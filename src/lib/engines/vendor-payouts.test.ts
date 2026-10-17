import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dueDateFor,
  groupPurchaseLots,
  isPaymentDay,
  moveRefusal,
  paymentDayOnOrAfter,
  paymentWeekdays,
  payoutTone,
  plannedPayOn,
  replannedPayOn,
  weekStart,
  weekdayOf,
  type RegisterLot,
} from "./vendor-payouts";

const TUE_TO_FRI = paymentWeekdays(["Tuesday", "Wednesday", "Thursday", "Friday"]);

test("payment days are read by name and ignore what is not a weekday", () => {
  assert.deepEqual([...paymentWeekdays(["tuesday", " Friday ", "Payday"])].sort(), [2, 5]);
  // 2026-10-06 is a Tuesday, 10-10 a Saturday, 10-12 a Monday.
  assert.equal(weekdayOf("2026-10-06"), 2);
  assert.equal(weekdayOf("2026-10-11"), 7);
  assert.equal(isPaymentDay("2026-10-06", TUE_TO_FRI), true);
  assert.equal(isPaymentDay("2026-10-12", TUE_TO_FRI), false);
});

test("a date that is not a payment day rolls forward to the next one", () => {
  assert.equal(paymentDayOnOrAfter("2026-10-08", TUE_TO_FRI), "2026-10-08"); // Thursday stays
  assert.equal(paymentDayOnOrAfter("2026-10-10", TUE_TO_FRI), "2026-10-13"); // Saturday → Tuesday
  assert.equal(paymentDayOnOrAfter("2026-10-12", TUE_TO_FRI), "2026-10-13"); // Monday → Tuesday
});

test("due is the purchase date plus the supplier's credit days, else the default", () => {
  assert.equal(dueDateFor("2026-09-01", 15, 30), "2026-09-16");
  assert.equal(dueDateFor("2026-09-01", null, 30), "2026-10-01");
  assert.equal(dueDateFor("2026-09-01", 0, 30), "2026-09-01");
});

test("a payout is planned on or after its due date, never in the past", () => {
  // Due Saturday the 17th → Tuesday the 20th.
  assert.equal(plannedPayOn("2026-10-17", "2026-10-08", TUE_TO_FRI), "2026-10-20");
  // Due last week and still unpaid → the next payment day from today (Thursday).
  assert.equal(plannedPayOn("2026-09-30", "2026-10-08", TUE_TO_FRI), "2026-10-08");
  // Today is a Monday and the due date has gone → Tuesday.
  assert.equal(plannedPayOn("2026-09-30", "2026-10-12", TUE_TO_FRI), "2026-10-13");
});

test("a payout moves only onto a payment day that has not gone", () => {
  const today = "2026-10-08";
  assert.equal(moveRefusal("2026-10-09", today, TUE_TO_FRI, "open"), null);
  assert.match(moveRefusal("2026-10-10", today, TUE_TO_FRI, "open")!, /Tuesday, Wednesday, Thursday and Friday — not on a Saturday/);
  assert.match(moveRefusal("2026-10-07", today, TUE_TO_FRI, "open")!, /day that has gone/);
  assert.match(moveRefusal("2026-10-09", today, TUE_TO_FRI, "paid")!, /already paid/);
  assert.equal(moveRefusal("2026-10-09", today, TUE_TO_FRI, "on_hold"), null);
});

test("the tone says paid, held, overdue, today, after due or planned", () => {
  const t = "2026-10-08";
  assert.equal(payoutTone({ status: "paid", payOn: "2026-10-01", dueDate: "2026-10-01" }, t), "paid");
  assert.equal(payoutTone({ status: "on_hold", payOn: "2026-10-01", dueDate: "2026-10-01" }, t), "held");
  assert.equal(payoutTone({ status: "open", payOn: "2026-10-07", dueDate: "2026-10-01" }, t), "overdue");
  assert.equal(payoutTone({ status: "open", payOn: t, dueDate: t }, t), "today");
  assert.equal(payoutTone({ status: "open", payOn: "2026-10-14", dueDate: "2026-10-09" }, t), "late");
  assert.equal(payoutTone({ status: "open", payOn: "2026-10-09", dueDate: "2026-10-14" }, t), "upcoming");
});

test("register lots become one payout per supplier per PR, worth the register's final figure", () => {
  const lot = (o: Partial<RegisterLot>): RegisterLot => ({
    id: "l",
    prNumber: 7,
    purchaseDate: "2026-09-10",
    supplierId: "s1",
    supplierName: "Shree Chem",
    supplierCreditDays: 15,
    poId: null,
    billNumber: null,
    status: "Pending",
    quantity: 100,
    unit: "Litre",
    ratePaise: 10_000,
    density: null,
    feedAdjustedLitre: 0,
    feedAdjustedAmountPaise: 0,
    gstBp: 1800,
    drums: null,
    ...o,
  });
  const groups = groupPurchaseLots([
    lot({ id: "a", billNumber: "B-1" }),
    lot({ id: "b", purchaseDate: "2026-09-09", poId: "po1", billNumber: "B-1" }),
    lot({ id: "c", billNumber: "B-2", feedAdjustedAmountPaise: 18_000 }),
    lot({ id: "d", ratePaise: null }), // no rate, no figure — left out
    lot({ id: "e", prNumber: 8, supplierId: "s2", ratePaise: null }), // a group with no rated lot is no payout
  ]);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.key, "s1|7");
  assert.equal(g.lots, 3);
  // 100 × ₹100 = ₹10,000 + 18% = ₹11,800 each; the third less ₹180.
  assert.equal(g.amountPaise, 1_180_000 * 3 - 18_000);
  assert.equal(g.purchaseDate, "2026-09-09");
  assert.equal(g.poId, "po1");
  assert.equal(g.reference, "B-1, B-2");
});

test("a week starts on Monday", () => {
  assert.equal(weekStart("2026-10-08"), "2026-10-05");
  assert.equal(weekStart("2026-10-11"), "2026-10-05");
  assert.equal(weekStart("2026-10-12"), "2026-10-12");
});

test("payouts nobody moved leave days that stop being payment days", () => {
  const TUE_FRI = paymentWeekdays(["Tuesday", "Friday"]);
  const today = "2026-10-08"; // Thursday
  // Planned for next Wednesday → that Friday.
  assert.equal(replannedPayOn({ status: "open", payOn: "2026-10-14", decided: false }, today, TUE_FRI), "2026-10-16");
  // Today, a Thursday → Friday.
  assert.equal(replannedPayOn({ status: "on_hold", payOn: "2026-10-08", decided: false }, today, TUE_FRI), "2026-10-09");
  // Already a payment day, chosen by a person, overdue, or settled → left alone.
  assert.equal(replannedPayOn({ status: "open", payOn: "2026-10-13", decided: false }, today, TUE_FRI), null);
  assert.equal(replannedPayOn({ status: "open", payOn: "2026-10-14", decided: true }, today, TUE_FRI), null);
  assert.equal(replannedPayOn({ status: "open", payOn: "2026-10-07", decided: false }, today, TUE_FRI), null);
  assert.equal(replannedPayOn({ status: "paid", payOn: "2026-10-14", decided: false }, today, TUE_FRI), null);
  assert.match(moveRefusal("2026-10-14", today, TUE_FRI, "open")!, /Tuesday and Friday — not on a Wednesday/);
});
