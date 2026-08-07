import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "./csv";

describe("CSV export", () => {
  test("quotes every field - Indian business names contain commas", () => {
    const csv = toCsv(["Customer", "City"], [["Shah & Co, Traders", "Mumbai"]]);
    assert.equal(csv, '"Customer","City"\n"Shah & Co, Traders","Mumbai"');
  });

  test("a quote inside a field is doubled, not dropped", () => {
    const csv = toCsv(["Note"], [['He said "call back"']]);
    assert.match(csv, /"He said ""call back"""/);
  });

  test("null and undefined become empty cells, never the word null", () => {
    const csv = toCsv(["A", "B"], [[null, undefined]]);
    assert.equal(csv, '"A","B"\n"",""');
  });
});
