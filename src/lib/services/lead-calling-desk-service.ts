import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  calls,
  type OrderLine,
  leadVerificationCorrections,
  mbosLeadValidations,
  products,
  users,
} from "@/db/schema";
import {
  CALL_MARK,
  DESK_FIELDS,
  answeredCount,
  deskLadderSalesType,
  isCallOutcome,
  isOnlineSource,
  isRequestState,
  ladderKeyOf,
  ladderKeyOfLost,
  nextActionKindOf,
  nextCallNumber,
  parseLostNote,
  phaseOf,
  requiredProgress,
  type CallOutcome,
  type DeskFieldKey,
  type DeskPhase,
  type DeskValues,
  type DeskView,
  type LadderKey,
  type NextActionKind,
  type RequestState,
} from "../engines/lead-calling-desk";
import { QUALIFICATION_CONDITIONS, gateTo } from "../engines/lead-gates";
import { ladderFor } from "../engines/lead-ladder";
import { resolveScope, scopedToUsers, scopedUserIds } from "../access-control";
import { MBOS_EVENT } from "../timeline";
import { asDate, calendarDate } from "../business-date";
import { countsAsPurchase } from "../order-status";
import { deskReference } from "../calling-desk-labels";
import { deskSummary, type DeskLeadRow, type DeskSummary } from "../calling-desk-summary";
import type { LeadPriority } from "../lead-priority";
import type { LeadSalesType, LeadStage } from "../lead-labels";
import {
  leadReceipts,
  leadRecord,
  leadTransitions,
  type LeadRecord,
} from "./lead-console-service";
import { leadRow, leadGateInput } from "./lead-service";
import { leadSamplesFor } from "./lead-record-service";

/* ---------------------------------------------------------------------------
 * The calling desk's reads: the dashboard, and one lead's whole record.
 *
 * Reads only. The three-call rule itself is `engines/lead-calling-desk.ts` and
 * every write is in `actions/lead-calling-desk.ts`; what lives here is getting
 * the facts those two are given, narrowed the way every other CRM list is.
 *
 * NARROWING IS `resolveScope`, THE SAME ONE EVERY OTHER CRM LIST USES. It pins
 * an associate to their own book, gives a manager their reports', and reads the
 * grant for the app named on the request — so this is a personal desk without
 * this file knowing who is asking. `scopedToUsers` is the shared clause and it
 * is written against `customers.<column>`, which is why the queries below select
 * from the table under its own name rather than an alias.
 *
 * It is NOT `managerScope`, which the Leads list narrows by and which looks like
 * the obvious choice: that narrows a REGIONAL MANAGER by territory and answers
 * "everybody" for anyone with no territory row — every associate. A desk built
 * on it counted the whole country's leads as one caller's work.
 *
 * A QUALIFICATION CALL IS A ROW IN `calls`, marked by `outcome_detail.qualCall`.
 * The CRM's own call history already holds every call anybody ever made at a
 * customer, and a second table for these would put half of one lead's calls in
 * a place the record's history, the EOD counts and the customer timeline do not
 * read. What separates a qualification call from any other is the marker, and
 * `CALL_MARK` is the one place that is spelled.
 * ------------------------------------------------------------------------- */

/** How many rows a list draws. The tiles are counted over the whole set. */
export const DESK_PAGE = 100;

/** Every lead the desk reads in one pass, so the tiles are counted over the same rows the list draws. */
const DESK_LEAD_CAP = 5000;

export type CallingDesk = DeskSummary & {
  /** Every lead in scope, lean — the dashboard filters these in the page. */
  all: DeskLeadRow[];
};

type RawRow = {
  id: string;
  name: string;
  companyName: string | null;
  city: string | null;
  source: string | null;
  stage: string;
  salesType: string | null;
  priority: string | null;
  createdAt: Date | string;
  nextAction: string | null;
  nextActionDate: string | null;
  ownerName: string | null;
  nextOwnerName: string | null;
  managerName: string | null;
  requestState: string | null;
  requestedAt: Date | string | null;
  lostFrom: string | null;
  decisionMaker: string | null;
  buyer: string | null;
  monthlyLitres: number | null;
  potentialPaise: number | null;
  requiredProductId: string | null;
  competitor: string | null;
  customerType: string | null;
  application: string | null;
  creditDaysWanted: number | null;
  gstin: string | null;
  address: string | null;
  email: string | null;
  callCount: number;
  callOutcomes: string[] | null;
};

/** The twelve answers, as the engine reads them. */
function valuesOf(r: RawRow): DeskValues {
  return {
    customerType: r.customerType,
    decisionMaker: r.decisionMaker,
    buyer: r.buyer,
    gstin: r.gstin,
    monthlyLitres: r.monthlyLitres,
    potentialPaise: r.potentialPaise,
    creditDaysWanted: r.creditDaysWanted,
    requiredProductId: r.requiredProductId,
    competitor: r.competitor,
    application: r.application,
    address: r.address,
    email: r.email,
  };
}

function toRow(r: RawRow): DeskLeadRow {
  const values = valuesOf(r);
  const state = isRequestState(r.requestState) ? r.requestState : null;
  const phase = phaseOf(r.stage as LeadStage, values, Number(r.callCount), state);
  const progress = requiredProgress(values);
  const pending = phase === "requested" || phase === "followup";
  return {
    id: r.id,
    name: r.companyName || r.name,
    city: r.city,
    source: r.source,
    stage: r.stage as LeadStage,
    salesType: r.salesType as LeadSalesType | null,
    priority: r.priority as LeadPriority | null,
    createdAt: new Date(r.createdAt).toISOString(),
    nextAction: r.nextAction,
    nextActionDate: r.nextActionDate,
    nextActionKind: nextActionKindOf(r.nextAction),
    responsible: pending ? (r.managerName ?? r.nextOwnerName) : (r.nextOwnerName ?? r.ownerName),
    callCount: Number(r.callCount),
    callOutcomes: (r.callOutcomes ?? []).filter(isCallOutcome),
    phase,
    nextCall: nextCallNumber(phase),
    answered: progress.done,
    required: progress.total,
    ladderKey:
      phase === "lost"
        ? ladderKeyOfLost(r.lostFrom as LeadStage | null, values, Number(r.callCount))
        : ladderKeyOf(phase),
    requestedAt: r.requestedAt ? new Date(r.requestedAt).toISOString() : null,
  };
}

const MARK = sql.raw(`'${CALL_MARK}'`);

/**
 * The columns a row needs, in one place.
 *
 * `::float8` on the rupee column and `::int` on the counts, because the driver
 * hands a `bigint` back as a string and every reader below does arithmetic on
 * these. A paise figure is far below 2^53, so nothing is lost.
 */
const ROW_COLUMNS = sql`
  customers.id, customers.name, customers.company_name as "companyName", customers.city,
  customers.lead_source as source,
  customers.lead_stage::text as stage, customers.lead_sales_type::text as "salesType",
  customers.lead_priority::text as priority,
  customers.created_at as "createdAt",
  customers.lead_next_action as "nextAction", customers.lead_next_action_date::text as "nextActionDate",
  ou.name as "ownerName", nu.name as "nextOwnerName", lm.name as "managerName",
  customers.prospect_request_state as "requestState",
  customers.prospect_requested_at as "requestedAt",
  (select t.from_stage::text from lead_stage_transitions t
     where t.customer_id = customers.id and t.to_stage = 'lost'
     order by t.at desc limit 1) as "lostFrom",
  customers.lead_decision_maker as "decisionMaker", customers.lead_buyer as buyer,
  customers.lead_monthly_volume_litres::int as "monthlyLitres",
  customers.lead_estimated_potential_paise::float8 as "potentialPaise",
  customers.lead_required_product_id as "requiredProductId",
  customers.lead_competitor as competitor, customers.customer_type::text as "customerType",
  customers.lead_application as application,
  customers.lead_credit_days_wanted::int as "creditDaysWanted", customers.gstin,
  customers.address, customers.email,
  (select count(*)::int from calls k
     where k.customer_id = customers.id and k.outcome_detail->>${MARK} is not null) as "callCount",
  (select array_agg(k.outcome_detail->>'qualOutcome' order by k.started_at) from calls k
     where k.customer_id = customers.id and k.outcome_detail->>${MARK} is not null) as "callOutcomes"`;

const ROW_JOINS = sql`
  left join users ou on ou.id = customers.owner_id
  left join users nu on nu.id = customers.lead_next_action_owner_id
  left join users lm on lm.id = customers.lead_manager_id`;

/**
 * The desk: the tiles, the lifecycle strip, the two side cards and the list
 * behind whichever tile was pressed.
 *
 * ONE PASS OVER THE BOOK decides all of it, by running `inView` over the same
 * rows the list draws — so a tile that says 14 opens a list of 14.
 *
 * `day` is passed in: a `now()` inside the statement would read the session's
 * zone, and on a server running in GMT that puts a call due tomorrow on today.
 */
export async function callingDesk(day: string, view: DeskView): Promise<CallingDesk> {
  const own = scopedToUsers(scopedUserIds((await resolveScope()).scope));
  const where = sql`customers.lead_stage is not null and customers.lead_archived = false ${
    own ? sql`and ${own}` : sql``
  }`;

  const raw = await db.execute<RawRow>(sql`
    select ${ROW_COLUMNS}
      from customers ${ROW_JOINS}
     where ${where}
     order by customers.lead_next_action_date asc nulls first, customers.created_at desc
     limit ${DESK_LEAD_CAP}`);

  const all = [...raw].map(toRow);
  const summary = deskSummary(all, view, day);

  return {
    ...summary,
    rows: summary.rows.slice(0, DESK_PAGE),
    ready: summary.ready.slice(0, 8),
    pending: summary.pending.slice(0, 8),
    all,
  };
}

/* ------------------------------------------------------------------ one lead */

export type DeskCall = {
  callNumber: number;
  at: string;
  outcome: CallOutcome;
  noAnswerReason: string | null;
  /** What this call captured, as it reads on the record now. */
  answers: { key: DeskFieldKey; label: string; value: string }[];
  notes: string | null;
  nextAction: string | null;
  nextDate: string | null;
  finalDisposition: string | null;
  byName: string;
};

/**
 * What the Sales Manager's verification made of one answer.
 *
 * `unverified` is the third answer `lead_verification_corrections` records —
 * asked, and could not be established — and it is neither of the other two, so
 * it is drawn as its own words rather than folded into either.
 */
export type DeskMark = { kind: "confirmed" | "corrected" | "unverified"; was: string | null };

export type DeskTimelineItem = {
  at: string;
  title: string;
  actor: string | null;
  who: "system" | "desk" | "manager" | "customer" | "other";
};

export type DeskMessage = { code: string; label: string; note: string | null; at: string };

export type DeskVerification = {
  verdict: string;
  /** The four-way result, in the words the Sales Manager's own screens use. */
  result: "Verified" | "Verified With Corrections" | "Follow-Up Required" | "Verification Failed";
  byName: string;
  at: string;
  note: string | null;
  /** Which verification call this was on the lead — the first is usually the one that matters. */
  attempt: number;
  explained: string | null;
  visited: string | null;
  genuineInterest: string | null;
  objections: { label: string; value: string }[];
  readiness: { label: string; value: string }[];
  impression: string | null;
  counts: { confirmed: number; corrected: number; unable: number };
  corrections: { label: string; original: string | null; corrected: string; reason: string }[];
};

export type DeskOrder = {
  orderNo: string | null;
  product: string | null;
  quantityCans: number | null;
  litres: number | null;
  amountPaise: number;
  status: string;
  orderedAt: string;
};

export type DeskMilestone = "first_order" | "delivery" | "payment" | "second_order" | "customer";

export type DeskLeadRecord = {
  id: string;
  /** `TC-1042` — a readable reference, never a slice of the id. */
  reference: string;
  name: string;
  companyName: string | null;
  city: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  source: string;
  createdAt: string;
  enquiry: string | null;
  stage: LeadStage;
  salesType: LeadSalesType | null;
  priority: LeadPriority | null;
  phase: DeskPhase;
  ladder: readonly LadderKey[];
  ladderIndex: number;
  stageDates: Partial<Record<LadderKey, string>>;
  ownerName: string | null;
  managerName: string | null;
  values: DeskValues;
  /** Whether the GST number has been checked against the register. */
  gstVerified: boolean;
  productName: string | null;
  /** Which call captured each answer. Absent means it came with the enquiry. */
  answeredOn: Partial<Record<DeskFieldKey, number>>;
  marks: Partial<Record<DeskFieldKey, DeskMark>>;
  calls: DeskCall[];
  callCount: number;
  requestState: RequestState | null;
  requestedAt: string | null;
  requestedByName: string | null;
  requestReason: string | null;
  requestNote: string | null;
  /** What the manager wrote when they sent it back or put it on hold. */
  managerNote: string | null;
  verification: DeskVerification | null;
  verifiedAt: string | null;
  nextAction: {
    text: string;
    date: string | null;
    ownerName: string | null;
    outcome: string | null;
    kind: NextActionKind | null;
  } | null;
  lost: {
    reasonCode: string | null;
    /** The desk's own label for it, where the desk closed it. */
    deskLabel: string | null;
    /** What was written beside the reason. */
    detail: string | null;
    at: string | null;
    byName: string | null;
  } | null;
  qualification: { done: number; total: number; conditions: { id: string; says: string; done: boolean }[] } | null;
  sample: {
    state: string;
    trialOutcome: string;
    reasonCode: string | null;
    requestedDate: string | null;
    dispatchedAt: string | null;
    receivedAt: string | null;
    reviewedAt: string | null;
    quantityCans: number | null;
    productName: string | null;
    rejectionReason: string | null;
    feedback: Record<string, string> | null;
  } | null;
  commitment: { expectedDate: string | null; cans: number | null; valuePaise: number | null; blockerCode: string | null } | null;
  order: DeskOrder | null;
  /** When each after-sales step happened, read off the ledger and falling back to the stage moves. */
  milestones: Partial<Record<DeskMilestone, string>>;
  chain: { distributor: string | null; salesman: string | null } | null;
  messages: DeskMessage[];
  /** Oldest first — the order a story is told in. */
  timeline: DeskTimelineItem[];
};

/** The manager's own words on a request that came back or is on hold. */
function managerNoteFor(
  state: RequestState | null,
  validationNote: string | null,
  events: { eventType: string; summary: string }[],
): string | null {
  if (state === "followup") return validationNote;
  if (state !== "returned") return null;
  const e = events.find((x) => x.eventType === MBOS_EVENT.prospectReturned);
  if (!e) return null;
  const at = e.summary.indexOf(": ");
  return at >= 0 ? e.summary.slice(at + 2) : e.summary;
}

/**
 * Whether this lead is one the request's scope lets the caller see.
 *
 * The record page reads through `leadRecord`, which narrows by manager
 * territory and is vacuous for an associate — so a URL with somebody else's id
 * would open it. The desk is a personal one, so it asks the shared scope
 * clause too and answers 404 for anything outside it.
 */
async function inDeskScope(customerId: string): Promise<boolean> {
  const own = scopedToUsers(scopedUserIds((await resolveScope()).scope));
  const rows = await db.execute<{ n: number }>(sql`
    select 1 as n from customers
     where customers.id = ${customerId} and customers.lead_stage is not null
       ${own ? sql`and ${own}` : sql``}
     limit 1`);
  return rows.length > 0;
}

const FINDING_KEY: Record<string, DeskFieldKey> = {
  competitor: "competitor",
  monthly_litres: "monthlyLitres",
  potential: "potentialPaise",
  required_product: "requiredProductId",
  decision_maker: "decisionMaker",
  credit_days: "creditDaysWanted",
  application: "application",
  customer_type: "customerType",
};

const day = (v: unknown): string | undefined => {
  const d = asDate(v);
  return d ? (calendarDate(d) as string) : undefined;
};

/** What was on an order's lines, in the words the desk draws. */
async function describeLines(
  lines: OrderLine[] | null,
): Promise<{ product: string | null; cans: number | null; litres: number | null }> {
  const items = (lines ?? []).filter((l) => l && l.product);
  if (!items.length) return { product: null, cans: null, litres: null };
  const names = [...new Set(items.map((l) => l.product))];
  const cans = items.reduce((n, l) => n + (Number(l.quantity) || 0), 0);
  const known = await db
    .select({ name: products.name, ml: products.millilitresPerCan })
    .from(products)
    .where(inArray(products.name, names));
  const mlOf = new Map(known.map((k) => [k.name, k.ml]));
  /* Litres only where every line's product is on the catalogue with a pack
     size: a total over half the lines is a number that looks complete. */
  const litres = items.every((l) => (mlOf.get(l.product) ?? 0) > 0)
    ? items.reduce((n, l) => n + ((Number(l.quantity) || 0) * (mlOf.get(l.product) ?? 0)) / 1000, 0)
    : null;
  return {
    product: names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2} more` : names.join(", "),
    cans: cans || null,
    litres: litres && litres > 0 ? Math.round(litres * 10) / 10 : null,
  };
}

/**
 * One lead, whole — everything the record's four tabs and its cards draw.
 *
 * It reuses the funnel's own reads (`leadRecord`, `leadTransitions`,
 * `leadOrders`, `leadSamplesFor`, the gate for the checklist) and adds only what
 * is the desk's: the qualification calls, which call captured which answer, the
 * request, and the messages. Nothing is copied into a second table.
 *
 * Null covers "no such lead" and "not yours", deliberately the same answer.
 */
export async function deskLeadRecord(customerId: string, today: string): Promise<DeskLeadRecord | null> {
  if (!(await inDeskScope(customerId))) return null;

  const [rec, lead] = await Promise.all([leadRecord(customerId, today), leadRow(customerId)]);
  if (!rec || !lead) return null;

  const extras = (
    await db.execute<{
      createdAt: Date | string;
      email: string | null;
      address: string | null;
      enquiry: string | null;
      buyer: string | null;
      requestState: string | null;
      requestedAt: Date | string | null;
      requestedByName: string | null;
      requestReason: string | null;
      requestNote: string | null;
      ownerName: string | null;
      blocker: string | null;
      rank: number;
    }>(sql`
      select customers.created_at as "createdAt", customers.email, customers.address,
             customers.lead_notes as enquiry, customers.lead_buyer as buyer,
             customers.prospect_request_state as "requestState",
             customers.prospect_requested_at as "requestedAt",
             rb.name as "requestedByName",
             customers.prospect_request_reason as "requestReason",
             customers.prospect_request_note as "requestNote",
             ou.name as "ownerName",
             customers.lead_expected_order_blocker_code as blocker,
             (select count(*)::int from customers c2
               where c2.lead_stage is not null
                 and (c2.created_at, c2.id) <= (customers.created_at, customers.id)) as rank
        from customers
        left join users rb on rb.id = customers.prospect_requested_by_id
        left join users ou on ou.id = customers.owner_id
       where customers.id = ${customerId}`)
  )[0];

  const values: DeskValues = {
    customerType: lead.customerType,
    decisionMaker: lead.leadDecisionMaker,
    buyer: extras?.buyer ?? null,
    gstin: lead.gstin,
    monthlyLitres: lead.leadMonthlyVolumeLitres,
    potentialPaise: lead.leadEstimatedPotentialPaise,
    creditDaysWanted: lead.leadCreditDaysWanted,
    requiredProductId: lead.leadRequiredProductId,
    competitor: lead.leadCompetitor,
    application: lead.leadApplication,
    address: extras?.address ?? null,
    email: extras?.email ?? null,
  };

  const [callRows, validations, transitions, samples, timelineRows, orderRows, receipts] = await Promise.all([
    db
      .select({
        at: calls.startedAt,
        notes: calls.notes,
        detail: calls.outcomeDetail,
        byName: users.name,
      })
      .from(calls)
      .innerJoin(users, eq(users.id, calls.userId))
      .where(
        and(eq(calls.customerId, customerId), sql`${calls.outcomeDetail}->>${MARK} is not null`),
      )
      .orderBy(asc(calls.startedAt)),
    db
      .select({
        id: mbosLeadValidations.id,
        verdict: mbosLeadValidations.verdict,
        note: mbosLeadValidations.verdictReason,
        at: mbosLeadValidations.calledAt,
        reached: mbosLeadValidations.reached,
        byName: users.name,
        explained: mbosLeadValidations.mahekExplained,
        visited: mbosLeadValidations.salesmanVisited,
        genuine: mbosLeadValidations.genuineInterest,
        price: mbosLeadValidations.priceConcern,
        credit: mbosLeadValidations.creditConcern,
        competitor: mbosLeadValidations.competitorConcern,
        readyTrial: mbosLeadValidations.readyForTrial,
        readyCommercial: mbosLeadValidations.readyForCommercial,
        readyOrder: mbosLeadValidations.readyForOrder,
        impression: mbosLeadValidations.salesmanFeedback,
      })
      .from(mbosLeadValidations)
      .innerJoin(users, eq(users.id, mbosLeadValidations.calledByUserId))
      .where(eq(mbosLeadValidations.customerId, customerId))
      .orderBy(desc(mbosLeadValidations.calledAt))
      .limit(10),
    leadTransitions(customerId),
    leadSamplesFor(customerId, { limit: 1 }),
    db.execute<{
      eventType: string;
      sourceRecordId: string | null;
      occurredAt: Date;
      summary: string;
      actorId: string | null;
      actorName: string | null;
    }>(sql`
      select t.event_type as "eventType", t.source_record_id as "sourceRecordId",
             t.occurred_at as "occurredAt", t.summary, t.actor_user_id as "actorId",
             u.name as "actorName"
        from timeline_events t left join users u on u.id = t.actor_user_id
       where t.customer_id = ${customerId}
       order by t.occurred_at desc, t.id desc
       limit 80`),
    db.execute<{
      orderNo: string | null;
      orderedAt: Date | string;
      total: number;
      status: string;
      lineItems: OrderLine[] | null;
      deliveryConfirmedAt: Date | string | null;
    }>(sql`
      select o.order_no as "orderNo", o.ordered_at as "orderedAt",
             o.total_amount::float8 as total, o.status::text as status,
             o.line_items as "lineItems", o.delivery_confirmed_at as "deliveryConfirmedAt"
        from orders o
       where o.customer_id = ${customerId}
       order by o.ordered_at asc, o.id asc
       limit 50`),
    leadReceipts(customerId),
  ]);

  const requestState = isRequestState(extras?.requestState) ? extras.requestState : null;
  const phase = phaseOf(lead.leadStage, values, callRows.length, requestState);

  /* ---- the calls, and which one captured which answer ---- */
  const answeredOn: Partial<Record<DeskFieldKey, number>> = {};
  const deskCalls: DeskCall[] = [];
  const valueText = (key: DeskFieldKey): string => {
    const v = values[key];
    if (key === "requiredProductId") return rec.requiredProductName ?? "Chosen";
    if (key === "monthlyLitres") return `${Number(v).toLocaleString("en-IN")} litres a month`;
    if (key === "potentialPaise") return `₹${Math.round(Number(v) / 100).toLocaleString("en-IN")} a month`;
    if (key === "creditDaysWanted") return `${v} days`;
    return String(v ?? "");
  };
  for (const r of callRows) {
    const d = (r.detail ?? {}) as Record<string, string>;
    const n = Number(d[CALL_MARK]);
    const keys = (d.answered ?? "").split(",").filter(Boolean) as DeskFieldKey[];
    for (const k of keys) answeredOn[k] ??= n;
    deskCalls.push({
      callNumber: n,
      at: r.at.toISOString(),
      outcome: isCallOutcome(d.qualOutcome) ? d.qualOutcome : "spoke_callback",
      noAnswerReason: d.noAnswerReason ?? null,
      answers: keys
        .filter((k) => DESK_FIELDS.some((f) => f.key === k))
        .map((k) => ({ key: k, label: DESK_FIELDS.find((f) => f.key === k)!.label, value: valueText(k) })),
      notes: r.notes,
      nextAction: d.nextAction ?? null,
      nextDate: d.nextDate ?? null,
      finalDisposition: d.final ?? null,
      byName: r.byName,
    });
  }

  /* ---- what the manager's verification made of each answer ---- */
  const validation = validations[0] ?? null;
  /* EVERY check on this lead, from either door — a verification call, and the
     * salesman's own second visit, which is the only place "unable to verify" is
     * recorded (nobody rang anybody, so there is no call to hang it on). The
     * newest answer to a finding is the one drawn beside it. */
  const allChecks = await db
    .select({
      validationId: leadVerificationCorrections.validationId,
      field: leadVerificationCorrections.field,
      verdict: leadVerificationCorrections.verdict,
      original: leadVerificationCorrections.original,
      corrected: leadVerificationCorrections.corrected,
      reason: leadVerificationCorrections.reason,
    })
    .from(leadVerificationCorrections)
    .where(eq(leadVerificationCorrections.customerId, customerId))
    .orderBy(asc(leadVerificationCorrections.changedAt));
  /* What THIS call corrected, for the card's own list. */
  const checks = allChecks.filter((c) => validation && c.validationId === validation.id);
  const marks: Partial<Record<DeskFieldKey, DeskMark>> = {};
  if (validation?.verdict === "confirmed") {
    /* A verification that passed and named nothing against a finding has
       confirmed it — the recorded rows below override this where they exist. */
    for (const key of Object.values(FINDING_KEY)) {
      if (values[key] !== null && values[key] !== undefined) marks[key] = { kind: "confirmed", was: null };
    }
  }
  for (const c of allChecks) {
    const key = FINDING_KEY[c.field];
    if (!key) continue;
    marks[key] = {
      kind: c.verdict === "corrected" ? "corrected" : c.verdict === "unverified" ? "unverified" : "confirmed",
      was: c.verdict === "corrected" ? c.original : null,
    };
  }
  const counts = { confirmed: 0, corrected: 0, unable: 0 };
  for (const m of Object.values(marks)) {
    if (m.kind === "confirmed") counts.confirmed++;
    else if (m.kind === "corrected") counts.corrected++;
    else counts.unable++;
  }

  /* ---- the ladder, and when each rung was reached ---- */
  const lostMove = transitions.find((t) => t.toStage === "lost");
  const ladder = ladderFor(deskLadderSalesType(lead.leadSalesType)) as readonly LadderKey[];
  const stageDates: Partial<Record<LadderKey, string>> = {};
  for (const t of [...transitions].reverse()) {
    const k = t.toStage as LadderKey;
    if ((ladder as readonly string[]).includes(k)) stageDates[k] ??= day(t.at);
  }
  stageDates.suspect ??= day(extras?.createdAt);
  const key =
    phase === "lost"
      ? ladderKeyOfLost(lostMove?.fromStage ?? null, values, callRows.length)
      : ladderKeyOf(phase);

  /* ---- the qualification checklist, read through the gate that enforces it ---- */
  let qualification: DeskLeadRecord["qualification"] = null;
  if (
    lead.leadSalesType !== "distributor" &&
    ["qualification", "sample_trial", "sample_received", "sample_review", "negotiation", "first_order", "delivery", "payment", "second_order", "customer"].includes(phase)
  ) {
    const gate = await leadGateInput(customerId);
    const missing = new Set(
      gate ? gateTo(gate, "sample_trial").missing.map((c) => c.id) : QUALIFICATION_CONDITIONS.map((c) => c.id),
    );
    const conditions = QUALIFICATION_CONDITIONS.map((c) => ({
      id: c.id,
      says: c.says,
      /* A lead already past the rung satisfied it, whatever the columns read now. */
      done: phase !== "qualification" || !missing.has(c.id),
    }));
    qualification = { done: conditions.filter((c) => c.done).length, total: conditions.length, conditions };
  }

  const sample = samples[0] ?? null;

  /* ---- the order, and the after-sales steps read off the ledger ---- */
  const counting = orderRows.filter((o) => countsAsPurchase(o.status));
  const first = counting[0] ?? orderRows[0] ?? null;
  const lines = first ? await describeLines(first.lineItems) : null;
  const paid = receipts
    .filter((r) => r.status === "confirmed")
    .map((r) => r.receivedAt)
    .sort()[0];
  const milestones: Partial<Record<DeskMilestone, string>> = {};
  const m1 = day(counting[0]?.orderedAt) ?? stageDates.first_order;
  if (m1) milestones.first_order = m1;
  const m2 = day(counting[0]?.deliveryConfirmedAt) ?? stageDates.delivery;
  if (m2) milestones.delivery = m2;
  const m3 = paid ?? stageDates.payment;
  if (m3) milestones.payment = m3;
  const m4 = day(counting[1]?.orderedAt) ?? stageDates.second_order;
  if (m4) milestones.second_order = m4;
  const m5 = day(rec.convertedAt) ?? stageDates.customer;
  if (m5) milestones.customer = m5;

  /* ---- messages, and the timeline told oldest first ---- */
  const messages: DeskMessage[] = timelineRows
    .filter((t) => t.eventType === MBOS_EVENT.leadCommunication)
    .map((t) => {
      const code = (t.sourceRecordId ?? "").split(":")[1] ?? "";
      const noteAt = t.summary.indexOf(": ");
      return {
        code,
        label: t.summary.split(/ — | :/)[0] ?? t.summary,
        note: noteAt >= 0 ? t.summary.slice(noteAt + 2) : null,
        at: new Date(t.occurredAt).toISOString(),
      };
    });

  const who = (eventType: string, actorId: string | null): DeskTimelineItem["who"] => {
    /* Things the CUSTOMER did — the shop said it, whoever typed it in. */
    if (
      eventType === MBOS_EVENT.sampleReceived ||
      eventType === MBOS_EVENT.delivery ||
      eventType === MBOS_EVENT.payment
    ) {
      return "customer";
    }
    if (eventType === MBOS_EVENT.leadCreated) return "system";
    if (!actorId) return "system";
    if (actorId === rec.leadManagerId) return "manager";
    if (actorId === rec.salesmanId) return "desk";
    return "other";
  };

  const created = new Date(extras?.createdAt ?? Date.now());
  const enquiryTitle = [
    isOnlineSource(rec.source) ? "Online enquiry received" : "Lead created",
    rec.source ? ` — ${rec.source}` : "",
    extras?.enquiry ? ` — “${extras.enquiry}”` : "",
  ].join("");
  const stamped: { ms: number; item: DeskTimelineItem }[] = [
    { ms: created.getTime(), item: { at: created.toISOString(), title: enquiryTitle, actor: null, who: "system" } },
  ];
  for (const t of timelineRows) {
    /* The enquiry line above replaces the raw "created" event, which says the same thing less well. */
    if (t.eventType === MBOS_EVENT.leadCreated) continue;
    const at = new Date(t.occurredAt);
    stamped.push({
      ms: at.getTime(),
      item: { at: at.toISOString(), title: t.summary, actor: t.actorName, who: who(t.eventType, t.actorId) },
    });
    if (t.eventType === MBOS_EVENT.prospectRequested) {
      /* The request raises the manager's verification task and notifies them; say so, as the system. */
      stamped.push({
        ms: at.getTime() + 1,
        item: {
          at: new Date(at.getTime() + 1).toISOString(),
          title: "Sales Manager notified — verification task raised",
          actor: null,
          who: "system",
        },
      });
    }
  }
  stamped.sort((a, b) => a.ms - b.ms);

  const distributor = rec.distributorLinks[0] ?? null;
  const lostParts = lostMove ? parseLostNote(lostMove.note) : { label: null, detail: null };

  const v = validation;
  const verdictResult: DeskVerification["result"] | null = !v
    ? null
    : v.verdict === "confirmed"
      ? counts.corrected > 0
        ? "Verified With Corrections"
        : "Verified"
      : v.verdict === "pending"
        ? "Follow-Up Required"
        : "Verification Failed";
  const pair = (rows: [string, string | null][]) =>
    rows.filter(([, val]) => val && val.trim()).map(([label, val]) => ({ label, value: val!.trim() }));

  return {
    id: customerId,
    reference: deskReference(extras?.rank ?? 0),
    name: rec.companyName || rec.name,
    companyName: rec.companyName,
    city: rec.city,
    contactPerson: rec.contactPerson,
    phone: rec.mobile,
    email: extras?.email ?? null,
    address: extras?.address ?? null,
    source: rec.source,
    createdAt: created.toISOString(),
    enquiry: extras?.enquiry ?? null,
    stage: rec.stage,
    salesType: rec.salesType,
    priority: rec.priority,
    phase,
    ladder,
    ladderIndex: key ? ladder.indexOf(key) : -1,
    stageDates,
    ownerName: extras?.ownerName ?? rec.salesmanName,
    managerName: rec.leadManagerName,
    values,
    gstVerified: rec.gstVerified,
    productName: rec.requiredProductName,
    answeredOn,
    marks,
    calls: deskCalls,
    callCount: deskCalls.length,
    requestState,
    requestedAt: extras?.requestedAt ? new Date(extras.requestedAt).toISOString() : null,
    requestedByName: extras?.requestedByName ?? null,
    requestReason: extras?.requestReason ?? null,
    requestNote: extras?.requestNote ?? null,
    managerNote: managerNoteFor(requestState, validation?.note ?? null, timelineRows),
    verification:
      v && verdictResult
        ? {
            verdict: v.verdict,
            result: verdictResult,
            byName: v.byName,
            at: v.at.toISOString(),
            note: v.note,
            attempt: validations.length,
            explained: v.explained,
            visited: v.reached ? v.visited : "Could not be reached",
            genuineInterest: v.genuine,
            objections: pair([
              ["Price", v.price],
              ["Credit terms", v.credit],
              ["Competitor", v.competitor],
            ]),
            readiness: pair([
              ["Ready for a trial", v.readyTrial],
              ["Ready to discuss commercials", v.readyCommercial],
              ["Ready to order", v.readyOrder],
            ]),
            impression: v.impression,
            counts,
            corrections: checks
              .filter((c) => c.verdict === "corrected")
              .map((c) => ({
                label: DESK_FIELDS.find((f) => f.key === FINDING_KEY[c.field])?.label ?? c.field,
                original: c.original,
                corrected: c.corrected ?? "",
                reason: c.reason ?? "",
              })),
          }
        : null,
    verifiedAt: rec.verifiedAt ? new Date(rec.verifiedAt).toISOString() : null,
    nextAction: rec.nextAction
      ? {
          text: rec.nextAction,
          date: rec.nextActionDate,
          ownerName: rec.nextActionOwnerName,
          outcome: rec.nextActionOutcome,
          kind: nextActionKindOf(rec.nextAction),
        }
      : null,
    lost:
      phase === "lost"
        ? {
            reasonCode: rec.lostReason,
            deskLabel: lostParts.label,
            detail: lostParts.detail,
            at: lostMove ? new Date(lostMove.at).toISOString() : null,
            byName: lostMove?.actorName ?? null,
          }
        : null,
    qualification,
    sample: sample
      ? {
          state: sample.state,
          trialOutcome: sample.trialOutcome,
          reasonCode: sample.reasonCode ?? null,
          requestedDate: sample.requestedDate,
          dispatchedAt: sample.dispatchedAt ? new Date(sample.dispatchedAt).toISOString() : null,
          receivedAt: sample.receivedAt ? new Date(sample.receivedAt).toISOString() : null,
          reviewedAt: sample.reviewedAt ? new Date(sample.reviewedAt).toISOString() : null,
          quantityCans: sample.quantityCans,
          productName: sample.productName,
          rejectionReason: sample.rejectionReason,
          feedback: sample.feedback ?? null,
        }
      : null,
    commitment:
      rec.expectedOrderDate || rec.expectedOrderCans || rec.expectedOrderValuePaise
        ? {
            expectedDate: rec.expectedOrderDate,
            cans: rec.expectedOrderCans,
            valuePaise: rec.expectedOrderValuePaise,
            blockerCode: extras?.blocker ?? null,
          }
        : null,
    order: first
      ? {
          orderNo: first.orderNo,
          product: lines?.product ?? null,
          quantityCans: lines?.cans ?? null,
          litres: lines?.litres ?? null,
          amountPaise: Number(first.total),
          status: first.status,
          orderedAt: (day(first.orderedAt) as string) ?? "",
        }
      : null,
    milestones,
    chain:
      rec.salesType === "third_party"
        ? { distributor: distributor?.distributorName ?? null, salesman: distributor?.salesmanName ?? null }
        : null,
    messages,
    timeline: stamped.map((s) => s.item),
  };
}

/** Kept exported for the record page's product-picker default. */
export async function productNameOf(id: string | null): Promise<string | null> {
  if (!id) return null;
  const [p] = await db.select({ name: products.name }).from(products).where(eq(products.id, id)).limit(1);
  return p?.name ?? null;
}

export { answeredCount };
export type { LeadRecord };

/* ------------------------------------------------------------------ the request, for the manager */

export type ProspectRequestNotice = {
  state: RequestState;
  requestedAt: string;
  requestedByName: string | null;
  reasonCode: string | null;
  note: string | null;
};

/**
 * The desk's pending request on a lead, for the sales manager's verification
 * screen — or null where there is none, which is every lead the salesman path
 * raises and every request already answered.
 */
export async function prospectRequestFor(customerId: string): Promise<ProspectRequestNotice | null> {
  const [r] = await db.execute<{
    state: string | null;
    requestedAt: Date | string | null;
    byName: string | null;
    reason: string | null;
    note: string | null;
  }>(sql`
    select customers.prospect_request_state as state,
           customers.prospect_requested_at as "requestedAt",
           u.name as "byName",
           customers.prospect_request_reason as reason,
           customers.prospect_request_note as note
      from customers left join users u on u.id = customers.prospect_requested_by_id
     where customers.id = ${customerId}`);
  if (!r || !isRequestState(r.state) || !r.requestedAt) return null;
  return {
    state: r.state,
    requestedAt: new Date(r.requestedAt).toISOString(),
    requestedByName: r.byName,
    reasonCode: r.reason,
    note: r.note,
  };
}
