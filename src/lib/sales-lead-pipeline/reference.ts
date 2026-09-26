/**
 * Static vocabulary, transcribed verbatim from the prototype's own source
 * (lead-pipeline.html — https://claude.ai/artifact/55h5EhgTReQbiThhdhPxRU).
 * Kept as one file, separate from the engine, because it is content rather
 * than logic: a manager rewording a reason list should not have to touch
 * anything that computes a stage or a KPI.
 */
import type { Stage, SalesType } from "./types";

export const PEOPLE_LIST = [
  { id: "amit", name: "Amit Deshmukh", initials: "AD", role: "sales_manager" as const },
  { id: "rahul", name: "Rahul Kulkarni", initials: "RK", role: "salesman" as const },
  { id: "sunil", name: "Sunil Patil", initials: "SP", role: "salesman" as const },
  { id: "meera", name: "Meera Joshi", initials: "MJ", role: "salesman" as const },
];

export const PROSPECT_REASONS = [
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
];

export const LOST_REASONS = [
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
];

/**
 * Eight conditions, matching the prototype's own "Salesman Process Manual
 * v1.0 Section 5" comment. Monthly Requirement, Monthly Potential, Product
 * and Competitor are deliberately absent — they are captured at Prospect
 * Conversion and read from there rather than re-asked here.
 */
export const QUALIFICATION_CONDITIONS = [
  { id: "gst_verified", says: "Get their GST number — Back Office validates it, not you" },
  { id: "application_understood", says: "Get the precise technical detail for the trial (Visit 1 already has the broad picture)" },
  { id: "price_discussed", says: "Talk about price, or at least a range" },
  { id: "credit_days", says: "Ask what credit they need" },
  { id: "delivery_discussed", says: "State our standard delivery timeline and confirm it works for them" },
  { id: "authorized_buyer", says: "Confirm the buyer, only if different from the Decision Maker already on record" },
  { id: "agrees_to_test", says: "Reconfirm they'll try it, now that price/credit/delivery are on the table" },
  { id: "next_step_agreed", says: "Agree what happens if the trial goes well" },
];

export const COMMS_ACTIONS = [
  { code: "call", label: "Call customer", icon: "phone" },
  { code: "company_profile", label: "Send company profile", icon: "doc" },
  { code: "product_image", label: "Send product image", icon: "eye" },
  { code: "brochure", label: "Send brochure", icon: "book" },
  { code: "price_list", label: "Send price list", icon: "rupee" },
  { code: "sample_followup", label: "Sample follow-up", icon: "clipboard" },
  { code: "negotiation_call", label: "Negotiation call", icon: "chat" },
  { code: "ask_first_order", label: "Ask for first order", icon: "target" },
  { code: "payment_followup", label: "Payment follow-up", icon: "wallet" },
  { code: "repeat_order", label: "Repeat-order call", icon: "history" },
];

export const SAMPLE_REASONS = [
  "Customer requested it",
  "Compare against competitor / current product",
  "Validate quality or performance before ordering",
  "New application",
  "Other",
];

export const ORDER_BLOCKERS = [
  "Price issue",
  "Credit issue",
  "Competitor issue",
  "Delivery issue",
  "No blocker",
];

export const DIRECT_LADDER: Stage[] = [
  "suspect", "prospect", "qualification", "sample_trial", "sample_received",
  "sample_review", "negotiation", "first_order", "delivery", "payment",
  "second_order", "customer",
];
export const THIRD_PARTY_LADDER: Stage[] = [
  "suspect", "prospect", "qualification", "sample_trial", "sample_review",
  "negotiation", "first_order", "delivery", "payment", "second_order", "customer",
];
export const DISTRIBUTOR_LADDER: Stage[] = [
  "suspect", "prospect", "qualification", "management_review",
  "commercial_discussion", "distributor_approval", "distributor_agreement",
  "initial_stock_order", "active_distributor",
];

export const STAGE_LABEL: Record<Stage, string> = {
  suspect: "Suspect",
  prospect: "Prospect",
  qualification: "Qualification",
  sample_trial: "Sample / Trial",
  sample_received: "Sample Received",
  sample_review: "Sample Review",
  negotiation: "Negotiation",
  first_order: "1st Order",
  delivery: "Delivery",
  payment: "Payment",
  second_order: "2nd Order",
  customer: "Customer",
  management_review: "Management Review",
  commercial_discussion: "Commercial Discussion",
  distributor_approval: "Distributor Approval",
  distributor_agreement: "Distributor Agreement",
  initial_stock_order: "Initial Stock Order",
  active_distributor: "Active Distributor",
};

export const VERIFICATION_RESULT_LABEL: Record<string, string> = {
  verified: "Verified",
  verified_with_corrections: "Verified With Corrections",
  followup_required: "Follow-Up Required",
  verification_failed: "Verification Failed",
};

export function ladderFor(salesType: SalesType): Stage[] {
  if (salesType === "distributor") return DISTRIBUTOR_LADDER;
  if (salesType === "third_party") return THIRD_PARTY_LADDER;
  return DIRECT_LADDER;
}

export function personName(id: string | undefined): string {
  return PEOPLE_LIST.find((p) => p.id === id)?.name ?? "—";
}

export function personInitials(id: string | undefined): string {
  return PEOPLE_LIST.find((p) => p.id === id)?.initials ?? "—";
}
