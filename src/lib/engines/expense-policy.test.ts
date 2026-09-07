import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  chooseDistance,
  computeDay,
  computeLeg,
  computeMeals,
  policyOn,
  routeDay,
  ruleFor,
  varianceBps,
  worstSeverity,
  type DayFacts,
  type Policy,
  type PolicyRule,
  type PolicySubject,
  type TravelLegFacts,
} from "./expense-policy";
import {
  gpsDistanceForLeg,
  haversineMetres,
  straightLineEstimate,
  trailDistance,
  type Fix,
  type TrailOptions,
} from "./travel-distance";

/* ---------------------------------------------------------------------------
 * These are golden vectors. The handset runs the same engine over the same
 * cases (see `mbos-app/src/engines/generated/`), so a change that moves a
 * number here moves it on the phone in the salesman's hand too — which is the
 * only arrangement in which the eligible amount he is shown mid-market and the
 * one the office pays cannot drift apart.
 * ------------------------------------------------------------------------- */

const ANY = { grade: null, cityClass: null };
const SUBJECT: PolicySubject = { grade: "sales_executive", cityClass: "tier2" };

const hhmm = (h: number, m = 0) => h * 60 + m;

/**
 * A policy carrying the client's own stated rules, so the numbers in §E of the
 * brief are the numbers these tests assert: ₹100 breakfast, ₹250 breakfast and
 * lunch, ₹450 all three, nothing for breakfast after eight, ₹250 for a
 * dormitory morning.
 */
function policy(extra: PolicyRule[] = []): Policy {
  const rules: PolicyRule[] = [
    { ...ANY, kind: "per_km", modeKey: "own_bike", paisePerKm: 350, dailyKmCap: null },
    { ...ANY, kind: "per_km", modeKey: "own_car", paisePerKm: 900, dailyKmCap: null },
    { ...ANY, kind: "zero_rated", modeKey: "customer_vehicle" },
    { ...ANY, kind: "zero_rated", modeKey: "walking" },
    { ...ANY, kind: "actuals", scopeKey: "travel_mode:bus", capPerInstancePaise: null, capPerDayPaise: null },
    { ...ANY, kind: "actuals", scopeKey: "travel_mode:train", capPerInstancePaise: null, capPerDayPaise: null },
    { ...ANY, kind: "actuals", scopeKey: "category:local_transport", capPerInstancePaise: 30000, capPerDayPaise: 60000 },
    {
      ...ANY,
      kind: "km_source",
      modeKey: null,
      precedence: ["odometer", "gps", "manual"],
      varianceFlagBps: 2500,
    },
    { ...ANY, kind: "odometer_photo", modeKey: null, when: "on_variance", randomPct: 10 },

    /* §E — the client's figures, decomposed per meal. */
    { ...ANY, kind: "meal_rate", meal: "breakfast", amountPaise: 10000 },
    { ...ANY, kind: "meal_rate", meal: "lunch", amountPaise: 15000 },
    { ...ANY, kind: "meal_rate", meal: "dinner", amountPaise: 20000 },
    { ...ANY, kind: "meal_entitlement", meal: "breakfast", windowFromMinutes: hhmm(6), windowToMinutes: hhmm(10), minAwayMinutes: null },
    { ...ANY, kind: "meal_entitlement", meal: "lunch", windowFromMinutes: hhmm(12), windowToMinutes: hhmm(15), minAwayMinutes: null },
    { ...ANY, kind: "meal_entitlement", meal: "dinner", windowFromMinutes: hhmm(19), windowToMinutes: hhmm(22), minAwayMinutes: null },
    { ...ANY, kind: "meal_disqualifier", meal: "breakfast", departedAfterMinutes: hhmm(8) },
    {
      ...ANY,
      kind: "dormitory",
      arrivalFromMinutes: hhmm(6),
      arrivalToMinutes: hhmm(10),
      amountPaise: 25000,
      replacesMeals: true,
    },

    { ...ANY, kind: "lodging", maxPerNightPaise: 150000, dayUseAllowed: false },
    { ...ANY, kind: "proof_threshold", scopeKey: "*", atPaise: 20000 },
    {
      ...ANY,
      kind: "approval_route",
      autoApproveUpToPaise: 100000,
      escalateAboveDayTotalPaise: 500000,
      escalateOnSeverity: null,
    },
    { ...ANY, kind: "exception_bands", dailyKmCeiling: 300, ownSpendBandBps: 20000, teamSpendBandBps: 20000 },
  ];
  return {
    id: "pol_1",
    versionNo: 1,
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    rules: [...rules, ...extra],
  };
}

const leg = (over: Partial<TravelLegFacts> = {}): TravelLegFacts => ({
  id: "leg_1",
  modeKey: "own_bike",
  gpsMetres: null,
  gpsCoveragePct: null,
  manualMetres: null,
  odometerMetres: null,
  hasOdometerPhoto: false,
  ticketAmountPaise: null,
  hasTicketProof: false,
  ...over,
});

const day = (over: Partial<DayFacts> = {}): DayFacts => ({
  day: "2026-09-07",
  clock: { departedMinutes: hhmm(7), returnedMinutes: hhmm(20), arrivedAtDestinationMinutes: null },
  departedFromHometown: true,
  stayedInHotel: false,
  overnight: false,
  legs: [],
  lines: [],
  ...over,
});

/* ------------------------------------------------------------ §B travel */

describe("travel modes", () => {
  test("own bike is distance times the rate, in integers", () => {
    const r = computeLeg(policy(), SUBJECT, leg({ odometerMetres: 42_300 }));
    assert.equal(r.chosenSource, "odometer");
    /* 42.3 km × ₹3.50 = ₹148.05 */
    assert.equal(r.eligiblePaise, 14805);
    assert.equal(r.exceptions.length, 0);
  });

  test("own car reads its own rate, not the bike's", () => {
    const r = computeLeg(policy(), SUBJECT, leg({ modeKey: "own_car", odometerMetres: 10_000 }));
    assert.equal(r.eligiblePaise, 9000);
  });

  test("a bus ticket is what it cost", () => {
    const r = computeLeg(
      policy(),
      SUBJECT,
      leg({ modeKey: "bus", ticketAmountPaise: 18000, hasTicketProof: false }),
    );
    assert.equal(r.eligiblePaise, 18000);
    /* Below the ₹200 proof threshold, so no bill is demanded. */
    assert.equal(r.proofRequired, false);
  });

  test("a train ticket above the proof threshold with no ticket is blocked to a person", () => {
    const r = computeLeg(
      policy(),
      SUBJECT,
      leg({ modeKey: "train", ticketAmountPaise: 95000, hasTicketProof: false }),
    );
    assert.equal(r.proofRequired, true);
    assert.equal(r.exceptions[0]!.kind, "missing_proof");
    assert.equal(r.exceptions[0]!.severity, "block_route");
    /* And it is still WORTH what it cost — the claim is routed, never voided. */
    assert.equal(r.eligiblePaise, 95000);
  });

  test("a customer's vehicle records the distance and pays nothing", () => {
    const r = computeLeg(
      policy(),
      SUBJECT,
      leg({ modeKey: "customer_vehicle", odometerMetres: 40_000 }),
    );
    assert.equal(r.eligiblePaise, 0);
    assert.equal(r.claimedPaise, 0);
    assert.equal(r.chosenMetres, 40_000, "the distance is still a fact about the day");
  });

  test("walking is recorded and pays nothing", () => {
    const r = computeLeg(policy(), SUBJECT, leg({ modeKey: "walking", manualMetres: 1_200 }));
    assert.equal(r.eligiblePaise, 0);
    assert.equal(r.chosenMetres, 1_200);
  });

  test("a mode the policy never priced is named, not silently paid zero", () => {
    const r = computeLeg(policy(), SUBJECT, leg({ modeKey: "helicopter", odometerMetres: 100_000 }));
    assert.equal(r.eligiblePaise, 0);
    assert.equal(r.exceptions[0]!.kind, "unpriced_mode");
    assert.match(r.unpricedReason!, /no rate for helicopter/);
  });
});

/* --------------------------------------------------------- §C kilometres */

describe("which distance the money is paid on", () => {
  test("odometer beats GPS beats manual, which is the shipped default", () => {
    const all = { odometer: 40_000, gps: 33_000, manual: 60_000 };
    assert.deepEqual(chooseDistance(["odometer", "gps", "manual"], all), {
      metres: 40_000,
      source: "odometer",
    });
    assert.deepEqual(chooseDistance(["gps", "odometer", "manual"], all), {
      metres: 33_000,
      source: "gps",
    });
  });

  test("it falls through what is missing rather than paying zero", () => {
    const r = chooseDistance(["odometer", "gps", "manual"], {
      odometer: null,
      gps: null,
      manual: 21_000,
    });
    assert.deepEqual(r, { metres: 21_000, source: "manual" });
  });

  test("GPS and the odometer disagreeing beyond the band is flagged, and still paid", () => {
    const r = computeLeg(policy(), SUBJECT, leg({ odometerMetres: 60_000, gpsMetres: 30_000 }));
    assert.equal(r.varianceBps, 5000);
    assert.equal(r.eligiblePaise, 21000, "paid on the odometer, per the precedence");
    const flags = r.exceptions.map((e) => e.kind);
    assert.ok(flags.includes("gps_odometer_variance"));
    /* on_variance: the disagreement is exactly what makes the photo mandatory */
    assert.equal(r.odometerPhotoRequired, true);
    assert.ok(flags.includes("missing_proof"));
  });

  test("agreeing within the band asks for nothing", () => {
    const r = computeLeg(policy(), SUBJECT, leg({ odometerMetres: 42_000, gpsMetres: 38_000 }));
    assert.equal(r.odometerPhotoRequired, false);
    assert.equal(r.exceptions.length, 0);
  });

  test("a number typed by hand over a leg the phone watched is questioned", () => {
    const p = policy([
      { ...ANY, kind: "km_source", modeKey: null, precedence: ["manual", "odometer", "gps"], varianceFlagBps: 2500 },
    ]);
    const r = computeLeg(p, SUBJECT, leg({ manualMetres: 80_000, gpsMetres: 30_000 }));
    assert.equal(r.chosenSource, "manual");
    assert.ok(r.exceptions.some((e) => e.kind === "manual_km_disagrees"));
  });

  test("variance is null rather than zero where there is nothing to compare", () => {
    assert.equal(varianceBps(null, 40_000), null);
    assert.equal(varianceBps(40_000, null), null);
    assert.equal(varianceBps(0, 0), null);
  });
});

/* --------------------------------------------------------------- §E food */

describe("food, on the client's own figures", () => {
  test("a full day away earns all three: ₹450", () => {
    const meals = computeMeals(policy(), SUBJECT, day({
      clock: { departedMinutes: hhmm(6, 30), returnedMinutes: hhmm(23), arrivedAtDestinationMinutes: null },
    }));
    assert.equal(meals.reduce((n, m) => n + m.amountPaise, 0), 45000);
  });

  test("out before eight and back by three earns breakfast and lunch: ₹250", () => {
    const meals = computeMeals(policy(), SUBJECT, day({
      clock: { departedMinutes: hhmm(7), returnedMinutes: hhmm(15), arrivedAtDestinationMinutes: null },
    }));
    assert.equal(meals.reduce((n, m) => n + m.amountPaise, 0), 25000);
  });

  test("a short morning earns breakfast alone: ₹100", () => {
    const meals = computeMeals(policy(), SUBJECT, day({
      clock: { departedMinutes: hhmm(7), returnedMinutes: hhmm(11), arrivedAtDestinationMinutes: null },
    }));
    assert.equal(meals.reduce((n, m) => n + m.amountPaise, 0), 10000);
  });

  test("requirement 28 — leaving after eight drops breakfast and only breakfast", () => {
    const meals = computeMeals(policy(), SUBJECT, day({
      clock: { departedMinutes: hhmm(8, 30), returnedMinutes: hhmm(21), arrivedAtDestinationMinutes: null },
    }));
    const breakfast = meals.find((m) => m.meal === "breakfast")!;
    assert.equal(breakfast.earned, false);
    assert.equal(breakfast.amountPaise, 0);
    assert.match(breakfast.withheldReason!, /left at 08:30/);
    /* Lunch and dinner are untouched: ₹150 + ₹200. */
    assert.equal(meals.reduce((n, m) => n + m.amountPaise, 0), 35000);
  });

  test("a meal the policy prices but never says how to earn is withheld with a reason", () => {
    const stripped: Policy = {
      ...policy(),
      rules: policy().rules.filter((r) => !(r.kind === "meal_entitlement" && r.meal === "dinner")),
    };
    const meals = computeMeals(stripped, SUBJECT, day({
      clock: { departedMinutes: hhmm(6), returnedMinutes: hhmm(23), arrivedAtDestinationMinutes: null },
    }));
    const dinner = meals.find((m) => m.meal === "dinner")!;
    assert.equal(dinner.earned, false);
    assert.match(dinner.withheldReason!, /says nothing about when dinner is earned/);
  });

  test("requirement 29 — a dormitory morning is ₹250 and REPLACES the meals", () => {
    const r = computeDay(policy(), SUBJECT, day({
      overnight: true,
      stayedInHotel: false,
      clock: { departedMinutes: hhmm(5), returnedMinutes: hhmm(21), arrivedAtDestinationMinutes: hhmm(7, 30) },
    }));
    assert.equal(r.dormitoryApplied, true);
    assert.equal(r.foodPaise, 25000, "₹250, not ₹250 on top of ₹450");
  });

  test("arriving outside the window is an ordinary day", () => {
    const r = computeDay(policy(), SUBJECT, day({
      overnight: true,
      stayedInHotel: false,
      clock: { departedMinutes: hhmm(5), returnedMinutes: hhmm(21), arrivedAtDestinationMinutes: hhmm(13) },
    }));
    assert.equal(r.dormitoryApplied, false);
    assert.equal(r.foodPaise, 45000);
  });

  test("a hotel night is not a dormitory morning", () => {
    const r = computeDay(policy(), SUBJECT, day({
      overnight: true,
      stayedInHotel: true,
      clock: { departedMinutes: hhmm(5), returnedMinutes: hhmm(21), arrivedAtDestinationMinutes: hhmm(7) },
    }));
    assert.equal(r.dormitoryApplied, false);
  });
});

/* ------------------------------------------------------------ §F lodging */

describe("hotel", () => {
  test("within the nightly limit is paid whole", () => {
    const r = computeDay(policy(), SUBJECT, day({
      lines: [{ id: "l1", kind: "lodging", claimedPaise: 120000, hasProof: true, nights: 1 }],
    }));
    assert.equal(r.lodgingEligiblePaise, 120000);
    assert.equal(r.totalExcessPaise, 0);
  });

  test("requirement 35 — over the limit shows claimed, eligible and the excess", () => {
    const r = computeDay(policy(), SUBJECT, day({
      lines: [{ id: "l1", kind: "lodging", claimedPaise: 220000, hasProof: true, nights: 1 }],
    }));
    assert.equal(r.lodgingClaimedPaise, 220000);
    assert.equal(r.lodgingEligiblePaise, 150000);
    assert.equal(r.totalExcessPaise, 70000);
    assert.ok(r.exceptions.some((e) => e.kind === "over_cap"));
  });

  test("two nights get two nights of headroom", () => {
    const r = computeDay(policy(), SUBJECT, day({
      lines: [{ id: "l1", kind: "lodging", claimedPaise: 280000, hasProof: true, nights: 2 }],
    }));
    assert.equal(r.lodgingEligiblePaise, 280000);
  });

  test("requirement 32 — a day room is ₹0, recorded, with the reason beside it", () => {
    const r = computeDay(policy(), SUBJECT, day({
      lines: [{ id: "l1", kind: "lodging", claimedPaise: 80000, hasProof: true, nights: 0 }],
    }));
    assert.equal(r.lodgingEligiblePaise, 0);
    assert.equal(r.lodgingClaimedPaise, 80000, "still recorded — it was spent");
    assert.ok(r.exceptions.some((e) => e.kind === "day_hotel"));
  });

  test("a hotel bill above the threshold with no bill blocks to a person", () => {
    const r = computeDay(policy(), SUBJECT, day({
      lines: [{ id: "l1", kind: "lodging", claimedPaise: 120000, hasProof: false, nights: 1 }],
    }));
    assert.ok(r.exceptions.some((e) => e.kind === "missing_proof" && e.severity === "block_route"));
  });
});

/* ------------------------------------------- §A6 the policy of the DAY */

describe("requirement 6 — the policy in force on the date", () => {
  const v1: Policy = { ...policy(), id: "v1", versionNo: 1, effectiveFrom: "2026-04-01", effectiveTo: "2026-08-31" };
  const v2: Policy = { ...policy(), id: "v2", versionNo: 2, effectiveFrom: "2026-09-01", effectiveTo: null };

  test("an old expense reads the old version", () => {
    assert.equal(policyOn([v1, v2], "2026-07-15")!.id, "v1");
  });

  test("a new one reads the new version", () => {
    assert.equal(policyOn([v1, v2], "2026-09-07")!.id, "v2");
  });

  test("a date before any policy answers null rather than guessing", () => {
    assert.equal(policyOn([v1, v2], "2026-01-01"), null);
  });

  test("the boundary days belong to the version that names them", () => {
    assert.equal(policyOn([v1, v2], "2026-08-31")!.id, "v1");
    assert.equal(policyOn([v1, v2], "2026-09-01")!.id, "v2");
  });
});

/* --------------------------------------------- §A7/§A8 grade and city */

describe("a rule may be narrowed by grade and by city", () => {
  const p = policy([
    { grade: "asm", cityClass: null, kind: "lodging", maxPerNightPaise: 300000, dayUseAllowed: false },
    { grade: null, cityClass: "metro", kind: "lodging", maxPerNightPaise: 250000, dayUseAllowed: false },
    { grade: "asm", cityClass: "metro", kind: "lodging", maxPerNightPaise: 400000, dayUseAllowed: false },
  ]);

  test("the residual rule catches anybody the policy does not name", () => {
    const r = ruleFor(p, "lodging", { grade: "sales_executive", cityClass: "tier2" })!;
    assert.equal(r.maxPerNightPaise, 150000);
  });

  test("a grade rule beats the residual", () => {
    const r = ruleFor(p, "lodging", { grade: "asm", cityClass: "tier2" })!;
    assert.equal(r.maxPerNightPaise, 300000);
  });

  test("a city rule beats the residual", () => {
    const r = ruleFor(p, "lodging", { grade: "sales_executive", cityClass: "metro" })!;
    assert.equal(r.maxPerNightPaise, 250000);
  });

  test("grade outranks city where a policy states both separately", () => {
    const narrower = policy([
      { grade: "asm", cityClass: null, kind: "lodging", maxPerNightPaise: 300000, dayUseAllowed: false },
      { grade: null, cityClass: "metro", kind: "lodging", maxPerNightPaise: 250000, dayUseAllowed: false },
    ]);
    const r = ruleFor(narrower, "lodging", { grade: "asm", cityClass: "metro" })!;
    assert.equal(r.maxPerNightPaise, 300000);
  });

  test("but a rule naming both outranks either alone", () => {
    const r = ruleFor(p, "lodging", { grade: "asm", cityClass: "metro" })!;
    assert.equal(r.maxPerNightPaise, 400000);
  });
});

/* ------------------------------------------------- §G/§H claim and route */

describe("what a whole day comes to, and where it goes", () => {
  const workingDay = day({
    legs: [
      leg({ id: "a", odometerMetres: 24_000 }),
      leg({ id: "b", modeKey: "walking", manualMetres: 900 }),
    ],
    lines: [{ id: "l1", kind: "local_transport", claimedPaise: 12000, hasProof: false }],
  });

  test("the day totals travel, food and everything else", () => {
    const r = computeDay(policy(), SUBJECT, workingDay);
    assert.equal(r.travelPaise, 8400, "24 km × ₹3.50");
    assert.equal(r.foodPaise, 45000);
    assert.equal(r.otherClaimedPaise, 12000);
    assert.equal(r.totalEligiblePaise, 8400 + 45000 + 12000);
    assert.equal(r.totalMetres, 24_900);
  });

  test("requirement 45 — a clean day under the ceiling approves itself", () => {
    const r = computeDay(policy(), SUBJECT, workingDay);
    const route = routeDay(policy(), SUBJECT, r);
    assert.equal(route.autoApproved, true);
    assert.equal(route.escalate, false);
  });

  test("anything flagged goes to a person, however small", () => {
    const flagged = computeDay(policy(), SUBJECT, day({
      legs: [leg({ id: "a", odometerMetres: 60_000, gpsMetres: 20_000 })],
    }));
    const route = routeDay(policy(), SUBJECT, flagged);
    assert.equal(route.autoApproved, false);
  });

  test("a big day reaches the owner AS WELL AS the manager", () => {
    const big = computeDay(policy(), SUBJECT, day({
      lines: [{ id: "l1", kind: "other", claimedPaise: 600000, hasProof: true }],
    }));
    const route = routeDay(policy(), SUBJECT, big);
    assert.equal(route.autoApproved, false);
    assert.equal(route.escalate, true);
  });

  test("a policy with no route says so rather than approving by default", () => {
    const routeless: Policy = {
      ...policy(),
      rules: policy().rules.filter((r) => r.kind !== "approval_route"),
    };
    const route = routeDay(routeless, SUBJECT, computeDay(routeless, SUBJECT, workingDay));
    assert.equal(route.autoApproved, false);
  });

  test("the day's KM ceiling is questioned, not refused", () => {
    const r = computeDay(policy(), SUBJECT, day({
      legs: [leg({ id: "a", odometerMetres: 420_000 })],
    }));
    assert.ok(r.exceptions.some((e) => e.kind === "over_km_ceiling"));
    assert.equal(r.travelPaise, 147000, "still worth 420 km × ₹3.50");
  });

  test("an unclosed day is computed to midnight and says so", () => {
    const r = computeDay(policy(), SUBJECT, day({
      clock: { departedMinutes: hhmm(7), returnedMinutes: null, arrivedAtDestinationMinutes: null },
    }));
    assert.ok(r.exceptions.some((e) => e.kind === "open_day" && e.severity === "info"));
  });

  test("worstSeverity ranks a blocker above a warning above a note", () => {
    assert.equal(worstSeverity([]), null);
    assert.equal(
      worstSeverity([
        { kind: "day_hotel", severity: "info", message: "", detail: {} },
        { kind: "over_cap", severity: "warn", message: "", detail: {} },
      ]),
      "warn",
    );
    assert.equal(
      worstSeverity([
        { kind: "over_cap", severity: "warn", message: "", detail: {} },
        { kind: "missing_proof", severity: "block_route", message: "", detail: {} },
      ]),
      "block_route",
    );
  });
});

/* ------------------------------------------------------- §C16 GPS distance */

describe("distance from the day's track", () => {
  const OPTS: TrailOptions = {
    maxAccuracyM: 100,
    expectedFixEveryMinutes: 5,
    roadFactorBps: 12500,
    minCoveragePct: 60,
  };

  const at = (mins: number) => Date.parse("2026-09-07T04:00:00Z") + mins * 60_000;
  /* Roughly a kilometre apart each, along a line. */
  const fix = (mins: number, i: number, accuracyM: number | null = 12): Fix => ({
    at: at(mins),
    lat: 19.0 + i * 0.009,
    lng: 72.85,
    accuracyM,
  });

  test("haversine is metres between two points, and symmetric", () => {
    const a = { lat: 19.0, lng: 72.85 };
    const b = { lat: 19.009, lng: 72.85 };
    const d = haversineMetres(a, b);
    assert.ok(d > 950 && d < 1050, `expected about a kilometre, got ${d}`);
    assert.equal(d, haversineMetres(b, a));
    assert.equal(haversineMetres(a, a), 0);
  });

  test("a well covered leg is measured along the track", () => {
    const fixes = [fix(0, 0), fix(5, 1), fix(10, 2), fix(15, 3)];
    const r = trailDistance(fixes, at(0), at(15), OPTS);
    assert.equal(r.method, "trail");
    assert.equal(r.fixCount, 4);
    assert.equal(r.coveragePct, 100);
    assert.ok(r.metres! > 2900 && r.metres! < 3100);
  });

  test("a loose fix is dropped rather than smoothed into the line", () => {
    const fixes = [fix(0, 0), fix(5, 40, 800), fix(10, 2)];
    const r = trailDistance(fixes, at(0), at(10), OPTS);
    assert.equal(r.fixCount, 2, "the 800 m fix is not a position");
    assert.ok(r.metres! < 2100, "and it did not invent forty kilometres of travel");
  });

  test("no fixes answers null WITH a reason, never zero", () => {
    const r = trailDistance([], at(0), at(30), OPTS);
    assert.equal(r.metres, null);
    assert.equal(r.method, null);
    assert.match(r.reason!, /no positions/);
  });

  test("one fix is not a path", () => {
    const r = trailDistance([fix(0, 0)], at(0), at(30), OPTS);
    assert.equal(r.metres, null);
    assert.match(r.reason!, /not a path/);
  });

  test("thin coverage falls back to a labelled estimate, never a quiet trail figure", () => {
    const fixes = [fix(0, 0), fix(55, 1)];
    const r = gpsDistanceForLeg(
      fixes,
      {
        startedAt: at(0),
        endedAt: at(60),
        from: { lat: 19.0, lng: 72.85 },
        to: { lat: 19.09, lng: 72.85 },
      },
      OPTS,
    );
    assert.equal(r.method, "straight_line_factored");
    assert.match(r.reason!, /estimate from the two ends/);
  });

  test("the road factor is applied to the straight line and says it is a guess", () => {
    const r = straightLineEstimate({ lat: 19.0, lng: 72.85 }, { lat: 19.09, lng: 72.85 }, 12500);
    const direct = haversineMetres({ lat: 19.0, lng: 72.85 }, { lat: 19.09, lng: 72.85 });
    assert.equal(r.metres, Math.round((direct * 12500) / 10000));
    assert.equal(r.method, "straight_line_factored");
  });

  test("a leg with neither times nor endpoints says what it is missing", () => {
    const r = gpsDistanceForLeg([], { startedAt: null, endedAt: null, from: null, to: null }, OPTS);
    assert.equal(r.metres, null);
    assert.match(r.reason!, /neither a start and end time nor two points/);
  });
});
