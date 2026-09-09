import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customers,
  mbosApprovals,
  mbosSamples,
  products,
  sampleFeedback,
  users,
} from "@/db/schema";
import {
  resolveScope,
  scopedToUsers,
  scopedUserIds,
} from "@/lib/access-control";
import { addDays, APP_TIMEZONE } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { chaseOffset } from "@/lib/engines/lead-nurture";
import type { SampleState } from "@/lib/lead-labels";
import { today } from "@/lib/recompute";

/* ---------------------------------------------------------------------------
 * The sample desk — §15 and §16, read.
 *
 * A sample is the most expensive thing a lead can ask for and the easiest to
 * lose track of: it costs stock, it costs a courier, and the whole of its value
 * is in an answer somebody has to go and get afterwards. `mbos_samples.state`
 * is the journey, and every stall on it looks the same in a list sorted by
 * date — so this file is four separate questions rather than one list with a
 * status column, because "approved three weeks ago and never dispatched" and
 * "delivered yesterday" want different people to do different things today.
 *
 * Reads only. The writes are `lib/actions/lead-samples.ts`.
 *
 * NARROWED LIKE EVERY OTHER LIST. A manager's sample desk is their team's
 * samples, not the company's; a reporting screen that skips the narrowing is a
 * way around it rather than a report.
 * ------------------------------------------------------------------------- */

/** Today, in the business's own zone rather than the server's. */
const TODAY = sql`((now() AT TIME ZONE ${APP_TIMEZONE})::date)`;

export type SampleDeskRow = {
  id: string;
  customerId: string;
  customerName: string;
  city: string | null;
  state: SampleState;
  productId: string | null;
  productName: string | null;
  quantityCans: number | null;
  application: string | null;
  reasonCode: string | null;
  salesmanId: string;
  salesmanName: string | null;
  requestedDate: string | null;
  /** Set from the moment somebody approved it. Null on anything unapproved. */
  approvedAt: string | null;
  dispatchedAt: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  expectedDeliveryDate: string | null;
  receivedAt: string | null;
  /** How many times the review has been asked for. See §16. */
  reviewChaseCount: number;
  lastReviewChaseAt: string | null;
  /** Days it has been sitting where it is. What a desk is actually sorted by. */
  waitingDays: number;
};

/**
 * The columns every one of the four lists wants, in one place.
 *
 * Four near-identical selects is four places for a column to be forgotten, and
 * the one that gets forgotten is always the one the screen needed.
 */
const deskColumns = {
  id: mbosSamples.id,
  customerId: mbosSamples.customerId,
  customerName: customers.name,
  city: customers.city,
  state: mbosSamples.state,
  productId: mbosSamples.productId,
  productName: products.name,
  quantityCans: mbosSamples.quantityCans,
  application: mbosSamples.application,
  reasonCode: mbosSamples.reasonCode,
  salesmanId: mbosSamples.salesmanId,
  salesmanName: users.name,
  requestedDate: mbosSamples.requestedDate,
  approvedAt: sql<string | null>`${mbosSamples.approvedAt}`,
  dispatchedAt: sql<string | null>`${mbosSamples.dispatchedAt}`,
  courierName: mbosSamples.courierName,
  trackingNumber: mbosSamples.trackingNumber,
  expectedDeliveryDate: mbosSamples.expectedDeliveryDate,
  receivedAt: sql<string | null>`${mbosSamples.receivedAt}`,
  reviewChaseCount: mbosSamples.reviewChaseCount,
  lastReviewChaseAt: sql<string | null>`${mbosSamples.lastReviewChaseAt}`,
};

/**
 * How long this sample has been where it is, in whole days.
 *
 * Measured from the mark of the state it is IN — approved for one awaiting
 * dispatch, dispatched for one in transit — because "waiting eleven days" is
 * the number that makes somebody act and "requested on the 3rd" is a number
 * they have to do arithmetic on first. Every cast names the zone: a bare one
 * is evaluated in the session's zone, which is not a property of the row.
 */
const waitingDaysFrom = (column: unknown) =>
  sql<number>`greatest(0, (${TODAY} - ((${column} AT TIME ZONE ${APP_TIMEZONE})::date)))::int`;

/** The narrowing, resolved once. Null means the whole book, which accounts get. */
async function visibility() {
  const ctx = await resolveScope();
  return scopedToUsers(scopedUserIds(ctx.scope));
}

const asRow = (r: Record<string, unknown>, waitingDays: number): SampleDeskRow => ({
  id: r.id as string,
  customerId: r.customerId as string,
  customerName: (r.customerName as string) ?? "",
  city: (r.city as string | null) ?? null,
  state: r.state as SampleState,
  productId: (r.productId as string | null) ?? null,
  productName: (r.productName as string | null) ?? null,
  quantityCans: r.quantityCans === null || r.quantityCans === undefined ? null : Number(r.quantityCans),
  application: (r.application as string | null) ?? null,
  reasonCode: (r.reasonCode as string | null) ?? null,
  salesmanId: r.salesmanId as string,
  salesmanName: (r.salesmanName as string | null) ?? null,
  requestedDate: (r.requestedDate as string | null) ?? null,
  approvedAt: (r.approvedAt as string | null) ?? null,
  dispatchedAt: (r.dispatchedAt as string | null) ?? null,
  courierName: (r.courierName as string | null) ?? null,
  trackingNumber: (r.trackingNumber as string | null) ?? null,
  expectedDeliveryDate: (r.expectedDeliveryDate as string | null) ?? null,
  receivedAt: (r.receivedAt as string | null) ?? null,
  reviewChaseCount: Number(r.reviewChaseCount ?? 0),
  lastReviewChaseAt: (r.lastReviewChaseAt as string | null) ?? null,
  waitingDays: Number(waitingDays ?? 0),
});

/**
 * The shared shape of all four: the sample, its customer, its product and the
 * salesman who asked for it, narrowed to the caller's book.
 */
function deskQuery(waiting: ReturnType<typeof waitingDaysFrom>) {
  return db
    .select({ ...deskColumns, waitingDays: waiting })
    .from(mbosSamples)
    .innerJoin(customers, eq(customers.id, mbosSamples.customerId))
    .leftJoin(products, eq(products.id, mbosSamples.productId))
    .leftJoin(users, eq(users.id, mbosSamples.salesmanId));
}

/**
 * Waiting for somebody to say yes.
 *
 * The `mbos_approvals` row is the decision and `state` is the sample's own
 * position, so this reads the sample and trusts the two to be in step — they
 * are written in one transaction by `decideSample`, which is the only thing
 * that moves either.
 */
export async function samplesAwaitingApproval(limit = 100): Promise<SampleDeskRow[]> {
  const scope = await visibility();
  const rows = await deskQuery(waitingDaysFrom(mbosSamples.serverCreatedAt))
    .where(and(eq(mbosSamples.state, "requested"), ...(scope ? [scope] : [])))
    /* Oldest first, and the id breaks the tie — a page whose sort has no
       tiebreaker shows one row twice and another not at all. */
    .orderBy(asc(mbosSamples.serverCreatedAt), asc(mbosSamples.id))
    .limit(limit);
  return rows.map((r) => asRow(r, r.waitingDays));
}

/**
 * Approved and still in the godown.
 *
 * This is the state the whole `state` column was added for. With one status
 * column a sample approved three weeks ago and never sent looked exactly like
 * one under evaluation at a customer's bench, and only one of those is stock
 * nobody gave away and an opportunity nobody took.
 */
export async function samplesAwaitingDispatch(limit = 100): Promise<SampleDeskRow[]> {
  const scope = await visibility();
  const rows = await deskQuery(waitingDaysFrom(mbosSamples.approvedAt))
    .where(and(eq(mbosSamples.state, "approved"), ...(scope ? [scope] : [])))
    .orderBy(asc(mbosSamples.approvedAt), asc(mbosSamples.id))
    .limit(limit);
  return rows.map((r) => asRow(r, r.waitingDays));
}

/**
 * Sent, past the day the courier promised, and nobody has said it arrived.
 *
 * A docket with no movement on it is a sample nobody will ever review, so this
 * is deliberately the promise being BROKEN rather than a list of everything in
 * transit: a parcel due on Thursday is not a problem on Wednesday, and a desk
 * that lists it anyway teaches people to skim the whole list.
 */
export async function samplesOverdueInTransit(limit = 100): Promise<SampleDeskRow[]> {
  const scope = await visibility();
  const rows = await deskQuery(waitingDaysFrom(mbosSamples.dispatchedAt))
    .where(
      and(
        eq(mbosSamples.state, "dispatched"),
        isNotNull(mbosSamples.expectedDeliveryDate),
        lt(mbosSamples.expectedDeliveryDate, TODAY),
        ...(scope ? [scope] : []),
      ),
    )
    .orderBy(asc(mbosSamples.expectedDeliveryDate), asc(mbosSamples.id))
    .limit(limit);
  return rows.map((r) => asRow(r, r.waitingDays));
}

export type SampleAwaitingReview = SampleDeskRow & {
  /** The day the next ask falls, from §16's ladder. */
  nextChaseOn: string | null;
  /** True where that day has already passed. */
  chaseOverdue: boolean;
};

/**
 * Delivered, tried or not, and still nobody knows what they thought.
 *
 * The chase count comes with every row and it is the number that matters: a
 * screen saying "asked three times" is what tells a manager to stop delegating
 * the call and ring the customer themselves. The next chase date is derived
 * here with the same `chaseOffset` the nightly pass uses, so the desk and the
 * job can never name two different days.
 */
export async function samplesAwaitingReview(limit = 100): Promise<SampleAwaitingReview[]> {
  const scope = await visibility();
  const config = await getConfig();
  const ladder = config["leads.sampleReviewChaseDays"];
  const day = await today();

  const rows = await deskQuery(waitingDaysFrom(mbosSamples.receivedAt))
    .where(
      and(
        inArray(mbosSamples.state, ["received", "trial_done"]),
        ...(scope ? [scope] : []),
      ),
    )
    /* Most-chased first: the ones that have been asked about the most are the
       ones closest to being written off, and they are the ones worth a
       manager's own phone call. */
    .orderBy(desc(mbosSamples.reviewChaseCount), asc(mbosSamples.receivedAt), asc(mbosSamples.id))
    .limit(limit);

  return rows.map((r) => {
    const base = asRow(r, r.waitingDays);
    /* The stored mark is an instant, and the day it fell on is the business's
       own — the column comes back from the driver already rendered in that
       zone by the select above, so the date part is the day and nothing here
       truncates an instant of its own. */
    const receivedOn = r.receivedAt ? String(r.receivedAt).slice(0, 10) : null;
    const offset = chaseOffset(ladder, base.reviewChaseCount + 1);
    const nextChaseOn = receivedOn ? addDays(receivedOn, offset) : null;
    return {
      ...base,
      nextChaseOn,
      chaseOverdue: nextChaseOn !== null && nextChaseOn <= day,
    };
  });
}

export type SampleFeedbackRow = {
  sampleId: string;
  customerId: string;
  quality: string | null;
  performance: string | null;
  application: string | null;
  drying: string | null;
  competitorComparison: string | null;
  priceFeedback: string | null;
  otherComments: string | null;
  trialOutcome: string;
  recordedById: string | null;
  recordedByName: string | null;
  recordedAt: string | null;
};

/**
 * What they actually said, once somebody has asked.
 *
 * Null rather than an empty shape when there is no feedback: "not asked yet"
 * and "asked, and they had nothing to say about drying" are different facts
 * about a trial, and seven blank fields render them identically.
 */
export async function sampleFeedbackFor(sampleId: string): Promise<SampleFeedbackRow | null> {
  const scope = await visibility();
  const [row] = await db
    .select({
      sampleId: sampleFeedback.sampleId,
      customerId: sampleFeedback.customerId,
      quality: sampleFeedback.quality,
      performance: sampleFeedback.performance,
      application: sampleFeedback.application,
      drying: sampleFeedback.drying,
      competitorComparison: sampleFeedback.competitorComparison,
      priceFeedback: sampleFeedback.priceFeedback,
      otherComments: sampleFeedback.otherComments,
      trialOutcome: mbosSamples.trialOutcome,
      recordedById: sampleFeedback.recordedById,
      recordedByName: users.name,
      recordedAt: sql<string | null>`${sampleFeedback.recordedAt}`,
    })
    .from(sampleFeedback)
    .innerJoin(mbosSamples, eq(mbosSamples.id, sampleFeedback.sampleId))
    .innerJoin(customers, eq(customers.id, sampleFeedback.customerId))
    .leftJoin(users, eq(users.id, sampleFeedback.recordedById))
    .where(and(eq(sampleFeedback.sampleId, sampleId), ...(scope ? [scope] : [])));

  return row ?? null;
}

export type SampleDeskCounts = {
  awaitingApproval: number;
  awaitingDispatch: number;
  overdueInTransit: number;
  awaitingReview: number;
};

/**
 * The four numbers, for a tile that says what is waiting inside.
 *
 * One query rather than four round trips, and it counts exactly what the four
 * lists above list — a badge counting something other than what its screen
 * shows is the commonest way a launcher tile stops being believed.
 */
export async function sampleDeskCounts(): Promise<SampleDeskCounts> {
  const scope = await visibility();
  const [row] = await db
    .select({
      awaitingApproval: sql<number>`count(*) filter (where ${mbosSamples.state} = 'requested')::int`,
      awaitingDispatch: sql<number>`count(*) filter (where ${mbosSamples.state} = 'approved')::int`,
      overdueInTransit: sql<number>`count(*) filter (where ${mbosSamples.state} = 'dispatched' and ${mbosSamples.expectedDeliveryDate} < ${TODAY})::int`,
      awaitingReview: sql<number>`count(*) filter (where ${mbosSamples.state} in ('received','trial_done'))::int`,
    })
    .from(mbosSamples)
    .innerJoin(customers, eq(customers.id, mbosSamples.customerId))
    .where(scope ? and(scope) : undefined);

  return {
    awaitingApproval: Number(row?.awaitingApproval ?? 0),
    awaitingDispatch: Number(row?.awaitingDispatch ?? 0),
    overdueInTransit: Number(row?.overdueInTransit ?? 0),
    awaitingReview: Number(row?.awaitingReview ?? 0),
  };
}

/**
 * One sample with everything a decision needs, including the approval row that
 * IS the decision.
 *
 * The approval is left-joined rather than assumed: a sample raised before the
 * approvals path existed, or one cancelled before anybody looked at it, has
 * none, and refusing to render it would hide the very rows somebody is trying
 * to account for.
 */
export async function sampleDetail(sampleId: string) {
  const scope = await visibility();
  const [row] = await deskQuery(waitingDaysFrom(mbosSamples.serverCreatedAt))
    .where(and(eq(mbosSamples.id, sampleId), ...(scope ? [scope] : [])));
  if (!row) return null;

  const [approval] = await db
    .select({
      id: mbosApprovals.id,
      state: mbosApprovals.state,
      stepIndex: mbosApprovals.stepIndex,
      approverUserId: mbosApprovals.approverUserId,
      decidedAt: sql<string | null>`${mbosApprovals.decidedAt}`,
      decisionNote: mbosApprovals.decisionNote,
    })
    .from(mbosApprovals)
    .where(
      and(
        eq(mbosApprovals.type, "sample"),
        eq(mbosApprovals.subjectType, "mbos_samples"),
        eq(mbosApprovals.subjectId, sampleId),
      ),
    )
    .orderBy(desc(mbosApprovals.stepIndex), desc(mbosApprovals.requestedAt))
    .limit(1);

  return {
    sample: asRow(row, row.waitingDays),
    approval: approval ?? null,
    feedback: await sampleFeedbackFor(sampleId),
  };
}

/**
 * Every sample on one customer, newest first — the panel on the lead record.
 *
 * Uncapped lists are how a customer record becomes a hundred screens long, so
 * this takes a limit like every other panel there.
 */
export async function samplesForCustomer(customerId: string, limit = 20): Promise<SampleDeskRow[]> {
  const scope = await visibility();
  const rows = await deskQuery(waitingDaysFrom(mbosSamples.serverCreatedAt))
    .where(and(eq(mbosSamples.customerId, customerId), ...(scope ? [scope] : [])))
    .orderBy(desc(mbosSamples.serverCreatedAt), desc(mbosSamples.id))
    .limit(limit);
  return rows.map((r) => asRow(r, r.waitingDays));
}
