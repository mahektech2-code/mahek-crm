/* ---------------------------------------------------------------------------
 * "RECENTLY" — a lead raised in the last few calendar days.
 *
 * PURE and client-safe, and it takes the lead's AGE IN DAYS rather than a date:
 * `ageDays` is `business day - created_at's IST day`, worked out in SQL with
 * the zone named (`leadsPage`, `LEAD_ROW_SELECT`), so a lead raised at 1am IST
 * is today's and nothing here reads a clock or a formatted date.
 *
 * The window is the Age filter's own "This week" bucket (`age < 7`): today and
 * the six days before it, seven calendar days in all. A lead raised exactly
 * seven days ago is not recent — it is the first day of the next bucket, and
 * the badge and the filter must never disagree about one lead. The number is
 * `mbos.leads.recentDays` so a team can widen it without a deploy.
 * ------------------------------------------------------------------------- */
export function isRecentLead(ageDays: number | null | undefined, windowDays: number): boolean {
  if (ageDays === null || ageDays === undefined || !Number.isFinite(ageDays)) return false;
  return ageDays < windowDays;
}
