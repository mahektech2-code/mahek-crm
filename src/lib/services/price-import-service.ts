import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { PriceFilenameHints, PriceParsedHeader } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { isReading, pickDocumentRates, printedOf, type PublishPick, type TaxBasis } from "@/lib/engines/price-document";
import { rankBooks, type MatchBook } from "@/lib/engines/price-book-match";
import { compareReaders, countVerdicts, type ModelCell } from "@/lib/engines/price-cross-read";
import { countChanges, diffRates, type ChangeRate } from "@/lib/engines/price-change";
import { changeRatesOf, listBooks } from "@/lib/services/price-book-service";
import { aiReadiness, PROVIDER_LABEL } from "@/lib/price-ai/providers";
import { CROSS_READ_FEATURE } from "@/lib/price-ai/pdf-read";
import type { BookMatchView, CrossReadView, ImportFacts, ImportPreview } from "@/lib/price-import-views";

/** What the review screen and the import workbench draw beside a document. */
export async function importFactsFor(documentId: string): Promise<ImportFacts> {
  const [match, cross, ai] = await Promise.all([bookMatchesForDocument(documentId), crossReadFor(documentId), aiReadiness()]);
  return { match, cross, ai };
}

/* ---------------------------------------------------------------------------
 * A PDF YOU ALREADY HAVE, AS A CHANGE ON ITS BOOK — the reads.
 *
 * Three questions, each answered from what is stored: which book does this
 * document look like (`bookMatchesForDocument`), what would it move on that
 * book (`documentChangePreview`), and do the three readers agree about each
 * cell (`crossReadFor`). The writes are in `actions/price-imports.ts`; the
 * rules in `engines/price-book-match.ts` and `engines/price-cross-read.ts`.
 * ------------------------------------------------------------------------- */

type DocRow = {
  id: string;
  filename: string;
  parseStatus: string;
  stageStartedAt: string | null;
  createdAt: string;
  header: PriceParsedHeader | null;
  filenameHints: PriceFilenameHints | null;
  priceListId: string | null;
};

async function documentRow(documentId: string): Promise<DocRow | null> {
  const [row] = await db.execute<DocRow>(sql`
    select id, filename, parse_status as "parseStatus",
           to_char(stage_started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "stageStartedAt",
           to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt",
           header, filename_hints as "filenameHints", price_list_id as "priceListId"
      from price_list_documents where id = ${documentId}
  `);
  return row ?? null;
}

/** Why a document cannot become a change at all, whatever book is picked. */
export function documentRefusal(status: string): string | null {
  if (status === "published") return "This document has already been brought in — as a price list or a change.";
  if (status === "rejected") return "This document was rejected. Upload it again if it should be read after all.";
  if (status === "failed") return "This document could not be read. Read it again first.";
  if (status === "queued" || isReading(status)) {
    return "This file is still being read. Wait for the read to finish.";
  }
  return null;
}

/* ------------------------------------------------------------- the pick */

export type DocumentPickRow = {
  matchedProductId: string;
  rateExGstPaise: number | null;
  rateInclGstPaise: number | null;
  offered: boolean;
  rawProductText: string;
  rawPackText: string | null;
  rawPriceText: string | null;
  matchStatus: string;
  matchConfidence: number | null;
  rowIndex: number;
  colIndex: number;
};

export type DocumentPick = {
  header: PriceParsedHeader | null;
  pick: PublishPick<DocumentPickRow>;
  /** Held cells that carry a price — bringing the file in as it stands would lose them. */
  heldPriced: number;
  /** Cells the matcher only guessed, which are left out. */
  suggested: number;
  final: { basis: TaxBasis; gstBp: number };
};

/**
 * One rate per SKU, exactly as `publishDocument` picks them — confirmed
 * matches only, figures worked out again under `final` from what the paper
 * printed under the header it was read with.
 */
export async function documentPick(documentId: string, final?: { basis?: TaxBasis | null; gstBp?: number | null }): Promise<DocumentPick | null> {
  const doc = await documentRow(documentId);
  if (!doc) return null;
  const config = await getConfig();
  const header = doc.header;
  const readAs = { basis: (header?.taxBasis ?? "inclusive") as TaxBasis, gstBp: header?.gstBp ?? config["pricing.gstBp"] };
  const to = { basis: (final?.basis ?? readAs.basis) as TaxBasis, gstBp: final?.gstBp ?? readAs.gstBp };
  const rows = await db.execute<DocumentPickRow>(sql`
    select r.matched_product_id as "matchedProductId", r.rate_ex_gst_paise as "rateExGstPaise",
           r.rate_incl_gst_paise as "rateInclGstPaise", r.offered,
           r.raw_product_text as "rawProductText", r.raw_pack_text as "rawPackText",
           r.raw_price_text as "rawPriceText", r.match_status as "matchStatus",
           r.match_confidence as "matchConfidence", r.row_index as "rowIndex", r.col_index as "colIndex"
      from price_list_parse_rows r
     where r.document_id = ${documentId}
       and r.matched_product_id is not null
       and r.match_status in ('matched', 'alias', 'manual')
     order by r.row_index asc, r.col_index asc
  `);
  const coerced = [...rows].map((r) => ({
    ...r,
    rateExGstPaise: r.rateExGstPaise == null ? null : Number(r.rateExGstPaise),
    rateInclGstPaise: r.rateInclGstPaise == null ? null : Number(r.rateInclGstPaise),
  }));
  const [counts] = await db.execute<{ heldPriced: number; suggested: number }>(sql`
    select count(*) filter (where r.match_status = 'held' and r.offered
                              and (r.rate_incl_gst_paise is not null or r.rate_ex_gst_paise is not null))::int as "heldPriced",
           count(*) filter (where r.match_status = 'suggested')::int as suggested
      from price_list_parse_rows r where r.document_id = ${documentId}
  `);
  return {
    header,
    pick: pickDocumentRates(coerced, readAs, to),
    heldPriced: Number(counts?.heldPriced ?? 0),
    suggested: Number(counts?.suggested ?? 0),
    final: to,
  };
}

/** What stops a pick becoming a change, in words. */
export async function pickBlockers(p: DocumentPick): Promise<string[]> {
  const out: string[] = [];
  if (p.heldPriced) out.push(`${p.heldPriced} price${p.heldPriced === 1 ? "" : "s"} on the paper ${p.heldPriced === 1 ? "has" : "have"} no product yet. Answer the held cells first.`);
  if (p.pick.conflicts.length) {
    const names = await productNames(p.pick.conflicts.map((c) => c.productId));
    out.push(
      `Two cells price the same product differently: ${p.pick.conflicts
        .slice(0, 3)
        .map((c) => names.get(c.productId) ?? c.labels[0])
        .join("; ")}${p.pick.conflicts.length > 3 ? ` and ${p.pick.conflicts.length - 3} more` : ""}.`,
    );
  }
  if (!p.pick.chosen.length) out.push("No cell in this document has been matched to a product.");
  return out;
}

async function productNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db.execute<{ id: string; name: string }>(sql`
    select id, name from products where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
  `);
  return new Map([...rows].map((r) => [r.id, r.name]));
}

/** The pick as the change engine reads rates. */
export async function pickAsRates(p: DocumentPick): Promise<ChangeRate[]> {
  const ids = [...new Set(p.pick.chosen.map((c) => c.matchedProductId))];
  if (!ids.length) return [];
  const rows = await db.execute<{ id: string; name: string; brandName: string | null; ml: number | null }>(sql`
    select p.id, p.name, b.name as "brandName", p.millilitres_per_can as ml
      from products p left join product_brands b on b.id = p.brand_id
     where p.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
  `);
  const byId = new Map([...rows].map((r) => [r.id, r]));
  return p.pick.chosen.map((c) => {
    const pr = byId.get(c.matchedProductId);
    const name = pr?.name ?? c.rawProductText;
    return {
      productId: c.matchedProductId,
      productName: name,
      family: pr?.brandName ?? (name.includes(" - ") ? name.slice(0, name.indexOf(" - ")) : name),
      millilitresPerCan: pr?.ml == null ? null : Number(pr.ml),
      minCans: null,
      rateExGstPaise: c.ex ?? 0,
      rateInclGstPaise: c.incl ?? 0,
      offered: c.offered && c.ex != null,
    };
  });
}

/* ------------------------------------------------------------ the match */

/** Which book this document most looks like. */
export async function bookMatchesForDocument(documentId: string): Promise<BookMatchView | null> {
  const doc = await documentRow(documentId);
  if (!doc) return null;
  const [books, staged, made] = await Promise.all([
    listBooks(),
    db.execute<{ productId: string }>(sql`
      select distinct matched_product_id as "productId" from price_list_parse_rows
       where document_id = ${documentId} and matched_product_id is not null and match_status <> 'held'
    `),
    db.execute<{ changeId: string; bookId: string; bookName: string }>(sql`
      select pc.id as "changeId", pc.book_id as "bookId", l.name as "bookName"
        from price_changes pc join price_lists l on l.id = pc.draft_list_id
       where pc.source_document_id = ${documentId} and pc.status <> 'cancelled'
       order by pc.created_at desc limit 1
    `),
  ]);
  const eligible = books.filter((b) => b.kind === "standard" && (b.live || b.scheduled));
  const listIds = eligible.map((b) => (b.live ?? b.scheduled)!.listId);
  const facts = listIds.length
    ? await db.execute<{ id: string; refNo: string | null; deliveryBasis: string | null; taxBasis: string; gstBp: number }>(sql`
        select id, ref_no as "refNo", delivery_basis as "deliveryBasis", tax_basis as "taxBasis", gst_bp as "gstBp"
          from price_lists where id in (${sql.join(listIds.map((i) => sql`${i}`), sql`, `)})
      `)
    : [];
  const products = listIds.length
    ? await db.execute<{ listId: string; productId: string }>(sql`
        select distinct price_list_id as "listId", product_id as "productId" from price_list_rates
         where price_list_id in (${sql.join(listIds.map((i) => sql`${i}`), sql`, `)})
      `)
    : [];
  const factOf = new Map([...facts].map((f) => [f.id, f]));
  const productsOf = new Map<string, string[]>();
  for (const p of products) productsOf.set(p.listId, [...(productsOf.get(p.listId) ?? []), p.productId]);

  const matchBooks: MatchBook[] = eligible.map((b) => {
    const listId = (b.live ?? b.scheduled)!.listId;
    const f = factOf.get(listId);
    return {
      bookId: b.id,
      name: b.name,
      kind: b.kind,
      refNo: f?.refNo ?? null,
      freightTerm: b.freightTerm,
      deliveryBasis: f?.deliveryBasis ?? null,
      taxBasis: f?.taxBasis ?? null,
      gstBp: f?.gstBp == null ? null : Number(f.gstBp),
      productIds: productsOf.get(listId) ?? [],
    };
  });
  const h = doc.header;
  const match = rankBooks(
    {
      listName: h?.listName ?? null,
      refNo: h?.refNo ?? null,
      freightTerm: h?.freightTerm ?? null,
      deliveryBasis: h?.deliveryBasis ?? null,
      taxBasis: h?.taxBasis ?? null,
      gstBp: h?.gstBp ?? null,
      filename: doc.filename,
      hints: doc.filenameHints,
      productIds: [...staged].map((s) => s.productId),
    },
    matchBooks,
  );
  const openChanges: BookMatchView["openChanges"] = {};
  for (const b of eligible) {
    if (b.openChange) openChanges[b.id] = { changeId: b.openChange.id, title: b.openChange.title, makerName: b.openChange.makerName };
  }
  return {
    documentId,
    candidates: match.candidates,
    winner: match.winner,
    openChanges,
    refusal: documentRefusal(doc.parseStatus),
    madeChange: made[0] ?? null,
  };
}

/** Every cell the document would put on the book beside what the book charges today. */
export async function documentChangePreview(documentId: string, bookId: string): Promise<ImportPreview | null> {
  const books = await listBooks();
  const book = books.find((b) => b.id === bookId);
  if (!book) return null;
  const base = book.live ?? book.scheduled;
  const [facts] = base
    ? await db.execute<{ taxBasis: string; gstBp: number }>(sql`select tax_basis as "taxBasis", gst_bp as "gstBp" from price_lists where id = ${base.listId}`)
    : [];
  const doc = await documentRow(documentId);
  if (!doc) return null;
  const p = await documentPick(documentId, {
    basis: (doc.header?.taxBasis ?? facts?.taxBasis ?? null) as TaxBasis | null,
    gstBp: doc.header?.gstBp ?? (facts?.gstBp == null ? null : Number(facts.gstBp)),
  });
  if (!p) return null;
  const [before, after, blockers] = await Promise.all([base ? changeRatesOf(base.listId) : Promise.resolve([]), pickAsRates(p), pickBlockers(p)]);
  const diffs = diffRates(before, after);
  const c = countChanges(diffs);
  const warnings: string[] = [];
  if (p.suggested) warnings.push(`${p.suggested} cell${p.suggested === 1 ? " the matcher only guessed is" : "s the matcher only guessed are"} left out. Confirm them on the review screen to bring them in.`);
  if (p.pick.dropped) warnings.push(`${p.pick.dropped} cell${p.pick.dropped === 1 ? "" : "s"} named a product another cell already priced.`);
  if (c.removed) warnings.push(`${c.removed} product${c.removed === 1 ? " the book carries is" : "s the book carries are"} not on the paper and would come off the book.`);
  return {
    bookId,
    bookName: book.name,
    againstVersion: base?.version ?? null,
    rows: diffs.map((d) => ({
      key: d.key,
      productId: d.productId,
      productName: d.productName,
      beforeIncl: d.before?.rateInclGstPaise ?? null,
      afterIncl: d.after?.rateInclGstPaise ?? null,
      kind: d.kind,
      changeBp: d.changeBp,
    })),
    counts: { up: c.up, down: c.down, added: c.added, removed: c.removed, same: diffs.length - c.changed },
    blockers: documentRefusal(doc.parseStatus) ? [documentRefusal(doc.parseStatus)!, ...blockers] : blockers,
    warnings,
  };
}

/* ------------------------------------------------------ three readers */

type RunRow = { provider: "openai" | "anthropic"; model: string | null; ok: boolean; output: unknown; error: string | null; at: string };

/** The newest cross-read of each model, compared with the text reader's cells. */
export async function crossReadFor(documentId: string): Promise<CrossReadView> {
  const [runs, staged, doc, config] = await Promise.all([
    db.execute<RunRow>(sql`
      select distinct on (provider) provider, model, ok, output, error,
             to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
        from price_ai_runs
       where subject_kind = 'price_list_document' and subject_id = ${documentId} and feature = ${CROSS_READ_FEATURE}
       order by provider, created_at desc
    `),
    db.execute<{ id: string; rawProductText: string; rawPackText: string | null; millilitres: number | null; rateInclGstPaise: number | null; rateExGstPaise: number | null }>(sql`
      select id, raw_product_text as "rawProductText", raw_pack_text as "rawPackText", millilitres,
             rate_incl_gst_paise as "rateInclGstPaise", rate_ex_gst_paise as "rateExGstPaise"
        from price_list_parse_rows where document_id = ${documentId}
       order by row_index asc, col_index asc
    `),
    documentRow(documentId),
    getConfig(),
  ]);
  const basis = (doc?.header?.taxBasis ?? "inclusive") as TaxBasis;
  const gstBp = doc?.header?.gstBp ?? config["pricing.gstBp"];
  const cellsOf = (provider: "openai" | "anthropic"): ModelCell[] | null => {
    const r = [...runs].find((x) => x.provider === provider);
    if (!r || !r.ok) return null;
    const out = r.output as { cells?: ModelCell[] } | null;
    return Array.isArray(out?.cells) ? out.cells : null;
  };
  const models = { openai: cellsOf("openai"), anthropic: cellsOf("anthropic") };
  const ran = !!(models.openai || models.anthropic);
  const cells = ran
    ? compareReaders(
        [...staged].map((s) => ({
          id: s.id,
          rawProductText: s.rawProductText,
          rawPackText: s.rawPackText,
          millilitres: s.millilitres == null ? null : Number(s.millilitres),
          printedPaise: printedOf(
            { rateInclGstPaise: s.rateInclGstPaise == null ? null : Number(s.rateInclGstPaise), rateExGstPaise: s.rateExGstPaise == null ? null : Number(s.rateExGstPaise) },
            basis,
            gstBp,
          ),
        })),
        models,
      )
    : [];
  return {
    documentId,
    readers: [...runs].map((r) => ({ provider: r.provider, label: PROVIDER_LABEL[r.provider], model: r.model, at: r.at, ok: r.ok, error: r.error })),
    cells,
    counts: countVerdicts(cells),
    ran,
  };
}
