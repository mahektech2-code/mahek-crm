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

/** Timestamp -> "12 Aug, 10:42 am" */
export function stamp(at: Date | string | null | undefined): string {
  if (!at) return "-";
  const d = typeof at === "string" ? new Date(at) : at;
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${day}, ${clock(d)}`;
}

export function clock(d: Date): string {
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const suffix = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m} ${suffix}`;
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

/** Aging bucket used across bills, payments and the aging bar. */
export function agingBucket(overdueDays: number): string {
  if (overdueDays <= 0) return "Not due";
  if (overdueDays <= 30) return "0–30 days";
  if (overdueDays <= 60) return "31–60 days";
  if (overdueDays <= 90) return "61–90 days";
  return "90+ days";
}

export const AGING_BUCKETS = [
  "0–30 days",
  "31–60 days",
  "61–90 days",
  "90+ days",
] as const;

export const BUCKET_COLOURS: Record<string, string> = {
  "0–30 days": "#6835FB",
  "31–60 days": "#B77B08",
  "61–90 days": "#D97706",
  "90+ days": "#B3261E",
};
