import { APPS, type AppId } from "./apps";
import { ERP_ALWAYS_OPEN, ERP_GROUPS, erpHref } from "./erp/registry";
import { HRMS_ALWAYS_OPEN, HRMS_GROUPS, hrmsHref } from "./hrms/registry";

/** What withholding an HRMS screen means, where it is not obvious. */
const HRMS_NOTES: Record<string, string> = {
  org: "Who reports to whom, and the only screen that can change it. Withholding it leaves the chart readable nowhere rather than read-only — there is no other view of it.",
  employees: "The directory, ID cards and working hours. Salaries and identity numbers stay behind their own powers.",
  payroll: "Salaries, advances and expenses. Payroll holders see everyone's; everyone else sees only their own.",
  home: "Checking in. Everybody who holds HRMS reaches it whatever else they were narrowed to.",
};

/** A screen's tabs, said on the Access screen so a grant names what it opens. */
const hrmsTabsNote = (sc: (typeof HRMS_GROUPS)[number]["screens"][number]) =>
  sc.views && sc.views.length > 1 ? `Tabs: ${sc.views.map((v) => v.label).join(", ")}.` : "";

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
  /**
   * NOT PART OF "THE WHOLE APP" WHEN SOMEBODY IS GIVEN IT.
   *
   * Every module of an app is ticked by default and a grant with all of them
   * ticked stores no rows, which is what makes a new screen reach everybody
   * who holds the whole app. That is the right default for a screen everybody
   * in the app works, and the wrong one for a desk that belongs to particular
   * people: the calling desk is worked by the telecaller and overseen by the
   * administrator, and every other CRM user reaching it by holding the whole
   * app would be the accident the module exists to prevent.
   *
   * It changes the DEFAULT the Access screen starts from and nothing else —
   * `moduleAllowed`, the guard and the storage are the same rules they always
   * were, so this adds no second permission mechanism. Somebody holding the
   * app with no module rows still holds every module, this one included, which
   * is what a grant from a terminal has always meant.
   */
  offByDefault?: boolean;
  /**
   * NEVER IMPLIED — not by a whole-app grant, not by holding the app as an
   * administrator. `offByDefault` answers "does a blanket grant reach this",
   * and its own doc above says the honest thing about it: a whole-app grant
   * with no module rows still holds every module, this one included, and an
   * administrator holds every `offByDefault` module regardless of rows. Both
   * are exactly right for a desk like Calling desk, which an administrator
   * hands out and must therefore be able to see and use without asking anybody.
   *
   * Sales Manager is a different shape: it is a SEAT, not a desk somebody
   * oversees, and it must be answerable on its own — "does this person carry
   * the Sales Manager view" — without that answer moving the day somebody's
   * account is made an administrator, or the day a whole-app grant with no
   * rows is issued from a terminal that has never heard of modules. A module
   * marked `explicitOnly` is granted if and only if its own key is one of the
   * rows stored for that person, full stop: no "zero rows means everything",
   * no administrator bypass. `moduleAllowed` checks this FIRST, ahead of
   * either of those rules, and every other reader of it — `listUserModules`,
   * the Access screen's own `buildGrants`, the route guard — inherits it for
   * free because none of them re-derive the rule, they ask this function.
   *
   * Always paired with `offByDefault: true` here: `moduleAllowed` does not
   * need that flag once `explicitOnly` is set, but `DEFAULT_OF` on the Access
   * screen — what "grant the whole app" writes when the app's own box is
   * first ticked — reads `offByDefault` alone, and a module missing it would
   * be swept into that bulk grant the same way this whole feature exists to
   * prevent.
   */
  explicitOnly?: boolean;
  /**
   * NOT A DESTINATION: THE WRITE HALF OF THE MODULE NAMED HERE.
   *
   * Some screens are worth handing out to read alone. WhatsApp is the first —
   * somebody in accounts reading what a customer wrote about a payment is one
   * job, answering them from the business number is another — so the module
   * that opens the screen is the READ grant, and this companion is the WRITE
   * grant beside it: replying, sending, runs, templates, groups.
   *
   * It is stored, diffed, audited and defaulted exactly like any other module,
   * which is the point of making it one: "no rows means every module" makes a
   * whole-app grant read AND write, so nothing anybody already held moved, and
   * read-only is a grant somebody narrowed on purpose. It has no route of its
   * own — `moduleForPath` never answers with it and the sidebar never draws it
   * (its href is its parent's, so it adds nothing to the set the sidebar
   * filters by) — and the Access screen draws it as Read / Write on the
   * parent's row rather than as a checkbox of its own.
   */
  writeOf?: string;
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

/** A Command Centre section, addressed `/founder?s=<section>`. */
const cc = (
  slug: string,
  section: string,
  label: string,
  group: string,
  note?: string,
): AppModule => ({
  key: `founder.${slug}`,
  app: "founder",
  label,
  group,
  href: `/founder?s=${section}`,
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

const website = (
  slug: string,
  label: string,
  group: string,
  note?: string,
): AppModule => ({
  key: `website.${slug}`,
  app: "website",
  label,
  group,
  href: `/website/${slug}`,
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
  crm(
    "opportunities",
    "Opportunities",
    "Daily calling",
    "What customers' calls turned up that somebody may buy — to be worked, not only read.",
  ),
  crm("payments", "Payment Follow-up", "Collections", "Chasing money owed. A telecaller who only sells does not need it."),
  /*
   * COLLECTIONS, after Payment Follow-up. It sat under Daily calling, on the
   * reasoning that a message is the same day's work as a call; in practice
   * almost everything on it is payment reminders and the customers' answers
   * to them, so it lives with the chasing. The key never moves — a grant
   * points at `crm.whatsapp` — only the heading it is drawn under.
   */
  crm("whatsapp", "WhatsApp", "Collections", "Reading the chats. Replying and sending is the Write level beside it."),
  {
    key: "crm.whatsapp-reply",
    app: "crm",
    label: "WhatsApp — reply and send",
    group: "Collections",
    href: "/crm/whatsapp",
    writeOf: "crm.whatsapp",
  },
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
  /*
   * THE CALLING DESK IS THE CRM'S ALONE — there is no counterpart under the
   * Sales Dashboard — and it is a module of its own rather than a tab of All
   * Leads. A tab cannot be withheld, so the desk was open to everybody who
   * could open the lead list, which is every CRM user. The Access screen is
   * where it is granted, to a person, and `offByDefault` keeps a grant of the
   * whole CRM from carrying it along.
   *
   * It is not one of `LEAD_SECTIONS`: those are the workspace both apps mount
   * from one list, and this is drawn from the CRM's own sidebar.
   */
  {
    key: "crm.lead-calling-desk",
    app: "crm",
    label: "Calling desk",
    group: "Lead Management",
    href: "/crm/leads/calling-desk",
    offByDefault: true,
    note:
      "The telecaller's desk: online leads qualified by phone in up to three calls, then requested as a Prospect. Off by default — grant it to the people who work the desk. Withholding it removes the screen and the actions behind it; the lead list and every other Lead Management screen are unaffected.",
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
  /**
   * The CRM's OWN Sales Manager seat — a module of its own, named the same as
   * `sales.lead-pipeline` on the Sales Dashboard on purpose: both answer to
   * the same job title, held by different people through different apps. This
   * one carries no Sales Dashboard screen and no read of `sales.lead-pipeline`
   * — a CRM grant here says nothing about that one, and the reverse.
   *
   * `offByDefault` for the reason `crm.lead-calling-desk` is: a manager-tier
   * seat is granted a person at a time, not handed to every CRM user the
   * moment the whole app is.
   */
  {
    key: "crm.sales-manager",
    app: "crm",
    label: "Sales Manager",
    group: "Lead Management",
    href: "/crm/leads/sales-manager",
    offByDefault: true,
    /* NOT `explicitOnly`, deliberately, though `sales.lead-pipeline` is. A
       whole-CRM grant with no rows still reaches this screen — and that is
       safe because the workspace's own scope is the seat: it shows, and lets
       somebody act on, only leads whose `sales_manager_id` is them. A
       telecaller reaching it sees an empty pipeline. Making it explicit would
       silently take it away from every sales manager on a whole-CRM grant on
       the day it shipped, with nothing on any screen saying why. */
    note:
      "The CRM's own Sales Manager seat. Off by default on a narrowed CRM grant; it only ever shows leads where this person is the named sales manager. Independent of any Sales Dashboard access.",
  },
  /**
   * A CENTRAL RECORD OF EVERY LEAD CLOSED LOST, off `crm.leads` for the same
   * reason the calling desk sits off it: a lead can be lost from any rung of
   * any ladder, so this is not a cut of one stage's worklist — it is its own
   * question ("what did we lose, and why") asked of the whole book, and a tab
   * of All Leads could not be withheld from anybody who can open that screen.
   *
   * `offByDefault` for the reason the desk and the Sales Manager seat both
   * are: a loss report is not everybody's to read, and a whole-CRM grant must
   * not carry it to every telecaller by accident. No Sales Dashboard
   * counterpart — that funnel is walked by field salesmen through MBOS, and a
   * lead lost there is read from the same `customers`/`lead_stage_transitions`
   * rows this reads, with no second screen needed yet.
   */
  {
    key: "crm.lead-lost",
    app: "crm",
    label: "Lost",
    group: "Lead Management",
    href: "/crm/leads/lost",
    offByDefault: true,
    note:
      "Every lead closed lost, whatever rung it was lost from, with the reason and who decided it. Off by default — grant it to whoever reviews what the funnel loses.",
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
  accounts("order-changes", "Order changes", "Decisions", "Accepting or declining a change a salesman asked for on an order already approved."),
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
  accounts(
    "price-lists",
    "Price lists",
    "Accounts",
    "Mahek's price lists end to end — create, duplicate, import PDFs in bulk, review what they read, publish, export, and say who each applies to. THE DESK THAT ISSUES THESE LISTS IS THIS ONE: `pricelist.manage` is the Price Desk's (Accounts and the Founder Command Centre), and the CRM and Sales Dashboard doors are read-only.",
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
  accounts(
    "cash-flow",
    "Cash flow",
    "Money",
    "Money in and money out, day by day. Out: what Mahek owes its suppliers and the payment day each is planned for — the ERP purchase register and anything added by hand, with their invoices. In: when each open bill is expected, from how that customer actually pays.",
  ),
  /*
   * The CRM's WhatsApp screen, opened from the ledger desk. It reads the same
   * conversations through the Accounts scope, which is every book — a
   * customer answering a payment reminder is accounts' business whoever's
   * customer they are.
   */
  accounts(
    "whatsapp",
    "WhatsApp",
    "Money",
    "Every customer's chats. Replying and sending is the Write level beside it.",
  ),
  {
    key: "accounts.whatsapp-reply",
    app: "accounts",
    label: "WhatsApp — reply and send",
    group: "Money",
    href: "/accounts/whatsapp",
    writeOf: "accounts.whatsapp",
  },
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
  /* Visits used to be a module of its own. It is a tab of this one now —
     the plan and the visits it produced are one story, allocated against
     visited — and `0213_sales_visits_into_journeys` moved every grant that
     named it here. */
  sales(
    "journeys",
    "Journeys & visits",
    "Field work",
    "Where each salesman walks and what came of it: proposed, agreed and walked days, the shops allocated against the shops visited, and every visit logged with which could not be verified. Withholding it leaves the handset's route screen empty, because nothing else writes a plan.",
  ),
  sales(
    "field-reports",
    "Field reports",
    "Field work",
    "Complaints, competitor intelligence, internal notes, tours and order changes salesmen file from the shops.",
  ),
  sales(
    "activity-history",
    "Activity history",
    "Field work",
    "Field salesman visits and calls from before this app existed, imported from a prior system's own log — including the shop names that still need matching to a real account.",
  ),
  sales("orders", "Orders", "Commercial", "Orders taken in the field, and the ones over a credit limit."),
  sales("payments", "Payments", "Commercial", "Money collected, and cash still in somebody's pocket."),
  sales("invoices", "Invoices", "Commercial", "What has been billed and what is overdue."),

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
  /**
   * The Sales Manager workspace, `/sales-lead-pipeline` — its own module and
   * its own lock, deliberately separate from `sales.leads` above it.
   *
   * It used to ride on `sales.leads`: the two screens read the same book, so
   * sharing the key seemed harmless, and the Access screen never grew a
   * checkbox for it as a result. That made it ungrantable and unrevokable on
   * its own — an admin wanting to hand somebody the Sales Manager workspace
   * without also handing them the plain All Leads screen (or the reverse) had
   * no way to say so, and the screen answered a question nobody could ask it:
   * why is there no "Sales Manager" box to tick. `crm.lead-calling-desk` is
   * the model this follows.
   *
   * `offByDefault` alone was tried first and is not enough, which is the whole
   * reason `explicitOnly` exists: without it, an administrator on this app
   * holds every `offByDefault` module regardless of rows, and a whole-app
   * grant with no module rows at all — the shape `npm run app:grant` and the
   * provisioning endpoint both write, knowing nothing of modules — holds every
   * module whatsoever, `offByDefault` or not. Production carried exactly this
   * account: an admin-level Sales Dashboard grant with zero module rows, which
   * `offByDefault` on its own would have opened this workspace to regardless.
   * `explicitOnly` closes both doors — see its doc on `AppModule` — so this is
   * the one module on this app answerable to nothing but its own row: an
   * administrator sees an unticked "Sales Manager" box exactly like anybody
   * else, and ticks it the same way Poonam is granted Calling desk, a person
   * at a time, on purpose.
   */
  {
    key: "sales.lead-pipeline",
    app: "sales",
    label: "Sales Manager",
    group: "Lead Management",
    href: "/sales-lead-pipeline",
    offByDefault: true,
    explicitOnly: true,
    note:
      "The Sales Manager's own workspace: dashboard, funnel and record in one flow, working the same book All Leads does. Granted one person at a time — holding the whole Sales Dashboard, even as an administrator, does not carry this on its own. Withholding it leaves All Leads and every other Lead Management screen untouched.",
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
  sales("expenses", "Expenses", "People", "Every expense a salesman logs, to approve, and the ledger of what each was claimed, allowed, refused and paid."),
  sales(
    "travel",
    "Travel ledger",
    "Field work",
    "Every movement, with the odometer, the day's GPS track and anything typed by hand side by side — which is the only way to see that a leg read 60 km on a dial and 6 km on the phone.",
  ),
  sales(
    "exceptions",
    "Flagged expenses",
    "People",
    "Claims the policy flagged for a second look — a missing bill, an amount over the limit, distances that do not agree.",
  ),
  sales(
    "expense-policy",
    "Expense policy",
    "People",
    "What a salesman is paid back for travel, meals, hotels and bills. Read-only.",
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

  /* -------------------------------------------------------------- the HRMS
   * One module per HRMS screen, read off its own registry so the sidebar,
   * this guard and the access screen cannot disagree. Home is the app root
   * and matched exactly, or it would swallow every /hrms/* path. The two
   * keys that existed before the rebuild — `hrms.employees` and `hrms.org` —
   * keep their keys, so every grant that named them means what it meant. */
  ...HRMS_GROUPS.flatMap((g) =>
    g.screens.map(
      (sc): AppModule => ({
        key: `hrms.${sc.key}`,
        app: "hrms",
        label: sc.label,
        group: `HRMS · ${g.label}`,
        href: hrmsHref(sc),
        exact: sc.slug === "",
        ...(HRMS_NOTES[sc.key] || hrmsTabsNote(sc) ? { note: [HRMS_NOTES[sc.key], hrmsTabsNote(sc)].filter(Boolean).join(" ") } : {}),
      }),
    ),
  ),

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

  /* ------------------------------------------- apps with no screens of their own
   *
   * None of these is an app "not built yet", which is what this heading
   * used to say. They are the apps that have NO web screen and never
   * will, and each keeps exactly one module for one reason: an app is granted
   * if and only if at least one of its modules is ticked, so an app with none
   * could not be granted, kept or taken away on the Access screen at all.
   *
   * `field` is MBOS, the handset. Its one module is the grant itself — "may
   * this person sign in on the phone" — and it points at NO path: it used to
   * be `/field`, a route that only ever said "not built yet" and is gone, so
   * an href there named a page that does not exist. The empty, exact href
   * matches nothing, which is the honest answer to "which screen is this".
   *
   * `people` is retired into HRMS. Its module stays so somebody still holding
   * the old grant can have it taken away; it is never offered to anybody new.
   *
   * `reports.home` is the same as `people.home`: the Reports app was retired
   * into the Founder Command Centre, and its one module stays for the same
   * reason.
   */
  {
    key: "field.home",
    app: "field",
    label: "Mobile sign-in",
    group: "App",
    href: "",
    exact: true,
    note: "Signing in on the MBOS handset. There is no web screen behind it: granting the Salesman App gives a phone a way in and the browser nothing to show.",
  },
  {
    key: "people.home",
    app: "people",
    label: "Attendance & People (retired)",
    group: "App",
    href: "/people",
    note: "Retired into HRMS. Kept only so a grant somebody still holds can be taken away.",
  },
  {
    key: "reports.home",
    app: "reports",
    label: "Reports (retired)",
    group: "App",
    href: "/reports",
    note: "Retired into the Founder Command Centre. Kept only so a grant somebody still holds can be taken away.",
  },

  /* --------------------------------------------------- the Founder Dashboard */
  /*
   * Five modules for one reason: whoever reads company revenue is not always
   * whoever reads the roster, and `app_module_access` is what lets that be
   * true without a second app. The overview is its own module too, so the
   * headline can be given without the four screens behind it.
   */
  /*
   * THE FOUNDER COMMAND CENTRE. One module per section (PRD §5.5). The seven
   * keys that existed before it are KEPT — a module key is stored in grants and
   * renaming one silently revokes it — even where the section behind it grew:
   * `founder.crm` opens Sales & order book. Sections are addressed `?s=` on
   * `/founder`; Price lists and WhatsApp keep their own desk pages as well.
   */
  { key: "founder.overview", app: "founder", label: "Company", group: "Today", href: "/founder", exact: true },
  cc("inbox", "inbox", "Needs you", "Today", "Every decision waiting on the founder, every alarm, and what was handed on."),
  cc("crm", "sales", "Sales & order book", "Sell", "Every order from every source, and deciding them."),
  cc("team", "team", "Targets & performance", "Sell", "Setting and revising targets; everyone scored, ranked and explained."),
  cc("customers", "customers", "Customers", "Sell", "Every customer and lead, the full record, and every change to an account."),
  cc("leads", "leads", "Leads, samples & distributors", "Sell", "The three ladders, gates, samples and distributor appointments."),
  cc("enquiries", "enquiries", "Website enquiries", "Sell", "The enquiries desk end to end."),
  cc("calling", "calling", "Calling operations", "Operate", "The telecallers' day: queues, calls, reminders, EOD and the call assistant."),
  cc("field", "field", "Field force", "Operate", "Where they are, attendance, visits, travel, expenses, leave and devices."),
  cc("service", "service", "Service", "Operate", "Complaints end to end."),
  cc("money", "money", "Money", "Operate", "Bills, receipts, outstanding, collections and credit notes — the whole accounts desk."),
  founder(
    "price-lists",
    "Price lists",
    "Founder desks",
    "Mahek's price lists — create, duplicate, import, publish and export them. The founder's desk is one of the two that may change a price; the CRM and the Sales Dashboard only read them.",
  ),
  founder(
    "whatsapp",
    "WhatsApp",
    "Founder desks",
    "The switch that decides whether WhatsApp messages go to customers through the API at all, which approved Wati template each message is sent as, and what has gone out. Nothing is sent through the API unless it is switched on here.",
  ),
  cc("people", "people", "People & organisation", "Organisation", "Headcount, the employee master, reporting lines and the business calendar."),
  cc("system", "system", "Data operations & health", "Organisation", "Every sync, import, repair and recompute, and how fresh the data is."),

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
  /* -------------------------------------------------------- the Website CMS
   * One module per screen — the public site's content desk, granted
   * separately from every other app for the same reason the Website
   * Enquiries app is: nobody who already holds Sales, Accounts or HRMS does
   * this work. Mock data only in this PR; a grant here opens the screens and
   * nothing on the live site yet.
   */
  { key: "website.dashboard", app: "website", label: "Dashboard", group: "Website", href: "/website", exact: true },
  /*
   * HIRE is one module. What somebody can open inside it is their Hire ROLE
   * (`lib/hire/roles.ts`), not a tick-list: an interviewer who could be
   * granted the Decisions screen would be a hiring manager in all but name,
   * and the scope that keeps interviewers away from earlier scores is not a
   * screen at all.
   */
  {
    key: "hire.app",
    app: "hire",
    label: "Hire",
    group: "Hire",
    href: "/hire",
    note: "What they can do inside Hire is their Hire role — recruiter, interviewer, hiring manager, onboarding, HR head or admin — set below, under Hire.",
  },
  website("products", "Products", "Website", "The catalogue shown on the public site."),
  website("industries", "Industries", "Website", "The industries the public site says Mahek serves."),
  website("pages", "Pages", "Website", "About, Manufacturing, Distributor and Contact — their sections and copy."),
  website("gallery", "Gallery", "Website", "Photos shown on the public site."),
  website("media", "Media", "Website", "The media library behind every image on the site."),
  website("careers", "Careers", "Website", "Job postings shown on the public site. Applications are managed in Enquiries."),
  website("testimonials", "Testimonials", "Website", "Customer quotes shown on the public site."),
  website("milestones", "Milestones", "Website", "The company timeline shown on the public site."),
  website("navigation", "Navigation", "Website", "The header and footer menus."),
  website("seo", "SEO", "Website", "Per-page titles, descriptions and metadata."),
  website("settings", "Settings", "Website", "Company, social, contact and analytics settings for the public site."),

  /*
   * THE ERP: one module per BUILT screen, read off its own registry so the
   * sidebar, this guard and the access screen cannot disagree. Each screen is
   * separately grantable because the source's permission list named screens.
   * The dashboard is the app root and matched exactly, or it would swallow
   * every /erp/* path.
   */
  ...ERP_GROUPS.flatMap((g) =>
    g.screens
      .filter((sc) => sc.built)
      .map(
        (sc): AppModule => ({
          key: `erp.${sc.key}`,
          app: "erp",
          label: sc.label,
          group: `ERP · ${g.label}`,
          href: erpHref(sc),
          exact: sc.slug === "",
        }),
      ),
  ),
];

const BY_KEY = new Map(APP_MODULES.map((m) => [m.key, m]));

/**
 * KEYS NO LONGER IN THE REGISTRY, and the live key each one now means.
 *
 * A module key is a join key in `app_module_access`, so retiring one has two
 * failure modes and both are silent. Leave the key out entirely and a stored
 * row naming it is not "a module of this app" any more — `moduleAllowed`
 * filters it away, and somebody narrowed to exactly that row is left with NO
 * rows for the app, which reads as the whole app: a retirement that widens
 * access. Keep the key in the registry and the Access screen goes on offering
 * a box that duplicates another.
 *
 * So a retired key is translated, here, on the way in, to the module that
 * replaced it — no migration, nothing rewritten, and the next save on the
 * Access screen writes the live key because that is the only one it can draw.
 */
export const RETIRED_MODULES: Readonly<Record<string, string>> = {};

/**
 * Modules a holder of the app reaches WHATEVER was ticked — HRMS's check-in
 * screen, the ERP's dashboard and settings. Their own apps enforce this
 * (`lib/hrms/access.ts`, `lib/erp/access.ts`); it is read here so the Access
 * screen can draw them as always on instead of as a checkbox that does
 * nothing when unticked, which is the one kind of control that teaches people
 * the screen is lying to them.
 */
export const ALWAYS_OPEN_MODULES: ReadonlySet<string> = new Set([
  ...[...HRMS_ALWAYS_OPEN].map((k) => `hrms.${k}`),
  ...[...ERP_ALWAYS_OPEN].map((k) => `erp.${k}`),
]);

export function isAlwaysOpen(key: string): boolean {
  return ALWAYS_OPEN_MODULES.has(key);
}

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
    if (m.writeOf) continue;
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
  /**
   * The person holds this app AS AN ADMINISTRATOR. Such a hat holds every
   * module marked `offByDefault` whatever its rows say: that flag exists so a
   * grant of the whole app does not carry the module to ordinary users, and an
   * administrator is the one who hands it out. It reaches ONLY those modules —
   * an administrator narrowed on purpose stays narrowed everywhere else.
   */
  administrator = false,
): boolean {
  const forApp = granted
    .map((g) => RETIRED_MODULES[g] ?? g)
    .filter((g) => getModule(g)?.app === app);
  /* Checked first, and returns on its own: an explicitOnly module answers to
     nothing but its own row, not to "no rows means everything" and not to the
     administrator bypass either. */
  if (getModule(key)?.explicitOnly) return forApp.includes(key);
  /* A write level is a narrowing of its screen, never a way onto it: a row
     for the companion beside no row for the screen opens nothing. */
  const parent = getModule(key)?.writeOf;
  if (parent && !moduleAllowed(parent, granted, app, administrator)) return false;
  if (administrator && getModule(key)?.offByDefault) return true;
  return forApp.length === 0 || forApp.includes(key);
}

/** The write companion of a module, where it has one. */
export function writeModuleOf(key: string): AppModule | undefined {
  return APP_MODULES.find((m) => m.writeOf === key);
}

/** The modules that open the WhatsApp screen, one per app that draws it. */
export const WHATSAPP_MODULES = ["crm.whatsapp", "accounts.whatsapp"] as const;

/** Apps a grant can be made against, in registry order. */
export function grantableApps() {
  return APPS.filter((a) => modulesForApp(a.id).length > 0);
}
