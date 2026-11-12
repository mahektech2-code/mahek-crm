import { RenderError } from "./errors";
import { inkWidth, type FontStyle } from "./text-layer";

// Text fitting (RENDERER_SPEC.md section 5): find the largest font size in [minFont, maxFont] at
// which the text wraps into at most `maxLines` lines inside the box, then apply the field's
// overflow policy if no size fits. Wrapping happens at spaces only; a single over-long word is
// shrunk, never split. Truncation never cuts inside a grapheme cluster (क्ष and ત્ર stay whole).
//
// Sharp's own height auto-fit would enlarge short text, and its text image is the ink box, so this
// file does its own deterministic search and its own line breaking.

export type FitField = {
  key: string;
  boxW: number;
  boxH: number;
  maxFont: number;
  minFont: number;
  step: number;
  maxLines: number;
  /** Line height multiplier, already including any script factor. */
  lh: number;
  overflow: "ellipsis" | "abbreviate" | "block";
};

export type FitResult = {
  lines: string[];
  size: number;
  status: "fits" | "auto-sized" | "shortened";
};

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
export const graphemes = (s: string): string[] => Array.from(segmenter.segment(s), (x) => x.segment);

const words = (text: string) => text.split(" ").filter((w) => w !== "");

/** Sizes to try, largest first: maxFont, maxFont - step, ... and always minFont last. */
export function candidateSizes(maxFont: number, minFont: number, step: number): number[] {
  const out: number[] = [];
  for (let s = maxFont; s >= minFont; s -= step) out.push(s);
  if (out.at(-1) !== minFont) out.push(minFont);
  return out;
}

const heightOf = (lines: number, size: number, lh: number) => lines * size * lh;
const fitsHeight = (f: FitField, lines: number, size: number) => heightOf(lines, size, f.lh) <= f.boxH + 0.5;

/** Greedy wrap by widths: lines of word indices, or null when one word is wider than the box. */
function wrapByWidths(w: readonly number[], space: number, boxW: number): number[][] | null {
  const lines: number[][] = [];
  let cur: number[] = [];
  let curW = 0;
  for (let i = 0; i < w.length; i++) {
    if (w[i] > boxW) return null;
    const next = cur.length === 0 ? w[i] : curW + space + w[i];
    if (cur.length === 0 || next <= boxW) {
      cur.push(i);
      curW = next;
    } else {
      lines.push(cur);
      cur = [i];
      curW = w[i];
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

async function spaceWidth(style: FontStyle): Promise<number> {
  // the advance of a space between two letters, including kerning
  return (await inkWidth("l l", style)) - (await inkWidth("ll", style));
}

/** Exact check: every line really measures within the box at this size. */
async function linesFit(lines: readonly string[], style: FontStyle, boxW: number): Promise<boolean> {
  for (const line of lines) if ((await inkWidth(line, style)) > boxW) return false;
  return true;
}

/** Wraps `text` at exactly `size`, measuring every word. Returns the lines, or null if it does not fit. */
async function tryFitAt(text: string, size: number, f: FitField, styleAt: (size: number) => FontStyle): Promise<string[] | null> {
  const ws = words(text);
  if (ws.length === 0) return [];
  const style = styleAt(size);
  if (!fitsHeight(f, 1, size)) return null;
  const widths = await Promise.all(ws.map((w) => inkWidth(w, style)));
  const lines = wrapByWidths(widths, await spaceWidth(style), f.boxW);
  if (!lines || lines.length > f.maxLines || !fitsHeight(f, lines.length, size)) return null;
  const strings = lines.map((idx) => idx.map((i) => ws[i]).join(" "));
  return (await linesFit(strings, style, f.boxW)) ? strings : null;
}

/**
 * Fits `text` into the field. `styleAt(size)` gives the font for a size. `short` is an optional
 * abbreviated form, used by the `abbreviate` policy.
 */
export async function fitText(text: string, f: FitField, styleAt: (size: number) => FontStyle, short?: string): Promise<FitResult> {
  const ws = words(text);
  if (ws.length === 0) return { lines: [], size: f.maxFont, status: "fits" };
  const sizes = candidateSizes(f.maxFont, f.minFont, f.step);

  // Measure every word once at the largest size, then PREDICT each smaller size by scaling (width is
  // close to linear in size) and only verify the predicted winner with real measurements. A
  // prediction that fails verification just moves on to the next smaller size.
  const baseSize = sizes[0];
  const baseStyle = styleAt(baseSize);
  const baseWidths = await Promise.all(ws.map((w) => inkWidth(w, baseStyle)));
  const baseSpace = await spaceWidth(baseStyle);

  for (const size of sizes) {
    if (!fitsHeight(f, 1, size)) continue;
    const k = size / baseSize;
    const predicted = wrapByWidths(
      baseWidths.map((w) => w * k),
      baseSpace * k,
      f.boxW,
    );
    if (!predicted || predicted.length > f.maxLines || !fitsHeight(f, predicted.length, size)) continue;
    const strings = predicted.map((idx) => idx.map((i) => ws[i]).join(" "));
    if (await linesFit(strings, styleAt(size), f.boxW)) return { lines: strings, size, status: size === f.maxFont ? "fits" : "auto-sized" };
  }

  // nothing fits: apply the overflow policy
  if (f.overflow === "block") throw new RenderError("FieldOverflow", `text does not fit field "${f.key}" even at the smallest size`, f.key);
  if (f.overflow === "abbreviate" && short && short !== text) {
    const shorter = await fitText(short, { ...f, overflow: "ellipsis" }, styleAt);
    return { ...shorter, status: "shortened" };
  }
  return truncate(text, f, styleAt);
}

/** Ellipsis at the smallest size: the longest grapheme prefix that fits with "…" appended. */
async function truncate(text: string, f: FitField, styleAt: (size: number) => FontStyle): Promise<FitResult> {
  const g = graphemes(text);
  let lo = 0;
  let hi = g.length;
  let best: string[] | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = `${g.slice(0, mid).join("").trimEnd()}…`;
    const lines = await tryFitAt(candidate, f.minFont, f, styleAt);
    if (lines) {
      best = lines;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (!best) {
    // not even "…" fits (an absurdly small box): fail loudly instead of drawing something wrong
    throw new RenderError("FieldOverflow", `field "${f.key}" is too small to show any text`, f.key);
  }
  return { lines: best, size: f.minFont, status: "shortened" };
}
