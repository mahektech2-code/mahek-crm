import * as Updates from 'expo-updates';
import * as Application from 'expo-application';

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
/**
 * When this JavaScript started running — the cold start, in effect. Read at
 * module load, so it answers "how long has this process been alive" rather
 * than "how long has some screen been open".
 */
const LOADED_AT = Date.now();

/**
 * How long after a cold start an update may still be applied on the spot.
 *
 * Inside this window he is looking at the home screen the app has just drawn
 * and has not typed anything, so reloading onto the new bundle costs him a
 * blink. Past it he may be half-way through an order, and the update waits for
 * the next launch exactly as it always did. Without this every fix took TWO
 * launches to arrive — one to download, one to run — and on Android, where
 * "opening the app" is usually resuming it, that was days.
 */
const APPLY_WINDOW_MS = 10_000;

export async function fetchUpdateInBackground(): Promise<'none' | 'ready' | 'applied' | 'off' | 'failed'> {
  /* False in development, and false in a build made before `eas init`. */
  if (!Updates.isEnabled) return 'off';

  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return 'none';

    await Updates.fetchUpdateAsync();
    /* Applied NOW only while the app has barely opened — see APPLY_WINDOW_MS.
       Any later and it is deliberately not `reloadAsync()`: restarting the app
       under somebody mid-visit, with a half-filled order form on screen, would
       lose work to deliver the change. It is already downloaded; the next time
       he opens the app it is what runs. Every saved record is in SQLite, so a
       reload inside the window loses nothing. */
    if (Date.now() - LOADED_AT <= APPLY_WINDOW_MS) {
      await Updates.reloadAsync();
      return 'applied';
    }
    return 'ready';
  } catch {
    /* No signal, the update server down, a bundle that will not verify. The
       app is running perfectly on the bundle it has, and there is nothing for
       the salesman to do about any of it. */
    return 'failed';
  }
}

/**
 * CAN THIS BUILD RESTART ITSELF? Asked before a button is drawn, never after
 * it is pressed.
 *
 * `reloadAsync` REJECTS in development, in Expo Go, and on any build where
 * `updates.enabled` is false — which is every build made before `eas init`
 * wrote the URL. A restart button drawn on one of those is a button that
 * appears to do nothing, which is the mistake the microphone made and
 * AGENTS.md records: a control that fails when pressed is worse than one never
 * offered. So the screen asks this first and prints the manual instruction
 * instead where the answer is no — closing the app by hand reaches the same
 * place, it just takes a sentence to say.
 */
export function canRestart(): boolean {
  return Updates.isEnabled;
}

/**
 * Restart MahekOne, because a setting the phone reads at startup has changed.
 *
 * THE ONE PLACE THIS IS A REMEDY is a day recording at the foreground floor
 * after the OEM switches have been changed under it —
 * `engines/oem-keepalive.ts` holds that rule and the reason. Everywhere else a
 * restart costs somebody a half-typed order and buys nothing.
 *
 * It is NOT the same act as `fetchUpdateInBackground`, which deliberately does
 * not reload: that one would restart the app under somebody mid-visit to
 * deliver a cosmetic change. This one is a button he pressed, on a screen that
 * says what it does, with nothing else on it to lose — and it picks up any
 * bundle already downloaded as a side effect rather than as its purpose.
 *
 * NOTHING IS LOST BY IT. Every record on this handset is in SQLite and the
 * outbox survives a restart by design, which is the whole reason the app can
 * be reaped on the road. The screen says so, because "restart" is a word people
 * have learned to be frightened of.
 *
 * `false` means it did not happen and the caller must say so. The promise
 * resolves immediately BEFORE the reload is posted to the main thread, so
 * `true` means the instruction went in — there is nothing after it to observe,
 * and no code here may assume it runs.
 */
export async function restartApp(): Promise<boolean> {
  if (!canRestart()) return false;
  try {
    await Updates.reloadAsync();
    return true;
  } catch {
    /* A module installed wrongly, or a runtime that has no reference to reload.
       Either way the honest answer is the manual one, and the screen has it. */
    return false;
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

/**
 * Which build this handset is actually running.
 *
 * The server has had an `app_version` column on `mbos_devices` since MBOS
 * shipped and the login has always accepted one; the handset has never sent
 * it, so every device row reads blank. That is the column somebody needs the
 * moment anything is wrong in the field — "is this the bug we fixed, or has
 * that fix not reached him" is unanswerable without it, and the answer decides
 * whether the next hour is spent debugging or distributing.
 *
 * It carries BOTH halves because there are two, and since `expo-updates` they
 * move independently. The native version is what an APK install pins; the
 * update id is which JavaScript bundle is running on top of it, and that is
 * what changes when a fix ships over the air. The native half read `1.0.0` on
 * every handset for the whole first year, because nothing bumped it until the
 * check-in radius made "which build is he on" a question somebody had to
 * answer at a shop door; DEPLOY.md now makes the bump part of releasing. It is
 * still a number a person moves by hand, which is exactly why `runtimeVersion`
 * uses the fingerprint policy rather than the version.
 *
 * `embedded` is a build running the bundle it shipped with — no update has
 * been applied yet — and is worth naming rather than leaving blank, because
 * blank is what this column already said for a year and it meant "nobody
 * asked".
 */
export function buildLabel(): string {
  const native = [
    Application.nativeApplicationVersion ?? '?',
    Application.nativeBuildVersion ? `(${Application.nativeBuildVersion})` : null,
  ]
    .filter(Boolean)
    .join(' ');

  /* Not the words "no update channel": `schema-usage.test.ts` greps this
     project for SQL, and that phrase reads as `UPDATE channel` to it. A guard
     that scans prose for statements is worth more than the phrasing. */
  if (!Updates.isEnabled) return `${native} · updates off`;
  /* `updateId` is null on the bundle that came with the APK. */
  const bundle = Updates.updateId ? Updates.updateId.slice(0, 8) : 'embedded';
  return `${native} · ${bundle}`;
}
