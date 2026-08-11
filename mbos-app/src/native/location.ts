import * as Location from 'expo-location';

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
 */
export async function getFix(opts: { accuracyThresholdM: number; timeoutMs?: number } = { accuracyThresholdM: 100 }): Promise<FixResult> {
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
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
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
