import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/schema';
import {
  discardCount,
  discardWithDependents,
  handoverWork,
  markOrphans,
  ORPHAN_MESSAGE,
  reapplyEdit,
  restoreBeforeEdit,
  saveSnapshot,
  type Db,
  type OutboxRow,
} from './outbox-ops';

/**
 * Letting an entry go, and putting a refused edit back — against the REAL
 * handset schema, through the same functions the app calls.
 */

type Bind = string | number | null;

function handset(): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(':memory:');
  for (const step of MIGRATIONS) for (const stmt of step) raw.exec(stmt);
  const db: Db = {
    async all<T>(sql: string, params: Bind[] = []) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async one<T>(sql: string, params: Bind[] = []) {
      return (raw.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async run(sql: string, params: Bind[] = []) {
      raw.prepare(sql).run(...params);
    },
  };
  return { raw, db };
}

let seq = 0;
function queue(
  raw: DatabaseSync,
  o: { id: string; entityType: string; entityId: string; op?: 'create' | 'update'; state?: string; dependsOn?: string[]; createdAt?: number },
) {
  raw
    .prepare(
      `INSERT INTO sync_queue (id, entityType, entityId, op, payload, dependsOn, idempotencyKey, nextAttemptAt, state, createdAt)
       VALUES (?, ?, ?, ?, '{}', ?, ?, 0, ?, ?)`,
    )
    .run(o.id, o.entityType, o.entityId, o.op ?? 'create', JSON.stringify(o.dependsOn ?? []), `k${++seq}`, o.state ?? 'queued', o.createdAt ?? seq);
}

const ids = (raw: DatabaseSync, sql: string) => (raw.prepare(sql).all() as { id: string }[]).map((r) => r.id);

function leave(raw: DatabaseSync, id: string) {
  raw
    .prepare(
      `INSERT INTO leave_requests (id, userId, kind, fromDate, toDate, days, reason, state, clientCreatedAt, deviceId, syncState)
       VALUES (?, 'u1', 'casual', '2026-11-27', '2026-11-27', 1, 'Family', 'pending', 1, 'd', 'rejected')`,
    )
    .run(id);
}

test('letting a refused create go takes everything waiting on it, and their records', async () => {
  const { raw, db } = handset();
  leave(raw, 'lv1');
  raw
    .prepare(
      `INSERT INTO approvals (id, type, subjectType, subjectId, reason, requestedAt, state, clientCreatedAt, deviceId, syncState)
       VALUES ('ap1', 'leave', 'leave', 'lv1', 'Family', 1, 'pending', 1, 'd', 'blocked')`,
    )
    .run();
  queue(raw, { id: 'q1', entityType: 'leave', entityId: 'lv1', state: 'rejected' });
  queue(raw, { id: 'q2', entityType: 'approval', entityId: 'ap1', state: 'blocked', dependsOn: ['lv1'] });
  /* The Withdraw he pressed afterwards — an edit to the refused record. */
  queue(raw, { id: 'q3', entityType: 'leave', entityId: 'lv1', op: 'update', state: 'blocked', dependsOn: ['lv1'] });
  /* Somebody else's entry, which must stay. */
  queue(raw, { id: 'q4', entityType: 'task', entityId: 't9', state: 'queued' });

  assert.equal(await discardCount(db, 'q1'), 2, 'the confirm says two more go with it');
  assert.equal(await discardWithDependents(db, 'q1'), 3);
  assert.deepEqual(ids(raw, 'SELECT id FROM sync_queue ORDER BY id'), ['q4']);
  assert.deepEqual(ids(raw, 'SELECT id FROM leave_requests'), []);
  assert.deepEqual(ids(raw, 'SELECT id FROM approvals'), []);
});

test('a dependent several steps behind goes too', async () => {
  const { raw, db } = handset();
  queue(raw, { id: 'q1', entityType: 'lead', entityId: 'lead1', state: 'rejected' });
  queue(raw, { id: 'q2', entityType: 'visit', entityId: 'v1', state: 'blocked', dependsOn: ['lead1'] });
  queue(raw, { id: 'q3', entityType: 'payment', entityId: 'p1', state: 'blocked', dependsOn: ['v1'] });
  assert.equal(await discardCount(db, 'q1'), 2);
  await discardWithDependents(db, 'q1');
  assert.deepEqual(ids(raw, 'SELECT id FROM sync_queue'), []);
});

test('an entry still being sent cannot be let go; a failed or blocked one can', async () => {
  const { raw, db } = handset();
  queue(raw, { id: 'q1', entityType: 'task', entityId: 't1', state: 'queued' });
  queue(raw, { id: 'q2', entityType: 'task', entityId: 't2', state: 'failed' });
  queue(raw, { id: 'q3', entityType: 'task', entityId: 't3', state: 'blocked' });
  assert.equal(await discardWithDependents(db, 'q1'), 0);
  assert.equal(await discardWithDependents(db, 'q2'), 1);
  assert.equal(await discardWithDependents(db, 'q3'), 1);
  assert.deepEqual(ids(raw, 'SELECT id FROM sync_queue'), ['q1']);
});

function task(raw: DatabaseSync, id: string, status: string) {
  raw
    .prepare(
      `INSERT INTO tasks (id, title, dueDate, status, clientCreatedAt, deviceId, syncState)
       VALUES (?, 'Ring Patil', '2026-11-26', ?, 1, 'd', 'queued')`,
    )
    .run(id, status);
}

const row = (raw: DatabaseSync, id: string): OutboxRow => raw.prepare('SELECT * FROM sync_queue WHERE id = ?').get(id) as OutboxRow;
const statusOf = (raw: DatabaseSync, id: string) => (raw.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }).status;

test('a refused Done puts the task back on the list, and sending it again takes it off', async () => {
  const { raw, db } = handset();
  task(raw, 't1', 'done');
  queue(raw, { id: 'q1', entityType: 'task', entityId: 't1', op: 'update', state: 'rejected' });
  await saveSnapshot(db, 'q1', { table: 'tasks', prev: { status: 'open', completionNote: null }, next: { status: 'done', completionNote: 'Called' } });

  assert.equal(await restoreBeforeEdit(db, row(raw, 'q1')), true);
  assert.equal(statusOf(raw, 't1'), 'open');
  await reapplyEdit(db, row(raw, 'q1'));
  assert.equal(statusOf(raw, 't1'), 'done');
});

test('an edit queued by an older build, with nothing remembered, still reopens the task', async () => {
  const { raw, db } = handset();
  task(raw, 't1', 'done');
  queue(raw, { id: 'q1', entityType: 'task', entityId: 't1', op: 'update', state: 'rejected' });
  assert.equal(await restoreBeforeEdit(db, row(raw, 'q1')), true);
  assert.equal(statusOf(raw, 't1'), 'open');
});

test('a later edit still waiting is not rolled back underneath', async () => {
  const { raw, db } = handset();
  task(raw, 't1', 'done');
  queue(raw, { id: 'q1', entityType: 'task', entityId: 't1', op: 'update', state: 'rejected', createdAt: 10 });
  queue(raw, { id: 'q2', entityType: 'task', entityId: 't1', op: 'update', state: 'queued', createdAt: 20 });
  await saveSnapshot(db, 'q1', { table: 'tasks', prev: { status: 'open' }, next: { status: 'done' } });
  assert.equal(await restoreBeforeEdit(db, row(raw, 'q1')), false);
  assert.equal(statusOf(raw, 't1'), 'done');
});

test('removing a refused edit leaves the record, as the office has it', async () => {
  const { raw, db } = handset();
  task(raw, 't1', 'done');
  queue(raw, { id: 'q1', entityType: 'task', entityId: 't1', op: 'update', state: 'rejected' });
  await saveSnapshot(db, 'q1', { table: 'tasks', prev: { status: 'open' }, next: { status: 'done' } });
  await discardWithDependents(db, 'q1');
  const t = raw.prepare('SELECT status, syncState FROM tasks WHERE id = ?').get('t1') as Record<string, unknown>;
  assert.deepEqual({ ...t }, { status: 'open', syncState: 'synced' });
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'prev:%'`).get()?.n, 0, 'the snapshot goes with it');
});

test('a fortnight-old stuck entry no longer holds the phone; one still sending always does', async () => {
  const { raw, db } = handset();
  const now = 100 * 86_400_000;
  const day = 86_400_000;
  queue(raw, { id: 'q1', entityType: 'task', entityId: 't1', state: 'failed', createdAt: now - 20 * day });
  queue(raw, { id: 'q2', entityType: 'task', entityId: 't2', state: 'blocked', createdAt: now - 20 * day });
  queue(raw, { id: 'q3', entityType: 'task', entityId: 't3', state: 'failed', createdAt: now - 2 * day });
  queue(raw, { id: 'q4', entityType: 'task', entityId: 't4', state: 'queued', createdAt: now - 30 * day });
  queue(raw, { id: 'q5', entityType: 'task', entityId: 't5', state: 'rejected', createdAt: now });
  assert.deepEqual(await handoverWork(db, now, 14), { counted: 2, ignored: 2 });
});

test('a record saved with nothing queued says it never went; one with its entry is left alone', async () => {
  const { raw, db } = handset();
  task(raw, 't1', 'open');
  task(raw, 't2', 'open');
  queue(raw, { id: 'q2', entityType: 'task', entityId: 't2' });
  assert.equal(await markOrphans(db), 1);
  const t1 = raw.prepare('SELECT syncState, syncMessage FROM tasks WHERE id = ?').get('t1') as Record<string, unknown>;
  assert.deepEqual({ ...t1 }, { syncState: 'failed', syncMessage: ORPHAN_MESSAGE });
  assert.equal((raw.prepare('SELECT syncState FROM tasks WHERE id = ?').get('t2') as { syncState: string }).syncState, 'queued');
});
