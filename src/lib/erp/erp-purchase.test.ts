/**
 * ERP phase 2 — purchase inward → testing → register → raw-material stock,
 * against a real database through the real handlers.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, erpInward, erpPurchases, erpRawMaterials, erpRmEntries, erpSuppliers, erpTests, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { purchaseStage } from "@/lib/erp/screens/purchase";
import { rmLots, rmLotStock } from "@/lib/erp/stock";
import { erpNavCounts } from "@/lib/erp/counts";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, level: "associate" | "manager" | "admin") {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\s/g, ".")}@erp.test`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: level,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "erp", role: level });
  return u;
}

async function as(u: typeof users.$inferSelect) {
  setTestUser(u);
  return erpContext();
}

const mod = (k: string) => {
  const m = screenModule(k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;
const TODAY = "2026-09-20";

before(async () => {
  await db.execute(
    sql`truncate users, erp_raw_materials, erp_suppliers, erp_inward, erp_tests, erp_purchases, erp_rm_entries, erp_user_powers, erp_godown_staff, erp_user_settings, audit_log restart identity cascade`,
  );
  await db.execute(sql`update erp_series set last = 1000 where key = 'pr'`);
  admin = await makeUser("Kavita Admin", "admin");
  clerk = await makeUser("Deepa Clerk", "associate");
  await db.insert(erpSuppliers).values({ id: "sup_a", name: "Asian Solvents", partyCode: "AS" });
  await db.insert(erpRawMaterials).values([
    { id: "rm_tol", serialNo: 1, name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical", density: 0.87, testingList: ["Smell", "Density"] },
    { id: "rm_mek", serialNo: 2, name: "MEK", code: "MEK", unit: "Kg", materialType: "Chemical", density: 0.8, testingList: [] },
    { id: "rm_can", serialNo: 3, name: "1 L Tin Can", code: "CAN1", unit: "Unit", materialType: "Can", testingList: [] },
  ]);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("inward", () => {
  test("one inward draws one PR for all its lines, and sends each where it is going as it is saved", async () => {
    const ctx = await as(admin);
    const r = await mod("inward").forms!.new(ctx, { date: TODAY, supplier: "Asian Solvents", godown: "Bhiwandi" }, [
      { type: "Chemical", item: "Toluene", drums: "2", weight: "400", qty: "360" },
      { type: "Chemical", item: "MEK", drums: "1", qty: "160" },
      { type: "Can", item: "1 L Tin Can", qty: "500" },
    ]);
    assert.ok(r.ok, JSON.stringify(r));
    const rows = await db.select().from(erpInward).orderBy(erpInward.rawMaterialId);
    assert.deepEqual([...new Set(rows.map((x) => x.prNumber))], [1001]);
    const byItem = Object.fromEntries(rows.map((x) => [x.rawMaterialId, x]));
    assert.equal(byItem.rm_tol.testingRequired, true);
    assert.equal(byItem.rm_mek.testingRequired, false);
    assert.equal(byItem.rm_can.unit, "Unit");
    /* No "Send to Testing / Send to Purchase" press: the testing list decided. */
    assert.equal(byItem.rm_tol.routed, "Testing");
    assert.equal(byItem.rm_mek.routed, "Purchase");
    assert.equal(byItem.rm_can.routed, "Purchase");
    const counts = await erpNavCounts(ctx);
    assert.equal(counts.inward, 0, "nothing is left waiting to be routed");
  });

  test("a minus quantity is refused in the source's words", async () => {
    const ctx = await as(admin);
    const r = await mod("inward").forms!.new(ctx, { date: TODAY, supplier: "Asian Solvents", godown: "Bhiwandi" }, [{ type: "Can", item: "1 L Tin Can", qty: "-4" }]);
    assert.ok(!r.ok && r.fieldErrors?.[0].message === "Minus Quantity Not Allowed");
  });

  test("a line routes once: a tested item cannot skip testing, and it cannot be sent again", async () => {
    const ctx = await as(admin);
    const [tol] = await db.select().from(erpInward).where(eq(erpInward.rawMaterialId, "rm_tol"));
    assert.ok(!(await mod("inward").actions!.toPurchase(ctx, tol.id, {})).ok);
    assert.ok(!(await mod("inward").actions!.toTesting(ctx, tol.id, {})).ok, "it was sent when it was saved");
  });

  test("an untested line goes straight to the register, but reaches stock only with a rate", async () => {
    const ctx = await as(admin);
    const [mek] = await db.select().from(erpInward).where(eq(erpInward.rawMaterialId, "rm_mek"));
    const [p] = await db.select().from(erpPurchases).where(eq(erpPurchases.inwardId, mek.id));
    assert.equal(p.lotNo, "ASMEK1001");
    assert.equal(p.availableLitres, 200, "160 kg at density 0.8 is 200 litres");
    assert.equal((await db.select().from(erpRmEntries)).length, 0, "no rate, no stock");

    const rated = await mod("register").actions!.rate(ctx, p.id, { rate: "90" });
    assert.ok(rated.ok);
    assert.equal(await rmLotStock("ASMEK1001", "erpg_bhiwandi"), 200);
  });
});

describe("testing", () => {
  test("the verifier cannot pass a test whose evidence is missing, nor can a clerk decide it", async () => {
    const ctx = await as(admin);
    const form = await mod("testing").load(ctx);
    const line = (form.spec.newForm?.header.find((f) => f.k === "line")?.opts ?? [])[0];
    assert.equal(line, "PR 1001 · Toluene");
    const made = await mod("testing").forms!.new(ctx, { line, tester: "Kavita Admin", date: TODAY, godown: "Bhiwandi", smell: "Good" }, []);
    assert.ok(made.ok, JSON.stringify(made));
    const [t] = await db.select().from(erpTests);
    const early = await mod("testing").actions!.verify(ctx, t.id, {});
    assert.ok(!early.ok && /density/.test(early.error));

    const c = await as(clerk);
    const refused = await mod("testing").actions!.verify(c, t.id, {});
    assert.ok(!refused.ok && refused.code === "not_permitted");
  });

  test("a density outside 0.5–1.5 is INVALID", async () => {
    const ctx = await as(admin);
    const [t] = await db.select().from(erpTests);
    const r = await mod("testing").forms!.edit(ctx, { smell: "Good", density: "2", tester: "Kavita Admin", date: TODAY }, [], t.id);
    assert.ok(!r.ok && r.fieldErrors?.[0].message === "INVALID");
  });

  test("verifying creates the register row once, carrying the tested density", async () => {
    const ctx = await as(admin);
    const [t] = await db.select().from(erpTests);
    const saved = await mod("testing").forms!.edit(ctx, { smell: "Good", density: "0.9", tester: "Kavita Admin", date: TODAY }, [], t.id);
    assert.ok(saved.ok);
    await db.update(erpTests).set({ densityPhotoId: "att_fake" }).where(eq(erpTests.id, t.id));
    const v = await mod("testing").actions!.verify(ctx, t.id, {});
    assert.ok(v.ok, JSON.stringify(v));
    const regs = await db.select().from(erpPurchases).where(eq(erpPurchases.testId, t.id));
    assert.equal(regs.length, 1);
    assert.equal(regs[0].lotNo, "ASTOL1001");
    assert.equal(regs[0].density, 0.9);
    const again = await mod("testing").actions!.verify(ctx, t.id, {});
    assert.ok(!again.ok);
    assert.equal((await db.select().from(erpPurchases).where(eq(erpPurchases.testId, t.id))).length, 1);
  });
});

describe("register and stock", () => {
  test("a lot number already taken is refused with the source's message", async () => {
    const ctx = await as(admin);
    const r = await mod("register").forms!.new(ctx, { pr: "1001", date: TODAY, supplier: "Asian Solvents", item: "Toluene", qty: "10", unit: "Litre", godown: "Bhiwandi" }, []);
    assert.ok(!r.ok && r.fieldErrors?.[0].message.startsWith("! Please Change 4 Digit PR Num"));
  });

  test("editing a posted purchase moves its stock entry with it", async () => {
    const ctx = await as(admin);
    const [tol] = await db.select().from(erpPurchases).where(eq(erpPurchases.lotNo, "ASTOL1001"));
    await mod("register").actions!.rate(ctx, tol.id, { rate: "120" });
    assert.equal(await rmLotStock("ASTOL1001", "erpg_bhiwandi"), 360);
    const edited = await mod("register").forms!.edit(
      ctx,
      { date: TODAY, qty: "360", unit: "Litre", feedLitre: "10", godown: "Ambernath", rate: "120", gst: "18", company: "Mahek Marketing India" },
      [],
      tol.id,
    );
    assert.ok(edited.ok, JSON.stringify(edited));
    assert.equal(await rmLotStock("ASTOL1001", "erpg_bhiwandi"), 0);
    assert.equal(await rmLotStock("ASTOL1001", "erpg_ambernath"), 350);
    assert.equal((await db.select().from(erpRmEntries).where(eq(erpRmEntries.sourceId, tol.id))).length, 1);
  });

  test("purchase money never reaches a clerk without the power, and a clerk cannot rate", async () => {
    const c = await as(clerk);
    const { spec, rows } = await mod("register").load(c);
    assert.ok(!spec.cols.some((x) => x.k === "rate" || x.k === "final"));
    assert.ok(rows.every((r) => !("rate" in r.v) && !("final" in r.v)));
    const [p] = await db.select().from(erpPurchases).limit(1);
    const r = await mod("register").actions!.rate(c, p.id, { rate: "1" });
    assert.ok(!r.ok && r.code === "not_permitted");
  });

  test("a purchase moves along one line: the bill and the status cannot disagree", async () => {
    const ctx = await as(admin);
    const [can] = await db.select().from(erpPurchases).where(eq(erpPurchases.rawMaterialId, "rm_can"));
    assert.equal(purchaseStage(can), "Arrived");
    assert.ok((await mod("register").actions!.billReceived(ctx, can.id, { billNo: "AS/77" })).ok);
    const [billed] = await db.select().from(erpPurchases).where(eq(erpPurchases.id, can.id));
    assert.equal(billed.status, "Invoice Received", "a bill in hand is the Invoice Received step");
    assert.equal(purchaseStage(billed), "Bill received");
    assert.ok((await mod("register").actions!.status(ctx, can.id, { status: "Purchase Verified" })).ok);
    assert.equal(purchaseStage((await db.select().from(erpPurchases).where(eq(erpPurchases.id, can.id)))[0]), "Verified");
    assert.ok(!(await mod("register").actions!.billNotReceived(ctx, can.id, {})).ok, "a verified purchase has its bill");
    assert.ok((await mod("register").actions!.reopen(ctx, can.id, {})).ok);
    assert.ok((await mod("register").actions!.billNotReceived(ctx, can.id, {})).ok);
    const [back] = await db.select().from(erpPurchases).where(eq(erpPurchases.id, can.id));
    assert.equal(back.billReceived, "Bill Not Received");
    assert.equal(purchaseStage(back), "Arrived");
  });

  test("only the verifier sets Purchase Verified", async () => {
    const ctx = await as(admin);
    await db.execute(sql`delete from erp_user_powers`);
    const [p] = await db.select().from(erpPurchases).limit(1);
    assert.ok((await mod("register").actions!.status(ctx, p.id, { status: "Purchase Verified" })).ok);
    await db.execute(sql`insert into erp_user_powers (user_id, power) values (${clerk.id}, 'viewPurchaseMoney')`);
    const c2 = await as(clerk);
    const r = await mod("register").actions!.status(c2, p.id, { status: "Purchase Verified" });
    assert.ok(!r.ok);
    const reopen = await mod("register").actions!.reopen(c2, p.id, {});
    assert.ok(!reopen.ok && reopen.code === "not_permitted");
  });

  test("available stock lists lots above zero, and the cost is hidden without its power", async () => {
    const lots = (await rmLots()).filter((l) => l.stock > 0);
    assert.deepEqual(lots.map((l) => [l.lotNo, l.godown, l.stock]).sort(), [
      ["ASMEK1001", "Bhiwandi", 200],
      ["ASTOL1001", "Ambernath", 350],
    ]);
    const c = await as(clerk);
    const { spec } = await mod("rmStock").load(c);
    assert.ok(!spec.cols.some((x) => x.k === "value"));
    const a = await as(admin);
    const full = await mod("rmStock").load(a);
    const mek = full.rows.find((r) => r.v.lot === "ASMEK1001");
    assert.equal(mek?.v.rate, 7200, "₹90 a kg at density 0.8 is ₹72 a litre");
  });

  test("the log flags an entry whose purchase has gone", async () => {
    const ctx = await as(admin);
    const [mek] = await db.select().from(erpPurchases).where(eq(erpPurchases.lotNo, "ASMEK1001"));
    await db.delete(erpPurchases).where(eq(erpPurchases.id, mek.id));
    const { rows } = await mod("rmLog").load(ctx);
    assert.deepEqual(rows.find((r) => r.v.source === mek.id)?.flags, ["orphan"]);
  });
});

describe("the PR number, offered like an invoice number", () => {
  const offered = async () => {
    const form = (await mod("inward").load(await as(admin))).spec.newForm!;
    return form.init!.prOffered;
  };
  const save = async (h: Record<string, string>) =>
    mod("inward").forms!.new(await as(admin), { date: TODAY, supplier: "Asian Solvents", godown: "Bhiwandi", ...h }, [{ type: "Can", item: "1 L Tin Can", qty: "10" }]);

  test("the form opens on the next number, and it can be typed over", async () => {
    const next = await offered();
    const r = await save({ pr: next, prOffered: next });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.message?.startsWith(`PR ${next} ·`), true, r.message);
    assert.equal(await offered(), String(Number(next) + 1));
  });

  test("two people saving the same offered number get it and the one after, never a clash or a random one", async () => {
    const next = await offered();
    const [a, b] = await Promise.all([save({ pr: next, prOffered: next }), save({ pr: next, prOffered: next })]);
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
    const prs = (await db.select().from(erpInward).where(sql`${erpInward.prNumber} in (${Number(next)}, ${Number(next) + 1})`)).map((x) => x.prNumber);
    assert.deepEqual(prs.sort(), [Number(next), Number(next) + 1]);
    const told = [a, b].filter((x) => x.ok && x.message?.includes(`PR ${next} was taken while you were filling this in`));
    assert.equal(told.length, 1, "the second saver is told their number moved");
  });

  test("a typed number moves the series past it, and a used one is refused", async () => {
    const next = await offered();
    const jump = String(Number(next) + 50);
    assert.ok((await save({ pr: jump, prOffered: next })).ok);
    assert.equal(await offered(), String(Number(jump) + 1), "the next form does not offer a number already used");
    const again = await save({ pr: jump, prOffered: await offered() });
    assert.ok(!again.ok && again.fieldErrors?.[0].field === "pr", JSON.stringify(again));
  });
});
