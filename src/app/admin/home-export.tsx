"use client";

import { downloadCsv, toCsv } from "@/lib/csv";
import { btnClass } from "./_shell/kit";

/**
 * "Export health report" — what Home shows, as a spreadsheet: the health
 * figures, everything waiting on an admin, and every app's people. Built from
 * the same figures the page drew, so the file and the screen cannot disagree.
 */
export function ExportHealthReport({ rows }: { rows: Array<[string, string, string]> }) {
  return (
    <button
      type="button"
      className={btnClass()}
      onClick={() => downloadCsv("admin-health-report", toCsv(["Section", "Item", "Value"], rows))}
    >
      Export health report
    </button>
  );
}
