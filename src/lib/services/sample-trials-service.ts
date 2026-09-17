import "server-only";
import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { customers, mbosSamples, products, sampleFeedback, users } from "@/db/schema";
import {
  resolveScope,
  scopedToUsers,
  scopedUserIds,
} from "@/lib/access-control";
import { APP_TIMEZONE, type BusinessDate } from "@/lib/business-date";
import type { SampleState } from "@/lib/lead-labels";

/* ---------------------------------------------------------------------------
 * §16 read twice — the chase that does not stop, and the answers it produces.
 *
 * `sample-service.ts` beside this one answers the desk's four questions and is
 * not touched here: a second read of "what is waiting on an answer" is how two
 * screens come to disagree about one trial. What lives in this file is only
 * what that one does not already provide, and it is three things.
 *
 * ONE. The DAY PARTS the chase ladder needs. `sampleChaseDue` takes
 * `BusinessDate`s and `mbos_samples` holds instants, and an instant is not a
 * wall-clock day until something names the midnight — so the day a sample was
 * received is read here with the zone spelled out rather than sliced off
 * whatever the driver happened to render. It is a narrow read for exactly that
 * reason and deliberately does not re-ask which samples are waiting.
 *
 * TWO. The feedback LIBRARY. §16's seven answers are recorded one trial at a
 * time and are worth reading all at once: "better drying than the incumbent,
 * price is the problem" is a pattern across forty trials and a note on one.
 *
 * THREE. The columns of `mbos_samples` the desk's row shape does not carry —
 * the delivery date, the two trial dates, the verdict and the rejection's
 * reason. A sample record has to show all of them, and the desk deliberately
 * shows none: it is a worklist and this is a history.
 *
 * Reads only, narrowed like every other list. A reporting screen that skips
 * the narrowing is a way around it rather than a report.
 * ------------------------------------------------------------------------- */

/** The narrowing, resolved once. Null means the whole book, which accounts get. */
async function visibility(): Promise<SQL | undefined> {
  const ctx = await resolveScope();
  return scopedToUsers(scopedUserIds(ctx.scope));
}

/**
 * A stored instant as the day it fell on, in the business's own zone.
 *
 * `to_char` rather than a cast, and the zone is NAMED rather than left to the
 * session's — the session's zone is not a property of the row, and one pooled
 * connection left in a different one is all it takes for two reads of the same
 * sample to disagree about which day it arrived.
 *
 * It takes the column QUALIFIED, as text. Drizzle renders `${table.column}`
 * inside a raw template as a bare name, which binds to whichever table in
 * scope happens to have one — and these queries join five tables, two of which
 * carry a `recorded_at` or an `id`. Writing the table out is the house rule
 * for exactly that reason: the wrong binding is silent, and both the types and
 * the unit tests pass.
 */
const dayPart = (qualifiedColumn: string) =>
  sql<string | null>`to_char(${sql.raw(qualifiedColumn)} AT TIME ZONE ${APP_TIMEZONE}, 'YYYY-MM-DD')`;

/* ------------------------------------------------------ §16 the chase ladder */

export type SampleChaseDays = {
  /** The day the customer confirmed it arrived. What the ladder counts from. */
  receivedOn: BusinessDate | null;
  /** The day of the last ask, so two passes in one day ask once. */
  lastChasedOn: BusinessDate | null;
};

/**
 * The two days `sampleChaseDue` needs, for samples somebody has already read.
 *
 * It takes IDS rather than asking its own question about which samples are in
 * the loop: that question is `samplesAwaitingReview()`'s and has exactly one
 * answer. This is the zone, and nothing else.
 *
 * An empty list short-circuits rather than sending `in ()` — a query with an
 * empty `IN` is legal, costs a round trip, and returns what we already knew.
 */
export async function sampleChaseDays(
  sampleIds: readonly string[],
): Promise<Record<string, SampleChaseDays>> {
  if (!sampleIds.length) return {};
  const scope = await visibility();

  const rows = await db
    .select({
      id: mbosSamples.id,
      receivedOn: dayPart("mbos_samples.received_at"),
      lastChasedOn: dayPart("mbos_samples.last_review_chase_at"),
    })
    .from(mbosSamples)
    .innerJoin(customers, eq(customers.id, mbosSamples.customerId))
    .where(and(inArray(mbosSamples.id, [...sampleIds]), ...(scope ? [scope] : [])));

  const out: Record<string, SampleChaseDays> = {};
  for (const r of rows) {
    out[r.id] = {
      receivedOn: (r.receivedOn as BusinessDate | null) ?? null,
      lastChasedOn: (r.lastChasedOn as BusinessDate | null) ?? null,
    };
  }
  return out;
}

/* --------------------------------------------------- §16 the feedback library */

export type TrialFeedbackFilters = {
  /** A SKU id. The catalogue's own key, never a typed name. */
  productId?: string | null;
  /**
   * The incumbent the lead named, from `customers.lead_competitor`.
   *
   * It is a stored column and therefore countable. The COMPARISON itself —
   * "better drying than what they use" — is a sentence, and a sentence cannot
   * be grouped, only read. The screen says so rather than offering a filter
   * that would quietly answer a different question.
   */
  competitor?: string | null;
  /** `approved`, `rejected`, `more_testing` or `pending`. */
  outcome?: string | null;
};

export type TrialFeedbackRow = {
  sampleId: string;
  customerId: string;
  customerName: string;
  city: string | null;
  productId: string | null;
  productName: string | null;
  /** What they were using before we asked. Null where nobody wrote it down. */
  competitor: string | null;
  salesmanName: string | null;
  quantityCans: number | null;
  state: SampleState;
  trialOutcome: string;
  /* §16's seven, in the order `FEEDBACK_FIELDS` asks them. */
  quality: string | null;
  performance: string | null;
  application: string | null;
  drying: string | null;
  competitorComparison: string | null;
  priceFeedback: string | null;
  otherComments: string | null;
  recordedByName: string | null;
  recordedAt: string | null;
  recordedOn: string | null;
};

/** The filters, as SQL. One place, so the list and its verdicts cannot differ. */
function filterClauses(filters: TrialFeedbackFilters): SQL[] {
  const out: SQL[] = [];
  if (filters.productId) out.push(eq(mbosSamples.productId, filters.productId));
  if (filters.competitor) out.push(eq(customers.leadCompetitor, filters.competitor));
  if (filters.outcome) {
    out.push(sql`${mbosSamples.trialOutcome}::text = ${filters.outcome}`);
  }
  return out;
}

/**
 * Every trial anybody has written an answer down for.
 *
 * `sample_feedback` is the population rather than `mbos_samples`: this screen
 * is the seven answers, and a sample with no answers has nothing to say on it.
 * What that leaves out is counted and named by `reviewedWithoutFeedback()`
 * below, because a reviewed sample missing from a library of reviews reads as
 * a screen that lost it.
 */
export async function trialFeedback(
  filters: TrialFeedbackFilters = {},
  limit = 200,
): Promise<TrialFeedbackRow[]> {
  const scope = await visibility();

  const rows = await db
    .select({
      sampleId: sampleFeedback.sampleId,
      customerId: sampleFeedback.customerId,
      customerName: customers.name,
      city: customers.city,
      productId: mbosSamples.productId,
      productName: products.name,
      competitor: customers.leadCompetitor,
      salesmanName: users.name,
      quantityCans: mbosSamples.quantityCans,
      state: mbosSamples.state,
      trialOutcome: mbosSamples.trialOutcome,
      quality: sampleFeedback.quality,
      performance: sampleFeedback.performance,
      application: sampleFeedback.application,
      drying: sampleFeedback.drying,
      competitorComparison: sampleFeedback.competitorComparison,
      priceFeedback: sampleFeedback.priceFeedback,
      otherComments: sampleFeedback.otherComments,
      recordedByName: sql<string | null>`(select u2.name from users u2 where u2.id = sample_feedback.recorded_by_id)`,
      recordedAt: sql<string | null>`sample_feedback.recorded_at`,
      recordedOn: dayPart("sample_feedback.recorded_at"),
    })
    .from(sampleFeedback)
    .innerJoin(mbosSamples, eq(mbosSamples.id, sampleFeedback.sampleId))
    .innerJoin(customers, eq(customers.id, sampleFeedback.customerId))
    .leftJoin(products, eq(products.id, mbosSamples.productId))
    .leftJoin(users, eq(users.id, mbosSamples.salesmanId))
    .where(and(...filterClauses(filters), ...(scope ? [scope] : [])))
    /* Newest first, and the id breaks the tie: a hundred reviews recorded in
       one batch share a timestamp, and a sort with no tiebreaker leaves their
       order to the planner. */
    .orderBy(desc(sampleFeedback.recordedAt), desc(sampleFeedback.sampleId))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    customerName: r.customerName ?? "",
    quantityCans:
      r.quantityCans === null || r.quantityCans === undefined ? null : Number(r.quantityCans),
    state: r.state as SampleState,
    trialOutcome: String(r.trialOutcome),
  }));
}

export type TrialFacetOption = { value: string; label: string; count: number };

export type TrialFeedbackFacets = {
  /** SKUs that have been tried, biggest first. */
  products: TrialFacetOption[];
  /** Incumbents named on the leads that were tried, biggest first. */
  competitors: TrialFacetOption[];
  /** Trials where no product was named — real, and not a filter option. */
  noProduct: number;
  /** Trials where nobody recorded what they were using. Also real. */
  noCompetitor: number;
  total: number;
};

/**
 * What there is to filter BY, counted off the same population the list draws.
 *
 * Unfiltered on purpose: a chip row whose counts moved with the selection
 * would say "there are 3 Nano trials" while the thing it is offering to do is
 * show you all 41 of them.
 *
 * The two "not named" figures are not filter options and are printed as
 * sentences instead. A product nobody named and a competitor nobody wrote down
 * are absences, and a chip reading "— 12" is an absence dressed up as a value.
 */
export async function trialFeedbackFacets(): Promise<TrialFeedbackFacets> {
  const scope = await visibility();

  const base = db
    .select({
      productId: mbosSamples.productId,
      productName: products.name,
      competitor: customers.leadCompetitor,
    })
    .from(sampleFeedback)
    .innerJoin(mbosSamples, eq(mbosSamples.id, sampleFeedback.sampleId))
    .innerJoin(customers, eq(customers.id, sampleFeedback.customerId))
    .leftJoin(products, eq(products.id, mbosSamples.productId))
    .where(scope ? and(scope) : undefined);

  const rows = await base;

  const byProduct = new Map<string, TrialFacetOption>();
  const byCompetitor = new Map<string, TrialFacetOption>();
  let noProduct = 0;
  let noCompetitor = 0;

  for (const r of rows) {
    if (r.productId) {
      const hit = byProduct.get(r.productId);
      if (hit) hit.count += 1;
      else
        byProduct.set(r.productId, {
          value: r.productId,
          label: r.productName ?? r.productId,
          count: 1,
        });
    } else noProduct += 1;

    const name = r.competitor?.trim();
    if (name) {
      const hit = byCompetitor.get(name);
      if (hit) hit.count += 1;
      else byCompetitor.set(name, { value: name, label: name, count: 1 });
    } else noCompetitor += 1;
  }

  const biggestFirst = (a: TrialFacetOption, b: TrialFacetOption) =>
    b.count - a.count || a.label.localeCompare(b.label);

  return {
    products: [...byProduct.values()].sort(biggestFirst),
    competitors: [...byCompetitor.values()].sort(biggestFirst),
    noProduct,
    noCompetitor,
    total: rows.length,
  };
}

export type TrialVerdicts = {
  approved: number;
  rejected: number;
  /** A REAL third answer. Never folded into `pending`. */
  moreTesting: number;
  /**
   * Answers written down against a sample whose verdict is still `pending`.
   *
   * It should be empty — `recordSampleFeedback` writes both in one
   * transaction — and it is drawn rather than hidden, because a row nobody can
   * account for is worse than one that says why it is there.
   */
  pending: number;
  total: number;
};

/** The verdict distribution over whatever the screen is currently showing. */
export async function trialVerdicts(
  filters: TrialFeedbackFilters = {},
): Promise<TrialVerdicts> {
  const scope = await visibility();
  const [row] = await db
    .select({
      approved: sql<number>`count(*) filter (where ${mbosSamples.trialOutcome} = 'approved')::int`,
      rejected: sql<number>`count(*) filter (where ${mbosSamples.trialOutcome} = 'rejected')::int`,
      moreTesting: sql<number>`count(*) filter (where ${mbosSamples.trialOutcome} = 'more_testing')::int`,
      pending: sql<number>`count(*) filter (where ${mbosSamples.trialOutcome} = 'pending')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(sampleFeedback)
    .innerJoin(mbosSamples, eq(mbosSamples.id, sampleFeedback.sampleId))
    .innerJoin(customers, eq(customers.id, sampleFeedback.customerId))
    .where(and(...filterClauses(filters), ...(scope ? [scope] : [])));

  return {
    approved: Number(row?.approved ?? 0),
    rejected: Number(row?.rejected ?? 0),
    moreTesting: Number(row?.moreTesting ?? 0),
    pending: Number(row?.pending ?? 0),
    total: Number(row?.total ?? 0),
  };
}

/**
 * Samples marked reviewed that carry no `sample_feedback` row.
 *
 * A NAMED GAP rather than a silent absence. Main's own sample screens wrote
 * `satisfaction` and `rejection_reason` — one box each — before §16's seven
 * questions existed, so a trial reviewed then has a verdict and a sentence and
 * nothing this library can show. Counting them is what stops the library
 * reading as the whole story.
 */
export async function reviewedWithoutFeedback(): Promise<number> {
  const scope = await visibility();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mbosSamples)
    .innerJoin(customers, eq(customers.id, mbosSamples.customerId))
    .where(
      and(
        eq(mbosSamples.state, "reviewed"),
        sql`not exists (select 1 from sample_feedback f where f.sample_id = mbos_samples.id)`,
        ...(scope ? [scope] : []),
      ),
    );
  return Number(row?.n ?? 0);
}

/* ------------------------------------------------------ §26 the sample record */

export type SampleTrialFacts = {
  /**
   * THE CARRIER'S WORD, and the second of the three dates.
   *
   * `dispatchedAt` is ours, this is whoever carried it, and `receivedAt` is
   * the shop's. No two of them are the same fact and none is ever defaulted
   * from another.
   */
  deliveredAt: string | null;
  /** Who told us it had arrived. A name, so the assertion has an author. */
  receivedReportedByName: string | null;
  /** §K — started. The gap to the next column is the point. */
  trialStartedAt: string | null;
  /** §K — finished. Null with a start above it is a trial that went quiet. */
  trialCompletedAt: string | null;
  trialOutcome: string;
  /** Mandatory on a rejection. Null on one is a gap worth saying out loud. */
  rejectionReason: string | null;
  /** The coarse column main's own screens wrote before §16's seven existed. */
  satisfaction: string | null;
  additionalRequirement: string | null;
  feedbackNotes: string | null;
  followUpDate: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  approvedByName: string | null;
  dispatchedByName: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** The rung the lead stood on when the sample was asked for. */
  leadStageAtRequest: string | null;
  convertedOrderId: string | null;
  /**
   * The day parts, with the zone named.
   *
   * Every date arithmetic on the record runs on these rather than on the
   * instants above: an instant is not a wall-clock day until something names
   * the midnight, and the gap between a trial starting and a trial finishing
   * is exactly the number somebody would otherwise work out in the browser's
   * own zone and be five and a half hours wrong about.
   */
  receivedOn: BusinessDate | null;
  lastChasedOn: BusinessDate | null;
  dispatchedOn: BusinessDate | null;
  deliveredOn: BusinessDate | null;
  trialStartedOn: BusinessDate | null;
  trialCompletedOn: BusinessDate | null;
};

/**
 * The rest of one sample — everything `sampleDetail` does not carry.
 *
 * It is a second read of the same row rather than a wider first one because
 * `sampleDetail`'s shape is the DESK's, shared by four worklists, and widening
 * it to suit one record page would put fifteen columns nobody uses on every
 * row of four tables. The record is the one screen that wants all of them.
 *
 * Narrowed identically, so a sample the desk will not show is not readable
 * here either.
 */
export async function sampleTrialFacts(sampleId: string): Promise<SampleTrialFacts | null> {
  const scope = await visibility();
  const [row] = await db
    .select({
      deliveredAt: sql<string | null>`mbos_samples.delivered_at`,
      receivedReportedByName: sql<string | null>`(select u.name from users u where u.id = mbos_samples.received_reported_by_id)`,
      trialStartedAt: sql<string | null>`mbos_samples.trial_started_at`,
      trialCompletedAt: sql<string | null>`mbos_samples.trial_completed_at`,
      trialOutcome: mbosSamples.trialOutcome,
      rejectionReason: mbosSamples.rejectionReason,
      satisfaction: mbosSamples.satisfaction,
      additionalRequirement: mbosSamples.additionalRequirement,
      feedbackNotes: mbosSamples.feedbackNotes,
      followUpDate: mbosSamples.followUpDate,
      reviewedAt: sql<string | null>`mbos_samples.reviewed_at`,
      reviewedByName: sql<string | null>`(select u.name from users u where u.id = mbos_samples.reviewed_by_id)`,
      approvedByName: sql<string | null>`(select u.name from users u where u.id = mbos_samples.approved_by_id)`,
      dispatchedByName: sql<string | null>`(select u.name from users u where u.id = mbos_samples.dispatched_by_id)`,
      cancelledAt: sql<string | null>`mbos_samples.cancelled_at`,
      cancelReason: mbosSamples.cancelReason,
      leadStageAtRequest: mbosSamples.leadStageAtRequest,
      convertedOrderId: mbosSamples.convertedOrderId,
      receivedOn: dayPart("mbos_samples.received_at"),
      lastChasedOn: dayPart("mbos_samples.last_review_chase_at"),
      dispatchedOn: dayPart("mbos_samples.dispatched_at"),
      deliveredOn: dayPart("mbos_samples.delivered_at"),
      trialStartedOn: dayPart("mbos_samples.trial_started_at"),
      trialCompletedOn: dayPart("mbos_samples.trial_completed_at"),
    })
    .from(mbosSamples)
    .innerJoin(customers, eq(customers.id, mbosSamples.customerId))
    .where(and(eq(mbosSamples.id, sampleId), ...(scope ? [scope] : [])));

  if (!row) return null;
  return {
    ...row,
    trialOutcome: String(row.trialOutcome),
    leadStageAtRequest: row.leadStageAtRequest ? String(row.leadStageAtRequest) : null,
    receivedOn: (row.receivedOn as BusinessDate | null) ?? null,
    lastChasedOn: (row.lastChasedOn as BusinessDate | null) ?? null,
    dispatchedOn: (row.dispatchedOn as BusinessDate | null) ?? null,
    deliveredOn: (row.deliveredOn as BusinessDate | null) ?? null,
    trialStartedOn: (row.trialStartedOn as BusinessDate | null) ?? null,
    trialCompletedOn: (row.trialCompletedOn as BusinessDate | null) ?? null,
  };
}

/**
 * Whether anything in this book has ever had a trial reviewed at all.
 *
 * The difference between "nothing matches your filters" and "nobody has ever
 * recorded a trial" is the whole of whether an empty screen is a dead end or a
 * filter to clear, and no empty list can say which on its own.
 */
export async function anyTrialFeedbackExists(): Promise<boolean> {
  const scope = await visibility();
  const [row] = await db
    .select({ n: sql<number>`1` })
    .from(sampleFeedback)
    .innerJoin(mbosSamples, eq(mbosSamples.id, sampleFeedback.sampleId))
    .innerJoin(customers, eq(customers.id, sampleFeedback.customerId))
    .where(and(isNotNull(sampleFeedback.sampleId), ...(scope ? [scope] : [])))
    .limit(1);
  return Boolean(row);
}
