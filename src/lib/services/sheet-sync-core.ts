import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, getTableName, gt, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { sheetSyncRuns } from "@/db/schema";
import type { ReadRange, SheetTable } from "@/lib/sheets";

/* ---------------------------------------------------------------------------
 * What every sheet import shares.
 *
 * Two tabs of the same workbook are imported into MahekOne — order lines and
 * employees — and they are nothing alike in shape. What they have in common is
 * the machinery, and it is the machinery that is easy to get subtly wrong: the
 * hash that makes an unchanged row free, the windowed read that keeps a large
 * tab out of memory, the watermark that stops an append run re-reading, and a
 * run record that survives a failure with enough on it to resume.
 *
 * So that lives here once. What a row MEANS stays with each importer.
 * ------------------------------------------------------------------------- */

export const newSyncId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** Rows per Google range request. Big enough to be few calls, small enough
 *  that one response is megabytes rather than hundreds of them. */
export const READ_WINDOW = 5_000;

/** Rows per database statement. Postgres takes 65,535 bind parameters total,
 *  and these rows carry ~35 columns — 500 leaves comfortable headroom. */
export const WRITE_BATCH = 500;

export type SyncMode = "append" | "reconcile" | "reparse";

export type SyncCounts = {
  rowsRead: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  rowsWithdrawn: number;
  rowsWithIssues: number;
  detail: string;
};

export type SyncOutcome = SyncCounts & { syncId: string; mode: SyncMode };

/**
 * How a window of the sheet is fetched. Real callers never pass this.
 *
 * It exists so a sync can be driven at a size no test fixture can reach
 * through Google — thirty thousand rows is not something to put in a
 * spreadsheet to find out whether the batching holds. Same seam as
 * `setTestUser()` in lib/auth.ts: everything downstream is the real thing.
 */
export type SheetReader = (range: ReadRange) => Promise<SheetTable>;

export const hashRow = (cells: Record<string, string>) =>
  createHash("sha256")
    // Key order out of a JSON object is insertion order, which follows the
    // sheet's columns. Sorted anyway: a column inserted in the middle must not
    // rewrite thirty thousand hashes and report the entire sheet as changed.
    .update(JSON.stringify(Object.entries(cells).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");

/* ---------------------------------------------------------------------------
 * WHAT HAS GONE IS A DIFFERENCE, NOT A STAMP.
 *
 * Every one of these imports used to answer "which rows have left the sheet"
 * by stamping `last_seen_sync_id` onto every row it saw and then withdrawing
 * whatever still held an older id. It reads well and it is quadratically
 * expensive in exactly the case that matters: on a quiet tab NOTHING has
 * changed, so the stamp is the ONLY write the pass makes — and it makes one
 * for every row in the table, every thirty minutes, for ever.
 *
 * Measured on production: `sheet_taken_order_rows` had taken 63,423,497
 * updates against 21,348 live rows — about 2,970 rewrites per row — in cycles
 * whose own log read "0 new, 0 changed, 21337 unchanged". Postgres has no
 * in-place update, so each of those was a new tuple, a WAL record and a dirty
 * page for a row whose contents did not move; on a 961 MB droplet that is what
 * evicts the page cache and keeps autovacuum running on a table nobody wrote
 * anything to.
 *
 * The pass already knows every key the sheet holds — it had to read them all
 * to hash them. So the question is answered by asking Postgres for the
 * difference instead: a present row whose key is not among the ones just seen
 * is a row that has gone. Nothing is written to say a row is still there,
 * which is right as well as cheap: "still there" is not news, and a column
 * that moves on every pass cannot also mean "this row changed".
 *
 * `last_seen_sync_id` is KEPT and is still written by the upsert, so it goes
 * on recording which run last WROTE a row. It is no longer the witness for
 * withdrawal and nothing else in MahekOne reads it. Do not reintroduce a
 * per-pass stamp on it: that is this bug, exactly.
 * ------------------------------------------------------------------------- */

/**
 * Rows this pass did not see, for the WHERE of a withdrawal.
 *
 * ONE bind parameter, not one per key. Drizzle expands a bare JS array into a
 * parameter list, which on the field-activity tab would be tens of thousands
 * of placeholders against Postgres's ceiling of 65,535 — so the array is
 * passed whole with `sql.param` and cast, and the statement stays the same
 * size whatever the sheet grows to.
 *
 * `not exists` over `unnest` rather than the shorter `<> all(…)`, because the
 * planner can turn this one into a Hash Right Anti Join and cannot turn that
 * one into anything: `<> all` is a linear walk of the array for every row, so
 * it is quadratic in the size of the tab. Measured on 21,348 rows against
 * 21,337 keys, 34 ms against 110 ms, and the gap widens with the sheet.
 *
 * The outer column is written out QUALIFIED. That is the house rule for raw
 * SQL and it is load-bearing exactly here: Drizzle renders a column reference
 * as a bare `"line_key"`, which inside this correlated subquery would bind to
 * the inner relation if it ever gained a column of that name — and the
 * condition would silently become false, which withdraws nothing, for ever,
 * with every type and every unit test still passing.
 *
 * An EMPTY set matches every row, which is the same answer the stamp gave:
 * a pass that saw nothing withdraws everything. That is a real hazard on a
 * tab somebody renamed or revoked a permission on, and it is why each caller
 * guards its own withdrawal the way it already did — this function is not the
 * place to decide that a sheet with no rows in it is impossible.
 */
export function notAmong(column: AnyColumn, seen: ReadonlySet<string>): SQL {
  const outer = sql.raw(`${getTableName(column.table)}.${column.name}`);
  return sql`not exists (
    select 1 from unnest(${sql.param([...seen])}::text[]) as seen_key(key)
     where seen_key.key = ${outer}
  )`;
}

/**
 * Where an `append` run starts reading.
 *
 * The highest row number this source has ever seen, +1. Kept on the sync run
 * rather than computed with max(row_number) so that a withdrawn row does not
 * pull the watermark backwards and cause the same rows to be re-read forever.
 */
export async function watermark(source: string): Promise<number> {
  const last = await db.query.sheetSyncRuns.findFirst({
    where: and(eq(sheetSyncRuns.source, source), eq(sheetSyncRuns.status, "ok")),
    orderBy: desc(sheetSyncRuns.startedAt),
    columns: { highestRow: true },
  });
  return last?.highestRow ?? 1;
}

/**
 * Read a tab in row windows.
 *
 * The header is fetched once and reused, because every window after the first
 * starts below it. Reading 30,000 rows in one request would be a response of
 * tens of megabytes held entirely in memory before a single row is written.
 */
export async function* readWindows(
  read: SheetReader,
  startRow: number,
  /** The first row that is data. Two-header tabs pass 3. */
  firstDataRow = 2,
): AsyncGenerator<SheetTable> {
  const header = await read({ firstRow: 1, lastRow: 1 });
  if (!header.headers.length) return;

  let from = Math.max(startRow, firstDataRow);
  for (;;) {
    const to = from + READ_WINDOW - 1;
    const window = await read({ firstRow: from, lastRow: to, headers: header.headers });

    if (window.rows.length) yield window;

    // A short window means the sheet ended inside it. Google returns only the
    // rows that exist, so this is how the end is detected — there is no count
    // to ask for that is cheaper than the read itself.
    if (window.rowsInWindow < READ_WINDOW) return;
    from = to + 1;
  }
}

export type RunOptions = {
  source: string;
  spreadsheetId: string;
  tabTitle: string;
  mode: SyncMode;
  triggeredById?: string | null;
};

/**
 * Open a run row, do the work, and close it — whichever way it ends.
 *
 * A failed run is left behind with its error and its cursor rather than
 * deleted. Both are needed: one to tell somebody what happened, the other to
 * carry on from.
 */
/**
 * How long a `running` row is believed before it is treated as abandoned.
 *
 * The sync route is capped at five minutes, so anything older than this was
 * killed rather than finished. Ten minutes leaves room for a slow finish
 * without letting one dead run block a schedule indefinitely.
 */
const STALE_RUN_MS = 10 * 60 * 1000;

/** Refused because the same source is already being read. Not a failure. */
export class SyncAlreadyRunningError extends Error {
  readonly source: string;
  readonly since: Date;
  constructor(source: string, since: Date) {
    super(`A ${source} sync started at ${since.toISOString()} is still running.`);
    this.name = "SyncAlreadyRunningError";
    this.source = source;
    this.since = since;
  }
}

export async function runSync(
  options: RunOptions,
  work: (syncId: string) => Promise<SyncCounts>,
): Promise<SyncOutcome> {
  /*
   * ONE RUN PER SOURCE AT A TIME.
   *
   * Nothing used to check this. On a laptop it did not matter — a person runs
   * one command and waits. On a schedule it does: a run that hangs on a slow
   * Google response is still `running` when the next fires, and two passes
   * over the same tab race through the same upserts. The writes are
   * idempotent, so the cost is doubled work and a doubled API bill rather than
   * corruption, but both runs also believe they own the cursor.
   *
   * A run older than the stale window is treated as dead rather than blocking
   * forever: the route is capped at five minutes, so a `running` row from an
   * hour ago is a process that was killed mid-write and never got to mark
   * itself failed. Waiting on it would let one timeout stop every future sync,
   * which is a worse failure than the one being prevented.
   */
  const inFlight = await db
    .select({ id: sheetSyncRuns.id, startedAt: sheetSyncRuns.startedAt })
    .from(sheetSyncRuns)
    .where(
      and(
        eq(sheetSyncRuns.source, options.source),
        eq(sheetSyncRuns.status, "running"),
        gt(sheetSyncRuns.startedAt, new Date(Date.now() - STALE_RUN_MS)),
      ),
    )
    .limit(1);

  if (inFlight.length) {
    throw new SyncAlreadyRunningError(options.source, inFlight[0].startedAt);
  }

  const syncId = newSyncId("sync");
  await db.insert(sheetSyncRuns).values({
    id: syncId,
    source: options.source,
    spreadsheetId: options.spreadsheetId,
    tabTitle: options.tabTitle,
    mode: options.mode,
    status: "running",
    triggeredById: options.triggeredById ?? null,
  });

  try {
    const counts = await work(syncId);
    await db
      .update(sheetSyncRuns)
      .set({
        status: "ok",
        finishedAt: new Date(),
        rowsRead: counts.rowsRead,
        rowsCreated: counts.rowsCreated,
        rowsUpdated: counts.rowsUpdated,
        rowsUnchanged: counts.rowsUnchanged,
        rowsWithdrawn: counts.rowsWithdrawn,
        rowsWithIssues: counts.rowsWithIssues,
        cursorRow: null,
      })
      .where(eq(sheetSyncRuns.id, syncId));

    return { ...counts, syncId, mode: options.mode };
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
