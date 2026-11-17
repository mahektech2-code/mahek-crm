/* ---------------------------------------------------------------------------
 * Every screen in the Admin Console, and the ONE place its address is written.
 *
 * The console used to be a single page that switched screens in memory, and
 * every link into it named a section and a tab as two loose strings. Renaming a
 * tab broke nothing at compile time — `navigate("apps", "contracts")` went on
 * pointing at a tab deleted two releases earlier, the Attention list sent
 * people to a section called "sheet" that had always been "order-sheet", and
 * HRMS linked to `/admin/access`, which was a blank page. Nothing failed; the
 * screen was simply wrong.
 *
 * So every screen is a real route now, and every link to one is built from
 * `ADMIN` below. A tab that is renamed here is renamed for every caller; a tab
 * that is removed stops compiling wherever it was linked. `admin-routes.test.ts`
 * checks the other half — that each address here has a `page.tsx` behind it.
 *
 * Pure and client-safe: the sidebar, the services that build the Attention
 * list and the other apps that link in all read it.
 * ------------------------------------------------------------------------- */

export type AdminTab = { slug: string; label: string };

/** The tabs of the sections that have them, in order. The first is where the section lands. */
export const ADMIN_TABS = {
  feedback: [
    // The queues in the order they are worked — `TRIAGE_QUEUES` in
    // feedback-labels.ts decides which one a report is in.
    { slug: "reply", label: "Needs a reply" },
    { slug: "waiting", label: "Waiting on them" },
    { slug: "looking", label: "Being looked at" },
    { slug: "closed", label: "Closed" },
    { slug: "all", label: "Everything" },
    { slug: "overview", label: "Overview" },
  ],
  signIns: [
    { slug: "now", label: "Signed in now" },
    { slug: "never", label: "Never signed in" },
  ],
  catalogue: [
    { slug: "skus", label: "All SKUs" },
    { slug: "goods", label: "Finished goods" },
    { slug: "brands", label: "Brands & formulations" },
    { slug: "categories", label: "Categories" },
    { slug: "duplicates", label: "Duplicates" },
    { slug: "exceptions", label: "Held & excluded" },
    { slug: "import", label: "Import" },
  ],
  sheets: [
    { slug: "lines", label: "Order lines" },
    { slug: "orders", label: "Orders" },
    { slug: "issues", label: "Needs attention" },
    { slug: "sync", label: "Sync" },
    { slug: "history", label: "Every sheet's history" },
  ],
  roles: [
    { slug: "matrix", label: "By permission" },
    { slug: "clashes", label: "Clashing hats" },
  ],
  otp: [
    { slug: "requests", label: "Every request" },
    { slug: "people", label: "By person" },
  ],
  /* Access seen from the power's side — who holds it, who could, what waits on it. */
  powers: [
    { slug: "powers", label: "Powers" },
    { slug: "screens", label: "Screens" },
    { slug: "templates", label: "Job templates" },
  ],
  person: [
    { slug: "profile", label: "Overview" },
    { slug: "apps", label: "Apps" },
    { slug: "sessions", label: "Sessions" },
    { slug: "audit", label: "Audit" },
  ],
  /* The audit log's groups — `AUDIT_GROUPS` in lib/audit-labels.ts is the
     definition and audit-labels.test.ts holds the two lists together. */
  audit: [
    { slug: "all", label: "Everything" },
    { slug: "money", label: "Money" },
    { slug: "customers", label: "Customers & leads" },
    { slug: "field", label: "Field team" },
    { slug: "factory", label: "Factory" },
    { slug: "hr", label: "HR" },
    { slug: "tasks", label: "Tasks" },
    { slug: "studio", label: "Studio" },
    { slug: "locker", label: "Locker" },
    { slug: "access", label: "People & access" },
    { slug: "settings", label: "Settings & catalogue" },
    { slug: "signin", label: "Sign-ins" },
  ],
} as const satisfies Record<string, readonly AdminTab[]>;

export type TabsOf<K extends keyof typeof ADMIN_TABS> = (typeof ADMIN_TABS)[K][number]["slug"];

const withTab = (base: string, tab?: string) => (tab ? `${base}/${tab}` : base);

/** Build every console address from here, never from a literal. */
export const ADMIN = {
  home: "/admin",
  feedback: (tab?: TabsOf<"feedback">) => withTab("/admin/feedback", tab),
  access: "/admin/access",
  /** Access, narrowed to the people who hold one app. */
  accessFor: (app: string) => `/admin/access?app=${app}`,
  person: (userId: string, tab?: TabsOf<"person">) => withTab(`/admin/access/${userId}`, tab),
  /** Every power and screen, who holds it and what waits on it; job templates across every app. */
  powers: (tab?: TabsOf<"powers">) => withTab("/admin/powers", tab),
  /** The ERP's designations — named, linked shapes of ERP access. */
  designations: "/admin/designations",
  /** Access, narrowed to the holders of one ERP designation. */
  accessForDesignation: (id: string) => `/admin/access?designation=${id}`,
  signIns: (tab?: TabsOf<"signIns">) => withTab("/admin/sign-ins", tab),
  /** The sign-in policy: lockouts, the console re-check, codes. */
  security: "/admin/security",
  /** The permission matrix, read-only, and who holds each power. */
  roles: (tab?: TabsOf<"roles">) => withTab("/admin/roles", tab),
  /** Every configuration change, old value beside new. */
  changes: "/admin/changes",
  /** Checks over the book, and the rebuild button for each derived figure. */
  health: "/admin/health",
  /** Which build every handset runs. */
  releases: "/admin/releases",
  /** Files: space by kind, and how long each kind is kept. */
  storage: "/admin/storage",
  /** Every one-time code sent through MiniMoth or Wati, and every request refused. */
  otp: (tab?: TabsOf<"otp">) => withTab("/admin/otp", tab),
  settings: "/admin/settings",
  /** One app's settings. The page id comes from `SETTINGS_PAGES`. */
  settingsFor: (page: string, tab?: string) => withTab(`/admin/settings/${page}`, tab),
  catalogue: (tab?: TabsOf<"catalogue">) => withTab("/admin/catalogue", tab),
  /** The named expense policies; with an id, that policy's editor. */
  expensePolicy: (id?: string) => withTab("/admin/expense-policy", id),
  sheets: (tab?: TabsOf<"sheets">) => withTab("/admin/sheets", tab),
  deletedLeads: "/admin/deleted-leads",
  integrations: "/admin/integrations",
  handsets: "/admin/handsets",
  /** Switches, sentences and banners on salesmen's phones, changed without a release. */
  mbosControl: "/admin/mbos-control",
  factoryHandsets: "/admin/factory-handsets",
  jobs: "/admin/jobs",
  notifications: "/admin/notifications",
  audit: (tab?: TabsOf<"audit">) => withTab("/admin/audit", tab),
} as const;

/** The tab a slug names, or the first one — a link to a tab since removed still opens the section. */
export function tabIndexOf(tabs: readonly AdminTab[], slug: string | undefined): number {
  return Math.max(0, tabs.findIndex((t) => t.slug === slug));
}

/* ------------------------------------------------------------ the sidebar */

export type AdminNavItem = {
  href: string;
  label: string;
  icon: string;
  exact?: boolean;
  /** Platform administrators only. Everything else is reached by anybody the layout lets in. */
  platform?: boolean;
  /** Which count to draw beside it. */
  badge?: "attention" | "feedback" | "catalogue" | "sheets";
  /** Other path prefixes this row is lit on. */
  match?: readonly string[];
};

export type AdminNavGroup = { label: string; icon: string; items: AdminNavItem[] };

/** Above the groups: where you start, and the one inbox. */
export const ADMIN_PINNED: AdminNavItem[] = [
  { href: ADMIN.home, label: "Home", icon: "home", exact: true, platform: true, badge: "attention" },
  { href: ADMIN.feedback(), label: "Inbox", icon: "inbox", badge: "feedback" },
];

/**
 * The groups, by the job somebody came here to do — the canvas's sidebar.
 * `icon` names a path in the shell's own set (`_shell/nav-icons.ts`), the
 * mockup's glyphs. Settings is ONE row: its pages are tabs on the screen.
 */
export const ADMIN_GROUPS: AdminNavGroup[] = [
  {
    label: "People & access",
    icon: "people",
    items: [
      { href: ADMIN.access, label: "People & access", icon: "people", platform: true },
      { href: ADMIN.roles(), label: "Roles & permissions", icon: "matrix", platform: true },
      { href: ADMIN.powers(), label: "Powers & screens", icon: "key", platform: true },
      { href: ADMIN.designations, label: "ERP designations", icon: "book", platform: true },
      {
        href: ADMIN.signIns(),
        label: "Security & sign-ins",
        icon: "shield",
        platform: true,
        match: ["/admin/otp", "/admin/security"],
      },
    ],
  },
  {
    label: "Configuration",
    icon: "sliders",
    items: [
      { href: ADMIN.settings, label: "Settings", icon: "sliders", match: ["/admin/settings"] },
      { href: ADMIN.changes, label: "Change history", icon: "history", platform: true },
      { href: ADMIN.integrations, label: "Integrations & keys", icon: "plug", platform: true },
      { href: ADMIN.expensePolicy(), label: "Expense policy", icon: "wallet" },
    ],
  },
  {
    label: "Business data",
    icon: "box",
    items: [
      { href: ADMIN.catalogue(), label: "Catalogue", icon: "box", badge: "catalogue" },
      { href: ADMIN.sheets(), label: "Sheets & imports", icon: "sheet", badge: "sheets" },
      { href: ADMIN.health, label: "Data health", icon: "pulse", platform: true },
      { href: ADMIN.deletedLeads, label: "Recycle bin", icon: "trash", platform: true },
    ],
  },
  {
    label: "Devices",
    icon: "phone",
    items: [
      { href: ADMIN.handsets, label: "Handsets", icon: "phone", platform: true, match: ["/admin/factory-handsets"] },
      { href: ADMIN.mbosControl, label: "MBOS control", icon: "sliders", platform: true },
      { href: ADMIN.releases, label: "App releases", icon: "release", platform: true },
    ],
  },
  {
    label: "System",
    icon: "clock",
    items: [
      { href: ADMIN.jobs, label: "Jobs & schedules", icon: "clock", platform: true },
      { href: ADMIN.notifications, label: "Notifications", icon: "bell", platform: true },
      { href: ADMIN.storage, label: "Storage & files", icon: "db", platform: true },
      { href: ADMIN.audit(), label: "Audit log", icon: "eye", platform: true },
    ],
  },
];

/**
 * Security & sign-ins is one screen to read and three routes underneath: the
 * sessions, the code history and the policy each keep the address they had,
 * and share this one tab strip so the screen reads as one.
 */
export const SECURITY_TABS = [
  { slug: "now", label: "Signed in now", href: ADMIN.signIns("now") },
  { slug: "never", label: "Never signed in", href: ADMIN.signIns("never") },
  { slug: "codes", label: "Codes", href: ADMIN.otp("requests") },
  { slug: "codes-people", label: "Codes by person", href: ADMIN.otp("people") },
  { slug: "policy", label: "Policy", href: ADMIN.security },
] as const;

/** Handsets likewise: the salesman's phones and the factory's, one fleet. */
export const HANDSET_TABS = [
  { slug: "field", label: "Salesman App", href: ADMIN.handsets },
  { slug: "factory", label: "Factory app", href: ADMIN.factoryHandsets },
] as const;
