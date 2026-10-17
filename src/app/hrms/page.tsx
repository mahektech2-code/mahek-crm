import { and, eq, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { hrmsAttendance, hrmsBuddyTasks, hrmsChecklist, hrmsGrievances, hrmsHelp, hrmsLeaveRequests, hrmsOffices, hrmsTaskTemplates, hrmsTodos } from "@/db/schema";
import { hrmsContext } from "@/lib/hrms/access";
import { attendanceCfg, attendanceRows } from "@/lib/hrms/services/attendance";
import { allPeople, markableStaff, staffInReach, timingMap } from "@/lib/hrms/services/people";
import { timeRemark } from "@/lib/hrms/engines/attendance";
import { hrmsLink } from "@/lib/hrms/registry";
import { today } from "@/lib/hrms/server";
import { weekdayOf, hm, distanceLabel, tmin } from "@/lib/hrms/time";
import { getConfig } from "@/lib/config/store";
import { nowMs } from "@/lib/format";
import { HomeCard, type HomeState, type WaitItem } from "./_ui/home-card";
import { BUDDY_DONE, LEAVE_WAITING } from "@/lib/hrms/values";

export const dynamic = "force-dynamic";
export const metadata = { title: "Check in — HRMS — MahekOne" };

/**
 * Home: today's check-in card and what is waiting for this person today
 * (design "Check in"; the source opened on Make Attendance). Only items the
 * person can act on are listed, and each links to its screen.
 */
export default async function HrmsHome() {
  const ctx = await hrmsContext();
  const t = today();
  const me = ctx.employee;
  const cfg = await attendanceCfg();
  const config = await getConfig();

  let state: HomeState = { linked: false, name: ctx.user.name, date: t, qr: config["hrms.attendance.qrEnabled"], graceMinutes: cfg.graceMinutes, nowMs: nowMs() };
  if (me) {
    const [rows, timings, office] = await Promise.all([
      attendanceRows({ employeeIds: [me.id], from: t, to: t }),
      timingMap(),
      me.office ? db.select().from(hrmsOffices).where(eq(hrmsOffices.name, me.office)).limit(1) : Promise.resolve([]),
    ]);
    const tm = timings.get(`${me.id}|${weekdayOf(t)}`);
    const r = rows[0];
    state = {
      ...state,
      linked: true,
      name: me.name,
      office: me.office ?? "",
      officeHasPin: office[0]?.lat != null,
      official: tm ? `${tm.inTime} – ${tm.outTime}` : "",
      today: r
        ? {
            in: r.checkIn,
            out: r.checkOut,
            status: r.fig.current,
            late: r.fig.lateTxt,
            lateBad: r.fig.lateBeyondGrace || (r.fig.lateMin ?? 0) > 0,
            remark: timeRemark(r.fig, me.name, r.method),
            targetMin: r.targetMin,
            inMin: tmin(r.checkIn),
            workedMin: r.fig.workedMin,
            workDay: r.fig.workDay,
            fullDayPercent: cfg.fullDayPercent,
            distance: r.method === "officer" ? `Marked by ${r.markedByName ?? "your department head"}` : distanceLabel(r.distanceM),
            worked: hm(r.fig.workedMin),
            field: r.method === "field",
          }
        : null,
    };
  }

  const wait: WaitItem[] = [];
  const count = sql<number>`count(*)::int`;
  if (me) {
    const [pend] = await db.select({ n: count }).from(hrmsAttendance).where(and(eq(hrmsAttendance.employeeId, me.id), isNull(hrmsAttendance.checkOut), lt(hrmsAttendance.date, t)));
    if (pend.n) wait.push({ l: "Your pending check-outs", v: String(pend.n), sub: "Your salary for that month waits until you check out", tone: "danger", href: hrmsLink("pendingOut") });
    if (ctx.screens.has("checklist")) {
      const cl = await db.select({ status: hrmsChecklist.status }).from(hrmsChecklist).where(and(eq(hrmsChecklist.employeeId, me.id), eq(hrmsChecklist.date, t)));
      if (cl.length) {
        const open = cl.filter((x) => !x.status).length;
        wait.push({ l: "Today’s checklist", v: `${cl.length - open} of ${cl.length}`, sub: `${open} still open`, tone: open ? "brand" : "success", href: hrmsLink("checklist") });
      } else {
        const [tpl] = await db.select({ n: count }).from(hrmsTaskTemplates).where(and(eq(hrmsTaskTemplates.employeeId, me.id), sql`${hrmsTaskTemplates.frequency} <> 'Monthly'`));
        if (tpl.n) wait.push({ l: "Today’s checklist", v: "Not taken", sub: "Today’s tasks are not in your checklist yet", tone: "warn", href: hrmsLink("checklist") });
      }
    }
    if (ctx.screens.has("todos")) {
      const td = await db.select({ till: hrmsTodos.tillDate }).from(hrmsTodos).where(and(eq(hrmsTodos.toEmployeeId, me.id), eq(hrmsTodos.status, "Open")));
      if (td.length) {
        const od = td.filter((x) => x.till && x.till < t).length;
        wait.push({ l: "Open to-dos", v: String(td.length), sub: `${od} overdue`, tone: od ? "danger" : "neutral", href: hrmsLink("todos") });
      }
    }
    if (ctx.screens.has("buddy")) {
      const [bd] = await db
        .select({ n: count })
        .from(hrmsBuddyTasks)
        .where(and(eq(hrmsBuddyTasks.toEmployeeId, me.id), eq(hrmsBuddyTasks.date, t), ne(hrmsBuddyTasks.status, BUDDY_DONE)));
      if (bd.n) wait.push({ l: "Buddy tasks shared with you", v: String(bd.n), sub: "", tone: "brand", href: hrmsLink("buddy") });
    }
  }
  if (ctx.screens.has("approvals") && ctx.powers.has("approveLeave")) {
    const [n] = await db.select({ n: count }).from(hrmsLeaveRequests).where(eq(hrmsLeaveRequests.status, LEAVE_WAITING));
    if (n.n) wait.push({ l: "Leave requests awaiting approval", v: String(n.n), sub: "", tone: "warn", href: hrmsLink("approvals") });
  }
  if (ctx.powers.has("checkoutStaff") && ctx.screens.has("pendingOut")) {
    /* Only the people this person may actually check out: a head's team and
       office, not the whole company still at work. */
    const open = await db.select({ employeeId: hrmsAttendance.employeeId }).from(hrmsAttendance).where(and(eq(hrmsAttendance.date, t), isNull(hrmsAttendance.checkOut)));
    const reach = staffInReach(ctx, await allPeople(), "checkoutStaff");
    const n = { n: open.filter((x) => x.employeeId !== me?.id && (!reach || reach.has(x.employeeId))).length };
    if (n.n) wait.push({ l: "Staff still checked in today", v: String(n.n), sub: "Check them out at the end of the day", tone: "neutral", href: hrmsLink("pendingOut") });
  }
  if (ctx.powers.has("markStaff") && ctx.screens.has("attendance")) {
    const [people, todays] = await Promise.all([allPeople(), attendanceRows({ from: t, to: t })]);
    const marked = new Set(todays.map((x) => x.employeeId));
    const n = markableStaff(ctx, people, ctx.powers.has("hr") || ctx.administrator).filter((p) => !marked.has(p.id)).length;
    if (n) wait.push({ l: "Staff not yet marked today", v: String(n), sub: "Mark attendance for field and other staff of your office", tone: "warn", href: hrmsLink("attendance") });
  }
  if (ctx.powers.has("resolve")) {
    const [h] = await db.select({ n: count }).from(hrmsHelp).where(eq(hrmsHelp.status, "Pending"));
    if (h.n && ctx.screens.has("help")) wait.push({ l: "Help requests waiting", v: String(h.n), sub: "", tone: "warn", href: hrmsLink("help") });
    const [g] = await db.select({ n: count }).from(hrmsGrievances).where(eq(hrmsGrievances.status, "Pending"));
    if (g.n && ctx.screens.has("grievances")) wait.push({ l: "Grievances waiting", v: String(g.n), sub: "", tone: "warn", href: hrmsLink("grievances") });
  } else if (me && ctx.screens.has("grievances")) {
    const [g] = await db.select({ n: count }).from(hrmsGrievances).where(and(eq(hrmsGrievances.status, "Pending"), eq(hrmsGrievances.toEmployeeId, me.id)));
    if (g.n) wait.push({ l: "Grievances addressed to you", v: String(g.n), sub: "", tone: "warn", href: hrmsLink("grievances") });
  }

  return <HomeCard state={state} wait={wait} canHelp={ctx.screens.has("help")} />;
}
