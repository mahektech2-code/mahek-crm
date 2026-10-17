import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { moneyArrivingSql } from "@/lib/money-arriving";
import { addMonths, endOfMonth } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { orderCountsSql } from "@/lib/order-status";
import { creditedToSql } from "@/lib/sales-attribution";
import { publishSalesTarget, saveSalesTarget } from "@/lib/actions/sales-targets";
import { founderTeamPerformance, type RankedReading } from "@/lib/services/founder-dashboard-service";
import { workingDaysIn } from "@/lib/services/performance-service";
import { revisionsFor, targetableCandidates, type TargetRow } from "@/lib/services/sales-target-service";
import {
  auditFor,
  emptyPage,
  notesFor,
  refusal,
  fromOwning,
  slice,
  stampIST,
  withPage,
  type Ctx,
  type SectionProvider,
  type TableQuery,
} from "../provider";
import { change, crore, fmtDate, inr, monthLabel, monthLong, monthShort, num, plural } from "../format";
import type {
  ActSpec,
  Callout,
  Cell,
  Fact,
  FigureDrawer,
  FormSpec,
  Metric,
  RecordView,
  Result,
  Row,
  TableDef,
  TablePage,
  Tone,
} from "../types";

/* ---------------------------------------------------------------------------
 * TARGETS & TEAM PERFORMANCE (PRD §10).
 *
 * The month the period ends in, because targets are set per month. Every
 * score is `founderTeamPerformance` — `readingsForPeriod` ranked, the same
 * reading `/sales/performance` shows a manager — and every write is the Sales
 * Dashboard's own `publishSalesTarget` / `saveSalesTarget`, so a revision
 * made here carries its reason code, notifies the person and lands in the
 * revision history exactly as one made there does.
 *
 * Performance money is EXCL. GST, as targets are set; everything else in the
 * Command Centre is with GST, and each figure says which.
 * ------------------------------------------------------------------------- */

const TITLE = "Targets & team performance";
const SCOPE = "Company-wide · everyone who sells";
const EXCL = "excl. GST, as targets are set";

/* ----------------------------------------------------------------- people */

type PersonFacts = { role: string; sub: string };

function roleWord(apps: string[], level: string): string {
  if (apps.includes("field")) return "Field";
  // role-name-ok: the job title on screen, not a stored role
  if (apps.includes("crm")) return level === "associate" ? "Telecaller" : "CRM manager";
  if (apps.includes("accounts")) return "Accounts";
  if (apps.includes("sales")) return "Sales manager";
  return "Back office";
}

/**
 * Role and a second line for each person: where they work, and who they
 * report to — from the HR sheet where their email matches, else the
 * reporting line on their account.
 */
async function peopleFacts(ids: string[]): Promise<Map<string, PersonFacts>> {
  const out = new Map<string, PersonFacts>();
  if (!ids.length) return out;
  const rows = await db.execute<{
    id: string;
    level: string;
    apps: string[] | null;
    place: string | null;
    reports_to: string | null;
  }>(sql`
    select u.id, u.role::text as level,
           (select array_agg(a.app::text) from app_access a where a.user_id = u.id) as apps,
           e.place, coalesce(e.reports_to, m.name) as reports_to
      from users u
      left join users m on m.id = u.reports_to_id
      left join lateral (
        select coalesce(nullif(emp.area_allocated, ''), nullif(emp.office_name, '')) as place,
               nullif(emp.reports_to, '') as reports_to
          from employees emp
         where u.email is not null and lower(emp.email) = lower(u.email)
         order by (emp.status = 'active') desc
         limit 1
      ) e on true
     where u.id in (${sql.join(
       ids.map((i) => sql`${i}`),
       sql`, `,
     )})
  `);
  for (const r of rows) {
    const apps = Array.isArray(r.apps) ? r.apps : [];
    out.set(r.id, {
      role: roleWord(apps, r.level),
      sub: [r.place, r.reports_to ? `reports to ${r.reports_to}` : null].filter(Boolean).join(" · "),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ read */

type MonthTarget = { userId: string; targetId: string; status: string; revenue: number | null };

async function targetsFor(period: string): Promise<Map<string, MonthTarget>> {
  const rows = await db.execute<{ user_id: string; id: string; status: string; revenue: string | null }>(sql`
    select t.user_id, t.id, t.status::text as status, t.revenue_target_paise as revenue
      from sales_targets t
     where t.period = ${period}
  `);
  return new Map(
    rows.map((r) => [
      r.user_id,
      { userId: r.user_id, targetId: r.id, status: r.status, revenue: r.revenue === null ? null : Number(r.revenue) },
    ]),
  );
}

function monthWin(key: string, upTo?: string) {
  const end = endOfMonth(key);
  const to = upTo && upTo < end ? upTo : end;
  return {
    start: sql.raw(`'${key}-01 00:00:00+05:30'::timestamptz`),
    end: sql.raw(`'${to} 23:59:59.999+05:30'::timestamptz`),
    fromDate: sql.raw(`'${key}-01'::date`),
    toDate: sql.raw(`'${to}'::date`),
  };
}

async function readTeam(ctx: Ctx) {
  const month = ctx.period.monthKey;
  const next = addMonths(month, 1);
  const prev = addMonths(month, -1);
  const w = monthWin(month, ctx.period.today);
  const [config, rankedAll, candidates, monthTargets, prevScores, money, days] = await Promise.all([
    getConfig(),
    founderTeamPerformance(month, ctx.period.today),
    targetableCandidates(next),
    targetsFor(month),
    db.execute<{ user_id: string; score: number }>(sql`
      select sp.user_id, sp.total_score_bp as score
        from sales_performance sp
       where sp.period = ${prev} and sp.target_id is not null
    `),
    db.execute<{ collected: string; receipts: number; new_customers: number }>(sql`
      select
        (select coalesce(sum(r.amount), 0) from payment_receipts r
          where ${moneyArrivingSql("r")}
            and r.received_at >= ${w.fromDate} and r.received_at <= ${w.toDate}) as collected,
        (select count(*)::int from payment_receipts r
          where ${moneyArrivingSql("r")}
            and r.received_at >= ${w.fromDate} and r.received_at <= ${w.toDate}) as receipts,
        (select count(*)::int from (
           select o.customer_id, min(o.ordered_at) as first_at
             from orders o
            where ${orderCountsSql("o")}
            group by o.customer_id
         ) f where f.first_at >= ${w.start} and f.first_at <= ${w.end}) as new_customers
    `),
    workingDaysIn(month, ctx.period.today),
  ]);
  /* Unranked people have no score to sort by; the most revenue first is the
     order somebody reads them in. `rankPerformance` keeps the ranked ones. */
  const ranked = [
    ...rankedAll.filter((r) => r.rank !== null),
    ...rankedAll.filter((r) => r.rank === null).sort((a, b) => b.actuals.revenuePaise - a.actuals.revenuePaise),
  ];
  const ids = [...new Set([...ranked.map((r) => r.userId), ...candidates.map((c) => c.userId)])];
  const facts = await peopleFacts(ids);
  return {
    config,
    month,
    next,
    prev,
    ranked,
    candidates,
    monthTargets,
    prevScore: new Map(prevScores.map((p) => [p.user_id, Number(p.score)])),
    collected: Number(money[0]?.collected ?? 0),
    receipts: Number(money[0]?.receipts ?? 0),
    newCustomers: Number(money[0]?.new_customers ?? 0),
    days,
    facts,
  };
}

type Team = Awaited<ReturnType<typeof readTeam>>;

function goodBand(config: Team["config"]): { label: string; min: number } | null {
  const bands = [...config["performance.ratingBands"]].sort((a, b) => b.min - a.min);
  if (!bands.length) return null;
  const good = bands.find((b) => b.label.toLowerCase() === "good");
  return good ?? bands[Math.floor((bands.length - 1) / 2)];
}

function ratingTone(scoreBp: number, config: Team["config"]): Tone {
  const bands = [...config["performance.ratingBands"]].sort((a, b) => b.min - a.min);
  const good = goodBand(config);
  const score = scoreBp / 100;
  if (good && score >= good.min) return "good";
  const lowest = bands[bands.length - 1];
  if (lowest && bands.length > 1 && score < (bands[bands.length - 2]?.min ?? 0)) return "bad";
  return "warn";
}

const scored = (t: Team) => t.ranked.filter((r) => r.hasTarget);

function revenueTargetSum(t: Team): number {
  let sum = 0;
  for (const mt of t.monthTargets.values()) if (mt.status === "published" && mt.revenue !== null) sum += mt.revenue;
  return sum;
}

function metricsOf(t: Team, ctx: Ctx): Metric[] {
  const s = scored(t);
  const good = goodBand(t.config);
  const avg = s.length ? Math.round(s.reduce((a, r) => a + r.score.totalBp, 0) / s.length / 100) : null;
  const atGood = good ? s.filter((r) => r.score.totalBp / 100 >= good.min).length : 0;
  const revenue = t.ranked.reduce((a, r) => a + r.actuals.revenuePaise, 0);
  const target = revenueTargetSum(t);
  const monthName = monthLong(t.month);
  const left = t.days.total - t.days.elapsed;
  const closed = ctx.period.today > endOfMonth(t.month);
  return [
    {
      key: "score",
      label: "Team score",
      value: avg === null ? "None yet" : String(avg),
      sub: s.length
        ? good
          ? `${num(atGood)} of ${num(s.length)} at ${good.label} or above`
          : `${plural(s.length, "person", "people")} scored`
        : `nobody holds a published target for ${monthName}`,
      kind: "Month",
    },
    {
      key: "revenue",
      label: "Revenue",
      value: crore(revenue),
      sub: target ? `of ${crore(target)} · ${EXCL}` : `no revenue target published · ${EXCL}`,
      kind: "Month",
    },
    {
      key: "collected",
      label: "Collected",
      value: t.receipts ? crore(t.collected) : "None yet",
      sub: "confirmed receipts",
      kind: "Month",
    },
    {
      key: "new",
      label: "New customers",
      value: num(t.newCustomers),
      sub: closed ? `won in ${monthName}` : "won this month",
      kind: "Month",
    },
    {
      key: "days",
      label: "Working days",
      value: `${num(t.days.elapsed)} of ${num(t.days.total)}`,
      sub: closed ? `${monthName} is over` : `${num(left)} left in ${monthName}`,
      kind: "Month",
    },
  ];
}

/* --------------------------------------------------------------- callouts */

function noTargetLists(t: Team) {
  const drafts = t.ranked.filter((r) => !r.hasTarget && t.monthTargets.get(r.userId)?.status === "draft");
  const draftOnly = [...t.monthTargets.values()].filter((m) => m.status === "draft");
  const none = t.ranked.filter((r) => !r.hasTarget && !t.monthTargets.has(r.userId) && r.actuals.revenuePaise > 0);
  return { drafts, draftCount: draftOnly.length, none };
}

function calloutsOf(t: Team): Callout[] {
  const out: Callout[] = [];
  const { draftCount, none } = noTargetLists(t);
  if (draftCount || none.length) {
    const parts: string[] = [];
    if (draftCount) {
      parts.push(
        `${plural(draftCount, "person", "people")} ${draftCount === 1 ? "holds" : "hold"} only a draft target — shown as "target not yet published", not "no target set".`,
      );
    }
    if (none.length) {
      parts.push(`${plural(none.length, "person", "people")} ${none.length === 1 ? "sells" : "sell"} with no target at all.`);
    }
    out.push({ tone: "warn", text: parts.join(" "), act: "See who", figure: "no-target" });
  }
  const pnv = t.ranked.filter((r) => r.alerts.some((a) => a.key === "price-not-volume"));
  if (pnv.length === 1) {
    const r = pnv[0];
    const a = r.alerts.find((x) => x.key === "price-not-volume")!;
    out.push({
      tone: "bad",
      text: `${r.userName}: revenue without volume — ${a.message}`,
      act: `Open ${r.userName.split(/\s+/)[0]}`,
      href: `/sales/people/${r.userId}`,
    });
  } else if (pnv.length > 1) {
    out.push({
      tone: "bad",
      text: `${plural(pnv.length, "person", "people")} show revenue without volume — revenue at or above target on litres well below it, so the money came from price rather than from selling more.`,
      act: "See who",
      figure: "price-not-volume",
    });
  }
  return out;
}

/* ------------------------------------------------------------------ tables */

const VIEW_AS: ActSpec = { key: "viewas", label: "View as", done: "Viewed", viewAs: true };

function reviseForm(t: { next: string; reasons: string[] }, init?: Record<string, string>): FormSpec {
  return {
    title: `Revise the ${monthLong(t.next)} target`,
    sub: `Revenue, ${EXCL}. The other four figures and the mix stay as they are.`,
    submit: "Save the target",
    consequence: "A published target changes with its reason on the record, and the person is told.",
    fields: [
      { k: "revenue", label: `Revenue target for ${monthLong(t.next)}`, type: "money", req: true, hint: `In rupees, ${EXCL}.` },
      {
        k: "reason",
        label: "Why it is changing",
        type: "select",
        options: t.reasons.map((r) => ({ v: r, l: r })),
        cond: "needed once published",
      },
      { k: "note", label: "Anything to add", type: "area", ph: "What changed, in a sentence" },
    ],
    init,
  };
}

function targetsDef(t: { month: string; next: string; reasons: string[]; today?: string }): TableDef {
  const nextShort = monthShort(t.next);
  const begun = t.today !== undefined && t.today >= `${t.next}-01`;
  return {
    key: "targets",
    title: `Targets for ${monthLong(t.next)}`,
    hint: begun
      ? `Month · ${monthLong(t.next)} is under way · ${EXCL}`
      : `Month · publish before 1 ${nextShort} · ${EXCL}`,
    cols: [
      ["Person", "1.5fr"],
      ["Role", "1fr"],
      [monthLong(t.month), "1fr", true],
      [`${monthLong(t.next)} draft`, "1fr", true],
      ["Change", "0.7fr", true],
    ],
    noun: "person",
    plural: "people",
    rec: "Target",
    acts: [
      {
        key: "publish",
        label: "Publish",
        confirm: `Every listed person sees the target on their dashboard from 1 ${nextShort}.`,
        done: "Published",
      },
      { key: "revise", label: "Revise", done: "Revised", form: reviseForm(t) },
    ],
  };
}

function peopleDef(month: string): TableDef {
  return {
    key: "people",
    title: `Everyone who sells, ${monthLong(month)}`,
    hint: "Month · sorted by score · click a person for every component",
    cols: [
      ["Person", "1.6fr"],
      ["Role", "1fr"],
      ["Score", "0.6fr", true],
      ["Change", "0.6fr", true],
      ["Revenue", "1fr", true],
      ["Achieved", "0.7fr", true],
      ["Forecast", "0.9fr", true],
      ["Rating", "0.8fr"],
    ],
    noun: "person",
    plural: "people",
    rec: "Person",
    acts: [VIEW_AS],
    actW: "110px",
    min: 900,
  };
}

function targetRows(t: Team, list: TargetRow[]): Row[] {
  return list.map((c) => {
    const f = t.facts.get(c.userId);
    const current = t.monthTargets.get(c.userId);
    const currentRevenue = current?.status === "published" ? current.revenue : null;
    const nextCell: Cell =
      c.revenueTargetPaise === null
        ? { t: "—", sub: c.targetId ? "revenue not set" : "no target yet" }
        : {
            t: crore(c.revenueTargetPaise),
            sub: c.status === "published" ? "published" : c.carriedForward ? "carried forward" : "draft",
          };
    const chg: Cell =
      c.revenueTargetPaise === null
        ? { t: "—" }
        : currentRevenue === null
          ? { t: "First target", pill: "warn" }
          : { t: change(c.revenueTargetPaise, currentRevenue).text };
    return {
      id: c.userId,
      cells: [
        { t: c.userName, sub: f?.sub || undefined },
        { t: f?.role ?? "—" },
        { t: currentRevenue === null ? "—" : crore(currentRevenue) },
        nextCell,
        chg,
      ],
      acts: c.status === "published" ? ["revise"] : c.status === "draft" ? ["publish", "revise"] : ["revise"],
    };
  });
}

function peopleRows(t: Team, list: RankedReading[]): Row[] {
  return list.map((r) => {
    const f = t.facts.get(r.userId);
    const rev = r.score.components.find((c) => c.key === "revenue");
    const prev = t.prevScore.get(r.userId);
    const scoreNow = Math.round(r.score.totalBp / 100);
    const diff = prev === undefined ? null : scoreNow - Math.round(prev / 100);
    const draft = t.monthTargets.get(r.userId)?.status === "draft";
    return {
      id: r.userId,
      cells: [
        { t: r.userName, sub: f?.sub || undefined },
        { t: f?.role ?? "—" },
        { t: r.hasTarget ? String(scoreNow) : "—" },
        { t: !r.hasTarget || diff === null ? "" : diff === 0 ? "No change" : `${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)}` },
        { t: crore(r.actuals.revenuePaise) },
        { t: rev?.achievementBp == null ? "—" : `${Math.round(rev.achievementBp / 100)}%` },
        { t: r.revenueForecast.projected === null || !r.hasTarget ? "—" : crore(r.revenueForecast.projected) },
        r.hasTarget
          ? { t: r.rating, pill: ratingTone(r.score.totalBp, t.config) }
          : { t: draft ? "Target not published" : "No target set", pill: "muted" },
      ],
    };
  });
}

function pageFrom<T>(all: T[], query: TableQuery, match: (r: T, q: string) => boolean, rows: (l: T[]) => Row[]): TablePage {
  const s = slice(all, query, match);
  return { rows: rows(s.rows), count: s.count, total: s.total, page: s.page, size: query.size, q: query.q };
}

function targetsPage(t: Team, query: TableQuery): TablePage {
  return pageFrom(
    t.candidates,
    query,
    (c, q) => [c.userName, t.facts.get(c.userId)?.role ?? "", t.facts.get(c.userId)?.sub ?? ""].some((v) => v.toLowerCase().includes(q)),
    (l) => targetRows(t, l),
  );
}

function peoplePage(t: Team, query: TableQuery): TablePage {
  return pageFrom(
    t.ranked,
    query,
    (r, q) =>
      [r.userName, r.rating, t.facts.get(r.userId)?.role ?? "", t.facts.get(r.userId)?.sub ?? ""].some((v) =>
        v.toLowerCase().includes(q),
      ),
    (l) => peopleRows(t, l),
  );
}

/* ------------------------------------------------------------------ drawer */

const FIGURE_KEYS: Record<string, string> = {
  score: "score",
  "team score": "score",
  revenue: "revenue",
  collected: "collected",
  new: "new",
  "new customers": "new",
  days: "days",
  "working days": "days",
  "no-target": "no-target",
  "price-not-volume": "price-not-volume",
};

function twelve(month: string): string[] {
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) out.push(addMonths(month, -i));
  return out;
}

async function monthlySeries(key: string, months: string[], upTo: string): Promise<Map<string, number>> {
  const w = { start: monthWin(months[0]).start, end: monthWin(months[months.length - 1], upTo).end };
  const fromDate = sql.raw(`'${months[0]}-01'::date`);
  const toDate = monthWin(months[months.length - 1], upTo).toDate;
  const zone = sql.raw(`'Asia/Kolkata'`);
  let rows: { month: string; v: string | number }[] = [];
  if (key === "revenue") {
    rows = await db.execute<{ month: string; v: string }>(sql`
      select to_char(o.ordered_at at time zone ${zone}, 'YYYY-MM') as month,
             coalesce(sum(coalesce(o.net_amount_paise, o.total_amount)), 0) as v
        from orders o join customers c on c.id = o.customer_id
       where ${orderCountsSql("o")}
         and o.ordered_at >= ${w.start} and o.ordered_at <= ${w.end}
         and ${creditedToSql("c")} is not null
       group by 1
    `);
  } else if (key === "collected") {
    rows = await db.execute<{ month: string; v: string }>(sql`
      select to_char(r.received_at, 'YYYY-MM') as month, coalesce(sum(r.amount), 0) as v
        from payment_receipts r
       where ${moneyArrivingSql("r")}
         and r.received_at >= ${fromDate} and r.received_at <= ${toDate}
       group by 1
    `);
  } else if (key === "new") {
    rows = await db.execute<{ month: string; v: number }>(sql`
      select to_char(f.first_at at time zone ${zone}, 'YYYY-MM') as month, count(*)::int as v
        from (select o.customer_id, min(o.ordered_at) as first_at
                from orders o where ${orderCountsSql("o")} group by o.customer_id) f
       where f.first_at >= ${w.start} and f.first_at <= ${w.end}
       group by 1
    `);
  } else if (key === "score") {
    rows = await db.execute<{ month: string; v: string }>(sql`
      select sp.period as month, avg(sp.total_score_bp) as v
        from sales_performance sp
       where sp.target_id is not null
         and sp.period >= ${months[0]} and sp.period <= ${months[months.length - 1]}
       group by 1
    `);
  }
  return new Map(rows.map((r) => [r.month, Number(r.v)]));
}

const DEFS: Record<string, string> = {
  score: "The average score of everyone holding a published target for the month.",
  revenue:
    "The month's counting orders, net of GST where the order sheet stated it, credited to one person each — the salesperson on the account, falling back to the back-office person. Orders on accounts with neither are not in this figure. The target beside it is the sum of every published revenue target for the month.",
  collected:
    "Receipts accounts confirmed as received in the month, company-wide. Reported or held money is not counted, and neither is a credit note.",
  new: "Customers whose first ever counting order was placed in the month. Creating a lead is never counted.",
  days: "The configured working week, less the holidays the office keeps, in the month. Today is not counted as worked until it is over.",
  "no-target":
    "People holding only a draft target for the month, and people credited with sales this month who hold no target at all.",
  "price-not-volume":
    "People whose revenue is at or above target while their volume is well below it — the money came from price, not from selling more.",
};

async function figureFor(ctx: Ctx, metric: string): Promise<FigureDrawer> {
  const key = FIGURE_KEYS[metric.toLowerCase()] ?? "score";
  const t = await readTeam(ctx);
  const metrics = metricsOf(t, ctx);
  const months = twelve(t.month);
  const monthName = monthLabel(t.month);
  const facts = (basis: string, source: string): Fact[] => [
    { label: "Kind", value: "Month" },
    { label: "Month", value: monthName },
    { label: "Basis", value: basis },
    { label: "Scope", value: SCOPE },
    { label: "Source", value: source },
    { label: "As of", value: stampIST(new Date()) },
  ];

  if (key === "no-target" || key === "price-not-volume") {
    const { drafts, none } = noTargetLists(t);
    const list =
      key === "no-target"
        ? [
            ...drafts.map((r) => ({ a: r.userName, b: "Draft target, not yet published", c: crore(r.actuals.revenuePaise) })),
            ...none.map((r) => ({ a: r.userName, b: "No target at all", c: crore(r.actuals.revenuePaise) })),
          ]
        : t.ranked
            .filter((r) => r.alerts.some((a) => a.key === "price-not-volume"))
            .map((r) => {
              const rev = r.score.components.find((c) => c.key === "revenue")?.achievementBp;
              const vol = r.score.components.find((c) => c.key === "volume")?.achievementBp;
              return {
                a: r.userName,
                b: `Volume at ${vol == null ? "—" : Math.round(vol / 100) + "%"} of target`,
                c: `Revenue ${rev == null ? "—" : Math.round(rev / 100) + "%"}`,
              };
            });
    return {
      kind: "Month figure · People",
      title: key === "no-target" ? "Selling without a published target" : "Revenue without volume",
      value: plural(list.length, "person", "people"),
      facts: facts("People", "Sales targets and the month's scores"),
      def: DEFS[key],
      bars: [],
      barsLabel: "No history is kept for this figure",
      rowsLabel: "Who",
      rows: list.slice(0, 8),
      noRowsLine: list.length ? undefined : "Nobody, this month.",
      section: "team",
      sectionLabel: key === "no-target" ? `Targets for ${monthLong(t.next)}` : `Everyone who sells, ${monthLong(t.month)}`,
    };
  }

  const metricOf = metrics.find((m) => m.key === key)!;
  let bars: FigureDrawer["bars"] = [];
  let barsLabel = "The last 12 months, this month last (to date)";
  if (key === "days") {
    barsLabel = "No history is kept for this figure";
  } else {
    const series = await monthlySeries(key, months, ctx.period.today);
    if (key === "score") {
      const avg = scored(t).length ? scored(t).reduce((a, r) => a + r.score.totalBp, 0) / scored(t).length : 0;
      series.set(t.month, avg);
    }
    const word = (v: number) =>
      key === "score" ? (v ? String(Math.round(v / 100)) : "no one scored") : key === "new" ? plural(v, "customer") : crore(v);
    bars = months.map((m, i) => ({
      h: series.get(m) ?? 0,
      tip: `${monthLabel(m)} · ${word(series.get(m) ?? 0)}`,
      ...(i === months.length - 1 ? { current: true } : {}),
    }));
    if (key === "score") barsLabel = "Earlier months from the nightly score, this month read now";
  }

  let rows: FigureDrawer["rows"] = [];
  let rowsLabel = "";
  const w = monthWin(t.month, ctx.period.today);
  if (key === "score") {
    rowsLabel = "The highest scores this month";
    rows = scored(t)
      .slice(0, 8)
      .map((r) => ({ a: r.userName, b: r.rating, c: String(Math.round(r.score.totalBp / 100)) }));
  } else if (key === "revenue") {
    rowsLabel = "Who the revenue is credited to";
    rows = [...t.ranked]
      .sort((a, b) => b.actuals.revenuePaise - a.actuals.revenuePaise)
      .slice(0, 8)
      .map((r) => {
        const rev = r.score.components.find((c) => c.key === "revenue");
        return {
          a: r.userName,
          b: rev?.achievementBp == null ? "No revenue target" : `${Math.round(rev.achievementBp / 100)}% of ${crore(rev.target)}`,
          c: crore(r.actuals.revenuePaise),
        };
      });
  } else if (key === "collected") {
    rowsLabel = "The largest receipts confirmed this month";
    const top = await db.execute<{ name: string; mode: string; on: string; amount: string }>(sql`
      select c.name, r.mode, to_char(r.received_at, 'YYYY-MM-DD') as on, r.amount
        from payment_receipts r join customers c on c.id = r.customer_id
       where ${moneyArrivingSql("r")}
         and r.received_at >= ${w.fromDate} and r.received_at <= ${w.toDate}
       order by r.amount desc
       limit 8
    `);
    rows = top.map((x) => ({ a: x.name, b: `${x.mode} · ${fmtDate(x.on)}`, c: inr(Number(x.amount)) }));
  } else if (key === "new") {
    rowsLabel = "The newest customers won";
    const top = await db.execute<{ name: string; credited: string | null; on: string; value: string }>(sql`
      with f as (
        select distinct on (o.customer_id) o.customer_id, o.ordered_at, o.total_amount
          from orders o
         where ${orderCountsSql("o")}
         order by o.customer_id, o.ordered_at asc
      )
      select c.name, u.name as credited,
             to_char(f.ordered_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as on,
             f.total_amount as value
        from f join customers c on c.id = f.customer_id
        left join users u on u.id = ${creditedToSql("c")}
       where f.ordered_at >= ${w.start} and f.ordered_at <= ${w.end}
       order by f.ordered_at desc
       limit 8
    `);
    rows = top.map((x) => ({
      a: x.name,
      b: `${x.credited ?? "Unattributed"} · ${fmtDate(x.on)}`,
      c: inr(Number(x.value)),
    }));
  }

  const basis: Record<string, string> = {
    score: "Out of 100",
    revenue: `Money, ${EXCL}`,
    collected: "Money, confirmed only",
    new: "Count of customers",
    days: "Working days",
  };
  const source: Record<string, string> = {
    score: "Sales targets and the month's orders, receipts and tasks",
    revenue: "Orders, credited by the sales-attribution rule",
    collected: "Receipts accounts confirmed",
    new: "Orders — each customer's first counting one",
    days: "The working week and the office's holiday list",
  };

  return {
    kind: `Month figure · ${key === "revenue" || key === "collected" ? "Money" : key === "score" ? "Score" : "Count"}`,
    title: metricOf.label,
    value: metricOf.value,
    facts: facts(basis[key], source[key]),
    def: DEFS[key],
    bars,
    barsLabel,
    rowsLabel,
    rows,
    noRowsLine: key === "days" ? "No list of records sits behind a count of days." : rows.length ? undefined : "Nothing this month.",
    ...(key === "score" || key === "revenue"
      ? { section: "team" as const, sectionLabel: `Everyone who sells, ${monthLong(t.month)}` }
      : {}),
  };
}

/* ------------------------------------------------------------------ record */

async function targetRecord(ctx: Ctx, userId: string): Promise<RecordView> {
  const t = await readTeam(ctx);
  const c = t.candidates.find((x) => x.userId === userId);
  const f = t.facts.get(userId) ?? (await peopleFacts([userId])).get(userId);
  const name =
    c?.userName ??
    (await db.execute<{ name: string }>(sql`select name from users where id = ${userId}`))[0]?.name ??
    "Somebody no longer listed";
  const current = t.monthTargets.get(userId);
  const reasons = t.config["performance.revisionReasons"];
  const pct = (bp: number | null) => (bp === null ? "Not asked" : `${(bp / 100).toFixed(0)}%`);
  const fields: Fact[] = [
    { label: "Person", value: name },
    { label: "Role", value: f?.role ?? "—" },
    ...(f?.sub ? [{ label: "Works", value: f.sub }] : []),
    {
      label: `${monthLong(t.month)} revenue target`,
      value:
        current?.revenue == null
          ? "None"
          : `${crore(current.revenue)}${current.status === "published" ? "" : " — draft, never published"}`,
    },
    {
      label: `${monthLong(t.next)} target`,
      value: !c?.targetId
        ? "Not set yet"
        : c.status === "published"
          ? `Published ${c.publishedAt ? stampIST(c.publishedAt) : ""}`.trim()
          : c.carriedForward
            ? "Draft, carried forward from last month and not yet looked at"
            : "Draft, not yet published",
    },
    { label: `Revenue, ${EXCL}`, value: c?.revenueTargetPaise == null ? "Not asked" : inr(c.revenueTargetPaise) },
    { label: "Volume", value: c?.volumeTargetMl == null ? "Not asked" : `${num(Math.round(c.volumeTargetMl / 1000))} L` },
    { label: "New customers", value: c?.newCustomerTarget == null ? "Not asked" : num(c.newCustomerTarget) },
    { label: "Collection, of what was overdue at the start of the month", value: pct(c?.collectionTargetBp ?? null) },
    { label: "Tasks done, of those set", value: pct(c?.activityTargetBp ?? null) },
    ...(c?.bands ?? []).map((b) => ({
      label: `Mix — ${b.name}`,
      value: `minimum ${(b.minimumBp / 100).toFixed(0)}%, target ${(b.targetBp / 100).toFixed(0)}%, stretch ${(b.stretchBp / 100).toFixed(0)}%`,
    })),
    { label: "Revisions since publishing", value: num(c?.revisions ?? 0) },
  ];

  const [notes, revisions, audit] = await Promise.all([
    notesFor("user", userId),
    c?.targetId ? revisionsFor(c.targetId) : Promise.resolve([]),
    c?.targetId ? auditFor("sales_target", c.targetId) : Promise.resolve([]),
  ]);
  const acts: ActSpec[] = [];
  const init = {
    revenue: c?.revenueTargetPaise == null ? "" : String(Math.round(c.revenueTargetPaise / 100)),
    reason: "",
    note: "",
  };
  if (c?.status === "draft") acts.push(targetsDef({ ...t, reasons }).acts![0]);
  acts.push({ key: "revise", label: "Revise", done: "Revised", form: reviseForm({ next: t.next, reasons }, init) });

  return {
    kind: `Target · ${TITLE}`,
    title: name,
    sub: `${monthLong(t.next)} target · ${EXCL}`,
    fields,
    timeline: [
      ...notes,
      ...revisions.map((r) => ({
        what: `${r.field === "newCustomers" ? "New customers" : r.field.charAt(0).toUpperCase() + r.field.slice(1)} ${r.old_value ?? "not set"} → ${r.new_value ?? "not set"} — ${r.reason}${r.reason_note ? `: ${r.reason_note}` : ""}`,
        when: `${stampIST(r.changed_at)}${r.changed_by_name ? ` · ${r.changed_by_name}` : ""}`,
      })),
    ],
    audit,
    acts,
    href: { label: "Open Sales targets", url: "/sales/targets" },
    noteTarget: { kind: "user", id: userId },
  };
}

const COMPONENT_WORD: Record<string, string> = {
  revenue: "Revenue",
  volume: "Volume",
  mix: "Product mix",
  newCustomers: "New customers",
  collection: "Collection",
  activity: "Activity",
};

async function personRecord(ctx: Ctx, userId: string): Promise<RecordView> {
  const t = await readTeam(ctx);
  const r = t.ranked.find((x) => x.userId === userId);
  const f = t.facts.get(userId) ?? (await peopleFacts([userId])).get(userId);
  const name =
    r?.userName ??
    (await db.execute<{ name: string }>(sql`select name from users where id = ${userId}`))[0]?.name ??
    "Somebody no longer listed";
  const [notes, revisions, audit] = await Promise.all([
    notesFor("user", userId),
    r?.targetId ? revisionsFor(r.targetId) : Promise.resolve([]),
    r?.targetId ? auditFor("sales_target", r.targetId) : Promise.resolve([]),
  ]);
  const fields: Fact[] = [
    { label: "Person", value: name },
    { label: "Role", value: f?.role ?? "—" },
    ...(f?.sub ? [{ label: "Works", value: f.sub }] : []),
  ];
  if (r) {
    const money = (key: string, v: number) =>
      key === "revenue" || key === "collection" ? inr(v) : key === "volume" ? `${num(Math.round(v / 1000))} L` : num(v);
    fields.push(
      { label: "Rank", value: r.rank === null ? "Not ranked — no published target" : `${num(r.rank)} of ${num(scored(t).length)}` },
      { label: "Score", value: r.hasTarget ? `${(r.score.totalBp / 100).toFixed(1)} of 100 · ${r.rating}` : "No published target, so no score" },
    );
    for (const cmp of r.score.components) {
      const word = COMPONENT_WORD[cmp.key] ?? cmp.key;
      if (cmp.key === "mix") {
        fields.push({
          label: word,
          value: cmp.achievementBp == null ? "Not asked" : `${Math.round(cmp.achievementBp / 100)}% achieved · ${(cmp.pointsBp / 100).toFixed(1)} points`,
        });
        continue;
      }
      fields.push({
        label: word + (cmp.key === "revenue" ? `, ${EXCL}` : ""),
        value:
          cmp.achievementBp == null
            ? `${money(cmp.key, cmp.actual)} · not asked`
            : `${money(cmp.key, cmp.actual)} of ${money(cmp.key, cmp.target)} · ${Math.round(cmp.achievementBp / 100)}% · ${(cmp.pointsBp / 100).toFixed(1)} points`,
      });
    }
    for (const m of r.mix.categories) {
      fields.push({
        label: `Mix — ${m.name}`,
        value: `${(m.actualBp / 100).toFixed(1)}% of value, against ${(m.targetBp / 100).toFixed(0)}% asked`,
      });
    }
    if (r.hasTarget && r.score.untargeted.length) {
      fields.push({
        label: "Not asked this month",
        value: r.score.untargeted.map((k) => COMPONENT_WORD[k] ?? k).join(", ") + " — their weight is shared among the rest",
      });
    }
    if (r.hasTarget) fields.push(
      {
        label: "Revenue forecast",
        value:
          r.revenueForecast.projected === null
            ? "No forecast until a working day is complete"
            : `${inr(r.revenueForecast.projected)}${r.revenueForecast.perRemainingDay ? ` · needs ${inr(r.revenueForecast.perRemainingDay)} a working day` : ""}`,
      },
      {
        label: "Volume forecast",
        value: r.volumeForecast.projected === null ? "No forecast yet" : `${num(Math.round(r.volumeForecast.projected / 1000))} L`,
      },
      { label: "Revenue matching no product", value: inr(r.unmatchedPaise) },
      { label: "Working days", value: `${num(r.workingDaysElapsed)} of ${num(r.workingDaysTotal)}` },
    );
    r.alerts.forEach((a, i) => fields.push({ label: i === 0 ? "Wants attention" : "Also", value: a.message }));
  } else {
    fields.push({ label: "This month", value: "No published target and no credited sales this month" });
  }

  return {
    kind: `Person · ${TITLE}`,
    title: name,
    sub: `${monthLong(t.month)} · ${f?.role ?? "—"}${r?.hasTarget ? ` · score ${Math.round(r.score.totalBp / 100)}` : ""}`,
    fields,
    timeline: [
      ...notes,
      ...revisions.map((x) => ({
        what: `Target revised: ${x.field} ${x.old_value ?? "not set"} → ${x.new_value ?? "not set"} — ${x.reason}`,
        when: `${stampIST(x.changed_at)}${x.changed_by_name ? ` · ${x.changed_by_name}` : ""}`,
      })),
    ],
    audit,
    acts: [VIEW_AS],
    href: { label: "Open in the Sales Dashboard", url: `/sales/people/${userId}` },
    noteTarget: { kind: "user", id: userId },
  };
}

/* ------------------------------------------------------------------- acts */

function rupeesToPaise(raw: string): number | null {
  const clean = raw.replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

const FIELD_MAP: Record<string, string> = { revenueTargetPaise: "revenue", reason: "reason", reasonNote: "note" };

async function revise(ctx: Ctx, userId: string, input: Record<string, string>): Promise<Result> {
  const next = addMonths(ctx.period.monthKey, 1);
  const paise = rupeesToPaise(String(input.revenue ?? ""));
  if (paise === null) {
    return { ok: false, error: "Type the revenue target in rupees.", fieldErrors: { revenue: "A whole rupee figure, like 3800000." } };
  }
  const config = await getConfig();
  const reason = String(input.reason ?? "").trim();
  const note = String(input.note ?? "").trim();
  if (reason && !config["performance.revisionReasons"].includes(reason)) {
    return { ok: false, error: "Pick one of the listed reasons.", fieldErrors: { reason: "Pick one of the listed reasons." } };
  }
  const [existing] = await db.execute<{
    id: string;
    status: string;
    volume_target_ml: string | null;
    new_customer_target: number | null;
    collection_target_bp: number | null;
    activity_target_bp: number | null;
    notes: string | null;
    name: string;
  }>(sql`
    select t.id, t.status::text as status, t.volume_target_ml, t.new_customer_target,
           t.collection_target_bp, t.activity_target_bp, t.notes, u.name
      from sales_targets t join users u on u.id = t.user_id
     where t.user_id = ${userId} and t.period = ${next}
  `);
  if (existing?.status === "published" && !reason) {
    return {
      ok: false,
      error: "This target has been published. Changing it needs a reason.",
      fieldErrors: { reason: "Pick why it is changing — it goes on the record beside what changed." },
    };
  }
  const bands = existing
    ? await db.execute<{ category_id: string; minimum_bp: number; target_bp: number; stretch_bp: number }>(sql`
        select coalesce(tc.formulation_id, tc.category_id) as category_id, tc.minimum_bp, tc.target_bp, tc.stretch_bp
          from sales_target_categories tc where tc.target_id = ${existing.id}
      `)
    : [];
  const who =
    existing?.name ?? (await db.execute<{ name: string }>(sql`select name from users where id = ${userId}`))[0]?.name ?? "them";
  const r = await saveSalesTarget({
    userId,
    period: next,
    revenueTargetPaise: paise,
    volumeTargetMl: existing?.volume_target_ml == null ? null : Number(existing.volume_target_ml),
    newCustomerTarget: existing?.new_customer_target ?? null,
    collectionTargetBp: existing?.collection_target_bp ?? null,
    activityTargetBp: existing?.activity_target_bp ?? null,
    notes: existing?.notes ?? null,
    bands: bands.map((b) => ({
      categoryId: b.category_id,
      minimumBp: Number(b.minimum_bp),
      targetBp: Number(b.target_bp),
      stretchBp: Number(b.stretch_bp),
    })),
    reason: existing?.status === "published" ? reason : undefined,
    reasonNote: existing?.status === "published" && note ? note : undefined,
  });
  if (!r.ok) {
    return fromOwning(
      { ...r, fieldErrors: r.fieldErrors?.map((f) => ({ field: FIELD_MAP[f.field] ?? f.field, message: f.message })) },
      "",
    );
  }
  return {
    ok: true,
    message: `${existing?.status === "published" ? "Revised" : existing ? "Draft saved" : "Draft set"} · ${who}, ${monthLabel(next)} — ${inr(paise)} ${EXCL}`,
  };
}

async function publish(ctx: Ctx, userId: string): Promise<Result> {
  const next = addMonths(ctx.period.monthKey, 1);
  const [row] = await db.execute<{ id: string; name: string }>(sql`
    select t.id, u.name from sales_targets t join users u on u.id = t.user_id
     where t.user_id = ${userId} and t.period = ${next}
  `);
  if (!row) {
    return { ok: false, error: `There is no ${monthLong(next)} target for this person yet. Revise sets one as a draft first.` };
  }
  const r = await publishSalesTarget(row.id);
  return fromOwning(r.ok ? { ok: true } : r, `Published · ${row.name}, ${monthLabel(next)}`);
}

/* --------------------------------------------------------------- provider */

export const provider: SectionProvider = {
  async section(ctx) {
    const t = await readTeam(ctx);
    const first: TableQuery = { q: "", page: 1, size: 25 };
    const reasons = t.config["performance.revisionReasons"];
    return {
      metrics: metricsOf(t, ctx),
      callouts: calloutsOf(t),
      tables: [
        withPage(targetsDef({ month: t.month, next: t.next, reasons, today: ctx.period.today }), targetsPage(t, first)),
        withPage(peopleDef(t.month), peoplePage(t, first)),
      ],
      foot:
        "Targets are set per month, so this section shows the month the chosen period ends in. Credit goes to the salesperson on the account, falling back to the back-office person.",
    };
  },

  async tablePage(ctx, table, query) {
    if (table !== "targets" && table !== "people") return emptyPage(query);
    const t = await readTeam(ctx);
    return table === "targets" ? targetsPage(t, query) : peoplePage(t, query);
  },

  async figure(ctx, metric) {
    return figureFor(ctx, metric);
  },

  async record(ctx, table, id) {
    return table === "targets" ? targetRecord(ctx, id) : personRecord(ctx, id);
  },

  async act(ctx, table, act, id, input): Promise<Result> {
    try {
      if (act === "viewas") return { ok: true, message: "Viewed" };
      if (table === "targets" && act === "publish") return await publish(ctx, id);
      if (table === "targets" && act === "revise") return await revise(ctx, id, input);
      return { ok: false, error: "That action is not offered here." };
    } catch (e) {
      return refusal(e);
    }
  },
};
