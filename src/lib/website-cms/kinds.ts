import type { ZodType } from "zod";
import {
  galleryItemSchema,
  industrySchema,
  jobSchema,
  milestoneSchema,
  navigationSchema,
  pageSchema,
  productSchema,
  seoSchema,
  siteSettingsSchema,
  testimonialSchema,
} from "./contract";

/* ---------------------------------------------------------------------------
 * THE KINDS OF WEBSITE CONTENT — one table, so the screens, the server, the
 * bundle and the permission checks cannot disagree about what exists.
 *
 * PURE and client-safe, like `seat-labels`: the editor runs in a browser and
 * the server enforces the same list.
 *
 * `moduleSlug` is the Website module that owns the kind — `website.<moduleSlug>`
 * is what a person must hold to edit it (lib/modules.ts). Publishing is a
 * separate right (`website.publish`), asked for by the server for every kind.
 * ------------------------------------------------------------------------- */

export const KIND_KEYS = [
  "product",
  "industry",
  "gallery",
  "job",
  "testimonial",
  "milestone",
  "page",
  "seo",
  "navigation",
  "settings",
] as const;
export type KindKey = (typeof KIND_KEYS)[number];

export const MODULE_SLUGS = [
  "products",
  "industries",
  "pages",
  "gallery",
  "media",
  "careers",
  "testimonials",
  "milestones",
  "navigation",
  "seo",
  "settings",
] as const;
export type ModuleSlug = (typeof MODULE_SLUGS)[number];

export type KindDef = {
  key: KindKey;
  moduleSlug: ModuleSlug;
  /** "product" — used in messages: "Another product already uses this slug." */
  noun: string;
  plural: string;
  schema: ZodType;
  /** One row for the whole site: its slug is the fixed word `site`. */
  singleton: boolean;
  /** The kind's own address is part of its data (a product's slug, a path for SEO). */
  slugInData: boolean;
  /** Prefix for the generated slug of kinds that have no natural one. */
  idPrefix: string;
  labelOf: (data: Record<string, unknown>) => string;
  /** Where on the public site to look at it. `slug` is the row's slug. */
  previewPath: (data: Record<string, unknown>, slug: string) => string;
};

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

export const KINDS: Record<KindKey, KindDef> = {
  product: {
    key: "product",
    moduleSlug: "products",
    noun: "product",
    plural: "products",
    schema: productSchema,
    singleton: false,
    slugInData: true,
    idPrefix: "p",
    labelOf: (d) => str(d.name, "Untitled product"),
    previewPath: (d, slug) => `/products/${str(d.slug, slug)}`,
  },
  industry: {
    key: "industry",
    moduleSlug: "industries",
    noun: "industry",
    plural: "industries",
    schema: industrySchema,
    singleton: false,
    slugInData: true,
    idPrefix: "i",
    labelOf: (d) => str(d.name, "Untitled industry"),
    previewPath: (d, slug) => `/industries/${str(d.slug, slug)}`,
  },
  gallery: {
    key: "gallery",
    moduleSlug: "gallery",
    noun: "gallery tile",
    plural: "gallery tiles",
    schema: galleryItemSchema,
    singleton: false,
    slugInData: false,
    idPrefix: "g",
    labelOf: (d) => str(d.label, "Untitled tile"),
    previewPath: () => "/gallery",
  },
  job: {
    key: "job",
    moduleSlug: "careers",
    noun: "job",
    plural: "jobs",
    schema: jobSchema,
    singleton: false,
    slugInData: false,
    idPrefix: "j",
    labelOf: (d) => str(d.title, "Untitled job"),
    previewPath: () => "/career",
  },
  testimonial: {
    key: "testimonial",
    moduleSlug: "testimonials",
    noun: "testimonial",
    plural: "testimonials",
    schema: testimonialSchema,
    singleton: false,
    slugInData: false,
    idPrefix: "t",
    labelOf: (d) => `${str(d.name, "Unnamed")}${d.company ? ` — ${str(d.company)}` : ""}`,
    previewPath: () => "/",
  },
  milestone: {
    key: "milestone",
    moduleSlug: "milestones",
    noun: "milestone",
    plural: "milestones",
    schema: milestoneSchema,
    singleton: false,
    slugInData: false,
    idPrefix: "m",
    labelOf: (d) => `${str(d.year)} — ${str(d.title, "Untitled")}`,
    previewPath: () => "/about",
  },
  page: {
    key: "page",
    moduleSlug: "pages",
    noun: "page",
    plural: "pages",
    schema: pageSchema,
    singleton: false,
    slugInData: false,
    idPrefix: "pg",
    labelOf: (d) => str(d.title, "Untitled page"),
    previewPath: (d) => str(d.path, "/"),
  },
  seo: {
    key: "seo",
    moduleSlug: "seo",
    noun: "SEO entry",
    plural: "SEO entries",
    schema: seoSchema,
    singleton: false,
    slugInData: false,
    idPrefix: "s",
    labelOf: (d) => str(d.label, str(d.path, "Untitled")),
    previewPath: (d) => str(d.path, "/"),
  },
  navigation: {
    key: "navigation",
    moduleSlug: "navigation",
    noun: "menu set",
    plural: "menus",
    schema: navigationSchema,
    singleton: true,
    slugInData: false,
    idPrefix: "n",
    labelOf: () => "Header and footer menus",
    previewPath: () => "/",
  },
  settings: {
    key: "settings",
    moduleSlug: "settings",
    noun: "settings",
    plural: "settings",
    schema: siteSettingsSchema,
    singleton: true,
    slugInData: false,
    idPrefix: "st",
    labelOf: () => "Site settings",
    previewPath: () => "/",
  },
};

export const SINGLETON_SLUG = "site";

export function isKind(v: unknown): v is KindKey {
  return typeof v === "string" && (KIND_KEYS as readonly string[]).includes(v);
}

/** The Website module key a person must hold to edit this kind. */
export function moduleKeyFor(kind: KindKey): string {
  return `website.${KINDS[kind].moduleSlug}`;
}

/** The permission to publish, unpublish, archive and refresh the live site. Explicit-only (lib/modules.ts). */
export const PUBLISH_MODULE_KEY = "website.publish";

/**
 * The row's slug for a piece of data — the product's own slug, an SEO path, the
 * fixed word for a singleton. `null` where the kind has no natural one and the
 * server must mint it.
 */
export function slugFromData(kind: KindKey, data: Record<string, unknown>): string | null {
  const def = KINDS[kind];
  if (def.singleton) return SINGLETON_SLUG;
  if (kind === "seo") return typeof data.path === "string" ? data.path : null;
  if (def.slugInData) return typeof data.slug === "string" ? data.slug : null;
  return null;
}

export type FieldIssue = { path: string; message: string };

/** Validates and returns the cleaned data, or every problem with a dotted path the form can mark. */
export function validateKindData(
  kind: KindKey,
  data: unknown,
): { ok: true; data: Record<string, unknown> } | { ok: false; issues: FieldIssue[] } {
  const parsed = KINDS[kind].schema.safeParse(data);
  if (parsed.success) return { ok: true, data: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  };
}
