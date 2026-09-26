/**
 * WHAT THE VISIT ASSISTANT CAN SAY HAPPENED IN A SHOP, and the words for it.
 *
 * The CRM's call assistant (`call-intel-labels.ts`) reads a phone call; this
 * reads a visit. The rule is the same one: speak → the assistant understands →
 * it fills the visit and names the follow-ons → the salesman checks → Save.
 * Nothing it proposes reaches the ledger except through the visit screen's own
 * Save, pressed by the man standing in the shop.
 *
 * PURE and client-safe, like its call counterpart.
 *
 * An INTENT is not an outcome. A visit has one outcome — the chip the handset
 * files it under, which the office counts — and may carry several intents: a
 * shop that pays ₹20,000 AND orders ten cans is two pieces of work on one
 * visit, and each gets its own door.
 */

export const VISIT_INTENTS = [
  "order_taken",
  "payment_collected",
  "payment_promised",
  "complaint",
  "sample_required",
  "opportunity",
  "requirement_captured",
  "not_interested",
  "relationship",
  "owner_not_available",
  "shop_closed",
] as const;

export type VisitIntent = (typeof VISIT_INTENTS)[number];

export const VISIT_INTENT_LABEL: Record<VisitIntent, string> = {
  order_taken: "Order taken",
  payment_collected: "Payment collected",
  payment_promised: "Payment promised",
  complaint: "Complaint",
  sample_required: "Sample required",
  opportunity: "May order later",
  requirement_captured: "Requirement noted",
  not_interested: "Not interested",
  relationship: "Relationship visit",
  owner_not_available: "Owner not available",
  shop_closed: "Shop closed",
};

/**
 * The handset's seven outcome chips, by key — `mbos-app/src/data/fixtures.ts`
 * `OUTCOMES`. A test pins the two.
 */
export const VISIT_OUTCOMES = [
  "visited",
  "order",
  "payment",
  "complaint",
  "sample",
  "closed_now",
  "closed",
] as const;

export type VisitOutcome = (typeof VISIT_OUTCOMES)[number];

export const VISIT_OUTCOME_LABEL: Record<VisitOutcome, string> = {
  visited: "Visited",
  order: "Order taken",
  payment: "Payment collected",
  complaint: "Complaint",
  sample: "Sample required",
  closed_now: "Not available",
  closed: "Shop closed",
};

/**
 * Which chip each intent is FILED as when it is the main thing that happened.
 *
 * A promise, a maybe, a requirement and a "no" all file as Visited, because
 * that is the truthful chip: nothing was handed over and nothing was raised.
 * What they produce — the date to come back, the requirement on the lead —
 * is carried by the rest of the proposal rather than by a chip that would
 * claim more than happened.
 */
export const INTENT_VISIT_OUTCOME: Record<VisitIntent, VisitOutcome> = {
  order_taken: "order",
  payment_collected: "payment",
  payment_promised: "visited",
  complaint: "complaint",
  sample_required: "sample",
  opportunity: "visited",
  requirement_captured: "visited",
  not_interested: "visited",
  relationship: "visited",
  owner_not_available: "closed_now",
  shop_closed: "closed",
};

/**
 * When several intents are present, which one the visit is filed as.
 *
 * An order first, because it is what the day is counted in. Money handed over
 * next — a receipt with nothing on the visit saying so is cash nobody can find.
 * A complaint above a sample because a complaint left as a secondary action is
 * the one somebody forgets to log. The two "nobody here" outcomes are last:
 * they cannot sit beside anything a customer said, and hearing both means the
 * model misread the note.
 */
export const VISIT_INTENT_PRECEDENCE: VisitIntent[] = [
  "order_taken",
  "payment_collected",
  "complaint",
  "sample_required",
  "payment_promised",
  "opportunity",
  "requirement_captured",
  "not_interested",
  "relationship",
  "owner_not_available",
  "shop_closed",
];
