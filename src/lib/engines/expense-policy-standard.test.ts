import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computeDay,
  computeLeg,
  policyOn,
  type DayFacts,
  type TravelLegFacts,
} from "./expense-policy";
import {
  STANDARD_POLICY,
  STANDARD_POLICY_ID,
  policyInWords,
} from "../expense-policy-standard";

/* The hard-coded standard policy: the client's own figures, every travel mode
   priced, every date covered, and the page saying what the engine pays. */

const subject = { grade: null, cityClass: null };
const hhmm = (h: number, m = 0) => h * 60 + m;

const leg = (p: Partial<TravelLegFacts>): TravelLegFacts => ({
  id: "l",
  modeKey: "own_bike",
  gpsMetres: null,
  gpsCoveragePct: null,
  manualMetres: null,
  odometerMetres: null,
  hasOdometerPhoto: false,
  ticketAmountPaise: null,
  hasTicketProof: false,
  ...p,
});

const day = (p: Partial<DayFacts>): DayFacts => ({
  day: "2026-10-07",
  clock: {
    departedMinutes: hhmm(7),
    returnedMinutes: hhmm(21),
    arrivedAtDestinationMinutes: null,
  },
  departedFromHometown: true,
  stayedInHotel: false,
  overnight: false,
  legs: [],
  lines: [],
  ...p,
});

test("it covers every date, old and new", () => {
  assert.equal(
    policyOn([STANDARD_POLICY], "2001-01-01")?.id,
    STANDARD_POLICY_ID,
  );
  assert.equal(
    policyOn([STANDARD_POLICY], "2030-12-31")?.id,
    STANDARD_POLICY_ID,
  );
});

test("the migration writes the row the policy id points at", () => {
  const sql = readFileSync("drizzle/0228_standard_expense_policy.sql", "utf8");
  assert.match(sql, new RegExp(`'${STANDARD_POLICY_ID}'`));
  assert.match(sql, new RegExp(`\\b${STANDARD_POLICY.versionNo}\\b`));
});

/* The issued Expense Policy document, row for row. */
const left = (h: number, m = 0) => ({ departedMinutes: hhmm(h, m) });
const trip = (dep: number, ret: number) => ({
  clock: {
    departedMinutes: dep,
    returnedMinutes: ret,
    arrivedAtDestinationMinutes: null,
  },
});

test("leaving after 8 AM earns no meal", () => {
  assert.equal(
    computeDay(STANDARD_POLICY, subject, day(trip(hhmm(8, 30), hhmm(23))))
      .foodPaise,
    0,
  );
  assert.equal(left(9).departedMinutes, hhmm(9));
});

test("leaving between 11 PM and 8 AM and back by 10:30 PM is breakfast and lunch, ₹250", () => {
  assert.equal(
    computeDay(STANDARD_POLICY, subject, day(trip(hhmm(7), hhmm(21))))
      .foodPaise,
    25000,
  );
  assert.equal(
    computeDay(STANDARD_POLICY, subject, day(trip(hhmm(7), hhmm(22, 30))))
      .foodPaise,
    25000,
  );
});

test("leaving early and back after 10:30 PM adds dinner, ₹450", () => {
  assert.equal(
    computeDay(STANDARD_POLICY, subject, day(trip(hhmm(6), hhmm(23))))
      .foodPaise,
    45000,
  );
});

test("leaving just before midnight counts as an early start", () => {
  assert.equal(
    computeDay(STANDARD_POLICY, subject, day(trip(hhmm(23, 30), hhmm(21))))
      .foodPaise,
    25000,
  );
});

test("a day in his own hometown earns no meal", () => {
  const c = computeDay(
    STANDARD_POLICY,
    subject,
    day({ ...trip(hhmm(6), hhmm(23)), departedFromHometown: false }),
  );
  assert.equal(c.foodPaise, 0);
});

test("a night in a hotel is a fixed ₹450, whatever the bill", () => {
  for (const bill of [30000, 45000, 90000]) {
    const c = computeDay(
      STANDARD_POLICY,
      subject,
      day({
        stayedInHotel: true,
        overnight: true,
        lines: [
          {
            id: "h",
            kind: "lodging",
            claimedPaise: bill,
            hasProof: true,
            nights: 1,
          },
        ],
      }),
    );
    assert.equal(c.lodgingEligiblePaise, 45000, `bill ${bill}`);
  }
});

test("overnight travel arriving 6–10 AM with no hotel is a ₹250 dormitory", () => {
  const c = computeDay(
    STANDARD_POLICY,
    subject,
    day({
      overnight: true,
      clock: {
        departedMinutes: hhmm(23, 30),
        returnedMinutes: hhmm(21),
        arrivedAtDestinationMinutes: hhmm(7),
      },
    }),
  );
  assert.equal(
    c.foodPaise - 25000,
    25000,
    "breakfast and lunch, plus the dormitory",
  );
});

test("a food bill is not paid — meals are the allowance", () => {
  const c = computeDay(
    STANDARD_POLICY,
    subject,
    day({
      ...trip(hhmm(9), hhmm(19)),
      lines: [{ id: "f", kind: "food", claimedPaise: 30000, hasProof: true }],
    }),
  );
  assert.equal(c.otherEligiblePaise, 0);
});

test("local travel is paid at actuals, with no limit", () => {
  const c = computeLeg(
    STANDARD_POLICY,
    subject,
    leg({
      modeKey: "share_auto",
      ticketAmountPaise: 123456,
      hasTicketProof: true,
    }),
  );
  assert.equal(c.eligiblePaise, 123456);
});

test("every travel mode the handset offers is priced", () => {
  const modes = new Set<string>();
  for (const f of [
    "drizzle/0090_travel_and_expense_days.sql",
    "drizzle/0127_the_day_says_how_he_travels.sql",
    "drizzle/0242_expense_policy_matches_document.sql",
  ]) {
    for (const m of readFileSync(f, "utf8").matchAll(
      /\('xmode_\w+',\s*'(\w+)'/g,
    ))
      modes.add(m[1]);
  }
  assert.ok(modes.size >= 10);
  for (const modeKey of modes) {
    const c = computeLeg(
      STANDARD_POLICY,
      subject,
      leg({ modeKey, odometerMetres: 10_000, ticketAmountPaise: 5000 }),
    );
    assert.equal(c.unpricedReason, null, `${modeKey} has no rate`);
  }
});

test("own vehicles are recorded and not paid — the document does not pay them", () => {
  const c = computeLeg(
    STANDARD_POLICY,
    subject,
    leg({ odometerMetres: 40_000 }),
  );
  assert.equal(c.eligiblePaise, 0);
  assert.equal(c.unpricedReason, null);
});

test("the page is built from the same rules", () => {
  const words = policyInWords();
  const travel = words.find((s) => s.key === "travel")!;
  assert.equal(
    travel.lines.find((l) => l.label === "Own bike")?.value,
    "Not paid",
  );
  const meals = words.find((s) => s.key === "meals")!;
  assert.equal(meals.lines.find((l) => l.label === "Breakfast")?.value, "₹100");
  const hotel = words.find((s) => s.key === "hotel")!;
  assert.equal(hotel.lines[0]?.value, "₹450 a night");
});

test("each bill is worth its own figure, never a share of the day", () => {
  const c = computeDay(
    STANDARD_POLICY,
    subject,
    day({
      lines: [
        { id: "food", kind: "food", claimedPaise: 30000, hasProof: true },
        {
          id: "bus",
          kind: "local_transport",
          claimedPaise: 10000,
          hasProof: true,
        },
      ],
    }),
  );
  assert.equal(c.lineEligiblePaise.food, 0);
  assert.equal(c.lineEligiblePaise.bus, 10000);
});

test("a travel bill with no photo needs none on a day the app recorded a trip", () => {
  const bill = {
    id: "b",
    kind: "local_transport" as const,
    claimedPaise: 4000,
    hasProof: false,
  };
  const bare = computeDay(STANDARD_POLICY, subject, day({ lines: [bill] }));
  assert.ok(bare.exceptions.some((e) => e.kind === "missing_proof"));
  const logged = computeDay(
    STANDARD_POLICY,
    subject,
    day({ lines: [bill], legs: [leg({ gpsMetres: 5000 })] }),
  );
  assert.ok(!logged.exceptions.some((e) => e.kind === "missing_proof"));
});
