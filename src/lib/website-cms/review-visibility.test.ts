/**
 * What the Website screens SHOW, against the real services and a real database.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test`, created by `npm run test:db` from the committed
 * migrations. It truncates between tests — never point it at a database anybody
 * is using.
 *
 * The rule under test is the read side of the assignment rule: where assignments
 * are enforced, an editor is shown only what they were assigned. Not another
 * person's item name, not their draft, not a count that includes their work, not
 * a line of the activity feed about it, not the name of the content that uses an
 * image. `review-workflow.test.ts` proves what the server REFUSES; this proves
 * what the screens would DRAW — the lists, the counts, the entry points and the
 * review queue are all read through the functions under test here, and a screen
 * that skipped them is caught by the static test at the end.
 */
import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  appSecrets,
  users,
  websiteChangeRequest,
  websiteReviewSetting,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import type { Result } from "@/lib/result";
import { MODULE_SLUGS, PUBLISH_MODULE_KEY, REVIEW_MODULE_KEY } from "@/lib/website-cms/kinds";
import * as cms from "@/lib/website-cms/commands";
import { impactReport } from "@/lib/impact/registry";
import { slugVisible } from "@/lib/website-cms/review-scope";
import {
  assignScreen,
  myWork,
  pendingReviewCount,
  requestHistory,
  reviewByItem,
  reviewQueue,
  scopeFor,
  visibleItems,
} from "@/lib/website-cms/review-queries";
import { createItem, dashboardSummary, listItems, transitionItems } from "@/lib/website-cms/service";
import { uploadMedia } from "@/lib/website-cms/media-service";
import { loadChrome } from "@/app/website/cms-ui/chrome";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

type Person = typeof users.$inferSelect;

async function makeUser(name: string, grants: { modules?: string[] } = {}): Promise<Person> {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role: "associate",
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "website", role: "associate" });
  for (const m of grants.modules ?? []) await db.insert(appModuleAccess).values({ id: id("mod"), userId: row.id, app: "website", module: m });
  return row;
}

const ALL_CONTENT = ["website.dashboard", ...MODULE_SLUGS.map((s) => `website.${s}`)];

const product = (slug: string, over: Record<string, unknown> = {}) => ({
  id: `MTI-${slug}`,
  slug,
  name: `Product ${slug}`,
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

const realFetch = globalThis.fetch;
function mockSite() {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, at: new Date().toISOString() }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

let pat: Person; //  publishes, sees everything
let rita: Person; // reviews
let eva: Person; //  an editor: every content module, no direct-edit right
let eli: Person; //  an editor of Products only

beforeEach(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test. Run `npm run test:db` first.");
  await db.execute(sql`
    truncate table
      website_change_item, website_change_request, website_assignment,
      website_publish_log, website_content, website_media, attachment_bytes,
      audit_log, app_module_access, app_secrets, app_access, users, app_settings
    restart identity cascade
  `);
  await db.insert(websiteReviewSetting).values({ id: "site", enforceAssignments: false }).onConflictDoNothing();
  invalidateConfig();
  await seedConfig();
  for (const [name, value] of [
    ["website.cmsReadSecret", "read-secret-for-tests-0123456789"],
    ["website.cmsPublishSecret", "publish-secret-for-tests-0123456789"],
  ] as const) {
    await db.insert(appSecrets).values({ name, value, last4: value.slice(-4) });
  }
  pat = await makeUser("Pat Publisher", { modules: [...ALL_CONTENT, PUBLISH_MODULE_KEY] });
  rita = await makeUser("Rita Reviewer", { modules: ["website.dashboard", REVIEW_MODULE_KEY] });
  eva = await makeUser("Eva Editor", { modules: ALL_CONTENT });
  eli = await makeUser("Eli Editor", { modules: ["website.dashboard", "website.products"] });
  setTestUser(pat);
  mockSite();
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

/** What the impact modal hands back once somebody has read it and typed the word. */
async function confirmed(kind: string, target: string) {
  const r = await impactReport(kind, target);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return { typed: r.data.confirmWord, fingerprint: r.data.fingerprint };
}

const as = (p: Person) => setTestUser(p);

async function enforce(on: boolean) {
  await db
    .insert(websiteReviewSetting)
    .values({ id: "site", enforceAssignments: on })
    .onConflictDoUpdate({ target: websiteReviewSetting.id, set: { enforceAssignments: on } });
}

async function live(slug: string, over: Record<string, unknown> = {}) {
  const made = must(await createItem(pat, "product", product(slug, over)));
  must(await transitionItems(pat, [made.id], "publish"));
  return made.id;
}

async function draft(slug: string, over: Record<string, unknown> = {}) {
  return must(await createItem(pat, "product", product(slug, over))).id;
}

async function assign(who: Person, kind: string, contentId: string | null = null) {
  as(rita);
  return must(await cms.assignWork(who.id, kind, contentId ?? undefined));
}

async function editAs(who: Person, itemId: string, over: Record<string, unknown>) {
  as(who);
  const [row] = await db.execute<{ data: Record<string, unknown>; version: number }>(sql`select data, version from website_content where id = ${itemId}`);
  return cms.saveContent(itemId, { ...row.data, ...over }, row.version);
}

/**
 * The shared scene. Pat has published alpha and bravo (bravo uses a picture) and
 * left charlie as a draft; the site's pages and SEO are imported. Eva is assigned
 * ONE product (alpha) and ONE page. Eli is assigned alpha too, and nothing else.
 */
async function scene() {
  const pic = must(await uploadMedia(pat, { filename: "bravo.png", bytes: pngWith(1), alt: "Bravo" }));
  const alpha = await live("alpha");
  const bravo = await live("bravo-secret", { image: pic.url });
  const charlie = await draft("charlie-draft");
  as(pat);
  must(await cms.importSiteContent());
  const pages = await listItems("page");
  await enforce(true);
  await assign(eva, "product", alpha);
  await assign(eva, "page", pages[0].id);
  await assign(eli, "product", alpha);
  return { alpha, bravo, charlie, pages, pic };
}

/* ================================================================== lists */

describe("every list shows an enforced editor only their own items", () => {
  test("a list holds exactly what was assigned — no other name, no other draft", async () => {
    const { alpha, bravo, charlie, pages } = await scene();
    const scope = await scopeFor(eva.id);
    assert.equal(scope.everything, false);

    assert.deepEqual((await visibleItems("product", scope)).map((i) => i.id), [alpha]);
    assert.deepEqual((await visibleItems("page", scope)).map((i) => i.id), [pages[0].id]);
    for (const kind of ["industry", "gallery", "job", "testimonial", "milestone", "seo", "navigation", "settings"] as const) {
      assert.deepEqual(await visibleItems(kind, scope), [], `${kind} holds nothing of theirs`);
    }
    const names = JSON.stringify([...(await visibleItems("product", scope)), ...(await visibleItems("page", scope))]);
    assert.doesNotMatch(names, /bravo-secret|charlie-draft/, "another person's item is not in what they are handed");
    // The rows exist (the three above and the site's own products); the scope is what hides them.
    assert.ok((await listItems("product")).length > 3);
    assert.ok([alpha, bravo, charlie].every((x) => x));
  });

  test("an editor with nothing assigned is shown nothing and has no module to open", async () => {
    await scene();
    const scope = await scopeFor(eli.id);
    assert.deepEqual((await visibleItems("product", scope)).map((i) => i.label), ["Product alpha"]);
    // Eli was assigned alpha only; he holds no other module, but even where he did, nothing else is his.
    assert.equal(slugVisible(scope, "products"), true);
    assert.equal(slugVisible(scope, "pages"), false);
    assert.equal(slugVisible(scope, "industries"), false);
    assert.equal(slugVisible(scope, "media"), false);
    assert.equal(slugVisible(scope, "dashboard"), true);

    const nobody = await makeUser("Nobody Assigned", { modules: ALL_CONTENT });
    const none = await scopeFor(nobody.id);
    for (const slug of MODULE_SLUGS) assert.equal(slugVisible(none, slug), false, slug);
    assert.deepEqual(await visibleItems("product", none), []);
  });

  test("the entry points follow the assignments: add and reorder need a whole-kind assignment", async () => {
    const { charlie } = await scene();
    const one = await scopeFor(eva.id);
    assert.equal(one.hasKind("product"), true);
    assert.equal(one.kindWide("product"), false, "no Add button, no Move up/down");
    await assign(eva, "product"); // now the whole kind
    const whole = await scopeFor(eva.id);
    assert.equal(whole.kindWide("product"), true);
    const wholeIds = (await visibleItems("product", whole)).map((i) => i.id);
    assert.equal(wholeIds.length, (await listItems("product")).length, "the whole kind");
    assert.ok(wholeIds.includes(charlie), "it includes the draft she may now see and edit");
  });

  test("taking an assignment away takes the item off their list", async () => {
    const { alpha } = await scene();
    as(rita);
    const mine = (await assignScreen()).assignments.find((a) => a.employeeId === eva.id && a.contentId === alpha)!;
    const bare = await cms.revokeAssignment(mine.id);
    assert.equal(!bare.ok && bare.code, "validation", "taking work away nobody confirmed is refused");
    const report = await impactReport("site-assignment", mine.id);
    assert.ok(report.ok);
    assert.equal(report.data.confirmWord, eva.name, "their own name is typed");
    must(await cms.revokeAssignment(mine.id, await confirmed("site-assignment", mine.id)));
    assert.deepEqual(await visibleItems("product", await scopeFor(eva.id)), []);
  });

  test("a publisher, a reviewer and — with assignments off — everybody sees everything", async () => {
    await scene();
    for (const who of [pat, rita]) {
      const scope = await scopeFor(who.id);
      assert.equal(scope.everything, true, who.name);
      assert.equal((await visibleItems("product", scope)).length, (await listItems("product")).length, who.name);
    }
    await enforce(false);
    const scope = await scopeFor(eva.id);
    assert.equal(scope.everything, true);
    assert.equal((await visibleItems("product", scope)).length, (await listItems("product")).length);
    assert.equal(slugVisible(scope, "industries"), true);
  });
});

/* =============================================================== dashboard */

describe("the dashboard counts an enforced editor's own work and nobody else's", () => {
  test("counts, pending, and the kinds that exist at all are theirs alone", async () => {
    const { alpha } = await scene();
    must(await editAs(eva, alpha, { name: "Alpha by Eva" }));

    const whole = await dashboardSummary(await scopeFor(pat.id));
    const mine = await dashboardSummary(await scopeFor(eva.id));
    assert.equal(whole.scoped, false);
    assert.equal(mine.scoped, true);

    const kind = (s: typeof mine, k: string) => s.kinds.find((x) => x.kind === k)!;
    const allProducts = (await listItems("product")).length;
    assert.ok(allProducts > 3);
    assert.equal(kind(whole, "product").total, allProducts);
    assert.equal(kind(mine, "product").total, 1, "alpha only");
    assert.equal(kind(mine, "product").live, 1);
    assert.equal(kind(mine, "product").draft, 0, "charlie's draft is not in her count");
    assert.equal(kind(mine, "product").changes, 1, "her own unpublished change");
    assert.equal(kind(mine, "page").total, 1);
    for (const k of ["industry", "gallery", "job", "testimonial", "milestone", "seo", "navigation", "settings"]) {
      assert.equal(kind(mine, k).total, 0, `${k} has nothing of hers`);
    }
    assert.equal(mine.pending, 1, "pending counts her change, not Pat's draft");
    assert.ok(whole.pending > mine.pending);
  });

  test("the activity feed names only her own content", async () => {
    const { alpha } = await scene();
    must(await editAs(eva, alpha, { name: "Alpha by Eva" }));
    const mine = await dashboardSummary(await scopeFor(eva.id));
    const labels = mine.activity.map((a) => a.label ?? "");
    assert.doesNotMatch(JSON.stringify(mine.activity), /bravo-secret|charlie-draft|import/, "nothing about another item or the import");
    assert.ok(labels.includes("alpha"), "her own publish history is there");
    const whole = await dashboardSummary(await scopeFor(pat.id));
    assert.match(JSON.stringify(whole.activity), /bravo-secret/, "the publisher still sees everything");
  });

  test("the image count and the last published item are hidden unless they are hers", async () => {
    await scene();
    const mine = await dashboardSummary(await scopeFor(eva.id));
    assert.equal(mine.mediaUploads, 0, "she was not assigned the media library");
    assert.equal(mine.mediaSite, 0);
    assert.notEqual(mine.lastPublish?.label, "Product bravo-secret", "the last publish shown is one of hers");
    await assign(eva, "media");
    const withMedia = await dashboardSummary(await scopeFor(eva.id));
    assert.equal(withMedia.mediaUploads, 1);
  });

  test("a publisher's dashboard is the whole site, as before", async () => {
    await scene();
    const whole = await dashboardSummary(await scopeFor(pat.id));
    assert.equal(whole.scoped, false);
    const allProducts = (await listItems("product")).length;
    assert.equal(whole.kinds.find((k) => k.kind === "product")!.total, allProducts);
    assert.equal(whole.mediaUploads, 1);
    // …and the same call with no scope at all is the same answer.
    const bare = await dashboardSummary();
    assert.equal(bare.scoped, false);
    assert.equal(bare.kinds.find((k) => k.kind === "product")!.total, allProducts);
  });
});

/* ======================================================= what editors load */

describe("what every editor is handed — the image library and the catalogue", () => {
  test("the library does not say which content uses an image, and the catalogue omits others' drafts", async () => {
    const { pic } = await scene();
    as(eva);
    const chrome = await loadChrome();
    const used = chrome.media.find((m) => m.id === pic.id)!;
    assert.deepEqual(used.usedBy, ["other content"], "it is in use — but not by anything she is told the name of");
    assert.doesNotMatch(JSON.stringify(chrome.media), /bravo-secret/);
    const slugs = chrome.products.map((p) => p.slug);
    assert.ok(slugs.includes("alpha") && slugs.includes("bravo-secret"), "a live product is public, so it is offered");
    assert.ok(!slugs.includes("charlie-draft"), "another person's draft is not");
    assert.ok(slugs.length >= 11, "the site's own live products are offered too");
    assert.equal(chrome.canPublish, false);
    assert.equal(chrome.canSubmit, true, "she hands work in for review");
  });

  test("a publisher is handed the names and every product, and does not submit", async () => {
    const { pic } = await scene();
    as(pat);
    const chrome = await loadChrome();
    assert.match(chrome.media.find((m) => m.id === pic.id)!.usedBy.join(), /bravo-secret|Product bravo-secret/);
    assert.ok(chrome.products.some((p) => p.slug === "charlie-draft"), "the publisher is offered the draft too");
    assert.equal(chrome.products.length, (await listItems("product")).length);
    assert.equal(chrome.canPublish, true);
    assert.equal(chrome.canSubmit, false, "publishers publish; they do not submit");
  });

  test("with assignments off, an editor is handed everything, as before", async () => {
    await scene();
    await enforce(false);
    as(eva);
    const chrome = await loadChrome();
    assert.ok(chrome.products.some((p) => p.slug === "charlie-draft"), "assignments off: nothing is narrowed");
    assert.ok(chrome.media.some((m) => m.usedBy.length > 0 && !m.usedBy.includes("other content")));
  });
});

/* ===================================================== an item's review */

describe("where an item stands in review", () => {
  test("an item held by somebody else's request is shown as held — nothing more", async () => {
    const { alpha } = await scene();
    must(await editAs(eli, alpha, { name: "Alpha by Eli" }));
    as(eli);
    const made = must(await cms.submitForVerification([alpha], "Eli's note"));

    const forEva = (await reviewByItem(eva.id, [alpha]))[alpha];
    assert.equal(forEva.status, "submitted");
    assert.equal(forEva.mine, false);
    assert.equal(forEva.reason, null);
    assert.equal(forEva.requestId, made.id, "the id is carried, but only mine links to it");

    const forEli = (await reviewByItem(eli.id, [alpha]))[alpha];
    assert.equal(forEli.mine, true);
  });

  test("a request that came back is shown to the person it came back to, with the reason, and to nobody else", async () => {
    const { alpha } = await scene();
    must(await editAs(eli, alpha, { name: "Alpha by Eli" }));
    as(eli);
    const made = must(await cms.submitForVerification([alpha]));
    as(rita);
    must(await cms.rejectRequest(made.id, "Use the new brand name."));

    const forEli = (await reviewByItem(eli.id, [alpha]))[alpha];
    assert.equal(forEli.status, "rejected");
    assert.equal(forEli.reason, "Use the new brand name.");
    assert.equal(forEli.mine, true);
    assert.equal((await reviewByItem(eva.id, [alpha]))[alpha], undefined, "Eli's returned work is not Eva's to read");
  });

  test("once submitted again, the old returned request stops being shown and the new one is", async () => {
    const { alpha } = await scene();
    must(await editAs(eli, alpha, { name: "First try" }));
    as(eli);
    const first = must(await cms.submitForVerification([alpha]));
    as(rita);
    must(await cms.rejectRequest(first.id, "No."));
    must(await editAs(eli, alpha, { name: "Second try" }));
    as(eli);
    const second = must(await cms.submitForVerification([alpha], undefined, first.id));
    const now = (await reviewByItem(eli.id, [alpha]))[alpha];
    assert.equal(now.requestId, second.id);
    assert.equal(now.status, "submitted");
  });

  test("a withdrawn request is not a problem to show", async () => {
    const { alpha } = await scene();
    must(await editAs(eli, alpha, { name: "x" }));
    as(eli);
    const made = must(await cms.submitForVerification([alpha]));
    must(await cms.withdrawRequest(made.id, await confirmed("site-request-withdraw", made.id)));
    assert.equal((await reviewByItem(eli.id, [alpha]))[alpha], undefined);
  });

  test("an approval that has lapsed is shown as expired, not as ready to publish", async () => {
    const { alpha } = await scene();
    must(await editAs(eli, alpha, { name: "x" }));
    as(eli);
    const made = must(await cms.submitForVerification([alpha]));
    as(rita);
    must(await cms.approveRequest(made.id));
    await db.update(websiteChangeRequest).set({ approvalExpiresAt: new Date(Date.now() - 1000) }).where(eq(websiteChangeRequest.id, made.id));
    const seen = (await reviewByItem(eli.id, [alpha]))[alpha];
    assert.equal(seen.status, "expired");
    assert.equal(seen.mine, true);
  });
});

/* ===================================================================== my work */

describe("My work is the person's own and nobody else's", () => {
  test("their assignments, their drafts to hand in, and nothing of other people's", async () => {
    const { alpha, bravo } = await scene();
    must(await editAs(eva, alpha, { name: "Alpha by Eva" }));
    as(pat);
    must(await cms.saveContent(bravo, { ...product("bravo-secret"), name: "Pat's change" }, 1));

    const work = await myWork(eva.id, await scopeFor(eva.id));
    assert.equal(work.enforced, true);
    assert.equal(work.assignments.length, 2);
    assert.deepEqual(work.assignments.map((a) => a.kind).sort(), ["page", "product"]);
    assert.deepEqual(work.ready.map((r) => r.id), [alpha], "Pat's change to bravo is not in her list");
    assert.doesNotMatch(JSON.stringify(work), /bravo-secret|Pat's change/);
  });

  test("what is held by a request leaves 'ready to submit' and appears under 'waiting'", async () => {
    const { alpha } = await scene();
    must(await editAs(eva, alpha, { name: "Alpha by Eva" }));
    as(eva);
    const made = must(await cms.submitForVerification([alpha]));
    const work = await myWork(eva.id, await scopeFor(eva.id));
    assert.deepEqual(work.ready, []);
    assert.deepEqual(work.waiting.map((r) => r.id), [made.id]);
    assert.deepEqual(work.toPublish, []);
  });

  test("approved goes under 'to publish'; returned under 'came back' until it is submitted again", async () => {
    const one = await live("one");
    const two = await live("two");
    await enforce(true);
    await assign(eva, "product");
    must(await editAs(eva, one, { name: "One!" }));
    must(await editAs(eva, two, { name: "Two!" }));
    as(eva);
    const a = must(await cms.submitForVerification([one]));
    const b = must(await cms.submitForVerification([two]));
    as(rita);
    must(await cms.approveRequest(a.id));
    must(await cms.rejectRequest(b.id, "Not that."));

    let work = await myWork(eva.id, await scopeFor(eva.id));
    assert.deepEqual(work.toPublish.map((r) => r.id), [a.id]);
    assert.deepEqual(work.returned.map((r) => r.id), [b.id]);
    assert.equal(work.returned[0].rejectReason, "Not that.");

    must(await editAs(eva, two, { name: "Two, fixed" }));
    as(eva);
    must(await cms.submitForVerification([two], undefined, b.id));
    work = await myWork(eva.id, await scopeFor(eva.id));
    assert.deepEqual(work.returned, [], "it was submitted again, so it is no longer waiting on her");
  });

  test("somebody else's requests are not in it", async () => {
    const { alpha } = await scene();
    must(await editAs(eli, alpha, { name: "Alpha by Eli" }));
    as(eli);
    must(await cms.submitForVerification([alpha]));
    const work = await myWork(eva.id, await scopeFor(eva.id));
    assert.deepEqual([...work.waiting, ...work.toPublish, ...work.returned, ...work.published], []);
  });
});

/* ===================================================================== queue */

describe("the review queue", () => {
  async function threeRequests() {
    const one = await live("one");
    const two = await live("two");
    const three = await live("three");
    await enforce(true);
    await assign(eva, "product");
    const ids: string[] = [];
    for (const [item, name] of [[one, "One!"], [two, "Two!"], [three, "Three!"]] as const) {
      must(await editAs(eva, item, { name }));
      as(eva);
      ids.push(must(await cms.submitForVerification([item])).id);
    }
    as(rita);
    must(await cms.approveRequest(ids[0]));
    must(await cms.rejectRequest(ids[1], "Wrong price."));
    return { ids, items: [one, two, three] };
  }

  test("each tab has a count, and the rows are the ones of that tab", async () => {
    const { ids } = await threeRequests();
    const pending = await reviewQueue("pending");
    assert.deepEqual(pending.counts, { pending: 1, approved: 1, published: 0, rejected: 1, closed: 0 });
    assert.deepEqual(pending.rows.map((r) => r.id), [ids[2]]);
    assert.equal(pending.rows[0].submitterName, "Eva Editor");
    assert.deepEqual(pending.rows[0].itemLabels, ["Three!"], "the label is the submitted name");

    assert.deepEqual((await reviewQueue("approved")).rows.map((r) => r.id), [ids[0]]);
    const rejected = await reviewQueue("rejected");
    assert.deepEqual(rejected.rows.map((r) => r.id), [ids[1]]);
    assert.equal(rejected.rows[0].rejectReason, "Wrong price.");
    assert.equal(rejected.rows[0].reviewerName, "Rita Reviewer");
    assert.deepEqual((await reviewQueue("published")).rows, []);
    assert.deepEqual((await reviewQueue("closed")).rows, []);
  });

  test("publishing moves a request from 'approved' to 'published', and withdrawing to 'closed'", async () => {
    const { ids } = await threeRequests();
    as(eva);
    must(await cms.publishApproved(ids[0]));
    must(await cms.withdrawRequest(ids[2], await confirmed("site-request-withdraw", ids[2])));
    const q = await reviewQueue("published");
    assert.deepEqual(q.counts, { pending: 0, approved: 0, published: 1, rejected: 1, closed: 1 });
    assert.deepEqual(q.rows.map((r) => r.id), [ids[0]]);
  });

  test("an approval whose seven days have passed is on the 'closed' tab, not the 'approved' one", async () => {
    const { ids } = await threeRequests();
    await db.update(websiteChangeRequest).set({ approvalExpiresAt: new Date(Date.now() - 1000) }).where(eq(websiteChangeRequest.id, ids[0]));
    const q = await reviewQueue("approved");
    assert.equal(q.counts.approved, 0);
    assert.equal(q.counts.closed, 1);
    assert.deepEqual(q.rows, []);
    assert.deepEqual((await reviewQueue("closed")).rows.map((r) => r.id), [ids[0]]);
  });

  test("the number waiting for a decision is the pending count", async () => {
    assert.equal(await pendingReviewCount(), 0);
    await threeRequests();
    assert.equal(await pendingReviewCount(), 1);
  });

  test("a request with many items shows the first few names and says how many more", async () => {
    await enforce(true);
    const items: string[] = [];
    for (const n of ["a", "b", "c", "d", "e", "f"]) {
      const item = await live(`bulk-${n}`);
      items.push(item);
    }
    await assign(eva, "product");
    for (const item of items) must(await editAs(eva, item, { short: "Changed." }));
    as(eva);
    must(await cms.submitForVerification(items));
    const q = await reviewQueue("pending");
    assert.equal(q.rows[0].items, 6);
    assert.equal(q.rows[0].itemLabels.length, 4);
  });
});

/* ================================================================== history */

describe("a request's history", () => {
  test("says who did what, in order, with the reason on a rejection", async () => {
    const { alpha } = await scene();
    must(await editAs(eli, alpha, { name: "x" }));
    as(eli);
    const made = must(await cms.submitForVerification([alpha]));
    as(rita);
    must(await cms.rejectRequest(made.id, "Use the new brand name."));
    const h = await requestHistory(made.id);
    assert.deepEqual(
      h.map((e) => [e.action, e.actorName]),
      [
        ["Submitted for verification", "Eli Editor"],
        ["Changes rejected", "Rita Reviewer"],
      ],
    );
    assert.equal(h[1].detail, "Use the new brand name.");
    assert.ok(h[0].at <= h[1].at);
  });

  test("covers approval and publication too", async () => {
    const { alpha } = await scene();
    must(await editAs(eli, alpha, { name: "x" }));
    as(eli);
    const made = must(await cms.submitForVerification([alpha]));
    as(rita);
    must(await cms.approveRequest(made.id));
    as(eli);
    must(await cms.publishApproved(made.id));
    assert.deepEqual((await requestHistory(made.id)).map((e) => e.action), ["Submitted for verification", "Permission to publish granted", "Published"]);
  });
});

/* ================================================================== assigning */

describe("the assign screen's data", () => {
  test("lists the employees with what each can be given, who holds a direct right, the items, and the assignments", async () => {
    const { alpha } = await scene();
    as(rita);
    const data = await assignScreen();
    assert.equal(data.enforced, true);

    const byName = (n: string) => data.employees.find((e) => e.name === n)!;
    assert.equal(byName("Eva Editor").direct, false);
    assert.equal(byName("Pat Publisher").direct, true);
    assert.equal(byName("Rita Reviewer").direct, true);
    assert.ok(byName("Eva Editor").kinds.includes("media"));
    assert.deepEqual(byName("Eli Editor").kinds, ["product"], "he can be given products and nothing else");
    assert.equal(byName("Rita Reviewer").kinds.length, 0, "a reviewer with no content module can be given nothing");

    assert.equal(data.assignments.length, 3);
    const evasAlpha = data.assignments.find((a) => a.employeeId === eva.id && a.contentId === alpha)!;
    assert.equal(evasAlpha.itemLabel, "Product alpha");
    assert.equal(evasAlpha.kindLabel, "Products");
    assert.equal(evasAlpha.assignedByName, "Rita Reviewer");
    assert.ok(data.items.some((i) => i.id === alpha));
    assert.ok(data.items.every((i) => i.kind && i.label));
  });

  test("shows a whole-kind assignment as the kind, not an item", async () => {
    await scene();
    await assign(eva, "gallery");
    as(rita);
    const row = (await assignScreen()).assignments.find((a) => a.kind === "gallery")!;
    assert.equal(row.contentId, null);
    assert.equal(row.itemLabel, null);
    assert.equal(row.kindLabel, "Gallery tiles");
  });
});

/* ===================================================================== static */

describe("no screen reads a list around the scope", () => {
  const ROOT = process.cwd();
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

  test("every list, document and dashboard page narrows through the scope", () => {
    for (const f of [
      ["src", "app", "website", "cms-ui", "list-page.tsx"],
      ["src", "app", "website", "pages", "page.tsx"],
      ["src", "app", "website", "settings", "page.tsx"],
      ["src", "app", "website", "navigation", "page.tsx"],
    ]) {
      const src = read(...f);
      assert.match(src, /scopeFor\(/, `${f.join("/")} must build the person's scope`);
      assert.match(src, /visibleItems\(/, `${f.join("/")} must read through visibleItems`);
      assert.doesNotMatch(src, /\blistItems\(/, `${f.join("/")} reads a list straight from the service`);
    }
    const dash = read("src", "app", "website", "page.tsx");
    assert.match(dash, /dashboardSummary\(scope\)/);
    assert.match(dash, /slugVisible\(scope/);
  });

  test("the layout draws the sidebar from the scope too, and the module guard sends an unassigned editor to My work", () => {
    assert.match(read("src", "app", "website", "layout.tsx"), /slugVisible\(scope/);
    const guard = read("src", "app", "website", "require-module.ts");
    assert.match(guard, /slugVisible\(await scopeFor\(user\.id\), slug\)/);
    assert.match(guard, /redirect\("\/website\/my-work"\)/);
  });

  test("the editor's chrome narrows the library and the catalogue", () => {
    const src = read("src", "app", "website", "cms-ui", "chrome.ts");
    assert.match(src, /scopeFor\(user\.id\)/);
    assert.match(src, /other content/);
    assert.match(src, /scope\.covers\("product"/);
  });
});
