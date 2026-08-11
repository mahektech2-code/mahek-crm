import { all, newId, one, run } from '../db';

/**
 * In-app notifications.
 *
 * They live in the local store like everything else, so a rejection raised
 * while the handset was offline is waiting on the screen whether or not a push
 * ever arrived. Push and in-app run in parallel; neither is the other's
 * fallback.
 */

export type Notification = {
  id: string;
  title: string;
  body: string;
  kind: 'danger' | 'amber' | 'success' | 'neutral';
  href: string | null;
  priority: number;
  acknowledged: number;
  readAt: number | null;
  createdAt: number;
};

export async function notify(args: {
  title: string;
  body: string;
  kind?: Notification['kind'];
  href?: string;
  /** 1 means it repeats until acted on. See `unacknowledgedPriority`. */
  priority?: number;
}): Promise<string> {
  const id = newId('notif');
  await run(
    `INSERT INTO notifications (id, title, body, kind, href, priority, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, args.title, args.body, args.kind ?? 'neutral', args.href ?? null, args.priority ?? 0, Date.now()],
  );
  return id;
}

export async function listNotifications(): Promise<Notification[]> {
  return all<Notification>('SELECT * FROM notifications ORDER BY createdAt DESC LIMIT 100');
}

export async function unreadCount(): Promise<number> {
  const row = await one<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE readAt IS NULL');
  return row?.n ?? 0;
}

export async function markRead(id: string): Promise<void> {
  await run('UPDATE notifications SET readAt = ? WHERE id = ? AND readAt IS NULL', [Date.now(), id]);
}

export async function markAllRead(): Promise<void> {
  await run('UPDATE notifications SET readAt = ? WHERE readAt IS NULL', [Date.now()]);
}

/**
 * A priority notification is cleared by ACTING on it, not by looking at it.
 *
 * Reading is not acknowledging — the brief is explicit — so these keep coming
 * back until the thing they are about has actually been dealt with. That is
 * what `acknowledge` is for, and it is called from the screen that resolves
 * the underlying problem, never from the notification list.
 */
export async function acknowledge(id: string): Promise<void> {
  await run('UPDATE notifications SET acknowledged = 1, readAt = COALESCE(readAt, ?) WHERE id = ?', [Date.now(), id]);
}

export async function unacknowledgedPriority(): Promise<Notification[]> {
  return all<Notification>('SELECT * FROM notifications WHERE priority > 0 AND acknowledged = 0 ORDER BY createdAt DESC');
}
