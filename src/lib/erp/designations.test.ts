import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { moduleKeysForApp } from "../modules";
import { ERP_POWERS } from "./powers";
import {
  designationShape,
  diffFromDesignation,
  draftFor,
  heldShape,
  isEmptyDiff,
  matchesDesignation,
} from "./designations";

const ALL = moduleKeysForApp("erp");
const TESTER = { level: "associate" as const, allScreens: false, modules: ["erp.testing", "erp.expenses", "erp.videos"], powers: [] };

test("holding exactly the designation's screens and powers matches it", () => {
  const held = heldShape({ level: "associate", moduleRows: ["erp.dashboard", "erp.settings", "erp.testing", "erp.expenses", "erp.videos"], powers: [] }, ALL);
  assert.ok(matchesDesignation(held, designationShape(TESTER, ALL), ALL));
});

test("the always-open screens never make anybody customised", () => {
  const held = heldShape({ level: "associate", moduleRows: ["erp.testing", "erp.expenses", "erp.videos"], powers: [] }, ALL);
  assert.ok(matchesDesignation(held, designationShape(TESTER, ALL), ALL));
});

test("an extra screen, a missing power and a different level are each named", () => {
  const held = heldShape({ level: "manager", moduleRows: ["erp.testing", "erp.expenses", "erp.videos", "erp.stock"], powers: [] }, ALL);
  const d = designationShape({ ...TESTER, powers: ["verifyTest"] }, ALL);
  const diff = diffFromDesignation(held, d, ALL);
  assert.deepEqual(diff.level, ["manager", "associate"]);
  assert.deepEqual(diff.extraScreens, ["erp.stock"]);
  assert.deepEqual(diff.missingPowers, ["verifyTest"]);
  assert.ok(!isEmptyDiff(diff));
});

test("no module rows is the whole app, which is what an all-screens designation means", () => {
  const held = heldShape({ level: "manager", moduleRows: [], powers: ["viewCost"] }, ALL);
  const d = designationShape({ level: "manager", allScreens: true, modules: [], powers: ["viewCost"] }, ALL);
  assert.ok(matchesDesignation(held, d, ALL));
  /* …and every screen ticked by hand is the same fact stored the long way. */
  const ticked = heldShape({ level: "manager", moduleRows: [...ALL], powers: ["viewCost"] }, ALL);
  assert.ok(matchesDesignation(ticked, d, ALL));
});

test("an administrator holds every power, so stored power rows cannot customise one", () => {
  const held = heldShape({ level: "admin", moduleRows: [], powers: ["viewCost"] }, ALL);
  const d = designationShape({ level: "admin", allScreens: true, modules: [], powers: [] }, ALL);
  assert.ok(matchesDesignation(held, d, ALL));
});

test("a designation with no screens is not the whole app", () => {
  const held = heldShape({ level: "associate", moduleRows: [], powers: [] }, ALL);
  const d = designationShape({ level: "associate", allScreens: false, modules: [], powers: [] }, ALL);
  assert.ok(!matchesDesignation(held, d, ALL));
});

test("picking a designation drafts exactly what it holds, always-open screens included", () => {
  const draft = draftFor(TESTER, ALL);
  assert.deepEqual(draft.modules.sort(), ["erp.dashboard", "erp.expenses", "erp.settings", "erp.testing", "erp.videos"]);
  assert.equal(draft.level, "associate");
  assert.deepEqual(draftFor({ level: "admin", allScreens: true, modules: [], powers: ["viewCost"] }, ALL), { level: "admin", modules: [...ALL], powers: [] });
  /* What the dialog writes is what then matches. */
  const held = heldShape({ level: draft.level, moduleRows: draft.modules, powers: draft.powers }, ALL);
  assert.ok(matchesDesignation(held, designationShape(TESTER, ALL), ALL));
});

test("every screen and power the seed migration names is real", () => {
  const sql = readFileSync(new URL("../../../drizzle/0218_erp_designations.sql", import.meta.url), "utf8");
  const modules = [...sql.matchAll(/\('erpd_\w+', '(erp\.\w+)'\)/g)].map((m) => m[1]);
  const powers = [...sql.matchAll(/\('erpd_\w+', '(\w+)'\)/g)].map((m) => m[1]).filter((p) => !p.startsWith("erp"));
  assert.ok(modules.length > 30 && powers.length > 10, "the seed was read");
  assert.deepEqual(modules.filter((k) => !ALL.includes(k)), [], "screens the ERP does not have");
  assert.deepEqual(modules.filter((k) => k === "erp.dashboard" || k === "erp.settings"), [], "always-open screens are never stored");
  assert.deepEqual(powers.filter((p) => !(ERP_POWERS as readonly string[]).includes(p)), [], "powers the ERP does not have");
});
