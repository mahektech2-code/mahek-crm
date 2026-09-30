import { test } from "node:test";
import assert from "node:assert/strict";
import { balances, checkApproval, checkRequest, holidayApplies, holidaysInside, leaveDays } from "./leave";

test("leave days: inclusive; a half day is half", () => {
  assert.equal(leaveDays("Leave", "2026-10-05", "2026-10-07"), 3);
  assert.equal(leaveDays("Half Day", "2026-10-05", "2026-10-05"), 0.5);
});

test("the apply form refuses a clash, a backwards range and a month boundary", () => {
  assert.equal(checkRequest({ type: "Leave", start: "2026-10-05", end: "2026-10-07", clash: null }), null);
  assert.match(checkRequest({ type: "Leave", start: "2026-10-05", end: "2026-10-05", clash: { type: "Leave", status: "Requesting" } })!.message, /already added/);
  assert.equal(checkRequest({ type: "Leave", start: "2026-10-05", end: "2026-10-04", clash: null })!.field, "end");
  assert.match(checkRequest({ type: "Leave", start: "2026-10-30", end: "2026-11-02", clash: null })!.message, /Same Month/);
});

test("balances: paid is the month's credit, unpaid the year's maximum", () => {
  const b = balances({
    month: "2026-10",
    credits: [{ month: "2026-10", days: 1.5 }, { month: "2026-09", days: 1.5 }],
    approved: [
      { startDate: "2026-10-02", paid: 1, unpaid: 0 },
      { startDate: "2026-03-02", paid: 0, unpaid: 2 },
    ],
    yearlyMax: 12,
  });
  assert.deepEqual(b, { paid: 0.5, unpaid: 10 });
});

test("approval split: invalid, insufficient paid, insufficient unpaid", () => {
  const b = { paid: 1, unpaid: 1 };
  assert.equal(checkApproval(2, 1, b), null);
  assert.equal(checkApproval(2, 3, b), "INVALID");
  assert.equal(checkApproval(2, 1.5, b), "Insufficient Paid Leave");
  assert.equal(checkApproval(3, 1, b), "Insufficient Unpaid Leave");
});

test("holidays apply to all, to an office, or to a named person", () => {
  const hs = [
    { date: "2026-10-02", tagged: "All employees", taggedEmployeeIds: [] },
    { date: "2026-10-03", tagged: "Thane", taggedEmployeeIds: [] },
    { date: "2026-10-04", tagged: "Selected", taggedEmployeeIds: ["e1"] },
  ];
  assert.equal(holidayApplies(hs[1], "e2", "Thane"), true);
  assert.equal(holidayApplies(hs[1], "e2", "Pune"), false);
  assert.equal(holidaysInside(hs, "e1", "Pune", "2026-10-01", "2026-10-31"), 2);
});
