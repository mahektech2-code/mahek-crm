import { daysInMonth, dayDiff, isLeapYear, isValidDateKey, makeDateKey } from "./date-key";

// A date that comes round every year: a birthday or a wedding anniversary. Pure.
//
// Accepted spellings: "YYYY-MM-DD" (a full date; the year is kept so an age or a count of years can be shown) and
// "--MM-DD" (no year). Anything else, a date that does not exist (2027-02-29, 1999-04-31) or an empty value is refused
// with `null`: a wrong date is never guessed or repaired.
//
// Leap day (29 February): in a year that has no 29 February the occasion is observed on 28 February, and the result says so
// (`observedOnFallback`). That is a stated rule of this app, not something the data says.

export type MonthDay = { month: number; day: number; year: number | null };

export function parseRecurringDate(input: unknown): MonthDay | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  const noYear = /^--(\d{2})-(\d{2})$/.exec(text);
  if (noYear) {
    const month = Number(noYear[1]);
    const day = Number(noYear[2]);
    // 29 February is a real date even without a year
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(2024, month) ? { month, day, year: null } : null;
  }
  if (!isValidDateKey(text)) return null;
  return { month: Number(text.slice(5, 7)), day: Number(text.slice(8, 10)), year: Number(text.slice(0, 4)) };
}

export type Occurrence = {
  /** The day it is next marked, "YYYY-MM-DD". */
  date: string;
  /** 0 when it is today. */
  daysUntil: number;
  /** True when a 29 February date is being marked on 28 February because that year has no 29 February. */
  observedOnFallback: boolean;
  /** Years since the original date (the age, or the anniversary number) on `date`, or null when the date had no year or lies in the future. */
  years: number | null;
};

function inYear(md: MonthDay, year: number): { date: string; fallback: boolean } {
  if (md.month === 2 && md.day === 29 && !isLeapYear(year)) return { date: makeDateKey(year, 2, 28), fallback: true };
  return { date: makeDateKey(year, md.month, md.day), fallback: false };
}

/** The day a yearly date falls on in a given year (28 February for a 29 February date in a year without one), or null when `input` is not a usable date. */
export function occurrenceInYear(input: unknown, year: number): { date: string; observedOnFallback: boolean } | null {
  const md = parseRecurringDate(input);
  if (!md) return null;
  const r = inYear(md, year);
  return { date: r.date, observedOnFallback: r.fallback };
}

/** The first occurrence on or after `todayKey` (today counts). `null` when `input` is not a usable date or `todayKey` is not a date. */
export function nextOccurrence(input: unknown, todayKey: string): Occurrence | null {
  const md = parseRecurringDate(input);
  if (!md || !isValidDateKey(todayKey)) return null;
  const thisYear = Number(todayKey.slice(0, 4));
  let { date, fallback } = inYear(md, thisYear);
  if (date < todayKey) ({ date, fallback } = inYear(md, thisYear + 1));
  const year = Number(date.slice(0, 4));
  const years = md.year !== null && year >= md.year ? year - md.year : null;
  return { date, daysUntil: dayDiff(todayKey, date), observedOnFallback: fallback, years };
}
