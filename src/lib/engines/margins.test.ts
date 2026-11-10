import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { bandOf, bridge, linePct, marginAlerts, rollup, totals, underFloor, type MarginLine, type MarginRules } from "./margins";

const RULES: MarginRules = { healthyAtOrAbove: 20, fairAtOrAbove: 12, thinAtOrAbove: 8, floorPercent: 12, targetPercent: 20, productDropPoints: 5, customerDropPercent: 30 };

let n = 0;
function line(p: Partial<MarginLine> = {}): MarginLine {
  n += 1;
  const amount = p.amountPaise ?? 100_000;
  const discount = p.discountPaise ?? 0;
  const lot = p.lotCostPaise === undefined ? 70_000 : p.lotCostPaise;
  const extra = p.extraPaise ?? 0;
  const cn = p.creditNotePaise ?? 0;
  return {
    id: `l${n}`, orderNo: p.orderNo ?? n, date: "2026-10-05", customerId: p.customerId ?? "c1", customer: p.customer ?? "Shop One",
    salesman: p.salesman ?? "Asha", state: "Maharashtra", district: "Pune", city: "Pune", godown: "Bhiwandi",
    product: p.product ?? "Nano 5 L", formulation: p.formulation ?? "Nano", lots: [], cans: p.cans ?? 10, litres: p.litres ?? 50,
    ratePaise: null, amountPaise: amount, discountPaise: discount, lotCostPaise: lot, extraPaise: extra, creditNotePaise: cn,
    marginPaise: p.marginPaise !== undefined ? p.marginPaise : lot == null ? null : amount - discount - lot - extra - cn,
    days: 1,
  };
}

describe("a line's margin", () => {
  test("is taken over sales after discount", () => {
    const l = line({ amountPaise: 100_000, discountPaise: 10_000, lotCostPaise: 72_000 });
    assert.equal(l.marginPaise, 18_000);
    assert.equal(linePct(l), 20);
  });
  test("is unknown, never 100%, without a lot cost", () => {
    const l = line({ lotCostPaise: null });
    assert.equal(l.marginPaise, null);
    assert.equal(linePct(l), null);
    assert.equal(bandOf(linePct(l), RULES), "nocost");
  });
});

describe("totals", () => {
  test("hold an uncosted line out of margin % but keep its sales", () => {
    const t = totals([line({ lotCostPaise: 60_000 }), line({ lotCostPaise: null })]);
    assert.equal(t.sales, 200_000);
    assert.equal(t.costedSales, 100_000);
    assert.equal(t.margin, 40_000);
    assert.equal(t.pct, 40);
    assert.equal(t.noCost, 1);
    assert.equal(t.noCostSales, 100_000);
  });
  test("count each order and customer once", () => {
    const t = totals([line({ orderNo: 1 }), line({ orderNo: 1 }), line({ orderNo: 2, customerId: "c2" })]);
    assert.equal(t.orders, 2);
    assert.equal(t.customers, 2);
  });
  test("give no percentage with nothing costed", () => {
    assert.equal(totals([line({ lotCostPaise: null })]).pct, null);
    assert.equal(totals([]).pct, null);
  });
});

describe("bands", () => {
  test("follow the rules' thresholds", () => {
    assert.equal(bandOf(25, RULES), "healthy");
    assert.equal(bandOf(20, RULES), "healthy");
    assert.equal(bandOf(15, RULES), "fair");
    assert.equal(bandOf(9, RULES), "thin");
    assert.equal(bandOf(-3, RULES), "loss");
  });
  test("under the floor is a line below it, and never an uncosted one", () => {
    assert.ok(underFloor(line({ lotCostPaise: 95_000 }), RULES));
    assert.ok(!underFloor(line({ lotCostPaise: 70_000 }), RULES));
    assert.ok(!underFloor(line({ lotCostPaise: null }), RULES));
  });
});

describe("the bridge", () => {
  test("adds up exactly from margin then to margin now", () => {
    const prev = [line({ product: "A", litres: 100, amountPaise: 100_000, lotCostPaise: 70_000 }), line({ product: "B", litres: 50, amountPaise: 60_000, lotCostPaise: 30_000 })];
    const cur = [
      line({ product: "A", litres: 150, amountPaise: 160_000, lotCostPaise: 110_000, extraPaise: 2_000 }),
      line({ product: "C", litres: 20, amountPaise: 30_000, lotCostPaise: 10_000 }),
    ];
    const b = bridge(cur, prev);
    const sum = b.prevMargin + b.volume + b.price + b.cost + b.leakage + b.mix;
    assert.ok(Math.abs(sum - b.margin) < 1e-6);
    assert.equal(b.margin, totals(cur).margin);
    assert.equal(b.leakage, -2_000);
  });
  test("reads a rate rise on the same product as price, not volume", () => {
    const prev = [line({ product: "A", litres: 100, amountPaise: 100_000, lotCostPaise: 70_000 })];
    const cur = [line({ product: "A", litres: 100, amountPaise: 110_000, lotCostPaise: 70_000 })];
    const b = bridge(cur, prev);
    assert.equal(b.volume, 0);
    assert.equal(b.price, 10_000);
    assert.equal(b.cost, 0);
    assert.ok(Math.abs(b.mix) < 1e-6);
  });
  test("leaves an uncosted line's expenses out, so Mix does not have to cancel them", () => {
    const prev = [line({ product: "A", litres: 100, amountPaise: 100_000, lotCostPaise: 70_000 })];
    const cur = [line({ product: "A", litres: 100, amountPaise: 100_000, lotCostPaise: 70_000 }), line({ product: "B", lotCostPaise: null, extraPaise: 5_000 })];
    const b = bridge(cur, prev);
    assert.equal(b.leakage, 0);
    assert.ok(Math.abs(b.mix) < 1e-6);
  });
  test("reads a dearer lot as cost", () => {
    const prev = [line({ product: "A", litres: 100, amountPaise: 100_000, lotCostPaise: 70_000 })];
    const cur = [line({ product: "A", litres: 100, amountPaise: 100_000, lotCostPaise: 80_000 })];
    assert.equal(bridge(cur, prev).cost, -10_000);
  });
});

describe("rollups and alerts", () => {
  test("pair a key with its previous period", () => {
    const r = rollup([line({ product: "A" }), line({ product: "B" })], [line({ product: "A" })], (l) => l.product);
    assert.ok(r.find((x) => x.key === "A")!.prev);
    assert.equal(r.find((x) => x.key === "B")!.prev, null);
  });
  test("raise under-floor and no-cost alerts from the lines alone", () => {
    const a = marginAlerts([line({ lotCostPaise: 95_000 }), line({ lotCostPaise: null })], null, RULES, (p) => String(p));
    assert.deepEqual(a.map((x) => x.id), ["under", "nocost"]);
  });
  test("raise a product drop only past the configured points", () => {
    const prev = [line({ product: "A", lotCostPaise: 70_000 })];
    const slight = marginAlerts([line({ product: "A", lotCostPaise: 72_000 })], prev, RULES, String);
    assert.ok(!slight.some((x) => x.id === "drop:A"));
    const big = marginAlerts([line({ product: "A", lotCostPaise: 80_000 })], prev, RULES, String);
    assert.ok(big.some((x) => x.id === "drop:A"));
  });
});
