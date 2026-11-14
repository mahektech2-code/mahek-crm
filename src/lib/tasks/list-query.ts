import { PRIORITY_LABEL, TASK_APP_LABEL, isTaskApp, plusDays, type TaskApp, type TaskPriority, type TaskStatus } from "./rules";

/* ---------------------------------------------------------------------------
 * A TASK LIST IS READ ONE PAGE AT A TIME, AND THE PAGE IS IN THE URL.
 *
 * Every Tasks screen used to fetch everything a person could see — capped at
 * 500, 1,000 or 2,000 rows depending on the screen — and then search, filter,
 * group and count in the browser. A person with 3,000 tasks saw 500 of them
 * and counts that were silently wrong; a manager with a large team shipped
 * megabytes of rows to draw twenty-five.
 *
 * Now the reading is the URL: which tab, which app, where from, what was
 * searched, how it is grouped, which page and how many a page. The server
 * filters, counts, groups and pages in SQL (`list-service.ts`) and sends one
 * page; the browser only draws it. This file is pure and client-safe, so the
 * screen that writes the URL and the server that reads it agree on every
 * default.
 * ------------------------------------------------------------------------- */

/** What a tab narrows to. Each screen offers its own subset. */
export const TASK_TABS = ["open", "now", "today", "late", "upcoming", "doing", "waiting", "done", "missed", "all"] as const;
export type TaskTab = (typeof TASK_TABS)[number];

export const TASK_GROUPS = ["app", "due", "priority", "source", "day", "none"] as const;
/** How rows are grouped. `day` is the day a task was closed — the Done screen's grouping. */
export type TaskGroup = (typeof TASK_GROUPS)[number];

export const TASK_KINDS = ["auto", "assigned", "routine", "self"] as const;
export type TaskKindFilter = "all" | (typeof TASK_KINDS)[number];

export const PER_PAGE_OPTIONS = [25, 50, 100] as const;
export const DEFAULT_PER_PAGE = 50;
/** The most a page may ever hold, whatever the URL asks for. */
export const MAX_PER_PAGE = 100;
/** The most one search may be, in characters — longer is trimmed, not refused. */
export const MAX_SEARCH = 120;
/** The most rows an export writes. Past this, filter it first. */
export const EXPORT_CAP = 20_000;
/** The most tasks one bulk action takes — the same ceiling the bulk actions enforce. */
export const BULK_CAP = 200;

export type TaskListQuery = {
  tab: TaskTab;
  /** One app, or null for every app. */
  app: TaskApp | null;
  kind: TaskKindFilter;
  q: string;
  group: TaskGroup;
  page: number;
  per: number;
};

/** What a screen starts from; the URL only carries what differs from it. */
export type TaskListDefaults = {
  tab: TaskTab;
  group: TaskGroup;
  /** The tabs this screen offers — a tab outside them falls back to the default. */
  tabs: readonly TaskTab[];
  /** The groupings this screen offers. */
  groups?: readonly TaskGroup[];
};

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Read a list's reading from the URL. Anything unknown, empty or out of range falls back to the screen's default. */
export function readTaskQuery(sp: Params, d: TaskListDefaults): TaskListQuery {
  const tab = one(sp.tab) as TaskTab;
  const group = one(sp.group) as TaskGroup;
  const groups = d.groups ?? TASK_GROUPS;
  const kind = one(sp.kind) as TaskKindFilter;
  const app = one(sp.app);
  const page = Number.parseInt(one(sp.page), 10);
  const per = Number.parseInt(one(sp.per), 10);
  return {
    tab: d.tabs.includes(tab) ? tab : d.tab,
    app: isTaskApp(app) ? app : null,
    kind: (TASK_KINDS as readonly string[]).includes(kind) ? kind : "all",
    q: one(sp.q).trim().slice(0, MAX_SEARCH),
    group: groups.includes(group) ? group : d.group,
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 100_000) : 1,
    per: (PER_PAGE_OPTIONS as readonly number[]).includes(per) ? per : DEFAULT_PER_PAGE,
  };
}

/**
 * The URL for a list after a change. Anything at its default is left out, so
 * a clean list has a clean address; changing anything but the page goes back
 * to page one, because page 7 of a different filter is a different page 7.
 * `keep` carries a screen's own parameters (the picked person, a tab of the
 * screen around the list) through untouched.
 */
export function taskQueryHref(base: string, cur: TaskListQuery, patch: Partial<TaskListQuery>, d: TaskListDefaults, keep: Record<string, string> = {}): string {
  const next: TaskListQuery = { ...cur, ...patch };
  if (!("page" in patch)) next.page = 1;
  const p = new URLSearchParams(keep);
  if (next.tab !== d.tab) p.set("tab", next.tab);
  if (next.app) p.set("app", next.app);
  if (next.kind !== "all") p.set("kind", next.kind);
  if (next.q.trim()) p.set("q", next.q.trim().slice(0, MAX_SEARCH));
  if (next.group !== d.group) p.set("group", next.group);
  if (next.page > 1) p.set("page", String(next.page));
  if (next.per !== DEFAULT_PER_PAGE) p.set("per", String(next.per));
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

/** The query string an export or a "select every match" request carries. */
export function taskQueryParams(q: TaskListQuery): Record<string, string> {
  const out: Record<string, string> = { tab: q.tab, group: q.group, kind: q.kind };
  if (q.app) out.app = q.app;
  if (q.q) out.q = q.q;
  return out;
}

/** The offset a page starts at, after the page is clamped to the last one there is. */
export function pageWindow(page: number, per: number, total: number): { page: number; offset: number; pages: number } {
  const pages = Math.max(1, Math.ceil(total / per));
  const at = Math.min(Math.max(1, page), pages);
  return { page: at, offset: (at - 1) * per, pages };
}

/** Escape a search for a LIKE pattern: a typed % or _ is a character, not a wildcard. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const SOURCE_LABEL: Record<(typeof TASK_KINDS)[number], string> = {
  auto: "Automatic",
  assigned: "Assigned to you",
  routine: "Routine",
  self: "Added by you",
};

const DUE_LABEL: Record<string, string> = { late: "Late", today: "Today", tomorrow: "Tomorrow", later: "Later", done: "Done" };

/** The heading a group key is drawn under. Keys come from the server's SQL. */
export function groupLabel(group: TaskGroup, key: string, today: string): string {
  if (group === "app") return key === "tasks" ? "Personal" : (TASK_APP_LABEL[key as TaskApp] ?? key);
  if (group === "priority") return PRIORITY_LABEL[key as TaskPriority] ?? key;
  if (group === "due") return DUE_LABEL[key] ?? key;
  if (group === "source") return SOURCE_LABEL[key as keyof typeof SOURCE_LABEL] ?? key;
  if (group === "day") {
    if (!key) return "Earlier";
    if (key === today) return "Today";
    const d = new Date(`${key}T00:00:00Z`);
    const t = new Date(`${today}T00:00:00Z`);
    if ((t.getTime() - d.getTime()) / 86_400_000 === 1) return "Yesterday";
    return `${WD[d.getUTCDay()]}, ${d.getUTCDate()} ${MO[d.getUTCMonth()]}${d.getUTCFullYear() !== t.getUTCFullYear() ? ` ${d.getUTCFullYear()}` : ""}`;
  }
  return "";
}

/** The fields a row's group is read from. */
export type GroupableRow = { app: string; priority: string; kind: string; status: TaskStatus; dueDate: string; closedOn: string | null };

/**
 * Which group a row falls in — the same answer as `groupKeySql` in
 * list-service.ts, which a test holds the two to. The page draws a heading
 * where this changes; the count beside it comes from the server.
 */
export function groupKeyOf(group: TaskGroup, r: GroupableRow, today: string): string {
  switch (group) {
    case "app":
      return r.app;
    case "priority":
      return r.priority;
    case "source":
      return r.kind;
    case "day":
      return r.closedOn ?? "";
    case "none":
      return "";
    case "due":
      return r.status === "done" ? "done" : r.status === "missed" ? "missed" : r.dueDate < today ? "late" : r.dueDate === today ? "today" : r.dueDate === plusDays(today, 1) ? "tomorrow" : "later";
  }
}

/* ------------------------------------------------- each screen's defaults */

/** All my tasks, and By app. */
export const ALL_TASKS_LIST: TaskListDefaults = {
  tab: "open",
  group: "app",
  tabs: ["open", "late", "today", "upcoming", "doing", "waiting", "done", "missed", "all"],
  groups: ["app", "due", "priority", "source", "none"],
};
/** By app: one app, so grouping by app would be one heading. */
export const BY_APP_LIST: TaskListDefaults = { ...ALL_TASKS_LIST, group: "due", groups: ["due", "priority", "source", "none"] };
/** An app's own My tasks. */
export const APP_TASKS_LIST: TaskListDefaults = { tab: "now", group: "none", tabs: ["now", "late", "upcoming", "done", "missed", "all"], groups: ["none"] };
/** Done: everything finished, by the day it closed. */
export const DONE_LIST: TaskListDefaults = { tab: "done", group: "day", tabs: ["done"], groups: ["day"] };
/** One person's tasks on Team workload. */
export const PERSON_LIST: TaskListDefaults = { tab: "open", group: "due", tabs: ["open", "late", "done", "missed", "all"], groups: ["due", "app", "none"] };
/** Assigned by me, the tasks given to one person. */
export const GIVEN_LIST: TaskListDefaults = { tab: "open", group: "none", tabs: ["open", "late", "done", "missed", "all"], groups: ["none"] };
/** Transfers waiting for you, or sent by you. */
export const TRANSFER_LIST: TaskListDefaults = { tab: "all", group: "none", tabs: ["all"], groups: ["none"] };
