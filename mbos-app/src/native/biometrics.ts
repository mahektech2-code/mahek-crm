import * as LocalAuthentication from 'expo-local-authentication';

/**
 * The fingerprint, and the only place the OS is asked about it.
 *
 * There is no MBOS fingerprint. There is the one the phone already holds — the
 * same finger that unlocks the handset, enrolled in Android's own settings and
 * never seen by this app or by MahekOne. What comes back here is a yes or a no
 * and nothing else: no template, no image, nothing to store and nothing to
 * send. That is what makes this cheap to add and impossible to leak.
 */

export type Capability = {
  /** There is a sensor. */
  hardware: boolean;
  /** A finger or a face is actually enrolled on this phone. */
  enrolled: boolean;
  /**
   * Whether the phone can authenticate the person AT ALL — a PIN or a pattern
   * counts. It is the wider question and the one the lock depends on, because
   * the OS falls back to the device credential when a finger will not read.
   */
  deviceCredential: boolean;
  /** "Fingerprint", "Face unlock", or both, as this phone actually has them. */
  label: string;
};

/**
 * Never throws.
 *
 * This is asked on the settings screen and again at the moment of locking, and
 * a permissions API that fails is not a reason to strand somebody outside their
 * own day's work — so a failure reads as "no biometrics here", which sends both
 * callers down their safe path: the setting is not offered, and the lock lets
 * the person through.
 */
export async function capability(): Promise<Capability> {
  try {
    const [hardware, enrolled, types, level] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
      LocalAuthentication.getEnrolledLevelAsync(),
    ]);

    const names: string[] = [];
    if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) names.push('Fingerprint');
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) names.push('Face unlock');
    if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) names.push('Iris');

    return {
      hardware,
      enrolled,
      /* `SECRET` is a PIN, a pattern or a password. It is not a fingerprint and
         it is enough — the point of the lock is that somebody who picks the
         phone up cannot open the book, and a PIN stops them. */
      deviceCredential: level !== LocalAuthentication.SecurityLevel.NONE,
      label: names.join(' or ') || 'Fingerprint',
    };
  } catch {
    return { hardware: false, enrolled: false, deviceCredential: false, label: 'Fingerprint' };
  }
}

export type PromptOutcome =
  /** The person proved who they are. */
  | { ok: true }
  /** They pressed cancel, or backed out. Ask again; nothing is wrong. */
  | { ok: false; kind: 'cancelled' }
  /**
   * Too many failed attempts. Android stops reading fingers for thirty seconds
   * and then for longer, and it does not tell the app when that ends.
   */
  | { ok: false; kind: 'lockout'; message: string }
  /**
   * There is nothing left to authenticate against — the fingers were removed,
   * or the screen lock was taken off, after the setting was turned on. The
   * caller must LET THEM IN on this one. See `app-lock.ts`.
   */
  | { ok: false; kind: 'unavailable'; message: string };

/**
 * Ask the phone who this is.
 *
 * `disableDeviceFallback` is deliberately left off, so the OS offers the PIN
 * when a finger will not read. A salesman with a cut thumb in the middle of a
 * wet morning has to be able to get into his own day, and a lock with no way
 * past it is a lock that gets switched off — or, worse, one that strands a
 * morning's unsent orders behind a sensor.
 */
export async function prompt(message: string): Promise<PromptOutcome> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: message,
      cancelLabel: 'Cancel',
    });

    if (result.success) return { ok: true };

    switch (result.error) {
      case 'user_cancel':
      case 'app_cancel':
      case 'system_cancel':
      case 'user_fallback':
      case 'authentication_failed':
        return { ok: false, kind: 'cancelled' };
      case 'lockout':
        return {
          ok: false,
          kind: 'lockout',
          message: 'Too many tries. Your phone has paused the fingerprint for a moment — wait, then try again.',
        };
      case 'not_enrolled':
      case 'not_available':
      case 'passcode_not_set':
        return {
          ok: false,
          kind: 'unavailable',
          message: 'This phone no longer has a fingerprint or a screen lock set up.',
        };
      default:
        return { ok: false, kind: 'cancelled' };
    }
  } catch {
    /* The module itself failed. Treating that as "unavailable" rather than as
       a refusal is what stops a broken sensor from becoming a bricked app. */
    return { ok: false, kind: 'unavailable', message: 'The fingerprint reader could not be used.' };
  }
}
