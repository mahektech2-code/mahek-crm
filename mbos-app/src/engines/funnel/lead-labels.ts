/**
 * The funnel's whole vocabulary, and it is PURE and CLIENT-SAFE.
 *
 * The forms that write these run in the browser and on a handset; the services
 * that read them are `server-only`. One file both can import is what stops the
 * lists being typed out a second time in a screen — and the half that drifts is
 * always the half somebody reads.
 *
 * A stored value is always a CODE, never a label. The lists below are defaults
 * that `lib/config/registry.ts` publishes as editable settings, so a manager can
 * reword "High monthly consumption" without a deploy — and a stored label would
 * stop resolving the moment they did.
 */

/* ------------------------------------------------------------------ types */

export type LeadStage =
  | "new"
  | "contacted"
  | "qualified"
  | "negotiation"
  | "won"
  | "lost"
  /**
   * §—: main's own rung, and it is NOT on any of the three ladders.
   *
   * A live prospect that has stopped moving — a plant shutdown, a budget
   * quarter, a decision maker abroad — which is genuinely different from
   * `lost`, where nobody rings again. It is a PARK: the lead keeps its place in
   * the world and loses its place on the ladder, because the stage column can
   * only hold one value and this one displaces the rung.
   *
   * That is why `bandOf` cannot answer for it and `gateForNext` refuses: the
   * rung it was parked FROM is in `lead_stage_transitions`, not in the stage.
   * See `isParked`.
   */
  | "on_hold"
  | "suspect"
  | "prospect"
  | "qualification"
  | "sample_trial"
  | "sample_received"
  | "sample_review"
  | "first_order"
  | "delivery"
  | "payment"
  | "second_order"
  | "customer"
  | "management_review"
  | "commercial_discussion"
  | "distributor_approval"
  | "distributor_agreement"
  | "initial_stock_order"
  | "active_distributor";

export type LeadSalesType = "direct" | "distributor" | "third_party";

export type SampleState =
  | "requested"
  | "approved"
  | "rejected"
  | "dispatched"
  | "received"
  | "trial_done"
  | "reviewed"
  | "cancelled";

export type CodedOption = { code: string; label: string };

/* ----------------------------------------------------------- sales types */

/**
 * The question asked before anything else on a new lead.
 *
 * The sentence under each is what a salesman standing outside a shop reads to
 * choose, so it names the CHAIN rather than defining the term: "who ends up
 * holding the invoice" is answerable on a doorstep, and "third party" is not.
 */
export const SALES_TYPES: readonly {
  code: LeadSalesType;
  label: string;
  hint: string;
  /**
   * Withdrawn from every picker, and kept here so the leads already on this
   * ladder go on reading correctly — the same shape a retired pay outcome
   * takes in `payment-followup-service.ts`, and for the same reason: a stored
   * value is a CODE and never a label, so a type that stops being OFFERED must
   * not stop being RESOLVABLE, or every record carrying it starts reading
   * "Not set" on the day the option was withdrawn.
   */
  retired?: true;
}[] = [
  {
    code: "direct",
    label: "Direct customer",
    hint: "We sell to them and we invoice them.",
  },
  {
    /**
     * MAHEK'S OWN DECISION, and it was taken because this track had no end.
     *
     * Choosing it started a lead up a nine-rung ladder running through a
     * management review, a commercial discussion and a two-step appointment
     * approval — and Mahek does not appoint distributors through MahekOne, so
     * nobody ever walked to the end of one. What that cost was not an unused
     * feature, which would have been harmless: it was leads parked half way up
     * a ladder behind a gate nobody in the building had the authority to open,
     * indistinguishable on every screen from leads somebody was working.
     *
     * NOTHING IS DELETED AND NOTHING IS MIGRATED. Every lead already on this
     * ladder keeps its rung, its gates, its Distributor Profile, its approval
     * chain and its ability to advance; the whole of the change is that it is
     * no longer OFFERED for a new one. Deleting the code instead would have
     * rewritten their history rather than stopping new ones —
     * `salesTypeLabel` would answer "Not set" on exactly the records that most
     * need explaining, `ladderFor` would drop them onto the legacy six rungs,
     * and the thirty answers underneath them would stop being the ones their
     * gates read.
     *
     * If distributor appointments are ever formalised, deleting the single
     * `retired: true` line below turns it back on everywhere at once.
     */
    retired: true,
    code: "distributor",
    label: "Distributor",
    hint: "They buy from us and sell it on. The job is to appoint them.",
  },
  {
    code: "third_party",
    label: "Third-party customer",
    hint: "The goods go to them, a distributor gets the invoice.",
  },
] as const;

export function salesTypeLabel(t: LeadSalesType | null | undefined): string {
  return SALES_TYPES.find((s) => s.code === t)?.label ?? "Not set";
}

/**
 * What a picker may put in front of somebody raising a lead TODAY.
 *
 * `SALES_TYPES` stays the whole vocabulary, because everything that reads a
 * lead which already EXISTS — the board's ladder chips, the label on a card,
 * the query parameter that picks a board — has to go on knowing about a
 * retired one. This answers the other question, and only the forms that WRITE
 * a sales type ask it: the intake form, the bulk file, and the handset's own
 * two sheets.
 */
export function offeredSalesTypes(): { code: LeadSalesType; label: string; hint: string }[] {
  return SALES_TYPES.filter((s) => !s.retired).map(({ code, label, hint }) => ({
    code,
    label,
    hint,
  }));
}

/**
 * May a lead be STARTED on this ladder, or moved onto it?
 *
 * Read by the server doors rather than by a screen, because a server action is
 * a URL and a picker that no longer draws a chip is not a rule. It says
 * nothing about a lead already on that ladder, which is a different question
 * and is asked where the answer matters.
 */
export function salesTypeIsOffered(t: LeadSalesType): boolean {
  return SALES_TYPES.some((s) => s.code === t && !s.retired);
}

/* ---------------------------------------------------------------- stages */

/**
 * A short name and a sentence for every rung.
 *
 * The short one goes in a chip and a table cell; the long one is what the
 * record page says under the heading. Both exist because "Sample review" in a
 * 90px column and "The customer has tried it and we are waiting to hear what
 * they thought" on a record are the same rung read at two different distances.
 */
const STAGE_TEXT: Record<LeadStage, { short: string; long: string }> = {
  /* the original six */
  new: { short: "New", long: "Raised, and nobody has been to see them yet." },
  contacted: { short: "Contacted", long: "Somebody has spoken to them." },
  qualified: { short: "Qualified", long: "There is a real opportunity here." },
  negotiation: { short: "Negotiation", long: "Talking about quantity, price and terms." },
  won: { short: "Won", long: "They became an account." },
  lost: { short: "Lost", long: "Closed, with the reason recorded." },
  on_hold: {
    short: "On hold",
    long: "Still live, but not moving — and the reason is on the record.",
  },

  /* the customer ladders */
  suspect: {
    short: "Suspect",
    long: "Worth a look. Two visits to find out whether there is anything here, three at the outside.",
  },
  prospect: {
    short: "Prospect",
    long: "A genuine opportunity, and the sales manager is now on it too.",
  },
  qualification: {
    short: "Qualification",
    long: "Answering what has to be known before we give anybody a sample.",
  },
  sample_trial: {
    short: "Sample / trial",
    long: "A sample has been asked for. Approval, dispatch and delivery all sit here.",
  },
  sample_received: {
    short: "Sample received",
    long: "It reached them. Now they have to actually try it.",
  },
  sample_review: {
    short: "Sample review",
    long: "Chasing what they thought of it, and writing down the answer.",
  },
  first_order: {
    short: "1st order",
    long: "They have ordered. From here they are an account on the book.",
  },
  delivery: { short: "Delivery", long: "Following the material until they have it." },
  payment: { short: "Payment", long: "Following the money on the agreed terms." },
  second_order: {
    short: "2nd order",
    long: "They have come back. The relationship is real rather than a trial.",
  },
  customer: {
    short: "Customer",
    long: "A repeat buyer. Retention, upselling and satisfaction from here.",
  },

  /* the distributor ladder */
  management_review: {
    short: "Management review",
    long: "The sales manager has put them up for appointment.",
  },
  commercial_discussion: {
    short: "Commercial discussion",
    long: "Discount, credit limit, territory and what they commit to.",
  },
  distributor_approval: {
    short: "Approval",
    long: "Management has appointed them. They are billable from here.",
  },
  distributor_agreement: {
    short: "Agreement",
    long: "The paperwork is signed and on file.",
  },
  initial_stock_order: {
    short: "Initial stock",
    long: "The first stock order they committed to.",
  },
  active_distributor: {
    short: "Active distributor",
    long: "Appointed, stocked and selling.",
  },
};

/**
 * Every rung there is, in ladder order, for a control that has to OFFER one.
 *
 * Derived from the same record the labels come from rather than typed out
 * beside it — a second list is a list that loses the twenty-fourth rung the day
 * somebody adds it, and the half that drifts is the half a screen renders.
 * Nothing here says a rung is REACHABLE: `ladderFor` answers which ladder a
 * lead is on and `lead-gates` answers whether it may move, and both are asked
 * after somebody has picked, never instead of offering the pick.
 */
export const ALL_LEAD_STAGES = Object.keys(STAGE_TEXT) as LeadStage[];

export function stageLabel(stage: LeadStage): string {
  return STAGE_TEXT[stage]?.short ?? stage;
}

export function stageSentence(stage: LeadStage): string {
  return STAGE_TEXT[stage]?.long ?? "";
}

/* ------------------------------------------------------- §5 why a prospect */

/**
 * §5 — the ten answers to "why are you converting this Suspect?"
 *
 * A dropdown rather than a text box, and ten rather than an open list, because
 * the question exists to stop a salesman promoting a shop he happened to walk
 * past. A free-text field answers that question with "good potential" every
 * time, which is not an answer and cannot be counted.
 */
export const PROSPECT_REASONS: readonly CodedOption[] = [
  { code: "regular_requirement", label: "Confirmed regular requirement" },
  { code: "high_consumption", label: "High monthly consumption or potential" },
  { code: "agreed_trial", label: "Customer agreed to a product trial" },
  { code: "switching_competitor", label: "Interested in switching from a competitor" },
  { code: "specific_requirement", label: "Specific product or application requirement" },
  { code: "price_interest", label: "Price or commercial interest" },
  { code: "quality_interest", label: "Quality or performance interest" },
  { code: "significant_potential", label: "New customer with significant potential" },
  { code: "requested_quotation", label: "Asked for a price or a quotation" },
  { code: "other_genuine", label: "Other genuine business opportunity" },
] as const;

/* ------------------------------------------------------- §10 why a sample */

/** §10 — the ten answers to "why does this customer want a trial?" */
export const SAMPLE_REASONS: readonly CodedOption[] = [
  { code: "requested", label: "Customer asked for a sample" },
  { code: "compare_competitor", label: "Wants to compare it with a competitor" },
  { code: "validate_quality", label: "Wants to check quality and performance" },
  { code: "considering_switch", label: "Considering switching from a competitor" },
  { code: "specific_application", label: "Has a specific product or application need" },
  { code: "test_before_order", label: "Wants to test before a first order" },
  { code: "immediate_requirement", label: "Has an immediate requirement" },
  { code: "commercial_evaluation", label: "Commercial or product evaluation" },
  { code: "agreed_after_explanation", label: "Agreed to a trial after we explained it" },
  { code: "other_genuine", label: "Other genuine trial opportunity" },
] as const;

/* ---------------------------------------------------------- §26 why lost */

/**
 * §26 — the ten reasons a lead closes, and none of them is "no reason".
 *
 * `stageRefusal` on the handset and the server action both already refuse a
 * loss with nothing said. What changes here is that the answer is a code, so
 * "how many did we lose on credit terms this quarter" is a question somebody
 * can actually ask.
 */
export const LOST_REASONS: readonly CodedOption[] = [
  { code: "price", label: "Price" },
  { code: "quality", label: "Quality or performance" },
  { code: "competitor", label: "Stayed with a competitor" },
  { code: "no_requirement", label: "No requirement" },
  { code: "credit_terms", label: "Credit terms" },
  { code: "delivery_service", label: "Delivery or service" },
  { code: "not_interested", label: "Customer not interested" },
  { code: "wrong_lead", label: "Wrong lead — should not have been raised" },
  /**
   * §8 — ITS OWN CODE, AND DELIBERATELY NOT `wrong_lead`.
   *
   * Mahek's instruction, and the reason is that the two are different
   * situations wearing one word. `wrong_lead` is somebody at Mahek raising
   * something that was never a lead — a duplicate typed twice, a supplier
   * filed as a customer. This is the verification CALL finding that the
   * opportunity the salesman reported is not there.
   *
   * Folded together, "how many did the verification call kill this quarter"
   * could not be asked, and the answer to "how many leads should never have
   * been raised" would silently include every shop that denied a visit.
   */
  { code: "verification_failed", label: "Verification failed" },
  { code: "territory_conflict", label: "Distributor or territory conflict" },
  { code: "other", label: "Other" },
] as const;

/**
 * §8 — WHY THE VERIFICATION CALL FOUND NOTHING, which is a second question.
 *
 * The loss reason says the call killed it; this says what the call actually
 * found, and Mahek asked for it because the two together are the report:
 * "Verification failed — 18" is a number, and "customer denied the visit — 6,
 * wrong business — 4, duplicate — 3" is something somebody can act on. Six of
 * those seven answers point at a different fix — one is a salesman problem,
 * one is a data problem, one is an intake problem.
 *
 * A CODE, like every reason list here, so it can be counted rather than
 * grepped. Demanded whenever the outcome is taken, because a failure with no
 * finding behind it is the number without the breakdown.
 *
 * WHAT IS NOT IN THIS LIST, on Mahek's explicit instruction: a customer who
 * did not answer the phone. That is not a failed verification, it is an
 * unfinished one, and it stays `follow_up` — folding it in here would make
 * every one of these counts read high and mean nothing.
 */
/** The one loss code §8's third outcome ever writes. Never the manager's pick. */
export const VERIFICATION_FAILED_CODE = "verification_failed";

export const VERIFICATION_FAILURE_REASONS: readonly CodedOption[] = [
  { code: "denies_visit", label: "Customer denies the visit" },
  { code: "denies_enquiry", label: "Customer denies the enquiry" },
  { code: "no_such_business", label: "Business or shop does not exist" },
  { code: "wrong_contact", label: "Wrong contact or wrong business" },
  { code: "duplicate", label: "Duplicate lead" },
  { code: "false_information", label: "False or inaccurate information" },
  { code: "other", label: "Other" },
] as const;

/**
 * §— WHY A LEAD WAS PARKED. Mahek's six.
 *
 * Parking already demanded a sentence, and a sentence cannot answer "how many
 * genuine opportunities are we parking a quarter, and for what" — which is the
 * question that tells Mahek whether the pipeline is stalling on its customers
 * or on itself. Four of these six are the customer's doing and two are ours to
 * chase, and that split is the whole value of counting them.
 *
 * `other` demands the remarks. A code meaning "something else" with nothing
 * behind it is the one row nobody can act on, and it is the code people reach
 * for when a list does not fit — so it has to cost a sentence.
 */
export const HOLD_REASONS: readonly CodedOption[] = [
  { code: "customer_decision_delayed", label: "Customer decision delayed" },
  { code: "budget_issue", label: "Budget or financial issue" },
  { code: "shutdown", label: "Plant or business shutdown" },
  { code: "decision_maker_away", label: "Decision maker unavailable" },
  { code: "requirement_inactive", label: "Requirement temporarily not active" },
  { code: "other", label: "Other" },
] as const;

/**
 * §5.5 §9 — WHAT IS STOPPING THE FIRST ORDER, asked as the commitment is taken.
 *
 * A commitment is a day and a size and the one thing that would stop it, and
 * the third is the half that is worth anything a fortnight later: "they will
 * order 40 cans on the 12th" is a forecast, and "they will order 40 cans on the
 * 12th once we agree the credit" is a forecast with somebody's name on the
 * work. Coded for the reason every other list here is coded — "how much did we
 * forecast behind credit terms this quarter" is a question somebody can ask,
 * and a grep over free text is not.
 *
 * `no_blocker` is FIRST and is the default, because it is the ordinary answer
 * and a list whose default is an obstacle teaches a salesman to record one. It
 * is a real answer rather than an empty field: a commitment nobody attached a
 * blocker to and a commitment somebody said was clear are different facts, and
 * only the second says anybody was asked.
 *
 * Five, and the four that are not `no_blocker` are deliberately the four
 * different DESKS a stalled first order lands on — ours to price, ours to
 * allow, the godown's to fill, theirs to sign off. A list that mixed them
 * would count into one number four problems with four owners.
 */
export const ORDER_BLOCKERS: readonly CodedOption[] = [
  { code: "no_blocker", label: "No blocker" },
  { code: "price_not_agreed", label: "Price not agreed" },
  { code: "credit_terms", label: "Credit terms not settled" },
  { code: "stock_availability", label: "Stock or availability" },
  { code: "customer_approval_pending", label: "Waiting on their own approval" },
] as const;

/**
 * §— WHY A TRIAL WAS CALLED OFF. Mahek's eight.
 *
 * The reason for coding this one is sharper than for most: these eight
 * separate THREE DIFFERENT PROBLEMS that a free-text box could not tell apart.
 * A product we could not source is a supply problem; a customer who stopped
 * answering is a customer problem; a price objection is a sales problem. All
 * three read as "trial cancelled" until somebody can count them, and each one
 * is somebody else's to fix.
 *
 * `other` demands the remarks, for the reason above.
 */
export const SAMPLE_CANCEL_REASONS: readonly CodedOption[] = [
  { code: "product_unavailable", label: "Product not available" },
  { code: "requirement_cancelled", label: "Customer cancelled the requirement" },
  { code: "customer_delayed", label: "Customer delayed the trial" },
  { code: "not_required", label: "Sample not required any more" },
  { code: "wrong_product", label: "Wrong product or wrong requirement" },
  { code: "commercial", label: "Commercial or price issue" },
  { code: "no_response", label: "Customer not responding" },
  { code: "other", label: "Other" },
] as const;

/** The one code in either list that demands a sentence after it. */
export const REASON_CODE_NEEDING_REMARKS = "other";

/**
 * WHOSE PROBLEM EACH OF THE EIGHT IS — which is the whole reason there are
 * eight rather than a box.
 *
 * Counting cancellations by code is only half of what the list buys. Eight
 * numbers on a screen is a list; the ANSWER is that they fall into three
 * groups, and each group is a different person's morning — a product we could
 * not source sends somebody to the factory, a shop that stopped answering
 * sends the salesman back to the door, and a price objection is a conversation
 * about the price list. "Trials cancelled: 14" named none of those three,
 * which is exactly what one free-text column cost.
 *
 * It is a map from CODE to group rather than a fourth field on each option,
 * because the list itself is configuration — Mahek may reword "Commercial or
 * price issue" tomorrow without a deploy — while the grouping is a statement
 * about what a code MEANS, and a reworded label still means the same thing.
 *
 * A code nobody has grouped answers null and is counted on its own rather than
 * folded into whichever group sorted first: `other` is deliberately ungrouped,
 * since its whole definition is that it is none of these, and a code somebody
 * adds to the configured list later must not be quietly filed under a
 * department nobody chose for it.
 */
export type SampleCancelProblem = "supply" | "customer" | "sales";

export const SAMPLE_CANCEL_PROBLEM: Readonly<Record<string, SampleCancelProblem>> = {
  product_unavailable: "supply",
  wrong_product: "supply",
  requirement_cancelled: "customer",
  customer_delayed: "customer",
  not_required: "customer",
  no_response: "customer",
  commercial: "sales",
};

/** What each group is called on a screen, and what it points at. */
export const SAMPLE_CANCEL_PROBLEM_LABELS: Readonly<
  Record<SampleCancelProblem, { label: string; whose: string }>
> = {
  supply: {
    label: "Supply",
    whose: "We could not put the right stock in their hands.",
  },
  customer: {
    label: "Customer",
    whose: "The shop went quiet, delayed it, or no longer wants it.",
  },
  sales: {
    label: "Sales",
    whose: "The commercial conversation is what stopped it.",
  },
};

/** Which of the three a code belongs to, or null where nobody has said. */
export function sampleCancelProblemOf(
  code: string | null | undefined,
): SampleCancelProblem | null {
  if (!code) return null;
  return SAMPLE_CANCEL_PROBLEM[code] ?? null;
}

/* ---------------------------------------- why a manager overrode a gate */

/**
 * §28 allows the rule to be bent and insists it be named.
 *
 * A system that refuses everything is defeated in a week by people recording
 * work after the event, which is worse than the gate being open: the record
 * then says the process was followed when it was not. So an override is
 * offered, it is a manager's alone, and it stores what was still missing.
 */
export const OVERRIDE_REASONS: readonly CodedOption[] = [
  { code: "recorded_late", label: "It was done — recorded after the event" },
  { code: "known_account", label: "We already know this account well" },
  { code: "customer_urgency", label: "Customer will not wait" },
  { code: "not_applicable", label: "The condition does not apply to this account" },
  { code: "management_instruction", label: "Instructed by management" },
  { code: "other", label: "Other" },
] as const;

export function labelOf(list: readonly CodedOption[], code: string | null | undefined): string {
  if (!code) return "—";
  return list.find((o) => o.code === code)?.label ?? code;
}

/* ------------------------------------------- §8 the verification call */

/**
 * §8 — the twelve questions the sales manager asks the customer.
 *
 * The verdict on its own would be worth very little a month later. The value is
 * the answers: "which competitor did he say he was using" is exactly what
 * somebody needs before the negotiation call, and it is asked once, here, by
 * the person who rang.
 *
 * Two of them are about the SALESMAN rather than the sale, and they are the
 * reason the call exists at all — this is the check that the visit happened and
 * that Mahek was explained properly, which no amount of GPS proves.
 */
/**
 * §5.2 — THE SALESMAN'S FINDINGS, as a list rather than as nine literals in a
 * page.
 *
 * These are the things the salesman already recorded standing in the shop, and
 * the manager's job on the verification call is to confirm each one, correct
 * it, or say the customer could not confirm it. They are NOT
 * `VERIFICATION_QUESTIONS` above: those are the twelve things the call asks
 * fresh, and these are the answers somebody else already gave.
 *
 * It is a constant because three things read it and they must not drift — the
 * screen that draws the rows, the action that validates a correction arriving
 * from one, and `lead_verification_corrections`, whose whole purpose is that
 * "how many leads had their competitor corrected last quarter" be countable.
 * A field code typed into a screen and not into the validator is a correction
 * silently dropped on the way in, which reads afterwards as a manager who
 * never bothered.
 *
 * `lands` names the `mbos_lead_validations` column that holds the shop's own
 * answer, and SIX OF THE NINE HAVE NONE. That is a real gap and it is stated
 * rather than hidden: without a column those six are kept only as words in the
 * call's note. The corrections table is what makes the before/after pair
 * countable for all nine regardless, which is the half that was missing.
 */
export const VERIFICATION_FINDINGS: readonly {
  id: string;
  label: string;
  lands: string | null;
}[] = [
  { id: "competitor", label: "Whose product they use now", lands: "competitor" },
  { id: "monthly_litres", label: "What they use in a month", lands: "monthly_requirement" },
  { id: "potential", label: "What they could be worth in a month", lands: "potential" },
  { id: "required_product", label: "Which of ours they need", lands: null },
  { id: "contact_person", label: "Who we ask for when we ring", lands: null },
  { id: "decision_maker", label: "Who signs off a purchase", lands: null },
  { id: "credit_days", label: "The credit they want", lands: null },
  { id: "application", label: "What they will use it on", lands: null },
  { id: "customer_type", label: "What kind of business this is", lands: null },
] as const;

/** Whether a field code arriving from a screen is one of the nine. */
export function isVerificationFinding(id: string): boolean {
  return VERIFICATION_FINDINGS.some((f) => f.id === id);
}

/** The finding's own words, for a timeline sentence and for a summary card. */
export function findingLabel(id: string): string {
  return VERIFICATION_FINDINGS.find((f) => f.id === id)?.label ?? id;
}

/**
 * §5.2's FOUR SECTIONS, which is the shape the call is actually conducted in.
 *
 * The questions used to be a flat list of twelve and the two forms cut it with
 * `slice(0, 2)` — the first two are about the salesman, the rest about the
 * sale. That held while the list was twelve in that order and stopped holding
 * the moment a question was appended: "How did you find our man?" is the third
 * salesman question and sits at index seven, so the slice had already been
 * drawing it under the wrong heading. A section is a PROPERTY of the question
 * rather than a position in the array, because the array's order is what the
 * conversation takes and the heading is what the question is about.
 *
 * The headings are here and not typed into a screen for the reason every list
 * in this file is: the modal and the full page both draw them, and the half
 * that drifts is always the half somebody reads.
 */
export type VerificationSection = "salesman" | "opportunity" | "objections" | "readiness";

export const VERIFICATION_SECTIONS: readonly {
  id: VerificationSection;
  title: string;
  /** Why this section exists, in the one sentence a manager needs. */
  says: string;
}[] = [
  {
    id: "salesman",
    title: "About our man — this is why the call exists",
    says:
      "No amount of GPS proves that Mahek was explained properly. These are the questions a check on the salesman's own work cannot be performed by the salesman.",
  },
  {
    id: "opportunity",
    title: "About the opportunity",
    says: "Whether the requirement the salesman reported is real, and whose product it would replace.",
  },
  {
    id: "objections",
    title: "What is in the way",
    says:
      "Every one of these is a separate answer. “Fine on price, the credit is the problem” is the sentence that decides what we offer next, and it is unreadable where the only place it can land is a free-text impression.",
  },
  {
    id: "readiness",
    title: "What they are ready for",
    says:
      "The half the call exists to hand on. §5.4 decides whether a sample goes out, and it decides it on whether the SHOP said it was ready for a trial — which this call had no box for at all.",
  },
] as const;

/**
 * §5.2's questions, and FIVE OF THEM ARE NEW.
 *
 * Sections A and B were here from the day §8 shipped. Of section C — the
 * objections — only price, quality and service were, so a shop that is happy
 * with the price and stuck on the credit terms had nowhere to say so but the
 * free-text impression, where it is a sentence rather than something anybody
 * can count. `credit_concern` and `competitor_concern` are the PRD's other two.
 * Section D was missing entirely, which is the more serious of the two gaps:
 * the one call that authorises a sample could not record whether the customer
 * said they were ready for one.
 *
 * `quality_issue` is NOT in the PRD's five and it stays. It is a real objection
 * — a shop that has been burned by a thinner before says so on this call and
 * nowhere else — and dropping a question that has answers stored against it to
 * match a list of five would delete the answers rather than tidy the form.
 * Six objections, of which five are the PRD's.
 *
 * THE PRD CALLS C AND D MULTI-SELECTS AND THESE ARE TEXT, deliberately. The
 * three objections already here are text columns on `mbos_lead_validations`,
 * for the reason the schema states beside them: "he came but only for five
 * minutes" is the answer that matters and a tick cannot hold it. Storing the
 * two new objections as booleans beside three that are text would be one
 * question answered two ways on one row. What the multi-select actually buys is
 * that several may be true at once, and a column each is the stronger version
 * of that — "how many said credit was the problem" is `credit_concern is not
 * null`, countable, with the shop's own words beside the count. A ticked box
 * gives the count and nothing else.
 *
 * And the distinction that has to survive: a null column is nobody asked, and
 * an answered one is asked. "No concern on price" is a real answer that goes in
 * the box, exactly as the findings panel stores "Could not verify" as words
 * rather than as a blank. A boolean would have collapsed the two, because
 * `false` cannot tell "they have no credit problem" from "we never got to it".
 */
export const VERIFICATION_QUESTIONS: readonly {
  id: string;
  ask: string;
  section: VerificationSection;
}[] = [
  { id: "visited", ask: "Did our salesman actually visit?", section: "salesman" },
  { id: "explained", ask: "Did he explain Mahek properly?", section: "salesman" },
  { id: "impression", ask: "How did you find our man?", section: "salesman" },
  { id: "understood", ask: "Did you understand what the product does?", section: "opportunity" },
  { id: "current_product", ask: "What are you using at the moment?", section: "opportunity" },
  { id: "competitor", ask: "Whose product is it?", section: "opportunity" },
  { id: "monthly_requirement", ask: "How much do you use in a month?", section: "opportunity" },
  { id: "potential", ask: "Could that grow?", section: "opportunity" },
  {
    id: "genuine_interest",
    ask: "Are you genuinely interested in trying it?",
    section: "opportunity",
  },
  { id: "price_issue", ask: "Any concern about price?", section: "objections" },
  { id: "quality_issue", ask: "Any concern about quality?", section: "objections" },
  { id: "service_issue", ask: "Any concern about delivery or service?", section: "objections" },
  { id: "credit_concern", ask: "Any concern about the credit terms?", section: "objections" },
  {
    id: "competitor_concern",
    ask: "Anything holding them to whoever supplies them now?",
    section: "objections",
  },
  { id: "ready_for_trial", ask: "Are they ready to take a trial?", section: "readiness" },
  {
    id: "ready_for_commercial",
    ask: "Are they ready to talk rates and terms?",
    section: "readiness",
  },
  { id: "ready_for_order", ask: "Are they ready to talk about an order?", section: "readiness" },
] as const;

/** The questions of one section, in the order they are asked. */
export function questionsInSection(
  section: VerificationSection,
): readonly { id: string; ask: string; section: VerificationSection }[] {
  return VERIFICATION_QUESTIONS.filter((q) => q.section === section);
}

/**
 * WHERE EACH ANSWER LANDS IN `mbos_lead_validations`.
 *
 * Two teams built the verification call at once. This branch stored the twelve
 * answers as one jsonb blob on a `lead_manager_calls` table of its own; main
 * shipped first with named columns on `mbos_lead_validations`. One
 * implementation per concept, and main's is the survivor — so the
 * twelve-question FORM stays, because it is how the call is actually conducted,
 * and the answers land on main's row.
 *
 * EVERY ONE OF THE TWELVE IS ITS OWN COLUMN. Seven of them had no box on main's
 * table and the first cut of this wrote them into `notes` as labelled lines,
 * which is the jsonb blob again wearing a different coat: "how many of last
 * month's leads said price was the problem" is the question §8 exists to
 * answer, and `notes ilike '%price%'` is not an answer to it. `0116` adds the
 * seven. A column costs nothing and an unqueryable line costs the report.
 *
 * `confirmed_monthly_volume_litres` and `confirmed_potential_paise` are
 * deliberately NOT filled from this form. They are numbers on the owner's KPI
 * screens, the form collects a sentence — "about 15-20 tins, more in season" —
 * and a parser guessing at that would put a confident wrong figure where a
 * wrong figure does the most damage. The sentence goes to the text column
 * beside each, which is where it is true.
 *
 * `product_feedback` is untouched here, and that is not an oversight: §E asks
 * an existing customer what they think of our product, and §8 asks a shop that
 * has never bought whether they understood what it does. Same word, different
 * question, and folding them together would make the first unreadable.
 */
export const VERIFICATION_COLUMNS: Readonly<Record<string, string>> = {
  visited: "salesmanVisited",
  explained: "mahekExplained",
  understood: "productUnderstood",
  current_product: "currentProduct",
  competitor: "confirmedCompetitor",
  monthly_requirement: "confirmedRequirement",
  potential: "growthPotential",
  impression: "salesmanFeedback",
  price_issue: "priceConcern",
  quality_issue: "qualityFeedback",
  service_issue: "dispatchFeedback",
  genuine_interest: "genuineInterest",
  /* §5.2's C and D, added by `0157`. A column each rather than an array, for
     the argument beside `VERIFICATION_QUESTIONS` above: these sit next to
     three objections that are already columns, and a row that answers one
     question two ways is a row two screens will read differently. */
  credit_concern: "creditConcern",
  competitor_concern: "competitorConcern",
  ready_for_trial: "readyForTrial",
  ready_for_commercial: "readyForCommercial",
  ready_for_order: "readyForOrder",
};

/**
 * And the way back: main's row read as the twelve answers the form asked.
 *
 * The record page renders the questions in the order they were asked, so it
 * needs them keyed the way the form keyed them. One mapping, read from both
 * ends, because a screen holding its own copy of which column is which is a
 * screen that shows the price answer under the quality question the day
 * somebody adds a thirteenth.
 */
export function verificationAnswers(
  row: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const answers: Record<string, string> = {};
  if (!row) return answers;
  for (const [id, column] of Object.entries(VERIFICATION_COLUMNS)) {
    const value = row[column];
    if (typeof value === "string" && value.trim()) answers[id] = value.trim();
  }
  return answers;
}

/**
 * The verdict, read as the form's yes/no.
 *
 * Main's column carries four values and the form asks one question, so the
 * mapping is lossy in one direction only: `pending` and `on_hold` are neither a
 * pass nor a failure and answer NULL rather than false. A call left undecided
 * drawn as "could not verify" would put a follow-up's sentence on a screen
 * where nobody has decided anything yet.
 */
export function verificationVerdict(verdict: string | null): boolean | null {
  if (verdict === "confirmed") return true;
  if (verdict === "not_qualified") return false;
  return null;
}

/**
 * WHAT A VERIFICATION CALL CAN ESTABLISH, and the third answer is new.
 *
 * Two of these have been here since §8 shipped and their meanings do not move.
 * `verified` says the visit happened and Mahek was explained, and it is what
 * opens the gate to qualification. `follow_up` says THIS CALL could not confirm
 * the visit — which is a statement about our own salesman rather than about the
 * shop, so it closes nothing and puts a task back on his list. Marking a lead
 * dead on the strength of not having reached our own man would be the office
 * writing off a customer for an internal failure, and that argument is as good
 * today as it was the day it was written.
 *
 * `not_qualified` is a DIFFERENT statement and that is the whole reason it can
 * exist beside the other two: the OPPORTUNITY is false. The shop denies any
 * such visit or any such requirement, the business is not there, the contact
 * was made up, or somebody raised the row in error. Nothing about the salesman
 * being hard to reach belongs in it, and the screen says so before the button
 * is pressed, because the cost of the two being confused is a real shop closed
 * as lost on the strength of a bad afternoon on the phone.
 *
 * It is a LIST rather than three branches in a screen because both doors onto
 * this call — the full page and the modal — have to offer the same words for
 * the same act, and a sentence typed into one of them is the copy that drifts.
 */
export type VerificationOutcome = "verified" | "follow_up" | "not_qualified";

export const VERIFICATION_OUTCOMES: readonly {
  code: VerificationOutcome;
  /** The radio's own line, which is the whole of what most people read. */
  label: string;
  /** What it means and what it costs, said before the button is pressed. */
  says: string;
}[] = [
  {
    code: "verified",
    label: "Verified — the visit happened and Mahek was explained",
    says: "Opens the gate to qualification. Nothing else on this page does.",
  },
  {
    code: "follow_up",
    label: "Follow-up required — this call could not confirm the visit",
    says:
      "NOT a failure of the lead. What could not be confirmed is our salesman's visit, so this raises a task back on him with your own words on it and leaves the lead exactly where it is.",
  },
  {
    code: "not_qualified",
    label: "Verification failed — there is no opportunity here",
    says:
      "For a false opportunity ONLY: the shop denies any such visit or requirement, the business does not exist, the contact is fabricated, or this was raised in error. It CLOSES the lead as lost and asks you to say in writing what the shop said. A call that merely went badly, or a salesman you could not reach, is the answer above this one.",
  },
] as const;

/**
 * The outcome as `mbos_lead_validations.verdict` stores it.
 *
 * One function so the two forms and anything that reads the row back cannot
 * disagree about which word means which: a failed verification stored as
 * `pending` and a false opportunity stored as `pending` would be one column
 * saying two things, and `verificationVerdict` above — which the record page
 * reads — would draw both as undecided.
 */
export function verificationVerdictFor(
  outcome: VerificationOutcome,
): "confirmed" | "pending" | "not_qualified" {
  if (outcome === "verified") return "confirmed";
  if (outcome === "not_qualified") return "not_qualified";
  return "pending";
}

/**
 * §5.2's FOURTH RESULT, AND IT IS DERIVED RATHER THAN STORED.
 *
 * The PRD makes the call's result four-way, not three: a verification that
 * survived the phone untouched and one where the manager corrected three of the
 * salesman's figures are both "verified" today, and telling them apart is most
 * of why the four-way split is asked for. "How many of our salesmen's reports
 * stood up to the call" is the question, and it is unanswerable while both read
 * back as one word.
 *
 * IT IS NOT A FOURTH `VERIFICATION_OUTCOMES` ENTRY, and that is the decision
 * worth stating. The corrections are already stored and already countable, one
 * row per contradicted field in `lead_verification_corrections`; a stored
 * fourth outcome would be a SECOND statement of the same fact, written by a
 * radio button a manager pressed, sitting beside the rows it claims to
 * summarise and free to disagree with them. This codebase argues the same thing
 * about a handover being outstanding and about a third party with no
 * distributor: derive it, because the flag would be a cache with nothing
 * rebuilding it and the only facts it could be rebuilt from are the rows
 * underneath it.
 *
 * It is also not a JUDGEMENT, which is the other half. The three outcomes are
 * things a manager decides on the call — did the visit happen, is the
 * opportunity real. Whether he corrected anything is not a decision he makes,
 * it is a count of what he did, and offering it as a radio would let somebody
 * pick "verified with corrections" having recorded none, or pick plain
 * "verified" having recorded four.
 *
 * WHERE IT IS COUNTED: the corrections table, `verdict = 'corrected'` grouped by
 * `validation_id` — the index `lead_verification_corrections_verdict_idx`
 * already serves it. A call with no row there is a clean verification. Anything
 * reading a call back passes the count in here rather than deciding for itself
 * what the threshold is.
 */
export type VerificationResult = VerificationOutcome | "verified_with_corrections";

/**
 * The four-way result, from the call read back and how many findings the shop
 * contradicted.
 *
 * It takes `verificationVerdict`'s own tri-state rather than the raw column,
 * because that is the shape every reader of a call already holds — the record
 * page, `ManagerCall`, the qualification screen. Asking for the column here
 * would mean each of them keeping a second copy of which word means which, and
 * that mapping already exists one function up.
 *
 * `null` is a call that was made and left undecided, which reads as a
 * follow-up: it closes nothing and opens nothing, which is precisely what a
 * follow-up does.
 *
 * Only a VERIFIED call can carry the fourth word. A follow-up could not confirm
 * the visit and a failed verification found no opportunity, and on neither of
 * those does "and three figures were corrected" say anything about whether the
 * report stood up — the report was never accepted in the first place. The
 * corrections are still stored and still counted on both; what they do not do
 * is rename the outcome.
 */
export function verificationResultOf(
  verified: boolean | null,
  correctedCount: number,
): VerificationResult {
  if (verified === false) return "not_qualified";
  if (verified === null) return "follow_up";
  return correctedCount > 0 ? "verified_with_corrections" : "verified";
}

/**
 * The result's own words, for a row in a list and a pill on a record.
 *
 * The three that are also outcomes deliberately read back through
 * `VERIFICATION_OUTCOMES`, so a label reworded there moves everywhere rather
 * than in one of two places — the drift this file exists to prevent.
 */
export function verificationResultLabel(result: VerificationResult): string {
  if (result === "verified_with_corrections") return "Verified with corrections";
  return VERIFICATION_OUTCOMES.find((o) => o.code === result)?.label ?? result;
}

/* ------------------------------------------------- §16 the sample review */

/** §16 — the seven things a trial is asked about, six named and one open. */
export const FEEDBACK_FIELDS: readonly { id: string; label: string }[] = [
  { id: "quality", label: "Quality" },
  { id: "performance", label: "Performance" },
  { id: "application", label: "Application" },
  { id: "drying", label: "Drying" },
  { id: "competitorComparison", label: "Against what they use now" },
  { id: "priceFeedback", label: "Price" },
  { id: "otherComments", label: "Anything else" },
] as const;

/* --------------------------------------------------------- sample states */

const SAMPLE_STATE_TEXT: Record<SampleState, string> = {
  requested: "Asked for",
  approved: "Approved",
  rejected: "Refused",
  dispatched: "Sent",
  received: "Delivered",
  trial_done: "Tried",
  reviewed: "Reviewed",
  cancelled: "Cancelled",
};

export function sampleStateLabel(s: SampleState): string {
  return SAMPLE_STATE_TEXT[s] ?? s;
}

/* ---------------------------------------- §13 what the manager is chased for */

/**
 * §13 — the nurture sequence, as a table rather than fifteen `if`s.
 *
 * `after` is days from the event that triggers it. `owner` says whose task it
 * is, which matters because the salesman and the manager are chased for
 * different things about the same lead and a single list would read as one
 * person being nagged twice.
 *
 * `lib/engines/lead-nurture.ts` reads this; nothing else should.
 */
export type NurtureTrigger =
  | "prospect_created"
  | "salesman_visit"
  | "sample_requested"
  | "sample_dispatched"
  | "sample_received"
  | "sample_approved"
  | "negotiation"
  | "expected_order_date"
  | "order_received"
  | "delivery_completed"
  | "payment_due"
  | "expected_reorder";

export const NURTURE_SEQUENCE: readonly {
  trigger: NurtureTrigger;
  after: number;
  owner: "lead_manager" | "salesman";
  title: string;
  detail: string;
}[] = [
  {
    trigger: "prospect_created",
    after: 0,
    owner: "lead_manager",
    title: "Verify the customer and the salesman",
    detail: "Ring them and go through the twelve questions before anything else happens.",
  },
  {
    trigger: "prospect_created",
    after: 0,
    owner: "salesman",
    title: "Collect and verify GST",
    detail: "No sample goes out without it.",
  },
  {
    trigger: "salesman_visit",
    after: 1,
    owner: "lead_manager",
    title: "Verification call after the visit",
    detail: "Check what was discussed while it is fresh.",
  },
  {
    trigger: "prospect_created",
    after: 2,
    owner: "lead_manager",
    title: "Send the company profile",
    detail: "Who Mahek is, before they are asked to try anything.",
  },
  {
    trigger: "prospect_created",
    after: 4,
    owner: "lead_manager",
    title: "Send the product brochure and video",
    detail: "What it does, in their hands, ahead of the trial.",
  },
  {
    trigger: "sample_requested",
    after: 0,
    owner: "lead_manager",
    title: "Check the sample request",
    detail: "The right product, the right quantity, for the application they named.",
  },
  {
    trigger: "sample_dispatched",
    after: 2,
    owner: "lead_manager",
    title: "Check it is moving",
    detail: "A docket with no movement on it is a sample nobody will ever review.",
  },
  {
    trigger: "sample_received",
    after: 2,
    owner: "lead_manager",
    title: "Sample review call",
    detail: "Have they tried it, and what did they think?",
  },
  {
    trigger: "sample_approved",
    after: 0,
    owner: "lead_manager",
    title: "Call about the order",
    detail: "They liked it. Ask what they want and when.",
  },
  {
    trigger: "negotiation",
    after: 3,
    owner: "lead_manager",
    title: "Follow up the negotiation",
    detail: "What is still in the way?",
  },
  {
    trigger: "expected_order_date",
    after: 0,
    owner: "lead_manager",
    title: "Ask for the first order",
    detail: "Quantity, product, date. 'Interested' is not an answer.",
  },
  {
    trigger: "order_received",
    after: 1,
    owner: "lead_manager",
    title: "Follow the delivery",
    detail: "Until the material is with them.",
  },
  {
    trigger: "delivery_completed",
    after: 2,
    owner: "lead_manager",
    title: "Satisfaction call",
    detail: "Did it arrive right, and did it do what we said?",
  },
  {
    trigger: "payment_due",
    after: 0,
    owner: "lead_manager",
    title: "Payment follow-up",
    detail: "On the terms that were agreed.",
  },
  {
    trigger: "expected_reorder",
    after: 0,
    owner: "lead_manager",
    title: "Repeat-order call",
    detail: "Their own cycle says they are about due. Ask what they need.",
  },
] as const;

/* ------------------------------------------- §14 the communication buttons */

/**
 * §14 — eleven things a manager does from the lead page without hunting.
 *
 * `document` names the library category the button reaches for, where it sends
 * something; the rest are calls, which log the attempt and open the dialler.
 * The manager should not be searching a shared drive for the current price list
 * every time, which is what this replaces.
 */
export const COMMUNICATION_ACTIONS: readonly {
  code: string;
  label: string;
  kind: "call" | "send";
  document?: "company_profile" | "catalogue" | "marketing" | "product_video" | "price_list";
}[] = [
  { code: "call", label: "Call the customer", kind: "call" },
  { code: "company_profile", label: "Send the company profile", kind: "send", document: "company_profile" },
  { code: "product_image", label: "Send a product image", kind: "send", document: "marketing" },
  { code: "brochure", label: "Send the brochure", kind: "send", document: "catalogue" },
  { code: "video", label: "Send the video", kind: "send", document: "product_video" },
  { code: "price_list", label: "Send the price list", kind: "send", document: "price_list" },
  { code: "sample_followup", label: "Sample follow-up", kind: "call" },
  { code: "negotiation_call", label: "Negotiation call", kind: "call" },
  { code: "ask_first_order", label: "Ask for the first order", kind: "call" },
  { code: "payment_followup", label: "Payment follow-up", kind: "call" },
  { code: "repeat_order", label: "Repeat-order call", kind: "call" },
] as const;

/* ------------------------------------------------- §18 asking for the order */

/**
 * §18 — the eight questions, because "customer interested" is not a report.
 *
 * The specification is explicit that a manager recording interest has recorded
 * nothing. Each of these has an answer the customer can give on a phone call,
 * and the last four are the four things that actually stop an order.
 */
export const FIRST_ORDER_QUESTIONS: readonly { id: string; ask: string }[] = [
  { id: "quantity", ask: "How much?" },
  { id: "product", ask: "Which product?" },
  { id: "when", ask: "When will you place it?" },
  { id: "blocker", ask: "What is stopping it today?" },
  { id: "price_issue", ask: "Is price an issue?" },
  { id: "credit_issue", ask: "Is credit an issue?" },
  { id: "competitor_issue", ask: "Is a competitor in the way?" },
  { id: "delivery_issue", ask: "Is delivery an issue?" },
] as const;
