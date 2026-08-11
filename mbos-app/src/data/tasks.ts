import { all, one, run } from '../db';
import { insertAndQueue, stamp, updateAndQueue } from './write';

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
  syncState: string;
};

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

export async function completeTask(id: string, note: string | null): Promise<void> {
  await updateAndQueue({
    table: 'tasks',
    entityType: 'task',
    id,
    patch: { status: 'done', completionNote: note },
  });
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
  const cutoff = new Date(now - hours * 3_600_000).toISOString().slice(0, 10);
  const due = await all<{ id: string }>(
    `SELECT id FROM tasks WHERE status = 'open' AND escalated = 0 AND dueDate < ?`,
    [cutoff],
  );
  for (const t of due) await run('UPDATE tasks SET escalated = 1 WHERE id = ?', [t.id]);
  return due.length;
}
