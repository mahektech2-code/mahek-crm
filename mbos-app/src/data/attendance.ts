import { all, one, run } from '../db';
import { enqueue } from '../sync/queue';
import { stamp, updateAndQueue } from './write';
import { getConfig } from './config';
import type { DayMayOpen } from './day-gate';
import { withinGeofence } from '../engines/geo';
import { deriveStatus } from '../engines/attendance';
import type { Fix } from '../native/location';
import { isoDate } from '../lib/format';
import * as trail from '../sync/trail';

/* Re-exported so the screens keep one import for the day's figures, while the
   formatting rule itself stays pure and tested in the engine. */
export { workedLabel } from '../engines/attendance';

/**
 * Attendance.
 *
 * **Check-in is never blocked BY A LOCATION.** A salesman outside the
 * permitted radius is offered the field-visit override, which records the
 * override and tells his manager, and the day starts. A missing or poor GPS
 * fix is recorded as missing and the day starts. A salesman who cannot mark
 * attendance cannot work, and an app that stops him is an app the company
 * stops using.
 *
 * **A PHONE THAT CANNOT RECORD THE DAY IS THE OTHER EXCEPTION, and it is not
 * a contradiction of the paragraph above.** A missing fix costs one coordinate
 * on one mark and the day is still a day; a handset whose OEM battery manager
 * kills the tracking service costs the entire record of where a man went, and
 * he finds that out in the evening when nothing can be done about it. So the
 * day does not open until the phone can prove it will record — see
 * `day-gate.ts` for the incident, the reversal and the configuration behind
 * it. Where it genuinely cannot, the answer is a dead end said in words rather
 * than a skip button, exactly as a refused camera is below.
 *
 * **The SELFIE is the exception, and it is deliberate.** Every check-in and
 * every check-out takes one, and there is no path through this module that
 * writes a session end without one. It is the one thing here that is not an
 * attachment to a record — it IS the record, because the mark on its own is
 * only a claim that somebody was somewhere at a time, and the photograph is
 * the only part of it that is evidence. Skippable, the two kinds of day were
 * indistinguishable afterwards: some proved something, some proved nothing,
 * and nothing on the record said which. See `selfie-camera.tsx` for the whole
 * argument and for what the dead end looks like when the camera is refused.
 *
 * **So a selfie is required PER SESSION, at both ends.** A day is
 * `[{ inAt, outAt }]` and a salesman breaks for lunch, so "a selfie at
 * check-in" would mean one photograph covering three separate arrivals. Each
 * session carries `inSelfieId` and `outSelfieId`; the day-level
 * `checkInSelfieId` and `checkOutSelfieId` mirror the FIRST in and the LAST
 * out, exactly as `checkInAt` and `checkOutAt` already do, because that is
 * what the screens read.
 */

export type AttendanceDay = {
  id: string;
  userId: string;
  day: string;
  /** First in and last out of the day. Hours are NOT computed from these. */
  checkInAt: number | null;
  checkOutAt: number | null;
  /** The first in and last out SELFIES, mirroring the two marks above. */
  checkInSelfieId: string | null;
  checkOutSelfieId: string | null;
  checkInLat: number | null;
  checkInLng: number | null;
  withinRadius: number | null;
  fieldVisitOverride: number;
  overrideReason: string | null;
  workedMinutes: number | null;
  status: string | null;
  /** JSON `[{ inAt, outAt, inSelfieId, outSelfieId }]`, oldest first, at most one open. */
  sessions: string | null;
  /**
   * The approval raised against this day by `requestRegularisation`, or null.
   *
   * The column has been written since that function was built and named on no
   * type, so no screen could read it — which is why the correction button
   * could be pressed five times for one day with nothing anywhere saying a
   * request was already with the manager.
   */
  regularizationId: string | null;
  syncState: string;
};

/**
 * One stretch of work. `outAt` null means it is still running.
 *
 * The two selfie ids are `media_queue` ids at first and `attachments` ids on
 * the server — the same id either side, because the handset mints it. They are
 * OPTIONAL on the type and required by every path that writes one: sessions
 * recorded before the photograph was mandatory have none, and a type that
 * refused to describe them would make the history unreadable rather than
 * making the old days compliant.
 */
export type Session = {
  inAt: number;
  outAt: number | null;
  inSelfieId?: string | null;
  outSelfieId?: string | null;
};

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

/**
 * The same sum, to the MILLISECOND, for a counter that has to move.
 *
 * `workedMinutes` rounds, which is right for everything that is filed,
 * compared or paid on — and useless for a clock, because a rounded minute
 * changes once every sixty seconds and a salesman watching it cannot tell a
 * running day from a frozen screen. This is the display's answer; that one
 * remains the record's.
 */
export function workedMs(sessions: Session[], now = Date.now()): number {
  return Math.max(
    0,
    sessions.reduce((total, x) => total + Math.max(0, (x.outAt ?? now) - x.inAt), 0),
  );
}


/**
 * Was this calendar day a holiday — the input `deriveStatus` has always
 * wanted and never had.
 *
 * Only a `universal` row answers yes. A regionally-scoped one is real data
 * (see `holidays.scope`) but the phone has no reliable way to match its
 * free-text scope against this salesman's own beat, so it is left for a
 * future screen to LIST rather than trusted to silently flip a working day
 * to Weekly Off on a guess.
 */
export async function isHoliday(day: string): Promise<boolean> {
  const row = await one<{ n: number }>(
    `SELECT count(*) as n FROM holidays WHERE onDate = ? AND universal = 1`,
    [day],
  );
  return (row?.n ?? 0) > 0;
}

/** Everything on the calendar for one day, universal or not — for display. */
export async function holidaysOn(day: string): Promise<{ id: string; name: string; scope: string | null; universal: number }[]> {
  return all(`SELECT id, name, scope, universal FROM holidays WHERE onDate = ? ORDER BY universal DESC`, [day]);
}

/** `7h 42m`, the way the design writes a duration. */
export function durationLabel(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function today(): string {
  return isoDate(new Date());
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
  /**
   * REQUIRED, and required by the type rather than by the screen.
   *
   * `resumeDay` used to pass null here and the second check-in of a day went
   * unphotographed — a hole exactly where the record is least verifiable,
   * since the afternoon session is the one nobody watched begin. A screen that
   * forgets to ask is a screen; a parameter that cannot be omitted is the
   * rule.
   */
  selfieMediaId: string;
  /**
   * REQUIRED, and unforgeable — which is one step past the selfie beside it.
   *
   * A phone that will not run the tracking service loses the whole record of
   * where a man spent a working day, and he finds out at six in the evening
   * when there is nothing left to do about it. So the question has to be asked
   * before a day opens, and the one way to be sure it was asked is to make it
   * impossible to open one without the answer: `DayMayOpen` carries a property
   * keyed on a `unique symbol` that only `day-gate.ts` can write, so
   * `mayOpenDay()` is the only thing in the app that can produce one. A
   * `readiness: boolean` would have been just as unomittable and just as
   * easily answered `true` by a screen in a hurry.
   *
   * It is not re-checked here. The token IS the check, and asking the native
   * layer a second time inside the write would be a second reading that can
   * disagree with the one the salesman was actually shown.
   *
   * BOTH DOORS GO THROUGH IT. The afternoon's check-in is this same function
   * — resuming appends a session rather than opening a second day — so the
   * type gates the lunch break as well as the morning, which is the only way a
   * gate survives: one of two doors is a door people learn to use.
   */
  mayOpen: DayMayOpen;
  homeLocation?: { lat: number; lng: number } | null;
  overrideReason?: string | null;
}): Promise<{ id: string; withinRadius: boolean | null; needsOverride: boolean }> {
  const radius = await getConfig<number>('mbos.attendance.geofenceRadiusM', 200);
  const day = today();

  let withinRadius: boolean | null = null;
  if (args.fix && args.homeLocation) {
    withinRadius = withinGeofence(args.fix, args.homeLocation, radius).inside;
  }

  /*
   * WHAT THE PHONE SAID ABOUT ITSELF AS THE DAY OPENED, sent with the mark.
   *
   * A gate that blocks a man's day is a support call, and a support call
   * nobody in the office can answer is worse than the fault it came from. So
   * the reading travels: whether everything checkable was in order, whether he
   * claimed to have done the steps nothing can check, and what was still
   * outstanding when he claimed it. The claim is a CLAIM — no Android API
   * reports whether an OEM battery manager will kill a foreground service —
   * and the office pairs it with the only evidence there is, which is whether
   * a trail then appeared.
   *
   * It is NOT kept in a column on this handset. Nothing here reads it back,
   * and a local copy would be a second answer to a question the office asks
   * once; the payload carries it, and the outbox is what makes that reliable.
   * `undefined` rather than null where there is nothing to say, so a re-sent
   * payload never writes an absent claim over a real one.
   */
  const setup = {
    setupReady: args.mayOpen.ready,
    setupAcknowledgedAt: args.mayOpen.acknowledgedAt ?? undefined,
    setupUnverified: args.mayOpen.unverified.length ? [...args.mayOpen.unverified] : undefined,
  };

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
    sessions.push({ inAt: Date.now(), outAt: null, inSelfieId: args.selfieMediaId });
    await run('UPDATE attendance_days SET sessions = ?, checkOutAt = NULL WHERE id = ?', [
      JSON.stringify(sessions),
      existing.id,
    ]);
    /* The photograph belongs to this day's row. It was queued against
       `'pending'` before the row was known — the ordinary
       attachment-before-its-parent pattern — and only the FIRST check-in ever
       bound it, so every afternoon selfie stayed parented to a string, which
       is what the nightly orphan sweep deletes. */
    await bindSelfie(args.selfieMediaId, existing.id);
    await enqueue({
      entityType: 'attendance',
      entityId: existing.id,
      op: 'update',
      /* `day` is on every attendance payload, update as well as create: the
         server keys one row per person per day off it, so an update without
         it names nothing. PROTOCOL.md §4.1. */
      payload: {
        id: existing.id,
        day,
        sessions,
        resumedAt: Date.now(),
        /* The afternoon's check-in is its own reading. A phone whose battery
           manager has since been turned back on is a phone that stopped being
           able to record at lunchtime, and the day should say so. */
        ...setup,
        /* Every session and both of its photographs, so the office holds the
           same list this handset does rather than a first-and-last summary of
           it. */
        selfieId: sessions[0]?.inSelfieId ?? undefined,
      },
    });
    /* Back from lunch: the trail starts again with the session it belongs to.
       It was stopped at the check-out, and an afternoon with no line on the map
       reads as an afternoon nobody worked. */
    void trail.start();
    return { id: existing.id, withinRadius, needsOverride: false };
  }

  const base = await stamp('att');
  const needsOverride = withinRadius === false && !args.overrideReason;

  const opened: Session[] = [{ inAt: Date.now(), outAt: null, inSelfieId: args.selfieMediaId }];

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

  await bindSelfie(args.selfieMediaId, base.id);

  await enqueue({
    entityType: 'attendance',
    entityId: base.id,
    op: 'create',
    payload: {
      id: base.id,
      day,
      checkInAt: base.clientCreatedAt,
      checkInLat: args.fix?.lat ?? undefined,
      checkInLng: args.fix?.lng ?? undefined,
      checkInAccuracyM: args.fix?.accuracyM ?? undefined,
      selfieId: args.selfieMediaId,
      sessions: opened,
      /* `withinRadius` here, `withinGeofence` there — the same question about
         the same fix, asked in two vocabularies, and the answer was landing
         nowhere. A check-in outside the radius is never blocked; it is marked,
         and the mark is the whole point of having asked. */
      withinGeofence: withinRadius ?? undefined,
      ...setup,
      regularisationRequested: withinRadius === false,
      regularisationReason: args.overrideReason ?? undefined,
      deviceId: base.deviceId,
    },
  });

  /* The day is open, so the trail runs. Between here and the check-out and not
     one second either side — a track that carried on afterwards would be
     following somebody home. */
  void trail.start();

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
  const row = await one<{ day: string }>('SELECT day FROM attendance_days WHERE id = ?', [id]);
  await updateAndQueue({
    table: 'attendance_days',
    entityType: 'attendance',
    id,
    patch: { fieldVisitOverride: true, overrideReason: reason },
    payloadExtras: {
      day: row?.day,
      regularisationRequested: true,
      regularisationReason: reason,
    },
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
  /**
   * REQUIRED, like the one on `checkIn` and for the same reason.
   *
   * Check-out took no photograph at all before this — so a day proved that
   * somebody arrived and proved nothing whatever about when they stopped,
   * which is the half that decides the hours. The type is what enforces it:
   * this function has two callers and one of them is a screen.
   */
  selfieMediaId: string,
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
  open.outSelfieId = selfieMediaId;
  await bindSelfie(selfieMediaId, row.id);

  const halfDay = await getConfig<number>('mbos.attendance.halfDayHours', 4);
  const fullDay = await getConfig<number>('mbos.attendance.fullDayHours', 8);

  /* The engine sums the sessions itself, which is why it takes the list rather
     than a pair — and why a half day is decided on the total, not the last
     stretch. */
  const verdict = deriveStatus({
    sessions: sessions.map((x, i) => ({ id: `${row.id}:${i}`, checkInAt: x.inAt, checkOutAt: x.outAt })),
    halfDayThresholdHours: halfDay,
    fullDayThresholdHours: fullDay,
    isWorkingDay: !(await isHoliday(row.day)),
    approvedLeave: null,
  });

  const worked = workedMinutes(sessions, at);

  await run(
    `UPDATE attendance_days
        SET sessions = ?, checkOutAt = ?, checkOutLat = ?, checkOutLng = ?,
            checkOutSelfieId = ?, workedMinutes = ?, status = ?
      WHERE id = ?`,
    [
      JSON.stringify(sessions), at, fix?.lat ?? null, fix?.lng ?? null,
      /* The LAST out's photograph, mirroring `checkOutAt` beside it. The
         per-session ids are the record; this is what a screen reads. */
      selfieMediaId, worked, verdict.status, row.id,
    ],
  );

  await enqueue({
    entityType: 'attendance',
    entityId: row.id,
    op: 'update',
    payload: {
      id: row.id,
      day: row.day,
      checkOutLat: fix?.lat ?? undefined,
      checkOutLng: fix?.lng ?? undefined,
      checkOutAccuracyM: fix?.accuracyM ?? undefined,
      sessions,
      checkOutAt: at,
      checkOutSelfieId: selfieMediaId,
      /* `workedMinutes` and `status` go for the record's own sake and the
         server ignores both: they are DERIVED there, rebuilt from the two
         marks, and a handset that could type them could type a full day onto
         an hour's work. */
      workedMinutes: worked,
      status: verdict.status,
    },
  });

  /* The day is closed. Stop, and send what is held — the last stretch of the
     afternoon is the part most likely still to be on the phone. */
  void trail.stop();

  return { ok: true, workedMinutes: worked };
}

/**
 * Point a queued selfie at the attendance row it belongs to.
 *
 * Every selfie is queued against the literal `'pending'` before the row it
 * belongs to is known — a photograph is taken, compressed and written to the
 * media queue while the person is still looking at the preview, and the row id
 * does not exist until they accept it. That is the ordinary
 * attachment-before-its-parent pattern in this app, and the price of it is
 * that something has to bind the parent afterwards. Only the first check-in
 * of a day ever did, so an afternoon selfie stayed parented to a string
 * literal — which is precisely what `sweepOrphans` deletes after the
 * configured window. One function, called by all three writers.
 */
async function bindSelfie(mediaId: string, attendanceId: string): Promise<void> {
  await run('UPDATE media_queue SET parentId = ? WHERE id = ?', [attendanceId, mediaId]);
}

/** Is the day running right now? Drives which button Home shows. */
export async function dayState(userId: string): Promise<{
  started: boolean;
  running: boolean;
  workedMinutes: number;
  firstInAt: number | null;
  sessionCount: number;
  /**
   * The stretches themselves, so a screen can keep counting without asking
   * the database again.
   *
   * `workedMinutes` above is a figure taken at the moment this ran, and Home
   * rendered it for as long as the screen stayed open — a duration that was
   * correct once and then silently stopped, which reads exactly like a day
   * that is not being recorded. A caller that holds the sessions can tick
   * against its own clock instead.
   */
  sessions: Session[];
}> {
  const row = await todayRow(userId);
  const sessions = sessionsOf(row);
  return {
    started: sessions.length > 0,
    running: !!openSession(sessions),
    workedMinutes: workedMinutes(sessions),
    firstInAt: sessions[0]?.inAt ?? null,
    sessionCount: sessions.length,
    sessions,
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
    payload: {
      id: dayId,
      day: (await one<{ day: string }>('SELECT day FROM attendance_days WHERE id = ?', [dayId]))?.day,
      regularisationRequested: true,
      regularisationReason: reason,
      approvalId,
    },
  });

  return approvalId;
}
