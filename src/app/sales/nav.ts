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

export type NavGroup = {
  label: string;
  /**
   * The group's own glyph. A collapsed sidebar is seven of these and nothing
   * else, and a group with no icon is a word in a list rather than a place.
   */
  icon: SalesIconName;
  items: NavItem[];
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

/**
 * ABOVE THE GROUPS, AND NEVER INSIDE ONE.
 *
 * Today is the console's home — the screen the wordmark links to and the one
 * somebody returns to between every other thing they do. Left inside Overview
 * it sits behind a shut group on every screen that is not Overview's, which is
 * most of them, and a home you have to open a drawer to reach is not a home.
 *
 * Exactly one item, on purpose: everything pinned here is a row the sidebar can
 * never collapse, so a second one spends what the grouping was bought for.
 */
export const SALES_PINNED: NavItem[] = [
  { href: "/sales", label: "Today", icon: "home", exact: true },
];

/**
 * THE GROUPS ARE THE MODULES AND THEIR ITEMS ARE THE SUB-MODULES, and exactly
 * one group is open at a time.
 *
 * `collapsible: true` used to be a property of ONE group, Lead Management,
 * because ten rows in one group was the case that broke the fold. The reasoning
 * was right about that group and wrong about the shape: the sidebar is forty
 * destinations under seven headings, which is forty-seven rows in a 232px
 * column — well past the viewport — so Administration was below the fold
 * whatever Lead Management did. Collapsing the ONE longest group treats the
 * symptom, and it leaves the console with two kinds of heading that look alike
 * and behave differently, which is worse than either kind alone.
 *
 * So every group collapses and one is open. Closed, the whole column is one
 * pinned row and seven headings. Opening a group shuts the one that was open —
 * an accordion rather than seven independent toggles, because seven toggles is
 * a state somebody has to tidy up and its worst case is the forty-seven-row
 * sidebar this replaced.
 *
 * The ORDER and the GROUPING are the design's own and are deliberately not
 * revisited here. `lib/modules.ts` carries the same seven group names, because
 * a grant is reviewed group by group on the Access screen — an information
 * architecture invented in a sidebar would be a second one competing both with
 * the one somebody designed and with the one access is granted against.
 */
export const SALES_NAV: NavGroup[] = [
  {
    label: "Overview",
    icon: "chart",
    items: [
      { href: "/sales/live", label: "Live map", icon: "pin" },
      { href: "/sales/territory", label: "Territory", icon: "grid" },
      { href: "/sales/performance", label: "Performance", icon: "chart" },
      { href: "/sales/targets", label: "Sales Targets", icon: "target" },
      { href: "/sales/roi", label: "Cost & return", icon: "chart" },
    ],
  },
  {
    label: "Field work",
    icon: "route",
    items: [
      { href: "/sales/tasks", label: "Tasks", icon: "task" },
      { href: "/sales/journeys", label: "Journey planning", icon: "route" },
      { href: "/sales/visits", label: "Visits", icon: "visit" },
      { href: "/sales/travel", label: "Travel ledger", icon: "route" },
      { href: "/sales/activity-history", label: "Activity history", icon: "clock" },
    ],
  },
  /*
   * THE GROUP THAT FORCED THE QUESTION, now answered for all seven.
   *
   * Every other group here is four to seven rows; Lead Management is ten, and
   * drawn open it pushed Commercial, People and Enablement below the fold for
   * anybody who does not work the funnel — which is most of this app's
   * audience. That is why it was the first to collapse. It is no longer the
   * only one, and nothing about it is special any more: it opens and shuts on
   * the same rule as its neighbours, and like them it opens itself whenever the
   * current route is inside it, because a group that hid the screen you were
   * standing on would be furniture rather than navigation.
   *
   * TEN and not twenty-three. The rest of the funnel's surface is tabs inside
   * these ten — see the note in `lib/modules.ts` for why that line was drawn
   * where it was, and what it costs.
   */
  {
    label: "Lead Management",
    icon: "spark",
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
    icon: "order",
    items: [
      { href: "/sales/orders", label: "Orders", icon: "order" },
      { href: "/sales/payments", label: "Payments", icon: "money" },
      { href: "/sales/invoices", label: "Invoices", icon: "doc" },
      { href: "/sales/catalogue", label: "Catalogue & rates", icon: "grid" },
    ],
  },
  {
    label: "People",
    icon: "people",
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
    icon: "book",
    items: [
      { href: "/sales/documents", label: "Documents", icon: "doc" },
      { href: "/sales/knowledge", label: "Knowledge", icon: "book" },
    ],
  },
  {
    label: "Administration",
    icon: "sliders",
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

/**
 * Every href the sidebar draws, pinned and grouped alike.
 *
 * It exists so `modules.test.ts` cannot check one half and miss the other: the
 * test that matters is "no module is unreachable", and the day Today moved out
 * of Overview it would have started reading a list Today was no longer in.
 */
export function navHrefs(): string[] {
  return [...SALES_PINNED, ...SALES_NAV.flatMap((g) => g.items)].map((i) => i.href);
}
