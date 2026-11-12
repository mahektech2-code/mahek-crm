import { APP_TIMEZONE } from "@/lib/business-date";
// Date helpers. Never depend on the server's time zone and never slice an ISO timestamp to get a
// date: everything goes through an explicit locale (en-IN) and an explicit time zone (APP_TIMEZONE).

export const LOCALE = "en-IN";
export const TIME_ZONE = APP_TIMEZONE;

const MS_MINUTE = 60_000;
const MS_HOUR = 3_600_000;

function parts(date: Date, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, ...options }).formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** The calendar date in India for an instant, as "YYYY-MM-DD". */
export function istDateKey(instant: Date | string): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  const p = parts(d, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}

/** Hour of the day (0 to 23) in India. */
export function istHour(instant: Date): number {
  return Number(parts(instant, { hour: "2-digit", hourCycle: "h23" }).hour);
}

/** Whole calendar days from `fromKey` to `toKey` (both "YYYY-MM-DD"). */
export function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86_400_000);
}

/** "20 Oct 2026" for a date-only string. Formatted in UTC so the day never shifts. */
export function formatDateOnly(dateOnly: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${dateOnly}T00:00:00Z`));
}

/** "Wednesday, 7 Oct 2026" for an instant, in India. */
export function formatLongDate(instant: Date): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "short", year: "numeric" }).format(instant);
}

/** "9:40 am" for an instant, in India. */
export function formatClock(instant: Date): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit", hour12: true }).format(instant).replace(/\s?([ap]m)$/i, " $1").toLowerCase();
}

export function dayGreeting(instant: Date): "Good morning" | "Good afternoon" | "Good evening" {
  const h = istHour(instant);
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/** True when the instant falls on the same calendar day (in India) as `now`. */
export function isSameIstDay(instant: Date | string, now: Date): boolean {
  return istDateKey(instant) === istDateKey(now);
}

/**
 * "12 minutes ago", "2 hours ago", "Today, 9:40 am", "Yesterday", "3 days ago", or a date.
 * Same-day older than 6 hours shows the clock time, as in the approved prototype.
 */
export function relativeAdded(addedAt: string, now: Date): string {
  const at = new Date(addedAt);
  const diff = now.getTime() - at.getTime();
  if (diff < 0) return formatDateOnly(istDateKey(at));
  if (isSameIstDay(at, now)) {
    if (diff < MS_HOUR) {
      const m = Math.max(1, Math.round(diff / MS_MINUTE));
      return `${m} minute${m === 1 ? "" : "s"} ago`;
    }
    if (diff < 6 * MS_HOUR) {
      const h = Math.floor(diff / MS_HOUR);
      return `${h} hour${h === 1 ? "" : "s"} ago`;
    }
    return `Today, ${formatClock(at)}`;
  }
  const days = daysBetween(istDateKey(at), istDateKey(now));
  if (days === 1) return "Yesterday";
  if (days <= 30) return `${days} days ago`;
  return formatDateOnly(istDateKey(at));
}

/** "7 Oct 2026, 3:52 pm" for an instant, in India. */
export function formatDateTime(instant: Date | string): string {
  const at = typeof instant === "string" ? new Date(instant) : instant;
  return `${formatDateOnly(istDateKey(at))}, ${formatClock(at)}`;
}
