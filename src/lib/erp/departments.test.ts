import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEPARTMENT_SEATS,
  ERP_DEPARTMENTS,
  categoriesFor,
  departmentByLabel,
  departmentsOf,
  requirementRefusal,
  requirementStep,
  requirementVisibleTo,
} from "./departments";
import { ERP_SCREENS } from "./registry";
import { ERP_POWERS } from "./powers";

const TYPES = ["Chemical", "Can", "Drum", "Box", "Stationary"];

test("each department asks for its own categories, and between them every category is somebody's", () => {
  assert.deepEqual(categoriesFor("Mixing & Blending", TYPES), ["Chemical"]);
  assert.deepEqual(categoriesFor("Refilling", TYPES), ["Can", "Drum"]);
  assert.deepEqual(categoriesFor("Packing", TYPES), ["Box", "Stationary"]);
  assert.deepEqual(categoriesFor("Office", TYPES), TYPES, "a department outside production is not narrowed");
  const covered = new Set(ERP_DEPARTMENTS.flatMap((d) => d.materialTypes));
  for (const t of TYPES) assert.ok(covered.has(t), `${t} belongs to no department`);
});

test("the production head works in all three; a department in one; nobody else in any", () => {
  assert.deepEqual(departmentsOf("head").map((d) => d.key), ["mixing", "refilling", "packing"]);
  assert.deepEqual(departmentsOf("packing").map((d) => d.key), ["packing"]);
  assert.deepEqual(departmentsOf(null), []);
});

test("a Mixing & Blending requirement is a chemical one, whoever raises it", () => {
  assert.equal(requirementRefusal(null, "Mixing & Blending", "Chemical"), null);
  assert.equal(requirementRefusal(null, "Mixing & Blending", "Box")?.field, "type");
  assert.equal(requirementRefusal(null, "Office", "Box"), null, "not a production department");
});

test("a department raises for itself only; the head raises for all three", () => {
  assert.equal(requirementRefusal("refilling", "Refilling", "Can"), null);
  assert.equal(requirementRefusal("refilling", "Refilling", "Drum"), null);
  assert.equal(requirementRefusal("refilling", "Packing", "Box")?.field, "department");
  assert.equal(requirementRefusal("refilling", "Office", "Can")?.field, "department");
  assert.equal(requirementRefusal("refilling", "Refilling", "Chemical")?.field, "type");
  for (const d of ERP_DEPARTMENTS) for (const t of d.materialTypes) assert.equal(requirementRefusal("head", d.label, t), null);
});

test("a departmental list shows its departments' requirements and what they raised themselves", () => {
  assert.ok(requirementVisibleTo("mixing", "Mixing & Blending", false));
  assert.ok(!requirementVisibleTo("mixing", "Packing", false));
  assert.ok(!requirementVisibleTo("mixing", "Production", false));
  assert.ok(requirementVisibleTo("mixing", "Production", true), "their own, whatever it names");
  assert.ok(requirementVisibleTo("head", "Packing", false));
  assert.ok(requirementVisibleTo(null, "Anything", false), "nobody outside a department is narrowed");
});

test("department labels are matched however they are cased", () => {
  assert.equal(departmentByLabel("mixing & blending")?.key, "mixing");
  assert.equal(departmentByLabel("  Packing ")?.key, "packing");
  assert.equal(departmentByLabel("Production"), undefined);
});

test("a requirement is counted under the step that asks for its category", () => {
  assert.equal(requirementStep("Packing", "Stationary")?.step.key, "stationeryReq");
  assert.equal(requirementStep("Packing", "Box")?.step.key, "boxReq");
  assert.equal(requirementStep("Refilling", "Drum")?.step.key, "canReq");
  assert.equal(requirementStep("Production", "Chemical")?.department.key, "mixing", "the store's chemical still feeds mixing");
  assert.equal(requirementStep("Packing", "Chemical"), null, "a department's own label is not re-read as another's");
});

test("every step names a built screen", () => {
  for (const d of ERP_DEPARTMENTS) for (const st of d.steps) assert.ok(ERP_SCREENS.find((s) => s.key === st.screen)?.built, `${st.screen} is not a built screen`);
});

test("the departmental designations seed only real screens, powers and seats", () => {
  const sql = readFileSync(new URL("../../../drizzle/0226_erp_departments.sql", import.meta.url), "utf8");
  const built = new Set(ERP_SCREENS.filter((s) => s.built).map((s) => `erp.${s.key}`));
  for (const m of sql.matchAll(/'(erp\.[A-Za-z]+)'/g)) assert.ok(built.has(m[1]), `${m[1]} is not an ERP screen`);
  for (const m of sql.matchAll(/'(mixing|refilling|packing|head)'/g)) assert.ok((DEPARTMENT_SEATS as readonly string[]).includes(m[1]));
  for (const m of sql.matchAll(/power"\) VALUES[\s\S]*?;/g)) for (const p of m[0].matchAll(/'([a-zA-Z]+)'\)/g)) assert.ok((ERP_POWERS as readonly string[]).includes(p[1]));
});
