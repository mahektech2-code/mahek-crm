import "server-only";
import fs from "node:fs";
import path from "node:path";
import { declaresAudiences, effectiveAudiences, offersTo } from "@/lib/studio/domain/audience";
import { copySchema, checkCopyText, checkCustomerWording, type Copy } from "@/lib/studio/domain/copy";
import { familyCovers } from "@/lib/studio/domain/fonts";
import { LANGUAGE_SCRIPT, type Language } from "@/lib/studio/domain/language";
import type { Occasion } from "@/lib/studio/domain/occasion";
import { templateSchema, type Template } from "@/lib/studio/domain/template";
import type { LoadedFontRegistry } from "../fonts";
import { readPngSize } from "./png";

// Loads and validates template folders (TEMPLATE_SPEC.md section 9 and RENDERER_SPEC.md section 10).
// A template that fails any check is excluded and reported, never half-loaded, and never blocks
// the other templates.

export type LoadedTemplate = {
  manifest: Template;
  copy: Copy;
  /** Absolute folder of the template. */
  dir: string;
  backgroundPath: string;
  previewPath: string;
  /** Things worth fixing that do not stop the design from loading (for example a missing `audiences`). */
  warnings?: string[];
};

export type TemplateProblem = {
  /** The folder name (a template whose id could not be read is still reported by its folder). */
  folder: string;
  message: string;
};

export type LoadResult = {
  /** Valid templates of every status (draft, approved, archived). */
  valid: LoadedTemplate[];
  problems: TemplateProblem[];
};

export type LoadOptions = {
  templatesDir: string;
  assetsDir: string;
  fonts: LoadedFontRegistry;
  occasions: readonly Occasion[];
};

function readJson(file: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

const issuesText = (issues: readonly { path: PropertyKey[]; message: string }[]) => issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);

/** Validates one folder. Returns the loaded template, or the list of problems found. */
export function loadTemplateFolder(dir: string, opts: LoadOptions): { template: LoadedTemplate; problems: [] } | { template: null; problems: string[] } {
  const folder = path.basename(dir);
  const problems: string[] = [];
  const fail = () => ({ template: null, problems });

  const manifestRaw = readJson(path.join(dir, "template.json"));
  if (!manifestRaw.ok) {
    problems.push(`template.json cannot be read: ${manifestRaw.message}`);
    return fail();
  }
  const parsed = templateSchema.safeParse(manifestRaw.value);
  if (!parsed.success) {
    problems.push(...issuesText(parsed.error.issues).map((m) => `template.json ${m}`));
    return fail();
  }
  const manifest = parsed.data;
  if (manifest.id !== folder) problems.push(`template.json id "${manifest.id}" must equal the folder name "${folder}"`);

  if (!opts.occasions.some((o) => o.id === manifest.occasion)) problems.push(`occasion "${manifest.occasion}" is not in occasions.json`);

  // files: background at exactly the canvas size, preview, layers
  const backgroundPath = path.join(dir, manifest.background);
  const previewPath = path.join(dir, "preview.png");
  if (!fs.existsSync(backgroundPath)) problems.push(`background file "${manifest.background}" is missing`);
  else {
    const size = readPngSize(fs.readFileSync(backgroundPath));
    if (!size) problems.push(`background "${manifest.background}" is not a valid PNG`);
    else if (size.width !== manifest.canvas.width || size.height !== manifest.canvas.height) {
      problems.push(`background is ${size.width}x${size.height} but the canvas is ${manifest.canvas.width}x${manifest.canvas.height}`);
    }
  }
  if (!fs.existsSync(previewPath)) problems.push('"preview.png" is missing');
  for (const layer of manifest.layers) if (!fs.existsSync(path.join(dir, layer.file))) problems.push(`layer file "${layer.file}" is missing`);

  // shared assets referenced by image fields
  for (const f of manifest.fields) {
    if (f.type === "image" && f.asset === "logo") {
      const file = path.join(opts.assetsDir, "logos", `mahek-${f.variant ?? "light"}.png`);
      if (!fs.existsSync(file)) problems.push(`logo variant "${f.variant ?? "light"}" is missing (${path.relative(opts.assetsDir, file)})`);
    }
    if (f.type === "image" && f.asset === "product_image" && !fs.existsSync(path.join(opts.assetsDir, "products"))) problems.push("assets/products/ does not exist");
  }

  // fonts: every role in use must name a registered family that covers each declared language
  const roles = [...new Set(manifest.fields.flatMap((f) => (f.type === "text" ? [f.font] : [])))];
  for (const role of roles) {
    for (const lang of new Set<Language>(["en", ...manifest.languages])) {
      const id = manifest.fonts[role]?.[lang];
      if (!id) continue; // already reported by the schema
      const family = opts.fonts.families.get(id);
      if (!family) problems.push(`font role "${role}" (${lang}) names unknown font family "${id}"`);
      else if (!familyCovers(family, LANGUAGE_SCRIPT[lang])) problems.push(`font "${id}" does not cover the ${LANGUAGE_SCRIPT[lang]} script needed for "${lang}" (role "${role}")`);
    }
  }

  // copy.json
  let copy: Copy = {};
  const copyRaw = readJson(path.join(dir, "copy.json"));
  if (!copyRaw.ok) problems.push(`copy.json cannot be read: ${copyRaw.message}`);
  else {
    const cp = copySchema.safeParse(copyRaw.value);
    if (!cp.success) problems.push(...issuesText(cp.error.issues).map((m) => `copy.json ${m}`));
    else {
      copy = cp.data;
      const greeting = manifest.fields.find((f) => f.type === "text" && f.source === "copy");
      const maxChars = greeting && greeting.type === "text" ? greeting.maxChars : undefined;
      for (const [lang, options] of Object.entries(copy) as [Language, NonNullable<Copy[Language]>][]) {
        if (!manifest.languages.includes(lang)) problems.push(`copy.json has wording for "${lang}" which the template does not declare`);
        const ids = new Set<string>();
        for (const o of options) {
          if (ids.has(o.id)) problems.push(`copy.json ${lang}: duplicate wording id "${o.id}"`);
          ids.add(o.id);
          for (const issue of checkCopyText(o.text, lang, maxChars)) problems.push(`copy.json ${lang}/${o.id}: ${issue.message}`);
          // a wording line can only narrow the design's audiences, and a line cleared for customers must not read like a lead welcome
          if (o.audiences) for (const a of o.audiences) if (!effectiveAudiences(manifest).includes(a)) problems.push(`copy.json ${lang}/${o.id}: audience "${a}" is not one of the design's audiences`);
          if (offersTo({ audiences: o.audiences ?? effectiveAudiences(manifest) }, "customer")) {
            for (const issue of checkCustomerWording(o.text)) problems.push(`copy.json ${lang}/${o.id}: ${issue.message}. Mark this wording lead-only with "audiences": ["lead"].`);
          }
        }
      }
      if (greeting) for (const lang of manifest.languages) if (!copy[lang]?.length) problems.push(`copy.json has no wording for declared language "${lang}"`);
    }
  }

  if (problems.length > 0) return fail();
  const warnings = declaresAudiences(manifest) ? [] : ['no "audiences" declared: read as lead-only (declare ["lead"], ["customer"] or ["lead", "customer"])'];
  return { template: { manifest, copy, dir, backgroundPath, previewPath, ...(warnings.length > 0 ? { warnings } : {}) }, problems: [] };
}

export function loadTemplates(opts: LoadOptions): LoadResult {
  const valid: LoadedTemplate[] = [];
  const problems: TemplateProblem[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(opts.templatesDir, { withFileTypes: true });
  } catch (e) {
    problems.push({ folder: ".", message: `templates folder cannot be read: ${(e as Error).message}` });
  }
  const seenIds = new Set<string>();
  for (const entry of entries.filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
    const result = loadTemplateFolder(path.join(opts.templatesDir, entry.name), opts);
    if (!result.template) {
      for (const message of result.problems) problems.push({ folder: entry.name, message });
      continue;
    }
    if (seenIds.has(result.template.manifest.id)) {
      problems.push({ folder: entry.name, message: `duplicate template id "${result.template.manifest.id}"` });
      continue;
    }
    seenIds.add(result.template.manifest.id);
    valid.push(result.template);
  }
  return { valid, problems };
}
