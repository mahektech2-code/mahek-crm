import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import type { BlueprintDefinition } from "../blueprint-types";
import { isScored } from "../blueprint-types";
import { adverseImpact, calibrate, correlation, type ImpactRow, type InterviewerStats } from "../engines/fairness";
import { round1 } from "../engines/scoring";
import { scopeWhere, type HireContext } from "../access";

/* ---------------------------------------------------------------------------
 * INSIGHTS (design brief §7.10) — funnel, quality, fairness, calibration and
 * AI usage, read off the same records the pipeline writes.
 *
 * Every figure here is AGGREGATE. Fairness in particular never returns a
 * person: a group, a count, a rate and a ratio. Groups too small to read are
 * marked `small` and said in words rather than drawn as a ratio, because a
 * four-fifths line drawn over three people is noise dressed as a finding.
 * ------------------------------------------------------------------------- */

type Raw = Record<string, unknown>;

export type Range = "30" | "90" | "180" | "365" | "all";
export const RANGES: { v: Range; l: string }[] = [
  { v: "30", l: "Last 30 days" },
  { v: "90", l: "Last 90 days" },
  { v: "180", l: "Last 180 days" },
  { v: "365", l: "Last 12 months" },
  { v: "all", l: "All time" },
];
export const rangeOf = (v: string | undefined): Range => (RANGES.some((r) => r.v === v) ? (v as Range) : "90");
const sinceIso = (r: Range, now: number) => (r === "all" ? null : new Date(now - Number(r) * 86_400_000).toISOString());

type Exec = { k: string; s: number | null; n: number | null; g: number; o: string; c: string | null; by: string | null; byName: string | null; ai: boolean; aiAcc: number; aiTot: number };
type AppRow = {
  id: string;
  bpKey: string;
  bpTitle: string;
  def: BlueprintDefinition;
  location: string | null;
  gender: string | null;
  ageBand: string | null;
  status: string;
  stageKey: string;
  appliedAt: number;
  enteredAt: number;
  hiredAt: number | null;
  execs: Exec[];
};

async function loadApps(ctx: HireContext, opts: { since: string | null; bpKey?: string; location?: string }): Promise<AppRow[]> {
  const rows = (await db.execute(sql`
    select a.id, b.key as bp_key, b.title as bp_title, b.definition, a.location, c.gender, c.age_band, a.status, a.stage_key,
           a.applied_at, a.stage_entered_at, a.hired_at,
           (select json_agg(json_build_object(
                'k', x.stage_key, 's', x.final_score, 'n', x.normalised, 'g', x.grace, 'o', x.outcome, 'c', x.completed_at,
                'by', x.conducted_by_id, 'byName', u.name,
                'ai', exists (select 1 from hire_answers w where w.execution_id = x.id and w.scored_by = 'ai' and w.superseded_by_id is null),
                'aiAcc', (select count(*) from hire_answers w where w.execution_id = x.id and w.superseded_by_id is null and w.ai_score is not null and w.confirmed_at is not null and w.human_action = 'accepted'),
                'aiTot', (select count(*) from hire_answers w where w.execution_id = x.id and w.superseded_by_id is null and w.ai_score is not null and w.confirmed_at is not null))
              order by x.created_at)
              from hire_stage_executions x left join users u on u.id = x.conducted_by_id
              where x.application_id = a.id and x.superseded_by_id is null) as execs
    from hire_applications a
    join hire_candidates c on c.id = a.candidate_id
    join hire_blueprints b on b.id = a.blueprint_id
    where ${scopeWhere(ctx)}
      ${opts.since ? sql`and a.applied_at >= ${opts.since}` : sql``}
      ${opts.bpKey ? sql`and b.key = ${opts.bpKey}` : sql``}
      ${opts.location ? sql`and a.location = ${opts.location}` : sql``}
  `)) as unknown as Raw[];
  return rows.map((r) => ({
    id: String(r.id),
    bpKey: String(r.bp_key),
    bpTitle: String(r.bp_title),
    def: r.definition as BlueprintDefinition,
    location: (r.location as string) ?? null,
    gender: (r.gender as string) ?? null,
    ageBand: (r.age_band as string) ?? null,
    status: String(r.status),
    stageKey: String(r.stage_key),
    appliedAt: new Date(r.applied_at as string).getTime(),
    enteredAt: new Date(r.stage_entered_at as string).getTime(),
    hiredAt: r.hired_at ? new Date(r.hired_at as string).getTime() : null,
    execs: ((r.execs as Exec[] | null) ?? []).map((e) => ({ ...e, aiAcc: Number(e.aiAcc), aiTot: Number(e.aiTot), g: Number(e.g ?? 0) })),
  }));
}

/** The roles and locations a picker offers — what this person can see. */
export async function insightFilters(ctx: HireContext) {
  const rows = (await db.execute(sql`
    select b.key, max(b.title) as title, count(*)::int as n, array_agg(distinct a.location) as locs
    from hire_applications a join hire_blueprints b on b.id = a.blueprint_id
    where ${scopeWhere(ctx)} group by b.key order by count(*) desc`)) as unknown as Raw[];
  const roles = rows.map((r) => ({ key: String(r.key), title: String(r.title), n: Number(r.n) }));
  const locations = [...new Set(rows.flatMap((r) => ((r.locs as (string | null)[]) ?? []).filter((x): x is string => Boolean(x))))].sort();
  return { roles, locations };
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctl = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const CLOSED_OUT = new Set(["rejected", "withdrawn", "offer_declined", "archived"]);

/* ------------------------------------------------------------------ funnel */

export type FunnelStage = {
  key: string;
  name: string;
  type: string;
  reached: number;
  /** Moved past this stage (or hired). */
  passed: number;
  /** Ended here: rejected, withdrawn or declined while at this stage. */
  dropped: number;
  /** Still here, in progress or on hold. */
  here: number;
  conversion: number | null;
  medianHours: number | null;
  avgHours: number | null;
  slaHours: number;
  /** Share of completed passes through the stage that took longer than its SLA. */
  overSla: number | null;
};

export async function funnel(ctx: HireContext, f: { range: Range; bpKey: string; location?: string }, now: number) {
  const apps = await loadApps(ctx, { since: sinceIso(f.range, now), bpKey: f.bpKey, location: f.location });
  const def = apps[0]?.def ?? null;
  if (!def) return { stages: [] as FunnelStage[], total: 0, hired: 0, open: 0, medianDaysToHire: null as number | null, byLocation: [] as { location: string; entered: number; hired: number; open: number; closed: number }[] };
  const stages = def.stages;
  const idxOf = (a: AppRow) => (a.status === "hired" ? stages.length : Math.max(0, stages.findIndex((s) => s.key === a.stageKey)));

  const out: FunnelStage[] = stages.map((s, i) => {
    const reached = apps.filter((a) => idxOf(a) >= i);
    const durations: number[] = [];
    let over = 0;
    for (const a of reached) {
      const at = idxOf(a);
      const prevDone = i === 0 ? a.appliedAt : a.execs.find((e) => e.k === stages[i - 1].key && e.c)?.c;
      const prev = typeof prevDone === "number" ? prevDone : prevDone ? new Date(prevDone).getTime() : null;
      if (at > i) {
        const done = a.execs.find((e) => e.k === s.key && e.c)?.c;
        if (done && prev != null) {
          const h = (new Date(done).getTime() - prev) / 3_600_000;
          if (h >= 0) {
            durations.push(h);
            if (s.slaHours && h > s.slaHours) over++;
          }
        }
      } else if (at === i && (a.status === "in_progress" || a.status === "on_hold")) {
        durations.push(Math.max(0, (now - a.enteredAt) / 3_600_000));
      }
    }
    const passedN = apps.filter((a) => idxOf(a) > i).length;
    const completedThrough = reached.filter((a) => idxOf(a) > i).length;
    return {
      key: s.key,
      name: s.name,
      type: s.type,
      reached: reached.length,
      passed: passedN,
      dropped: reached.filter((a) => idxOf(a) === i && CLOSED_OUT.has(a.status)).length,
      here: reached.filter((a) => idxOf(a) === i && (a.status === "in_progress" || a.status === "on_hold")).length,
      conversion: reached.length ? passedN / reached.length : null,
      medianHours: median(durations),
      avgHours: avg(durations),
      slaHours: s.slaHours,
      overSla: completedThrough ? over / completedThrough : null,
    };
  });

  const hiredApps = apps.filter((a) => a.status === "hired" && a.hiredAt);
  const locs = new Map<string, AppRow[]>();
  for (const a of apps) locs.set(a.location ?? "Not stated", [...(locs.get(a.location ?? "Not stated") ?? []), a]);
  return {
    stages: out,
    total: apps.length,
    hired: apps.filter((a) => a.status === "hired").length,
    open: apps.filter((a) => a.status === "in_progress" || a.status === "on_hold").length,
    medianDaysToHire: median(hiredApps.map((a) => ((a.hiredAt as number) - a.appliedAt) / 86_400_000)),
    byLocation: [...locs.entries()]
      .map(([location, xs]) => ({ location, entered: xs.length, hired: xs.filter((a) => a.status === "hired").length, open: xs.filter((a) => a.status === "in_progress" || a.status === "on_hold").length, closed: xs.filter((a) => CLOSED_OUT.has(a.status)).length }))
      .sort((a, b) => b.entered - a.entered),
  };
}

/* ----------------------------------------------------------------- quality */

const overallOf = (a: AppRow) => {
  const s = a.execs.filter((e) => e.s != null).map((e) => Number(e.s));
  return s.length ? s.reduce((x, y) => x + y, 0) / s.length : null;
};

export async function quality(ctx: HireContext, f: { range: Range; bpKey?: string }, now: number) {
  const since = sinceIso(f.range, now);
  const apps = await loadApps(ctx, { since, bpKey: f.bpKey });
  const idSet = new Set(apps.map((a) => a.id));
  const [offersAll, outcomesAll] = await Promise.all([
    db.execute(sql`select o.application_id, o.status, o.response from hire_offers o join hire_applications a on a.id = o.application_id
      where ${scopeWhere(ctx)} and o.superseded_by_id is null and o.issued_at is not null`) as unknown as Promise<Raw[]>,
    db.execute(sql`select h.application_id, h.left_at, h.performance_score from hire_outcomes h join hire_applications a on a.id = h.application_id
      where ${scopeWhere(ctx)}`) as unknown as Promise<Raw[]>,
  ]);
  const offers = offersAll.filter((o) => idSet.has(String(o.application_id)));
  const outcomes = outcomesAll.filter((o) => idSet.has(String(o.application_id)));
  const declinedApps = apps.filter((a) => a.status === "offer_declined").length;
  const accepted = offers.filter((o) => o.status === "accepted").length;
  const declined = Math.max(offers.filter((o) => o.status === "declined").length, declinedApps);
  const decided = accepted + declined;

  const outBy = new Map(outcomes.map((o) => [String(o.application_id), o]));
  const hires = apps.filter((a) => a.status === "hired" && a.hiredAt);
  const windows = [30, 90, 180].map((d) => {
    const measurable = hires.filter((h) => now - (h.hiredAt as number) >= d * 86_400_000);
    const stayed = measurable.filter((h) => {
      const left = outBy.get(h.id)?.left_at as string | null | undefined;
      return !left || new Date(`${left}T12:00:00+05:30`).getTime() - (h.hiredAt as number) >= d * 86_400_000;
    });
    return { days: d, measurable: measurable.length, stayed: stayed.length, rate: measurable.length ? stayed.length / measurable.length : null, tooYoung: hires.length - measurable.length };
  });

  const pairs: { x: number; y: number; role: string }[] = [];
  for (const h of hires) {
    const o = overallOf(h);
    const p = outBy.get(h.id)?.performance_score;
    if (o != null && p != null) pairs.push({ x: round1(o), y: Number(p), role: h.bpTitle });
  }
  const r = correlation(pairs.map((p) => [p.x, p.y]));
  let fit: { a: number; b: number } | null = null;
  if (pairs.length >= 5) {
    const mx = avg(pairs.map((p) => p.x)) as number;
    const my = avg(pairs.map((p) => p.y)) as number;
    const sxx = pairs.reduce((n, p) => n + (p.x - mx) ** 2, 0);
    const b = sxx ? pairs.reduce((n, p) => n + (p.x - mx) * (p.y - my), 0) / sxx : 0;
    fit = { a: my - b * mx, b };
  }

  const roles = new Map<string, AppRow[]>();
  for (const a of apps) roles.set(a.bpTitle, [...(roles.get(a.bpTitle) ?? []), a]);
  const byRole = [...roles.entries()].map(([role, xs]) => {
    const hs = xs.filter((a) => a.status === "hired" && a.hiredAt);
    const m90 = hs.filter((h) => now - (h.hiredAt as number) >= 90 * 86_400_000);
    const s90 = m90.filter((h) => {
      const left = outBy.get(h.id)?.left_at as string | null | undefined;
      return !left || new Date(`${left}T12:00:00+05:30`).getTime() - (h.hiredAt as number) >= 90 * 86_400_000;
    });
    const roleOffers = offers.filter((o) => xs.some((a) => a.id === o.application_id));
    const acc = roleOffers.filter((o) => o.status === "accepted").length;
    const dec = roleOffers.filter((o) => o.status === "declined").length + xs.filter((a) => a.status === "offer_declined").length;
    return {
      role,
      hires: hs.length,
      acceptance: acc + dec ? acc / (acc + dec) : null,
      retention90: m90.length ? s90.length / m90.length : null,
      measurable90: m90.length,
      medianDaysToHire: median(hs.map((h) => ((h.hiredAt as number) - h.appliedAt) / 86_400_000)),
      avgPerformance: avg(hs.map((h) => outBy.get(h.id)?.performance_score).filter((v): v is number => v != null).map(Number)),
    };
  });

  return {
    hires: hires.length,
    acceptance: decided ? accepted / decided : null,
    accepted,
    declined,
    windows,
    pairs,
    r,
    fit,
    medianDaysToHire: median(hires.map((h) => ((h.hiredAt as number) - h.appliedAt) / 86_400_000)),
    byRole: byRole.sort((a, b) => b.hires - a.hires),
  };
}

/* ---------------------------------------------------------------- fairness */

export type FairAttr = "gender" | "age" | "location";
export const FAIR_ATTRS: { v: FairAttr; l: string }[] = [
  { v: "gender", l: "Gender" },
  { v: "age", l: "Age band" },
  { v: "location", l: "Location" },
];
const groupOf = (a: AppRow, attr: FairAttr) =>
  attr === "gender" ? (a.gender === "M" ? "Men" : a.gender === "F" ? "Women" : "Not stated") : attr === "age" ? (a.ageBand ?? "Not stated") : (a.location ?? "Not stated");

export type FairStage = { key: string; name: string; rows: ImpactRow[]; ai: ImpactRow[]; human: ImpactRow[]; decided: number };

export async function fairness(ctx: HireContext, f: { range: Range; bpKey: string; attr: FairAttr }, now: number) {
  const apps = await loadApps(ctx, { since: sinceIso(f.range, now), bpKey: f.bpKey });
  const def = apps[0]?.def ?? null;
  if (!def) return { stages: [] as FairStage[], threshold: 0.8, monitored: true, decided: 0, flagged: [] as { stage: string; group: string; ratio: number }[] };
  const threshold = def.fairness.adverseImpactThreshold || 0.8;
  const monitored = def.fairness.monitor[f.attr];
  const groups = [...new Set(apps.map((a) => groupOf(a, f.attr)))].sort();
  const stages: FairStage[] = def.stages
    .filter((s) => isScored(s) || s.type === "decision_gate" || s.type === "briefing")
    .map((s) => {
      const decided = apps
        .map((a) => ({ a, e: a.execs.find((e) => e.k === s.key && (e.o === "pass" || e.o === "fail")) }))
        .filter((x): x is { a: AppRow; e: Exec } => Boolean(x.e));
      const count = (xs: typeof decided) =>
        groups.map((g) => {
          const inG = xs.filter((x) => groupOf(x.a, f.attr) === g);
          return { group: g, entered: inG.length, passed: inG.filter((x) => x.e.o === "pass").length };
        });
      return {
        key: s.key,
        name: s.name,
        decided: decided.length,
        rows: adverseImpact(count(decided), threshold),
        ai: adverseImpact(count(decided.filter((x) => x.e.ai)), threshold),
        human: adverseImpact(count(decided.filter((x) => !x.e.ai)), threshold),
      };
    })
    .filter((s) => s.decided > 0);
  const flagged = stages.flatMap((s) => s.rows.filter((r) => r.flagged).map((r) => ({ stage: s.name, group: r.group, ratio: r.ratio as number })));
  return { stages, threshold, monitored, decided: stages.reduce((n, s) => n + s.decided, 0), flagged };
}

/* --------------------------------------------------------------- calibrate */

export type CalibrateRow = InterviewerStats & { name: string; flips: number; scores: number[]; perfectAgreement: boolean };

export async function calibration(ctx: HireContext, f: { range: Range; bpKey?: string }, now: number) {
  const apps = await loadApps(ctx, { since: sinceIso(f.range, now), bpKey: f.bpKey });
  const rows: { interviewer: string; name: string; score: number; grace: number; aiAccepted: number; aiTotal: number; flip: boolean }[] = [];
  for (const a of apps)
    for (const e of a.execs) {
      if (e.s == null || !e.by || (e.o !== "pass" && e.o !== "fail")) continue;
      const stage = a.def.stages.find((s) => s.key === e.k);
      if (!stage || !isScored(stage)) continue;
      const n = e.n ?? e.s;
      rows.push({ interviewer: e.by, name: e.byName ?? "Unknown", score: Number(e.s), grace: e.g, aiAccepted: e.aiAcc, aiTotal: e.aiTot, flip: e.g !== 0 && Number(n) >= stage.passThreshold !== Number(e.s) >= stage.passThreshold });
    }
  const c = calibrate(rows);
  const names = new Map(rows.map((r) => [r.interviewer, r.name]));
  const out: CalibrateRow[] = c.stats.map((s) => ({
    ...s,
    name: names.get(s.interviewer) ?? "Unknown",
    flips: rows.filter((r) => r.interviewer === s.interviewer && r.flip).length,
    scores: rows.filter((r) => r.interviewer === s.interviewer).map((r) => r.score),
    perfectAgreement: s.agreement === 1 && rows.filter((r) => r.interviewer === s.interviewer).reduce((n, r) => n + r.aiTotal, 0) >= 10,
  }));
  return { panelMean: c.panelMean, rows: out, n: rows.length, graceUses: rows.filter((r) => r.grace !== 0).length, flips: rows.filter((r) => r.flip).length };
}

/* ---------------------------------------------------------------- AI usage */

export async function aiUsage(ctx: HireContext, f: { range: Range }, now: number) {
  const since = sinceIso(f.range, now);
  const c = await getConfig();
  const budget = c["hire.ai.monthlyBudgetPaise"];
  const rows = (await db.execute(sql`
    select t.task_type, t.status, t.input_tokens, t.output_tokens, t.latency_ms, t.cost_paise, t.application_id, t.fallback_used, t.model_id,
           coalesce(b.title, b2.title) as role
    from hire_ai_tasks t
    left join hire_applications a on a.id = t.application_id
    left join hire_blueprints b on b.id = a.blueprint_id
    left join hire_blueprints b2 on b2.id = t.blueprint_id
    where ${since ? sql`t.created_at >= ${since}` : sql`true`}
  `)) as unknown as Raw[];
  const [month] = (await db.execute(sql`
    select coalesce(sum(cost_paise), 0)::bigint as spend, count(*)::int as n from hire_ai_tasks
    where created_at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`)) as unknown as Raw[];
  const spendMonth = Number(month?.spend ?? 0);
  void ctx;

  const t = rows.map((r) => ({
    type: String(r.task_type),
    status: String(r.status),
    inTok: Number(r.input_tokens ?? 0),
    outTok: Number(r.output_tokens ?? 0),
    latency: r.latency_ms == null ? null : Number(r.latency_ms),
    cost: Number(r.cost_paise ?? 0),
    app: (r.application_id as string) ?? null,
    role: (r.role as string) ?? "No role",
    fallback: (r.fallback_used as string) ?? null,
    model: (r.model_id as string) ?? "—",
  }));
  const group = <K extends string>(key: (x: (typeof t)[number]) => K) => {
    const m = new Map<K, typeof t>();
    for (const x of t) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
    return [...m.entries()].map(([k, xs]) => {
      const lat = xs.map((x) => x.latency).filter((v): v is number => v != null && v > 0);
      return {
        key: k,
        calls: xs.length,
        success: xs.filter((x) => x.status === "success").length,
        fallbacks: xs.filter((x) => x.status !== "success" && x.status !== "cached").length,
        inTok: xs.reduce((n, x) => n + x.inTok, 0),
        outTok: xs.reduce((n, x) => n + x.outTok, 0),
        cost: xs.reduce((n, x) => n + x.cost, 0),
        p50: median(lat),
        p95: pctl(lat, 95),
        apps: new Set(xs.map((x) => x.app).filter(Boolean)).size,
      };
    });
  };
  const byType = group((x) => x.type).sort((a, b) => b.calls - a.calls);
  const byRole = group((x) => x.role).sort((a, b) => b.cost - a.cost);
  const statuses = group((x) => x.status).sort((a, b) => b.calls - a.calls);
  const lat = t.map((x) => x.latency).filter((v): v is number => v != null && v > 0);
  const apps = new Set(t.map((x) => x.app).filter(Boolean)).size;
  const total = t.reduce((n, x) => n + x.cost, 0);
  return {
    calls: t.length,
    success: t.filter((x) => x.status === "success").length,
    cost: total,
    perCandidate: apps ? Math.round(t.filter((x) => x.app).reduce((n, x) => n + x.cost, 0) / apps) : null,
    candidates: apps,
    p50: median(lat),
    p95: pctl(lat, 95),
    tokens: t.reduce((n, x) => n + x.inTok + x.outTok, 0),
    byType,
    byRole,
    statuses,
    budget,
    spendMonth,
  };
}
