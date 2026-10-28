import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments, employees, hrmsAttendance, hrmsLeaveCredits, hrmsLeaveRequests, hrmsMonthlyRemarks, hrmsOvertime } from "@/db/schema";
import { has } from "@/lib/hrms/access";
import { first, today } from "@/lib/hrms/server";
import { fdShort, hm, monLabel, monthOf } from "@/lib/hrms/time";
import { LEAVE_WAITING } from "@/lib/hrms/values";
import { canOtAnyone, readMonthlyKey } from "@/lib/hrms/screens/leave";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { many, present } from "./erp-common";
import { countOf, employeeName, hrmsMayAct, linkedUsers, monthsBetween, salariesFor, salaryExamples, SALARY_KEPT_NOTE } from "./hrms-common";

/* ---------------------------------------------------------------------------
 * HRMS's time records: a leave request, a leave credit, an overtime record, a
 * monthly report's remark and an attendance day.
 *
 * Most of what these feed is DERIVED — payroll, the monthly report, the
 * absentee list and a leave balance are worked out from the rows on every
 * read — so a delete moves them without touching a second row, and the person
 * pressing it sees one line on one screen. Approved leave also reaches the
 * field: the Sales Dashboard's attendance verdict reads it and re-judges the
 * days tonight. What a delete does NOT reach is a salary already made, whose
 * figures payroll froze; that is said too, because people assume money follows.
 * ------------------------------------------------------------------------- */

const span = (a: string, b: string) => (a === b ? fdShort(a) : `${fdShort(a)} – ${fdShort(b)}`);

/* ========================================================== leave request */

export const leaveRequestImpact: ImpactSource = {
  /* Whoever decides leave, or the person themself while it is still waiting —
     the act's own rule, on either screen it is offered on. */
  authorize: async (id) => {
    await hrmsMayAct(["leave", "approvals"], async (ctx) => {
      const [r] = await db.select({ employeeId: hrmsLeaveRequests.employeeId, status: hrmsLeaveRequests.status }).from(hrmsLeaveRequests).where(eq(hrmsLeaveRequests.id, id));
      if (!r) return null;
      const own = r.employeeId === ctx.employee?.id && r.status === LEAVE_WAITING;
      return has(ctx, "approveLeave") || own ? null : "You can delete only your own request, and only while it is waiting for a decision";
    });
  },

  async report(id) {
    const [r] = await db.select().from(hrmsLeaveRequests).where(eq(hrmsLeaveRequests.id, id));
    if (!r) return null;
    const name = await employeeName(r.employeeId);
    const when = span(r.startDate, r.endDate);
    const items: ImpactItem[] = [];

    /* Only approved leave is read anywhere else; a waiting or rejected request
       is a request, and deleting it touches nothing but itself. */
    if (r.status === "Approved") {
      const days = Number(r.days);
      const paid = Number(r.paid ?? 0);
      items.push({
        app: "HRMS",
        label: many(days, "day of approved leave", "days of approved leave"),
        effect: "changed",
        count: days,
        note:
          `Payroll, the monthly report and the absentee list read ${when} as working days again — a day not worked shows as absent` +
          (paid > 0 ? `, and the ${paid} paid ${many(paid, "day goes", "days go")} back to ${first(name)}’s balance.` : "."),
      });
      const accounts = (await linkedUsers([r.employeeId])).map((u) => u.id);
      const fieldDays = accounts.length
        ? await countOf(sql`select count(*)::int as n from mbos_attendance_days
             where user_id in ${accounts} and day between ${r.startDate}::date and ${r.endDate}::date`)
        : 0;
      items.push({
        app: "Sales Dashboard",
        label: many(fieldDays, "field attendance day", "field attendance days"),
        effect: "changed",
        count: fieldDays,
        note: "The field attendance verdict reads HRMS’s approved leave; tonight’s pass judges these days again without it.",
      });
      const salaries = await salariesFor(r.employeeId, monthsBetween(r.startDate, r.endDate));
      items.push({
        app: "HRMS",
        label: many(salaries.length, "salary already made for those days", "salaries already made for those days"),
        effect: "kept",
        count: salaries.length,
        examples: salaryExamples(salaries),
        note: SALARY_KEPT_NOTE,
      });
    }

    return {
      title: `${name}’s ${r.type} leave, ${when} (${r.reqNo})`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: present(items),
      blockers: [],
    };
  },
};

/* =========================================================== leave credit */

export const leaveCreditImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["leaveSetup"], (ctx) => (has(ctx, "admin") ? null : "Only an HRMS administrator can delete a credit"));
  },

  async report(id) {
    const [c] = await db.select().from(hrmsLeaveCredits).where(eq(hrmsLeaveCredits.id, id));
    if (!c) return null;
    const [e] = await db.select({ name: employees.name, status: employees.status, monthly: employees.monthlyPaidLeave }).from(employees).where(eq(employees.id, c.employeeId));
    const name = e?.name ?? "this employee";
    const days = Number(c.days);
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: many(days, `paid-leave day in ${first(name)}’s balance`, `paid-leave days in ${first(name)}’s balance`),
        effect: "changed",
        count: days,
        note: "The balance the apply form and the approvals queue quote drops by this much. Leave already approved stays approved, even where it now runs past the balance.",
      },
    ];
    /* The monthly job credits the month to every active employee with no job
       credit for it — so a job credit deleted in its own month is back by
       morning, and the delete looks like it did nothing. Said, with the way
       that works. */
    const again = c.source === "job" && c.month === monthOf(today()) && e?.status === "active" && Number(e?.monthly ?? 0) > 0;
    if (again)
      items.push({
        app: "HRMS",
        label: "credit made again by tonight’s monthly job",
        effect: "changed",
        count: 1,
        note: `The monthly job credits ${monLabel(c.month)} to every active employee who has no job credit for it, so this one comes back tonight. To give fewer days, edit the credit instead.`,
      });
    return {
      title: `${name}’s ${monLabel(c.month)} leave credit (${days} ${many(days, "day")})`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: present(items),
      blockers: [],
    };
  },
};

/* =============================================================== overtime */

export const overtimeImpact: ImpactSource = {
  authorize: async (id) => {
    await hrmsMayAct(["overtime"], async (ctx) => {
      if (!ctx.flags.ot) return "Overtime is switched off in HRMS settings.";
      const [r] = await db.select({ employeeId: hrmsOvertime.employeeId }).from(hrmsOvertime).where(eq(hrmsOvertime.id, id));
      if (!r) return null;
      return r.employeeId === ctx.employee?.id || canOtAnyone(ctx) ? null : "Only the employee, HR or an HRMS administrator can delete this overtime";
    });
  },

  /* Nothing else reads an overtime record — payroll does not pay it — so the
     record is all that goes. */
  async report(id) {
    const [r] = await db.select().from(hrmsOvertime).where(eq(hrmsOvertime.id, id));
    if (!r) return null;
    const name = await employeeName(r.employeeId);
    return {
      title: `${name}’s overtime on ${fdShort(r.date)} (${hm(r.minutes)}, ${r.slot})`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: [],
      blockers: [],
    };
  },
};

/* ========================================================= monthly remark */

export const monthlyRemarkImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["monthly"], (ctx) => (has(ctx, "admin") ? null : "Only an HRMS administrator can delete a report remark"));
  },

  /* The remark is the only thing the monthly report stores; the report itself
     is worked out from attendance every time and does not go with it. */
  async report(id) {
    const k = readMonthlyKey(id);
    if (!k) return null;
    const [rm] = await db
      .select({ remark: hrmsMonthlyRemarks.remark })
      .from(hrmsMonthlyRemarks)
      .where(and(eq(hrmsMonthlyRemarks.employeeId, k.employeeId), eq(hrmsMonthlyRemarks.month, k.month)));
    if (!rm) return null;
    const name = await employeeName(k.employeeId);
    return {
      title: `the remark on ${name}’s ${monLabel(k.month)} report`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: [],
      blockers: [],
    };
  },
};

/* ========================================================= attendance day */

export const attendanceDayImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["attendance"], (ctx) => (has(ctx, "editAtt") ? null : "Only someone who can edit attendance can delete it"));
  },

  async report(id) {
    const [d] = await db.select().from(hrmsAttendance).where(eq(hrmsAttendance.id, id));
    if (!d) return null;
    const name = await employeeName(d.employeeId);
    const [photos, overtime, salaries] = await Promise.all([
      db
        .select({ id: attachments.id })
        .from(attachments)
        .where(and(eq(attachments.parentType, "hrms_attendance"), eq(attachments.parentId, id), ne(attachments.status, "removed"))),
      db.select({ id: hrmsOvertime.id, minutes: hrmsOvertime.minutes }).from(hrmsOvertime).where(and(eq(hrmsOvertime.employeeId, d.employeeId), eq(hrmsOvertime.date, d.date))),
      salariesFor(d.employeeId, [monthOf(d.date)]),
    ]);
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: "day in payroll and the monthly report",
        effect: "changed",
        count: 1,
        note: `With no attendance, ${fdShort(d.date)} reads as absent — unless it is leave or a holiday — in payroll, the monthly report and the absentee list.`,
      },
      {
        app: "HRMS",
        label: many(photos.length, "check-in photograph"),
        effect: "deleted",
        count: photos.length,
        note: "Taken off the day; the file itself is kept until retention removes it.",
      },
      {
        app: "HRMS",
        label: "overtime record on that day",
        effect: "kept",
        count: overtime.length,
        examples: overtime.map((o) => hm(o.minutes)),
        note: "Its start and end were read from this day, and stay as they were.",
      },
      {
        app: "HRMS",
        label: `salary already made for ${monLabel(monthOf(d.date))}`,
        effect: "kept",
        count: salaries.length,
        examples: salaryExamples(salaries),
        note: SALARY_KEPT_NOTE,
      },
    ];
    return {
      title: `${name}’s attendance on ${fdShort(d.date)} (in ${d.checkIn}${d.checkOut ? `, out ${d.checkOut}` : ""})`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: present(items),
      blockers: [],
    };
  },
};
