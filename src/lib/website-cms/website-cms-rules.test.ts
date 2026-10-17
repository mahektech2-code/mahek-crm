import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildBundle, revisionOf, stableStringify, type ContentRowLike } from "./bundle";
import { bundleSchema, productSchema, seedSchema, slugField, mediaRef, hrefField, pageSchema, seoSchema, siteSettingsSchema, navigationSchema } from "./contract";
import { KINDS, KIND_KEYS, MODULE_SLUGS, PUBLISH_MODULE_KEY, isKind, moduleKeyFor, slugFromData, validateKindData } from "./kinds";
import { checkWebsiteImage, isMediaId, mediaIdsIn, mediaPublicPath, safeMediaFilename, sniffWebsiteImage, WEBSITE_IMAGE_MAX_BYTES } from "./media-types";
import { PREVIEW_MAX_TTL_SECONDS, signPreviewToken, verifyPreviewToken } from "./preview-token";
import { bearerMatches } from "./bearer";
import { moduleAllowed, modulesForApp } from "@/lib/modules";

/* ---------------------------------------------------------------------------
 * The Website CMS's rules, with no database: what the contract accepts, how the
 * bundle is built from rows, how a preview link is signed, what an image may be.
 * The database half is `website-cms.test.ts` (integration).
 * ------------------------------------------------------------------------- */

const product = (over: Record<string, unknown> = {}) => ({
  id: "MTI-90",
  slug: "test-thinner",
  name: "Test Thinner",
  icon: "flask",
  image: "/Mahek%20NC%20Thinner/Mahek%20N.C%20Thinner%20Combo.webp",
  imageScale: { grid: 2, heroMobile: 1, heroDesktop: 2 },
  tag: "Test",
  short: "A thinner for tests.",
  applications: ["Primer"],
  benefits: ["Fast"],
  industries: ["Paint"],
  packaging: ["1L"],
  specs: { Appearance: "Clear" },
  ...over,
});

const row = (over: Partial<ContentRowLike> & Pick<ContentRowLike, "kind" | "slug">): ContentRowLike => ({
  sort: 10,
  state: "published",
  data: {},
  publishedData: null,
  ...over,
});

describe("the kinds table", () => {
  it("every kind has a module, a schema and a label, and every module slug is a real Website module", () => {
    for (const k of KIND_KEYS) {
      const def = KINDS[k];
      assert.equal(def.key, k);
      assert.ok(MODULE_SLUGS.includes(def.moduleSlug), `${k} → ${def.moduleSlug}`);
      assert.ok(modulesForApp("website").some((m) => m.key === moduleKeyFor(k)), `${moduleKeyFor(k)} is registered`);
      assert.equal(typeof def.labelOf({}), "string");
    }
  });
  it("publishing is a separate, explicit-only module that no kind's edit module can imply", () => {
    const pub = modulesForApp("website").find((m) => m.key === PUBLISH_MODULE_KEY);
    assert.ok(pub?.explicitOnly && pub.offByDefault && pub.writeOf === "website.dashboard");
    for (const k of KIND_KEYS) assert.notEqual(moduleKeyFor(k), PUBLISH_MODULE_KEY);
    // A whole-app grant and an administrator both lack it; only its own row grants it.
    assert.equal(moduleAllowed(PUBLISH_MODULE_KEY, [], "website", false), false);
    assert.equal(moduleAllowed(PUBLISH_MODULE_KEY, [], "website", true), false);
    assert.equal(moduleAllowed(PUBLISH_MODULE_KEY, ["website.dashboard", PUBLISH_MODULE_KEY], "website", false), true);
    assert.equal(moduleAllowed("website.products", [], "website", false), true);
  });
  it("isKind refuses anything that is not a kind", () => {
    assert.equal(isKind("product"), true);
    for (const bad of ["", "Product", "__proto__", "constructor", null, undefined, 3, {}]) assert.equal(isKind(bad), false);
  });
  it("slugs come from the data where the kind has a natural one", () => {
    assert.equal(slugFromData("product", { slug: "nc-thinner" }), "nc-thinner");
    assert.equal(slugFromData("seo", { path: "/about" }), "/about");
    assert.equal(slugFromData("settings", {}), "site");
    assert.equal(slugFromData("navigation", {}), "site");
    assert.equal(slugFromData("job", { title: "x" }), null);
  });
});

describe("the content contract", () => {
  it("accepts a real product and returns the cleaned data", () => {
    const r = validateKindData("product", product({ name: "  Test Thinner  " }));
    assert.ok(r.ok);
    assert.equal(r.ok && r.data.name, "Test Thinner");
  });
  it("names every problem with its field path", () => {
    const r = validateKindData("product", product({ name: "", slug: "Bad Slug", imageScale: { grid: 0, heroMobile: 1, heroDesktop: 1 }, specs: { "": "x" } }));
    assert.equal(r.ok, false);
    const paths = !r.ok ? r.issues.map((i) => i.path) : [];
    for (const p of ["name", "slug", "imageScale.grid"]) assert.ok(paths.includes(p), `${p} in ${paths.join(",")}`);
  });
  it("slugs are lower-case words joined by single hyphens", () => {
    for (const ok of ["a", "nc-thinner", "mylac-135-melamine-thinner", "m1433"]) assert.ok(slugField.safeParse(ok).success, ok);
    for (const bad of ["", "Upper", "two  spaces", "under_score", "-x", "x-", "a--b", "a/b", "ünï"]) assert.equal(slugField.safeParse(bad).success, false, bad);
  });
  it("an image reference is a path on the site or an upload — never a full address, //host, javascript:, spaces or quotes", () => {
    for (const ok of ["/images/a.webp", "/Mahek%20NC%20Thinner/x.webp", "/cms-media/wm_abc12345/a.png"]) {
      assert.ok(mediaRef.safeParse(ok).success, ok);
    }
    for (const bad of ["", "//evil.com/a.png", "https://cdn.example.com/a.png", "javascript:alert(1)", "http://insecure.example.com/a.png", "/a b.png", '/a"b.png', "data:image/png;base64,AAAA", "images/a.png"]) {
      assert.equal(mediaRef.safeParse(bad).success, false, bad);
    }
  });
  it("a menu link is a path, an address, mailto or tel — with no spaces", () => {
    for (const ok of ["/", "/products", "https://example.com/x", "http://example.com", "mailto:a@b.com", "tel:+918108106253"]) assert.ok(hrefField.safeParse(ok).success, ok);
    for (const bad of ["", "products", "//x.com", "/a b", "javascript:alert(1)", "ftp://x.com"]) assert.equal(hrefField.safeParse(bad).success, false, bad);
  });
  it("a page's blocks must match their type and not be blank", () => {
    const page = (blocks: unknown[]) => pageSchema.safeParse({ title: "About", path: "/about", blocks });
    assert.ok(page([{ key: "hero.title", label: "Title", type: "text", value: "About us" }]).success);
    assert.ok(page([{ key: "x.list", label: "List", type: "list", value: ["a", "b"] }]).success);
    assert.equal(page([{ key: "hero.title", label: "Title", type: "text", value: "" }]).success, false);
    assert.equal(page([{ key: "hero.title", label: "Title", type: "text", value: ["a"] }]).success, false);
    assert.equal(page([{ key: "x", label: "L", type: "list", value: "not a list" }]).success, false);
  });
  it("SEO paths start with one slash and have no spaces", () => {
    assert.ok(seoSchema.safeParse({ path: "/products/nc-thinner", label: "NC" }).success);
    for (const bad of ["products", "//x", "/a b"]) assert.equal(seoSchema.safeParse({ path: bad, label: "x" }).success, false, bad);
  });
  it("settings and menus validate the values the public site depends on", () => {
    const settings = {
      company: { name: "Mahek Marketing India", tagline: "t", phoneDisplay: "+91 81081 06253", phoneHref: "tel:+918108106253", whatsappDisplay: "+91 81081 06253", whatsappHref: "https://wa.me/918108106253", email: "info@mahekindia.com", officeAddress: "Mumbai", plantAddress: "Ambernath", workingHours: "Mon–Sat" },
      stats: [{ value: 1190, suffix: "+", label: "Happy Customers", shortLabel: "Customers" }, { value: 15, suffix: " T", label: "Daily Production", shortLabel: "Daily Output" }],
      social: [{ label: "LinkedIn", href: null }, { label: "Facebook", href: "https://facebook.com/x" }],
      analyticsId: "G-9QL6FEYDRC",
    };
    assert.ok(siteSettingsSchema.safeParse(settings).success);
    assert.equal(siteSettingsSchema.safeParse({ ...settings, analyticsId: "UA-1" }).success, false);
    assert.equal(siteSettingsSchema.safeParse({ ...settings, stats: settings.stats.slice(0, 1) }).success, false, "the site reads the first two figures by position");
    assert.equal(siteSettingsSchema.safeParse({ ...settings, company: { ...settings.company, email: "nope" } }).success, false);
    assert.equal(siteSettingsSchema.safeParse({ ...settings, social: [{ label: "x", href: "javascript:alert(1)" }] }).success, false);
    assert.ok(navigationSchema.safeParse({ header: [{ label: "Home", href: "/" }, { label: "Products", href: "/products", mega: "products" }], manufacturingMega: [], footerCompany: [], footerQuick: [], legal: [] }).success);
    assert.equal(navigationSchema.safeParse({ header: [{ label: "x", href: "bad link", mega: "other" }], manufacturingMega: [], footerCompany: [], footerQuick: [], legal: [] }).success, false);
  });
});

describe("building the bundle the public site reads", () => {
  const rows: ContentRowLike[] = [
    row({ kind: "product", slug: "b", sort: 20, state: "published", data: product({ slug: "b", name: "B draft" }), publishedData: product({ slug: "b", name: "B live" }), publishedSort: 20 }),
    row({ kind: "product", slug: "a", sort: 10, state: "published", data: product({ id: "MTI-91", slug: "a" }), publishedData: product({ id: "MTI-91", slug: "a" }), publishedSort: 10 }),
    row({ kind: "product", slug: "c", sort: 30, state: "draft", data: product({ id: "MTI-92", slug: "c" }) }),
    row({ kind: "product", slug: "d", sort: 40, state: "archived", data: product({ id: "MTI-93", slug: "d" }) }),
  ];

  it("the live bundle has only published snapshots, in the PUBLISHED order, never the working copy", () => {
    const live = buildBundle(rows, { draft: false });
    assert.equal(live.draft, false);
    assert.deepEqual(live.products?.map((p) => p.slug), ["a", "b"]);
    assert.equal(live.products?.find((p) => p.slug === "b")?.name, "B live");
  });
  it("a preview has the working copy of everything not archived, in the editor's order", () => {
    const reordered = rows.map((r) => (r.slug === "b" ? { ...r, sort: 5 } : r));
    const preview = buildBundle(reordered, { draft: true });
    assert.deepEqual(preview.products?.map((p) => p.slug), ["b", "a", "c"]);
    assert.equal(preview.products?.find((p) => p.slug === "b")?.name, "B draft");
    const live = buildBundle(reordered, { draft: false });
    assert.deepEqual(live.products?.map((p) => p.slug), ["a", "b"], "live ignores the unpublished reorder");
  });
  it("a kind the CMS has never held is null; one it holds with nothing live is an empty list", () => {
    const only = buildBundle([row({ kind: "product", slug: "x", state: "draft", data: product() })], { draft: false });
    assert.equal(only.industries, null);
    assert.equal(only.settings, null);
    assert.deepEqual(only.products, []);
  });
  it("a one-row kind that is not published is null, so a settings draft cannot blank the site", () => {
    const b = buildBundle([row({ kind: "settings", slug: "site", state: "draft", data: {} })], { draft: false });
    assert.equal(b.settings, null);
  });
  it("pages become blockKey → value maps, and SEO becomes path → fields without the editor's label", () => {
    const b = buildBundle(
      [
        row({ kind: "page", slug: "about", state: "published", data: {}, publishedData: { title: "About", path: "/about", blocks: [{ key: "hero.title", label: "T", type: "text", value: "About us" }, { key: "l", label: "L", type: "list", value: ["a"] }] } }),
        row({ kind: "seo", slug: "/about", state: "published", data: {}, publishedData: { path: "/about", label: "About", title: "About | Mahek", description: "", noindex: false } }),
      ],
      { draft: false },
    );
    assert.deepEqual(b.pages, { about: { "hero.title": "About us", l: ["a"] } });
    assert.deepEqual(b.seo, { "/about": { title: "About | Mahek" } }, "blank fields and the label are not sent");
  });
  it("industries drop product slugs that are not live", () => {
    const b = buildBundle(
      [
        row({ kind: "product", slug: "live", state: "published", data: product({ slug: "live" }), publishedData: product({ slug: "live" }) }),
        row({ kind: "industry", slug: "i", state: "published", data: {}, publishedData: { slug: "i", name: "I", icon: "x", short: "s", productSlugs: ["live", "ghost"] } }),
      ],
      { draft: false },
    );
    assert.deepEqual(b.industries?.[0].productSlugs, ["live"]);
  });
  it("the output satisfies the contract the website validates", () => {
    const b = buildBundle(rows, { draft: false });
    assert.ok(bundleSchema.safeParse(b).success);
  });
  it("the revision is stable for the same content and changes with it", () => {
    const a = buildBundle(rows, { draft: false, now: new Date(0) });
    const b = buildBundle(rows, { draft: false, now: new Date(99999) });
    assert.equal(a.revision, b.revision, "the clock is not part of the content");
    const changed = buildBundle(rows.map((r) => (r.slug === "a" ? { ...r, publishedData: product({ id: "MTI-91", slug: "a", name: "Other" }) } : r)), { draft: false });
    assert.notEqual(a.revision, changed.revision);
    assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }));
    assert.equal(revisionOf({ x: 1 }).length, 16);
  });
});

describe("preview tokens", () => {
  const SECRET = "a-long-shared-publish-secret-0123456789";
  it("a fresh token verifies and carries its path", () => {
    const t = signPreviewToken(SECRET, { path: "/products/x" });
    const v = verifyPreviewToken(SECRET, t);
    assert.ok(v.ok);
    assert.equal(v.ok && v.payload.path, "/products/x");
  });
  it("is refused when expired, tampered, signed with another key or too long-lived", () => {
    const now = 1_800_000_000_000;
    const t = signPreviewToken(SECRET, { nowMs: now, ttlSeconds: 60 });
    assert.equal(verifyPreviewToken(SECRET, t, now + 61_000).ok, false);
    assert.equal(verifyPreviewToken("another-secret", t, now).ok, false);
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 1e6, path: "//evil" })).toString("base64url");
    assert.equal(verifyPreviewToken(SECRET, `${forged}.${sig}`, now).ok, false);
    assert.equal(verifyPreviewToken(SECRET, `${body}.AAAA`, now).ok, false);
    const longLived = signPreviewToken(SECRET, { nowMs: now, ttlSeconds: PREVIEW_MAX_TTL_SECONDS + 600 });
    assert.equal(verifyPreviewToken(SECRET, longLived, now).ok, false);
    for (const junk of ["", ".", "a", "a.b.c", "!!!.???"]) assert.equal(verifyPreviewToken(SECRET, junk, now).ok, false, junk);
  });
});

describe("what a website image may be", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  it("is decided by the bytes: png, jpeg, webp and gif — not svg, html or a renamed file", () => {
    assert.equal(sniffWebsiteImage(png), "image/png");
    assert.equal(sniffWebsiteImage(jpg), "image/jpeg");
    assert.equal(sniffWebsiteImage(gif), "image/gif");
    assert.equal(sniffWebsiteImage(webp), "image/webp");
    assert.equal(sniffWebsiteImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
    assert.equal(sniffWebsiteImage(new TextEncoder().encode("<html><script>alert(1)</script></html>")), null);
    assert.equal(sniffWebsiteImage(new TextEncoder().encode("RIFF....WAVEfmt ")), null, "RIFF alone is not WebP");
    assert.equal(sniffWebsiteImage(new Uint8Array(3)), null);
  });
  it("enforces the size limit and names the file in the refusal", () => {
    assert.equal(checkWebsiteImage("a.png", png).ok, true);
    const big = new Uint8Array(WEBSITE_IMAGE_MAX_BYTES + 1);
    big.set(png);
    const r = checkWebsiteImage("big.png", big);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /big\.png is 8\.0 MB\. The limit is 8 MB/);
    assert.match(String(!checkWebsiteImage("empty.png", new Uint8Array()).ok), /true/);
  });
  it("makes a URL-safe file name whose extension follows the true type", () => {
    assert.equal(safeMediaFilename("My Photo (1).PNG", "image/png"), "my-photo-1.png");
    assert.match(safeMediaFilename("../../etc/passwd.jpg", "image/webp"), /^[a-z0-9.-]+\.webp$/);
    assert.doesNotMatch(safeMediaFilename("../../etc/passwd.jpg", "image/webp"), /[\\/]/);
    assert.equal(safeMediaFilename("", "image/gif"), "image.gif");
    assert.equal(safeMediaFilename("ünï côdé.png", "image/png"), "uni-code.png");
    assert.ok(safeMediaFilename("x".repeat(500) + ".png", "image/png").length <= 64);
  });
  it("finds the uploaded files a piece of content points at, and validates ids", () => {
    const content = { image: "/cms-media/wm_abc12345-xyz/a.png", images: [{ src: "/cms-media/wm_other_123456/b.webp" }, { src: "/images/site.webp" }] };
    assert.deepEqual(mediaIdsIn(content).sort(), ["wm_abc12345-xyz", "wm_other_123456"]);
    assert.deepEqual(mediaIdsIn("nothing here"), []);
    assert.equal(mediaPublicPath("wm_abc12345", "a b.png"), "/cms-media/wm_abc12345/a%20b.png");
    for (const ok of ["wm_abc12345", "A-b_c-1234"]) assert.ok(isMediaId(ok), ok);
    for (const bad of ["short", "../x", "a/b/c/d/e/f", "wm abc12345", "x".repeat(65), ""]) assert.equal(isMediaId(bad), false, bad);
  });
});

describe("bearer check", () => {
  const req = (h?: string) => new Request("http://x", { headers: h ? { authorization: h } : {} });
  it("matches only the exact secret", () => {
    assert.equal(bearerMatches(req("Bearer s3cret"), "s3cret"), true);
    for (const h of [undefined, "", "Bearer ", "Bearer s3cre", "Bearer s3cret!", "Basic s3cret", "bearer s3cret", "Bearer  s3cret"]) {
      assert.equal(bearerMatches(req(h), "s3cret"), false, String(h));
    }
    assert.equal(bearerMatches(req("Bearer "), ""), false, "an empty secret matches nothing");
  });
});

describe("the contract fixture the website exports", () => {
  it("is exercised by seed.test.ts once the website's export is in place", () => {
    assert.ok(seedSchema && productSchema);
  });
});
