"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  catalogueExceptions,
  finishedGoods,
  productAliases,
  productBrands,
  productFormulations,
  products,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { requireCapability } from "@/lib/access-control";
import { canonicalName, matchKey } from "@/lib/catalogue";
import {
  importCatalogue,
  resolveCanonicalId,
  type ImportReport,
} from "@/lib/services/catalogue-import";
import { err as fail, ok, type Result } from "@/lib/result";

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
    revalidatePath("/admin/catalogue");
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
