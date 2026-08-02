/* ---------------------------------------------------------------------------
 * The MahekOne app registry.
 *
 * One sign-in covers all of these. What a person can open is data — a row per
 * user per app — not something hard-coded against their role, because access
 * and job title drift apart the moment somebody covers for a colleague.
 * ------------------------------------------------------------------------- */

export const APP_IDS = [
  "crm",
  "field",
  "orders",
  "people",
  "reports",
  "admin",
] as const;

export type AppId = (typeof APP_IDS)[number];

export type AppDefinition = {
  id: AppId;
  name: string;
  initials: string;
  description: string;
  href: string;
  /** The CRM carries the brand chip; everything else is neutral. */
  tone: "primary" | "neutral";
  /** False until the app itself exists — the launcher says so plainly. */
  built: boolean;
};

export const APPS: AppDefinition[] = [
  {
    id: "crm",
    name: "Telecaller CRM",
    initials: "TC",
    description:
      "Call queue, payment follow-up, reminders and the EOD report.",
    href: "/crm/dashboard",
    tone: "primary",
    built: true,
  },
  {
    id: "field",
    name: "Salesman App",
    initials: "SA",
    description:
      "Visit requests, route for the day and outcomes from the field.",
    href: "/field",
    tone: "neutral",
    built: false,
  },
  {
    id: "orders",
    name: "Order Management",
    initials: "OM",
    description: "Order entry, dispatch and the bill register the CRM mirrors.",
    href: "/orders",
    tone: "neutral",
    built: false,
  },
  {
    id: "people",
    name: "Attendance & People",
    initials: "AP",
    description: "Hours, leave and the team roster.",
    href: "/people",
    tone: "neutral",
    built: false,
  },
  {
    id: "reports",
    name: "Reports",
    initials: "RP",
    description: "Sales, collections and performance across every app.",
    href: "/reports",
    tone: "neutral",
    built: false,
  },
  {
    id: "admin",
    name: "Admin Console",
    initials: "AC",
    description: "Accounts, roles and app access for the whole team.",
    href: "/admin",
    tone: "neutral",
    built: false,
  },
];

export function getApp(id: string): AppDefinition | undefined {
  return APPS.find((a) => a.id === id);
}

/** "MAHEK CRM" for the CRM, "MAHEK OM" and so on for the rest. */
export function wordmark(app: AppDefinition): string {
  return `MAHEK ${app.id === "crm" ? "CRM" : app.initials}`;
}
