import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE, type DateRange } from "../business-date";
import { isOnTheBookAt, ladderFor } from "../engines/lead-ladder";
import type { LeadSalesType, LeadStage } from "../lead-labels";
import { leadsVisible, managerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * The funnel read three ways: by RUNG, by COHORT, and by REASON CODE.
 *
 * `lead-console-service.ts` already answers "what is waiting on me" — a desk's
 * worth of queues. This file answers the other question a manager asks of the
 * same table, which is not a queue at all: how the shape of the book is
 * changing, where it is bunching, where it came from and what it is dying of.
 * Those are aggregates over everything rather than lists of what is pending,
 * and folding them in beside the queues would give every desk screen a
 * `group by` it pays for and never reads.
 *
 * Three rules run through it, and all three are inherited rather than invented.
 *
 * **The ladder is the engine's and is never restated.** `ladderFor()` decides
 * which rungs exist and in what order; nothing here writes a stage list out.
 * Where this needs BANDS it would call `bandOf` — it does not need them, which
 * is the whole reason `funnelByRung` exists beside `leadFunnel`.
 *
 * **Scope is resolved here, never passed in.** `managerScope()` reads the
 * session inside the service, so no call site can forget the narrowing — and a
 * forgotten narrowing is silent, looks like working software, and shows a
 * regional manager the whole country.
 *
 * **Every window names its zone and every parameter names its type.** A bare
 * `::date` reads in the session's zone, and an untyped parameter beside a date
 * lets Postgres resolve `date - $1` as `date - date`, which yields an integer
 * and then has no operator to compare against. Both of those throw inside the
 * driver where no type check sees them, and the second one took the whole MBOS
 * pull down twice.
 * ------------------------------------------------------------------------- */

/**
 * A window as two instants, both in Asia/Kolkata.
 *
 * `from` and `to` are calendar days and the columns are timestamptz, so
 * something has to name the midnight — a date cast to a timestamp is evaluated
 * in the SESSION's zone, which is not a property of the row and is not stable
 * across a pooled connection. Half-open at the top rather than
 * `23:59:59.999`: a row written in the last millisecond of a day is a row, and
 * a window that excludes it is wrong once in a while in a way nobody can
 * reproduce.
 */
function istWindow(range: DateRange) {
  return {
    start: sql`(${range.from}::date)::timestamp at time zone ${APP_TIMEZONE}`,
    end: sql`((${range.to}::date + 1)::timestamp at time zone ${APP_TIMEZONE})`,
  };
}

/* ═════════════════════════════════════════════════════ the funnel, by rung */

export type RungCount = {
  stage: LeadStage;
  /** How many leads are standing on this rung right now. */
  count: number;
  /**
   * The MEDIAN days leads on this rung have been on it, from
   * `lead_stage_since`. Median rather than mean because one lead parked on a
   * rung for four years drags an average into uselessness, and the question
   * being asked — "is this the rung where the book gets stuck" — is a question
   * about the typical lead.
   */
  medianDaysHere: number | null;
  /**
   * How many of that count actually carry a `lead_stage_since`. A median taken
   * over three of forty rows is a median of three rows, and a screen that does
   * not say so is one somebody plans from.
   */
  dated: number;
  /** Somebody's ESTIMATE of what these are worth, never a derived value. */
  potentialPaise: number;
};

export type RungFunnel = {
  salesType: LeadSalesType | null;
  /** In ladder order, every rung drawn — including the empty ones. */
  rungs: RungCount[];
  /**
   * Rows sitting on a stage that is NOT on this ladder.
   *
   * It happens for exactly as long as it takes somebody to change a lead's
   * sales type, and it is reported rather than dropped: a funnel whose bars do
   * not add up to its own total is a funnel somebody stops trusting, and the
   * honest answer is that these leads are on a rung their ladder does not have.
   */
  offLadder: RungCount[];
  /** On the ladder — or off it — and still climbing. */
  inFunnel: number;
  /**
   * `on_hold` — PARKED, which is neither a rung nor terminal. `bandOf` refuses
   * to answer for it and so does this: the rung it was parked from lives in
   * `lead_stage_transitions`, not in the stage column, so counting it into a
   * bar would be a guess printed as a figure.
   */
  parked: number;
  lost: number;
  /** `won`, `customer`, `active_distributor` — arrived rather than waiting. */
  arrived: number;
};

/**
 * TWELVE RUNGS, where `leadFunnel()` answers four bands.
 *
 * They are the same table asked a different question, and the difference is
 * the point of this screen: four bands say the pipeline is healthy, and twelve
 * rungs say that eleven of the fourteen leads inside "Qualified" have been
 * sitting on `sample_trial` for six weeks. `bandOf` is not duplicated here and
 * is not needed here — the ladder array IS the ordering, and it comes from the
 * engine.
 *
 * `day` is the business date, passed in rather than read, because a service
 * that reads the clock cannot be tested and because where the day starts is
 * configuration.
 */
export async function funnelByRung(day: string): Promise<RungFunnel[]> {
  const scope = await managerScope();

  const rows = await db.execute<{
    salesType: LeadSalesType | null;
    stage: LeadStage;
    n: number;
    potential: string | number | null;
    dated: number;
    medianDays: string | number | null;
  }>(sql`
    select c.lead_sales_type::text as "salesType",
           c.lead_stage::text as stage,
           count(*)::int as n,
           coalesce(sum(c.lead_estimated_potential_paise), 0) as potential,
           count(c.lead_stage_since)::int as dated,
           percentile_cont(0.5) within group (
             order by (${day}::date - c.lead_stage_since)
           ) as "medianDays"
      from customers c
     where c.lead_stage is not null
       and c.lead_archived = false
       ${leadsVisible(scope)}
     group by 1, 2
  `);

  const key = (t: LeadSalesType | null) => t ?? "legacy";
  const byType = new Map<string, RungFunnel>();
  /* The measured rows, kept aside so a rung the ladder has and the book does
     not is still drawn at zero — a funnel that omits its empty rungs redraws
     itself every time somebody works it. */
  const measured = new Map<string, Map<string, RungCount>>();

  const blank = (salesType: LeadSalesType | null): RungFunnel => ({
    salesType,
    rungs: [],
    offLadder: [],
    inFunnel: 0,
    parked: 0,
    lost: 0,
    arrived: 0,
  });

  for (const r of rows) {
    const k = key(r.salesType);
    if (!byType.has(k)) {
      byType.set(k, blank(r.salesType));
      measured.set(k, new Map());
    }
    const f = byType.get(k)!;
    const cell: RungCount = {
      stage: r.stage,
      count: Number(r.n),
      dated: Number(r.dated),
      medianDaysHere: r.medianDays === null ? null : Math.round(Number(r.medianDays)),
      potentialPaise: Number(r.potential ?? 0),
    };

    if (r.stage === "lost") {
      f.lost += cell.count;
      continue;
    }
    if (r.stage === "on_hold") {
      f.parked += cell.count;
      continue;
    }
    if (r.stage === "won" || r.stage === "customer" || r.stage === "active_distributor") {
      f.arrived += cell.count;
      continue;
    }
    measured.get(k)!.set(r.stage, cell);
  }

  for (const [k, f] of byType) {
    const seen = measured.get(k)!;
    const ladder = ladderFor(f.salesType);
    f.rungs = ladder.map(
      (stage) =>
        seen.get(stage) ?? {
          stage,
          count: 0,
          medianDaysHere: null,
          dated: 0,
          potentialPaise: 0,
        },
    );
    for (const [stage, cell] of seen) {
      if (!ladder.includes(stage as LeadStage)) f.offLadder.push(cell);
    }
    f.inFunnel =
      f.rungs.reduce((n, r) => n + r.count, 0) + f.offLadder.reduce((n, r) => n + r.count, 0);
  }

  /* The three real ladders in the order the specification lists them, then the
     leads raised before any of this existed. */
  const order: (LeadSalesType | null)[] = ["direct", "distributor", "third_party", null];
  return order.map((t) => byType.get(key(t))).filter((f): f is RungFunnel => Boolean(f));
}

/* ═══════════════════════════════════════════════════ the cohort, followed */

type CohortLead = {
  id: string;
  stage: LeadStage | null;
  salesType: LeadSalesType | null;
  source: string | null;
  createdOn: string;
};

/**
 * Every lead RAISED in a window, with where it now stands.
 *
 * One read, shared by the cohort figures and by the sources table, because
 * "what did this source convert" and "what did this month convert" are the
 * same question asked of two groupings — and two reads of it is how two
 * screens come to disagree about one month.
 */
async function cohortLeads(range: DateRange): Promise<CohortLead[]> {
  const scope = await managerScope();
  const w = istWindow(range);

  const rows = await db.execute<{
    id: string;
    stage: LeadStage | null;
    salesType: LeadSalesType | null;
    source: string | null;
    createdOn: string;
  }>(sql`
    select c.id,
           c.lead_stage::text as stage,
           c.lead_sales_type::text as "salesType",
           c.lead_source as source,
           to_char(c.created_at at time zone ${APP_TIMEZONE}, 'YYYY-MM-DD') as "createdOn"
      from customers c
     where (c.kind = 'lead' or c.lead_stage is not null)
       and c.created_at >= ${w.start}
       and c.created_at < ${w.end}
       ${leadsVisible(scope)}
  `);

  return rows.map((r) => ({
    id: r.id,
    stage: r.stage,
    salesType: r.salesType,
    source: r.source,
    createdOn: r.createdOn,
  }));
}

/** What became of one lead, as far as the ladder can say. */
type Outcome = "converted" | "lost" | "open" | "unresolved";

function outcomeOf(lead: CohortLead, windowClosedOn: (createdOn: string) => boolean): Outcome {
  /*
   * A lead with no rung is UNRESOLVED and is never quietly counted as a
   * failure. `customers.kind = 'lead'` predates the funnel and carries no
   * ladder at all, so "did it convert" has no answer for it — folding those
   * into the denominator would report a conversion rate that falls every time
   * somebody raises a lead the old way.
   */
  if (!lead.stage) return "unresolved";
  if (lead.stage === "lost") return "lost";
  if (isOnTheBookAt(lead.stage, lead.salesType)) return "converted";
  return windowClosedOn(lead.createdOn) ? "lost" : "open";
}

export type Cohort = {
  range: DateRange;
  /** `owner.conversionWindowDays` — how long a lead is followed forward. */
  windowDays: number;
  raised: number;
  converted: number;
  /**
   * Raised, not converted, and its own window has CLOSED. This is the only
   * honest other half of the denominator — a lead eleven days old with a
   * ninety-day window has not failed to convert.
   */
  closedUnconverted: number;
  /** Still inside its window. Printed in words, never divided. */
  stillOpen: number;
  /** Raised as a lead with no rung — outside this cohort, and said so. */
  unresolved: number;
  /**
   * Converted over (converted + closedUnconverted), as a fraction. Null where
   * nothing in the cohort has closed its window yet: a rate over zero decided
   * leads is not a low rate, it is no rate.
   */
  rate: number | null;
};

/**
 * CONVERSION MEASURED BY COHORT, never this month over this month.
 *
 * Dividing orders this month by leads this month asks a lead raised on the
 * 29th to have ordered by the 31st, and mixes conversions from March's leads
 * into a rate labelled with August's lead count. This follows ONE window's
 * leads forward for `owner.conversionWindowDays` and reports what became of
 * them — and a cohort read before its window closes is UNFINISHED rather than
 * failing, which is why `stillOpen` is carried separately instead of being
 * silently counted as a loss.
 *
 * `day` is the business date the windows are measured against.
 */
export async function leadCohort(
  range: DateRange,
  windowDays: number,
  day: string,
): Promise<Cohort> {
  const leads = await cohortLeads(range);
  return tallyCohort(leads, range, windowDays, day);
}

/**
 * Pure, and shared by the cohort figures and the per-source ones.
 *
 * The window closes `windowDays` after the day the lead was raised, compared
 * as calendar strings rather than as instants: both sides are already
 * Asia/Kolkata days by the time they reach here, and turning them back into
 * Date objects to subtract them is how the zone gets lost again.
 */
function tallyCohort(
  leads: CohortLead[],
  range: DateRange,
  windowDays: number,
  day: string,
): Cohort {
  const closed = (createdOn: string) => daysApart(createdOn, day) >= windowDays;

  let converted = 0;
  let closedUnconverted = 0;
  let stillOpen = 0;
  let unresolved = 0;

  for (const lead of leads) {
    switch (outcomeOf(lead, closed)) {
      case "converted":
        converted += 1;
        break;
      case "lost":
        closedUnconverted += 1;
        break;
      case "open":
        stillOpen += 1;
        break;
      default:
        unresolved += 1;
    }
  }

  const decided = converted + closedUnconverted;
  return {
    range,
    windowDays,
    raised: leads.length,
    converted,
    closedUnconverted,
    stillOpen,
    unresolved,
    rate: decided > 0 ? converted / decided : null,
  };
}

/**
 * Whole days between two `YYYY-MM-DD` strings.
 *
 * `Date.UTC` over the parts rather than `Date.parse` over the string: both
 * sides are already days in Asia/Kolkata, so the arithmetic wants a zone that
 * is the same for both and nothing else — and parsing them as local dates
 * would give a different answer on a machine that is not IST, which is every
 * machine this runs on in production.
 */
function daysApart(from: string, to: string): number {
  const at = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((at(to) - at(from)) / 86_400_000);
}

/* ═══════════════════════════════════════════════════ sources & attribution */

export type LeadSourceRow = {
  /** Exactly as it is stored. */
  source: string;
  leads: number;
  converted: number;
  closedUnconverted: number;
  stillOpen: number;
  unresolved: number;
  /** The cohort's own definition, over this source's leads alone. */
  rate: number | null;
  /**
   * The normalised spelling this row clusters under — case folded, punctuation
   * and spacing removed. Two rows sharing one of these are one source spelled
   * twice, which is the whole reason this screen exists.
   */
  fingerprint: string;
};

export type SourceCluster = {
  fingerprint: string;
  /** Biggest first: the spelling with the most leads is the one to merge INTO. */
  spellings: LeadSourceRow[];
  leads: number;
};

export type LeadSourceReport = {
  range: DateRange;
  windowDays: number;
  rows: LeadSourceRow[];
  /** Only the fingerprints carrying more than one spelling. */
  clusters: SourceCluster[];
  /** Leads raised in the window with no source on them at all. */
  unattributed: number;
  total: number;
};

/**
 * The spelling with the meaning taken out.
 *
 * `lead_source` is free text written by a handset, a spreadsheet and an office
 * form, so "Website", "website", "Web-site" and "WEB SITE" are one source and
 * four rows. Folding case, punctuation and spacing catches all four; it
 * deliberately does NOT try to catch "Referral" against "Reference", which is
 * a judgement rather than a spelling and belongs to whoever presses the merge
 * button. A fuzzy match offered as a certainty is how two real sources get
 * silently added together.
 */
function fingerprintOf(source: string): string {
  return source.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Where the business came from, and which of those are the same place twice.
 *
 * The conversion figure is the SAME cohort definition the funnel's headline
 * uses, computed from the same rows — a per-source rate derived some other way
 * would eventually disagree with the total above it, and the half that
 * disagrees is the half somebody is reading.
 */
export async function leadSources(
  range: DateRange,
  windowDays: number,
  day: string,
): Promise<LeadSourceReport> {
  const leads = await cohortLeads(range);

  const bySource = new Map<string, CohortLead[]>();
  let unattributed = 0;
  for (const lead of leads) {
    const s = lead.source?.trim();
    if (!s) {
      unattributed += 1;
      continue;
    }
    const list = bySource.get(s);
    if (list) list.push(lead);
    else bySource.set(s, [lead]);
  }

  const rows: LeadSourceRow[] = [...bySource].map(([source, list]) => {
    const t = tallyCohort(list, range, windowDays, day);
    return {
      source,
      leads: t.raised,
      converted: t.converted,
      closedUnconverted: t.closedUnconverted,
      stillOpen: t.stillOpen,
      unresolved: t.unresolved,
      rate: t.rate,
      fingerprint: fingerprintOf(source),
    };
  });
  rows.sort((a, b) => b.leads - a.leads || a.source.localeCompare(b.source));

  const grouped = new Map<string, LeadSourceRow[]>();
  for (const r of rows) {
    const list = grouped.get(r.fingerprint);
    if (list) list.push(r);
    else grouped.set(r.fingerprint, [r]);
  }
  const clusters: SourceCluster[] = [...grouped]
    .filter(([, list]) => list.length > 1)
    .map(([fingerprint, spellings]) => ({
      fingerprint,
      spellings,
      leads: spellings.reduce((n, s) => n + s.leads, 0),
    }))
    .sort((a, b) => b.leads - a.leads);

  return { range, windowDays, rows, clusters, unattributed, total: leads.length };
}

/**
 * Every distinct `lead_source` in the book, whatever window a screen is
 * showing.
 *
 * The merge dialog needs the whole list rather than the window's — somebody
 * tidying "Web site" away has to be able to merge it into "Website" even where
 * "Website" raised nothing this quarter, and a picker that silently omitted it
 * would make the merge look impossible rather than merely unlisted.
 */
export async function allLeadSources(): Promise<Array<{ source: string; leads: number }>> {
  const scope = await managerScope();
  const rows = await db.execute<{ source: string; n: number }>(sql`
    select c.lead_source as source, count(*)::int as n
      from customers c
     where c.lead_source is not null
       and btrim(c.lead_source) <> ''
       and (c.kind = 'lead' or c.lead_stage is not null)
       ${leadsVisible(scope)}
     group by 1
     order by 2 desc, 1 asc
  `);
  return rows.map((r) => ({ source: r.source, leads: Number(r.n) }));
}

/* ═══════════════════════════════════════════════════ reason-code analytics */

/**
 * Which coded list a transition's reason came from.
 *
 * It is derived from the MOVE rather than stored beside the code, because the
 * move is what decided which list the person was shown: §5's ten answers are
 * offered on the way to Prospect, §10's on the way to a trial, §26's on the
 * way out, and the override list whenever a manager passes a shut gate. A
 * column repeating that would be a second answer to a question the row already
 * answers.
 */
export type ReasonGroupKind = "prospect" | "sample" | "lost" | "override" | "other";

export type ReasonTally = { code: string; count: number };

export type ReasonBreakdown = {
  /** Null is a real value here: a lead nobody owns, or a city nobody typed. */
  id: string | null;
  label: string | null;
  count: number;
  /** The commonest code for this person or place — the "mostly" column. */
  topCode: string | null;
};

export type ReasonGroup = {
  kind: ReasonGroupKind;
  total: number;
  byReason: ReasonTally[];
  bySalesman: ReasonBreakdown[];
  byCity: ReasonBreakdown[];
  /**
   * Moves in this group that carried NO code at all.
   *
   * Every one of them is a question somebody can no longer ask. It is counted
   * rather than dropped, because a list of reasons totalling less than the
   * number of losses above it reads as a broken query — and the true answer,
   * that these were recorded before the code was demanded or through a path
   * that does not demand one, is itself worth knowing.
   */
  uncoded: number;
};

export type ReasonReport = {
  range: DateRange;
  groups: ReasonGroup[];
  /** Every transition in the window, coded or not. */
  transitions: number;
};

/**
 * THE PAYOFF FOR STORING CODES RATHER THAN LABELS.
 *
 * "How many did we lose on credit terms this quarter" is a question somebody
 * can ask here only because `lead_stage_transitions.reason_code` is a code: a
 * stored label stops resolving the day somebody rewords the list, and a free
 * text box answers "why did we lose this" with "price issue" in nine different
 * spellings. This is the screen that makes that decision pay.
 *
 * **The salesman is the lead's OWNER, not whoever pressed the button.** The
 * transition carries an `actor_id`, which on an overridden move is the manager
 * who passed the gate rather than the person whose book the lead is in —
 * grouping by it would file every override against the same three managers and
 * answer a question nobody asked. `owner_id` is what `ASSIGNED_TO_SQL` reads
 * for a lead, so it is what "whose lead was this" already means everywhere
 * else in the product.
 */
export async function reasonAnalytics(range: DateRange): Promise<ReasonReport> {
  const scope = await managerScope();
  const w = istWindow(range);

  const rows = await db.execute<{
    kind: ReasonGroupKind;
    code: string | null;
    salesmanId: string | null;
    salesmanName: string | null;
    city: string | null;
    n: number;
  }>(sql`
    select case
             when t.kind = 'overridden' then 'override'
             when t.to_stage = 'lost' then 'lost'
             when t.to_stage = 'prospect' then 'prospect'
             when t.to_stage = 'sample_trial' then 'sample'
             else 'other'
           end as kind,
           t.reason_code as code,
           c.owner_id as "salesmanId",
           u.name as "salesmanName",
           c.city as city,
           count(*)::int as n
      from lead_stage_transitions t
      join customers c on c.id = t.customer_id
      left join users u on u.id = c.owner_id
     where t.at >= ${w.start}
       and t.at < ${w.end}
       ${leadsVisible(scope)}
     group by 1, 2, 3, 4, 5
  `);

  /* Lost first: it is the question this screen was asked for. */
  const ORDER: ReasonGroupKind[] = ["lost", "prospect", "sample", "override", "other"];

  type Bucket = ReasonBreakdown & { codes: Map<string, number> };
  const groups = new Map<ReasonGroupKind, ReasonGroup>();
  /* Accumulated as maps and flattened at the end: the query groups by five
     columns at once, so the three views this screen draws are three roll-ups
     of one result rather than three round trips at three slightly different
     definitions of the window. */
  const reason = new Map<ReasonGroupKind, Map<string, number>>();
  const salesman = new Map<ReasonGroupKind, Map<string, Bucket>>();
  const city = new Map<ReasonGroupKind, Map<string, Bucket>>();
  let transitions = 0;

  /** A key for "nobody" that no id can collide with. */
  const NONE = "__none__";

  const open = (k: ReasonGroupKind) => {
    let g = groups.get(k);
    if (!g) {
      g = { kind: k, total: 0, byReason: [], bySalesman: [], byCity: [], uncoded: 0 };
      groups.set(k, g);
      reason.set(k, new Map());
      salesman.set(k, new Map());
      city.set(k, new Map());
    }
    return g;
  };

  const bump = (
    into: Map<string, Bucket>,
    id: string | null,
    label: string | null,
    code: string | null,
    n: number,
  ) => {
    const key = id ?? NONE;
    let row = into.get(key);
    if (!row) {
      row = { id, label, count: 0, topCode: null, codes: new Map() };
      into.set(key, row);
    }
    row.count += n;
    if (code) row.codes.set(code, (row.codes.get(code) ?? 0) + n);
  };

  for (const r of rows) {
    const n = Number(r.n);
    transitions += n;
    const g = open(r.kind);
    g.total += n;
    const codes = reason.get(r.kind)!;
    if (r.code) codes.set(r.code, (codes.get(r.code) ?? 0) + n);
    else g.uncoded += n;
    bump(salesman.get(r.kind)!, r.salesmanId, r.salesmanName, r.code, n);
    bump(city.get(r.kind)!, r.city, r.city, r.code, n);
  }

  const settle = (m: Map<string, Bucket>): ReasonBreakdown[] =>
    [...m.values()]
      .map(({ codes, ...row }) => ({
        ...row,
        topCode: [...codes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      }))
      .sort((a, b) => b.count - a.count);

  for (const [k, g] of groups) {
    g.byReason = [...reason.get(k)!]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    g.bySalesman = settle(salesman.get(k)!);
    g.byCity = settle(city.get(k)!);
  }

  return {
    range,
    transitions,
    groups: ORDER.map((k) => groups.get(k)).filter((g): g is ReasonGroup => Boolean(g)),
  };
}
