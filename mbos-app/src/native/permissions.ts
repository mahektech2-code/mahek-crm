import * as Location from 'expo-location';
import { getKv, setKv } from '../db';

/**
 * Asking for location before the work needs it.
 *
 * It used to be asked for at the moment of the first check-in, inside
 * `getFix()`, and that is a bad moment: the salesman is standing outside a
 * shop at nine in the morning with the day waiting on him, and a system
 * dialog appears over the button he just pressed. If he taps the wrong one —
 * and under time pressure people tap the one that makes the dialog go away —
 * Android will not ask again, his check-in records `denied`, and nothing on
 * the phone explains why the office cannot see him for the rest of the week.
 *
 * So it is asked on the first open instead, when nothing is riding on it.
 *
 * **ASKED ONCE, NEVER NAGGED.** Android shows the dialog twice and then stops
 * showing it at all, so a second and third automatic ask are spent for
 * nothing and teach the person that the app pesters. After a refusal this
 * records the fact and stays quiet; `getFix()` still asks at the point of use,
 * which is the one place where a person who has changed their mind can grant
 * it deliberately.
 *
 * **It never blocks anything.** A refused permission is a flagged visit, not
 * a lost one — the rule the whole location subsystem is built on. This returns
 * what happened so a screen can say so if it wants to, and callers are free to
 * ignore it entirely.
 */

const ASKED_KEY = 'mbos.permissions.locationAsked';

export type PermissionOutcome =
  /** Already held, or granted just now. */
  | 'granted'
  /** Asked and refused — this time or previously. Not asked again. */
  | 'denied'
  /** Deliberately not asked, because it has been asked before and refused. */
  | 'skipped';

/**
 * Make sure the location permission has been ASKED FOR at least once.
 *
 * Safe to call on every open: it is a no-op once the answer is known.
 */
export async function ensureLocationPermission(): Promise<PermissionOutcome> {
  try {
    const existing = await Location.getForegroundPermissionsAsync();
    if (existing.status === 'granted') return 'granted';

    /* `canAskAgain` is false once Android has stopped showing the dialog.
       Asking then is a call that returns instantly and changes nothing, and
       the person sees no dialog — so it would look like the app did nothing. */
    if (!existing.canAskAgain) return 'denied';

    if (await getKv(ASKED_KEY)) return 'skipped';

    const asked = await Location.requestForegroundPermissionsAsync();
    await setKv(ASKED_KEY, String(Date.now()));
    return asked.status === 'granted' ? 'granted' : 'denied';
  } catch {
    /* A permissions API that throws is not a reason to stop the app opening.
       The day still starts; the check-in records what it finds. */
    return 'denied';
  }
}
