/* ---------------------------------------------------------------------------
 * WHICH SKU A ROW AND A COLUMN NAME, with no I/O in it.
 *
 * A list prints "Maruti Nano Thinner" down the side and "20 Litre 02/bx"
 * across the top; the catalogue holds "Nano Thinner - 20 Liter (2 Can/Box)".
 * Matching is two questions asked in order: which SKUs have this can size and
 * this packing (an exact, structural filter — a 32-a-box tin cannot be a
 * 24-a-box tin however the name reads), and of those, whose brand words read
 * most like the row's (a score). The score decides between "matched",
 * "suggested" and "held"; it never overrides the structure, because a wrong
 * pack size is a wrong price on every can of a month's orders.
 *
 * NAMES ARE LEARNED, NOT HARD-CODED. `product_aliases` already exists so an
 * old spelling keeps resolving; a reviewer who picks a SKU for a held cell
 * can ask for the row's spelling to be remembered, and the next list in the
 * same hand matches on its own. The handful of rewrites below cover the
 * abbreviations Mahek's own lists use — "P.U.", "N.C.", "S.D." — which are
 * punctuation, not knowledge.
 * ------------------------------------------------------------------------- */

import type { PriceMatchStatus } from "@/db/schema";
import { matchKey } from "@/lib/catalogue";
import type { ParsedColumn, ParsedPriceList } from "./price-list-parse";

export type CatalogueSku = {
  id: string;
  name: string;
  millilitresPerCan: number | null;
  cansPerBox: number | null;
  packing: string | null;
  brandName: string | null;
  formulationName: string | null;
  finishedGoodId: string | null;
  active: boolean;
};

export type AliasRow = { name: string; productId: string };

export type CellMatch = {
  productId: string | null;
  status: PriceMatchStatus;
  confidence: number;
  candidates: Array<{ productId: string; name: string; score: number }>;
};

export const MATCHED_AT = 85;
export const SUGGESTED_AT = 60;

/* ---------------------------------------------------------------- words */

const STOP = new Set(["thinner", "thinners", "can", "cans", "tin", "plain", "the", "of", "and", "&"]);

/** Mahek's own abbreviations, as the lists print them. Punctuation, not a product master. */
const REWRITES: Array<[RegExp, string]> = [
  [/\bp\.?\s*u\.?\b/gi, "pu"],
  [/\bn\.?\s*c\.?\b/gi, "nc"],
  [/\bs\.?\s*d\.?\b/gi, "sd"],
  [/\bf\.?\s*d\.?\b/gi, "fd"],
  [/\bmylac[\s-]*135\b/gi, "mylac"],
  [/\bmelamine\b/gi, ""],
  [/\(\s*\d+\s*c\s*\)/gi, ""],
  [/\bmaruti\b/gi, ""],
  [/\bretarder\b/gi, "retarder thinner"],
];

function words(raw: string): string[] {
  let t = raw.toLowerCase();
  for (const [re, to] of REWRITES) t = t.replace(re, to);
  return t
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOP.has(w));
}

/**
 * The brand line of a SKU name: everything before " - <size>".
 *
 * TWO SPELLINGS, and both are read. `brandName` is the catalogue's own row —
 * "Epoxy Thinner (SD)" — while the SKU is NAMED "Mahek Epoxy Thinner (SD) -
 * 1 Liter", and a price list prints the second. Scoring against the brand row
 * alone marked the right SKU as merely suggested for want of the word Mahek.
 */
function brandOf(sku: CatalogueSku): string {
  if (sku.brandName) return sku.brandName;
  return namePrefixOf(sku);
}

function namePrefixOf(sku: CatalogueSku): string {
  const i = sku.name.indexOf(" - ");
  return i > 0 ? sku.name.slice(0, i) : sku.name;
}

/** Dice coefficient over word sets, 0 to 100. */
function dice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let both = 0;
  for (const w of sa) if (sb.has(w)) both++;
  return Math.round((200 * both) / (sa.size + sb.size));
}

/* -------------------------------------------------------------- structure */

function isTin(sku: CatalogueSku): boolean {
  return /tin\s*can/i.test(sku.name) || /tin/i.test(sku.packing ?? "");
}

function isLoose(sku: CatalogueSku): boolean {
  return /loose/i.test(sku.packing ?? "") || /\(loose\)/i.test(sku.name);
}

function isDrum(sku: CatalogueSku): boolean {
  return /drum/i.test(sku.packing ?? "") || /drum/i.test(sku.name);
}

/** The SKUs this column could possibly mean, whatever the row says. */
function structuralCandidates(column: ParsedColumn, catalogue: CatalogueSku[]): CatalogueSku[] {
  return catalogue.filter((sku) => {
    if (column.millilitres != null && sku.millilitresPerCan !== column.millilitres) return false;
    if (column.container === "drum") return isDrum(sku);
    if (column.container === "tin") {
      // A tin sold singly is the loose tin SKU; a tin by the box wants the box count.
      if (!isTin(sku)) return false;
      if (column.cansPerBox == null || column.cansPerBox <= 1) return isLoose(sku) || sku.cansPerBox === 1;
      return sku.cansPerBox === column.cansPerBox;
    }
    if (column.container === "loose") return isLoose(sku) && !isTin(sku);
    if (column.cansPerBox != null) return sku.cansPerBox === column.cansPerBox && !isTin(sku) && !isDrum(sku);
    return !isDrum(sku);
  });
}

/** The same product family a pack size away — offered when the exact packing does not exist. */
function nearCandidates(column: ParsedColumn, catalogue: CatalogueSku[]): CatalogueSku[] {
  return catalogue.filter((sku) => column.millilitres == null || sku.millilitresPerCan === column.millilitres);
}

/* --------------------------------------------------------------- aliases */

function aliasFor(rawProduct: string, column: ParsedColumn, aliases: AliasRow[]): string | null {
  const wanted = new Set([
    matchKey(`${rawProduct} - ${column.label}`),
    matchKey(`${rawProduct} ${column.label}`),
  ]);
  for (const a of aliases) if (wanted.has(matchKey(a.name))) return a.productId;
  return null;
}

/** A brand the aliases already taught us for this row's spelling, from any column. */
function aliasBrand(rawProduct: string, aliases: AliasRow[], byId: Map<string, CatalogueSku>): string | null {
  const prefix = matchKey(rawProduct);
  if (!prefix) return null;
  for (const a of aliases) {
    if (matchKey(a.name).startsWith(prefix)) {
      const sku = byId.get(a.productId);
      if (sku) return brandOf(sku);
    }
  }
  return null;
}

/* ----------------------------------------------------------------- score */

function scoreRow(rawProduct: string, sku: CatalogueSku, column: ParsedColumn, learnedBrand: string | null): number {
  const rowWords = words(rawProduct);
  const brandWords = words(brandOf(sku));
  const nameWords = words(namePrefixOf(sku));
  let score = Math.max(dice(rowWords, brandWords), dice(rowWords, nameWords));
  // "Mahek Universal Thinner" against brand "Mahek Universal Thinner" is 100;
  // against "Melody Green Thinner" (same formulation, different brand) the
  // formulation must not rescue it — a customer asks for the brand.
  if (learnedBrand && brandOf(sku) === learnedBrand) score = Math.max(score, 95);
  // Every row word found in the brand is a stronger signal than Dice alone
  // when the brand carries an extra word the list dropped ("Mahek").
  const brandSet = new Set([...brandWords, ...nameWords]);
  if (rowWords.length && rowWords.every((w) => brandSet.has(w))) score = Math.max(score, 88);
  // A "Tin Can" column wants the tin SKU and the plain row name says nothing about it.
  if (column.container === "tin" && isTin(sku)) score = Math.min(100, score + 5);
  if (!sku.active) score -= 10;
  return Math.max(0, Math.min(100, score));
}

/**
 * Every cell of a parsed list matched to a SKU, or held with its candidates.
 *
 * Keyed `${rowIndex}:${colIndex}`. Dash cells are matched too, so a rate
 * marked "not offered" can be written for the right SKU rather than nothing.
 */
export function matchGrid(
  parsed: ParsedPriceList,
  catalogue: CatalogueSku[],
  aliases: AliasRow[],
): Map<string, CellMatch> {
  const out = new Map<string, CellMatch>();
  const byId = new Map(catalogue.map((s) => [s.id, s]));
  const byColumn = new Map<number, CatalogueSku[]>();
  for (const col of parsed.columns) byColumn.set(col.colIndex, structuralCandidates(col, catalogue));

  for (const row of parsed.rows) {
    const learnedBrand = aliasBrand(row.rawProduct, aliases, byId);
    for (const cell of row.cells) {
      const column = parsed.columns[cell.colIndex];
      if (!column) continue;
      const key = `${row.rowIndex}:${cell.colIndex}`;

      const alias = aliasFor(row.rawProduct, column, aliases);
      if (alias && byId.has(alias)) {
        const sku = byId.get(alias)!;
        out.set(key, { productId: alias, status: "alias", confidence: 100, candidates: [{ productId: alias, name: sku.name, score: 100 }] });
        continue;
      }

      const exact = byColumn.get(cell.colIndex) ?? [];
      const scored = exact
        .map((sku) => ({ sku, score: scoreRow(row.rawProduct, sku, column, learnedBrand) }))
        .sort((a, b) => b.score - a.score || Number(b.sku.active) - Number(a.sku.active) || a.sku.name.localeCompare(b.sku.name));

      // A zero is not a candidate, it is every other product in the catalogue.
      // Offering five of them under a held cell reads as a broken matcher.
      let candidates = scored
        .filter((c) => c.score > 0)
        .slice(0, 5)
        .map((c) => ({ productId: c.sku.id, name: c.sku.name, score: c.score }));
      let best = scored[0] ?? null;
      let structural = true;

      // Nothing has this packing at all: offer the family at other packings as
      // suggestions, never as a match — the reviewer chooses the pack.
      if (!best || best.score < SUGGESTED_AT) {
        const near = nearCandidates(column, catalogue)
          .filter((sku) => !exact.includes(sku))
          .map((sku) => ({ sku, score: scoreRow(row.rawProduct, sku, column, learnedBrand) }))
          .filter((c) => c.score >= SUGGESTED_AT)
          .sort((a, b) => b.score - a.score);
        if (near.length && (!best || near[0].score > best.score)) {
          candidates = [...near.slice(0, 5).map((c) => ({ productId: c.sku.id, name: c.sku.name, score: c.score })), ...candidates].slice(0, 6);
          best = near[0];
          structural = false;
        }
      }

      if (!best) {
        out.set(key, { productId: null, status: "held", confidence: 0, candidates });
        continue;
      }
      const runnerUp = scored[1]?.score ?? 0;
      const clear = best.score - runnerUp >= 10 || scored.length < 2;
      if (structural && best.score >= MATCHED_AT && clear && best.sku.active) {
        out.set(key, { productId: best.sku.id, status: "matched", confidence: best.score, candidates });
      } else if (best.score >= SUGGESTED_AT) {
        out.set(key, { productId: best.sku.id, status: "suggested", confidence: structural ? best.score : Math.min(best.score, 70), candidates });
      } else {
        out.set(key, { productId: null, status: "held", confidence: best.score, candidates });
      }
    }
  }
  return out;
}
