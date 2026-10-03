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
    { slug: "new", label: "New" },
    // The one tab about an obligation rather than a state: somebody wrote
    // something and nobody has answered it.
    { slug: "awaiting", label: "Waiting on us" },
    { slug: "in-progress", label: "Being looked at" },
    { slug: "requests", label: "Feature requests" },
    { slug: "all", label: "Everything" },
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
  expensePolicy: [
    { slug: "rules", label: "Rules" },
    { slug: "simulate", label: "What it would cost" },
    { slug: "versions", label: "Versions" },
    { slug: "grades", label: "Grades" },
    { slug: "cities", label: "Cities" },
  ],
  sheets: [
    { slug: "lines", label: "Order lines" },
    { slug: "orders", label: "Orders" },
    { slug: "issues", label: "Needs attention" },
    { slug: "sync", label: "Sync" },
    { slug: "history", label: "Every sheet's history" },
  ],
  person: [
    { slug: "profile", label: "Profile" },
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
  signIns: (tab?: TabsOf<"signIns">) => withTab("/admin/sign-ins", tab),
  settings: "/admin/settings",
  /** One app's settings. The page id comes from `SETTINGS_PAGES`. */
  settingsFor: (page: string, tab?: string) => withTab(`/admin/settings/${page}`, tab),
  catalogue: (tab?: TabsOf<"catalogue">) => withTab("/admin/catalogue", tab),
  expensePolicy: (tab?: TabsOf<"expensePolicy">) => withTab("/admin/expense-policy", tab),
  sheets: (tab?: TabsOf<"sheets">) => withTab("/admin/sheets", tab),
  deletedLeads: "/admin/deleted-leads",
  integrations: "/admin/integrations",
  handsets: "/admin/handsets",
  jobs: "/admin/jobs",
  notifications: "/admin/notifications",
  database: "/admin/database",
  audit: (tab?: TabsOf<"audit">) => withTab("/admin/audit", tab),
  components: "/admin/components",
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
};

export type AdminNavGroup = { label: string; icon: string; items: AdminNavItem[] };

/** Above the groups: where you start, and the one inbox. */
export const ADMIN_PINNED: AdminNavItem[] = [
  { href: ADMIN.home, label: "Home", icon: "dashboard", exact: true, platform: true, badge: "attention" },
  { href: ADMIN.feedback(), label: "Feedback", icon: "mail", badge: "feedback" },
];

/**
 * The groups. The settings group is filled in by the layout from
 * `SETTINGS_PAGES`, because which apps somebody may configure is theirs.
 */
export const ADMIN_GROUPS: AdminNavGroup[] = [
  {
    label: "People",
    icon: "people",
    items: [
      { href: ADMIN.access, label: "Access", icon: "people", platform: true },
      { href: ADMIN.signIns(), label: "Sign-ins", icon: "lock", platform: true },
    ],
  },
  { label: "Settings", icon: "settings", items: [] },
  {
    label: "Business data",
    icon: "book",
    items: [
      { href: ADMIN.catalogue(), label: "Catalogue", icon: "book", badge: "catalogue" },
      { href: ADMIN.expensePolicy(), label: "Expense policy", icon: "wallet" },
      { href: ADMIN.sheets(), label: "Sheets", icon: "doc", badge: "sheets" },
      { href: ADMIN.deletedLeads, label: "Deleted leads", icon: "history", platform: true },
    ],
  },
  {
    label: "System",
    icon: "grid",
    items: [
      { href: ADMIN.integrations, label: "Integrations", icon: "grid", platform: true },
      { href: ADMIN.handsets, label: "Handsets", icon: "phone", platform: true },
      { href: ADMIN.jobs, label: "Jobs", icon: "clock", platform: true },
      { href: ADMIN.notifications, label: "Notifications", icon: "bell", platform: true },
      { href: ADMIN.database, label: "Database", icon: "clipboard", platform: true },
      { href: ADMIN.audit(), label: "Audit log", icon: "eye", platform: true },
    ],
  },
  {
    label: "For builders",
    icon: "copy",
    items: [{ href: ADMIN.components, label: "Components", icon: "copy", platform: true }],
  },
];
