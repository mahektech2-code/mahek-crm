/**
 * §5 and §6 — THROUGH WHICH CONTROL, which is a third question.
 *
 * `lead-ladder.ts` answers what comes NEXT. `lead-gates.ts` answers whether we
 * MAY. Neither answers the one a person standing on this record is actually
 * asking, which is what to press — and the record's answer was a button
 * reading "Advance", on every rung of all four ladders.
 *
 * §5's stage table is emphatic that it is not one act. At Qualification with
 * all eight conditions met the thing to do is REQUEST THE SAMPLE; at Sample
 * Received it is RECORD THE TRIAL REVIEW; at Negotiation with a commitment on
 * file and no order it is CONFIRM THE ACTUAL ORDER, which is §7's own fork and
 * the single most consequential moment on the ladder. All four of those moved
 * the lead one rung and all four were spelled "Advance", so the verb on the
 * screen said less than the rung above it already did.
 *
 * ---------------------------------------------------------------------------
 * IT IS NOT A SECOND OPINION ABOUT THE GATE, and that is the load-bearing
 * constraint. This file says what a rung's work IS; `lead-gates.ts` says
 * whether that work has been done. Where they could disagree the gate wins,
 * and the card that draws this is built so it cannot offer an action the gate
 * would refuse: a shut gate draws the same verb DISABLED with the engine's own
 * missing list under it. A verb is a label, and a label is not a permission —
 * the same distinction `lead-role-action.ts` spends thirty lines on one file
 * over, and worth restating because a reader who mistook this for the gate
 * might delete a real check believing it redundant.
 *
 * IT DOES NOT RE-DERIVE THE LADDER EITHER. It never asks what the next rung
 * is; it answers about the rung the lead is STANDING on, which is a column.
 * Folding this into `lead-ladder.ts` would put "which form" inside the
 * function that draws progress, and folding it into `lead-gates.ts` would put
 * it inside the one that refuses — three questions, three files, which is the
 * split those two already made between themselves.
 *
 * Pure, like every engine here: it takes what it needs and performs no I/O.
 * That is what lets the handset compile the same file and tell a salesman with
 * no signal what the shop in front of him is waiting for.
 *
 * ---------------------------------------------------------------------------
 * EXHAUSTIVE BY CONSTRUCTION. The switch has no `default`, and the fall-through
 * at the foot assigns the stage to `never` — so a twenty-fourth rung added to
 * the enum fails the BUILD rather than answering nothing at runtime. A rung
 * that answers nothing is a record with no way forward on it, and nobody
 * reports that as a bug; they work around it. `lead-gate-action.test.ts` walks
 * every enum value through here as well, because the type only guards the file
 * and the test guards the promise.
 */

import type { LeadSalesType, LeadStage, SampleState } from "../lead-labels";
import type { LeadActionTone } from "./lead-role-action";

/**
 * WHICH CONTROL ASKS THE QUESTION — named by what it is, never by where it
 * lives.
 *
 * An href is workspace-relative and a modal is a component, so both belong to
 * the screen; this answers only which of the nine things a person is being
 * sent to do. Several of them are not on the record page at all — a sample is
 * dispatched and reviewed at the sample desk, because that is where the stock
 * is — and naming them anyway is the point: a card that offered only what this
 * page happens to render would go silent on exactly the three rungs where
 * somebody most needs to be told where to go.
 */
export type LeadGateControl =
  /** §5.2 — the sales manager's verification call. Nothing opens without it. */
  | "verify"
  /** §5.3 — the sample request form. */
  | "request_sample"
  /** §5.4 — dispatch, receipt and the trial review, which the sample desk owns. */
  | "sample_desk"
  /** §5.5 first act — the forecast. A commitment is not a sale. */
  | "record_commitment"
  /** §5.5 second act — the real order, with a value and a reference. */
  | "confirm_order"
  /** §6.3 and §6.5 — the two-step chain, management's and nobody else's. */
  | "management_approval"
  /**
   * §5.1, §5.6–§5.9, §6.4, §6.6, §6.7 — a plain move up a rung.
   *
   * §5.1's Convert-to-Prospect is one of these rather than a control of its
   * own, and deliberately: MahekOne has no separate convert form, the reason
   * code is asked by the move itself, and inventing a ninth control for it
   * would have the card point somewhere that does not exist. The VERB still
   * says Convert to Prospect, because that is what the move is called on that
   * rung — which is the whole of what this file is for.
   */
  | "advance"
  /** Terminal, lost or parked. There is nothing to press, and saying so is the answer. */
  | "none";

export type LeadGateAction = {
  /** The verb, as somebody would say it out loud. Never a stage name. */
  label: string;
  /** The engine's own answer, not the screen's. See `LeadActionTone`. */
  tone: LeadActionTone;
  control: LeadGateControl;
  /** One sentence under the button, saying what pressing it is understood to do. */
  says: string;
};

/**
 * What the function needs off a lead, and nothing else.
 *
 * A narrow shape rather than the `customers` row, for the reason every engine
 * here takes one: it is what lets the handset compile the same file, and what
 * lets a test state a case in four lines instead of forty.
 */
export type LeadGateActionFacts = {
  stage: LeadStage;
  salesType: LeadSalesType | null;
  /**
   * §4 — the suspect window has run out and a decision is being DEMANDED
   * rather than a visit refused. It is `mustDecideSuspect`'s answer, taken
   * rather than recomputed: counting visits against a cap in two places is two
   * places for the cap to be read differently.
   */
  mustDecide: boolean;
  /**
   * §3.4 — a day AND a size, through `lead-commitment.ts`. The same fact
   * `roleAction` forks the sales manager's verb on, so the card and the
   * readings above it cannot name two different next acts on one afternoon.
   */
  hasCommitment: boolean;
  /** A real order exists against this lead. Ends the asking. */
  hasOrder: boolean;
  /**
   * The newest sample's journey, or null where none has been asked for.
   *
   * The STATE and not the verdict: §5.4's three sub-states are what decide
   * whether the parcel is waiting on the godown, on the courier or on the
   * customer, and those are three different people to chase. What the customer
   * thought is `trial_outcome`, and it is the GATE's question rather than this
   * one — whether a rejected trial may move to Negotiation is `lead-gates.ts`,
   * and answering it here as well would be the second opinion this file must
   * not become.
   */
  sampleState: SampleState | null;
};

const NOTHING: LeadGateAction = {
  label: "Nothing to press",
  tone: "muted",
  control: "none",
  says: "This lead is at the end of its ladder. Drawing a button that could never be enabled would be worse than drawing none.",
};

/**
 * The one function. §5.1 through §5.10 and §6.1 through §6.8, read down a
 * column at a time.
 */
export function gateAction(facts: LeadGateActionFacts): LeadGateAction {
  const distributor = facts.salesType === "distributor";

  switch (facts.stage) {
    /* §5.10 and §—: two closed states and one paused one, and they are three
       different sentences because they send somebody to three different
       places. A park is the only one of the three that has a way out, and the
       way out is naming the rung it returns to rather than a rung above it. */
    case "lost":
      return {
        label: "Nothing to press",
        tone: "muted",
        control: "none",
        says: "This lead is closed. The record and its timeline stay, unchanged, for reference.",
      };
    case "on_hold":
      return {
        label: "Nothing to press",
        tone: "muted",
        control: "none",
        says: "A park is not a rung, so there is no rung above it. Putting this back means naming the rung it returns to, and the gate for that rung is then evaluated exactly as it always would be.",
      };
    case "won":
    case "customer":
    case "active_distributor":
      return NOTHING;

    /*
     * §5.1 — TWO ANSWERS AND BOTH ARE MOVES, which is why the cap asks rather
     * than refuses. Past it nothing is blocked; a decision is demanded, and
     * the verb changes to say so. `engines/geo.ts` states the principle the
     * whole field product rests on — a reading is evidence, never a gate — and
     * this is the same shape one module over: the cost of refusing a fourth
     * visit is the GPS, the competitor note and the reason, thrown away to
     * stop a number reaching four.
     */
    case "new":
    case "suspect":
      return facts.mustDecide
        ? {
            label: "Decide: Prospect, or not",
            tone: "danger",
            control: "advance",
            says: "The visit window has run out. Nothing is being refused — an answer is being demanded, and both answers are moves the rules allow.",
          }
        : {
            label: "Convert to Prospect",
            tone: "brand",
            control: "advance",
            says: "Captures the conversion fields and a coded reason. Not a Prospect is the other answer, and it is the Lost form.",
          };

    /*
     * §5.2 — THE ONE RUNG NOBODY ELSE CAN MOVE. Qualification does not open
     * until a sales manager has rung the customer, and the tone is danger
     * rather than brand for that reason: every day this sits here is a day the
     * salesman who did the work cannot move.
     */
    case "contacted":
    case "prospect":
      return {
        label: "Make the verification call",
        tone: "danger",
        control: "verify",
        says: "A sales manager rings the customer and answers the twelve questions. No amount of GPS proves that Mahek was explained properly, which is what this call is for.",
      };

    /*
     * §5.3 against §6.2 — THE SAME RUNG ASKS TWO DIFFERENT THINGS, which is
     * the clearest case in the table for this function existing at all. A shop
     * is qualified towards a trial; a distributor candidate is qualified
     * towards a profile that management can rule on, and there is no sample in
     * that process anywhere. One verb for both would send half the book to a
     * form that does not apply to them.
     */
    case "qualified":
    case "qualification":
      return distributor
        ? {
            label: "Send for management review",
            tone: "brand",
            control: "advance",
            says: "The candidate profile and the three requested terms go to management. A sales manager may recommend a distributor and may not appoint one.",
          }
        : {
            label: "Request the sample",
            tone: "brand",
            control: "request_sample",
            says: "The product and the application carry forward; only the quantity and the coded reason are new.",
          };

    /*
     * §5.4 — THREE SUB-STATES AND THREE DIFFERENT PEOPLE TO CHASE. A sample
     * nobody approved is waiting on a manager, one approved and unsent is
     * waiting on the godown, and one sent and not acknowledged is waiting on
     * the courier or on the shop. Drawn as one verb they look identical, which
     * is exactly how a sample goes quiet: the salesman assumes it is being
     * tried and the shop assumes we forgot.
     */
    case "sample_trial":
      switch (facts.sampleState) {
        case "approved":
          return {
            label: "Mark the sample dispatched",
            tone: "danger",
            control: "sample_desk",
            says: "Approved and not yet sent. This is stock nobody has given away against an opportunity nobody has taken.",
          };
        case "dispatched":
          return {
            label: "Confirm the shop has it",
            tone: "warn",
            control: "sample_desk",
            says: "Us saying it went and the shop saying it arrived are two different facts, and the review is dated from the second.",
          };
        case "requested":
          return {
            label: "Waiting on the sample approval",
            tone: "warn",
            control: "sample_desk",
            says: "A request is a salesman asking. Until a manager says yes there is nothing for the godown to pack.",
          };
        /* The parcel has overtaken the rung — the shop has it, or has tried
           it, and nobody moved the lead. That is a move and not a chase. */
        case "received":
        case "trial_done":
        case "reviewed":
          return {
            label: "Move the rung on",
            tone: "warn",
            control: "advance",
            says: "The sample is further along than the lead is. The rung is behind the parcel, which is how a trial goes quiet with everybody assuming somebody else is holding it.",
          };
        /* Refused, called off, or never asked for. All three leave this rung
           standing on nothing, and a fresh request is the only way out. */
        case "rejected":
        case "cancelled":
        case null:
          return {
            label: "Ask for a sample",
            tone: "brand",
            control: "request_sample",
            says: "This rung is about a parcel and there is no live one on the record — a refused or cancelled trial needs a fresh request before anything can move.",
          };
      }

    case "sample_received":
      return {
        label: "Record the trial review",
        tone: "brand",
        control: "sample_desk",
        says: "Seven answers and a verdict. A trial nobody reviewed is stock given away for nothing, which is why it is chased until there is an answer.",
      };

    /*
     * §5.4's gate to Negotiation is `trialOutcome === 'approved'`, and that is
     * deliberately NOT asked here — a rejected trial gets the same verb and
     * the gate refuses it with the reason. Asking it in both places is the
     * second opinion this file is written against, and the half that drifts is
     * always the half somebody is reading.
     */
    case "sample_review":
      return {
        label: "Move to Negotiation",
        tone: "brand",
        control: "advance",
        says: "An approved sample is what authorises a commercial conversation — not the salesman deciding he is ready for one.",
      };

    /*
     * §5.5 — TWO SEQUENTIAL ACTS, DELIBERATELY NEVER MERGED, and §7's own
     * fork. A commitment is a forecast and confirming the order is the sale;
     * collapsing them would let a screen record a sale nobody made. The danger
     * tone on the second is the whole reason `hasCommitment` exists as a fact:
     * a commitment on file with no order against it is money left on the table,
     * and it is the one state on this ladder that goes quiet by itself.
     */
    case "negotiation":
      if (facts.hasOrder) {
        return {
          label: "Move to First order",
          tone: "brand",
          control: "advance",
          says: "The order is on the record. The rung follows it.",
        };
      }
      return facts.hasCommitment
        ? {
            label: "Confirm the actual order",
            tone: "danger",
            control: "confirm_order",
            says: "A day and a size were promised and nothing has been placed against them. This asks for a real value and a reference, and it supersedes the forecast.",
          }
        : {
            label: "Record the commitment",
            tone: "brand",
            control: "record_commitment",
            says: "A forecast, not a sale — the expected day and the expected size. It moves no rung and creates no order.",
          };

    /* §5.6–§5.8 — the back office's three, and each is one fact being
       recorded rather than a form being filled in. Payment is the danger one:
       a lead sitting there is money we have delivered and not collected. */
    case "first_order":
      return {
        label: "Mark the order dispatched",
        tone: "warn",
        control: "advance",
        says: "Goods on a lorry are goods sold. The order goes on counting towards every figure it already feeds.",
      };
    case "delivery":
      return {
        label: "Mark it delivered",
        tone: "warn",
        control: "advance",
        says: "The shop saying the goods came is its own fact, and nobody is asked to assume it.",
      };
    case "payment":
      return {
        label: "Mark the payment received",
        tone: "danger",
        control: "advance",
        says: "Delivered and not collected. Money the customer says has arrived is not money the business has seen, so this follows the confirmed receipt rather than the promise.",
      };
    case "second_order":
      return {
        label: "Record the second order",
        tone: "brand",
        control: "advance",
        says: "The terminal, successful rung. Responsibility moves from the Lead Manager to the relationship, and the account lives on the regular Call Log from then on.",
      };

    /* §6.3 and §6.5 — the two approvals, management's and nobody else's. The
       person carrying the target must not be the person allowing the discount
       that hits it, which is why this is a chain and not a button. */
    case "management_review":
      return {
        label: "Management approval",
        tone: "danger",
        control: "management_approval",
        says: "Exclusivity, a discount above the manager's limit or a credit limit above the threshold — whichever of the three is true is what sent this here.",
      };
    case "distributor_approval":
      return {
        label: "Management's final approval",
        tone: "danger",
        control: "management_approval",
        says: "The second of the two steps. A salesman may never appoint a distributor and a manager may not do it alone.",
      };
    case "commercial_discussion":
      return {
        label: "Move to Distributor approval",
        tone: "brand",
        control: "advance",
        says: "Final terms, agreed after management's first clearance.",
      };
    case "distributor_agreement":
      return {
        label: "Confirm the agreement is signed",
        tone: "brand",
        control: "advance",
        says: "Paperwork rather than an approval. Nobody's sign-off is waiting on this one.",
      };
    case "initial_stock_order":
      return {
        label: "Record the initial stock order",
        tone: "brand",
        control: "advance",
        says: "The last rung before the distributor is live and bills directly.",
      };
  }

  /*
   * NO DEFAULT, AND THIS IS WHY. A rung added to the enum and not to the
   * switch fails here, at compile time, as a stage that cannot be assigned to
   * `never` — rather than falling through to a shrug at runtime on somebody's
   * record. The alternative is a lead with no way forward on it, which nobody
   * reports as a bug because it looks like a lead that has nothing waiting.
   */
  const unreachable: never = facts.stage;
  return unreachable;
}
