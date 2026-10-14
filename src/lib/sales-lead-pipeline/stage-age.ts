/**
 * HOW LONG A LEAD HAS BEEN ON ITS CURRENT RUNG — as the two CRM Sales Manager
 * screens draw it. PURE and client-safe, like `lead-recent.ts` beside it.
 *
 * The day count itself is NOT worked out here. It is `business day -
 * customers.lead_stage_since`, taken in SQL by the same expression every other
 * stage-age figure already uses (`leadRecord`'s `stuckDays`, `leadsPage`'s
 * `stageDays`). This file only decides whether that figure may be SHOWN:
 *
 * - No stage date means NO figure. The existing readers coalesce a missing date
 *   to 0, which on a screen reads as "arrived today"; a lead whose date nobody
 *   recorded is not that, so it is left blank instead.
 * - A negative figure (a date in the future, from bad data) is clamped to 0.
 */
export function stageAgeDays(
  stageSince: string | null | undefined,
  days: number | null | undefined,
): number | undefined {
  if (!stageSince) return undefined;
  if (days === null || days === undefined || !Number.isFinite(days)) return undefined;
  return Math.max(0, Math.floor(days));
}

/** `4d` — the compact form for a list badge. */
export function stageAgeShort(days: number | null | undefined): string | null {
  if (days === null || days === undefined || !Number.isFinite(days)) return null;
  return `${Math.max(0, Math.floor(days))}d`;
}

/** `4d in Suspect` — the form for the Next Action band, where the rung is named. */
export function stageAgeLong(days: number | null | undefined, stageLabel: string): string | null {
  const short = stageAgeShort(days);
  return short === null ? null : `${short} in ${stageLabel}`;
}
