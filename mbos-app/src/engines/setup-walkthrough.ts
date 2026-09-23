import { APP_LABEL, oemOf, oemWords } from './oem-keepalive';
import type { BatteryExemption, PermissionState } from './phone-readiness';

/**
 * Everything a new install or an update needs from the salesman, ONE STEP AT
 * A TIME, straight after he signs in.
 *
 * Android grants nothing at install. Every permission this app lives on is a
 * dialog a person has to answer with the app open, and two of them are not
 * dialogs at all — "Allow all the time" is a page in Settings on Android 11
 * and later, and autostart is a manufacturer's switch with no API behind it.
 * The app used to ask for these in five different places: location on the
 * home screen, notifications at boot, the camera at the first selfie, the
 * microphone at the first dictation, and the battery and autostart switches
 * only on the start-of-day gate or on a card on the Sync screen. So the
 * question somebody took to the office was "which settings do I need", and
 * the honest answer was "whichever ones the app happens to trip over first".
 *
 * This is the one list, in the one order that works:
 *
 * 1. THE POPUPS, together — location while using, notifications, camera,
 *    microphone. Four taps of Allow, no Settings.
 * 2. Location switched on for the whole phone, where it is off.
 * 3. "Allow all the time". AFTER the first, always: Android refuses the
 *    background permission outright until the foreground one is held, so
 *    asking it first spends the ask for nothing.
 * 4. The battery saver — a one-tap system popup.
 * 5. Autostart — the manufacturer's own screen, opened for him, with that
 *    manufacturer's words for it.
 *
 * PURE, for the reason every engine here gives: anything that imports a
 * permissions module cannot be exercised without a device, and the rule for
 * when this screen takes over a salesman's phone is the rule most worth
 * testing.
 *
 * **It never gates anything.** The start-of-day gate in `phone-readiness.ts`
 * is what refuses a day and it keeps that job; this screen is the fast way to
 * satisfy it, not a second copy of it. Someone who leaves half-way still has
 * a working app, and the gate still catches what matters on the morning it
 * matters.
 */

export type StepKey = 'allow' | 'location_services' | 'background' | 'battery' | 'autostart';

export type StepState =
  /** Read from the phone and it said yes, or — for autostart — he said he has done it. */
  | 'done'
  /** Something to press, and pressing it can finish the step. */
  | 'todo'
  /**
   * Android has stopped offering the popup, so the only way left is the app's
   * own page in Settings. Still a button, never a dead end: the page exists
   * and the switch is on it.
   */
  | 'settings';

export type StepAction =
  /** Fire whichever of the four popups are still unanswered, one after another. */
  | 'ask_popups'
  | 'location_settings'
  /** The background permission — on Android 11+ this OPENS the app's location page. */
  | 'ask_background'
  | 'battery'
  | 'autostart'
  | 'app_settings';

export type Step = {
  key: StepKey;
  state: StepState;
  title: string;
  detail: string;
  /** What the one button does. Null on a step that is done. */
  action: StepAction | null;
  button: string | null;
};

export type SetupFacts = {
  /** Autostart and the battery saver exist only on Android. */
  android: boolean;
  /** expo-device `Device.manufacturer`, for the autostart words. */
  manufacturer: string | null;
  /** Null where the phone would not answer — not the same as off. */
  locationServicesEnabled: boolean | null;
  foreground: PermissionState;
  foregroundCanAsk: boolean;
  background: PermissionState;
  backgroundCanAsk: boolean;
  notifications: PermissionState;
  notificationsCanAsk: boolean;
  camera: PermissionState;
  cameraCanAsk: boolean;
  microphone: PermissionState;
  microphoneCanAsk: boolean;
  batteryExemption: BatteryExemption;
  /**
   * When he said, ON THIS INSTALL, that autostart is on. Kept in the handset's
   * own store, which a reinstall wipes — and a reinstall is exactly what
   * resets the manufacturer's switch, so the two go together. An update keeps
   * both.
   */
  autostartConfirmedAt: number | null;
};

/* ------------------------------------------------------------- the popups */

type Popup = { name: string; state: PermissionState; canAsk: boolean; essential: boolean };

function popups(f: SetupFacts): Popup[] {
  return [
    { name: 'location', state: f.foreground, canAsk: f.foregroundCanAsk, essential: true },
    { name: 'notifications', state: f.notifications, canAsk: f.notificationsCanAsk, essential: false },
    { name: 'camera', state: f.camera, canAsk: f.cameraCanAsk, essential: false },
    { name: 'microphone', state: f.microphone, canAsk: f.microphoneCanAsk, essential: false },
  ];
}

/**
 * Which of the four popups there is still something to do about.
 *
 * A popup is OUTSTANDING when it is not granted. What differs is how it can
 * still be granted: a popup Android will still show is `todo`, and one it has
 * stopped showing needs the Settings page.
 */
export function outstandingPopups(f: SetupFacts): { ask: string[]; settings: string[] } {
  const ask: string[] = [];
  const settings: string[] = [];
  for (const p of popups(f)) {
    if (p.state === 'granted') continue;
    if (p.canAsk) ask.push(p.name);
    else settings.push(p.name);
  }
  return { ask, settings };
}

function listed(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function allowStep(f: SetupFacts): Step {
  const { ask, settings } = outstandingPopups(f);
  const title = `Allow ${APP_LABEL} what it needs`;

  if (!ask.length && !settings.length) {
    return {
      key: 'allow',
      state: 'done',
      title,
      detail: 'Location, notifications, camera and microphone are all allowed.',
      action: null,
      button: null,
    };
  }

  /* The popups come first even when some need Settings: four taps here is the
     cheapest thing on the whole list, and the page in Settings shows every
     permission together, so one trip there afterwards covers the rest. */
  if (ask.length) {
    return {
      key: 'allow',
      state: 'todo',
      title,
      detail:
        `Your phone will ask about ${listed(ask)}, one after another. Tap Allow each time — ` +
        '“While using the app” is the right answer for location here.',
      action: 'ask_popups',
      button: ask.length === 1 ? 'Allow' : `Allow all ${ask.length}`,
    };
  }

  return {
    key: 'allow',
    state: 'settings',
    title,
    detail:
      `Your phone has stopped asking about ${listed(settings)}. Tap below, open Permissions, and switch ` +
      `${settings.length === 1 ? 'it' : 'them'} on. Then come back here.`,
    action: 'app_settings',
    button: 'Open MBOS settings',
  };
}

function locationServicesStep(f: SetupFacts): Step {
  const title = 'Switch on location';
  /* Null is a phone that would not answer. It is not drawn as off, and it does
     not hold the walkthrough — the start-of-day gate reads it again. */
  if (f.locationServicesEnabled !== false) {
    return { key: 'location_services', state: 'done', title, detail: 'Location is on.', action: null, button: null };
  }
  return {
    key: 'location_services',
    state: 'todo',
    title,
    detail: 'Location is switched off for the whole phone. Turn it on, then come back here.',
    action: 'location_settings',
    button: 'Open location settings',
  };
}

function backgroundStep(f: SetupFacts): Step {
  const title = 'Allow location all the time';
  if (f.background === 'granted') {
    return {
      key: 'background',
      state: 'done',
      title,
      detail: 'Allowed all the time, so your route keeps recording with the phone in your pocket.',
      action: null,
      button: null,
    };
  }

  /* Without the foreground permission Android will not even show this page's
     option, so the step waits rather than sending him somewhere useless. */
  if (f.foreground !== 'granted') {
    return {
      key: 'background',
      state: 'todo',
      title,
      detail: 'Allow location in the step above first. Your phone will not offer this until you have.',
      action: null,
      button: null,
    };
  }

  return {
    key: 'background',
    state: f.backgroundCanAsk ? 'todo' : 'settings',
    title,
    detail:
      (f.android
        ? `Your phone will open ${APP_LABEL}’s location page. Tap “Allow all the time”, then come back here. `
        : 'Tap below and choose “Always”. ') +
      'Anything less and the office stops seeing you the moment the phone goes in your pocket.',
    action: f.backgroundCanAsk ? 'ask_background' : 'app_settings',
    button: f.android ? 'Open the location page' : 'Allow',
  };
}

function batteryStep(f: SetupFacts): Step {
  const title = 'Stop the battery saver switching MBOS off';
  /* `unknown` is iOS, or a phone that would not say. Nothing to press and
     nothing to claim, so it is not held against him. */
  if (!f.android || f.batteryExemption !== 'optimised') {
    return { key: 'battery', state: 'done', title, detail: 'Nothing to do.', action: null, button: null };
  }
  return {
    key: 'battery',
    state: 'todo',
    title,
    detail: 'Your phone will ask whether MBOS may keep running. Tap Allow.',
    action: 'battery',
    button: 'Allow MBOS to keep running',
  };
}

/**
 * The one step the phone cannot confirm, so HE does.
 *
 * No Android API reads autostart, on any make. The step is therefore done
 * when he says it is, once per install — which is also exactly how often the
 * switch resets. The start-of-day gate goes on watching the one piece of real
 * evidence there is, a worked day that recorded nothing, and reopens the
 * question if his word turns out to be wrong.
 */
function autostartStep(f: SetupFacts): Step {
  const words = oemWords(oemOf(f.manufacturer));
  if (!f.android || f.autostartConfirmedAt != null) {
    return { key: 'autostart', state: 'done', title: words.label, detail: 'Done.', action: null, button: null };
  }
  return {
    key: 'autostart',
    state: 'todo',
    title: words.label,
    detail: words.path + (words.also ? ' ' + words.also : ''),
    action: 'autostart',
    button: 'Open the setting',
  };
}

/** Every step, in the order they have to be done. */
export function setupSteps(f: SetupFacts): Step[] {
  return [allowStep(f), locationServicesStep(f), backgroundStep(f), batteryStep(f), autostartStep(f)];
}

/** The first step with anything left in it, or null once the phone is set up. */
export function currentStep(steps: readonly Step[]): Step | null {
  return steps.find((s) => s.state !== 'done') ?? null;
}

/**
 * Whether to put the walkthrough in front of him without being asked.
 *
 * ONCE PER BUILD, and only with something to do. A fresh install has nothing
 * shown and everything outstanding, so it opens straight after sign-in; an
 * update carries a new version, so it opens again if the update left anything
 * missing — a reinstall that lost its permissions, or a permission revoked by
 * Android's own unused-app clean-up. A phone with everything done never sees
 * it, and a man who pressed "Later" is not stopped again until the next build:
 * the start-of-day gate is what holds the line in between, on the morning it
 * matters, rather than this screen on every open.
 */
export function shouldOpenWalkthrough(args: {
  steps: readonly Step[];
  version: string;
  shownForVersion: string | null;
}): boolean {
  if (currentStep(args.steps) === null) return false;
  return args.shownForVersion !== args.version;
}
