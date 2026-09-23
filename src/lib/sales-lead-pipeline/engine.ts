import type { Lead, Stage } from "./types";
import { DIRECT_LADDER, QUALIFICATION_CONDITIONS, STAGE_LABEL } from "./reference";

/**
 * Pure read functions for the Sales Manager Lead Pipeline mock. No I/O, no
 * clock reads at call time — `today` is always passed in, the same
 * discipline the real engines in `lib/engines/` follow, so this stays
 * testable and so nothing here reads the clock during a render.
 */

const paise = (p?: number) => (p ? "₹" + Math.round(p / 100).toLocaleString("en-IN") : "");

export type FindingField = { key: string; label: string; get: (l: Lead) => string | null };

/**
 * The eight facts a Salesman collects in the field — reviewed, never
 * re-collected, at both Prospect Conversion and Manager Verification. One
 * definition so the two modals can never disagree about what "Competitor"
 * or "Contact Person" means.
 */
export const SALESMAN_FINDING_FIELDS: FindingField[] = [
  { key: "monthlyLitres", label: "Monthly Requirement", get: (l) => (l.monthlyLitres ? l.monthlyLitres.toLocaleString("en-IN") + " Litres" : null) },
  { key: "potentialPaise", label: "Monthly Potential", get: (l) => (l.potentialPaise ? paise(l.potentialPaise) : null) },
  { key: "product", label: "Product", get: (l) => l.product ?? null },
  { key: "competitor", label: "Competitor", get: (l) => l.competitor ?? null },
  { key: "contact", label: "Contact Person", get: (l) => l.contact ?? null },
  { key: "decisionMaker", label: "Decision Maker", get: (l) => l.decisionMaker ?? null },
  { key: "buyer", label: "Buyer", get: (l) => l.buyer ?? null },
  {
    key: "trialInterest",
    label: "Trial Interest",
    get: (l) => {
      const hit = l.timeline.find((t) => /trial/i.test(t.meta ?? "") || /trial/i.test(t.title));
      return hit ? hit.meta || hit.title : null;
    },
  },
];

/** The 6 of the 8 findings that Prospect Conversion asks about (Trial Interest and Buyer are not conversion fields). */
export const CONVERSION_FIELD_KEYS = ["monthlyLitres", "potentialPaise", "product", "competitor", "contact", "decisionMaker"];

export function salesmanNotesFor(l: Lead): string | null {
  const entries = l.timeline.filter((t) => t.kind === "salesman" && t.meta);
  return entries.length ? entries[entries.length - 1].meta! : null;
}

export function isActive(l: Lead): boolean {
  return !l.lost && l.stage !== "active_distributor";
}

export function daysUntil(dateIso: string | undefined, today: Date): number | null {
  if (!dateIso) return null;
  const target = new Date(dateIso + "T00:00:00");
  const diffMs = target.getTime() - new Date(today.toDateString()).getTime();
  return Math.round(diffMs / 86400000);
}

export function isOverdue(l: Lead, today: Date): boolean {
  if (!l.nextActionDate || l.lost) return false;
  const d = daysUntil(l.nextActionDate, today);
  return d !== null && d < 0;
}

export function isDueToday(l: Lead, today: Date): boolean {
  if (!l.nextActionDate || l.lost) return false;
  return daysUntil(l.nextActionDate, today) === 0;
}

export function personalBookCounts(leads: Lead[]) {
  const active = leads.filter(isActive);
  return {
    mine: active.length,
    suspects: active.filter((l) => l.stage === "suspect").length,
    prospects: active.filter((l) => l.stage === "prospect").length,
    inSample: active.filter((l) => ["sample_trial", "sample_received", "sample_review"].includes(l.stage)).length,
    negotiations: active.filter((l) => l.stage === "negotiation").length,
    expectedOrders: active.filter(
      (l) => (l.commitment && !l.order) || ["commercial_discussion", "distributor_approval"].includes(l.stage),
    ).length,
    lost: leads.filter((l) => l.lost).length,
  };
}

/** The Sales-Manager-only "verification & nurturing" strip. */
export function managerKpis(leads: Lead[], today: Date) {
  const active = leads.filter(isActive);
  return {
    pendingVerification: active.filter((l) => l.stage === "prospect" && !l.verification.done).length,
    verifiedProspects: active.filter((l) => l.verification.done).length,
    verificationFailed: leads.filter((l) => l.verification.result === "verification_failed").length,
    sampleReviewsPending: active.filter((l) => l.sample && l.sample.state === "received" && !l.sample.feedbackRecorded).length,
    negotiationsPending: active.filter((l) => l.stage === "negotiation").length,
    awaitingActualOrder: active.filter((l) => l.commitment && !l.order).length,
    // Matches the prototype's own window: `daysUntil(expectedOrderDate) >= 0 && <= 7`.
    expectedThisWeek: active.filter((l) => {
      if (!l.commitment || l.order) return false;
      const d = daysUntil(l.commitment.expectedOrderDate, today);
      return d !== null && d >= 0 && d <= 7;
    }).length,
  };
}

export function funnelCounts(leads: Lead[]) {
  const active = leads.filter(isActive);
  const ladder = DIRECT_LADDER.filter((s) => !["delivery", "payment"].includes(s));
  return ladder.map((stage) => ({
    stage,
    label: STAGE_LABEL[stage],
    count: active.filter((l) => l.stage === stage).length,
  }));
}

export function qualificationStatus(l: Lead) {
  const done = QUALIFICATION_CONDITIONS.filter((c) => l.qualChecks[c.id]).length;
  const total = QUALIFICATION_CONDITIONS.length;
  const missing = QUALIFICATION_CONDITIONS.filter((c) => !l.qualChecks[c.id]);
  return { done, total, allDone: done === total, missing };
}

/**
 * What the record's gate action button offers, from the Sales Manager's own
 * side only — mirrors the prototype's `gateAction()`, narrowed to the
 * Sales-Manager actions this implementation covers. Management-only steps
 * (approving a distributor appointment) are named but not offered here.
 */
export type GateAction =
  | { kind: "visit"; label: string }
  | { kind: "verify"; label: string }
  | { kind: "awaitingVerification"; label: string }
  | { kind: "qualify"; label: string }
  | { kind: "requestSample"; label: string; disabled: boolean; note?: string }
  | { kind: "markDispatched" | "markReceived"; label: string }
  | { kind: "sampleReview"; label: string }
  | { kind: "moveToNegotiation"; label: string; disabled: boolean; note?: string }
  | { kind: "askOrder"; label: string }
  | { kind: "confirmOrder"; label: string; note: string }
  | { kind: "awaitingManagement"; label: string }
  | { kind: "confirmAgreement"; label: string }
  | { kind: "recordInitialStock"; label: string }
  | { kind: "closed"; label: string }
  | { kind: "none" };

export function gateActionFor(l: Lead): GateAction {
  if (l.lost) return { kind: "closed", label: "No further action — this lead is closed." };
  switch (l.stage) {
    case "suspect":
      return { kind: "visit", label: "Log the next suspect visit, or open the conversion decision above." };
    case "prospect":
      if (!l.verification.done) return { kind: "verify", label: "Verify prospect" };
      return { kind: "qualify", label: "Open qualification checklist" };
    case "qualification": {
      const q = qualificationStatus(l);
      return {
        kind: "requestSample",
        label: "Proceed to Sample / Trial",
        disabled: !q.allDone,
        note: q.allDone
          ? undefined
          : `${q.done} of ${q.total} conditions met. Still pending: ${q.missing.map((c) => c.says).join("; ")}.`,
      };
    }
    case "sample_trial":
      return {
        kind: l.sample?.state === "dispatched" ? "markReceived" : "markDispatched",
        label: l.sample?.state === "dispatched" ? "Mark received" : "Mark sample dispatched",
      };
    case "sample_received":
      return { kind: "sampleReview", label: "Record trial review" };
    case "sample_review":
      return {
        kind: "moveToNegotiation",
        label: "Move to Negotiation",
        disabled: l.sample?.trialOutcome !== "approved",
        note: l.sample?.trialOutcome !== "approved" ? "They have to be happy with the trial before negotiation opens." : undefined,
      };
    case "negotiation":
      if (!l.commitment) return { kind: "askOrder", label: "Record Commitment / Expected Order" };
      if (!l.order)
        return {
          kind: "confirmOrder",
          label: "Confirm Actual Order",
          note: `Commitment on file — ${l.commitment.quantity}, expected ${l.commitment.expectedOrderDate}. This is a forecast, not a sale.`,
        };
      return { kind: "none" };
    case "management_review":
    case "commercial_discussion":
    case "distributor_approval":
      // All three sit on the same "Management reviews" step of the two-step
      // approval stepper (see `ApprovalTab`'s own `current` condition) — the
      // Sales Manager has nothing further to action until Management moves
      // it on, which is deliberately out of scope for this app.
      return { kind: "awaitingManagement", label: "Waiting on management to review the distributor profile." };
    case "distributor_agreement":
      return { kind: "confirmAgreement", label: "Confirm agreement signed" };
    case "initial_stock_order":
      return { kind: "recordInitialStock", label: "Record initial stock order" };
    case "customer":
    case "active_distributor":
      return { kind: "none" };
    default:
      return { kind: "none" };
  }
}

export function ladderProgressIndex(l: Lead, ladder: Stage[]): number {
  return ladder.indexOf(l.stage);
}
