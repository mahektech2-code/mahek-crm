import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import {
  addDays,
  APP_TIMEZONE,
  dayBoundaryWindow,
  isWorkingDay,
  monthKey,
  addMonths,
  endOfMonth,
  type BusinessDate,
} from "@/lib/business-date";
import { orderCountsSql } from "@/lib/order-status";
import { lastKnownPositions, teamDay, type LastKnown, type SalesmanDay } from "@/lib/services/sales-service";
import {
  auditFor,
  notesFor,
  slice,
  stampIST,
  withPage,
  type Ctx,
  type SectionProvider,
  type TableQuery,
} from "../provider";
import { change, fmtDay, inr, monthShort, num, plural, span } from "../format";
import type {
  ActSpec,
  Bar,
  Callout,
  FigureDrawer,
  Metric,
  RecordView,
  Row,
  TableDef,
  TablePage,
  Tone,
} from "../types";

/* ---------------------------------------------------------------------------
 * FIELD FORCE (PRD §15) — who is out, what they did, where they were last.
 *
 * The team and its day are the Sales Dashboard's own reads: `teamDay` for
 * check-ins, visits, orders and routes, `lastKnownPositions` for the newest of
 * the trail, the check-in and each visit. The founder hat carries no region,
 * so `managerScope` answers national — the whole field team.
 *
 * What neither read carries is added here and only here: whether a check-in
 * came with a GPS fix, whether a visit is open right now, the cities a
 * salesman works, and the distance travelled today — the travel legs he
 * logged, or the day's trail where he logged none. Salesmen are whoever holds
 * the Salesman App, which is exactly what MBOS sign-in checks.
 * ------------------------------------------------------------------------- */

const IST = sql.raw(`at time zone '${APP_TIMEZONE}'`);
const SCOPE = "Company-wide · every field salesman";

const VIEW_AS: ActSpec = { key: "viewAs", label: "View as", done: "Viewed", viewAs: true };

const TEAM_DEF: TableDef = {
  key: "team",
  title: "The field team today",
  hint: "",
  noun: "salesman",
  plural: "salesmen",
  rec: "Salesman",
  acts: [VIEW_AS],
  actW: "110px",
  min: 900,
  cols: [
    ["Salesman", "1.5fr"],
    ["Cities", "1.3fr"],
    ["Checked in", "0.9fr"],
    ["Visits", "0.6fr", true],
    ["Orders", "0.6fr", true],
    ["Last seen", "1.2fr"],
    ["State", "1fr"],
  ],
};

const CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: APP_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function clock(at: Date | string | null | undefined): string {
  if (!at) return "—";
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? "—" : CLOCK.format(d);
}

function ago(at: Date | string | null | undefined): string {
  if (!at) return "";
  const d = at instanceof Date ? at : new Date(at);
  const min = Math.max(0, Math.round((Date.now() - d.getTime()) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
}

function nowHint(): string {
  return `Now · ${stampIST(new Date()).replace(/ \d{4},/, ",")}`;
}

function km(metres: number): string {
  const k = metres / 1000;
  return `${k >= 100 ? num(Math.round(k)) : k.toFixed(1)} km`;
}

/* ------------------------------------------------------------- the team today */

type Extra = {
  id: string;
  no_fix: boolean;
  on_leave: boolean;
  open_visit: boolean;
  leg_metres: number | string | null;
  leg_count: number;
  trail_metres: number | string | null;
  cities: string[] | null;
  areas: string[] | null;
  email: string;
  phone: string | null;
};

type Person = SalesmanDay & {
  noFix: boolean;
  onLeave: boolean;
  openVisit: boolean;
  metres: number;
  metresFrom: "legs" | "trail" | null;
  cities: string[];
  email: string;
  phone: string | null;
  seen: LastKnown | null;
  state: { t: string; pill: Tone };
};

async function extras(day: BusinessDate): Promise<Map<string, Extra>> {
  const config = await getConfig();
  const w = dayBoundaryWindow(day, {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  });
  const acc = config["mbos.location.gpsAccuracyThresholdM"];
  const rows = await db.execute<Extra>(sql`
    with men as (
      select u.id, u.email, u.phone
        from users u
        join app_access a on a.user_id = u.id and a.app = 'field'
       where u.active
    ),
    pts as (
      select p.user_id, p.lat, p.lng,
             lag(p.lat) over w as plat, lag(p.lng) over w as plng
        from mbos_positions p
       where p.user_id in (select id from men)
         and p.at >= ${w.start}::timestamptz and p.at < ${w.end}::timestamptz
         and (p.accuracy_m is null or p.accuracy_m <= ${acc})
      window w as (partition by p.user_id order by p.at)
    ),
    trail as (
      select user_id,
             sum(2 * 6371008.8 * asin(sqrt(
               power(sin(radians(lat - plat) / 2), 2)
               + cos(radians(plat)) * cos(radians(lat)) * power(sin(radians(lng - plng) / 2), 2)
             )))::bigint as metres
        from pts where plat is not null
       group by user_id
    ),
    legs as (
      select l.user_id, coalesce(sum(l.chosen_metres), 0)::bigint as metres, count(*)::int as n
        from mbos_travel_legs l
       where l.user_id in (select id from men)
         and l.started_at >= ${w.start}::timestamptz and l.started_at < ${w.end}::timestamptz
       group by l.user_id
    )
    select m.id, m.email, m.phone,
           (att.check_in_at is not null and att.check_in_lat is null) as no_fix,
           coalesce(att.status = 'on_leave', false) as on_leave,
           exists (
             select 1 from mbos_visits v
              where v.salesman_id = m.id and v.check_out_at is null
                and v.check_in_at >= ${w.start}::timestamptz and v.check_in_at < ${w.end}::timestamptz
           ) as open_visit,
           legs.metres as leg_metres, coalesce(legs.n, 0) as leg_count,
           trail.metres as trail_metres,
           (select array_agg(t.region order by t.region) from mbos_user_territories t
             where t.user_id = m.id and t.kind = 'city') as cities,
           (select array_agg(t.region order by t.region) from mbos_user_territories t
             where t.user_id = m.id and t.kind <> 'region') as areas
      from men m
      left join mbos_attendance_days att on att.user_id = m.id and att.day = ${day}::date
      left join legs on legs.user_id = m.id
      left join trail on trail.user_id = m.id
  `);
  return new Map(rows.map((r) => [r.id, r]));
}

function stateOf(p: SalesmanDay, x: Extra | undefined): { t: string; pill: Tone } {
  if (x?.on_leave) return { t: "On leave", pill: "muted" };
  if (!p.checkInAt) return { t: "Not checked in", pill: "bad" };
  if (p.checkOutAt) return { t: "Finished", pill: "muted" };
  if (x?.no_fix) return { t: "No GPS", pill: "warn" };
  if (x?.open_visit) return { t: "In a visit", pill: "good" };
  return { t: "On route", pill: "good" };
}

async function teamToday(day: BusinessDate): Promise<Person[]> {
  const [td, seen, extra] = await Promise.all([teamDay(day), lastKnownPositions(day), extras(day)]);
  const seenById = new Map(seen.map((s) => [s.salesmanId, s]));
  return td.people
    .filter((p) => p.active)
    .map((p) => {
      const x = extra.get(p.id);
      const legs = Number(x?.leg_metres ?? 0);
      const trail = Number(x?.trail_metres ?? 0);
      const useLegs = (x?.leg_count ?? 0) > 0;
      return {
        ...p,
        visits: Number(p.visits),
        unverifiedVisits: Number(p.unverifiedVisits),
        orders: Number(p.orders),
        orderValuePaise: Number(p.orderValuePaise),
        collectedPaise: Number(p.collectedPaise),
        plannedStops: Number(p.plannedStops),
        walkedStops: Number(p.walkedStops),
        noFix: !!x?.no_fix,
        onLeave: !!x?.on_leave,
        openVisit: !!x?.open_visit,
        metres: useLegs ? legs : trail,
        metresFrom: useLegs ? "legs" : trail > 0 ? "trail" : null,
        cities: (x?.cities?.length ? x.cities : x?.areas) ?? [],
        email: x?.email ?? "",
        phone: x?.phone ?? null,
        seen: seenById.get(p.id) ?? null,
        state: stateOf(p, x),
      };
    });
}

function lastSeenCell(p: Person): string {
  if (!p.checkInAt && !p.seen?.seenAt) return "—";
  if (p.noFix && !p.seen?.seenAt) return "No fix since check-in";
  if (!p.seen?.seenAt) return "No fix today";
  return `${p.seen.place ?? "On the road"} · ${ago(p.seen.seenAt)}`;
}

function teamRow(p: Person): Row {
  return {
    id: p.id,
    cells: [
      { t: p.name },
      { t: p.cities.length ? p.cities.join(", ") : "No area set" },
      { t: p.checkInAt ? clock(p.checkInAt) : "—" },
      { t: num(p.visits) },
      { t: num(p.orders) },
      { t: lastSeenCell(p) },
      { t: p.state.t, pill: p.state.pill },
    ],
  };
}

function teamPage(people: Person[], query: TableQuery): TablePage {
  const s = slice(people, query, (p, q) =>
    [p.name, p.cities.join(" "), p.state.t, p.seen?.place ?? ""].join(" ").toLowerCase().includes(q),
  );
  return { rows: s.rows.map(teamRow), count: s.count, total: s.total, page: s.page, size: query.size, q: query.q };
}

/* ------------------------------------------------------------- period figures */

async function workingDaysIn(from: string, to: string): Promise<number> {
  const config = await getConfig();
  const wd = {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  };
  const hol = await db.execute<{ d: string }>(sql`
    select on_date::text as d from mbos_holidays
     where on_date between ${from}::date and ${to}::date
       and level = 'company'
  `);
  const holidays = new Set(hol.map((h) => h.d));
  let n = 0;
  for (let d = from as BusinessDate; d <= to; d = addDays(d, 1)) {
    if (isWorkingDay(d, wd) && !holidays.has(d)) n++;
  }
  return n;
}

async function periodCounts(ctx: Ctx) {
  const p = ctx.period;
  const [row] = await db.execute<Record<string, string>>(sql`
    select
      (select count(*) from mbos_visits v
        where (v.check_in_at ${IST})::date between ${p.from}::date and ${p.to}::date) as visits,
      (select count(*) from mbos_visits v
        where (v.check_in_at ${IST})::date between ${p.from}::date and ${p.to}::date and v.verified) as verified,
      (select count(*) from mbos_visits v
        where (v.check_in_at ${IST})::date between ${p.compareFrom}::date and ${p.compareTo}::date) as visits_prev,
      (select count(*) from orders o
        where o.source = 'mbos' and ${orderCountsSql("o")}
          and (o.ordered_at ${IST})::date between ${p.from}::date and ${p.to}::date) as field_orders,
      (select count(*) from orders o
        where ${orderCountsSql("o")}
          and (o.ordered_at ${IST})::date between ${p.from}::date and ${p.to}::date) as all_orders
  `);
  return {
    visits: Number(row?.visits ?? 0),
    verified: Number(row?.verified ?? 0),
    visitsPrev: Number(row?.visits_prev ?? 0),
    fieldOrders: Number(row?.field_orders ?? 0),
    allOrders: Number(row?.all_orders ?? 0),
  };
}

/* ------------------------------------------------------------------ section */

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length <= 4) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(", ")} and ${num(names.length - 3)} others`;
}

function openLabel(n: number): string {
  return n === 1 ? "Open it" : n === 2 ? "Open the two" : `Open all ${num(n)}`;
}

async function section(ctx: Ctx) {
  const day = ctx.period.today as BusinessDate;
  const wdTo = ctx.period.to < ctx.period.today ? ctx.period.to : ctx.period.today;
  const [people, pc, wd] = await Promise.all([teamToday(day), periodCounts(ctx), workingDaysIn(ctx.period.from, wdTo)]);

  const salesmen = people.length;
  const checkedIn = people.filter((p) => p.checkInAt).length;
  const noFix = people.filter((p) => p.noFix);
  const visitsToday = people.reduce((n, p) => n + p.visits, 0);
  const unverifiedToday = people.reduce((n, p) => n + p.unverifiedVisits, 0);
  const travelled = people.reduce((n, p) => n + p.metres, 0);
  const travellers = people.filter((p) => p.metres > 0).length;

  const notYet = salesmen - checkedIn;
  const visitChange = change(pc.visits, pc.visitsPrev);
  const verifiedPct = pc.visits ? Math.round((pc.verified / pc.visits) * 100) : 0;
  const share = pc.allOrders ? Math.round((pc.fieldOrders / pc.allOrders) * 100) : 0;

  const metrics: Metric[] = [
    {
      key: "checkedIn",
      label: "Checked in today",
      value: salesmen ? `${num(checkedIn)} of ${num(salesmen)}` : "None yet",
      sub: salesmen
        ? `${notYet ? `${num(notYet)} not yet` : "everybody is out"}${noFix.length ? ` · ${num(noFix.length)} with no GPS fix` : ""}`
        : "nobody holds the Salesman App",
      kind: "Now",
      tone: notYet || noFix.length ? "warn" : salesmen ? "good" : undefined,
    },
    {
      key: "visitsToday",
      label: "Visits today",
      value: num(visitsToday),
      sub: visitsToday
        ? `${num(visitsToday - unverifiedToday)} verified · ${num(unverifiedToday)} unverified`
        : "no visit logged yet",
      kind: "Now",
      tone: unverifiedToday ? "warn" : undefined,
    },
    {
      key: "visitsPeriod",
      label: "Visits this period",
      value: num(pc.visits),
      sub: pc.visits
        ? `${visitChange.text} · ${verifiedPct}% verified · ${plural(wd, "working day")}`
        : `none logged · ${plural(wd, "working day")}`,
      kind: "Period",
    },
    {
      key: "fieldOrders",
      label: "Orders from the field",
      value: num(pc.fieldOrders),
      sub: pc.allOrders ? `${share}% of all orders` : "no orders in this period",
      kind: "Period",
    },
    {
      key: "travelled",
      label: "Travelled today",
      value: km(travelled),
      sub: travellers ? `across ${plural(travellers, "salesman", "salesmen")}` : "no distance recorded yet",
      kind: "Now",
    },
  ];

  const callouts: Callout[] = [];
  if (noFix.length) {
    const names = listNames(noFix.map((p) => p.name));
    callouts.push({
      tone: "warn",
      text: `${names} checked in with no GPS fix, so where ${noFix.length === 1 ? "that day" : "those days"} started is not recorded. Their visits are still checked against each shop's address one by one.`,
      act: openLabel(noFix.length),
      figure: "checkedIn",
    });
  }

  return {
    metrics,
    callouts,
    tables: [withPage({ ...TEAM_DEF, hint: nowHint() }, teamPage(people, { q: "", page: 1, size: 25 }))],
    foot:
      "Selfies and positions are shown only to people granted the field-force module. Attendance here is field attendance; office staff attendance does not exist yet.",
  };
}

/* ------------------------------------------------------------------- figure */

function lastDays(day: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(day as BusinessDate, -i));
  return out;
}

function lastMonths(day: string, n: number): string[] {
  const out: string[] = [];
  const key = monthKey(day as BusinessDate);
  for (let i = n - 1; i >= 0; i--) out.push(addMonths(key, -i));
  return out;
}

async function dailySeries(days: string[], what: "checkins" | "visits" | "legs"): Promise<Map<string, number>> {
  const from = days[0]!;
  const to = days[days.length - 1]!;
  const q =
    what === "checkins"
      ? sql`select d.day::text as d, count(*)::bigint as n from mbos_attendance_days d
             join app_access a on a.user_id = d.user_id and a.app = 'field'
            where d.check_in_at is not null and d.day between ${from}::date and ${to}::date
            group by 1`
      : what === "visits"
        ? sql`select (v.check_in_at ${IST})::date::text as d, count(*)::bigint as n from mbos_visits v
               where (v.check_in_at ${IST})::date between ${from}::date and ${to}::date group by 1`
        : sql`select (l.started_at ${IST})::date::text as d, coalesce(sum(l.chosen_metres), 0)::bigint as n
                from mbos_travel_legs l
               where (l.started_at ${IST})::date between ${from}::date and ${to}::date group by 1`;
  const rows = await db.execute<{ d: string; n: string }>(q);
  return new Map(rows.map((r) => [r.d, Number(r.n)]));
}

async function monthlySeries(months: string[], what: "visits" | "fieldOrders"): Promise<Map<string, number>> {
  const from = `${months[0]}-01`;
  const to = endOfMonth(months[months.length - 1]!);
  const q =
    what === "visits"
      ? sql`select to_char((v.check_in_at ${IST})::date, 'YYYY-MM') as m, count(*)::bigint as n from mbos_visits v
             where (v.check_in_at ${IST})::date between ${from}::date and ${to}::date group by 1`
      : sql`select to_char((o.ordered_at ${IST})::date, 'YYYY-MM') as m, count(*)::bigint as n from orders o
             where o.source = 'mbos' and ${orderCountsSql("o")}
               and (o.ordered_at ${IST})::date between ${from}::date and ${to}::date group by 1`;
  const rows = await db.execute<{ m: string; n: string }>(q);
  return new Map(rows.map((r) => [r.m, Number(r.n)]));
}

function dayBars(days: string[], values: Map<string, number>, fmt: (n: number) => string = num): Bar[] {
  return days.map((d, i) => ({
    h: values.get(d) ?? 0,
    tip: `${fmtDay(d)} · ${fmt(values.get(d) ?? 0)}`,
    ...(i === days.length - 1 ? { current: true } : {}),
  }));
}

function monthBars(months: string[], values: Map<string, number>): Bar[] {
  return months.map((m, i) => ({
    h: values.get(m) ?? 0,
    tip: `${monthShort(m)} ${m.slice(0, 4)} · ${num(values.get(m) ?? 0)}`,
    ...(i === months.length - 1 ? { current: true } : {}),
  }));
}

async function figure(ctx: Ctx, metric: string): Promise<FigureDrawer> {
  const day = ctx.period.today as BusinessDate;
  const asOf = stampIST(new Date());
  const periodLine = `${span(ctx.period.from, ctx.period.to)}, compared with ${span(ctx.period.compareFrom, ctx.period.compareTo)}`;
  const base = { section: "field" as const, sectionLabel: "Field force" };

  if (metric === "checkedIn" || metric === "visitsToday" || metric === "travelled") {
    const days = lastDays(day, 12);
    const [people, series] = await Promise.all([
      teamToday(day),
      dailySeries(days, metric === "checkedIn" ? "checkins" : metric === "visitsToday" ? "visits" : "legs"),
    ]);
    const salesmen = people.length;
    const checkedIn = people.filter((p) => p.checkInAt).length;

    if (metric === "checkedIn") {
      const order = (p: Person) => (p.noFix ? 0 : !p.checkInAt ? 1 : 2);
      const rows = [...people]
        .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
        .slice(0, 8)
        .map((p) => ({
          a: p.name,
          b: p.checkInAt
            ? `Checked in ${clock(p.checkInAt)}${p.noFix ? " · no GPS fix" : ""}`
            : p.onLeave
              ? "On leave"
              : "Not checked in",
          c: p.state.t,
        }));
      return {
        kind: "Now figure · Attendance",
        title: "Checked in today",
        value: salesmen ? `${num(checkedIn)} of ${num(salesmen)}` : "None yet",
        facts: [
          { label: "Kind", value: "Now — today so far, whatever the period" },
          { label: "As of", value: asOf },
          { label: "Basis", value: "A field attendance day with a check-in time" },
          { label: "Scope", value: SCOPE },
          { label: "Source", value: "Salesman App attendance, as the Sales Dashboard reads it" },
        ],
        def: "Salesmen with a check-in today, out of every active field salesman.",
        bars: dayBars(days, series),
        barsLabel: "Salesmen checked in on each of the last 12 days",
        rowsLabel: "Salesmen, those without a GPS fix first",
        rows,
        ...base,
      };
    }

    if (metric === "visitsToday") {
      const visits = await db.execute<{ customer: string; salesman: string; at: string; verified: boolean; reason: string | null; dist: number | null }>(sql`
        select c.name as customer, u.name as salesman, v.check_in_at as at, v.verified,
               v.unverified_reason as reason, v.distance_from_shop_m as dist
          from mbos_visits v
          join customers c on c.id = v.customer_id
          join users u on u.id = v.salesman_id
         where (v.check_in_at ${IST})::date = ${day}::date
         order by v.check_in_at desc
         limit 8
      `);
      const total = people.reduce((n, p) => n + p.visits, 0);
      const unv = people.reduce((n, p) => n + p.unverifiedVisits, 0);
      return {
        kind: "Now figure · Visits",
        title: "Visits today",
        value: num(total),
        facts: [
          { label: "Kind", value: "Now — today so far, whatever the period" },
          { label: "As of", value: asOf },
          { label: "Basis", value: `${num(total - unv)} verified · ${num(unv)} unverified` },
          { label: "Scope", value: SCOPE },
          { label: "Source", value: "Visits logged on the Salesman App" },
        ],
        def: "Visits logged on the handset today. Verified means within range of the shop’s recorded address.",
        bars: dayBars(days, series),
        barsLabel: "Visits logged on each of the last 12 days",
        rowsLabel: "The latest visits today",
        rows: visits.map((v) => ({
          a: v.customer,
          b: `${v.salesman} · ${clock(v.at)}`,
          c: v.verified
            ? "Verified"
            : v.dist != null
              ? `Unverified · ${num(Number(v.dist))} m away`
              : "Unverified",
        })),
        noRowsLine: visits.length ? undefined : "No visit has been logged today.",
        ...base,
      };
    }

    const travelled = people.reduce((n, p) => n + p.metres, 0);
    return {
      kind: "Now figure · Travel",
      title: "Travelled today",
      value: km(travelled),
      facts: [
        { label: "Kind", value: "Now — today so far, whatever the period" },
        { label: "As of", value: asOf },
        {
          label: "Basis",
          value: "The travel legs each salesman logged today; where he logged none, the length of his GPS trail",
        },
        { label: "Scope", value: SCOPE },
        { label: "Source", value: "Travel legs and the day's position trail from the Salesman App" },
      ],
      def: "Kilometres travelled today by every field salesman: the distance chosen on the travel legs he logged, or, where he logged no leg, the length of his GPS trail with readings too loose to be a position left out. A trail is a floor on the real distance, never more than it.",
      bars: dayBars(days, series, (n) => km(n)),
      barsLabel: "Kilometres on logged travel legs, each of the last 12 days (the trail is measured for today only)",
      rowsLabel: "Salesmen by distance today",
      rows: [...people]
        .filter((p) => p.metres > 0)
        .sort((a, b) => b.metres - a.metres)
        .slice(0, 8)
        .map((p) => ({ a: p.name, b: p.metresFrom === "legs" ? "from logged legs" : "from the GPS trail", c: km(p.metres) })),
      noRowsLine: people.some((p) => p.metres > 0) ? undefined : "No distance has been recorded today.",
      ...base,
    };
  }

  if (metric === "visitsPeriod" || metric === "fieldOrders") {
    const months = lastMonths(ctx.period.to, 12);
    const p = ctx.period;
    const [series, pc, top] = await Promise.all([
      monthlySeries(months, metric === "visitsPeriod" ? "visits" : "fieldOrders"),
      periodCounts(ctx),
      metric === "visitsPeriod"
        ? db.execute<{ name: string; n: string; extra: string }>(sql`
            select u.name, count(*)::bigint as n, count(*) filter (where v.verified)::bigint as extra
              from mbos_visits v join users u on u.id = v.salesman_id
             where (v.check_in_at ${IST})::date between ${p.from}::date and ${p.to}::date
             group by u.name order by n desc limit 8`)
        : db.execute<{ name: string; n: string; extra: string }>(sql`
            select coalesce(u.name, 'Nobody recorded') as name, count(*)::bigint as n,
                   coalesce(sum(o.total_amount), 0)::bigint as extra
              from orders o left join users u on u.id = o.created_by_id
             where o.source = 'mbos' and ${orderCountsSql("o")}
               and (o.ordered_at ${IST})::date between ${p.from}::date and ${p.to}::date
             group by 1 order by n desc limit 8`),
    ]);
    const isVisits = metric === "visitsPeriod";
    const value = isVisits ? pc.visits : pc.fieldOrders;
    return {
      kind: isVisits ? "Period figure · Visits" : "Period figure · Orders",
      title: isVisits ? "Visits this period" : "Orders from the field",
      value: num(value),
      facts: [
        { label: "Kind", value: "Period — follows the period control" },
        { label: "Period", value: periodLine },
        {
          label: "Basis",
          value: isVisits
            ? `${num(pc.verified)} verified · ${change(pc.visits, pc.visitsPrev).text} on the period before`
            : `${num(pc.fieldOrders)} of ${plural(pc.allOrders, "order")} in the period`,
        },
        { label: "Scope", value: SCOPE },
        { label: "Source", value: isVisits ? "Visits logged on the Salesman App" : "Orders taken on the Salesman App" },
        { label: "As of", value: asOf },
      ],
      def: isVisits
        ? "Every visit logged on the handset with a check-in day inside the period, verified or not. Working days count the configured working week less company-wide holidays, up to today."
        : "Orders taken on the Salesman App with an order date inside the period that count as a sale — captured, approved, dispatched or delivered; pending, declined and cancelled orders are left out. The share is of every counting order in the period, from any source.",
      bars: monthBars(months, series),
      barsLabel: isVisits ? "Visits in each of the last 12 months" : "Field orders in each of the last 12 months",
      rowsLabel: isVisits ? "Salesmen by visits in the period" : "Salesmen by field orders in the period",
      rows: top.map((r) =>
        isVisits
          ? { a: r.name, b: `${num(Number(r.extra))} verified`, c: num(Number(r.n)) }
          : { a: r.name, b: `${inr(Number(r.extra))} with GST`, c: plural(Number(r.n), "order") },
      ),
      noRowsLine: top.length ? undefined : isVisits ? "No visit was logged in this period." : "No field order in this period.",
      ...base,
    };
  }

  throw new Error("That figure is not part of Field force.");
}

/* ------------------------------------------------------------------- record */

async function record(ctx: Ctx, table: string, id: string): Promise<RecordView> {
  if (table !== "team") throw new Error("That list is not part of Field force.");
  const day = ctx.period.today as BusinessDate;
  const [people, notes, audit, visits, dev] = await Promise.all([
    teamToday(day),
    notesFor("user", id),
    auditFor("user", id),
    db.execute<{ customer: string; at: string; out: string | null; verified: boolean; reason: string | null; dist: number | null; outcome: string }>(sql`
      select c.name as customer, v.check_in_at as at, v.check_out_at as out, v.verified,
             v.unverified_reason as reason, v.distance_from_shop_m as dist, v.outcome::text as outcome
        from mbos_visits v join customers c on c.id = v.customer_id
       where v.salesman_id = ${id} and (v.check_in_at ${IST})::date = ${day}::date
       order by v.check_in_at desc
    `),
    db.execute<{ model: string | null; app_version: string | null; last_seen_at: string | null; battery_percent: number | null; device_state_at: string | null }>(sql`
      select d.model, d.app_version, d.last_seen_at, d.battery_percent, d.device_state_at
        from mbos_devices d where d.user_id = ${id} and d.active
       order by d.bound_at desc limit 1
    `),
  ]);
  const p = people.find((x) => x.id === id);
  if (!p) throw new Error("That salesman is not on the field team.");
  const d = dev[0];

  const OUTCOME: Record<string, string> = {
    visited: "Visited",
    order: "Order taken",
    payment: "Payment collected",
    complaint: "Complaint raised",
    sample: "Sample",
    not_available: "Nobody available",
    closed: "Shop closed",
  };

  const timeline: { what: string; when: string }[] = [...notes];
  const events: { at: number; what: string; when: string }[] = [];
  for (const v of visits) {
    events.push({
      at: new Date(v.at).getTime(),
      what: `Visit · ${v.customer} · ${OUTCOME[v.outcome] ?? "Visited"} · ${
        v.verified ? "verified" : v.dist != null ? `unverified, ${num(Number(v.dist))} m from the shop` : "unverified"
      }${v.out ? ` · left ${clock(v.out)}` : " · still open"}`,
      when: stampIST(v.at),
    });
  }
  if (p.checkInAt) events.push({ at: new Date(p.checkInAt).getTime(), what: `Checked in${p.noFix ? " with no GPS fix" : ""}`, when: stampIST(p.checkInAt) });
  if (p.checkOutAt) events.push({ at: new Date(p.checkOutAt).getTime(), what: "Checked out", when: stampIST(p.checkOutAt) });
  events.sort((a, b) => b.at - a.at);
  timeline.push(...events.map(({ what, when }) => ({ what, when })));

  return {
    kind: "Salesman · Field force",
    title: p.name,
    sub: `${p.state.t} · ${p.cities.length ? p.cities.join(", ") : "no area set"}`,
    fields: [
      { label: "Email", value: p.email || "—" },
      { label: "Phone", value: p.phone || "—" },
      { label: "Works in", value: p.cities.length ? p.cities.join(", ") : "No area set — his handset shows no book" },
      { label: "Checked in", value: p.checkInAt ? `${clock(p.checkInAt)}${p.noFix ? " · no GPS fix" : ""}${p.withinGeofence === false ? " · outside the permitted radius" : ""}` : p.onLeave ? "On leave" : "Not yet" },
      { label: "Checked out", value: p.checkOutAt ? clock(p.checkOutAt) : p.checkInAt ? "Still out" : "—" },
      { label: "Correction asked for", value: p.regularisationRequested ? "Yes" : "No" },
      { label: "Visits today", value: `${num(p.visits)} · ${num(p.unverifiedVisits)} unverified` },
      { label: "Route", value: p.plannedStops ? `${num(p.walkedStops)} of ${plural(p.plannedStops, "planned stop")} walked` : "No route planned today" },
      { label: "Orders today", value: `${plural(p.orders, "order")} · ${inr(p.orderValuePaise)} with GST, captured and waiting on accounts` },
      { label: "Collected today", value: `${inr(p.collectedPaise)} reported, not yet confirmed by accounts` },
      { label: "Travelled today", value: p.metres ? `${km(p.metres)} ${p.metresFrom === "legs" ? "on logged legs" : "on the GPS trail"}` : "Nothing recorded" },
      { label: "Last seen", value: lastSeenCell(p) },
      { label: "Handset", value: d ? [d.model, d.app_version ? `app ${d.app_version}` : null].filter(Boolean).join(" · ") || "Bound, model not reported" : "No handset bound" },
      { label: "Handset last heard", value: d?.last_seen_at ? stampIST(d.last_seen_at) : "Never" },
      {
        label: "Battery",
        value: d?.battery_percent != null && d.device_state_at ? `${d.battery_percent}% — read ${ago(d.device_state_at)}` : "Not reported",
      },
    ],
    timeline,
    audit,
    acts: [VIEW_AS],
    href: { label: "Open in the Sales Dashboard", url: `/sales/people/${id}` },
    noteTarget: { kind: "user", id },
  };
}

/* ------------------------------------------------------------------ provider */

export const provider: SectionProvider = {
  section,
  async tablePage(ctx, table, query) {
    if (table !== "team") throw new Error("That list is not part of Field force.");
    return teamPage(await teamToday(ctx.period.today as BusinessDate), query);
  },
  figure,
  record,
  async act(_ctx, table, act) {
    if (table === "team" && act === "viewAs") {
      // Viewing as somebody is a read, opened by the client; nothing is run.
      return { ok: true, message: "Viewed" };
    }
    return { ok: false, error: "That action is not part of Field force." };
  },
};
