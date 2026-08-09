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
  | "targets"
  | "working-day"
  | "reminders"
  | "complaints"
  | "products"
  | "attachments"
  | "interactions"
  | "whatsapp";

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
      "Never chase an order inside this many days of the last one. A customer reordering faster than this is serving themselves, and a call adds nothing. Reminders still fire \u2014 a callback the customer asked for is not chasing.",
    default: 15,
    min: 0,
    max: 90,
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
      reminderOverdue: 100,
      reminderDueToday: 90,
      orderOverdueFullCycle: 80,
      orderDue: 70,
      orderDueSoon: 60,
      prospect: 55,
      checkInOverdue: 50,
      checkInDue: 40,
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
    description: "Clamp against absurdly short computed cycles.",
    default: 7,
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
    description: "Days overdue at which the gentle WhatsApp nudge begins.",
    default: 7,
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
    default: 45,
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
      "Lower bounds in days overdue. MUST align with the escalation thresholds, or the bills screen and the follow-up screen will disagree about how overdue an account is. The defaults trace the follow-up policy: the quiet window, then calling, then urgent.",
    default: [0, 15, 45, 90],
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
      "The hour at which 'today' flips. Set to 5 so a report finalised at 11 pm still belongs to that working day.",
    default: 5,
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
    if (!buckets.includes(stage2Days) && !buckets.includes(stage3Days)) {
      problems.push(
        `Aging buckets (${buckets.join(", ")}) share no boundary with the escalation thresholds (${stage2Days}, ${stage3Days}). The bills screen and the follow-up screen will disagree about how overdue an account is.`,
      );
    }
  }

  const days = config["workingDay.workingDays"];
  if (!Array.isArray(days) || days.length === 0) {
    problems.push("At least one working day must be configured.");
  }

  // A price list keyed on the customer's pricelist tag is the intended answer
  // one day, but nothing stores one yet. Offering it and letting somebody pick
  // it would produce orders valued from a table that does not exist.
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
  "escalation.slowPayerLateCount": number;

  "bills.agingBuckets": number[];
  "bills.defaultCreditDays": number;
  "bills.creditDayOptions": number[];

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
  "attachments.orphanCleanupHours": number;
  "attachments.retentionDays": number;

  "products.frequentCount": number;
  "products.frequentRanking": "orders" | "recency";
  "products.starterListCount": number;
  "products.priceSource": "unset" | "manual" | "product" | "pricelist";
  "products.searchOnOrderForms": boolean;
  "interactions.singleSelectOutcomes": string[];

  "whatsapp.mode": "manual" | "automatic";
  "whatsapp.contactsPerWeekLimit": number;
  "whatsapp.unconfirmedExpiryHours": number;
  "whatsapp.autoConfirmAfterHours": number;
};

export type QueueReasonKind =
  | "reminderOverdue"
  | "reminderDueToday"
  | "orderOverdueFullCycle"
  | "orderDue"
  | "orderDueSoon"
  | "prospect"
  | "checkInOverdue"
  | "checkInDue";
