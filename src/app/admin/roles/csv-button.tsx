"use client";

import { downloadCsv, toCsv } from "@/lib/csv";
import { btnClass } from "../_shell/kit";

/** "Export": the rows the screen is drawing, as a CSV — the server hands them over ready. */
export function CsvButton({
  name,
  headers,
  rows,
  filters,
  label = "Export",
}: {
  name: string;
  headers: string[];
  rows: Array<Array<string | number | null>>;
  filters?: Array<string | null>;
  label?: string;
}) {
  return (
    <button
      type="button"
      className={btnClass()}
      disabled={rows.length === 0}
      onClick={() => downloadCsv(name, toCsv(headers, rows), filters)}
    >
      {label}
    </button>
  );
}
