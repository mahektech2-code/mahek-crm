/* ---------------------------------------------------------------------------
 * The configuration registry.
 *
 * Every business threshold in this product is a stored setting, never a
 * constant in code. The numbers below are PLACEHOLDERS — each one must be
 * confirmed with Mahek before go-live, and each is expected to change during
 * migration tuning without a code change or a redeploy.
 *
 * This file is pure data and pure validation. It has no storage, no clock and
 * no network, so engines and tests can use it directly.
 * ------------------------------------------------------------------------- */

import { COMPLAINT_CATEGORIES } from "../constants";

export type SettingType = "integer" | "decimal" | "text" | "boolean" | "structured";

export type SettingCategory =
  | "queue"
  | "buying-cycle"
  | "inactive-watch"
  | "escalation"
  | "bills"
  | "payments"
  | "targets"
  | "working-day"
  | "reminders"
  | "complaints"
  | "products"
  | "attachments"
  | "interactions"
  | "whatsapp"
  | "voice"
  /** Who accounts answer to, and how the screens that change that behave. */
  | "people"
  /* ---- MBOS, the field sales app. Same rule: no threshold is a constant. ---- */
  | "mbos-location"
  | "mbos-orders"
  | "mbos-credit"
  | "mbos-payments"
  | "mbos-expenses"
  | "mbos-attendance"
  | "mbos-leave"
  | "mbos-health"
  | "mbos-sync"
  | "mbos-leads"
  | "mbos-tasks";

export type SettingDefinition = {
  key: string;
  type: SettingType;
  category: SettingCategory;
  label: string;
  description: string;
  default: unknown;
  /** Inclusive bounds for integer and decimal settings. */
  min?: number;
  max?: number;
  /** Allowed values for text settings behaving as an enum. */
  options?: readonly string[];
};

export const SETTINGS = [
  /* ----------------------------------------------------------- call log */
  {
    key: "queue.checkInIntervalDays",
    type: "integer",
    category: "queue",
    label: "Routine check-in interval",
    description:
      "Days since last contact before a check-in becomes due. Applies only to customers whose buying cycle could not be measured \u2014 once there is enough order history, the cycle drives the call instead.",
    default: 7,
    min: 1,
    max: 365,
  },
  {
    key: "queue.whatsappCooldownDays",
    type: "integer",
    category: "queue",
    label: "WhatsApp cooldown",
    description:
      "Hold a customer back from the queue for this many days after a CONFIRMED WhatsApp send. A copied-but-unconfirmed message never counts.",
    default: 3,
    min: 0,
    max: 60,
  },
  {
    key: "queue.quietDaysAfterOrder",
    type: "integer",
    category: "queue",
    label: "Quiet days after an order",
    description:
      "Never chase an order inside this many days of the last one. Somebody who ordered days ago is serving themselves and a call asking for another adds nothing. CAPPED AT THE CUSTOMER\u2019S OWN CYCLE where that is shorter and measured \u2014 a flat window longer than somebody\u2019s cycle held the people who order most often off the list until after their order was due, which is backwards and lost real orders. Reminders still fire: a callback the customer asked for is not chasing.",
    default: 15,
    min: 0,
    max: 90,
  },
  {
    key: "queue.routineCallPercent",
    type: "integer",
    category: "queue",
    label: "Routine call, as a percentage of the cycle",
    description:
      "The stock-check call, placed before the order is due. 70 means a 30-day customer is rung on day 21, three weeks after their last order and nine days before the next is expected. It replaces the old lead-days calculation, which worked backwards from the due date and produced a later call on every cycle length.",
    default: 70,
    min: 10,
    max: 100,
  },
  {
    key: "queue.routineConfidenceSwing",
    type: "integer",
    category: "queue",
    label: "How far confidence moves the stock-check call",
    description:
      "Percentage points, either way. The stock check lands at the routine percentage of the cycle, moved later for a customer whose cycle is predictable and earlier for one whose is not — a swing of 10 puts a perfectly regular customer at 80% of their cycle and an erratic one at 60%. A date computed from 29, 30, 31 days is worth calling on; one computed from 15, 45, 22, 60 is a guess, and a guess is worth a wider net. Zero keeps the flat percentage for everybody.",
    default: 10,
    min: 0,
    max: 40,
  },
  {
    key: "queue.orderValueLookbackDays",
    type: "integer",
    category: "queue",
    label: "Order history read for what a call is worth",
    description:
      "Days of order history behind the typical order value that ranks the call list. A year covers a seasonal book without letting a customer’s size three years ago decide today’s order of calling.",
    default: 365,
    min: 30,
    max: 1825,
  },
  {
    key: "queue.routineMinCycleDays",
    type: "integer",
    category: "queue",
    label: "Shortest cycle that earns a routine call",
    description:
      "Above this many days, a customer gets a stock-check call before their order is due. At or below it they do not, and that is the ONLY thing a short cycle costs them \u2014 their order is still chased on their own due date like everybody else\u2019s. The call they lose asks what they have left on the shelf, and somebody buying every week already knows.",
    default: 15,
    min: 0,
    max: 120,
  },
  {
    key: "queue.outcomeCooldownDays",
    type: "structured",
    category: "queue",
    label: "How long each answer buys",
    description:
      "What the customer said, and how many days before they are asked again. Asking for an order and being told no has to buy quiet, or a customer past their call day returns to the top of the list every day until they order — which punishes the telecaller for working it. A missing outcome means no cooldown at all.",
    default: {
      /*
       * Five, and it is a FLOOR rather than the usual answer. A no-order call
       * now has to end with the telecaller saying when to ring back, so most
       * of these carry a date the customer gave and this never applies to
       * them — a reminder outranks every cooldown. What is left is the case
       * where the customer would not commit to anything, and five days is how
       * long that silence buys.
       */
      no_order: 5,
      not_interested: 30,
      casual_talk: 3,
    },
  },
  {
    key: "queue.noAnswerRetryHours",
    type: "integer",
    category: "queue",
    label: "Same-day retry, in hours",
    description:
      "A ring nobody answered is worth one more attempt the same day — people are driving, or in the shop, or at lunch. Counted from the attempt, not from the start of the day.",
    default: 1,
    min: 0,
    max: 12,
  },
  {
    key: "queue.noAnswerRetryDays",
    type: "structured",
    category: "queue",
    label: "The retry ladder after the first day",
    description:
      "Working days to wait before each further attempt once the same-day retry has failed. [1, 3] means: try the next working day, then three working days after that. The ladder ends at the attempt limit, where the customer stops being retried and somebody has to decide what happens next.",
    default: [1, 3],
  },
  {
    key: "queue.noAnswerMaxAttempts",
    type: "integer",
    category: "queue",
    label: "Attempts before a customer is unreachable",
    description:
      "After this many unanswered attempts in a row the customer is not retried again. They appear as unreachable, which is a decision for a person: a different number, a different time of day, a visit, or leaving them alone.",
    default: 5,
    min: 2,
    max: 10,
  },
  {
    key: "queue.includePaymentDue",
    type: "boolean",
    category: "queue",
    label: "Show payment calls in the Call Log",
    description:
      "Customers the collections cadence says are due a payment call appear at the top of the calling list rather than only on the payment screen. The collections engine still decides WHEN — this only decides whether the call log shows what it decided, so a telecaller works one list instead of two.",
    default: true,
  },
  {
    key: "queue.showOrderStatus",
    type: "boolean",
    category: "queue",
    label: "Show orders in progress",
    description:
      "An order already placed and still being processed, held or waiting for dispatch is NOT a reason to ask for another order — but it is worth seeing. On, the customer appears with the order's status and no order-chasing reason. Off, they are simply held back.",
    default: true,
  },
  {
    key: "queue.leadPercent",
    type: "integer",
    category: "queue",
    label: "Call this far before the expected order",
    description:
      "As a percentage of the customer's own cycle, so a slow bulk buyer gets more notice than a fast one. A 22-day cycle at 20% is called on day 18.",
    default: 20,
    min: 0,
    max: 60,
  },
  {
    key: "queue.leadMinDays",
    type: "integer",
    category: "queue",
    label: "Shortest lead",
    description: "Floor for the percentage above, so short cycles still get some notice.",
    default: 3,
    min: 0,
    max: 30,
  },
  {
    key: "queue.leadMaxDays",
    type: "integer",
    category: "queue",
    label: "Longest lead",
    description:
      "Ceiling for the percentage above. Without it a 90-day cycle would be called nearly three weeks early.",
    default: 10,
    min: 1,
    max: 60,
  },
  {
    key: "queue.noOrderCooldownDays",
    type: "integer",
    category: "queue",
    label: "Quiet days after \u201cno order\u201d",
    description:
      "Hold a customer back for this many days after a call that produced no order. Without it, a customer past their call day returns to the top of the list every single day until they order \u2014 which punishes the telecaller for working it.",
    default: 7,
    min: 0,
    max: 60,
  },
  {
    key: "queue.prospectIntervalDays",
    type: "integer",
    category: "queue",
    label: "Prospect calling interval",
    description:
      "Days between calls to a customer who has never ordered. Deliberately shorter than the check-in interval: converting a first order is the growth work.",
    default: 3,
    min: 1,
    max: 90,
  },
  {
    key: "queue.excludeActiveInOrderSystem",
    type: "boolean",
    category: "queue",
    label: "Exclude customers active in the order system",
    description: "Hold back customers with live activity in the external order system.",
    default: true,
  },
  {
    key: "queue.excludeCalledToday",
    type: "boolean",
    category: "queue",
    label: "Exclude customers already called today",
    description: "Held back if any user has already called them today.",
    default: true,
  },
  {
    key: "queue.maxSizePerUser",
    type: "integer",
    category: "queue",
    label: "Maximum queue size per user",
    description: "Truncate the ranked queue to this length. 0 means unlimited.",
    default: 60,
    min: 0,
    max: 500,
  },
  {
    key: "queue.snapshotHour",
    type: "integer",
    category: "queue",
    label: "Hour the queue is snapshotted",
    description:
      "The queue is rebuilt on every read, so this does not schedule the rebuild. It records who was on the list when the day opened, which is the only way \u201cN carried over from yesterday\u201d can be answered. Shown to telecallers as the time the queue settles for the day.",
    default: 8,
    min: 0,
    max: 23,
  },
  {
    key: "queue.tierWeights",
    type: "structured",
    category: "queue",
    label: "Priority tier weights",
    description:
      "Relative ranking of the reasons a customer can enter the queue. Highest weight wins. Inferred - confirm against the existing system during migration diffing.",
    default: {
      /* P1 — money, and promises made to a customer. */
      paymentOverdue: 110,
      reminderOverdue: 100,
      reminderDueToday: 90,
      /* P2 — the order that should have happened by now. */
      orderOverdueFullCycle: 80,
      orderDue: 70,
      /* P3 — routine work. */
      routineCall: 60,
      prospect: 55,
      checkInOverdue: 50,
      checkInDue: 40,
      /* P4 — chasing a ring nobody answered, and the state after it. */
      unreachable: 35,
      noAnswerRetry: 30,
      /* Not a call for an order at all: an order already on its way. */
      orderStatus: 10,
    },
  },

  /* --------------------------------------------------------- buying cycle */
  {
    key: "buyingCycle.method",
    type: "text",
    category: "buying-cycle",
    label: "Calculation method",
    description:
      "Median resists a single bulk order or a festival gap; mean does not. Median is the default for that reason.",
    default: "median",
    options: ["median", "mean"],
  },
  {
    key: "buyingCycle.lookbackOrders",
    type: "integer",
    category: "buying-cycle",
    label: "Lookback orders",
    description: "How many of the most recent orders to consider.",
    default: 6,
    min: 2,
    max: 50,
  },
  {
    key: "buyingCycle.minIntervals",
    type: "integer",
    category: "buying-cycle",
    label: "Minimum intervals required",
    description: "Below this many intervals, fall back to the default cycle.",
    default: 3,
    min: 1,
    max: 20,
  },
  {
    key: "buyingCycle.defaultDays",
    type: "integer",
    category: "buying-cycle",
    label: "Default cycle",
    description: "Applied to customers with insufficient order history.",
    default: 30,
    min: 1,
    max: 365,
  },
  {
    key: "buyingCycle.minDays",
    type: "integer",
    category: "buying-cycle",
    label: "Minimum cycle",
    description:
      "Floor under a computed cycle. It was 7, which was not a clamp against an absurd figure but a policy nobody had stated: a customer genuinely ordering every two days was recorded as ordering every seven, so their order was chased five days late and every screen reading the cycle was wrong about them. Two orders on the same day are already excluded as one purchase split across bills, so the shortest interval that can reach this is a real one. Raise it only to say “nobody is chased faster than this” — and say it here rather than in the queue, because it changes what the cycle MEANS.",
    default: 1,
    min: 1,
    max: 365,
  },
  {
    key: "buyingCycle.maxDays",
    type: "integer",
    category: "buying-cycle",
    label: "Maximum cycle",
    description: "Clamp against absurdly long computed cycles.",
    default: 180,
    min: 1,
    max: 730,
  },

  /* -------------------------------------------------------- inactive watch */
  {
    key: "inactive.cycleMultiplier",
    type: "decimal",
    category: "inactive-watch",
    label: "Cycle multiplier",
    description:
      "Flag at this multiple of the customer's OWN buying cycle. The source document states 2.0 precisely - the one threshold that is not a guess.",
    default: 2.0,
    min: 1,
    max: 10,
  },
  {
    key: "inactive.decisionAgeWarningDays",
    type: "integer",
    category: "inactive-watch",
    label: "Decision age warning",
    description: "Highlight watch rows sitting this long without an outcome.",
    default: 14,
    min: 1,
    max: 365,
  },

  /* ------------------------------------------------------------ escalation */
  {
    key: "escalation.stage1Days",
    type: "integer",
    category: "escalation",
    label: "Stage 1 threshold",
    description:
      "Days overdue at which the gentle WhatsApp nudge begins. Zero, because it begins the day the bill falls due: the reminder interval decides when the first message actually goes, and `stageFor` puts everything below stage 2 in stage 1 regardless. A seven here described a band the engine never had.",
    default: 0,
    min: 0,
    max: 365,
  },
  {
    key: "escalation.stage2Days",
    type: "integer",
    category: "escalation",
    label: "Stage 2 threshold",
    description:
      "Days overdue at which calling begins and channels start alternating. This is the first day a payment call may be logged, so it must be the day after the quiet window closes.",
    default: 16,
    min: 0,
    max: 365,
  },
  {
    key: "escalation.stage3Days",
    type: "integer",
    category: "escalation",
    label: "Stage 3 threshold",
    description: "Days overdue at which the urgent call stage begins.",
    default: 30,
    min: 0,
    max: 730,
  },
  {
    key: "escalation.stageDriver",
    type: "text",
    category: "escalation",
    label: "Stage driver",
    description: "Which overdue bill anchors the days-overdue measurement.",
    default: "oldest",
    options: ["oldest", "largest"],
  },
  {
    key: "escalation.partialPaymentResetsClock",
    type: "boolean",
    category: "escalation",
    label: "Partial payment resets the clock",
    description: "When false, a part payment reduces the balance but not the age.",
    default: false,
  },
  {
    key: "escalation.disputeHoldsEscalation",
    type: "boolean",
    category: "escalation",
    label: "Disputes hold escalation",
    description: "Hold a disputed account at its current stage instead of escalating.",
    default: true,
  },
  {
    key: "escalation.quietCallDays",
    type: "integer",
    category: "escalation",
    label: "Quiet days after the due date",
    description:
      "Days after a bill falls due during which the customer is messaged but never called. A bill one day late is usually paperwork, not refusal, and a call that early costs goodwill. Calls begin the day after this window closes.",
    default: 15,
    min: 0,
    max: 180,
  },
  {
    key: "escalation.messageIntervalDays",
    type: "integer",
    category: "escalation",
    label: "Payment reminder interval",
    description:
      "Days between payment reminder messages, counted from the due date and then from each message actually sent. Messages continue after calling begins.",
    default: 4,
    min: 1,
    max: 90,
  },
  {
    key: "escalation.callIntervalDays",
    type: "integer",
    category: "escalation",
    label: "Payment call interval",
    description:
      "Days a customer rests after a logged payment call before returning to the calling list. Without it a customer past the quiet window is called every single day.",
    default: 3,
    min: 1,
    max: 90,
  },
  {
    key: "escalation.slowPayerLookbackMonths",
    type: "integer",
    category: "escalation",
    label: "Slow payer lookback",
    description: "Months of payment history examined for the slow-payer flag.",
    default: 6,
    min: 1,
    max: 60,
  },
  {
    key: "escalation.slowPayerGraceDays",
    type: "integer",
    category: "escalation",
    label: "Slow payer grace period",
    description:
      "Days past the due date a payment may arrive without counting as late. A bill settled a day or two after its term is ordinary business - a cheque in the post, a bank holiday, an accounts department that runs on Fridays - and counting it marks customers who pay reliably. The flag is meant to name the ones who genuinely do not.",
    default: 7,
    min: 0,
    max: 90,
  },
  {
    key: "escalation.slowPayerLateCount",
    type: "integer",
    category: "escalation",
    label: "Slow payer threshold",
    description: "Late payments within the lookback needed to earn the flag.",
    default: 3,
    min: 1,
    max: 100,
  },

  /* ---------------------------------------------------------------- bills */
  {
    key: "bills.agingBuckets",
    type: "structured",
    category: "bills",
    label: "Aging bucket boundaries",
    description:
      "Lower bounds in days overdue, EXCLUSIVE: a boundary of 15 opens a band on day 16. MUST align with the escalation thresholds, or the bills screen and the follow-up screen will disagree about how overdue an account is. The defaults trace the follow-up policy: the quiet window, then calling, then urgent.",
    default: [0, 15, 29],
  },
  {
    key: "bills.defaultCreditDays",
    type: "integer",
    category: "bills",
    label: "Default credit period",
    description:
      "The last fallback for a bill with no due date, used when neither the order that produced it nor the customer's record states a term.",
    default: 30,
    min: 0,
    max: 365,
  },
  {
    key: "bills.creditDayOptions",
    type: "structured",
    category: "bills",
    label: "Payment terms offered",
    description:
      "The terms a telecaller can pick from when taking an order, in days. Any other number can still be typed in - this list is the shortcut, not the limit.",
    default: [15, 30, 45],
  },

  /* -------------------------------------------------------------- payments */
  {
    key: "payments.reportedQuietDays",
    type: "integer",
    category: "payments",
    label: "Quiet days after a payment is reported",
    description:
      "Days a customer is left alone about money after somebody reports a payment that accounts have not yet confirmed. Chasing a customer who has just paid is the fastest way to lose one. It expires so that an unconfirmed claim cannot silence an account for ever - once it does, the bill is still open and the customer returns to the list.",
    default: 3,
    min: 0,
    max: 60,
  },
  {
    key: "payments.allowOnAccountRemainder",
    type: "boolean",
    category: "payments",
    label: "Allow money on account",
    description:
      "Let a receipt carry more than its bills, holding the difference against the next one. Switched off, the whole amount must be split across open bills - which is how a receipt gets recorded for the wrong amount to make the screen accept it.",
    default: true,
  },
  {
    key: "people.amChangeReasons",
    type: "structured",
    category: "people",
    label: "Reasons an account manager changes",
    description:
      "Why an account moved to a different account manager, offered as a list so the answer can be counted rather than read. Somebody leaving is the common one and the reason the list exists - when a salesperson resigns, whoever picks up their accounts needs to know which moved and why. `other` always requires a note. Retiring a reason here does not touch the history: stored codes keep resolving, because a reason nobody can read any more is a row nobody can explain.",
    default: [
      "Salesperson left",
      "Back office staff left",
      "Territory reassigned",
      "Workload rebalanced",
      "Customer requested",
      "Correcting a mistake",
      "Other",
    ],
  },
  {
    key: "people.pickerSearchThreshold",
    type: "integer",
    category: "people",
    label: "When a person picker becomes a search box",
    description:
      "How many people a picker will list plainly before it leads with a search box instead. A short list is faster to read than to type into; a long one is the opposite, and scrolling ninety names to find a colleague mid-task is how the wrong one gets picked. Both are the same control - this only decides whether the search field takes focus.",
    default: 10,
    min: 3,
    max: 100,
  },
  {
    key: "payments.modes",
    type: "structured",
    category: "payments",
    label: "Payment modes",
    description:
      "How money is received. The first is the default on the form. Two of them are not money arriving at all: an adjustment settles a bill against something already on the account, and a credit note settles it against goods returned or a claim allowed. Both close a bill the same way a transfer does, and leaving them off the list is how they get recorded as cash that nobody can find in the bank.",
    default: ["Bank transfer", "UPI", "Cheque", "Cash", "Adjustment", "Credit note"],
  },
  {
    key: "payments.referenceRequiredModes",
    type: "structured",
    category: "payments",
    label: "Modes needing a reference",
    description:
      "Modes that cannot be CONFIRMED without a UTR, cheque number or equivalent. Empty by default, so a reference is asked for and never demanded: accounts confirm money they are already looking at in the bank statement, so the entry is the cross-check and the string is a convenience for finding it again. Refusing the save turned a receipt somebody could see into one nobody could record. Naming a mode here brings the old rule back for it, and it is asked of whoever asserts the money arrived - never of a telecaller repeating what a customer said.",
    default: [],
  },
  {
    key: "payments.confirmationAgeWarningHours",
    type: "integer",
    category: "payments",
    label: "Confirmation age warning",
    description:
      "Hours after which a reported payment still waiting on accounts is flagged on the queue. The customer has been left alone on the strength of it, so it going stale is a problem worth showing.",
    default: 24,
    min: 1,
    max: 720,
  },
  {
    key: "payments.datedModes",
    type: "structured",
    category: "payments",
    label: "Modes that carry a date of their own",
    description:
      "Modes where the instrument has a date written on it, separate from the day we received it. A cheque handed over on the 3rd and dated the 20th cannot reach the bank until the 20th, and those are two different facts - collapsing them into one loses whichever answer somebody needed. The date may be in the past or the future: one dated last week should have been banked already, and one dated next month is a customer who must not be chased until then.",
    default: ["Cheque"],
  },
  {
    key: "payments.holdStaleDays",
    type: "integer",
    category: "payments",
    label: "When a held payment starts to look forgotten",
    description:
      "Days after which a payment accounts have put on hold is flagged on their own list. A hold does NOT expire - it was somebody's decision and only somebody undoes it - so this is the whole of what stops one being forgotten. The customer behind it is getting no calls and no messages the entire time, which is exactly what makes an old hold expensive.",
    default: 7,
    min: 1,
    max: 90,
  },
  {
    key: "payments.matchWindowDays",
    type: "integer",
    category: "payments",
    label: "How far back to look for the same money",
    description:
      "When accounts record a payment from the bank statement, how many days back to search the customer's own reported and held receipts for the same money. A telecaller writes down what the customer said days before the transfer shows up on a statement, so too short a window offers no match and the payment gets recorded twice.",
    default: 45,
    min: 1,
    max: 365,
  },
  {
    key: "payments.matchTolerancePercent",
    type: "integer",
    category: "payments",
    label: "How far off an amount can be and still be the same money",
    description:
      "A customer says fifty thousand and fifty thousand and forty rupees of bank charges arrive. Anything inside this percentage is offered as a possible match rather than hidden - it is offered, never applied, and the amount that counts is always the one accounts entered from the statement. Zero means only an exact amount is ever suggested.",
    default: 2,
    min: 0,
    max: 25,
  },

  /* --------------------------------------------------------------- targets */
  {
    key: "targets.defaultMethod",
    type: "text",
    category: "targets",
    label: "Default target method",
    description: "How an unset monthly target is filled automatically.",
    default: "trailing-average",
    options: ["trailing-average", "last-month", "fixed"],
  },
  {
    key: "targets.trailingMonths",
    type: "integer",
    category: "targets",
    label: "Trailing months",
    description: "Months of achievement averaged for a defaulted target.",
    default: 3,
    min: 1,
    max: 24,
  },
  {
    key: "targets.defaultUpliftPercent",
    type: "decimal",
    category: "targets",
    label: "Default uplift percentage",
    description: "Applied on top of the computed default target.",
    default: 0,
    min: -100,
    max: 500,
  },
  {
    key: "targets.proRateNewCustomers",
    type: "boolean",
    category: "targets",
    label: "Pro-rate new customers",
    description: "Scale the first month's target by the portion of the month they existed.",
    default: true,
  },

  /* ----------------------------------------------------------- working day */
  {
    key: "workingDay.shiftStart",
    type: "text",
    category: "working-day",
    label: "Shift start",
    description: "Local start of the telecalling shift, HH:MM.",
    default: "09:00",
  },
  {
    key: "workingDay.shiftEnd",
    type: "text",
    category: "working-day",
    label: "Shift end",
    description: "Local end of the telecalling shift, HH:MM.",
    default: "19:00",
  },
  {
    key: "workingDay.dayBoundaryHour",
    type: "integer",
    category: "working-day",
    label: "Day boundary hour",
    description:
      "The hour at which 'today' flips, in the working-day timezone. 0 is midnight — the day changes when the date does, which is what everybody outside the building means by the word. Raise it only if calls are logged after midnight and should count towards the shift that started the previous morning.",
    default: 0,
    min: 0,
    max: 23,
  },
  {
    key: "workingDay.workingDays",
    type: "structured",
    category: "working-day",
    label: "Working days",
    description: "ISO weekday numbers, Monday is 1 and Sunday is 7.",
    default: [1, 2, 3, 4, 5, 6],
  },
  {
    key: "workingDay.timezone",
    type: "text",
    category: "working-day",
    label: "Timezone",
    description: "Every business date decision is evaluated in this zone.",
    default: "Asia/Kolkata",
  },

  /* ------------------------------------------------------------- reminders */
  {
    key: "reminders.rollForwardOnNonWorkingDays",
    type: "boolean",
    category: "reminders",
    label: "Roll forward on non-working days",
    description: "Move a reminder falling on a non-working day to the next working day.",
    default: true,
  },
  {
    key: "reminders.rescheduleWarningCount",
    type: "integer",
    category: "reminders",
    label: "Reschedule warning count",
    description: "Flag a reminder rescheduled at least this many times.",
    default: 3,
    min: 1,
    max: 50,
  },

  /* ------------------------------------------------------------ complaints */
  {
    key: "complaints.slaHours",
    type: "structured",
    category: "complaints",
    label: "Resolution SLA",
    description: "Hours to resolution by severity.",
    default: { low: 120, medium: 48, high: 24 },
  },
  {
    key: "complaints.defaultSeverity",
    type: "text",
    category: "complaints",
    label: "Default severity",
    description: "Severity given to a complaint raised on a call, which sets its SLA.",
    default: "medium",
    options: ["low", "medium", "high"],
  },
  {
    key: "interactions.maxNotesLength",
    type: "integer",
    category: "complaints",
    label: "Maximum note length",
    description: "Longest note accepted when logging an interaction.",
    default: 2000,
    min: 200,
    max: 10000,
  },
  {
    key: "customers.defaultCreditDays",
    type: "integer",
    category: "bills",
    label: "Default credit days",
    description:
      "Shown on a customer's information tab where no per-customer value is set.",
    default: 30,
    min: 0,
    max: 180,
  },
  {
    key: "dashboard.reminderOverdueFlagDays",
    type: "integer",
    category: "reminders",
    label: "Reminder red-flag age",
    description:
      "A reminder overdue by more than this many days is counted on the manager's red-flag strip.",
    default: 3,
    min: 1,
    max: 30,
  },
  {
    key: "dashboard.complaintUnresolvedFlagDays",
    type: "integer",
    category: "complaints",
    label: "Complaint red-flag age",
    description:
      "A complaint still open after this many days is counted on the manager's red-flag strip.",
    default: 5,
    min: 1,
    max: 60,
  },
  {
    key: "complaints.categories",
    type: "structured",
    category: "complaints",
    label: "Complaint categories",
    description:
      "The list offered wherever a complaint is raised - the Complaints dialog, the customer record and the call panel all read this, so they cannot drift apart. Edit it here rather than in code.",
    default: [...COMPLAINT_CATEGORIES],
  },

  /* -------------------------------------------------------------- products */
  {
    key: "products.frequentCount",
    type: "integer",
    category: "products",
    label: "Frequent products shown",
    description:
      "How many of a customer's regular products the order form offers before anybody searches. Enough to cover the usual order without becoming a list to read.",
    default: 6,
    min: 1,
    max: 24,
  },
  {
    key: "products.frequentRanking",
    type: "text",
    category: "products",
    label: "Frequent products ranked by",
    description:
      "Total orders puts their staples first and is stable week to week. Recency surfaces what they have moved onto, and reorders more often.",
    default: "orders",
    options: ["orders", "recency"],
  },
  {
    key: "products.starterListCount",
    type: "integer",
    category: "products",
    label: "Products offered before anybody searches",
    description:
      "The best sellers the picker shows when the search box is empty and the customer has no history of their own. The catalogue runs to two hundred SKUs, which is a search box's job rather than a list's - this is the handful worth offering unprompted. Zero shows nothing until something is typed.",
    default: 12,
    min: 0,
    max: 50,
  },
  {
    key: "products.priceSource",
    type: "text",
    category: "products",
    label: "Where a line's price comes from",
    description:
      "The product master arrived with no prices in it, so this is unanswered until somebody answers it. Until then an order is worth what the telecaller typed and nothing computes a value from the catalogue - a packing cost is the cost of an empty box, and valuing orders with it would put believable wrong numbers on every target screen. Not set: order value stays manual and the screens that would derive it say so.",
    default: "unset",
    options: ["unset", "manual", "product", "pricelist"],
  },
  {
    key: "products.searchOnOrderForms",
    type: "boolean",
    category: "products",
    label: "Product search on order forms",
    description:
      "Off, a telecaller can only pick from the frequent list - which is a deliberate constraint for a new team, and a wall for an experienced one.",
    default: true,
  },
  {
    key: "products.searchMinChars",
    type: "integer",
    category: "products",
    label: "Characters before the catalogue is searched",
    description:
      "One letter matches most of the catalogue, so the answer is a list nobody can read produced by the most expensive query in the app - trigram similarity plus a leading-wildcard match on eight columns. Two characters is where the answer starts being an answer. Raise it on a much larger catalogue; one means search from the first keystroke.",
    default: 2,
    min: 1,
    max: 5,
  },

  /* ---------------------------------------------------------- interactions */
  {
    key: "interactions.singleSelectOutcomes",
    type: "structured",
    category: "interactions",
    label: "Single-select outcomes",
    description:
      "Outcomes whose quick notes are one choice rather than several. A second pick replaces the first. Every outcome not listed here takes as many notes as apply.",
    default: ["no_order"],
  },

  /* ----------------------------------------------------------- attachments */
  {
    key: "attachments.maxSizeMb",
    type: "integer",
    category: "attachments",
    label: "Maximum file size",
    description:
      "Megabytes per file. A photograph from a phone is usually under three; the ceiling is there to stop a video being attached by accident.",
    default: 5,
    min: 1,
    max: 50,
  },
  {
    key: "attachments.acceptedTypes",
    type: "structured",
    category: "attachments",
    label: "Permitted file types",
    description:
      "Checked against the bytes of the file, never its extension — anything can be renamed .jpg. A type removed here stops being accepted immediately; files already stored keep working.",
    default: ["image/jpeg", "image/png", "application/pdf"],
  },
  {
    key: "attachments.maxPerComplaint",
    type: "integer",
    category: "attachments",
    label: "Attachments per complaint",
    description:
      "Photographs and documents supporting one complaint. Six covers a pallet photographed from every side.",
    default: 6,
    min: 0,
    max: 20,
  },
  {
    key: "attachments.maxPerFollowUp",
    type: "integer",
    category: "attachments",
    label: "Attachments per payment follow-up",
    description:
      "Proof of payment against one follow-up attempt. Three covers a slip, a screenshot and a bank reference.",
    default: 3,
    min: 0,
    max: 20,
  },
  {
    key: "attachments.maxPerFeedback",
    type: "integer",
    category: "attachments",
    label: "Attachments per feedback message",
    description:
      "Screenshots on one report or one reply in its thread. Three covers the screen that is wrong, what was expected, and the error itself — which is usually the whole bug report.",
    default: 3,
    min: 0,
    max: 20,
  },
  {
    key: "attachments.orphanCleanupHours",
    type: "integer",
    category: "attachments",
    label: "Orphan cleanup window",
    description:
      "An upload starts the moment a file is chosen, so a form abandoned before saving leaves a file belonging to nothing. Swept after this many hours. Long enough that a telecaller interrupted mid-call still finds their file.",
    default: 24,
    min: 1,
    max: 720,
  },
  {
    key: "attachments.retentionDays",
    type: "integer",
    category: "attachments",
    label: "Retention after removal",
    description:
      "Days a removed attachment's bytes are kept before purging. 0 keeps them indefinitely. A payment proof may have accounting relevance long after somebody tidied it off a screen — confirm this with the business before lowering it.",
    default: 0,
    min: 0,
    max: 3650,
  },

  /* -------------------------------------------------------------- whatsapp */
  {
    key: "whatsapp.mode",
    type: "text",
    category: "whatsapp",
    label: "Mode",
    description:
      "Manual means copy-and-confirm. Switching to automatic must need no code change beyond credentials.",
    default: "manual",
    options: ["manual", "automatic"],
  },
  {
    key: "whatsapp.contactsPerWeekLimit",
    type: "integer",
    category: "whatsapp",
    label: "Contact frequency limit",
    description: "Maximum messages to one customer within a rolling week.",
    default: 3,
    min: 0,
    max: 50,
  },
  {
    key: "whatsapp.unconfirmedExpiryHours",
    type: "integer",
    category: "whatsapp",
    label: "Unconfirmed copy expiry",
    description: "How long a copied-but-unconfirmed message waits before the sweep acts.",
    default: 12,
    min: 1,
    max: 168,
  },
  {
    key: "whatsapp.autoConfirmAfterHours",
    type: "integer",
    category: "whatsapp",
    label: "Auto-confirm after",
    description:
      "0 means never auto-confirm. Defaulted off - auto-confirming asserts a message was sent when the system cannot know that.",
    default: 0,
    min: 0,
    max: 168,
  },

  /*
   * Dictation. These govern the microphone on every prose field in MahekOne,
   * not just the CRM's — it is a property of the text box rather than of an
   * app, and this is the only settings surface there is.
   */
  {
    key: "voice.enabled",
    type: "boolean",
    category: "voice",
    label: "Dictate by voice",
    description:
      "Puts a microphone on every box where somebody writes a sentence. Off hides it everywhere immediately; nothing already typed is affected. The recording is never stored — it is transcribed and dropped.",
    default: true,
  },
  {
    key: "voice.maxSeconds",
    type: "integer",
    category: "voice",
    label: "Longest recording",
    description:
      "Recording stops itself here. Two minutes is a long note read aloud; the limit exists so a phone left in a pocket does not send ten minutes of a live call to a transcription provider.",
    default: 120,
    min: 10,
    max: 600,
  },
  {
    key: "voice.maxSizeMb",
    type: "integer",
    category: "voice",
    label: "Largest recording",
    description:
      "Megabytes of audio the server will accept. Opus speech runs about half a megabyte a minute, so this is a backstop against a browser that ignores the time limit rather than a limit anybody meets.",
    default: 15,
    min: 1,
    max: 50,
  },
  {
    key: "voice.transcriptionProvider",
    type: "text",
    category: "voice",
    label: "Who hears the speech",
    description:
      "Sarvam's saaras is built for Indian languages and code-mixed speech — Hindi with English words dropped in mid-sentence is what it is FOR, rather than something it copes with. Its synchronous endpoint refuses audio over 30 seconds, which is what the OpenAI fallback below is for.",
    default: "sarvam",
    options: ["sarvam", "openai"],
  },
  {
    key: "voice.fallbackToOpenai",
    type: "boolean",
    category: "voice",
    label: "Fall back to OpenAI",
    description:
      "Send the recording to OpenAI when Sarvam cannot take it — anything over its 30-second ceiling, and anything it refuses or fails on. This is what lets a telecaller record for a minute and still get a note back. Turning it off keeps every recording with Sarvam and caps them at 30 seconds, which is the setting for a deployment that wants audio kept inside India. It has no effect where there is no Sarvam key: OpenAI serves the whole feature on its own rather than switching itself off on behalf of a provider nothing was going to ask.",
    default: true,
  },
  {
    key: "voice.noiseSuppression",
    type: "boolean",
    category: "voice",
    label: "Browser noise suppression",
    description:
      "OFF by default, and deliberately. The browser turns this on unless told otherwise, and it is built for conference calls: it gates low-level signal, which is exactly what a whisper, a tired voice at the end of a shift, or somebody speaking quietly because the customer is still on the other line all look like. It removed the words along with the fan. Turn it on only for a floor loud enough that the noise costs more than the whispers.",
    default: false,
  },
  {
    key: "voice.autoGainControl",
    type: "boolean",
    category: "voice",
    label: "Automatic gain",
    description:
      "Lifts a quiet voice towards a usable level before it is ever encoded, which is the half of the problem noise suppression was making worse. On by default. Turn it off only if recordings come back pumping or breathing between words.",
    default: true,
  },
  {
    key: "voice.echoCancellation",
    type: "boolean",
    category: "voice",
    label: "Echo cancellation",
    description:
      "For a two-way call, where the far end coming back through the speaker has to be subtracted. Dictation has no far end, so this is off: it is a filter on the voice being recorded, buying nothing.",
    default: false,
  },
  {
    key: "voice.transcriptionModel",
    type: "text",
    category: "voice",
    label: "Sarvam model",
    description:
      "Sarvam's speech model. It is asked for the same audio twice — once to write down what was said, once for the English — so the two can be shown side by side and a bad translation can be caught against the sentence it came from.",
    default: "saaras:v3",
  },
  {
    key: "voice.openaiTranscriptionModel",
    type: "text",
    category: "voice",
    label: "OpenAI transcription model",
    description:
      "Used when OpenAI is the chosen provider, and whenever the fallback takes over. It writes the speech down in whatever language it was spoken in; the English is a second pass by the writing model below.",
    default: "gpt-4o-transcribe",
  },
  {
    key: "voice.languageModel",
    type: "text",
    category: "voice",
    label: "Writing model",
    description:
      "An OpenAI text model. It renders the transcript into English without summarising, and does the tightening and rewriting the person asks for.",
    default: "gpt-5-mini",
  },

  /* ═══════════════════════════════════════════════ MBOS — field sales, §9
   *
   * Every one of these is a number somebody in the field will argue with, and
   * every argument is a settings change rather than a deploy. Distances are
   * metres, money is paise, and anything measured in hours says so in its key.
   */

  /* ------------------------------------------------------- where they are */
  {
    key: "mbos.location.gpsAccuracyThresholdM",
    type: "integer",
    category: "mbos-location",
    label: "Usable GPS accuracy",
    description:
      "Metres. A fix the handset itself rates worse than this is not evidence of where anybody was standing — a visit captured on one is still saved, but it is not marked verified and it never counts as a location mismatch. Refusing the check-in instead would lose a real visit to a cloudy afternoon indoors.",
    default: 50,
    min: 5,
    max: 1000,
  },
  {
    key: "mbos.location.visitMismatchM",
    type: "integer",
    category: "mbos-location",
    label: "Visit location mismatch distance",
    description:
      "Metres between the check-in and the customer's own pin before the visit is flagged for a manager. It must be comfortably larger than the accuracy above, or an honest fix on a busy street reads as somebody checking in from the tea shop.",
    default: 200,
    min: 20,
    max: 5000,
  },
  {
    key: "mbos.location.routeDeviationM",
    type: "integer",
    category: "mbos-location",
    label: "Route deviation distance",
    description:
      "Metres a salesman may stray from the planned beat before the day is flagged as a deviation. Not a fence — nothing is blocked by it; it decides what a manager is told about.",
    default: 2000,
    min: 100,
    max: 50000,
  },
  {
    key: "mbos.location.unplannedVisitsPerDay",
    type: "integer",
    category: "mbos-location",
    label: "Unplanned visits before the manager is told",
    description:
      "An unplanned visit is ordinary — a shop that called, a walk-in on the way past. A day made entirely of them is a plan nobody worked. This is how many are allowed before the day is raised, not how many are permitted.",
    default: 3,
    min: 0,
    max: 50,
  },

  {
    key: "mbos.location.trackWhileWorking",
    type: "boolean",
    category: "mbos-location",
    label: "Follow the route while somebody is checked in",
    description:
      "The handset reports its position every few minutes between the check-in and the check-out, and not one second either side — a track that ran after the day was closed would be following somebody home. Off here means no handset reports at all, and the Live map falls back to the handful of fixes a check-in and each visit already leave.",
    default: true,
  },
  {
    key: "mbos.location.trackEveryMinutes",
    type: "integer",
    category: "mbos-location",
    label: "How often a position is taken",
    description:
      "Minutes between fixes while the day is open. Every minute draws a smoother line and costs battery on a phone that has to last until the evening; every fifteen is a line that cuts corners through buildings. Five is a shape you can recognise a beat from.",
    default: 5,
    min: 1,
    max: 60,
  },

  {
    key: "mbos.location.logActivityLocation",
    type: "boolean",
    category: "mbos-location",
    label: "Record where each activity was done",
    description:
      "An order, a payment, a complaint and a sample all happen somewhere, and until now only visits and the check-in recorded where. It costs no battery and adds no delay: the position used is almost always one the day's tracking had already taken, and a save is never held up waiting for a fix. Off here means no handset attaches one, checked in the server as well as on the phone.",
    default: true,
  },
  {
    key: "mbos.location.activityFixMaxAgeSeconds",
    type: "integer",
    category: "mbos-location",
    label: "How old a position may be before it is called stale",
    description:
      "Seconds. This changes what the screens CALL a position, never what is stored — the age is recorded either way and a reader can judge it. A fix from four minutes ago is evidence of where somebody was standing; one from four hours ago is evidence of nothing, and a screen that showed them alike would be the more misleading of the two.",
    default: 900,
    min: 60,
    max: 86_400,
  },

  /* ------------------------------------------------------------ ordering */
  {
    key: "mbos.orders.approvalThresholdPaise",
    type: "integer",
    category: "mbos-orders",
    label: "Order value needing approval",
    description:
      "Paise. An order at or above this waits for a manager before dispatch. Below it, accounts still check the customer — this threshold governs the manager's sign-off, not the credit check.",
    default: 5000000,
    min: 0,
    max: 1000000000,
  },
  {
    key: "mbos.orders.secondTierThresholdPaise",
    type: "integer",
    category: "mbos-orders",
    label: "Order value needing the second approver",
    description:
      "Paise. Above this the approval goes a level further up the reporting hierarchy. Must exceed the first threshold, or the two tiers are one.",
    default: 25000000,
    min: 0,
    max: 1000000000,
  },
  {
    key: "mbos.orders.minimumQuantityCans",
    type: "integer",
    category: "mbos-orders",
    label: "Minimum order quantity",
    description:
      "Cans, per line, because cans are what a salesman counts and what the customer says. 0 means no minimum.",
    default: 0,
    min: 0,
    max: 1000,
  },

  /* -------------------------------------------------------------- credit */
  {
    key: "mbos.credit.blockOnLimitExceeded",
    type: "boolean",
    category: "mbos-credit",
    label: "Refuse orders over the credit limit",
    description:
      "On, an order taking a customer past `creditLimitPaise` is rejected at sync with `credit_exceeded` and the salesman is told, naming the customer. Off, it is accepted and flagged for accounts. Rejecting is the safer default and the more painful one — the salesman was standing in the shop when they promised it.",
    default: true,
  },
  {
    key: "mbos.credit.outstandingStaleHours",
    type: "integer",
    category: "mbos-credit",
    label: "Outstanding figure goes stale after",
    description:
      "Hours. The handset carries a cached outstanding per customer, and a credit decision taken against a figure older than this is refused with `outstanding_stale` rather than taken on a number from last week. The screen shows the age wherever the decision hangs on it.",
    default: 24,
    min: 1,
    max: 720,
  },
  {
    key: "mbos.credit.overdueDaysBlockOrders",
    type: "integer",
    category: "mbos-credit",
    label: "Days overdue that block new orders",
    description:
      "A customer with a bill this far past its due date stops being offered new orders in the field. 0 switches the rule off. This is a policy about debt, not about the credit limit — an account inside its limit can still be months late.",
    default: 0,
    min: 0,
    max: 365,
  },

  /* ------------------------------------------------------------ payments */
  {
    key: "mbos.payments.cashDepositSlaHours",
    type: "integer",
    category: "mbos-payments",
    label: "Cash deposit SLA",
    description:
      "Hours a salesman may hold cash collected in the field before it is deposited or handed over. Past it the collection is shown as undeposited on a manager's screen — tracked separately from the payment itself, because the customer has paid either way.",
    default: 48,
    min: 1,
    max: 720,
  },
  {
    key: "mbos.payments.managerNotifyThresholdPaise",
    type: "integer",
    category: "mbos-payments",
    label: "Collection value the manager is told about",
    description:
      "Paise. A collection at or above this notifies the manager when it syncs. Money reported from the field is still money the business has not seen — confirming it stays accounts' work.",
    default: 10000000,
    min: 0,
    max: 1000000000,
  },

  /* ------------------------------------------------------------ expenses */
  {
    key: "mbos.expenses.billPhotoThresholdPaise",
    type: "integer",
    category: "mbos-expenses",
    label: "Expense needing a bill photograph",
    description:
      "Paise. At or above this a bill photograph is required before the line can be claimed. 0 requires one on every expense.",
    default: 20000,
    min: 0,
    max: 100000000,
  },
  {
    key: "mbos.expenses.categoryCapsPaise",
    type: "structured",
    category: "mbos-expenses",
    label: "Daily caps by category",
    description:
      "Paise per day per category. A claim above a cap is not refused — it goes up as a partial approval decision, which is what the approver's `approvedAmountPaise` is for.",
    default: { travel: 100000, food: 40000, lodging: 250000, other: 50000 },
  },
  {
    key: "mbos.expenses.backdatedDaysAllowed",
    type: "integer",
    category: "mbos-expenses",
    label: "How far back an expense may be dated",
    description:
      "Days. An expense dated further back than this cannot be entered without a manager. A future date is never accepted at all.",
    default: 30,
    min: 0,
    max: 365,
  },

  /* ---------------------------------------------------------- attendance */
  {
    key: "mbos.attendance.geofenceRadiusM",
    type: "integer",
    category: "mbos-attendance",
    label: "Check-in geofence radius",
    description:
      "Metres from the designated start location within which a check-in counts as on-site. Outside it the check-in still SAVES, with the distance recorded and the day flagged — a salesman starting at a customer's factory is doing his job, and a refused check-in is a day's work with no record of it.",
    default: 500,
    min: 25,
    max: 20000,
  },
  {
    key: "mbos.attendance.fullDayHours",
    type: "decimal",
    category: "mbos-attendance",
    label: "Full day",
    description: "Hours between check-in and check-out that count as a full day.",
    default: 8,
    min: 1,
    max: 24,
  },
  {
    key: "mbos.attendance.halfDayHours",
    type: "decimal",
    category: "mbos-attendance",
    label: "Half day threshold",
    description:
      "Hours below which a day is a half day rather than a full one. Below it entirely and the day is absent unless leave says otherwise. Must be under the full day, or every full day is also a half one.",
    default: 4,
    min: 0.5,
    max: 24,
  },
  {
    key: "mbos.attendance.autoCheckOutHour",
    type: "integer",
    category: "mbos-attendance",
    label: "Hour a missed check-out is closed",
    description:
      "A day nobody checked out of is closed at this hour and flagged for regularisation, rather than left open for ever. Local hour, in the working-day timezone.",
    default: 22,
    min: 0,
    max: 23,
  },
  {
    key: "mbos.attendance.selfieRequired",
    type: "boolean",
    category: "mbos-attendance",
    label: "Selfie on check-in",
    description:
      "A photograph at check-in. Off where the team finds it intrusive and the geofence is enough; it changes what the check-in asks for, never whether it is allowed.",
    default: true,
  },

  /* --------------------------------------------------------------- leave */
  {
    key: "mbos.leave.noticeDays",
    type: "integer",
    category: "mbos-leave",
    label: "Notice for planned leave",
    description:
      "Days ahead a casual or earned leave should be applied for. Sick leave is exempt, because nobody schedules it. Applying later is allowed and flagged, never blocked.",
    default: 2,
    min: 0,
    max: 90,
  },
  {
    key: "mbos.leave.allowLossOfPay",
    type: "boolean",
    category: "mbos-leave",
    label: "Allow leave beyond the balance",
    description:
      "On, an employee out of balance may still apply, as loss of pay. Off, the application is refused — which turns a conversation with a manager into an error message.",
    default: true,
  },

  /* -------------------------------------------------------- health score */
  {
    key: "mbos.health.componentWeights",
    type: "structured",
    category: "mbos-health",
    label: "Health score weights",
    description:
      "How much each part counts towards a customer's health score, out of 100. The score is a DERIVED cache like outstanding and the buying cycle: change these and re-run the recompute, never edit a customer's score. Every weight together should come to 100, or the score is out of something nobody stated.",
    default: {
      orderRecency: 25,
      orderValueTrend: 20,
      paymentBehaviour: 25,
      visitEngagement: 15,
      complaints: 15,
    },
  },
  {
    key: "mbos.health.atRiskBelow",
    type: "integer",
    category: "mbos-health",
    label: "At-risk score",
    description:
      "A customer scoring below this is shown as at risk on the salesman's list and in the AI assistant's suggestions. Advisory — nothing is blocked by a score.",
    default: 40,
    min: 0,
    max: 100,
  },
  {
    key: "mbos.health.staleAfterHours",
    type: "integer",
    category: "mbos-health",
    label: "Score goes stale after",
    description:
      "Hours after which a health score is shown with its age rather than as a current figure. A cache nobody has rebuilt is a number that was true once.",
    default: 24,
    min: 1,
    max: 720,
  },

  /* ---------------------------------------------------------------- sync */
  {
    key: "mbos.sync.imageMaxDimensionPx",
    type: "integer",
    category: "mbos-sync",
    label: "Image longest side",
    description:
      "Pixels. Photographs are resized on the handset before they are queued — a shop front at 4000px costs a salesman on 2G several minutes and tells a manager nothing a 1600px one does not.",
    default: 1600,
    min: 320,
    max: 4096,
  },
  {
    key: "mbos.sync.imageQualityPercent",
    type: "integer",
    category: "mbos-sync",
    label: "Image quality",
    description:
      "JPEG quality after the resize above. Low enough to move on a bad connection, high enough that a damaged can is still legible in the photograph.",
    default: 70,
    min: 30,
    max: 100,
  },
  {
    key: "mbos.sync.offlineLoginValidityDays",
    type: "integer",
    category: "mbos-sync",
    label: "Offline sign-in validity",
    description:
      "Days a handset may be signed in without ever reaching the server. Past it the app asks for a real sign-in — which is what stops a device that left the company from staying open indefinitely on a book of customers.",
    default: 7,
    min: 1,
    max: 90,
  },
  {
    key: "mbos.sync.retryBackoffSeconds",
    type: "structured",
    category: "mbos-sync",
    label: "Retry backoff",
    description:
      "Seconds between sync attempts, in order. After the last one the item is `failed` and shown for a person to retry by hand. Jittered on the device, and the schedule resumes rather than restarts across an app restart.",
    default: [2, 8, 30, 120, 600, 1800],
  },
  {
    key: "mbos.sync.maxItemsPerRequest",
    type: "integer",
    category: "mbos-sync",
    label: "Queue items per sync request",
    description:
      "How many outbox items one request carries. Small enough that thirty seconds of signal between two shops is enough for a round trip.",
    default: 50,
    min: 1,
    max: 500,
  },
  {
    key: "mbos.sync.accessTokenMinutes",
    type: "integer",
    category: "mbos-sync",
    label: "Access token life",
    description:
      "Minutes an access token is good for. Short, because it carries no revocation of its own — moving somebody off the field app takes effect when the next one is asked for. The refresh token, which does check the database, lives for the offline login validity above.",
    default: 60,
    min: 5,
    max: 1440,
  },
  {
    key: "mbos.orders.numberSeriesPrefix",
    type: "text",
    category: "mbos-orders",
    label: "Order number series",
    description:
      "The prefix of a field order's display number — `MBOS/26-27/0041`. The financial year and the sequence are added by the server, in a transaction, because two salesmen offline must never produce the same number.",
    default: "MBOS",
  },
  {
    key: "mbos.payments.receiptSeriesPrefix",
    type: "text",
    category: "mbos-payments",
    label: "Receipt number series",
    description:
      "The prefix of a field receipt's display number — `MRCP/26-27/0041`. Allocated server-side for the same reason the order series is.",
    default: "MRCP",
  },

  /* --------------------------------------------------------------- leads */
  {
    key: "mbos.leads.staleDays",
    type: "integer",
    category: "mbos-leads",
    label: "Lead goes stale after",
    description:
      "Days with no activity before a lead is tagged stale and surfaced to its owner and their manager.",
    default: 30,
    min: 1,
    max: 365,
  },
  {
    key: "mbos.leads.archiveDays",
    type: "integer",
    category: "mbos-leads",
    label: "Lead is archived after",
    description:
      "Days with no activity and no conversion before a lead archives itself. Archiving is a flag, never a delete — a cold lead is exactly who next year's campaign goes back to. Must be longer than the stale window, or nothing is ever merely stale.",
    default: 90,
    min: 2,
    max: 1095,
  },
  {
    key: "mbos.leads.escalateAfterDays",
    type: "integer",
    category: "mbos-leads",
    label: "Untouched lead escalates after",
    description:
      "Days with no activity before the manager is told. Deliberately shorter than the stale window: the point is to save the lead, not to record that it died.",
    default: 7,
    min: 1,
    max: 90,
  },

  /* --------------------------------------------------------------- tasks */
  {
    key: "mbos.tasks.escalationHours",
    type: "integer",
    category: "mbos-tasks",
    label: "Overdue task escalates after",
    description:
      "Hours past its due date before a task is escalated to the assignee's manager. Escalation is a notification and a flag; the task stays with whoever it was given to.",
    default: 24,
    min: 1,
    max: 720,
  },
  {
    key: "mbos.tasks.requireCompletionNote",
    type: "boolean",
    category: "mbos-tasks",
    label: "Require a note to close a task",
    description:
      "On, a task cannot be marked done without saying what was done. A closed task with nothing against it tells the person who raised it nothing at all.",
    default: true,
  },
  {
    key: "mbos.approvals.escalationHours",
    type: "integer",
    category: "mbos-tasks",
    label: "Approval escalates after",
    description:
      "Hours a request may sit undecided before it escalates. An approval with nowhere to go is a salesman waiting in a shop for an answer nobody is coming with.",
    default: 24,
    min: 1,
    max: 720,
  },

  /* --------------------------------------------------------------- visits */
  {
    key: "mbos.visits.minimumDwellSeconds",
    type: "integer",
    category: "mbos-location",
    label: "A visit must last at least",
    description:
      "Seconds in the shop before a visit counts as verified. Under it the visit still saves — it is marked unverified with the salesman's reason, because refusing the save teaches people to stop logging visits at all.",
    default: 120,
    min: 0,
    max: 3600,
  },

  /* ------------------------------------------------------------------ sync */
  {
    key: "mbos.sync.mediaWifiOnly",
    type: "boolean",
    category: "mbos-sync",
    label: "Upload photos on Wi-Fi only",
    description:
      "On, photographs and audio wait for Wi-Fi. Records NEVER wait — a payment reaches the office the moment there is any signal. What waits is the picture of the cheque, not the fact of it.",
    default: false,
  },
  {
    key: "mbos.ai.retainAudioAfterTranscription",
    type: "boolean",
    category: "mbos-sync",
    label: "Keep the recording after transcription",
    description:
      "On, voice notes are kept on the handset once transcribed. Off, they are deleted — but only ever after the transcript is confirmed stored, never merely because the upload finished.",
    default: false,
  },
] as const satisfies readonly SettingDefinition[];

export type SettingKey = (typeof SETTINGS)[number]["key"];

const BY_KEY = new Map<string, SettingDefinition>(
  SETTINGS.map((s) => [s.key, s as SettingDefinition]),
);

export function definition(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

export function settingsByCategory(): Record<string, SettingDefinition[]> {
  const out: Record<string, SettingDefinition[]> = {};
  for (const s of SETTINGS) {
    (out[s.category] ??= []).push(s as SettingDefinition);
  }
  return out;
}

/** Every default, as the shape the engines consume. */
export function defaultConfig(): Config {
  const out: Record<string, unknown> = {};
  for (const s of SETTINGS) out[s.key] = s.default;
  return out as Config;
}

/* ------------------------------------------------------------- validation */

export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * Validates at the point of the request, not the point of use. A bad threshold
 * must be rejected when a manager saves it, not discovered at 6 am when the
 * nightly job builds a nonsense queue.
 */
export function validateSetting(key: string, raw: unknown): ValidationResult {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, error: `Unknown setting "${key}".` };

  switch (def.type) {
    case "integer": {
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
        return { ok: false, error: `${def.label} must be a whole number.` };
      }
      if (def.min !== undefined && n < def.min) {
        return { ok: false, error: `${def.label} cannot be below ${def.min}.` };
      }
      if (def.max !== undefined && n > def.max) {
        return { ok: false, error: `${def.label} cannot be above ${def.max}.` };
      }
      return { ok: true, value: n };
    }
    case "decimal": {
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n)) {
        return { ok: false, error: `${def.label} must be a number.` };
      }
      if (def.min !== undefined && n < def.min) {
        return { ok: false, error: `${def.label} cannot be below ${def.min}.` };
      }
      if (def.max !== undefined && n > def.max) {
        return { ok: false, error: `${def.label} cannot be above ${def.max}.` };
      }
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true" || raw === "false") return { ok: true, value: raw === "true" };
      return { ok: false, error: `${def.label} must be true or false.` };
    }
    case "text": {
      if (typeof raw !== "string" || !raw.trim()) {
        return { ok: false, error: `${def.label} must be text.` };
      }
      if (def.options && !def.options.includes(raw)) {
        return {
          ok: false,
          error: `${def.label} must be one of: ${def.options.join(", ")}.`,
        };
      }
      return { ok: true, value: raw };
    }
    case "structured": {
      let value = raw;
      if (typeof raw === "string") {
        try {
          value = JSON.parse(raw);
        } catch {
          return { ok: false, error: `${def.label} must be valid JSON.` };
        }
      }
      if (value === null || typeof value !== "object") {
        return { ok: false, error: `${def.label} must be an object or a list.` };
      }
      return { ok: true, value };
    }
  }
}

/* ------------------------------------------------------- consistency check */

/**
 * Cross-setting rules. Section 12 warns that aging buckets and escalation
 * thresholds disagreeing makes two screens contradict each other about the
 * same account, so that pairing is checked explicitly.
 */
export function checkConsistency(config: Config): string[] {
  const problems: string[] = [];

  /*
   * Sarvam's synchronous endpoint refuses audio over 30 seconds. With the
   * fallback on, a longer recording simply goes to OpenAI instead and the
   * limit can be whatever suits a telecaller. With it off, a limit above 30
   * would let somebody speak for a minute into a recorder that was always
   * going to refuse it — the wasted minute is paid by the person on the phone.
   *
   * The recorder now caps itself at 30 in that case rather than running on and
   * failing, so this is no longer a broken deployment; it is a setting that
   * does not mean what it says, which a manager reading the number should
   * still be told. Note what this check CANNOT see: whether OpenAI has a key.
   * Configuration validation has no business reading secrets, so a fallback
   * that is switched on but has nothing behind it passes here and is caught
   * where the keys are actually known — see `resolveReadiness`.
   */
  if (
    config["voice.transcriptionProvider"] === "sarvam" &&
    !config["voice.fallbackToOpenai"] &&
    config["voice.maxSeconds"] > 30
  ) {
    problems.push(
      `Voice: Sarvam refuses audio over 30 seconds and the OpenAI fallback is off, so wherever a Sarvam key is set, recordings stop at 30s and the ${config["voice.maxSeconds"]}s limit has no effect. Lower it to 30, or turn the fallback back on. (With no Sarvam key this setting does nothing — OpenAI serves every recording at the full limit.)`,
    );
  }

  const { stage1Days, stage2Days, stage3Days } = {
    stage1Days: config["escalation.stage1Days"],
    stage2Days: config["escalation.stage2Days"],
    stage3Days: config["escalation.stage3Days"],
  };
  if (!(stage1Days < stage2Days && stage2Days < stage3Days)) {
    problems.push(
      "Escalation thresholds must increase: stage 1 < stage 2 < stage 3.",
    );
  }

  // The quiet window and stage 2 are two statements of the same fact: the day
  // a payment call may first be made. The calling list reads one, the
  // server-side stage-1 rule reads the other. Let them drift and the list
  // offers calls that saving them rejects.
  const quiet = config["escalation.quietCallDays"];
  if (stage2Days !== quiet + 1) {
    problems.push(
      `Calling opens on day ${stage2Days} (stage 2) but the quiet window runs to day ${quiet}. Stage 2 must be the day after the quiet window closes - set it to ${quiet + 1}, or shorten the window to ${stage2Days - 1}.`,
    );
  }

  const terms = config["bills.creditDayOptions"];
  if (!Array.isArray(terms) || terms.length === 0) {
    problems.push("At least one payment term must be offered when taking an order.");
  } else if (terms.some((d) => !Number.isInteger(d) || d < 0)) {
    problems.push("Payment terms must be whole numbers of days, none of them negative.");
  }

  if (config["buyingCycle.minDays"] > config["buyingCycle.maxDays"]) {
    problems.push("Minimum buying cycle cannot exceed the maximum.");
  }

  const buckets = config["bills.agingBuckets"];
  if (!Array.isArray(buckets) || buckets.length < 2) {
    problems.push("Aging buckets must list at least two boundaries.");
  } else {
    const sorted = [...buckets].every((v, i, a) => i === 0 || a[i - 1] < v);
    if (!sorted) problems.push("Aging bucket boundaries must increase.");
    // A bucket boundary is EXCLUSIVE — a boundary of 15 opens a band on day 16
    // — so a band starts at boundary + 1, and that is what has to line up with
    // the day a stage begins. Comparing the boundary itself was off by one: it
    // let 45 pass as "aligned" with a stage 3 that opens on day 45, which put
    // the first urgent day inside the 16–45 bucket on the bills screen.
    const bandStarts = buckets.map((b) => b + 1);
    if (!bandStarts.includes(stage2Days) && !bandStarts.includes(stage3Days)) {
      problems.push(
        `Aging buckets (${buckets.join(", ")}) open bands on days ${bandStarts.join(", ")}, none of which is where an escalation stage begins (${stage2Days}, ${stage3Days}). The bills screen and the follow-up screen will disagree about how overdue an account is.`,
      );
    }
  }

  const days = config["workingDay.workingDays"];
  if (!Array.isArray(days) || days.length === 0) {
    problems.push("At least one working day must be configured.");
  }

  const modes = config["payments.modes"];
  if (!Array.isArray(modes) || modes.length === 0) {
    problems.push("At least one payment mode must be offered.");
  } else {
    // A mode that demands a reference but is not on the form is a rule that can
    // never fire, and reads on the settings screen as though it does.
    const orphans = (config["payments.referenceRequiredModes"] ?? []).filter(
      (m) => !modes.includes(m),
    );
    if (orphans.length) {
      problems.push(
        `These modes require a reference but are not offered on the form: ${orphans.join(", ")}. Add them to the payment modes, or drop them from the list.`,
      );
    }

    // Same rule for a mode that carries a date of its own. A dated mode nobody
    // can pick is a field that can never be shown and a post-dated cheque that
    // can never be recorded, while the settings screen reads as though both
    // work.
    const datedOrphans = (config["payments.datedModes"] ?? []).filter(
      (m) => !modes.includes(m),
    );
    if (datedOrphans.length) {
      problems.push(
        `These modes carry a date of their own but are not offered on the form: ${datedOrphans.join(", ")}. Add them to the payment modes, or drop them from the list.`,
      );
    }
  }

  // The quiet a reported payment buys must expire while the customer is still
  // being chased at all. Set beyond the escalation ladder it would silence an
  // account permanently on nothing more than somebody's word.
  const reportedQuiet = config["payments.reportedQuietDays"];
  if (reportedQuiet > stage3Days) {
    problems.push(
      `A reported payment buys ${reportedQuiet} days of quiet, which outlasts the stage 3 threshold of ${stage3Days} days. An unconfirmed payment would take an account off the collections list for longer than the debt takes to become urgent.`,
    );
  }

  // A price list keyed on the customer's pricelist tag is the intended answer
  // one day, but nothing stores one yet. Offering it and letting somebody pick
  // it would produce orders valued from a table that does not exist.
  /* ------------------------------------------------- MBOS — field sales */

  // A fix the handset rates worse than the mismatch distance cannot tell the
  // two apart: every honest check-in on a poor signal would read as somebody
  // standing somewhere else, and a flag raised on all of them is a flag a
  // manager stops opening.
  const accuracy = config["mbos.location.gpsAccuracyThresholdM"];
  const mismatch = config["mbos.location.visitMismatchM"];
  if (mismatch <= accuracy) {
    problems.push(
      `A visit is flagged as a location mismatch at ${mismatch}m, but a fix is trusted down to ${accuracy}m of error. The mismatch distance must be comfortably larger than the accuracy threshold, or an honest check-in on a poor signal is flagged as a false one.`,
    );
  }

  // Two approval tiers that are one tier. The second approver would never be
  // asked, and the screen would say they were.
  const tier1 = config["mbos.orders.approvalThresholdPaise"];
  const tier2 = config["mbos.orders.secondTierThresholdPaise"];
  if (tier2 <= tier1) {
    problems.push(
      "The second approval tier must be above the first, or every order needing approval needs both approvers and the two tiers are one.",
    );
  }

  // Below the half-day threshold is a half day; at or above it is a full one.
  // Equal or inverted, a day is both or neither.
  if (config["mbos.attendance.halfDayHours"] >= config["mbos.attendance.fullDayHours"]) {
    problems.push(
      "The half-day threshold must be below the full day, or every full day also counts as a half day.",
    );
  }

  // A score out of an unstated total. Every screen reads it as a percentage.
  const weights = config["mbos.health.componentWeights"];
  if (!weights || typeof weights !== "object") {
    problems.push("Health score weights must be an object of component names to numbers.");
  } else {
    const values = Object.values(weights);
    if (values.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      problems.push("Every health score weight must be a number, none of them negative.");
    } else {
      const total = values.reduce((a, b) => a + b, 0);
      if (total !== 100) {
        problems.push(
          `Health score weights total ${total}, not 100. The score is shown as a figure out of a hundred, so the parts have to add up to one.`,
        );
      }
    }
  }

  // Archiving before staleness means nothing is ever merely stale: a lead the
  // owner could still have saved would be filed away without being surfaced.
  const staleDays = config["mbos.leads.staleDays"];
  const archiveDays = config["mbos.leads.archiveDays"];
  const escalateDays = config["mbos.leads.escalateAfterDays"];
  if (archiveDays <= staleDays) {
    problems.push(
      `Leads archive after ${archiveDays} days but only go stale at ${staleDays}. Archiving must come later, or a lead is filed away before anybody is told it needs working.`,
    );
  }
  if (escalateDays > staleDays) {
    problems.push(
      `A lead escalates to the manager after ${escalateDays} days but is not stale until ${staleDays}. Escalation is meant to save the lead, so it has to come first.`,
    );
  }

  // The backoff is what stands between a handset with no signal and a battery
  // spent retrying. An empty or unordered list is neither a schedule nor a give-up point.
  const backoff = config["mbos.sync.retryBackoffSeconds"];
  if (!Array.isArray(backoff) || backoff.length === 0) {
    problems.push("At least one retry backoff interval must be configured.");
  } else if (backoff.some((s) => typeof s !== "number" || s <= 0)) {
    problems.push("Every retry backoff interval must be a positive number of seconds.");
  } else if (!backoff.every((v, i, a) => i === 0 || a[i - 1] < v)) {
    problems.push(
      "Retry backoff intervals must increase — a backoff that does not back off is a retry loop.",
    );
  }

  // Caps for categories the expense form does not offer are rules that can
  // never fire, and read on the settings screen as though they do.
  const caps = config["mbos.expenses.categoryCapsPaise"];
  if (!caps || typeof caps !== "object") {
    problems.push("Expense caps must be an object of category names to amounts in paise.");
  } else {
    const known = ["travel", "food", "lodging", "other"];
    const unknown = Object.keys(caps).filter((k) => !known.includes(k));
    if (unknown.length) {
      problems.push(
        `These expense categories have caps but are not categories anybody can pick: ${unknown.join(", ")}. The categories are ${known.join(", ")}.`,
      );
    }
    if (Object.values(caps).some((v) => typeof v !== "number" || v < 0)) {
      problems.push("Every expense cap must be an amount in paise, none of them negative.");
    }
  }

  if (config["products.priceSource"] === "pricelist") {
    problems.push(
      "Prices are set to come from a customer price list, but no price list exists yet - nothing is keyed on a pricelist tag. Until one is built, order value has to stay manual.",
    );
  }

  return problems;
}

/* ------------------------------------------------------------------ types */

export type Config = {
  "queue.checkInIntervalDays": number;
  "queue.snapshotHour": number;
  "queue.whatsappCooldownDays": number;
  "queue.quietDaysAfterOrder": number;
  "queue.leadPercent": number;
  "queue.leadMinDays": number;
  "queue.leadMaxDays": number;
  "queue.noOrderCooldownDays": number;
  "queue.prospectIntervalDays": number;
  "queue.excludeActiveInOrderSystem": boolean;
  "queue.excludeCalledToday": boolean;
  "queue.maxSizePerUser": number;
  "queue.tierWeights": Record<QueueReasonKind, number>;
  "queue.routineCallPercent": number;
  "queue.routineConfidenceSwing": number;
  "queue.orderValueLookbackDays": number;
  "queue.routineMinCycleDays": number;
  "queue.outcomeCooldownDays": Record<string, number>;
  "queue.noAnswerRetryHours": number;
  "queue.noAnswerRetryDays": number[];
  "queue.noAnswerMaxAttempts": number;
  "queue.includePaymentDue": boolean;
  "queue.showOrderStatus": boolean;

  "buyingCycle.method": "median" | "mean";
  "buyingCycle.lookbackOrders": number;
  "buyingCycle.minIntervals": number;
  "buyingCycle.defaultDays": number;
  "buyingCycle.minDays": number;
  "buyingCycle.maxDays": number;

  "inactive.cycleMultiplier": number;
  "inactive.decisionAgeWarningDays": number;

  "escalation.stage1Days": number;
  "escalation.stage2Days": number;
  "escalation.stage3Days": number;
  "escalation.stageDriver": "oldest" | "largest";
  "escalation.partialPaymentResetsClock": boolean;
  "escalation.disputeHoldsEscalation": boolean;
  "escalation.quietCallDays": number;
  "escalation.messageIntervalDays": number;
  "escalation.callIntervalDays": number;
  "escalation.slowPayerLookbackMonths": number;
  "escalation.slowPayerGraceDays": number;
  "escalation.slowPayerLateCount": number;

  "bills.agingBuckets": number[];
  "bills.defaultCreditDays": number;
  "bills.creditDayOptions": number[];

  "payments.reportedQuietDays": number;
  "payments.allowOnAccountRemainder": boolean;
  "people.amChangeReasons": string[];
  "people.pickerSearchThreshold": number;
  "payments.modes": string[];
  "payments.referenceRequiredModes": string[];
  "payments.confirmationAgeWarningHours": number;
  "payments.datedModes": string[];
  "payments.holdStaleDays": number;
  "payments.matchWindowDays": number;
  "payments.matchTolerancePercent": number;

  "targets.defaultMethod": "trailing-average" | "last-month" | "fixed";
  "targets.trailingMonths": number;
  "targets.defaultUpliftPercent": number;
  "targets.proRateNewCustomers": boolean;

  "workingDay.shiftStart": string;
  "workingDay.shiftEnd": string;
  "workingDay.dayBoundaryHour": number;
  "workingDay.workingDays": number[];
  "workingDay.timezone": string;

  "reminders.rollForwardOnNonWorkingDays": boolean;
  "reminders.rescheduleWarningCount": number;

  "complaints.slaHours": { low: number; medium: number; high: number };
  "complaints.categories": string[];
  "dashboard.reminderOverdueFlagDays": number;
  "dashboard.complaintUnresolvedFlagDays": number;
  "complaints.defaultSeverity": "low" | "medium" | "high";
  "interactions.maxNotesLength": number;
  "customers.defaultCreditDays": number;

  "attachments.maxSizeMb": number;
  "attachments.acceptedTypes": string[];
  "attachments.maxPerComplaint": number;
  "attachments.maxPerFollowUp": number;
  "attachments.maxPerFeedback": number;
  "attachments.orphanCleanupHours": number;
  "attachments.retentionDays": number;

  "products.frequentCount": number;
  "products.frequentRanking": "orders" | "recency";
  "products.starterListCount": number;
  "products.priceSource": "unset" | "manual" | "product" | "pricelist";
  "products.searchOnOrderForms": boolean;
  "products.searchMinChars": number;
  "interactions.singleSelectOutcomes": string[];

  "whatsapp.mode": "manual" | "automatic";
  "whatsapp.contactsPerWeekLimit": number;
  "whatsapp.unconfirmedExpiryHours": number;
  "whatsapp.autoConfirmAfterHours": number;

  "voice.enabled": boolean;
  "voice.maxSeconds": number;
  "voice.maxSizeMb": number;
  "voice.transcriptionProvider": "sarvam" | "openai";
  "voice.noiseSuppression": boolean;
  "voice.autoGainControl": boolean;
  "voice.echoCancellation": boolean;
  "voice.fallbackToOpenai": boolean;
  "voice.transcriptionModel": string;
  "voice.openaiTranscriptionModel": string;
  "voice.languageModel": string;

  /* ------------------------------------------------- MBOS — field sales */
  "mbos.location.gpsAccuracyThresholdM": number;
  "mbos.location.visitMismatchM": number;
  "mbos.location.routeDeviationM": number;
  "mbos.location.unplannedVisitsPerDay": number;
  "mbos.location.trackWhileWorking": boolean;
  "mbos.location.trackEveryMinutes": number;
  "mbos.location.logActivityLocation": boolean;
  "mbos.location.activityFixMaxAgeSeconds": number;

  "mbos.orders.approvalThresholdPaise": number;
  "mbos.orders.secondTierThresholdPaise": number;
  "mbos.orders.minimumQuantityCans": number;
  "mbos.orders.numberSeriesPrefix": string;

  "mbos.credit.blockOnLimitExceeded": boolean;
  "mbos.credit.outstandingStaleHours": number;
  "mbos.credit.overdueDaysBlockOrders": number;

  "mbos.payments.cashDepositSlaHours": number;
  "mbos.payments.managerNotifyThresholdPaise": number;
  "mbos.payments.receiptSeriesPrefix": string;

  "mbos.expenses.billPhotoThresholdPaise": number;
  "mbos.expenses.categoryCapsPaise": Record<MbosExpenseCategory, number>;
  "mbos.expenses.backdatedDaysAllowed": number;

  "mbos.attendance.geofenceRadiusM": number;
  "mbos.attendance.fullDayHours": number;
  "mbos.attendance.halfDayHours": number;
  "mbos.attendance.autoCheckOutHour": number;
  "mbos.attendance.selfieRequired": boolean;

  "mbos.leave.noticeDays": number;
  "mbos.leave.allowLossOfPay": boolean;

  "mbos.health.componentWeights": Record<MbosHealthComponent, number>;
  "mbos.health.atRiskBelow": number;
  "mbos.health.staleAfterHours": number;

  "mbos.sync.imageMaxDimensionPx": number;
  "mbos.sync.imageQualityPercent": number;
  "mbos.sync.offlineLoginValidityDays": number;
  "mbos.sync.retryBackoffSeconds": number[];
  "mbos.sync.maxItemsPerRequest": number;
  "mbos.sync.accessTokenMinutes": number;

  "mbos.leads.staleDays": number;
  "mbos.leads.archiveDays": number;
  "mbos.leads.escalateAfterDays": number;

  "mbos.tasks.escalationHours": number;
  "mbos.tasks.requireCompletionNote": boolean;
  "mbos.approvals.escalationHours": number;
  "mbos.visits.minimumDwellSeconds": number;
  "mbos.sync.mediaWifiOnly": boolean;
  "mbos.ai.retainAudioAfterTranscription": boolean;
};

/** The parts a customer health score is made of. Weights must total 100. */
export type MbosHealthComponent =
  | "orderRecency"
  | "orderValueTrend"
  | "paymentBehaviour"
  | "visitEngagement"
  | "complaints";

/** Mirrors `mbos_expense_category` in the schema. */
export type MbosExpenseCategory = "travel" | "food" | "lodging" | "other";

export type QueueReasonKind =
  /** Money overdue and the collections engine says a call is due today. */
  | "paymentOverdue"
  | "reminderOverdue"
  | "reminderDueToday"
  | "orderOverdueFullCycle"
  | "orderDue"
  /** The routine stock check, at a percentage of the customer's own cycle. */
  | "routineCall"
  | "prospect"
  | "checkInOverdue"
  | "checkInDue"
  /** An order already placed and still working its way through. */
  | "orderStatus"
  /** Rang, nobody answered, and the ladder says try again now. */
  | "noAnswerRetry"
  /** The ladder is exhausted; somebody has to decide what happens next. */
  | "unreachable";
