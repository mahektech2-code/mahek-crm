import * as Updates from 'expo-updates';

/**
 * Picking up a new build without anybody reinstalling anything.
 *
 * Every code change to this app — a screen, a sentence, an engine rule — used
 * to cost an APK: a 111 MB file, built by hand, sideloaded by every salesman.
 * That price is why the small faults sat in it for months. Nobody cuts a
 * release to fix a button that raises the wrong toast. `expo-updates` is what
 * makes that fix worth shipping.
 *
 * WHAT IT CAN AND CANNOT SHIP, because getting this wrong is how an app is
 * bricked in the field:
 *
 *   JavaScript, assets, copy, engine rules — yes. That is nearly everything.
 *
 *   Anything NATIVE — a new native module, a permission, an SDK bump, the
 *   `EXPO_PUBLIC_API_BASE` that is inlined at build time — no, ever. Those
 *   need a real APK, and pushing JS that expects them to a build that has
 *   them not is exactly how a handset stops opening.
 *
 * `runtimeVersion` is what enforces that boundary, and it is set to the
 * `fingerprint` policy rather than `appVersion` deliberately. `appVersion`
 * would read `1.0.0` — a number this project has never once bumped — so every
 * native change would silently keep the same runtime and OTA would happily
 * push JS to a build that cannot run it. A fingerprint hashes the native
 * project itself, so it changes when the native side changes, whether or not
 * anybody remembered.
 *
 * IT NEVER DELAYS A LAUNCH. `fallbackToCacheTimeout: 0` and this function is
 * not awaited by anything: the app opens on the bundle it already has and the
 * new one is fetched behind it, ready for the NEXT launch. A salesman opening
 * the app at a shop door must not wait on a download over 2G — the whole app
 * is built around never blocking him on the network, and an update check is
 * not the place to break that rule.
 *
 * And it is inert until somebody runs `eas init`: `updates.enabled` is false
 * in `app.json` until that writes the URL, so `Updates.isEnabled` is false and
 * this returns immediately. An update channel pointed at nothing is worse than
 * no update channel — it fails on every launch, in the background, silently.
 */
export async function fetchUpdateInBackground(): Promise<'none' | 'ready' | 'off' | 'failed'> {
  /* False in development, and false in a build made before `eas init`. */
  if (!Updates.isEnabled) return 'off';

  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return 'none';

    await Updates.fetchUpdateAsync();
    /* Deliberately NOT `reloadAsync()`. Restarting the app under somebody
       mid-visit — with a half-filled order form on screen — would lose work to
       deliver a cosmetic change. It is already downloaded; the next time he
       opens the app it is what runs. */
    return 'ready';
  } catch {
    /* No signal, the update server down, a bundle that will not verify. The
       app is running perfectly on the bundle it has, and there is nothing for
       the salesman to do about any of it. */
    return 'failed';
  }
}

/** What is actually running, for the Sync screen to print. */
export function runningBuild(): { id: string; embedded: boolean; channel: string | null } {
  return {
    id: Updates.updateId ?? 'embedded',
    embedded: Updates.isEmbeddedLaunch,
    channel: Updates.channel ?? null,
  };
}
