/* ---------------------------------------------------------------------------
 * A PRICE LIST AS A SHEET OF PAPER — the one model every copy is drawn from.
 *
 * Mahek has sent the same one-page document out for years: a letterhead,
 * "PRICE LIST", one line naming the reference, the effective date, the tax
 * basis and who pays the transport, a grid of products down and pack sizes
 * across with a price in every cell, numbered terms, and a signature. The
 * parser in `price-list-parse.ts` reads that document IN. This file is the
 * same document going OUT, and it is deliberately the parser's mirror image:
 * every label it writes is one the parser reads back to the same pack, and
 * every figure is printed the way the parser expects a figure to look.
 *
 * ONE MODEL, FOUR RENDERINGS. The PDF (`price-sheet-pdf.ts`), the HTML print
 * page, the CSV export and the editor's grid are all drawn from a
 * `PriceSheet`, so the paper a shop is handed, the spreadsheet accounts
 * reconcile against and the screen somebody typed the prices into cannot say
 * three different things.
 *
 * AND IT IS CHECKED BY READING IT BACK. `compareReadBack` takes what the
 * parser made of a generated PDF and says, cell by cell, whether the paper
 * says what was typed. A generated list is only as good as the claim that the
 * document matches the data behind it, and that claim is cheap to prove.
 *
 * Pure and client-safe: the editor runs in a browser and the export routes on
 * the server, and both import from here.
 * ------------------------------------------------------------------------- */

import type { PriceDeliveryBasis, PriceDiscountKind, PriceFreightTerm } from "@/db/schema";
import { exFromIncl, inclFromEx } from "@/lib/engines/price-math";
import { matchKey } from "@/lib/catalogue";

/* ------------------------------------------------------------ letterhead */

/** Mahek's own letterhead, verbatim from the lists the office sends. */
export const LETTERHEAD = {
  company: "MAHEK MARKETING INDIA",
  address: [
    "Off: Ashok Industrial Estate, Gala No 111, L.B.S. Marg, Bhandup (W), Mumbai-400078",
    "Factory: Pale MIDC, Plot M30, Ambernath, Thane | Email: info@mahekindia.com | Tel: 7208114573",
  ],
  footer: "www.mahekmarketingindia.com | Mahek Marketing India — Quality Stand First Since 1995",
  closing: "We strive to provide you the best service and look forward to your valuable order.",
  signOff: "For Mahek Marketing India",
} as const;

/* ------------------------------------------------------------------ types */

export type Container = "can" | "tin" | "drum" | "loose";

export type SheetColumn = {
  /** `${millilitres}|${container}|${cansPerBox}` — the pack, not its label. */
  key: string;
  millilitres: number | null;
  cansPerBox: number | null;
  container: Container;
  /** "500 ml", "20 Litre", "20L Tin Can" — the top strip of the header. */
  sizeLabel: string;
  /** "50/bx", "01 Can", "Loose" — the strip under it. */
  packLabel: string;
};

export type SheetCell = {
  /** The SKU this cell prices. Null where the catalogue has no such pack of this product. */
  productId: string | null;
  /** In the list's own tax basis — GST-inclusive on every sample. Null is not yet priced. */
  printedPaise: number | null;
  /** False prints a dash: listed, and not sold in this pack on this list. */
  offered: boolean;
};

export type SheetRow = {
  key: string;
  /** What the paper prints down the side — "Maruti Nano Thinner". */
  label: string;
  /** The catalogue family the row's cells are drawn from. */
  familyKey: string;
  cells: Record<string, SheetCell>;
};

export type SheetDiscount = {
  kind: PriceDiscountKind;
  percentBp: number;
  thresholdLitres: number | null;
  thresholdPaise: number | null;
};

export type PriceSheet = {
  name: string;
  refNo: string | null;
  effectiveFrom: string;
  validityDays: number | null;
  taxBasis: "inclusive" | "exclusive";
  gstBp: number;
  deliveryBasis: PriceDeliveryBasis | null;
  freightTerm: PriceFreightTerm;
  columns: SheetColumn[];
  rows: SheetRow[];
  /** The numbered clauses, without their numbers. */
  terms: string[];
  discounts: SheetDiscount[];
  signatory: string | null;
  signatoryTitle: string | null;
};

/** What the editor and the grid builder need to know about a SKU. */
export type SheetProduct = {
  id: string;
  name: string;
  millilitresPerCan: number | null;
  cansPerBox: number | null;
  packing: string | null;
  brandName: string | null;
  formulationName: string | null;
  active: boolean;
};

/* ------------------------------------------------------------------ packs */

export function containerOf(p: Pick<SheetProduct, "name" | "packing">): Container {
  const name = p.name.toLowerCase();
  const packing = (p.packing ?? "").toLowerCase();
  if (/tin/.test(packing) || /tin\s*can/.test(name)) return "tin";
  if (/drum/.test(packing) || /drum/.test(name)) return "drum";
  if (/loose/.test(packing) || /\(loose\)/.test(name)) return "loose";
  return "can";
}

function litres(ml: number): string {
  const l = ml / 1000;
  return Number.isInteger(l) ? String(l) : String(Number(l.toFixed(2)));
}

/**
 * The two header strips for one pack, written so `parsePackColumn` reads
 * them back to the same millilitres, container and cans per box. That is the
 * whole constraint on the wording, and `price-sheet.test.ts` pins it.
 */
export function packLabels(
  millilitres: number | null,
  container: Container,
  cansPerBox: number | null,
): { sizeLabel: string; packLabel: string } {
  const size =
    millilitres == null
      ? "?"
      : millilitres < 1000
        ? `${millilitres} ml`
        : container === "tin"
          ? `${litres(millilitres)}L Tin Can`
          : container === "drum"
            ? `${litres(millilitres)} Litre Drum`
            : `${litres(millilitres)} Litre`;
  const pack =
    container === "loose"
      ? "Loose"
      : container === "drum"
        ? "Drum"
        : container === "tin"
          ? `${String(cansPerBox && cansPerBox > 1 ? cansPerBox : 1).padStart(2, "0")} Can`
          : cansPerBox == null
            ? "01 Can"
            : cansPerBox <= 1
              ? "01 Can"
              : `${String(cansPerBox).padStart(2, "0")}/bx`;
  return { sizeLabel: size, packLabel: pack };
}

export function columnKey(millilitres: number | null, container: Container, cansPerBox: number | null): string {
  const cpb = container === "loose" || container === "drum" ? 1 : (cansPerBox ?? 1);
  return `${millilitres ?? "?"}|${container}|${cpb}`;
}

export function columnOf(p: SheetProduct): SheetColumn {
  const container = containerOf(p);
  const cansPerBox = container === "loose" || container === "drum" ? 1 : p.cansPerBox;
  return {
    key: columnKey(p.millilitresPerCan, container, cansPerBox),
    millilitres: p.millilitresPerCan,
    cansPerBox,
    container,
    ...packLabels(p.millilitresPerCan, container, cansPerBox),
  };
}

const CONTAINER_ORDER: Record<Container, number> = { can: 0, loose: 1, tin: 2, drum: 3 };

/** Smallest pack first, then the plain can before the loose, the tin and the drum — the order the paper uses. */
export function sortColumns(columns: SheetColumn[]): SheetColumn[] {
  return [...columns].sort(
    (a, b) =>
      (a.millilitres ?? 0) - (b.millilitres ?? 0) ||
      CONTAINER_ORDER[a.container] - CONTAINER_ORDER[b.container] ||
      (b.cansPerBox ?? 0) - (a.cansPerBox ?? 0),
  );
}

/* --------------------------------------------------------------- families */

/**
 * The line a SKU belongs to — one row on the paper. The brand where the
 * catalogue names one, otherwise the SKU name before its pack size, which is
 * the same rule the list detail's grid uses.
 */
export function familyOf(p: Pick<SheetProduct, "name" | "brandName">): string {
  if (p.brandName) return p.brandName;
  const i = p.name.indexOf(" - ");
  return i > 0 ? p.name.slice(0, i) : p.name;
}

export function familyKeyOf(p: Pick<SheetProduct, "name" | "brandName">): string {
  return familyOf(p).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type Family = { key: string; name: string; formulation: string | null; products: SheetProduct[]; active: boolean };

/** The catalogue as the rows a price list can have, biggest line first. */
export function familiesOf(products: SheetProduct[]): Family[] {
  const by = new Map<string, Family>();
  for (const p of products) {
    const key = familyKeyOf(p);
    const f = by.get(key) ?? { key, name: familyOf(p), formulation: p.formulationName, products: [], active: false };
    f.products.push(p);
    f.active = f.active || p.active;
    by.set(key, f);
  }
  return [...by.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

/**
 * The SKU a family sells in one pack. Active before retired, then by name, so
 * two catalogue rows for one pack resolve the same way every time.
 */
export function skuFor(family: Family | undefined, column: SheetColumn): SheetProduct | null {
  if (!family) return null;
  const hits = family.products.filter((p) => columnOf(p).key === column.key);
  hits.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  return hits[0] ?? null;
}

/* ----------------------------------------------------------------- money */

/** 116800 → "1,168"; 116850 → "1,168.50". Indian grouping, as the office prints. */
export function groupRupees(paise: number): string {
  const whole = Math.floor(Math.abs(paise) / 100);
  const fraction = Math.abs(paise) % 100;
  const s = String(whole);
  const grouped = s.length <= 3 ? s : `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${s.slice(-3)}`;
  return fraction ? `${grouped}.${String(fraction).padStart(2, "0")}` : grouped;
}

/** "Rs.1,168" or a dash — the only two things a cell on the paper says. */
export function printedPrice(cell: SheetCell | undefined): string {
  if (!cell || !cell.offered || cell.printedPaise == null) return "—";
  return `Rs.${groupRupees(cell.printedPaise)}`;
}

/** "1,168" or "1168.50" typed into a box → paise. Null for anything else. */
export function parseTypedRupees(raw: string): number | null {
  const t = raw.trim().replace(/^(?:rs\.?|₹|inr)\s*/i, "").replace(/,/g, "");
  if (!t) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/* ---------------------------------------------------------------- header */

const DELIVERY_PRINTED: Record<PriceDeliveryBasis, string> = {
  for_mumbai: "FOR Mumbai",
  for_godown: "FOR Godown",
  door_delivery: "Door Delivery",
  ex_factory: "Ex Factory",
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-08-01" → "01 August 2026" — the form the parser's `parseLongDate` reads first. */
export function printedDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d} ${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

function pct(bp: number): string {
  const p = bp / 100;
  return Number.isInteger(p) ? String(p) : p.toFixed(2).replace(/0$/, "");
}

/**
 * "Ref. No. PL102 | Effective: 01 August 2026 | GST 18% Inclusive | FOR Godown
 * (Transportation paid)". Every part is phrased the way `parseHeader` reads it.
 */
export function headerLine(sheet: Pick<PriceSheet, "refNo" | "effectiveFrom" | "taxBasis" | "gstBp" | "deliveryBasis" | "freightTerm">): string {
  const freight =
    sheet.freightTerm === "paid" ? " (Transportation paid)" : sheet.freightTerm === "to_pay" ? " (Transportation to pay)" : "";
  const parts = [
    sheet.refNo ? `Ref. No. ${sheet.refNo}` : null,
    `Effective: ${printedDate(sheet.effectiveFrom)}`,
    `GST ${pct(sheet.gstBp)}% ${sheet.taxBasis === "inclusive" ? "Inclusive" : "Extra"}`,
    sheet.deliveryBasis ? `${DELIVERY_PRINTED[sheet.deliveryBasis]}${freight}` : freight ? freight.trim().replace(/[()]/g, "") : null,
  ];
  return parts.filter((p): p is string => !!p).join(" | ");
}

/* ----------------------------------------------------------------- terms */

/**
 * The clauses the office prints, as a starting point for a list built here.
 * Filled from the list's own facts — the date, the GST rate, the delivery
 * basis — so a new list does not print last month's date in its first line.
 */
export function defaultTerms(sheet: Pick<PriceSheet, "effectiveFrom" | "gstBp" | "taxBasis" | "deliveryBasis" | "validityDays">): string[] {
  const days = sheet.validityDays ?? 30;
  const gst = `${pct(sheet.gstBp)}%`;
  const delivery =
    sheet.deliveryBasis === "for_godown"
      ? "Prices are on a FOR Transporter Godown basis. Freight and transportation charges up to the transporter's godown are included. Any further transportation beyond the transporter's godown, if applicable, shall be borne by the buyer."
      : sheet.deliveryBasis === "for_mumbai"
        ? "Prices are on a FOR Mumbai basis. Freight and transportation charges beyond Mumbai shall be borne by the buyer."
        : sheet.deliveryBasis === "door_delivery"
          ? "Prices include delivery to the buyer's door."
          : sheet.deliveryBasis === "ex_factory"
            ? "Prices are ex factory. Freight and transportation charges shall be borne by the buyer."
            : null;
  return [
    `This price list supersedes and cancels all previously issued price lists with immediate effect from ${printedDate(sheet.effectiveFrom)}.`,
    `All prices listed are valid for ${days} days from the effective date or until the next revised quotation is issued, whichever is earlier.`,
    sheet.taxBasis === "inclusive"
      ? `All prices are inclusive of GST @ ${gst}. No additional tax will be levied unless mandated by applicable government regulation.`
      : `All prices are exclusive of GST, which will be charged extra @ ${gst}.`,
    ...(delivery ? [delivery] : []),
    "Payment is to be made by cheque, NEFT/RTGS, or pay order in favour of Mahek Marketing India. No credit is extended unless agreed in writing prior to the order.",
    "Any complaint regarding product quality or quantity must be raised in writing within 15 days of the invoice date. Claims raised after this period will not be entertained. Goods once dispatched are non-returnable unless a manufacturing defect is established.",
    "Mahek Marketing India guarantees consistent quality backed by lab-tested certificates. In the event of a quality concern, the matter will be resolved after due inspection.",
    "Orders once confirmed cannot be cancelled without prior written consent from Mahek Marketing India.",
    "All disputes shall be subject to the exclusive jurisdiction of courts in Mumbai, Maharashtra.",
  ];
}

/**
 * A stored terms block back into clauses. The parser keeps wrapped lines as
 * they fell on the page, so a line that does not start with a number belongs
 * to the clause above it.
 */
export function splitTerms(text: string | null | undefined): string[] {
  if (!text?.trim()) return [];
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const numbered = line.match(/^\d+[.)]\s*(.*)$/);
    if (numbered) out.push(numbered[1].trim());
    else if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${line}`;
    else out.push(line);
  }
  return out;
}

export function joinTerms(terms: string[]): string | null {
  const clean = terms.map((t) => t.trim()).filter(Boolean);
  return clean.length ? clean.map((t, i) => `${i + 1}. ${t}`).join("\n") : null;
}

/** A discount said as a clause the parser reads back to the same kind and figure. */
export function discountClause(d: SheetDiscount): string {
  const p = `${pct(d.percentBp)}%`;
  switch (d.kind) {
    case "advance_payment":
      return `A discount of ${p} is allowed on advance payment.`;
    case "prompt_payment":
      return `A discount of ${p} is allowed for prompt payment within 7 days.`;
    case "quantity":
      if (d.thresholdLitres) return `A quantity discount of ${p} is allowed on orders of ${d.thresholdLitres} litres and above.`;
      if (d.thresholdPaise) return `A quantity discount of ${p} is allowed on orders of Rs.${groupRupees(d.thresholdPaise)} and above.`;
      return `A quantity discount of ${p} is allowed.`;
    case "other":
      return `A special discount of ${p} is allowed.`;
  }
}

/** Every clause that goes on the paper: the list's own, then its discounts. */
export function printedClauses(sheet: Pick<PriceSheet, "terms" | "discounts">): string[] {
  return [...sheet.terms.map((t) => t.trim()).filter(Boolean), ...sheet.discounts.map(discountClause)];
}

/**
 * A clause that only restates a structured discount. Loading a list that was
 * imported from a PDF, its terms block already carries the discount sentence
 * AND the structured term was read out of it; printing both would say the
 * discount twice.
 */
export function isDiscountClause(clause: string, discounts: SheetDiscount[]): boolean {
  if (/\bGST\b/i.test(clause)) return false;
  const m = clause.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return false;
  const bp = Math.round(Number(m[1]) * 100);
  return discounts.some((d) => d.percentBp === bp);
}

/* ------------------------------------------------------------ from rates */

export type SheetRate = {
  productId: string;
  rateExGstPaise: number;
  rateInclGstPaise: number;
  offered: boolean;
  minCans: number | null;
  rawProductText: string | null;
  product: SheetProduct;
};

/**
 * A stored list as paper.
 *
 * A ROW IS WHAT THE PAPER PRINTED, not a catalogue brand. The office prints
 * "Astar M126 Thinner" once, and the catalogue files its packs under two
 * brands — so grouping by brand split one printed line into two rows with the
 * same name, which reprints the list with a line in it twice. Rows are keyed
 * on the printed name where the rate carries one and fall back to the brand
 * where it does not (a list typed on the detail screen), and `familyKey` is
 * the brand most of the row's SKUs belong to, which is what adding a pack to
 * the row later looks up.
 */
export function sheetFromRates(
  meta: Omit<PriceSheet, "columns" | "rows">,
  rates: SheetRate[],
): PriceSheet {
  const columns = new Map<string, SheetColumn>();
  type Building = SheetRow & { families: Map<string, number>; firstFamily: string };
  const rows = new Map<string, Building>();
  const flat = rates.filter((r) => r.minCans == null || r.minCans <= 1);
  for (const r of flat) {
    const column = columnOf(r.product);
    columns.set(column.key, column);
    const printed = r.rawProductText?.trim() || null;
    const family = familyKeyOf(r.product);
    const key = printed ? `p:${printed.toLowerCase().replace(/\s+/g, " ")}` : `f:${family}`;
    const row: Building =
      rows.get(key) ?? { key, label: printed ?? familyOf(r.product), familyKey: family, cells: {}, families: new Map(), firstFamily: family };
    row.cells[column.key] = {
      productId: r.productId,
      printedPaise: r.offered ? (meta.taxBasis === "inclusive" ? r.rateInclGstPaise : r.rateExGstPaise) : null,
      offered: r.offered,
    };
    row.families.set(family, (row.families.get(family) ?? 0) + 1);
    rows.set(key, row);
  }
  return {
    ...meta,
    columns: sortColumns([...columns.values()]),
    rows: [...rows.values()]
      .map(({ families, firstFamily, ...row }) => ({
        ...row,
        familyKey: [...families.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? firstFamily,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

/* -------------------------------------------------------------- to rates */

export type RateOut = {
  productId: string;
  rateExGstPaise: number;
  rateInclGstPaise: number;
  offered: boolean;
  rawProductText: string;
  rawPackText: string;
  rawPriceText: string;
};

/**
 * The paper back into rates, at the list's own GST. A cell with no SKU or no
 * price is not a rate — the review says so rather than storing a zero.
 */
export function sheetRates(sheet: PriceSheet): RateOut[] {
  const out: RateOut[] = [];
  const seen = new Set<string>();
  for (const row of sheet.rows) {
    for (const column of sheet.columns) {
      const cell = row.cells[column.key];
      if (!cell?.productId || seen.has(cell.productId)) continue;
      if (cell.offered && cell.printedPaise == null) continue;
      seen.add(cell.productId);
      const printed = cell.offered ? cell.printedPaise : null;
      const ex = printed == null ? 0 : sheet.taxBasis === "inclusive" ? exFromIncl(printed, sheet.gstBp) : printed;
      const incl = printed == null ? 0 : sheet.taxBasis === "inclusive" ? printed : inclFromEx(printed, sheet.gstBp);
      out.push({
        productId: cell.productId,
        rateExGstPaise: ex,
        rateInclGstPaise: incl,
        offered: cell.offered && printed != null,
        rawProductText: row.label,
        rawPackText: `${column.sizeLabel} ${column.packLabel}`,
        rawPriceText: printedPrice(cell),
      });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- checks */

export type SheetCheck = {
  level: "block" | "warn" | "info";
  code: string;
  message: string;
  /** `${rowKey}::${columnKey}` where one cell is at fault. */
  cells?: string[];
};

/**
 * What the review page says before anything is saved. A BLOCK stops a
 * publish (never a draft — a draft is a place to leave unfinished work); a
 * WARN is read and may be accepted; INFO is a fact worth seeing.
 */
export function checkSheet(
  sheet: PriceSheet,
  opts: { todayIso: string; baseline?: Map<string, number> | null; outlierBp?: number },
): SheetCheck[] {
  const checks: SheetCheck[] = [];
  const rates = sheetRates(sheet);

  if (!sheet.name.trim()) checks.push({ level: "block", code: "name", message: "The list has no name." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sheet.effectiveFrom)) {
    checks.push({ level: "block", code: "date", message: "The effective date is not a date." });
  }
  if (!rates.length) checks.push({ level: "block", code: "empty", message: "No cell has a price yet. A list with no prices is not a list." });
  if (!sheet.refNo?.trim()) checks.push({ level: "warn", code: "ref", message: "No reference number. Every list the office sends carries one." });
  if (!sheet.deliveryBasis) checks.push({ level: "warn", code: "delivery", message: "The header does not say where prices are delivered to." });
  if (sheet.freightTerm === "not_stated") checks.push({ level: "warn", code: "freight", message: "It does not say who pays the transport." });
  if (!sheet.signatory?.trim()) checks.push({ level: "warn", code: "sign", message: "Nobody signs it." });
  if (sheet.effectiveFrom < opts.todayIso) {
    checks.push({ level: "info", code: "past", message: `It takes effect from a date already past (${printedDate(sheet.effectiveFrom)}).` });
  }

  const unpriced: string[] = [];
  const zero: string[] = [];
  const noSku: string[] = [];
  const outliers: string[] = [];
  for (const row of sheet.rows) {
    let rowPriced = 0;
    for (const column of sheet.columns) {
      const cell = row.cells[column.key];
      const at = `${row.key}::${column.key}`;
      if (!cell) continue;
      if (cell.printedPaise != null && cell.offered && !cell.productId) noSku.push(at);
      if (cell.productId && cell.offered && cell.printedPaise == null) unpriced.push(at);
      if (cell.productId && cell.offered && cell.printedPaise === 0) zero.push(at);
      if (cell.productId && cell.offered && cell.printedPaise) {
        rowPriced++;
        const before = opts.baseline?.get(cell.productId);
        if (before && opts.outlierBp) {
          const moved = Math.abs(cell.printedPaise - before) / before;
          if (moved * 10_000 > opts.outlierBp) outliers.push(at);
        }
      }
    }
    if (!rowPriced && Object.values(row.cells).some((c) => c.productId)) {
      checks.push({ level: "warn", code: "row-empty", message: `${row.label} is on the paper with no price in any pack.` });
    }
  }
  if (unpriced.length) {
    checks.push({
      level: "warn",
      code: "unpriced",
      message: `${unpriced.length} cell${unpriced.length === 1 ? " is" : "s are"} empty. They print as a dash and are left off the list — mark them "not sold" to say so deliberately.`,
      cells: unpriced,
    });
  }
  if (zero.length) checks.push({ level: "block", code: "zero", message: `${zero.length} cell${zero.length === 1 ? " is" : "s are"} priced at zero.`, cells: zero });
  if (noSku.length) {
    checks.push({
      level: "warn",
      code: "nosku",
      message: `${noSku.length} price${noSku.length === 1 ? " is" : "s are"} in a pack the catalogue does not sell for that product, so ${noSku.length === 1 ? "it" : "they"} cannot become a rate.`,
      cells: noSku,
    });
  }
  if (outliers.length) {
    checks.push({
      level: "warn",
      code: "outlier",
      message: `${outliers.length} price${outliers.length === 1 ? " moved" : "s moved"} more than ${(opts.outlierBp ?? 0) / 100}% from the list this starts from. Worth a second look for a typed zero or a missing digit.`,
      cells: outliers,
    });
  }
  // A big pack cheaper per litre than a small one is ordinary; a small pack
  // cheaper per litre than its big sibling in the same row almost always is
  // a typo. Said per row, never refused.
  for (const row of sheet.rows) {
    const cells = sheet.columns
      .map((c) => ({ c, cell: row.cells[c.key] }))
      .filter((x) => x.c.millilitres && x.cell?.offered && x.cell.printedPaise && x.c.container === "can");
    for (let i = 1; i < cells.length; i++) {
      const big = cells[i];
      // The nearest genuinely SMALLER pack. Two boxings of one size (500 ml by
      // fifty and by twenty-five) are one size, and comparing them per litre
      // produced "the 500 ml costs more per litre than the 500 ml".
      const small = [...cells.slice(0, i)].reverse().find((x) => x.c.millilitres! < big.c.millilitres!);
      if (!small) continue;
      const smallPl = small.cell!.printedPaise! / small.c.millilitres!;
      const bigPl = big.cell!.printedPaise! / big.c.millilitres!;
      if (bigPl > smallPl * 1.15) {
        checks.push({
          level: "warn",
          code: "per-litre",
          message: `${row.label}: the ${big.c.sizeLabel} costs more per litre than the ${small.c.sizeLabel}.`,
          cells: [`${row.key}::${big.c.key}`],
        });
        break;
      }
    }
  }
  return checks;
}

/* ------------------------------------------------------------------- CSV */

export const CSV_HEADERS = [
  "List",
  "Ref",
  "Effective from",
  "Product ID",
  "Product",
  "Printed name",
  "Size",
  "Pack",
  "Rate incl GST (Rs)",
  "Rate ex GST (Rs)",
  "Offered",
] as const;

const rupees = (paise: number) => (paise / 100).toFixed(2).replace(/\.00$/, "");

/** One row per priced cell. Re-importable: `csvToCells` reads this file back. */
export function sheetCsvRows(sheet: PriceSheet, products: Map<string, SheetProduct>): Array<Array<string | number | null>> {
  const out: Array<Array<string | number | null>> = [];
  for (const row of sheet.rows) {
    for (const column of sheet.columns) {
      const cell = row.cells[column.key];
      if (!cell?.productId) continue;
      const priced = cell.offered && cell.printedPaise != null;
      const incl = !priced ? null : sheet.taxBasis === "inclusive" ? cell.printedPaise! : inclFromEx(cell.printedPaise!, sheet.gstBp);
      const ex = !priced ? null : sheet.taxBasis === "inclusive" ? exFromIncl(cell.printedPaise!, sheet.gstBp) : cell.printedPaise!;
      out.push([
        sheet.name,
        sheet.refNo ?? "",
        sheet.effectiveFrom,
        cell.productId,
        products.get(cell.productId)?.name ?? "",
        row.label,
        column.sizeLabel,
        column.packLabel,
        incl == null ? "" : rupees(incl),
        ex == null ? "" : rupees(ex),
        cell.offered ? "yes" : "no",
      ]);
    }
  }
  return out;
}

export type CsvImport = {
  cells: Array<{ productId: string; printedPaise: number | null; offered: boolean; printedName: string | null }>;
  unmatched: Array<{ line: number; product: string; reason: string }>;
  read: number;
};

/**
 * A spreadsheet into cells. The file the export writes reads back exactly;
 * a sheet somebody typed needs only a product (id or name) and one price
 * column. Names are matched on the catalogue's own normalised key, and a name
 * that matches nothing is REPORTED, never guessed at — a guessed SKU is a
 * price on the wrong can.
 */
export function csvToCells(
  rows: Array<Record<string, string>>,
  products: SheetProduct[],
  taxBasis: "inclusive" | "exclusive",
  gstBp: number,
): CsvImport {
  const byId = new Map(products.map((p) => [p.id, p]));
  const byKey = new Map(products.map((p) => [matchKey(p.name), p]));
  const pick = (r: Record<string, string>, ...names: string[]) => {
    for (const n of names) {
      const hit = Object.keys(r).find((k) => k.trim().toLowerCase() === n.toLowerCase());
      if (hit && r[hit]?.trim()) return r[hit].trim();
    }
    return "";
  };
  const cells: CsvImport["cells"] = [];
  const unmatched: CsvImport["unmatched"] = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    const idText = pick(r, "Product ID", "product_id", "id", "sku");
    const nameText = pick(r, "Product", "SKU name", "name", "product name");
    const product = (idText && byId.get(idText)) || (nameText && byKey.get(matchKey(nameText))) || null;
    if (!product) {
      if (idText || nameText) unmatched.push({ line, product: nameText || idText, reason: "No product in the catalogue has this id or name." });
      return;
    }
    const inclText = pick(r, "Rate incl GST (Rs)", "Rate incl GST", "incl", "mrp incl gst", "price incl gst");
    const exText = pick(r, "Rate ex GST (Rs)", "Rate ex GST", "ex", "price ex gst", "rate");
    const offeredText = pick(r, "Offered").toLowerCase();
    const incl = inclText ? parseTypedRupees(inclText) : null;
    const ex = exText ? parseTypedRupees(exText) : null;
    const notOffered = offeredText === "no" || offeredText === "n" || offeredText === "false" || inclText === "—" || inclText === "-";
    let printed: number | null = null;
    if (taxBasis === "inclusive") printed = incl ?? (ex != null ? inclFromEx(ex, gstBp) : null);
    else printed = ex ?? (incl != null ? exFromIncl(incl, gstBp) : null);
    if (printed == null && !notOffered) {
      unmatched.push({ line, product: product.name, reason: "No price in either rate column." });
      return;
    }
    cells.push({ productId: product.id, printedPaise: notOffered ? null : printed, offered: !notOffered, printedName: pick(r, "Printed name") || null });
  });
  return { cells, unmatched, read: rows.length };
}

/* -------------------------------------------------------------- read back */

export type ReadBackCell = {
  rowLabel: string;
  sizeLabel: string;
  packLabel: string;
  typed: string;
  read: string | null;
  samePrice: boolean;
  expectedProductId: string | null;
  readProductId: string | null;
  sameProduct: boolean;
};

export type ReadBack = {
  cells: ReadBackCell[];
  priceMismatches: number;
  productMismatches: number;
  missing: number;
  headerMismatches: string[];
  ok: boolean;
};

/**
 * What the paper says against what was typed.
 *
 * The parser's output is taken as structure — rows in order, columns in
 * order — and compared position by position with the sheet it was printed
 * from. A price that reads back differently is a rendering fault; a cell the
 * MATCHER would put on a different SKU is not a fault in this list (the list
 * stores the SKU it was built with) but it is exactly what would go wrong if
 * this paper were imported somewhere else, so it is reported beside it.
 */
export function compareReadBack(
  sheet: PriceSheet,
  parsed: {
    header: { refNo: string | null; effectiveFrom: string | null; gstBp: number | null; taxBasis: string | null; deliveryBasis: string | null; freightTerm: string | null };
    columns: Array<{ millilitres: number | null; cansPerBox: number | null; container: string | null }>;
    rows: Array<{ rowIndex: number; rawProduct: string; cells: Array<{ colIndex: number; raw: string; inclPaise: number | null; offered: boolean }> }>;
  },
  matches: Map<string, { productId: string | null }>,
): ReadBack {
  const cells: ReadBackCell[] = [];
  let priceMismatches = 0;
  let productMismatches = 0;
  let missing = 0;

  sheet.rows.forEach((row, r) => {
    const readRow = parsed.rows[r];
    sheet.columns.forEach((column, c) => {
      const cell = row.cells[column.key];
      const typed = printedPrice(cell);
      const readCell = readRow?.cells.find((x) => x.colIndex === c);
      const read = readCell ? (readCell.offered ? readCell.raw : "—") : null;
      const samePrice = read != null && (read === typed || (read === "—" && typed === "—"));
      const readProductId = matches.get(`${readRow?.rowIndex ?? -1}:${c}`)?.productId ?? null;
      const expected = cell?.offered && cell.printedPaise != null ? (cell.productId ?? null) : null;
      const sameProduct = !expected || readProductId === expected;
      if (read == null) missing++;
      else if (!samePrice) priceMismatches++;
      if (!sameProduct) productMismatches++;
      cells.push({
        rowLabel: row.label,
        sizeLabel: column.sizeLabel,
        packLabel: column.packLabel,
        typed,
        read,
        samePrice,
        expectedProductId: expected,
        readProductId,
        sameProduct,
      });
    });
  });

  const headerMismatches: string[] = [];
  const h = parsed.header;
  if ((sheet.refNo ?? null) && h.refNo !== sheet.refNo) headerMismatches.push(`Reference reads back as "${h.refNo ?? "nothing"}".`);
  if (h.effectiveFrom !== sheet.effectiveFrom) headerMismatches.push(`Effective date reads back as ${h.effectiveFrom ?? "nothing"}.`);
  if (h.gstBp !== sheet.gstBp) headerMismatches.push(`GST reads back as ${h.gstBp == null ? "nothing" : `${h.gstBp / 100}%`}.`);
  if ((h.taxBasis ?? "inclusive") !== sheet.taxBasis) headerMismatches.push(`Tax basis reads back as ${h.taxBasis ?? "nothing"}.`);
  if (sheet.deliveryBasis && h.deliveryBasis !== sheet.deliveryBasis) headerMismatches.push(`Delivery basis reads back as ${h.deliveryBasis ?? "nothing"}.`);
  if (sheet.freightTerm !== "not_stated" && h.freightTerm !== sheet.freightTerm) headerMismatches.push(`Freight term reads back as ${h.freightTerm ?? "nothing"}.`);
  if (parsed.columns.length !== sheet.columns.length) {
    headerMismatches.push(`${parsed.columns.length} pack columns read back; the sheet has ${sheet.columns.length}.`);
  }
  if (parsed.rows.length !== sheet.rows.length) {
    headerMismatches.push(`${parsed.rows.length} product rows read back; the sheet has ${sheet.rows.length}.`);
  }

  return {
    cells,
    priceMismatches,
    productMismatches,
    missing,
    headerMismatches,
    ok: priceMismatches === 0 && missing === 0 && headerMismatches.length === 0,
  };
}

/* ------------------------------------------------------------ duplicating */

/** "Odisha To Pay — August 2026" → "Odisha To Pay — August 2026 (copy)", then (copy 2). */
export function copyName(name: string, taken: string[]): string {
  const base = name.replace(/\s*\(copy(?: \d+)?\)$/i, "");
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(`${base} (copy)`.toLowerCase())) return `${base} (copy)`;
  for (let i = 2; i < 100; i++) {
    const n = `${base} (copy ${i})`;
    if (!used.has(n.toLowerCase())) return n;
  }
  return `${base} (copy)`;
}
