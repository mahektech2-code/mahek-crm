/* ---------------------------------------------------------------------------
 * The old AppSheet "Task EMP 2.0" workbook, read into the MahekOne Tasks app.
 * PURE — the script that reads the sheet and writes the rows is
 * scripts/import-task-emp.ts.
 *
 * The TASK LIST tab is routines: each row becomes a `task_routines` row,
 * checked by `routineProblems`, the same rule the Routines form runs, so
 * nothing lands that the screen itself would have refused. The TO DO LIST tab
 * is one-off tasks: each row becomes a `tasks` row.
 *
 * People are matched by NAME to MahekOne accounts, because a task belongs to
 * somebody who can sign in. What the sheet got wrong is either corrected by a
 * NAMED fix below — keyed on the Sr. No and the exact values it replaces, so a
 * sheet edited since is refused rather than silently re-corrected — or held
 * back and said out loud.
 * ------------------------------------------------------------------------- */

import { routineProblems, WEEKDAY_NAMES, WORKING_WEEK, type RoutineFrequency } from "./routines";

export type SheetRow = { rowNumber: number; cells: Record<string, string> };
/** A MahekOne account the sheet's names are matched against. */
export type EmployeeRef = { id: string; code: string; name: string; active: boolean };

export type RoutineDraft = {
  sr: number;
  rowNumber: number;
  assigneeId: string;
  assigneeName: string;
  title: string;
  note: string | null;
  frequency: RoutineFrequency;
  weekdays: number[];
  dayOfMonth: number | null;
  completeByDay: number | null;
  startTime: string | null;
  dueTime: string | null;
  priority: "urgent" | "high" | "normal";
  fixes: string[];
};

export type Skipped = { sr: string; rowNumber: number; name: string; task: string; reason: string };

/** Names the sheet spells differently from the account. Confirmed by the business, 2026-11-11. */
export const NAME_ALIASES: Record<string, string> = {
  "vaishali shivaji chaudhari": "sarthika sandesh londhe",
};

/**
 * Corrections to individual rows, each stating what it expects to find. An
 * end time before its start time on these rows is a 12-hour clock typed into a
 * 24-hour field (11:00 to 01:00 is 11 am to 1 pm).
 */
export const ROW_FIXES: Record<number, { expect: { start: string; end: string }; set: { start?: string | null; end?: string | null }; why: string }> = {
  313: { expect: { start: "11:00", end: "01:00" }, set: { end: "13:00" }, why: "end 01:00 read as 13:00" },
  397: { expect: { start: "12:30", end: "01:30" }, set: { end: "13:30" }, why: "end 01:30 read as 13:30" },
  433: { expect: { start: "11:00", end: "05:00" }, set: { end: "17:00" }, why: "end 05:00 read as 17:00" },
  615: { expect: { start: "11:00", end: "05:00" }, set: { end: "17:00" }, why: "end 05:00 read as 17:00" },
  263: { expect: { start: "12:02", end: "12:02" }, set: { end: null }, why: "end equal to start dropped" },
};

/** Weekly rows the sheet gave no weekday. Filled in only once somebody says which day. */
export const WEEKLY_DAY_FIXES: Record<number, string[]> = {};

/** The sheet's categories, as a priority. Anything else is normal. */
const PRIORITY: Record<string, "urgent" | "high" | "normal"> = { "Urgent and Important": "urgent", Important: "high", "To-Do Only": "normal" };

export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** "14:00:00" → "14:00"; blank → null; anything else → undefined (unreadable). */
export function hhmm(v: string): string | null | undefined {
  if (!v) return null;
  const m = v.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** The identity of a routine: two rows equal on this are one routine. */
export const routineKey = (t: Pick<RoutineDraft, "assigneeId" | "title" | "frequency" | "weekdays" | "dayOfMonth" | "startTime">) =>
  [t.assigneeId, norm(t.title), t.frequency, t.weekdays.join(","), t.dayOfMonth ?? "", t.startTime ?? ""].join("|");

/**
 * The Task List tab as routines. A "Daily" row naming no days runs Monday to
 * Saturday — the old app's own daily log holds one Sunday in 65,000 rows, so
 * "every day" there meant every working day.
 */
export function mapTaskList(rows: SheetRow[], accounts: EmployeeRef[]): { drafts: RoutineDraft[]; skipped: Skipped[] } {
  const byName = new Map<string, EmployeeRef[]>();
  for (const e of accounts) byName.set(norm(e.name), [...(byName.get(norm(e.name)) ?? []), e]);

  const drafts: RoutineDraft[] = [];
  const skipped: Skipped[] = [];
  const seen = new Map<string, number>();

  for (const { rowNumber, cells } of rows) {
    const g = (k: string) => (cells[k] ?? "").trim();
    const sr = g("Sr. No");
    const name = g("Name Of Employee");
    const task = g("Task").replace(/\s*\n\s*/g, " ").trim();
    const skip = (reason: string) => skipped.push({ sr, rowNumber, name, task, reason });

    if (!/^\d+$/.test(sr)) { skip("Sr. No is not a number"); continue; }
    const srn = Number(sr);
    const matches = byName.get(NAME_ALIASES[norm(name)] ?? norm(name)) ?? [];
    if (matches.length === 0) { skip(`no MahekOne login for “${name}”`); continue; }
    if (matches.length > 1) { skip(`${matches.length} logins are named “${name}”`); continue; }
    const who = matches[0];
    if (!who.active) { skip(`${who.name}'s login is switched off`); continue; }
    if (!task) { skip("no task text"); continue; }

    const sheetFrequency = g("Frequency");
    const frequency = sheetFrequency.toLowerCase() as RoutineFrequency;
    const monthly = frequency === "monthly";
    const fixes: string[] = [];
    let days = g("Days").split(",").map((d) => d.trim()).filter(Boolean);
    if (frequency === "weekly" && !days.length && WEEKLY_DAY_FIXES[srn]) {
      days = WEEKLY_DAY_FIXES[srn];
      fixes.push(`weekday set to ${days.join(", ")}`);
    }
    const unknown = days.find((d) => !(WEEKDAY_NAMES as readonly string[]).includes(d));
    if (unknown) { skip(`a weekday the app does not know: “${unknown}”`); continue; }
    let weekdays = days.map((d) => (WEEKDAY_NAMES as readonly string[]).indexOf(d)).sort((a, b) => a - b);
    if (frequency === "daily" && !weekdays.length) {
      weekdays = [...WORKING_WEEK];
      fixes.push("no days named — Monday to Saturday");
    }

    let startTime = hhmm(g("Start Time"));
    let dueTime = hhmm(g("End Time"));
    if (startTime === undefined || dueTime === undefined) { skip(`unreadable time “${g("Start Time")}” – “${g("End Time")}”`); continue; }
    const fix = ROW_FIXES[srn];
    if (fix) {
      if (fix.expect.start !== startTime || fix.expect.end !== dueTime) {
        skip(`a correction is named for this row but it now reads ${startTime}–${dueTime}, not ${fix.expect.start}–${fix.expect.end}`);
        continue;
      }
      if ("start" in fix.set) startTime = fix.set.start ?? null;
      if ("end" in fix.set) dueTime = fix.set.end ?? null;
      fixes.push(fix.why);
    }

    // A monthly row's day columns; a "Till Date" of 0 is the sheet's blank.
    const dom = g("Date");
    const till = g("Till Date");
    const input = {
      title: task.length > 200 ? `${task.slice(0, 199)}…` : task,
      app: "tasks",
      priority: PRIORITY[g("Category")] ?? "normal",
      frequency,
      weekdays: monthly ? [] : weekdays,
      dayOfMonth: monthly && dom ? Number(dom) : null,
      completeByDay: monthly && till && till !== "0" ? Number(till) : null,
      startTime,
      dueTime,
    };
    const bad = routineProblems(input);
    if (bad.length) {
      skip(frequency === "weekly" && !days.length ? "a Weekly task with no weekday — which day does it run?" : `${sheetFrequency}: ${bad[0].message}`);
      continue;
    }

    const draft: RoutineDraft = {
      sr: srn,
      rowNumber,
      assigneeId: who.id,
      assigneeName: who.name,
      title: input.title,
      note: task.length > 200 ? task : null,
      frequency,
      weekdays: input.weekdays,
      dayOfMonth: input.dayOfMonth,
      completeByDay: input.completeByDay,
      startTime,
      dueTime,
      priority: input.priority,
      fixes,
    };
    const key = routineKey(draft);
    const first = seen.get(key);
    if (first !== undefined) { skip(`the same routine as Sr. No ${first}`); continue; }
    seen.set(key, srn);
    drafts.push(draft);
  }
  return { drafts, skipped };
}

/* ------------------------------------------------------------ To Do List */

/*
 * The To Do List tab, one-off tasks. This is a RECORD, so it is copied for
 * whoever still has a login whether or not they are still working here: who
 * was given what, and whether they did it, is history. A to-do given TO
 * somebody with no login is held back and named — a task has to belong to
 * somebody who can open it. A giver with no login is fine: the task is then
 * created by the person who holds it, and its note says who gave it.
 *
 * Nothing is "corrected" on a to-do. A past due date on an open one makes it
 * late, which is precisely what it was in AppSheet.
 */

export const MONTHLY_FROM = "Monthly Task";

export type TodoDraft = {
  sheetId: string;
  rowNumber: number;
  forDate: string;
  tillDate: string | null;
  fromUserId: string | null;
  fromLabel: string;
  toUserId: string;
  toName: string;
  category: string | null;
  task: string;
  urgent: boolean;
  status: "Open" | "Done";
  recheck: "" | "Verified";
  remark: string | null;
  doneAt: string | null; // ISO instant, +05:30
  doneOn: string | null;
  monthlyKey: string | null;
  createdAt: string; // ISO instant: midnight IST of the day it was given
};

const pad = (n: number | string) => String(n).padStart(2, "0");
const MON3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The sheet's dates: "10/3/2026" (month first, always) or "1-Jul-2025". */
export function sheetDate(v: string): string | null | undefined {
  if (!v) return null;
  let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return validISO(`${m[3]}-${pad(m[1])}-${pad(m[2])}`);
  m = v.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m && MON3.includes(m[2].toLowerCase())) return validISO(`${m[3]}-${pad(MON3.indexOf(m[2].toLowerCase()) + 1)}-${pad(m[1])}`);
  return undefined;
}
function validISO(iso: string): string | undefined {
  const [y, mo, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? iso : undefined;
}

/** "8/12/2023 16:12:50" → "2023-08-12T16:12:50+05:30": AppSheet stamps in the office's wall clock. */
export function sheetStamp(v: string): string | null | undefined {
  if (!v) return null;
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return undefined;
  const day = validISO(`${m[3]}-${pad(m[1])}-${pad(m[2])}`);
  if (!day || Number(m[4]) > 23) return undefined;
  return `${day}T${pad(m[4])}:${m[5]}:${m[6] ?? "00"}+05:30`;
}

/** "102026" → "2026-10"; "92023" → "2023-09". */
export function monthKey(v: string): string | null | undefined {
  if (!v) return null;
  const m = v.match(/^(\d{1,2})(\d{4})$/);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return undefined;
  return `${m[2]}-${pad(m[1])}`;
}

export type TodoSkipped = { sheetId: string; rowNumber: number; to: string; task: string; reason: string };

export function mapToDoList(rows: SheetRow[], employees: EmployeeRef[]): { drafts: TodoDraft[]; skipped: TodoSkipped[]; merged: number } {
  const byName = new Map<string, EmployeeRef[]>();
  for (const e of employees) byName.set(norm(e.name), [...(byName.get(norm(e.name)) ?? []), e]);
  const find = (name: string) => byName.get(NAME_ALIASES[norm(name)] ?? norm(name)) ?? [];

  const skipped: TodoSkipped[] = [];
  const all: TodoDraft[] = [];
  for (const { rowNumber, cells } of rows) {
    const g = (k: string) => (cells[k] ?? "").trim();
    const sheetId = g("To Do Task Id");
    const to = g("Assign To");
    const task = g("Assign Task").replace(/\s*\n\s*/g, " ").trim();
    const skip = (reason: string) => skipped.push({ sheetId, rowNumber, to, task, reason });

    if (!sheetId) { skip("no To Do Task Id"); continue; }
    if (!task) { skip("no task text"); continue; }
    const toMatch = find(to);
    if (!toMatch.length) { skip(`no MahekOne login for “${to}”`); continue; }
    if (toMatch.length > 1) { skip(`${toMatch.length} employees are named “${to}”`); continue; }

    const given = sheetDate(g("Date"));
    const forDate = sheetDate(g("For Date"));
    const tillDate = sheetDate(g("Till Date"));
    if (!forDate) { skip(`unreadable For Date “${g("For Date")}”`); continue; }
    if (tillDate === undefined) { skip(`unreadable Till Date “${g("Till Date")}”`); continue; }
    if (given === undefined) { skip(`unreadable Date “${g("Date")}”`); continue; }

    const fromRaw = g("Assign From");
    const monthly = fromRaw === MONTHLY_FROM;
    const fromMatch = monthly ? [] : find(fromRaw);
    const status = g("Status");
    if (status !== "" && status !== "Done") { skip(`status “${status}”`); continue; }
    const recheck = g("Recheck Status");
    if (recheck !== "" && recheck !== "Verified") { skip(`recheck status “${recheck}”`); continue; }
    const stamp = sheetStamp(g("Timestamp"));
    if (stamp === undefined) { skip(`unreadable Timestamp “${g("Timestamp")}”`); continue; }
    const mk = monthKey(g("Month ID"));
    if (mk === undefined) { skip(`unreadable Month ID “${g("Month ID")}”`); continue; }
    const category = g("Category") || null;
    const done = status === "Done";

    all.push({
      sheetId,
      rowNumber,
      forDate,
      tillDate: tillDate ?? null,
      fromUserId: fromMatch.length === 1 ? fromMatch[0].id : null,
      fromLabel: monthly ? MONTHLY_FROM : fromMatch.length === 1 ? fromMatch[0].name : fromRaw || "Unknown",
      toUserId: toMatch[0].id,
      toName: toMatch[0].name,
      category,
      task,
      urgent: category === "Urgent and Important",
      status: done ? "Done" : "Open",
      // A verified recheck means the giver checked a DONE to-do; on an open one it says nothing.
      recheck: done && recheck === "Verified" ? "Verified" : "",
      remark: g("Remark") || null,
      doneAt: done ? stamp : null,
      doneOn: done && stamp ? stamp.slice(0, 10) : null,
      monthlyKey: mk,
      createdAt: `${given ?? forDate}T00:00:00+05:30`,
    });
  }

  // AppSheet's "Take monthly task" sometimes ran twice and copied a month twice.
  // One to-do per (person, task, for date, month): the most finished copy wins
  // — verified over done over open — then the earliest row.
  const rank = (d: TodoDraft) => (d.recheck === "Verified" ? 2 : d.status === "Done" ? 1 : 0);
  const keep = new Map<string, TodoDraft>();
  let merged = 0;
  for (const d of all) {
    const key = [d.toUserId, norm(d.task), d.forDate, d.monthlyKey ?? "", d.fromLabel].join("|");
    const prev = keep.get(key);
    if (!prev) { keep.set(key, d); continue; }
    merged++;
    if (rank(d) > rank(prev)) keep.set(key, d);
  }
  return { drafts: [...keep.values()], skipped, merged };
}

/* --------------------------------------------- a to-do as a MahekOne task */

const TITLE_MAX = 200;
const ORIGIN = "Task EMP 2.0";

export type TaskRow = {
  id: string;
  title: string;
  note: string | null;
  app: "tasks";
  assigneeId: string;
  createdById: string;
  status: "todo" | "done";
  priority: "urgent" | "high" | "normal";
  dueDate: string;
  closedAt: Date | null;
  closedById: string | null;
  closeRemark: string | null;
  createdAt: Date;
  updatedAt: Date;
  events: { kind: string; actorId: string; body: string; at: Date }[];
};

const day = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]} ${y}`;
};

/**
 * One to-do as a row of `tasks`, with the events that tell its story. The
 * creator must be somebody who can sign in: whoever gave it where they can,
 * otherwise the person it was given to, with the note saying who gave it —
 * a monthly copy, and a to-do from somebody who has left, both land there.
 * The due date is the till date where there was one; the for date otherwise.
 * A done to-do carries its close; the check constraint on `tasks` wants a
 * closer and a remark, and the person it belonged to is who marked it done.
 */
export function todoAsTask(d: TodoDraft): TaskRow {
  const createdById = d.fromUserId ?? d.toUserId;
  const lines: string[] = [];
  if (d.task.length > TITLE_MAX) lines.push(d.task);
  if (!d.fromUserId) lines.push(d.fromLabel === MONTHLY_FROM ? "A monthly task." : `Given by ${d.fromLabel}.`);
  if (d.tillDate) lines.push(`For ${day(d.forDate)}, to be done by ${day(d.tillDate)}.`);
  if (d.status === "Open" && d.remark) lines.push(d.remark);
  lines.push(`Brought over from ${ORIGIN}.`);

  const createdAt = new Date(d.createdAt);
  const done = d.status === "Done";
  // A done to-do the sheet never stamped is dated to its own day, not to today.
  const closedAt = done ? new Date(d.doneAt ?? `${d.tillDate ?? d.forDate}T18:00:00+05:30`) : null;
  const closeRemark = done ? d.remark ?? `Marked done in ${ORIGIN}.` : null;

  const events: TaskRow["events"] = [
    { kind: "created", actorId: createdById, at: createdAt, body: createdById === d.toUserId ? `Added it (${ORIGIN}).` : `Gave it to ${d.toName.split(" ")[0]} (${ORIGIN}).` },
  ];
  if (closedAt) {
    events.push({ kind: "closed", actorId: d.toUserId, at: closedAt, body: closeRemark! });
    if (d.recheck === "Verified") events.push({ kind: "note", actorId: createdById, at: closedAt, body: `Checked and verified in ${ORIGIN}.` });
  }

  return {
    id: `tsk_taskemp_${d.sheetId}`,
    title: d.task.length > TITLE_MAX ? `${d.task.slice(0, TITLE_MAX - 1)}…` : d.task,
    note: lines.join("\n"),
    app: "tasks",
    assigneeId: d.toUserId,
    createdById,
    status: done ? "done" : "todo",
    priority: (d.category && PRIORITY[d.category]) || "normal",
    dueDate: d.tillDate ?? d.forDate,
    closedAt,
    closedById: done ? d.toUserId : null,
    closeRemark,
    createdAt,
    updatedAt: closedAt ?? createdAt,
    events,
  };
}
