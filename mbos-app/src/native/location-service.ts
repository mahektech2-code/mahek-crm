import { Platform } from 'react-native';
import {
  LocationService,
  type NativeFix,
  type NativeServiceState,
} from '../../modules/location-service';
import { agoOrNull, countOrNull } from '../engines/capture';

/**
 * THE HALF THAT IS GUARANTEED TO ANSWER.
 *
 * `modules/location-service/index.ts` is the native module as it actually is —
 * six functions on an object that can be `null`. This is what the rest of the
 * app may touch: every call resolves, every call is a no-op on a build or a
 * platform without the module, and nothing here throws. Two files for the
 * reason `native/phone-setup.ts` gives beside it, and the reason is sharper
 * here: the caller is `sync/trail.ts`, which runs at module scope on every
 * start of the app. A throw there would not degrade the trail, it would stop
 * MBOS opening.
 *
 * **ABSENT IS NOT BROKEN.** `available()` false means this APK predates the
 * module or is running on iOS, and the trail falls back to the expo task
 * exactly as it did before — `chooseCapture` is where that is decided and this
 * file only reports.
 */

const on = Platform.OS === 'android' && LocationService != null;

export function available(): boolean {
  return on;
}

export type ServiceState = {
  /** Is our foreground service up, as this process can tell. */
  running: boolean;
  /** Does the handset still believe the office wants tracking? */
  wanted: boolean;
  /**
   * IS THE SERVICE THE ONE SENDING? `chooseSender` is the rule; this is the
   * fact. False covers the office switching it off, a handset with no usable
   * credential, a service that is not running and a day that has ended — four
   * different reasons with one consequence, which is that the app has to drain
   * the buffer itself.
   */
  uploads: boolean;
  /** Seconds since the service last had a batch accepted. Null: never. */
  lastUploadAgoSeconds: number | null;
  /** Seconds since the last fix the SERVICE took. Null: it has never taken one. */
  lastFixAgoSeconds: number | null;
  /** Fixes held natively and not yet in `positions`. Null: cannot say. */
  buffered: number | null;
  /** Times the service has had to be started today. Null: cannot say. */
  startsToday: number | null;
  /** Seconds since the platform last refused a start. Null: it never has. */
  lastRefusalAgoSeconds: number | null;
  /** What the refusal was, in the native side's own words. */
  lastRefusal: string | null;
};

/** Nothing known, in the shape every caller already handles. */
const NOTHING: ServiceState = {
  running: false,
  wanted: false,
  /* FALSE, so a build with no service in it reads as "the app is sending" —
     which is exactly what it is. */
  uploads: false,
  lastUploadAgoSeconds: null,
  lastFixAgoSeconds: null,
  buffered: null,
  startsToday: null,
  lastRefusalAgoSeconds: null,
  lastRefusal: null,
};

export type StartOptions = {
  askEverySeconds: number;
  keepEverySeconds: number;
  bufferCap: number;
  /**
   * How long the handset may go on recording before JavaScript has to say so
   * again. See `trackingDeadlineSeconds` — this is the only thing that ends a
   * day which had no check-out.
   */
  wantedForSeconds: number;
  watchdogMinutes: number;
  /**
   * How often the SERVICE posts what it has taken, which is a different
   * question from how often it takes one. ZERO means it does not post at all
   * and the app does — the escape hatch, reachable from the Admin Console
   * rather than from a sideloaded APK.
   */
  uploadEverySeconds: number;
  /** How long a fix the server cannot yet file is kept. See `retentionMs`. */
  retentionDays: number;
  /**
   * TRUE ONLY ON THE CALL WHERE THE OFFICE'S NUMBER CHANGED.
   *
   * WorkManager's `UPDATE` policy resets a periodic job's period, so passing
   * true on every start would push the next run out for ever on a handset
   * whose app is opened every ten minutes — a `setInterval` cleared on every
   * resume, arriving inside the one scheduler that was supposed to be immune
   * to it. The caller remembers the number it last used and passes true once.
   */
  periodChanged: boolean;
};

/** Start following, and say for how long. Answers whether the service started. */
export async function startService(opts: StartOptions): Promise<boolean> {
  if (!on) return false;
  try {
    return await LocationService!.start(
      opts.askEverySeconds,
      opts.keepEverySeconds,
      opts.bufferCap,
      opts.wantedForSeconds,
      opts.watchdogMinutes,
      opts.periodChanged,
      opts.uploadEverySeconds,
      opts.retentionDays,
    );
  } catch {
    /* The native half answers rather than throwing, so reaching this is the
       bridge itself failing — a module removed from the binary under a running
       JS bundle, which happens on an over-the-air update. Falling back is the
       same answer as a refused start. */
    return false;
  }
}

/**
 * WHAT THE SERVICE SIGNS ITS POSTS WITH, handed over rather than fetched.
 *
 * The service cannot read `expo-secure-store` — that is another package's
 * cipher and another package's keystore alias, and being wrong about either
 * inside a background service on a phone that cannot be recalled is not a
 * thing to build. So the app mirrors the pair across, on every sign-in, every
 * refresh and every start.
 *
 * Empty strings are a SIGN-OUT and clear the mirror. Passing them is how
 * `clearTokens` reaches the native side.
 */
export async function setServiceCredentials(args: {
  baseUrl: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
}): Promise<void> {
  if (!on) return;
  try {
    await LocationService!.credentials(
      args.baseUrl,
      args.deviceId,
      args.accessToken,
      args.refreshToken,
    );
  } catch {
    /* The uploader then holds whatever it had. An access token it can no
       longer refresh blocks it, `uploads` goes false, and the app takes the
       queue back — which is the same outcome as this build having no service
       at all, and is why nothing here is worth reporting. */
  }
}

/** The day is still open. Cheap enough to ride every sync pass. */
export async function touchService(wantedForSeconds: number): Promise<void> {
  if (!on) return;
  try {
    await LocationService!.touch(wantedForSeconds);
  } catch {
    /* As above. A deadline that was not pushed out expires, which stops
       tracking — the safe direction, and the watchdog's next `start` puts it
       back. */
  }
}

/** The check-out. */
export async function stopService(): Promise<void> {
  if (!on) return;
  try {
    await LocationService!.stop();
  } catch {
    /* The service reads the deadline on every fix, so a stop that did not
       land still ends within the hour rather than never. */
  }
}

/** Sign-out: stop, and stop waking up as well. */
export async function releaseService(): Promise<void> {
  if (!on) return;
  try {
    await LocationService!.release();
  } catch {
    /* Nothing further to try. */
  }
}

/** What happened while JavaScript was not running. Never throws. */
export async function serviceState(): Promise<ServiceState> {
  if (!on) return NOTHING;
  try {
    const raw: NativeServiceState = await LocationService!.state();
    return {
      running: raw.running === true,
      wanted: raw.wanted === true,
      uploads: raw.uploads === true,
      lastUploadAgoSeconds: agoOrNull(raw.lastUploadAgoSeconds),
      lastFixAgoSeconds: agoOrNull(raw.lastFixAgoSeconds),
      buffered: countOrNull(raw.buffered),
      startsToday: countOrNull(raw.startsToday),
      lastRefusalAgoSeconds: agoOrNull(raw.lastRefusalAgoSeconds),
      lastRefusal: raw.lastRefusal ?? null,
    };
  } catch {
    return NOTHING;
  }
}

/**
 * Take a page of fixes off the native buffer — AND DELETE NOTHING.
 *
 * The second half is `forgetFixes`, called once the rows are in `positions`.
 * `FixStore` carries the whole argument: deleting on read saves one round trip
 * and costs a morning of somebody's route to any kill between the read and the
 * insert, while a repeat costs nothing at all because the id of a position is
 * its own reading.
 */
export async function drainFixes(limit: number): Promise<NativeFix[]> {
  if (!on) return [];
  try {
    const rows = await LocationService!.drain(limit);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** These reached `positions`. Answers whether the native side agreed. */
export async function forgetFixes(ids: string[]): Promise<boolean> {
  if (!on || ids.length === 0) return true;
  try {
    return await LocationService!.forget(ids);
  } catch {
    /* They stay in the buffer and are drained again, which the conflict-ignore
       insert makes free. A buffer that grows for ever is the failure this
       could cause, and `FixStore`'s cap is what stops it. */
    return false;
  }
}

export type { NativeFix };
