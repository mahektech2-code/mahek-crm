import { test } from "node:test";
import assert from "node:assert/strict";
import {
  modeForReason,
  parseOutstanding,
  parseRupeesPaise,
  parseSheetDate,
} from "./outstanding-parse";

const HEAD = [
  "Bill Number", "Customer Name", "Bill Total Amount",
  "Bill Outstanding Amount", "Status", "Date", "Reason",
];

test("rupees become paise, decimals and all", () => {
  assert.equal(parseRupeesPaise("5,210.50"), 521050);
  assert.equal(parseRupeesPaise("1769.0"), 176900);
  assert.equal(parseRupeesPaise(""), null);
  assert.equal(parseRupeesPaise("Pending"), null);
});

test("the date column is read in all three of its spellings", () => {
  assert.equal(parseSheetDate("22/02/2026"), "2026-02-22");
  assert.equal(parseSheetDate("25/2/2026"), "2026-02-25");
  assert.equal(parseSheetDate("46328.0"), "2026-11-02");
  // A fragment is not a date. 21 would be January 1900.
  assert.equal(parseSheetDate("21"), null);
  assert.equal(parseSheetDate(""), null);
  assert.equal(parseSheetDate("Pending"), null);
});

test("a Pending row owes the figure in the outstanding column", () => {
  const { rows } = parseOutstanding([
    HEAD,
    ["MMI/26-27/0972", "A-ONE TRADERS", "6228.0", "6228.0", "Pending", "", "Pending"],
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owedPaise, 622800);
  assert.equal(rows[0].status, "pending");
});

test("a Paid row owes NOTHING, whatever its outstanding column says", () => {
  // This is the whole reading of the sheet, and the Rs 33 lakh question.
  const { rows } = parseOutstanding([
    HEAD,
    ["MMI/26-27/0857", "AGARWAL HARDWARE", "74823.0", "74823.0", "Paid", "19/08/2026", "Transfred"],
    ["MMI/25-26/0881", "A B ENTERPRISES", "81469.0", "1769.0", "Paid", "45695.0", "CN"],
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.owedPaise), [0, 0]);
  // What it said is still carried, so the run can report it.
  assert.deepEqual(rows.map((r) => r.statedPaise), [7482300, 176900]);
});

test("a blank status is never guessed at", () => {
  const { rows, unstated, problems } = parseOutstanding([
    HEAD,
    ["MMI/26-27/0751/8635", "COLOUR CAMP", "23423.0", "23423.0", "", "", ""],
  ]);
  assert.equal(rows.length, 0);
  assert.equal(problems.length, 0);
  assert.equal(unstated.length, 1);
  assert.equal(unstated[0].billNo, "MMI/26-27/0751/8635");
  assert.equal(unstated[0].statedPaise, 2342300);
});

test("a short row keeps its status and simply has no reason", () => {
  // Three rows in the book stop after the Date cell.
  const { rows } = parseOutstanding([
    HEAD,
    ["MMI/26-27/1135", "AASTHA ENTERPRISES", "3468.0", "3468.0", "Pending", "21"],
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owedPaise, 346800);
  assert.equal(rows[0].reason, "");
  assert.equal(rows[0].date, null);
});

test("nonsense is reported rather than applied", () => {
  const { rows, problems } = parseOutstanding([
    HEAD,
    ["MMI/1", "X", "abc", "10", "Pending", "", ""],
    ["MMI/2", "X", "100", "500", "Pending", "", ""],
    ["MMI/3", "X", "100", "-5", "Pending", "", ""],
    ["MMI/4", "X", "100", "10", "Cancelled", "", ""],
  ]);
  assert.equal(rows.length, 0);
  assert.equal(problems.length, 4);
  assert.match(problems[1], /exceeds the bill total/);
  assert.match(problems[3], /unknown status/);
});

test("the heading row and blank lines are not data", () => {
  const { rows, unstated, problems } = parseOutstanding([HEAD, [], ["", "", ""]]);
  assert.equal(rows.length + unstated.length + problems.length, 0);
});

test("how a bill was closed is recorded as the mode it actually was", () => {
  assert.equal(modeForReason("CN"), "Credit note");
  assert.equal(modeForReason("Adjusted"), "Adjustment");
  assert.equal(modeForReason("Transfred"), "Bank transfer");
  assert.equal(modeForReason(""), "Bank transfer");
});
