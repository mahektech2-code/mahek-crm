import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { LANGUAGE_SCRIPT } from "@/lib/studio/domain/language";
import type { TextField } from "@/lib/studio/domain/template";
import { loadImageForBox } from "./assets";
import { parseColor } from "./color";
import { RenderError } from "./errors";
import { fontDescription, registerFonts } from "./fonts";
import { encode } from "./output";
import { fitText } from "./text-fit";
import { drawLine, normalizeForRender, shadowFor } from "./text-layer";
import type { FieldReport, RenderInput, RenderResult } from "./types";

// Layering (RENDERER_SPEC.md section 3): background, static layers in z order, then each field in
// manifest order (manifest order IS z-order). Everything is positioned in canvas pixels.

// The prototype's line-height rule: Indic scripts need more vertical room for stacked marks, except
// the "name" role (which is mostly Latin).
const INDIC_LINE_FACTOR = 1.22;
// where a baseline sits inside its line box, as a fraction of the font size (the prototype's value)
const BASELINE_OFFSET = 0.32;

type Overlay = { input: Buffer; left: number; top: number; raw?: { width: number; height: number; channels: 4 } };

/** Crops an overlay to the canvas so a layer that sticks out (a shadow near an edge) never errors. */
async function clipToCanvas(o: Overlay, w: number, h: number, W: number, H: number): Promise<Overlay | null> {
  const left = Math.max(0, o.left);
  const top = Math.max(0, o.top);
  const right = Math.min(W, o.left + w);
  const bottom = Math.min(H, o.top + h);
  if (right <= left || bottom <= top) return null;
  if (left === o.left && top === o.top && right === o.left + w && bottom === o.top + h) return o;
  const src = o.raw ? sharp(o.input, { raw: o.raw }) : sharp(o.input);
  const input = await src.extract({ left: left - o.left, top: top - o.top, width: right - left, height: bottom - top }).png().toBuffer();
  return { input, left, top };
}

const rawOverlay = (data: Buffer, width: number, height: number, left: number, top: number): Overlay => ({
  input: data,
  left,
  top,
  raw: { width, height, channels: 4 },
});

/** Height of the SAMPLE strip. Nothing in a template may start above it (a test checks every template). */
export const SAMPLE_STRIP_HEIGHT = 44;
export const SAMPLE_STRIP_TEXT = "SAMPLE \u00b7 NOT A LIVE RECORD";

async function sampleStrip(input: RenderInput, W: number, H: number): Promise<Overlay[]> {
  const out: Overlay[] = [];
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${SAMPLE_STRIP_HEIGHT}"><rect width="${W}" height="${SAMPLE_STRIP_HEIGHT}" fill="#B3261E" fill-opacity="0.96"/></svg>`);
  out.push({ input: svg, left: 0, top: 0 });
  // always the Latin face of the template's "name" role: the mark is English whatever the poster language
  const description = fontDescription(input.template.manifest, "name", "en", 700, input.fonts);
  const size = 26;
  const layer = await drawLine(SAMPLE_STRIP_TEXT, { description, size }, "#FFFFFF");
  if (layer) {
    const left = Math.round((W - layer.width) / 2);
    const y = Math.round(SAMPLE_STRIP_HEIGHT / 2 + size * BASELINE_OFFSET - layer.baseline);
    const drawn = await clipToCanvas(rawOverlay(layer.data, layer.width, layer.height, left, y), layer.width, layer.height, W, H);
    if (drawn) out.push(drawn);
  }
  return out;
}

function pillSvg(width: number, height: number, color: string): Buffer {
  const { hex, alpha } = parseColor(color);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${height / 2}" fill="${hex}" fill-opacity="${alpha.toFixed(3)}"/></svg>`,
  );
}

async function drawTextField(f: TextField, text: string, short: string | undefined, input: RenderInput, W: number, H: number, overlays: Overlay[]): Promise<FieldReport> {
  const { manifest } = input.template;
  const language = input.language;
  const factor = language !== "en" && f.font !== "name" ? INDIC_LINE_FACTOR : 1;
  const description = fontDescription(manifest, f.font, language, f.weight, input.fonts);
  const styleAt = (size: number) => ({ description, size });

  const fit = await fitText(
    text,
    { key: f.key, boxW: f.box.w, boxH: f.box.h, maxFont: f.maxFont, minFont: f.minFont, step: f.step, maxLines: f.maxLines, lh: f.lh * factor, overflow: f.overflow },
    styleAt,
    short,
  );

  const lineHeight = fit.size * f.lh * factor;
  const block = fit.lines.length * lineHeight;
  const top = f.vAlign === "middle" ? f.box.y + (f.box.h - block) / 2 : f.vAlign === "bottom" ? f.box.y + f.box.h - block : f.box.y;

  for (let i = 0; i < fit.lines.length; i++) {
    const layer = await drawLine(fit.lines[i], styleAt(fit.size), f.color);
    if (!layer) continue;
    const left = f.align === "left" ? f.box.x : f.align === "right" ? f.box.x + f.box.w - layer.width : f.box.x + Math.round((f.box.w - layer.width) / 2);
    const baseline = top + i * lineHeight + lineHeight / 2 + fit.size * BASELINE_OFFSET;
    const y = Math.round(baseline - layer.baseline);

    if (f.pill && fit.lines.length === 1) {
      const pw = layer.width + 48;
      const ph = Math.round(fit.size * 1.9);
      const px = f.align === "left" ? left - 24 : f.align === "right" ? left + layer.width + 24 - pw : left + Math.round(layer.width / 2) - Math.round(pw / 2);
      const pillOverlay = await clipToCanvas({ input: pillSvg(pw, ph, f.pill), left: px, top: Math.round(f.box.y + (f.box.h - ph) / 2) }, pw, ph, W, H);
      if (pillOverlay) overlays.push(pillOverlay);
    }
    if (f.shadow) {
      const s = await shadowFor(layer);
      const sh = layer.height + s.pad * 2;
      const sw = layer.width + s.pad * 2;
      const o = await clipToCanvas({ input: s.input, left: left - s.pad, top: y - s.pad + 4 }, sw, sh, W, H);
      if (o) overlays.push(o);
    }
    const drawn = await clipToCanvas(rawOverlay(layer.data, layer.width, layer.height, left, y), layer.width, layer.height, W, H);
    if (drawn) overlays.push(drawn);
  }
  return { key: f.key, status: fit.status, fontSize: fit.size, lines: fit.lines.length, text: fit.lines.join("\n") };
}

export async function composeCreative(input: RenderInput): Promise<RenderResult> {
  const { manifest, dir, backgroundPath } = input.template;
  if (!manifest.languages.includes(input.language)) throw new RenderError("UnsupportedLanguage", `template "${manifest.id}" does not support "${input.language}"`, input.language);
  const { width: W, height: H } = manifest.canvas;
  const format = input.format ?? manifest.canvas.defaultFormat;

  await registerFonts(input.fonts);

  let background: Buffer;
  try {
    background = await fs.readFile(backgroundPath);
  } catch {
    throw new RenderError("AssetMissing", `background art is missing: ${backgroundPath}`, backgroundPath);
  }
  const meta = await sharp(background).metadata();
  if (meta.width !== W || meta.height !== H) throw new RenderError("TemplateInvalid", `background is ${meta.width}x${meta.height} but the canvas is ${W}x${H}`, manifest.id);

  const overlays: Overlay[] = [];
  const report: FieldReport[] = [];

  for (const layer of [...manifest.layers].sort((a, b) => a.z - b.z)) {
    const placed = await loadImageForBox(path.join(dir, layer.file), layer.box, "contain", layer.file);
    overlays.push({ input: placed.input, left: placed.left, top: placed.top });
  }

  for (const f of manifest.fields) {
    const value = input.values[f.key];
    if (f.type === "image") {
      if (!value) {
        if (f.missing === "block") throw new RenderError("ValueMissing", `required image "${f.key}" has no asset`, f.key);
        report.push({ key: f.key, status: "skipped" });
        continue;
      }
      if (!("assetPath" in value)) throw new RenderError("TemplateInvalid", `image field "${f.key}" was given text`, f.key);
      const placed = await loadImageForBox(value.assetPath, f.box, f.fit, f.key);
      overlays.push({ input: placed.input, left: placed.left, top: placed.top });
      report.push({ key: f.key, status: "placed" });
      continue;
    }

    if (!value) {
      if (f.required) throw new RenderError("ValueMissing", `required field "${f.key}" has no value`, f.key);
      report.push({ key: f.key, status: "skipped" });
      continue;
    }
    if (!("text" in value)) throw new RenderError("TemplateInvalid", `text field "${f.key}" was given an image`, f.key);
    let text = normalizeForRender(value.text).trim();
    // upper-casing is for Latin text only: it would corrupt Indic shaping
    if (f.transform === "upper" && LANGUAGE_SCRIPT[input.language] === "latin") text = text.toUpperCase();
    if (!text) {
      if (f.required) throw new RenderError("ValueMissing", `required field "${f.key}" is empty`, f.key);
      report.push({ key: f.key, status: "skipped" });
      continue;
    }
    report.push(await drawTextField(f, text, value.short ? normalizeForRender(value.short).trim() : undefined, input, W, H, overlays));
  }

  // last, so it sits above everything the template draws
  if (input.sampleMark === true) overlays.push(...(await sampleStrip(input, W, H)));

  const pipeline = sharp(background).ensureAlpha().composite(overlays.map((o) => ({ input: o.input, left: o.left, top: o.top, ...(o.raw ? { raw: o.raw } : {}) })));
  const image = await encode(pipeline, format, input.jpegQuality ?? manifest.canvas.jpegQuality);
  return { image, format, width: W, height: H, report };
}
