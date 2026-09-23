import { Platform } from 'react-native';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Camera } from 'expo-camera';
import { AudioModule } from 'expo-audio';

import { getKv, setKv } from '../db';
import { batteryExemption } from '../native/phone-setup';
import { registerForPush } from '../native/push';
import {
  outstandingPopups,
  setupSteps,
  shouldOpenWalkthrough,
  type SetupFacts,
  type Step,
} from '../engines/setup-walkthrough';
import type { BatteryExemption, PermissionState } from '../engines/phone-readiness';

/**
 * The walkthrough in `engines/setup-walkthrough.ts`, wired to the phone.
 *
 * Every permission API and every stored mark lives here, and the rule for
 * what to ask and when lives next door where it can be tested without a
 * device.
 */

/** Which build last had the walkthrough put in front of him. */
const SHOWN_KEY = 'setup-walkthrough.shownFor';
/** When he said autostart is on. Wiped by a reinstall, as the switch is. */
const AUTOSTART_KEY = 'setup-walkthrough.autostartConfirmedAt';

type Response = { status?: string; granted?: boolean; canAskAgain?: boolean } | null;

function stateOf(r: Response): PermissionState {
  if (!r) return 'undetermined';
  if (r.granted || r.status === 'granted') return 'granted';
  return r.status === 'undetermined' ? 'undetermined' : 'denied';
}

/* A response that could not be read keeps the ask open: declaring "Android
   will not ask again" on the strength of a call that threw would send a man
   to Settings for a popup his phone would happily have shown. */
function canAsk(r: Response): boolean {
  return r?.canAskAgain ?? true;
}

/**
 * The build, as Android knows it — version and version code, never the
 * over-the-air bundle. The walkthrough follows installs and updates of the
 * app itself; a bundle pushed over the air changes no permission.
 */
export function walkthroughVersion(): string {
  return `${Application.nativeApplicationVersion ?? '?'} (${Application.nativeBuildVersion ?? '?'})`;
}

/**
 * Every fact the steps turn on, read fresh.
 *
 * Fresh every time, because the screen is built around him going out to
 * Settings and coming back: a step still saying "not allowed" after he allowed
 * it is the app telling him he did not do what he just did. Each reading is
 * guarded on its own, so one API that throws costs one fact and never the
 * screen.
 */
export async function readSetupFacts(): Promise<SetupFacts> {
  const [services, fg, bg, push, camera, mic, battery, autostart] = await Promise.all([
    Location.hasServicesEnabledAsync().catch<null>(() => null),
    Location.getForegroundPermissionsAsync().catch<null>(() => null),
    Location.getBackgroundPermissionsAsync().catch<null>(() => null),
    (Notifications.getPermissionsAsync() as Promise<Response>).catch<null>(() => null),
    Camera.getCameraPermissionsAsync().catch<null>(() => null),
    AudioModule.getRecordingPermissionsAsync().catch<null>(() => null),
    batteryExemption().catch<BatteryExemption>(() => 'unknown'),
    getKv(AUTOSTART_KEY).catch<null>(() => null),
  ]);

  const confirmed = autostart ? Number(autostart) : NaN;

  return {
    android: Platform.OS === 'android',
    manufacturer: Device.manufacturer,
    locationServicesEnabled: services,
    foreground: stateOf(fg),
    foregroundCanAsk: canAsk(fg),
    background: stateOf(bg),
    backgroundCanAsk: canAsk(bg),
    notifications: stateOf(push),
    notificationsCanAsk: canAsk(push),
    camera: stateOf(camera),
    cameraCanAsk: canAsk(camera),
    microphone: stateOf(mic),
    microphoneCanAsk: canAsk(mic),
    batteryExemption: battery,
    autostartConfirmedAt: Number.isFinite(confirmed) ? confirmed : null,
  };
}

export async function readSetupSteps(): Promise<Step[]> {
  return setupSteps(await readSetupFacts());
}

/**
 * Should the walkthrough open on its own right now?
 *
 * Fails to NO. This runs on the home screen as the app opens, and a check that
 * throws must never stand between a salesman and his day — the start-of-day
 * gate still reads every one of these facts before a check-in.
 */
export async function walkthroughDue(): Promise<boolean> {
  try {
    const [steps, shown] = await Promise.all([readSetupSteps(), getKv(SHOWN_KEY)]);
    return shouldOpenWalkthrough({ steps, version: walkthroughVersion(), shownForVersion: shown });
  } catch {
    return false;
  }
}

/** Record that this build has shown him the walkthrough, so it does not open again on its own. */
export async function markWalkthroughShown(): Promise<void> {
  await setKv(SHOWN_KEY, walkthroughVersion());
}

/**
 * Fire every popup still waiting for an answer, ONE AFTER ANOTHER.
 *
 * In sequence and never together: Android shows one permission dialog at a
 * time, and a second request fired while the first is up is refused rather
 * than queued. Location goes first because it is the one the day depends on,
 * and notifications go through `registerForPush`, which is what also creates
 * the notification channel Android 13 needs before it will show that dialog
 * at all — and registers the token the office pushes to, which asking alone
 * would not.
 */
export async function askPopups(): Promise<void> {
  const { ask } = outstandingPopups(await readSetupFacts());
  for (const name of ask) {
    try {
      if (name === 'location') await Location.requestForegroundPermissionsAsync();
      else if (name === 'notifications') await registerForPush();
      else if (name === 'camera') await Camera.requestCameraPermissionsAsync();
      else if (name === 'microphone') await AudioModule.requestRecordingPermissionsAsync();
    } catch {
      /* One popup that fails is one fact left outstanding; the step says so
         when the screen re-reads, and the others still get their turn. */
    }
  }
}

/**
 * "Allow all the time".
 *
 * On Android 11 and later this does not show a dialog — it opens the app's own
 * location page in Settings, where "Allow all the time" is an option, and
 * resolves when he comes back. That is Android's rule, not a choice here: no
 * app on a current phone can grant it from a popup.
 */
export async function askBackgroundLocation(): Promise<void> {
  try {
    await Location.requestBackgroundPermissionsAsync();
  } catch {
    /* Left outstanding; the step re-reads and says so. */
  }
}

/** He says autostart is on. Kept until a reinstall, which is when the switch resets. */
export async function confirmAutostart(): Promise<void> {
  await setKv(AUTOSTART_KEY, String(Date.now()));
}
