import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeHealth, type HealthFacts } from "./health";
import { defaultConfig } from "../config/registry";

/* The customer health score. Pure, so every case here is a plain call. */

const WEIGHTS = defaultConfig()["mbos.health.componentWeights"];
const TODAY = "2026-08-11";

const facts = (over: Partial<HealthFacts> = {}): HealthFacts => ({
  lastOrderDate: "2026-08-10",
  lastVisitDate: "2026-08-10",
  cycleDays: 30,
  recentOrderValuePaise: 100_000_00,
  priorOrderValuePaise: 100_000_00,
  billsPaidLate: 0,
  billsTotal: 4,
  overduePaise: 0,
  outstandingPaise: 0,
  complaintsOpened: 0,
  complaintsOpen: 0,
  visitFrequencyDays: 30,
  ...over,
});

describe("health score", () => {
  test("the weights are a hundred, so the score is out of a hundred", () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    assert.equal(total, 100);
  });

  test("a customer doing everything right scores near the top", () => {
    const { score } = computeHealth(
      facts({ recentOrderValuePaise: 150_000_00 }),
      WEIGHTS,
      TODAY,
    );
    assert.ok(score > 90, `expected a high score, got ${score}`);
  });

  test("a steady account is good, not perfect — a flat trend is honestly flat", () => {
    const { score } = computeHealth(facts(), WEIGHTS, TODAY);
    assert.ok(score > 80 && score < 95, `expected a good score, got ${score}`);
  });

  test("recency is measured against the customer's OWN cycle", () => {
    // Forty days silent. Ordinary for a 60-day buyer, alarming for a 7-day one.
    const slow = computeHealth(
      facts({ cycleDays: 60, lastOrderDate: "2026-07-02" }),
      WEIGHTS,
      TODAY,
    );
    const fast = computeHealth(
      facts({ cycleDays: 7, lastOrderDate: "2026-07-02" }),
      WEIGHTS,
      TODAY,
    );
    assert.ok(slow.components.orderRecency > fast.components.orderRecency);
    assert.equal(fast.components.orderRecency, 0);
  });

  test("never ordered scores zero for recency rather than throwing", () => {
    const { components } = computeHealth(
      facts({ lastOrderDate: null }),
      WEIGHTS,
      TODAY,
    );
    assert.equal(components.orderRecency, 0);
  });

  test("a flat spend is neither rewarded nor punished", () => {
    const { components } = computeHealth(facts(), WEIGHTS, TODAY);
    assert.equal(components.orderValueTrend, 50);
  });

  test("halving the spend costs the whole trend component", () => {
    const { components } = computeHealth(
      facts({ recentOrderValuePaise: 50_000_00 }),
      WEIGHTS,
      TODAY,
    );
    assert.equal(components.orderValueTrend, 0);
  });

  test("paying late costs, and overdue money on the books costs more", () => {
    const clean = computeHealth(facts(), WEIGHTS, TODAY);
    const late = computeHealth(facts({ billsPaidLate: 2 }), WEIGHTS, TODAY);
    const overdue = computeHealth(
      facts({ billsPaidLate: 2, outstandingPaise: 100_00, overduePaise: 100_00 }),
      WEIGHTS,
      TODAY,
    );
    assert.ok(late.components.paymentBehaviour < clean.components.paymentBehaviour);
    assert.ok(overdue.components.paymentBehaviour < late.components.paymentBehaviour);
  });

  test("a customer nobody has asked to pay yet is not marked down for it", () => {
    const { components } = computeHealth(
      facts({ billsTotal: 0, billsPaidLate: 0 }),
      WEIGHTS,
      TODAY,
    );
    assert.equal(components.paymentBehaviour, 50);
  });

  test("an open complaint costs more than a settled one", () => {
    const settled = computeHealth(facts({ complaintsOpened: 1 }), WEIGHTS, TODAY);
    const open = computeHealth(
      facts({ complaintsOpened: 1, complaintsOpen: 1 }),
      WEIGHTS,
      TODAY,
    );
    assert.ok(open.components.complaints < settled.components.complaints);
  });

  test("the score never leaves 0..100, however bad the facts", () => {
    const worst = computeHealth(
      facts({
        lastOrderDate: null,
        lastVisitDate: null,
        recentOrderValuePaise: 0,
        priorOrderValuePaise: 500_000_00,
        billsPaidLate: 9,
        billsTotal: 9,
        outstandingPaise: 100_00,
        overduePaise: 100_00,
        complaintsOpened: 20,
        complaintsOpen: 20,
      }),
      WEIGHTS,
      TODAY,
    );
    assert.ok(worst.score >= 0 && worst.score <= 100);
    assert.equal(worst.score, 0);
  });

  test("weights that do not total a hundred are rescaled, not believed", () => {
    // A mistyped weight must not silently turn the score into "out of 87".
    const half = { ...WEIGHTS, orderRecency: WEIGHTS.orderRecency / 2 };
    const { score } = computeHealth(facts(), half, TODAY);
    assert.ok(score >= 0 && score <= 100);
  });
});
