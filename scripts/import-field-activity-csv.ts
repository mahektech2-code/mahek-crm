/**
 * Import the field-activity backfill from a local CSV export, before the
 * live Google Sheet is reachable.
 *
 *   npm run jobs:field-activity-csv -- "/path/to/Mahek EMP 2.0 - Performance - Activity.csv"
 *   npm run jobs:field-activity-csv -- "/path/to/export.csv" --project
 *
 * Shares every line of parsing, matching and staging with the eventual live
 * sheet sync — the sync service takes any `reader` matching `SheetReader`'s
 * shape, and this is a CSV-backed one. Once the live sheet is reachable,
 * `npm run jobs -- field-activity-sync` reads it directly and reconciles
 * against whatever this run already staged, picking up just the diff.
 *
 * `--project` runs the timeline projection immediately afterwards. Left
 * optional rather than automatic — the ordinary path is to look at the sync
 * summary (how many customer names matched, how many are still ambiguous)
 * before deciding a batch is ready to reach a customer's shared timeline and
 * a salesman's phone.
 */
import { readFileSync } from "node:fs";
import { parseCsv } from "../src/lib/csv";
import type { ReadRange, SheetTable } from "../src/lib/sheets";
import { fieldActivitySheetId, syncFieldActivitySheet } from "../src/lib/services/field-activity-sync-service";
import { projectFieldActivityTimeline } from "../src/lib/services/field-activity-projection-service";

function csvReader(path: string) {
  const text = readFileSync(path, "utf-8");
  const records = parseCsv(text);
  const headers = records.length ? Object.keys(records[0]) : [];

  return async (range: ReadRange): Promise<SheetTable> => {
    if (!range.headers) {
      // The header-only probe `readWindows` makes before the first window.
      return { headers, rows: [], rowsInWindow: 1 };
    }

    const firstRow = range.firstRow ?? 2;
    const lastRow = range.lastRow ?? records.length + 1;
    // Row 1 is the header; record[0] is sheet row 2, record[i] is row i+2 —
    // `parseCsv` already dropped the header and any fully-blank line, so a
    // row number here can differ slightly from the live sheet's once a
    // blank line is involved. Fine for a one-time backfill: `Activity ID`,
    // not the row number, is what a re-import is keyed on.
    const startIdx = Math.max(firstRow - 2, 0);
    const endIdx = Math.min(lastRow - 2, records.length - 1);
    const rowsInWindow = Math.max(0, endIdx - startIdx + 1);

    const rows: SheetTable["rows"] = [];
    for (let idx = startIdx; idx <= endIdx; idx++) {
      rows.push({ rowNumber: idx + 2, cells: records[idx] });
    }
    return { headers: range.headers, rows, rowsInWindow };
  };
}

async function main() {
  const args = process.argv.slice(2);
  const project = args.includes("--project");
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("Usage: import-field-activity-csv.ts <path-to-csv> [--project]");
    process.exit(1);
  }

  const outcome = await syncFieldActivitySheet({
    spreadsheetId: fieldActivitySheetId(),
    tabTitle: "CSV import",
    mode: "reconcile",
    reader: csvReader(path),
  });
  console.log(`sync: ${outcome.detail}`);
  console.log(
    `read ${outcome.rowsRead}, created ${outcome.rowsCreated}, updated ${outcome.rowsUpdated}, ` +
      `unchanged ${outcome.rowsUnchanged}, withdrawn ${outcome.rowsWithdrawn}, ` +
      `with issues ${outcome.rowsWithIssues}`,
  );

  if (project) {
    const result = await projectFieldActivityTimeline();
    console.log(
      `project: ${result.written} timeline entries written from ${result.scanned} matched rows` +
        (result.skipped ? `, ${result.skipped} already had one` : ""),
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
