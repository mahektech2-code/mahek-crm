import "server-only";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { sheetPartyRows, sheetSyncRuns } from "@/db/schema";
import {
  listTabs,
  readTab,
  sheetsConfigured,
  type ReadRange,
  type SheetTable,
} from "@/lib/sheets";
import { PARTY_COL, parsePartyRow, partyNameKey } from "@/lib/sheet-parse";
import {
  hashRow,
  newSyncId,
  WRITE_BATCH,
  type SheetReader,
  type SyncOutcome,
} from "./sheet-sync-core";

/* ---------------------------------------------------------------------------
 * The customer master: the Sales Party tab of the Master workbook.
 *
 * Twelve hundred rows, so no windowing — one call reads the tab and the whole
 * apparatus the order sheet needs for thirty thousand would be ceremony here.
 * The hash still earns its place: this list is edited constantly and re-read
 * often, and a sync that rewrites 1,191 rows to change one is a sync nobody
 * runs frequently enough.
 *
 * Reconcile only. A master list changes IN PLACE — a number corrected, a party
 * marked Deactive, a rep reassigned — and an append run, which reads only past
 * the last row it saw, would never notice any of it.
 * ------------------------------------------------------------------------- */

/** Data starts at row 3: machine names on row 1, human labels on row 2. */
const FIRST_DATA_ROW = 3;

export const PARTY_SPREADSHEET_ID = "1-AYLTA3vYLKmFylkzQxwY4zZLLKuJwkI406YkXvZGSU";

export function partySheetId(): string {
  return process.env.PARTY_SHEET_ID || PARTY_SPREADSHEET_ID;
}

export function partyTabTitle(): string {
  return process.env.PARTY_SHEET_TAB || "Sales Party";
}

export async function syncPartySheet(options: {
  source?: string;
  triggeredById?: string | null;
  reader?: SheetReader;
} = {}): Promise<SyncOutcome> {
  const source = options.source ?? "sales_party";
  const spreadsheetId = partySheetId();
  const tabTitle = partyTabTitle();

  if (!options.reader && !sheetsConfigured()) {
    throw new Error(
      "Google Sheets is not configured — set GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY.",
    );
  }

  const syncId = newSyncId("sync");
  await db.insert(sheetSyncRuns).values({
    id: syncId,
    source,
    spreadsheetId,
    tabTitle,
    mode: "reconcile",
    status: "running",
    triggeredById: options.triggeredById ?? null,
  });

  try {
    const read: SheetReader =
      options.reader ?? ((range: ReadRange) => readTab(spreadsheetId, tabTitle, range));

    // Row 1 is the machine names this parser keys on. Row 2 is the human
    // labels, which are for people reading the spreadsheet and nothing else.
    const header = await read({ firstRow: 1, lastRow: 1 });

    // A1 notation has no open-ended row range — "'Sales Party'!3:" is a parse
    // error, not "everything from row 3". So the grid's own height is asked
    // for and used as the bound. One extra call, and no guessed ceiling that
    // would either truncate the tab or ask for rows that do not exist.
    const lastRow = options.reader
      ? FIRST_DATA_ROW + 100_000
      : (await listTabs(spreadsheetId)).find((t) => t.title === tabTitle)?.rows ??
        FIRST_DATA_ROW;

    const table: SheetTable = await read({
      firstRow: FIRST_DATA_ROW,
      lastRow,
      headers: header.headers,
    });

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let withIssues = 0;
    let skippedNoName = 0;

    const usable = table.rows.filter(
      (r) => (r.cells[PARTY_COL.name] ?? "").trim() !== "",
    );
    skippedNoName = table.rows.length - usable.length;

    for (let i = 0; i < usable.length; i += WRITE_BATCH) {
      const slice = usable.slice(i, i + WRITE_BATCH);
      const keys = slice.map((r) => partyNameKey(r.cells[PARTY_COL.name]));

      const existing = await db
        .select({ partyKey: sheetPartyRows.partyKey, rowHash: sheetPartyRows.rowHash })
        .from(sheetPartyRows)
        .where(inArray(sheetPartyRows.partyKey, keys));
      const hashByKey = new Map(existing.map((e) => [e.partyKey, e.rowHash]));

      const changed: (typeof sheetPartyRows.$inferInsert)[] = [];
      const untouched: string[] = [];

      for (const row of slice) {
        const hash = hashRow(row.cells);
        const key = partyNameKey(row.cells[PARTY_COL.name]);
        const known = hashByKey.get(key);

        if (known === hash) {
          unchanged++;
          untouched.push(key);
          continue;
        }

        const parsed = parsePartyRow(row.cells);
        if (parsed.issues.length) withIssues++;
        if (known === undefined) created++;
        else updated++;

        changed.push({
          id: newSyncId("prty"),
          syncId,
          rowNumber: row.rowNumber,
          partyName: parsed.partyName,
          partyKey: parsed.partyKey,
          raw: row.cells,
          rowHash: hash,
          status: "present",
          lastSeenSyncId: syncId,
          area: parsed.area,
          location: parsed.location,
          state: parsed.state,
          mobileNo: parsed.mobileNo,
          whatsappNo: parsed.whatsappNo,
          email: parsed.email,
          salesPersonName: parsed.salesPersonName,
          backOfficeName: parsed.backOfficeName,
          creditDays: parsed.creditDays,
          gstNumber: parsed.gstNumber,
          grade: parsed.grade,
          monthlyTargetPaise: parsed.monthlyTargetPaise,
          tagPricelist: parsed.tagPricelist,
          segment: parsed.segment,
          counterType: parsed.counterType,
          standingInstructions: parsed.standingInstructions,
          callingInstructions: parsed.callingInstructions,
          transportDetail: parsed.transportDetail,
          paymentType: parsed.paymentType,
          deliveryType: parsed.deliveryType,
          weightType: parsed.weightType,
          partyStatus: parsed.partyStatus,
          companyName: parsed.companyName,
          allocateEmail: parsed.allocateEmail,
          sinceDate: parsed.sinceDate,
          issues: parsed.issues,
          updatedAt: new Date(),
        });
      }

      if (changed.length) {
        await db
          .insert(sheetPartyRows)
          .values(changed)
          .onConflictDoUpdate({ target: sheetPartyRows.partyKey, set: upsertColumns() });
      }
      if (untouched.length) {
        await db
          .update(sheetPartyRows)
          .set({ lastSeenSyncId: syncId, status: "present" })
          .where(inArray(sheetPartyRows.partyKey, untouched));
      }
    }

    const gone = await db
      .update(sheetPartyRows)
      .set({ status: "withdrawn", updatedAt: new Date() })
      .where(
        and(
          ne(sheetPartyRows.lastSeenSyncId, syncId),
          eq(sheetPartyRows.status, "present"),
        ),
      )
      .returning({ id: sheetPartyRows.id });

    const detail =
      `${created} new, ${updated} changed, ${unchanged} unchanged` +
      (gone.length ? `, ${gone.length} gone from the sheet` : "") +
      (skippedNoName ? `, ${skippedNoName} rows with no party name` : "") +
      (withIssues ? `, ${withIssues} with issues` : "");

    await db
      .update(sheetSyncRuns)
      .set({
        status: "ok",
        finishedAt: new Date(),
        rowsRead: table.rows.length,
        rowsCreated: created,
        rowsUpdated: updated,
        rowsUnchanged: unchanged,
        rowsWithdrawn: gone.length,
        rowsWithIssues: withIssues,
      })
      .where(eq(sheetSyncRuns.id, syncId));

    return {
      syncId,
      mode: "reconcile",
      rowsRead: table.rows.length,
      rowsCreated: created,
      rowsUpdated: updated,
      rowsUnchanged: unchanged,
      rowsWithdrawn: gone.length,
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

function upsertColumns() {
  const set: Record<string, unknown> = {};
  for (const column of [
    "syncId", "rowNumber", "partyName", "raw", "rowHash", "status",
    "lastSeenSyncId", "area", "location", "state", "mobileNo", "whatsappNo",
    "email", "salesPersonName", "backOfficeName", "creditDays", "gstNumber",
    "grade", "monthlyTargetPaise", "tagPricelist", "segment", "counterType",
    "standingInstructions", "callingInstructions", "transportDetail",
    "paymentType", "deliveryType", "weightType", "partyStatus", "companyName",
    "allocateEmail", "sinceDate", "issues", "updatedAt",
  ]) {
    set[column] = sql.raw(`excluded.${column.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`);
  }
  return set;
}
