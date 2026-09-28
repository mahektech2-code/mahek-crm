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

test("a tab is never a module, and every link to one lands on its screen's tab", async () => {
  const { erpLink, erpPlace, erpKeysOf } = await import("./registry");
  const modules = new Set(modulesForApp("erp").map((m) => m.key));
  const tabKeys = new Set<string>();
  for (const sc of ERP_SCREENS) {
    for (const k of erpKeysOf(sc).filter((k) => k !== sc.key)) {
      assert.ok(!modules.has(`erp.${k}`), `${k} is a tab and must not be grantable on its own`);
      assert.ok(!tabKeys.has(k), `${k} is a tab of two screens`);
      tabKeys.add(k);
      assert.equal(erpPlace(k)?.screen.key, sc.key);
    }
  }
  assert.equal(erpLink("pendingLr"), "/erp/transport");
  assert.equal(erpLink("trackLr", { f: "a,b", fl: "In Transit" }), "/erp/transport?view=trackLr&f=a%2Cb&fl=In+Transit");
  assert.equal(erpLink("transport"), "/erp/transport?view=transport");
  assert.equal(erpLink("rmLog"), "/erp/stock?view=rmLog");
  assert.equal(erpLink("stock"), "/erp/stock");
  assert.equal(erpLink("reorderRm"), "/erp/rm-levels");
  assert.equal(erpLink("customers", { open: "c1" }), "/erp/customers?open=c1");
  assert.equal(erpLink("gone"), "/erp");
});
