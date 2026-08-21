/**
 * What each kind of activity is called on a screen — PURE, and client-safe.
 *
 * A stored enum is not a label. `plan_stops` and `competitor_record` reach the
 * console as they are stored, and neither is a phrase anybody says out loud;
 * the way back cannot be derived from the entity type by replacing underscores
 * either, or "Plan stops" appears next to "Order" as though they were the same
 * kind of thing.
 *
 * Client-safe because the map that draws these runs in the browser, and it is
 * the same reason the feedback and library vocabularies live in their own
 * files rather than in a `server-only` service.
 */

const LABELS: Record<string, string> = {
  visit: "Visit",
  order: "Order",
  payment: "Payment collected",
  complaint: "Complaint",
  sample: "Sample given",
  lead: "Lead",
  task: "Task",
  expense: "Expense",
  attendance: "Check-in",
  customer: "Customer edited",
  approval: "Approval asked for",
  leave: "Leave request",
  plan_day: "Day agreed",
  plan_stops: "Shops picked",
};

export function activityLabel(entityType: string): string {
  return LABELS[entityType] ?? entityType.replace(/_/g, " ");
}

/**
 * Why there is no position on an activity that asked for one.
 *
 * "No location" would cover all three of these and tell somebody nothing about
 * which. A refused permission is a conversation with the salesman; a godown
 * with no signal is nobody's fault and needs no conversation at all.
 */
const REASONS: Record<string, string> = {
  denied: "Location permission was off on the handset",
  unavailable: "The phone could not get a fix — indoors, or no signal",
  off: "Recording where activities happen was switched off",
};

export function locationReason(reason: string | null): string | null {
  if (!reason) return null;
  return REASONS[reason] ?? "No position was recorded";
}

/**
 * How a position reads once its age is taken into account.
 *
 * Age is part of the reading exactly as accuracy is: four minutes is evidence
 * of where somebody stood, four hours is evidence of nothing. The threshold is
 * configuration rather than a constant here, because it is a judgement about
 * how fast a salesman moves and somebody may disagree with ours.
 */
export function positionAge(ageSeconds: number | null, staleAfterSeconds: number): string {
  if (ageSeconds == null) return "";
  if (ageSeconds <= 60) return "taken at the time";
  const minutes = Math.round(ageSeconds / 60);
  if (ageSeconds <= staleAfterSeconds) return `position ${minutes} min old`;
  if (minutes < 120) return `position ${minutes} min old — too old to place him`;
  return `position ${Math.round(minutes / 60)} h old — too old to place him`;
}
