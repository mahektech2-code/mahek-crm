import "server-only";
import { randomUUID } from "node:crypto";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import {
  catalogueExceptions,
  finishedGoods,
  productAliases,
  productBrands,
  productFormulations,
  products,
} from "@/db/schema";
import {
  BRANDS,
  EXCEPTIONS,
  EXCLUSIONS,
  FINISHED_GOODS,
  FORMULATIONS,
  SKUS,
  SOURCE_DISCREPANCIES,
  type SeedSku,
} from "@/db/catalogue-seed";
import { catalogueSlug, matchKey } from "../catalogue";

/* ---------------------------------------------------------------------------
 * The product-master import.
 *
 * Re-runnable, and that is the whole design. It matches on the canonical name
 * rather than on any ID, because the ID it was given is not sequential, not a
 * count, and not what legacy orders reference — they reference the description
 * text. Re-running updates what changed and reports it; it never inserts a
 * second row for a name it already carries.
 *
 * Two things it will not do:
 *
 *  - Pick a canonical ID for a name that several legacy IDs share. Choosing
 *    wrong silently reassigns a year of order history, so those SKUs land as
 *    `needs_canonical_id` and wait for a person.
 *  - Invent a price. The document has none, and a packing cost is not one.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export type ImportChange = {
  level: "formulation" | "brand" | "finished good" | "SKU" | "exception";
  name: string;
  action: "created" | "updated";
  /** Field-level detail for an update, so a re-run's report is readable. */
  fields?: string[];
};

export type ImportReport = {
  /** What the document holds, per level. */
  counted: Record<string, number>;
  created: number;
  updated: number;
  unchanged: number;
  changes: ImportChange[];
  /** Names that still need a human to choose which legacy ID is canonical. */
  needsCanonicalId: Array<{ name: string; externalIds: number[] }>;
  /** Rows deliberately not imported, and rows held back for want of a name. */
  held: Array<{ externalId: number; reason: string }>;
  excluded: Array<{ externalId: number; name: string; reason: string }>;
  /** Where the source document contradicts its own counts. */
  discrepancies: string[];
  /** Written, or a dry run that only reported. */
  applied: boolean;
};

type Diff = { fields: string[] };

/** Only the fields that actually differ, so "updated" means something. */
function diff<T extends Record<string, unknown>>(row: T, want: Partial<T>): Diff {
  const fields: string[] = [];
  for (const [k, v] of Object.entries(want)) {
    const before = row[k as keyof T];
    const same =
      Array.isArray(v) && Array.isArray(before)
        ? JSON.stringify(v) === JSON.stringify(before)
        : before === v;
    if (!same) fields.push(k);
  }
  return { fields };
}

/**
 * Imports the generated catalogue.
 *
 * `dryRun` reports exactly what a real run would change and writes nothing —
 * which is what the console shows before anybody presses the button, because
 * "213 SKUs, 4 updated" is a decision and "it ran" is not.
 */
export async function importCatalogue(
  opts: { dryRun?: boolean } = {},
): Promise<ImportReport> {
  const dryRun = opts.dryRun ?? false;
  const changes: ImportChange[] = [];
  let unchanged = 0;

  /* ---- level 1: formulations ---- */

  const existingForms = await db.select().from(productFormulations);
  const formBySlug = new Map(existingForms.map((f) => [f.slug, f]));
  const formIdByName = new Map<string, string>();

  for (const [i, f] of FORMULATIONS.entries()) {
    const slug = catalogueSlug(f.name);
    const row = formBySlug.get(slug);
    if (!row) {
      const newId = id("frm");
      formIdByName.set(f.name, newId);
      changes.push({ level: "formulation", name: f.name, action: "created" });
      if (!dryRun) {
        await db.insert(productFormulations).values({
          id: newId,
          name: f.name,
          slug,
          displayOrder: i,
        });
      }
      continue;
    }
    formIdByName.set(f.name, row.id);
    const d = diff(row, { name: f.name });
    if (d.fields.length) {
      changes.push({ level: "formulation", name: f.name, action: "updated", fields: d.fields });
      if (!dryRun) {
        await db
          .update(productFormulations)
          .set({ name: f.name, updatedAt: new Date() })
          .where(eq(productFormulations.id, row.id));
      }
    } else unchanged++;
  }

  /* ---- level 2: brand lines ---- */

  const existingBrands = await db.select().from(productBrands);
  const brandBySlug = new Map(existingBrands.map((b) => [b.slug, b]));
  const brandIdByName = new Map<string, string>();

  for (const [i, b] of BRANDS.entries()) {
    const slug = catalogueSlug(b.name);
    const formulationId = formIdByName.get(b.formulation);
    if (!formulationId) continue; // dry run before its formulation exists
    const row = brandBySlug.get(slug);
    if (!row) {
      const newId = id("brd");
      brandIdByName.set(b.name, newId);
      changes.push({ level: "brand", name: b.name, action: "created" });
      if (!dryRun) {
        await db
          .insert(productBrands)
          .values({ id: newId, name: b.name, slug, formulationId, displayOrder: i });
      }
      continue;
    }
    brandIdByName.set(b.name, row.id);
    const d = diff(row, { name: b.name, formulationId });
    if (d.fields.length) {
      changes.push({ level: "brand", name: b.name, action: "updated", fields: d.fields });
      if (!dryRun) {
        await db
          .update(productBrands)
          .set({ name: b.name, formulationId, updatedAt: new Date() })
          .where(eq(productBrands.id, row.id));
      }
    } else unchanged++;
  }

  /* ---- level 3: finished goods ---- */

  const existingGoods = await db.select().from(finishedGoods);
  const goodBySlug = new Map(existingGoods.map((g) => [g.slug, g]));
  const goodIdByName = new Map<string, string>();

  for (const [i, g] of FINISHED_GOODS.entries()) {
    const slug = catalogueSlug(g.name);
    const brandId = brandIdByName.get(g.brand);
    const formulationId = formIdByName.get(g.formulation);
    if (!brandId || !formulationId) continue;
    const row = goodBySlug.get(slug);
    if (!row) {
      const newId = id("fgd");
      goodIdByName.set(g.name, newId);
      changes.push({ level: "finished good", name: g.name, action: "created" });
      if (!dryRun) {
        await db.insert(finishedGoods).values({
          id: newId,
          name: g.name,
          slug,
          brandId,
          formulationId,
          millilitres: g.millilitres,
          displayOrder: i,
        });
      }
      continue;
    }
    goodIdByName.set(g.name, row.id);
    const d = diff(row, {
      name: g.name,
      brandId,
      formulationId,
      millilitres: g.millilitres,
    });
    if (d.fields.length) {
      changes.push({ level: "finished good", name: g.name, action: "updated", fields: d.fields });
      if (!dryRun) {
        await db
          .update(finishedGoods)
          .set({
            name: g.name,
            brandId,
            formulationId,
            millilitres: g.millilitres,
            updatedAt: new Date(),
          })
          .where(eq(finishedGoods.id, row.id));
      }
    } else unchanged++;
  }

  /* ---- level 4: SKUs, matched on the canonical name ---- */

  // Every product, including rows that predate the catalogue: a legacy row
  // whose name matches is ADOPTED rather than duplicated, because order lines
  // already point at its id and a second row would split that history in two.
  const existingSkus = await db.select().from(products);
  const skuByKey = new Map(existingSkus.map((p) => [matchKey(p.name), p]));

  const needsCanonicalId: ImportReport["needsCanonicalId"] = [];

  for (const [i, s] of SKUS.entries()) {
    const finishedGoodId = goodIdByName.get(s.finishedGood);
    const brandId = brandIdByName.get(s.brand);
    const formulationId = formIdByName.get(s.formulation);
    if (!finishedGoodId || !brandId || !formulationId) continue;

    if (s.duplicated) needsCanonicalId.push({ name: s.name, externalIds: s.externalIds });

    const want = skuValues(s, { finishedGoodId, brandId, formulationId, displayOrder: i });
    const row = skuByKey.get(matchKey(s.name));

    if (!row) {
      changes.push({ level: "SKU", name: s.name, action: "created" });
      if (!dryRun) await db.insert(products).values({ id: id("prd"), ...want });
      continue;
    }

    // A decision already made is never unmade by a re-run.
    //
    // `active` is set when the row is CREATED and never afterwards: whether a
    // SKU is on the order form is somebody's decision, and an import that
    // re-activated everything would quietly put every retired product back.
    const update = { ...want, active: undefined };
    delete (update as { active?: boolean }).active;

    // Likewise the canonical ID. If somebody has chosen which legacy ID this
    // name really is, the import must not reset the row to unresolved and
    // throw that choice away.
    const settled = row.status === "ok" && row.externalCode;
    const wanted = settled
      ? { ...update, status: "ok" as const, externalCode: row.externalCode }
      : update;

    const d = diff(row, wanted);
    if (d.fields.length) {
      changes.push({ level: "SKU", name: s.name, action: "updated", fields: d.fields });
      if (!dryRun) {
        await db
          .update(products)
          .set({ ...wanted, updatedAt: new Date() })
          .where(eq(products.id, row.id));
      }
    } else unchanged++;
  }

  /* ---- the rows that are not SKUs ---- */

  const existingExceptions = await db.select().from(catalogueExceptions);
  const exceptionByExternal = new Map(existingExceptions.map((e) => [e.externalId, e]));

  const exceptionRows = [
    ...EXCEPTIONS.map((e) => ({
      externalId: e.externalId,
      label: `${e.formulation} — ${e.millilitresPerCan / 1000} L`,
      reason: e.reason,
      kind: "held",
    })),
    ...EXCLUSIONS.map((e) => ({
      externalId: e.externalId,
      label: e.name,
      reason: e.reason,
      kind: "excluded",
    })),
  ];

  for (const e of exceptionRows) {
    const row = exceptionByExternal.get(e.externalId);
    if (!row) {
      changes.push({ level: "exception", name: `#${e.externalId} ${e.label}`, action: "created" });
      if (!dryRun) await db.insert(catalogueExceptions).values({ id: id("cex"), ...e });
      continue;
    }
    // A resolved exception is somebody's decision and stays resolved.
    if (row.resolvedAt) {
      unchanged++;
      continue;
    }
    const d = diff(row, e);
    if (d.fields.length) {
      changes.push({
        level: "exception",
        name: `#${e.externalId} ${e.label}`,
        action: "updated",
        fields: d.fields,
      });
      if (!dryRun) {
        await db.update(catalogueExceptions).set(e).where(eq(catalogueExceptions.id, row.id));
      }
    } else unchanged++;
  }

  return {
    counted: {
      formulations: FORMULATIONS.length,
      brands: BRANDS.length,
      "finished goods": FINISHED_GOODS.length,
      SKUs: SKUS.length,
    },
    created: changes.filter((c) => c.action === "created").length,
    updated: changes.filter((c) => c.action === "updated").length,
    unchanged,
    changes,
    needsCanonicalId,
    held: EXCEPTIONS.map((e) => ({ externalId: e.externalId, reason: e.reason })),
    excluded: EXCLUSIONS.map((e) => ({ externalId: e.externalId, name: e.name, reason: e.reason })),
    discrepancies: SOURCE_DISCREPANCIES,
    applied: !dryRun,
  };
}

/** One SKU's stored shape. The selling price is deliberately absent. */
function skuValues(
  s: SeedSku,
  refs: { finishedGoodId: string; brandId: string; formulationId: string; displayOrder: number },
) {
  return {
    name: s.name,
    rawName: s.rawName,
    // Null on purpose. `packSize` exists for rows whose size is separable from
    // their name; a SKU name carries its own size and packing, so filling this
    // in would render as "… - 5 Liter (6 Can/Box) - 5L". The structured size
    // is `millilitresPerCan`, which is what the maths reads anyway.
    packSize: null,
    // A single legacy ID is the code outright. Several is nobody's decision
    // to make automatically, so the code stays empty until one is chosen.
    externalCode: s.duplicated ? null : String(s.externalIds[0]),
    externalIds: s.externalIds,
    status: s.duplicated ? ("needs_canonical_id" as const) : ("ok" as const),
    // A SKU nobody can identify must not be orderable, or a telecaller picks
    // it and the order points at a product we cannot name.
    active: !s.duplicated,
    finishedGoodId: refs.finishedGoodId,
    brandId: refs.brandId,
    formulationId: refs.formulationId,
    packing: s.packing,
    millilitresPerCan: s.millilitresPerCan,
    cansPerBox: s.cansPerBox,
    packingCostPaise: s.packingCostPaise,
    weightGrams: s.weightGrams,
    weightBasis: s.weightBasis,
    displayOrder: refs.displayOrder,
  };
}

/* --------------------------------------------------- duplicate resolution */

/**
 * Settles one duplicated name: the chosen legacy ID becomes the SKU's code,
 * the losing ones become aliases pointing at it, and the SKU becomes
 * orderable. This is the step the import refuses to take on its own.
 */
export async function resolveCanonicalId(
  productId: string,
  externalId: number,
  userId: string,
): Promise<{ name: string; aliases: number[] }> {
  const [row] = await db.select().from(products).where(eq(products.id, productId));
  if (!row) throw new Error("No such product.");
  const candidates = row.externalIds ?? [];
  if (!candidates.includes(externalId)) {
    throw new Error("That legacy ID is not one of this product's candidates.");
  }

  const losers = candidates.filter((c) => c !== externalId);

  await db.transaction(async (tx) => {
    await tx
      .update(products)
      .set({
        externalCode: String(externalId),
        status: "ok",
        active: true,
        updatedAt: new Date(),
      })
      .where(eq(products.id, productId));

    // The losing IDs keep resolving to this product, because legacy rows that
    // carry them must still find something when they are read back.
    for (const loser of losers) {
      await tx
        .insert(productAliases)
        .values({
          id: id("pal"),
          productId,
          name: `${row.name} [#${loser}]`,
          externalId: loser,
          reason: `Duplicate legacy ID; #${externalId} was chosen as canonical`,
          createdById: userId,
        })
        .onConflictDoNothing();
    }
  });

  return { name: row.name, aliases: losers };
}

/** Every SKU still waiting on a canonical ID, with its candidates. */
export async function pendingCanonicalIds() {
  return db
    .select()
    .from(products)
    .where(eq(products.status, "needs_canonical_id"))
    .orderBy(products.name);
}

/** The held and excluded legacy rows, for the screen that lists them. */
export async function listCatalogueExceptions() {
  return db.select().from(catalogueExceptions).orderBy(catalogueExceptions.externalId);
}

/** Used by the console to show what an import would do before it does it. */
export async function catalogueCounts() {
  // Catalogue rows only: a product that predates the import is not part of
  // what the import is reporting on.
  const rows = await db
    .select({ id: products.id, status: products.status, active: products.active })
    .from(products)
    .where(isNotNull(products.finishedGoodId));
  return {
    total: rows.length,
    unresolved: rows.filter((r) => r.status === "needs_canonical_id").length,
    inactive: rows.filter((r) => !r.active).length,
  };
}
