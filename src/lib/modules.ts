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

const enquiries = (
  slug: string,
  label: string,
  group: string,
  note?: string,
): AppModule => ({
  key: `enquiries.${slug}`,
  app: "enquiries",
  label,
  group,
  href: `/enquiries/${slug}`,
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
  /*
   * DAILY CALLING, and no longer a group of its own.
   *
   * "Communication" held exactly this one module, and a heading that opens a
   * single row spends a row to save none — see the note in
   * `components/shell/nav.ts`. It belongs here on its own merits rather than
   * for tidiness: a message to a customer is the same day's work as a call to
   * one, and the WhatsApp screen is worked from the same queue.
   *
   * It has to sit BESIDE its group rather than keep its old position, because
   * `moduleGroupsForApp` returns runs and the Access screen keys its sections
   * on the group name — a group appearing twice hands React two children with
   * the same key and draws the heading twice with something else wedged
   * between them. There is a test for exactly that.
   */
  crm("whatsapp", "WhatsApp", "Daily calling"),
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
  crm(
    "price-lists",
    "Price lists",
    "Customer records",
    "What each customer pays: the lists in force, the one that applies to a shop and why, and a special price asked for on a call. Reading is every telecaller's; importing, publishing and scoping need the manage capability.",
  ),
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

  /* ------------------------------- Lead Management, the same ten, in the CRM
   *
   * THE FUNNEL IS NOT THE FIELD TEAM'S ALONE, which is why these exist twice.
   *
   * The Manager Console built the workspace and the telecallers were left out
   * of it by an accident of where it was mounted: `/sales` redirects anybody
   * without the Sales Dashboard, and a telecaller does not hold it. So the
   * people who ring leads all day had a Call Log and no funnel, while the
   * funnel had ten screens and no telephone.
   *
   * What is duplicated is the GRANT and nothing else. One set of screens, one
   * set of services, one set of engines and one set of actions — see
   * `lib/lead-workspace.ts`, which is the single list both sidebars draw and
   * both route guards match. A second lead system inside the CRM would be
   * twenty thousand lines of the same rules drifting from these.
   *
   * They are separate KEYS because a grant is per app: `app_module_access` is
   * a row per user per module, and a telecaller given the funnel in the CRM
   * must not thereby be given the Sales Dashboard's copy of it, which sits in
   * an app they cannot open at all. It is the same shape as `accounts.targets`
   * beside `sales.targets` — one feature, two doors, two grants.
   *
   * WHAT DIFFERS BETWEEN THE TWO MOUNTS IS SCOPE, and nothing here says so
   * because nothing here has to. `resolveScope` reads the grant for the app
   * named on the request, so the same screen narrows to a telecaller's own
   * book under `/crm` and to a manager's team under `/sales` — and the write
   * side needed no change at all, because `lead.work` is held by any associate
   * rather than by an app.
   *
   * `crm.samples` is `/crm/samples` rather than a route under `leads/`, which
   * mirrors the console exactly: a sample is a thing that happens TO a lead and
   * is worked from its own desk, and the two apps disagreeing about where it
   * lives would make `lib/lead-workspace.ts` impossible to write as one list.
   */
  {
    key: "crm.leads",
    app: "crm",
    label: "All Leads",
    group: "Lead Management",
    href: "/crm/leads",
    exact: true,
    note:
      "The book itself — every lead, its rung, what its gate is waiting on, and the record behind each one. Narrowed to this person's own book unless they are a manager.",
  },
  {
    key: "crm.lead-funnel",
    app: "crm",
    label: "Funnel & conversion",
    group: "Lead Management",
    href: "/crm/leads/funnel",
    note: "The three ladders drawn as funnels, where business comes from, and what the four reason codes say about what we lose. A reading screen — it writes nothing but a source rename.",
  },
  {
    key: "crm.lead-intake",
    app: "crm",
    label: "Intake",
    group: "Lead Management",
    href: "/crm/leads/intake",
    note: "Raising a lead at a desk, in bulk from a file, and the duplicate pairs a book fed by a website form, a handset and a spreadsheet keeps producing. The telecaller's own door into the funnel.",
  },
  {
    key: "crm.lead-qualify",
    app: "crm",
    label: "Qualification",
    group: "Lead Management",
    href: "/crm/leads/qualify",
    note: "Everything between a Suspect and a qualified Prospect: the visit cap's decisions, the verification queue, the validation calls behind them, and what each lead's gate is still missing.",
  },
  crm(
    "samples",
    "Samples & trials",
    "Lead Management",
    "Samples out with customers, the desk that approves and dispatches them, the review nobody chased, and the seven answers a trial produces.",
  ),
  {
    key: "crm.lead-commercial",
    app: "crm",
    label: "Commercial",
    group: "Lead Management",
    href: "/crm/leads/commercial",
    note: "Negotiation, the commitments that are forecasts rather than sales, and the first order that converts an account. Renders order status and never writes it.",
  },
  {
    key: "crm.lead-appointments",
    app: "crm",
    label: "Distributor appointments",
    group: "Lead Management",
    href: "/crm/leads/appointments",
    note: "The two-step chain that appoints a distributor. Deciding needs distributor.approve, which is management's; the queue is readable without it.",
  },
  {
    key: "crm.lead-actions",
    app: "crm",
    label: "Next actions & nurture",
    group: "Lead Management",
    href: "/crm/leads/actions",
    note: "What is owed on every active lead, what is overdue, what has nothing scheduled at all, and the fifteen-row nurture sequence behind it.",
  },
  {
    key: "crm.lead-handovers",
    app: "crm",
    label: "Handovers",
    group: "Lead Management",
    href: "/crm/leads/handovers",
    note: "Converted accounts still waiting on a relationship owner. Its own key because a handover moves who RUNS an account — sight, never a rupee — and that is held deliberately.",
  },
  {
    key: "crm.lead-oversight",
    app: "crm",
    label: "Oversight",
    group: "Lead Management",
    href: "/crm/leads/oversight",
    note: "Every gate somebody passed and what was missing when they did, the funnel's own audit trail, and the thresholds in force. Reading who overrode what is a different job from working the book.",
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
  accounts(
    "targets",
    "Sales targets",
    "Accounts",
    "Setting what each person is asked for in a month, publishing it, and revising it with a reason. Accounts assign and manage targets here; a manager keeps the same screen in the Sales Dashboard and can act on a shortfall directly.",
  ),
  accounts(
    "customer-targets",
    "Customer targets",
    "Accounts",
    "A rupee quota per customer per month — the same screen the CRM's own Monthly Targets reaches, from a second door. Where a person's target asks what they should sell overall, this asks what one account should buy.",
  ),
  accounts("record", "Record a payment", "Money"),
  accounts(
    "payment-history",
    "Payment history",
    "Money",
    "Every payment recorded or decided on, across every customer — the record a busy day of collections is checked against.",
  ),
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
  sales(
    "activity-history",
    "Activity history",
    "Field work",
    "Field salesman visits and calls from before this app existed, imported from a prior system's own log — including the shop names that still need matching to a real account.",
  ),
  sales("orders", "Orders", "Commercial", "Orders taken in the field, and the ones over a credit limit."),
  sales("payments", "Payments", "Commercial", "Money collected, and cash still in somebody's pocket."),
  sales("invoices", "Invoices", "Commercial", "What has been billed and what is overdue."),
  sales("catalogue", "Catalogue & rates", "Commercial", "What is sold and at what price."),
  sales(
    "price-lists",
    "Price lists",
    "Commercial",
    "Mahek's price lists end to end: import a PDF, review what it read, publish, say who it applies to, compare months, and see who is billed off-list.",
  ),

  /* ------------------------------------------------- Lead Management, the ten
   *
   * The funnel's engines, services and actions have existed since the lead
   * funnel landed; what did not exist was anywhere to work in them. Nine
   * screens sat behind two keys — `sales.leads` and `sales.samples` — inside a
   * sidebar built for the field team, and a person whose whole job is the
   * funnel had no front door.
   *
   * TEN destinations, not the twenty-three the surface actually has. The ones
   * left out are not missing, they are TABS, and the difference is the rule
   * this file already states: a module is a destination in an app's
   * NAVIGATION. "Suspect decisions" and "Verification queue" are one question
   * asked of two populations, so they are two tabs of Qualification and one
   * grant; splitting them would put four near-identical rows in front of
   * somebody scanning for one, and would make "can she work the funnel" a
   * twenty-three-part answer nobody could hold in their head at the access
   * screen.
   *
   * What that costs is worth naming rather than discovering: a tab cannot be
   * withheld on its own, so somebody given Qualification is given all four of
   * its tabs. The ten were chosen so that is never the wrong answer — each is
   * a job somebody holds whole — and the two that genuinely are separately
   * sensitive are their own keys for exactly that reason rather than folded
   * into a neighbour: Handovers moves who RUNS an account, and Oversight is
   * the override log and the audit trail, which is a different job from
   * working the book.
   *
   * `sales.leads` and `sales.samples` keep their KEYS and change only their
   * group and their label. A key is a join and renaming one silently revokes
   * it from everybody holding it; a group is cosmetic. The other eight are
   * new, and `0136_lead_management_modules.sql` grants them to every grant
   * already narrowed to `sales.leads` — three routes guarded by that key today
   * move to new ones, and would otherwise vanish on deploy day for exactly the
   * people already using them.
   */
  {
    key: "sales.leads",
    app: "sales",
    label: "All Leads",
    group: "Lead Management",
    href: "/sales/leads",
    exact: true,
    note:
      "The book itself — every lead, its rung, what its gate is waiting on, and the record behind each one. Without it there is no funnel to work.",
  },
  {
    key: "sales.lead-funnel",
    app: "sales",
    label: "Funnel & conversion",
    group: "Lead Management",
    href: "/sales/leads/funnel",
    note: "The three ladders drawn as funnels, where business comes from, and what the four reason codes say about what we lose. A reading screen — it writes nothing but a source rename.",
  },
  {
    key: "sales.lead-intake",
    app: "sales",
    label: "Intake",
    group: "Lead Management",
    href: "/sales/leads/intake",
    note: "Raising a lead at a desk, in bulk from a file, and the duplicate pairs a book fed by a website form, a handset and a spreadsheet keeps producing.",
  },
  {
    key: "sales.lead-qualify",
    app: "sales",
    label: "Qualification",
    group: "Lead Management",
    href: "/sales/leads/qualify",
    note: "Everything between a Suspect and a qualified Prospect: the visit cap's decisions, the verification queue, the validation calls behind them, and what each lead's gate is still missing.",
  },
  sales(
    "samples",
    "Samples & trials",
    "Lead Management",
    "Samples out with customers, the desk that approves and dispatches them, the review nobody chased, and the seven answers a trial produces.",
  ),
  {
    key: "sales.lead-commercial",
    app: "sales",
    label: "Commercial",
    group: "Lead Management",
    href: "/sales/leads/commercial",
    note: "Negotiation, the commitments that are forecasts rather than sales, and the first order that converts an account. Renders order status and never writes it.",
  },
  {
    key: "sales.lead-appointments",
    app: "sales",
    label: "Distributor appointments",
    group: "Lead Management",
    href: "/sales/leads/appointments",
    note: "The two-step chain that appoints a distributor. Deciding needs distributor.approve, which is management's; the queue is readable without it.",
  },
  {
    key: "sales.lead-actions",
    app: "sales",
    label: "Next actions & nurture",
    group: "Lead Management",
    href: "/sales/leads/actions",
    note: "What is owed on every active lead, what is overdue, what has nothing scheduled at all, and the fifteen-row nurture sequence behind it.",
  },
  {
    key: "sales.lead-handovers",
    app: "sales",
    label: "Handovers",
    group: "Lead Management",
    href: "/sales/leads/handovers",
    note: "Converted accounts still waiting on a relationship owner. Its own key because a handover moves who RUNS an account — sight, never a rupee — and that is held deliberately.",
  },
  {
    key: "sales.lead-oversight",
    app: "sales",
    label: "Oversight",
    group: "Lead Management",
    href: "/sales/leads/oversight",
    note: "Every gate somebody passed and what was missing when they did, the funnel's own audit trail, and the thresholds in force. Reading who overrode what is a different job from working the book.",
  },

  sales("attendance", "Attendance", "People", "Who started the day, when, and from where."),
  sales("leave", "Leave", "People", "Requests waiting on a decision, and the policy behind them."),
  sales("holidays", "Holidays", "People", "The days nobody is expected to work."),
  sales("salary", "Salary", "People", "Pay, incentive and deductions. Granted deliberately."),
  sales("expenses", "Expenses & claims", "People", "What the field spent, and what it is owed back."),
  sales(
    "travel",
    "Travel ledger",
    "Field work",
    "Every movement, with the odometer, the day's GPS track and anything typed by hand side by side — which is the only way to see that a leg read 60 km on a dial and 6 km on the phone.",
  ),
  sales(
    "exceptions",
    "Expense exceptions",
    "People",
    "Claims outside policy, distances that do not agree and spending unlike anything this person usually does. Questions rather than refusals — the money is already spent.",
  ),
  sales(
    "expense-policy",
    "Expense policy",
    "People",
    "Which rules are in force, from when, and who they apply to. Read-only: a policy is authored in the Admin Console, because a manager writing the rules for what their own team's travelling may cost is the conflict order approval exists to avoid.",
  ),
  sales(
    "roi",
    "Cost & return",
    "Overview",
    "Sales per kilometre, per visit, travel as a share of sales, and what each salesman costs against what he brought in. Revenue rather than margin — MahekOne holds no product costs.",
  ),

  sales("documents", "Documents", "Enablement", "Price lists, policies and certificates the handset can open."),
  sales("knowledge", "Knowledge", "Enablement", "Training a salesman is expected to have done."),

  sales("people", "Salesmen", "Administration", "Every salesman's own record — visits, orders, money, hours, leave."),
  sales("prefs", "App preferences", "Administration", "The thresholds every handset reads."),
  sales("logins", "Login history", "Administration", "Who signed in, from which handset, and what failed."),
  sales("sync-health", "Sync health", "Administration", "Whose handset has gone quiet, and whose last pushes were refused."),
  sales("notify", "Send a notification", "Administration", "A message to one salesman, a few, or the whole team — in-app and pushed."),
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

  /* ------------------------------------------------------ §M, the field's cost */
  reports(
    "expenses",
    "Field cost & exceptions",
    "The five",
    "What the sales team costs a month, broken down, against what it brought in — with only the exceptions that need somebody, and the trend behind both. Revenue rather than margin, because MahekOne holds no product costs.",
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

  /* -------------------------------------------------- the Website Enquiries app */
  /*
   * Two modules: the pipeline at a glance, and the worklist behind it. Its own
   * app rather than a screen inside the CRM, Accounts or HRMS — Sales, Accounts
   * and HR each work enquiries that belong to their own team, and a shared
   * workspace granted separately is what lets somebody hold it without also
   * holding whichever of those three apps happens to be nearby.
   */
  { key: "enquiries.overview", app: "enquiries", label: "Overview", group: "Website Enquiries", href: "/enquiries", exact: true },
  enquiries(
    "list",
    "Enquiries",
    "Website Enquiries",
    "The worklist itself — every enquiry, who it is assigned to, and what it is waiting on.",
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
