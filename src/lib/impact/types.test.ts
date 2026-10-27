import { test } from "node:test";
import assert from "node:assert/strict";
import { IMPACT_FIELD, impactFingerprint, readConfirmation, typedMatches, type ImpactItem } from "./types";

const item = (over: Partial<ImpactItem> = {}): ImpactItem => ({
  app: "CRM",
  label: "orders",
  effect: "deleted",
  count: 3,
  ...over,
});

test("the typed name matches whatever its case and spacing, and nothing else", () => {
  assert.equal(typedMatches("raja  parba ", "Raja Parba"), true);
  assert.equal(typedMatches("Raja", "Raja Parba"), false);
  assert.equal(typedMatches("", ""), false, "an empty word confirms nothing");
});

test("the fingerprint moves when a count does, and not when the prose does", () => {
  const base = { kind: "customer", id: "c1", items: [item()], blockers: [] };
  const same = impactFingerprint(base);
  assert.equal(impactFingerprint({ ...base, items: [item({ examples: ["Order 7"], note: "reworded" })] }), same);
  assert.notEqual(impactFingerprint({ ...base, items: [item({ count: 4 })] }), same);
  assert.notEqual(impactFingerprint({ ...base, items: [item({ effect: "unlinked" })] }), same);
  assert.notEqual(impactFingerprint({ ...base, blockers: ["It has bills"] }), same);
  assert.notEqual(impactFingerprint({ ...base, id: "c2" }), same);
});

test("a confirmation is read back out of an action's string payload", () => {
  const c = { typed: "Diwali", fingerprint: "3:abc" };
  assert.deepEqual(readConfirmation({ [IMPACT_FIELD]: JSON.stringify(c) }), c);
  assert.equal(readConfirmation({}), null);
  assert.equal(readConfirmation({ [IMPACT_FIELD]: "not json" }), null);
  assert.equal(readConfirmation(undefined), null);
});
