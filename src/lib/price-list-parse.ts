/* ---------------------------------------------------------------------------
 * A PRICE LIST'S TEXT → TYPED CELLS, with no I/O in it.
 *
 * Mahek's lists are one page: a header naming the reference, the effective
 * date, the tax basis and who pays the transport; a grid of products down and
 * pack sizes across with a GST-inclusive price per can in every cell; a
 * numbered terms block that sometimes states a discount. This file turns the
 * text a reader extracted into that structure and nothing else — it never
 * touches a file, a model or the database, which is what lets the four real
 * lists in `fixtures/price-lists/` pin it without any of those.
 *
 * TWO LAYOUTS. The grid above is every sample; the "long" layout — one SKU
 * per line with its price beside it — exists because a list typed in a hurry
 * comes out that way, and refusing it would send the file to a model to read
 * what a regular expression can.
 *
 * WHAT IT DOES NOT DECIDE. Which SKU a row and a column name is the matcher's
 * question (`price-list-match.ts`), and whether the result may be published is
 * a person's. The parser reports confidence and warnings so those two can ask
 * for a person sooner rather than later.
 * ------------------------------------------------------------------------- */

import type {
  PriceDeliveryBasis,
  PriceDiscountKind,
  PriceFilenameHints,
  PriceFreightTerm,
  PriceParsedHeader,
} from "@/db/schema";
import { canonicalState, isKnownState } from "@/lib/india-states";

export type ParsedColumn = {
  colIndex: number;
  /** "1 Litre 32/bx", as the two header strips read together. */
  label: string;
  raw: string;
  millilitres: number | null;
  cansPerBox: number | null;
  container: "can" | "tin" | "drum" | "loose" | null;
};

export type ParsedCell = {
  colIndex: number;
  raw: string;
  /** GST-inclusive as printed, in paise. Null on a dash. */
  inclPaise: number | null;
  /** False on a dash: listed, and not for sale on this list. */
  offered: boolean;
};

export type ParsedRow = { rowIndex: number; rawProduct: string; cells: ParsedCell[] };

export type ParsedDiscountTerm = {
  kind: PriceDiscountKind;
  percentBp: number;
  thresholdLitres: number | null;
  thresholdPaise: number | null;
  rawText: string;
};

export type ParsedPriceList = {
  layout: "grid" | "long" | "unknown";
  header: PriceParsedHeader;
  columns: ParsedColumn[];
  rows: ParsedRow[];
  discountTerms: ParsedDiscountTerm[];
  termsText: string | null;
  warnings: string[];
  /** 0 to 100. What a person should expect to have to correct. */
  confidence: number;
};

/* --------------------------------------------------------------- money */

const DASHES = new Set(["—", "–", "-", "--", "NA", "N/A", "n/a", "na", "x", "X"]);

/**
 * "Rs.1,168" → 116800. "Rs 1150" and "₹1,168.50" too. A dash is null — it is
 * an answer, not a failure — and anything else is null as well, which the
 * caller tells apart by asking `isPriceToken` first.
 */
export function parseRupees(raw: string): number | null {
  const t = raw.trim();
  if (!t || DASHES.has(t)) return null;
  const m = t.match(/^(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:\/-)?$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function isPriceToken(raw: string): boolean {
  const t = raw.trim();
  return DASHES.has(t) || /^(?:Rs\.?|INR|₹)?\s*[\d,]+(?:\.\d{1,2})?\s*(?:\/-)?$/i.test(t);
}

/* --------------------------------------------------------------- packs */

function millilitresOf(sizeLabel: string): number | null {
  const m = sizeLabel.match(/(\d+(?:\.\d+)?)\s*(ml|ML|Ml|mL|l|L|ltr|Ltr|LTR|litre|Litre|liter|Liter|Litres|Liters)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return unit === "ml" ? Math.round(n) : Math.round(n * 1000);
}

/**
 * "1 Litre" + "32/bx" → 1000 ml, 32 a box. "20L Tin Can" + "01 Can" → a tin
 * of 20 L sold singly. The size strip and the pack strip are two lines of the
 * same header and only mean something read together.
 */
export function parsePackColumn(sizeLabel: string, packLabel: string): Omit<ParsedColumn, "colIndex"> {
  const millilitres = millilitresOf(sizeLabel);
  const size = sizeLabel.toLowerCase();
  const pack = packLabel.toLowerCase();
  let container: ParsedColumn["container"] = null;
  if (/tin/.test(size) || /tin/.test(pack)) container = "tin";
  else if (/drum/.test(size) || /drum/.test(pack)) container = "drum";
  else if (/loose/.test(pack)) container = "loose";

  let cansPerBox: number | null = null;
  const box = pack.match(/(\d+)\s*\/\s*(?:bx|box|ctn|case)/);
  if (box) cansPerBox = Number(box[1]);
  else {
    const can = pack.match(/(\d+)\s*(?:can|cans|pc|pcs|nos?)\b/);
    if (can) cansPerBox = Number(can[1]);
    else if (container === "loose" || container === "drum") cansPerBox = 1;
  }
  if (container === null && cansPerBox != null) container = "can";

  return {
    label: `${sizeLabel.trim()} ${packLabel.trim()}`.trim(),
    raw: `${sizeLabel} | ${packLabel}`,
    millilitres,
    cansPerBox,
    container,
  };
}

/* -------------------------------------------------------------- header */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** "01 August 2026" or "1st Aug 2026" or "01/08/2026" → "2026-08-01". */
export function parseLongDate(raw: string): string | null {
  const t = raw.trim();
  let m = t.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()] != null) {
    return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = t.match(/([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()] != null) {
    return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  m = t.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  return null;
}

function deliveryBasisOf(text: string): PriceDeliveryBasis | null {
  const t = text.toLowerCase();
  if (/\bfor\s+mumbai\b/.test(t)) return "for_mumbai";
  if (/\bfor\s+(?:transporter'?s?\s+)?godown\b/.test(t)) return "for_godown";
  if (/\bdoor\s+delivery\b/.test(t)) return "door_delivery";
  if (/\bex[\s-]?(?:factory|works)\b/.test(t)) return "ex_factory";
  return null;
}

function freightTermOf(text: string, basis: PriceDeliveryBasis | null): PriceFreightTerm | null {
  const t = text.toLowerCase();
  if (/transport(?:ation)?\s+(?:extra|to\s+pay|payable)/.test(t) || /\bto\s+pay\b/.test(t)) return "to_pay";
  if (/transport(?:ation)?\s+(?:paid|included|inclusive|free)/.test(t) || /freight\s+paid/.test(t)) return "paid";
  if (basis === "for_godown" || basis === "door_delivery") return "paid";
  if (basis === "for_mumbai" || basis === "ex_factory") return "to_pay";
  return null;
}

function parseHeader(lines: string[]): { header: PriceParsedHeader; supersedesFrom: string | null } {
  const all = lines.join("\n");
  const refNo = all.match(/Ref\.?\s*(?:No\.?)?\s*[:.]?\s*([A-Z]{0,4}[\s-]?\d[\w\-\/]*)/i)?.[1]?.trim() ?? null;
  const effectiveRaw = all.match(/Effective(?:\s+from)?\s*[:.]?\s*([^|\n]+)/i)?.[1] ?? null;
  const effectiveFrom = effectiveRaw ? parseLongDate(effectiveRaw) : null;
  const gst = all.match(/GST\s*@?\s*(\d+(?:\.\d+)?)\s*%\s*(Inclusive|Incl\.?|Extra|Exclusive|Excl\.?)?/i);
  const gstBp = gst ? Math.round(Number(gst[1]) * 100) : null;
  const taxBasis: PriceParsedHeader["taxBasis"] = gst
    ? /^(extra|excl)/i.test(gst[2] ?? "") || /GST\s+extra|plus\s+GST|\+\s*GST/i.test(all)
      ? "exclusive"
      : "inclusive"
    : /GST\s+extra|plus\s+GST|\+\s*GST/i.test(all)
      ? "exclusive"
      : null;
  const headerLine = lines.find((l) => /Effective/i.test(l)) ?? all;
  const deliveryBasis = deliveryBasisOf(headerLine) ?? deliveryBasisOf(all);
  const freightTerm = freightTermOf(headerLine, deliveryBasis) ?? freightTermOf(all, deliveryBasis);
  const validityDays = all.match(/valid\s+for\s+(\d+)\s+days/i) ? Number(all.match(/valid\s+for\s+(\d+)\s+days/i)![1]) : null;

  let signatory: string | null = null;
  const forIdx = lines.findIndex((l) => /^For\s+Mahek/i.test(l.trim()));
  if (forIdx >= 0) {
    for (let i = forIdx + 1; i < Math.min(lines.length, forIdx + 4); i++) {
      const cand = lines[i].trim();
      if (!cand || /^www\.|@|^Account|^Tel|^\d/i.test(cand)) continue;
      signatory = cand;
      break;
    }
  }
  const supersedes = all.match(/supersedes[^\n]*?effect\s+from\s+([^\n.]+)/i)?.[1] ?? null;
  return {
    header: { refNo, effectiveFrom, taxBasis, gstBp, deliveryBasis, freightTerm, validityDays, signatory },
    supersedesFrom: supersedes ? parseLongDate(supersedes) : null,
  };
}

/* ---------------------------------------------------------------- terms */

function parseDiscountTerms(termsLines: string[]): ParsedDiscountTerm[] {
  const out: ParsedDiscountTerm[] = [];
  for (const raw of termsLines) {
    const line = raw.replace(/^\s*\d+\.\s*/, "").trim();
    if (!/\d+(?:\.\d+)?\s*%/.test(line) || /\bGST\b/i.test(line)) continue;
    const pct = Number(line.match(/(\d+(?:\.\d+)?)\s*%/)![1]);
    const percentBp = Math.round(pct * 100);
    const lower = line.toLowerCase();
    const litres = lower.match(/(\d[\d,]*)\s*(?:liters|litres|ltrs?|l)\b/);
    const rupees = lower.match(/(?:rs\.?|₹|inr)\s*([\d,]+)/);
    let kind: PriceDiscountKind = "other";
    if (/advance/.test(lower)) kind = "advance_payment";
    else if (/prompt|within\s+\d+\s+days/.test(lower)) kind = "prompt_payment";
    else if (/quantity|volume|litre|liter|and above|orders of/.test(lower)) kind = "quantity";
    else if (!/discount|off\b/.test(lower)) continue;
    out.push({
      kind,
      percentBp,
      thresholdLitres: litres ? Number(litres[1].replace(/,/g, "")) : null,
      thresholdPaise: rupees ? Number(rupees[1].replace(/,/g, "")) * 100 : null,
      rawText: line,
    });
  }
  return out;
}

/* ----------------------------------------------------------------- grid */

const SIZE_TOKEN = /(\d+(?:\.\d+)?\s*(?:ml|ML|Ml|l|L|ltr|Ltr|litres?|Litres?|liters?|Liters?)\b(?:\s*(?:Tin\s*Can|Tin|Drum|Loose|Can))?)/g;
const PACK_TOKEN = /(\d+\s*\/\s*(?:bx|box|ctn|case)|\d+\s*(?:Can|Cans|Pcs?|Nos?)\b|Loose|Drum)/gi;

function parseColumns(sizeLine: string, packLine: string | null): ParsedColumn[] {
  const sizes = [...sizeLine.replace(/^\s*Product\s*/i, "").matchAll(SIZE_TOKEN)].map((m) => m[1].trim());
  const packs = packLine ? [...packLine.replace(/^\s*Pack\s*Size\s*/i, "").matchAll(PACK_TOKEN)].map((m) => m[1].trim()) : [];
  return sizes.map((size, i) => ({ colIndex: i, ...parsePackColumn(size, packs[i] ?? "") }));
}

function parseGridRow(line: string, columnCount: number, rowIndex: number): ParsedRow | null {
  const tokens = line.trim().split(/\s+/);
  // Prices are read from the RIGHT: a product name has spaces and dots in it
  // and a price never does, so the boundary is where the price tokens stop.
  let n = 0;
  while (n < tokens.length && isPriceToken(tokens[tokens.length - 1 - n])) n++;
  if (n < columnCount) {
    // "Rs. 1,168" split across two tokens: rejoin "Rs." with the number after it.
    const rejoined: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (/^(?:Rs\.?|INR|₹)$/i.test(tokens[i]) && i + 1 < tokens.length) {
        rejoined.push(`${tokens[i]}${tokens[i + 1]}`);
        i++;
      } else rejoined.push(tokens[i]);
    }
    if (rejoined.length !== tokens.length) return parseGridRow(rejoined.join(" "), columnCount, rowIndex);
    return null;
  }
  const priceTokens = tokens.slice(tokens.length - columnCount);
  const rawProduct = tokens.slice(0, tokens.length - columnCount).join(" ").trim();
  if (!rawProduct || /^(product|pack\s*size)$/i.test(rawProduct)) return null;
  return {
    rowIndex,
    rawProduct,
    cells: priceTokens.map((raw, colIndex) => ({
      colIndex,
      raw,
      inclPaise: parseRupees(raw),
      offered: !DASHES.has(raw.trim()),
    })),
  };
}

/* ----------------------------------------------------------------- long */

const LONG_ROW = /^(.+?\s[-–]\s*\d+(?:\.\d+)?\s*(?:ml|ML|l|L|ltr|Ltr|litres?|Litres?|liters?|Liters?)\b[^:]*?)\s+((?:Rs\.?|INR|₹)?\s*[\d,]+(?:\.\d{1,2})?|—|-)\s*$/;

function parseLongRows(lines: string[]): { rows: ParsedRow[]; columns: ParsedColumn[] } {
  const columns: ParsedColumn[] = [];
  const rows: ParsedRow[] = [];
  const keyOf = (c: Omit<ParsedColumn, "colIndex">) => `${c.millilitres}|${c.cansPerBox}|${c.container}`;
  for (const line of lines) {
    const m = line.trim().match(LONG_ROW);
    if (!m) continue;
    const name = m[1].trim();
    const size = name.match(/\d+(?:\.\d+)?\s*(?:ml|ML|l|L|ltr|Ltr|litres?|Litres?|liters?|Liters?)\b/)?.[0] ?? "";
    const pack = name.match(/\(([^)]*)\)/)?.[1] ?? "";
    const col = parsePackColumn(size, pack);
    let colIndex = columns.findIndex((c) => keyOf(c) === keyOf(col));
    if (colIndex < 0) {
      colIndex = columns.length;
      columns.push({ colIndex, ...col });
    }
    rows.push({
      rowIndex: rows.length,
      rawProduct: name,
      cells: [{ colIndex, raw: m[2].trim(), inclPaise: parseRupees(m[2]), offered: !DASHES.has(m[2].trim()) }],
    });
  }
  return { rows, columns };
}

/* ---------------------------------------------------------------- whole */

/**
 * The whole document, page texts in. Pages are read as one stream: a grid
 * that continues over a page break is one grid.
 */
export function parsePriceListText(pages: string[]): ParsedPriceList {
  const lines = pages
    .join("\n")
    .split(/\r?\n/)
    .map((l) => l.replace(/ /g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);

  const warnings: string[] = [];
  const { header, supersedesFrom } = parseHeader(lines);

  const termsIdx = lines.findIndex((l) => /^terms\s*(?:&|and)\s*conditions/i.test(l));
  const termsEnd = lines.findIndex((l, i) => i > termsIdx && /^(we strive|for\s+mahek|thank(?:ing)? you)/i.test(l));
  const termsLines = termsIdx >= 0 ? lines.slice(termsIdx + 1, termsEnd > termsIdx ? termsEnd : undefined) : [];
  const termsText = termsLines.length ? termsLines.join("\n") : null;
  const discountTerms = parseDiscountTerms(termsLines);

  const sizeIdx = lines.findIndex((l) => /^product\b/i.test(l) && [...l.matchAll(SIZE_TOKEN)].length >= 2);
  let layout: ParsedPriceList["layout"] = "unknown";
  let columns: ParsedColumn[] = [];
  let rows: ParsedRow[] = [];
  let skipped = 0;

  if (sizeIdx >= 0) {
    layout = "grid";
    const packLine = /^pack\s*size/i.test(lines[sizeIdx + 1] ?? "") ? lines[sizeIdx + 1] : null;
    columns = parseColumns(lines[sizeIdx], packLine);
    const bodyStart = sizeIdx + (packLine ? 2 : 1);
    const bodyEnd = termsIdx > bodyStart ? termsIdx : lines.length;
    for (let i = bodyStart; i < bodyEnd; i++) {
      const row = parseGridRow(lines[i], columns.length, rows.length);
      if (row) rows.push(row);
      else if (/(?:Rs\.?|₹)\s*[\d,]+/.test(lines[i]) || /—/.test(lines[i])) {
        skipped++;
        warnings.push(`Could not read the row "${lines[i].slice(0, 60)}" as a product with ${columns.length} prices.`);
      }
    }
    if (!packLine) warnings.push("No pack-size strip under the size columns; cans per box are unknown.");
  } else {
    const long = parseLongRows(lines);
    if (long.rows.length) {
      layout = "long";
      rows = long.rows;
      columns = long.columns;
    }
  }

  if (!header.refNo) warnings.push("No reference number found in the header.");
  if (!header.effectiveFrom) warnings.push("No effective date found in the header.");
  if (header.gstBp == null) warnings.push("The header does not say whether prices include GST, or at what rate.");
  if (!header.deliveryBasis) warnings.push("The header does not say where prices are delivered to (FOR Mumbai, FOR godown).");
  if (supersedesFrom && header.effectiveFrom && supersedesFrom !== header.effectiveFrom) {
    warnings.push(
      `The terms say this list supersedes earlier ones from ${supersedesFrom}, which is not the effective date ${header.effectiveFrom}. Probably a sentence carried over from an earlier month.`,
    );
  }
  if (columns.some((c) => c.millilitres == null)) warnings.push("A pack column has no readable size.");
  if (layout === "grid" && columns.some((c) => c.cansPerBox == null)) warnings.push("A pack column has no readable cans-per-box.");
  if (!rows.length) warnings.push("No product rows were read.");

  let confidence = 100;
  if (!header.refNo) confidence -= 10;
  if (!header.effectiveFrom) confidence -= 15;
  if (header.gstBp == null) confidence -= 10;
  if (!header.deliveryBasis || !header.freightTerm) confidence -= 10;
  if (!columns.length) confidence -= 20;
  if (!rows.length) confidence -= 30;
  confidence -= Math.min(25, skipped * 5);
  confidence -= Math.min(10, columns.filter((c) => c.millilitres == null || c.cansPerBox == null).length * 5);
  confidence = Math.max(0, Math.min(100, confidence));

  return {
    layout,
    header: { ...header, discountTerms, termsText },
    columns,
    rows,
    discountTerms,
    termsText,
    warnings,
    confidence,
  };
}

/* ------------------------------------------------------------ filename */

const NOISE = new Set(["mahek", "marketing", "india", "price", "list", "pricelist", "pl", "final", "copy", "new", "revised"]);
const REGION_WORDS = ["mp & cg", "mp&cg", "pan india", "pan maharashtra", "western line", "south zone", "north zone", "east zone", "west zone", "wholesale", "wholesales", "colour camp", "color camp"];

/**
 * What the filename says before the file is opened. Mahek names its lists
 * "…_Odisha_To Pay_August2026.pdf", so the region, the freight term and the
 * month are usually right there — and they are PROPOSALS a reviewer confirms,
 * because a file renamed by somebody's phone is a file named wrongly.
 */
export function filenameHints(filename: string): PriceFilenameHints {
  const base = filename.replace(/\.[A-Za-z0-9]+$/, "").replace(/\s*\(\d+\)\s*$/, "").replace(/\s+\d+$/, "");
  const parts = base
    .split(/[_]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const tokens: string[] = [];
  let region: string | null = null;
  let freightTerm: PriceFreightTerm | null = null;
  let monthIso: string | null = null;
  let customer: string | null = null;

  for (const part of parts) {
    const lower = part.toLowerCase();
    const month = part.match(/^([A-Za-z]{3,9})[\s-]?(\d{4})$/) ?? part.match(/^(\d{4})[\s-]?([A-Za-z]{3,9})$/);
    if (month) {
      const name = /^\d/.test(month[1]) ? month[2] : month[1];
      const year = /^\d/.test(month[1]) ? month[1] : month[2];
      if (MONTHS[name.toLowerCase()] != null) {
        monthIso = `${year}-${String(MONTHS[name.toLowerCase()]).padStart(2, "0")}`;
        continue;
      }
    }
    if (lower === "paid" || lower === "freight paid") {
      freightTerm = "paid";
      continue;
    }
    if (lower === "to pay" || lower === "topay" || lower === "to-pay") {
      freightTerm = "to_pay";
      continue;
    }
    const words = part.split(/\s+/).filter((w) => !NOISE.has(w.toLowerCase()));
    if (!words.length) continue;
    const cleaned = words.join(" ");
    tokens.push(cleaned);
    if (region == null && (isKnownState(cleaned) || REGION_WORDS.includes(cleaned.toLowerCase()))) {
      region = isKnownState(cleaned) ? canonicalState(cleaned) : cleaned;
      continue;
    }
    if (region == null && cleaned.split(" ").some((w) => isKnownState(w))) {
      region = canonicalState(cleaned.split(" ").find((w) => isKnownState(w)));
      continue;
    }
    if (customer == null && /distributor|enterprise|trader|paints?|hardware|marketing|agenc|corp|store|pvt|ltd|& sons|sales/i.test(cleaned)) {
      customer = cleaned;
      continue;
    }
    if (customer == null && region == null && /^[A-Z][A-Za-z.&' ]+$/.test(cleaned) && cleaned.length <= 40) {
      customer = cleaned;
    }
  }
  return { region, freightTerm, monthIso, customer, tokens };
}
