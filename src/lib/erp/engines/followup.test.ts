import { test } from "node:test";
import assert from "node:assert/strict";
import { callingDate, cashBalances, cashKey, followFigures } from "./followup";

test("the previous order is by date, not row position, and the product gap is its own (A-22)", () => {
  const f = followFigures([
    { id: "c", party: "P", product: "Thinner", date: "2026-03-31" },
    { id: "a", party: "P", product: "Thinner", date: "2026-03-01" },
    { id: "b", party: "P", product: "Primer", date: "2026-03-11" },
    { id: "b2", party: "P", product: "Thinner", date: "2026-03-11" },
  ]);
  assert.equal(f.get("a")!.lastParty, null);
  assert.equal(f.get("c")!.lastParty, "2026-03-11");
  assert.equal(f.get("c")!.dayCountParty, 20);
  assert.equal(f.get("c")!.lastProduct, "2026-03-11");
  assert.equal(f.get("b")!.lastProduct, null, "first primer order");
  assert.equal(f.get("c")!.averageDays, 15, "gaps of 10 and 20 days");
  assert.equal(f.get("c")!.nextOrder, "2026-04-15");
  assert.equal(f.get("a")!.nextOrder, null, "no previous order, no prediction");
  assert.equal(callingDate("2026-04-15", 3), "2026-04-18");
});

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
