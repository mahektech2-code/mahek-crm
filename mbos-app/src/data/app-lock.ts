import { getKv, setKv } from '../db';
import { getConfig } from './config';
import { capability } from '../native/biometrics';

/**
 * The app lock — whether to ask for a fingerprint before showing the book.
 *
 * WHAT IT PROTECTS, and why it is not the sign-in screen. MBOS does not sign
 * anybody out: `app/index.tsx` goes straight to `/home` whenever a session
 * exists, so the login form is seen on the first morning and then essentially
 * never again. A fingerprint bolted to that screen would fire perhaps twice a
 * year. Meanwhile the handset spends every day on shop counters carrying the
 * whole book — every customer, what each of them owes, and a form that places
 * an order in Mahek's name. The thing worth locking is the app in somebody's
 * hand, not a form nobody opens.
 *
 * IT IS PER HANDSET, not per person, and stored in the local kv rather than on
 * the server. A lock is a property of the phone in a pocket: two salesmen who
 * share a spare handset between shifts each want it on, and neither is
 * expressing a company policy by saying so. It also has to be answerable with
 * no signal, standing in a shop.
 *
 * IT NEVER STOPS THE WORK BEHIND IT. The lock is a screen over the app; the
 * sync engine, the media queue and the route trail all keep running. A locked
 * phone in a pocket goes on sending the morning's orders and goes on drawing
 * the line the office watches — which is the whole reason it is safe to make
 * the lock strict.
 */

const ON_KEY = 'mbos.lock.on';

/**
 * When the person last proved who they are, and when the app last left their
 * hands. Both DELIBERATELY IN MEMORY.
 *
 * A cold start therefore has no unlock to measure from and always asks, which
 * is what somebody expects of a locked app — and what a persisted timestamp
 * would have quietly skipped for the first three minutes after a force-quit.
 * The behaviour falls out of not writing it down rather than out of a second
 * rule that could drift from the first.
 */
let unlockedAt: number | null = null;

/**
 * The grace is measured from HERE, not from the unlock.
 *
 * Measured from the unlock, every hand-off after the first few minutes of the
 * morning would lock the app: three minutes into a session, stepping out to
 * the system camera for a shop photo and stepping straight back would find the
 * grace already spent. The question the lock is actually asking is how long the
 * phone was out of the person's hands, and that is this.
 */
let leftAt: number | null = null;

export async function isOn(): Promise<boolean> {
  return (await getKv(ON_KEY)) === '1';
}

export async function setOn(on: boolean): Promise<void> {
  await setKv(ON_KEY, on ? '1' : '');
  /* Turning it on does not lock the person out of the screen they are standing
     on — they have just proved themselves to enable it. */
  if (on) markUnlocked();
}

export function markUnlocked(): void {
  unlockedAt = Date.now();
  leftAt = null;
}

/**
 * The app went to the background. Recorded rather than acted on: what matters
 * is how long it stays there, and that is only knowable on the way back.
 *
 * Only a true `background`, never `inactive` — iOS raises that for the app
 * switcher, for a notification shade pulled halfway down, and for the moment a
 * system dialog appears, including the fingerprint dialog itself.
 */
export function markLeft(): void {
  if (leftAt == null) leftAt = Date.now();
}

/** Forget the unlock, so the next look at `shouldLock` says yes. */
export function forgetUnlock(): void {
  unlockedAt = null;
  leftAt = null;
}

/**
 * Seconds the app may sit in the background before the fingerprint is asked
 * for again. Configuration, because it is the whole usability of the feature:
 * this app hands off to the system camera, to WhatsApp and to the dialler
 * dozens of times a morning, and a lock that fires on every return is a lock
 * somebody turns off by lunchtime.
 */
export async function graceSeconds(): Promise<number> {
  return getConfig<number>('mbos.devices.appLockGraceSeconds', 180);
}

/**
 * Should the lock screen be showing?
 *
 * Answers no wherever it cannot answer yes safely. A phone whose fingers were
 * removed, or whose screen lock was taken off, after the setting was turned on
 * has nothing left to check against — and the only alternative to letting the
 * person in is a handset nobody can open with a day's unsent work inside it.
 * The setting is turned OFF at the same time and the screen says why, because a
 * protection that has silently lapsed is worse than one that was never on.
 */
export async function shouldLock(): Promise<boolean> {
  if (!(await isOn())) return false;

  const can = await capability();
  if (!can.deviceCredential) {
    await setKv(ON_KEY, '');
    return false;
  }

  /* Never proved in this process — a cold start, or a sign-in that has not
     been followed by an unlock. Always ask. */
  if (unlockedAt == null) return true;

  /* Unlocked, and never out of their hands since. Nothing to reconsider. */
  if (leftAt == null) return false;

  const grace = await graceSeconds();
  return Date.now() - leftAt > grace * 1000;
}

/**
 * Whether the setting may be OFFERED at all.
 *
 * The same rule the microphone follows in MahekOne: draw nothing where it
 * cannot work. A toggle that turns on a lock this phone has no way to open is
 * a trap, and one that fails when pressed is worse than one never shown.
 */
export async function canOffer(): Promise<{ ok: boolean; why: string; label: string }> {
  const can = await capability();
  if (!can.hardware) {
    return { ok: false, why: 'This phone has no fingerprint reader.', label: can.label };
  }
  if (!can.enrolled) {
    return {
      ok: false,
      why: 'Add a fingerprint in your phone’s own Settings first, then come back.',
      label: can.label,
    };
  }
  return { ok: true, why: '', label: can.label };
}
