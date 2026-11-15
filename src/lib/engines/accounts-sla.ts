/* ---------------------------------------------------------------------------
 * THE ACCOUNTS DEADLINE — how long something has waited on the ledger desk,
 * counted in WORKING hours, and when it went past the deadline.
 *
 * Pure: the working week, the shift and the company holidays arrive as
 * arguments, and nothing here reads a clock or a database. The service hands
 * it the pending orders, payments, credit notes and order changes; this says
 * which of them are late and by how much.
 *
 * TWO CLOCKS, because "24 working hours" means two things to two people and
 * the setting says which this deployment meant:
 *
 * - `working_days` — every hour of a working day counts, all twenty-four of
 *   them, and a Sunday or a company holiday counts none. An order raised on
 *   Saturday at 4 pm is due Monday at 4 pm. This is the default: it is what
 *   "within a working day" means to the person waiting on the answer.
 * - `office_hours` — only the hours between shift start and shift end count.
 *   With a ten-hour shift, 24 hours is two and a half office days.
 *
 * India keeps one offset all year, so the zone is a fixed +05:30 here; a
 * stored instant is turned into its local wall clock by adding it, never by
 * asking the machine's zone (which on the server is UTC).
 * ------------------------------------------------------------------------- */

import { calendarDate } from "@/lib/business-date";

export type SlaClock = "working_days" | "office_hours";

export type SlaCalendar = {
  clock: SlaClock;
  /** ISO weekdays that are worked: Monday 1 … Sunday 7. */
  workingDays: readonly number[];
  /** "HH:MM", local. Read only by the office-hours clock. */
  shiftStart: string;
  shiftEnd: string;
  /** Company-wide holidays, "YYYY-MM-DD", local. */
  holidays: ReadonlySet<string>;
};

export type SlaKind = "order" | "payment" | "credit_note" | "order_change";

export const SLA_KIND_LABEL: Record<SlaKind, string> = {
  order: "Order approval",
  payment: "Payment to confirm",
  credit_note: "Credit note request",
  order_change: "Order change request",
};

export const SLA_KINDS: readonly SlaKind[] = ["order", "payment", "credit_note", "order_change"];

const IST_MS = 330 * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function minutesOf(hhmm: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return fallback;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 24 * 60 ? v : fallback;
}

/** The local calendar day an instant falls on, "YYYY-MM-DD". */
export function localDay(ms: number): string {
  return calendarDate(new Date(ms));
}

/** Local midnight (as a UTC instant) of the day containing `ms`. */
function localMidnight(ms: number): number {
  const local = ms + IST_MS;
  return local - (((local % DAY) + DAY) % DAY) - IST_MS;
}

function isoWeekday(dayStartMs: number): number {
  const d = new Date(dayStartMs + IST_MS).getUTCDay(); // 0 = Sunday
  return d === 0 ? 7 : d;
}

/** The part of one local day that counts, as [from, to) offsets from its midnight. */
function countedWindow(dayStartMs: number, cal: SlaCalendar): [number, number] | null {
  if (!cal.workingDays.includes(isoWeekday(dayStartMs))) return null;
  if (cal.holidays.has(localDay(dayStartMs))) return null;
  if (cal.clock === "working_days") return [0, DAY];
  const s = minutesOf(cal.shiftStart, 9 * 60) * 60_000;
  const e = minutesOf(cal.shiftEnd, 19 * 60) * 60_000;
  return e > s ? [s, e] : null;
}

/** A calendar with nothing counted would never fall due — refuse it rather than loop. */
function workable(cal: SlaCalendar): boolean {
  if (!cal.workingDays.some((d) => d >= 1 && d <= 7)) return false;
  if (cal.clock === "office_hours") {
    return minutesOf(cal.shiftEnd, 19 * 60) > minutesOf(cal.shiftStart, 9 * 60);
  }
  return true;
}

/** Working milliseconds between two instants (0 if `to` is not after `from`). */
export function workingMsBetween(fromMs: number, toMs: number, cal: SlaCalendar): number {
  if (!(toMs > fromMs) || !workable(cal)) return 0;
  let total = 0;
  // A guard of three years of days: a wait longer than that is not a queue.
  for (let day = localMidnight(fromMs), n = 0; day < toMs && n < 1100; day += DAY, n++) {
    const w = countedWindow(day, cal);
    if (!w) continue;
    const a = Math.max(fromMs, day + w[0]);
    const b = Math.min(toMs, day + w[1]);
    if (b > a) total += b - a;
  }
  return total;
}

/** The instant `hours` working hours after `fromMs` — when the deadline falls. */
export function addWorkingHours(fromMs: number, hours: number, cal: SlaCalendar): number | null {
  if (!workable(cal)) return null;
  let left = Math.max(0, hours) * HOUR;
  if (left === 0) return fromMs;
  for (let day = localMidnight(fromMs), n = 0; n < 1100; day += DAY, n++) {
    const w = countedWindow(day, cal);
    if (!w) continue;
    const a = Math.max(fromMs, day + w[0]);
    const b = day + w[1];
    if (b <= a) continue;
    if (b - a >= left) return a + left;
    left -= b - a;
  }
  return null;
}

export type SlaCandidate = { kind: SlaKind; recordId: string; sinceMs: number };

export type SlaVerdict = SlaCandidate & {
  /** Working hours it has waited so far. */
  waitedHours: number;
  /** When the deadline fell (or falls). */
  dueMs: number | null;
  overdue: boolean;
};

export function judge(c: SlaCandidate, nowMs: number, limitHours: number, cal: SlaCalendar): SlaVerdict {
  const dueMs = addWorkingHours(c.sinceMs, limitHours, cal);
  return {
    ...c,
    waitedHours: workingMsBetween(c.sinceMs, nowMs, cal) / HOUR,
    dueMs,
    overdue: dueMs !== null && nowMs >= dueMs,
  };
}

/**
 * How many FURTHER escalations an overdue item has earned: one for every
 * `everyHours` working hours past its deadline. The first notice (at the
 * deadline itself) is not counted here — this is what comes after it.
 */
export function escalationLevel(dueMs: number, nowMs: number, everyHours: number, cal: SlaCalendar): number {
  if (!(everyHours > 0)) return 0;
  return Math.floor(workingMsBetween(dueMs, nowMs, cal) / (everyHours * HOUR));
}

/* ---------------------------------------------------------- the reminders */

export type RemindChoice = "1h" | "1d" | "2d" | "custom";

export const REMIND_CHOICES: { key: RemindChoice; label: string }[] = [
  { key: "1h", label: "In 1 hour" },
  { key: "1d", label: "Tomorrow, same time" },
  { key: "2d", label: "In 2 days" },
  { key: "custom", label: "Pick a time" },
];

/** The latest a reminder may be set — a "remind me" a fortnight out is a way of not answering. */
export const MAX_REMIND_DAYS = 7;
export const MIN_REMARK_CHARS = 10;

export function remindAtFor(choice: RemindChoice, nowMs: number, customMs: number | null): number | null {
  if (choice === "1h") return nowMs + HOUR;
  if (choice === "1d") return nowMs + DAY;
  if (choice === "2d") return nowMs + 2 * DAY;
  return customMs;
}

/** Why a reason and reminder cannot be saved, or null. One sentence, shown and enforced. */
export function remarkProblem(body: string, remindAtMs: number | null, nowMs: number): string | null {
  if (body.trim().length < MIN_REMARK_CHARS) {
    return `Write why it is not done yet — at least ${MIN_REMARK_CHARS} characters.`;
  }
  if (remindAtMs === null || !Number.isFinite(remindAtMs)) return "Choose when to be reminded.";
  if (remindAtMs <= nowMs) return "The reminder has to be in the future.";
  if (remindAtMs > nowMs + MAX_REMIND_DAYS * DAY) return `A reminder can be at most ${MAX_REMIND_DAYS} days away.`;
  return null;
}

/** "26 h", "3 d 4 h" — working hours, for a table cell. */
export function hoursLabel(h: number): string {
  const whole = Math.max(0, Math.floor(h));
  if (whole < 48) return `${whole} h`;
  const d = Math.floor(whole / 24);
  const r = whole % 24;
  return r ? `${d} d ${r} h` : `${d} d`;
}
