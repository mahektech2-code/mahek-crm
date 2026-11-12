import { z } from "zod";
import type { Script } from "./language";

// The font registry (assets/fonts/fonts.json). Pure schema and helpers; reading the files is the
// server layer's job. Each family records the scripts it covers, so a template that declares Hindi
// can be checked against a font that really has Devanagari.

export const fontFamilySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** The family name as the text engine (Pango) knows it. */
  family: z.string().min(1),
  scripts: z.array(z.enum(["latin", "devanagari", "gujarati"])).min(1),
  licence: z.string().min(1),
  source: z.string().min(1),
  /** CSS-style weight ("400", "700") -> font file name inside assets/fonts. */
  files: z.record(z.string().regex(/^[1-9]00$/), z.string().min(1)),
});
export type FontFamily = z.infer<typeof fontFamilySchema>;

export const fontRegistrySchema = z.object({
  _note: z.string().optional(),
  families: z.array(fontFamilySchema).min(1),
});
export type FontRegistry = z.infer<typeof fontRegistrySchema>;

export const familyCovers = (family: Pick<FontFamily, "scripts">, script: Script): boolean => family.scripts.includes(script);

/** The weight a family really has that is closest to the one asked for (ties go to the heavier). */
export function nearestWeight(family: Pick<FontFamily, "files">, weight: number): string {
  const available = Object.keys(family.files).map(Number);
  if (available.length === 0) throw new Error("font family has no files");
  let best = available[0];
  for (const w of available) {
    const d = Math.abs(w - weight);
    const bd = Math.abs(best - weight);
    if (d < bd || (d === bd && w > best)) best = w;
  }
  return String(best);
}
