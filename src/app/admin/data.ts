/* ---------------------------------------------------------------------------
 * The Admin Console renders configuration from what each app DECLARES.
 *
 * There is no app-specific code past this file — only a registry, the schemas
 * the apps publish, and one renderer per declared control type. Adding an app
 * to the registry gives the console a working settings section without a code
 * change, because the console reads that app's schema endpoint.
 *
 * Everything here is the demo contract the UI is built against. The screens are
 * the deliverable; wiring these shapes to `app_settings` and the real tables is
 * the next step and does not change a single component below.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------- the registry */

export type AppStatus = "Live" | "Coming soon" | "Maintenance" | "Retired";

export type RegistryEntry = {
  id: string;
  name: string;
  short: string;
  status: AppStatus;
  route: string;
  schemaEndpoint: string;
  writeEndpoint: string;
  summaryEndpoint: string;
  roles: string[];
  managerRole: string;
  /** Whether this app's roles carry a reporting line. */
  reportsTo?: boolean;
  order: number;
  desc: string;
};

export const REGISTRY: RegistryEntry[] = [
  {
    id: "crm",
    name: "Telecaller CRM",
    short: "CRM",
    status: "Live",
    route: "/crm/dashboard",
    schemaEndpoint: "/api/crm/config/schema",
    writeEndpoint: "/api/crm/config",
    summaryEndpoint: "/api/crm/summary",
    roles: ["Telecaller", "Manager"],
    managerRole: "Manager",
    reportsTo: true,
    order: 1,
    desc: "Call queue, payment follow-up, reminders and the EOD report.",
  },
  {
    id: "orders",
    name: "Order Management",
    short: "Orders",
    status: "Coming soon",
    route: "—",
    schemaEndpoint: "—",
    writeEndpoint: "—",
    summaryEndpoint: "—",
    roles: ["Dispatcher", "Manager"],
    managerRole: "Manager",
    order: 2,
    desc: "Loading sheets, vehicle assignment and delivery confirmation.",
  },
  {
    id: "field",
    name: "Salesman App",
    short: "Field",
    status: "Coming soon",
    route: "—",
    schemaEndpoint: "—",
    writeEndpoint: "—",
    summaryEndpoint: "—",
    roles: ["Salesman", "Manager"],
    managerRole: "Manager",
    order: 3,
    desc: "Visit requests, route for the day and outcomes from the field.",
  },
];

/* ------------------------------------------------- the declared control set */

export const T = {
  int: "int",
  dec: "decimal",
  cur: "currency",
  bool: "bool",
  text: "text",
  long: "longtext",
  choice: "choice",
  multi: "multi",
  ordered: "ordered",
  keyvalue: "keyvalue",
  threshold: "threshold",
  time: "time",
  dayset: "dayset",
  entity: "entity",
} as const;

export type ControlType = (typeof T)[keyof typeof T];
export type EntityKind =
  | "products"
  | "templates"
  | "scripts"
  | "help"
  | "holidays"
  | "rules"
  | "notes";

export type SchemaField = {
  key: string;
  label: string;
  type: ControlType;
  help?: string;
  unit?: string;
  def?: unknown;
  min?: number;
  max?: number;
  options?: string[];
  parts?: Array<{ k: string; l: string; v: number }>;
  pairs?: Array<{ k: string; l: string; v: number }>;
  ascending?: boolean;
  entity?: EntityKind;
  /** Platform admin only — a CRM manager sees it but cannot change it. */
  adminOnly?: boolean;
  /** Marks a setting whose change alters tomorrow's worklists. */
  impact?: "queue" | "collections" | "inactive";
};

export type SchemaGroup = { label: string; note?: string; fields: SchemaField[] };
export type SchemaTab = { key: string; label: string; groups: SchemaGroup[] };
export type AppSchema = { tabs: SchemaTab[] };

/**
 * The CRM's published schema. The console has never heard of "escalation
 * stages" — it only knows the control types above.
 */
export const CRM_SCHEMA: AppSchema = {
  tabs: [
    {
      key: "queue",
      label: "Call queue",
      groups: [
        {
          label: "When a customer enters the queue",
          fields: [
            {
              key: "checkinInterval",
              label: "Routine check-in interval",
              type: T.int,
              unit: "days",
              def: 14,
              min: 1,
              max: 120,
              help: "How long after the last contact a customer is due a routine call.",
              impact: "queue",
            },
            {
              key: "checkinMultiplier",
              label: "Check-in overdue multiplier",
              type: T.dec,
              def: 1.5,
              min: 1,
              max: 5,
              help: "How far past the interval before a check-in counts as overdue.",
            },
            {
              key: "waCooldown",
              label: "WhatsApp cooldown window",
              type: T.int,
              unit: "days",
              def: 3,
              min: 0,
              max: 30,
              help: "Held back from the queue for this long after a confirmed WhatsApp send.",
            },
            {
              key: "orderLead",
              label: "Order due lead time",
              type: T.int,
              unit: "days",
              def: 2,
              min: 0,
              max: 30,
              help: "How early before the projected order date a customer surfaces.",
            },
          ],
        },
        {
          label: "Suppression",
          fields: [
            {
              key: "excludeErp",
              label: "Exclude customers active in the external order system",
              type: T.bool,
              def: true,
              help: "Anyone with a live order is held back so they are not chased mid-dispatch.",
            },
            {
              key: "excludeCalledToday",
              label: "Exclude customers already called today",
              type: T.bool,
              def: true,
              help: "Prevents a second call the same day.",
            },
            {
              key: "orderReceivedSuppresses",
              label: "Order Received suppresses from today's queue",
              type: T.bool,
              def: true,
              help: "An order logged without a call also counts as contact.",
            },
            {
              key: "showSuppression",
              label: "Show suppression strip to telecallers",
              type: T.bool,
              def: true,
              help: "Suppression is a return value, not a filter — a telecaller must be able to find out why somebody is missing.",
            },
          ],
        },
        {
          label: "Size and ordering",
          fields: [
            {
              key: "maxQueue",
              label: "Maximum queue size per telecaller",
              type: T.int,
              unit: "customers",
              def: 60,
              min: 0,
              max: 300,
              help: "0 means unlimited.",
              impact: "queue",
            },
            {
              key: "tierWeights",
              label: "Priority tier weights",
              type: T.threshold,
              ascending: false,
              parts: [
                { k: "overdueRem", l: "Overdue reminder", v: 100 },
                { k: "remToday", l: "Reminder due today", v: 90 },
                { k: "orderOverCycle", l: "Order overdue by a cycle", v: 80 },
                { k: "orderOverdue", l: "Order overdue", v: 70 },
                { k: "orderSoon", l: "Order due soon", v: 60 },
                { k: "checkinOver", l: "Check-in overdue", v: 50 },
                { k: "checkinDue", l: "Check-in due", v: 40 },
              ],
              help: "Higher weight sorts higher in the Call Log.",
            },
            {
              key: "tieBreak",
              label: "Tie-breaker order",
              type: T.ordered,
              def: ["Outstanding", "Target gap", "Days since contact"],
              help: "Applied when two customers share a tier weight.",
            },
          ],
        },
      ],
    },
    {
      key: "collections",
      label: "Collections",
      groups: [
        {
          label: "Escalation stages",
          note: "Thresholds must ascend, and the aging buckets below must align with them.",
          fields: [
            {
              key: "stageThresholds",
              label: "Stage thresholds",
              type: T.threshold,
              ascending: true,
              unit: "days overdue",
              parts: [
                { k: "s1", l: "Stage 1", v: 7 },
                { k: "s2", l: "Stage 2", v: 21 },
                { k: "s3", l: "Stage 3", v: 45 },
              ],
              help: "Days overdue at which each stage begins.",
              impact: "collections",
            },
            { key: "stage1Name", label: "Stage 1 name", type: T.text, def: "Gentle nudge", help: "Shown on the follow-up row and in the panel." },
            { key: "stage2Name", label: "Stage 2 name", type: T.text, def: "Alternating" },
            { key: "stage3Name", label: "Stage 3 name", type: T.text, def: "Urgent" },
            {
              key: "stage1Channels",
              label: "Stage 1 permitted channels",
              type: T.multi,
              options: ["WhatsApp", "Call"],
              def: ["WhatsApp"],
              help: "A late bill is messaged before it is called — the prescribed action is drawn from these.",
            },
            { key: "stage2Channels", label: "Stage 2 permitted channels", type: T.multi, options: ["WhatsApp", "Call"], def: ["WhatsApp", "Call"] },
            { key: "stage3Channels", label: "Stage 3 permitted channels", type: T.multi, options: ["WhatsApp", "Call"], def: ["Call"] },
            {
              key: "stageDriver",
              label: "Stage driver",
              type: T.choice,
              options: ["Oldest overdue bill", "Largest overdue bill"],
              def: "Oldest overdue bill",
              help: "Which bill decides the stage when several are overdue.",
            },
          ],
        },
        {
          label: "Behaviour",
          fields: [
            {
              key: "partialResets",
              label: "Partial payment resets the aging clock",
              type: T.bool,
              def: false,
              adminOnly: true,
              help: "Off means a part payment does not make the account look less overdue.",
            },
            { key: "disputeHolds", label: "Dispute holds escalation", type: T.bool, def: true, help: "A raised dispute stops the stage advancing." },
            { key: "slowLookback", label: "Slow payer lookback", type: T.int, unit: "months", def: 6, min: 1, max: 36 },
            {
              key: "slowThreshold",
              label: "Slow payer late-payment threshold",
              type: T.int,
              unit: "late payments",
              def: 3,
              min: 1,
              max: 20,
              help: "Late payments within the lookback before the flag appears.",
            },
            { key: "monthEnd", label: "Month-end mode starts", type: T.int, unit: "days before month end", def: 7, min: 0, max: 20 },
          ],
        },
        {
          label: "Aging and credit",
          fields: [
            {
              key: "agingBuckets",
              label: "Aging bucket boundaries",
              type: T.threshold,
              ascending: true,
              unit: "days",
              // Ships aligned with the stage thresholds above. These two are two
              // statements of the same fact, and the section refuses to save
              // while they disagree.
              parts: [
                { k: "b1", l: "Bucket 1 from", v: 0 },
                { k: "b2", l: "Bucket 2 from", v: 7 },
                { k: "b3", l: "Bucket 3 from", v: 21 },
                { k: "b4", l: "Bucket 4 from", v: 45 },
              ],
              help: "Used by the Sales Bill Report. Must align with the stage thresholds above.",
            },
            { key: "creditPeriod", label: "Default credit period", type: T.int, unit: "days", def: 30, min: 0, max: 180 },
            { key: "creditNew", label: "Default credit days for new customers", type: T.int, unit: "days", def: 30, min: 0, max: 180 },
          ],
        },
      ],
    },
    {
      key: "targets",
      label: "Targets & cycles",
      groups: [
        {
          label: "Buying cycle",
          note: "Minimum must be below the default, and the default below the maximum.",
          fields: [
            { key: "cycleMethod", label: "Buying cycle method", type: T.choice, options: ["Median", "Mean"], def: "Median", help: "How the interval between orders is averaged." },
            { key: "cycleLookback", label: "Cycle lookback orders", type: T.int, unit: "orders", def: 6, min: 2, max: 24 },
            { key: "cycleMinIntervals", label: "Minimum intervals required", type: T.int, unit: "intervals", def: 3, min: 1, max: 12, help: "Below this the default cycle is used instead." },
            {
              key: "cycleBounds",
              label: "Cycle bounds",
              type: T.threshold,
              ascending: true,
              unit: "days",
              parts: [
                { k: "min", l: "Minimum", v: 7 },
                { k: "def", l: "Default", v: 30 },
                { k: "max", l: "Maximum", v: 180 },
              ],
              help: "A computed cycle is clamped into this range.",
            },
          ],
        },
        {
          label: "Inactivity",
          fields: [
            {
              key: "inactiveMultiplier",
              label: "Inactivity cycle multiplier",
              type: T.dec,
              def: 2.0,
              min: 1,
              max: 6,
              help: "A customer flags once this many of their own cycles have passed.",
              impact: "inactive",
            },
            { key: "decisionWarn", label: "Inactive decision age warning", type: T.int, unit: "days", def: 14, min: 1, max: 120 },
            { key: "dismissSuppress", label: "Inactive dismissal suppression period", type: T.int, unit: "days", def: 90, min: 1, max: 365 },
          ],
        },
        {
          label: "Targets",
          fields: [
            { key: "targetMethod", label: "Default target method", type: T.choice, options: ["Trailing average", "Same month last year", "Fixed"], def: "Trailing average" },
            { key: "trailingMonths", label: "Trailing months", type: T.int, unit: "months", def: 3, min: 1, max: 12 },
            { key: "targetUplift", label: "Default target uplift", type: T.dec, unit: "%", def: 0, min: -50, max: 100 },
            { key: "prorate", label: "Pro-rate targets for new customers", type: T.bool, def: true },
            { key: "runRateBasis", label: "Run rate calculation basis", type: T.choice, options: ["Working days", "Calendar days"], def: "Working days" },
            { key: "daysAgoBasis", label: "Days-ago display basis", type: T.choice, options: ["Calendar days", "Working days"], def: "Calendar days" },
          ],
        },
      ],
    },
    {
      key: "interactions",
      label: "Interactions",
      groups: [
        {
          label: "Interaction types",
          note: "The first question the Call Log asks. Everything below depends on it.",
          fields: [
            {
              key: "ixTypes",
              label: "Interaction types",
              type: T.ordered,
              def: ["We Called Them", "They Called Us", "Order Received"],
              help: "Label and order as shown to the telecaller.",
            },
          ],
        },
        {
          label: "Outcomes",
          fields: [
            {
              key: "outOutcomes",
              label: "Outbound outcomes",
              type: T.ordered,
              def: ["Order Taken", "No Order", "No Answer", "Payment Promised", "Follow-up", "Not Interested"],
              help: "Shown after choosing We Called Them.",
            },
            {
              key: "inOutcomes",
              label: "Inbound outcomes",
              type: T.ordered,
              def: ["Order Taken", "Payment Promised", "Follow-up", "Complaint", "Transport Follow-up", "Casual Talk"],
              help: "Shown after choosing They Called Us.",
            },
          ],
        },
        {
          label: "Field rules and side effects",
          note: "Per outcome: which fields appear, and what saving creates.",
          fields: [
            {
              key: "outcomeRules",
              label: "Per-outcome rules",
              type: T.entity,
              entity: "rules",
              help: "Resolves questions like whether outbound Payment Promised requires a date, without a code change.",
            },
          ],
        },
        {
          label: "Quick notes",
          fields: [
            {
              key: "quickNotes",
              label: "Quick notes",
              type: T.entity,
              entity: "notes",
              help: "Per outcome, tappable in the Call Log. Retired notes are deactivated, never deleted — old interactions must keep resolving.",
            },
            { key: "notesAppend", label: "Multiple quick notes append rather than replace", type: T.bool, def: true },
            { key: "notesByUsage", label: "Order quick notes by usage", type: T.bool, def: false },
            { key: "notesMax", label: "Notes maximum length", type: T.int, unit: "characters", def: 1000, min: 100, max: 5000 },
          ],
        },
      ],
    },
    {
      key: "products",
      label: "Products",
      groups: [
        {
          label: "Catalogue",
          note: "The rate field is load-bearing — without it, order value, target achievement and run rate all read zero.",
          fields: [
            { key: "products", label: "Products", type: T.entity, entity: "products", help: "Name, pack, external code, rate and display order in the quantity list." },
            {
              key: "rateModel",
              label: "Rate model",
              type: T.choice,
              options: ["Single rate per product", "Rate card per customer"],
              def: "Single rate per product",
              adminOnly: true,
              help: "Flag this with the business — customer-specific rates need the rate-card model.",
            },
          ],
        },
      ],
    },
    {
      key: "whatsapp",
      label: "WhatsApp",
      groups: [
        {
          label: "Connection",
          fields: [
            {
              key: "waMode",
              label: "Mode",
              type: T.choice,
              options: ["Manual", "Automatic"],
              def: "Manual",
              adminOnly: true,
              help: "Manual prepares a message to copy; Automatic sends from the business number. A message is only sent when a human confirms it.",
            },
            { key: "waNumber", label: "Business number", type: T.text, def: "", adminOnly: true, help: "Used only in Automatic mode." },
          ],
        },
        {
          label: "Limits",
          fields: [
            { key: "waFrequency", label: "Contact frequency limit", type: T.int, unit: "per week", def: 3, min: 1, max: 20 },
            { key: "waExpiry", label: "Unconfirmed copy expiry", type: T.int, unit: "hours", def: 12, min: 1, max: 72, help: "How long a copied-but-unconfirmed message stays on the list." },
            { key: "waAutoConfirm", label: "Auto-confirm after", type: T.int, unit: "hours", def: 0, min: 0, max: 72, help: "0 never auto-confirms." },
            { key: "waFreeText", label: "Allow free-text messages", type: T.bool, def: false, help: "Off means only templates can be sent." },
            { key: "waBulkRoles", label: "Bulk send permitted for", type: T.multi, options: ["Telecaller", "Manager"], def: ["Manager"] },
          ],
        },
        {
          label: "Templates",
          fields: [{ key: "waTemplates", label: "Templates", type: T.entity, entity: "templates", help: "Merge placeholders are validated at authoring time, not at send time." }],
        },
      ],
    },
    {
      key: "scripts",
      label: "Scripts & help",
      groups: [
        {
          label: "Call scripts",
          fields: [
            { key: "scripts", label: "Call scripts", type: T.entity, entity: "scripts", help: "Opening, purpose, repeatable objection blocks and closing." },
            {
              key: "scriptMatching",
              label: "Contextual matching order",
              type: T.ordered,
              def: ["Open complaint", "Collections stage", "Order overdue", "Inactive", "Routine check-in"],
              help: "The first match decides which script the CRM suggests.",
            },
          ],
        },
        {
          label: "Help articles",
          fields: [{ key: "helpArticles", label: "Help articles", type: T.entity, entity: "help", help: "Read in the CRM, authored here." }],
        },
      ],
    },
    {
      key: "reminders",
      label: "Reminders",
      groups: [
        {
          label: "Types and behaviour",
          fields: [
            {
              key: "reminderTypes",
              label: "Reminder types",
              type: T.ordered,
              def: ["Call back", "Payment promise", "Order confirmation", "Send information", "Check stock", "Other"],
            },
            { key: "rollForward", label: "Roll forward when due on a non-working day", type: T.bool, def: true },
            { key: "reschedWarn", label: "Reschedule count warning threshold", type: T.int, unit: "times", def: 3, min: 1, max: 20 },
            { key: "dismissReason", label: "Dismissal requires a reason", type: T.bool, def: true },
            {
              key: "blockEod",
              label: "Block end-of-day close on open reminders",
              type: T.bool,
              def: true,
              help: "The EOD report cannot be submitted until today's reminders are closed or carried.",
            },
            { key: "notifyDue", label: "Notify on reminder due", type: T.bool, def: true },
          ],
        },
      ],
    },
    {
      key: "complaints",
      label: "Complaints",
      groups: [
        {
          label: "Classification",
          fields: [
            {
              key: "cmpCategories",
              label: "Categories",
              type: T.ordered,
              def: ["Product Quality", "Packaging Damage", "Dispatch Delay", "Billing Issue", "Delivery", "Pricing", "Service", "Shortage", "Other"],
            },
            { key: "cmpSeverities", label: "Severity levels", type: T.ordered, def: ["Low", "Medium", "High"] },
            { key: "cmpDefaultSeverity", label: "Default severity", type: T.choice, options: ["Low", "Medium", "High"], def: "Medium" },
          ],
        },
        {
          label: "Resolution",
          fields: [
            {
              key: "cmpSla",
              label: "Resolution SLA per severity",
              type: T.keyvalue,
              unit: "hours",
              pairs: [
                { k: "low", l: "Low", v: 120 },
                { k: "med", l: "Medium", v: 48 },
                { k: "high", l: "High", v: 24 },
              ],
            },
            { key: "cmpNotes", label: "Resolution notes mandatory on close", type: T.bool, def: true },
            { key: "cmpInformed", label: "Record whether the customer was informed", type: T.bool, def: true },
            { key: "cmpFollowUp", label: "Auto-create follow-up reminder on resolution", type: T.bool, def: false },
            {
              key: "cmpDuplicate",
              label: "Duplicate handling",
              type: T.choice,
              options: ["Update existing in same category", "Always create new"],
              def: "Update existing in same category",
            },
            { key: "cmpEscalate", label: "Escalate past SLA to manager", type: T.bool, def: true },
          ],
        },
      ],
    },
    {
      key: "workday",
      label: "Workday",
      groups: [
        {
          label: "Hours",
          note: "Shift start must precede shift end, and the day boundary must fall outside the shift.",
          fields: [
            { key: "shiftStart", label: "Shift start", type: T.time, def: "09:00" },
            { key: "shiftEnd", label: "Shift end", type: T.time, def: "19:00" },
            {
              key: "dayBoundary",
              label: "Day boundary hour",
              type: T.time,
              def: "05:00",
              help: "When one working day becomes the next for reporting. A call logged at 2am belongs to the shift that started yesterday.",
            },
            { key: "workingDays", label: "Working days", type: T.dayset, def: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] },
            { key: "timezone", label: "Timezone", type: T.choice, options: ["India Standard Time"], def: "India Standard Time", adminOnly: true },
          ],
        },
        {
          label: "End of day",
          fields: [
            { key: "eodAuto", label: "EOD auto-generate at day boundary", type: T.bool, def: true },
            {
              key: "eodLines",
              label: "EOD report line items",
              type: T.multi,
              options: ["Calls attempted", "Connected", "Missed", "Inbound", "Orders", "Follow-ups", "Reminders closed", "Carried forward", "Complaints", "Target progress"],
              def: ["Calls attempted", "Connected", "Missed", "Inbound", "Orders", "Follow-ups", "Reminders closed", "Carried forward", "Complaints", "Target progress"],
            },
            {
              key: "eodTemplate",
              label: "EOD WhatsApp format",
              type: T.long,
              def: "*MAHEK MARKETING — EOD REPORT*\n*{name}* | {date}\n\nCalls attempted: {attempted}\nConnected: {connected}\nMissed: {missed}\n\nOrders: {orders} ({orderValue})\nTarget: {achieved} / {target} ({pct})",
            },
            { key: "holidays", label: "Holiday calendar", type: T.entity, entity: "holidays", help: "Excluded from working-day counts." },
          ],
        },
        {
          label: "Platform contract",
          note: "The launcher aggregates one number across every app. If apps count unlike things, the total is meaningless.",
          fields: [
            {
              key: "attentionDef",
              label: "Attention-count definition",
              type: T.multi,
              options: ["Overdue reminders", "Reminders due today", "Pending payment follow-ups", "Complaints past SLA", "Unworked queue items"],
              def: ["Overdue reminders", "Reminders due today", "Pending payment follow-ups"],
              adminOnly: true,
              help: "Which item types feed the figure the launcher shows for this app.",
            },
            { key: "attentionFormat", label: "Attention status line format", type: T.text, def: "{count} reminders overdue across the team" },
          ],
        },
      ],
    },
  ],
};

export function schemaFor(appId: string): AppSchema | null {
  return appId === "crm" ? CRM_SCHEMA : null;
}

/* ------------------------------------------------------- platform sections */

export const PLATFORM_TABS: Record<string, string[]> = {
  overview: ["Health", "Integrations", "Recent activity", "Scheduled jobs"],
  people: ["Users", "App access", "Roles & teams", "Sessions & security", "Onboarding"],
  apps: ["Registry", "Status", "Access rules"],
  data: ["Import history", "Export log", "Backup"],
  audit: ["Configuration changes", "Access changes", "Admin actions"],
};

export const PLATFORM_SUBTITLES: Record<string, string> = {
  overview: "Platform health, external connections and what changed recently.",
  people: "Accounts, which apps they open, and what they can do inside each one.",
  apps: "The registry that drives the launcher and this console.",
  audit: "Every configuration and access change. Read-only, and never editable.",
  data: "What has been imported and exported, and whether the backup ran.",
};

/* --------------------------------------------------------------- the people */

export type UserStatus = "Active" | "Invited" | "Locked" | "Deactivated";

export type Grant = { app: string; by: string; on: string; reason: string };

export type AdminUser = {
  id: string;
  name: string;
  code: string;
  dept: string;
  contact: string;
  mobile: string;
  status: UserStatus;
  apps: string[];
  roles: Record<string, string>;
  reportsTo?: string;
  designation: string;
  lastSeen: string;
  lastActive: string;
  created: string;
  createdBy: string;
  joined: string;
  team?: number;
  invitedOn?: string;
  lockReason?: string;
  deactivatedOn?: string;
  deactReason?: string;
  grants: Grant[];
  roleLog: Array<{ app: string; role: string; by: string; on: string }>;
};

export const USERS: AdminUser[] = [
  {
    id: "u1", name: "Priya Sharma", code: "MM-014", dept: "Telecalling",
    contact: "priya@mahek.in", mobile: "+91 98200 11001",
    status: "Active", apps: ["crm"], roles: { crm: "Telecaller" },
    reportsTo: "Vikram Shah", designation: "Senior telecaller",
    lastSeen: "Today, 09:04", lastActive: "Today, 11:20",
    created: "12 Mar 2026", createdBy: "Vikram Shah", joined: "12 Mar 2026",
    grants: [{ app: "crm", by: "Vikram Shah", on: "12 Mar 2026", reason: "Joined telecalling" }],
    roleLog: [{ app: "crm", role: "Telecaller", by: "Vikram Shah", on: "12 Mar 2026" }],
  },
  {
    id: "u2", name: "Vikram Shah", code: "MM-002", dept: "Sales",
    contact: "vikram@mahek.in", mobile: "+91 98200 11006",
    status: "Active", apps: ["crm", "orders"], roles: { crm: "Manager", orders: "Manager" },
    designation: "Sales manager",
    lastSeen: "Today, 08:41", lastActive: "Today, 11:48",
    created: "02 Jan 2026", createdBy: "System", joined: "02 Jan 2026", team: 6,
    grants: [
      { app: "crm", by: "System", on: "02 Jan 2026", reason: "Founding account" },
      { app: "orders", by: "Sandeep Rao", on: "04 Aug 2026", reason: "Reviews dispatch against collections" },
    ],
    roleLog: [{ app: "crm", role: "Manager", by: "System", on: "02 Jan 2026" }],
  },
  {
    id: "u3", name: "Rakesh Yadav", code: "MM-018", dept: "Telecalling",
    contact: "rakesh@mahek.in", mobile: "+91 98200 11002",
    status: "Active", apps: ["crm"], roles: { crm: "Telecaller" },
    reportsTo: "Vikram Shah", designation: "Telecaller",
    lastSeen: "Today, 09:12", lastActive: "Today, 11:02",
    created: "12 Mar 2026", createdBy: "Vikram Shah", joined: "12 Mar 2026",
    grants: [{ app: "crm", by: "Vikram Shah", on: "12 Mar 2026", reason: "Joined telecalling" }],
    roleLog: [{ app: "crm", role: "Telecaller", by: "Vikram Shah", on: "12 Mar 2026" }],
  },
  {
    id: "u4", name: "Anjali Kulkarni", code: "MM-021", dept: "Back office",
    contact: "anjali@mahek.in", mobile: "+91 98200 11003",
    status: "Active", apps: ["crm"], roles: { crm: "Manager" },
    designation: "Back-office manager",
    lastSeen: "Yesterday, 18:20", lastActive: "Yesterday, 18:26",
    created: "20 Mar 2026", createdBy: "Vikram Shah", joined: "20 Mar 2026", team: 0,
    grants: [{ app: "crm", by: "Vikram Shah", on: "20 Mar 2026", reason: "Handles order confirmations" }],
    roleLog: [
      { app: "crm", role: "Manager", by: "Vikram Shah", on: "01 Jun 2026" },
      { app: "crm", role: "Telecaller", by: "Vikram Shah", on: "20 Mar 2026" },
    ],
  },
  {
    id: "u5", name: "Mahesh Parab", code: "MM-030", dept: "Field sales",
    contact: "mahesh@mahek.in", mobile: "+91 98200 11007",
    status: "Invited", apps: [], roles: {},
    reportsTo: "Vikram Shah", designation: "Field salesman",
    lastSeen: "—", lastActive: "—",
    created: "04 Aug 2026", createdBy: "Vikram Shah", joined: "04 Aug 2026", invitedOn: "04 Aug 2026",
    grants: [], roleLog: [],
  },
  {
    id: "u6", name: "Neha Joshi", code: "MM-024", dept: "Telecalling",
    contact: "neha@mahek.in", mobile: "+91 98200 11005",
    status: "Locked", apps: ["crm"], roles: { crm: "Telecaller" },
    reportsTo: "Anjali Kulkarni", designation: "Telecaller",
    lastSeen: "Today, 08:10", lastActive: "Today, 08:12",
    created: "02 Apr 2026", createdBy: "Vikram Shah", joined: "02 Apr 2026",
    lockReason: "5 failed sign-in attempts",
    grants: [{ app: "crm", by: "Vikram Shah", on: "02 Apr 2026", reason: "Joined telecalling" }],
    roleLog: [{ app: "crm", role: "Telecaller", by: "Vikram Shah", on: "02 Apr 2026" }],
  },
  {
    id: "u7", name: "Suresh Kumar", code: "MM-009", dept: "Telecalling",
    contact: "suresh@mahek.in", mobile: "+91 98200 11004",
    status: "Deactivated", apps: [], roles: {},
    designation: "Telecaller",
    lastSeen: "28 Jul 2026", lastActive: "28 Jul 2026",
    created: "12 Mar 2026", createdBy: "Vikram Shah", joined: "12 Mar 2026",
    deactivatedOn: "28 Jul 2026", deactReason: "Resigned",
    grants: [], roleLog: [],
  },
];

/**
 * Each app declares what it owns per user. The console reads this contract and
 * knows nothing about what a "customer" or a "complaint" actually is.
 */
export const OWNED_CONTRACT: Record<string, Array<{ key: string; label: string; reassignable: boolean }>> = {
  crm: [
    { key: "customers", label: "Customers owned", reassignable: true },
    { key: "complaints", label: "Open complaints assigned", reassignable: true },
    { key: "reminders", label: "Reminders outstanding", reassignable: true },
    { key: "recovery", label: "Active recovery cases", reassignable: true },
  ],
  orders: [{ key: "dispatches", label: "Dispatches assigned", reassignable: true }],
  field: [{ key: "routes", label: "Routes assigned", reassignable: true }],
};

export const OWNED: Record<string, Record<string, Record<string, number>>> = {
  u1: { crm: { customers: 142, complaints: 2, reminders: 7, recovery: 5 } },
  u2: { crm: { customers: 0, complaints: 1, reminders: 3, recovery: 0 }, orders: { dispatches: 12 } },
  u3: { crm: { customers: 96, complaints: 1, reminders: 4, recovery: 2 } },
  u4: { crm: { customers: 0, complaints: 3, reminders: 2, recovery: 0 } },
  u5: {},
  u6: { crm: { customers: 88, complaints: 0, reminders: 6, recovery: 1 } },
  u7: {},
};

export type OwnedRow = {
  app: string;
  appId: string;
  key: string;
  label: string;
  count: number;
  reassignable: boolean;
};

/** Read from each app's declared contract — no CRM knowledge here. */
export function ownedFor(uid: string): OwnedRow[] {
  const rows: OwnedRow[] = [];
  const per = OWNED[uid] ?? {};
  for (const appId of Object.keys(per)) {
    const app = REGISTRY.find((a) => a.id === appId);
    for (const c of OWNED_CONTRACT[appId] ?? []) {
      const n = per[appId][c.key] ?? 0;
      if (n) {
        rows.push({ app: app ? app.name : appId, appId, key: c.key, label: c.label, count: n, reassignable: c.reassignable });
      }
    }
  }
  return rows;
}

/* ------------------------------------------------------ sessions & security */

export type Session = {
  id: string;
  user: string;
  app: string;
  device: string;
  ip: string;
  started: string;
  seen: string;
  stale?: boolean;
  current?: boolean;
};

export const SESSIONS: Session[] = [
  { id: "s1", user: "u1", app: "Telecaller CRM", device: "Windows 11 · Chrome 128", ip: "103.21.58.14", started: "Today, 09:04", seen: "2 minutes ago", current: true },
  { id: "s2", user: "u2", app: "Telecaller CRM", device: "macOS · Safari 18", ip: "103.21.58.14", started: "Today, 08:41", seen: "6 minutes ago" },
  { id: "s3", user: "u2", app: "Order Management", device: "Windows 11 · Edge 128", ip: "49.36.180.22", started: "Today, 10:02", seen: "20 minutes ago" },
  { id: "s4", user: "u3", app: "Telecaller CRM", device: "Windows 10 · Chrome 127", ip: "103.21.58.14", started: "Today, 09:12", seen: "1 hour ago" },
  { id: "s5", user: "u4", app: "Telecaller CRM", device: "Android · Chrome 128", ip: "182.70.44.9", started: "Yesterday, 18:20", seen: "Yesterday, 18:26", stale: true },
];

export const SIGNINS = [
  { user: "Priya Sharma", t: "Today, 09:04", ip: "103.21.58.14", device: "Windows · Chrome", ok: true, note: "" },
  { user: "Neha Joshi", t: "Today, 08:12", ip: "182.70.44.9", device: "Windows · Chrome", ok: false, note: "Wrong password · attempt 5" },
  { user: "Neha Joshi", t: "Today, 08:11", ip: "182.70.44.9", device: "Windows · Chrome", ok: false, note: "Wrong password · attempt 4" },
  { user: "Vikram Shah", t: "Today, 08:41", ip: "103.21.58.14", device: "macOS · Safari", ok: true, note: "" },
  { user: "Rakesh Yadav", t: "Today, 09:12", ip: "103.21.58.14", device: "Windows · Chrome", ok: true, note: "" },
  { user: "Unknown account", t: "Yesterday, 23:40", ip: "45.118.72.6", device: "Linux · curl", ok: false, note: "No such account · 11 attempts from this address" },
];

export const RESETS = [
  { user: "Neha Joshi", by: "Vikram Shah", t: "Today, 08:20", state: "Sent, not used", expires: "Expires 08:50" },
  { user: "Mahesh Parab", by: "Vikram Shah", t: "04 Aug, 10:10", state: "Expired unused", expires: "—" },
  { user: "Anjali Kulkarni", by: "Sandeep Rao", t: "20 Mar, 09:02", state: "Used", expires: "—" },
];

export const SECURITY_POLICY = [
  { label: "Session timeout", value: "8 hours" },
  { label: "Remember-me duration", value: "30 days" },
  { label: "Failed attempts before lockout", value: "5" },
  { label: "Lockout duration", value: "30 minutes" },
  { label: "Password minimum length", value: "10 characters" },
  { label: "Reset link expiry", value: "30 minutes" },
  { label: "Concurrent sessions per user", value: "3" },
];

export const SECURITY_FLAGS = [
  "Neha Joshi signed in from a new device at 08:10",
  "11 failed attempts from 45.118.72.6 against an account that does not exist",
];

/* --------------------------------------------------------------- access ops */

export type AccessRequest = { id: string; user: string; app: string; why: string; on: string };

export const REQUESTS: AccessRequest[] = [
  { id: "q1", user: "Rakesh Yadav", app: "Order Management", why: "Needs to check dispatches against his own collections calls.", on: "Today, 10:14" },
  { id: "q2", user: "Priya Sharma", app: "Salesman App", why: "Wants to see whether a visit happened before promising a date.", on: "Yesterday, 16:30" },
];

export const EXPIRING = [
  { who: "Vikram Shah", app: "Order Management", kind: "Delegated from Sandeep Rao", ends: "31 Aug 2026", left: 26 },
  { who: "Rakesh Yadav", app: "Telecaller CRM", kind: "Leave cover for Priya Sharma", ends: "20 Aug 2026", left: 15 },
];

export const UNUSED_ACCESS = [{ who: "Vikram Shah", app: "Order Management", granted: "04 Aug 2026", opened: "Never" }];

export const TEAMS = [
  { id: "t1", name: "Telecalling — Vikram", app: "Telecaller CRM", manager: "Vikram Shah", members: ["Priya Sharma", "Rakesh Yadav"] },
  { id: "t2", name: "Telecalling — Anjali", app: "Telecaller CRM", manager: "Anjali Kulkarni", members: ["Neha Joshi"] },
];

/* ---------------------------------------------------------------- onboarding */

export const ROLE_TEMPLATES = [
  { id: "rt1", name: "Telecaller", dept: "Telecalling", apps: "Telecaller CRM", roles: "CRM: Telecaller", used: 4 },
  { id: "rt2", name: "Telecalling Manager", dept: "Telecalling", apps: "Telecaller CRM, Order Management", roles: "CRM: Manager", used: 2 },
  { id: "rt3", name: "Field Salesman", dept: "Field sales", apps: "Salesman App", roles: "Field: Salesman", used: 0 },
];

export const CHECKLIST = [
  { label: "Account created", done: true },
  { label: "Apps granted", done: false },
  { label: "Role assigned", done: false },
  { label: "Added to a team", done: false },
  { label: "Customers assigned", done: false },
  { label: "First sign-in completed", done: false },
];

/* ---------------------------------------------------------- platform health */

export const JOBS = [
  { app: "Telecaller CRM", name: "Rebuild call queue", last: "Today, 08:00", dur: "42s", rows: "318 customers", ok: true, note: "" },
  {
    app: "Telecaller CRM", name: "Recompute buying cycles", last: "Today, 03:20", dur: "—", rows: "0", ok: false,
    note: "Timed out reading the order system. Cycles are stale, so the queue is ordering on yesterday's projections.",
  },
  { app: "Telecaller CRM", name: "Age collections stages", last: "Today, 03:05", dur: "11s", rows: "46 bills", ok: true, note: "" },
  { app: "Platform", name: "Nightly backup", last: "Today, 03:00", dur: "3m 12s", rows: "4.2 GB", ok: true, note: "" },
];

export const INTEGRATIONS = [
  { name: "External order system", app: "Telecaller CRM", state: "Failing", last: "Today, 07:30", note: "Authentication rejected on the last three attempts." },
  { name: "WhatsApp provider", app: "Telecaller CRM", state: "Not connected", last: "—", note: "Running in manual mode — messages are prepared, not sent." },
  { name: "Outbound mail (Resend)", app: "Platform", state: "Healthy", last: "Today, 08:20", note: "Password reset links. Without a key the mail is written to the log instead." },
  { name: "Backup", app: "Platform", state: "Healthy", last: "Today, 03:00", note: "Nightly, retained 30 days." },
];

export const PLATFORM_FACTS = [
  { label: "Last backup", value: "Today, 03:00", sub: "Nightly · 30-day retention" },
  { label: "Storage in use", value: "4.2 GB", sub: "Of 50 GB" },
  { label: "Active sessions", value: "5", sub: "Across 4 users" },
];

export const BACKUP_FACTS = [
  { label: "Last backup", value: "Today, 03:00", sub: "4.2 GB · 3m 12s" },
  { label: "Retention", value: "30 days", sub: "Nightly" },
  { label: "Restore last tested", value: "12 Jul 2026", sub: "Passed" },
];

export const IMPORTS = [
  { what: "Customer book", by: "Sandeep Rao", t: "02 Aug, 21:10", rows: 580, failed: 0, ok: true },
  { what: "Product catalogue", by: "Sandeep Rao", t: "02 Aug, 20:40", rows: 92, failed: 0, ok: true },
  { what: "Call history", by: "Sandeep Rao", t: "02 Aug, 22:05", rows: 14200, failed: 38, ok: false },
];

export const EXPORTS = [
  { what: "Customer book — full", by: "Vikram Shah", t: "Yesterday, 17:40", rows: 580 },
  { what: "Sales bills — August", by: "Anjali Kulkarni", t: "04 Aug, 11:20", rows: 316 },
  { what: "Audit log — July", by: "Sandeep Rao", t: "01 Aug, 09:00", rows: 1204 },
];

export const DEFAULT_ACCESS_RULES = [
  { line: "Every user with the CRM Manager role also receives Order Management access", on: true },
  { line: "Every new user receives Telecaller CRM access", on: false },
];

/* --------------------------------------------------------------- the audit */

export type AuditKind = "config" | "access" | "admin";

export type AuditRow = {
  kind: AuditKind;
  app: string;
  setting: string;
  from: string;
  to: string;
  actor: string;
  t: string;
};

export const AUDIT: AuditRow[] = [
  { kind: "config", app: "Telecaller CRM", setting: "Stage 2 threshold", from: "18 days", to: "21 days", actor: "Vikram Shah", t: "Today, 08:52" },
  { kind: "config", app: "Telecaller CRM", setting: "Routine check-in interval", from: "21 days", to: "14 days", actor: "Vikram Shah", t: "Yesterday, 17:10" },
  { kind: "access", app: "Platform", setting: "App access granted — Order Management", from: "—", to: "Vikram Shah", actor: "Sandeep Rao", t: "Yesterday, 11:02" },
  { kind: "access", app: "Platform", setting: "User deactivated", from: "Active", to: "Deactivated", actor: "Vikram Shah", t: "28 Jul, 16:40" },
  { kind: "admin", app: "Platform", setting: "App registered — Order Management", from: "—", to: "Coming soon", actor: "Sandeep Rao", t: "26 Jul, 10:15" },
  { kind: "admin", app: "Telecaller CRM", setting: "Template edited — Payment reminder stage 2", from: "—", to: "—", actor: "Anjali Kulkarni", t: "25 Jul, 15:30" },
  { kind: "config", app: "Telecaller CRM", setting: "Aging bucket boundaries", from: "0 / 30 / 60 / 90", to: "0 / 7 / 21 / 45", actor: "Vikram Shah", t: "24 Jul, 09:20" },
];

/* ------------------------------------------------------- entity collections */

export type EntityRow = {
  id: string;
  name: string;
  active: boolean;
  pack?: string;
  code?: string;
  rate?: string;
  cat?: string;
  stage?: string;
  uses?: number;
  body?: string;
  situation?: string;
  lang?: string;
  type?: string;
  roles?: string;
  meta?: string;
};

export const ENTITIES: Record<EntityKind, EntityRow[]> = {
  products: [
    { id: "p1", name: "Mahek Universal Thinner", pack: "5L", code: "MUT-03", rate: "1,240", active: true },
    { id: "p2", name: "Nano Thinner", pack: "20L", code: "NAN-02", rate: "4,180", active: true },
    { id: "p3", name: "Mahek NC Thinner", pack: "5L", code: "MNC-02", rate: "1,120", active: true },
    { id: "p4", name: "PU Thinner M16 Tin Can", pack: "1L", code: "PUM-02", rate: "310", active: true },
    { id: "p5", name: "Epoxy Thinner", pack: "20L", code: "EPX-03", rate: "4,650", active: false },
  ],
  templates: [
    {
      id: "t1", name: "Payment reminder — stage 1", cat: "Payment reminder", stage: "1", uses: 42, active: true,
      body: "Namaste {contact} ji,\n\n{customer} ke naam par bill {bill} pending hai — {amount}, {days} din ho gaye hain.\n\nKripya payment ki date bata dijiye.\n\n{telecaller}",
    },
    {
      id: "t2", name: "Payment reminder — stage 2", cat: "Payment reminder", stage: "2", uses: 18, active: true,
      body: "Namaste {contact} ji,\n\n{customer} ke {amount} abhi tak pending hain. Sabse purana bill {days} din ka ho gaya hai.\n\n{telecaller}",
    },
    {
      id: "t3", name: "Order confirmation", cat: "Order confirmation", stage: "—", uses: 61, active: true,
      body: "Namaste {contact} ji,\n\nAapka order confirm ho gaya hai — {qty}.\n\nDispatch {date} ko hoga.\n\n{telecaller}",
    },
    {
      id: "t4", name: "Routine check-in", cat: "Routine check-in", stage: "—", uses: 37, active: true,
      body: "Namaste {contact} ji,\n\n{customer} mein stock kaisa chal raha hai?\n\n{telecaller}",
    },
  ],
  scripts: [
    {
      id: "s1", name: "Payment reminder — stage 2", situation: "Collections stage 2", lang: "Hindi", active: true,
      body: 'OPENING\n"Namaste {contact} ji, {telecaller} bol rahi hoon Mahek Marketing se."\n\nPURPOSE\n"{customer} ke naam par {amount} pending hai. Humein aaj ek date chahiye."\n\nIF THEY BLAME ACCOUNTS\n"Accounts ka number de dijiye, main directly baat kar leta hoon."\n\nCLOSING\n"Dhanyavaad {contact} ji."',
    },
    {
      id: "s2", name: "Routine check-in", situation: "Routine check-in", lang: "Hindi", active: true,
      body: 'OPENING\n"Namaste {contact} ji. {telecaller} bol raha hoon, Mahek Marketing se."\n\nPURPOSE\n"Aapka last order {lastorder} ko tha. Stock kaisa chal raha hai?"\n\nCLOSING\n"Koi cheez chahiye to WhatsApp kar dijiye."',
    },
    {
      id: "s3", name: "Win-back", situation: "Inactive", lang: "Hindi", active: true,
      body: 'OPENING\n"Namaste {contact} ji. Bahut time se aapka order nahi aaya."\n\nPURPOSE\n"Koi problem hui thi kya?"\n\nCLOSING\n"Main {cycle} baad phir baat karunga."',
    },
  ],
  help: [
    { id: "h1", name: "The three escalation stages", cat: "Collections SOP", type: "SOP", roles: "Telecaller, Manager", active: true, body: "Stage 1 — WhatsApp only…" },
    { id: "h2", name: "Capturing an order during a call", cat: "Order capture", type: "SOP", roles: "Telecaller", active: true, body: "Capture the order inside the call panel…" },
    { id: "h3", name: "Repeat order call", cat: "Call scripts", type: "Call script", roles: "Telecaller", active: true, body: "Namaste [Name] ji…" },
  ],
  holidays: [],
  rules: [
    { id: "r1", name: "Outbound · Order Taken", meta: "Products required · notes optional", active: true },
    { id: "r2", name: "Outbound · Payment Promised", meta: "Promise date optional · amount required", active: true },
    { id: "r3", name: "Outbound · Follow-up", meta: "Follow-up date required", active: true },
    { id: "r4", name: "Outbound · No Answer", meta: "No fields · counts as missed", active: true },
    { id: "r5", name: "Inbound · Complaint", meta: "Category required · creates complaint", active: true },
    { id: "r6", name: "Order Received", meta: "Order date required · products required", active: true },
  ],
  notes: [
    { id: "n1", name: "Outbound · Order Taken", meta: "5 notes · 128 uses", active: true },
    { id: "n2", name: "Outbound · No Order", meta: "5 notes · 74 uses", active: true },
    { id: "n3", name: "Outbound · Payment Promised", meta: "4 notes · 61 uses", active: true },
    { id: "n4", name: "Inbound · Casual Talk", meta: "5 notes · 22 uses", active: true },
  ],
};

export const ENTITY_META: Record<EntityKind, { noun: string; cta: string }> = {
  products: { noun: "products", cta: "Add product" },
  templates: { noun: "templates", cta: "New template" },
  scripts: { noun: "scripts", cta: "New script" },
  help: { noun: "articles", cta: "New article" },
  holidays: { noun: "holidays", cta: "Add holiday" },
  rules: { noun: "outcomes", cta: "Edit rules" },
  notes: { noun: "groups", cta: "Add note" },
};

/* ------------------------------------------------------------- the personas */

export type Persona = {
  key: string;
  name: string;
  initials: string;
  role: string;
  /** Platform admins reach the platform sections; app managers do not. */
  platform: boolean;
  apps: string[];
};

export const PERSONAS: Persona[] = [
  { key: "admin", name: "Sandeep Rao", initials: "SR", role: "Platform admin", platform: true, apps: ["crm", "orders", "field"] },
  { key: "crmMgr", name: "Vikram Shah", initials: "VS", role: "CRM manager", platform: false, apps: ["crm"] },
];
