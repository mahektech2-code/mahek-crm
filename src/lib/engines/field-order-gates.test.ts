import test from "node:test";
import assert from "node:assert/strict";
import { overdueBlockingBill } from "./field-order-gates";

const bill = (over: Partial<Parameters<typeof overdueBlockingBill>[0][number]> = {}) => ({
  billNo: "MMI/26-27/1",
  balance: 10_000,
  overdueDays: 100,
  paymentPosition: "owed",
  disputed: false,
  ...over,
});

test("0 switches the overdue block off", () => {
  assert.equal(overdueBlockingBill([bill()], 0), null);
});

test("a bill at or past the threshold blocks, naming the oldest", () => {
  const got = overdueBlockingBill([bill({ billNo: "A", overdueDays: 95 }), bill({ billNo: "B", overdueDays: 120 })], 90);
  assert.deepEqual(got, { billNo: "B", overdueDays: 120 });
  assert.deepEqual(overdueBlockingBill([bill({ overdueDays: 90 })], 90)?.overdueDays, 90);
});

test("a bill short of the threshold, settled, unstated or disputed does not block", () => {
  assert.equal(overdueBlockingBill([bill({ overdueDays: 89 })], 90), null);
  assert.equal(overdueBlockingBill([bill({ balance: 0 })], 90), null);
  assert.equal(overdueBlockingBill([bill({ paymentPosition: "unstated" })], 90), null);
  assert.equal(overdueBlockingBill([bill({ disputed: true })], 90), null);
});
