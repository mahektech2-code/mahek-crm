/* ---------------------------------------------------------------------------
 * Task rules (spec §13), PURE: which templates a day or a month copies, when
 * a to-do has expired, the days a to-do was given and took, the checklist's
 * week, and the Task EOD message. The screens, the staff-performance figures
 * and the EOD all read these, so they cannot disagree about one task.
 * ------------------------------------------------------------------------- */

import { addDaysISO, daysBetweenISO, daysIn, monthOf, tmin, weekdayOf, WEEKDAYS } from "../time";
import { CHECKLIST_NA } from "../values";

export const FREQUENCIES = ["Daily", "Weekly", "Monthly"] as const;
export const TASK_CATEGORIES = ["Urgent and Important", "Important", "To-Do Only"] as const;

export type TemplateLike = {
  id: string;
  task: string;
  frequency: string;
  weekdays: string[];
  category: string | null;
  dayOfMonth: number | null;
  beforeDay: number | null;
  startTime: string | null;
  endTime: string | null;
};

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-01" → "1 Oct 2026": the date as the task messages print it. */
export function taskDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${Number(d)} ${MON[Number(m) - 1] ?? ""} ${y}`;
}

/** Whether a to-do's category makes it urgent (the design's "Urgent & important" flag). */
export const isUrgentCategory = (category: string | null | undefined) => category === "Urgent and Important";

/* ----------------------------------------------------------- templates */

/**
 * The template form's rules (spec §13.1), each with a sentence that says what
 * to fix. A Daily
 * template with no weekdays picked runs every day — that is what Daily
 * means — while a Weekly one has to say which.
 */
export function checkTemplate(x: {
  frequency: string;
  weekdays: string[];
  category: string | null;
  dayOfMonth: number | null;
  beforeDay: number | null;
  startTime: string | null;
  endTime: string | null;
}): { field: string; message: string } | null {
  if (!(FREQUENCIES as readonly string[]).includes(x.frequency)) return { field: "freq", message: "Pick daily, weekly or monthly" };
  if (x.frequency === "Monthly") {
    if (x.category && !(TASK_CATEGORIES as readonly string[]).includes(x.category)) return { field: "category", message: "Pick a category from the list" };
    if (x.dayOfMonth == null || x.dayOfMonth < 1 || x.dayOfMonth > 31) return { field: "dom", message: "Enter a day of the month from 1 to 31" };
    if (x.beforeDay != null && x.beforeDay <= x.dayOfMonth) return { field: "before", message: `The complete-before day must be later than day ${x.dayOfMonth}` };
    if (x.beforeDay != null && x.beforeDay > 31) return { field: "before", message: "Enter a complete-before day from 1 to 31" };
  } else {
    if (x.weekdays.some((d) => !(WEEKDAYS as readonly string[]).includes(d))) return { field: "weekdays", message: "Pick weekdays from the list" };
    if (x.frequency === "Weekly" && !x.weekdays.length) return { field: "weekdays", message: "Pick the weekdays this task runs on" };
  }
  if (x.startTime && x.endTime && (tmin(x.endTime) ?? 0) <= (tmin(x.startTime) ?? 0)) return { field: "end", message: "The end time must be after the start time" };
  return null;
}

/** The weekdays a template runs on as stored: Daily with none picked is every day, Monthly none. */
export function storedWeekdays(frequency: string, picked: string[]): string[] {
  if (frequency === "Monthly") return [];
  if (frequency === "Daily" && !picked.length) return [...WEEKDAYS];
  return WEEKDAYS.filter((d) => picked.includes(d));
}

/** Take my task (spec §13.1): the non-Monthly templates whose weekdays include this date's. */
export function templatesForDay<T extends Pick<TemplateLike, "frequency" | "weekdays">>(templates: T[], date: string): T[] {
  const wd = weekdayOf(date);
  return templates.filter((t) => t.frequency !== "Monthly" && t.weekdays.includes(wd));
}

/** Take monthly task: the Monthly templates. */
export function monthlyTemplates<T extends Pick<TemplateLike, "frequency">>(templates: T[]): T[] {
  return templates.filter((t) => t.frequency === "Monthly");
}

/**
 * The for-date and till-date a Monthly template's to-do gets in a month. Both
 * are clamped to the month's length: a template for the 31st still lands in
 * September, on the 30th, rather than rolling into October or vanishing.
 */
export function monthlyTodoDates(month: string, dayOfMonth: number | null, beforeDay: number | null): { forDate: string; tillDate: string | null } {
  const last = daysIn(month);
  const day = (n: number) => `${month}-${String(Math.min(Math.max(1, n), last)).padStart(2, "0")}`;
  return { forDate: day(dayOfMonth ?? 1), tillDate: beforeDay == null ? null : day(beforeDay) };
}

/** Share task (spec §13.4): my templates for today's weekday, minus what I already shared today. */
export function buddySuggestions(templates: Pick<TemplateLike, "task" | "frequency" | "weekdays">[], date: string, sharedToday: string[]): string[] {
  const shared = new Set(sharedToday.map((s) => s.trim().toLowerCase()));
  return [...new Set(templatesForDay(templates, date).map((t) => t.task))].filter((t) => !shared.has(t.trim().toLowerCase()));
}

/* ----------------------------------------------------------- checklist */

/** Whether two dates fall in the same week — Sunday to Saturday, as the source's WEEKNUM counts it. */
export function sameWeek(a: string, b: string): boolean {
  const start = (d: string) => addDaysISO(d, -WEEKDAYS.indexOf(weekdayOf(d)));
  return start(a) === start(b);
}

/** A checklist item's status that still counts as not done: blank or Not Done. */
export const checklistOpen = (status: string) => status === "" || status === "Not Done";

/** The checklist chips: Today, still blank this week, or Earlier. */
export function checklistBucket(date: string, status: string, today: string): "Today" | "Not done this week" | "Earlier" {
  if (date === today) return "Today";
  if (checklistOpen(status) && date < today && sameWeek(date, today)) return "Not done this week";
  return "Earlier";
}

/** Time difference (spec §13.2): working time − end time, in minutes; null without both. */
export function timeDifference(workingTime: string | null, endTime: string | null): number | null {
  const w = tmin(workingTime);
  const e = tmin(endTime);
  return w == null || e == null ? null : w - e;
}

/* --------------------------------------------------------------- to-dos */

/** Marking a to-do is refused once its till date has passed (spec §13.3, A26). */
export function todoExpired(tillDate: string | null, today: string): boolean {
  return tillDate != null && today > tillDate;
}

export function expiredMessage(task: string, tillDate: string): string {
  return `“${task}” was due by ${taskDate(tillDate)} and has expired, so it can no longer be marked`;
}

/**
 * An open to-do past its till date — or, with none, past its for date — is
 * overdue. The source hid these (A35); HRMS keeps them listed and says so.
 */
export function todoOverdue(t: { status: string; forDate: string; tillDate: string | null }, today: string): boolean {
  return t.status === "Open" && (t.tillDate ?? t.forDate) < today;
}

/** Days taken: the day it was done − the for date. */
export function daysTaken(forDate: string, doneOn: string | null): number | null {
  return doneOn ? Math.max(0, daysBetweenISO(forDate, doneOn)) : null;
}

/** Days given: till date − for date; without a till date, to the end of the for date's month. */
export function daysGiven(forDate: string, tillDate: string | null): number {
  const end = tillDate ?? `${monthOf(forDate)}-${String(daysIn(monthOf(forDate))).padStart(2, "0")}`;
  return daysBetweenISO(forDate, end);
}

/** Average days taken by one assignee over the to-dos they finished in one month, to one decimal. */
export function averageDaysTaken(done: { toEmployeeId: string; forDate: string; doneOn: string | null }[], employeeId: string, doneMonth: string): number | null {
  const mine = done.filter((t) => t.toEmployeeId === employeeId && t.doneOn && monthOf(t.doneOn) === doneMonth);
  if (!mine.length) return null;
  const total = mine.reduce((s, t) => s + (daysTaken(t.forDate, t.doneOn) ?? 0), 0);
  return Math.round((total / mine.length) * 10) / 10;
}

/** The to-do tabs: still open, done and waiting for the giver, or verified history. */
export function todoTab(status: string, recheck: string): "Open" | "To verify" | "History" {
  if (status === "Open") return "Open";
  return recheck === "Verified" ? "History" : "To verify";
}

/* ------------------------------------------------------------- Task EOD */

export type EodChecklist = { task: string; status: string; naReason: string | null; remark: string | null };
export type EodTodo = { task: string; status: string; forDate: string; toEmployeeId: string };

/** Up to five, numbered, one per line: "1. …\n2. …". A dash when there are none. */
function numbered(items: string[]): string {
  const five = items.slice(0, 5);
  return five.length ? five.map((x, i) => `${i + 1}. ${x}`).join("\n") : "-";
}

/**
 * The Task EOD message (spec §13.5), in the source's layout. The overdue list
 * is the to-dos given to this person, still open, for a date up to today in
 * this month — oldest first.
 */
export function taskEodMessage(x: { name: string; employeeId: string; today: string; checklist: EodChecklist[]; todos: EodTodo[] }): string {
  const done = x.checklist.filter((c) => c.status === "Done").length;
  const na = x.checklist.filter((c) => c.status === CHECKLIST_NA);
  const pending = x.checklist.filter((c) => checklistOpen(c.status)).length;
  const month = monthOf(x.today);
  const overdue = x.todos
    .filter((t) => t.toEmployeeId === x.employeeId && t.status === "Open" && t.forDate <= x.today && monthOf(t.forDate) === month)
    .sort((a, b) => a.forDate.localeCompare(b.forDate));
  const rule = "--------------------------------";
  return [
    `*📝 Task EOD - ${x.name}*`,
    `📅 *Date:* ${taskDate(x.today)}`,
    rule,
    "📊 *Summary:*",
    `🔹 *Total tasks:* ${x.checklist.length}`,
    `✅ *Completed:* ${done}`,
    `⏳ *Pending:* ${pending}`,
    `🚫 *Not applicable:* ${na.length}`,
    rule,
    "🚫 *Not applicable tasks:*",
    `*Task:* ${numbered(na.map((c) => c.task))}`,
    `*Reason:* ${numbered(na.map((c) => c.naReason ?? c.remark ?? ""))}`,
    rule,
    "⚠ *Overdue and pending to-dos:*",
    numbered(overdue.map((t) => t.task)),
  ].join("\n");
}

/** The digits of a configured phone number, for a wa.me link. */
export function waDigits(phone: string): string {
  return String(phone ?? "").replace(/\D/g, "");
}
