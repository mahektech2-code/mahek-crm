/**
 * The website review workflow, against the real services and a real database.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test`, created by `npm run test:db` from the committed
 * migrations. It truncates between tests — never point it at a database anybody
 * is using.
 *
 * EVERYTHING HERE CALLS THE COMMANDS DIRECTLY, as a person signed in with a
 * given set of grants (`setTestUser`) — never through a screen. That is the point
 * of the commands being their own layer: a server action is a URL, a hidden
 * button is not a permission, and what a screen would have drawn is not under
 * test. Where a rule lives in the service rather than a command (concurrency,
 * the sweep), the service is called with an explicit person instead.
 *
 * What it exists to prove, in the order the work was asked for:
 *   - the server, from the database row, refuses whoever may not assign, edit,
 *     submit, decide or publish — and remembers having refused them;
 *   - an approval covers exactly what was reviewed, and one difference voids it;
 *   - an item is in at most one open request, and is freed by every way a
 *     request can end;
 *   - publishing an approved request publishes ITS items and nothing else — in
 *     particular not the working order of the whole list;
 *   - with assignments off (the default, and what a missing setting means)
 *     nobody who could edit before has lost anything.
 */
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  appSecrets,
  auditLog,
  users,
  websiteAssignment,
  websiteChangeItem,
  websiteChangeRequest,
  websiteContent,
  websitePublishLog,
  websiteReviewSetting,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import type { Result } from "@/lib/result";
import { MODULE_SLUGS, PUBLISH_MODULE_KEY, REVIEW_MODULE_KEY } from "@/lib/website-cms/kinds";
import * as cms from "@/lib/website-cms/commands";
import { assignmentsEnforced } from "@/lib/website-cms/access";
import * as review from "@/lib/website-cms/review-service";
import { createItem, currentBundle, listItems, orderChangedKinds, transitionItems } from "@/lib/website-cms/service";
import { uploadMedia } from "@/lib/website-cms/media-service";
import { GET as editorMedia } from "@/app/api/website/media/[id]/route";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

type Person = typeof users.$inferSelect;

async function makeUser(name: string, grants: { website?: "associate" | "admin"; modules?: string[] } = {}): Promise<Person> {
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
  return row;
}

const CONTENT_MODULES = MODULE_SLUGS.map((s) => `website.${s}`);
const ALL_CONTENT = ["website.dashboard", ...CONTENT_MODULES];

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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1]);
const pngWith = (n: number) => {
  const b = new Uint8Array(PNG.length + 4);
  b.set(PNG);
  new DataView(b.buffer).setUint32(PNG.length, n);
  return b;
};

/* The one thing that leaves the building: the call telling the public site to refresh. */
const realFetch = globalThis.fetch;
let calls: string[] = [];
function mockSite() {
  calls = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, at: new Date().toISOString() }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

let pat: Person; //   publishes, edits everything
let rita: Person; //  reviews; holds no content module at all
let rex: Person; //   reviews AND edits everything
let eva: Person; //   an editor: content modules, no publish, no review
let eli: Person; //   an editor of Products only
let nia: Person; //   holds the Website app, nothing inside it but the dashboard
let appOnly: Person; // a whole-app grant with no module rows: every content module, never publish or review
let adam: Person; //  holds the Website app AS ADMINISTRATOR

const as = (p: Person) => setTestUser(p);

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test. Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      website_change_item, website_change_request, website_assignment,
      website_publish_log, website_content, website_media, attachment_bytes,
      audit_log, app_module_access, app_secrets, app_access, users, app_settings
    restart identity cascade
  `);
  // `users` cascades into the setting row; put it back the way the migration leaves it.
  await db.insert(websiteReviewSetting).values({ id: "site", enforceAssignments: false }).onConflictDoNothing();
  invalidateConfig();
  await seedConfig();
  for (const [name, value] of [
    ["website.cmsReadSecret", "read-secret-for-tests-0123456789"],
    ["website.cmsPublishSecret", "publish-secret-for-tests-0123456789"],
  ] as const) {
    await db.insert(appSecrets).values({ name, value, last4: value.slice(-4) });
  }
  pat = await makeUser("Pat Publisher", { website: "associate", modules: [...ALL_CONTENT, PUBLISH_MODULE_KEY] });
  rita = await makeUser("Rita Reviewer", { website: "associate", modules: ["website.dashboard", REVIEW_MODULE_KEY] });
  rex = await makeUser("Rex Both", { website: "associate", modules: [...ALL_CONTENT, REVIEW_MODULE_KEY] });
  eva = await makeUser("Eva Editor", { website: "associate", modules: ALL_CONTENT });
  eli = await makeUser("Eli Editor", { website: "associate", modules: ["website.dashboard", "website.products"] });
  nia = await makeUser("Nia Nothing", { website: "associate", modules: ["website.dashboard"] });
  appOnly = await makeUser("Abe App", { website: "associate", modules: [] });
  adam = await makeUser("Adam Admin", { website: "admin", modules: [] });
  as(pat);
  mockSite();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  setTestUser(null);
  await db.$client.end();
});

/* ----------------------------------------------------------------- helpers */

function must<T>(r: Result<T>): T {
  assert.ok(r.ok, r.ok ? "" : `${r.error} (${r.code})`);
  return r.data;
}

function refusedWith(r: Result<unknown>, code: string, pattern?: RegExp) {
  assert.equal(r.ok, false, "expected a refusal");
  if (!r.ok) {
    assert.equal(r.code, code, r.error);
    if (pattern) assert.match(r.error, pattern);
  }
}

async function enforce(on: boolean) {
  await db
    .insert(websiteReviewSetting)
    .values({ id: "site", enforceAssignments: on })
    .onConflictDoUpdate({ target: websiteReviewSetting.id, set: { enforceAssignments: on } });
}

async function row(rowId: string) {
  const [r] = await db.select().from(websiteContent).where(eq(websiteContent.id, rowId));
  return r;
}

async function request(requestId: string) {
  const [r] = await db.select().from(websiteChangeRequest).where(eq(websiteChangeRequest.id, requestId));
  return r;
}

async function slots(requestId: string): Promise<(string | null)[]> {
  const items = await db.select().from(websiteChangeItem).where(eq(websiteChangeItem.requestId, requestId));
  return items.map((i) => i.openContentId);
}

async function audits(action: string, entityId?: string) {
  const rows = await db.select().from(auditLog).where(eq(auditLog.action, action));
  return entityId ? rows.filter((r) => r.entityId === entityId) : rows;
}

/** A product that is LIVE, made by the publisher the way the CMS makes them. */
async function liveProduct(slug = "test-thinner", over: Record<string, unknown> = {}): Promise<string> {
  const made = must(await createItem(pat, "product", product({ slug, id: `MTI-${slug}`, name: `Product ${slug}`, ...over })));
  must(await transitionItems(pat, [made.id], "publish"));
  return made.id;
}

async function draftProduct(slug: string, over: Record<string, unknown> = {}): Promise<string> {
  return must(await createItem(pat, "product", product({ slug, id: `MTI-${slug}`, name: `Product ${slug}`, ...over }))).id;
}

/** Saves a change to an item as somebody, through the command. */
async function editAs(who: Person, itemId: string, over: Record<string, unknown>) {
  as(who);
  const r = await row(itemId);
  return cms.saveContent(itemId, { ...r.data, ...over }, r.version);
}

async function assign(employee: Person, kind: string, contentId: string | null = null) {
  as(rita);
  return must(await cms.assignWork(employee.id, kind, contentId ?? undefined));
}

async function submitAs(who: Person, ids: string[], note?: string, resubmissionOf?: string) {
  as(who);
  return cms.submitForVerification(ids, note, resubmissionOf);
}

async function approveAs(who: Person, requestId: string) {
  as(who);
  return cms.approveRequest(requestId);
}

/** Live product → employee edit → submitted request. Returns what a test needs. */
async function submitted(slug = "test-thinner", who: Person = eva, over: Record<string, unknown> = { name: "Renamed by Eva" }) {
  await enforce(true);
  const itemId = await liveProduct(slug);
  await assign(who, "product", itemId);
  must(await editAs(who, itemId, over));
  const made = must(await submitAs(who, [itemId]));
  return { itemId, requestId: made.id };
}

async function approved(slug = "test-thinner", who: Person = eva, over?: Record<string, unknown>) {
  const s = await submitted(slug, who, over);
  must(await approveAs(rita, s.requestId));
  return s;
}

/* =================================================== assignments are OFF */

describe("with assignments off — the default — nobody who could edit before has lost anything", () => {
  test("an editor with only the Products module still creates, saves, discards, moves, deletes and previews, assigned to nothing", async () => {
    assert.equal(await assignmentsEnforced(), false);
    as(eli);
    const a = must(await cms.createContent("product", product({ slug: "a", id: "MTI-a", name: "A" })));
    const b = must(await cms.createContent("product", product({ slug: "b", id: "MTI-b", name: "B" })));
    must(await cms.saveContent(a.id, product({ slug: "a", id: "MTI-a", name: "A2" }), a.version));
    must(await cms.moveContent(b.id, "up"));
    must(await cms.deleteContentDraft(b.id));
    const live = await liveProduct("c");
    must(await editAs(eli, live, { name: "C2" }));
    must(await cms.discardContentChanges(live));
    assert.ok((await cms.readContent(a.id)).ok);
    const preview = await cms.previewKind("product");
    assert.ok(preview.ok || preview.code !== "not_permitted", "a preview may need the site to be connected, never an assignment");
  });

  test("an editor still cannot publish, unpublish, archive, restore, import, refresh or publish everything", async () => {
    const live = await liveProduct();
    as(eva);
    refusedWith(await cms.transitionContent([live], "publish"), "not_permitted");
    refusedWith(await cms.transitionContent([live], "unpublish"), "not_permitted");
    refusedWith(await cms.transitionContent([live], "archive"), "not_permitted");
    refusedWith(await cms.transitionContent([live], "restore"), "not_permitted");
    refusedWith(await cms.publishAllPending(), "not_permitted");
    refusedWith(await cms.refreshLiveSiteNow(), "not_permitted");
    refusedWith(await cms.importSiteContent(), "not_permitted");
  });

  test("a publisher edits, reorders, publishes and unpublishes exactly as before — no assignment, no request", async () => {
    as(pat);
    const a = await draftProduct("a");
    const b = await draftProduct("b");
    must(await cms.saveContent(a, product({ slug: "a", id: "MTI-a", name: "A2" }), (await row(a)).version));
    must(await cms.moveContent(b, "up"));
    must(await cms.transitionContent([a, b], "publish"));
    assert.equal((await currentBundle(false)).products?.length, 2);
    must(await cms.transitionContent([a], "unpublish"));
    must(await cms.transitionContent([b], "archive"));
    assert.equal((await cms.publishAllPending()).ok, true);
    assert.equal((await db.select().from(websiteChangeRequest)).length, 0, "no request was needed or created");
  });

  test("a MISSING setting row means off, not on", async () => {
    await db.delete(websiteReviewSetting);
    assert.equal(await assignmentsEnforced(), false);
    as(eli);
    const made = must(await cms.createContent("product", product()));
    must(await cms.saveContent(made.id, product({ name: "Still allowed" }), made.version));
  });

  test("with nothing waiting in review, a save is not held up by the review lock", async () => {
    const live = await liveProduct();
    must(await editAs(eva, live, { name: "One" }));
    must(await editAs(eva, live, { name: "Two" }));
    assert.equal((await row(live)).data.name, "Two");
  });
});

/* =============================================== the setting itself */

describe("only a Review holder changes whether assignments are enforced", () => {
  test("an editor, a publisher, an administrator hat, an app-only grant and a dashboard-only user are all refused", async () => {
    for (const who of [eva, pat, adam, appOnly, nia]) {
      as(who);
      refusedWith(await cms.setEnforceAssignments(true), "not_permitted");
    }
    assert.equal(await assignmentsEnforced(), false);
  });

  test("a Review holder turns it on and off, and each change is recorded", async () => {
    as(rita);
    assert.equal(must(await cms.setEnforceAssignments(true)).enforced, true);
    assert.equal(await assignmentsEnforced(), true);
    must(await cms.setEnforceAssignments(false));
    assert.equal(await assignmentsEnforced(), false);
    const log = await audits("website.review.enforcement_changed");
    assert.equal(log.length, 2);
    assert.ok(log.every((r) => r.actorId === rita.id));
    const turnedOn = log.find((r) => (r.afterState as { enforceAssignments: boolean }).enforceAssignments === true);
    assert.ok(turnedOn, "turning it on is recorded");
    assert.deepEqual(turnedOn.beforeState, { enforceAssignments: false });
  });

  test("only a real on or off is accepted", async () => {
    as(rita);
    refusedWith(await cms.setEnforceAssignments("yes"), "validation");
    refusedWith(await cms.setEnforceAssignments(undefined), "validation");
  });
});

/* ====================================== an unassigned editor, enforced */

describe("with assignments enforced, an editor changes only what was assigned to them", () => {
  test("an editor with no assignment cannot create, save, discard, delete, move, read or submit", async () => {
    const live = await liveProduct();
    const draft = await draftProduct("draft-one");
    await enforce(true);
    as(eva);
    refusedWith(await cms.createContent("product", product({ slug: "mine", id: "MTI-mine" })), "not_permitted", /assigned/);
    refusedWith(await cms.saveContent(live, product({ name: "x" }), 1), "not_permitted", /assigned/);
    refusedWith(await cms.discardContentChanges(live), "not_permitted");
    refusedWith(await cms.deleteContentDraft(draft), "not_permitted");
    refusedWith(await cms.moveContent(draft, "up"), "not_permitted");
    refusedWith(await cms.readContent(draft), "not_permitted", /assigned/);
    refusedWith(await cms.submitForVerification([live]), "not_permitted");
    assert.equal((await row(live)).data.name, `Product test-thinner`, "nothing was changed");
  });

  test("an editor assigned one product edits that product and not another, nor a new one, nor the order", async () => {
    const a = await liveProduct("a");
    const b = await liveProduct("b");
    await enforce(true);
    await assign(eva, "product", a);
    must(await editAs(eva, a, { name: "A changed" }));
    refusedWith(await editAs(eva, b, { name: "B changed" }), "not_permitted");
    as(eva);
    refusedWith(await cms.createContent("product", product({ slug: "n", id: "MTI-n" })), "not_permitted");
    refusedWith(await cms.moveContent(a, "down"), "not_permitted", /reorder|assigned/);
    assert.equal((await row(b)).data.name, "Product b");
  });

  test("a kind-wide assignment covers every item of the kind, new ones and reordering — and no other kind", async () => {
    const a = await liveProduct("a");
    const b = await liveProduct("b");
    await enforce(true);
    await assign(eva, "product");
    must(await editAs(eva, a, { name: "A2" }));
    must(await editAs(eva, b, { name: "B2" }));
    as(eva);
    const fresh = must(await cms.createContent("product", product({ slug: "n", id: "MTI-n", name: "New" })));
    must(await cms.moveContent(b, "up"));
    must(await cms.deleteContentDraft(fresh.id));
    // …but the same person holds the Industries module and was assigned nothing there.
    as(pat);
    const industry = must(await createItem(pat, "industry", { slug: "paint", name: "Paint", icon: "droplet", short: "x", productSlugs: [] }));
    as(eva);
    refusedWith(await cms.saveContent(industry.id, { ...industry.data, name: "Paint 2" }, industry.version), "not_permitted");
  });

  test("an editor assigned one page edits that page and not another page", async () => {
    as(pat);
    must(await cms.importSiteContent());
    const pages = await listItems("page");
    assert.ok(pages.length >= 2, "the seed carries several pages");
    const [mine, other] = pages;
    await enforce(true);
    await assign(eva, "page", mine.id);
    as(eva);
    const blocks = (mine.data as { blocks: { type: string; value: unknown }[] }).blocks.map((b) => ({ ...b }));
    must(await cms.saveContent(mine.id, { ...mine.data, blocks }, mine.version));
    refusedWith(await cms.saveContent(other.id, other.data, other.version), "not_permitted");
  });

  test("an editor assigned to the SEO of named pages edits those entries only", async () => {
    as(pat);
    must(await cms.importSiteContent());
    const seo = await listItems("seo");
    assert.ok(seo.length >= 2);
    await enforce(true);
    await assign(eva, "seo", seo[0].id);
    as(eva);
    must(await cms.saveContent(seo[0].id, { ...seo[0].data, title: "A new title" }, seo[0].version));
    refusedWith(await cms.saveContent(seo[1].id, { ...seo[1].data, title: "Another" }, seo[1].version), "not_permitted");
  });

  test("taking an assignment away takes the access away", async () => {
    const a = await liveProduct("a");
    await enforce(true);
    const given = await assign(eva, "product", a);
    must(await editAs(eva, a, { name: "While assigned" }));
    as(rita);
    must(await cms.revokeAssignment(given.id));
    refusedWith(await editAs(eva, a, { name: "After" }), "not_permitted");
    assert.equal((await row(a)).data.name, "While assigned");
  });

  test("holders of website.publish and website.review edit directly, whatever they are assigned", async () => {
    const a = await liveProduct("a");
    await enforce(true);
    must(await editAs(pat, a, { name: "Pat edits" }));
    must(await editAs(rex, a, { name: "Rex edits" }));
    as(pat);
    must(await cms.createContent("product", product({ slug: "n", id: "MTI-n" })));
    must(await cms.moveContent(a, "up"));
  });

  test("a refusal by an assignment is remembered", async () => {
    const a = await liveProduct("a");
    await enforce(true);
    refusedWith(await editAs(eva, a, { name: "no" }), "not_permitted");
    const denied = await audits("website.access.denied");
    assert.equal(denied.length, 1);
    assert.equal(denied[0].actorId, eva.id);
    assert.equal(denied[0].entityId, a);
  });

  test("holding the module is still required: an assignment alone opens nothing", async () => {
    const a = await liveProduct("a");
    await enforce(true);
    // Nia holds no content module. An assignment cannot be made for her…
    as(rita);
    refusedWith(await cms.assignWork(nia.id, "product", a), "rule_violation", /Access screen/);
    // …and a stale one written some other way would not help her either.
    await db.insert(websiteAssignment).values({ id: id("wa"), employeeId: nia.id, kind: "product", contentId: a, assignedById: rita.id });
    refusedWith(await editAs(nia, a, { name: "x" }), "not_permitted", /do not have access/);
  });
});

/* =============================================== who assigns and decides */

describe("only a Review holder assigns work and decides submissions", () => {
  test("an editor cannot assign, revoke, approve, reject or revoke an approval — called directly", async () => {
    const { itemId, requestId } = await submitted();
    as(eva);
    refusedWith(await cms.assignWork(eli.id, "product", itemId), "not_permitted");
    refusedWith(await cms.revokeAssignment("anything"), "not_permitted");
    refusedWith(await cms.approveRequest(requestId), "not_permitted");
    refusedWith(await cms.rejectRequest(requestId, "no"), "not_permitted");
    refusedWith(await cms.revokeApproval(requestId), "not_permitted");
    assert.equal((await request(requestId)).status, "submitted");
  });

  test("an app-only grant, an administrator hat, a publisher and a dashboard-only user cannot approve", async () => {
    const { requestId } = await submitted();
    for (const who of [appOnly, adam, pat, nia]) {
      refusedWith(await approveAs(who, requestId), "not_permitted");
      as(who);
      refusedWith(await cms.assignWork(eli.id, "product"), "not_permitted");
    }
    assert.equal((await request(requestId)).status, "submitted", "nobody without Review moved it");
  });

  test("nobody approves their own submission — not even a Review holder", async () => {
    await enforce(true);
    const itemId = await liveProduct();
    must(await editAs(rex, itemId, { name: "Rex's own change" }));
    const made = must(await submitAs(rex, [itemId]));
    refusedWith(await approveAs(rex, made.id), "not_permitted", /own submission/);
    as(rex);
    refusedWith(await cms.rejectRequest(made.id, "I reject myself"), "not_permitted");
    assert.equal((await request(made.id)).status, "submitted");
    // Somebody else can, and a refusal was remembered.
    must(await approveAs(rita, made.id));
    assert.ok((await audits("website.access.denied")).some((r) => r.actorId === rex.id));
  });

  test("an editor cannot publish a request that is only submitted, and cannot publish another person's approved one", async () => {
    const mine = await submitted("a", eva);
    as(eva);
    refusedWith(await cms.publishApproved(mine.requestId), "conflict", /cannot be published/);

    const theirs = await approved("b", eli);
    as(eva); // `approved` leaves the reviewer signed in
    refusedWith(await cms.publishApproved(theirs.requestId), "not_permitted", /submitted this/);
    assert.equal(((await row(theirs.itemId)).publishedData as { name: string }).name, "Product b", "nothing went live");
  });

  test("publishApproved takes a request: an item id is not one", async () => {
    const { itemId } = await approved();
    as(eva);
    refusedWith(await cms.publishApproved(itemId), "not_found");
  });

  test("assigning checks the row, the employee and the module — and is idempotent", async () => {
    const a = await liveProduct("a");
    as(rita);
    refusedWith(await cms.assignWork("usr_missing", "product", a), "not_found");
    refusedWith(await cms.assignWork(eva.id, "product", "wc_missing"), "not_found");
    refusedWith(await cms.assignWork(eva.id, "industry", a), "validation", /not of the kind/);
    refusedWith(await cms.assignWork(eva.id, "blog"), "validation");
    refusedWith(await cms.assignWork(eli.id, "page"), "rule_violation", /module/);
    const first = must(await cms.assignWork(eva.id, "product", a));
    const again = must(await cms.assignWork(eva.id, "product", a));
    assert.equal(again.id, first.id);
    assert.equal((await db.select().from(websiteAssignment)).length, 1);
    const media = must(await cms.assignWork(eva.id, "media"));
    assert.equal(media.kind, "media");
    assert.equal(media.contentId, null);
    assert.equal((await audits("website.assignment.assigned")).length, 2);
  });

  test("the kind of an assigned item comes from its row, whatever the caller says", async () => {
    const a = await liveProduct("a");
    as(rita);
    const made = must(await cms.assignWork(eva.id, undefined, a));
    assert.equal(made.kind, "product");
  });
});

/* ============================================================ the path */

describe("the full path: assign, edit, submit, approve, publish", () => {
  test("a draft never reaches the live site; approval then publishes exactly what was reviewed", async () => {
    await enforce(true);
    const itemId = await liveProduct();
    await assign(eva, "product", itemId);
    const before = (await currentBundle(false)).products?.[0];
    calls = [];

    // Edit: saved as a draft, live site untouched, public site not contacted.
    must(await editAs(eva, itemId, { name: "Eva's new name", tag: "" }));
    assert.equal((await currentBundle(false)).products?.[0].name, before?.name);
    assert.equal(calls.length, 0);

    // Submit: the copy is frozen — before, after, what kind of change.
    const made = must(await submitAs(eva, [itemId], "Please check the name"));
    const view = must(await (async () => { as(eva); return cms.readRequest(made.id); })());
    assert.equal(view.status, "submitted");
    assert.equal(view.submitterName, "Eva Editor");
    assert.equal(view.note, "Please check the name");
    assert.equal(view.items.length, 1);
    const item = view.items[0];
    assert.equal(item.action, "edit");
    assert.equal(item.baseData?.name, before?.name);
    assert.equal(item.proposedData.name, "Eva's new name");
    assert.deepEqual(
      item.changes.map((c) => [c.path, c.change]),
      [["name", "edited"], ["tag", "edited"]],
      "a cleared field is a visible edit",
    );
    assert.equal(calls.length, 0);

    // Nothing is publishable yet — only approved requests are.
    refusedWith(await cms.publishApproved(made.id), "conflict");

    // Approve, then publish.
    const grant = must(await approveAs(rita, made.id));
    assert.ok(new Date(grant.approvalExpiresAt).getTime() > Date.now() + 6.9 * 864e5, "seven days");
    as(eva);
    const out = must(await cms.publishApproved(made.id));
    assert.equal(out.changed, 1);
    assert.equal(out.live?.status, "refreshed");
    assert.equal(calls.length, 1, "the public site was told once, after the commit");

    const live = await row(itemId);
    assert.equal(live.state, "published");
    assert.equal(live.publishedById, eva.id);
    assert.deepEqual(live.publishedData, item.proposedData, "published_data is exactly the approved content");
    assert.equal((await currentBundle(false)).products?.[0].name, "Eva's new name");

    const done = await request(made.id);
    assert.equal(done.status, "published");
    assert.equal(done.publishedById, eva.id);
    assert.equal(done.reviewerId, rita.id);
    assert.deepEqual(await slots(made.id), [null]);

    // Every step is on the record, with who did it.
    for (const [action, actor] of [
      ["website.assignment.assigned", rita.id],
      ["website.review.submitted", eva.id],
      ["website.review.approved", rita.id],
      ["website.review.published", eva.id],
    ] as const) {
      const rows = await audits(action);
      assert.equal(rows.length, 1, action);
      assert.equal(rows[0].actorId, actor, action);
      assert.equal(rows[0].actorApp, "website", action);
    }
    const logged = await db.select().from(websitePublishLog).where(and(eq(websitePublishLog.action, "publish"), eq(websitePublishLog.contentId, itemId)));
    const viaRequest = logged.filter((l) => (l.detail ?? "").includes(made.id));
    assert.equal(viaRequest.length, 1, "the publish log names the request that authorised it");
    assert.equal(viaRequest[0].actorId, eva.id);
  });

  test("a new item is an 'add': it has nothing live before and is live after", async () => {
    await enforce(true);
    await assign(eva, "product");
    as(eva);
    const draft = must(await cms.createContent("product", product({ slug: "brand-new", id: "MTI-new", name: "Brand new" })));
    const made = must(await submitAs(eva, [draft.id]));
    as(eva);
    const view = must(await cms.readRequest(made.id));
    assert.equal(view.items[0].action, "add");
    assert.equal(view.items[0].baseData, null);
    assert.ok(view.items[0].changes.every((c) => c.change === "added"));
    must(await approveAs(rita, made.id));
    as(eva);
    must(await cms.publishApproved(made.id));
    assert.equal((await row(draft.id)).state, "published");
    assert.equal((await currentBundle(false)).products?.some((p) => p.name === "Brand new"), true);
  });

  test("a reviewer can publish an approved request too", async () => {
    const { itemId, requestId } = await approved();
    as(rita);
    must(await cms.publishApproved(requestId));
    assert.equal((await row(itemId)).data.name, "Renamed by Eva");
    assert.equal((await row(itemId)).publishedById, rita.id);
  });

  test("a submitter who has lost the module cannot publish, but a reviewer still can", async () => {
    const { itemId, requestId } = await approved();
    await db.delete(appModuleAccess).where(and(eq(appModuleAccess.userId, eva.id), eq(appModuleAccess.module, "website.products")));
    as(eva);
    refusedWith(await cms.publishApproved(requestId), "not_permitted", /no longer hold/);
    assert.equal((await request(requestId)).status, "approved", "the approval is still there");
    as(rita);
    must(await cms.publishApproved(requestId));
    assert.equal((await row(itemId)).state, "published");
  });

  test("publishing publishes only the approved items — never other drafts of the same kind", async () => {
    await enforce(true);
    const a = await liveProduct("a");
    const pendingDraft = await draftProduct("pending-draft");
    const alsoPending = await draftProduct("also-pending");
    await assign(eva, "product");
    must(await editAs(eva, a, { name: "A by Eva" }));
    const made = must(await submitAs(eva, [a]));
    must(await approveAs(rita, made.id));
    as(eva);
    const out = must(await cms.publishApproved(made.id));
    assert.deepEqual(out.items.map((i) => i.id), [a]);
    assert.equal((await row(pendingDraft)).state, "draft");
    assert.equal((await row(alsoPending)).state, "draft");
    assert.deepEqual((await currentBundle(false)).products?.map((p) => p.name), ["A by Eva"]);
  });

  test("publishing an approved request does NOT publish the working order of the list", async () => {
    // Pat publishes A then B, then moves B above A in the editor — an order change nobody has published or reviewed.
    const a = await liveProduct("a");
    const b = await liveProduct("b");
    as(pat);
    must(await cms.moveContent(b, "up"));
    const liveOrder = async () => (await currentBundle(false)).products?.map((p) => p.slug);
    assert.deepEqual(await liveOrder(), ["a", "b"], "the live order is still A, B");
    const beforeA = (await row(a)).publishedSort;
    const beforeB = (await row(b)).publishedSort;
    assert.deepEqual(await orderChangedKinds(), ["product"], "a reorder is pending");

    // Eva's reviewed edit to A goes live. The kind's pending order must not come with it.
    await enforce(true);
    await assign(eva, "product", a);
    must(await editAs(eva, a, { name: "A by Eva" }));
    const made = must(await submitAs(eva, [a]));
    must(await approveAs(rita, made.id));
    as(eva);
    must(await cms.publishApproved(made.id));

    assert.equal((await row(a)).publishedSort, beforeA, "A keeps its live position");
    assert.equal((await row(b)).publishedSort, beforeB, "B keeps its live position");
    assert.deepEqual(await liveOrder(), ["a", "b"], "the live order is untouched");
    assert.deepEqual(await orderChangedKinds(), ["product"], "the reorder is still waiting for whoever publishes it");
  });

  test("a new item published by request gets its own live position and moves nobody else", async () => {
    const a = await liveProduct("a");
    const b = await liveProduct("b");
    const beforeA = (await row(a)).publishedSort;
    const beforeB = (await row(b)).publishedSort;
    await enforce(true);
    await assign(eva, "product");
    as(eva);
    const draft = must(await cms.createContent("product", product({ slug: "c", id: "MTI-c", name: "C" })));
    const made = must(await submitAs(eva, [draft.id]));
    must(await approveAs(rita, made.id));
    as(eva);
    must(await cms.publishApproved(made.id));
    const c = await row(draft.id);
    assert.equal(c.publishedSort, c.sort, "only its own position");
    assert.equal((await row(a)).publishedSort, beforeA);
    assert.equal((await row(b)).publishedSort, beforeB);
  });

  test("the code path itself never calls syncPublishedOrder or the generic publishers", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/website-cms/review-service.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /syncPublishedOrder/);
    assert.doesNotMatch(code, /\b(transitionItems|publishPending|publishOrder)\b/);
  });
});

/* ======================================================= rejecting */

describe("rejection returns the work to the employee, with the reason", () => {
  test("a reason is mandatory — empty, blank and missing are refused, and nothing changes", async () => {
    const { requestId } = await submitted();
    for (const reason of ["", "   ", undefined, null, 42]) {
      as(rita);
      const r = await cms.rejectRequest(requestId, reason);
      refusedWith(r, "validation");
      if (!r.ok) assert.equal(r.fieldErrors?.[0].field, "reason");
    }
    assert.equal((await request(requestId)).status, "submitted");
    as(rita);
    refusedWith(await cms.rejectRequest(requestId, "x".repeat(1001)), "validation");
  });

  test("the employee sees the reason, edits again, resubmits as a linked request, and is approved", async () => {
    const { itemId, requestId } = await submitted();
    as(rita);
    must(await cms.rejectRequest(requestId, "The name is the old brand — use the new one."));

    const rejected = await request(requestId);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.rejectReason, "The name is the old brand — use the new one.");
    assert.equal(rejected.reviewerId, rita.id);
    assert.deepEqual(await slots(requestId), [null], "the item is free again");
    as(eva);
    const seen = must(await cms.readRequest(requestId));
    assert.equal(seen.rejectReason, "The name is the old brand — use the new one.");

    must(await editAs(eva, itemId, { name: "The new brand name" }));
    const second = must(await submitAs(eva, [itemId], undefined, requestId));
    assert.equal((await request(second.id)).resubmissionOf, requestId);

    must(await approveAs(rita, second.id));
    as(eva);
    must(await cms.publishApproved(second.id));
    assert.equal((await row(itemId)).data.name, "The new brand name");
    assert.equal((await audits("website.review.rejected")).length, 1);
  });

  test("a resubmission can follow only your own returned request", async () => {
    const mine = await submitted("a", eva);
    const theirs = await submitted("b", eli);
    as(rita);
    must(await cms.rejectRequest(mine.requestId, "No."));
    // Eva's own request is returned, so she may follow it; she may not follow Eli's, nor one that is still open.
    must(await editAs(eva, mine.itemId, { name: "Second try" }));
    refusedWith(await submitAs(eva, [mine.itemId], undefined, theirs.requestId), "validation", /returned requests/);
    refusedWith(await submitAs(eva, [mine.itemId], undefined, "wr_missing"), "validation");
    must(await submitAs(eva, [mine.itemId], undefined, mine.requestId));
  });

  test("a rejected or decided request cannot be decided again", async () => {
    const { requestId } = await submitted();
    as(rita);
    must(await cms.rejectRequest(requestId, "No."));
    refusedWith(await cms.rejectRequest(requestId, "Again"), "conflict");
    refusedWith(await approveAs(rita, requestId), "conflict");
    refusedWith(await cms.revokeApproval(requestId), "conflict");
  });
});

/* ==================================================== saving while open */

describe("an item waiting in review cannot be changed under the reviewer", () => {
  test("saves, discards and deletes are refused while the request is submitted or approved — withdrawing frees it", async () => {
    const { itemId, requestId } = await submitted();
    for (const stage of ["submitted", "approved"] as const) {
      if (stage === "approved") must(await approveAs(rita, requestId));
      refusedWith(await editAs(eva, itemId, { name: "Sneaky" }), "conflict", /Withdraw/);
      refusedWith(await editAs(pat, itemId, { name: "Even the publisher" }), "conflict", /Withdraw/);
      as(eva);
      refusedWith(await cms.discardContentChanges(itemId), "conflict");
      assert.equal((await row(itemId)).data.name, "Renamed by Eva");
    }
    as(eva);
    must(await cms.withdrawRequest(requestId));
    assert.equal((await request(requestId)).status, "withdrawn");
    assert.deepEqual(await slots(requestId), [null]);
    must(await editAs(eva, itemId, { name: "After withdrawing" }));
  });

  test("a never-published draft in a request cannot be deleted until the request is closed", async () => {
    await enforce(true);
    await assign(eva, "product");
    as(eva);
    const draft = must(await cms.createContent("product", product({ slug: "d", id: "MTI-d" })));
    const made = must(await submitAs(eva, [draft.id]));
    as(eva);
    refusedWith(await cms.deleteContentDraft(draft.id), "conflict");
    must(await cms.withdrawRequest(made.id));
    must(await cms.deleteContentDraft(draft.id));
  });

  test("only the submitter, or a reviewer, withdraws", async () => {
    const { requestId } = await submitted("a", eva);
    as(eli);
    refusedWith(await cms.withdrawRequest(requestId), "not_permitted");
    as(pat);
    refusedWith(await cms.withdrawRequest(requestId), "not_permitted");
    as(rita);
    must(await cms.withdrawRequest(requestId));
  });
});

/* ====================================================== exact-version */

describe("approval covers exactly the content that was reviewed", () => {
  test("content changed after approval: publish fails, the request goes stale, nothing is published, resubmission works", async () => {
    const { itemId, requestId } = await approved();
    const liveBefore = (await row(itemId)).publishedData;
    // A save through the command is refused while the request is open; this is the same change arriving some other way
    // (another route, an import, a restore) — the backstop the hash exists for.
    await db.update(websiteContent).set({ data: sql`jsonb_set(data, '{name}', '"Tampered"')`, version: sql`version + 1` }).where(eq(websiteContent.id, itemId));

    as(eva);
    refusedWith(await cms.publishApproved(requestId), "conflict", /changed since/);
    const after = await request(requestId);
    assert.equal(after.status, "stale");
    assert.deepEqual(await slots(requestId), [null]);
    assert.deepEqual((await row(itemId)).publishedData, liveBefore, "nothing was published");
    assert.equal((await audits("website.review.stale", requestId)).length, 1);

    // The employee can start again with a new request.
    const again = must(await submitAs(eva, [itemId], undefined, requestId));
    must(await approveAs(rita, again.id));
    as(eva);
    must(await cms.publishApproved(again.id));
    assert.equal((await row(itemId)).data.name, "Tampered", "what was reviewed THIS time is what went live");
  });

  test("a different editor's save between submit and publish is caught", async () => {
    const { itemId, requestId } = await approved();
    await db.update(websiteContent).set({ version: sql`version + 1` }).where(eq(websiteContent.id, itemId));
    as(eva);
    refusedWith(await cms.publishApproved(requestId), "conflict");
    assert.equal((await request(requestId)).status, "stale");
  });

  test("the same text under a new version is not good enough, and neither is the same version under new text", async () => {
    const one = await approved("a");
    await db.update(websiteContent).set({ version: sql`version + 1` }).where(eq(websiteContent.id, one.itemId));
    as(eva);
    refusedWith(await cms.publishApproved(one.requestId), "conflict");

    const two = await approved("b");
    await db.update(websiteContent).set({ data: sql`jsonb_set(data, '{short}', '"Different"')` }).where(eq(websiteContent.id, two.itemId));
    as(eva);
    refusedWith(await cms.publishApproved(two.requestId), "conflict");
    assert.equal((await request(two.requestId)).status, "stale");
  });

  test("a request whose content moved before anybody decided is closed as stale when it is approved", async () => {
    const { itemId, requestId } = await submitted();
    await db.update(websiteContent).set({ data: sql`jsonb_set(data, '{name}', '"Moved"')`, version: sql`version + 1` }).where(eq(websiteContent.id, itemId));
    refusedWith(await approveAs(rita, requestId), "conflict", /changed since/);
    assert.equal((await request(requestId)).status, "stale");
    assert.deepEqual(await slots(requestId), [null]);
    assert.equal((await audits("website.review.approved")).length, 0, "no approval was recorded");
  });

  test("an item deleted after approval voids the request", async () => {
    await enforce(true);
    await assign(eva, "product");
    as(eva);
    const draft = must(await cms.createContent("product", product({ slug: "d", id: "MTI-d" })));
    const made = must(await submitAs(eva, [draft.id]));
    must(await approveAs(rita, made.id));
    await db.delete(websiteContent).where(eq(websiteContent.id, draft.id));
    as(eva);
    refusedWith(await cms.publishApproved(made.id), "conflict", /no longer exists/);
    assert.equal((await request(made.id)).status, "stale");
  });

  test("a request of several items is all or none: one that moved voids the whole request", async () => {
    await enforce(true);
    const a = await liveProduct("a");
    const b = await liveProduct("b");
    await assign(eva, "product");
    must(await editAs(eva, a, { name: "A2" }));
    must(await editAs(eva, b, { name: "B2" }));
    const made = must(await submitAs(eva, [a, b]));
    must(await approveAs(rita, made.id));
    await db.update(websiteContent).set({ version: sql`version + 1` }).where(eq(websiteContent.id, b));
    as(eva);
    refusedWith(await cms.publishApproved(made.id), "conflict");
    assert.equal((await row(a)).data.name, "A2");
    assert.equal(((await row(a)).publishedData as { name: string }).name, "Product a", "A was not published either");
  });
});

/* ======================================================= expiry, revoke */

describe("expired and revoked approvals cannot be used", () => {
  test("after seven days the approval is dead: publishing is refused, the request is expired, the item is free", async () => {
    const { itemId, requestId } = await approved();
    await db.update(websiteChangeRequest).set({ approvalExpiresAt: new Date(Date.now() - 1000) }).where(eq(websiteChangeRequest.id, requestId));
    as(eva);
    refusedWith(await cms.publishApproved(requestId), "conflict", /expired/);
    assert.equal((await request(requestId)).status, "expired");
    assert.deepEqual(await slots(requestId), [null]);
    assert.equal(((await row(itemId)).publishedData as { name: string }).name, "Product test-thinner");
    assert.equal((await audits("website.review.expired", requestId)).length, 1);
    // …and she can edit and submit again.
    must(await editAs(eva, itemId, { name: "Second go" }));
    must(await submitAs(eva, [itemId], undefined, requestId));
  });

  test("the sweep expires every lapsed approval and leaves live ones alone", async () => {
    const one = await approved("a");
    const two = await approved("b", eli);
    await db.update(websiteChangeRequest).set({ approvalExpiresAt: new Date(Date.now() - 1000) }).where(eq(websiteChangeRequest.id, one.requestId));
    assert.equal(await review.sweepExpiredApprovals(), 1);
    assert.equal((await request(one.requestId)).status, "expired");
    assert.equal((await request(two.requestId)).status, "approved");
    assert.deepEqual(await slots(one.requestId), [null]);
    assert.equal(await review.sweepExpiredApprovals(), 0, "nothing left to do");
  });

  test("a reviewer revokes before publication: it cannot be published, and the employee can resubmit", async () => {
    const { itemId, requestId } = await approved();
    as(rita);
    must(await cms.revokeApproval(requestId));
    assert.equal((await request(requestId)).status, "revoked");
    assert.deepEqual(await slots(requestId), [null]);
    as(eva);
    refusedWith(await cms.publishApproved(requestId), "conflict", /cannot be published/);
    assert.equal(((await row(itemId)).publishedData as { name: string }).name, "Product test-thinner");
    must(await submitAs(eva, [itemId], undefined, requestId));
  });

  test("only an approved request is revocable, and not by its own submitter", async () => {
    const { requestId } = await submitted("a", rex);
    as(rita);
    refusedWith(await cms.revokeApproval(requestId), "conflict", /cannot be revoked/);
    must(await approveAs(rita, requestId));
    as(rex);
    refusedWith(await cms.revokeApproval(requestId), "not_permitted", /withdraw/);
  });
});

/* ============================================= one open request per item */

describe("an item is in at most one open request", () => {
  test("submitting an item that is already waiting is refused — by the same person or anybody else", async () => {
    await enforce(true);
    const a = await liveProduct("a");
    await assign(eva, "product", a);
    await assign(eli, "product", a);
    must(await editAs(eva, a, { name: "Eva's" }));
    must(await submitAs(eva, [a]));
    refusedWith(await submitAs(eva, [a]), "conflict", /already waiting/);
    refusedWith(await submitAs(eli, [a]), "conflict", /already waiting/);
    assert.equal((await db.select().from(websiteChangeRequest)).length, 1);
  });

  test("two submissions racing for one item cannot both succeed", async () => {
    await enforce(true);
    const a = await liveProduct("a");
    await assign(eva, "product", a);
    await assign(eli, "product", a);
    must(await editAs(eva, a, { name: "Raced" }));
    const results = await Promise.all([review.submitChange(eva, [a]), review.submitChange(eli, [a])]);
    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one wins");
    const loser = results.find((r) => !r.ok)!;
    refusedWith(loser, "conflict");
    const held = await db.select().from(websiteChangeItem).where(eq(websiteChangeItem.contentId, a));
    assert.equal(held.length, 1);
    assert.equal(held[0].openContentId, a);
    assert.equal((await db.select().from(websiteChangeRequest)).length, 1, "the loser left no request behind");
  });

  test("the same person pressing Submit twice at once makes one request", async () => {
    await enforce(true);
    const a = await liveProduct("a");
    await assign(eva, "product", a);
    must(await editAs(eva, a, { name: "Double click" }));
    as(eva);
    const results = await Promise.all([cms.submitForVerification([a]), cms.submitForVerification([a])]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal((await db.select().from(websiteChangeRequest)).length, 1);
  });

  test("two requests for different items open side by side", async () => {
    await enforce(true);
    const a = await liveProduct("a");
    const b = await liveProduct("b");
    await assign(eva, "product");
    must(await editAs(eva, a, { name: "A2" }));
    must(await editAs(eva, b, { name: "B2" }));
    must(await submitAs(eva, [a]));
    must(await submitAs(eva, [b]));
  });

  test("every way a request can end frees its items; approval alone does not", async () => {
    const free = async (requestId: string) => assert.deepEqual(await slots(requestId), [null], `request ${requestId}`);
    const held = async (requestId: string, itemId: string) => assert.deepEqual(await slots(requestId), [itemId]);

    // approved — still held
    const ap = await approved("approved-one");
    await held(ap.requestId, ap.itemId);

    // rejected
    const rj = await submitted("rejected-one");
    await held(rj.requestId, rj.itemId);
    as(rita);
    must(await cms.rejectRequest(rj.requestId, "No."));
    await free(rj.requestId);

    // withdrawn
    const wd = await submitted("withdrawn-one");
    as(eva);
    must(await cms.withdrawRequest(wd.requestId));
    await free(wd.requestId);

    // revoked
    const rv = await approved("revoked-one");
    as(rita);
    must(await cms.revokeApproval(rv.requestId));
    await free(rv.requestId);

    // expired
    const ex = await approved("expired-one");
    await db.update(websiteChangeRequest).set({ approvalExpiresAt: new Date(Date.now() - 1000) }).where(eq(websiteChangeRequest.id, ex.requestId));
    await review.sweepExpiredApprovals();
    await free(ex.requestId);

    // stale
    const st = await approved("stale-one");
    await db.update(websiteContent).set({ version: sql`version + 1` }).where(eq(websiteContent.id, st.itemId));
    as(eva);
    await cms.publishApproved(st.requestId);
    await free(st.requestId);

    // published
    const pb = await approved("published-one");
    as(eva);
    must(await cms.publishApproved(pb.requestId));
    await free(pb.requestId);

    const statuses = await Promise.all([ap, rj, wd, rv, ex, st, pb].map(async (x) => (await request(x.requestId)).status));
    assert.deepEqual(statuses, ["approved", "rejected", "withdrawn", "revoked", "expired", "stale", "published"]);
  });
});

/* =================================================== submission rules */

describe("what can be submitted", () => {
  test("something with no change from what is live is refused, and so is an empty or oversized list", async () => {
    await enforce(true);
    const a = await liveProduct("a");
    await assign(eva, "product", a);
    refusedWith(await submitAs(eva, [a]), "validation", /no changes/);
    refusedWith(await submitAs(eva, []), "validation");
    as(eva);
    refusedWith(await cms.submitForVerification("nope"), "validation");
    refusedWith(await cms.submitForVerification(Array.from({ length: 51 }, (_, i) => `wc_${i}`)), "not_found");
    refusedWith(await cms.submitForVerification(["wc_missing"]), "not_found");
  });

  test("saving the same text again is a new version and still not a change", async () => {
    await enforce(true);
    const a = await liveProduct("a");
    await assign(eva, "product", a);
    must(await editAs(eva, a, {}));
    must(await editAs(eva, a, {}));
    refusedWith(await submitAs(eva, [a]), "validation", /no changes/);
  });

  test("clearing a field is a change that can be submitted, and replacing a list entry shows in the diff", async () => {
    await enforce(true);
    const a = await liveProduct("a");
    await assign(eva, "product", a);
    must(await editAs(eva, a, { tag: "", benefits: ["Slower"] }));
    const made = must(await submitAs(eva, [a]));
    as(eva);
    const view = must(await cms.readRequest(made.id));
    assert.deepEqual(
      view.items[0].changes.map((c) => [c.path, c.change]),
      [["benefits[0]", "edited"], ["tag", "edited"]],
    );
  });

  test("an item outside the assignment cannot be put in a request, and one bad item stops the whole submission", async () => {
    await enforce(true);
    const a = await liveProduct("a");
    const b = await liveProduct("b");
    await assign(eva, "product", a);
    must(await editAs(eva, a, { name: "A2" }));
    refusedWith(await submitAs(eva, [a, b]), "not_permitted");
    assert.equal((await db.select().from(websiteChangeRequest)).length, 0);
  });

  test("an archived item cannot be submitted — restoring is for whoever publishes", async () => {
    const a = await liveProduct("a");
    as(pat);
    must(await cms.transitionContent([a], "archive"));
    await enforce(true);
    await assign(eva, "product", a);
    refusedWith(await submitAs(eva, [a]), "validation", /archived/);
  });

  test("invalid content cannot be submitted", async () => {
    await enforce(true);
    const a = await liveProduct("a");
    await assign(eva, "product", a);
    await db.update(websiteContent).set({ data: sql`jsonb_set(data, '{name}', '""')`, version: sql`version + 1` }).where(eq(websiteContent.id, a));
    refusedWith(await submitAs(eva, [a]), "validation", /need attention/);
  });

  test("a person with no module in the Website app cannot submit anything, and is remembered", async () => {
    const a = await liveProduct("a");
    refusedWith(await submitAs(nia, [a]), "not_permitted");
    assert.ok((await audits("website.access.denied")).some((r) => r.actorId === nia.id));
  });

  test("a request is read by its submitter and by reviewers — and nobody else", async () => {
    const { requestId } = await submitted("a", eva);
    as(eva);
    assert.ok((await cms.readRequest(requestId)).ok);
    as(rita);
    assert.ok((await cms.readRequest(requestId)).ok);
    as(eli);
    refusedWith(await cms.readRequest(requestId), "not_found");
    as(nia);
    refusedWith(await cms.readRequest(requestId), "not_permitted");
  });
});

/* ==================================================================== images */

describe("images in a request", () => {
  const upload = async (who: Person, n: number) => {
    const made = must(await uploadMedia(who, { filename: `pic-${n}.png`, bytes: pngWith(n), alt: `Picture ${n}` }));
    return { id: made.id, url: made.url };
  };
  const route = async (who: Person, mediaId: string) => {
    as(who);
    return editorMedia(new Request("http://localhost/api/website/media/x"), { params: Promise.resolve({ id: mediaId }) });
  };

  test("replacing an image stores the old and the new id, shows it in the diff, and the reviewer can read both", async () => {
    const oldPic = await upload(pat, 1);
    const newPic = await upload(pat, 2);
    await enforce(true);
    const a = await liveProduct("a", { image: oldPic.url });
    await assign(eva, "product", a);
    must(await editAs(eva, a, { image: newPic.url }));
    const made = must(await submitAs(eva, [a]));

    const [item] = await db.select().from(websiteChangeItem).where(eq(websiteChangeItem.requestId, made.id));
    assert.deepEqual(item.mediaBefore, [oldPic.id]);
    assert.deepEqual(item.mediaAfter, [newPic.id]);
    as(rita);
    const view = must(await cms.readRequest(made.id));
    assert.deepEqual(view.items[0].changes.map((c) => [c.path, c.change, c.before, c.after]), [["image", "edited", oldPic.url, newPic.url]]);

    // Rita holds Review and no content module — she can still open both pictures.
    for (const pic of [oldPic, newPic]) assert.equal((await route(rita, pic.id)).status, 200, pic.id);
    // Somebody with nothing in the Website app beyond the dashboard cannot.
    assert.equal((await route(nia, newPic.id)).status, 403);
  });

  test("an image live on the site, or waiting in a request, cannot be deleted", async () => {
    const live = await upload(pat, 3);
    const incoming = await upload(pat, 4);
    await enforce(true);
    const a = await liveProduct("a", { image: live.url });
    await assign(eva, "product", a);
    must(await editAs(eva, a, { image: incoming.url }));
    must(await submitAs(eva, [a]));
    as(pat);
    refusedWith(await cms.removeMedia(live.id), "rule_violation", /in use/);
    refusedWith(await cms.removeMedia(incoming.id), "rule_violation", /in use/);

    // The request's own copy holds the picture even when the working copy has moved off it.
    await db.update(websiteContent).set({ data: sql`jsonb_set(data, '{image}', '"/images/other.webp"')` }).where(eq(websiteContent.id, a));
    refusedWith(await cms.removeMedia(incoming.id), "rule_violation", /awaiting review/);

    // Once the request is closed, an image nothing points at can go.
    const [open] = await db.select().from(websiteChangeRequest);
    as(eva);
    must(await cms.withdrawRequest(open.id));
    as(pat);
    must(await cms.removeMedia(incoming.id));
  });

  test("with assignments enforced, an editor changes only images they uploaded, unless assigned the media library", async () => {
    const patsPic = await upload(pat, 5);
    await enforce(true);
    const evasPic = await upload(eva, 6);
    as(eva);
    refusedWith(await cms.setMediaAlt(patsPic.id, "mine now"), "not_permitted", /uploaded/);
    refusedWith(await cms.removeMedia(patsPic.id), "not_permitted");
    must(await cms.setMediaAlt(evasPic.id, "Mine"));
    must(await cms.removeMedia(evasPic.id));
    assert.ok((await audits("website.access.denied")).some((r) => r.actorId === eva.id && r.entityId === patsPic.id));

    await assign(eva, "media");
    as(eva);
    must(await cms.setMediaAlt(patsPic.id, "Now allowed"));
    must(await cms.removeMedia(patsPic.id));
  });

  test("with assignments off, the media rules are as they were", async () => {
    const patsPic = await upload(pat, 7);
    as(eva);
    must(await cms.setMediaAlt(patsPic.id, "Anyone with a module"));
    must(await cms.removeMedia(patsPic.id));
  });
});

/* ====================================================== the audit trail */

describe("the record", () => {
  test("denied attempts are written, with who and what", async () => {
    const { requestId } = await submitted();
    as(eva);
    await cms.approveRequest(requestId);
    await cms.setEnforceAssignments(false);
    await cms.assignWork(eli.id, "product");
    const denied = await audits("website.access.denied");
    assert.equal(denied.length, 3);
    assert.ok(denied.every((r) => r.actorId === eva.id));
    assert.deepEqual(
      denied.map((r) => (r.afterState as { attempt: string }).attempt).sort(),
      ["approve a website change request", "assign website work", "change whether website assignments are enforced"],
    );
  });

  test("a refused publish by somebody who publishes nothing leaves no trace on the content", async () => {
    const { itemId } = await submitted();
    const before = await row(itemId);
    as(eva);
    await cms.transitionContent([itemId], "publish");
    const after = await row(itemId);
    assert.deepEqual(after.publishedData, before.publishedData);
    assert.equal(after.version, before.version);
  });

  test("every audit write in the workflow goes through the transaction that made the change", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/website-cms/review-service.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const calls = [...code.matchAll(/await audit\((\w+),/g)].map((m) => m[1]);
    assert.ok(calls.length >= 7, "the workflow audits its changes");
    for (const client of calls) {
      // `db` is used once, by the denial record, which describes a change that did NOT happen.
      assert.ok(client === "tx" || client === "db", `audit through ${client}`);
    }
    assert.equal(calls.filter((c) => c === "db").length, 1, "only the refusal is written outside a transaction");
    // And the status changes that must be atomic with their audit are in `closeRequest`, which takes the transaction.
    assert.match(code, /async function closeRequest\(\s*tx: Tx/);
  });

  test("a failed submission leaves no request, no item, no lock and no audit row", async () => {
    await enforce(true);
    const a = await liveProduct("a");
    const b = await liveProduct("b");
    await assign(eva, "product");
    must(await editAs(eva, a, { name: "A2" }));
    // B has no change, so the whole submission is refused after A was already read.
    refusedWith(await submitAs(eva, [a, b]), "validation");
    assert.equal((await db.select().from(websiteChangeRequest)).length, 0);
    assert.equal((await db.select().from(websiteChangeItem)).length, 0);
    assert.equal((await audits("website.review.submitted")).length, 0);
    must(await submitAs(eva, [a]));
  });

  test("a request's history says who assigned, edited, submitted, reviewed and published, and when", async () => {
    const { itemId, requestId } = await approved();
    as(eva);
    must(await cms.publishApproved(requestId));
    const trail = await db.select().from(auditLog).orderBy(auditLog.at);
    const mine = trail.filter((r) => r.entityId === requestId || r.action === "website.assignment.assigned");
    assert.deepEqual(
      mine.map((r) => [r.action, r.actorId]),
      [
        ["website.assignment.assigned", rita.id],
        ["website.review.submitted", eva.id],
        ["website.review.approved", rita.id],
        ["website.review.published", eva.id],
      ],
    );
    const edits = await db.select().from(websitePublishLog).where(and(eq(websitePublishLog.contentId, itemId), eq(websitePublishLog.action, "save")));
    assert.ok(edits.some((e) => e.actorId === eva.id), "her save is in the publish log");
  });
});

/* ============================================================== listing */

describe("listing requests", () => {
  test("a person's own requests, and the reviewer's whole queue, newest first with their item counts", async () => {
    await enforce(true);
    const a = await liveProduct("a");
    const b = await liveProduct("b");
    await assign(eva, "product");
    await assign(eli, "product", b);
    must(await editAs(eva, a, { name: "A2" }));
    must(await editAs(eli, b, { name: "B2" }));
    const first = must(await submitAs(eva, [a]));
    const second = must(await submitAs(eli, [b]));
    const queue = await review.listRequests();
    assert.deepEqual(queue.map((r) => r.id), [second.id, first.id]);
    assert.deepEqual((await review.listRequests({ submitterId: eva.id })).map((r) => r.id), [first.id]);
    assert.equal((await review.listRequests({ status: "approved" })).length, 0);
    must(await approveAs(rita, first.id));
    assert.deepEqual((await review.listRequests({ status: "approved" })).map((r) => r.id), [first.id]);
    assert.ok(queue.every((r) => r.items === 1));
  });
});
