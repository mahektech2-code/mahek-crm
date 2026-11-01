import { test } from "node:test";
import assert from "node:assert/strict";
import { roundBill, roundedTotal } from "./bill-round";

test("a bill's total goes to the nearest rupee, fifty paise up, with the round off said", () => {
  assert.deepEqual(roundBill(1044962), { totalPaise: 1045000, roundOffPaise: 38 });
  assert.deepEqual(roundBill(1044949), { totalPaise: 1044900, roundOffPaise: -49 });
  assert.deepEqual(roundBill(1044950), { totalPaise: 1045000, roundOffPaise: 50 }, "fifty paise goes up, as Tally does");
  assert.deepEqual(roundBill(1045000), { totalPaise: 1045000, roundOffPaise: 0 }, "a round figure is left alone");
  assert.deepEqual(roundBill(0), { totalPaise: 0, roundOffPaise: 0 });
});

test("a negative total rounds the same way, away from zero at fifty paise", () => {
  assert.deepEqual(roundBill(-1050), { totalPaise: -1100, roundOffPaise: -50 });
  assert.deepEqual(roundBill(-1049), { totalPaise: -1000, roundOffPaise: 49 });
});

test("a fractional paise figure is taken to the paisa first", () => {
  assert.equal(roundedTotal(1049.6), 1100);
  assert.equal(roundedTotal(1049.4), 1000);
});
