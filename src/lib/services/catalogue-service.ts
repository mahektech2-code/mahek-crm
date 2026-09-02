import "server-only";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  catalogueExceptions,
  finishedGoods,
  productAliases,
  productBrands,
  productCategories,
  productFormulations,
  products,
} from "@/db/schema";

/* ---------------------------------------------------------------------------
 * What the Admin Console reads about the catalogue.
 *
 * Every screen here reads the database and nothing else — there is no shipped
 * copy of the catalogue in the console, the same way there is no copy of the
 * configuration. The document that seeded it is a starting point; the tables
 * are what is true, and this is how they are read.
 * ------------------------------------------------------------------------- */

export type SkuRow = {
  id: string;
  name: string;
  rawName: string | null;
  finishedGood: string | null;
  brand: string | null;
  formulation: string | null;
  packing: string | null;
  millilitresPerCan: number | null;
  cansPerBox: number;
  packingCostPaise: number | null;
  weightGrams: number | null;
  weightBasis: "box" | "can";
  sellingPricePaise: number | null;
  status: "ok" | "needs_canonical_id" | "held";
  externalCode: string | null;
  externalIds: number[] | null;
  active: boolean;
  /** How many order lines point at it — what makes deactivating it a decision. */
  timesOrdered: number;
  aliases: string[];
};

/** Everything a SKU list or a SKU detail needs, in one query. */
export async function listSkus(opts: {
  query?: string;
  formulationId?: string;
  brandId?: string;
  status?: "all" | "ok" | "needs_canonical_id" | "inactive";
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: SkuRow[]; total: number }> {
  const q = opts.query?.trim() ?? "";
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const filters = [isNotNull(products.finishedGoodId)];
  if (opts.formulationId) filters.push(eq(products.formulationId, opts.formulationId));
  if (opts.brandId) filters.push(eq(products.brandId, opts.brandId));
  if (opts.status === "ok") filters.push(eq(products.status, "ok"));
  if (opts.status === "needs_canonical_id") filters.push(eq(products.status, "needs_canonical_id"));
  if (opts.status === "inactive") filters.push(eq(products.active, false));
  if (q) {
    // The console's own search: substring across the name and the two levels
    // above it. Deliberately not the telecaller's fuzzy search — an admin
    // looking for a row wants what they typed, not what they might have meant.
    const like = `%${q}%`;
    filters.push(
      sql`(${products.name} ilike ${like}
        or coalesce(${products.rawName}, '') ilike ${like}
        or coalesce(${products.externalCode}, '') ilike ${like})`,
    );
  }

  const where = and(...filters);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(products)
    .where(where);

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      rawName: products.rawName,
      finishedGood: finishedGoods.name,
      brand: productBrands.name,
      formulation: productFormulations.name,
      packing: products.packing,
      millilitresPerCan: products.millilitresPerCan,
      cansPerBox: products.cansPerBox,
      packingCostPaise: products.packingCostPaise,
      weightGrams: products.weightGrams,
      weightBasis: products.weightBasis,
      sellingPricePaise: products.sellingPricePaise,
      status: products.status,
      externalCode: products.externalCode,
      externalIds: products.externalIds,
      active: products.active,
      // A SKU that a year of orders points at is not one to deactivate
      // casually, so the screen says how much history is behind it.
      timesOrdered: sql<number>`(
        select count(*)::int from interaction_product_lines l where l.product_id = ${products.id}
      )`,
      aliases: sql<string[]>`coalesce((
        select array_agg(a.name order by a.name) from product_aliases a where a.product_id = ${products.id}
      ), '{}')`,
    })
    .from(products)
    .leftJoin(finishedGoods, eq(finishedGoods.id, products.finishedGoodId))
    .leftJoin(productBrands, eq(productBrands.id, products.brandId))
    .leftJoin(productFormulations, eq(productFormulations.id, products.formulationId))
    .where(where)
    .orderBy(asc(products.displayOrder), asc(products.name))
    .limit(limit)
    .offset(offset);

  return { rows: rows as SkuRow[], total: Number(count) };
}

/** The three levels above a SKU, each with what hangs off it. */
export async function listHierarchy() {
  const [forms, brands, goods] = await Promise.all([
    db
      .select({
        id: productFormulations.id,
        name: productFormulations.name,
        active: productFormulations.active,
        notes: productFormulations.notes,
        brands: sql<number>`(select count(*)::int from product_brands b where b.formulation_id = ${productFormulations.id})`,
        skus: sql<number>`(select count(*)::int from products p where p.formulation_id = ${productFormulations.id})`,
      })
      .from(productFormulations)
      .orderBy(asc(productFormulations.displayOrder), asc(productFormulations.name)),
    db
      .select({
        id: productBrands.id,
        name: productBrands.name,
        active: productBrands.active,
        formulationId: productBrands.formulationId,
        formulation: productFormulations.name,
        goods: sql<number>`(select count(*)::int from finished_goods g where g.brand_id = ${productBrands.id})`,
        skus: sql<number>`(select count(*)::int from products p where p.brand_id = ${productBrands.id})`,
      })
      .from(productBrands)
      .leftJoin(productFormulations, eq(productFormulations.id, productBrands.formulationId))
      .orderBy(asc(productBrands.displayOrder), asc(productBrands.name)),
    db
      .select({
        id: finishedGoods.id,
        name: finishedGoods.name,
        active: finishedGoods.active,
        millilitres: finishedGoods.millilitres,
        brandId: finishedGoods.brandId,
        brand: productBrands.name,
        formulation: productFormulations.name,
        skus: sql<number>`(select count(*)::int from products p where p.finished_good_id = ${finishedGoods.id})`,
      })
      .from(finishedGoods)
      .leftJoin(productBrands, eq(productBrands.id, finishedGoods.brandId))
      .leftJoin(productFormulations, eq(productFormulations.id, finishedGoods.formulationId))
      .orderBy(asc(finishedGoods.displayOrder), asc(finishedGoods.name)),
  ]);
  return { formulations: forms, brands, goods };
}

/**
 * Every mix category, active and retired alike — this is management, not the
 * `where active` list a target is set against (`mixCategories()` in
 * `sales-target-service.ts`). The residual sorts last by its own
 * `display_order` of 99; nothing here special-cases it, the seed data does.
 */
export async function listCategories() {
  return db
    .select({
      id: productCategories.id,
      name: productCategories.name,
      isResidual: productCategories.isResidual,
      active: productCategories.active,
      displayOrder: productCategories.displayOrder,
      // What classifying INTO this category has actually done — a category
      // nobody has assigned a formulation to is real but empty, worth seeing
      // rather than guessing at from the name alone.
      formulations: sql<number>`(
        select count(*)::int from product_formulations f where f.category_id = ${productCategories.id}
      )`,
    })
    .from(productCategories)
    .orderBy(asc(productCategories.displayOrder), asc(productCategories.name));
}

/** The SKUs still waiting on somebody to choose which legacy ID is real. */
export async function listDuplicates() {
  return db
    .select({
      id: products.id,
      name: products.name,
      rawName: products.rawName,
      formulation: productFormulations.name,
      packing: products.packing,
      externalIds: products.externalIds,
    })
    .from(products)
    .leftJoin(productFormulations, eq(productFormulations.id, products.formulationId))
    .where(eq(products.status, "needs_canonical_id"))
    .orderBy(asc(products.name));
}

/** Held and excluded legacy rows, with whatever they became. */
export async function listExceptions() {
  return db
    .select({
      id: catalogueExceptions.id,
      externalId: catalogueExceptions.externalId,
      label: catalogueExceptions.label,
      reason: catalogueExceptions.reason,
      kind: catalogueExceptions.kind,
      resolvedAt: catalogueExceptions.resolvedAt,
      resolvedProduct: products.name,
    })
    .from(catalogueExceptions)
    .leftJoin(products, eq(products.id, catalogueExceptions.resolvedProductId))
    .orderBy(asc(catalogueExceptions.externalId));
}

/** Every alias, for the screen that explains why an old name still resolves. */
export async function listAliases() {
  return db
    .select({
      id: productAliases.id,
      name: productAliases.name,
      externalId: productAliases.externalId,
      reason: productAliases.reason,
      product: products.name,
      productId: products.id,
    })
    .from(productAliases)
    .leftJoin(products, eq(products.id, productAliases.productId))
    .orderBy(asc(productAliases.name));
}

/** The numbers along the top of the section. */
export async function catalogueSummary() {
  const [row] = await db
    .select({
      skus: sql<number>`count(*) filter (where ${products.finishedGoodId} is not null)::int`,
      orderable: sql<number>`count(*) filter (where ${products.finishedGoodId} is not null and ${products.active})::int`,
      unresolved: sql<number>`count(*) filter (where ${products.status} = 'needs_canonical_id')::int`,
      priced: sql<number>`count(*) filter (where ${products.sellingPricePaise} is not null)::int`,
      legacy: sql<number>`count(*) filter (where ${products.finishedGoodId} is null)::int`,
    })
    .from(products);

  const [levels] = await db
    .select({
      formulations: sql<number>`(select count(*)::int from product_formulations)`,
      brands: sql<number>`(select count(*)::int from product_brands)`,
      goods: sql<number>`(select count(*)::int from finished_goods)`,
      aliases: sql<number>`(select count(*)::int from product_aliases)`,
      held: sql<number>`(select count(*)::int from catalogue_exceptions where resolved_at is null)`,
    })
    .from(sql`(select 1) as one`);

  return { ...row, ...levels };
}
