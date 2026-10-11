/**
 * Material returns, end to end, against a real database through the real
 * screen handlers:
 *
 *   vendor:   GRN lot → purchase return → approval (owner above the limit)
 *             → debit note (no stock) → return outward → confirmed (stock minus)
 *   customer: dispatched line → return → inward (quarantine) → credit note
 *             → QC: reuse into the same FG lot, rework into SFG, chemical scrap
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
  appSettings,
  complaints,
  customers,
  erpBatchCodes,
  erpCustomerReturns,
  erpDebitNotes,
  erpFgEntries,
  erpOrderDetails,
  erpOrders,
  erpPurchaseReturns,
  erpPurchases,
  erpRawMaterials,
  erpRmEntries,
  erpSuppliers,
  erpUserPowers,
  finishedGoods,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig } from "@/lib/config/store";
import { erpContext } from "@/lib/erp/access";
import { lineOption, lotOption, returnableLines, returnableLots, returnsSummary } from "@/lib/erp/returns";
import { screenModule } from "@/lib/erp/screens";
import { fgLots, rmLots } from "@/lib/erp/stock";
import { traceCode } from "@/lib/erp/traceability";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const BHW = "erpg_bhiwandi";
const tag = randomUUID().slice(0, 6);

async function makeUser(name: string, level: "associate" | "manager" | "admin") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}@returns.test`, phone: String(9823000000 + Math.floor(Math.random() * 999999)), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
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
async function setting(key: string, value: unknown) {
  await db.insert(appSettings).values({ key, value, valueType: "integer", category: "erp", label: key }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  invalidateConfig();
}
const stockOf = async (lot: string) => (await rmLots()).filter((l) => l.lotNo === lot).reduce((a, l) => a + l.stock, 0);

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;
let head: typeof users.$inferSelect;
let fgId = "";

before(async () => {
  await db.execute(sql`
    truncate users, customers, complaints, erp_suppliers, erp_raw_materials, erp_purchases, erp_rm_entries, erp_user_powers, erp_orders, erp_batch_codes,
             erp_order_details, erp_fg_entries, erp_sfg_entries, erp_sfg_qc, erp_scrap_entries, erp_units, erp_unit_events, erp_purchase_returns,
             erp_debit_notes, erp_return_outwards, erp_customer_returns, erp_return_dispositions, erp_rework_orders, erp_waste_disposals,
             audit_log restart identity cascade`);
  await db.execute(sql`update erp_series set last = 0`);
  await setting("erp.returns.ownerApprovalPaise", 10_000_000);
  admin = await makeUser("Kavita Owner", "admin");
  clerk = await makeUser("Ravi Stores", "associate");
  head = await makeUser("Pooja Head", "manager");
  await db.insert(erpUserPowers).values([
    { userId: head.id, power: "returnApprove", grantedById: admin.id },
    { userId: head.id, power: "returnQc", grantedById: admin.id },
    { userId: head.id, power: "viewPurchaseMoney", grantedById: admin.id },
  ]);

  /* A raw-material lot of 100 L at ₹100 a litre + 18% GST, all on the shelf. */
  await db.insert(erpSuppliers).values({ id: "sup_a", name: "Solvent Supplier A", partyCode: "SA" });
  await db.insert(erpRawMaterials).values({ id: "rm_tol", serialNo: 1, name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical" });
  for (const [pid, lot] of [
    ["pur_a", "SA-TOL-1"],
    ["pur_b", "SA-TOL-2"],
  ])
    await db.insert(erpPurchases).values({ id: pid, prNumber: pid === "pur_a" ? 501 : 502, purchaseDate: "2026-09-01", supplierId: "sup_a", rawMaterialId: "rm_tol", lotNo: lot, quantity: 100, unit: "Litre", godownId: BHW, ratePaise: 10_000, gstBp: 1800, billNumber: "SA/77", source: "manual" } as typeof erpPurchases.$inferInsert);
  await db.insert(erpRmEntries).values([
    { id: id("rme"), sourceType: "purchase", sourceId: "pur_a", entryDate: "2026-09-01", rawMaterialId: "rm_tol", lotNo: "SA-TOL-1", godownId: BHW, quantity: 100 },
    { id: id("rme"), sourceType: "purchase", sourceId: "pur_b", entryDate: "2026-09-01", rawMaterialId: "rm_tol", lotNo: "SA-TOL-2", godownId: BHW, quantity: 100 },
  ]);

  /* A dispatched order line: 10 loose 1 L cans of lot FG9BH at ₹200 a can. */
  const fId = id("form");
  const bId = id("brand");
  fgId = id("fg");
  const sku = id("sku");
  await db.insert(productFormulations).values({ id: fId, name: `RTN Nano ${tag}`, slug: `rtn-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `RTN Nano ${tag}`, slug: `rtn-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values({ id: fgId, name: `RTN Nano 1 L ${tag}`, slug: `rtn-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 1000 });
  await db.insert(products).values({ id: sku, name: `RTN Nano ${tag} - 1 Liter (Loose)`, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 1 });
  await db.insert(customers).values({ id: "cus_r", name: "Return Paints", city: "Pune", phone: "9876500777", kind: "customer" });
  await db.insert(erpFgEntries).values({ id: id("efe"), sourceType: "fill", sourceId: id("fill"), entryDate: "2026-09-02", finishedGoodId: fgId, lotCode: "FG9BH", godownId: BHW, quantity: 30, skuId: sku });
  await db.insert(erpOrders).values({ id: "ord_r", orderNo: 91, orderDate: "2026-09-03", godownId: BHW, billingCustomerId: "cus_r", deliveryCustomerId: "cus_r", skuId: sku, qtyCans: 10, ratePaise: 20_000, tallyBillNo: "MMI/26-27/9", status: "Ready" } as typeof erpOrders.$inferInsert);
  await db.insert(erpBatchCodes).values({ id: id("ebc"), orderId: "ord_r", lotFrom: "fg", lotCode: "FG9BH", finishedGoodId: fgId, godownId: BHW, quantity: 10 });
  await db.insert(erpOrderDetails).values({ orderId: "ord_r", gstBp: 1800, dispatchStatus: "Dispatched", dispatchDate: "2026-09-04" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("vendor side", () => {
  test("a purchase return is linked to its GRN lot and cannot exceed what is there", async () => {
    const lot = (await returnableLots()).find((l) => l.lotNo === "SA-TOL-1")!;
    assert.equal(lot.returnable, 100);
    const c = await as(clerk);
    const over = await mod("vendorReturns").forms!.new(c, { lot: lotOption(lot), date: "2026-10-01", qty: "120", reason: "Quality defect" }, []);
    assert.equal(over.ok, false, "more than the lot received is refused");
    const r = await mod("vendorReturns").forms!.new(c, { lot: lotOption(lot), date: "2026-10-01", qty: "20", reason: "Quality defect", remarks: "Cloudy" }, []);
    assert.ok(r.ok, msg(r));
    const [ret] = await db.select().from(erpPurchaseReturns).where(eq(erpPurchaseReturns.lotNo, "SA-TOL-1"));
    assert.equal(Number(ret.totalPaise), 236_000, "20 L × ₹100 + 18% GST");
    assert.equal(ret.needsOwner, false);
  });

  test("approval issues the debit note and moves no stock; the raiser cannot approve their own", async () => {
    const [ret] = await db.select().from(erpPurchaseReturns).where(eq(erpPurchaseReturns.lotNo, "SA-TOL-1"));
    assert.equal((await mod("vendorReturns").actions!.approve(await as(clerk), ret.id, {})).ok, false);
    const ok = await mod("vendorReturns").actions!.approve(await as(head), ret.id, {});
    assert.ok(ok.ok, msg(ok));
    const [dn] = await db.select().from(erpDebitNotes).where(eq(erpDebitNotes.purchaseReturnId, ret.id));
    assert.equal(dn.status, "issued");
    assert.equal(Number(dn.totalPaise), 236_000);
    assert.equal(await stockOf("SA-TOL-1"), 100, "a debit note is financial only");
  });

  test("stock leaves only when the outward is confirmed, and a reversal gives it back", async () => {
    const [ret] = await db.select().from(erpPurchaseReturns).where(eq(erpPurchaseReturns.lotNo, "SA-TOL-1"));
    const h = await as(head);
    const prep = await mod("vendorReturns").actions!.prepareOutward(h, ret.id, { godown: "Bhiwandi", date: "2026-10-02", transporter: "Shree Roadways", vehicle: "MH04 1234" });
    assert.ok(prep.ok, msg(prep));
    assert.equal(await stockOf("SA-TOL-1"), 100, "a prepared outward changes nothing");
    const conf = await mod("vendorReturns").actions!.confirmOutward(h, ret.id, {});
    assert.ok(conf.ok, msg(conf));
    assert.equal(await stockOf("SA-TOL-1"), 80);
    const rev = await mod("vendorReturns").actions!.reverseOutward(h, ret.id, { reason: "Lorry turned back at the gate" });
    assert.ok(rev.ok, msg(rev));
    assert.equal(await stockOf("SA-TOL-1"), 100);
    assert.ok((await mod("vendorReturns").actions!.prepareOutward(h, ret.id, { godown: "Bhiwandi", date: "2026-10-03" })).ok);
    assert.ok((await mod("vendorReturns").actions!.confirmOutward(h, ret.id, {})).ok);
    assert.equal(await stockOf("SA-TOL-1"), 80);
    const trace = await traceCode("SA-TOL-1");
    assert.ok(trace?.forward.some((f) => f.stage === "Material returns" && f.rows.some((r) => /PRN-1/.test(r.text))), "the lot's trace shows its return");
  });

  test("above the limit the owner approves too, and only the owner", async () => {
    await setting("erp.returns.ownerApprovalPaise", 100_000);
    const lot = (await returnableLots()).find((l) => l.lotNo === "SA-TOL-2")!;
    assert.ok((await mod("vendorReturns").forms!.new(await as(clerk), { lot: lotOption(lot), date: "2026-10-04", qty: "10", reason: "Damaged material" }, [])).ok);
    const [ret] = await db.select().from(erpPurchaseReturns).where(eq(erpPurchaseReturns.lotNo, "SA-TOL-2"));
    assert.ok((await mod("vendorReturns").actions!.approve(await as(head), ret.id, {})).ok);
    assert.equal((await db.select().from(erpDebitNotes).where(eq(erpDebitNotes.purchaseReturnId, ret.id))).length, 0, "no debit note before the owner");
    assert.equal((await mod("vendorReturns").actions!.ownerApprove(await as(head), ret.id, {})).ok, false);
    const own = await mod("vendorReturns").actions!.ownerApprove(await as(admin), ret.id, {});
    assert.ok(own.ok, msg(own));
    assert.equal((await db.select().from(erpDebitNotes).where(eq(erpDebitNotes.purchaseReturnId, ret.id))).length, 1);
    const cancel = await mod("vendorReturns").actions!.cancel(await as(head), ret.id, { reason: "Supplier replaced it instead" });
    assert.ok(cancel.ok, msg(cancel));
    const [dn] = await db.select().from(erpDebitNotes).where(eq(erpDebitNotes.purchaseReturnId, ret.id));
    assert.equal(dn.status, "cancelled", "cancelled with its return, and kept");
    await setting("erp.returns.ownerApprovalPaise", 10_000_000);
  });
});

describe("customer side", () => {
  const fgStock = async () => (await fgLots()).filter((l) => l.lotCode === "FG9BH").reduce((a, l) => a + l.stock, 0);

  test("a return is linked to the dispatched line and cannot exceed what was sent", async () => {
    const line = (await returnableLines()).find((l) => l.lotCode === "FG9BH")!;
    assert.equal(line.sent, 10);
    const c = await as(clerk);
    assert.equal((await mod("customerReturns").forms!.new(c, { line: lineOption(line), date: "2026-10-05", qty: "11", reason: "Quality defect" }, [])).ok, false);
    const r = await mod("customerReturns").forms!.new(c, { line: lineOption(line), date: "2026-10-05", qty: "4", reason: "Quality defect", remarks: "Settled in the can" }, []);
    assert.ok(r.ok, msg(r));
    const [ret] = await db.select().from(erpCustomerReturns);
    assert.equal(Number(ret.totalPaise), 94_400, "4 cans × ₹200 + 18% GST");
  });

  test("received into quarantine, not saleable; the credit note goes to Accounts and moves no stock", async () => {
    const before = await fgStock();
    const [ret] = await db.select().from(erpCustomerReturns);
    const h = await as(head);
    const rec = await mod("customerReturns").actions!.receive(h, ret.id, { qty: "4", godown: "Bhiwandi" });
    assert.ok(rec.ok, msg(rec));
    assert.equal(await fgStock(), before, "quarantine is not FG stock");
    const cn = await mod("customerReturns").actions!.approveCredit(await as(admin), ret.id, {});
    assert.ok(cn.ok, msg(cn));
    const [r2] = await db.select().from(erpCustomerReturns);
    const [cm] = await db.select().from(complaints).where(eq(complaints.id, r2.complaintId!));
    assert.equal(cm.requestCn, true);
    assert.equal(Number(cm.cnAmount), 94_400);
    assert.equal(await fgStock(), before);
  });

  test("QC splits it: 2 reused into the same lot, 1 reworked into SFG, 1 to chemical scrap", async () => {
    const before = await fgStock();
    const [ret] = await db.select().from(erpCustomerReturns);
    const h = await as(head);
    assert.equal((await mod("returnQc").actions!.decide(await as(clerk), ret.id, { kind: "Reusable as is", qty: "2", godown: "Bhiwandi" })).ok, false, "QC needs the power");
    assert.ok((await mod("returnQc").actions!.decide(h, ret.id, { kind: "Reusable as is", qty: "2", godown: "Bhiwandi" })).ok);
    assert.equal(await fgStock(), before + 2, "back into the existing FG lot");
    assert.equal((await mod("returnQc").actions!.decide(h, ret.id, { kind: "Rework", qty: "5", godown: "Bhiwandi" })).ok, false, "more than is left in quarantine");
    assert.ok((await mod("returnQc").actions!.decide(h, ret.id, { kind: "Rework", qty: "1", godown: "Bhiwandi" })).ok);
    assert.ok((await mod("returnQc").actions!.decide(h, ret.id, { kind: "Chemical scrap", qty: "1", godown: "Bhiwandi", scrapKg: "0.9" })).ok);
    const [w] = (await db.execute(sql`select id, sfg_lot_code as lot from erp_rework_orders`)) as unknown as { id: string; lot: string }[];
    assert.equal((await mod("reworkOrders").actions!.complete(h, w.id, { output: "2", operator: "Mixer" })).ok, false, "more out than in is refused");
    const done = await mod("reworkOrders").actions!.complete(h, w.id, { output: "0.8", operator: "Mixer", date: "2026-10-06" });
    assert.ok(done.ok, msg(done));
    const [sfg] = (await db.execute(sql`select quantity::float8 as q from erp_sfg_entries where source_type = 'rework'`)) as unknown as { q: number }[];
    assert.equal(sfg.q, 0.8);
    const [qc] = (await db.execute(sql`select status from erp_sfg_qc where lot_code = ${w.lot}`)) as unknown as { status: string }[];
    assert.equal(qc.status, "Pending", "reworked SFG waits for SFG QC");
    const [scrap] = (await db.execute(sql`select category, quantity::float8 as q from erp_scrap_entries`)) as unknown as { category: string; q: number }[];
    assert.equal(scrap.category, "Chemical Scrap");
    const s = await returnsSummary();
    assert.equal(s.customer.pendingQc, 0);
    assert.equal(s.customer.recoveredLitres, 2.8);
  });

  test("a reuse decision can be reversed while its stock is still there", async () => {
    const before = await fgStock();
    const [ret] = await db.select().from(erpCustomerReturns);
    const rows = (await mod("customerReturns").load(await as(head))).rows;
    const row = rows.find((r) => r.id === ret.id)!;
    const action = row.actions!.find((a) => a.id === "reverseDecision")!;
    const choice = action.prompt!.fields[0].opts!.find((o) => /Reusable/.test(o))!;
    const rev = await mod("customerReturns").actions!.reverseDecision(await as(head), ret.id, { decision: choice, reason: "QC re-tested, it is not fit" });
    assert.ok(rev.ok, msg(rev));
    assert.equal(await fgStock(), before - 2);
  });

  test("every returns screen loads, and the order's trace shows the return", async () => {
    const a = await as(admin);
    for (const k of ["vendorReturns", "debitNotes", "returnOutwards", "customerReturns", "returnQc", "reworkOrders", "wasteDisposals"]) {
      const l = await mod(k).load(a);
      assert.equal(l.spec.screen, k);
    }
    const t = await traceCode("FG9BH");
    assert.ok(t?.forward.some((f) => f.stage === "Material returns"), "the FG lot's trace shows its customer return");
  });
});
