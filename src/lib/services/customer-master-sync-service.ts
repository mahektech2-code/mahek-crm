import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { sheetCustomerMasterRows, sheetSyncRuns } from "@/db/schema";
import { readTab, sheetsConfigured } from "@/lib/sheets";
import {
  flagSharedMobiles,
  parseCustomerMasterRow,
  type ParsedCustomerMasterRow,
} from "@/lib/customer-master-parse";
import {
  hashRow,
  newSyncId,
  readWindows,
  runSync,
  WRITE_BATCH,
  type SheetReader,
  type SyncCounts,
} from "./sheet-sync-core";

/* ---------------------------------------------------------------------------
 * Pulling the `Customer Details` tab of a defunct prior system ("Mahek EMP
 * 2.0") into `sheet_customer_master_rows`.
 *
 * The same workbook the Activity tab already syncs from, so it needs no new
 * credential and no new share — `mahekone@mahekone.iam.gserviceaccount.com`
 * has held Viewer on it since 2026-09-01.
 *
 * RECONCILE ONLY, which is the employee master's shape rather than the order
 * sheet's three modes. Five thousand rows is one API window and one hash
 * compare; an append pass would save a read that costs nothing while missing
 * the only edits that matter here — a number corrected, a shop deactivated,
 * a row deleted. A tab that has not changed costs a read and zero writes.
 *
 * Nothing in this file writes a `customers` row. Landing and publishing are
 * two passes on purpose: the projection reads this table and never writes to
 * it, so what the spreadsheet actually said stays derivable however badly the
 * published side is later mangled — the lesson the order sheet's assumed
 * receipts taught, and the reason `revert-sheet-paid` was possible at all.
 * ------------------------------------------------------------------------- */

export const CUSTOMER_MASTER_SOURCE = "customer_master";
export const CUSTOMER_MASTER_TAB = "Customer Details";
/** The same workbook as the Activity tab — see `fieldActivitySheetId`. */
export const CUSTOMER_MASTER_SPREADSHEET_ID = "1lo03cZH6LFAr5lWYm-U1wEzh9MvNqZT9R4ZBU_Vqfi4";

export function customerMasterSheetId(): string {
  return process.env.FIELD_ACTIVITY_SHEET_ID || CUSTOMER_MASTER_SPREADSHEET_ID;
}

/** Header is row 1; data starts at row 2. */
const FIRST_DATA_ROW = 2;

export type CustomerMasterSyncOptions = {
  spreadsheetId?: string;
  tabTitle?: string;
  triggeredById?: string | null;
  reader?: SheetReader;
};

type Landed = {
  parsed: ParsedCustomerMasterRow;
  rowNumber: number;
  cells: Record<string, string>;
  hash: string;
};

export async function syncCustomerMasterSheet(options: CustomerMasterSyncOptions = {}) {
  const spreadsheetId = options.spreadsheetId ?? customerMasterSheetId();
  const tabTitle = options.tabTitle ?? CUSTOMER_MASTER_TAB;

  if (!options.reader && !sheetsConfigured()) {
    throw new Error(
      "Google Sheets is not configured — set GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY.",
    );
  }

  const read: SheetReader =
    options.reader ?? ((range) => readTab(spreadsheetId, tabTitle, range));

  return runSync(
    {
      source: CUSTOMER_MASTER_SOURCE,
      spreadsheetId,
      tabTitle,
      mode: "reconcile",
      triggeredById: options.triggeredById ?? null,
    },
    (syncId) => land(syncId, read),
  );
}

async function land(syncId: string, read: SheetReader): Promise<SyncCounts> {
  /*
   * The whole tab is read into memory before anything is written, which the
   * order sheet deliberately does not do. Two reasons it is right here and
   * wrong there: five thousand rows is megabytes rather than hundreds of
   * them, and the placeholder-number check is a fact about the WHOLE sheet
   * that no single row can see — a number is only a placeholder because 952
   * other rows carry it too.
   */
  const landed: Landed[] = [];
  const seenKeys = new Map<string, number>();
  const duplicateNames: string[] = [];
  let highestRow = 1;

  for await (const window of readWindows(read, FIRST_DATA_ROW, FIRST_DATA_ROW)) {
    for (const row of window.rows) {
      highestRow = Math.max(highestRow, row.rowNumber);
      const parsed = parseCustomerMasterRow(row.cells);
      if (!parsed) continue;

      // The tab has no id column, so the normalised name IS the key. A repeat
      // is reported rather than resolved by keeping whichever row was read
      // last — 32 of these exist, and which one is right is not code's call.
      const already = seenKeys.get(parsed.nameKey);
      if (already !== undefined) {
        duplicateNames.push(`${parsed.customerName} (rows ${already} and ${row.rowNumber})`);
        continue;
      }
      seenKeys.set(parsed.nameKey, row.rowNumber);

      landed.push({
        parsed,
        rowNumber: row.rowNumber,
        cells: row.cells,
        hash: hashRow(row.cells),
      });
    }
  }

  // A number on three or more shops is not a shop's number. Detected here
  // rather than listed in code: the next export will use a different one.
  const shared = flagSharedMobiles(
    landed.map((l) => ({ nameKey: l.parsed.nameKey, mobile: l.parsed.mobile })),
  );
  for (const l of landed) {
    const count = l.parsed.mobile ? shared.get(l.parsed.mobile) : undefined;
    if (!count) continue;
    l.parsed.issues.push({
      column: "Mobile Number",
      value: l.parsed.mobile ?? "",
      problem: `shared with ${count - 1} other shops — a placeholder, not this shop's number`,
      kind: "contradiction",
    });
  }

  const existing = await db
    .select({
      nameKey: sheetCustomerMasterRows.nameKey,
      rowHash: sheetCustomerMasterRows.rowHash,
    })
    .from(sheetCustomerMasterRows);
  const hashByKey = new Map(existing.map((e) => [e.nameKey, e.rowHash]));

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let withIssues = 0;

  const values = landed.map((l) => {
    const known = hashByKey.get(l.parsed.nameKey);
    if (known === undefined) created++;
    else if (known === l.hash) unchanged++;
    else updated++;
    if (l.parsed.issues.length) withIssues++;

    return {
      id: newSyncId("cmr"),
      syncId,
      rowNumber: l.rowNumber,
      raw: l.cells,
      rowHash: l.hash,
      status: "present" as const,
      lastSeenSyncId: syncId,
      customerName: l.parsed.customerName,
      nameKey: l.parsed.nameKey,
      mobileRaw: l.parsed.mobileRaw,
      mobile: l.parsed.mobile,
      altMobile: l.parsed.altMobile,
      address: l.parsed.address,
      locationText: l.parsed.locationText,
      state: l.parsed.state,
      rating: l.parsed.rating,
      segmentation: l.parsed.segmentation,
      specialInstructions: l.parsed.specialInstructions,
      salesPersonName: l.parsed.salesPersonName,
      tagEmployeeName: l.parsed.tagEmployeeName,
      backOfficeName: l.parsed.backOfficeName,
      sheetStatus: l.parsed.sheetStatus,
      deactivationRequest: l.parsed.deactivationRequest,
      deactivationRemark: l.parsed.deactivationRemark,
      issues: l.parsed.issues,
      updatedAt: new Date(),
    };
  });

  for (let i = 0; i < values.length; i += WRITE_BATCH) {
    await db
      .insert(sheetCustomerMasterRows)
      .values(values.slice(i, i + WRITE_BATCH))
      .onConflictDoUpdate({
        target: sheetCustomerMasterRows.nameKey,
        set: {
          // Everything the sheet states is restated. What is NOT here is
          // deliberate: `matchedCustomerId`, `resolvedKind`, `resolvedStatus`,
          // `evidence` and the two `projected*` columns belong to the
          // projection, and a re-read of an unchanged row must not undo a
          // decision it already published.
          syncId: sql`excluded.sync_id`,
          rowNumber: sql`excluded.row_number`,
          raw: sql`excluded.raw`,
          rowHash: sql`excluded.row_hash`,
          status: sql`excluded.status`,
          lastSeenSyncId: sql`excluded.last_seen_sync_id`,
          customerName: sql`excluded.customer_name`,
          mobileRaw: sql`excluded.mobile_raw`,
          mobile: sql`excluded.mobile`,
          altMobile: sql`excluded.alt_mobile`,
          address: sql`excluded.address`,
          locationText: sql`excluded.location_text`,
          state: sql`excluded.state`,
          rating: sql`excluded.rating`,
          segmentation: sql`excluded.segmentation`,
          specialInstructions: sql`excluded.special_instructions`,
          salesPersonName: sql`excluded.sales_person_name`,
          tagEmployeeName: sql`excluded.tag_employee_name`,
          backOfficeName: sql`excluded.back_office_name`,
          sheetStatus: sql`excluded.sheet_status`,
          deactivationRequest: sql`excluded.deactivation_request`,
          deactivationRemark: sql`excluded.deactivation_remark`,
          issues: sql`excluded.issues`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  /*
   * A row that has left the sheet is marked, never deleted — the same rule the
   * employee master follows, and for the same reason: somebody tidying a shop
   * off a tab is not asking for the customer it produced to be erased. The
   * projection reads `status` and stops restating a withdrawn row.
   */
  const withdrawn = landed.length
    ? await db
        .update(sheetCustomerMasterRows)
        .set({ status: "withdrawn", updatedAt: new Date() })
        .where(
          and(
            ne(sheetCustomerMasterRows.status, "withdrawn"),
            // Not a NOT IN over five thousand names: every row this pass saw
            // carries the run's own id, so anything still holding an older one
            // is exactly what the sheet no longer has.
            ne(sheetCustomerMasterRows.lastSeenSyncId, syncId),
          ),
        )
        .returning({ id: sheetCustomerMasterRows.id })
    : [];

  await db
    .update(sheetSyncRuns)
    .set({ highestRow })
    .where(eq(sheetSyncRuns.id, syncId));

  const detailParts = [
    `${landed.length} shops`,
    `${values.filter((v) => v.mobile).length} with a mobile`,
    `${shared.size} placeholder numbers`,
  ];
  if (duplicateNames.length) detailParts.push(`${duplicateNames.length} duplicate names skipped`);

  return {
    rowsRead: landed.length + duplicateNames.length,
    rowsCreated: created,
    rowsUpdated: updated,
    rowsUnchanged: unchanged,
    rowsWithdrawn: withdrawn.length,
    rowsWithIssues: withIssues,
    detail: detailParts.join(", "),
  };
}
