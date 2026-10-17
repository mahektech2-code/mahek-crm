/**
 * `writeModules` stores "every module ticked" as NO rows, and `moduleAllowed`
 * reads no rows as "the whole app" — except for an `explicitOnly` module, which
 * answers to its own row alone. The write used to collapse on a COUNT of ticked
 * modules, so ticking everything including `website.publish` stored nothing and
 * the right silently never existed (the audit still read "13/13").
 *
 * Pure: a recording stand-in for the transaction, so no database is needed. The
 * one rule under test is that what is stored, read back through
 * `moduleAllowed`, is exactly what was ticked.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { getModule, isWholeApp, moduleAllowed, moduleKeysForApp, modulesForApp, wholeAppKeys } from "@/lib/modules";
import { writeModules, type Tx } from "@/lib/services/access-writes";

/** Rows this one person holds for one app, as the table would after each write. */
function store() {
  let rows: string[] = [];
  const tx = {
    delete: () => ({
      where: () => {
        rows = [];
        return Promise.resolve();
      },
    }),
    insert: () => ({
      values: (v: { module: string }[]) => {
        rows = v.map((r) => r.module);
        return Promise.resolve();
      },
    }),
  } as unknown as Tx;
  return { tx, rows: () => rows };
}

const ORDINARY = (app: "website" | "sales") => wholeAppKeys(app);
const EXPLICIT = (app: "website" | "sales") => modulesForApp(app).filter((m) => m.explicitOnly).map((m) => m.key);

describe("writeModules and explicit-only rights", () => {
  test("website: ticking everything INCLUDING website.publish stores rows, and the right is held", async () => {
    const s = store();
    await writeModules(s.tx, "u", "website", moduleKeysForApp("website"), "me");
    assert.ok(s.rows().includes("website.publish"));
    assert.equal(s.rows().length, moduleKeysForApp("website").length);
    assert.equal(moduleAllowed("website.publish", s.rows(), "website"), true);
    for (const k of ORDINARY("website")) assert.equal(moduleAllowed(k, s.rows(), "website"), true, k);
  });

  test("website: ticking only the review right stores rows, holds it, and does not carry publishing", async () => {
    const s = store();
    await writeModules(s.tx, "u", "website", [...ORDINARY("website"), "website.review"], "me");
    assert.ok(s.rows().includes("website.review"), "the explicit-only right is written as a row, not implied by the whole app");
    assert.equal(moduleAllowed("website.review", s.rows(), "website"), true);
    assert.equal(moduleAllowed("website.publish", s.rows(), "website"), false);
  });

  test("website: every ordinary screen with NEITHER explicit right is still the whole app (no rows) and neither is held", async () => {
    const s = store();
    await writeModules(s.tx, "u", "website", ORDINARY("website"), "me");
    assert.deepEqual(s.rows(), []);
    assert.equal(moduleAllowed("website.review", s.rows(), "website"), false);
    assert.equal(moduleAllowed("website.review", s.rows(), "website", true), false, "not even an administrator hat");
  });

  test("website: every ordinary screen WITHOUT publish is still the whole app (no rows) and publish is not held", async () => {
    const s = store();
    await writeModules(s.tx, "u", "website", ORDINARY("website"), "me");
    assert.deepEqual(s.rows(), []);
    assert.equal(moduleAllowed("website.publish", s.rows(), "website"), false);
    assert.equal(moduleAllowed("website.products", s.rows(), "website"), true);
  });

  test("partial selection stores exactly what was ticked, and nothing more is held", async () => {
    const s = store();
    await writeModules(s.tx, "u", "website", ["website.dashboard", "website.products"], "me");
    assert.deepEqual([...s.rows()].sort(), ["website.dashboard", "website.products"]);
    assert.equal(moduleAllowed("website.products", s.rows(), "website"), true);
    assert.equal(moduleAllowed("website.pages", s.rows(), "website"), false);
    assert.equal(moduleAllowed("website.publish", s.rows(), "website"), false);
  });

  test("explicit-only right alone beside its screen: held, and the rest stays narrowed", async () => {
    const s = store();
    await writeModules(s.tx, "u", "website", ["website.dashboard", "website.publish"], "me");
    assert.equal(moduleAllowed("website.publish", s.rows(), "website"), true);
    assert.equal(moduleAllowed("website.products", s.rows(), "website"), false);
  });

  test("repeated saves are stable: the same full selection twice keeps the right; dropping it revokes it", async () => {
    const s = store();
    const full = moduleKeysForApp("website");
    await writeModules(s.tx, "u", "website", full, "me");
    await writeModules(s.tx, "u", "website", full, "me");
    assert.equal(moduleAllowed("website.publish", s.rows(), "website"), true);
    assert.equal(s.rows().length, full.length, "no duplicate rows after a second save");
    await writeModules(s.tx, "u", "website", ORDINARY("website"), "me");
    assert.equal(moduleAllowed("website.publish", s.rows(), "website"), false);
    assert.deepEqual(s.rows(), [], "back to the plain whole-app grant");
  });

  test("an app with no explicit-only module is unchanged: all ticked is no rows, one short is rows", async () => {
    const s = store();
    await writeModules(s.tx, "u", "crm", moduleKeysForApp("crm"), "me");
    assert.deepEqual(s.rows(), []);
    const short = moduleKeysForApp("crm").slice(1);
    await writeModules(s.tx, "u", "crm", short, "me");
    assert.deepEqual([...s.rows()].sort(), [...short].sort());
  });

  test("sales.lead-pipeline (also explicit-only) has the same guarantee through the same write", async () => {
    const s = store();
    await writeModules(s.tx, "u", "sales", moduleKeysForApp("sales"), "me");
    assert.ok(s.rows().includes("sales.lead-pipeline"));
    assert.equal(moduleAllowed("sales.lead-pipeline", s.rows(), "sales"), true);
    await writeModules(s.tx, "u", "sales", ORDINARY("sales"), "me");
    assert.deepEqual(s.rows(), []);
    assert.equal(moduleAllowed("sales.lead-pipeline", s.rows(), "sales"), false);
  });
});

describe("what no rows stands for", () => {
  test("wholeAppKeys is exactly what moduleAllowed grants to a no-rows holder, for every app", () => {
    for (const m of modulesForApp("website")) {
      assert.equal(wholeAppKeys("website").includes(m.key), moduleAllowed(m.key, [], "website"), m.key);
    }
    for (const app of ["crm", "sales", "erp", "accounts"] as const) {
      for (const m of modulesForApp(app)) {
        assert.equal(wholeAppKeys(app).includes(m.key), moduleAllowed(m.key, [], app), m.key);
      }
    }
  });

  test("isWholeApp: explicit-only ticked is never the whole app; an ordinary one missing is never the whole app", () => {
    assert.equal(isWholeApp("website", ORDINARY("website")), true);
    assert.equal(isWholeApp("website", [...ORDINARY("website"), ...EXPLICIT("website")]), false);
    assert.equal(isWholeApp("website", ORDINARY("website").slice(1)), false);
    assert.equal(isWholeApp("website", []), false);
  });

  test("the explicit-only registry is what these tests think it is", () => {
    assert.deepEqual(EXPLICIT("website"), ["website.publish", "website.review"]);
    assert.deepEqual(EXPLICIT("sales"), ["sales.lead-pipeline"]);
    assert.equal(getModule("website.publish")?.explicitOnly, true);
    assert.equal(getModule("website.review")?.explicitOnly, true);
  });
});
