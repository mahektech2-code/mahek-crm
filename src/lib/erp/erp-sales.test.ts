/**
 * ERP phase 4 — sales orders, lot allocation, order details and dispatch
 * verification, against a real database through the real handlers.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { placeOrder } from "./test-orders";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";

import { attachInvoicePdf } from "@/lib/erp/invoice-fixture";
import { billingViewFor } from "@/lib/erp/billing-view-read";
import { invoicePrintList } from "@/lib/erp/invoice-panel";
import { db } from "@/db";
import {
  appAccess,
  customers,
  erpBatchCodes,
  erpCustomerProfiles,
  erpFgEntries,
  erpFollowups,
  erpOrderDetails,
  erpOrderHolds,
  erpOrderIntakes,
  erpOrderReviews,
  erpOrders,
  erpUserPowers,
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
import { dispatchLabels } from "@/lib/erp/label-data";
import { withFills, type FieldSpec } from "@/lib/erp/ui";
import { impactReport } from "@/lib/impact/registry";
import { IMPACT_FIELD, type ImpactReport } from "@/lib/impact/types";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** The report the impact modal shows, and the payload it sends back with the act — typed exactly as asked. */
async function confirmed(kind: string, recordId: string): Promise<{ report: ImpactReport; values: Record<string, string> }> {
  const r = await impactReport(kind, recordId);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return { report: r.data, values: { [IMPACT_FIELD]: JSON.stringify({ typed: r.data.confirmWord, fingerprint: r.data.fingerprint }) } };
}
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
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}@erp.test`, phone: testPhone(), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
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
/** What a result says, success included. */
const say = (r: { ok: boolean; message?: unknown; fieldErrors?: { message: string }[]; error?: string }) => (r.ok ? String(r.message ?? "ok") : msg(r));

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
             erp_order_reviews, audit_log restart identity cascade`);
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
  await db.execute(sql`delete from erp_transporters where id in ('etr_sales_vrl', 'etr_sales_shree')`);
  await db.execute(sql`insert into erp_transporters (id, name) values ('etr_sales_vrl', 'VRL'), ('etr_sales_shree', 'Shree Roadways') on conflict do nothing`);
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
  (await db.select().from(erpOrders).where(sql`${erpOrders.skuId} = ${sku} and ${erpOrders.billingCustomerId} = 'cus_shree' and ${erpOrders.qtyCans} in (20, 24)`).orderBy(erpOrders.orderNo))[0];

describe("taking an order", () => {
  test("boxes must come out whole", async () => {
    const ctx = await as(admin);
    const r = await placeOrder(ctx, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: BOXED, qty: "25" }]);
    assert.equal(msg(r), "INVALID");
  });

  test("the rate defaults from the list the Accounts app applies to the party, and the transporter from the delivery party", async () => {
    const ctx = await as(admin);
    const r = await placeOrder(ctx, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [
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

  test("a party no list applies to gets no rate, says so, keeps the one typed for it, and a TO without a rate is not checked", async () => {
    const ctx = await as(admin);
    const blank = await mod("orders").forms!.new(ctx, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "No List Traders" }, [{ sku: LOOSE, qty: "7" }]);
    assert.ok(blank.ok);
    assert.match(blank.ok ? String(blank.message) : "", /^TO-\d+ saved .*1 without a rate: no price list applies to the party/);
    const toNo = Number(/TO-(\d+)/.exec(String(blank.message))![1]);
    const [to] = await db.select().from(erpOrderIntakes).where(eq(erpOrderIntakes.toNo, toNo));
    const { approveIntake } = await import("./order-hub");
    assert.match(msg(await approveIntake(admin.id, to.id, null)), /rate/i, "Accounts add the rate before they approve");
    const typed = await placeOrder(ctx, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "No List Traders" }, [{ sku: LOOSE, qty: "9", rate: "350" }]);
    assert.ok(typed.ok, JSON.stringify(typed));
    const rows = await db.select().from(erpOrders).where(eq(erpOrders.billingCustomerId, "cus_nolist"));
    assert.deepEqual(rows.map((o) => [o.qtyCans, o.ratePaise]), [[9, 35000]], "only the checked TO became order lines");
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
    const more = await orderForm(ctx, { orderNo: 1, date: TODAY, godown: "Bhiwandi", billing: "Shree Paints", delivery: "Shree Paints", transporter: "", source: "Phone" });
    assert.equal(more.init?.priceList, LIST);
    const drafted = withFills({ ...form, init: { ...form.init, billing: "Shree Paints" }, initLines: [{ sku: LOOSE, qty: "2" }, { sku: DASHED, qty: "12" }, { sku: BOXED, qty: "4", rate: "390" }] });
    assert.deepEqual(drafted.initLines?.map((l) => l.rate ?? ""), ["400", "", "390"], "a drafted line's own rate stands");
  });

  test("somebody without the rate power cannot set a rate, and a pending party's order is marked for approval", async () => {
    const c = await as(clerk);
    const r = await placeOrder(c, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "New Colour House" }, [{ sku: LOOSE, qty: "2", rate: "1" }]);
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

describe("delivering to a third-party shop", () => {
  /* A shop billed through its distributor is a lead with the mark and, usually, no dispatch profile. */
  test("the shop is offered, saved and shown as the delivery party, never the billing party", async () => {
    await db.insert(customers).values({ id: "cus_corner", name: "Corner Hardware", city: "Thane", phone: "9876500009", kind: "lead", thirdParty: true, area: "Thane" });
    const ctx = await as(admin);
    const form = await orderForm(ctx);
    const field = (k: string) => form.header.find((f) => f.k === k) as FieldSpec;
    assert.ok(field("delivery").opts?.includes("Corner Hardware"), "the delivery list carries third-party shops");
    assert.ok(!field("billing").opts?.includes("Corner Hardware"), "a shop we do not invoice is not a billing party");

    const r = await placeOrder(ctx, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "No List Traders", delivery: "Corner Hardware" }, [{ sku: LOOSE, qty: "4", rate: "300" }]);
    assert.ok(r.ok, JSON.stringify(r));
    const [o] = await db.select().from(erpOrders).where(eq(erpOrders.deliveryCustomerId, "cus_corner"));
    assert.equal(o.billingCustomerId, "cus_nolist");

    const { rows } = await mod("orders").load(ctx);
    const row = rows.find((x) => x.id === o.id);
    assert.equal(row?.v.delivery, "Corner Hardware", "the list reads the shop, not the billing party");
    assert.equal(row?.v.billing, "No List Traders");
  });

  test("a delivery party nobody holds is refused rather than becoming the billing party", async () => {
    const ctx = await as(admin);
    const r = await placeOrder(ctx, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "No List Traders", delivery: "Nobody By This Name" }, [{ sku: LOOSE, qty: "1" }]);
    assert.match(msg(r), /No party named "Nobody By This Name"/);
  });
});

describe("what a line weighs", () => {
  test("a box's weight times the boxes, or a can's times the cans where there is no box", async () => {
    const ctx = await as(admin);
    assert.ok((await placeOrder(ctx, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: BOXED, qty: "24" }, { sku: LOOSE, qty: "7" }])).ok);
    const [boxed] = await db.select().from(erpOrders).where(and(eq(erpOrders.skuId, boxedId), eq(erpOrders.qtyCans, 24)));
    const [loose] = await db.select().from(erpOrders).where(and(eq(erpOrders.skuId, looseId), eq(erpOrders.qtyCans, 7)));
    const { rows } = await mod("orders").load(ctx);
    const weight = (lineId: string) => rows.find((r) => r.id === lineId)?.fields?.find((f) => f.l === "Weight")?.v;
    assert.equal(weight(boxed.id), "27 kg", "6 boxes of 4.5 kg, not the 4.5 kg of one box");
    assert.equal(weight(loose.id), "7.7 kg", "7 loose cans of 1.1 kg");
  });
});

describe("marking Ready", () => {
  test("Ready is refused where the godown has not the stock, and says what it needs", async () => {
    const ctx = await as(admin);
    const r = await placeOrder(ctx, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: LOOSE, qty: "40" }]);
    assert.ok(r.ok, JSON.stringify(r));
    const [big] = await db.select().from(erpOrders).where(sql`${erpOrders.skuId} = ${looseId} and ${erpOrders.qtyCans} = 40`);
    assert.equal(big.orderCheck, "Verified", "an order arrives checked: both checks made its number");
    assert.match(msg(await mod("orders").actions!.ready(ctx, big.id, {})), /stock is not there: .*needs 40 cans, 30 in stock/);
    const viaEdit = await mod("orders").forms!.edit(ctx, { status: "Ready", delivery: "Shree Paints", qty: "40" }, [], big.id);
    assert.match(msg(viaEdit), /Stock is not there/);
    assert.equal((await db.select().from(erpOrders).where(eq(erpOrders.id, big.id)))[0].status, big.status, "nothing was marked");
    await db.delete(erpOrders).where(eq(erpOrders.id, big.id));
  });
  test("a status moves either way: hold, back to Under Process, cancel and back again", async () => {
    const ctx = await as(admin);
    const r = await placeOrder(ctx, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: LOOSE, qty: "41" }]);
    assert.ok(r.ok, JSON.stringify(r));
    const [line] = await db.select().from(erpOrders).where(sql`${erpOrders.skuId} = ${looseId} and ${erpOrders.qtyCans} = 41`);
    const statusNow = async () => (await db.select().from(erpOrders).where(eq(erpOrders.id, line.id)))[0].status;
    const a = mod("orders").actions!;
    /* A hold is an order's, and it says why — in words the customer may read (customer order tracking, 0292). */
    assert.equal(msg(await a.hold(ctx, line.id, {})), "Pick the reason");
    assert.ok((await a.hold(ctx, line.id, { reason: "Material shortage", customerText: "Waiting for one of the materials.", internalNote: "Toluene short", notify: "No" })).ok);
    assert.equal(await statusNow(), "Hold From Office");
    const [held] = await db.select().from(erpOrderHolds).where(eq(erpOrderHolds.orderNo, line.orderNo));
    assert.equal(held.reason, "material_shortage");
    assert.equal(held.internalNote, "Toluene short");
    assert.equal(held.lineStatuses[line.id], "Under Process");
    assert.ok((await a.underProcess(ctx, line.id, {})).ok, "Hold goes back to Under Process");
    assert.equal(await statusNow(), "Under Process");
    assert.ok((await db.select().from(erpOrderHolds).where(eq(erpOrderHolds.id, held.id)))[0].resolvedAt, "moving the last held line off hold ends the order's hold");
    assert.match(msg(await a.cancel(ctx, line.id, {})), /Check what this affects/, "a cancel is confirmed through the impact modal");
    const cancel = await confirmed("erp-order-cancel", line.id);
    assert.ok(cancel.report.items.some((i) => i.effect === "changed" && /order line cancelled/.test(i.label)), JSON.stringify(cancel.report.items));
    assert.equal(cancel.report.confirmWord, String(line.orderNo));
    assert.ok((await a.cancel(ctx, line.id, cancel.values)).ok);
    assert.equal(await statusNow(), "Cancel");
    assert.ok((await mod("orders").bulk!.underProcess(ctx, [line.id], {})).ok, "a cancelled line can be put back");
    assert.equal(await statusNow(), "Under Process");
    await db.delete(erpOrderHolds).where(eq(erpOrderHolds.orderNo, line.orderNo));
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

describe("the order to the bill to the lorry (Order-to-Delivery PRD)", () => {
  test("goods that will go later move to a new, linked order; the rest is billed whole with its Tally invoice", async () => {
    const ctx = await as(admin);
    const loose = await orderFor(looseId);
    const boxed = await orderFor(boxedId);
    const a = mod("orders").actions!;
    assert.match(msg(await a.bill(ctx, loose.id, {})), /The Tally invoice number is required/);
    assert.equal(msg(await a.moveOut(ctx, boxed.id, { qty: "24" })), "Goods, cans, prices and parties are changed with Edit order (the Production Head, or whoever holds Edit orders), until it is billed.");
    const [bc] = await db.select().from(erpBatchCodes).where(eq(erpBatchCodes.orderId, boxed.id));
    assert.match(msg(await mod("batchCodes").actions!.release(ctx, bc.id, {})), /Check what this affects/);
    const release = await confirmed("erp-batch-release", bc.id);
    assert.ok(release.report.items.some((i) => new RegExp(`go back into packing lot ${bc.lotCode}`).test(i.label)), JSON.stringify(release.report.items));
    assert.ok((await mod("batchCodes").actions!.release(ctx, bc.id, release.values)).ok);
    assert.equal((await packLots())[0].stock, 10, "releasing gives the stock back");
    /* Goods that go later are no longer moved onto a new order: the line is cancelled and taken again. */
    const cancelBoxed = await confirmed("erp-order-cancel", boxed.id);
    assert.ok((await a.cancel(ctx, boxed.id, cancelBoxed.values)).ok);
    const edit = await mod("orders").forms!.edit(ctx, { status: "Ready", delivery: "Shree Paints", qty: "20", rate: "400", discount: "5", transport: "0" }, [], loose.id);
    assert.ok(edit.ok, JSON.stringify(edit));
    const beforeBill = await mod("pendingOrders").load(ctx);
    const working = await mod("readyOrders").load(ctx);
    assert.deepEqual(beforeBill.rows.filter((r) => working.rows.some((w) => w.id === r.id)).map((r) => r.id), [], "no line is on two tabs at once");
    assert.ok((await mod("toBill").load(ctx)).rows.some((r) => r.id === loose.id), "Ready material is on Ready to bill");
    assert.ok((await a.bill(ctx, loose.id, { invoiceNo: "MMI/26-27/101", invoiceDate: TODAY })).ok);
    const [l] = await db.select().from(erpOrders).where(eq(erpOrders.id, loose.id));
    assert.equal(l.entryStatus, "Done");
    assert.equal(l.tallyBillNo, "MMI/26-27/101");
    assert.equal(l.invoiceDate, TODAY);
    const [d] = await db.select().from(erpOrderDetails).where(eq(erpOrderDetails.orderId, loose.id));
    assert.equal(d.invoiceCheck, "Pending", "a new bill waits for the invoice check");
    assert.ok((await mod("invoiceCheck").load(ctx)).rows.some((r) => r.id === loose.id), "and is on Invoice check");
    assert.equal(msg(await mod("orders").forms!.more(ctx, { orderFixed: String(l.orderNo), source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: LOOSE, qty: "1" }])), "Goods, cans, prices and parties are changed with Edit order (the Production Head, or whoever holds Edit orders), until it is billed.");
  });

  test("the invoice check comes before dispatch, and the checker is not the person who billed", async () => {
    const ctx = await as(admin);
    const loose = await orderFor(looseId);
    const pending = (await mod("orderDetails").load(ctx)).rows.find((r) => r.id === loose.id);
    assert.equal(pending?.actions?.find((x) => x.id === "verify")?.why, "Waiting for the invoice check.", "a pending invoice check holds dispatch");
    await db.insert(erpUserPowers).values({ userId: clerk.id, power: "checkInvoices" });
    await db.update(erpOrderDetails).set({ createdById: clerk.id }).where(eq(erpOrderDetails.orderId, loose.id));
    assert.equal(msg(await mod("orders").actions!.approveInvoice(await as(clerk), loose.id, {})), "You entered this bill, so somebody else checks it.");
    await db.update(erpOrderDetails).set({ createdById: admin.id }).where(eq(erpOrderDetails.orderId, loose.id));
    assert.equal(msg(await mod("orders").actions!.approveInvoice(await as(clerk), loose.id, {})), "Add the invoice PDF first — an invoice is checked against its PDF.");
    const noPdf = (await mod("invoiceCheck").load(ctx)).rows.find((r) => r.id === loose.id);
    assert.equal(noPdf?.actions?.find((x) => x.id === "approveInvoice")?.why, "Add the invoice PDF first", "the button says why before it is pressed");
    assert.match(String(noPdf?.v.invoice), /^n:\d+$/, "the order heading shows Add PDF");
    await attachInvoicePdf(loose.id, admin.id);
    const withPdf = (await mod("invoiceCheck").load(ctx)).rows.find((r) => r.id === loose.id);
    assert.match(String(withPdf?.v.invoice), /^y:\d+$/, "and view and print once it is attached");
    assert.equal(withPdf?.panel?.kind, "orderInvoice", "the checker opens the invoice first");
    const [listed] = await invoicePrintList([loose.id, loose.id]);
    assert.equal(listed?.hasPdf, true, "Print invoices offers the order once, with its PDF");
    assert.match(say(await mod("orders").actions!.approveInvoice(await as(clerk), loose.id, {})), /approved · order \d+ can be dispatched/);
    const [d0] = await db.select().from(erpOrderDetails).where(eq(erpOrderDetails.orderId, loose.id));
    assert.equal(d0.invoiceCheck, "Approved");
    assert.equal(d0.invoiceCheckedById, clerk.id);
    assert.equal(msg(await mod("orderDetails").actions!.verify(ctx, loose.id, {})), "Dispatch date is required");
    assert.match(say(await mod("orderDetails").actions!.verify(ctx, loose.id, { date: "2026-09-22", vehicle: "mh 04 ab 1234", driver: "Ramesh", remark: "" })), /Dispatched · order \d+ on MH 04 AB 1234/);
    const [d] = await db.select().from(erpOrderDetails).where(eq(erpOrderDetails.orderId, loose.id));
    assert.equal(d.verification, "Verified");
    assert.equal(d.dispatchStatus, "Dispatched");
    assert.equal(d.dispatchDate, "2026-09-22");
    assert.equal(d.vehicleNo, "MH 04 AB 1234");
    assert.equal(d.driver, "Ramesh");
    const [bc] = await db.select().from(erpBatchCodes).where(eq(erpBatchCodes.orderId, loose.id));
    const late = await confirmed("erp-batch-release", bc.id);
    assert.deepEqual(late.report.blockers, ["The order has been dispatch-verified."], "the modal says why before the button would");
    assert.equal(msg(await mod("batchCodes").actions!.release(ctx, bc.id, late.values)), "The order has been dispatch-verified.");
  });

  test("dispatch stickers go on while the goods are under process or ready, before any bill", async () => {
    const ctx = await as(admin);
    const placed = await placeOrder(ctx, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: LOOSE, qty: "7" }]);
    assert.ok(placed.ok);
    const [line] = await db.select().from(erpOrders).where(eq(erpOrders.orderNo, placed.orderNo!));
    const onStickers = async () => (await mod("labels").load(ctx)).rows.some((r) => r.id === line.id);
    const a = mod("orders").actions!;
    if (line.status !== "Under Process" && line.status !== "Ready") assert.equal(await onStickers(), false, "a line nobody is working is not stickered yet");
    const r = await a.ready(ctx, line.id, {});
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.ok(await onStickers(), "Ready, unbilled, no invoice check — on Dispatch stickers");
    const labels = await dispatchLabels(line.orderNo);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].label.orderNo, line.orderNo, "the sticker carries the order, which is known before the bill");
    assert.equal(labels[0].label.lotSize, labels[0].copies, "the pieces on the whole order: one sticker each");
    assert.equal(labels[0].label.qty, 1, "a loose line's sticker is on one can, so it says one can — not the line's seven");
    assert.equal(labels[0].stickers.length, 0, "reading the stickers gives no ids");
    const printed = await dispatchLabels(line.orderNo, admin.id);
    assert.equal(printed[0].stickers.length, printed[0].copies, "printing gives every copy its own sticker id and QR");
    assert.ok(printed[0].stickers.every((x, i) => /^DS-[1-9]\d{5}$/.test(x.label.sticker!.id) && x.label.sticker!.pos === i + 1 && x.label.sticker!.of === printed[0].copies));
    const again = await dispatchLabels(line.orderNo, admin.id);
    assert.deepEqual(again[0].stickers.map((x) => x.label.sticker!.id), printed[0].stickers.map((x) => x.label.sticker!.id), "printed again: the same ids");
    assert.equal(a.stickers, undefined, "there is no \"Stickers are on\" to press any more");
    assert.ok((await mod("orders").forms!.edit(ctx, { status: "Ready", delivery: "Shree Paints", qty: "7", rate: "400", transport: "0" }, [], line.id)).ok);
    const b = await a.bill(ctx, line.id, { invoiceNo: `MMI/26-27/${tag}`, invoiceDate: TODAY });
    assert.ok(b.ok, b.ok ? "" : b.error);
    assert.ok(await onStickers(), "billed with the check still pending — still on the tab until it leaves");
  });

  test("an order is billed only once Ready, an invoice is shared only on its own date, and a changed invoice goes back to the checker", async () => {
    const ctx = await as(admin);
    assert.ok((await placeOrder(ctx, { source: "WhatsApp", date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: LOOSE, qty: "3" }])).ok);
    const [line] = await db.select().from(erpOrders).where(and(eq(erpOrders.skuId, looseId), eq(erpOrders.qtyCans, 3)));
    assert.equal(line.orderSource, "WhatsApp");
    assert.equal(line.orderCheck, "Verified", "both checks made its order number");
    const a = mod("orders").actions!;
    assert.match(msg(await a.bill(ctx, line.id, { invoiceNo: "MMI/26-27/909", invoiceDate: TODAY })), /to be Ready — or cancelled/);
    assert.ok((await a.ready(ctx, line.id, {})).ok);
    /* The same party may share an invoice, but only on the invoice's own date. */
    assert.match(msg(await a.bill(ctx, line.id, { invoiceNo: " mmi/26-27/101 ", invoiceDate: "2026-01-01" })), /is already on order \d+, dated .*Orders sharing an invoice share its date\./);
    assert.ok((await a.bill(ctx, line.id, { invoiceNo: "MMI/26-27/909", invoiceDate: TODAY })).ok);
    assert.equal(msg(await a.rejectInvoice(ctx, line.id, {})), "Say why the invoice is rejected");
    assert.ok((await a.rejectInvoice(ctx, line.id, { reason: "Rate should be ₹410" })).ok);
    assert.match(msg(await mod("orderDetails").actions!.verify(ctx, line.id, { date: TODAY })), /was rejected/);
    assert.match(msg(await mod("orders").forms!.edit(ctx, { status: "Ready", delivery: "Shree Paints", qty: "3", rate: "410", transport: "0" }, [], line.id)), /Edit order/, "the rate changes with Edit order");
    assert.ok((await a.changeInvoice(ctx, line.id, { invoiceNo: "MMI/26-27/910", invoiceDate: TODAY })).ok, "a rejected invoice is corrected in Tally and its new number entered");
    const det = async () => (await db.select().from(erpOrderDetails).where(eq(erpOrderDetails.orderId, line.id)))[0];
    assert.equal((await det()).invoiceCheck, "Pending", "the corrected invoice is back with the checker");
    await attachInvoicePdf(line.id, admin.id);
    assert.ok((await a.approveInvoice(ctx, line.id, {})).ok);
    assert.ok((await a.changeInvoice(ctx, line.id, { invoiceNo: "MMI/26-27/911", invoiceDate: TODAY })).ok);
    assert.equal((await det()).invoiceCheck, "Pending", "a changed invoice number after approval goes back too");
    assert.ok((await a.approveInvoice(ctx, line.id, {})).ok);
    const history = await db.select().from(erpOrderReviews).where(eq(erpOrderReviews.orderNo, line.orderNo)).orderBy(erpOrderReviews.at);
    assert.deepEqual(
      history.map((h) => `${h.kind}:${h.result}`),
      ["order:verified", "invoice:submitted", "invoice:rejected", "invoice:submitted", "invoice:approved", "invoice:reset", "invoice:approved"],
    );
    assert.ok((await mod("labels").load(ctx)).rows.some((r) => r.id === line.id), "a billed line not yet gone is on Dispatch stickers");
    /* A line with no lot is not "packed before box ids": nothing says what is on the lorry, so it waits for its boxes to be scanned (order 10058 left with no lot code at all). */
    assert.match(msg(await mod("orderDetails").actions!.verify(ctx, line.id, { date: TODAY })), /3 of 3 still to scan/, "a lot-less line is held for its scans");
    assert.equal((await db.select().from(erpBatchCodes).where(eq(erpBatchCodes.orderId, line.id))).length, 0, "and took no stock");
    assert.notEqual((await det()).verification, "Verified", "and has not left");
  });

  test("Billing & dispatch undoes a bill and changes an invoice from its own row, as the Orders tabs do", async () => {
    const ctx = await as(admin);
    assert.ok((await placeOrder(ctx, { source: "WhatsApp", date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: LOOSE, qty: "17" }])).ok);
    const [line] = await db.select().from(erpOrders).where(and(eq(erpOrders.skuId, looseId), eq(erpOrders.qtyCans, 17)));
    /* The suite's loose stock is spent by now; Ready's stock rule is tested above, so the line is put there directly. */
    await db.update(erpOrders).set({ status: "Ready" }).where(eq(erpOrders.id, line.id));
    const billed = await mod("orders").actions!.bill(ctx, line.id, { invoiceNo: "MMI/26-27/930", invoiceDate: TODAY });
    assert.ok(billed.ok, JSON.stringify(billed));
    const row = (await mod("orderDetails").load(ctx)).rows.find((r) => r.id === line.id)!;
    assert.deepEqual(row.actions?.find((a) => a.id === "unbill")?.impact, { kind: "erp-order-unbill", id: line.id });
    assert.equal(row.actions?.find((a) => a.id === "changeInvoice")?.prompt?.init?.invoiceNo, "MMI/26-27/930");
    const d = mod("orderDetails").actions!;
    assert.ok((await d.changeInvoice(ctx, line.id, { invoiceNo: "MMI/26-27/931", invoiceDate: TODAY })).ok);
    assert.equal((await db.select().from(erpOrders).where(eq(erpOrders.id, line.id)))[0].tallyBillNo, "MMI/26-27/931");
    const bare = await d.unbill(ctx, line.id, {});
    assert.equal(bare.ok, false, "undoing a bill is confirmed in the impact modal first");
    const { values } = await confirmed("erp-order-unbill", line.id);
    const done = await d.unbill(ctx, line.id, values);
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal((await db.select().from(erpOrderDetails).where(eq(erpOrderDetails.orderId, line.id))).length, 0, "back out of billing");
    assert.ok(!(await mod("orderDetails").load(ctx)).rows.some((r) => r.id === line.id));
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

  test("the order domains are separate words", async () => {
    const ctx = await as(admin);
    const { rows } = await mod("orders").load(ctx);
    const loose = await orderFor(looseId);
    const r = rows.find((x) => x.id === loose.id)!;
    assert.deepEqual([r.v.orderStatus, r.v.production, r.v.billingStatus, r.v.dispatchStatus], ["Verified", "Ready", "Approved", "Dispatched"]);
  });
});

describe("Accounts' check of a TO (Option A)", () => {
  test("the Order Hub: a duplicate is asked about, a TO is sent back and edited, Accounts approve it, and the Production Head edits it until billed", async () => {
    const { approveIntake, sendBackIntake } = await import("./order-hub");
    const ctx = await as(admin);
    const head = { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "No List Traders" };
    const first = await mod("orders").forms!.new(ctx, head, [{ sku: LOOSE, qty: "11", rate: "300" }]);
    assert.ok(first.ok, JSON.stringify(first));
    const dup = await mod("orders").forms!.new(ctx, head, [{ sku: LOOSE, qty: "11", rate: "300" }]);
    assert.ok(!dup.ok && dup.code === "duplicate", "the same order on the same day is asked about");
    assert.match(msg(await mod("orders").forms!.new(ctx, { ...head, source: "" }, [{ sku: LOOSE, qty: "12" }])), /how the order was received/);
    const toNo = Number(/TO-(\d+)/.exec(String(first.message))![1]);
    const [to] = await db.select().from(erpOrderIntakes).where(eq(erpOrderIntakes.toNo, toNo));
    const mine = and(eq(erpOrders.billingCustomerId, "cus_nolist"), inArray(erpOrders.qtyCans, [11, 12]));
    assert.equal((await db.select().from(erpOrders).where(mine)).length, 0, "nothing downstream sees a TO");
    assert.ok((await sendBackIntake(admin.id, to.id, "Customer asked for 12, not 11")).ok);
    assert.ok((await mod("hubCorrection").load(ctx)).rows.some((r) => r.id === to.id), "it waits on Sent back");
    assert.match(msg(await approveIntake(admin.id, to.id, null)), /not waiting for Accounts/);
    const edited = await mod("orderHub").forms!.editTo(ctx, head, [{ sku: LOOSE, qty: "12", rate: "300" }], to.id);
    assert.ok(edited.ok, JSON.stringify(edited));
    const made = await approveIntake(admin.id, to.id, null);
    assert.ok(made.ok, JSON.stringify(made));
    const [o] = await db.select().from(erpOrders).where(mine);
    assert.equal(o.qtyCans, 12);
    assert.equal(o.orderCheck, "Verified");
    assert.equal(o.accountsCheck, "Approved", "Accounts' approval made the order number");
    assert.equal(o.productionCheck, "Pending", "the MRP check is next");
    assert.equal(o.intakeId, to.id);
    assert.match(msg(await mod("orderHub").forms!.editTo(ctx, head, [{ sku: LOOSE, qty: "13", rate: "300" }], to.id)), /order number|not|cannot/i);
    /* After the order number: the line edit is dispatch details; goods move with Edit order. */
    const a = mod("orders").actions!;
    assert.match(msg(await a.unverifyOrder(ctx, o.id, {})), /not undone/);
    assert.match(msg(await mod("orders").forms!.edit(ctx, { status: "Under Process", qty: "13", transport: "0" }, [], o.id)), /Edit order/);
    assert.ok((await mod("orders").forms!.edit(ctx, { status: "Under Process", transport: "0", remark: "Call first" }, [], o.id)).ok, "dispatch details still change");
    assert.match(msg(await a.ready(ctx, o.id, {})), /MRP|Production Head|not cleared/i);
    await db.delete(erpOrders).where(eq(erpOrders.id, o.id));
  });
});

describe("numbers and releases", () => {
  test("a dispatch date is planned, and the lists say today, tomorrow or late from it", async () => {
    const ctx = await as(admin);
    const made = await placeOrder(ctx, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "Shree Paints", dispatchOn: "2026-10-05" }, [{ sku: LOOSE, qty: "1" }]);
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
});

describe("editing an order until Bill it (Option A)", () => {
  test("Edit order is the Production Head's; Add another and Move to a new order stay refused", async () => {
    const ctx = await as(admin);
    const placed = await placeOrder(ctx, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: LOOSE, qty: "5" }]);
    assert.ok(placed.ok);
    const [line] = await db.select().from(erpOrders).where(eq(erpOrders.orderNo, placed.orderNo!));
    assert.equal(msg(await mod("orders").actions!.moveOut(ctx, line.id, { qty: "1" })), "Goods, cans, prices and parties are changed with Edit order (the Production Head, or whoever holds Edit orders), until it is billed.");
    assert.ok(mod("orders").formLoaders!.editOrder, "the whole-order form loads");
    const row = (await mod("orders").load(ctx)).rows.find((r) => r.id === line.id)!;
    const ids = (typeof row.actions === "function" ? (row.actions as () => { id: string }[])() : (row.actions ?? [])).map((x) => x.id);
    assert.ok(ids.includes("editOrder"), "an administrator holds the Production Head's edit");
    for (const gone of ["more", "moveOut", "unverifyOrder"]) assert.ok(!ids.includes(gone), gone);
    const saved = await mod("orders").forms!.editOrder(ctx, { billing: "Shree Paints", deliveredBy: "Transporter" }, [{ lineId: line.id, sku: LOOSE, qty: "6" }], line.id);
    assert.ok(saved.ok, JSON.stringify(saved));
    const [after] = await db.select().from(erpOrders).where(eq(erpOrders.id, line.id));
    assert.equal(after.qtyCans, 6);
  });
});

describe("the billing view", () => {
  test("a ticked line brings its whole order, leaves cancelled lines out, and answers for what the viewer may see", async () => {
    const ctx = await as(admin);
    const made = await placeOrder(ctx, { source: "Phone", date: "2026-09-23", godown: "Bhiwandi", billing: "No List Traders" }, [
      { sku: LOOSE, qty: "3", rate: "300" },
      { sku: LOOSE, qty: "5", rate: "300" },
      { sku: BOXED, qty: "4", rate: "300" },
    ]);
    assert.ok(made.ok, msg(made));
    const lines = await db.select().from(erpOrders).where(eq(erpOrders.orderDate, "2026-09-23"));
    const gone = lines.find((l) => l.qtyCans === 5)!;
    await db.update(erpOrders).set({ status: "Cancel" }).where(eq(erpOrders.id, gone.id));
    const ticked = lines.find((l) => l.qtyCans === 3)!;

    const [sheet, ...rest] = await billingViewFor(ctx, [ticked.id]);
    assert.equal(rest.length, 0);
    assert.equal(sheet.buyers[0].fields[0].v.show, "No List Traders");
    assert.deepEqual(sheet.rows.map((r) => r.cans.copy).sort(), ["3", "4"]);
    assert.ok(sheet.totals.some((t) => t.l === "Invoice total"));
    assert.ok(sheet.rows.some((r) => r.weight), "the line weights reach the sheet");
    assert.ok(sheet.totals.some((t) => t.l === "Total weight"));

    const blind = { ...ctx, powers: new Set([...ctx.powers].filter((p) => p !== "viewSalesRate" && p !== "viewSalesAmounts")) };
    const [hidden] = await billingViewFor(blind, [ticked.id]);
    assert.ok(hidden.rows.every((r) => r.rate == null && r.amount == null));
    assert.deepEqual(
      hidden.totals,
      [
        { l: "Total can qty", v: { show: "3", copy: "3" } },
        { l: "Total box qty", v: { show: "1", copy: "1" } },
        { l: "Total weight", v: { show: "7.8 kg", copy: "7.8" } },
      ],
      "3 loose cans of 1.1 kg and one box of 4.5 kg: cans, boxes and weight are not money",
    );
  });
});

describe("deleting a line", () => {
  test("says what goes with it first, and a retired follow-up remark no longer pins the line in place", async () => {
    const ctx = await as(admin);
    const made = await placeOrder(ctx, { source: "Phone", date: "2026-09-22", godown: "Bhiwandi", billing: "No List Traders" }, [
      { sku: LOOSE, qty: "3", rate: "300" },
      { sku: BOXED, qty: "4", rate: "300" },
    ]);
    assert.ok(made.ok, msg(made));
    const lines = await db.select().from(erpOrders).where(eq(erpOrders.orderDate, "2026-09-22"));
    const doomed = lines.find((l) => l.qtyCans === 3)!;
    /* Mahek Plus's follow-up remark: a foreign key that used to make the delete fail in the database. */
    await db.insert(erpFollowups).values({ orderId: doomed.id, remark: "Call after Diwali" });

    const report = await impactReport("erp-order-line", doomed.id);
    assert.ok(report.ok, report.ok ? "" : report.error);
    assert.equal(report.data.confirmWord, String(doomed.orderNo));
    assert.deepEqual(report.data.blockers, []);
    assert.equal(report.data.items.find((i) => i.effect === "deleted" && /follow-up/.test(i.label))?.count, 1);
    assert.equal(report.data.items.find((i) => i.effect === "kept" && /other line/.test(i.label))?.count, 1);

    assert.equal((await mod("orders").actions!.delete(ctx, doomed.id, {})).ok, false, "no confirmation, no delete");
    const r = await mod("orders").actions!.delete(ctx, doomed.id, {
      [IMPACT_FIELD]: JSON.stringify({ typed: String(doomed.orderNo), fingerprint: report.data.fingerprint }),
    });
    assert.ok(r.ok, msg(r));
    assert.equal((await db.select().from(erpOrders).where(eq(erpOrders.id, doomed.id))).length, 0);
    assert.equal((await db.select().from(erpFollowups).where(eq(erpFollowups.orderId, doomed.id))).length, 0);
  });

  test("a line with batch codes holding stock is a blocker before anybody types", async () => {
    await as(admin);
    const [held] = await db.select({ orderId: erpBatchCodes.orderId }).from(erpBatchCodes).limit(1);
    assert.ok(held, "the fixture allocated a lot earlier");
    const report = await impactReport("erp-order-line", held.orderId);
    assert.ok(report.ok, report.ok ? "" : report.error);
    assert.ok(report.data.blockers.length >= 1, JSON.stringify(report.data.blockers));
  });
});
