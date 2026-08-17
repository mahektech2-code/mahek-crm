import { APPS, type AppId } from "./apps";

/* ---------------------------------------------------------------------------
 * What a person can open INSIDE an app.
 *
 * `app_access` answers "may they open the CRM". It does not answer "may they
 * open the EOD report", and until this file existed there was no way to ask —
 * a telecaller granted the CRM got every screen in it, including Monthly
 * Targets and the Sheet import, because the app was the smallest thing that
 * could be granted.
 *
 * A module is a destination in an app's navigation. That is deliberate and it
 * is the whole rule: if it has a place in the sidebar or the header, it is a
 * module and it can be withheld; if it does not, it is part of the screen its
 * link belongs to. Anything else would be a permission somebody can see the
 * door to and not open, which reads as a broken app rather than as a policy.
 *
 * This file is PURE and client-safe — the access screen renders the same list
 * the server enforces, because a review table that disagreed with the guard
 * would be worse than no review table. Enforcement is `lib/access.ts`, which
 * is server-only and reads this.
 *
 * The keys are stored in `app_module_access.module` and they are therefore
 * join keys: renaming one silently revokes it from everybody who held it. A
 * module that has to change its name becomes a new key plus a migration that
 * moves the rows.
 * ------------------------------------------------------------------------- */

export type AppModule = {
  /** Stored. `crm.reminders`. Never renamed — it is what a grant points at. */
  key: string;
  app: AppId;
  /** What the navigation calls it, so the review table and the sidebar agree. */
  label: string;
  /** The sidebar group it sits under, purely so the table reads in sections. */
  group: string;
  /** Where it lives. The guard matches a path against this. */
  href: string;
  /**
   * True where the route is the app's own root and would otherwise match every
   * child path — `/accounts` is Today, not the whole of Accounts.
   */
  exact?: boolean;
  /** One line on what withholding it actually costs somebody. */
  note?: string;
};

const crm = (
  slug: string,
  label: string,
  group: string,
  note?: string,
): AppModule => ({
  key: `crm.${slug}`,
  app: "crm",
  label,
  group,
  href: `/crm/${slug}`,
  note,
});

const accounts = (
  slug: string,
  label: string,
  group: string,
  note?: string,
): AppModule => ({
  key: `accounts.${slug}`,
  app: "accounts",
  label,
  group,
  href: `/accounts/${slug}`,
  note,
});

/**
 * Every module MahekOne has, in the order its app draws them.
 *
 * The CRM list is `components/shell/nav.ts` and the Accounts list is
 * `app/accounts/accounts-shell.tsx`, read off the screen rather than invented
 * here — both of those filter themselves through this file, so a nav item
 * added without a module here simply would not appear, which is the failure
 * direction that shows up immediately rather than the one that quietly grants
 * everybody a new screen.
 */
export const APP_MODULES: AppModule[] = [
  /* --------------------------------------------------------------- the CRM */
  crm("dashboard", "Dashboard", "Overview"),
  crm("call-log", "Call Log", "Daily calling", "The calling queue itself. Without it there is no day's work to do."),
  crm("reminders", "Reminders", "Daily calling"),
  crm("history", "Call History", "Daily calling"),
  crm("payments", "Payment Follow-up", "Collections", "Chasing money owed. A telecaller who only sells does not need it."),
  crm(
    "outstanding",
    "Outstanding",
    "Collections",
    "Who owes what, and the bills behind each balance.",
  ),
  crm("bills", "Sales Bills", "Collections"),
  crm("inactive", "Inactive Watch", "Collections"),
  crm("customers", "Customers", "Customer records", "The customer list and every customer record behind it."),
  crm("complaints", "Complaints", "Customer records"),
  // WRITTEN OUT LONGHAND, because the key and the route have to disagree.
  //
  // The `crm()` helper derives both from one slug, which is right for every
  // other screen and wrong for this one: the KEY is `crm.deactivations` and must
  // stay that way for ever — it is what `app_module_access` rows point at, so
  // renaming it would silently revoke this screen from everybody holding it —
  // while the ROUTE moved to `/crm/status-requests`, because "deactivations"
  // named half of what the screen does.
  //
  // A label is cosmetic. A route is a bookmark, and `next.config.ts` redirects
  // the old one. A key is a join, and it does not move.
  {
    key: "crm.deactivations",
    app: "crm",
    label: "Close/Reopen",
    group: "Customer records",
    href: "/crm/status-requests",
    note: "Approving or refusing a request to close a customer account, or to reopen one. Withholding it leaves those requests to another manager — the ask still reaches everybody who can decide.",
  },
  crm("targets", "Monthly Targets", "Targets & reporting", "Whose numbers are whose. Usually a manager's screen."),
  crm("eod", "EOD Report", "Targets & reporting"),
  crm("whatsapp", "WhatsApp", "Communication"),
  crm("help", "Help Center", "Support", "The SOPs. Withholding it is rarely what anybody means."),
  crm(
    "settings",
    "Manager settings",
    "Support",
    "Not in the sidebar — reached from the Help Center, and a manager's screen wherever it is reached from.",
  ),

  /* ---------------------------------------------------------- the Accounts */
  {
    key: "accounts.today",
    app: "accounts",
    label: "Today",
    group: "Overview",
    href: "/accounts",
    exact: true,
  },
  accounts("approvals", "Order approvals", "Decisions", "Approving or declining an order somebody took on a call."),
  accounts("payments", "Payments to confirm", "Decisions", "Confirming that money a telecaller reported actually arrived."),
  accounts("credits", "Credit notes", "Decisions"),
  accounts("customers", "Customers", "Accounts", "Where an account manager is changed. Accounts' and admin's alone."),
  accounts("record", "Record a payment", "Money"),
  accounts(
    "outstanding",
    "Outstanding",
    "Money",
    "What each customer still owes, and the bills behind it.",
  ),
  accounts("bills", "Bills", "Money"),
  accounts("ledger", "Customer account", "Money"),
  accounts("on-account", "On account", "Money"),
  accounts("import", "Sheet import", "System", "Runs the projection against the live database."),
  accounts("audit", "Audit log", "System"),

  /* -------------------------------------------------------------- the HRMS */
  {
    key: "hrms.employees",
    app: "hrms",
    label: "All Employees",
    group: "Employees",
    href: "/hrms/employees",
    note: "Salaries, home addresses and identity numbers.",
  },

  /* ------------------------------------------------------------- the admin */
  {
    key: "admin.console",
    app: "admin",
    label: "Admin Console",
    group: "Platform",
    href: "/admin",
    exact: false,
    note: "The whole console. Its own sections are not separately grantable yet.",
  },

  /* ---------------------------------------------------- apps not built yet */
  { key: "field.home", app: "field", label: "Salesman App", group: "App", href: "/field" },
  { key: "people.home", app: "people", label: "Attendance & People", group: "App", href: "/people" },
  { key: "reports.home", app: "reports", label: "Reports", group: "App", href: "/reports" },
];

const BY_KEY = new Map(APP_MODULES.map((m) => [m.key, m]));

export function getModule(key: string): AppModule | undefined {
  return BY_KEY.get(key);
}

export function modulesForApp(app: AppId): AppModule[] {
  return APP_MODULES.filter((m) => m.app === app);
}

export function moduleKeysForApp(app: AppId): string[] {
  return modulesForApp(app).map((m) => m.key);
}

/** The review table renders in sections, in the order the sidebar draws them. */
export function moduleGroupsForApp(app: AppId): Array<{ group: string; modules: AppModule[] }> {
  const out: Array<{ group: string; modules: AppModule[] }> = [];
  for (const m of modulesForApp(app)) {
    const last = out[out.length - 1];
    if (last && last.group === m.group) last.modules.push(m);
    else out.push({ group: m.group, modules: [m] });
  }
  return out;
}

/**
 * Which module a path belongs to.
 *
 * Longest href wins, so `/crm/customers/import` resolves to Customers rather
 * than to whichever module happened to be registered first — every screen
 * under a module's route is that module, which is what makes a folder-level
 * guard enough.
 */
export function moduleForPath(path: string): AppModule | undefined {
  let best: AppModule | undefined;
  for (const m of APP_MODULES) {
    const hit = m.exact ? path === m.href : path === m.href || path.startsWith(m.href + "/");
    if (!hit) continue;
    if (!best || m.href.length > best.href.length) best = m;
  }
  return best;
}

/**
 * Whether a set of stored grants lets somebody open a module.
 *
 * An app grant with NO module rows means every module. That is what kept the
 * day this shipped uneventful: every grant that already existed carried on
 * meaning exactly what it meant before, and a grant only narrows once somebody
 * has actually unticked something on the access screen.
 */
export function moduleAllowed(
  key: string,
  granted: readonly string[],
  app: AppId,
): boolean {
  const forApp = granted.filter((g) => getModule(g)?.app === app);
  return forApp.length === 0 || forApp.includes(key);
}

/** Apps a grant can be made against, in registry order. */
export function grantableApps() {
  return APPS.filter((a) => modulesForApp(a.id).length > 0);
}
