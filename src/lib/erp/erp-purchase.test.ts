/**
 * ERP purchase — the whole flow, against a real database through the real
 * handlers: requirement → purchase method (the item's rule) → PO number,
 * linked from the Quotation manager or created at the item's price, with no
 * approval → receipt (goods inward) → testing → register → raw-material stock.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appSettings,
  erpInward,
  erpPoLines,
  erpPrCosts,
  erpPurchaseOrders,
  erpPurchases,
  erpQuoteCells,
  erpQuoteColumns,
  erpQuoteRows,
  erpRawMaterials,
  erpRequisitions,
  erpRmEntries,
  erpSuppliers,
  erpTests,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { purchaseStage } from "@/lib/erp/screens/purchase";
import { rmLots, rmLotStock } from "@/lib/erp/stock";
import { erpNavCounts } from "@/lib/erp/counts";
import { invalidateConfig } from "@/lib/config/store";
import { approvedPo } from "@/lib/erp/po-fixture";
import { applyQuoteOps } from "@/lib/erp/quotes";
import { lookupRequirementPo } from "@/lib/erp/screens/requirement-po";
import type { GrnItem } from "@/lib/erp/engines/grn-pick";
import type { ToolResult } from "@/lib/erp/ui";

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

/**
 * Goods received against a fresh approved PO for exactly these items — for the
 * tests whose subject is the gate itself (the scale, transport, costs) rather
 * than the flow that raised the PO.
 */
async function receive(h: Record<string, string>, lines: (Record<string, string> & { item: string })[], rates: Record<string, number> = {}) {
  const items = [...new Set(lines.map((l) => l.item))];
  const po = await approvedPo("Asian Solvents", items.map((item) => ({ item, quantity: 100000, ratePaise: rates[item] })));
  return mod("inward").forms!.new(await as(admin), { date: TODAY, godown: "Bhiwandi", po: po.po, ...h }, lines.map((l) => ({ ...l, poLine: po.lines[l.item] })));
}

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;
const TODAY = "2026-09-20";
const NONE = "No Transport Charges";

before(async () => {
  /* This suite is about the flow after the stock check; the check has its own suite (erp-stock-check). */
  await db
    .insert(appSettings)
    .values({ key: "erp.stockCheck.onRequirement", value: false, valueType: "boolean", category: "erp", label: "Count stock before every purchase requirement" })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: false } });
  invalidateConfig();
  await db.execute(
    sql`truncate users, erp_raw_materials, erp_suppliers, erp_inward, erp_tests, erp_purchases, erp_rm_entries, erp_requisitions, erp_quotations, erp_purchase_orders, erp_po_lines, erp_quote_cells, erp_quote_rows, erp_quote_columns, erp_user_powers, erp_godown_staff, erp_user_settings, audit_log restart identity cascade`,
  );
  await db.execute(sql`update erp_series set last = 1000 where key = 'pr'`);
  await db.execute(sql`update erp_series set last = 0 where key = 'po'`);
  admin = await makeUser("Kavita Admin", "admin");
  clerk = await makeUser("Deepa Clerk", "associate");
  await db.insert(erpSuppliers).values([
    { id: "sup_a", name: "Asian Solvents", partyCode: "AS", whatsapp: "9820012345", creditDays: 30 },
    { id: "sup_b", name: "Bharat Chemicals", partyCode: "BC" },
  ]);
  await db.insert(erpRawMaterials).values([
    /* The three purchase rules: chemicals bought on the Quotation manager, cans left to the
       buyer, and routine boxes bought direct at the price on the item — one with no price. */
    { id: "rm_tol", serialNo: 1, name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical", density: 0.87, testingList: ["Smell", "Density"], purchaseMethod: "quotation" },
    { id: "rm_mek", serialNo: 2, name: "MEK", code: "MEK", unit: "Kg", materialType: "Chemical", density: 0.8, testingList: [], purchaseMethod: "quotation" },
    { id: "rm_can", serialNo: 3, name: "1 L Tin Can", code: "CAN1", unit: "Unit", materialType: "Can", testingList: [], purchaseMethod: "buyer" },
    { id: "rm_box", serialNo: 4, name: "Carton 12", code: "BOX12", unit: "Unit", materialType: "Box", testingList: [], purchaseMethod: "direct", preferredSupplierId: "sup_a", pricePaise: 1450 },
    { id: "rm_plain", serialNo: 5, name: "Plain Carton", code: "BOXP", unit: "Unit", materialType: "Box", testingList: [], purchaseMethod: "direct", preferredSupplierId: "sup_b" },
  ]);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/** The receipt form's labels for the flow's PO, filled in by the flow tests. */
let flowPo = "";
const flowLine: Record<string, string> = {};

describe("the purchase flow up to the PO", () => {
  const raise = async (item: string, type: string, qty: string) =>
    mod("requisitions").forms!.new(await as(clerk), { date: TODAY, requiredBy: "2026-09-30", department: "Production Head", godown: "Bhiwandi", type, item, required: qty, priority: "Medium" }, []);
  /* The flow's own requirements; fixtures elsewhere raise others for the same items. */
  const req = async (item: string) => (await db.select().from(erpRequisitions).where(sql`raw_material_id = ${item} and purchase_rule is not null and department = 'Production Head' and required_by = '2026-09-30'`))[0];
  const stage = async (item: string) => {
    const { rows } = await mod("requisitions").load(await as(admin));
    return rows.find((r) => r.v.item === item)?.v.stage;
  };
  const cell = (rowId: string, columnId: string) => ({ rowId, columnId });

  test("the item's purchase rule decides how the PO comes, the moment it is raised", async () => {
    assert.ok((await raise("Toluene", "Chemical", "400")).ok);
    assert.ok((await raise("MEK", "Chemical", "200")).ok);
    assert.ok((await raise("1 L Tin Can", "Can", "500")).ok);
    assert.ok((await raise("Carton 12", "Box", "1200")).ok);
    assert.equal(await stage("Toluene"), "Waiting for PO number", "quotation — bought on the Quotation manager");
    assert.equal(await stage("1 L Tin Can"), "Create or link PO", "buyer decision — either");
    assert.equal(await stage("Carton 12"), "Create PO", "direct purchase — no quotation");
    const box = await req("rm_box");
    assert.equal(box.purchaseRule, "direct");
    assert.equal(box.supplierId, "sup_a", "the item's default vendor");
    assert.equal((await req("rm_mek")).unit, "Kg", "a requirement is counted in the item's own purchase unit");
    assert.equal((await req("rm_can")).unit, "Pcs");
  });

  test("a requirement needs its date and department; finished goods are never bought", async () => {
    const c = await as(clerk);
    const noDate = await mod("requisitions").forms!.new(c, { date: TODAY, department: "Production Head", godown: "Bhiwandi", type: "Chemical", item: "MEK", required: "1", priority: "Medium" }, []);
    assert.ok(!noDate.ok && noDate.fieldErrors?.[0].field === "requiredBy");
    const fg = await mod("requisitions").forms!.new(c, { date: TODAY, requiredBy: TODAY, department: "Production Head", godown: "Bhiwandi", type: "Finish Good", item: "MEK", required: "1", priority: "Medium" }, []);
    assert.ok(!fg.ok && fg.fieldErrors?.[0].field === "type");
  });

  test("Purchase it on the Quotation manager makes the PO number — nobody types one", async () => {
    const a = await as(admin);
    await db.insert(erpQuoteColumns).values([
      { id: "eqc_toluene", position: 1, pack: "Drum", name: "Toluene", brand: "Reliance", rawMaterialId: "rm_tol" },
      { id: "eqc_mekdrum", position: 2, pack: "Drum", name: "MEK", brand: "", rawMaterialId: "rm_mek" },
      { id: "eqc_tincan", position: 3, pack: "Can", name: "1 L Tin", brand: "", rawMaterialId: "rm_can" },
    ]);
    await db.insert(erpQuoteRows).values({ id: "eqr_asian1", quoteDate: "2026-09-18", party: "Asian Solvents", supplierId: "sup_a" });
    await db.insert(erpQuoteCells).values([
      { rowId: "eqr_asian1", columnId: "eqc_toluene", value: "100", status: "ready" },
      { rowId: "eqr_asian1", columnId: "eqc_mekdrum", value: "90" },
      { rowId: "eqr_asian1", columnId: "eqc_tincan", value: "10" },
    ]);
    /* A typed PO number is ignored: the server makes it. */
    const bought = await applyQuoteOps(a, [{ op: "cell", ...cell("eqr_asian1", "eqc_toluene"), status: "po", drums: 2, poNo: "TYPED-99" } as never]);
    assert.ok(bought.ok, JSON.stringify(bought));
    assert.deepEqual(bought.data.minted, [{ rowId: "eqr_asian1", columnId: "eqc_toluene", poNo: "PO-1" }]);
    const [c1] = await db.select().from(erpQuoteCells).where(sql`column_id = 'eqc_toluene'`);
    assert.equal(c1.poNo, "PO-1");
    /* Editing the purchase keeps its number. */
    const again = await applyQuoteOps(a, [{ op: "cell", ...cell("eqr_asian1", "eqc_toluene"), status: "po", drums: 3 }]);
    assert.ok(again.ok && again.data.minted.length === 0);
    /* The other two were bought under the same number the old way, when the desk typed it. */
    await db.update(erpQuoteCells).set({ status: "po", poNo: "PO-1", drums: 1, poAt: new Date() }).where(sql`column_id in ('eqc_mekdrum', 'eqc_tincan')`);
  });

  test("a PO number is looked up and checked against the requirement before it is linked", async () => {
    const a = await as(admin);
    const tol = await req("rm_tol");
    const unknown = await lookupRequirementPo(a, tol.id, "PO-77");
    assert.ok(!unknown.ok && /No PO numbered PO-77/.test(unknown.fieldErrors?.[0].message ?? ""));
    const seen = await lookupRequirementPo(a, tol.id, " po-1 ");
    assert.ok(seen.ok, JSON.stringify(seen));
    assert.equal(seen.data.vendor, "Asian Solvents");
    assert.equal(seen.data.drums, 3);
    assert.match(seen.data.rate ?? "", /100/);
    /* The route is the item's rule: a direct item is not linked, a quotation item is not created. */
    const box = await req("rm_box");
    const wrongWay = await mod("requisitions").actions!.linkPo(a, box.id, { poNo: "PO-1" });
    assert.ok(!wrongWay.ok && /direct purchase/.test(wrongWay.error));
    const notCreated = await mod("requisitions").actions!.createPo(a, tol.id, { vendor: "Asian Solvents" });
    assert.ok(!notCreated.ok && /Quotation manager/.test(notCreated.error));
  });

  test("linking needs no approval: the PO is the same number, sent, ready to receive", async () => {
    const a = await as(admin);
    for (const item of ["rm_tol", "rm_mek", "rm_can"]) {
      const r = await mod("requisitions").actions!.linkPo(a, (await req(item)).id, { poNo: "PO-1" });
      assert.ok(r.ok, `${item}: ${JSON.stringify(r)}`);
    }
    const pos = await db.select().from(erpPurchaseOrders);
    assert.equal(pos.length, 1, "three requirements on one PO number are one PO");
    const [po] = pos;
    assert.equal(po.poNumber, 1, "the Quotation manager's number is the ERP's");
    assert.equal(po.qmPoNo, "PO-1");
    assert.equal(po.source, "quotation_manager");
    assert.equal(po.status, "Sent");
    const lines = await db.select().from(erpPoLines).orderBy(erpPoLines.sortOrder);
    assert.deepEqual(
      lines.map((l) => [l.rawMaterialId, l.quantity, l.ratePaise, l.gstBp, l.drums]),
      [
        ["rm_tol", 400, 10000, 1800, 3],
        ["rm_mek", 200, 9000, 1800, 1],
        ["rm_can", 500, 1000, 1800, 1],
      ],
    );
    assert.equal(await stage("Toluene"), "Waiting for goods");
    assert.equal((await req("rm_tol")).status, "Order Placed");
    const twice = await mod("requisitions").actions!.linkPo(a, (await req("rm_tol")).id, { poNo: "PO-1" });
    assert.ok(!twice.ok, "a requirement is on one PO");
  });

  test("a direct purchase creates its PO at the item's price — the amount is never typed", async () => {
    const a = await as(admin);
    const box = await req("rm_box");
    const r = await mod("requisitions").actions!.createPo(a, box.id, {
      vendor: "Asian Solvents",
      qty: "1200",
      deliverTo: "Bhiwandi",
      deliveryDate: "2099-09-30",
      terms: "30 days credit",
      rate: "1", // ignored: the rate is the item's
    });
    assert.ok(r.ok, JSON.stringify(r));
    const [po] = await db.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, (r.data as { poId: string }).poId));
    assert.equal(po.status, "Approved", "no approval");
    assert.equal(po.source, "erp");
    const [line] = await db.select().from(erpPoLines).where(eq(erpPoLines.poId, po.id));
    assert.equal(line.ratePaise, 1450);
    assert.equal(line.quantity, 1200);
    assert.equal(await stage("Carton 12"), "Waiting for goods");
  });

  test("an item with no price in Raw materials is ordered at ₹0", async () => {
    const a = await as(admin);
    assert.ok((await raise("Plain Carton", "Box", "300")).ok);
    const plain = await req("rm_plain");
    const r = await mod("requisitions").actions!.createPo(a, plain.id, { vendor: "Bharat Chemicals", qty: "300", deliverTo: "Bhiwandi", deliveryDate: "2099-09-30", terms: "Advance" });
    assert.ok(r.ok && /no price on the item/.test(r.message ?? ""), JSON.stringify(r));
    const [line] = await db.select().from(erpPoLines).where(eq(erpPoLines.requisitionId, plain.id));
    assert.equal(line.ratePaise, 0);
  });

  test("sending the PO records how, and hands back the PO written out for the vendor", async () => {
    await db.execute(sql`insert into erp_user_powers (user_id, power) values (${clerk.id}, 'viewPurchaseMoney') on conflict do nothing`);
    const [po] = await db.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.poNumber, 1));
    const r = await mod("purchaseOrders").actions!.send(await as(clerk), po.id, { via: "WhatsApp" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = (r.data as ToolResult).dialog!;
    assert.match(d.text!, /PURCHASE ORDER PO-1/);
    assert.match(d.open!.href, /^https:\/\/wa\.me\/919820012345\?text=/);
    const [after] = await db.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.poNumber, 1));
    assert.equal(after.status, "Sent");
    assert.equal(after.sentVia, "WhatsApp");
    const { spec } = await mod("inward").load(await as(admin));
    const po1 = spec.newForm!.header.find((f) => f.k === "po")!;
    assert.ok(po1.typed, "the GRN's PO number is typed");
    flowPo = po1.opts!.find((o) => o.startsWith("PO-1 "))!;
    assert.equal(flowPo, "PO-1 · Asian Solvents");
    for (const key of Object.keys(spec.newForm!.data!.pendingOf as object)) {
      const [label, line] = key.split("|");
      if (label === flowPo) flowLine[line.replace(/^\d+\. /, "")] = line;
    }
    /* The clerk goes back to having no purchase money for the tests that follow. */
    await db.execute(sql`delete from erp_user_powers where user_id = ${clerk.id}`);
  });
});

describe("inward", () => {
  test("one inward draws one PR for all its lines, and sends each where it is going as it is saved", async () => {
    const ctx = await as(admin);
    const r = await mod("inward").forms!.new(ctx, { date: TODAY, po: flowPo, godown: "Bhiwandi", transportMode: NONE }, [
      { poLine: flowLine["Toluene"], drums: "2", qty: "360" },
      { poLine: flowLine["MEK"], drums: "1", weight: "175", emptyDrum: "15" },
      { poLine: flowLine["1 L Tin Can"], qty: "500" },
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
    /* The receipt moves the PO and its requirements along. */
    const [po] = await db.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.poNumber, 1));
    assert.equal(po.status, "Partly received", "360 of 400 Toluene and 160 of 200 MEK");
    assert.equal(rows.every((x) => x.poLineId && x.poId === po.id), true);
    const [can] = await db.select().from(erpRequisitions).where(eq(erpRequisitions.rawMaterialId, "rm_can"));
    assert.equal(can.status, "Received", "500 of 500 tins");
  });

  test("a GRN takes the PO number as typed", async () => {
    const r = await mod("inward").forms!.new(await as(admin), { date: TODAY, po: "po-1", godown: "Bhiwandi", transportMode: NONE }, [{ poLine: flowLine["1 L Tin Can"], qty: "26" }]);
    assert.ok(!r.ok && /More than the PO allows/.test(r.fieldErrors?.[0].message ?? ""), "found by its bare number — and refused only for the quantity");
  });

  test("more than the PO allows is refused, beyond the tolerance", async () => {
    const r = await mod("inward").forms!.new(await as(admin), { date: TODAY, po: flowPo, godown: "Bhiwandi", transportMode: NONE }, [{ poLine: flowLine["1 L Tin Can"], qty: "26" }]);
    assert.ok(!r.ok && /More than the PO allows/.test(r.fieldErrors?.[0].message ?? ""), JSON.stringify(r));
  });

  test("a minus quantity is refused in the source's words", async () => {
    const ctx = await as(admin);
    const r = await mod("inward").forms!.new(ctx, { date: TODAY, po: flowPo, godown: "Bhiwandi", transportMode: NONE }, [{ poLine: flowLine["1 L Tin Can"], qty: "-4" }]);
    assert.ok(!r.ok && r.fieldErrors?.[0].message === "Minus Quantity Not Allowed");
  });

  test("a line routes once: a tested item cannot skip testing, and it cannot be sent again", async () => {
    const ctx = await as(admin);
    const [tol] = await db.select().from(erpInward).where(eq(erpInward.rawMaterialId, "rm_tol"));
    assert.ok(!(await mod("inward").actions!.toPurchase(ctx, tol.id, {})).ok);
    assert.ok(!(await mod("inward").actions!.toTesting(ctx, tol.id, {})).ok, "it was sent when it was saved");
  });

  test("an untested line goes straight to the register at the PO's rate, and so straight to stock", async () => {
    const ctx = await as(admin);
    const [mek] = await db.select().from(erpInward).where(eq(erpInward.rawMaterialId, "rm_mek"));
    const [p] = await db.select().from(erpPurchases).where(eq(erpPurchases.inwardId, mek.id));
    assert.equal(p.lotNo, "ASMEK1001");
    assert.equal(p.availableLitres, 200, "160 kg at density 0.8 is 200 litres");
    assert.equal(p.poNumber, "PO-1");
    assert.equal(p.ratePaise, 9000, "the PO line's rate");
    assert.equal(await rmLotStock("ASMEK1001", "erpg_bhiwandi"), 200);
    /* The bill's rate is entered over it, and the register says it differs from the PO. */
    const rated = await mod("register").actions!.rate(ctx, p.id, { rate: "92" });
    assert.ok(rated.ok);
    const { rows } = await mod("register").load(ctx);
    assert.ok(rows.find((r) => r.id === p.id)!.flags.includes("rateOffPo"));
    await mod("register").actions!.rate(ctx, p.id, { rate: "90" });
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
    assert.equal(regs[0].poNumber, "PO-1", "a tested lot carries the PO it was bought on");
    assert.equal(regs[0].ratePaise, 10000, "at the Quotation manager's rate");
    const again = await mod("testing").actions!.verify(ctx, t.id, {});
    assert.ok(!again.ok);
    assert.equal((await db.select().from(erpPurchases).where(eq(erpPurchases.testId, t.id))).length, 1);
  });
});

describe("register and stock", () => {
  test("a lot number already taken is refused with the source's message", async () => {
    const ctx = await as(admin);
    const po = await approvedPo("Asian Solvents", [{ item: "Toluene", quantity: 10 }]);
    const r = await mod("register").forms!.new(ctx, { pr: "1001", date: TODAY, po: po.po, poLine: po.lines["Toluene"], qty: "10", unit: "Litre", godown: "Bhiwandi" }, []);
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
      /* Received on PO-1 at the PO's rate, so in stock without anybody rating it. */
      ["ASCAN11001", "Bhiwandi", 500],
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

describe("transport and landing cost", () => {
  const ratePerKm = async (paise: number) => {
    await db
      .insert(appSettings)
      .values({ key: "erp.purchase.ownVehicleRatePerKmPaise", value: paise, valueType: "integer", category: "erp", label: "Own vehicle rate per km" })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: paise } });
    invalidateConfig();
  };
  const inward = async (h: Record<string, string>, lines: Record<string, string>[]) =>
    receive(h, lines as (Record<string, string> & { item: string })[]);
  const prOf = (r: { ok: boolean; message?: string }) => Number(/^PR (\d+)/.exec(r.message ?? "")?.[1]);

  after(async () => {
    await db.execute(sql`delete from app_settings where key = 'erp.purchase.ownVehicleRatePerKmPaise'`);
    invalidateConfig();
  });

  test("weight with drum is required for a kg item and optional for a litre one", async () => {
    const kg = await inward({ transportMode: "No Transport Charges" }, [{ type: "Chemical", item: "MEK", drums: "1", qty: "160" }]);
    assert.ok(!kg.ok && kg.fieldErrors?.[0].field === "l0.weight", JSON.stringify(kg));
    const noTare = await inward({ transportMode: "No Transport Charges" }, [{ type: "Chemical", item: "MEK", drums: "1", weight: "175" }]);
    assert.ok(!noTare.ok && noTare.fieldErrors?.[0].field === "l0.emptyDrum", JSON.stringify(noTare));
    const litre = await inward({ transportMode: "No Transport Charges" }, [{ type: "Chemical", item: "Toluene", drums: "1", qty: "180" }]);
    assert.ok(litre.ok, JSON.stringify(litre));
  });

  test("our own vehicle is km × the approved rate, copied onto the PR; with no rate it is refused", async () => {
    await ratePerKm(0);
    const refused = await inward({ transportMode: "Mahek Own Vehicle", km: "40", tempo: "MH04 AB 1234" }, [{ type: "Can", item: "1 L Tin Can", qty: "10" }]);
    assert.ok(!refused.ok && refused.fieldErrors?.[0].field === "km", JSON.stringify(refused));
    await ratePerKm(1800);
    const noTempo = await inward({ transportMode: "Mahek Own Vehicle", km: "40" }, [{ type: "Can", item: "1 L Tin Can", qty: "10" }]);
    assert.ok(!noTempo.ok && noTempo.fieldErrors?.[0].field === "tempo");
    const r = await inward({ transportMode: "Mahek Own Vehicle", km: "42.5", tempo: "MH04 AB 1234", transportCost: "1" }, [{ type: "Can", item: "1 L Tin Can", qty: "10" }]);
    assert.ok(r.ok, JSON.stringify(r));
    const [c] = await db.select().from(erpPrCosts).where(eq(erpPrCosts.prNumber, prOf(r)));
    assert.equal(c.transportCostPaise, 76500, "42.5 km × ₹18 — a typed cost is ignored for our own vehicle");
    assert.equal(c.ratePerKmPaise, 1800);
    await ratePerKm(2500);
    const [still] = await db.select().from(erpPrCosts).where(eq(erpPrCosts.prNumber, prOf(r)));
    assert.equal(still.transportCostPaise, 76500, "a new rate never reprices a journey already made");
  });

  test("supplier freight and other cost are shared by value, and the stock rate is the landed rate", async () => {
    /* Each lot arrives at its PO line's rate: cans at ₹10, MEK at ₹90 a kg. */
    const r = await receive(
      { transportMode: "Supplier Transport", transportCost: "2360", tempo: "GJ05 X 9", otherCost: "640", otherNote: "Unloading" },
      [
        { type: "Can", item: "1 L Tin Can", qty: "100" },
        { type: "Chemical", item: "MEK", drums: "1", weight: "220", emptyDrum: "20" },
      ],
      { "1 L Tin Can": 1000, MEK: 9000 },
    );
    assert.ok(r.ok, JSON.stringify(r));
    const pr = prOf(r);
    const regs = await db.select().from(erpPurchases).where(eq(erpPurchases.prNumber, pr));
    const can = regs.find((x) => x.rawMaterialId === "rm_can")!;
    const mek = regs.find((x) => x.rawMaterialId === "rm_mek")!;
    assert.equal(can.ratePaise, 1000);
    const ctx = await as(admin);
    /* Cans ₹1,000 and MEK ₹18,000: the ₹3,000 splits 1:18. */
    const lots = await rmLots();
    assert.equal(lots.find((l) => l.lotNo === can.lotNo)?.ratePaise, 1158, "₹1,000 + ₹157.89 over 100 cans");
    assert.equal(lots.find((l) => l.lotNo === mek.lotNo)?.ratePaise, 8337, "(₹18,000 + ₹2,842.11) ÷ 200 kg is ₹104.21 a kg, × density 0.8");
    const { rows } = await mod("register").load(ctx);
    assert.equal(rows.find((x) => x.id === mek.id)?.v.landing, 2084211);
  });

  test("transport is recorded or corrected after the inward, once for the PR", async () => {
    const r = await inward({ transportMode: "No Transport Charges" }, [{ type: "Can", item: "1 L Tin Can", qty: "5" }]);
    const pr = prOf(r);
    const ctx = await as(admin);
    const fixed = await mod("inward").forms!.costs(ctx, { transportMode: "Third-Party Transport", transportCost: "500", tempo: "MH12 Z 1" }, [], String(pr));
    assert.ok(fixed.ok, JSON.stringify(fixed));
    const [c] = await db.select().from(erpPrCosts).where(eq(erpPrCosts.prNumber, pr));
    assert.equal(c.transportMode, "third_party");
    assert.equal(c.transportCostPaise, 50000);
    const missing = await mod("inward").forms!.costs(ctx, { transportMode: "Supplier Transport" }, [], String(pr));
    assert.ok(!missing.ok && missing.fieldErrors?.[0].field === "transportCost");
  });
});

describe("net quantity off the scale", () => {
  test("a kg line's weight without drum is weight with drum − drums × empty drum weight, whatever was typed", async () => {
    const ctx = await as(admin);
    void ctx;
    const r = await receive({ transportMode: NONE }, [
      { type: "Chemical", item: "MEK", drums: "4", weight: "872", emptyDrum: "18", qty: "999" },
    ]);
    assert.ok(r.ok, JSON.stringify(r));
    const pr = Number(/^PR (\d+)/.exec(r.message ?? "")?.[1]);
    const [line] = await db.select().from(erpInward).where(eq(erpInward.prNumber, pr));
    assert.equal(line.quantity, 800, "872 − 4 × 18");
    assert.equal(line.emptyDrumWeight, 18);
    const [reg] = await db.select().from(erpPurchases).where(eq(erpPurchases.inwardId, line.id));
    assert.equal(reg.quantity, 800, "the register gets the net, not the gross");
    assert.equal(reg.weightWithDrum, 872);
  });

  test("drums as heavy as the load is refused as a misread scale", async () => {
    const r = await receive({ transportMode: NONE }, [
      { type: "Chemical", item: "MEK", drums: "5", weight: "90", emptyDrum: "18" },
    ]);
    assert.ok(!r.ok && r.fieldErrors?.[0].field === "l0.weight", JSON.stringify(r));
  });
});

const req0 = async (item: string) => (await db.select().from(erpRequisitions).where(sql`raw_material_id = ${item} and purchase_rule is not null and department = 'Production Head' and required_by = '2026-09-30'`))[0];

describe("after the PO: cancelling, unlinking, closing short", () => {
  const raiseBox = async () =>
    mod("requisitions").forms!.new(await as(admin), { date: TODAY, requiredBy: "2026-10-30", department: "Production Head", godown: "Bhiwandi", type: "Box", item: "Carton 12", required: "50", priority: "Urgent" }, []);
  const openBox = async () => (await db.select().from(erpRequisitions).where(sql`raw_material_id = 'rm_box' and status = 'Pending' and required_by = '2026-10-30'`))[0];
  const createPo = async (reqId: string) => {
    const r = await mod("requisitions").actions!.createPo(await as(admin), reqId, { vendor: "Asian Solvents", qty: "50", deliverTo: "Bhiwandi", deliveryDate: "2099-10-30", terms: "Advance" });
    assert.ok(r.ok, JSON.stringify(r));
    return (r.data as { poId: string }).poId;
  };
  const stageOf = async (id: string) => (await mod("requisitions").load(await as(admin))).rows.find((r) => r.id === id)!.v.stage;

  test("a cancelled PO frees its requirement for a new one; a requirement on a live PO cannot be cancelled", async () => {
    assert.ok((await raiseBox()).ok);
    const req = await openBox();
    const po = await createPo(req.id);
    const a = await as(admin);
    const blocked = await mod("requisitions").actions!.cancel(a, req.id, { reason: "Not needed" });
    assert.ok(!blocked.ok, "it is on a PO");
    assert.ok((await mod("purchaseOrders").actions!.cancel(a, po, { reason: "Vendor out of stock" })).ok);
    assert.equal(await stageOf(req.id), "Create PO");
    const second = await createPo(req.id);
    assert.ok(second, "a new PO for the same requirement");
    assert.ok((await mod("purchaseOrders").actions!.cancel(a, second, { reason: "Bought from the market" })).ok);
    assert.ok((await mod("requisitions").actions!.cancel(a, req.id, { reason: "Bought from the market" })).ok);
    assert.equal(await stageOf(req.id), "Cancelled");
  });

  test("a wrong Quotation manager PO number is unlinked while nothing has arrived", async () => {
    const a = await as(admin);
    assert.ok((await mod("requisitions").forms!.new(a, { date: TODAY, requiredBy: "2026-11-15", department: "Production Head", godown: "Bhiwandi", type: "Chemical", item: "MEK", required: "60", priority: "Medium" }, [])).ok);
    const [mek] = await db.select().from(erpRequisitions).where(sql`raw_material_id = 'rm_mek' and required_by = '2026-11-15'`);
    await db.insert(erpQuoteRows).values({ id: "eqr_bharat1", quoteDate: "2026-09-19", party: "Bharat Chemicals", supplierId: "sup_b" });
    const bought = await applyQuoteOps(a, [{ op: "cell", rowId: "eqr_bharat1", columnId: "eqc_mekdrum", value: "88", status: "po", drums: 1 }]);
    assert.ok(bought.ok, JSON.stringify(bought));
    const poNo = bought.data.minted[0].poNo;
    assert.ok((await mod("requisitions").actions!.linkPo(a, mek.id, { poNo })).ok);
    assert.equal(await stageOf(mek.id), "Waiting for goods");
    assert.ok((await mod("requisitions").actions!.unlinkPo(a, mek.id, {})).ok);
    assert.equal(await stageOf(mek.id), "Waiting for PO number");
    const [po] = await db.select().from(erpPurchaseOrders).where(sql`qm_po_no = ${poNo}`);
    assert.equal(po.status, "Cancelled", "a PO left with nothing on it is cancelled");
    /* And linked again — the same number, the same PO row. */
    assert.ok((await mod("requisitions").actions!.linkPo(a, mek.id, { poNo })).ok);
    const [back] = await db.select().from(erpPurchaseOrders).where(sql`qm_po_no = ${poNo}`);
    assert.equal(back.id, po.id);
    assert.equal(back.status, "Sent");
    assert.ok(!(await mod("requisitions").actions!.unlinkPo(a, (await req0("rm_tol")).id, {})).ok, "goods arrived against PO-1 — it stays");
  });

  test("a partly received PO is closed short with a reason, and its requirements count as received", async () => {
    const [po] = await db.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.poNumber, 1));
    assert.equal(po.status, "Partly received");
    const a = await as(admin);
    assert.ok(!(await mod("purchaseOrders").actions!.cancel(a, po.id, { reason: "x" })).ok, "goods arrived — close it short instead");
    assert.ok((await mod("purchaseOrders").actions!.close(a, po.id, { reason: "Vendor short-shipped" })).ok);
    const [tol] = await db.select().from(erpRequisitions).where(sql`raw_material_id = 'rm_tol' and purchase_rule = 'quotation'`);
    assert.equal(tol.status, "Received");
    assert.equal(await stageOf(tol.id), "Closed short");
    const late = await mod("inward").forms!.new(a, { date: TODAY, po: flowPo, godown: "Bhiwandi", transportMode: NONE }, [{ poLine: flowLine["Toluene"], drums: "1", qty: "40" }]);
    assert.ok(!late.ok && late.fieldErrors?.[0].field === "po", "nothing more is received on a closed PO");
  });

  test("no purchase is registered by hand without a PO", async () => {
    const r = await mod("register").forms!.new(await as(admin), { date: TODAY, qty: "10", unit: "Litre", godown: "Bhiwandi" }, []);
    assert.ok(!r.ok && r.fieldErrors?.[0].field === "po");
  });

  test("the item master carries the purchase rule and the default vendor", async () => {
    const a = await as(admin);
    const r = await mod("rawMaterials").forms!.edit(
      a,
      { name: "1 L Tin Can", code: "CAN1", unit: "Unit", materialType: "Can", purchaseMethod: "Direct purchase", preferredSupplier: "Bharat Chemicals" },
      [],
      "rm_can",
    );
    assert.ok(r.ok, JSON.stringify(r));
    const [can] = await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.id, "rm_can"));
    assert.equal(can.purchaseMethod, "direct");
    assert.equal(can.preferredSupplierId, "sup_b");
  });
});

describe("one requirement, many items", () => {
  const head = { date: TODAY, requiredBy: "2026-12-01", department: "Production Head", godown: "Bhiwandi", priority: "For Stock", remarks: "Monthly stock-up" };
  const rowsOf = async (reqNo: number) =>
    db.select().from(erpRequisitions).where(sql`req_no = ${reqNo}`).orderBy(erpRequisitions.rawMaterialId);

  test("every item is raised under ONE number, each on its own row and its own rule", async () => {
    const r = await mod("requisitions").forms!.new(await as(admin), head, [
      { item: "Toluene", required: "400" },
      { item: "MEK", required: "120.5" },
      { item: "1 L Tin Can", required: "900" },
      { item: "", required: "" },
    ]);
    assert.ok(r.ok, JSON.stringify(r));
    assert.match(r.message ?? "", /^REQ-\d+ raised · 3 items/);
    const reqNo = Number(/REQ-(\d+)/.exec(r.message!)![1]);
    const rows = await rowsOf(reqNo);
    assert.deepEqual(
      rows.map((x) => [x.rawMaterialId, x.requiredQty, x.unit, x.priority, x.remarks, x.department]),
      [
        ["rm_can", 900, "Pcs", "For Stock", "Monthly stock-up", "Production Head"],
        ["rm_mek", 120.5, "Kg", "For Stock", "Monthly stock-up", "Production Head"],
        ["rm_tol", 400, "Litre", "For Stock", "Monthly stock-up", "Production Head"],
      ],
      "the blank row is dropped; the header travels to every item",
    );
    assert.equal(rows[1].purchaseRule, "quotation", "each item copies its own rule");
    assert.equal(rows[2].purchaseRule, "quotation");
    /* The list names the requirement on each of its items. */
    const listed = (await mod("requisitions").load(await as(admin))).rows.filter((x) => x.v.reqNo === `REQ-${reqNo}`);
    assert.equal(listed.length, 3);
  });

  test("a bad line names its row and writes nothing — a requirement is never half raised", async () => {
    const before = (await db.select().from(erpRequisitions)).length;
    const dup = await mod("requisitions").forms!.new(await as(admin), head, [
      { item: "MEK", required: "10" },
      { item: "Toluene", required: "5" },
      { item: "MEK", required: "3" },
    ]);
    assert.ok(!dup.ok && dup.fieldErrors?.[0].field === "l2.item" && /line 1/.test(dup.fieldErrors[0].message), JSON.stringify(dup));
    const noQty = await mod("requisitions").forms!.new(await as(admin), head, [{ item: "MEK", required: "10" }, { item: "Toluene", required: "" }]);
    assert.ok(!noQty.ok && noQty.fieldErrors?.[0].field === "l1.required");
    const unknown = await mod("requisitions").forms!.new(await as(admin), head, [{ item: "Acetone", required: "1" }]);
    assert.ok(!unknown.ok && unknown.fieldErrors?.[0].field === "l0.item");
    const empty = await mod("requisitions").forms!.new(await as(admin), head, []);
    assert.ok(!empty.ok && /at least one item/.test(empty.error));
    assert.equal((await db.select().from(erpRequisitions)).length, before);
  });

  test("the form is a header and an item table, its search offering every item the department may ask for", async () => {
    const form = (await mod("requisitions").load(await as(admin))).spec.newForm!;
    assert.equal(form.lineLayout, "table");
    assert.deepEqual(form.line!.map((f) => f.k), ["item", "stock", "required", "unit", "rule"]);
    assert.ok(form.line!.find((f) => f.k === "item")!.optsBy!.map["Production Head"].includes("Toluene"));
    assert.equal((form.data!.ruleShortOf as Record<string, string>).Toluene, "Quotations");
  });
});

describe("the goods receipt starts from the item", () => {
  test("a receipt started from the item carries a line per PO, across one vendor's POs, and refuses a second vendor", async () => {
    const a = await approvedPo("Asian Solvents", [{ item: "Toluene", quantity: 10 }]);
    const b = await approvedPo("Asian Solvents", [{ item: "1 L Tin Can", quantity: 10 }]);
    const c = await approvedPo("Bharat Chemicals", [{ item: "1 L Tin Can", quantity: 10 }]);
    const ctx = await as(admin);
    const { spec } = await mod("inward").load(ctx);
    assert.equal(spec.newForm!.flow, "grn");
    const grn = spec.newForm!.data!.grn as GrnItem[];
    const tol = grn.find((x) => x.item === "Toluene")!;
    assert.ok(tol.lines.some((l) => l.po === a.po && l.poLine === a.lines.Toluene), "the item offers its open PO line");
    const tins = grn.find((x) => x.item === "1 L Tin Can")!;
    assert.ok(tins.lines.some((l) => l.po === b.po) && tins.lines.some((l) => l.po === c.po), "both vendors' open lines are offered for the item");

    const mixed = await mod("inward").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", transportMode: NONE }, [
      { po: a.po, poLine: a.lines.Toluene, drums: "1", qty: "5" },
      { po: c.po, poLine: c.lines["1 L Tin Can"], qty: "3" },
    ]);
    assert.ok(!mixed.ok && mixed.fieldErrors?.[0].field === "l1.poLine" && /one vendor/.test(mixed.fieldErrors[0].message), JSON.stringify(mixed));

    const r = await mod("inward").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", transportMode: NONE }, [
      { po: a.po, poLine: a.lines.Toluene, drums: "1", qty: "5" },
      { po: b.po, poLine: b.lines["1 L Tin Can"], qty: "3" },
    ]);
    assert.ok(r.ok, JSON.stringify(r));
    const rows = await db.select().from(erpInward).where(inArray(erpInward.poId, [a.poId, b.poId]));
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((x) => x.prNumber)).size, 1, "one truck, one PR");
    assert.deepEqual(new Set(rows.map((x) => x.poId)), new Set([a.poId, b.poId]));
    const [pa] = await db.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, a.poId));
    const [pb] = await db.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, b.poId));
    assert.equal(pa.status, "Partly received");
    assert.equal(pb.status, "Partly received");
  });
});
