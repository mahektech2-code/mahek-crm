/* ---------------------------------------------------------------------------
 * A PHOTO IS MADE TO FIT BEFORE IT IS SENT, so nobody on the floor is ever
 * told a picture is too big. The server takes up to 5 MB a file
 * (`attachments.maxSizeMb`); a phone camera hands over 4–12 MB. Each step
 * re-encodes from the ORIGINAL — never a copy of a copy — smaller and lighter
 * until the file is under the target, and the last step is small enough for
 * any photo. An LR stays readable at the first step; only an unusually heavy
 * picture goes further.
 * ------------------------------------------------------------------------- */
import { File } from "expo-file-system";
import * as ImageManipulator from "expo-image-manipulator";
import { Platform } from "react-native";

/** Under this a photo goes as it is. Well inside the server's 5 MB. */
export const UPLOAD_TARGET_BYTES = 1_500_000;

const STEPS = [
  { width: 1800, compress: 0.7 },
  { width: 1500, compress: 0.6 },
  { width: 1200, compress: 0.5 },
  { width: 1000, compress: 0.45 },
];

/** The file's size in bytes, or null where it cannot be read (the browser preview). */
export function photoBytes(uri: string): number | null {
  if (Platform.OS === "web") return null;
  try {
    const n = new File(uri).size;
    return typeof n === "number" && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The photo, re-encoded until it is under the upload target. Never throws: at worst the original. */
export async function fitForUpload(uri: string): Promise<string> {
  const size = photoBytes(uri);
  if (size !== null && size <= UPLOAD_TARGET_BYTES) return uri;
  let best = uri;
  for (const s of STEPS) {
    try {
      const r = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: s.width } }], { compress: s.compress, format: ImageManipulator.SaveFormat.JPEG });
      best = r.uri;
      const n = photoBytes(best);
      if (n === null || n <= UPLOAD_TARGET_BYTES) return best;
    } catch {
      return best;
    }
  }
  return best;
}
