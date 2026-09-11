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
export const SALES_TYPES: readonly { code: LeadSalesType; label: string; hint: string }[] = [
  {
    code: "direct",
    label: "Direct customer",
    hint: "We sell to them and we invoice them.",
  },
  {
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
  { code: "territory_conflict", label: "Distributor or territory conflict" },
  { code: "other", label: "Other" },
] as const;

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
export const VERIFICATION_QUESTIONS: readonly { id: string; ask: string }[] = [
  { id: "visited", ask: "Did our salesman actually visit?" },
  { id: "explained", ask: "Did he explain Mahek properly?" },
  { id: "understood", ask: "Did you understand what the product does?" },
  { id: "current_product", ask: "What are you using at the moment?" },
  { id: "competitor", ask: "Whose product is it?" },
  { id: "monthly_requirement", ask: "How much do you use in a month?" },
  { id: "potential", ask: "Could that grow?" },
  { id: "impression", ask: "How did you find our man?" },
  { id: "price_issue", ask: "Any concern about price?" },
  { id: "quality_issue", ask: "Any concern about quality?" },
  { id: "service_issue", ask: "Any concern about delivery or service?" },
  { id: "genuine_interest", ask: "Are you genuinely interested in trying it?" },
] as const;

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
