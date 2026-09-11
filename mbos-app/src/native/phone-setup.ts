import { Platform } from 'react-native';
import { PhoneSetup } from '../../modules/phone-setup';

/**
 * The phone's own settings, read and repaired.
 *
 * A salesman on a vivo checked in at 04:16 and posted zero GPS fixes all
 * day. Every permission was granted and every expo-location call succeeded;
 * the OEM battery manager killed the foreground service behind them. The
 * office saw a man who never left home, and nothing on the handset or on any
 * screen in MahekOne could have said otherwise — a permission model answers
 * "were you allowed to", and this is a phone answering "and did I let you".
 *
 * `modules/phone-setup` is the native half. This file is the contract every
 * screen uses, and it exists so that three rules hold in ONE place rather
 * than at every call site.
 *
 * **NOTHING HERE EVER THROWS.** Not on iOS, not on web, not on an older APK
 * that predates the native module, not when a ROM stubs out the service it
 * asks. A screen whose entire job is helping somebody whose phone is already
 * misbehaving is the last screen in this app that may crash. Where the
 * answer cannot be had it is `'unknown'` — which is a real answer and is
 * never to be rendered as "your phone is fine".
 *
 * **`'unknown'` IS NOT `'exempt'`.** Two different facts: one says we asked
 * and the phone is not throttling us, the other says we could not ask. The
 * second must not be drawn as a tick, or the screen quietly tells a salesman
 * his phone is set up correctly on precisely the handsets we could not check.
 *
 * **IT DIAGNOSES; IT DOES NOT GATE.** The same rule `engines/geo.ts` states
 * for a GPS reading. Nothing in MBOS may refuse a check-in, a visit or an
 * order because this reports `'optimised'` — a salesman whose day is refused
 * over a settings screen stops recording days, and the company loses the work
 * as well as the diagnosis.
 */

/**
 * Whether Android is leaving this app alone.
 *
 * `optimised` is the one that costs a day: Doze and app standby are free to
 * kill the foreground service the location trail runs in. `unknown` is iOS,
 * web, a build with no native module in it, and any ROM that refuses to
 * answer.
 */
export type BatteryExemption = 'exempt' | 'optimised' | 'unknown';

/**
 * Which screen actually came up.
 *
 * `opened_oem` is the autostart list itself. `opened_app_settings` is the
 * fallback — Android's own app details page, which always exists but is two
 * screens away from the switch, so a caller that gets this should say what
 * to look for rather than assume the salesman has landed on it.
 */
export type OpenResult = 'opened_oem' | 'opened_app_settings' | 'failed';

const EXEMPTIONS: BatteryExemption[] = ['exempt', 'optimised', 'unknown'];
const OPEN_RESULTS: OpenResult[] = ['opened_oem', 'opened_app_settings', 'failed'];

/* The native side sends a plain string across the bridge, so what comes back
   is checked rather than cast. An `as BatteryExemption` would let a native
   half from a different APK — a real possibility when sideloading has no
   staged rollout — put a word this app has never heard of into a union the
   screens switch on, and the failure would be a screen rendering nothing at
   all rather than saying it could not tell. */
function asExemption(value: unknown): BatteryExemption {
  return EXEMPTIONS.includes(value as BatteryExemption) ? (value as BatteryExemption) : 'unknown';
}

function asOpenResult(value: unknown): OpenResult {
  return OPEN_RESULTS.includes(value as OpenResult) ? (value as OpenResult) : 'failed';
}

/** Is the native half present at all? Absent on iOS, on web, and on an APK built before it landed. */
const native = Platform.OS === 'android' ? PhoneSetup : null;

/** Whether Android is currently exempting this app from battery optimisation. */
export async function batteryExemption(): Promise<BatteryExemption> {
  if (!native) return 'unknown';
  try {
    return asExemption(await native.batteryExemption());
  } catch {
    return 'unknown';
  }
}

/**
 * Fire the system exemption dialog, and resolve with the state AFTER the
 * user answers.
 *
 * The dialog reports the same result code whichever button is pressed, so
 * the native side waits for the app to come back to the foreground and then
 * re-reads the real state. That is why this resolves with a value rather
 * than with whether it was granted: what the user tapped is a guess, what
 * the phone says afterwards is a fact.
 *
 * A resolved `'optimised'` therefore means he said no, or the dialog never
 * appeared — both of which leave the screen with the same thing to say, and
 * neither of which is an error.
 */
export async function requestBatteryExemption(): Promise<BatteryExemption> {
  if (!native) return 'unknown';
  try {
    return asExemption(await native.requestBatteryExemption());
  } catch {
    return 'unknown';
  }
}

/**
 * Open the manufacturer's autostart list, or the nearest real screen to it.
 *
 * There is no Android API for this — autostart is an OEM invention and every
 * one of them built it differently — so the native side works down a list of
 * undocumented component names and falls back to the app's own settings
 * page. The return value says which it got, because those two need different
 * sentences on the screen.
 */
export async function openAutostartSettings(): Promise<OpenResult> {
  if (!native) return 'failed';
  try {
    return asOpenResult(await native.openAutostartSettings());
  } catch {
    return 'failed';
  }
}

/** Android's own app details page — permissions, storage, battery. */
export async function openAppSettings(): Promise<boolean> {
  if (!native) return false;
  try {
    return (await native.openAppSettings()) === true;
  } catch {
    return false;
  }
}

/** The system location settings, for a phone with location switched off entirely. */
export async function openLocationSettings(): Promise<boolean> {
  if (!native) return false;
  try {
    return (await native.openLocationSettings()) === true;
  } catch {
    return false;
  }
}
