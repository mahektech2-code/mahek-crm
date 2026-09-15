/**
 * The quick-note lists and the interaction vocabulary.
 *
 * Seeded into tables rather than read from here at runtime. The lists below
 * came to us labelled "examples", which means they are a draft. A manager adds
 * "Diwali stock booking" in October by editing a row, not by waiting for a
 * deploy — so this file is the shipped starting point and the table is the
 * source of truth.
 *
 * The product catalogue used to live here too, as sixteen placeholder rows. It
 * is now the real product master: generated into catalogue-seed.ts from the
 * source document and written by lib/services/catalogue-import.ts.
 */

export type InteractionTypeKey = "outbound_call" | "inbound_call" | "order_received";

export type OutcomeKey =
  | "order_taken"
  | "no_order"
  | "no_answer"
  | "payment_promised"
  | "follow_up"
  | "not_interested"
  | "complaint"
  | "transport_follow_up"
  | "casual_talk";

export type SeedQuickNote = {
  interactionType: InteractionTypeKey;
  outcome: OutcomeKey | null;
  labels: string[];
};

/*
 * SEVEN LISTS, AND FIVE OUTCOMES DELIBERATELY HAVE NONE.
 *
 * It was thirteen — the lists the brief gave. No Order, No Answer, Follow-up,
 * Not Interested and Casual Talk each ask a CODED question now
 * (`lib/call-outcomes.ts`), and the chips they carried were answers to that
 * same question in different words: "Price issue", "Stock sufficient", "Busy",
 * "Switched Off", "Call Next Week", "Using another brand", "Relationship Call".
 *
 * Keeping both made the telecaller answer twice and let the two DISAGREE — a
 * call coded `price_issue` carrying a "Business slow" chip is a record nobody
 * can read back, and neither half of it is wrong. A single-select chip list and
 * a single-select coded field are the same control asked twice.
 *
 * Where chips SURVIVE they answer nothing: "Cheque Ready", "Dispatch today",
 * "LR Shared", "Urgent delivery" are shorthand into the note a human reads,
 * which is what a quick note is for. That is the whole test for whether an
 * outcome should have them.
 *
 * The existing rows are DEACTIVATED by 0125 rather than deleted — historical
 * interactions hold their ids in `quick_note_ids`, and those references must
 * keep resolving to something a person can read.
 */
export const QUICK_NOTES: SeedQuickNote[] = [
  {
    interactionType: "outbound_call",
    outcome: "order_taken",
    labels: [
      "Customer confirmed order",
      "Repeat order",
      "Urgent delivery",
      "Rate accepted",
      "Payment on delivery",
    ],
  },
  {
    interactionType: "outbound_call",
    outcome: "payment_promised",
    labels: ["Payment Tomorrow", "Cheque Ready", "NEFT Today", "Accounts Processing"],
  },
  {
    interactionType: "inbound_call",
    outcome: "order_taken",
    labels: [
      "Customer called to place order",
      "Repeat monthly order",
      "Urgent delivery",
      "Dispatch today",
    ],
  },
  {
    interactionType: "inbound_call",
    outcome: "payment_promised",
    labels: ["Payment Today", "Cheque Ready", "NEFT Today", "Accounts Processing"],
  },
  {
    interactionType: "inbound_call",
    outcome: "complaint",
    labels: ["Leakage", "Wrong Material", "Damaged Product", "Delivery Delay"],
  },
  {
    interactionType: "inbound_call",
    outcome: "transport_follow_up",
    labels: [
      "Shipment In Transit",
      "LR Shared",
      "Vehicle Not Dispatched",
      "Driver Contact Shared",
      "Delivery Tomorrow",
    ],
  },
  {
    interactionType: "order_received",
    outcome: null,
    labels: [
      "Order received via WhatsApp",
      "Order received via ERP",
      "Purchase Order Received",
      "Repeat Monthly Order",
      "Urgent Dispatch",
      "Delivery Required Today",
    ],
  },
];

/** Which outcomes are legal for which interaction type. Enforced server-side. */
export const OUTCOMES_BY_TYPE: Record<InteractionTypeKey, OutcomeKey[]> = {
  outbound_call: [
    "order_taken",
    "no_order",
    "no_answer",
    "payment_promised",
    "follow_up",
    // A complaint is not something the customer has to ring in to make. Half
    // of them come out when we call to ask for the next order, and a
    // telecaller with nowhere to put it either loses it or files it as a note.
    "complaint",
    "transport_follow_up",
    "casual_talk",
    "not_interested",
  ],
  inbound_call: [
    "order_taken",
    // An enquiry that ended in nothing, and a customer who rang to say they
    // are done buying, both happen on calls we did not make. Only "no answer"
    // stays outbound-only: they are on the line.
    "no_order",
    "payment_promised",
    "follow_up",
    "complaint",
    "transport_follow_up",
    "casual_talk",
    "not_interested",
  ],
  order_received: [],
};

/** The words people see. The design owns these; the enum is internal. */
export const TYPE_LABEL: Record<InteractionTypeKey, string> = {
  outbound_call: "We Called Them",
  inbound_call: "They Called Us",
  order_received: "Order Received",
};

export const OUTCOME_LABEL: Record<OutcomeKey, string> = {
  order_taken: "Order Taken",
  no_order: "No Order",
  no_answer: "No Answer",
  payment_promised: "Payment Promised",
  follow_up: "Follow-up",
  not_interested: "Not Interested",
  complaint: "Complaint",
  transport_follow_up: "Transport Follow-up",
  casual_talk: "Casual Talk",
};
