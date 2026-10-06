/**
 * ERP phase 6b — the reading features, tested on the RULES' half with a
 * reading supplied by the test, so no model is ever called: supplier bills
 * (AI-1), orders from messages (AI-2), Ask the ERP's tools (AI-5), LR and test
 * photos (AI-8), and the complaint review (AI-6). Also: with no provider key,
 * every reading feature says it is unavailable rather than failing.
 *
 *   npm run test:integration
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  customers,
  erpAiSuggestions,
  erpCustomerProfiles,
  erpOrderInbox,
  erpOrders,
  erpProductPacking,
  erpPurchases,
  erpRawMaterials,
  complaints,
  erpSuppliers,
  erpTests,
  erpTransports,
  finishedGoods,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { createComplaint } from "@/lib/services/complaint-create";
import { erpContext } from "@/lib/erp/access";
import { featureState, logSuggestion } from "@/lib/erp/ai";
import { askTools } from "@/lib/erp/ai-ask";
import { applyBill, billReviewForm, recordBillReading } from "@/lib/erp/ai-bills";
import { applyComplaint } from "@/lib/erp/ai-complaints";
import { draftForm, recordDraft } from "@/lib/erp/ai-orders";
import { applyLr, lrReviewForm, recordLrReading, recordTestReading, testReviewForm } from "@/lib/erp/ai-photos";
import { screenModule } from "@/lib/erp/screens";
import { approvedPoLine } from "@/lib/erp/po-fixture";

const poFor = async (item: string, qty: number) => {
  const p = await approvedPoLine("Asian Solvents", item, qty);
  return { po: p.po, poLine: p.poLine };
};
import { orderForm } from "@/lib/erp/screens/sales";
import { rmLotStock } from "@/lib/erp/stock";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const tag = randomUUID().slice(0, 6);
const LOOSE = `ERPR NC Thinner ${tag} - 1 Liter (Loose)`;
const BOXED = `ERPR NC Thinner ${tag} - 1 Liter (24 Can/Box)`;

async function makeUser(name: string, level: "associate" | "admin") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}@erp.test`, phone: String(9820000000 + Math.floor(Math.random() * 999999)), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "erp", role: level });
  return u;
}
async function as(u: typeof users.$inferSelect) {
  setTestUser(u);
  return erpContext();
}
const mod = (k: string) => screenModule(k)!;
const ok = async (p: Promise<{ ok: boolean }>) => {
  const r = await p;
  assert.ok(r.ok, JSON.stringify(r));
  return r;
};

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;
let boxedId = "";

before(async () => {
  await db.execute(sql`
    truncate users, customers, erp_customer_profiles, erp_raw_materials, erp_suppliers, erp_inward, erp_tests, erp_purchases, erp_rm_entries,
             erp_orders, erp_batch_codes, erp_order_details, erp_transports, erp_requests, erp_followups, erp_ai_suggestions,
             erp_order_inbox, erp_user_powers, erp_godown_staff, erp_user_settings, audit_log restart identity cascade`);
  await db.execute(sql`update erp_series set last = 0`);
  admin = await makeUser("Kavita Admin", "admin");
  clerk = await makeUser("Deepa Clerk", "associate");
  await db.insert(erpSuppliers).values({ id: "sup_a", name: "Asian Solvents", partyCode: "AS", gstin: "27ABCDE1234F1Z5" });
  await db.insert(erpRawMaterials).values([
    { id: "rm_tol", serialNo: 1, name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical", density: 0.87, testingList: ["Density"] },
    { id: "rm_mek", serialNo: 2, name: "Methyl Ethyl Ketone", code: "MEK", unit: "Litre", materialType: "Chemical", density: 0.8, testingList: [] },
  ]);
  const fId = id("form");
  const bId = id("brand");
  const fgId = id("fg");
  boxedId = id("sku");
  await db.insert(productFormulations).values({ id: fId, name: `ERPR NC ${tag}`, slug: `erpr-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `ERPR ${tag}`, slug: `erpr-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values({ id: fgId, name: `ERPR NC Thinner 1 L ${tag}`, slug: `erpr-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 1000 });
  const looseId = id("sku");
  await db.insert(products).values([
    { id: looseId, name: LOOSE, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 1 },
    { id: boxedId, name: BOXED, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 24 },
  ]);
  await db.insert(erpProductPacking).values([
    { productId: looseId, emptyBoxesRequired: 0 },
    { productId: boxedId, emptyBoxesRequired: 1, boxType: "Empty Box 1 Liter" },
  ]);
  await db.insert(customers).values({ id: "cus_shree", name: "Shree Paints", city: "Pune", phone: "9876500001", whatsappPhone: "9876500001", kind: "customer" });
  await db.insert(erpCustomerProfiles).values({ customerId: "cus_shree", transporter: "VRL Logistics" });

  const a = await as(admin);
  /* An earlier purchase at ₹100, then PR 2 with two unrated rows. */
  await ok(mod("register").forms!.new(a, { pr: "1", date: "2026-08-01", ...(await poFor("Toluene", 100)), qty: "100", unit: "Litre", rate: "100", gst: "18", company: "Mahek Marketing India", godown: "Bhiwandi" }, []));
  await ok(mod("register").forms!.new(a, { pr: "2", date: "2026-09-01", ...(await poFor("Toluene", 200)), qty: "200", unit: "Litre", gst: "18", company: "Mahek Marketing India", godown: "Bhiwandi" }, []));
  await ok(mod("register").forms!.new(a, { pr: "2", date: "2026-09-01", ...(await poFor("Methyl Ethyl Ketone", 50)), qty: "50", unit: "Litre", gst: "18", company: "Mahek Marketing India", godown: "Bhiwandi" }, []));
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("absent when unavailable (AI PRD §1.6)", () => {
  test("with no provider key, a reading feature says so instead of failing", async () => {
    const s = await featureState("bills", true);
    assert.equal(s.on, false);
    assert.ok(!s.on && /OpenAI key/.test(s.reason));
    const a = await as(admin);
    const { rows } = await mod("register").load(a);
    assert.ok(rows.every((r) => !(r.actions ?? []).some((x) => x.id === "aiBillRead")), "no Read supplier bill button without a key");
  });
});

describe("supplier bill reading (AI-1)", () => {
  test("a reading is matched to the PR's rows and flagged, and applying it rates them into stock", async () => {
    const a = await as(admin);
    const [anchor] = await db.select().from(erpPurchases).where(eq(erpPurchases.lotNo, "ASTOL2"));
    const res = await recordBillReading(
      a,
      anchor,
      {
        supplierName: "Asian Solvents Pvt Ltd",
        supplierGstin: "27 ABCDE 1234 F1Z5",
        billNo: "AS/901",
        billDate: "2026-09-02",
        billNoConfidence: "high",
        billDateConfidence: "check",
        lines: [
          { description: "TOLUENE", quantity: 210, unit: "ltr", rate: 130, gstPercent: 18, amount: 27300, confidence: "high" },
          { description: "MEK (Methyl Ethyl Ketone)", quantity: 50, unit: "ltr", rate: 90, gstPercent: 12, amount: 4500, confidence: "check" },
        ],
        billTotal: 31800,
        freight: null,
      },
      [],
      "test",
    );
    assert.ok(res.ok);
    const form = (await billReviewForm(anchor.id))!;
    assert.deepEqual(form.initLines?.map((l) => [l.lot, l.qty, l.rate, l.gst]), [["ASTOL2", "210", "130", "18"], ["ASMEK2", "50", "90", "12"]]);
    const flags = form.evidence!.flags!.map((f) => f.text).join(" | ");
    assert.match(flags, /bill says 210, the register 200/);
    assert.match(flags, /rate ₹130 against last ₹100/);
    assert.match(flags, /GST 12%, not 18%/);
    assert.equal(form.header.find((f) => f.k === "billDate")?.conf, "check");

    /* The person corrects the quantity back to 200 and saves. */
    const lines = form.initLines!.map((l) => (l.lot === "ASTOL2" ? { ...l, qty: "200" } : l));
    await ok(applyBill(a, form.recordId!, { billNo: "AS/901", billDate: "2026-09-02" }, lines));
    const [tol] = await db.select().from(erpPurchases).where(eq(erpPurchases.lotNo, "ASTOL2"));
    assert.equal(tol.ratePaise, 13000);
    assert.equal(tol.billNumber, "AS/901");
    assert.equal(tol.aiFilled, true);
    assert.equal(await rmLotStock("ASTOL2", "erpg_bhiwandi"), 200, "rated through the register's own rule, so it posts");
    const [s] = await db.select().from(erpAiSuggestions).where(eq(erpAiSuggestions.id, form.recordId!));
    assert.equal(s.outcome, "edited", "the correction is logged");
  });

  test("the same bill number on another PR is flagged", async () => {
    const a = await as(admin);
    const [one] = await db.select().from(erpPurchases).where(eq(erpPurchases.lotNo, "ASTOL1"));
    await recordBillReading(a, one, { supplierName: null, supplierGstin: null, billNo: "AS/901", billDate: null, billNoConfidence: "high", billDateConfidence: "not found", lines: [], billTotal: null, freight: null }, [], "test");
    const form = (await billReviewForm(one.id))!;
    assert.ok(form.evidence!.flags!.some((f) => f.tone === "danger" && /already recorded/.test(f.text)));
  });
});

describe("orders from messages (AI-2)", () => {
  test("the sender's number finds the customer, what they bought before breaks a tie, and peti become cans", async () => {
    const a = await as(admin);
    await db.insert(erpOrders).values({ id: "ODID-PAST", orderNo: 999, orderDate: "2026-08-01", godownId: "erpg_bhiwandi", billingCustomerId: "cus_shree", deliveryCustomerId: "cus_shree", skuId: boxedId, qtyCans: 24 });
    const r = await recordDraft(a, "Bhai 2 peti NC 1 ltr bhejo kal", { looksLikeOrder: true, customerName: null, deliveryName: null, transporter: null, remark: "Send tomorrow", lines: [{ mention: "NC 1 ltr", quantity: 2, unit: "peti" }] }, { source: "paste", sender: "+91 98765 00001" }, "test");
    assert.ok(r.ok);
    const d = r.ok ? r.data.draft! : null;
    assert.equal(d?.customerName, "Shree Paints");
    assert.equal(d?.lines[0].sku, BOXED);
    assert.equal(d?.lines[0].qty, 48);
    const base = await orderForm(a);
    const form = (await draftForm(base, r.ok ? r.data.id : ""))!;
    assert.equal(form.init?.billing, "Shree Paints");
    await ok(mod("orders").forms!.new(a, { ...form.init, godown: "Bhiwandi", date: "2026-09-20" } as Record<string, string>, form.initLines!));
    const [inbox] = await db.select().from(erpOrderInbox).where(eq(erpOrderInbox.id, r.ok ? r.data.id : ""));
    assert.equal(inbox.status, "Converted");
    assert.ok(inbox.orderNo);
  });

  test("an unknown sender and an unclear product are left for the person to choose", async () => {
    const a = await as(admin);
    const r = await recordDraft(a, "need thinner", { looksLikeOrder: true, customerName: null, deliveryName: null, transporter: null, remark: null, lines: [{ mention: "NC thinner 1 ltr", quantity: 10, unit: "can" }] }, { source: "paste", sender: "9000000000" }, "test");
    const d = r.ok ? r.data.draft! : null;
    assert.equal(d?.customerId, null);
    assert.equal(d?.lines[0].sku, null);
    assert.ok((d?.lines[0].choices.length ?? 0) >= 2, "both 1 L SKUs are offered, neither is picked");
  });
});

describe("LR and test photos (AI-8)", () => {
  test("an LR reading is checked against the bill's transporter, and saving records it", async () => {
    const a = await as(admin);
    await db.insert(erpTransports).values({ id: "tr_1", orderNo: 1, billingCustomerId: "cus_shree", transporter: "VRL Logistics", billDate: "2026-09-10" });
    await db.insert(erpTransports).values({ id: "tr_2", orderNo: 2, billingCustomerId: "cus_shree", transporter: "VRL Logistics", lrNo: "LR-500" });
    const [t] = await db.select().from(erpTransports).where(eq(erpTransports.id, "tr_1"));
    await recordLrReading(a, t, { lrNo: "LR-500", lrConfidence: "high", transporter: "Gati Ltd", date: "2026-09-10" }, "att_x", "test");
    const form = (await lrReviewForm("pendingLr", "tr_1"))!;
    const flags = form.evidence!.flags!.map((f) => f.text).join(" | ");
    assert.match(flags, /from "Gati Ltd", but the bill goes by VRL Logistics/);
    assert.match(flags, /LR-500 is already recorded on order 2/);
    const dup = await applyLr(a, form.recordId!, { lr: "LR-500" });
    assert.ok(!dup.ok, "a used LR is refused on save too");
    await ok(applyLr(a, form.recordId!, { lr: "LR-501" }));
    const [after] = await db.select().from(erpTransports).where(eq(erpTransports.id, "tr_1"));
    assert.equal(after.lrNo, "LR-501");
  });

  test("a density far from the master is flagged, and the test's verification is untouched", async () => {
    const a = await as(admin);
    await db.insert(erpTests).values({ id: "tst_1", prNumber: 2, rawMaterialId: "rm_tol", godownId: "erpg_bhiwandi", tests: ["Density"], testingDate: "2026-09-02", densityPhotoId: null });
    const [t] = await db.select().from(erpTests).where(eq(erpTests.id, "tst_1"));
    await recordTestReading(a, t, { density: 0.95, densityConfidence: "high", ph: null, phConfidence: "not found", observation: "Uniform film, no patches visible." }, [], "test");
    const base = { screen: "testing", id: "edit", title: "x", submit: "Save", init: { remark: "" }, header: [{ k: "density", l: "Density value", t: "num" as const }, { k: "remark", l: "Remark", t: "area" as const }] };
    const form = (await testReviewForm(base, "tst_1"))!;
    assert.equal(form.init?.density, "0.95");
    assert.match(form.init?.remark ?? "", /Uniform film/);
    assert.ok(form.evidence!.flags!.some((f) => /more than 3% from Toluene's master density 0.87/.test(f.text)));
    const [still] = await db.select().from(erpTests).where(eq(erpTests.id, "tst_1"));
    assert.equal(still.decidedAt, null, "the AI never decides a test");
  });
});

describe("complaint review (AI-6)", () => {
  test("a confirmed suggestion sets the type, and the summary is kept with it", async () => {
    const a = await as(admin);
    /* The complaint is the CRM's own record, so the confirmed type is the category the telecaller sees too. */
    await createComplaint({ id: "req_1", customerId: "cus_shree", loggedById: a.user.id, loggedByName: a.user.name, category: "Other", description: "Two cans came dented" });
    const sid = await logSuggestion({ feature: "complaints", recordType: "complaint", recordId: "req_1", proposed: { type: "Leakage / Packaging", summary: "Two cans arrived dented." }, confidence: { type: "high" }, userId: a.user.id });
    await ok(applyComplaint(a, sid, { type: "Leakage / Packaging", summary: "Two cans arrived dented." }));
    const [r] = await db.select().from(complaints).where(eq(complaints.id, "req_1"));
    assert.equal(r.category, "packaging_damage");
    const [s] = await db.select().from(erpAiSuggestions).where(eq(erpAiSuggestions.id, sid));
    assert.equal(s.outcome, "accepted");
  });
});

describe("Ask the ERP's tools (AI-5)", () => {
  test("a tool answers with the person's own screen: a clerk gets the rows without their rates", async () => {
    const c = await as(clerk);
    const records: { label: string; href: string }[] = [];
    const tools = askTools(c, records);
    const res = (await tools.purchases.execute!({ match: "toluene" }, { toolCallId: "t1", messages: [] } as never)) as { rows: Record<string, unknown>[]; hiddenFromThisPerson: string[] };
    assert.ok(res.rows.length >= 2);
    assert.ok(res.rows.every((r) => !("rate" in r) && !("final" in r)));
    assert.ok(res.hiddenFromThisPerson.includes("Rate"));
    assert.ok(records[0].href.startsWith("/erp/register?view=register&f="), records[0].href);
  });
});
