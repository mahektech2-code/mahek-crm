"use server";

import { randomUUID, createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
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
  products,
  PRICE_DELIVERY_BASES,
  PRICE_DISCOUNT_KINDS,
  PRICE_FREIGHT_TERMS,
  PRICE_SCOPE_KINDS,
  type PriceDerivation,
  type PriceParsedHeader,
} from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { placeKey } from "@/lib/engines/price-resolution";
import { publishPriceList } from "@/lib/actions/price-lists";
import { bindAttachments, createAttachment } from "@/lib/services/attachment-service";
import { joinSignatory, verifySheet } from "@/lib/services/price-sheet-service";
import { pdfFilename } from "@/lib/price-sheet-pdf";
import { joinTerms, sheetRates, type PriceSheet } from "@/lib/price-sheet";
import { err, fieldErr, fromThrown, ok, type FieldError, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * A PRICE LIST MADE HERE RATHER THAN READ IN.
 *
 * The editor hands over a whole `PriceSheet` — the header, the grid, the
 * clauses, the discounts — and this file makes the list agree with it in one
 * transaction: header written, every rate replaced, every discount replaced,
 * and the scopes replaced where the editor sent them. Replace rather than
 * merge, because the sheet IS the list: a row taken off the grid is a rate
 * taken off the list, and a merge could never express that.
 *
 * THE RULES OF `price-lists.ts` STILL HOLD. A published list is never
 * rewritten — editing one here makes a new VERSION that supersedes it on
 * publish, so an order taken against August stays explainable. Only a draft
 * is updated in place.
 *
 * PUBLISHING STORES THE PAPER. The moment a list goes into force its PDF is
 * drawn, read back through the import pipeline, and kept as the list's own
 * document — the same shape an imported list has, so "what did we send them"
 * has one answer whichever way the list was made. A failure there never costs
 * the publish: the list is in force, and the warning says the document is
 * missing.
 * ------------------------------------------------------------------------- */

const gen = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function refresh() {
  try {
    for (const base of ["/sales", "/crm", "/accounts", "/founder"]) revalidatePath(`${base}/price-lists`, "layout");
  } catch {
    /* No request context — a job or a test. */
  }
}

type Ctx = { user: { id: string }; authorisedBy: string; authorisedIn: string | null };

async function audit(
  tx: { insert: typeof db.insert },
  ctx: Ctx,
  input: { action: string; entityId: string; entityType?: string; before?: unknown; after?: unknown },
) {
  await tx.insert(auditLog).values({
    id: gen("aud"),
    actorId: ctx.user.id,
    action: input.action,
    entityType: input.entityType ?? "price_list",
    entityId: input.entityId,
    actorRole: ctx.authorisedBy as never,
    actorApp: ctx.authorisedIn as never,
    beforeState: (input.before ?? null) as never,
    afterState: (input.after ?? null) as never,
  });
}

function zodErr(error: z.ZodError): ReturnType<typeof err> {
  const fieldErrors = error.issues.map<FieldError>((i) => ({ field: i.path.join(".") || "form", message: i.message }));
  return err(fieldErrors[0]?.message ?? "That is not valid.", "validation", fieldErrors);
}

/* ----------------------------------------------------------------- shapes */

const cellSchema = z.object({
  productId: z.string().nullable(),
  printedPaise: z.number().int().min(0).nullable(),
  offered: z.boolean(),
});

const sheetSchema = z.object({
  name: z.string().trim().min(1, "A list needs a name people will recognise."),
  refNo: z.string().trim().nullable(),
  effectiveFrom: z.string().regex(ISO_DATE, "That is not a date."),
  validityDays: z.number().int().min(0).max(3650).nullable(),
  taxBasis: z.enum(["inclusive", "exclusive"]),
  gstBp: z.number().int().min(0).max(5000),
  deliveryBasis: z.enum(PRICE_DELIVERY_BASES).nullable(),
  freightTerm: z.enum(PRICE_FREIGHT_TERMS),
  columns: z.array(
    z.object({
      key: z.string(),
      millilitres: z.number().nullable(),
      cansPerBox: z.number().nullable(),
      container: z.enum(["can", "tin", "drum", "loose"]),
      sizeLabel: z.string(),
      packLabel: z.string(),
    }),
  ).max(24, "A sheet with more than 24 pack sizes will not fit on paper."),
  rows: z.array(
    z.object({
      key: z.string(),
      label: z.string().trim().min(1, "Every row needs the name it is printed under."),
      familyKey: z.string(),
      cells: z.record(z.string(), cellSchema),
    }),
  ).max(400),
  terms: z.array(z.string()).max(40),
  discounts: z.array(
    z.object({
      kind: z.enum(PRICE_DISCOUNT_KINDS),
      percentBp: z.number().int().min(1).max(10_000),
      thresholdLitres: z.number().int().positive().nullable(),
      thresholdPaise: z.number().int().positive().nullable(),
    }),
  ).max(12),
  signatory: z.string().trim().nullable(),
  signatoryTitle: z.string().trim().nullable(),
});

const scopeSchema = z.object({
  kind: z.enum(PRICE_SCOPE_KINDS),
  value: z.string().default(""),
  label: z.string().nullish(),
  parentKey: z.string().default(""),
  freightTermMatch: z.enum(["any", "to_pay", "paid"]).default("any"),
});

export type SheetScopeInput = z.input<typeof scopeSchema>;

const GEOGRAPHY = new Set(["state", "district", "city", "area", "beat"]);

const derivationSchema: z.ZodType<PriceDerivation> = z.union([
  z.object({ kind: z.literal("per_litre_paise"), paise: z.number().int() }),
  z.object({ kind: z.literal("percent_bp"), bp: z.number().int() }),
  z.object({ kind: z.literal("per_can_paise"), paise: z.number().int() }),
]);

export type SaveSheetInput = {
  /** create a new draft · update a draft in place · version: a new draft superseding a published list. */
  mode: "create" | "update" | "version";
  listId?: string | null;
  sheet: PriceSheet;
  notes?: string | null;
  /** Null leaves a list's scopes exactly as they are. */
  scopes?: SheetScopeInput[] | null;
  parentListId?: string | null;
  derivation?: PriceDerivation | null;
  /** Set to put the list into force as it saves. */
  publish?: { supersedesId?: string | null } | null;
};

export type SaveSheetResult = {
  listId: string;
  published: boolean;
  documentId: string | null;
  warnings: string[];
  readBackOk: boolean | null;
};

/* ------------------------------------------------------------------- save */

export async function savePriceSheet(input: SaveSheetInput): Promise<Result<SaveSheetResult>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const parsed = sheetSchema.safeParse(input.sheet);
    if (!parsed.success) return zodErr(parsed.error);
    const sheet = parsed.data as PriceSheet;
    const scopes = input.scopes == null ? null : z.array(scopeSchema).safeParse(input.scopes);
    if (scopes && !scopes.success) return zodErr(scopes.error);
    const derivation = input.derivation ? derivationSchema.safeParse(input.derivation) : null;
    if (derivation && !derivation.success) return zodErr(derivation.error);

    const rates = sheetRates(sheet);
    if (input.publish && !rates.filter((r) => r.offered).length) {
      return err("No cell has a price. A list with no prices cannot be put in force — save it as a draft instead.", "rule_violation");
    }

    // Every SKU named has to exist. A product id the browser made up is a rate
    // on nothing, and a foreign key failing half way through is a worse answer.
    const ids = [...new Set(rates.map((r) => r.productId))];
    if (ids.length) {
      const known = await db.select({ id: products.id }).from(products).where(inArray(products.id, ids));
      if (known.length !== ids.length) return err("The sheet names a product the catalogue does not have. Reload the editor and try again.", "validation");
    }

    const source = input.listId
      ? (await db.select().from(priceLists).where(eq(priceLists.id, input.listId)))[0] ?? null
      : null;
    if (input.mode !== "create" && !source) return err("That price list does not exist.", "not_found");
    if (input.mode === "update" && source!.status !== "draft") {
      return err(
        `This list is ${source!.status}. What a customer was charged is not rewritten — save it as a new version instead.`,
        "rule_violation",
      );
    }

    const listId = input.mode === "update" ? source!.id : gen("pl");
    const header = {
      refNo: sheet.refNo?.trim() || null,
      name: sheet.name.trim(),
      effectiveFrom: sheet.effectiveFrom,
      validityDays: sheet.validityDays,
      taxBasis: sheet.taxBasis,
      gstBp: sheet.gstBp,
      deliveryBasis: sheet.deliveryBasis,
      freightTerm: sheet.freightTerm,
      termsText: joinTerms(sheet.terms),
      signatory: joinSignatory(sheet.signatory, sheet.signatoryTitle),
      notes: input.notes?.trim() || null,
      updatedAt: new Date(),
      updatedById: ctx.user.id,
    };

    await db.transaction(async (tx) => {
      if (input.mode === "update") {
        await tx.update(priceLists).set(header).where(eq(priceLists.id, listId));
      } else {
        await tx.insert(priceLists).values({
          id: listId,
          ...header,
          version: input.mode === "version" ? source!.version + 1 : 1,
          supersedesId: input.mode === "version" ? source!.id : null,
          parentListId: input.parentListId ?? (input.mode === "version" ? source!.parentListId : null),
          derivation: derivation?.data ?? (input.mode === "version" ? source!.derivation : null),
          unitBasis: source?.unitBasis ?? "per_can",
          freightPerLitrePaise: source?.freightPerLitrePaise ?? null,
          status: "draft",
          createdById: ctx.user.id,
        });
      }

      await tx.delete(priceListRates).where(eq(priceListRates.priceListId, listId));
      if (rates.length) {
        await tx.insert(priceListRates).values(
          rates.map((r) => ({
            id: gen("plr"),
            priceListId: listId,
            productId: r.productId,
            rateExGstPaise: r.rateExGstPaise,
            rateInclGstPaise: r.rateInclGstPaise,
            offered: r.offered,
            rawProductText: r.rawProductText,
            rawPackText: r.rawPackText,
            rawPriceText: r.rawPriceText,
            matchStatus: "manual" as const,
            updatedById: ctx.user.id,
          })),
        );
      }

      await tx.delete(priceListDiscountTerms).where(eq(priceListDiscountTerms.priceListId, listId));
      if (sheet.discounts.length) {
        await tx.insert(priceListDiscountTerms).values(
          sheet.discounts.map((d) => ({
            id: gen("plt"),
            priceListId: listId,
            kind: d.kind,
            percentBp: d.percentBp,
            thresholdLitres: d.thresholdLitres,
            thresholdPaise: d.thresholdPaise,
            rawText: null,
          })),
        );
      }

      // A new version with no scopes of its own inherits them, as the
      // "new version" action always has — a list that applies to nobody is
      // the silent failure of this whole module.
      const wanted =
        scopes?.data ??
        (input.mode === "version"
          ? (await tx.select().from(priceListScopes).where(eq(priceListScopes.priceListId, source!.id))).map((s) => ({
              kind: s.scopeKind as never,
              value: s.scopeValue,
              label: s.scopeLabel,
              parentKey: s.parentKey,
              freightTermMatch: s.freightTermMatch as "any" | "to_pay" | "paid",
              raw: true,
            }))
          : null);
      if (wanted) {
        await tx.delete(priceListScopes).where(eq(priceListScopes.priceListId, listId));
        for (const s of wanted) {
          const raw = "raw" in s;
          const value = raw || !GEOGRAPHY.has(s.kind) ? (s.value ?? "").trim() : placeKey(s.value ?? "");
          if (s.kind !== "everybody" && !value) continue;
          await tx.insert(priceListScopes).values({
            id: gen("pls"),
            priceListId: listId,
            scopeKind: s.kind,
            scopeValue: s.kind === "everybody" ? "" : value,
            scopeLabel: s.label ?? s.value ?? null,
            parentKey: raw || !GEOGRAPHY.has(s.kind) ? (s.parentKey ?? "") : placeKey(s.parentKey ?? ""),
            freightTermMatch: s.freightTermMatch ?? "any",
            createdById: ctx.user.id,
          });
        }
      }

      await audit(tx, ctx, {
        action: input.mode === "update" ? "pricelist.sheet.update" : input.mode === "version" ? "pricelist.sheet.version" : "pricelist.sheet.create",
        entityId: listId,
        before: source ? { id: source.id, status: source.status, version: source.version } : undefined,
        after: { name: header.name, effectiveFrom: header.effectiveFrom, rates: rates.length, rows: sheet.rows.length, columns: sheet.columns.length },
      });
    });

    const warnings: string[] = [];
    let published = false;
    let documentId: string | null = null;
    let readBackOk: boolean | null = null;

    if (input.publish) {
      const supersedesId = input.publish.supersedesId ?? (input.mode === "version" ? source!.id : null);
      const done = await publishPriceList(listId, { supersedesId });
      if (!done.ok) {
        refresh();
        return ok(
          { listId, published: false, documentId: null, warnings: [done.error], readBackOk: null },
          "Saved as a draft — it could not be put in force.",
        );
      }
      published = true;
      warnings.push(...done.data.warnings);
      try {
        const stored = await storeGeneratedDocument(listId, sheet, ctx.user.id);
        documentId = stored.documentId;
        readBackOk = stored.ok;
        if (!stored.ok) warnings.push("The PDF did not read back exactly as typed. Open the list's document to see which cells.");
      } catch (e) {
        warnings.push(`The list is in force, but its PDF could not be stored: ${e instanceof Error ? e.message : "unknown error"}.`);
      }
    }

    refresh();
    return ok(
      { listId, published, documentId, warnings, readBackOk },
      published ? `${sheet.name} is in force.` : input.mode === "update" ? "Draft saved." : `${sheet.name} is a draft.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * The issued paper, kept as the list's document and read back.
 *
 * Staged rows are written from the read-back with the SKU the sheet was built
 * with, so the document's review screen shows exactly what every imported
 * document shows — the grid as the reader saw it — and says "manual" where the
 * catalogue matcher would have chosen differently.
 */
async function storeGeneratedDocument(listId: string, sheet: PriceSheet, userId: string): Promise<{ documentId: string; ok: boolean }> {
  const verification = await verifySheet(sheet);
  const bytes = verification.bytes;
  const fileHash = createHash("sha256").update(bytes).digest("hex");

  const [existing] = await db.select({ id: priceListDocuments.id }).from(priceListDocuments).where(eq(priceListDocuments.fileHash, fileHash));
  let documentId = existing?.id ?? null;

  if (!documentId) {
    const filename = pdfFilename(sheet.name);
    const created = await createAttachment({ filename, bytes, declaredType: "application/pdf" });
    if (!created.ok) throw new Error(created.error);
    documentId = gen("pld");
    const header: PriceParsedHeader = {
      refNo: sheet.refNo,
      effectiveFrom: sheet.effectiveFrom,
      taxBasis: sheet.taxBasis,
      gstBp: sheet.gstBp,
      deliveryBasis: sheet.deliveryBasis,
      freightTerm: sheet.freightTerm,
      validityDays: sheet.validityDays,
      signatory: sheet.signatory,
      discountTerms: sheet.discounts.map((d) => ({ ...d, rawText: "" })),
      termsText: joinTerms(sheet.terms),
    };
    const problems = [
      ...verification.readBack.headerMismatches,
      ...(verification.readBack.priceMismatches ? [`${verification.readBack.priceMismatches} figure(s) read back differently from what was typed.`] : []),
    ];
    await db.insert(priceListDocuments).values({
      id: documentId,
      attachmentId: created.data.id,
      fileHash,
      filename,
      sourceKind: "pdf_text",
      byteSize: bytes.byteLength,
      pageCount: verification.pageCount,
      filenameHints: { region: null, freightTerm: sheet.freightTerm === "not_stated" ? null : sheet.freightTerm, monthIso: sheet.effectiveFrom.slice(0, 7), customer: null, tokens: ["generated"] },
      parseStatus: "published",
      parserVersion: null,
      modelUsed: null,
      layout: "grid",
      confidence: verification.confidence,
      extractedText: verification.extractedText,
      header,
      problems,
      priceListId: listId,
      uploadedById: userId,
      parsedAt: new Date(),
      publishedAt: new Date(),
      publishedById: userId,
    });
    await bindAttachments([created.data.id], "price_list_document", documentId);

    const rows = verification.readBack.cells.map((c, i) => {
      const col = i % Math.max(1, sheet.columns.length);
      const row = Math.floor(i / Math.max(1, sheet.columns.length));
      const cell = sheet.rows[row]?.cells[sheet.columns[col]?.key];
      const priced = !!cell?.offered && cell.printedPaise != null;
      const incl = !priced ? null : sheet.taxBasis === "inclusive" ? cell!.printedPaise! : null;
      return {
        id: gen("plp"),
        documentId: documentId!,
        page: 1,
        rowIndex: row,
        colIndex: col,
        rawProductText: c.rowLabel,
        rawPackText: `${c.sizeLabel} ${c.packLabel}`,
        rawPriceText: c.read ?? c.typed,
        millilitres: sheet.columns[col]?.millilitres ?? null,
        cansPerBox: sheet.columns[col]?.cansPerBox ?? null,
        container: sheet.columns[col]?.container ?? null,
        rateInclGstPaise: incl,
        rateExGstPaise: null,
        offered: priced,
        matchedProductId: cell?.productId ?? null,
        matchStatus: !cell?.productId ? ("skipped" as const) : c.sameProduct ? ("matched" as const) : ("manual" as const),
        matchConfidence: c.sameProduct ? 100 : null,
        candidates: [],
        problem: c.samePrice ? null : `Typed ${c.typed}, the paper reads ${c.read ?? "nothing"}.`,
        decidedById: userId,
        decidedAt: new Date(),
      };
    });
    if (rows.length) await db.insert(priceListParseRows).values(rows);
  }

  // A list that came from an imported PDF keeps that PDF as its source; one
  // made here takes the paper it was issued as.
  await db
    .update(priceLists)
    .set({ documentId })
    .where(and(eq(priceLists.id, listId), sql`${priceLists.documentId} is null`));
  return { documentId: documentId!, ok: verification.readBack.ok };
}

/* -------------------------------------------------------------- duplicate */

export async function duplicatePriceList(
  id: string,
  input: { name: string; effectiveFrom: string; refNo?: string | null; copyScopes: boolean },
): Promise<Result<{ id: string }>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    if (!input.name.trim()) return fieldErr("name", "A copy needs a name, or it will be mistaken for the list it came from.");
    if (!ISO_DATE.test(input.effectiveFrom)) return fieldErr("effectiveFrom", "That is not a date.");
    const [row] = await db.select().from(priceLists).where(eq(priceLists.id, id));
    if (!row) return err("That price list does not exist.", "not_found");

    const newId = gen("pl");
    await db.transaction(async (tx) => {
      await tx.insert(priceLists).values({
        id: newId,
        refNo: input.refNo === undefined ? row.refNo : input.refNo?.trim() || null,
        name: input.name.trim(),
        version: 1,
        supersedesId: null,
        documentId: null,
        effectiveFrom: input.effectiveFrom,
        validityDays: row.validityDays,
        taxBasis: row.taxBasis,
        gstBp: row.gstBp,
        deliveryBasis: row.deliveryBasis,
        freightTerm: row.freightTerm,
        freightPerLitrePaise: row.freightPerLitrePaise,
        // A copy stands on its own. Keeping the parent rule would make a copy
        // of "Odisha Paid" silently regenerate from "Odisha To Pay".
        parentListId: null,
        derivation: null,
        unitBasis: row.unitBasis,
        status: "draft",
        termsText: row.termsText,
        signatory: row.signatory,
        notes: row.notes,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      const rates = await tx.select().from(priceListRates).where(eq(priceListRates.priceListId, id));
      if (rates.length) {
        await tx.insert(priceListRates).values(
          rates.map((r) => ({
            id: gen("plr"),
            priceListId: newId,
            productId: r.productId,
            rateExGstPaise: Number(r.rateExGstPaise),
            rateInclGstPaise: Number(r.rateInclGstPaise),
            minCans: r.minCans,
            maxCans: r.maxCans,
            offered: r.offered,
            rawProductText: r.rawProductText,
            rawPackText: r.rawPackText,
            rawPriceText: r.rawPriceText,
            matchStatus: "manual" as const,
            updatedById: ctx.user.id,
          })),
        );
      }
      const terms = await tx.select().from(priceListDiscountTerms).where(eq(priceListDiscountTerms.priceListId, id));
      if (terms.length) {
        await tx.insert(priceListDiscountTerms).values(
          terms.map((t) => ({
            id: gen("plt"),
            priceListId: newId,
            kind: t.kind,
            percentBp: t.percentBp,
            thresholdLitres: t.thresholdLitres,
            thresholdPaise: t.thresholdPaise == null ? null : Number(t.thresholdPaise),
            rawText: t.rawText,
          })),
        );
      }
      if (input.copyScopes) {
        const scopes = await tx.select().from(priceListScopes).where(eq(priceListScopes.priceListId, id));
        if (scopes.length) {
          await tx.insert(priceListScopes).values(
            scopes.map((s) => ({
              id: gen("pls"),
              priceListId: newId,
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
        }
      }
      await audit(tx, ctx, {
        action: "pricelist.duplicate",
        entityId: newId,
        after: { from: id, name: input.name.trim(), rates: rates.length, copyScopes: input.copyScopes },
      });
    });

    refresh();
    return ok({ id: newId }, `${input.name.trim()} is a draft copy. Nothing is priced from it until it is published.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------------- bulk */

export type BulkOutcome = { id: string; name: string; ok: boolean; message: string };

/** Drafts only. A published list is what somebody was charged and is withdrawn, never deleted. */
export async function deleteDraftPriceLists(ids: string[]): Promise<Result<{ outcomes: BulkOutcome[] }>> {
  try {
    const ctx = await requireCapability("pricelist.manage");
    const rows = ids.length ? await db.select().from(priceLists).where(inArray(priceLists.id, ids)) : [];
    const outcomes: BulkOutcome[] = [];
    for (const row of rows) {
      if (row.status !== "draft") {
        outcomes.push({ id: row.id, name: row.name, ok: false, message: `${row.status} — withdraw it instead` });
        continue;
      }
      await db.transaction(async (tx) => {
        await audit(tx, ctx, { action: "pricelist.delete", entityId: row.id, before: { name: row.name } });
        await tx.delete(priceLists).where(eq(priceLists.id, row.id));
      });
      outcomes.push({ id: row.id, name: row.name, ok: true, message: "Deleted" });
    }
    refresh();
    const done = outcomes.filter((o) => o.ok).length;
    return ok({ outcomes }, `${done} draft${done === 1 ? "" : "s"} deleted.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/** Each through `publishPriceList`, so every one gets the same checks and the same audit row as one at a time. */
export async function publishDraftPriceLists(ids: string[]): Promise<Result<{ outcomes: BulkOutcome[] }>> {
  try {
    await requireCapability("pricelist.manage");
    const rows = ids.length ? await db.select().from(priceLists).where(inArray(priceLists.id, ids)) : [];
    const outcomes: BulkOutcome[] = [];
    for (const row of rows) {
      if (row.status !== "draft") {
        outcomes.push({ id: row.id, name: row.name, ok: false, message: `Already ${row.status}` });
        continue;
      }
      const r = await publishPriceList(row.id, { supersedesId: row.supersedesId });
      outcomes.push({ id: row.id, name: row.name, ok: r.ok, message: r.ok ? (r.data.warnings[0] ?? "In force") : r.error });
    }
    refresh();
    const done = outcomes.filter((o) => o.ok).length;
    return ok({ outcomes }, `${done} of ${rows.length} put in force.`);
  } catch (e) {
    return fromThrown(e);
  }
}
