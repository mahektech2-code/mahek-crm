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

const reports = (
  slug: string,
  label: string,
  group: string,
  note?: string,
): AppModule => ({
  key: `reports.${slug}`,
  app: "reports",
  label,
  group,
  href: `/reports/${slug}`,
  note,
});

const sales = (
  slug: string,
  label: string,
  group: string,
  note?: string,
): AppModule => ({
  key: `sales.${slug}`,
  app: "sales",
  label,
  group,
  href: `/sales/${slug}`,
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

const founder = (
  slug: string,
  label: string,
  group: string,
  note?: string,
): AppModule => ({
  key: `founder.${slug}`,
  app: "founder",
  label,
  group,
  href: `/founder/${slug}`,
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
  /*
   * A person's OWN score, and not a manager's screen.
   *
   * It is in the CRM rather than only in the Sales Dashboard because of the
   * fall-through rule: an account with no salesperson is carried by the back
   * office, so a telecaller holds real targets — and telecallers are
   * redirected out of `/sales` entirely. Without this they would be measured
   * on a number they had no way to read.
   */
  crm(
    "performance",
    "My Performance",
    "Targets & reporting",
    "Their own target and how the month is going against it. Not a manager's screen — everybody who carries customers has one.",
  ),
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

  /* ---------------------------------------------- the Sales Dashboard */
  /*
   * Twenty-four destinations in six groups, from `MBOS Manager Console.dc.html`.
   * The design's own grouping, in its own order and its own words — a nav
   * invented here would be a second information architecture competing with
   * the one somebody designed.
   *
   * They are separately grantable because they are separately sensitive: the
   * person who plans routes is not always the person who sees salaries, and
   * `app_module_access` is what lets that be true without a second app.
   */
  { key: "sales.today", app: "sales", label: "Today", group: "Overview", href: "/sales", exact: true },
  /*
   * Where every kind of request is actually decided.
   *
   * It is NOT in the design's sidebar, and that is right: the design splits
   * the queue across Orders, Leave, Expenses and Samples, so each screen shows
   * its own kind in context. Deciding still happens in one place, because the
   * rules are one set — a refusal needs a reason, a decision is made once —
   * and three copies of that is how one of them ends up more generous.
   *
   * Reached from those screens rather than from the nav, the same way
   * `crm.settings` is reached from the Help Center. It still needs a module, or
   * the route has nothing to guard against.
   */
  sales(
    "approvals",
    "Approvals",
    "Decisions",
    "Not in the sidebar — reached from Orders, Leave, Expenses and Samples, which is where each kind is seen in context.",
  ),
  sales("live", "Live map", "Overview", "Where every salesman is right now. GPS runs only while somebody is checked in."),
  sales("territory", "Territory", "Overview", "Which states, cities and beats belong to whom."),
  sales("performance", "Performance", "Overview", "Targets, achievement and the month against the one before it."),
  sales(
    "targets",
    "Sales Targets",
    "Decisions",
    "Setting what each person is asked for in a month, and publishing it to them. Withholding it leaves the month readable and unchangeable, which is the right shape for anybody who reviews performance without setting it.",
  ),

  sales("tasks", "Tasks", "Field work", "What each salesman has been asked to do, and what is overdue."),
  sales(
    "journeys",
    "Journey planning",
    "Field work",
    "Where each salesman walks. Withholding it leaves the handset's route screen empty, because nothing else writes a plan.",
  ),
  sales("visits", "Visits", "Field work", "Every visit logged, and which of them could not be verified."),
  sales("leads", "Leads", "Field work", "Shops that are not on the book yet."),

  sales("orders", "Orders", "Commercial", "Orders taken in the field, and the ones over a credit limit."),
  sales("payments", "Payments", "Commercial", "Money collected, and cash still in somebody's pocket."),
  sales("invoices", "Invoices", "Commercial", "What has been billed and what is overdue."),
  sales("samples", "Samples", "Commercial", "Samples out with customers, and the feedback nobody chased."),
  sales("catalogue", "Catalogue & rates", "Commercial", "What is sold and at what price."),

  sales("attendance", "Attendance", "People", "Who started the day, when, and from where."),
  sales("leave", "Leave", "People", "Requests waiting on a decision, and the policy behind them."),
  sales("holidays", "Holidays", "People", "The days nobody is expected to work."),
  sales("salary", "Salary", "People", "Pay, incentive and deductions. Granted deliberately."),
  sales("expenses", "Expenses & claims", "People", "What the field spent, and what it is owed back."),

  sales("documents", "Documents", "Enablement", "Price lists, policies and certificates the handset can open."),
  sales("knowledge", "Knowledge", "Enablement", "Training a salesman is expected to have done."),

  sales("people", "Salesmen", "Administration", "Every salesman's own record — visits, orders, money, hours, leave."),
  sales("prefs", "App preferences", "Administration", "The thresholds every handset reads."),
  sales("logins", "Login history", "Administration", "Who signed in, from which handset, and what failed."),
  sales("audit", "Audit trail", "Administration", "Every decision made here, with a name against it."),

  /* -------------------------------------------------------------- the HRMS */
  {
    key: "hrms.org",
    app: "hrms",
    label: "Org Chart",
    group: "Employees",
    href: "/hrms/org",
    note: "Who reports to whom, and the only screen that can change it. Withholding it leaves the chart readable nowhere rather than read-only — there is no other view of it.",
  },
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
  /* ------------------------------------------------------------- Reports */
  /*
   * The owner's five, and the three screens behind them.
   *
   * Modules rather than one screen because the four questions are held by
   * different people in practice: whoever chases lead generation is not always
   * whoever is answerable for retention, and `app_module_access` is what lets
   * that be true without a second app. The overview is deliberately its own
   * module too — somebody can be given the headline figures without the
   * customer-by-customer lists underneath them.
   */
  { key: "reports.overview", app: "reports", label: "Overview", group: "The five", href: "/reports", exact: true },
  reports(
    "leads",
    "Leads & conversion",
    "The five",
    "Where new business comes from and what became of it, by cohort. Withholding it leaves the overview's first two figures with nowhere to click.",
  ),
  reports(
    "sales",
    "Bill size & frequency",
    "The five",
    "What an average order is worth and how often one comes.",
  ),
  reports(
    "customers",
    "Customer health",
    "The five",
    "Active, at risk, dormant and lost, and who moved between them. The list behind it names customers, their salesperson and what they owe.",
  ),

  /* --------------------------------------------------- the Founder Dashboard */
  /*
   * Five modules for one reason: whoever reads company revenue is not always
   * whoever reads the roster, and `app_module_access` is what lets that be
   * true without a second app. The overview is its own module too, so the
   * headline can be given without the four screens behind it.
   */
  { key: "founder.overview", app: "founder", label: "Overview", group: "Company", href: "/founder", exact: true },
  founder(
    "team",
    "Team performance",
    "Company",
    "Everybody scored — telecallers and the field team together, ranked. Withholding it leaves the overview's headline with nowhere to click.",
  ),
  founder(
    "money",
    "Money",
    "Company",
    "What is outstanding, what is waiting on a decision, and what has been collected.",
  ),
  founder(
    "people",
    "People",
    "Company",
    "Headcount, by office and department. Not attendance — see HRMS's own note on that.",
  ),
  founder(
    "crm",
    "CRM",
    "Company",
    "The order book's own five, with links into the Reports app for the full breakdown.",
  ),
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

/**
 * The review table renders in sections, in the order the sidebar draws them.
 *
 * ONE SECTION PER GROUP NAME, not one per run of them. This used to merge only
 * ADJACENT modules, which is the same thing right up until somebody inserts a
 * module in the middle of a run — and `sales.approvals` is exactly that: it is
 * deliberately not in the sidebar, so it was written next to Today where the
 * comment explaining it belongs, and it split Overview in half. The table drew
 * OVERVIEW, then DECISIONS, then OVERVIEW again, and React was handed two
 * children keyed "Overview".
 *
 * The order is first appearance, so the sidebar's order still decides the
 * sections. What changes is only that a group is whole wherever its members
 * were written.
 */
export function moduleGroupsForApp(app: AppId): Array<{ group: string; modules: AppModule[] }> {
  const out: Array<{ group: string; modules: AppModule[] }> = [];
  const at = new Map<string, { group: string; modules: AppModule[] }>();
  for (const m of modulesForApp(app)) {
    const existing = at.get(m.group);
    if (existing) {
      existing.modules.push(m);
      continue;
    }
    const fresh = { group: m.group, modules: [m] };
    at.set(m.group, fresh);
    out.push(fresh);
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
