import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { APP_MODULES } from "./modules";
import { ERP_POWERS } from "./erp/powers";
import { ERP_POWER_SINCE, MODULE_SINCE } from "./module-since-data";
import { dayLabel, erpPowersNewSince, namedList, screensNewSince } from "./module-since";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

describe("every screen and power carries the day it shipped", () => {
  /* A key with no date is never reported as new, which is exactly the silence
     the date table exists to end. Add it to module-since-data.ts with the day
     it ships. */
  it("every module key has a date", () => {
    const missing = APP_MODULES.map((m) => m.key).filter((k) => !MODULE_SINCE[k]);
    assert.deepEqual(missing, [], `add these to MODULE_SINCE in src/lib/module-since-data.ts with the day they ship: ${missing.join(", ")}`);
  });

  it("every ERP power has a date", () => {
    const missing = ERP_POWERS.filter((p) => !ERP_POWER_SINCE[p]);
    assert.deepEqual(missing, [], `add these to ERP_POWER_SINCE in src/lib/module-since-data.ts with the day they ship: ${missing.join(", ")}`);
  });

  it("every date is a YYYY-MM-DD day", () => {
    for (const [k, v] of [...Object.entries(MODULE_SINCE), ...Object.entries(ERP_POWER_SINCE)]) {
      assert.match(v, DAY, `${k}: ${v}`);
    }
  });
});

describe("screensNewSince", () => {
  it("names a screen shipped after the grant was set and not held", () => {
    const fresh = screensNewSince("crm", "2026-10-05", ["crm.dashboard"]).map((m) => m.key);
    assert.ok(fresh.includes("crm.opportunities"));
  });

  it("is silent about a screen that already existed — that was a decision", () => {
    const fresh = screensNewSince("crm", "2026-10-05", []).map((m) => m.key);
    assert.ok(!fresh.includes("crm.dashboard"));
  });

  it("is silent about a screen shipped on the very day it was set", () => {
    const fresh = screensNewSince("crm", MODULE_SINCE["crm.opportunities"], []).map((m) => m.key);
    assert.ok(!fresh.includes("crm.opportunities"));
  });

  it("is silent about a screen they already hold", () => {
    const fresh = screensNewSince("crm", "2026-10-05", ["crm.opportunities"]).map((m) => m.key);
    assert.ok(!fresh.includes("crm.opportunities"));
  });

  it("never offers an off-by-default desk, a seat, a write level or an always-open screen", () => {
    const fresh = screensNewSince("crm", "2000-01-01", []);
    for (const m of fresh) {
      assert.ok(!m.offByDefault && !m.explicitOnly && !m.writeOf, m.key);
    }
    const erp = screensNewSince("erp", "2000-01-01", []).map((m) => m.key);
    assert.ok(!erp.includes("erp.dashboard"));
  });

  it("says nothing without a date — a whole-app grant receives new screens by itself", () => {
    assert.deepEqual(screensNewSince("crm", null, []), []);
  });
});

describe("erpPowersNewSince", () => {
  it("names a power added after the save and not held", () => {
    assert.ok(erpPowersNewSince("2026-10-09", []).includes("verifyOrders"));
    assert.ok(!erpPowersNewSince("2026-10-09", ["verifyOrders"]).includes("verifyOrders"));
    assert.ok(!erpPowersNewSince("2026-10-09", []).includes("viewCost"));
  });
});

describe("words", () => {
  it("dayLabel", () => assert.equal(dayLabel("2026-10-05"), "5 Oct"));
  it("namedList", () => {
    assert.equal(namedList(["A"]), "A");
    assert.equal(namedList(["A", "B"]), "A and B");
    assert.equal(namedList(["A", "B", "C"]), "A, B and C");
    assert.equal(namedList(["A", "B", "C", "D"]), "A, B and 2 more");
  });
});
