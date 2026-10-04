import { all, newId, one, payloadHash, run } from '../db';
import { backoffFor as computeBackoff, MAX_ATTEMPTS as MAX, partition } from './ordering';
import { whereNow } from '../native/where';

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
  /** JSON — where this was done. See `native/where.ts`. */
  location: string | null;
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

/**
 * Queue one write, and remember where it was done.
 *
 * The location is attached HERE, in the one function every write in the app
 * passes through, so a new kind of activity carries it by existing rather than
 * by somebody remembering. Fourteen call sites each fetching a position is
 * thirteen doing it and one forgetting — which is the state this replaced.
 *
 * It is stored in its own COLUMN and hashed into nothing. `idempotencyKey` is
 * a hash of the payload, so folding a position in would make the same order
 * enqueued twice from two spots on a street into two orders. Where somebody
 * stood is a fact about the act, not part of the record's content — and the
 * dedupe below is the reason that distinction has to be kept.
 *
 * `whereNow()` never waits on the radio, so this adds no delay to a save.
 */
export async function enqueue(args: {
  entityType: string;
  entityId: string;
  op: 'create' | 'update';
  payload: unknown;
  dependsOn?: string[];
  now?: number;
  /** Set false for a write that is paperwork rather than field work. */
  location?: boolean;
}): Promise<string> {
  const now = args.now ?? Date.now();
  const hash = await payloadHash(args.payload);
  const base = `${args.entityId}:${args.op}:${hash}`;

  /* The same edit enqueued twice is one item — while the first is still
     WAITING. This is the client half of idempotence; the server half is the
     receipts ledger. */
  const waiting = await one<{ id: string }>(
    `SELECT id FROM sync_queue WHERE idempotencyKey = ? AND state <> 'synced'`,
    [base],
  );
  if (waiting) return waiting.id;

  /*
   * AN EDIT THAT MATCHES ONE ALREADY SENT IS A NEW EDIT, not the old one.
   *
   * The key was matched against every row ever written, so archive, unarchive,
   * archive on one lead — or a follow-up moved to X, then Y, then back to X —
   * made the third enqueue return the FIRST item's id, long since synced. It
   * was never sent: the office kept the middle value and the phone showed the
   * last. Re-using the old key would not help either, because the server's
   * receipts ledger would replay the first answer without applying anything.
   * So an update repeated after the original landed gets a key of its own,
   * numbered by how many times it has gone before. A create keeps the bare
   * key, because a create sent twice is exactly the duplicate this guards.
   */
  let key = base;
  if (args.op === 'update') {
    const sent = await one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sync_queue WHERE idempotencyKey = ? OR idempotencyKey LIKE ?`,
      [base, `${base}#%`],
    );
    if ((sent?.n ?? 0) > 0) key = `${base}#${sent!.n}`;
  }

  /* Composed before the insert and never awaited on the radio — see
     `native/where.ts`. A failure here is a queue item with no location, which
     is exactly what a phone in a basement should produce. */
  let location: string | null = null;
  if (args.location !== false) {
    try {
      const where = await whereNow();
      if (where) location = JSON.stringify(where);
    } catch {
      /* Nothing to tell anybody: the record is what matters and it is about
         to be written either way. */
    }
  }

  const id = newId('q');
  await run(
    `INSERT INTO sync_queue
       (id, entityType, entityId, op, payload, dependsOn, idempotencyKey, nextAttemptAt, state, createdAt, location)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
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
      location,
    ],
  );
  /* Tell the engine there is something to send, so a save goes up in about a
     second rather than on the next minute's tick. A hook rather than an
     import, because the engine imports this file. */
  onQueued?.();
  return id;
}

let onQueued: (() => void) | null = null;

/** The engine's way of hearing that something was just put in the outbox. */
export function whenQueued(listener: (() => void) | null): void {
  onQueued = listener;
}

/**
 * Whether anything is due to go out now — a single indexed count, cheap enough
 * to ask every few seconds. It can say yes for an item still waiting on a
 * dependency; `readyItems` is the real answer and is only asked after this.
 */
export async function anythingDue(now = Date.now()): Promise<boolean> {
  const row = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sync_queue WHERE state = 'queued' AND nextAttemptAt <= ?`,
    [now],
  );
  return (row?.n ?? 0) > 0;
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
/**
 * How many go in one request. The server's own ceiling is configuration
 * (`mbos.sync.maxItemsPerRequest`, 1 to 500) and this used to be a literal 50 —
 * so a manager who set the ceiling to 20 made every sync from every phone a
 * 413: no push, no pull, and every item exhausting its retries. Whichever is
 * smaller wins.
 */
export async function batchLimit(): Promise<number> {
  const { getConfig } = await import('../data/config');
  const ceiling = Number(await getConfig<number>('mbos.sync.maxItemsPerRequest', 50));
  return Number.isFinite(ceiling) && ceiling >= 1 ? Math.min(50, Math.floor(ceiling)) : 50;
}

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
  const settled = await all<{ entityId: string; state: string; op: string }>(
    `SELECT entityId, state, op FROM sync_queue WHERE state IN ('synced','rejected','failed','blocked')`,
  );
  const syncedIds = new Set(settled.filter((r) => r.state === 'synced').map((r) => r.entityId));
  /* DEAD MEANS ITS CREATE NEVER LANDED. A refused EDIT does not unmake a
     record the office already holds: an order accounts approved while the
     phone was stale, whose edit was then refused, is still an order — and the
     change request the office told him to send instead depends on it. Reading
     any refusal as death blocked that request for ever. */
  const deadIds = new Set(
    settled.filter((r) => r.state !== 'synced' && r.op === 'create').map((r) => r.entityId),
  );

  /* A dependency with NO row waiting anywhere in the outbox has landed: its
     create went up and has since been pruned (`pruneSynced`), or it is a record
     the office made. Without this, pruning sent rows would leave anything
     depending on a fortnight-old record waiting for ever. */
  const waitingIds = new Set(queued.map((q) => q.entityId));
  const inFlight = await all<{ entityId: string }>(`SELECT entityId FROM sync_queue WHERE state = 'syncing'`);
  for (const r of inFlight) waitingIds.add(r.entityId);
  for (const q of queued) {
    for (const d of JSON.parse(q.dependsOn) as string[]) {
      if (!waitingIds.has(d) && !deadIds.has(d)) syncedIds.add(d);
    }
  }

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
    await blockItem(item.id, 'Something this needs was not sent. Send that first.');
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
  /* Only a refused CREATE leaves dependents with nothing to attach to. */
  if (item.op === 'create') await blockDependents(item.entityId);
}

export async function markFailure(item: QueueItem, reason: string, now = Date.now()): Promise<void> {
  const attempts = item.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await run(`UPDATE sync_queue SET state = 'failed', attempts = ?, failureReason = ? WHERE id = ?`, [attempts, reason, item.id]);
    await setEntityState(item.entityType, item.entityId, 'failed', reason, null);
    if (item.op === 'create') await blockDependents(item.entityId);
    return;
  }
  await run(
    `UPDATE sync_queue SET state = 'queued', attempts = ?, nextAttemptAt = ?, failureReason = ? WHERE id = ?`,
    [attempts, backoffFor(attempts, now), reason, item.id],
  );
}

/**
 * Back in the queue with NOTHING counted against it. For a pass that failed
 * because nobody is signed in any more: the item did nothing wrong, and burning
 * its six attempts on a lapsed sign-in is how a day's orders end up `failed`
 * and blocked for a reason that has nothing to do with them.
 */
export async function markUnsent(item: QueueItem, reason: string): Promise<void> {
  await run(`UPDATE sync_queue SET state = 'queued', failureReason = ? WHERE id = ?`, [reason, item.id]);
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
      await blockItem(item.id, 'Something this needs was not sent. Send that first.');
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

/**
 * Everything authored here the office cannot see yet, counted in SQL — never
 * the length of a capped list.
 *
 * ONE predicate, because there were three counts of this one queue within
 * thirty points of each other on the Sync screen. The card added up the rows
 * it had drawn, which `listQueue` caps at fifty; the caption under it printed
 * this; and the status strip above both printed `pendingCount`, which left
 * `rejected` out. So a hundred and twenty queued items read "50 things
 * waiting" directly above "of 120 waiting", and three refused records read
 * "3 things waiting" under a green "All sent". After that he believes none of
 * the three.
 *
 * A refusal counts. It is work sitting on this phone that the office does not
 * have, which is the whole of what this number means — and "All sent" in green
 * over three records nobody accepted is the one direction this screen must not
 * get wrong.
 */
export async function queueDepth(): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sync_queue WHERE state <> 'synced'`,
  );
  return row?.n ?? 0;
}

/**
 * What the status strip counts, and what the Sync card's headline counts: the
 * outbox depth plus the photographs behind it. Composed from `queueDepth`
 * rather than spelling the states out a second time — the second copy is
 * always the half that drifts, and this one had.
 */
export async function pendingCount(): Promise<number> {
  const media = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM media_queue WHERE state IN ('queued','syncing','failed')`,
  );
  return (await queueDepth()) + (media?.n ?? 0);
}

/**
 * How many outbox rows the Sync screen draws at once.
 *
 * The read was unbounded and the screen maps every row it gets. That is fine
 * on the ordinary day — a handful of records waiting — and it is exactly wrong
 * on the day it matters: a week offline, or a queue that has stopped draining,
 * is when somebody opens this screen, and it is when the list is longest. The
 * customer book taught this lesson already, and it cost an ANR.
 *
 * The trouble is sorted so the rejected and failed rows come first, so a cap
 * keeps what somebody came to look at.
 */
export const QUEUE_PAGE = 50;

export async function listQueue(limit = QUEUE_PAGE): Promise<QueueItem[]> {
  return all<QueueItem>(
    `SELECT * FROM sync_queue WHERE state <> 'synced' ORDER BY
       CASE state WHEN 'rejected' THEN 0 WHEN 'failed' THEN 1 WHEN 'blocked' THEN 2
                  WHEN 'syncing' THEN 3 ELSE 4 END, createdAt DESC
     LIMIT ?`,
    [limit],
  );
}

/**
 * LET A REFUSED ENTRY GO, which the Not accepted screen could not do.
 *
 * Nothing on it removed anything, so a refusal that could never be put right
 * — a product taken off the list, a bill somebody else settled — sat there for
 * ever, and `autoRetryStuck` sent it again every three hours to be refused
 * again. This is always a person's decision, made on that screen with the
 * consequence said first; nothing calls it on its own.
 *
 * A refused CREATE never reached the office, so the local record goes with it —
 * the salesman is about to take it again, and two copies on his phone of one
 * order would be counted twice in his day. A refused EDIT leaves the record:
 * the office holds it, and the next pull writes the office's version back over
 * the edit it did not accept.
 */
const OWNED_CHILDREN: Record<string, { table: string; key: string }[]> = {
  order: [{ table: 'order_lines', key: 'orderId' }],
};

export async function discardRefused(id: string): Promise<void> {
  const item = await one<QueueItem>('SELECT * FROM sync_queue WHERE id = ?', [id]);
  if (!item || (item.state !== 'rejected' && item.state !== 'failed')) return;
  await run('DELETE FROM sync_queue WHERE id = ?', [id]);
  if (item.op !== 'create') return;
  for (const child of OWNED_CHILDREN[item.entityType] ?? []) {
    await run(`DELETE FROM ${child.table} WHERE ${child.key} = ?`, [item.entityId]);
  }
  const table = ENTITY_TABLE[item.entityType];
  if (table) await run(`DELETE FROM ${table} WHERE id = ?`, [item.entityId]);
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
export async function recoverInterrupted(
  now = Date.now(),
  opts: { media?: boolean } = {},
): Promise<number> {
  const stuck = await all<{ id: string }>(`SELECT id FROM sync_queue WHERE state = 'syncing'`);
  if (stuck.length) {
    await run(`UPDATE sync_queue SET state = 'queued', nextAttemptAt = ? WHERE state = 'syncing'`, [now]);
  }
  /* MEDIA ONLY ON A COLD START. This ran at the top of every sync pass, and a
     photo upload on 2G outlasts the three-second push tick — so a file still
     going up was reset to `queued` and picked up again by the next pass: two
     uploads of the same file at once, double the data on the worst
     connection, and a voice note transcribed twice. After a cold start
     nothing can be in flight, and that is the only time it is true. */
  if (opts.media !== false) {
    await run(`UPDATE media_queue SET state = 'queued', nextAttemptAt = ? WHERE state = 'syncing'`, [now]);
  }
  return stuck.length;
}

/**
 * Sent rows are kept a fortnight, then let go.
 *
 * They were never pruned, and `readyItems` reads every settled row whenever
 * anything is due — every three seconds while the app is open. A year of a
 * busy salesman's outbox is tens of thousands of rows read to decide whether
 * one visit may go. A fortnight is long past any dependency or retry that could
 * still ask about one.
 */
export const SYNCED_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

export async function pruneSynced(now = Date.now()): Promise<void> {
  await run(`DELETE FROM sync_queue WHERE state = 'synced' AND createdAt < ?`, [now - SYNCED_KEEP_MS]);
}

/**
 * Send refused and exhausted records again, without anybody pressing Retry.
 *
 * The server's rules move and this build cannot: a record refused under last
 * week's rule, or given up on after the server failed it five times, would sit
 * on this phone for ever — and everything queued behind it with it — because
 * the only way out was a Retry button nobody in the field presses. The server
 * judges a resent refusal afresh rather than replaying it, so sending it again
 * is exactly how a relaxed rule reaches a phone that cannot be changed.
 *
 * Throttled, because a record that is still wrong is refused again and must
 * not be resent on every tick. Returns how many went back in the queue.
 */
export async function autoRetryStuck(now = Date.now(), everyMs = 3 * 60 * 60 * 1000): Promise<number> {
  const last = Number((await one<{ value: string }>(`SELECT value FROM kv WHERE key = 'autoRetryAt'`))?.value ?? 0);
  if (last && now - last < everyMs && now >= last) return 0;
  await run(`INSERT OR REPLACE INTO kv (key, value) VALUES ('autoRetryAt', ?)`, [String(now)]);

  const stuck = await all<{ id: string }>(
    `SELECT id FROM sync_queue WHERE state IN ('rejected','failed') ORDER BY createdAt ASC`,
  );
  for (const row of stuck) await retryItem(row.id, now);
  return stuck.length;
}
