/* ---------------------------------------------------------------------------
 * THE MONTHS A VARIANCE REPORT CAN BE ASKED FOR, and what they are called.
 *
 * Pure, and it takes the business day as an argument rather than reading a
 * clock — the pages that build the list are server components and the panel
 * that prints the names is a client one, and neither may read the clock
 * during a render. "2026-08" is the whole vocabulary; a month is a string.
 * ------------------------------------------------------------------------- */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-08" → "August 2026". */
export function monthLabel(month: string): string {
  const [year, m] = month.split("-");
  return `${MONTH_NAMES[Number(m) - 1] ?? month} ${year}`;
}

/**
 * The twelve months ending with the one the business day falls in, newest
 * first. Arithmetic on the parts rather than on a Date, because a Date built
 * from a day string is an instant in whatever zone the machine is in, and
 * subtracting a month from one of those is how a report ends up labelled
 * with the wrong month for five and a half hours of every day.
 */
export function lastTwelveMonths(todayIso: string): string[] {
  const year = Number(todayIso.slice(0, 4));
  const month = Number(todayIso.slice(5, 7));
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const total = year * 12 + (month - 1) - i;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    out.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return out;
}

/** The month a day falls in — the default a variance screen opens on. */
export function monthOf(todayIso: string): string {
  return todayIso.slice(0, 7);
}
