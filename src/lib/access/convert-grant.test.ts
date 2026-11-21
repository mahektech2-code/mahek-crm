/**
 * CONVERTING TODAY'S GRANTS TO THE SCREEN MODEL — and proving what it moves.
 *
 * Pure. The backfill job is these two functions and a database; every case
 * the job meets is pinned here first.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { APPS } from "../apps";
import { compareConversion, convertGrant, type GrantToday } from "./convert-grant";

const grant = (over: Partial<GrantToday> & Pick<GrantToday, "app">): GrantToday => ({
  role: "associate",
  modules: null,
  powers: [],
  platformAdmin: false,
  ...over,
});

describe("whole-app grants", () => {
  test("no app, at any level, loses anything or gains a screen", () => {
    for (const a of APPS.filter((x) => !x.retiredInto)) {
      for (const role of ["associate", "manager", "admin", null] as const) {
        for (const platformAdmin of [false, true]) {
          const g = grant({ app: a.id, role, platformAdmin });
          const d = compareConversion(g, convertGrant(g));
          assert.deepEqual([d.lost, d.lostWithScreen, d.screensAdded], [[], [], []], `${a.id} ${role} ${platformAdmin}`);
        }
      }
    }
  });

  test("a level becomes the position: associate own, manager team, an administrator everyone", () => {
    assert.equal(convertGrant(grant({ app: "crm" })).position, "associate");
    assert.equal(convertGrant(grant({ app: "crm", role: null })).position, "associate");
    assert.equal(convertGrant(grant({ app: "crm", role: "manager" })).position, "manager");
    assert.equal(convertGrant(grant({ app: "erp", role: "admin" })).position, "everyone");
  });

  test("an administrator holds every screen at Edit and Delete", () => {
    const g = convertGrant(grant({ app: "erp", role: "admin" }));
    for (const t of g.screens.values()) assert.deepEqual(t, { edit: true, delete: true, autoEdit: false });
  });
});

describe("narrowed grants", () => {
  test("keep exactly their screens, plus the ones every holder opens", () => {
    const g = convertGrant(grant({ app: "erp", modules: ["erp.orders"] }));
    assert.deepEqual([...g.screens.keys()].sort(), ["erp.dashboard", "erp.feedback", "erp.myTasks", "erp.orders", "erp.settings"]);
  });

  test("a capability held only through a screen left out goes with that screen, and says so", () => {
    const g = grant({ app: "crm", role: "manager", modules: ["crm.call-log"] });
    const d = compareConversion(g, convertGrant(g));
    assert.deepEqual(d.lost, []);
    assert.ok(d.lostWithScreen.includes("lead.trash"));
  });

  test("the old Write level is Edit: WhatsApp narrowed to read stays read", () => {
    const read = convertGrant(grant({ app: "crm", modules: ["crm.whatsapp"] }));
    const write = convertGrant(grant({ app: "crm", modules: ["crm.whatsapp", "crm.whatsapp-reply"] }));
    assert.equal(read.screens.get("crm.whatsapp")?.edit, false);
    assert.equal(write.screens.get("crm.whatsapp")?.edit, true);
    assert.equal(convertGrant(grant({ app: "crm" })).screens.get("crm.whatsapp")?.edit, true);
  });
});

describe("the ERP's, HRMS's and Tasks' powers", () => {
  test("a power is its screen at its tick, and nothing is lost", () => {
    const g = grant({ app: "erp", modules: ["erp.orders"], powers: ["approvePurchaseOrder", "reopenPurchase"] });
    const after = convertGrant(g);
    assert.equal(after.screens.get("erp.purchaseOrders")?.edit, true);
    assert.deepEqual(after.screens.get("erp.register"), { edit: true, delete: true, autoEdit: true });
    const d = compareConversion(g, after);
    assert.deepEqual(d.lost, []);
    assert.deepEqual(d.screensAdded.sort(), ["erp.purchaseOrders", "erp.register"]);
  });

  test("a power that shares its tick brings its partner, and the comparison names it", () => {
    const g = grant({ app: "erp", powers: ["approvePurchaseOrder"] });
    const d = compareConversion(g, convertGrant(g));
    assert.ok(d.gained.includes("erp:viewPurchaseMoney"));
  });

  test("an everybody power raises the position", () => {
    assert.equal(convertGrant(grant({ app: "tasks", powers: ["seeAll"] })).position, "everyone");
    assert.equal(convertGrant(grant({ app: "tasks", powers: ["automations"] })).position, "associate");
  });

  test("an HRMS manager keeps marking and checking out their team", () => {
    const g = grant({ app: "hrms", role: "manager", modules: ["hrms.home"] });
    const after = convertGrant(g);
    assert.equal(after.screens.get("hrms.attendance")?.edit, true);
    assert.deepEqual(compareConversion(g, after).lost, []);
  });

  test("an unknown power row is ignored rather than guessed", () => {
    const g = grant({ app: "erp", modules: ["erp.orders"], powers: ["notAPower"] });
    assert.deepEqual(compareConversion(g, convertGrant(g)).lost, []);
  });
});
