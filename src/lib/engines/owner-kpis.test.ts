import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { checkConsistency, defaultConfig } from "../config/registry";
import {
  bandFor,
  bandThresholds,
  evaluateInactivity,
  healthBand,
  type HealthBand,
} from "./inactivity";
import {
  billSize,
  changeInCount,
  changeInRate,
  conversionFor,
  frequency,
  isQualified,
  movement,
  ownerAlerts,
  retention,
  type LeadRow,
} from "./owner-kpis";
import {
  comparableRange,
  reportRange,
  sameRangeLastYear,
} from "../business-date";

/* ============================ E11 — the owner's five
 *
 * What these pin is mostly the difference between a figure and a flattering
 * figure: a rate reported in the wrong unit, a cohort read before it finished,
 * a retention count with the never-ordered folded into it, and a band measured
 * against a flat number of days instead of the customer's own rhythm.
 */

const C = defaultConfig();

const lead = (over: Partial<LeadRow> = {}): LeadRow => ({
  leadId: `l${Math.random()}`,
  origin: "crm",
  customerId: "c1",
  source: "website",
  ownerUserId: "u1",
  ownerName: "Rahul",
  state: "Maharashtra",
  city: "Mumbai",
  customerType: "dealer",
  createdOn: "2026-08-01",
  stage: null,
  firstOrderOn: null,
  ...over,
});

/* ------------------------------------------------------------- comparison */

describe("saying how a figure moved", () => {
  test("a COUNT moves in percent", () => {
    // The brief's own example: 210 leads to 245 is +16.7%.
    const c = changeInCount(245, 210);
    assert.equal(c.value, 16.7);
    assert.equal(c.kind, "percent");
    assert.equal(c.direction, "up");
  });

  test("a RATE moves in percentage POINTS, never in percent", () => {
    // 12.5% to 14.8% is 2.3 points. Reporting it as +18.4% is the commonest
    // way a dashboard flatters itself, and the two are indistinguishable once
    // printed as bare numbers.
    const c = changeInRate(14.8, 12.5);
    assert.equal(c.value, 2.3);
    assert.equal(c.kind, "points");
  });

  test("growth from nothing is not a percentage", () => {
    // One lead last month and forty this month is not "up 3,900%".
    const c = changeInCount(40, 0);
    assert.equal(c.value, null);
    assert.equal(c.direction, "up");
  });
});

/* --------------------------------------------------------- KPI 2: cohorts */

describe("lead-to-order conversion", () => {
  test("the brief's example: 30 of 200 is 15%", () => {
    const cohort = [
      ...Array.from({ length: 30 }, () =>
        lead({ createdOn: "2026-08-01", firstOrderOn: "2026-08-20" }),
      ),
      ...Array.from({ length: 170 }, () => lead({ createdOn: "2026-08-01" })),
    ];
    const c = conversionFor(cohort, "2026-12-01", C);
    assert.equal(c.leads, 200);
    assert.equal(c.converted, 30);
    assert.equal(c.ratePercent, 15);
  });

  test("an order AFTER the window does not count for that cohort", () => {
    // A lead created on 1 August with a 90-day window converts by 30 October.
    const inside = conversionFor(
      [lead({ createdOn: "2026-08-01", firstOrderOn: "2026-10-29" })],
      "2026-12-01",
      C,
    );
    assert.equal(inside.converted, 1);

    const outside = conversionFor(
      [lead({ createdOn: "2026-08-01", firstOrderOn: "2026-11-15" })],
      "2026-12-01",
      C,
    );
    assert.equal(outside.converted, 0);
  });

  test("a lead still INSIDE its window has not failed, it is unfinished", () => {
    // The single most misread figure on the screen: a cohort read eleven days
    // in reports a low rate that is really an incomplete one.
    const c = conversionFor(
      [
        lead({ createdOn: "2026-08-01", firstOrderOn: "2026-08-05" }),
        lead({ createdOn: "2026-08-01" }),
        lead({ createdOn: "2026-08-10" }),
      ],
      "2026-08-12",
      C,
    );
    assert.equal(c.converted, 1);
    assert.equal(c.stillOpen, 2);
    assert.equal(c.windowClosed, false);
  });

  test("once every window has closed the cohort is final", () => {
    const c = conversionFor(
      [lead({ createdOn: "2026-08-01" }), lead({ createdOn: "2026-08-02" })],
      "2027-01-01",
      C,
    );
    assert.equal(c.stillOpen, 0);
    assert.equal(c.windowClosed, true);
    assert.equal(c.ratePercent, 0);
  });

  test("an empty cohort has no rate, rather than a rate of zero", () => {
    // Nobody generated a lead. That is not a conversion failure.
    assert.equal(conversionFor([], "2026-08-12", C).ratePercent, null);
  });

  test("only a FIELD lead can be qualified, and the two rates are both reported", () => {
    const cohort = [
      lead({ origin: "field", stage: "qualified", firstOrderOn: "2026-08-10" }),
      lead({ origin: "field", stage: "negotiation" }),
      lead({ origin: "field", stage: "new" }),
      // A CRM lead has no ladder at all. It counts in the denominator of the
      // headline rate and can never count in the qualified one.
      lead({ origin: "crm", stage: null, firstOrderOn: "2026-08-11" }),
      lead({ origin: "crm", stage: null }),
    ];
    const c = conversionFor(cohort, "2026-12-01", C);

    assert.equal(c.leads, 5);
    assert.equal(c.converted, 2);
    assert.equal(c.ratePercent, 40);
    assert.equal(c.qualified, 2, "only the two field leads at or past qualified");
    assert.equal(c.qualifiedConverted, 1);
    assert.equal(c.qualifiedRatePercent, 50);
  });

  test("the qualification rungs are the ones at or past `qualified`", () => {
    assert.equal(isQualified(lead({ stage: "new" })), false);
    assert.equal(isQualified(lead({ stage: "contacted" })), false);
    assert.equal(isQualified(lead({ stage: "qualified" })), true);
    assert.equal(isQualified(lead({ stage: "negotiation" })), true);
    assert.equal(isQualified(lead({ stage: "won" })), true);
    assert.equal(isQualified(lead({ stage: "lost" })), false);
    assert.equal(isQualified(lead({ stage: null })), false);
  });
});

/* ------------------------------------------------------ KPI 3: bill size */

describe("average bill size", () => {
  test("the brief's example: 50 lakh over 250 transactions is 20,000", () => {
    const b = billSize(50_00_000_00, 0, 250);
    assert.equal(b.averagePaise, 20_000_00);
  });

  test("credit notes reduce the VALUE and never the COUNT", () => {
    // Removing the transaction would raise the average every time somebody
    // allowed a claim, which is exactly backwards.
    const b = billSize(10_00_000_00, 1_00_000_00, 100);
    assert.equal(b.transactions, 100);
    assert.equal(b.netValuePaise, 9_00_000_00);
    assert.equal(b.averagePaise, 9_000_00);
    // Both halves survive: a healthy gross with large credit notes is a
    // different month to a small gross, and one net figure hides which.
    assert.equal(b.grossValuePaise, 10_00_000_00);
    assert.equal(b.creditNotePaise, 1_00_000_00);
  });

  test("nothing sold is no average, not a confident zero", () => {
    assert.equal(billSize(0, 0, 0).averagePaise, null);
  });
});

/* ------------------------------------------------------- KPI 4: frequency */

describe("purchase frequency", () => {
  test("the brief's example: 1,000 transactions over 250 customers is 4", () => {
    const f = frequency(1000, Array.from({ length: 250 }, () => 4), C);
    assert.equal(f.perActiveCustomer, 4);
    assert.equal(f.activeCustomers, 250);
  });

  test("segments split on the configured thresholds", () => {
    const f = frequency(0, [9, 8, 7, 4, 3, 1], C); // high 8+, medium 4-7
    const by = (s: string) => f.segments.find((x) => x.segment === s)!.customers;
    assert.equal(by("high"), 2);
    assert.equal(by("medium"), 2);
    assert.equal(by("low"), 2);
  });

  test("nobody ordering is no figure, rather than a division by zero", () => {
    assert.equal(frequency(0, [], C).perActiveCustomer, null);
  });
});

/* ------------------------------------------------------- KPI 5: retention */

describe("customer health bands", () => {
  test("dormant IS the existing inactive multiplier, not a second number", () => {
    // The whole reason the Call Log and this dashboard cannot disagree about
    // whether an account has gone quiet.
    const t = bandThresholds(C);
    assert.equal(t.dormant, C["inactive.cycleMultiplier"]);
  });

  test("the bands read off multiples of the customer's OWN cycle", () => {
    assert.equal(healthBand(0.5, C), "active");
    assert.equal(healthBand(1.24, C), "active");
    assert.equal(healthBand(1.25, C), "at-risk");
    assert.equal(healthBand(1.99, C), "at-risk");
    assert.equal(healthBand(2.0, C), "dormant");
    assert.equal(healthBand(2.99, C), "dormant");
    assert.equal(healthBand(3.0, C), "lost");
    assert.equal(healthBand(9, C), "lost");
  });

  test("a fortnightly buyer and a twice-a-year buyer band the same way", () => {
    // The reason a flat 30/60/90 is wrong: 20 days late is nothing to one of
    // these and most of a year to the other.
    const fortnightly = bandFor(
      { lastOrderDate: "2026-07-14", cycleDays: 14 },
      "2026-08-01",
      C,
    )!;
    const halfYearly = bandFor(
      { lastOrderDate: "2026-01-15", cycleDays: 180 },
      "2026-08-01",
      C,
    )!;
    assert.equal(fortnightly.band, "at-risk"); // 18 days on a 14-day cycle
    assert.equal(halfYearly.band, "active"); // 198 days on a 180-day cycle
  });

  test("a customer who never ordered gets NO band", () => {
    // They have not stopped buying, they have not started, and either band
    // would be a lie in a different direction.
    assert.equal(bandFor({ lastOrderDate: null, cycleDays: 30 }, "2026-08-01", C), null);
  });

  test("days overdue is never negative", () => {
    const early = bandFor(
      { lastOrderDate: "2026-07-28", cycleDays: 30 },
      "2026-08-01",
      C,
    )!;
    assert.equal(early.daysOverdue, 0, "not yet due is not overdue");
  });

  test("the never-ordered are counted apart, never folded into active", () => {
    const bands: (HealthBand | null)[] = [
      "active",
      "active",
      "at-risk",
      "dormant",
      null,
      null,
    ];
    const r = retention(bands);
    assert.equal(r.total, 4, "the banded only");
    assert.equal(r.unbanded, 2);
    assert.equal(r.counts.active, 2);
    assert.equal(r.share.active, 50);
  });

  test("the inactive flag still fires exactly where it did", () => {
    // The bands were added underneath `evaluateInactivity`; if they had moved
    // the boundary, every customer between 1.75 and 2 cycles would silently
    // change status on deploy.
    const at195 = evaluateInactivity(
      {
        status: "active",
        lastOrderDate: "2026-06-04", // 58 days before, on a 30-day cycle
        cycleDays: 30,
        cycleIsDefault: false,
        avgOrderValue: 0,
      },
      "2026-08-01",
      C,
    );
    assert.equal(at195.inactive, false, "1.93 cycles is not yet inactive");

    const at2 = evaluateInactivity(
      {
        status: "active",
        lastOrderDate: "2026-06-02", // 60 days, exactly 2 cycles
        cycleDays: 30,
        cycleIsDefault: false,
        avgOrderValue: 0,
      },
      "2026-08-01",
      C,
    );
    assert.equal(at2.inactive, true);
  });
});

describe("movement between two readings", () => {
  const before = new Map<string, HealthBand>([
    ["a", "active"],
    ["b", "active"],
    ["c", "at-risk"],
    ["d", "dormant"],
    ["e", "at-risk"],
  ]);
  const after = new Map<string, HealthBand>([
    ["a", "active"],
    ["b", "at-risk"],
    ["c", "active"],
    ["d", "lost"],
    ["e", "at-risk"],
    ["f", "active"], // new — present in only one reading
  ]);

  test("recovery and decay are told apart", () => {
    const m = movement(before, after);
    const find = (from: string, to: string) =>
      m.find((x) => x.from === from && x.to === to)!;

    assert.equal(find("at-risk", "active").direction, "recovered");
    assert.equal(find("active", "at-risk").direction, "declined");
    assert.equal(find("dormant", "lost").direction, "declined");
    assert.equal(find("active", "active").direction, "held");
  });

  test("a customer in only one reading is not a movement", () => {
    // They were added, or they had no measurable cycle. Counting them as
    // having come from somewhere would invent a recovery.
    const m = movement(before, after);
    assert.equal(
      m.reduce((s, x) => s + x.customers, 0),
      5,
      "the five in both readings, and not the sixth",
    );
  });

  test("movements are listed before the stayed-put rows", () => {
    // "Eleven customers came back" is the sentence somebody is looking for and
    // it must not sit below "six hundred stayed active".
    const m = movement(before, after);
    const firstHeld = m.findIndex((x) => x.direction === "held");
    const lastMoved = m.map((x) => x.direction !== "held").lastIndexOf(true);
    assert.ok(firstHeld === -1 || firstHeld > lastMoved);
  });
});

/* ------------------------------------------------------------------ alerts */

describe("what the owner is told", () => {
  const base = {
    billSize: billSize(10_00_000_00, 0, 100),
    previousBillSize: billSize(10_00_000_00, 0, 100),
    retention: retention(["active", "active", "at-risk"]),
    previousRetention: retention(["active", "active", "at-risk"]),
    newLeads: 100,
    previousNewLeads: 100,
  };

  test("conversion below target is raised against the TARGET, not the last month", () => {
    // A rate flat at 4% all year against a target of 15% is a bigger problem
    // than one that slipped from 4 to 3.6, and only a target can say so.
    const conversion = conversionFor(
      [lead({ createdOn: "2026-01-01", firstOrderOn: "2026-01-05" }), lead({ createdOn: "2026-01-01" })],
      "2027-01-01",
      C,
    );
    const alerts = ownerAlerts(
      { ...base, conversion, previousConversion: conversion },
      { ...C, "owner.conversionTargetPercent": 80 },
    );
    assert.ok(alerts.find((a) => a.key === "conversion-below-target"));
  });

  test("an unfinished cohort says so inside the alert", () => {
    const conversion = conversionFor([lead({ createdOn: "2026-08-01" })], "2026-08-05", C);
    const alerts = ownerAlerts(
      { ...base, conversion, previousConversion: null },
      C,
    );
    const alert = alerts.find((a) => a.key === "conversion-below-target")!;
    assert.match(alert.message, /still inside their 90-day window/);
  });

  test("a small movement raises nothing", () => {
    // Six alerts every month is the same as none.
    const conversion = conversionFor(
      Array.from({ length: 10 }, () => lead({ firstOrderOn: "2026-08-02" })),
      "2027-01-01",
      C,
    );
    const alerts = ownerAlerts(
      {
        ...base,
        conversion,
        previousConversion: conversion,
        newLeads: 98,
        previousNewLeads: 100,
      },
      C,
    );
    assert.equal(alerts.find((a) => a.key === "leads-falling"), undefined);
  });

  test("dormant customers rising is raised, and it is high", () => {
    const conversion = conversionFor(
      Array.from({ length: 10 }, () => lead({ firstOrderOn: "2026-08-02" })),
      "2027-01-01",
      C,
    );
    const alerts = ownerAlerts(
      {
        ...base,
        conversion,
        previousConversion: conversion,
        retention: retention(["active", "dormant", "dormant", "dormant"]),
        previousRetention: retention(["active", "dormant"]),
      },
      C,
    );
    const alert = alerts.find((a) => a.key === "dormant-rising")!;
    assert.ok(alert);
    assert.equal(alert.severity, "high");
  });
});

/* ---------------------------------------------------------------- periods */

describe("the owner's periods", () => {
  const TODAY = "2026-08-22";

  test("a running period stops at today, a closed one runs to its end", () => {
    assert.deepEqual(reportRange(TODAY, "month"), {
      from: "2026-08-01",
      to: TODAY,
    });
    assert.deepEqual(reportRange(TODAY, "last-month"), {
      from: "2026-07-01",
      to: "2026-07-31",
    });
    assert.deepEqual(reportRange(TODAY, "quarter"), {
      from: "2026-07-01",
      to: TODAY,
    });
    assert.deepEqual(reportRange(TODAY, "last-quarter"), {
      from: "2026-04-01",
      to: "2026-06-30",
    });
    assert.deepEqual(reportRange(TODAY, "ytd"), {
      from: "2026-01-01",
      to: TODAY,
    });
  });

  test("a month is compared CALENDAR-ALIGNED and equal-length at once", () => {
    // 1-22 August against 1-22 July. Not 10-31 July, which is the equal span
    // immediately before and a window nobody recognises; and not the whole of
    // July, which would make every month-to-date read as a collapse.
    const range = reportRange(TODAY, "month");
    assert.deepEqual(comparableRange(range, "month"), {
      from: "2026-07-01",
      to: "2026-07-22",
    });
  });

  test("a custom range has no calendar to align to, so it takes the span before", () => {
    const range = { from: "2026-08-10", to: "2026-08-19" }; // 10 days
    assert.deepEqual(comparableRange(range, "custom"), {
      from: "2026-07-31",
      to: "2026-08-09",
    });
  });

  test("the 31st shifted into a 30-day month lands on the 30th", () => {
    // Not the 1st of the next month, which is what a naive setMonth does and
    // would make the comparison window wrong by a whole month.
    assert.deepEqual(
      comparableRange({ from: "2026-08-31", to: "2026-08-31" }, "month"),
      { from: "2026-07-31", to: "2026-07-31" },
    );
    assert.deepEqual(
      comparableRange({ from: "2026-05-31", to: "2026-05-31" }, "month"),
      { from: "2026-04-30", to: "2026-04-30" },
    );
  });

  test("same window last year is the same dates", () => {
    assert.deepEqual(sameRangeLastYear({ from: "2026-08-01", to: "2026-08-22" }), {
      from: "2025-08-01",
      to: "2025-08-22",
    });
  });
});

/* --------------------------------------------------------------- settings */

describe("configuration is refused rather than silently obeyed", () => {
  test("bands that do not increase are a problem", () => {
    const bad = { ...C, "health.atRiskCycleMultiplier": 5 };
    assert.ok(
      checkConsistency(bad).some((p) => p.includes("Customer health bands must increase")),
    );
  });

  test("high frequency must start above medium", () => {
    const bad = { ...C, "owner.frequencyHighOrders": 2 };
    assert.ok(
      checkConsistency(bad).some((p) => p.includes("High frequency must start above")),
    );
  });

  test("the shipped defaults are consistent", () => {
    const problems = checkConsistency(C).filter(
      (p) => p.includes("health bands") || p.includes("frequency"),
    );
    assert.deepEqual(problems, []);
  });
});
