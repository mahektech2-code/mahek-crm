import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attachments,
  priceListDocuments,
  priceListParseRows,
  type PriceDocumentStatus,
  type PriceParsedHeader,
} from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { bindAttachments, createAttachment } from "@/lib/services/attachment-service";
import { fileStorage } from "@/lib/storage";
import { extractPages, readWithVision } from "@/lib/price-list-extract";
import { filenameHints, parsePriceListText, type ParsedPriceList } from "@/lib/price-list-parse";
import { matchGrid, type AliasRow, type CatalogueSku } from "@/lib/price-list-match";
import { FINAL_STATUSES, READING_STATUSES, STALE_READ_MS, stagedFigures } from "@/lib/engines/price-document";

/* ---------------------------------------------------------------------------
 * A FILE BECOMES STAGED ROWS, one stage at a time and in the open.
 *
 * The discipline is the catalogue import's and the sheet projections': read
 * into STAGING, keep the raw text beside every normalised value, and let a
 * person publish. Nothing here writes a price list — `publishDocument` does,
 * after somebody has looked.
 *
 * THE STAGES ARE WRITTEN DOWN AS THEY HAPPEN, which is the only unusual thing
 * in this file. `parse_status` walks extracting → classifying → normalising →
 * matching → validating, and each step is stored before it starts. That is
 * what lets the import screen show what is happening rather than a spinner
 * that means nothing: a poller reads the row. The floor below is what makes
 * the stages legible on a file that parses in eighty milliseconds — a progress
 * display nobody can read is a progress display that teaches people the app
 * has hung.
 *
 * A FAILURE IS A STATE, not an exception thrown at a screen. Anything that
 * goes wrong lands as `failed` with the reason in `stage_note`, because the
 * person who uploaded the file needs to know whether to fix the file, the
 * catalogue or the key.
 * ------------------------------------------------------------------------- */

/** Bumped when the READING changes, so a re-parse pass can find old documents. */
export const PARSER_VERSION = 1;

/** Long enough for a stage to be seen. See the note above. */
const STAGE_FLOOR_MS = 250;

const PARENT_TYPE = "price_list_document" as const;

function gen(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

/* ------------------------------------------------------------- uploading */

export type UploadResult = {
  filename: string;
  documentId?: string;
  /** The document this file's bytes already belong to. */
  duplicateOf?: string;
  error?: string;
};

/**
 * Files in, documents out, deduplicated on the BYTES.
 *
 * The same PDF sent twice — mailed round the office, downloaded twice, dragged
 * in again to check — is one document, because the alternative is two lists
 * from one sheet and a person deciding which is real. The name is not part of
 * the key: a renamed copy is the same list.
 *
 * A file that cannot be stored does not stop the others. An import of thirty
 * lists must not be lost to one that was a spreadsheet.
 */
export async function createDocumentsFromUploads(
  files: Array<{ filename: string; bytes: Uint8Array; declaredType?: string }>,
  uploadedById: string,
): Promise<UploadResult[]> {
  const out: UploadResult[] = [];
  for (const file of files) {
    const fileHash = createHash("sha256").update(file.bytes).digest("hex");
    const [existing] = await db
      .select({ id: priceListDocuments.id })
      .from(priceListDocuments)
      .where(eq(priceListDocuments.fileHash, fileHash))
      .limit(1);
    if (existing) {
      out.push({ filename: file.filename, duplicateOf: existing.id });
      continue;
    }

    const created = await createAttachment({
      filename: file.filename,
      bytes: file.bytes,
      declaredType: file.declaredType,
    });
    if (!created.ok) {
      out.push({ filename: file.filename, error: created.error });
      continue;
    }

    const id = gen("pld");
    await db.insert(priceListDocuments).values({
      id,
      attachmentId: created.data.id,
      fileHash,
      filename: file.filename,
      sourceKind: file.declaredType?.startsWith("image/") ? "image" : "pdf_text",
      byteSize: file.bytes.byteLength,
      filenameHints: filenameHints(file.filename),
      parseStatus: "queued",
      parserVersion: PARSER_VERSION,
      uploadedById,
    });
    // The file is the document's, so it is bound once the row exists — the
    // same "bind when the parent is written" the rest of the app follows.
    await bindAttachments([created.data.id], PARENT_TYPE, id);
    out.push({ filename: file.filename, documentId: id });
  }
  return out;
}

/* --------------------------------------------------------------- parsing */

async function stage(documentId: string, status: PriceDocumentStatus, note: string | null) {
  await db
    .update(priceListDocuments)
    .set({ parseStatus: status, stageNote: note, stageStartedAt: new Date(), updatedAt: new Date() })
    .where(eq(priceListDocuments.id, documentId));
  await new Promise((r) => setTimeout(r, STAGE_FLOOR_MS));
}

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
  const aliases = await db.execute<AliasRow>(sql`
    select name, product_id as "productId" from product_aliases
  `);
  return { skus: [...skus], aliases: [...aliases] };
}

/**
 * Read a document end to end and stage every cell it holds.
 *
 * Re-runnable: rows a person has DECIDED are left exactly as they are, and
 * everything else is rewritten. That is what makes "re-parse" safe after the
 * reading rule changes — the same reason the taken-order reparse exists.
 */
export type ParseOutcome = { status: PriceDocumentStatus; problems: string[]; refused?: "final" | "running" };

/**
 * ONE READ AT A TIME, and never of a finished document. The first stage is
 * CLAIMED with one conditional update: it lands only where the document is not
 * published or rejected and no live read holds it (a read whose stage started
 * longer ago than `STALE_READ_MS` is dead, and may be taken over). Two reads
 * of one file used to both delete the unanswered rows and both insert theirs,
 * so every count doubled; and a published file could be put back to "parsed"
 * and published as a second list.
 */
async function claim(documentId: string): Promise<"ok" | "final" | "running" | "missing"> {
  const stale = new Date(Date.now() - STALE_READ_MS);
  const claimed = await db
    .update(priceListDocuments)
    .set({ parseStatus: "extracting", stageNote: "Reading the file", stageStartedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(priceListDocuments.id, documentId),
        sql`${priceListDocuments.parseStatus} not in (${sql.join(FINAL_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
        sql`(${priceListDocuments.parseStatus} not in (${sql.join(READING_STATUSES.map((s) => sql`${s}`), sql`, `)})
             or ${priceListDocuments.stageStartedAt} is null
             or ${priceListDocuments.stageStartedAt} < ${stale.toISOString()})`,
      ),
    )
    .returning({ id: priceListDocuments.id });
  if (claimed.length) return "ok";
  const [doc] = await db.select({ parseStatus: priceListDocuments.parseStatus }).from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
  if (!doc) return "missing";
  return (FINAL_STATUSES as readonly string[]).includes(doc.parseStatus) ? "final" : "running";
}

export async function parseDocument(documentId: string): Promise<ParseOutcome> {
  const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
  if (!doc) return { status: "failed", problems: ["No such document."] };

  const claimed = await claim(documentId);
  if (claimed === "missing") return { status: "failed", problems: ["No such document."] };
  if (claimed === "final") {
    return {
      status: doc.parseStatus as PriceDocumentStatus,
      problems: [doc.parseStatus === "published" ? "This one has already become a price list." : "This one was rejected."],
      refused: "final",
    };
  }
  if (claimed === "running") {
    return { status: doc.parseStatus as PriceDocumentStatus, problems: ["This file is being read right now. Wait for that read to finish."], refused: "running" };
  }

  try {
    const config = await getConfig();

    /* ---- extracting: the words off the page --------------------------- */
    await new Promise((r) => setTimeout(r, STAGE_FLOOR_MS));
    const bytes = await attachmentBytes(doc.attachmentId);
    if (!bytes) throw new Error("The uploaded file could not be read back from storage.");

    const extracted = await extractPages(bytes.bytes, bytes.contentType);
    let parsed: ParsedPriceList;
    let modelUsed: string | null = null;

    /* ---- classifying: which layout, and by which reader --------------- */
    await stage(documentId, "classifying", extracted.kind === "pdf_text" ? "Reading the grid" : "No text in the file; asking a model to read it");
    if (extracted.kind === "pdf_text") {
      parsed = parsePriceListText(extracted.pages, extracted.meta);
    } else {
      const vision = await readWithVision(bytes.bytes, bytes.contentType);
      if ("error" in vision) throw new Error(vision.error);
      parsed = vision.parsed;
      modelUsed = vision.model;
    }

    /* ---- normalising: figures and packs ------------------------------- */
    await stage(documentId, "normalising", `${parsed.rows.length} products × ${parsed.columns.length} pack sizes`);
    const gstBp = parsed.header.gstBp ?? config["pricing.gstBp"];
    const basis = parsed.header.taxBasis ?? "inclusive";

    /* ---- matching: which SKU each cell names -------------------------- */
    await stage(documentId, "matching", "Matching each row to the catalogue");
    const { skus, aliases } = await catalogue();
    const matches = matchGrid(parsed, skus, aliases);

    /* ---- validating and staging --------------------------------------- */
    await stage(documentId, "validating", "Checking the figures");
    const decided = await db
      .select({ rowIndex: priceListParseRows.rowIndex, colIndex: priceListParseRows.colIndex })
      .from(priceListParseRows)
      .where(and(eq(priceListParseRows.documentId, documentId), sql`${priceListParseRows.decidedById} is not null`));
    const keep = new Set(decided.map((d) => `${d.rowIndex}:${d.colIndex}`));

    const problems = [...parsed.warnings];
    let held = 0;
    let suggested = 0;

    await db.transaction(async (tx) => {
      // Everything nobody has answered is rewritten; a person's answer stands.
      await tx
        .delete(priceListParseRows)
        .where(and(eq(priceListParseRows.documentId, documentId), isNull(priceListParseRows.decidedById)));

      const rows = [];
      for (const row of parsed.rows) {
        for (const cellValue of row.cells) {
          const key = `${row.rowIndex}:${cellValue.colIndex}`;
          if (keep.has(key)) continue;
          const column = parsed.columns[cellValue.colIndex];
          const match = matches.get(key);
          if (match?.status === "held") held++;
          if (match?.status === "suggested") suggested++;
          // Stored as the document PRINTS it, and the other figure beside it.
          // A list printed GST-extra has already given us the ex figure; the
          // same whole-number arithmetic as everywhere else, so a re-read
          // and a later header correction land on the same paisa.
          const figures = stagedFigures(cellValue.inclPaise, basis, gstBp);
          rows.push({
            id: gen("plp"),
            documentId,
            page: 1,
            rowIndex: row.rowIndex,
            colIndex: cellValue.colIndex,
            rawProductText: row.rawProduct,
            rawPackText: column?.label ?? null,
            rawPriceText: cellValue.raw,
            millilitres: column?.millilitres ?? null,
            cansPerBox: column?.cansPerBox ?? null,
            container: column?.container ?? null,
            rateInclGstPaise: figures.incl,
            rateExGstPaise: figures.ex,
            offered: cellValue.offered,
            matchedProductId: match?.productId ?? null,
            matchStatus: match?.status ?? "held",
            matchConfidence: match?.confidence ?? null,
            candidates: match?.candidates ?? [],
            problem: match?.status === "held" ? "No product in the catalogue has this name at this pack size." : null,
          });
        }
      }
      if (rows.length) await tx.insert(priceListParseRows).values(rows);
    });

    if (held) problems.push(`${held} cell${held === 1 ? "" : "s"} could not be matched to a product.`);
    if (suggested) problems.push(`${suggested} cell${suggested === 1 ? "" : "s"} matched a product that is worth checking.`);

    const floor = config["pricing.parseConfidenceFloor"];
    const status: PriceDocumentStatus =
      parsed.confidence < floor || held > 0 || parsed.warnings.length > 0 ? "needs_review" : "parsed";

    const header: PriceParsedHeader = { ...parsed.header, discountTerms: parsed.discountTerms, termsText: parsed.termsText };
    // Guarded like the claim: a document published or rejected while this
    // read ran keeps the status a person gave it.
    await db
      .update(priceListDocuments)
      .set({
        parseStatus: status,
        stageNote: null,
        sourceKind: extracted.kind,
        pageCount: extracted.pageCount,
        layout: parsed.layout,
        confidence: parsed.confidence,
        extractedText: extracted.pages.join("\n\f\n") || null,
        header,
        problems,
        modelUsed,
        parserVersion: PARSER_VERSION,
        parsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(priceListDocuments.id, documentId), sql`${priceListDocuments.parseStatus} not in ('published', 'rejected')`));

    return { status, problems };
  } catch (e) {
    const message = e instanceof Error ? e.message : "The file could not be read.";
    await db
      .update(priceListDocuments)
      .set({ parseStatus: "failed", stageNote: message, updatedAt: new Date() })
      .where(and(eq(priceListDocuments.id, documentId), sql`${priceListDocuments.parseStatus} not in ('published', 'rejected')`));
    return { status: "failed", problems: [message] };
  }
}

/**
 * Reads that died part-way, put down as failed so the screens offer "Read
 * again". A tab closed mid-read, or a request killed at the route's 300
 * seconds, leaves the document in a stage nothing will ever finish — and it
 * was shown as read while it held nothing. A queued file nobody started counts
 * too. Run hourly; also asked by nothing else, because the screens already
 * treat a stale stage as stuck on their own.
 */
export async function failStaleReads(nowMs = Date.now()): Promise<number> {
  const stale = new Date(nowMs - STALE_READ_MS).toISOString();
  const done = await db
    .update(priceListDocuments)
    .set({
      parseStatus: "failed",
      stageNote: "The read stopped part-way — the window was closed or it ran out of time. Read it again.",
      updatedAt: new Date(),
    })
    .where(
      sql`(${priceListDocuments.parseStatus} in (${sql.join(READING_STATUSES.map((s) => sql`${s}`), sql`, `)})
            and coalesce(${priceListDocuments.stageStartedAt}, ${priceListDocuments.createdAt}) < ${stale})
          or (${priceListDocuments.parseStatus} = 'queued' and ${priceListDocuments.createdAt} < ${stale})`,
    )
    .returning({ id: priceListDocuments.id });
  return done.length;
}

/** The bytes back out of storage, with the type they were stored under. */
async function attachmentBytes(attachmentId: string | null): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!attachmentId) return null;
  const [row] = await db
    .select({ storedRef: attachments.storedRef, contentType: attachments.contentType, status: attachments.status })
    .from(attachments)
    .where(eq(attachments.id, attachmentId));
  if (!row || row.status !== "available") return null;
  const bytes = await fileStorage.read(row.storedRef);
  return { bytes: new Uint8Array(bytes), contentType: row.contentType };
}

/* ---------------------------------------------------------------- status */

export type DocumentStatus = {
  parseStatus: PriceDocumentStatus;
  stageNote: string | null;
  stageStartedAt: string | null;
  confidence: number | null;
  problems: string[];
  rowCount: number;
  matchedCount: number;
  suggestedCount: number;
  heldCount: number;
  pageCount: number | null;
  layout: string | null;
  header: PriceParsedHeader | null;
};

/**
 * What a poller reads while a file is being read.
 *
 * Counts come from the staged rows rather than from a column, because they are
 * what a reviewer is about to work through and a cached count is a count that
 * can be wrong about work somebody has already done.
 */
export async function documentStatus(documentId: string): Promise<DocumentStatus | null> {
  const [row] = await db.execute<DocumentStatus & { stageStartedAt: string | null }>(sql`
    select d.parse_status as "parseStatus",
           d.stage_note as "stageNote",
           to_char(d.stage_started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "stageStartedAt",
           d.confidence,
           d.problems,
           d.page_count as "pageCount",
           d.layout,
           d.header,
           (select count(*)::int from price_list_parse_rows r where r.document_id = d.id) as "rowCount",
           (select count(*)::int from price_list_parse_rows r
             where r.document_id = d.id and r.match_status in ('matched', 'alias', 'manual')) as "matchedCount",
           (select count(*)::int from price_list_parse_rows r
             where r.document_id = d.id and r.match_status = 'suggested') as "suggestedCount",
           (select count(*)::int from price_list_parse_rows r
             where r.document_id = d.id and r.match_status = 'held') as "heldCount"
      from price_list_documents d
     where d.id = ${documentId}
  `);
  return row ?? null;
}
