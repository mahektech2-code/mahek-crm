import { all, one, run } from '../db';
import { enqueue } from '../sync/queue';
import { stamp, updateAndQueue } from './write';
import { getConfig } from './config';
import { withinGeofence } from '../engines/geo';
import { deriveStatus } from '../engines/attendance';
import type { Fix } from '../native/location';

/**
 * Attendance.
 *
 * The rule that governs the whole module: **check-in is never blocked**. A
 * salesman outside the permitted radius is offered the field-visit override,
 * which records the override and tells his manager, and the day starts. A
 * salesman who cannot mark attendance cannot work, and an app that stops him
 * is an app the company stops using.
 */

export type AttendanceDay = {
  id: string;
  userId: string;
  day: string;
  /** First in and last out of the day. Hours are NOT computed from these. */
  checkInAt: number | null;
  checkOutAt: number | null;
  checkInLat: number | null;
  checkInLng: number | null;
  withinRadius: number | null;
  fieldVisitOverride: number;
  overrideReason: string | null;
  workedMinutes: number | null;
  status: string | null;
  /** JSON `[{ inAt, outAt }]`, oldest first, at most one open. */
  sessions: string | null;
  syncState: string;
};

/** One stretch of work. `outAt` null means it is still running. */
export type Session = { inAt: number; outAt: number | null };

export function sessionsOf(row: Pick<AttendanceDay, 'sessions'> | null): Session[] {
  if (!row?.sessions) return [];
  try {
    return (JSON.parse(row.sessions) as Session[]).filter((x) => typeof x?.inAt === 'number');
  } catch {
    return [];
  }
}

/** The one still running, if any. */
export function openSession(sessions: Session[]): Session | null {
  return sessions.find((x) => x.outAt == null) ?? null;
}

/**
 * Minutes actually worked, summed across every closed session.
 *
 * The open one counts up to `now`, so the figure on screen keeps moving while
 * the day is running rather than jumping when it ends.
 */
export function workedMinutes(sessions: Session[], now = Date.now()): number {
  return Math.max(
    0,
    Math.round(
      sessions.reduce((total, x) => total + Math.max(0, (x.outAt ?? now) - x.inAt), 0) / 60_000,
    ),
  );
}

/** `7h 42m`, the way the design writes a duration. */
export function durationLabel(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function todayRow(userId: string): Promise<AttendanceDay | null> {
  return one<AttendanceDay>('SELECT * FROM attendance_days WHERE userId = ? AND day = ?', [userId, today()]);
}

/**
 * Start the day: three effects in order, each confirming separately so a
 * failure in one is visible rather than swallowed by the other two.
 */
export async function checkIn(args: {
  userId: string;
  fix: Fix | null;
  selfieMediaId: string | null;
  homeLocation?: { lat: number; lng: number } | null;
  overrideReason?: string | null;
}): Promise<{ id: string; withinRadius: boolean | null; needsOverride: boolean }> {
  const radius = await getConfig<number>('mbos.attendance.geofenceRadiusM', 200);
  const day = today();

  let withinRadius: boolean | null = null;
  if (args.fix && args.homeLocation) {
    withinRadius = withinGeofence(args.fix, args.homeLocation, radius).inside;
  }

  const existing = await todayRow(args.userId);
  if (existing) {
    /* Back out after lunch. This APPENDS a session rather than clearing the
       previous check-out — clearing it is what lost the morning's hours and
       turned 9-to-1 plus 2-to-6 into nine hours instead of eight. */
    const sessions = sessionsOf(existing);
    if (openSession(sessions)) {
      /* Already running. Checking in twice is a slip, not a second day. */
      return { id: existing.id, withinRadius, needsOverride: false };
    }
    sessions.push({ inAt: Date.now(), outAt: null });
    await run('UPDATE attendance_days SET sessions = ?, checkOutAt = NULL WHERE id = ?', [
      JSON.stringify(sessions),
      existing.id,
    ]);
    await enqueue({
      entityType: 'attendance',
      entityId: existing.id,
      op: 'update',
      payload: { id: existing.id, sessions, resumedAt: Date.now() },
    });
    return { id: existing.id, withinRadius, needsOverride: false };
  }

  const base = await stamp('att');
  const needsOverride = withinRadius === false && !args.overrideReason;

  const opened: Session[] = [{ inAt: Date.now(), outAt: null }];

  await run(
    `INSERT INTO attendance_days (id, userId, day, checkInAt, checkInLat, checkInLng, checkInAccuracyM,
                                  checkInSelfieId, withinRadius, fieldVisitOverride, overrideReason,
                                  status, sessions, clientCreatedAt, deviceId, syncState)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued')`,
    [
      base.id, args.userId, day, Date.now(),
      args.fix?.lat ?? null, args.fix?.lng ?? null, args.fix?.accuracyM ?? null,
      args.selfieMediaId, withinRadius === null ? null : withinRadius ? 1 : 0,
      withinRadius === false ? 1 : 0, args.overrideReason ?? null,
      'Present', JSON.stringify(opened), base.clientCreatedAt, base.deviceId,
    ],
  );

  if (args.selfieMediaId) {
    await run('UPDATE media_queue SET parentId = ? WHERE id = ?', [base.id, args.selfieMediaId]);
  }

  await enqueue({
    entityType: 'attendance',
    entityId: base.id,
    op: 'create',
    payload: {
      id: base.id, userId: args.userId, day,
      checkInAt: base.clientCreatedAt,
      lat: args.fix?.lat ?? null, lng: args.fix?.lng ?? null, accuracyM: args.fix?.accuracyM ?? null,
      withinRadius, fieldVisitOverride: withinRadius === false, overrideReason: args.overrideReason ?? null,
      deviceId: base.deviceId,
    },
  });

  return { id: base.id, withinRadius, needsOverride };
}

/**
 * The reason for a check-in outside the permitted radius, recorded after the
 * fact.
 *
 * It is a second write on purpose. The day starts the moment the salesman
 * presses the button — asking him why first, and losing the check-in if he
 * dismisses the question, is precisely the block this module exists to avoid.
 */
export async function setOverrideReason(id: string, reason: string): Promise<void> {
  await updateAndQueue({
    table: 'attendance_days',
    entityType: 'attendance',
    id,
    patch: { fieldVisitOverride: true, overrideReason: reason },
  });
}

/**
 * Ending the day, or breaking off for now.
 *
 * Closes the running session and re-adds the hours from ALL of them. A day
 * with three sessions is three stretches of work, and the total is what goes
 * on the record — the last check-out on its own says nothing about the day.
 */
export async function checkOut(
  userId: string,
  fix: Fix | null,
): Promise<{ ok: boolean; workedMinutes: number; reason?: string }> {
  const row = await todayRow(userId);
  if (!row) return { ok: false, workedMinutes: 0, reason: 'The day has not been started yet.' };

  const sessions = sessionsOf(row);
  const open = openSession(sessions);
  if (!open) {
    return { ok: false, workedMinutes: workedMinutes(sessions), reason: 'The day is already closed.' };
  }

  const at = Date.now();
  open.outAt = at;

  const halfDay = await getConfig<number>('mbos.attendance.halfDayHours', 4);
  const fullDay = await getConfig<number>('mbos.attendance.fullDayHours', 8);

  /* The engine sums the sessions itself, which is why it takes the list rather
     than a pair — and why a half day is decided on the total, not the last
     stretch. */
  const verdict = deriveStatus({
    sessions: sessions.map((x, i) => ({ id: `${row.id}:${i}`, checkInAt: x.inAt, checkOutAt: x.outAt })),
    halfDayThresholdHours: halfDay,
    fullDayThresholdHours: fullDay,
    isWorkingDay: true,
    approvedLeave: null,
  });

  const worked = workedMinutes(sessions, at);

  await run(
    `UPDATE attendance_days
        SET sessions = ?, checkOutAt = ?, checkOutLat = ?, checkOutLng = ?, workedMinutes = ?, status = ?
      WHERE id = ?`,
    [JSON.stringify(sessions), at, fix?.lat ?? null, fix?.lng ?? null, worked, verdict.status, row.id],
  );

  await enqueue({
    entityType: 'attendance',
    entityId: row.id,
    op: 'update',
    payload: {
      id: row.id,
      sessions,
      checkOutAt: at,
      lat: fix?.lat ?? null,
      lng: fix?.lng ?? null,
      workedMinutes: worked,
      status: verdict.status,
    },
  });

  return { ok: true, workedMinutes: worked };
}

/** Is the day running right now? Drives which button Home shows. */
export async function dayState(userId: string): Promise<{
  started: boolean;
  running: boolean;
  workedMinutes: number;
  firstInAt: number | null;
  sessionCount: number;
}> {
  const row = await todayRow(userId);
  const sessions = sessionsOf(row);
  return {
    started: sessions.length > 0,
    running: !!openSession(sessions),
    workedMinutes: workedMinutes(sessions),
    firstInAt: sessions[0]?.inAt ?? null,
    sessionCount: sessions.length,
  };
}

export async function recentDays(userId: string, limit = 30): Promise<AttendanceDay[]> {
  return all<AttendanceDay>('SELECT * FROM attendance_days WHERE userId = ? ORDER BY day DESC LIMIT ?', [userId, limit]);
}

/**
 * A missed check-out is auto-marked and flagged for regularization, never
 * guessed at. Inventing an end time would put hours on a record nobody
 * measured, and those hours end up on a payslip.
 */
export async function autoCloseMissedCheckouts(userId: string): Promise<number> {
  const rows = await all<AttendanceDay>(
    'SELECT * FROM attendance_days WHERE userId = ? AND checkInAt IS NOT NULL AND checkOutAt IS NULL AND day < ?',
    [userId, today()],
  );
  for (const r of rows) {
    await run('UPDATE attendance_days SET autoMarked = 1 WHERE id = ?', [r.id]);
  }
  return rows.length;
}

/**
 * Asking for a day to be corrected.
 *
 * The record is never edited here — that is the whole point of it. What this
 * does is raise an approval against the day, so a manager sees what the app
 * recorded, what the salesman says happened, and decides. The day changes only
 * if they approve.
 *
 * Before this, the dialog collected a reason and then did nothing but toast:
 * the salesman believed he had asked, and nobody had been asked.
 */
export async function requestRegularisation(dayId: string, reason: string): Promise<string> {
  const { raiseApproval } = await import('./requests');
  const deviceId = (await import('../sync/api')).deviceId;

  const approvalId = await raiseApproval({
    type: 'attendance_regularisation',
    subjectType: 'attendance',
    subjectId: dayId,
    reason,
    deviceId: await deviceId(),
  });

  await run('UPDATE attendance_days SET regularizationId = ? WHERE id = ?', [approvalId, dayId]);

  await enqueue({
    entityType: 'attendance',
    entityId: dayId,
    op: 'update',
    payload: { id: dayId, regularisationRequested: true, regularisationReason: reason, approvalId },
  });

  return approvalId;
}
