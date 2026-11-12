import sharp from "sharp";
import { parseColor } from "./color";

// Drawing one line of text with Sharp (libvips + Pango/HarfBuzz).
//
// Two findings from the Phase 0 proof shape this file:
//  1. Pango treats & < > as markup, so every dynamic string is XML-escaped first.
//  2. Sharp returns the INK box of the text, not the line box. The layer's height and top depend on
//     the glyphs, so placing text by its box shifts it a few pixels between different strings
//     ("baseline jitter"). The fix is a transparent "strut" line above the text: it has the same ink
//     extents every time, so the layer's top is constant, and the baseline sits at a fixed distance
//     below it. That distance is measured once per (font, size, script) by drawing a reference "H"
//     (a letter with a flat bottom) in the same structure, and cached.

/** Escapes text for Pango markup. Must be applied to every dynamic string. */
export function escapeMarkup(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** NFC (ZWJ and ZWNJ survive it) and no line breaks: a line is exactly one line. */
export function normalizeForRender(s: string): string {
  return s.normalize("NFC").replace(/[\r\n\t\u{2028}\u{2029}]+/gu, " ");
}

const DEVANAGARI = /[\u{900}-\u{97F}]/u;
const GUJARATI = /[\u{A80}-\u{AFF}]/u;
export type ScriptClass = "latin" | "devanagari" | "gujarati";

/** Which script's line metrics a line uses: Pango sizes a line by the tallest font it draws from. */
export function scriptClass(text: string): ScriptClass {
  if (GUJARATI.test(text)) return "gujarati";
  if (DEVANAGARI.test(text)) return "devanagari";
  return "latin";
}
const CLASS_REFERENCE: Record<ScriptClass, string> = { latin: "", devanagari: "\u{915}", gujarati: "\u{A95}" };

// alpha="1" is 1/65535: drawn with exactly zero opacity (verified), but its glyphs still count
// toward the layer's extents.
const STRUT = '<span alpha="1">Hg</span>';

export type FontStyle = { description: string; size: number };
const fontOf = (s: FontStyle) => `${s.description} ${s.size}`;

type Raw = { data: Buffer; width: number; height: number };

async function renderRaw(markup: string, font: string): Promise<Raw> {
  const { data, info } = await sharp({ text: { text: markup, font, rgba: true, align: "left", wrap: "none" } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`text layer has ${info.channels} channels, expected 4`);
  return { data, width: info.width, height: info.height };
}

// ---- measuring ----------------------------------------------------------------------------

const widthCache = new Map<string, number>();
const WIDTH_CACHE_LIMIT = 20_000;

/** The ink width in pixels of one line of text. Cached: names and words repeat across creatives. */
export async function inkWidth(text: string, style: FontStyle): Promise<number> {
  if (text === "") return 0;
  const key = `${style.description}|${style.size}|${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  const { info } = await sharp({ text: { text: `<span>${escapeMarkup(text)}</span>`, font: fontOf(style), rgba: true, align: "left", wrap: "none" } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (widthCache.size >= WIDTH_CACHE_LIMIT) widthCache.clear();
  widthCache.set(key, info.width);
  return info.width;
}

// ---- baseline calibration ------------------------------------------------------------------

const baselineCache = new Map<string, number>();

/** Row (from the layer top) of the baseline for this font, size and script class. */
async function baselineRow(style: FontStyle, cls: ScriptClass): Promise<number> {
  const key = `${style.description}|${style.size}|${cls}`;
  const hit = baselineCache.get(key);
  if (hit !== undefined) return hit;
  const ref = CLASS_REFERENCE[cls];
  const layer = await renderRaw(`${STRUT}\n<span foreground="#FFFFFF">H</span>${ref ? `<span alpha="1">${ref}</span>` : ""}`, fontOf(style));
  let last = -1;
  for (let y = 0; y < layer.height; y++) {
    for (let x = 0; x < layer.width; x++) {
      if (layer.data[(y * layer.width + x) * 4 + 3] > 128) {
        last = y;
        break;
      }
    }
  }
  if (last < 0) throw new Error("baseline calibration drew nothing");
  const row = last + 1; // the baseline is the bottom edge of the flat-bottomed H
  baselineCache.set(key, row);
  return row;
}

// ---- drawing ------------------------------------------------------------------------------

export type LineLayer = {
  /** RGBA pixels of just the ink (cropped), straight alpha. */
  data: Buffer;
  width: number;
  height: number;
  /** Rows from the top of this layer down to the baseline. May be negative or larger than height. */
  baseline: number;
};

/**
 * Draws one line. Returns null when the text has no ink (only spaces). The layer is cropped to the
 * ink, so its width is the true width and `baseline` says where the baseline is inside it.
 */
export async function drawLine(text: string, style: FontStyle, color: string): Promise<LineLayer | null> {
  const { hex, alpha } = parseColor(color);
  const alphaAttr = alpha < 1 ? ` alpha="${Math.max(1, Math.round(alpha * 100))}%"` : "";
  const markup = `${STRUT}\n<span foreground="${hex}"${alphaAttr}>${escapeMarkup(text)}</span>`;
  const [layer, base] = await Promise.all([renderRaw(markup, fontOf(style)), baselineRow(style, scriptClass(text))]);

  let top = layer.height;
  let bottom = -1;
  let left = layer.width;
  let right = -1;
  for (let y = 0; y < layer.height; y++) {
    const row = y * layer.width * 4;
    for (let x = 0; x < layer.width; x++) {
      if (layer.data[row + x * 4 + 3] > 0) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < 0) return null;

  const width = right - left + 1;
  const height = bottom - top + 1;
  const data = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) {
    layer.data.copy(data, y * width * 4, ((top + y) * layer.width + left) * 4, ((top + y) * layer.width + right + 1) * 4);
  }
  return { data, width, height, baseline: base - top };
}

/** A soft drop shadow for a line: its alpha, blackened, blurred and lowered (the prototype's shadow). */
export async function shadowFor(line: LineLayer): Promise<{ input: Buffer; pad: number }> {
  const pad = 24;
  const w = line.width + pad * 2;
  const h = line.height + pad * 2;
  const raw = Buffer.alloc(w * h * 4); // transparent black
  for (let y = 0; y < line.height; y++) {
    for (let x = 0; x < line.width; x++) {
      const a = line.data[(y * line.width + x) * 4 + 3];
      raw[((y + pad) * w + (x + pad)) * 4 + 3] = Math.round(a * 0.38);
    }
  }
  const input = await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).blur(7).png().toBuffer();
  return { input, pad };
}
