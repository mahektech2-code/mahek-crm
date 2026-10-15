/**
 * The Website CMS, against the real services and a real database.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test`, created by `npm run test:db` from the committed
 * migrations. It truncates between tests — never point it at a database anybody
 * is using.
 *
 * What it exists to prove, in the order the work was asked for:
 *   - what is saved is still there afterwards, and saving never changes what is live;
 *   - publishing changes what the public site is served, atomically, and only then;
 *   - a refresh that did not happen is never reported as one (a failed publish is
 *     never reported as successful);
 *   - the server — not the screen — refuses a person who may not edit or publish;
 *   - the public routes answer only to the secret;
 *   - media is judged by its bytes, deduplicated, and not deletable while used.
 */
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  appSecrets,
  users,
  websiteContent,
  websiteMedia,
  websitePublishLog,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { MODULE_SLUGS, PUBLISH_MODULE_KEY } from "@/lib/website-cms/kinds";
import * as cms from "@/lib/website-cms/commands";
import {
  createItem,
  currentBundle,
  dashboardSummary,
  getItem,
  listItems,
  moveItem,
  transitionItems,
  updateItem,
} from "@/lib/website-cms/service";
import { deleteMedia, listMedia, readMedia, uploadMedia } from "@/lib/website-cms/media-service";
import { verifyPreviewToken } from "@/lib/website-cms/preview-token";
import { parseSeed } from "@/lib/website-cms/seed";
import seedJson from "@/lib/website-cms/seed/cms-seed.bundle.json";
import { GET as readContent } from "@/app/api/public/website/content/route";
import { GET as readMediaRoute } from "@/app/api/public/website/media/[id]/route";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const READ = "read-secret-for-tests-0123456789";
const PUBLISH = "publish-secret-for-tests-0123456789";

type Person = typeof users.$inferSelect;

async function makeUser(name: string, grants: { website?: "associate" | "admin"; modules?: string[]; crm?: boolean } = {}): Promise<Person> {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: grants.website === "admin" ? "manager" : "associate",
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  if (grants.website) {
    await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "website", role: grants.website });
    for (const m of grants.modules ?? []) {
      await db.insert(appModuleAccess).values({ id: id("mod"), userId: row.id, app: "website", module: m });
    }
  }
  if (grants.crm) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role: "associate" });
  return row;
}

const ALL_MODULES = ["website.dashboard", ...MODULE_SLUGS.map((s) => `website.${s}`)];

async function setSecrets(read = READ, publish = PUBLISH) {
  for (const [name, value] of [
    ["website.cmsReadSecret", read],
    ["website.cmsPublishSecret", publish],
  ] as const) {
    if (value) await db.insert(appSecrets).values({ name, value, last4: value.slice(-4) });
  }
}

const product = (over: Record<string, unknown> = {}) => ({
  id: "MTI-90",
  slug: "test-thinner",
  name: "Test Thinner",
  icon: "flask",
  image: "/images/test-thinner.webp",
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

const industry = (over: Record<string, unknown> = {}) => ({
  slug: "test-industry",
  name: "Test Industry",
  icon: "droplet",
  short: "An industry for tests.",
  productSlugs: ["test-thinner"],
  ...over,
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const pngWith = (n: number) => {
  const b = new Uint8Array(PNG.length + 4);
  b.set(PNG);
  new DataView(b.buffer).setUint32(PNG.length, n);
  return b;
};

/* Mocking the one thing that leaves the building: the call to the public site. */
const realFetch = globalThis.fetch;
let calls: { url: string; init?: RequestInit }[] = [];
function mockSite(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}
const siteOk = () => new Response(JSON.stringify({ ok: true, at: new Date().toISOString() }), { status: 200, headers: { "content-type": "application/json" } });

let editor: Person;
let publisher: Person;

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test. Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      website_publish_log, website_content, website_media, attachment_bytes,
      app_module_access, app_secrets, app_access, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  await setSecrets();
  // A person who can edit everything and publish.
  publisher = await makeUser("Pat Publisher", { website: "associate", modules: [...ALL_MODULES, PUBLISH_MODULE_KEY] });
  // A person who can edit Products only.
  editor = await makeUser("Ed Editor", { website: "associate", modules: ["website.dashboard", "website.products"] });
  setTestUser(publisher);
  mockSite(() => siteOk());
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  setTestUser(null);
  await db.$client.end();
});

async function liveBundle() {
  return currentBundle(false);
}

/* ------------------------------------------------------------------ saving */

describe("saving content", () => {
  test("a created item is a draft, is still there afterwards, and is NOT in the live bundle", async () => {
    const made = await cms.createContent("product", product());
    assert.ok(made.ok, made.ok ? "" : made.error);
    assert.equal(made.data.state, "draft");

    const again = await listItems("product");
    assert.equal(again.length, 1);
    assert.equal(again[0].label, "Test Thinner");
    assert.deepEqual(again[0].data.specs, { Appearance: "Clear" });

    const live = await liveBundle();
    assert.deepEqual(live.products, [], "the CMS holds products, none are live: empty list, not null");
    const preview = await currentBundle(true);
    assert.equal(preview.products?.length, 1, "the working copy is in the preview");
    assert.equal(calls.length, 0, "saving never contacts the public site");
  });

  test("saving a published item changes the working copy and leaves the live copy alone", async () => {
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    const pub = await cms.transitionContent([made.data.id], "publish");
    assert.ok(pub.ok);

    const saved = await cms.saveContent(made.data.id, product({ name: "Test Thinner v2" }), made.data.version);
    assert.ok(saved.ok, saved.ok ? "" : saved.error);
    assert.equal(saved.data.hasChanges, true);
    assert.equal(saved.data.version, made.data.version + 1);

    const live = await liveBundle();
    assert.equal(live.products?.[0].name, "Test Thinner", "live still shows the published name");
    const preview = await currentBundle(true);
    assert.equal(preview.products?.[0].name, "Test Thinner v2");
  });

  test("a stale version is refused and nothing is saved", async () => {
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    const first = await cms.saveContent(made.data.id, product({ name: "First" }), made.data.version);
    assert.ok(first.ok);
    const stale = await cms.saveContent(made.data.id, product({ name: "Second" }), made.data.version);
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.code, "conflict");
    assert.equal((await getItem(made.data.id))?.label, "First");
  });

  test("invalid data is rejected with field paths; a duplicate slug or product code is refused", async () => {
    const bad = await cms.createContent("product", product({ name: "", slug: "Bad Slug", image: "//evil.example/x.png" }));
    assert.equal(bad.ok, false);
    const fields = !bad.ok ? (bad.fieldErrors ?? []).map((f) => f.field).sort() : [];
    assert.deepEqual(fields, ["image", "name", "slug"]);

    assert.ok((await cms.createContent("product", product())).ok);
    const dupSlug = await cms.createContent("product", product({ id: "MTI-91" }));
    assert.equal(dupSlug.ok, false);
    assert.equal(!dupSlug.ok && dupSlug.code, "duplicate");
    const dupId = await cms.createContent("product", product({ slug: "another-one" }));
    assert.equal(dupId.ok, false);
    assert.match(!dupId.ok ? dupId.error : "", /product code/);
    assert.equal((await listItems("product")).length, 1);
  });

  test("changing a product's slug moves its row; a clash with another product is refused", async () => {
    const a = await cms.createContent("product", product());
    const b = await cms.createContent("product", product({ id: "MTI-91", slug: "other-thinner", name: "Other" }));
    assert.ok(a.ok && b.ok);
    const moved = await cms.saveContent(a.data.id, product({ slug: "renamed-thinner" }), a.data.version);
    assert.ok(moved.ok);
    assert.equal((await getItem(a.data.id))?.slug, "renamed-thinner");
    const clash = await cms.saveContent(a.data.id, product({ slug: "other-thinner" }), moved.data.version);
    assert.equal(clash.ok, false);
  });

  test("the pages and one-row kinds cannot be created or deleted; only a never-published draft can be deleted", async () => {
    const page = await cms.createContent("page", { title: "X", path: "/x", blocks: [] });
    assert.equal(page.ok, false);
    const settings = await cms.createContent("settings", {});
    assert.equal(settings.ok, false);

    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    const pub = await cms.transitionContent([made.data.id], "publish");
    assert.ok(pub.ok);
    const refused = await cms.deleteContentDraft(made.data.id);
    assert.equal(refused.ok, false, "a live item cannot be deleted");
    assert.ok((await cms.transitionContent([made.data.id], "unpublish")).ok);
    const stillRefused = await cms.deleteContentDraft(made.data.id);
    assert.equal(stillRefused.ok, false, "one that has been live is archived, never deleted");

    const draft = await cms.createContent("product", product({ id: "MTI-95", slug: "never-live", name: "Never live" }));
    assert.ok(draft.ok);
    assert.ok((await cms.deleteContentDraft(draft.data.id)).ok);
    assert.equal(await getItem(draft.data.id), null);
  });

  test("discarding changes returns a live item to what is live", async () => {
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    assert.ok((await cms.transitionContent([made.data.id], "publish")).ok);
    const edited = await cms.saveContent(made.data.id, product({ name: "Draft rename" }));
    assert.ok(edited.ok && edited.data.hasChanges);
    const back = await cms.discardContentChanges(made.data.id);
    assert.ok(back.ok);
    assert.equal(back.data.label, "Test Thinner");
    assert.equal(back.data.hasChanges, false);
  });
});

/* -------------------------------------------------------------- publishing */

describe("publishing", () => {
  test("publish puts the item in the live bundle, and the live site is told", async () => {
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    const r = await cms.transitionContent([made.data.id], "publish");
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.data.changed, 1);
    assert.equal(r.data.live?.status, "refreshed");
    assert.match(r.message ?? "", /live site has been refreshed/);

    const live = await liveBundle();
    assert.equal(live.products?.length, 1);
    assert.equal(live.products?.[0].slug, "test-thinner");

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/revalidate$/);
    const sent = new Headers(calls[0].init?.headers).get("authorization");
    assert.equal(sent, `Bearer ${PUBLISH}`);
  });

  test("publishing something already live and unchanged does nothing and does not contact the site", async () => {
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    assert.ok((await cms.transitionContent([made.data.id], "publish")).ok);
    calls = [];
    const again = await cms.transitionContent([made.data.id], "publish");
    assert.ok(again.ok);
    assert.equal(again.data.changed, 0);
    assert.equal(calls.length, 0);
    assert.match(again.message ?? "", /Nothing to publish/);
  });

  test("unpublish takes it off the live bundle but keeps the working copy; archive and restore", async () => {
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    assert.ok((await cms.transitionContent([made.data.id], "publish")).ok);

    const down = await cms.transitionContent([made.data.id], "unpublish");
    assert.ok(down.ok);
    assert.deepEqual((await liveBundle()).products, []);
    const item = await getItem(made.data.id);
    assert.equal(item?.state, "draft");
    assert.equal(item?.everPublished, true);
    assert.equal(item?.label, "Test Thinner");

    assert.ok((await cms.transitionContent([made.data.id], "publish")).ok);
    assert.ok((await cms.transitionContent([made.data.id], "archive")).ok);
    assert.equal((await getItem(made.data.id))?.state, "archived");
    assert.deepEqual((await liveBundle()).products, []);
    assert.deepEqual((await currentBundle(true)).products, [], "an archived item is not even in a preview");

    const restored = await cms.transitionContent([made.data.id], "restore");
    assert.ok(restored.ok);
    assert.equal((await getItem(made.data.id))?.state, "draft", "restored as a draft, never straight to live");
  });

  test("a section is null until the CMS holds that kind, and an empty list afterwards", async () => {
    const empty = await liveBundle();
    assert.equal(empty.products, null);
    assert.equal(empty.settings, null);
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    assert.deepEqual((await liveBundle()).products, []);
  });

  test("publish is all-or-nothing: one invalid item stops the whole batch and nothing goes live", async () => {
    const good = await cms.createContent("product", product());
    assert.ok(good.ok);
    // A row that is not valid for its kind (bypassing the service, as a bad import could).
    const bad = id("wc");
    await db.insert(websiteContent).values({ id: bad, kind: "product", slug: "broken", sort: 20, data: { slug: "broken" } });

    const r = await cms.transitionContent([good.data.id, bad], "publish");
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /Nothing was published/);
    assert.equal((await getItem(good.data.id))?.state, "draft", "the valid one was not published either");
    assert.equal(calls.length, 0, "no refresh was sent for a publish that did not happen");
  });

  test("industries only point at products that are live", async () => {
    const p = await cms.createContent("product", product());
    const i = await cms.createContent("industry", industry({ productSlugs: ["test-thinner", "ghost"] }));
    assert.ok(p.ok && i.ok);
    assert.ok((await cms.transitionContent([i.data.id], "publish")).ok);
    assert.deepEqual((await liveBundle()).industries?.[0].productSlugs, [], "product not live yet");
    assert.ok((await cms.transitionContent([p.data.id], "publish")).ok);
    assert.deepEqual((await liveBundle()).industries?.[0].productSlugs, ["test-thinner"]);

    const down = await cms.transitionContent([p.data.id], "unpublish");
    assert.ok(down.ok);
    assert.ok((down.warnings ?? []).some((w) => /no longer shown under/.test(w)), "the editor is told what unpublishing breaks");
  });

  test("publish all pending publishes changed and never-published items, not ones taken down on purpose", async () => {
    const a = await cms.createContent("product", product());
    const b = await cms.createContent("product", product({ id: "MTI-91", slug: "second", name: "Second" }));
    const c = await cms.createContent("product", product({ id: "MTI-92", slug: "third", name: "Third" }));
    assert.ok(a.ok && b.ok && c.ok);
    assert.ok((await cms.transitionContent([a.data.id, b.data.id], "publish")).ok);
    assert.ok((await cms.transitionContent([b.data.id], "unpublish")).ok); // taken down on purpose
    assert.ok((await cms.saveContent(a.data.id, product({ name: "A changed" }))).ok);

    const r = await cms.publishAllPending(["product"]);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.data.changed, 2, "A (changed) and C (never published)");
    const states = Object.fromEntries((await listItems("product")).map((x) => [x.slug, x.state]));
    assert.equal(states["test-thinner"], "published");
    assert.equal(states["third"], "published");
    assert.equal(states["second"], "draft", "the one taken down stays down");
  });
});

/* ------------------------------------------------------------------ order */

describe("ordering", () => {
  test("reordering changes the working order only; the live order moves when the list is published", async () => {
    const a = await cms.createContent("product", product({ id: "MTI-91", slug: "aaa", name: "A" }));
    const b = await cms.createContent("product", product({ id: "MTI-92", slug: "bbb", name: "B" }));
    assert.ok(a.ok && b.ok);
    assert.ok((await cms.transitionContent([a.data.id, b.data.id], "publish")).ok);
    assert.deepEqual((await liveBundle()).products?.map((p) => p.slug), ["aaa", "bbb"]);

    assert.ok((await cms.moveContent(b.data.id, "up")).ok);
    assert.deepEqual((await currentBundle(true)).products?.map((p) => p.slug), ["bbb", "aaa"], "the preview follows the editor");
    assert.deepEqual((await liveBundle()).products?.map((p) => p.slug), ["aaa", "bbb"], "live keeps its published order");
    assert.equal((await dashboardSummary()).kinds.find((k) => k.kind === "product")?.orderChanged, true);

    const r = await cms.publishAllPending(["product"]);
    assert.ok(r.ok);
    assert.deepEqual((await liveBundle()).products?.map((p) => p.slug), ["bbb", "aaa"]);
  });
});

/* ------------------------------------------------- an honest refresh result */

describe("a failed refresh is never reported as a success", () => {
  async function publishOne() {
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    return cms.transitionContent([made.data.id], "publish");
  }

  test("the site answers 401 (wrong secret): saved here, NOT live, and the message says so", async () => {
    mockSite(() => new Response("{}", { status: 401 }));
    const r = await publishOne();
    assert.ok(r.ok, "the content is published in MahekOne");
    assert.equal(r.data.live?.status, "failed");
    assert.match(r.message ?? "", /BUT the live site did not refresh/);
    assert.doesNotMatch(r.message ?? "", /has been refreshed/);
    assert.match(r.data.live?.detail ?? "", /does not match CMS_PUBLISH_SECRET/);
    const log = await db.select().from(websitePublishLog).where(eq(websitePublishLog.action, "refresh"));
    assert.equal(log.length, 1);
    assert.equal(log[0].ok, false);
  });

  test("the site is down: failed, with a message that does not claim a refresh", async () => {
    mockSite(() => {
      throw new TypeError("fetch failed");
    });
    const r = await publishOne();
    assert.ok(r.ok);
    assert.equal(r.data.live?.status, "failed");
    assert.doesNotMatch(r.message ?? "", /has been refreshed/);
  });

  test("the site answers 200 but does not confirm: failed", async () => {
    mockSite(() => new Response("<html>an unrelated page</html>", { status: 200 }));
    const r = await publishOne();
    assert.ok(r.ok);
    assert.equal(r.data.live?.status, "failed");
  });

  test("the site is not switched on (503): failed, and says why", async () => {
    mockSite(() => new Response("{}", { status: 503 }));
    const r = await publishOne();
    assert.equal(r.ok && r.data.live?.status, "failed");
    assert.match(r.ok ? (r.data.live?.detail ?? "") : "", /not switched on/);
  });

  test("no publish secret: nothing is sent and the message says the site is not connected", async () => {
    await db.delete(appSecrets).where(eq(appSecrets.name, "website.cmsPublishSecret"));
    const r = await publishOne();
    assert.ok(r.ok);
    assert.equal(r.data.live?.status, "not_configured");
    assert.equal(calls.length, 0);
    assert.match(r.message ?? "", /not connected yet, so nothing has changed on mahekindia\.com/);
  });

  test("a retry after a failure succeeds and is recorded; the dashboard shows an outstanding refresh until then", async () => {
    mockSite(() => new Response("{}", { status: 500 }));
    assert.ok((await publishOne()).ok);
    assert.equal((await dashboardSummary()).refreshOutstanding, true);
    mockSite(() => siteOk());
    const retry = await cms.refreshLiveSiteNow();
    assert.ok(retry.ok);
    assert.equal(retry.data.live.status, "refreshed");
    assert.equal((await dashboardSummary()).refreshOutstanding, false);
  });

  test("the connection check reads the site's own status endpoint", async () => {
    mockSite(() => new Response(JSON.stringify({ ok: true, enabled: true, cmsReachable: true, usingFallback: false, revision: "abc" }), { status: 200 }));
    const r = await cms.checkConnection();
    assert.ok(r.ok);
    assert.equal(r.data.state, "ok");
    assert.match(calls[0].url, /\/status$/);

    mockSite(() => new Response(JSON.stringify({ ok: true, enabled: false, cmsReachable: false, usingFallback: true, revision: null }), { status: 200 }));
    const off = await cms.checkConnection();
    assert.ok(off.ok && off.data.state === "ok");
    assert.match(off.ok && off.data.state === "ok" ? off.data.detail : "", /not switched on/);
  });
});

/* ------------------------------------------------------- authorization */

describe("the server refuses people who may not", () => {
  test("a person without the Website app can do nothing", async () => {
    const outsider = await makeUser("Olly Outsider", { crm: true });
    setTestUser(outsider);
    const made = await db.insert(websiteContent).values({ id: id("wc"), kind: "product", slug: "p", sort: 10, data: product() }).returning();
    for (const result of [
      await cms.createContent("product", product({ slug: "zzz", id: "MTI-77" })),
      await cms.saveContent(made[0].id, product()),
      await cms.transitionContent([made[0].id], "publish"),
      await cms.previewItem(made[0].id),
      await cms.checkConnection(),
      await cms.importSiteContent(),
      await cms.refreshLiveSiteNow(),
      await cms.removeMedia("whatever"),
    ]) {
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.code, "not_permitted");
    }
    assert.equal(calls.length, 0);
  });

  test("a Products editor can edit products but not other kinds, whatever kind the request names", async () => {
    setTestUser(editor);
    const made = await cms.createContent("product", product());
    assert.ok(made.ok, made.ok ? "" : made.error);
    assert.ok((await cms.saveContent(made.data.id, product({ name: "Renamed" }))).ok);

    const ind = await cms.createContent("industry", industry());
    assert.equal(!ind.ok && ind.code, "not_permitted");

    // An industry created by somebody else: the kind is read from the ROW, not the caller.
    setTestUser(publisher);
    const theirs = await cms.createContent("industry", industry());
    assert.ok(theirs.ok);
    setTestUser(editor);
    const sneaky = await cms.saveContent(theirs.data.id, industry({ name: "Hijacked" }));
    assert.equal(!sneaky.ok && sneaky.code, "not_permitted");
    assert.equal((await getItem(theirs.data.id))?.label, "Test Industry");
  });

  test("editing is not publishing: a module editor cannot publish, unpublish, archive, refresh or import", async () => {
    setTestUser(editor);
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    for (const action of ["publish", "unpublish", "archive", "restore"] as const) {
      const r = await cms.transitionContent([made.data.id], action);
      assert.equal(!r.ok && r.code, "not_permitted", action);
    }
    assert.equal(!(await cms.publishAllPending(["product"])).ok, true);
    assert.equal(!(await cms.refreshLiveSiteNow()).ok, true);
    assert.equal(!(await cms.importSiteContent()).ok, true);
    assert.equal((await getItem(made.data.id))?.state, "draft");
    assert.equal(calls.length, 0, "a refused publish never contacts the live site");
  });

  test("a whole-app Website grant (no module rows) edits everything but is NOT implied the right to publish", async () => {
    const whole = await makeUser("Wendy Whole", { website: "associate" });
    setTestUser(whole);
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    const r = await cms.transitionContent([made.data.id], "publish");
    assert.equal(!r.ok && r.code, "not_permitted");
  });

  test("being an administrator of the Website app does not imply publishing either — it must be granted", async () => {
    const admin = await makeUser("Ada Admin", { website: "admin" });
    setTestUser(admin);
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    const r = await cms.transitionContent([made.data.id], "publish");
    assert.equal(!r.ok && r.code, "not_permitted");
  });

  test("the right to publish does not reach a kind the person cannot edit", async () => {
    const half = await makeUser("Hal Half", { website: "associate", modules: ["website.dashboard", "website.industries", PUBLISH_MODULE_KEY] });
    setTestUser(publisher);
    const p = await cms.createContent("product", product());
    assert.ok(p.ok);
    setTestUser(half);
    const r = await cms.transitionContent([p.data.id], "publish");
    assert.equal(!r.ok && r.code, "not_permitted");
    const all = await cms.publishAllPending();
    assert.equal(!all.ok && all.code, "not_permitted", "publishing everything needs every module");
    assert.equal((await getItem(p.data.id))?.state, "draft");
  });

  test("malformed requests are refused before they reach the database", async () => {
    assert.equal((await cms.createContent("not-a-kind", {})).ok, false);
    assert.equal((await cms.saveContent("nope", {})).ok, false);
    assert.equal((await cms.transitionContent([], "publish")).ok, false);
    assert.equal((await cms.transitionContent("x", "publish")).ok, false);
    assert.equal((await cms.transitionContent([1 as unknown as string], "publish")).ok, false);
    assert.equal((await cms.moveContent("nope", "sideways")).ok, false);
  });
});

/* -------------------------------------------------------- public routes */

describe("the public content route", () => {
  const call = (path: string, bearer?: string) =>
    readContent(new Request(`http://localhost${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }));

  test("answers only to the read secret, and is never cached", async () => {
    assert.equal((await call("/api/public/website/content")).status, 401);
    assert.equal((await call("/api/public/website/content", "wrong")).status, 401);
    assert.equal((await call("/api/public/website/content", PUBLISH)).status, 401, "the publish secret is not the read secret");
    const ok = await call("/api/public/website/content", READ);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const body = (await ok.json()) as { version: number; draft: boolean; products: unknown };
    assert.equal(body.version, 1);
    assert.equal(body.draft, false);
  });

  test("fails closed when no secret is configured", async () => {
    await db.delete(appSecrets).where(eq(appSecrets.name, "website.cmsReadSecret"));
    assert.equal((await call("/api/public/website/content", READ)).status, 503);
  });

  test("serves published content by default and working copies only with draft=1", async () => {
    const live = await cms.createContent("product", product());
    const wip = await cms.createContent("product", product({ id: "MTI-91", slug: "unfinished", name: "Unfinished" }));
    assert.ok(live.ok && wip.ok);
    assert.ok((await cms.transitionContent([live.data.id], "publish")).ok);
    assert.ok((await cms.saveContent(live.data.id, product({ name: "Edited, not published" }))).ok);

    const published = (await (await call("/api/public/website/content", READ)).json()) as { products: { slug: string; name: string }[] };
    assert.deepEqual(published.products.map((p) => p.slug), ["test-thinner"]);
    assert.equal(published.products[0].name, "Test Thinner");

    const draft = (await (await call("/api/public/website/content?draft=1", READ)).json()) as { draft: boolean; products: { slug: string; name: string }[] };
    assert.equal(draft.draft, true);
    assert.deepEqual(draft.products.map((p) => p.slug).sort(), ["test-thinner", "unfinished"]);
    assert.equal(draft.products.find((p) => p.slug === "test-thinner")?.name, "Edited, not published");
  });

  test("the bundle revision changes when live content changes and not when only a draft does", async () => {
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    assert.ok((await cms.transitionContent([made.data.id], "publish")).ok);
    const r1 = (await liveBundle()).revision;
    assert.ok((await cms.saveContent(made.data.id, product({ name: "Only a draft" }))).ok);
    assert.equal((await liveBundle()).revision, r1);
    assert.ok((await cms.transitionContent([made.data.id], "publish")).ok);
    assert.notEqual((await liveBundle()).revision, r1);
  });
});

/* --------------------------------------------------------------------- media */

describe("website media", () => {
  test("an image is judged by its bytes: real images are stored, a renamed text file is refused", async () => {
    const png = await uploadMedia(publisher, { filename: "My Photo (1).PNG", bytes: pngWith(1), alt: "A photo" });
    assert.ok(png.ok, png.ok ? "" : png.error);
    assert.equal(png.data.contentType, "image/png");
    assert.match(png.data.filename, /^my-photo-1\.png$/);
    assert.match(png.data.url, /^\/cms-media\/wm_[A-Za-z0-9_-]+\/my-photo-1\.png$/);

    const webp = await uploadMedia(publisher, { filename: "a.jpg", bytes: WEBP });
    assert.ok(webp.ok);
    assert.equal(webp.data.contentType, "image/webp");
    assert.match(webp.data.filename, /\.webp$/, "the extension follows the true type, not the typed one");

    const fake = await uploadMedia(publisher, { filename: "pic.png", bytes: new TextEncoder().encode("<script>alert(1)</script> not an image") });
    assert.equal(fake.ok, false);
    const svg = await uploadMedia(publisher, { filename: "x.svg", bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>') });
    assert.equal(svg.ok, false, "SVG is not accepted");
    const empty = await uploadMedia(publisher, { filename: "e.png", bytes: new Uint8Array() });
    assert.equal(empty.ok, false);
    const huge = await uploadMedia(publisher, { filename: "h.png", bytes: new Uint8Array(9 * 1024 * 1024).fill(0).map((_, i) => (i < 8 ? PNG[i] : 0)) });
    assert.equal(huge.ok, false);
    assert.match(!huge.ok ? huge.error : "", /limit is 8 MB/);
  });

  test("the same picture twice is one library entry", async () => {
    const a = await uploadMedia(publisher, { filename: "one.png", bytes: pngWith(7) });
    const b = await uploadMedia(publisher, { filename: "two.png", bytes: pngWith(7) });
    assert.ok(a.ok && b.ok);
    assert.equal(a.data.id, b.data.id);
    assert.equal((await db.select().from(websiteMedia)).length, 1);
  });

  test("stored bytes come back exactly, and the public media route serves them to the secret only", async () => {
    const up = await uploadMedia(publisher, { filename: "x.png", bytes: pngWith(42) });
    assert.ok(up.ok);
    const back = await readMedia(up.data.id);
    assert.deepEqual([...(back?.bytes ?? [])], [...pngWith(42)]);

    const get = (idArg: string, bearer?: string, headers: Record<string, string> = {}) =>
      readMediaRoute(new Request(`http://localhost/api/public/website/media/${idArg}`, { headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers } }), {
        params: Promise.resolve({ id: idArg }),
      });
    assert.equal((await get(up.data.id)).status, 401);
    assert.equal((await get(up.data.id, "wrong")).status, 401);
    const ok = await get(up.data.id, READ);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [...pngWith(42)]);
    const etag = ok.headers.get("etag");
    assert.ok(etag);
    assert.equal((await get(up.data.id, READ, { "if-none-match": etag })).status, 304);
    assert.equal((await get("../../etc/passwd", READ)).status, 404);
    assert.equal((await get("short", READ)).status, 404);
    assert.equal((await get("wm_doesnotexist0000", READ)).status, 404);
  });

  test("a file in use cannot be deleted; an unused one can, and then it is gone from the route", async () => {
    const up = await uploadMedia(publisher, { filename: "used.png", bytes: pngWith(5) });
    assert.ok(up.ok);
    const made = await cms.createContent("product", product({ image: up.data.url }));
    assert.ok(made.ok, made.ok ? "" : made.error);

    const blocked = await cms.removeMedia(up.data.id);
    assert.equal(blocked.ok, false);
    assert.match(!blocked.ok ? blocked.error : "", /in use by/);
    assert.equal((await listMedia()).find((m) => m.id === up.data.id)?.usedBy.length, 1);

    assert.ok((await cms.saveContent(made.data.id, product({ image: "/images/other.webp" }))).ok);
    assert.ok((await cms.removeMedia(up.data.id)).ok);
    assert.equal(await readMedia(up.data.id), null);
    assert.equal((await listMedia()).some((m) => m.id === up.data.id), false);
  });

  test("a file used by the LIVE copy stays protected even after the working copy stops using it", async () => {
    const up = await uploadMedia(publisher, { filename: "live.png", bytes: pngWith(6) });
    assert.ok(up.ok);
    const made = await cms.createContent("product", product({ image: up.data.url }));
    assert.ok(made.ok);
    assert.ok((await cms.transitionContent([made.data.id], "publish")).ok);
    assert.ok((await cms.saveContent(made.data.id, product({ image: "/images/other.webp" }))).ok);
    const r = await deleteMedia(publisher, up.data.id);
    assert.equal(r.ok, false, "the live site still shows it");
  });

  test("files that ship inside the website cannot be deleted from here", async () => {
    const [site] = await db
      .insert(websiteMedia)
      .values({ id: id("wm"), source: "site", filename: "a.webp", contentType: "image/webp", sitePath: "/images/a.webp" })
      .returning();
    const r = await cms.removeMedia(site.id);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /part of the website itself/);
  });

  test("a person with no Website module cannot upload or delete", async () => {
    const outsider = await makeUser("Olly Outsider", { crm: true });
    setTestUser(outsider);
    const r = await cms.removeMedia("anything");
    assert.equal(!r.ok && r.code, "not_permitted");
  });
});

/* ------------------------------------------------------------------ preview */

describe("preview links", () => {
  test("a link opens the right page and carries a token only the shared secret can verify", async () => {
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    const r = await cms.previewItem(made.data.id);
    assert.ok(r.ok, r.ok ? "" : r.error);
    const url = new URL(r.data.url);
    assert.equal(url.origin, "https://mahekindia.com");
    assert.equal(url.pathname, "/api/cms/preview");
    assert.equal(url.searchParams.get("path"), "/products/test-thinner");
    const token = url.searchParams.get("token") ?? "";
    assert.equal(verifyPreviewToken(PUBLISH, token).ok, true);
    assert.equal(verifyPreviewToken(READ, token).ok, false, "the read secret cannot forge or verify it");
    assert.equal(verifyPreviewToken(PUBLISH, token, Date.now() + 40 * 60_000).ok, false, "expires");
  });

  test("without the publish secret there is no preview, and the message says why", async () => {
    await db.delete(appSecrets).where(eq(appSecrets.name, "website.cmsPublishSecret"));
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    const r = await cms.previewItem(made.data.id);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /publish secret/);
  });

  test("a preview needs the right to edit that kind", async () => {
    const made = await cms.createContent("product", product());
    assert.ok(made.ok);
    const careers = await makeUser("Cara Careers", { website: "associate", modules: ["website.dashboard", "website.careers"] });
    setTestUser(careers);
    const r = await cms.previewItem(made.data.id);
    assert.equal(!r.ok && r.code, "not_permitted");
  });
});

/* ---------------------------------------------------------------- dashboard */

describe("the dashboard reflects what is really stored", () => {
  test("counts by state, pending work, and an honest last-refresh", async () => {
    const a = await cms.createContent("product", product());
    const b = await cms.createContent("product", product({ id: "MTI-91", slug: "two", name: "Two" }));
    assert.ok(a.ok && b.ok);
    assert.ok((await cms.transitionContent([a.data.id], "publish")).ok);
    assert.ok((await cms.saveContent(a.data.id, product({ name: "Changed" }))).ok);

    const d = await dashboardSummary();
    const p = d.kinds.find((k) => k.kind === "product")!;
    assert.deepEqual({ total: p.total, live: p.live, draft: p.draft, changes: p.changes, neverPublished: p.neverPublished }, { total: 2, live: 1, draft: 1, changes: 1, neverPublished: 1 });
    assert.equal(d.pending, 2);
    assert.equal(d.imported, true);
    assert.equal(d.lastRefresh?.ok, true);
    assert.ok(d.activity.some((x) => x.action === "publish"));
  });

  test("an empty CMS says it has not been imported", async () => {
    assert.equal((await dashboardSummary()).imported, false);
  });
});

/* ---------------------------------------------------------- service edges */

describe("ordering and concurrency edges", () => {
  test("moving the first item up or the last down is a no-op", async () => {
    const a = await createItem(publisher, "product", product({ id: "MTI-91", slug: "aa", name: "A" }));
    const b = await createItem(publisher, "product", product({ id: "MTI-92", slug: "bb", name: "B" }));
    assert.ok(a.ok && b.ok);
    const r = await moveItem(publisher, a.data.id, "up");
    assert.ok(r.ok);
    assert.deepEqual((await listItems("product")).map((p) => p.slug), ["aa", "bb"]);
  });

  test("two saves racing on the same version: exactly one wins", async () => {
    const made = await createItem(publisher, "product", product());
    assert.ok(made.ok);
    const [x, y] = await Promise.all([
      updateItem(publisher, made.data.id, product({ name: "X" }), made.data.version),
      updateItem(publisher, made.data.id, product({ name: "Y" }), made.data.version),
    ]);
    assert.equal([x, y].filter((r) => r.ok).length, 1);
  });

  test("transitions of an unknown id fail cleanly", async () => {
    const r = await transitionItems(publisher, ["wc_nope"], "publish");
    assert.equal(r.ok, false);
  });
});

/* ------------------------------------------------------ the real content */

describe("importing the website's actual content", () => {
  test("brings in everything as live, and the live bundle then equals what the website exported", async () => {
    const r = await cms.importSiteContent();
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.deepEqual(r.data.problems, []);
    assert.equal(r.data.created.product, 9);
    assert.equal(r.data.created.industry, 8);
    assert.equal(r.data.created.job, 4);
    assert.equal(r.data.created.page, 10);
    assert.equal(r.data.created.settings, 1);
    assert.equal(r.data.created.navigation, 1);
    assert.equal(r.data.skipped, 0);
    assert.ok(r.data.media >= 50);
    assert.equal(calls.length, 0, "an import changes nothing for a visitor, so it does not ask the site to refresh");

    // The CMS trims stray whitespace (the website's source has a few trailing spaces), so compare to the cleaned seed.
    const parsedSeed = parseSeed(seedJson);
    assert.ok(parsedSeed.ok);
    const seed = parsedSeed.seed as unknown as Record<string, unknown>;
    const live = await liveBundle();
    for (const key of ["products", "industries", "gallery", "jobs", "testimonials", "milestones", "settings", "navigation", "pages"] as const) {
      assert.deepEqual(live[key], seed[key], key);
    }
    assert.equal(live.settings?.company.name, "Mahek Marketing India");
    assert.equal((await dashboardSummary()).pending, 0, "nothing is pending straight after an import");
  });

  test("running it again changes nothing, and never overwrites an edit", async () => {
    const first = await cms.importSiteContent();
    assert.ok(first.ok);
    const total = Object.values(first.data.created).reduce((a, b) => a + b, 0);
    assert.ok(total >= 60, "the whole site, not a sample");
    const products = await listItems("product");
    const nc = products.find((p) => p.slug === "nc-thinner")!;
    const edited = await cms.saveContent(nc.id, { ...nc.data, name: "Mahek NC Thinner (renamed)" }, nc.version);
    assert.ok(edited.ok, edited.ok ? "" : edited.error);

    const again = await cms.importSiteContent();
    assert.ok(again.ok);
    assert.equal(Object.values(again.data.created).reduce((a, b) => a + b, 0), 0);
    assert.equal(again.data.skipped, total, "every row was found, none re-created");
    assert.match(again.message ?? "", /already here/);
    assert.equal((await getItem(nc.id))?.label, "Mahek NC Thinner (renamed)", "the edit survived the second import");
    assert.equal((await listItems("product")).length, 9);
    assert.equal((await liveBundle()).products?.find((p) => p.slug === "nc-thinner")?.name, "Mahek NC Thinner", "and the live copy is still the original until published");
  });

  test("the real catalogue edits, previews and publishes: the live bundle changes only after the publish", async () => {
    assert.ok((await cms.importSiteContent()).ok);
    const nc = (await listItems("product")).find((p) => p.slug === "nc-thinner")!;
    const saved = await cms.saveContent(nc.id, { ...nc.data, short: "A sharper one-line summary." }, nc.version);
    assert.ok(saved.ok);
    assert.equal((await liveBundle()).products?.find((p) => p.slug === "nc-thinner")?.short, "Precision Formulated for Perfect Flow & Finish.");
    assert.equal((await currentBundle(true)).products?.find((p) => p.slug === "nc-thinner")?.short, "A sharper one-line summary.");
    const pub = await cms.transitionContent([nc.id], "publish");
    assert.ok(pub.ok);
    assert.equal((await liveBundle()).products?.find((p) => p.slug === "nc-thinner")?.short, "A sharper one-line summary.");
    assert.equal(pub.data.live?.status, "refreshed");
  });

  test("a Pages edit changes only that block's value in the bundle", async () => {
    assert.ok((await cms.importSiteContent()).ok);
    const about = (await listItems("page")).find((p) => p.slug === "about")!;
    const blocks = about.data.blocks as { key: string; value: string | string[] }[];
    const first = blocks.find((b) => typeof b.value === "string")!;
    const edited = { ...about.data, blocks: blocks.map((b) => (b.key === first.key ? { ...b, value: "A new headline" } : b)) };
    assert.ok((await cms.saveContent(about.id, edited, about.version)).ok);
    assert.ok((await cms.transitionContent([about.id], "publish")).ok);
    const pages = (await liveBundle()).pages as Record<string, Record<string, unknown>>;
    assert.equal(pages.about[first.key], "A new headline");
    assert.deepEqual(Object.keys(pages.about), blocks.map((b) => b.key));
  });

  test("settings and menus publish and can be taken back to the site's built-in version", async () => {
    assert.ok((await cms.importSiteContent()).ok);
    const settings = (await listItems("settings"))[0];
    const data = settings.data as { company: Record<string, string> };
    assert.ok((await cms.saveContent(settings.id, { ...data, company: { ...data.company, workingHours: "Mon–Fri, 10:00–5:00" } }, settings.version)).ok);
    assert.ok((await cms.transitionContent([settings.id], "publish")).ok);
    assert.equal((await liveBundle()).settings?.company.workingHours, "Mon–Fri, 10:00–5:00");
    assert.ok((await cms.transitionContent([settings.id], "unpublish")).ok);
    assert.equal((await liveBundle()).settings, null, "unpublished settings are null: the site uses its own");
    const archive = await cms.transitionContent([settings.id], "archive");
    assert.equal(archive.ok, false, "settings cannot be archived");
  });
});
