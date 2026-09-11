import * as Location from 'expo-location';
import {
  batteryPercent,
  connectionAnswer,
  permissionAnswer,
  type LocationPermission,
} from '../engines/device-state';

/**
 * ASKING THE PHONE ABOUT ITSELF.
 *
 * The office's team list used to draw "No fix today" for four completely
 * different situations — a refused permission, location switched off on the
 * device, no signal since breakfast, and a flat battery — so a manager had to
 * ring the salesman and ask him to read out his own settings screen. This is
 * the half of that fix that runs on the handset.
 *
 * IT RIDES CHANNELS THAT ARE ALREADY OPEN, and never opens one of its own.
 * The permission report fires when `trail.start()` discovers what the OS
 * actually granted; the battery goes up with the position batch, which is
 * already talking every few minutes while a day is open. A poller of its own
 * would spend the battery in order to report it.
 *
 * NOTHING HERE MAY THROW OR DELAY. Every reading is a courtesy on top of a
 * request that has its own job to do, so each is wrapped and a failure simply
 * omits that field — the same rule attachments follow, where a photograph
 * that would not upload never costs the call it belonged to.
 */

export type DeviceStateReport = {
  locationPermission?: LocationPermission;
  locationServicesEnabled?: boolean;
  connectionType?: 'wifi' | 'cellular' | 'none' | 'unknown';
  batteryPercent?: number;
  batteryCharging?: boolean;
  backgroundSyncRegistered?: boolean;
  /**
   * DURATIONS, not instants, and that is deliberate.
   *
   * The office stamps everything on its own clock because a phone's clock is
   * its owner's to set. These two are facts only this handset holds, so they
   * have to come from here — and seconds-ago survives a clock that is wrong
   * by hours, where an absolute instant would not.
   */
  backgroundSyncLastRunAgoSeconds?: number;
  trackerStalledAgoSeconds?: number;
};

/**
 * What the OS says about location, both scopes and the device switch.
 *
 * `hasServicesEnabledAsync` is a different question from either permission —
 * a salesman can have granted MahekOne everything and still have the phone's
 * own location toggle off, commonly to save battery, and the symptom on the
 * map is identical while the fix is not.
 */
async function locationState(): Promise<Partial<DeviceStateReport>> {
  const out: Partial<DeviceStateReport> = {};
  try {
    const [fg, bg] = await Promise.all([
      Location.getForegroundPermissionsAsync(),
      Location.getBackgroundPermissionsAsync(),
    ]);
    out.locationPermission = permissionAnswer(
      fg.status as never,
      bg.status as never,
    );
  } catch {
    /* Left absent rather than guessed. The office reads a missing field as
       "this build did not say", which is the truth. */
  }
  try {
    out.locationServicesEnabled = await Location.hasServicesEnabledAsync();
  } catch {
    /* As above. */
  }
  return out;
}

/** What it is connected by, if netinfo will say. */
async function connectionState(): Promise<Partial<DeviceStateReport>> {
  try {
    const NetInfo = (await import('@react-native-community/netinfo')).default;
    const s = await NetInfo.fetch();
    return { connectionType: connectionAnswer(s.type, s.isConnected) };
  } catch {
    return {};
  }
}

/**
 * The battery, where the platform will say.
 *
 * Imported lazily like netinfo above, so a build without the native module —
 * or a simulator that does not implement it — costs a caught import rather
 * than a screen that will not start.
 */
async function batteryState(): Promise<Partial<DeviceStateReport>> {
  try {
    const Battery = await import('expo-battery');
    const [level, state] = await Promise.all([
      Battery.getBatteryLevelAsync(),
      Battery.getBatteryStateAsync(),
    ]);
    const percent = batteryPercent(level);
    const out: Partial<DeviceStateReport> = {};
    if (percent !== null) out.batteryPercent = percent;
    /* CHARGING AND FULL ARE BOTH "on charge". 18% climbing needs no phone
       call, and the office draws it differently for exactly that reason. */
    if (state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL) {
      out.batteryCharging = true;
    } else if (state === Battery.BatteryState.UNPLUGGED) {
      out.batteryCharging = false;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Whether the background machinery is alive, as this phone understands it.
 *
 * Cheap — two reads of the local key-value store, no native call and no
 * radio — which is why it rides here rather than being asked for separately.
 */
async function backgroundState(): Promise<Partial<DeviceStateReport>> {
  try {
    const [{ backgroundSyncState }, { stalledAt }] = await Promise.all([
      import('./background-sync-task'),
      import('./trail'),
    ]);
    const [bg, stalled] = await Promise.all([backgroundSyncState(), stalledAt()]);
    const out: Partial<DeviceStateReport> = {};
    if (bg.registered !== null) out.backgroundSyncRegistered = bg.registered;
    const now = Date.now();
    /* A mark in the future is a clock that moved under us, and the honest
       answer to that is to say nothing rather than send a negative the office
       would have to decide what to do with. */
    if (bg.lastRunAt !== null && bg.lastRunAt <= now) {
      out.backgroundSyncLastRunAgoSeconds = Math.round((now - bg.lastRunAt) / 1000);
    }
    if (stalled !== null && stalled <= now) {
      out.trackerStalledAgoSeconds = Math.round((now - stalled) / 1000);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Everything the handset can currently say, gathered in parallel.
 *
 * Parallel because this sits in front of a request somebody is waiting on:
 * three sequential native round trips on a cheap Android handset is a delay
 * a salesman would feel on every position flush.
 */
export async function readDeviceState(): Promise<DeviceStateReport> {
  const parts = await Promise.all([
    locationState(),
    connectionState(),
    batteryState(),
    backgroundState(),
  ]);
  return Object.assign({}, ...parts) as DeviceStateReport;
}
