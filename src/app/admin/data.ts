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

import type { Tone } from "@/components/ui/primitives";

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
    id: "accounts",
    name: "Accounts",
    short: "Accounts",
    status: "Live",
    route: "/accounts",
    schemaEndpoint: "—",
    writeEndpoint: "—",
    summaryEndpoint: "—",
    roles: ["Accounts", "Manager"],
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

/* ---------------------------------------------------------------------------
 * The console holds NO copy of any app's settings.
 *
 * The CRM's schema is projected from `lib/config/registry.ts` by
 * `lib/config/schema-contract.ts` — the same file the engines read — so a
 * setting shown here is always one the CRM actually reads, and one added there
 * appears here with no change to this console.
 * ------------------------------------------------------------------------- */

export type EntityKind =
  | "templates"
  | "scripts"
  | "help"
  | "holidays"
  | "rules"
  | "notes";

/* ------------------------------------------------------- platform sections */

export type PlatformTab = { slug: string; label: string };

/**
 * Every sub-tab, with the slug it answers to.
 *
 * These were positional once and everything addressed them by index —
 * `navigate("apps", 5)` meant Contract validation only because it happened to
 * be sixth. Inserting a tab moved every deep link below it without a single
 * compile error. A slug cannot drift that way.
 */
export const PLATFORM_TABS: Record<string, PlatformTab[]> = {
  overview: [
    { slug: "attention", label: "Attention" },
    { slug: "health", label: "Health" },
    { slug: "integrations", label: "Integrations" },
    { slug: "usage", label: "Usage" },
    { slug: "configuration", label: "Configuration" },
    /* "Job health" while it only reported. It now carries two controls — the
       one-off backfill and the Call Log rebuild — and a tab named for a status
       report is a tab nobody looks in for a button. */
    { slug: "jobs", label: "Jobs" },
    /* Two questions about the platform rather than about access: who is signed
       in right now, and which accounts have never been used. They lived under
       People, which now answers one question only. */
    { slug: "sessions", label: "Sessions" },
    { slug: "onboarding", label: "Never signed in" },
  ],
  /*
   * One screen, no tabs.
   *
   * It was five — a roster, a grid of app checkboxes, a roles table, a session
   * list and a never-signed-in list — and the answer to "can Ramesh open the
   * bill ledger" was spread across three of them. A tab bar over one question
   * is a way of hiding most of the answer.
   */
  people: [{ slug: "access", label: "Access" }],
  apps: [
    { slug: "registry", label: "Registry" },
    { slug: "schema", label: "Schema inspector" },
  ],
  data: [
    { slug: "imports", label: "Sheet imports" },
    { slug: "migration", label: "Schema migrations" },
  ],
  notifications: [{ slug: "sent", label: "What was sent" }],
  voice: [{ slug: "credentials", label: "Credentials" }],
  components: [{ slug: "library", label: "Library" }],
  feedback: [
    { slug: "new", label: "New" },
    // The one tab that is about an obligation rather than a state: somebody
    // wrote something and nobody has answered it. A report can sit at "Being
    // looked at" for a week with a question against it that nobody has read.
    { slug: "awaiting", label: "Waiting on us" },
    { slug: "in-progress", label: "Being looked at" },
    { slug: "requests", label: "Feature requests" },
    { slug: "all", label: "Everything" },
  ],
  audit: [
    { slug: "all", label: "Everything" },
    { slug: "config", label: "Configuration" },
    { slug: "access", label: "Accounts & access" },
    { slug: "signin", label: "Sign-ins" },
    { slug: "work", label: "App activity" },
  ],
};

export const PLATFORM_SUBTITLES: Record<string, string> = {
  overview: "Platform health, external connections and what changed recently.",
  people:
    "Who can open which app, and how far into it. People come from the employee master, so access starts with somebody who actually works here.",
  apps: "The registry that drives the launcher and this console, and the settings each app declares.",
  audit: "Everything MahekOne has recorded happening. Read-only, and never editable.",
  data: "What has been imported from the sheets, and whether this database's schema is up to date.",
  notifications: "What the platform has sent, to whom, and whether they have read it.",
  voice:
    "The credentials dictation calls outside services with. Set here so a deploy nobody has shell access to can still turn the microphone on.",
  components:
    "Every component in every state, so a change to a token or a primitive can be checked in one place rather than hunted for across fifteen screens. A handoff artifact for whoever builds the screens.",
  feedback:
    "What the team has reported, asked for or suggested from inside the apps. Answering one tells the person who wrote it.",
};

/* --------------------------------------------------------------- the people */

export type UserStatus = "Active" | "Invited" | "Locked" | "Deactivated";

/** The badge colour for a status. Here rather than on a screen, so two screens
 *  cannot colour the same word differently. */
export function statusTone(status: UserStatus): Tone {
  return status === "Active"
    ? "success"
    : status === "Invited"
      ? "brand"
      : status === "Locked"
        ? "danger"
        : "neutral";
}

export type AdminUser = {
  id: string;
  name: string;
  code: string;
  dept: string;
  contact: string;
  mobile: string;
  status: UserStatus;
  apps: string[];
  /** The account's one role. There is no role per app. */
  platformRole: "telecaller" | "manager" | "accounts" | "admin";
  /** Customers whose book this account holds. Real work, not a decoration. */
  customers: number;
  reportsTo?: string;
  designation: string;
  lastSeen: string;
  lastActive: string;
  created: string;
  createdBy: string;
  joined: string;
  team?: number;
};

/**
 * Each app declares what it owns per user. The console reads this contract and
 * knows nothing about what a "customer" or a "complaint" actually is.
 */
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

/**
 * Fixtures for the collections the console still edits in a drawer.
 *
 * Products are NOT here, and must not come back. The catalogue is two hundred
 * real SKUs in the database, read and written by the Catalogue section — a
 * handful of invented rows sitting beside it, with invented rates, is a screen
 * that tells a manager something untrue about what the business sells.
 */
export const ENTITIES: Record<EntityKind, EntityRow[]> = {
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
  templates: { noun: "templates", cta: "New template" },
  scripts: { noun: "scripts", cta: "New script" },
  help: { noun: "articles", cta: "New article" },
  holidays: { noun: "holidays", cta: "Add holiday" },
  rules: { noun: "outcomes", cta: "Edit rules" },
  notes: { noun: "groups", cta: "Add note" },
};

