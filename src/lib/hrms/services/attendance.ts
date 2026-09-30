import "server-only";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { hrmsAttendance, hrmsHolidays, hrmsLeaveCredits, hrmsLeaveRequests, type HrmsAttendance } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { dayFigures, type AttendanceCfg, type DayFigures } from "../engines/attendance";
import { balances, holidayApplies, holidaysInside, type Balances, type HolidayRef } from "../engines/leave";
import { datesBetween, datesOfMonth, monthOf } from "../time";
import { today } from "../server";

/* ---------------------------------------------------------------------------
 * Attendance, holidays and leave, read the one way every screen reads them —
 * the register, the monthly report, payroll and performance must agree about
 * a day, so none of them computes a day's figures on its own.
 * ------------------------------------------------------------------------- */

export async function attendanceCfg(): Promise<AttendanceCfg & { privilegedRangeM: number; defaultWindowDays: number; lateOverMinutes: number }> {
  const c = await getConfig();
  return {
    graceMinutes: c["hrms.attendance.graceMinutes"],
    fullDayPercent: c["hrms.attendance.fullDayPercent"],
    qrGraceMinutes: c["hrms.attendance.qrGraceMinutes"],
    qrFullDayPercent: c["hrms.attendance.qrFullDayPercent"],
    privilegedRangeM: c["hrms.attendance.privilegedRangeM"],
    defaultWindowDays: c["hrms.attendance.defaultWindowDays"],
    lateOverMinutes: c["hrms.reports.lateOverMinutes"],
  };
}

export type DayRow = HrmsAttendance & { fig: DayFigures };

/** Attendance rows, optionally for some employees and a date range, each with its figures. */
export async function attendanceRows(opts: { employeeIds?: string[] | null; from?: string; to?: string }): Promise<DayRow[]> {
  const cfg = await attendanceCfg();
  const conds = [];
  if (opts.employeeIds) {
    if (!opts.employeeIds.length) return [];
    conds.push(inArray(hrmsAttendance.employeeId, opts.employeeIds));
  }
  if (opts.from) conds.push(gte(hrmsAttendance.date, opts.from));
  if (opts.to) conds.push(lte(hrmsAttendance.date, opts.to));
  const rows = await db
    .select()
    .from(hrmsAttendance)
    .where(conds.length ? and(...conds) : undefined);
  const t = today();
  return rows.map((r) => ({ ...r, fig: dayFigures({ ...r, targetMin: r.targetMin }, cfg, t) }));
}

export async function holidays(from?: string, to?: string): Promise<(HolidayRef & { id: string; name: string; category: string })[]> {
  const conds = [];
  if (from) conds.push(gte(hrmsHolidays.date, from));
  if (to) conds.push(lte(hrmsHolidays.date, to));
  const rows = await db.select().from(hrmsHolidays).where(conds.length ? and(...conds) : undefined);
  return rows.map((h) => ({ id: h.id, date: h.date, name: h.name, category: h.category, tagged: h.tagged, taggedEmployeeIds: h.taggedEmployeeIds }));
}

/** The holiday dates in a month that apply to one employee. */
export function holidayDatesFor(all: HolidayRef[], employeeId: string, office: string | null, month: string): string[] {
  return all.filter((h) => monthOf(h.date) === month && holidayApplies(h, employeeId, office)).map((h) => h.date);
}

/** Approved leave requests for some employees. */
export async function approvedLeave(employeeIds?: string[]) {
  const conds = [eq(hrmsLeaveRequests.status, "Approved")];
  if (employeeIds) {
    if (!employeeIds.length) return [];
    conds.push(inArray(hrmsLeaveRequests.employeeId, employeeIds));
  }
  return db.select().from(hrmsLeaveRequests).where(and(...conds));
}

/** Available paid leave (month) and unpaid leave (year) for one employee. */
export async function leaveBalances(employeeId: string, month: string, yearlyMax: number | null): Promise<Balances> {
  const [credits, approved] = await Promise.all([
    db.select({ month: hrmsLeaveCredits.month, days: hrmsLeaveCredits.days }).from(hrmsLeaveCredits).where(eq(hrmsLeaveCredits.employeeId, employeeId)),
    db
      .select({ startDate: hrmsLeaveRequests.startDate, paid: hrmsLeaveRequests.paid, unpaid: hrmsLeaveRequests.unpaid })
      .from(hrmsLeaveRequests)
      .where(and(eq(hrmsLeaveRequests.employeeId, employeeId), eq(hrmsLeaveRequests.status, "Approved"))),
  ]);
  return balances({ month, credits, approved, yearlyMax });
}

/** The leave dates of a set of approved requests that fall in a month. */
export function leaveDatesIn(requests: { startDate: string; endDate: string }[], month: string): string[] {
  const set = new Set<string>();
  for (const r of requests) for (const d of datesBetween(r.startDate, r.endDate)) if (monthOf(d) === month) set.add(d);
  return [...set].sort();
}

/** What the month's attendance, leave and holidays say for one employee (payroll's inputs). */
export function monthCounts(x: {
  employeeId: string;
  office: string | null;
  month: string;
  days: DayRow[];
  approved: { employeeId: string; type: string; startDate: string; endDate: string; days: number; paid: number | null; unpaid: number | null }[];
  holidays: HolidayRef[];
}) {
  const mine = x.days.filter((d) => d.employeeId === x.employeeId && monthOf(d.date) === x.month);
  const full = new Set(mine.filter((d) => d.fig.workDay === "Full Day").map((d) => d.date)).size;
  const half = new Set(mine.filter((d) => d.fig.workDay === "Half Day").map((d) => d.date)).size;
  const pending = new Set(mine.filter((d) => !d.checkOut).map((d) => d.date)).size;
  const late = mine.filter((d) => d.fig.lateBeyondGrace).length;
  /* Spec §10.1: only approved requests of type Leave reach payroll (A39). */
  const leave = x.approved.filter((r) => r.employeeId === x.employeeId && r.type === "Leave" && monthOf(r.startDate) === x.month);
  const paidLeave = leave.reduce((a, r) => a + Number(r.paid ?? 0), 0);
  const unpaidLeave = leave.reduce((a, r) => a + Number(r.unpaid ?? 0), 0);
  const leaveDays = leave.reduce((a, r) => a + Number(r.days), 0);
  const inside = leave.reduce((a, r) => a + holidaysInside(x.holidays, x.employeeId, x.office, r.startDate, r.endDate), 0);
  const official = x.holidays.filter((h) => monthOf(h.date) === x.month && holidayApplies(h, x.employeeId, x.office)).length;
  return { fullDays: full, halfDays: half, pendingCheckouts: pending, lateCount: late, paidLeave, unpaidLeave, leaveDays, holidaysInsideLeave: inside, officialHolidays: official };
}

/** Every date in a month, for callers that walk a calendar. */
export const monthDates = datesOfMonth;
