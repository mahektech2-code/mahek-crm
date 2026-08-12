export type NavItem = {
  href: string;
  label: string;
  icon: string;
  badge?: "reminders" | "complaints";
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
export function navForModules(allowed: readonly string[]): NavGroup[] {
  const set = new Set(allowed);
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => set.has(i.href)),
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
      { href: at("/bills"), label: "Sales Bills", icon: "doc" },
      { href: at("/inactive"), label: "Inactive Watch", icon: "eye" },
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
    ],
  },
  {
    label: "Targets & reporting",
    items: [
      { href: at("/targets"), label: "Monthly Targets", icon: "target" },
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
