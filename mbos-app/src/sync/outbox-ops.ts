/* ---------------------------------------------------------------------------
 * THE OUTBOX'S HOUSEKEEPING, with the database passed in.
 *
 * No Expo import, so every rule here runs under `tsx --test` against a real
 * SQLite built from the handset's own migrations (`outbox-ops.test.ts`).
 * `queue.ts` hands it the app's connection; nothing else differs.
 *
 * What lives here is what a person decides on the Not accepted and Sync
 * screens — letting an entry go, and what goes with it — and what the outbox
 * owes a record it has spoken for: putting the phone's copy back the way the
 * office has it when an edit is refused.
 * ------------------------------------------------------------------------- */

import { dependents, type Eligible } from './ordering';
import { DROP_PHONE_LEAD_SHOP_SQL } from '../data/lead-shop';

type Bind = string | number | null;

export type Db = {
  all<T>(sql: string, params?: Bind[]): Promise<T[]>;
  one<T>(sql: string, params?: Bind[]): Promise<T | null>;
  run(sql: string, params?: Bind[]): Promise<void>;
};

export type OutboxRow = {
  id: string;
  entityType: string;
  entityId: string;
  op: string;
  payload: string;
  dependsOn: string;
  state: string;
  createdAt: number;
  nextAttemptAt: number;
};

/**
 * Reflect the queue item's fate onto the record itself, so a screen showing
 * an order can say what state it is in without joining the outbox.
 */
export const ENTITY_TABLE: Record<string, string> = {
  visit: 'visits',
  order: 'orders',
  order_change_request: 'order_change_requests',
  payment: 'payments',
  attendance: 'attendance_days',
  task: 'tasks',
  lead: 'leads',
  sample: 'samples',
  complaint: 'complaints',
  expense: 'expenses',
  leave: 'leave_requests',
  tour: 'tours',
  territory_request: 'territory_requests',
  competitor: 'competitor_records',
  /* Without this the row would sync and its own syncState would stay 'queued'
     for ever — the sync screen would show a call that never landed, and the
     salesman would make it again. A table missing from this map fails silently
     and looks exactly like a broken connection. */
  lead_validation: 'lead_validations',
  approval: 'approvals',
  plan_day: 'journey_days',
  /*
   * Both answers about a day land on the same row, because `entityId` for a
   * pick IS the plan day's id. Missing, a refused pick wrote nothing back at
   * all: the local row kept the `dayState = 'planned'` the pick had set
   * optimistically, with no stops behind it and nothing on the screen saying
   * the office had refused it — a route claiming to be a route, which is the
   * one state this model exists to prevent.
   */
  plan_stops: 'journey_days',
};

/** Rows that belong to a record and go when its create is let go. */
export const OWNED_CHILDREN: Record<string, { table: string; key: string }[]> = {
  order: [{ table: 'order_lines', key: 'orderId' }],
};

/** The states a person may let go of: the office refused it, the phone gave up, or it is held behind one that did. */
export const REMOVABLE_STATES = ['rejected', 'failed', 'blocked'] as const;

function parseDeps(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------- previous values */

/**
 * WHAT AN EDIT CHANGED, AND FROM WHAT — kept beside the outbox item in `kv`.
 *
 * An edit is applied to the phone's copy at once (that is the offline-first
 * promise) and goes up afterwards. When the office refuses it, the phone's copy
 * was left saying the edit happened: a task refused as Done stayed done here,
 * so it left the list — while the office still had it open and the next pull
 * did not mention it, because nothing on the office's side had changed. So
 * the columns the edit touched are remembered as they were, and put back.
 */
export type EditSnapshot = { table: string; prev: Record<string, Bind>; next: Record<string, Bind> };

export const snapshotKey = (queueId: string) => `prev:${queueId}`;

export async function saveSnapshot(db: Db, queueId: string, snap: EditSnapshot): Promise<void> {
  await db.run('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', [snapshotKey(queueId), JSON.stringify(snap)]);
}

async function readSnapshot(db: Db, queueId: string): Promise<EditSnapshot | null> {
  const row = await db.one<{ value: string }>('SELECT value FROM kv WHERE key = ?', [snapshotKey(queueId)]);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as EditSnapshot;
  } catch {
    return null;
  }
}

export async function dropSnapshot(db: Db, queueId: string): Promise<void> {
  await db.run('DELETE FROM kv WHERE key = ?', [snapshotKey(queueId)]);
}

/**
 * Where no snapshot was kept — an edit queued by a build before this one — the
 * one thing that is known to be wrong is put right: a task the office refused
 * to close is open.
 */
const FALLBACK_RESTORE: Record<string, string> = {
  task: `UPDATE tasks SET status = 'open' WHERE id = ? AND status = 'done'`,
};

async function applyValues(db: Db, table: string, id: string, values: Record<string, Bind>): Promise<void> {
  const cols = Object.keys(values).filter((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c));
  if (!cols.length) return;
  await db.run(
    `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map((c) => values[c] ?? null), id],
  );
}

/**
 * Put the phone's copy back as it was before a refused edit. Skipped where a
 * LATER edit to the same record is still waiting: that one is the newer fact,
 * and rolling back underneath it would undo what he did after.
 */
export async function restoreBeforeEdit(db: Db, item: OutboxRow): Promise<boolean> {
  if (item.op !== 'update') return false;
  const table = ENTITY_TABLE[item.entityType];
  if (!table) return false;
  const later = await db.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sync_queue
      WHERE entityId = ? AND id <> ? AND state <> 'synced' AND createdAt > ?`,
    [item.entityId, item.id, item.createdAt],
  );
  if ((later?.n ?? 0) > 0) return false;
  const snap = await readSnapshot(db, item.id);
  if (snap) {
    await applyValues(db, snap.table, item.entityId, snap.prev);
    return true;
  }
  const fallback = FALLBACK_RESTORE[item.entityType];
  if (fallback) {
    await db.run(fallback, [item.entityId]);
    return true;
  }
  return false;
}

/** Sending a refused edit again puts the edit back on the phone's copy too. */
export async function reapplyEdit(db: Db, item: OutboxRow): Promise<void> {
  if (item.op !== 'update') return;
  const snap = await readSnapshot(db, item.id);
  if (snap) await applyValues(db, snap.table, item.entityId, snap.next);
}

/* ---------------------------------------------------------- letting go */

/**
 * EVERYTHING THAT GOES WITH AN ENTRY when it is let go.
 *
 * A create that never reached the office takes with it everything waiting on
 * it — the payment against the refused order, the approval asked for the
 * refused leave, an edit to the record itself — because each of those is
 * blocked for ever behind a record that will now never exist: they sat in the
 * outbox, counted against the handover, with nothing able to clear them.
 * An edit goes alone; the record it edits is the office's and stays.
 */
export async function discardSet(db: Db, id: string): Promise<OutboxRow[]> {
  const item = await db.one<OutboxRow>('SELECT * FROM sync_queue WHERE id = ?', [id]);
  if (!item || !(REMOVABLE_STATES as readonly string[]).includes(item.state)) return [];
  if (item.op !== 'create') return [item];
  const open = await db.all<OutboxRow>(`SELECT * FROM sync_queue WHERE state <> 'synced' AND id <> ?`, [id]);
  const eligible: (Eligible & { row: OutboxRow })[] = open.map((r) => ({
    id: r.id,
    entityId: r.entityId,
    dependsOn: parseDeps(r.dependsOn),
    nextAttemptAt: r.nextAttemptAt,
    createdAt: r.createdAt,
    state: r.state,
    row: r,
  }));
  const out = new Map<string, OutboxRow>([[item.id, item]]);
  /* Edits to the record itself, whether or not an older build said they waited on it. */
  for (const e of eligible) if (e.entityId === item.entityId) out.set(e.id, e.row);
  for (const e of dependents(eligible, item.entityId)) out.set(e.id, e.row);
  return [...out.values()];
}

/** How many OTHER entries go with this one — the number the confirm says. */
export async function discardCount(db: Db, id: string): Promise<number> {
  return Math.max(0, (await discardSet(db, id)).length - 1);
}

/**
 * Let an entry go, and everything that goes with it. Returns how many outbox
 * entries were removed.
 *
 * A create's local record goes with it, with what it owns: the office never
 * got it, and a second copy on the phone of one order he is about to take
 * again would be counted twice in his day. An edit's record stays and is put
 * back as the office has it.
 */
export async function discardWithDependents(db: Db, id: string): Promise<number> {
  const set = await discardSet(db, id);
  /* Edits first, while the records they would restore still exist. */
  const ordered = [...set].sort((a, b) => (a.op === b.op ? 0 : a.op === 'update' ? -1 : 1));
  for (const row of ordered) {
    if (row.op === 'update') {
      await restoreBeforeEdit(db, row);
      const table = ENTITY_TABLE[row.entityType];
      const others = await db.one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sync_queue WHERE entityId = ? AND id <> ? AND state <> 'synced'`,
        [row.entityId, row.id],
      );
      /* The office's copy is what the phone now holds — unless something else
         about this record is still waiting, which keeps its own state. */
      if (table && (others?.n ?? 0) === 0) {
        await db.run(`UPDATE ${table} SET syncState = 'synced', syncMessage = NULL WHERE id = ?`, [row.entityId]);
      }
    }
    await db.run('DELETE FROM sync_queue WHERE id = ?', [row.id]);
    await dropSnapshot(db, row.id);
    if (row.op !== 'create') continue;
    for (const child of OWNED_CHILDREN[row.entityType] ?? []) {
      await db.run(`DELETE FROM ${child.table} WHERE ${child.key} = ?`, [row.entityId]);
    }
    const table = ENTITY_TABLE[row.entityType];
    if (table) await db.run(`DELETE FROM ${table} WHERE id = ?`, [row.entityId]);
    if (row.entityType === 'lead') await db.run(DROP_PHONE_LEAD_SHOP_SQL, [row.entityId]);
  }
  return set.length;
}

/* ------------------------------------------------------------ handover */

/**
 * WHAT STOPS SOMEBODY ELSE SIGNING IN ON THIS PHONE.
 *
 * Work still on its way counts, always. Work the phone gave up on — failed,
 * or blocked behind something that failed — counts only while it is recent:
 * an entry stuck for weeks is not going to go, and counting it held the phone
 * hostage to it (`mbos.sync.handoverIgnoreDays`, sent by the office). A
 * refusal is not counted at all; the office has already answered it.
 */
export async function handoverWork(
  db: Db,
  now: number,
  ignoreDays: number,
): Promise<{ counted: number; ignored: number }> {
  const cutoff = now - Math.max(1, ignoreDays) * 86_400_000;
  const r = await db.one<{ live: number; recent: number; old: number }>(
    `SELECT
       SUM(CASE WHEN state IN ('queued','syncing') THEN 1 ELSE 0 END) AS live,
       SUM(CASE WHEN state IN ('failed','blocked') AND createdAt >= ? THEN 1 ELSE 0 END) AS recent,
       SUM(CASE WHEN state IN ('failed','blocked') AND createdAt < ? THEN 1 ELSE 0 END) AS old
     FROM sync_queue`,
    [cutoff, cutoff],
  );
  const m = await db.one<{ live: number; old: number }>(
    `SELECT
       SUM(CASE WHEN state IN ('queued','syncing') OR (state = 'failed' AND createdAt >= ?) THEN 1 ELSE 0 END) AS live,
       SUM(CASE WHEN state = 'failed' AND createdAt < ? THEN 1 ELSE 0 END) AS old
     FROM media_queue`,
    [cutoff, cutoff],
  );
  return {
    counted: (r?.live ?? 0) + (r?.recent ?? 0) + (m?.live ?? 0),
    ignored: (r?.old ?? 0) + (m?.old ?? 0),
  };
}

/* ------------------------------------------------------------ orphans */

/**
 * A RECORD SAVED BUT NEVER QUEUED — the crash between the two writes, which a
 * build before this one could leave behind. It drew as "Not sent yet" for
 * ever with nothing in the outbox to send.
 *
 * It is not re-queued: what goes up is not the row but the row plus the wire's
 * own spellings (a task's priority, a leave's dates, a sample's product), and
 * those cannot be rebuilt from the row. A payload rebuilt without them would be
 * read wrong by the office rather than refused. So the record says plainly
 * that it never went, and he takes it again.
 *
 * The day and the plan are left alone: their state is set before an amendment
 * and an outbox item is not always theirs alone.
 */
export const ORPHAN_SWEEP_SKIP = new Set(['attendance', 'plan_day', 'plan_stops', 'approval']);
export const ORPHAN_MESSAGE = 'Saved on this phone but never sent. Take it again.';

export async function markOrphans(db: Db): Promise<number> {
  let marked = 0;
  const tables = new Set<string>();
  for (const [type, table] of Object.entries(ENTITY_TABLE)) if (!ORPHAN_SWEEP_SKIP.has(type)) tables.add(table);
  for (const table of tables) {
    const rows = await db.all<{ id: string }>(
      `SELECT t.id FROM ${table} t
        WHERE t.syncState = 'queued'
          AND NOT EXISTS (SELECT 1 FROM sync_queue q WHERE q.entityId = t.id)`,
    );
    for (const r of rows) {
      await db.run(`UPDATE ${table} SET syncState = 'failed', syncMessage = ? WHERE id = ?`, [ORPHAN_MESSAGE, r.id]);
      marked++;
    }
  }
  return marked;
}
