import { z } from "zod";

/* ---------------------------------------------------------------------------
 * THE WEBSITE CONTENT CONTRACT — the shape mahekindia.com reads.
 *
 * PURE: no database, no React, no secrets. It is imported by the editor (to
 * validate what a person typed), by the bundle builder (to shape what the
 * public site reads) and by the tests.
 *
 * The public site's own copy of these types lives in `mahek-website`
 * (`src/lib/cms/types.ts`). Nothing can be imported across two repositories,
 * so the two are kept in step by a shared fixture — the seed bundle the
 * website exports — which BOTH repositories validate in their tests. If a field
 * is added here it must be added there, and the fixture is what notices.
 *
 * Field names are the website's existing `src/types/*` names, unchanged, so
 * the public components needed no renaming.
 * ------------------------------------------------------------------------- */

export const CONTENT_VERSION = 1 as const;

/* ------------------------------------------------------------------ pieces */

const text = (max: number) => z.string().trim().min(1, "Required.").max(max);
/** Allowed to be empty — a tagline can be blank, a description can be missing. */
const looseText = (max: number) => z.string().trim().max(max);

/** URL-shaped: lower-case words and numbers joined by single hyphens. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const slugField = z
  .string()
  .trim()
  .min(1, "Slug is required.")
  .max(100)
  .regex(SLUG_PATTERN, "Use lower-case letters, numbers and single hyphens only, e.g. universal-thinner.");

/**
 * An image reference: a path on the public site (`/images/…`, `/Mahek%20NC%20Thinner/…`)
 * or an uploaded file (`/cms-media/<id>/<name>`). Never `//host`, never a full
 * address or another scheme — it ends up in an `<img src>`, and the public site
 * itself rejects anything that is not a path on itself (contract §4), so a
 * reference it would refuse is refused here, at the editor, instead of making
 * the whole bundle fail to load.
 */
export const mediaRef = z
  .string()
  .trim()
  .min(1, "Choose an image.")
  .max(500)
  .refine((v) => v.startsWith("/") && !v.startsWith("//"), {
    message: "Choose an image from the library. Only images on the website or uploaded here can be used.",
  })
  .refine((v) => !/[\s<>"']/.test(v), { message: "An image address cannot contain spaces or quotes." });

/** A link on the site: a path, a full address, mailto: or tel:. */
export const hrefField = z
  .string()
  .trim()
  .min(1, "Link is required.")
  .max(500)
  .refine((v) => !/\s/.test(v), { message: "A link cannot contain spaces." })
  .refine(
    (v) => (v.startsWith("/") && !v.startsWith("//")) || /^(https?:\/\/[^\s/]+\.[^\s/]+|mailto:\S+|tel:\S+)/i.test(v),
    { message: "Use a path like /products, or a full address starting with https://." },
  );

const scale = z.number().positive().max(10);

/* ------------------------------------------------------------- the content */

export const productSchema = z.object({
  id: text(40),
  slug: slugField,
  name: text(120),
  icon: text(40),
  image: mediaRef,
  imageScale: z.object({ grid: scale, heroMobile: scale, heroDesktop: scale }),
  tag: looseText(60),
  short: text(300),
  description: z.array(text(3000)).max(12).optional(),
  images: z
    .array(
      z.object({
        size: text(40),
        src: mediaRef,
        scale: z.object({ mobile: scale, desktop: scale }).optional(),
      }),
    )
    .max(24)
    .optional(),
  applications: z.array(text(160)).max(60),
  benefits: z.array(text(200)).max(60),
  industries: z.array(text(120)).max(60),
  packaging: z.array(text(60)).max(40),
  specs: z.record(text(80), text(240)),
});
export type ProductContent = z.infer<typeof productSchema>;

export const industrySchema = z.object({
  slug: slugField,
  name: text(120),
  icon: text(40),
  short: text(300),
  image: mediaRef.optional(),
  productSlugs: z.array(slugField).max(60),
});
export type IndustryContent = z.infer<typeof industrySchema>;

export const galleryItemSchema = z.object({
  category: text(60),
  label: text(160),
  image: mediaRef.optional(),
  imagePosition: looseText(60).optional(),
});
export type GalleryContent = z.infer<typeof galleryItemSchema>;

export const jobSchema = z.object({
  title: text(120),
  department: text(80),
  location: text(120),
  type: text(40),
});
export type JobContent = z.infer<typeof jobSchema>;

export const testimonialSchema = z.object({
  name: text(100),
  role: looseText(100),
  company: looseText(160),
  quote: text(1200),
  initials: text(6),
});
export type TestimonialContent = z.infer<typeof testimonialSchema>;

export const milestoneSchema = z.object({
  year: text(12),
  title: text(160),
  description: text(2000),
});
export type MilestoneContent = z.infer<typeof milestoneSchema>;

/* ----------------------------------------------------------- settings, menus */

const phoneText = z
  .string()
  .trim()
  .max(40)
  .refine((v) => v === "" || (/^\+?[\d\s\-().]+$/.test(v) && v.replace(/\D/g, "").length >= 7 && v.replace(/\D/g, "").length <= 15), {
    message: "Enter a phone number using digits, spaces and an optional leading +.",
  });
const emailText = z
  .string()
  .trim()
  .max(160)
  .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v), { message: "Enter an email address like name@example.com." });
const urlText = z
  .string()
  .trim()
  .max(300)
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".");
      } catch {
        return false;
      }
    },
    { message: "Enter a full web address starting with https://, e.g. https://example.com." },
  );

export const siteSettingsSchema = z.object({
  company: z.object({
    name: text(120),
    tagline: text(600),
    phoneDisplay: phoneText,
    phoneHref: looseText(60),
    whatsappDisplay: phoneText,
    whatsappHref: looseText(200),
    email: emailText,
    officeAddress: looseText(300),
    plantAddress: looseText(300),
    workingHours: looseText(120),
  }),
  stats: z
    .array(
      z.object({
        value: z.number().finite().nonnegative(),
        suffix: z.string().max(12),
        label: text(80),
        shortLabel: text(60),
        displayValue: looseText(20).optional(),
      }),
    )
    // The public site quotes the first two figures by position (customers, daily
    // production) on the About and Manufacturing pages, so fewer than two is
    // refused rather than published and then rejected by the site.
    .min(2, "Keep at least the first two figures — the About and Manufacturing pages quote them.")
    .max(12),
  social: z.array(z.object({ label: text(40), href: urlText.nullable() })).max(12),
  analyticsId: z
    .string()
    .trim()
    .regex(/^G-[A-Z0-9]{6,14}$/, "A Google Analytics ID looks like G-ABCDE12345.")
    .nullable(),
});
export type SiteSettings = z.infer<typeof siteSettingsSchema>;

const navLink = z.object({ label: text(80), href: hrefField });
export const navigationSchema = z.object({
  header: z.array(navLink.extend({ mega: z.enum(["products", "industries", "manufacturing"]).optional() })).max(16),
  manufacturingMega: z.array(navLink.extend({ description: looseText(200) })).max(8),
  footerCompany: z.array(navLink).max(16),
  footerQuick: z.array(navLink).max(16),
  legal: z.array(navLink).max(12),
});
export type Navigation = z.infer<typeof navigationSchema>;

/* ------------------------------------------------------------ pages and SEO */

export const BLOCK_TYPES = ["text", "paragraph", "list"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const blockSchema = z.object({
  key: text(80),
  label: text(120),
  type: z.enum(BLOCK_TYPES),
  value: z.union([z.string().max(4000), z.array(z.string().max(1000)).max(40)]),
});
export type PageBlock = z.infer<typeof blockSchema>;

/**
 * One page's editable copy. `blocks` is the website's registry (its own
 * `src/lib/cms/page-blocks.ts`) as seeded — the editor changes VALUES and never
 * invents a block, because a block the site does not read would be an edit that
 * does nothing.
 */
export const pageSchema = z
  .object({
    title: text(80),
    /** Where the page lives on the public site, for the preview link. */
    path: z.string().trim().startsWith("/").max(120),
    blocks: z.array(blockSchema).max(200),
  })
  .superRefine((page, ctx) => {
    page.blocks.forEach((b, i) => {
      const bad =
        (b.type === "list" && !Array.isArray(b.value)) || (b.type !== "list" && typeof b.value !== "string");
      if (bad) ctx.addIssue({ code: "custom", path: ["blocks", i, "value"], message: `${b.label} must be ${b.type === "list" ? "a list" : "text"}.` });
      if (b.type === "text" && typeof b.value === "string" && b.value.length > 600) {
        ctx.addIssue({ code: "custom", path: ["blocks", i, "value"], message: `${b.label} is too long for a heading or single line (600 characters).` });
      }
      if (b.type !== "list" && typeof b.value === "string" && b.value.trim() === "") {
        ctx.addIssue({ code: "custom", path: ["blocks", i, "value"], message: `${b.label} cannot be blank.` });
      }
    });
  });
export type PageContent = z.infer<typeof pageSchema>;

export const seoSchema = z.object({
  /** The page this describes: `/`, `/about`, `/products/nc-thinner`. */
  path: z.string().trim().startsWith("/").max(200).refine((v) => !v.startsWith("//") && !/\s/.test(v), { message: "A path starts with a single / and has no spaces." }),
  /** What the editor calls it. Not sent to the public site. */
  label: text(160),
  title: looseText(120).optional(),
  description: looseText(320).optional(),
  ogImage: mediaRef.optional(),
  noindex: z.boolean().optional(),
});
export type SeoEntry = z.infer<typeof seoSchema>;
/** What the public site receives for a path — no editor-only label. */
export type SeoContent = Pick<SeoEntry, "title" | "description" | "ogImage" | "noindex">;

/* ----------------------------------------------------------------- the bundle */

/** A section is null when the CMS has never held content of that kind: the website keeps its own static copy for it. */
export const bundleSchema = z.object({
  version: z.literal(CONTENT_VERSION),
  draft: z.boolean(),
  revision: z.string().min(1),
  generatedAt: z.string().min(1),
  settings: siteSettingsSchema.nullable(),
  navigation: navigationSchema.nullable(),
  products: z.array(productSchema).nullable(),
  industries: z.array(industrySchema).nullable(),
  gallery: z.array(galleryItemSchema).nullable(),
  jobs: z.array(jobSchema).nullable(),
  testimonials: z.array(testimonialSchema).nullable(),
  milestones: z.array(milestoneSchema).nullable(),
  pages: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.array(z.string())]))).nullable(),
  seo: z
    .record(
      z.string(),
      z.object({ title: z.string().optional(), description: z.string().optional(), ogImage: z.string().optional(), noindex: z.boolean().optional() }),
    )
    .nullable(),
});
export type WebsiteBundle = z.infer<typeof bundleSchema>;

/** What the website's seed export adds on top of a bundle. */
export const seedSchema = bundleSchema.extend({
  blockDefinitions: z.record(
    z.string(),
    z.object({
      title: text(80),
      path: z.string().startsWith("/"),
      blocks: z.array(z.object({ key: text(80), label: text(120), type: z.enum(BLOCK_TYPES) })),
    }),
  ),
  staticMedia: z.array(z.object({ path: z.string().min(1), label: z.string().min(1) })),
});
export type WebsiteSeed = z.infer<typeof seedSchema>;
