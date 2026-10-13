import { test } from "node:test";
import assert from "node:assert/strict";
import { allPassValues, EVIDENCE_FIELDS, evidenceFileIds, hasEvidence, qcEvidenceFields, qcTestFields, readQcEvidence, readQcTests, testKey, testResultsLine } from "./sfg-tests";

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

test("the SFG QC prompt asks Lot testing's evidence, none of it required or tagged", () => {
  const fields = qcEvidenceFields(["PH", "Smell", "Density", "Viscosity"]);
  assert.deepEqual(
    fields.map((f) => f.k),
    ["ph", "phValue", "smell", "density", "densityPhoto", "photo:Viscosity", "video"],
    "a test the list does not know is asked for as a photograph",
  );
  assert.ok(fields.every((f) => f.untagged && !("req" in f)));
  assert.deepEqual(
    EVIDENCE_FIELDS.filter((f) => f.test === "PH").map((f) => f.l),
    ["pH photo", "PH Value"],
    "one list for both kinds of test",
  );
});

test("evidence: blank is fine everywhere, and what is given must make sense", () => {
  const tests = ["PH", "Smell", "Density", "Color"];
  assert.deepEqual(readQcEvidence(tests, {}), { ok: true, evidence: { photos: {} } });
  const read = readQcEvidence(tests, { ph: "f1", phValue: "6.5", smell: "Good", density: "0.9", color: "f2", video: "v1", oil: "ignored" });
  assert.deepEqual(read, { ok: true, evidence: { photos: { PH: "f1", Color: "f2" }, phValue: 6.5, smell: "Good", density: 0.9, video: "v1" } });
  assert.deepEqual(readQcEvidence(tests, { smell: "Lovely" }), { ok: false, field: "smell", message: "Choose Good, Moderate, Bad for smell" });
  assert.equal(readQcEvidence(tests, { density: "3" }).ok, false);
  assert.equal(readQcEvidence(tests, { phValue: "x" }).ok, false);
  if (read.ok) {
    assert.deepEqual(evidenceFileIds(read.evidence).sort(), ["f1", "f2", "v1"]);
    assert.equal(hasEvidence(read.evidence), true);
  }
  assert.equal(hasEvidence({ photos: {} }), false);
});
