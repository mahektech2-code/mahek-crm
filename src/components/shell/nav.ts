export type NavItem = {
  href: string;
  label: string;
  icon: string;
  /**
   * Which count to draw beside the label. An internal discriminator — never
   * stored, never rendered — so unlike a module key it is free to be renamed,
   * and it was worth renaming: it read `deactivations` on a screen that also
   * handles reopening, which is the same half-a-name the route had.
   */
  badge?: "reminders" | "complaints" | "statusRequests";
  /**
   * Hidden from anybody who is not a manager or an admin, on top of the module
   * grant.
   *
   * This flag existed on the type and was read by nothing — declared, never
   * honoured, so every item carrying it was visible to everybody. It is honoured
   * now, and `navForModules` takes the role to do it.
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
  isManager = true,
): NavGroup[] {
  const set = new Set(allowed);
  return NAV.map((g) => ({
    ...g,
    // Two filters, deliberately. The module grant answers "were they given this
    // screen"; `managerOnly` answers "is this screen theirs to have at all" —
    // and the second is needed because an ungranted module is a HELD module,
    // not a withheld one.
    items: g.items.filter((i) => set.has(i.href) && (isManager || !i.managerOnly)),
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
      { href: at("/whatsapp"), label: "WhatsApp", icon: "chat" },
    ],
  },
  {
    label: "Collections",
    icon: "rupee",
    items: [
      { href: at("/payments"), label: "Payment Follow-up", icon: "rupee" },
      { href: at("/outstanding"), label: "Outstanding", icon: "wallet" },
      { href: at("/bills"), label: "Sales Bills", icon: "doc" },
    ],
  },
  {
    label: "Customer records",
    icon: "people",
    items: [
      { href: at("/customers"), label: "Customers", icon: "people" },
      {
        href: at("/complaints"),
        label: "Complaints",
        icon: "warning",
        badge: "complaints",
      },
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
