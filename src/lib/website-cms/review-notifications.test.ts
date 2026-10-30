/**
 * Who is TOLD what, against the real services and a real database.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test`, created by `npm run test:db` from the committed
 * migrations. It truncates between tests — never point it at a database anybody
 * is using.
 *
 * For every step of the review workflow that hands the work to somebody else, this
 * proves three things about the notification it writes: WHO receives it, WHAT it
 * says, and WHERE its link goes — and, as importantly, that NOBODY ELSE receives
 * anything. The recipients are checked against the whole `notifications` table
 * rather than against the person expected, because "she was told" is half of it
 * and "nobody else was" is the half that goes wrong.
 *
 * It also proves the notifications are what they are meant to be — a courtesy
 * after the fact: a failure to write one changes nothing about the workflow, and a
 * refused or failed action tells nobody anything.
 */
import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  appSecrets,
  notifications,
  users,
  websiteChangeRequest,
  websiteContent,
  websiteReviewSetting,
} from "@/db/schema";
import { launcherApps } from "@/lib/access";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { runJob } from "@/lib/jobs";
import { notificationAppOf } from "@/lib/notification-apps";
import type { Result } from "@/lib/result";
import { MODULE_SLUGS, PUBLISH_MODULE_KEY, REVIEW_MODULE_KEY } from "@/lib/website-cms/kinds";
import * as cms from "@/lib/website-cms/commands";
import { impactReport } from "@/lib/impact/registry";
import { APPROVED_TITLE, summarise } from "@/lib/website-cms/review-notify";
import * as review from "@/lib/website-cms/review-service";
import { createItem, transitionItems } from "@/lib/website-cms/service";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

type Person = typeof users.$inferSelect;

async function makeUser(name: string, opts: { modules?: string[]; app?: boolean; active?: boolean } = {}): Promise<Person> {
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
      active: opts.active ?? true,
    })
    .returning();
  if (opts.app !== false) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "website", role: "associate" });
  for (const m of opts.modules ?? []) await db.insert(appModuleAccess).values({ id: id("mod"), userId: row.id, app: "website", module: m });
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

const realFetch = globalThis.fetch;
function mockSite() {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, at: new Date().toISOString() }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

let pat: Person; //   publishes
let rita: Person; //  reviews
let ravi: Person; //  reviews — a second one, who must be told of every submission too
let rex: Person; //   reviews AND edits: submits his own, and must not be told of it
let rue: Person; //   a reviewer who has left (inactive)
let rob: Person; //   holds the review module's row but never the Website app
let eva: Person; //   an editor
let eli: Person; //   another editor — who must never be told about Eva's work

beforeEach(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test. Run `npm run test:db` first.");
  await db.execute(sql`
    truncate table
      website_change_item, website_change_request, website_assignment,
      website_publish_log, website_content, website_media, attachment_bytes,
      audit_log, notifications, app_module_access, app_secrets, app_access, users, app_settings
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
  ravi = await makeUser("Ravi Reviewer", { modules: ["website.dashboard", REVIEW_MODULE_KEY] });
  rex = await makeUser("Rex Both", { modules: [...ALL_CONTENT, REVIEW_MODULE_KEY] });
  rue = await makeUser("Rue Left", { modules: ["website.dashboard", REVIEW_MODULE_KEY], active: false });
  rob = await makeUser("Rob NoApp", { modules: [REVIEW_MODULE_KEY], app: false });
  eva = await makeUser("Eva Editor", { modules: ALL_CONTENT });
  eli = await makeUser("Eli Editor", { modules: ["website.dashboard", "website.products"] });
  setTestUser(pat);
  mockSite();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  // A test that broke the bell on purpose must not leave it broken.
  await db.execute(sql`alter table notifications drop constraint if exists website_test_block`);
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

async function bell() {
  return db.select().from(notifications).orderBy(asc(notifications.createdAt), asc(notifications.id));
}

async function bellOf(p: Person) {
  return (await bell()).filter((n) => n.userId === p.id);
}

/** Who received anything at all, by name — the half of every test that catches an extra recipient. */
async function recipients(): Promise<string[]> {
  const names = new Map((await db.select({ id: users.id, name: users.name }).from(users)).map((u) => [u.id, u.name]));
  return [...new Set((await bell()).map((n) => names.get(n.userId)!))].sort();
}

async function clearBell() {
  await db.delete(notifications);
}

async function live(slug: string, over: Record<string, unknown> = {}) {
  const made = must(await createItem(pat, "product", product(slug, over)));
  must(await transitionItems(pat, [made.id], "publish"));
  return made.id;
}

async function editAs(who: Person, itemId: string, over: Record<string, unknown>) {
  as(who);
  const [row] = await db.execute<{ data: Record<string, unknown>; version: number }>(sql`select data, version from website_content where id = ${itemId}`);
  return cms.saveContent(itemId, { ...row.data, ...over }, row.version);
}

async function assign(who: Person, kind: string, contentId: string | null = null, note?: string) {
  as(rita);
  return must(await cms.assignWork(who.id, kind, contentId ?? undefined, note));
}

/** A live product, assigned, edited and submitted by `who`. The bell is cleared, so a test sees only what comes next. */
async function submitted(slug = "alpha", who: Person = eva, over: Record<string, unknown> = { name: "Renamed" }) {
  await db.update(websiteReviewSetting).set({ enforceAssignments: true });
  const itemId = await live(slug);
  await assign(who, "product", itemId);
  must(await editAs(who, itemId, over));
  as(who);
  const made = must(await cms.submitForVerification([itemId]));
  await clearBell();
  return { itemId, requestId: made.id };
}

async function approved(slug = "alpha", who: Person = eva) {
  const s = await submitted(slug, who);
  as(rita);
  must(await cms.approveRequest(s.requestId));
  await clearBell();
  return s;
}

/* ============================================================ the wording */

describe("how a list of items is put in a sentence", () => {
  test("one is named, a few are listed, many are counted — never a wall of names", () => {
    assert.equal(summarise([]), "your changes");
    assert.equal(summarise(["Alpha"]), "“Alpha”");
    assert.equal(summarise(["Alpha", "Bravo"]), "“Alpha”, “Bravo”");
    assert.equal(summarise(["A", "B", "C"]), "“A”, “B”, “C”");
    assert.equal(summarise(["A", "B", "C", "D", "E"]), "5 items (“A”, “B” and 3 more)");
  });

  test("the approval wording is exactly what was asked for", () => {
    assert.equal(APPROVED_TITLE, "Verification Granted — You can now publish your approved changes.");
    assert.ok(APPROVED_TITLE.includes("—"), "an em dash, not a hyphen");
  });
});

/* ========================================================== assignment */

describe("assigning work tells the employee, and only the employee", () => {
  test("an item: one message, to her, saying who, what, and where to go", async () => {
    const itemId = await live("alpha");
    await assign(eva, "product", itemId);
    const mine = await bellOf(eva);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].title, "You have been assigned website work");
    assert.equal(mine[0].body, "Rita Reviewer assigned you the product “Product alpha”. You can edit it, and submit it for verification when it is ready.");
    assert.equal(mine[0].href, "/website/my-work");
    assert.equal(mine[0].kind, "info");
    assert.deepEqual(await recipients(), ["Eva Editor"], "nobody else — not the assigner, not other employees, not other reviewers");
  });

  test("a whole kind, the media library, and a note", async () => {
    await assign(eva, "gallery", null, "Please do the new tiles first.");
    await assign(eva, "media");
    const mine = await bellOf(eva);
    assert.equal(mine.length, 2);
    assert.match(mine[0].body, /assigned you all of the website's gallery tiles\. Please do the new tiles first\./);
    assert.match(mine[1].body, /assigned you the media library\./);
    assert.deepEqual(await recipients(), ["Eva Editor"]);
  });

  test("assigning what she already has says nothing a second time", async () => {
    const itemId = await live("alpha");
    await assign(eva, "product", itemId);
    await assign(eva, "product", itemId);
    assert.equal((await bellOf(eva)).length, 1);
  });

  test("a refused assignment tells nobody anything", async () => {
    const itemId = await live("alpha");
    as(eli);
    assert.equal((await cms.assignWork(eva.id, "product", itemId)).ok, false);
    as(rita);
    assert.equal((await cms.assignWork("usr_nobody", "product", itemId)).ok, false);
    assert.equal((await cms.assignWork(eli.id, "page")).ok, false, "he holds no Pages module");
    assert.equal((await bell()).length, 0);
  });
});

/* =========================================================== submission */

describe("submitting tells every reviewer, and nobody else", () => {
  test("every active holder of Review who is in the app, never the submitter, a leaver, a person with no app grant or anybody else", async () => {
    await db.update(websiteReviewSetting).set({ enforceAssignments: true });
    const itemId = await live("alpha");
    await assign(eva, "product", itemId);
    must(await editAs(eva, itemId, { name: "Renamed" }));
    await clearBell();
    as(eva);
    const made = must(await cms.submitForVerification([itemId], "Please check the name."));

    assert.deepEqual(await recipients(), ["Ravi Reviewer", "Rex Both", "Rita Reviewer"], "Rue left, Rob has no app, Pat only publishes, Eli and Eva are editors");
    for (const who of [rita, ravi, rex]) {
      const n = await bellOf(who);
      assert.equal(n.length, 1, who.name);
      assert.equal(n[0].title, "Website changes waiting for review");
      assert.equal(n[0].body, "Eva Editor submitted “Renamed” for verification. Note: “Please check the name.”");
      assert.equal(n[0].href, `/website/review/${made.id}`);
      assert.equal(n[0].kind, "info");
    }
    // Named, one by one, because each is a different way to be wrongly included.
    assert.equal((await bellOf(rue)).length, 0, "a reviewer who has left");
    assert.equal((await bellOf(rob)).length, 0, "holds the review module's row, never the Website app");
    assert.equal((await bellOf(pat)).length, 0, "publishes, does not review");
    assert.equal((await bellOf(eli)).length, 0, "another editor");
    assert.equal((await bellOf(eva)).length, 0, "the submitter");
  });

  test("a reviewer who submits their own work is not told about it — the others are", async () => {
    await db.update(websiteReviewSetting).set({ enforceAssignments: true });
    const itemId = await live("alpha");
    must(await editAs(rex, itemId, { name: "Rex's change" }));
    await clearBell();
    as(rex);
    must(await cms.submitForVerification([itemId]));
    assert.deepEqual(await recipients(), ["Ravi Reviewer", "Rita Reviewer"]);
  });

  test("a request of many items says how many, not which all of them are", async () => {
    await db.update(websiteReviewSetting).set({ enforceAssignments: true });
    const ids: string[] = [];
    for (const n of ["a", "b", "c", "d", "e"]) ids.push(await live(`bulk-${n}`));
    await assign(eva, "product");
    for (const item of ids) must(await editAs(eva, item, { short: "Changed." }));
    await clearBell();
    as(eva);
    must(await cms.submitForVerification(ids));
    const n = await bellOf(rita);
    assert.match(n[0].body, /^Eva Editor submitted 5 items \(“Product bulk-a”, “Product bulk-b” and 3 more\) for verification\.$/);
  });

  test("a refused or failed submission tells nobody", async () => {
    const itemId = await live("alpha");
    as(eva);
    assert.equal((await cms.submitForVerification([itemId])).ok, false, "no change to submit");
    assert.equal((await cms.submitForVerification(["wc_missing"])).ok, false);
    assert.equal((await cms.submitForVerification([])).ok, false);
    await db.update(websiteReviewSetting).set({ enforceAssignments: true });
    must(await editAs(pat, itemId, { name: "Pat's" }));
    as(eva);
    assert.equal((await cms.submitForVerification([itemId])).ok, false, "not assigned");
    assert.equal((await bell()).length, 0);
  });

  test("submitting something already in a request tells nobody twice", async () => {
    const { itemId } = await submitted("alpha", eva);
    as(eva);
    assert.equal((await cms.submitForVerification([itemId])).ok, false);
    assert.equal((await bell()).length, 0);
  });
});

/* ============================================================== approval */

describe("approving tells the employee — in exactly the agreed words — and nobody else", () => {
  test("the title is the agreed sentence, the body says who and until when, and the link opens her request", async () => {
    const { requestId } = await submitted();
    as(rita);
    must(await cms.approveRequest(requestId));
    const mine = await bellOf(eva);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].title, "Verification Granted — You can now publish your approved changes.");
    assert.match(mine[0].body, /^Rita Reviewer approved “Renamed”\. Publish it by .+; after that the approval lapses\.$/);
    assert.equal(mine[0].href, `/website/my-work/${requestId}`);
    assert.equal(mine[0].kind, "success");
    assert.deepEqual(await recipients(), ["Eva Editor"], "not the other reviewers, not the approver, not other editors");
  });

  test("the date in the message is the approval's own expiry", async () => {
    const { requestId } = await submitted();
    as(rita);
    must(await cms.approveRequest(requestId));
    const [req] = await db.select().from(websiteChangeRequest).where(eq(websiteChangeRequest.id, requestId));
    const { stamp } = await import("@/lib/format");
    assert.ok((await bellOf(eva))[0].body.includes(stamp(req.approvalExpiresAt!)));
  });

  test("a refused approval — by the wrong person, or of one's own work — tells nobody", async () => {
    const { requestId } = await submitted();
    as(eli);
    assert.equal((await cms.approveRequest(requestId)).ok, false);
    as(pat);
    assert.equal((await cms.approveRequest(requestId)).ok, false);
    assert.equal((await bell()).length, 0);

    await db.update(websiteReviewSetting).set({ enforceAssignments: true });
    const own = await live("own");
    must(await editAs(rex, own, { name: "Rex's own" }));
    as(rex);
    const made = must(await cms.submitForVerification([own]));
    await clearBell();
    assert.equal((await cms.approveRequest(made.id)).ok, false);
    assert.equal((await bell()).length, 0);
  });

  test("approving twice does not tell her twice", async () => {
    const { requestId } = await submitted();
    as(rita);
    must(await cms.approveRequest(requestId));
    assert.equal((await cms.approveRequest(requestId)).ok, false);
    assert.equal((await bellOf(eva)).length, 1);
  });
});

/* ============================================================= rejection */

describe("rejecting tells the employee, with the reason, and nobody else", () => {
  test("the reason is in the message, in the reviewer's own words", async () => {
    const { requestId } = await submitted();
    as(rita);
    must(await cms.rejectRequest(requestId, "The name still uses the old brand."));
    const mine = await bellOf(eva);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].title, "Website changes rejected");
    assert.equal(mine[0].body, "Rita Reviewer rejected “Renamed”: “The name still uses the old brand.” Fix what it says and submit it again.");
    assert.equal(mine[0].href, `/website/my-work/${requestId}`);
    assert.equal(mine[0].kind, "warn");
    assert.deepEqual(await recipients(), ["Eva Editor"]);
  });

  test("a rejection without a reason is refused and tells nobody", async () => {
    const { requestId } = await submitted();
    as(rita);
    for (const reason of ["", "   ", undefined]) assert.equal((await cms.rejectRequest(requestId, reason)).ok, false);
    assert.equal((await bell()).length, 0);
  });
});

/* ================================================== revoked, expired, stale */

describe("revocation, expiry and a voided approval each tell the employee, and only the employee", () => {
  test("revoked — by name, and that nothing went live", async () => {
    const { requestId } = await approved();
    as(rita);
    const bare = await cms.revokeApproval(requestId);
    assert.equal(!bare.ok && bare.code, "validation", "a revocation nobody confirmed is refused");
    assert.equal((await bellOf(eva)).length, 0, "and tells nobody anything");
    const report = await impactReport("site-approval-revoke", requestId);
    assert.ok(report.ok);
    const told = report.data.items.find((i) => /notification/.test(i.label));
    assert.deepEqual(told?.examples, [eva.name], "the modal names who will be told");
    must(await cms.revokeApproval(requestId, await confirmed("site-approval-revoke", requestId)));
    const mine = await bellOf(eva);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].title, "Approval revoked");
    assert.equal(mine[0].body, "Rita Reviewer took back the approval for “Renamed” before it was published. Nothing went live. You can submit it again.");
    assert.equal(mine[0].href, `/website/my-work/${requestId}`);
    assert.deepEqual(await recipients(), ["Eva Editor"]);
  });

  test("expired — by the sweep, once, whoever runs it", async () => {
    const { requestId } = await approved();
    await db.update(websiteChangeRequest).set({ approvalExpiresAt: new Date(Date.now() - 1000) }).where(eq(websiteChangeRequest.id, requestId));
    assert.equal(await review.sweepExpiredApprovals(), 1);
    const mine = await bellOf(eva);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].title, "Approval expired");
    assert.equal(mine[0].body, "The approval for “Renamed” ran out after 7 days and nothing was published. Submit it again to ask for it afresh.");
    assert.equal(mine[0].href, `/website/my-work/${requestId}`);
    assert.deepEqual(await recipients(), ["Eva Editor"], "the reviewer who approved it is not told it lapsed");

    assert.equal(await review.sweepExpiredApprovals(), 0);
    assert.equal((await bellOf(eva)).length, 1, "a second sweep says nothing more");
  });

  test("expired — found when she tries to publish it", async () => {
    const { requestId } = await approved();
    await db.update(websiteChangeRequest).set({ approvalExpiresAt: new Date(Date.now() - 1000) }).where(eq(websiteChangeRequest.id, requestId));
    as(eva);
    assert.equal((await cms.publishApproved(requestId)).ok, false);
    const mine = await bellOf(eva);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].title, "Approval expired");
    assert.deepEqual(await recipients(), ["Eva Editor"]);
  });

  test("voided — when the content moved before she published", async () => {
    const { itemId, requestId } = await approved();
    await db.update(websiteContent).set({ version: sql`version + 1` }).where(eq(websiteContent.id, itemId));
    as(eva);
    assert.equal((await cms.publishApproved(requestId)).ok, false);
    const mine = await bellOf(eva);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].title, "Approval no longer applies");
    assert.equal(mine[0].body, "“Renamed” changed after it was submitted, so the approval cannot be used and nothing was published. Submit it again.");
    assert.equal(mine[0].href, `/website/my-work/${requestId}`);
    assert.deepEqual(await recipients(), ["Eva Editor"]);
  });

  test("voided — when the content moved before anybody decided: the submitter is told, the reviewer who tried to approve is not", async () => {
    const { itemId, requestId } = await submitted();
    await db.update(websiteContent).set({ version: sql`version + 1` }).where(eq(websiteContent.id, itemId));
    as(rita);
    assert.equal((await cms.approveRequest(requestId)).ok, false);
    assert.equal((await bellOf(eva)).length, 1);
    assert.equal((await bellOf(eva))[0].title, "Approval no longer applies");
    assert.deepEqual(await recipients(), ["Eva Editor"]);
  });

  test("an approval revoked or voided by a reviewer who is not the one who approved it still tells only the submitter", async () => {
    const { requestId } = await approved();
    as(ravi);
    must(await cms.revokeApproval(requestId, await confirmed("site-approval-revoke", requestId)));
    assert.deepEqual(await recipients(), ["Eva Editor"]);
    assert.match((await bellOf(eva))[0].body, /^Ravi Reviewer took back the approval/);
  });
});

/* ====================================================== steps that say nothing */

describe("the steps nobody needs telling about", () => {
  test("withdrawing, publishing and saving a draft tell nobody", async () => {
    const one = await submitted("one");
    as(eva);
    must(await cms.withdrawRequest(one.requestId, await confirmed("site-request-withdraw", one.requestId)));
    assert.equal((await bell()).length, 0, "withdrawn: she did it herself, and the reviewers have nothing left to do");

    const two = await approved("two");
    as(eva);
    must(await cms.publishApproved(two.requestId));
    assert.equal((await bell()).length, 0, "published: she did it herself");

    const three = await live("three");
    await assign(eva, "product", three);
    await clearBell();
    must(await editAs(eva, three, { name: "A draft only" }));
    assert.equal((await bell()).length, 0, "a saved draft is nobody's news");
  });

  test("enforcement being switched, and reading a request, tell nobody", async () => {
    as(rita);
    must(await cms.setEnforceAssignments(true));
    must(await cms.setEnforceAssignments(false));
    const { requestId } = await submitted();
    as(rita);
    must(await cms.readRequest(requestId));
    assert.equal((await bell()).length, 0);
  });
});

/* ====================================================== the whole picture */

describe("every notification the workflow writes", () => {
  test("links into the Website app, and the bell files each one under it", async () => {
    // The full path, with a rejection and an approval, so every kind of message is written at least once.
    await db.update(websiteReviewSetting).set({ enforceAssignments: true });
    const a = await live("a");
    const b = await live("b");
    const c = await live("c");
    await assign(eva, "product");
    for (const [item, name] of [[a, "A2"], [b, "B2"], [c, "C2"]] as const) must(await editAs(eva, item, { name }));
    as(eva);
    const ra = must(await cms.submitForVerification([a])).id;
    const rb = must(await cms.submitForVerification([b])).id;
    const rc = must(await cms.submitForVerification([c])).id;
    as(rita);
    must(await cms.approveRequest(ra));
    must(await cms.rejectRequest(rb, "No."));
    must(await cms.approveRequest(rc));
    must(await cms.revokeApproval(rc, await confirmed("site-approval-revoke", rc)));

    const all = await bell();
    assert.ok(all.length >= 9, "assigned, three submissions to three reviewers, approved, rejected, approved, revoked");
    for (const n of all) {
      assert.ok(n.href && n.href.startsWith("/website/"), `${n.title}: ${n.href}`);
      assert.equal(notificationAppOf(n.href), "website", `${n.title} belongs in the Website bell`);
      assert.ok(n.title.length > 0 && n.body.length > 0);
      assert.equal(n.mbosHref, null, "the handset has no screen for these");
    }
    const titles = new Set(all.map((n) => n.title));
    for (const t of [
      "You have been assigned website work",
      "Website changes waiting for review",
      APPROVED_TITLE,
      "Website changes rejected",
      "Approval revoked",
    ]) assert.ok(titles.has(t), `${t} was written`);
  });

  test("the only people who ever receive one are the employee and the reviewers — never a publisher, another editor, a leaver, or somebody with no app", async () => {
    const { requestId } = await submitted();
    as(rita);
    must(await cms.approveRequest(requestId));
    as(eva);
    must(await cms.publishApproved(requestId));
    const names = await recipients();
    for (const never of ["Pat Publisher", "Eli Editor", "Rue Left", "Rob NoApp"]) assert.ok(!names.includes(never), `${never} must not be told`);
  });
});

/* ================================================================ best effort */

describe("a notification is a courtesy: it never changes what the workflow did", () => {
  async function breakTheBell() {
    // A constraint no row can satisfy: every insert into the bell now fails, which is what a full disk or a dead connection would do.
    await db.execute(sql`alter table notifications add constraint website_test_block check (false) not valid`);
  }

  test("a submission is saved, audited and locked even though nobody could be told", async () => {
    const itemId = await live("alpha");
    await db.update(websiteReviewSetting).set({ enforceAssignments: true });
    await assign(eva, "product", itemId);
    must(await editAs(eva, itemId, { name: "Renamed" }));
    await clearBell();
    await breakTheBell();
    as(eva);
    const made = must(await cms.submitForVerification([itemId]));
    assert.equal((await db.select().from(websiteChangeRequest).where(eq(websiteChangeRequest.id, made.id))).length, 1);
    assert.equal((await bell()).length, 0);
    assert.equal((await cms.saveContent(itemId, product("alpha"), 1)).ok, false, "and the item is still held by it");
  });

  test("an approval, a rejection, a revocation and a publish all stand when the bell is broken", async () => {
    const one = await submitted("one");
    const two = await submitted("two");
    const three = await approved("three");
    await breakTheBell();
    as(rita);
    must(await cms.approveRequest(one.requestId));
    must(await cms.rejectRequest(two.requestId, "No."));
    must(await cms.revokeApproval(three.requestId, await confirmed("site-approval-revoke", three.requestId)));
    const status = async (rid: string) => (await db.select().from(websiteChangeRequest).where(eq(websiteChangeRequest.id, rid)))[0].status;
    assert.equal(await status(one.requestId), "approved");
    assert.equal(await status(two.requestId), "rejected");
    assert.equal(await status(three.requestId), "revoked");
    as(eva);
    const pub = must(await cms.publishApproved(one.requestId));
    assert.equal(pub.changed, 1, "and the approved change still goes live");
    assert.equal((await bell()).length, 0);
  });

  test("an expiry sweep still expires, and a refused publish still refuses, when the bell is broken", async () => {
    const { requestId } = await approved();
    await db.update(websiteChangeRequest).set({ approvalExpiresAt: new Date(Date.now() - 1000) }).where(eq(websiteChangeRequest.id, requestId));
    await breakTheBell();
    assert.equal(await review.sweepExpiredApprovals(), 1);
    assert.equal((await db.select().from(websiteChangeRequest).where(eq(websiteChangeRequest.id, requestId)))[0].status, "expired");
  });

  test("an assignment still stands when the bell is broken", async () => {
    const itemId = await live("alpha");
    await breakTheBell();
    const made = await assign(eva, "product", itemId);
    assert.equal((await db.execute(sql`select 1 from website_assignment where id = ${made.id}`)).length, 1);
  });

  test("nothing is written before the change is safe: no message exists for a change that did not commit", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/website-cms/review-service.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // The only notify* calls in the service are inside closures queued for after the commit, or after the transaction call returned.
    const direct = [...code.matchAll(/await (notify\w+)\(/g)].map((m) => m[1]);
    assert.deepEqual(direct, [], "no notification is awaited directly — each is queued with runAfterCommit");
    assert.ok((code.match(/runAfterCommit\(/g) ?? []).length >= 7);
  });
});

/* =============================================================== the schedule */

describe("the hourly sweep of lapsed approvals", () => {
  test("is a step of the hourly cycle and a job that can be run by hand", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/jobs.ts"), "utf8");
    assert.match(src, /\| "website-review-expiry"/, "a job name");
    assert.match(src, /results\.push\(await run\("website-review-expiry", websiteReviewExpiryStep, triggeredById\)\)/, "a step of runHourly");
    assert.match(src, /case "website-review-expiry":\s*return \[await run\("website-review-expiry", websiteReviewExpiryStep, triggeredById\)\]/, "and by hand");
    const hourly = src.slice(src.indexOf("export async function runHourly"), src.indexOf("export async function runDayBoundary"));
    assert.ok(hourly.includes('"website-review-expiry"'), "inside runHourly, not beside it");
  });

  test("run by hand it expires what has lapsed, reports how many, and tells the employee once", async () => {
    const { requestId } = await approved();
    const live_ = await approved("live-one", eli);
    await db.update(websiteChangeRequest).set({ approvalExpiresAt: new Date(Date.now() - 1000) }).where(eq(websiteChangeRequest.id, requestId));

    const [first] = await runJob("website-review-expiry", pat.id);
    assert.equal(first.recordsAffected, 1);
    assert.match(first.detail ?? "", /1 lapsed approval expired/);
    assert.equal((await db.select().from(websiteChangeRequest).where(eq(websiteChangeRequest.id, requestId)))[0].status, "expired");
    assert.equal((await db.select().from(websiteChangeRequest).where(eq(websiteChangeRequest.id, live_.requestId)))[0].status, "approved", "an approval with time left is untouched");
    assert.deepEqual(await recipients(), ["Eva Editor"]);

    const [again] = await runJob("website-review-expiry", pat.id);
    assert.equal(again.recordsAffected, 0);
    assert.match(again.detail ?? "", /no approval had lapsed/);
    assert.equal((await bellOf(eva)).length, 1, "running it again tells nobody anything");
  });
});

/* ================================================================== launcher */

describe("the Website tile on the launcher", () => {
  const tile = async (who: Person) => (await launcherApps(who)).find((a) => a.id === "website")!;

  test("says 'Nothing waiting', with no badge, when nothing is", async () => {
    for (const who of [eva, rita, pat]) {
      const t = await tile(who);
      assert.equal(t.count, 0, who.name);
      assert.equal(t.status, "Nothing waiting", who.name);
    }
  });

  test("a reviewer's badge is the requests waiting for a decision, and the sentence says so", async () => {
    await submitted("a");
    await submitted("b", eli);
    const t = await tile(rita);
    assert.equal(t.count, 2);
    assert.equal(t.status, "2 changes to review");
    assert.equal((await tile(ravi)).count, 2, "every reviewer sees the same queue");
  });

  test("an employee is not told about the reviewers' queue, and a request waiting for a decision is not theirs to act on", async () => {
    await submitted("a");
    const t = await tile(eva);
    assert.equal(t.count, 0);
    assert.equal(t.status, "Nothing waiting");
    assert.equal((await tile(pat)).count, 0, "a publisher who does not review has nothing to decide");
  });

  test("an employee's badge is their approved changes and the requests that came back — nobody else's", async () => {
    const one = await submitted("one");
    const two = await submitted("two");
    const three = await submitted("three");
    as(rita);
    must(await cms.approveRequest(one.requestId));
    must(await cms.rejectRequest(two.requestId, "No."));
    void three;
    const t = await tile(eva);
    assert.equal(t.count, 2);
    assert.equal(t.status, "1 approved — ready to publish · 1 sent back to you");
    assert.equal((await tile(eli)).count, 0, "somebody else's work is not on his tile");
  });

  test("somebody who is both a reviewer and an employee sees both, and the badge is their sum", async () => {
    await db.update(websiteReviewSetting).set({ enforceAssignments: true });
    const mine = await live("rex-one");
    must(await editAs(rex, mine, { name: "Rex's" }));
    as(rex);
    const own = must(await cms.submitForVerification([mine]));
    await submitted("eva-one");
    as(rita);
    must(await cms.rejectRequest(own.id, "No."));
    const t = await tile(rex);
    assert.equal(t.count, 2, "one to review, one of his own sent back");
    assert.equal(t.status, "1 change to review · 1 sent back to you");
  });

  test("a request submitted again is no longer waiting on them", async () => {
    const { itemId, requestId } = await submitted();
    as(rita);
    must(await cms.rejectRequest(requestId, "No."));
    assert.equal((await tile(eva)).count, 1);
    must(await editAs(eva, itemId, { name: "Fixed" }));
    as(eva);
    must(await cms.submitForVerification([itemId], undefined, requestId));
    assert.equal((await tile(eva)).count, 0, "it is with the reviewers again");
    assert.equal((await tile(rita)).count, 1);
  });

  test("an approval that has lapsed is not offered for publishing, even before the sweep has run", async () => {
    const { requestId } = await approved();
    assert.equal((await tile(eva)).status, "1 approved — ready to publish");
    await db.update(websiteChangeRequest).set({ approvalExpiresAt: new Date(Date.now() - 1000) }).where(eq(websiteChangeRequest.id, requestId));
    const t = await tile(eva);
    assert.equal(t.status, "1 sent back to you", "the tile must not say publish what the server would refuse");
    assert.equal(t.count, 1);
  });

  test("withdrawn, published and decided requests are not waiting on anybody", async () => {
    const one = await submitted("one");
    as(eva);
    must(await cms.withdrawRequest(one.requestId, await confirmed("site-request-withdraw", one.requestId)));
    const two = await approved("two");
    as(eva);
    must(await cms.publishApproved(two.requestId));
    assert.equal((await tile(eva)).count, 0);
    assert.equal((await tile(rita)).count, 0);
  });
});
