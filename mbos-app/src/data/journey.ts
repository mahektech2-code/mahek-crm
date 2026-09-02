import { all, one, run } from '../db';
import { isoDate } from '../lib/format';
import { enqueue } from '../sync/queue';

/**
 * The day's route.
 *
 * `journey_stops` is reference data — the plan is made in MahekOne and pulled
 * down — so nothing here enqueues. What the salesman changes on the handset is
 * the ORDER he walks it in, which is his own decision about his own morning and
 * which the next pull is entitled to overwrite. The visit he logs against a
 * stop is the thing that syncs, and `saveVisit` already does that.
 */

export type JourneyStop = {
  id: string;
  planDate: string;
  customerId: string;
  seq: number;
  plannedAt: string | null;
  actualAt: number | null;
  visitId: string | null;
  status: string;
  skipReason: string | null;
  /* Joined from the customer, because a stop with no name is not a stop. */
  customerName: string;
  area: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  outstandingPaise: number;
};

export function today(): string {
  return isoDate(new Date());
}

export async function todayStops(planDate = today()): Promise<JourneyStop[]> {
  return all<JourneyStop>(
    `SELECT j.*, COALESCE(c.name, 'Unknown customer') AS customerName, c.area,
            c.gpsLat, c.gpsLng, COALESCE(c.outstandingPaise, 0) AS outstandingPaise
       FROM journey_stops j LEFT JOIN customers c ON c.id = j.customerId
      WHERE j.planDate = ?
      ORDER BY j.seq`,
    [planDate],
  );
}

/** The stop the salesman is walking to now — the first one not yet visited. */
export async function nextStop(planDate = today()): Promise<JourneyStop | null> {
  const stops = await todayStops(planDate);
  return stops.find((s) => s.status === 'planned') ?? null;
}

/**
 * Write a new walking order.
 *
 * The sequence is rewritten from the array's own order, so a reorder that
 * dropped or duplicated a stop could not silently produce two stop 3s.
 */
export async function saveStopOrder(orderedIds: string[]): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    await run('UPDATE journey_stops SET seq = ? WHERE id = ?', [i + 1, orderedIds[i]]);
  }
}

export async function stopCounts(planDate = today()): Promise<{ total: number; done: number }> {
  const row = await one<{ total: number; done: number }>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'visited' THEN 1 ELSE 0 END) AS done
       FROM journey_stops WHERE planDate = ?`,
    [planDate],
  );
  return { total: row?.total ?? 0, done: row?.done ?? 0 };
}

/**
 * The same rollup as `stopCounts`, for a whole window of past days at once —
 * one query rather than one per row on a screen that lists a fortnight of
 * them.
 */
export async function stopCountsSince(from: string): Promise<Record<string, { total: number; done: number }>> {
  const rows = await all<{ planDate: string; total: number; done: number }>(
    `SELECT planDate, COUNT(*) AS total, SUM(CASE WHEN status = 'visited' THEN 1 ELSE 0 END) AS done
       FROM journey_stops WHERE planDate >= ? AND planDate < ? GROUP BY planDate`,
    [from, today()],
  );
  return Object.fromEntries(rows.map((r) => [r.planDate, { total: r.total, done: r.done }]));
}


/* ══════════════════════════════════════════════════════ the days themselves */

export type PlanDay = {
  id: string;
  planDate: string;
  city: string | null;
  beat: string | null;
  dayState: 'proposed' | 'refused' | 'agreed' | 'planned';
  refusalReason: string | null;
  counterCity: string | null;
  proposedAt: number | null;
  proposedBy: string | null;
  picked: number;
  syncState: string;
};

/**
 * Where the office has asked you to work, and what you have said about it.
 *
 * A plan is AGREED rather than issued. The office proposes a city; you are the
 * one who knows whether that market is open on a Wednesday, so you answer —
 * and once a day is agreed you pick the shops yourself, because you know which
 * of them are worth the walk.
 *
 * Only days from today onwards. A proposal about last Tuesday is not a
 * question anybody can still answer.
 */
export async function planDays(from = today()): Promise<PlanDay[]> {
  return all<PlanDay>(
    `SELECT * FROM journey_days WHERE planDate >= ? ORDER BY planDate ASC`,
    [from],
  );
}

/** How many days are waiting on an answer from this handset. */
export async function daysAwaitingAnswer(from = today()): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM journey_days WHERE planDate >= ? AND dayState = 'proposed'`,
    [from],
  );
  return row?.n ?? 0;
}

/**
 * Yes — you will work that city.
 *
 * The day moves to `agreed` here and to `planned` only when you pick the
 * shops, which is an ordinary stop write. Keeping those two apart is what
 * stops an empty day claiming to be a route.
 */
export async function agreeDay(id: string): Promise<void> {
  await answer(id, { answer: 'agreed' });
}

/**
 * No — and why.
 *
 * The reason is required, and not out of politeness: without one your manager
 * has nothing to act on, and the day sits unplanned while each of you waits
 * for the other. Naming somewhere you would rather go is optional — "not this"
 * is a legitimate answer, and being made to produce an alternative on the spot
 * is how people stop refusing things they should refuse.
 */
export async function refuseDay(
  id: string,
  reason: string,
  counterCity?: string | null,
): Promise<{ ok: boolean; message?: string }> {
  const said = reason.trim();
  if (!said) {
    return {
      ok: false,
      message: 'Say why it will not work — without it your manager has nothing to go on.',
    };
  }
  await answer(id, { answer: 'refused', reason: said, counterCity: counterCity?.trim() || null });
  return { ok: true };
}

/**
 * The write itself.
 *
 * Local first, then queued, like every other write in this app — the screen
 * must not wait on a network that is not there. The row is marked `queued` so
 * the day can say "sent, not yet acknowledged" rather than pretending the
 * office has already heard.
 */
async function answer(
  id: string,
  payload: { answer: 'agreed' | 'refused'; reason?: string; counterCity?: string | null },
): Promise<void> {
  await run(
    `UPDATE journey_days
        SET dayState = ?, refusalReason = ?, counterCity = ?, syncState = 'queued'
      WHERE id = ?`,
    [payload.answer, payload.reason ?? null, payload.counterCity ?? null, id],
  );

  await enqueue({
    entityType: 'plan_day',
    entityId: id,
    op: 'update',
    /* Paperwork, not field work. Answering a proposed day happens on a sofa
       at nine in the evening as often as anywhere, and recording a salesman's
       home coordinates because he replied to his manager is surveillance with
       no business purpose behind it. Where an ORDER was taken answers a real
       question; where a form was filled in answers none. */
    location: false,

    payload: { id, ...payload },
  });
}


/* ══════════════════════════════════════════════════════════ picking the shops */

export type Candidate = {
  id: string;
  name: string;
  area: string | null;
  city: string | null;
  beat: string | null;
  outstandingPaise: number;
  lastVisitDate: string | null;
  lastOrderDate: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
};

/**
 * Who there is to pick from, for a day in a given city.
 *
 * **The city NARROWS rather than filters.** Everything is offered, with the
 * proposed city's shops first — a salesman going to Nagpur often has one call
 * to make on the way, and a list that refused to show it would send him back
 * to the office to ask. The word "elsewhere" on the row is what keeps that
 * honest.
 *
 * Ordered by how long it has been. The question being answered is "who have I
 * not seen", and a customer visited yesterday is the last one to put on
 * tomorrow — a name that has never been visited sorts to the very top, because
 * that is the strongest version of the same answer.
 */
export async function pickCandidates(city: string | null, query = ''): Promise<Candidate[]> {
  const q = query.trim().toLowerCase();
  const like = `%${q}%`;
  const where = q
    ? `WHERE lower(name) LIKE ? OR lower(COALESCE(area,'')) LIKE ? OR lower(COALESCE(city,'')) LIKE ?`
    : '';
  const args: string[] = q ? [like, like, like] : [];

  const rows = await all<Candidate>(
    `SELECT id, name, area, city, beat, outstandingPaise, lastVisitDate, lastOrderDate, gpsLat, gpsLng
       FROM customers ${where}
      ORDER BY lastVisitDate IS NULL DESC, lastVisitDate ASC, name ASC`,
    args,
  );

  if (!city) return rows;
  const here = city.trim().toLowerCase();
  /* Sorted in JavaScript rather than in SQL, so the ordering above is stated
     once and the city only lifts a group of it. */
  return [
    ...rows.filter((r) => (r.city ?? '').trim().toLowerCase() === here),
    ...rows.filter((r) => (r.city ?? '').trim().toLowerCase() !== here),
  ];
}

/** The shops already picked for a day, so reopening the screen shows them. */
export async function pickedFor(planDayId: string): Promise<string[]> {
  /* Stops are keyed by the DATE here rather than by the day's id — the handset
     table came down flat, one row per stop with its `planDate`, and adding a
     plan id to it would be a second way of saying the same thing. */
  const rows = await all<{ customerId: string }>(
    `SELECT s.customerId FROM journey_stops s
       JOIN journey_days d ON d.planDate = s.planDate
      WHERE d.id = ? ORDER BY s.seq`,
    [planDayId],
  );
  return rows.map((r) => r.customerId);
}

export async function planDay(id: string): Promise<PlanDay | null> {
  return (await one<PlanDay>('SELECT * FROM journey_days WHERE id = ?', [id])) ?? null;
}

/**
 * The shops he picked, in the order he means to walk them.
 *
 * **The payload is the WHOLE answer, not a difference.** Sending a shorter
 * list is how a shop is unpicked, and a merge on the server would make that
 * impossible — the same reasoning as the reorder above, one level up.
 *
 * Local first, then queued, like every other write here. The day moves to
 * `planned` immediately so the screen reflects the decision rather than the
 * network; the pull is what confirms it, and it is entitled to disagree.
 */
export async function pickShops(
  planDayId: string,
  customerIds: string[],
): Promise<{ ok: boolean; message?: string }> {
  if (!customerIds.length) {
    return {
      ok: false,
      message: 'Pick at least one shop. A day with nothing on it is not a route.',
    };
  }

  await run(
    `UPDATE journey_days SET dayState = 'planned', picked = ?, syncState = 'queued' WHERE id = ?`,
    [customerIds.length, planDayId],
  );

  await enqueue({
    entityType: 'plan_stops',
    entityId: planDayId,
    op: 'update',
    /* Picking shops for next Tuesday is planning, done wherever he happens to
       be sitting. See `plan_day` above. */
    location: false,
    payload: { id: planDayId, customerIds },
  });

  return { ok: true };
}
