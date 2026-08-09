import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  complaints,
  jobRuns,
  notifications,
  queueSnapshots,
  reminders,
  users,
} from "@/db/schema";
import { getConfig } from "./config/store";
import {
  recomputeAllBuyingCycles,
  recomputeAllFollowUpStates,
  recomputeAllOutstanding,
  recomputeBillStatuses,
  recomputeInactivity,
  recomputeSlowPayers,
  seedMonthlyTargets,
  today,
} from "./recompute";
import { sweepUnconfirmed } from "./services/whatsapp-service";
import { sweepOrphans } from "./services/attachment-service";
import { autoGenerateEodReports } from "./services/eod-service";
import { isWorkingDay, nextWorkingDay, type BusinessDate } from "./business-date";
import { buildQueue } from "./engines/queue";
import { queueCandidatesFor } from "./services/queue-service";
import {
  syncOrderSheet,
  syncPaymentSheet,
  type SyncMode,
} from "./services/sheet-sync-service";

/* ---------------------------------------------------------------------------
 * §7 Scheduled work.
 *
 * Every task is idempotent and safe to re-run, logs start, end and records
 * affected, and can be triggered by hand — all three are needed during
 * rollout and migration tuning.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export type JobName =
  | "nightly"
  | "hourly"
  | "day-boundary"
  | "recompute-cycles"
  | "recompute-inactivity"
  | "recompute-followups"
  | "recompute-slow-payers"
  | "snapshot-queue"
  | "seed-targets"
  | "sweep-unconfirmed"
  | "escalate-complaint-sla"
  | "auto-eod"
  | "roll-reminders"
  | "sweep-orphan-attachments"
  | "sheet-append"
  | "sheet-reconcile"
  | "sheet-reparse"
  | "sheet-payments";

export type JobResult = { job: JobName; recordsAffected: number; detail: string };

async function run(
  job: JobName,
  fn: () => Promise<{ recordsAffected: number; detail: string }>,
  triggeredById?: string,
): Promise<JobResult> {
  const runId = id("job");
  await db.insert(jobRuns).values({
    id: runId,
    job,
    startedAt: new Date(),
    triggeredById: triggeredById ?? null,
  });

  try {
    const { recordsAffected, detail } = await fn();
    await db
      .update(jobRuns)
      .set({ finishedAt: new Date(), recordsAffected, ok: true, detail })
      .where(eq(jobRuns.id, runId));
    return { job, recordsAffected, detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await db
      .update(jobRuns)
      .set({ finishedAt: new Date(), ok: false, detail })
      .where(eq(jobRuns.id, runId));
    throw error;
  }
}

/* ---------------------------------------------------------------- nightly */

export async function runNightly(triggeredById?: string): Promise<JobResult[]> {
  const day = await today();
  const results: JobResult[] = [];

  results.push(
    await run("recompute-cycles", async () => {
      const n = await recomputeAllBuyingCycles();
      return { recordsAffected: n, detail: `${n} customers` };
    }, triggeredById),
  );

  results.push(
    await run("recompute-inactivity", async () => {
      const n = await recomputeInactivity();
      return { recordsAffected: n, detail: `${n} on the watch` };
    }, triggeredById),
  );

  results.push(
    await run("recompute-followups", async () => {
      await recomputeBillStatuses();
      await recomputeAllOutstanding();
      const n = await recomputeAllFollowUpStates();
      return { recordsAffected: n, detail: `${n} customers evaluated` };
    }, triggeredById),
  );

  // §4.2 — an abandoned form leaves files belonging to nothing. Nothing else
  // will ever reclaim them, so the sweep is part of the subsystem rather than
  // a tidy-up somebody remembers to run.
  results.push(
    await run("sweep-orphan-attachments", async () => {
      const { swept } = await sweepOrphans();
      return { recordsAffected: swept, detail: `${swept} unbound files removed` };
    }, triggeredById),
  );

  results.push(
    await run("recompute-slow-payers", async () => {
      const n = await recomputeSlowPayers();
      return { recordsAffected: n, detail: `${n} customers evaluated` };
    }, triggeredById),
  );

  // After the recomputes, never before: the snapshot has to record the list as
  // it will actually be read today, and the recomputes are what decide who is
  // on it.
  results.push(
    await run("snapshot-queue", async () => {
      const n = await snapshotQueue(day);
      return { recordsAffected: n, detail: `${n} rows recorded for ${day}` };
    }, triggeredById),
  );

  // Only on the first of the month, but harmless to call any day: it seeds
  // only customers without a target.
  if (day.endsWith("-01")) {
    results.push(
      await run("seed-targets", async () => {
        const n = await seedMonthlyTargets();
        return { recordsAffected: n, detail: `${n} default targets seeded` };
      }, triggeredById),
    );
  }

  return results;
}

/* -------------------------------------------------------- queue snapshot */

/**
 * Records who is in each telecaller's queue as the day opens.
 *
 * The queue is derived on every read and this does not change that — nothing
 * ever builds a queue FROM this table. It exists so the screen can answer
 * "how many of these were here yesterday too", which a derived list cannot
 * answer about its own past.
 *
 * Idempotent: re-running replaces the day's rows rather than doubling them,
 * so a hand-triggered run after a fix is safe.
 */
export async function snapshotQueue(day: BusinessDate): Promise<number> {
  const config = await getConfig();
  const telecallers = await db.select().from(users).where(eq(users.active, true));

  await db.delete(queueSnapshots).where(eq(queueSnapshots.day, day));

  let written = 0;
  for (const user of telecallers) {
    const candidates = await queueCandidatesFor(user.id, day);
    const { entries } = buildQueue(candidates, day, config);
    if (!entries.length) continue;
    await db.insert(queueSnapshots).values(
      entries.map((e) => ({ day, customerId: e.customerId, userId: user.id })),
    );
    written += entries.length;
  }
  return written;
}

/* ----------------------------------------------------------------- hourly */

export async function runHourly(triggeredById?: string): Promise<JobResult[]> {
  const results: JobResult[] = [];

  results.push(
    await run("sweep-unconfirmed", async () => {
      const { swept, autoConfirmed } = await sweepUnconfirmed();
      return {
        recordsAffected: swept,
        detail: `${swept} unconfirmed copies, ${autoConfirmed} auto-confirmed`,
      };
    }, triggeredById),
  );

  results.push(
    await run("escalate-complaint-sla", async () => {
      const breached = await db
        .select({ id: complaints.id, customerId: complaints.customerId })
        .from(complaints)
        .where(
          and(
            lt(complaints.slaDueAt, new Date()),
            isNull(complaints.resolvedAt),
            isNull(complaints.slaEscalatedAt),
          ),
        );

      if (breached.length) {
        const managers = await db
          .select({ id: users.id })
          .from(users)
          .where(sql`${users.role} in ('manager','admin')`);

        for (const c of breached) {
          await db
            .update(complaints)
            .set({ slaEscalatedAt: new Date() })
            .where(eq(complaints.id, c.id));
          for (const m of managers) {
            await db.insert(notifications).values({
              id: id("ntf"),
              userId: m.id,
              title: "Complaint past its SLA",
              body: "A complaint has passed its resolution deadline and needs attention.",
              kind: "danger",
              href: "/crm/complaints",
            });
          }
        }
      }
      return {
        recordsAffected: breached.length,
        detail: `${breached.length} complaints escalated`,
      };
    }, triggeredById),
  );

  return results;
}

/* ----------------------------------------------------------- day boundary */

export async function runDayBoundary(triggeredById?: string): Promise<JobResult[]> {
  const config = await getConfig();
  const day = await today();
  const workingDay = {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  };

  const results: JobResult[] = [];

  results.push(
    await run("auto-eod", async () => {
      // A zero-activity day still produces a report; the absence of one must
      // never be ambiguous.
      const n = await autoGenerateEodReports(day);
      return { recordsAffected: n, detail: `${n} reports generated` };
    }, triggeredById),
  );

  results.push(
    await run("roll-reminders", async () => {
      if (!config["reminders.rollForwardOnNonWorkingDays"]) {
        return { recordsAffected: 0, detail: "roll-forward disabled" };
      }
      const stranded = await db
        .select({ id: reminders.id, dueDate: reminders.dueDate })
        .from(reminders)
        .where(eq(reminders.status, "pending"));

      let moved = 0;
      for (const r of stranded) {
        if (!isWorkingDay(r.dueDate, workingDay)) {
          await db
            .update(reminders)
            .set({ dueDate: nextWorkingDay(r.dueDate, workingDay), updatedAt: new Date() })
            .where(eq(reminders.id, r.id));
          moved++;
        }
      }
      return { recordsAffected: moved, detail: `${moved} reminders rolled forward` };
    }, triggeredById),
  );

  return results;
}

/* ---------------------------------------------------------- manual trigger */

export async function runJob(job: JobName, triggeredById?: string): Promise<JobResult[]> {
  switch (job) {
    case "nightly":
      return runNightly(triggeredById);
    case "hourly":
      return runHourly(triggeredById);
    case "day-boundary":
      return runDayBoundary(triggeredById);
    case "sheet-append":
    case "sheet-reconcile":
    case "sheet-reparse":
      return [await runSheetSync(job, triggeredById)];
    case "sheet-payments":
      return [await runPaymentSync(triggeredById)];
    default:
      throw new Error(`Unknown job "${job}".`);
  }
}

export async function recentJobRuns(limit = 30) {
  return db
    .select()
    .from(jobRuns)
    .orderBy(sql`${jobRuns.startedAt} desc`)
    .limit(limit);
}

/* ------------------------------------------------------- the order sheet */

/**
 * Three schedules over one sheet, because a spreadsheet offers no way to ask
 * what changed:
 *
 *   sheet-append     every few minutes — reads only past the highest row seen
 *   sheet-reconcile  nightly — the whole tab, hash-compared, catches edits
 *                    and rows that have gone
 *   sheet-reparse    by hand — re-reads nothing, re-parses what is stored
 *
 * Append cannot see an edit to an existing row and reconcile can, which is why
 * both exist rather than one compromise between them. Running append alone
 * would mean a corrected figure never arrives; running reconcile at append's
 * frequency would read two million cells every few minutes to find nothing.
 */
async function runSheetSync(
  job: "sheet-append" | "sheet-reconcile" | "sheet-reparse",
  triggeredById?: string,
): Promise<JobResult> {
  const mode = job.replace("sheet-", "") as SyncMode;
  return run(
    job,
    async () => {
      const spreadsheetId = process.env.ORDERS_SHEET_ID;
      if (!spreadsheetId) {
        // Not an error and not a silent success: nothing is configured, and
        // the job log should say exactly that rather than "0 rows".
        return { recordsAffected: 0, detail: "ORDERS_SHEET_ID is not set — nothing to sync." };
      }

      const outcome = await syncOrderSheet({
        source: "order_details",
        spreadsheetId,
        tabTitle: process.env.ORDERS_SHEET_TAB ?? "Order Details",
        mode,
        triggeredById,
      });

      return {
        recordsAffected: outcome.rowsCreated + outcome.rowsUpdated,
        detail: outcome.detail,
      };
    },
    triggeredById,
  );
}

/**
 * The Payment Status tab. Always a full reconcile: unlike orders, a payment
 * row's whole purpose is to CHANGE after it is written — Pending becomes
 * Received weeks later, in place, on a row that was created long ago. An
 * append run reads only new rows and would never see it.
 */
async function runPaymentSync(triggeredById?: string): Promise<JobResult> {
  return run(
    "sheet-payments",
    async () => {
      const spreadsheetId = process.env.ORDERS_SHEET_ID;
      if (!spreadsheetId) {
        return { recordsAffected: 0, detail: "ORDERS_SHEET_ID is not set — nothing to sync." };
      }
      const outcome = await syncPaymentSheet({
        source: "payment_status",
        spreadsheetId,
        tabTitle: process.env.PAYMENTS_SHEET_TAB ?? "Payment Status",
        mode: "reconcile",
        triggeredById,
      });
      return {
        recordsAffected: outcome.rowsCreated + outcome.rowsUpdated,
        detail: outcome.detail,
      };
    },
    triggeredById,
  );
}
