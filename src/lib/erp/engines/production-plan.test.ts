import { test } from "node:test";
import assert from "node:assert/strict";
import { changedSince, lineProblems, lineState, printMarks, sizeName } from "./production-plan";

const line = (id: string, quantity: number, over: Record<string, unknown> = {}) => ({
  id,
  category: "loose",
  productName: "Nano Thinner 20 L",
  productCode: null,
  size: "20 L",
  quantity,
  unit: "Cans",
  remarks: null,
  ...over,
});

test("before any print every line is new, and the first print marks nothing", () => {
  assert.equal(lineState({ ...line("a", 40), deleted: false }, null), "new");
  const { rows, removed } = printMarks([line("a", 40)], null);
  assert.equal(rows[0].mark, null);
  assert.deepEqual(removed, []);
});

test("against the last print a line is given, edited, new or removed", () => {
  const last = new Map([["a", line("a", 40)], ["b", line("b", 15)]]);
  assert.equal(lineState({ ...line("a", 40), deleted: false }, last), "given");
  assert.equal(lineState({ ...line("a", 43), deleted: false }, last), "edited");
  assert.equal(lineState({ ...line("c", 3), deleted: false }, last), "new");
  assert.equal(lineState({ ...line("b", 15), deleted: true }, last), "removed");
  /* Added and deleted between two prints: the floor never saw it. */
  assert.equal(lineState({ ...line("d", 5), deleted: true }, last), null);
  assert.equal(
    changedSince(
      [
        { ...line("a", 40), deleted: false },
        { ...line("b", 15), deleted: true },
        { ...line("c", 3), deleted: false },
        { ...line("d", 5), deleted: true },
      ],
      last,
    ),
    2,
  );
});

test("a reprint underlines new and edited lines, says what an edit was, and lists removals", () => {
  const prev = [line("a", 40), line("b", 80, { category: "packing" }), line("x", 15, { category: "packing" })];
  const cur = [line("a", 40), line("b", 100, { category: "packing" }), line("c", 3, { remarks: "Urgent" })];
  const { rows, removed } = printMarks(cur, prev);
  const by = new Map(rows.map((r) => [r.id, r]));
  assert.equal(by.get("a")!.mark, null);
  assert.equal(by.get("c")!.mark, "new");
  assert.equal(by.get("b")!.mark, "edited");
  assert.equal(by.get("b")!.was, 80);
  assert.deepEqual(removed.map((r) => r.id), ["x"]);
  /* Category order, numbered in that order. */
  assert.deepEqual(rows.map((r) => [r.sr, r.category]), [[1, "loose"], [2, "loose"], [3, "packing"]]);
});

test("a line needs a product, a size where the category has one, and a quantity above zero", () => {
  const ok = { itemExists: true, size: "20 L" };
  assert.deepEqual(lineProblems({ category: "loose", itemId: "fg1", quantity: "40", unit: "Cans" }, ok), {});
  assert.ok(lineProblems({ category: "loose", itemId: "", quantity: "40", unit: "Cans" }, ok).itemId);
  assert.ok(lineProblems({ category: "loose", itemId: "fg1", quantity: "0", unit: "Cans" }, ok).quantity);
  assert.ok(lineProblems({ category: "loose", itemId: "fg1", quantity: "2.5", unit: "Cans" }, ok).quantity);
  assert.ok(lineProblems({ category: "loose", itemId: "fg1", quantity: "4", unit: "Cans" }, { itemExists: true, size: null }).itemId);
  assert.deepEqual(lineProblems({ category: "sfg", itemId: "f1", quantity: "12.5", unit: "Litre" }, { itemExists: true, size: null }), {});
  assert.ok(lineProblems({ category: "nope", itemId: "f1", quantity: "1", unit: "Litre" }, ok).category);
});

test("sizes read as the floor names them", () => {
  assert.equal(sizeName(20000), "20 L");
  assert.equal(sizeName(800), "800 ml");
  assert.equal(sizeName(500), "500 ml");
  assert.equal(sizeName(null), null);
});
