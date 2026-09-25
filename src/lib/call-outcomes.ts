/**
 * WHAT EACH OUTCOME ASKS FOR.
 *
 * `lib/call-reasons.ts` answers why the customer RANG, which is an inbound
 * question. This answers what a call NEEDS once somebody knows how it ended —
 * and that applies whichever way the call went, because the things that make a
 * No Order worth recording are the same whether we rang them or they rang us.
 *
 * It exists because "Quick notes plus a free-text box" was the whole of what
 * seven of the nine outcomes collected. Quick notes are a good thing and stay:
 * they are the telecaller's shorthand into the note. What they cannot be is
 * the ANSWER — they are multi-select, they are edited by managers, they carry
 * no required-ness, and two of them can be picked at once, so "why did we lose
 * this order" had no single value to count. Everything here is a code with
 * exactly one answer where the question has one.
 *
 * PURE and client-safe, like `call-reasons` beside it, and for the same
 * reason: the form runs in a browser and `saveInteraction` is `server-only`,
 * so the only way the rule and the screen cannot drift is for both to read
 * this file.
 */

import type { ReasonField } from "./call-reasons";

/* ------------------------------------------------------------- no order */

/**
 * WHY NO ORDER — ten, and one answer.
 *
 * The six quick notes this supersedes are kept and still offered: they write
 * words into the note, which is what a human reads back. This is the value a
 * REPORT reads, and it is single-select because "price issue and buying
 * elsewhere and business slow" is three answers to a question that has one —
 * and a figure built by counting multi-select chips is one nobody can add up.
 */
export const NO_ORDER_REASONS = [
  { code: "not_required", label: "Not required currently" },
  { code: "buying_elsewhere", label: "Buying elsewhere" },
  { code: "price_issue", label: "Price issue" },
  { code: "stock_available", label: "Stock available" },
  { code: "business_slow", label: "Business slow" },
  { code: "will_order_later", label: "Will order later" },
  { code: "quality_issue", label: "Quality issue" },
  { code: "credit_issue", label: "Credit / payment issue" },
  { code: "competitor_offer", label: "Competitor offer" },
  { code: "other", label: "Other" },
] as const;

/* ------------------------------------------------------------ no answer */

/**
 * WHY NO ANSWER — five, and deliberately the only question this outcome asks
 * beyond a note.
 *
 * Nobody spoke to anybody. A form of any size here is a form a telecaller
 * working down a list of forty fills in at speed and stops reading, and the
 * one field that matters is which KIND of silence it was: a switched-off phone
 * is a number worth checking and a rejected call is a customer avoiding us.
 *
 * `connection_status` on `calls` held exactly this once — rang, busy, switched
 * off — and was retired when the EOD count moved onto the outcome. The
 * vocabulary comes back here as a code, where it is asked rather than derived.
 */
export const NO_ANSWER_REASONS = [
  { code: "no_response", label: "No response" },
  { code: "busy", label: "Busy" },
  { code: "switched_off", label: "Switched off" },
  { code: "out_of_network", label: "Out of network" },
  { code: "call_rejected", label: "Call rejected" },
  /*
   * Not in the brief's five, and kept because the quick note it replaces was.
   * "Call Disconnected" has been on the No Answer chips since the CRM shipped
   * and it is a different fact from a rejected call — one is the customer
   * declining and the other is the network — so deactivating that chip without
   * this would silently lose an answer telecallers already give.
   */
  { code: "call_disconnected", label: "Call disconnected" },
] as const;

/* ------------------------------------------------------------- follow-up */

/**
 * WHAT WE ARE WAITING FOR.
 *
 * The first three were the existing quick notes and are kept word for word, so
 * nothing a telecaller already knows changes. The eight added are all the same
 * shape — a named thing somebody is waiting on — and that is the point: "when
 * do we call back" was answerable and "why is this call not an order yet" was
 * not, which is the question a manager asks about a follow-up three weeks old.
 */
export const FOLLOW_UP_REASONS = [
  { code: "call_next_week", label: "Call next week" },
  { code: "waiting_sample_approval", label: "Waiting for sample approval" },
  /* From the inbound follow-up chips this replaces — a quotation somebody is
     waiting on is not the same as a price approval somebody is waiting for. */
  { code: "waiting_quotation", label: "Waiting for quotation" },
  { code: "waiting_stock_confirmation", label: "Call after stock confirmation" },
  { code: "waiting_decision_maker", label: "Waiting for decision maker" },
  { code: "waiting_price_approval", label: "Waiting for price approval" },
  { code: "waiting_requirement", label: "Waiting for customer requirement" },
  { code: "waiting_payment", label: "Waiting for payment" },
  { code: "waiting_stock", label: "Waiting for stock" },
  { code: "waiting_sample", label: "Waiting for sample" },
  { code: "waiting_management_approval", label: "Waiting for management approval" },
  { code: "customer_asked_later", label: "Customer asked to call later" },
] as const;

/* ----------------------------------------------------------- casual talk */

/**
 * WHAT THE CALL WAS FOR, and nothing else is asked.
 *
 * A relationship call is real work and recording it should cost one tap. The
 * one open box beside it is there because the single most valuable thing on a
 * call like this is a sentence nobody went looking for — a competitor's rate, a
 * plant shutting for a fortnight — and it has never had anywhere to go except
 * the note, where nothing reads it back.
 */
export const CASUAL_TALK_PURPOSES = [
  { code: "relationship", label: "Relationship building" },
  { code: "customer_feedback", label: "Customer feedback" },
  { code: "business_update", label: "Business update" },
  { code: "personal_greeting", label: "Personal greeting" },
  { code: "festival", label: "Festival / birthday" },
  { code: "market_information", label: "Market information" },
  { code: "competitor_information", label: "Competitor information" },
  { code: "other", label: "Other" },
] as const;

/* -------------------------------------------------------- not interested */

/**
 * WHY NOT INTERESTED — the analytical heart of the outbound form.
 *
 * A lost customer with no coded reason is a customer nobody learns anything
 * from, and this is the one outcome where the record IS the whole value: the
 * call produced no order, no promise and no complaint. Ten, single-select, for
 * the same reason the No Order list is.
 */
export const NOT_INTERESTED_REASONS = [
  { code: "price_too_high", label: "Price too high" },
  { code: "buying_competitor", label: "Buying from a competitor" },
  { code: "quality_not_suitable", label: "Quality not suitable" },
  { code: "no_requirement", label: "No current requirement" },
  { code: "business_closed", label: "Customer closed business" },
  { code: "credit_terms", label: "Credit terms not suitable" },
  { code: "product_not_suitable", label: "Product not suitable" },
  { code: "existing_supplier", label: "Existing supplier relationship" },
  { code: "permanently_not_interested", label: "Permanently not interested" },
  { code: "other", label: "Other" },
] as const;

/** The one answer that asks a second question. Named, never matched inline. */
export const BUYING_COMPETITOR = "buying_competitor";

/**
 * IS THERE A LATER, and the third answer is a standing instruction.
 *
 * `possible_later` takes a date and becomes a reminder. `no` is this call
 * closing and nothing more. `never` is the customer asking not to be rung
 * again — which is `customers.do_not_contact`, a real standing instruction
 * that outranks every reason the queue can produce, so it is deliberately the
 * last option, worded as the customer's own request, and confirmed on the
 * screen before it is written.
 */
export const FUTURE_OPPORTUNITY = [
  { code: "possible_later", label: "Possible later" },
  { code: "no", label: "No" },
  { code: "never", label: "They asked us not to call again" },
] as const;

export const NEVER_CALL_AGAIN = "never";

/* ----------------------------------------------------------- complaints */

/*
 * A COMPLAINT'S PRIORITY IS NOT HERE, and that is deliberate.
 *
 * Normal / Urgent / Critical belongs to PR #358 (`complaint-vocabulary`), along
 * with the ten headings and the label-to-enum mapping — and its version is the
 * better one: it gives `severity` a `critical` member of its own rather than
 * folding four meanings onto three levels, and it recomputes the SLA from when
 * the complaint was RAISED when somebody reclassifies it late, which is the
 * true thing to say about a three-day-old complaint that turns out to be
 * critical.
 *
 * Two branches writing one vocabulary is two vocabularies, and the half that
 * drifts is the half somebody reads. What this file keeps is the part that PR
 * does not have: what the customer is ASKING FOR, which is what routes the
 * complaint to a desk.
 */

/**
 * WHAT THE CUSTOMER IS ASKING FOR, and who that lands on.
 *
 * `complaints.assigned_to` is a free-text department that has defaulted to
 * "Operations" on every complaint ever raised — which is not a routing
 * decision, it is the absence of one. The action IS the routing: a replacement
 * is the godown's, a credit note is accounts', a technical visit is technical.
 * So the desk is derived from the action rather than asked as a second
 * question the telecaller has no way to answer.
 */
export const COMPLAINT_ACTIONS = [
  { code: "replacement", label: "Replacement", desk: "Dispatch" },
  { code: "credit_note", label: "Credit note", desk: "Accounts" },
  { code: "technical_visit", label: "Technical visit", desk: "Technical" },
  { code: "sales_visit", label: "Sales visit", desk: "Sales" },
  { code: "transport_check", label: "Transport check", desk: "Logistics" },
  { code: "accounts_check", label: "Accounts check", desk: "Accounts" },
  { code: "management", label: "Management intervention", desk: "Management" },
] as const;

/**
 * The desk an action lands on, or null where the action is not one of ours.
 *
 * Null rather than "Operations": the default is what this replaces, and
 * falling back to it would quietly reintroduce the thing that made every
 * complaint look routed when none of them was.
 */
export function deskForAction(action: string | null | undefined): string | null {
  return COMPLAINT_ACTIONS.find((a) => a.code === action)?.desk ?? null;
}

/* ------------------------------------------------------- what each asks */

/**
 * The questions an outcome asks, in the same shape `reasonFieldsFor` uses — so
 * the panel renders both through one component and the server validates both
 * through one loop.
 */
const OUTCOME_FIELDS: Record<string, ReasonField[]> = {
  payment_promised: [
    /*
     * HOW MUCH, beside the date the form already asked. Optional: a customer
     * who says "I will clear it Friday" has promised a day and not a figure,
     * and refusing the save over a number nobody said would lose the date.
     * Where it is given it rides into the reminder's note, which is what the
     * person ringing on Friday reads first.
     */
    {
      key: "promisedAmount",
      label: "Amount promised (₹)",
      kind: "number",
      hint: "Whole rupees, as they said it. Leave it empty if they named no figure.",
    },
  ],
  no_order: [
    {
      key: "whyNoOrder",
      label: "Why no order",
      kind: "choice",
      required: true,
      options: NO_ORDER_REASONS,
    },
  ],
  no_answer: [
    {
      key: "whyNoAnswer",
      label: "Why no answer",
      kind: "choice",
      required: true,
      options: NO_ANSWER_REASONS,
      hint: "Which kind of silence it was. A switched-off phone is a number worth checking; a rejected call is a customer avoiding us.",
    },
  ],
  follow_up: [
    {
      key: "followUpReason",
      label: "What are we waiting for",
      kind: "choice",
      required: true,
      options: FOLLOW_UP_REASONS,
    },
  ],
  casual_talk: [
    /*
     * OPTIONAL, and that is the brief's own instruction: a relationship call
     * should stay extremely simple and not force a telecaller through a form.
     * Every other outcome here demands its coded answer because a report is
     * built on it; nobody is measured on why somebody rang to wish them a happy
     * Diwali, so the tap is offered and never required.
     */
    {
      key: "purpose",
      label: "Purpose",
      kind: "choice",
      options: CASUAL_TALK_PURPOSES,
    },
    {
      key: "customerFeedback",
      label: "Anything worth knowing",
      kind: "text",
      hint: "A competitor's rate, a plant shutting for a fortnight — the sentence nobody would have gone looking for.",
    },
  ],
  not_interested: [
    {
      key: "whyNotInterested",
      label: "Why not interested",
      kind: "choice",
      required: true,
      options: NOT_INTERESTED_REASONS,
    },
    /* Shown only where the answer above is "buying from a competitor" — the
       panel decides that, because a field that is required in one branch and
       absent in another cannot be expressed as a flag on the field itself. */
    { key: "competitorName", label: "Which competitor", kind: "text" },
    {
      key: "futureOpportunity",
      label: "Is there a later",
      kind: "choice",
      required: true,
      options: FUTURE_OPPORTUNITY,
    },
    { key: "recallDate", label: "Call them again on", kind: "date" },
  ],
  complaint: [
    {
      key: "requiredAction",
      label: "What they are asking for",
      kind: "choice",
      required: true,
      options: COMPLAINT_ACTIONS,
      hint: "This is what routes it — a replacement goes to dispatch, a credit note to accounts.",
    },
  ],
};

export function outcomeFieldsFor(outcome: string | null | undefined): ReasonField[] {
  if (!outcome) return [];
  return OUTCOME_FIELDS[outcome] ?? [];
}

/**
 * Which of an outcome's fields are asked at all, given what has been answered
 * so far.
 *
 * Two of them are conditional and neither can say so on the field itself: the
 * competitor name belongs to one answer of the question above it, and the
 * recall date belongs to one answer of the question below. Drawing both always
 * asks a customer's competitor about a customer who said they have no
 * requirement, and a required flag that is only sometimes true is exactly the
 * state `lead-gates` exists to stop being expressed.
 */
export function outcomeFieldsVisible(
  outcome: string | null | undefined,
  answers: Record<string, string>,
): ReasonField[] {
  return outcomeFieldsFor(outcome).filter((f) => {
    if (f.key === "competitorName") {
      return answers.whyNotInterested === BUYING_COMPETITOR;
    }
    if (f.key === "recallDate") return answers.futureOpportunity === "possible_later";
    return true;
  });
}

/**
 * And which of the visible ones must be answered.
 *
 * The two conditionals are required WHEN THEY ARE ASKED — a recall date is the
 * entire content of "possible later", and "possible later, no date" is the
 * state that makes a lapsed customer invisible for ever. The competitor name
 * is not: a telecaller is often told "somebody cheaper" and no more, and
 * refusing the save over it would lose the reason to win the name.
 */
export function outcomeFieldRequired(
  field: ReasonField,
  answers: Record<string, string>,
): boolean {
  if (field.key === "recallDate") return answers.futureOpportunity === "possible_later";
  if (field.key === "competitorName") return false;
  return Boolean(field.required);
}
