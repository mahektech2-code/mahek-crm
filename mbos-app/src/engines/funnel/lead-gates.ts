/**
 * §28 — no lead moves forward only because somebody pressed a button.
 *
 * This is the whole of that rule, in one pure function, and it is the reason
 * the rest of the funnel can be trusted. Every stage has conditions; this
 * answers whether they are met and, where they are not, WHICH ONES — because a
 * refusal that does not say what is missing teaches a salesman to press the
 * button again rather than to do the work.
 *
 * THREE CALLERS, ONE ANSWER. The handset draws the next rung disabled with the
 * missing list underneath it; the server action refuses on the same function
 * before it writes; the console shows a manager what a lead is stuck behind. A
 * second copy of these conditions typed into a screen would drift inside one
 * release, and the half that drifts is the half a salesman is reading.
 *
 * It performs no I/O and reads no clock, so the handset compiles it and answers
 * offline — which it must, because the salesman deciding whether he can request
 * a sample is standing in a shop with no signal.
 */

import type { LeadSalesType, LeadStage } from "../lead-labels";
import { isParked, isTerminal, ladderFor, nextStage } from "./lead-ladder";

/* ------------------------------------------------------------- conditions */

/**
 * One thing that has to be true, and the sentence a salesman reads when it is
 * not.
 *
 * `says` is written as an instruction rather than a complaint — "Get their GST
 * number" rather than "GST missing" — because it is displayed as a list of what
 * to go and do, and a list of faults reads as an accusation about work already
 * done.
 */
export type Condition = {
  id: string;
  says: string;
  /** Which of §11's five groups it belongs to. Absent on customer conditions. */
  group?: "legal" | "capability" | "commercial" | "territory" | "commitment";
};

/**
 * §6 — the eight answers a Suspect owes before it may be a Prospect.
 *
 * These are columns rather than checklist ticks, so the gate reads real values.
 * "Decision maker, if known" in the specification is deliberately NOT here: the
 * word "if" makes it an invitation, and a gate that refuses on an optional
 * field is a gate nobody can pass.
 */
export const PROSPECT_CONDITIONS: readonly Condition[] = [
  { id: "customer_type", says: "Say what kind of business this is" },
  { id: "monthly_litres", says: "How many litres a month do they use?" },
  { id: "potential_value", says: "What could they be worth in a month, in rupees?" },
  { id: "competitor", says: "Whose product are they using now?" },
  { id: "required_product", says: "Which of ours do they need?" },
  { id: "contact_person", says: "Who do we ask for when we ring?" },
  { id: "next_action", says: "What happens next, and when?" },
  { id: "prospect_reason", says: "Say why this is worth pursuing" },
] as const;

/**
 * §5 — THE EIGHT a shop answers before anybody may send it a sample.
 *
 * These are the conditions that make a trial mean something: a sample given to
 * somebody whose application we do not understand cannot be reviewed, because
 * nobody knows what a good result would look like.
 *
 * ---------------------------------------------------------------------------
 * IT WAS TWELVE, AND FOUR WERE REMOVED ON THE SPECIFICATION'S OWN INSTRUCTION.
 *
 * `monthly_requirement`, `monthly_potential`, `required_product` and
 * `competitor_identified` are gone from this list. They are not unimportant —
 * they are SECTION 4 CONVERSION FIELDS, asked and answered at Suspect →
 * Prospect, and `PROSPECT_CONDITIONS` above still refuses that move without
 * them. The specification excludes them here in as many words, and the
 * principle it excludes them under is its first one: a fact captured once by
 * whoever was in the shop is never re-asked of the customer by another role.
 * Checking them again at Qualification is the checklist asking the salesman to
 * re-certify work a gate has already refused to let him skip.
 *
 * WHAT THIS COSTS IS REAL AND IS WORTH NAMING. A lead can now reach Sample /
 * Trial with a monthly requirement that was true in March and is stale in
 * September, because nothing on this rung looks at it again. That is the trade
 * the specification makes deliberately: the alternative is a gate that blocks a
 * sample over a field the lead could not have got this far without, which
 * teaches people that the checklist is furniture. The staleness is a question
 * for the verification call, which re-asks exactly these four of the CUSTOMER
 * and records the answer beside the salesman's rather than over it.
 *
 * Removing rather than reinterpreting: a stored tick against one of the four
 * stays in `lead_qualification` and is simply never read. Nothing is rewritten,
 * so a lead somebody qualified last week does not change what it means.
 *
 * `buyer_confirmed` is the eighth and it is CONDITIONAL — see its satisfier.
 */
export const QUALIFICATION_CONDITIONS: readonly Condition[] = [
  { id: "gst_verified", says: "Get their GST number — the back office checks it" },
  { id: "application_understood", says: "Get the precise detail of what they will use it on" },
  { id: "price_discussed", says: "Talk about price, or at least a range" },
  { id: "credit_days", says: "Ask what credit they need" },
  { id: "delivery_discussed", says: "State how long delivery takes and check it suits them" },
  { id: "buyer_confirmed", says: "Confirm who places the order, if that is not the decision maker" },
  { id: "agrees_to_test", says: "Reconfirm they will try it, now price and credit are on the table" },
  { id: "next_step_agreed", says: "Agree what happens if the trial goes well" },
] as const;

/**
 * §11 — the thirty a distributor answers, in the specification's five groups.
 *
 * A shop is asked twelve; a distributor is asked thirty, because appointing one
 * is a commercial arrangement rather than a sale. Every one of these is a column
 * on `distributor_profiles` — the gate reads the row, not a checklist, so a
 * condition cannot be ticked without the answer that satisfies it.
 */
export const DISTRIBUTOR_CONDITIONS: readonly Condition[] = [
  /* business and legal */
  { id: "gst_verified", says: "Verify their GST", group: "legal" },
  { id: "pan_verified", says: "Verify their PAN", group: "legal" },
  { id: "address_verified", says: "Verify the business address", group: "legal" },
  { id: "business_type", says: "Record what kind of business it is", group: "legal" },
  { id: "years_in_business", says: "How long have they been trading?", group: "legal" },
  { id: "decision_maker", says: "Who makes the decisions?", group: "legal" },

  /* distribution capability */
  { id: "dealer_network", says: "Do they have a dealer network?", group: "capability" },
  { id: "active_dealers", says: "How many dealers are actually active?", group: "capability" },
  { id: "territory_covered", says: "What territory do they cover?", group: "capability" },
  { id: "cities_covered", says: "Which cities and markets?", group: "capability" },
  { id: "sales_team", says: "How many people do they have selling?", group: "capability" },
  { id: "delivery_capability", says: "How do they deliver?", group: "capability" },
  { id: "warehouse", says: "Do they have a godown?", group: "capability" },
  { id: "storage_capacity", says: "How much can they hold, in litres?", group: "capability" },

  /* commercial capability */
  { id: "product_portfolio", says: "What do they carry now?", group: "commercial" },
  { id: "competitor_brands", says: "Which competing brands?", group: "commercial" },
  { id: "monthly_potential", says: "What could they do in a month?", group: "commercial" },
  { id: "initial_order_potential", says: "What would the first order be?", group: "commercial" },
  { id: "investment_capacity", says: "What can they put in?", group: "commercial" },
  { id: "expected_monthly_purchase", says: "What will they buy each month?", group: "commercial" },
  { id: "credit_days_required", says: "What credit period do they want?", group: "commercial" },
  { id: "credit_limit_required", says: "What credit limit do they want?", group: "commercial" },

  /* territory */
  { id: "proposed_territory", says: "Which territory are they asking for?", group: "territory" },
  { id: "existing_checked", says: "Check whether we already have somebody there", group: "territory" },
  { id: "conflict_checked", says: "Settle whether that clashes with anyone", group: "territory" },
  { id: "exclusivity", says: "Are they asking for exclusivity?", group: "territory" },

  /* commitment */
  { id: "initial_stock", says: "What stock will they commit to?", group: "commitment" },
  { id: "monthly_commitment", says: "What will they commit to monthly?", group: "commitment" },
  { id: "dealer_development", says: "What will they do about growing dealers?", group: "commitment" },
  { id: "expected_start", says: "When would they start?", group: "commitment" },
] as const;

/* ------------------------------------------------------------------ input */

/**
 * Everything the gates read, and nothing they do not.
 *
 * Explicit rather than a `Customer` row, for the usual reason every engine here
 * takes an argument list: the handset has no `customers` table of that shape,
 * and a function that takes a database row cannot be called from a phone.
 */
export type LeadGateInput = {
  salesType: LeadSalesType | null | undefined;
  stage: LeadStage;

  /* §6 — the prospect answers */
  customerType?: string | null;
  monthlyLitres?: number | null;
  potentialPaise?: number | null;
  competitor?: string | null;
  requiredProductId?: string | null;
  contactPerson?: string | null;
  decisionMaker?: string | null;
  /**
   * §4.2 — who PLACES the order, where that is not who approves it. Null on
   * the ordinary shop where one man does both, which is why the condition
   * reading it accepts a confirmed decision maker instead.
   */
  buyer?: string | null;
  /**
   * §11.6 — the BACK OFFICE's answer, not the salesman's tick. `gstin` above
   * is the number somebody wrote down; this is whether anybody checked it.
   */
  gstVerified?: boolean | null;
  creditDaysWanted?: number | null;
  application?: string | null;
  gstin?: string | null;

  /* §24 — the next action, which every active lead owes */
  nextAction?: string | null;
  nextActionDate?: string | null;
  nextActionOwnerId?: string | null;

  /* §9 §11 — the ticked conditions */
  qualification?: Record<string, boolean | string> | null;

  /* §4 — the suspect window */
  suspectVisitCount?: number;
  suspectDecidedAt?: Date | string | null;

  /* §5 — the reason recorded on the move to Prospect */
  prospectReasonRecorded?: boolean;

  /* §8 — the manager's verification */
  verifiedAt?: Date | string | null;

  /* §23 — a third-party shop has to say who invoices it */
  thirdParty?: boolean;
  distributorCount?: number;

  /* §15 §16 — the sample, where there is one */
  sample?: {
    state: string;
    trialOutcome: string;
    feedbackRecorded: boolean;
  } | null;

  /* §11 §12 — the distributor's application and its approvals */
  distributorProfile?: Record<string, unknown> | null;
  managementReviewApproved?: boolean;
  distributorApprovalApproved?: boolean;
  commercialTermsAgreed?: boolean;
  agreementOnFile?: boolean;

  /* §18–§22 — what the ledger says, read rather than re-derived */
  countingOrderCount?: number;
  deliveredOrderCount?: number;
  confirmedPaymentCount?: number;
  expectedOrderDate?: string | null;
  initialStockOrderPlaced?: boolean;
};

/** What a gate answers. `missing` is empty exactly when `open` is true. */
export type GateVerdict = {
  /** The rung being asked about. */
  to: LeadStage;
  open: boolean;
  missing: Condition[];
  /**
   * Why there is no answer rather than a negative one — a lead already at the
   * top of its ladder, or one on a terminal rung. The screen says this instead
   * of drawing a disabled button that could never be enabled.
   */
  noNextRung?: boolean;
};

/* --------------------------------------------------------------- helpers */

function has(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "boolean") return v;
  return true;
}

/** A checklist answer counts where it is `true` or a non-empty string. */
function ticked(q: Record<string, boolean | string> | null | undefined, id: string): boolean {
  if (!q) return false;
  return has(q[id]);
}

function missingFrom(
  conditions: readonly Condition[],
  met: (c: Condition) => boolean,
): Condition[] {
  return conditions.filter((c) => !met(c));
}

/* -------------------------------------------------------- the §24 rule */

/**
 * §24 — an active lead may not sit with nothing owed by anybody.
 *
 * Applied to every upward move rather than to one stage, which is what makes it
 * the standing rule the specification asks for rather than a field on a form.
 * Terminal rungs are exempt: there is nothing left to do about a lead that is
 * lost, and demanding a next action on one would be a box somebody types a full
 * stop into.
 */
const NEXT_ACTION_CONDITION: Condition = {
  id: "next_action",
  says: "Say what happens next, on what day, and who is doing it",
};

function nextActionMet(i: LeadGateInput): boolean {
  return has(i.nextAction) && has(i.nextActionDate) && has(i.nextActionOwnerId);
}

/* --------------------------------------------------- per-stage conditions */

/**
 * What has to be true to ENTER a given rung.
 *
 * Keyed by destination, never by origin: the question a screen asks is "may
 * this go to Prospect", and answering it from where the lead happens to be
 * standing would give two different answers for one rung depending on the route
 * taken to it.
 */
function conditionsToEnter(to: LeadStage, i: LeadGateInput): Condition[] {
  const q = i.qualification;
  const p = (i.distributorProfile ?? {}) as Record<string, unknown>;
  const out: Condition[] = [];

  switch (to) {
    /* ------------------------------------------------------------ §5 §6 */
    case "prospect": {
      out.push(
        ...missingFrom(PROSPECT_CONDITIONS, (c) => {
          switch (c.id) {
            case "customer_type": return has(i.customerType);
            case "monthly_litres": return has(i.monthlyLitres);
            case "potential_value": return has(i.potentialPaise);
            case "competitor": return has(i.competitor);
            case "required_product": return has(i.requiredProductId);
            case "contact_person": return has(i.contactPerson);
            case "next_action": return nextActionMet(i);
            case "prospect_reason": return Boolean(i.prospectReasonRecorded);
            default: return true;
          }
        }),
      );
      return out;
    }

    /* --------------------------------------------------------------- §9 */
    case "qualification": {
      /* Entering qualification is entering the WORK of qualifying, so the
         twelve are not asked here — they are what it produces. What is asked is
         the manager's verification, because §7 makes that the first thing that
         happens to a prospect and the whole point is that it happens BEFORE the
         salesman goes any further. */
      if (!has(i.verifiedAt)) {
        out.push({
          id: "manager_verified",
          says: "Your sales manager has to verify this customer first",
        });
      }
      return out;
    }

    /* ---------------------------------------------------- §9 §10 the trial */
    case "sample_trial": {
      const isDistributorLadder = i.salesType === "distributor";
      if (!isDistributorLadder) {
        out.push(
          ...missingFrom(QUALIFICATION_CONDITIONS, (c) => {
            switch (c.id) {
              /* THREE of the eight are answered by a real column rather than
                 a tick, so the gate reads the value: a ticked box beside an
                 empty field is exactly the state this engine exists to stop.
                 The rest are genuine yes/no judgements with nothing to store
                 but the answer — "did you talk about price" has no column
                 because the answer is the conversation.

                 §11.6 — GST NOW READS A COLUMN SOMEBODY ELSE WROTE. It used to
                 be the number plus a TICK, and the tick was writable by anyone
                 holding `lead.work`, which is the salesman who typed the number
                 in. So the man collecting it was the man certifying it. The
                 specification gives validation to the back office, and
                 `customers.gst_verified` is their answer, stamped with who and
                 when. The old tick is not read at all: carrying it forward
                 would import the self-certification into the column that exists
                 to end it. */
              case "gst_verified": return has(i.gstin) && i.gstVerified === true;
              case "credit_days": return has(i.creditDaysWanted);
              case "application_understood": return has(i.application);
              /* CONDITIONAL, and the only condition here that can be satisfied
                 by a fact about a DIFFERENT field.

                 The specification asks for the buyer "only if different from
                 the Decision Maker already on record" — so on a shop where the
                 owner both decides and orders, naming him once is the whole
                 answer and being asked again is the re-asking this checklist
                 was cut down to avoid. A buyer on the record satisfies it
                 outright; with no buyer named, a decision maker plus the
                 salesman's tick saying "same man" does.

                 The tick is also read under its OLD id. This condition was
                 `decision_maker` until the list was cut to eight, and a lead
                 somebody qualified last week carries that key in its jsonb —
                 reading only the new one would un-tick work already done and
                 send finished leads back down the ladder. */
              case "buyer_confirmed":
                return (
                  has(i.buyer) ||
                  (has(i.decisionMaker) &&
                    (ticked(q, "buyer_confirmed") || ticked(q, "decision_maker")))
                );
              default: return ticked(q, c.id);
            }
          }),
        );
      }
      /* §23 — a shop we do not invoice has to say who does, before it is given
         anything. A sample sent to a counter nobody bills is stock nobody can
         account for. */
      if (i.thirdParty && !(i.distributorCount && i.distributorCount > 0)) {
        out.push({
          id: "distributor_named",
          says: "Say which distributor invoices this shop",
        });
      }
      return out;
    }

    /* --------------------------------------------------------------- §15 */
    case "sample_received": {
      if (i.sample?.state !== "dispatched" && i.sample?.state !== "received") {
        out.push({ id: "sample_dispatched", says: "The sample has to be sent first" });
      }
      return out;
    }

    case "sample_review": {
      const s = i.sample?.state;
      if (s !== "received" && s !== "trial_done" && s !== "reviewed") {
        out.push({ id: "sample_delivered", says: "Confirm they actually received it" });
      }
      return out;
    }

    /* --------------------------------------------------------- §17 §9 §16 */
    case "negotiation": {
      /* On the legacy ladder this rung has no gate at all, which is how it
         behaved before the funnel existed and how it must go on behaving for
         every lead raised before it. */
      if (!i.salesType) return out;
      /* The two halves used to disagree about what a MISSING sample meant: no
         sample pushed `sample_reviewed`, so it was never negotiable, while
         `sample_approved` fired only where a row existed. One condition rather
         than a contradictory pair — the trial is a rung on both ladders that
         reach here, so no sample is one fact and deserves one sentence. */
      if (!i.sample) {
        out.push({ id: "sample_sent", says: "Nothing has been sent for them to try yet" });
        return out;
      }
      if (!i.sample.feedbackRecorded) {
        out.push({ id: "sample_reviewed", says: "Write down what they thought of the sample" });
      }
      if (i.sample.trialOutcome !== "approved") {
        out.push({
          id: "sample_approved",
          says: "They have to be happy with the trial before you negotiate",
        });
      }
      return out;
    }

    /* --------------------------------------------------------------- §18 */
    case "first_order": {
      if (!has(i.expectedOrderDate)) {
        out.push({
          id: "expected_order_date",
          says: "Ask when they will place it, and record the date",
        });
      }
      if (!(i.countingOrderCount && i.countingOrderCount >= 1)) {
        out.push({ id: "order_placed", says: "There is no order on this account yet" });
      }
      return out;
    }

    case "delivery": {
      if (!(i.deliveredOrderCount && i.deliveredOrderCount >= 1)) {
        out.push({ id: "order_delivered", says: "The material has not reached them yet" });
      }
      return out;
    }

    case "payment": {
      if (!(i.confirmedPaymentCount && i.confirmedPaymentCount >= 1)) {
        out.push({
          id: "payment_confirmed",
          says: "Accounts have not found the money in the bank yet",
        });
      }
      return out;
    }

    /* ----------------------------------------------------------- §21 §22 */
    case "second_order": {
      if (!(i.countingOrderCount && i.countingOrderCount >= 2)) {
        out.push({ id: "second_order_placed", says: "They have not come back with a second order" });
      }
      return out;
    }

    case "customer": {
      if (!(i.countingOrderCount && i.countingOrderCount >= 2)) {
        out.push({
          id: "two_orders",
          says: "A customer is somebody who came back — two orders, not one",
        });
      }
      return out;
    }

    /* ----------------------------------------------------------- §11 §12 */
    case "management_review": {
      out.push(
        ...missingFrom(DISTRIBUTOR_CONDITIONS, (c) => {
          switch (c.id) {
            case "gst_verified": return p.gstVerified === true;
            case "pan_verified": return p.panVerified === true;
            case "address_verified": return p.businessAddressVerified === true;
            case "business_type": return has(p.businessType);
            case "years_in_business": return has(p.yearsInBusiness);
            case "decision_maker": return has(p.decisionMaker);
            /* Answered, not affirmative. See the note on these two columns in
               `distributor_profiles`: a candidate with no godown is ordinary,
               and a gate demanding `true` could only ever be passed by lying. */
            case "dealer_network": return p.hasDealerNetwork !== null && p.hasDealerNetwork !== undefined;
            case "active_dealers": return has(p.activeDealerCount);
            case "territory_covered": return has(p.territoryCovered);
            case "cities_covered": return has(p.citiesCovered);
            case "sales_team": return has(p.salesTeamSize);
            case "delivery_capability": return has(p.deliveryCapability);
            case "warehouse": return p.hasWarehouse !== null && p.hasWarehouse !== undefined;
            case "storage_capacity": return has(p.storageCapacityLitres);
            case "product_portfolio": return has(p.productPortfolio);
            case "competitor_brands": return has(p.competitorBrands);
            case "monthly_potential": return has(p.monthlyPotentialPaise);
            case "initial_order_potential": return has(p.initialOrderPotentialPaise);
            case "investment_capacity": return has(p.investmentCapacityPaise);
            case "expected_monthly_purchase": return has(p.expectedMonthlyPurchasePaise);
            case "credit_days_required": return has(p.creditDaysRequired);
            case "credit_limit_required": return has(p.creditLimitRequiredPaise);
            case "proposed_territory": return has(p.proposedTerritory);
            case "existing_checked": return p.existingDistributorChecked === true;
            /* A conflict that IS recorded as true still satisfies the check —
               the condition is that somebody looked, not that the answer was
               convenient. A real clash is management's to weigh, not the
               gate's to hide. */
            case "conflict_checked": return p.territoryConflict !== null && p.territoryConflict !== undefined;
            case "exclusivity": return p.exclusivityRequested !== null && p.exclusivityRequested !== undefined;
            case "initial_stock": return has(p.initialStockCommitmentPaise);
            case "monthly_commitment": return has(p.monthlyPurchaseCommitmentPaise);
            case "dealer_development": return has(p.dealerDevelopmentCommitment);
            case "expected_start": return has(p.expectedStartDate);
            default: return false;
          }
        }),
      );
      return out;
    }

    case "commercial_discussion": {
      if (!i.managementReviewApproved) {
        out.push({
          id: "manager_recommended",
          says: "Your sales manager has to put them forward first",
        });
      }
      return out;
    }

    case "distributor_approval": {
      if (!i.commercialTermsAgreed) {
        out.push({
          id: "terms_agreed",
          says: "Settle the discount, the credit limit and the territory first",
        });
      }
      if (!i.distributorApprovalApproved) {
        out.push({
          id: "management_approved",
          says: "Only management can appoint a distributor",
        });
      }
      return out;
    }

    case "distributor_agreement": {
      if (!i.agreementOnFile) {
        out.push({ id: "agreement_signed", says: "Put the signed agreement on file" });
      }
      return out;
    }

    case "initial_stock_order": {
      if (!i.initialStockOrderPlaced) {
        out.push({
          id: "stock_ordered",
          says: "They have not placed the stock order they committed to",
        });
      }
      return out;
    }

    case "active_distributor": {
      if (!i.initialStockOrderPlaced) {
        out.push({ id: "stock_ordered", says: "The initial stock order has not been placed" });
      }
      return out;
    }

    /* `suspect` is the foot of every ladder and has no gate — a lead is raised
       onto it. `won` and `lost` are answered by `gateTo` below rather than
       here: losing one is always allowed, and `won` is the legacy ladder's
       terminal rung, which the funnel does not gate. */
    default:
      return out;
  }
}

/* ------------------------------------------------------------ the answer */

/**
 * §4 — the suspect window, which is the one gate that pushes rather than holds.
 *
 * Two visits to decide, three at the outside. Past the cap the specification
 * FORCES a decision, so this is reported separately from a gate: nothing is
 * being refused, something is being demanded. The screen turns the lead into a
 * single question, and `advanceLeadStage` is not what enforces it — a salesman
 * who has run out of visits has to answer Prospect or Not Prospect, and both of
 * those are moves this engine allows.
 */
export function mustDecideSuspect(i: LeadGateInput, maxVisits: number): boolean {
  if (i.stage !== "suspect") return false;
  if (has(i.suspectDecidedAt)) return false;
  return (i.suspectVisitCount ?? 0) >= maxVisits;
}

/**
 * May this lead move to that rung, and if not, what is missing.
 *
 * `lost` is always open — §26 puts it at every rung, and a lead that cannot be
 * closed is a lead that gets abandoned instead, which is the same outcome with
 * no reason recorded. The reason itself is demanded by the action, not here:
 * this engine answers about conditions, and "say why" is a field on a form.
 */
export function gateTo(i: LeadGateInput, to: LeadStage): GateVerdict {
  if (to === "lost") return { to, open: true, missing: [] };

  const missing = conditionsToEnter(to, i);

  /* §24, applied to every upward move on a real ladder. Not to the legacy one:
     those leads predate the rule, and demanding a next action to move a
     four-year-old lead would freeze the book the rule was meant to unstick.

     Skipped where the destination's own list already carries it — the move to
     Prospect asks for a next action among its eight, and pushing this as well
     printed the same instruction twice in one refusal, worded differently. A
     salesman reading a list of what to go and do counts the items. */
  const alreadyAsked = missing.some((c) => c.id === NEXT_ACTION_CONDITION.id);
  if (i.salesType && to !== "won" && !alreadyAsked && !nextActionMet(i)) {
    missing.push(NEXT_ACTION_CONDITION);
  }

  return { to, open: missing.length === 0, missing };
}

/** The ordinary question: may it go UP one, and what is in the way. */
export function gateForNext(i: LeadGateInput): GateVerdict {
  /* `nextStage` answers with the foot of the ladder for a stage that is not on
     it, which is right for a lead whose sales type somebody has just changed and
     wrong for a terminal one — without this guard a LOST lead was offered "move
     to Suspect". Terminal is checked here rather than there because the ladder
     engine is a map, and being finished with it is not a place on it. */
  /* A PARKED lead is refused here too, and not because it is finished. `on_hold`
     is on no ladder, so `nextStage` would answer with the FOOT of one — parking
     a qualified lead offered to move it back to Suspect. Coming back is a move
     to a NAMED rung, read from the transition that parked it. */
  const to =
    isTerminal(i.stage) || isParked(i.stage) ? null : nextStage(i.stage, i.salesType);
  if (!to) {
    return { to: i.stage, open: false, missing: [], noNextRung: true };
  }
  return gateTo(i, to);
}

/**
 * Which conditions a stage is made of, for a screen that draws the checklist.
 *
 * The same list the gate refuses on, so a salesman ticking his way down it
 * cannot arrive at the bottom and still be refused — which is the failure that
 * makes people stop trusting a checklist entirely.
 */
export function checklistFor(
  salesType: LeadSalesType | null | undefined,
  stage: LeadStage,
): readonly Condition[] {
  if (salesType === "distributor" && stage === "qualification") return DISTRIBUTOR_CONDITIONS;
  if (stage === "qualification") return QUALIFICATION_CONDITIONS;
  if (stage === "suspect") return PROSPECT_CONDITIONS;
  return [];
}

/**
 * §12 — whether anything about this appointment is out of the ordinary.
 *
 * The specification names three things: a special discount, a credit limit, and
 * territory exclusivity. Anything out of the ordinary in those is a decision
 * with a cost attached, and the person carrying the target should not be the
 * person allowing it.
 *
 * Returns the trigger's own name, or null where none of the three applies. It
 * does NOT answer whether management see the appointment — they always do, and
 * `managementRouteReason` below is the function that says so. This one is read
 * by the screens that draw the escalation callout, where "nothing forced this
 * upstairs" is the whole point of the paragraph.
 */
export function approvalRouteReason(
  profile: Record<string, unknown> | null | undefined,
  thresholds: { discountPercent: number; creditLimitPaise: number },
): string | null {
  if (!profile) return null;
  const discount = Number(profile.specialDiscountPercent ?? 0);
  const limit = Number(profile.agreedCreditLimitPaise ?? 0);
  /* `exclusivityGranted`, NOT `exclusivityRequested` — one letter apart in the
     same object and opposite in meaning. Asking for exclusivity is a candidate's
     opening position and routes nowhere; GRANTING it is the term that cannot be
     walked back without taking something away from somebody, so it always goes
     to management whatever the numbers beside it say. */
  if (profile.exclusivityGranted === true) return "exclusivity";
  if (discount > thresholds.discountPercent) return "over_discount";
  if (limit > thresholds.creditLimitPaise) return "over_credit_limit";
  return null;
}

/**
 * The word an unescalated appointment reaches management under.
 *
 * It is a stored `routeReason` like `exclusivity` or `over_discount`, and it
 * exists so that "nothing forced this upstairs" is a thing the row can SAY
 * rather than a row that is absent. A missing row and an ordinary one look
 * alike in a queue and are opposite answers to "has anybody been asked".
 */
export const STANDARD_ROUTE_REASON = "standard";

/**
 * Why this appointment is in front of management — and it always is.
 *
 * MANAGEMENT ALWAYS REVIEWS, AND THAT IS A REVERSAL. `approvalRouteReason`
 * above used to decide whether a second signature was needed AT ALL, and a
 * routine candidate — no exclusivity, discount and credit limit both under the
 * thresholds — got no `stepIndex` 1 row written for it. But the gate on
 * `distributor_approval` asks for `distributorApprovalApproved` unconditionally
 * and always has, so there was nothing anybody could ever approve: an ordinary
 * candidate reached `commercial_discussion` and stayed there for ever, with the
 * checklist complete, the terms agreed and the refusal naming a signature that
 * no screen could produce. The specification settles it in as many words — "Who
 * acts: Management only" against BOTH `management_review` and
 * `distributor_approval` — and it names the fallback wording itself: the
 * escalation callout lists whichever trigger applies, or falls back to
 * "standard review" where none do.
 *
 * So `approvalRouteReason` no longer answers WHETHER management see it. It
 * answers WHY it reached them, and this function is the whole of that change:
 * a trigger where there is one, `standard` where there is not. The two are kept
 * as separate functions deliberately — the record screen's escalation callout
 * still needs to know whether anything was ABOVE A THRESHOLD, which is a
 * different question from which words go on the row, and folding them together
 * would make an ordinary appointment read as an escalated one on the one screen
 * where the difference is the point.
 */
export function managementRouteReason(
  profile: Record<string, unknown> | null | undefined,
  thresholds: { discountPercent: number; creditLimitPaise: number },
): string {
  return approvalRouteReason(profile, thresholds) ?? STANDARD_ROUTE_REASON;
}

/**
 * Every rung of this lead's ladder with its verdict, for the record page.
 *
 * Drawn as the whole climb rather than only the next step, because a manager
 * looking at a stalled lead wants to see where it stopped and what it is
 * waiting on — and a salesman learns the process from seeing the rungs above
 * him, not from being told one at a time.
 */
export function ladderVerdicts(i: LeadGateInput): GateVerdict[] {
  return ladderFor(i.salesType).map((stage) => gateTo(i, stage));
}
