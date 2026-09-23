import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { PriceDerivation, PriceListStatus } from "@/db/schema";
import { priceListDetail } from "@/lib/services/price-list-service";
import { parsePriceListText } from "@/lib/price-list-parse";
import { matchGrid, type AliasRow, type CatalogueSku } from "@/lib/price-list-match";
import { renderPriceSheetPdf } from "@/lib/price-sheet-pdf";
import {
  compareReadBack,
  isDiscountClause,
  sheetFromRates,
  splitTerms,
  type PriceSheet,
  type ReadBack,
  type SheetDiscount,
} from "@/lib/price-sheet";
import type { ScopeView } from "@/lib/price-list-views";

/* ---------------------------------------------------------------------------
 * A STORED LIST AS PAPER, AND PAPER READ BACK.
 *
 * Two jobs, and both are about the claim a generated price list makes: that
 * the document a shop is handed says what the database charges.
 *
 * `sheetForList` turns a list into the one model the PDF, the CSV, the print
 * page and the editor are all drawn from. `verifySheet` draws that model as a
 * PDF, reads the PDF back with the SAME extractor and parser an imported list
 * goes through, runs the same catalogue matcher over it, and says cell by
 * cell whether the paper agrees — the import pipeline run in reverse, which
 * is what makes it a proof rather than a preview.
 * ------------------------------------------------------------------------- */

/** The signatory column holds the name and, on a second line, the title under it. */
export function splitSignatory(raw: string | null): { name: string | null; title: string | null } {
  if (!raw?.trim()) return { name: null, title: null };
  const [name, ...rest] = raw.split(/\r?\n/);
  return { name: name.trim() || null, title: rest.join(" ").trim() || null };
}

export function joinSignatory(name: string | null | undefined, title: string | null | undefined): string | null {
  const n = name?.trim();
  const t = title?.trim();
  if (!n && !t) return null;
  return t ? `${n ?? ""}\n${t}` : (n ?? null);
}

export type ListSheet = {
  sheet: PriceSheet;
  listId: string;
  status: PriceListStatus;
  version: number;
  notes: string | null;
  parentListId: string | null;
  derivation: PriceDerivation | null;
  scopes: ScopeView[];
  /** Keyed by product id — what each SKU costs on this list, printed basis, for "moved by" hints. */
  baseline: Record<string, number>;
};

export async function sheetForList(id: string): Promise<ListSheet | null> {
  const detail = await priceListDetail(id);
  if (!detail) return null;
  const l = detail.list;
  const discounts: SheetDiscount[] = detail.discountTerms.map((d) => ({
    kind: d.kind,
    percentBp: d.percentBp,
    thresholdLitres: d.thresholdLitres,
    thresholdPaise: d.thresholdPaise == null ? null : Number(d.thresholdPaise),
  }));
  const signatory = splitSignatory(l.signatory);
  const sheet = sheetFromRates(
    {
      name: l.name,
      refNo: l.refNo,
      effectiveFrom: l.effectiveFrom,
      validityDays: l.validityDays,
      taxBasis: l.taxBasis,
      gstBp: l.gstBp,
      deliveryBasis: l.deliveryBasis,
      freightTerm: l.freightTerm,
      // The discount sentence an imported document carried is the structured
      // term now; printing both would say it twice.
      terms: splitTerms(l.termsText).filter((t) => !isDiscountClause(t, discounts)),
      discounts,
      signatory: signatory.name,
      signatoryTitle: signatory.title,
    },
    detail.rates.map((r) => ({
      productId: r.productId,
      rateExGstPaise: Number(r.rateExGstPaise),
      rateInclGstPaise: Number(r.rateInclGstPaise),
      offered: r.offered,
      minCans: r.minCans,
      rawProductText: r.rawProductText,
      product: {
        id: r.productId,
        name: r.productName,
        millilitresPerCan: r.millilitresPerCan,
        cansPerBox: r.cansPerBox,
        packing: r.packing,
        brandName: r.brandName,
        formulationName: r.formulationName,
        active: r.productActive,
      },
    })),
  );
  const baseline: Record<string, number> = {};
  for (const r of detail.rates) {
    if (r.offered) baseline[r.productId] = l.taxBasis === "inclusive" ? Number(r.rateInclGstPaise) : Number(r.rateExGstPaise);
  }
  return {
    sheet,
    listId: l.id,
    status: l.status,
    version: l.version,
    notes: l.notes,
    parentListId: l.parentListId,
    derivation: l.derivation,
    scopes: detail.scopes,
    baseline,
  };
}

export async function sheetsForLists(ids: string[]): Promise<ListSheet[]> {
  const out: ListSheet[] = [];
  for (const id of ids) {
    const s = await sheetForList(id);
    if (s) out.push(s);
  }
  return out;
}

/* ------------------------------------------------------------- read back */

async function catalogue(): Promise<{ skus: CatalogueSku[]; aliases: AliasRow[] }> {
  const skus = await db.execute<CatalogueSku>(sql`
    select p.id, p.name,
           p.millilitres_per_can as "millilitresPerCan",
           p.cans_per_box as "cansPerBox",
           p.packing,
           b.name as "brandName",
           f.name as "formulationName",
           p.finished_good_id as "finishedGoodId",
           p.active
      from products p
      left join product_brands b on b.id = p.brand_id
      left join product_formulations f on f.id = p.formulation_id
     where p.finished_good_id is not null
  `);
  const aliases = await db.execute<AliasRow>(sql`select name, product_id as "productId" from product_aliases`);
  return { skus: [...skus], aliases: [...aliases] };
}

export type VerifyStage = { key: string; label: string; detail: string; ms: number };

export type Verification = {
  readBack: ReadBack;
  stages: VerifyStage[];
  pageCount: number;
  byteSize: number;
  extractedText: string;
  confidence: number;
  warnings: string[];
  bytes: Uint8Array;
};

/**
 * Draw it, read it, match it, compare it — the import pipeline in reverse.
 *
 * Each stage is timed and described, because the editor shows the stages as
 * they were actually run: a reviewer who watched their own list go through the
 * same reader every imported list goes through has a reason to trust the file.
 */
export async function verifySheet(sheet: PriceSheet): Promise<Verification> {
  const stages: VerifyStage[] = [];
  let t = Date.now();
  const lap = (key: string, label: string, detail: string) => {
    const now = Date.now();
    stages.push({ key, label, detail, ms: now - t });
    t = now;
  };

  const bytes = await renderPriceSheetPdf(sheet);
  lap("drawing", "Drew the PDF", `${Math.max(1, Math.round(bytes.byteLength / 1024))} KB, Mahek's own layout`);

  const { extractText, getDocumentProxy } = await import("unpdf");
  // A copy: pdf.js transfers the buffer it is handed, and these bytes are
  // stored afterwards.
  const pdf = await getDocumentProxy(bytes.slice());
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((p) => p ?? "");
  const lines = pages.join("\n").split("\n").filter((l) => l.trim()).length;
  lap("extracting", "Read the words off the page", `${totalPages} page${totalPages === 1 ? "" : "s"}, ${lines} lines of text`);

  const parsed = parsePriceListText(pages);
  lap("classifying", "Read the grid", `${parsed.rows.length} products × ${parsed.columns.length} pack sizes, ${parsed.layout} layout`);

  const { skus, aliases } = await catalogue();
  const matches = matchGrid(parsed, skus, aliases);
  const matched = [...matches.values()].filter((m) => m.productId).length;
  lap("matching", "Matched each cell to the catalogue", `${matched} of ${matches.size} cells named a product`);

  const readBack = compareReadBack(sheet, parsed, matches);
  lap(
    "validating",
    "Compared the paper with what was typed",
    readBack.ok
      ? `Every figure reads back exactly${readBack.productMismatches ? `; ${readBack.productMismatches} cell${readBack.productMismatches === 1 ? "" : "s"} would match a different SKU on import` : ""}`
      : `${readBack.priceMismatches + readBack.missing} cell${readBack.priceMismatches + readBack.missing === 1 ? "" : "s"} and ${readBack.headerMismatches.length} header fact${readBack.headerMismatches.length === 1 ? "" : "s"} differ`,
  );

  return {
    readBack,
    stages,
    pageCount: totalPages,
    byteSize: bytes.byteLength,
    extractedText: pages.join("\n\f\n"),
    confidence: parsed.confidence,
    warnings: parsed.warnings,
    bytes,
  };
}
