import * as Device from 'expo-device';
import * as Location from 'expo-location';

import { all, getKv } from '../db';
import { batteryExemption } from '../native/phone-setup';
import {
  phoneReadiness,
  type BatteryExemption,
  type PermissionState,
  type Readiness,
  type ReadinessInput,
} from '../engines/phone-readiness';
import { isoDate } from '../lib/format';

/**
 * The engine in `engines/phone-readiness.ts`, wired to the phone.
 *
 * Everything that touches a permission API, a native module or the database
 * lives here and nothing else does — the rule itself is pure and next door, so
 * it can be exercised with no device. This file is the reading.
 */

/**
 * Where he last said he had done the steps nobody can verify.
 *
 * READ HERE AND WRITTEN IN `day-gate.ts`, which is the one place the claim is
 * made — the gate is what spends it, so the gate owns it. Two stores for one
 * claim would be the familiar failure: the screen would tick a row the gate
 * had never heard of, and the man would be refused a day he had just been told
 * he could start.
 */
export const ACK_KEY = 'phone-setup.acknowledged';

/**
 * The mark `sync/trail.ts` leaves whenever it KEEPS a fix.
 *
 * Deliberately the same key that file writes rather than a count of rows in
 * `positions`: the queue is emptied as it uploads, so the table answers
 * "nothing recently" the moment a flush succeeds. The mark is the only thing
 * on the handset that survives the upload and says the trail was alive.
 */
const LAST_KEPT_KEY = 'trailLastKeptAt';

function permissionOf(status: string, granted: boolean): PermissionState {
  if (granted || status === 'granted') return 'granted';
  return status === 'undetermined' ? 'undetermined' : 'denied';
}

/**
 * Did the last day he actually worked produce any trail at all?
 *
 * The comparison is the persisted mark against that day's check-in, and it
 * works because the mark only ever moves forward: a mark at or after the
 * check-in means at least one fix was kept on or after that morning, and a
 * mark before it means the whole day was silent. That is the vivo case, and it
 * is the only evidence the handset holds.
 *
 * NO MARK AT ALL reads as silence, which is right for the case this exists to
 * catch — a phone whose background task was killed before it ever kept
 * anything has no mark — and wrong for exactly one other: a reinstall, which
 * loses the mark along with everything else. That costs a salesman one trip to
 * the autostart screen and one tap to say he has been. The other direction
 * costs a day of work nobody can see, so the trade is not close.
 */
async function previousWorkedDay(userId: string): Promise<{ day: string; hadTrail: boolean } | null> {
  const rows = await all<{ day: string; checkInAt: number | null }>(
    `SELECT day, checkInAt FROM attendance_days
      WHERE userId = ? AND checkInAt IS NOT NULL AND day < ?
      ORDER BY day DESC LIMIT 1`,
    [userId, isoDate(new Date())],
  );
  const prev = rows[0];
  if (!prev || prev.checkInAt == null) return null;

  const raw = await getKv(LAST_KEPT_KEY);
  const lastKeptAt = raw ? Number(raw) : 0;
  return {
    day: prev.day,
    hadTrail: Number.isFinite(lastKeptAt) && lastKeptAt >= prev.checkInAt,
  };
}

/**
 * Every fact the gate turns on, read fresh.
 *
 * Read fresh EVERY TIME rather than cached, because the whole screen is built
 * around him walking out to Settings and coming back — a checklist still
 * saying "not granted" after he granted it is the single most damaging thing
 * this feature could do, and one stale read is all it takes.
 *
 * Each reading is guarded on its own. A permissions API that throws is a fact
 * to record, never a reason for the screen to fail to draw: an unreadable
 * answer becomes `undetermined` or `unknown`, which the engine states in words
 * rather than ticking.
 */
export async function readFacts(userId: string | null): Promise<ReadinessInput> {
  const [services, fg, bg, battery, prev, ack] = await Promise.all([
    Location.hasServicesEnabledAsync().catch<null>(() => null),
    Location.getForegroundPermissionsAsync().catch(() => null),
    Location.getBackgroundPermissionsAsync().catch(() => null),
    batteryExemption().catch<BatteryExemption>(() => 'unknown'),
    userId ? previousWorkedDay(userId).catch<null>(() => null) : Promise.resolve(null),
    storedAckAt(),
  ]);

  /*
   * `canAskAgain` is a property of each permission and the rule takes one, so
   * the two are ANDed: if either has run out of asks the app has run out of
   * ways to help, which is what the flag means to the engine. A missing
   * response is read as "the ask is still there", because the alternative is
   * declaring a dead end on the strength of a call that threw.
   */
  const canAskAgain = (fg?.canAskAgain ?? true) && (bg?.canAskAgain ?? true);

  return {
    manufacturer: Device.manufacturer,
    locationServicesEnabled: services,
    foreground: fg ? permissionOf(fg.status, fg.granted) : 'undetermined',
    background: bg ? permissionOf(bg.status, bg.granted) : 'undetermined',
    canAskAgain,
    batteryExemption: battery,
    previousWorkedDay: prev,
    acknowledgedAt: ack,
    nowMs: Date.now(),
  };
}

export async function readReadiness(userId: string | null): Promise<Readiness> {
  return phoneReadiness(await readFacts(userId));
}

/**
 * When he last said he had done the steps nobody can check, or null.
 *
 * The stored shape is `day-gate.ts`'s — `{ at, items }` — and an unreadable one
 * is read as NO claim rather than as an old one. Falling through to "he has not
 * said" costs one more trip through the setup screen; trusting half a parsed
 * object would clear a block on a claim nobody made.
 */
async function storedAckAt(): Promise<number | null> {
  try {
    const raw = await getKv(ACK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: unknown };
    return typeof parsed?.at === 'number' ? parsed.at : null;
  } catch {
    return null;
  }
}
