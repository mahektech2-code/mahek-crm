import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDaysIso,
  allocationState,
  allocationTarget,
  billFigures,
  boxQuantity,
  daysBetween,
  labelCount,
  lotCosting,
  margin,
  monthId,
  orderType,
  standingInstructions,
  targetReached,
} from "./sales";

test("a line's type comes from the SKU's box type", () => {
  assert.equal(orderType("Empty Drum"), "Drum");
  assert.equal(orderType(null), "Can");
  assert.equal(orderType("Empty Box 5 Liter"), "Box");
});

test("boxes must come out whole, and a loose SKU has none", () => {
  assert.deepEqual(boxQuantity(24, 6, false), { boxes: 4, valid: true });
  assert.equal(boxQuantity(25, 6, false).valid, false);
  assert.deepEqual(boxQuantity(25, 1, true), { boxes: 0, valid: true });
  assert.equal(labelCount("Box", 4, 24), 4);
  assert.equal(labelCount("Can", 0, 25), 25);
});

test("allocation is done when it matches the target exactly, in boxes for a boxed SKU", () => {
  assert.equal(allocationTarget(true, 4, 24), 4);
  assert.equal(allocationState(4, 4), "Done");
  assert.equal(allocationState(4, 3), "Add More Quantity");
  assert.equal(allocationState(4, 5), "Remove Some Quantity");
});

test("the bill: rate on cans, or litres for a drum; discount off; GST on amount less discount plus transport", () => {
  const can = billFigures({ type: "Can", qtyCans: 10, litresPerCan: 5, ratePaise: 50000, discountBp: 1000, transportCostPaise: 20000, gstBp: 1800 });
  assert.equal(can.amountPaise, 500000);
  assert.equal(can.discountedPaise, 50000);
  assert.equal(can.finalPaise, Math.round((500000 - 50000 + 20000) * 1.18));
  assert.equal(can.company, "Mahek Marketing India");
  const drum = billFigures({ type: "Drum", qtyCans: 2, litresPerCan: 210, ratePaise: 12000, discountBp: 0, transportCostPaise: 0, gstBp: 0 });
  assert.equal(drum.amountPaise, 420 * 12000);
  assert.equal(drum.company, "Mylac");
  assert.equal(billFigures({ type: "Can", qtyCans: 1, litresPerCan: 1, ratePaise: null, discountBp: 0, transportCostPaise: 0, gstBp: 1800 }).finalPaise, null);
});

test("costing averages the allocated lots, and a margin needs it", () => {
  assert.equal(lotCosting({ type: "Can", qtyCans: 10, litres: 50, costs: [30000, 40000], extraPaise: 5000 }), 355000);
  assert.equal(lotCosting({ type: "Can", qtyCans: 10, litres: 50, costs: [30000, null], extraPaise: 0 }), null);
  assert.equal(margin({ amountPaise: 500000, discountedPaise: 50000, costingPaise: 355000, creditNotePaise: 10000 }), 85000);
});

test("dates: month id, fulfil days, due date", () => {
  assert.equal(monthId("2026-08-31"), "Aug2026");
  assert.equal(daysBetween("2026-08-28", "2026-09-02"), 5);
  assert.equal(addDaysIso("2026-09-20", 30), "2026-10-20");
});

test("standing instructions and the target flag (A-20)", () => {
  assert.equal(standingInstructions({ instructions: "Call first", deliveryType: "Door Delivery", paymentType: "Paid", weightType: null }), "Call first - Door Delivery - Paid - ");
  assert.equal(standingInstructions({ instructions: null, deliveryType: null, paymentType: null, weightType: null }), "");
  assert.equal(targetReached(100, 100), true);
  assert.equal(targetReached(100, null), false);
  assert.equal(targetReached(100, 0), false);
});
