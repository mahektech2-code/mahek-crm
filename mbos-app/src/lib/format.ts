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
 * `Wed 9 Sep`, and connecting the two meant knowing today's date. The two days
 * worth naming in words are the two anybody acts on.
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

/**
 * How far away, in words a person walking a beat would use.
 *
 * Metres under a kilometre and kilometres above it, and the precision drops as
 * the number grows because that is how the figure is actually used: at 80 m he
 * is looking for the door, at 14 km he is deciding whether to go at all, and a
 * tenth of a kilometre means nothing to that decision. Rounding metres to the
 * nearest ten is honest about a GPS fix that is itself good to a few metres —
 * printing "83 m" claims an accuracy the handset does not have.
 */
export function distanceLabel(metres: number | null | undefined): string | null {
  if (metres == null || !Number.isFinite(metres) || metres < 0) return null;
  if (metres < 950) return `${Math.max(10, Math.round(metres / 10) * 10)} m`;
  const km = metres / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/**
 * A number of bytes, as somebody deciding whether to download it would say it.
 *
 * Megabytes are the unit the decision is actually made in — a salesman knows
 * what 300 MB costs him and has no feel at all for 314,572,800. Decimal
 * megabytes rather than binary ones, because that is what the phone's own
 * storage screen and his data plan both use, and a figure here that disagreed
 * with the one in Settings would be the one he stopped believing.
 */
export function dataSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1_000_000_000) return (bytes / 1_000_000_000).toFixed(1) + ' GB';
  if (bytes >= 1_000_000) return Math.round(bytes / 1_000_000) + ' MB';
  if (bytes >= 1_000) return Math.round(bytes / 1_000) + ' KB';
  return bytes + ' B';
}

/**
 * A SHOP'S NAME AS IT SHOULD BE READ, not as it was typed.
 *
 * Half this book is shouted and a third of it is whispered: of 5,915 customers,
 * 1,254 are entirely upper case, 1,644 entirely lower, and plenty of the rest
 * are "new Asha paint". It comes from a spreadsheet a dozen people have typed
 * into over years, and nobody is going to go back and fix it.
 *
 * So it is fixed on the way to the SCREEN and never in the store. The name is
 * how orders and bills are matched back to legacy records — MahekOne's own rule
 * about `products.name` being a join key that must never be rewritten applies
 * here for the same reason — and the search box matches on what is stored. This
 * changes what is drawn and nothing else.
 *
 * THE RULE IS PER WORD, because a name is not uniformly wrong:
 *
 *   - A word holding both cases is somebody's deliberate spelling. Left alone,
 *     which is what keeps "McDonald" and "3D" intact.
 *   - A word in capitals inside a name that is NOT all capitals is an acronym
 *     the author shouted on purpose — "JSK Hardware", "P Janardhan Rao". Left
 *     alone.
 *   - Everything else is title-cased.
 *
 * The second rule is the one that earns its keep. Without it "JSK Hardware"
 * becomes "Jsk Hardware", which is worse than shouting. It cannot save an
 * acronym inside a name that is ALL capitals — "JSK HARDWARE" becomes "Jsk
 * Hardware" — because at that point there is nothing in the string that
 * distinguishes the acronym from the rest, and inventing a dictionary of them
 * would be wrong more often and less predictably.
 *
 * Separators are preserved exactly: "M/S", "R.K.", "A & B" keep their shape,
 * because splitting on them and rejoining is how "M/S" turns into "M / S".
 */
export function shopName(name: string | null | undefined): string {
  const raw = (name ?? '').trim();
  if (!raw) return '';

  const shouted = raw === raw.toUpperCase();

  /* Split on the RUNS BETWEEN letters and digits, so every separator that was
     there comes back untouched — one pass, no rejoining by hand. */
  return raw.replace(/[\p{L}\p{N}]+/gu, (word) => {
    const hasLower = word !== word.toUpperCase();
    const hasUpper = word !== word.toLowerCase();

    /* Deliberate mixed case: somebody meant it. */
    if (hasLower && hasUpper) return word;

    /* An acronym shouted inside a name that is not itself shouted. */
    if (hasUpper && !shouted) return word;

    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}
