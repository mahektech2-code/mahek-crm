export type NavItem = {
  href: string;
  label: string;
  icon: string;
  /**
   * Only where the route is a prefix of every other route beneath it. All
   * Leads is `/crm/leads`, which every other lead screen sits inside — without
   * this the row would read as active on all ten of them.
   */
  exact?: boolean;
  /**
   * Which count to draw beside the label. An internal discriminator — never
   * stored, never rendered — so unlike a module key it is free to be renamed,
   * and it was worth renaming: it read `deactivations` on a screen that also
   * handles reopening, which is the same half-a-name the route had.
   */
  badge?:
    | "reminders"
    | "complaints"
    | "statusRequests"
    | "leadsDueToday"
    | "leadsOverdue"
    /** §24 as ONE number: what is past its day if anything is, otherwise what is due today. */
    | "leadsAttention";
  /**
   * A screen that has left the main navigation but is still granted, routed and
   * working — drawn ONLY for somebody who cannot reach the screen that replaced
   * it (All Leads, where every one of these is now a view or a link).
   *
   * Hiding a destination from the sidebar must not strand the person whose grant
   * is for that destination alone: with no All Leads there is no desk line to
   * find it from, so for them the entry stays. Everybody else reaches it from
   * All Leads, the Sales Manager desk, or the link that always led to it.
   */
  legacy?: boolean;
  /**
   * Hidden from anybody who cannot DECIDE what the screen queues, on top of the
   * module grant.
   *
   * This flag existed on the type and was read by nothing — declared, never
   * honoured, so every item carrying it was visible to everybody. It was then
   * honoured against `isManager`, the widest level held in ANY app, which drew
   * the deactivation queue for a telecaller who managed Reports. The one item
   * carrying it is the Close/Reopen queue, so `navForModules` is now handed
   * whether the person holds `customer.deactivate` — the capability that
   * queue's actions and its route both ask.
   */
  managerOnly?: boolean;
};

/**
 * Filtering the sidebar to what somebody may open.
 *
 * The module registry decides, and `lib/access.ts` enforces the same list on
 * the route — the sidebar is the courtesy, the route guard is the rule. A link
 * that is not drawn is a statement to the browser, and the browser is not
 * where authority lives.
 */
/**
 * The rows above the groups, narrowed the same way.
 *
 * Dashboard is pinned for the reason the Manager Console pins Today: it is the
 * app's home, the screen the wordmark links to and the one somebody returns to
 * between every other thing they do. Inside a group it would sit behind a shut
 * heading on every screen that is not its own, which is most of them, and a
 * home you have to open a drawer to reach is not a home.
 *
 * It is narrowed by the grant like anything else — Dashboard is a module and
 * can be withheld, and a pinned row nobody may open would be a permanent link
 * to a redirect.
 */
export function pinnedForModules(allowed: readonly string[]): NavItem[] {
  const set = new Set(allowed);
  return PINNED.filter((i) => set.has(i.href));
}

export function navForModules(
  allowed: readonly string[],
  /** Holds `customer.deactivate` — see `NavItem.managerOnly`. */
  isManager = true,
): NavGroup[] {
  const set = new Set(allowed);
  /* A `legacy` row is drawn only for somebody with no All Leads — see the flag. */
  const hub = set.has(`${CRM_BASE}/leads`);
  return NAV.map((g) => ({
    ...g,
    // Three filters, deliberately. The module grant answers "were they given this
    // screen"; `managerOnly` answers "is this screen theirs to have at all" —
    // and the second is needed because an ungranted module is a HELD module,
    // not a withheld one. `legacy` answers "has something else replaced it for
    // this person".
    items: g.items.filter(
      (i) => set.has(i.href) && (isManager || !i.managerOnly) && !(i.legacy && hub),
    ),
  })).filter((g) => g.items.length > 0);
}

export type NavGroup = {
  label: string;
  /**
   * The group's own glyph. Shut, a group IS its glyph and its word — see
   * `components/shell/collapsible-nav.tsx`, which both apps' sidebars are now.
   */
  icon: string;
  items: NavItem[];
};

/**
 * Every CRM route hangs off this. MahekOne namespaces each app under its own
 * segment, so the base lives in one place rather than being spelled out
 * fourteen times and drifting the next time an app moves.
 */
export const CRM_BASE = "/crm";
const at = (path: string) => `${CRM_BASE}${path}`;

/** Above the groups, and never inside one. See `pinnedForModules`. */
export const PINNED: NavItem[] = [
  { href: at("/dashboard"), label: "Dashboard", icon: "dashboard" },
];

/**
 * THE GROUPS ARE THE MODULES AND THEIR ITEMS ARE THE SUB-MODULES, and exactly
 * one group is open at a time.
 *
 * The CRM's sidebar was seven headings over fourteen destinations, all drawn
 * flat and all equally prominent — twenty-one rows, which fitted, and which is
 * the only reason it was never a problem. It stopped fitting for two reasons
 * at once: Lead Management is ten more destinations, and the Manager Console
 * had already answered this for itself. Both apps draw
 * `components/shell/collapsible-nav.tsx` now, which is the same argument this
 * codebase makes everywhere else about two copies of one rule — and it means
 * somebody who works both apps learns one navigation rather than two.
 *
 * TWO GROUPS OF ONE ARE GONE, because a heading that opens a single row spends
 * a row to save none. Dashboard was Overview's only item and is pinned above
 * the groups instead; WhatsApp was Communication's only item and sits in Daily
 * calling, which is what it is — a message to a customer is the same day's
 * work as a call to one, and the WhatsApp screen is worked from the same queue.
 * Support keeps its own heading with one item in it, deliberately: the Help
 * Centre is the SOPs, it belongs to no part of the day, and filing it under
 * one would be the same misgrouping in the other direction.
 *
 * `lib/modules.ts` carries these group names too, because a grant is reviewed
 * group by group on the Access screen — the two lists move together or the
 * sidebar and the thing that grants it describe different apps.
 */
export const NAV: NavGroup[] = [
  {
    label: "Daily calling",
    icon: "phone",
    items: [
      { href: at("/call-log"), label: "Call Log", icon: "phone" },
      { href: at("/reminders"), label: "Reminders", icon: "bell", badge: "reminders" },
      { href: at("/history"), label: "Call History", icon: "history" },
    ],
  },
  {
    label: "Collections",
    icon: "rupee",
    items: [
      { href: at("/payments"), label: "Payment Follow-up", icon: "rupee" },
      /* WhatsApp is mostly payment reminders and the answers to them, so it
         sits with the chasing it belongs to rather than with the calls. */
      { href: at("/whatsapp"), label: "WhatsApp", icon: "chat" },
      { href: at("/outstanding"), label: "Outstanding", icon: "wallet" },
      { href: at("/bills"), label: "Sales Bills", icon: "doc" },
    ],
  },
  {
    label: "Customer records",
    icon: "people",
    items: [
      { href: at("/customers"), label: "Customers", icon: "people" },
      { href: at("/top-customers"), label: "Top customers", icon: "chart" },
      {
        href: at("/complaints"),
        label: "Complaints",
        icon: "warning",
        badge: "complaints",
      },
      { href: at("/price-lists"), label: "Price lists", icon: "rupee" },
      {
        href: at("/status-requests"),
        label: "Close/Reopen",
        icon: "warning",
        badge: "statusRequests",
        // The one place `managerOnly` is not decoration.
        //
        // Every other module is withheld per person on the access screen. This
        // one ALSO has to be withheld by role, because a module nobody has
        // narrowed reaches everybody holding the app — "no module rows for an
        // app means every module of it" — and that would put an approval queue
        // in front of the telecallers whose own requests it answers.
        managerOnly: true,
      },
    ],
  },
  /*
   * THE FUNNEL, in the app whose whole job is ringing people.
   *
   * Ten rows, which is why the sidebar had to collapse before this could land:
   * flat, the CRM would have been thirty-one rows. It is the same ten the
   * Manager Console draws, from the same list in `lib/lead-workspace.ts`, and
   * the screens behind them are the same files — what differs is the grant and
   * therefore the scope.
   */
  {
    label: "Lead Management",
    icon: "target",
    items: [
      /*
       * §8.1 — THE LEAD BADGE, AND WHY IT IS NOT THE SIZE OF THE BOOK.
       *
       * A badge is a queue, never a population. The three above decide the
       * same way — Reminders counts what is pending AND due, Complaints counts
       * the open ones — and a number that is never zero is furniture, read as
       * often as the resize grip. "412 leads" against All Leads would have sat
       * there every working day of the year and taught everybody to stop
       * looking at this column, taking the count beside it down too.
       *
       * It was two badges on two rows: All Leads carried what is owed TODAY and
       * Next actions carried what had gone PAST its day, in red. Next actions has
       * left this list — its Due, Overdue, Nothing-scheduled and On-hold tabs are
       * views of All Leads now — so the two numbers share the one row, as ONE
       * number: what is past its day if anything is (red, because one lead past
       * the day somebody promised is not a lighter version of five), otherwise
       * what is due today. Both come from `lead-action-window.ts`, the same two
       * windows the views behind them read, because a badge is the half nobody
       * checks: nobody presses a sidebar number and counts the rows it opened.
       *
       * THE SIX THAT STAY are the funnel's own surfaces — the list, the two ways
       * in (a desk and a form), the two managers' desks, and the one record of
       * what was lost. The seven rows after them have left the list but not the
       * product; see `NavItem.legacy`.
       */
      {
        href: at("/leads"),
        label: "All Leads",
        icon: "target",
        exact: true,
        badge: "leadsAttention",
      },
      { href: at("/leads/intake"), label: "Intake", icon: "plus" },
      /* The module's own name. It read "Telecaller" here while the access
         screen called the same grant "Calling desk", so a manager ticking one
         could not find it in the other. */
      { href: at("/leads/calling-desk"), label: "Calling desk", icon: "phone" },
      { href: at("/leads/sales-manager"), label: "Sales Manager", icon: "people" },
      { href: at("/leads/appointments"), label: "Distributor appointments", icon: "people" },
      { href: at("/leads/lost"), label: "Lost", icon: "warning" },
      /* ---- out of the main navigation; see `NavItem.legacy` -------------- */
      { href: at("/leads/funnel"), label: "Funnel & conversion", icon: "chart", legacy: true },
      { href: at("/leads/qualify"), label: "Qualification", icon: "check", legacy: true },
      { href: at("/samples"), label: "Samples & trials", icon: "doc", legacy: true },
      { href: at("/leads/commercial"), label: "Commercial", icon: "rupee", legacy: true },
      {
        href: at("/leads/actions"),
        label: "Next actions & nurture",
        icon: "clipboard",
        legacy: true,
      },
      { href: at("/leads/handovers"), label: "Handovers", icon: "arrowRight", legacy: true },
      /* Oversight is the Admin Console's now (Lead oversight, under Platform). It
         is kept here for somebody granted nothing but it. */
      { href: at("/leads/oversight"), label: "Oversight", icon: "lock", legacy: true },
    ],
  },
  {
    label: "Targets & reporting",
    icon: "target",
    items: [
      { href: at("/targets"), label: "Monthly Targets", icon: "target" },
      { href: at("/performance"), label: "My Performance", icon: "chart" },
      { href: at("/eod"), label: "EOD Report", icon: "clipboard" },
    ],
  },
  {
    label: "Support",
    icon: "book",
    items: [
      { href: at("/help"), label: "Help Center", icon: "book" },
      // Configuration is not here. Every setting in MahekOne is changed in the
      // Admin Console, so an app that also offered them would be a second place
      // for the same fact to live.
    ],
  },
];

/**
 * Every href the sidebar draws, pinned and grouped alike.
 *
 * It exists so `modules.test.ts` cannot check one half and miss the other: the
 * test that matters is "every link is a module that can be withheld", and the
 * day Dashboard moved out of Overview it would have started reading a list
 * Dashboard was no longer in.
 */
export function navHrefs(): string[] {
  return [...PINNED, ...NAV.flatMap((g) => g.items)].map((i) => i.href);
}
