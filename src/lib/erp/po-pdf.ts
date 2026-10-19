import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { poLineFigures, poTotals } from "./engines/purchase-flow";

/* ---------------------------------------------------------------------------
 * THE PURCHASE ORDER AS A PDF — what a vendor receives when a PO is shared:
 * attached to the email, and behind the link in the WhatsApp message. It is
 * the printed PO (`/erp/po/<id>`) drawn as a file, from the same figures
 * (`poLineFigures`, `poTotals`), so the paper and the PDF cannot disagree.
 *
 * Pure: pdf-lib runs anywhere and nothing here reads the database. The
 * standard Helvetica cannot draw ₹, so money is "Rs." — the rule the price
 * lists already follow.
 * ------------------------------------------------------------------------- */

export type PoPdfInput = {
  name: string;
  /** "18 Oct 2026". */
  date: string;
  company: string;
  vendor: { name: string; phone: string | null; email: string | null };
  deliverTo: string;
  deliveryBy: string;
  paymentTerms: string;
  freightPaise: number;
  remarks: string | null;
  lines: { item: string; quantity: number; unit: string; ratePaise: number; gstBp: number }[];
  approvedBy: string | null;
  approvedOn: string | null;
};

const W = 595.28;
const H = 841.89;
const M = 44;
const INK = rgb(0.09, 0.09, 0.09);
const BODY = rgb(0.24, 0.27, 0.33);
const MUTED = rgb(0.42, 0.45, 0.52);
const LINE = rgb(0.85, 0.87, 0.9);

type Fonts = { regular: PDFFont; bold: PDFFont };

/** Text the standard font can encode; anything else becomes "?" rather than failing the file. */
function safe(text: string, font: PDFFont): string {
  const mapped = text.replace(/₹\s*/g, "Rs. ").replace(/[\t\r\n]+/g, " ");
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

/** Rupees with Indian grouping, paise only where there are any. */
export function rs(paise: number): string {
  return "Rs. " + (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

/** Cut to fit a width, ending in "…" (drawn as "...") when it had to be cut. */
function fit(text: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t + "...", size) > width) t = t.slice(0, -1);
  return t + "...";
}

/** Words wrapped to a width, at most `max` lines. */
function wrap(text: string, font: PDFFont, size: number, width: number, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      if (line) out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  if (out.length > max) return [...out.slice(0, max - 1), fit(out.slice(max - 1).join(" "), font, size, width)];
  return out;
}

export async function renderPoPdf(po: PoPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const f: Fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const s = (t: string, bold = false) => safe(t, bold ? f.bold : f.regular);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const text = (t: string, x: number, yy: number, o: { size?: number; bold?: boolean; color?: typeof INK; right?: boolean } = {}) => {
    const font = o.bold ? f.bold : f.regular;
    const size = o.size ?? 9.5;
    const str = s(t, o.bold);
    const xx = o.right ? x - font.widthOfTextAtSize(str, size) : x;
    page.drawText(str, { x: xx, y: yy, size, font, color: o.color ?? INK });
  };
  const rule = (yy: number, color = LINE, thickness = 0.8) => page.drawLine({ start: { x: M, y: yy }, end: { x: W - M, y: yy }, thickness, color });

  /* Header: who, and which PO. */
  text(po.company, M, y - 4, { size: 15, bold: true });
  text("Purchase order", M, y - 20, { color: BODY });
  text(po.name, W - M, y - 6, { size: 20, bold: true, right: true });
  text(`Date ${po.date}`, W - M, y - 22, { color: BODY, right: true });
  y -= 46;
  rule(y);
  y -= 18;

  /* Vendor and delivery, side by side. */
  const half = (W - 2 * M) / 2;
  const block = (x: number, label: string, lines: { t: string; bold?: boolean }[]) => {
    text(label.toUpperCase(), x, y, { size: 7.5, color: MUTED });
    lines.forEach((l, i) => text(fit(s(l.t, l.bold), l.bold ? f.bold : f.regular, 9.5, half - 12), x, y - 14 - i * 13, { bold: l.bold, color: l.bold ? INK : BODY }));
  };
  block(M, "Vendor", [{ t: po.vendor.name, bold: true }, ...(po.vendor.phone ? [{ t: po.vendor.phone }] : []), ...(po.vendor.email ? [{ t: po.vendor.email }] : [])]);
  block(M + half, "Deliver to", [{ t: po.deliverTo, bold: true }, { t: `By ${po.deliveryBy}` }, { t: `Payment: ${po.paymentTerms}` }]);
  y -= 14 + 3 * 13 + 14;

  /* The lines. */
  const cols = [
    { l: "#", x: M, w: 18 },
    { l: "Item", x: M + 18, w: 160 },
    { l: "Quantity", x: M + 178, w: 68, right: true },
    { l: "Rate", x: M + 246, w: 62, right: true },
    { l: "Amount", x: M + 308, w: 70, right: true },
    { l: "GST", x: M + 378, w: 38, right: true },
    { l: "Total", x: M + 416, w: W - 2 * M - 416, right: true },
  ];
  const head = () => {
    rule(y + 4, INK, 1);
    cols.forEach((c) => text(c.l.toUpperCase(), c.right ? c.x + c.w : c.x, y - 8, { size: 7.5, color: MUTED, right: c.right }));
    y -= 14;
    rule(y + 1, INK, 1);
    y -= 13;
  };
  head();
  po.lines.forEach((l, i) => {
    const fig = poLineFigures(l);
    const name = wrap(s(l.item), f.regular, 9.5, cols[1].w - 6, 2);
    const h = 13 * name.length + 5;
    if (y - h < M + 120) {
      page = doc.addPage([W, H]);
      y = H - M;
      head();
    }
    text(String(i + 1), cols[0].x, y);
    name.forEach((n, k) => text(n, cols[1].x, y - k * 13, { bold: k === 0 }));
    text(`${l.quantity.toLocaleString("en-IN")} ${l.unit}`, cols[2].x + cols[2].w, y, { right: true });
    text(rs(l.ratePaise), cols[3].x + cols[3].w, y, { right: true });
    text(rs(fig.amountPaise), cols[4].x + cols[4].w, y, { right: true });
    text(`${l.gstBp / 100}%`, cols[5].x + cols[5].w, y, { right: true });
    text(rs(fig.totalPaise), cols[6].x + cols[6].w, y, { right: true });
    y -= h;
    rule(y + 8);
    y -= 4;
  });

  /* Totals, right-aligned. */
  const t = poTotals(po.lines, po.freightPaise);
  y -= 8;
  const sumRow = (label: string, v: string, strong = false) => {
    text(label, W - M - 190, y, { color: strong ? INK : BODY, bold: strong, size: strong ? 11 : 9.5 });
    text(v, W - M, y, { right: true, bold: strong, size: strong ? 11 : 9.5 });
    y -= strong ? 18 : 14;
  };
  sumRow("Amount", rs(t.amountPaise));
  sumRow("GST", rs(t.gstPaise));
  if (t.freightPaise) sumRow("Freight", rs(t.freightPaise));
  page.drawLine({ start: { x: W - M - 190, y: y + 10 }, end: { x: W - M, y: y + 10 }, thickness: 1, color: INK });
  y -= 2;
  sumRow("Total", rs(t.totalPaise), true);

  if (po.remarks) {
    y -= 6;
    text("NOTE", M, y, { size: 7.5, color: MUTED });
    wrap(s(po.remarks), f.regular, 9.5, W - 2 * M, 6).forEach((ln, k) => text(ln, M, y - 14 - k * 13, { color: BODY }));
  }

  /* Footer on the last page. */
  page.drawLine({ start: { x: M, y: M + 34 }, end: { x: W - M, y: M + 34 }, thickness: 0.8, color: LINE });
  text(`Please quote ${po.name} on your invoice and delivery challan.`, M, M + 18, { color: BODY });
  if (po.approvedBy || po.approvedOn) text(`Approved${po.approvedBy ? ` by ${po.approvedBy}` : ""}${po.approvedOn ? ` · ${po.approvedOn}` : ""}`, W - M, M + 18, { color: BODY, right: true });

  doc.setTitle(s(`${po.name} — ${po.vendor.name}`));
  doc.setAuthor(s(po.company));
  doc.setCreator("MahekOne");
  doc.setProducer("MahekOne purchase orders");
  /* Same PO, same bytes: the file is a function of the PO alone. */
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  return doc.save();
}

/** "PO-411" → "PO-411.pdf"; anything a filename should not carry becomes "-". */
export function poPdfFilename(name: string): string {
  return `${name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "purchase-order"}.pdf`;
}
