/* ---------------------------------------------------------------------------
 * A PRICE DOCUMENT'S STATE AND FIGURES, with no I/O in it.
 *
 * Four questions the import pipeline asks in more than one place, so each has
 * one answer: is a document being read right now, has a read died part-way,
 * what does a staged cell PRINT, and which cell becomes the rate when two of
 * them name one SKU. The import modal, the review screen, the parse service
 * and `publishDocument` all read this file, because a screen that offered
 * "Read again" on a file the server refuses to re-read is a button that fails
 * when pressed.
 * ------------------------------------------------------------------------- */

import { exFromIncl, inclFromEx } from "@/lib/engines/price-math";

/** The stages a read walks through. A document sitting in one of them is being read — or was, and died. */
export const READING_STATUSES = ["extracting", "classifying", "normalising", "matching", "validating"] as const;

/**
 * How long a read may sit in one stage before it is taken as dead. The parse
 * route runs for at most 300 seconds; a stage still "running" twice that long
 * after it started is a tab that was closed or a request that was killed.
 */
export const STALE_READ_MS = 10 * 60 * 1000;

/** Statuses a re-read may never touch: the document became a list, or a person threw it out. */
export const FINAL_STATUSES = ["published", "rejected"] as const;

export function isReading(status: string | null | undefined): boolean {
  return (READING_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * A read that stopped part-way. `queued` counts too once it is old: the import
 * window starts the read the moment the upload lands, so a queued document an
 * hour later is one whose window was closed in between.
 */
export function isStuck(
  doc: { parseStatus: string; stageStartedAt: string | Date | null; createdAt?: string | Date | null },
  nowMs: number,
): boolean {
  const since = doc.stageStartedAt ?? (doc.parseStatus === "queued" ? (doc.createdAt ?? null) : null);
  if (!isReading(doc.parseStatus) && doc.parseStatus !== "queued") return false;
  if (since == null) return doc.parseStatus !== "queued";
  return nowMs - new Date(since).getTime() > STALE_READ_MS;
}

/** Whether "Read again" may be offered: not while a live read is running, never on a published or rejected file. */
export function canReread(
  doc: { parseStatus: string; stageStartedAt: string | Date | null; createdAt?: string | Date | null },
  nowMs: number,
): boolean {
  if ((FINAL_STATUSES as readonly string[]).includes(doc.parseStatus)) return false;
  if (isReading(doc.parseStatus)) return isStuck(doc, nowMs);
  return true;
}

/* --------------------------------------------------------------- figures */

export type TaxBasis = "inclusive" | "exclusive";

/**
 * A printed figure as the two staged figures. The document's own basis decides
 * which of the two the paper said; the other is worked out with the same
 * whole-number arithmetic every price in MahekOne uses.
 */
export function stagedFigures(printed: number | null, basis: TaxBasis, gstBp: number): { incl: number | null; ex: number | null } {
  if (printed == null) return { incl: null, ex: null };
  return basis === "inclusive"
    ? { incl: printed, ex: exFromIncl(printed, gstBp) }
    : { ex: printed, incl: inclFromEx(printed, gstBp) };
}

/** What the paper printed, read back off a staged cell under the basis it was staged with. */
export function printedOf(
  row: { rateInclGstPaise: number | null; rateExGstPaise: number | null },
  basis: TaxBasis,
  gstBp: number,
): number | null {
  const incl = row.rateInclGstPaise == null ? null : Number(row.rateInclGstPaise);
  const ex = row.rateExGstPaise == null ? null : Number(row.rateExGstPaise);
  if (basis === "inclusive") return incl ?? (ex == null ? null : inclFromEx(ex, gstBp));
  return ex ?? (incl == null ? null : exFromIncl(incl, gstBp));
}

/**
 * A staged cell re-stated under a corrected header. Changing the tax basis or
 * the GST rate after a read does not change what the paper PRINTED — it
 * changes what that figure means — so the printed figure is recovered under
 * the old header and both figures worked out again under the new one.
 */
export function restage(
  row: { rateInclGstPaise: number | null; rateExGstPaise: number | null },
  from: { basis: TaxBasis; gstBp: number },
  to: { basis: TaxBasis; gstBp: number },
): { incl: number | null; ex: number | null } {
  return stagedFigures(printedOf(row, from.basis, from.gstBp), to.basis, to.gstBp);
}

/* -------------------------------------------------- one rate per SKU */

export type PublishCell = {
  matchedProductId: string;
  rateExGstPaise: number | null;
  rateInclGstPaise: number | null;
  offered: boolean;
  matchStatus: string;
  rawProductText: string;
  rowIndex: number;
  colIndex: number;
};

export type PublishPick<T extends PublishCell> = {
  /** One cell per SKU, in the document's order. */
  chosen: Array<T & { ex: number | null; incl: number | null }>;
  /** SKUs two confirmed cells price differently — the document is held until a person decides. */
  conflicts: Array<{ productId: string; labels: string[]; prices: number[] }>;
  /** Cells left out because another cell already priced their SKU. */
  dropped: number;
};

/**
 * Which cell becomes the rate where two cells name one SKU.
 *
 * It used to be the first in reading order, and a blank cell marked the SKU
 * "seen" before it was skipped — so a dash or a wrong guess higher up the page
 * silently pushed out the real price below it. Now: a cell a person or the
 * catalogue CONFIRMED (matched, alias, manual) beats a suggestion; a price
 * beats a dash; a blank cell never counts. Two confirmed cells that print
 * DIFFERENT prices for one SKU are a conflict, and nothing is guessed: the
 * caller refuses and names the product.
 *
 * Figures are worked out under the FINAL header — the one the list is being
 * published with — from what the paper printed under the header it was read
 * with, so a corrected tax basis or GST rate re-prices nothing by accident.
 */
export function pickDocumentRates<T extends PublishCell>(
  cells: T[],
  read: { basis: TaxBasis; gstBp: number },
  final: { basis: TaxBasis; gstBp: number },
): PublishPick<T> {
  const confirmed = (c: { matchStatus: string }) => c.matchStatus !== "suggested";
  const byProduct = new Map<string, Array<T & { ex: number | null; incl: number | null; printed: number | null }>>();
  for (const c of cells) {
    const printed = printedOf(c, read.basis, read.gstBp);
    // A cell offered with no figure is a blank, not a price and not a dash.
    if (c.offered && printed == null) continue;
    const { ex, incl } = stagedFigures(c.offered ? printed : null, final.basis, final.gstBp);
    const list = byProduct.get(c.matchedProductId) ?? [];
    list.push({ ...c, ex, incl, printed: c.offered ? printed : null });
    byProduct.set(c.matchedProductId, list);
  }
  const chosen: PublishPick<T>["chosen"] = [];
  const conflicts: PublishPick<T>["conflicts"] = [];
  let dropped = 0;
  const rank = (c: { matchStatus: string; printed: number | null }) =>
    (confirmed(c) ? 0 : 2) + (c.printed != null ? 0 : 1);
  for (const [productId, list] of byProduct) {
    const best = Math.min(...list.map(rank));
    const top = list.filter((c) => rank(c) === best);
    const prices = [...new Set(top.map((c) => c.printed).filter((p): p is number => p != null))];
    if (prices.length > 1 && confirmed(top[0])) {
      conflicts.push({ productId, labels: [...new Set(top.map((c) => c.rawProductText))], prices });
      continue;
    }
    const pick = top[0];
    const { printed: _printed, ...rest } = pick;
    void _printed;
    chosen.push(rest as T & { ex: number | null; incl: number | null });
    dropped += list.length - 1;
  }
  chosen.sort((a, b) => a.rowIndex - b.rowIndex || a.colIndex - b.colIndex);
  return { chosen, conflicts, dropped };
}
