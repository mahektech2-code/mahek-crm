import { APP_TIMEZONE } from "@/lib/business-date";

/**
 * Today and the "HH:MM" clock in the app's zone — what `routineMissed` is
 * asked against on the server. Named zone, never the machine's: the server
 * runs in UTC and a routine due at 6 PM is due at 6 PM in India.
 */
export function appClock(now = new Date()): { day: string; hm: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}` };
}
