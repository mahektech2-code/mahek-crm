import { requireOptionalNativeModule } from 'expo';

/**
 * The bridge, and nothing else.
 *
 * This file is the native module as it actually is: four calls, every one of
 * which can be absent. Everything a caller should touch — the never-reject
 * promise, the platform guard, the honest nulls — lives one file over in
 * `src/native/tracker-watchdog.ts`. Two files because the thing that can be
 * missing and the thing that is guaranteed to answer are different objects,
 * and a caller importing this one would be importing the half that can be
 * `null`. `phone-setup` next door is the same pattern for the same reason.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule`, which THROWS
 * when the native half is not in the binary. That is not theoretical: the
 * module arrives in a new APK, sideloading has no staged rollout, and a handset
 * in somebody's pocket goes on running the build it has until a person installs
 * the next one. The whole subject of this module is a handset that has stopped
 * recording somebody's day — crashing on the older build would be the worst
 * possible version of it.
 *
 * ANDROID ONLY, and that is not a gap to fill later. The mechanism is
 * WorkManager and the fault is an OEM battery manager killing a foreground
 * service; iOS has neither. On iOS the module is simply `null` and the wrapper
 * answers as it does on any build without it.
 */

export type NativeTrackerWatchdogModule = {
  /** Schedule the periodic check. `periodChanged` forces the stored period to move. */
  start(everyMinutes: number, periodChanged: boolean): Promise<boolean>;
  /** Unschedule it entirely. Sign-out, not check-out — see the Kotlin. */
  stop(): Promise<boolean>;
  /** Mirror the day's state and the nudge policy where a dead process can read them. */
  setTrackingWanted(
    wanted: boolean,
    nudge: boolean,
    nudgeQuietSeconds: number,
  ): Promise<boolean>;
  /** What happened while JavaScript was not running. `-1` means "never". */
  state(): Promise<{ lastRunAgoSeconds: number; revivalsToday: number }>;
};

/** `null` on iOS, on web, and on any build that predates the module. */
export const TrackerWatchdog =
  requireOptionalNativeModule<NativeTrackerWatchdogModule>('MbosTrackerWatchdog');
