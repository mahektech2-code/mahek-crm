import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { hitSummary, linesFor, matchScore, searchGrnItems, sortPoLines, type GrnItem, type GrnPoLine } from "./grn-pick";

const line = (po: string, supplier: string, due: string | null, pending = 100): GrnPoLine => ({
  po: `${po} · ${supplier}`,
  poLine: "1. X",
  poNumber: po,
  supplier,
  godown: "Ambernath",
  due,
  ordered: pending,
  received: 0,
  pending,
  unit: "kg",
});

const items: GrnItem[] = [
  { item: "Toluene", type: "Chemical", code: "TOL", unit: "kg", lines: [line("PO-7", "Shree Ganesh", "2026-10-22", 800), line("PO-9", "Dharam Chem", "2026-10-17", 600)] },
  { item: "Toluene 20 L can", type: "Can", code: null, unit: "Pcs", lines: [line("PO-4", "Mono", null)] },
  { item: "Toluol (reclaimed)", type: "Chemical", code: null, unit: "kg", lines: [] },
  { item: "Mix Xylene", type: "Chemical", code: "MXY", unit: "kg", lines: [line("PO-9", "Dharam Chem", "2026-10-17")] },
];

describe("the goods receipt starts from the item", () => {
  test("a search lists receivable items first, and keeps the rest with no PO", () => {
    const hits = searchGrnItems(items, "tolu");
    assert.deepEqual(
      hits.map((h) => [h.item.item, h.receivable]),
      [
        ["Toluene", true],
        ["Toluene 20 L can", true],
        ["Toluol (reclaimed)", false],
      ],
    );
  });

  test("the whole name or the code is the best match, and every word has to be found", () => {
    assert.equal(matchScore(items[0], "toluene"), 3);
    assert.equal(matchScore(items[3], "mxy"), 3);
    assert.equal(matchScore(items[1], "20 can"), 2);
    assert.equal(matchScore(items[1], "20 drum"), 0);
    assert.equal(matchScore(items[3], "ylen"), 1);
  });

  test("once a vendor is named, only their open lines count", () => {
    assert.equal(linesFor(items[0], "Dharam Chem").length, 1);
    const hits = searchGrnItems(items, "", { supplier: "Dharam Chem" });
    assert.deepEqual(
      hits.filter((h) => h.receivable).map((h) => h.item.item),
      ["Mix Xylene", "Toluene"],
    );
    assert.equal(hits.find((h) => h.item.item === "Toluene 20 L can")?.receivable, false);
  });

  test("open lines come oldest due date first, undated last", () => {
    assert.deepEqual(
      sortPoLines([line("PO-4", "M", null), ...items[0].lines]).map((l) => l.poNumber),
      ["PO-9", "PO-7", "PO-4"],
    );
  });

  test("a hit says how many POs, how much and from whom", () => {
    assert.equal(hitSummary(items[0].lines, String), "2 open POs · 1400 kg pending · Shree Ganesh, Dharam Chem");
    assert.equal(hitSummary([], String), "No approved PO is waiting for this item");
  });
});
