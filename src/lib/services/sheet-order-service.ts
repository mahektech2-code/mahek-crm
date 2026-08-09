import "server-only";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { sheetOrderRows, sheetSyncRuns } from "@/db/schema";
import { DISPLAY_COLUMNS, isLineLevel } from "@/lib/sheet-parse";

/* ---------------------------------------------------------------------------
 * Reads for the Order Sheet section of the console.
 *
 * The screen shows the imported rows exactly as the sheet holds them, and this
 * is what feeds it. Two rules shape every query here:
 *
 *   `raw` is never selected by a list. It is the whole row as JSONB and there
 *   will be thirty thousand of them; dragging that through the pool to render
 *   a table would make the screen slower the more data succeeds in arriving.
 *   The detail view fetches it for ONE row, which is the only time it is worth
 *   its weight.
 *
 *   An order's value is the SUM of its lines. Amount and Final Amount live on
 *   the line, and the sheet repeats the order-level columns down every line of
 *   an order — so a query that reads Final Amount per order without summing
 *   shows the last line's figure. Roughly half the orders here are multi-line,
 *   so that mistake would be invisible and wrong at the same time.
 * ------------------------------------------------------------------------- */

export type SheetRowSummary = {
  totalRows: number;
  presentRows: number;
  withdrawnRows: number;
  rowsWithIssues: number;
  distinctOrders: number;
  distinctParties: number;
  unmatchedProducts: number;
  /** Null when nothing has ever synced. */
  lastSync: {
    at: Date | null;
    mode: string;
    status: string;
    rowsCreated: number;
    rowsUpdated: number;
    rowsUnchanged: number;
    error: string | null;
    feedsCrm: boolean;
  } | null;
};

export async function sheetSummary(source = "order_details"): Promise<SheetRowSummary> {
  const [counts] = await db
    .select({
      totalRows: sql<number>`count(*)::int`,
      presentRows: sql<number>`count(*) filter (where ${sheetOrderRows.status} = 'present')::int`,
      withdrawnRows: sql<number>`count(*) filter (where ${sheetOrderRows.status} = 'withdrawn')::int`,
      rowsWithIssues: sql<number>`count(*) filter (where jsonb_array_length(${sheetOrderRows.issues}) > 0)::int`,
      distinctOrders: sql<number>`count(distinct ${sheetOrderRows.orderNumber})::int`,
      distinctParties: sql<number>`count(distinct ${sheetOrderRows.billingPartyName})::int`,
      unmatchedProducts: sql<number>`count(*) filter (where ${sheetOrderRows.productMatchStatus} <> 'matched')::int`,
    })
    .from(sheetOrderRows);

  const run = await db.query.sheetSyncRuns.findFirst({
    where: eq(sheetSyncRuns.source, source),
    orderBy: desc(sheetSyncRuns.startedAt),
  });

  return {
    ...counts,
    lastSync: run
      ? {
          at: run.finishedAt ?? run.startedAt,
          mode: run.mode,
          status: run.status,
          rowsCreated: run.rowsCreated,
          rowsUpdated: run.rowsUpdated,
          rowsUnchanged: run.rowsUnchanged,
          error: run.error,
          feedsCrm: run.feedsCrm,
        }
      : null,
  };
}

export type SheetLineRow = {
  id: string;
  rowNumber: number;
  lineKey: string;
  orderNumber: string | null;
  orderDate: string | null;
  billingPartyName: string | null;
  description: string | null;
  cans: number | null;
  volumeMl: number | null;
  packType: string | null;
  ratePaise: number | null;
  paymentStatus: string | null;
  paymentReceivedDate: string | null;
  area: string | null;
  gstBp: number | null;
  amountPaise: number | null;
  transportName: string | null;
  discountBp: number | null;
  finalAmountPaise: number | null;
  dispatchDate: string | null;
  tallyBillNo: string | null;
  orderFulfillDays: number | null;
  creditDays: number | null;
  paymentType: string | null;
  segmentCounterType: string | null;
  salesMan: string | null;
  status: "present" | "withdrawn";
  issueCount: number;
};

export type SheetListFilters = {
  query?: string;
  /** Only rows the parser could not fully read, or that contradict themselves. */
  issuesOnly?: boolean;
  withdrawn?: boolean;
  party?: string;
  page?: number;
  perPage?: number;
};

export async function listSheetRows(
  filters: SheetListFilters = {},
): Promise<{ rows: SheetLineRow[]; total: number; page: number; pages: number }> {
  const perPage = Math.min(filters.perPage ?? 50, 200);
  const page = Math.max(filters.page ?? 1, 1);

  const where: SQL[] = [];
  if (!filters.withdrawn) where.push(eq(sheetOrderRows.status, "present"));
  if (filters.issuesOnly) {
    where.push(sql`jsonb_array_length(${sheetOrderRows.issues}) > 0`);
  }
  if (filters.party) where.push(eq(sheetOrderRows.billingPartyName, filters.party));

  const q = filters.query?.trim();
  if (q) {
    // What was typed, across the columns somebody would search by. Not the
    // telecaller's fuzzy match: an admin looking for order 16978 wants 16978.
    const like = `%${q}%`;
    where.push(sql`(
      coalesce(${sheetOrderRows.orderNumber}, '') ilike ${like}
      or coalesce(${sheetOrderRows.billingPartyName}, '') ilike ${like}
      or coalesce(${sheetOrderRows.description}, '') ilike ${like}
      or coalesce(${sheetOrderRows.tallyBillNo}, '') ilike ${like}
      or coalesce(${sheetOrderRows.area}, '') ilike ${like}
      or coalesce(${sheetOrderRows.salesMan}, '') ilike ${like}
    )`);
  }

  const clause = where.length ? and(...where) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(sheetOrderRows)
    .where(clause);

  const rows = await db
    .select({
      id: sheetOrderRows.id,
      rowNumber: sheetOrderRows.rowNumber,
      lineKey: sheetOrderRows.lineKey,
      orderNumber: sheetOrderRows.orderNumber,
      orderDate: sheetOrderRows.orderDate,
      billingPartyName: sheetOrderRows.billingPartyName,
      description: sheetOrderRows.description,
      cans: sheetOrderRows.cans,
      volumeMl: sheetOrderRows.volumeMl,
      packType: sheetOrderRows.packType,
      ratePaise: sheetOrderRows.ratePaise,
      paymentStatus: sheetOrderRows.paymentStatus,
      paymentReceivedDate: sheetOrderRows.paymentReceivedDate,
      area: sheetOrderRows.area,
      gstBp: sheetOrderRows.gstBp,
      amountPaise: sheetOrderRows.amountPaise,
      transportName: sheetOrderRows.transportName,
      discountBp: sheetOrderRows.discountBp,
      finalAmountPaise: sheetOrderRows.finalAmountPaise,
      dispatchDate: sheetOrderRows.dispatchDate,
      tallyBillNo: sheetOrderRows.tallyBillNo,
      orderFulfillDays: sheetOrderRows.orderFulfillDays,
      creditDays: sheetOrderRows.creditDays,
      paymentType: sheetOrderRows.paymentType,
      segmentCounterType: sheetOrderRows.segmentCounterType,
      salesMan: sheetOrderRows.salesMan,
      status: sheetOrderRows.status,
      issueCount: sql<number>`jsonb_array_length(${sheetOrderRows.issues})::int`,
      // Deliberately absent: `raw`. See the note at the top of this file.
    })
    .from(sheetOrderRows)
    .where(clause)
    .orderBy(desc(sheetOrderRows.orderDate), sheetOrderRows.rowNumber)
    .limit(perPage)
    .offset((page - 1) * perPage);

  return {
    rows: rows as SheetLineRow[],
    total,
    page,
    pages: Math.max(Math.ceil(total / perPage), 1),
  };
}

export type SheetIssueRow = {
  id: string;
  rowNumber: number;
  orderNumber: string | null;
  billingPartyName: string | null;
  issues: { column: string; value: string; problem: string }[];
};

/** Every row the import could not fully read. The reason to open this screen. */
export async function listSheetIssues(limit = 200): Promise<SheetIssueRow[]> {
  const rows = await db
    .select({
      id: sheetOrderRows.id,
      rowNumber: sheetOrderRows.rowNumber,
      orderNumber: sheetOrderRows.orderNumber,
      billingPartyName: sheetOrderRows.billingPartyName,
      issues: sheetOrderRows.issues,
    })
    .from(sheetOrderRows)
    .where(sql`jsonb_array_length(${sheetOrderRows.issues}) > 0`)
    .orderBy(sheetOrderRows.rowNumber)
    .limit(limit);
  return rows as SheetIssueRow[];
}

export type SheetOrderGroup = {
  orderNumber: string;
  orderDate: string | null;
  billingPartyName: string | null;
  area: string | null;
  salesMan: string | null;
  lineCount: number;
  /** SUMMED across the order's lines — never one line's figure. */
  amountPaise: number;
  finalAmountPaise: number;
  tallyBillNos: string[];
};

/**
 * The same rows grouped into orders.
 *
 * This is the view that answers "how many orders" and "what were they worth",
 * and it exists because the flat one cannot: 99 rows are 47 orders here, so
 * counting rows overstates the order count by more than double and summing
 * per-line figures per row is the only way to get the value right.
 */
export async function listSheetOrders(
  limit = 100,
): Promise<SheetOrderGroup[]> {
  const rows = await db
    .select({
      orderNumber: sheetOrderRows.orderNumber,
      orderDate: sql<string | null>`min(${sheetOrderRows.orderDate})`,
      billingPartyName: sql<string | null>`min(${sheetOrderRows.billingPartyName})`,
      area: sql<string | null>`min(${sheetOrderRows.area})`,
      salesMan: sql<string | null>`min(${sheetOrderRows.salesMan})`,
      lineCount: sql<number>`count(*)::int`,
      amountPaise: sql<number>`coalesce(sum(${sheetOrderRows.amountPaise}), 0)::bigint`,
      finalAmountPaise: sql<number>`coalesce(sum(${sheetOrderRows.finalAmountPaise}), 0)::bigint`,
      tallyBillNos: sql<string[]>`array_remove(array_agg(distinct ${sheetOrderRows.tallyBillNo}), null)`,
    })
    .from(sheetOrderRows)
    .where(
      and(
        eq(sheetOrderRows.status, "present"),
        sql`${sheetOrderRows.orderNumber} is not null`,
      ),
    )
    .groupBy(sheetOrderRows.orderNumber)
    .orderBy(sql`min(${sheetOrderRows.orderDate}) desc nulls last`)
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    orderNumber: r.orderNumber!,
    amountPaise: Number(r.amountPaise),
    finalAmountPaise: Number(r.finalAmountPaise),
  }));
}

/** One row, with its raw cells. The only place `raw` is read. */
export async function getSheetRow(id: string) {
  return db.query.sheetOrderRows.findFirst({ where: eq(sheetOrderRows.id, id) });
}

/** The column list the screen renders, with each one's level. */
export function displayColumns() {
  return DISPLAY_COLUMNS.map((column) => ({
    column,
    level: isLineLevel(column) ? ("line" as const) : ("order" as const),
  }));
}
