import { all, newId, one, run, tx } from '../db';
import { enqueue } from '../sync/queue';
import { insertLocal, stamp } from './write';
import { notify } from './notifications';
import type { Fix } from '../native/location';
import { isoDate } from '../lib/format';
import { wireOutcome } from '../lib/wire';

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

/** GPS accuracy comes back fractional; the column it lands in is an integer. */
function round(value: number | null | undefined): number | undefined {
  return value == null ? undefined : Math.round(value);
}

export type SaveVisitArgs = {
  customerId: string;
  customerName: string;
  userId: string;
  /**
   * WHERE he was, and nothing about WHEN.
   *
   * These carry the coordinates and their accuracy. The instants below are what
   * the row is stamped with, because a fix is evidence and the clock is not
   * evidence of anything — reading the times off `Fix.at` meant a visit made in
   * a godown with no signal had a NULL `checkInAt`, a NULL duration and
   * `openEnded = 1`: invisible to `visitsToday`, unreachable by
   * `closeOpenVisits` (a NULL compares false), and enough to make the next
   * visit's "Last time" card print 1 Jan 1970. That is the one case this whole
   * app is built around.
   */
  checkIn: Fix | null;
  checkOut: Fix | null;
  /** The dwell clock's start — the instant he said he had arrived. */
  checkInAt: number;
  /** The instant he saved. Null only where no arrival was ever recorded, which
      leaves the visit open for the day-boundary sweep rather than claiming a
      duration nobody measured. */
  checkOutAt: number | null;
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
  /*
   * PAST THE CHECK-IN GATE, in his own words.
   *
   * Null on every visit that was never refused, which is nearly all of them.
   * It rides on the visit rather than going up as its own record for the same
   * reason the Suspect decision does: the refusal, the sentence and the visit
   * it let through are one act, and sending them apart is how a visit lands
   * with the answer lost to a failed second request.
   */
  checkInOverrideReason?: string | null;
  /** "The shop's pin is wrong — move it here." A request for his manager. */
  pinCorrectionRequested?: boolean;
  /** Records already created from inside this visit, to be linked to it. */
  linkedOrderId?: string | null;
  linkedPaymentId?: string | null;
  linkedComplaintId?: string | null;
  linkedSampleId?: string | null;
  /*
   * §B — the Suspect decision, answered on the visit that demanded it.
   *
   * It rides on the visit rather than on a separate lead update because the
   * answer and the visit that prompted it are one act: sending them apart is
   * how a visit lands with the decision lost to a failed second request. The
   * server writes both in one transaction for the same reason.
   */
  suspectDecision?: string | null;
  suspectReason?: string | null;
  /*
   * §G — the requirement visit's own three answers.
   *
   * They overwrite the lead's columns on the server, unlike the validation
   * call's `confirmed*` answers: this is the same person asking the same
   * question better informed, not a second party's account of it.
   */
  requirement?: string | null;
  monthlyVolumeLitres?: number | null;
  quantityCans?: number | null;
};

export async function saveVisit(args: SaveVisitArgs): Promise<string> {
  const base = await stamp('visit');

  const durationSeconds =
    args.checkOutAt != null ? Math.max(0, Math.round((args.checkOutAt - args.checkInAt) / 1000)) : null;

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
         checkInOverrideReason, pinCorrectionRequested,
         clientCreatedAt, deviceId, syncState
       ) VALUES (?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?, ?,?,?)`,
      [
        base.id, args.customerId, args.userId,
        args.checkIn?.lat ?? null, args.checkIn?.lng ?? null, args.checkIn?.accuracyM ?? null, args.checkInAt,
        args.checkOut?.lat ?? null, args.checkOut?.lng ?? null, args.checkOut?.accuracyM ?? null, args.checkOutAt,
        durationSeconds, args.outcome, args.notes, args.transcript, args.transcriptIsAi ? 1 : 0,
        args.shopPhotoId, args.custPhotoId, args.voiceNoteId,
        args.linkedOrderId ?? null, args.linkedPaymentId ?? null, args.linkedComplaintId ?? null, args.linkedSampleId ?? null,
        args.nextFollowUpDate, args.journeyStopId, args.wasPlanned ? 1 : 0, args.deviationReason,
        args.locationMismatch ? 1 : 0, args.metresFromShop, args.verified ? 1 : 0, args.unverifiedReason,
        args.checkOutAt == null ? 1 : 0,
        args.checkInOverrideReason ?? null, args.pinCorrectionRequested ? 1 : 0,
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

    /* A follow-up date the salesman set becomes a task he will actually see —
       and one the office sees too. It was written locally and never queued,
       so a follow-up promised in a shop existed on one handset only. */
    if (args.nextFollowUpDate) {
      const { createTask } = await import('./tasks');
      await createTask({
        title: `Follow up with ${args.customerName}`,
        customerId: args.customerId,
        priority: 'Normal',
        dueDate: args.nextFollowUpDate,
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
      occurredAt: args.checkInAt,
      actor: 'You',
      summary: args.notes || args.transcript || 'Visited',
    });

    await run('UPDATE customers SET lastVisitDate = ? WHERE id = ?', [isoDate(new Date()), args.customerId]);

    /* The decision, mirrored locally so the lead card is right the moment the
       visit closes rather than after the next pull. `visitsHere` counts the
       unsynced visit itself, so the counter moves on its own. */
    if (args.suspectDecision) {
      const stays = args.suspectDecision === 'still_suspect';
      const { localStage } = await import('../lib/wire');
      if (!stays) {
        await run('UPDATE leads SET stage = ? WHERE id = ?', [
          localStage(args.suspectDecision),
          args.customerId,
        ]);
      }
      if (args.suspectReason?.trim()) {
        const column = args.suspectDecision === 'lost' ? 'lostReason' : 'holdReason';
        await run(`UPDATE leads SET ${column} = ? WHERE id = ?`, [
          args.suspectReason.trim(),
          args.customerId,
        ]);
      }
    }
  });

  await enqueue({
    entityType: 'visit',
    entityId: base.id,
    op: 'create',
    /* Spelled out rather than spread — see PROTOCOL.md §4.1. Spreading `args`
       sent the handset's own shapes, so a `checkIn: { lat, lng, at }` reached
       a server reading `checkInLat`, `checkInLng`, `checkInAt` and every fix,
       photograph and duration was quietly dropped on the way in: the visit
       landed with a customer and nothing else, and nothing on either end
       reported a loss, because an unknown field is not an invalid one. */
    payload: {
      id: base.id,
      customerId: args.customerId,
      customerName: args.customerName,
      checkInAt: args.checkInAt,
      checkInLat: args.checkIn?.lat ?? undefined,
      checkInLng: args.checkIn?.lng ?? undefined,
      checkInAccuracyM: round(args.checkIn?.accuracyM),
      checkOutAt: args.checkOutAt ?? undefined,
      checkOutLat: args.checkOut?.lat ?? undefined,
      checkOutLng: args.checkOut?.lng ?? undefined,
      checkOutAccuracyM: round(args.checkOut?.accuracyM),
      durationSeconds: durationSeconds ?? undefined,
      outcome: wireOutcome(args.outcome),
      notes: args.notes ?? undefined,
      transcript: args.transcript ?? undefined,
      transcriptIsAi: args.transcriptIsAi,
      shopPhotoId: args.shopPhotoId ?? undefined,
      custPhotoId: args.custPhotoId ?? undefined,
      voiceNoteId: args.voiceNoteId ?? undefined,
      journeyPlanStopId: args.journeyStopId ?? undefined,
      wasPlanned: args.wasPlanned,
      deviationReason: args.deviationReason ?? undefined,
      nextFollowUpDate: args.nextFollowUpDate ?? undefined,
      checkInOverrideReason: args.checkInOverrideReason ?? undefined,
      pinCorrectionRequested: args.pinCorrectionRequested ?? undefined,
      suspectDecision: args.suspectDecision ?? undefined,
      suspectReason: args.suspectReason ?? undefined,
      requirement: args.requirement ?? undefined,
      monthlyVolumeLitres: args.monthlyVolumeLitres ?? undefined,
      quantityCans: args.quantityCans ?? undefined,
      clientCreatedAt: base.clientCreatedAt,
      deviceId: base.deviceId,
    },
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

/*
 * `COALESCE(checkInAt, clientCreatedAt)` in the three reads below is for the
 * rows this bug already wrote. Until the save above stamped the dwell clock,
 * every visit made without a GPS fix landed with a NULL `checkInAt` — and an
 * APK cannot be recalled, so those rows are sitting on handsets in the field.
 * A NULL compares false, so they were missing from the day's count, could never
 * be closed, and sorted to the top of "last time" as 1 Jan 1970. The row's own
 * creation instant is the nearest true thing about when the visit happened.
 */

export async function visitsToday(userId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const row = await one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM visits WHERE userId = ? AND COALESCE(checkInAt, clientCreatedAt) >= ?',
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

export type PreviousNote = { checkInAt: number; note: string; outcome: string | null };

/**
 * What was said last time, read back BEFORE the next call rather than found
 * afterwards by scrolling the timeline.
 *
 * "Will pay" typed in a hurry three weeks ago reads exactly like a sentence
 * that never named a date — which is the whole reason the note exists at
 * all. A salesman about to walk into the same shop should not have to
 * remember to go and look for it.
 */
export async function previousVisitNote(customerId: string): Promise<PreviousNote | null> {
  return one<PreviousNote>(
    `SELECT COALESCE(checkInAt, clientCreatedAt) AS checkInAt, notes AS note, outcome FROM visits
      WHERE customerId = ? AND notes IS NOT NULL AND trim(notes) <> ''
      ORDER BY COALESCE(checkInAt, clientCreatedAt) DESC LIMIT 1`,
    [customerId],
  );
}

/**
 * A visit saved without a check-out is left open and closed at the day
 * boundary, flagged. Guessing an end time would put a duration on the record
 * that nobody measured.
 */
export async function closeOpenVisits(dayBoundaryMs: number): Promise<number> {
  const open = await all<{ id: string; checkInAt: number }>(
    'SELECT id, COALESCE(checkInAt, clientCreatedAt) AS checkInAt FROM visits WHERE openEnded = 1 AND COALESCE(checkInAt, clientCreatedAt) < ?',
    [dayBoundaryMs],
  );
  for (const v of open) {
    await run(`UPDATE visits SET openEnded = 0, verified = 0, unverifiedReason = COALESCE(unverifiedReason, 'Closed automatically at the end of the day — no check-out was recorded') WHERE id = ?`, [v.id]);
  }
  return open.length;
}
