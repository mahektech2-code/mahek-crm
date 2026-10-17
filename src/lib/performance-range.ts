/* ---------------------------------------------------------------------------
 * THE RANGE A PERFORMANCE READING COVERS, and the one rule about its end.
 *
 * A performance reading over a range is scored against the targets of the
 * months it touches, and a month only partly inside the range asks for that
 * part of its target (`handsetReadingForRange`). That is right for two days
 * somebody DELIBERATELY picked — the 1st to the 10th asks for ten days' worth.
 *
 * It is wrong for "this month" asked on the 7th, and that is the bug this file
 * exists to stop coming back. The handset's endpoint clamped the end of every
 * range to today, on the reasoning that the future has no figures in it — so
 * October asked on the 7th became 1–7 October, its target was cut to 7/31 of
 * itself, the tasks due later in the month dropped out of the activity base,
 * and the phone scored the salesman three or four times higher than the
 * Performance screen beside it, which holds the month to date against the
 * WHOLE month's target. Two answers to one question, on the screen an
 * appraisal is read off.
 *
 * So the end is never clamped. The future really does have no orders, no
 * receipts and no new customers in it, so reading it costs nothing and changes
 * no actual; what it keeps is the target and the tasks already set for the
 * rest of the period, which is exactly what the dashboard scores against. A
 * range that has not STARTED is still refused, because it has nothing at all
 * to say.
 *
 * PURE and client-safe: the Sales Dashboard's person modal builds its presets
 * from here, and both endpoints validate with it.
 * ------------------------------------------------------------------------- */

export type RangePreset =
  | "this-month"
  | "last-month"
  | "this-quarter"
  | "last-quarter"
  | "this-year"
  | "last-year";

export const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "this-quarter", label: "This quarter" },
  { key: "last-quarter", label: "Last quarter" },
  { key: "this-year", label: "This year" },
  { key: "last-year", label: "Last year" },
];

export type DayRange = { from: string; to: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Five years is every question anybody has asked of this book, and a bound on the work. */
export const MAX_RANGE_DAYS = 5 * 366;

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** A day, with month arithmetic allowed to run past either end of a year. */
function day(year: number, month: number, d: number): string {
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  return `${y}-${pad(m)}-${pad(Math.min(d, lastDay(y, m)))}`;
}

function monthRange(year: number, month: number): DayRange {
  const from = day(year, month, 1);
  const [y, m] = from.split("-").map(Number);
  return { from, to: day(y, m, lastDay(y, m)) };
}

/**
 * A preset as two days. A YEAR IS THE FINANCIAL YEAR, April to March, the
 * year Mahek's bill numbers carry; quarters follow it. The same arithmetic as
 * the handset's `engines/periods.ts`, so the two screens' presets cover the
 * same days.
 */
export function presetRange(key: RangePreset, today: string): DayRange {
  const [y, m] = today.split("-").map(Number);
  const intoYear = (m - 4 + 12) % 12;
  const qStart = m - (intoYear % 3);
  const fy = m >= 4 ? y : y - 1;
  switch (key) {
    case "this-month":
      return monthRange(y, m);
    case "last-month":
      return monthRange(y, m - 1);
    case "this-quarter":
      return { from: day(y, qStart, 1), to: monthRange(y, qStart + 2).to };
    case "last-quarter":
      return { from: day(y, qStart - 3, 1), to: monthRange(y, qStart - 1).to };
    case "this-year":
      return { from: `${fy}-04-01`, to: `${fy + 1}-03-31` };
    case "last-year":
      return { from: `${fy - 1}-04-01`, to: `${fy}-03-31` };
  }
}

/** Which preset a range is, if any — so a picked range lights its chip. */
export function presetOf(range: DayRange, today: string): RangePreset | null {
  for (const p of RANGE_PRESETS) {
    const r = presetRange(p.key, today);
    if (r.from === range.from && r.to === range.to) return p.key;
  }
  return null;
}

/** Whether a range is exactly one calendar month, and which. */
export function wholeMonthOf(range: DayRange): string | null {
  const key = range.from.slice(0, 7);
  if (range.to.slice(0, 7) !== key || !range.from.endsWith("-01")) return null;
  const [y, m] = key.split("-").map(Number);
  return range.to === day(y, m, lastDay(y, m)) ? key : null;
}

/** Whole days from `from` to `to`, both ends counted. */
export function rangeDays(range: DayRange): number {
  const at = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((at(range.to) - at(range.from)) / 86_400_000) + 1;
}

/**
 * A range as it arrived from a client, checked — and NEVER clamped. See the
 * header: clamping the end to today is what made the phone and the dashboard
 * disagree.
 */
export function checkRange(
  from: string | null | undefined,
  to: string | null | undefined,
  today: string,
): { ok: true; range: DayRange } | { ok: false; error: string } {
  const f = from ?? "";
  const t = to ?? "";
  if (!ISO_DAY.test(f) || !ISO_DAY.test(t) || f > t) {
    return { ok: false, error: "Pick a start date on or before the end date." };
  }
  if (f > today) return { ok: false, error: "That range has not started yet." };
  if (rangeDays({ from: f, to: t }) - 1 > MAX_RANGE_DAYS) {
    return { ok: false, error: "Pick a range of five years or less." };
  }
  return { ok: true, range: { from: f, to: t } };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 2026" for one whole month, else "1 Apr 2026 – 31 Mar 2027". */
export function rangeLabel(range: DayRange): string {
  const month = wholeMonthOf(range);
  if (month) return `${MONTHS[+month.slice(5, 7) - 1]} ${month.slice(0, 4)}`;
  const words = (iso: string, withYear: boolean) =>
    `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]}${withYear ? ` ${iso.slice(0, 4)}` : ""}`;
  if (range.from === range.to) return words(range.from, true);
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  return `${words(range.from, !sameYear)} – ${words(range.to, true)}`;
}
