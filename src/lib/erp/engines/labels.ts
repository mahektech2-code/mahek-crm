/* ---------------------------------------------------------------------------
 * THE FOUR ERP LABELS — what each carries and how its words are sized. PURE,
 * no I/O, client-safe: the print page draws them and the label printer is sent
 * exactly what the page drew, so a rule about what fits on a label lives here
 * once and is testable without a browser or a printer.
 *
 *   box       50 × 50 mm   a packed box (or a labelled loose can), with its QR
 *   sfg       80 × 80 mm   a semi-finished lot, QR = the lot code
 *   purchase  80 × 80 mm   a raw-material lot on its drum, QR = the lot number
 *   dispatch  80 × 80 mm   the dispatch sticker: one per box or can leaving on an approved invoice
 *
 * A label is cut to a fixed size and nobody is there to scroll it, so every
 * value that can be long is given a type size that FITS rather than a size
 * that looks right on the sample. The widths below are Helvetica Bold's own
 * (Arial's are the same), which is what the labels are set in.
 * ------------------------------------------------------------------------- */

export type LabelKind = "box" | "sfg" | "purchase" | "dispatch";

/** The stock each label is printed on: a square, this many millimetres a side. */
export const LABEL_MM: Record<LabelKind, number> = { box: 50, sfg: 80, purchase: 80, dispatch: 80 };

export const LABEL_NAME: Record<LabelKind, string> = { box: "Box label", sfg: "SFG label", purchase: "Purchase label", dispatch: "Dispatch label" };

export type BoxLabel = {
  kind: "box";
  /** The box's own id — what the QR carries. */
  id: string;
  /** "1 L", "500 ml". */
  size: string;
  /** Cans in the box; null on a loose can or drum. */
  cans: number | null;
  /** The product, without the company's name in front. */
  name: string;
  /** "Batch" for a box, "Lot" for a loose unit. */
  lotWord: string;
  lot: string;
  /** "Box" or "Unit", its number in the batch or lot, and how many the batch made where that is known. */
  unitWord: string;
  seq: number;
  of: number | null;
  /** The packing date, ISO; null where the record has none. */
  date: string | null;
};

export type SfgLabel = {
  kind: "sfg";
  /** Semi Finished | Transfer — how the lot reached this godown. */
  type: string;
  product: string;
  lot: string;
  batches: number | null;
  batchSizeLitres: number | null;
  date: string;
  location: string;
  inventoryId: string;
};

export type PurchaseLabel = {
  kind: "purchase";
  item: string;
  lot: string;
  date: string;
  quantity: number;
  unit: string;
  inLitre: number;
  density: number | null;
  drums: number | null;
  litresPerDrum: number | null;
  prNumber: number;
  prBillNo: string;
  testingId: string | null;
  remark: string | null;
};

/**
 * THE DISPATCH STICKER (Order-to-Delivery PRD, rule 5 and step 7): the
 * customer, the product, the invoice number and the order number — and nothing
 * else. It carries no lot code and no box code: those are on the box's own
 * label, made by the box-id system, and the two are never one sticker.
 */
export type DispatchLabel = {
  kind: "dispatch";
  orderNo: number;
  /** The Tally invoice number, recorded at billing and approved by the checker. */
  invoiceNo: string;
  customer: string;
  product: string;
};

export type Label = BoxLabel | SfgLabel | PurchaseLabel | DispatchLabel;

/** A QR code as its modules: `n` a side, `bits` row by row, "1" dark. */
export type Qr = { n: number; bits: string };

/* ============================================================= words */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-08" → "08 Oct 2026". Anything that is not an ISO date is returned as it came. */
export function labelDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return iso;
  return `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}`;
}

/** 205 → "205", 0.84 → "0.84", 12.5 → "12.5": a figure as a person would write it on a drum. */
export function labelNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return String(Math.round(n * 100) / 100);
}

/**
 * The product name as the box label prints it. "MAHEK" is already across the
 * top of the label, so a name that starts with it loses the word rather than
 * saying it twice in the little room there is.
 */
export function productLine(name: string): string {
  const s = name.trim().replace(/\s+/g, " ");
  const rest = s.replace(/^mahek\s+/i, "");
  return rest || s;
}

/**
 * An ERP id (`ord_3f9c1a2b4d5e6f70`) as a short reference: the first eight
 * characters of its own part, in capitals. The whole id does not fit beside
 * the order number, and the list the label came from shows it in full.
 */
export function shortRef(id: string): string {
  const own = id.includes("_") ? id.slice(id.lastIndexOf("_") + 1) : id;
  return own.slice(0, 8).toUpperCase();
}

/** "12 cans", "1 can", "2 drums": what was ordered, in the unit the line is counted in. */
export function orderQty(type: string, qty: number): string {
  const word = type === "Drum" ? "drum" : "can";
  return `${qty} ${word}${qty === 1 ? "" : "s"}`;
}

/**
 * LOT SIZE on a dispatch label: every label on the whole order added up, so
 * whoever loads the lorry — and whoever takes delivery — can count the pieces
 * against one number printed on each of them.
 */
export function lotSize(lines: { labels: number }[]): number {
  return lines.reduce((sum, l) => sum + Math.max(0, Math.round(l.labels)), 0);
}

/** How many copies a request may ask for: at least one, and never a roll's worth by a slip of the finger. */
export const MAX_COPIES = 200;

export function copiesOf(raw: string | number | null | undefined, fallback: number): number {
  const n = typeof raw === "number" ? raw : raw != null && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  const v = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.min(MAX_COPIES, Math.max(1, Math.round(v)));
}

/* ======================================================= fitting text */

/* Helvetica Bold advance widths, in thousandths of an em, for ASCII 32–126. */
const BOLD: number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584,
  584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667,
  611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556,
  778, 556, 556, 500, 389, 280, 389, 584,
];

const PT_PER_MM = 72 / 25.4;

/** How wide a run of bold text is, in ems. A character outside ASCII is counted as a wide capital. */
export function boldWidthEm(text: string): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    w += c >= 32 && c <= 126 ? BOLD[c - 32] : 722;
  }
  return w / 1000;
}

/** How many lines bold text takes at a size in a column, breaking only between words. */
export function boldLines(text: string, pt: number, widthMm: number): number {
  const room = (widthMm * PT_PER_MM) / pt;
  const space = BOLD[0] / 1000;
  let lines = 1;
  let used = 0;
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const w = boldWidthEm(word);
    if (used === 0) used = w;
    else if (used + space + w <= room) used += space + w;
    else {
      lines += 1;
      used = w;
    }
  }
  return lines;
}

/**
 * The largest of `sizes` at which `text` fits `widthMm` in `maxLines` lines —
 * the smallest of them where none does, and the label's own clipping takes
 * what is left. A little room is held back, because a label printer's Arial
 * is not always exactly Arial.
 */
export function fitPt(text: string, widthMm: number, sizes: number[], maxLines = 1): number {
  const room = widthMm * 0.96 * PT_PER_MM;
  const fits = (pt: number) => {
    if (maxLines === 1) return boldWidthEm(text) * pt <= room;
    const words = text.trim().split(/\s+/).filter(Boolean);
    return words.every((w) => boldWidthEm(w) * pt <= room) && boldLines(text, pt, widthMm * 0.96) <= maxLines;
  };
  return sizes.find(fits) ?? sizes[sizes.length - 1];
}

/* The sizes each long value steps down through, largest first, and the room it has. */

/** The pack size beside the QR on a box label: 17 mm of room. */
export const packSizePt = (size: string) => fitPt(size, 17, [27, 24, 21, 18, 16, 14, 13]);
/**
 * The product name under the rule on a box label: one line of 44 mm, as large
 * as it goes. A name too long for one line at a readable size takes two
 * smaller ones instead of losing its last word to an ellipsis.
 */
export function boxNameFit(name: string): { pt: number; lines: 1 | 2 } {
  const one = [14, 13, 12, 11, 10];
  const pt = fitPt(name, 44, one);
  if (boldWidthEm(name) * pt <= 44 * 0.96 * PT_PER_MM) return { pt, lines: 1 };
  return { pt: fitPt(name, 44, [10, 9], 2), lines: 2 };
}
/**
 * The last line of a box label: the batch and the box's place in it on the
 * left, the packing date on the right, in 44 mm. "Box 1 of 5" at 6 pt where
 * that fits; the same words a touch smaller where it does not; and
 * "Box 118/120" for the batch of a hundred and twenty that still would not.
 */
export function boxFoot(l: Pick<BoxLabel, "lotWord" | "lot" | "unitWord" | "seq" | "of" | "date">): { position: string; pt: number } {
  /* The words that are not bold are a little narrower than the table says. */
  const regular = 0.93;
  const lead = boldWidthEm(`${l.lotWord} `) * regular + boldWidthEm(l.lot) + boldWidthEm(" . ") * regular;
  const date = l.date ? boldWidthEm(labelDate(l.date)) * regular : 0;
  const long = l.of ? `${l.unitWord} ${l.seq} of ${l.of}` : `${l.unitWord} ${l.seq}`;
  const short = l.of ? `${l.unitWord} ${l.seq}/${l.of}` : long;
  const room = (pt: number) => ((44 - (l.date ? 2 : 0)) * 0.97 * PT_PER_MM) / pt;
  const tries: [string, number][] = [
    [long, 6],
    [long, 5.5],
    [short, 5.5],
  ];
  for (const [position, pt] of tries) if (lead + boldWidthEm(position) + date <= room(pt)) return { position, pt };
  return { position: short, pt: 5.5 };
}

/** The product on an SFG label: two lines beside a 24 mm QR. */
export const sfgNamePt = (name: string) => fitPt(name, 44, [20, 18, 16, 14, 12], 2);
/** The lot code across an SFG label. */
export const sfgLotPt = (lot: string) => fitPt(lot, 70, [26, 23, 20, 17, 14]);
/** The item on a purchase label: two lines beside a 22 mm QR. */
export const purchaseNamePt = (name: string) => fitPt(name, 46, [20, 18, 16, 14, 12], 2);
/** The lot number on a purchase label, which shares its line with the purchase date. */
export const purchaseLotPt = (lot: string) => fitPt(lot, 42, [24, 21, 18, 15, 12]);
/** Who a dispatch label is going to: two lines across the label. */
export const partyPt = (name: string) => fitPt(name, 72, [16, 14, 12], 2);
/** The goods on a dispatch label: two lines across the label. */
export const skuPt = (name: string) => fitPt(name, 72, [14, 13, 12, 11], 2);
/** The transporter on a dispatch label: two lines across the label. */
export const transporterPt = (name: string) => fitPt(name, 72, [13, 12, 11], 2);

/* ======================================================== print runs */

export type PrintRun<T> = { item: T; copies: number };

/**
 * Labels that are the same label, one after another, become one label printed
 * several times — the printer is told "three of these" rather than being sent
 * the same picture three times. `keyOf` says what "the same" means.
 */
export function printRuns<T>(items: T[], keyOf: (item: T) => string): PrintRun<T>[] {
  const runs: PrintRun<T>[] = [];
  let last: string | null = null;
  for (const item of items) {
    const key = keyOf(item);
    if (runs.length && key === last) runs[runs.length - 1].copies += 1;
    else runs.push({ item, copies: 1 });
    last = key;
  }
  return runs;
}
