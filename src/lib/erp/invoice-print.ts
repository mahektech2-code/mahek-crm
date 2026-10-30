import "server-only";
import { PDFDocument } from "pdf-lib";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { canRead } from "@/lib/services/attachment-service";
import { fileStorage } from "@/lib/storage";
import { invoiceFilesFor } from "./order-tracking";

/* ---------------------------------------------------------------------------
 * The Tally invoices of several orders as ONE PDF, for viewing and printing.
 * MahekOne never draws its own copy of a tax invoice: this is the uploaded
 * PDF (or photograph) itself, joined in the order asked, `copies` times each.
 * Orders on one invoice share its PDF, which is printed once. A file the
 * person may not open is left out exactly as a missing one is.
 * ------------------------------------------------------------------------- */

/** A4 in points, for a photograph of an invoice. */
const A4: [number, number] = [595.28, 841.89];

export type InvoicePack = { pdf: Uint8Array; orders: number[]; missing: number[] };

/** Parses "10082,10080" into order numbers, keeping the order asked and dropping repeats. */
export function orderNosOf(raw: string | null | undefined): number[] {
  const out: number[] = [];
  for (const part of (raw ?? "").split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 200);
}

export async function invoicePack(orderNos: number[], copies: number): Promise<InvoicePack | null> {
  const files = await invoiceFilesFor(orderNos);
  const missing: number[] = [];
  const order: { no: number; id: string }[] = [];
  const seen = new Set<string>();
  for (const no of orderNos) {
    const f = files.get(no);
    if (!f || !(await canRead(f.id))) {
      missing.push(no);
      continue;
    }
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    order.push({ no, id: f.id });
  }
  if (!order.length) return null;
  const rows = await db.select().from(attachments).where(inArray(attachments.id, order.map((o) => o.id)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = await PDFDocument.create();
  const done: number[] = [];
  for (const o of order) {
    const row = byId.get(o.id);
    if (!row || row.status === "removed") {
      missing.push(o.no);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fileStorage.read(row.storedRef));
    } catch {
      missing.push(o.no);
      continue;
    }
    const pages = await pagesOf(out, bytes, row.contentType);
    if (!pages) {
      missing.push(o.no);
      continue;
    }
    for (let c = 0; c < copies; c++) for (const draw of pages) await draw();
    done.push(o.no);
  }
  if (!done.length) return null;
  return { pdf: await out.save(), orders: done, missing };
}

/** One function per page of the file, each adding that page to `out` once — called again for every copy. */
async function pagesOf(out: PDFDocument, bytes: Uint8Array, type: string): Promise<(() => Promise<void>)[] | null> {
  try {
    if (type === "application/pdf") {
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const idx = src.getPageIndices();
      return idx.map((i) => async () => {
        const [p] = await out.copyPages(src, [i]);
        out.addPage(p);
      });
    }
    if (type === "image/jpeg" || type === "image/png") {
      const img = type === "image/png" ? await out.embedPng(bytes) : await out.embedJpg(bytes);
      return [
        async () => {
          const page = out.addPage(A4);
          const margin = 24;
          const scale = Math.min((A4[0] - margin * 2) / img.width, (A4[1] - margin * 2) / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
        },
      ];
    }
  } catch {
    return null;
  }
  return null;
}
