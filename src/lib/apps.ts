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
  "hrms",
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
    // The app grew past its name: orders wait here to be accepted, and so does
    // money. The id and the route stay `orders` — they are what `app_access`
    // rows and every bookmark already say, and renaming those would revoke the
    // app from everybody who has it.
    name: "Accounts",
    initials: "AC",
    description:
      "Orders taken on a call, and payments reported against them, wait here to be accepted.",
    href: "/orders",
    tone: "neutral",
    built: true,
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
    id: "hrms",
    name: "HRMS",
    initials: "HR",
    description:
      "The employee master — who works here, where, since when and on what.",
    href: "/hrms/employees",
    tone: "neutral",
    built: true,
  },
  {
    id: "admin",
    name: "Admin Console",
    initials: "AC",
    description: "Accounts, roles and app access for the whole team.",
    href: "/admin",
    tone: "neutral",
    built: true,
  },
];

/* ---------------------------------------------------------------------------
 * Registering an app.
 *
 * An app's id is its slug, and it is load-bearing in three places at once: the
 * row in `app_access` that grants somebody the app, the URL segment they land
 * on, and the key every console screen joins against. That is why it is
 * validated here rather than in the console — the rule belongs to the registry,
 * not to whichever screen happens to be collecting the value.
 * ------------------------------------------------------------------------- */

/**
 * Slugs the platform reserves.
 *
 * The console addresses an app at /admin/<slug> and its own sections at
 * /admin/people, /admin/audit and so on — one namespace. An app allowed to call
 * itself "people" would shadow the People section, so the platform's segments
 * are reserved alongside its routes.
 */
const RESERVED = new Set([
  // Top-level routes.
  "api", "admin", "login", "apps", "assets", "static", "_next",
  // Sections inside the console.
  "overview", "people", "data", "notifications", "audit",
]);

export function validateAppSlug(
  slug: string,
  taken: readonly string[],
  /** The entry being edited, so it does not collide with itself. */
  currentId?: string,
): string | null {
  const value = slug.trim();
  if (!value) return "An app needs a slug — it is how access is granted and where the app lives.";
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    return "Lowercase letters, digits and hyphens, starting with a letter. This becomes a URL.";
  }
  if (value.length > 24) return "Keep it under 24 characters.";
  if (value.endsWith("-")) return "It cannot end with a hyphen.";
  if (value.includes("--")) return "No double hyphens.";
  if (RESERVED.has(value)) return `"${value}" is a platform route and cannot be an app slug.`;
  if (taken.some((t) => t === value && t !== currentId)) {
    return `Another app already uses "${value}". Two apps sharing a slug would share their access grants.`;
  }
  return null;
}

/** "—" and empty both mean "not deployed", which is legitimate before launch. */
function unset(value: string): boolean {
  const v = value.trim();
  return v === "" || v === "—" || v === "-";
}

export function validateAppRoute(route: string, slug: string, live: boolean): string | null {
  if (unset(route)) {
    return live ? "A live app needs a route, or the launcher has nowhere to send people." : null;
  }
  const value = route.trim();
  if (!value.startsWith("/")) return "A route is a path on this site, so it starts with a slash.";
  if (/\s/.test(value)) return "No spaces in a route.";
  if (/[A-Z]/.test(value)) return "Routes are lowercase.";
  if (/\.[a-z0-9]+$/i.test(value)) return "That looks like a file, not a route. Point at the app's first screen.";
  if (slug && !(value === `/${slug}` || value.startsWith(`/${slug}/`))) {
    return `A route must sit under /${slug}, or the launcher sends people somewhere that is not this app.`;
  }
  return null;
}

/**
 * An endpoint is optional — an app can be live and simply have no settings, and
 * one that publishes no summary just contributes nothing to the launcher's
 * count. What is checked here is the SHAPE. Whether a declared endpoint
 * actually answers is a different question, and Contract validation asks it.
 */
export function validateAppEndpoint(value: string): string | null {
  if (unset(value)) return null;
  const v = value.trim();
  if (!v.startsWith("/api/")) return "An endpoint is a path under /api/.";
  if (/\s/.test(v)) return "No spaces in an endpoint.";
  return null;
}

export function getApp(id: string): AppDefinition | undefined {
  return APPS.find((a) => a.id === id);
}

/** "MAHEK CRM" for the CRM, "MAHEK OM" and so on for the rest. */
export function wordmark(app: AppDefinition): string {
  return `MAHEK ${app.id === "crm" ? "CRM" : app.initials}`;
}
