import { test } from "node:test";
import assert from "node:assert/strict";
import { MATCH_THRESHOLD, nameTokens, rankBooks, refPrefix, scoreBook, type MatchBook, type MatchDocument } from "./price-book-match";
import { compareReaders, countVerdicts, findModelValue } from "./price-cross-read";

const P = (n: number) => Array.from({ length: n }, (_, i) => `prd_${i}`);

const doc = (over: Partial<MatchDocument> = {}): MatchDocument => ({
  listName: "Odisha To Pay — November 2026",
  refNo: "PL0201",
  freightTerm: "to_pay",
  deliveryBasis: "for_godown",
  taxBasis: "inclusive",
  gstBp: 1800,
  filename: "Odisha to pay nov.pdf",
  hints: { region: "Odisha", freightTerm: "to_pay", customer: null, tokens: ["odisha"] },
  productIds: P(20),
  ...over,
});

const book = (over: Partial<MatchBook> = {}): MatchBook => ({
  bookId: "bk_odisha",
  name: "Odisha To Pay — October 2026",
  kind: "standard",
  refNo: "PL0200",
  freightTerm: "to_pay",
  deliveryBasis: "for_godown",
  taxBasis: "inclusive",
  gstBp: 1800,
  productIds: P(20),
  ...over,
});

test("names are compared without months, years or 'price list'", () => {
  assert.deepEqual(nameTokens("Odisha To Pay — October 2026 Price List"), ["odisha", "to", "pay"]);
  assert.equal(refPrefix("PL0105"), "PL");
  assert.equal(refPrefix("MMI/ODI/12"), "MMI/ODI");
  assert.equal(refPrefix("12"), null);
});

test("next month's copy of a book scores near the top, with its reasons", () => {
  const c = scoreBook(doc(), book());
  assert.ok(c.score >= 90, `scored ${c.score}`);
  assert.ok(c.reasons.some((r) => r.includes("names it as this book")));
  assert.ok(c.reasons.some((r) => r.includes("20 of the 20 products")));
  assert.ok(c.reasons.some((r) => r.includes("PL")));
});

test("a clear winner is named; agreed books are never candidates", () => {
  const books = [
    book(),
    book({ bookId: "bk_paid", name: "Odisha Paid — October 2026", freightTerm: "paid", productIds: P(20) }),
    book({ bookId: "bk_mh", name: "Maharashtra", freightTerm: "not_stated", refNo: "MH01", productIds: P(5) }),
    book({ bookId: "bk_agreed", name: "Odisha To Pay — October 2026", kind: "agreed" }),
  ];
  const m = rankBooks(doc(), books);
  assert.equal(m.candidates[0].bookId, "bk_odisha");
  assert.equal(m.winner?.bookId, "bk_odisha");
  assert.ok(!m.candidates.some((c) => c.bookId === "bk_agreed"));
  // The paid book is penalised for its freight even though its products match.
  const paid = m.candidates.find((c) => c.bookId === "bk_paid")!;
  assert.ok(paid.reasons.some((r) => r.startsWith("Freight differs")));
  assert.ok(paid.score < m.candidates[0].score - 15);
});

test("two books that look equally like the file name no winner", () => {
  const m = rankBooks(doc({ listName: null, freightTerm: null, hints: null, filename: "scan.pdf", refNo: null }), [
    book({ bookId: "a", name: "Book A" }),
    book({ bookId: "b", name: "Book B" }),
  ]);
  assert.equal(m.winner, null);
  assert.equal(m.candidates.length, 2);
});

test("a weak match below the threshold is a candidate, never a winner", () => {
  const m = rankBooks(doc({ listName: "Gujarat", refNo: null, hints: null, filename: "x.pdf", freightTerm: null, deliveryBasis: null, taxBasis: null, productIds: P(3) }), [
    book({ name: "Odisha", productIds: P(30) }),
  ]);
  assert.ok(m.candidates[0].score < MATCH_THRESHOLD);
  assert.equal(m.winner, null);
});

test("no books, no candidates", () => {
  assert.deepEqual(rankBooks(doc(), []), { candidates: [], winner: null });
});

/* --------------------------------------------------------- three readers */

const staged = [
  { id: "r1", rawProductText: "Nano Thinner", rawPackText: "20 Ltr", millilitres: 20000, printedPaise: 252_100 },
  { id: "r2", rawProductText: "Nano Thinner", rawPackText: "1 Ltr", millilitres: 1000, printedPaise: 13_500 },
  { id: "r3", rawProductText: "PU Thinner", rawPackText: "5 Ltr", millilitres: 5000, printedPaise: 58_400 },
];

test("a model cell is found by product and pack size, however the pack is spelled", () => {
  assert.equal(findModelValue(staged[0], [{ product: "NANO THINNER", pack: "20 L", pricePaise: 252_100 }]), 252_100);
  assert.equal(findModelValue(staged[0], [{ product: "Nano Thinner", pack: "1 L", pricePaise: 13_500 }]), undefined);
});

test("agree only when every reader that answered prints the same figure", () => {
  const openai = [
    { product: "Nano Thinner", pack: "20 Litre", pricePaise: 252_100 },
    { product: "Nano Thinner", pack: "1 Litre", pricePaise: 13_550 },
    { product: "PU Thinner", pack: "5 Litre", pricePaise: 85_400 },
  ];
  const anthropic = [
    { product: "Nano Thinner", pack: "20 L", pricePaise: 252_100 },
    { product: "Nano Thinner", pack: "1 L", pricePaise: 13_500 },
  ];
  const cells = compareReaders(staged, { openai, anthropic });
  assert.equal(cells[0].verdict, "agree");
  assert.equal(cells[1].verdict, "agree", "₹0.50 apart is within ₹1");
  assert.equal(cells[2].verdict, "disagree");
  assert.equal(cells[2].openai, 85_400);
  assert.equal(cells[2].anthropic, undefined);
  assert.deepEqual(countVerdicts(cells), { agree: 2, disagree: 1, unseen: 0 });
});

test("a cell a model did not mention is unseen, not a disagreement", () => {
  const cells = compareReaders(staged.slice(0, 1), { openai: [], anthropic: [{ product: "Nano Thinner", pack: "20 L", pricePaise: 252_100 }] });
  assert.equal(cells[0].verdict, "unseen");
});

test("with no model answered, nothing is agreed", () => {
  const cells = compareReaders(staged, {});
  assert.ok(cells.every((c) => c.verdict === "unseen"));
});
