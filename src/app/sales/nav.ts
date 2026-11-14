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
  /** The group's own glyph. A COLLAPSED sidebar is six of these and nothing
   * else, so a group with no icon is a word in a list rather than a place. */
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
 * somebody returns to between every other thing they do. Folded into Overview
 * it would be hidden behind a closed group on every screen that is not
 * Overview's, which is most of them, and a home you have to open a drawer to
 * reach is not a home.
 *
 * It is exactly one item on purpose. Everything pinned here is a row the
 * sidebar can never collapse, so a second pinned item costs what the grouping
 * was bought for.
 */
export const SALES_PINNED: NavItem[] = [
  { href: "/sales", label: "Today", icon: "home", exact: true },
];

/**
 * THE GROUPS ARE THE MODULES AND THEIR ITEMS ARE THE SUB-MODULES, and only one
 * group is open at a time.
 *
 * Thirty destinations drawn flat under six headings is thirty-six rows in a
 * 232px column — taller than the viewport, so Administration was below the
 * fold on every screen and the scroll position was a thing somebody had to
 * manage in order to navigate. Worse, everything was equally prominent, which
 * means nothing was: the eye has no way to tell the part of the console it is
 * standing in from the five parts it is not.
 *
 * Collapsed, the same list is one pinned row and six headings. The group you
 * are in is open, and opening another closes it — an accordion rather than six
 * independent toggles, because six toggles is a state somebody has to tidy up
 * and its worst case is the thirty-six-row sidebar this replaced.
 *
 * The ORDER and the GROUPING are the design's own and are deliberately not
 * revisited here. `lib/modules.ts` carries the same six group names, because a
 * grant is reviewed group by group on the Access screen — an information
 * architecture invented in a sidebar would be a second one competing with the
 * one somebody designed and the one access is granted against.
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
      { href: "/sales/leads", label: "Leads", icon: "spark" },
    ],
  },
  {
    label: "Commercial",
    icon: "order",
    items: [
      { href: "/sales/orders", label: "Orders", icon: "order" },
      { href: "/sales/payments", label: "Payments", icon: "money" },
      { href: "/sales/invoices", label: "Invoices", icon: "doc" },
      { href: "/sales/samples", label: "Samples", icon: "sample" },
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
