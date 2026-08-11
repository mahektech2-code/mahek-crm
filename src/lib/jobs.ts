import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { mbosHourly, mbosNightly } from "@/lib/mbos-jobs";
import {
  complaints,
  jobRuns,
  notifications,
  queueSnapshots,
  reminders,
  users,
} from "@/db/schema";
import { getConfig } from "./config/store";
import { money } from "./format";
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
  orderSheetId,
  orderTabTitle,
  paymentTabTitle,
  syncOrderSheet,
  syncPaymentSheet,
  type SyncMode,
} from "./services/sheet-sync-service";
import { syncPartySheet } from "./services/party-sync-service";
import { syncTakenOrderSheet } from "./services/taken-order-sync-service";
import { projectSheet, revertSheetSettledBills } from "./services/sheet-projection-service";
import { projectParties } from "./services/party-projection-service";
import { provisionBackOffice } from "./services/team-service";
import {
  employeeSheetId,
  syncEmployeeSheet,
} from "./services/employee-sync-service";

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
  | "hrms-sync"
  | "hrms-reparse"
  | "sheet-payments"
  | "taken-order-sync"
  | "taken-order-reparse"
  | "party-sync"
  | "project-sheet"
  | "revert-sheet-paid"
  | "provision-team"
  | "mbos-nightly"
  | "mbos-hourly";

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

  /* The field app's nightly tidy-up rides the same schedule as the CRM's.
     One cron, one place to look when something did not run. */
  results.push(await run("mbos-nightly", mbosNightly, triggeredById));

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

  results.push(await run("mbos-hourly", mbosHourly, triggeredById));

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

/**
 * Options a job may be given.
 *
 * Most jobs need none — a nightly recompute has nothing to decide. The
 * projections do: who imported customers answer to, and whether parties that
 * have never ordered become leads. Both are business decisions, so they are
 * passed in at the call rather than buried in a default nobody sees.
 */
export type JobOptions = {
  /** Email of the user imported customers are assigned to. */
  owner?: string;
  /** Create the never-ordered parties as leads. */
  leads?: boolean;
  /** Write bills and payments from the Payment Status tab. */
  bills?: boolean;
  /** Move customers that already exist to `owner`, not just new ones. */
  reassign?: boolean;
  /** Password for accounts the team provisioning creates. Never for existing ones. */
  password?: string;
  /**
   * Report what would change and write nothing. Offered by the jobs that
   * delete — a count read before the fact is the only review a destructive
   * run gets.
   */
  dryRun?: boolean;
};

export async function runJob(
  job: JobName,
  triggeredById?: string,
  options: JobOptions = {},
): Promise<JobResult[]> {
  switch (job) {
    case "nightly":
      return runNightly(triggeredById);
    case "hourly":
      return runHourly(triggeredById);
    case "day-boundary":
      return runDayBoundary(triggeredById);
    case "mbos-nightly":
      return [await run("mbos-nightly", mbosNightly, triggeredById)];
    case "mbos-hourly":
      return [await run("mbos-hourly", mbosHourly, triggeredById)];
    case "sheet-append":
    case "sheet-reconcile":
    case "sheet-reparse":
      return [await runSheetSync(job, triggeredById)];
    case "sheet-payments":
      return [await runPaymentSync(triggeredById)];
    case "taken-order-sync":
    case "taken-order-reparse":
      return [await runTakenOrderSync(job, triggeredById)];
    case "party-sync":
      return [await runPartySync(triggeredById)];
    case "project-sheet":
      return [await runProjection(triggeredById, options)];
    case "revert-sheet-paid":
      return [await runRevertSheetPaid(triggeredById, options)];
    case "provision-team":
      return [await runTeamProvision(triggeredById, options)];
    case "hrms-sync":
    case "hrms-reparse":
      return [await runEmployeeSync(job, triggeredById)];
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
      const outcome = await syncOrderSheet({
        source: "order_details",
        spreadsheetId: orderSheetId(),
        tabTitle: orderTabTitle(),
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
      const outcome = await syncPaymentSheet({
        source: "payment_status",
        spreadsheetId: orderSheetId(),
        tabTitle: paymentTabTitle(),
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

/* -------------------------------------------------- the employee sheet */

/**
 * The employee master, kept level with the Employee Details tab.
 *
 * One job and not three. The order sheet needs a cheap append and an expensive
 * reconcile because it is heading for thirty thousand rows; this tab is a
 * company's payroll, so a full compare is a single API call and the hashes
 * make an unchanged sheet cost no writes at all. That makes reconcile
 * affordable at the frequency append would have run at — and it is the only
 * mode that sees a salary corrected, a leaver marked Inactive, or a row
 * deleted. Watching for new rows alone would miss all three.
 *
 * `hrms-reparse` touches Google not at all and re-reads what is stored. It is
 * the one to run after a date-reading rule is corrected.
 */
async function runEmployeeSync(
  job: "hrms-sync" | "hrms-reparse",
  triggeredById?: string,
): Promise<JobResult> {
  return run(
    job,
    async () => {
      const outcome = await syncEmployeeSheet({
        spreadsheetId: employeeSheetId(),
        mode: job === "hrms-reparse" ? "reparse" : "reconcile",
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
 * The Taken Order tab: orders as the team types them, before dispatch.
 *
 * Reconcile only, for the payment tab's reason rather than the party tab's. A
 * row here exists in order to change after it is written — `Hold From Office`
 * becomes `Ready` days later, in place — and an append run, which reads only
 * past the highest row it has seen, would never witness a single release.
 *
 * It ends by rebuilding `customers.activeInOrderSystem`, which is what the
 * calling queue suppresses on. That is the point of the job; landing the rows
 * is how it gets there.
 *
 * `taken-order-reparse` touches Google not at all and re-reads what is stored.
 * It is the one to run after the meaning of a status changes — the hashes make
 * an unchanged sheet free, which is exactly wrong when it is the rule that
 * moved rather than the rows.
 */
async function runTakenOrderSync(
  job: "taken-order-sync" | "taken-order-reparse",
  triggeredById?: string,
): Promise<JobResult> {
  return run(
    job,
    async () => {
      const outcome = await syncTakenOrderSheet({
        mode: job === "taken-order-reparse" ? "reparse" : "reconcile",
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
 * The customer master. Reconcile only — the list changes in place, and an
 * append run would never see a number corrected or a party marked Deactive.
 */
async function runPartySync(triggeredById?: string): Promise<JobResult> {
  return run(
    "party-sync",
    async () => {
      const outcome = await syncPartySheet({ triggeredById });
      return {
        recordsAffected: outcome.rowsCreated + outcome.rowsUpdated,
        detail: outcome.detail,
      };
    },
    triggeredById,
  );
}

/**
 * Landing the sheets is not the same as believing them, and this is the second
 * act: imported rows become customers, orders, and — only if asked — bills.
 *
 * It is a job rather than a script because production has no shell, and the
 * whole point of the last few changes is that a deployed machine can do what a
 * laptop could. It is not on any schedule: a projection assigns accounts to
 * people and can create leads, and neither should happen because a clock went
 * round.
 *
 * Order matters. Orders first, because they create the customer rows the party
 * master then fills in — running the master first would find nobody to give a
 * phone number to.
 */
async function runProjection(
  triggeredById?: string,
  options: JobOptions = {},
): Promise<JobResult> {
  return run(
    "project-sheet",
    async () => {
      let ownerId: string | null = null;
      if (options.owner) {
        const owner = await db.query.users.findFirst({
          where: eq(users.email, options.owner),
        });
        if (!owner) {
          return {
            recordsAffected: 0,
            detail: `No user with the email ${options.owner}, so nothing was assigned.`,
          };
        }
        ownerId = owner.id;
      }

      const orders = await projectSheet({
        assignToUserId: ownerId,
        includeBills: options.bills ?? false,
        reassign: options.reassign ?? false,
      });
      const parties = await projectParties({
        createLeads: options.leads ?? false,
        leadOwnerId: ownerId,
      });

      const detail =
        `customers ${orders.customers.created} new / ${orders.customers.updated} updated, ` +
        `orders ${orders.orders.created} new (${orders.orders.lines} lines), ` +
        `bills ${orders.bills.skipped ? "skipped" : orders.bills.created}` +
        (orders.bills.clashed ? ` (${orders.bills.clashed} bill numbers already taken)` : "") +
        (orders.bills.leftUnpaid
          ? ` (${orders.bills.leftUnpaid} left unpaid on the Payment Status tab's word)`
          : "") + ", " +
        `master matched ${parties.matched}, phones ${parties.phonesFilled}, ` +
        `leads ${parties.leadsCreated}/${parties.leadsAvailable}` +
        (options.reassign ? ", reassigned to the given owner" : "") +
        (orders.customers.unassigned
          ? `, ${orders.customers.unassigned} customers in nobody's book`
          : "");

      return {
        recordsAffected:
          orders.customers.created + orders.orders.created + parties.matched,
        detail,
      };
    },
    triggeredById,
  );
}

/**
 * Give back the outstanding that a default-settled projection wrote over.
 *
 * BY HAND, NEVER SCHEDULED. It deletes receipts, and a delete on a schedule is
 * a delete nobody reads the output of. Run `--dry-run` first: it reports the
 * count, the money and how many customers are affected while writing nothing,
 * which is the only review this gets before rows go.
 *
 * It is also not a job that should ever need running twice. The importer no
 * longer settles a bill the Payment Status tab calls unpaid, so this cleans up
 * what the old behaviour left behind rather than holding a line against it.
 */
async function runRevertSheetPaid(
  triggeredById?: string,
  options: JobOptions = {},
): Promise<JobResult> {
  return run(
    "revert-sheet-paid",
    async () => {
      const report = await revertSheetSettledBills({ dryRun: options.dryRun });
      const restored = money(report.restoredPaise);
      const detail = report.dryRun
        ? `dry run — ${report.deleted} receipts would go, giving ${restored} of outstanding ` +
          `back to ${report.customers} customers. ${report.kept} sheet receipts would be kept.`
        : `${report.deleted} receipts deleted, ${restored} of outstanding restored to ` +
          `${report.customers} customers. ${report.kept} sheet receipts kept.`;

      // A dry run affects nothing, and saying otherwise would put a number in
      // the job log for work that never happened.
      return { recordsAffected: report.dryRun ? 0 : report.deleted, detail };
    },
    triggeredById,
  );
}

/**
 * Give the back office team logins, and hand each of them the accounts the
 * customer master says they work.
 *
 * Not scheduled, and never will be: it creates people and moves books.
 */
async function runTeamProvision(
  triggeredById?: string,
  options: JobOptions = {},
): Promise<JobResult> {
  return run(
    "provision-team",
    async () => {
      if (!options.password) {
        return {
          recordsAffected: 0,
          detail: "Give a password for the accounts this creates (&password=).",
        };
      }
      const report = await provisionBackOffice({ password: options.password });
      const made = report.people.filter((p) => p.created);
      const detail =
        `${report.people.length} named on the master` +
        (made.length ? `, ${made.length} accounts created (${made.map((m) => m.email).join(", ")})` : ", no new accounts") +
        `, ${report.assigned} records handed over (${report.assignedLeads} of them leads)` +
        `, ${report.untagged} parties tagged to nobody`;
      return { recordsAffected: report.assigned, detail };
    },
    triggeredById,
  );
}
