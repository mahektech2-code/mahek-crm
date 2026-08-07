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

/** Exactly the thirteen lists from the brief, in the order given. */
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
    outcome: "no_order",
    // §3 — the six structured reasons. Single-select, so these are mutually
    // exclusive answers to "why not", not notes that stack. The five they
    // replaced are deactivated rather than deleted, in the same migration:
    // historical interactions still point at them and must keep resolving.
    labels: [
      "Stock sufficient",
      "Price issue",
      "Will order later",
      "Not interested",
      "Buying elsewhere",
      "Business slow",
    ],
  },
  {
    interactionType: "outbound_call",
    outcome: "no_answer",
    labels: ["Phone rang", "Busy", "Switched Off", "No Response", "Call Disconnected"],
  },
  {
    interactionType: "outbound_call",
    outcome: "payment_promised",
    labels: ["Payment Tomorrow", "Cheque Ready", "NEFT Today", "Accounts Processing"],
  },
  {
    interactionType: "outbound_call",
    outcome: "follow_up",
    labels: ["Call Next Week", "Waiting for Approval", "Call After Stock Confirmation"],
  },
  {
    interactionType: "outbound_call",
    outcome: "not_interested",
    labels: ["Using another brand", "Business closed", "No requirement", "Price high"],
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
    outcome: "follow_up",
    labels: ["Call next week", "Waiting for quotation", "Waiting for approval"],
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
    interactionType: "inbound_call",
    outcome: "casual_talk",
    labels: [
      "Relationship Call",
      "Festival Greetings",
      "General Discussion",
      "Product Enquiry",
      "Business Discussion",
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

export const COMPLAINT_CATEGORY_LABEL: Record<string, string> = {
  product_quality: "Product Quality",
  packaging_damage: "Packaging Damage",
  dispatch_delay: "Dispatch Delay",
  billing_issue: "Billing Issue",
  delivery: "Delivery",
  pricing: "Pricing",
  service: "Service",
  shortage: "Shortage",
  other: "Other",
};
