import test from "node:test";
import assert from "node:assert/strict";
import { APPS } from "../apps";
import { SETTINGS } from "./registry";
import { PAGE_TABS, RETIRED_SETTINGS, placeSetting } from "./settings-placement";
import { SETTINGS_PAGES } from "./settings-pages";
import { schemaForPage, settingAddress } from "./settings-schemas";
import { schemaFields } from "./schema-contract";

/* ---------------------------------------------------------------------------
 * EVERY SETTING HAS ONE PAGE, AND IT IS A REAL ONE.
 *
 * 254 settings once sat on a CRM tab called "Other" in a group called "Not yet
 * placed", because a setting with no presentation entry fell there silently.
 * These hold the opposite: a setting added to the registry that no rule places
 * fails here, before it ships to a console where nobody can find it.
 * ------------------------------------------------------------------------- */

test("every setting in the registry is on exactly one settings page", () => {
  const live = SETTINGS.filter((s) => !RETIRED_SETTINGS.has(s.key));
  const nowhere = live.filter((s) => !settingAddress(s.key)).map((s) => s.key);
  assert.deepEqual(nowhere, [], "these settings are on no page, so nobody can change them from the console");

  const seen = new Map<string, string>();
  for (const p of SETTINGS_PAGES) {
    for (const f of schemaFields(schemaForPage(p.id)!)) {
      if (f.control === "entity") continue;
      assert.ok(!seen.has(f.key), `${f.key} is on both ${seen.get(f.key)} and ${p.id}`);
      seen.set(f.key, p.id);
    }
  }
  assert.equal(seen.size, live.length);
});

test("nothing is placed on a page or tab that is not declared", () => {
  for (const s of SETTINGS) {
    if (s.key.startsWith("hrms.") || RETIRED_SETTINGS.has(s.key)) continue;
    const at = placeSetting(s.key);
    assert.ok(at, s.key);
    assert.ok(SETTINGS_PAGES.some((p) => p.id === at.page), `${s.key} names page ${at.page}`);
    assert.ok(PAGE_TABS[at.page]?.some((t) => t.slug === at.tab), `${s.key} names tab ${at.page}/${at.tab}`);
  }
});

test("no group is called 'Not yet placed' or 'Other'", () => {
  for (const p of SETTINGS_PAGES) {
    for (const t of schemaForPage(p.id)!.tabs) {
      for (const g of t.groups) {
        assert.ok(!/not yet placed|^other$/i.test(g.label), `${p.id}/${t.key} has a group called "${g.label}"`);
      }
    }
  }
});

test("every page has settings, and every declared tab is drawn", () => {
  for (const p of SETTINGS_PAGES) {
    const schema = schemaForPage(p.id)!;
    assert.ok(schema.tabs.length > 0, `${p.id} has no settings — an app with nothing to configure gets no page`);
    if (PAGE_TABS[p.id]) {
      assert.deepEqual(
        schema.tabs.map((t) => t.key),
        PAGE_TABS[p.id].map((t) => t.slug),
        `${p.id} declares a tab nothing is placed on`,
      );
    }
  }
});

test("a page's owners are real apps", () => {
  const ids = new Set(APPS.map((a) => a.id));
  for (const p of SETTINGS_PAGES) {
    for (const o of p.owners) assert.ok(ids.has(o), `${p.id} names ${o}`);
  }
});
