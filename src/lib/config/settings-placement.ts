import { GROUP_ORDER, PRESENTATION, TABS as CRM_TABS } from "./presentation";

/* ---------------------------------------------------------------------------
 * Which settings page, tab and group every setting sits on.
 *
 * WHY THIS FILE EXISTS. The console rendered one schema, the CRM's, and a
 * setting with no entry in `PRESENTATION` landed on a tab called "Other" in a
 * group called "Not yet placed". By the time anybody looked, 254 of the
 * registry's settings were there — every one of the field app's, the ERP's,
 * the lead funnel's, salesman performance, sign-in codes, payments — all of
 * them presented as the Telecaller CRM's, on one unsorted page, while the
 * Sales Dashboard and the ERP each said they had nothing to configure.
 *
 * So placement is a set of rules, read top to bottom, matched on the key —
 * the same keys the engines read — and the first rule that matches decides.
 * A rule with no group of its own keeps the group `PRESENTATION` gives the
 * setting, or names one after the key's own segment. A setting that matches
 * no rule and has no presentation tab is placed NOWHERE, and
 * `settings-placement.test.ts` fails the build on it: a setting that cannot be
 * found cannot be changed, and the dump is how that used to look like it could.
 *
 * Pure and client-safe.
 * ------------------------------------------------------------------------- */

/**
 * Settings the registry keeps so a stored value still resolves, and that
 * nothing reads any more. Drawing one would be a control that changes nothing.
 */
export const RETIRED_SETTINGS: ReadonlySet<string> = new Set([
  // Sending is the founder's switch, on the Founder Command Centre's WhatsApp desk.
  "whatsapp.mode",
]);

export type Placement = {
  page: string;
  tab: string;
  group: string;
  /** Orders groups within a tab: the presentation's own order first, then the rules'. */
  rank: number;
};

/** Every page's tabs, in the order they are drawn. */
export const PAGE_TABS: Record<string, Array<{ slug: string; label: string }>> = {
  platform: [
    { slug: "sign-in", label: "Sign-in" },
    { slug: "workday", label: "Workday" },
    { slug: "attachments", label: "Attachments" },
    { slug: "people", label: "People & names" },
    { slug: "maps", label: "Map keys" },
  ],
  // The CRM's own tabs, as `presentation.ts` declares them, less the four that
  // moved to the page that owns what they decide.
  crm: CRM_TABS.filter((t) => !["workday", "attachments", "voice", "pricing"].includes(t.slug)).map((t) => ({
    slug: t.slug,
    label: t.label,
  })),
  leads: [
    { slug: "gates", label: "Gates & decisions" },
    { slug: "reasons", label: "Reason lists" },
    { slug: "handset", label: "On the handset" },
  ],
  sales: [
    { slug: "attendance", label: "Attendance & leave" },
    { slug: "tracking", label: "Tracking & the Live map" },
    { slug: "visits", label: "Visits & routes" },
    { slug: "orders", label: "Orders, credit & collections" },
    { slug: "performance", label: "Targets & health" },
    { slug: "expenses", label: "Expenses" },
    { slug: "handset", label: "The handset" },
  ],
  accounts: [
    { slug: "payments", label: "Payments" },
    { slug: "price-lists", label: "Price lists" },
  ],
  erp: [
    { slug: "general", label: "Production & orders" },
    { slug: "alerts", label: "Alerts" },
    { slug: "assistants", label: "AI assistants" },
  ],
  hire: [
    { slug: "ai", label: "AI" },
    { slug: "pipeline", label: "Pipeline & voice screen" },
  ],
  reports: [
    { slug: "kpis", label: "Owner's KPIs" },
    { slug: "health", label: "Customer health" },
  ],
  ai: [
    { slug: "dictation", label: "Dictation" },
    { slug: "call-assistant", label: "Call assistant" },
    { slug: "assistants", label: "Other assistants" },
  ],
};

type Rule = { test: RegExp; page: string; tab: string; group?: string | ((key: string) => string) };

/** The words for a key's assistant, so the assistants page reads as five named things. */
const ASSISTANT: Record<string, string> = {
  visitIntel: "The visit",
  leadCallIntel: "The lead calling desk",
  verifyIntel: "The verification call",
  convertIntel: "Convert to Prospect",
  intakeIntel: "Lead intake",
  leadScan: "Reading a visiting card",
  leadVoice: "Filling a lead by voice",
  mbos: "On the handset",
};

const ERP_ASSISTANT: Record<string, string> = {
  voice: "Voice notes",
  complaints: "Complaints",
  reorder: "Re-order levels",
  bills: "Supplier bills",
  bill: "Supplier bills",
  orders: "Orders from messages",
  ask: "Ask the ERP",
  photos: "LR and test photos",
  qc: "Quality checks",
  visionModel: "Models",
  textModel: "Models",
};

const RULES: Rule[] = [
  /* ------------------------------------------------------------- platform */
  {
    test: /^auth\.otp\.(defaultChannel|sms|whatsapp)/,
    page: "platform",
    tab: "sign-in",
    group: "How the code is sent",
  },
  { test: /^auth\.(password|console)\./, page: "platform", tab: "sign-in", group: "Passwords and the console" },
  { test: /^auth\./, page: "platform", tab: "sign-in", group: "The code itself" },
  { test: /^workingDay\./, page: "platform", tab: "workday" },
  { test: /^attachments\.maxPerFeedback$/, page: "platform", tab: "attachments", group: "Limits" },
  { test: /^attachments\./, page: "platform", tab: "attachments" },
  { test: /^people\./, page: "platform", tab: "people", group: "People" },
  { test: /^maps\./, page: "platform", tab: "maps", group: "The Ola Maps key pool" },

  /* ------------------------------------------------------------------ CRM */
  {
    test: /^queue\.(routineCallPercent|routineConfidenceSwing|routineMinCycleDays)$/,
    page: "crm",
    tab: "call-queue",
    group: "The stock-check call",
  },
  { test: /^queue\.(outcomeCooldownDays|noAnswer)/, page: "crm", tab: "call-queue", group: "After a call" },
  { test: /^queue\.(includePaymentDue|showOrderStatus)$/, page: "crm", tab: "call-queue", group: "What the Call Log shows" },
  { test: /^queue\.orderValueLookbackDays$/, page: "crm", tab: "call-queue", group: "Size and ordering" },
  { test: /^escalation\.slowPayerGraceDays$/, page: "crm", tab: "collections", group: "Behaviour" },
  { test: /^products\.searchMinChars$/, page: "crm", tab: "products", group: "How the order form offers them" },

  /* ------------------------------------------------------------ lead funnel */
  { test: /^leads\.(\w+Reasons|orderBlockers|sources)$/, page: "leads", tab: "reasons", group: "Reason lists" },
  { test: /^leads\.(?!distributor)/, page: "leads", tab: "gates", group: "Gates and decisions" },
  { test: /^mbos\.leads\.(visitsBeforeDecision|maxSuspectVisits)$/, page: "leads", tab: "gates", group: "Deciding about a Suspect" },
  { test: /^leads\.distributor/, page: "leads", tab: "gates", group: "Appointing a distributor" },
  { test: /^mbos\.leads\./, page: "leads", tab: "handset", group: "Leads on the handset" },
  { test: /^mbos\.samples\./, page: "leads", tab: "handset", group: "Samples" },

  /* --------------------------------------------------- sales & field app */
  { test: /^mbos\.attendance\./, page: "sales", tab: "attendance", group: "Check-in and the day" },
  { test: /^mbos\.leave\./, page: "sales", tab: "attendance", group: "Leave" },
  { test: /^mbos\.(visits?|travel)\./, page: "sales", tab: "visits", group: "Visits" },
  { test: /^mbos\.route\./, page: "sales", tab: "visits", group: "Ordering a day's route" },
  { test: /^mbos\.location\.nearby(RadiusOptions|PerKilometreCost)$/, page: "sales", tab: "visits", group: "What is near me" },
  {
    test: /^mbos\.location\.(gpsAccuracyThresholdM|visitMismatchM|routeDeviationM|unplannedVisitsPerDay|startOfDayGate)$/,
    page: "sales",
    tab: "tracking",
    group: "Accuracy and the check-in radius",
  },
  {
    test: /^mbos\.location\.(trackWhileWorking|trackEverySeconds|trail(KeepEverySeconds|StalledAfterMisses|StalledMinSilenceSeconds)|queue|tracker|trackingSetup|service)/,
    page: "sales",
    tab: "tracking",
    group: "Following the route",
  },
  {
    test: /^mbos\.location\.(logActivityLocation|activityFixMaxAgeSeconds)$/,
    page: "sales",
    tab: "tracking",
    group: "Where each activity was done",
  },
  { test: /^mbos\.location\./, page: "sales", tab: "tracking", group: "The Live map" },
  { test: /^mbos\.orders\./, page: "sales", tab: "orders", group: "Orders" },
  { test: /^mbos\.credit\./, page: "sales", tab: "orders", group: "Credit" },
  { test: /^mbos\.payments\./, page: "sales", tab: "orders", group: "Collections" },
  { test: /^mbos\.(approvals|tasks)\./, page: "sales", tab: "orders", group: "Tasks and approvals" },
  {
    test: /^performance\.weight/,
    page: "sales",
    tab: "performance",
    group: "The six weights",
  },
  { test: /^performance\./, page: "sales", tab: "performance", group: "Scoring and targets" },
  { test: /^mbos\.health\./, page: "sales", tab: "performance", group: "Customer health score" },
  { test: /^expenses\./, page: "sales", tab: "expenses", group: "Checking a claim" },
  { test: /^mbos\.expenses\./, page: "sales", tab: "expenses", group: "Recording an expense" },
  { test: /^mbos\.sync\./, page: "sales", tab: "handset", group: "Sync" },
  { test: /^mbos\.devices\./, page: "sales", tab: "handset", group: "Devices" },
  { test: /^mbos\.push\./, page: "sales", tab: "handset", group: "Push notifications" },
  { test: /^mbos\.maps\./, page: "sales", tab: "handset", group: "Offline maps" },

  /* -------------------------------------------------------------- accounts */
  { test: /^payments\./, page: "accounts", tab: "payments", group: "Recording and confirming money" },
  { test: /^pricing\./, page: "accounts", tab: "price-lists" },

  /* ------------------------------------------------------------------- ERP */
  { test: /^erp\.purchase\./, page: "erp", tab: "general", group: "Purchase" },
  { test: /^erp\.(production|orders)\./, page: "erp", tab: "general", group: "Production and orders" },
  { test: /^erp\.location\./, page: "erp", tab: "general", group: "Working location" },
  { test: /^erp\.ai\.alerts\.enabled$/, page: "erp", tab: "alerts", group: "Switch" },
  { test: /^erp\.ai\.alerts\./, page: "erp", tab: "alerts", group: "Thresholds" },
  { test: /^erp\.ai\./, page: "erp", tab: "assistants", group: (k) => ERP_ASSISTANT[k.split(".")[2]] ?? "Other" },

  /* ------------------------------------------------------------------ hire */
  { test: /^hire\.ai\.(enabled|minConfidence|monthlyBudgetPaise)$/, page: "hire", tab: "ai", group: "Switch, confidence and budget" },
  { test: /^hire\.ai\./, page: "hire", tab: "ai", group: "Models" },
  { test: /^hire\./, page: "hire", tab: "pipeline" },

  /* --------------------------------------------------------------- reports */
  { test: /^owner\./, page: "reports", tab: "kpis", group: "The owner's five" },
  { test: /^health\./, page: "reports", tab: "health", group: "Health bands" },

  /* ------------------------------------------------------------ voice & AI */
  {
    test: /^voice\.(noiseSuppression|autoGainControl|echoCancellation)$/,
    page: "ai",
    tab: "dictation",
    group: "The microphone",
  },
  { test: /^voice\./, page: "ai", tab: "dictation" },
  { test: /^callIntel\./, page: "ai", tab: "call-assistant" },
  {
    test: /^(visitIntel|leadCallIntel|verifyIntel|convertIntel|intakeIntel|leadScan|leadVoice|mbos\.ai)\./,
    page: "ai",
    tab: "assistants",
    group: (k) => ASSISTANT[k.split(".")[0]] ?? "Other",
  },
];

/** The CRM tab a presentation label names. */
const CRM_SLUG = new Map(CRM_TABS.map((t) => [t.label as string, t.slug as string]));

/**
 * Where one setting lives, or null if nowhere. HRMS's keys are placed by
 * `hrmsSchema` from their own second segment and are not handled here.
 */
export function placeSetting(key: string): Placement | null {
  if (RETIRED_SETTINGS.has(key)) return null;
  const p = PRESENTATION[key];
  const declared = (group: string) => {
    const i = p?.tab ? (GROUP_ORDER[p.tab] ?? []).indexOf(group) : -1;
    return i;
  };
  for (const [index, rule] of RULES.entries()) {
    if (!rule.test.test(key)) continue;
    const group =
      typeof rule.group === "function" ? rule.group(key) : (rule.group ?? p?.group ?? segmentLabel(key));
    const i = declared(group);
    return { page: rule.page, tab: rule.tab, group, rank: i >= 0 ? i : 1000 + index };
  }
  // Everything else is the CRM's, where the presentation says so.
  const slug = p?.tab ? CRM_SLUG.get(p.tab) : undefined;
  if (slug && PAGE_TABS.crm.some((t) => t.slug === slug)) {
    const group = p!.group ?? "Other";
    const i = declared(group);
    return { page: "crm", tab: slug, group, rank: i >= 0 ? i : 1000 + RULES.length };
  }
  return null;
}

function segmentLabel(key: string): string {
  const seg = key.split(".")[1] ?? key;
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/([A-Z])/g, " $1").toLowerCase();
}
