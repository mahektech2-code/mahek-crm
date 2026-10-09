import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STANDARD_POLICY, policyInWords } from "./expense-policy-standard";
import {
  RULE_SECTIONS,
  blankRule,
  checkRules,
  diffRules,
  policyGaps,
  readStoredRules,
  ruleToDraft,
  sectionOf,
} from "./expense-policy-sets";
import { POLICY_RULE_KINDS, computeDay, type Policy } from "./engines/expense-policy";

/* The editor round-trips every rule through a draft and back. If that loses
   or bends a single figure, saving the standard policy unchanged would quietly
   change what the field is paid — so the round trip is pinned whole. */

const drafts = () => STANDARD_POLICY.rules.map(ruleToDraft);

test("the standard policy survives the editor unchanged", () => {
  const { rules, errors } = checkRules(drafts());
  assert.deepEqual(errors, []);
  assert.deepEqual(rules, STANDARD_POLICY.rules);
});

test("the stored JSON reads back as the same rules", () => {
  const stored = JSON.parse(JSON.stringify(STANDARD_POLICY.rules));
  const { rules, unreadable } = readStoredRules(stored);
  assert.equal(unreadable, 0);
  assert.deepEqual(rules, STANDARD_POLICY.rules);
});

test("a rule this release cannot read is counted, never thrown on", () => {
  const { rules, unreadable } = readStoredRules([{ kind: "teleport_rate", x: 1 }, null, 7, STANDARD_POLICY.rules[0]]);
  assert.equal(unreadable, 3);
  assert.equal(rules.length, 1);
});

test("a stored set prices a day exactly as the hard-coded policy did", () => {
  const { rules } = readStoredRules(JSON.parse(JSON.stringify(STANDARD_POLICY.rules)));
  const named: Policy = { id: "xpol_x", versionNo: 4, effectiveFrom: "2000-01-01", effectiveTo: null, rules };
  const day = {
    day: "2026-06-15",
    clock: { departedMinutes: 7 * 60, returnedMinutes: 21 * 60, arrivedAtDestinationMinutes: null },
    departedFromHometown: true,
    stayedInHotel: false,
    overnight: false,
    legs: [
      {
        id: "l1",
        modeKey: "own_bike",
        gpsMetres: 30_000,
        gpsCoveragePct: 100,
        manualMetres: null,
        odometerMetres: 32_000,
        hasOdometerPhoto: true,
        ticketAmountPaise: null,
        hasTicketProof: false,
      },
    ],
    lines: [{ id: "x", kind: "food" as const, claimedPaise: 60_000, hasProof: true }],
  };
  const a = computeDay(STANDARD_POLICY, { grade: null, cityClass: null }, day);
  const b = computeDay(named, { grade: null, cityClass: null }, day);
  assert.equal(b.totalEligiblePaise, a.totalEligiblePaise);
  assert.equal(b.foodPaise, a.foodPaise);
  assert.equal(b.travelPaise, a.travelPaise);
});

test("two rules answering one question for the same people are refused", () => {
  const list = [...drafts(), ruleToDraft(STANDARD_POLICY.rules[0]!)];
  const { errors } = checkRules(list);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.index, list.length - 1);
  assert.match(errors[0]!.message, /repeats rule 1/);
});

test("the same rule for a different grade is an override, not a repeat", () => {
  const override = { ...ruleToDraft(STANDARD_POLICY.rules[0]!), grade: "asm", value: { paisePerKm: 500, dailyKmCap: null } };
  const { errors, rules } = checkRules([...drafts(), override]);
  assert.deepEqual(errors, []);
  assert.equal(rules.length, STANDARD_POLICY.rules.length + 1);
});

test("a bad figure is marked on its own field", () => {
  const list = drafts();
  const i = list.findIndex((d) => d.kind === "meal_rate");
  list[i] = { ...list[i]!, value: { amountPaise: "a lot" } };
  const j = list.findIndex((d) => d.kind === "meal_entitlement");
  list[j] = { ...list[j]!, value: { ...list[j]!.value, windowToMinutes: 0 } };
  const { errors } = checkRules(list);
  assert.ok(errors.some((e) => e.index === i && e.field === "amountPaise"));
  assert.ok(errors.some((e) => e.index === j && e.field === "windowToMinutes"));
});

test("a limit with nothing to apply to is refused", () => {
  const blank = blankRule("actuals", "travel");
  const { errors } = checkRules([blank]);
  assert.ok(errors.some((e) => e.field === "scopeKey"));
  const vehicle = { ...blankRule("per_km", "travel"), scopeKey: "category:food" };
  assert.ok(checkRules([vehicle]).errors.some((e) => e.field === "scopeKey"));
});

test("every kind can be added somewhere, and a fresh one is valid once its scope is picked", () => {
  const addable = new Set(RULE_SECTIONS.flatMap((s) => s.kinds));
  for (const k of POLICY_RULE_KINDS) assert.ok(addable.has(k), `${k} has no section`);
  for (const s of RULE_SECTIONS) {
    for (const k of s.kinds) {
      const d = blankRule(k, s.key);
      const needsScope = k === "per_km" || k === "zero_rated" || k === "actuals";
      const fixed = d.scopeKey || !needsScope ? d : { ...d, scopeKey: k === "actuals" ? "travel_mode:bus" : "own_bike" };
      assert.deepEqual(checkRules([fixed]).errors, [], `${k} in ${s.key}`);
      assert.equal(sectionOf(fixed), k === "actuals" && s.key === "travel" ? "travel" : s.key);
    }
  }
});

test("the standard policy has no gaps, and an empty one says what it lacks", () => {
  assert.deepEqual(policyGaps(STANDARD_POLICY.rules), []);
  assert.ok(policyGaps([]).length >= 4);
});

test("the words for the standard policy do not move when they are built from its rules", () => {
  assert.deepEqual(policyInWords(STANDARD_POLICY.rules), policyInWords());
});

test("the diff counts what moved", () => {
  const before = drafts();
  const after = before.slice(1);
  after[0] = { ...after[0]!, value: { ...after[0]!.value, paisePerKm: 1000 } };
  after.push({ ...before[0]!, grade: "asm" });
  assert.deepEqual(diffRules(before, after), { added: 1, removed: 1, changed: 1 });
});

test("the migration creates the tables and leaves the rates to the code", () => {
  const sql = readFileSync("drizzle/0241_expense_policy_sets.sql", "utf8");
  for (const t of ["expense_policy_sets", "expense_policy_set_revisions", "expense_policy_assignments"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
  }
  assert.doesNotMatch(sql, /paisePerKm/);
});
