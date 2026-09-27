import "server-only";
import {
  comparableRange,
  reportRange,
  sameRangeLastYear,
  quarterOf,
  type BusinessDate,
  type DateRange,
  type ReportPeriod,
} from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { span } from "./format";
import type { PeriodKey, PeriodState, PeriodView } from "./types";

/* ---------------------------------------------------------------------------
 * The period control, read off the business date — never off a literal.
 *
 * The design's seven periods are `reportRange`'s, with "year to date" meaning
 * the FINANCIAL year (PRD Q10) and the quarter labelled as an FY quarter.
 * Every view states its dates and what it is compared with (PRD §7.1).
 * ------------------------------------------------------------------------- */

const KEYS: PeriodKey[] = ["today", "week", "month", "last-month", "quarter", "ytd", "custom"];

export function isPeriodKey(v: unknown): v is PeriodKey {
  return typeof v === "string" && (KEYS as string[]).includes(v);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** "Q2 FY 26-27" — the FY quarter the date falls in (Apr–Jun is Q1). */
export function fyQuarterLabel(day: BusinessDate): string {
  const q = quarterOf(day); // calendar quarter 1..4
  const fyq = q === 1 ? 4 : q - 1;
  const y = Number(day.slice(0, 4));
  const fyStart = Number(day.slice(5, 7)) >= 4 ? y : y - 1;
  return `Q${fyq} FY ${String(fyStart).slice(2)}-${String(fyStart + 1).slice(2)}`;
}

export function fyLabel(day: BusinessDate): string {
  const y = Number(day.slice(0, 4));
  const fyStart = Number(day.slice(5, 7)) >= 4 ? y : y - 1;
  return `FY ${String(fyStart).slice(2)}-${String(fyStart + 1).slice(2)}`;
}

function ranges(day: BusinessDate, key: PeriodKey, custom?: { from?: string; to?: string }) {
  let range: DateRange;
  if (key === "custom") {
    const from = custom?.from && ISO.test(custom.from) ? custom.from : day;
    const to = custom?.to && ISO.test(custom.to) ? custom.to : day;
    // A backwards range is swapped rather than refused — the dates are the
    // person's, and "from 30 to 1" means 1 to 30.
    range = from <= to ? { from, to } : { from: to, to: from };
  } else {
    range = reportRange(day, key as ReportPeriod);
  }
  const compare = comparableRange(range, key as ReportPeriod);
  const lastYear = sameRangeLastYear(range);
  return { range, compare, lastYear };
}

export function periodView(day: BusinessDate, key: PeriodKey, custom?: { from?: string; to?: string }): PeriodView {
  const label =
    key === "today"
      ? "Today"
      : key === "week"
        ? "This week"
        : key === "month"
          ? "This month"
          : key === "last-month"
            ? "Last month"
            : key === "quarter"
              ? fyQuarterLabel(day)
              : key === "ytd"
                ? `${fyLabel(day)} to date`
                : "Custom";
  if (key === "custom" && !custom?.from) {
    return { key, label, dates: "Pick a start and an end date" };
  }
  const { range, compare, lastYear } = ranges(day, key, custom);
  const cmp = key === "ytd" ? span(lastYear.from, lastYear.to) : span(compare.from, compare.to);
  return { key, label, dates: `${span(range.from, range.to)}, compared with ${cmp}` };
}

export async function readPeriodState(
  key: string | undefined,
  custom?: { from?: string; to?: string },
): Promise<PeriodState> {
  const day = await today();
  const k: PeriodKey = isPeriodKey(key) ? key : "month";
  const { range, compare, lastYear } = ranges(day, k, custom);
  return {
    key: k,
    from: range.from,
    to: range.to,
    compareFrom: compare.from,
    compareTo: compare.to,
    lastYearFrom: lastYear.from,
    lastYearTo: lastYear.to,
    today: day,
    monthKey: range.to.slice(0, 7),
    views: KEYS.map((pk) => periodView(day, pk, pk === "custom" ? custom : undefined)),
  };
}
