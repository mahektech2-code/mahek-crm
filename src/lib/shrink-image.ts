/* ---------------------------------------------------------------------------
 * A PICTURE IS MADE TO FIT BEFORE IT IS UPLOADED, in the browser, so nobody is
 * ever told a photo is too big. The server takes up to `attachments.maxSizeMb`
 * (5 MB by default) a file, and a tablet or phone camera hands over 4–12 MB.
 *
 * Anything that is not a picture the browser can draw (a PDF, a video, HEIC on
 * a desktop browser) goes exactly as it was picked, and so does a picture
 * already under the target — this only ever makes a file smaller. Each step
 * re-draws the ORIGINAL, never a copy of a copy.
 * ------------------------------------------------------------------------- */

/** Under this a picture goes as it is. Well inside the server's 5 MB. */
export const UPLOAD_TARGET_BYTES = 1_500_000;

const STEPS = [
  { edge: 2000, quality: 0.78 },
  { edge: 1600, quality: 0.68 },
  { edge: 1280, quality: 0.6 },
  { edge: 1024, quality: 0.5 },
];

const DRAWABLE = /^image\/(jpeg|jpg|png|webp)$/i;

function blobOf(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((done) => canvas.toBlob((b) => done(b), "image/jpeg", quality));
}

/** The file, re-encoded as JPEG until it is under the target. Never throws: at worst the original. */
export async function shrinkImage(file: File): Promise<File> {
  if (file.size <= UPLOAD_TARGET_BYTES || !DRAWABLE.test(file.type) || typeof document === "undefined") return file;
  try {
    const bitmap = await createImageBitmap(file);
    let best: File = file;
    for (const s of STEPS) {
      const scale = Math.min(1, s.edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      /* A transparent PNG has nothing behind it once it is a JPEG: white, not black. */
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await blobOf(canvas, s.quality);
      if (!blob) break;
      best = new File([blob], file.name.replace(/\.(png|webp|jpe?g)$/i, "") + ".jpg", { type: "image/jpeg", lastModified: file.lastModified });
      if (blob.size <= UPLOAD_TARGET_BYTES) break;
    }
    bitmap.close?.();
    return best.size < file.size ? best : file;
  } catch {
    return file;
  }
}
