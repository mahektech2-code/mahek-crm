import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import { leadsCreatedIn } from "@/lib/services/owner-dashboard-service";
import { conversionFor, type Conversion } from "@/lib/engines/owner-kpis";
import type { LeadRow } from "@/lib/engines/owner-kpis";
import { bandOf } from "@/lib/engines/lead-ladder";
import { salesTypeLabel, sampleStateLabel, stageLabel, stageSentence, type LeadStage } from "@/lib/lead-labels";
import { reassignLead } from "@/lib/actions/sales";
import { assignDeskLead } from "@/lib/actions/lead-desk-assignment";
import { setLeadNextAction } from "@/lib/actions/leads";
import {
  auditFor,
  notesFor,
  refusal,
  stampIST,
  withPage,
  type Ctx,
  type SectionProvider,
  type TableQuery,
} from "../provider";
import { change, fmtDate, inr, monthLabel, num, plural, span } from "../format";
import type { ActSpec, Cell, FigureDrawer, Metric, RecordView, Row, TableDef, TablePage, Tone } from "../types";
import { customerStory } from "./customers";

/* ---------------------------------------------------------------------------
 * LEADS — the funnel (PRD §16).
 *
 * One lead is one `customers` row: `kind = 'lead'` while it has never ordered,
 * on the ladder `lead_stage` names. The period figures are the Reports app's
 * own — `leadsCreatedIn` for the cohort and `conversionFor` for what became
 * of it, followed forward `owner.conversionWindowDays` — so conversion here is
 * the owner's number and not a second reading of it.
 *
 * A stuck Suspect is `mustDecideSuspect`'s rule said in SQL: still a Suspect,
 * never decided, with at least `mbos.leads.maxSuspectVisits` visits on the handset.
 * Samples out are `mbos_samples` with the customer and no verdict yet.
 *
 * "Assign" moves the owner — the owner IS the assignment. A salesman is given
 * it through `reassignLead` (the Sales Dashboard's move, onto his handset); a
 * telecaller through `assignDeskLead` (the CRM calling desk's). Either way a
 * next action is then owed today by the new owner through `setLeadNextAction`.
 * ------------------------------------------------------------------------- */

const TZ = "Asia/Kolkata";
const CLOSED_STAGES = ["lost", "won", "customer", "active_distributor"];
const CLOSED_SQL = sql.raw(`('${CLOSED_STAGES.join("','")}')`);
const OPEN_WHERE = sql`c.kind = 'lead' and not coalesce(c.lead_archived, false) and c.deleted_at is null
  and (c.lead_stage is null or c.lead_stage::text not in ${CLOSED_SQL})`;
const LAST_TOUCHED = sql.raw(
  `greatest(c.lead_last_activity_date, c.last_contact_date, c.last_visit_date, (c.created_at at time zone '${TZ}')::date)`,
);
const VISITS = sql.raw(`(select count(*)::int from mbos_visits v where v.customer_id = c.id)`);
const SAMPLES_OUT = sql.raw(`('dispatched','received','trial_done')`);
const COHORT_MONTHS = 5;

type Config = Awaited<ReturnType<typeof getConfig>>;

const n = (v: unknown) => Number(v ?? 0);

function stuckWhere(cap: number): SQL {
  return sql`c.lead_stage = 'suspect' and c.lead_suspect_decided_at is null
    and not coalesce(c.lead_archived, false) and c.deleted_at is null and ${VISITS} >= ${cap}`;
}

function sourceLabel(config: Config, code: string | null): string {
  if (!code) return "Not recorded";
  const found = (config["leads.sources"] ?? []).find((s) => s.code === code);
  return found?.label ?? code;
}

function stageTone(stage: string | null, stuck: boolean): Tone {
  if (!stage) return "muted";
  if (stuck) return "warn";
  if (stage === "on_hold") return "warn";
  const band = bandOf(stage as LeadStage);
  if (band === "contacted") return "info";
  if (band === "qualified" || band === "negotiation") return "good";
  return "muted";
}

function monthStart(today: string, back: number): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const t = y * 12 + (m - 1) - back;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
}

function monthKeys(today: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => monthStart(today, count - 1 - i).slice(0, 7));
}

const pct = (x: number | null) => (x == null ? "—" : `${x.toFixed(1)}%`);

/* ------------------------------------------------------------ open leads */

const ASSIGN_KEY = "assign";

const ASSIGN: ActSpec = {
  key: ASSIGN_KEY,
  label: "Assign",
  confirm: "The lead moves to the chosen person's book with a follow-up due today.",
  done: "Assigned",
  form: {
    title: "Assign this lead",
    sub: "The owner is whose book the lead is in. A salesman gets it on his handset; a telecaller on the calling desk.",
    submit: "Assign",
    consequence: "The lead moves to the chosen person's book with a follow-up due today. Both people are told.",
    fields: [{ k: "person", label: "Give it to", type: "person", search: "staff", req: true }],
  },
};

const OPEN_DEF: TableDef = {
  key: "open",
  title: "Every open lead",
  hint: "Now · oldest activity first",
  cols: [
    ["Lead", "1.6fr"],
    ["Stage", "0.9fr"],
    ["Source", "1fr"],
    ["Owner", "1.1fr"],
    ["Last touched", "0.9fr"],
    ["Visits", "0.6fr", true],
  ],
  noun: "lead",
  rec: "Lead",
  acts: [ASSIGN],
  actW: "100px",
};

async function openPage(query: TableQuery, config: Config, today: string): Promise<TablePage> {
  const q = query.q.trim();
  const like = `%${q}%`;
  const search =
    q.length >= 2
      ? sql`and (c.name ilike ${like} or c.city ilike ${like} or c.company_name ilike ${like} or c.phone ilike ${like})`
      : sql``;
  const cap = Number(config["mbos.leads.maxSuspectVisits"]);
  const [counts] = await db.execute<{ total: number; matched: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where true ${search})::int as matched
      from customers c where ${OPEN_WHERE}
  `);
  const matched = n(counts?.matched);
  const pages = Math.max(1, Math.ceil(matched / query.size));
  const page = Math.min(query.page, pages);
  const rows = await db.execute<{
    id: string;
    name: string;
    city: string | null;
    stage: string | null;
    source: string | null;
    owner: string | null;
    touched: string;
    visits: number;
    decided: string | null;
  }>(sql`
    select c.id, c.name, c.city, c.lead_stage::text as stage, c.lead_source as source,
           u.name as owner, to_char(${LAST_TOUCHED}, 'YYYY-MM-DD') as touched,
           ${VISITS} as visits, c.lead_suspect_decided_at as decided
      from customers c
      left join users u on u.id = c.owner_id
     where ${OPEN_WHERE} ${search}
     order by ${LAST_TOUCHED} asc, c.id
     limit ${query.size} offset ${(page - 1) * query.size}
  `);
  const thisYear = today.slice(0, 4);
  return {
    rows: rows.map((r): Row => {
      const stuck = r.stage === "suspect" && !r.decided && n(r.visits) >= cap;
      const stage: Cell = r.stage
        ? { t: stageLabel(r.stage as LeadStage), pill: stageTone(r.stage, stuck), sub: stuck ? "must be decided" : undefined }
        : { t: "Not on a ladder", pill: "muted" };
      return {
        id: r.id,
        cells: [
          { t: r.name, sub: r.city ?? undefined },
          stage,
          { t: sourceLabel(config, r.source) },
          { t: r.owner ?? "Nobody" },
          { t: r.touched.slice(0, 4) === thisYear ? fmtDate(r.touched).replace(/ \d{4}$/, "") : fmtDate(r.touched) },
          { t: num(n(r.visits)) },
        ],
      };
    }),
    count: matched,
    total: n(counts?.total),
    page,
    size: query.size,
    q: query.q,
  };
}

/* ---------------------------------------------------------------- cohorts */

function cohortDef(windowDays: number): TableDef {
  return {
    key: "cohorts",
    title: "Cohorts by creation month",
    hint: `Each followed forward ${windowDays} days`,
    cols: [
      ["Cohort", "1fr"],
      ["Leads", "0.7fr", true],
      ["Converted", "0.8fr", true],
      ["Rate", "0.7fr", true],
      ["Window", "1.4fr"],
    ],
    noun: "cohort",
    rec: "Cohort",
  };
}

/** Leads created from the start of `back` months ago to today, by creation month. */
async function cohortsByMonth(today: string, count: number, config: Config) {
  const cohort = await leadsCreatedIn({ from: monthStart(today, count - 1), to: today }, {});
  const by = new Map<string, LeadRow[]>();
  for (const l of cohort) {
    const k = l.createdOn.slice(0, 7);
    by.set(k, [...(by.get(k) ?? []), l]);
  }
  return monthKeys(today, count).map((k) => ({ key: k, conv: conversionFor(by.get(k) ?? [], today, config) }));
}

function cohortRow(key: string, c: Conversion): Row {
  return {
    id: key,
    cells: [
      { t: monthLabel(key) },
      { t: num(c.leads) },
      { t: num(c.converted) },
      { t: pct(c.ratePercent) },
      c.leads === 0
        ? { t: "No leads", pill: "muted" }
        : c.windowClosed
          ? { t: "Closed", pill: "good" }
          : { t: "Open", pill: "warn", sub: `${plural(c.stillOpen, "lead")} still inside` },
    ],
  };
}

async function cohortPage(today: string, config: Config, query: TableQuery): Promise<TablePage> {
  const months = (await cohortsByMonth(today, COHORT_MONTHS, config)).reverse();
  const q = query.q.trim().toLowerCase();
  const matched = q.length >= 2 ? months.filter((m) => monthLabel(m.key).toLowerCase().includes(q)) : months;
  return {
    rows: matched.map((m) => cohortRow(m.key, m.conv)),
    count: matched.length,
    total: months.length,
    page: 1,
    size: query.size,
    q: query.q,
  };
}

/* ---------------------------------------------------------------- figures */

async function headline(ctx: Ctx, config: Config) {
  const p = ctx.period;
  const cap = Number(config["mbos.leads.maxSuspectVisits"]);
  const reviewDays = Number(config["mbos.samples.reviewAfterDays"]);
  const [now, before, [stuck], [samples]] = await Promise.all([
    leadsCreatedIn({ from: p.from, to: p.to }, {}),
    leadsCreatedIn({ from: p.compareFrom, to: p.compareTo }, {}),
    db.execute<{ n: number }>(sql`select count(*)::int as n from customers c where ${stuckWhere(cap)}`),
    db.execute<{ out: number; late: number }>(sql`
      select count(*)::int as out,
             count(*) filter (where s.state in ('received','trial_done')
               and s.received_at is not null
               and s.received_at + make_interval(days => ${reviewDays}::int) < now())::int as late
        from mbos_samples s where s.state in ${SAMPLES_OUT}
    `),
  ]);
  const convNow = conversionFor(now, p.today, config);
  const convBefore = conversionFor(before, p.today, config);
  const qRate = (c: Conversion) => (c.leads ? (c.qualified / c.leads) * 100 : null);
  return { now, before, convNow, convBefore, qRate, stuck: n(stuck?.n), samplesOut: n(samples?.out), samplesLate: n(samples?.late), cap };
}

function metricsOf(ctx: Ctx, h: Awaited<ReturnType<typeof headline>>): Metric[] {
  const vs = `vs ${span(ctx.period.compareFrom, ctx.period.compareTo)}`;
  const qNow = h.qRate(h.convNow);
  const qBefore = h.qRate(h.convBefore);
  return [
    { key: "new", label: "New leads", value: num(h.now.length), sub: h.before.length === 0 ? (h.now.length ? `up from none in ${span(ctx.period.compareFrom, ctx.period.compareTo)}` : `none in ${span(ctx.period.compareFrom, ctx.period.compareTo)} either`) : `${change(h.now.length, h.before.length).text} ${vs}`, kind: "Period" },
    h.convNow.leads === 0
      ? { key: "conversion", label: "Conversion", value: "None yet", sub: "no leads created in the period", kind: "Period" }
      : h.convNow.stillOpen > 0
        ? {
            key: "conversion",
            label: "Conversion",
            value: pct(h.convNow.ratePercent),
            sub: `Unfinished · ${num(h.convNow.stillOpen)} still in window`,
            kind: "Period",
            tone: "warn",
          }
        : {
            key: "conversion",
            label: "Conversion",
            value: pct(h.convNow.ratePercent),
            sub: `${change(h.convNow.ratePercent, h.convBefore.leads ? h.convBefore.ratePercent : null, true).text} · window closed`,
            kind: "Period",
          },
    {
      key: "qualified",
      label: "Qualified rate",
      value: qNow == null ? "None yet" : pct(qNow),
      sub: qNow == null ? "no leads created in the period" : change(qNow, qBefore, true).text,
      kind: "Period",
    },
    {
      key: "stuck",
      label: "Stuck suspects",
      value: num(h.stuck),
      sub: `visited to the ${h.cap}-visit cap, not decided`,
      kind: "Now",
      tone: h.stuck ? "bad" : undefined,
    },
    {
      key: "samples",
      label: "Samples out",
      value: num(h.samplesOut),
      sub: `${num(h.samplesLate)} past their review date`,
      kind: "Now",
      tone: h.samplesLate ? "warn" : undefined,
    },
  ];
}

const DEFS: Record<string, string> = {
  new: "Leads created in the period — every account raised as a lead, whether or not anybody has put it on a ladder since. A lead that has since ordered still counts in the month it was created.",
  conversion:
    "Of the leads created in the period, the share that placed a first order within 90 days. An open window is unfinished, not failing.",
  qualified:
    "Of the leads created in the period, the share that reached the qualification rung or beyond. Every lead counts in the denominator, including those nobody has put on a ladder.",
  stuck:
    "Suspects visited at least as many times as the visit cap allows and still not decided Prospect or Not Prospect. Nothing is refused at the cap — a decision is demanded.",
  samples:
    "Samples sent to a lead and not yet reviewed: on the way, delivered, or tried. Past their review date means delivered longer ago than the review call is due.",
};
const TITLES: Record<string, string> = {
  new: "New leads",
  conversion: "Conversion",
  qualified: "Qualified rate",
  stuck: "Stuck suspects",
  samples: "Samples out",
};

/* ----------------------------------------------------------------- record */

async function leadRecord(ctx: Ctx, id: string, config: Config): Promise<RecordView> {
  const cap = Number(config["mbos.leads.maxSuspectVisits"]);
  const [r] = await db.execute<Record<string, unknown>>(sql`
    select c.id, c.name, c.company_name, c.contact_person, c.phone, c.email, c.city, c.region, c.address,
           c.kind::text as kind, c.lead_stage::text as stage, to_char(c.lead_stage_since, 'YYYY-MM-DD') as stage_since,
           c.lead_sales_type::text as sales_type, c.lead_source, c.lead_source_detail,
           c.lead_requirement, c.lead_monthly_volume_litres, c.lead_estimated_potential_paise,
           c.lead_competitor, c.lead_next_action, to_char(c.lead_next_action_date, 'YYYY-MM-DD') as next_date,
           c.lead_hold_reason, c.lead_archived, c.lead_suspect_decided_at, c.lead_priority::text as priority,
           to_char(${LAST_TOUCHED}, 'YYYY-MM-DD') as touched,
           to_char((c.created_at at time zone ${TZ})::date, 'YYYY-MM-DD') as created_on,
           ${VISITS} as visits,
           ou.name as owner, mu.name as lead_manager, nu.name as next_owner,
           (select count(*)::int from mbos_samples s where s.customer_id = c.id and s.state in ${SAMPLES_OUT}) as samples_out
      from customers c
      left join users ou on ou.id = c.owner_id
      left join users mu on mu.id = c.lead_manager_id
      left join users nu on nu.id = c.lead_next_action_owner_id
     where c.id = ${id}
  `);
  if (!r) throw new Error("That lead is no longer on MahekOne.");
  const s = (k: string) => (r[k] === null || r[k] === undefined || r[k] === "" ? null : String(r[k]));
  const stage = s("stage") as LeadStage | null;
  const stuck = stage === "suspect" && !r.lead_suspect_decided_at && n(r.visits) >= cap;
  const open = s("kind") === "lead" && !r.lead_archived && !(stage && CLOSED_STAGES.includes(stage));

  const fields = [
    { label: "Lead", value: s("name")! },
    { label: "Company", value: s("company_name") ?? "Not recorded" },
    { label: "Contact", value: [s("contact_person"), s("phone"), s("email")].filter(Boolean).join(" · ") || "Not recorded" },
    { label: "Town", value: [s("city"), s("region")].filter(Boolean).join(" · ") || "Not recorded" },
    {
      label: "Stage",
      value: stage
        ? `${stageLabel(stage)}${s("stage_since") ? ` since ${fmtDate(s("stage_since"))}` : ""} — ${stageSentence(stage)}`
        : "Not on a ladder — raised in the CRM and never put on one",
    },
    { label: "Sold as", value: salesTypeLabel((s("sales_type") ?? null) as never) },
    { label: "Source", value: `${sourceLabel(config, s("lead_source"))}${s("lead_source_detail") ? ` · ${s("lead_source_detail")}` : ""}` },
    { label: "Owner", value: s("owner") ?? "Nobody" },
    { label: "Lead manager", value: s("lead_manager") ?? "Nobody" },
    {
      label: "Next action",
      value: s("lead_next_action")
        ? `${s("lead_next_action")} · ${fmtDate(s("next_date"))} · ${s("next_owner") ?? "nobody"}`
        : "None owed",
    },
    { label: "Last touched", value: fmtDate(s("touched")) },
    {
      label: "Visits",
      value: `${plural(n(r.visits), "visit")}${stuck ? ` — at the ${cap}-visit cap, a Prospect-or-not decision is due` : ""}`,
    },
    { label: "Samples out", value: n(r.samples_out) ? plural(n(r.samples_out), "sample") : "None" },
    { label: "What they want", value: s("lead_requirement") ?? "Not recorded" },
    {
      label: "Monthly volume",
      value: r.lead_monthly_volume_litres != null ? `${num(n(r.lead_monthly_volume_litres))} litres` : "Not recorded",
    },
    {
      label: "Estimated potential",
      value: r.lead_estimated_potential_paise != null ? `${inr(n(r.lead_estimated_potential_paise))} a month` : "Not estimated",
    },
    { label: "Competitor", value: s("lead_competitor") ?? "Not recorded" },
    ...(s("lead_hold_reason") ? [{ label: "On hold because", value: s("lead_hold_reason")! }] : []),
    { label: "Created", value: fmtDate(s("created_on")) },
  ];
  const [notes, story, audit] = await Promise.all([
    notesFor("lead", id),
    customerStory(id),
    auditFor(["customer", "mbos_lead"], id),
  ]);
  return {
    kind: "Lead · Leads",
    title: s("name")!,
    sub: [s("city"), stage ? stageLabel(stage) : "Not on a ladder", s("owner") ?? "No owner"].filter(Boolean).join(" · "),
    fields,
    timeline: [...notes, ...story],
    audit,
    acts: open ? [ASSIGN] : [],
    href: { label: "Open the lead", url: `/crm/leads/${id}` },
    noteTarget: { kind: "lead", id },
  };
}

async function cohortRecord(ctx: Ctx, key: string, config: Config): Promise<RecordView> {
  if (!/^\d{4}-\d{2}$/.test(key)) throw new Error("That cohort is not a month.");
  const [y, m] = key.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${key}-${String(last).padStart(2, "0")}` < ctx.period.today ? `${key}-${String(last).padStart(2, "0")}` : ctx.period.today;
  const cohort = await leadsCreatedIn({ from: `${key}-01`, to }, {});
  const c = conversionFor(cohort, ctx.period.today, config);
  const converted = cohort
    .filter((l) => l.firstOrderOn)
    .sort((a, b) => (b.firstOrderOn ?? "").localeCompare(a.firstOrderOn ?? ""))
    .slice(0, 20);
  const names = converted.length
    ? await db.execute<{ id: string; name: string }>(sql`
        select c.id, c.name from customers c where c.id in (${sql.join(converted.map((l) => sql`${l.leadId}`), sql`, `)})
      `)
    : [];
  const nameOf = new Map(names.map((x) => [x.id, x.name]));
  return {
    kind: "Cohort · Leads",
    title: `${monthLabel(key)} cohort`,
    sub: `Leads created ${span(`${key}-01`, to)}, followed forward ${c.windowDays} days`,
    fields: [
      { label: "Leads created", value: num(c.leads) },
      { label: "Converted", value: `${num(c.converted)} placed a first order within ${c.windowDays} days` },
      { label: "Conversion", value: pct(c.ratePercent) },
      { label: "Qualified", value: `${num(c.qualified)} reached the qualification rung or beyond` },
      { label: "Qualified conversion", value: pct(c.qualifiedRatePercent) },
      {
        label: "Window",
        value: c.leads === 0 ? "No leads" : c.windowClosed ? "Closed — every lead has had its full window" : `Open — ${plural(c.stillOpen, "lead")} still inside`,
      },
    ],
    timeline: [
      ...(await notesFor("lead_cohort", key)),
      ...converted.map((l) => ({
        what: `${nameOf.get(l.leadId) ?? "A lead"} placed a first order`,
        when: `${fmtDate(l.firstOrderOn)} · created ${fmtDate(l.createdOn)}`,
      })),
    ],
    audit: [],
    acts: [],
    noteTarget: { kind: "lead_cohort", id: key },
  };
}

/* --------------------------------------------------------------- provider */

export const provider: SectionProvider = {
  async section(ctx) {
    const config = await getConfig();
    const [h, open, cohorts] = await Promise.all([
      headline(ctx, config),
      openPage({ q: "", page: 1, size: 25 }, config, ctx.period.today),
      cohortPage(ctx.period.today, config, { q: "", page: 1, size: 25 }),
    ]);
    return {
      metrics: metricsOf(ctx, h),
      callouts: [],
      tables: [withPage(OPEN_DEF, open), withPage(cohortDef(Number(config["owner.conversionWindowDays"])), cohorts)],
      foot: "Conversion follows each lead's own window. A cohort still inside it is unfinished, not failing — and every lead counts in the denominator.",
    };
  },

  async tablePage(ctx, table, query) {
    const config = await getConfig();
    if (table === "open") return openPage(query, config, ctx.period.today);
    if (table === "cohorts") return cohortPage(ctx.period.today, config, query);
    throw new Error(`No table called ${table}.`);
  },

  async figure(ctx, metric): Promise<FigureDrawer> {
    if (!TITLES[metric]) throw new Error(`No figure called ${metric}.`);
    const config = await getConfig();
    const p = ctx.period;
    const h = await headline(ctx, config);
    const m = metricsOf(ctx, h).find((x) => x.key === metric)!;
    const asOf = stampIST(new Date());
    const isNow = metric === "stuck" || metric === "samples";
    const facts = [
      { label: "Kind", value: isNow ? "As of now" : "Follows the period" },
      ...(isNow ? [] : [{ label: "Period", value: span(p.from, p.to) }]),
      {
        label: "Basis",
        value: metric === "conversion" || metric === "qualified" ? "Rate — change in points" : "Count — change in percent",
      },
      { label: "Scope", value: "Company-wide · every lead" },
      {
        label: "Source",
        value: isNow ? (metric === "stuck" ? "Leads and handset visits" : "Samples") : "Leads — the Reports app's cohort",
      },
      { label: "As of", value: asOf },
    ];
    const base = {
      kind: `${isNow ? "Now" : "Period"} figure · Leads`,
      title: TITLES[metric],
      value: m.value,
      facts,
      def: DEFS[metric],
    };

    if (metric === "new") {
      const keys = monthKeys(p.today, 12);
      const [counts, newest] = await Promise.all([
        db.execute<{ m: string; n: number }>(sql`
          select to_char(c.created_at at time zone ${TZ}, 'YYYY-MM') as m, count(*)::int as n
            from customers c
           where (c.kind = 'lead' or c.lead_stage is not null)
             and c.created_at >= ${`${keys[0]}-01 00:00:00+05:30`}::timestamptz
           group by 1
        `),
        Promise.resolve(
          [...h.now].sort((a, b) => b.createdOn.localeCompare(a.createdOn)).slice(0, 8),
        ),
      ]);
      const by = new Map(counts.map((c) => [c.m, n(c.n)]));
      const names = newest.length
        ? await db.execute<{ id: string; name: string }>(sql`
            select c.id, c.name from customers c where c.id in (${sql.join(newest.map((l) => sql`${l.leadId}`), sql`, `)})
          `)
        : [];
      const nameOf = new Map(names.map((x) => [x.id, x.name]));
      return {
        ...base,
        bars: keys.map((k, i) => ({ h: by.get(k) ?? 0, tip: `${monthLabel(k)} · ${num(by.get(k) ?? 0)}`, current: i === 11 || undefined })),
        barsLabel: "Leads created in each calendar month · the running month to date",
        rowsLabel: `Records behind it · leads created in the period · ${num(h.now.length)} in all`,
        rows: newest.map((l) => ({
          a: nameOf.get(l.leadId) ?? "A lead",
          b: [l.city, sourceLabel(config, l.source), l.ownerName ?? "Nobody"].filter(Boolean).join(" · "),
          c: fmtDate(l.createdOn),
        })),
        noRowsLine: newest.length ? undefined : "No lead was created in the period.",
      };
    }

    if (metric === "conversion" || metric === "qualified") {
      const months = await cohortsByMonth(p.today, 12, config);
      const value = (c: Conversion) =>
        metric === "conversion" ? (c.ratePercent ?? 0) : c.leads ? (c.qualified / c.leads) * 100 : 0;
      const recent = [...months].reverse().slice(0, 8);
      return {
        ...base,
        bars: months.map((x, i) => ({
          h: Math.round(value(x.conv) * 10) / 10,
          tip: `${monthLabel(x.key)} cohort · ${x.conv.leads ? pct(value(x.conv)) : "no leads"}${x.conv.windowClosed ? "" : " · unfinished"}`,
          current: i === 11 || undefined,
        })),
        barsLabel: "Each month's cohort, as it stands today · the recent ones are still inside their window",
        rowsLabel: "Records behind it · cohorts by creation month",
        rows: recent.map((x) => ({
          a: monthLabel(x.key),
          b: `${plural(x.conv.leads, "lead")} · ${num(metric === "conversion" ? x.conv.converted : x.conv.qualified)} ${metric === "conversion" ? "converted" : "qualified"}${x.conv.windowClosed ? "" : ` · ${num(x.conv.stillOpen)} still inside`}`,
          c: x.conv.leads ? pct(value(x.conv)) : "—",
        })),
      };
    }

    if (metric === "stuck") {
      const rows = await db.execute<{ name: string; city: string | null; owner: string | null; visits: number }>(sql`
        select c.name, c.city, u.name as owner, ${VISITS} as visits
          from customers c left join users u on u.id = c.owner_id
         where ${stuckWhere(h.cap)}
         order by ${VISITS} desc, c.name limit 8
      `);
      return {
        ...base,
        bars: [],
        barsLabel: "No history is kept for this figure",
        rowsLabel: `Records behind it · every open lead · ${plural(h.stuck, "stuck suspect")}`,
        rows: rows.map((r) => ({ a: r.name, b: [r.city, r.owner ?? "Nobody"].filter(Boolean).join(" · "), c: plural(n(r.visits), "visit") })),
        noRowsLine: rows.length ? undefined : "No Suspect has reached the visit cap undecided.",
      };
    }

    // samples
    const rows = await db.execute<{ name: string; state: string; at: string | null; salesman: string | null }>(sql`
      select c.name, s.state::text as state,
             to_char(coalesce(s.received_at, s.dispatched_at) at time zone ${TZ}, 'YYYY-MM-DD') as at,
             u.name as salesman
        from mbos_samples s
        join customers c on c.id = s.customer_id
        left join users u on u.id = s.salesman_id
       where s.state in ${SAMPLES_OUT}
       order by coalesce(s.received_at, s.dispatched_at) asc nulls last limit 8
    `);
    return {
      ...base,
      bars: [],
      barsLabel: "No history is kept for this figure",
      rowsLabel: `Records behind it · samples with a lead · ${num(h.samplesOut)} in all`,
      rows: rows.map((r) => ({
        a: r.name,
        b: [r.salesman ?? "No salesman", r.at ? `since ${fmtDate(r.at)}` : null]
          .filter(Boolean)
          .join(" · "),
        c: sampleStateLabel(r.state as never),
      })),
      noRowsLine: rows.length ? undefined : "No sample is out with a lead.",
    };
  },

  async record(ctx, table, id) {
    const config = await getConfig();
    if (table === "open") return leadRecord(ctx, id, config);
    if (table === "cohorts") return cohortRecord(ctx, id, config);
    throw new Error(`No table called ${table}.`);
  },

  async act(ctx, table, act, id, input) {
    if (table !== "open" || act !== ASSIGN_KEY) return { ok: false, error: "That action is not offered here." };
    const person = String(input.person ?? "").trim();
    if (!person) return { ok: false, error: "Pick who it goes to.", fieldErrors: { person: "Pick who it goes to." } };
    try {
      const [who] = await db.execute<{ lead: string | null; person: string | null; field: boolean }>(sql`
        select (select name from customers where customers.id = ${id}) as lead,
               (select name from users where users.id = ${person}) as person,
               exists (select 1 from app_access a where a.user_id = ${person} and a.app = 'field') as field
      `);
      if (!who?.lead) return { ok: false, error: "That lead is no longer on MahekOne." };
      if (!who.person) return { ok: false, error: "That person could not be found.", fieldErrors: { person: "Not found." } };

      const moved = who.field
        ? await reassignLead({ leadId: id, salesmanId: person })
        : await assignDeskLead({ customerId: id, ownerId: person });
      if (!moved.ok) {
        const fe: Record<string, string> = {};
        for (const f of moved.fieldErrors ?? []) fe[f.field === "ownerId" || f.field === "salesmanId" ? "person" : f.field] = f.message;
        return { ok: false, error: moved.error, fieldErrors: Object.keys(fe).length ? fe : undefined };
      }
      const next = await setLeadNextAction(id, {
        action: "Follow up — the lead was just assigned to you",
        date: ctx.period.today,
        ownerId: person,
      });
      const subject = `${who.lead} to ${who.person}`;
      return next.ok
        ? { ok: true, message: `Assigned · ${subject} · follow-up due today` }
        : { ok: true, message: `Assigned · ${subject} · the follow-up could not be set: ${next.error}` };
    } catch (e) {
      return refusal(e);
    }
  },
};
