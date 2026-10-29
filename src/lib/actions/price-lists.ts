"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  priceListDiscountTerms,
  priceListDocuments,
  priceListParseRows,
  priceListRates,
  priceListScopes,
  priceLists,
  priceRequests,
  productAliases,
  products,
  PRICE_DELIVERY_BASES,
  PRICE_DISCOUNT_KINDS,
  PRICE_FREIGHT_TERMS,
  PRICE_SCOPE_KINDS,
  type PriceDerivation,
  type PriceParsedHeader,
} from "@/db/schema";
import { requireCapability, assertCustomerInScope } from "@/lib/access-control";
import { removeDraftList, requirePriceDesk } from "@/lib/services/price-desk";
import { confirmImpact } from "@/lib/impact/registry";
import type { ImpactConfirmation } from "@/lib/impact/types";
import { getConfig } from "@/lib/config/store";
import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { notifyUsers } from "@/lib/notify";
import { deriveRate, exFromIncl, inclFromEx, listInclFromEx, roundToRupee } from "@/lib/engines/price-math";
import { money } from "@/lib/format";
import { AGREED_SCOPE_PRIORITY, placeKey } from "@/lib/engines/price-resolution";
import { canReread, isReading, pickDocumentRates, restage, stagedFigures, type TaxBasis } from "@/lib/engines/price-document";
import { ratesForCustomer, resolveForCustomer } from "@/lib/services/price-list-service";
import {
  draftOnlyRefusal,
  scopeDatesProblem,
  withdrawRefusal,
} from "@/lib/engines/price-supersede";
import { err, fieldErr, fromThrown, ok, okVoid, type FieldError, type Result } from "@/lib/result";
import { audit, draftVersionIn, lockedList, publishDraftIn, Refused, type VersionInput } from "@/lib/services/price-write";

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
    revalidatePath("/crm/price-lists");
    revalidatePath("/accounts/price-lists");
    revalidatePath("/founder/price-lists");
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

/* `requirePriceDesk` — the capability AND the desk it was worn at — lives in
   `services/price-desk.ts`, beside the one delete both action files share. */

async function listRow(id: string) {
  const [row] = await db.select().from(priceLists).where(eq(priceLists.id, id));
  return row ?? null;
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
    const ctx = await requirePriceDesk();
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
            /* A list generated by a rule shows the rupee — see `listInclFromEx`. */
            rateInclGstPaise: listInclFromEx(ex, gstBp, Boolean(input.derivation && parent)),
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
    const ctx = await requirePriceDesk();
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

export async function deleteDraftPriceList(id: string, confirmation?: ImpactConfirmation): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    const row = await listRow(id);
    if (!row) return err("That price list does not exist.", "not_found");
    if (row.status !== "draft") {
      return err(
        "Only a draft can be deleted. A list that has been published is what somebody was charged; withdraw it instead.",
        "rule_violation",
      );
    }
    /* The person saw what goes with it — rates, scopes, the document it was
       read from, the lists derived from it — and that is still the picture. */
    const refusal = await confirmImpact("price-list-draft", id, confirmation);
    if (refusal) return refusal;
    await db.transaction(async (tx) => {
      await audit(tx, ctx, { action: "pricelist.delete", entityType: "price_list", entityId: id, before: { name: row.name } });
      await removeDraftList(tx, id);
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
  derived: boolean,
): { ex: number; incl: number } | null {
  if (ex != null) return { ex, incl: listInclFromEx(ex, gstBp, derived) };
  if (incl != null) return { ex: exFromIncl(incl, gstBp), incl };
  return null;
}

export async function setRate(input: z.input<typeof rateInput>): Promise<Result<{ id: string }>> {
  try {
    const ctx = await requirePriceDesk();
    const parsed = rateInput.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);

    const list = await listRow(parsed.data.priceListId);
    if (!list) return err("That price list does not exist.", "not_found");
    /* A price is set on a DRAFT. A published list rewritten in place would
       price orders differently from that moment with no version recording
       it — the same reason `removeRate` and `bulkSetRates` refuse. */
    const notDraft = draftOnlyRefusal(list.status, "Changing a price on it");
    if (notDraft) return err(notDraft, "rule_violation");

    const rates = bothRates(parsed.data.rateExGstPaise, parsed.data.rateInclGstPaise, list.gstBp, list.derivation != null);
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

export async function removeRate(rateId: string, confirmation?: ImpactConfirmation): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    const [row] = await db.select().from(priceListRates).where(eq(priceListRates.id, rateId));
    if (!row) return err("That rate does not exist.", "not_found");
    const list = await listRow(row.priceListId);
    if (list && list.status !== "draft") {
      return err(
        `This list is ${list.status}. Taking a rate off it would change what a customer was charged; publish a new version instead.`,
        "rule_violation",
      );
    }
    /* A draft's rate, and the person saw which. */
    const refusal = await confirmImpact("price-rate", rateId, confirmation);
    if (refusal) return refusal;
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
    const ctx = await requirePriceDesk();
    const list = await listRow(input.priceListId);
    if (!list) return err("That price list does not exist.", "not_found");
    if (list.status !== "draft") {
      return err("Rates can be pasted into a draft. Publish a new version to change a list in force.", "rule_violation");
    }
    if (!input.rates.length) return err("Nothing to write.", "validation");

    let written = 0;
    await db.transaction(async (tx) => {
      for (const r of input.rates) {
        const rates = bothRates(r.rateExGstPaise, r.rateInclGstPaise, list.gstBp, list.derivation != null);
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
    const ctx = await requirePriceDesk();
    const parsed = scopeInput.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const list = await listRow(parsed.data.priceListId);
    if (!list) return err("That price list does not exist.", "not_found");

    const value = storedScopeValue(parsed.data.scopeKind, parsed.data.scopeValue);
    if (parsed.data.scopeKind !== "everybody" && !value) {
      return fieldErr("scopeValue", "Say which one this list applies to.");
    }
    const dates = scopeDatesProblem(parsed.data.validFrom, parsed.data.validTo);
    if (dates) return fieldErr("validTo", dates);

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
    const ctx = await requirePriceDesk();
    const [row] = await db.select().from(priceListScopes).where(eq(priceListScopes.id, id));
    if (!row) return err("That scope does not exist.", "not_found");
    for (const d of [input.validFrom, input.validTo]) {
      if (d && !ISO_DATE.test(d)) return fieldErr(d === input.validFrom ? "validFrom" : "validTo", "That is not a date.");
    }
    const dates = scopeDatesProblem(
      input.validFrom !== undefined ? input.validFrom : row.validFrom,
      input.validTo !== undefined ? input.validTo : row.validTo,
    );
    if (dates) return fieldErr("validTo", dates);

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

export async function removeScope(id: string, confirmation?: ImpactConfirmation): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    const [row] = await db.select().from(priceListScopes).where(eq(priceListScopes.id, id));
    if (!row) return err("That scope does not exist.", "not_found");
    /* Which shops stop being priced from this list, and where each lands. */
    const refusal = await confirmImpact("price-list-scope", id, confirmation);
    if (refusal) return refusal;
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
    const ctx = await requirePriceDesk();
    if (!PRICE_DISCOUNT_KINDS.includes(input.kind)) return fieldErr("kind", "That is not a kind of discount.");
    if (!Number.isInteger(input.percentBp) || input.percentBp <= 0 || input.percentBp > 10_000) {
      return fieldErr("percentBp", "A discount is a percentage above zero.");
    }
    const list = await listRow(input.priceListId);
    if (!list) return err("That price list does not exist.", "not_found");
    /* A discount printed under the prices is offered on every sales order
       naming the list — a term of the list, set on a draft like its rates. */
    const notDraft = draftOnlyRefusal(list.status, "Changing a discount on it");
    if (notDraft) return err(notDraft, "rule_violation");
    if (input.id) {
      const [term] = await db
        .select({ priceListId: priceListDiscountTerms.priceListId })
        .from(priceListDiscountTerms)
        .where(eq(priceListDiscountTerms.id, input.id));
      if (!term || term.priceListId !== input.priceListId) {
        return err("That discount is not on this list.", "not_found");
      }
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
          .where(and(eq(priceListDiscountTerms.id, input.id), eq(priceListDiscountTerms.priceListId, input.priceListId)));
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

export async function removeDiscountTerm(
  id: string,
  confirmation?: ImpactConfirmation,
  priceListId?: string,
): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    const [row] = await db.select().from(priceListDiscountTerms).where(eq(priceListDiscountTerms.id, id));
    if (!row) return err("That term does not exist.", "not_found");
    if (priceListId && row.priceListId !== priceListId) return err("That discount is not on this list.", "not_found");
    const list = await listRow(row.priceListId);
    const notDraft = list ? draftOnlyRefusal(list.status, "Taking a discount off it") : null;
    if (notDraft) return err(notDraft, "rule_violation");
    /* On a published list it leaves the printed sheet and every ERP sales
       order that names the list — the parties were listed by name. */
    const refusal = await confirmImpact("price-discount-term", id, confirmation);
    if (refusal) return refusal;
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
    const ctx = await requirePriceDesk();
    const first = await listRow(id);
    if (!first) return err("That price list does not exist.", "not_found");
    if (first.status !== "draft") return err(`This list is already ${first.status}.`, "rule_violation");

    const effectiveFrom = input?.effectiveFrom ?? first.effectiveFrom;
    if (!ISO_DATE.test(effectiveFrom)) return fieldErr("effectiveFrom", "That is not a date.");
    if (input?.supersedesId === id) return fieldErr("supersedesId", "A list cannot supersede itself.");

    /* A draft that is a CHANGE on a price book is published by approving the
       change, never from here: the change carries who made it, what was
       checked and who approved it, and publishing round it would skip all
       three. */
    const [change] = await db.execute<{ id: string; status: string }>(sql`
      select id, status from price_changes where draft_list_id = ${id} and status <> 'cancelled' limit 1
    `);
    if (change) {
      return err(
        "This draft is a change on a price book. Check it and send it for approval from the book; it goes live when somebody approves it.",
        "rule_violation",
      );
    }

    const config = await getConfig();
    const day = await today();
    /* EVERYTHING that decides is read inside the transaction, on locked rows.
       Read outside it, a double click or a second tab both saw a draft and
       both published — copying the old list's scopes twice. The status guard
       on the final update is the second half of the same answer. */
    const done = await db.transaction((tx) =>
      publishDraftIn(tx, ctx, id, { supersedesId: input?.supersedesId, effectiveFrom }, config, day),
    );

    refresh();
    return ok({ warnings: done.warnings }, `${done.name} is in force from ${effectiveFrom}.`);
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

export async function withdrawPriceList(id: string, reason: string, confirmation?: ImpactConfirmation): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    if (!reason.trim()) {
      return fieldErr("reason", "Say why it is being withdrawn. Somebody will ask what happened to this list.");
    }
    const row = await listRow(id);
    if (!row) return err("That price list does not exist.", "not_found");
    /* Only a list in force is withdrawn: a draft is deleted, and a superseded
       list already ended on the day its successor began — withdrawing it
       would rewrite that end date. */
    const notWithdrawable = withdrawRefusal(row.status);
    if (notWithdrawable) return err(notWithdrawable, "rule_violation");
    /* Every shop it prices falls to another list or to none — the person saw
       which, by name, and nothing has moved since. */
    const refusal = await confirmImpact("price-list-withdrawal", id, confirmation);
    if (refusal) return refusal;

    const day = await today();
    let restored: string | null = null;
    await db.transaction(async (tx) => {
      const locked = await lockedList(tx, id);
      if (!locked) throw new Refused(err("That price list does not exist.", "not_found"));
      const now = withdrawRefusal(locked.status);
      if (now) throw new Refused(err(now, "rule_violation"));
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
        .where(and(eq(priceLists.id, id), eq(priceLists.status, "published")));

      /* A version withdrawn BEFORE it took over never took over: the list it
         was to replace is still the one in force, and it goes on being so
         rather than ending on a day nothing replaces it. */
      if (locked.supersedesId && locked.effectiveFrom > day) {
        const back = await tx
          .update(priceLists)
          .set({ effectiveTo: null, updatedAt: new Date(), updatedById: ctx.user.id })
          .where(
            and(
              eq(priceLists.id, locked.supersedesId),
              eq(priceLists.status, "published"),
              eq(priceLists.effectiveTo, addDays(locked.effectiveFrom, -1)),
            ),
          )
          .returning({ id: priceLists.id });
        restored = back[0]?.id ?? null;
      }

      await audit(tx, ctx, {
        action: "pricelist.withdraw",
        entityType: "price_list",
        entityId: id,
        before: { status: row.status },
        after: { status: "withdrawn", reason: reason.trim(), predecessorRestored: restored },
      });
    });

    refresh();
    return okVoid(
      restored
        ? "Withdrawn before it started. The version it was to replace stays in force."
        : "Withdrawn. Nothing is priced from it from today.",
    );
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------- versioning */

export async function newVersion(id: string, input: VersionInput): Promise<Result<{ id: string }>> {
  try {
    const ctx = await requirePriceDesk();
    if (!ISO_DATE.test(input.effectiveFrom)) return fieldErr("effectiveFrom", "That is not a date.");

    const made = await db.transaction((tx) => draftVersionIn(tx, ctx, id, input));

    refresh();
    return ok(
      { id: made.id },
      made.existing
        ? `Version ${made.version} is already a draft — opened it rather than starting a second one.`
        : `Version ${made.version} is a draft. Change what has moved, then publish it.`,
    );
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

export async function bulkRevise(
  id: string,
  input: { derivation: PriceDerivation; effectiveFrom: string; name?: string; refNo?: string | null; roundToRupee: boolean },
): Promise<Result<{ id: string; sample: Array<{ productName: string; fromEx: number; toEx: number }> }>> {
  try {
    const ctx = await requirePriceDesk();
    const derivation = derivationSchema.safeParse(input.derivation);
    if (!derivation.success) return zodErr(derivation.error);
    if (!ISO_DATE.test(input.effectiveFrom)) return fieldErr("effectiveFrom", "That is not a date.");

    const sample: Array<{ productName: string; fromEx: number; toEx: number }> = [];
    /* ONE transaction: the new version and every moved rate, or neither. Two
       left a draft behind with the old prices in it whenever the second failed. */
    const newId = await db.transaction(async (tx) => {
      const made = await draftVersionIn(tx, ctx, id, input);
      if (made.existing) {
        /* Its rates may already have been changed by hand; moving them again
           would move them twice. */
        throw new Refused(
          err(
            `Version ${made.version} of this list is already a draft. Revise that draft, or delete it, before revising every price again.`,
            "conflict",
          ),
        );
      }
      const [list] = await tx.select().from(priceLists).where(eq(priceLists.id, made.id));
      const gstBp = list?.gstBp ?? 1800;

      const rows = await tx.execute<{
        id: string;
        productName: string;
        rateExGstPaise: number;
        millilitresPerCan: number | null;
      }>(sql`
        select r.id, p.name as "productName", r.rate_ex_gst_paise as "rateExGstPaise",
               p.millilitres_per_can as "millilitresPerCan"
          from price_list_rates r join products p on p.id = r.product_id
         where r.price_list_id = ${made.id}
         order by p.name asc
      `);

      for (const row of rows) {
        const from = Number(row.rateExGstPaise);
        const moved = deriveRate(from, row.millilitresPerCan, derivation.data);
        if (moved == null) continue;
        const to = input.roundToRupee ? roundToRupee(moved) : moved;
        await tx
          .update(priceListRates)
          .set({ rateExGstPaise: to, rateInclGstPaise: listInclFromEx(to, gstBp, list?.derivation != null), updatedAt: new Date(), updatedById: ctx.user.id })
          .where(eq(priceListRates.id, row.id));
        if (sample.length < 5) sample.push({ productName: row.productName, fromEx: from, toEx: to });
      }
      await audit(tx, ctx, {
        action: "pricelist.revise",
        entityType: "price_list",
        entityId: made.id,
        after: { from: id, derivation: derivation.data, rates: rows.length },
      });
      return made.id;
    });

    refresh();
    return ok({ id: newId, sample }, "Every rate has been moved. Check them, then publish.");
  } catch (e) {
    if (e instanceof Refused) return e.result;
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
    const ctx = await requirePriceDesk();
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

/**
 * A cell's price, corrected by a person — typed AS THE DOCUMENT PRINTS IT.
 * On a GST-extra list that is the ex figure, and the inclusive one is grossed
 * up beside it exactly as the reader stages it; it used to be stored as the
 * inclusive figure too, so a corrected cell went into force 18% short.
 */
export async function setParseRowPrice(input: {
  rowId: string;
  /** The figure as the document prints it, in the document's own tax basis. */
  printedPaise: number | null;
  offered: boolean;
}): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    if (input.offered && (input.printedPaise == null || !Number.isInteger(input.printedPaise) || input.printedPaise <= 0)) {
      return fieldErr("rateInclGstPaise", "Type the price as the document prints it, or say it is not offered.");
    }
    const [row] = await db.select().from(priceListParseRows).where(eq(priceListParseRows.id, input.rowId));
    if (!row) return err("That cell does not exist.", "not_found");

    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, row.documentId));
    if (doc?.parseStatus === "published") return err("This document is already a price list. Change the list instead.", "rule_violation");
    const config = await getConfig();
    const header = doc?.header as PriceParsedHeader | null;
    const gstBp = header?.gstBp ?? config["pricing.gstBp"];
    const basis: TaxBasis = header?.taxBasis ?? "inclusive";
    const figures = stagedFigures(input.offered ? input.printedPaise : null, basis, gstBp);
    const incl = figures.incl;

    await db.transaction(async (tx) => {
      await tx
        .update(priceListParseRows)
        .set({
          rateInclGstPaise: figures.incl,
          rateExGstPaise: figures.ex,
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
    const ctx = await requirePriceDesk();
    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    if (!doc) return err("That document does not exist.", "not_found");

    if (doc.parseStatus === "published") return err("This document is already a price list. Change the list instead.", "rule_violation");
    if (isReading(doc.parseStatus)) return err("This file is being read right now. Wait for the read to finish.", "rule_violation");

    const before = (doc.header as PriceParsedHeader | null) ?? null;
    const merged = { ...(before ?? {}), ...header } as PriceParsedHeader;
    const config = await getConfig();
    const from = { basis: (before?.taxBasis ?? "inclusive") as TaxBasis, gstBp: before?.gstBp ?? config["pricing.gstBp"] };
    const to = { basis: (merged.taxBasis ?? "inclusive") as TaxBasis, gstBp: merged.gstBp ?? config["pricing.gstBp"] };
    const repriced = from.basis !== to.basis || from.gstBp !== to.gstBp;
    await db.transaction(async (tx) => {
      await tx
        .update(priceListDocuments)
        .set({ header: merged, updatedAt: new Date() })
        .where(eq(priceListDocuments.id, documentId));
      /* A corrected tax basis or GST rate does not change what the paper
       * PRINTED; it changes what that figure means. Every staged cell is
       * worked out again from its printed figure, so publishing reads figures
       * that agree with the header it is published under. */
      if (repriced) {
        const staged = await tx
          .select({ id: priceListParseRows.id, rateInclGstPaise: priceListParseRows.rateInclGstPaise, rateExGstPaise: priceListParseRows.rateExGstPaise })
          .from(priceListParseRows)
          .where(eq(priceListParseRows.documentId, documentId));
        for (const r of staged) {
          if (r.rateInclGstPaise == null && r.rateExGstPaise == null) continue;
          const next = restage(r, from, to);
          await tx
            .update(priceListParseRows)
            .set({ rateInclGstPaise: next.incl, rateExGstPaise: next.ex, updatedAt: new Date() })
            .where(eq(priceListParseRows.id, r.id));
        }
      }
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
    const ctx = await requirePriceDesk();
    const parsed = listFields.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);

    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    if (!doc) return err("That document does not exist.", "not_found");
    if (doc.parseStatus === "published") {
      return err("This document has already been published as a price list.", "rule_violation");
    }
    if (isReading(doc.parseStatus)) {
      return err("This file is still being read. Wait for the read to finish, then publish it.", "rule_violation");
    }

    const header = (doc.header as PriceParsedHeader | null) ?? null;
    const config = await getConfig();
    const gstBp = parsed.data.gstBp ?? header?.gstBp ?? config["pricing.gstBp"];
    const taxBasis: TaxBasis = parsed.data.taxBasis ?? header?.taxBasis ?? "inclusive";
    // The figures were staged under the header the file was READ with; the
    // list goes into force under this one. Each rate is worked out again from
    // what the paper printed, so a basis or GST corrected on the publish form
    // re-prices nothing by accident.
    const readAs = { basis: (header?.taxBasis ?? "inclusive") as TaxBasis, gstBp: header?.gstBp ?? config["pricing.gstBp"] };

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

    // One rate per SKU: a grid prints one product once per column, but two
    // rows that resolve to the same SKU would collide on the unique index.
    // Which one wins is decided, never "the first": see `pickDocumentRates`.
    const pick = pickDocumentRates([...rows], readAs, { basis: taxBasis, gstBp });
    if (pick.conflicts.length) {
      const names = await db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(inArray(products.id, pick.conflicts.map((c) => c.productId)));
      const nameOf = new Map(names.map((n) => [n.id, n.name]));
      const said = pick.conflicts
        .slice(0, 3)
        .map((c) => `${nameOf.get(c.productId) ?? c.labels[0]} (${c.prices.map((p) => money(p)).join(" and ")})`)
        .join("; ");
      return err(
        `Two cells price the same product differently, so nothing was published: ${said}${pick.conflicts.length > 3 ? ` and ${pick.conflicts.length - 3} more` : ""}. Point one of the cells at a different product, or skip it, then publish.`,
        "rule_violation",
      );
    }

    const warnings: string[] = [];
    if (Number(skipped)) {
      warnings.push(`${skipped} cell${Number(skipped) === 1 ? "" : "s"} had no product and ${Number(skipped) === 1 ? "was" : "were"} left out.`);
    }
    if (pick.dropped) {
      warnings.push(`${pick.dropped} cell${pick.dropped === 1 ? "" : "s"} named a product another cell already priced, and ${pick.dropped === 1 ? "was" : "were"} left out.`);
    }

    const listId = gen("pl");
    let raced = false;

    await db.transaction(async (tx) => {
      /* ONE LIST PER DOCUMENT. The status was read outside this transaction,
       * so a double click or two tabs both passed it and made two lists. The
       * row is locked here and asked again; the loser writes nothing. */
      const [locked] = await tx.execute<{ parseStatus: string }>(sql`
        select parse_status as "parseStatus" from price_list_documents where id = ${documentId} for update
      `);
      if (!locked || locked.parseStatus === "published" || isReading(locked.parseStatus)) {
        raced = true;
        return;
      }
      await tx.insert(priceLists).values({
        id: listId,
        refNo: parsed.data.refNo?.trim() || header?.refNo || null,
        name: parsed.data.name,
        version: 1,
        documentId,
        effectiveFrom: parsed.data.effectiveFrom,
        validityDays: parsed.data.validityDays ?? header?.validityDays ?? null,
        taxBasis,
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
      for (const r of pick.chosen) {
        // A dash keeps its SKU and is stored as not offered — "we do not sell
        // this in this pack on this list" is a fact, and zero is not. The
        // inclusive figure is the one the paper PRINTED (on an inclusive
        // list), not one rebuilt from the ex figure a paisa away from it.
        values.push({
          id: gen("plr"),
          priceListId: listId,
          productId: r.matchedProductId,
          rateExGstPaise: r.ex ?? 0,
          rateInclGstPaise: r.incl ?? 0,
          offered: r.offered && r.ex != null,
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

    if (raced) return err("This document has already been published as a price list.", "rule_violation");

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
    const ctx = await requirePriceDesk();
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
        .where(and(eq(priceListDocuments.id, documentId), sql`${priceListDocuments.parseStatus} <> 'published'`));
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
    const ctx = await requirePriceDesk();
    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    if (!doc) return err("That document does not exist.", "not_found");
    if (doc.parseStatus === "published") {
      return err("This one has already become a price list. Re-reading it would change nothing.", "rule_violation");
    }
    if (doc.parseStatus === "rejected") {
      return err("This one was rejected. Upload it again if it should be read after all.", "rule_violation");
    }
    if (!canReread({ parseStatus: doc.parseStatus, stageStartedAt: doc.stageStartedAt, createdAt: doc.createdAt }, Date.now())) {
      return err("This file is being read right now. Wait for that read to finish before reading it again.", "rule_violation");
    }

    // Everything a person answered stands; the rest is read again — inside
    // `parseDocument`, after it has claimed the document, so a second press
    // cannot delete the rows a running read is about to write beside.
    const { parseDocument } = await import("@/lib/services/price-list-parse-service");
    const result = await parseDocument(documentId);
    if (result.refused) return err(result.problems[0] ?? "This file cannot be read again now.", "rule_violation");

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

export async function deleteDocument(documentId: string, confirmation?: ImpactConfirmation): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    if (!doc) return err("That document does not exist.", "not_found");
    if (doc.parseStatus === "published") {
      return err("This one became a price list, and the list points back at it. Withdraw the list instead.", "rule_violation");
    }
    /* Every price read off it, and whatever a person had already matched. */
    const refusal = await confirmImpact("price-document", documentId, confirmation);
    if (refusal) return refusal;
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

/**
 * Whoever may decide one. The bell has to reach everybody who can answer.
 *
 * Each is sent to the Requests tab in an app they actually HOLD — Accounts
 * first, where the price desk is, then the CRM. It used to point everybody at
 * the Sales Dashboard's copy, which has since been removed: prices are not
 * the Sales Dashboard's subject, so a sales manager is told only where he is
 * also a CRM or Accounts manager.
 */
async function decidersOfPrices(): Promise<Array<{ id: string; href: string }>> {
  const rows = await db.execute<{ id: string; accounts: boolean }>(sql`
    select u.id, bool_or(a.app = 'accounts') as accounts
      from users u
      left join app_access a on a.user_id = u.id
     where u.active
       and (u.role = 'admin'
            or (a.role in ('manager', 'admin') and a.app in ('crm', 'accounts')))
     group by u.id
  `);
  return [...rows].map((r) => ({
    id: r.id,
    href: r.accounts ? "/accounts/price-lists/requests" : "/crm/price-lists/requests",
  }));
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
        .filter((d) => d.id !== ctx.user.id)
        .map((d) => ({
          userId: d.id,
          title: "A special price has been asked for",
          body: `${ctx.user.name} has asked for ${customer.name} to pay a different price for ${product?.name ?? "a product"}. Reason: ${input.reason.trim()}`,
          kind: "info",
          href: d.href,
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
    const ctx = await requirePriceDesk();
    const [first] = await db.select().from(priceRequests).where(eq(priceRequests.id, id));
    if (!first) return err("That request does not exist.", "not_found");
    if (first.status !== "pending") return err(`That request was already ${first.status}.`, "rule_violation");

    const day = await today();
    const effectiveFrom = input.effectiveFrom ?? day;
    if (!ISO_DATE.test(effectiveFrom)) return fieldErr("effectiveFrom", "That is not a date.");

    const [customer] = await db.execute<{ name: string }>(sql`select name from customers where id = ${first.customerId}`);
    const [product] = await db.execute<{ name: string }>(sql`select name from products where id = ${first.productId}`);
    const config = await getConfig();

    let listId: string | null = null;
    /* The pending check is made on the LOCKED row. Read outside the
       transaction, two people deciding at once both saw "pending": two
       approvals made two agreed lists, and approve-against-refuse was won by
       whoever saved last while both were told they had decided it. */
    const row = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(priceRequests).where(eq(priceRequests.id, id)).for("update");
      if (!locked) throw new Refused(err("That request does not exist.", "not_found"));
      if (locked.status !== "pending") {
        throw new Refused(err(`That request has just been ${locked.status} by somebody else.`, "conflict"));
      }

      if (input.decision === "approved") {
        const ex = Number(locked.requestedRateExGstPaise);
        /* Serialise approvals for ONE shop, so two different requests for it
           cannot each find no agreed list and each make one. */
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"agreed-prices:" + locked.customerId}))`);

        /* The shop's OWN agreed-prices list, and nothing else. Any list with a
           customer scope naming the shop used to qualify — which is also what
           a shared list ASSIGNED to the shop looks like, so approving one
           shop's price rewrote it for every shop on that list. */
        const [existing] = await tx.execute<{ id: string; gstBp: number }>(sql`
          select l.id, l.gst_bp as "gstBp" from price_lists l
           where l.kind = 'agreed'
             and l.status = 'published'
             and (l.effective_to is null or l.effective_to >= ${day}::date)
             and exists (select 1 from price_list_scopes s
                          where s.price_list_id = l.id
                            and s.scope_kind = 'customer' and s.scope_value = ${locked.customerId})
             and not exists (select 1 from price_list_scopes s
                              where s.price_list_id = l.id
                                and not (s.scope_kind = 'customer' and s.scope_value = ${locked.customerId}))
           order by l.effective_from desc, l.id desc
           limit 1
           for update of l
        `);

        if (existing) {
          listId = existing.id;
          /* At the GST of the list being written, not the list behind it. */
          const gstBp = Number(existing.gstBp);
          const [already] = await tx.execute<{ id: string; rateExGstPaise: number }>(sql`
            select r.id, r.rate_ex_gst_paise as "rateExGstPaise" from price_list_rates r
             where r.price_list_id = ${existing.id} and r.product_id = ${locked.productId}
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
              productId: locked.productId,
              rateExGstPaise: ex,
              rateInclGstPaise: inclFromEx(ex, gstBp),
              matchStatus: "manual",
              updatedById: ctx.user.id,
            });
          }
          await audit(tx, ctx, {
            action: "pricelist.rate.set",
            entityType: "price_list",
            entityId: existing.id,
            before: already ? { productId: locked.productId, rateExGstPaise: Number(already.rateExGstPaise) } : undefined,
            after: { productId: locked.productId, rateExGstPaise: ex, request: id },
          });
        } else {
          const parentList = locked.currentListId ? await listRow(locked.currentListId) : null;
          const gstBp = parentList?.gstBp ?? config["pricing.gstBp"];
          listId = gen("pl");
          await tx.insert(priceLists).values({
            id: listId,
            name: `${customer?.name ?? "Customer"} — agreed prices`,
            version: 1,
            kind: "agreed",
            effectiveFrom,
            taxBasis: parentList?.taxBasis ?? "inclusive",
            gstBp,
            deliveryBasis: parentList?.deliveryBasis ?? null,
            freightTerm: "not_stated",
            parentListId: locked.currentListId,
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
            productId: locked.productId,
            rateExGstPaise: ex,
            rateInclGstPaise: inclFromEx(ex, gstBp),
            matchStatus: "manual",
            updatedById: ctx.user.id,
          });
          /* It LAYERS over whatever list the shop is assigned rather than
             competing with it: the agreed priority outranks every other
             customer scope (see AGREED_SCOPE_PRIORITY). */
          await tx.insert(priceListScopes).values({
            id: gen("pls"),
            priceListId: listId,
            scopeKind: "customer",
            scopeValue: locked.customerId,
            scopeLabel: customer?.name ?? null,
            freightTermMatch: "any",
            priority: AGREED_SCOPE_PRIORITY,
            createdById: ctx.user.id,
          });
        }
      }

      const decided = await tx
        .update(priceRequests)
        .set({
          status: input.decision,
          decidedById: ctx.user.id,
          decidedAt: new Date(),
          decisionNote: input.note?.trim() || null,
          resultingListId: input.decision === "approved" ? listId : null,
          updatedAt: new Date(),
        })
        .where(and(eq(priceRequests.id, id), eq(priceRequests.status, "pending")))
        .returning({ id: priceRequests.id });
      if (!decided.length) throw new Refused(err("That request has just been decided by somebody else.", "conflict"));

      await audit(tx, ctx, {
        action: "pricelist.request.decide",
        entityType: "price_request",
        entityId: id,
        before: { status: "pending" },
        after:
          input.decision === "approved"
            ? { status: "approved", listId }
            : { status: "refused", note: input.note?.trim() ?? null },
      });
      return locked;
    });

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
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

export async function withdrawPriceRequest(id: string, confirmation?: ImpactConfirmation): Promise<Result> {
  try {
    const ctx = await requireCapability("pricelist.read");
    const [row] = await db.select().from(priceRequests).where(eq(priceRequests.id, id));
    if (!row) return err("That request does not exist.", "not_found");
    if (row.requestedById !== ctx.user.id) {
      return err("Only the person who asked can withdraw it.", "not_permitted");
    }
    if (row.status !== "pending") return err(`That request was already ${row.status}.`, "rule_violation");
    const refusal = await confirmImpact("price-request-withdraw", id, confirmation);
    if (refusal) return refusal;

    await db.transaction(async (tx) => {
      const gone = await tx
        .update(priceRequests)
        .set({ status: "withdrawn", decidedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(priceRequests.id, id), eq(priceRequests.status, "pending")))
        .returning({ id: priceRequests.id });
      if (!gone.length) throw new Refused(err("That request has just been decided.", "conflict"));
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
    if (e instanceof Refused) return e.result;
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
    const ctx = await requirePriceDesk();
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
      if (list.kind === "agreed") {
        return fieldErr(
          "priceListId",
          "That is one shop's agreed prices. It sits on top of whatever list a shop is assigned; pick the ordinary list instead.",
        );
      }
    }

    await db.transaction(async (tx) => {
      // A shop is named by ONE list at a time; putting it on a second would
      // leave the priority to decide, which nobody would think to look at.
      //
      // What is replaced is the shop's ASSIGNMENT: a customer scope on an
      // ordinary list that still prices or will. Its agreed-prices list is not
      // an assignment — it layers on top — and a superseded or withdrawn
      // list's scope is the record of who that list priced, kept with it.
      await tx.execute(sql`
        delete from price_list_scopes s
         using price_lists l
         where l.id = s.price_list_id
           and s.scope_kind = 'customer'
           and s.scope_value = ${input.customerId}
           and l.kind <> 'agreed'
           and l.status in ('draft', 'published')
      `);

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
