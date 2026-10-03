import "server-only";
import { cache } from "react";
import { and, eq, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { hrmsAttendance, hrmsBuddyTasks, hrmsGrievances, hrmsHelp, hrmsLeaveRequests, hrmsSalaries, hrmsTodos } from "@/db/schema";
import type { HrmsContext } from "./access";
import { today } from "./server";
import { BUDDY_DONE, LEAVE_WAITING } from "./values";

/* ---------------------------------------------------------------------------
 * What is waiting on each screen for this person — the sidebar's badges.
 * Only work waiting on THEM: a count they cannot act on is noise.
 * ------------------------------------------------------------------------- */

/** Cached per request: the layout draws the sidebar badges and the page the tab badges. */
export const hrmsNavCounts = cache(async function hrmsNavCounts(ctx: HrmsContext): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const me = ctx.employee?.id ?? null;
  const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);
  const count = sql<number>`count(*)::int`;
  const jobs: Promise<void>[] = [];
  if (me && ctx.screens.has("pendingOut"))
    jobs.push(
      db.select({ n: count }).from(hrmsAttendance).where(and(eq(hrmsAttendance.employeeId, me), isNull(hrmsAttendance.checkOut), lt(hrmsAttendance.date, today())))
        .then((r) => void (out.pendingOut = n(r))),
    );
  if (ctx.screens.has("approvals") && ctx.powers.has("approveLeave"))
    jobs.push(db.select({ n: count }).from(hrmsLeaveRequests).where(eq(hrmsLeaveRequests.status, LEAVE_WAITING)).then((r) => void (out.approvals = n(r))));
  if (ctx.screens.has("help") && ctx.powers.has("resolve"))
    jobs.push(db.select({ n: count }).from(hrmsHelp).where(eq(hrmsHelp.status, "Pending")).then((r) => void (out.help = n(r))));
  if (ctx.screens.has("grievances") && ctx.powers.has("resolve"))
    jobs.push(db.select({ n: count }).from(hrmsGrievances).where(eq(hrmsGrievances.status, "Pending")).then((r) => void (out.grievances = n(r))));
  if (me && ctx.screens.has("todos"))
    jobs.push(db.select({ n: count }).from(hrmsTodos).where(and(eq(hrmsTodos.toEmployeeId, me), eq(hrmsTodos.status, "Open"))).then((r) => void (out.todos = n(r))));
  if (me && ctx.screens.has("buddy"))
    jobs.push(
      db.select({ n: count }).from(hrmsBuddyTasks).where(and(eq(hrmsBuddyTasks.toEmployeeId, me), eq(hrmsBuddyTasks.date, today()), ne(hrmsBuddyTasks.status, BUDDY_DONE)))
        .then((r) => void (out.buddy = n(r))),
    );
  if (ctx.screens.has("payroll") && (ctx.powers.has("payroll") || ctx.powers.has("pay")))
    jobs.push(db.select({ n: count }).from(hrmsSalaries).where(sql`${hrmsSalaries.status} <> 'Paid'`).then((r) => void (out.payroll = n(r))));
  await Promise.all(jobs);
  return out;
});
