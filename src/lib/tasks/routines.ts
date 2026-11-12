/* ---------------------------------------------------------------------------
 * ROUTINES — a task that comes back on a schedule. PURE, client-safe, no I/O.
 *
 * A routine is daily or weekly on the weekdays it names, or monthly on a day
 * of the month. On each day it falls due it writes one ordinary task, and
 * `occurrenceOn` is the one answer to "does it, and when is that task due" —
 * the job that writes the tasks, the screen that describes the routine and the
 * tests all ask it, so they cannot disagree about a day.
 *
 * DAILY AND WEEKLY ARE THE SAME RULE, said two ways. Both run on the weekdays
 * they name; "daily" is the word for most of the week and "weekly" for one or
 * two days of it, and the old Task EMP app kept them apart for that reason.
 *
 * A MONTHLY DAY PAST THE END OF A SHORT MONTH lands on its last day. A routine
 * for the 31st still happens in September, on the 30th, rather than skipping
 * the month — a missed month is a missed GST payment.
 * ------------------------------------------------------------------------- */

import { TASK_PRIORITIES, TITLE_MAX, NOTE_MAX, canFileUnder, clock12, type FieldProblem } from "./rules";

export const ROUTINE_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type RoutineFrequency = (typeof ROUTINE_FREQUENCIES)[number];

export const FREQUENCY_LABEL: Record<RoutineFrequency, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

/** 0 = Sunday … 6 = Saturday, as `Date.getUTCDay` counts. */
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** Monday to Saturday — the working week, and what a new daily routine starts with. */
export const WORKING_WEEK = [1, 2, 3, 4, 5, 6];

export type RoutineSchedule = {
  frequency: RoutineFrequency;
  weekdays: number[];
  dayOfMonth: number | null;
  completeByDay: number | null;
  startsOn: string;
  active: boolean;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** The weekday of a "YYYY-MM-DD", read off its parts — no zone is involved. */
export function weekdayOf(day: string): number {
  return new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** That day of `day`'s month, held to the month's last day. */
function dayOfSameMonth(day: string, n: number): string {
  const y = +day.slice(0, 4);
  const m = +day.slice(5, 7);
  return `${y}-${pad(m)}-${pad(Math.min(n, daysInMonth(y, m)))}`;
}

/**
 * Whether the routine writes a task on `day`, and the day that task is due.
 * Null for a paused routine, a day before it starts, and a day it does not run.
 */
export function occurrenceOn(r: RoutineSchedule, day: string): { dueDate: string } | null {
  if (!r.active || day < r.startsOn) return null;
  if (r.frequency === "monthly") {
    if (r.dayOfMonth == null || dayOfSameMonth(day, r.dayOfMonth) !== day) return null;
    return { dueDate: r.completeByDay == null ? day : dayOfSameMonth(day, r.completeByDay) };
  }
  return r.weekdays.includes(weekdayOf(day)) ? { dueDate: day } : null;
}

/** "Every day", "Mon to Sat", "Every Tue and Fri", "Monthly on the 25th, done by the 30th". */
export function scheduleWords(r: Pick<RoutineSchedule, "frequency" | "weekdays" | "dayOfMonth" | "completeByDay">): string {
  if (r.frequency === "monthly") {
    const on = `Monthly on the ${ordinal(r.dayOfMonth ?? 1)}`;
    return r.completeByDay ? `${on}, done by the ${ordinal(r.completeByDay)}` : on;
  }
  const days = [...new Set(r.weekdays)].sort((a, b) => a - b);
  if (days.length === 7) return "Every day";
  if (days.join() === WORKING_WEEK.join()) return "Mon to Sat";
  if (days.join() === "1,2,3,4,5") return "Mon to Fri";
  const names = days.map((d) => WEEKDAY_SHORT[d]);
  return `Every ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]}`;
}

/** "2 PM to 4 PM", "by 4 PM", "from 2 PM", or nothing. */
export function windowWords(startTime: string | null, dueTime: string | null): string {
  if (startTime && dueTime) return `${clock12(startTime)} to ${clock12(dueTime)}`;
  if (dueTime) return `by ${clock12(dueTime)}`;
  if (startTime) return `from ${clock12(startTime)}`;
  return "";
}

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

/* ------------------------------------------------------------- checking */

export type RoutineInput = {
  title: string;
  app: string;
  priority: string;
  frequency: string;
  weekdays: number[];
  dayOfMonth: number | null;
  completeByDay: number | null;
  startTime: string | null;
  dueTime: string | null;
  note?: string | null;
};

const TIME = /^[0-2]\d:[0-5]\d$/;

/** Everything wrong with a routine, field by field. Empty means it can be saved. */
export function routineProblems(r: RoutineInput, opts: { keepApp?: string | null } = {}): FieldProblem[] {
  const out: FieldProblem[] = [];
  const title = r.title.trim();
  if (!title) out.push({ field: "title", message: "Say what needs doing." });
  else if (title.length > TITLE_MAX) out.push({ field: "title", message: `Keep it under ${TITLE_MAX} characters — put the detail in the note.` });
  // A routine filed under an app before it closed to new tasks keeps it on an edit.
  if (!canFileUnder(r.app) && r.app !== opts.keepApp) out.push({ field: "app", message: "Pick the app this work happens in." });
  if (!(TASK_PRIORITIES as readonly string[]).includes(r.priority)) out.push({ field: "priority", message: "Pick a priority." });
  if ((r.note ?? "").length > NOTE_MAX) out.push({ field: "note", message: `Keep the note under ${NOTE_MAX} characters.` });
  if (!(ROUTINE_FREQUENCIES as readonly string[]).includes(r.frequency)) {
    out.push({ field: "frequency", message: "Pick daily, weekly or monthly." });
  } else if (r.frequency === "monthly") {
    const d = r.dayOfMonth;
    if (d == null || !Number.isInteger(d) || d < 1 || d > 31) out.push({ field: "dayOfMonth", message: "Pick a day of the month, 1 to 31." });
    else if (r.completeByDay != null && (!Number.isInteger(r.completeByDay) || r.completeByDay <= d || r.completeByDay > 31)) {
      out.push({ field: "completeByDay", message: `The done-by day must come after the ${ordinal(d)}.` });
    }
  } else if (!r.weekdays.length || r.weekdays.some((w) => !Number.isInteger(w) || w < 0 || w > 6)) {
    out.push({ field: "weekdays", message: "Pick the days it runs on." });
  }
  if (r.startTime && !TIME.test(r.startTime)) out.push({ field: "startTime", message: "Use a time like 14:00." });
  if (r.dueTime && !TIME.test(r.dueTime)) out.push({ field: "dueTime", message: "Use a time like 16:00." });
  if (r.startTime && r.dueTime && TIME.test(r.startTime) && TIME.test(r.dueTime) && r.dueTime <= r.startTime) {
    out.push({ field: "dueTime", message: "The end time must be after the start time." });
  }
  return out;
}

/** What a routine stores, from what was typed: weekdays only for daily/weekly, month days only for monthly. */
export function normaliseRoutine<T extends RoutineInput>(r: T): T {
  const monthly = r.frequency === "monthly";
  return {
    ...r,
    title: r.title.trim(),
    note: r.note?.trim() ? r.note.trim() : null,
    weekdays: monthly ? [] : [...new Set(r.weekdays)].sort((a, b) => a - b),
    dayOfMonth: monthly ? r.dayOfMonth : null,
    completeByDay: monthly ? r.completeByDay : null,
    startTime: r.startTime || null,
    dueTime: r.dueTime || null,
  };
}
