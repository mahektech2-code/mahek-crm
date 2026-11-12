import type { Sharp } from "sharp";
import { RenderError } from "./errors";
import type { OutputFormat } from "./types";

// Encoding and size limits (RENDERER_SPEC.md section 9). The limits are the renderer's defaults, not
// designer rules: the detailed sample art makes PNGs of about 0.1 to 1.4 MB, so 3 MB leaves headroom.
// PNG is lossless and the default; JPEG
// trades quality for a smaller file and is re-encoded at lower quality if it exceeds the limit.
export const MAX_PNG_BYTES = 3_000_000;
export const MAX_JPEG_BYTES = 400_000;
export const DEFAULT_JPEG_QUALITY = 90;
const MIN_JPEG_QUALITY = 60;

export async function encode(pipeline: Sharp, format: OutputFormat, jpegQuality = DEFAULT_JPEG_QUALITY): Promise<Buffer> {
  if (format === "png") {
    const png = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    if (png.length > MAX_PNG_BYTES) throw new RenderError("OutputTooLarge", `PNG is ${png.length} bytes; the limit is ${MAX_PNG_BYTES}`);
    return png;
  }
  const flat = pipeline.flatten({ background: "#FFFFFF" });
  for (let q = Math.max(1, Math.min(100, Math.round(jpegQuality))); ; q -= 5) {
    const jpg = await flat.clone().jpeg({ quality: Math.max(q, 1), mozjpeg: true }).toBuffer();
    if (jpg.length <= MAX_JPEG_BYTES) return jpg;
    if (q - 5 < MIN_JPEG_QUALITY) throw new RenderError("OutputTooLarge", `JPEG is ${jpg.length} bytes at quality ${q}; the limit is ${MAX_JPEG_BYTES}`);
  }
}
