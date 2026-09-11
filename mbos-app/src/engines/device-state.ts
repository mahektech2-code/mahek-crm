/**
 * WHAT THE PHONE CAN SAY ABOUT ITSELF, as a rule rather than as native calls.
 *
 * This is the same argument `cadence.ts` makes and it is worth repeating,
 * because it is the reason that bug survived three days in the field:
 * `trail.ts` imports expo-location and TaskManager at module scope, so
 * nothing in it can be exercised without a device. A classification nobody
 * can test is a classification nobody can be sure of — and this one decides
 * what a manager in the office is told about a salesman's handset, which is
 * exactly the kind of sentence that must not be wrong.
 *
 * PURE. It takes what the OS answered and returns what to send. The native
 * asking lives in `sync/device-state.ts` beside it.
 */

/** The four answers the office understands. Kept in step with the server's
 *  `lib/mbos/device-state.ts`, which refuses anything else. */
export type LocationPermission = 'always' | 'while_using' | 'denied' | 'undetermined';

/** What expo-location hands back for either scope. */
export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

/**
 * FOREGROUND AND BACKGROUND ARE ONE ANSWER, and the order matters.
 *
 * Android grants these in a ladder: there is no background permission without
 * a foreground one, and "Allow all the time" is a strictly larger grant than
 * "While using the app". So the foreground answer is read FIRST — refused
 * there means refused outright, whatever the background scope claims, because
 * a stale background grant on a phone whose location has since been revoked
 * would otherwise report `always` for a handset that cannot take a single fix.
 *
 * `undetermined` survives only where NEITHER has been asked. Once the
 * foreground prompt has been answered, the pair describes a real setting and
 * the office should be told which one.
 */
export function permissionAnswer(
  foreground: PermissionStatus,
  background: PermissionStatus,
): LocationPermission {
  if (foreground === 'denied') return 'denied';
  if (foreground === 'undetermined') {
    return background === 'granted' ? 'always' : 'undetermined';
  }
  return background === 'granted' ? 'always' : 'while_using';
}

/** What netinfo says, folded to the four words the office stores. */
export function connectionAnswer(
  type: string | null | undefined,
  isConnected: boolean | null | undefined,
): 'wifi' | 'cellular' | 'none' | 'unknown' {
  /*
   * A REPORT THAT ARRIVES CANNOT HONESTLY SAY "none", but it can be TAKEN
   * while the radio is down and sent minutes later out of a queue, so the
   * value is kept rather than argued with. What no column anywhere claims is
   * that a phone we have not heard from has no internet — that is silence,
   * and the office measures it from when the handset last spoke.
   */
  if (isConnected === false) return 'none';
  if (type === 'wifi') return 'wifi';
  if (type === 'cellular') return 'cellular';
  return 'unknown';
}

/**
 * expo-battery answers a FRACTION, and the office stores a percentage.
 *
 * -1 is what it returns where the platform will not say, which rounds to a
 * confident "-100%" if it is passed straight through. Null is the honest
 * answer and the column is nullable for exactly this.
 */
export function batteryPercent(level: number | null | undefined): number | null {
  if (typeof level !== 'number' || !Number.isFinite(level)) return null;
  if (level < 0 || level > 1) return null;
  return Math.round(level * 100);
}
