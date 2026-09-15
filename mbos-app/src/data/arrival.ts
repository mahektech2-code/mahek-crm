import { getKv, setKv } from '../db';
import { isoDate } from '../lib/format';
import { arrivalIsCurrent, withCheckIn } from '../lib/visit';

/**
 * ARRIVING AND CHECKING IN ARE TWO ACTS, and this is the gap between them.
 *
 * They were one: pressing "I am here" closed the travel leg, took the closing
 * meter photograph, started the dwell clock and opened the visit form in a
 * single tap. That is one act too many for what it describes — a salesman who
 * has parked outside a shop has arrived, and he is not yet in front of the
 * customer. The dwell figure exists to say how long he spent WITH the
 * customer, and counting the walk from the bike, the wait at the counter and
 * the call he takes on the way in is the same error the ride itself used to
 * make, one step further down.
 *
 * So the arrival ends the journey and this records that he is at the shop but
 * not yet inside it. Checking in is the second tap, and it is what starts the
 * clock.
 *
 * **IT IS A RECORD, NOT A SCREEN STATE, for the reason the leg itself is.**
 * Android reaps this app on the road constantly, and an "arrived" flag held in
 * memory would be gone by the time he walked in — with the leg already closed
 * and the meter already photographed, so there is no way back to the arrival
 * he has just made and nothing on any screen able to say what happened. `kv`
 * rather than a table because there is exactly one of these at a time: a
 * salesman is at one shop.
 *
 * **NOTHING HERE GOES UP THE WIRE, and nothing needs to.** The arrival instant
 * is already on `travel_legs.endedAt`, which the visit is bound to on save, so
 * the office can read "arrived 10:41, checked in 10:58" off two records it
 * already has. A second copy of an instant already stored is a copy that can
 * disagree with it.
 */

const KEY = 'mbos.arrival';

export type Arrival = {
  customerId: string;
  customerName: string;
  /** The journey he got here on. Null only where a visit began without one. */
  legId: string | null;
  /** When he said he was here — the instant written onto the leg. */
  arrivedAt: number;
  /** When he went in. Null is the whole point of this record. */
  checkedInAt: number | null;
  /** The business day it belongs to, so a stale one can be told from today's. */
  day: string;
};

function parse(raw: string | null): Arrival | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Arrival | null;
    return value && value.customerId && value.arrivedAt ? value : null;
  } catch {
    return null;
  }
}

/**
 * The shop he is standing at, if he is standing at one.
 *
 * An arrival from an EARLIER DAY is rubbed out rather than returned. He did
 * not check in and the day has ended; restoring it would greet him on
 * Wednesday morning with a bar offering to check him into Tuesday's last shop,
 * which is the same leak `restoreOffPlanReason` closes one file along. The
 * journey behind it is closed by `closeStaleLegs` at the same boundary.
 */
export async function readArrival(): Promise<Arrival | null> {
  const value = parse(await getKv(KEY));
  if (!value) return null;
  if (!arrivalIsCurrent(value, isoDate(new Date()))) {
    await clearArrival();
    return null;
  }
  return value;
}

/** He is at the shop. Written the moment the leg closes, before anything else. */
export async function recordArrival(args: {
  customerId: string;
  customerName: string;
  legId: string | null;
  arrivedAt: number;
}): Promise<Arrival> {
  const value: Arrival = {
    ...args,
    checkedInAt: null,
    day: isoDate(new Date(args.arrivedAt)),
  };
  await setKv(KEY, JSON.stringify(value));
  return value;
}

/**
 * He has gone in. The dwell clock starts from what this returns.
 *
 * Checking in twice returns the FIRST instant rather than restarting the
 * clock: a second tap is a slip — the screen was slow, or Android redrew it —
 * and reading it as a second arrival would silently shorten every visit it
 * happened on.
 */
export async function checkInAtShop(now: number): Promise<Arrival | null> {
  const value = await readArrival();
  if (!value) return null;
  const next = withCheckIn(value, now);
  /* Unchanged means it was already stamped, so there is nothing to write and
     no reason to touch the disk over a double tap. */
  if (next === value) return value;
  await setKv(KEY, JSON.stringify(next));
  return next;
}

/** Spent — the visit is in the ledger, or the trip was called off. */
export async function clearArrival(): Promise<void> {
  await setKv(KEY, '');
}
