/* ---------------------------------------------------------------------------
 * Which months a Top customers report covers, and which report is current.
 *
 * PURE and client-safe: the screen prints the month headings from the same
 * function the generator builds the window from, so the columns can never be
 * labelled with months the figures were not taken over.
 *
 * A report is generated on the 1st of a month at 10:00 IST and covers whole
 * calendar months ending with the one just finished. Before 10:00 on the 1st
 * the current report is still last month's — the new one does not exist yet,
 * and pretending it does would show a month that has not been generated.
 * ------------------------------------------------------------------------- */

/** The spans the screen offers. A report is generated for each of them. */
export const TOP_CUSTOMER_SPANS = [3, 6, 12] as const;
export type TopCustomerSpan = (typeof TOP_CUSTOMER_SPANS)[number];

export const SPAN_LABEL: Record<TopCustomerSpan, string> = {
  3: "3 months",
  6: "6 months",
  12: "1 year",
};

/** The hour of the 1st, IST, at which the month's report is generated. */
export const REPORT_HOUR_IST = 10;

/** `YYYY-MM` plus (or minus) whole months. */
export function addMonthsKey(month: string, delta: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + delta;
  const year = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${year}-${String(mm + 1).padStart(2, "0")}`;
}

/** The months a report generated in `month` covers, oldest first. */
export function monthsCovered(month: string, span: number): string[] {
  return Array.from({ length: span }, (_, i) => addMonthsKey(month, i - span));
}

/**
 * The month whose report is current at a given instant: this month once the
 * 1st's 10:00 IST has passed, last month before it.
 *
 * Read with `formatToParts` in the app's zone, never a local-zone getter —
 * the server runs in UTC, and 10:00 IST is 04:30 there.
 */
export function currentReportMonth(atMs: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(atMs))
      .map((p) => [p.type, p.value]),
  );
  const month = `${parts.year}-${parts.month}`;
  return Number(parts.day) === 1 && Number(parts.hour) < REPORT_HOUR_IST
    ? addMonthsKey(month, -1)
    : month;
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07" → "Jul", or "Jul 25" where the window crosses a year. */
export function monthHeading(month: string, withYear: boolean): string {
  const label = MONTH_SHORT[Number(month.slice(5, 7)) - 1] ?? month;
  return withYear ? `${label} ${month.slice(2, 4)}` : label;
}
