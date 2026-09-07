import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  duplicateCandidates,
  kmAnomalies,
  median,
  ownerAlerts,
  spendAnomalies,
  type ClaimFacts,
} from "./expense-fraud";
import {
  coca,
  customerReturn,
  purposeDisagreesWithHistory,
  rank,
  salesPerKm,
  salesPerVisit,
  salesmanReturn,
  servicingCost,
  splitSpend,
  topAndBottom,
  totalSalesmanCost,
  travelExpenseRatioBps,
  type SalesmanPeriod,
} from "./sales-roi";

/* ------------------------------------------------------------ §I47 dupes */

const claim = (over: Partial<ClaimFacts> = {}): ClaimFacts => ({
  id: "c1",
  userId: "u1",
  expenseDate: "2026-09-07",
  kind: "local_transport",
  claimedPaise: 20000,
  vendorName: null,
  billNumber: null,
  billHash: null,
  reference: null,
  ...over,
});

const OPTS = { windowDays: 30, nearAmountBps: 500 };

describe("duplicate claims", () => {
  test("the same bill photograph is certain, even at a different amount", () => {
    const hits = duplicateCandidates(
      claim({ billHash: "abc", claimedPaise: 30000 }),
      [claim({ id: "c2", billHash: "abc", claimedPaise: 20000 })],
      OPTS,
    );
    assert.equal(hits[0]!.strength, "certain");
    assert.match(hits[0]!.reason, /different amount/);
  });

  test("the same bill number is certain, and names the amounts when they differ", () => {
    const hits = duplicateCandidates(
      claim({ billNumber: "INV-4471", claimedPaise: 30000 }),
      [claim({ id: "c2", billNumber: "inv 4471", claimedPaise: 20000 })],
      OPTS,
    );
    assert.equal(hits[0]!.strength, "certain");
    assert.match(hits[0]!.reason, /₹200 rather than ₹300/);
  });

  test("a reference too short to name anything matches nothing", () => {
    const hits = duplicateCandidates(
      claim({ billNumber: "NA", kind: "other" }),
      [claim({ id: "c2", billNumber: "NA", kind: "other", expenseDate: "2026-08-01" })],
      OPTS,
    );
    assert.equal(hits.length, 0);
  });

  test("two claims with nothing to match on match on nothing", () => {
    const hits = duplicateCandidates(
      claim({ expenseDate: "2026-09-07" }),
      [claim({ id: "c2", expenseDate: "2026-08-20" })],
      OPTS,
    );
    assert.equal(hits.length, 0, "different days, no reference, no vendor");
  });

  test("same vendor, same day, same amount is likely rather than certain", () => {
    const hits = duplicateCandidates(
      claim({ vendorName: "Shell Wadala" }),
      [claim({ id: "c2", vendorName: "shell wadala" })],
      OPTS,
    );
    assert.equal(hits[0]!.strength, "likely");
  });

  test("the same amount on the same day is a QUESTION, not an accusation", () => {
    const hits = duplicateCandidates(claim({}), [claim({ id: "c2" })], OPTS);
    assert.equal(hits[0]!.strength, "possible");
    assert.match(hits[0]!.reason, /is this a second one\?/);
  });

  test("outside the window nothing matches, however identical", () => {
    const hits = duplicateCandidates(
      claim({ billNumber: "INV-4471" }),
      [claim({ id: "c2", billNumber: "INV-4471", expenseDate: "2025-01-01" })],
      OPTS,
    );
    assert.equal(hits.length, 0);
  });

  test("strongest first", () => {
    const hits = duplicateCandidates(
      claim({ billNumber: "INV-4471", vendorName: "Shell" }),
      [claim({ id: "weak" }), claim({ id: "strong", billNumber: "INV-4471" })],
      OPTS,
    );
    assert.equal(hits[0]!.otherId, "strong");
  });
});

/* ------------------------------------------------------- §I48/§I49 bands */

describe("abnormal distance and spending", () => {
  const bands = { dailyKmCeiling: 300, aboveOwnMedianBps: 10000, varianceFlagBps: 2500 };

  test("the median is the middle, so one huge day does not hide the next", () => {
    assert.equal(median([10, 20, 30]), 20);
    assert.equal(median([10, 20, 30, 400_000]), 25);
    assert.equal(median([]), null);
  });

  test("a day over the ceiling is questioned", () => {
    const out = kmAnomalies({ totalMetres: 420_000, gpsMetres: null, odometerMetres: null }, { dailyMetres: [] }, bands);
    assert.equal(out[0]!.kind, "over_km_ceiling");
  });

  test("a day well above his own usual is questioned, with both numbers in it", () => {
    const out = kmAnomalies(
      { totalMetres: 250_000, gpsMetres: null, odometerMetres: null },
      { dailyMetres: [80_000, 84_000, 90_000, 76_000, 88_000] },
      bands,
    );
    assert.equal(out.length, 1);
    assert.match(out[0]!.message, /against his own usual/);
    assert.equal(out[0]!.detail.ownMedianMetres, 84_000);
  });

  test("too little history raises nothing — a flag against a second week is not a finding", () => {
    const out = kmAnomalies(
      { totalMetres: 250_000, gpsMetres: null, odometerMetres: null },
      { dailyMetres: [80_000, 84_000] },
      bands,
    );
    assert.equal(out.length, 0);
  });

  test("GPS and the odometer disagreeing across the day is its own finding", () => {
    const out = kmAnomalies(
      { totalMetres: 100_000, gpsMetres: 30_000, odometerMetres: 100_000 },
      { dailyMetres: [] },
      bands,
    );
    assert.equal(out[0]!.kind, "gps_odometer_variance");
  });

  test("spending above his own is a warning; above the team's is a note", () => {
    const own = [200000, 210000, 190000, 205000, 195000];
    const team = [220000, 230000, 210000, 240000, 225000];
    const out = spendAnomalies(600000, own, team, {
      aboveOwnMedianBps: 10000,
      aboveTeamMedianBps: 10000,
    });
    assert.equal(out.length, 2);
    assert.equal(out[0]!.severity, "warn");
    assert.equal(out[1]!.severity, "info");
  });

  test("the owner's list drops the notes and keeps the blockers first", () => {
    const alerts = ownerAlerts([
      { kind: "day_hotel", severity: "info", message: "a", detail: {} },
      { kind: "over_cap", severity: "warn", message: "b", detail: {} },
      { kind: "missing_proof", severity: "block_route", message: "c", detail: {} },
    ]);
    assert.deepEqual(alerts.map((a) => a.message), ["c", "b"]);
  });
});

/* --------------------------------------------------------------- §K ratios */

const person = (over: Partial<SalesmanPeriod> = {}): SalesmanPeriod => ({
  userId: "u1",
  name: "Mahesh",
  revenuePaise: 50_000_00,
  metres: 500_000,
  visitCount: 20,
  newCustomerCount: 2,
  travelPaise: 2_000_00,
  foodPaise: 900_00,
  lodgingPaise: 0,
  otherPaise: 100_00,
  salaryPaise: 25_000_00,
  ...over,
});

describe("what a salesman brought in against what he cost", () => {
  test("sales per kilometre and per visit", () => {
    assert.equal(salesPerKm(person()).value, 10_000, "₹50,000 over 500 km is ₹100 a km, in paise");
    assert.equal(salesPerVisit(person()).value, 250_000, "₹50,000 over 20 visits is ₹2,500 a visit");
  });

  test("no distance is a question with no denominator, not zero", () => {
    const r = salesPerKm(person({ metres: 0 }));
    assert.equal(r.value, null);
    assert.match(r.reason!, /nothing to divide by/);
  });

  test("a month with no sales has no expense ratio rather than an infinite one", () => {
    const r = travelExpenseRatioBps(person({ revenuePaise: 0 }));
    assert.equal(r.value, null);
    assert.match(r.reason!, /Nothing was sold/);
  });

  test("travel as a share of sales is basis points", () => {
    assert.equal(travelExpenseRatioBps(person()).value, 400, "₹2,000 of ₹50,000 is 4%");
  });

  test("total cost is salary plus every approved expense", () => {
    const c = totalSalesmanCost(person());
    assert.equal(c.totalPaise, 25_000_00 + 2_000_00 + 900_00 + 0 + 100_00);
    assert.equal(c.salaryMissing, false);
  });

  test("a missing salary is SAID, never treated as free", () => {
    const c = totalSalesmanCost(person({ salaryPaise: null }));
    assert.equal(c.salaryMissing, true);
    assert.equal(c.totalPaise, 3_000_00);
  });

  test("with no margin the figure is REVENUE and carries the sentence saying so", () => {
    const p = person();
    const r = salesmanReturn(p, totalSalesmanCost(p));
    assert.equal(r.basis, "revenue");
    assert.match(r.caveat!, /not profit against cost/);
  });

  test("with a margin it becomes contribution and the caveat goes", () => {
    const p = person();
    const r = salesmanReturn(p, totalSalesmanCost(p), 2000);
    assert.equal(r.basis, "contribution");
    assert.equal(r.returnedPaise, 10_000_00, "20% of ₹50,000");
    assert.equal(r.caveat, null);
  });
});

/* ------------------------------------------------- §L acquisition/servicing */

describe("acquisition and servicing never mix", () => {
  const items = [
    { id: "a", paise: 100, purpose: "new_customer", customerId: "c1", customerHadOrderedBefore: false },
    { id: "b", paise: 200, purpose: "collection", customerId: "c2", customerHadOrderedBefore: true },
    { id: "c", paise: 300, purpose: "visit", customerId: null, customerHadOrderedBefore: null },
    { id: "d", paise: 400, purpose: "new_customer", customerId: "c3", customerHadOrderedBefore: true },
    { id: "e", paise: 500, purpose: "visit", customerId: "c4", customerHadOrderedBefore: null },
  ];

  test("the order history decides, not what the salesman ticked", () => {
    const s = splitSpend(items);
    assert.deepEqual(s.acquisitionIds, ["a"]);
    assert.deepEqual(s.servicingIds, ["b", "d"], "d was ticked new-customer against an account that had ordered");
  });

  test("spending nobody can attribute is its own number, never padding for either", () => {
    const s = splitSpend(items);
    assert.deepEqual(s.unattributedIds, ["c", "e"]);
    assert.equal(s.unattributedPaise, 800);
  });

  test("the three buckets add up to the whole", () => {
    const s = splitSpend(items);
    assert.equal(
      s.acquisitionPaise + s.servicingPaise + s.unattributedPaise,
      items.reduce((n, i) => n + i.paise, 0),
    );
  });

  test("a disagreement between the purpose and the book is reportable", () => {
    assert.equal(purposeDisagreesWithHistory(items[3]!), true);
    assert.equal(purposeDisagreesWithHistory(items[0]!), false);
    assert.equal(purposeDisagreesWithHistory(items[2]!), false);
  });

  test("COCA with nobody won is null with a reason, never zero", () => {
    const c = coca(50_000_00, 0);
    assert.equal(c.perCustomerPaise, null);
    assert.match(c.reason!, /none has been won yet/);
  });

  test("COCA divides only by customers actually won", () => {
    assert.equal(coca(50_000_00, 5).perCustomerPaise, 10_000_00);
  });

  test("servicing cost is its own function, so it cannot be folded into COCA", () => {
    assert.equal(servicingCost(30_000_00, 60).perCustomerPaise, 500_00);
    assert.equal(servicingCost(30_000_00, 0).perCustomerPaise, null);
  });

  test("a customer's return names both costs separately even while subtracting both", () => {
    const r = customerReturn(100_000_00, 8_000_00, 12_000_00);
    assert.equal(r.acquisitionPaise, 8_000_00);
    assert.equal(r.servicingPaise, 12_000_00);
    assert.equal(r.costPaise, 20_000_00);
    assert.equal(r.basis, "revenue");
  });
});

/* ------------------------------------------------------------ §M rankings */

describe("top and bottom", () => {
  const people = rank([
    person({ userId: "a", name: "A", revenuePaise: 90_000_00, metres: 300_000 }),
    person({ userId: "b", name: "B", revenuePaise: 40_000_00, metres: 800_000 }),
    person({ userId: "c", name: "C", revenuePaise: 60_000_00, metres: 0 }),
  ]);

  test("somebody the question cannot be asked of is set aside, not ranked last", () => {
    const { top, bottom, unmeasurable } = topAndBottom(people, (p) => p.perKm.value, 1);
    assert.equal(top[0]!.name, "A");
    assert.equal(bottom[0]!.name, "B");
    assert.deepEqual(unmeasurable.map((p) => p.name), ["C"]);
  });

  test("ranking carries every ratio, so a table needs one pass", () => {
    assert.equal(people[0]!.cost.totalPaise > 0, true);
    assert.equal(people[0]!.ret.basis, "revenue");
  });
});
