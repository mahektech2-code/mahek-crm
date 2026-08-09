import type {
  listSheetIssues,
  listSheetOrders,
  listSheetRows,
  sheetSummary,
} from "@/lib/services/sheet-order-service";

/* ---------------------------------------------------------------------------
 * Everything the Order Sheet section is handed by the server.
 *
 * Shapes derived from the read functions rather than restated, the way the
 * catalogue section does it: a column added to a query cannot silently fail to
 * reach the screen, and one removed breaks the build instead of rendering
 * "undefined" to somebody reconciling figures against a spreadsheet.
 * ------------------------------------------------------------------------- */

type Unwrap<T> = T extends (...args: never[]) => Promise<infer R> ? R : never;

export type SheetData = {
  summary: Unwrap<typeof sheetSummary>;
  rows: Unwrap<typeof listSheetRows>["rows"];
  total: number;
  page: number;
  pages: number;
  orders: Unwrap<typeof listSheetOrders>;
  issues: Unwrap<typeof listSheetIssues>;
  filters: { query?: string; issuesOnly?: boolean; withdrawn?: boolean };
  /** Which sheet and tab this came from, so the screen can name its source. */
  source: { spreadsheetId: string; tabTitle: string; configured: boolean };
  /** Who imported customers can be assigned to, and whether this person may run it. */
  owners: Array<{ id: string; name: string; email: string; role: string }>;
  canImport: boolean;
};

export const SHEET_TABS = [
  { slug: "lines", label: "Order lines" },
  { slug: "orders", label: "Orders" },
  { slug: "issues", label: "Needs attention" },
  { slug: "sync", label: "Sync" },
] as const;

export const SHEET_SUBTITLE =
  "Order history imported from the Google Sheet, exactly as the sheet holds it. Read-only — the sheet is the source.";
