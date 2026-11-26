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

test('a shop edit on its way holds his contact and pin against the pull, and nothing else', async () => {
  const { pendingShopEdit, SHOP_EDIT_COLUMNS, upsertSets } = await import('./pending');
  const db = handset();
  db.prepare(
    `INSERT INTO customers (id, name, contactPerson, gpsLat, gpsLng, outstandingPaise) VALUES ('c1', 'Sai Paints', 'Ramesh (his fix)', 21.1, 79.1, 0)`,
  ).run();
  queue(db, 'q1', 'customer', 'c1', JSON.stringify({ customerId: 'c1', contactPerson: 'Ramesh (his fix)' }));
  const cols = ['id', 'name', 'contactPerson', 'gpsLat', 'gpsLng', 'outstandingPaise'];
  const sets = upsertSets('customers', cols, 'id', { cols: SHOP_EDIT_COLUMNS, while: pendingShopEdit('customers') });
  const pull = db.prepare(
    `INSERT INTO customers (${cols.join(',')}) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ${sets}`,
  );
  pull.run('c1', 'Sai Paints', 'Office contact', null, null, 50000);
  const held = { ...(db.prepare('SELECT contactPerson, gpsLat, outstandingPaise FROM customers WHERE id = ?').get('c1') as Record<string, unknown>) };
  assert.deepEqual(held, { contactPerson: 'Ramesh (his fix)', gpsLat: 21.1, outstandingPaise: 50000 }, 'the money lands; his fix stands');

  db.prepare(`UPDATE sync_queue SET state = 'synced' WHERE id = 'q1'`).run();
  pull.run('c1', 'Sai Paints', 'Office contact', 21.2, 79.2, 50000);
  const after = { ...(db.prepare('SELECT contactPerson, gpsLat FROM customers WHERE id = ?').get('c1') as Record<string, unknown>) };
  assert.deepEqual(after, { contactPerson: 'Office contact', gpsLat: 21.2 }, 'once heard, the office is the newer fact');
});

test('pull.ts holds the shop-edit columns on the customers upsert', () => {
  const src = readFileSync(`${import.meta.dirname}/pull.ts`, 'utf8');
  assert.match(src, /function upsertCustomers[\s\S]{0,400}SHOP_EDIT_COLUMNS[\s\S]{0,80}pendingShopEdit\('customers'\)/);
});
