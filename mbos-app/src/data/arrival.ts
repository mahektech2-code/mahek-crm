import { all, getKv, newId, one, setKv } from '../db';
import { getConfig } from './config';
import { IN_FLIGHT_LEG_SHOPS_SQL, IN_FLIGHT_LEG_WINDOW_MS } from './day-shape';
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
  /**
   * The reading the check-in gate accepted. Kept so that checking out never
   * re-measures him against the shop — the gate is at the door, and a fresh
   * fix taken after he has walked away would refuse a check-out for a visit
   * that verified perfectly well. Also what `leftShopVerdict` measures from.
   * Absent on arrivals written before this existed.
   */
  checkInFix?: { lat: number; lng: number; accuracyM: number | null } | null;
  /**
   * When the trail first proved he had walked away without checking out. Set
   * once, and it is what closes the visit — the time he left, not the time he
   * finally remembered to press the button.
   */
  leftShopAt?: number | null;
  /** How far away he was when that was noticed, for the sentence that says so. */
  leftShopMetres?: number | null;
  /**
   * "I DIDN'T LEAVE", and why — the answer to a wrong reading.
   *
   * The trail can be wrong: a fix that jumped across the market from inside a
   * steel-roofed godown, a phone left in the bike's box at the gate. Before
   * this, a wrong "you left" closed the visit at an instant he never left at,
   * cut the dwell figure short and could not be argued with anywhere on the
   * phone. His answer clears the instant, is kept here with the reading it
   * disputes, and rides on the visit to the office so a manager can weigh one
   * against the other. Once given, the same visit is not asked again — a
   * trail that keeps disagreeing with him is already on the record.
   */
  leftShopDispute?: { reason: string; seenAt: number; metres: number | null } | null;
  /**
   * THE VISIT'S ID, MINTED AT THE DOOR rather than at the save.
   *
   * An order, a payment and every photograph are taken from INSIDE a visit
   * that does not exist yet — and the outbox sends them within a second of
   * being written, long before the visit is saved. Minted at the save, the id
   * reached the office on nothing: the order arrived naming no visit, the
   * shop photograph arrived parented to the literal string `pending` and
   * nobody could ever open it. Minted here, everything punched inside the
   * visit can carry the id it will have, from the moment it is created.
   *
   * Absent on arrivals written before this existed; the save mints one then,
   * exactly as it always did.
   */
  visitId?: string;
  /**
   * PAST THE CHECK-IN GATE, and the question asked after it.
   *
   * Both were screen state, so "Not yet" on the Arrived card, a tab tap or
   * Android reaping the app took them with it: the visit then saved with no
   * override reason, the office recorded "no reason was given", and the pin
   * correction he asked for never reached his manager. They are part of the
   * arrival — the refusal, the sentence and the request all happened at the
   * door — so they are written down with it.
   *
   * `pinAsked` is whether the pin question has been answered at all, so a
   * restored visit asks it again only when it never was.
   */
  overrideReason?: string | null;
  pinCorrectionRequested?: boolean;
  pinAsked?: boolean;
  /**
   * EVERYTHING TYPED INSIDE THE VISIT, so a reap does not take it.
   *
   * The store is memory, and Android takes this app apart on the road. The
   * clock already came back from the arrival; the note, the outcome, the
   * photographs, the records raised inside the visit and the cart did not —
   * so a complaint raised in the visit lost its link, a photograph sat in the
   * queue for a visit that would never name it, and the note he had dictated
   * was gone. See `VisitDraft` in `state/store.ts`, which is what writes it.
   */
  draft?: Record<string, unknown> | null;
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
  const today = isoDate(new Date());
  /* The punch-in is read only when the date has moved — the ordinary read,
     every keystroke of the draft, costs no extra query. See
     `arrivalIsCurrent` for why midnight alone no longer erases it. */
  if (value.day !== today && !arrivalIsCurrent(value, today, await punchedInSince())) {
    await clearArrival();
    return null;
  }
  return value;
}

/**
 * When the punch-in he is still on began, or null.
 *
 * Read straight off `attendance_days` rather than through `runningSince`,
 * which needs the user and drags the tracker and the outbox into a module the
 * store imports — the arrival has no user on it, and the handset has one
 * person's attendance on it at a time. Bounded by the same ceiling
 * `currentRow` keeps (`mbos.location.serviceMaxDayHours`) so a session left
 * open on Friday does not keep Friday's arrival alive on Monday.
 */
async function punchedInSince(): Promise<number | null> {
  try {
    const row = await one<{ sessions: string | null }>(
      'SELECT sessions FROM attendance_days ORDER BY day DESC LIMIT 1',
    );
    if (!row?.sessions) return null;
    const sessions = JSON.parse(row.sessions) as { inAt?: number; outAt?: number | null }[];
    const open = sessions.find((s) => typeof s?.inAt === 'number' && s.outAt == null);
    if (!open?.inAt) return null;
    const hours = await getConfig<number>('mbos.location.serviceMaxDayHours', 16);
    return Date.now() - open.inAt < Math.max(1, hours) * 3_600_000 ? open.inAt : null;
  } catch {
    /* A row nobody can read proves no punch-in; the date rule stands. */
    return null;
  }
}

/** He is at the shop. Written the moment the leg closes, before anything else. */
export async function recordArrival(args: {
  customerId: string;
  customerName: string;
  legId: string | null;
  arrivedAt: number;
  checkInFix?: Arrival['checkInFix'];
  /** His sentence, where the gate refused him on distance and he said why. */
  overrideReason?: string | null;
  /** Set where there was no journey: arriving and walking in are one act. */
  checkedInAt?: number | null;
}): Promise<Arrival> {
  const value: Arrival = {
    ...args,
    checkedInAt: args.checkedInAt ?? null,
    leftShopAt: null,
    leftShopMetres: null,
    day: isoDate(new Date(args.arrivedAt)),
    visitId: newId('visit'),
    overrideReason: args.overrideReason ?? null,
    pinCorrectionRequested: false,
    pinAsked: false,
    draft: null,
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

/**
 * He walked away without checking out. Written once — a second call returns
 * what is already there, so the instant he left is the FIRST one noticed.
 * Returns null where there is no checked-in arrival to mark.
 */
export async function markLeftShop(at: number, metres: number): Promise<Arrival | null> {
  const value = await readArrival();
  if (!value || value.checkedInAt == null) return null;
  if (value.leftShopAt != null) return value;
  /* He has said he did not leave. Asked once per visit — see `leftShopDispute`. */
  if (value.leftShopDispute) return null;
  const next: Arrival = { ...value, leftShopAt: at, leftShopMetres: metres };
  await setKv(KEY, JSON.stringify(next));
  return next;
}

/**
 * Amend the arrival in place — the pin answer, the draft.
 *
 * Read and written in one place so the fields the caller did not name survive:
 * the draft is written every few hundred milliseconds while he types, and a
 * writer that rebuilt the record from a stale copy would undo his check-in.
 * Returns null, and writes nothing, where there is no arrival to amend.
 */
export async function patchArrival(patch: Partial<Arrival>): Promise<Arrival | null> {
  const value = await readArrival();
  if (!value) return null;
  const next: Arrival = { ...value, ...patch };
  await setKv(KEY, JSON.stringify(next));
  return next;
}

/**
 * THE SHOPS A SYNC MAY NOT TAKE OFF THIS PHONE, because he is on his way to
 * one or standing in it.
 *
 * A pull drops a shop that has left his book (`reconcileBook`) or that the
 * office tombstones — a reassignment at noon, a territory edit, a stop on an
 * office-made plan for a shop the phone was never sent. Taken from under an
 * open arrival, the visit screen had no customer to save against and Check
 * out did nothing at all; taken from under an open trip, the arrival had no
 * shop to arrive at. Neither is the office's to undo mid-visit: the work he
 * is doing there is his, and the next pull after the visit is saved removes
 * the row as it would have.
 *
 * The arrival is read RAW — not through `readArrival` — because this asks
 * what is on disk, not whether it is still current, and a read here must
 * never be the thing that rubs an arrival out.
 */
export async function shopsInFlight(): Promise<string[]> {
  const ids = new Set<string>();
  const value = parse(await getKv(KEY));
  if (value?.customerId) ids.add(value.customerId);
  try {
    const legs = await all<{ customerId: string }>(
      IN_FLIGHT_LEG_SHOPS_SQL,
      [Date.now() - IN_FLIGHT_LEG_WINDOW_MS],
    );
    for (const l of legs) ids.add(l.customerId);
  } catch {
    /* No legs table on a phone mid-migration: the arrival alone still holds. */
  }
  return [...ids];
}

/** Spent — the visit is in the ledger, or the trip was called off. */
export async function clearArrival(): Promise<void> {
  await setKv(KEY, '');
}
