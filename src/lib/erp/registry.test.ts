import test from "node:test";
import assert from "node:assert/strict";
import { ERP_GROUPS, ERP_SCREENS, ERP_ALWAYS_OPEN, erpHref } from "./registry";
import { APP_MODULES, moduleForPath, modulesForApp } from "../modules";
import { ERP_POWERS, ERP_POWER_LABEL } from "./powers";

/* The ERP's screens are its modules, read off one registry. These pin that the
   access screen, the guard and the sidebar cannot disagree. */

test("every built ERP screen is exactly one module, and no unbuilt screen is", () => {
  const erp = modulesForApp("erp");
  const built = ERP_SCREENS.filter((s) => s.built);
  assert.deepEqual(erp.map((m) => m.key).sort(), built.map((s) => `erp.${s.key}`).sort());
  const keys = APP_MODULES.map((m) => m.key);
  assert.equal(new Set(keys).size, keys.length, "module keys are join keys and must be unique");
});

test("screen keys and slugs are unique, and the always-open screens are built", () => {
  const keys = ERP_SCREENS.map((s) => s.key);
  const slugs = ERP_SCREENS.map((s) => s.slug);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const k of ERP_ALWAYS_OPEN) assert.ok(ERP_SCREENS.find((s) => s.key === k)?.built, `${k} must be built`);
});

test("the dashboard is the app root and does not swallow the other screens", () => {
  assert.equal(moduleForPath("/erp")?.key, "erp.dashboard");
  assert.equal(moduleForPath("/erp/customers")?.key, "erp.customers");
  for (const g of ERP_GROUPS) for (const s of g.screens.filter((x) => x.built)) assert.equal(moduleForPath(erpHref(s))?.key, `erp.${s.key}`);
});

test("every power has a label and a sentence saying where it came from", () => {
  for (const p of ERP_POWERS) assert.ok(ERP_POWER_LABEL[p].label && ERP_POWER_LABEL[p].source);
});
