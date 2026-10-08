import test from "node:test";
import assert from "node:assert/strict";
import {
  DUTY_LABEL,
  MATERIAL_DUTIES,
  dutyAllows,
  dutyAllowsAll,
  dutyApplies,
  dutyBookFrom,
  dutyRefusal,
  type DutyActor,
} from "./material-duties";

const book = dutyBookFrom([
  { rawMaterialId: "xylene", duty: "request", userId: "priya", designationId: null },
  { rawMaterialId: "xylene", duty: "request", userId: null, designationId: "production" },
  { rawMaterialId: "xylene", duty: "approve", userId: "deepa", designationId: null },
  { rawMaterialId: "xylene", duty: "test", userId: null, designationId: "quality" },
  { rawMaterialId: "xylene", duty: "nonsense", userId: "x", designationId: null },
]);

const who = (userId: string, designationIds: string[] = [], administrator = false): DutyActor => ({ userId, designationIds, administrator });

test("an unconfigured duty keeps the rule that held before", () => {
  assert.equal(dutyAllows(book, "xylene", "raisePo", who("anyone"), true), true);
  assert.equal(dutyAllows(book, "acetate", "request", who("anyone"), true), true);
  /* Approval falls back to the power, so an unconfigured material is still the power holder's. */
  assert.equal(dutyAllows(book, "acetate", "approve", who("anyone"), false), false);
  assert.equal(dutyAllows(book, "acetate", "approve", who("anyone"), true), true);
});

test("a configured duty is the named people's and the named departments' alone", () => {
  assert.equal(dutyAllows(book, "xylene", "request", who("priya"), true), true);
  assert.equal(dutyAllows(book, "xylene", "request", who("rakesh", ["production"]), true), true);
  assert.equal(dutyAllows(book, "xylene", "request", who("rakesh", ["packing"]), true), false);
  assert.equal(dutyAllows(book, "xylene", "test", who("anjali", ["quality"]), true), true);
  assert.equal(dutyAllows(book, "xylene", "test", who("priya"), true), false);
});

test("a named approver approves without the power; an unnamed power holder no longer does", () => {
  assert.equal(dutyAllows(book, "xylene", "approve", who("deepa"), false), true);
  assert.equal(dutyAllows(book, "xylene", "approve", who("vikram"), true), false);
});

test("an ERP administrator holds every duty", () => {
  for (const d of MATERIAL_DUTIES) assert.equal(dutyAllows(book, "xylene", d, who("admin", [], true), false), true);
});

test("a PO needs the duty for every line", () => {
  assert.equal(dutyAllowsAll(book, ["xylene", "acetate"], "approve", who("deepa"), false), false);
  assert.equal(dutyAllowsAll(book, ["xylene", "acetate"], "approve", who("deepa"), true), true);
  assert.equal(dutyAllowsAll(book, ["xylene", "acetate"], "approve", who("vikram"), true), false);
});

test("a refusal names who the duty belongs to, and is silent where nothing is set", () => {
  const names = { users: new Map([["priya", "Priya Shah"]]), designations: new Map([["production", "Production"]]) };
  assert.equal(dutyRefusal(book, { id: "xylene", name: "Mix Xylene" }, "request", names), "Requesting Mix Xylene is set to Priya Shah, Production");
  assert.equal(dutyRefusal(book, { id: "xylene", name: "Mix Xylene" }, "raisePo", names), null);
});

test("testing is a chemical's duty only; an unknown duty in storage is ignored", () => {
  assert.equal(dutyApplies("test", "Chemical"), true);
  assert.equal(dutyApplies("test", "Can"), false);
  assert.equal(dutyApplies("request", "Can"), true);
  assert.equal(DUTY_LABEL.test.chemicalOnly, true);
  assert.deepEqual(Object.keys(book.get("xylene")!).sort(), ["approve", "request", "test"]);
});
