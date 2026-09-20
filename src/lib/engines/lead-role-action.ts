/**
 * §7 — one lead, several role-shaped instructions.
 *
 * The specification calls this the single most important piece of business
 * logic in the pipeline, and the reason is worth stating rather than assumed: a
 * lead in Negotiation with a commitment on file is a DIFFERENT INSTRUCTION to
 * five different people on the same afternoon. The sales manager should be
 * confirming the actual order; the salesman should be making the negotiation
 * visit; the back office has nothing operational to do and should be told so in
 * words rather than shown a blank. Written as five screens, those are five
 * places for the ladder to be re-read and five chances to disagree about one
 * shop. Written as one function, they cannot.
 *
 * Pure, like every engine here: it takes what it needs and performs no I/O.
 *
 * ---------------------------------------------------------------------------
 * A VANTAGE IS NOT A ROLE, AND THIS FILE DECIDES WORDS RATHER THAN RIGHTS.
 *
 * MahekOne has three LEVELS and per-app GRANTS — `access-control.ts` is
 * emphatic that a role is a level and the app is the job, and that there is
 * deliberately no `management` role and no `back_office` role: management is
 * `admin` holding `distributor.approve`, and the back office is a SEAT,
 * `customers.back_office_am_id`, held by somebody whose hat is an ordinary CRM
 * one. Inventing five roles to satisfy a table in a specification would be
 * teaching scope, the console, the audit log and every switcher about a
 * vocabulary that exists nowhere else in the product.
 *
 * So what this file takes is a VANTAGE: which of the five jobs the person
 * reading the screen is doing on THIS lead. It is resolved from their hats and
 * from the seats they hold on the row — `vantagesFor` in the service layer —
 * and it answers exactly one question, which is what sentence to put in front
 * of them. It answers NOTHING about what they may do: every action in
 * `lib/actions/leads.ts` goes on asking `requireCapability`, because a server
 * action is a URL and a sentence is not a permission.
 *
 * The distinction is worth labouring because the two look alike from a
 * distance, and a reader who mistakes this for the security boundary might
 * delete a real check believing it redundant. It is the same shape as the rule
 * about territory narrowing a book without being a permission.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS FILE PARTS COMPANY WITH §7, said here rather than left to be
 * discovered by whoever next reads the table beside the code.
 *
 * ONE CELL IS DELIBERATELY NOT THE TABLE'S. The back office reads "Validate
 * GST number" at Prospect, where §7's row has a dash and §7's own note says
 * the back office is silent from Suspect through Negotiation. The
 * specification disagrees with ITSELF about that cell, and the other two
 * readings win: §2 hands the back office "Sample dispatch, GST validation,
 * order processing…" in as many words, and §11.6 is emphatic — GST is
 * collected once and validated once, only the back office flips `gstVerified`,
 * and no other role's screens ask for it again. Qualification condition #1
 * says the same thing to the salesman standing in the shop. MahekOne built it
 * that way rather than borrowed it: `lead.gstValidate` is a real capability
 * with its own desk check, and the qualify gate reads the office's verdict, so
 * the number is asked for at Prospect precisely because qualification is the
 * rung it blocks. A back office told "nothing operational pending" on the one
 * early rung where a lead is waiting on THEM is the exact failure the muted
 * sentences exist to prevent. The dash is read as the prototype's mock
 * omitting a step it never implemented, not as a rule.
 *
 * AND THE TONES ARE AN INTERPRETATION, which is worth saying because it looks
 * like conformance. §7 marks four cells danger — "Confirm actual order",
 * "Approval required" twice, and "Payment follow-up" — and says nothing
 * whatever about the rest, which is an absence rather than a verdict of "not
 * danger". Three more carry it here: "Verify prospect", "Review sample /
 * trial" and "Dispatch sample". Each is a rung where the lead is stopped dead
 * until that one person acts and nobody else on the table can move it — §11.2
 * says nothing skips manager verification, §11.4 says negotiation cannot open
 * on an unreviewed trial, and an approved sample nobody has posted is a lead
 * waiting on a parcel that never left. A tone is what sorts four hundred rows,
 * so a blocking rung drawn at the weight of a courtesy visit is a list nobody
 * works top-down. It is a choice; it should be read as one.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DECIDE is whether the lead may MOVE — that is
 * `lead-gates.ts` — nor what comes next, which is `lead-ladder.ts`. A person
 * can be told "Confirm actual order" by this file and refused by that one, and
 * that is correct: the instruction is what they are FOR, the gate is whether
 * the work behind it has been done. The screen draws both.
 */

import type { LeadSalesType, LeadStage } from "../lead-labels";

/**
 * The five jobs §2 names, as a view rather than as a role.
 *
 * `distributor_salesman` is deliberately absent although §2 names a sixth
 * person: they work for the distributor, have no MahekOne login and never will
 * — `distributor_salesmen` is a name on a row, not a `users` row — so there is
 * nobody for this function to put a sentence in front of.
 */
export type LeadVantage =
  | "salesman"
  | "calling_desk"
  | "sales_manager"
  | "management"
  | "back_office";

/**
 * The four tones §7 names.
 *
 * `muted` is the one that earns its place: "Nothing operational pending" is a
 * real and useful answer, and drawn at the same weight as "Payment follow-up"
 * it would be read as a task. The other three map onto the house vocabulary in
 * `ui/primitives`; muted is the absence of one.
 */
export type LeadActionTone = "brand" | "warn" | "danger" | "muted";

export type LeadAction = {
  /** The instruction, as a verb phrase. Never a stage name. */
  label: string;
  tone: LeadActionTone;
  /**
   * TRUE where the vantage is being asked to DO something, false where it is
   * being told there is nothing for it. The distinction drives whether a lead
   * counts towards somebody's "needs you today", and it is not the same as
   * `tone !== "muted"`: "Awaiting manager verification" is a warn-toned
   * sentence about somebody ELSE's work.
   */
  actionable: boolean;
};

/**
 * What the function needs off a lead, and nothing else.
 *
 * A narrow shape rather than the `customers` row, for the reason every engine
 * here takes one: it is what lets the handset compile the same file, and what
 * lets a test state a case in four lines instead of forty.
 */
export type LeadActionFacts = {
  stage: LeadStage;
  salesType: LeadSalesType | null;
  /**
   * §3.4 — a forecast somebody recorded, NOT a sale. Its presence is what
   * escalates the sales manager's verb in Negotiation from supporting the
   * conversation to closing it, and it is the whole reason that stage forks.
   *
   * A COMMITMENT IS A DAY AND A SIZE, and that is a reversal: either half
   * used to count, so a lead where all anybody had written down was "around
   * the 25th" escalated the manager to "Confirm actual order" — an order
   * nobody had agreed a quantity or a price for. `lib/lead-commitment.ts` is
   * the one place the rule lives and `LEAD_ROW_SELECT` reads it from there;
   * this engine takes the answer rather than the columns, like every other
   * fact here, which is what lets the handset compile it.
   */
  hasCommitment: boolean;
  /** A real order exists against this lead. Ends the asking. */
  hasOrder: boolean;
  /**
   * A sample a manager has APPROVED and nobody has sent yet. What lights the
   * back office up at `sample_trial`: the dispatch is theirs and the review is
   * not.
   *
   * THE WORD "APPROVED" IN THAT SENTENCE IS LOAD BEARING, and it used to be
   * missing. The fact was computed over `state in ('requested', 'approved')`,
   * on the reasoning that both are states before dispatch and therefore both
   * are a parcel somebody is waiting on. A REQUEST is not: it is a salesman
   * asking, and until the Sales Manager says yes there is nothing to pack —
   * so this told the back office to "Dispatch sample" on a lead whose sample
   * nobody had approved, which is the one thing the approval step exists to
   * stop. It also outlived a refusal, because a lead can carry a rejected
   * sample and a fresh request at once.
   *
   * The sample desk's own worklist has always keyed on `approved` alone, so
   * the two screens disagreed about one shop; they no longer can. Where the
   * request is still waiting on a manager, the sales manager's own line at
   * this rung is what says so, and the back office is told the truth instead:
   * nothing has been dispatched, and nothing is theirs to dispatch yet.
   */
  sampleAwaitingDispatch: boolean;
};

const NOTHING_OPERATIONAL: LeadAction = {
  label: "Nothing operational pending",
  tone: "muted",
  actionable: false,
};

const NO_CALLING_DESK_ACTION: LeadAction = {
  label: "No calling-desk action",
  tone: "muted",
  actionable: false,
};

const NO_APPROVAL_PENDING: LeadAction = {
  label: "No approval pending",
  tone: "muted",
  actionable: false,
};

/**
 * §7's note, second half: management sees "No approval pending" on an ordinary
 * lead "or 'Monitor distributor track' if it's a distributor-type lead
 * elsewhere in its ladder".
 *
 * That sentence is what `facts.salesType` is FOR, and for a while nothing read
 * it — a declared input nothing consults is worse than an absent one, because
 * it reads as implemented. A distributor candidate sitting at Suspect,
 * Prospect, Qualification or Negotiation told "No approval pending" is being
 * told something true and useless: the distributor track is the one ladder
 * management owns end to end, and the honest answer while a candidate climbs
 * towards them is that there is a track here worth an eye. Both answers are
 * muted and neither is actionable, so this changes what management READS and
 * never what lands on their queue — §7's own rule that management is given a
 * verb on exactly the three approval rungs is untouched, and there is a test
 * saying so.
 */
const MONITOR_DISTRIBUTOR: LeadAction = {
  label: "Monitor distributor track",
  tone: "muted",
  actionable: false,
};

/** Management's quiet answer, which depends on which ladder the lead is on. */
function managementQuiet(facts: LeadActionFacts): LeadAction {
  return facts.salesType === "distributor" ? MONITOR_DISTRIBUTOR : NO_APPROVAL_PENDING;
}

const NOT_YOUR_LADDER: LeadAction = {
  label: "No action for you on this lead",
  tone: "muted",
  actionable: false,
};

/** Every vantage reads the same sentence on a lost lead. */
const LOST: LeadAction = { label: "Lost — no action", tone: "muted", actionable: false };

/**
 * §—: parked is not lost, and the sentence has to say so.
 *
 * `on_hold` displaces the rung rather than ending the climb, so an instruction
 * derived from the stage would be an instruction about nothing. What everybody
 * needs to know is that somebody paused it and it will come back.
 */
const PARKED: LeadAction = {
  label: "On hold — parked, not lost",
  tone: "muted",
  actionable: false,
};

/**
 * The one function. §7's table, read down a column at a time.
 *
 * It is a switch on the stage with a branch per vantage rather than five
 * functions, because the table is the specification and a reader checking this
 * against it should be able to put them side by side.
 */
export function roleAction(facts: LeadActionFacts, vantage: LeadVantage): LeadAction {
  const { stage } = facts;

  if (stage === "lost") return LOST;
  if (stage === "on_hold") return PARKED;

  /* The distributor ladder is management's, and everybody else on it is
   * waiting. Handled ahead of the shared rungs because three of its stages
   * have no counterpart on the other two ladders at all. */
  if (
    stage === "management_review" ||
    stage === "commercial_discussion" ||
    stage === "distributor_approval"
  ) {
    switch (vantage) {
      case "management":
        return { label: "Approval required", tone: "danger", actionable: true };
      case "sales_manager":
        return stage === "management_review"
          ? { label: "Prepare for management review", tone: "warn", actionable: true }
          : { label: "Awaiting management decision", tone: "warn", actionable: false };
      case "salesman":
        return { label: "Awaiting management", tone: "muted", actionable: false };
      case "calling_desk":
        return NO_CALLING_DESK_ACTION;
      case "back_office":
        return NOTHING_OPERATIONAL;
    }
  }

  /* The rest of the distributor ladder: paperwork and stock, nobody's approval. */
  if (
    stage === "distributor_agreement" ||
    stage === "initial_stock_order" ||
    stage === "active_distributor"
  ) {
    if (vantage === "management") {
      return stage === "active_distributor"
        ? { label: "Appointed — nothing pending", tone: "muted", actionable: false }
        : MONITOR_DISTRIBUTOR;
    }
    if (vantage === "sales_manager") {
      switch (stage) {
        case "distributor_agreement":
          return { label: "Confirm agreement signed", tone: "brand", actionable: true };
        case "initial_stock_order":
          return { label: "Record initial stock order", tone: "brand", actionable: true };
        default:
          return { label: "Active distributor — bills directly", tone: "muted", actionable: false };
      }
    }
    if (vantage === "back_office" && stage === "initial_stock_order") {
      return { label: "Process initial stock order", tone: "warn", actionable: true };
    }
    return vantage === "calling_desk" ? NO_CALLING_DESK_ACTION : NOT_YOUR_LADDER;
  }

  switch (stage) {
    case "suspect":
    case "new":
      switch (vantage) {
        case "salesman":
          return { label: "Visit customer", tone: "brand", actionable: true };
        case "calling_desk":
          return {
            label: "Call to qualify basic requirement",
            tone: "brand",
            actionable: true,
          };
        case "sales_manager":
          return { label: "Suspect — no manager action yet", tone: "muted", actionable: false };
        case "management":
          return managementQuiet(facts);
        case "back_office":
          return NOTHING_OPERATIONAL;
      }
      break;

    case "prospect":
    case "contacted":
      switch (vantage) {
        case "salesman":
          return { label: "Awaiting manager verification", tone: "warn", actionable: false };
        case "calling_desk":
          return { label: "Verification call support", tone: "brand", actionable: true };
        case "sales_manager":
          return { label: "Verify prospect", tone: "danger", actionable: true };
        case "management":
          return managementQuiet(facts);
        case "back_office":
          /* §11.6 — GST is collected once and validated once, and the back
           * office is who validates it. It is the earliest thing they own on
           * the ladder, which is why this rung is not "nothing operational". */
          return { label: "Validate GST number", tone: "warn", actionable: true };
      }
      break;

    case "qualification":
    case "qualified":
      switch (vantage) {
        case "salesman":
          return { label: "Complete qualification visit", tone: "brand", actionable: true };
        case "calling_desk":
          return NO_CALLING_DESK_ACTION;
        case "sales_manager":
          return { label: "Review qualification", tone: "warn", actionable: true };
        case "management":
          return managementQuiet(facts);
        case "back_office":
          return NOTHING_OPERATIONAL;
      }
      break;

    case "sample_trial":
      switch (vantage) {
        case "salesman":
          return {
            label: "Deliver / confirm sample dispatch",
            tone: "brand",
            actionable: true,
          };
        case "calling_desk":
          return NO_CALLING_DESK_ACTION;
        case "sales_manager":
          return { label: "Sample out — awaiting receipt", tone: "muted", actionable: false };
        case "management":
          return managementQuiet(facts);
        case "back_office":
          /*
           * The false arm reads "dispatched — track it" and stays true of a
           * sample still waiting on its approval, which is the one case this
           * fork gained when the fact narrowed to `approved`. Tracking a
           * parcel that was never sent is a wasted minute; being told to SEND
           * one nobody approved is stock out of the godown on nobody's say-so,
           * and the two are not the same size of mistake.
           */
          return facts.sampleAwaitingDispatch
            ? { label: "Dispatch sample", tone: "danger", actionable: true }
            : { label: "Sample dispatched — track it", tone: "warn", actionable: true };
      }
      break;

    case "sample_received":
    case "sample_review":
      switch (vantage) {
        case "salesman":
          return { label: "Visit — discuss trial result", tone: "brand", actionable: true };
        case "calling_desk":
          return NO_CALLING_DESK_ACTION;
        case "sales_manager":
          return { label: "Review sample / trial", tone: "danger", actionable: true };
        case "management":
          return managementQuiet(facts);
        case "back_office":
          return NOTHING_OPERATIONAL;
      }
      break;

    case "negotiation":
      switch (vantage) {
        case "salesman":
          return { label: "Negotiation visit", tone: "brand", actionable: true };
        case "calling_desk":
          return NO_CALLING_DESK_ACTION;
        case "sales_manager":
          /* §3.4 and §11.5 — the fork this whole distinction exists for. A
           * commitment on file and no order is money left on the table, and
           * the danger tone is what surfaces exactly those leads on a list of
           * four hundred. Without one there is a conversation to support and
           * nothing yet to close. */
          return facts.hasCommitment && !facts.hasOrder
            ? { label: "Confirm actual order", tone: "danger", actionable: true }
            : { label: "Support negotiation", tone: "warn", actionable: true };
        case "management":
          return managementQuiet(facts);
        case "back_office":
          return NOTHING_OPERATIONAL;
      }
      break;

    case "first_order":
      switch (vantage) {
        case "salesman":
          return { label: "Confirm order with customer", tone: "brand", actionable: true };
        case "calling_desk":
          return NO_CALLING_DESK_ACTION;
        case "sales_manager":
          return { label: "Monitor delivery", tone: "muted", actionable: false };
        case "management":
          return managementQuiet(facts);
        case "back_office":
          return { label: "Process order for dispatch", tone: "danger", actionable: true };
      }
      break;

    case "delivery":
      switch (vantage) {
        case "salesman":
          return { label: "Courtesy visit", tone: "muted", actionable: false };
        case "calling_desk":
          return NO_CALLING_DESK_ACTION;
        case "sales_manager":
          return { label: "Monitor payment follow-up", tone: "muted", actionable: false };
        case "management":
          return managementQuiet(facts);
        case "back_office":
          return { label: "Track delivery", tone: "warn", actionable: true };
      }
      break;

    case "payment":
      switch (vantage) {
        case "salesman":
          return { label: "Courtesy visit", tone: "muted", actionable: false };
        case "calling_desk":
          return NO_CALLING_DESK_ACTION;
        case "sales_manager":
          return { label: "Monitor payment follow-up", tone: "warn", actionable: true };
        case "management":
          return managementQuiet(facts);
        case "back_office":
          return { label: "Payment follow-up", tone: "danger", actionable: true };
      }
      break;

    case "second_order":
      switch (vantage) {
        case "salesman":
          return { label: "Repeat-order visit", tone: "brand", actionable: true };
        case "calling_desk":
          /*
           * §7 PUTS A DASH HERE AND IT IS RIGHT, though a repeat-order call is
           * a calling-desk job by any other reading — which is what made this
           * cell wrong for a while. Two mechanisms chase a repeat order and
           * they are not one mechanism. The CRM's Call Log times a stock check
           * and an order chase off the customer's OWN measured buying cycle,
           * on the account rather than on the lead, and by this rung
           * `promotesToCustomerAt` has long since flipped `kind` — so the shop
           * is already on that cadence, with a quiet window and a cooldown
           * deciding when it is rung. A verb here would be a second
           * instruction about one shop on one afternoon, off a ladder the
           * office is not working. §7 scopes the calling desk "strictly to
           * intake, never to the field or commercial workflow", and §10.4
           * leaves a repeat-order call on the Communication tab for any role
           * at any stage, so nothing is taken from a telecaller who wants to
           * make one.
           */
          return NO_CALLING_DESK_ACTION;
        case "sales_manager":
          return { label: "Repeat-order call", tone: "warn", actionable: true };
        case "management":
          return managementQuiet(facts);
        case "back_office":
          return NOTHING_OPERATIONAL;
      }
      break;

    /* §5.9 and §6.8 — the two terminal successes, and the hand-off is the
     * point. This product's job ends here by design; the account belongs to
     * the Call Log from now on. Nobody is given a verb. */
    case "customer":
      return {
        label: "Converted — now on the regular Call Log",
        tone: "muted",
        actionable: false,
      };
    case "won":
      return { label: "Won — no action", tone: "muted", actionable: false };
  }

  return NOT_YOUR_LADDER;
}

/**
 * §7's companion: whether this lead belongs on this vantage's work queue.
 *
 * Deliberately NOT a second reading of the ladder. It asks `roleAction` and
 * believes the answer, because a lead a vantage is given no verb for is a lead
 * that vantage has no business being shown — and two functions each deciding
 * "is this mine" is how a dashboard count and the list under it come to
 * disagree.
 *
 * It answers about the WORDS only. Whose book a lead is on is
 * `ASSIGNED_TO_SQL` and the seat expressions beside it, and this can only ever
 * narrow what those already allow — the same trade territory makes.
 */
export function isOnQueueFor(facts: LeadActionFacts, vantage: LeadVantage): boolean {
  return roleAction(facts, vantage).actionable;
}
