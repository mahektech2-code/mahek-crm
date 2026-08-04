export type NavItem = {
  href: string;
  label: string;
  icon: string;
  badge?: "reminders" | "complaints";
  managerOnly?: boolean;
};

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
      { href: at("/queue"), label: "Call Queue", icon: "phone" },
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
      // Managers only, but the page explains itself rather than 403-ing.
      { href: at("/settings"), label: "Configuration", icon: "settings" },
    ],
  },
];
