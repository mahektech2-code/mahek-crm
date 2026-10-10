import { addDays, type BusinessDate } from "./business-date";
import { financialYearOf, financialYearRange, financialYearsBetween } from "./financial-year";

/* ---------------------------------------------------------------------------
 * A YEAR, either way of counting it — the one filter every yearly screen uses.
 *
 * Mahek reads money in FINANCIAL years (1 April – 31 March, the year the bill
 * numbers carry: MMI/26-27/1119), and some questions are asked in CALENDAR
 * years. A year is one string, and the two shapes cannot be confused:
 *
 *   "26-27"  financial year 2026-27   — the shape `?fy=` links already carry
 *   "2026"   calendar year 2026
 *
 * So a URL, a service filter and an export link carry one value, an old
 * bookmark still opens the year it named, and nothing has to send a second
 * parameter saying which kind it is.
 *
 * Pure and client-safe: the screen that labels a year and the query that
 * filters by it read the same function, so they cannot disagree about where a
 * year starts. The default is the CURRENT FINANCIAL YEAR everywhere.
 * ------------------------------------------------------------------------- */

export type YearKind = "fy" | "cy";

const FY_SHAPE = /^\d{2}-\d{2}$/;
const CY_SHAPE = /^\d{4}$/;

/** Which kind a year string is, or null for anything that is neither. */
export function yearKindOf(year: string | null | undefined): YearKind | null {
  if (!year) return null;
  if (FY_SHAPE.test(year)) {
    // "26-27" only: a pair that does not follow on is a typo, not a year.
    const a = Number(year.slice(0, 2));
    const b = Number(year.slice(3, 5));
    return (a + 1) % 100 === b ? "fy" : null;
  }
  return CY_SHAPE.test(year) ? "cy" : null;
}

/** Start inclusive, end EXCLUSIVE — the same contract as `financialYearRange`. */
export function yearRange(year: string): { start: BusinessDate; end: BusinessDate } {
  if (yearKindOf(year) === "cy") {
    const y = Number(year);
    return { start: `${y}-01-01`, end: `${y + 1}-01-01` };
  }
  return financialYearRange(year);
}

/** The same range with an INCLUSIVE last day, for screens that take from/to. */
export function yearDates(year: string): { from: BusinessDate; to: BusinessDate } {
  const { start, end } = yearRange(year);
  return { from: start, to: addDays(end, -1) };
}

/** "FY 2026-27" or "2026" — what a person reads. */
export function yearLabel(year: string): string {
  if (yearKindOf(year) === "cy") return year;
  const start = 2000 + Number(year.slice(0, 2));
  return `FY ${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** "1 Apr 2026 – 31 Mar 2027", for the line under a picker. */
export function yearSpanLabel(year: string): string {
  const { start, end } = yearRange(year);
  const last = addDays(end, -1);
  const d = (iso: string) => {
    const [y, m, day] = iso.split("-").map(Number);
    return `${day} ${MONTHS[m - 1]} ${y}`;
  };
  return `${d(start)} – ${d(last)}`;
}

/** The year of `kind` that today falls in. */
export function currentYear(today: BusinessDate, kind: YearKind): string {
  return kind === "cy" ? today.slice(0, 4) : financialYearOf(today);
}

/**
 * Every year of both kinds from the oldest record to today, newest first.
 * Derived from the data, so no year is offered that could only be empty, and
 * today's year is always there — a new year is selectable on its first day.
 */
export function yearOptions(
  earliest: BusinessDate | null,
  today: BusinessDate,
): { fy: string[]; cy: string[] } {
  const fy = financialYearsBetween(earliest, today);
  const to = Number(today.slice(0, 4));
  const from = earliest ? Math.min(Number(earliest.slice(0, 4)), to) : to;
  const cy: string[] = [];
  for (let y = to; y >= from; y--) cy.push(String(y));
  return { fy, cy };
}

/**
 * The year a URL asked for, if it is one this screen offers; otherwise the
 * current financial year. `legacy` is an older parameter (`?fy=`) still read
 * so a link somebody saved keeps opening the year it named.
 */
export function pickYear(
  asked: string | null | undefined,
  options: { fy: string[]; cy: string[] },
  today: BusinessDate,
): string {
  if (asked && (options.fy.includes(asked) || options.cy.includes(asked))) return asked;
  return financialYearOf(today);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
