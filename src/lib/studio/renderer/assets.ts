import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Box } from "@/lib/studio/domain/template";
import { RenderError } from "./errors";

// Approved images (logo, product pack) are LOCAL files only: no remote URLs, with size limits so a
// bad or oversized file is rejected instead of exhausting memory.
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_ASSET_PIXELS = 4096 * 4096;

export type PlacedImage = { input: Buffer; left: number; top: number };

/** Loads an image file and fits it into `box` ("contain" keeps the whole image, "cover" fills the box). */
export async function loadImageForBox(assetPath: string, box: Box, fit: "contain" | "cover", subject: string): Promise<PlacedImage> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(assetPath) || !path.isAbsolute(assetPath)) {
    throw new RenderError("AssetMissing", `asset must be an absolute local file path: ${assetPath}`, subject);
  }
  let size: number;
  try {
    size = (await fs.stat(assetPath)).size;
  } catch {
    throw new RenderError("AssetMissing", `asset file is missing: ${assetPath}`, subject);
  }
  if (size > MAX_ASSET_BYTES) throw new RenderError("AssetMissing", `asset file is too large (${size} bytes): ${assetPath}`, subject);

  try {
    const meta = await sharp(assetPath).metadata();
    if (!meta.width || !meta.height || meta.width * meta.height > MAX_ASSET_PIXELS) {
      throw new RenderError("AssetMissing", `asset dimensions are not acceptable: ${assetPath}`, subject);
    }
    const input = await sharp(assetPath)
      .resize({ width: box.w, height: box.h, fit, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .png()
      .toBuffer();
    return { input, left: box.x, top: box.y };
  } catch (e) {
    if (e instanceof RenderError) throw e;
    throw new RenderError("RenderFailed", `asset cannot be read as an image: ${assetPath}`, subject, { cause: e });
  }
}
