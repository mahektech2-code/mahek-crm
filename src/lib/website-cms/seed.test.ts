import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import seedJson from "./seed/cms-seed.bundle.json";
import { buildBundle, type ContentRowLike } from "./bundle";
import { bundleSchema } from "./contract";
import { parseSeed, seedToRows } from "./seed";

/* ---------------------------------------------------------------------------
 * THE WEBSITE'S EXPORTED CONTENT — the contract fixture.
 *
 * `seed/cms-seed.bundle.json` is produced by the website repository
 * (`npm run cms:seed`) from the content in its code, and the website validates
 * the same file in ITS tests. If a field is added on either side and not the
 * other, one of the two suites stops here.
 *
 * The strongest check is the round trip: import the seed, build the LIVE bundle
 * back out of the imported rows, and require it to equal what the website
 * exported — so importing demonstrably loses nothing and invents nothing, and
 * the day the CMS is switched on the site shows exactly what it showed before.
 * ------------------------------------------------------------------------- */

const parsed = parseSeed(seedJson);
assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
const seed = parsed.seed;
const plan = seedToRows(seed);

describe("the website's content export", () => {
  it("satisfies the contract (the same shape the website validates)", () => {
    assert.ok(bundleSchema.safeParse({ ...seed, blockDefinitions: undefined, staticMedia: undefined }).success);
    assert.equal(seed.version, 1);
    assert.equal(seed.draft, false);
  });

  it("holds every real record, not a sample", () => {
    assert.equal(seed.products?.length, 9);
    assert.equal(seed.industries?.length, 8);
    assert.equal(seed.jobs?.length, 4);
    assert.equal(seed.testimonials?.length, 4);
    assert.equal(seed.milestones?.length, 8);
    assert.equal(Object.keys(seed.blockDefinitions).length, 10);
    assert.ok((seed.staticMedia.length ?? 0) >= 50);
    assert.equal(seed.settings?.company.name, "Mahek Marketing India", "the real company, not 'Mahek Chemicals'");
    assert.equal(seed.settings?.company.phoneDisplay, "+91 81081 06253");
  });

  it("imports with no problems: every record satisfies the contract and every reference resolves", () => {
    assert.deepEqual(plan.problems, []);
  });

  it("row slugs are unique per kind and stable (importing twice finds the same rows)", () => {
    const keys = plan.rows.map((r) => `${r.kind}:${r.slug}`);
    assert.equal(new Set(keys).size, keys.length);
    const again = seedToRows(seed);
    assert.deepEqual(again.rows.map((r) => `${r.kind}:${r.slug}`), keys);
  });

  it("preserves existing addresses and product codes", () => {
    const products = plan.rows.filter((r) => r.kind === "product");
    assert.deepEqual(
      products.map((p) => p.slug),
      ["universal-thinner", "nc-thinner", "pu-thinner", "nano-thinner", "mylac-135-melamine-thinner", "mahek-epoxy-thinner", "mahek-polish-thinner-m1433", "mahek-mild-cleaner-m164", "enamel-gp-thinner"],
    );
    assert.deepEqual(products.map((p) => (p.data as { id: string }).id), ["MTI-01", "MTI-02", "MTI-03", "MTI-04", "MTI-07", "MTI-08", "MTI-09", "MTI-10", "MTI-11"]);
  });

  it("does not pin product and industry page titles: their entries are left out as overrides", () => {
    const seoPaths = plan.rows.filter((r) => r.kind === "seo").map((r) => r.slug);
    assert.ok(seoPaths.includes("/about"));
    assert.ok(!seoPaths.some((p) => /^\/(products|industries)\/[^/]+$/.test(p)));
    assert.equal(plan.detailSeoSkipped, 17, "9 products + 8 industries");
  });

  it("round trip: the live bundle rebuilt from the imported rows equals what the website exported", () => {
    const rows: ContentRowLike[] = plan.rows.map((r) => ({
      kind: r.kind,
      slug: r.slug,
      sort: r.sort,
      publishedSort: r.sort,
      state: "published",
      data: r.data,
      publishedData: r.data,
    }));
    const live = buildBundle(rows, { draft: false });
    assert.deepEqual(live.products, seed.products);
    assert.deepEqual(live.industries, seed.industries);
    assert.deepEqual(live.gallery, seed.gallery);
    assert.deepEqual(live.jobs, seed.jobs);
    assert.deepEqual(live.testimonials, seed.testimonials);
    assert.deepEqual(live.milestones, seed.milestones);
    assert.deepEqual(live.settings, seed.settings);
    assert.deepEqual(live.navigation, seed.navigation);
    assert.deepEqual(live.pages, seed.pages);
    const expectedSeo = Object.fromEntries(Object.entries(seed.seo ?? {}).filter(([p]) => !/^\/(products|industries)\/[^/]+$/.test(p)));
    assert.deepEqual(live.seo, expectedSeo);
  });

  it("every page block the website defines is imported with its value", () => {
    for (const [pageKey, def] of Object.entries(seed.blockDefinitions)) {
      const row = plan.rows.find((r) => r.kind === "page" && r.slug === pageKey);
      assert.ok(row, pageKey);
      const blocks = (row!.data as { blocks: { key: string; type: string; value: unknown }[] }).blocks;
      assert.deepEqual(blocks.map((b) => b.key), def.blocks.map((b) => b.key));
      for (const b of blocks) {
        assert.ok(b.type === "list" ? Array.isArray(b.value) : typeof b.value === "string" && b.value.trim() !== "", `${pageKey}.${b.key}`);
      }
    }
  });

  it("lists every image file that ships with the site, and every image a record uses is one of them", () => {
    const listed = new Set(plan.media.map((m) => m.path));
    const used = new Set<string>();
    const walk = (v: unknown) => {
      if (typeof v === "string") {
        if (v.startsWith("/") && /\.(webp|jpe?g|png|gif)$/i.test(v)) used.add(v);
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    plan.rows.forEach((r) => walk(r.data));
    for (const p of used) assert.ok(listed.has(p), p);
  });
});
