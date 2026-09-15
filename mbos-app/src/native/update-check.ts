import { Linking, Platform } from 'react-native';
import * as Application from 'expo-application';
import { BASE } from '../sync/api';
import { updateVerdict, type UpdateVerdict } from '../engines/app-update';

/**
 * ASKING WHETHER THIS HANDSET IS BEHIND.
 *
 * The impure half of `engines/app-update.ts`. It fetches the manifest the
 * release workflow publishes beside the APK and hands both facts to the pure
 * rule, which decides.
 *
 * IT IS A PLAIN STATIC FILE and deliberately not an API route. Caddy serves
 * `/downloads` off the droplet's own disk, the same place the APK itself
 * comes from, so the thing that says "there is a new build" and the thing
 * that IS the new build are published together by one step and cannot drift.
 * A route would also need a session, and the moment a salesman most needs to
 * update is the moment his build is too old to sign in.
 *
 * NOTHING HERE THROWS AND NOTHING HERE BLOCKS. A failed check answers
 * `current`, which draws nothing — the same shape the microphone and the map
 * both use for "cannot, so do not offer".
 */

/** A few seconds. A handset on 2G must not wait on this to open a screen. */
const TIMEOUT_MS = 6_000;

export async function checkForUpdate(): Promise<UpdateVerdict> {
  /* iOS never sideloads, so there is nothing this could offer there. */
  if (Platform.OS !== 'android') return { kind: 'current' };

  const installed = Number(Application.nativeBuildVersion);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    /* Off the API base, so a staging build checks its own droplet rather than
       offering everybody production's APK. `EXPO_PUBLIC_API_BASE` is baked in
       at build time, which is exactly the property wanted here. */
    const response = await fetch(`${BASE}/downloads/mbos.json?at=${Date.now()}`, {
      signal: controller.signal,
      /* Cache-busted in the URL as well: a CDN or a captive portal holding a
         stale manifest would tell a handset it is current for as long as the
         cache lives, and the failure would look exactly like nothing to do. */
      headers: { 'cache-control': 'no-cache' },
    });
    clearTimeout(timer);
    if (!response.ok) return { kind: 'current' };
    return updateVerdict(await response.json(), Number.isFinite(installed) ? installed : null);
  } catch {
    /* No signal, a captive portal, a timeout, HTML where JSON was expected.
       None of it is the salesman's to know about. */
    return { kind: 'current' };
  }
}

/**
 * Hand the download to the browser, which is where an install has to happen.
 *
 * The app cannot install an APK itself — Android refuses that without
 * device-owner enrolment nobody here has — so the honest most it can do is
 * put the file in front of him and let the system installer take over.
 */
export async function openDownload(url: string): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
