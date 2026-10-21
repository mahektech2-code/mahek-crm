/* ---------------------------------------------------------------------------
 * A STATEMENT PDF, OPENED AND CUT INTO PIECES FOR THE MODEL.
 *
 * No database and no model: `services/bank-statement-reader.ts` sends what
 * this prepares. Kept apart so it can be tested on real PDFs — an encrypted
 * one, a locked one, a long one — without an OpenAI key.
 * ------------------------------------------------------------------------- */

/** Pages in one model call. Small enough that a dense page of a busy current account still fits one answer. */
export const PAGES_PER_CALL = 4;

export class StatementLocked extends Error {
  constructor(public wrongPassword: boolean) {
    super(wrongPassword ? "That password does not open this PDF." : "This PDF is locked with a password.");
  }
}

type PdfDoc = Awaited<ReturnType<typeof import("unpdf").getDocumentProxy>>;

function isPasswordError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? "";
  return name === "PasswordException" || /password/i.test(e instanceof Error ? e.message : "");
}

/**
 * Opens the PDF the way a viewer would: without a password, and with the one
 * typed only if the PDF will not open without it. pdf.js takes ownership of
 * the buffer it is handed, so each attempt gets its own copy.
 */
async function openPdf(bytes: Uint8Array, password: string | null): Promise<PdfDoc> {
  const { getDocumentProxy } = await import("unpdf");
  try {
    return await getDocumentProxy(new Uint8Array(bytes));
  } catch (e) {
    if (!isPasswordError(e)) throw e;
    if (!password) throw new StatementLocked(false);
  }
  try {
    return await getDocumentProxy(new Uint8Array(bytes), { password });
  } catch (e) {
    if (isPasswordError(e)) throw new StatementLocked(true);
    throw e;
  }
}

/** Whether the file carries encryption at all — an owner password included. */
export function isEncrypted(bytes: Uint8Array): boolean {
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 8192))).toString("latin1");
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 8192))).toString("latin1");
  return /\/Encrypt\b/.test(tail) || /\/Encrypt\b/.test(head);
}

type TextItem = { str: string; x: number; y: number; w: number; h: number };

/**
 * One page as text with its columns kept: words on one baseline make a line,
 * and each word starts at the column its position puts it in. A statement's
 * table read as one long run of words is a table nobody can split back into
 * debit, credit and balance.
 */
export function layoutText(items: TextItem[]): string {
  const words = items.filter((i) => i.str.trim());
  if (!words.length) return "";
  const chars = words.reduce((n, i) => n + i.str.length, 0);
  const width = words.reduce((n, i) => n + i.w, 0);
  const cw = Math.max(2, Math.min(8, chars ? width / chars : 5));
  const tol = Math.max(1.5, (words.reduce((n, i) => n + (i.h || 8), 0) / words.length) * 0.4);
  const lines: { y: number; items: TextItem[] }[] = [];
  for (const w of [...words].sort((a, b) => b.y - a.y)) {
    const line = lines.find((l) => Math.abs(l.y - w.y) <= tol);
    if (line) line.items.push(w);
    else lines.push({ y: w.y, items: [w] });
  }
  const minX = Math.min(...words.map((w) => w.x));
  return lines
    .map((l) => {
      let out = "";
      for (const w of l.items.sort((a, b) => a.x - b.x)) {
        const col = Math.round((w.x - minX) / cw);
        out += out.length && col <= out.length ? " " : " ".repeat(Math.max(0, col - out.length));
        out += w.str.trim();
      }
      return out.trimEnd();
    })
    .join("\n");
}

async function pageText(pdf: PdfDoc, page: number): Promise<string> {
  const p = await pdf.getPage(page);
  const content = await p.getTextContent();
  const items: TextItem[] = [];
  for (const it of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
    if (typeof it.str !== "string" || !it.transform) continue;
    items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width ?? 0, h: it.height ?? Math.abs(it.transform[3]) });
  }
  return layoutText(items);
}

/** The pages each model call reads: [1–4], [5–8], … */
export function pageRanges(pages: number, per = PAGES_PER_CALL): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let from = 1; from <= pages; from += per) out.push({ from, to: Math.min(pages, from + per - 1) });
  return out;
}

/**
 * A page number the model gives for a piece is either the statement's own
 * (from..to) or counted inside the piece (1..n). The two ranges never overlap
 * past the first piece, so the second is moved onto the first.
 */
export function absolutePage(page: number | null, from: number, to: number): number | null {
  if (page == null || !Number.isFinite(page)) return from === to ? from : null;
  if (page >= from && page <= to) return page;
  if (page >= 1 && page <= to - from + 1) return from + page - 1;
  return null;
}

export type Piece = { from: number; to: number; content: ({ type: "text"; text: string } | { type: "file"; mediaType: string; data: Uint8Array; filename: string })[] };

/**
 * Opens the statement and says how it will be read: its pages, the pieces,
 * and how to build each piece's message. No model is called here.
 */
export async function prepareStatement(bytes: Uint8Array, fileName: string, password: string | null): Promise<{ pages: number; ranges: { from: number; to: number }[]; mode: "whole" | "split" | "text"; pieceFor: (r: { from: number; to: number }) => Promise<Piece> }> {
  const pdf = await openPdf(bytes, password);
  const pages = pdf.numPages;
  if (!pages) throw new Error("This PDF has no pages.");
  const ranges = pageRanges(pages);

  // A file the model can open goes as a file; an encrypted one — or one
  // pdf-lib cannot re-save — goes as its text.
  const encrypted = isEncrypted(bytes);
  let asFile: import("pdf-lib").PDFDocument | null = null;
  if (!encrypted && ranges.length > 1) {
    try {
      const { PDFDocument } = await import("pdf-lib");
      asFile = await PDFDocument.load(bytes);
    } catch {
      asFile = null;
    }
  }
  const mode = !encrypted && ranges.length === 1 ? "whole" : asFile ? "split" : "text";
  const base = fileName.replace(/\.pdf$/i, "");

  // Text only: a scanned statement has none, and its text cannot be read.
  if (mode === "text") {
    const sample = await pageText(pdf, 1);
    if (!sample.replace(/\s/g, "")) throw new Error("This PDF is a scan with no text in it, and it cannot be sent as it is. Download the statement again from the bank as a text PDF.");
  }

  async function pieceFor(r: { from: number; to: number }): Promise<Piece> {
    const where = pages === 1 ? "This is a one-page bank statement." : `These are pages ${r.from} to ${r.to} of a ${pages}-page bank statement. Number pages as the statement does: the first page here is page ${r.from}.`;
    if (mode === "whole") {
      return { ...r, content: [{ type: "text", text: `${where} Read it.` }, { type: "file", mediaType: "application/pdf", data: bytes, filename: fileName }] };
    }
    if (mode === "split" && asFile) {
      const { PDFDocument } = await import("pdf-lib");
      const part = await PDFDocument.create();
      const copied = await part.copyPages(asFile, Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from - 1 + i));
      for (const p of copied) part.addPage(p);
      const data = await part.save();
      return { ...r, content: [{ type: "text", text: `${where} Read them.` }, { type: "file", mediaType: "application/pdf", data, filename: `${base}-p${r.from}-${r.to}.pdf` }] };
    }
    const texts: string[] = [];
    for (let p = r.from; p <= r.to; p++) texts.push(`--- Page ${p} ---\n${await pageText(pdf, p)}`);
    return { ...r, content: [{ type: "text", text: `${where} Its text, page by page, with the columns kept where they are printed:\n\n${texts.join("\n\n")}` }] };
  }
  return { pages, ranges, mode, pieceFor };
}

