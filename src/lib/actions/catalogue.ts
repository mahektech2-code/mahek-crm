"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  catalogueExceptions,
  erpProductPacking,
  erpRawMaterials,
  finishedGoods,
  productAliases,
  productBrands,
  productCategories,
  productFormulations,
  products,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { requireCapability } from "@/lib/access-control";
import { canonicalName, finishedGoodNameFor, matchKey, newSkuProblems, type PackingKind } from "@/lib/catalogue";
import {
  importCatalogue,
  resolveCanonicalId,
  type ImportReport,
} from "@/lib/services/catalogue-import";
import { err as fail, ok, type Result } from "@/lib/result";
import { ADMIN } from "@/lib/admin-routes";
import type { PackingImportReport } from "@/lib/erp/packing-import";
import { BOX_TYPES } from "@/lib/erp/refs";

/* ---------------------------------------------------------------------------
 * Writes to the catalogue.
 *
 * All of them are manager-or-admin, checked HERE and not merely disabled in
 * the console — a catalogue is what every order line points at, and a
 * disabled button is not an access control.
 *
 * Two rules run through the whole file. Nothing that history refers to is
 * deleted: a retired SKU deactivates, a retired brand deactivates, and both
 * keep resolving. And a SKU's NAME is never edited, because the name is the
 * join key legacy orders and bills match on — renaming one would silently
 * detach every historical line that carried the old spelling. A name that
 * needs to change becomes a new SKU plus an alias.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** Throws for anybody without config.write, and records the denial. */
async function actor() {
  await requireCapability("config.write");
  return requireUser();
}

async function audit(
  userId: string,
  action: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
) {
  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId: userId,
    action,
    entityType: "product",
    entityId,
    beforeState: (before ?? null) as never,
    afterState: (after ?? null) as never,
  });
}

/**
 * Drops the cached copies of the screens that read the catalogue.
 *
 * Deliberately unable to fail the write it follows. This runs AFTER the row is
 * committed, so a cache hint that throws — which it does outside a request
 * scope, as in the integration tests — must not turn a save that happened into
 * an error message saying it did not.
 */
function refresh() {
  try {
    revalidatePath(ADMIN.home, "layout");
    revalidatePath("/crm");
  } catch {
    // No request scope, so nothing is cached to drop.
  }
}

/* ------------------------------------------------------------------ import */

/**
 * Runs the product-master import. A dry run reports what would change and
 * writes nothing, which is what the console shows before anybody commits —
 * "213 SKUs, 4 updated" is a decision, and "it ran" is not.
 */
export async function runCatalogueImport(dryRun: boolean): Promise<Result<ImportReport>> {
  try {
    const user = await actor();
    const report = await importCatalogue({ dryRun });
    if (!dryRun) {
      await audit(user.id, "catalogue.import", null, null, {
        created: report.created,
        updated: report.updated,
        unchanged: report.unchanged,
      });
      refresh();
    }
    return ok(
      report,
      dryRun
        ? `Dry run: ${report.created} would be created, ${report.updated} updated, ${report.unchanged} unchanged.`
        : `${report.created} created, ${report.updated} updated, ${report.unchanged} unchanged.`,
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : "The import did not run.");
  }
}

/**
 * The ERP packing — Can Use, empty boxes, box type, box rate — from the Mahek
 * Plus "My Products" tab, with the packing raw materials it names. The rules
 * are in `lib/erp/packing-plan.ts`; a dry run writes nothing.
 */
export async function runPackingImport(dryRun: boolean): Promise<Result<PackingImportReport>> {
  try {
    const user = await actor();
    const { importPackingFromMahekPlus, packingImportSummary } = await import("@/lib/erp/packing-import");
    const report = await importPackingFromMahekPlus({ dryRun, userId: user.id });
    if (!dryRun) {
      await audit(user.id, "catalogue.packing_import", null, null, {
        materialsCreated: report.materialsCreated.length,
        packingSet: report.packingSet.length,
        withCanUse: report.withCanUse,
      });
      refresh();
    }
    return ok(report, `${dryRun ? "Dry run: " : ""}${packingImportSummary(report)}.`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "The packing import did not run.");
  }
}

/* --------------------------------------------------- duplicate resolution */

/**
 * Settles which legacy Product ID a duplicated name really is. The losing IDs
 * become aliases pointing at the same SKU, so a legacy row carrying one still
 * resolves, and the SKU becomes orderable.
 */
export async function chooseCanonicalId(
  productId: string,
  externalId: number,
): Promise<Result<{ name: string; aliases: number[] }>> {
  try {
    const user = await actor();
    const [before] = await db.select().from(products).where(eq(products.id, productId));
    if (!before) return fail("No such product.", "not_found");
    if (before.status !== "needs_canonical_id") {
      return fail("That product's legacy ID has already been settled.", "conflict");
    }

    const result = await resolveCanonicalId(productId, externalId, user.id);
    await audit(user.id, "catalogue.canonicalId", productId,
      { status: before.status, externalIds: before.externalIds },
      { externalCode: String(externalId), aliases: result.aliases },
    );
    refresh();
    return ok(
      result,
      result.aliases.length === 1
        ? `#${externalId} is canonical. #${result.aliases[0]} is now an alias pointing at it.`
        : `#${externalId} is canonical. ${result.aliases.length} IDs are now aliases pointing at it.`,
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That did not resolve.");
  }
}

/* --------------------------------------------------------------- SKU edits */

const skuPatch = z.object({
  /** Paise. Null clears it, which is different from zero — see the registry. */
  sellingPricePaise: z.number().int().min(0).nullable().optional(),
  packingCostPaise: z.number().int().min(0).nullable().optional(),
  weightGrams: z.number().int().min(0).nullable().optional(),
  weightBasis: z.enum(["box", "can"]).optional(),
  cansPerBox: z.number().int().min(1).max(500).optional(),
  millilitresPerCan: z.number().int().min(1).optional(),
  packing: z.string().trim().min(1).max(60).optional(),
  displayOrder: z.number().int().min(0).optional(),
  finishedGoodId: z.string().optional(),
});

export async function updateSku(
  productId: string,
  patch: z.input<typeof skuPatch>,
): Promise<Result<{ name: string }>> {
  try {
    const user = await actor();
    const parsed = skuPatch.safeParse(patch);
    if (!parsed.success) return fail("Those values are not valid.");

    const [before] = await db.select().from(products).where(eq(products.id, productId));
    if (!before) return fail("No such product.", "not_found");

    const values: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };

    // Moving a SKU to another finished good moves it to that good's brand and
    // formulation too. Leaving the three to be set independently is how a SKU
    // ends up filed under a brand its finished good does not belong to.
    if (parsed.data.finishedGoodId) {
      const [good] = await db
        .select()
        .from(finishedGoods)
        .where(eq(finishedGoods.id, parsed.data.finishedGoodId));
      if (!good) return fail("No such finished good.", "not_found");
      values.brandId = good.brandId;
      values.formulationId = good.formulationId;
    }

    await db.update(products).set(values as never).where(eq(products.id, productId));
    await audit(user.id, "catalogue.sku", productId, before, values);
    refresh();
    return ok({ name: before.name }, "Saved.");
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That did not save.");
  }
}

/**
 * RENAMING A SKU KEEPS ITS OLD NAME ANSWERING.
 *
 * The name is the join key: legacy orders, bills and price lists name a SKU as
 * TEXT. That is why it was never editable — a rename would have detached every
 * line carrying the old spelling. What makes it safe is the alias: the old name
 * is written to `product_aliases` in the same transaction, and every reader that
 * resolves a name reads aliases too, so the history keeps finding this row. The
 * catalogue import matches aliases as well and leaves a renamed SKU's name alone
 * (`catalogue-import.ts`), so a re-run neither reverts the rename nor creates a
 * second SKU under the old name.
 */
export async function renameSku(productId: string, name: string): Promise<Result<{ name: string }>> {
  try {
    const user = await actor();
    const clean = canonicalName(name);
    if (clean.length < 3) return fail("A SKU name needs at least three characters.");

    const [before] = await db.select().from(products).where(eq(products.id, productId));
    if (!before) return fail("No such product.", "not_found");
    if (clean === before.name) return ok({ name: clean }, "Nothing changed.");

    // One string, one SKU: the new name may not be another SKU's name or answer for one.
    const key = matchKey(clean);
    const others = await db.select({ name: products.name }).from(products).where(ne(products.id, productId));
    const taken = others.find((o) => matchKey(o.name) === key);
    if (taken) return fail(`"${taken.name}" is already another SKU.`, "conflict");
    const aliases = await db.select().from(productAliases);
    const answering = aliases.find((a) => a.productId !== productId && matchKey(a.name) === key);
    if (answering) return fail(`"${answering.name}" already answers for another SKU — remove that alias first.`, "conflict");

    await db.transaction(async (tx) => {
      /* The new name stops being one of its own aliases — it is the name now. */
      const own = aliases.filter((a) => a.productId === productId && matchKey(a.name) === key).map((a) => a.id);
      if (own.length) await tx.delete(productAliases).where(inArray(productAliases.id, own));
      await tx
        .insert(productAliases)
        .values({ id: newId("pal"), productId, name: before.name, reason: `Renamed to ${clean}`, createdById: user.id })
        .onConflictDoNothing();
      await tx.update(products).set({ name: clean, updatedAt: new Date() }).where(eq(products.id, productId));
    });
    await audit(user.id, "catalogue.rename", productId, { name: before.name }, { name: clean });
    refresh();
    return ok({ name: clean }, `Renamed. "${before.name}" still finds it.`);
  } catch (e) {
    const message = e instanceof Error && /products_name/.test(e.message) ? "Another SKU already has that name." : e instanceof Error ? e.message : "That did not save.";
    return fail(message);
  }
}

const packingPatch = z.object({
  /** Null: no can or drum set. */
  canUseMaterialId: z.string().nullable(),
  emptyBoxesRequired: z.number().int().min(0).max(500),
  boxType: z.string().nullable(),
  boxRatePaise: z.number().int().min(0).nullable(),
});

/**
 * A SKU's ERP packing — the can or drum it is filled into and the box it ships
 * in — edited from the catalogue. The same rules as ERP → Products → Edit
 * packing, and the same row, so the two editors cannot disagree.
 */
export async function updateSkuPacking(
  productId: string,
  patch: z.input<typeof packingPatch>,
): Promise<Result<undefined>> {
  try {
    const user = await actor();
    const parsed = packingPatch.safeParse(patch);
    if (!parsed.success) return fail("Those packing values are not valid.");
    const v = parsed.data;
    const [p] = await db.select({ id: products.id }).from(products).where(eq(products.id, productId));
    if (!p) return fail("No such product.", "not_found");
    if (v.canUseMaterialId) {
      const [m] = await db
        .select({ id: erpRawMaterials.id })
        .from(erpRawMaterials)
        .where(and(eq(erpRawMaterials.id, v.canUseMaterialId), inArray(erpRawMaterials.materialType, ["Can", "Drum"])));
      if (!m) return fail("The can use must be a raw material of type Can or Drum.");
    }
    if (v.boxType && !BOX_TYPES.includes(v.boxType)) return fail("That is not one of the box types.");

    const [before] = await db.select().from(erpProductPacking).where(eq(erpProductPacking.productId, productId));
    const values = { ...v, updatedAt: new Date(), updatedById: user.id };
    await db.insert(erpProductPacking).values({ productId, ...values }).onConflictDoUpdate({ target: erpProductPacking.productId, set: values });
    await audit(user.id, "catalogue.packing", productId, before ?? null, v);
    refresh();
    return ok(undefined, "Saved.");
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That did not save.");
  }
}

/**
 * Retires a SKU, or brings it back.
 *
 * Never a delete: historical order lines point at this row, and a product
 * nobody can resolve turns a year of orders into rows that name nothing. It
 * leaves the order form and stays readable everywhere else.
 */
export async function setSkuActive(
  productId: string,
  active: boolean,
): Promise<Result<{ name: string }>> {
  try {
    const user = await actor();
    const [before] = await db.select().from(products).where(eq(products.id, productId));
    if (!before) return fail("No such product.", "not_found");
    if (active && before.status === "needs_canonical_id") {
      return fail(
        "This SKU shares its name with more than one legacy ID. Choose the canonical one first, or an order taken against it points at a product we cannot identify.",
        "rule_violation",
      );
    }

    await db
      .update(products)
      .set({ active, updatedAt: new Date() })
      .where(eq(products.id, productId));
    await audit(user.id, "catalogue.skuActive", productId, { active: before.active }, { active });
    refresh();
    return ok(
      { name: before.name },
      active
        ? `${before.name} is back on the order form.`
        : `${before.name} has left the order form. Past orders still name it.`,
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That did not save.");
  }
}

/* ------------------------------------------------- the three levels above */

const levels = {
  formulation: productFormulations,
  brand: productBrands,
  good: finishedGoods,
  category: productCategories,
} as const;

export async function renameLevel(
  level: keyof typeof levels,
  rowId: string,
  name: string,
): Promise<Result<{ name: string }>> {
  try {
    const user = await actor();
    const clean = canonicalName(name);
    if (clean.length < 2) return fail("A name needs at least two characters.");

    const table = levels[level];
    const [before] = await db.select().from(table).where(eq(table.id, rowId));
    if (!before) return fail("No such row.", "not_found");

    // The slug follows the name, and it is unique — two brands cannot become
    // the same brand by being renamed into each other.
    await db
      .update(table)
      .set({ name: clean, slug: matchKey(clean), updatedAt: new Date() } as never)
      .where(eq(table.id, rowId));
    await audit(user.id, `catalogue.${level}`, rowId, { name: before.name }, { name: clean });
    refresh();
    return ok({ name: clean }, `Renamed to ${clean}.`);
  } catch (e) {
    // A slug collision is the interesting failure, so it is named rather than
    // reported as "something went wrong".
    const message = e instanceof Error && /slug/.test(e.message)
      ? "Another row already answers to that name."
      : e instanceof Error
        ? e.message
        : "That did not save.";
    return fail(message);
  }
}

export async function setLevelActive(
  level: keyof typeof levels,
  rowId: string,
  active: boolean,
): Promise<Result<undefined>> {
  try {
    const user = await actor();
    const table = levels[level];
    const [before] = await db.select().from(table).where(eq(table.id, rowId));
    if (!before) return fail("No such row.", "not_found");
    // The residual catches every product nobody has classified — retiring it
    // would silently drop that catch-all out of every mix-target screen,
    // which reads categories `where active` (see `mixCategories()`).
    if (!active && "isResidual" in before && before.isResidual) {
      return fail(
        "The residual category catches everything unclassified — it cannot be retired.",
        "rule_violation",
      );
    }

    await db
      .update(table)
      .set({ active, updatedAt: new Date() } as never)
      .where(eq(table.id, rowId));
    await audit(user.id, `catalogue.${level}Active`, rowId, { active: before.active }, { active });
    refresh();
    return ok(
      undefined,
      active
        ? `${before.name} is active again.`
        : `${before.name} is retired. The SKUs underneath it keep working — retire those separately if that is what you meant.`,
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That did not save.");
  }
}

export async function setFormulationNotes(
  rowId: string,
  notes: string,
): Promise<Result<undefined>> {
  try {
    const user = await actor();
    await db
      .update(productFormulations)
      .set({ notes: notes.trim() || null, updatedAt: new Date() })
      .where(eq(productFormulations.id, rowId));
    await audit(user.id, "catalogue.formulationNotes", rowId, null, { notes });
    refresh();
    return ok(undefined, "Saved.");
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That did not save.");
  }
}

/**
 * WHETHER A MIX TARGET MAY BE AIMED AT THIS LIQUID.
 *
 * Not the same act as retiring it, and the console draws the two separately for
 * that reason. `active` decides whether its SKUs are offered on an order at all;
 * this decides whether a manager setting next month's mix sees it in the list he
 * picks three bands from. On this book most of the nineteen formulations are real
 * and are not things to aim a month at, so without this the list was nineteen
 * alphabetical rows with nothing marking the three that matter.
 *
 * IT CHANGES NO TARGET THAT EXISTS. A band already set on a liquid is read by id
 * and never asks this question — the same discipline `active` keeps — because a
 * target somebody typed is a decision, and withdrawing a liquid from the offer
 * list in the middle of a month must not silently drop a share out of somebody's
 * score. The message says so, because "removed from mix targets" is a sentence a
 * manager would otherwise read as exactly that.
 *
 * The residual is refused, the same shape as retiring it is refused and for the
 * same reason: value from a product naming no formulation has to land somewhere
 * or the shares stop adding up. A CHECK constraint says it too — this is the half
 * that can explain itself.
 */
export async function setFormulationOfferedForMix(
  rowId: string,
  offered: boolean,
): Promise<Result<undefined>> {
  try {
    const user = await actor();
    const [before] = await db
      .select()
      .from(productFormulations)
      .where(eq(productFormulations.id, rowId));
    if (!before) return fail("No such formulation.", "not_found");
    if (!offered && before.isResidual) {
      return fail(
        "Other is where value from an unclassified product lands — take it off the list and the shares stop adding up.",
        "rule_violation",
      );
    }

    await db
      .update(productFormulations)
      .set({ offerForMix: offered, updatedAt: new Date() })
      .where(eq(productFormulations.id, rowId));
    await audit(
      user.id,
      "catalogue.formulationOfferedForMix",
      rowId,
      { offerForMix: before.offerForMix },
      { offerForMix: offered },
    );
    refresh();
    return ok(
      undefined,
      offered
        ? `${before.name} can be given a mix target again.`
        : `${before.name} is off the mix target list. Targets already set on it are untouched and go on scoring.`,
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That did not save.");
  }
}

/**
 * Move a formulation up or down the offer list.
 *
 * `display_order` has been on that table since it was created and was read by
 * NOTHING — the one list that needed it ordered by name — so an admin who put the
 * three liquids that matter at the top watched them stay in the alphabet.
 *
 * It SWAPS with its neighbour rather than renumbering the table, so the write is
 * two rows whatever the list is worth, and it works on a book where every row
 * still reads 0: the neighbour is chosen by the SAME ordering the offer list
 * reads — `display_order` then name — so the first move of an untouched list
 * swaps two alphabetical neighbours, which is exactly what pressing up on the
 * second row means. Renumbering from scratch would be one statement per row and a
 * different answer depending on which ties the planner broke.
 */
export async function moveFormulation(
  rowId: string,
  direction: "up" | "down",
): Promise<Result<undefined>> {
  try {
    const user = await actor();
    /* The list as the offer screen orders it, so "the one above" means the row
       the admin can actually see above it. Residual first in that sort is
       deliberate there and irrelevant here — it is pinned by its own flag. */
    const all = await db
      .select({
        id: productFormulations.id,
        name: productFormulations.name,
        order: productFormulations.displayOrder,
      })
      .from(productFormulations)
      .orderBy(asc(productFormulations.displayOrder), asc(productFormulations.name));

    const at = all.findIndex((r) => r.id === rowId);
    if (at === -1) return fail("No such formulation.", "not_found");
    const swapWith = all[direction === "up" ? at - 1 : at + 1];
    /* Already at the end. Not a failure — the button is simply drawn on a row
       that cannot move, and refusing loudly would read as a fault. */
    if (!swapWith) return ok(undefined, `${all[at].name} is already at the ${direction === "up" ? "top" : "bottom"}.`);

    /*
     * EQUAL ORDERS ARE THE ORDINARY CASE, not the edge one: every row defaults
     * to 0, so on an untouched book both numbers are the same and swapping them
     * would change nothing at all while reporting success. The pair is written as
     * two distinct numbers around the position, which is what actually separates
     * them, and the rest of the list keeps whatever it had.
     */
    const mine = all[at].order;
    const theirs = swapWith.order;
    const [lower, upper] = mine === theirs ? [theirs - 1, theirs] : [theirs, mine];
    const moved = direction === "up" ? lower : upper;
    const displaced = direction === "up" ? upper : lower;

    await db.transaction(async (tx) => {
      await tx
        .update(productFormulations)
        .set({ displayOrder: moved, updatedAt: new Date() })
        .where(eq(productFormulations.id, rowId));
      await tx
        .update(productFormulations)
        .set({ displayOrder: displaced, updatedAt: new Date() })
        .where(eq(productFormulations.id, swapWith.id));
    });

    await audit(user.id, "catalogue.formulationMoved", rowId, { displayOrder: mine }, { displayOrder: moved });
    refresh();
    return ok(undefined, `${all[at].name} moved ${direction}.`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That did not save.");
  }
}

/* ------------------------------------------------------------- categories */

/**
 * A new mix category — a row, not a fourth string typed into a screen. It
 * sorts after whatever already exists and before the residual, which stays
 * pinned last at `display_order` 99 by the seed data
 * (`drizzle/0069_salesman_targets.sql`). Classifying formulations into it is
 * separate work, done from the catalogue's Duplicates-style screens.
 */
export async function createCategory(name: string): Promise<Result<{ id: string; name: string }>> {
  try {
    const user = await actor();
    const clean = canonicalName(name);
    if (clean.length < 2) return fail("A name needs at least two characters.");

    const [{ next }] = await db
      .select({
        next: sql<number>`coalesce(max(${productCategories.displayOrder}), 0) + 1`,
      })
      .from(productCategories)
      .where(eq(productCategories.isResidual, false));

    const id = newId("pcat");
    await db.insert(productCategories).values({
      id,
      name: clean,
      slug: matchKey(clean),
      isResidual: false,
      active: true,
      displayOrder: next,
    });
    await audit(user.id, "catalogue.categoryCreated", id, null, { name: clean });
    refresh();
    return ok({ id, name: clean }, `"${clean}" is now a mix category.`);
  } catch (e) {
    const message = e instanceof Error && /slug/.test(e.message)
      ? "Another category already answers to that name."
      : e instanceof Error
        ? e.message
        : "That did not save.";
    return fail(message);
  }
}

/**
 * Moves a category up or down against its neighbours. The residual never
 * takes part — it sorts last by convention, not by position in this list.
 */
export async function moveCategory(
  categoryId: string,
  direction: "up" | "down",
): Promise<Result<undefined>> {
  try {
    const user = await actor();
    const rows = await db
      .select({ id: productCategories.id, displayOrder: productCategories.displayOrder })
      .from(productCategories)
      .where(eq(productCategories.isResidual, false))
      .orderBy(asc(productCategories.displayOrder), asc(productCategories.name));

    const index = rows.findIndex((r) => r.id === categoryId);
    if (index === -1) return fail("That category cannot be reordered.", "not_found");

    const neighborIndex = direction === "up" ? index - 1 : index + 1;
    if (neighborIndex < 0 || neighborIndex >= rows.length) {
      return fail(direction === "up" ? "Already first." : "Already last.");
    }

    const row = rows[index];
    const neighbor = rows[neighborIndex];
    await db.transaction(async (tx) => {
      await tx
        .update(productCategories)
        .set({ displayOrder: neighbor.displayOrder, updatedAt: new Date() })
        .where(eq(productCategories.id, row.id));
      await tx
        .update(productCategories)
        .set({ displayOrder: row.displayOrder, updatedAt: new Date() })
        .where(eq(productCategories.id, neighbor.id));
    });
    await audit(
      user.id,
      "catalogue.categoryOrder",
      row.id,
      { displayOrder: row.displayOrder },
      { displayOrder: neighbor.displayOrder },
    );
    refresh();
    return ok(undefined, "Reordered.");
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That did not save.");
  }
}

/* --------------------------------------------------------------- aliases */

/**
 * Teaches the catalogue a name it does not answer to yet — a spelling a
 * customer or a legacy file still uses. Aliases are read on the way in and
 * never offered on an order form.
 */
export async function addAlias(
  productId: string,
  name: string,
): Promise<Result<{ name: string }>> {
  try {
    const user = await actor();
    const clean = canonicalName(name);
    if (clean.length < 2) return fail("An alias needs at least two characters.");

    const [target] = await db.select().from(products).where(eq(products.id, productId));
    if (!target) return fail("No such product.", "not_found");
    if (matchKey(clean) === matchKey(target.name)) {
      return fail("That is the product's own name, so it already resolves.");
    }

    // A name that is already some other SKU's name cannot become an alias, or
    // one string would resolve to two products.
    const clash = await db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(eq(products.name, clean));
    if (clash.length) {
      return fail(`"${clean}" is already the name of another SKU.`, "conflict");
    }

    await db.insert(productAliases).values({
      id: newId("pal"),
      productId,
      name: clean,
      reason: "Added in the Admin Console",
      createdById: user.id,
    });
    await audit(user.id, "catalogue.alias", productId, null, { name: clean });
    refresh();
    return ok({ name: clean }, `"${clean}" now resolves to ${target.name}.`);
  } catch (e) {
    const message =
      e instanceof Error && /product_aliases_name_key/.test(e.message)
        ? "Something already answers to that name."
        : e instanceof Error
          ? e.message
          : "That did not save.";
    return fail(message);
  }
}

export async function removeAlias(aliasId: string): Promise<Result<undefined>> {
  try {
    const user = await actor();
    const [before] = await db.select().from(productAliases).where(eq(productAliases.id, aliasId));
    if (!before) return fail("No such alias.", "not_found");
    await db.delete(productAliases).where(eq(productAliases.id, aliasId));
    await audit(user.id, "catalogue.aliasRemoved", before.productId, before, null);
    refresh();
    return ok(undefined, `"${before.name}" no longer resolves to anything.`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That did not save.");
  }
}

/* ------------------------------------------------------------ exceptions */

/**
 * Names a held legacy row, which is what turns it into a SKU somebody can
 * order. The import refuses to invent a name for these — a product with no
 * name is not a product — so this is the only way out of the held list.
 */
export async function nameHeldRow(
  exceptionId: string,
  input: {
    name: string;
    finishedGoodId: string;
    packing: string;
    cansPerBox: number;
    millilitresPerCan: number;
  },
): Promise<Result<{ productId: string }>> {
  try {
    const user = await actor();
    const [row] = await db
      .select()
      .from(catalogueExceptions)
      .where(eq(catalogueExceptions.id, exceptionId));
    if (!row) return fail("No such held row.", "not_found");
    if (row.resolvedAt) return fail("That row has already been named.", "conflict");
    if (row.kind === "excluded") {
      return fail(
        "That row was excluded on purpose — it is packaging material, not something anybody can order.",
        "rule_violation",
      );
    }

    const clean = canonicalName(input.name);
    if (clean.length < 3) return fail("A product needs a real name.");

    const existing = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.name, clean));
    if (existing.length) return fail(`"${clean}" is already a SKU.`, "conflict");

    const [good] = await db
      .select()
      .from(finishedGoods)
      .where(eq(finishedGoods.id, input.finishedGoodId));
    if (!good) return fail("No such finished good.", "not_found");

    const productId = newId("prd");
    await db.transaction(async (tx) => {
      await tx.insert(products).values({
        id: productId,
        name: clean,
        rawName: row.label,
        externalCode: String(row.externalId),
        externalIds: [row.externalId],
        finishedGoodId: good.id,
        brandId: good.brandId,
        formulationId: good.formulationId,
        packing: input.packing,
        cansPerBox: input.cansPerBox,
        millilitresPerCan: input.millilitresPerCan,
        weightBasis: input.cansPerBox > 1 ? "box" : "can",
        status: "ok",
        active: true,
      });
      await tx
        .update(catalogueExceptions)
        .set({ resolvedProductId: productId, resolvedAt: new Date(), resolvedById: user.id })
        .where(eq(catalogueExceptions.id, exceptionId));
    });

    await audit(user.id, "catalogue.heldNamed", productId, row, { name: clean });
    refresh();
    return ok({ productId }, `#${row.externalId} is now "${clean}" and can be ordered.`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That did not save.");
  }
}

/* ------------------------------------------------------------ a new SKU */

/** An existing level by id, or a new one by what it is called. */
type LevelPick = { id: string } | { name: string };

export type NewSkuInput = {
  formulation: LevelPick;
  brand: LevelPick;
  /** An existing finished good, or a new one of this size (and, optionally, this name). */
  good: { id: string } | { millilitres: number; name?: string };
  name: string;
  packingKind: PackingKind;
  cansPerBox: number;
  millilitresPerCan: number;
  packingCostPaise: number | null;
  weightGrams: number | null;
  sellingPricePaise: number | null;
  externalCode: number | null;
  aliases: string[];
  /** Offered on the order form straight away, or kept back until somebody puts it on. */
  active: boolean;
};

const levelPick = z.union([
  z.object({ id: z.string().min(1) }),
  z.object({ name: z.string().trim().min(2).max(120) }),
]);

const newSkuSchema = z.object({
  formulation: levelPick,
  brand: levelPick,
  good: z.union([
    z.object({ id: z.string().min(1) }),
    z.object({
      millilitres: z.number().int().min(1).max(250_000),
      name: z.string().trim().max(160).optional(),
    }),
  ]),
  name: z.string(),
  packingKind: z.enum(["box", "loose", "drum"]),
  cansPerBox: z.number(),
  millilitresPerCan: z.number(),
  packingCostPaise: z.number().nullable(),
  weightGrams: z.number().nullable(),
  sellingPricePaise: z.number().nullable(),
  externalCode: z.number().nullable(),
  aliases: z.array(z.string()).max(20),
  active: z.boolean(),
});

/** A unique-index violation, turned into the sentence somebody can act on. */
function clashSentence(e: unknown): string | null {
  const m = e instanceof Error ? e.message : "";
  if (/product_formulations_slug_key/.test(m)) return "A formulation already answers to that name — pick it from the list.";
  if (/product_brands_slug_key/.test(m)) return "A brand line already answers to that name — pick it from the list.";
  if (/finished_goods_slug_key/.test(m)) return "A finished good already answers to that name — pick it from the list.";
  if (/products_name_key/.test(m)) return "Another SKU already has that name.";
  if (/product_aliases_name_key/.test(m)) return "One of the other names already resolves to a product.";
  return null;
}

/**
 * ADDS A SKU BY HAND, and whatever it hangs from that does not exist yet.
 *
 * The import is how the catalogue was filled; this is how a product launched
 * after it gets in without editing a document and re-running a parser. One
 * transaction writes the formulation, brand line and finished good where the
 * console asked for new ones, the SKU, and its other names — a SKU filed under
 * a brand that failed to save is the state the hierarchy exists to prevent.
 *
 * The levels must chain: a brand picked from the list must belong to the
 * formulation, and a finished good to the brand, because `updateSku` makes the
 * same promise and a SKU filed across two branches reads as two products.
 * The name is the join key, so it is checked against every SKU name AND every
 * alias by match key — "Nano 5L" and "nano 5 l" are the same string to an
 * order line. A legacy Product ID already carried by another SKU is refused
 * for the same reason.
 */
export async function createSku(input: NewSkuInput): Promise<Result<{ productId: string; name: string }>> {
  try {
    const user = await actor();
    const parsed = newSkuSchema.safeParse(input);
    if (!parsed.success) return fail("Those values are not valid.");
    const d = parsed.data;

    const problems = newSkuProblems(d);
    const first = Object.values(problems)[0];
    if (first) return fail(first);

    const name = canonicalName(d.name);
    const key = matchKey(name);
    const aliases = d.aliases.map(canonicalName);

    /* The join key, by match key, against every SKU and every alias. */
    const [names, aliasRows] = await Promise.all([
      db.select({ name: products.name, externalCode: products.externalCode, externalIds: products.externalIds }).from(products),
      db.select({ name: productAliases.name, externalId: productAliases.externalId }).from(productAliases),
    ]);
    const taken = new Map<string, string>();
    for (const r of names) taken.set(matchKey(r.name), `the SKU "${r.name}"`);
    for (const r of aliasRows) if (!taken.has(matchKey(r.name))) taken.set(matchKey(r.name), `another name for a product ("${r.name}")`);
    if (taken.has(key)) return fail(`That name is already ${taken.get(key)}.`, "conflict");
    for (const a of aliases) {
      const hit = taken.get(matchKey(a));
      if (hit) return fail(`"${a}" is already ${hit}.`, "conflict");
    }
    if (d.externalCode != null) {
      const code = d.externalCode;
      const owner = names.find(
        (r) => r.externalCode === String(code) || (r.externalIds ?? []).includes(code),
      );
      if (owner) return fail(`Legacy Product ID ${code} already belongs to "${owner.name}".`, "conflict");
      if (aliasRows.some((r) => r.externalId === code)) {
        return fail(`Legacy Product ID ${code} already resolves through another name.`, "conflict");
      }
    }

    /* The three levels above, existing or new — and chained. */
    let formulation: { id: string; name: string; isNew: boolean };
    if ("id" in d.formulation) {
      const [f] = await db.select().from(productFormulations).where(eq(productFormulations.id, d.formulation.id));
      if (!f) return fail("No such formulation.", "not_found");
      formulation = { id: f.id, name: f.name, isNew: false };
    } else {
      const fname = canonicalName(d.formulation.name);
      const [f] = await db.select().from(productFormulations).where(eq(productFormulations.slug, matchKey(fname)));
      if (f) return fail(`"${f.name}" is already a formulation — pick it from the list.`, "conflict");
      formulation = { id: newId("frm"), name: fname, isNew: true };
    }

    let brand: { id: string; name: string; isNew: boolean };
    if ("id" in d.brand) {
      const [b] = await db.select().from(productBrands).where(eq(productBrands.id, d.brand.id));
      if (!b) return fail("No such brand line.", "not_found");
      if (b.formulationId !== formulation.id) {
        return fail(`"${b.name}" belongs to another formulation. Pick a brand under ${formulation.name}, or add one.`, "rule_violation");
      }
      brand = { id: b.id, name: b.name, isNew: false };
    } else {
      const bname = canonicalName(d.brand.name);
      const [b] = await db.select().from(productBrands).where(eq(productBrands.slug, matchKey(bname)));
      if (b) return fail(`"${b.name}" is already a brand line — pick it from the list.`, "conflict");
      brand = { id: newId("brd"), name: bname, isNew: true };
    }

    let good: { id: string; name: string; millilitres: number; isNew: boolean };
    if ("id" in d.good) {
      const [g] = await db.select().from(finishedGoods).where(eq(finishedGoods.id, d.good.id));
      if (!g) return fail("No such finished good.", "not_found");
      if (g.brandId !== brand.id) {
        return fail(`"${g.name}" belongs to another brand line. Pick one under ${brand.name}, or add one.`, "rule_violation");
      }
      good = { id: g.id, name: g.name, millilitres: g.millilitres, isNew: false };
    } else {
      const gname = canonicalName(d.good.name || finishedGoodNameFor(brand.name, d.good.millilitres));
      if (gname.length < 3) return fail("The finished good needs a name.");
      const [g] = await db
        .select()
        .from(finishedGoods)
        .where(eq(finishedGoods.slug, matchKey(gname)));
      if (g) return fail(`"${g.name}" is already a finished good — pick it from the list.`, "conflict");
      good = { id: newId("fgd"), name: gname, millilitres: d.good.millilitres, isNew: true };
    }

    const productId = newId("prd");
    const weightBasis = d.cansPerBox > 1 ? "box" : "can";
    const packing = d.packingKind === "box" ? `${d.cansPerBox} Can/Box` : d.packingKind === "drum" ? "Drum" : "Loose";

    await db.transaction(async (tx) => {
      if (formulation.isNew) {
        await tx.insert(productFormulations).values({
          id: formulation.id,
          name: formulation.name,
          slug: matchKey(formulation.name),
          active: true,
        });
      }
      if (brand.isNew) {
        await tx.insert(productBrands).values({
          id: brand.id,
          name: brand.name,
          slug: matchKey(brand.name),
          formulationId: formulation.id,
          active: true,
        });
      }
      if (good.isNew) {
        await tx.insert(finishedGoods).values({
          id: good.id,
          name: good.name,
          slug: matchKey(good.name),
          brandId: brand.id,
          formulationId: formulation.id,
          millilitres: good.millilitres,
          active: true,
        });
      }
      await tx.insert(products).values({
        id: productId,
        name,
        rawName: name,
        externalCode: d.externalCode == null ? null : String(d.externalCode),
        externalIds: d.externalCode == null ? null : [d.externalCode],
        finishedGoodId: good.id,
        brandId: brand.id,
        formulationId: formulation.id,
        packing,
        cansPerBox: d.cansPerBox,
        millilitresPerCan: d.millilitresPerCan,
        packingCostPaise: d.packingCostPaise,
        weightGrams: d.weightGrams,
        weightBasis,
        sellingPricePaise: d.sellingPricePaise,
        status: "ok",
        active: d.active,
      });
      for (const a of aliases) {
        await tx.insert(productAliases).values({
          id: newId("pal"),
          productId,
          name: a,
          reason: "Added with the SKU in the Admin Console",
          createdById: user.id,
        });
      }
    });

    await audit(user.id, "catalogue.skuCreated", productId, null, {
      name,
      formulation: { id: formulation.id, name: formulation.name, new: formulation.isNew },
      brand: { id: brand.id, name: brand.name, new: brand.isNew },
      finishedGood: { id: good.id, name: good.name, new: good.isNew },
      packing,
      cansPerBox: d.cansPerBox,
      millilitresPerCan: d.millilitresPerCan,
      packingCostPaise: d.packingCostPaise,
      weightGrams: d.weightGrams,
      sellingPricePaise: d.sellingPricePaise,
      externalCode: d.externalCode,
      aliases,
      active: d.active,
    });
    refresh();
    return ok(
      { productId, name },
      d.active ? `"${name}" is in the catalogue and can be ordered.` : `"${name}" is in the catalogue, kept off the order form.`,
    );
  } catch (e) {
    return fail(clashSentence(e) ?? (e instanceof Error ? e.message : "That did not save."));
  }
}
