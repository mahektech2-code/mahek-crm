/**
 * ERP phase 3 — SFG batches, FG filling, packing, transfers and re-order
 * levels, against a real database through the real handlers.
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
import {
  appAccess,
  erpFgFills,
  erpPackEntries,
  erpProductPacking,
  erpRawMaterials,
  erpSfgLines,
  erpSuppliers,
  finishedGoods,
  notifications,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { approvedPoLine } from "@/lib/erp/po-fixture";
import { fgLots, packLots, rmLots, rmLotStock, sfgLots } from "@/lib/erp/stock";
import { runErpAlerts } from "@/lib/erp/alerts";
import { erpNavCounts } from "@/lib/erp/counts";
import "@/lib/erp/calcs";
import { runCalc } from "@/lib/erp/calc";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = "2026-09-20";

async function makeUser(name: string, level: "associate" | "admin") {
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

const fieldMsg = (r: { ok: boolean; fieldErrors?: { message: string }[]; error?: string }) =>
  r.ok ? "ok" : (r.fieldErrors?.[0]?.message ?? r.error ?? "?");

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;
const tag = randomUUID().slice(0, 6);
const SFG = `ERPT Thinner ${tag}`;
const FG = `ERPT Thinner 5 L ${tag}`;
const LOOSE = `ERPT Thinner ${tag} - 5 Liter (Loose)`;
const BOXED = `ERPT Thinner ${tag} - 5 Liter (4 Can/Box)`;
let fgId = "";

async function purchase(item: string, qty: string, unit: string, rate: string) {
  const ctx = await as(admin);
  const po = await approvedPoLine("Asian Solvents", item, Number(qty));
  const r = await mod("register").forms!.new(ctx, { date: TODAY, po: po.po, poLine: po.poLine, qty, unit, rate, gst: "18", company: "Mahek Marketing India", godown: "Bhiwandi" }, []);
  assert.ok(r.ok, JSON.stringify(r));
}

before(async () => {
  await db.execute(sql`
    truncate users, erp_raw_materials, erp_suppliers, erp_inward, erp_tests, erp_purchases, erp_rm_entries,
             erp_sfg_lines, erp_sfg_entries, erp_fg_fills, erp_fg_entries, erp_pack_lines, erp_pack_entries,
             erp_transfers, erp_rm_levels, erp_fg_levels, erp_requisitions, erp_user_powers, erp_godown_staff,
             erp_user_settings, audit_log restart identity cascade`);
  await db.execute(sql`update erp_series set last = 0`);
  admin = await makeUser("Kavita Admin", "admin");
  clerk = await makeUser("Deepa Clerk", "associate");
  await db.insert(erpSuppliers).values({ id: "sup_a", name: "Asian Solvents", partyCode: "AS" });
  await db.insert(erpRawMaterials).values([
    { id: "rm_tol", serialNo: 1, name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical", density: 0.87, testingList: [] },
    { id: "rm_can", serialNo: 2, name: "Tin can 5L", code: "CAN5", unit: "Unit", materialType: "Can", testingList: [], pricePaise: 3000 },
    { id: "rm_box", serialNo: 3, name: "Box6", code: "BX6", unit: "Unit", materialType: "Box", testingList: [], pricePaise: 2500 },
  ]);
  const fId = id("form");
  const bId = id("brand");
  fgId = id("fg");
  await db.insert(productFormulations).values({ id: fId, name: SFG, slug: `erpt-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `ERPT ${tag}`, slug: `erpt-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values({ id: fgId, name: FG, slug: `erpt-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 5000 });
  const looseId = id("sku");
  const boxedId = id("sku");
  await db.insert(products).values([
    { id: looseId, name: LOOSE, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 5000, cansPerBox: 1 },
    { id: boxedId, name: BOXED, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 5000, cansPerBox: 4 },
  ]);
  await db.insert(erpProductPacking).values([
    { productId: looseId, canUseMaterialId: "rm_can", emptyBoxesRequired: 0 },
    { productId: boxedId, canUseMaterialId: "rm_can", emptyBoxesRequired: 1, boxType: "Box6", boxRatePaise: 2500 },
  ]);
  await purchase("Toluene", "1000", "Litre", "100");
  await purchase("Tin can 5L", "100", "Pcs", "30");
  await purchase("Box6", "50", "Pcs", "25");
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("semi-finished", () => {
  test("two lines on one lot in one save cannot spend more than the lot holds (A-09)", async () => {
    const ctx = await as(admin);
    const r = await mod("sfgBatches").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", product: SFG, batches: "2" }, [
      { item: "Toluene", lot: "ASTOL1", qty: "300" },
      { item: "Toluene", lot: "ASTOL1", qty: "300" },
    ]);
    assert.equal(fieldMsg(r), "Low Stock!");
    assert.equal((await db.select().from(erpSfgLines)).length, 0, "a refused batch writes nothing");
  });

  test("a batch consumes batches × quantity, and puts that less the loss into SFG stock", async () => {
    const ctx = await as(admin);
    const r = await mod("sfgBatches").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", product: SFG, batches: "2" }, [{ item: "Toluene", lot: "ASTOL1", qty: "200", adjusted: "10" }]);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(await rmLotStock("ASTOL1", "erpg_bhiwandi"), 600);
    const [lot] = await sfgLots();
    assert.equal(lot.lotCode, "1ASTOL1");
    assert.equal(lot.stock, 390);
    assert.equal(lot.ratePaise, 10000, "₹100 a litre in, ₹100 a litre out");
  });

  test("a cans item is never consumed by a batch", async () => {
    const ctx = await as(admin);
    const r = await mod("sfgBatches").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", product: SFG, batches: "1" }, [{ item: "Tin can 5L", lot: "ASCAN52", qty: "1" }]);
    assert.ok(!r.ok);
  });
});

describe("filling", () => {
  test("each failed check says its own thing (A-11)", async () => {
    const ctx = await as(admin);
    const base = { date: TODAY, godown: "Bhiwandi", sfg: SFG, sfgLot: "1ASTOL1", fg: FG, size: "5", canUse: "Tin can 5L" };
    assert.equal(fieldMsg(await mod("fgFill").forms!.new(ctx, { ...base, cans: "80" }, [])), "Low SFG Stock");
    assert.equal(fieldMsg(await mod("fgFill").forms!.new(ctx, { ...base, cans: "0" }, [])), "Minus Quantity Not Allowed");
  });

  test("a fill posts its cans net of the ones lost (A-12), costed from SFG and the can", async () => {
    const ctx = await as(admin);
    const r = await mod("fgFill").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", sfg: SFG, sfgLot: "1ASTOL1", fg: FG, size: "5", canUse: "Tin can 5L", cans: "40", adjusted: "2" }, []);
    assert.ok(r.ok, JSON.stringify(r));
    const [lot] = await fgLots();
    assert.equal(lot.lotCode, "FG1BH");
    assert.equal(lot.stock, 38);
    assert.equal(lot.sku, LOOSE, "the loose SKU of the product is what these cans sell as");
    assert.equal(lot.perCanPaise, (10000 * 200 + 40 * 3000) / 40);
    assert.equal((await sfgLots())[0].stock, 190);
  });
});

describe("packing", () => {
  test("a line cannot draw more cans than its lot holds", async () => {
    const ctx = await as(admin);
    const r = await mod("packBatches").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", fg: FG, sku: BOXED, boxes: "10", lot: "FG1BH" }, []);
    assert.equal(fieldMsg(r), "Low Stock");
  });

  test("a batch reaches packing stock only when its lines draw exactly its cans, once", async () => {
    const ctx = await as(admin);
    const first = await mod("packBatches").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", fg: FG, sku: BOXED, boxes: "10", lot: "FG1BH", cans: "30" }, []);
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal((await db.select().from(erpPackEntries)).length, 0, "incomplete: nothing in stock");
    const counts = await erpNavCounts(ctx);
    assert.equal(counts.packBatches, 1);

    const fill = await mod("fgFill").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", sfg: SFG, sfgLot: "1ASTOL1", fg: FG, size: "5", canUse: "Tin can 5L", cans: "12" }, []);
    assert.ok(fill.ok);
    const more = await mod("packBatches").forms!.more(ctx, { date: TODAY, godown: "Bhiwandi", fg: FG, sku: BOXED, boxes: "10", lot: "FG2BH", serialFixed: "1" }, []);
    assert.ok(more.ok, JSON.stringify(more));
    const packs = await packLots();
    assert.deepEqual(packs.map((p) => [p.batchNo, p.stock]), [["FP1BH", 10]]);
    assert.equal((await fgLots()).find((l) => l.lotCode === "FG2BH")?.stock, 2);

    const over = await mod("packBatches").forms!.more(ctx, { date: TODAY, godown: "Bhiwandi", fg: FG, sku: BOXED, boxes: "10", lot: "FG2BH", serialFixed: "1", cans: "1" }, []);
    assert.equal(fieldMsg(over), "You Cant Select More Than 0 Can");
    assert.equal((await db.select().from(erpPackEntries)).length, 1);
  });
});

describe("transfers", () => {
  test("moves boxes between godowns, and refuses the same godown or more than the lot holds", async () => {
    const ctx = await as(admin);
    const base = { date: TODAY, type: "FG Packing", from: "Bhiwandi", item: BOXED, lot: "FP1BH" };
    assert.equal(fieldMsg(await mod("transfers").forms!.new(ctx, { ...base, qty: "3", to: "Bhiwandi" }, [])), "You Selected The Same Location, Change To Location");
    assert.equal(fieldMsg(await mod("transfers").forms!.new(ctx, { ...base, qty: "11", to: "Ambernath" }, [])), "Select Correct Quantity!");
    const ok = await mod("transfers").forms!.new(ctx, { ...base, qty: "3", to: "Ambernath" }, []);
    assert.ok(ok.ok, JSON.stringify(ok));
    const packs = await packLots();
    assert.deepEqual(packs.map((p) => [p.godown, p.stock]).sort(), [["Ambernath", 3], ["Bhiwandi", 7]]);
  });

  test("writing stock off needs the lost-stock power", async () => {
    const c = await as(clerk);
    const base = { date: TODAY, type: "Purchase", from: "Bhiwandi", item: "Toluene", lot: "ASTOL1", qty: "5", to: "Item Lost Record" };
    assert.ok(!(await mod("transfers").forms!.new(c, base, [])).ok);
    const a = await as(admin);
    assert.ok((await mod("transfers").forms!.new(a, base, [])).ok);
    assert.equal(await rmLotStock("ASTOL1", "erpg_bhiwandi"), 595);
    const { rows } = await mod("transfers").load(a);
    assert.ok(rows.find((r) => r.v.to === "Item Lost Record")?.flags.includes("lost"));
  });
});

describe("re-order levels", () => {
  test("a can level counts stock less cans already filled; a box level less boxes already packed", async () => {
    const ctx = await as(admin);
    assert.ok((await mod("rmLevels").forms!.new(ctx, { godown: "Bhiwandi", type: "Can", item: "Tin can 5L", min: "50", max: "100", status: "Follow" }, [])).ok);
    assert.ok((await mod("rmLevels").forms!.new(ctx, { godown: "Bhiwandi", type: "Box", item: "Box6", min: "10", max: "60", status: "Follow" }, [])).ok);
    const dup = await mod("rmLevels").forms!.new(ctx, { godown: "Bhiwandi", type: "Can", item: "Tin can 5L", min: "1", max: "2", status: "Follow" }, []);
    assert.equal(fieldMsg(dup), "Duplicate Entry!");
    const { rows } = await mod("rmLevels").load(ctx);
    const can = rows.find((r) => r.v.item === "Tin can 5L");
    const box = rows.find((r) => r.v.item === "Box6");
    assert.equal(can?.v.available, 100 - 52);
    assert.equal(can?.v.required, 52);
    assert.equal(box?.v.available, 50 - 10);
    const reorder = await mod("reorderRm").load(ctx);
    assert.deepEqual(reorder.rows.map((r) => r.v.item).sort(), ["Box6", "Tin can 5L"]);
  });

  test("a requisition's present quantity is the level's available figure", async () => {
    const ctx = await as(admin);
    const made = await mod("requisitions").forms!.new(ctx, { date: TODAY, requiredBy: TODAY, department: "Production", godown: "Bhiwandi", type: "Can", item: "Tin can 5L", required: "60", priority: "Urgent" }, []);
    assert.ok(made.ok);
    const toluene = await mod("requisitions").forms!.new(ctx, { date: TODAY, requiredBy: TODAY, department: "Production", godown: "Bhiwandi", type: "Chemical", item: "Toluene", required: "60", priority: "Urgent" }, []);
    assert.ok(toluene.ok);
    const { rows } = await mod("requisitions").load(ctx);
    assert.equal(rows.find((r) => r.v.item === "Tin can 5L")?.v.present, 48);
    assert.equal(rows.find((r) => r.v.item === "Toluene")?.v.present, "no level set");
  });

  test("the requisition form shows each lot on hand, at this godown and elsewhere, and offers no finished goods", async () => {
    const ctx = await as(admin);
    const { spec } = await mod("requisitions").load(ctx);
    const form = spec.newForm!;
    /* The categories are offered per department now; no department is offered a finished good. */
    const byDept = form.line!.find((f) => f.k === "item")!.optsBy!.map;
    const typeOf = form.data!.typeOf as Record<string, string>;
    assert.ok(Object.keys(byDept).length);
    for (const opts of Object.values(byDept)) assert.ok(opts.every((i) => typeOf[i] !== "Finish Good"));
    const lots = (await rmLots()).filter((l) => l.item === "Toluene" && l.stock > 0);
    assert.ok(lots.length, "the fixture holds Toluene");
    const godown = lots[0].godown;
    const shown = runCalc("requisitions.onHand", { h: { item: "Toluene", godown }, l: {}, lines: [], i: -1, data: form.data ?? {} });
    for (const l of lots.filter((x) => x.godown === godown)) assert.ok(shown.includes(`Lot ${l.lotNo} ·`), shown);
    assert.match(runCalc("requisitions.onHand", { h: { item: "Toluene", godown: "Nowhere" }, l: {}, lines: [], i: -1, data: form.data ?? {} }), /^None at Nowhere\nElsewhere · /);
    const fg = await mod("requisitions").forms!.new(ctx, { date: TODAY, requiredBy: TODAY, department: "Production", godown: "Bhiwandi", type: "Finish Good", item: BOXED, required: "5", priority: "Urgent" }, []);
    assert.ok(!fg.ok && fg.fieldErrors?.[0].field === "type", JSON.stringify(fg));
  });

  test("a boxed SKU's level reads packing stock", async () => {
    const ctx = await as(admin);
    assert.ok((await mod("fgLevels").forms!.new(ctx, { godown: "Bhiwandi", sku: BOXED, min: "10", status: "Follow" }, [])).ok);
    const { rows } = await mod("reorderFg").load(ctx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].v.available, 7);
    assert.equal(rows[0].v.kind, "FG Packing Inventory");
  });
});

describe("costs stay behind their power", () => {
  test("a clerk sees no SFG rate, FG costing or stock value", async () => {
    const c = await as(clerk);
    for (const k of ["sfgBatches", "fgFill", "packBatches", "sfgStock", "fgStock", "packStock"]) {
      const { spec, rows } = await mod(k).load(c);
      const money = spec.cols.filter((x) => x.t === "m");
      assert.equal(money.length, 0, `${k} shows no money column`);
      for (const r of rows) for (const key of ["rate", "costing", "sfgRate", "value", "amount"]) assert.ok(!(key in r.v), `${k} sends no ${key}`);
    }
    const fills = await db.select().from(erpFgFills).where(eq(erpFgFills.lotCode, "FG1BH"));
    assert.equal(fills.length, 1);
  });
});

describe("what filling and packing use comes out of stock (A-30)", () => {
  test("the cans filled and the boxes packed leave their lots, and a level does not count them twice", async () => {
    const lots = await rmLots();
    const can = lots.filter((l) => l.item === "Tin can 5L" && l.godownId === "erpg_bhiwandi").reduce((n, l) => n + l.stock, 0);
    const box = lots.filter((l) => l.item === "Box6" && l.godownId === "erpg_bhiwandi").reduce((n, l) => n + l.stock, 0);
    assert.equal(can, 100 - 52, "52 cans were filled");
    assert.equal(box, 50 - 10, "one batch of 10 boxes was packed");
    const ctx = await as(admin);
    const level = (await mod("rmLevels").load(ctx)).rows.find((r) => r.v.item === "Tin can 5L");
    assert.equal(level?.v.available, 48, "the level reads the lot stock as it stands");
  });

  test("a packing batch is refused when the empty boxes are not at the godown", async () => {
    const ctx = await as(admin);
    assert.ok((await mod("fgFill").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", sfg: SFG, sfgLot: "1ASTOL1", fg: FG, size: "5", canUse: "Tin can 5L", cans: "20" }, [])).ok);
    const lot = (await fgLots()).find((l) => l.stock >= 4)!.lotCode;
    const refused = await mod("packBatches").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", fg: FG, sku: BOXED, boxes: "41", lot, cans: "4" }, []);
    assert.match(fieldMsg(refused), /^Low Box Quantity · 41 Box6 needed, 40 at Bhiwandi/);
    const fits = await mod("packBatches").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", fg: FG, sku: BOXED, boxes: "5", lot, cans: "4" }, []);
    assert.ok(fits.ok, JSON.stringify(fits));
  });
});

describe("recipes", () => {
  test("a recipe starts a batch with its lines, and a batch that used more than it allows is flagged", async () => {
    const ctx = await as(admin);
    assert.ok((await mod("recipes").forms!.new(ctx, { product: SFG }, [{ item: "Toluene", qty: "200" }])).ok);
    const [r] = (await mod("recipes").load(ctx)).rows;
    const start = await mod("recipes").formLoaders!.start(ctx, r.id);
    assert.equal(start?.screen, "sfgBatches");
    assert.equal(start?.init?.product, SFG);
    assert.deepEqual(start?.initLines, [{ item: "Toluene", qty: "200" }]);
    /* The batch made earlier used 400 over 2 batches: exactly the recipe. */
    const line = () => mod("sfgBatches").load(ctx).then((x) => x.rows.find((y) => y.v.item === "Toluene")!);
    assert.ok(!(await line()).flags.includes("overRecipe"));
    assert.ok((await mod("recipes").actions!.qty(ctx, r.id, { qty: "150" })).ok);
    assert.ok((await line()).flags.includes("overRecipe"), "400 against 300 and a 5% tolerance");
    const c = await as(clerk);
    assert.ok(!(await mod("recipes").actions!.qty(c, r.id, { qty: "1" })).ok, "a manager sets a recipe");
  });
});

describe("low stock reaches the people who would buy", () => {
  test("a new below-level alert tells whoever works at that godown, once", async () => {
    await db.execute(sql`insert into erp_godown_staff (godown_id, user_id) values ('erpg_bhiwandi', ${clerk.id}) on conflict do nothing`);
    await runErpAlerts();
    const mine = await db.select().from(notifications).where(eq(notifications.userId, clerk.id));
    assert.ok(mine.some((n) => n.title === "Below re-order level: Tin can 5L"), JSON.stringify(mine.map((n) => n.title)));
    const count = mine.length;
    await runErpAlerts();
    assert.equal((await db.select().from(notifications).where(eq(notifications.userId, clerk.id))).length, count, "an alert already open tells nobody again");
  });
});
