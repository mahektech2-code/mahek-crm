import "server-only";
import fs from "node:fs";
import path from "node:path";
import { fontRegistrySchema, type FontFamily } from "@/lib/studio/domain/fonts";

export type LoadedFontFamily = FontFamily & {
  /** weight -> absolute path of the font file */
  paths: Record<string, string>;
};

export type LoadedFontRegistry = {
  dir: string;
  families: Map<string, LoadedFontFamily>;
};

/** Reads assets/fonts/fonts.json and checks every listed file exists. Throws a clear error otherwise. */
export function loadFontRegistry(assetsDir: string): LoadedFontRegistry {
  const dir = path.join(assetsDir, "fonts");
  const file = path.join(dir, "fonts.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read font registry ${file}: ${(e as Error).message}`);
  }
  const parsed = fontRegistrySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid font registry ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);

  const families = new Map<string, LoadedFontFamily>();
  for (const f of parsed.data.families) {
    if (families.has(f.id)) throw new Error(`Duplicate font family id "${f.id}" in ${file}`);
    const paths: Record<string, string> = {};
    for (const [weight, name] of Object.entries(f.files)) {
      const abs = path.join(dir, name);
      if (!fs.existsSync(abs)) throw new Error(`Font file missing for "${f.id}" weight ${weight}: ${abs}`);
      paths[weight] = abs;
    }
    families.set(f.id, { ...f, paths });
  }
  return { dir, families };
}
