import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, leadStageTransitions, products, users } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { assertLeadInScope } from "@/lib/services/lead-scope";
import {
  buildReviewRows,
  confirmBlockers,
  REVIEW_EDIT_ACTION,
  reviewTally,
  unmetAt,
  type FieldChange,
  type ReviewRow,
} from "@/lib/qualification-review";
import { qualificationAccess } from "@/lib/lead-qualification-access";
import { PROSPECT_REVIEW_AUDIT, prospectReviewStateOf } from "@/lib/prospect-review";
import { gateTo } from "@/lib/engines/lead-gates";
import { requestOf } from "./lead-prospect-request-service";
import { leadGateInput, leadRow } from "./lead-service";
import { canVerifyLeadById, creatorFactsFor, qualificationCollectorRefusal } from "./lead-verifier";
import { answersMissing, canDecideProspect } from "./prospect-verifier";
import { assertDesignatedQualificationApprover, designatedQualificationApprover } from "./qualification-approver";

/* ---------------------------------------------------------------------------
 * THE QUALIFICATION REVIEW'S READ MODEL.
 *
 * Reads the answers the Calling Desk, the Sales Manager pipeline and the
 * Qualify screen already saved and lays them out in the order the lead met
 * them. It writes nothing and defines no question of its own: which questions
 * are ANSWERED is the gate's verdict (`gateTo`), which are required is the
 * gate's, and who may decide is `assertDesignatedQualificationApprover` — the
 * function the decision itself asks, so a button drawn here and a refusal given
 * there cannot disagree.
 *
 * Everyone who can see the lead can read this — the owner above all, who has to
 * see the decision and the reason.
 * ------------------------------------------------------------------------- */

export type ReviewState =
  | "not_open" // the lead is not at Qualification (yet, or any more)
  | "in_progress" // Qualification is open and not yet complete
  | "pending" // complete, waiting for the approver
  | "sent_back" // the approver rejected it; the Salesman owes a correction
  | "verified"
  | "prospect_pending" // a Prospect submitted for Qualification, with its designated verifier
  | "prospect_returned"; // the verifier returned it; its owner owes a correction

export type HistoryEntry = {
  at: string;
  byName: string;
  kind: "edit" | "verified" | "incomplete" | "clarification" | "resubmitted";
  summary: string;
  changes: FieldChange[];
  note: string | null;
};

export type QualificationReviewModel = {
  customerId: string;
  name: string;
  stage: string;
  salesType: string | null;
  state: ReviewState;
  /** Which decision this is: the Prospect review (before Qualification opens) or the Qualification review. */
  kind: "prospect" | "qualification" | "none";
  people: {
    creatorName: string | null;
    ownerName: string | null;
    leadManagerName: string | null;
    verifierName: string | null;
  };
  rows: ReviewRow[];
  tally: ReturnType<typeof reviewTally>;
  /** What the gate still names — the reason Confirm is held. Empty = may confirm. */
  blockers: string[];
  decision: {
    verdict: "verified" | "incomplete" | "clarification";
    note: string | null;
    at: string | null;
    byName: string | null;
  } | null;
  viewer: {
    /** The designated approver, with Qualification open. */
    canDecide: boolean;
    /** Said in words when canDecide is false and the viewer might expect it. */
    why: string | null;
    isOwner: boolean;
    /** The owner may send a returned Prospect back for review. */
    canResubmit: boolean;
  };
  products: { id: string; name: string }[];
  history: HistoryEntry[];
};

async function nameMap(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (!unique.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

/**
 * The review for one lead, or null where it is not on MahekOne or the viewer
 * may not see it. The two are deliberately one answer.
 */
export async function loadQualificationReview(
  customerId: string,
  viewer: { id: string; role: string },
): Promise<QualificationReviewModel | null> {
  const lead = await leadRow(customerId);
  if (!lead || !lead.leadStage) return null;
  try {
    await assertLeadInScope(customerId, lead);
  } catch {
    return null;
  }

  const config = await getConfig();
  const gate = await leadGateInput(customerId);

  const [extra] = await db
    .select({ address: customers.address, email: customers.email })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  const [reasonRow] = await db
    .select({ code: leadStageTransitions.reasonCode })
    .from(leadStageTransitions)
    .where(and(eq(leadStageTransitions.customerId, customerId), eq(leadStageTransitions.toStage, "prospect")))
    .orderBy(desc(leadStageTransitions.at))
    .limit(1);
  const prospectReason = reasonRow?.code
    ? ((config["leads.prospectReasons"] ?? []).find((r) => r.code === reasonRow.code)?.label ?? reasonRow.code)
    : null;

  const productName = lead.leadRequiredProductId
    ? (await db.select({ name: products.name }).from(products).where(eq(products.id, lead.leadRequiredProductId)).limit(1))[0]?.name ?? null
    : null;

  /* WHICH DECISION THIS IS. Before Qualification opens, the lead is with its
     designated VERIFIER for the Prospect review; once it is open it is the
     Qualification review. The same screen, the same answers, two decisions. */
  const access = qualificationAccess(lead.leadStage);
  const req = await requestOf(customerId);
  const pstate = prospectReviewStateOf({
    stage: lead.leadStage,
    verifiedAt: lead.leadVerifiedAt,
    nextAction: lead.leadNextAction,
    requestState: req?.state ?? null,
  });
  const kind: QualificationReviewModel["kind"] = access.writable
    ? "qualification"
    : pstate === "pending" || pstate === "returned"
      ? "prospect"
      : "none";

  /* Who may decide — the same function the decision itself asks. */
  let canDecide = false;
  let why: string | null = null;
  if (kind === "prospect") {
    if (pstate === "pending" && (await canDecideProspect(viewer, customerId))) canDecide = true;
  } else if (!access.writable) {
    why = access.reason;
  } else if (await canVerifyLeadById(viewer, customerId)) {
    const check = await assertDesignatedQualificationApprover(customerId, viewer.id);
    canDecide = check.ok;
    why = check.ok ? null : check.message;
  }

  /* Where the CRM keeps Qualification answers for the Salesman who collects, the
     Sales Manager is refused them — said in the CRM's own words, never worked round. */
  const collectorOnlyReason = canDecide
    ? kind === "prospect"
      ? access.reason
      : await qualificationCollectorRefusal(viewer, {
        id: customerId,
        ownerId: lead.ownerId,
        salesManagerId: lead.salesManagerId,
        leadStage: lead.leadStage,
      })
    : null;

  const unmetProspect = gate ? unmetAt(gate, "prospect") : new Set<string>();
  const unmetQualification = gate ? unmetAt(gate, "sample_trial") : new Set<string>();

  const allRows = buildReviewRows(
    {
      salesType: lead.leadSalesType as never,
      customerType: lead.customerType,
      decisionMaker: lead.leadDecisionMaker,
      buyer: lead.leadBuyer,
      gstin: lead.gstin,
      gstVerified: Boolean(lead.gstVerified),
      monthlyLitres: lead.leadMonthlyVolumeLitres as number | null,
      creditDaysWanted: lead.leadCreditDaysWanted,
      requiredProductId: lead.leadRequiredProductId,
      requiredProductName: productName,
      competitor: lead.leadCompetitor,
      application: lead.leadApplication,
      contactPerson: lead.contactPerson,
      address: extra?.address ?? null,
      email: extra?.email ?? null,
      nextAction: lead.leadNextAction,
      nextActionDate: lead.leadNextActionDate,
      prospectReason,
      qualification: lead.leadQualification as Record<string, boolean | string> | null,
      unmetProspect,
      unmetQualification,
    },
    { editable: canDecide, collectorOnlyReason },
  );

  /* BEFORE QUALIFICATION OPENS the review is of the Suspect and Prospect answers
     ONLY. The Qualification questions are not asked yet, so they are neither
     shown nor counted as missing. */
  const rows = kind === "prospect" ? allRows.filter((r) => r.section !== "qualification") : allRows;

  /* What holds Confirm: the Prospect gate's own words before Qualification opens,
     the Qualification gate's after. */
  const blockers = !gate
    ? []
    : kind === "prospect"
      ? answersMissing(gateTo({ ...gate, prospectReasonRecorded: true }, "prospect").missing).map((c) => c.says)
      : confirmBlockers(gate);

  /* History: approver edits, verdicts and resubmissions, newest first. */
  const audits = await db
    .select({
      at: auditLog.at,
      actorId: auditLog.actorId,
      action: auditLog.action,
      after: auditLog.afterState,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "customer"),
        eq(auditLog.entityId, customerId),
        inArray(auditLog.action, [
          REVIEW_EDIT_ACTION,
          "lead.qualificationReview",
          "lead.qualificationReview.resubmit",
          PROSPECT_REVIEW_AUDIT.confirm,
          PROSPECT_REVIEW_AUDIT.returned,
          PROSPECT_REVIEW_AUDIT.resubmit,
          PROSPECT_REVIEW_AUDIT.requestReturned,
        ]),
      ),
    )
    .orderBy(desc(auditLog.at))
    .limit(60);

  const creator = await creatorFactsFor(customerId);
  const approver = await designatedQualificationApprover(customerId);
  const names = await nameMap([
    lead.ownerId,
    lead.leadManagerId,
    lead.leadQualificationReviewedById,
    creator.actorUserId,
    ...audits.map((a) => a.actorId),
  ]);

  const history: HistoryEntry[] = audits.map((a) => {
    const byName = (a.actorId && names.get(a.actorId)) || "Somebody";
    if (a.action === REVIEW_EDIT_ACTION) {
      const changes = ((a.after as { changes?: FieldChange[] } | null)?.changes ?? []) as FieldChange[];
      return {
        at: a.at.toISOString(),
        byName,
        kind: "edit",
        summary: `${byName} changed ${changes.length} answer${changes.length === 1 ? "" : "s"}`,
        changes,
        note: null,
      };
    }
    if (a.action === PROSPECT_REVIEW_AUDIT.confirm) {
      return { at: a.at.toISOString(), byName, kind: "verified", summary: `${byName} confirmed the Suspect and Prospect answers`, changes: [], note: null };
    }
    if (a.action === PROSPECT_REVIEW_AUDIT.returned || a.action === PROSPECT_REVIEW_AUDIT.requestReturned) {
      const note = ((a.after as { note?: string } | null)?.note ?? null) || null;
      return { at: a.at.toISOString(), byName, kind: "incomplete", summary: `${byName} returned it for correction`, changes: [], note };
    }
    if (a.action === PROSPECT_REVIEW_AUDIT.resubmit) {
      return { at: a.at.toISOString(), byName, kind: "resubmitted", summary: `${byName} resubmitted it for review`, changes: [], note: null };
    }
    if (a.action === "lead.qualificationReview.resubmit") {
      return { at: a.at.toISOString(), byName, kind: "resubmitted", summary: `${byName} sent it back for review`, changes: [], note: null };
    }
    const after = (a.after ?? {}) as { leadQualificationReview?: string; leadQualificationReviewNote?: string | null };
    const verdict = (after.leadQualificationReview ?? "verified") as "verified" | "incomplete" | "clarification";
    return {
      at: a.at.toISOString(),
      byName,
      kind: verdict,
      summary:
        verdict === "verified"
          ? `${byName} confirmed the qualification`
          : verdict === "incomplete"
            ? `${byName} rejected it as incomplete`
            : `${byName} rejected it asking for clarification`,
      changes: [],
      note: after.leadQualificationReviewNote ?? null,
    };
  });

  const verdict = lead.leadQualificationReview;
  const state: ReviewState = kind === "prospect"
    ? pstate === "returned"
      ? "prospect_returned"
      : "prospect_pending"
    : !access.writable
    ? "not_open"
    : verdict === "verified"
      ? "verified"
      : verdict === "incomplete" || verdict === "clarification"
        ? "sent_back"
        : blockers.length
          ? "in_progress"
          : "pending";

  const productList = canDecide
    ? await db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(eq(products.active, true))
        .orderBy(products.name)
        .limit(600)
    : [];

  const approverId = approver?.id ?? null;
  const verifierNames = approverId && !names.has(approverId) ? await nameMap([approverId]) : names;

  return {
    customerId,
    name: lead.name,
    stage: lead.leadStage,
    salesType: lead.leadSalesType,
    state,
    kind,
    people: {
      creatorName: creator.actorUserId ? (names.get(creator.actorUserId) ?? null) : null,
      ownerName: lead.ownerId ? (names.get(lead.ownerId) ?? null) : null,
      leadManagerName: lead.leadManagerId ? (names.get(lead.leadManagerId) ?? null) : null,
      verifierName: approver?.name ?? (approverId ? (verifierNames.get(approverId) ?? null) : null),
    },
    rows,
    tally: reviewTally(rows),
    blockers,
    decision: kind === "prospect"
      ? (() => {
          if (pstate !== "returned") return null;
          const h = history.find((x) => x.kind === "incomplete");
          return h ? { verdict: "incomplete" as const, note: h.note, at: h.at, byName: h.byName } : null;
        })()
      : verdict
      ? {
          verdict,
          note: lead.leadQualificationReviewNote,
          at: iso(lead.leadQualificationReviewedAt),
          byName: lead.leadQualificationReviewedById ? (names.get(lead.leadQualificationReviewedById) ?? null) : null,
        }
      : null,
    viewer: {
      canDecide,
      why,
      isOwner: lead.ownerId === viewer.id,
      canResubmit: pstate === "returned" && lead.leadStage === "prospect" && lead.ownerId === viewer.id,
    },
    products: productList,
    history,
  };
}
