import type { BusinessDate } from "./business-date";

/* ---------------------------------------------------------------------------
 * The Indian financial year: 1 April to 31 March.
 *
 * Pure, and shared by the server that filters and the screen that labels, so
 * the two cannot disagree about which bills belong to "FY 26-27". Mahek's own
 * bill numbers already carry it — MMI/26-27/1119 — which is what makes it the
 * natural way to cut a ten-thousand-row ledger.
 * ------------------------------------------------------------------------- */

/** "26-27" for any date between 1 Apr 2026 and 31 Mar 2027. */
export function financialYearOf(date: BusinessDate): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return `${String(start % 100).padStart(2, "0")}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/**
 * The half-open range for a year, as business dates: start inclusive, end
 * EXCLUSIVE. Exclusive because 31 March is a real trading day and an
 * inclusive end invites the off-by-one that quietly drops it.
 */
export function financialYearRange(fy: string): { start: BusinessDate; end: BusinessDate } {
  const startYY = Number(fy.slice(0, 2));
  // Two digits, and these records begin well after 2000, so the century is
  // never in doubt.
  const startYear = 2000 + startYY;
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-04-01` };
}

/** "FY 26-27" — what a person reads. */
export function financialYearLabel(fy: string): string {
  return `FY ${fy}`;
}

/**
 * Every year from the oldest record to today, newest first.
 *
 * Derived from the data rather than listed, so a year appears the moment it
 * has a bill in it and no year is offered that would show an empty table.
 * Today is always included: a fresh financial year has to be selectable on
 * 1 April, before anything has been billed in it.
 */
export function financialYearsBetween(
  earliest: BusinessDate | null,
  today: BusinessDate,
): string[] {
  const current = financialYearOf(today);
  if (!earliest) return [current];

  const from = Number(financialYearRange(financialYearOf(earliest)).start.slice(0, 4));
  const to = Number(financialYearRange(current).start.slice(0, 4));

  const years: string[] = [];
  for (let y = to; y >= from; y--) {
    years.push(financialYearOf(`${y}-04-01`));
  }
  return years;
}
