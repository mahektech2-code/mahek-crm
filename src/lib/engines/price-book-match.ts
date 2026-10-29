/* ---------------------------------------------------------------------------
 * WHICH BOOK IS THIS PDF A REVISION OF — with no I/O in it.
 *
 * A PDF that arrives at the desk is almost always next month's copy of a book
 * the desk already keeps: the same name on the header, the same reference
 * series, the same freight and delivery terms, and very nearly the same
 * products. Publishing it as a brand-new list made a second book for one
 * audience; this engine says which existing book it most looks like, so the
 * desk can bring it in as a CHANGE on that book instead.
 *
 * It only ever SUGGESTS. A candidate carries its score and the reasons in
 * words, and a "winner" is named only where one book is both above the
 * threshold and well ahead of the next — two books that look equally like the
 * file are a question for a person, not a coin toss. Agreed books (one shop's
 * own prices) are never matched: a printed list is for an audience, and
 * folding it into one shop's agreement would re-price that shop alone.
 *
 * Weights, out of 100:
 *   name 30 · products 35 · reference series 10 · freight 10 ·
 *   delivery basis 5 · tax basis and GST 5 · filename 5
 * A stated freight or delivery term that DIFFERS from the book's is taken
 * off, because a to-pay list and a paid list are two audiences however alike
 * their products are.
 * ------------------------------------------------------------------------- */

export type MatchDocument = {
  listName: string | null;
  refNo: string | null;
  freightTerm: string | null;
  deliveryBasis: string | null;
  taxBasis: "inclusive" | "exclusive" | null;
  gstBp: number | null;
  filename: string;
  hints: { region: string | null; freightTerm: string | null; customer: string | null; tokens: string[] } | null;
  /** The SKUs the document's cells were matched to (any confirmed or suggested match). */
  productIds: readonly string[];
};

export type MatchBook = {
  bookId: string;
  name: string;
  kind: "standard" | "agreed";
  refNo: string | null;
  freightTerm: string | null;
  deliveryBasis: string | null;
  taxBasis: string | null;
  gstBp: number | null;
  /** The SKUs on the book's live (or scheduled) revision. */
  productIds: readonly string[];
};

export type BookCandidate = { bookId: string; name: string; score: number; reasons: string[] };

export type BookMatch = {
  /** Every standard book, best first. */
  candidates: BookCandidate[];
  /** Named only where one book is clearly the answer. */
  winner: BookCandidate | null;
};

export const MATCH_THRESHOLD = 60;
export const MATCH_LEAD = 15;

const WEIGHT = { name: 30, products: 35, ref: 10, freight: 10, delivery: 5, tax: 5, filename: 5 } as const;

const MONTHS = [
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
];
/** Words every list carries, which say nothing about which one it is. */
const NOISE = new Set(["price", "prices", "list", "lists", "pl", "rate", "rates", "the", "of", "for", "and", "w", "e", "f", "wef", "new", "revised", "pdf", ...MONTHS]);

/** The words that name a list: lower case, no years, no months, no "price list". */
export function nameTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const words = text
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !NOISE.has(w) && !/^\d+$/.test(w) && !/^\d{1,2}(st|nd|rd|th)$/.test(w));
  return [...new Set(words)];
}

/** "PL0105" → "PL"; "MMI/ODI/12" → "MMI/ODI". The series, without the running number. */
export function refPrefix(refNo: string | null | undefined): string | null {
  if (!refNo) return null;
  const p = refNo.trim().toUpperCase().replace(/[\s/._-]*\d+$/, "").replace(/[\s/._-]+$/, "");
  return p.length >= 2 ? p : null;
}

function overlap(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  return a.filter((x) => sb.has(x)).length;
}

const stated = (v: string | null | undefined) => (v && v !== "not_stated" ? v : null);
const WORD: Record<string, string> = { to_pay: "to pay", paid: "paid", for_mumbai: "FOR Mumbai", for_godown: "FOR godown", door_delivery: "door delivery", ex_factory: "ex factory" };
const say = (v: string) => WORD[v] ?? v.replace(/_/g, " ");

/** One book against the document: a score out of 100 and why. */
export function scoreBook(doc: MatchDocument, book: MatchBook): BookCandidate {
  const reasons: string[] = [];
  let score = 0;

  // NAME — the header's own name for the list, against the book's.
  const dn = nameTokens(doc.listName);
  const bn = nameTokens(book.name);
  if (dn.length && bn.length) {
    const common = overlap(dn, bn);
    const ratio = common / Math.max(dn.length, bn.length);
    if (ratio === 1) {
      score += WEIGHT.name;
      reasons.push("The header names it as this book does");
    } else if (common) {
      score += Math.round(WEIGHT.name * ratio);
      reasons.push(`The header's name shares ${dn.filter((w) => bn.includes(w)).join(", ")}`);
    }
  }

  // PRODUCTS — how much of each one the other covers.
  const dp = [...new Set(doc.productIds)];
  const bp = [...new Set(book.productIds)];
  const common = overlap(dp, bp);
  if (dp.length && bp.length && common) {
    const dice = (2 * common) / (dp.length + bp.length);
    score += Math.round(WEIGHT.products * dice);
    reasons.push(`It prices ${common} of the ${bp.length} products the book carries`);
  }

  // REFERENCE SERIES — weak on its own (Mahek's numbering repeats), but real.
  const dr = refPrefix(doc.refNo);
  const br = refPrefix(book.refNo);
  if (dr && br && dr === br) {
    score += WEIGHT.ref;
    reasons.push(`Same reference series (${dr})`);
  }

  // FREIGHT — the filename's word counts where the header said nothing.
  const df = stated(doc.freightTerm) ?? stated(doc.hints?.freightTerm);
  const bf = stated(book.freightTerm);
  if (df && bf) {
    if (df === bf) {
      score += WEIGHT.freight;
      reasons.push(`Freight ${say(df)}, like the book`);
    } else {
      score -= WEIGHT.freight;
      reasons.push(`Freight differs: the file says ${say(df)}, the book ${say(bf)}`);
    }
  }

  const dd = stated(doc.deliveryBasis);
  const bd = stated(book.deliveryBasis);
  if (dd && bd) {
    if (dd === bd) {
      score += WEIGHT.delivery;
      reasons.push(`Delivery ${say(dd)}, like the book`);
    } else {
      score -= WEIGHT.delivery;
      reasons.push(`Delivery differs: ${say(dd)} against ${say(bd)}`);
    }
  }

  if (doc.taxBasis && book.taxBasis && doc.taxBasis === book.taxBasis && (doc.gstBp == null || book.gstBp == null || doc.gstBp === book.gstBp)) {
    score += WEIGHT.tax;
    reasons.push(`Prices ${doc.taxBasis} of GST${doc.gstBp != null ? ` at ${doc.gstBp / 100}%` : ""}, like the book`);
  }

  // FILENAME — a region, a customer or a word the file was named with.
  const hintWords = [
    ...nameTokens(doc.hints?.region),
    ...nameTokens(doc.hints?.customer),
    ...(doc.hints?.tokens ?? []).flatMap((t) => nameTokens(t)),
    ...nameTokens(doc.filename),
  ];
  const named = [...new Set(hintWords)].filter((w) => bn.includes(w) && !dn.includes(w));
  const namedAny = [...new Set(hintWords)].filter((w) => bn.includes(w));
  if (namedAny.length) {
    score += WEIGHT.filename;
    if (named.length) reasons.push(`The filename says ${named.join(", ")}`);
  }

  return { bookId: book.bookId, name: book.name, score: Math.max(0, Math.min(100, score)), reasons };
}

/** Every standard book scored, best first, and the winner where there clearly is one. */
export function rankBooks(
  doc: MatchDocument,
  books: readonly MatchBook[],
  opts: { threshold?: number; lead?: number } = {},
): BookMatch {
  const threshold = opts.threshold ?? MATCH_THRESHOLD;
  const lead = opts.lead ?? MATCH_LEAD;
  const candidates = books
    .filter((b) => b.kind !== "agreed")
    .map((b) => scoreBook(doc, b))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.bookId.localeCompare(b.bookId));
  const [first, second] = candidates;
  const winner = first && first.score >= threshold && first.score - (second?.score ?? 0) >= lead ? first : null;
  return { candidates, winner };
}
