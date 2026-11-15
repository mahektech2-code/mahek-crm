import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/schema';
import { noPendingLead } from './pending';

/**
 * A Suspect decision taken on a visit is written onto the local lead row but
 * travels inside the VISIT — so the lead guard has to see a pending visit that
 * names the shop, or the next pull writes the office's older rung back over
 * the decision.
 */

function handset(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const step of MIGRATIONS) for (const stmt of step) db.exec(stmt);
  return db;
}

function queue(db: DatabaseSync, id: string, entityType: string, entityId: string, payload: string, state = 'queued') {
  db.prepare(
    `INSERT INTO sync_queue (id, entityType, entityId, op, payload, idempotencyKey, state, createdAt)
     VALUES (?, ?, ?, 'create', ?, ?, ?, 1)`,
  ).run(id, entityType, entityId, payload, id, state);
}

function held(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT id FROM leads WHERE NOT (${noPendingLead('leads')}) ORDER BY id`).all() as { id: string }[]).map(
    (r) => r.id,
  );
}

test('a pending visit carrying a Suspect decision holds the lead back from the pull', () => {
  const db = handset();
  for (const id of ['decided', 'reasoned', 'plain-visit', 'own-edit', 'sent', 'garbled', 'untouched']) {
    db.prepare(`INSERT INTO leads (id, name, stage, archived, clientCreatedAt, deviceId) VALUES (?, ?, 'New', 0, 1, 'dev')`).run(id, id);
  }
  queue(db, 'q1', 'visit', 'v1', JSON.stringify({ customerId: 'decided', suspectDecision: 'qualified' }));
  queue(db, 'q2', 'visit', 'v2', JSON.stringify({ customerId: 'reasoned', suspectReason: 'Back after Diwali' }));
  queue(db, 'q3', 'visit', 'v3', JSON.stringify({ customerId: 'plain-visit' }));
  queue(db, 'q4', 'lead', 'own-edit', JSON.stringify({ stage: 'prospect' }));
  queue(db, 'q5', 'visit', 'v5', JSON.stringify({ customerId: 'sent', suspectDecision: 'lost' }), 'synced');
  queue(db, 'q6', 'visit', 'v6', 'not json {', 'queued');
  assert.deepEqual(held(db), ['decided', 'own-edit', 'reasoned']);
  db.close();
});

test('a lead the office sends is written live, and an archived lead holds no shop', () => {
  /* `pull.ts` imports expo-sqlite and cannot be loaded here, so the two
     statements are read as text — the technique `deletable.test.ts` uses. */
  const src = readFileSync(new URL('./pull.ts', import.meta.url), 'utf8');
  const upsert = src.slice(src.indexOf('INSERT INTO leads'), src.indexOf("WHERE ${noPendingLead('leads')}`"));
  assert.match(upsert, /archived = 0\s*$/m, 'upsertLeads must restore archived = 0 on conflict');
  assert.ok(
    src.includes('WHERE id NOT IN (SELECT id FROM leads WHERE archived = 0)'),
    'reconcileBook must keep a shop only for a LIVE lead row',
  );
  assert.match(src, /entity === 'leads'[\s\S]{0,120}SET archived = 1/, 'a leads tombstone archives');
});
