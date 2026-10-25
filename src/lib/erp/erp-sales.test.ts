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
import { and, eq, sql } from "drizzle-orm";

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
  monthlyTargets,
  priceListDiscountTerms,
  priceListRates,
  priceListScopes,
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
import { dueOf, orderForm } from "@/lib/erp/screens/sales";
import { withFills, type FieldSpec } from "@/lib/erp/ui";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = "2026-09-20";
const tag = randomUUID().slice(0, 6);
const LOOSE = `ERPS Thinner ${tag} - 1 Liter (Loose)`;
const BOXED = `ERPS Thinner ${tag} - 1 Liter (4 Can/Box)`;
/* A packing the list prints a dash for: not for sale on it, so it must not borrow the loose rate. */
const DASHED = `ERPS Thinner ${tag} - 1 Liter (12 Can/Box)`;
/* The Accounts app's name for the list, and the sheet's tag beside it, which names no list. */
const LIST = `Western line Paid ${tag}`;
const SHEET_TAG = "Pan Maharashtra";

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
let dashedId = "";

before(async () => {
  await db.execute(sql`
    truncate users, customers, price_lists, erp_customer_profiles, erp_orders, erp_batch_codes, erp_order_details, erp_fg_entries,
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
  dashedId = id("sku");
  await db.insert(productFormulations).values({ id: fId, name: `ERPS Thinner ${tag}`, slug: `erps-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `ERPS ${tag}`, slug: `erps-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values({ id: fgId, name: `ERPS Thinner 1 L ${tag}`, slug: `erps-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 1000 });
  await db.insert(products).values([
    { id: looseId, name: LOOSE, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 1, weightGrams: 1100 },
    { id: boxedId, name: BOXED, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 4, weightGrams: 4500 },
    { id: dashedId, name: DASHED, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 12, weightGrams: 13000 },
  ]);
  await db.insert(erpProductPacking).values([
    { productId: looseId, emptyBoxesRequired: 0 },
    { productId: boxedId, emptyBoxesRequired: 1, boxType: "Empty Box 1 Liter", boxRatePaise: 2000 },
    { productId: dashedId, emptyBoxesRequired: 1, boxType: "Empty Box 1 Liter", boxRatePaise: 2000 },
  ]);

  await db.insert(customers).values([
    { id: "cus_shree", name: "Shree Paints", city: "Pune", phone: "9876500001", kind: "customer", area: "Pune", priceTag: SHEET_TAG, creditDays: 30, deliveryType: "Door Delivery", freightTerm: "Paid" },
    { id: "cus_new", name: "New Colour House", city: "Nashik", phone: "9876500002", kind: "lead", priceTag: SHEET_TAG },
    /* Tagged with the list's very name, and named by none of its scopes: the tag is not what applies a list. */
    { id: "cus_nolist", name: "No List Traders", city: "Surat", phone: "9876500003", kind: "customer", priceTag: LIST },
  ]);
  await db.insert(erpCustomerProfiles).values([
    { customerId: "cus_shree", transporter: "VRL", standingInstructions: "Call first", weightType: "With Weight" },
    { customerId: "cus_new", pendingActivation: true },
  ]);
  /* The target is the CRM's Monthly Targets row for the month dispatched in. */
  await db.insert(monthlyTargets).values({ id: id("mt"), customerId: "cus_shree", year: 2026, month: 9, targetAmount: 500000, isDefault: false });

  const [pl] = await db.insert(priceLists).values({ id: id("pl"), name: LIST, effectiveFrom: "2026-01-01", status: "published" }).returning();
  /* Who it applies to, the way Accounts says it: by customer. */
  await db.insert(priceListScopes).values([
    { id: id("pls"), priceListId: pl.id, scopeKind: "customer", scopeValue: "cus_shree", scopeLabel: "Shree Paints" },
    { id: id("pls"), priceListId: pl.id, scopeKind: "customer", scopeValue: "cus_new", scopeLabel: "New Colour House" },
  ]);
  await db.insert(priceListRates).values([
    { id: id("plr"), priceListId: pl.id, productId: looseId, rateExGstPaise: 40000, rateInclGstPaise: 47200 },
    { id: id("plr"), priceListId: pl.id, productId: boxedId, rateExGstPaise: 38000, rateInclGstPaise: 44840 },
    { id: id("plr"), priceListId: pl.id, productId: dashedId, rateExGstPaise: 0, rateInclGstPaise: 0, offered: false },
  ]);
  /* MP & CG's real shape: a discount with no threshold that is still conditional — on paying in advance. */
  await db.insert(priceListDiscountTerms).values({ id: id("pld"), priceListId: pl.id, kind: "advance_payment", percentBp: 300 });

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

  test("the rate defaults from the list the Accounts app applies to the party, and the transporter from the delivery party", async () => {
    const ctx = await as(admin);
    const r = await mod("orders").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [
      { sku: LOOSE, qty: "20", discount: "5" },
      { sku: BOXED, qty: "24" },
    ]);
    assert.ok(r.ok, JSON.stringify(r));
    const loose = await orderFor(looseId);
    const boxed = await orderFor(boxedId);
    assert.equal(loose.orderNo, boxed.orderNo, "one save is one order");
    assert.equal(loose.ratePaise, 40000, "the list's own rate for the SKU");
    assert.equal(boxed.ratePaise, 38000);
    assert.equal(loose.discountBp, 500, "the discount somebody typed");
    assert.equal(boxed.discountBp, null, "the list's 3% for advance payment is not given unasked");
    assert.equal(loose.transporter, "VRL");
    assert.equal(loose.partyStatus, null);
    assert.match(loose.id, /^ODID-/);
  });

  test("a party no list applies to gets no rate, says so, and keeps the one typed for it", async () => {
    const ctx = await as(admin);
    const blank = await mod("orders").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", billing: "No List Traders" }, [{ sku: LOOSE, qty: "7" }]);
    assert.ok(blank.ok);
    assert.match(blank.ok ? String(blank.message) : "", /1 without a rate: no price list applies to the party/);
    assert.ok((await mod("orders").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", billing: "No List Traders" }, [{ sku: LOOSE, qty: "9", rate: "350" }])).ok);
    const rows = await db.select().from(erpOrders).where(eq(erpOrders.billingCustomerId, "cus_nolist"));
    assert.deepEqual(rows.map((o) => [o.qtyCans, o.ratePaise]).sort((a, b) => Number(a[0]) - Number(b[0])), [[7, null], [9, 35000]]);
  });

  test("the form fills each party's list and its rates in, and names what it cannot fill", async () => {
    const ctx = await as(admin);
    const form = await orderForm(ctx);
    const field = (k: string) => [...form.header, ...(form.line ?? [])].find((f) => f.k === k) as FieldSpec;
    assert.equal(field("priceList").fillBy?.map["Shree Paints"], LIST);
    assert.equal(field("priceList").fillBy?.map["No List Traders"], "None applies to this party");
    assert.equal(field("listTerms").fillBy?.map["Shree Paints"], "3% off for advance payment");
    const rate = field("rate").fillBy!;
    assert.deepEqual(rate.by, ["priceList", "sku"]);
    assert.equal(rate.map[`${LIST}|${LOOSE}`], "400");
    assert.equal(rate.map[`${LIST}|${DASHED}`], undefined, "a dash is not for sale on the list, whatever its loose packing costs");
    assert.equal(rate.otherwise, "", "a party or SKU without a rate clears the one the last pick filled in");
    assert.equal(field("discount").fillBy, undefined, "no discount is filled in");
    /* "Add to order" and a drafted order open with the party already picked. */
    const more = await orderForm(ctx, { orderNo: 1, date: TODAY, godown: "Bhiwandi", billing: "Shree Paints", delivery: "Shree Paints", transporter: "" });
    assert.equal(more.init?.priceList, LIST);
    const drafted = withFills({ ...form, init: { ...form.init, billing: "Shree Paints" }, initLines: [{ sku: LOOSE, qty: "2" }, { sku: DASHED, qty: "12" }, { sku: BOXED, qty: "4", rate: "390" }] });
    assert.deepEqual(drafted.initLines?.map((l) => l.rate ?? ""), ["400", "", "390"], "a drafted line's own rate stands");
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

describe("marking Ready", () => {
  test("Ready is refused where the godown has not the stock, and says what it needs", async () => {
    const ctx = await as(admin);
    const r = await mod("orders").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: LOOSE, qty: "40" }]);
    assert.ok(r.ok, JSON.stringify(r));
    const [big] = await db.select().from(erpOrders).where(sql`${erpOrders.skuId} = ${looseId} and ${erpOrders.qtyCans} = 40`);
    assert.match(msg(await mod("orders").actions!.ready(ctx, big.id, {})), /^Stock is not there: .*needs 40 cans, 30 in stock/);
    const viaEdit = await mod("orders").forms!.edit(ctx, { status: "Ready", delivery: "Shree Paints", qty: "40" }, [], big.id);
    assert.match(msg(viaEdit), /Stock is not there/);
    assert.equal((await db.select().from(erpOrders).where(eq(erpOrders.id, big.id)))[0].status, big.status, "nothing was marked");
    await db.delete(erpOrders).where(eq(erpOrders.id, big.id));
  });
  test("a status moves either way: hold, back to Under Process, cancel and back again", async () => {
    const ctx = await as(admin);
    const r = await mod("orders").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: LOOSE, qty: "41" }]);
    assert.ok(r.ok, JSON.stringify(r));
    const [line] = await db.select().from(erpOrders).where(sql`${erpOrders.skuId} = ${looseId} and ${erpOrders.qtyCans} = 41`);
    const statusNow = async () => (await db.select().from(erpOrders).where(eq(erpOrders.id, line.id)))[0].status;
    const a = mod("orders").actions!;
    assert.ok((await a.hold(ctx, line.id, {})).ok);
    assert.equal(await statusNow(), "Hold From Office");
    assert.ok((await a.underProcess(ctx, line.id, {})).ok, "Hold goes back to Under Process");
    assert.equal(await statusNow(), "Under Process");
    assert.ok((await a.cancel(ctx, line.id, {})).ok);
    assert.equal(await statusNow(), "Cancel");
    assert.ok((await mod("orders").bulk!.hold(ctx, [line.id], {})).ok, "a cancelled line can be put back");
    assert.equal(await statusNow(), "Hold From Office");
    await db.delete(erpOrders).where(eq(erpOrders.id, line.id));
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
  test("Bill it takes a Ready, fully allocated line with a bill no. and a rate — one step, not Done then Add To Order Details", async () => {
    const ctx = await as(admin);
    const loose = await orderFor(looseId);
    const blocked = await mod("orders").actions!.bill(ctx, loose.id, {});
    assert.match(msg(blocked), /a Tally bill no\./);
    const edit = await mod("orders").forms!.edit(ctx, { status: "Ready", delivery: "Shree Paints", qty: "20", rate: "400", discount: "5", bill: "MMI/26-27/101", transport: "0" }, [], loose.id);
    assert.ok(edit.ok, JSON.stringify(edit));
    const beforeBill = await mod("pendingOrders").load(ctx);
    const working = await mod("readyOrders").load(ctx);
    const onBoth = beforeBill.rows.filter((r) => working.rows.some((w) => w.id === r.id));
    assert.deepEqual(onBoth.map((r) => r.v.status), [], "no line is on Pending and Under process & ready at once");
    assert.ok(!beforeBill.rows.some((r) => r.v.status === "Under Process" || r.v.status === "Ready"), "Pending holds no Under Process or Ready line");
    assert.ok(!beforeBill.rows.some((r) => r.id === loose.id), "a Ready line has left Pending for Under process & ready");
    assert.ok((await mod("readyOrders").load(ctx)).rows.some((r) => r.id === loose.id), "and is on Under process & ready");
    assert.ok((await mod("orders").actions!.bill(ctx, loose.id, {})).ok);
    assert.equal((await orderFor(looseId)).entryStatus, "Done", "billing it is what Done means");
    assert.equal((await db.select().from(erpOrderDetails).where(eq(erpOrderDetails.orderId, loose.id))).length, 1);
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

  test("an Under Process line with no lots is billed once it has a bill no. and a rate, and leaves without lots", async () => {
    const ctx = await as(admin);
    assert.ok((await mod("orders").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: LOOSE, qty: "3" }])).ok);
    const [line] = await db.select().from(erpOrders).where(and(eq(erpOrders.skuId, looseId), eq(erpOrders.qtyCans, 3)));
    assert.equal(line.status, "Under Process");
    assert.match(msg(await mod("orders").actions!.bill(ctx, line.id, {})), /a Tally bill no\./, "the bill no. is still asked for");
    assert.doesNotMatch(msg(await mod("orders").actions!.bill(ctx, line.id, {})), /Ready|lots/, "Ready and lots are not");
    assert.ok((await mod("orders").forms!.edit(ctx, { status: "Under Process", delivery: "Shree Paints", qty: "3", rate: "400", bill: "MMI/26-27/909", transport: "0" }, [], line.id)).ok);
    assert.ok((await mod("orders").actions!.bill(ctx, line.id, {})).ok);
    assert.ok((await mod("orderDetails").actions!.verify(ctx, line.id, { date: TODAY })).ok, "a line billed without lots is dispatch-verified without them");
    const [d] = await db.select().from(erpOrderDetails).where(eq(erpOrderDetails.orderId, line.id));
    assert.equal(d.verification, "Verified");
    assert.equal((await db.select().from(erpBatchCodes).where(eq(erpBatchCodes.orderId, line.id))).length, 0, "and took no stock");
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
  test("a dispatch date is planned, and the lists say today, tomorrow or late from it", async () => {
    const ctx = await as(admin);
    const made = await mod("orders").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", billing: "Shree Paints", dispatchOn: "2026-10-05" }, [{ sku: LOOSE, qty: "1" }]);
    assert.ok(made.ok);
    const [o] = await db.select().from(erpOrders).where(eq(erpOrders.qtyCans, 1));
    assert.equal(o.dispatchOn, "2026-10-05");
    assert.equal(o.status, "Under Process");
    assert.equal(dueOf("2026-10-05", false, "Under Process", "2026-10-05"), "today");
    assert.equal(dueOf("2026-10-06", false, "Ready", "2026-10-05"), "tomorrow");
    assert.equal(dueOf("2026-10-01", false, "Ready", "2026-10-05"), "late");
    assert.equal(dueOf("2026-10-01", true, "Ready", "2026-10-05"), null, "once it has left it is not late");
    assert.equal(dueOf("2026-10-01", false, "Cancel", "2026-10-05"), null);
    assert.equal(dueOf(null, false, "Ready", "2026-10-05"), null);
  });

  test("releasing an allocation gives the stock back, and a billed line's lots stay until its billing is undone", async () => {
    const ctx = await as(admin);
    const boxed = await orderFor(boxedId);
    const [bc] = await db.select().from(erpBatchCodes).where(eq(erpBatchCodes.orderId, boxed.id));
    assert.ok((await mod("batchCodes").actions!.release(ctx, bc.id, {})).ok);
    assert.equal((await packLots())[0].stock, 10);
    assert.equal((await orderFor(boxedId)).entryStatus, "Not Done");
  });
});
