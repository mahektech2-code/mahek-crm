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
  /**
   * `null` means THIS HANDSET HAS NO SUCH MARK — the condition is over, or
   * never happened — and the server clears the column on it. Omitted still
   * means "I cannot say", which leaves the stored value alone. Those are
   * different facts and they used to arrive identically; see the note at the
   * `else if` that sets them.
   */
  backgroundSyncLastRunAgoSeconds?: number | null;
  trackerStalledAgoSeconds?: number | null;
  /**
   * WHEN THE ONE MECHANISM THAT OUTLIVES THIS APP LAST RAN.
   *
   * `backgroundSyncLastRunAgoSeconds` above says the same thing about the
   * expo-background-task job, and the two are not the same fact: that one runs
   * by booting the whole JavaScript bundle, so its silence can mean the bundle
   * would not start. This is a native WorkManager worker that touches no
   * bundle, so its silence means only one thing — the OEM has stopped honouring
   * WorkManager for this app at all, which is a support call of its own and one
   * nothing could previously make.
   *
   * `null` clears the column and absent leaves it alone, the same distinction
   * the two above keep.
   */
  trackerWatchdogLastRunAgoSeconds?: number | null;
  /**
   * How many times the tracker has had to be revived today.
   *
   * The handset's own restarts plus the native watchdog's, added together,
   * because a manager is asking one question and which of our two mechanisms
   * did it is a fact about our code. ZERO IS A REAL ANSWER and the healthy one
   * — so, like `queuedPositions` and unlike the marks above, absence here means
   * only that this build cannot say.
   */
  trackerRestartsToday?: number;
  /**
   * Unsent fixes still on this phone. ZERO IS A REAL ANSWER and the common one
   * — the handset is clear — so unlike the two marks above, absence here means
   * only that this build cannot say, and is never read as nothing waiting.
   */
  queuedPositions?: number;
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
    const [{ backgroundSyncState }, { stalledAt, restartsTodayCount }, { watchdogState }] =
      await Promise.all([
        import('./background-sync-task'),
        import('./trail'),
        import('../native/tracker-watchdog'),
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
    } else if (bg.lastRunAt === null) {
      /* EXPLICIT NULL, and the distinction is the whole of the fix below. */
      out.backgroundSyncLastRunAgoSeconds = null;
    }
    /* HOW FAR BEHIND WE ARE, which is the question a manager is really asking
       — not "is he tracking" but "is his day going to reach me". Counted here
       rather than on the server because only the phone knows: the queue is
       local by design, which is what makes a lost connection cost nothing. */
    try {
      const { queueDepth } = await import('./trail');
      out.queuedPositions = await queueDepth();
    } catch {
      /* A count is worth nothing against a report failing to go at all. The
         field is left absent, which the server reads as "cannot say" rather
         than as a clear queue. */
    }
    if (stalled !== null && stalled <= now) {
      out.trackerStalledAgoSeconds = Math.round((now - stalled) / 1000);
    } else if (stalled === null) {
      /*
       * "THERE IS NO STALL" IS AN ANSWER, AND IT COULD NOT BE GIVEN.
       *
       * The key used to be omitted here, and the server treats an omitted key
       * as "leave the column alone" — deliberately, so an old build posting
       * its one boolean cannot wipe the richer answers a newer one gave. That
       * rule collapses two different absences into one: "my build cannot
       * report this" and "this condition is over" both arrived as silence, and
       * only the first of them wants the old value kept.
       *
       * So a stall mark, once written, could never be cleared. It survived the
       * tracker recovering, it survived an uninstall — a handset that had just
       * been reinstalled and was fixing to three metres every three seconds
       * sent nothing for this field, and the office went on reading "his phone
       * stopped the tracker" from a timestamp belonging to a previous
       * installation. Two standing false alarms on a healthy phone, on the one
       * panel whose whole discipline is that a healthy phone says nothing.
       *
       * `null` is distinguishable from absent in JSON, so this is the one shape
       * that says it without taking the protection away: the server clears on
       * an explicit null and still keeps the column where the key never came.
       */
      out.trackerStalledAgoSeconds = null;
    }

    /*
     * WHAT HAPPENED WHILE THIS RUNTIME WAS NOT RUNNING.
     *
     * Read through the native bridge, which never throws and answers `null`
     * where it cannot say — an iOS build, an APK from before the module, or an
     * OEM that refused to schedule the work. That last one is the reading worth
     * having, and it arrives as silence rather than as an error, exactly as a
     * handset with no signal does: the mark simply stops moving.
     *
     * `-1` never leaves `native/tracker-watchdog.ts`, so nothing here has to
     * know that a negative was ever a word. The server refuses a negative
     * duration rather than clamping it, correctly, and it should never be asked
     * to see one.
     */
    try {
      const watchdog = await watchdogState();
      if (watchdog.lastRunAgoSeconds !== null) {
        out.trackerWatchdogLastRunAgoSeconds = watchdog.lastRunAgoSeconds;
      } else {
        /* EXPLICIT NULL for the same reason `trackerStalledAgoSeconds` sends
           one: a handset that was reinstalled, or whose watchdog was
           deliberately unscheduled at sign-out, has to be able to say the mark
           is gone. An omitted key leaves a stale timestamp on the office's
           screen for ever, which on this panel reads as a fault that has been
           fixed and never cleared. */
        out.trackerWatchdogLastRunAgoSeconds = null;
      }
      const revivals = await restartsTodayCount();
      if (revivals !== null) out.trackerRestartsToday = revivals;
    } catch {
      /* Both left absent, which the office reads as "this build did not say"
         rather than as a healthy phone. */
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
