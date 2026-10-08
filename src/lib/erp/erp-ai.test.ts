/**
 * ERP phase 6a — the dashboard, unusual-activity alerts, the batch trace and
 * suggested re-order levels, against a real database through the real
 * handlers.
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
  customers,
  erpAlerts,
  erpCustomerProfiles,
  erpOrders,
  erpProductPacking,
  erpPurchases,
  erpRawMaterials,
  erpRmLevels,
  erpSuppliers,
  finishedGoods,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { runErpAlerts, visibleAlerts } from "@/lib/erp/alerts";
import { dashboardSections } from "@/lib/erp/dashboard";
import { addDaysIso } from "@/lib/erp/engines/sales";
import { screenModule } from "@/lib/erp/screens";
import { approvedPoLine } from "@/lib/erp/po-fixture";
import { today } from "@/lib/erp/screens/common";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const tag = randomUUID().slice(0, 6);
const SFG = `ERPA Thinner ${tag}`;
const FG = `ERPA Thinner 1 L ${tag}`;
const SKU = `ERPA Thinner ${tag} - 1 Liter (Loose)`;
const T = today();
const ago = (n: number) => addDaysIso(T, -n);

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
const mod = (k: string) => {
  const m = screenModule(k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;
const orderIds: string[] = [];

async function ok(p: Promise<{ ok: boolean }>) {
  const r = await p;
  assert.ok(r.ok, JSON.stringify(r));
}

before(async () => {
  await db.execute(sql`
    truncate users, customers, erp_customer_profiles, erp_raw_materials, erp_suppliers, erp_inward, erp_tests, erp_purchases, erp_rm_entries,
             erp_sfg_lines, erp_sfg_entries, erp_fg_fills, erp_fg_entries, erp_pack_lines, erp_pack_entries, erp_transfers,
             erp_rm_levels, erp_fg_levels, erp_orders, erp_batch_codes, erp_order_details, erp_transports, erp_requests,
             erp_followups, erp_credits, erp_expenses, erp_alerts, erp_user_powers, erp_godown_staff, erp_user_settings, erp_sfg_qc, erp_units, erp_unit_events,
             audit_log restart identity cascade`);
  await db.execute(sql`update erp_series set last = 0`);
  admin = await makeUser("Kavita Admin", "admin");
  clerk = await makeUser("Deepa Clerk", "associate");
  await db.insert(erpSuppliers).values({ id: "sup_a", name: "Asian Solvents", partyCode: "AS" });
  await db.insert(erpRawMaterials).values([
    { id: "rm_tol", serialNo: 1, name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical", density: 0.87, testingList: [] },
    { id: "rm_can", serialNo: 2, name: "Tin can 1L", code: "CAN1", unit: "Unit", materialType: "Can", testingList: [], pricePaise: 1000 },
  ]);
  const fId = id("form");
  const bId = id("brand");
  const fgId = id("fg");
  const skuId = id("sku");
  await db.insert(productFormulations).values({ id: fId, name: SFG, slug: `erpa-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `ERPA ${tag}`, slug: `erpa-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values({ id: fgId, name: FG, slug: `erpa-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 1000 });
  await db.insert(products).values({ id: skuId, name: SKU, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 1 });
  await db.insert(erpProductPacking).values({ productId: skuId, canUseMaterialId: "rm_can", emptyBoxesRequired: 0 });
  await db.insert(customers).values({ id: "cus_shree", name: "Shree Paints", city: "Pune", phone: "9876500001", kind: "customer", freightTerm: "Paid" });
  await db.insert(erpCustomerProfiles).values({ customerId: "cus_shree", transporter: "VRL" });

  const a = await as(admin);
  const buy = async (pr: string, date: string, item: string, qty: string, unit: string, rate: string) => {
    const po = await approvedPoLine("Asian Solvents", item, Number(qty));
    return ok(mod("register").forms!.new(a, { pr, date, po: po.po, poLine: po.poLine, qty, unit, rate, gst: "18", company: "Mahek Marketing India", godown: "Bhiwandi" }, []));
  };
  await buy("1", ago(40), "Toluene", "500", "Litre", "100");
  await buy("2", ago(30), "Toluene", "500", "Litre", "102");
  await buy("3", ago(20), "Toluene", "500", "Litre", "150");
  await buy("4", ago(20), "Tin can 1L", "300", "Pcs", "10");

  /* The whole chain, through the real handlers: SFG → fill → three orders dispatched on one bill. */
  await ok(mod("sfgBatches").forms!.new(a, { date: ago(15), godown: "Bhiwandi", product: SFG, batches: "1" }, [{ item: "Toluene", lot: "ASTOL1", qty: "200" }]));
  const [sfgLine] = await db.execute(sql`select id from erp_sfg_lines limit 1`) as unknown as { id: string }[];
  await ok(mod("sfgBatches").actions!.qcApprove(a, sfgLine.id, {}));
  await ok(mod("fgFill").forms!.new(a, { date: ago(14), godown: "Bhiwandi", sfg: SFG, sfgLot: "1ASTOL1", fg: FG, size: "1", canUse: "Tin can 1L", cans: "150" }, []));
  for (const [i, qty] of [10, 11, 12].entries()) {
    await ok(mod("orders").forms!.new(a, { date: ago(10 - i), godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: SKU, qty: String(qty), rate: "300" }]));
    const [o] = await db.select().from(erpOrders).where(eq(erpOrders.qtyCans, qty));
    orderIds.push(o.id);
    await ok(mod("orders").actions!.ready(a, o.id, {}));
    await ok(mod("orders").forms!.allocate(a, { lot: "FG1BH", qty: String(qty) }, [], o.id));
    await ok(mod("orders").forms!.edit(a, { status: "Ready", delivery: "Shree Paints", qty: String(qty), rate: "300", bill: `MMI/${qty}`, transport: "0" }, [], o.id));
    await ok(mod("orders").actions!.bill(a, o.id, {}));
    await ok(mod("orderDetails").actions!.verify(a, o.id, { date: ago(8 - i) }));
  }
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("alerts (AI-4)", () => {
  test("an alert is raised once, however often the checks run, and only its power sees money alerts", async () => {
    const first = await runErpAlerts();
    assert.ok(first.raised > 0);
    const second = await runErpAlerts();
    assert.equal(second.raised, 0, "the same condition never raises two open alerts");
    const kinds = (await db.select().from(erpAlerts)).map((a) => a.kind);
    assert.ok(kinds.includes("rateJump"), "₹150 against a median of ₹101");
    assert.ok(kinds.includes("lrMissing"), "bills dispatched days ago without an LR");
    const c = await as(clerk);
    const seen = await visibleAlerts(c.screens, c.powers);
    assert.ok(!seen.some((a) => a.kind === "rateJump"), "a rate jump needs purchase money");
    assert.ok(seen.some((a) => a.kind === "lrMissing"));
  });

  test("an alert resolves itself once its condition clears", async () => {
    const a = await as(admin);
    const lr = (await db.select().from(erpAlerts).where(eq(erpAlerts.kind, "lrMissing")))[0];
    await ok(mod("pendingLr").actions!.update(a, lr.subject, { lr: "LR-1", stage: "In Transit" }));
    const [p] = await db.select().from(erpPurchases).where(eq(erpPurchases.lotNo, "ASTOL3"));
    await ok(mod("register").actions!.rate(a, p.id, { rate: "101" }));
    const r = await runErpAlerts();
    assert.ok(r.resolved >= 2);
    const [again] = await db.select().from(erpAlerts).where(eq(erpAlerts.id, lr.id));
    assert.equal(again.status, "Resolved");
    assert.equal(again.resolveReason, "Condition cleared");
  });
});

describe("batch trace and complaint clusters (AI-6)", () => {
  test("a request's trace runs from the bill back to the supplier, and three on one lot flag a batch problem", async () => {
    /* The bills a credit note names are MahekOne's own; with the ERP not yet
       taking the orders, they are the ones the sheet wrote for these orders. */
    for (const qty of [10, 11, 12]) await db.execute(sql`insert into bills (id, customer_id, bill_no, bill_date, amount, payment_position) values (${`bil_mmi${qty}`}, 'cus_shree', ${`MMI/${qty}`}, '2026-09-01', 100000, 'stated')`);
    const c = await as(clerk);
    for (const qty of [10, 11, 12]) await ok(mod("requests").forms!.new(c, { customer: "Shree Paints", type: "Leakage", description: "Leaking", cn: "Yes", bill: `MMI/${qty}`, goods: SKU }, []));
    const a = await as(admin);
    const { rows } = await mod("requests").load(a);
    const panel = rows[0].panel as { kind: string; data: { steps: { stage: string }[]; cluster: { count: number } | null; people: string[] } };
    assert.equal(panel.kind, "trace");
    assert.deepEqual(panel.data.steps.map((s) => s.stage), ["Bill", "Lots dispatched", "FG filling", "SFG batch", "Raw material", "Purchase test"]);
    assert.equal(panel.data.cluster?.count, 3, "three complaints share FG1BH, 1ASTOL1 and ASTOL1");
    assert.deepEqual(panel.data.people, ["Kavita Admin"]);
  });
});

describe("suggested levels (AI-7)", () => {
  test("a level's suggestion is cover days of recent use, applied only when a person presses it", async () => {
    const a = await as(admin);
    await ok(mod("rmLevels").forms!.new(a, { godown: "Bhiwandi", type: "Chemical", item: "Toluene", min: "1", max: "2", status: "Follow" }, []));
    const { rows } = await mod("rmLevels").load(a);
    const r = rows.find((x) => x.v.item === "Toluene")!;
    /* 200 L over a 90-day look-back: 2.2 L/day; 7 and 21 days' cover. */
    assert.equal(r.v.sMin, 16);
    assert.equal(r.v.sMax, 47);
    const [before] = await db.select().from(erpRmLevels);
    assert.equal(before.minQty, 1, "nothing changes until applied");
    await ok(mod("rmLevels").actions!.apply(a, r.id, {}));
    const [after] = await db.select().from(erpRmLevels);
    assert.deepEqual([after.minQty, after.maxQty], [16, 47]);
  });
});

describe("the dashboard", () => {
  test("money tiles need their power; every tile links to the rows it counted", async () => {
    const a = await as(admin);
    const all = (await dashboardSections(a, null)).flatMap((s) => s.tiles);
    const labels = all.map((t) => t.l);
    for (const l of ["Sales value this month", "Margin this month", "Purchase value this month", "Dispatched this month", "Pending LR"]) assert.ok(labels.includes(l), `admin sees ${l}`);
    assert.ok(!labels.includes("Calls due today"), "order follow-up is the CRM's, not a second prediction here");
    assert.ok(all.every((t) => t.href.startsWith("/erp")));
    const c = await as(clerk);
    const clerkLabels = (await dashboardSections(c, null)).flatMap((s) => s.tiles).map((t) => t.l);
    for (const l of ["Sales value this month", "Margin this month", "Purchase value this month", "Raw material stock value"]) assert.ok(!clerkLabels.includes(l), `a clerk does not see ${l}`);
    assert.ok(clerkLabels.includes("Dispatched this month"));
    void orderIds;
  });
});
