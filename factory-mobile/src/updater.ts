import { Linking, Platform } from "react-native";
import Constants from "expo-constants";
import * as IntentLauncher from "expo-intent-launcher";
import { cacheDirectory, createDownloadResumable, deleteAsync, getContentUriAsync } from "expo-file-system/legacy";
import { SITE } from "./api";
import { updateVerdict, type UpdateVerdict } from "./update";

/**
 * THE IMPURE HALF of `update.ts`: read the manifest, and install a new APK
 * without leaving the app.
 *
 * The manifest is the static file the release workflow writes beside the APK
 * (`/downloads/factory.json`), not an API route: the two are published
 * together by one step, and a build too old to sign in can still read it.
 *
 * NOTHING HERE THROWS. A failed check answers `current`, which draws nothing.
 */

const TIMEOUT_MS = 6_000;

/** The versionCode this APK was built with. The release workflow stamps it into app.json before the build. */
export function installedCode(): number | null {
  const code = Number((Constants.expoConfig?.android as { versionCode?: number } | undefined)?.versionCode);
  return Number.isFinite(code) ? code : null;
}

export async function checkForUpdate(): Promise<UpdateVerdict> {
  if (Platform.OS !== "android") return { kind: "current" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const r = await fetch(SITE + "/downloads/factory.json?at=" + Date.now(), { signal: controller.signal, headers: { "cache-control": "no-cache" } });
    clearTimeout(timer);
    if (!r.ok) return { kind: "current" };
    return updateVerdict(await r.json(), installedCode());
  } catch {
    return { kind: "current" };
  }
}

/** One file, overwritten each time, so failed or old downloads never pile up. */
const TARGET = (cacheDirectory ?? "") + "factory-update.apk";
/** Android's flag for "the installer may read this content URI". */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

/**
 * Download the APK inside the app, with progress, then hand it to Android's
 * own installer, which opens over the app. That confirmation page cannot be
 * skipped — only a device owner installs silently — and the first time,
 * Android also asks to allow "Install unknown apps" for Mahek Factory and
 * takes the worker to that switch itself. Nothing saved is lost: the queue and
 * the drafts are on the phone and survive the update.
 *
 * `failed` hands the caller the browser download as the way out.
 */
export async function downloadAndInstall(url: string, onProgress: (fraction: number) => void): Promise<"installer" | "failed"> {
  if (Platform.OS !== "android") return "failed";
  try {
    await deleteAsync(TARGET, { idempotent: true });
    const task = createDownloadResumable(url, TARGET, {}, (p) => {
      if (p.totalBytesExpectedToWrite > 0) onProgress(p.totalBytesWritten / p.totalBytesExpectedToWrite);
    });
    const done = await task.downloadAsync();
    if (!done || done.status !== 200) return "failed";
    onProgress(1);
    const data = await getContentUriAsync(done.uri);
    await IntentLauncher.startActivityAsync("android.intent.action.VIEW", { data, type: "application/vnd.android.package-archive", flags: FLAG_GRANT_READ_URI_PERMISSION });
    return "installer";
  } catch {
    return "failed";
  }
}

/** The fallback: the browser downloads it and the notification installs it. */
export async function openInBrowser(url: string): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
