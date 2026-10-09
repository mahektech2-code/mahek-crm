/* ---------------------------------------------------------------------------
 * The floor's clock. PURE and client-safe: the phone and the server both
 * compare "is this job late" against an "HH:MM" in Asia/Kolkata, and a phone
 * whose own zone is wrong must not move a deadline.
 * ------------------------------------------------------------------------- */
import { APP_TIMEZONE } from "@/lib/business-date";

const HM = new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE, weekday: "long", day: "numeric", month: "long" });

/** "09:05" */
export function hhmm(at: Date): string {
  return HM.format(at);
}

/** "Friday, 9 October" */
export function dayLine(at: Date): string {
  const parts = DAY.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")}, ${get("day")} ${get("month")}`;
}

/** Minutes between two "HH:MM" readings on one day; never negative. */
export function minutesBetween(from: string, to: string): number {
  const m = (s: string) => {
    const [h, mm] = s.split(":").map(Number);
    return (h || 0) * 60 + (mm || 0);
  };
  return Math.max(0, m(to) - m(from));
}
