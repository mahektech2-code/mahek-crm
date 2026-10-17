import { Platform } from 'react-native';
import * as Application from 'expo-application';
import * as IntentLauncher from 'expo-intent-launcher';
import { cacheDirectory, createDownloadResumable, deleteAsync, getContentUriAsync } from 'expo-file-system/legacy';
import { openDownload } from './update-check';

/**
 * A NEW APK, DOWNLOADED INSIDE THE APP AND HANDED TO ANDROID'S INSTALLER.
 *
 * The Sync screen's update card used to open the browser, which downloads the
 * file into a notification shade the salesman then has to find, tap and
 * install from — three steps nobody explained, on the screen least suited to
 * explaining them. This keeps the download in the app, with progress on the
 * screen, and ends on Android's own "Do you want to install this update?"
 * page.
 *
 * THAT LAST PAGE CANNOT BE SKIPPED, and nothing here pretends otherwise. A
 * sideloaded app may only be installed silently by a device owner, which no
 * handset here is enrolled as. The first time, Android also asks him to allow
 * "Install unknown apps" for Mahek MBOS; it sends him to that switch itself.
 *
 * IT NEEDS `REQUEST_INSTALL_PACKAGES`, which is a manifest permission — native,
 * so it arrives only with an APK, never over the air. A build without it hands
 * Android an install it refuses with nowhere to switch it on. So the in-app
 * path is gated on the build that first carried the permission, and every
 * older build keeps the browser download it already had.
 */
export const IN_APP_INSTALL_FROM_VERSION_CODE = 20;

export function canInstallInApp(): boolean {
  if (Platform.OS !== 'android') return false;
  const code = Number(Application.nativeBuildVersion);
  return Number.isFinite(code) && code >= IN_APP_INSTALL_FROM_VERSION_CODE;
}

/** One file, overwritten each time, so failed or old downloads never pile up. */
const TARGET = `${cacheDirectory ?? ''}mbos-update.apk`;

/** Android's flag for "the installer may read this content URI". */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

export type InstallResult = 'installer' | 'browser' | 'failed';

/**
 * Download, then open the installer. `onProgress` gets 0–1.
 *
 * On an older build this opens the browser instead and answers `browser`, so
 * the caller can say what happened rather than show a progress bar that will
 * never move.
 */
export async function downloadAndInstall(url: string, onProgress: (fraction: number) => void): Promise<InstallResult> {
  if (!canInstallInApp()) return (await openDownload(url)) ? 'browser' : 'failed';
  try {
    await deleteAsync(TARGET, { idempotent: true });
    const task = createDownloadResumable(url, TARGET, {}, (p) => {
      if (p.totalBytesExpectedToWrite > 0) onProgress(p.totalBytesWritten / p.totalBytesExpectedToWrite);
    });
    const done = await task.downloadAsync();
    if (!done || done.status !== 200) return 'failed';
    onProgress(1);
    const contentUri = await getContentUriAsync(done.uri);
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: 'application/vnd.android.package-archive',
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
    return 'installer';
  } catch {
    return 'failed';
  }
}
