import { isoDate } from '../lib/format';

/**
 * Whether this phone can be trusted to record a day before the day is started.
 *
 * THE OS SAYS YES AND THEN DOES NOTHING — `trail-watchdog.ts` next door was
 * written to notice that AFTER the fact, and this is the other end of the same
 * incident. A salesman on a vivo checked in at 04:16 and posted not one
 * position all day. Every permission read correct, the background task really
 * was registered, and Funtouch's battery manager killed the foreground service
 * behind it anyway. Nothing on the handset looked wrong, nothing in the office
 * looked wrong, and the only symptom was a man who appeared not to have left
 * home.
 *
 * So the check-in is BLOCKED until the phone can show it will record the
 * trail, and where it genuinely cannot, the screen is A DEAD END SAID IN
 * WORDS. There is no skip button, exactly as the attendance selfie has none:
 * AGENTS.md records why its "Start the day without a photo" button was taken
 * away — it produced two kinds of day, some that proved something and some
 * that proved nothing, with nothing on the record saying which. A day started
 * past a warning about tracking is the same two kinds of day.
 *
 * PURE, and in `engines/` rather than inside the screen, for the reason
 * `cadence.ts` and `trail-watchdog.ts` both give and this incident proves
 * twice over: anything that imports expo-location cannot be exercised without
 * a device, and a gate nobody can test is a gate nobody can be sure of. A
 * WRONG one here is worse than no gate at all — it would refuse a working
 * handset the day's work, which is the one failure a salesman cannot carry on
 * past.
 */

export type PermissionState = 'granted' | 'denied' | 'undetermined';
export type BatteryExemption = 'exempt' | 'optimised' | 'unknown';

export type ReadinessInput = {
  /** expo-device `Device.manufacturer`, e.g. "vivo". Null on web, and when the phone will not say. */
  manufacturer: string | null;
  /** Null where the query itself failed — which is NOT the same as "off". */
  locationServicesEnabled: boolean | null;
  foreground: PermissionState;
  background: PermissionState;
  /** False once Android will no longer show the prompt — the dead end. */
  canAskAgain: boolean;
  batteryExemption: BatteryExemption;
  /** The last day he worked, and whether it produced any trail at all. */
  previousWorkedDay: { day: string; hadTrail: boolean } | null;
  /** When he last said he had done the battery steps, epoch ms. */
  acknowledgedAt: number | null;
  nowMs: number;
};

export type ItemKey = 'location_services' | 'foreground' | 'background' | 'battery' | 'autostart';

export type ItemState =
  /** Read from the phone, and the phone said yes. */
  | 'ok'
  /** Read from the phone, the phone said no, and there is something to press. */
  | 'todo'
  /**
   * NOBODY CAN READ THIS, and that is not the same as `ok`.
   *
   * Autostart has no API on any Android — not a private one, not a hidden
   * one — and battery exemption is readable on Android and simply absent on
   * iOS. Drawing either as a tick would be the app asserting something it has
   * no way to know, on the one screen whose whole job is to stop exactly that.
   */
  | 'unknowable'
  /** Android has stopped asking, and MBOS cannot route around it. */
  | 'dead_end';

export type ReadinessItem = {
  key: ItemKey;
  state: ItemState;
  title: string;
  detail: string;
  action: 'location_settings' | 'ask_permission' | 'app_settings' | 'battery' | 'autostart' | 'acknowledge' | null;
};

export type Readiness = {
  items: ReadinessItem[];
  mayCheckIn: boolean;
  deadEnd: boolean;
};

/* ------------------------------------------------------------ the words */

/**
 * THE MANUFACTURER CHANGES THE WORDS AND NEVER THE RULE.
 *
 * Every one of these phones has the same setting and not one of them calls it
 * the same thing. A salesman told to find "Autostart" on a phone whose menu
 * says "Background power consumption" does not conclude that his phone is
 * unusual — he concludes the app is wrong about his phone, and the next thing
 * he does is ring the office to be told to ignore the screen. So the row is
 * titled with HIS phone's own word and the path is the path he will actually
 * walk.
 *
 * `label` is the setting as the phone spells it; `path` is where it lives;
 * `also` is the second setting on the same phone that undoes the first, which
 * on several of these is the one that actually matters.
 *
 * An unrecognised manufacturer gets honest generic wording. NEVER A GUESS: a
 * confident wrong path is worse than an admitted vague one, because a man who
 * cannot find "Autostart" where we said it was stops believing the rest of the
 * screen too.
 */
type Oem = { label: string; path: string; also: string | null };

const GENERIC: Oem = {
  label: 'Let MBOS run in the background',
  path:
    'Open your phone Settings and look for Battery, then for anything about background apps, ' +
    'app launch or autostart. Set MBOS so the phone never stops it.',
  also: null,
};

function oemWords(manufacturer: string | null): Oem {
  const m = (manufacturer ?? '').trim().toLowerCase();
  if (!m) return GENERIC;

  /* vivo and iQOO are one company and one skin, Funtouch. This is the phone
     the whole gate was built for. */
  if (m.includes('vivo') || m.includes('iqoo')) {
    return {
      label: 'Autostart',
      path:
        'Settings → Apps → Special app access → Autostart → switch MBOS on.',
      also:
        'Then Settings → Battery → Background power consumption management → MBOS → ' +
        'Allow high background power consumption.',
    };
  }

  if (m.includes('xiaomi') || m.includes('redmi') || m.includes('poco')) {
    return {
      label: 'Autostart',
      path: 'Settings → Apps → Manage apps → MBOS → Autostart → switch it on.',
      also: 'Then on the same MBOS page: Battery saver → No restrictions.',
    };
  }

  /* Realme runs ColorOS too, and both skins call it the same thing. */
  if (m.includes('oppo') || m.includes('realme')) {
    return {
      label: 'Auto-launch',
      path: 'Settings → Apps → App management → MBOS → Auto-launch → switch it on.',
      also: 'Then Settings → Battery → App battery management → MBOS → Allow background running.',
    };
  }

  if (m.includes('oneplus')) {
    return {
      label: 'Battery optimisation',
      path: 'Settings → Apps → MBOS → Battery usage → Unrestricted.',
      also: 'Then Settings → Battery → More → Advanced optimisation → switch Deep optimisation off.',
    };
  }

  if (m.includes('huawei') || m.includes('honor')) {
    return {
      label: 'App launch',
      path: 'Settings → Battery → App launch → MBOS → Manage manually.',
      also: 'Switch on all three: Auto-launch, Secondary launch and Run in background.',
    };
  }

  if (m.includes('samsung')) {
    return {
      label: 'Never sleeping apps',
      path:
        'Settings → Battery → Background usage limits → Never sleeping apps → add MBOS.',
      also: 'Also check MBOS is not in the Sleeping apps or Deep sleeping apps list on the same page.',
    };
  }

  return GENERIC;
}

/* ------------------------------------------------------------ the rules */

/**
 * Whether an acknowledgement still stands.
 *
 * AN ACKNOWLEDGEMENT IS A CLAIM AND NEVER A PROOF, so it buys exactly one
 * day. He says he has done the autostart steps; the only thing that can
 * actually confirm it is a day that produced a trail, and that day has not
 * happened yet. So the claim unblocks the day in front of him and no more: if
 * the next day is also silent, `previousWorkedDay` moves forward to it, the
 * acknowledgement is no longer AFTER the failing day, and the gate shuts
 * again. That is the whole rule, and it is why the comparison is against the
 * failing day's own date rather than against an age in hours — "he said so
 * yesterday" is a fact about a day, and a 24-hour window would let a claim
 * made on Monday evening cover a Tuesday that failed all over again.
 *
 * Strictly after: a claim made ON the failing day cannot be a response to it,
 * because at the time it was made nobody yet knew the day would record
 * nothing.
 *
 * `isoDate` is the local calendar date and never `toISOString`, which answers
 * in UTC — the same rule the whole codebase keeps, arriving here as the
 * difference between a claim made at 6am and one made the previous evening.
 *
 * A mark in the FUTURE is discarded rather than trusted, which is the same
 * reading `trail-watchdog.ts` gives a future `lastKeptAt` and for a sharper
 * reason: a phone whose clock is running a week ahead would stamp a claim
 * dated next Tuesday, and every day between now and then would find an
 * acknowledgement sitting after it. That is a gate held permanently open by an
 * error, which is the one direction it must never fail in.
 */
function acknowledgedAfter(day: string, acknowledgedAt: number | null, nowMs: number): boolean {
  if (acknowledgedAt == null || !Number.isFinite(acknowledgedAt) || acknowledgedAt <= 0) return false;
  if (Number.isFinite(nowMs) && acknowledgedAt > nowMs) return false;
  return isoDate(new Date(acknowledgedAt)) > day;
}

function locationServicesItem(i: ReadinessInput): ReadinessItem {
  if (i.locationServicesEnabled === true) {
    return {
      key: 'location_services',
      state: 'ok',
      title: 'Location is switched on',
      detail: 'Your phone’s location is on.',
      action: null,
    };
  }

  /*
   * Null is "we asked and the phone would not answer", which is a different
   * fact from "off" and must not be drawn as either. It does not block: the
   * three readable checks below are what the gate stands on, and refusing a
   * day because one query threw would take a working handset off the road.
   */
  if (i.locationServicesEnabled == null) {
    return {
      key: 'location_services',
      state: 'unknowable',
      title: 'Could not check location',
      detail:
        'The phone would not say whether location is on. Open your location settings and make sure it is.',
      action: 'location_settings',
    };
  }

  return {
    key: 'location_services',
    state: 'todo',
    title: 'Location is switched off',
    detail:
      'Switch on location for the whole phone, not just for MBOS. With it off, nothing you do today ' +
      'is recorded anywhere.',
    action: 'location_settings',
  };
}

/**
 * The two permissions, which differ only in what they are for.
 *
 * THE DEAD END IS `denied` PLUS `canAskAgain: false`, and only that.
 * `undetermined` with no ask left is not a thing Android produces, and reading
 * it as a dead end would strand a phone that has simply never been asked.
 *
 * The dead-end row still carries a button to the app's own settings page, and
 * that is not a contradiction of "no pretend buttons": the page genuinely
 * exists and the permission genuinely can be set by hand there. What the
 * sentence adds is the honest part — that MBOS has run out of ways to help,
 * and if he cannot find the switch the answer is the office rather than
 * another tap. The one thing it never offers is a way past.
 */
function permissionItem(
  key: 'foreground' | 'background',
  state: PermissionState,
  canAskAgain: boolean,
): ReadinessItem {
  const title =
    key === 'foreground' ? 'MBOS is allowed to see where you are' : 'MBOS is allowed to follow your day';

  if (state === 'granted') {
    return {
      key,
      state: 'ok',
      title,
      detail:
        key === 'foreground'
          ? 'Allowed.'
          : 'Allowed all the time, so the trail keeps running with the phone in your pocket.',
      action: null,
    };
  }

  if (state === 'denied' && !canAskAgain) {
    return {
      key,
      state: 'dead_end',
      title: key === 'foreground' ? 'Your phone will not ask again' : 'Your phone will not ask again',
      detail:
        (key === 'foreground'
          ? 'Location was refused for MBOS and your phone has stopped offering to ask. '
          : 'Following your day was refused and your phone has stopped offering to ask. ') +
        'Open Settings → Permissions → Location and set it by hand. If you cannot find it, ring the ' +
        'office — MBOS cannot fix this from here, and the day cannot be started until it is fixed.',
      action: 'app_settings',
    };
  }

  return {
    key,
    state: 'todo',
    title: key === 'foreground' ? 'MBOS cannot see where you are' : 'MBOS can only see you while it is open',
    detail:
      key === 'foreground'
        ? 'Tap below and choose Allow when your phone asks.'
        : 'Tap below and choose “Allow all the time”. Anything less and the trail stops the moment ' +
          'you put the phone away.',
    action: 'ask_permission',
  };
}

function batteryItem(i: ReadinessInput): ReadinessItem {
  if (i.batteryExemption === 'exempt') {
    return {
      key: 'battery',
      state: 'ok',
      title: 'The battery saver will leave MBOS alone',
      detail: 'Your phone will let MBOS keep working while it is in your pocket.',
      action: null,
    };
  }

  if (i.batteryExemption === 'optimised') {
    return {
      key: 'battery',
      state: 'todo',
      title: 'The battery saver will stop MBOS',
      detail:
        'Your phone is set to switch MBOS off to save battery. It takes one tap to allow it. Without ' +
        'it, the office stops seeing you a few minutes after you put the phone away.',
      action: 'battery',
    };
  }

  /*
   * `unknown` is iOS, or a query that failed. There is nothing readable and
   * therefore nothing to demand — but it is not a tick either, and the row
   * says so and points at the step below, which is the one that covers the
   * same ground on a phone that will not answer.
   */
  return {
    key: 'battery',
    state: 'unknowable',
    title: 'Could not check the battery saver',
    detail: 'This phone will not tell MBOS what the battery saver is set to. Do the step below as well.',
    action: null,
  };
}

/**
 * The one nobody can read, settled by EVIDENCE.
 *
 * There is no API for autostart on any Android, by anyone, so a tick here
 * could only ever be the app claiming something it cannot know. What CAN be
 * known is what the phone did last time it was asked to work: a day that
 * produced no trail at all is the vivo case, and it is the only evidence there
 * is. So the row is ordinarily an offer — stated, never demanded, because most
 * phones are fine and stopping every salesman over a setting nobody can check
 * would be a gate that fires almost entirely on the innocent — and it becomes
 * a block the moment a worked day comes back empty.
 *
 * "No trail at all" is the test rather than "a thin trail". A handset in a
 * basement godown records little and is working perfectly; one that records
 * NOTHING across a whole worked day has not been throttled, it has been
 * killed.
 *
 * `action` is `autostart` while it blocks, because the first thing to do is go
 * to the setting. The screen pairs that with the `acknowledge` control once he
 * has been sent — the two are one act and the item carries one action, so the
 * ordering lives on the screen where it can watch him come back.
 */
function autostartItem(i: ReadinessInput): ReadinessItem {
  const oem = oemWords(i.manufacturer);
  const where = oem.path + (oem.also ? ' ' + oem.also : '');
  const prev = i.previousWorkedDay;

  const blocking =
    prev != null && !prev.hadTrail && !acknowledgedAfter(prev.day, i.acknowledgedAt, i.nowMs);

  if (blocking) {
    return {
      key: 'autostart',
      state: 'todo',
      title: oem.label,
      detail:
        'Your last working day recorded no movement at all, which is what this setting does when it ' +
        'is off — your phone switched MBOS off behind your back. ' +
        where +
        ' Then tell us you have done it.',
      action: 'autostart',
    };
  }

  return {
    key: 'autostart',
    state: 'unknowable',
    title: oem.label,
    detail:
      'No phone will tell MBOS whether this is switched on, so we cannot tick it for you. It is worth ' +
      'checking once. ' +
      where,
    action: 'autostart',
  };
}

/**
 * The gate.
 *
 * WHAT BLOCKS IS WHAT IS READABLE AND FIXABLE IN SECONDS: location switched
 * off, either permission not granted, and a battery saver that readably says
 * it will stop the app. Each of those is an objective answer from the phone
 * with a button beside it, so refusing the day costs a man half a minute and
 * buys a day that is actually recorded.
 *
 * What does NOT block is anything nobody can read — an autostart setting with
 * no API, a battery query that returned `unknown`, a location query that threw
 * — UNLESS the phone's own last worked day says it went wrong. That is the
 * line the whole engine is drawn on: unverifiable claims never gate a day,
 * evidence does.
 */
export function phoneReadiness(i: ReadinessInput): Readiness {
  const items: ReadinessItem[] = [
    locationServicesItem(i),
    permissionItem('foreground', i.foreground, i.canAskAgain),
    permissionItem('background', i.background, i.canAskAgain),
    batteryItem(i),
    autostartItem(i),
  ];

  const deadEnd = items.some((it) => it.state === 'dead_end');
  /* `unknowable` is deliberately absent from this test and `ok` is deliberately
     not the only thing in it: the gate is "nothing outstanding", not
     "everything ticked", because on most phones two of these five can never be
     ticked by anybody. */
  const mayCheckIn = !items.some((it) => it.state === 'todo' || it.state === 'dead_end');

  return { items, mayCheckIn, deadEnd };
}
