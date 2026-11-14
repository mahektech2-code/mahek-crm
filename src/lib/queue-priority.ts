/* ---------------------------------------------------------------------------
 * What counts as "high priority" on the calling queue: a broken promise, a
 * debt gone overdue, or a customer a full cycle past due — the same set
 * `queue-screen.tsx`'s REASON_TONE already draws in red. One definition, so
 * the Call Log and the EOD report cannot come to call two different things
 * "high priority".
 *
 * Pure, client-safe.
 * ------------------------------------------------------------------------- */

export const HIGH_PRIORITY_REASON_KINDS = [
  "paymentOverdue",
  "reminderOverdue",
  "orderOverdueFullCycle",
] as const;

export function isHighPriority(reasons: Array<{ kind: string }>): boolean {
  return reasons.some((r) => (HIGH_PRIORITY_REASON_KINDS as readonly string[]).includes(r.kind));
}
