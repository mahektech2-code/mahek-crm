import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  customerDistributors,
  customers,
  distributorProfiles,
  mbosLeadValidations,
  leadStageTransitions,
  mbosApprovals,
  mbosDocuments,
  mbosUserTerritories,
  mbosSamples,
  mbosVisits,
  notifications,
  products,
  sampleFeedback,
  users,
} from "@/db/schema";
import { orderCountsSql } from "../order-status";
import { getConfig } from "../config/store";
import { MBOS_EVENT, writeTimelineEvent } from "../timeline";
import type { Hat } from "../access-control";
import {
  gateTo,
  PROSPECT_CONDITIONS,
  type Condition,
  type LeadGateInput,
} from "../engines/lead-gates";
import { directionOf, isOnTheBookAt } from "../engines/lead-ladder";
import {
  stageLabel,
  verificationAnswers,
  verificationVerdict,
  type LeadSalesType,
  type LeadStage,
} from "../lead-labels";

/* ---------------------------------------------------------------------------
 * Reading one lead — the engines' half of it, and the record page's half.
 *
 * `lib/engines/lead-gates.ts` is pure and takes an argument list rather than a
 * `customers` row, which is what lets the handset compile it and answer with no
 * signal. THIS is the file that pays for that: somebody has to go and get the
 * eleven facts the gates read, and there is exactly one such assembler because
 * a second one would answer a slightly different question. The console draws a
 * checklist from a gate verdict, `advanceLeadStage` refuses on one, and the
 * sync handler refuses a move arriving from a phone on the same one — three
 * callers, one reading of the book, or the screen and the save disagree about
 * whether a lead may move and the screen is the half somebody is working from.
 *
 * Reads only. Every write is in `lib/actions/leads.ts`.
 * ------------------------------------------------------------------------- */

/** The lead columns every reader here wants, selected once. */
const LEAD_COLUMNS = {
  id: customers.id,
  name: customers.name,
  companyName: customers.companyName,
  phone: customers.phone,
  city: customers.city,
  area: customers.area,
  kind: customers.kind,
  status: customers.status,
  thirdParty: customers.thirdParty,
  territoryRegion: customers.territoryRegion,
  customerType: customers.customerType,
  contactPerson: customers.contactPerson,
  gstin: customers.gstin,
  ownerId: customers.ownerId,
  salesAmId: customers.salesAmId,
  backOfficeAmId: customers.backOfficeAmId,
  amDecidedAt: customers.amDecidedAt,

  leadSalesType: customers.leadSalesType,
  leadStage: customers.leadStage,
  leadStageSince: customers.leadStageSince,
  leadSource: customers.leadSource,
  leadNotes: customers.leadNotes,
  leadLostReason: customers.leadLostReason,
  leadArchived: customers.leadArchived,
  leadConvertedAt: customers.leadConvertedAt,
  leadEstimatedPotentialPaise: customers.leadEstimatedPotentialPaise,
  leadMonthlyVolumeLitres: customers.leadMonthlyVolumeLitres,
  leadCompetitor: customers.leadCompetitor,
  leadRequiredProductId: customers.leadRequiredProductId,
  leadDecisionMaker: customers.leadDecisionMaker,
  leadCreditDaysWanted: customers.leadCreditDaysWanted,
  leadApplication: customers.leadApplication,
  leadQualification: customers.leadQualification,
  leadSuspectDecidedAt: customers.leadSuspectDecidedAt,
  leadNextAction: customers.leadNextAction,
  leadNextActionDate: customers.leadNextActionDate,
  leadNextActionOwnerId: customers.leadNextActionOwnerId,
  leadNextActionOutcome: customers.leadNextActionOutcome,
  leadManagerId: customers.leadManagerId,
  leadManagerDecidedAt: customers.leadManagerDecidedAt,
  leadVerifiedAt: customers.leadVerifiedAt,
  leadVerifiedById: customers.leadVerifiedById,
  leadExpectedOrderDate: customers.leadExpectedOrderDate,
  leadExpectedOrderValuePaise: customers.leadExpectedOrderValuePaise,
  leadDistributorSalesmanId: customers.leadDistributorSalesmanId,
} as const;

export type LeadRow = {
  [K in keyof typeof LEAD_COLUMNS]: (typeof LEAD_COLUMNS)[K]["_"]["data"];
};

/** The row itself, unadorned. `advanceLeadStage` needs it for the scope check. */
export async function leadRow(customerId: string): Promise<LeadRow | null> {
  const [row] = await db
    .select(LEAD_COLUMNS)
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return (row as LeadRow | undefined) ?? null;
}

/* --------------------------------------------------------- the gate input */

/**
 * Everything `gateTo` reads about this lead, assembled from the book.
 *
 * The counts are DERIVED on every read and stored nowhere. That is deliberate
 * for the visit count in particular — §4 gives a Suspect two visits and a cap
 * of three, and a column holding the number would drift the first time a visit
 * arrived late off a handset or was deleted, which is exactly the population
 * this gate is hardest on. Counting is a `count(*)` on an indexed column and
 * costs nothing beside being right.
 *
 * The ledger counts go through `lib/order-status.ts` rather than
 * `status <> 'cancelled'`: an order sitting at `pending_approval` is the
 * customer having ordered and NOT the business having sold anything, and §18's
 * gate is about the second. Counting the first would walk a lead onto the book
 * on the strength of an order accounts were about to decline.
 */
export async function leadGateInput(customerId: string): Promise<LeadGateInput | null> {
  const lead = await leadRow(customerId);
  if (!lead) return null;

  const [
    visitCount,
    distributorCount,
    prospectReasonRows,
    sample,
    profile,
    approvals,
    ledger,
    agreement,
  ] = await Promise.all([
    /* §4 — how many times somebody has actually stood in this shop. */
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(mbosVisits)
      .where(eq(mbosVisits.customerId, customerId)),

    /* §23 — who invoices this shop. A list, because a shop on a territory
       boundary is served by two distributors and storing one of them makes the
       other unrecordable. */
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(customerDistributors)
      .where(eq(customerDistributors.customerId, customerId)),

    /* §5 — the reason is recorded ON the transition that made it a Prospect,
       so the gate reads that row rather than a column nothing would ever
       clear. A lead moved to Prospect and then back down still has it, which is
       right: the answer was given, and giving it again would be theatre. */
    db
      .select({ id: leadStageTransitions.id })
      .from(leadStageTransitions)
      .where(
        and(
          eq(leadStageTransitions.customerId, customerId),
          eq(leadStageTransitions.toStage, "prospect"),
          sql`${leadStageTransitions.reasonCode} is not null`,
        ),
      )
      .limit(1),

    /* The NEWEST sample, because §15 and §16 are about the trial in progress.
       An older one that was refused is history and must not hold the lead. */
    db
      .select({
        id: mbosSamples.id,
        state: mbosSamples.state,
        trialOutcome: mbosSamples.trialOutcome,
        feedbackId: sampleFeedback.id,
      })
      .from(mbosSamples)
      .leftJoin(sampleFeedback, eq(sampleFeedback.sampleId, mbosSamples.id))
      .where(eq(mbosSamples.customerId, customerId))
      .orderBy(desc(mbosSamples.serverCreatedAt), desc(mbosSamples.id))
      .limit(1),

    /* §11 — the thirty answers, as a row rather than a checklist. The gate
       reads the VALUES, so a condition cannot be ticked without the answer
       that satisfies it. */
    db
      .select()
      .from(distributorProfiles)
      .where(eq(distributorProfiles.customerId, customerId))
      .limit(1),

    /* §12 — the two approval steps. `stepIndex` 0 is the sales manager putting
       them forward, 1 is management appointing them; the subject's position is
       the state of its highest step, which is the same rule every other
       approval chain in MBOS follows. */
    db
      .select({ stepIndex: mbosApprovals.stepIndex, state: mbosApprovals.state })
      .from(mbosApprovals)
      .where(
        and(
          eq(mbosApprovals.type, "distributor_appointment"),
          eq(mbosApprovals.subjectType, "customers"),
          eq(mbosApprovals.subjectId, customerId),
        ),
      ),

    ledgerCounts(customerId),

    /* The signed agreement is a document in the library filed against this
       account, which is what `recordDistributorAgreement` writes. Deriving it
       from the library rather than a boolean on the customer keeps "is it on
       file" answerable by opening the file. */
    db
      .select({ id: mbosDocuments.id })
      .from(mbosDocuments)
      .where(
        and(
          eq(mbosDocuments.customerId, customerId),
          eq(mbosDocuments.category, "agreement"),
          eq(mbosDocuments.active, true),
        ),
      )
      .limit(1),
  ]);

  const approvedAt = (step: number) =>
    approvals.some((a) => a.stepIndex === step && a.state === "approved");

  return {
    salesType: lead.leadSalesType as LeadSalesType | null,
    stage: (lead.leadStage ?? "suspect") as LeadStage,

    customerType: lead.customerType,
    monthlyLitres: lead.leadMonthlyVolumeLitres,
    potentialPaise: lead.leadEstimatedPotentialPaise,
    competitor: lead.leadCompetitor,
    requiredProductId: lead.leadRequiredProductId,
    contactPerson: lead.contactPerson,
    decisionMaker: lead.leadDecisionMaker,
    creditDaysWanted: lead.leadCreditDaysWanted,
    application: lead.leadApplication,
    gstin: lead.gstin,

    nextAction: lead.leadNextAction,
    nextActionDate: lead.leadNextActionDate,
    nextActionOwnerId: lead.leadNextActionOwnerId,

    qualification: lead.leadQualification,

    suspectVisitCount: Number(visitCount[0]?.n ?? 0),
    suspectDecidedAt: lead.leadSuspectDecidedAt,
    prospectReasonRecorded: prospectReasonRows.length > 0,

    verifiedAt: lead.leadVerifiedAt,

    thirdParty: lead.thirdParty,
    distributorCount: Number(distributorCount[0]?.n ?? 0),

    sample: sample[0]
      ? {
          state: sample[0].state,
          trialOutcome: sample[0].trialOutcome,
          feedbackRecorded: sample[0].feedbackId !== null,
        }
      : null,

    distributorProfile: (profile[0] as Record<string, unknown> | undefined) ?? null,
    managementReviewApproved: approvedAt(0),
    distributorApprovalApproved: approvedAt(1),
    commercialTermsAgreed: profile[0]?.commercialTermsAgreedAt != null,
    agreementOnFile: agreement.length > 0,

    countingOrderCount: ledger.countingOrders,
    deliveredOrderCount: ledger.deliveredOrders,
    confirmedPaymentCount: ledger.confirmedPayments,
    expectedOrderDate: lead.leadExpectedOrderDate,
    /*
     * §21 — the initial stock order a distributor committed to IS an order on
     * their account, not a second kind of record. There is no separate flag to
     * read and there should not be one: a boolean somebody ticks beside an
     * order book that disagrees with it is how the two come apart.
     */
    initialStockOrderPlaced: ledger.countingOrders >= 1,
  };
}

/**
 * What the ledger says about this account: orders that count, orders that
 * arrived, and money accounts found in the bank.
 *
 * Three `count(*)`s rather than one join, because a join across orders and
 * receipts multiplies the rows and the number it produces is wrong in a way
 * nobody notices until a lead walks up two rungs it had not earned.
 */
async function ledgerCounts(customerId: string): Promise<{
  countingOrders: number;
  deliveredOrders: number;
  confirmedPayments: number;
}> {
  const [row] = await db.execute<{
    counting_orders: number;
    delivered_orders: number;
    confirmed_payments: number;
  }>(sql`
    select
      (select count(*)::int from orders
        where orders.customer_id = ${customerId}
          and ${orderCountsSql("orders")}) as counting_orders,
      (select count(*)::int from orders
        where orders.customer_id = ${customerId}
          and orders.status = 'dispatched') as delivered_orders,
      (select count(*)::int from payment_receipts
        where payment_receipts.customer_id = ${customerId}
          and payment_receipts.status = 'confirmed') as confirmed_payments
  `);

  return {
    countingOrders: Number(row?.counting_orders ?? 0),
    deliveredOrders: Number(row?.delivered_orders ?? 0),
    confirmedPayments: Number(row?.confirmed_payments ?? 0),
  };
}

/* ---------------------------------------------------------- the history */

export type LeadTransitionRow = {
  id: string;
  fromStage: LeadStage | null;
  toStage: LeadStage;
  salesType: LeadSalesType | null;
  kind: "passed" | "overridden" | "reverted";
  reasonCode: string | null;
  note: string | null;
  overriddenConditions: string[];
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  at: Date;
};

export type LeadTransitionPage = {
  rows: LeadTransitionRow[];
  /** Feed straight back as `cursor`. Null when there is nothing older. */
  nextCursor: string | null;
};

const TRANSITION_PAGE = 20;

/**
 * How this lead got where it is, newest first, a page at a time.
 *
 * KEYSET, not an offset, and the sort carries a TIEBREAKER — `at desc, id
 * desc`. Several transitions of one lead share a second routinely: a manager
 * clearing a backlog moves a lead three rungs in one sitting, and with
 * `order by at desc` alone their order is left to the planner. That is
 * invisible until it is paged, and then it is a row appearing on two pages
 * while another appears on none. The cursor is the pair, compared as a pair.
 */
export async function leadTransitions(
  customerId: string,
  options?: { limit?: number; cursor?: string | null },
): Promise<LeadTransitionPage> {
  const limit = Math.min(Math.max(options?.limit ?? TRANSITION_PAGE, 1), 100);
  const cursor = decodeCursor(options?.cursor);

  const rows = await db
    .select({
      id: leadStageTransitions.id,
      fromStage: leadStageTransitions.fromStage,
      toStage: leadStageTransitions.toStage,
      salesType: leadStageTransitions.salesType,
      kind: leadStageTransitions.kind,
      reasonCode: leadStageTransitions.reasonCode,
      note: leadStageTransitions.note,
      overriddenConditions: leadStageTransitions.overriddenConditions,
      actorId: leadStageTransitions.actorId,
      actorName: users.name,
      actorRole: leadStageTransitions.actorRole,
      at: leadStageTransitions.at,
    })
    .from(leadStageTransitions)
    .leftJoin(users, eq(users.id, leadStageTransitions.actorId))
    .where(
      and(
        eq(leadStageTransitions.customerId, customerId),
        cursor
          ? /* The cursor instant is passed as an ISO STRING, never as a JS
               Date: `postgres` serialises a Date by asking Node to measure it
               as text, and on Node 25 that throws inside the driver where no
               type check sees it. */
            sql`(${leadStageTransitions.at}, ${leadStageTransitions.id}) < (${cursor.at}::timestamptz, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(leadStageTransitions.at), desc(leadStageTransitions.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit) as LeadTransitionRow[];
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor:
      rows.length > limit && last ? `${last.at.toISOString()}|${last.id}` : null,
  };
}

function decodeCursor(raw: string | null | undefined): { at: string; id: string } | null {
  if (!raw) return null;
  const cut = raw.lastIndexOf("|");
  if (cut <= 0) return null;
  const at = raw.slice(0, cut);
  const id = raw.slice(cut + 1);
  /* A cursor that does not parse is treated as no cursor rather than as an
     error: it comes back off a page the reader is holding, and the honest
     failure is to show them the newest page again, not a stack trace. */
  return Number.isNaN(Date.parse(at)) || !id ? null : { at, id };
}

/* ------------------------------------------------- §8 the verification calls */

export type LeadManagerCallRow = {
  id: string;
  managerId: string;
  managerName: string | null;
  calledAt: Date;
  verified: boolean | null;
  answers: Record<string, string>;
  followUpNote: string | null;
};

/**
 * Every verification call on this lead, newest first.
 *
 * Not just the latest one. §8's call can fail — "he never came" — and that
 * raises a follow-up rather than closing anything, so the second call is the
 * interesting one precisely because there was a first. A screen showing only
 * the newest would present a passed verification with no sign that it took two
 * attempts to get there.
 *
 * READ OFF `mbos_lead_validations`, which is where a verification call lives.
 * This branch built `lead_manager_calls` for the same act at the same time main
 * built that one, and two tables meant the web form's calls and the handset's
 * were two histories of one lead — with each screen showing whichever half it
 * happened to read. The twelve answers are reassembled from their columns by
 * `verificationAnswers`, the same mapping the form writes through.
 */
export async function leadManagerCallsFor(customerId: string): Promise<LeadManagerCallRow[]> {
  const rows = await db
    .select()
    .from(mbosLeadValidations)
    .leftJoin(users, eq(users.id, mbosLeadValidations.calledByUserId))
    .where(eq(mbosLeadValidations.customerId, customerId))
    .orderBy(desc(mbosLeadValidations.calledAt), desc(mbosLeadValidations.id));

  return rows.map((r) => {
    const call = r.mbos_lead_validations;
    return {
      id: call.id,
      managerId: call.calledByUserId,
      managerName: r.users?.name ?? null,
      calledAt: call.calledAt,
      verified: verificationVerdict(call.verdict),
      answers: verificationAnswers(call as unknown as Record<string, unknown>),
      /* The reason a verdict was reached is what the follow-up task carried,
         and `notes` is where a call made from the handset puts its prose. Both
         are the same sentence to a reader, so neither is dropped. */
      followUpNote: call.verdictReason ?? call.notes ?? null,
    };
  });
}

/* --------------------------------------------------------- the record page */

export type LeadRecord = {
  lead: LeadRow;
  gate: LeadGateInput;
  /** Names, because an id in a "who owes the next action" line is unreadable. */
  people: {
    owner: string | null;
    salesAm: string | null;
    leadManager: string | null;
    nextActionOwner: string | null;
    verifiedBy: string | null;
  };
  requiredProductName: string | null;
  transitions: LeadTransitionPage;
  managerCalls: LeadManagerCallRow[];
};

/**
 * The whole lead, for the record page — and it is CAPPED like every other
 * fixed-length page in this product.
 *
 * The transitions come back as the first page rather than the lot. A lead
 * worked for a year through a manager clearing backlogs carries a long history,
 * and it is the leads with the most history whose record somebody most needs to
 * read before ringing — which is exactly the page that would otherwise
 * serialise two hundred rows into the DOM and put the qualification answers a
 * hundred screens below the fold.
 */
export async function leadRecord(customerId: string): Promise<LeadRecord | null> {
  const [lead, gate] = await Promise.all([leadRow(customerId), leadGateInput(customerId)]);
  if (!lead || !gate) return null;

  const personIds = [
    lead.ownerId,
    lead.salesAmId,
    lead.leadManagerId,
    lead.leadNextActionOwnerId,
    lead.leadVerifiedById,
  ].filter((v): v is string => Boolean(v));

  const [people, product, transitions, managerCalls] = await Promise.all([
    personIds.length
      ? db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(or(...personIds.map((id) => eq(users.id, id))))
      : Promise.resolve([] as { id: string; name: string }[]),
    lead.leadRequiredProductId
      ? db
          .select({ name: products.name })
          .from(products)
          .where(eq(products.id, lead.leadRequiredProductId))
          .limit(1)
      : Promise.resolve([] as { name: string }[]),
    leadTransitions(customerId),
    leadManagerCallsFor(customerId),
  ]);

  const nameOf = (id: string | null) =>
    id ? (people.find((p) => p.id === id)?.name ?? null) : null;

  return {
    lead,
    gate,
    people: {
      owner: nameOf(lead.ownerId),
      salesAm: nameOf(lead.salesAmId),
      leadManager: nameOf(lead.leadManagerId),
      nextActionOwner: nameOf(lead.leadNextActionOwnerId),
      verifiedBy: nameOf(lead.leadVerifiedById),
    },
    requiredProductName: product[0]?.name ?? null,
    transitions,
    managerCalls,
  };
}

/* ═══════════════════════════════════════════════ moving a lead up its ladder */

/**
 * THE ONE READING OF §28, AND THE ONE WRITE THAT FOLLOWS IT.
 *
 * These two functions are the only thing in this file that is not a read, and
 * they are here rather than in `lib/actions/leads.ts` for a reason worth
 * stating plainly, because it bends the house rule.
 *
 * A stage move arrives from two places: a manager pressing a button in the
 * console, authenticated by a session cookie, and a salesman's handset, whose
 * outbox drains through `ingestSyncBatch` and carries a bearer token instead.
 * Those two are authenticated completely differently and must be, but what they
 * DO is one act — the same gate, the same transition row, the same promotion of
 * `kind` at the same rung, the same lead manager released to the same
 * relationship owner. Written twice, the phone and the console would come apart
 * on exactly the case that matters: the salesman's move promotes an account and
 * the console's does not, or the other way round, and nothing on either screen
 * would say so.
 *
 * `lib/actions/leads.ts` cannot hold it, because a `"use server"` module
 * exports server ACTIONS: a function there taking "who is doing this" as an
 * argument is a URL anybody can post an arbitrary user id to. So the shared
 * half lives here, behind `server-only`, and the two callers each do their own
 * capability check before reaching it — which is where a capability check
 * belongs anyway.
 */

export type LeadMoveKind = "passed" | "overridden" | "reverted";

export type LeadMoveRefusalCode =
  | "not_on_funnel"
  | "same_stage"
  | "off_ladder"
  | "gate_shut"
  | "override_not_offered"
  | "override_not_permitted"
  | "override_reason"
  | "lost_reason"
  | "prospect_reason"
  | "revert_not_permitted";

export type LeadMoveDecision =
  | { ok: true; kind: LeadMoveKind; overriddenConditions: string[] }
  | { ok: false; code: LeadMoveRefusalCode; message: string; missing: Condition[] };

/**
 * May this lead go to that rung — the whole of it, including the parts §28
 * leaves to configuration and the parts the engine deliberately does not know
 * about.
 *
 * The gate engine answers about CONDITIONS and nothing else, which is what
 * keeps it pure and compilable on a handset. Three things sit outside it and
 * are settled here:
 *
 *   - `leads.requireNextAction`. The engine adds §24's condition to every
 *     upward move on a real ladder, unconditionally, because it reads no
 *     configuration. Where a manager has turned the rule off, that one
 *     condition is lifted back out — and only that one, by id, so turning the
 *     setting off never quietly opens a gate it was not aimed at.
 *   - the reason codes. "Say why" is a field on a form rather than a condition,
 *     and the lists are configuration, so they are validated against
 *     `getConfig()` and never against a literal in this file.
 *   - who may pass a shut gate, and who may walk a lead back down. Both are a
 *     manager's; the caller has already asked its own auth layer and passes the
 *     answer in.
 */
export async function evaluateLeadStageMove(input: {
  lead: Pick<LeadRow, "leadStage" | "leadSalesType">;
  gate: LeadGateInput;
  to: LeadStage;
  reasonCode?: string | null;
  override?: { reasonCode: string } | null;
  /** Whether the caller holds `lead.override`. Asked by the caller, not here. */
  canOverride: boolean;
}): Promise<LeadMoveDecision> {
  const { lead, to } = input;
  const from = lead.leadStage as LeadStage | null;
  const salesType = lead.leadSalesType as LeadSalesType | null;
  const config = await getConfig();

  if (!from) {
    return {
      ok: false,
      code: "not_on_funnel",
      message:
        "This account is not on the lead funnel, so there is no rung to move it to. Raise it as a lead first.",
      missing: [],
    };
  }
  if (from === to) {
    return {
      ok: false,
      code: "same_stage",
      message: `This lead is already at ${stageLabel(to)}.`,
      missing: [],
    };
  }

  const direction = directionOf(from, to, salesType);

  /* Walking a lead back DOWN undoes work somebody recorded, which is why the
     ladder engine's own `previousStage` says in as many words that it is for a
     manager reverting one. A reason is demanded with it for the same reason a
     loss demands one: a lead that went backwards and nobody explained teaches
     nothing to whoever picks it up next. */
  if (direction === "down") {
    if (!input.canOverride) {
      return {
        ok: false,
        code: "revert_not_permitted",
        message:
          "Putting a lead back down its ladder is a manager's. Ask yours to do it, and say what changed.",
        missing: [],
      };
    }
    if (!input.reasonCode && !input.override?.reasonCode) {
      return {
        ok: false,
        code: "override_reason",
        message: "Say why this lead is going back down. A step backwards nobody explained teaches nothing.",
        missing: [],
      };
    }
    return { ok: true, kind: "reverted", overriddenConditions: [] };
  }

  if (direction === "off_ladder") {
    return {
      ok: false,
      code: "off_ladder",
      message: `${stageLabel(to)} is not a rung on this lead's ladder. Change the sales type first if that is what you meant.`,
      missing: [],
    };
  }

  /* §26 — a loss is allowed at every rung and always demands a code. The gate
     engine says so too, and it answers `open` for `lost` on purpose: the
     conditions are met by definition, and "say why" is a form field. */
  if (to === "lost") {
    const codes = config["leads.lostReasons"].map((r) => r.code);
    if (!input.reasonCode || !codes.includes(input.reasonCode)) {
      return {
        ok: false,
        code: "lost_reason",
        message:
          "A loss nobody explained teaches nothing. Pick one of the reasons before closing this lead.",
        missing: [],
      };
    }
    return { ok: true, kind: "passed", overriddenConditions: [] };
  }

  /* §5 — the reason a Suspect became a Prospect is recorded ON this move, so
     it is validated here and fed into the gate below. Without it the gate's
     own `prospect_reason` condition refuses, which is the same refusal said
     less usefully. */
  if (to === "prospect") {
    const codes = config["leads.prospectReasons"].map((r) => r.code);
    if (!input.reasonCode || !codes.includes(input.reasonCode)) {
      return {
        ok: false,
        code: "prospect_reason",
        message:
          "Say why this is worth pursuing. A free-text box answers that question with 'good potential' every time, so pick one of the reasons.",
        missing: PROSPECT_CONDITIONS.filter((c) => c.id === "prospect_reason"),
      };
    }
  }

  const verdict = gateTo(
    {
      ...input.gate,
      prospectReasonRecorded: input.gate.prospectReasonRecorded || to === "prospect",
    },
    to,
  );

  /* §24 is the engine's, the SETTING is a manager's, and lifting it is done by
     id rather than by rebuilding the list — a filter on "conditions about the
     next action" would take out anything that ever mentions one. */
  const missing = config["leads.requireNextAction"]
    ? verdict.missing
    : verdict.missing.filter((c) => c.id !== "next_action");

  if (missing.length === 0) {
    return { ok: true, kind: "passed", overriddenConditions: [] };
  }

  if (!input.override) {
    return {
      ok: false,
      code: "gate_shut",
      message: `${stageLabel(to)} is not open yet. ${missing.length} thing${
        missing.length === 1 ? "" : "s"
      } still to do.`,
      missing,
    };
  }

  if (!config["leads.allowManagerOverride"]) {
    return {
      ok: false,
      code: "override_not_offered",
      message:
        "Passing a gate that is shut has been switched off for this deployment. The conditions have to be met.",
      missing,
    };
  }
  if (!input.canOverride) {
    return {
      ok: false,
      code: "override_not_permitted",
      message: "Only a manager can move a lead past a gate that is shut.",
      missing,
    };
  }
  const overrideCodes = config["leads.overrideReasons"].map((r) => r.code);
  if (!overrideCodes.includes(input.override.reasonCode)) {
    return {
      ok: false,
      code: "override_reason",
      message:
        "An override has to say why. The commonest honest answer is that the work was done and recorded afterwards.",
      missing,
    };
  }

  return { ok: true, kind: "overridden", overriddenConditions: missing.map((c) => c.id) };
}

export type LeadMoveActor = {
  userId: string;
  /**
   * The hat that carried it — level AND app, for `actor_role` and `actor_app`.
   * Null is not recorded. The app half became load-bearing when roles stopped
   * being job titles: `associate` on its own no longer says who acted.
   */
  hat: Hat | null;
  sourceApp: "crm" | "mbos";
};

/**
 * Write the move: the transition, the rung, the promotion, and who to tell.
 *
 * ONE TRANSACTION, and the promotion is the reason it has to be. A lead that
 * reached its first order with `kind` still reading `lead` is a row about
 * thirty readers get wrong — the calling queue's prospect cadence, the owner's
 * funnel, sales attribution, the buying cycle — and a lead promoted with no
 * transition row behind it is a `kind` nobody can account for. Half of this is
 * worse than none of it.
 */
export async function applyLeadStageMove(
  actor: LeadMoveActor,
  lead: LeadRow,
  to: LeadStage,
  o: {
    decision: Extract<LeadMoveDecision, { ok: true }>;
    reasonCode?: string | null;
    note?: string | null;
    nextAction?: {
      action: string;
      date: string;
      ownerId: string;
      outcome?: string | null;
    } | null;
    /** The business date, resolved by the caller — engines read no clock. */
    day: string;
  },
): Promise<{ transitionId: string; promoted: boolean }> {
  const salesType = lead.leadSalesType as LeadSalesType | null;
  const from = lead.leadStage as LeadStage | null;
  const transitionId = `lst_${randomUUID().slice(0, 12)}`;

  /*
   * §22 — reaching the promoting rung puts the account on the book.
   *
   * `isOnTheBookAt` answers about the rung and UPWARDS, not the exact rung, so
   * a lead a manager moved straight from qualification to payment is promoted
   * too: it has plainly ordered, and asking only about the exact rung would
   * leave it a lead for ever. It is guarded on `kind` still being `lead`
   * because a repeat customer climbing to the ladder's own `customer` rung
   * must not be "promoted" a second time and have its converted date rewritten.
   */
  const promoted = lead.kind === "lead" && isOnTheBookAt(to, salesType);

  await db.transaction(async (tx) => {
    await tx.insert(leadStageTransitions).values({
      id: transitionId,
      customerId: lead.id,
      fromStage: from,
      toStage: to,
      salesType,
      kind: o.decision.kind,
      reasonCode: o.reasonCode ?? null,
      note: o.note ?? null,
      overriddenConditions: o.decision.overriddenConditions,
      actorId: actor.userId,
      actorRole: actor.hat?.role ?? null,
      actorApp: actor.hat?.app ?? null,
    });

    const set: Partial<typeof customers.$inferInsert> = {
      leadStage: to,
      leadStageSince: o.day,
      /* Any move is work on the lead, and staleness is measured from the last
         thing that happened rather than from the last note somebody typed. */
      leadLastActivityDate: o.day,
      updatedAt: new Date(),
    };

    if (o.nextAction) {
      set.leadNextAction = o.nextAction.action;
      set.leadNextActionDate = o.nextAction.date;
      set.leadNextActionOwnerId = o.nextAction.ownerId;
      set.leadNextActionOutcome = o.nextAction.outcome ?? null;
    }

    /* The column has held free text since before the funnel existed and now
       holds a CODE, which is the whole point of §26: "how many did we lose on
       credit terms this quarter" is a question somebody can ask of a code and
       cannot ask of a grep. Old rows keep their sentences and still read. */
    if (to === "lost" && o.reasonCode) set.leadLostReason = o.reasonCode;

    if (promoted) {
      set.kind = "customer";
      set.leadConvertedAt = new Date();
      /*
       * Scope has to resolve to somebody who can sign in and see the work.
       * `ASSIGNED_TO_SQL` reads a lead through `owner_id` and a customer
       * through `sales_am_id`, so a promotion that left the sales seat empty
       * would take the account off the very person who won it — on the day
       * they won it. It is only ever FILLED here, never moved: reassignment is
       * `customer.reassign`, which is accounts' and admin's for reasons that do
       * not stop applying because a lead was promoted.
       */
      set.salesAmId = lead.salesAmId ?? lead.ownerId;
      /*
       * §22 — the lead manager hands over to the relationship owner.
       *
       * That seat is the person who owed the verification call, the nurture
       * tasks and the files, and every one of those is about WINNING the
       * account. Left in place it would go on generating a lead's worklist
       * against a customer who has been buying for a year. `leadManagerDecidedAt`
       * is left alone: when they were given it is a fact about the past, and
       * the empty seat is what says they no longer hold it.
       */
      set.leadManagerId = null;
    }

    await tx.update(customers).set(set).where(eq(customers.id, lead.id));

    /*
     * §25 — the shared stream, which leads have written nothing to until now.
     *
     * A telecaller opening the record and a salesman standing in the shop read
     * the same timeline, and a lead that climbed six rungs without leaving a
     * mark on it looked like an account nobody had touched. The source record
     * is the transition, so a replayed sync lands on the row that is already
     * there rather than a second sentence about one move.
     */
    await writeTimelineEvent(tx, {
      customerId: lead.id,
      eventType: MBOS_EVENT.leadStage,
      sourceApp: actor.sourceApp,
      sourceRecordId: transitionId,
      occurredAt: new Date(),
      actorUserId: actor.userId,
      summary: stageMoveSummary(from, to, o.decision, promoted),
    });

    if (promoted) {
      /*
       * Both people are told, and the incoming one especially: an account has
       * arrived in their book without them asking, and the first they would
       * otherwise know is a list that grew overnight. One notification each,
       * never one per event, and never one to the person who did it — they are
       * looking at the screen that says so.
       */
      const tell = new Set(
        [lead.leadManagerId, set.salesAmId ?? null].filter(
          (id): id is string => Boolean(id) && id !== actor.userId,
        ),
      );
      for (const userId of tell) {
        await tx.insert(notifications).values({
          id: `ntf_${randomUUID().slice(0, 12)}`,
          userId,
          title: `${lead.name} is now a customer`,
          body:
            userId === lead.leadManagerId
              ? `${lead.name} reached ${stageLabel(to)} and is on the book. The lead manager seat is released — the account is now the relationship owner's.`
              : `${lead.name} reached ${stageLabel(to)} and is on the book. It is in your book from today.`,
          kind: "info",
          href: `/crm/customers/${lead.id}`,
        });
      }
    }

    await tx.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      actorId: actor.userId,
      action: promoted ? "lead.stage.promote" : "lead.stage.move",
      entityType: "customer",
      entityId: lead.id,
      actorRole: actor.hat?.role ?? null,
      actorApp: actor.hat?.app ?? null,
      beforeState: { stage: from, kind: lead.kind, leadManagerId: lead.leadManagerId },
      afterState: {
        stage: to,
        kind: promoted ? "customer" : lead.kind,
        transitionKind: o.decision.kind,
        overriddenConditions: o.decision.overriddenConditions,
        reasonCode: o.reasonCode ?? null,
        source: actor.sourceApp,
      },
    });
  });

  return { transitionId, promoted };
}

/** One line for the shared stream. Short enough to sit in a list on a phone. */
function stageMoveSummary(
  from: LeadStage | null,
  to: LeadStage,
  decision: Extract<LeadMoveDecision, { ok: true }>,
  promoted: boolean,
): string {
  const head =
    decision.kind === "reverted"
      ? `Lead moved back to ${stageLabel(to)}`
      : `Lead moved to ${stageLabel(to)}`;
  const whence = from ? ` from ${stageLabel(from)}` : "";
  /* An override says so on the stream itself. A move that skipped conditions
     and read identically to one that met them is precisely the record §28
     exists to prevent. */
  const how = decision.kind === "overridden" ? " — passed a gate that was shut" : "";
  const book = promoted ? ". They are on the book from today." : "";
  return `${head}${whence}${how}${book}`;
}

/* ------------------------------------------------------ §7 the lead manager */

/**
 * Who covers this lead's region, for the default `assignLeadManager` offers.
 *
 * **No rows for a manager means national**, which is the rule
 * `mbos_manager_territories` already carries and the reason this could ship
 * without changing the meaning of a single existing row. So the answer is
 * whoever names this region, and failing that whoever names no region at all —
 * a permission model that silently narrows what people already hold is one
 * nobody can deploy, and the same is true of a worklist.
 */
export async function leadManagerCandidates(region: string | null): Promise<
  { id: string; name: string; national: boolean }[]
> {
  const [managers, territories] = await Promise.all([
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.role, "manager"), eq(users.active, true))),
    db
      .select({ userId: mbosUserTerritories.userId, region: mbosUserTerritories.region })
      .from(mbosUserTerritories),
  ]);

  const covered = new Map<string, string[]>();
  for (const t of territories) {
    covered.set(t.userId, [...(covered.get(t.userId) ?? []), t.region]);
  }

  const out: { id: string; name: string; national: boolean }[] = [];
  for (const m of managers) {
    const mine = covered.get(m.id);
    /* No rows at all is national. Rows that are all somewhere else is a
       manager who covers a different part of the country, and offering them
       here would make the default meaningless. */
    if (!mine) out.push({ id: m.id, name: m.name, national: true });
    else if (region && mine.includes(region)) out.push({ id: m.id, name: m.name, national: false });
  }
  /* Whoever names this region sorts above whoever covers everywhere: a
     regional answer is the better default and the picker is read top-down. */
  return out.sort((a, b) => Number(a.national) - Number(b.national));
}
