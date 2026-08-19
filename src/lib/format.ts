/* ---------------------------------------------------------------------------
 * Formatting. Money lives in paise everywhere else in the codebase; it only
 * becomes a string here, on the way to the screen.
 * ------------------------------------------------------------------------- */

import { APP_TIMEZONE } from "./business-date";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** 1_84_20_000 paise -> "₹18,42,000" (Indian grouping, rupees, no paise). */
export function money(paise: number | null | undefined): string {
  if (paise == null) return "₹0";
  const rupees = Math.round(paise / 100);
  return "₹" + groupIndian(Math.abs(rupees)) + (rupees < 0 ? "" : "");
}

/** Same as money() but keeps a leading minus. */
export function signedMoney(paise: number): string {
  const rupees = Math.round(paise / 100);
  return (rupees < 0 ? "−₹" : "₹") + groupIndian(Math.abs(rupees));
}

/** Compact form used in tight cells: ₹18.4L, ₹2.6Cr. */
export function moneyShort(paise: number): string {
  const r = Math.round(paise / 100);
  const abs = Math.abs(r);
  if (abs >= 10_000_000) return `₹${(r / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000) return `₹${(r / 100_000).toFixed(2)}L`;
  if (abs >= 1_000) return `₹${(r / 1_000).toFixed(1)}k`;
  return `₹${r}`;
}

/** 1842000 -> "18,42,000" */
export function groupIndian(n: number): string {
  const s = String(Math.round(n));
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
}

/** Parse "2,00,000" / "₹2 00 000" / "200000" into paise. */
export function parseRupees(input: string): number | null {
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export function rupeesFromPaise(paise: number): string {
  return String(Math.round(paise / 100));
}

/** "2026-08-12" -> "12 Aug" */
export function shortDate(iso: string | Date | null | undefined): string {
  if (!iso) return "-";
  const d = typeof iso === "string" ? parseISODate(iso) : iso;
  if (!d) return "-";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * "14 Apr" while it is this year, "14 Apr 2025" once it is not.
 *
 * `shortDate` never prints a year, which is right on a date everybody knows is
 * recent and wrong the moment one is not: a Call Log row read "Last order 14
 * Apr" against an order placed sixteen months earlier, beside another row's
 * "6 Mar" that genuinely was this year. Rendered identically, the screen gave
 * a telecaller no way to tell an old order from a new one — and the one they
 * were about to ring about was the old one.
 *
 * `relativeTo` is a business date rather than the clock, because the clock may
 * not be read during render and because "this year" on this screen means the
 * working year, not the server's.
 */
export function shortDateWithYear(
  iso: string | null | undefined,
  relativeTo: string,
): string {
  if (!iso) return "-";
  const short = shortDate(iso);
  if (short === "-") return short;
  return iso.slice(0, 4) === relativeTo.slice(0, 4) ? short : `${short} ${iso.slice(0, 4)}`;
}

/** "2026-08-12" -> "12 Aug 2026" */
/** "2026-08" → "August". The design names the month rather than numbering it. */
export function monthLabel(period: string): string {
  const m = Number(period.slice(5, 7));
  return MONTHS_LONG[m - 1] ?? period;
}

export function longDate(iso: string | Date | null | undefined): string {
  if (!iso) return "-";
  const d = typeof iso === "string" ? parseISODate(iso) : iso;
  if (!d) return "-";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "2026-08" -> "August 2026" */
export function periodLabel(period: string): string {
  const [y, m] = period.split("-");
  return `${MONTHS_LONG[Number(m) - 1]} ${y}`;
}

/* ---------------------------------------------------------------------------
 * Reading a stored instant back as a wall clock.
 *
 * `getHours()` and `getDate()` answer in the zone of whichever machine is
 * asking, and these run on both sides: a page.tsx formats on the server, a
 * screen formats in the browser. The server is Vercel and Vercel is UTC, so
 * every timestamp rendered on the server came out FIVE AND A HALF HOURS
 * EARLY — an order taken at 9am appeared as "3:30 am", which reads as a
 * machine writing rows in the middle of the night rather than a person on a
 * call.
 *
 * It hid for the same reason the `::date` version hid: on a laptop set to IST
 * it is correct, so it is right in development and wrong only in production.
 * The zone is named here, once, and the grep test in §11 keeps it named.
 * ------------------------------------------------------------------------- */

const IST_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TIMEZONE,
  day: "numeric",
  month: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

type WallClock = { day: number; month: number; year: number; hour: number; minute: number };

function istParts(d: Date): WallClock | null {
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(
    IST_PARTS.formatToParts(d).map((p) => [p.type, p.value]),
  );
  return {
    day: Number(parts.day),
    month: Number(parts.month),
    year: Number(parts.year),
    // Midnight comes back as "24" in some runtimes under hour12: false.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** Timestamp -> "12 Aug, 10:42 am", in the business's own zone. */
export function stamp(at: Date | string | null | undefined): string {
  if (!at) return "-";
  const d = typeof at === "string" ? new Date(at) : at;
  const p = istParts(d);
  if (!p) return "-";
  return `${p.day} ${MONTHS[p.month - 1]}, ${clock(d)}`;
}

/** Timestamp -> "12 Aug 2026", no time. For a day that has no meaningful one. */
export function stampDate(at: Date | string | null | undefined): string {
  if (!at) return "-";
  const d = typeof at === "string" ? new Date(at) : at;
  const p = istParts(d);
  if (!p) return "-";
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

export function clock(d: Date): string {
  const p = istParts(d);
  if (!p) return "-";
  const suffix = p.hour >= 12 ? "pm" : "am";
  const h = p.hour % 12 || 12;
  return `${h}:${String(p.minute).padStart(2, "0")} ${suffix}`;
}

/** "4 days ago", "today", "in 3 days" */
export function relativeDays(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days === -1) return "tomorrow";
  if (days > 0) return `${days} days ago`;
  return `in ${-days} days`;
}

export function daysBetween(a: string | Date, b: string | Date): number {
  const da = typeof a === "string" ? parseISODate(a) : a;
  const dbb = typeof b === "string" ? parseISODate(b) : b;
  if (!da || !dbb) return 0;
  return Math.round(
    (Date.UTC(dbb.getUTCFullYear(), dbb.getUTCMonth(), dbb.getUTCDate()) -
      Date.UTC(da.getUTCFullYear(), da.getUTCMonth(), da.getUTCDate())) /
      86_400_000,
  );
}

export function parseISODate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/**
 * The wall clock, read once per server render and passed down as a prop.
 * Components never call Date.now() themselves — a value that changes between
 * renders makes filters and elapsed timers jump around.
 */
export function nowMs(): number {
  return Date.now();
}

/**
 * Today in Asia/Kolkata. The server may run in UTC, where "today" flips at
 * 5:30 am IST — mid-morning for a telecaller. Anchor the working day to the
 * team's own clock so the queue and EOD never roll over during a shift.
 */
export function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function toISODate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  if (!d) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/** Indian phone display: 98765 43210 */
/**
 * "+91 98470 55318". The country code is shown because every number here is an
 * Indian mobile and a telecaller reading one aloud, or pasting it into
 * WhatsApp, needs it in full. Storage stays as ten digits.
 */
export function phoneDisplay(phone: string): string {
  const digits = phone.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return phone;
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

/**
 * The status badge on the customer screens. The stored status is one lower-case
 * word and says nothing about slow payment or a customer who has not started
 * yet, so the label the screens were written against is derived here — in one
 * place, so the list and the record cannot disagree.
 */
export function customerStatusLabel(customer: {
  status: string;
  slowPayer?: boolean;
  lastOrderDate?: string | null;
}): "Active" | "Inactive" | "Deactivated" | "Slow payer" | "New" {
  if (customer.status === "deactivated") return "Deactivated";
  // Inactive outranks slow payer: it is the one that says stop and think. The
  // record screen still shows the slow-payer badge beside it.
  if (customer.status === "inactive") return "Inactive";
  if (!customer.lastOrderDate) return "New";
  if (customer.slowPayer) return "Slow payer";
  return "Active";
}

export function ageLabel(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

/* An `agingBucket` lived here too, with bands of its own — 0–30/31–60/61–90 —
 * hardcoded where the real one reads `bills.agingBuckets` from configuration.
 * Nothing imported it, which is the only reason no screen ever disagreed with
 * the ledger. Deleted rather than corrected: a second set of bands is a second
 * thing to change, and the one that matters is
 * `lib/engines/escalation.ts#agingBucket`. */
