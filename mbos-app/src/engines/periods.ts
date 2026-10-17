/**
 * The ranges a salesman can read his performance over, as two calendar days.
 *
 * PURE: it takes today as a `YYYY-MM-DD` string and does no I/O and reads no
 * clock, so every preset can be pinned by a test on any machine in any zone.
 *
 * A YEAR HERE IS THE FINANCIAL YEAR, April to March. That is the year Mahek's
 * own bill numbers carry (MMI/26-27/1119), the year targets and appraisals are
 * argued over, and the one the accounts desk will quote back at him — a
 * January-to-December "this year" would be a figure nobody else in the
 * building could reconcile. The label says so in the dates printed under it.
 * Quarters follow the same year: April–June is the first.
 */

export type PeriodKey =
  | 'this-month'
  | 'last-month'
  | 'this-quarter'
  | 'last-quarter'
  | 'this-year'
  | 'last-year'
  | 'custom';

export type Period = { key: PeriodKey; label: string; from: string; to: string };

export const PRESETS: { key: Exclude<PeriodKey, 'custom'>; label: string }[] = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'this-quarter', label: 'This quarter' },
  { key: 'last-quarter', label: 'Last quarter' },
  { key: 'this-year', label: 'This year' },
  { key: 'last-year', label: 'Last year' },
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** The last day of a month, `month` 1–12. Day 0 of the next month, in UTC. */
function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function day(year: number, month: number, d: number): string {
  /* Month arithmetic below can run past either end of a year. */
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  return `${y}-${pad(m)}-${pad(Math.min(d, lastDay(y, m)))}`;
}

function monthRange(year: number, month: number): { from: string; to: string } {
  const from = day(year, month, 1);
  const [y, m] = from.split('-').map(Number);
  return { from, to: day(y, m, lastDay(y, m)) };
}

/** The financial year a month falls in, by the year it STARTS. Jan 2027 is FY 2026. */
export function fyStart(year: number, month: number): number {
  return month >= 4 ? year : year - 1;
}

/**
 * A preset as a range.
 *
 * Ranges END on their own last day rather than on today — the server clamps
 * the future away, and a range that changed its end every morning could not
 * be compared with the one before it.
 */
export function periodFor(key: Exclude<PeriodKey, 'custom'>, today: string): Period {
  const [y, m] = today.split('-').map(Number);
  const label = PRESETS.find((p) => p.key === key)!.label;
  /* Months since April, 0–11, so a quarter is a third of that. */
  const intoYear = (m - 4 + 12) % 12;
  const qStartMonth = m - (intoYear % 3);

  switch (key) {
    case 'this-month':
      return { key, label, ...monthRange(y, m) };
    case 'last-month':
      return { key, label, ...monthRange(y, m - 1) };
    case 'this-quarter':
      return {
        key,
        label,
        from: day(y, qStartMonth, 1),
        to: monthRange(y, qStartMonth + 2).to,
      };
    case 'last-quarter':
      return {
        key,
        label,
        from: day(y, qStartMonth - 3, 1),
        to: monthRange(y, qStartMonth - 1).to,
      };
    case 'this-year': {
      const fy = fyStart(y, m);
      return { key, label, from: `${fy}-04-01`, to: `${fy + 1}-03-31` };
    }
    case 'last-year': {
      const fy = fyStart(y, m) - 1;
      return { key, label, from: `${fy}-04-01`, to: `${fy + 1}-03-31` };
    }
  }
}

/** A custom range, its two ends put in order whichever was picked first. */
export function customPeriod(a: string, b: string): Period {
  const [from, to] = a <= b ? [a, b] : [b, a];
  return { key: 'custom', label: 'Custom', from, to };
}

/**
 * Whether a range is exactly one calendar month — the shape the sync already
 * carries, so the screen can draw it with no signal.
 */
export function wholeMonth(period: { from: string; to: string }): string | null {
  const key = period.from.slice(0, 7);
  if (period.to.slice(0, 7) !== key || !period.from.endsWith('-01')) return null;
  const [y, m] = key.split('-').map(Number);
  return period.to === day(y, m, lastDay(y, m)) ? key : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "1 Apr 2026 – 31 Mar 2027", or "Sep 2026" for one whole month.
 *
 * The dates are ALWAYS printed under a preset's name: "This year" alone would
 * leave him guessing whether it starts in January or April.
 */
export function rangeWords(period: { from: string; to: string }): string {
  const month = wholeMonth(period);
  if (month) {
    const [y, m] = month.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }
  const words = (iso: string, withYear: boolean) => {
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
  };
  const sameYear = period.from.slice(0, 4) === period.to.slice(0, 4);
  if (period.from === period.to) return words(period.from, true);
  return `${words(period.from, !sameYear)} – ${words(period.to, true)}`;
}

/** The last day of a `YYYY-MM` month, as `YYYY-MM-DD`. */
export function endOfMonthIso(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return monthRange(y, m).to;
}
