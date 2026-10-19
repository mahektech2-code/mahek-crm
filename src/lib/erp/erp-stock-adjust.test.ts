/**
 * Stock adjusted by hand from its row, and the stock inquiry that shows it,
 * end to end against a real database through the real screen handlers:
 *
 *   Add    → an inflow entry on the same lot, stock up at once
 *   Remove → a write-off to Item Lost Record, stock down at once, never below 0
 *   Other  → the reason must be written
 *   no power → refused; the ⋯ menu offers only Stock inquiry
 *   inquiry → every movement with a running balance, Item Lost Record left out
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
import { appAccess, erpFgEntries, erpManualAdjustments, erpRawMaterials, erpRmEntries, erpUserPowers, finishedGoods, productBrands, productFormulations, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { fgLots, rmLots } from "@/lib/erp/stock";
import { stockInquiry } from "@/lib/erp/stock-inquiry";
import { unscoped } from "@/lib/erp/window";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const BHW = "erpg_bhiwandi";
const tag = randomUUID().slice(0, 6);

async function makeUser(name: string, level: "associate" | "manager" | "admin") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}@adjust.test`, phone: String(9824000000 + Math.floor(Math.random() * 999999)), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
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
const msg = (r: { ok: boolean; fieldErrors?: { message: string }[]; error?: string; message?: string }) => (r.ok ? (r.message ?? "ok") : (r.fieldErrors?.[0]?.message ?? r.error ?? "?"));

let controller: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;
let fgId = "";
const fgRow = () => `${fgId}|FGADJ|${BHW}`;
const fgStock = async () => (await fgLots()).filter((l) => l.lotCode === "FGADJ" && l.godownId === BHW).reduce((a, l) => a + l.stock, 0);
const rmStock = async () => (await rmLots()).filter((l) => l.lotNo === "TOL-ADJ" && l.godownId === BHW).reduce((a, l) => a + l.stock, 0);

before(async () => {
  await db.execute(sql`truncate users, erp_raw_materials, erp_rm_entries, erp_fg_entries, erp_user_powers, erp_transfers, erp_units, erp_manual_adjustments, audit_log restart identity cascade`);
  controller = await makeUser("Sanjay Stock", "manager");
  clerk = await makeUser("Ravi Godown", "associate");
  await db.insert(erpUserPowers).values({ userId: controller.id, power: "stockControl", grantedById: controller.id });

  await db.insert(erpRawMaterials).values({ id: "rm_adj", serialNo: 1, name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical" });
  await db.insert(erpRmEntries).values({ id: id("rme"), sourceType: "purchase", sourceId: id("pur"), entryDate: "2026-10-01", rawMaterialId: "rm_adj", lotNo: "TOL-ADJ", godownId: BHW, quantity: 100 });

  const fId = id("form");
  const bId = id("brand");
  fgId = id("fg");
  const sku = id("sku");
  await db.insert(productFormulations).values({ id: fId, name: `ADJ Nano ${tag}`, slug: `adj-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `ADJ Nano ${tag}`, slug: `adj-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values({ id: fgId, name: `ADJ Nano 5 L ${tag}`, slug: `adj-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 5000 });
  await db.insert(products).values({ id: sku, name: `ADJ Nano ${tag} - 5 Liter (Loose)`, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 5000, cansPerBox: 1 });
  await db.insert(erpFgEntries).values({ id: id("efe"), sourceType: "fill", sourceId: id("fill"), entryDate: "2026-10-02", finishedGoodId: fgId, lotCode: "FGADJ", godownId: BHW, quantity: 214, skuId: sku });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("adjusting stock from its row", () => {
  test("every stock row carries Stock inquiry and Adjust stock in its ⋯ menu", async () => {
    const res = await mod("fgStock").load(await as(controller), unscoped());
    assert.deepEqual(res.spec.rowMenu, ["inquiry", "adjust"]);
    const row = res.rows.find((r) => r.id === fgRow())!;
    assert.ok(row.actions?.some((a) => a.id === "inquiry" && a.href?.startsWith("/erp/stock-inquiry?stage=fg")));
    assert.ok(row.actions?.some((a) => a.id === "adjust" && a.prompt));
    for (const k of ["rmStock", "sfgStock", "packStock"]) assert.deepEqual((await mod(k).load(await as(controller), unscoped())).spec.rowMenu, ["inquiry", "adjust"]);
  });

  test("without the stock-control power the menu has only the inquiry, and the action is refused", async () => {
    const c = await as(clerk);
    const row = (await mod("fgStock").load(c, unscoped())).rows.find((r) => r.id === fgRow())!;
    assert.deepEqual(row.actions?.filter((a) => a.id === "inquiry" || a.id === "adjust").map((a) => a.id), ["inquiry"]);
    const r = await mod("fgStock").actions!.adjust(c, fgRow(), { dir: "Remove", qty: "1", reason: "Damaged" });
    assert.equal(r.ok, false);
    assert.equal(await fgStock(), 214);
  });

  test("Remove writes the cans off to Item Lost Record at once", async () => {
    const r = await mod("fgStock").actions!.adjust(await as(controller), fgRow(), { dir: "Remove", qty: "12", reason: "Damaged" });
    assert.ok(r.ok, msg(r));
    assert.equal(await fgStock(), 202);
    const [a] = await db.select().from(erpManualAdjustments).where(eq(erpManualAdjustments.lot, "FGADJ"));
    assert.equal(Number(a.quantity), -12);
    assert.equal(Number(a.stockBefore), 214);
    assert.equal(a.reasonCode, "damaged");
    assert.ok(a.posted?.transfer, "posted as a write-off transfer");
    const [t] = (await db.execute(sql`select g.reserved from erp_transfers t join erp_godowns g on g.id = t.to_godown_id where t.id = ${a.posted!.transfer!}`)) as unknown as { reserved: boolean }[];
    assert.equal(t.reserved, true, "to Item Lost Record");
  });

  test("never below zero", async () => {
    const r = await mod("fgStock").actions!.adjust(await as(controller), fgRow(), { dir: "Remove", qty: "203", reason: "Lost or missing" });
    assert.equal(r.ok, false);
    assert.equal(await fgStock(), 202);
  });

  test("Add puts stock back on the same lot", async () => {
    const r = await mod("fgStock").actions!.adjust(await as(controller), fgRow(), { dir: "Add", qty: "5", reason: "Counting mistake" });
    assert.ok(r.ok, msg(r));
    assert.equal(await fgStock(), 207);
  });

  test("Other needs the reason written, and then a raw material is adjusted the same way", async () => {
    const c = await as(controller);
    const row = `TOL-ADJ|${BHW}`;
    const bare = await mod("rmStock").actions!.adjust(c, row, { dir: "Add", qty: "25", reason: "Other" });
    assert.equal(bare.ok, false);
    assert.equal(await rmStock(), 100);
    const ok = await mod("rmStock").actions!.adjust(c, row, { dir: "Add", qty: "25", reason: "Other", note: "Extra half drum with the last GRN" });
    assert.ok(ok.ok, msg(ok));
    assert.equal(await rmStock(), 125);
  });
});

describe("the stock inquiry", () => {
  test("lists every movement with a running balance that ends at the stock now", async () => {
    const inq = (await stockInquiry({ stage: "fg", itemId: fgId, godownId: null, window: { from: null, to: null } }))!;
    assert.equal(inq.stockNow, 207);
    assert.deepEqual(
      inq.movements.map((m) => [m.kind, m.qty]),
      [
        ["Filled", 214],
        ["Adjusted by hand", -12],
        ["Adjusted by hand", 5],
      ],
      "the write-off is one movement, not a pair: Item Lost Record is left out",
    );
    assert.equal(inq.movements.at(-1)!.balance, 207);
    assert.equal(inq.movements[1].note, "Damaged");
    assert.equal(inq.movements[1].by, "Sanjay Stock");
    assert.equal(inq.adjusted, -7);
  });

  test("a period starts from its opening balance", async () => {
    const inq = (await stockInquiry({ stage: "rm", itemId: "rm_adj", godownId: BHW, window: { from: "2026-10-02", to: null } }))!;
    assert.equal(inq.opening, 100);
    assert.equal(inq.movements.length, 1);
    assert.equal(inq.movements[0].note, "Other: Extra half drum with the last GRN");
    assert.equal(inq.movements[0].balance, 125);
  });
});
