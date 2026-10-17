/**
 * Inventory Accuracy Control — against a real database through the real
 * handlers: a requirement waits for a blind count; a matching count lets it
 * through; a difference is a red flag, recounted by somebody else, and moves
 * stock only through an adjustment somebody else approves. Missing records
 * and the daily cycle count are read off the same ledgers.
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
import { appAccess, appSettings, notifications, erpPurchases, erpRawMaterials, erpRequisitions, erpRmEntries, erpRmLevels, erpStockAdjustments, erpStockCounts, erpSuppliers, erpUserPowers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig } from "@/lib/config/store";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { requirementViews, stageOf } from "@/lib/erp/screens/purchase-flow";
import { rmItemStockAt } from "@/lib/erp/stock";
import { controlWork, missingRecords, planCycleCounts } from "@/lib/erp/stock-check";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = "2026-10-11";
const BHW = "erpg_bhiwandi";

async function makeUser(name: string, level: "associate" | "manager" | "admin") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}@stock.test`, phone: String(9821000000 + Math.floor(Math.random() * 999999)), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
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

async function setting(key: string, value: unknown, valueType: "boolean" | "integer" | "decimal") {
  await db.insert(appSettings).values({ key, value, valueType, category: "erp", label: key }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  invalidateConfig();
}

/** Puts `qty` litres of a raw material on the shelf at Bhiwandi as one rated purchase lot. */
async function stock(rm: string, lot: string, qty: number) {
  await db.insert(erpRmEntries).values({ id: id("rme"), sourceType: "purchase", sourceId: id("pur"), entryDate: "2026-09-01", rawMaterialId: rm, lotNo: lot, godownId: BHW, quantity: qty });
}

const raise = async (u: typeof users.$inferSelect, item: string, required: string) =>
  mod("requisitions").forms!.new(await as(u), { date: TODAY, requiredBy: "2026-10-30", department: "Production Head", godown: "Bhiwandi", type: "Chemical", item, required, priority: "Medium" }, []);

const reqOf = async (rm: string) => (await db.select().from(erpRequisitions).where(eq(erpRequisitions.rawMaterialId, rm)).orderBy(sql`created_at desc`))[0];
const stage = async (reqId: string) => {
  const [v] = await requirementViews({ ids: [reqId] });
  return stageOf(v);
};
const rootCount = async (rm: string) => (await db.select().from(erpStockCounts).where(sql`raw_material_id = ${rm} and recount_of_id is null`).orderBy(sql`created_at desc`))[0];

let admin: typeof users.$inferSelect;
let store1: typeof users.$inferSelect;
let store2: typeof users.$inferSelect;
let controller: typeof users.$inferSelect;

before(async () => {
  await db.execute(
    sql`truncate users, erp_raw_materials, erp_suppliers, erp_inward, erp_tests, erp_purchases, erp_rm_entries, erp_requisitions, erp_quotations,
        erp_purchase_orders, erp_po_lines, erp_user_powers, erp_godown_staff, erp_user_settings, erp_stock_counts, erp_stock_adjustments,
        erp_transfers, erp_rm_levels, erp_sfg_lines, erp_sfg_entries, notifications, audit_log restart identity cascade`,
  );
  await setting("erp.stockCheck.onRequirement", true, "boolean");
  await setting("erp.stockCheck.tolerancePercent", 2, "decimal");
  await setting("erp.stockCheck.toleranceFloor", 1, "decimal");
  admin = await makeUser("Asha Admin", "admin");
  store1 = await makeUser("Ravi Store", "associate");
  store2 = await makeUser("Sunil Store", "associate");
  controller = await makeUser("Meera Control", "manager");
  await db.insert(erpUserPowers).values({ userId: controller.id, power: "stockControl", grantedById: admin.id });
  await db.insert(erpSuppliers).values({ id: "sup_a", name: "Asian Solvents", partyCode: "AS" });
  await db.insert(erpRawMaterials).values([
    { id: "rm_tol", serialNo: 1, name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical", purchaseMethod: "direct", preferredSupplierId: "sup_a" },
    { id: "rm_xyl", serialNo: 2, name: "Xylene", code: "XYL", unit: "Litre", materialType: "Chemical", purchaseMethod: "direct", preferredSupplierId: "sup_a" },
    { id: "rm_ace", serialNo: 3, name: "Acetone", code: "ACE", unit: "Litre", materialType: "Chemical", purchaseMethod: "direct", preferredSupplierId: "sup_a" },
  ]);
  await stock("rm_tol", "AS-TOL-1", 500);
  await stock("rm_xyl", "AS-XYL-1", 300);
  await stock("rm_xyl", "AS-XYL-2", 200);
  await stock("rm_ace", "AS-ACE-1", 100);
  await db.insert(erpRmLevels).values({ id: id("rml"), godownId: BHW, materialType: "Chemical", rawMaterialId: "rm_tol", minQty: 200, maxQty: 800 });
});

after(async () => {
  setTestUser(null);
  await setting("erp.stockCheck.onRequirement", true, "boolean");
  await db.$client.end();
});

describe("a requirement waits for its blind count to be entered, and no longer", () => {
  test("raising it opens the count, and the buying steps wait for it", async () => {
    const r = await raise(store1, "Toluene", "300");
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.match(r.message ?? "", /count the stock first/);
    const req = await reqOf("rm_tol");
    assert.equal(req.stockCheckRequired, true);
    const st = await stage(req.id);
    assert.equal(st.stage, "Blind count");
    assert.equal(st.readyForPo, false);
    const count = await rootCount("rm_tol");
    assert.equal(count.status, "open");
    assert.equal(count.kind, "reorder");
    assert.equal(count.requisitionId, req.id);
    /* The server refuses what the list draws disabled. */
    const vendor = await mod("requisitions").actions!.vendor(await as(admin), req.id, { vendor: "Asian Solvents" });
    assert.ok(!vendor.ok && /blind count/.test(vendor.error));
  });

  test("the To count tab never shows the book", async () => {
    const load = await mod("countTasks").load(await as(store1));
    const row = load.rows.find((x) => String(x.v.item) === "Toluene");
    assert.ok(row);
    assert.equal(JSON.stringify(row.v).includes("500"), false, "the book is not in the row");
    const panel = row.panel?.data as { blind: boolean; book: number | null; reconciled: number | null };
    assert.equal(panel.blind, true);
    assert.equal(panel.book, null);
    assert.equal(panel.reconciled, null);
  });

  test("a count within tolerance: the purchase goes on, with no flag", async () => {
    const count = await rootCount("rm_tol");
    const res = await mod("countTasks").actions!.count(await as(store1), count.id, { qty: "495", bin: "Bay 3" });
    assert.ok(res.ok, res.ok ? "" : res.error);
    assert.match(res.message ?? "", /book 500/);
    assert.equal((await rootCount("rm_tol")).status, "matched");
    const req = await reqOf("rm_tol");
    const [v] = await requirementViews({ ids: [req.id] });
    assert.equal(v.stock?.gate.blocks, false);
    assert.equal(v.stock?.gate.flag, null);
    assert.equal(v.stock?.justification?.justified, 305);
    assert.equal(stageOf(v).readyForPo, true, "direct, default vendor, counted — ready for the PO");
  });

  test("asking for far more than the count justifies is flagged, not held", async () => {
    const r = await raise(store1, "Toluene", "900");
    assert.ok(r.ok);
    /* The open count for the shelf is new: the earlier match was before this requirement. */
    const req = await reqOf("rm_tol");
    assert.equal((await stage(req.id)).stage, "Blind count");
    const count = await rootCount("rm_tol");
    assert.ok((await mod("countTasks").actions!.count(await as(store2), count.id, { qty: "500" })).ok);
    const [v] = await requirementViews({ ids: [req.id] });
    assert.equal(v.stock?.gate.flag, "stockOverJustified");
    assert.equal(stageOf(v).readyForPo, true, "nothing to confirm — it goes on");
  });
});

describe("a red flag is recounted, investigated and adjusted — never silently", () => {
  let reqId = "";
  let rootId = "";
  test("a short count is a red flag that notifies stock control, and the purchase goes on", async () => {
    assert.ok((await raise(store1, "Xylene", "100")).ok);
    reqId = (await reqOf("rm_xyl")).id;
    rootId = (await rootCount("rm_xyl")).id;
    const res = await mod("countTasks").actions!.count(await as(store1), rootId, { qty: "440" });
    assert.ok(res.ok);
    assert.match(res.message ?? "", /Red flag: -60/);
    assert.equal((await rootCount("rm_xyl")).status, "flagged");
    const st = await stage(reqId);
    assert.equal(st.readyForPo, true, "a red flag never holds the requirement");
    const [v] = await requirementViews({ ids: [reqId] });
    assert.equal(v.stock?.gate.flag, "stockFlag");
    const told = await db.select().from(notifications).where(eq(notifications.userId, controller.id));
    assert.equal(told.length, 1, "the stock-control holder is told");
    assert.match(told[0].title, /Stock difference: Xylene at Bhiwandi/);
    assert.match(told[0].body, /440.*500.*-60/);
    assert.equal((await db.select().from(notifications).where(eq(notifications.userId, admin.id))).length, 1, "an ERP administrator is told");
    assert.equal((await db.select().from(notifications).where(eq(notifications.userId, store1.id))).length, 0, "not the counter, who saw it on the screen");
    assert.equal((await db.select().from(notifications).where(eq(notifications.userId, store2.id))).length, 0, "nobody else");
  });

  test("the recount is somebody else's", async () => {
    assert.ok((await mod("stockFlags").actions!.recount(await as(controller), rootId, {})).ok);
    assert.equal((await rootCount("rm_xyl")).status, "recount");
    const [child] = await db.select().from(erpStockCounts).where(eq(erpStockCounts.recountOfId, rootId));
    const same = await mod("countTasks").actions!.count(await as(store1), child.id, { qty: "440" });
    assert.ok(!same.ok && /somebody other/.test(same.error));
    const other = await mod("countTasks").actions!.count(await as(store2), child.id, { qty: "441" });
    assert.ok(other.ok);
    assert.match(other.message ?? "", /confirms a difference/);
    assert.equal((await rootCount("rm_xyl")).status, "investigating");
    const told = await db.select().from(notifications).where(eq(notifications.userId, controller.id));
    assert.ok(told.some((n) => /confirmed/.test(n.title)), "a confirmed difference is told again");
  });

  test("the drawer lists causes from the records, and a shortage nothing explains is physical", async () => {
    const load = await mod("stockFlags").load(await as(controller));
    const row = load.rows.find((x) => x.id === rootId);
    const panel = row?.panel?.data as { causes: { missing: string; likelihood: string }[]; counted: number; reconciled: number };
    assert.equal(panel.counted, 441);
    assert.equal(panel.reconciled, 500);
    assert.ok(panel.causes.some((c) => c.missing === "physical" && c.likelihood === "likely"));
  });

  test("'the missing record is entered' is refused while the book still disagrees", async () => {
    const res = await mod("stockFlags").actions!.missingEntry(await as(controller), rootId, { note: "Checked the SFG register for issues" });
    assert.ok(!res.ok && /still differs/.test(res.error));
  });

  test("an adjustment is approved by somebody other than its requester, and writes off oldest lot first", async () => {
    const req = await mod("stockFlags").actions!.adjust(await as(controller), rootId, { reasonCode: "Spillage or leakage", reason: "Drum valve leaked in bay 2 over the weekend" });
    assert.ok(req.ok, req.ok ? "" : req.error);
    const [adj] = await db.select().from(erpStockAdjustments).where(eq(erpStockAdjustments.countId, rootId));
    assert.equal(adj.quantity, -59);
    assert.equal(await rmItemStockAt("rm_xyl", BHW), 500, "nothing moves before approval");
    const own = await mod("stockAdjustments").actions!.approve(await as(controller), adj.id, {});
    assert.ok(!own.ok && /other than the requester/.test(own.error));
    const noPower = await mod("stockAdjustments").actions!.approve(await as(store2), adj.id, {});
    assert.ok(!noPower.ok);
    const ok = await mod("stockAdjustments").actions!.approve(await as(admin), adj.id, {});
    assert.ok(ok.ok, ok.ok ? "" : ok.error);
    assert.equal(await rmItemStockAt("rm_xyl", BHW), 441);
    assert.equal(await rmItemStockAt("rm_xyl", "erpg_item_lost_record"), 59, "written off to Item Lost Record");
    const lots = (await db.execute(sql`select lot_no, quantity::float8 as q from erp_transfers where item_id = 'rm_xyl' order by lot_no`)) as unknown as { lot_no: string; q: number }[];
    assert.deepEqual([...lots], [{ lot_no: "AS-XYL-1", q: 59 }]);
    const root = await rootCount("rm_xyl");
    assert.equal(root.status, "resolved");
    assert.equal(root.resolution, "adjusted");
    assert.equal((await stage(reqId)).readyForPo, true);
  });

  test("a surplus is entered on the newest lot", async () => {
    const r = await raise(store1, "Acetone", "50");
    assert.ok(r.ok);
    const root = await rootCount("rm_ace");
    assert.ok((await mod("countTasks").actions!.count(await as(store1), root.id, { qty: "120" })).ok);
    assert.ok((await mod("stockFlags").actions!.recount(await as(admin), root.id, {})).ok);
    const [child] = await db.select().from(erpStockCounts).where(eq(erpStockCounts.recountOfId, root.id));
    assert.ok((await mod("countTasks").actions!.count(await as(store2), child.id, { qty: "120" })).ok);
    assert.ok((await mod("stockFlags").actions!.adjust(await as(store2), root.id, { reasonCode: "Received, never recorded", reason: "A drum delivered with the last lot was never weighed in" })).ok);
    const [adj] = await db.select().from(erpStockAdjustments).where(eq(erpStockAdjustments.countId, root.id));
    assert.ok((await mod("stockAdjustments").actions!.approve(await as(controller), adj.id, {})).ok);
    assert.equal(await rmItemStockAt("rm_ace", BHW), 120);
    const [e] = await db.select().from(erpRmEntries).where(eq(erpRmEntries.sourceType, "adjustment"));
    assert.equal(e.lotNo, "AS-ACE-1");
    assert.equal(e.quantity, 20);
  });
});

describe("an urgent purchase approved under the old rule", () => {
  test("goes on without its count", async () => {
    await db.update(erpStockCounts).set({ status: "cancelled" }).where(sql`raw_material_id = 'rm_tol' and status = 'open'`);
    assert.ok((await raise(store1, "Toluene", "100")).ok);
    const req = await reqOf("rm_tol");
    assert.equal((await stage(req.id)).stage, "Blind count");
    await db.update(erpRequisitions).set({ stockExceptionStatus: "approved", stockExceptionReason: "Line stops tomorrow without it" }).where(eq(erpRequisitions.id, req.id));
    assert.notEqual((await stage(req.id)).stage, "Blind count");
  });
});

describe("missing records, the cycle count and the dashboard", () => {
  test("a register lot that never reached stock is listed, and nothing is created", async () => {
    await db.insert(erpPurchases).values({ id: "pur_norate", prNumber: 7001, purchaseDate: "2026-10-01", supplierId: "sup_a", rawMaterialId: "rm_tol", lotNo: "AS-TOL-9", quantity: 50, unit: "Litre", godownId: BHW, source: "manual" } as typeof erpPurchases.$inferInsert);
    const found = await missingRecords();
    const row = found.find((m) => m.id === "pur:pur_norate");
    assert.ok(row);
    assert.equal(row.kind, "purchase_no_entry");
    assert.match(row.detail, /rate is missing/);
    assert.equal((await db.select().from(erpRmEntries).where(eq(erpRmEntries.sourceId, "pur_norate"))).length, 0);
  });

  test("today's cycle counts open once, however often the job runs", async () => {
    await setting("erp.stockCheck.dailyCount", 2, "integer");
    await db.update(erpStockCounts).set({ status: "cancelled" }).where(eq(erpStockCounts.status, "open"));
    const first = await planCycleCounts(null);
    const second = await planCycleCounts(null);
    assert.ok(first.opened <= 2);
    assert.equal(second.opened, 0);
    const work = await controlWork();
    assert.ok(work.toCount.length >= first.opened);
  });
});

describe("a stock check of anything, by anybody", () => {
  test("a matching check is just a record; a mismatch waits for the office and can be raised into a count", async () => {
    await db.insert(erpRawMaterials).values({ id: "rm_fc", serialNo: 40, name: "Butanol", code: "BUT", unit: "Litre", materialType: "Chemical", purchaseMethod: "direct", preferredSupplierId: "sup_a" });
    await stock("rm_fc", "AS-BUT-1", 120);
    const { recordFloorCheck, setFloorCheckReason, openMismatches, checkableItems } = await import("@/lib/erp/floor-checks");

    const items = await checkableItems(BHW);
    const but = items.find((i) => i.stage === "rm" && i.id === "rm_fc");
    assert.ok(but && but.here && !but.checkedToday);
    assert.ok(!("book" in but), "the list never carries the book");

    const ok = await recordFloorCheck(store1.id, { stage: "rm", itemId: "rm_fc", godownId: BHW, qty: 120.5, key: "CHK-a", source: "factory" });
    assert.ok(ok.ok && ok.check.matched && ok.check.book === 120);
    const again = await recordFloorCheck(store1.id, { stage: "rm", itemId: "rm_fc", godownId: BHW, qty: 120.5, key: "CHK-a", source: "factory" });
    assert.ok(again.ok && again.check.replay && again.check.id === ok.check.id, "a resend answers with the first save");

    const bad = await recordFloorCheck(store1.id, { stage: "rm", itemId: "rm_fc", godownId: BHW, qty: 90, key: "CHK-b", source: "factory" });
    assert.ok(bad.ok && !bad.check.matched && bad.check.difference === -30);
    assert.ok((await openMismatches()).some((m) => m.id === bad.check.id));
    assert.equal(await setFloorCheckReason(store2.id, bad.check.id, "not mine"), false, "only the counter gives the reason");
    assert.equal(await setFloorCheckReason(store1.id, bad.check.id, "Used in production"), true);
    assert.equal((await checkableItems(BHW)).find((i) => i.id === "rm_fc")?.checkedToday?.matched, false);

    const screen = mod("floorChecks");
    const load = await screen.load(await as(controller));
    const row = load.rows.find((r) => r.id === bad.check.id);
    assert.ok(row && row.v.result === "Mismatch" && row.v.reason === "Used in production");
    assert.ok(!(await screen.actions!.review(await as(store2), bad.check.id, {})).ok, "a store hand does not review");
    const esc = await screen.actions!.escalate(await as(controller), bad.check.id, {});
    assert.ok(esc.ok, esc.ok ? "" : esc.error);
    const formal = await rootCount("rm_fc");
    assert.equal(formal.status, "open");
    assert.ok(!(await openMismatches()).some((m) => m.id === bad.check.id), "raising it reviews it");

    const viaErp = await screen.forms!.new(await as(store2), { kind: "Raw material", item: "Butanol", godown: "Bhiwandi", qty: "120", reason: "" }, []);
    assert.ok(viaErp.ok, viaErp.ok ? "" : viaErp.error);
    assert.match(viaErp.message ?? "", /Matches the book/);
  });
});
