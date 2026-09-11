/* ---------------------------------------------------------------------------
 * The enquiry vocabulary — stages, priorities and activity kinds — pure and
 * client-safe. Three screens (the list, the dashboard, the detail page) all
 * say the same thing about a stage; written out three times they would drift,
 * the same reasoning `next-step-labels.ts` and `complaint-labels.ts` already
 * follow for their own screens.
 * ------------------------------------------------------------------------- */

import type { Tone } from "@/components/ui/primitives";

export const ENQUIRY_STAGES = [
  "new",
  "contacted",
  "follow_up",
  "qualified",
  "converted",
  "closed",
] as const;
export type EnquiryStage = (typeof ENQUIRY_STAGES)[number];

export const STAGE_LABEL: Record<EnquiryStage, string> = {
  new: "New",
  contacted: "Contacted",
  follow_up: "Follow-up",
  qualified: "Qualified",
  converted: "Converted",
  closed: "Closed",
};

export const STAGE_TONE: Record<EnquiryStage, Tone> = {
  new: "brand",
  contacted: "neutral",
  follow_up: "warn",
  qualified: "brand",
  converted: "success",
  closed: "muted",
};

export function isTerminalStage(stage: EnquiryStage): boolean {
  return stage === "converted" || stage === "closed";
}

export const ENQUIRY_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type EnquiryPriority = (typeof ENQUIRY_PRIORITIES)[number];

export const PRIORITY_LABEL: Record<EnquiryPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const PRIORITY_TONE: Record<EnquiryPriority, Tone> = {
  low: "muted",
  normal: "neutral",
  high: "warn",
  urgent: "danger",
};

export const ENQUIRY_SOURCES = [
  "Website",
  "Instagram",
  "Facebook",
  "WhatsApp",
  "IndiaMART",
  "Google",
  "Manual",
  "Other",
] as const;

/** Labels for the fixed set of activity kinds this phase writes. The column itself stays free text, same as `timeline_events.eventType` — a new kind later needs no migration. */
export const ACTIVITY_LABEL: Record<string, string> = {
  received: "Enquiry received",
  viewed: "Enquiry viewed",
  assigned: "Assigned",
  reassigned: "Reassigned",
  unassigned: "Unassigned",
  stage_changed: "Stage changed",
  priority_changed: "Priority changed",
  customer_linked: "Customer linked",
  note: "Note added",
  order_linked: "Order linked",
  order_unlinked: "Order unlinked",
  reminder_created: "Follow-up scheduled",
};
