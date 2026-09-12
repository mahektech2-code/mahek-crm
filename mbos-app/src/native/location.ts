import * as Location from 'expo-location';
import { setKv } from '../db';

/**
 * The radio.
 *
 * Two rules govern everything here, and both come straight from the brief:
 *
 *   A GPS-dependent action must complete WITHOUT a fix. Indoors in a concrete
 *   godown there is no fix, and a salesman who cannot log a visit there stops
 *   logging visits everywhere.
 *
 *   Accuracy is part of the reading. A 500-metre fix is not a check-in. It is
 *   still recorded — it is just recorded as what it is, and flagged.
 */

export type Fix = {
  lat: number;
  lng: number;
  accuracyM: number;
  at: number;
};

export type FixResult =
  | { status: 'ok'; fix: Fix }
  | { status: 'coarse'; fix: Fix; reason: string }
  | { status: 'denied'; reason: string }
  | { status: 'unavailable'; reason: string };

export async function requestPermission(): Promise<boolean> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
}

export async function hasPermission(): Promise<boolean> {
  const { status } = await Location.getForegroundPermissionsAsync();
  return status === 'granted';
}

/**
 * Try for a fix, and give up rather than hang.
 *
 * The timeout is short on purpose: the salesman is standing in a shop with the
 * owner waiting. Ten seconds of trying, then carry on without one and say so.
 *
 * **`precise` IS FOR THE ONE READING THAT DECIDES SOMETHING.** Everything else
 * here asks for `Balanced`, which on Android is roughly a city block and is
 * exactly right for the questions it answers — which part of town an order was
 * taken in, where a leg set off from. The check-in gate is a different
 * question: it refuses a salesman at 100 m, and a reading only good to 100 m
 * cannot tell the doorway from the tea shop across the road, so every refusal
 * it produced would land on somebody standing in the right place.
 *
 * It is a parameter rather than the new default because `High` keeps the GPS
 * radio on longer, and paying that on every fix the app takes — the departure,
 * every order — to serve one of them would be a battery cost with nothing to
 * show for it.
 *
 * **THE TRAIL IS THE SECOND CALLER THAT PASSES IT, and it is not a third
 * exception so much as the same one.** The list above used to name the trail
 * as a place Balanced was "exactly right". It is not, and for a reason that is
 * about the READER rather than the radio: the Live map runs
 * `dropInaccurateFixes` over a trail before drawing it and discards anything
 * worse than `mbos.location.gpsAccuracyThresholdM`, 50 m. Balanced returns
 * 100 m indoors — a city block, as this comment says two paragraphs up — so
 * every coarse trail fix was woken for, kept, uploaded, stored and then thrown
 * away unseen. Coarse is genuinely fine for "which part of town was this order
 * taken in", because nothing filters that. It is useless for a line that
 * claims to be the road somebody rode.
 */
export async function getFix(opts: { accuracyThresholdM: number; timeoutMs?: number; precise?: boolean } = { accuracyThresholdM: 100 }): Promise<FixResult> {
  const granted = await hasPermission();
  if (!granted) {
    const ok = await requestPermission();
    if (!ok) {
      return { status: 'denied', reason: 'Location permission is off. The visit will be saved and flagged for your manager.' };
    }
  }

  try {
    const timeout = opts.timeoutMs ?? 10_000;
    const position = await Promise.race([
      Location.getCurrentPositionAsync({
        accuracy: opts.precise ? Location.Accuracy.High : Location.Accuracy.Balanced,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout)),
    ]);

    if (!position) {
      return { status: 'unavailable', reason: 'No GPS fix. The visit will be saved and flagged for your manager to confirm.' };
    }

    const fix: Fix = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracyM: Math.round(position.coords.accuracy ?? 9999),
      at: position.timestamp,
    };

    /* Worse than the configured threshold is not a valid location — but the
       action proceeds, carrying the flag. Blocking here would be the mistake. */
    remember(fix);

    if (fix.accuracyM > opts.accuracyThresholdM) {
      return {
        status: 'coarse',
        fix,
        reason: `Only accurate to about ${fix.accuracyM} m. Recorded, and flagged for your manager.`,
      };
    }

    return { status: 'ok', fix };
  } catch {
    return { status: 'unavailable', reason: 'The phone could not get a location. Saved without one.' };
  }
}

/** The fix, whatever its quality, or null. Callers record the absence. */
export function fixOf(result: FixResult): Fix | null {
  return result.status === 'ok' || result.status === 'coarse' ? result.fix : null;
}

/**
 * The last fix this handset got, whoever asked for it.
 *
 * Remembered HERE, in the one function that talks to the radio, rather than at
 * the five places that call it — so the visit screen's own fix, the check-in's
 * and every trail tick all feed the same answer without any of them knowing
 * about it. That is what lets an order logged inside a shop carry the fix the
 * visit took at its door seconds earlier, instead of waiting for a new one.
 *
 * A coarse fix is remembered too. Five hundred metres is poor evidence of a
 * doorway and perfectly good evidence of which part of the city somebody is
 * in, and the accuracy travels with it so nothing downstream has to guess.
 *
 * Written and never awaited by the caller: this must not add a step to a path
 * a salesman is waiting on.
 */
const LAST_FIX = 'lastFix';

function remember(fix: Fix): void {
  void setKv(LAST_FIX, JSON.stringify(fix)).catch(() => {});
}

/**
 * The same remembering, for a fix that did not come through `getFix()` —
 * the background trail task, which gets its points pushed by the OS rather
 * than asking the radio itself. Exported rather than folded into `getFix()`
 * because a background fix has no accuracy threshold to compare against and
 * no permission to ask for; it already has both, settled, from the OS.
 */
export function rememberFix(fix: Fix): void {
  remember(fix);
}
