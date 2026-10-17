import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { employees, hrmsLeaveCredits } from "@/db/schema";
import { hrmsId, today } from "./server";
import { monthOf } from "./time";

/* ---------------------------------------------------------------------------
 * HRMS scheduled work (spec §18). Every job is idempotent and has a manual
 * "Run now", so running it twice — or by hand after the schedule already did —
 * changes nothing the second time.
 * ------------------------------------------------------------------------- */

/**
 * The monthly paid-leave credit (spec §7.4 / §18.1): one `source = 'job'`
 * credit per ACTIVE employee per month, worth their monthly paid leave.
 *
 * The partial unique index on (employee, month) where source = 'job' is what
 * makes this idempotent — not the read below, which only saves the inserts.
 * Two runs racing each other both try, and the index lets exactly one land.
 * A hand-added correction for the month does not stop the job's credit: it
 * is a correction ON TOP of the entitlement, not a substitute for it.
 *
 * An employee with no monthly paid leave on their record is skipped rather
 * than credited zero: a zero row would mark the month done, and the credit
 * HR meant to give would never arrive once they fill the figure in.
 */
export async function runMonthlyLeaveCredit(month?: string): Promise<{ created: number }> {
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : monthOf(today());
  const [people, done] = await Promise.all([
    db.select({ id: employees.id, days: employees.monthlyPaidLeave }).from(employees).where(eq(employees.status, "active")),
    db
      .select({ employeeId: hrmsLeaveCredits.employeeId })
      .from(hrmsLeaveCredits)
      .where(and(eq(hrmsLeaveCredits.month, m), eq(hrmsLeaveCredits.source, "job"))),
  ]);
  const have = new Set(done.map((d) => d.employeeId));
  const due = people.filter((p) => !have.has(p.id) && p.days != null && Number(p.days) > 0);
  if (!due.length) return { created: 0 };
  const res = await db
    .insert(hrmsLeaveCredits)
    .values(due.map((p) => ({ id: hrmsId("hlc"), employeeId: p.id, month: m, days: Number(p.days), source: "job" })))
    .onConflictDoNothing()
    .returning({ id: hrmsLeaveCredits.id });
  return { created: res.length };
}
