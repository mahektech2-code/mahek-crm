import { test } from "node:test";
import assert from "node:assert/strict";
import {
  billingOf,
  DELIVERED_STAGE,
  dispatchOf,
  invoiceChanges,
  invoiceKey,
  likelyDuplicate,
  logisticsOf,
  orderBillBlockers,
  orderStatusOf,
  productionOf,
  splitForMove,
  type BillLine,
  type InvoiceSnapshot,
} from "./order-flow";

test("production has two values only: Under Process and Ready", () => {
  assert.equal(productionOf("Under Process"), "Under Process");
  assert.equal(productionOf("Ready"), "Ready");
  assert.equal(productionOf("Hold From Office"), null, "a hold is the order's, not production's");
  assert.equal(productionOf("Cancel"), null);
  assert.equal(productionOf("Partially Ready"), null, "there is no Partially Ready");
});

test("the order domain: verification, hold, cancel and closed", () => {
  const t = (stage: string | null) => ({ stage, hasLr: false, issue: null });
  assert.equal(orderStatusOf({ status: "Under Process", orderCheck: "Pending", transport: null }), "Verification Pending");
  assert.equal(orderStatusOf({ status: "Under Process", orderCheck: "Correction", transport: null }), "Correction Required");
  assert.equal(orderStatusOf({ status: "Ready", orderCheck: "Verified", transport: null }), "Verified");
  assert.equal(orderStatusOf({ status: "Hold From Office", orderCheck: "Verified", transport: null }), "On Hold");
  assert.equal(orderStatusOf({ status: "Cancel", orderCheck: "Verified", transport: null }), "Cancelled");
  assert.equal(orderStatusOf({ status: "Ready", orderCheck: "Verified", transport: t(DELIVERED_STAGE) }), "Closed");
});

test("billing, dispatch and logistics are each their own word", () => {
  const base = { status: "Ready", billed: false, invoiceCheck: null, toScan: null, dispatched: false, transport: null };
  assert.equal(billingOf(base), "Invoice Pending");
  assert.equal(billingOf({ ...base, billed: true, invoiceCheck: "Pending" }), "Verification Pending");
  assert.equal(billingOf({ ...base, billed: true, invoiceCheck: "Rejected" }), "Correction Required");
  assert.equal(billingOf({ ...base, billed: true, invoiceCheck: "Approved" }), "Approved");
  assert.equal(dispatchOf({ ...base, billed: true, invoiceCheck: "Pending" }), "Pending", "dispatch waits for the invoice check");
  assert.equal(dispatchOf({ ...base, billed: true, invoiceCheck: "Approved", toScan: "2 of 3" }), "Scanning / Verification Pending");
  assert.equal(dispatchOf({ ...base, billed: true, invoiceCheck: "Approved" }), "Ready to Dispatch");
  assert.equal(dispatchOf({ ...base, billed: true, invoiceCheck: "Approved", dispatched: true }), "Dispatched");
  assert.equal(logisticsOf({ dispatched: false, transport: null }), null);
  assert.equal(logisticsOf({ dispatched: true, transport: { stage: "Dispatched", hasLr: false, issue: null } }), "Logistics Pending");
  assert.equal(logisticsOf({ dispatched: true, transport: { stage: "In Transit", hasLr: true, issue: null } }), "In Transit");
  assert.equal(logisticsOf({ dispatched: true, transport: { stage: "Reached Destination Area", hasLr: true, issue: null } }), "Delivery Pending Confirmation");
  assert.equal(logisticsOf({ dispatched: true, transport: { stage: "In Transit", hasLr: true, issue: "Delayed" } }), "Exception");
  assert.equal(logisticsOf({ dispatched: true, transport: { stage: DELIVERED_STAGE, hasLr: true, issue: null } }), "Delivered / Closed");
});

test("an order is billed whole: verified, every live line Ready, rates, an approved party", () => {
  const line = (over: Partial<BillLine>): BillLine => ({ id: "a", label: "Nano 1 L", status: "Ready", orderCheck: "Verified", partyPending: false, ratePaise: 10000, billed: false, ...over });
  assert.deepEqual(orderBillBlockers([line({}), line({ id: "b", status: "Cancel", ratePaise: null })]), [], "a cancelled line does not hold the bill");
  assert.deepEqual(orderBillBlockers([line({ orderCheck: "Pending" })]), ["the back office to verify the order"]);
  const [why] = orderBillBlockers([line({}), line({ id: "b", label: "Astar 20 L", status: "Under Process" })]);
  assert.match(why, /Astar 20 L to be Ready — or moved to a new order/);
  assert.deepEqual(orderBillBlockers([line({ ratePaise: null })]), ["a rate on Nano 1 L"]);
  assert.deepEqual(orderBillBlockers([line({ billed: true })]), ["already billed"]);
});

test("an invoice number is compared without case or spaces", () => {
  assert.equal(invoiceKey(" mmi/26-27/ 1119 "), "MMI/26-27/1119");
  assert.equal(invoiceKey("  "), null);
});

test("a change to the invoice's figures is named; nothing else is", () => {
  const before: InvoiceSnapshot = { invoiceNo: "MMI/1", invoiceDate: "2026-10-26", lines: [{ id: "a", skuId: "s", qtyCans: 10, ratePaise: 100, discountBp: null, gstBp: 1800 }] };
  assert.deepEqual(invoiceChanges(before, structuredClone(before)), []);
  assert.deepEqual(invoiceChanges(before, { ...before, invoiceNo: "mmi/1" }), [], "the same number in another case is the same number");
  const after: InvoiceSnapshot = { ...before, lines: [{ ...before.lines[0], ratePaise: 120, gstBp: 0 }] };
  assert.deepEqual(invoiceChanges(before, after), ["a rate", "GST"]);
  assert.deepEqual(invoiceChanges(before, { ...before, invoiceNo: "MMI/2" }), ["invoice no. MMI/1 → MMI/2"]);
});

test("a likely duplicate is the same party, day and goods", () => {
  const existing = [{ orderNo: 10, billingId: "c1", date: "2026-10-26", lines: [{ skuId: "a", qtyCans: 12 }, { skuId: "b", qtyCans: 4 }] }];
  assert.equal(likelyDuplicate({ billingId: "c1", date: "2026-10-26", lines: [{ skuId: "b", qtyCans: 4 }, { skuId: "a", qtyCans: 12 }] }, existing), 10);
  assert.equal(likelyDuplicate({ billingId: "c1", date: "2026-10-27", lines: [{ skuId: "a", qtyCans: 12 }, { skuId: "b", qtyCans: 4 }] }, existing), null, "another day is a reorder");
  assert.equal(likelyDuplicate({ billingId: "c1", date: "2026-10-26", lines: [{ skuId: "a", qtyCans: 12 }] }, existing), null);
  assert.equal(likelyDuplicate({ billingId: "c2", date: "2026-10-26", lines: [{ skuId: "a", qtyCans: 12 }, { skuId: "b", qtyCans: 4 }] }, existing), null);
});

test("moving part of a line keeps both parts in whole boxes", () => {
  assert.deepEqual(splitForMove(64, 64, 32, false), { ok: true, stays: 0, moves: 64 });
  assert.deepEqual(splitForMove(64, 32, 32, false), { ok: true, stays: 32, moves: 32 });
  assert.equal(splitForMove(64, 10, 32, false).ok, false);
  assert.deepEqual(splitForMove(10, 3, 1, true), { ok: true, stays: 7, moves: 3 });
  assert.equal(splitForMove(10, 11, 1, true).ok, false);
  assert.equal(splitForMove(10, 0, 1, true).ok, false);
});
