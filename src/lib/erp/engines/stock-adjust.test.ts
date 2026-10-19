import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ADJUST_REASONS, adjustReasonText, readAdjust, stockAfter } from "./stock-adjust";

describe("adjusting stock by hand", () => {
  test("Add takes any quantity and a reason", () => {
    const r = readAdjust({ dir: "Add", qty: "25", reason: "Counting mistake" }, 10);
    assert.deepEqual(r, { ok: true, value: { dir: "add", qty: 25, reasonCode: "count", note: null } });
  });

  test("Remove may take the lot to zero and never below it", () => {
    assert.equal(readAdjust({ dir: "Remove", qty: "10", reason: "Damaged" }, 10).ok, true);
    const r = readAdjust({ dir: "Remove", qty: "10.5", reason: "Damaged" }, 10);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.field, "qty");
  });

  test("a direction, a quantity above zero and a reason are all asked for", () => {
    assert.equal((readAdjust({ qty: "1", reason: "Damaged" }, 5) as { field: string }).field, "dir");
    assert.equal((readAdjust({ dir: "Add", qty: "0", reason: "Damaged" }, 5) as { field: string }).field, "qty");
    assert.equal((readAdjust({ dir: "Add", qty: "abc", reason: "Damaged" }, 5) as { field: string }).field, "qty");
    assert.equal((readAdjust({ dir: "Add", qty: "2" }, 5) as { field: string }).field, "reason");
  });

  test("Other needs the reason written; the others do not", () => {
    assert.equal((readAdjust({ dir: "Add", qty: "2", reason: "Other" }, 5) as { field: string }).field, "note");
    const r = readAdjust({ dir: "Add", qty: "2", reason: "Other", note: "Extra half drum with the last GRN" }, 5);
    assert.equal(r.ok && r.value.note, "Extra half drum with the last GRN");
    assert.equal(r.ok && adjustReasonText(r.value.reasonCode, r.value.note), "Other: Extra half drum with the last GRN");
  });

  test("the list is short and ends with Other", () => {
    assert.equal(ADJUST_REASONS.length, 6);
    assert.equal(ADJUST_REASONS.at(-1)!.v, "other");
  });

  test("the stock after is said back", () => {
    assert.equal(stockAfter(214, { dir: "remove", qty: 12 }), 202);
    assert.equal(stockAfter(1240, { dir: "add", qty: 25 }), 1265);
  });
});
