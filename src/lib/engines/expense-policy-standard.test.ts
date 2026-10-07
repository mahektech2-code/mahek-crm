import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computeDay,
  computeLeg,
  policyOn,
  routeDay,
  type DayFacts,
  type TravelLegFacts,
} from "./expense-policy";
import { STANDARD_POLICY, STANDARD_POLICY_ID, policyInWords } from "../expense-policy-standard";

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
  clock: { departedMinutes: hhmm(7), returnedMinutes: hhmm(21), arrivedAtDestinationMinutes: null },
  departedFromHometown: true,
  stayedInHotel: false,
  overnight: false,
  legs: [],
  lines: [],
  ...p,
});

test("it covers every date, old and new", () => {
  assert.equal(policyOn([STANDARD_POLICY], "2001-01-01")?.id, STANDARD_POLICY_ID);
  assert.equal(policyOn([STANDARD_POLICY], "2030-12-31")?.id, STANDARD_POLICY_ID);
});

test("the migration writes the row the policy id points at", () => {
  const sql = readFileSync("drizzle/0228_standard_expense_policy.sql", "utf8");
  assert.match(sql, new RegExp(`'${STANDARD_POLICY_ID}'`));
  assert.match(sql, new RegExp(`\\b${STANDARD_POLICY.versionNo}\\b`));
});

test("meals are the client's ₹100 / ₹250 / ₹450", () => {
  const all = computeDay(STANDARD_POLICY, subject, day({}));
  assert.equal(all.foodPaise, 45000);
  const noDinner = computeDay(
    STANDARD_POLICY,
    subject,
    day({ clock: { departedMinutes: hhmm(7), returnedMinutes: hhmm(16), arrivedAtDestinationMinutes: null } }),
  );
  assert.equal(noDinner.foodPaise, 25000);
  const lateStart = computeDay(
    STANDARD_POLICY,
    subject,
    day({ clock: { departedMinutes: hhmm(9), returnedMinutes: hhmm(11), arrivedAtDestinationMinutes: null } }),
  );
  assert.equal(lateStart.foodPaise, 0, "no breakfast after leaving at 9");
});

test("every travel mode the handset offers is priced", () => {
  const modes = new Set<string>();
  for (const f of ["drizzle/0090_travel_and_expense_days.sql", "drizzle/0127_the_day_says_how_he_travels.sql"]) {
    for (const m of readFileSync(f, "utf8").matchAll(/\('xmode_\w+',\s*'(\w+)'/g)) modes.add(m[1]);
  }
  assert.ok(modes.size >= 10);
  for (const modeKey of modes) {
    const c = computeLeg(STANDARD_POLICY, subject, leg({ modeKey, odometerMetres: 10_000, ticketAmountPaise: 5000 }));
    assert.equal(c.unpricedReason, null, `${modeKey} has no rate`);
  }
});

test("own bike is ₹3.50 a km", () => {
  const c = computeLeg(STANDARD_POLICY, subject, leg({ odometerMetres: 40_000 }));
  assert.equal(c.eligiblePaise, 14000);
});

test("a small clean day is approved automatically", () => {
  const c = computeDay(STANDARD_POLICY, subject, day({ legs: [leg({ odometerMetres: 20_000 })] }));
  assert.equal(routeDay(STANDARD_POLICY, subject, c).autoApproved, true);
});

test("the page is built from the same rules", () => {
  const words = policyInWords();
  const travel = words.find((s) => s.key === "travel")!;
  assert.equal(travel.lines.find((l) => l.label === "Own bike")?.value, "₹3.50 per km");
  const meals = words.find((s) => s.key === "meals")!;
  assert.equal(meals.lines.find((l) => l.label === "Breakfast")?.value, "₹100");
});
