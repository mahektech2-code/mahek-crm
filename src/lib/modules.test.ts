import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { APP_MODULES, moduleAllowed, moduleForPath, modulesForApp } from "./modules";
import { NAV } from "@/components/shell/nav";

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
    const keys = new Set(modulesForApp("crm").map((m) => m.href));
    for (const group of NAV) {
      for (const item of group.items) {
        assert.ok(keys.has(item.href), `${item.href} has no module`);
      }
    }
  });

  it("module keys are unique", () => {
    const seen = new Set<string>();
    for (const m of APP_MODULES) {
      assert.equal(seen.has(m.key), false, `duplicate module key ${m.key}`);
      seen.add(m.key);
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
