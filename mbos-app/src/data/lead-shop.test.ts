import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/schema';
import { partition, type Eligible } from '../sync/ordering';
import { LEAD_SHOP_SQL, leadShopParams, leadVisitRefusal } from './lead-shop';

/**
 * A lead added at the shop door is a shop he can visit at once (the field
 * report: "if we create a new lead in MBOS, sales folks are unable to create a
 * visit"). The insert runs against the REAL handset schema, and the visit's
 * place in the outbox is the real ordering rule.
 */

function handset(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const step of MIGRATIONS) for (const stmt of step) db.exec(stmt);
  return db;
}

const lead = { id: 'mbos_lead_1', name: 'Suresh Patil', company: 'Patil Hardware', mobile: '9822011003', city: ' Nagpur ', area: 'Sadar', customerType: 'retailer', gpsLat: 21.15, gpsLng: 79.08 };

test('a new lead is a customers row under its own id, named by its shop, marked a lead', () => {
  const db = handset();
  db.prepare(LEAD_SHOP_SQL).run(...leadShopParams(lead));
  const raw = db.prepare('SELECT id, name, contactPerson, phone, city, kind, gpsLat FROM customers WHERE id = ?').get(lead.id) as Record<string, unknown>;
  const row = { ...raw };
  assert.deepEqual(row, { id: 'mbos_lead_1', name: 'Patil Hardware', contactPerson: 'Suresh Patil', phone: '9822011003', city: 'Nagpur', kind: 'lead', gpsLat: 21.15 });
});

test('a lead with no shop name is named by what was typed, with nobody as its contact', () => {
  const db = handset();
  db.prepare(LEAD_SHOP_SQL).run(...leadShopParams({ ...lead, company: null }));
  const raw = db.prepare('SELECT name, contactPerson FROM customers WHERE id = ?').get(lead.id) as Record<string, unknown>;
  const row = { ...raw };
  assert.deepEqual(row, { name: 'Suresh Patil', contactPerson: null });
});

test("the office's copy, already on the phone, is never overwritten by the phone's", () => {
  const db = handset();
  db.prepare("INSERT INTO customers (id, name, kind, lastSyncedAt) VALUES (?, 'Patil Hardware & Paints', 'lead', 1)").run(lead.id);
  db.prepare(LEAD_SHOP_SQL).run(...leadShopParams(lead));
  const raw = db.prepare('SELECT name, lastSyncedAt FROM customers WHERE id = ?').get(lead.id) as Record<string, unknown>;
  const row = { ...raw };
  assert.deepEqual(row, { name: 'Patil Hardware & Paints', lastSyncedAt: 1 });
});

const item = (o: Partial<Eligible> & Pick<Eligible, 'id' | 'entityId'>): Eligible => ({ dependsOn: [], nextAttemptAt: 0, createdAt: 0, state: 'queued', ...o });

test('a visit to a lead still on its way up waits for it, then both leave on one pass', () => {
  const leadItem = item({ id: 'q1', entityId: lead.id, createdAt: 1 });
  const visit = item({ id: 'q2', entityId: 'visit_1', dependsOn: [lead.id], createdAt: 2 });
  const both = partition({ queued: [visit, leadItem], syncedIds: new Set(), deadIds: new Set(), now: 10 });
  assert.deepEqual(both.ready.map((r) => r.id), ['q1', 'q2'], 'the lead goes first, the visit behind it');
  const alone = partition({ queued: [visit], syncedIds: new Set(), deadIds: new Set([lead.id]), now: 10 });
  assert.deepEqual(alone.blocked.map((r) => r.id), ['q2'], 'a lead the office refused blocks its visit instead of sending it to be refused');
});

test('the lead record says why it cannot be visited, and nothing for an open lead', () => {
  assert.equal(leadVisitRefusal({ archived: 0, syncState: 'queued' }), null);
  assert.match(leadVisitRefusal({ archived: 0, syncState: 'rejected' }) ?? '', /already in the book/);
  assert.match(leadVisitRefusal({ archived: 1, syncState: 'synced' }) ?? '', /filed/);
});
