/* ---------------------------------------------------------------------------
 * THE PRICE LIST AS A PDF — Mahek's own sheet, drawn from a `PriceSheet`.
 *
 * Isomorphic on purpose. The editor draws it in the browser on every change,
 * so the preview IS the file that will be downloaded rather than a picture of
 * it; the export routes and the save action draw the same bytes on the server,
 * where they are stored as the list's document and read back through the
 * parser to prove the paper says what was typed.
 *
 * THE TEXT IS REAL TEXT, and laid out one line per line. A PDF drawn as an
 * image, or with a table whose cells are emitted column by column, would read
 * back as nonsense — and a shop that forwards this file to somebody who
 * imports it into their own system would get nonsense too. Every row of the
 * grid is drawn left to right at one baseline, which is exactly what the
 * text extractor turns back into one line.
 *
 * Standard fonts only (Helvetica), so there is nothing to embed or license and
 * the file stays a few kilobytes. Their encoding has no rupee sign, which is
 * no loss: the office prints "Rs." and the parser reads "Rs.".
 * ------------------------------------------------------------------------- */

import {
  PDFDocument,
  StandardFonts,
  rgb,
  setCharacterSpacing,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import {
  LETTERHEAD,
  headerLine,
  printedClauses,
  printedPrice,
  type PriceSheet,
} from "@/lib/price-sheet";

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 36;
const INK = rgb(0.086, 0.086, 0.086);
const MUTED = rgb(0.24, 0.27, 0.33);
const FAINT = rgb(0.42, 0.45, 0.52);
const LINE = rgb(0.8, 0.82, 0.86);
const HEAD_FILL = rgb(0.93, 0.94, 0.96);
const ZEBRA = rgb(0.975, 0.978, 0.985);
const ACCENT = rgb(0.72, 0.11, 0.11);

const PRODUCT_COL_MIN = 150;
const PRICE_COL_MIN = 50;
const ROW_H = 15;
const CELL_PAD = 4;

type Fonts = { regular: PDFFont; bold: PDFFont };

/**
 * Text the standard font can encode. Anything else becomes "?" rather than
 * throwing half way through a file — a clause typed with a curly apostrophe
 * from a phone must not cost somebody their PDF.
 */
function safe(text: string, font: PDFFont): string {
  const mapped = text.replace(/₹\s*/g, "Rs.").replace(/\t/g, " ");
  let out = "";
  for (const ch of mapped) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

function width(text: string, font: PDFFont, size: number): number {
  return font.widthOfTextAtSize(text, size);
}

/** The largest size, down to a floor, at which the text fits. Truncated with an ellipsis below the floor. */
function fit(text: string, font: PDFFont, size: number, max: number, floor: number): { text: string; size: number } {
  let s = size;
  while (s > floor && width(text, font, s) > max) s -= 0.25;
  if (width(text, font, s) <= max) return { text, size: s };
  let t = text;
  while (t.length > 1 && width(`${t}…`, font, s) > max) t = t.slice(0, -1);
  return { text: `${t.trimEnd()}…`, size: s };
}

function wrap(text: string, font: PDFFont, size: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (width(next, font, size) <= max || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function centred(page: PDFPage, text: string, y: number, font: PDFFont, size: number, color = INK) {
  const { width: w } = page.getSize();
  page.drawText(text, { x: (w - width(text, font, size)) / 2, y, size, font, color });
}

/** Portrait until the grid will not fit across it; a list with nine pack sizes turns the page. */
function pageSizeFor(columnCount: number): [number, number] {
  const need = PRODUCT_COL_MIN + columnCount * PRICE_COL_MIN + MARGIN * 2;
  return need > A4[0] ? [A4[1], A4[0]] : A4;
}

async function drawSheet(doc: PDFDocument, sheet: PriceSheet, fonts: Fonts): Promise<PDFPage[]> {
  const size = pageSizeFor(sheet.columns.length);
  const pages: PDFPage[] = [];
  let page = doc.addPage(size);
  pages.push(page);
  const W = size[0];
  const H = size[1];
  const inner = W - MARGIN * 2;
  let y = H - MARGIN;

  /* ---- letterhead ------------------------------------------------------ */
  y -= 18;
  centred(page, LETTERHEAD.company, y, fonts.bold, 18);
  y -= 12;
  for (const line of LETTERHEAD.address) {
    const f = fit(safe(line, fonts.regular), fonts.regular, 7.5, inner, 6);
    centred(page, f.text, y, fonts.regular, f.size, MUTED);
    y -= 10;
  }
  y -= 2;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: W - MARGIN, y }, thickness: 1.2, color: ACCENT });
  y -= 20;

  page.pushOperators(setCharacterSpacing(2.5));
  centred(page, "PRICE LIST", y, fonts.bold, 13);
  page.pushOperators(setCharacterSpacing(0));
  y -= 15;
  const head = fit(safe(headerLine(sheet), fonts.regular), fonts.regular, 8.5, inner, 6);
  centred(page, head.text, y, fonts.regular, head.size, MUTED);
  y -= 18;

  /* ---- grid ------------------------------------------------------------ */
  const priceCol = Math.max(PRICE_COL_MIN, Math.min(78, (inner - PRODUCT_COL_MIN) / Math.max(1, sheet.columns.length)));
  const productCol = inner - priceCol * sheet.columns.length;

  const drawHeads = () => {
    const strips: Array<{ first: string; cells: string[]; bold: boolean }> = [
      { first: "Product", cells: sheet.columns.map((c) => c.sizeLabel), bold: true },
      { first: "Pack Size", cells: sheet.columns.map((c) => c.packLabel), bold: false },
    ];
    for (const strip of strips) {
      const font = strip.bold ? fonts.bold : fonts.regular;
      page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: inner, height: ROW_H, color: HEAD_FILL, borderColor: LINE, borderWidth: 0.5 });
      const base = y - ROW_H + 4.5;
      page.drawText(strip.first, { x: MARGIN + CELL_PAD, y: base, size: 8, font, color: INK });
      strip.cells.forEach((label, i) => {
        const x0 = MARGIN + productCol + i * priceCol;
        const f = fit(safe(label, font), font, 8, priceCol - CELL_PAD * 2, 5.5);
        page.drawText(f.text, { x: x0 + priceCol - CELL_PAD - width(f.text, font, f.size), y: base, size: f.size, font, color: strip.bold ? INK : MUTED });
        page.drawLine({ start: { x: x0, y }, end: { x: x0, y: y - ROW_H }, thickness: 0.5, color: LINE });
      });
      y -= ROW_H;
    }
  };

  const newPage = () => {
    page = doc.addPage(size);
    pages.push(page);
    y = H - MARGIN - 6;
  };

  drawHeads();
  sheet.rows.forEach((row, r) => {
    if (y - ROW_H < MARGIN + 30) {
      newPage();
      drawHeads();
    }
    if (r % 2 === 1) page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: inner, height: ROW_H, color: ZEBRA });
    page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: inner, height: ROW_H, borderColor: LINE, borderWidth: 0.5 });
    const base = y - ROW_H + 4.5;
    const label = fit(safe(row.label, fonts.regular), fonts.regular, 8.5, productCol - CELL_PAD * 2, 6.5);
    page.drawText(label.text, { x: MARGIN + CELL_PAD, y: base, size: label.size, font: fonts.regular, color: INK });
    sheet.columns.forEach((column, i) => {
      const x0 = MARGIN + productCol + i * priceCol;
      const text = printedPrice(row.cells[column.key]);
      page.drawText(text, {
        x: x0 + priceCol - CELL_PAD - width(text, fonts.regular, 8.5),
        y: base,
        size: 8.5,
        font: fonts.regular,
        color: text === "—" ? FAINT : INK,
      });
      page.drawLine({ start: { x: x0, y }, end: { x: x0, y: y - ROW_H }, thickness: 0.5, color: LINE });
    });
    y -= ROW_H;
  });

  /* ---- terms ------------------------------------------------------------ */
  const clauses = printedClauses(sheet);
  const room = (need: number) => {
    if (y - need < MARGIN + 24) newPage();
  };
  if (clauses.length) {
    y -= 20;
    room(30);
    page.drawText("TERMS & CONDITIONS", { x: MARGIN, y, size: 9, font: fonts.bold, color: INK });
    y -= 13;
    clauses.forEach((clause, i) => {
      const number = `${i + 1}. `;
      const indent = width(number, fonts.regular, 7.5);
      const lines = wrap(safe(clause, fonts.regular), fonts.regular, 7.5, inner - indent);
      room(lines.length * 10);
      lines.forEach((line, j) => {
        page.drawText(j === 0 ? `${number}${line}` : line, {
          x: MARGIN + (j === 0 ? 0 : indent),
          y,
          size: 7.5,
          font: fonts.regular,
          color: MUTED,
        });
        y -= 10;
      });
      y -= 1.5;
    });
  }

  /* ---- signature -------------------------------------------------------- */
  room(80);
  y -= 12;
  page.drawText(LETTERHEAD.closing, { x: MARGIN, y, size: 8, font: fonts.regular, color: MUTED });
  y -= 22;
  page.drawText(LETTERHEAD.signOff, { x: MARGIN, y, size: 8.5, font: fonts.regular, color: INK });
  y -= 26;
  if (sheet.signatory?.trim()) {
    page.drawText(safe(sheet.signatory.trim(), fonts.bold), { x: MARGIN, y, size: 9, font: fonts.bold, color: INK });
    y -= 11;
  }
  if (sheet.signatoryTitle?.trim()) {
    page.drawText(safe(sheet.signatoryTitle.trim(), fonts.regular), { x: MARGIN, y, size: 8, font: fonts.regular, color: MUTED });
  }

  /* ---- footers: the letterhead line on the last page, a page count on every one */
  const last = pages[pages.length - 1];
  const footer = fit(safe(LETTERHEAD.footer, fonts.regular), fonts.regular, 7, inner, 5.5);
  last.drawLine({ start: { x: MARGIN, y: MARGIN + 12 }, end: { x: W - MARGIN, y: MARGIN + 12 }, thickness: 0.5, color: LINE });
  centred(last, footer.text, MARGIN + 2, fonts.regular, footer.size, FAINT);
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const text = `Page ${i + 1} of ${pages.length}`;
      p.drawText(text, { x: W - MARGIN - width(text, fonts.regular, 7), y: MARGIN - 14, size: 7, font: fonts.regular, color: FAINT });
    });
  }
  return pages;
}

/**
 * One price list, or several — one per page run — in one file.
 *
 * Several is the bulk export: thirty lists as thirty files is thirty downloads
 * the browser asks about one at a time, and one file with every list in it is
 * what somebody actually forwards or prints.
 */
export async function renderPriceSheetsPdf(sheets: PriceSheet[], opts?: { title?: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  for (const sheet of sheets) await drawSheet(doc, sheet, fonts);
  const title = opts?.title ?? (sheets.length === 1 ? sheets[0].name : `Price lists (${sheets.length})`);
  doc.setTitle(safe(title, fonts.regular));
  doc.setAuthor("Mahek Marketing India");
  doc.setCreator("MahekOne");
  doc.setProducer("MahekOne price lists");
  doc.setSubject(sheets.map((s) => s.refNo ?? s.name).join(", "));
  // A fixed date keeps the bytes a function of the list alone, so the same
  // list drawn twice is the same file — which is what the document table's
  // hash deduplication relies on.
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  return doc.save();
}

export function renderPriceSheetPdf(sheet: PriceSheet): Promise<Uint8Array> {
  return renderPriceSheetsPdf([sheet]);
}

/** "Odisha To Pay — August 2026" → "Odisha-To-Pay-August-2026.pdf". */
export function pdfFilename(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${slug || "price-list"}.pdf`;
}
