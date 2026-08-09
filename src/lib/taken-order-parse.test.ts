import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTakenOrderOpen,
  parseSheetDateTime,
  parseTakenOrderRow,
  parseWeightGrams,
  resolveTakenColumns,
  TAKEN_COL,
} from "./taken-order-parse";

/* ---------------------------------------------------------------------------
 * The Taken Order tab. Pure, so no database.
 *
 * Most of this file is one rule stated many ways, because that rule decides
 * whether a customer's phone rings and it is asymmetric in a way that is easy
 * to "simplify" wrongly: Ready AND Done releases, either one failing holds.
 * ------------------------------------------------------------------------- */

const HEADERS = [
  "Order number", "Location", "Date", "Billing Party Name", "Delivery Party Name",
  "Standing Instructions", "Area", "Transporter name", "Description Of Goods",
  "Order Qty No. Of Can", "Box Quantity", "Status", "Rate", "Discount",
  "Tally Bill No.", "Transportation Cost", "Remark", "Entry status",
  "Party Status", "User Name", "Order ID", "Timpstamp", "Weight",
];

const COLUMNS = resolveTakenColumns(HEADERS);

/* ------------------------------------------------------------- the rule */

test("Ready and Done together release the customer", () => {
  assert.equal(isTakenOrderOpen("Ready", "Done"), false);
});

test("Hold From Office holds, whatever the entry status says", () => {
  assert.equal(isTakenOrderOpen("Hold From Office", "Done"), true);
  assert.equal(isTakenOrderOpen("Hold From Office", "Not Done"), true);
});

test("Not Done holds, even when the goods are marked Ready", () => {
  assert.equal(isTakenOrderOpen("Ready", "Not Done"), true);
});

test("case and stray whitespace do not change the answer", () => {
  assert.equal(isTakenOrderOpen("  ready ", "DONE"), false);
  assert.equal(isTakenOrderOpen("hold  from   office", "done"), true);
});

test("Cancel releases on its own, whatever the entry status says", () => {
  // The one status that never changes again. Held, it would be a permanent
  // mute — and the customer behind a cancelled order has not ordered anything.
  assert.equal(isTakenOrderOpen("Cancel", "Done"), false);
  assert.equal(isTakenOrderOpen("Cancel", "Not Done"), false);
  assert.equal(isTakenOrderOpen("cancel", ""), false);
});

test("the tab's other live statuses all hold", () => {
  assert.equal(isTakenOrderOpen("Under Process", "Done"), true);
  assert.equal(isTakenOrderOpen("Delay", "Done"), true);
});

test("an unrecognised status holds rather than releases", () => {
  // The safe direction, and deliberate: the full vocabulary of this column is
  // not known, and a value nobody has seen must not read as dispatched.
  assert.equal(isTakenOrderOpen("Partially Dispatched", "Done"), true);
  assert.equal(isTakenOrderOpen("Redy", "Done"), true);
  assert.equal(isTakenOrderOpen("", ""), true);
  assert.equal(isTakenOrderOpen(null, null), true);
});

/* ------------------------------------------------------- column binding */

test("the two decisive columns are found by header text", () => {
  assert.equal(COLUMNS.officeStatus, "Status");
  assert.equal(COLUMNS.entryStatus, "Entry status");
});

test("a renamed status header falls back to columns L and R", () => {
  const renamed = [...HEADERS];
  renamed[11] = "Dispatch Status";
  renamed[17] = "Office Entry";

  const columns = resolveTakenColumns(renamed);
  assert.equal(columns.officeStatus, "Dispatch Status");
  assert.equal(columns.entryStatus, "Office Entry");
});

test("a column with neither a header nor a fallback resolves to null", () => {
  const columns = resolveTakenColumns(["Order ID", "Status"]);
  assert.equal(columns.remark, null);
  assert.equal(columns.lineKey, "Order ID");
});

/* ------------------------------------------------------------ the row */

const ROW: Record<string, string> = {
  "Order number": "47",
  Location: "Bhiwandi - Rehnal",
  Date: "20/08/2024",
  "Billing Party Name": "RAJ COLOUR AND CHEMICAL",
  "Delivery Party Name": "RAJ COLOUR AND CHEMICAL",
  "Standing Instructions": "Discount 4% - Door Delivery - To Pay - With Weight",
  Area: "RAJKOT",
  "Transporter name": "INDEX TRANSPORT",
  "Description Of Goods": "Mahek Universal Thinner - 5 Liter (06 Can/Box)",
  "Order Qty No. Of Can": "30",
  "Box Quantity": "5",
  Status: "Ready",
  Rate: "440.68",
  Discount: "4.00%",
  "Tally Bill No.": "MMI/24-25/1653",
  "Transportation Cost": "",
  Remark: "",
  "Entry status": "Done",
  "Party Status": "",
  "User Name": "ANKIT SRIVASTAV",
  "Order ID": "ODID-C55674",
  Timpstamp: "20/08/2024 11:10:07",
  Weight: "27",
};

test("a dispatched line reads back with every field typed", () => {
  const row = parseTakenOrderRow(ROW, COLUMNS);

  assert.equal(row.lineKey, "ODID-C55674");
  assert.equal(row.orderNumber, "47");
  assert.equal(row.orderDate, "2024-08-20");
  assert.equal(row.billingPartyName, "RAJ COLOUR AND CHEMICAL");
  assert.equal(row.cans, 30);
  assert.equal(row.boxes, 5);
  // Rupees to paise, per can — not a line total.
  assert.equal(row.ratePaise, 44068);
  // A PERCENTAGE. Four percent is 400 basis points, not four rupees.
  assert.equal(row.discountBp, 400);
  assert.equal(row.weightGrams, 27_000);
  assert.equal(row.open, false);
  assert.deepEqual(row.issues, []);
});

test("a held line is open and keeps the sheet's own words", () => {
  const row = parseTakenOrderRow(
    { ...ROW, Status: "Hold From Office", "Entry status": "Not Done" },
    COLUMNS,
  );

  assert.equal(row.open, true);
  assert.equal(row.officeStatus, "Hold From Office");
  assert.equal(row.entryStatus, "Not Done");
  // A known status, so no note for anybody to act on.
  assert.deepEqual(row.issues, []);
});

test("an unknown status is held AND reported", () => {
  const row = parseTakenOrderRow({ ...ROW, Status: "Awaiting Stock" }, COLUMNS);

  assert.equal(row.open, true);
  const issue = row.issues.find((i) => i.column === TAKEN_COL.officeStatus);
  assert.ok(issue, "the unrecognised status should reach a person, not only behaviour");
  assert.equal(issue.kind, "ambiguous");
  assert.equal(issue.value, "Awaiting Stock");
});

test("an unreadable cell becomes null and an issue, and the row still imports", () => {
  const row = parseTakenOrderRow({ ...ROW, Rate: "n/a", Date: "sometime" }, COLUMNS);

  assert.equal(row.ratePaise, null);
  assert.equal(row.orderDate, null);
  assert.equal(row.lineKey, "ODID-C55674", "the rest of the row survives one bad cell");
  assert.equal(row.issues.length, 2);
});

test("an open line with no billing party is flagged — it can hold nobody", () => {
  const row = parseTakenOrderRow(
    { ...ROW, Status: "Hold From Office", "Billing Party Name": "" },
    COLUMNS,
  );

  const issue = row.issues.find((i) => i.column === TAKEN_COL.billingPartyName);
  assert.ok(issue);
  assert.equal(issue.kind, "contradiction");
});

/* ------------------------------------------------------------ primitives */

test("the timestamp is read as a wall clock in Asia/Kolkata", () => {
  // 16:29:55 IST is 10:59:55 UTC. Read as UTC it would file a late-afternoon
  // order at 9:59pm, and the last orders of a day onto the next one.
  assert.equal(
    parseSheetDateTime("14/08/2024 16:29:55")?.toISOString(),
    "2024-08-14T10:59:55.000Z",
  );
});

test("a date with no time lands at midnight, and nonsense stays null", () => {
  assert.equal(parseSheetDateTime("14/08/2024")?.toISOString(), "2024-08-13T18:30:00.000Z");
  assert.equal(parseSheetDateTime("14/08/2024 25:00:00"), null);
  assert.equal(parseSheetDateTime(""), null);
});

test("weight keeps its half-kilos", () => {
  assert.equal(parseWeightGrams("27"), 27_000);
  assert.equal(parseWeightGrams("27.5"), 27_500);
  assert.equal(parseWeightGrams("27 kg"), 27_000);
  assert.equal(parseWeightGrams("heavy"), null);
});
