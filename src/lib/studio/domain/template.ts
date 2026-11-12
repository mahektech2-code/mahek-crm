import { z } from "zod";
import { FIELD_REGISTRY, isFieldKey, type FieldKey } from "./fields";
import { audiencesSchema, effectiveAudiences } from "./audience";
import { languageSchema, type Language } from "./language";

// The template manifest (template.json) as a Zod schema, following TEMPLATE_SPEC.md. This file is
// pure: it checks the manifest on its own. Checks that need the disk (files exist) or the font
// registry live in server/templates/validate.ts.

const kebab = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "kebab-case");
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "semantic version, for example 1.2.0");
const color = z.string().regex(/^(#[0-9a-fA-F]{3,8}|rgba?\([0-9., %]+\))$/, "a hex colour or rgb()/rgba()");
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const localized = z
  .partialRecord(languageSchema, z.string().min(1))
  .refine((v) => typeof v.en === "string", { message: "must include an English (en) entry, used as the fallback" });

export const boxSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
export type Box = z.infer<typeof boxSchema>;

export const FONT_ROLES = ["display", "body", "name"] as const;
export const fontRoleSchema = z.enum(FONT_ROLES);
export type FontRole = z.infer<typeof fontRoleSchema>;

export const OVERFLOW_POLICIES = ["ellipsis", "abbreviate", "block"] as const;

const baseField = {
  key: z.string().refine(isFieldKey, { message: "not a known field key (see domain/fields.ts)" }),
  required: z.boolean().optional(),
  optional: z.boolean().optional(),
  box: boxSchema,
};

export const textFieldSchema = z.object({
  ...baseField,
  type: z.literal("text"),
  source: z.enum(["crm", "copy", "static", "user", "poster"]),
  crmPath: z.string().optional(),
  fallback: z.string().optional(),
  prefix: localized.optional(),
  text: localized.optional(),
  font: fontRoleSchema,
  weight: z.number().int().min(100).max(900),
  color,
  align: z.enum(["left", "center", "right"]),
  vAlign: z.enum(["top", "middle", "bottom"]),
  maxFont: z.number().int().positive(),
  minFont: z.number().int().positive(),
  step: z.number().int().positive(),
  maxLines: z.number().int().min(1),
  lh: z.number().positive(),
  maxChars: z.number().int().positive().optional(),
  transform: z.literal("upper").optional(),
  overflow: z.enum(OVERFLOW_POLICIES),
  pill: color.optional(),
  shadow: z.boolean().optional(),
});

export const imageFieldSchema = z.object({
  ...baseField,
  type: z.literal("image"),
  source: z.literal("asset"),
  asset: z.enum(["logo", "product_image"]),
  variant: z.enum(["light", "dark"]).optional(),
  fit: z.enum(["contain", "cover"]),
  missing: z.enum(["hide", "block"]),
});

export const fieldSchema = z.discriminatedUnion("type", [textFieldSchema, imageFieldSchema]);
export type TemplateField = z.infer<typeof fieldSchema>;
export type TextField = z.infer<typeof textFieldSchema>;
export type ImageField = z.infer<typeof imageFieldSchema>;

export const templateSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: kebab,
    name: z.string().min(1),
    description: z.string().min(1),
    version: semver,
    status: z.enum(["draft", "approved", "archived"]),
    /** Only on an archived copy of an EARLIER version of a design: the id of that design. The copy is never edited and never offered for new creatives; it exists so a creative made with that version renders the same again. */
    versionOf: kebab.optional(),
    approval: z.object({ approvedBy: z.string().min(1), approvedAt: dateOnly }),
    occasion: kebab,
    category: z.enum(["festival", "promotion", "greeting", "relationship", "repeat"]),
    /** Who the design is for: lead-only, customer-only or shared. Absent is read as lead-only (see domain/audience.ts). */
    audiences: audiencesSchema.optional(),
    languages: z.array(languageSchema).min(1),
    requires: z.array(z.enum(["product"])),
    tags: z.array(z.string()),
    canvas: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      defaultFormat: z.enum(["png", "jpeg"]),
      jpegQuality: z.number().int().min(1).max(100),
    }),
    background: z.string().min(1),
    /** role -> language -> font family id (see assets/fonts/fonts.json). `en` is the Latin family. */
    fonts: z.record(fontRoleSchema, z.partialRecord(languageSchema, z.string().min(1))),
    layers: z.array(z.object({ file: z.string().min(1), box: boxSchema, z: z.number().int() })),
    fields: z.array(fieldSchema).min(1),
    sample: z.object({
      contact: z.string().min(1),
      company: z.string().min(1),
      product: z.string().nullable(),
      language: languageSchema,
      /** A made-up contact number, for the sample render of a design that has a contact-number field. Never a real number. */
      phone: z.string().optional(),
    }),
  })
  .superRefine((t, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const { width, height } = t.canvas;
    const inside = (b: Box) => b.x + b.w <= width && b.y + b.h <= height;

    const seen = new Set<string>();
    t.fields.forEach((f, i) => {
      if (seen.has(f.key)) issue(["fields", i, "key"], `duplicate field key "${f.key}"`);
      seen.add(f.key);
      if (!inside(f.box)) issue(["fields", i, "box"], `box of "${f.key}" is outside the ${width}x${height} canvas`);

      const def = isFieldKey(f.key) ? FIELD_REGISTRY[f.key as FieldKey] : null;
      if (def) {
        if (def.type !== f.type) issue(["fields", i, "type"], `"${f.key}" must be of type ${def.type}`);
        if (!(def.sources as readonly string[]).includes(f.source)) issue(["fields", i, "source"], `"${f.key}" cannot use source "${f.source}"`);
      }
      if (f.type === "text") {
        if (f.minFont > f.maxFont) issue(["fields", i, "minFont"], `minFont (${f.minFont}) is larger than maxFont (${f.maxFont})`);
        if (f.source === "crm") {
          if (!f.crmPath) issue(["fields", i, "crmPath"], "a crm field needs a crmPath");
          else if (def && "crmPaths" in def && !(def.crmPaths as readonly string[]).includes(f.crmPath)) issue(["fields", i, "crmPath"], `"${f.crmPath}" is not allowed for "${f.key}"`);
          if (f.fallback && def && "fallbackPaths" in def && !(def.fallbackPaths as readonly string[]).includes(f.fallback)) issue(["fields", i, "fallback"], `"${f.fallback}" is not an allowed fallback for "${f.key}"`);
        }
        if (f.source === "static" && !f.text) issue(["fields", i, "text"], "a static field needs text");
      } else if (def && "assets" in def && !(def.assets as readonly string[]).includes(f.asset)) {
        issue(["fields", i, "asset"], `"${f.asset}" is not allowed for "${f.key}"`);
      }
    });

    t.layers.forEach((l, i) => {
      if (!inside(l.box)) issue(["layers", i, "box"], `layer "${l.file}" is outside the canvas`);
    });

    // every role used by a text field must name a font for English (Latin) and for each declared language
    const roles = new Set(t.fields.flatMap((f) => (f.type === "text" ? [f.font] : [])));
    for (const role of roles) {
      const map = t.fonts[role];
      if (!map) issue(["fonts", role], `no fonts declared for role "${role}"`);
      else for (const lang of new Set<Language>(["en", ...t.languages])) if (!map[lang]) issue(["fonts", role, lang], `role "${role}" has no font for "${lang}"`);
    }

    if (new Set(t.languages).size !== t.languages.length) issue(["languages"], "duplicate language");

    // category rules (CUSTOMER_FEATURE_BLUEPRINT.md section 7.2, rule 4)
    const audiences = effectiveAudiences(t);
    const only = (kind: string) => audiences.length === 1 && audiences[0] === kind;
    if (t.category === "greeting" && !only("lead")) issue(["audiences"], 'a "greeting" design is the new-lead welcome and must be lead-only: ["lead"]');
    if ((t.category === "relationship" || t.category === "repeat") && !only("customer")) issue(["audiences"], `a "${t.category}" design must declare audiences ["customer"]`);
    if (t.requires.includes("product") && !t.fields.some((f) => f.key === "product_name" || f.key === "product_line" || f.key === "product_image")) {
      issue(["requires"], 'requires "product" but no field uses the product');
    }
  });

export type Template = z.infer<typeof templateSchema>;

/** The language a request should use: the asked one if the template offers it, otherwise English. */
export function templateLanguage(template: Pick<Template, "languages">, requested: Language): Language {
  return template.languages.includes(requested) ? requested : "en";
}

/** What a card or list needs to know about a template. A plain, serializable view of the manifest. */
export type TemplateSummary = {
  id: string;
  name: string;
  description: string;
  occasion: string;
  occasionLabel: string;
  occasionColor?: string;
  languages: Language[];
  version: string;
  requiresProduct: boolean;
};
