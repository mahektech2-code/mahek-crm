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
import { appAccess, appModuleAccess, customers, studioBatches, studioDesigns, studioPosters, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { fileStorage } from "@/lib/storage";
import { approveDesign, makeBatch, makePoster, recordShare, saveDraftPlacement, savePersonDate } from "@/lib/actions/studio";
import { defaultPlacement, canvasById, type PlacementDraft } from "./domain/template-upload";
import { listRecipients } from "./recipients";
import { renderRecipe } from "./render-service";
import { getStudioRegistry } from "./registry-service";
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
