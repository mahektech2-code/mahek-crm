import type { KindKey } from "@/lib/website-cms/kinds";

/* ---------------------------------------------------------------------------
 * HOW EACH KIND OF WEBSITE CONTENT IS EDITED — as data, not as a screen each.
 *
 * Seven of the Website modules are a list of records with an editor; two more
 * (menus, settings) are one record with a longer form. They differ in WHICH
 * fields, not in how a field is drawn, so a field is described here once and
 * `field-editor.tsx` draws every one of them. The server validates the same
 * shape (`lib/website-cms/contract.ts`), so what this describes and what is
 * accepted cannot drift: a path here is the zod path of the problem it shows.
 *
 * PURE and client-safe.
 * ------------------------------------------------------------------------- */

export type Option = { value: string; label: string };

export type FieldDef =
  | { type: "text"; path: string; label: string; hint?: string; placeholder?: string; emptyAs?: "undefined" | "null"; readOnlyWhenExisting?: boolean; maxLength?: number; counter?: number }
  | { type: "textarea"; path: string; label: string; hint?: string; rows?: number; emptyAs?: "undefined"; counter?: number }
  | { type: "number"; path: string; label: string; hint?: string; step?: number }
  | { type: "select"; path: string; label: string; hint?: string; options: Option[]; emptyAs?: "undefined" }
  | { type: "bool"; path: string; label: string; hint?: string }
  | { type: "strings"; path: string; label: string; hint?: string; addLabel: string; placeholder?: string }
  | { type: "paragraphs"; path: string; label: string; hint?: string; addLabel: string }
  | { type: "specs"; path: string; label: string; hint?: string }
  | { type: "image"; path: string; label: string; hint?: string; optional?: boolean }
  | { type: "imageList"; path: string; label: string; hint?: string }
  | { type: "productPicker"; path: string; label: string; hint?: string }
  | { type: "rows"; path: string; label: string; hint?: string; addLabel: string; columns: FieldDef[]; blank: () => Record<string, unknown> }
  | { type: "group"; label: string; hint?: string; collapsed?: boolean; fields: FieldDef[] };

/* ---------------------------------------------------------------- products */

const ICON_HINT = "The small icon drawn on cards, e.g. droplet, flask, beaker, layers, truck, gauge, globe, award.";

export const PRODUCT_FIELDS: FieldDef[] = [
  { type: "text", path: "name", label: "Name", maxLength: 120 },
  {
    type: "text",
    path: "slug",
    label: "Web address (slug)",
    hint: "The page lives at /products/<slug>. Lower-case words joined by hyphens. Changing it after the product is live changes its address.",
    maxLength: 100,
  },
  { type: "text", path: "id", label: "Product code", hint: "A short unique code, e.g. MTI-12.", maxLength: 40 },
  { type: "text", path: "tag", label: "Badge", hint: "The small label on the card, e.g. Best Seller. May be left blank.", maxLength: 60 },
  { type: "textarea", path: "short", label: "One-line summary", rows: 2, counter: 300 },
  { type: "paragraphs", path: "description", label: "Description", hint: "Shown on the product page, one paragraph per box.", addLabel: "Add paragraph" },
  { type: "image", path: "image", label: "Main photo", hint: "The photo used on cards, the home page and sharing." },
  { type: "imageList", path: "images", label: "Photos by pack size", hint: "Shown as a slider on the product page. Only list sizes that were actually photographed." },
  { type: "strings", path: "applications", label: "Applications", addLabel: "Add application", placeholder: "e.g. Synthetic Enamel" },
  { type: "strings", path: "benefits", label: "Benefits", addLabel: "Add benefit", placeholder: "e.g. Fast Drying" },
  { type: "strings", path: "industries", label: "Used in (industries)", hint: "Free text shown on the product page.", addLabel: "Add industry", placeholder: "e.g. Furniture" },
  { type: "strings", path: "packaging", label: "Pack sizes", addLabel: "Add size", placeholder: "e.g. 5L" },
  { type: "specs", path: "specs", label: "Specifications", hint: "Name and value, e.g. Appearance — Crystal Clear." },
  { type: "text", path: "icon", label: "Icon", hint: ICON_HINT, maxLength: 40 },
  {
    type: "group",
    label: "Photo zoom (advanced)",
    hint: "How far each product photo is zoomed inside its frame. Leave alone unless a photo looks too small or too cropped.",
    collapsed: true,
    fields: [
      { type: "number", path: "imageScale.grid", label: "On cards", step: 0.05 },
      { type: "number", path: "imageScale.heroMobile", label: "Product page, phone", step: 0.05 },
      { type: "number", path: "imageScale.heroDesktop", label: "Product page, desktop", step: 0.05 },
    ],
  },
];

export const INDUSTRY_FIELDS: FieldDef[] = [
  { type: "text", path: "name", label: "Name", maxLength: 120 },
  { type: "text", path: "slug", label: "Web address (slug)", hint: "The page lives at /industries/<slug>. Changing it after the industry is live changes its address.", maxLength: 100 },
  { type: "textarea", path: "short", label: "Short description", rows: 2, counter: 300 },
  { type: "image", path: "image", label: "Photo", optional: true },
  { type: "productPicker", path: "productSlugs", label: "Products shown under this industry", hint: "Only products that are live are shown to visitors." },
  { type: "text", path: "icon", label: "Icon", hint: ICON_HINT, maxLength: 40 },
];

export const GALLERY_FIELDS: FieldDef[] = [
  { type: "text", path: "label", label: "Caption", maxLength: 160 },
  { type: "text", path: "category", label: "Category", hint: "Visitors filter the gallery by this, e.g. Factory, Dealer Meet, Events.", maxLength: 60 },
  { type: "image", path: "image", label: "Photo", optional: true },
  { type: "text", path: "imagePosition", label: "Focus point", hint: "Optional. Which part of a tall photo stays visible, e.g. center top.", emptyAs: "undefined", maxLength: 60 },
];

export const JOB_FIELDS: FieldDef[] = [
  { type: "text", path: "title", label: "Job title", maxLength: 120 },
  { type: "text", path: "department", label: "Department", maxLength: 80 },
  { type: "text", path: "location", label: "Location", maxLength: 120 },
  { type: "text", path: "type", label: "Type", hint: "e.g. Full-time.", maxLength: 40 },
];

export const TESTIMONIAL_FIELDS: FieldDef[] = [
  { type: "text", path: "name", label: "Name", maxLength: 100 },
  { type: "text", path: "role", label: "Role", maxLength: 100 },
  { type: "text", path: "company", label: "Company and place", maxLength: 160 },
  { type: "text", path: "initials", label: "Initials", hint: "Shown in the avatar circle, e.g. RD.", maxLength: 6 },
  { type: "textarea", path: "quote", label: "Quote", rows: 4, counter: 1200 },
];

export const MILESTONE_FIELDS: FieldDef[] = [
  { type: "text", path: "year", label: "Year", maxLength: 12 },
  { type: "text", path: "title", label: "Title", maxLength: 160 },
  { type: "textarea", path: "description", label: "Description", rows: 5, counter: 2000 },
];

export const SEO_FIELDS: FieldDef[] = [
  { type: "text", path: "path", label: "Page address", hint: "e.g. /about or /products/nc-thinner. Fixed once created.", readOnlyWhenExisting: true, maxLength: 200 },
  { type: "text", path: "label", label: "Name in this list", hint: "Only for you — not shown to visitors.", maxLength: 160 },
  { type: "text", path: "title", label: "Search title", hint: "Leave blank to keep the page's own title. Around 50–60 characters reads best.", emptyAs: "undefined", counter: 60, maxLength: 120 },
  { type: "textarea", path: "description", label: "Search description", hint: "Leave blank to keep the page's own. Around 150–160 characters reads best.", rows: 3, emptyAs: "undefined", counter: 160 },
  { type: "image", path: "ogImage", label: "Sharing image", hint: "The picture shown when the page is shared. Leave blank to keep the default.", optional: true },
  { type: "bool", path: "noindex", label: "Ask search engines not to list this page" },
];

/* ------------------------------------------------------------ menus, settings */

const linkCols: FieldDef[] = [
  { type: "text", path: "label", label: "Label", maxLength: 80 },
  { type: "text", path: "href", label: "Link", placeholder: "/products", maxLength: 500 },
];

export const NAVIGATION_FIELDS: FieldDef[] = [
  {
    type: "rows",
    path: "header",
    label: "Header menu",
    hint: "The main menu across the top. A menu marked with a panel opens the matching dropdown.",
    addLabel: "Add menu item",
    blank: () => ({ label: "", href: "" }),
    columns: [
      ...linkCols,
      {
        type: "select",
        path: "mega",
        label: "Dropdown panel",
        emptyAs: "undefined",
        options: [
          { value: "", label: "None" },
          { value: "products", label: "Products" },
          { value: "industries", label: "Industries" },
          { value: "manufacturing", label: "Manufacturing & Quality" },
        ],
      },
    ],
  },
  {
    type: "rows",
    path: "manufacturingMega",
    label: "Manufacturing & Quality panel",
    addLabel: "Add link",
    blank: () => ({ label: "", href: "", description: "" }),
    columns: [...linkCols, { type: "text", path: "description", label: "Description", maxLength: 200 }],
  },
  { type: "rows", path: "footerCompany", label: "Footer — Company", addLabel: "Add link", blank: () => ({ label: "", href: "" }), columns: linkCols },
  { type: "rows", path: "footerQuick", label: "Footer — Quick links", addLabel: "Add link", blank: () => ({ label: "", href: "" }), columns: linkCols },
  { type: "rows", path: "legal", label: "Footer — Legal", addLabel: "Add link", blank: () => ({ label: "", href: "" }), columns: linkCols },
];

export const SETTINGS_FIELDS: FieldDef[] = [
  {
    type: "group",
    label: "Company",
    fields: [
      { type: "text", path: "company.name", label: "Company name", maxLength: 120 },
      { type: "textarea", path: "company.tagline", label: "Tagline", rows: 3, counter: 600 },
      { type: "text", path: "company.phoneDisplay", label: "Phone (as shown)", placeholder: "+91 81081 06253" },
      { type: "text", path: "company.phoneHref", label: "Phone link", hint: "What tapping the number dials, e.g. tel:+918108106253.", placeholder: "tel:+918108106253" },
      { type: "text", path: "company.whatsappDisplay", label: "WhatsApp (as shown)" },
      { type: "text", path: "company.whatsappHref", label: "WhatsApp link", placeholder: "https://wa.me/918108106253" },
      { type: "text", path: "company.email", label: "Email", placeholder: "info@mahekindia.com" },
      { type: "text", path: "company.officeAddress", label: "Office address", maxLength: 300 },
      { type: "text", path: "company.plantAddress", label: "Plant address", maxLength: 300 },
      { type: "text", path: "company.workingHours", label: "Working hours", maxLength: 120 },
    ],
  },
  {
    type: "rows",
    path: "stats",
    label: "Figures shown across the site",
    hint: "The counters on the home page, hero and About. Keep the order: the first two are also quoted on the Manufacturing and About pages.",
    addLabel: "Add figure",
    blank: () => ({ value: 0, suffix: "", label: "", shortLabel: "" }),
    columns: [
      { type: "number", path: "value", label: "Number", step: 1 },
      { type: "text", path: "suffix", label: "Suffix", hint: "e.g. + or T", maxLength: 12 },
      { type: "text", path: "label", label: "Full label", maxLength: 80 },
      { type: "text", path: "shortLabel", label: "Short label", maxLength: 60 },
      { type: "text", path: "displayValue", label: "Show this text instead", hint: "e.g. Since — replaces the counter.", emptyAs: "undefined", maxLength: 20 },
    ],
  },
  {
    type: "rows",
    path: "social",
    label: "Social links",
    hint: "Leave the address blank where there is no real page yet — the site then shows no link rather than a dead one.",
    addLabel: "Add social link",
    blank: () => ({ label: "", href: null }),
    columns: [
      { type: "text", path: "label", label: "Network", maxLength: 40 },
      { type: "text", path: "href", label: "Address", placeholder: "https://…", emptyAs: "null", maxLength: 300 },
    ],
  },
  {
    type: "group",
    label: "Analytics",
    fields: [{ type: "text", path: "analyticsId", label: "Google Analytics ID", hint: "Looks like G-ABCDE12345. Blank keeps the ID built into the site.", emptyAs: "null", placeholder: "G-ABCDE12345" }],
  },
];

/* ------------------------------------------------------- the list screens */

export type ListKind = Extract<KindKey, "product" | "industry" | "gallery" | "job" | "testimonial" | "milestone" | "seo">;

export type ListUi = {
  kind: ListKind;
  title: string;
  subtitle: string;
  noun: string;
  addLabel: string;
  fields: FieldDef[];
  /** A fresh record for the Add dialog. */
  blank: () => Record<string, unknown>;
  /** The second column: what to show beside the name. */
  meta: { header: string; of: (data: Record<string, unknown>) => string };
  /** Where the record's picture lives, for the thumbnail. */
  imageOf?: (data: Record<string, unknown>) => string | undefined;
  /** A name for the second line under the label. */
  subOf?: (data: Record<string, unknown>) => string;
  ordered: boolean;
  /** A kind that may be unpublished to fall back to the site's built-in version is not archivable — N/A here, kept for clarity. */
  emptyHint: string;
};

const s = (v: unknown) => (typeof v === "string" ? v : "");

export const LIST_UI: Record<ListKind, ListUi> = {
  product: {
    kind: "product",
    title: "Products",
    subtitle: "The catalogue shown on mahekindia.com. Edit, preview, then publish.",
    noun: "product",
    addLabel: "Add Product",
    fields: PRODUCT_FIELDS,
    blank: () => ({
      id: "",
      slug: "",
      name: "",
      icon: "flask",
      image: "",
      imageScale: { grid: 2, heroMobile: 1, heroDesktop: 2 },
      tag: "",
      short: "",
      description: [],
      images: [],
      applications: [],
      benefits: [],
      industries: [],
      packaging: [],
      specs: {},
    }),
    meta: { header: "Badge", of: (d) => s(d.tag) || "—" },
    imageOf: (d) => s(d.image) || undefined,
    subOf: (d) => `/products/${s(d.slug)}`,
    ordered: true,
    emptyHint: "Import the website's current products from the Dashboard, or add the first one.",
  },
  industry: {
    kind: "industry",
    title: "Industries",
    subtitle: "The industries the public site says Mahek serves, and the products shown under each.",
    noun: "industry",
    addLabel: "Add Industry",
    fields: INDUSTRY_FIELDS,
    blank: () => ({ slug: "", name: "", icon: "droplet", short: "", image: undefined, productSlugs: [] }),
    meta: { header: "Products", of: (d) => String(Array.isArray(d.productSlugs) ? d.productSlugs.length : 0) },
    imageOf: (d) => s(d.image) || undefined,
    subOf: (d) => `/industries/${s(d.slug)}`,
    ordered: true,
    emptyHint: "Import the website's current industries from the Dashboard, or add the first one.",
  },
  gallery: {
    kind: "gallery",
    title: "Gallery",
    subtitle: "The photos in the public gallery. Product photos are added automatically from Products.",
    noun: "photo",
    addLabel: "Add Photo",
    fields: GALLERY_FIELDS,
    blank: () => ({ category: "Factory", label: "", image: undefined }),
    meta: { header: "Category", of: (d) => s(d.category) },
    imageOf: (d) => s(d.image) || undefined,
    ordered: true,
    emptyHint: "Import the website's current gallery from the Dashboard, or add the first photo.",
  },
  job: {
    kind: "job",
    title: "Careers",
    subtitle: "The roles shown on the Career page.",
    noun: "job",
    addLabel: "Add Job",
    fields: JOB_FIELDS,
    blank: () => ({ title: "", department: "", location: "", type: "Full-time" }),
    meta: { header: "Department · Location", of: (d) => `${s(d.department)} · ${s(d.location)}` },
    ordered: true,
    emptyHint: "Import the website's current roles from the Dashboard, or add the first one.",
  },
  testimonial: {
    kind: "testimonial",
    title: "Testimonials",
    subtitle: "Customer quotes shown on the home page.",
    noun: "testimonial",
    addLabel: "Add Testimonial",
    fields: TESTIMONIAL_FIELDS,
    blank: () => ({ name: "", role: "", company: "", quote: "", initials: "" }),
    meta: { header: "Quote", of: (d) => (s(d.quote).length > 70 ? `${s(d.quote).slice(0, 70)}…` : s(d.quote)) },
    ordered: true,
    emptyHint: "Import the website's current testimonials from the Dashboard, or add the first one.",
  },
  milestone: {
    kind: "milestone",
    title: "Milestones",
    subtitle: "The company timeline on the About page.",
    noun: "milestone",
    addLabel: "Add Milestone",
    fields: MILESTONE_FIELDS,
    blank: () => ({ year: "", title: "", description: "" }),
    meta: { header: "Year", of: (d) => s(d.year) },
    ordered: true,
    emptyHint: "Import the website's current milestones from the Dashboard, or add the first one.",
  },
  seo: {
    kind: "seo",
    title: "SEO",
    subtitle: "What search engines and link previews show for each page. A blank field keeps the page's own.",
    noun: "SEO entry",
    addLabel: "Add Page Entry",
    fields: SEO_FIELDS,
    blank: () => ({ path: "/", label: "", title: undefined, description: undefined, ogImage: undefined }),
    meta: { header: "Search title", of: (d) => s(d.title) || "(page's own)" },
    subOf: (d) => s(d.path),
    ordered: false,
    emptyHint: "Import the website's current page descriptions from the Dashboard, or add an entry.",
  },
};

/* --------------------------------------------------------- path utilities */

export function getAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** An immutable set by dotted path. A numeric segment indexes an array. */
export function setAt<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const rec = (node: unknown, i: number): unknown => {
    const key = keys[i];
    const isIndex = /^\d+$/.test(key);
    const copy: unknown = Array.isArray(node) ? [...node] : { ...((node as Record<string, unknown>) ?? {}) };
    const next = i === keys.length - 1 ? value : rec((copy as Record<string, unknown>)[key], i + 1);
    if (next === undefined && !isIndex) {
      delete (copy as Record<string, unknown>)[key];
    } else {
      (copy as Record<string, unknown>)[key] = next;
    }
    return copy;
  };
  return rec(obj, 0) as T;
}
