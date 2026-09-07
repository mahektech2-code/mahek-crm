import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  RULE_KINDS,
  describeRule,
  parseRule,
  ruleSpec,
  unspecifiedKinds,
  validateRule,
  type RuleDraft,
} from "./expense-rule-forms";
import { POLICY_RULE_KINDS, computeLeg, type Policy } from "./engines/expense-policy";

const draft = (over: Partial<RuleDraft>): RuleDraft => ({
  kind: "per_km",
  scopeKey: "travel_mode:own_bike",
  grade: null,
  cityClass: null,
  value: { paisePerKm: 350 },
  ...over,
});

describe("every rule kind can be set from a screen", () => {
  test("there is a form for each of the thirteen", () => {
    assert.deepEqual(unspecifiedKinds(), []);
    assert.equal(RULE_KINDS.length, POLICY_RULE_KINDS.length);
  });

  test("each kind names the client requirements it answers", () => {
    for (const spec of RULE_KINDS) {
      assert.ok(spec.requirements.length > 0, `${spec.kind} answers no stated requirement`);
      assert.ok(spec.blurb.length > 20, `${spec.kind} has no blurb worth reading`);
    }
  });

  test("a field that may be left empty says what empty means", () => {
    for (const spec of RULE_KINDS) {
      for (const f of spec.fields) {
        if (!f.required) {
          assert.ok(f.emptyMeans, `${spec.kind}.${f.key} is optional and does not say what leaving it out does`);
        }
      }
    }
  });
});

describe("validation", () => {
  test("a good rule passes", () => {
    assert.deepEqual(validateRule(draft({})), []);
  });

  test("a missing required field names the field", () => {
    const errs = validateRule(draft({ value: {} }));
    assert.equal(errs.length, 1);
    assert.equal(errs[0]!.field, "paisePerKm");
  });

  test("an unknown kind is refused rather than stored", () => {
    const errs = validateRule(draft({ kind: "vibes" }));
    assert.equal(errs[0]!.field, "kind");
  });

  test("money and time have to be whole numbers", () => {
    const errs = validateRule(draft({ value: { paisePerKm: 3.5 } }));
    assert.match(errs[0]!.message, /whole number/);
  });

  test("a rule for the whole day may not name a scope", () => {
    const errs = validateRule(
      draft({ kind: "lodging", scopeKey: "travel_mode:bus", value: { maxPerNightPaise: 1, dayUseAllowed: true } }),
    );
    assert.equal(errs[0]!.field, "scopeKey");
  });

  test("a meal rule has to name a real meal", () => {
    const errs = validateRule(draft({ kind: "meal_rate", scopeKey: "brunch", value: { amountPaise: 100 } }));
    assert.equal(errs[0]!.field, "scopeKey");
  });

  test("a meal window has to close after it opens", () => {
    const errs = validateRule(
      draft({
        kind: "meal_entitlement",
        scopeKey: "lunch",
        value: { windowFromMinutes: 900, windowToMinutes: 720, minAwayMinutes: null },
      }),
    );
    assert.equal(errs[0]!.field, "windowToMinutes");
  });

  test("a dinner running past midnight is allowed, because that is what dinner does", () => {
    assert.deepEqual(
      validateRule(
        draft({
          kind: "meal_entitlement",
          scopeKey: "dinner",
          value: { windowFromMinutes: 23 * 60, windowToMinutes: 25 * 60 + 30, minAwayMinutes: null },
        }),
      ),
      [],
    );
  });

  test("a random odometer check of nought per cent is refused as the nothing it is", () => {
    const errs = validateRule(
      draft({ kind: "odometer_photo", scopeKey: "*", value: { when: "random", randomPct: 0 } }),
    );
    assert.equal(errs[0]!.field, "randomPct");
    assert.match(errs[0]!.message, /never happens/);
  });

  test("a daily cap below a single-claim cap is refused", () => {
    const errs = validateRule(
      draft({
        kind: "actuals",
        scopeKey: "category:local_transport",
        value: { capPerInstancePaise: 30000, capPerDayPaise: 20000 },
      }),
    );
    assert.equal(errs[0]!.field, "capPerDayPaise");
  });

  test("a distance precedence may not name the same source twice", () => {
    const errs = validateRule(
      draft({
        kind: "km_source",
        scopeKey: "*",
        value: { precedence: ["gps", "gps"], varianceFlagBps: 2500 },
      }),
    );
    assert.match(errs[0]!.message, /only be named once/);
  });

  test("a distance precedence may not name something that is not a distance", () => {
    const errs = validateRule(
      draft({ kind: "km_source", scopeKey: "*", value: { precedence: ["guess"], varianceFlagBps: 2500 } }),
    );
    assert.match(errs[0]!.message, /comes from one of/);
  });
});

describe("what is stored becomes what the engine reads", () => {
  test("a per-km row round-trips into a rule the engine pays on", () => {
    const rule = parseRule({
      kind: "per_km",
      scopeKey: "travel_mode:own_bike",
      grade: null,
      cityClass: null,
      valueJson: { paisePerKm: 350, dailyKmCap: null },
    })!;
    const policy: Policy = {
      id: "p",
      versionNo: 1,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      rules: [rule],
    };
    const r = computeLeg(policy, { grade: null, cityClass: null }, {
      id: "l",
      modeKey: "own_bike",
      gpsMetres: null,
      gpsCoveragePct: null,
      manualMetres: null,
      odometerMetres: 20_000,
      hasOdometerPhoto: false,
      ticketAmountPaise: null,
      hasTicketProof: false,
    });
    assert.equal(r.eligiblePaise, 7000);
  });

  test("a kind this release does not know is left out rather than failing the read", () => {
    assert.equal(
      parseRule({ kind: "teleportation", scopeKey: "", grade: null, cityClass: null, valueJson: {} }),
      null,
    );
  });

  test("a wildcard scope becomes 'every mode', not a mode called star", () => {
    const rule = parseRule({
      kind: "km_source",
      scopeKey: "*",
      grade: null,
      cityClass: null,
      valueJson: { precedence: ["odometer", "gps"], varianceFlagBps: 2500 },
    })!;
    assert.equal(rule.kind === "km_source" && rule.modeKey, null);
  });

  test("the qualifier survives the crossing", () => {
    const rule = parseRule({
      kind: "lodging",
      scopeKey: "",
      grade: "asm",
      cityClass: "metro",
      valueJson: { maxPerNightPaise: 400000, dayUseAllowed: false },
    })!;
    assert.equal(rule.grade, "asm");
    assert.equal(rule.cityClass, "metro");
  });
});

describe("a rule reads as a sentence, which is what makes verifying it possible", () => {
  const say = (row: Parameters<typeof parseRule>[0]) => describeRule(parseRule(row)!);

  test("the rate", () => {
    assert.equal(
      say({ kind: "per_km", scopeKey: "travel_mode:own_bike", grade: null, cityClass: null, valueJson: { paisePerKm: 350, dailyKmCap: null } }),
      "own bike is paid ₹3.5 a kilometre.",
    );
  });

  test("the meals, on the client's own figures", () => {
    assert.equal(
      say({ kind: "meal_rate", scopeKey: "breakfast", grade: null, cityClass: null, valueJson: { amountPaise: 10000 } }),
      "Breakfast is worth ₹100.",
    );
    assert.equal(
      say({ kind: "meal_disqualifier", scopeKey: "breakfast", grade: null, cityClass: null, valueJson: { departedAfterMinutes: 480 } }),
      "Breakfast is not paid to anybody leaving after 08:00.",
    );
  });

  test("the dormitory says it replaces the meals rather than adding to them", () => {
    assert.match(
      say({ kind: "dormitory", scopeKey: "", grade: null, cityClass: null, valueJson: { arrivalFromMinutes: 360, arrivalToMinutes: 600, amountPaise: 25000, replacesMeals: true } }),
      /₹250, instead of the day's meals/,
    );
  });

  test("a day room says plainly that it pays nothing", () => {
    assert.match(
      say({ kind: "lodging", scopeKey: "", grade: null, cityClass: null, valueJson: { maxPerNightPaise: 150000, dayUseAllowed: false } }),
      /room with no night in it pays nothing/,
    );
  });

  test("the approval route says all three of its answers", () => {
    const s = say({
      kind: "approval_route",
      scopeKey: "",
      grade: null,
      cityClass: null,
      valueJson: { autoApproveUpToPaise: 100000, escalateAboveDayTotalPaise: 500000, escalateOnSeverity: "warn" },
    });
    assert.match(s, /approved on submission/);
    assert.match(s, /also reaches the owner/);
    assert.match(s, /waits for a manager/);
  });

  test("every kind produces a sentence, and none of them is empty", () => {
    for (const spec of RULE_KINDS) {
      const scopeKey =
        spec.scope === "none" ? "" : spec.scope === "meal" ? "breakfast" : spec.scope === "wildcard" ? "*" : "travel_mode:own_bike";
      const value: Record<string, unknown> = {};
      for (const f of spec.fields) {
        value[f.key] =
          f.type === "boolean" ? true
          : f.type === "select" ? f.options![0]!.value
          : f.type === "km_precedence" ? ["odometer", "gps"]
          : 100;
      }
      const rule = parseRule({ kind: spec.kind, scopeKey, grade: null, cityClass: null, valueJson: value });
      assert.ok(rule, `${spec.kind} did not parse`);
      const sentence = describeRule(rule!);
      assert.ok(sentence.length > 10, `${spec.kind} says nothing: "${sentence}"`);
      assert.ok(sentence.endsWith("."), `${spec.kind} is not a sentence: "${sentence}"`);
    }
  });
});

describe("the spec lookup", () => {
  test("finds a kind and refuses an invention", () => {
    assert.equal(ruleSpec("per_km")!.label, "Rate per kilometre");
    assert.equal(ruleSpec("nonsense"), null);
  });
});
