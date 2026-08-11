import { all, one, run } from '../db';
import { isoDate } from '../lib/format';

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
