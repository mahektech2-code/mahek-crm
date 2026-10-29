import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { approvalOf, buildWatch, givenAwayPaise, median, personOf, watchRange, type WatchLine } from "./price-watch";

let n = 0;
function line(over: Partial<WatchLine>): WatchLine {
  const list = over.listExPaise === undefined ? 10_000 : over.listExPaise;
  const billed = over.billedExPaise ?? 10_000;
  return {
    lineId: `l${++n}`,
    orderDate: "2026-10-10",
    orderNumber: "1",
    customerId: "c1",
    customerName: "Shop A",
    productId: "p1",
    productName: "Nano 20 L",
    cans: 2,
    billedExPaise: billed,
    listExPaise: list,
    listInclPaise: list == null ? null : Math.round(list * 1.18),
    listGstBp: 1800,
    listId: "L1",
    listName: "Maharashtra",
    deltaPaise: list == null ? null : billed - list,
    deltaBp: list == null ? null : Math.round(((billed - list) / list) * 10_000),
    sheetDiscountBp: null,
    source: "sheet",
    takenByName: "Ramesh",
    takenById: null,
    rateSetById: null,
    rateSetByName: null,
    discountAuthorisedById: null,
    discountAuthorisedByName: null,
    ...over,
  };
}

const NONE = { overrides: [], requests: [] };

describe("money given away", () => {
  test("is (book − billed) × cans on lines below the book only", () => {
    assert.equal(givenAwayPaise(line({ billedExPaise: 9_000, cans: 3 })), 3_000);
    assert.equal(givenAwayPaise(line({ billedExPaise: 11_000 })), 0);
    assert.equal(givenAwayPaise(line({ billedExPaise: 9_000, listExPaise: null })), 0);
    assert.equal(givenAwayPaise(line({ billedExPaise: 9_000, cans: null })), 1_000, "no can count is one can, as variance counts it");
  });

  test("totals count every verdict and add the money", () => {
    const r = buildWatch(
      [
        line({ billedExPaise: 9_000 }),
        line({ billedExPaise: 10_000 }),
        line({ billedExPaise: 12_000 }),
        line({ listExPaise: null }),
      ],
      NONE,
    );
    assert.deepEqual(
      { ...r.totals },
      { lines: 4, priced: 3, on: 1, below: 1, above: 1, unpriced: 1, givenAwayPaise: 2_000, unapprovedPaise: 2_000 },
    );
  });
});

describe("grouping", () => {
  test("shop × product groups take below lines only, money first, with min/median billed", () => {
    const r = buildWatch(
      [
        line({ billedExPaise: 9_000, orderDate: "2026-10-01" }),
        line({ billedExPaise: 8_000, orderDate: "2026-10-05" }),
        line({ billedExPaise: 9_500, orderDate: "2026-10-07" }),
        line({ customerId: "c2", customerName: "Shop B", billedExPaise: 5_000, cans: 10 }),
        line({ customerId: "c2", customerName: "Shop B", billedExPaise: 10_000 }),
      ],
      NONE,
    );
    assert.equal(r.byShopProduct.length, 2);
    const [top, next] = r.byShopProduct;
    assert.equal(top.customerName, "Shop B");
    assert.equal(top.givenAwayPaise, 50_000);
    assert.equal(top.lines, 1);
    assert.equal(next.lines, 3);
    assert.equal(next.cans, 6);
    assert.equal(next.billedMinPaise, 8_000);
    assert.equal(next.billedMedianPaise, 9_000);
    assert.equal(next.givenAwayPaise, (1_000 + 2_000 + 500) * 2);
    assert.equal(r.lines[next.lineIdx[0]].orderDate, "2026-10-07", "newest line first");
  });

  test("a revision inside the range: the group names the newest book price and keeps both", () => {
    const r = buildWatch(
      [line({ billedExPaise: 9_000, orderDate: "2026-10-01" }), line({ listExPaise: 11_000, billedExPaise: 10_000, orderDate: "2026-10-20" })],
      NONE,
    );
    assert.equal(r.byShopProduct[0].listExPaise, 11_000);
    assert.deepEqual(r.byShopProduct[0].listPrices.sort(), [10_000, 11_000]);
  });

  test("by person and by product add the same money", () => {
    const r = buildWatch(
      [
        line({ billedExPaise: 9_000, takenByName: "Ramesh" }),
        line({ billedExPaise: 8_000, takenByName: "Suresh", productId: "p2", productName: "PU 5 L" }),
        line({ billedExPaise: 10_000, takenByName: "Suresh" }),
      ],
      NONE,
    );
    const total = r.totals.givenAwayPaise;
    assert.equal(r.byPerson.reduce((s, p) => s + p.givenAwayPaise, 0), total);
    assert.equal(r.byProduct.reduce((s, p) => s + p.givenAwayPaise, 0), total);
    const suresh = r.byPerson.find((p) => p.name === "Suresh")!;
    assert.equal(suresh.lines, 2);
    assert.equal(suresh.belowLines, 1);
    assert.equal(r.byProduct[0].productName, "PU 5 L");
  });
});

describe("who took it", () => {
  test("ERP: whoever set the rate, else whoever created the line; sheet: the salesman as typed", () => {
    assert.deepEqual(
      personOf({ source: "erp", takenById: "u1", takenByName: "Asha", rateSetById: "u2", rateSetByName: "Neha" }),
      { key: "user:u2", name: "Neha", known: true },
    );
    assert.deepEqual(personOf({ source: "erp", takenById: "u1", takenByName: "Asha", rateSetById: null, rateSetByName: null }), {
      key: "user:u1",
      name: "Asha",
      known: true,
    });
    assert.deepEqual(personOf({ source: "sheet", takenById: null, takenByName: " Ramesh  Kumar ", rateSetById: null, rateSetByName: null }), {
      key: "name:ramesh kumar",
      name: "Ramesh  Kumar",
      known: true,
    });
    assert.equal(personOf({ source: "sheet", takenById: null, takenByName: null, rateSetById: null, rateSetByName: null }).name, "Not recorded");
  });
});

describe("approval", () => {
  const facts = {
    overrides: [{ customerId: "c1", productId: "p1", validFrom: "2026-10-05", validTo: "2026-10-15" }],
    requests: [
      { customerId: "c2", productId: "p1", status: "approved", day: "2026-09-01" },
      { customerId: "c3", productId: "p1", status: "pending", day: "2026-10-01" },
      { customerId: "c4", productId: "p1", status: "refused", day: "2026-10-01" },
    ],
  };
  test("authorised in the ERP, an override covering the date, an approved or pending request", () => {
    assert.equal(approvalOf({ customerId: "c9", productId: "p1", orderDate: "2026-10-10", discountAuthorisedById: "u1" }, facts), "authorised");
    assert.equal(approvalOf({ customerId: "c1", productId: "p1", orderDate: "2026-10-10", discountAuthorisedById: null }, facts), "override");
    assert.equal(approvalOf({ customerId: "c1", productId: "p1", orderDate: "2026-10-20", discountAuthorisedById: null }, facts), null);
    assert.equal(approvalOf({ customerId: "c2", productId: "p1", orderDate: "2026-10-10", discountAuthorisedById: null }, facts), "approved_request");
    assert.equal(approvalOf({ customerId: "c3", productId: "p1", orderDate: "2026-10-10", discountAuthorisedById: null }, facts), "asked");
    assert.equal(approvalOf({ customerId: "c4", productId: "p1", orderDate: "2026-10-10", discountAuthorisedById: null }, facts), null);
  });
  test("approved money is kept out of the unapproved figure", () => {
    const r = buildWatch([line({ billedExPaise: 9_000, orderDate: "2026-10-10" }), line({ customerId: "c5", billedExPaise: 9_000 })], facts);
    assert.equal(r.totals.givenAwayPaise, 4_000);
    assert.equal(r.totals.unapprovedPaise, 2_000);
  });
});

describe("range", () => {
  const today = "2026-10-29";
  test("presets are inclusive at both ends and the query end is the day after", () => {
    assert.deepEqual(watchRange({ preset: "7d" }, today), { preset: "7d", from: "2026-10-23", to: today, toExclusive: "2026-10-30" });
    assert.deepEqual(watchRange({ preset: "month" }, today), { preset: "month", from: "2026-10-01", to: today, toExclusive: "2026-10-30" });
    assert.deepEqual(watchRange({ preset: "last_month" }, today), {
      preset: "last_month",
      from: "2026-09-01",
      to: "2026-09-30",
      toExclusive: "2026-10-01",
    });
    assert.equal(watchRange({}, today).from, "2026-09-30");
  });
  test("custom takes two dates in order, else falls back to 30 days", () => {
    assert.deepEqual(watchRange({ preset: "custom", from: "2026-08-01", to: "2026-08-31" }, today).toExclusive, "2026-09-01");
    assert.equal(watchRange({ preset: "custom", from: "2026-09-01", to: "2026-08-01" }, today).preset, "30d");
  });
  test("median", () => {
    assert.equal(median([]), null);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 3);
  });
});
