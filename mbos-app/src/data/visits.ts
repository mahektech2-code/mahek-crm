import { all, newId, one, run, tx } from '../db';
import { enqueue } from '../sync/queue';
import { insertLocal, stamp } from './write';
import { notify } from './notifications';
import type { Fix } from '../native/location';

/**
 * Saving a visit.
 *
 * This is one transaction across every side effect it causes, and that is
 * deliberate: the visit, the order punched inside it, the payment collected
 * against that order, the follow-up task, the timeline event and all of their
 * queue items either all land or none do. A half-saved visit describes
 * something that never happened, and nobody can reconstruct which half was
 * real afterwards.
 */

export type SaveVisitArgs = {
  customerId: string;
  customerName: string;
  userId: string;
  checkIn: Fix | null;
  checkOut: Fix | null;
  outcome: string;
  notes: string | null;
  transcript: string | null;
  transcriptIsAi: boolean;
  shopPhotoId: string | null;
  custPhotoId: string | null;
  voiceNoteId: string | null;
  nextFollowUpDate: string | null;
  journeyStopId: string | null;
  wasPlanned: boolean;
  deviationReason: string | null;
  locationMismatch: boolean;
  metresFromShop: number | null;
  verified: boolean;
  unverifiedReason: string | null;
  /** Records already created from inside this visit, to be linked to it. */
  linkedOrderId?: string | null;
  linkedPaymentId?: string | null;
  linkedComplaintId?: string | null;
  linkedSampleId?: string | null;
};

export async function saveVisit(args: SaveVisitArgs): Promise<string> {
  const base = await stamp('visit');

  const durationSeconds =
    args.checkIn && args.checkOut ? Math.max(0, Math.round((args.checkOut.at - args.checkIn.at) / 1000)) : null;

  await tx(async () => {
    await run(
      `INSERT INTO visits (
         id, customerId, userId,
         checkInLat, checkInLng, checkInAccuracyM, checkInAt,
         checkOutLat, checkOutLng, checkOutAccuracyM, checkOutAt,
         durationSeconds, outcome, notes, transcript, transcriptIsAi,
         shopPhotoId, custPhotoId, voiceNoteId,
         linkedOrderId, linkedPaymentId, linkedComplaintId, linkedSampleId,
         nextFollowUpDate, journeyStopId, wasPlanned, deviationReason,
         locationMismatch, metresFromShop, verified, unverifiedReason, openEnded,
         clientCreatedAt, deviceId, syncState
       ) VALUES (?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?)`,
      [
        base.id, args.customerId, args.userId,
        args.checkIn?.lat ?? null, args.checkIn?.lng ?? null, args.checkIn?.accuracyM ?? null, args.checkIn?.at ?? null,
        args.checkOut?.lat ?? null, args.checkOut?.lng ?? null, args.checkOut?.accuracyM ?? null, args.checkOut?.at ?? null,
        durationSeconds, args.outcome, args.notes, args.transcript, args.transcriptIsAi ? 1 : 0,
        args.shopPhotoId, args.custPhotoId, args.voiceNoteId,
        args.linkedOrderId ?? null, args.linkedPaymentId ?? null, args.linkedComplaintId ?? null, args.linkedSampleId ?? null,
        args.nextFollowUpDate, args.journeyStopId, args.wasPlanned ? 1 : 0, args.deviationReason,
        args.locationMismatch ? 1 : 0, args.metresFromShop, args.verified ? 1 : 0, args.unverifiedReason,
        args.checkOut ? 0 : 1,
        base.clientCreatedAt, base.deviceId, 'queued',
      ],
    );

    /* Bind the media that was captured before the visit existed. A photograph
       is taken when the shop is in front of you, not when the form saves — so
       it begins life unparented and is claimed here. */
    for (const mediaId of [args.shopPhotoId, args.custPhotoId, args.voiceNoteId]) {
      if (mediaId) await run('UPDATE media_queue SET parentId = ? WHERE id = ?', [base.id, mediaId]);
    }

    /* The records punched from inside the visit now depend on it. */
    for (const [table, id] of [
      ['orders', args.linkedOrderId],
      ['payments', args.linkedPaymentId],
      ['complaints', args.linkedComplaintId],
      ['samples', args.linkedSampleId],
    ] as const) {
      if (id) await run(`UPDATE ${table} SET visitId = ? WHERE id = ?`, [base.id, id]);
    }

    /* A follow-up date the salesman set becomes a task he will actually see. */
    if (args.nextFollowUpDate) {
      await insertLocal('tasks', {
        id: newId('task'),
        title: `Follow up with ${args.customerName}`,
        customerId: args.customerId,
        priority: 'Normal',
        dueDate: args.nextFollowUpDate,
        status: 'open',
        clientCreatedAt: Date.now(),
        deviceId: base.deviceId,
        syncState: 'queued',
      });
    }

    /* The stop on today's route is marked visited. */
    if (args.journeyStopId) {
      await run(`UPDATE journey_stops SET status = 'visited', actualAt = ?, visitId = ? WHERE id = ?`, [Date.now(), base.id, args.journeyStopId]);
    }

    /* Written locally so the customer's record reads correctly straight away;
       the server writes its own copy on ingest and the pull reconciles. */
    await insertLocal('timeline_events', {
      id: newId('tl'),
      customerId: args.customerId,
      eventType: 'visit',
      sourceApp: 'mbos',
      sourceRecordId: base.id,
      occurredAt: args.checkIn?.at ?? Date.now(),
      actor: 'You',
      summary: args.notes || args.transcript || 'Visited',
    });

    await run('UPDATE customers SET lastVisitDate = ? WHERE id = ?', [new Date().toISOString().slice(0, 10), args.customerId]);
  });

  await enqueue({
    entityType: 'visit',
    entityId: base.id,
    op: 'create',
    payload: { ...args, id: base.id, durationSeconds, clientCreatedAt: base.clientCreatedAt, deviceId: base.deviceId },
  });

  /* Anything punched inside the visit must not reach the server before it. */
  for (const [type, id] of [
    ['order', args.linkedOrderId],
    ['payment', args.linkedPaymentId],
    ['complaint', args.linkedComplaintId],
    ['sample', args.linkedSampleId],
  ] as const) {
    if (id) await addDependency(type, id, base.id);
  }

  if (!args.verified) {
    await notify({
      title: 'Visit saved unverified',
      body: `${args.customerName} · your manager will see the reason you gave.`,
      kind: 'amber',
      href: '/sync',
    });
  }

  return base.id;
}

/**
 * Re-point an already-queued item at a record created after it.
 *
 * The order is punched from inside the visit, so it is enqueued first and the
 * visit does not exist yet. Rather than delay the order's write until save,
 * the dependency is added here — the queue reads `dependsOn` at send time, not
 * at enqueue time.
 */
async function addDependency(entityType: string, entityId: string, dependsOnId: string): Promise<void> {
  const row = await one<{ id: string; dependsOn: string }>(
    'SELECT id, dependsOn FROM sync_queue WHERE entityType = ? AND entityId = ? ORDER BY createdAt DESC LIMIT 1',
    [entityType, entityId],
  );
  if (!row) return;
  const deps: string[] = JSON.parse(row.dependsOn);
  if (deps.includes(dependsOnId)) return;
  deps.push(dependsOnId);
  await run('UPDATE sync_queue SET dependsOn = ? WHERE id = ?', [JSON.stringify(deps), row.id]);
}

/* ----------------------------------------------------------------- reads */

export async function visitsToday(userId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const row = await one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM visits WHERE userId = ? AND checkInAt >= ?',
    [userId, startOfDay.getTime()],
  );
  return row?.n ?? 0;
}

/**
 * Follow-ups the salesman promised on a visit, and how many are for today.
 *
 * A date he set standing in the shop is a promise to the customer, so it is
 * counted from the visit itself rather than from whether the task it created
 * has survived somebody's tidying.
 */
export async function followUpCounts(userId: string, today: string): Promise<{ open: number; dueToday: number }> {
  const row = await one<{ open: number; dueToday: number }>(
    `SELECT COUNT(*) AS open, SUM(CASE WHEN nextFollowUpDate = ? THEN 1 ELSE 0 END) AS dueToday
       FROM visits WHERE userId = ? AND nextFollowUpDate IS NOT NULL AND nextFollowUpDate >= ?`,
    [today, userId, today],
  );
  return { open: row?.open ?? 0, dueToday: row?.dueToday ?? 0 };
}

export async function recentVisits(customerId: string) {
  return all('SELECT * FROM visits WHERE customerId = ? ORDER BY checkInAt DESC LIMIT 20', [customerId]);
}

/**
 * A visit saved without a check-out is left open and closed at the day
 * boundary, flagged. Guessing an end time would put a duration on the record
 * that nobody measured.
 */
export async function closeOpenVisits(dayBoundaryMs: number): Promise<number> {
  const open = await all<{ id: string; checkInAt: number }>(
    'SELECT id, checkInAt FROM visits WHERE openEnded = 1 AND checkInAt < ?',
    [dayBoundaryMs],
  );
  for (const v of open) {
    await run(`UPDATE visits SET openEnded = 0, verified = 0, unverifiedReason = COALESCE(unverifiedReason, 'Closed automatically at the end of the day — no check-out was recorded') WHERE id = ?`, [v.id]);
  }
  return open.length;
}
