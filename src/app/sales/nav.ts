import type { SalesIconName } from "./icons";

/* ---------------------------------------------------------------------------
 * The Manager Console's navigation.
 *
 * DATA, and in its own file, because two things read it: the sidebar draws it,
 * and `modules.test.ts` checks it against the module registry.
 *
 * **IT IS A SECOND LIST AND THAT IS WHY IT IS TESTED.** `lib/modules.ts` is
 * what a grant points at and what the route guard enforces; this adds the one
 * thing that registry deliberately does not carry, an icon. Kept as two
 * hand-typed lists with nothing comparing them, they drifted by FOUR SCREENS:
 * Travel ledger, Expense exceptions, Expense policy and Cost & return were all
 * declared as modules — grantable on the Access screen, with a route, a layout
 * and a group name saying which part of the sidebar they belong to — and none
 * of them was ever drawn. Cost & return had no inbound link from anywhere in
 * the product, so the only way to reach it was to type the URL.
 *
 * Nothing about that was visible: the sidebar filters itself through the
 * grants, so a missing entry looks exactly like a module somebody was not
 * given.
 * ------------------------------------------------------------------------- */

export type NavItem = {
  href: string;
  label: string;
  icon: SalesIconName;
  exact?: boolean;
};

/**
 * NOT IN THE SIDEBAR, ON PURPOSE — and named here rather than left as a gap,
 * so the test can tell a decision from an omission.
 *
 * `sales.approvals` is reached from Today, which is where the decision is
 * actually taken: the greeting counts what is waiting and the button beside it
 * opens the queue. A standing sidebar entry for it would be a permanent link
 * to a list that is usually empty.
 */
export const NOT_IN_SIDEBAR = ["/sales/approvals"];

export const SALES_NAV: Array<{
  label: string;
  items: NavItem[];
  collapsible?: boolean;
}> = [
  {
    label: "Overview",
    items: [
      { href: "/sales", label: "Today", icon: "home", exact: true },
      { href: "/sales/live", label: "Live map", icon: "pin" },
      { href: "/sales/territory", label: "Territory", icon: "grid" },
      { href: "/sales/performance", label: "Performance", icon: "chart" },
      { href: "/sales/targets", label: "Sales Targets", icon: "target" },
      { href: "/sales/roi", label: "Cost & return", icon: "chart" },
    ],
  },
  {
    label: "Field work",
    items: [
      { href: "/sales/tasks", label: "Tasks", icon: "task" },
      { href: "/sales/journeys", label: "Journey planning", icon: "route" },
      { href: "/sales/visits", label: "Visits", icon: "visit" },
      { href: "/sales/travel", label: "Travel ledger", icon: "route" },
      { href: "/sales/activity-history", label: "Activity history", icon: "clock" },
    ],
  },
  /*
   * THE ONE COLLAPSIBLE GROUP, and the only one that needed to be.
   *
   * Every other group here is four to seven rows and is read at a glance. Lead
   * Management is ten, which is more than the rest of the sidebar's longest
   * group and would push Commercial, People and Enablement below the fold for
   * anybody who does not work the funnel — which is most of this app's
   * audience. So it collapses, it remembers whether it was open, and it opens
   * itself whenever the current route is inside it: a group that hid the
   * screen you were standing on would be furniture rather than navigation.
   *
   * TEN and not twenty-three. The rest of the funnel's surface is tabs inside
   * these ten — see the note in `lib/modules.ts` for why that line was drawn
   * where it was, and what it costs.
   */
  {
    label: "Lead Management",
    collapsible: true,
    items: [
      { href: "/sales/leads", label: "All Leads", icon: "spark", exact: true },
      { href: "/sales/leads/funnel", label: "Funnel & conversion", icon: "chart" },
      { href: "/sales/leads/intake", label: "Intake", icon: "doc" },
      { href: "/sales/leads/qualify", label: "Qualification", icon: "tick" },
      { href: "/sales/samples", label: "Samples & trials", icon: "sample" },
      { href: "/sales/leads/commercial", label: "Commercial", icon: "order" },
      { href: "/sales/leads/appointments", label: "Distributor appointments", icon: "people" },
      { href: "/sales/leads/actions", label: "Next actions & nurture", icon: "task" },
      { href: "/sales/leads/handovers", label: "Handovers", icon: "route" },
      { href: "/sales/leads/oversight", label: "Oversight", icon: "shield" },
    ],
  },
  {
    label: "Commercial",
    items: [
      { href: "/sales/orders", label: "Orders", icon: "order" },
      { href: "/sales/payments", label: "Payments", icon: "money" },
      { href: "/sales/invoices", label: "Invoices", icon: "doc" },
      { href: "/sales/catalogue", label: "Catalogue & rates", icon: "grid" },
    ],
  },
  {
    label: "People",
    items: [
      { href: "/sales/attendance", label: "Attendance", icon: "clock" },
      { href: "/sales/leave", label: "Leave", icon: "cal" },
      { href: "/sales/holidays", label: "Holidays", icon: "cal" },
      { href: "/sales/salary", label: "Salary", icon: "money" },
      { href: "/sales/expenses", label: "Expenses & claims", icon: "receipt" },
      { href: "/sales/exceptions", label: "Expense exceptions", icon: "shield" },
      { href: "/sales/expense-policy", label: "Expense policy", icon: "list" },
    ],
  },
  {
    label: "Enablement",
    items: [
      { href: "/sales/documents", label: "Documents", icon: "doc" },
      { href: "/sales/knowledge", label: "Knowledge", icon: "book" },
    ],
  },
  {
    label: "Administration",
    items: [
      { href: "/sales/people", label: "Salesmen", icon: "people" },
      { href: "/sales/prefs", label: "App preferences", icon: "sliders" },
      { href: "/sales/logins", label: "Login history", icon: "shield" },
      { href: "/sales/sync-health", label: "Sync health", icon: "bell" },
      { href: "/sales/notify", label: "Send a notification", icon: "bell" },
      { href: "/sales/audit", label: "Audit trail", icon: "list" },
    ],
  },
];
