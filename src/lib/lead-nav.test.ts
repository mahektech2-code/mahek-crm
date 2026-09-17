import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { APP_MODULES, modulesForApp } from "./modules";
import { LEAD_SECTIONS, sectionForPath } from "@/app/sales/leads/lead-nav";

/* ---------------------------------------------------------------------------
 * The Lead Management workspace has TWO lists of where you can go, and they
 * are joined only by a string.
 *
 * `APP_MODULES` says what can be GRANTED. `LEAD_SECTIONS` says what is DRAWN.
 * Nothing in TypeScript connects them: a section naming a module that does not
 * exist compiles, and a module nobody drew compiles too. Both failures are
 * invisible at runtime in the direction that matters — the first is a screen
 * nobody can be refused, because `requireModule` throws on an unknown key only
 * when somebody actually opens it; the second is a screen nobody can find,
 * which reads as a feature that was never built rather than as a nav item that
 * was forgotten.
 *
 * So the join is asserted here, the same way `mbos-wire.test.ts` pins the
 * server's payload against the handset's schema: two lists in two files,
 * joined by a spelling, and getting it wrong fails silently.
 * ------------------------------------------------------------------------- */

describe("the Lead Management nav and the module registry agree", () => {
  it("every section names a real module", () => {
    for (const section of LEAD_SECTIONS) {
      const found = APP_MODULES.find((m) => m.key === section.key);
      assert.ok(
        found,
        `${section.label} points at "${section.key}", which is not a module. ` +
          `Its route would be drawn in the sidebar and guarded by nothing.`,
      );
      assert.equal(
        found?.app,
        "sales",
        `${section.key} belongs to ${found?.app}, not the Sales Dashboard.`,
      );
    }
  });

  it("every lead module is drawn exactly once", () => {
    // The funnel's own keys, plus the two that predate this workspace and were
    // moved into it: `sales.leads` and `sales.samples` keep their keys because
    // a key is a join, and renaming one silently revokes it from everybody.
    const leadModules = modulesForApp("sales").filter(
      (m) => m.group === "Lead Management",
    );

    for (const m of leadModules) {
      const drawn = LEAD_SECTIONS.filter((s) => s.key === m.key);
      assert.equal(
        drawn.length,
        1,
        `${m.key} ("${m.label}") is drawn ${drawn.length} times. ` +
          `Zero means a grantable screen nobody can reach; two means two ` +
          `sidebar rows fighting over one grant.`,
      );
    }

    assert.equal(
      LEAD_SECTIONS.length,
      leadModules.length,
      "A section exists with no module in the Lead Management group.",
    );
  });

  it("stays at ten, because the sidebar is the constraint", () => {
    /*
     * Not a style rule. The Sales sidebar already carries twenty-four
     * destinations in six groups; Lead Management is the only collapsible one
     * precisely because ten is already more than the longest group beside it.
     * The rest of the workspace's surface is TABS, which cannot be granted
     * separately and therefore cost nothing here. A eleventh row is a decision
     * about the whole app's navigation, not a detail of this feature, so it
     * fails the build rather than quietly appearing.
     */
    assert.ok(
      LEAD_SECTIONS.length <= 10,
      `Lead Management has ${LEAD_SECTIONS.length} sidebar rows. Ten is the cap — ` +
        `add a tab to an existing section instead, or make the case for widening it.`,
    );
  });

  it("a section's own href is its first tab, so the sidebar never redirects", () => {
    for (const section of LEAD_SECTIONS) {
      assert.equal(
        section.href,
        section.tabs[0]?.href,
        `${section.label} points somewhere other than its first tab. A landing ` +
          `page that redirected would put a redirect in front of every sidebar ` +
          `click, and the back button would never leave it.`,
      );
    }
  });

  it("the module's href and the section's href are the same route", () => {
    for (const section of LEAD_SECTIONS) {
      const m = APP_MODULES.find((x) => x.key === section.key);
      assert.equal(
        m?.href,
        section.href,
        `${section.key} is guarded at ${m?.href} and drawn at ${section.href}. ` +
          `The guard matches a path, so two answers means an unguarded screen.`,
      );
    }
  });

  it("no two tabs share a route", () => {
    const seen = new Map<string, string>();
    for (const section of LEAD_SECTIONS) {
      for (const tab of section.tabs) {
        const previous = seen.get(tab.href);
        assert.equal(
          previous,
          undefined,
          `${tab.href} is both "${previous}" and "${section.label} › ${tab.label}". ` +
            "One route cannot belong to two sections — the tab strip would draw " +
            "whichever sectionForPath happened to resolve.",
        );
        seen.set(tab.href, `${section.label} › ${tab.label}`);
      }
    }
  });

  it("only the module's own root is exact", () => {
    for (const section of LEAD_SECTIONS) {
      for (const tab of section.tabs) {
        if (!tab.exact) continue;
        assert.equal(
          tab.href,
          section.href,
          `${tab.href} is marked exact but is not its section's root. Exact is ` +
            `for the route that would otherwise match every child of itself.`,
        );
      }
    }
  });
});

describe("which section a path is inside", () => {
  it("resolves a child to the deepest section, not the shortest prefix", () => {
    // `/sales/leads` is a prefix of nearly every route in this workspace, so a
    // first-match resolution would answer "All Leads" for all of them.
    assert.equal(sectionForPath("/sales/leads/funnel/sources")?.key, "sales.lead-funnel");
    assert.equal(sectionForPath("/sales/leads/qualify/verification")?.key, "sales.lead-qualify");
    assert.equal(sectionForPath("/sales/leads/actions/none")?.key, "sales.lead-actions");
    assert.equal(sectionForPath("/sales/leads")?.key, "sales.leads");
    assert.equal(sectionForPath("/sales/samples/desk")?.key, "sales.samples");
  });

  it("answers nothing for a route outside the workspace", () => {
    assert.equal(sectionForPath("/sales/visits"), undefined);
    assert.equal(sectionForPath("/crm/dashboard"), undefined);
  });

  it("a lead record is inside All Leads", () => {
    // It has no tab of its own — the strip takes an explicit section there, or
    // draws nothing — but it must still resolve, because the sidebar highlights
    // from the same answer.
    assert.equal(sectionForPath("/sales/leads/LD-2231")?.key, "sales.leads");
  });
});
