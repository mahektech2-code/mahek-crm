import { createHash } from "node:crypto";
import { seedSchema, type WebsiteSeed } from "./contract";
import { SINGLETON_SLUG, validateKindData, type KindKey } from "./kinds";

/* ---------------------------------------------------------------------------
 * TURNING THE WEBSITE'S EXPORTED CONTENT INTO ROWS.
 *
 * PURE. The seed is the complete content of mahekindia.com as it stands in the
 * website's code — products, industries, gallery tiles, jobs, testimonials,
 * milestones, settings, menus, every page's copy, every page's metadata — in the
 * same shape the public site reads (`WebsiteBundle`), plus the page-block
 * definitions and the list of image files that ship inside the site.
 *
 * Importing it is INSERT-ONLY and re-runnable (service.ts): what is already in
 * the CMS is never overwritten. Row slugs are therefore STABLE — derived from
 * the content, not from a counter — so running the import twice finds the same
 * rows rather than creating a second set.
 *
 * Nothing is invented here. A record that does not satisfy the contract is
 * REPORTED in `problems` and left out, so a data mistake in the website is
 * something a person sees, not something quietly "fixed".
 * ------------------------------------------------------------------------- */

export type SeedRow = { kind: KindKey; slug: string; sort: number; data: Record<string, unknown> };
export type SeedMedia = { path: string; label: string };
export type SeedPlan = { rows: SeedRow[]; media: SeedMedia[]; problems: string[]; detailSeoSkipped: number };

const short = (...parts: (string | undefined)[]) =>
  createHash("sha1").update(parts.map((p) => p ?? "").join("|")).digest("hex").slice(0, 10);

export function parseSeed(raw: unknown): { ok: true; seed: WebsiteSeed } | { ok: false; error: string } {
  const parsed = seedSchema.safeParse(raw);
  if (parsed.success) return { ok: true, seed: parsed.data };
  const first = parsed.error.issues[0];
  return { ok: false, error: `The website's content export is not in the expected shape (${first.path.join(".")}: ${first.message}).` };
}

export function seedToRows(seed: WebsiteSeed): SeedPlan {
  const rows: SeedRow[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  const add = (kind: KindKey, slug: string, sort: number, data: unknown, what: string) => {
    const key = `${kind}:${slug}`;
    if (seen.has(key)) {
      problems.push(`${what}: "${slug}" appears more than once in the website's content — only the first was imported.`);
      return;
    }
    const checked = validateKindData(kind, data);
    if (!checked.ok) {
      problems.push(`${what}: ${checked.issues.map((i) => `${i.path || "(record)"} — ${i.message}`).join("; ")}`);
      return;
    }
    seen.add(key);
    rows.push({ kind, slug, sort, data: checked.data });
  };

  const step = 10;
  (seed.products ?? []).forEach((p, i) => add("product", p.slug, i * step, p, `Product "${p.name ?? p.slug}"`));
  (seed.industries ?? []).forEach((x, i) => add("industry", x.slug, i * step, x, `Industry "${x.name ?? x.slug}"`));
  (seed.gallery ?? []).forEach((g, i) =>
    add("gallery", `g-${short(g.category, g.label, g.image)}`, i * step, g, `Gallery tile "${g.label}"`),
  );
  (seed.jobs ?? []).forEach((j, i) => add("job", `j-${short(j.title, j.department, j.location)}`, i * step, j, `Job "${j.title}"`));
  (seed.testimonials ?? []).forEach((t, i) =>
    add("testimonial", `t-${short(t.name, t.company)}`, i * step, t, `Testimonial from "${t.name}"`),
  );
  (seed.milestones ?? []).forEach((m, i) =>
    add("milestone", `m-${m.year}-${short(m.title)}`, i * step, m, `Milestone ${m.year}`),
  );

  if (seed.settings) add("settings", SINGLETON_SLUG, 0, seed.settings, "Site settings");
  if (seed.navigation) add("navigation", SINGLETON_SLUG, 0, seed.navigation, "Menus");

  Object.entries(seed.blockDefinitions).forEach(([pageKey, def], i) => {
    const values = seed.pages?.[pageKey] ?? {};
    add(
      "page",
      pageKey,
      i * step,
      {
        title: def.title,
        path: def.path,
        blocks: def.blocks.map((b) => ({
          key: b.key,
          label: b.label,
          type: b.type,
          value: values[b.key] ?? (b.type === "list" ? [] : ""),
        })),
      },
      `Page "${def.title}"`,
    );
  });

  const nameOfPath = (path: string): string => {
    if (path === "/") return "Home";
    const product = (seed.products ?? []).find((p) => path === `/products/${p.slug}`);
    if (product) return product.name;
    const industry = (seed.industries ?? []).find((x) => path === `/industries/${x.slug}`);
    if (industry) return industry.name;
    const page = Object.values(seed.blockDefinitions).find((d) => d.path === path);
    return page?.title ?? path;
  };
  /*
   * A product's or industry's own page already describes itself from its name and
   * summary. The website exports an entry for each of them (so nothing is lost
   * if one is wanted), but importing them as overrides would PIN the title and
   * description: renaming the product would then not change its page title.
   * They are left out; an override is added from SEO when one is wanted.
   */
  const DETAIL_PAGE = /^\/(products|industries)\/[^/]+$/;
  let detailSkipped = 0;
  Object.entries(seed.seo ?? {}).forEach(([path, entry], i) => {
    if (DETAIL_PAGE.test(path)) {
      detailSkipped += 1;
      return;
    }
    add("seo", path, i * step, { path, label: nameOfPath(path), ...entry }, `SEO entry for ${path}`);
  });

  /* ------------------------------------------------ things worth a person's eye */
  const productSlugs = new Set((seed.products ?? []).map((p) => p.slug));
  for (const ind of seed.industries ?? []) {
    for (const s of ind.productSlugs) {
      if (!productSlugs.has(s)) problems.push(`Industry "${ind.name}" lists product "${s}", which is not in the product list.`);
    }
  }

  const mediaPaths = new Map<string, string>();
  for (const m of seed.staticMedia) mediaPaths.set(m.path, m.label);
  const referenced = new Set<string>();
  const collect = (v: unknown) => {
    if (typeof v === "string") {
      if (v.startsWith("/") && !v.startsWith("//") && /\.(webp|jpe?g|png|gif|avif)$/i.test(v.split("?")[0])) referenced.add(v);
    } else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  rows.forEach((r) => collect(r.data));
  for (const path of referenced) {
    if (!mediaPaths.has(path)) problems.push(`Image ${path} is used by the content but is not in the website's list of image files.`);
  }

  return { rows, media: seed.staticMedia, problems, detailSeoSkipped: detailSkipped };
}
