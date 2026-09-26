/**
 * Vocabulary the Sales Manager Lead Pipeline screens draw — labels and the
 * shape of the ladders, and nothing that pretends to be data.
 *
 * WHAT USED TO LIVE HERE AND DOES NOT ANY MORE: the four fictional people, the
 * prospect / lost / sample reasons and the order blockers (configuration —
 * `leads.*` in `app_settings`, read on the server and passed down as
 * `PipelineRefs`), and the eight qualification conditions (the real gate
 * engine's, per lead, in `Lead.qualItems`). A list a manager can reword without
 * a deploy has no business being typed into a screen.
 *
 * The LADDERS are the real engine's own (`engines/lead-ladder.ts`), imported
 * rather than copied, so a rung added there reaches this screen and a lead with
 * no sales type is drawn on the legacy ladder it actually climbs.
 */
import { ladderFor as engineLadderFor } from "@/lib/engines/lead-ladder";
import { COMMUNICATION_ACTIONS } from "@/lib/lead-labels";
import type { SalesType, Stage } from "./types";

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
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  won: "Won",
  on_hold: "On hold",
};

/** The three real ladders' rungs, from the engine — and the legacy one for a lead with no sales type. */
export function ladderFor(salesType: SalesType | null): Stage[] {
  return [...engineLadderFor(salesType)] as Stage[];
}

export const DIRECT_LADDER: Stage[] = ladderFor("direct");
export const DISTRIBUTOR_LADDER: Stage[] = ladderFor("distributor");

export const VERIFICATION_RESULT_LABEL: Record<string, string> = {
  verified: "Verified",
  verified_with_corrections: "Verified With Corrections",
  followup_required: "Follow-Up Required",
  verification_failed: "Verification Failed",
};

const COMMS_ICON: Record<string, string> = {
  call: "phone",
  company_profile: "doc",
  product_image: "eye",
  brochure: "book",
  video: "eye",
  price_list: "rupee",
  sample_followup: "clipboard",
  negotiation_call: "chat",
  ask_first_order: "target",
  payment_followup: "wallet",
  repeat_order: "history",
};

/** The company's communication actions, from the same list the real record page offers. */
export const COMMS_ACTIONS = COMMUNICATION_ACTIONS.map((a) => ({
  code: a.code,
  label: a.label,
  icon: COMMS_ICON[a.code] ?? "chat",
  /** A "send" names the library document that went; a "call" logs the attempt and needs none. */
  kind: a.kind,
  document: a.document,
}));

/** A person is carried as their name already; this only turns an empty one into a dash. */
export function personName(name: string | undefined | null): string {
  return name && name.trim() ? name : "—";
}
