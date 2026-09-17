import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { APP_MODULES, modulesForApp } from "./modules";
import {
  LEAD_SECTIONS,
  LEAD_WORKSPACES,
  leadHref,
  leadModuleKey,
  sectionForPath,
  type LeadWorkspace,
} from "./lead-workspace";

/* ---------------------------------------------------------------------------
 * The Lead Management workspace has TWO lists of where you can go, and they
 * are joined only by a string.
 *
 * AND IT IS MOUNTED TWICE, so every assertion below runs for every workspace.
 * The Manager Console built the funnel and the CRM draws the same screens for
 * telecallers; a section that resolves in one app and not the other is a row
 * that is there for half the company, which is the failure this whole file
 * exists to make loud.
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
  it("every section names a real module in every workspace", () => {
    for (const workspace of LEAD_WORKSPACES) {
      for (const section of LEAD_SECTIONS) {
        const key = leadModuleKey(workspace, section);
        const found = APP_MODULES.find((m) => m.key === key);
        assert.ok(
          found,
          `${section.label} points at "${key}", which is not a module. ` +
            `Its route would be drawn in the sidebar and guarded by nothing.`,
        );
        assert.equal(
          found?.app,
          workspace,
          `${key} belongs to ${found?.app}, not ${workspace}.`,
        );
      }
    }
  });

  it("every lead module is drawn exactly once, in every workspace", () => {
    // The funnel's own keys, plus the two that predate this workspace and were
    // moved into it: `leads` and `samples` keep their slugs because a key is a
    // join, and renaming one silently revokes it from everybody.
    for (const workspace of LEAD_WORKSPACES) {
      const leadModules = modulesForApp(workspace).filter(
        (m) => m.group === "Lead Management",
      );

      for (const m of leadModules) {
        const drawn = LEAD_SECTIONS.filter(
          (s) => leadModuleKey(workspace, s) === m.key,
        );
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
        `A section exists with no module in ${workspace}'s Lead Management group.`,
      );
    }
  });

  /**
   * THE TWO MOUNTS CARRY THE SAME SCREENS, which is the whole reason the
   * workspace is one list rather than two.
   *
   * A module present in one app and absent from the other is a feature half
   * the company has, and nothing on either screen would say so — the sidebar
   * filters itself through the grants, so a missing module looks exactly like
   * one somebody was not given. That is this codebase's oldest navigation bug
   * and it is worth one assertion.
   */
  it("both workspaces carry the same Lead Management modules", () => {
    const slugsFor = (workspace: LeadWorkspace) =>
      modulesForApp(workspace)
        .filter((m) => m.group === "Lead Management")
        .map((m) => m.key.slice(workspace.length + 1))
        .sort();
    assert.deepEqual(slugsFor("crm"), slugsFor("sales"));
  });

  it("stays at ten, because the sidebar is the constraint", () => {
    /*
     * Not a style rule. Ten is already more than the longest group beside it
     * in either app, and this one is now drawn in two sidebars rather than
     * one — so an eleventh row is spent twice. The rest of the workspace's
     * surface is TABS, which cannot be granted separately and therefore cost
     * nothing here. An eleventh row is a decision about two apps' navigation,
     * not a detail of this feature, so it fails the build rather than quietly
     * appearing.
     */
    assert.ok(
      LEAD_SECTIONS.length <= 10,
      `Lead Management has ${LEAD_SECTIONS.length} sidebar rows. Ten is the cap — ` +
        `add a tab to an existing section instead, or make the case for widening it.`,
    );
  });

  it("a section's own path is its first tab, so the sidebar never redirects", () => {
    for (const section of LEAD_SECTIONS) {
      assert.equal(
        section.path,
        section.tabs[0]?.path,
        `${section.label} points somewhere other than its first tab. A landing ` +
          `page that redirected would put a redirect in front of every sidebar ` +
          `click, and the back button would never leave it.`,
      );
    }
  });

  it("the module's href and the section's route are the same, in both apps", () => {
    for (const workspace of LEAD_WORKSPACES) {
      for (const section of LEAD_SECTIONS) {
        const key = leadModuleKey(workspace, section);
        const m = APP_MODULES.find((x) => x.key === key);
        const drawn = leadHref(workspace, section.path);
        assert.equal(
          m?.href,
          drawn,
          `${key} is guarded at ${m?.href} and drawn at ${drawn}. ` +
            `The guard matches a path, so two answers means an unguarded screen.`,
        );
      }
    }
  });

  it("no two tabs share a route", () => {
    const seen = new Map<string, string>();
    for (const section of LEAD_SECTIONS) {
      for (const tab of section.tabs) {
        const previous = seen.get(tab.path);
        assert.equal(
          previous,
          undefined,
          `${tab.path} is both "${previous}" and "${section.label} › ${tab.label}". ` +
            "One route cannot belong to two sections — the tab strip would draw " +
            "whichever sectionForPath happened to resolve.",
        );
        seen.set(tab.path, `${section.label} › ${tab.label}`);
      }
    }
  });

  it("only the module's own root is exact", () => {
    for (const section of LEAD_SECTIONS) {
      for (const tab of section.tabs) {
        if (!tab.exact) continue;
        assert.equal(
          tab.path,
          section.path,
          `${tab.path} is marked exact but is not its section's root. Exact is ` +
            `for the route that would otherwise match every child of itself.`,
        );
      }
    }
  });
});

describe("which section a path is inside", () => {
  it("resolves a child to the deepest section, not the shortest prefix", () => {
    // `<app>/leads` is a prefix of nearly every route in this workspace, so a
    // first-match resolution would answer "All Leads" for all of them.
    for (const w of LEAD_WORKSPACES) {
      assert.equal(sectionForPath(w, leadHref(w, "leads/funnel/sources"))?.slug, "lead-funnel");
      assert.equal(sectionForPath(w, leadHref(w, "leads/qualify/verification"))?.slug, "lead-qualify");
      assert.equal(sectionForPath(w, leadHref(w, "leads/actions/none"))?.slug, "lead-actions");
      assert.equal(sectionForPath(w, leadHref(w, "leads"))?.slug, "leads");
      assert.equal(sectionForPath(w, leadHref(w, "samples/desk"))?.slug, "samples");
    }
  });

  it("answers nothing for a route outside the workspace", () => {
    assert.equal(sectionForPath("sales", "/sales/visits"), undefined);
    assert.equal(sectionForPath("crm", "/crm/dashboard"), undefined);
  });

  /**
   * THE WORKSPACE IS ASKED FOR RATHER THAN SNIFFED, and this is why.
   *
   * Both apps mount the same relative paths, so `/crm/leads` and `/sales/leads`
   * differ only in the segment this function is told. Resolving from the path
   * alone would answer "All Leads" for the other app's route too — and the tab
   * strip would then draw a set of links leading out of the app somebody is in.
   */
  it("does not resolve the other app's routes", () => {
    assert.equal(sectionForPath("crm", "/sales/leads/funnel"), undefined);
    assert.equal(sectionForPath("sales", "/crm/leads/funnel"), undefined);
  });

  it("a lead record is inside All Leads", () => {
    // It has no tab of its own — the strip takes an explicit section there, or
    // draws nothing — but it must still resolve, because the sidebar highlights
    // from the same answer.
    for (const w of LEAD_WORKSPACES) {
      assert.equal(sectionForPath(w, leadHref(w, "leads/LD-2231"))?.slug, "leads");
    }
  });
});

describe("the workspace's own folder guards nothing", () => {
  /**
   * NINE MODULES LIVE UNDER `leads/`, so the folder above them may not demand
   * one.
   *
   * A `requireModule(user.id, "<app>.leads")` in that layout refuses somebody
   * holding Qualification on the strength of a module they were deliberately
   * not given — a grant they hold, refused by the folder above it. The Manager
   * Console's layout records that decision in prose, and the CRM's copy was
   * generated with a guard in it precisely BECAUSE the console's prose quotes
   * the call it no longer makes.
   *
   * Read as text, like `mbos-wire.test.ts` and the timezone greps beside it:
   * the failure is a redirect somebody only sees if they happen to hold a
   * narrowed grant, which is nobody during development and several people on
   * the day access is tightened.
   */
  for (const app of LEAD_WORKSPACES) {
    it(`${app}/leads/layout.tsx requires no module`, () => {
      const src = readFileSync(`src/app/${app}/leads/layout.tsx`, "utf8");
      const calls = src.match(/^\s*await requireModule\(/gm) ?? [];
      assert.deepEqual(
        calls,
        [],
        `src/app/${app}/leads/layout.tsx guards a module. Nine separately ` +
          `grantable modules sit under it, so the guard belongs in each ` +
          `module's own folder.`,
      );
    });
  }
});
