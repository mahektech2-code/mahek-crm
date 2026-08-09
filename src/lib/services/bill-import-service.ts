import "server-only";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns, sheetSyncRuns, users } from "@/db/schema";
import { checkCapability, requireCapability } from "../access-control";

/* ---------------------------------------------------------------------------
 * The bill import, from the desk that needs the bills.
 *
 * Sales bills are projected from the Google Sheet by a job. That job was
 * reachable from a terminal and from a cron endpoint behind a secret, which on
 * this deployment meant neither: the import ran on somebody's laptop against
 * the production database, or it did not run. Admin Console → Order sheet
 * gained a button; accounts do not have the console, and they are the people
 * who notice the bills are missing.
 *
 * This file reads what the runs did. Running one goes through the same
 * `runJob` the console and the CLI use — one path, so a run started here is
 * indistinguishable from a run started anywhere else.
 * ------------------------------------------------------------------------- */

export type ImportRun = {
  id: string;
  /** Which step: the order tab, the payment tab, or the projection. */
  what: string;
  startedAt: Date;
  finishedAt: Date | null;
  created: number;
  updated: number;
  /** Rows whose hash was unchanged, so nothing was written. */
  unchanged: number;
  /** Rows the run could not use, and said so rather than guessing. */
  withIssues: number;
  ok: boolean;
  /** Populated on failure — a sync that died halfway says so on the screen. */
  error: string | null;
  triggeredByName: string | null;
};

export type ImportState = {
  runs: ImportRun[];
  last: ImportRun | null;
  /** Who imported customers may be assigned to — the sheet names no person. */
  owners: Array<{ id: string; name: string; email: string }>;
  canRun: boolean;
};

const SOURCE_WORDS: Record<string, string> = {
  order_details: "Order Details tab",
  payment_status: "Payment Status tab",
  taken_order: "Taken Order tab",
  employee_details: "Employee Details tab",
};

const JOB_WORDS: Record<string, string> = {
  "project-sheet": "Projection — customers, orders and bills",
  "sheet-reconcile": "Order sheet, full reconcile",
  "sheet-payments": "Payment Status tab",
};

export async function importState(): Promise<ImportState> {
  await requireCapability("payment.record");
  const { allowed } = await checkCapability("sheet.import");

  // Two tables record the same story from different ends: the sheet reader
  // logs what it read, `job_runs` logs what a person asked for. Both are shown
  // because a projection that touched nothing and a sheet that could not be
  // read look identical from one of them alone.
  const syncs = await db
    .select({
      run: sheetSyncRuns,
      by: sql<string | null>`(
        select u.name from users u where u.id = sheet_sync_runs.triggered_by_id
      )`,
    })
    .from(sheetSyncRuns)
    .where(inArray(sheetSyncRuns.source, ["order_details", "payment_status"]))
    .orderBy(desc(sheetSyncRuns.startedAt))
    .limit(10);

  const jobs = await db
    .select({
      run: jobRuns,
      by: sql<string | null>`(
        select u.name from users u where u.id = job_runs.triggered_by_id
      )`,
    })
    .from(jobRuns)
    .where(inArray(jobRuns.job, ["project-sheet", "sheet-reconcile", "sheet-payments"]))
    .orderBy(desc(jobRuns.startedAt))
    .limit(10);

  const runs: ImportRun[] = [
    ...syncs.map(({ run, by }) => ({
      id: run.id,
      what: SOURCE_WORDS[run.source] ?? run.source,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      created: run.rowsCreated,
      updated: run.rowsUpdated,
      unchanged: run.rowsUnchanged,
      withIssues: run.rowsWithIssues,
      ok: run.status === "ok",
      error: run.error,
      triggeredByName: by,
    })),
    ...jobs.map(({ run, by }) => ({
      id: run.id,
      what: JOB_WORDS[run.job] ?? run.job,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      // A job row counts what it touched without splitting it, so the two
      // columns it cannot fill are left at zero rather than invented.
      created: run.recordsAffected,
      updated: 0,
      unchanged: 0,
      withIssues: 0,
      ok: run.ok,
      error: run.ok ? null : (run.detail ?? "The run failed."),
      triggeredByName: by,
    })),
  ].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  const owners = allowed
    ? await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.active, true))
        .orderBy(users.name)
    : [];

  return {
    runs: runs.slice(0, 12),
    last: runs[0] ?? null,
    owners: owners.map((o) => ({ id: o.id, name: o.name, email: o.email ?? "" })),
    canRun: allowed,
  };
}
