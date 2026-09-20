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

import type { LeadSalesType, LeadStage } from "../lead-labels";

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
 * PARKED, WHICH IS NEITHER TERMINAL NOR ON A LADDER.
 *
 * `on_hold` is a live prospect that has stopped moving — a plant shutdown, a
 * budget quarter, a decision maker abroad. It is emphatically not `lost`: the
 * reason it exists at all is that folding the two together made every stalled
 * lead look dead, and the staleness sweep then archived real prospects.
 *
 * It DISPLACES the rung, because a lead has one stage column and this took it.
 * So the rung it was parked FROM lives in `lead_stage_transitions.from_stage`
 * and nowhere else, and two functions here refuse rather than guess: `bandOf`
 * cannot say which band a parked lead is in, and `gateForNext` cannot say what
 * comes next. Coming back is a move to a NAMED rung — the caller reads the
 * newest transition into `on_hold` and asks `gateTo` about that rung, which
 * evaluates its conditions exactly as it always would.
 *
 * Without this, `nextStage` answered with the FOOT of the ladder, since
 * `on_hold` is on none of them: parking a qualified lead offered to move it
 * back to Suspect, and there was no gate-legal way up again.
 */
export function isParked(stage: LeadStage): boolean {
  return stage === "on_hold";
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
    /*
     * won, lost, customer, active_distributor — out of the funnel by design.
     *
     * `on_hold` lands here too, for a DIFFERENT reason that matters: those four
     * have left the funnel and a parked lead has not. It is unanswerable rather
     * than absent — the rung is in the transition history, not in the stage —
     * so a screen that only counts bands understates the pipeline by every
     * parked lead. Count them with `isParked` and show them beside the funnel.
     * Folding them into a band would be a guess printed as a figure.
     */
    default:
      return null;
  }
}

/**
 * WHERE A LEAD ARRIVING FROM A HANDSET MAY BE PLANTED.
 *
 * §28 is asked when a lead MOVES, and a lead that is created has not moved —
 * so a `create` naming `negotiation`, or `customer`, used to land exactly where
 * it asked with no checklist, no verification, no next action and no transition
 * row behind it. Every gate in the funnel bypassed at the one door that does
 * not ask, on an endpoint that authenticates a device somebody owns rather than
 * a browser session.
 *
 * The answer is neither a refusal nor a shrug. A create carries a shop, a
 * photograph, a pin, a competitor and thirty answers typed standing in front of
 * a shopkeeper, and refusing it puts all of that in the outbox's rejection list
 * for ever to punish one field — the same trade `handleVisit` refuses to make
 * about a distance. So the lead is planted at the FOOT of its own ladder, which
 * is where the deployed handset already plants it, and the rung it asked for is
 * recorded in words by the caller.
 *
 * `lost` is the one other rung a create may name, and it is not an exception to
 * the rule: it is not a climb at all, it is a closure, and what a closure has to
 * carry — a reason — is demanded separately and always was.
 */
export function plantableStage(
  claimed: LeadStage | null | undefined,
  salesType: LeadSalesType | null | undefined,
): LeadStage {
  const foot = ladderFor(salesType)[0];
  if (!claimed) return foot;
  return claimed === foot || claimed === "lost" ? claimed : foot;
}

/**
 * THE RUNGS AT WHICH NOBODY HAS DECIDED ANYTHING YET — §B's "Suspect".
 *
 * This is the one list, and it is here rather than in the two runtimes that
 * enforce the visit cap because there were two of them and they held two
 * different vocabularies. The handset's `visitCapState` and the server's
 * `handleVisit` both spelled a suspect out as `new` and `contacted`, which is
 * the LEGACY ladder's own foot and nothing else — so every lead the funnel
 * raises, which is planted at `suspect`, was invisible to both halves of the
 * rule §B cares about more than any other. No counter on the card, no warning,
 * no decision demanded, and no refusal at the third visit. The office's own
 * `mustDecideSuspect` tested `suspect` and caught it; the two ends that fire at
 * the door did not.
 *
 * `prospect` is deliberately NOT here, and that is the whole distinction the
 * list carries. A Prospect is a shop somebody has already answered the question
 * about — it is what the answer MOVES a Suspect to — so capping it would demand
 * the same decision a second time, which is the "a qualified prospect visited a
 * fourth time is a negotiation, not a stall" rule read one rung lower. The
 * legacy ladder has no such rung: `new` and `contacted` are both "we have been
 * and decided nothing", which is why both of them are capped and why nothing
 * about the old book changes.
 *
 * Not exported. The list is the reasoning and `isUndecidedSuspect` is the
 * question: an export nothing imports is a rule nothing asks, and a second
 * caller reading the array rather than the function is how the two ends came
 * to hold two lists in the first place.
 */
const UNDECIDED_SUSPECT_RUNGS: readonly LeadStage[] = [
  "new",
  "contacted",
  "suspect",
] as const;

/**
 * Whether the visit cap has anything to say about a lead on this rung.
 *
 * Takes a bare string rather than a `LeadStage` because both callers hold one:
 * the server reads `customers.lead_stage`, which is TEXT behind an enum, and
 * the handset reads a column that may still carry the six capitalised words it
 * shipped with. Neither should have to prove the rung is on the union before it
 * can ask — an unrecognised word answers false, which is the safe direction: a
 * cap that fires on a rung nobody recognises is a decision demanded about a
 * lead nobody can place.
 */
export function isUndecidedSuspect(stage: string | null | undefined): boolean {
  return (UNDECIDED_SUSPECT_RUNGS as readonly string[]).includes(stage ?? "");
}

/**
 * THE RUNG AT WHICH A LEAD BECOMES A CUSTOMER, and it is the SECOND order.
 *
 * §22 says so, and the reason is the trade rather than the schema: a first
 * order from a shop that has just finished a trial is a test — a few cans to
 * see how it behaves on their own substrate, in their own booth, in front of
 * their own customer. It is not a relationship and it routinely does not repeat.
 * The SECOND order is the one that says the trial worked and they are buying
 * from us now, and that is what everybody in this business means by a customer.
 *
 * This was built at `first_order` first, on the reasoning that MahekOne's own
 * word for a customer is an account that has ORDERED and that about thirty
 * readers of `customers.kind` assume it. That reasoning was about the CODE and
 * this one is about the trade, and where those two disagree the trade wins —
 * the column exists to describe the business, not the other way round.
 *
 * What makes it safe is that most of those thirty readers do not key on `kind`
 * at all: the Call Log's prospect reason fires on `lastOrderDate` being null,
 * the buying cycle is computed from approved orders whatever the row calls
 * itself, and attribution follows the seats. What genuinely changes is that an
 * account with exactly one order is counted as a lead — which is the whole
 * point, and is what the owner's funnel should have been saying all along.
 *
 * A distributor is NOT held to this. There is no trial order in an appointment:
 * they are approved, they sign, and they place a stock order that was committed
 * to in advance. `distributor_approval` is where they start being invoiced.
 */
export function promotesToCustomerAt(
  salesType: LeadSalesType | null | undefined,
): LeadStage {
  return salesType === "distributor" ? "distributor_approval" : "second_order";
}

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

/**
 * §K ANSWER 05 — THE RUNG A SAMPLE NORMALLY WANTS, AND WHY IT IS A RUNG RATHER
 * THAN A GATE.
 *
 * Mahek's own words: before stock leaves the godown we should already know the
 * product, the approximate monthly requirement, the potential value, the
 * competitor and the basic requirement — and those five are precisely the
 * answers a lead gives on its way from Suspect to Prospect. A sample asked for
 * below that rung is a trial aimed at a shop nobody has established anything
 * about, which is the commonest way a sample becomes stock given away for
 * nothing: there is no requirement to measure the result against, no competitor
 * to compare it with, and no value to weigh the can against.
 *
 * So the threshold is PROSPECT, which is one rung up from the foot of all three
 * funnel ladders. The legacy ladder — the six rungs a lead raised before any of
 * this existed is still climbing — has no `prospect` on it at all, and the rung
 * that means the same thing there is `qualified`; answering with a rung the
 * ladder does not carry would make `indexOf` return -1 and every legacy lead
 * would read as unqualified for ever, which is a flag on the whole of the old
 * book rather than on the handful of shops this is about.
 *
 * NOTHING IS REFUSED ON THIS. It is the difference between an ordinary approval
 * and one a manager should look twice at — a salesman who believes a can in a
 * shopkeeper's hand is what opens the relationship may still ask, and answer 05
 * says in as many words that the Sales Manager decides. See `requestSample`,
 * which marks rather than blocks.
 */
export function sampleReadyStage(salesType: LeadSalesType | null | undefined): LeadStage {
  return ladderFor(salesType).includes("prospect") ? "prospect" : "qualified";
}

/**
 * Whether this lead has climbed far enough that a sample is the ordinary next
 * thing to do.
 *
 * A NULL stage answers TRUE, and that is the case that would otherwise be
 * wrong on far more rows than the one this exists for: a sample is raised
 * against a `customers` row, and a real customer — somebody who has been buying
 * from us for four years — carries no lead stage at all. Reading that absence
 * as "not qualified" would put "Lead not qualified" on every sample anybody
 * ever sent an established account, which is both false and the fastest way to
 * teach a manager that the mark means nothing.
 *
 * A stage that is not on this lead's own ladder answers TRUE for the same kind
 * of reason rather than the same reason. `won`, `customer` and
 * `active_distributor` are past every rung; `on_hold` DISPLACES the rung, so
 * the one it was parked from lives in `lead_stage_transitions` and cannot be
 * read here — and a guess printed as a warning to the person deciding is worse
 * than no warning at all. Only a rung the ladder actually carries is judged.
 */
export function qualifiedForSample(
  stage: LeadStage | null | undefined,
  salesType: LeadSalesType | null | undefined,
): boolean {
  if (!stage) return true;
  const ladder = ladderFor(salesType);
  const here = ladder.indexOf(stage);
  const wanted = ladder.indexOf(sampleReadyStage(salesType));
  if (here === -1 || wanted === -1) return true;
  return here >= wanted;
}
