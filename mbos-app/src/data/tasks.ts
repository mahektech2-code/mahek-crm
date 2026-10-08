import { all, getKv, one, run, setKv } from '../db';
import { insertAndQueue, stamp, updateAndQueue } from './write';
import { isoDate } from '../lib/format';
import { wirePriority } from '../lib/wire';
import { expandTaskForm, parseTaskForm, type TaskAnswers, type TaskField, type TaskLinkContext } from '../engines/task-form';

export type Task = {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  dueDate: string;
  customerId: string | null;
  status: string;
  completionNote: string | null;
  snoozeHistory: string | null;
  escalated: number;
  /** What KIND of work this is — `lead_validation`, `requirement_visit`,
   *  `rejected_order` — so the list can open the screen that answers it. */
  sourceType: string | null;
  sourceId: string | null;
  assigneeId: string | null;
  assignerId: string | null;
  /** The office's assignment this task is one of, and the form it asks him
   *  to fill — JSON text, read through `taskFormOf`. Null on a plain task. */
  campaignId: string | null;
  form: string | null;
  /** His answers to that form, JSON text — see `taskAnswersOf`. */
  responses: string | null;
  /** The customer record as the linked questions see it — `taskContextOf`. */
  context: string | null;
  syncState: string;
};

/** The questions this task asks. Empty is a plain task: a note and a tick. */
export function taskFormOf(t: Pick<Task, 'form'>): TaskField[] {
  return parseTaskForm(t.form);
}

/** What the customer record holds for this task's shop, or null. */
export function taskContextOf(t: Pick<Task, 'context'>): TaskLinkContext | null {
  if (!t.context) return null;
  try {
    const v = JSON.parse(t.context);
    return v && typeof v === 'object' && Array.isArray(v.contacts) && v.shop ? (v as TaskLinkContext) : null;
  } catch {
    return null;
  }
}

/**
 * The form as he answers it on THIS shop: a question about every contact
 * repeated per person, each linked question showing what the record holds,
 * and the record's values as the first answers — the same expansion the
 * office runs over what he sends.
 */
export function taskFormForShop(t: Pick<Task, 'form' | 'context'>): ReturnType<typeof expandTaskForm> {
  return expandTaskForm(taskFormOf(t), taskContextOf(t));
}

/** What he has answered so far — kept when he leaves the form half done. */
export function taskAnswersOf(t: Pick<Task, 'responses'>): TaskAnswers {
  if (!t.responses) return {};
  try {
    const v = JSON.parse(t.responses);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as TaskAnswers) : {};
  } catch {
    return {};
  }
}

/**
 * Answers kept on the phone without closing the task, so a form left half
 * done — the shop was shut, the owner was out — opens where he left it.
 *
 * In `kv` rather than on the row: a pull rewrites `responses` from the office
 * on every pass, and a draft written there would be erased by the next sync.
 * Nothing goes to the office until he submits.
 */
const draftKey = (id: string) => 'taskDraft:' + id;

export async function loadTaskDraft(t: Pick<Task, 'id' | 'responses' | 'form' | 'context'>): Promise<TaskAnswers> {
  const start = { ...taskFormForShop(t).prefill, ...taskAnswersOf(t) };
  const raw = await getKv(draftKey(t.id)).catch(() => null);
  if (raw) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { ...start, ...(v as TaskAnswers) };
    } catch {
      /* A draft that cannot be read is no draft. */
    }
  }
  return start;
}

export async function saveTaskDraft(id: string, answers: TaskAnswers): Promise<void> {
  await setKv(draftKey(id), JSON.stringify(answers));
}

export async function dropTaskDraft(id: string): Promise<void> {
  await run('DELETE FROM kv WHERE key = ?', [draftKey(id)]).catch(() => undefined);
}

export async function createTask(args: {
  title: string;
  description?: string;
  customerId?: string | null;
  priority?: string;
  dueDate: string;
}): Promise<string> {
  const base = await stamp('task');
  return insertAndQueue({
    table: 'tasks',
    entityType: 'task',
    row: {
      ...base,
      title: args.title,
      description: args.description ?? null,
      customerId: args.customerId ?? null,
      priority: args.priority ?? 'Normal',
      dueDate: args.dueDate,
      status: 'open',
    },
    /* The row keeps the design's word; the wire carries MahekOne's. */
    payloadExtras: { priority: wirePriority(args.priority) },
  });
}

export async function listOpenTasks(): Promise<Task[]> {
  return all<Task>(`SELECT * FROM tasks WHERE status = 'open' ORDER BY dueDate ASC`);
}

/**
 * Buckets are derived from the due date rather than stored.
 *
 * A stored bucket goes stale overnight — a task marked "Today" is still marked
 * "Today" tomorrow morning, which is exactly when it matters that it says
 * Overdue.
 */
export function bucketOf(dueDate: string, today: string): 'Overdue' | 'Today' | 'Tomorrow' | 'This week' | 'Later' {
  if (dueDate < today) return 'Overdue';
  if (dueDate === today) return 'Today';
  const t = new Date(today + 'T00:00:00');
  const d = new Date(dueDate + 'T00:00:00');
  const days = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  if (days === 1) return 'Tomorrow';
  return days <= 7 ? 'This week' : 'Later';
}

/**
 * Closing a task SAYS HOW, because the office refuses one that does not.
 *
 * `mbos.tasks.requireCompletionNote` is on by default, and this used to send
 * `completionNote: null` on every Done — the row left the list, the toast said
 * "Done", and the office refused it: the task landed in Not accepted, came
 * back as open on the next pull and was resent every three hours with a fresh
 * bell each time. The note and the photograph were on the wire all along; no
 * screen asked for either.
 */
export async function completeTask(
  id: string,
  args: { note: string | null; photoId?: string | null; responses?: TaskAnswers | null },
): Promise<void> {
  const note = args.note?.trim() || null;
  const patch: Record<string, unknown> = {
    status: 'done',
    completionNote: note,
    completionPhotoId: args.photoId ?? null,
  };
  /* The answers travel in the same update as the tick, so the office never
     holds a closed task whose answers are still on the phone. */
  if (args.responses) patch.responses = args.responses;
  await updateAndQueue({ table: 'tasks', entityType: 'task', id, patch });
}

/**
 * Where a snooze may land: never before the day the task is already due.
 *
 * "Snooze" moved every task to tomorrow, so snoozing one due on the 20th
 * dragged it FORWARD to tomorrow — the opposite of what the button says.
 */
export function snoozeTarget(dueDate: string, today: string, days: number): string {
  const from = dueDate > today ? dueDate : today;
  const d = new Date(from + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

/** A snooze needs a new date and a reason; both are kept, appended not replaced. */
export async function snoozeTask(id: string, newDate: string, reason: string): Promise<void> {
  const row = await one<{ snoozeHistory: string | null }>('SELECT snoozeHistory FROM tasks WHERE id = ?', [id]);
  const history: { at: number; to: string; reason: string }[] = row?.snoozeHistory ? JSON.parse(row.snoozeHistory) : [];
  history.push({ at: Date.now(), to: newDate, reason });

  await updateAndQueue({
    table: 'tasks',
    entityType: 'task',
    id,
    patch: { dueDate: newDate, snoozeHistory: history },
  });
}

/**
 * Overdue past the configured window escalates. Idempotent — a task already
 * escalated is not escalated again, so re-running the sweep costs nothing.
 */
export async function escalateOverdue(hours: number, now = Date.now()): Promise<number> {
  const cutoff = isoDate(new Date(now - hours * 3_600_000));
  const due = await all<{ id: string }>(
    `SELECT id FROM tasks WHERE status = 'open' AND escalated = 0 AND dueDate < ?`,
    [cutoff],
  );
  for (const t of due) await run('UPDATE tasks SET escalated = 1 WHERE id = ?', [t.id]);
  return due.length;
}
