import "server-only";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { sheetTakenOrderRows } from "@/db/schema";
import {
  listTabs,
  readTab,
  sheetsConfigured,
  type ReadRange,
  type SheetTable,
} from "@/lib/sheets";
import { parseTakenOrderRow, resolveTakenColumns } from "@/lib/taken-order-parse";
import { recomputeOrderSystemHolds } from "@/lib/recompute";
import {
  hashRow,
  newSyncId,
  runSync,
  WRITE_BATCH,
  type SheetReader,
  type SyncOutcome,
} from "./sheet-sync-core";

/* ---------------------------------------------------------------------------
 * The Taken Order tab of the operations workbook.
 *
 * A fourth source, and its own workbook — not a tab on the one the Order
 * Details and Payment Status syncs read. This is where the team types an order
 * the moment the customer gives it, which is hours or days before anything
 * else in MahekOne knows about it.
 *
 * Reconcile only, and for the payment tab's reason rather than the party
 * tab's: a row here exists in order to CHANGE after it is written. `Hold From
 * Office` becomes `Ready` and `Not Done` becomes `Done` days later, in place,
 * on a row created long ago. An append run reads only past the highest row it
 * has seen and would never witness a single release — every customer it ever
 * held would stay held.
 *
 * The whole point of the pass is the last step: what has landed is turned into
 * `customers.activeInOrderSystem`, which is what the calling queue suppresses
 * on. Landing the rows without that would be a table nobody reads.
 * ------------------------------------------------------------------------- */

/** Data starts at row 2: one header row, unlike the party tab's two. */
const FIRST_DATA_ROW = 2;

export const TAKEN_ORDER_SPREADSHEET_ID =
  "1o8Z0zjY_VirRGN_ZVAGu8LUU1L2Q-KXYS07cL_8LhM4";

/**
 * The id is in the code and the credential is not, for the same reason the
 * employee sheet's is: a spreadsheet id names a document, it does not open
 * one. The service account does that, and it stays in the environment.
 * `TAKEN_ORDER_SHEET_ID` is how a staging deploy points at a copy.
 */
export function takenOrderSheetId(): string {
  return process.env.TAKEN_ORDER_SHEET_ID || TAKEN_ORDER_SPREADSHEET_ID;
}

export function takenOrderTabTitle(): string {
  return process.env.TAKEN_ORDER_SHEET_TAB || "Taken Order";
}

export async function syncTakenOrderSheet(options: {
  source?: string;
  mode?: "reconcile" | "reparse";
  triggeredById?: string | null;
  reader?: SheetReader;
} = {}): Promise<SyncOutcome> {
  const source = options.source ?? "taken_order";
  const spreadsheetId = takenOrderSheetId();
  const tabTitle = takenOrderTabTitle();

  if (options.mode === "reparse") {
    return reparseTakenOrders({ source, spreadsheetId, tabTitle, triggeredById: options.triggeredById });
  }

  if (!options.reader && !sheetsConfigured()) {
    throw new Error(
      "Google Sheets is not configured — set GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY.",
    );
  }

  return runSync(
    { source, spreadsheetId, tabTitle, mode: "reconcile", triggeredById: options.triggeredById },
    async (syncId) => {
      const read: SheetReader =
        options.reader ?? ((range: ReadRange) => readTab(spreadsheetId, tabTitle, range));

      const header = await read({ firstRow: 1, lastRow: 1 });
      const columns = resolveTakenColumns(header.headers);

      // Both halves of the release rule have to be findable. Without them
      // every row would parse as open and the entire book would go quiet on
      // the next recompute — the exact failure `0021` had to undo. Refusing is
      // the only safe answer: a sync that cannot tell dispatched from held has
      // nothing useful to say.
      if (!columns.officeStatus || !columns.entryStatus) {
        throw new Error(
          `The "${tabTitle}" tab has neither a Status/Entry status header nor columns L and R ` +
            `to fall back on, so no order can be told from a dispatched one.`,
        );
      }
      if (!columns.lineKey) {
        throw new Error(`The "${tabTitle}" tab has no "Order ID" column to key rows on.`);
      }

      // A1 notation has no open-ended row range, so the grid's own height is
      // the bound. Same call the party sync makes, and the same reason.
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
      let openLines = 0;

      /** Counted per distinct value so a status nobody told us about shows up
       *  in the run report on the day it appears, not only as behaviour. */
      const statusTally = new Map<string, number>();

      const usable = table.rows.filter(
        (r) => (r.cells[columns.lineKey!] ?? "").trim() !== "",
      );
      const skippedNoKey = table.rows.length - usable.length;

      for (let i = 0; i < usable.length; i += WRITE_BATCH) {
        const slice = usable.slice(i, i + WRITE_BATCH);
        const keys = slice.map((r) => (r.cells[columns.lineKey!] ?? "").trim());

        const existing = await db
          .select({ lineKey: sheetTakenOrderRows.lineKey, rowHash: sheetTakenOrderRows.rowHash })
          .from(sheetTakenOrderRows)
          .where(inArray(sheetTakenOrderRows.lineKey, keys));
        const hashByKey = new Map(existing.map((e) => [e.lineKey, e.rowHash]));

        const changed: (typeof sheetTakenOrderRows.$inferInsert)[] = [];
        const untouched: string[] = [];

        for (const row of slice) {
          const parsed = parseTakenOrderRow(row.cells, columns);
          const hash = hashRow(row.cells);
          const known = hashByKey.get(parsed.lineKey);

          // Tallied and counted before the hash short-circuit. These describe
          // the sheet as it stands, not the rows this run happened to write —
          // on a quiet day that would be none of them.
          if (parsed.open) openLines++;
          const label = parsed.officeStatus ?? "(blank)";
          statusTally.set(label, (statusTally.get(label) ?? 0) + 1);

          if (known === hash) {
            unchanged++;
            untouched.push(parsed.lineKey);
            continue;
          }

          if (parsed.issues.length) withIssues++;
          if (known === undefined) created++;
          else updated++;

          changed.push({
            id: newSyncId("tord"),
            syncId,
            rowNumber: row.rowNumber,
            lineKey: parsed.lineKey,
            orderNumber: parsed.orderNumber,
            raw: row.cells,
            rowHash: hash,
            status: "present",
            lastSeenSyncId: syncId,
            orderDate: parsed.orderDate,
            location: parsed.location,
            billingPartyName: parsed.billingPartyName,
            deliveryPartyName: parsed.deliveryPartyName,
            standingInstructions: parsed.standingInstructions,
            area: parsed.area,
            transporterName: parsed.transporterName,
            userName: parsed.userName,
            takenAt: parsed.takenAt,
            transportationCostPaise: parsed.transportationCostPaise,
            remark: parsed.remark,
            partyStatus: parsed.partyStatus,
            description: parsed.description,
            cans: parsed.cans,
            boxes: parsed.boxes,
            ratePaise: parsed.ratePaise,
            discountBp: parsed.discountBp,
            tallyBillNo: parsed.tallyBillNo,
            weightGrams: parsed.weightGrams,
            officeStatus: parsed.officeStatus,
            entryStatus: parsed.entryStatus,
            open: parsed.open,
            issues: parsed.issues,
            updatedAt: new Date(),
          });
        }

        if (changed.length) {
          await db
            .insert(sheetTakenOrderRows)
            .values(changed)
            .onConflictDoUpdate({
              target: sheetTakenOrderRows.lineKey,
              set: upsertColumns(),
            });
        }
        if (untouched.length) {
          await db
            .update(sheetTakenOrderRows)
            .set({ lastSeenSyncId: syncId, status: "present" })
            .where(inArray(sheetTakenOrderRows.lineKey, untouched));
        }
      }

      // A row deleted from the tab is withdrawn, not deleted here — and a
      // withdrawn row holds nobody, because the order it described is no
      // longer one the sheet claims exists.
      const gone = await db
        .update(sheetTakenOrderRows)
        .set({ status: "withdrawn", updatedAt: new Date() })
        .where(
          and(
            ne(sheetTakenOrderRows.lastSeenSyncId, syncId),
            eq(sheetTakenOrderRows.status, "present"),
          ),
        )
        .returning({ id: sheetTakenOrderRows.id });

      /* ------------------------------------------------------------------
       * Turn it into the flag the queue reads.
       *
       * Skipped when the tab came back with nothing usable. Zero rows is
       * indistinguishable from a tab somebody emptied, renamed or broke a
       * permission on, and the recompute would read it as "every order in the
       * company has been dispatched" and release the whole book in one pass.
       * A stale hold is a call not made; a wrongly cleared one is the silent
       * un-muting of every customer at once, which is the same class of
       * accident as the one `0021` cleaned up, in the other direction.
       * ---------------------------------------------------------------- */
      const holds = usable.length
        ? await recomputeOrderSystemHolds()
        : null;

      const statuses = [...statusTally.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => `${value} ${count}`)
        .join(", ");

      const detail =
        `${created} new, ${updated} changed, ${unchanged} unchanged` +
        (gone.length ? `, ${gone.length} gone from the sheet` : "") +
        (skippedNoKey ? `, ${skippedNoKey} rows with no Order ID` : "") +
        (withIssues ? `, ${withIssues} with issues` : "") +
        `; ${openLines} open line${openLines === 1 ? "" : "s"}` +
        (statuses ? ` (status: ${statuses})` : "") +
        (holds
          ? `; ${holds.held} customer${holds.held === 1 ? "" : "s"} held from order calls ` +
            `(${holds.newlyHeld} newly), ${holds.released} released` +
            (holds.unmatched
              ? `, ${holds.unmatched} open part${holds.unmatched === 1 ? "y" : "ies"} matched no customer`
              : "")
          : "; holds NOT recomputed — the tab returned no usable rows");

      return {
        rowsRead: table.rows.length,
        rowsCreated: created,
        rowsUpdated: updated,
        rowsUnchanged: unchanged,
        rowsWithdrawn: gone.length,
        rowsWithIssues: withIssues,
        detail,
      };
    },
  );
}

/**
 * Re-read what is stored and parse it again. Touches Google not at all.
 *
 * The one to run after the READING of a row changes rather than the row, and
 * this import needs it more than the others do. Everything here is hash-driven,
 * so an unchanged sheet costs no writes — which is exactly wrong when what
 * changed is the rule: the day `Cancel` stopped meaning "held" and started
 * meaning "released", not one of those 294 rows differed by a character, every
 * hash matched, and 294 customers stayed muted on the strength of a decision
 * that had already been reversed in the code.
 *
 * A sheet-driven flag whose meaning lives in code needs a way to re-derive
 * itself without waiting for somebody to edit a spreadsheet.
 */
async function reparseTakenOrders(options: {
  source: string;
  spreadsheetId: string;
  tabTitle: string;
  triggeredById?: string | null;
}): Promise<SyncOutcome> {
  return runSync({ ...options, mode: "reparse" }, async (syncId) => {
    const stored = await db
      .select({
        id: sheetTakenOrderRows.id,
        raw: sheetTakenOrderRows.raw,
        open: sheetTakenOrderRows.open,
      })
      .from(sheetTakenOrderRows)
      .where(eq(sheetTakenOrderRows.status, "present"));

    let changed = 0;
    let withIssues = 0;
    let openLines = 0;

    for (const row of stored) {
      // The stored row's own keys, in the sheet's column order — so the L/R
      // fallback still resolves even for a row landed before a rename.
      const parsed = parseTakenOrderRow(row.raw, resolveTakenColumns(Object.keys(row.raw)));
      if (parsed.issues.length) withIssues++;
      if (parsed.open) openLines++;

      await db
        .update(sheetTakenOrderRows)
        .set({
          syncId,
          orderDate: parsed.orderDate,
          location: parsed.location,
          billingPartyName: parsed.billingPartyName,
          deliveryPartyName: parsed.deliveryPartyName,
          standingInstructions: parsed.standingInstructions,
          area: parsed.area,
          transporterName: parsed.transporterName,
          userName: parsed.userName,
          takenAt: parsed.takenAt,
          transportationCostPaise: parsed.transportationCostPaise,
          remark: parsed.remark,
          partyStatus: parsed.partyStatus,
          description: parsed.description,
          cans: parsed.cans,
          boxes: parsed.boxes,
          ratePaise: parsed.ratePaise,
          discountBp: parsed.discountBp,
          tallyBillNo: parsed.tallyBillNo,
          weightGrams: parsed.weightGrams,
          officeStatus: parsed.officeStatus,
          entryStatus: parsed.entryStatus,
          open: parsed.open,
          issues: parsed.issues,
          updatedAt: new Date(),
        })
        .where(eq(sheetTakenOrderRows.id, row.id));

      if (parsed.open !== row.open) changed++;
    }

    const holds = stored.length ? await recomputeOrderSystemHolds() : null;

    const detail =
      `${stored.length} rows re-read, ${changed} changed their open/closed reading` +
      (withIssues ? `, ${withIssues} with issues` : "") +
      `; ${openLines} open line${openLines === 1 ? "" : "s"}` +
      (holds
        ? `; ${holds.held} customer${holds.held === 1 ? "" : "s"} held from order calls ` +
          `(${holds.newlyHeld} newly), ${holds.released} released`
        : "");

    return {
      rowsRead: stored.length,
      rowsCreated: 0,
      rowsUpdated: stored.length,
      rowsUnchanged: 0,
      rowsWithdrawn: 0,
      rowsWithIssues: withIssues,
      detail,
    };
  });
}

function upsertColumns() {
  const set: Record<string, unknown> = {};
  for (const column of [
    "syncId", "rowNumber", "orderNumber", "raw", "rowHash", "status",
    "lastSeenSyncId", "orderDate", "location", "billingPartyName",
    "deliveryPartyName", "standingInstructions", "area", "transporterName",
    "userName", "takenAt", "transportationCostPaise", "remark", "partyStatus",
    "description", "cans", "boxes", "ratePaise", "discountBp", "tallyBillNo",
    "weightGrams", "officeStatus", "entryStatus", "open", "issues", "updatedAt",
  ]) {
    set[column] = sql.raw(`excluded.${column.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`);
  }
  return set;
}
