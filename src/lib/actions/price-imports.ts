"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { priceChangeEvents, priceChanges, priceListDiscountTerms, priceListRates, type PriceParsedHeader } from "@/db/schema";
import { requirePriceDesk } from "@/lib/services/price-desk";
import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { canReread, isReading, type TaxBasis } from "@/lib/engines/price-document";
import { audit, draftVersionIn, Refused } from "@/lib/services/price-write";
import { listBooks } from "@/lib/services/price-book-service";
import { crossReadFor, documentPick, documentRefusal, pickBlockers } from "@/lib/services/price-import-service";
import { crossReadFile, documentFile } from "@/lib/price-ai/pdf-read";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import type { CrossReadCounts } from "@/lib/engines/price-cross-read";

/* ---------------------------------------------------------------------------
 * A PDF YOU ALREADY HAVE, BROUGHT IN AS A CHANGE ON ITS BOOK — and read again
 * by two models.
 *
 * `publishDocument` makes a NEW list from a document and stays exactly as it
 * is. `documentToChange` is the other road: the document's prices become the
 * draft of a change on a book the desk already keeps, which then goes through
 * Check and Approve like any other change. The prices are picked by the SAME
 * rule (`pickDocumentRates`), and the same cells stop it — a price with no
 * product, two confirmed cells pricing one product differently. The document
 * is consumed the moment the change is made, and handed back for review if
 * the change is cancelled (`cancelChange`).
 *
 * `crossReadDocument` asks OpenAI and Claude to read the file. Their answers
 * are kept and compared on read; nothing they say is written as a price.
 * ------------------------------------------------------------------------- */

const gen = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

function refresh(documentId: string, bookId?: string) {
  try {
    for (const base of ["/accounts/price-lists", "/founder/price-lists", "/crm/price-lists"]) {
      revalidatePath(base, "layout");
      revalidatePath(`${base}/documents/${documentId}`);
      if (bookId) revalidatePath(`${base}/books/${bookId}`);
    }
  } catch {
    /* No request context — a job or a test. */
  }
}

export async function documentToChange(
  documentId: string,
  bookId: string,
): Promise<Result<{ changeId: string; bookId: string; warnings: string[] }>> {
  try {
    const ctx = await requirePriceDesk();
    const day = await today();

    const [doc] = await db.execute<{ parseStatus: string; header: PriceParsedHeader | null; filename: string }>(sql`
      select parse_status as "parseStatus", header, filename from price_list_documents where id = ${documentId}
    `);
    if (!doc) return err("That document does not exist.", "not_found");
    const refusal = documentRefusal(doc.parseStatus);
    if (refusal) return err(refusal, "rule_violation");

    const book = (await listBooks()).find((b) => b.id === bookId);
    if (!book) return err("That book does not exist.", "not_found");
    if (book.kind === "agreed") return err("That is one shop's agreed prices. A printed list is brought in on a standard book.", "rule_violation");
    if (book.openChange) {
      return err(
        `${book.name} already has a change open${book.openChange.title ? ` (“${book.openChange.title}”)` : ""}, started by ${book.openChange.makerName}. Finish or cancel it before bringing this PDF in.`,
        "conflict",
      );
    }

    const [head] = await db.execute<{ id: string; effectiveFrom: string; taxBasis: string; gstBp: number; derived: boolean }>(sql`
      select id, effective_from::text as "effectiveFrom", tax_basis as "taxBasis", gst_bp as "gstBp",
             (parent_list_id is not null and derivation is not null) as derived
        from price_lists
       where book_id = ${bookId} and status = 'published'
       order by version desc, effective_from desc limit 1
    `);
    if (!head) return err("This book has no published revision to change. Publish it from the list screens first.", "rule_violation");
    if (head.derived) return err("This book's prices are worked out from another list, so a PDF's prices cannot be put on it.", "rule_violation");

    const header = doc.header;
    const final = { basis: (header?.taxBasis ?? head.taxBasis) as TaxBasis, gstBp: header?.gstBp ?? Number(head.gstBp) };
    const picked = await documentPick(documentId, final);
    if (!picked) return err("That document does not exist.", "not_found");
    const blockers = await pickBlockers(picked);
    if (blockers.length) return err(`Nothing was changed. ${blockers.join(" ")}`, "rule_violation");

    const warnings: string[] = [];
    if (picked.suggested) warnings.push(`${picked.suggested} cell${picked.suggested === 1 ? " the matcher only guessed was" : "s the matcher only guessed were"} left out.`);
    if (picked.pick.dropped) warnings.push(`${picked.pick.dropped} cell${picked.pick.dropped === 1 ? "" : "s"} named a product another cell already priced, and ${picked.pick.dropped === 1 ? "was" : "were"} left out.`);

    const earliest = [addDays(day, 1), addDays(head.effectiveFrom, 1)].sort().at(-1)!;
    // The paper's own date, where it is still to come, is when the change goes live.
    const goLive = header?.effectiveFrom && /^\d{4}-\d{2}-\d{2}$/.test(header.effectiveFrom) && header.effectiveFrom > earliest ? header.effectiveFrom : earliest;

    const changeId = gen("pch");
    const made = await db.transaction(async (tx) => {
      /* One document, one destination. The status was read outside this
       * transaction; it is locked and asked again here, so a double click or
       * a publish from another tab cannot spend the same file twice. */
      const [locked] = await tx.execute<{ parseStatus: string }>(sql`
        select parse_status as "parseStatus" from price_list_documents where id = ${documentId} for update
      `);
      const again = locked ? documentRefusal(locked.parseStatus) : "That document does not exist.";
      if (again) throw new Refused(err(again, "rule_violation"));

      const [open] = await tx.execute<{ id: string }>(sql`
        select id from price_changes where book_id = ${bookId} and status in ('draft', 'submitted', 'sent_back') limit 1 for update
      `);
      if (open) throw new Refused(err(`${book.name} already has a change open. Finish or cancel it before bringing this PDF in.`, "conflict"));

      const draft = await draftVersionIn(tx, ctx, head.id, { effectiveFrom: goLive });

      // What the paper says about itself flows onto the draft; what it does not say keeps the book's.
      await tx.execute(sql`
        update price_lists set
          effective_from = ${goLive},
          tax_basis = ${final.basis},
          gst_bp = ${final.gstBp},
          validity_days = coalesce(${header?.validityDays ?? null}::int, validity_days),
          ref_no = coalesce(${header?.refNo ?? null}::text, ref_no),
          delivery_basis = coalesce(delivery_basis, ${header?.deliveryBasis ?? null}::text),
          terms_text = coalesce(${header?.termsText ?? null}::text, terms_text),
          signatory = coalesce(${header?.signatory ?? null}::text, signatory),
          document_id = ${documentId},
          updated_at = now(), updated_by_id = ${ctx.user.id}
         where id = ${draft.id}
      `);

      await tx.execute(sql`delete from price_list_rates where price_list_id = ${draft.id}`);
      const values = picked.pick.chosen.map((r) => ({
        id: gen("plr"),
        priceListId: draft.id,
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
      }));
      if (values.length) await tx.insert(priceListRates).values(values);

      const terms = header?.discountTerms ?? [];
      if (terms.length) {
        await tx.execute(sql`delete from price_list_discount_terms where price_list_id = ${draft.id}`);
        await tx.insert(priceListDiscountTerms).values(
          terms.map((t) => ({
            id: gen("plt"),
            priceListId: draft.id,
            kind: t.kind,
            percentBp: t.percentBp,
            thresholdLitres: t.thresholdLitres,
            thresholdPaise: t.thresholdPaise,
            rawText: t.rawText,
          })),
        );
      }

      await tx.insert(priceChanges).values({
        id: changeId,
        bookId,
        baseListId: head.id,
        draftListId: draft.id,
        status: "draft",
        title: header?.listName?.trim() || `From ${doc.filename}`,
        source: "import",
        sourceDocumentId: documentId,
        makerId: ctx.user.id,
        goLive,
      });
      await tx.insert(priceChangeEvents).values({
        id: gen("pce"),
        changeId,
        bookId,
        kind: "imported",
        actorId: ctx.user.id,
        note: doc.filename,
        detail: { documentId, base: head.id, draft: draft.id, adoptedDraft: draft.existing, rates: values.length } as never,
      });

      await tx.execute(sql`
        update price_list_documents set parse_status = 'published', price_list_id = ${draft.id},
               published_at = now(), published_by_id = ${ctx.user.id}, updated_at = now()
         where id = ${documentId}
      `);
      await audit(tx, ctx, {
        action: "pricebook.change.import",
        entityType: "price_change",
        entityId: changeId,
        after: { bookId, documentId, base: head.id, draft: draft.id, rates: values.length },
      });
      return { changeId, bookId, warnings };
    });

    refresh(documentId, bookId);
    return ok(made, `A change on ${book.name}, with the PDF's prices. Check it and send it for approval.`);
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/** OpenAI and Claude each read the file; the comparison is drawn on the review screen. Advice only. */
export async function crossReadDocument(documentId: string): Promise<Result<{ counts: CrossReadCounts; failed: string[] }>> {
  try {
    const ctx = await requirePriceDesk();
    const [doc] = await db.execute<{ parseStatus: string; attachmentId: string | null; stageStartedAt: string | null; createdAt: string }>(sql`
      select parse_status as "parseStatus", attachment_id as "attachmentId",
             stage_started_at as "stageStartedAt", created_at as "createdAt"
        from price_list_documents where id = ${documentId}
    `);
    if (!doc) return err("That document does not exist.", "not_found");
    if (doc.parseStatus === "published") return err("This document has already been brought in; reading it again would change nothing.", "rule_violation");
    if (doc.parseStatus === "rejected") return err("This document was rejected.", "rule_violation");
    if (isReading(doc.parseStatus) || !canReread(doc, Date.now())) return err("This file is being read right now. Wait for the read to finish.", "rule_violation");

    const file = await documentFile(doc.attachmentId);
    if (!file) return err("The uploaded file could not be read back from storage.", "not_found");
    if (!["application/pdf", "image/png", "image/jpeg"].includes(file.contentType)) {
      return err("Only a PDF or a photograph can be read by the models.", "rule_violation");
    }

    const answers = await crossReadFile(documentId, file, ctx.user.id);
    const failed = [answers.openai, answers.anthropic].filter((a) => !a.ok).map((a) => (a.ok ? "" : a.reason));
    if (failed.length === 2) return err(failed.join(" "), "rule_violation");

    const view = await crossReadFor(documentId);
    refresh(documentId);
    const c = view.counts;
    return ok(
      { counts: c, failed },
      c.disagree
        ? `${c.disagree} cell${c.disagree === 1 ? "" : "s"} the readers disagree on. Pick the right value for each.`
        : `Read again. ${c.agree} cell${c.agree === 1 ? "" : "s"} agree.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}
