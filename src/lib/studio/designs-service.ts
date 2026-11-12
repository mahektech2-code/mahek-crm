import "server-only";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Copy } from "./domain/copy";
import {
  MIN_SOURCE_WIDTH,
  PLACEABLE,
  buildManifest,
  canvasForSize,
  checkPlacement,
  copyFromDraft,
  type PlacementCheck,
  type PlacementDraft,
} from "./domain/template-upload";
import { istDateKey } from "./date";
import { createLimiter } from "./limiter";
import { ASSETS_DIR } from "./paths";
import { prepareRender } from "./prepare";
import { isRenderError, renderCreative } from "./renderer";
import { SAMPLE_USER, sampleLead } from "./sample";
import { shippedRegistry } from "./registry-service";
import type { LoadedTemplate } from "./templates/loader";

/* ---------------------------------------------------------------------------
 * UPLOADED DESIGNS — somebody's own artwork, with the fields placed on it.
 *
 * The rules are the standalone Studio's, unchanged: the image is checked on
 * its bytes and normalised to one of the supported canvases; the placement is
 * checked (inside the canvas, no overlaps, a personalised field present); and
 * before approval the design is drawn twice — once with the sample text, where
 * anything that does not fit is an ERROR, and once with deliberately long
 * names, where shortening is only a WARNING.
 *
 * What changed is where the files live: file storage and a database row
 * rather than a folder on one server's disk, because MahekOne has no
 * persistent disk to keep one on.
 * ------------------------------------------------------------------------- */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_PIXELS = 36_000_000;

const draftRenders = createLimiter(1);

export function sniffImageFormat(b: Buffer): "png" | "jpeg" | "webp" | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

export type NormalizedImage = { png: Buffer; canvas: string; sourceSha256: string };

const SUPPORTED = "Only PNG, JPG or WebP images can be uploaded.";

/** The uploaded artwork, checked on its bytes and redrawn at the canvas it fits. */
export async function normalizeUploadedImage(input: Buffer): Promise<{ ok: true; data: NormalizedImage } | { ok: false; error: string }> {
  if (input.length === 0) return { ok: false, error: "The file is empty." };
  if (input.length > MAX_UPLOAD_BYTES) return { ok: false, error: `The file is too large (at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` };
  const format = sniffImageFormat(input);
  if (!format) return { ok: false, error: SUPPORTED };
  try {
    const base = () => sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false });
    const meta = await base().metadata();
    if (meta.format !== format || !meta.width || !meta.height) return { ok: false, error: SUPPORTED };
    if ((meta.pages ?? 1) > 1) return { ok: false, error: "Animated images are not supported. Upload a still image." };
    const rotated = (meta.orientation ?? 1) >= 5;
    const width = rotated ? meta.height : meta.width;
    const height = rotated ? meta.width : meta.height;
    if (width < MIN_SOURCE_WIDTH) return { ok: false, error: `The image is too small (${width} x ${height}). It must be at least ${MIN_SOURCE_WIDTH} pixels wide.` };
    const preset = canvasForSize(width, height);
    if (!preset) return { ok: false, error: `The image is ${width} x ${height}, which is too wide or too tall. Its width can be at most 2.5 times its height, and its height at most 2.5 times its width.` };
    const png = await base().rotate().resize(preset.width, preset.height, { fit: "fill" }).flatten({ background: "#ffffff" }).png({ compressionLevel: 9 }).toBuffer();
    return { ok: true, data: { png, canvas: preset.id, sourceSha256: createHash("sha256").update(input).digest("hex") } };
  } catch {
    return { ok: false, error: "The image could not be read. It may be damaged or too large. Try exporting it again." };
  }
}

/** custom-<name>-<random>: the id the renderer will know the design by once approved. */
export function newDesignId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return `custom-${slug ? `${slug}-` : ""}${randomBytes(4).toString("hex")}`;
}

/** A draft's background, written where the renderer can read it. */
function draftDir(id: string): string {
  return path.join(os.tmpdir(), "mahek-studio-drafts", id);
}

export function stageDraftBackground(id: string, png: Buffer): string {
  const dir = draftDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "background.png");
  fs.writeFileSync(file, png);
  return file;
}


export function templateForDraft(input: { id: string; placement: PlacementDraft; backgroundPath: string; status: "draft" | "approved"; approvedBy: string }): { ok: true; template: LoadedTemplate } | { ok: false; error: string } {
  const built = buildManifest(input.placement, { id: input.id, version: "1.0.0", status: input.status, approvedBy: input.approvedBy, approvedAt: istDateKey(new Date()) });
  if (!built.ok) return { ok: false, error: `The design cannot be built: ${built.problems[0]}` };
  const dir = path.dirname(input.backgroundPath);
  return { ok: true, template: { manifest: built.manifest, copy: copyFromDraft(input.placement) as Copy, dir, backgroundPath: input.backgroundPath, previewPath: path.join(dir, "preview.png") } };
}

const label = (key: string) => (key in PLACEABLE ? PLACEABLE[key as keyof typeof PLACEABLE].label : key.replaceAll("_", " "));

async function renderCase(template: LoadedTemplate, stress: boolean): Promise<{ png?: Buffer; errors: string[]; shortened: string[] }> {
  const m = template.manifest;
  const has = (k: string) => m.fields.some((f) => f.key === k);
  const base = sampleLead(template);
  const longest = (template.copy.en ?? []).map((o) => o.text).sort((a, b) => b.length - a.length)[0];
  const lead = stress ? { ...base, contact: "Maheshwari Venkataraghavan Subramaniam", company: "Shri Maheshwari Venkataraghavan Industries Private Limited" } : base;
  const prepared = prepareRender({
    template,
    lead,
    user: SAMPLE_USER,
    language: "en",
    options: template.copy.en ?? [],
    variantId: undefined,
    showProduct: true,
    assetsDir: ASSETS_DIR,
    personal: {
      ...(has("contact_phone") ? { phone: m.sample.phone ?? "+91 98765 43210" } : {}),
      ...(has("product_name") ? { product: stress ? "Premium Fortified Refined Sunflower Cooking Oil 15 kg Tin" : (m.sample.product ?? "Sample Product") } : {}),
      ...(stress && has("greeting") && longest ? { message: longest } : {}),
    },
  });
  if (!prepared.ok) return { errors: [prepared.error], shortened: [] };
  try {
    const result = await draftRenders.run(() =>
      renderCreative({ template: { manifest: m, dir: template.dir, backgroundPath: template.backgroundPath }, values: prepared.data.values, language: "en", fonts: shippedRegistry().fonts.families }),
    );
    return { png: result.image, errors: [], shortened: result.report.filter((r) => r.status === "shortened").map((r) => r.key) };
  } catch (e) {
    if (isRenderError(e)) return { errors: [`The design could not be drawn: ${e.message}`], shortened: [] };
    throw e;
  }
}

export type DraftPreview = { png: Buffer; check: PlacementCheck; render: { errors: string[]; warnings: string[] } };

/**
 * The draft drawn with sample text, the placement's own problems, and what the
 * drawing found: text that does not fit even the sample is an error; a long
 * real name that would be shortened is a warning.
 */
export async function previewDraft(input: { id: string; placement: PlacementDraft; backgroundPath: string }): Promise<DraftPreview> {
  const check = checkPlacement(input.placement);
  const background = () => sharp(input.backgroundPath).png().toBuffer();
  const tpl = templateForDraft({ ...input, status: "draft", approvedBy: "preview" });
  if (!tpl.ok) return { png: await background(), check, render: { errors: [], warnings: [] } };
  const sample = await renderCase(tpl.template, false);
  const render = { errors: [...sample.errors], warnings: [] as string[] };
  for (const k of sample.shortened) render.errors.push(`${label(k)}: even the sample text does not fit at the smallest size. Make the box larger or lower the smallest size.`);
  if (sample.png && render.errors.length === 0) {
    const stress = await renderCase(tpl.template, true);
    for (const k of stress.shortened) render.warnings.push(`${label(k)}: a very long value would be shortened with "...". Make the box larger if that matters.`);
  }
  return { png: sample.png ?? (await background()), check, render };
}
