/* ---------------------------------------------------------------------------
 * THE TASKS APP'S RULES — pure, client-safe, no I/O.
 *
 * Every screen that draws a task and every action that writes one reads its
 * words and its checks from here, so the form that refuses a close and the
 * server that refuses it say the same sentence. Dates are the business day as
 * "YYYY-MM-DD" strings, passed in — nothing here reads a clock.
 * ------------------------------------------------------------------------- */

export const TASK_STATUSES = ["todo", "doing", "waiting", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  doing: "In progress",
  waiting: "Waiting on someone",
  done: "Done",
};

export const TASK_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

/** Lower sorts first. */
export const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/**
 * The apps a task can belong to, and `tasks` for one that belongs to none.
 * Only apps where people do work somebody could be asked to do — not the
 * handset, the retired apps, the console or the documentation.
 */
export const TASK_APPS = ["tasks", "crm", "accounts", "sales", "erp", "hrms", "founder", "enquiries", "website", "hire", "factory"] as const;
export type TaskApp = (typeof TASK_APPS)[number];

export const TASK_APP_LABEL: Record<TaskApp, string> = {
  tasks: "Personal",
  crm: "TeleCRM",
  accounts: "Accounts",
  sales: "Sales Dashboard",
  erp: "ERP",
  hrms: "HRMS",
  founder: "Founder",
  enquiries: "Website Enquiries",
  website: "Website",
  hire: "Hire",
  factory: "Factory",
};

export const isTaskApp = (v: string): v is TaskApp => (TASK_APPS as readonly string[]).includes(v);

/**
 * EVERY APP HAS ITS OWN MY TASKS, and this is where each one lives. It shows
 * the tasks whose work happens in that app, plus personal ones. The CRM's came
 * first, at `/crm/tasks`; the rest are at `/<app>/my-tasks`, because the Sales
 * Dashboard and Hire already had a `tasks` of their own meaning something else.
 * The Factory has none here: the floor works from its phone app.
 */
export const APP_TASKS_PATH: Partial<Record<TaskApp, string>> = {
  crm: "/crm/tasks",
  accounts: "/accounts/my-tasks",
  sales: "/sales/my-tasks",
  erp: "/erp/my-tasks",
  hrms: "/hrms/my-tasks",
  founder: "/founder/my-tasks",
  enquiries: "/enquiries/my-tasks",
  website: "/website/my-tasks",
  hire: "/hire/my-tasks",
};

/** Does an app's own My tasks show this task: its own app's work, and personal tasks. */
export const shownInApp = (taskApp: string, app: TaskApp) => taskApp === app || taskApp === "tasks";

/**
 * Where a link to one task goes: the Tasks app for somebody who holds it, else
 * the My tasks of the app the work belongs to, else the first app they hold
 * that has one (a personal task belongs to no app).
 */
export function taskLink(task: { id: string; app: string }, holds: { tasks: boolean; apps?: readonly string[] }): string {
  const own = isTaskApp(task.app) ? APP_TASKS_PATH[task.app] : undefined;
  if (task.app === "crm" && own) return `${own}?task=${task.id}`;
  if (holds.tasks) return `/tasks?task=${task.id}`;
  if (own && (!holds.apps || holds.apps.includes(task.app))) return `${own}?task=${task.id}`;
  const fallback = (holds.apps ?? []).map((a) => (isTaskApp(a) ? APP_TASKS_PATH[a] : undefined)).find(Boolean);
  return `${fallback ?? own ?? "/tasks"}?task=${task.id}`;
}

/** The shortest a remark may be: a word, not a keystroke. */
export const REMARK_MIN = 3;
export const REMARK_MAX = 2000;
export const TITLE_MAX = 200;
export const NOTE_MAX = 4000;
export const REASON_MIN = 3;
/** How many screenshots one close may carry. */
export const MAX_PROOFS = 5;

/* ------------------------------------------------------------------ dates */

export type DueState = "late" | "today" | "tomorrow" | "later";

/** Days from `today` to `due`, negative when it has passed. Both "YYYY-MM-DD". */
export function daysUntil(due: string, today: string): number {
  const a = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  const b = Date.UTC(+due.slice(0, 4), +due.slice(5, 7) - 1, +due.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

export function dueState(due: string, today: string): DueState {
  const d = daysUntil(due, today);
  return d < 0 ? "late" : d === 0 ? "today" : d === 1 ? "tomorrow" : "later";
}

/** "HH:MM" on the 24-hour clock to "3 PM" / "9:30 AM" for a person to read. */
export function clock12(hhmm: string | null | undefined): string {
  if (!hhmm || !/^\d\d:\d\d$/.test(hhmm)) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${ap}` : `${h12} ${ap}`;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "8 Nov" — the same in every zone, because it is read off the string. */
export function shortDate(day: string): string {
  return `${+day.slice(8, 10)} ${MONTH[+day.slice(5, 7) - 1]}`;
}

export function weekday(day: string): string {
  return WEEKDAY[new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))).getUTCDay()];
}

/** "Today", "Tomorrow", "2 days late", "Thu 13 Nov". */
export function dueWords(due: string, today: string): string {
  const d = daysUntil(due, today);
  if (d < 0) return `${-d} day${d === -1 ? "" : "s"} late`;
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  return `${weekday(due)} ${shortDate(due)}`;
}

/** `day` plus `n` days, as "YYYY-MM-DD". */
export function plusDays(day: string, n: number): string {
  const t = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) + n * 86_400_000;
  // A calendar day shifted on a UTC midnight, read back by its UTC parts —
  // there is no stored instant here whose zone could be lost.
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/* ------------------------------------------------------------- new tasks */

export type NewTaskInput = {
  title: string;
  app: string;
  dueDate: string;
  dueTime?: string | null;
  priority: string;
  note?: string | null;
  checklist?: string | null;
};

export type FieldProblem = { field: string; message: string };

/** Everything wrong with a new task, field by field. Empty means it can be saved. */
export function newTaskProblems(input: NewTaskInput): FieldProblem[] {
  const out: FieldProblem[] = [];
  const title = input.title.trim();
  if (!title) out.push({ field: "title", message: "Say what needs doing." });
  else if (title.length > TITLE_MAX) out.push({ field: "title", message: `Keep it under ${TITLE_MAX} characters — put the detail in the note.` });
  if (!isTaskApp(input.app)) out.push({ field: "app", message: "Pick the app this work happens in." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) out.push({ field: "dueDate", message: "Pick the day it is due." });
  if (input.dueTime && !/^[0-2]\d:[0-5]\d$/.test(input.dueTime)) out.push({ field: "dueTime", message: "Use a time like 15:30." });
  if (!(TASK_PRIORITIES as readonly string[]).includes(input.priority)) out.push({ field: "priority", message: "Pick a priority." });
  if ((input.note ?? "").length > NOTE_MAX) out.push({ field: "note", message: `Keep the note under ${NOTE_MAX} characters.` });
  return out;
}

/** One step per line, blank lines dropped. */
export function checklistFrom(text: string | null | undefined): { text: string; done: boolean }[] {
  return (text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((s) => ({ text: s.slice(0, 200), done: false }));
}

/* ----------------------------------------------------------------- closing */

export type CloseInput = {
  /** The person ticked "Yes, it is done". */
  confirmed: boolean;
  remark: string;
  /** Screenshots that arrived and are theirs. */
  proofs: number;
  proofRequired: boolean;
  /** Whether a remark must be written. Optional where the creator said so; true when not said. */
  remarkRequired?: boolean;
};

/**
 * Why a task cannot be closed yet, field by field. Closing is two steps on the
 * screen — say it is done, then show it — and both are asked again here, so a
 * request that skipped the screen is refused in the same words.
 */
export function closeProblems(input: CloseInput): FieldProblem[] {
  const out: FieldProblem[] = [];
  if (!input.confirmed) out.push({ field: "confirmed", message: "Tick the box to say it is done." });
  const remark = input.remark.trim();
  const remarkRequired = input.remarkRequired ?? true;
  if (remarkRequired && remark.length < REMARK_MIN) out.push({ field: "remark", message: "Write what was done." });
  else if (remark.length > REMARK_MAX) out.push({ field: "remark", message: `Keep the remark under ${REMARK_MAX} characters.` });
  if (input.proofRequired && input.proofs < 1) out.push({ field: "proof", message: "Add a screenshot — this task needs one to close." });
  if (input.proofs > MAX_PROOFS) out.push({ field: "proof", message: `Up to ${MAX_PROOFS} screenshots.` });
  return out;
}

/* --------------------------------------------------------------- transfers */

export type TransferRoute = "move" | "request";

/**
 * Whether handing a task over moves it now or asks first.
 *
 * A manager over both people moves it — their team is theirs to arrange.
 * Anybody else asks, and the task stays with its assignee until the other
 * person accepts: work does not land on somebody because a colleague decided
 * it should.
 */
export function transferRoute(input: { actorManagesBoth: boolean }): TransferRoute {
  return input.actorManagesBoth ? "move" : "request";
}

export function transferProblems(input: { route: TransferRoute; fromId: string; toId: string; reason: string }): FieldProblem[] {
  const out: FieldProblem[] = [];
  if (!input.toId) out.push({ field: "to", message: "Pick who takes it." });
  else if (input.toId === input.fromId) out.push({ field: "to", message: "It is already theirs." });
  if (input.route === "request" && input.reason.trim().length < REASON_MIN) {
    out.push({ field: "reason", message: "Say why — they read this before they decide." });
  }
  return out;
}

export function rejectProblems(note: string): FieldProblem[] {
  return note.trim().length < REASON_MIN ? [{ field: "note", message: "Say why you can't take it — they read this." }] : [];
}

/* -------------------------------------------------------------- the team */

/**
 * Everybody below `root` on the org chart, at any depth. `managerOf` maps a
 * person to their manager. A loop in the chart (somebody recorded as their own
 * manager's manager) is walked once and stops.
 */
export function teamBelow(managerOf: ReadonlyMap<string, string>, root: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const [person, manager] of managerOf) {
    if (!manager || manager === person) continue;
    const list = children.get(manager) ?? [];
    list.push(person);
    children.set(manager, list);
  }
  const out = new Set<string>();
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    if (p === root || out.has(p)) continue;
    out.add(p);
    stack.push(...(children.get(p) ?? []));
  }
  return out;
}

/** "Manager or above": the actor sits above both people, or is one of them and above the other. */
export function managesBoth(team: ReadonlySet<string>, actorId: string, fromId: string, toId: string): boolean {
  const covers = (id: string) => id === actorId || team.has(id);
  return covers(fromId) && covers(toId) && (team.has(fromId) || team.has(toId));
}

/* -------------------------------------------------------------- quick add */

/**
 * "Call Hari Om Paints tomorrow 3pm !high" → a title, a day, a time and a
 * priority. Only what is unmistakable is read; everything else stays words.
 */
export function parseQuickAdd(text: string, today: string): { title: string; dueDate: string; dueTime: string | null; priority: TaskPriority } {
  let title = ` ${text} `;
  let dueDate = today;
  let dueTime: string | null = null;
  let priority: TaskPriority = "normal";
  if (/\stomorrow\s/i.test(title)) {
    dueDate = plusDays(today, 1);
    title = title.replace(/\stomorrow\s/i, " ");
  }
  title = title.replace(/\stoday\s/i, " ");
  const t = title.match(/\s(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s/i);
  if (t && +t[1] >= 1 && +t[1] <= 12) {
    let h = +t[1] % 12;
    if (/pm/i.test(t[3])) h += 12;
    dueTime = `${String(h).padStart(2, "0")}:${t[2] ?? "00"}`;
    title = title.replace(t[0], " ");
  }
  const p = title.match(/\s!(urgent|high|low)\s/i);
  if (p) {
    priority = p[1].toLowerCase() as TaskPriority;
    title = title.replace(p[0], " ");
  }
  return { title: title.replace(/\s{2,}/g, " ").trim(), dueDate, dueTime, priority };
}
