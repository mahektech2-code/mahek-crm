/**
 * The three ladders, and nothing else.
 *
 * Mahek sells three ways and the specification gives each its own rungs: a
 * direct customer is worked towards a first order, a distributor is worked
 * towards an appointment, and a third-party shop is worked towards an order
 * somebody else invoices. Folding them into one list would put "Distributor
 * Agreement" on a paint shop's funnel and "Sample review" on a distributor's,
 * and every screen would then need its own idea of which rungs to hide.
 *
 * Pure, like every engine here: it takes what it needs and performs no I/O.
 * That is what lets the handset compile the same file and tell a salesman with
 * no signal which rung he is on.
 *
 * WHAT THIS FILE DOES NOT DECIDE is whether a lead may MOVE — that is
 * `lead-gates.ts`, and the split is deliberate. This answers "what comes next";
 * that answers "may we". One is the map and the other is the toll.
 */

import type { LeadSalesType, LeadStage } from "./lead-labels";

/**
 * The ladder a lead raised before any of this existed is on.
 *
 * It is the six rungs this product shipped with, kept whole and kept first, and
 * it is what `leadSalesType === null` means. Nothing backfills a sales type, so
 * every lead in the book on the day the funnel landed carried on climbing
 * exactly what it was climbing — which is the only reason this could ship
 * without a migration that moves rows.
 */
export const LEGACY_LADDER: readonly LeadStage[] = [
  "new",
  "contacted",
  "qualified",
  "negotiation",
  "won",
] as const;

/**
 * §3A — Mahek to the shop.
 *
 * `sample_received` is its own rung rather than a date on the sample, because
 * the specification chases it separately: a sample dispatched and not received
 * is a courier problem, and one received and not reviewed is a customer
 * problem. They are different calls to different people.
 */
export const DIRECT_LADDER: readonly LeadStage[] = [
  "suspect",
  "prospect",
  "qualification",
  "sample_trial",
  "sample_received",
  "sample_review",
  "negotiation",
  "first_order",
  "delivery",
  "payment",
  "second_order",
  "customer",
] as const;

/**
 * §3C — Mahek to a distributor to the shop.
 *
 * The same climb as a direct customer minus `sample_received`, which §3C drops:
 * the sample goes through the distributor, so the date we could stand behind is
 * when it was reviewed rather than when it landed. What makes it a different
 * ladder at all is not the rungs — it is that the gates ask who invoices the
 * shop, and `lead-gates.ts` is where that is asked.
 */
export const THIRD_PARTY_LADDER: readonly LeadStage[] = [
  "suspect",
  "prospect",
  "qualification",
  "sample_trial",
  "sample_review",
  "negotiation",
  "first_order",
  "delivery",
  "payment",
  "second_order",
  "customer",
] as const;

/**
 * §3B — appointing a distributor.
 *
 * No sample rungs at all, and that is the point of it being a separate ladder:
 * the objective is a signed distributor with a territory and a stock
 * commitment, not a shop that liked the thinner. What replaces the trial is two
 * approvals, which is why `management_review` and `distributor_approval` are
 * both here — a sales manager may recommend one and may not appoint one.
 */
export const DISTRIBUTOR_LADDER: readonly LeadStage[] = [
  "suspect",
  "prospect",
  "qualification",
  "management_review",
  "commercial_discussion",
  "distributor_approval",
  "distributor_agreement",
  "initial_stock_order",
  "active_distributor",
] as const;

/** Terminal on every ladder. `lost` is reachable from any rung; see §26. */
export const TERMINAL_STAGES: readonly LeadStage[] = [
  "won",
  "lost",
  "customer",
  "active_distributor",
] as const;

/** The rungs a lead climbs, given what kind of sale it is. */
export function ladderFor(salesType: LeadSalesType | null | undefined): readonly LeadStage[] {
  switch (salesType) {
    case "direct":
      return DIRECT_LADDER;
    case "third_party":
      return THIRD_PARTY_LADDER;
    case "distributor":
      return DISTRIBUTOR_LADDER;
    default:
      return LEGACY_LADDER;
  }
}

/** Where on its own ladder a lead is standing, or -1 if it is off it. */
export function rungOf(stage: LeadStage, salesType: LeadSalesType | null | undefined): number {
  return ladderFor(salesType).indexOf(stage);
}

/**
 * The one rung above this one, or null at the top.
 *
 * A lead on a stage that is not on its own ladder — which happens for exactly
 * as long as it takes somebody to change a lead's sales type — is answered with
 * the FOOT of the new ladder rather than null. Answering null would leave the
 * record with no button at all and no way to say why.
 */
export function nextStage(
  stage: LeadStage,
  salesType: LeadSalesType | null | undefined,
): LeadStage | null {
  const ladder = ladderFor(salesType);
  const i = ladder.indexOf(stage);
  if (i === -1) return ladder[0] ?? null;
  return ladder[i + 1] ?? null;
}

/** The rung below, or null at the foot. Used only by a manager reverting one. */
export function previousStage(
  stage: LeadStage,
  salesType: LeadSalesType | null | undefined,
): LeadStage | null {
  const ladder = ladderFor(salesType);
  const i = ladder.indexOf(stage);
  if (i <= 0) return null;
  return ladder[i - 1] ?? null;
}

export function isTerminal(stage: LeadStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/**
 * Whether a move is up, down, out, or nowhere.
 *
 * `lost` is `out` from anywhere, which is what §26 asks for — a lead can be
 * lost at any rung, and it is never a step down the ladder it was on.
 */
export type MoveDirection = "up" | "down" | "out" | "same" | "off_ladder";

export function directionOf(
  from: LeadStage,
  to: LeadStage,
  salesType: LeadSalesType | null | undefined,
): MoveDirection {
  if (from === to) return "same";
  if (to === "lost") return "out";
  const ladder = ladderFor(salesType);
  const a = ladder.indexOf(from);
  const b = ladder.indexOf(to);
  if (a === -1 || b === -1) return "off_ladder";
  return b > a ? "up" : "down";
}

/**
 * The four bands the console funnel draws, and the owner's cohort reads.
 *
 * THIS IS WHY THE NEW RUNGS DID NOT MOVE A KPI. `leadsCreatedIn` and the
 * conversion cohort count leads by band, not by rung, and the funnel bar has
 * always shown four. Adding seventeen enum values without this would have
 * dropped every lead on a new rung out of the bands entirely — a pipeline that
 * silently shrinks as the team works it, which is the worst possible direction
 * for that particular bug.
 *
 * `won` and the two ladder ends are NOT a band: a funnel counts what is still
 * in it, and folding the closed deals in is how a funnel comes to include the
 * business it already did.
 */
export type FunnelBand = "new" | "contacted" | "qualified" | "negotiation" | null;

export function bandOf(stage: LeadStage): FunnelBand {
  switch (stage) {
    case "new":
    case "suspect":
      return "new";
    case "contacted":
    case "prospect":
      return "contacted";
    case "qualified":
    case "qualification":
    case "sample_trial":
    case "sample_received":
    case "sample_review":
    case "management_review":
      return "qualified";
    case "negotiation":
    case "commercial_discussion":
    case "distributor_approval":
    case "distributor_agreement":
    case "first_order":
    case "delivery":
    case "payment":
    case "second_order":
    case "initial_stock_order":
      return "negotiation";
    /* won, lost, customer, active_distributor — out of the funnel by design */
    default:
      return null;
  }
}

/**
 * The rung at which the account starts being invoiced.
 *
 * MahekOne's own word for a customer is an account that has ORDERED, and about
 * thirty places read `customers.kind` on exactly that understanding — the
 * calling queue's prospect cadence, the owner's funnel, sales attribution, the
 * buying cycle. The specification's ladder says `Customer` at the second order
 * (§22), and honouring that literally would leave an account with one order,
 * one bill and one payment sitting at `kind = 'lead'`, which every one of those
 * thirty readers would get wrong.
 *
 * So the two words are separated rather than reconciled: `kind` flips here, at
 * the first order, because that is what the word means everywhere else in the
 * product — and the ladder carries on to its own `second_order` and `customer`
 * rungs, which are the funnel's statement about the relationship rather than
 * the ledger's statement about the account.
 */
export function promotesToCustomerAt(
  salesType: LeadSalesType | null | undefined,
): LeadStage {
  return salesType === "distributor" ? "distributor_approval" : "first_order";
}

/**
 * Whether reaching this rung means the account is now on the book.
 *
 * True from the promoting rung UPWARDS, not just on it — a lead moved straight
 * from qualification to payment by a manager clearing a backlog has still
 * plainly ordered, and asking only about the exact rung would leave it a lead.
 */
export function isOnTheBookAt(
  stage: LeadStage,
  salesType: LeadSalesType | null | undefined,
): boolean {
  if (stage === "lost") return false;
  if (stage === "won" || stage === "customer" || stage === "active_distributor") return true;
  const ladder = ladderFor(salesType);
  const at = ladder.indexOf(promotesToCustomerAt(salesType));
  const here = ladder.indexOf(stage);
  if (at === -1 || here === -1) return false;
  return here >= at;
}
