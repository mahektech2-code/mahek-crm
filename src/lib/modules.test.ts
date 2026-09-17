import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  APP_MODULES,
  moduleAllowed,
  moduleForPath,
  moduleGroupsForApp,
  modulesForApp,
} from "./modules";
import { grantableApps } from "./modules";
import { NAV, PINNED, navHrefs as crmNavHrefs } from "@/components/shell/nav";
import { NOT_IN_SIDEBAR, SALES_NAV, SALES_PINNED, navHrefs } from "@/app/sales/nav";

/* ---------------------------------------------------------------------------
 * The module registry, which is what an access grant points at.
 *
 * Pure, so it is tested without a database — the same reason the engines are.
 * ------------------------------------------------------------------------- */

describe("what a module grant means", () => {
  it("no rows for an app means the whole app", () => {
    // The rule the whole migration rests on. Every grant that existed before
    // this table did carries no module rows, and has to keep opening
    // everything it opened yesterday.
    for (const m of modulesForApp("crm")) {
      assert.equal(moduleAllowed(m.key, [], "crm"), true);
    }
  });

  it("one row narrows the app to exactly that row", () => {
    assert.equal(moduleAllowed("crm.call-log", ["crm.call-log"], "crm"), true);
    assert.equal(moduleAllowed("crm.targets", ["crm.call-log"], "crm"), false);
  });

  it("another app's rows do not narrow this one", () => {
    // Somebody narrowed inside Accounts and untouched in the CRM still opens
    // the whole CRM. Reading the grant list without filtering by app would
    // have shut them out of their own calling queue.
    const granted = ["accounts.approvals"];
    assert.equal(moduleAllowed("crm.call-log", granted, "crm"), true);
    assert.equal(moduleAllowed("accounts.bills", granted, "accounts"), false);
  });
});

describe("resolving a path to a module", () => {
  it("a child route belongs to its module", () => {
    assert.equal(moduleForPath("/crm/customers/cus_123")?.key, "crm.customers");
    assert.equal(moduleForPath("/crm/customers/import")?.key, "crm.customers");
  });

  it("the Accounts root is Today, not the whole app", () => {
    // `/accounts` is a prefix of every other Accounts route. Without `exact`
    // it would swallow all of them and one module would guard the app.
    assert.equal(moduleForPath("/accounts")?.key, "accounts.today");
    assert.equal(moduleForPath("/accounts/bills")?.key, "accounts.bills");
    assert.equal(moduleForPath("/accounts/approvals")?.key, "accounts.approvals");
  });

  it("an unregistered path resolves to nothing rather than to something near it", () => {
    assert.equal(moduleForPath("/login"), undefined);
  });
});

describe("the registry and the navigation agree", () => {
  it("every CRM sidebar link is a module that can be withheld", () => {
    // A link with no module behind it is a screen nobody can be stopped from
    // opening, and it would silently disappear from the sidebar, since the
    // sidebar filters itself through this list.
    // Both halves: Dashboard is pinned above the groups, so a check reading
    // the groups alone would stop looking at the app's own home.
    const keys = new Set(modulesForApp("crm").map((m) => m.href));
    for (const href of crmNavHrefs()) {
      assert.ok(keys.has(href), `${href} has no module`);
    }
  });

  /**
   * BOTH DIRECTIONS FOR THE SALES DASHBOARD, because only one of them had ever
   * been checked anywhere and the other is the one that bit.
   *
   * A sidebar link with no module behind it is a screen nobody can be withheld
   * from — and, since the sidebar filters itself through the grants, one that
   * silently vanishes for everybody.
   *
   * A module with no sidebar link is the failure this test was written for:
   * Travel ledger, Expense exceptions, Expense policy and Cost & return were
   * all declared, all routable, all grantable, and none of them drawn. Cost &
   * return had no inbound link anywhere in the product. Nothing looked broken,
   * because a missing entry is indistinguishable from a module somebody was
   * not given.
   */
  it("every Sales Dashboard sidebar link is a module that can be withheld", () => {
    const hrefs = new Set(modulesForApp("sales").map((m) => m.href));
    for (const href of navHrefs()) {
      assert.ok(hrefs.has(href), `${href} is in the sidebar and has no module`);
    }
  });

  it("every Sales Dashboard module is reachable from the sidebar", () => {
    // Both halves, through `navHrefs`: Today is pinned above the groups, so a
    // check reading the groups alone would call the console's own home
    // unreachable.
    const drawn = new Set(navHrefs());
    for (const m of modulesForApp("sales")) {
      if (NOT_IN_SIDEBAR.includes(m.href)) continue;
      assert.ok(
        drawn.has(m.href),
        `${m.key} can be granted and has no way in — draw it, or name it in NOT_IN_SIDEBAR`,
      );
    }
  });

  it("nothing is excluded from the sidebar that is not a module", () => {
    // An excuse for a module that no longer exists is an excuse that would
    // silently cover a real one the day somebody reuses the path.
    const hrefs = new Set(modulesForApp("sales").map((m) => m.href));
    for (const href of NOT_IN_SIDEBAR) {
      assert.ok(hrefs.has(href), `${href} is excused from the sidebar and is not a module`);
    }
  });

  /**
   * A pinned item that is also in a group is drawn twice — once at the top and
   * once inside the group — and the second copy is the one nobody expects to
   * find. It is the failure `SALES_PINNED` could have arrived with: Today moved
   * out of Overview, and leaving it in both lists would have been invisible
   * until somebody counted the rows.
   */
  it("nothing is both pinned and inside a group", () => {
    const grouped = new Set(SALES_NAV.flatMap((g) => g.items.map((i) => i.href)));
    for (const item of SALES_PINNED) {
      assert.equal(grouped.has(item.href), false, `${item.href} is pinned and in a group`);
    }
    assert.deepEqual(navHrefs(), [...new Set(navHrefs())], "the sidebar draws an href twice");
  });

  /**
   * Collapsed, a group IS its glyph and its word. The type demands one, so what
   * this guards is a group arriving with a name the icon set does not carry —
   * which renders as a gap rather than as an error.
   */
  it("every group has a glyph the icon set carries", () => {
    for (const group of SALES_NAV) {
      assert.ok(group.icon, `${group.label} has no icon`);
    }
  });

  it("the CRM draws nothing twice, pinned or grouped", () => {
    const grouped = new Set(NAV.flatMap((g) => g.items.map((i) => i.href)));
    for (const item of PINNED) {
      assert.equal(grouped.has(item.href), false, `${item.href} is pinned and in a group`);
    }
    assert.deepEqual(crmNavHrefs(), [...new Set(crmNavHrefs())], "the sidebar draws an href twice");
  });

  it("every CRM group has a glyph the icon set carries", () => {
    for (const group of NAV) {
      assert.ok(group.icon, `${group.label} has no icon`);
    }
  });

  it("module keys are unique", () => {
    const seen = new Set<string>();
    for (const m of APP_MODULES) {
      assert.equal(seen.has(m.key), false, `duplicate module key ${m.key}`);
      seen.add(m.key);
    }
  });

  /**
   * The review table keys its sections on the group NAME, so a group that came
   * back twice handed React two children with the same key — and drew the same
   * heading twice with something else wedged between them.
   *
   * It happened for a reason that will happen again: `sales.approvals` is not
   * in the sidebar, so it was written beside Today where the comment explaining
   * it belongs, and it split Overview into two runs. Anybody inserting a module
   * mid-list can do the same thing tomorrow, in an app they were not thinking
   * about. This is cheaper than remembering.
   */
  it("every app's module groups are whole, so a group name is a usable key", () => {
    for (const app of grantableApps()) {
      const groups = moduleGroupsForApp(app.id);
      const names = groups.map((g) => g.group);
      assert.deepEqual(
        names,
        [...new Set(names)],
        `${app.id} returns the same group more than once: ${names.join(", ")}`,
      );
    }
  });

  it("grouping loses no module and invents none", () => {
    for (const app of grantableApps()) {
      const flat = moduleGroupsForApp(app.id).flatMap((g) => g.modules.map((m) => m.key));
      assert.deepEqual(
        [...flat].sort(),
        modulesForApp(app.id)
          .map((m) => m.key)
          .sort(),
        `${app.id} lost or duplicated a module in grouping`,
      );
    }
  });

  it("a module key is prefixed with its own app", () => {
    // The key is the join key and it carries the app, which is what makes
    // uniqueness on (user, module) enough.
    for (const m of APP_MODULES) {
      assert.equal(m.key.split(".")[0], m.app, `${m.key} does not belong to ${m.app}`);
    }
  });
});
