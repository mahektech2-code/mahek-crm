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

/**
 * "15:00" -> "3 PM", "09:05" -> "9:05 AM". The floor reads a 12-hour clock;
 * every "HH:MM" the app stores and compares stays 24-hour, and is turned into
 * words only where a person reads it. Anything that is not an "HH:MM" comes
 * back unchanged.
 */
export function clock12(hm: string | null | undefined): string {
  const m = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(hm ?? "");
  if (!m) return hm ?? "";
  const h = Number(m[1]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + (m[2] === "00" ? "" : ":" + m[2]) + (h < 12 ? " AM" : " PM");
}

/** Every "HH:MM" inside a sentence, said the 12-hour way ("Today 14:30 · Ravi" -> "Today 2:30 PM · Ravi"). */
export function clockText(text: string | null | undefined): string {
  return (text ?? "").replace(/(^|[^\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g, (_, pre: string, h: string, mm: string) => pre + clock12(h + ":" + mm));
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
