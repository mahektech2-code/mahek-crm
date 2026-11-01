/**
 * The units master, against a real database through the real handlers.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches and
 * puts the three base units back, because every quantity box depends on them.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, erpUoms, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { erpAddUom } from "@/lib/actions/erp";
import { listUoms } from "@/lib/erp/uoms";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const mod = screenModule("uoms")!;

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;

async function ctx(u = admin) {
  setTestUser(u);
  return erpContext();
}

before(async () => {
  await db.execute(sql`truncate users, erp_uoms, audit_log restart identity cascade`);
  await db.insert(erpUoms).values([
    { id: "uom_kg", name: "Kg", measure: "weight", perBase: 1, builtIn: true },
    { id: "uom_litre", name: "Litre", measure: "volume", perBase: 1, builtIn: true },
    { id: "uom_pcs", name: "Pcs", measure: "count", perBase: 1, builtIn: true },
  ]);
  [admin, clerk] = await db
    .insert(users)
    .values([
      { id: id("usr"), name: "Kavita Admin", email: "kavita@uom.test", phone: "9820099101", passwordHash: "x", role: "admin", initials: "KA" },
      { id: id("usr"), name: "Ramesh Store", email: "ramesh@uom.test", phone: "9820099102", passwordHash: "x", role: "associate", initials: "RS" },
    ])
    .returning();
  await db.insert(appAccess).values([
    { id: id("aca"), userId: admin.id, app: "erp", role: "admin" },
    { id: id("aca"), userId: clerk.id, app: "erp", role: "associate" },
  ]);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("units of measure", () => {
  test("the screen adds a unit, refuses a second of the same name, and lists it", async () => {
    const c = await ctx();
    const made = await mod.forms!.new(c, { name: "Drum (200 L)", measure: "Volume — kept in litres", perBase: "200" }, []);
    assert.ok(made.ok, made.ok ? "" : made.error);
    const dup = await mod.forms!.new(c, { name: "drum (200 l)", measure: "Volume — kept in litres", perBase: "210" }, []);
    assert.equal(dup.ok, false);
    const load = await mod.load(c);
    const row = load.rows.find((r) => r.title === "Drum (200 L)")!;
    assert.equal(row.v.size, "200 L");
    assert.equal(load.rows.find((r) => r.title === "Kg")!.actions?.length ?? 0, 0, "a base unit offers nothing to change");
  });

  test("anybody in the ERP adds one from a quantity box; a base unit cannot be touched", async () => {
    await ctx(clerk);
    const res = await erpAddUom({ name: "Bag (25 kg)", measure: "weight", perBase: "25" });
    assert.ok(res.ok, res.ok ? "" : res.error);
    assert.equal(res.data.perBase, 25);
    const bad = await erpAddUom({ name: "Box", measure: "count", perBase: "0" });
    assert.equal(bad.ok, false);

    const c = await ctx();
    assert.equal((await mod.actions!.retire(c, "uom_kg", {})).ok, false);
    assert.equal((await mod.actions!.edit(c, "uom_litre", { name: "Litre", measure: "Volume — kept in litres", perBase: "2" })).ok, false);
  });

  test("editing and retiring a unit, audited, and restoring it", async () => {
    const c = await ctx();
    const [bag] = await db.select().from(erpUoms).where(eq(erpUoms.name, "Bag (25 kg)"));
    assert.ok((await mod.actions!.edit(c, bag.id, { name: "Bag (50 kg)", measure: "Weight — kept in kg", perBase: "50" })).ok);
    assert.ok((await mod.actions!.retire(c, bag.id, {})).ok);
    assert.equal((await listUoms()).find((u) => u.id === bag.id)!.active, false);
    assert.ok((await mod.actions!.restore(c, bag.id, {})).ok);
    const audit = (await db.execute(sql`select action from audit_log where entity_id = ${bag.id}`)) as unknown as { action: string }[];
    assert.deepEqual(audit.map((a) => a.action).sort(), ["erp.uom.add", "erp.uom.edit", "erp.uom.restore", "erp.uom.retire"]);
  });
});
