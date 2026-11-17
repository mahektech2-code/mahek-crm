import type { AppId } from "./apps";

/* ---------------------------------------------------------------------------
 * HOW THE LAUNCHER SORTS AND DRAWS THE APPS — pure and client-safe.
 *
 * Four groups, each with its own icon colour, so fourteen tiles read as four
 * shelves rather than one wall. The order here is the order on the screen, and
 * the 1–9 shortcuts follow it. An app missing from this map is drawn in the
 * last group rather than dropped, and `launcher-groups.test.ts` fails on it.
 * ------------------------------------------------------------------------- */

export type LauncherGroupId = "sell" | "ops" | "people" | "company";

export const LAUNCHER_GROUPS: { id: LauncherGroupId; title: string; apps: AppId[] }[] = [
  { id: "sell", title: "Sell", apps: ["crm", "sales", "enquiries", "studio", "website"] },
  { id: "ops", title: "Money & operations", apps: ["accounts", "erp", "factory"] },
  { id: "people", title: "People", apps: ["hrms", "hire", "tasks"] },
  { id: "company", title: "Company", apps: ["founder", "locker", "docs", "admin"] },
];

/** The tile's icon colours per group: a soft ground and a deep stroke. */
export const GROUP_TONE: Record<LauncherGroupId, { bg: string; fg: string; dot: string }> = {
  sell: { bg: "#f1ecff", fg: "#3d14a8", dot: "#6835fb" },
  ops: { bg: "#fdf1e4", fg: "#8a4b06", dot: "#d97a1a" },
  people: { bg: "#e8f0fc", fg: "#1f4fa8", dot: "#2b5cbf" },
  company: { bg: "#e9f5ee", fg: "#155f36", dot: "#1d7a45" },
};

/** One stroke path per app, drawn at 24×24. */
export const APP_ICON_PATH: Record<AppId, string> = {
  crm: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2",
  field: "M7 2h10v20H7z M11 18h2",
  sales: "M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z M12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4",
  enquiries: "M3 13h5l2 3h4l2-3h5 M5 5h14l2 8v6H3v-6z",
  studio: "M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M15 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3",
  website:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3c2.5 2.5 4 5.5 4 9s-1.5 6.5-4 9c-2.5-2.5-4-5.5-4-9s1.5-6.5 4-9z",
  accounts: "M7 4h10 M7 8h10 M7 4h3a4 4 0 0 1 0 8H7l7 8",
  erp: "M21 8l-9-5-9 5 9 5 9-5z M3 8v8l9 5 9-5V8 M12 13v8",
  factory: "M3 21V10l6 4V10l6 4V6l6-3v18z M3 21h18",
  hrms: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M3 21v-1a6 6 0 0 1 12 0v1 M16 3.5a4 4 0 0 1 0 7.5 M21 21v-1a6 6 0 0 0-4-5.6",
  people: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M3 21v-1a6 6 0 0 1 12 0v1",
  hire: "M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M3 21v-1a7 7 0 0 1 11-5.7 M19 14v6 M16 17h6",
  tasks: "M4 4h16v16H4z M8 12l3 3 5-6",
  founder: "M4 20V10 M10 20V4 M16 20v-7 M22 20H2",
  reports: "M4 20V10 M10 20V4 M16 20v-7 M22 20H2",
  locker: "M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4 M12 15v2",
  docs: "M4 5a1 1 0 0 1 1-1h5a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4z M20 5a1 1 0 0 0-1-1h-5a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z",
  admin: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4",
};

/**
 * The apps a person holds, sorted onto the shelves. Empty groups are left out;
 * an app no group names lands in the last one rather than disappearing.
 */
export function groupApps<T extends { id: AppId }>(apps: T[]): { id: LauncherGroupId; title: string; apps: T[] }[] {
  const placed = new Set<AppId>();
  const out = LAUNCHER_GROUPS.map((g) => {
    const mine = g.apps.flatMap((id) => apps.filter((a) => a.id === id));
    mine.forEach((a) => placed.add(a.id));
    return { id: g.id, title: g.title, apps: mine };
  });
  const rest = apps.filter((a) => !placed.has(a.id));
  if (rest.length) out[out.length - 1].apps.push(...rest);
  return out.filter((g) => g.apps.length);
}

export function groupOf(id: AppId): LauncherGroupId {
  return LAUNCHER_GROUPS.find((g) => g.apps.includes(id))?.id ?? "company";
}

/** The badge's look, by the word on it. Admin is the strongest. */
export function roleTone(role: string): "admin" | "manager" | "associate" {
  if (role === "Admin") return "admin";
  if (role === "Associate") return "associate";
  return "manager";
}
