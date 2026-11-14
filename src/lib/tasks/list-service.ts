import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";
import { TASK_APPS, TASK_APP_LABEL, plusDays, type TaskApp } from "./rules";
import { TASK_TABS, groupKeyOf, likePattern, pageWindow, type TaskGroup, type TaskListQuery, type TaskTab } from "./list-query";
import { TASK_COLUMNS, TASK_FROM, idList, teamInSql, teamOf, toRow, type Raw, type TaskRow, type Viewer } from "./service";

/* ---------------------------------------------------------------------------
 * EVERY TASKS SCREEN READS ONE PAGE, AND EVERY FIGURE ON IT COMES FROM SQL.
 *
 * The lists used to fetch everything a person could see (capped at 500 to
 * 2,000 rows, silently) and to count, search, group and page in the browser.
 * At ten thousand tasks that is wrong twice: the counts describe the rows that
 * happened to arrive rather than the tasks that exist, and the page carries
 * megabytes to draw fifty. Here a list is a SCOPE (whose tasks), a QUERY (the
 * URL's tab, app, source, search, grouping and page — list-query.ts) and a
 * date; the database filters, counts every tab, counts every group on the
 * page, and returns that page. Nothing on a screen is a count of what was sent.
 *
 * Whose tasks a scope may name is decided BEFORE it gets here: `resolveScope`
 * is the one door a request's scope passes, and it asks the org chart and the
 * Tasks permissions exactly as the task's own record does.
 * ------------------------------------------------------------------------- */

/** Whose tasks a list is. */
export type TaskScope =
  | { kind: "mine"; userId: string; apps?: readonly TaskApp[] }
  | { kind: "person"; personId: string }
  | { kind: "team"; inTeam: SQL }
  | { kind: "given"; userId: string; singles?: boolean }
  | { kind: "incoming"; userId: string; apps?: readonly TaskApp[] }
  | { kind: "outgoing"; userId: string };

/** A scope as a screen may name it — no user ids it has not been checked for. */
export type TaskScopeSpec =
  | { kind: "mine"; apps?: TaskApp[] }
  | { kind: "person"; personId: string }
  | { kind: "given"; singles?: boolean }
  | { kind: "incoming"; apps?: TaskApp[] }
  | { kind: "outgoing" };

/**
 * A screen's scope, for this viewer — or null where they may not read it. A
 * person's tasks are open to whoever SEES that person (lib/tasks/permissions).
 */
export async function resolveScope(viewer: Viewer, spec: TaskScopeSpec): Promise<TaskScope | null> {
  switch (spec.kind) {
    case "mine":
      return { kind: "mine", userId: viewer.id, apps: spec.apps };
    case "incoming":
      return { kind: "incoming", userId: viewer.id, apps: spec.apps };
    case "outgoing":
      return { kind: "outgoing", userId: viewer.id };
    case "given":
      return { kind: "given", userId: viewer.id, singles: spec.singles };
    case "person":
      if (spec.personId === viewer.id) return { kind: "mine", userId: viewer.id };
      return (await teamOf(viewer, "see")).has(spec.personId) ? { kind: "person", personId: spec.personId } : null;
  }
}

const appsIn = (apps: readonly string[]) => sql`t.app = any(${idList(apps)})`;

function scopeSql(s: TaskScope): SQL {
  switch (s.kind) {
    case "mine":
      return s.apps?.length ? sql`t.assignee_id = ${s.userId} and ${appsIn(s.apps)}` : sql`t.assignee_id = ${s.userId}`;
    case "person":
      return sql`t.assignee_id = ${s.personId}`;
    case "team":
      return s.inTeam;
    case "given":
      return s.singles
        ? sql`t.created_by_id = ${s.userId} and t.assignee_id <> ${s.userId} and t.batch_id is null`
        : sql`t.created_by_id = ${s.userId} and t.assignee_id <> ${s.userId}`;
    case "incoming":
      return s.apps?.length ? sql`tr.to_id = ${s.userId} and ${appsIn(s.apps)}` : sql`tr.to_id = ${s.userId}`;
    case "outgoing":
      return sql`(tr.from_id = ${s.userId} or tr.requested_by_id = ${s.userId})`;
  }
}

/** Where a task came from, as SQL — the same order `toRow` decides `kind` in. */
export const KIND_SQL = sql`(case when t.auto_rule is not null then 'auto' when t.routine_id is not null then 'routine' when t.created_by_id <> t.assignee_id then 'assigned' else 'self' end)`;

/* Open is neither done nor missed; spelled as two inequalities so the open-task partial indexes still apply. */
const OPEN = sql`t.status <> 'done' and t.status <> 'missed'`;

export function tabSql(tab: TaskTab, today: string): SQL {
  switch (tab) {
    case "open":
      return OPEN;
    case "now":
      return sql`${OPEN} and t.due_date <= ${today}::date`;
    case "today":
      return sql`${OPEN} and t.due_date = ${today}::date`;
    case "late":
      return sql`${OPEN} and t.due_date < ${today}::date`;
    case "upcoming":
      return sql`${OPEN} and t.due_date > ${today}::date`;
    case "doing":
    case "waiting":
      return sql`t.status = ${tab}`;
    case "done":
      return sql`t.status = 'done'`;
    case "missed":
      return sql`t.status = 'missed'`;
    case "all":
      return sql`true`;
  }
}

/** The app, the source and the search — everything but the tab, which the tab counts are taken across. */
function filterSql(q: TaskListQuery): SQL {
  const parts: SQL[] = [];
  if (q.app) parts.push(sql`t.app = ${q.app}`);
  if (q.kind !== "all") parts.push(sql`${KIND_SQL} = ${q.kind}`);
  if (q.q) {
    const like = likePattern(q.q);
    parts.push(sql`(t.title ilike ${like} or c.name ilike ${like} or cb.name ilike ${like} or a.name ilike ${like})`);
  }
  return parts.length ? sql.join(parts, sql` and `) : sql`true`;
}

/* Apps in the order their labels read, so "group by app" sorts as the headings do. */
const APP_ORDER = [...TASK_APPS].sort((x, y) => (x === "tasks" ? "Personal" : TASK_APP_LABEL[x]).localeCompare(y === "tasks" ? "Personal" : TASK_APP_LABEL[y]));

function dueKeySql(today: string): SQL {
  return sql`(case when t.status = 'done' then 'done' when t.status = 'missed' then 'missed' when t.due_date < ${today}::date then 'late' when t.due_date = ${today}::date then 'today' when t.due_date = ${plusDays(today, 1)}::date then 'tomorrow' else 'later' end)`;
}

const CLOSED_ON = sql`coalesce((t.closed_at at time zone ${APP_TIMEZONE})::date::text, '')`;

export function groupKeySql(group: TaskGroup, today: string): SQL {
  switch (group) {
    case "app":
      return sql`t.app`;
    case "due":
      return dueKeySql(today);
    case "priority":
      return sql`t.priority`;
    case "source":
      return KIND_SQL;
    case "day":
      return CLOSED_ON;
    case "none":
      return sql`''`;
  }
}

const PRIORITY_POS = sql`array_position(array['urgent','high','normal','low'], t.priority)`;

/** Group first, so a group's rows are together across pages; then the order a person works in. */
function orderSql(group: TaskGroup, tab: TaskTab, today: string): SQL {
  const groupRank =
    group === "app"
      ? sql`array_position(${idList(APP_ORDER)}, t.app),`
      : group === "due"
        ? sql`array_position(array['late','today','tomorrow','later','done','missed'], ${dueKeySql(today)}),`
        : group === "priority"
          ? sql`${PRIORITY_POS},`
          : group === "source"
            ? sql`array_position(array['auto','assigned','routine','self'], ${KIND_SQL}),`
            : sql``;
  // Finished work reads newest first; open work reads in the order it is due.
  if (group === "day" || tab === "done" || tab === "missed") return sql`order by ${groupRank} t.closed_at desc nulls last, t.id desc`;
  return sql`order by ${groupRank} (t.status in ('done','missed')), t.due_date, t.due_time nulls last, ${PRIORITY_POS}, t.created_at, t.id`;
}

export type TaskListPage = {
  rows: TaskRow[];
  /** How many match the whole reading — what the pager and "select every match" count. */
  total: number;
  page: number;
  per: number;
  pages: number;
  /** Every tab's count, with the app, source and search applied. */
  tabCounts: Record<TaskTab, number>;
  /** The apps this scope has any task in, with how many — the App filter's choices. */
  apps: { app: TaskApp; n: number }[];
  /** How many rows each group on this page holds across EVERY page. */
  groupCounts: Record<string, number>;
};

const where = (...parts: SQL[]) => sql.join(parts.map((p) => sql`(${p})`), sql` and `);

/** One page of a list, with every count the screen draws. */
export async function taskListPage(scope: TaskScope, q: TaskListQuery, today: string): Promise<TaskListPage> {
  const base = scopeSql(scope);
  const filt = filterSql(q);
  const [countRows, appRows] = await Promise.all([
    db.execute<Record<string, number>>(sql`
      select ${sql.join(
        TASK_TABS.map((t) => sql`count(*) filter (where ${tabSql(t, today)})::int as ${sql.identifier(t)}`),
        sql`, `,
      )}
      ${TASK_FROM}
      where ${where(base, filt)}`),
    db.execute<{ app: string; n: number }>(sql`select t.app, count(*)::int as n ${TASK_FROM} where ${base} group by t.app`),
  ]);
  const tabCounts = Object.fromEntries(TASK_TABS.map((t) => [t, Number(countRows[0]?.[t] ?? 0)])) as Record<TaskTab, number>;
  const total = tabCounts[q.tab];
  const w = pageWindow(q.page, q.per, total);
  const full = where(base, filt, tabSql(q.tab, today));
  const rows = total
    ? (await db.execute<Raw>(sql`${TASK_COLUMNS} ${TASK_FROM} where ${full} ${orderSql(q.group, q.tab, today)} limit ${q.per} offset ${w.offset}`)).map(toRow)
    : [];
  let groupCounts: Record<string, number> = {};
  if (q.group !== "none" && rows.length) {
    const key = groupKeySql(q.group, today);
    const keys = [...new Set(rows.map((r) => groupKeyOf(q.group, r, today)))];
    const g = await db.execute<{ k: string; n: number }>(sql`select ${key} as k, count(*)::int as n ${TASK_FROM} where ${full} and ${key} = any(${idList(keys)}) group by 1`);
    groupCounts = Object.fromEntries(g.map((r) => [r.k, Number(r.n)]));
  }
  return {
    rows,
    total,
    page: w.page,
    per: q.per,
    pages: w.pages,
    tabCounts,
    apps: appRows.filter((r) => (TASK_APPS as readonly string[]).includes(r.app)).map((r) => ({ app: r.app as TaskApp, n: Number(r.n) })),
    groupCounts,
  };
}

/** Every id the reading matches, in its order, up to `limit` — "select every match". */
export async function matchingTaskIds(scope: TaskScope, q: TaskListQuery, today: string, limit: number): Promise<{ ids: string[]; total: number }> {
  const full = where(scopeSql(scope), filterSql(q), tabSql(q.tab, today));
  const [ids, n] = await Promise.all([
    db.execute<{ id: string }>(sql`select t.id ${TASK_FROM} where ${full} ${orderSql(q.group, q.tab, today)} limit ${limit}`),
    db.execute<{ n: number }>(sql`select count(*)::int as n ${TASK_FROM} where ${full}`),
  ]);
  return { ids: ids.map((r) => r.id), total: Number(n[0]?.n ?? 0) };
}

/** Rows for an export, a slice at a time — the caller walks the slices so a large export never sits in memory whole. */
export async function taskListSlice(scope: TaskScope, q: TaskListQuery, today: string, offset: number, limit: number): Promise<TaskRow[]> {
  const full = where(scopeSql(scope), filterSql(q), tabSql(q.tab, today));
  return (await db.execute<Raw>(sql`${TASK_COLUMNS} ${TASK_FROM} where ${full} ${orderSql(q.group, q.tab, today)} limit ${limit} offset ${offset}`)).map(toRow);
}

/* ------------------------------------------------------------------ My day */

/** The most rows a section of My day, a Board column or a Calendar day draws — the rest is a count and a link. */
export const PREVIEW_ROWS = 25;

export type Section = { rows: TaskRow[]; total: number };

async function section(cond: SQL, order: SQL, limit = PREVIEW_ROWS): Promise<Section> {
  const [rows, n] = await Promise.all([
    db.execute<Raw>(sql`${TASK_COLUMNS} ${TASK_FROM} where ${cond} ${order} limit ${limit}`),
    db.execute<{ n: number }>(sql`select count(*)::int as n from tasks t where ${cond}`),
  ]);
  return { rows: rows.map(toRow), total: Number(n[0]?.n ?? 0) };
}

const BY_DUE = sql`order by t.due_date, t.due_time nulls last, ${PRIORITY_POS}, t.created_at, t.id`;

export type MyDay = {
  late: Section;
  today: Section;
  soon: Section;
  doneToday: Section;
  timedToday: number;
  byKind: Record<"auto" | "assigned" | "routine" | "self", number>;
};

/** My day: what is late, due today, due in the next three days and done today — each capped, each counted whole. */
export async function myDay(userId: string, today: string): Promise<MyDay> {
  const mine = sql`t.assignee_id = ${userId}`;
  const [late, dueToday, soon, doneToday, extra] = await Promise.all([
    section(sql`${mine} and ${tabSql("late", today)}`, BY_DUE),
    section(sql`${mine} and ${tabSql("today", today)}`, BY_DUE),
    section(sql`${mine} and ${OPEN} and t.due_date > ${today}::date and t.due_date <= ${plusDays(today, 3)}::date`, BY_DUE),
    section(sql`${mine} and t.status = 'done' and t.closed_at >= (${today}::date)::timestamp at time zone ${APP_TIMEZONE}`, sql`order by t.closed_at desc, t.id`),
    db.execute<Record<string, number>>(sql`
      select count(*) filter (where t.due_date = ${today}::date and t.due_time is not null)::int as timed,
             count(*) filter (where ${KIND_SQL} = 'auto')::int as auto,
             count(*) filter (where ${KIND_SQL} = 'assigned')::int as assigned,
             count(*) filter (where ${KIND_SQL} = 'routine')::int as routine,
             count(*) filter (where ${KIND_SQL} = 'self')::int as self
        from tasks t where ${mine} and ${OPEN}`),
  ]);
  const e = extra[0] ?? {};
  return {
    late,
    today: dueToday,
    soon,
    doneToday,
    timedToday: Number(e.timed ?? 0),
    byKind: { auto: Number(e.auto ?? 0), assigned: Number(e.assigned ?? 0), routine: Number(e.routine ?? 0), self: Number(e.self ?? 0) },
  };
}

/** The first task somebody is offering this person, and how many there are — the callout above a list. */
export async function incomingSummary(userId: string, apps?: readonly TaskApp[]): Promise<Section> {
  const scope = scopeSql({ kind: "incoming", userId, apps });
  const [rows, n] = await Promise.all([
    db.execute<Raw>(sql`${TASK_COLUMNS} ${TASK_FROM} where ${scope} order by tr.created_at limit 1`),
    db.execute<{ n: number }>(sql`select count(*)::int as n ${TASK_FROM} where ${scope}`),
  ]);
  return { rows: rows.map(toRow), total: Number(n[0]?.n ?? 0) };
}

/* ------------------------------------------------------------------- Board */

export type BoardColumns = Record<"todo" | "doing" | "waiting" | "done", Section>;

/** The board: each column capped, each counted. Done is today's done — a column of everything ever finished is not a board. */
export async function boardColumns(userId: string, today: string, app: TaskApp | null): Promise<BoardColumns> {
  const mine = app ? sql`t.assignee_id = ${userId} and t.app = ${app}` : sql`t.assignee_id = ${userId}`;
  const [todo, doing, waiting, done] = await Promise.all([
    section(sql`${mine} and t.status = 'todo'`, BY_DUE, 50),
    section(sql`${mine} and t.status = 'doing'`, BY_DUE, 50),
    section(sql`${mine} and t.status = 'waiting'`, BY_DUE, 50),
    section(sql`${mine} and t.status = 'done' and t.closed_at >= (${today}::date)::timestamp at time zone ${APP_TIMEZONE}`, sql`order by t.closed_at desc, t.id`, 50),
  ]);
  return { todo, doing, waiting, done };
}

/* ---------------------------------------------------------------- Calendar */

export type CalendarWeek = { byDay: Record<string, Section>; late: Section };

/** A week of this person's tasks, each day capped and counted; what is late sits on today when the week holds today. */
export async function calendarWeek(userId: string, days: string[], today: string, perDay = 20): Promise<CalendarWeek> {
  const from = days[0];
  const to = days[days.length - 1];
  const holdsToday = days.includes(today);
  /* A task late as of today is drawn on today, so it is not drawn on its own day too. */
  const notLate = holdsToday ? sql` and not (${OPEN} and t.due_date < ${today}::date)` : sql``;
  const cond = sql`t.assignee_id = ${userId} and t.due_date between ${from}::date and ${to}::date${notLate}`;
  const [rows, counts, late] = await Promise.all([
    db.execute<Raw>(sql`
      ${TASK_COLUMNS} ${TASK_FROM}
      where t.id in (
        select z.id from (
          select t.id, row_number() over (partition by t.due_date order by t.due_time nulls last, ${PRIORITY_POS}, t.created_at, t.id) as rn
            from tasks t where ${cond}
        ) z where z.rn <= ${perDay}
      )
      order by t.due_date, t.due_time nulls last, t.id`),
    db.execute<{ d: string; n: number }>(sql`select t.due_date::text as d, count(*)::int as n from tasks t where ${cond} group by 1`),
    holdsToday ? section(sql`t.assignee_id = ${userId} and ${tabSql("late", today)}`, BY_DUE, perDay) : Promise.resolve({ rows: [], total: 0 }),
  ]);
  const byDay: Record<string, Section> = Object.fromEntries(days.map((d) => [d, { rows: [] as TaskRow[], total: 0 }]));
  for (const r of rows.map(toRow)) byDay[r.dueDate]?.rows.push(r);
  for (const c of counts) if (byDay[c.d]) byDay[c.d].total = Number(c.n);
  return { byDay, late };
}

/* ----------------------------------------------------------- the tray */

/** The header tray: how many open and late, and the next few, soonest first. */
export async function trayTasks(userId: string, today: string, limit = 6): Promise<{ open: number; late: number; next: TaskRow[] }> {
  const [rows, n] = await Promise.all([
    db.execute<Raw>(sql`${TASK_COLUMNS} ${TASK_FROM} where t.assignee_id = ${userId} and ${OPEN} ${BY_DUE} limit ${limit}`),
    db.execute<{ open: number; late: number }>(sql`
      select count(*)::int as open, count(*) filter (where t.due_date < ${today}::date)::int as late
        from tasks t where t.assignee_id = ${userId} and ${OPEN}`),
  ]);
  return { open: Number(n[0]?.open ?? 0), late: Number(n[0]?.late ?? 0), next: rows.map(toRow) };
}

/* --------------------------------------------------- an app's My tasks */

export type AppSummary = { dueToday: number; callbacksToday: number; late: number; oldestLateDays: number; upcoming: number; fromManager: number; doneToday: number };

/** The strip above an app's My tasks, counted over every task rather than over a page. */
export async function appSummary(userId: string, apps: readonly TaskApp[], today: string): Promise<AppSummary> {
  const rows = await db.execute<Record<string, number | string | null>>(sql`
    select count(*) filter (where ${OPEN} and t.due_date = ${today}::date)::int as due_today,
           count(*) filter (where ${OPEN} and t.due_date = ${today}::date and t.auto_rule = 'crm.callback')::int as callbacks_today,
           count(*) filter (where ${OPEN} and t.due_date < ${today}::date)::int as late,
           min(t.due_date) filter (where ${OPEN} and t.due_date < ${today}::date)::text as oldest_late,
           count(*) filter (where ${OPEN} and t.due_date > ${today}::date)::int as upcoming,
           count(*) filter (where ${OPEN} and ${KIND_SQL} = 'assigned')::int as from_manager,
           count(*) filter (where t.status = 'done' and t.closed_at >= (${today}::date)::timestamp at time zone ${APP_TIMEZONE})::int as done_today
      from tasks t where t.assignee_id = ${userId} and ${appsIn(apps)}`);
  const r = rows[0] ?? {};
  const oldest = r.oldest_late ? String(r.oldest_late) : null;
  return {
    dueToday: Number(r.due_today ?? 0),
    callbacksToday: Number(r.callbacks_today ?? 0),
    late: Number(r.late ?? 0),
    oldestLateDays: oldest ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / 86_400_000) : 0,
    upcoming: Number(r.upcoming ?? 0),
    fromManager: Number(r.from_manager ?? 0),
    doneToday: Number(r.done_today ?? 0),
  };
}

/** What this person has open OUTSIDE these apps, and where — counted, never listed. */
export async function openElsewhere(userId: string, apps: readonly TaskApp[]): Promise<{ count: number; apps: TaskApp[] }> {
  const rows = await db.execute<{ app: string; n: number }>(sql`
    select t.app, count(*)::int as n from tasks t
     where t.assignee_id = ${userId} and ${OPEN} and not (${appsIn(apps)}) group by t.app order by count(*) desc`);
  return { count: rows.reduce((a, r) => a + Number(r.n), 0), apps: rows.map((r) => r.app as TaskApp) };
}

/* -------------------------------------------------------------- the team */

export type WorkloadRow = { id: string; name: string; apps: string[]; open: number; late: number; today: number; done: number; missed: number; manage: boolean };
export type Workload = {
  rows: WorkloadRow[];
  /** People matching the search, across every page. */
  people: number;
  page: number;
  pages: number;
  per: number;
  /** Sums over EVERY person the viewer sees, not the page. */
  totals: { open: number; late: number; today: number; done: number; missed: number; withLate: number; people: number };
};

/**
 * Team workload: each person's figures from one grouped read, paged by person.
 * The totals above the table are over everybody the viewer sees, whatever is
 * searched or paged — a page of fifty people is not the team.
 */
export async function teamWorkload(viewer: Viewer, today: string, opts: { q: string; page: number; per: number }): Promise<Workload> {
  const [inTeam, manages] = await Promise.all([teamInSql(viewer, "see", sql`u.id`), teamOf(viewer, "manage")]);
  const like = opts.q ? likePattern(opts.q) : null;
  const ppl = sql`select u.id, u.name from users u where u.active = true and ${inTeam}`;
  const stats = sql`
    select t.assignee_id,
           count(*) filter (where ${OPEN})::int as open,
           count(*) filter (where ${OPEN} and t.due_date < ${today}::date)::int as late,
           count(*) filter (where ${OPEN} and t.due_date = ${today}::date)::int as today,
           count(*) filter (where t.status = 'done' and t.closed_at > now() - interval '14 days')::int as done,
           count(*) filter (where t.status = 'missed' and t.closed_at > now() - interval '14 days')::int as missed
      from tasks t where t.assignee_id in (select id from ppl) group by t.assignee_id`;
  const [totals, matched] = await Promise.all([
    db.execute<Record<string, number>>(sql`
      with ppl as (${ppl}), s as (${stats})
      select (select count(*)::int from ppl) as people,
             coalesce(sum(open), 0)::int as open, coalesce(sum(late), 0)::int as late,
             coalesce(sum(today), 0)::int as today, coalesce(sum(done), 0)::int as done, coalesce(sum(missed), 0)::int as missed,
             count(*) filter (where late > 0)::int as with_late
        from s`),
    db.execute<{ n: number }>(sql`with ppl as (${ppl}) select count(*)::int as n from ppl ${like ? sql`where name ilike ${like}` : sql``}`),
  ]);
  const people = Number(matched[0]?.n ?? 0);
  const w = pageWindow(opts.page, opts.per, people);
  const rows = people
    ? await db.execute<{ id: string; name: string; apps: string[] | null; open: number; late: number; today: number; done: number; missed: number }>(sql`
        with ppl as (${ppl}), s as (${stats})
        select p.id, p.name,
               (select array_agg(distinct a.app::text) from app_access a where a.user_id = p.id) as apps,
               coalesce(s.open, 0)::int as open, coalesce(s.late, 0)::int as late, coalesce(s.today, 0)::int as today, coalesce(s.done, 0)::int as done, coalesce(s.missed, 0)::int as missed
          from ppl p left join s on s.assignee_id = p.id
         ${like ? sql`where p.name ilike ${like}` : sql``}
         order by coalesce(s.late, 0) desc, coalesce(s.open, 0) desc, p.name, p.id
         limit ${opts.per} offset ${w.offset}`)
    : [];
  const t = totals[0] ?? {};
  return {
    rows: rows.map((r) => ({ id: r.id, name: r.name, apps: r.apps ?? [], open: Number(r.open), late: Number(r.late), today: Number(r.today), done: Number(r.done), missed: Number(r.missed), manage: manages.has(r.id) })),
    people,
    page: w.page,
    pages: w.pages,
    per: opts.per,
    totals: { people: Number(t.people ?? 0), open: Number(t.open ?? 0), late: Number(t.late ?? 0), today: Number(t.today ?? 0), done: Number(t.done ?? 0), missed: Number(t.missed ?? 0), withLate: Number(t.with_late ?? 0) },
  };
}

/** One person's name, for the heading above their tasks — only somebody the viewer sees. */
export async function personName(viewer: Viewer, personId: string): Promise<string | null> {
  if (!(await teamOf(viewer, "see")).has(personId)) return null;
  const r = await db.execute<{ name: string }>(sql`select name from users where id = ${personId}`);
  return r[0]?.name ?? null;
}

/* ------------------------------------------------------- assigned by me */

export type GivenBatch = {
  id: string;
  title: string;
  app: TaskApp;
  audience: string;
  createdAt: string;
  dueDate: string;
  dueTime: string | null;
  total: number;
  done: number;
  /** The first people on it — open ones first. The rest is a count. */
  people: { taskId: string; name: string; status: TaskRow["status"] }[];
};

/** What this person gave to a group, one card per group, newest first — paged by group. */
export async function givenBatches(userId: string, page: number, per: number, chips = 24): Promise<{ rows: GivenBatch[]; total: number; page: number; pages: number }> {
  const mineInBatch = sql`t.batch_id = b.id and t.created_by_id = ${userId} and t.assignee_id <> ${userId}`;
  const n = await db.execute<{ n: number }>(sql`select count(*)::int as n from task_batches b where b.given_by_id = ${userId} and exists (select 1 from tasks t where ${mineInBatch})`);
  const total = Number(n[0]?.n ?? 0);
  const w = pageWindow(page, per, total);
  const rows = total
    ? await db.execute<Raw>(sql`
        select b.id, b.title, b.app, b.audience, b.created_at,
               (select min(t.due_date)::text from tasks t where ${mineInBatch}) as due_date,
               (select min(t.due_time) from tasks t where ${mineInBatch}) as due_time,
               (select count(*)::int from tasks t where ${mineInBatch}) as total,
               (select count(*)::int from tasks t where ${mineInBatch} and t.status = 'done') as done,
               (select coalesce(json_agg(json_build_object('taskId', x.id, 'name', x.name, 'status', x.status)), '[]'::json) from (
                  select t.id, u.name, t.status from tasks t join users u on u.id = t.assignee_id
                   where ${mineInBatch} order by (t.status = 'done'), u.name limit ${chips}) x) as people
          from task_batches b
         where b.given_by_id = ${userId} and exists (select 1 from tasks t where ${mineInBatch})
         order by b.created_at desc, b.id desc
         limit ${per} offset ${w.offset}`)
    : [];
  return {
    total,
    page: w.page,
    pages: w.pages,
    rows: rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      app: r.app as TaskApp,
      audience: String(r.audience),
      createdAt: new Date(String(r.created_at)).toISOString(),
      dueDate: String(r.due_date),
      dueTime: (r.due_time as string) ?? null,
      total: Number(r.total),
      done: Number(r.done),
      people: (r.people as GivenBatch["people"]) ?? [],
    })),
  };
}

/* ---------------------------------------------------------- transfers */

export type TransferHistoryRow = {
  id: string;
  taskId: string;
  title: string;
  fromName: string;
  toName: string;
  status: "accepted" | "rejected" | "withdrawn" | "moved";
  decidedByName: string | null;
  note: string | null;
  reason: string | null;
  decidedAt: string;
};

/** Transfers this person was part of that have been decided, newest first, a page at a time. */
export async function transferHistoryPage(userId: string, page: number, per: number): Promise<{ rows: TransferHistoryRow[]; total: number; page: number; pages: number }> {
  const cond = sql`tr.status <> 'pending' and (tr.from_id = ${userId} or tr.to_id = ${userId} or tr.requested_by_id = ${userId})`;
  const n = await db.execute<{ n: number }>(sql`select count(*)::int as n from task_transfers tr where ${cond}`);
  const total = Number(n[0]?.n ?? 0);
  const w = pageWindow(page, per, total);
  const rows = total
    ? await db.execute<Raw>(sql`
        select tr.id, tr.task_id, t.title, f.name as from_name, u.name as to_name, tr.status, d.name as decided_by_name,
               tr.decision_note, tr.reason, coalesce(tr.decided_at, tr.created_at) as decided_at
          from task_transfers tr
          join tasks t on t.id = tr.task_id
          join users f on f.id = tr.from_id
          join users u on u.id = tr.to_id
          left join users d on d.id = tr.decided_by_id
         where ${cond}
         order by coalesce(tr.decided_at, tr.created_at) desc, tr.id desc
         limit ${per} offset ${w.offset}`)
    : [];
  return {
    total,
    page: w.page,
    pages: w.pages,
    rows: rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      title: String(r.title),
      fromName: String(r.from_name),
      toName: String(r.to_name),
      status: r.status as TransferHistoryRow["status"],
      decidedByName: (r.decided_by_name as string) ?? null,
      note: (r.decision_note as string) ?? null,
      reason: (r.reason as string) ?? null,
      decidedAt: new Date(String(r.decided_at)).toISOString(),
    })),
  };
}

/** The counts on the Transfers tabs. */
export async function transferCounts(userId: string): Promise<{ incoming: number; outgoing: number; history: number }> {
  const r = await db.execute<Record<string, number>>(sql`
    select (select count(*)::int from task_transfers where to_id = ${userId} and status = 'pending') as incoming,
           (select count(*)::int from task_transfers where status = 'pending' and (from_id = ${userId} or requested_by_id = ${userId})) as outgoing,
           (select count(*)::int from task_transfers where status <> 'pending' and (from_id = ${userId} or to_id = ${userId} or requested_by_id = ${userId})) as history`);
  return { incoming: Number(r[0]?.incoming ?? 0), outgoing: Number(r[0]?.outgoing ?? 0), history: Number(r[0]?.history ?? 0) };
}
