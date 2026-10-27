/**
 * EDITING A SKU END TO END, from the Admin Console's Catalogue.
 *
 *   A RENAME KEEPS THE OLD NAME ANSWERING. The old name becomes an alias in the
 *   same write, so history that names the SKU as text still finds it; and the
 *   catalogue import, which still carries the old name, finds the SKU through
 *   that alias and neither reverts the rename nor makes a second SKU.
 *
 *   ONE STRING, ONE SKU. A name another SKU has, or answers to, is refused.
 *
 *   THE PACKING IS THE ERP'S ROW, under the ERP's rules: the can use is a Can or
 *   Drum, the box one of the box types.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, erpProductPacking, erpRawMaterials, productAliases, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { importCatalogue } from "@/lib/services/catalogue-import";
import { renameSku, updateSku, updateSkuPacking } from "@/lib/actions/catalogue";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let admin: typeof users.$inferSelect;
let sku: typeof products.$inferSelect;
let other: typeof products.$inferSelect;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});
after(async () => {
  setTestUser(null);
  await db.$client.end();
});
beforeEach(async () => {
  await db.execute(sql`
    truncate table erp_product_packing, erp_raw_materials, product_aliases, products, finished_goods, product_brands,
      product_formulations, catalogue_exceptions, audit_log, app_access, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  await importCatalogue();
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Pritesh Admin", email: `admin-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", role: "admin", initials: "PA" })
    .returning();
  admin = row;
  await db.insert(appAccess).values({ id: id("aca"), userId: admin.id, app: "admin", role: "admin" });
  [sku, other] = await db.select().from(products).where(eq(products.status, "ok")).orderBy(products.name).limit(2);
  setTestUser(admin);
});

describe("renaming a SKU", () => {
  test("the new name is the SKU's, and the old one becomes an alias that still finds it", async () => {
    const r = await renameSku(sku.id, "  Renamed   Thinner - 5 Liter (6 can/box) ");
    assert.ok(r.ok, JSON.stringify(r));
    const [after] = await db.select().from(products).where(eq(products.id, sku.id));
    assert.equal(after.name, "Renamed Thinner - 5 Liter (6 Can/Box)", "normalised as every name is");
    const aliases = await db.select().from(productAliases).where(eq(productAliases.productId, sku.id));
    assert.ok(aliases.some((a) => a.name === sku.name), "the old name answers for it");
  });

  test("a re-import finds the renamed SKU through its old name, and leaves the new name alone", async () => {
    assert.ok((await renameSku(sku.id, "Renamed Thinner X")).ok);
    const before = (await db.select().from(products)).length;
    await importCatalogue();
    assert.equal((await db.select().from(products)).length, before, "no second SKU under the old name");
    const [after] = await db.select().from(products).where(eq(products.id, sku.id));
    assert.equal(after.name, "Renamed Thinner X");
  });

  test("renaming back to an old name takes that alias over rather than doubling it", async () => {
    assert.ok((await renameSku(sku.id, "Renamed Thinner X")).ok);
    assert.ok((await renameSku(sku.id, sku.name)).ok);
    const [after] = await db.select().from(products).where(eq(products.id, sku.id));
    assert.equal(after.name, sku.name);
    const aliases = (await db.select().from(productAliases).where(eq(productAliases.productId, sku.id))).map((a) => a.name);
    assert.ok(!aliases.includes(sku.name), "its own name is not also its alias");
    assert.ok(aliases.includes("Renamed Thinner X"));
  });

  test("a name another SKU has, or answers to, is refused", async () => {
    const taken = await renameSku(sku.id, other.name.toUpperCase());
    assert.ok(!taken.ok && taken.code === "conflict", JSON.stringify(taken));
    await db.insert(productAliases).values({ id: id("pal"), productId: other.id, name: "Spoken For" });
    const answering = await renameSku(sku.id, "spoken  for");
    assert.ok(!answering.ok && answering.code === "conflict", JSON.stringify(answering));
    const [after] = await db.select().from(products).where(eq(products.id, sku.id));
    assert.equal(after.name, sku.name);
  });
});

describe("the rest of the row", () => {
  test("the packing label and the pack size are edited", async () => {
    const r = await updateSku(sku.id, { packing: "4 Can/Box", millilitresPerCan: 4000 });
    assert.ok(r.ok, JSON.stringify(r));
    const [after] = await db.select().from(products).where(eq(products.id, sku.id));
    assert.equal(after.packing, "4 Can/Box");
    assert.equal(after.millilitresPerCan, 4000);
  });

  test("the ERP packing is written to the ERP's row, under its rules", async () => {
    const can = id("rm");
    const solvent = id("rm");
    await db.insert(erpRawMaterials).values([
      { id: can, serialNo: 1, name: "Packing Material 5 Liter", unit: "Unit", materialType: "Can" },
      { id: solvent, serialNo: 2, name: "Toluene", unit: "Litre", materialType: "Chemical" },
    ] as (typeof erpRawMaterials.$inferInsert)[]);

    const ok = await updateSkuPacking(sku.id, { canUseMaterialId: can, emptyBoxesRequired: 1, boxType: "Empty Box 5 Liter", boxRatePaise: 2500 });
    assert.ok(ok.ok, JSON.stringify(ok));
    const [pk] = await db.select().from(erpProductPacking).where(eq(erpProductPacking.productId, sku.id));
    assert.equal(pk.canUseMaterialId, can);
    assert.equal(pk.boxType, "Empty Box 5 Liter");
    assert.equal(pk.emptyBoxesRequired, 1);
    assert.equal(Number(pk.boxRatePaise), 2500);

    const notACan = await updateSkuPacking(sku.id, { canUseMaterialId: solvent, emptyBoxesRequired: 0, boxType: null, boxRatePaise: null });
    assert.ok(!notACan.ok, "a chemical is not a can");
    const badBox = await updateSkuPacking(sku.id, { canUseMaterialId: can, emptyBoxesRequired: 0, boxType: "Shoebox", boxRatePaise: null });
    assert.ok(!badBox.ok, "not one of the box types");
  });
});
