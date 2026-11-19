import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { ERP_POWERS } from "./erp/powers";
import { moduleKeysForApp } from "./modules";
import { ALL_POWERS, ERP_POWER_SCREENS, applyChange, cleanShape, grantsPlatformAdmin, holdsPower, inputFromRow, shapeFromRow, type AccessTemplateShape, type HeldAccess } from "./access-bulk";

/* The bulk arithmetic: every change is the whole picture `setAccess` saves,
   so what matters is that it changes exactly what was asked and nothing else. */

const ERP = moduleKeysForApp("erp");
const narrowed = (keys: string[]) => ERP.map((k) => ({ key: k, granted: keys.includes(k) }));

function person(over: Partial<HeldAccess> = {}): HeldAccess {
  return {
    userId: "u1",
    name: "Puja",
    role: "manager",
    active: true,
    grants: [{ app: "erp", role: "manager", modules: narrowed(["erp.dashboard", "erp.orders", "erp.settings"]) }],
    erpPowers: ["verifyOrders"],
    hrmsPowers: [],
    taskPowers: [],
    ...over,
  };
}

describe("the power-to-screen map", () => {
  it("names a screen for every ERP power, and every screen exists", () => {
    for (const p of ERP_POWERS) {
      assert.ok(p in ERP_POWER_SCREENS, `${p} has no entry`);
      for (const k of ERP_POWER_SCREENS[p]) assert.ok(ERP.includes(k), `${p} → ${k} is not an ERP screen`);
    }
  });
  it("puts the Production Head check on the Order Hub and MRP check", () => {
    assert.deepEqual([...ERP_POWER_SCREENS.productionCheck].sort(), ["erp.mrpCheck", "erp.orderHub", "erp.toHold"]);
  });
  it("lists every power of every app once", () => {
    const ids = ALL_POWERS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("applyChange", () => {
  it("saving what somebody holds changes nothing", () => {
    const row = person();
    const save = inputFromRow(row);
    assert.deepEqual(save.erpPowers, ["verifyOrders"]);
    assert.deepEqual(save.grants[0].modules.sort(), ["erp.dashboard", "erp.orders", "erp.settings"]);
  });

  it("granting a power ticks the screens it is used on, for a narrowed grant", () => {
    const r = applyChange(person(), { kind: "power", power: "erp.productionCheck", on: true });
    assert.ok(r.changed);
    assert.ok(r.save.erpPowers.includes("productionCheck"));
    for (const k of ["erp.orderHub", "erp.mrpCheck", "erp.toHold"]) assert.ok(r.save.grants[0].modules.includes(k), k);
    assert.match(r.words, /production head/i);
  });

  it("leaves a whole-app grant whole", () => {
    const row = person({ grants: [{ app: "erp", role: "manager", modules: ERP.map((k) => ({ key: k, granted: true })) }] });
    const r = applyChange(row, { kind: "power", power: "erp.productionCheck", on: true });
    assert.ok(r.changed);
    assert.equal(r.save.grants[0].modules.length, ERP.length);
  });

  it("skips somebody without the app unless told to give it", () => {
    const row = person({ grants: [], erpPowers: [] });
    const r = applyChange(row, { kind: "power", power: "erp.verifyPurchase", on: true });
    assert.equal(r.changed, false);
    const g = applyChange(row, { kind: "power", power: "erp.verifyPurchase", on: true, grantApp: true });
    assert.ok(g.changed);
    assert.equal(g.save.grants[0].role, "associate");
    assert.ok(g.save.grants[0].modules.includes("erp.register"));
  });

  it("says so when somebody already holds it", () => {
    const r = applyChange(person(), { kind: "power", power: "erp.verifyOrders", on: true });
    // verifyOrders' screens are not all held, so the screens still move
    assert.ok(r.changed);
    const again = applyChange(person({ grants: [{ app: "erp", role: "manager", modules: ERP.map((k) => ({ key: k, granted: true })) }] }), { kind: "power", power: "erp.verifyOrders", on: true });
    assert.equal(again.changed, false);
  });

  it("taking a power away leaves the screens", () => {
    const r = applyChange(person(), { kind: "power", power: "erp.verifyOrders", on: false });
    assert.ok(r.changed);
    assert.deepEqual(r.save.erpPowers, []);
    assert.ok(r.save.grants[0].modules.includes("erp.orders"));
  });

  it("cannot take a power from an administrator, who holds it without a row", () => {
    const row = person({ grants: [{ app: "erp", role: "admin", modules: narrowed(["erp.dashboard"]) }], erpPowers: [] });
    assert.equal(holdsPower(row, { app: "erp", key: "verifyPurchase" }), "admin");
    const r = applyChange(row, { kind: "power", power: "erp.verifyPurchase", on: false });
    assert.equal(r.changed, false);
  });

  it("will not untick somebody's last screen — that is taking the app away", () => {
    const row = person({ grants: [{ app: "erp", role: "associate", modules: narrowed(["erp.orders"]) }] });
    const r = applyChange(row, { kind: "screen", module: "erp.orders", on: false });
    assert.equal(r.changed, false);
  });

  it("a template only widens: higher level, more screens, more powers, nothing removed", () => {
    const row = person({ hrmsPowers: [], grants: [...person().grants, { app: "hrms", role: "associate", modules: moduleKeysForApp("hrms").map((k) => ({ key: k, granted: true })) }] });
    const shape = cleanShape({
      apps: [
        { app: "erp", role: "associate", modules: ["erp.orderHub"] },
        { app: "tasks", role: "associate", modules: null },
      ],
      erpPowers: ["productionCheck"],
      hrmsPowers: [],
      taskPowers: ["seeAll"],
    });
    const r = applyChange(row, { kind: "template", shape });
    assert.ok(r.changed);
    const erp = r.save.grants.find((g) => g.app === "erp")!;
    assert.equal(erp.role, "manager", "never lowered");
    assert.ok(erp.modules.includes("erp.orders"), "kept");
    assert.ok(erp.modules.includes("erp.orderHub") && erp.modules.includes("erp.mrpCheck"));
    assert.deepEqual(r.save.erpPowers.sort(), ["productionCheck", "verifyOrders"]);
    assert.ok(r.save.grants.some((g) => g.app === "tasks"));
    assert.deepEqual(r.save.taskPowers, ["seeAll"]);
  });

  it("a template made from a person, applied to them, changes nothing", () => {
    const row = person({ grants: [{ app: "erp", role: "manager", modules: narrowed(["erp.dashboard", "erp.orders", "erp.orderHub", "erp.toHold", "erp.settings"]) }] });
    const r = applyChange(row, { kind: "template", shape: shapeFromRow(row) });
    assert.equal(r.changed, false);
  });

  it("cleanShape drops screens and powers that no longer exist", () => {
    const s = cleanShape({ apps: [{ app: "erp", role: "boss", modules: ["erp.orders", "erp.gone"] }, { app: "nope", role: "admin", modules: null }], erpPowers: ["verifyOrders", "flyAway"] });
    assert.deepEqual(s.apps, [{ app: "erp", role: "associate", modules: ["erp.orders"] }]);
    assert.deepEqual(s.erpPowers, ["verifyOrders"]);
  });
});

test("a template never makes somebody a platform administrator", () => {
  const shape = (app: string, role: "associate" | "manager" | "admin") => ({ apps: [{ app, role, modules: null }], erpPowers: [], hrmsPowers: [], taskPowers: [] }) as AccessTemplateShape;
  assert.equal(grantsPlatformAdmin(shape("admin", "admin")), true);
  assert.equal(grantsPlatformAdmin(shape("admin", "manager")), false, "a lower Admin Console level is not the platform hat");
  assert.equal(grantsPlatformAdmin(shape("erp", "admin")), false, "admin of another app is admin of that app only");
});

describe("a template that carries a Hire role and an ERP designation", () => {
  const held = (apps: string[], over: Partial<HeldAccess> = {}): HeldAccess => ({
    userId: "u1",
    name: "Asha",
    role: "associate",
    active: true,
    grants: apps.map((app) => ({ app: app as never, role: "associate", modules: moduleKeysForApp(app as never).map((key) => ({ key, granted: true })) })),
    erpPowers: [],
    hrmsPowers: [],
    taskPowers: [],
    ...over,
  });
  const shape = { apps: [{ app: "erp" as const, role: "associate" as const, modules: null }, { app: "hire" as const, role: "associate" as const, modules: null }], erpPowers: [], hrmsPowers: [], taskPowers: [], hireRole: "recruiter", erpDesignationId: "erpd_x" };

  it("sets both on somebody it gives those apps, and is made from a person who holds them", () => {
    const r = applyChange(held([]), { kind: "template", shape });
    assert.ok(r.changed);
    assert.equal(r.changed && r.save.hireRole, "recruiter");
    assert.equal(r.changed && r.save.erpDesignationId, "erpd_x");
    const made = shapeFromRow(held(["erp", "hire"], { hireRole: "interviewer", erpDesignation: { id: "erpd_y" } }));
    assert.equal(made.hireRole, "interviewer");
    assert.equal(made.erpDesignationId, "erpd_y");
  });

  it("leaves them alone where the person already has them, so nothing changes", () => {
    const r = applyChange(held(["erp", "hire"], { hireRole: "recruiter", erpDesignation: { id: "erpd_x" } }), { kind: "template", shape });
    assert.equal(r.changed, false);
  });

  it("survives cleaning, and an old template without them still applies", () => {
    assert.equal(cleanShape(shape).hireRole, "recruiter");
    assert.equal(cleanShape({ apps: [], erpPowers: [], hrmsPowers: [], taskPowers: [] }).hireRole, null);
  });
});
