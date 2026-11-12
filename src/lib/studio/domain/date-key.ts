// Date-only keys ("YYYY-MM-DD") and the arithmetic on them. Pure: no clock, no time zone. The caller decides what
// "today" is (the app uses the India date, see lib/date.ts istDateKey) and passes it in as a key.

export const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** A real calendar date: 2027-02-29 and 2026-13-01 are refused. */
export function isValidDateKey(key: unknown): key is string {
  if (typeof key !== "string" || !DATE_KEY.test(key)) return false;
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const day = Number(key.slice(8, 10));
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export const makeDateKey = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const MS_DAY = 86_400_000;

/** Whole calendar days from `fromKey` to `toKey`; negative when `toKey` is earlier. */
export function dayDiff(fromKey: string, toKey: string): number {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / MS_DAY);
}

export function addDays(key: string, days: number): string {
  const d = new Date(Date.parse(`${key}T00:00:00Z`) + days * MS_DAY);
  return makeDateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 0 = Sunday ... 6 = Saturday. */
export const weekdayOf = (key: string): number => new Date(`${key}T00:00:00Z`).getUTCDay();

/** The weeks (Sunday first) of a month. A cell is a date key, or null for a padding day outside the month. */
export function monthGrid(year: number, month: number): (string | null)[][] {
  const cells: (string | null)[] = Array.from({ length: weekdayOf(makeDateKey(year, month, 1)) }, () => null);
  for (let d = 1; d <= daysInMonth(year, month); d++) cells.push(makeDateKey(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
