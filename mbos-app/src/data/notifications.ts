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
  /** Stored for the office; nothing on the phone repeats on it yet. */
  priority?: number;
}): Promise<string> {
  const id = newId('notif');
  await run(
    `INSERT INTO notifications (id, title, body, kind, href, priority, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, args.title, args.body, args.kind ?? 'neutral', args.href ?? null, args.priority ?? 0, Date.now()],
  );
  return id;
}

/*
 * ONE CLOCK FOR BOTH KINDS OF ROW.
 *
 * The office's rows have arrived with `createdAt` as an ISO string and the
 * phone's own as epoch milliseconds, and SQLite sorts every TEXT value above
 * every INTEGER — so every office row sat above every local one whatever its
 * time, and a fresh "Order not accepted" could fall past the hundred-row cap.
 * The pull now writes milliseconds; this reads either, so rows already on a
 * phone sort correctly too.
 */
const CREATED_MS = `CASE WHEN typeof(createdAt) = 'text'
       THEN CAST(ROUND((julianday(createdAt) - 2440587.5) * 86400000) AS INTEGER)
       ELSE createdAt END`;

export async function listNotifications(): Promise<Notification[]> {
  return all<Notification>(
    `SELECT id, title, body, kind, href, priority, acknowledged, readAt, ${CREATED_MS} AS createdAt
       FROM notifications ORDER BY ${CREATED_MS} DESC LIMIT 100`,
  );
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
