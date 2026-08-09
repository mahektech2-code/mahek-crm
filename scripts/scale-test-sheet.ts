/**
 * Scale test for the order-sheet sync.
 *
 *   npx tsx --conditions=react-server --env-file=.env.local \
 *     scripts/scale-test-sheet.ts [rows]
 *
 * Builds a synthetic tab of N rows from the real sheet's 99 — same headers,
 * same value shapes, unique line keys — and drives the REAL sync against the
 * REAL database through the reader seam. Google is not involved, because the
 * point is to test the batching and the hashing, and putting thirty thousand
 * rows in somebody's spreadsheet to find out whether they hold is not a test,
 * it is a mess to clean up afterwards.
 *
 * It asserts the property the whole design rests on: a second run over
 * unchanged rows writes NOTHING, and a run after editing k rows writes k.
 */
import { readTab } from "../src/lib/sheets";
import { syncOrderSheet, type SheetReader } from "../src/lib/services/sheet-sync-service";
import { db } from "../src/db";
import { sheetOrderRows, sheetSyncRuns } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";

const TARGET = Number(process.argv[2] ?? 3000);
const SOURCE = "scale_test";

type Row = { rowNumber: number; cells: Record<string, string> };

function buildRows(template: Row[], headers: string[], count: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < count; i++) {
    const base = template[i % template.length];
    const cells = { ...base.cells };
    // Unique per line, because it is the idempotency key. Order Number is
    // varied more slowly so multi-line orders survive into the copy.
    cells["Order ID"] = `ODID-SCALE-${String(i).padStart(6, "0")}`;
    cells["Order Number"] = String(90_000 + Math.floor(i / 3));
    out.push({ rowNumber: i + 2, cells });
  }
  void headers;
  return out;
}

/** Serves the synthetic rows through the same windowing the real reader uses. */
function readerFor(rows: Row[], headers: string[]): SheetReader {
  return async (range) => {
    const first = range.firstRow ?? 1;
    const last = range.lastRow ?? Number.MAX_SAFE_INTEGER;

    if (!range.headers) {
      // The header-only probe the sync makes before its first window.
      return { headers, rows: [], rowsInWindow: 0 };
    }
    const slice = rows.filter((r) => r.rowNumber >= first && r.rowNumber <= last);
    return { headers, rows: slice, rowsInWindow: slice.length };
  };
}

const ms = (start: number) => `${(performance.now() - start).toFixed(0)}ms`;

async function count() {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sheetOrderRows)
    .where(eq(sheetOrderRows.syncId, sheetOrderRows.syncId));
  return n;
}

async function main() {
  console.log(`Scale test: ${TARGET.toLocaleString()} rows\n`);

  // Clean slate for this source only.
  await db.delete(sheetOrderRows).where(sql`${sheetOrderRows.lineKey} like 'ODID-SCALE-%'`);
  await db.delete(sheetSyncRuns).where(eq(sheetSyncRuns.source, SOURCE));

  const real = await readTab(
    process.env.ORDERS_SHEET_ID!,
    process.env.ORDERS_SHEET_TAB ?? "Order Details",
  );
  console.log(`template: ${real.rows.length} real rows, ${real.headers.length} columns`);

  const rows = buildRows(real.rows, real.headers, TARGET);
  const opts = {
    source: SOURCE,
    spreadsheetId: "scale-test",
    tabTitle: "Order Details",
    reader: readerFor(rows, real.headers),
  };

  /* -------------------------------------------------- 1. the initial load */
  let t = performance.now();
  const first = await syncOrderSheet({ ...opts, mode: "reconcile" });
  const firstMs = performance.now() - t;
  console.log(
    `\n1. first reconcile      ${ms(t).padStart(8)}  ` +
      `created ${first.rowsCreated}  updated ${first.rowsUpdated}  ` +
      `unchanged ${first.rowsUnchanged}  issues ${first.rowsWithIssues}`,
  );
  console.log(`   ${(TARGET / (firstMs / 1000)).toFixed(0)} rows/sec`);

  /* ------------------------------- 2. re-run unchanged: must write nothing */
  t = performance.now();
  const second = await syncOrderSheet({ ...opts, mode: "reconcile" });
  const secondMs = performance.now() - t;
  console.log(
    `2. re-run, no changes   ${ms(t).padStart(8)}  ` +
      `created ${second.rowsCreated}  updated ${second.rowsUpdated}  ` +
      `unchanged ${second.rowsUnchanged}  withdrawn ${second.rowsWithdrawn}`,
  );
  const clean = second.rowsCreated === 0 && second.rowsUpdated === 0;
  console.log(
    `   ${clean ? "PASS" : "FAIL"} — nothing rewritten; ` +
      `${(firstMs / secondMs).toFixed(1)}x faster than the load`,
  );

  /* ----------------------------------- 3. edit 5 rows: must write only 5 */
  for (let i = 0; i < 5; i++) rows[i * 37].cells["Area"] = `Changed ${i}`;
  t = performance.now();
  const third = await syncOrderSheet({ ...opts, mode: "reconcile" });
  console.log(
    `3. after editing 5 rows ${ms(t).padStart(8)}  ` +
      `created ${third.rowsCreated}  updated ${third.rowsUpdated}  ` +
      `unchanged ${third.rowsUnchanged}`,
  );
  console.log(
    `   ${third.rowsUpdated === 5 && third.rowsCreated === 0 ? "PASS" : "FAIL"}` +
      ` — work proportional to change, not to size`,
  );

  /* ------------------------------------ 4. append: only rows past the mark */
  const appended = buildRows(real.rows, real.headers, TARGET + 200).slice(TARGET);
  appended.forEach((r, i) => {
    r.rowNumber = TARGET + 2 + i;
    r.cells["Order ID"] = `ODID-SCALE-NEW-${String(i).padStart(4, "0")}`;
  });
  const grown = [...rows, ...appended];
  t = performance.now();
  const fourth = await syncOrderSheet({
    ...opts,
    mode: "append",
    reader: readerFor(grown, real.headers),
  });
  console.log(
    `4. append 200 new rows  ${ms(t).padStart(8)}  ` +
      `read ${fourth.rowsRead}  created ${fourth.rowsCreated}  ` +
      `updated ${fourth.rowsUpdated}`,
  );
  console.log(
    `   ${fourth.rowsRead === 200 && fourth.rowsCreated === 200 ? "PASS" : "FAIL"}` +
      ` — read 200 of ${grown.length.toLocaleString()}, not the whole sheet`,
  );

  /* --------------------------------------- 5. reparse: no Google at all */
  t = performance.now();
  const fifth = await syncOrderSheet({ ...opts, mode: "reparse" });
  console.log(
    `5. reparse (no network) ${ms(t).padStart(8)}  ` +
      `reparsed ${fifth.rowsUpdated}  issues ${fifth.rowsWithIssues}`,
  );

  /* ------------------------------------------------------------ 6. reads */
  t = performance.now();
  const page = await db
    .select({
      id: sheetOrderRows.id,
      orderNumber: sheetOrderRows.orderNumber,
      orderDate: sheetOrderRows.orderDate,
      billingPartyName: sheetOrderRows.billingPartyName,
      finalAmountPaise: sheetOrderRows.finalAmountPaise,
    })
    .from(sheetOrderRows)
    .orderBy(sheetOrderRows.orderDate, sheetOrderRows.id)
    .limit(50);
  console.log(
    `\n6. admin page (50 rows, no raw column)  ${ms(t)}  -> ${page.length} rows`,
  );

  const total = await count();
  console.log(`\ntotal rows in sheet_order_rows: ${total.toLocaleString()}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
