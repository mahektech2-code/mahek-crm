"use client";

import { downloadCsv, toCsv } from "@/lib/csv";

/**
 * Export to a spreadsheet — §30's "Export to Excel".
 *
 * CSV rather than a real `.xlsx`, and that is a deliberate trade rather than a
 * shortcut: Excel opens a CSV by double-click, the whole app already exports
 * this way, and an `.xlsx` writer is a dependency and a binary format to
 * maintain for a file whose only job is to be opened once and sorted.
 *
 * The rows are built on the SERVER and handed down, so what leaves in the file
 * is what was on the screen. Rebuilding them in the browser from a different
 * shape is how an export comes to hold a different set of rows to the table
 * above it — usually the unfiltered set, which is the worst version of that
 * bug because it looks like more data rather than wrong data.
 */
export function ExportButton({
  name,
  rows,
}: {
  name: string;
  /** First row is the header. */
  rows: Array<Array<string | number | null | undefined>>;
}) {
  const [headers, ...body] = rows;
  const disabled = body.length === 0;

  return (
    <button
      type="button"
      disabled={disabled}
      title={
        disabled
          ? "Nothing to export — the table is empty."
          : `${body.length} rows, exactly as filtered`
      }
      onClick={() =>
        downloadCsv(name, toCsv(headers.map(String), body), [name])
      }
      className="rounded-[4px] border border-line bg-surface px-2.5 py-1 text-[12px] text-body hover:bg-canvas disabled:opacity-50"
    >
      Export ({body.length})
    </button>
  );
}
