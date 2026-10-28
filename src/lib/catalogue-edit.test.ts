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
import { appAccess, erpProductPacking, erpRawMaterials, finishedGoods, productAliases, productBrands, productFormulations, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { importCatalogue } from "@/lib/services/catalogue-import";
import { addAlias, moveBrandLine, moveFinishedGood, removeAlias, renameLevel, renameSku, setLevelActive, updateSku, updateSkuPacking } from "@/lib/actions/catalogue";
import { impactReport } from "@/lib/impact/registry";

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

/*
 * A CHANGE HIGHER UP THE TREE REACHES EVERYTHING UNDER IT.
 *
 * The formulation is stored on the brand, each finished good and each SKU, and
 * the ERP's FG filling reads it off the finished good — so a move that wrote
 * only the brand would leave the ERP filling the old tree. And the handset
 * pulls SKUs by their own `updated_at`, so a rename that touched only the
 * brand row would never reach a phone.
 */
describe("the tree above a SKU", () => {
  const skusOf = (col: "brandId" | "finishedGoodId", v: string) => db.select().from(products).where(eq(products[col], v));

  test("moving a brand line carries its finished goods and SKUs to the new formulation", async () => {
    const [brand] = await db.select().from(productBrands).where(eq(productBrands.id, sku.brandId!));
    const [to] = await db.select().from(productFormulations).where(sql`${productFormulations.id} <> ${brand.formulationId}`).limit(1);
    const before = await skusOf("brandId", brand.id);
    const r = await moveBrandLine(brand.id, to.id);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal((await db.select().from(productBrands).where(eq(productBrands.id, brand.id)))[0].formulationId, to.id);
    const goods = await db.select().from(finishedGoods).where(eq(finishedGoods.brandId, brand.id));
    assert.ok(goods.length && goods.every((g) => g.formulationId === to.id), "every finished good follows — the ERP's FG filling reads this");
    const after = await skusOf("brandId", brand.id);
    assert.ok(after.length && after.every((p) => p.formulationId === to.id), "every SKU follows");
    assert.ok(after.every((p) => p.updatedAt > before.find((b) => b.id === p.id)!.updatedAt), "and is touched, so the next handset pull carries it");
    assert.equal(r.ok && r.data.skus, after.length);
    assert.equal((await moveBrandLine(brand.id, to.id)).ok, false, "moving to where it already is says so");
  });

  test("moving a finished good takes the new brand line and that brand's formulation", async () => {
    const [good] = await db.select().from(finishedGoods).where(eq(finishedGoods.id, sku.finishedGoodId!));
    const [to] = await db.select().from(productBrands).where(sql`${productBrands.id} <> ${good.brandId} and ${productBrands.formulationId} <> ${good.formulationId}`).limit(1);
    const r = await moveFinishedGood(good.id, to.id);
    assert.ok(r.ok, JSON.stringify(r));
    const [g] = await db.select().from(finishedGoods).where(eq(finishedGoods.id, good.id));
    assert.equal(g.brandId, to.id);
    assert.equal(g.formulationId, to.formulationId);
    const after = await skusOf("finishedGoodId", good.id);
    assert.ok(after.length && after.every((p) => p.brandId === to.id && p.formulationId === to.formulationId));
  });

  test("renaming or retiring a level touches every SKU under it, for the handsets", async () => {
    const brandId = sku.brandId!;
    const before = await skusOf("brandId", brandId);
    assert.ok((await renameLevel("brand", brandId, "Renamed Brand Line")).ok);
    const renamed = await skusOf("brandId", brandId);
    assert.ok(renamed.every((p) => p.updatedAt > before.find((b) => b.id === p.id)!.updatedAt));
    assert.ok((await setLevelActive("brand", brandId, false)).ok);
    const retired = await skusOf("brandId", brandId);
    assert.ok(retired.every((p) => p.updatedAt > renamed.find((b) => b.id === p.id)!.updatedAt));
  });
});

/*
 * EVERY DEPLOY RUNS THE IMPORT, so an edit that does not survive it does not
 * survive the next deploy. It used to write the seed back over packing, cans
 * per box, weight, packing cost and where a SKU or finished good is filed, and
 * a renamed level stopped matching its slug and was created again.
 */
describe("a console edit survives the deploy-time import", () => {
  test("a SKU's edited packing and filing are kept", async () => {
    const want = sku.cansPerBox === 2 ? 3 : 2;
    assert.ok((await updateSku(sku.id, { cansPerBox: want, packingCostPaise: 4321 })).ok);
    const report = await importCatalogue();
    const [after] = await db.select().from(products).where(eq(products.id, sku.id));
    assert.equal(after.cansPerBox, want, "the import did not put the seed's back");
    assert.equal(after.packingCostPaise, 4321);
    assert.ok(report.kept >= 1 && report.changes.some((c) => c.action === "kept" && c.name === sku.name), "and it says so");
  });

  test("a renamed brand line is found under its old name, not created again", async () => {
    const brandsBefore = (await db.select().from(productBrands)).length;
    assert.ok((await renameLevel("brand", sku.brandId!, "Renamed Brand Line")).ok);
    await importCatalogue();
    assert.equal((await db.select().from(productBrands)).length, brandsBefore, "no second brand under the seed's name");
    const [b] = await db.select().from(productBrands).where(eq(productBrands.id, sku.brandId!));
    assert.equal(b.name, "Renamed Brand Line", "and the rename stands");
    const [after] = await db.select().from(products).where(eq(products.id, sku.id));
    assert.equal(after.brandId, sku.brandId, "its SKUs were not filed back under a new copy");
  });

  test("a moved brand line stays moved", async () => {
    const [brand] = await db.select().from(productBrands).where(eq(productBrands.id, sku.brandId!));
    const [to] = await db.select().from(productFormulations).where(sql`${productFormulations.id} <> ${brand.formulationId}`).limit(1);
    assert.ok((await moveBrandLine(brand.id, to.id)).ok);
    await importCatalogue();
    assert.equal((await db.select().from(productBrands).where(eq(productBrands.id, brand.id)))[0].formulationId, to.id);
    assert.ok((await db.select().from(finishedGoods).where(eq(finishedGoods.brandId, brand.id))).every((g) => g.formulationId === to.id));
    assert.ok((await db.select().from(products).where(eq(products.brandId, brand.id))).every((p) => p.formulationId === to.id));
  });

  test("a row nobody edited still takes the seed's correction", async () => {
    await db.update(products).set({ packingCostPaise: 1 }).where(eq(products.id, other.id));
    await importCatalogue();
    const [after] = await db.select().from(products).where(eq(products.id, other.id));
    assert.notEqual(after.packingCostPaise, 1, "an unedited row is still the seed's to correct");
  });
});

describe("removing an alias", () => {
  test("says what stops resolving, and is refused until that is confirmed", async () => {
    assert.ok((await addAlias(sku.id, "Old Spelling Thinner")).ok);
    const [alias] = await db.select().from(productAliases).where(eq(productAliases.name, "Old Spelling Thinner"));
    const bare = await removeAlias(alias.id);
    assert.equal(!bare.ok && bare.code, "validation", "a removal nobody confirmed is refused");
    const report = await impactReport("admin-catalogue-alias", alias.id);
    assert.ok(report.ok, report.ok ? "" : report.error);
    assert.equal(report.data.confirmWord, "Old Spelling Thinner");
    assert.ok(report.data.items.some((i) => i.label === "product search on the order form" && i.note?.includes(sku.name)));
    const done = await removeAlias(alias.id, { typed: "old spelling thinner", fingerprint: report.data.fingerprint });
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal((await db.select().from(productAliases).where(eq(productAliases.id, alias.id))).length, 0);
  });
});
