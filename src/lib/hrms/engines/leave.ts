/* ---------------------------------------------------------------------------
 * Leave rules (spec §7), PURE.
 * ------------------------------------------------------------------------- */

import { daysBetweenISO, monthOf } from "../time";

export type LeaveType = "Leave" | "Half Day";

/** Leave days: end − start + 1; a Half Day is half a day (spec §7.1, design). */
export function leaveDays(type: LeaveType, start: string, end: string): number {
  if (type === "Half Day") return 0.5;
  return daysBetweenISO(start, end) + 1;
}

export type RequestCheck = { field: string; message: string } | null;

/** The apply-form validations (spec §7.1). */
export function checkRequest(x: {
  type: LeaveType;
  start: string;
  end: string;
  /** Another request of the same employee that overlaps (not rejected), if any. */
  clash: { type: string; status: string } | null;
}): RequestCheck {
  if (x.clash) return { field: "start", message: `You already have a request on these dates: ${x.clash.type}, ${x.clash.status}` };
  if (x.type === "Leave") {
    if (x.end < x.start) return { field: "end", message: "The end date must be on or after the start date" };
    if (monthOf(x.end) !== monthOf(x.start))
      return { field: "end", message: "The end date must be in the same month as the start. Apply for next month’s days as a separate request." };
  }
  return null;
}

export type Balances = {
  /** Credits for the month − paid leave already approved in that month. */
  paid: number;
  /** Yearly maximum − unpaid leave approved in that year. */
  unpaid: number;
};

/**
 * Available paid leave for a month and unpaid leave for its year (spec §7.1):
 * paid = this month's credits − approved paid days that month; unpaid =
 * yearly maximum − approved unpaid days that year.
 */
export function balances(x: {
  month: string;
  credits: { month: string; days: number }[];
  approved: { startDate: string; paid: number | null; unpaid: number | null }[];
  yearlyMax: number | null;
}): Balances {
  const year = x.month.slice(0, 4);
  const credit = x.credits.filter((c) => c.month === x.month).reduce((a, c) => a + Number(c.days), 0);
  const paidUsed = x.approved.filter((r) => monthOf(r.startDate) === x.month).reduce((a, r) => a + Number(r.paid ?? 0), 0);
  const unpaidUsed = x.approved.filter((r) => r.startDate.slice(0, 4) === year).reduce((a, r) => a + Number(r.unpaid ?? 0), 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { paid: round(Math.max(0, credit - paidUsed)), unpaid: round(Math.max(0, (x.yearlyMax ?? 0) - unpaidUsed)) };
}

const dayWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** The approval's split, and why it may not stand. */
export function checkApproval(days: number, paid: number, b: Balances): string | null {
  if (!Number.isFinite(paid) || paid < 0 || paid > days) return `Paid leave must be between 0 and ${days} days`;
  if (paid > b.paid) return `Not enough paid leave: ${dayWord(b.paid)} available this month, ${dayWord(paid)} asked`;
  if (days - paid > b.unpaid) return `Not enough unpaid leave: ${dayWord(b.unpaid)} left this year, ${dayWord(Math.round((days - paid) * 100) / 100)} needed`;
  return null;
}

export type HolidayRef = { date: string; tagged: string; taggedEmployeeIds: string[] };

/** Whether a holiday applies to this employee (all, their office, or named). */
export function holidayApplies(h: HolidayRef, employeeId: string, office: string | null): boolean {
  return h.tagged === "All employees" || (!!office && h.tagged === office) || h.taggedEmployeeIds.includes(employeeId);
}

/** Holidays tagged to the employee between two dates (the source's Holiday Count). */
export function holidaysInside(holidays: HolidayRef[], employeeId: string, office: string | null, start: string, end: string): number {
  return holidays.filter((h) => h.date >= start && h.date <= end && holidayApplies(h, employeeId, office)).length;
}

