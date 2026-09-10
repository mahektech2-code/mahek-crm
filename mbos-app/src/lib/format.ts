/**
 * The four formatting helpers the design uses, ported unchanged.
 *
 * `inr` groups the Indian way — last three digits, then pairs — because
 * ₹12,43,405 and ₹1,243,405 are the same number and only one of them is
 * readable at a glance to the person holding the phone.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function inr(n: number): string {
  const s = Math.round(Math.abs(n)).toString();
  if (s.length <= 3) return '₹' + s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return '₹' + rest + ',' + last3;
}

/**
 * The short form the day-ahead strip uses — ₹5.1L rather than ₹5,12,000.
 *
 * Three numbers side by side in a 110-point cell cannot each be eight
 * characters wide, and a lakh is how the figure is said out loud anyway.
 * Takes rupees, like `inr`.
 */
export function compactInr(rupees: number): string {
  const n = Math.round(Math.abs(rupees));
  const trim = (v: number) => String(Math.round(v * 10) / 10);
  if (n >= 10_000_000) return '₹' + trim(n / 10_000_000) + 'Cr';
  if (n >= 100_000) return '₹' + trim(n / 100_000) + 'L';
  if (n >= 1_000) return '₹' + trim(n / 1_000) + 'K';
  return inr(n);
}

export function plural(n: number, noun: string, form?: string): string {
  return n + ' ' + (n === 1 ? noun : form || noun + 's');
}

/** `2026-08-24` → `24 Aug`. An empty date reads as an em dash, never as blank. */
export function pretty(iso: string | null | undefined): string {
  if (!iso) return '—';
  const p = String(iso).split('-');
  return p.length === 3 ? Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1] : String(iso);
}

/** Same conversion, but an empty date is genuinely empty — used inside labels. */
export function dmy(iso: string | null | undefined): string {
  if (!iso) return '';
  const p = String(iso).split('-');
  if (p.length !== 3) return String(iso);
  return parseInt(p[2], 10) + ' ' + MONTHS[parseInt(p[1], 10) - 1];
}

/**
 * `Mon 18 Aug` — a day named the way somebody says it out loud.
 *
 * Built in UTC deliberately: these are calendar days with no time of day in
 * them, so there is no zone to get right, and building them locally is what
 * shifts a date across a DST boundary.
 *
 * It lived in `app/journey.tsx` and nowhere else, so the pick screen printed
 * `2026-09-09` on the card naming the very day the route screen called
 * `Wed 9 Sep` — one day, two vocabularies, on two screens one tap apart.
 */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  const at = new Date(Date.UTC(y, m - 1, d));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][at.getUTCDay()];
  return day + ' ' + at.getUTCDate() + ' ' + MONTHS[at.getUTCMonth()];
}

/**
 * `Today`, `Tomorrow`, or `Wed 9 Sep`.
 *
 * The route screen listed every day by date while its own headline talked
 * about "today" — so the card naming the day somebody is standing in read
 * `Wed 9 Sep`, and connecting the two meant knowing today's date. The two
 * days worth naming in words are the two anybody acts on.
 *
 * `Yesterday` is deliberately absent: past days appear under Recently, where
 * every row is a date and one relative word among them reads as a different
 * kind of row.
 */
export function dayLabelRelative(iso: string, today: string): string {
  if (iso === today) return 'Today';
  const [y, m, d] = today.split('-').map(Number);
  if (y && m && d) {
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    if (iso === isoDateUtc(next)) return 'Tomorrow';
  }
  return dayLabel(iso);
}

/** `YYYY-MM-DD` off a date built in UTC — the zone `dayLabel` works in. */
function isoDateUtc(d: Date): string {
  return (
    d.getUTCFullYear() +
    '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getUTCDate()).padStart(2, '0')
  );
}

export function monthName(monthIndex: number): string {
  return MONTH_NAMES[monthIndex];
}

/** A local calendar date as `YYYY-MM-DD`, never via toISOString — that answers in UTC. */
export function isoDate(d: Date): string {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}
