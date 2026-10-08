import "server-only";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { hrmsAttendance, hrmsHolidays, hrmsLeaveRequests, hrmsStaffTimings, type HrmsAttendance } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { dayFigures, minutesBetween, type AttendanceCfg, type DayFigures } from "../engines/attendance";
import { holidayApplies, holidaysInside, type HolidayRef } from "../engines/leave";
import { datesBetween, monthOf, nowHM, tmin, weekdayOf } from "../time";
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

/**
 * Attendance rows, optionally for some employees and a date range, each with
 * its figures.
 *
 * ONE RECORD OF WHO WAS AT WORK. A field salesman checks in on the handset,
 * which writes `mbos_attendance_days`, and HRMS used to read only its own
 * table — so his days did not exist for the register, the monthly summary,
 * the absentee list or payroll, and a salary prepared for him counted him
 * absent every day he had worked. His handset days are read here as rows of
 * the register, method "field", for anybody whose MahekOne account is linked
 * to their employee record. They are read-only in HRMS (`isFieldDay`): the
 * handset and the Sales Dashboard's attendance screen are where they are
 * corrected. Where a person has both a web check-in and a handset day on one
 * date, the web row is the day — it is the one HRMS can edit.
 */
export async function attendanceRows(opts: { employeeIds?: string[] | null; from?: string; to?: string }): Promise<DayRow[]> {
  const cfg = await attendanceCfg();
  const conds = [];
  if (opts.employeeIds) {
    if (!opts.employeeIds.length) return [];
    conds.push(inArray(hrmsAttendance.employeeId, opts.employeeIds));
  }
  if (opts.from) conds.push(gte(hrmsAttendance.date, opts.from));
  if (opts.to) conds.push(lte(hrmsAttendance.date, opts.to));
  const [rows, field] = await Promise.all([db.select().from(hrmsAttendance).where(conds.length ? and(...conds) : undefined), fieldDays(opts)]);
  const t = today();
  const web = new Set(rows.map((r) => `${r.employeeId}|${r.date}`));
  const all = [...rows, ...field.filter((f) => !web.has(`${f.employeeId}|${f.date}`))];
  return all.map((r) => ({ ...r, fig: dayFigures({ ...r, targetMin: r.targetMin }, cfg, t) }));
}

/** A register row that is a handset day, read from the field app and corrected there. */
export const isFieldDay = (r: { id: string }) => r.id.startsWith(FIELD_PREFIX);
const FIELD_PREFIX = "mbos:";

/** HH:MM in the business's zone — a stored instant named in its zone before it becomes a wall clock. */
const hhmm = (at: Date | string | null) => (at ? nowHM(new Date(at)) : null);

/** The handset's days, as register rows. */
async function fieldDays(opts: { employeeIds?: string[] | null; from?: string; to?: string }): Promise<HrmsAttendance[]> {
  const rows = (await db.execute(sql`
    select d.id, u.employee_id as "employeeId", d.day::text as "date", e.office_name as "officeName",
           d.check_in_at as "checkInAt", d.check_out_at as "checkOutAt",
           d.check_in_lat as "lat", d.check_in_lng as "lng", d.check_in_accuracy_m as "accuracy",
           d.check_out_lat as "outLat", d.check_out_lng as "outLng",
           d.check_in_selfie_id as "inPhotoId", d.check_out_selfie_id as "outPhotoId",
           d.worked_seconds as "workedSeconds", d.auto_checked_out as "auto",
           d.geofence_distance_m as "distanceM", d.server_created_at as "createdAt", d.updated_at as "updatedAt"
      from mbos_attendance_days d
      join users u on u.id = d.user_id and u.employee_id is not null
      join employees e on e.id = u.employee_id
     where d.check_in_at is not null
       ${opts.employeeIds ? sql`and u.employee_id in ${opts.employeeIds}` : sql``}
       ${opts.from ? sql`and d.day >= ${opts.from}::date` : sql``}
       ${opts.to ? sql`and d.day <= ${opts.to}::date` : sql``}
  `)) as unknown as {
    id: string; employeeId: string; date: string; officeName: string | null; checkInAt: string; checkOutAt: string | null;
    lat: number | null; lng: number | null; accuracy: number | null; outLat: number | null; outLng: number | null;
    inPhotoId: string | null; outPhotoId: string | null; workedSeconds: number | null; auto: boolean; distanceM: number | null;
    createdAt: string; updatedAt: string;
  }[];
  if (!rows.length) return [];
  const timings = await db.select().from(hrmsStaffTimings);
  const tm = new Map(timings.map((x) => [`${x.employeeId}|${x.weekday}`, x]));
  return rows.map((d) => {
    const checkIn = hhmm(d.checkInAt)!;
    const checkOut = hhmm(d.checkOutAt);
    const t = tm.get(`${d.employeeId}|${weekdayOf(d.date)}`);
    /* A handset day can carry breaks (sessions); what was not worked between
       the first check-in and the last check-out is the day's stoppage. */
    const span = checkOut ? (tmin(checkOut) ?? 0) - (tmin(checkIn) ?? 0) : null;
    const worked = d.workedSeconds != null ? Math.round(Number(d.workedSeconds) / 60) : null;
    const stoppageMin = span != null && worked != null ? Math.max(0, span - worked) : 0;
    return {
      id: `${FIELD_PREFIX}${d.id}`,
      employeeId: d.employeeId,
      date: d.date,
      officeName: d.officeName,
      method: "field",
      checkIn,
      checkOut,
      stoppageMin,
      officialIn: t?.inTime ?? null,
      officialOut: t?.outTime ?? null,
      targetMin: t ? minutesBetween(t.inTime, t.outTime) : null,
      lat: d.lat,
      lng: d.lng,
      accuracyM: d.accuracy,
      distanceM: d.distanceM,
      outLat: d.outLat,
      outLng: d.outLng,
      outDistanceM: null,
      checkInCode: null,
      inPhotoId: d.inPhotoId,
      outPhotoId: d.outPhotoId,
      remark: d.auto ? "Closed by itself on the field app — nobody checked out" : null,
      markedById: null,
      markedByName: null,
      reportToStamp: null,
      editHelp: false,
      createdAt: new Date(d.createdAt),
      updatedAt: new Date(d.updatedAt),
      createdById: null,
      updatedById: null,
    } satisfies HrmsAttendance;
  });
}

/** The handset day a person has on a date, if they checked in on the field app. */
export async function fieldDayOn(employeeId: string, date: string): Promise<HrmsAttendance | null> {
  return (await fieldDays({ employeeIds: [employeeId], from: date, to: date }))[0] ?? null;
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
export async function approvedLeave(employeeIds?: string[]): Promise<LeaveRef[]> {
  const conds = [eq(hrmsLeaveRequests.status, "Approved")];
  if (employeeIds) {
    if (!employeeIds.length) return [];
    conds.push(inArray(hrmsLeaveRequests.employeeId, employeeIds));
  }
  const [hrms, field] = await Promise.all([
    db.select().from(hrmsLeaveRequests).where(and(...conds)),
    fieldLeave({ employeeIds: employeeIds ?? null, states: ["approved"] }),
  ]);
  return [
    ...hrms.map((r) => ({ id: r.id, employeeId: r.employeeId, type: r.type, startDate: r.startDate, endDate: r.endDate, days: Number(r.days), paid: r.paid == null ? null : Number(r.paid), unpaid: r.unpaid == null ? null : Number(r.unpaid), status: r.status, source: "hrms" as const })),
    ...field,
  ];
}

/** A leave request as payroll, the monthly summary and the absentee list read it — HRMS's or the field app's. */
export type LeaveRef = {
  id: string;
  employeeId: string;
  /** "Leave" or "Half Day", HRMS's two words. */
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  paid: number | null;
  unpaid: number | null;
  /** HRMS's status words: Waiting · Approved · Rejected. */
  status: string;
  source: "hrms" | "field";
  /** The field app's own kind (casual, sick, earned, loss of pay). */
  fieldType?: string;
  reason?: string | null;
};

/**
 * ONE RECORD OF WHO WAS AWAY. A field salesman asks for leave on the handset
 * (`mbos_leave_requests`, decided in `mbos_approvals` on the Sales Dashboard)
 * and HRMS used to know nothing of it: payroll counted his approved leave as
 * days missing and the absentee list named him. Field leave is read here in
 * HRMS's own shape — a half day is "Half Day", loss of pay is unpaid, every
 * other kind is paid — and is decided where it was asked for.
 */
export async function fieldLeave(opts: { employeeIds?: string[] | null; states: ("pending" | "approved" | "rejected")[]; from?: string; to?: string }): Promise<LeaveRef[]> {
  if (opts.employeeIds && !opts.employeeIds.length) return [];
  const rows = (await db.execute(sql`
    select l.id, u.employee_id as "employeeId", l.leave_type::text as "kind", l.half_day as "halfDay", l.days,
           l.from_date::text as "startDate", l.to_date::text as "endDate", l.reason,
           coalesce(ap.state::text, 'pending') as "state"
      from mbos_leave_requests l
      join users u on u.id = l.user_id and u.employee_id is not null
      left join mbos_approvals ap on ap.subject_id = l.id and ap.type = 'leave'
     where l.cancelled_at is null
       ${opts.employeeIds ? sql`and u.employee_id in ${opts.employeeIds}` : sql``}
       ${opts.to ? sql`and l.from_date <= ${opts.to}::date` : sql``}
       ${opts.from ? sql`and l.to_date >= ${opts.from}::date` : sql``}
  `)) as unknown as { id: string; employeeId: string; kind: string; halfDay: boolean; days: number | string; startDate: string; endDate: string; reason: string | null; state: string }[];
  const STATUS: Record<string, string> = { pending: "Waiting", approved: "Approved", rejected: "Rejected", partially_approved: "Approved" };
  return rows
    .filter((r) => (opts.states as string[]).includes(r.state === "partially_approved" ? "approved" : r.state))
    .map((r) => {
      const days = r.halfDay ? 0.5 : Number(r.days);
      const unpaid = r.kind === "loss_of_pay";
      return {
        id: `mbos:${r.id}`,
        employeeId: r.employeeId,
        type: r.halfDay ? "Half Day" : "Leave",
        startDate: r.startDate,
        endDate: r.endDate,
        days,
        paid: unpaid ? 0 : days,
        unpaid: unpaid ? days : 0,
        status: STATUS[r.state] ?? "Waiting",
        source: "field" as const,
        fieldType: r.kind.replace(/_/g, " "),
        reason: r.reason,
      };
    });
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

