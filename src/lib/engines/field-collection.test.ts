import test from "node:test";
import assert from "node:assert/strict";
import { allocate, type AllocatableBill } from "./allocation";
import { planFieldCollection } from "./field-collection";

const bills: AllocatableBill[] = [
  { id: "b1", billNo: "B1", billDate: "2026-07-01", amount: 10_000, paid: 10_000 }, // settled meanwhile
  { id: "b2", billNo: "B2", billDate: "2026-08-01", amount: 5_000, paid: 0 },
  { id: "b3", billNo: "B3", billDate: "2026-09-01", amount: 8_000, paid: 2_000 },
];

test("nothing named is the oldest-first spread, unflagged", () => {
  const plan = planFieldCollection(bills, { amountPaise: 3_000 });
  assert.equal(plan.request.mode, "auto");
  assert.equal(plan.flag, null);
});

test("every named bill still open settles them as before, unflagged", () => {
  const plan = planFieldCollection(bills, { amountPaise: 6_000, billIds: ["b3"] });
  assert.equal(plan.request.mode, "settle");
  assert.deepEqual(plan.request.selectedBillIds, ["b3"]);
  assert.equal(plan.flag, null);
});

test("a named bill settled meanwhile is accepted: named open bills first, then oldest, then on account — and flagged", () => {
  const plan = planFieldCollection(bills, { amountPaise: 15_000, billIds: ["b1", "b3"] });
  assert.equal(plan.request.mode, "custom");
  assert.deepEqual(plan.settledNamed, ["B1"]);
  assert.match(plan.flag ?? "", /B1.*already settled/);
  const result = allocate(bills, plan.request);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.lines.map((l) => [l.billId, l.amount]),
    [["b3", 6_000], ["b2", 5_000], [null, 4_000]],
  );
});

test("with nothing left open it all goes on account, still flagged", () => {
  const paidUp = bills.map((b) => ({ ...b, paid: b.amount }));
  const plan = planFieldCollection(paidUp, { amountPaise: 2_000, billIds: ["b2"] });
  assert.match(plan.flag ?? "", /on account/);
  const result = allocate(paidUp, plan.request);
  assert.deepEqual(result.lines, [{ billId: null, billNo: null, amount: 2_000 }]);
});

test("a bill no longer on the account at all is treated like a settled one", () => {
  const plan = planFieldCollection(bills, { amountPaise: 1_000, billIds: ["gone"] });
  assert.ok(plan.flag);
  assert.equal(allocate(bills, plan.request).lines[0].billId, "b2");
});
