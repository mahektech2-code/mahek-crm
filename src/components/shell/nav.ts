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

export type NavGroup = { label: string; items: NavItem[] };

/**
 * Every CRM route hangs off this. MahekOne namespaces each app under its own
 * segment, so the base lives in one place rather than being spelled out
 * fourteen times and drifting the next time an app moves.
 */
export const CRM_BASE = "/crm";
const at = (path: string) => `${CRM_BASE}${path}`;

/**
 * MahekOne's app switcher will sit above this. Today there is one app — CRM —
 * so the sidebar is its sections.
 */
export const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [{ href: at("/dashboard"), label: "Dashboard", icon: "dashboard" }],
  },
  {
    label: "Daily calling",
    items: [
      { href: at("/call-log"), label: "Call Log", icon: "phone" },
      { href: at("/reminders"), label: "Reminders", icon: "bell", badge: "reminders" },
      { href: at("/history"), label: "Call History", icon: "history" },
    ],
  },
  {
    label: "Collections",
    items: [
      { href: at("/payments"), label: "Payment Follow-up", icon: "rupee" },
      { href: at("/outstanding"), label: "Outstanding", icon: "wallet" },
      { href: at("/bills"), label: "Sales Bills", icon: "doc" },
    ],
  },
  {
    label: "Customer records",
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
    items: [
      { href: at("/targets"), label: "Monthly Targets", icon: "target" },
      { href: at("/performance"), label: "My Performance", icon: "chart" },
      { href: at("/eod"), label: "EOD Report", icon: "clipboard" },
    ],
  },
  {
    label: "Communication",
    items: [{ href: at("/whatsapp"), label: "WhatsApp", icon: "chat" }],
  },
  {
    label: "Support",
    items: [
      { href: at("/help"), label: "Help Center", icon: "book" },
      // Configuration is not here. Every setting in MahekOne is changed in the
      // Admin Console, so an app that also offered them would be a second place
      // for the same fact to live.
    ],
  },
];
