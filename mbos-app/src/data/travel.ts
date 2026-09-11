import { all, one, run } from '../db';
import { insertAndQueue, stamp } from './write';
import {
  computeDay,
  routeDay,
  type DayComputation,
  type DayFacts,
  type ExpenseKind,
  type Policy,
  type PolicySubject,
  type Route,
} from '../engines/generated/expense-policy';

/* The pricing of one claim moved to `engines/claim-preview.ts` — it is pure,
   and this file cannot be loaded by a test runner. Re-exported here so every
   screen that already asks this module for it goes on being answered. */
export {
  previewClaim,
  CLAIM_KINDS,
  type ClaimedLine,
  type ClaimPreview,
} from '../engines/claim-preview';

/**
 * The day, its legs, and what they are worth — worked out HERE, on the phone.
 *
 * The engine in `engines/generated/` is a byte-for-byte copy of the office's,
 * kept in step by `npm run mbos:sync-engines` and a test in both projects that
 * fails when it drifts. That is the whole arrangement: a salesman in a market
 * with no signal is told what his day is worth, and the office pays exactly
 * that. Two hand-written copies of this arithmetic would be the worst drift
 * available in the product, because the half that drifts is the half he read
 * out loud and is now arguing about.
 *
 * The server recomputes on receipt and its answer wins where they differ — but
 * the difference is RECORDED and shown, never silently applied.
 */

export type TravelMode = {
  key: string;
  label: string;
  sortOrder: number;
  reimbursementKind: 'per_km' | 'actuals' | 'zero';
  requiresOdometer: number;
  requiresTicket: number;
};

export type ExpenseDay = {
  id: string;
  userId: string;
  day: string;
  departedAt: number | null;
  returnedAt: number | null;
  departedFromHometown: number;
  destinationCity: string | null;
  arrivedAtDestinationAt: number | null;
  overnight: number;
  stayedInHotel: number;
  openingOdometerKm: number | null;
  closingOdometerKm: number | null;
  odometerPhotoDemanded: number;
  submittedAt: number | null;
  lockedAt: number | null;
  note: string | null;
  syncState: string;
};

export type TravelLeg = {
  id: string;
  expenseDayId: string | null;
  day: string | null;
  modeKey: string;
  fromLabel: string | null;
  toLabel: string | null;
  /* Where he set off from and where he arrived, both written by the app that
     was standing there. The pair is declared because `SELECT *` returns it and
     the journey screen navigates to the leg's own destination rather than to
     whatever stop the plan had queued — reading the plan's coordinates under
     the leg's shop name is how somebody rides to the wrong shop. */
  fromLat: number | null;
  fromLng: number | null;
  toLat: number | null;
  toLng: number | null;
  startedAt: number | null;
  endedAt: number | null;
  purpose: string | null;
  customerId: string | null;
  visitId: string | null;
  manualMetres: number | null;
  odometerStartKm: number | null;
  odometerEndKm: number | null;
  odometerPhotoId: string | null;
  odometerEndPhotoId: string | null;
  origin: string;
  ticketAmountPaise: number | null;
  ticketPhotoId: string | null;
  ticketReference: string | null;
  note: string | null;
  syncState: string;
};

/* ------------------------------------------------------------- the policy */

export type LocalPolicy = {
  policy: Policy;
  subject: PolicySubject;
  versionNo: number;
  effectiveFrom: string;
  sentences: string[];
};

/**
 * The policy this handset holds, or null.
 *
 * **Null is an answer and the screens say it in words.** A phone that has
 * never synced, or a date the office has published nothing for, must not show
 * "₹0 eligible" against a real claim — that reads as "the company allows you
 * nothing", which is a different and much worse sentence than "the office has
 * not published the rules yet".
 */
export async function activePolicy(): Promise<LocalPolicy | null> {
  const row = await one<{
    policyId: string;
    versionNo: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    grade: string | null;
    cityClass: string | null;
    rulesJson: string;
    sentencesJson: string;
  }>('SELECT * FROM expense_policy WHERE id = 1');
  if (!row) return null;

  try {
    return {
      policy: {
        id: row.policyId,
        versionNo: row.versionNo,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        rules: JSON.parse(row.rulesJson),
      },
      subject: { grade: row.grade, cityClass: row.cityClass },
      versionNo: row.versionNo,
      effectiveFrom: row.effectiveFrom,
      sentences: JSON.parse(row.sentencesJson),
    };
  } catch {
    /* A policy that will not parse is a policy this phone cannot price
       against, and saying so is better than pricing against half of one. */
    return null;
  }
}

export async function travelModes(): Promise<TravelMode[]> {
  return all<TravelMode>('SELECT * FROM travel_modes ORDER BY sortOrder ASC');
}

/* ----------------------------------------------------------------- the day */

export async function dayFor(userId: string, day: string): Promise<ExpenseDay | null> {
  return one<ExpenseDay>('SELECT * FROM expense_days WHERE userId = ? AND day = ?', [userId, day]);
}

/**
 * Open the day, or return the one already open.
 *
 * Idempotent on `(userId, day)` because opening it is the first thing every
 * other screen does — adding a leg opens it, claiming an expense opens it —
 * and two rows for one Tuesday would give that Tuesday two sets of meals.
 */
export async function openDay(args: {
  userId: string;
  day: string;
  departedAt?: number | null;
  departedFromHometown?: boolean;
  destinationCity?: string | null;
}): Promise<string> {
  const existing = await dayFor(args.userId, args.day);
  if (existing) return existing.id;

  const base = await stamp('expday');
  return insertAndQueue({
    table: 'expense_days',
    entityType: 'expense_day',
    row: {
      ...base,
      userId: args.userId,
      day: args.day,
      departedAt: args.departedAt ?? null,
      departedFromHometown: args.departedFromHometown === false ? 0 : 1,
      destinationCity: args.destinationCity ?? null,
    },
    payloadExtras: { day: args.day },
  });
}

/** Change something about the day. Refused once the office has locked it. */
export async function updateDay(
  dayId: string,
  patch: Partial<{
    departedAt: number | null;
    returnedAt: number | null;
    departedFromHometown: boolean;
    destinationCity: string | null;
    arrivedAtDestinationAt: number | null;
    overnight: boolean;
    stayedInHotel: boolean;
    openingOdometerKm: number | null;
    closingOdometerKm: number | null;
    note: string | null;
  }>,
): Promise<{ ok: boolean; reason?: string }> {
  const row = await one<ExpenseDay>('SELECT * FROM expense_days WHERE id = ?', [dayId]);
  if (!row) return { ok: false, reason: 'That day is not on this phone.' };
  if (row.lockedAt) {
    return {
      ok: false,
      reason: 'You have already sent this day in. Ask your manager to reopen it — what you sent stays exactly as you sent it.',
    };
  }

  const cols: string[] = [];
  const args: (string | number | null)[] = [];
  const set = (col: string, value: string | number | null | undefined) => {
    cols.push(`${col} = ?`);
    args.push(value ?? null);
  };
  if (patch.departedAt !== undefined) set('departedAt', patch.departedAt);
  if (patch.returnedAt !== undefined) set('returnedAt', patch.returnedAt);
  if (patch.departedFromHometown !== undefined)
    set('departedFromHometown', patch.departedFromHometown ? 1 : 0);
  if (patch.destinationCity !== undefined) set('destinationCity', patch.destinationCity);
  if (patch.arrivedAtDestinationAt !== undefined)
    set('arrivedAtDestinationAt', patch.arrivedAtDestinationAt);
  if (patch.overnight !== undefined) set('overnight', patch.overnight ? 1 : 0);
  if (patch.stayedInHotel !== undefined) set('stayedInHotel', patch.stayedInHotel ? 1 : 0);
  if (patch.openingOdometerKm !== undefined) set('openingOdometerKm', patch.openingOdometerKm);
  if (patch.closingOdometerKm !== undefined) set('closingOdometerKm', patch.closingOdometerKm);
  if (patch.note !== undefined) set('note', patch.note);
  if (!cols.length) return { ok: true };

  args.push(dayId);
  await run(`UPDATE expense_days SET ${cols.join(', ')}, syncState = 'local' WHERE id = ?`, args);
  await queueDayUpdate(dayId);
  return { ok: true };
}

async function queueDayUpdate(dayId: string) {
  const row = await one<ExpenseDay>('SELECT * FROM expense_days WHERE id = ?', [dayId]);
  if (!row) return;
  const { enqueue } = await import('../sync/queue');
  await enqueue({
    entityType: 'expense_day',
    entityId: dayId,
    op: 'update',
    payload: {
      day: row.day,
      departedAt: row.departedAt,
      returnedAt: row.returnedAt,
      departedFromHometown: row.departedFromHometown === 1,
      destinationCity: row.destinationCity,
      arrivedAtDestinationAt: row.arrivedAtDestinationAt,
      overnight: row.overnight === 1,
      stayedInHotel: row.stayedInHotel === 1,
      openingOdometerKm: row.openingOdometerKm,
      closingOdometerKm: row.closingOdometerKm,
      note: row.note,
    },
  });
}

/* ---------------------------------------------------------------- the legs */

export async function legsFor(dayId: string): Promise<TravelLeg[]> {
  return all<TravelLeg>(
    'SELECT * FROM travel_legs WHERE expenseDayId = ? ORDER BY startedAt ASC, clientCreatedAt ASC',
    [dayId],
  );
}

/**
 * The odometer reading the next leg should start from.
 *
 * Prefilled from the previous leg's end so a day is a CHAIN — and so a gap in
 * the chain is visible rather than being something nobody notices until the
 * month is closed.
 */
export async function nextOdometerStart(dayId: string): Promise<number | null> {
  const row = await one<{ odometerEndKm: number | null }>(
    `SELECT odometerEndKm FROM travel_legs
      WHERE expenseDayId = ? AND odometerEndKm IS NOT NULL
      ORDER BY startedAt DESC, clientCreatedAt DESC LIMIT 1`,
    [dayId],
  );
  if (row?.odometerEndKm != null) return row.odometerEndKm;
  const day = await one<{ openingOdometerKm: number | null }>(
    'SELECT openingOdometerKm FROM expense_days WHERE id = ?',
    [dayId],
  );
  return day?.openingOdometerKm ?? null;
}

export async function addLeg(args: {
  userId: string;
  expenseDayId: string;
  day: string;
  modeKey: string;
  fromLabel: string | null;
  toLabel: string | null;
  fromLat?: number | null;
  fromLng?: number | null;
  toLat?: number | null;
  toLng?: number | null;
  startedAt: number | null;
  endedAt: number | null;
  purpose: string | null;
  customerId: string | null;
  visitId?: string | null;
  manualMetres?: number | null;
  manualReason?: string | null;
  odometerStartKm?: number | null;
  odometerEndKm?: number | null;
  odometerPhotoId?: string | null;
  ticketAmountPaise?: number | null;
  ticketPhotoId?: string | null;
  ticketReference?: string | null;
  note?: string | null;
  /** The meter on arrival, where the two readings were taken apart. */
  odometerEndPhotoId?: string | null;
  /** `day_log` | `visit`. See the note above `departForVisit`. */
  origin?: 'day_log' | 'visit';
}): Promise<string> {
  const base = await stamp('leg');
  const id = await insertAndQueue({
    table: 'travel_legs',
    entityType: 'travel_leg',
    row: {
      ...base,
      userId: args.userId,
      expenseDayId: args.expenseDayId,
      day: args.day,
      modeKey: args.modeKey,
      fromLabel: args.fromLabel,
      toLabel: args.toLabel,
      fromLat: args.fromLat ?? null,
      fromLng: args.fromLng ?? null,
      toLat: args.toLat ?? null,
      toLng: args.toLng ?? null,
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      purpose: args.purpose,
      customerId: args.customerId,
      visitId: args.visitId ?? null,
      manualMetres: args.manualMetres ?? null,
      manualReason: args.manualReason ?? null,
      odometerStartKm: args.odometerStartKm ?? null,
      odometerEndKm: args.odometerEndKm ?? null,
      odometerPhotoId: args.odometerPhotoId ?? null,
      odometerEndPhotoId: args.odometerEndPhotoId ?? null,
      ticketAmountPaise: args.ticketAmountPaise ?? null,
      ticketPhotoId: args.ticketPhotoId ?? null,
      ticketReference: args.ticketReference ?? null,
      note: args.note ?? null,
      origin: args.origin ?? 'day_log',
    },
    /* The day is a dependency: a leg that reached the office before the day it
       belongs to would open a second one. PROTOCOL.md §3. */
    dependsOn: [args.expenseDayId],
  });

  for (const mediaId of [args.odometerPhotoId, args.odometerEndPhotoId]) {
    if (mediaId) await run('UPDATE media_queue SET parentId = ? WHERE id = ?', [id, mediaId]);
  }
  if (args.ticketPhotoId) {
    await run('UPDATE media_queue SET parentId = ? WHERE id = ?', [id, args.ticketPhotoId]);
  }
  return id;
}

export async function removeLeg(legId: string): Promise<{ ok: boolean; reason?: string }> {
  const leg = await one<TravelLeg>('SELECT * FROM travel_legs WHERE id = ?', [legId]);
  if (!leg) return { ok: false, reason: 'That leg is not on this phone.' };
  if (leg.syncState === 'synced') {
    return {
      ok: false,
      reason: 'The office already has this leg. Tell your manager rather than deleting it here — a leg that vanishes from one side and not the other is worse than a wrong one.',
    };
  }
  await run('DELETE FROM travel_legs WHERE id = ?', [legId]);
  await run(`DELETE FROM sync_queue WHERE entityId = ?`, [legId]);
  return { ok: true };
}

/* ------------------------------------------------------------ the pricing */

/**
 * The day, priced against the policy this phone holds.
 *
 * `null` where there is no policy: the claims are still recorded and the
 * screen says the office has not published rules covering this date. That is
 * an honest answer; a screen of zeroes is not.
 *
 * **Wall-clock minutes, not instants.** The engine compares meal windows to
 * "minutes since local midnight", and the handset is already in the salesman's
 * own zone — which is the whole reason the conversion happens here rather than
 * inside the engine. The office does the same conversion against
 * `Asia/Kolkata` explicitly, so the two agree wherever the phone is set
 * correctly, and a phone set wrongly produces a difference the office records
 * rather than one it hides.
 */
export async function priceDay(
  userId: string,
  day: string,
): Promise<{
  day: ExpenseDay | null;
  legs: TravelLeg[];
  computation: DayComputation | null;
  route: Route | null;
  policy: LocalPolicy | null;
  reason: string | null;
}> {
  const row = await dayFor(userId, day);
  if (!row) {
    return { day: null, legs: [], computation: null, route: null, policy: null, reason: null };
  }
  const legs = await legsFor(row.id);
  const policy = await activePolicy();
  if (!policy) {
    return {
      day: row,
      legs,
      computation: null,
      route: null,
      policy: null,
      reason: 'This phone has no expense policy yet. Everything you record is kept, and the office will work out what it is worth when it arrives.',
    };
  }

  const lines = await all<{
    id: string;
    kind: string | null;
    category: string;
    amountPaise: number;
    billPhotoId: string | null;
  }>('SELECT id, kind, category, amountPaise, billPhotoId FROM expenses WHERE expenseDayId = ?', [
    row.id,
  ]);

  const facts: DayFacts = {
    day,
    clock: {
      departedMinutes: minutesSinceMidnight(day, row.departedAt),
      returnedMinutes: minutesSinceMidnight(day, row.returnedAt),
      arrivedAtDestinationMinutes: minutesSinceMidnight(day, row.arrivedAtDestinationAt),
    },
    departedFromHometown: row.departedFromHometown === 1,
    stayedInHotel: row.stayedInHotel === 1,
    overnight: row.overnight === 1,
    legs: legs.map((l) => ({
      id: l.id,
      modeKey: l.modeKey,
      /* The handset never measures GPS distance — the trail lives on the
         server and arrives in batches, so a figure worked out here from the
         few fixes this phone happens to hold would be lower than the office's
         and would move between now and syncing. The odometer and anything
         typed are what he sees; the office adds the track when the day lands. */
      gpsMetres: null,
      gpsCoveragePct: null,
      manualMetres: l.manualMetres,
      odometerMetres:
        l.odometerStartKm != null && l.odometerEndKm != null && l.odometerEndKm >= l.odometerStartKm
          ? (l.odometerEndKm - l.odometerStartKm) * 1000
          : null,
      hasOdometerPhoto: l.odometerPhotoId != null,
      ticketAmountPaise: l.ticketAmountPaise,
      hasTicketProof: l.ticketPhotoId != null,
      odometerPhotoDemanded: row.odometerPhotoDemanded === 1,
    })),
    lines: lines.map((l) => ({
      id: l.id,
      kind: ((l.kind ?? l.category) as ExpenseKind) ?? 'other',
      claimedPaise: l.amountPaise,
      hasProof: l.billPhotoId != null,
      nights: (l.kind ?? l.category) === 'lodging' ? 1 : undefined,
    })),
  };

  const computation = computeDay(policy.policy, policy.subject, facts);
  return {
    day: row,
    legs,
    computation,
    route: routeDay(policy.policy, policy.subject, computation),
    policy,
    reason: null,
  };
}

/**
 * Minutes from local midnight on `day` to an instant.
 *
 * May exceed 1440, and that is the point: a salesman who left on Tuesday and
 * got home at half past one on Wednesday morning was away until 25:30 on
 * Tuesday, not until 01:30 on a day he had not reached. The handset is in his
 * own zone already, so `getHours()` is correct HERE in a way it never is on
 * the server — which is exactly why the office does the same sum with the zone
 * named, and why both hand the engine a plain number.
 */
function minutesSinceMidnight(day: string, at: number | null): number | null {
  if (at == null) return null;
  const midnight = new Date(`${day}T00:00:00`).getTime();
  return Math.round((at - midnight) / 60_000);
}

/* -------------------------------------------------------------- sending it */

export async function submitDay(
  userId: string,
  day: string,
  note: string | null,
): Promise<{ ok: boolean; reason?: string; claimedPaise?: number }> {
  const priced = await priceDay(userId, day);
  if (!priced.day) return { ok: false, reason: 'There is nothing recorded for that day.' };
  if (priced.day.lockedAt) return { ok: false, reason: 'You have already sent this day in.' };
  if (priced.day.returnedAt == null) {
    return {
      ok: false,
      reason: 'Say what time you got back first — the meal allowance is worked out from when you left and when you returned.',
    };
  }

  const claimed = priced.computation?.totalClaimedPaise ?? 0;
  const base = await stamp('expsubmit');
  const { enqueue } = await import('../sync/queue');
  await enqueue({
    entityType: 'expense_day_submit',
    entityId: base.id,
    op: 'create',
    payload: { day, clientClaimedPaise: claimed, note },
    dependsOn: [priced.day.id, ...priced.legs.map((l) => l.id)],
  });

  await run(`UPDATE expense_days SET submittedAt = ?, lockedAt = ? WHERE id = ?`, [
    Date.now(),
    Date.now(),
    priced.day.id,
  ]);

  return { ok: true, claimedPaise: claimed };
}



/* ══════════════════════════════════════ a leg walked, rather than logged */

/**
 * The journey opened when he presses Start visit, and closed when he arrives.
 *
 * **THIS IS A SECOND WAY IN, NOT A SECOND MODEL.** Everything below writes the
 * same `travel_legs` rows the `/travel` screen writes, belongs to the same
 * `expense_days`, and is priced by the same policy engine — so a day's
 * reimbursement is one figure however its legs got there. What differs is
 * WHEN: `/travel` is typed up once the journey is over, and this is opened
 * while it is happening. `origin` is the column that says which, and it is the
 * column the server holds a visit leg to a higher standard by.
 *
 * **A LEG IS A RECORD, NOT A SCREEN STATE.** It is written to SQLite the
 * moment he picks the mode, before he has moved. Android reaps this app on the
 * road constantly — a battery manager, a phone call, a map — and a
 * "travelling" flag held in memory would be gone by the time he arrived, with
 * the departure photograph already taken and nothing left to attach it to. He
 * would then be asked to set off again from outside the shop, and the reading
 * he typed would be the arrival reading twice over. So the state is a row with
 * `endedAt IS NULL`, and the app finds out it is mid-journey by asking the
 * store, exactly as it finds out the attendance day is open.
 */

/**
 * The journey he is on, if he is on one. The ONE definition of travelling.
 *
 * `startedSince` is the day boundary, and it is what stops a journey he set off
 * on yesterday and never arrived at from being read as this morning's. A leg
 * has no natural end — nothing closes one but arriving or calling it off — so
 * without the bound the route screen greeted him with "On your way to
 * <yesterday's shop> · 19h 47m" and replaced today's first Start visit with a
 * Continue into the wrong shop.
 *
 * Left off by `departForVisit`, deliberately: the leg it has to close before
 * opening a new one is ANY open leg, whatever day it began. Two open legs is a
 * state nothing in this module can make sense of, and a stale one is exactly
 * the leg that would produce it.
 */
export async function openLegOf(userId: string, startedSince?: number): Promise<TravelLeg | null> {
  return one<TravelLeg>(
    `SELECT * FROM travel_legs
      WHERE userId = ? AND endedAt IS NULL` +
      (startedSince == null ? '' : ' AND startedAt >= ?') +
      ` ORDER BY startedAt DESC, clientCreatedAt DESC LIMIT 1`,
    startedSince == null ? [userId] : [userId, startedSince],
  );
}

/**
 * Journeys still open from a day that has ended, closed at their own reading.
 *
 * The counterpart of the bound above, and the reason it is safe: an open leg is
 * either today's — and drawn — or it is this, and closed. Run from
 * `runDayBoundaryWork` beside `closeOpenVisits`, for the same reason and with
 * the same shape: nothing on a handset runs overnight, so the tidying happens
 * on the next launch, and closing an already-closed leg does nothing.
 *
 * Closed at its start reading so it measures ZERO, and NAMED — a leg worth
 * nothing with no sentence against it is indistinguishable from one somebody
 * forgot to fill in.
 */
export async function closeStaleLegs(userId: string, dayBoundaryMs: number): Promise<number> {
  const open = await all<TravelLeg>(
    `SELECT * FROM travel_legs
      WHERE userId = ? AND endedAt IS NULL AND startedAt IS NOT NULL AND startedAt < ?`,
    [userId, dayBoundaryMs],
  );
  for (const leg of open) {
    await closeAbandoned(leg, 'Closed automatically at the end of the day — no arrival was recorded.');
  }
  return open.length;
}

/** The leg he took to this shop, closed and not yet spent on a visit. */
export async function arrivedLegFor(userId: string, customerId: string): Promise<TravelLeg | null> {
  return one<TravelLeg>(
    `SELECT * FROM travel_legs
      WHERE userId = ? AND customerId = ? AND origin = 'visit'
        AND endedAt IS NOT NULL AND visitId IS NULL
      ORDER BY endedAt DESC LIMIT 1`,
    [userId, customerId],
  );
}

/**
 * Setting off for a shop.
 *
 * `odometer` is both the reading and its photograph or neither — a metered
 * mode brings both, an unmetered one brings neither, and there is no third
 * shape. The caller has already refused a reading it could not check (see
 * `checkOdometer`); this is where it becomes a record.
 */
export async function departForVisit(args: {
  userId: string;
  day: string;
  customerId: string;
  customerName: string;
  modeKey: string;
  purpose: string | null;
  fix: { lat: number; lng: number } | null;
  odometer: { km: number; photoId: string } | null;
}): Promise<{ ok: true; legId: string } | { ok: false; reason: string }> {
  /*
   * A LEG ALREADY OPEN IS CLOSED FIRST, at the reading it started from.
   *
   * The unique index would otherwise refuse the insert, and the refusal would
   * land on somebody standing in the street being told nothing he can act on.
   * It happens for an ordinary reason: he set off for one shop, changed his
   * mind on the road and picked another off the list, which is exactly the
   * flexibility the journey screen is built for.
   *
   * Closed at its own start rather than deleted, so it measures ZERO. The
   * journey did not happen; the meter has not moved for it; and a row that
   * quietly disappeared would leave the next departure's reading following on
   * from nothing, which is the gap an audit stops at.
   */
  const running = await openLegOf(args.userId);
  if (running) {
    if (running.customerId === args.customerId) {
      /* Same shop, still travelling. Pressing it twice is a slip, not a second
         journey — and returning the leg he is already on is what makes the
         arrival photograph close the departure he actually took. */
      return { ok: true, legId: running.id };
    }
    await closeAbandoned(running, `Set off for ${args.customerName} instead.`);
  }

  const dayId = await openDay({ userId: args.userId, day: args.day });

  const legId = await addLeg({
    userId: args.userId,
    expenseDayId: dayId,
    day: args.day,
    modeKey: args.modeKey,
    fromLabel: null,
    toLabel: args.customerName,
    fromLat: args.fix?.lat ?? null,
    fromLng: args.fix?.lng ?? null,
    startedAt: Date.now(),
    /* NULL, and it is the whole point: this is a leg still being travelled,
       which is a state `/travel` has never been able to express. */
    endedAt: null,
    purpose: args.purpose,
    customerId: args.customerId,
    odometerStartKm: args.odometer?.km ?? null,
    odometerPhotoId: args.odometer?.photoId ?? null,
    origin: 'visit',
  });

  return { ok: true, legId };
}

/**
 * Arriving.
 *
 * The distance is NOT computed here and never has been in this module — the
 * policy engine decides what to pay on, from the odometer, the trail or a
 * typed figure, and it does that when the day is priced. All this does is
 * close the leg with what the meter said.
 */
export async function arriveForVisit(args: {
  legId: string;
  fix: { lat: number; lng: number } | null;
  odometer: { km: number; photoId: string } | null;
}): Promise<{ ok: boolean; reason?: string }> {
  const leg = await one<TravelLeg>('SELECT * FROM travel_legs WHERE id = ?', [args.legId]);
  if (!leg) return { ok: false, reason: 'That journey is not on this phone.' };
  if (leg.endedAt != null) return { ok: true };

  await patchLeg(leg, {
    endedAt: Date.now(),
    toLat: args.fix?.lat ?? null,
    toLng: args.fix?.lng ?? null,
    odometerEndKm: args.odometer?.km ?? null,
    odometerEndPhotoId: args.odometer?.photoId ?? null,
  });
  if (args.odometer) {
    await run('UPDATE media_queue SET parentId = ? WHERE id = ?', [leg.id, args.odometer.photoId]);
  }
  return { ok: true };
}

/** He set off and did not get there. The reason is required by the caller. */
export async function abandonLeg(legId: string, reason: string): Promise<{ ok: boolean }> {
  const leg = await one<TravelLeg>('SELECT * FROM travel_legs WHERE id = ?', [legId]);
  if (!leg) return { ok: false };
  await closeAbandoned(leg, reason);
  return { ok: true };
}

/**
 * A journey called off, closed at the reading it started from so it measures
 * nothing — and NAMED, because a leg worth zero with no sentence against it is
 * indistinguishable from one somebody forgot to fill in.
 */
async function closeAbandoned(leg: TravelLeg, reason: string): Promise<void> {
  await patchLeg(leg, {
    endedAt: Date.now(),
    odometerEndKm: leg.odometerStartKm,
    note: leg.note ? `${leg.note} · ${reason}` : reason,
  });
}

/** The visit this journey produced, stamped once the visit exists. */
export async function bindLegToVisit(legId: string, visitId: string): Promise<void> {
  const leg = await one<TravelLeg>('SELECT * FROM travel_legs WHERE id = ?', [legId]);
  if (leg) await patchLeg(leg, { visitId });
}

/** The ticket, on a bus or a train, attached on the way out of the shop. */
export async function attachTicketToLeg(args: {
  legId: string;
  amountPaise: number;
  photoId: string | null;
  reference: string | null;
}): Promise<{ ok: boolean }> {
  const leg = await one<TravelLeg>('SELECT * FROM travel_legs WHERE id = ?', [args.legId]);
  if (!leg) return { ok: false };
  await patchLeg(leg, {
    ticketAmountPaise: args.amountPaise,
    ticketPhotoId: args.photoId,
    ticketReference: args.reference,
  });
  if (args.photoId) {
    await run('UPDATE media_queue SET parentId = ? WHERE id = ?', [leg.id, args.photoId]);
  }
  return { ok: true };
}

/**
 * Change a leg and re-send it WHOLE.
 *
 * `handleTravelLeg` upserts with `onConflictDoUpdate` over its entire value
 * set, so a partial payload would write nulls over every column it did not
 * mention. That is not a bug in the server — a leg is a small record the
 * handset owns outright and re-stating it is the simplest thing that cannot go
 * wrong — but it does mean an update from here has to carry the row as it now
 * stands rather than the fields that changed.
 */
async function patchLeg(leg: TravelLeg, patch: Record<string, string | number | null>): Promise<void> {
  const cols = Object.keys(patch);
  await run(
    `UPDATE travel_legs SET ${cols.map((c) => `${c} = ?`).join(', ')}, syncState = 'queued' WHERE id = ?`,
    [...cols.map((c) => patch[c]), leg.id],
  );

  const row = await one<TravelLeg & { odometerEndPhotoId: string | null; origin: string }>(
    'SELECT * FROM travel_legs WHERE id = ?',
    [leg.id],
  );
  if (!row) return;

  const { enqueue } = await import('../sync/queue');
  await enqueue({
    entityType: 'travel_leg',
    entityId: row.id,
    op: 'update',
    payload: {
      expenseDayId: row.expenseDayId,
      day: row.day,
      modeKey: row.modeKey,
      fromLabel: row.fromLabel,
      toLabel: row.toLabel,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      purpose: row.purpose,
      customerId: row.customerId,
      visitId: row.visitId,
      manualMetres: row.manualMetres,
      odometerStartKm: row.odometerStartKm,
      odometerEndKm: row.odometerEndKm,
      odometerPhotoId: row.odometerPhotoId,
      odometerEndPhotoId: row.odometerEndPhotoId,
      ticketAmountPaise: row.ticketAmountPaise,
      ticketPhotoId: row.ticketPhotoId,
      ticketReference: row.ticketReference,
      note: row.note,
      origin: row.origin,
    },
  });
}
