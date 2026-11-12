import "server-only";
import fs from "node:fs";
import path from "node:path";
import { offersTo } from "@/lib/studio/domain/audience";
import type { Occasion } from "@/lib/studio/domain/occasion";
import type { RecipientKind } from "@/lib/studio/domain/recipient";
import { languagesForAudience } from "@/lib/studio/domain/template-audience";
import type { Language } from "@/lib/studio/domain/language";
import { loadFontRegistry, type LoadedFontRegistry } from "../fonts";
import { loadTemplates, type LoadedTemplate, type TemplateProblem } from "./loader";
import { loadOccasions } from "./occasions";

// The in-memory index of approved templates. Only `approved` templates are listed and renderable;
// an invalid template is excluded and reported by `problems()`.
export type TemplateRegistry = {
  /** Approved templates, in calendar order (the order of occasions.json), then by name. */
  /** Approved templates; with `audience`, only those offered to that kind of recipient. */
  list(options?: { audience?: RecipientKind }): LoadedTemplate[];
  get(id: string): LoadedTemplate | null;
  /**
   * The design `id` AS IT WAS at `version`: the current approved design when it is that version, otherwise the archived copy of
   * that version. Without a version it is the current approved design (what an id that carries no version has always meant).
   * Null when there is no such version. Use it to show or render a creative that already exists; a NEW creative uses `get`.
   */
  getVersion(id: string, version?: string | undefined): LoadedTemplate | null;
  /** Archived copies of earlier versions (never listed, never offered for new creatives). */
  archivedVersions(): LoadedTemplate[];
  /** The languages a design can be made in for this kind of recipient (see domain/template-audience.ts). */
  languagesFor(template: LoadedTemplate, audience: RecipientKind): Language[];
  occasions(): Occasion[];
  occasion(id: string): Occasion | null;
  /** Occasions that have at least one approved template, in calendar order. */
  occasionsWithTemplates(audience?: RecipientKind): Occasion[];
  fonts: LoadedFontRegistry;
  problems(): TemplateProblem[];
};

export function createTemplateRegistry(options: { templatesDir: string; assetsDir: string; /** Approved custom (uploaded) templates, in the same folder format; read with the same loader. */ extraTemplatesDir?: string }): TemplateRegistry {
  const occasions = loadOccasions(options.templatesDir);
  const fonts = loadFontRegistry(options.assetsDir);
  const base = { templatesDir: options.templatesDir, assetsDir: options.assetsDir, fonts, occasions };
  const { valid, problems } = loadTemplates(base);
  if (options.extraTemplatesDir && fs.existsSync(options.extraTemplatesDir)) {
    const extra = loadTemplates({ ...base, templatesDir: options.extraTemplatesDir });
    const taken = new Set(valid.map((t) => t.manifest.id));
    for (const t of extra.valid) {
      if (taken.has(t.manifest.id)) problems.push({ folder: `uploaded/${path.basename(t.dir)}`, message: `duplicate template id "${t.manifest.id}"` });
      else valid.push(t);
    }
    for (const p of extra.problems) problems.push({ ...p, folder: `uploaded/${p.folder}` });
  }

  const order = new Map(occasions.map((o, i) => [o.id, i]));
  const approved = valid
    .filter((t) => t.manifest.status === "approved")
    .sort((a, b) => (order.get(a.manifest.occasion) ?? 99) - (order.get(b.manifest.occasion) ?? 99) || a.manifest.name.localeCompare(b.manifest.name));
  const byId = new Map(approved.map((t) => [t.manifest.id, t]));

  // Archived copies of earlier versions, keyed by "<design id>@<version>". A copy that names no design, repeats a version, or has the
  // same version as the current design would make a lookup ambiguous, so it is excluded and reported rather than guessed at.
  const archived = new Map<string, LoadedTemplate>();
  const extraProblems: TemplateProblem[] = [];
  for (const t of valid.filter((x) => x.manifest.status === "archived" && x.manifest.versionOf !== undefined)) {
    const design = t.manifest.versionOf as string;
    const key = `${design}@${t.manifest.version}`;
    if (archived.has(key)) extraProblems.push({ folder: t.manifest.id, message: `a second archived copy of ${key}` });
    else if (byId.get(design)?.manifest.version === t.manifest.version) extraProblems.push({ folder: t.manifest.id, message: `archived copy has the same version as the current "${design}" (${t.manifest.version})` });
    else archived.set(key, t);
  }

  return {
    list: (options) => (options?.audience ? approved.filter((t) => offersTo(t.manifest, options.audience as RecipientKind)) : approved.slice()),
    get: (id) => byId.get(id) ?? null,
    getVersion: (id, version) => {
      const current = byId.get(id) ?? null;
      if (version === undefined || current?.manifest.version === version) return current;
      return archived.get(`${id}@${version}`) ?? null;
    },
    archivedVersions: () => [...archived.values()],
    languagesFor: (template, audience) => languagesForAudience(template.manifest, template.copy, audience),
    occasions: () => occasions.slice(),
    occasion: (id) => occasions.find((o) => o.id === id) ?? null,
    occasionsWithTemplates: (audience) => occasions.filter((o) => approved.some((t) => t.manifest.occasion === o.id && (!audience || offersTo(t.manifest, audience)))),
    fonts,
    problems: () => [...problems, ...extraProblems],
  };
}
