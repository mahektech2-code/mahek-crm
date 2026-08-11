import { run, tx } from '../db';
import type { PullPayload } from './api';

/**
 * Applying what came down.
 *
 * The rule that governs this whole file: a pull overwrites REFERENCE data and
 * never touches OWNED data. The server is authoritative about what a customer
 * owes; it is not authoritative about the visit this salesman saved four
 * minutes ago and has not sent yet. Confusing the two is how an offline app
 * eats somebody's morning.
 *
 * Every reference row is stamped with `lastSyncedAt`, because the screens that
 * decide on a cached figure — credit limit and outstanding above all — have to
 * be able to say how old it is.
 */

export async function applyPull(pull: PullPayload): Promise<number> {
  const now = Date.now();
  let touched = 0;

  await tx(async () => {
    touched += await upsertCustomers(pull.customers, now);
    touched += await upsertProducts(pull.products, now);
    touched += await upsertPriceList(pull.priceList);
    touched += await upsertSchemes(pull.schemes);
    touched += await upsertTimeline(pull.timeline);
    touched += await upsertStops(pull.journeyStops, now);
    touched += await upsertConfig(pull.config, now);
    touched += await upsertNotifications(pull.notifications);
    touched += await upsertLeaveBalances(pull.leaveBalances, now);
    touched += await upsertDocuments(pull.documents, now);
    touched += await upsertCourses(pull.courses, now);
    touched += await applyApprovals(pull.approvals);
    touched += await applyDeletions(pull.deletions);
  });

  return touched;
}

/* ------------------------------------------------------------- primitives */

type Row = Record<string, unknown>;

/** Upsert by primary key, writing only the columns the server actually sent. */
async function upsert(table: string, key: string, rows: unknown[] | undefined, extra: Row = {}): Promise<number> {
  if (!rows?.length) return 0;
  for (const raw of rows) {
    const row = { ...(raw as Row), ...extra };
    const cols = Object.keys(row);
    const marks = cols.map(() => '?').join(',');
    const sets = cols.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(', ');
    await run(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${marks})
       ON CONFLICT(${key}) DO UPDATE SET ${sets}`,
      cols.map((c) => normalise(row[c])),
    );
  }
  return rows.length;
}

/** SQLite takes no booleans, no objects and no undefined. */
function normalise(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'number') return v;
  return String(v);
}

/* ---------------------------------------------------------------- tables */

function upsertCustomers(rows: unknown[] | undefined, now: number) {
  return upsert('customers', 'id', rows, { lastSyncedAt: now });
}

function upsertProducts(rows: unknown[] | undefined, now: number) {
  return upsert('products', 'id', rows, { lastSyncedAt: now });
}

async function upsertPriceList(rows: unknown[] | undefined) {
  if (!rows?.length) return 0;
  /* The price list is small and replaced wholesale — a rate that was withdrawn
     has to disappear, and a per-row upsert would leave it behind. */
  await run('DELETE FROM price_list');
  for (const raw of rows) {
    const r = raw as { priceTag: string; productId: string; ratePaise: number };
    await run('INSERT INTO price_list (priceTag, productId, ratePaise) VALUES (?, ?, ?)', [r.priceTag, r.productId, r.ratePaise]);
  }
  return rows.length;
}

function upsertSchemes(rows: unknown[] | undefined) {
  return upsert('schemes', 'id', rows);
}

function upsertTimeline(rows: unknown[] | undefined) {
  return upsert('timeline_events', 'id', rows);
}

function upsertStops(rows: unknown[] | undefined, now: number) {
  return upsert('journey_stops', 'id', rows, { lastSyncedAt: now });
}

function upsertNotifications(rows: unknown[] | undefined) {
  return upsert('notifications', 'id', rows);
}

function upsertLeaveBalances(rows: unknown[] | undefined, now: number) {
  return upsert('leave_balances', 'kind', rows, { lastSyncedAt: now });
}

function upsertDocuments(rows: unknown[] | undefined, now: number) {
  return upsert('documents', 'id', rows, { lastSyncedAt: now });
}

function upsertCourses(rows: unknown[] | undefined, now: number) {
  return upsert('courses', 'id', rows, { lastSyncedAt: now });
}

async function upsertConfig(config: Record<string, unknown> | undefined, now: number): Promise<number> {
  if (!config) return 0;
  for (const [key, value] of Object.entries(config)) {
    await run(
      'INSERT INTO config (key, value, lastSyncedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, lastSyncedAt = excluded.lastSyncedAt',
      [key, JSON.stringify(value), now],
    );
  }
  return Object.keys(config).length;
}

/**
 * An approval decision coming back down.
 *
 * The subject record's state is DERIVED from its approval and never set on its
 * own — so an order becomes approved because its approval says so, not because
 * something wrote a flag onto the order.
 */
async function applyApprovals(rows: unknown[] | undefined): Promise<number> {
  if (!rows?.length) return 0;
  for (const raw of rows) {
    const a = raw as {
      id: string; subjectType: string; subjectId: string; state: string;
      decidedAt?: number; decisionNote?: string; approvedAmountPaise?: number; approverName?: string;
    };
    await run(
      `INSERT INTO approvals (id, type, subjectType, subjectId, state, decidedAt, decisionNote, approvedAmountPaise, approverName,
                              requestedAt, clientCreatedAt, deviceId, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'server', 'synced')
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, decidedAt = excluded.decidedAt,
         decisionNote = excluded.decisionNote, approvedAmountPaise = excluded.approvedAmountPaise,
         approverName = excluded.approverName, syncState = 'synced'`,
      [a.id, a.subjectType, a.subjectType, a.subjectId, a.state, a.decidedAt ?? null, a.decisionNote ?? null,
       a.approvedAmountPaise ?? null, a.approverName ?? null],
    );

    if (a.subjectType === 'order') {
      const status = a.state === 'approved' ? 'approved' : a.state === 'rejected' ? 'rejected' : 'pending_approval';
      await run('UPDATE orders SET status = ?, approvalId = ? WHERE id = ?', [status, a.id, a.subjectId]);
    } else if (a.subjectType === 'expense') {
      const state = a.state === 'approved' ? 'Approved' : a.state === 'rejected' ? 'Rejected' : 'Pending';
      await run('UPDATE expenses SET state = ?, approvedAmountPaise = ? WHERE id = ?', [state, a.approvedAmountPaise ?? null, a.subjectId]);
    } else if (a.subjectType === 'leave') {
      const state = a.state === 'approved' ? 'Approved' : a.state === 'rejected' ? 'Rejected' : 'Pending';
      await run('UPDATE leave_requests SET state = ? WHERE id = ?', [state, a.subjectId]);
    } else if (a.subjectType === 'sample') {
      await run('UPDATE samples SET state = ? WHERE id = ?', [a.state === 'approved' ? 'Approved' : 'Requested', a.subjectId]);
    }
  }
  return rows.length;
}

/**
 * Rows the server says are gone.
 *
 * Only ever reference data. Nothing the salesman authored is deleted by a
 * sync — not a rejected order, not a visit that lost a conflict.
 */
const DELETABLE = new Set(['customers', 'products', 'timeline_events', 'journey_stops', 'documents', 'courses', 'notifications', 'schemes']);

async function applyDeletions(deletions: { entity: string; ids: string[] }[] | undefined): Promise<number> {
  if (!deletions?.length) return 0;
  let n = 0;
  for (const d of deletions) {
    if (!DELETABLE.has(d.entity) || !d.ids.length) continue;
    const marks = d.ids.map(() => '?').join(',');
    await run(`DELETE FROM ${d.entity} WHERE id IN (${marks})`, d.ids);
    n += d.ids.length;
  }
  return n;
}
