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
    status: "Live",
    route: "/orders",
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
    { slug: "drift", label: "Configuration drift" },
    { slug: "jobs", label: "Job health" },
    { slug: "activity", label: "Recent activity" },
  ],
  people: [
    { slug: "users", label: "Users" },
    { slug: "access", label: "App access" },
    { slug: "roles", label: "Roles & teams" },
    { slug: "security", label: "Sessions & security" },
    { slug: "onboarding", label: "Onboarding" },
  ],
  apps: [
    { slug: "registry", label: "Registry" },
    { slug: "status", label: "Status" },
    { slug: "rules", label: "Access rules" },
    { slug: "dashboard", label: "Per-app dashboard" },
    { slug: "schema", label: "Schema inspector" },
    { slug: "contracts", label: "Contract validation" },
    { slug: "flags", label: "Feature flags" },
    { slug: "platform", label: "Platform settings" },
  ],
  data: [
    { slug: "imports", label: "Import history" },
    { slug: "exports", label: "Export log" },
    { slug: "migration", label: "Migration status" },
    { slug: "backup", label: "Backup status" },
  ],
  notifications: [
    { slug: "catalogue", label: "Catalogue" },
    { slug: "announcements", label: "Announcements" },
    { slug: "delivery", label: "Delivery log" },
  ],
  audit: [
    { slug: "search", label: "Unified search" },
    { slug: "config", label: "Configuration changes" },
    { slug: "access", label: "Access changes" },
    { slug: "admin", label: "Admin actions" },
  ],
};

export const PLATFORM_SUBTITLES: Record<string, string> = {
  overview: "Platform health, external connections and what changed recently.",
  people: "Accounts, which apps they open, and what they can do inside each one.",
  apps: "The registry that drives the launcher and this console.",
  audit: "Every configuration and access change. Read-only, and never editable.",
  data: "What has been imported and exported, and whether the backup ran.",
  notifications: "What the platform sends, who receives it, and whether it arrived.",
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
  /**
   * The account this record is *about*, as opposed to the actor who caused it.
   * Without it, a user's own audit tab can only show what they did, never what
   * was done to them.
   */
  subject?: string | null;
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
