import { createHash } from "node:crypto";
import { CONTENT_VERSION, type WebsiteBundle } from "./contract";
import type { KindKey } from "./kinds";

/* ---------------------------------------------------------------------------
 * BUILDING THE BUNDLE THE PUBLIC SITE READS.
 *
 * PURE: rows in, bundle out — the route handler loads the rows, this decides
 * what the website is shown. Keeping the decision here means it is tested
 * without a database, and it is the one place that says:
 *
 *   - a PUBLISHED bundle contains only published snapshots (`publishedData`),
 *     so saving a draft can never change the live site;
 *   - a DRAFT bundle (a preview) contains the working copy of everything not
 *     archived, so an editor sees their unpublished product on the real page;
 *   - a section is `null` ONLY when the CMS has never held that kind — the
 *     website then keeps its own static copy. An empty list means the CMS
 *     manages the section and nothing is live, so the page shows nothing;
 *   - a one-row kind (settings, menus) that exists but is not published is
 *     `null` too — an unpublished settings draft must not blank the site.
 * ------------------------------------------------------------------------- */

export type ContentRowLike = {
  kind: string;
  slug: string;
  sort: number;
  /** The position on the live site; falls back to `sort` for a row that predates it. */
  publishedSort?: number | null;
  state: "draft" | "published" | "archived";
  data: Record<string, unknown>;
  publishedData: Record<string, unknown> | null;
};

type Pick = (row: ContentRowLike) => Record<string, unknown> | null;

export function buildBundle(rows: ContentRowLike[], opts: { draft: boolean; now?: Date }): WebsiteBundle {
  const pick: Pick = opts.draft
    ? (r) => (r.state === "archived" ? null : r.data)
    : (r) => (r.state === "published" ? r.publishedData : null);

  const byKind = new Map<string, ContentRowLike[]>();
  for (const r of rows) {
    const list = byKind.get(r.kind) ?? [];
    list.push(r);
    byKind.set(r.kind, list);
  }
  // A preview follows the editor's order; the live site follows the order that was last PUBLISHED.
  const position = (r: ContentRowLike) => (opts.draft ? r.sort : (r.publishedSort ?? r.sort));
  const held = (kind: KindKey) => (byKind.get(kind)?.length ?? 0) > 0;

  const ordered = (kind: KindKey) =>
    (byKind.get(kind) ?? [])
      .slice()
      .sort((a, b) => position(a) - position(b) || a.slug.localeCompare(b.slug))
      .map((r) => ({ row: r, data: pick(r) }))
      .filter((x): x is { row: ContentRowLike; data: Record<string, unknown> } => x.data !== null);

  const list = <T,>(kind: KindKey): T[] | null =>
    held(kind) ? (ordered(kind).map((x) => x.data) as T[]) : null;

  const single = <T,>(kind: KindKey): T | null => {
    const found = ordered(kind)[0];
    return found ? (found.data as T) : null;
  };

  // Industries name products by slug; a link to a product that is not live would
  // be a dead card, so the published bundle only keeps the ones that are.
  const products = list<WebsiteBundle["products"] extends (infer P)[] | null ? P : never>("product");
  const liveProductSlugs = products ? new Set(products.map((p) => (p as { slug: string }).slug)) : null;
  const industriesRaw = list<{ slug: string; productSlugs: string[] }>("industry");
  const industries =
    industriesRaw && liveProductSlugs
      ? industriesRaw.map((i) => ({ ...i, productSlugs: i.productSlugs.filter((s) => liveProductSlugs.has(s)) }))
      : industriesRaw;

  let pages: WebsiteBundle["pages"] = null;
  if (held("page")) {
    pages = {};
    for (const { row, data } of ordered("page")) {
      const blocks = (data.blocks as { key: string; value: string | string[] }[] | undefined) ?? [];
      pages[row.slug] = Object.fromEntries(blocks.map((b) => [b.key, b.value]));
    }
  }

  let seo: WebsiteBundle["seo"] = null;
  if (held("seo")) {
    seo = {};
    for (const { data } of ordered("seo")) {
      const entry: { title?: string; description?: string; ogImage?: string; noindex?: boolean } = {};
      if (typeof data.title === "string" && data.title.trim()) entry.title = data.title;
      if (typeof data.description === "string" && data.description.trim()) entry.description = data.description;
      if (typeof data.ogImage === "string" && data.ogImage.trim()) entry.ogImage = data.ogImage;
      if (data.noindex === true) entry.noindex = true;
      seo[String(data.path)] = entry;
    }
  }

  const sections = {
    settings: single<WebsiteBundle["settings"] & object>("settings"),
    navigation: single<WebsiteBundle["navigation"] & object>("navigation"),
    products,
    industries,
    gallery: list("gallery"),
    jobs: list("job"),
    testimonials: list("testimonial"),
    milestones: list("milestone"),
    pages,
    seo,
  } as Omit<WebsiteBundle, "version" | "draft" | "revision" | "generatedAt">;

  return {
    version: CONTENT_VERSION,
    draft: opts.draft,
    revision: revisionOf(sections),
    generatedAt: (opts.now ?? new Date()).toISOString(),
    ...sections,
  };
}

/** A short hash of what the bundle CONTAINS, so the website and the dashboard can tell "changed" from "same". */
export function revisionOf(sections: object): string {
  return createHash("sha256").update(stableStringify(sections)).digest("hex").slice(0, 16);
}

/** JSON with sorted object keys: the same content always hashes the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}
