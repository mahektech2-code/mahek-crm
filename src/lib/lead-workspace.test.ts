import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
import { pipelineLinks } from "./sales-lead-pipeline/workspace";

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

/**
 * LEAD MODULES THAT ARE NOT A SECTION OF THE SHARED WORKSPACE.
 *
 * `LEAD_SECTIONS` is the list both apps mount, one sidebar row each, so every
 * assertion below reads "every module is a section, in both workspaces". The
 * calling desk is the exception and is named here rather than quietly passing:
 * it is the CRM's alone (the Sales Dashboard's people walk a beat), it is drawn
 * from the CRM's own sidebar in `components/shell/nav.ts`, and it is a module
 * of its own so that it can be GRANTED to particular people — a tab of All
 * Leads could not be, and the desk was open to every CRM user. The last test in
 * this file pins the exception itself, so it cannot grow unnoticed.
 *
 * Sales Manager is the mirror exception on the OTHER side: `sales.lead-pipeline`
 * is the Sales Dashboard's alone (the CRM's people work the phones, not the
 * funnel from a manager's chair), drawn from `app/sales/nav.ts`, and — like
 * the desk — a module of its own so it can be granted or withheld from
 * particular people rather than riding on the whole app.
 *
 * `crm.sales-manager` is a THIRD exception, and a different shape from either:
 * it names the same job title as the Sales Dashboard's seat but is its own
 * module, its own route and its own grant, in the CRM. Nothing reads it
 * against `sales.lead-pipeline` and nothing should — a person can hold one,
 * both, or neither.
 *
 * `crm.lead-lost` is a FOURTH exception, and the same shape as the calling
 * desk: a lead can be lost from any rung of any ladder, so it is a question
 * asked of the whole book rather than a cut of one stage's worklist, and a tab
 * of All Leads could not be withheld from anybody who can open that screen.
 * There is no Sales Dashboard counterpart yet — the field funnel is walked
 * through MBOS, and a lost lead there is read off the same rows.
 */
const CRM_ONLY_LEAD_MODULES = ["lead-calling-desk", "sales-manager", "lead-lost"];
const SALES_ONLY_LEAD_MODULES = ["lead-pipeline"];
const isSharedLeadModule = (workspace: string, key: string) => {
  const slug = key.slice(workspace.length + 1);
  if (workspace === "crm") return !CRM_ONLY_LEAD_MODULES.includes(slug);
  if (workspace === "sales") return !SALES_ONLY_LEAD_MODULES.includes(slug);
  return true;
};

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
        (m) => m.group === "Lead Management" && isSharedLeadModule(workspace, m.key),
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
        .filter((m) => m.group === "Lead Management" && isSharedLeadModule(workspace, m.key))
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

  it("the CRM-only exceptions are exactly the calling desk, Sales Manager and Lost: their own modules, off by default, drawn in the CRM sidebar", () => {
    assert.deepEqual(CRM_ONLY_LEAD_MODULES, ["lead-calling-desk", "sales-manager", "lead-lost"]);
    for (const slug of CRM_ONLY_LEAD_MODULES) {
      const mod = APP_MODULES.find((m) => m.key === `crm.${slug}`);
      assert.ok(mod, `crm.${slug} is not a module`);
      assert.equal(mod?.group, "Lead Management");
      assert.equal(
        mod?.offByDefault,
        true,
        `crm.${slug} is not offByDefault, so a grant of the whole CRM would carry it — which is every CRM user.`,
      );
      assert.equal(
        APP_MODULES.find((m) => m.key === `sales.${slug}`),
        undefined,
        `sales.${slug} exists: the exception is the CRM's alone.`,
      );
      assert.ok(
        !LEAD_SECTIONS.some((s) => s.slug === slug),
        `${slug} is a section as well as an exception — pick one.`,
      );
    }
  });

  it("crm.sales-manager and sales.lead-pipeline are two independent modules sharing a job title, not one permission", () => {
    const crmSeat = APP_MODULES.find((m) => m.key === "crm.sales-manager");
    const salesSeat = APP_MODULES.find((m) => m.key === "sales.lead-pipeline");
    assert.ok(crmSeat && salesSeat, "both Sales Manager modules must exist");
    assert.equal(crmSeat?.label, "Sales Manager");
    assert.equal(salesSeat?.label, "Sales Manager");
    assert.notEqual(crmSeat?.key, salesSeat?.key);
    assert.notEqual(crmSeat?.href, salesSeat?.href);
    assert.equal(crmSeat?.app, "crm");
    assert.equal(salesSeat?.app, "sales");
  });

  it("the Sales-only exception is exactly the Sales Manager workspace: its own module, off by default, explicit-only", () => {
    assert.deepEqual(SALES_ONLY_LEAD_MODULES, ["lead-pipeline"]);
    for (const slug of SALES_ONLY_LEAD_MODULES) {
      const mod = APP_MODULES.find((m) => m.key === `sales.${slug}`);
      assert.ok(mod, `sales.${slug} is not a module`);
      assert.equal(mod?.group, "Lead Management");
      assert.equal(
        mod?.offByDefault,
        true,
        `sales.${slug} is not offByDefault, so a grant of the whole Sales Dashboard would carry it.`,
      );
      assert.equal(
        mod?.explicitOnly,
        true,
        `sales.${slug} is not explicitOnly, so an administrator or a whole-app grant would carry it regardless.`,
      );
      assert.equal(
        APP_MODULES.find((m) => m.key === `crm.${slug}`),
        undefined,
        `crm.${slug} exists: the exception is the Sales Dashboard's alone.`,
      );
      assert.ok(
        !LEAD_SECTIONS.some((s) => s.slug === slug),
        `${slug} is a section as well as an exception — pick one.`,
      );
    }
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

/* ---------------------------------------------------------------------------
 * The Sales Manager screens are mounted twice as well — on the Sales Dashboard
 * at /sales-lead-pipeline and in the CRM at /crm/leads/sales-manager — and the
 * only thing that differs is where a link leads.
 * ------------------------------------------------------------------------- */
describe("the Sales Manager screens are workspace-aware", () => {
  it("defaults to the Sales Dashboard, exactly the routes they had before the CRM mounted them", () => {
    const sales = pipelineLinks();
    assert.equal(sales.base, "/sales-lead-pipeline");
    assert.equal(sales.intake, "/sales/leads/intake");
    assert.equal(sales.qualify, "/sales/leads/qualify");
    assert.equal(sales.record("cus_1"), "/sales/leads/cus_1");
    assert.equal(pipelineLinks("sales").base, sales.base, "naming the default is the same as omitting it");
    assert.equal(pipelineLinks("sales").record("x"), sales.record("x"));
  });

  it("the CRM sends a manager to the CRM's own intake, qualification and record", () => {
    const crm = pipelineLinks("crm");
    assert.equal(crm.base, "/crm/leads/sales-manager");
    assert.equal(crm.intake, "/crm/leads/intake");
    assert.equal(crm.qualify, "/crm/leads/qualify");
    assert.equal(crm.record("cus_1"), "/crm/leads/cus_1");
  });

  it("every route either workspace links to exists", () => {
    for (const ws of ["sales", "crm"] as const) {
      const l = pipelineLinks(ws);
      const dir = (route: string) => "src/app" + route.replace("cus_1", "[id]");
      for (const route of [l.intake, l.qualify, l.record("cus_1")]) {
        assert.ok(existsSync(dir(route) + "/page.tsx"), `${ws}: ${route} has no page`);
      }
      for (const sub of ["", "/pipeline", "/list", "/[id]"]) {
        assert.ok(existsSync(`src/app${l.base}${sub}/page.tsx`), `${ws}: ${l.base}${sub} has no page`);
      }
    }
  });

  it("the CRM workspace has the states a screen owes: loading, failure and not found", () => {
    for (const file of ["loading.tsx", "error.tsx", "not-found.tsx", "layout.tsx"]) {
      assert.ok(existsSync(`src/app/crm/leads/sales-manager/${file}`), `missing ${file}`);
    }
  });

  it("no shared component spells a workspace's route — they ask pipelineLinks", () => {
    const dir = "src/components/sales-lead-pipeline";
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
      const code = readFileSync(`${dir}/${file}`, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      assert.equal(/["'`]\/sales-lead-pipeline|["'`]\/sales\/leads/.test(code), false, `${file} hard-codes a Sales route`);
      assert.equal(/["'`]\/crm\/leads/.test(code), false, `${file} hard-codes a CRM route`);
    }
  });

  it("the CRM pages draw the Sales Manager desk, and the record is handed the CRM workspace", () => {
    const at = (page: string) => readFileSync(`src/app/crm/leads/sales-manager/${page}`, "utf8");
    assert.match(at("page.tsx"), /pipelineDesk/);
    assert.match(at("page.tsx"), /<Dashboard/);
    assert.match(at("[id]/page.tsx"), /SalesManagerRecordScreen/);
    assert.match(at("[id]/page.tsx"), /workspace="crm"/, "the record must be handed the CRM workspace");
    /* The old separate views are redirects into the desk, never a second screen. */
    for (const view of ["list", "mine", "today", "overdue", "distributors", "pipeline"]) {
      assert.match(at(`${view}/page.tsx`), /redirect\("\/crm\/leads\/sales-manager/,`${view} must redirect into the desk`);
    }
  });

  it("the Sales Dashboard's pages still draw the shared screens, untouched", () => {
    for (const page of ["page.tsx", "pipeline/page.tsx", "list/page.tsx"]) {
      const src = readFileSync(`src/app/sales-lead-pipeline/${page}`, "utf8");
      assert.doesNotMatch(src, /Proto/, `${page} must not draw the CRM prototype`);
    }
  });

  it("the workspace draws NO bar of its own: the CRM's header and sidebar are the only chrome", () => {
    const crmLayout = readFileSync("src/app/crm/layout.tsx", "utf8");
    assert.match(crmLayout, /<AppShell/, "the CRM shell frames this route like every other");
    assert.doesNotMatch(crmLayout, /ownFrame|inCrmSalesManagerWorkspace/, "no workspace branch around the CRM shell");

    /* The module layout is a guard and nothing else. */
    const layout = readFileSync("src/app/crm/leads/sales-manager/layout.tsx", "utf8");
    assert.match(layout, /requireModule\(user\.id, "crm\.sales-manager"\)/);
    assert.doesNotMatch(layout, /Shell|NotificationBell|AccountMenu|<aside/);
    assert.equal(existsSync("src/components/sales-lead-pipeline/desk/shell.tsx"), false, "the duplicate bar is gone");
    /* Nothing under this route draws a shell of its own. */
    for (const page of ["page.tsx", "pipeline/page.tsx", "[id]/page.tsx"]) {
      assert.doesNotMatch(readFileSync(`src/app/crm/leads/sales-manager/${page}`, "utf8"), /SalesManagerShell|AppShell|<Header/, page);
    }
  });

  it("every old view address still has a page, so no link the shared dialogs draw is dead", () => {
    for (const view of ["pipeline", "list", "today", "overdue", "mine", "distributors"]) {
      assert.ok(existsSync(`src/app/crm/leads/sales-manager/${view}/page.tsx`), `${view} has no page`);
    }
  });
});
