import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_TABS_RETIRED,
  PARTY_TAB_RETIRED,
  WHOLE_SHEET_RETIRED,
  retiredReason,
  sheetSwitches,
  sourceRetired,
} from "./sheet-retirement";

const BOTH_LIVE = { ordersLive: false, partySheetLive: true };
const ERP_ORDERS = { ordersLive: true, partySheetLive: true };
const ALL_RETIRED = { ordersLive: true, partySheetLive: false };

test("while the sheet takes the orders, every read still runs", () => {
  for (const job of ["sheet-append", "sheet-reconcile", "sheet-payments", "taken-order-sync", "party-sync", "project-sheet"]) {
    assert.equal(retiredReason(job, BOTH_LIVE), null, job);
  }
});

test("once the ERP takes the orders, the order tabs stop and the party tab and its publish carry on", () => {
  for (const job of ["sheet-append", "sheet-reconcile", "sheet-payments", "taken-order-sync"]) {
    assert.equal(retiredReason(job, ERP_ORDERS), ORDER_TABS_RETIRED, job);
  }
  assert.equal(retiredReason("party-sync", ERP_ORDERS), null);
  // The projection still publishes the party master into customers.
  assert.equal(retiredReason("project-sheet", ERP_ORDERS), null);
});

test("retiring the party tab too stops the party read and the publish", () => {
  assert.equal(retiredReason("party-sync", ALL_RETIRED), PARTY_TAB_RETIRED);
  assert.equal(retiredReason("project-sheet", ALL_RETIRED), WHOLE_SHEET_RETIRED);
});

test("the party tab can be retired on its own, and the order publish still runs", () => {
  const partyOnly = { ordersLive: false, partySheetLive: false };
  assert.equal(retiredReason("party-sync", partyOnly), PARTY_TAB_RETIRED);
  assert.equal(retiredReason("project-sheet", partyOnly), null);
  assert.equal(retiredReason("sheet-append", partyOnly), null);
});

test("jobs that only re-read stored rows, and jobs that are not sheet reads, are never retired here", () => {
  for (const job of ["sheet-reparse", "taken-order-reparse", "nightly", "hourly", "erp-book-sync", "field-activity-append"]) {
    assert.equal(retiredReason(job, ALL_RETIRED), null, job);
  }
});

test("a missing party setting reads as live — retiring it is a decision somebody makes", () => {
  assert.deepEqual(sheetSwitches({ "erp.orders.live": false, "erp.orders.partySheet": undefined as unknown as boolean }), BOTH_LIVE);
  assert.deepEqual(sheetSwitches({ "erp.orders.live": true, "erp.orders.partySheet": false }), ALL_RETIRED);
});

test("the freshness rows follow the same answers as the jobs behind them", () => {
  assert.equal(sourceRetired("order_details", ERP_ORDERS), ORDER_TABS_RETIRED);
  assert.equal(sourceRetired("taken_order", ERP_ORDERS), ORDER_TABS_RETIRED);
  assert.equal(sourceRetired("sales_party", ERP_ORDERS), null);
  assert.equal(sourceRetired("publish", ERP_ORDERS), null);
  assert.equal(sourceRetired("publish", ALL_RETIRED), WHOLE_SHEET_RETIRED);
  assert.equal(sourceRetired("payment_status", BOTH_LIVE), null);
});
