/**
 * ERP departments — who raises which purchase requirements and sees which, department by
 * department, against a real database through the real handlers:
 *
 *   Mixing & Blending  chemical requirement → test the inward chemical → SFG
 *   Refilling          can requirement → FG filling
 *   Packing            empty box + packing stationery requirements → packing
 *   Production Head    all of the above
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, erpDesignations, erpRawMaterials, erpRequisitions, erpSuppliers, erpUserDesignations, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { erpNavCounts } from "@/lib/erp/counts";
import type { FieldSpec } from "@/lib/erp/ui";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = "2026-10-07";

async function makeUser(name: string, level: "associate" | "manager" | "admin", designation?: string) {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\s/g, ".")}@dept.test`,
      phone: String(9830000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: level,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  /* A whole-ERP grant: what a person may open is not the subject here, what they may ask to be bought is. */
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "erp", role: level });
  if (designation) await db.insert(erpUserDesignations).values({ userId: u.id, designationId: designation });
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

let mixer: typeof users.$inferSelect;
let refiller: typeof users.$inferSelect;
let packer: typeof users.$inferSelect;
let head: typeof users.$inferSelect;
let admin: typeof users.$inferSelect;
let store: typeof users.$inferSelect;

const raise = async (u: typeof users.$inferSelect, department: string, type: string, item: string, qty = "10") =>
  mod("requisitions").forms!.new(await as(u), { date: TODAY, requiredBy: "2026-10-20", department, godown: "Bhiwandi", type, item, required: qty, priority: "Medium" }, []);

before(async () => {
  await db.execute(
    sql`truncate users, erp_designations, erp_raw_materials, erp_suppliers, erp_inward, erp_tests, erp_purchases, erp_rm_entries, erp_requisitions, erp_quotations, erp_purchase_orders, erp_po_lines, erp_user_powers, erp_godown_staff, erp_user_settings, audit_log restart identity cascade`,
  );
  await db.insert(erpDesignations).values([
    { id: "erpd_mixing", name: "Mixing & Blending", level: "associate", department: "mixing" },
    { id: "erpd_refilling", name: "Refilling", level: "associate", department: "refilling" },
    { id: "erpd_packing", name: "Packing", level: "associate", department: "packing" },
    { id: "erpd_prodhead", name: "Production Head", level: "manager", department: "head" },
    { id: "erpd_store", name: "Purchase / store", level: "associate" },
  ]);
  mixer = await makeUser("Manoj Mixer", "associate", "erpd_mixing");
  refiller = await makeUser("Rekha Refill", "associate", "erpd_refilling");
  packer = await makeUser("Pooja Packer", "associate", "erpd_packing");
  head = await makeUser("Harish Head", "manager", "erpd_prodhead");
  store = await makeUser("Sunil Store", "associate", "erpd_store");
  admin = await makeUser("Kavita Admin", "admin");
  await db.insert(erpSuppliers).values([{ id: "sup_a", name: "Asian Solvents", partyCode: "AS" }]);
  await db.insert(erpRawMaterials).values([
    { id: "rm_tol", serialNo: 1, name: "Toluene", unit: "Litre", materialType: "Chemical", density: 0.87, testingList: ["Smell"], purchaseMethod: "quotation" },
    { id: "rm_can", serialNo: 2, name: "1 L Tin Can", unit: "Unit", materialType: "Can", testingList: [], purchaseMethod: "direct", preferredSupplierId: "sup_a" },
    { id: "rm_drum", serialNo: 3, name: "210 L Drum", unit: "Unit", materialType: "Drum", testingList: [], purchaseMethod: "direct" },
    { id: "rm_box", serialNo: 4, name: "5 L Box", unit: "Unit", materialType: "Box", testingList: [], purchaseMethod: "direct", preferredSupplierId: "sup_a" },
    { id: "rm_tape", serialNo: 5, name: "Packing Tape", unit: "Unit", materialType: "Stationary", testingList: [], purchaseMethod: "direct" },
  ]);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("who is in which department", () => {
  test("the department comes with the designation, and an administrator is in none", async () => {
    assert.equal((await as(mixer)).department, "mixing");
    assert.equal((await as(packer)).department, "packing");
    assert.equal((await as(head)).department, "head");
    assert.equal((await as(store)).department, null, "a designation outside production narrows nothing");
    assert.equal((await as(admin)).department, null);
  });
});

describe("each department raises its own requirements", () => {
  test("Mixing & Blending raises a chemical requirement, and nothing else", async () => {
    const ok = await raise(mixer, "Mixing & Blending", "Chemical", "Toluene", "400");
    assert.ok(ok.ok, ok.ok ? "" : ok.error);
    const box = await raise(mixer, "Mixing & Blending", "Box", "5 L Box");
    assert.ok(!box.ok && box.fieldErrors?.[0].field === "type");
    const other = await raise(mixer, "Packing", "Box", "5 L Box");
    assert.ok(!other.ok && other.fieldErrors?.[0].field === "department", "not for another department");
  });

  test("Refilling raises can and drum requirements", async () => {
    assert.ok((await raise(refiller, "Refilling", "Can", "1 L Tin Can", "500")).ok);
    assert.ok((await raise(refiller, "Refilling", "Drum", "210 L Drum", "20")).ok);
    const chem = await raise(refiller, "Refilling", "Chemical", "Toluene");
    assert.ok(!chem.ok && chem.fieldErrors?.[0].field === "type");
  });

  test("Packing raises empty boxes and packing stationery", async () => {
    assert.ok((await raise(packer, "Packing", "Box", "5 L Box", "300")).ok);
    assert.ok((await raise(packer, "Packing", "Stationary", "Packing Tape", "40")).ok);
    const can = await raise(packer, "Packing", "Can", "1 L Tin Can");
    assert.ok(!can.ok && can.fieldErrors?.[0].field === "type");
  });

  test("the Production Head raises for every department, each for its own categories", async () => {
    assert.ok((await raise(head, "Mixing & Blending", "Chemical", "Toluene", "50")).ok);
    assert.ok((await raise(head, "Refilling", "Can", "1 L Tin Can", "60")).ok);
    assert.ok((await raise(head, "Packing", "Stationary", "Packing Tape", "5")).ok);
    const wrong = await raise(head, "Packing", "Chemical", "Toluene");
    assert.ok(!wrong.ok && wrong.fieldErrors?.[0].field === "type");
    assert.ok((await raise(head, "Production Head", "Box", "5 L Box", "5")).ok, "or under their own name, for any of it");
    const office = await raise(head, "Office", "Box", "5 L Box");
    assert.ok(!office.ok && office.fieldErrors?.[0].field === "department");
  });

  test("somebody in no department picks one of the four teams, and the team decides the category", async () => {
    assert.ok((await raise(store, "Mixing & Blending", "Chemical", "Toluene", "70")).ok);
    assert.ok((await raise(store, "Production Head", "Box", "5 L Box", "70")).ok);
    for (const old of ["Production", "Godown / Store", "Office", "Maintenance"]) {
      const r = await raise(store, old, "Box", "5 L Box");
      assert.ok(!r.ok && r.fieldErrors?.[0].field === "department", `${old} is not one of the four`);
    }
    const wrong = await raise(store, "Refilling", "Box", "5 L Box");
    assert.ok(!wrong.ok && wrong.fieldErrors?.[0].field === "type");
  });

  test("the form offers a department only its own, already chosen, with only its categories", async () => {
    const { spec } = await mod("requisitions").load(await as(packer));
    const f = (k: string) => spec.newForm!.header.find((x) => x.k === k) as FieldSpec;
    assert.deepEqual(f("department").opts, ["Packing"]);
    assert.equal(spec.newForm!.init?.department, "Packing");
    assert.equal(f("department").readOnly, true);
    /* Every item offered to Packing is one of its two categories, across both — one requirement lists them all. */
    const offered = spec.newForm!.line!.find((x) => x.k === "item")!.optsBy!.map.Packing;
    const typeOf = spec.newForm!.data!.typeOf as Record<string, string>;
    assert.ok(offered.length);
    assert.deepEqual([...new Set(offered.map((i) => typeOf[i]))].sort(), ["Box", "Stationary"]);
    const headForm = (await mod("requisitions").load(await as(head))).spec.newForm!;
    assert.deepEqual(headForm.header.find((x) => x.k === "department")!.opts, ["Mixing & Blending", "Refilling", "Packing", "Production Head"]);
    assert.equal(headForm.init?.department, undefined, "the head chooses");
    const storeForm = (await mod("requisitions").load(await as(store))).spec.newForm!;
    const dept = storeForm.header.find((x) => x.k === "department")!;
    assert.deepEqual(dept.opts, ["Mixing & Blending", "Refilling", "Packing", "Production Head"], "no reference list beside the four");
    const refilling = storeForm.line!.find((x) => x.k === "item")!.optsBy!.map["Refilling"];
    const storeTypes = storeForm.data!.typeOf as Record<string, string>;
    assert.deepEqual([...new Set(refilling.map((i) => storeTypes[i]))].sort(), ["Can", "Drum"]);
  });
});

describe("each department sees its own requirements", () => {
  const items = async (u: typeof users.$inferSelect) => (await mod("requisitions").load(await as(u))).rows.map((r) => `${r.v.department}:${r.v.item}`).sort();

  test("a department's list is its own department's work", async () => {
    const mine = await items(mixer);
    assert.ok(mine.length > 0);
    assert.ok(mine.every((x) => x.startsWith("Mixing & Blending:")), mine.join(", "));
    assert.ok((await items(packer)).every((x) => x.startsWith("Packing:")));
  });

  test("the head, the store and an administrator see every department", async () => {
    const all = await items(head);
    for (const d of ["Mixing & Blending", "Refilling", "Packing"]) assert.ok(all.some((x) => x.startsWith(`${d}:`)), d);
    assert.equal((await items(admin)).length, (await db.select().from(erpRequisitions)).length);
    assert.equal((await items(store)).length, (await db.select().from(erpRequisitions)).length);
  });

  test("a department cannot cancel another department's requirement", async () => {
    const [mix] = await db.select().from(erpRequisitions).where(sql`department = 'Mixing & Blending'`).limit(1);
    const r = await mod("requisitions").actions!.cancel(await as(packer), mix.id, { reason: "not ours" });
    assert.ok(!r.ok && r.code === "not_permitted");
    const ok = await mod("requisitions").actions!.cancel(await as(head), mix.id, { reason: "ordered twice" });
    assert.ok(ok.ok);
  });

  test("the sidebar badge counts only the department's own requirements", async () => {
    const mixing = (await erpNavCounts(await as(mixer))).requisitions ?? 0;
    const everybody = (await erpNavCounts(await as(admin))).requisitions ?? 0;
    assert.ok(mixing < everybody, `${mixing} < ${everybody}`);
  });
});
