import {
  addDays,
  daysBetween,
  endOfMonth,
  startOfWeek,
} from "@/lib/business-date";
import { longDate, monthLabel, shortDate } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * The period an Expenses screen is reading — PURE and client-safe, because the
 * picker in the header (a client component) and the page that filters by it
 * (a server one) must agree on what "this week" means.
 *
 * It rides the URL as `period` plus either `on` (any day inside a day, week or
 * month) or `from`/`to` (a range). The older `?month=YYYY-MM` links still
 * open the month they name, so nothing anybody bookmarked breaks.
 * ------------------------------------------------------------------------- */

export type PeriodKind = "day" | "week" | "month" | "range" | "all";

export const PERIOD_KINDS: { key: PeriodKind; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "range", label: "Range" },
  { key: "all", label: "All time" },
];

export type ExpensePeriod = {
  kind: PeriodKind;
  /** Inclusive bounds; both null for all time. */
  from: string | null;
  to: string | null;
  /** The day the period is anchored on — what stepping moves from. */
  on: string;
  /** Words for the header: "Thu 9 Oct", "6 – 12 Oct 2026", "October 2026". */
  label: string;
  /** Short words for a figure's label: "this month", "this week", "in range". */
  noun: string;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

export type PeriodParams = {
  period?: string;
  on?: string;
  from?: string;
  to?: string;
  month?: string;
};

/** Read the period off the URL. Anything malformed falls back to this month. */
export function readPeriod(p: PeriodParams, today: string): ExpensePeriod {
  if (!p.period && p.month && MONTH.test(p.month))
    return build("month", `${p.month}-01`, null, null);
  const kind = (
    PERIOD_KINDS.some((k) => k.key === p.period) ? p.period : "month"
  ) as PeriodKind;
  const on = p.on && DAY.test(p.on) ? p.on : today;
  if (kind === "range") {
    let from = p.from && DAY.test(p.from) ? p.from : null;
    let to = p.to && DAY.test(p.to) ? p.to : null;
    if (!from && !to) return build("month", today, null, null);
    from ??= to;
    to ??= from;
    if (from! > to!) [from, to] = [to, from];
    return build("range", from!, from, to);
  }
  return build(kind, on, null, null);
}

function build(
  kind: PeriodKind,
  on: string,
  from: string | null,
  to: string | null,
): ExpensePeriod {
  switch (kind) {
    case "day":
      return {
        kind,
        on,
        from: on,
        to: on,
        label: longDate(on),
        noun: "on the day",
      };
    case "week": {
      const start = startOfWeek(on);
      const end = addDays(start, 6);
      return {
        kind,
        on,
        from: start,
        to: end,
        label: `${shortDate(start)} – ${longDate(end)}`,
        noun: "this week",
      };
    }
    case "month": {
      const key = on.slice(0, 7);
      return {
        kind,
        on,
        from: `${key}-01`,
        to: endOfMonth(key),
        label: `${monthLabel(key)} ${key.slice(0, 4)}`,
        noun: "this month",
      };
    }
    case "range":
      return {
        kind,
        on,
        from,
        to,
        label:
          from === to ? longDate(from) : `${shortDate(from)} – ${longDate(to)}`,
        noun: "in range",
      };
    default:
      return {
        kind: "all",
        on,
        from: null,
        to: null,
        label: "All time",
        noun: "all time",
      };
  }
}

/** The same kind of period, one step earlier or later. Range and all time do not step. */
export function stepPeriod(p: ExpensePeriod, by: -1 | 1): ExpensePeriod | null {
  if (p.kind === "day") return build("day", addDays(p.on, by), null, null);
  if (p.kind === "week")
    return build("week", addDays(startOfWeek(p.on), 7 * by), null, null);
  if (p.kind === "month") {
    const [y, m] = p.on.split("-").map(Number);
    const t = y * 12 + (m - 1) + by;
    return build(
      "month",
      `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`,
      null,
      null,
    );
  }
  if (p.kind === "range" && p.from && p.to) {
    const len = daysBetween(p.from, p.to) + 1;
    return build(
      "range",
      addDays(p.from, by * len),
      addDays(p.from, by * len),
      addDays(p.to, by * len),
    );
  }
  return null;
}

/** The URL parameters that state a period — the inverse of `readPeriod`. */
export function periodQuery(p: ExpensePeriod): Record<string, string> {
  if (p.kind === "all") return { period: "all" };
  if (p.kind === "range") return { period: "range", from: p.from!, to: p.to! };
  return { period: p.kind, on: p.on };
}

/** Is a `YYYY-MM-DD` inside the period? */
export function inPeriod(p: ExpensePeriod, day: string): boolean {
  return (!p.from || day >= p.from) && (!p.to || day <= p.to);
}
