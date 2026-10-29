/* ---------------------------------------------------------------------------
 * A PDF BROUGHT IN AS A CHANGE ON ITS BOOK — the shapes the screens read.
 * Client-safe: types only.
 * ------------------------------------------------------------------------- */

import type { BookCandidate } from "@/lib/engines/price-book-match";
import type { CellComparison, CrossReadCounts } from "@/lib/engines/price-cross-read";
import type { CellKind } from "@/lib/engines/price-change";

export type { BookCandidate };

export type BookMatchView = {
  documentId: string;
  /** Every standard book with a live or scheduled revision, best first. */
  candidates: BookCandidate[];
  winner: BookCandidate | null;
  /** The book that already has a change open, by book id — the action refuses those. */
  openChanges: Record<string, { changeId: string; title: string | null; makerName: string }>;
  /** Whether a change can be made from this document at all, and why not. */
  refusal: string | null;
  /** Where the document already became a change, the change. */
  madeChange: { changeId: string; bookId: string; bookName: string } | null;
};

export type ImportPreviewRow = {
  key: string;
  productId: string;
  productName: string;
  beforeIncl: number | null;
  afterIncl: number | null;
  kind: CellKind;
  changeBp: number | null;
};

export type ImportPreview = {
  bookId: string;
  bookName: string;
  againstVersion: number | null;
  rows: ImportPreviewRow[];
  counts: { up: number; down: number; same: number; added: number; removed: number };
  /** Reasons the document cannot be made a change as it stands. */
  blockers: string[];
  warnings: string[];
};

/** What the review screen and the import workbench draw beside a document. */
export type ImportFacts = {
  match: BookMatchView | null;
  cross: CrossReadView;
  /** Whether each model can be asked at all. */
  ai: { enabled: boolean; openai: boolean; anthropic: boolean };
};

export type CrossReadView = {
  documentId: string;
  /** The readers that answered, newest run each. */
  readers: Array<{ provider: "openai" | "anthropic"; label: string; model: string | null; at: string; ok: boolean; error: string | null }>;
  cells: CellComparison[];
  counts: CrossReadCounts;
  /** True once at least one model has answered. */
  ran: boolean;
};
