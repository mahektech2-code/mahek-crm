/**
 * ERP phase 1 — access, powers, working location and the masters, against a
 * real database through the real handlers.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  customers,
  erpCustomerProfiles,
  erpGodownStaff,
  erpRawMaterials,
  erpUserPowers,
  users,
} from "@/db/schema";
import { setAccess } from "@/lib/actions/access";
import { moduleKeysForApp } from "@/lib/modules";
import { setTestUser } from "@/lib/auth";
import { erpContext, requireErpWrite, ErpNotPermitted } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { partyStatus, loadCustomers } from "@/lib/erp/screens/masters";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, level: "associate" | "manager" | "admin", erp = true) {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\s/g, ".")}@erp.test`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: level,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  if (erp) await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "erp", role: level });
  return u;
}

/* `erpContext` is cached per request; a test "request" is a fresh import scope
   only if the cache is not shared — it is React's `cache`, which outside a
   request does not memoise, so each call reads afresh. */
async function as(u: typeof users.$inferSelect) {
  setTestUser(u);
  return erpContext();
}

const mod = (k: string) => {
  const m = screenModule(k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;
let narrowed: typeof users.$inferSelect;
let outsider: typeof users.$inferSelect;

before(async () => {
  await db.execute(sql`truncate users, customers, erp_raw_materials, erp_suppliers, erp_user_powers, erp_godown_staff, erp_user_settings, erp_customer_profiles, audit_log restart identity cascade`);
  admin = await makeUser("Kavita Admin", "admin");
  clerk = await makeUser("Deepa Clerk", "associate");
  narrowed = await makeUser("Santosh Narrow", "associate");
  outsider = await makeUser("Priya Outsider", "associate", false);
  await db.insert(appModuleAccess).values({ id: id("ama"), userId: narrowed.id, app: "erp", module: "erp.customers" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("access", () => {
  test("an ERP administrator holds every power without a row; an associate holds none", async () => {
    const a = await as(admin);
    assert.equal(a.administrator, true);
    assert.ok(a.powers.has("verifyTest") && a.powers.has("viewCost") && a.powers.has("lostStock"));
    const c = await as(clerk);
    assert.equal(c.powers.size, 0);
  });

  test("a narrowed grant opens only its modules, plus the dashboard and settings", async () => {
    const n = await as(narrowed);
    assert.ok(n.screens.has("customers"));
    assert.ok(n.screens.has("dashboard") && n.screens.has("settings"));
    assert.ok(!n.screens.has("rawMaterials"));
    await assert.rejects(() => requireErpWrite("rawMaterials"), ErpNotPermitted);
    await requireErpWrite("customers");
  });

  test("somebody never given the ERP cannot write to it", async () => {
    await as(outsider);
    await assert.rejects(() => requireErpWrite("customers"), ErpNotPermitted);
  });

  test("a write that needs a power is refused without it", async () => {
    await as(clerk);
    await assert.rejects(() => requireErpWrite("customers", "customerStatus"), /Only an admin or the office/);
  });
});

describe("raw materials", () => {
  test("a chemical needs a density and a testing list", async () => {
    const ctx = await as(admin);
    const r = await mod("rawMaterials").forms!.new(ctx, { name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical" }, []);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.fieldErrors?.[0].field === "density");
  });

  test("serial numbers follow on, and a name is unique whatever its case", async () => {
    const ctx = await as(admin);
    const a = await mod("rawMaterials").forms!.new(ctx, { name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical", density: "0.87", testingList: "PH|Density", price: "92" }, []);
    assert.ok(a.ok);
    const b = await mod("rawMaterials").forms!.new(ctx, { name: "1 L Tin Can", code: "CAN1", unit: "Unit", materialType: "Can" }, []);
    assert.ok(b.ok);
    const dup = await mod("rawMaterials").forms!.new(ctx, { name: "toluene", code: "X", unit: "Litre", materialType: "Can" }, []);
    assert.ok(!dup.ok && dup.fieldErrors?.[0].message === "Duplicate Entry!");
    const rows = await db.select().from(erpRawMaterials).orderBy(erpRawMaterials.serialNo);
    assert.deepEqual(rows.map((r) => [r.serialNo, r.name]), [[1, "Toluene"], [2, "1 L Tin Can"]]);
    assert.equal(rows[0].pricePaise, 9200);
    assert.equal(rows[1].density, null, "a can carries no density");
  });

  test("the price never reaches somebody without the purchase-money power", async () => {
    const ctx = await as(clerk);
    const { spec, rows } = await mod("rawMaterials").load(ctx);
    assert.ok(!spec.cols.some((c) => c.k === "price"));
    assert.deepEqual(spec.hidden.map((h) => h.l), ["Price"]);
    assert.ok(rows.every((r) => !("price" in r.v)));
  });

  test("a clerk saving a raw material cannot overwrite its price", async () => {
    const ctx = await as(clerk);
    const [tol] = await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.name, "Toluene"));
    const r = await mod("rawMaterials").forms!.edit(ctx, { name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical", density: "0.88", testingList: "PH", price: "1" }, [], tol.id);
    assert.ok(r.ok);
    const [after] = await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.id, tol.id));
    assert.equal(after.pricePaise, 9200);
    assert.equal(after.density, 0.88);
  });
});

describe("customers", () => {
  test("a new customer is created Pending, and only a status-holder activates it", async () => {
    const ctx = await as(clerk);
    const made = await mod("customers").forms!.new(ctx, { name: "Shree Paints", city: "Pune", mobile: "9876543210", credit: "30" }, []);
    assert.ok(made.ok);
    const [row] = await loadCustomers(eq(customers.name, "Shree Paints"));
    assert.equal(partyStatus(row), "Pending");

    const refused = await mod("customers").actions!.activate(ctx, row.id, {});
    assert.ok(!refused.ok && refused.code === "not_permitted");

    const a = await as(admin);
    const ok = await mod("customers").actions!.activate(a, row.id, {});
    assert.ok(ok.ok);
    const [again] = await loadCustomers(eq(customers.id, row.id));
    assert.equal(partyStatus(again), "Active");
  });

  test("deactivating is the customer's own status, so the CRM sees it too", async () => {
    const a = await as(admin);
    const [row] = await loadCustomers(eq(customers.name, "Shree Paints"));
    await mod("customers").actions!.deactivate(a, row.id, {});
    const [c] = await db.select().from(customers).where(eq(customers.id, row.id));
    assert.equal(c.status, "deactivated");
    const [again] = await loadCustomers(eq(customers.id, row.id));
    assert.equal(partyStatus(again), "Deactive");
    await mod("customers").actions!.activate(a, row.id, {});
    const [c2] = await db.select().from(customers).where(eq(customers.id, row.id));
    assert.equal(c2.status, "active");
    const [p] = await db.select().from(erpCustomerProfiles).where(eq(erpCustomerProfiles.customerId, row.id));
    assert.equal(p.pendingActivation, false);
  });
});

describe("powers and godowns", () => {
  test("powers are given on the Access dialog, only by a platform administrator, and a given power reveals its column", async () => {
    const whole = { app: "erp", modules: moduleKeysForApp("erp"), role: "associate" as const };
    /* A manager is refused the powers: moving the control to the Admin
       Console did not lower the bar on it. */
    const manager = await makeUser("Ravi Manager", "manager");
    setTestUser(manager);
    const refused = await setAccess({ userId: clerk.id, grants: [whole], erpPowers: ["viewPurchaseMoney"] });
    assert.ok(!refused.ok);
    assert.equal((await as(clerk)).powers.has("viewPurchaseMoney"), false);

    /* And so is the ERP's own administrator. Admin of an app holds every
       power INSIDE it, but changing what somebody else can reach is the
       platform's — the Access dialog lives on the Admin Console and its save
       is a platform administrator's alone, or an app administrator could
       grant themselves admin of every other app from the same URL. */
    setTestUser(admin);
    const byErpAdmin = await setAccess({ userId: clerk.id, grants: [whole], erpPowers: ["viewPurchaseMoney"] });
    assert.ok(!byErpAdmin.ok, "an ERP administrator changed somebody's access");
    assert.equal((await as(clerk)).powers.has("viewPurchaseMoney"), false);

    const platform = await makeUser("Meera Platform", "admin", false);
    await db.insert(appAccess).values({ id: id("aca"), userId: platform.id, app: "admin", role: "admin" });
    setTestUser(platform);
    const given = await setAccess({ userId: clerk.id, grants: [whole], erpPowers: ["viewPurchaseMoney", "notAPower"] });
    assert.ok(given.ok, JSON.stringify(given));
    const c2 = await as(clerk);
    assert.deepEqual([...c2.powers], ["viewPurchaseMoney"], "an unknown power is dropped, never stored");
    const { spec } = await mod("rawMaterials").load(c2);
    assert.ok(spec.cols.some((x) => x.k === "price"));

    /* Taking the ERP away takes its powers with it, like its screens. */
    setTestUser(platform);
    const other = await makeUser("Sunil Other", "associate");
    await db.insert(appAccess).values({ id: id("aca"), userId: other.id, app: "crm", role: "associate" });
    await setAccess({ userId: other.id, grants: [whole, { app: "crm", modules: moduleKeysForApp("crm"), role: "associate" }], erpPowers: ["viewCost"] });
    assert.equal((await db.select().from(erpUserPowers).where(eq(erpUserPowers.userId, other.id))).length, 1);
    await setAccess({ userId: other.id, grants: [{ app: "crm", modules: moduleKeysForApp("crm"), role: "associate" }] });
    assert.equal((await db.select().from(erpUserPowers).where(eq(erpUserPowers.userId, other.id))).length, 0);
  });

  test("a screen's tabs are opened by holding the screen, and never granted apart from it", async () => {
    const t = await makeUser("Tara Transport", "associate");
    await db.insert(appModuleAccess).values({ id: id("ama"), userId: t.id, app: "erp", module: "erp.transport" });
    const ctx = await as(t);
    for (const k of ["transport", "pendingLr", "trackLr", "paidFreight"]) assert.ok(ctx.screens.has(k), k);
    assert.equal(ctx.screens.has("stock"), false);
    assert.equal(ctx.screens.has("rmStock"), false, "a tab of a screen they do not hold stays closed");
    await assert.rejects(requireErpWrite("rmStock"), ErpNotPermitted);
    await requireErpWrite("pendingLr");
  });

  test("the reserved godown cannot be switched off, and staff decide the working location", async () => {
    const a = await as(admin);
    const bad = await mod("godowns").actions!.toggle(a, "erpg_item_lost_record", {});
    assert.ok(!bad.ok);
    const ok = await mod("godowns").actions!.staff(a, "erpg_bhiwandi", { people: "Deepa Clerk" });
    assert.ok(ok.ok);
    const staff = await db.select().from(erpGodownStaff).where(eq(erpGodownStaff.godownId, "erpg_bhiwandi"));
    assert.deepEqual(staff.map((s) => s.userId), [clerk.id]);
    const c = await as(clerk);
    assert.deepEqual(c.assignedGodowns.map((g) => g.name), ["Bhiwandi"]);
    assert.equal(c.workingGodown?.name, "Bhiwandi");
    const n = await as(narrowed);
    assert.equal(n.workingGodown, null, "nobody assigned means no working location, not a guess");
  });
});
