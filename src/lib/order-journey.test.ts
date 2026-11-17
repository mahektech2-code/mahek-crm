import { test } from "node:test";
import assert from "node:assert/strict";
import { journeyOf, tabOf, type IntakeFacts, type ErpOrderFacts } from "./order-journey";

const intake = (o: Partial<IntakeFacts> = {}): IntakeFacts => ({
  toNo: 1042,
  status: "open",
  takenAt: "2026-11-16T04:44:00.000Z",
  takenBy: "Priya",
  backOfficeAt: null,
  backOfficeBy: null,
  productionAt: null,
  productionBy: null,
  correctionAt: null,
  correctionNote: null,
  heldAt: null,
  holdReason: null,
  cancelledAt: null,
  cancelReason: null,
  orderNo: null,
  ...o,
});
const order = (o: Partial<ErpOrderFacts> = {}): ErpOrderFacts => ({
  orderNo: 5821,
  accountsCheck: "Pending",
  accountsAt: null,
  accountsBy: null,
  productionCheck: "Pending",
  productionAt: null,
  productionBy: null,
  cancelled: false,
  holds: [],
  milestones: [],
  ...o,
});
const book = { status: "pending_approval", at: "2026-11-16T04:44:00.000Z", approvedAt: null, declineReason: null };

test("an open TO is the TO number, waiting for Accounts, and can be changed", () => {
  const j = journeyOf({ intake: intake(), order: null, book });
  assert.equal(j.title, "TO-1042");
  assert.equal(j.status, "Waiting for Accounts");
  assert.equal(j.state, "open");
  assert.equal(j.editable, true);
  assert.equal(tabOf(j), "to");
  assert.equal(j.steps.find((s) => s.key === "checked"), undefined);
  assert.equal(j.steps.find((s) => s.key === "accounts")?.state, "current");
  assert.equal(j.steps.find((s) => s.key === "production")?.state, "todo");
});

test("a TO the office flagged at sync is a possible duplicate, still waiting and still editable", () => {
  const j = journeyOf({ intake: intake({ duplicateState: "possible", duplicateOfToNo: 1040, origin: "mbos" }), order: null, book });
  assert.equal(j.status, "Possible duplicate");
  assert.equal(j.state, "possible_duplicate");
  assert.equal(j.duplicateOfToNo, 1040);
  assert.equal(j.editable, true);
  assert.match(j.banner ?? "", /no signal.*TO-1040.*Accounts will check/);
});

test("a TO the taker said is a different order is just waiting for Accounts", () => {
  const j = journeyOf({ intake: intake({ duplicateState: "different", duplicateOfToNo: 1040, duplicateReason: "second lorry" }), order: null, book });
  assert.equal(j.state, "open");
  assert.equal(j.duplicateOfToNo, null);
});

test("a TO Accounts declined says why and cannot be changed", () => {
  const j = journeyOf({ intake: intake({ status: "declined", declinedAt: "2026-11-16T06:00:00.000Z", declineReason: "Bills 60 days overdue" }), order: null, book });
  assert.equal(j.status, "Declined");
  assert.equal(j.state, "declined");
  assert.equal(j.reason, "Bills 60 days overdue");
  assert.equal(j.editable, false);
  assert.equal(tabOf(j), "done");
  assert.match(j.events.at(-1)!.text, /Declined by Accounts: Bills/);
});

test("a TO sent back says why and can still be changed", () => {
  const j = journeyOf({ intake: intake({ status: "correction", correctionAt: "2026-11-16T05:00:00.000Z", correctionNote: "Wrong pack" }), order: null, book });
  assert.equal(j.status, "Sent back by Accounts");
  assert.equal(j.state, "correction");
  assert.equal(j.reason, "Wrong pack");
  assert.equal(j.editable, true);
  assert.match(j.banner ?? "", /Wrong pack/);
  assert.equal(tabOf(j), "hold");
});

test("once Accounts approve it, it is Order N, from its TO, never editable, and at the MRP check", () => {
  const j = journeyOf({ intake: intake({ status: "verified", orderNo: 5821, backOfficeAt: "2026-11-16T04:52:00.000Z" }), order: order({ accountsCheck: "Approved", accountsAt: "2026-11-16T04:52:00.000Z" }), book });
  assert.equal(j.title, "Order 5821");
  assert.equal(j.toNo, 1042);
  assert.equal(j.editable, false);
  assert.equal(j.state, "approved");
  assert.equal(j.status, "Approved · MRP check");
  assert.equal(j.steps.find((s) => s.key === "accounts")?.state, "done");
  assert.equal(j.steps.find((s) => s.key === "production")?.state, "current");
  assert.equal(tabOf(j), "moving");
});

test("an open hold names its desk and its sentence", () => {
  const j = journeyOf({
    intake: intake({ status: "verified", orderNo: 5821 }),
    order: order({ holds: [{ department: "accounts", reason: "advance", text: "NEFT not in the bank yet", at: "2026-11-17T05:50:00.000Z", resolvedAt: null }] }),
    book,
  });
  assert.equal(j.status, "On hold · accounts");
  assert.match(j.banner ?? "", /NEFT/);
  assert.equal(j.steps.find((s) => s.key === "accounts")?.state, "hold");
});

test("approved and MRP cleared; milestones move it on to delivered", () => {
  const base = { intake: intake({ status: "verified", orderNo: 5821 }), book };
  assert.equal(journeyOf({ ...base, order: order({ accountsCheck: "Approved", accountsAt: "2026-11-16T06:10:00.000Z", productionCheck: "Cleared" }) }).status, "Approved · MRP cleared");
  const done = journeyOf({ ...base, order: order({ accountsCheck: "Approved", productionCheck: "Cleared", milestones: [{ step: "invoice", at: "2026-11-19T08:35:00.000Z", note: null }, { step: "delivered", at: "2026-11-21T08:35:00.000Z", note: null }] }) });
  assert.equal(done.status, "Delivered");
  assert.equal(tabOf(done), "done");
  assert.equal(done.steps.find((s) => s.key === "billed")?.state, "done");
});

test("events are in the order they happened", () => {
  const j = journeyOf({
    intake: intake({ status: "verified", orderNo: 5821, backOfficeAt: "2026-11-16T04:52:00.000Z", productionAt: "2026-11-16T05:58:00.000Z" }),
    order: order({ accountsCheck: "Approved", accountsAt: "2026-11-16T06:10:00.000Z" }),
    book,
  });
  const at = j.events.map((e) => e.at);
  assert.deepEqual(at, [...at].sort());
  assert.match(j.events.at(-1)!.text, /Approved by Accounts.*Order number 5821/);
});

test("an order that never went through the hub reads its book status", () => {
  const j = journeyOf({ intake: null, order: null, book: { ...book, status: "confirmed", approvedAt: "2026-11-16T06:10:00.000Z" } });
  assert.equal(j.status, "Approved");
  assert.equal(j.editable, false);
});
