"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  priceListDiscountTerms,
  priceListDocuments,
  priceListParseRows,
  priceListRates,
  priceListScopes,
  priceLists,
  priceRequests,
  productAliases,
  PRICE_DELIVERY_BASES,
  PRICE_DISCOUNT_KINDS,
  PRICE_FREIGHT_TERMS,
  PRICE_SCOPE_KINDS,
  type PriceDerivation,
  type PriceParsedHeader,
} from "@/db/schema";
import { requireCapability, assertCustomerInScope } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { notifyUsers } from "@/lib/notify";
import { deriveRate, exFromIncl, inclFromEx, roundToRupee } from "@/lib/engines/price-math";
import { placeKey } from "@/lib/engines/price-resolution";
import { ratesForCustomer, resolveForCustomer } from "@/lib/services/price-list-service";
import { err, fieldErr, fromThrown, ok, okVoid, type FieldError, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * EVERY WRITE A PRICE LIST TAKES.
 *
 * Three rules run through all of it and are worth stating once rather than at
 * each function:
 *
 * A PUBLISHED LIST IS NOT EDITED, IT IS SUPERSEDED. An order taken in August
 * has to stay explainable in December, so a price that moves produces a new
 * VERSION dated from the day it takes effect and dates the old one out. What
 * may still be changed on a published list is what a reader sees and not what
 * a customer paid: the name, the reference, the notes, the terms block.
 *
 * NOTHING IS DELETED. Superseded and withdrawn are states; the rows stay, and
 * the only delete in this file is a draft nobody ever published and a document
 * that became nothing.
 *
 * A SERVER ACTION IS A URL. Every one of these re-checks the capability even
 * where the screen would never draw the control, and the audit row records the
 * hat that allowed it.
 * ------------------------------------------------------------------------- */

const gen = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

function refresh(customerId?: string) {
  try {
    revalidatePath("/sales/price-lists");
    revalidatePath("/crm/price-lists");
    if (customerId) revalidatePath(`/crm/customers/${customerId}`);
  } catch {
    /* No request context — a job or a test. */
  }
}

function zodErr(error: z.ZodError): ReturnType<typeof err> {
  const fieldErrors = error.issues.map<FieldError>((i) => ({
    field: i.path.join(".") || "form",
    message: i.message,
  }));
  return err(fieldErrors[0]?.message ?? "That is not valid.", "validation", fieldErrors);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const listFields = z.object({
  name: z.string().trim().min(1, "A list needs a name people will recognise."),
  refNo: z.string().trim().nullish(),
  effectiveFrom: z.string().regex(ISO_DATE, "That is not a date."),
  validityDays: z.number().int().min(0).max(3650).nullish(),
  taxBasis: z.enum(["inclusive", "exclusive"]).optional(),
  gstBp: z.number().int().min(0).max(5000).optional(),
  deliveryBasis: z.enum(PRICE_DELIVERY_BASES).nullish(),
  freightTerm: z.enum(PRICE_FREIGHT_TERMS).optional(),
  freightPerLitrePaise: z.number().int().nullish(),
  notes: z.string().trim().nullish(),
  termsText: z.string().nullish(),
  signatory: z.string().trim().nullish(),
});

export type ListFields = z.infer<typeof listFields>;

const derivationSchema: z.ZodType<PriceDerivation> = z.union([
  z.object({ kind: z.literal("per_litre_paise"), paise: z.number().int() }),
  z.object({ kind: z.literal("percent_bp"), bp: z.number().int() }),
  z.object({ kind: z.literal("per_can_paise"), paise: z.number().int() }),
]);

/** A list row as the writes need it. */
async function listRow(id: string) {
  const [row] = await db.select().from(priceLists).where(eq(priceLists.id, id));
  return row ?? null;
}

async function audit(
  tx: { insert: typeof db.insert },
  ctx: { user: { id: string }; authorisedBy: string; authorisedIn: string | null },
  input: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown },
) {
  await tx.insert(auditLog).values({
    id: gen("aud"),
    actorId: ctx.user.id,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    actorRole: ctx.authorisedBy as never,
    actorApp: ctx.authorisedIn as never,
    beforeState: (input.before ?? null) as never,
    afterState: (input.after ?? null) as never,
  });
}

/* ------------------------------------------------------------------ lists */

export async function createPriceList(
  input: ListFields & {
    parentListId?: string | null;
    derivation?: PriceDerivation | null;
    copyRatesFromListId?: string | null;
  },
): Promise<Result<{ id: string }>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const parsed = listFields.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const config = await getConfig();

    if (input.derivation && !input.parentListId) {
      return fieldErr("parentListId", "A derived list needs the list it is derived from.");
    }
    const parent = input.parentListId ? await listRow(input.parentListId) : null;
    if (input.parentListId && !parent) return fieldErr("parentListId", "That list does not exist.");

    const id = gen("pl");
    const gstBp = parsed.data.gstBp ?? parent?.gstBp ?? config["pricing.gstBp"];

    await db.transaction(async (tx) => {
      await tx.insert(priceLists).values({
        id,
        refNo: parsed.data.refNo?.trim() || null,
        name: parsed.data.name,
        version: 1,
        effectiveFrom: parsed.data.effectiveFrom,
        validityDays: parsed.data.validityDays ?? null,
        taxBasis: parsed.data.taxBasis ?? "inclusive",
        gstBp,
        deliveryBasis: parsed.data.deliveryBasis ?? parent?.deliveryBasis ?? null,
        freightTerm: parsed.data.freightTerm ?? "not_stated",
        freightPerLitrePaise: parsed.data.freightPerLitrePaise ?? null,
        parentListId: input.parentListId ?? null,
        derivation: input.derivation ?? null,
        notes: parsed.data.notes ?? null,
        termsText: parsed.data.termsText ?? null,
        signatory: parsed.data.signatory ?? null,
        status: "draft",
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });

      // A derived list is GENERATED from its parent rather than typed, which
      // is the whole reason the rule is stored: "Odisha Paid" cannot drift
      // from "Odisha To Pay" if nobody ever types it.
      const source = input.derivation && parent ? parent.id : input.copyRatesFromListId;
      if (source) {
        const rows = await tx.execute<{
          productId: string;
          rateExGstPaise: number;
          minCans: number | null;
          maxCans: number | null;
          offered: boolean;
          millilitresPerCan: number | null;
        }>(sql`
          select r.product_id as "productId", r.rate_ex_gst_paise as "rateExGstPaise",
                 r.min_cans as "minCans", r.max_cans as "maxCans", r.offered,
                 p.millilitres_per_can as "millilitresPerCan"
            from price_list_rates r join products p on p.id = r.product_id
           where r.price_list_id = ${source}
        `);
        const values = [];
        for (const row of rows) {
          const base = Number(row.rateExGstPaise);
          const ex = input.derivation ? deriveRate(base, row.millilitresPerCan, input.derivation) : base;
          // A per-litre rule on a SKU with no pack size cannot be computed,
          // and a guess there is a wrong price on a real order.
          if (ex == null) continue;
          values.push({
            id: gen("plr"),
            priceListId: id,
            productId: row.productId,
            rateExGstPaise: ex,
            rateInclGstPaise: inclFromEx(ex, gstBp),
            minCans: row.minCans,
            maxCans: row.maxCans,
            offered: row.offered,
            matchStatus: "manual" as const,
            updatedById: ctx.user.id,
          });
        }
        if (values.length) await tx.insert(priceListRates).values(values);

        const terms = await tx
          .select()
          .from(priceListDiscountTerms)
          .where(eq(priceListDiscountTerms.priceListId, source));
        if (terms.length) {
          await tx.insert(priceListDiscountTerms).values(
            terms.map((t) => ({
              id: gen("pld"),
              priceListId: id,
              kind: t.kind,
              percentBp: t.percentBp,
              thresholdLitres: t.thresholdLitres,
              thresholdPaise: t.thresholdPaise,
              rawText: t.rawText,
            })),
          );
        }
      }

      await audit(tx, ctx, {
        action: "pricelist.create",
        entityType: "price_list",
        entityId: id,
        after: { name: parsed.data.name, effectiveFrom: parsed.data.effectiveFrom, parentListId: input.parentListId ?? null },
      });
    });

    refresh();
    return ok({ id }, "Draft created. Add its rates and say who it applies to, then publish it.");
  } catch (e) {
    return fromThrown(e);
  }
}

/** What may still be changed once a list is in force: how it READS, never what it charges. */
const PUBLISHED_EDITABLE = new Set(["name", "refNo", "notes", "termsText", "signatory", "validityDays", "deliveryBasis"]);

export async function updatePriceList(id: string, input: Partial<ListFields>): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const row = await listRow(id);
    if (!row) return err("That price list does not exist.", "not_found");

    if (row.status !== "draft") {
      const blocked = Object.keys(input).filter((k) => !PUBLISHED_EDITABLE.has(k) && input[k as keyof ListFields] !== undefined);
      if (blocked.length) {
        return err(
          `This list is ${row.status} and its prices and terms are what somebody was charged. Publish a new version to change ${blocked.join(", ")}.`,
          "rule_violation",
        );
      }
    }
    if (input.effectiveFrom && !ISO_DATE.test(input.effectiveFrom)) return fieldErr("effectiveFrom", "That is not a date.");

    await db.transaction(async (tx) => {
      await tx
        .update(priceLists)
        .set({
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.refNo !== undefined ? { refNo: input.refNo?.trim() || null } : {}),
          ...(input.effectiveFrom !== undefined ? { effectiveFrom: input.effectiveFrom } : {}),
          ...(input.validityDays !== undefined ? { validityDays: input.validityDays ?? null } : {}),
          ...(input.taxBasis !== undefined ? { taxBasis: input.taxBasis } : {}),
          ...(input.gstBp !== undefined ? { gstBp: input.gstBp } : {}),
          ...(input.deliveryBasis !== undefined ? { deliveryBasis: input.deliveryBasis ?? null } : {}),
          ...(input.freightTerm !== undefined ? { freightTerm: input.freightTerm } : {}),
          ...(input.freightPerLitrePaise !== undefined ? { freightPerLitrePaise: input.freightPerLitrePaise ?? null } : {}),
          ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
          ...(input.termsText !== undefined ? { termsText: input.termsText ?? null } : {}),
          ...(input.signatory !== undefined ? { signatory: input.signatory?.trim() || null } : {}),
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(priceLists.id, id));
      await audit(tx, ctx, {
        action: "pricelist.update",
        entityType: "price_list",
        entityId: id,
        before: { name: row.name, effectiveFrom: row.effectiveFrom },
        after: input,
      });
    });

    refresh();
    return okVoid("Saved.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function deleteDraftPriceList(id: string): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const row = await listRow(id);
    if (!row) return err("That price list does not exist.", "not_found");
    if (row.status !== "draft") {
      return err(
        "Only a draft can be deleted. A list that has been published is what somebody was charged; withdraw it instead.",
        "rule_violation",
      );
    }
    await db.transaction(async (tx) => {
      await audit(tx, ctx, { action: "pricelist.delete", entityType: "price_list", entityId: id, before: { name: row.name } });
      await tx.delete(priceLists).where(eq(priceLists.id, id));
    });
    refresh();
    return okVoid("Draft deleted.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------------ rates */

const rateInput = z.object({
  priceListId: z.string().min(1),
  productId: z.string().min(1, "Pick a product."),
  rateExGstPaise: z.number().int().positive().nullish(),
  rateInclGstPaise: z.number().int().positive().nullish(),
  minCans: z.number().int().positive().nullish(),
  maxCans: z.number().int().positive().nullish(),
  offered: z.boolean().optional(),
});

/** Both figures from either one, at the LIST's own GST rate. */
function bothRates(
  ex: number | null | undefined,
  incl: number | null | undefined,
  gstBp: number,
): { ex: number; incl: number } | null {
  if (ex != null) return { ex, incl: inclFromEx(ex, gstBp) };
  if (incl != null) return { ex: exFromIncl(incl, gstBp), incl };
  return null;
}

export async function setRate(input: z.input<typeof rateInput>): Promise<Result<{ id: string }>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const parsed = rateInput.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);

    const list = await listRow(parsed.data.priceListId);
    if (!list) return err("That price list does not exist.", "not_found");
    if (list.status === "superseded" || list.status === "withdrawn") {
      return err(`This list is ${list.status}. Publish a new version to change a price.`, "rule_violation");
    }

    const rates = bothRates(parsed.data.rateExGstPaise, parsed.data.rateInclGstPaise, list.gstBp);
    if (!rates) return fieldErr("rateInclGstPaise", "Type a price.");
    if (parsed.data.minCans != null && parsed.data.maxCans != null && parsed.data.maxCans < parsed.data.minCans) {
      return fieldErr("maxCans", "The top of the band cannot be below the bottom of it.");
    }

    const id = gen("plr");
    await db.transaction(async (tx) => {
      const [existing] = await tx.execute<{ id: string; rateExGstPaise: number }>(sql`
        select r.id, r.rate_ex_gst_paise as "rateExGstPaise" from price_list_rates r
         where r.price_list_id = ${parsed.data.priceListId}
           and r.product_id = ${parsed.data.productId}
           and coalesce(r.min_cans, 0) = ${parsed.data.minCans ?? 0}
      `);
      if (existing) {
        await tx
          .update(priceListRates)
          .set({
            rateExGstPaise: rates.ex,
            rateInclGstPaise: rates.incl,
            maxCans: parsed.data.maxCans ?? null,
            offered: parsed.data.offered ?? true,
            matchStatus: "manual",
            updatedAt: new Date(),
            updatedById: ctx.user.id,
          })
          .where(eq(priceListRates.id, existing.id));
      } else {
        await tx.insert(priceListRates).values({
          id,
          priceListId: parsed.data.priceListId,
          productId: parsed.data.productId,
          rateExGstPaise: rates.ex,
          rateInclGstPaise: rates.incl,
          minCans: parsed.data.minCans ?? null,
          maxCans: parsed.data.maxCans ?? null,
          offered: parsed.data.offered ?? true,
          matchStatus: "manual",
          updatedById: ctx.user.id,
        });
      }
      await audit(tx, ctx, {
        action: "pricelist.rate.set",
        entityType: "price_list_rate",
        entityId: existing?.id ?? id,
        before: existing ? { rateExGstPaise: Number(existing.rateExGstPaise) } : undefined,
        after: { productId: parsed.data.productId, ...rates, minCans: parsed.data.minCans ?? null },
      });
    });

    refresh();
    return ok({ id }, "Rate saved.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function removeRate(rateId: string): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const [row] = await db.select().from(priceListRates).where(eq(priceListRates.id, rateId));
    if (!row) return err("That rate does not exist.", "not_found");
    const list = await listRow(row.priceListId);
    if (list && list.status !== "draft") {
      return err(
        `This list is ${list.status}. Taking a rate off it would change what a customer was charged; publish a new version instead.`,
        "rule_violation",
      );
    }
    await db.transaction(async (tx) => {
      await audit(tx, ctx, {
        action: "pricelist.rate.remove",
        entityType: "price_list_rate",
        entityId: rateId,
        before: { productId: row.productId, rateExGstPaise: row.rateExGstPaise },
      });
      await tx.delete(priceListRates).where(eq(priceListRates.id, rateId));
    });
    refresh();
    return okVoid("Rate removed.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function bulkSetRates(input: {
  priceListId: string;
  rates: Array<{
    productId: string;
    rateExGstPaise?: number | null;
    rateInclGstPaise?: number | null;
    minCans?: number | null;
    maxCans?: number | null;
    offered?: boolean;
  }>;
}): Promise<Result<{ written: number }>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const list = await listRow(input.priceListId);
    if (!list) return err("That price list does not exist.", "not_found");
    if (list.status !== "draft") {
      return err("Rates can be pasted into a draft. Publish a new version to change a list in force.", "rule_violation");
    }
    if (!input.rates.length) return err("Nothing to write.", "validation");

    let written = 0;
    await db.transaction(async (tx) => {
      for (const r of input.rates) {
        const rates = bothRates(r.rateExGstPaise, r.rateInclGstPaise, list.gstBp);
        if (!rates) continue;
        /* The unique index is over an EXPRESSION — `coalesce(min_cans, 0)`, so
         * that a flat price and a slab starting at nothing are one row — and
         * drizzle cannot name an expression as a conflict target. Asked and
         * then written, inside the transaction that holds the row. */
        const [existing] = await tx.execute<{ id: string }>(sql`
          select r.id from price_list_rates r
           where r.price_list_id = ${input.priceListId}
             and r.product_id = ${r.productId}
             and coalesce(r.min_cans, 0) = ${r.minCans ?? 0}
        `);
        if (existing) {
          await tx
            .update(priceListRates)
            .set({
              rateExGstPaise: rates.ex,
              rateInclGstPaise: rates.incl,
              maxCans: r.maxCans ?? null,
              offered: r.offered ?? true,
              updatedAt: new Date(),
              updatedById: ctx.user.id,
            })
            .where(eq(priceListRates.id, existing.id));
        } else {
          await tx.insert(priceListRates).values({
            id: gen("plr"),
            priceListId: input.priceListId,
            productId: r.productId,
            rateExGstPaise: rates.ex,
            rateInclGstPaise: rates.incl,
            minCans: r.minCans ?? null,
            maxCans: r.maxCans ?? null,
            offered: r.offered ?? true,
            matchStatus: "manual",
            updatedById: ctx.user.id,
          });
        }
        written++;
      }
      await audit(tx, ctx, {
        action: "pricelist.rate.bulk",
        entityType: "price_list",
        entityId: input.priceListId,
        after: { written },
      });
    });

    refresh();
    return ok({ written }, `${written} rate${written === 1 ? "" : "s"} written.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ----------------------------------------------------------------- scopes */

const scopeInput = z.object({
  priceListId: z.string().min(1),
  scopeKind: z.enum(PRICE_SCOPE_KINDS),
  scopeValue: z.string().default(""),
  scopeLabel: z.string().nullish(),
  parentKey: z.string().default(""),
  parentLabel: z.string().nullish(),
  freightTermMatch: z.enum(["any", "to_pay", "paid"]).optional(),
  priority: z.number().int().optional(),
  validFrom: z.string().regex(ISO_DATE).nullish(),
  validTo: z.string().regex(ISO_DATE).nullish(),
});

/** Geography is stored FOLDED, so two spellings of one place are one scope. */
const GEOGRAPHY = new Set(["state", "district", "city", "area", "beat"]);

function storedScopeValue(kind: string, value: string): string {
  return GEOGRAPHY.has(kind) ? placeKey(value) : value.trim();
}

export async function addScope(input: z.input<typeof scopeInput>): Promise<Result<{ id: string }>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const parsed = scopeInput.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const list = await listRow(parsed.data.priceListId);
    if (!list) return err("That price list does not exist.", "not_found");

    const value = storedScopeValue(parsed.data.scopeKind, parsed.data.scopeValue);
    if (parsed.data.scopeKind !== "everybody" && !value) {
      return fieldErr("scopeValue", "Say which one this list applies to.");
    }

    const id = gen("pls");
    await db.transaction(async (tx) => {
      await tx.insert(priceListScopes).values({
        id,
        priceListId: parsed.data.priceListId,
        scopeKind: parsed.data.scopeKind,
        scopeValue: value,
        scopeLabel: parsed.data.scopeLabel ?? (parsed.data.scopeValue || null),
        parentKey: GEOGRAPHY.has(parsed.data.scopeKind) ? placeKey(parsed.data.parentKey) : parsed.data.parentKey,
        freightTermMatch: parsed.data.freightTermMatch ?? "any",
        priority: parsed.data.priority ?? 0,
        validFrom: parsed.data.validFrom ?? null,
        validTo: parsed.data.validTo ?? null,
        createdById: ctx.user.id,
      });
      await audit(tx, ctx, {
        action: "pricelist.scope.add",
        entityType: "price_list_scope",
        entityId: id,
        after: { list: list.name, kind: parsed.data.scopeKind, value },
      });
    });

    refresh();
    return ok({ id }, "Saved. This list now applies to them.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function updateScope(
  id: string,
  input: Partial<Omit<z.input<typeof scopeInput>, "priceListId">>,
): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const [row] = await db.select().from(priceListScopes).where(eq(priceListScopes.id, id));
    if (!row) return err("That scope does not exist.", "not_found");

    const kind = input.scopeKind ?? row.scopeKind;
    await db.transaction(async (tx) => {
      await tx
        .update(priceListScopes)
        .set({
          ...(input.scopeKind !== undefined ? { scopeKind: input.scopeKind } : {}),
          ...(input.scopeValue !== undefined ? { scopeValue: storedScopeValue(kind, input.scopeValue) } : {}),
          ...(input.scopeLabel !== undefined ? { scopeLabel: input.scopeLabel ?? null } : {}),
          ...(input.parentKey !== undefined
            ? { parentKey: GEOGRAPHY.has(kind) ? placeKey(input.parentKey) : input.parentKey }
            : {}),
          ...(input.freightTermMatch !== undefined ? { freightTermMatch: input.freightTermMatch } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.validFrom !== undefined ? { validFrom: input.validFrom ?? null } : {}),
          ...(input.validTo !== undefined ? { validTo: input.validTo ?? null } : {}),
        })
        .where(eq(priceListScopes.id, id));
      await audit(tx, ctx, {
        action: "pricelist.scope.update",
        entityType: "price_list_scope",
        entityId: id,
        before: { kind: row.scopeKind, value: row.scopeValue },
        after: input,
      });
    });

    refresh();
    return okVoid("Saved.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function removeScope(id: string): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const [row] = await db.select().from(priceListScopes).where(eq(priceListScopes.id, id));
    if (!row) return err("That scope does not exist.", "not_found");
    await db.transaction(async (tx) => {
      await audit(tx, ctx, {
        action: "pricelist.scope.remove",
        entityType: "price_list_scope",
        entityId: id,
        before: { kind: row.scopeKind, value: row.scopeValue },
      });
      await tx.delete(priceListScopes).where(eq(priceListScopes.id, id));
    });
    refresh();
    return okVoid("Removed. This list no longer applies to them.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* -------------------------------------------------------- discount terms */

export async function setDiscountTerm(input: {
  id?: string;
  priceListId: string;
  kind: (typeof PRICE_DISCOUNT_KINDS)[number];
  percentBp: number;
  thresholdLitres?: number | null;
  thresholdPaise?: number | null;
  rawText?: string | null;
}): Promise<Result<{ id: string }>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    if (!PRICE_DISCOUNT_KINDS.includes(input.kind)) return fieldErr("kind", "That is not a kind of discount.");
    if (!Number.isInteger(input.percentBp) || input.percentBp <= 0 || input.percentBp > 10_000) {
      return fieldErr("percentBp", "A discount is a percentage above zero.");
    }
    const id = input.id ?? gen("plt");
    await db.transaction(async (tx) => {
      if (input.id) {
        await tx
          .update(priceListDiscountTerms)
          .set({
            kind: input.kind,
            percentBp: input.percentBp,
            thresholdLitres: input.thresholdLitres ?? null,
            thresholdPaise: input.thresholdPaise ?? null,
            rawText: input.rawText ?? null,
          })
          .where(eq(priceListDiscountTerms.id, input.id));
      } else {
        await tx.insert(priceListDiscountTerms).values({
          id,
          priceListId: input.priceListId,
          kind: input.kind,
          percentBp: input.percentBp,
          thresholdLitres: input.thresholdLitres ?? null,
          thresholdPaise: input.thresholdPaise ?? null,
          rawText: input.rawText ?? null,
        });
      }
      await audit(tx, ctx, {
        action: "pricelist.discount.set",
        entityType: "price_list",
        entityId: input.priceListId,
        after: { kind: input.kind, percentBp: input.percentBp },
      });
    });
    refresh();
    return ok({ id }, "Saved.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function removeDiscountTerm(id: string): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const [row] = await db.select().from(priceListDiscountTerms).where(eq(priceListDiscountTerms.id, id));
    if (!row) return err("That term does not exist.", "not_found");
    await db.transaction(async (tx) => {
      await audit(tx, ctx, {
        action: "pricelist.discount.remove",
        entityType: "price_list",
        entityId: row.priceListId,
        before: { kind: row.kind, percentBp: row.percentBp },
      });
      await tx.delete(priceListDiscountTerms).where(eq(priceListDiscountTerms.id, id));
    });
    refresh();
    return okVoid("Removed.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* -------------------------------------------------------------- publishing */

export async function publishPriceList(
  id: string,
  input?: { supersedesId?: string | null; effectiveFrom?: string },
): Promise<Result<{ warnings: string[] }>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const row = await listRow(id);
    if (!row) return err("That price list does not exist.", "not_found");
    if (row.status !== "draft") return err(`This list is already ${row.status}.`, "rule_violation");

    const effectiveFrom = input?.effectiveFrom ?? row.effectiveFrom;
    if (!ISO_DATE.test(effectiveFrom)) return fieldErr("effectiveFrom", "That is not a date.");

    const [{ rates }] = await db.execute<{ rates: number }>(sql`
      select count(*)::int as rates from price_list_rates where price_list_id = ${id}
    `);
    if (!Number(rates)) {
      return err("This list has no rates in it. A list with no prices is not a list.", "rule_violation");
    }

    const warnings: string[] = [];
    const [{ scopes }] = await db.execute<{ scopes: number }>(sql`
      select count(*)::int as scopes from price_list_scopes where price_list_id = ${id}
    `);

    const supersedes = input?.supersedesId ? await listRow(input.supersedesId) : null;
    if (input?.supersedesId && !supersedes) return fieldErr("supersedesId", "That list does not exist.");
    if (supersedes && supersedes.status !== "published") {
      return fieldErr("supersedesId", `That list is ${supersedes.status}, so there is nothing to supersede.`);
    }

    // A derived list is checked against its own rule before it goes out. Not
    // refused: the office overrides a cell deliberately often enough that a
    // block would be worked around, and a warning is read.
    const config = await getConfig();
    if (row.parentListId && row.derivation) {
      const drift = await db.execute<{ name: string; expected: number; actual: number }>(sql`
        select p.name,
               child.rate_ex_gst_paise as actual,
               parent.rate_ex_gst_paise as expected
          from price_list_rates child
          join price_list_rates parent
            on parent.price_list_id = ${row.parentListId}
           and parent.product_id = child.product_id
           and coalesce(parent.min_cans, 0) = coalesce(child.min_cans, 0)
          join products p on p.id = child.product_id
         where child.price_list_id = ${id}
      `);
      const tolerance = config["pricing.derivationTolerancePaise"];
      let off = 0;
      for (const d of drift) {
        const expected = deriveRate(Number(d.expected), null, row.derivation as PriceDerivation);
        if (expected != null && Math.abs(expected - Number(d.actual)) > tolerance) off++;
      }
      if (off) warnings.push(`${off} rate${off === 1 ? " is" : "s are"} further from this list's own rule than the tolerance allows.`);
    }

    await db.transaction(async (tx) => {
      if (supersedes) {
        await tx
          .update(priceLists)
          .set({
            status: "superseded",
            effectiveTo: addDays(effectiveFrom, -1),
            updatedAt: new Date(),
            updatedById: ctx.user.id,
          })
          .where(eq(priceLists.id, supersedes.id));

        // A new version with nobody on it would silently apply to nothing;
        // inheriting the scopes is what makes "publish next month's list"
        // one act rather than two, and the second one easy to forget.
        if (!Number(scopes)) {
          const old = await tx.select().from(priceListScopes).where(eq(priceListScopes.priceListId, supersedes.id));
          if (old.length) {
            await tx.insert(priceListScopes).values(
              old.map((s) => ({
                id: gen("pls"),
                priceListId: id,
                scopeKind: s.scopeKind,
                scopeValue: s.scopeValue,
                scopeLabel: s.scopeLabel,
                parentKey: s.parentKey,
                freightTermMatch: s.freightTermMatch,
                priority: s.priority,
                validFrom: s.validFrom,
                validTo: s.validTo,
                createdById: ctx.user.id,
              })),
            );
            warnings.push(`Carried ${old.length} scope${old.length === 1 ? "" : "s"} over from ${supersedes.name}.`);
          }
        }
      } else if (!Number(scopes)) {
        warnings.push("Nobody is on this list yet, so no shop will be priced from it. Add who it applies to.");
      }

      await tx
        .update(priceLists)
        .set({
          status: "published",
          effectiveFrom,
          supersedesId: supersedes?.id ?? row.supersedesId,
          publishedAt: new Date(),
          publishedById: ctx.user.id,
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(priceLists.id, id));

      await audit(tx, ctx, {
        action: "pricelist.publish",
        entityType: "price_list",
        entityId: id,
        before: { status: "draft" },
        after: { status: "published", effectiveFrom, supersedes: supersedes?.id ?? null, rates: Number(rates) },
      });
    });

    refresh();
    return ok({ warnings }, `${row.name} is in force from ${effectiveFrom}.`);
  } catch (e) {
    return fromThrown(e);
  }
}

export async function withdrawPriceList(id: string, reason: string): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    if (!reason.trim()) {
      return fieldErr("reason", "Say why it is being withdrawn. Somebody will ask what happened to this list.");
    }
    const row = await listRow(id);
    if (!row) return err("That price list does not exist.", "not_found");
    if (row.status === "withdrawn") return err("That list has already been withdrawn.", "rule_violation");

    const day = await today();
    await db.transaction(async (tx) => {
      await tx
        .update(priceLists)
        .set({
          status: "withdrawn",
          effectiveTo: addDays(day, -1),
          withdrawnAt: new Date(),
          withdrawnById: ctx.user.id,
          withdrawReason: reason.trim(),
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(priceLists.id, id));
      await audit(tx, ctx, {
        action: "pricelist.withdraw",
        entityType: "price_list",
        entityId: id,
        before: { status: row.status },
        after: { status: "withdrawn", reason: reason.trim() },
      });
    });

    refresh();
    return okVoid("Withdrawn. Nothing is priced from it from today.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------- versioning */

export async function newVersion(
  id: string,
  input: { effectiveFrom: string; name?: string; refNo?: string | null },
): Promise<Result<{ id: string }>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    if (!ISO_DATE.test(input.effectiveFrom)) return fieldErr("effectiveFrom", "That is not a date.");
    const row = await listRow(id);
    if (!row) return err("That price list does not exist.", "not_found");

    const newId = gen("pl");
    await db.transaction(async (tx) => {
      await tx.insert(priceLists).values({
        id: newId,
        refNo: input.refNo !== undefined ? input.refNo : row.refNo,
        name: input.name?.trim() || row.name,
        version: row.version + 1,
        supersedesId: row.id,
        documentId: null,
        effectiveFrom: input.effectiveFrom,
        validityDays: row.validityDays,
        taxBasis: row.taxBasis,
        gstBp: row.gstBp,
        deliveryBasis: row.deliveryBasis,
        freightTerm: row.freightTerm,
        freightPerLitrePaise: row.freightPerLitrePaise,
        parentListId: row.parentListId,
        derivation: row.derivation,
        unitBasis: row.unitBasis,
        status: "draft",
        termsText: row.termsText,
        signatory: row.signatory,
        notes: row.notes,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });

      await tx.execute(sql`
        insert into price_list_rates (id, price_list_id, product_id, rate_ex_gst_paise, rate_incl_gst_paise,
                                      min_cans, max_cans, offered, match_status, updated_by_id)
        select ${sql.raw("'plr_' || substr(md5(random()::text), 1, 12)")}, ${newId}, r.product_id,
               r.rate_ex_gst_paise, r.rate_incl_gst_paise, r.min_cans, r.max_cans, r.offered,
               'manual', ${ctx.user.id}
          from price_list_rates r where r.price_list_id = ${id}
      `);
      await tx.execute(sql`
        insert into price_list_discount_terms (id, price_list_id, kind, percent_bp, threshold_litres, threshold_paise, raw_text)
        select ${sql.raw("'plt_' || substr(md5(random()::text), 1, 12)")}, ${newId}, t.kind, t.percent_bp,
               t.threshold_litres, t.threshold_paise, t.raw_text
          from price_list_discount_terms t where t.price_list_id = ${id}
      `);
      await tx.execute(sql`
        insert into price_list_scopes (id, price_list_id, scope_kind, scope_value, scope_label, parent_key,
                                       freight_term_match, priority, valid_from, valid_to, created_by_id)
        select ${sql.raw("'pls_' || substr(md5(random()::text), 1, 12)")}, ${newId}, s.scope_kind, s.scope_value,
               s.scope_label, s.parent_key, s.freight_term_match, s.priority, s.valid_from, s.valid_to, ${ctx.user.id}
          from price_list_scopes s where s.price_list_id = ${id}
      `);

      await audit(tx, ctx, {
        action: "pricelist.version",
        entityType: "price_list",
        entityId: newId,
        after: { from: id, version: row.version + 1, effectiveFrom: input.effectiveFrom },
      });
    });

    refresh();
    return ok({ id: newId }, `Version ${row.version + 1} is a draft. Change what has moved, then publish it.`);
  } catch (e) {
    return fromThrown(e);
  }
}

export async function bulkRevise(
  id: string,
  input: { derivation: PriceDerivation; effectiveFrom: string; name?: string; refNo?: string | null; roundToRupee: boolean },
): Promise<Result<{ id: string; sample: Array<{ productName: string; fromEx: number; toEx: number }> }>> {
  try {
    await requireCapability("pricelist.manage");
    const derivation = derivationSchema.safeParse(input.derivation);
    if (!derivation.success) return zodErr(derivation.error);

    const created = await newVersion(id, { effectiveFrom: input.effectiveFrom, name: input.name, refNo: input.refNo });
    if (!created.ok) return created;
    const newId = created.data.id;

    const ctx = await requireCapability("pricelist.manage");
    const list = await listRow(newId);
    const gstBp = list?.gstBp ?? 1800;

    const rows = await db.execute<{
      id: string;
      productName: string;
      rateExGstPaise: number;
      millilitresPerCan: number | null;
    }>(sql`
      select r.id, p.name as "productName", r.rate_ex_gst_paise as "rateExGstPaise",
             p.millilitres_per_can as "millilitresPerCan"
        from price_list_rates r join products p on p.id = r.product_id
       where r.price_list_id = ${newId}
       order by p.name asc
    `);

    const sample: Array<{ productName: string; fromEx: number; toEx: number }> = [];
    await db.transaction(async (tx) => {
      for (const row of rows) {
        const from = Number(row.rateExGstPaise);
        const moved = deriveRate(from, row.millilitresPerCan, derivation.data);
        if (moved == null) continue;
        const to = input.roundToRupee ? roundToRupee(moved) : moved;
        await tx
          .update(priceListRates)
          .set({ rateExGstPaise: to, rateInclGstPaise: inclFromEx(to, gstBp), updatedAt: new Date(), updatedById: ctx.user.id })
          .where(eq(priceListRates.id, row.id));
        if (sample.length < 5) sample.push({ productName: row.productName, fromEx: from, toEx: to });
      }
      await audit(tx, ctx, {
        action: "pricelist.revise",
        entityType: "price_list",
        entityId: newId,
        after: { from: id, derivation: derivation.data, rates: rows.length },
      });
    });

    refresh();
    return ok({ id: newId, sample }, "Every rate has been moved. Check them, then publish.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function createDerivedList(
  input: ListFields & { parentListId: string; derivation: PriceDerivation },
): Promise<Result<{ id: string }>> {
  const derivation = derivationSchema.safeParse(input.derivation);
  if (!derivation.success) return zodErr(derivation.error);
  return createPriceList({ ...input, derivation: derivation.data });
}

/* ------------------------------------------------------- reviewing a parse */

export async function resolveParseRow(input: {
  rowId: string;
  productId: string | null;
  applyToRow?: boolean;
  learnAlias?: boolean;
}): Promise<Result<{ updated: number }>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const [row] = await db.select().from(priceListParseRows).where(eq(priceListParseRows.id, input.rowId));
    if (!row) return err("That cell does not exist.", "not_found");

    let updated = 0;
    await db.transaction(async (tx) => {
      await tx
        .update(priceListParseRows)
        .set({
          matchedProductId: input.productId,
          matchStatus: input.productId ? "manual" : "skipped",
          problem: null,
          decidedById: ctx.user.id,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(priceListParseRows.id, input.rowId));
      updated++;

      /* The same product at the other pack sizes on this row. A reviewer who
       * has said "this is Mylac Thinner" has answered for the whole row, and
       * asking again per column is six clicks for one decision. Each cell gets
       * the SKU that matches its OWN pack, not the one just chosen. */
      if (input.applyToRow && input.productId) {
        const siblings = await tx.execute<{ id: string; millilitres: number | null; cansPerBox: number | null; productId: string | null }>(sql`
          select r.id, r.millilitres, r.cans_per_box as "cansPerBox",
                 (select s.id from products s
                   where (s.finished_good_id = (select p.finished_good_id from products p where p.id = ${input.productId})
                          or s.brand_id = (select p.brand_id from products p where p.id = ${input.productId}))
                     and s.millilitres_per_can is not distinct from r.millilitres
                     and s.cans_per_box is not distinct from r.cans_per_box
                   order by s.active desc, s.name asc limit 1) as "productId"
            from price_list_parse_rows r
           where r.document_id = ${row.documentId}
             and r.raw_product_text = ${row.rawProductText}
             and r.id <> ${input.rowId}
             and r.decided_by_id is null
        `);
        for (const s of siblings) {
          if (!s.productId) continue;
          await tx
            .update(priceListParseRows)
            .set({
              matchedProductId: s.productId,
              matchStatus: "manual",
              problem: null,
              decidedById: ctx.user.id,
              decidedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(priceListParseRows.id, s.id));
          updated++;
        }
      }

      /* And the next list in the same hand matches on its own. */
      if (input.learnAlias && input.productId) {
        const name = `${row.rawProductText}${row.rawPackText ? ` - ${row.rawPackText}` : ""}`;
        const [existing] = await tx.select().from(productAliases).where(eq(productAliases.name, name));
        if (!existing) {
          await tx.insert(productAliases).values({
            id: gen("pa"),
            productId: input.productId,
            name,
            reason: "price_list",
            createdById: ctx.user.id,
          });
        }
      }

      await audit(tx, ctx, {
        action: "pricelist.parse.resolve",
        entityType: "price_list_document",
        entityId: row.documentId,
        before: { was: row.matchedProductId, status: row.matchStatus },
        after: { productId: input.productId, cells: updated },
      });
    });

    refresh();
    return ok({ updated }, updated > 1 ? `${updated} cells answered.` : "Answered.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function setParseRowPrice(input: {
  rowId: string;
  rateInclGstPaise: number | null;
  offered: boolean;
}): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const [row] = await db.select().from(priceListParseRows).where(eq(priceListParseRows.id, input.rowId));
    if (!row) return err("That cell does not exist.", "not_found");

    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, row.documentId));
    const config = await getConfig();
    const header = doc?.header as PriceParsedHeader | null;
    const gstBp = header?.gstBp ?? config["pricing.gstBp"];
    const inclusive = (header?.taxBasis ?? "inclusive") === "inclusive";
    const incl = input.offered ? input.rateInclGstPaise : null;

    await db.transaction(async (tx) => {
      await tx
        .update(priceListParseRows)
        .set({
          rateInclGstPaise: incl,
          rateExGstPaise: incl == null ? null : inclusive ? exFromIncl(incl, gstBp) : incl,
          offered: input.offered,
          decidedById: ctx.user.id,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(priceListParseRows.id, input.rowId));
      await audit(tx, ctx, {
        action: "pricelist.parse.price",
        entityType: "price_list_document",
        entityId: row.documentId,
        before: { was: row.rateInclGstPaise },
        after: { incl, offered: input.offered },
      });
    });

    refresh();
    return okVoid("Corrected.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function updateDocumentHeader(documentId: string, header: Partial<PriceParsedHeader>): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    if (!doc) return err("That document does not exist.", "not_found");

    const merged = { ...((doc.header as PriceParsedHeader | null) ?? {}), ...header } as PriceParsedHeader;
    await db.transaction(async (tx) => {
      await tx
        .update(priceListDocuments)
        .set({ header: merged, updatedAt: new Date() })
        .where(eq(priceListDocuments.id, documentId));
      await audit(tx, ctx, {
        action: "pricelist.document.header",
        entityType: "price_list_document",
        entityId: documentId,
        before: doc.header,
        after: merged,
      });
    });

    refresh();
    return okVoid("Saved.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* --------------------------------------------- a document becomes a list */

export async function publishDocument(
  documentId: string,
  input: ListFields & {
    supersedesId?: string | null;
    scopes?: Array<Omit<z.input<typeof scopeInput>, "priceListId">>;
    publishNow: boolean;
    includeSuggested: boolean;
  },
): Promise<Result<{ priceListId: string; warnings: string[] }>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const parsed = listFields.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);

    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    if (!doc) return err("That document does not exist.", "not_found");
    if (doc.parseStatus === "published") {
      return err("This document has already been published as a price list.", "rule_violation");
    }

    const header = (doc.header as PriceParsedHeader | null) ?? null;
    const config = await getConfig();
    const gstBp = parsed.data.gstBp ?? header?.gstBp ?? config["pricing.gstBp"];

    const statuses = input.includeSuggested
      ? ["matched", "alias", "manual", "suggested"]
      : ["matched", "alias", "manual"];
    const rows = await db.execute<{
      matchedProductId: string;
      rateExGstPaise: number | null;
      rateInclGstPaise: number | null;
      minCans: number | null;
      offered: boolean;
      rawProductText: string;
      rawPackText: string | null;
      rawPriceText: string | null;
      matchStatus: string;
      matchConfidence: number | null;
      rowIndex: number;
      colIndex: number;
    }>(sql`
      select r.matched_product_id as "matchedProductId", r.rate_ex_gst_paise as "rateExGstPaise",
             r.rate_incl_gst_paise as "rateInclGstPaise", null::int as "minCans", r.offered,
             r.raw_product_text as "rawProductText", r.raw_pack_text as "rawPackText",
             r.raw_price_text as "rawPriceText", r.match_status as "matchStatus",
             r.match_confidence as "matchConfidence", r.row_index as "rowIndex", r.col_index as "colIndex"
        from price_list_parse_rows r
       where r.document_id = ${documentId}
         and r.matched_product_id is not null
         and r.match_status in (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})
       order by r.row_index asc, r.col_index asc
    `);

    const [{ skipped }] = await db.execute<{ skipped: number }>(sql`
      select count(*)::int as skipped from price_list_parse_rows r
       where r.document_id = ${documentId}
         and (r.matched_product_id is null or r.match_status not in (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)}))
    `);

    if (!rows.length) {
      return err(
        "No cell in this document has been matched to a product, so there is nothing to publish. Answer the held cells first.",
        "rule_violation",
      );
    }

    const warnings: string[] = [];
    if (Number(skipped)) {
      warnings.push(`${skipped} cell${Number(skipped) === 1 ? "" : "s"} had no product and ${Number(skipped) === 1 ? "was" : "were"} left out.`);
    }

    const listId = gen("pl");
    // One rate per SKU: a grid prints one product once per column, but two
    // rows that resolve to the same SKU would collide on the unique index.
    const seen = new Set<string>();

    await db.transaction(async (tx) => {
      await tx.insert(priceLists).values({
        id: listId,
        refNo: parsed.data.refNo?.trim() || header?.refNo || null,
        name: parsed.data.name,
        version: 1,
        documentId,
        effectiveFrom: parsed.data.effectiveFrom,
        validityDays: parsed.data.validityDays ?? header?.validityDays ?? null,
        taxBasis: parsed.data.taxBasis ?? header?.taxBasis ?? "inclusive",
        gstBp,
        deliveryBasis: parsed.data.deliveryBasis ?? header?.deliveryBasis ?? null,
        freightTerm: parsed.data.freightTerm ?? header?.freightTerm ?? "not_stated",
        freightPerLitrePaise: parsed.data.freightPerLitrePaise ?? null,
        termsText: parsed.data.termsText ?? header?.termsText ?? null,
        signatory: parsed.data.signatory?.trim() || header?.signatory || null,
        notes: parsed.data.notes ?? null,
        status: "draft",
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });

      const values = [];
      for (const r of rows) {
        if (seen.has(r.matchedProductId)) continue;
        seen.add(r.matchedProductId);
        const ex = r.rateExGstPaise == null ? null : Number(r.rateExGstPaise);
        // A dash keeps its SKU and is stored as not offered — "we do not sell
        // this in this pack on this list" is a fact, and zero is not.
        if (ex == null && r.offered) continue;
        values.push({
          id: gen("plr"),
          priceListId: listId,
          productId: r.matchedProductId,
          rateExGstPaise: ex ?? 0,
          rateInclGstPaise: ex == null ? 0 : inclFromEx(ex, gstBp),
          offered: r.offered && ex != null,
          rawProductText: r.rawProductText,
          rawPackText: r.rawPackText,
          rawPriceText: r.rawPriceText,
          sourceRef: { page: 1, row: r.rowIndex, col: r.colIndex },
          matchStatus: r.matchStatus as never,
          matchConfidence: r.matchConfidence,
          updatedById: ctx.user.id,
        });
      }
      if (values.length) await tx.insert(priceListRates).values(values);

      const terms = header?.discountTerms ?? [];
      if (terms.length) {
        await tx.insert(priceListDiscountTerms).values(
          terms.map((t) => ({
            id: gen("plt"),
            priceListId: listId,
            kind: t.kind,
            percentBp: t.percentBp,
            thresholdLitres: t.thresholdLitres,
            thresholdPaise: t.thresholdPaise,
            rawText: t.rawText,
          })),
        );
      }

      for (const s of input.scopes ?? []) {
        const value = storedScopeValue(s.scopeKind, s.scopeValue ?? "");
        if (s.scopeKind !== "everybody" && !value) continue;
        await tx.insert(priceListScopes).values({
          id: gen("pls"),
          priceListId: listId,
          scopeKind: s.scopeKind,
          scopeValue: value,
          scopeLabel: s.scopeLabel ?? s.scopeValue ?? null,
          parentKey: GEOGRAPHY.has(s.scopeKind) ? placeKey(s.parentKey ?? "") : (s.parentKey ?? ""),
          freightTermMatch: s.freightTermMatch ?? "any",
          priority: s.priority ?? 0,
          createdById: ctx.user.id,
        });
      }

      await tx
        .update(priceListDocuments)
        .set({
          parseStatus: "published",
          priceListId: listId,
          publishedAt: new Date(),
          publishedById: ctx.user.id,
          updatedAt: new Date(),
        })
        .where(eq(priceListDocuments.id, documentId));

      await audit(tx, ctx, {
        action: "pricelist.document.publish",
        entityType: "price_list_document",
        entityId: documentId,
        after: { priceListId: listId, rates: values.length, skipped: Number(skipped) },
      });
    });

    if (input.publishNow) {
      const published = await publishPriceList(listId, { supersedesId: input.supersedesId ?? null });
      if (!published.ok) {
        // The list exists as a draft, which is a state somebody can finish.
        return ok({ priceListId: listId, warnings: [...warnings, published.error] }, "Read in as a draft.");
      }
      warnings.push(...published.data.warnings);
    }

    refresh();
    return ok(
      { priceListId: listId, warnings },
      input.publishNow ? `${parsed.data.name} is in force.` : `${parsed.data.name} is a draft.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

export async function rejectDocument(documentId: string, reason: string): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    if (!reason.trim()) return fieldErr("reason", "Say why, so the next person does not upload it again.");
    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    if (!doc) return err("That document does not exist.", "not_found");
    if (doc.parseStatus === "published") return err("This one became a price list; withdraw the list instead.", "rule_violation");

    await db.transaction(async (tx) => {
      await tx
        .update(priceListDocuments)
        .set({
          parseStatus: "rejected",
          rejectedAt: new Date(),
          rejectedById: ctx.user.id,
          rejectReason: reason.trim(),
          updatedAt: new Date(),
        })
        .where(eq(priceListDocuments.id, documentId));
      await audit(tx, ctx, {
        action: "pricelist.document.reject",
        entityType: "price_list_document",
        entityId: documentId,
        after: { reason: reason.trim() },
      });
    });

    refresh();
    return okVoid("Rejected. It stays in the list with the reason on it.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function reparseDocument(documentId: string): Promise<Result<{ status: string; problems: string[] }>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    if (!doc) return err("That document does not exist.", "not_found");
    if (doc.parseStatus === "published") {
      return err("This one has already become a price list. Re-reading it would change nothing.", "rule_violation");
    }

    // Everything a person answered stands; the rest is read again. That is
    // what makes re-parsing safe after the reading rule changes.
    await db
      .delete(priceListParseRows)
      .where(and(eq(priceListParseRows.documentId, documentId), isNull(priceListParseRows.decidedById)));

    const { parseDocument } = await import("@/lib/services/price-list-parse-service");
    const result = await parseDocument(documentId);

    await db.transaction(async (tx) => {
      await audit(tx, ctx, {
        action: "pricelist.document.reparse",
        entityType: "price_list_document",
        entityId: documentId,
        after: { status: result.status },
      });
    });

    refresh();
    return ok(result, "Read again.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function deleteDocument(documentId: string): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    if (!doc) return err("That document does not exist.", "not_found");
    if (doc.parseStatus === "published") {
      return err("This one became a price list, and the list points back at it. Withdraw the list instead.", "rule_violation");
    }
    await db.transaction(async (tx) => {
      await audit(tx, ctx, {
        action: "pricelist.document.delete",
        entityType: "price_list_document",
        entityId: documentId,
        before: { filename: doc.filename },
      });
      await tx.delete(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    });
    refresh();
    return okVoid("Deleted.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------- a special price */

/** Whoever may decide one. The bell has to reach everybody who can answer. */
async function decidersOfPrices(): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select distinct u.id
      from users u
      left join app_access a on a.user_id = u.id
     where u.active
       and (u.role = 'admin'
            or (a.role in ('manager', 'admin') and a.app in ('crm', 'sales', 'accounts')))
  `);
  return [...rows].map((r) => r.id);
}

export async function requestSpecialPrice(input: {
  customerId: string;
  productId: string;
  requestedRateInclGstPaise: number;
  reason: string;
}): Promise<Result<{ id: string }>> {
  try {
    const ctx = await requireCapability("pricelist.read");
    if (!input.reason.trim()) {
      return fieldErr("reason", "Say why they should get a different price. Somebody has to weigh it.");
    }
    if (!Number.isInteger(input.requestedRateInclGstPaise) || input.requestedRateInclGstPaise <= 0) {
      return fieldErr("requestedRateInclGstPaise", "Type the price they are asking for.");
    }

    const [customer] = await db.execute<{
      id: string;
      name: string;
      kind: "lead" | "customer";
      ownerId: string | null;
      salesAmId: string | null;
      backOfficeAmId: string | null;
    }>(sql`
      select c.id, c.name, c.kind, c.owner_id as "ownerId", c.sales_am_id as "salesAmId",
             c.back_office_am_id as "backOfficeAmId"
        from customers c where c.id = ${input.customerId}
    `);
    if (!customer) return err("That customer does not exist.", "not_found");
    await assertCustomerInScope(customer as never);

    const day = await today();
    const [resolution, rates, config] = await Promise.all([
      resolveForCustomer(input.customerId, day),
      ratesForCustomer(input.customerId, [input.productId], day),
      getConfig(),
    ]);
    const current = rates[input.productId] ?? null;
    const gstBp = current?.gstBp ?? config["pricing.gstBp"];
    const requestedEx = exFromIncl(input.requestedRateInclGstPaise, gstBp);

    const id = gen("prq");
    await db.transaction(async (tx) => {
      await tx.insert(priceRequests).values({
        id,
        customerId: input.customerId,
        productId: input.productId,
        requestedRateExGstPaise: requestedEx,
        currentRateExGstPaise: current?.rateExGstPaise ?? null,
        currentListId: resolution?.listId ?? null,
        reason: input.reason.trim(),
        status: "pending",
        requestedById: ctx.user.id,
      });
      await audit(tx, ctx, {
        action: "pricelist.request.raise",
        entityType: "price_request",
        entityId: id,
        after: { customer: customer.name, requestedEx, currentEx: current?.rateExGstPaise ?? null },
      });
    });

    const [product] = await db.execute<{ name: string }>(sql`select name from products where id = ${input.productId}`);
    await notifyUsers(
      (await decidersOfPrices())
        .filter((uid) => uid !== ctx.user.id)
        .map((userId) => ({
          userId,
          title: "A special price has been asked for",
          body: `${ctx.user.name} has asked for ${customer.name} to pay a different price for ${product?.name ?? "a product"}. Reason: ${input.reason.trim()}`,
          kind: "info",
          href: "/sales/price-lists/requests",
        })),
    );

    refresh(input.customerId);
    return ok({ id }, "Asked. Whoever decides prices has been told.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function decidePriceRequest(
  id: string,
  input: { decision: "approved" | "refused"; note?: string; effectiveFrom?: string },
): Promise<Result<{ listId: string | null }>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const [row] = await db.select().from(priceRequests).where(eq(priceRequests.id, id));
    if (!row) return err("That request does not exist.", "not_found");
    if (row.status !== "pending") return err(`That request was already ${row.status}.`, "rule_violation");

    const day = await today();
    const effectiveFrom = input.effectiveFrom ?? day;
    if (!ISO_DATE.test(effectiveFrom)) return fieldErr("effectiveFrom", "That is not a date.");

    const [customer] = await db.execute<{ name: string }>(sql`select name from customers where id = ${row.customerId}`);
    const [product] = await db.execute<{ name: string }>(sql`select name from products where id = ${row.productId}`);

    let listId: string | null = null;
    if (input.decision === "approved") {
      const config = await getConfig();
      const parentList = row.currentListId ? await listRow(row.currentListId) : null;
      const gstBp = parentList?.gstBp ?? config["pricing.gstBp"];

      /* One special list per shop, not one per price. A shop that has been
       * given a second special price joins the list it already has, so
       * everything else keeps falling through to the ordinary list behind it. */
      const [existing] = await db.execute<{ id: string }>(sql`
        select l.id from price_lists l
          join price_list_scopes s on s.price_list_id = l.id
         where l.status = 'published'
           and s.scope_kind = 'customer' and s.scope_value = ${row.customerId}
         order by l.effective_from desc limit 1
      `);

      await db.transaction(async (tx) => {
        if (existing) {
          listId = existing.id;
          const ex = Number(row.requestedRateExGstPaise);
          const [already] = await tx.execute<{ id: string }>(sql`
            select r.id from price_list_rates r
             where r.price_list_id = ${existing.id} and r.product_id = ${row.productId}
               and coalesce(r.min_cans, 0) = 0
          `);
          if (already) {
            await tx
              .update(priceListRates)
              .set({
                rateExGstPaise: ex,
                rateInclGstPaise: inclFromEx(ex, gstBp),
                updatedAt: new Date(),
                updatedById: ctx.user.id,
              })
              .where(eq(priceListRates.id, already.id));
          } else {
            await tx.insert(priceListRates).values({
              id: gen("plr"),
              priceListId: existing.id,
              productId: row.productId,
              rateExGstPaise: ex,
              rateInclGstPaise: inclFromEx(ex, gstBp),
              matchStatus: "manual",
              updatedById: ctx.user.id,
            });
          }
        } else {
          listId = gen("pl");
          await tx.insert(priceLists).values({
            id: listId,
            name: `${customer?.name ?? "Customer"} — agreed prices`,
            version: 1,
            effectiveFrom,
            taxBasis: parentList?.taxBasis ?? "inclusive",
            gstBp,
            deliveryBasis: parentList?.deliveryBasis ?? null,
            freightTerm: "not_stated",
            parentListId: row.currentListId,
            status: "published",
            publishedAt: new Date(),
            publishedById: ctx.user.id,
            notes: `Agreed prices for this shop. Everything not listed here falls through to ${parentList?.name ?? "their ordinary list"}.`,
            createdById: ctx.user.id,
            updatedById: ctx.user.id,
          });
          await tx.insert(priceListRates).values({
            id: gen("plr"),
            priceListId: listId,
            productId: row.productId,
            rateExGstPaise: Number(row.requestedRateExGstPaise),
            rateInclGstPaise: inclFromEx(Number(row.requestedRateExGstPaise), gstBp),
            matchStatus: "manual",
            updatedById: ctx.user.id,
          });
          await tx.insert(priceListScopes).values({
            id: gen("pls"),
            priceListId: listId,
            scopeKind: "customer",
            scopeValue: row.customerId,
            scopeLabel: customer?.name ?? null,
            freightTermMatch: "any",
            priority: 0,
            createdById: ctx.user.id,
          });
        }

        await tx
          .update(priceRequests)
          .set({
            status: "approved",
            decidedById: ctx.user.id,
            decidedAt: new Date(),
            decisionNote: input.note?.trim() || null,
            resultingListId: listId,
            updatedAt: new Date(),
          })
          .where(eq(priceRequests.id, id));

        await audit(tx, ctx, {
          action: "pricelist.request.decide",
          entityType: "price_request",
          entityId: id,
          before: { status: "pending" },
          after: { status: "approved", listId },
        });
      });
    } else {
      await db.transaction(async (tx) => {
        await tx
          .update(priceRequests)
          .set({
            status: "refused",
            decidedById: ctx.user.id,
            decidedAt: new Date(),
            decisionNote: input.note?.trim() || null,
            updatedAt: new Date(),
          })
          .where(eq(priceRequests.id, id));
        await audit(tx, ctx, {
          action: "pricelist.request.decide",
          entityType: "price_request",
          entityId: id,
          before: { status: "pending" },
          after: { status: "refused", note: input.note?.trim() ?? null },
        });
      });
    }

    /* The person who asked is told, with the reason in the message rather than
     * behind a link — they have to ring the shop back and say something. */
    if (row.requestedById !== ctx.user.id) {
      await notifyUsers([
        {
          userId: row.requestedById,
          title: input.decision === "approved" ? "A special price was approved" : "A special price was refused",
          body:
            input.decision === "approved"
              ? `${customer?.name ?? "The customer"} now has an agreed price for ${product?.name ?? "that product"}.${input.note?.trim() ? ` ${input.note.trim()}` : ""}`
              : `The special price for ${customer?.name ?? "that customer"} on ${product?.name ?? "that product"} was not approved.${input.note?.trim() ? ` ${input.note.trim()}` : ""}`,
          kind: input.decision === "approved" ? "info" : "warn",
          href: `/crm/customers/${row.customerId}`,
        },
      ]);
    }

    refresh(row.customerId);
    return ok(
      { listId },
      input.decision === "approved" ? "Approved. The shop is on its own price from now on." : "Refused, and they have been told.",
    );
  } catch (e) {
    return fromThrown(e);
  }
}

export async function withdrawPriceRequest(id: string): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.read");
    const [row] = await db.select().from(priceRequests).where(eq(priceRequests.id, id));
    if (!row) return err("That request does not exist.", "not_found");
    if (row.requestedById !== ctx.user.id) {
      return err("Only the person who asked can withdraw it.", "not_permitted");
    }
    if (row.status !== "pending") return err(`That request was already ${row.status}.`, "rule_violation");

    await db.transaction(async (tx) => {
      await tx
        .update(priceRequests)
        .set({ status: "withdrawn", decidedAt: new Date(), updatedAt: new Date() })
        .where(eq(priceRequests.id, id));
      await audit(tx, ctx, {
        action: "pricelist.request.withdraw",
        entityType: "price_request",
        entityId: id,
        before: { status: "pending" },
      });
    });

    refresh(row.customerId);
    return okVoid("Withdrawn.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* --------------------------------------------------- one shop's own list */

export async function assignCustomerList(input: {
  customerId: string;
  priceListId: string | null;
  freightTerm?: "to_pay" | "paid" | null;
}): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const [customer] = await db.execute<{ id: string; name: string }>(sql`
      select id, name from customers where id = ${input.customerId}
    `);
    if (!customer) return err("That customer does not exist.", "not_found");
    if (input.priceListId) {
      const list = await listRow(input.priceListId);
      if (!list) return err("That price list does not exist.", "not_found");
      if (list.status !== "published") {
        return fieldErr("priceListId", `That list is ${list.status}, so nothing would be priced from it.`);
      }
    }

    await db.transaction(async (tx) => {
      // A shop is named by ONE list at a time; putting it on a second would
      // leave the priority to decide, which nobody would think to look at.
      await tx
        .delete(priceListScopes)
        .where(and(eq(priceListScopes.scopeKind, "customer"), eq(priceListScopes.scopeValue, input.customerId)));

      if (input.priceListId) {
        await tx.insert(priceListScopes).values({
          id: gen("pls"),
          priceListId: input.priceListId,
          scopeKind: "customer",
          scopeValue: input.customerId,
          scopeLabel: customer.name,
          freightTermMatch: "any",
          priority: 0,
          createdById: ctx.user.id,
        });
      }

      if (input.freightTerm !== undefined) {
        await tx.execute(sql`
          update customers set freight_term = ${input.freightTerm}, updated_at = now(), updated_by_id = ${ctx.user.id}
           where id = ${input.customerId}
        `);
      }

      await audit(tx, ctx, {
        action: "pricelist.customer.assign",
        entityType: "customer",
        entityId: input.customerId,
        after: { priceListId: input.priceListId, freightTerm: input.freightTerm ?? null },
      });
    });

    refresh(input.customerId);
    return okVoid(input.priceListId ? "Saved. This shop is priced from that list." : "Removed. They fall back to whichever list their area is on.");
  } catch (e) {
    return fromThrown(e);
  }
}
