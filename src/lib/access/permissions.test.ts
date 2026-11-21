/**
 * THE SCREEN MODEL OF ACCESS — its tick rules, its table of who owns which
 * action, and what it changes against today's levels.
 *
 * Pure, so nothing here needs a database. The last test is the sign-off list:
 * it pins EXACTLY what the screen model gives or takes away for a whole-app
 * grant at each level, so any change to `action-owners.ts` that moves
 * somebody's powers fails here until the list is updated on purpose.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { APPS, type AppId } from "../apps";
import { CAPABILITIES, type Capability } from "../capability-matrix";
import { ACTION_OWNERS } from "./action-owners";
import {
  emptyGrant,
  normaliseGrant,
  setAccess,
  setDelete,
  setEdit,
  setModule,
  setPosition,
  type AppGrantDraft,
  type ModuleShape,
} from "./permission-rules";
import { ERP_POWER_OWNERS, HRMS_POWER_OWNERS, TASK_POWER_OWNERS } from "./power-owners";
import { differenceForLevel, draftFromLevel, holdsAny, holdsWithScreens, moduleShape } from "./screen-permissions";

const SHAPE: ModuleShape[] = [
  { module: "Daily calling", screens: ["crm.tasks", "crm.call-log", "crm.reminders"] },
  { module: "Lead Management", screens: ["crm.leads", "crm.lead-dead"] },
];

const ticks = (g: AppGrantDraft, s: string) => g.screens.get(s);

describe("module gates its screens", () => {
  test("a screen cannot be given while its module is not", () => {
    const g = setAccess(emptyGrant(), SHAPE, "crm.call-log", true);
    assert.equal(g.screens.size, 0);
    assert.equal(setEdit(emptyGrant(), SHAPE, "crm.call-log", true).screens.size, 0);
    assert.equal(setDelete(emptyGrant(), SHAPE, "crm.call-log", true).screens.size, 0);
  });

  test("giving a module opens every screen under it, at Access only", () => {
    const g = setModule(emptyGrant(), SHAPE, "Daily calling", true);
    assert.deepEqual([...g.screens.keys()].sort(), ["crm.call-log", "crm.reminders", "crm.tasks"]);
    for (const t of g.screens.values()) assert.deepEqual(t, { edit: false, delete: false, autoEdit: false });
    assert.ok(!g.screens.has("crm.leads"));
  });

  test("taking a module away takes its screens, ticks and all", () => {
    let g = setModule(emptyGrant(), SHAPE, "Daily calling", true);
    g = setDelete(g, SHAPE, "crm.call-log", true);
    g = setModule(g, SHAPE, "Daily calling", false);
    assert.equal(g.screens.size, 0);
    assert.ok(!g.modules.has("Daily calling"));
  });

  test("taking the last screen away takes the module", () => {
    let g = setModule(emptyGrant(), SHAPE, "Lead Management", true);
    g = setAccess(g, SHAPE, "crm.leads", false);
    assert.ok(g.modules.has("Lead Management"));
    g = setAccess(g, SHAPE, "crm.lead-dead", false);
    assert.ok(!g.modules.has("Lead Management"));
  });
});

describe("Delete needs Edit", () => {
  const open = () => setModule(emptyGrant(), SHAPE, "Lead Management", true);

  test("Delete brings Edit along, and takes back only the Edit it brought", () => {
    let g = setDelete(open(), SHAPE, "crm.leads", true);
    assert.deepEqual(ticks(g, "crm.leads"), { edit: true, delete: true, autoEdit: true });
    g = setDelete(g, SHAPE, "crm.leads", false);
    assert.deepEqual(ticks(g, "crm.leads"), { edit: false, delete: false, autoEdit: false });
  });

  test("an Edit ticked by hand stays when Delete goes", () => {
    let g = setEdit(open(), SHAPE, "crm.leads", true);
    g = setDelete(g, SHAPE, "crm.leads", true);
    assert.equal(ticks(g, "crm.leads")?.autoEdit, false);
    g = setDelete(g, SHAPE, "crm.leads", false);
    assert.deepEqual(ticks(g, "crm.leads"), { edit: true, delete: false, autoEdit: false });
  });

  test("an Edit Delete brought becomes the person's own once ticked by hand", () => {
    let g = setDelete(open(), SHAPE, "crm.leads", true);
    g = setEdit(g, SHAPE, "crm.leads", true);
    g = setDelete(g, SHAPE, "crm.leads", false);
    assert.equal(ticks(g, "crm.leads")?.edit, true);
  });

  test("taking Edit away takes Delete with it", () => {
    let g = setDelete(open(), SHAPE, "crm.leads", true);
    g = setEdit(g, SHAPE, "crm.leads", false);
    assert.deepEqual(ticks(g, "crm.leads"), { edit: false, delete: false, autoEdit: false });
  });

  test("taking Access away takes Edit and Delete with it", () => {
    let g = setDelete(open(), SHAPE, "crm.leads", true);
    g = setAccess(g, SHAPE, "crm.leads", false);
    assert.equal(ticks(g, "crm.leads"), undefined);
  });
});

describe("the server's reading of a save", () => {
  test("drops unknown screens and screens under a module not given; mends Delete without Edit", () => {
    const sent: AppGrantDraft = {
      position: "associate",
      modules: new Set(["Lead Management"]),
      screens: new Map([
        ["crm.leads", { edit: false, delete: true, autoEdit: false }],
        ["crm.call-log", { edit: true, delete: false, autoEdit: false }],
        ["crm.not-a-screen", { edit: true, delete: true, autoEdit: false }],
      ]),
    };
    const g = normaliseGrant(sent, SHAPE);
    assert.deepEqual([...g.screens.keys()], ["crm.leads"]);
    assert.deepEqual(ticks(g, "crm.leads"), { edit: true, delete: true, autoEdit: true });
  });

  test("a module with no screen left is not given; running it twice changes nothing", () => {
    const sent: AppGrantDraft = { position: "manager", modules: new Set(["Daily calling"]), screens: new Map() };
    const once = normaliseGrant(sent, SHAPE);
    assert.equal(once.modules.size, 0);
    assert.deepEqual(normaliseGrant(once, SHAPE), once);
  });
});

describe("position decides what is seen, never what is done", () => {
  test("switching position moves no tick", () => {
    let g = setModule(emptyGrant(), SHAPE, "Lead Management", true);
    g = setDelete(g, SHAPE, "crm.leads", true);
    const m = setPosition(g, "manager");
    assert.equal(m.position, "manager");
    assert.deepEqual(m.screens, g.screens);
    assert.deepEqual(m.modules, g.modules);
  });
});

describe("who owns which action", () => {
  test("every owning screen is a real screen of that app's sidebar", () => {
    for (const c of CAPABILITIES) {
      for (const [app, owners] of Object.entries(ACTION_OWNERS[c])) {
        const screens = new Set(moduleShape(app as AppId).flatMap((m) => m.screens));
        for (const o of owners ?? []) assert.ok(screens.has(o.screen), `${c} is owned by ${o.screen}, which ${app} does not have`);
      }
    }
  });

  test("a whole-app grant at a level, read back, holds everything the level held", () => {
    for (const a of APPS.filter((x) => !x.retiredInto)) {
      for (const role of ["associate", "manager"] as const) {
        assert.deepEqual(differenceForLevel(a.id, role).lost, [], `${a.id} ${role} would lose powers on the day`);
      }
    }
  });

  test("a narrowed grant keeps no tick on a screen it never held", () => {
    const g = draftFromLevel("crm", "manager", ["crm.call-log"]);
    assert.deepEqual([...g.screens.keys()], ["crm.call-log"]);
    assert.equal(holdsWithScreens("crm", g, "lead.trash"), false);
  });

  /*
   * THE SIGN-OFF LIST. What a whole-app grant gains under the screen model
   * that its level did not carry. Each line is a decision, not an accident:
   *
   * - Exporting the customer list comes with opening Customers, because
   *   Access gives every ordinary action on a screen. Today it is a
   *   manager's. An associate exports only their own book (position).
   */
  test("what the screen model gives beyond today's levels is exactly the signed-off list", () => {
    const gained: Record<string, Capability[]> = {};
    for (const a of APPS.filter((x) => !x.retiredInto)) {
      for (const role of ["associate", "manager"] as const) {
        const d = differenceForLevel(a.id, role);
        if (d.gained.length) gained[`${a.id} ${role}`] = d.gained;
      }
    }
    assert.deepEqual(gained, {
      "crm associate": ["customer.export"],
      "sales associate": ["customer.export"],
    });
  });
});

describe("the ERP's, HRMS's and Tasks' own powers", () => {
  const TABLES = [
    ["erp", ERP_POWER_OWNERS],
    ["hrms", HRMS_POWER_OWNERS],
    ["tasks", TASK_POWER_OWNERS],
  ] as const;

  test("every power sits on a real screen of its app", () => {
    for (const [app, table] of TABLES) {
      const screens = new Set(moduleShape(app).flatMap((m) => m.screens));
      for (const [power, owners] of Object.entries(table)) {
        assert.ok(owners.length > 0, `${app} ${power} sits on no screen`);
        for (const o of owners) assert.ok(screens.has(o.screen), `${app} ${power} sits on ${o.screen}, which ${app} does not have`);
      }
    }
  });

  test("seeing everybody's records needs the Everyone position", () => {
    const g: AppGrantDraft = { position: "manager", modules: new Set(["Tasks"]), screens: new Map([["tasks.team", { edit: true, delete: true, autoEdit: false }]]) };
    assert.equal(holdsAny(g, TASK_POWER_OWNERS.manageAnyone), false);
    assert.equal(holdsAny({ ...g, position: "everyone" }, TASK_POWER_OWNERS.manageAnyone), true);
    assert.equal(holdsAny({ ...g, position: "everyone" }, TASK_POWER_OWNERS.automations), false);
  });

  /*
   * POWERS THAT NOW TRAVEL TOGETHER, because they sit on the same screen at
   * the same tick. Signed off with the rule that money comes with Edit.
   */
  test("the powers that share a tick are exactly these", () => {
    const shared: Record<string, string[]> = {};
    for (const [app, table] of TABLES) {
      const byTick = new Map<string, string[]>();
      for (const [power, owners] of Object.entries(table)) {
        for (const o of owners) {
          const k = `${o.screen} ${o.tick}${o.position ? ` ${o.position}` : ""}`;
          byTick.set(k, [...(byTick.get(k) ?? []), power]);
        }
      }
      for (const [k, ps] of byTick) if (ps.length > 1) shared[`${app}: ${k}`] = ps;
    }
    assert.deepEqual(shared, {
      "erp: erp.register edit": ["viewPurchaseMoney", "verifyPurchase"],
      "erp: erp.purchaseOrders edit": ["viewPurchaseMoney", "approvePurchaseOrder"],
      "erp: erp.sfgBatches edit": ["viewCost", "approveSfgQc"],
      "erp: erp.orders edit": ["viewSalesRate", "viewSalesAmounts", "editOrders"],
      "hrms: hrms.attendance edit": ["markStaff", "checkoutStaff"],
      "hrms: hrms.leave edit": ["onBehalf", "approveLeave", "split"],
      "hrms: hrms.offices edit": ["import", "timings"],
      "hrms: hrms.payroll edit": ["payroll", "verifyExp"],
      "hrms: hrms.payroll delete": ["pay", "advance"],
      "hrms: hrms.kpi access everyone": ["perfAdmin", "salesAll"],
    });
  });
});
