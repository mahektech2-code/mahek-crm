import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { cacheDirectory, copyAsync, deleteAsync, getInfoAsync, makeDirectoryAsync } from 'expo-file-system/legacy';

/**
 * SEND A FILE TO SOMEBODY — the phone's own share sheet, with the file in it.
 *
 * A price list is shown to a customer and then, nine times out of ten, he
 * asks for it on WhatsApp. "Open in another app" could get it there only on a
 * phone whose PDF viewer happened to have a share button. This hands the FILE
 * itself to Android's chooser, so WhatsApp, Gmail, Bluetooth or anything else
 * the phone has receives a real attachment.
 *
 * It cannot be done with what the app already carried. React Native's `Share`
 * sends text only on Android, and `expo-intent-launcher` puts every extra in
 * as a STRING — a share target reads the attachment as a URI and ignores a
 * string, so the message would arrive with nothing on it. `expo-sharing` grants
 * the content URI properly, through its own FileProvider.
 *
 * **It is loaded only where its native half exists**, the way `expo-haptics`
 * is in `components/ui/feedback.ts`: the JavaScript reaches older APKs over
 * the air, `expo-sharing` has no native half in them, and importing it there
 * would throw. On those builds `shareAvailable` is false and the button is not
 * drawn at all — a control that fails when pressed is worse than one never
 * offered — and "Open in another app" is still there.
 *
 * **It goes out under its title.** The file on the phone is named after the
 * attachment it came from, which is all the receiver would see in the chat;
 * a copy named by `shareFileName` goes instead, in the cache, under a folder
 * of its own that is emptied before each share so copies never pile up.
 */

export const shareAvailable = Platform.OS === 'android' && requireOptionalNativeModule('ExpoSharing') != null;

type SharingModule = typeof import('expo-sharing');
let sharing: Promise<SharingModule | null> | null = null;

function loadSharing(): Promise<SharingModule | null> {
  if (!sharing) {
    sharing = shareAvailable ? import('expo-sharing').catch(() => null) : Promise.resolve(null);
  }
  return sharing;
}

export type ShareAnswer = { ok: true } | { ok: false; reason: string };

export async function shareFile(args: {
  /** The downloaded file, a `file://` path. */
  uri: string;
  /** What it is called when it arrives — see `shareFileName`. */
  name: string;
  mediaType: string;
  /** The heading of Android's chooser. */
  dialogTitle: string;
}): Promise<ShareAnswer> {
  const lib = await loadSharing();
  if (!lib) return { ok: false, reason: 'This version of the app cannot share files. Open it in another app instead.' };
  try {
    const info = await getInfoAsync(args.uri);
    if (!info.exists) return { ok: false, reason: 'The file is no longer on this phone. Download it again.' };

    let out = args.uri;
    if (cacheDirectory) {
      const dir = cacheDirectory + 'mbos-share/';
      await deleteAsync(dir, { idempotent: true });
      await makeDirectoryAsync(dir, { intermediates: true });
      out = dir + encodeURIComponent(args.name);
      await copyAsync({ from: args.uri, to: out });
    }

    await lib.shareAsync(out, { mimeType: args.mediaType, dialogTitle: args.dialogTitle });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'The file could not be shared. Try again, or open it in another app.' };
  }
}
