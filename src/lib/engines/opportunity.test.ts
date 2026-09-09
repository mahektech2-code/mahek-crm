import test from "node:test";
import assert from "node:assert/strict";
import { annualise, opportunity } from "@/lib/engines/opportunity";

const TODAY = "2026-09-09T00:00:00.000Z";

test("no estimate is not a gap of zero", () => {
  /* Zero would read as "no opportunity here", which is a claim nobody made.
     Null says the true thing: nobody has judged this shop. */
  const o = opportunity({
    potentialMonthlyPaise: null,
    revenuePaise: 500_00,
    months: 1,
    estimatedAt: null,
    today: TODAY,
  });
  assert.equal(o.gapMonthlyPaise, null);
  assert.equal(o.potentialMonthlyPaise, null);
  /* Current sales are still measured — that half needs no estimate. */
  assert.equal(o.currentMonthlyPaise, 500_00);
});

test("the gap is never negative", () => {
  /* A shop buying more than somebody guessed is an estimate that has been
     overtaken, not a negative opportunity. "-₹40,000 opportunity" invites the
     reader to see a decline. */
  const o = opportunity({
    potentialMonthlyPaise: 50_000_00,
    revenuePaise: 90_000_00,
    months: 1,
    estimatedAt: TODAY,
    today: TODAY,
  });
  assert.equal(o.gapMonthlyPaise, 0);
  assert.equal(o.beatingEstimate, true);
});

test("revenue is averaged over its window, not read as one month", () => {
  /* A year of orders divided by twelve. Reading the whole year as a month would
     make every account look twelve times better than it is. */
  const o = opportunity({
    potentialMonthlyPaise: 100_000_00,
    revenuePaise: 120_000_00,
    months: 12,
    estimatedAt: TODAY,
    today: TODAY,
  });
  assert.equal(o.currentMonthlyPaise, 10_000_00);
  assert.equal(o.gapMonthlyPaise, 90_000_00);
});

test("a zero-month window cannot divide by zero", () => {
  const o = opportunity({
    potentialMonthlyPaise: 1000_00,
    revenuePaise: 500_00,
    months: 0,
    estimatedAt: TODAY,
    today: TODAY,
  });
  assert.equal(o.currentMonthlyPaise, 500_00);
});

test("the estimate carries its age, because nothing can verify it", () => {
  /* `products.priceSource` is unset, so nothing in MahekOne can derive what a
     shop could spend. "He thought this in 2024" is most of what a reader needs
     to know about a figure like that. */
  const o = opportunity({
    potentialMonthlyPaise: 10_000_00,
    revenuePaise: 0,
    months: 1,
    estimatedAt: "2026-06-09T00:00:00.000Z",
    today: TODAY,
  });
  assert.equal(o.estimateAgeDays, 92);
});

test("the annual figure is derived and never stored", () => {
  /* A stored copy is one that can disagree: somebody edits the month, the year
     stays where it was, and two screens quote two numbers for one shop. */
  assert.equal(annualise(10_000_00), 120_000_00);
  assert.equal(annualise(null), null);
});
