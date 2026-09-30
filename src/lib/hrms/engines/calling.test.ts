import { test } from "node:test";
import assert from "node:assert/strict";
import { callingTab, checkCall, followUpSelection, suggestion, totalOrders } from "./calling";

test("suggestion: calls − 7 × orders ≤ 7 follows up, above it deactivates (A32)", () => {
  assert.equal(suggestion(7, 0), "Do FollowUp");
  assert.equal(suggestion(8, 0), "Do Deactivate This Customer");
  assert.equal(suggestion(14, 1), "Do FollowUp");
  assert.equal(suggestion(15, 1), "Do Deactivate This Customer");
  assert.equal(suggestion(0, 0), "Do FollowUp");
});

test("suggestion reads a configured factor and threshold", () => {
  assert.equal(suggestion(10, 1, { factor: 5, threshold: 5 }), "Do FollowUp");
  assert.equal(suggestion(11, 1, { factor: 5, threshold: 5 }), "Do Deactivate This Customer");
});

test("total orders counts Order Received, not the source's misspelling (A29)", () => {
  assert.equal(totalOrders([{ status: "Order Received" }, { status: "order recieved" }, { status: "" }, { status: null }]), 1);
});

test("calling tab: blank status is To call, whatever the dates say", () => {
  assert.equal(callingTab({ date: "2026-01-01", status: "", secondStatus: null, followUp: "2025-01-01" }, "2026-10-01", 10), "To call");
});

test("calling tab: a follow-up due today with no second status is due", () => {
  const r = { date: "2026-09-01", status: "Reminder Call Back", secondStatus: null, followUp: "2026-10-01" };
  assert.equal(callingTab(r, "2026-10-01", 10), "Follow-ups due");
  assert.equal(callingTab({ ...r, secondStatus: "Busy" }, "2026-10-01", 10), "Older");
  assert.equal(callingTab({ ...r, followUp: "2026-10-02" }, "2026-10-01", 10), "Older");
});

test("calling tab: history is the last N days, inclusive", () => {
  const r = { status: "No Requirement", secondStatus: null, followUp: null };
  assert.equal(callingTab({ ...r, date: "2026-09-21" }, "2026-10-01", 10), "History");
  assert.equal(callingTab({ ...r, date: "2026-09-20" }, "2026-10-01", 10), "Older");
});

test("log call: second status required when not picked up; follow-up never in the past", () => {
  assert.equal(checkCall({ status: "", second: "", followUp: "" }, "2026-10-01")?.field, "status");
  assert.equal(checkCall({ status: "Call Not Pick Up", second: "", followUp: "" }, "2026-10-01")?.field, "second");
  assert.equal(checkCall({ status: "Call Not Pick Up", second: "Reminder Call Back", followUp: "2026-10-01" }, "2026-10-01"), null);
  assert.equal(checkCall({ status: "Order Received", second: "", followUp: "2026-09-30" }, "2026-10-01")?.message, "INVALID");
});

test("take follow-up: my active customers of the area, not already called today (A34)", () => {
  const cs = [
    { id: "a", area: "Thane", active: true, mine: true },
    { id: "b", area: " thane ", active: true, mine: true },
    { id: "c", area: "Thane", active: false, mine: true },
    { id: "d", area: "Thane", active: true, mine: false },
    { id: "e", area: "Kalyan", active: true, mine: true },
    { id: "f", area: "Thane", active: true, mine: true },
    { id: "g", area: "Thane", active: true, mine: true },
  ];
  assert.deepEqual(followUpSelection("Thane", cs, new Set(["f"]), new Set(["g"])), ["a", "b"]);
  assert.deepEqual(followUpSelection("", cs, new Set()), []);
});
