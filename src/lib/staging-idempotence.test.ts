/**
 * SYNCING THE SAME UNCHANGED TAB TWICE MUST WRITE NO STAGING ROW.
 *
 *   npm run test:integration
 *
 * The sibling of `projection-idempotence.test.ts`, one layer up: that one
 * watches what the projection writes into `customers`, `orders` and `bills`;
 * this one watches what the SYNC writes into the `sheet_*` staging tables it
 * projects from.
 *
 * Every one of these imports used to answer "which rows have left the sheet"
 * by stamping `last_seen_sync_id` onto every row it saw, and then withdrawing
 * whatever still held an older id. On a quiet tab that stamp is the only write
 * the pass makes — and it makes one per row, every thirty minutes, for ever.
 * Measured on production, `sheet_taken_order_rows` had taken 63,423,497
 * updates against 21,348 live rows, in cycles whose own log read "0 new, 0
 * changed, 21337 unchanged".
 *
 * `xmin` is what these assert on, and it is the only honest witness: it is the
 * transaction that inserted the tuple the row is currently stored as, so it
 * moves if and only if the row was genuinely rewritten. The run's own counts
 * cannot say — they reported "unchanged" throughout the years this ran.
 *
 * The other half matters exactly as much: a row that DID change must still
 * land, a row that has LEFT the sheet must still be withdrawn, and a row the
 * sheet takes BACK unaltered must come back to `present` — that last one is
 * the case the old stamp handled for free and a difference does not, because
 * its hash matches and no upsert will carry it.
 *
 * Needs mahekone_test, which `npm run test:db` creates from the committed
 * migrations. The harness truncates between tests.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { sheetPaymentRows, sheetTakenOrderRows } from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { syncPaymentSheet } from "@/lib/services/sheet-sync-service";
import { syncTakenOrderSheet } from "@/lib/services/taken-order-sync-service";
import type { ReadRange, SheetTable } from "@/lib/sheets";
import type { SheetReader } from "@/lib/services/sheet-sync-core";

/**
 * A tab, served the way Google serves one.
 *
 * Row numbers are the sheet's own and 1-based, so data starts at 2 — which is
 * what both of these importers assume, and getting it wrong here would make
 * the fixture agree with a bug rather than with the sheet. `rowsInWindow` has
 * to be the count the range actually spans, blanks included, because that is
 * how `readWindows` finds the end of a tab.
 */
function fakeSheet(headers: string[], rows: Record<string, string>[]): SheetReader {
  return async (range: ReadRange): Promise<SheetTable> => {
    const first = range.firstRow ?? 1;
    const last = range.lastRow ?? 1 + rows.length;

    const numbered = rows.map((cells, i) => ({ rowNumber: i + 2, cells }));
    const inRange = numbered.filter((r) => r.rowNumber >= first && r.rowNumber <= last);

    // Row 1 is the header and carries no data of its own.
    const spanned = Math.max(0, Math.min(last, rows.length + 1) - Math.max(first, 2) + 1);

    return { headers, rows: inRange, rowsInWindow: spanned };
  };
}

/* ------------------------------------------------------ the Taken Order tab */

const TAKEN_HEADERS = [
  "Order number", "Location", "Date", "Billing Party Name", "Delivery Party Name",
  "Standing Instructions", "Area", "Transporter name", "Description Of Goods",
  "Order Qty No. Of Can", "Box Quantity", "Status", "Rate", "Discount",
  "Tally Bill No.", "Transportation Cost", "Remark", "Entry status",
  "Party Status", "User Name", "Order ID", "Timpstamp", "Weight",
];

const takenRow = (lineKey: string, status = "Ready", extra: Record<string, string> = {}) => ({
  "Order number": lineKey.replace("ODID-", ""),
  "Location": "Nagpur",
  "Date": "01-Aug-2026",
  "Billing Party Name": "Shree Paints",
  "Delivery Party Name": "",
  "Standing Instructions": "",
  "Area": "Sadar",
  "Transporter name": "",
  "Description Of Goods": "Nano Thinner - 20 Liter (Loose)",
  "Order Qty No. Of Can": "6",
  "Box Quantity": "",
  "Status": status,
  "Rate": "1200",
  "Discount": "",
  "Tally Bill No.": `T-${lineKey}`,
  "Transportation Cost": "",
  "Remark": "",
  "Entry status": "Done",
  "Party Status": "",
  "User Name": "Poonam",
  "Order ID": lineKey,
  "Timpstamp": "",
  "Weight": "",
  ...extra,
});

/* --------------------------------------------------- the Payment Status tab */

const PAY_HEADERS = [
  "Order Number", "Billing Party Name", "Tally Bill No.", "Dispatch Date",
  "Bill Amount", "Due Date", "Payment Status", "Payment Received Date",
  "Message Date", "Next Message Date", "Back Office",
];

const payRow = (orderNumber: string, status = "Received") => ({
  "Order Number": orderNumber,
  "Billing Party Name": "Shree Paints",
  "Tally Bill No.": `T-${orderNumber}`,
  "Dispatch Date": "01-Aug-2026",
  "Bill Amount": "7200",
  "Due Date": "31-Aug-2026",
  "Payment Status": status,
  "Payment Received Date": "",
  "Message Date": "",
  "Next Message Date": "",
  "Back Office": "Deepa",
});

const payOptions = (reader: SheetReader) => ({
  source: "payment_status",
  spreadsheetId: "test-book",
  tabTitle: "Payment Status",
  mode: "reconcile" as const,
  reader,
});

/* --------------------------------------------------------------- the witness */

/**
 * The transaction that wrote the tuple each row is currently stored as.
 *
 * Every column is qualified against its own table, which is the house rule for
 * raw SQL and not merely tidiness: `xmin` is a system column and every table
 * in the database has one.
 */
async function tupleVersions(table: "taken" | "payments"): Promise<Map<string, string>> {
  const rows = await db.execute<{ k: string; v: string }>(
    table === "taken"
      ? sql`select sheet_taken_order_rows.line_key as k,
                   sheet_taken_order_rows.xmin::text as v
              from sheet_taken_order_rows`
      : sql`select sheet_payment_rows.order_number as k,
                   sheet_payment_rows.xmin::text as v
              from sheet_payment_rows`,
  );
  return new Map(rows.map((r) => [r.k, r.v]));
}

function assertNoRowRewritten(before: Map<string, string>, after: Map<string, string>) {
  assert.equal(after.size, before.size, "the second pass must create no rows");
  for (const [key, version] of after) {
    assert.equal(
      version,
      before.get(key),
      `staging row ${key} was rewritten by a pass that had nothing to change`,
    );
  }
}

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table sheet_taken_order_rows, sheet_payment_rows, sheet_sync_runs,
                   customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
});

after(async () => {
  await db.$client.end();
});

/* --------------------------------------------------------------------- taken */

test("a second taken-order sync over an unchanged tab rewrites no row", async () => {
  const reader = fakeSheet(
    TAKEN_HEADERS,
    ["ODID-1", "ODID-2", "ODID-3"].map((k) => takenRow(k)),
  );

  const first = await syncTakenOrderSheet({ reader });
  assert.equal(first.rowsCreated, 3);

  const before = await tupleVersions("taken");
  assert.equal(before.size, 3);

  const second = await syncTakenOrderSheet({ reader });
  assert.equal(second.rowsUnchanged, 3, "the pass must still recognise all three as unchanged");
  assert.equal(second.rowsCreated, 0);
  assert.equal(second.rowsUpdated, 0);
  assert.equal(second.rowsWithdrawn, 0, "nothing left the tab, so nothing may be withdrawn");

  assertNoRowRewritten(before, await tupleVersions("taken"));
});

test("a taken-order row that really changed is still written", async () => {
  await syncTakenOrderSheet({
    reader: fakeSheet(TAKEN_HEADERS, [takenRow("ODID-1"), takenRow("ODID-2")]),
  });
  const before = await tupleVersions("taken");

  // One cell moves, on one row. The sheet's own release rule turns on this
  // cell, so a skip here would mute a customer whose order has gone out.
  await syncTakenOrderSheet({
    reader: fakeSheet(TAKEN_HEADERS, [
      takenRow("ODID-1", "Hold From Office"),
      takenRow("ODID-2"),
    ]),
  });

  const after = await tupleVersions("taken");
  assert.notEqual(after.get("ODID-1"), before.get("ODID-1"), "the changed row must be rewritten");
  assert.equal(after.get("ODID-2"), before.get("ODID-2"), "its neighbour must not be");

  const stored = await db.query.sheetTakenOrderRows.findFirst({
    where: (t, { eq }) => eq(t.lineKey, "ODID-1"),
  });
  assert.equal(stored?.officeStatus, "Hold From Office");
  assert.equal(stored?.open, true, "a held row is an open line, which is what holds the customer");
});

test("a taken-order row that left the tab is still withdrawn", async () => {
  await syncTakenOrderSheet({
    reader: fakeSheet(TAKEN_HEADERS, [takenRow("ODID-1"), takenRow("ODID-2")]),
  });

  const outcome = await syncTakenOrderSheet({
    reader: fakeSheet(TAKEN_HEADERS, [takenRow("ODID-1")]),
  });

  assert.equal(outcome.rowsWithdrawn, 1);
  const rows = await db.select().from(sheetTakenOrderRows);
  assert.equal(rows.find((r) => r.lineKey === "ODID-1")?.status, "present");
  assert.equal(rows.find((r) => r.lineKey === "ODID-2")?.status, "withdrawn");
});

test("a withdrawn taken-order row pasted back unaltered returns to present", async () => {
  const full = fakeSheet(TAKEN_HEADERS, [takenRow("ODID-1"), takenRow("ODID-2")]);

  await syncTakenOrderSheet({ reader: full });
  await syncTakenOrderSheet({ reader: fakeSheet(TAKEN_HEADERS, [takenRow("ODID-1")]) });

  // Same cells, so the same hash: nothing but this path can carry it back.
  const outcome = await syncTakenOrderSheet({ reader: full });
  assert.equal(outcome.rowsWithdrawn, 0);

  const back = await db.query.sheetTakenOrderRows.findFirst({
    where: (t, { eq }) => eq(t.lineKey, "ODID-2"),
  });
  assert.equal(back?.status, "present", "a row the sheet has taken back is present again");
});

/* ------------------------------------------------------------------ payments */

test("a second payment sync over an unchanged tab rewrites no row", async () => {
  const reader = fakeSheet(PAY_HEADERS, ["1001", "1002", "1003"].map((n) => payRow(n)));

  const first = await syncPaymentSheet(payOptions(reader));
  assert.equal(first.rowsCreated, 3);

  const before = await tupleVersions("payments");
  assert.equal(before.size, 3);

  const second = await syncPaymentSheet(payOptions(reader));
  assert.equal(second.rowsUnchanged, 3);
  assert.equal(second.rowsWithdrawn, 0);

  assertNoRowRewritten(before, await tupleVersions("payments"));
});

test("a payment row that changed lands, and one that left is withdrawn", async () => {
  await syncPaymentSheet(payOptions(fakeSheet(PAY_HEADERS, [payRow("1001"), payRow("1002")])));
  const before = await tupleVersions("payments");

  const outcome = await syncPaymentSheet(
    payOptions(fakeSheet(PAY_HEADERS, [payRow("1001", "Not Received")])),
  );

  assert.equal(outcome.rowsUpdated, 1);
  assert.equal(outcome.rowsWithdrawn, 1);

  const after = await tupleVersions("payments");
  assert.notEqual(after.get("1001"), before.get("1001"));

  const rows = await db.select().from(sheetPaymentRows);
  assert.equal(rows.find((r) => r.orderNumber === "1002")?.status, "withdrawn");
  assert.equal(rows.find((r) => r.orderNumber === "1001")?.paymentStatus, "Not Received");
});

test("an append payment pass withdraws nothing, whatever it did not read", async () => {
  // The watermark rule: an append has not looked above where it starts, so it
  // cannot conclude anything has gone. The difference this change reads a
  // withdrawal from is only ever the WHOLE tab's, which is why this is here.
  await syncPaymentSheet(payOptions(fakeSheet(PAY_HEADERS, [payRow("1001"), payRow("1002")])));

  const outcome = await syncPaymentSheet({
    ...payOptions(fakeSheet(PAY_HEADERS, [])),
    mode: "append",
  });

  assert.equal(outcome.rowsWithdrawn, 0);
  const rows = await db.select().from(sheetPaymentRows);
  assert.deepEqual(
    rows.map((r) => r.status).sort(),
    ["present", "present"],
    "an append that read nothing must leave every row exactly as it found it",
  );
});
