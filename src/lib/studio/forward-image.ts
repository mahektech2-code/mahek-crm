import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { MAX_UPLOAD_BYTES, sniffImageFormat } from "./designs-service";

/* A finished poster is checked on its BYTES — a name is three characters
   anybody can type — and stored exactly as it arrived: it is forwarded
   unchanged, so nothing here redraws it. */

export type FinishedPoster = { bytes: Buffer; format: "png" | "jpeg" | "webp"; width: number; height: number; sha256: string };

const MIN_SIDE = 200;
const MAX_PIXELS = 36_000_000;

export async function checkFinishedPoster(bytes: Buffer): Promise<{ ok: true; data: FinishedPoster } | { ok: false; error: string }> {
  if (bytes.length === 0) return { ok: false, error: "The file is empty." };
  if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, error: `The file is too large (at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` };
  const format = sniffImageFormat(bytes);
  if (!format) return { ok: false, error: "Only JPG, JPEG, PNG or WebP images can be uploaded." };
  try {
    const meta = await sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error", animated: false }).metadata();
    if (meta.format !== format || !meta.width || !meta.height) return { ok: false, error: "Only JPG, JPEG, PNG or WebP images can be uploaded." };
    if ((meta.pages ?? 1) > 1) return { ok: false, error: "Animated images are not supported. Upload a still image." };
    const rotated = (meta.orientation ?? 1) >= 5;
    const width = rotated ? meta.height : meta.width;
    const height = rotated ? meta.width : meta.height;
    if (Math.min(width, height) < MIN_SIDE) return { ok: false, error: `The image is too small (${width} x ${height}). Each side must be at least ${MIN_SIDE} pixels.` };
    return { ok: true, data: { bytes, format, width, height, sha256: createHash("sha256").update(bytes).digest("hex") } };
  } catch {
    return { ok: false, error: "That file could not be read as an image." };
  }
}
