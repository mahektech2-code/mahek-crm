import { all, newId, one, payloadHash, run } from '../db';
import { backoffFor as computeBackoff, MAX_ATTEMPTS as MAX, partition } from './ordering';

/**
 * The outbox.
 *
 * Three properties this has to hold, and each of them is a way offline apps go
 * wrong:
 *
 *   ORDER. Items go out in dependency order, not creation order. A payment
 *   against an order created ten seconds ago cannot reach the server first —
 *   there would be nothing to attach it to.
 *
 *   IDEMPOTENCE. Every item carries a key the server remembers. A request
 *   whose response we never saw gets retried, and on a 2G connection in a
 *   market that is most of them; without the key each retry would duplicate a
 *   real order.
 *
 *   DURABILITY. The queue is a table, and `nextAttemptAt` is an absolute time.
 *   Killing the app mid-queue loses nothing and does not restart the backoff
 *   schedule from the beginning.
 */

export type SyncState =
  | 'local' | 'queued' | 'syncing' | 'synced'
  | 'failed' | 'rejected' | 'blocked' | 'conflicted';

export type QueueItem = {
  id: string;
  entityType: string;
  entityId: string;
  op: 'create' | 'update';
  payload: string;
  dependsOn: string;
  idempotencyKey: string;
  attempts: number;
  lastAttemptAt: number | null;
  nextAttemptAt: number;
  state: string;
  failureCode: string | null;
  failureReason: string | null;
  createdAt: number;
};

/**
 * Backoff, in milliseconds. Six attempts across roughly forty minutes, then
 * the item is surfaced as failed rather than retried forever — a queue that
 * never gives up is a queue nobody looks at.
 */
export const backoffFor = computeBackoff;
export const MAX_ATTEMPTS = MAX;

/* --------------------------------------------------------------- enqueue */

export async function enqueue(args: {
  entityType: string;
  entityId: string;
  op: 'create' | 'update';
  payload: unknown;
  dependsOn?: string[];
  now?: number;
}): Promise<string> {
  const now = args.now ?? Date.now();
  const hash = await payloadHash(args.payload);
  const key = `${args.entityId}:${args.op}:${hash}`;

  /* The same edit enqueued twice is one item. This is the client half of
     idempotence — the server half is the receipts ledger. */
  const existing = await one<{ id: string }>('SELECT id FROM sync_queue WHERE idempotencyKey = ?', [key]);
  if (existing) return existing.id;

  const id = newId('q');
  await run(
    `INSERT INTO sync_queue
       (id, entityType, entityId, op, payload, dependsOn, idempotencyKey, nextAttemptAt, state, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    [
      id,
      args.entityType,
      args.entityId,
      args.op,
      JSON.stringify(args.payload),
      JSON.stringify(args.dependsOn ?? []),
      key,
      now,
      now,
    ],
  );
  return id;
}

/* ------------------------------------------------------- dependency order */

/**
 * The items eligible to go out right now.
 *
 * Eligible means: queued, past its backoff gate, and every id it depends on is
 * already `synced`. A dependency that was rejected or failed does not merely
 * delay its dependents — it blocks them, because a payment for an order the
 * server refused must not arrive looking like a payment against nothing.
 */
export async function readyItems(now = Date.now(), limit = 50): Promise<QueueItem[]> {
  const queued = await all<QueueItem>(
    `SELECT * FROM sync_queue
      WHERE state = 'queued' AND nextAttemptAt <= ?
      ORDER BY createdAt ASC`,
    [now],
  );
  if (queued.length === 0) return [];

  /* What has already landed, and what has gone wrong. Both are needed: one
     decides eligibility, the other decides blocking. */
  const settled = await all<{ entityId: string; state: string }>(
    `SELECT entityId, state FROM sync_queue WHERE state IN ('synced','rejected','failed','blocked')`,
  );
  const syncedIds = new Set(settled.filter((r) => r.state === 'synced').map((r) => r.entityId));
  const deadIds = new Set(settled.filter((r) => r.state !== 'synced').map((r) => r.entityId));

  /* The decision itself is pure and lives in `ordering.ts`, so the rule that
     keeps a payment behind its order is covered by tests that need neither a
     database nor a handset. */
  const verdict = partition({
    queued: queued.map((q) => ({ ...q, dependsOn: JSON.parse(q.dependsOn) as string[] })),
    syncedIds,
    deadIds,
    now,
    limit,
  });

  for (const item of verdict.blocked) {
    await blockItem(item.id, 'A record this one depends on did not go through.');
  }

  const byId = new Map(queued.map((q) => [q.id, q]));
  return verdict.ready.map((r) => byId.get(r.id)!).filter(Boolean);
}

/* ---------------------------------------------------------- state changes */

export async function markSyncing(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const marks = ids.map(() => '?').join(',');
  await run(`UPDATE sync_queue SET state = 'syncing', lastAttemptAt = ? WHERE id IN (${marks})`, [Date.now(), ...ids]);
}

export async function markSynced(item: QueueItem, serverAt: number | null): Promise<void> {
  await run(`UPDATE sync_queue SET state = 'synced', failureCode = NULL, failureReason = NULL WHERE id = ?`, [item.id]);
  await setEntityState(item.entityType, item.entityId, 'synced', null, serverAt);
}

/**
 * A refusal from the server.
 *
 * The record is retained — always. The salesman stood in a shop and said the
 * order was placed; deleting it here would leave him with no way to find out
 * that it was not.
 */
export async function markRejected(item: QueueItem, code: string, message: string): Promise<void> {
  await run(`UPDATE sync_queue SET state = 'rejected', failureCode = ?, failureReason = ? WHERE id = ?`, [code, message, item.id]);
  await setEntityState(item.entityType, item.entityId, 'rejected', message, null);
  await blockDependents(item.entityId);
}

export async function markFailure(item: QueueItem, reason: string, now = Date.now()): Promise<void> {
  const attempts = item.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await run(`UPDATE sync_queue SET state = 'failed', attempts = ?, failureReason = ? WHERE id = ?`, [attempts, reason, item.id]);
    await setEntityState(item.entityType, item.entityId, 'failed', reason, null);
    await blockDependents(item.entityId);
    return;
  }
  await run(
    `UPDATE sync_queue SET state = 'queued', attempts = ?, nextAttemptAt = ?, failureReason = ? WHERE id = ?`,
    [attempts, backoffFor(attempts, now), reason, item.id],
  );
}

async function blockItem(id: string, reason: string): Promise<void> {
  const item = await one<QueueItem>('SELECT * FROM sync_queue WHERE id = ?', [id]);
  if (!item) return;
  await run(`UPDATE sync_queue SET state = 'blocked', failureReason = ? WHERE id = ?`, [reason, id]);
  await setEntityState(item.entityType, item.entityId, 'blocked', reason, null);
}

/** Anything waiting on a record that will never land is blocked, not sent. */
export async function blockDependents(entityId: string): Promise<void> {
  const open = await all<QueueItem>(`SELECT * FROM sync_queue WHERE state IN ('queued','syncing')`);
  for (const item of open) {
    const deps: string[] = JSON.parse(item.dependsOn);
    if (deps.includes(entityId)) {
      await blockItem(item.id, 'A record this one depends on did not go through.');
      await blockDependents(item.entityId);
    }
  }
}

/**
 * Put a rejected item back in the queue after the salesman has corrected it.
 * Its dependents come back with it — they were only ever blocked because of it.
 */
export async function retryItem(id: string, now = Date.now()): Promise<void> {
  const item = await one<QueueItem>('SELECT * FROM sync_queue WHERE id = ?', [id]);
  if (!item) return;
  await run(
    `UPDATE sync_queue SET state = 'queued', attempts = 0, nextAttemptAt = ?, failureCode = NULL, failureReason = NULL WHERE id = ?`,
    [now, id],
  );
  await setEntityState(item.entityType, item.entityId, 'queued', null, null);
  await unblockDependents(item.entityId, now);
}

async function unblockDependents(entityId: string, now: number): Promise<void> {
  const blocked = await all<QueueItem>(`SELECT * FROM sync_queue WHERE state = 'blocked'`);
  for (const item of blocked) {
    const deps: string[] = JSON.parse(item.dependsOn);
    if (!deps.includes(entityId)) continue;
    await run(`UPDATE sync_queue SET state = 'queued', nextAttemptAt = ?, failureReason = NULL WHERE id = ?`, [now, item.id]);
    await setEntityState(item.entityType, item.entityId, 'queued', null, null);
    await unblockDependents(item.entityId, now);
  }
}

/**
 * Reflect the queue item's fate onto the record itself, so a screen showing
 * an order can say what state it is in without joining the outbox.
 */
const ENTITY_TABLE: Record<string, string> = {
  visit: 'visits',
  order: 'orders',
  payment: 'payments',
  attendance: 'attendance_days',
  task: 'tasks',
  lead: 'leads',
  sample: 'samples',
  complaint: 'complaints',
  expense: 'expenses',
  leave: 'leave_requests',
  competitor: 'competitor_records',
  approval: 'approvals',
};

async function setEntityState(
  entityType: string,
  entityId: string,
  state: SyncState,
  message: string | null,
  serverAt: number | null,
): Promise<void> {
  const table = ENTITY_TABLE[entityType];
  if (!table) return;
  if (serverAt != null) {
    await run(`UPDATE ${table} SET syncState = ?, syncMessage = ?, serverCreatedAt = ? WHERE id = ?`, [state, message, serverAt, entityId]);
  } else {
    await run(`UPDATE ${table} SET syncState = ?, syncMessage = ? WHERE id = ?`, [state, message, entityId]);
  }
}

/* -------------------------------------------------------------- reporting */

export async function queueCounts(): Promise<Record<string, number>> {
  const rows = await all<{ state: string; n: number }>(`SELECT state, COUNT(*) AS n FROM sync_queue GROUP BY state`);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.state] = r.n;
  return out;
}

/** What the status strip counts: everything authored here the office cannot see yet. */
export async function pendingCount(): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sync_queue WHERE state IN ('queued','syncing','failed','blocked')`,
  );
  const media = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM media_queue WHERE state IN ('queued','syncing','failed')`,
  );
  return (row?.n ?? 0) + (media?.n ?? 0);
}

export async function listQueue(): Promise<QueueItem[]> {
  return all<QueueItem>(
    `SELECT * FROM sync_queue WHERE state <> 'synced' ORDER BY
       CASE state WHEN 'rejected' THEN 0 WHEN 'failed' THEN 1 WHEN 'blocked' THEN 2
                  WHEN 'syncing' THEN 3 ELSE 4 END, createdAt DESC`,
  );
}

/**
 * Edits of ours that lost a merge.
 *
 * Nothing is discarded silently — both versions are in `conflict_log` — so the
 * outbox says plainly that something changed under him rather than leaving him
 * to notice his own edit had gone.
 */
export async function conflictCount(): Promise<number> {
  const row = await one<{ n: number }>('SELECT COUNT(*) AS n FROM conflict_log WHERE reviewed = 0');
  return row?.n ?? 0;
}

/** The rejection review screen reads this. */
export async function listRejections(): Promise<QueueItem[]> {
  return all<QueueItem>(`SELECT * FROM sync_queue WHERE state = 'rejected' ORDER BY createdAt DESC`);
}

/**
 * Anything left `syncing` when the app died is put back in the queue. It may
 * or may not have reached the server; the idempotency key makes finding out by
 * re-sending it safe.
 */
export async function recoverInterrupted(now = Date.now()): Promise<number> {
  const stuck = await all<{ id: string }>(`SELECT id FROM sync_queue WHERE state = 'syncing'`);
  if (stuck.length) {
    await run(`UPDATE sync_queue SET state = 'queued', nextAttemptAt = ? WHERE state = 'syncing'`, [now]);
  }
  await run(`UPDATE media_queue SET state = 'queued', nextAttemptAt = ? WHERE state = 'syncing'`, [now]);
  return stuck.length;
}
