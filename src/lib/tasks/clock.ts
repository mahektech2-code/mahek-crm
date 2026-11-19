import { APP_TIMEZONE } from "@/lib/business-date";

/**
 * THE TASKS CLOCK. Every "is it past its due time" question Tasks asks — the
 * JS one (`appClock`) and the SQL one (`markMissedRoutineTasks` binds
 * `tasksNow()` instead of reading the database's `now()`) — reads this one
 * moment, so a test can pin it. Without the pin, the routine tests failed for
 * the grace time after every midnight in India: yesterday's task was still in
 * its grace and today's 00:00 task had not yet run out of it.
 */
let pinned: Date | null = null;

/** Tests only: hold the Tasks clock at `at` (null lets it run again). Refused outside NODE_ENV=test. */
export function pinTasksClock(at: Date | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("The Tasks clock is pinned only in tests.");
  pinned = at;
}

/** Now, as Tasks reads it: the real time, unless a test has pinned it. */
export function tasksNow(): Date {
  return pinned ? new Date(pinned) : new Date();
}

/**
 * Today and the "HH:MM" clock in the app's zone — what `routineMissed` is
 * asked against on the server. Named zone, never the machine's: the server
 * runs in UTC and a routine due at 6 PM is due at 6 PM in India.
 */
export function appClock(now = tasksNow()): { day: string; hm: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}` };
}
