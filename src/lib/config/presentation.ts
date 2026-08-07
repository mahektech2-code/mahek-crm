/* ---------------------------------------------------------------------------
 * How the CRM's settings are PRESENTED.
 *
 * The registry says what a setting is and what values it accepts. It stops
 * short of saying how to draw it, because four different settings are stored
 * as `structured` — an object of weights, a list of ascending boundaries, a
 * set of weekdays, a list of offered terms — and a console cannot guess which
 * control each one wants.
 *
 * So the CRM declares that too, here. The Admin Console reads this and renders
 * it; it holds no copy of either file. Adding a setting to the registry without
 * an entry below still works — it falls back to its storage type — but it lands
 * in a catch-all group, which is the nudge to come and place it properly.
 *
 * Pure data. No storage, no clock, no network.
 * ------------------------------------------------------------------------- */

/** The control the console should render. Mirrors its declared control set. */
export type Control =
  | "int"
  | "decimal"
  | "bool"
  | "text"
  | "longtext"
  | "time"
  | "choice"
  | "multi"
  | "ordered"
  | "keyvalue"
  | "threshold"
  | "dayset"
  | "currency"
  | "richtext"
  | "entity";

export type Presentation = {
  /** Sub-tab in the console's section for this app. */
  tab: string;
  /** Card within that sub-tab. */
  group: string;
  control?: Control;
  /** Suffix rendered after a number — "days", "customers". */
  unit?: string;
  /**
   * Member labels for threshold and keyvalue controls. For a setting stored as
   * an ARRAY, order here is the array order; for one stored as an OBJECT, `k`
   * is the property name.
   */
  parts?: Array<{ k: string; l: string }>;
  /** Options for a multi control whose registry definition has none. */
  options?: readonly string[];
  /** Marks a setting whose change alters tomorrow's worklists. */
  impact?: "queue" | "collections" | "inactive";
  /** Platform admin only — a CRM manager sees it but cannot change it. */
  adminOnly?: boolean;
};

/**
 * The sub-tabs, in the order they appear, each with the slug it answers to.
 *
 * The slug is declared rather than derived from the label, so rewording a tab
 * is a copy change and not a moved page. Anything not listed sorts to the end
 * and gets a generated slug.
 */
export const TABS = [
  { slug: "call-queue", label: "Call queue" },
  { slug: "collections", label: "Collections" },
  { slug: "targets", label: "Targets & cycles" },
  { slug: "interactions", label: "Interactions" },
  { slug: "products", label: "Products" },
  { slug: "whatsapp", label: "WhatsApp" },
  { slug: "scripts", label: "Scripts & help" },
  { slug: "reminders", label: "Reminders" },
  { slug: "complaints", label: "Complaints" },
  { slug: "workday", label: "Workday" },
  { slug: "attachments", label: "Attachments" },
] as const;

export const TAB_ORDER = TABS.map((t) => t.label);

/** Group order within each tab. */
export const GROUP_ORDER: Record<string, string[]> = {
  "Call queue": ["When a customer is due a call", "Chasing the order", "Suppression", "Size and ordering"],
  Collections: ["Escalation stages", "Behaviour", "Aging and credit"],
  "Targets & cycles": ["Buying cycle", "Inactivity", "Targets"],
  Interactions: ["Quick notes", "Field rules and side effects"],
  Products: ["Catalogue", "How the order form offers them"],
  WhatsApp: ["Connection", "Limits", "Templates"],
  "Scripts & help": ["Call scripts", "Help articles"],
  Reminders: ["Types and behaviour"],
  Complaints: ["Classification", "Resolution"],
  Workday: ["Hours", "Holidays"],
  Attachments: ["Files", "Lifecycle", "Limits"],
};

/**
 * A sentence under a group heading, where the grouping itself carries a rule
 * somebody needs to know before editing anything inside it.
 */
export const GROUP_NOTES: Record<string, string> = {
  "Call queue · When a customer is due a call":
    "The Call Log chases orders, not contact. Underneath all of it sits a quiet window — no order is chased inside it, because a customer reordering faster than that is serving themselves.",
  "Call queue · Chasing the order":
    "A customer with a measured cycle is called on cycle − lead, where the lead is a percentage of their own cycle, clamped between the two bounds.",
  "Call queue · Suppression":
    "Suppression is a return value, not a filter — held-back customers are shown to the telecaller with the reason.",
  "Collections · Escalation stages":
    "Thresholds must ascend, and stage 2 must be the day after the quiet window closes. They are two statements of the same fact: the day a payment call may first be made.",
  "Collections · Aging and credit":
    "The aging buckets must share a boundary with the escalation thresholds, or the Sales Bill Report and Payment Follow-up will disagree about how overdue an account is.",
  "Targets & cycles · Buying cycle":
    "A computed cycle is clamped between the minimum and the maximum. Below the minimum number of intervals, the default is used instead.",
  "Workday · Hours":
    "The working day is Asia/Kolkata and does not start at midnight — a call logged at 2am belongs to the shift that started yesterday.",
  "Attachments · Files":
    "A file is validated on its bytes, never on its name. Removing a type takes effect immediately.",
  "Attachments · Lifecycle":
    "An upload starts before its parent record exists, so a form abandoned mid-call keeps its files for the cleanup window first. Removing an attachment is a status, not a delete.",
};

export const PRESENTATION: Record<string, Presentation> = {
  /* ------------------------------------------------------------ call queue */
  "queue.checkInIntervalDays": {
    tab: "Call queue", group: "When a customer is due a call", unit: "days", impact: "queue",
  },
  "queue.prospectIntervalDays": { tab: "Call queue", group: "When a customer is due a call", unit: "days" },
  "queue.quietDaysAfterOrder": { tab: "Call queue", group: "When a customer is due a call", unit: "days" },
  "queue.noOrderCooldownDays": { tab: "Call queue", group: "When a customer is due a call", unit: "days" },
  "queue.whatsappCooldownDays": { tab: "Call queue", group: "When a customer is due a call", unit: "days" },

  "queue.leadPercent": { tab: "Call queue", group: "Chasing the order", unit: "% of their cycle" },
  "queue.leadMinDays": { tab: "Call queue", group: "Chasing the order", unit: "days" },
  "queue.leadMaxDays": { tab: "Call queue", group: "Chasing the order", unit: "days" },

  "queue.excludeActiveInOrderSystem": { tab: "Call queue", group: "Suppression" },
  "queue.excludeCalledToday": { tab: "Call queue", group: "Suppression" },

  "queue.maxSizePerUser": { tab: "Call queue", group: "Size and ordering", unit: "customers", impact: "queue" },
  "queue.snapshotHour": { tab: "Call queue", group: "Size and ordering", unit: "hour" },
  "queue.tierWeights": {
    tab: "Call queue", group: "Size and ordering", control: "keyvalue", unit: "weight",
    parts: [
      { k: "reminderOverdue", l: "Overdue reminder" },
      { k: "reminderDueToday", l: "Reminder due today" },
      { k: "orderOverdueFullCycle", l: "Order overdue by a cycle" },
      { k: "orderDue", l: "Order overdue" },
      { k: "orderDueSoon", l: "Order due soon" },
      { k: "prospect", l: "Prospect" },
      { k: "checkInOverdue", l: "Check-in overdue" },
      { k: "checkInDue", l: "Check-in due" },
    ],
  },

  /* ----------------------------------------------------------- collections */
  "escalation.stage1Days": { tab: "Collections", group: "Escalation stages", unit: "days overdue", impact: "collections" },
  "escalation.stage2Days": { tab: "Collections", group: "Escalation stages", unit: "days overdue", impact: "collections" },
  "escalation.stage3Days": { tab: "Collections", group: "Escalation stages", unit: "days overdue", impact: "collections" },
  "escalation.quietCallDays": { tab: "Collections", group: "Escalation stages", unit: "days", impact: "collections" },
  "escalation.messageIntervalDays": { tab: "Collections", group: "Escalation stages", unit: "days" },
  "escalation.callIntervalDays": { tab: "Collections", group: "Escalation stages", unit: "days" },
  "escalation.stageDriver": { tab: "Collections", group: "Escalation stages", control: "choice" },

  "escalation.partialPaymentResetsClock": { tab: "Collections", group: "Behaviour", adminOnly: true },
  "escalation.disputeHoldsEscalation": { tab: "Collections", group: "Behaviour" },
  "escalation.slowPayerLookbackMonths": { tab: "Collections", group: "Behaviour", unit: "months" },
  "escalation.slowPayerLateCount": { tab: "Collections", group: "Behaviour", unit: "late payments" },

  "bills.agingBuckets": {
    tab: "Collections", group: "Aging and credit", control: "threshold", unit: "days",
    parts: [
      { k: "0", l: "Bucket 1 from" },
      { k: "1", l: "Bucket 2 from" },
      { k: "2", l: "Bucket 3 from" },
      { k: "3", l: "Bucket 4 from" },
    ],
  },
  "bills.defaultCreditDays": { tab: "Collections", group: "Aging and credit", unit: "days" },
  "customers.defaultCreditDays": { tab: "Collections", group: "Aging and credit", unit: "days" },
  "bills.creditDayOptions": { tab: "Collections", group: "Aging and credit", control: "ordered" },

  /* -------------------------------------------------------- targets/cycles */
  "buyingCycle.method": { tab: "Targets & cycles", group: "Buying cycle", control: "choice" },
  "buyingCycle.lookbackOrders": { tab: "Targets & cycles", group: "Buying cycle", unit: "orders" },
  "buyingCycle.minIntervals": { tab: "Targets & cycles", group: "Buying cycle", unit: "intervals" },
  "buyingCycle.defaultDays": { tab: "Targets & cycles", group: "Buying cycle", unit: "days" },
  "buyingCycle.minDays": { tab: "Targets & cycles", group: "Buying cycle", unit: "days" },
  "buyingCycle.maxDays": { tab: "Targets & cycles", group: "Buying cycle", unit: "days" },

  "inactive.cycleMultiplier": { tab: "Targets & cycles", group: "Inactivity", control: "decimal", impact: "inactive" },
  "inactive.decisionAgeWarningDays": { tab: "Targets & cycles", group: "Inactivity", unit: "days" },

  "targets.defaultMethod": { tab: "Targets & cycles", group: "Targets", control: "choice" },
  "targets.trailingMonths": { tab: "Targets & cycles", group: "Targets", unit: "months" },
  "targets.defaultUpliftPercent": { tab: "Targets & cycles", group: "Targets", control: "decimal", unit: "%" },
  "targets.proRateNewCustomers": { tab: "Targets & cycles", group: "Targets" },

  /* --------------------------------------------------------- interactions */
  "interactions.singleSelectOutcomes": { tab: "Interactions", group: "Quick notes", control: "ordered" },
  "interactions.maxNotesLength": { tab: "Interactions", group: "Quick notes", unit: "characters" },

  /* -------------------------------------------------------------- products */
  "products.frequentCount": { tab: "Products", group: "How the order form offers them", unit: "products" },
  "products.frequentRanking": { tab: "Products", group: "How the order form offers them", control: "choice" },
  "products.searchOnOrderForms": { tab: "Products", group: "How the order form offers them" },

  /* -------------------------------------------------------------- whatsapp */
  "whatsapp.mode": { tab: "WhatsApp", group: "Connection", control: "choice", adminOnly: true },
  "whatsapp.contactsPerWeekLimit": { tab: "WhatsApp", group: "Limits", unit: "per week" },
  "whatsapp.unconfirmedExpiryHours": { tab: "WhatsApp", group: "Limits", unit: "hours" },
  "whatsapp.autoConfirmAfterHours": { tab: "WhatsApp", group: "Limits", unit: "hours" },

  /* ------------------------------------------------------------- reminders */
  "reminders.rollForwardOnNonWorkingDays": { tab: "Reminders", group: "Types and behaviour" },
  "reminders.rescheduleWarningCount": { tab: "Reminders", group: "Types and behaviour", unit: "times" },
  "dashboard.reminderOverdueFlagDays": { tab: "Reminders", group: "Types and behaviour", unit: "days" },

  /* ------------------------------------------------------------ complaints */
  "complaints.categories": { tab: "Complaints", group: "Classification", control: "ordered" },
  "complaints.defaultSeverity": { tab: "Complaints", group: "Classification", control: "choice" },
  "complaints.slaHours": {
    tab: "Complaints", group: "Resolution", control: "keyvalue", unit: "hours",
    parts: [
      { k: "low", l: "Low" },
      { k: "medium", l: "Medium" },
      { k: "high", l: "High" },
    ],
  },
  "dashboard.complaintUnresolvedFlagDays": { tab: "Complaints", group: "Resolution", unit: "days" },

  /* --------------------------------------------------------------- workday */
  "workingDay.shiftStart": { tab: "Workday", group: "Hours", control: "time" },
  "workingDay.shiftEnd": { tab: "Workday", group: "Hours", control: "time" },
  "workingDay.dayBoundaryHour": { tab: "Workday", group: "Hours", unit: "hour" },
  "workingDay.workingDays": { tab: "Workday", group: "Hours", control: "dayset" },
  "workingDay.timezone": { tab: "Workday", group: "Hours", control: "choice", adminOnly: true },

  /* ----------------------------------------------------------- attachments */
  "attachments.acceptedTypes": {
    tab: "Attachments", group: "Files", control: "multi",
    options: ["image/jpeg", "image/png", "image/heic", "image/webp", "application/pdf"],
  },
  "attachments.maxSizeMb": { tab: "Attachments", group: "Files", unit: "MB" },
  "attachments.orphanCleanupHours": { tab: "Attachments", group: "Lifecycle", unit: "hours" },
  "attachments.retentionDays": { tab: "Attachments", group: "Lifecycle", unit: "days" },
  "attachments.maxPerComplaint": { tab: "Attachments", group: "Limits", unit: "files" },
  "attachments.maxPerFollowUp": { tab: "Attachments", group: "Limits", unit: "files" },
};

/* ------------------------------------------------------ entity collections */

/**
 * Collections the CRM owns that are edited as lists rather than as a single
 * value — its products, its message templates, its quick notes.
 *
 * Declared here for the same reason the settings are: the console renders what
 * an app declares and knows nothing about what a "product" is. `table` names
 * the storage that backs it; a collection with none is declared but not yet
 * built, and the console says exactly that instead of showing an empty list
 * that looks broken.
 */
export type EntityCollection = {
  key: string;
  tab: string;
  group: string;
  label: string;
  help: string;
  /** The plural noun the count reads with — "products", "templates". */
  noun: string;
  /** What the create button says. */
  cta: string;
  /** False when nothing stores this yet. */
  built: boolean;
  /**
   * False when the rows exist but there is no write path from here. The list
   * still shows — knowing what is in the catalogue is useful on its own — but
   * nothing offers an editor that would not save.
   */
  editable: boolean;
};

export const ENTITY_COLLECTIONS: EntityCollection[] = [
  {
    key: "products", tab: "Products", group: "Catalogue", label: "Products", noun: "products", cta: "Add product",
    built: true, editable: false,
    help: "Name, pack, external code, rate and display order in the quantity list. The rate is load-bearing — without it, order value, target achievement and run rate all read zero.",
  },
  {
    key: "notes", tab: "Interactions", group: "Quick notes", label: "Quick notes", noun: "notes", cta: "Add note",
    built: true, editable: false,
    help: "Per outcome, tappable in the Call Log. Retired notes are deactivated, never deleted — historical interactions must keep resolving to something a human can read.",
  },
  {
    key: "templates", tab: "WhatsApp", group: "Templates", label: "Templates", noun: "templates", cta: "New template",
    built: true, editable: true,
    help: "Merge placeholders are validated at authoring time, not at send time.",
  },
  {
    key: "help", tab: "Scripts & help", group: "Help articles", label: "Help articles", noun: "articles", cta: "New article",
    built: true, editable: false,
    help: "Read in the CRM Help Center, authored here.",
  },
  {
    key: "scripts", tab: "Scripts & help", group: "Call scripts", label: "Call scripts", noun: "scripts", cta: "New script",
    built: false, editable: false,
    help: "Opening, purpose, repeatable objection blocks and closing, matched to the customer's situation.",
  },
  {
    key: "rules", tab: "Interactions", group: "Field rules and side effects", label: "Per-outcome rules", noun: "outcomes", cta: "Edit rules",
    built: false, editable: false,
    help: "Which fields appear for each outcome, and what saving it creates. Today these are declared in code, in the interaction and payment follow-up services.",
  },
  {
    key: "holidays", tab: "Workday", group: "Holidays", label: "Holiday calendar", noun: "holidays", cta: "Add holiday",
    built: false, editable: false,
    help: "Excluded from working-day counts and run-rate maths.",
  },
];

/** Weekday order for the dayset control, matching ISO 1–7. */
export const ISO_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
