import { test } from "node:test";
import assert from "node:assert/strict";
import { cashBalances, cashKey } from "./cash";

test("cash in hand is credits less what that person spent (A-24)", () => {
  const b = cashBalances(
    [
      { employee: "Ravi", godownId: "g1", mode: "Cash", amountPaise: 500000 },
      { employee: "Ravi", godownId: "g1", mode: "Bank Cash", amountPaise: 100000 },
    ],
    [{ employee: "ravi ", godownId: "g1", mode: "Cash", amountPaise: 120000 }],
  );
  assert.equal(b.get(cashKey("Ravi", "g1", "Cash")), 380000);
  assert.equal(b.get(cashKey("Ravi", "g1", "Bank Cash")), 100000);
});
