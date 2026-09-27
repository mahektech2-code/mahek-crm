/**
 * ERP phase 4 — sales orders, lot allocation, order details and dispatch
 * verification, against a real database through the real handlers.
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
  erpBatchCodes,
  erpCustomerProfiles,
  erpFgEntries,
  erpOrderDetails,
  erpOrders,
  erpPackEntries,
  erpProductPacking,
  finishedGoods,
  priceListDiscountTerms,
  priceListRates,
  priceLists,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { fgLots, packLots } from "@/lib/erp/stock";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = "2026-09-20";
const tag = randomUUID().slice(0, 6);
const LOOSE = `ERPS Thinner ${tag} - 1 Liter (Loose)`;
const BOXED = `ERPS Thinner ${tag} - 1 Liter (4 Can/Box)`;
const LIST = `Retail ${tag}`;

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
const msg = (r: { ok: boolean; fieldErrors?: { message: string }[]; error?: string }) => (r.ok ? "ok" : (r.fieldErrors?.[0]?.message ?? r.error ?? "?"));

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;
let fgId = "";
let looseId = "";
let boxedId = "";

before(async () => {
  await db.execute(sql`
    truncate users, customers, erp_customer_profiles, erp_orders, erp_batch_codes, erp_order_details, erp_fg_entries,
             erp_pack_entries, erp_pack_lines, erp_fg_fills, erp_transfers, erp_user_powers, erp_godown_staff, erp_user_settings,
             audit_log restart identity cascade`);
  await db.execute(sql`update erp_series set last = 0`);
  admin = await makeUser("Kavita Admin", "admin");
  clerk = await makeUser("Deepa Clerk", "associate");

  const fId = id("form");
  const bId = id("brand");
  fgId = id("fg");
  looseId = id("sku");
  boxedId = id("sku");
  await db.insert(productFormulations).values({ id: fId, name: `ERPS Thinner ${tag}`, slug: `erps-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `ERPS ${tag}`, slug: `erps-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values({ id: fgId, name: `ERPS Thinner 1 L ${tag}`, slug: `erps-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 1000 });
  await db.insert(products).values([
    { id: looseId, name: LOOSE, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 1, weightGrams: 1100 },
    { id: boxedId, name: BOXED, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 4, weightGrams: 4500 },
  ]);
  await db.insert(erpProductPacking).values([
    { productId: looseId, emptyBoxesRequired: 0 },
    { productId: boxedId, emptyBoxesRequired: 1, boxType: "Empty Box 1 Liter", boxRatePaise: 2000 },
  ]);

  await db.insert(customers).values([
    { id: "cus_shree", name: "Shree Paints", city: "Pune", phone: "9876500001", kind: "customer", area: "Pune", priceTag: LIST, creditDays: 30, deliveryType: "Door Delivery", freightTerm: "Paid" },
    { id: "cus_new", name: "New Colour House", city: "Nashik", phone: "9876500002", kind: "lead", priceTag: LIST },
  ]);
  await db.insert(erpCustomerProfiles).values([
    { customerId: "cus_shree", transporter: "VRL", standingInstructions: "Call first", weightType: "With Weight", monthlyTargetPaise: 500000 },
    { customerId: "cus_new", pendingActivation: true },
  ]);

  const [pl] = await db.insert(priceLists).values({ id: id("pl"), name: LIST, effectiveFrom: "2026-01-01", status: "published" }).returning();
  await db.insert(priceListRates).values([
    { id: id("plr"), priceListId: pl.id, productId: looseId, rateExGstPaise: 40000, rateInclGstPaise: 47200 },
    { id: id("plr"), priceListId: pl.id, productId: boxedId, rateExGstPaise: 38000, rateInclGstPaise: 44840 },
  ]);
  await db.insert(priceListDiscountTerms).values({ id: id("pld"), priceListId: pl.id, kind: "flat", percentBp: 500 });

  /* Stock to sell from: 30 loose cans in FG, 10 boxes in packing, both at Bhiwandi. */
  await db.insert(erpFgEntries).values({ id: id("fge"), sourceType: "fill", sourceId: "fin_x", entryDate: TODAY, finishedGoodId: fgId, lotCode: "FG1BH", godownId: "erpg_bhiwandi", quantity: 30, packingType: "Can", skuId: looseId });
  await db.insert(erpPackEntries).values({ id: id("pke"), sourceType: "batch", sourceId: "FP1BH", entryDate: TODAY, skuId: boxedId, batchNo: "FP1BH", godownId: "erpg_bhiwandi", boxes: 10 });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/** The two lines of Shree Paints' first order: 20 loose cans and 24 boxed ones. */
const orderFor = async (sku: string) =>
  (await db.select().from(erpOrders).where(sql`${erpOrders.skuId} = ${sku} and ${erpOrders.billingCustomerId} = 'cus_shree' and ${erpOrders.qtyCans} in (20, 24)`))[0];

describe("taking an order", () => {
  test("boxes must come out whole", async () => {
    const ctx = await as(admin);
    const r = await mod("orders").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: BOXED, qty: "25" }]);
    assert.equal(msg(r), "INVALID");
  });

  test("rate and discount default from the party's price list, and the transporter from the delivery party", async () => {
    const ctx = await as(admin);
    const r = await mod("orders").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [
      { sku: LOOSE, qty: "20" },
      { sku: BOXED, qty: "24" },
    ]);
    assert.ok(r.ok, JSON.stringify(r));
    const loose = await orderFor(looseId);
    const boxed = await orderFor(boxedId);
    assert.equal(loose.orderNo, boxed.orderNo, "one save is one order");
    assert.equal(loose.ratePaise, 40000);
    assert.equal(loose.discountBp, 500);
    assert.equal(loose.transporter, "VRL");
    assert.equal(loose.partyStatus, null);
    assert.match(loose.id, /^ODID-/);
  });

  test("somebody without the rate power cannot set a rate, and a pending party's order is marked for approval", async () => {
    const c = await as(clerk);
    const r = await mod("orders").forms!.new(c, { date: TODAY, godown: "Bhiwandi", billing: "New Colour House" }, [{ sku: LOOSE, qty: "2", rate: "1" }]);
    assert.ok(r.ok, JSON.stringify(r));
    const [o] = await db.select().from(erpOrders).where(eq(erpOrders.billingCustomerId, "cus_new"));
    assert.equal(o.ratePaise, 40000, "the typed rate was ignored");
    assert.equal(o.partyStatus, "Pending");
    assert.equal(msg(await mod("orders").actions!.approve(c, o.id, {})), "Only an admin or the office approves a pending party's order.");
    const a = await as(admin);
    assert.ok((await mod("orders").actions!.approve(a, o.id, {})).ok);
    const { rows } = await mod("orders").load(c);
    assert.ok(!rows.some((x) => "rate" in x.v), "no rate reaches a clerk");
  });
});

describe("allocating lots", () => {
  test("a line is allocated only once Ready, and never beyond its need or the lot's stock", async () => {
    const ctx = await as(admin);
    const loose = await orderFor(looseId);
    assert.equal(msg(await mod("orders").forms!.allocate(ctx, { lot: "FG1BH", qty: "20" }, [], loose.id)), "Lots are allocated once the line is Ready.");
    assert.ok((await mod("orders").bulk!.ready(ctx, [loose.id, (await orderFor(boxedId)).id], {})).ok);
    assert.equal(msg(await mod("orders").forms!.allocate(ctx, { lot: "FG1BH", qty: "21" }, [], loose.id)), "Invalid Quantity Or Wait For Synchronization");
    assert.ok((await mod("orders").forms!.allocate(ctx, { lot: "FG1BH", qty: "20" }, [], loose.id)).ok);
    assert.equal((await fgLots()).find((l) => l.lotCode === "FG1BH")?.stock, 10, "an allocation takes the stock at once");
  });

  test("a boxed line allocates boxes from packing stock", async () => {
    const ctx = await as(admin);
    const boxed = await orderFor(boxedId);
    assert.equal(msg(await mod("orders").forms!.allocate(ctx, { lot: "FG1BH", qty: "6" }, [], boxed.id)), `No packing batch FG1BH of this SKU has stock at Bhiwandi`);
    assert.ok((await mod("orders").forms!.allocate(ctx, { lot: "FP1BH", qty: "6" }, [], boxed.id)).ok);
    assert.equal((await packLots())[0].stock, 4);
  });
});

describe("order details and dispatch", () => {
  test("a line reaches order details only when Ready, Done, billed, rated and fully allocated", async () => {
    const ctx = await as(admin);
    const loose = await orderFor(looseId);
    const blocked = await mod("orders").actions!.toDetails(ctx, loose.id, {});
    assert.match(msg(blocked), /a Tally bill no\., entry Done/);
    assert.ok((await mod("orders").actions!.done(ctx, loose.id, {})).ok);
    const edit = await mod("orders").forms!.edit(ctx, { status: "Ready", delivery: "Shree Paints", qty: "20", rate: "400", discount: "5", bill: "MMI/26-27/101", transport: "0" }, [], loose.id);
    assert.ok(edit.ok, JSON.stringify(edit));
    assert.ok((await mod("orders").actions!.toDetails(ctx, loose.id, {})).ok);
    const pending = await mod("pendingOrders").load(ctx);
    assert.ok(!pending.rows.some((r) => r.v.orderNo === String(loose.orderNo)), "an order in details has left the pending list");
  });

  test("dispatch verification needs a date, stamps the line, and freezes its lots", async () => {
    const ctx = await as(admin);
    const loose = await orderFor(looseId);
    assert.equal(msg(await mod("orderDetails").actions!.verify(ctx, loose.id, {})), "Dispatch date is required");
    assert.ok((await mod("orderDetails").actions!.verify(ctx, loose.id, { date: "2026-09-22" })).ok);
    const [d] = await db.select().from(erpOrderDetails).where(eq(erpOrderDetails.orderId, loose.id));
    assert.equal(d.verification, "Verified");
    assert.equal(d.dispatchStatus, "Dispatched");
    assert.equal(d.dispatchDate, "2026-09-22");
    const [bc] = await db.select().from(erpBatchCodes).where(eq(erpBatchCodes.orderId, loose.id));
    assert.equal(msg(await mod("batchCodes").actions!.release(ctx, bc.id, {})), "The order has been dispatch-verified.");
  });

  test("the bill: 20 × ₹400, 5% off, 18% GST, and the month's sale against the target", async () => {
    const ctx = await as(admin);
    const loose = await orderFor(looseId);
    const { rows } = await mod("orderDetails").load(ctx);
    const r = rows.find((x) => x.id === loose.id)!;
    assert.equal(r.v.amount, 800000);
    assert.equal(r.v.discounted, 40000);
    assert.equal(r.v.billTotal, Math.round(760000 * 1.18));
    assert.equal(r.v.monthId, "Sep2026");
    assert.ok(r.flags.includes("targetReached"), "₹8,000 against a ₹5,000 target");
    const c = await as(clerk);
    const clerkView = await mod("orderDetails").load(c);
    assert.ok(!clerkView.rows.some((x) => "amount" in x.v || "margin" in x.v));
  });
});

describe("numbers and releases", () => {
  test("Generate New Order Number gives the whole selection one number (A-17)", async () => {
    const ctx = await as(admin);
    const made = await mod("orders").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [
      { sku: LOOSE, qty: "1" },
      { sku: LOOSE, qty: "2" },
    ]);
    assert.ok(made.ok);
    const fresh = (await db.select().from(erpOrders).where(eq(erpOrders.qtyCans, 1))).concat(await db.select().from(erpOrders).where(eq(erpOrders.qtyCans, 2)));
    const ids = fresh.filter((o) => o.billingCustomerId === "cus_shree").map((o) => o.id);
    assert.ok((await mod("orders").bulk!.renumber(ctx, ids, {})).ok);
    const after = await db.select({ no: erpOrders.orderNo }).from(erpOrders).where(sql`${erpOrders.id} in ${ids}`);
    assert.equal(new Set(after.map((a) => a.no)).size, 1);
  });

  test("releasing an allocation gives the stock back and undoes Done", async () => {
    const ctx = await as(admin);
    const boxed = await orderFor(boxedId);
    assert.ok((await mod("orders").actions!.done(ctx, boxed.id, {})).ok);
    const [bc] = await db.select().from(erpBatchCodes).where(eq(erpBatchCodes.orderId, boxed.id));
    assert.ok((await mod("batchCodes").actions!.release(ctx, bc.id, {})).ok);
    assert.equal((await packLots())[0].stock, 10);
    assert.equal((await orderFor(boxedId)).entryStatus, "Not Done");
  });
});
