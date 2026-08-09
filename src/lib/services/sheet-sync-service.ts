import "server-only";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { sheetOrderRows, sheetPaymentRows, sheetSyncRuns } from "@/db/schema";
import { readTab, sheetsConfigured, type SheetTable } from "@/lib/sheets";
import { PAY_COL, parseOrderRow, parsePaymentRow } from "@/lib/sheet-parse";
import {
  hashRow,
  newSyncId,
  readWindows,
  runSync,
  watermark,
  WRITE_BATCH,
  type SheetReader,
  type SyncCounts,
  type SyncMode,
  type SyncOutcome,
} from "./sheet-sync-core";

/**
 * The order workbook.
 *
 * Hardcoded, and deliberately: a spreadsheet id NAMES a document, it does not
 * grant access to one. What opens it is the service account credential, which
 * is configuration and stays configuration. Naming the document here means
 * production reads the same workbook as a developer's machine without anybody
 * having to remember to set a variable — and a deploy where nobody did reads
 * as a broken feature rather than a missing setting.
 *
 * `ORDERS_SHEET_ID` still wins where it is set, so a staging deploy can be
 * pointed at a copy without touching this file.
 *
 * Note this is NOT the workbook HRMS reads. Only the older one carries an
 * `Employee Details` tab, and only this one carries current orders — two
 * documents, deliberately, and neither is a fallback for the other.
 */
export const ORDERS_SPREADSHEET_ID = "1YjLquBct-cv27ugjtXM3RgyLiDaAXx-224myOjsNMdM";

export function orderSheetId(): string {
  return process.env.ORDERS_SHEET_ID || ORDERS_SPREADSHEET_ID;
}

/** The tab carrying one row per order LINE. */
export function orderTabTitle(): string {
  return process.env.ORDERS_SHEET_TAB || "Order Details";
}

/** The tab carrying one row per order, with what was billed and received. */
export function paymentTabTitle(): string {
  return process.env.PAYMENTS_SHEET_TAB || "Payment Status";
}

/* ---------------------------------------------------------------------------
 * Pulling the order sheet into MahekOne, at the size it actually is.
 *
 * The sheet is expected to reach 20–30,000 rows, which rules out the obvious
 * implementation. Three things make it hold:
 *
 *  1. THE READ IS RANGED. A tab is fetched in row windows, not in one call, so
 *     peak memory is a window rather than the sheet and a slow response cannot
 *     take the whole sync with it.
 *
 *  2. THE WRITE IS HASH-DRIVEN. Each row carries the SHA-256 of its raw cells.
 *     A nightly reconcile over 30,000 rows where nothing changed performs zero
 *     writes. Work is proportional to change, not to size — which is the only
 *     property that makes a frequent schedule affordable.
 *
 *  3. IT RESUMES. The cursor is stored on the run, so a sync that dies at row
 *     24,000 continues rather than restarting. At this size a restart-on-fail
 *     design never finishes on a bad day.
 *
 * And the cheapest mode reads nothing at all: `reparse` re-runs the parser
 * over stored raw rows. Fixing a parsing rule tomorrow costs one local pass,
 * no API quota, and no dependency on the sheet still saying what it said.
 *
 * The machinery those three points describe is shared with the employee
 * import and lives in `sheet-sync-core.ts`. What stays here is what an order
 * LINE means.
 * ------------------------------------------------------------------------- */

const newId = newSyncId;

export type { SyncMode, SyncOutcome, SheetReader };

export type SyncOptions = {
  source: string;
  spreadsheetId: string;
  tabTitle: string;
  mode: SyncMode;
  triggeredById?: string | null;
  reader?: SheetReader;
};

export async function syncOrderSheet(options: SyncOptions): Promise<SyncOutcome> {
  const { source, spreadsheetId, tabTitle, mode } = options;

  if (mode !== "reparse" && !options.reader && !sheetsConfigured()) {
    // Deliberately not an empty success. A sync that reports zero rows and a
    // sync that never authenticated look identical on a screen, and only one
    // of them means the sheet is empty.
    throw new Error(
      "Google Sheets is not configured — set GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY.",
    );
  }

  return runSync(
    { source, spreadsheetId, tabTitle, mode, triggeredById: options.triggeredById },
    (syncId) =>
      mode === "reparse"
        ? reparseStored(syncId, source)
        : pullFromSheet(syncId, options),
  );
}

async function pullFromSheet(
  syncId: string,
  { source, spreadsheetId, tabTitle, mode, reader }: SyncOptions,
): Promise<SyncCounts> {
  const read: SheetReader =
    reader ?? ((range) => readTab(spreadsheetId, tabTitle, range));
  const startRow = mode === "append" ? await watermark(source) + 1 : 2;

  let rowsRead = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let withIssues = 0;
  let highestRow = Math.max(startRow - 1, 1);

  for await (const window of readWindows(read, startRow)) {
    rowsRead += window.rows.length;
    for (const row of window.rows) highestRow = Math.max(highestRow, row.rowNumber);

    const result = await writeWindow(syncId, window);
    created += result.created;
    updated += result.updated;
    unchanged += result.unchanged;
    withIssues += result.withIssues;

    // Checkpoint after every window rather than at the end, so a failure at
    // row 24,000 costs one window and not the whole run.
    await db
      .update(sheetSyncRuns)
      .set({ cursorRow: highestRow, rowsRead, highestRow })
      .where(eq(sheetSyncRuns.id, syncId));
  }

  // An append that found nothing still knows how far it looked, and the
  // checkpoint above only runs when there was a window to write. Without this
  // the run records the default watermark, the next append reads it and starts
  // from the top again — free in writes, because the hashes catch everything,
  // but every quarter of an hour it would re-read the entire sheet to discover
  // that nothing had changed.
  await db
    .update(sheetSyncRuns)
    .set({ rowsRead, highestRow })
    .where(eq(sheetSyncRuns.id, syncId));

  // Only a full read can conclude that a row has gone. An append run has not
  // looked at the rows above its watermark and must never mark them missing.
  let withdrawn = 0;
  if (mode === "reconcile") {
    const result = await db
      .update(sheetOrderRows)
      .set({ status: "withdrawn", updatedAt: new Date() })
      .where(
        and(
          ne(sheetOrderRows.lastSeenSyncId, syncId),
          eq(sheetOrderRows.status, "present"),
        ),
      )
      .returning({ id: sheetOrderRows.id });
    withdrawn = result.length;
  }

  const detail =
    `${mode} from row ${startRow}: ${created} new, ${updated} changed, ` +
    `${unchanged} unchanged` +
    (withdrawn ? `, ${withdrawn} gone from the sheet` : "") +
    (withIssues ? `, ${withIssues} with issues` : "");

  return {
    rowsRead,
    rowsCreated: created,
    rowsUpdated: updated,
    rowsUnchanged: unchanged,
    rowsWithdrawn: withdrawn,
    rowsWithIssues: withIssues,
    detail,
  };
}

async function writeWindow(syncId: string, window: SheetTable) {
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let withIssues = 0;

  const candidates = window.rows
    .map((row) => ({ row, hash: hashRow(row.cells) }))
    .filter(({ row }) => (row.cells["Order ID"] ?? "").trim() !== "");

  // Rows with no line key cannot be matched on a re-import, so they are held
  // under a key derived from the sheet position instead of being dropped.
  const keyed = window.rows
    .filter((row) => (row.cells["Order ID"] ?? "").trim() === "")
    .map((row) => ({ row, hash: hashRow(row.cells) }));

  for (let i = 0; i < candidates.length + keyed.length; i += WRITE_BATCH) {
    const slice = [...candidates, ...keyed].slice(i, i + WRITE_BATCH);
    if (!slice.length) continue;

    const keys = slice.map(({ row }) =>
      (row.cells["Order ID"] ?? "").trim() || `row:${row.rowNumber}`,
    );

    // One read to find out which rows actually changed. This is what keeps a
    // nightly reconcile cheap: the rows that match are touched no further.
    const existing = await db
      .select({
        lineKey: sheetOrderRows.lineKey,
        rowHash: sheetOrderRows.rowHash,
      })
      .from(sheetOrderRows)
      .where(inArray(sheetOrderRows.lineKey, keys));

    const hashByKey = new Map(existing.map((e) => [e.lineKey, e.rowHash]));

    const changed: (typeof sheetOrderRows.$inferInsert)[] = [];
    const untouched: string[] = [];

    for (const { row, hash } of slice) {
      const lineKey = (row.cells["Order ID"] ?? "").trim() || `row:${row.rowNumber}`;
      const known = hashByKey.get(lineKey);

      if (known === hash) {
        unchanged++;
        untouched.push(lineKey);
        continue;
      }

      const parsed = parseOrderRow(row.cells);
      if (parsed.issues.length) withIssues++;
      if (known === undefined) created++;
      else updated++;

      changed.push({
        id: newId("srow"),
        syncId,
        rowNumber: row.rowNumber,
        lineKey,
        orderNumber: parsed.orderNumber,
        raw: row.cells,
        rowHash: hash,
        status: "present",
        lastSeenSyncId: syncId,
        orderDate: parsed.orderDate,
        dispatchDate: parsed.dispatchDate,
        paymentReceivedDate: parsed.paymentReceivedDate,
        billingPartyName: parsed.billingPartyName,
        area: parsed.area,
        transportName: parsed.transportName,
        paymentType: parsed.paymentType,
        paymentStatus: parsed.paymentStatus,
        segmentCounterType: parsed.segmentCounterType,
        salesMan: parsed.salesMan,
        creditDays: parsed.creditDays,
        orderFulfillDays: parsed.orderFulfillDays,
        gstBp: parsed.gstBp,
        description: parsed.description,
        packType: parsed.packType,
        cans: parsed.cans,
        volumeMl: parsed.volumeMl,
        ratePaise: parsed.ratePaise,
        amountPaise: parsed.amountPaise,
        finalAmountPaise: parsed.finalAmountPaise,
        discountBp: parsed.discountBp,
        tallyBillNo: parsed.tallyBillNo,
        issues: parsed.issues,
        updatedAt: new Date(),
      });
    }

    if (changed.length) {
      await db
        .insert(sheetOrderRows)
        .values(changed)
        .onConflictDoUpdate({
          target: sheetOrderRows.lineKey,
          set: upsertColumns(),
        });
    }

    // Unchanged rows still need their "seen" stamp, or the reconcile pass
    // would conclude every one of them had vanished from the sheet. One
    // statement for the batch, and it writes a single column.
    if (untouched.length) {
      await db
        .update(sheetOrderRows)
        .set({ lastSeenSyncId: syncId, status: "present" })
        .where(inArray(sheetOrderRows.lineKey, untouched));
    }
  }

  return { created, updated, unchanged, withIssues };
}

/**
 * The columns an upsert overwrites.
 *
 * Not `id` and not `createdAt` — a row that already exists keeps its identity
 * across re-imports, because things elsewhere may already point at it.
 *
 * Not the resolved matches either. `matchedProductId` is somebody's decision
 * about an ambiguous name, and a re-import must not undo it: the catalogue
 * import here already works this way, and for the same reason.
 */
function upsertColumns() {
  const set: Record<string, unknown> = {};
  for (const column of [
    "syncId", "rowNumber", "orderNumber", "raw", "rowHash", "status",
    "lastSeenSyncId", "orderDate", "dispatchDate", "paymentReceivedDate",
    "billingPartyName", "area", "transportName", "paymentType", "paymentStatus",
    "segmentCounterType", "salesMan", "creditDays", "orderFulfillDays", "gstBp",
    "description", "packType", "cans", "volumeMl", "ratePaise", "amountPaise",
    "finalAmountPaise", "discountBp", "tallyBillNo", "issues", "updatedAt",
  ]) {
    set[column] = sql.raw(`excluded.${toSnake(column)}`);
  }
  return set;
}

const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Re-run the parser over rows already stored. Touches Google not at all.
 *
 * This is the mode that makes a wrong parsing rule cheap to fix: the raw cells
 * are already here, so correcting how a column is read costs one pass over the
 * database rather than a re-import, an API quota, and the sheet still saying
 * what it said this morning.
 */
async function reparseStored(syncId: string, source: string): Promise<SyncCounts> {
  let updated = 0;
  let withIssues = 0;
  let read = 0;
  let after = "";

  for (;;) {
    // Keyset pagination, not OFFSET: at 30,000 rows an offset scan re-reads
    // everything it has already skipped, so the last page costs the most.
    const page = await db
      .select({
        id: sheetOrderRows.id,
        lineKey: sheetOrderRows.lineKey,
        raw: sheetOrderRows.raw,
      })
      .from(sheetOrderRows)
      .where(after ? sql`${sheetOrderRows.id} > ${after}` : undefined)
      .orderBy(sheetOrderRows.id)
      .limit(WRITE_BATCH);

    if (!page.length) break;
    read += page.length;
    after = page[page.length - 1].id;

    for (const row of page) {
      const parsed = parseOrderRow(row.raw);
      if (parsed.issues.length) withIssues++;
      updated++;

      await db
        .update(sheetOrderRows)
        .set({
          orderNumber: parsed.orderNumber,
          orderDate: parsed.orderDate,
          dispatchDate: parsed.dispatchDate,
          paymentReceivedDate: parsed.paymentReceivedDate,
          billingPartyName: parsed.billingPartyName,
          area: parsed.area,
          transportName: parsed.transportName,
          paymentType: parsed.paymentType,
          paymentStatus: parsed.paymentStatus,
          segmentCounterType: parsed.segmentCounterType,
          salesMan: parsed.salesMan,
          creditDays: parsed.creditDays,
          orderFulfillDays: parsed.orderFulfillDays,
          gstBp: parsed.gstBp,
          description: parsed.description,
          packType: parsed.packType,
          cans: parsed.cans,
          volumeMl: parsed.volumeMl,
          ratePaise: parsed.ratePaise,
          amountPaise: parsed.amountPaise,
          finalAmountPaise: parsed.finalAmountPaise,
          discountBp: parsed.discountBp,
          tallyBillNo: parsed.tallyBillNo,
          issues: parsed.issues,
          updatedAt: new Date(),
        })
        .where(eq(sheetOrderRows.id, row.id));
    }
  }

  return {
    rowsRead: read,
    rowsCreated: 0,
    rowsUpdated: updated,
    rowsUnchanged: 0,
    rowsWithdrawn: 0,
    rowsWithIssues: withIssues,
    detail: `reparsed ${updated} stored rows for ${source}, ${withIssues} with issues`,
  };
}

/* ------------------------------------------------- the Payment Status tab */

/**
 * Same machinery, second tab.
 *
 * Windowed read, hash-skip, batched upsert and the withdrawn sweep all behave
 * exactly as they do for the order tab — the only differences are the grain
 * (one row per order) and the key (Order Number). Rows carrying no order
 * number are skipped rather than stored: on this tab they are spacer rows, and
 * unlike the order tab there is no second identifier to hold them by.
 */
export async function syncPaymentSheet(options: SyncOptions): Promise<SyncOutcome> {
  const { source, spreadsheetId, tabTitle, mode } = options;

  if (mode !== "reparse" && !options.reader && !sheetsConfigured()) {
    throw new Error(
      "Google Sheets is not configured — set GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY.",
    );
  }

  const syncId = newId("sync");
  await db.insert(sheetSyncRuns).values({
    id: syncId,
    source,
    spreadsheetId,
    tabTitle,
    mode,
    status: "running",
    triggeredById: options.triggeredById ?? null,
  });

  try {
    const read: SheetReader =
      options.reader ?? ((range) => readTab(spreadsheetId, tabTitle, range));

    let rowsRead = 0;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let withIssues = 0;
    let skippedNoOrder = 0;
    let highestRow = 1;

    const startRow = mode === "append" ? (await watermark(source)) + 1 : 2;

    for await (const window of readWindows(read, startRow)) {
      rowsRead += window.rows.length;
      for (const row of window.rows) highestRow = Math.max(highestRow, row.rowNumber);

      const usable = window.rows.filter(
        (r) => (r.cells[PAY_COL.orderNumber] ?? "").trim() !== "",
      );
      skippedNoOrder += window.rows.length - usable.length;

      for (let i = 0; i < usable.length; i += WRITE_BATCH) {
        const slice = usable.slice(i, i + WRITE_BATCH);
        const keys = slice.map((r) => r.cells[PAY_COL.orderNumber].trim());

        const existing = await db
          .select({
            orderNumber: sheetPaymentRows.orderNumber,
            rowHash: sheetPaymentRows.rowHash,
          })
          .from(sheetPaymentRows)
          .where(inArray(sheetPaymentRows.orderNumber, keys));
        const hashByKey = new Map(existing.map((e) => [e.orderNumber, e.rowHash]));

        const changed: (typeof sheetPaymentRows.$inferInsert)[] = [];
        const untouched: string[] = [];

        for (const row of slice) {
          const orderNumber = row.cells[PAY_COL.orderNumber].trim();
          const hash = hashRow(row.cells);
          const known = hashByKey.get(orderNumber);

          if (known === hash) {
            unchanged++;
            untouched.push(orderNumber);
            continue;
          }

          const parsed = parsePaymentRow(row.cells);
          if (parsed.issues.length) withIssues++;
          if (known === undefined) created++;
          else updated++;

          changed.push({
            id: newId("prow"),
            syncId,
            rowNumber: row.rowNumber,
            orderNumber,
            raw: row.cells,
            rowHash: hash,
            status: "present",
            lastSeenSyncId: syncId,
            billingPartyName: parsed.billingPartyName,
            tallyBillNo: parsed.tallyBillNo,
            dispatchDate: parsed.dispatchDate,
            billAmountPaise: parsed.billAmountPaise,
            dueDate: parsed.dueDate,
            paymentStatus: parsed.paymentStatus,
            paymentReceivedDate: parsed.paymentReceivedDate,
            messageDate: parsed.messageDate,
            nextMessageDate: parsed.nextMessageDate,
            backOffice: parsed.backOffice,
            issues: parsed.issues,
            updatedAt: new Date(),
          });
        }

        if (changed.length) {
          await db
            .insert(sheetPaymentRows)
            .values(changed)
            .onConflictDoUpdate({
              target: sheetPaymentRows.orderNumber,
              set: paymentUpsertColumns(),
            });
        }
        if (untouched.length) {
          await db
            .update(sheetPaymentRows)
            .set({ lastSeenSyncId: syncId, status: "present" })
            .where(inArray(sheetPaymentRows.orderNumber, untouched));
        }
      }

      await db
        .update(sheetSyncRuns)
        .set({ cursorRow: highestRow, rowsRead, highestRow })
        .where(eq(sheetSyncRuns.id, syncId));
    }

    let withdrawn = 0;
    if (mode === "reconcile") {
      const gone = await db
        .update(sheetPaymentRows)
        .set({ status: "withdrawn", updatedAt: new Date() })
        .where(
          and(
            ne(sheetPaymentRows.lastSeenSyncId, syncId),
            eq(sheetPaymentRows.status, "present"),
          ),
        )
        .returning({ id: sheetPaymentRows.id });
      withdrawn = gone.length;
    }

    const detail =
      `${mode}: ${created} new, ${updated} changed, ${unchanged} unchanged` +
      (withdrawn ? `, ${withdrawn} gone` : "") +
      (skippedNoOrder ? `, ${skippedNoOrder} rows with no order number` : "") +
      (withIssues ? `, ${withIssues} with issues` : "");

    await db
      .update(sheetSyncRuns)
      .set({
        status: "ok",
        finishedAt: new Date(),
        rowsRead,
        rowsCreated: created,
        rowsUpdated: updated,
        rowsUnchanged: unchanged,
        rowsWithdrawn: withdrawn,
        rowsWithIssues: withIssues,
        cursorRow: null,
      })
      .where(eq(sheetSyncRuns.id, syncId));

    return {
      syncId,
      mode,
      rowsRead,
      rowsCreated: created,
      rowsUpdated: updated,
      rowsUnchanged: unchanged,
      rowsWithdrawn: withdrawn,
      rowsWithIssues: withIssues,
      detail,
    };
  } catch (error) {
    await db
      .update(sheetSyncRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      })
      .where(eq(sheetSyncRuns.id, syncId));
    throw error;
  }
}

function paymentUpsertColumns() {
  const set: Record<string, unknown> = {};
  for (const column of [
    "syncId", "rowNumber", "raw", "rowHash", "status", "lastSeenSyncId",
    "billingPartyName", "tallyBillNo", "dispatchDate", "billAmountPaise",
    "dueDate", "paymentStatus", "paymentReceivedDate", "messageDate",
    "nextMessageDate", "backOffice", "issues", "updatedAt",
  ]) {
    set[column] = sql.raw(`excluded.${toSnake(column)}`);
  }
  return set;
}
