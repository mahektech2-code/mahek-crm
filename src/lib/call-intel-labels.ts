/**
 * WHAT THE CALL ASSISTANT CAN SAY HAPPENED, and the words for it.
 *
 * The assistant listens to what a telecaller says about a call and proposes
 * the form that call would have produced. It never writes anything: every
 * suggestion lands in a form the telecaller reads and saves, which is the
 * client's whole rule ("Speak → AI understands → AI opens the correct screen →
 * AI fills details → telecaller checks → save") and the only honest shape for
 * something that is guessing from speech.
 *
 * PURE and client-safe, like `call-outcomes` beside it: the card that renders
 * a suggestion runs in the browser and the service that produces it is
 * `server-only`, and a vocabulary typed twice is two vocabularies.
 *
 * An INTENT is not an outcome. A call has exactly one outcome — the column the
 * EOD counts read — and may carry several intents: a customer who promises a
 * payment AND complains about a leaking drum is two pieces of work on one
 * call. The intent list is what was said; `INTENT_OUTCOME` says which of
 * them the call is filed as, and everything else is a secondary action with a
 * door of its own.
 */

export const CALL_INTENTS = [
  "order_received",
  "opportunity",
  "complaint",
  "not_interested",
  "no_order",
  "sample_required",
  "payment_promised",
  "no_answer",
  "follow_up",
  "transport_follow_up",
  "casual_talk",
] as const;

export type CallIntent = (typeof CALL_INTENTS)[number];

export const CALL_INTENT_LABEL: Record<CallIntent, string> = {
  order_received: "Order received",
  opportunity: "Opportunity",
  complaint: "Complaint",
  not_interested: "Not interested",
  no_order: "No order today",
  sample_required: "Sample required",
  payment_promised: "Payment promised",
  no_answer: "No answer",
  follow_up: "Follow-up required",
  transport_follow_up: "Delivery / transport update",
  casual_talk: "Relationship call",
};

/**
 * Which call outcome each intent is FILED as, when it is the main thing that
 * happened.
 *
 * Two intents have no outcome of their own and borrow the follow-up, which is
 * the truthful one: an opportunity is somebody saying "maybe next week", and a
 * sample request is a trial that has to come back before anything is decided —
 * in both the call ends with something we are waiting for, and the follow-up's
 * own "what are we waiting for" list already has the words.
 */
export const INTENT_OUTCOME: Record<CallIntent, string> = {
  order_received: "order_taken",
  opportunity: "follow_up",
  complaint: "complaint",
  not_interested: "not_interested",
  no_order: "no_order",
  sample_required: "follow_up",
  payment_promised: "payment_promised",
  no_answer: "no_answer",
  follow_up: "follow_up",
  transport_follow_up: "transport_follow_up",
  casual_talk: "casual_talk",
};

/**
 * When several intents are present, which one the call is filed as.
 *
 * An order outranks everything because it is the thing the EOD counts are for.
 * A complaint outranks money because a complaint left as a secondary action is
 * one somebody forgets to raise, while a payment date survives as a reminder
 * either way. No answer sits last among the real ones: it cannot co-occur with
 * anything a customer said, and if the model reports both it has misheard.
 */
export const INTENT_PRECEDENCE: CallIntent[] = [
  "order_received",
  "complaint",
  "not_interested",
  "payment_promised",
  "sample_required",
  "opportunity",
  "no_order",
  "follow_up",
  "transport_follow_up",
  "no_answer",
  "casual_talk",
];

/**
 * How sure the assistant is about one suggestion, in the three states the
 * screen draws differently.
 *
 * `ready` — the form can be opened filled in and the telecaller checks it.
 * `confirm` — something was not clear, and the card ASKS rather than fills.
 *   The client's rule is "if AI is not sure, ask the telecaller; do not
 *   guess", and a field left blank with a question beside it is the only form
 *   of that rule a screen can keep.
 * `duplicate` — a record like this already exists, and creating another is the
 *   thing the client asked us not to do. The card names the existing one.
 */
export type SuggestionState = "ready" | "confirm" | "duplicate";

export const SUGGESTION_STATE_LABEL: Record<SuggestionState, string> = {
  ready: "Filled in — check it",
  confirm: "Needs you to confirm",
  duplicate: "Already on record",
};

/** Words for where a date came from, shown beside every date the card fills. */
export type DateSource = "said" | "rule" | "default";

/**
 * On a call THEY made, why they rang — asked by the form before the outcome.
 *
 * Proposed from the intent where the intent answers it plainly; left for the
 * telecaller where it does not. WHO picked up the phone is never proposed:
 * nothing in "they want 20 cans" says whether that was the owner or the store
 * boy, and a guess there would be filed as a fact about the customer.
 */
export const INTENT_CALL_REASON: Partial<Record<CallIntent, string>> = {
  order_received: "place_order",
  opportunity: "product_enquiry",
  complaint: "complaint",
  sample_required: "product_enquiry",
  payment_promised: "payment_outstanding",
  follow_up: "followup_previous",
  transport_follow_up: "delivery_transport",
};
