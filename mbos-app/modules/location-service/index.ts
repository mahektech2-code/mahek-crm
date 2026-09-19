import { requireOptionalNativeModule } from 'expo';

/**
 * The bridge, and nothing else.
 *
 * This file is the native module as it actually is: seven functions, any of
 * which can be absent. Everything a caller should touch — the never-reject
 * promises, the platform guard, the `null` that means "this build has nothing
 * to say" — lives one file over in `src/native/location-service.ts`. Two files
 * because the thing that can be missing and the thing that is guaranteed to
 * answer are different objects, and `sync/trail.ts` importing this one would
 * be importing the half that can be `null`.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule`, which
 * THROWS when the native half is not in the binary. That is not theoretical:
 * the module arrives in a new APK, sideloading has no staged rollout, and a
 * handset in somebody's pocket runs the build it has until a person installs
 * the next one. `trail.ts` runs at module scope on every start of the app —
 * throwing there would not degrade the trail, it would stop MBOS opening.
 *
 * ANDROID ONLY. `expo-module.config.json` declares no apple platform, so this
 * is `null` on iOS by construction rather than by a check somebody has to
 * remember to write. The trail's expo-location path is untouched and is what
 * an iOS handset would still run — there is no iOS field force today, and the
 * honest reason this is Android-only is that the bug it fixes is a specific
 * line in expo-location's Android consumer plus the OEM battery managers on
 * these specific phones.
 */

export type NativeFix = {
  id: string;
  /** Epoch milliseconds, as the PROVIDER stamped the reading. */
  at: number;
  lat: number;
  lng: number;
  accuracyM: number | null;
};

export type NativeServiceState = {
  running: boolean;
  wanted: boolean;
  /** Is the SERVICE the one posting positions? See `chooseSender`. */
  uploads: boolean;
  /** `-1` for "nothing to say" — never a duration. See the module's own note. */
  lastUploadAgoSeconds: number;
  /** `-1` for "nothing to say" — never a duration. See the module's own note. */
  lastFixAgoSeconds: number;
  buffered: number;
  startsToday: number;
  lastRefusalAgoSeconds: number;
  lastRefusal: string | null;
};

export type NativeLocationServiceModule = {
  start(
    askEverySeconds: number,
    keepEverySeconds: number,
    bufferCap: number,
    wantedForSeconds: number,
    watchdogMinutes: number,
    periodChanged: boolean,
    /** 0 means the service does not post at all and the app does. */
    uploadEverySeconds: number,
    retentionDays: number,
  ): Promise<boolean>;
  /**
   * The credential the service posts with, mirrored where a dead bundle cannot
   * be asked for it. All four empty is a sign-out.
   */
  credentials(
    baseUrl: string,
    deviceId: string,
    accessToken: string,
    refreshToken: string,
  ): Promise<boolean>;
  touch(wantedForSeconds: number): Promise<boolean>;
  stop(): Promise<boolean>;
  release(): Promise<boolean>;
  state(): Promise<NativeServiceState>;
  drain(limit: number): Promise<NativeFix[]>;
  forget(ids: string[]): Promise<boolean>;
};

/** `null` on iOS, on web, and on any build that predates the module. */
export const LocationService =
  requireOptionalNativeModule<NativeLocationServiceModule>('MbosLocationService');
