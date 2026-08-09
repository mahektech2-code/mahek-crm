"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { sheetSyncRuns } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { canOpen } from "@/lib/access";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import {
  EMPLOYEE_SOURCE,
  employeeSheetId,
  syncEmployeeSheet,
} from "@/lib/services/employee-sync-service";

/* ---------------------------------------------------------------------------
 * Pulling the employee sheet on demand.
 *
 * Two callers, one path: the button on the screen, and the screen itself while
 * somebody has it open. Both land here so the guards below apply to both.
 * ------------------------------------------------------------------------- */

export type SyncReport = {
  created: number;
  updated: number;
  unchanged: number;
  withdrawn: number;
  /** True when nothing ran because a sync had just run or was still running. */
  skipped: boolean;
};

/**
 * How recently a sync has to have finished for the next one to be pointless.
 *
 * The screen asks on a timer while it is open, and several people may have it
 * open at once. Without this, ten open tabs are ten reads of the same sheet a
 * minute — Google's quota is finite and the answer would be identical.
 */
const QUIET_SECONDS = 20;

/** A run that started this long ago and is still `running` has died. */
const STALE_MINUTES = 10;

export async function syncEmployeesAction(
  /** True for the button somebody pressed. It waits for no quiet window —
   *  a person pressing Sync now is asking a question, and "we synced twenty
   *  seconds ago" is not an answer they can see. */
  force = false,
): Promise<Result<SyncReport>> {
  try {
    // Not merely hidden on the screen: this reads somebody else's HR data, and
    // a server action is a URL like any other.
    const user = await requireUser();
    if (!(await canOpen(user.id, "hrms"))) {
      return err("You do not have the HRMS app.", "not_permitted");
    }

    const last = await db
      .select({
        status: sheetSyncRuns.status,
        startedAt: sheetSyncRuns.startedAt,
        finishedAt: sheetSyncRuns.finishedAt,
      })
      .from(sheetSyncRuns)
      .where(eq(sheetSyncRuns.source, EMPLOYEE_SOURCE))
      .orderBy(desc(sheetSyncRuns.startedAt))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (last) {
      const ageMs = Date.now() - (last.finishedAt ?? last.startedAt).getTime();
      const running =
        last.status === "running" && ageMs < STALE_MINUTES * 60_000;
      if (running || (!force && ageMs < QUIET_SECONDS * 1000)) {
        return ok(
          { created: 0, updated: 0, unchanged: 0, withdrawn: 0, skipped: true },
          running ? "A sync is already running." : "Already up to date.",
        );
      }
    }

    const outcome = await syncEmployeeSheet({
      spreadsheetId: employeeSheetId(),
      mode: "reconcile",
      triggeredById: user.id,
    });

    revalidatePath("/hrms/employees");
    revalidatePath("/apps");

    return ok(
      {
        created: outcome.rowsCreated,
        updated: outcome.rowsUpdated,
        unchanged: outcome.rowsUnchanged,
        withdrawn: outcome.rowsWithdrawn,
        skipped: false,
      },
      describe(outcome.rowsCreated, outcome.rowsUpdated, outcome.rowsWithdrawn),
    );
  } catch (e) {
    return fromThrown(e);
  }
}

function describe(created: number, updated: number, withdrawn: number): string {
  const parts: string[] = [];
  if (created) parts.push(`${created} new`);
  if (updated) parts.push(`${updated} updated`);
  if (withdrawn) parts.push(`${withdrawn} no longer in the sheet`);
  return parts.length
    ? `Synced — ${parts.join(", ")}.`
    : "Synced. The sheet has not changed.";
}

/** Whether an employee sync has ever completed, for the empty state to read. */
export async function hasSyncedEmployees(): Promise<boolean> {
  const rows = await db
    .select({ id: sheetSyncRuns.id })
    .from(sheetSyncRuns)
    .where(
      and(eq(sheetSyncRuns.source, EMPLOYEE_SOURCE), eq(sheetSyncRuns.status, "ok")),
    )
    .limit(1);
  return rows.length > 0;
}
