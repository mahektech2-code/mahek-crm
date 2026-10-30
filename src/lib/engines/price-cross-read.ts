/* ---------------------------------------------------------------------------
 * THREE READERS OF ONE PDF, compared cell by cell — with no I/O in it.
 *
 * The text layer is read exactly by code; OpenAI and Claude are each handed
 * the file and asked to transcribe every cell. None of the three is trusted
 * alone. A cell is AGREED only where every reader that answered prints the
 * same figure (within ₹1); anywhere else the three values are kept side by
 * side and a person picks one. AI is advice: nothing here writes a price.
 *
 * Matching a model's cell to a staged one is by the product text and the pack,
 * both folded to letters and digits, the pack also by its size in millilitres
 * (a model writes "5 Ltr" where the paper said "5 L"). A cell no model cell
 * could be matched to is UNSEEN for that model — said, not counted as a
 * disagreement, because a missed match is our reading of their answer, not
 * their reading of the paper.
 * ------------------------------------------------------------------------- */

import { parsePackColumn } from "@/lib/price-list-parse";

export type ReaderName = "openai" | "anthropic";

/** One cell as a model transcribed it. `pricePaise` null is a dash or a blank. */
export type ModelCell = { product: string; pack: string; pricePaise: number | null };

export type StagedCell = {
  id: string;
  rawProductText: string;
  rawPackText: string | null;
  millilitres: number | null;
  /** What the paper printed, as the text reader staged it. */
  printedPaise: number | null;
};

export type CellVerdict = "agree" | "disagree" | "unseen";

export type CellComparison = {
  rowId: string;
  verdict: CellVerdict;
  text: number | null;
  openai: number | null | undefined;
  anthropic: number | null | undefined;
  /** How many readers gave a figure that was compared. */
  readers: number;
};

export const TOLERANCE_PAISE = 100;

export function fold(text: string | null | undefined): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}

function millilitresOf(pack: string | null | undefined): number | null {
  if (!pack) return null;
  return parsePackColumn(pack, "").millilitres ?? null;
}

function sameProduct(a: string, b: string): boolean {
  const fa = fold(a);
  const fb = fold(b);
  if (!fa || !fb) return false;
  if (fa === fb || fa.includes(fb) || fb.includes(fa)) return true;
  const wa = words(a);
  const wb = new Set(words(b));
  if (!wa.length || !wb.size) return false;
  const common = wa.filter((w) => wb.has(w)).length;
  return common / Math.max(wa.length, wb.size) >= 0.6;
}

function samePack(staged: StagedCell, model: ModelCell): boolean {
  const a = fold(staged.rawPackText);
  const b = fold(model.pack);
  if (a && b && a === b) return true;
  const ml = staged.millilitres ?? millilitresOf(staged.rawPackText);
  const mm = millilitresOf(model.pack);
  if (ml != null && mm != null) return ml === mm;
  // A one-price-a-line list names the pack inside the product; no pack on either side is a match on the product alone.
  return !a && !b;
}

/** The model's figure for a staged cell: undefined where no cell of its answer is this one. */
export function findModelValue(staged: StagedCell, cells: readonly ModelCell[]): number | null | undefined {
  const hits = cells.filter((c) => sameProduct(staged.rawProductText, c.product) && samePack(staged, c));
  if (!hits.length) return undefined;
  // Several hits (a product named twice): the one closest to the text reader's figure.
  if (staged.printedPaise != null) {
    const priced = hits.filter((h) => h.pricePaise != null);
    if (priced.length) return priced.sort((x, y) => Math.abs(x.pricePaise! - staged.printedPaise!) - Math.abs(y.pricePaise! - staged.printedPaise!))[0].pricePaise;
  }
  return hits[0].pricePaise;
}

function close(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) <= TOLERANCE_PAISE;
}

/**
 * Every staged cell against whichever models answered. A model that did not
 * answer at all is `null` here and simply not a reader; one that answered
 * contributes `undefined` (unseen) or its figure for each cell.
 */
export function compareReaders(
  staged: readonly StagedCell[],
  models: Partial<Record<ReaderName, readonly ModelCell[] | null>>,
): CellComparison[] {
  const openai = models.openai ?? null;
  const anthropic = models.anthropic ?? null;
  return staged.map((s) => {
    const o = openai ? findModelValue(s, openai) : undefined;
    const a = anthropic ? findModelValue(s, anthropic) : undefined;
    const given = [openai ? o : undefined, anthropic ? a : undefined].filter((v) => v !== undefined) as Array<number | null>;
    const asked = (openai ? 1 : 0) + (anthropic ? 1 : 0);
    let verdict: CellVerdict;
    if (given.some((v) => !close(v, s.printedPaise))) verdict = "disagree";
    else if (given.length < asked || !asked) verdict = "unseen";
    else verdict = "agree";
    return { rowId: s.id, verdict, text: s.printedPaise, openai: openai ? o : undefined, anthropic: anthropic ? a : undefined, readers: given.length + 1 };
  });
}

export type CrossReadCounts = { agree: number; disagree: number; unseen: number };

export function countVerdicts(cells: readonly CellComparison[]): CrossReadCounts {
  return {
    agree: cells.filter((c) => c.verdict === "agree").length,
    disagree: cells.filter((c) => c.verdict === "disagree").length,
    unseen: cells.filter((c) => c.verdict === "unseen").length,
  };
}
