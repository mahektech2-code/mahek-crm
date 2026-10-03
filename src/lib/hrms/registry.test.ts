import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HRMS_ALWAYS_OPEN, HRMS_RETIRED_SLUGS, HRMS_SCREENS, HRMS_TABS, hrmsLink, hrmsPlace } from "./registry";
import { modulesForApp, moduleForPath } from "../modules";

/* The HRMS's screens are its modules and its old screens are tabs. These pin
   that the sidebar, the guard, the Access screen and the migration that moved
   the grants cannot disagree. */

test("every screen is exactly one module, and no tab is a module", () => {
  const hrms = modulesForApp("hrms").map((m) => m.key).sort();
  assert.deepEqual(hrms, HRMS_SCREENS.map((s) => `hrms.${s.key}`).sort());
});

test("keys, slugs and tab keys are unique, and a tab is on one screen only", () => {
  const keys = HRMS_TABS.map((x) => x.tab.key);
  assert.equal(new Set(keys).size, keys.length);
  const slugs = HRMS_SCREENS.map((s) => s.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const k of HRMS_ALWAYS_OPEN) assert.ok(HRMS_SCREENS.some((s) => s.key === k));
  /* A screen with tabs opens on the tab that carries its own key, so a grant
     and the first thing it shows are the same thing. */
  for (const s of HRMS_SCREENS) if (s.views) assert.equal(s.views[0].key, s.key, `${s.key} must open on its own tab`);
});

test("a link to a tab lands on its screen with the tab named, and a first tab needs no name", () => {
  assert.equal(hrmsLink("approvals"), "/hrms/leave?view=approvals");
  assert.equal(hrmsLink("leave"), "/hrms/leave");
  assert.equal(hrmsLink("payroll", { open: "x" }), "/hrms/pay?open=x");
  assert.equal(hrmsLink("home"), "/hrms");
  assert.equal(hrmsLink("nothing"), "/hrms");
  assert.equal(hrmsPlace("refLists")?.screen.key, "settings");
});

test("every screen's URL belongs to its own module, and check-in does not swallow them", () => {
  assert.equal(moduleForPath("/hrms")?.key, "hrms.home");
  for (const s of HRMS_SCREENS.filter((x) => x.slug)) assert.equal(moduleForPath(`/hrms/${s.slug}`)?.key, `hrms.${s.key}`);
});

test("every retired URL names a list that exists, and no retired URL is a live screen's", () => {
  const live = new Set(HRMS_SCREENS.map((s) => s.slug));
  for (const [slug, key] of Object.entries(HRMS_RETIRED_SLUGS)) {
    assert.ok(hrmsPlace(key), `${slug} redirects to ${key}, which is not a list`);
    assert.ok(!live.has(slug), `${slug} is retired and live`);
  }
});

test("the grant migration moves every tab that used to be a screen onto the screen it is a tab of", () => {
  const sql = readFileSync("drizzle/0201_hrms_screens_merged.sql", "utf8");
  const pairs = new Map([...sql.matchAll(/\('hrms\.(\w+)', 'hrms\.(\w+)'\)/g)].map((m) => [m[1], m[2]]));
  const tabs = HRMS_TABS.filter((x) => x.tab.key !== x.screen.key);
  assert.deepEqual([...pairs.keys()].sort(), tabs.map((x) => x.tab.key).sort());
  for (const x of tabs) assert.equal(pairs.get(x.tab.key), x.screen.key, `${x.tab.key} must move to ${x.screen.key}`);
});
