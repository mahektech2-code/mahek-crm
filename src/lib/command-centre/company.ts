import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { addMonths, endOfMonth as endOfMonthKey, type BusinessDate, type DateRange } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { orderCountsSql } from "@/lib/order-status";
import { moneyArrivingSql } from "@/lib/money-arriving";
import { creditedToSql } from "@/lib/sales-attribution";
import { conversionFor } from "@/lib/engines/owner-kpis";
import { rankPerformance } from "@/lib/engines/performance";
import { leadsCreatedIn, ownerDashboard } from "@/lib/services/owner-dashboard-service";
import { readingsForPeriod, unattributedForPeriod, volumeForRange, workingDaysIn } from "@/lib/services/performance-service";
import { accountsHome } from "@/lib/services/accounts-home-service";
import { employeeMaster } from "@/lib/services/employee-service";
import { change, crore, fmtDate, initials, monthLong, monthShort, num, plural, signedChange, span } from "./format";
import { stampIST } from "./provider";
import type { Bar, CompanyPayload, FigureDrawer, PeriodCard, PeriodState } from "./types";

/* ---------------------------------------------------------------------------
 * THE COMPANY SECTION — the headline, read off the services the owning apps
 * already use (PRD §8, P12). Nothing here is a new definition:
 *
 *   revenue, orders, bill size, customers who ordered, conversion
 *                         → ownerDashboard() (the owner's five)
 *   volume               → volumeForRange() (the score's own line reading)
 *   pace, team score     → readingsForPeriod() (Targets & performance)
 *   outstanding, queues  → accountsHome() (the Accounts desk)
 *   headcount            → employeeMaster() (HRMS)
 *
 * The 12-bar trend beside every card is the same figure for each of the last
 * twelve months, read with the same predicates — never a decoration.
 * ------------------------------------------------------------------------- */

const IST_START = (d: string) => sql.raw(`'${d} 00:00:00+05:30'::timestamptz`);
const IST_END = (d: string) => sql.raw(`'${d} 23:59:59.999+05:30'::timestamptz`);

function twelveMonths(monthKey: string): string[] {
  return Array.from({ length: 12 }, (_, i) => addMonths(monthKey, i - 11));
}

type MonthRow = { month: string; revenue: string; orders: number; customers: number };

/** Revenue (with GST, net of credit notes), orders and ordering customers, per IST month. */
async function monthlySales(months: string[]) {
  const from = `${months[0]}-01`;
  const to = `${months[months.length - 1]}-31`;
  const [sales, notes, newc, collected] = await Promise.all([
    db.execute<MonthRow>(sql`
      select to_char(o.ordered_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month,
             coalesce(sum(o.total_amount), 0) as revenue,
             count(*)::int as orders,
             count(distinct o.customer_id)::int as customers
        from orders o
       where ${orderCountsSql("o")}
         and o.ordered_at >= ${IST_START(from)}
         and o.ordered_at < ${sql.raw(`('${months[months.length - 1]}-01'::date + interval '1 month')::timestamp at time zone 'Asia/Kolkata'`)}
       group by 1
    `),
    db.execute<{ month: string; value: string }>(sql`
      select to_char(r.received_at, 'YYYY-MM') as month, coalesce(sum(r.amount), 0) as value
        from payment_receipts r
       where r.status = 'confirmed'
         and r.idempotency_key like 'creditnote:%'
         and r.received_at >= ${sql.raw(`'${from}'::date`)}
       group by 1
    `),
    db.execute<{ month: string; n: number }>(sql`
      with first_order as (
        select o.customer_id, min(o.ordered_at) as first_at
          from orders o
         where ${orderCountsSql("o")}
         group by o.customer_id
      )
      select to_char(f.first_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month, count(*)::int as n
        from first_order f
       where f.first_at >= ${IST_START(from)}
       group by 1
    `),
    db.execute<{ month: string; value: string }>(sql`
      select to_char(r.received_at, 'YYYY-MM') as month, coalesce(sum(r.amount), 0) as value
        from payment_receipts r
       where ${moneyArrivingSql("r")}
         and r.received_at >= ${sql.raw(`'${from}'::date`)}
       group by 1
    `),
  ]);
  void to;
  const by = <T,>(rows: T[], key: (r: T) => string) => new Map(rows.map((r) => [key(r), r]));
  return {
    sales: by(sales, (r) => r.month),
    notes: new Map(notes.map((r) => [r.month, Number(r.value)])),
    newc: new Map(newc.map((r) => [r.month, Number(r.n)])),
    collected: new Map(collected.map((r) => [r.month, Number(r.value)])),
  };
}

async function newCustomersIn(range: DateRange): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    with first_order as (
      select o.customer_id, min(o.ordered_at) as first_at
        from orders o
       where ${orderCountsSql("o")}
       group by o.customer_id
    )
    select count(*)::int as n from first_order
     where first_at >= ${IST_START(range.from)} and first_at <= ${IST_END(range.to)}
  `);
  return Number(rows[0]?.n ?? 0);
}

async function collectedIn(range: DateRange): Promise<number> {
  const rows = await db.execute<{ v: string }>(sql`
    select coalesce(sum(r.amount), 0) as v
      from payment_receipts r
     where ${moneyArrivingSql("r")}
       and r.received_at >= ${sql.raw(`'${range.from}'::date`)}
       and r.received_at <= ${sql.raw(`'${range.to}'::date`)}
  `);
  return Number(rows[0]?.v ?? 0);
}

function bars(months: string[], value: (m: string) => number | null, fmt: (v: number) => string): Bar[] {
  return months.map((m, i) => {
    const v = value(m);
    return { h: Math.max(0, v ?? 0), tip: `${monthShort(m)} ${m.slice(0, 4)} · ${v == null ? "—" : fmt(v)}`, current: i === months.length - 1 };
  });
}

export type CompanyReads = Awaited<ReturnType<typeof readCompany>>;

/** Every read the Company section needs, in parallel. */
async function readCompany(p: PeriodState) {
  const range = { from: p.from, to: p.to };
  const compare = { from: p.compareFrom, to: p.compareTo };
  const lastYear = { from: p.lastYearFrom, to: p.lastYearTo };
  const months = twelveMonths(p.monthKey);
  const config = await getConfig();

  const [owner, volNow, volBefore, volLy, volTrend, newNow, newBefore, newLy, colNow, colBefore, colLy, trend, cohortLeads, readings, days, unattr, home, people, unstated] =
    await Promise.all([
      ownerDashboard(range, compare, lastYear, p.today as BusinessDate, {}),
      volumeForRange(range.from, range.to),
      volumeForRange(compare.from, compare.to),
      volumeForRange(lastYear.from, lastYear.to),
      volumeForRange(`${months[0]}-01`, p.today),
      newCustomersIn(range),
      newCustomersIn(compare),
      newCustomersIn(lastYear),
      collectedIn(range),
      collectedIn(compare),
      collectedIn(lastYear),
      monthlySales(months),
      leadsCreatedIn({ from: `${months[0]}-01`, to: p.today as BusinessDate }, {}),
      readingsForPeriod(p.monthKey, p.today as BusinessDate, {}),
      workingDaysIn(p.monthKey, p.today as BusinessDate),
      unattributedPeriod(range),
      accountsHome(),
      employeeMaster(),
      db.execute<{ n: number; v: string }>(sql`
        select count(*)::int as n, coalesce(sum(b.amount - b.paid_amount), 0) as v
          from bills b
         where b.payment_position = 'unstated'
           and b.amount > b.paid_amount
      `),
    ]);
  return { owner, volNow, volBefore, volLy, volTrend, newNow, newBefore, newLy, colNow, colBefore, colLy, trend, cohortLeads, readings, days, unattr, home, people, unstated: { n: Number(unstated[0]?.n ?? 0), v: Number(unstated[0]?.v ?? 0) }, months, config };
}

/** Unattributed revenue over ANY window — the same rule as `unattributedForPeriod`. */
async function unattributedPeriod(range: DateRange) {
  const rows = await db.execute<{ total: string; customers: number }>(sql`
    select coalesce(sum(o.total_amount), 0) as total, count(distinct o.customer_id)::int as customers
      from orders o
      join customers c on c.id = o.customer_id
     where ${orderCountsSql("o")}
       and o.ordered_at >= ${IST_START(range.from)} and o.ordered_at <= ${IST_END(range.to)}
       and ${creditedToSql("c")} is null
  `);
  return { revenuePaise: Number(rows[0]?.total ?? 0), customers: Number(rows[0]?.customers ?? 0) };
}
void unattributedForPeriod;

async function roleWords(userIds: string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const rows = await db.execute<{ user_id: string; apps: string[] }>(sql`
    select a.user_id, array_agg(a.app::text) as apps
      from app_access a
     where a.user_id in ${sql`(${sql.join(userIds.map((i) => sql`${i}`), sql`, `)})`}
     group by a.user_id
  `);
  return new Map(
    rows.map((r) => {
      const apps = r.apps ?? [];
      // role-name-ok: the job title on screen, not a stored role
      const word = apps.includes("field") ? "Field salesman" : apps.includes("crm") ? "Telecaller" : apps.includes("sales") ? "Sales manager" : "Staff";
      return [r.user_id, word];
    }),
  );
}

export async function companyPayload(p: PeriodState): Promise<CompanyPayload> {
  const r = await readCompany(p);
  const o = r.owner;
  const isFy = p.key === "ytd";
  const prevLine = isFy ? "vs last FY" : "vs previous period";

  const card = (
    key: string,
    label: string,
    cur: number | null,
    prev: number | null,
    ly: number | null,
    value: string,
    opts: { rate?: boolean; note?: string; bars: Bar[]; goodWhenUp?: boolean },
  ): PeriodCard => {
    const c = change(cur, prev, opts.rate);
    const lyTxt = isFy ? null : signedChange(cur, ly, opts.rate);
    return {
      key,
      label,
      value,
      chg: c.text,
      chgGood: c.up === null ? null : opts.goodWhenUp === false ? !c.up : c.up,
      prevLine,
      lyLine: isFy ? "" : lyTxt ? `Same dates last year: ${lyTxt}` : "Same dates last year: no comparison",
      note: opts.note,
      bars: opts.bars,
    };
  };

  const months = r.months;
  const monthRev = (m: string) => {
    const s = r.trend.sales.get(m);
    return s ? Number(s.revenue) - (r.trend.notes.get(m) ?? 0) : 0;
  };
  const monthOrders = (m: string) => Number(r.trend.sales.get(m)?.orders ?? 0);
  const monthCust = (m: string) => Number(r.trend.sales.get(m)?.customers ?? 0);
  const monthBill = (m: string) => {
    const n = monthOrders(m);
    return n ? monthRev(m) / n : null;
  };
  // Conversion by creation-month cohort, each followed forward its own window.
  const cohorts = new Map<string, typeof r.cohortLeads>();
  for (const l of r.cohortLeads) {
    const k = l.createdOn.slice(0, 7);
    const list = cohorts.get(k) ?? [];
    list.push(l);
    cohorts.set(k, list);
  }
  const monthConv = (m: string) => {
    const c = cohorts.get(m);
    return c && c.length ? conversionFor(c, p.today, r.config).ratePercent : null;
  };

  const b = o.billSize;
  const conv = o.conversion.current;
  const windowDays = r.config["owner.conversionWindowDays"];
  const convNote =
    conv.leads === 0
      ? "No leads were created in this period."
      : `${conv.stillOpen > 0 ? `Unfinished: ${num(conv.stillOpen)} of ${num(conv.leads)} leads are still inside their ${windowDays}-day window. ` : ""}${conv.qualified === 0 ? "No lead in it has been qualified yet." : `Qualified-lead rate ${conv.qualifiedRatePercent == null ? "—" : conv.qualifiedRatePercent.toFixed(1) + "%"}.`}`;

  const litres = (ml: number) => ml / 1000;
  const cards: PeriodCard[] = [
    card("rev", "Revenue", b.current.netValuePaise, b.previous?.netValuePaise ?? null, b.lastYear?.netValuePaise ?? null, crore(b.current.netValuePaise), {
      bars: bars(months, monthRev, crore),
    }),
    card("vol", "Volume", litres(r.volNow.millilitres), litres(r.volBefore.millilitres), litres(r.volLy.millilitres), `${num(Math.round(litres(r.volNow.millilitres)))} L`, {
      note: r.volNow.unmatchedPaise > 0 ? `${crore(r.volNow.unmatchedPaise)} of lines could not be matched to a pack size and have no litres.` : undefined,
      bars: bars(months, (m) => litres(r.volTrend.byMonth[m] ?? 0), (v) => `${num(Math.round(v))} L`),
    }),
    card("orders", "Orders", b.current.transactions, b.previous?.transactions ?? null, b.lastYear?.transactions ?? null, num(b.current.transactions), {
      bars: bars(months, monthOrders, (v) => num(v)),
    }),
    card("cust", "Customers who ordered", o.frequency.current.activeCustomers, o.frequency.previous?.activeCustomers ?? null, o.frequency.lastYear?.activeCustomers ?? null, num(o.frequency.current.activeCustomers), {
      bars: bars(months, monthCust, (v) => num(v)),
    }),
    card("bill", "Average bill size", b.current.averagePaise, b.previous?.averagePaise ?? null, b.lastYear?.averagePaise ?? null, b.current.averagePaise == null ? "—" : crore(b.current.averagePaise), {
      bars: bars(months, monthBill, crore),
    }),
    card("newc", "New customers won", r.newNow, r.newBefore, r.newLy, num(r.newNow), {
      bars: bars(months, (m) => r.trend.newc.get(m) ?? 0, (v) => num(v)),
    }),
    card("coll", "Collected", r.colNow, r.colBefore, r.colLy, crore(r.colNow), {
      bars: bars(months, (m) => r.trend.collected.get(m) ?? 0, crore),
    }),
    card("conv", "Lead-to-order conversion", conv.ratePercent, o.conversion.previous?.ratePercent ?? null, o.conversion.lastYear?.ratePercent ?? null, conv.ratePercent == null ? "—" : `${conv.ratePercent.toFixed(1)}%`, {
      rate: true,
      note: convNote,
      bars: bars(months, monthConv, (v) => `${v.toFixed(1)}%`),
    }),
  ];

  /* ---- pace for the month: targets excl. GST, as targets are set ---- */
  const scored = r.readings.filter((x) => x.hasTarget);
  const doneNet = r.readings.reduce((s, x) => s + x.actuals.revenuePaise, 0);
  const target = scored.reduce((s, x) => s + (x.score.components.find((c) => c.key === "revenue")?.target ?? 0), 0);
  const projectedAll = r.days.elapsed > 0 ? Math.round((doneNet / r.days.elapsed) * r.days.total) : null;
  const left = Math.max(0, r.days.total - r.days.elapsed);
  const shortfall = target > 0 && projectedAll != null ? Math.max(0, target - projectedAll) : null;
  const needPerDay = target > 0 && left > 0 ? Math.max(0, (target - doneNet) / left) : null;
  const soFarPerDay = r.days.elapsed > 0 ? doneNet / r.days.elapsed : null;
  const monthName = monthLong(p.monthKey);
  const monthEnd = endOfMonthKey(p.monthKey);
  const scale = Math.max(target, projectedAll ?? 0, doneNet, 1);
  const pace: CompanyPayload["pace"] = {
    title: `Pace for ${monthName}`,
    badge: `Month · ${r.days.elapsed} of ${r.days.total} working days`,
    hasTarget: target > 0,
    figures: [
      {
        label: `Projected to ${fmtDate(monthEnd).replace(/ \d{4}$/, "")}`,
        value: projectedAll == null ? "—" : crore(projectedAll),
        sub: projectedAll == null ? "no working day finished yet" : "at the current working-day pace",
      },
      {
        label: "Shortfall",
        value: target === 0 ? "No target" : shortfall == null ? "—" : crore(shortfall),
        sub: target === 0 ? "nobody holds a published target this month" : `against ${crore(target)} of targets`,
        tone: target > 0 && (shortfall ?? 0) > 0 ? "bad" : undefined,
      },
      {
        label: "Needed per working day",
        value: needPerDay == null ? "—" : crore(needPerDay),
        sub:
          needPerDay == null
            ? target === 0
              ? "set in Targets & performance"
              : "no working days left"
            : `for the ${plural(left, "day")} left, vs ${soFarPerDay == null ? "—" : crore(soFarPerDay)} so far`,
        tone: needPerDay != null && soFarPerDay != null && needPerDay > soFarPerDay ? "warn" : undefined,
      },
    ],
    donePct: Math.round((doneNet / scale) * 100),
    projectedPct: Math.round(((projectedAll ?? doneNet) / scale) * 100),
    targetPct: target > 0 ? Math.round((target / scale) * 100) : 0,
    leftLine: `Done ${crore(doneNet)}${projectedAll != null ? ` · projected ${crore(projectedAll)}` : ""}`,
    rightLine: target > 0 ? `Target ${crore(target)}, excl. GST as targets are set` : "No published target, excl. GST as targets are set",
  };

  /* ---- what moved revenue against the comparison period ---- */
  const movers = await revenueMovers(p);

  /* ---- as of now ---- */
  const aging = r.home.aging;
  const overdue = aging.buckets.filter((x) => x.from >= 0).reduce((s, x) => s + x.amount, 0);
  const ret = o.retention;
  const prevRet = o.previousRetention;
  const active = ret.total;
  const moveLine = prevRet
    ? `${ret.counts.active - prevRet.counts.active >= 0 ? "▲" : "▼"} ${num(Math.abs(ret.counts.active - prevRet.counts.active))} Healthy · ${ret.counts["at-risk"] - prevRet.counts["at-risk"] >= 0 ? "▲" : "▼"} ${num(Math.abs(ret.counts["at-risk"] - prevRet.counts["at-risk"]))} Slowing since the last month end`
    : `${num(ret.counts.active)} Healthy · ${num(ret.counts["at-risk"])} Slowing · no month-end snapshot to compare with yet`;
  const lastSync = r.people.lastSync?.at ?? null;
  const hrAgeDays = lastSync ? Math.floor((Date.now() - new Date(lastSync).getTime()) / 86_400_000) : null;
  const avgScore = scored.length ? Math.round(scored.reduce((s, x) => s + x.score.totalBp, 0) / scored.length / 100) : null;
  const goodPlus = scored.filter((x) => x.score.totalBp >= 7000).length;

  const now: CompanyPayload["now"] = [
    {
      key: "out",
      label: "Outstanding (stated)",
      value: crore(aging.total),
      sub: `${aging.total ? Math.round((overdue / aging.total) * 100) : 0}% overdue · ${crore(r.unstated.v)} unstated, not counted`,
      warn: r.unstated.v > 0,
    },
    { key: "act", label: "Active customers", value: num(active), sub: moveLine },
    {
      key: "q",
      label: "Accounts queues",
      value: num(r.home.orders.count + r.home.payments.count),
      sub: `${plural(r.home.orders.count, "order")} to approve · ${plural(r.home.payments.count, "payment")} to confirm`,
    },
    {
      key: "hc",
      label: "Headcount",
      value: num(r.people.summary.active),
      sub: lastSync ? `HR sheet as of ${fmtDate(lastSync.slice(0, 10))}${hrAgeDays && hrAgeDays > 1 ? ` — ${hrAgeDays} days old` : ""}` : "The HR sheet has never been read",
      warn: !lastSync || (hrAgeDays ?? 0) > 1,
    },
    {
      key: "ts",
      label: `Team score, ${monthName}`,
      value: avgScore == null ? "—" : String(avgScore),
      sub: scored.length ? `Month · ${num(goodPlus)} of ${num(scored.length)} at Good or above` : "Month · nobody holds a published target yet",
    },
  ];

  /* ---- top of the team ---- */
  const ranked = rankPerformance(
    r.readings.map((x) => ({ ...x, totalBp: x.score.totalBp, revenuePaise: x.actuals.revenuePaise })),
  ).filter((x) => x.rank !== null);
  const top = ranked.slice(0, 3);
  const roles = await roleWords(top.map((t) => t.userId));
  const topTeam = top.map((t) => ({
    rank: `#${t.rank}`,
    name: t.userName,
    role: roles.get(t.userId) ?? "Staff",
    score: String(Math.round(t.totalBp / 100)),
    initials: initials(t.userName),
  }));

  const ua = r.unattr;
  return {
    cards,
    pace,
    moversTitle: `Why revenue moved against ${span(p.compareFrom, p.compareTo)}`,
    movers,
    nowAsOf: stampIST(new Date()),
    now,
    topTeam,
    topTeamMonthLine: `Month · ${monthName}, the month the period ends in`,
    teamAllLabel: `All ${num(ranked.length)} →`,
    unattributed:
      ua.customers > 0
        ? {
            line: `${crore(ua.revenuePaise)} of this period's revenue is not counted towards anybody — ${plural(ua.customers, "customer")} ${ua.customers === 1 ? "has" : "have"} no salesperson and no back-office person.`,
            button: `See the ${plural(ua.customers, "customer")}`,
          }
        : null,
  };
}

/** The five largest movements in revenue, by person, customer and formulation. */
async function revenueMovers(p: PeriodState): Promise<CompanyPayload["movers"]> {
  const rows = await db.execute<{ kind: string; name: string; d: string }>(sql`
    with cur as (
      select o.customer_id, ${creditedToSql("c")} as person, sum(o.total_amount) as v
        from orders o join customers c on c.id = o.customer_id
       where ${orderCountsSql("o")} and o.ordered_at >= ${IST_START(p.from)} and o.ordered_at <= ${IST_END(p.to)}
       group by 1, 2
    ),
    prev as (
      select o.customer_id, ${creditedToSql("c")} as person, sum(o.total_amount) as v
        from orders o join customers c on c.id = o.customer_id
       where ${orderCountsSql("o")} and o.ordered_at >= ${IST_START(p.compareFrom)} and o.ordered_at <= ${IST_END(p.compareTo)}
       group by 1, 2
    ),
    by_customer as (
      select coalesce(cur.customer_id, prev.customer_id) as id,
             coalesce(cur.v, 0) - coalesce(prev.v, 0) as d
        from cur full join prev on prev.customer_id = cur.customer_id
    ),
    by_person as (
      select person as id, sum(v) as v from cur where person is not null group by person
    ),
    by_person_prev as (
      select person as id, sum(v) as v from prev where person is not null group by person
    )
    select 'Customer' as kind, cu.name, bc.d::text as d
      from by_customer bc join customers cu on cu.id = bc.id
     where bc.d <> 0
    union all
    select 'Person' as kind, u.name, (coalesce(a.v, 0) - coalesce(b.v, 0))::text as d
      from by_person a full join by_person_prev b on b.id = a.id
      join users u on u.id = coalesce(a.id, b.id)
     where coalesce(a.v, 0) - coalesce(b.v, 0) <> 0
  `);
  const all = rows.map((r) => ({ kind: r.kind, name: r.name, d: Number(r.d) }));
  const up = all.filter((m) => m.d > 0).sort((a, b) => b.d - a.d).slice(0, 3);
  const down = all.filter((m) => m.d < 0).sort((a, b) => a.d - b.d).slice(0, 2);
  const picked = [...up, ...down].slice(0, 5);
  return picked.map((m) => ({ ...m, val: (m.d >= 0 ? "+" : "") + crore(m.d) }));
}

/* ---------------------------------------------------------------- drawers */

const DEFS: Record<string, { label: string; def: string; src: string; section: import("./types").SectionKey; rate?: boolean }> = {
  rev: { label: "Revenue", def: "Every counting order in the period, with GST, less credit notes raised in it. Cancelled, declined and pending-approval orders do not count. Credit goes to the salesperson on the account, falling back to the back-office person.", src: "Orders, credit notes", section: "sales" },
  vol: { label: "Volume", def: "Cans multiplied by the millilitres per can of each SKU, for lines matched to a product. Unmatched value is stated beside it, never guessed.", src: "Order lines, product master", section: "sales" },
  orders: { label: "Orders", def: "Count of counting orders placed in the period — approved and in progress, never pending approval, cancelled or declined.", src: "Orders", section: "sales" },
  cust: { label: "Customers who ordered", def: "Distinct customers with at least one counting order in the period.", src: "Orders", section: "customers" },
  bill: { label: "Average bill size", def: "Net value divided by orders, with GST, net of credit notes. A negative figure means credit notes exceeded sales and keeps its sign.", src: "Orders, credit notes", section: "sales" },
  newc: { label: "New customers won", def: "Customers whose first ever counting order falls inside the period.", src: "Orders", section: "customers" },
  coll: { label: "Collected", def: "Confirmed receipts dated in the period. Reported and held payments are not money yet and are shown on their own. Credit notes and adjustments are not money arriving.", src: "Payment receipts", section: "money" },
  conv: { label: "Lead-to-order conversion", def: "Of the leads created in the period, the share that placed a first order within the conversion window. A cohort whose window has not closed is unfinished, not failing.", src: "Leads, orders", section: "leads", rate: true },
};

export async function companyFigure(p: PeriodState, key: string): Promise<FigureDrawer> {
  const payload = await companyPayload(p);
  const card = payload.cards.find((c) => c.key === key);
  const period = span(p.from, p.to);
  if (card) {
    const d = DEFS[key]!;
    const rows = await recordsBehind(p, key);
    return {
      kind: "Period figure",
      title: d.label,
      value: card.value,
      facts: [
        { label: "Kind", value: "Follows the period" },
        { label: "Period", value: period },
        { label: "Basis", value: d.rate ? "Rate — change in points" : key === "rev" || key === "bill" || key === "coll" ? "With GST" : "Count — change in percent" },
        { label: "Scope", value: "Company-wide · every customer" },
        { label: "Source", value: d.src },
        { label: "As of", value: stampIST(new Date()) },
      ],
      def: d.def,
      bars: card.bars,
      barsLabel: "Last 12 months",
      rowsLabel: rows.label,
      rows: rows.rows,
      noRowsLine: rows.rows.length ? undefined : "Nothing in this period.",
      section: d.section,
      sectionLabel: `Open ${SECTION_TITLE[d.section]}`,
    };
  }
  const nowRow = payload.now.find((n) => n.key === key);
  const NOW: Record<string, { def: string; src: string; section: import("./types").SectionKey; kind: string }> = {
    out: { def: "Every stated bill’s balance after confirmed receipts. Unstated bills — raised but not yet stated to the customer — are counted on their own, never added to debt.", src: "Bills, confirmed receipts", section: "money", kind: "Now" },
    act: { def: "Customers with a health band today: not deactivated, not third-party, with a last order and a measured buying cycle. A customer who has never ordered has no band.", src: "Customer health", section: "customers", kind: "Now" },
    q: { def: "Orders waiting for approval and payments reported but not yet confirmed against the bank.", src: "Accounts", section: "money", kind: "Now" },
    hc: { def: "Active employees on the HR sheet at its last sync. Its age is always stated.", src: "HR sheet", section: "people", kind: "Now" },
    ts: { def: "The average score of everyone holding a published target for the month. Targets are set per month, so this figure is monthly whatever the period.", src: "Performance", section: "team", kind: "Month" },
  };
  if (nowRow && NOW[key]) {
    const n = NOW[key]!;
    const rows = await recordsBehind(p, key);
    return {
      kind: `${n.kind} figure`,
      title: nowRow.label,
      value: nowRow.value,
      facts: [
        { label: "Kind", value: n.kind === "Now" ? "As of now" : `Month · ${monthLong(p.monthKey)}` },
        { label: "Period", value: n.kind === "Now" ? stampIST(new Date()) : span(`${p.monthKey}-01`, p.to) },
        { label: "Basis", value: key === "out" ? "With GST" : "Count" },
        { label: "Scope", value: "Company-wide · every customer" },
        { label: "Source", value: n.src },
        { label: "As of", value: stampIST(new Date()) },
      ],
      def: n.def,
      bars: [],
      barsLabel: "No history is kept for this figure",
      rowsLabel: rows.label,
      rows: rows.rows,
      noRowsLine: rows.rows.length ? undefined : "Nothing to list.",
      section: n.section,
      sectionLabel: `Open ${SECTION_TITLE[n.section]}`,
    };
  }
  if (key === "unattr") {
    const rows = await recordsBehind(p, key);
    return {
      kind: "Period figure",
      title: "Unattributed revenue",
      value: payload.unattributed ? payload.unattributed.line.split(" of ")[0]! : "₹0",
      facts: [
        { label: "Kind", value: "Follows the period" },
        { label: "Period", value: period },
        { label: "Basis", value: "With GST" },
        { label: "Scope", value: "Company-wide · every customer" },
        { label: "Source", value: "Orders, customer seats" },
        { label: "As of", value: stampIST(new Date()) },
      ],
      def: "Revenue from customers with neither a salesperson nor a back-office person. It is counted in the company total but towards nobody’s score.",
      bars: [],
      barsLabel: "No history is kept for this figure",
      rowsLabel: `The ${plural(rows.rows.length, "customer")}`,
      rows: rows.rows,
      section: "customers",
      sectionLabel: "Open Customers",
    };
  }
  throw new Error("No such figure.");
}

export const SECTION_TITLE: Record<import("./types").SectionKey, string> = {
  company: "Company",
  inbox: "Needs you",
  sales: "Sales & order book",
  team: "Targets & performance",
  customers: "Customers",
  leads: "Leads, samples & distributors",
  enquiries: "Website enquiries",
  calling: "Calling operations",
  field: "Field force",
  service: "Service",
  money: "Money",
  prices: "Price lists",
  whatsapp: "WhatsApp",
  people: "People & organisation",
  system: "Data operations & health",
};

/** Up to eight of the records behind a Company figure. */
async function recordsBehind(p: PeriodState, key: string): Promise<{ label: string; rows: { a: string; b: string; c: string }[] }> {
  const inRange = sql`o.ordered_at >= ${IST_START(p.from)} and o.ordered_at <= ${IST_END(p.to)}`;
  if (key === "rev" || key === "orders" || key === "bill" || key === "vol") {
    const rows = await db.execute<{ id: string; name: string; at: string; who: string | null; v: string; sheet: string | null }>(sql`
      select o.id, c.name, to_char(o.ordered_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as at,
             u.name as who, o.total_amount::text as v, o.order_no as sheet
        from orders o join customers c on c.id = o.customer_id
        left join users u on u.id = ${creditedToSql("c")}
       where ${orderCountsSql("o")} and ${inRange}
       order by o.total_amount desc limit 8
    `);
    return {
      label: "Orders behind it · largest first",
      rows: rows.map((r) => ({ a: r.sheet ? `Order ${r.sheet}` : r.name, b: `${r.name} · ${fmtDate(r.at)} · ${r.who ?? "Unattributed"}`, c: crore(Number(r.v)) })),
    };
  }
  if (key === "cust" || key === "newc") {
    const rows = await db.execute<{ name: string; city: string | null; n: number; v: string }>(sql`
      select c.name, c.city, count(*)::int as n, sum(o.total_amount)::text as v
        from orders o join customers c on c.id = o.customer_id
       where ${orderCountsSql("o")} and ${inRange}
       group by c.id, c.name, c.city order by sum(o.total_amount) desc limit 8
    `);
    return { label: "Customers behind it · by value", rows: rows.map((r) => ({ a: r.name, b: `${r.city ?? "City not recorded"} · ${plural(r.n, "order")}`, c: crore(Number(r.v)) })) };
  }
  if (key === "coll") {
    const rows = await db.execute<{ name: string; at: string; mode: string; v: string }>(sql`
      select c.name, to_char(r.received_at, 'YYYY-MM-DD') as at, r.mode, r.amount::text as v
        from payment_receipts r join customers c on c.id = r.customer_id
       where ${moneyArrivingSql("r")}
         and r.received_at >= ${sql.raw(`'${p.from}'::date`)} and r.received_at <= ${sql.raw(`'${p.to}'::date`)}
       order by r.amount desc limit 8
    `);
    return { label: "Receipts behind it · largest first", rows: rows.map((r) => ({ a: r.name, b: `${fmtDate(r.at)} · ${r.mode}`, c: crore(Number(r.v)) })) };
  }
  if (key === "conv") {
    const leads = await leadsCreatedIn({ from: p.from as BusinessDate, to: p.to as BusinessDate }, {});
    return {
      label: "Leads in the cohort",
      rows: leads.slice(0, 8).map((l) => ({ a: l.customerId ? l.city ?? "Lead" : "Lead", b: `Created ${fmtDate(l.createdOn)} · ${l.ownerName ?? "Nobody"}`, c: l.firstOrderOn ? `Ordered ${fmtDate(l.firstOrderOn)}` : "No order yet" })),
    };
  }
  if (key === "out") {
    const rows = await db.execute<{ name: string; owes: string; bills: number }>(sql`
      select c.name, sum(b.amount - b.paid_amount)::text as owes, count(*)::int as bills
        from bills b join customers c on c.id = b.customer_id
       where b.payment_position = 'stated' and b.amount > b.paid_amount
       group by c.id, c.name order by sum(b.amount - b.paid_amount) desc limit 8
    `);
    return { label: "Largest balances", rows: rows.map((r) => ({ a: r.name, b: plural(r.bills, "open bill"), c: crore(Number(r.owes)) })) };
  }
  if (key === "unattr") {
    const rows = await db.execute<{ name: string; city: string | null; n: number; v: string }>(sql`
      select c.name, c.city, count(*)::int as n, sum(o.total_amount)::text as v
        from orders o join customers c on c.id = o.customer_id
       where ${orderCountsSql("o")} and ${inRange} and ${creditedToSql("c")} is null
       group by c.id, c.name, c.city order by sum(o.total_amount) desc
    `);
    return { label: "Customers", rows: rows.map((r) => ({ a: r.name, b: `${r.city ?? "City not recorded"} · ${plural(r.n, "order")}`, c: crore(Number(r.v)) })) };
  }
  if (key === "q") {
    const rows = await db.execute<{ name: string; v: string; at: string }>(sql`
      select c.name, o.total_amount::text as v, to_char(o.created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as at
        from orders o join customers c on c.id = o.customer_id
       where o.status = 'pending_approval' order by o.created_at limit 8
    `);
    return { label: "Orders waiting on approval · oldest first", rows: rows.map((r) => ({ a: r.name, b: `Taken ${fmtDate(r.at)}`, c: crore(Number(r.v)) })) };
  }
  if (key === "ts") {
    const readings = await readingsForPeriod(p.monthKey, p.today as BusinessDate, {});
    const ranked = rankPerformance(readings.map((x) => ({ ...x, totalBp: x.score.totalBp, revenuePaise: x.actuals.revenuePaise }))).filter((x) => x.rank !== null);
    return { label: "Everyone scored", rows: ranked.slice(0, 8).map((x) => ({ a: x.userName, b: x.rating, c: String(Math.round(x.totalBp / 100)) })) };
  }
  return { label: "Records behind it", rows: [] };
}
