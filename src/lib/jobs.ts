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
import { autoGenerateEodReports } from "./services/eod-service";
import { isWorkingDay, nextWorkingDay, type BusinessDate } from "./business-date";
import { buildQueue } from "./engines/queue";
import { queueCandidatesFor } from "./services/queue-service";

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
  | "roll-reminders";

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
