import { all, run, tx } from '../db';
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
    touched += await upsertPlanDays(pull.planDays, now);
    touched += await upsertConfig(pull.config, now);
    touched += await upsertNotifications(pull.notifications);
    touched += await upsertLeaveBalances(pull.leaveBalances, now);
    touched += await upsertHolidays(pull.holidays, now);
    touched += await upsertDocuments(pull.documents, now);
    touched += await upsertCourses(pull.courses, now);
    touched += await upsertPerformance(pull.performance, now);
    touched += await upsertTasks(pull.tasks, now);
    touched += await upsertLeads(pull.leads, now);
    touched += await upsertSamples(pull.samples, now);
    touched += await upsertSalary(pull.salary, now);
    touched += await applyApprovals(pull.approvals);
    touched += await applyDeletions(pull.deletions);
  });

  /* Outside the transaction, because confirming a transcript deletes the audio
     file from the filesystem — which is not a thing a database transaction can
     roll back, and not a thing to hold one open across. */
  touched += await applyTranscripts(pull.transcripts);

  return touched;
}

/**
 * The words the office wrote out, coming home.
 *
 * This is the other end of the rule in `sync/media.ts`: a recording is kept
 * until its transcription is confirmed STORED, not merely until the upload
 * succeeded. Until this channel existed the confirmation never arrived, so
 * every voice note ever recorded stayed on the handset — correctly, and
 * forever.
 */
async function applyTranscripts(
  rows: { mediaId: string; transcript: string }[] | undefined,
): Promise<number> {
  if (!rows?.length) return 0;
  const { confirmTranscription } = await import('./media');
  for (const row of rows) {
    if (row.mediaId && row.transcript) {
      await confirmTranscription(row.mediaId, row.transcript);
    }
  }
  return rows.length;
}

/* ------------------------------------------------------------- primitives */

type Row = Record<string, unknown>;

/**
 * What this table can actually hold, asked of SQLite rather than assumed.
 *
 * Cached for the life of the process: a migration runs once, on open, before
 * any of this — so the answer cannot change underneath a sync.
 */
const columnsOf = new Map<string, Set<string>>();

async function knownColumns(table: string): Promise<Set<string>> {
  const cached = columnsOf.get(table);
  if (cached) return cached;
  const info = await all<{ name: string }>(`PRAGMA table_info(${table})`);
  const cols = new Set(info.map((c) => c.name));
  columnsOf.set(table, cols);
  return cols;
}

/**
 * Upsert by primary key, writing the columns the server sent THAT THIS
 * HANDSET HAS SOMEWHERE TO PUT.
 *
 * The filter is the whole point, and it was missing. SQLite refuses a column
 * it does not have, so one field the server knew about and this build did not
 * threw — and because `applyPull` is a single transaction, that throw rolled
 * back every table in the pull, not just the one. `signIn` then caught it,
 * found it was not an `ApiError`, and signed the salesman in through the
 * offline path with an empty database and nothing on the screen.
 *
 * An APK cannot be recalled, so the server has to be able to move first. A
 * column this build does not know about is one it cannot use anyway; dropping
 * it costs a field the screens never read, and refusing it costs the book.
 */
async function upsert(table: string, key: string, rows: unknown[] | undefined, extra: Row = {}): Promise<number> {
  if (!rows?.length) return 0;
  const known = await knownColumns(table);
  for (const raw of rows) {
    const row = { ...(raw as Row), ...extra };
    const cols = Object.keys(row).filter((c) => known.has(c));
    if (!cols.includes(key)) continue;
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

/**
 * The days, and where each has got to.
 *
 * `syncState: 'synced'` is set alongside, because a pull is the office's word
 * arriving — it overwrites whatever this handset thought, including an answer
 * that has since been superseded. An answer still waiting in the outbox is not
 * lost by this: the outbox is what will resend it.
 */
function upsertPlanDays(rows: unknown[] | undefined, now: number) {
  return upsert('journey_days', 'id', rows, { lastSyncedAt: now, syncState: 'synced' });
}

function upsertNotifications(rows: unknown[] | undefined) {
  return upsert('notifications', 'id', rows);
}

function upsertLeaveBalances(rows: unknown[] | undefined, now: number) {
  return upsert('leave_balances', 'kind', rows, { lastSyncedAt: now });
}

function upsertHolidays(rows: unknown[] | undefined, now: number) {
  return upsert('holidays', 'id', rows, { lastSyncedAt: now });
}

/*
 * Keyed on the PERIOD, so a rebuilt month replaces itself rather than stacking.
 * The office recomputes this hourly and the same period comes down again and
 * again; an id-keyed upsert would leave one row per rebuild and the screen
 * would pick whichever it read first.
 */
function upsertPerformance(rows: unknown[] | undefined, now: number) {
  return upsert('performance', 'period', rows, { lastSyncedAt: now });
}

function upsertSalary(rows: unknown[] | undefined, now: number) {
  return upsert('salary', 'period', rows, { lastSyncedAt: now });
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
 * A task the office raised or reassigned, coming down.
 *
 * The columns are not the same word on both ends — see `lib/wire.ts`'s own
 * account of why a mapping like this has to be a function and not a payload
 * literal. `assignedToUserId`/`assignedByUserId` become `assigneeId`/
 * `assignerId`; `snoozedTo`/`snoozeReason` fold into the one JSON history
 * column this table already keeps; `escalatedAt` becomes the boolean this
 * table already has. `in_progress` is not a bucket this app's screens draw,
 * so it reads as `open` rather than a status nothing knows how to show.
 *
 * `clientCreatedAt: 0` / `deviceId: 'server'` mark a row that never touched a
 * device — the same convention `applyApprovals` below already uses. Like
 * every other channel in this file, a pull overwrites what is here: an
 * outbox write still in flight for this same task is not lost, because the
 * outbox is what resends it and wins the next round trip.
 */
/**
 * A lead and a sample the OFFICE holds, coming home.
 *
 * These are the only two tables written from both ends. They are OWNED — the
 * salesman raises them in the field — and they also have an office end, which
 * is why a plain reference upsert is wrong for both: it would overwrite an
 * edit sitting in the outbox with the older row the server still believes.
 * `WHERE syncState = 'synced'` is what keeps that from happening. A queued row
 * is one this handset has said something about and the office has not heard
 * yet, so the local answer is the newer fact and it stands until it is sent.
 *
 * The words differ too, and not only in case — PROTOCOL.md §4.1 and
 * `lib/wire.ts`. `companyName` is `company`, a lower-case `won` is
 * `Converted`, one note field is a list, and a sample's `state` is not on the
 * wire at all because MahekOne tracks the two timestamps behind it instead.
 * That is exactly why neither of these can go through the generic upsert: it
 * writes the keys it is given, and none of these five is the same word twice.
 */
async function upsertLeads(rows: unknown[] | undefined, now: number): Promise<number> {
  if (!rows?.length) return 0;
  const { localNotes, localStage } = await import('../lib/wire');
  for (const raw of rows) {
    const l = raw as {
      id: string;
      name: string;
      companyName?: string | null;
      mobile?: string | null;
      city?: string | null;
      source?: string | null;
      stage?: string;
      estimatedPotentialPaise?: number | null;
      nextFollowUpDate?: string | null;
      notes?: string | null;
      convertedCustomerId?: string | null;
      lastActivityDate?: string | null;
    };
    await run(
      `INSERT INTO leads (id, name, company, mobile, city, source, estimatedPotentialPaise,
                          assigneeId, stage, nextFollowUpDate, notes, convertedCustomerId,
                          archived, lastActivityDate, clientCreatedAt, serverCreatedAt,
                          deviceId, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, ?, 'server', 'synced')
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, company = excluded.company, mobile = excluded.mobile,
         city = excluded.city, source = excluded.source,
         estimatedPotentialPaise = excluded.estimatedPotentialPaise,
         stage = excluded.stage, nextFollowUpDate = excluded.nextFollowUpDate,
         convertedCustomerId = excluded.convertedCustomerId,
         lastActivityDate = excluded.lastActivityDate
       WHERE leads.syncState = 'synced'`,
      [
        l.id,
        l.name,
        l.companyName ?? null,
        l.mobile ?? null,
        l.city ?? null,
        l.source ?? null,
        l.estimatedPotentialPaise ?? null,
        localStage(l.stage),
        l.nextFollowUpDate ?? null,
        /* Only on INSERT. The note list is APPENDED to locally and the wire
           carries one flattened string, so re-writing it on every pass would
           replace a salesman's own notes with the office's rendering of them. */
        localNotes(l.notes, now),
        l.convertedCustomerId ?? null,
        l.lastActivityDate ?? null,
        now,
        now,
      ],
    );
  }
  return rows.length;
}

async function upsertSamples(rows: unknown[] | undefined, now: number): Promise<number> {
  if (!rows?.length) return 0;
  const { localInstant, localSampleState } = await import('../lib/wire');
  for (const raw of rows) {
    const s = raw as {
      id: string;
      customerId: string;
      productId?: string | null;
      productName?: string | null;
      quantityCans?: number | null;
      requestedDate?: string | null;
      deliveredAt?: string | null;
      deliveryPhotoId?: string | null;
      trialOutcome?: string | null;
      followUpDate?: string | null;
      feedbackNotes?: string | null;
      convertedOrderId?: string | null;
    };
    await run(
      `INSERT INTO samples (id, customerId, productId, productName, cans, reason,
                            requestedAt, state, deliveredAt, deliveryPhotoId, trialOutcome,
                            followUpDate, convertedOrderId, clientCreatedAt, serverCreatedAt,
                            deviceId, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'server', 'synced')
       ON CONFLICT(id) DO UPDATE SET
         productId = excluded.productId, productName = excluded.productName,
         cans = excluded.cans, reason = excluded.reason, state = excluded.state,
         deliveredAt = excluded.deliveredAt, deliveryPhotoId = excluded.deliveryPhotoId,
         trialOutcome = excluded.trialOutcome, followUpDate = excluded.followUpDate,
         convertedOrderId = excluded.convertedOrderId
       WHERE samples.syncState = 'synced'`,
      [
        s.id,
        s.customerId,
        s.productId ?? null,
        s.productName ?? null,
        s.quantityCans ?? null,
        /* `feedbackNotes` is what this app sends its `reason` as — the round
           trip, not two different fields. See `requestSample`. */
        s.feedbackNotes ?? null,
        /* NOT NULL, and a sample with no requested date is still a sample:
           the day it arrived is a worse answer than the day it was raised and
           a better one than refusing the row. */
        localInstant(s.requestedDate) ?? now,
        localSampleState(s),
        localInstant(s.deliveredAt),
        s.deliveryPhotoId ?? null,
        s.trialOutcome ?? null,
        s.followUpDate ?? null,
        s.convertedOrderId ?? null,
        now,
        now,
      ],
    );
  }
  return rows.length;
}

async function upsertTasks(rows: unknown[] | undefined, now: number): Promise<number> {
  if (!rows?.length) return 0;
  const { localPriority } = await import('../lib/wire');
  for (const raw of rows) {
    const t = raw as {
      id: string;
      title: string;
      description?: string | null;
      assignedToUserId: string;
      assignedByUserId?: string | null;
      priority: string;
      dueDate: string;
      customerId?: string | null;
      status: string;
      completionNote?: string | null;
      completionPhotoId?: string | null;
      snoozedTo?: string | null;
      snoozeReason?: string | null;
      escalatedAt?: string | null;
    };
    const status = t.status === 'in_progress' ? 'open' : t.status;
    const snoozeHistory = t.snoozedTo
      ? JSON.stringify([{ at: now, to: t.snoozedTo, reason: t.snoozeReason ?? '' }])
      : null;
    await run(
      `INSERT INTO tasks (id, title, description, assigneeId, assignerId, priority, dueDate,
                          customerId, status, completionNote, completionPhotoId, snoozeHistory,
                          escalated, clientCreatedAt, serverCreatedAt, deviceId, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'server', 'synced')
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, description = excluded.description,
         priority = excluded.priority, dueDate = excluded.dueDate, customerId = excluded.customerId,
         status = excluded.status, completionNote = excluded.completionNote,
         completionPhotoId = excluded.completionPhotoId, escalated = excluded.escalated,
         syncState = 'synced'`,
      [
        t.id,
        t.title,
        t.description ?? null,
        t.assignedToUserId,
        t.assignedByUserId ?? null,
        localPriority(t.priority),
        t.dueDate,
        t.customerId ?? null,
        status,
        t.completionNote ?? null,
        t.completionPhotoId ?? null,
        snoozeHistory,
        t.escalatedAt ? 1 : 0,
        now,
      ],
    );
  }
  return rows.length;
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
    } else if (a.subjectType === 'tour') {
      const state = a.state === 'approved' ? 'Approved' : a.state === 'rejected' ? 'Rejected' : 'Pending';
      await run('UPDATE tours SET state = ?, decisionNote = ? WHERE id = ?', [state, a.decisionNote ?? null, a.subjectId]);
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
const DELETABLE = new Set(['customers', 'products', 'timeline_events', 'journey_stops', 'documents', 'courses', 'notifications', 'schemes', 'holidays']);

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
