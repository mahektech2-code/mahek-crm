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
import {
  LOST_REASONS,
  OVERRIDE_REASONS,
  PROSPECT_REASONS,
  SAMPLE_REASONS,
} from "../lead-labels";
import { LEAVE_TYPES, PAID_LEAVE_TYPES, type PaidLeaveType } from "../mbos/types";

export type SettingType = "integer" | "decimal" | "text" | "boolean" | "structured";

export type SettingCategory =
  | "queue"
  | "buying-cycle"
  | "inactive-watch"
  | "escalation"
  | "bills"
  | "payments"
  | "targets"
  /** How a salesman is measured: the six weights, the bands and the ceiling. */
  | "performance"
  /** The owner's five KPIs: the lead cohort window and the health bands. */
  | "owner"
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
  /** The sign-in code sent to a work number, and its provider. */
  | "auth"
  /* ---- MBOS, the field sales app. Same rule: no threshold is a constant. ---- */
  | "mbos-location"
  /**
   * How a day's stops are put in order. Four numbers that only mean anything
   * together — publishing one of them is half a control.
   */
  | "mbos-route"
  | "mbos-orders"
  | "mbos-credit"
  | "mbos-payments"
  | "mbos-expenses"
  | "mbos-attendance"
  | "mbos-leave"
  | "mbos-health"
  | "mbos-sync"
  /** The handsets themselves: how many a person may be signed in on. */
  | "mbos-devices"
  /** Reaching a handset that is not open. */
  | "mbos-push"
  | "mbos-leads"
  | "mbos-tasks"
  /** Maps on the handset, and how much of one it may keep for no signal. */
  | "mbos-maps"
  /**
   * Travel and expense — the PLATFORM behaviour, not the reimbursement terms.
   *
   * Every rate, limit, time rule and approval rule lives in `expense_policies`
   * instead, because those need versions and effective dates and these do not.
   * The test for which belongs here: would changing it restate what an old
   * claim was worth? If yes it is policy; if no it is a setting.
   */
  | "expenses";

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
  /**
   * Structured settings only: null is a real answer rather than an empty box.
   *
   * The ordinary structured setting is a map of weights or a list of reasons,
   * and a null one is a value somebody cleared by accident — refusing it is
   * right. It is wrong where the ABSENCE is the statement:
   * `mbos.attendance.baseLocation` null means nobody has said where the office
   * is, which is the shipped state and the state a deployment that typed the
   * wrong coordinates has to be able to get back to. Without this flag the
   * only way back from a bad pin would be a database write.
   */
  nullable?: boolean;
};

/**
 * The ranking, as data, and the ONE definition of it.
 *
 * Exported because the engine needs somewhere to fall back to. A stored
 * `queue.tierWeights` replaces this object wholesale rather than merging into
 * it, so a blob written before a reason kind existed — or before one was
 * renamed — leaves that kind with no weight at all, and `undefined` arithmetic
 * does not throw, it quietly poisons a sort.
 */
export const DEFAULT_TIER_WEIGHTS: Record<QueueReasonKind, number> = {
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
  /*
   * P3.5 — the customer who stopped.
   *
   * Past the same multiple of their own cycle that earns the Inactive badge,
   * and deliberately BELOW every call about an order that is merely due. This
   * is the "why did you stop" conversation, which is worth having and is not
   * worth having first: there are 322 of these against 198 active customers,
   * and at `orderOverdueFullCycle`'s weight they filled every 60-row list and
   * pushed the people about to reorder off the bottom of it. Ranked here, they
   * are worked when the day's real chasing is done.
   */
  orderLongOverdue: 45,
  checkInDue: 40,
  /* P4 — chasing a ring nobody answered, and the state after it. */
  unreachable: 35,
  noAnswerRetry: 30,
  /* Not a call for an order at all: an order already on its way. */
  orderStatus: 10,
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
      "Customers the collections cadence says are due a payment call appear at the top of the calling list rather than only on the payment screen. The collections engine still decides WHEN — this only decides whether the call log shows what it decided. Off by default: a payment call is collections' own worklist, at /crm/payments, and folding it into the Call Log put it in front of telecallers who cannot act on it.",
    default: false,
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
    default: DEFAULT_TIER_WEIGHTS,
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
    key: "people.companyName",
    type: "text",
    category: "people",
    label: "Company name",
    description:
      "The organisation everybody ultimately belongs to. It sits at the top of the org chart, above whoever has nobody above them, so the tree has one head instead of several loose ones. It is configuration rather than a constant for the ordinary reason: a name on a screen is a thing somebody eventually wants to change, and this one is already written out as a literal in four other places.",
    default: "Mahek Marketing India",
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
  /* -------------------------------------------------------------- sign-in */
  /*
   * NOTHING READS THESE YET, and a reader should know it before tuning one.
   * They were written for a sign-in where a work number and a code sent to it
   * are the whole credential. That flow is not built: `otp_channel` is an enum
   * in the schema with no table, no sender and no route behind it, and `signIn`
   * asks for a work number or an email AND a password. They are kept because
   * the thresholds are the right ones for the day it is built and none of them
   * may be a constant then — but until then, changing one changes nothing.
   */
  {
    key: "auth.otp.codeLength",
    type: "integer",
    category: "auth",
    label: "Code length",
    description: "Digits in a sign-in code. Six is the ordinary length for an SMS/WhatsApp OTP — short enough to read off a notification, long enough that guessing it is not a real attack within the attempt limit below.",
    default: 6,
    min: 4,
    max: 8,
  },
  {
    key: "auth.otp.ttlMinutes",
    type: "integer",
    category: "auth",
    label: "Code lifetime",
    description: "Minutes a code stays live after it is sent. Long enough for a message to actually arrive and be typed back; short enough that a code somebody glimpsed on a shared phone is useless an hour later.",
    default: 10,
    min: 1,
    max: 60,
  },
  {
    key: "auth.otp.maxVerifyAttempts",
    type: "integer",
    category: "auth",
    label: "Wrong-code attempts before a code is dead",
    description: "How many wrong guesses one sent code tolerates before it stops working, whether or not it has expired yet. Without a limit, a six-digit code sent once is a million guesses away from anybody with the time.",
    default: 5,
    min: 1,
    max: 20,
  },
  {
    key: "auth.otp.resendCooldownSeconds",
    type: "integer",
    category: "auth",
    label: "Wait before another code",
    description: "Seconds somebody must wait after one code before the screen will send another. Stops a slow network turning “Resend” into three SMS credits spent on one login.",
    default: 30,
    min: 10,
    max: 300,
  },
  {
    key: "auth.otp.maxRequestsPerWindow",
    type: "integer",
    category: "auth",
    label: "Codes allowed per window",
    description: "How many codes one account may be sent inside the window below. This is the guard against a number being used to run up an SMS bill rather than to sign in — the resend cooldown alone only slows that down.",
    default: 5,
    min: 1,
    max: 50,
  },
  {
    key: "auth.otp.requestWindowMinutes",
    type: "integer",
    category: "auth",
    label: "Request window",
    description: "The window the request limit above counts against, in minutes.",
    default: 60,
    min: 5,
    max: 1440,
  },
  {
    key: "auth.otp.defaultChannel",
    type: "text",
    category: "auth",
    label: "Default delivery channel",
    description: "Which channel the login screen offers first. Both are always offered — this only decides which one somebody sees without having to choose.",
    default: "sms",
    options: ["sms", "whatsapp"],
  },
  {
    key: "auth.otp.smsSenderId",
    type: "text",
    category: "auth",
    label: "SMS sender ID",
    description: "The six-character DLT-registered sender ID an SMS OTP is sent from. Set once the MSG91 account and its DLT entity are approved — until then SMS delivery cannot go out for real, and the code is written to the server log instead.",
    default: "",
  },
  {
    key: "auth.otp.smsTemplateId",
    type: "text",
    category: "auth",
    label: "SMS DLT template ID",
    description: "The DLT-approved template ID the OTP message is sent under. Indian carriers silently drop commercial SMS sent outside a registered template, so this has to name a real one before SMS delivery can work.",
    default: "",
  },
  {
    key: "auth.otp.whatsappTemplateName",
    type: "text",
    category: "auth",
    label: "WhatsApp template name",
    description: "The Meta-approved WhatsApp template the OTP is sent through. WhatsApp Business API refuses a free-form message to somebody who has not messaged first, so an OTP has to ride a template.",
    default: "",
  },
  {
    key: "auth.otp.whatsappTemplateNamespace",
    type: "text",
    category: "auth",
    label: "WhatsApp template namespace",
    description: "The namespace Meta assigned the WhatsApp Business account the template lives in, alongside the template name above.",
    default: "",
  },
  {
    key: "auth.otp.whatsappTemplateLanguage",
    type: "text",
    category: "auth",
    label: "WhatsApp template language code",
    description: "The language the WhatsApp template was approved in, e.g. \"en\". Sending the wrong code is refused by Meta rather than sent in the wrong language.",
    default: "en",
  },
  {
    key: "auth.otp.whatsappIntegratedNumber",
    type: "text",
    category: "auth",
    label: "WhatsApp business number",
    description: "The WhatsApp Business number MSG91 has integrated for this account, in international format with no leading +. A code cannot go out over WhatsApp without one.",
    default: "",
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

  /* ------------------------------------------------------ salesman scoring */
  /*
   * The six weights. They must total 100, which `checkConsistency` enforces —
   * a score "out of 100" computed from weights totalling 95 is a different
   * number wearing the same label, and nothing on any screen would say so.
   */
  {
    key: "performance.weightRevenue",
    type: "integer",
    category: "performance",
    label: "Weight: revenue",
    description:
      "How many of the hundred points revenue is worth. It is the largest single weight and deliberately not the only one - a salesman measured on rupees alone is rewarded for a price rise he had no part in.",
    default: 35,
    min: 0,
    max: 100,
  },
  {
    key: "performance.weightVolume",
    type: "integer",
    category: "performance",
    label: "Weight: volume",
    description:
      "How many points litres sold are worth. This is the half of the score a price revision cannot move, which is the whole reason it sits beside revenue.",
    default: 20,
    min: 0,
    max: 100,
  },
  {
    key: "performance.weightMix",
    type: "integer",
    category: "performance",
    label: "Weight: product mix",
    description:
      "How many points selling the strategic products is worth. Without it the easy-selling lines carry the month and Universal, PU and Nano are nobody's problem.",
    default: 20,
    min: 0,
    max: 100,
  },
  {
    key: "performance.weightNewCustomers",
    type: "integer",
    category: "performance",
    label: "Weight: new customers",
    description:
      "How many points acquisition is worth. It stops an excellent score being reachable by billing the same book harder every month.",
    default: 10,
    min: 0,
    max: 100,
  },
  {
    key: "performance.weightCollection",
    type: "integer",
    category: "performance",
    label: "Weight: collection",
    description:
      "How many points collected money is worth. A sale that is never paid for is not a sale, and this is where that shows up in the score.",
    default: 10,
    min: 0,
    max: 100,
  },
  {
    key: "performance.weightActivity",
    type: "integer",
    category: "performance",
    label: "Weight: activity",
    description:
      "How many points visits and calls are worth. The smallest weight on purpose - it measures effort rather than result, and a score that pays well for effort is one people learn to farm.",
    default: 5,
    min: 0,
    max: 100,
  },
  {
    key: "performance.maxAchievementPercent",
    type: "integer",
    category: "performance",
    label: "Scoring ceiling",
    description:
      "The most any one component may score, as a percentage of its target. 400% of a small revenue target would otherwise pay out more than every other component put together. The ceiling applies to the SCORE only - the screens print the real achievement beside it.",
    default: 120,
    min: 100,
    max: 300,
  },
  {
    key: "performance.mixScoreAtMinimum",
    type: "integer",
    category: "performance",
    label: "Mix: what the minimum share pays",
    description:
      "What a product category earns when its share lands exactly on the minimum, as a percentage of what that category is worth. Below the minimum it falls away to nothing; above it, it climbs to the target.",
    default: 60,
    min: 0,
    max: 100,
  },
  {
    key: "performance.mixScoreAtTarget",
    type: "integer",
    category: "performance",
    label: "Mix: what the target share pays",
    description: "What a product category earns when its share lands on the target.",
    default: 100,
    min: 0,
    max: 200,
  },
  {
    key: "performance.mixScoreAtStretch",
    type: "integer",
    category: "performance",
    label: "Mix: what the stretch share pays",
    description:
      "What a category earns at or above its stretch share. Above 100 it rewards exceptional depth in one line; the mix component as a whole is still capped at 100%, so stretch can never pay for another category being absent.",
    default: 110,
    min: 0,
    max: 200,
  },
  {
    key: "performance.ratingBands",
    type: "structured",
    category: "performance",
    label: "Rating bands",
    description:
      "The word printed beside the score. Read highest first, so the lowest band catches everything beneath the one above it.",
    default: [
      { min: 90, label: "Excellent" },
      { min: 80, label: "Very good" },
      { min: 70, label: "Good" },
      { min: 60, label: "Needs improvement" },
      { min: 0, label: "Poor" },
    ],
  },
  {
    key: "performance.volumeDivergencePoints",
    type: "integer",
    category: "performance",
    label: "Revenue-vs-volume divergence",
    description:
      "How many percentage points volume may sit below revenue before the month is flagged. Revenue at target with volume well under it means the money came from the price list rather than from selling more - which is the single most important thing this module was built to make visible, and the month in which somebody would otherwise be congratulated.",
    default: 10,
    min: 0,
    max: 100,
  },
  {
    key: "performance.paceWarningPercent",
    type: "integer",
    category: "performance",
    label: "Pace warning",
    description:
      "How far behind the month's own pace revenue may fall before it is flagged, as a percentage of the elapsed share of working days. At 80, a salesman half way through the working month is flagged below 40% of target. Measured in WORKING days, so a fortnight with three holidays does not read as a slow start.",
    default: 80,
    min: 0,
    max: 100,
  },
  {
    key: "performance.newCustomerBasis",
    type: "text",
    category: "performance",
    label: "What makes a customer new",
    description:
      "Whether a customer counts as won on their first order or on their first bill. Creating a lead never counts either way - a name in a list is not a customer, and counting it would make the acquisition target reachable from a desk.",
    default: "first-order",
    options: ["first-order", "first-bill"],
  },
  {
    key: "performance.revisionReasons",
    type: "structured",
    category: "performance",
    label: "Why a target was revised",
    description:
      "The reasons a manager may pick from when changing a published target. A list rather than free text, because the question people actually ask months later is which targets moved for a price revision and which moved because somebody was struggling.",
    default: [
      "Price revision",
      "Territory change",
      "Product discontinued",
      "New product launch",
      "Customer transferred",
      "Salesman transferred",
      "Market disruption",
      "Correction",
    ],
  },

  /* ------------------------------------------------------- the owner's five */
  /*
   * The health bands. `dormant` is deliberately absent: it IS
   * `inactive.cycleMultiplier`, which is the one threshold the source document
   * states precisely and the point at which `customers.status` becomes
   * inactive. A second dormant number would be two answers to "has this
   * customer gone quiet", and the day they drift the Call Log is chasing
   * somebody the owner's screen has written off.
   */
  {
    key: "health.atRiskCycleMultiplier",
    type: "decimal",
    category: "owner",
    label: "At risk after",
    description:
      "How many of the customer's OWN buying cycles may pass before they are called at risk. A fortnightly buyer and a twice-a-year buyer are both a quarter late at 1.25 of their own cycle; a flat 30/60/90 would call the first lost and the second fine. Must sit below the inactive multiplier, which is where dormant begins.",
    default: 1.25,
    min: 1,
    max: 10,
  },
  {
    key: "health.lostCycleMultiplier",
    type: "decimal",
    category: "owner",
    label: "Lost after",
    description:
      "Beyond this many of their own cycles a customer is treated as lost rather than dormant. It changes no other screen - dormant is already where the inactive flag falls - but it separates somebody worth one more call from somebody worth a campaign.",
    default: 3.0,
    min: 1,
    max: 20,
  },
  {
    key: "owner.conversionWindowDays",
    type: "integer",
    category: "owner",
    label: "Conversion window",
    description:
      "How long a lead has to place its first order before the cohort it belongs to stops waiting for it. Conversion is measured by COHORT - the leads created in a month, and how many of them ordered within this window - because dividing this month's first orders by this month's leads asks a lead created on the 29th to have ordered by the 31st.",
    default: 90,
    min: 1,
    max: 730,
  },
  {
    key: "owner.frequencyMediumOrders",
    type: "integer",
    category: "owner",
    label: "Medium frequency from",
    description: "Orders in the period at which a customer stops being low frequency.",
    default: 4,
    min: 1,
    max: 100,
  },
  {
    key: "owner.frequencyHighOrders",
    type: "integer",
    category: "owner",
    label: "High frequency from",
    description: "Orders in the period at which a customer counts as high frequency.",
    default: 8,
    min: 1,
    max: 200,
  },
  {
    key: "owner.conversionTargetPercent",
    type: "decimal",
    category: "owner",
    label: "Conversion rate target",
    description:
      "The lead-to-order conversion the owner expects. Below it the dashboard raises an alert - it is the only one of the five KPIs with an absolute target rather than a comparison against the period before.",
    default: 15,
    min: 0,
    max: 100,
  },
  {
    key: "owner.kpiAlertChangePercent",
    type: "decimal",
    category: "owner",
    label: "Movement worth an alert",
    description:
      "How far a KPI must move against the period before it to be worth saying out loud. Too low and every month raises six alerts, which is the same as raising none.",
    default: 10,
    min: 0,
    max: 100,
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
    label: "How close a check-in has to be",
    description:
      "Metres between the salesman and the shop's own pin. Inside it the check-in goes ahead; outside it the handset refuses, and he can only pass by saying in writing that the pin is wrong — which reaches you as an unverified visit. It is ALSO the distance a saved visit is flagged at, because the distance a check-in is refused at and the distance one is questioned at are one fact. Keep it comfortably larger than the accuracy above: a fix that is itself 50 m wide cannot tell a doorway from the tea shop across the road, and every refusal it produces falls on somebody standing in the right place.",
    default: 100,
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
    key: "mbos.location.trackEverySeconds",
    type: "integer",
    category: "mbos-location",
    label: "How often a position is taken",
    description:
      "Seconds between fixes while the day is open. At this density the line connecting them hugs the actual road on its own, without needing a map-matching service to snap it there — the tighter the interval, the closer the shape gets to the road actually walked. Every few seconds is close to exact and costs real battery over a full field day; a minute or more is back to a line that cuts corners through buildings. Three is close to exact — the shape of the road, not just the shape of the beat — and worth the extra battery once a salesman is checked in rather than idle. It is a ceiling on how often the HANDSET tries, not a promise: a dropped signal or a backgrounded app still leaves real gaps no interval fixes, which is what the Live map's own gap line is for.",
    default: 3,
    min: 3,
    max: 300,
  },
  {
    key: "mbos.location.trackEveryMinutes",
    type: "integer",
    category: "mbos-location",
    label: "How far apart two points on the trail may be",
    description:
      "Minutes. The one above is a CEILING on how often the handset asks the OS for a position; this is the floor on how often one is actually kept, and it is the number that decides what the trail looks like and what it costs to upload. The two are not the same question and must not be collapsed: Android delivers on its own schedule whatever it is asked for, so the app keeps what it wants and discards the rest — which is the whole reason a setting that asked for five minutes once ran at three seconds for three days. Longer draws a line that cuts corners through buildings; shorter fills the upload queue faster than a market lane can drain it.",
    default: 5,
    min: 1,
    max: 120,
  },
  {
    key: "mbos.location.trailStalledAfterMisses",
    type: "integer",
    category: "mbos-location",
    label: "Missed fixes before the handset stops believing it is tracking",
    description:
      "Android accepts the background tracking task and then, on a vivo, an Oppo or a Xiaomi, the battery manager quietly kills the service behind it — the handset is told it started and is never told otherwise. Silence is the only evidence there is, so this is how many of its own position intervals may pass with nothing recorded before the phone concludes it is not tracking, falls back to taking fixes while the app is open, and tells the office what it is really doing. Too low and a salesman walking through a basement godown is demoted off real background tracking for the rest of the day; too high and a handset that will never deliver a fix spends a morning believing it is.",
    default: 4,
    min: 2,
    max: 60,
  },
  {
    key: "mbos.location.startOfDayGate",
    type: "text",
    category: "mbos-location",
    options: ["block", "warn", "off"],
    label: "What happens when a handset cannot record the day",
    description:
      "A salesman checked in at 04:16 on a vivo and posted not one position all day: every permission on the phone read correct, the tracking service started properly, and the handset's own battery manager killed it within minutes. Nothing looked broken at either end and the day was gone by the time anybody noticed — a trail cannot be reconstructed afterwards. Block means the day does not open until the phone can show it will record, with the steps to fix it on the screen and, where the phone genuinely cannot, a plain dead end rather than a button that leads nowhere. Warn opens the day anyway and still records what was wrong, which is how to turn this on for a team without a morning of nobody being able to mark attendance — the office can count who would have been stopped first. Off is no gate at all. There is no skip a salesman can reach in any of the three: a day that opened on a phone that could not record it, filed beside one that could, is exactly the pair nobody can tell apart a week later.",
    default: "block",
  },
  {
    key: "mbos.location.dwellRadiusMeters",
    type: "integer",
    category: "mbos-location",
    label: "How far counts as \"still there\"",
    description:
      "Metres a run of consecutive fixes may drift from each other and still count as one stop rather than movement — GPS drifts even standing still, so this has to clear ordinary drift without also swallowing a slow walk down one street. Sized off the accuracy a handset actually reports, not off the road: a tighter number here reads a slow walk as a stop, a looser one misses a real one.",
    default: 60,
    min: 15,
    max: 300,
  },
  {
    key: "mbos.location.dwellMinMinutes",
    type: "integer",
    category: "mbos-location",
    label: "How long counts as a stop worth marking",
    description:
      "Minutes a salesman has to stay within the radius above before the Live map marks it as a stop rather than a red light or a moment fishing for change. A few minutes is long enough to mean something was actually happening there.",
    default: 5,
    min: 1,
    max: 60,
  },
  {
    key: "mbos.location.tripBreakMinutes",
    type: "integer",
    category: "mbos-location",
    label: "How long a stop has to be before the trail changes colour",
    description:
      "Minutes. The Live map draws a day as coloured legs, and a stop longer than this is what ends one leg and begins the next. Deliberately longer than the stop-marking threshold above: every pause worth a mark on the map is not a new journey, and colouring it as one turns a morning in a single market into a rainbow nobody can read. A shop visit ends a leg; waiting at a counter does not.",
    default: 10,
    min: 2,
    max: 120,
  },
  {
    key: "mbos.location.trailGapMeters",
    type: "integer",
    category: "mbos-location",
    label: "How far apart counts as no path recorded",
    description:
      "Metres between two consecutive fixes before the Live map stops drawing a confident line between them and draws an honest gap instead — a straight, dashed line saying nothing is known about what happened in between, rather than a solid one that looks like the road was walked. Below this, two fixes are close enough that a straight line between them already is the road, at the sampling density this app uses; above it, the fixes are far enough apart that the road actually taken is a guess, most often a stretch driven rather than walked, or a stretch where the handset's signal dropped.",
    default: 200,
    min: 50,
    max: 2000,
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
  {
    key: "mbos.location.handsetQuietMinutes",
    type: "integer",
    category: "mbos-location",
    label: "How long a working handset may go silent before the Live map says so",
    description:
      "Minutes. A phone that cannot reach us cannot tell us it cannot reach us, so silence is the only evidence there is that a salesman is out of signal, out of battery or has closed the app — and this is where that silence starts being worth saying out loud. It changes what the Live map SAYS and nothing a handset does. It is deliberately not the same number as the Sync health screen's quiet hours: that one asks whether a phone has stopped syncing at all, over days, and this one asks whether a man who checked in this morning has gone quiet since — which on an open working day is a question measured in minutes.",
    default: 30,
    min: 5,
    max: 720,
  },
  {
    key: "mbos.location.noTrailMinutes",
    type: "integer",
    category: "mbos-location",
    label: "How long an open day may run with no trail at all before the Live map says so",
    description:
      "Minutes since the check-in. A day four minutes old with no fix yet is a phone still starting its tracking task; one four hours old with not a single position is a handset whose trail is dead, and until this existed nothing on any screen said so — the map simply drew him at his check-in point and the only note he got was that he had gone quiet, which sent managers looking for a signal problem on a phone that was syncing perfectly. It is deliberately not the same number as the silence above: that one asks whether we are hearing from the phone at all, and this one asks whether the phone that IS reporting has produced a trail.",
    default: 90,
    min: 10,
    max: 720,
  },
  {
    key: "mbos.location.lowBatteryPercent",
    type: "integer",
    category: "mbos-location",
    label: "Battery level the Live map calls low",
    description:
      "Per cent, at or below which a salesman's handset is flagged on the team list. A flat phone in the middle of a beat is the commonest reason a trail simply stops, and it is the one cause a manager can still do something about while the day is running. The reading is never live — it is whatever the phone last reported — so the screen always prints the time it was taken beside it.",
    default: 20,
    min: 5,
    max: 50,
  },
  {
    key: "mbos.sync.quietHours",
    type: "integer",
    category: "mbos-sync",
    label: "How long a handset may go unheard before it is called quiet",
    description:
      "Hours since a device last spoke to MahekOne. This only changes what the Sync health screen highlights, never what any handset does — a salesman whose phone has had no signal for a morning is not the same as one whose phone has stopped syncing, and this is where a manager draws that line.",
    default: 24,
    min: 1,
    max: 168,
  },

  /* ------------------------------------------------------- route ordering
   *
   * The four arguments `engines/route.ts` takes, and it takes them as
   * arguments precisely so they can be these. They ran as compiled defaults on
   * every handset in the field until they were published here — which is the
   * silent failure `getConfig` is built to make safe and which is invisible
   * exactly because the numbers it fell back to were the numbers everybody
   * assumed were in force. Each default below is what has actually been
   * running, so publishing them changed nobody's route.
   *
   * They are one category because they are one control. Two of them bound the
   * work the phone is allowed to do and two of them price a day in minutes;
   * on their own, each reads as a knob nobody can predict the effect of.
   */
  {
    key: "mbos.route.averageSpeedKmph",
    type: "integer",
    category: "mbos-route",
    label: "Average speed on the road",
    description:
      "Kilometres an hour, used to turn the straight-line distance between two shops into minutes. The honest number differs by a factor of three between a city beat on a two-wheeler and a district tour in a car, which is the whole reason it is a setting. It changes the day's estimated finishing time, never the order the stops are visited in — that is decided by distance alone.",
    default: 22,
    min: 5,
    max: 120,
  },
  {
    key: "mbos.route.minutesPerStop",
    type: "integer",
    category: "mbos-route",
    label: "Minutes budgeted inside a shop",
    description:
      "Added to every stop on the day, including the ones with no location on file. Travel time alone under-reads a day badly enough to be useless for planning — a beat of twenty shops is mostly time spent in them. Like the speed above, it moves the estimate and not the order.",
    default: 20,
    min: 1,
    max: 240,
  },
  {
    key: "mbos.route.maxStopsForTwoOpt",
    type: "integer",
    category: "mbos-route",
    label: "Longest list the tidy-up pass will take",
    description:
      "Above this many located stops the improvement pass is skipped and the nearest-neighbour order stands. It is a ceiling on work a mid-range Android has to do on the spot, not a judgement about route quality: the pass is O(n²) per sweep, and a pathological list would lock the screen. A day's beat is twenty to thirty shops, so raising it affects almost nobody and lowering it quietly stops the tidy-up happening at all.",
    default: 40,
    min: 0,
    max: 500,
  },
  {
    key: "mbos.route.maxTwoOptPasses",
    type: "integer",
    category: "mbos-route",
    label: "Sweeps of the tidy-up pass",
    description:
      "How many times the route may be swept for a pair of legs worth swapping — what removes the long dash back across the territory that nearest-neighbour leaves behind. It is a CEILING and rarely reached: a sweep that improves nothing ends the pass, because every later sweep would improve nothing either. Zero turns the tidy-up off.",
    default: 4,
    min: 0,
    max: 50,
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
  /*
   * `mbos.expenses.categoryCapsPaise` WAS HERE, and it is retired.
   *
   * One key, read three contradictory ways: this entry called it a DAILY cap
   * and said in as many words that a claim above one "is not refused";
   * `handleExpense` read it PER CLAIM and rejected the sync outright; the
   * handset read it as a MONTHLY running total and flagged the claim. Three
   * answers to "what am I allowed", and the salesman met whichever of them the
   * screen he was standing on happened to hold. It also never carried
   * `local_transport`, so the one kind a man claims several times a day was
   * capped by nothing on any path.
   *
   * The policy is the single authority now. `expense_policies` carries
   * `capPerInstancePaise` and `capPerDayPaise`, `computeDay` honours both, and
   * `claim-preview.ts` runs that same engine on the handset so what he is told
   * before he spends is what the office pays. 0089 already moved these four
   * numbers across as daily `actuals` rules on a draft version, so nothing was
   * lost by retiring them here.
   *
   * The rejection went with it, because the engine's own header states the
   * principle the whole module rests on: it never refuses anything. The money
   * is already spent, and a system that refuses to record it has not saved the
   * money — it has only made sure nobody finds out. A sync rejection is the
   * worst available shape of that, since the claim dies in an outbox on a
   * phone rather than arriving as something somebody has to decide about.
   *
   * A stored `app_settings` row for it needs no migration: `getConfig` layers
   * a stored value only where `definition(key)` still answers, so a row for a
   * key the registry has forgotten is already unreadable by every path here,
   * and `configDrift` walks SETTINGS rather than the table. 0089 deliberately
   * READ that row and left it — it is the provenance of the draft policy's
   * figures, and deleting it would destroy that to tidy away something nothing
   * can see.
   */
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

  /* --------------------------------------------- travel and expense policy */
  {
    key: "expenses.policyFallbackToConfig",
    type: "boolean",
    category: "expenses",
    label: "Fall back to the old caps where no policy covers a date",
    description:
      "THERE IS NOTHING LEFT TO FALL BACK TO, and this switch does nothing. It was written for `mbos.expenses.categoryCapsPaise`, which is retired — 0089 moved those four figures into a draft policy version, and the policy is the single authority on what a claim is worth. Nothing reads this setting. It is kept only because deleting a key and the thing it named in one change is how a reader a year from now ends up unable to work out what either of them meant; a day with no published policy is recorded and reported as unpriced, which is what the off position always described and is now simply the behaviour.",
    default: true,
  },
  {
    key: "expenses.gpsRoadFactorBps",
    type: "integer",
    category: "expenses",
    label: "Straight line to estimated road distance",
    description:
      "Basis points. 12500 means a road is assumed to be 25% longer than the crow flies. Used ONLY where the day's track did not cover a leg, and the result is labelled an estimate on every screen that shows it — never presented as a measurement.",
    default: 12500,
    min: 10000,
    max: 30000,
  },
  {
    key: "expenses.gpsMinCoveragePct",
    type: "integer",
    category: "expenses",
    label: "Track coverage below which GPS is evidence rather than a distance",
    description:
      "Per cent. A leg the phone reported through is measurable; a leg it saw twice is not. Below this the trail figure is still shown — it is the cross-check against the odometer — but the leg falls back to a labelled estimate rather than being paid on a line that cut every corner.",
    default: 60,
    min: 0,
    max: 100,
  },
  {
    key: "expenses.odometerPhotoRandomPct",
    type: "integer",
    category: "expenses",
    label: "Share of days asked for an odometer photograph at random",
    description:
      "Per cent. The draw is made in the office and sent to the handset, never rolled on the device — a random check a phone can decline to roll is not a check. Only read where the active policy's odometer rule says 'random'.",
    default: 10,
    min: 0,
    max: 100,
  },
  {
    key: "expenses.duplicateWindowDays",
    type: "integer",
    category: "expenses",
    label: "How far either side a duplicate claim is looked for",
    description:
      "Days. A bill number or a bill photograph matching inside this window raises a question at the point of entry. It is a suggestion and never a gate: two salesmen claiming the same fare on one Tuesday is an ordinary Tuesday.",
    default: 30,
    min: 1,
    max: 365,
  },
  {
    key: "expenses.anomalyLookbackDays",
    type: "integer",
    category: "expenses",
    label: "History a day is compared against",
    description:
      "Days. The person's own recent days and the team's, as medians rather than means — one enormous day in a month drags a mean up far enough to hide the next one.",
    default: 90,
    min: 7,
    max: 730,
  },
  {
    key: "expenses.anomalyMinHistoryDays",
    type: "integer",
    category: "expenses",
    label: "Days of history before anybody is compared to themselves",
    description:
      "Below this nothing is flagged against a person's own average. Three days is not a pattern, and a flag raised in somebody's second week is a flag raised against not having been here long — which nobody can act on and everybody learns to ignore.",
    default: 5,
    min: 1,
    max: 60,
  },
  {
    key: "expenses.eodReopenWindowDays",
    type: "integer",
    category: "expenses",
    label: "How long a submitted day may be reopened",
    description:
      "Days. Past this a locked day cannot be corrected at all, which is deliberate: an authorised correction is a real thing and an authorised correction to a quarter that has been reported on is not. Reopening always takes a reason.",
    default: 7,
    min: 0,
    max: 90,
  },
  {
    key: "expenses.trendMonths",
    type: "integer",
    category: "expenses",
    label: "Months of expense trend the owner is shown",
    description: "Requirement 72. Read from the monthly snapshot, not from live data — a trend rebuilt from live rows restates history every time an old claim is corrected.",
    default: 12,
    min: 3,
    max: 36,
  },

  /* ---------------------------------------------------------- attendance */
  {
    key: "mbos.attendance.baseLocation",
    type: "structured",
    category: "mbos-attendance",
    nullable: true,
    label: "Where the geofence is drawn around",
    description:
      'The office\'s own coordinates, as {"lat": 21.1458, "lng": 79.0882}. Read them off a map — right-click the building in Google Maps and the pair is the first line of the menu — or leave the box EMPTY, which means nobody has said, and a check-in is then never measured against anything rather than being measured against a guess. It is a JSON box and not a map to click on because the radius beside it was published without it for the life of the module: a distance with no centre is half a control, and half a control that works today beats a whole one nobody has built. A map picker writes this same key and can arrive without anybody re-entering anything.',
    default: null,
  },
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
  {
    key: "mbos.attendance.selfieRetentionHours",
    type: "integer",
    category: "mbos-attendance",
    label: "Keep an attendance photograph for",
    description:
      "Hours before a check-in or check-out photograph is deleted. It is EVIDENCE OF A MOMENT, not a record to keep: it exists so a manager can verify that the person who marked the day is the person who worked it, and that question is asked within a day or two or not at all. Held longer it stops being verification and becomes a collection of photographs of employees, which is a different thing to hold and a worse one to lose. Only the image goes — the check-in, its time, its place and the fact that a photograph was taken are all kept for ever. This is ALSO how far back the Attendance screen can show one, because they are the same fact: a screen offering a photograph the sweep has already destroyed is a screen that appears broken.",
    default: 72,
    min: 1,
    max: 8760,
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
  {
    key: "mbos.leave.annualEntitlementDays",
    type: "structured",
    category: "mbos-leave",
    label: "Leave a person gets in a year",
    description:
      "Days per kind, for everybody, per calendar year. This is what the handset builds its list of leave kinds from — a kind missing from here cannot be applied for at all, and with none of them set the only thing the form can offer is loss of pay. A person on different terms gets a row in `mbos_leave_balances`, which overrides this for them alone. `loss_of_pay` does not belong here: it is what leave becomes once the balance is gone, and there is no balance of unpaid days to keep.",
    /*
     * Twenty-four days, which is the two a month the employee sheet states
     * on 54 of its 64 filled rows — the only leave figure Mahek has written
     * down anywhere, so it is the one to default to.
     *
     * The sheet's `yearly_maximum_leave` says 60 and is NOT this number: it
     * only reconciles with two days a month if it means the most absence
     * allowed in a year including unpaid, which is a different question to
     * what somebody is entitled to. Six rows carry 24 in the MONTHLY column,
     * which is the annual figure typed into the wrong cell — that is why the
     * sheet is read for the number once, here, by a person, rather than
     * projected into balances every night by a job.
     *
     * The split across the three kinds is not in the sheet at all. It is a
     * decision, and this is where it is recorded rather than in anybody's
     * memory.
     */
    default: { casual: 12, sick: 6, earned: 6 },
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
    label: "Watch below this score",
    description:
      "A customer scoring below this is worth a look, and the screens say which of the five components is dragging. Deliberately NOT called at risk any more: that phrase belongs to the retention band, which asks whether somebody has stopped BUYING, and a customer ordering perfectly on time can still score badly for late payments or open complaints. Two settings using one phrase for two questions is what B3-16 was raised about. Advisory - nothing is blocked by a score. The key keeps its old name so no stored setting has to be migrated.",
    default: 40,
    min: 0,
    max: 100,
  },
  {
    key: "mbos.health.strongAtOrAbove",
    type: "integer",
    category: "mbos-health",
    label: "Strong at or above this score",
    description:
      "At or above this a customer's score reads as strong. It existed as a literal 70 inside the handset's health pill, with 50 beside it, which made two business thresholds invisible to the one screen a manager would go to change them. Nothing business-critical is a constant.",
    default: 70,
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
  /* ------------------------------------------------------------- handsets */
  {
    key: "mbos.devices.onePerPerson",
    type: "boolean",
    category: "mbos-devices",
    label: "One handset per person",
    description:
      "On, somebody signed in on one phone is refused on a second until the first is released — brief §2.2, and the reason is that a field account is a person's own: two live handsets on one login means a day's visits, orders and cash-in-hand that nobody can attribute, and a phone that has quietly left the company still holding a book of customers. Off, the same login opens on as many handsets as it is typed into. Turn it off deliberately and for a reason — a salesman whose phone broke on a Tuesday, a shared handset between shifts — because nothing else in the app distinguishes the two devices afterwards. It does NOT let one person take over a handset registered to somebody else; that stays refused either way.",
    default: true,
  },
  {
    key: "mbos.devices.appLockGraceSeconds",
    type: "integer",
    category: "mbos-devices",
    label: "App lock grace period",
    description:
      "Seconds the app may sit in the background before the fingerprint is asked for again. The lock exists because a field handset carries the whole book — every customer, what each owes, and the ability to place an order — and it spends the day on shop counters. But the app hands off constantly and deliberately: the system camera for a shop photo, WhatsApp to send a receipt, the dialler to ring a customer. Locking on every return would make the salesman prove himself twenty times a morning to finish jobs he was in the middle of, which is how a lock gets turned off. Long enough for a hand-off, short enough that a phone left on a counter closes itself. A cold start always asks, whatever this says.",
    default: 180,
    min: 0,
    max: 3600,
  },

  /* ----------------------------------------------------------------- push */
  {
    key: "mbos.push.enabled",
    type: "boolean",
    category: "mbos-push",
    label: "Send push notifications",
    description:
      "Off, MahekOne still writes every notification — the bell in the app is unaffected and nothing is lost. What stops is the message arriving on a handset that is closed, which is the only way somebody learns about a declined order or a task before they next open the app. Turn it off to silence the field team's phones without losing the record of what they were told.",
    default: true,
  },
  {
    key: "mbos.push.expoProjectId",
    type: "text",
    category: "mbos-push",
    label: "Expo project id",
    description:
      "The id `getExpoPushTokenAsync` asks Expo's service for a token against — a UUID from `eas init`, or from the project's page on expo.dev. It lives HERE rather than only in `app.json` because a value baked into the bundle is a value that needs a new APK on every handset to change, and the last thing this setting should be is another reason to rebuild. The handset reads it from its synced configuration and falls back to `app.json` where this is blank. Empty means no token can be requested at all, and every screen that mentions push says so rather than pretending.",
    default: "",
  },
  {
    key: "mbos.push.quietHours",
    type: "structured",
    category: "mbos-push",
    label: "Quiet hours",
    description:
      "The window a push waits out, as `[from, to]` in 24-hour local time. A field salesman's phone is his own phone, and an order approval at half past eleven at night is a notification that teaches him to turn them off — which costs the ones that matter. `[22, 7]` is ten at night until seven in the morning; equal values mean no quiet hours at all. The notification row is still written immediately either way: what waits is the buzz, not the record.",
    default: [22, 7],
  },
  {
    key: "mbos.push.failureRetentionDays",
    type: "integer",
    category: "mbos-push",
    label: "How long a failed push is kept",
    description:
      "A delivered push is deleted the moment its receipt confirms it — the notification row is the record and a second copy of it is not worth keeping. A FAILED one is kept this long, because it is the only evidence of why somebody never heard about a decision, and it is the list to read before concluding that push does not work.",
    default: 30,
    min: 1,
    max: 365,
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
  {
    key: "mbos.leads.visitsBeforeDecision",
    type: "integer",
    category: "mbos-leads",
    label: "Warn about a Suspect after",
    description:
      "Visits to a lead that is still a Suspect before the handset starts asking the salesman to decide. A warning, never a refusal — he is told the next visit needs an answer, and the visit itself is never blocked.",
    default: 2,
    min: 1,
    max: 10,
  },
  {
    key: "mbos.leads.maxSuspectVisits",
    type: "integer",
    category: "mbos-leads",
    label: "Suspect decision required at",
    description:
      "The visit on which a Prospect-or-not answer becomes mandatory before the visit can be closed. It does NOT stop the visit being made or recorded — a cap that refuses the save is a cap that produces unlogged visits, and the company loses the GPS, the competitor note and the reason to prevent a number reaching four. Beyond it the lead is escalated to the manager instead.",
    default: 3,
    min: 1,
    max: 10,
  },

  {
    key: "mbos.leads.validationScript",
    type: "structured",
    category: "mbos-leads",
    label: "Validation call script",
    description:
      "What the caller reads out and asks on the Prospect validation call. Configuration rather than code because it is CONTENT — the wording will be argued about, improved after a bad call, and translated, and none of that should need a deploy. Each section is a heading and the lines under it; the caller sees them in this order, on the handset and in the console.",
    default: {
      sections: [
        {
          heading: "Introduce yourself — 30 seconds",
          lines: [
            "Good morning, my name is ___ from Mahek Marketing India.",
            "I look after this area with ___, who came to see you on ___.",
            "Is this a good moment, or shall I call back?",
          ],
        },
        {
          heading: "Introduce the company — 30 seconds",
          lines: [
            "We make thinners and coatings and supply shops and factories across the region.",
            "We deliver ourselves, and we can hold stock for a regular customer.",
          ],
        },
        {
          heading: "Check the visit",
          lines: [
            "Did our man explain the products clearly?",
            "What did you make of the quality?",
            "Any thoughts on how we dispatch and how quickly?",
            "And was he alright with you — anything we should know?",
          ],
        },
        {
          heading: "Confirm what they need",
          lines: [
            "What is it you are actually looking for?",
            "Roughly how much do you get through in a month?",
            "Who are you buying from at the moment?",
          ],
        },
      ],
    },
  },

  {
    key: "mbos.samples.reviewAfterDays",
    type: "integer",
    category: "mbos-leads",
    label: "Sample review call after",
    description:
      "Days after the customer CONFIRMS they have the sample before the review call is due. Dated from confirmed receipt and never from dispatch: a review timed from the day we posted it rings somebody still waiting for the parcel, and that call teaches them we do not know where our own stock is.",
    default: 3,
    min: 1,
    max: 30,
  },

  {
    key: "mbos.samples.transitChaseAfterDays",
    type: "integer",
    category: "mbos-leads",
    label: "Chase a sample in transit after",
    description:
      "Days after DISPATCH before somebody is asked to find out where the sample got to. It is the mirror of the review call: that one is dated from confirmed receipt because the customer has it, and this one from dispatch because they do not. A sample that never arrives is the quietest way a lead dies - the salesman assumes it is being tried, the shop assumes we forgot, and nothing on either screen says otherwise.",
    default: 4,
    min: 1,
    max: 30,
  },

  {
    key: "mbos.location.nearbyRadiusOptions",
    type: "structured",
    category: "mbos-location",
    label: "Nearby search radii",
    description:
      "The distances the handset offers when a salesman asks what is near him, in metres. Configuration because a city beat and a district tour do not mean the same thing by 'nearby' — five kilometres is the next lane in Nagpur and half a day in Vidarbha.",
    default: { metres: [1000, 3000, 5000, 10000, 25000] },
  },
  {
    key: "mbos.location.nearbyPerKilometreCost",
    type: "integer",
    category: "mbos-location",
    label: "What a kilometre is worth",
    description:
      "How much a kilometre of travel counts AGAINST a reason to visit, when the handset orders what is nearby. This is the whole trade-off in one number: raise it and the list stays local, lower it and a good reason will send somebody across town. It is configuration and not a constant because a kilometre on a two-wheeler through a market and a kilometre on a district tour are not the same kilometre.",
    default: 12,
    min: 0,
    max: 200,
  },

  /* ------------------------------------------------- maps, kept for offline

     A salesman in a market lane has no signal, and a map that is blank exactly
     where he is standing is worse than no map at all. These decide what a
     handset may download to answer that, and every one of them is a trade
     between the size of the download and how much of the map survives it. */
  {
    key: "mbos.maps.offlineEnabled",
    type: "boolean",
    category: "mbos-maps",
    label: "Let handsets download maps to work offline",
    description:
      "On, a salesman can save the streets around the places he works so the map still draws with no signal. Off, the screen is not offered at all rather than offered and refused — a control that fails when pressed is worse than one never drawn. Nothing already downloaded is deleted by turning this off; it stops new downloads.",
    default: true,
  },
  {
    key: "mbos.maps.maxZoom",
    type: "integer",
    category: "mbos-maps",
    label: "Closest zoom saved",
    description:
      "How far in a saved map still has streets. THIS IS THE SETTING THAT DECIDES THE SIZE — each step closer is four times the tiles, so 17 is roughly four times the download of 16 and sixteen times that of 15. At 16 a market lane has its name on it, which is the point of the whole feature; at 14 the download is small and the salesman is looking at a map of the town he already knows.",
    default: 16,
    min: 10,
    max: 18,
  },
  {
    key: "mbos.maps.minZoom",
    type: "integer",
    category: "mbos-maps",
    label: "Furthest zoom saved",
    description:
      "How far out a saved map still draws. Costs almost nothing — the whole of a district is four tiles at zoom 9 — and without it the map is blank the moment somebody pinches out to see where an area sits.",
    default: 9,
    min: 0,
    max: 14,
  },
  {
    key: "mbos.maps.areaSeparationKm",
    type: "integer",
    category: "mbos-maps",
    label: "How far apart two places are",
    description:
      "Kilometres between shops before the handset treats them as two places to download rather than one. This is what stops a book spread over a state becoming a single box with three hundred kilometres of farmland in it. Raise it and a salesman downloads fewer, larger maps; lower it and he downloads more, smaller ones, and has to remember which. Shops link in a chain, so a beat running down a highway stays one map however long it is, as long as each step is under this.",
    default: 25,
    min: 1,
    max: 200,
  },
  {
    key: "mbos.maps.paddingMetres",
    type: "integer",
    category: "mbos-maps",
    label: "Margin around the shops",
    description:
      "Metres of map saved beyond the outermost shop. A map that stops at the shop's own doorstep is no use for getting there — this is the road he arrives on, the junction he turns at and the lane behind. It is also what keeps a download useful as the book grows: a shop added next month just outside the old edge is still inside what was saved.",
    default: 2000,
    min: 0,
    max: 20000,
  },
  {
    key: "mbos.maps.bytesPerTileEstimate",
    type: "integer",
    category: "mbos-maps",
    label: "Assumed size of one map tile",
    description:
      "Bytes, used ONLY to tell a salesman what a download will cost before he starts it. A tile over a paint market is several times one over farmland, so this is an estimate and every screen calls it one — but the decision it informs is \"tens of megabytes or hundreds\", and it is right about that. Tune it once somebody has watched a few real downloads finish against what this predicted.",
    default: 45000,
    min: 1000,
    max: 500000,
  },
  {
    key: "mbos.maps.maxPackMegabytes",
    type: "integer",
    category: "mbos-maps",
    label: "Largest map a handset may save",
    description:
      "Megabytes. An area estimated above this is shown with its size and NOT offered — a download that fills a salesman's phone is a phone that stops taking photographs of cheques. If a place somebody genuinely works is over the limit, the fix is to lower \"How far apart two places are\" so it splits into towns, or to save one zoom level less.",
    default: 500,
    min: 20,
    max: 4000,
  },
  {
    key: "mbos.maps.tileCountLimit",
    type: "integer",
    category: "mbos-maps",
    label: "Tiles a handset may hold in total",
    description:
      "A ceiling MapLibre itself enforces across every saved map on the phone, and it ABORTS a download rather than trimming it — so it is deliberately set well above what the megabyte limit above allows. The two are different units and the phone cannot convert between them; if this one binds first, a download the size check had already approved stops part-way with an error about tiles that means nothing to the person reading it. Its own shipped default is 6,000, which is a few square kilometres and no use here at all.",
    default: 250000,
    min: 1000,
    max: 5000000,
  },
  {
    key: "mbos.maps.downloadOnWifiOnly",
    type: "boolean",
    category: "mbos-maps",
    label: "Only download maps on Wi-Fi",
    description:
      "On, the download button says why it is off while the phone is on mobile data. Several hundred megabytes out of a salesman's own data allowance is a real cost to him, and it is the kind he only finds out about at the end of the month. Off, he decides — the size is on the screen either way.",
    default: true,
  },
  {
    key: "mbos.maps.refreshAfterDays",
    type: "integer",
    category: "mbos-maps",
    label: "Call a saved map old after",
    description:
      "Days before a saved map is marked as worth refreshing. Roads do not change quickly, so this is a nudge and never an expiry — nothing is deleted and the old map goes on working. Refreshing re-checks each tile against the server and downloads only what actually changed, so it costs far less than saving the area again.",
    default: 120,
    min: 7,
    max: 1095,
  },

  /* ------------------------------------------------------ the lead funnel */
  {
    key: "leads.suspectMaxVisits",
    type: "integer",
    category: "mbos-leads",
    label: "Visits before a Suspect must be decided",
    description:
      "§4. A salesman gets this many visits to work out whether there is a genuine opportunity, and then the lead turns into a single question: Prospect or not. The specification's normal target is two and its absolute maximum is three. Nothing is refused when the cap is reached - a decision is DEMANDED, which is the opposite gesture, and the lead cannot be quietly left in the drawer instead.",
    default: 3,
    min: 1,
    max: 10,
  },
  {
    key: "leads.requireNextAction",
    type: "boolean",
    category: "mbos-leads",
    label: "Every active lead must have a next action",
    description:
      "§24. An upward move is refused unless the lead names what happens next, on what day, and who is doing it. Off, a lead may move with none of the three - which is how a lead sits for six weeks with everybody assuming somebody else is holding it. It never applies to a lead raised before the funnel existed: those carry no sales type and are exempt by design.",
    default: true,
  },
  {
    key: "leads.allowManagerOverride",
    type: "boolean",
    category: "mbos-leads",
    label: "A manager may move a lead past a gate",
    description:
      "§28 with its escape hatch. A system that refuses everything is defeated in a week by people recording the work after the event, and the record then says the process was followed when it was not - which is worse than the gate being open. An override is a manager's alone, it demands a reason, and it stores exactly which conditions were still missing. Off, nobody may pass a gate that is shut.",
    default: true,
  },
  {
    key: "leads.prospectReasons",
    type: "structured",
    category: "mbos-leads",
    label: "Why a Suspect becomes a Prospect",
    description:
      "§5. A closed list rather than a text box, because the question exists to stop a shop being promoted on the strength of having been walked past - and a free-text field answers it with 'good potential' every time, which is not an answer and cannot be counted. Each entry is a code and a label; the code is what is stored, so rewording a label never orphans the leads already carrying it.",
    default: PROSPECT_REASONS.map((r) => ({ ...r })),
  },
  {
    key: "leads.sampleReasons",
    type: "structured",
    category: "mbos-leads",
    label: "Why the customer wants a trial",
    description:
      "§10. Asked at the moment the sample is requested, for the same reason as the list above: a sample is stock given away, and 'they asked for one' has to be distinguishable from 'they are comparing us against the incumbent'.",
    default: SAMPLE_REASONS.map((r) => ({ ...r })),
  },
  {
    key: "leads.lostReasons",
    type: "structured",
    category: "mbos-leads",
    label: "Why a lead was lost",
    description:
      "§26. A loss nobody explained teaches nothing, which the handset and the server have both refused to accept for as long as the field has existed. What this adds is that the answer is a CODE - so 'how many did we lose on credit terms this quarter' becomes a question somebody can ask, rather than a grep over free text.",
    default: LOST_REASONS.map((r) => ({ ...r })),
  },
  {
    key: "leads.overrideReasons",
    type: "structured",
    category: "mbos-leads",
    label: "Why a manager overrode a gate",
    description:
      "Only offered where the override setting above is on. The commonest honest answer is the first one - the work was done and recorded afterwards - and naming it is what keeps the override from being used as a shrug.",
    default: OVERRIDE_REASONS.map((r) => ({ ...r })),
  },
  {
    key: "leads.sampleReviewChaseDays",
    type: "structured",
    category: "mbos-leads",
    label: "Chasing a sample review",
    description:
      "§16. Days after the sample was received to ask what they thought, in order. The specification's own ladder is day 2, then 4, then 6, and it does not stop: the LAST interval repeats until there is an answer, because a trial nobody reviewed is stock given away for nothing. The count of times it has been asked is on the sample, and a screen showing 'asked three times' is what tells a manager to ring themselves.",
    default: [2, 4, 6],
  },
  {
    key: "leads.verificationDueDays",
    type: "integer",
    category: "mbos-leads",
    label: "Verification call is due within",
    description:
      "§7, §8. Days from a lead reaching Prospect before the sales manager's verification call is overdue. Deliberately short: the call checks that the visit happened and that Mahek was explained, and both answers decay fast in the customer's memory.",
    default: 2,
    min: 1,
    max: 30,
  },
  {
    key: "leads.distributorDiscountApprovalPercent",
    type: "integer",
    category: "mbos-leads",
    label: "Discount needing management approval",
    description:
      "§12. A special discount above this routes the distributor appointment past the sales manager to management. The person carrying the target must not be the person allowing the discount that hits it - the same reasoning that keeps order approval away from managers entirely.",
    default: 5,
    min: 0,
    max: 100,
  },
  {
    key: "leads.distributorCreditLimitApprovalPaise",
    type: "integer",
    category: "mbos-leads",
    label: "Credit limit needing management approval",
    description:
      "§12, in paise. A credit limit above this routes the appointment to management. Territory exclusivity always does, whatever the numbers say, because it is the one term that cannot be walked back without taking something away from somebody.",
    default: 50000000,
    min: 0,
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
  {
    key: "mbos.travel.maxLegKilometres",
    type: "integer",
    category: "mbos-location",
    label: "Longest single journey to one shop",
    description:
      "Kilometres. A guard against a mistyped odometer, not a limit on how far anybody may travel: 41,208 entered as 4,120 turns one journey into a claim for thirty-seven thousand kilometres, and the policy engine would price it without a murmur. Above this the handset refuses the reading while he is still standing at the meter and can look again — which is the only moment anybody can. It applies to a journey opened from Start visit; a leg typed up afterwards on the Travel screen is a different kind of evidence and is not held to it.",
    default: 400,
    min: 1,
    max: 5000,
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
      /* An empty box is how a screen spells null, and `asText` already renders
         null back into one — so on a nullable setting the round trip has to
         close here or the value can be read and never written again. */
      if (def.nullable && (raw === null || (typeof raw === "string" && !raw.trim()))) {
        return { ok: true, value: null };
      }
      if (typeof raw === "string") {
        try {
          value = JSON.parse(raw);
        } catch {
          return { ok: false, error: `${def.label} must be valid JSON.` };
        }
      }
      if (def.nullable && value === null) return { ok: true, value: null };
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
   * A score cannot be both strong and worth watching. Set the strong threshold
   * at or below the watch one and every score in the overlap is rendered green
   * by one rule and red by the other on two screens that both claim to show
   * health — which is the shape of the confusion B3-16 was raised about, one
   * level down. Refused here rather than resolved by ordering the branches in
   * `healthView`, because a rule the code silently works around is a rule
   * nobody knows is broken.
   */
  if (config["mbos.health.strongAtOrAbove"] <= config["mbos.health.atRiskBelow"]) {
    problems.push(
      `Health: "strong at or above" (${config["mbos.health.strongAtOrAbove"]}) must sit above "watch below" (${config["mbos.health.atRiskBelow"]}), or a score between them is both at once.`,
    );
  }

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

  /*
   * The six weights are a division of one hundred points. Letting them total
   * 95 or 110 does not break anything visibly — it produces a score out of a
   * different number, printed under a heading that says 100, and the appraisal
   * conversation happens on the strength of it.
   */
  const weightKeys = [
    "performance.weightRevenue",
    "performance.weightVolume",
    "performance.weightMix",
    "performance.weightNewCustomers",
    "performance.weightCollection",
    "performance.weightActivity",
  ] as const;
  const weightTotal = weightKeys.reduce((sum, k) => sum + config[k], 0);
  if (weightTotal !== 100) {
    problems.push(
      `The performance weights total ${weightTotal}, not 100. A score presented out of 100 has to be computed out of 100 — adjust one of the six.`,
    );
  }

  // Anchors that do not increase make the mix score fall as a share rises,
  // which is invisible until somebody is marked down for selling more Nano.
  if (
    !(
      config["performance.mixScoreAtMinimum"] <= config["performance.mixScoreAtTarget"] &&
      config["performance.mixScoreAtTarget"] <= config["performance.mixScoreAtStretch"]
    )
  ) {
    problems.push(
      "Mix scoring must not fall as a share rises: minimum ≤ target ≤ stretch.",
    );
  }

  const bands = config["performance.ratingBands"];
  if (!Array.isArray(bands) || bands.length === 0) {
    problems.push("At least one rating band is needed, or a score has no word beside it.");
  } else if (!bands.some((b) => b.min <= 0)) {
    problems.push(
      "The lowest rating band must start at 0, or a poor enough score falls through every band and is left unrated.",
    );
  }

  /*
   * The bands have to increase, and dormant is `inactive.cycleMultiplier`.
   * Out of order they would classify a customer who is further behind as
   * healthier — invisible until somebody asks why a two-year-silent account is
   * on the active list.
   */
  const health = {
    atRisk: config["health.atRiskCycleMultiplier"],
    dormant: config["inactive.cycleMultiplier"],
    lost: config["health.lostCycleMultiplier"],
  };
  if (!(health.atRisk < health.dormant && health.dormant < health.lost)) {
    problems.push(
      `Customer health bands must increase: at risk (${health.atRisk}) < dormant (${health.dormant}, the inactive multiplier) < lost (${health.lost}).`,
    );
  }

  if (config["owner.frequencyMediumOrders"] >= config["owner.frequencyHighOrders"]) {
    problems.push(
      "High frequency must start above medium frequency, or no customer can ever be medium.",
    );
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

  // A fix the handset rates worse than the check-in radius cannot tell the two
  // apart: every honest check-in on a poor signal would read as somebody
  // standing somewhere else. This used only to raise a flag a manager stops
  // opening; it now REFUSES the check-in, so the same misconfiguration turns
  // into a salesman standing in the right shop being told he is not there.
  const accuracy = config["mbos.location.gpsAccuracyThresholdM"];
  const mismatch = config["mbos.location.visitMismatchM"];
  if (mismatch <= accuracy) {
    problems.push(
      `A check-in is refused past ${mismatch}m from the shop, but a fix is trusted down to ${accuracy}m of error. The radius must be comfortably larger than the accuracy threshold, or an honest salesman on a poor signal is refused at the door of the right shop.`,
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
  /*
   * The warning has to come BEFORE the decision is demanded, or it is not a
   * warning. Equal is allowed and means "no warning" — a team that wants the
   * answer on the second visit with no build-up can say so.
   */
  const warnAt = config["mbos.leads.visitsBeforeDecision"];
  const decideAt = config["mbos.leads.maxSuspectVisits"];
  if (warnAt > decideAt) {
    problems.push(
      `A Suspect decision is demanded on visit ${decideAt} but the warning does not start until visit ${warnAt}. The salesman would be asked for an answer he was never told was coming.`,
    );
  }
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

  /*
   * A saved map whose closest zoom is below its furthest is an empty download:
   * the handset would ask for every level from 16 down to 9 and there are none,
   * so the pack completes instantly at nothing and the salesman is left with a
   * row that says "saved" over a blank map.
   */
  const mapMin = config["mbos.maps.minZoom"];
  const mapMax = config["mbos.maps.maxZoom"];
  if (mapMin > mapMax) {
    problems.push(
      `Saved maps would go from zoom ${mapMin} out to ${mapMax} in, which is no zoom levels at all. The closest zoom must be at least the furthest one.`,
    );
  }

  /*
   * The tile ceiling and the megabyte ceiling are two limits in two units on
   * the same download, and only one of them is enforced by something that can
   * explain itself. MapLibre's ABORTS the download; ours refuses it up front
   * with the size on the screen. If the tile ceiling binds first, a salesman
   * starts a download this app has already told him is fine and it stops
   * part-way with an error about tiles.
   */
  const megabyteCeiling = config["mbos.maps.maxPackMegabytes"];
  const perTile = config["mbos.maps.bytesPerTileEstimate"];
  const tilesAtCeiling = Math.ceil((megabyteCeiling * 1_000_000) / perTile);
  if (config["mbos.maps.tileCountLimit"] < tilesAtCeiling) {
    problems.push(
      `A ${megabyteCeiling} MB map is about ${tilesAtCeiling.toLocaleString("en-IN")} tiles, which is more than the ${config["mbos.maps.tileCountLimit"].toLocaleString("en-IN")}-tile ceiling. Downloads the size limit allows would abort part-way — raise the tile ceiling, or lower the megabyte one.`,
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

  /*
   * A base location nobody can stand at.
   *
   * Empty is fine and is the shipped answer — with no base there is nothing to
   * be outside of, and a check-in is never refused for want of one. What is
   * not fine is a pair that parses and is not a place: a longitude typed into
   * the latitude, or the two swapped, puts the office in the sea, and then
   * EVERY check-in is flagged as off-site with nothing on any screen saying
   * why. A geofence is the one setting here whose wrongness is invisible at
   * the moment it is saved and obvious only to the salesman being accused.
   */
  const base = config["mbos.attendance.baseLocation"];
  if (base !== null && base !== undefined) {
    const lat = (base as { lat?: unknown }).lat;
    const lng = (base as { lng?: unknown }).lng;
    if (typeof lat !== "number" || typeof lng !== "number") {
      problems.push(
        'The base location must be a lat and a lng, as {"lat": 21.1458, "lng": 79.0882}, or left empty for no base at all.',
      );
    } else if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      problems.push(
        `The base location ${lat}, ${lng} is not a point on earth — a latitude runs to 90 and a longitude to 180, and the commonest way to get this wrong is to type them the other way round.`,
      );
    }
  }

  /*
   * An entitlement is not just a number — it is the LIST the handset builds
   * its leave form from, so a typo here does not misprice a kind of leave, it
   * removes it. Somebody who cannot find "casual" on the form applies for loss
   * of pay instead and finds out on the payslip, which is precisely the failure
   * this setting exists to end.
   */
  const entitlement = config["mbos.leave.annualEntitlementDays"];
  if (!entitlement || typeof entitlement !== "object") {
    problems.push(
      "Leave entitlement must be an object of leave kinds to days a year. With none set, the only thing the handset's leave form can offer is loss of pay.",
    );
  } else {
    const unknown = Object.keys(entitlement).filter(
      (k) => !(PAID_LEAVE_TYPES as readonly string[]).includes(k),
    );
    if (unknown.length) {
      const wrongHalf = unknown.filter((k) => (LEAVE_TYPES as readonly string[]).includes(k));
      problems.push(
        `These are not kinds of leave anybody has a balance of: ${unknown.join(", ")}. The kinds are ${PAID_LEAVE_TYPES.join(", ")}.${
          wrongHalf.length
            ? ` ${wrongHalf.join(", ")} is what leave becomes once the balance is spent, so there is no yearly allowance of it to set.`
            : ""
        }`,
      );
    }
    if (Object.values(entitlement).some((v) => typeof v !== "number" || v < 0)) {
      problems.push("Every leave entitlement must be a number of days, none of them negative.");
    }
    if (!Object.keys(entitlement).length) {
      problems.push(
        "No kind of leave has an entitlement, so the handset's leave form can offer nothing but loss of pay — every request anybody makes would be unpaid.",
      );
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
  "people.companyName": string;
  "people.pickerSearchThreshold": number;

  "auth.otp.codeLength": number;
  "auth.otp.ttlMinutes": number;
  "auth.otp.maxVerifyAttempts": number;
  "auth.otp.resendCooldownSeconds": number;
  "auth.otp.maxRequestsPerWindow": number;
  "auth.otp.requestWindowMinutes": number;
  "auth.otp.defaultChannel": "sms" | "whatsapp";
  "auth.otp.smsSenderId": string;
  "auth.otp.smsTemplateId": string;
  "auth.otp.whatsappTemplateName": string;
  "auth.otp.whatsappTemplateNamespace": string;
  "auth.otp.whatsappTemplateLanguage": string;
  "auth.otp.whatsappIntegratedNumber": string;

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

  "performance.weightRevenue": number;
  "performance.weightVolume": number;
  "performance.weightMix": number;
  "performance.weightNewCustomers": number;
  "performance.weightCollection": number;
  "performance.weightActivity": number;
  "performance.maxAchievementPercent": number;
  "performance.mixScoreAtMinimum": number;
  "performance.mixScoreAtTarget": number;
  "performance.mixScoreAtStretch": number;
  "performance.ratingBands": { min: number; label: string }[];
  "performance.volumeDivergencePoints": number;
  "performance.paceWarningPercent": number;
  "performance.newCustomerBasis": "first-order" | "first-bill";
  "performance.revisionReasons": string[];

  "health.atRiskCycleMultiplier": number;
  "health.lostCycleMultiplier": number;
  "owner.conversionWindowDays": number;
  "owner.frequencyHighOrders": number;
  "owner.frequencyMediumOrders": number;
  "owner.conversionTargetPercent": number;
  "owner.kpiAlertChangePercent": number;

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
  "mbos.location.trackEverySeconds": number;
  "mbos.location.trackEveryMinutes": number;
  "mbos.location.trailStalledAfterMisses": number;
  "mbos.location.dwellRadiusMeters": number;
  "mbos.location.dwellMinMinutes": number;
  "mbos.location.tripBreakMinutes": number;
  "mbos.location.trailGapMeters": number;
  "mbos.location.logActivityLocation": boolean;
  "mbos.location.activityFixMaxAgeSeconds": number;
  "mbos.location.handsetQuietMinutes": number;
  "mbos.location.noTrailMinutes": number;
  "mbos.location.lowBatteryPercent": number;
  "mbos.sync.quietHours": number;

  "mbos.route.averageSpeedKmph": number;
  "mbos.route.minutesPerStop": number;
  "mbos.route.maxStopsForTwoOpt": number;
  "mbos.route.maxTwoOptPasses": number;

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
  "mbos.expenses.backdatedDaysAllowed": number;
  "expenses.policyFallbackToConfig": boolean;
  "expenses.gpsRoadFactorBps": number;
  "expenses.gpsMinCoveragePct": number;
  "expenses.odometerPhotoRandomPct": number;
  "expenses.duplicateWindowDays": number;
  "expenses.anomalyLookbackDays": number;
  "expenses.anomalyMinHistoryDays": number;
  "expenses.eodReopenWindowDays": number;
  "expenses.trendMonths": number;

  "mbos.attendance.baseLocation": { lat: number; lng: number } | null;
  "mbos.attendance.geofenceRadiusM": number;
  "mbos.attendance.fullDayHours": number;
  "mbos.attendance.halfDayHours": number;
  "mbos.attendance.autoCheckOutHour": number;
  "mbos.attendance.selfieRequired": boolean;
  "mbos.attendance.selfieRetentionHours": number;

  "mbos.leave.noticeDays": number;
  "mbos.leave.allowLossOfPay": boolean;
  "mbos.leave.annualEntitlementDays": Partial<Record<PaidLeaveType, number>>;

  "mbos.health.componentWeights": Record<MbosHealthComponent, number>;
  "mbos.health.atRiskBelow": number;
  "mbos.health.strongAtOrAbove": number;
  "mbos.health.staleAfterHours": number;

  "mbos.sync.imageMaxDimensionPx": number;
  "mbos.sync.imageQualityPercent": number;
  "mbos.sync.offlineLoginValidityDays": number;
  "mbos.sync.retryBackoffSeconds": number[];
  "mbos.sync.maxItemsPerRequest": number;
  "mbos.sync.accessTokenMinutes": number;

  "mbos.devices.onePerPerson": boolean;
  "mbos.devices.appLockGraceSeconds": number;

  "mbos.push.enabled": boolean;
  "mbos.push.expoProjectId": string;
  "mbos.push.quietHours": number[];
  "mbos.push.failureRetentionDays": number;

  "mbos.leads.staleDays": number;
  "mbos.leads.archiveDays": number;
  "mbos.leads.escalateAfterDays": number;
  "mbos.leads.visitsBeforeDecision": number;
  "mbos.leads.maxSuspectVisits": number;
  "mbos.samples.reviewAfterDays": number;
  "mbos.samples.transitChaseAfterDays": number;
  "mbos.location.nearbyRadiusOptions": { metres: number[] };
  "mbos.location.nearbyPerKilometreCost": number;
  "mbos.leads.validationScript": {
    sections: { heading: string; lines: string[] }[];
  };

  "mbos.maps.offlineEnabled": boolean;
  "mbos.maps.minZoom": number;
  "mbos.maps.maxZoom": number;
  "mbos.maps.areaSeparationKm": number;
  "mbos.maps.paddingMetres": number;
  "mbos.maps.bytesPerTileEstimate": number;
  "mbos.maps.maxPackMegabytes": number;
  "mbos.maps.tileCountLimit": number;
  "mbos.maps.downloadOnWifiOnly": boolean;
  "mbos.maps.refreshAfterDays": number;

  "leads.suspectMaxVisits": number;
  "leads.requireNextAction": boolean;
  "leads.allowManagerOverride": boolean;
  "leads.prospectReasons": { code: string; label: string }[];
  "leads.sampleReasons": { code: string; label: string }[];
  "leads.lostReasons": { code: string; label: string }[];
  "leads.overrideReasons": { code: string; label: string }[];
  "leads.sampleReviewChaseDays": number[];
  "leads.verificationDueDays": number;
  "leads.distributorDiscountApprovalPercent": number;
  "leads.distributorCreditLimitApprovalPaise": number;

  "mbos.tasks.escalationHours": number;
  "mbos.tasks.requireCompletionNote": boolean;
  "mbos.approvals.escalationHours": number;
  "mbos.visits.minimumDwellSeconds": number;
  "mbos.travel.maxLegKilometres": number;
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
  /** Past the multiple of their own cycle that earns the Inactive badge. */
  | "orderLongOverdue"
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
