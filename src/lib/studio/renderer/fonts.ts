import sharp from "sharp";
import { nearestWeight } from "@/lib/studio/domain/fonts";
import type { Language } from "@/lib/studio/domain/language";
import type { FontRole, Template } from "@/lib/studio/domain/template";
import { RenderError } from "./errors";
import type { RendererFontFamily, RendererFonts } from "./types";

// Fonts load from explicit files, never from whatever the host has installed. Sharp takes ONE
// `fontfile` per text call and registers it with fontconfig for the whole process, so every file is
// registered once up front. After that a single text layout can fall back across families, which is
// what a Hindi sentence containing a Latin company name needs (Phase 0 finding).

const registrations = new Map<string, Promise<void>>();

function registerFile(family: string, file: string): Promise<void> {
  let p = registrations.get(file);
  if (!p) {
    p = sharp({ text: { text: "x", font: `${family} 10`, fontfile: file } })
      .raw()
      .toBuffer()
      .then(() => undefined)
      .catch((cause: unknown) => {
        registrations.delete(file); // allow a retry after a transient failure
        throw new RenderError("FontMissing", `font file cannot be loaded: ${file}`, family, { cause });
      });
    registrations.set(file, p);
  }
  return p;
}

export async function registerFonts(fonts: RendererFonts): Promise<void> {
  for (const f of fonts.values()) for (const file of Object.values(f.paths)) await registerFile(f.family, file);
}

const WEIGHT_WORD: Record<string, string> = {
  "100": "Thin",
  "200": "Ultra-Light",
  "300": "Light",
  "400": "Regular",
  "500": "Medium",
  "600": "Semi-Bold",
  "700": "Bold",
  "800": "Ultra-Bold",
  "900": "Heavy",
};

/**
 * The Pango font description (without the size) for a field: the Latin family first, so Latin
 * glyphs (names, product codes) never come from an Indic font, then the language's script family
 * as the per-script fallback. The weight is the closest weight the Latin family really has.
 */
export function fontDescription(template: Pick<Template, "fonts">, role: FontRole, language: Language, weight: number, fonts: RendererFonts): string {
  const map = template.fonts[role];
  const latinId = map?.en;
  if (!latinId) throw new RenderError("FontMissing", `template declares no Latin font for role "${role}"`, role);
  const get = (id: string): RendererFontFamily => {
    const f = fonts.get(id);
    if (!f) throw new RenderError("FontMissing", `font family "${id}" is not registered`, id);
    return f;
  };
  const latin = get(latinId);
  const families = [latin.family];
  const scriptId = map?.[language];
  if (scriptId && scriptId !== latinId) families.push(get(scriptId).family);
  const wordKey = nearestWeight({ files: latin.paths }, weight);
  return `${families.join(", ")} ${WEIGHT_WORD[wordKey] ?? "Regular"}`;
}
