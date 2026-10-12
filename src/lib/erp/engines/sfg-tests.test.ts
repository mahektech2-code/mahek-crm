import { test } from "node:test";
import assert from "node:assert/strict";
import { allPassValues, qcTestFields, readQcTests, testKey, testResultsLine } from "./sfg-tests";

const TESTS = ["PH", "Smell", "Density"];

test("one Pass/Fail field per active test, required only to approve", () => {
  const approve = qcTestFields(TESTS, true);
  assert.deepEqual(approve.map((f) => f.l), TESTS);
  assert.ok(approve.every((f) => f.req && f.t === "select" && f.opts.join() === "Pass,Fail"));
  assert.ok(qcTestFields(TESTS, false).every((f) => !f.req));
  assert.deepEqual(qcTestFields([], true), [], "no Testing list, no fields");
});

test("approving needs every test answered, and every answer Pass", () => {
  const pass = allPassValues(TESTS);
  assert.deepEqual(readQcTests(TESTS, pass, true), { ok: true, results: { PH: "Pass", Smell: "Pass", Density: "Pass" } });
  const missing = readQcTests(TESTS, { ...pass, [testKey("Smell")]: "" }, true);
  assert.deepEqual(missing, { ok: false, field: testKey("Smell"), message: "Record the Smell result before approving" });
  const failed = readQcTests(TESTS, { ...pass, [testKey("PH")]: "Fail", [testKey("Density")]: "Fail" }, true);
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.field, testKey("PH"));
    assert.match(failed.message, /^PH, Density failed/);
  }
});

test("rejecting records what was answered and asks for nothing more", () => {
  assert.deepEqual(readQcTests(TESTS, { [testKey("PH")]: "Fail" }, false), { ok: true, results: { PH: "Fail" } });
  assert.deepEqual(readQcTests(TESTS, {}, false), { ok: true, results: {} });
});

test("a value that is not Pass or Fail, or a test not on the list, is not recorded", () => {
  assert.equal(readQcTests(TESTS, { ...allPassValues(TESTS), [testKey("PH")]: "Maybe" }, true).ok, false);
  const extra = readQcTests(TESTS, { ...allPassValues(TESTS), [testKey("Colour")]: "Pass" }, true);
  assert.ok(extra.ok && !("Colour" in extra.results));
  assert.equal(readQcTests([], {}, true).ok, true, "an empty Testing list approves on the note alone");
});

test("the recorded checks read back in one line", () => {
  assert.equal(testResultsLine({ PH: "Pass", Smell: "Fail" }), "PH: Pass · Smell: Fail");
  assert.equal(testResultsLine({}), null);
  assert.equal(testResultsLine(null), null);
});
