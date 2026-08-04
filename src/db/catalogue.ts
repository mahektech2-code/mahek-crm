/**
 * The product catalogue and the quick-note lists.
 *
 * Both are seeded into tables rather than read from here at runtime. Quick
 * notes especially: the lists below came to us labelled "examples", which
 * means they are a draft. A manager adds "Diwali stock booking" in October by
 * editing a row, not by waiting for a deploy — so this file is the shipped
 * starting point and the table is the source of truth.
 */

export type SeedProduct = {
  name: string;
  packSize: string | null;
  externalCode: string;
};

/** Named in the source document, plus the rest of Mahek's catalogue. */
export const PRODUCTS: SeedProduct[] = [
  { name: "Mahek Universal Thinner", packSize: "5L", externalCode: "MUT-5" },
  { name: "Mahek Universal Thinner", packSize: "20L", externalCode: "MUT-20" },
  { name: "Mahek Universal Thinner", packSize: "200L", externalCode: "MUT-200" },
  { name: "NC Thinner", packSize: "5L", externalCode: "NC-5" },
  { name: "NC Thinner", packSize: "20L", externalCode: "NC-20" },
  { name: "NC Thinner", packSize: "200L", externalCode: "NC-200" },
  { name: "MTO Thinner", packSize: "20L", externalCode: "MTO-20" },
  { name: "MTO Thinner", packSize: "200L", externalCode: "MTO-200" },
  { name: "PU Thinner", packSize: "5L", externalCode: "PU-5" },
  { name: "PU Thinner", packSize: "20L", externalCode: "PU-20" },
  { name: "Low-odour Thinner", packSize: "20L", externalCode: "LOT-20" },
  { name: "Epoxy Thinner", packSize: "20L", externalCode: "EPX-20" },
  { name: "Acetone", packSize: "20L", externalCode: "ACE-20" },
  { name: "Toluene", packSize: "200L", externalCode: "TOL-200" },
  { name: "Mineral Turpentine Oil", packSize: "200L", externalCode: "MTUR-200" },
  { name: "White Petrol", packSize: "20L", externalCode: "WP-20" },
];

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
    labels: [
      "Comparing competitor rates",
      "Stock available",
      "Price high",
      "Needs approval",
      "Will order later",
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
    "not_interested",
  ],
  inbound_call: [
    "order_taken",
    "payment_promised",
    "follow_up",
    "complaint",
    "transport_follow_up",
    "casual_talk",
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
