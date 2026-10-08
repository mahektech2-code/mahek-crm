/**
 * ERP purchase — the whole flow, against a real database through the real
 * handlers: requirement → purchase method → vendor / quotation → approval →
 * PO → receipt (goods inward) → testing → register → raw-material stock.
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
  erpInward,
  erpPoLines,
  erpPrCosts,
  erpPurchaseOrders,
  erpPurchases,
  erpQuotations,
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
  await db.execute(
    sql`truncate users, erp_raw_materials, erp_suppliers, erp_inward, erp_tests, erp_purchases, erp_rm_entries, erp_requisitions, erp_quotations, erp_purchase_orders, erp_po_lines, erp_user_powers, erp_godown_staff, erp_user_settings, audit_log restart identity cascade`,
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
    /* The three purchase rules: a price-sensitive chemical on quotation, a routine one direct
       from its default vendor, and cans left to the buyer. */
    { id: "rm_tol", serialNo: 1, name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical", density: 0.87, testingList: ["Smell", "Density"], purchaseMethod: "quotation" },
    { id: "rm_mek", serialNo: 2, name: "MEK", code: "MEK", unit: "Kg", materialType: "Chemical", density: 0.8, testingList: [], purchaseMethod: "direct", preferredSupplierId: "sup_a" },
    { id: "rm_can", serialNo: 3, name: "1 L Tin Can", code: "CAN1", unit: "Unit", materialType: "Can", testingList: [], purchaseMethod: "buyer" },
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

  test("the item's purchase rule decides where a requirement goes the moment it is raised", async () => {
    assert.ok((await raise("Toluene", "Chemical", "400")).ok);
    assert.ok((await raise("MEK", "Chemical", "200")).ok);
    assert.ok((await raise("1 L Tin Can", "Can", "500")).ok);
    assert.equal(await stage("Toluene"), "Collect quotations");
    assert.equal(await stage("MEK"), "Ready for PO", "direct, and its default vendor is offered");
    assert.equal(await stage("1 L Tin Can"), "Buyer decision");
    const mek = await req("rm_mek");
    assert.equal(mek.purchaseRule, "direct");
    assert.equal(mek.supplierId, "sup_a");
    assert.equal(mek.unit, "Kg", "a requirement is counted in the item's own purchase unit");
    assert.equal((await req("rm_can")).unit, "Pcs");
  });

  test("a requirement needs its date and department; finished goods are never bought", async () => {
    const c = await as(clerk);
    const noDate = await mod("requisitions").forms!.new(c, { date: TODAY, department: "Production Head", godown: "Bhiwandi", type: "Chemical", item: "MEK", required: "1", priority: "Medium" }, []);
    assert.ok(!noDate.ok && noDate.fieldErrors?.[0].field === "requiredBy");
    const fg = await mod("requisitions").forms!.new(c, { date: TODAY, requiredBy: TODAY, department: "Production Head", godown: "Bhiwandi", type: "Finish Good", item: "MEK", required: "1", priority: "Medium" }, []);
    assert.ok(!fg.ok && fg.fieldErrors?.[0].field === "type");
  });

  test("only the buyer decides a Buyer-decision requirement, and direct then asks for a vendor", async () => {
    const can = await req("rm_can");
    const refused = await mod("requisitions").actions!.decide(await as(clerk), can.id, { method: "Direct purchase" });
    assert.ok(!refused.ok && refused.code === "not_permitted");
    assert.ok((await mod("requisitions").actions!.decide(await as(admin), can.id, { method: "Direct purchase", note: "Same tins as always" })).ok);
    assert.equal(await stage("1 L Tin Can"), "Select vendor");
    assert.ok((await mod("requisitions").actions!.vendor(await as(clerk), can.id, { vendor: "Asian Solvents" })).ok);
    assert.equal(await stage("1 L Tin Can"), "Ready for PO");
  });

  test("a quotation item cannot skip its quotations, and the lowest landed cost wins unless somebody says why", async () => {
    const a = await as(admin);
    const tol = await req("rm_tol");
    const label = (await mod("quotations").load(a)).spec.newForm!.header.find((f) => f.k === "requirement")!.opts![0];
    /* Not ready for a PO until a quotation is selected — direct vendor selection is refused. */
    assert.ok(!(await mod("requisitions").actions!.vendor(a, tol.id, { vendor: "Asian Solvents" })).ok);
    const q1 = await mod("quotations").forms!.new(a, { requirement: label, vendor: "Asian Solvents", date: TODAY, rate: "100", gst: "18", deliveryDays: "5", terms: "30 days credit" }, []);
    assert.ok(q1.ok, JSON.stringify(q1));
    const [first] = await db.select().from(erpQuotations);
    const early = await mod("quotations").actions!.select(a, first.id, {});
    assert.ok(!early.ok && /At least 2/.test(early.error), "two quotations before one is selected");
    const dup = await mod("quotations").forms!.new(a, { requirement: label, vendor: "Asian Solvents", date: TODAY, rate: "99", gst: "18" }, []);
    assert.ok(!dup.ok && dup.fieldErrors?.[0].field === "vendor", "one quotation per vendor");
    /* Bharat quotes a lower rate, but its freight makes it dearer landed. */
    assert.ok((await mod("quotations").forms!.new(a, { requirement: label, vendor: "Bharat Chemicals", date: TODAY, rate: "95", gst: "18", freight: "5000" }, [])).ok);
    assert.equal(await stage("Toluene"), "Compare quotations");
    const { rows } = await mod("quotations").load(a);
    const bharat = rows.find((r) => r.v.vendor === "Bharat Chemicals")!;
    assert.deepEqual(rows.find((r) => r.v.vendor === "Asian Solvents")!.flags, ["lowestQuote"]);
    const why = await mod("quotations").actions!.select(a, bharat.id, {});
    assert.ok(!why.ok && why.fieldErrors?.[0].field === "note", "not the lowest — say why");
    assert.ok((await mod("quotations").actions!.select(a, first.id, {})).ok);
    const after = await req("rm_tol");
    assert.equal(after.supplierId, "sup_a");
    assert.equal(after.quotationId, first.id);
    assert.equal(await stage("Toluene"), "Ready for PO");
  });

  test("a clerk without purchase money cannot add a quotation or raise a PO", async () => {
    const c = await as(clerk);
    const r = await mod("quotations").forms!.new(c, { requirement: "x", vendor: "Asian Solvents", date: TODAY, rate: "1", gst: "18" }, []);
    assert.ok(!r.ok && r.code === "not_permitted");
    const po = await mod("purchaseOrders").forms!.new(c, { vendor: "Asian Solvents" }, []);
    assert.ok(!po.ok && po.code === "not_permitted");
  });

  test("the PO is raised from the vendor's ready requirements, at the quotation's rate", async () => {
    await db.execute(sql`insert into erp_user_powers (user_id, power) values (${clerk.id}, 'viewPurchaseMoney'), (${clerk.id}, 'approvePurchaseOrder') on conflict do nothing`);
    const c = await as(clerk);
    const mek = await req("rm_mek");
    const form = await mod("requisitions").formLoaders!.createPo(c, mek.id);
    assert.ok(form);
    assert.equal(form!.init!.vendor, "Asian Solvents");
    assert.equal(form!.initLines!.length, 3, "every requirement ready for this vendor comes onto the PO");
    const lines = form!.initLines!.map((l) => ({ ...l, requirement: l.requirement ?? "", rate: l.rate || "90" }));
    const tolLine = lines.findIndex((l) => l.requirement.startsWith("Toluene"));
    assert.equal(lines[tolLine].rate, "100", "the quotation's rate");
    const h = { date: TODAY, vendor: "Asian Solvents", deliverTo: "Bhiwandi", deliveryDate: "2026-09-25", terms: "30 days credit" };
    const off = await mod("purchaseOrders").forms!.new(c, h, lines.map((l, i) => (i === tolLine ? { ...l, rate: "110" } : l)));
    assert.ok(!off.ok && off.fieldErrors?.[0].field === `l${tolLine}.rate`, "the PO keeps the selected quotation's rate");
    const made = await mod("purchaseOrders").forms!.new(c, h, lines.map((l) => (l.requirement.startsWith("1 L") ? { ...l, rate: "10" } : l)));
    assert.ok(made.ok, JSON.stringify(made));
    const [po] = await db.select().from(erpPurchaseOrders);
    assert.equal(po.poNumber, 1);
    assert.equal(po.status, "Pending approval");
    assert.equal((await db.select().from(erpPoLines)).length, 3);
    assert.equal(await stage("Toluene"), "PO awaiting approval");
    const twice = await mod("purchaseOrders").forms!.new(c, h, lines);
    assert.ok(!twice.ok, "a requirement is on one PO");
  });

  test("nothing is received against a PO awaiting approval, and nobody approves their own", async () => {
    const [po] = await db.select().from(erpPurchaseOrders);
    const gate = await mod("inward").forms!.new(await as(admin), { date: TODAY, po: `PO-1 · Asian Solvents`, godown: "Bhiwandi", transportMode: NONE }, [{ poLine: "1. Toluene", qty: "1" }]);
    assert.ok(!gate.ok && gate.fieldErrors?.[0].field === "po");
    const sent = await mod("purchaseOrders").actions!.send(await as(admin), po.id, { via: "WhatsApp" });
    assert.ok(!sent.ok, "a PO is approved before it is sent");
    const own = await mod("purchaseOrders").actions!.approve(await as(clerk), po.id, {});
    assert.ok(!own.ok && own.code === "not_permitted");
    assert.ok((await mod("purchaseOrders").actions!.approve(await as(admin), po.id, { note: "OK" })).ok);
    assert.equal((await req("rm_tol")).status, "Order Placed");
  });

  test("sending the PO records how, and hands back the PO written out for the vendor", async () => {
    const [po] = await db.select().from(erpPurchaseOrders);
    const r = await mod("purchaseOrders").actions!.send(await as(clerk), po.id, { via: "WhatsApp" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = (r.data as ToolResult).dialog!;
    assert.match(d.text!, /PURCHASE ORDER PO-1/);
    assert.match(d.open!.href, /^https:\/\/wa\.me\/919820012345\?text=/);
    const [after] = await db.select().from(erpPurchaseOrders);
    assert.equal(after.status, "Sent");
    assert.equal(after.sentVia, "WhatsApp");
    assert.equal(await stage("Toluene"), "PO sent");
    const { spec } = await mod("inward").load(await as(admin));
    flowPo = spec.newForm!.header.find((f) => f.k === "po")!.opts![0];
    assert.equal(flowPo, "PO-1 · Asian Solvents");
    for (const key of Object.keys(spec.newForm!.data!.pendingOf as object)) {
      const line = key.split("|")[1];
      flowLine[line.replace(/^\d+\. /, "")] = line;
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
    assert.equal(regs[0].ratePaise, 10000, "at the selected quotation's rate");
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

describe("after the PO: sending back, cancelling, closing short", () => {
  const raiseMek = async () =>
    mod("requisitions").forms!.new(await as(admin), { date: TODAY, requiredBy: "2026-10-30", department: "Production Head", godown: "Bhiwandi", type: "Chemical", item: "MEK", required: "50", priority: "Urgent" }, []);
  const openMek = async () => (await db.select().from(erpRequisitions).where(sql`raw_material_id = 'rm_mek' and status = 'Pending' and required_by = '2026-10-30'`))[0];
  const raisePo = async (reqId: string) => {
    const a = await as(admin);
    const f = (await mod("requisitions").formLoaders!.createPo(a, reqId))!;
    const lines = f.initLines!.map((l) => ({ requirement: l.requirement ?? "", qty: l.qty ?? "", rate: "90", gst: "18" }));
    const r = await mod("purchaseOrders").forms!.new(a, { date: TODAY, vendor: "Asian Solvents", deliverTo: "Bhiwandi", deliveryDate: TODAY, terms: "Advance" }, lines);
    assert.ok(r.ok, JSON.stringify(r));
    return (r.data as { id: string }).id;
  };
  const stageOf = async (id: string) => (await mod("requisitions").load(await as(admin))).rows.find((r) => r.id === id)!.v.stage;

  test("a PO sent back frees its requirements for a corrected one, and needs a reason", async () => {
    assert.ok((await raiseMek()).ok);
    const req = await openMek();
    const po = await raisePo(req.id);
    const a = await as(admin);
    assert.ok(!(await mod("purchaseOrders").actions!.sendBack(a, po, {})).ok);
    assert.ok((await mod("purchaseOrders").actions!.sendBack(a, po, { reason: "Wrong delivery date" })).ok);
    assert.equal(await stageOf(req.id), "Ready for PO");
  });

  test("a cancelled PO frees its requirements too; a requirement on a live PO cannot be cancelled", async () => {
    const req = await openMek();
    const po = await raisePo(req.id);
    const a = await as(admin);
    const blocked = await mod("requisitions").actions!.cancel(a, req.id, { reason: "Not needed" });
    assert.ok(!blocked.ok, "it is on a PO");
    assert.ok((await mod("purchaseOrders").actions!.approve(a, po, {})).ok);
    assert.ok((await mod("purchaseOrders").actions!.cancel(a, po, { reason: "Vendor out of stock" })).ok);
    assert.equal(await stageOf(req.id), "Ready for PO");
    assert.ok((await mod("requisitions").actions!.cancel(a, req.id, { reason: "Bought from the market" })).ok);
    assert.equal(await stageOf(req.id), "Cancelled");
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
    assert.equal(rows[1].purchaseRule, "direct", "each item copies its own rule");
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
