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

test("a refused lead's phone-only shop goes; one the office sent stays", async () => {
  const { DROP_PHONE_LEAD_SHOP_SQL, LEAD_CREATE_REFUSED_SQL } = await import('./lead-shop');
  const db = handset();
  db.prepare(LEAD_SHOP_SQL).run(...leadShopParams(lead));
  db.prepare("INSERT INTO customers (id, name, kind, lastSyncedAt) VALUES ('office_lead', 'Office Lead', 'lead', 5)").run();
  db.prepare(DROP_PHONE_LEAD_SHOP_SQL).run(lead.id);
  db.prepare(DROP_PHONE_LEAD_SHOP_SQL).run('office_lead');
  const ids = (db.prepare('SELECT id FROM customers ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  assert.deepEqual(ids, ['office_lead']);
  db.prepare(
    `INSERT INTO sync_queue (id, entityType, entityId, op, payload, dependsOn, idempotencyKey, nextAttemptAt, state, createdAt)
     VALUES ('q1', 'lead', ?, 'create', '{}', '[]', 'k1', 0, 'rejected', 0)`,
  ).run(lead.id);
  assert.ok(db.prepare(LEAD_CREATE_REFUSED_SQL).get(lead.id), 'the refusal is read off the outbox');
  assert.equal(db.prepare(LEAD_CREATE_REFUSED_SQL).get('someone_else'), undefined);
});

function leadCreate(db: DatabaseSync, id: string, entityId: string, state: string, code: string | null = null) {
  db.prepare(
    `INSERT INTO sync_queue (id, entityType, entityId, op, payload, dependsOn, idempotencyKey, nextAttemptAt, state, failureCode, createdAt)
     VALUES (?, 'lead', ?, 'create', '{}', '[]', ?, 0, ?, ?, 0)`,
  ).run(id, entityId, id, state, code);
}

test('ghosts stranded by an older build go on the next pull — only refused, only the phone’s own', async () => {
  const { DROP_REFUSED_LEAD_SHOPS_SQL, REFUSED_LEAD_SHOPS_SQL } = await import('./lead-shop');
  const db = handset();
  const ghost = (id: string) => db.prepare(LEAD_SHOP_SQL).run(...leadShopParams({ ...lead, id }));
  ghost('refused');
  ghost('waiting');
  db.prepare("INSERT INTO customers (id, name, kind, lastSyncedAt) VALUES ('office_copy', 'Office', 'lead', 9)").run();
  leadCreate(db, 'q1', 'refused', 'rejected', 'duplicate');
  leadCreate(db, 'q2', 'waiting', 'queued');
  leadCreate(db, 'q3', 'office_copy', 'rejected', 'duplicate');
  assert.equal((db.prepare(REFUSED_LEAD_SHOPS_SQL).get() as { n: number }).n, 1);
  db.prepare(DROP_REFUSED_LEAD_SHOPS_SQL).run();
  const left = (db.prepare('SELECT id FROM customers ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  assert.deepEqual(left, ['office_copy', 'waiting'], 'a lead still on its way keeps its shop; the office’s copy is the reconcile’s');
});

test('a refusal as a duplicate is told apart from any other, so the banner can open the existing shop', async () => {
  const { DUPLICATE_REFUSAL_SQL } = await import('./lead-shop');
  const db = handset();
  leadCreate(db, 'q1', 'dup', 'rejected', 'duplicate');
  leadCreate(db, 'q2', 'outside', 'rejected', 'not_permitted');
  assert.equal((db.prepare(DUPLICATE_REFUSAL_SQL).get('dup') as { code: string }).code, 'duplicate');
  assert.equal((db.prepare(DUPLICATE_REFUSAL_SQL).get('outside') as { code: string }).code, 'not_permitted');
  assert.equal(db.prepare(DUPLICATE_REFUSAL_SQL).get('none'), undefined);
});

test('A FILED LEAD is one rule for the list and the duplicate check: a lead, and filed', async () => {
  const { DUPLICATE_CUSTOMERS_SQL, DUPLICATE_LEADS_SQL, filedLeadClause, leadCustomerClause } = await import('./lead-query');
  const db = handset();
  const addLead = db.prepare(
    `INSERT INTO leads (id, name, mobile, stage, funnelStage, archived, clientCreatedAt, deviceId) VALUES (?, ?, ?, ?, ?, ?, 1, 'dev')`,
  );
  addLead.run('filed', 'Filed Paints', '9822000001', 'Lost', 'lost', 1);
  addLead.run('live', 'Live Paints', '9822000002', 'New', 'suspect', 0);
  addLead.run('won', 'Won Paints', '9822000003', 'Converted', 'won', 1);
  const shop = db.prepare(`INSERT INTO customers (id, name, phone, kind) VALUES (?, ?, ?, ?)`);
  shop.run('filed', 'Filed Paints', '9822000001', 'lead');
  shop.run('live', 'Live Paints', '9822000002', 'lead');
  shop.run('won', 'Won Paints', '9822000003', 'customer');
  const rows = db
    .prepare(`SELECT id, ${leadCustomerClause('customers')} AS live, ${filedLeadClause('customers')} AS filed FROM customers ORDER BY id`)
    .all()
    .map((r) => ({ ...(r as Record<string, unknown>) }));
  assert.deepEqual(rows, [
    { id: 'filed', live: 0, filed: 1 },
    { id: 'live', live: 1, filed: 0 },
    { id: 'won', live: 0, filed: 0 },
  ]);
  const dupCustomers = db.prepare(DUPLICATE_CUSTOMERS_SQL).all().map((r) => ({ ...(r as Record<string, unknown>) }));
  assert.deepEqual(
    dupCustomers.map((r) => [r.id, r.isLead, r.isFiled]),
    [['filed', 1, 1], ['live', 1, 0], ['won', 0, 0]],
  );
  const dupLeads = (db.prepare(DUPLICATE_LEADS_SQL).all() as { id: string }[]).map((r) => r.id).sort();
  assert.deepEqual(dupLeads, ['filed', 'live'], 'a lost lead is still found by its number; a converted one is the customer');
});
