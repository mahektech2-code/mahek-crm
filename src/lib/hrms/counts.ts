import "server-only";
import { cache } from "react";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { hrmsAttendance, hrmsExpenses, hrmsGrievances, hrmsHelp, hrmsLeaveRequests, hrmsSalaries } from "@/db/schema";
import { decidesLeave, type HrmsContext } from "./access";
import { today } from "./server";
import { LEAVE_WAITING } from "./values";

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
  const team = [...ctx.team].filter((id) => id !== me);
  const managesTeam = ctx.level === "manager" && !ctx.administrator && team.length > 0;
  if (ctx.screens.has("approvals") && decidesLeave(ctx)) {
    /* A manager is counted their team's requests only — the ones they decide. */
    const wide = ctx.administrator || ctx.granted.has("approveLeave");
    if (wide || team.length)
      jobs.push(
        db
          .select({ n: count })
          .from(hrmsLeaveRequests)
          .where(and(eq(hrmsLeaveRequests.status, LEAVE_WAITING), wide ? undefined : inArray(hrmsLeaveRequests.employeeId, team)))
          .then((r) => void (out.approvals = n(r))),
      );
  }
  /* A manager without the resolve power is counted their team's help requests
     and unverified expense claims — the ones they may act on. */
  if (ctx.screens.has("help") && ctx.powers.has("resolve"))
    jobs.push(db.select({ n: count }).from(hrmsHelp).where(eq(hrmsHelp.status, "Pending")).then((r) => void (out.help = n(r))));
  else if (ctx.screens.has("help") && managesTeam)
    jobs.push(
      db.select({ n: count }).from(hrmsHelp).where(and(eq(hrmsHelp.status, "Pending"), inArray(hrmsHelp.employeeId, team)))
        .then((r) => void (out.help = n(r))),
    );
  if (ctx.screens.has("expenses") && !ctx.powers.has("verifyExp") && managesTeam)
    jobs.push(
      db.select({ n: count }).from(hrmsExpenses).where(and(sql`${hrmsExpenses.verify} <> 'Verified'`, inArray(hrmsExpenses.employeeId, team)))
        .then((r) => void (out.expenses = n(r))),
    );
  if (ctx.screens.has("grievances") && ctx.powers.has("resolve"))
    jobs.push(db.select({ n: count }).from(hrmsGrievances).where(eq(hrmsGrievances.status, "Pending")).then((r) => void (out.grievances = n(r))));
  /* Somebody a grievance is addressed to answers it too: the home page said
     so and the badge did not. */ else if (me && ctx.screens.has("grievances"))
    jobs.push(
      db.select({ n: count }).from(hrmsGrievances).where(and(eq(hrmsGrievances.status, "Pending"), eq(hrmsGrievances.toEmployeeId, me)))
        .then((r) => void (out.grievances = n(r))),
    );
  if (ctx.screens.has("payroll") && (ctx.powers.has("payroll") || ctx.powers.has("pay")))
    jobs.push(db.select({ n: count }).from(hrmsSalaries).where(sql`${hrmsSalaries.status} <> 'Paid'`).then((r) => void (out.payroll = n(r))));
  await Promise.all(jobs);
  return out;
});
