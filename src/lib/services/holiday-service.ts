import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  audienceLabel,
  indexTree,
  isHolidayLevel,
  placeLabel,
  resolveHoliday,
  type HolidayLevel,
  type HolidayPerson,
  type PlaceNode,
  type TerritoryRow,
  type TreeIndex,
} from "@/lib/engines/holiday-audience";
import { EVERYBODY } from "@/lib/services/holiday-calendar";
import { placeKey } from "@/lib/place-parse";

/* ---------------------------------------------------------------------------
 * THE HOLIDAY CALENDAR, wired to data.
 *
 * `holiday-audience.ts` decides who a holiday reaches; this reads what it
 * needs (the field team, their territories, the place tree, the holidays and
 * their per-person allocations), hands it over, and writes the answer where
 * SQL can join it — `mbos_holiday_members`. Every reader that asks "is this
 * HIS day off" goes through `holidayAppliesSql`, which reads that table.
 *
 * THE HANDSET HEARS A CHANGE WITHOUT AN UPDATE because a rebuild that moves
 * who a holiday reaches also moves the holiday's `updated_at`, and the pull's
 * holiday channel is a delta on that column. The phone is sent the same five
 * columns it always was; `universal` now answers "is this mine", which is
 * exactly what its attendance engine already reads it as.
 * ------------------------------------------------------------------------- */

type Tx = Pick<typeof db, "execute">;

/** The place tree, as the engine reads it. A few thousand short rows. */
async function placeNodes(tx: Tx = db): Promise<PlaceNode[]> {
  return (await tx.execute<PlaceNode>(sql`
    select id, kind, name, parent_id as "parentId" from places
  `)) as unknown as PlaceNode[];
}

/**
 * Everybody holding the field app, with where they WORK — a manager's `region`
 * oversight patch is left out, as the Salesmen screen leaves it out: watching
 * Odisha from Nagpur is not working there. Unscoped.
 */
async function fieldPeople(tx: Tx = db): Promise<(HolidayPerson & { name: string; active: boolean })[]> {
  const rows = (await tx.execute<{ id: string; name: string; active: boolean; territories: TerritoryRow[] }>(sql`
    select u.id, u.name, u.active,
           coalesce((select json_agg(json_build_object('kind', t.kind, 'value', t.region,
                                                       'parent', coalesce(t.parent, '')))
                       from mbos_user_territories t where t.user_id = u.id and t.kind <> 'region'), '[]'::json) as territories
      from users u
      join app_access a on a.user_id = u.id and a.app = 'field'
     order by u.name
  `)) as unknown as { id: string; name: string; active: boolean; territories: TerritoryRow[] }[];
  return rows;
}

type StoredHoliday = {
  id: string;
  onDate: string;
  name: string;
  category: string;
  level: string;
  placeIds: string[];
  audienceLabel: string | null;
  note: string | null;
  scope: string | null;
  createdAt: Date;
  createdByName: string | null;
  updatedAt: Date;
};

async function storedHolidays(tx: Tx, where = sql`true`): Promise<StoredHoliday[]> {
  return (await tx.execute<StoredHoliday>(sql`
    select h.id, h.on_date::text as "onDate", h.name, h.category, h.level,
           h.place_ids as "placeIds", h.audience_label as "audienceLabel", h.note, h.scope,
           h.created_at as "createdAt", u.name as "createdByName", h.updated_at as "updatedAt"
      from mbos_holidays h
      left join users u on u.id = h.created_by_id
     where ${where}
     order by h.on_date asc, h.name asc
  `)) as unknown as StoredHoliday[];
}

type Assignment = { holidayId: string; userId: string; mode: "include" | "exclude"; reason: string | null; name: string; createdAt: Date; byName: string | null };

async function assignments(tx: Tx, holidayIds: string[]): Promise<Assignment[]> {
  if (!holidayIds.length) return [];
  return (await tx.execute<Assignment>(sql`
    select a.holiday_id as "holidayId", a.user_id as "userId", a.mode, a.reason,
           u.name, a.created_at as "createdAt", b.name as "byName"
      from mbos_holiday_assignments a
      join users u on u.id = a.user_id
      left join users b on b.id = a.created_by_id
     where a.holiday_id in (${sql.join(holidayIds.map((id) => sql`${id}`), sql`, `)})
  `)) as unknown as Assignment[];
}

function ruleOf(h: StoredHoliday, all: Assignment[]) {
  const mine = all.filter((a) => a.holidayId === h.id);
  return {
    level: (isHolidayLevel(h.level) ? h.level : "company") as HolidayLevel,
    placeIds: Array.isArray(h.placeIds) ? h.placeIds : [],
    include: mine.filter((a) => a.mode === "include").map((a) => a.userId),
    exclude: mine.filter((a) => a.mode === "exclude").map((a) => a.userId),
  };
}

/**
 * Resolve every holiday and write who it reaches.
 *
 * Idempotent and cheap — a few dozen holidays over a few dozen people — so it
 * runs after every holiday write, every allocation, every territory change,
 * and hourly as the net under all of them. Only a holiday whose answer
 * CHANGED is rewritten and has its `updated_at` moved, so a rebuild that
 * finds nothing new sends nothing to any phone.
 */
export async function rebuildHolidayMembers(): Promise<{ holidays: number; changed: number }> {
  return db.transaction(async (tx) => {
    /* One rebuild at a time: two interleaved would each delete what the other wrote. */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mbos_holiday_members'))`);

    const [nodes, people, holidays] = await Promise.all([
      placeNodes(tx),
      fieldPeople(tx),
      storedHolidays(tx, sql`h.on_date >= (date_trunc('year', now()) - interval '1 year')::date`),
    ]);
    const tree = indexTree(nodes);
    const allAssignments = await assignments(tx, holidays.map((h) => h.id));
    const current = (await tx.execute<{ holidayId: string; userId: string; reason: string }>(sql`
      select holiday_id as "holidayId", user_id as "userId", reason from mbos_holiday_members
    `)) as unknown as { holidayId: string; userId: string; reason: string }[];
    const had = new Map<string, Map<string, string>>();
    for (const r of current) {
      const m = had.get(r.holidayId) ?? new Map<string, string>();
      m.set(r.userId, r.reason);
      had.set(r.holidayId, m);
    }

    let changed = 0;
    for (const h of holidays) {
      const rule = ruleOf(h, allAssignments);
      const label = audienceLabel(rule, tree);
      const want = new Map<string, string>();
      if (rule.level !== "company")
        for (const [uid, m] of resolveHoliday(rule, people, tree)) want.set(uid, m.reasons.join(" · "));
      const before = had.get(h.id) ?? new Map<string, string>();
      const same =
        before.size === want.size && [...want].every(([uid, why]) => before.get(uid) === why);
      if (!same) {
        await tx.execute(sql`delete from mbos_holiday_members where holiday_id = ${h.id}`);
        for (const [uid, why] of want)
          await tx.execute(sql`
            insert into mbos_holiday_members (holiday_id, user_id, reason)
            values (${h.id}, ${uid}, ${why}) on conflict do nothing
          `);
      }
      if (!same || (label ?? null) !== (h.audienceLabel ?? null)) {
        changed++;
        await tx.execute(sql`
          update mbos_holidays set audience_label = ${label}, updated_at = now() where id = ${h.id}
        `);
        await mirrorAudienceToHrms(tx, h, rule.level, label, [...want.keys()]);
      }
    }
    return { holidays: holidays.length, changed };
  });
}

const HRMS_CATEGORY: Record<string, string> = {
  National: "National",
  Festival: "Festival",
  Regional: "Festival",
  "Weekly off": "Weekly",
  Special: "Festival",
};

/**
 * HRMS's copy of who a holiday is for. HRMS knows offices and named
 * employees, not places, so a non-company holiday reaches it as the named
 * employees behind the salesmen it reaches — re-written whenever that moves.
 * Only a row that already shares this holiday's id is touched: an HRMS
 * holiday HR entered for an office stays HR's.
 */
async function mirrorAudienceToHrms(tx: Tx, h: StoredHoliday, level: HolidayLevel, label: string | null, userIds: string[]) {
  const employees = userIds.length
    ? ((await tx.execute<{ employeeId: string }>(sql`
        select employee_id as "employeeId" from users
         where employee_id is not null
           and id in (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
      `)) as unknown as { employeeId: string }[]).map((r) => r.employeeId)
    : [];
  await tx.execute(sql`
    update hrms_holidays
       set tagged = ${level === "company" ? EVERYBODY : `Sales Dashboard: ${label ?? "named people"}`},
           tagged_employee_ids = ${JSON.stringify(level === "company" ? [] : employees)}::jsonb,
           category = ${HRMS_CATEGORY[h.category] ?? "Festival"},
           name = ${h.name},
           date = ${h.onDate}::date
     where id = ${h.id}
  `);
}

/* ═══════════════════════════════════════════════════════════════ the screen */

export type HolidayPlace = { id: string; kind: string; label: string };

export type HolidayAllocation = { userId: string; name: string; reason: string | null; at: Date; byName: string | null };

export type HolidayEntry = {
  id: string;
  onDate: string;
  name: string;
  category: string;
  level: HolidayLevel;
  places: HolidayPlace[];
  audienceLabel: string | null;
  note: string | null;
  /** What the old free-text "where" said, on a row from before levels. */
  typedScope: string | null;
  include: HolidayAllocation[];
  exclude: HolidayAllocation[];
  /** Everybody on the field team it reaches, and why. */
  members: { userId: string; reasons: string[] }[];
  createdAt: Date;
  createdByName: string | null;
};

export type HolidayPersonRow = {
  id: string;
  name: string;
  active: boolean;
  /** "Odisha · Cuttack (Odisha)" — where he is allocated, as a line. */
  where: string;
  /** The state names his territories sit in, for grouping. */
  states: string[];
};

export type HolidayCalendar = {
  year: number;
  holidays: HolidayEntry[];
  people: HolidayPersonRow[];
  /** Every state on the tree, for the picker and the state tab. */
  states: HolidayPlace[];
};

function statesOf(territories: TerritoryRow[], tree: TreeIndex): string[] {
  const out = new Set<string>();
  for (const t of territories) {
    if (t.kind === "state" || t.kind === "region") out.add(t.value);
    else if (t.kind === "city" && t.parent.trim()) out.add(t.parent);
    else {
      const name = t.kind === "beat" ? t.parent : t.value;
      for (const s of tree.cityStates.get(placeKey(name)) ?? []) out.add(s);
    }
  }
  return [...out].filter(Boolean).sort();
}

/**
 * One year of the calendar, with who each day reaches — resolved by the same
 * engine the rebuild uses, so the screen and the phones cannot disagree.
 * `teamIds` narrows the PEOPLE to the manager's own team; the holidays are
 * the company's and are all shown.
 */
export async function holidayCalendar(year: number, teamIds: string[] | null): Promise<HolidayCalendar> {
  const [nodes, everyone, holidays] = await Promise.all([
    placeNodes(),
    fieldPeople(),
    storedHolidays(db, sql`h.on_date between ${`${year}-01-01`}::date and ${`${year}-12-31`}::date`),
  ]);
  const tree = indexTree(nodes);
  const team = teamIds ? everyone.filter((p) => teamIds.includes(p.id)) : everyone;
  const all = await assignments(db, holidays.map((h) => h.id));
  const allocation = (a: Assignment): HolidayAllocation => ({ userId: a.userId, name: a.name, reason: a.reason, at: a.createdAt, byName: a.byName });

  const entries: HolidayEntry[] = holidays.map((h) => {
    const rule = ruleOf(h, all);
    const resolved = resolveHoliday(rule, team, tree);
    return {
      id: h.id,
      onDate: h.onDate,
      name: h.name,
      category: h.category,
      level: rule.level,
      places: rule.placeIds.map((id) => ({ id, kind: tree.byId.get(id)?.kind ?? "", label: placeLabel(tree, id) })),
      audienceLabel: audienceLabel(rule, tree),
      note: h.note,
      typedScope: h.scope,
      include: all.filter((a) => a.holidayId === h.id && a.mode === "include").map(allocation),
      exclude: all.filter((a) => a.holidayId === h.id && a.mode === "exclude").map(allocation),
      members: [...resolved].map(([userId, m]) => ({ userId, reasons: m.reasons })),
      createdAt: h.createdAt,
      createdByName: h.createdByName,
    };
  });

  const territoryLine = (ts: TerritoryRow[]) =>
    ts.filter((t) => t.kind !== "region").map((t) => (t.parent.trim() ? `${t.value} (${t.parent})` : t.value)).join(" · ");

  return {
    year,
    holidays: entries,
    people: team.map((p) => ({ id: p.id, name: p.name, active: p.active, where: territoryLine(p.territories), states: statesOf(p.territories, tree) })),
    states: nodes
      .filter((n) => n.kind === "state")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((n) => ({ id: n.id, kind: "state", label: n.name })),
  };
}

/**
 * Places of one kind matching what was typed, labelled with what they sit in
 * — "Cuttack (Odisha)" — so two towns of one name are two choices.
 */
export async function searchPlaces(kind: string, query: string, limit = 25): Promise<HolidayPlace[]> {
  const q = query.trim();
  const nodes = await placeNodes();
  const tree = indexTree(nodes);
  const needle = q.toLowerCase();
  return nodes
    .filter((n) => n.kind === kind && (!needle || n.name.toLowerCase().includes(needle) || placeLabel(tree, n.id).toLowerCase().includes(needle)))
    .sort((a, b) => {
      const as = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
      const bs = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
      return as - bs || a.name.localeCompare(b.name);
    })
    .slice(0, limit)
    .map((n) => ({ id: n.id, kind: n.kind, label: placeLabel(tree, n.id) }));
}

/** Who a holiday WOULD reach, before it is saved — the dialog's preview. */
export async function previewAudience(rule: { level: HolidayLevel; placeIds: string[]; include: string[]; exclude: string[] }, teamIds: string[] | null) {
  const [nodes, everyone] = await Promise.all([placeNodes(), fieldPeople()]);
  const tree = indexTree(nodes);
  const team = teamIds ? everyone.filter((p) => teamIds.includes(p.id)) : everyone;
  const resolved = resolveHoliday(rule, team, tree);
  return team
    .filter((p) => resolved.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, reasons: resolved.get(p.id)!.reasons }));
}

/**
 * HRMS's copy of ONE holiday, now — after a save, whether or not the rebuild
 * found its audience moved, so a renamed or re-dated day reaches payroll too.
 */
export async function syncHolidayToHrms(id: string): Promise<void> {
  const [h] = await storedHolidays(db, sql`h.id = ${id}`);
  if (!h) return;
  const members = (await db.execute<{ userId: string }>(sql`
    select user_id as "userId" from mbos_holiday_members where holiday_id = ${id}
  `)) as unknown as { userId: string }[];
  await mirrorAudienceToHrms(db, h, isHolidayLevel(h.level) ? h.level : "company", h.audienceLabel, members.map((m) => m.userId));
}
