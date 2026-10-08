/**
 * ERP material duties — who may request a material, raise its PO, approve that
 * PO and test its lots — against a real database, through the real handlers.
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
import { appAccess, erpDesignations, erpGodowns, erpMaterialDuties, erpPurchaseOrders, erpRawMaterials, erpSuppliers, erpTests, erpUserDesignations, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { approvedPo } from "@/lib/erp/po-fixture";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, level: "associate" | "manager" | "admin") {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\s/g, ".")}@duties.test`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: level,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "erp", role: level });
  return u;
}

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
let priya: typeof users.$inferSelect;
let rakesh: typeof users.$inferSelect;
let tester: typeof users.$inferSelect;
let qualityId = "";
const TODAY = "2026-10-08";

before(async () => {
  await db.execute(
    sql`truncate users, erp_raw_materials, erp_suppliers, erp_inward, erp_tests, erp_purchases, erp_requisitions, erp_quotations, erp_purchase_orders, erp_po_lines, erp_user_powers, erp_user_designations, erp_material_duties, erp_designations, audit_log restart identity cascade`,
  );
  admin = await makeUser("Kavita Admin", "admin");
  priya = await makeUser("Priya Store", "associate");
  rakesh = await makeUser("Rakesh Office", "associate");
  tester = await makeUser("Anjali Lab", "associate");
  qualityId = id("erpd");
  await db.insert(erpDesignations).values({ id: qualityId, name: "Quality tester" });
  await db.insert(erpUserDesignations).values({ userId: tester.id, designationId: qualityId });
  await db.insert(erpSuppliers).values({ id: "sup_a", name: "Asian Solvents", partyCode: "AS" });
  await db.insert(erpRawMaterials).values([
    { id: "rm_x", serialNo: 1, name: "Mix Xylene", code: "XY", unit: "Kg", materialType: "Chemical", density: 0.86, testingList: ["Smell"], purchaseMethod: "direct", preferredSupplierId: "sup_a" },
    { id: "rm_can", serialNo: 2, name: "Naked 20 Liter", code: "N20", unit: "Unit", materialType: "Can", testingList: [], purchaseMethod: "direct", preferredSupplierId: "sup_a" },
  ]);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

const setDuties = async (who: typeof users.$inferSelect, values: Record<string, string>) =>
  mod("rawMaterials").forms!.duties(await as(who), values, [], "rm_x");

describe("setting who does what", () => {
  test("only an ERP administrator opens and saves a material's duties", async () => {
    assert.equal(await mod("rawMaterials").formLoaders!.duties(await as(priya), "rm_x"), null);
    const refused = await setDuties(priya, { requestPeople: "Priya Store" });
    assert.ok(!refused.ok && refused.code === "not_permitted");
    const form = await mod("rawMaterials").formLoaders!.duties(await as(admin), "rm_x");
    assert.ok(form?.header.some((f) => f.k === "testDepartments"), "a chemical has a tester");
    const can = await mod("rawMaterials").formLoaders!.duties(await as(admin), "rm_can");
    assert.ok(!can?.header.some((f) => f.k.startsWith("test")), "a can is not tested");
  });

  test("the record says who holds each duty, and that an empty one is open", async () => {
    assert.ok((await setDuties(admin, { requestPeople: "Priya Store", approvePeople: "Rakesh Office", testDepartments: "Quality tester" })).ok);
    const { rows } = await mod("rawMaterials").load(await as(priya));
    const f = Object.fromEntries(rows.find((r) => r.id === "rm_x")!.fields!.map((x) => [x.l, x.v]));
    assert.equal(f["Who can request it"], "Priya Store");
    assert.equal(f["Who approves the PO"], "Rakesh Office");
    assert.equal(f["Who tests it"], "Quality tester");
    assert.match(f["Who can raise the PO"], /not set/);
    assert.equal((await db.select().from(erpMaterialDuties)).length, 3);
  });
});

describe("the duties are enforced", () => {
  test("only the named requester is offered the item and may raise it", async () => {
    const items = async (u: typeof users.$inferSelect) =>
      Object.values(((await mod("requisitions").load(await as(u))).spec.newForm!.header.find((f) => f.k === "item")!.optsBy!.map) as Record<string, string[]>).flat();
    assert.ok((await items(priya)).includes("Mix Xylene"));
    assert.ok(!(await items(rakesh)).includes("Mix Xylene"));
    assert.ok((await items(rakesh)).includes("Naked 20 Liter"), "an unconfigured item stays open");
    const raise = async (u: typeof users.$inferSelect) =>
      mod("requisitions").forms!.new(await as(u), { date: TODAY, requiredBy: TODAY, department: "Production", godown: "Bhiwandi", type: "Chemical", item: "Mix Xylene", required: "10", priority: "Medium" }, []);
    const no = await raise(rakesh);
    assert.ok(!no.ok && no.fieldErrors?.[0].field === "item" && /set to Priya Store/.test(no.fieldErrors[0].message));
    assert.ok((await raise(priya)).ok);
  });

  test("a named approver approves without the power; an unnamed power holder may not", async () => {
    const p = await approvedPo("Asian Solvents", [{ item: "Mix Xylene", quantity: 10 }]);
    await db.update(erpPurchaseOrders).set({ status: "Pending approval", approvedAt: null, createdById: admin.id }).where(eq(erpPurchaseOrders.id, p.poId));
    await db.execute(sql`insert into erp_user_powers (user_id, power) values (${priya.id}, 'approvePurchaseOrder')`);
    const { rows } = await mod("purchaseOrders").load(await as(priya));
    assert.match(rows.find((r) => r.id === p.poId)!.actions!.find((a) => a.id === "approve")!.why!, /set to Rakesh Office/);
    const refused = await mod("purchaseOrders").actions!.approve(await as(priya), p.poId, {});
    assert.ok(!refused.ok && refused.code === "not_permitted");
    assert.ok((await mod("purchaseOrders").actions!.approve(await as(rakesh), p.poId, {})).ok);
  });

  test("only the named department records a chemical's test", async () => {
    const [gd] = await db.select().from(erpGodowns).where(eq(erpGodowns.name, "Bhiwandi"));
    const tid = id("tst");
    await db.insert(erpTests).values({ id: tid, prNumber: 5001, rawMaterialId: "rm_x", godownId: gd.id, tests: ["Smell"], testingDate: TODAY });
    const save = async (u: typeof users.$inferSelect) => mod("testing").forms!.edit(await as(u), { tester: u.name, date: TODAY, smell: "Good" }, [], tid);
    const no = await save(priya);
    assert.ok(!no.ok && no.code === "not_permitted");
    const { rows } = await mod("testing").load(await as(priya));
    assert.match(rows.find((r) => r.id === tid)!.actions!.find((a) => a.id === "edit")!.why!, /set to Quality tester/);
    assert.ok((await save(tester)).ok);
  });

  test("clearing a duty opens it again", async () => {
    assert.ok((await setDuties(admin, {})).ok);
    assert.equal((await db.select().from(erpMaterialDuties)).length, 0);
    const r = await mod("requisitions").forms!.new(await as(rakesh), { date: TODAY, requiredBy: TODAY, department: "Production", godown: "Bhiwandi", type: "Chemical", item: "Mix Xylene", required: "5", priority: "Medium" }, []);
    assert.ok(r.ok, JSON.stringify(r));
  });
});
