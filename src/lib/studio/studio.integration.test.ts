/**
 * THE STUDIO, end to end — the actions against a real database and the real
 * renderer.
 *
 * A poster is made only for somebody in the maker's own book; it is stored as
 * a recipe and draws the same picture again from it; a bulk run skips, with a
 * reason, anybody the design cannot be made for; a withheld module is refused
 * in the action and not only in the sidebar; and an uploaded design is
 * published only by somebody given `studio.approve`, after which anybody can
 * make posters from it.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";

import { db } from "@/db";
import { appAccess, appModuleAccess, appSettings, auditLog, customers, studioBatches, studioDesignVersions, studioDesigns, studioPosters, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { fileStorage } from "@/lib/storage";
import { approveDesign, archiveDesign, deleteDraft, makeBatch, makePoster, publishDesign, recordShare, restoreDesign, reviseDesign, saveDraftPlacement, savePersonDate } from "@/lib/actions/studio";
import { POST as uploadRoute } from "@/app/api/studio/designs/upload/route";
import { buildManifest, copyFromDraft, defaultPlacement, canvasById, type PlacementDraft } from "./domain/template-upload";
import { listRecipients } from "./recipients";
import { renderRecipe } from "./render-service";
import { isUniqueViolation } from "./db-errors";
import { getStudioRegistry, validateCandidate } from "./registry-service";
import { listPosters, peopleDates, recipeOf } from "./service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, role: "associate" | "manager", modules?: string[]) {
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", role, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "studio", role });
  for (const m of modules ?? []) await db.insert(appModuleAccess).values({ id: id("amx"), userId: row.id, app: "studio", module: m });
  return row;
}

async function makeCustomer(owner: string, over: Record<string, unknown> = {}) {
  const cid = id("cus");
  await db.insert(customers).values({ id: cid, name: "Shree Paints", companyName: "Shree Paints", contactPerson: "Rajesh Shah", phone: "9820099001", city: "Nagpur", kind: "customer", ownerId: owner, salesAmId: owner, ...over } as never);
  return cid;
}

let priya: typeof users.$inferSelect;
let rakesh: typeof users.$inferSelect;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table studio_poster_shares, studio_posters, studio_batches, studio_designs, studio_people_dates, studio_reminder_state,
      customers, attachment_bytes, audit_log, notifications, app_module_access, app_access, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  priya = await makeUser("Priya Sharma", "associate");
  rakesh = await makeUser("Rakesh Iyer", "associate");
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("One poster", () => {
  test("is made for a customer in the maker's book, stored as a recipe, and draws again from it", async () => {
    const cid = await makeCustomer(priya.id);
    setTestUser(priya);
    const made = await makePoster({ customerId: cid, templateId: "diwali-classic", language: "en", showProduct: true });
    assert.ok(made.ok, made.ok ? "" : made.error);
    const [row] = await db.select().from(studioPosters).where(eq(studioPosters.id, made.data.id));
    assert.equal(row.customerId, cid);
    assert.equal(row.recipient.company, "Shree Paints");
    assert.equal(row.senderName, "Priya Sharma");
    assert.match(row.templateVersion, /^\d+\.\d+\.\d+$/);
    const drawn = await renderRecipe(recipeOf(row), "png");
    assert.ok(drawn.ok);
    assert.equal(drawn.data.image.subarray(1, 4).toString("ascii"), "PNG");
  });

  test("is refused for a customer in somebody else's book, and says nothing about whether it exists", async () => {
    const theirs = await makeCustomer(rakesh.id);
    setTestUser(priya);
    const made = await makePoster({ customerId: theirs, templateId: "diwali-classic", language: "en", showProduct: true });
    assert.equal(made.ok, false);
    assert.equal(made.ok ? null : made.code, "not_found");
    assert.equal((await db.select().from(studioPosters)).length, 0);
  });

  test("a lost lead is greeted as a lead, and is listed on its own", async () => {
    await makeCustomer(priya.id, { kind: "lead", leadStage: "lost", companyName: "Gone Coatings", name: "Gone Coatings" });
    await makeCustomer(priya.id, { kind: "lead", leadStage: "new", companyName: "New Coatings", name: "New Coatings" });
    const lost = await listRecipients({ userIds: [priya.id], list: "lost" });
    const leads = await listRecipients({ userIds: [priya.id], list: "lead" });
    assert.deepEqual(lost.rows.map((r) => r.company), ["Gone Coatings"]);
    assert.deepEqual(leads.rows.map((r) => r.company), ["New Coatings"]);
  });

  test("a withheld module is refused in the action, not only hidden from the sidebar", async () => {
    const narrowed = await makeUser("Anjali Rao", "associate", ["studio.home", "studio.posters"]);
    const cid = await makeCustomer(narrowed.id);
    setTestUser(narrowed);
    const made = await makePoster({ customerId: cid, templateId: "diwali-classic", language: "en", showProduct: true });
    assert.equal(made.ok, false);
    assert.equal(made.ok ? null : made.code, "not_permitted");
  });

  test("a share is recorded against the poster and counted on it", async () => {
    const cid = await makeCustomer(priya.id);
    setTestUser(priya);
    const made = await makePoster({ customerId: cid, templateId: "diwali-classic", language: "en", showProduct: true });
    assert.ok(made.ok);
    assert.ok((await recordShare(made.data.id, "download", "png")).ok);
    assert.ok((await recordShare(made.data.id, "whatsapp")).ok);
    const mine = await listPosters({ whose: "mine" });
    assert.equal(mine.rows[0]?.shareCount, 2);
    setTestUser(rakesh);
    assert.equal((await recordShare(made.data.id, "download")).ok, false, "a poster outside somebody's sight cannot be shared by them");
  });
});

describe("Bulk posters", () => {
  test("makes a recipe for each customer and skips, with the reason, one the batch is not for", async () => {
    const a = await makeCustomer(priya.id, { companyName: "Alpha Paints", name: "Alpha Paints" });
    const b = await makeCustomer(priya.id, { companyName: "Beta Paints", name: "Beta Paints" });
    const lead = await makeCustomer(priya.id, { kind: "lead", companyName: "Gamma Leads", name: "Gamma Leads" });
    const theirs = await makeCustomer(rakesh.id, { companyName: "Delta Paints", name: "Delta Paints" });
    setTestUser(priya);
    const run = await makeBatch({ list: "customer", templateId: "diwali-classic", language: "en", showProduct: true, customerIds: [a, b, lead, theirs] });
    assert.ok(run.ok, run.ok ? "" : run.error);
    assert.equal(run.data.made, 2);
    assert.equal(run.data.skipped, 2);
    const [batch] = await db.select().from(studioBatches).where(eq(studioBatches.id, run.data.id));
    assert.deepEqual(batch.skipped.map((s) => s.customerId).sort(), [lead, theirs].sort());
    assert.ok(batch.skipped.every((s) => s.reason.length > 0));
    assert.equal((await db.select().from(studioPosters).where(eq(studioPosters.batchId, run.data.id))).length, 2);
  });

  test("refuses more than fifty at once", async () => {
    setTestUser(priya);
    const run = await makeBatch({ list: "customer", templateId: "diwali-classic", language: "en", showProduct: true, customerIds: Array.from({ length: 51 }, (_, i) => `c${i}`) });
    assert.equal(run.ok, false);
  });
});

describe("Uploaded designs", () => {
  async function draft(owner: string) {
    const png = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#1F3A5F" } }).png().toBuffer();
    const designId = id("custom-test").replace(/_/g, "-");
    const stored = await fileStorage.upload({ key: `studio/designs/${designId}/background.png`, body: png, contentType: "image/png" });
    const placement: PlacementDraft = { name: "Monsoon wishes", canvas: "square", occasion: "anytime", fields: [], messages: [] };
    await db.insert(studioDesigns).values({ id: designId, name: placement.name, canvas: "square", placement, backgroundRef: stored.ref, sourceSha256: "x", createdById: owner });
    const canvas = canvasById("square")!;
    placement.fields = [defaultPlacement("company_name", canvas, [])];
    return { designId, placement };
  }

  test("only somebody given studio.approve can publish one, and then anybody can make a poster from it", async () => {
    /* Given the Studio on the Access screen with its defaults: every module
       except the one that is off by default. */
    const uploader = await makeUser("Neha Joshi", "associate", ["studio.home", "studio.make", "studio.posters", "studio.designs"]);
    const { designId, placement } = await draft(uploader.id);
    setTestUser(uploader);
    assert.ok((await saveDraftPlacement(designId, placement)).ok);
    const refused = await approveDesign(designId);
    assert.equal(refused.ok, false, "somebody without studio.approve cannot publish their own upload");

    const approver = await makeUser("Vikram Shah", "manager", ["studio.home", "studio.make", "studio.designs", "studio.approve"]);
    setTestUser(approver);
    const approved = await approveDesign(designId);
    assert.ok(approved.ok, approved.ok ? "" : approved.error);
    const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    assert.equal(row.status, "approved");
    assert.ok(row.manifest && row.previewRef);

    const registry = await getStudioRegistry();
    assert.ok(registry.get(designId), "an approved upload is in the registry");
    const cid = await makeCustomer(priya.id);
    setTestUser(priya);
    const made = await makePoster({ customerId: cid, templateId: designId, language: "en", showProduct: true });
    assert.ok(made.ok, made.ok ? "" : made.error);
    setTestUser(uploader);
    assert.equal((await saveDraftPlacement(designId, placement)).ok, false, "an approved design can never be changed");
  });
});

describe("Shared template library", () => {
  const MODULES = ["studio.home", "studio.make", "studio.posters", "studio.designs"];

  /** A complete three-language draft in the owner's name: a company name, a greeting and a fixed headline. */
  async function multiDraft(owner: string, languages: ("hi" | "gu")[] = ["hi", "gu"]) {
    const png = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#1F3A5F" } }).png().toBuffer();
    const designId = id("custom-lib").replace(/_/g, "-");
    const stored = await fileStorage.upload({ key: `studio/designs/${designId}/background.png`, body: png, contentType: "image/png" });
    const canvas = canvasById("square")!;
    const company = { ...defaultPlacement("company_name", canvas, []), y: 80 };
    const greeting = { ...defaultPlacement("greeting", canvas, []), y: 300 };
    const headline = { ...defaultPlacement("occasion_title", canvas, []), y: 600, text: "Season's Greetings" };
    const i18n: NonNullable<PlacementDraft["i18n"]> = {};
    if (languages.includes("hi")) i18n.hi = { messages: ["आपके और आपकी टीम के लिए सफल मौसम की शुभकामनाएँ।"], statics: { occasion_title: "शुभकामनाएँ" } };
    if (languages.includes("gu")) i18n.gu = { messages: ["તમને અને તમારી ટીમને સફળ મોસમની શુભેચ્છાઓ."], statics: { occasion_title: "શુભેચ્છાઓ" } };
    const placement: PlacementDraft = { name: "Monsoon library", canvas: "square", occasion: "anytime", fields: [company, greeting, headline], messages: ["Wishing you a bright season ahead."], languages, i18n };
    await db.insert(studioDesigns).values({ id: designId, name: placement.name, canvas: "square", placement, backgroundRef: stored.ref, sourceSha256: "x", createdById: owner });
    return { designId, placement };
  }

  test("a studio.designs holder publishes their own draft at once, in three languages, and another user can make a poster in each", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const { designId, placement } = await multiDraft(uploader.id);
    setTestUser(uploader);
    assert.ok((await saveDraftPlacement(designId, placement)).ok);
    const published = await publishDesign(designId);
    assert.ok(published.ok, published.ok ? "" : published.error);
    const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    assert.equal(row.status, "approved");
    assert.equal(row.approvedById, uploader.id);

    const registry = await getStudioRegistry();
    const t = registry.get(designId);
    assert.ok(t, "published at once: in the shared library");
    assert.deepEqual(t!.manifest.languages, ["en", "hi", "gu"]);

    const cid = await makeCustomer(priya.id);
    setTestUser(priya);
    for (const language of ["en", "hi", "gu"]) {
      const made = await makePoster({ customerId: cid, templateId: designId, language, showProduct: true });
      assert.ok(made.ok, `${language}: ${made.ok ? "" : made.error}`);
      const [poster] = await db.select().from(studioPosters).where(eq(studioPosters.id, made.data.id));
      const drawn = await renderRecipe(recipeOf(poster), "png");
      assert.ok(drawn.ok, `${language}: ${drawn.ok ? "" : drawn.error}`);
    }
  });

  test("an incomplete language is never published", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const { designId, placement } = await multiDraft(uploader.id, ["hi"]);
    placement.i18n!.hi!.messages = [];
    await db.update(studioDesigns).set({ placement }).where(eq(studioDesigns.id, designId));
    setTestUser(uploader);
    const refused = await publishDesign(designId);
    assert.equal(refused.ok, false);
    const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    assert.equal(row.status, "draft");
    assert.equal((await getStudioRegistry()).get(designId), null);
  });

  test("a draft is private: nobody else can publish or archive it, an approver may not publish it either, and publishing needs the Designs screen", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const { designId } = await multiDraft(uploader.id);
    setTestUser(priya);
    assert.equal((await publishDesign(designId)).ok, false, "no module at all");
    const other = await makeUser("Meena Rao", "associate", MODULES);
    setTestUser(other);
    assert.equal((await publishDesign(designId)).ok, false, "somebody else's draft");
    const approver = await makeUser("Vikram Shah", "manager", [...MODULES, "studio.approve"]);
    setTestUser(approver);
    assert.equal((await publishDesign(designId)).ok, false, "publishing is the uploader's; an approver uses approveDesign");
    const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    assert.equal(row.status, "draft");
  });

  test("with immediate publishing switched off the uploader waits for an approver, and the approval path still works", async () => {
    await db.update(appSettings).set({ value: false }).where(eq(appSettings.key, "studio.publishImmediately"));
    invalidateConfig();
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const { designId } = await multiDraft(uploader.id);
    setTestUser(uploader);
    assert.equal((await publishDesign(designId)).ok, false);
    const approver = await makeUser("Vikram Shah", "manager", [...MODULES, "studio.approve"]);
    setTestUser(approver);
    const approved = await approveDesign(designId);
    assert.ok(approved.ok, approved.ok ? "" : approved.error);
  });

  test("archive and restore: the uploader and an approver may, anybody else may not; posters made before keep drawing", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const { designId } = await multiDraft(uploader.id);
    setTestUser(uploader);
    assert.ok((await publishDesign(designId)).ok);
    const cid = await makeCustomer(priya.id);
    setTestUser(priya);
    const made = await makePoster({ customerId: cid, templateId: designId, language: "hi", showProduct: true });
    assert.ok(made.ok, made.ok ? "" : made.error);
    const [poster] = await db.select().from(studioPosters).where(eq(studioPosters.id, made.data.id));

    const stranger = await makeUser("Meena Rao", "associate", MODULES);
    setTestUser(stranger);
    assert.equal((await archiveDesign(designId)).ok, false, "not theirs");
    setTestUser(uploader);
    const archived = await archiveDesign(designId);
    assert.ok(archived.ok, archived.ok ? "" : archived.error);

    const registry = await getStudioRegistry();
    assert.equal(registry.get(designId), null, "archived: not offered");
    assert.equal(registry.list().some((t) => t.manifest.id === designId), false);
    assert.ok(registry.getVersion(designId, poster.templateVersion), "archived: the version a poster names is still there");
    const again = await renderRecipe(recipeOf(poster), "png");
    assert.ok(again.ok, again.ok ? "" : again.error);
    setTestUser(priya);
    const refused = await makePoster({ customerId: cid, templateId: designId, language: "en", showProduct: true });
    assert.equal(refused.ok, false, "no new poster from an archived design");

    setTestUser(stranger);
    assert.equal((await restoreDesign(designId)).ok, false);
    const approver = await makeUser("Vikram Shah", "manager", [...MODULES, "studio.approve"]);
    setTestUser(approver);
    const restored = await restoreDesign(designId);
    assert.ok(restored.ok, restored.ok ? "" : restored.error);
    assert.ok((await getStudioRegistry()).get(designId), "restored: offered again");
    const [after] = await db.select().from(studioPosters).where(eq(studioPosters.id, poster.id));
    assert.deepEqual([after.templateId, after.templateVersion], [poster.templateId, poster.templateVersion], "the poster row is untouched");
    assert.ok((await archiveDesign(designId)).ok, "an approver may archive somebody else's design");
  });
});

describe("Template library: publish gate, restore rights, registry cache, drafts, versions, originals", () => {
  const MODULES = ["studio.home", "studio.make", "studio.posters", "studio.designs"];
  const APPROVER = [...MODULES, "studio.approve"];

  async function png(color = "#1F3A5F", size = 1080) {
    return sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer();
  }

  /** A draft in the owner's name, English plus the languages asked for, every one complete. */
  async function draftFor(owner: string, languages: ("hi" | "gu")[] = []) {
    const designId = id("custom-gate").replace(/_/g, "-");
    const stored = await fileStorage.upload({ key: `studio/designs/${designId}/background.png`, body: await png(), contentType: "image/png" });
    const canvas = canvasById("square")!;
    const i18n: NonNullable<PlacementDraft["i18n"]> = {};
    if (languages.includes("hi")) i18n.hi = { messages: ["आपके और आपकी टीम के लिए सफल मौसम की शुभकामनाएँ।"], statics: {} };
    if (languages.includes("gu")) i18n.gu = { messages: ["તમને અને તમારી ટીમને સફળ મોસમની શુભેચ્છાઓ."], statics: {} };
    const placement: PlacementDraft = {
      name: "Gate test",
      canvas: "square",
      occasion: "anytime",
      fields: [{ ...defaultPlacement("company_name", canvas, []), y: 80 }, { ...defaultPlacement("greeting", canvas, []), y: 300 }],
      messages: ["Wishing you a bright season ahead."],
      ...(languages.length ? { languages, i18n } : {}),
    };
    await db.insert(studioDesigns).values({ id: designId, name: placement.name, canvas: "square", placement, backgroundRef: stored.ref, sourceSha256: "x", createdById: owner });
    return { designId, placement };
  }

  async function published(owner: Awaited<ReturnType<typeof makeUser>>, languages: ("hi" | "gu")[] = []) {
    const d = await draftFor(owner.id, languages);
    setTestUser(owner);
    const r = await publishDesign(d.designId);
    assert.ok(r.ok, r.ok ? "" : r.error);
    return d;
  }

  /* ---------------------------------------------------------------- 1. the gate is the loader */

  test("a published upload is in the REAL registry, on disk, and a poster can be made from it", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const { designId } = await published(uploader, ["hi", "gu"]);
    const registry = await getStudioRegistry();
    const t = registry.get(designId);
    assert.ok(t, "the registry the app uses lists it");
    assert.equal(registry.problems().some((p) => p.folder.includes(designId)), false, "the loader reported nothing against it");
    assert.equal(t!.manifest.status, "approved");
    assert.ok(t!.copy.hi?.length && t!.copy.gu?.length && t!.copy.en?.length, "wording for every declared language was loaded");
    const cid = await makeCustomer(priya.id);
    setTestUser(priya);
    const made = await makePoster({ customerId: cid, templateId: designId, language: "gu", showProduct: true });
    assert.ok(made.ok, made.ok ? "" : made.error);
  });

  test("wording the loader would reject is refused at publish, in English as well, and the design stays a draft", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    for (const bad of ["Welcome to Mahek, thanks for your interest.", "Get 20 free cans this week.", "Visit www.example.com today."]) {
      const d = await draftFor(uploader.id);
      d.placement.messages = [bad];
      await db.update(studioDesigns).set({ placement: d.placement }).where(eq(studioDesigns.id, d.designId));
      setTestUser(uploader);
      const r = await publishDesign(d.designId);
      assert.equal(r.ok, false, bad);
      const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, d.designId));
      assert.equal(row.status, "draft", bad);
    }
    assert.equal((await getStudioRegistry()).list().some((t) => t.manifest.tags.includes("custom")), false);
  });

  test("validateCandidate runs the loader: a missing language, an unregistered occasion and a wrong-size background are all refused", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const { placement } = await draftFor(uploader.id, ["hi"]);
    const meta = { id: "custom-candidate-1", version: "1.0.0", status: "approved" as const, approvedBy: "T", approvedAt: "2026-11-13" };
    const built = buildManifest(placement, meta);
    assert.ok(built.ok);
    if (!built.ok) return;
    const bg = await png();
    const good = validateCandidate({ manifest: built.manifest, copy: copyFromDraft(placement), background: bg, preview: bg });
    assert.deepEqual(good, [], good.join("; "));
    const noHindi = validateCandidate({ manifest: built.manifest, copy: { en: copyFromDraft(placement).en }, background: bg, preview: bg });
    assert.ok(noHindi.some((p) => /no wording for declared language "hi"/.test(p)), noHindi.join("; "));
    const wrongSize = validateCandidate({ manifest: built.manifest, copy: copyFromDraft(placement), background: await png("#000000", 540), preview: bg });
    assert.ok(wrongSize.some((p) => /background is 540x540/.test(p)), wrongSize.join("; "));
    const unlisted = { ...built.manifest, occasion: "no-such-occasion" };
    const badOccasion = validateCandidate({ manifest: unlisted, copy: copyFromDraft(placement), background: bg, preview: bg });
    assert.ok(badOccasion.some((p) => /occasion/.test(p)), badOccasion.join("; "));
  });

  /* ---------------------------------------------------------------- 2. who may restore */

  test("an uploader restores only what they archived themselves; an approver restores anything; archive and restore are audited with who did it", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const approver = await makeUser("Vikram Shah", "manager", APPROVER);
    const mine = await published(uploader);
    const theirs = await published(uploader);

    setTestUser(uploader);
    assert.ok((await archiveDesign(mine.designId)).ok);
    assert.ok((await restoreDesign(mine.designId)).ok, "they archived it, so they may restore it");

    setTestUser(approver);
    assert.ok((await archiveDesign(theirs.designId)).ok, "an approver archives somebody else's");
    const [archived] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, theirs.designId));
    assert.equal(archived.status, "archived");
    assert.equal(archived.archivedById, approver.id, "WHO archived it is recorded");

    setTestUser(uploader);
    const refused = await restoreDesign(theirs.designId);
    assert.equal(refused.ok, false, "the uploader cannot undo an approver's archive");
    const [still] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, theirs.designId));
    assert.equal(still.status, "archived");

    const stranger = await makeUser("Meena Rao", "associate", MODULES);
    setTestUser(stranger);
    assert.equal((await restoreDesign(theirs.designId)).ok, false, "somebody else entirely cannot");

    setTestUser(approver);
    assert.ok((await restoreDesign(theirs.designId)).ok, "an approver restores anybody's");
    const [back] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, theirs.designId));
    assert.deepEqual([back.status, back.archivedById], ["approved", null]);

    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, theirs.designId));
    const kinds = rows.map((r) => r.action);
    assert.ok(kinds.includes("studio.design.archived") && kinds.includes("studio.design.restored") && kinds.includes("studio.design.published"), kinds.join(","));
    const archivedRow = rows.find((r) => r.action === "studio.design.archived")!;
    assert.equal(archivedRow.actorId, approver.id);
    assert.equal((archivedRow.afterState as { byApprover: boolean }).byApprover, true);
    const restoredRow = rows.find((r) => r.action === "studio.design.restored")!;
    assert.equal((restoredRow.afterState as { archivedBy: string }).archivedBy, approver.id);
  });

  /* ---------------------------------------------------------------- 3. the registry never caches a failure */

  test("a design whose files could not be read is left out of ONE answer and is back on the next call, with nothing changed", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const { designId } = await published(uploader);
    const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    const bg = Buffer.from(await fileStorage.read(row.backgroundRef));
    await getStudioRegistry();
    /* Storage loses the artwork, and the folder cache is wiped: the next build cannot write this design's folder. */
    await fileStorage.remove(row.backgroundRef);
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    fs.rmSync(path.join(os.tmpdir(), "mahek-studio-designs", "approved", designId), { recursive: true, force: true });
    const failed = await getStudioRegistry();
    assert.equal(failed.get(designId), null, "this request cannot have it");
    /* Storage comes back. Nothing about the rows changed, so a cached failure would stay for good. */
    await fileStorage.upload({ key: row.backgroundRef, body: bg, contentType: "image/png" });
    const again = await getStudioRegistry();
    assert.ok(again.get(designId), "the next call retried and found it");
  });

  /* ---------------------------------------------------------------- 4. drafts need the Designs screen */

  test("saving or deleting a draft needs studio.designs in the action itself, and ownership as well", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const { designId, placement } = await draftFor(uploader.id);
    const without = await makeUser("Dev Patil", "associate", ["studio.home", "studio.make"]);
    await db.update(studioDesigns).set({ createdById: without.id }).where(eq(studioDesigns.id, designId));
    setTestUser(without);
    assert.equal((await saveDraftPlacement(designId, placement)).ok, false, "owner, but no Designs screen");
    assert.equal((await deleteDraft(designId)).ok, false);
    await db.update(studioDesigns).set({ createdById: uploader.id }).where(eq(studioDesigns.id, designId));
    const other = await makeUser("Meena Rao", "associate", MODULES);
    setTestUser(other);
    assert.equal((await saveDraftPlacement(designId, placement)).ok, false, "has the screen, not the owner");
    assert.equal((await deleteDraft(designId)).ok, false);
    setTestUser(uploader);
    assert.ok((await saveDraftPlacement(designId, placement)).ok);
    assert.ok((await deleteDraft(designId)).ok);
  });

  /* ---------------------------------------------------------------- 5. language content is stored tidy */

  test("saving drops wording for a language that is no longer declared and for a fixed field that is no longer placed", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const { designId, placement } = await draftFor(uploader.id, ["hi", "gu"]);
    setTestUser(uploader);
    placement.i18n!.hi!.statics = { occasion_title: "शुभकामनाएँ" };
    assert.ok((await saveDraftPlacement(designId, { ...placement, languages: ["hi"] })).ok);
    const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    const stored = row.placement as PlacementDraft;
    assert.deepEqual(stored.languages, ["hi"]);
    assert.deepEqual(Object.keys(stored.i18n ?? {}), ["hi"], "Gujarati is gone");
    assert.deepEqual(stored.i18n!.hi!.statics, {}, "no fixed headline is placed, so none is kept");
    assert.ok((await saveDraftPlacement(designId, { ...placement, languages: [], i18n: undefined })).ok);
    const [en] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    assert.equal("languages" in (en.placement as object), false, "an English-only design is stored exactly as before");
    assert.equal("i18n" in (en.placement as object), false);
  });

  /* ---------------------------------------------------------------- 6. versions */

  test("a new version keeps the design's id, keeps the old version for the posters made from it, and never breaks them", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const { designId } = await published(uploader, ["hi"]);
    const cid = await makeCustomer(priya.id);
    setTestUser(priya);
    const before = await makePoster({ customerId: cid, templateId: designId, language: "hi", showProduct: true });
    assert.ok(before.ok, before.ok ? "" : before.error);
    const [oldPoster] = await db.select().from(studioPosters).where(eq(studioPosters.id, before.data.id));
    assert.equal(oldPoster.templateVersion, "1.0.0");
    const oldPicture = await renderRecipe(recipeOf(oldPoster), "png");
    assert.ok(oldPicture.ok);

    const stranger = await makeUser("Meena Rao", "associate", MODULES);
    setTestUser(stranger);
    assert.equal((await reviseDesign(designId)).ok, false, "not theirs, and not an approver");

    setTestUser(uploader);
    const started = await reviseDesign(designId);
    assert.ok(started.ok, started.ok ? "" : started.error);
    const again = await reviseDesign(designId);
    assert.ok(again.ok && again.data.id === started.data.id, "asking again resumes the open draft");
    const revisionId = started.data.id;
    const [draft] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, revisionId));
    assert.equal(draft.revisesId, designId);
    assert.equal(draft.status, "draft");
    assert.notEqual(draft.backgroundRef, (await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId)))[0].backgroundRef, "the draft owns its own copy of the artwork");

    const moved = { ...(draft.placement as PlacementDraft), name: "Monsoon library 2" };
    moved.fields = moved.fields.map((f) => (f.key === "company_name" ? { ...f, x: f.x + 20, w: f.w - 40 } : f));
    assert.ok((await saveDraftPlacement(revisionId, moved)).ok);
    const published2 = await publishDesign(revisionId);
    assert.ok(published2.ok, published2.ok ? "" : published2.error);

    const [now] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    assert.equal(now.version, "1.0.1");
    assert.equal(now.name, "Monsoon library 2");
    assert.equal((await db.select().from(studioDesigns).where(eq(studioDesigns.id, revisionId))).length, 0, "the draft is gone");
    const kept = await db.select().from(studioDesignVersions).where(eq(studioDesignVersions.designId, designId));
    assert.deepEqual(kept.map((k) => k.version), ["1.0.0"]);

    const registry = await getStudioRegistry();
    assert.equal(registry.get(designId)!.manifest.version, "1.0.1");
    assert.ok(registry.getVersion(designId, "1.0.0"), "the version the old poster names is still there");
    assert.equal(registry.list().filter((t) => t.manifest.id === designId).length, 1, "one design in the library, not two");
    const still = await renderRecipe(recipeOf(oldPoster), "png");
    assert.ok(still.ok, still.ok ? "" : still.error);
    setTestUser(priya);
    const fresh = await makePoster({ customerId: cid, templateId: designId, language: "hi", showProduct: true });
    assert.ok(fresh.ok);
    const [newPoster] = await db.select().from(studioPosters).where(eq(studioPosters.id, fresh.data.id));
    assert.equal(newPoster.templateVersion, "1.0.1");

    /* Archiving the design afterwards keeps BOTH versions drawable. */
    setTestUser(uploader);
    assert.ok((await archiveDesign(designId)).ok);
    const r2 = await getStudioRegistry();
    assert.equal(r2.get(designId), null);
    assert.ok(r2.getVersion(designId, "1.0.0") && r2.getVersion(designId, "1.0.1"));
    assert.ok((await renderRecipe(recipeOf(oldPoster), "png")).ok);
    assert.ok((await renderRecipe(recipeOf(newPoster), "png")).ok);
    assert.equal((await reviseDesign(designId)).ok, false, "an archived design must be restored before it gets a new version");
  });

  /* ---------------------------------------------------------------- 7. the original upload */

  test("the file as uploaded is kept in file storage — JPEG, PNG and WebP — beside the normalised background", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    setTestUser(uploader);
    for (const [format, ext] of [["jpeg", "jpg"], ["png", "png"], ["webp", "webp"]] as const) {
      const original = await sharp({ create: { width: 1200, height: 1200, channels: 3, background: "#C0392B" } })[format]().toBuffer();
      const form = new FormData();
      form.set("name", `Original ${format}`);
      form.set("file", new File([new Uint8Array(original)], `art.${ext}`));
      const res = await uploadRoute(new Request("http://test.local/api/studio/designs/upload", { method: "POST", body: form }));
      const j = (await res.json()) as { ok: boolean; data?: { id: string }; error?: string };
      assert.ok(res.ok && j.ok && j.data, `${format}: ${j.error ?? ""}`);
      const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, j.data!.id));
      assert.equal(row.sourceFormat, format);
      assert.ok(row.sourceRef && row.sourceRef.includes(`source.${ext}`));
      const kept = Buffer.from(await fileStorage.read(row.sourceRef!));
      assert.ok(kept.equals(original), `${format}: the original comes back byte for byte`);
      const bg = Buffer.from(await fileStorage.read(row.backgroundRef));
      assert.equal((await sharp(bg).metadata()).width, 1080, "the normalised background is still what the renderer reads");
      assert.equal(bg.subarray(1, 4).toString("ascii"), "PNG");
    }
  });

  test("a non-image and a PDF are refused, and nothing is stored for them", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    setTestUser(uploader);
    for (const body of [Buffer.from("%PDF-1.7 not an image"), Buffer.from("hello")]) {
      const form = new FormData();
      form.set("name", "Not an image");
      form.set("file", new File([new Uint8Array(body)], "x.pdf"));
      const res = await uploadRoute(new Request("http://test.local/api/studio/designs/upload", { method: "POST", body: form }));
      assert.equal(res.status, 400);
    }
    assert.equal((await db.select().from(studioDesigns)).length, 0);
  });

  test("new artwork for a new version is kept as its original too, must have the same shape, and starts a draft that revises the design", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const { designId } = await published(uploader);
    setTestUser(uploader);
    const art = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#27AE60" } }).png().toBuffer();
    const form = new FormData();
    form.set("revisesId", designId);
    form.set("file", new File([new Uint8Array(art)], "v2.png"));
    const res = await uploadRoute(new Request("http://test.local/api/studio/designs/upload", { method: "POST", body: form }));
    const j = (await res.json()) as { ok: boolean; data?: { id: string }; error?: string };
    assert.ok(j.ok && j.data, j.error);
    const [draft] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, j.data!.id));
    assert.equal(draft.revisesId, designId);
    assert.ok(draft.sourceRef);
    const wide = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#27AE60" } }).png().toBuffer();
    const f2 = new FormData();
    f2.set("revisesId", designId);
    f2.set("file", new File([new Uint8Array(wide)], "wide.png"));
    const bad = await uploadRoute(new Request("http://test.local/api/studio/designs/upload", { method: "POST", body: f2 }));
    assert.equal(bad.status, 400);
    const stranger = await makeUser("Meena Rao", "associate", MODULES);
    setTestUser(stranger);
    const f3 = new FormData();
    f3.set("revisesId", designId);
    f3.set("file", new File([new Uint8Array(art)], "v2.png"));
    assert.equal((await uploadRoute(new Request("http://test.local/api/studio/designs/upload", { method: "POST", body: f3 }))).status, 404);
  });
});

describe("Template library: concurrency, stale versions and upload rollback", () => {
  const MODULES = ["studio.home", "studio.make", "studio.posters", "studio.designs"];
  const APPROVER = [...MODULES, "studio.approve"];

  async function publishedDesign(owner: Awaited<ReturnType<typeof makeUser>>) {
    const designId = id("custom-race").replace(/_/g, "-");
    const bg = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#1F3A5F" } }).png().toBuffer();
    const stored = await fileStorage.upload({ key: `studio/designs/${designId}/background.png`, body: bg, contentType: "image/png" });
    const placement: PlacementDraft = { name: "Race test", canvas: "square", occasion: "anytime", fields: [{ ...defaultPlacement("company_name", canvasById("square")!, []), y: 80 }], messages: [] };
    await db.insert(studioDesigns).values({ id: designId, name: placement.name, canvas: "square", placement, backgroundRef: stored.ref, sourceSha256: "x", createdById: owner.id });
    setTestUser(owner);
    const r = await publishDesign(designId);
    assert.ok(r.ok, r.ok ? "" : r.error);
    return designId;
  }

  const openRevisions = (designId: string) => db.select().from(studioDesigns).where(eq(studioDesigns.revisesId, designId));
  const versionRows = (designId: string) => db.select().from(studioDesignVersions).where(eq(studioDesignVersions.designId, designId));
  const rawDbWords = /duplicate key|violates|constraint|23505|failed query|insert into/i;

  /* ------------------------------------------------------------ M3: one open new version per design per person */

  test("two requests to start a new version at the same moment make ONE draft, and both are handed it", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const designId = await publishedDesign(uploader);
    setTestUser(uploader);
    const [a, b, c] = await Promise.all([reviseDesign(designId), reviseDesign(designId), reviseDesign(designId)]);
    assert.ok(a.ok && b.ok && c.ok, "none of them fails");
    if (!(a.ok && b.ok && c.ok)) return;
    assert.equal(new Set([a.data.id, b.data.id, c.data.id]).size, 1, "all three are the same draft");
    const drafts = await openRevisions(designId);
    assert.equal(drafts.length, 1, "exactly one draft exists");
    assert.equal(drafts[0].revisesVersion, "1.0.0", "it records the version it was made from");
    const leaked = await db.execute(sql`select count(*)::int as n from attachment_bytes where ref like ${`studio/designs/%/background.png`}`);
    assert.equal(Number((leaked as unknown as { n: number }[])[0].n), 2, "the design's own artwork and the one draft's copy — the losers' copies were removed");
  });

  test("the database itself refuses a second open draft for the same design and person, but not for another person or a closed one", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const approver = await makeUser("Vikram Shah", "manager", APPROVER);
    const designId = await publishedDesign(uploader);
    setTestUser(uploader);
    const first = await reviseDesign(designId);
    assert.ok(first.ok);
    if (!first.ok) return;
    const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, first.data.id));
    const clone = (over: Partial<typeof studioDesigns.$inferInsert>) => ({ ...row, id: id("custom-dup").replace(/_/g, "-"), ...over }) as typeof studioDesigns.$inferInsert;
    let caught: unknown = null;
    try {
      await db.insert(studioDesigns).values(clone({}));
    } catch (e) {
      caught = e;
    }
    assert.ok(caught && isUniqueViolation(caught), "same design, same person, both drafts: refused by the index");
    await db.insert(studioDesigns).values(clone({ createdById: approver.id }));
    assert.equal((await openRevisions(designId)).length, 2, "somebody else may have their own");
  });

  /* ------------------------------------------------------------ M2: a stale new version is refused */

  test("a new version made from 1.0.0 is refused once 1.0.1 is published, and nothing is overwritten", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const approver = await makeUser("Vikram Shah", "manager", APPROVER);
    const designId = await publishedDesign(uploader);

    setTestUser(uploader);
    const mine = await reviseDesign(designId);
    setTestUser(approver);
    const theirs = await reviseDesign(designId);
    assert.ok(mine.ok && theirs.ok);
    if (!(mine.ok && theirs.ok)) return;
    assert.notEqual(mine.data.id, theirs.data.id, "two people may each have a draft");
    const [theirDraft] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, theirs.data.id));
    assert.equal(theirDraft.revisesVersion, "1.0.0");

    setTestUser(uploader);
    assert.ok((await saveDraftPlacement(mine.data.id, { ...((await db.select().from(studioDesigns).where(eq(studioDesigns.id, mine.data.id)))[0].placement as PlacementDraft), name: "Race test: first" })).ok);
    const first = await publishDesign(mine.data.id);
    assert.ok(first.ok, first.ok ? "" : first.error);
    const [at101] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    assert.deepEqual([at101.version, at101.name], ["1.0.1", "Race test: first"]);

    setTestUser(approver);
    assert.ok((await saveDraftPlacement(theirs.data.id, { ...(theirDraft.placement as PlacementDraft), name: "Race test: second" })).ok);
    const stale = await publishDesign(theirs.data.id);
    assert.equal(stale.ok, false, "the stale draft is refused");
    if (!stale.ok) {
      assert.equal(stale.code, "conflict");
      assert.match(stale.error, /1\.0\.1/);
      assert.doesNotMatch(stale.error, rawDbWords);
    }
    const [still] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    assert.deepEqual([still.version, still.name], ["1.0.1", "Race test: first"], "the newer version was not replaced");
    assert.deepEqual((await versionRows(designId)).map((v) => v.version), ["1.0.0"], "no extra snapshot was written");
    assert.equal((await db.select().from(studioDesigns).where(eq(studioDesigns.id, theirs.data.id))).length, 1, "their draft is still theirs to read and delete");

    /* Recovery: drop the stale draft, start again from the current version, publish. */
    assert.ok((await deleteDraft(theirs.data.id)).ok);
    const again = await reviseDesign(designId);
    assert.ok(again.ok);
    if (!again.ok) return;
    const [fresh] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, again.data.id));
    assert.equal(fresh.revisesVersion, "1.0.1");
    const second = await publishDesign(again.data.id);
    assert.ok(second.ok, second.ok ? "" : second.error);
    const [at102] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    assert.equal(at102.version, "1.0.2");
    assert.deepEqual((await versionRows(designId)).map((v) => v.version).sort(), ["1.0.0", "1.0.1"]);
  });

  /* ------------------------------------------------------------ M1: concurrent publish is a conflict, said in words */

  test("a snapshot that already exists is a friendly conflict, not a database error, and the design is untouched", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const designId = await publishedDesign(uploader);
    setTestUser(uploader);
    const rev = await reviseDesign(designId);
    assert.ok(rev.ok);
    if (!rev.ok) return;
    /* Somebody else's publish has already saved version 1.0.0 as superseded: the snapshot insert will violate the primary key. */
    const [cur] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    await db.insert(studioDesignVersions).values({ designId, version: "1.0.0", manifest: cur.manifest ?? {}, copy: cur.copy, placement: cur.placement, backgroundRef: cur.backgroundRef, previewRef: cur.previewRef ?? "x" });
    const r = await publishDesign(rev.data.id);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "conflict");
      assert.doesNotMatch(r.error, rawDbWords, "no raw database message reaches the person");
    }
    const [after] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    assert.equal(after.version, "1.0.0", "rolled back: still the version it was");
    assert.equal((await db.select().from(studioDesigns).where(eq(studioDesigns.id, rev.data.id))).length, 1, "the draft is kept");
    assert.equal((await versionRows(designId)).length, 1, "only the pre-existing snapshot");
  });

  test("the same new version published twice at once: one wins, the other is told in words, and the history is consistent", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const designId = await publishedDesign(uploader);
    setTestUser(uploader);
    const rev = await reviseDesign(designId);
    assert.ok(rev.ok);
    if (!rev.ok) return;
    const results = await Promise.all([publishDesign(rev.data.id), publishDesign(rev.data.id)]);
    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one publish wins");
    for (const r of results) if (!r.ok) assert.doesNotMatch(r.error, rawDbWords);
    const [final] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId));
    assert.equal(final.version, "1.0.1", "published once, not twice");
    assert.deepEqual((await versionRows(designId)).map((v) => v.version), ["1.0.0"]);
    assert.equal((await openRevisions(designId)).length, 0);
  });

  /* ------------------------------------------------------------ H1: the upload never costs a saved design its files */

  async function uploadForm(fields: Record<string, string>, bytes: Buffer) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set("file", new File([new Uint8Array(bytes)], "art.png"));
    return new Request("http://test.local/api/studio/designs/upload", { method: "POST", body: form });
  }
  const storedCount = async () => Number(((await db.execute(sql`select count(*)::int as n from attachment_bytes`)) as unknown as { n: number }[])[0].n);

  test("an upload that fails leaves no files behind: a second open new version is refused and nothing it stored survives", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const designId = await publishedDesign(uploader);
    setTestUser(uploader);
    const art = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#27AE60" } }).png().toBuffer();
    const ok1 = await uploadRoute(await uploadForm({ revisesId: designId }, art));
    assert.equal(ok1.status, 200);
    const before = await storedCount();
    const dup = await uploadRoute(await uploadForm({ revisesId: designId }, art));
    assert.equal(dup.status, 409, "the index refused the second open draft");
    const body = (await dup.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.doesNotMatch(body.error, rawDbWords);
    assert.equal(await storedCount(), before, "the source and background it had just stored were removed");
    assert.equal((await openRevisions(designId)).length, 1);
  });

  test("a commit that succeeds and then reports an error never deletes the files of the design it saved", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const designId = await publishedDesign(uploader);
    setTestUser(uploader);
    const art = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#27AE60" } }).png().toBuffer();
    const real = db.transaction.bind(db);
    (db as unknown as { transaction: unknown }).transaction = async (...args: Parameters<typeof real>) => {
      await real(...args);
      throw new Error("connection dropped after commit");
    };
    let res: Response;
    try {
      res = await uploadRoute(await uploadForm({ revisesId: designId }, art));
    } finally {
      (db as unknown as { transaction: unknown }).transaction = real;
    }
    const j = (await res.json()) as { ok: boolean; data?: { id: string } };
    assert.ok(j.ok && j.data, "the design WAS saved, so the upload is reported as done");
    const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, j.data!.id));
    assert.ok(row, "the row is there");
    assert.ok((await fileStorage.read(row.backgroundRef)).byteLength > 0, "its artwork is still there");
    assert.ok(row.sourceRef && (await fileStorage.read(row.sourceRef)).byteLength > 0, "and so is its original");
    assert.equal(row.revisesVersion, "1.0.0");
  });

  test("an upload for a new version records the version it was made from, and is stale if the design moves on", async () => {
    const uploader = await makeUser("Neha Joshi", "associate", MODULES);
    const designId = await publishedDesign(uploader);
    setTestUser(uploader);
    const art = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#27AE60" } }).png().toBuffer();
    const j = (await (await uploadRoute(await uploadForm({ revisesId: designId }, art))).json()) as { ok: boolean; data: { id: string } };
    const viaButton = await reviseDesign(designId);
    assert.ok(viaButton.ok && viaButton.data.id === j.data.id, "the same open draft, whichever door made it");
    const [d] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, j.data.id));
    assert.equal(d.revisesVersion, "1.0.0");
  });
});

describe("Shared dates", () => {
  test("a birthday is shared, and an edit that started from an old version is refused", async () => {
    setTestUser(priya);
    const added = await savePersonDate({ kind: "birthday", personName: "Rajesh Shah", company: "Shree Paints", month: "3", day: "14", year: "", leadDays: "3", note: "" });
    assert.ok(added.ok, added.ok ? "" : added.error);
    const [one] = await peopleDates();
    assert.equal(one.date, "--03-14");
    assert.ok((await savePersonDate({ kind: "birthday", personName: "Rajesh Shah", company: "", month: "3", day: "15", year: "", leadDays: "7", note: "" }, { id: one.id, version: 1 })).ok);
    const stale = await savePersonDate({ kind: "birthday", personName: "R. Shah", company: "", month: "3", day: "16", year: "", leadDays: "7", note: "" }, { id: one.id, version: 1 });
    assert.equal(stale.ok, false);
    assert.equal(stale.ok ? null : stale.code, "conflict");
  });
});
