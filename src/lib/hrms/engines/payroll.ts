/* ---------------------------------------------------------------------------
 * The salary (spec §10.1), PURE. Every figure the source's Employee Salary
 * row computed, from what the month's attendance, leave and holidays say.
 * Money in paise throughout; each figure is rounded once, where it is made.
 * ------------------------------------------------------------------------- */

import { daysIn, prevMonth, monthOf } from "../time";

export type PayrollCfg = {
  pfRatePercent: number;
  pfCapPaise: number;
  employerPfExtraPercent: number;
  esicEmployeePercent: number;
  esicEmployerPercent: number;
  esicCeilingPaise: number;
  februaryDays: number;
  ptSlabs: { female: { upToPaise: number; pt: number }[]; male: { upToPaise: number; pt: number }[]; rest: number; february: number };
  lateBands: [number, number][];
};

/** The month a salary dated `salaryDate` pays for: always the one before (spec §10.1, A15). */
export function salaryMonth(salaryDate: string): string {
  return prevMonth(monthOf(salaryDate));
}

export function daysInSalaryMonth(month: string, cfg: Pick<PayrollCfg, "februaryDays">): number {
  return month.slice(5, 7) === "02" ? cfg.februaryDays : daysIn(month);
}

/** Half-days of salary deducted for a month's late check-ins (spec §10.1). */
export function lateHalfDays(lateCount: number, bands: [number, number][]): number {
  const sorted = [...bands].sort((a, b) => b[0] - a[0]);
  for (const [atLeast, half] of sorted) if (lateCount >= atLeast) return half;
  return 0;
}

/** Maharashtra professional tax (spec §10.1). */
export function professionalTax(grossPaise: number, gender: string | null, month: string, cfg: PayrollCfg["ptSlabs"]): number {
  const slabs = /female/i.test(gender ?? "") ? cfg.female : cfg.male;
  for (const s of [...slabs].sort((a, b) => a.upToPaise - b.upToPaise)) if (grossPaise <= s.upToPaise) return s.pt;
  return month.slice(5, 7) === "02" ? cfg.february : cfg.rest;
}

export type SalaryInput = {
  month: string;
  salaryPaise: number;
  conveyancePaise: number;
  otherSalaryPaise: number;
  pfApplies: boolean;
  gender: string | null;
  /** Distinct attendance dates that were Full Days / Half Days. */
  fullDays: number;
  halfDays: number;
  /** Days with a check-in and no check-out in the month. */
  pendingCheckouts: number;
  /** Late-beyond-grace check-ins in the month. */
  lateCount: number;
  /** From approved Leave requests in the month. */
  paidLeave: number;
  unpaidLeave: number;
  leaveDays: number;
  holidaysInsideLeave: number;
  /** Holidays in the month tagged to the employee. */
  officialHolidays: number;
  compDays: number;
  incentivePaise: number;
  /** Advance to recover this month. */
  advanceDeductionPaise: number;
};

export type SalaryFigures = {
  month: string;
  daysInMonth: number;
  fullDays: number;
  halfDays: number;
  paidLeave: number;
  unpaidLeave: number;
  leaveDays: number;
  holidaysInsideLeave: number;
  officialHolidays: number;
  compDays: number;
  attendanceCount: number;
  /** The reconciliation the source checked: must equal days in month. */
  accounted: number;
  missingDays: number;
  pendingCheckouts: number;
  fixedPaise: number;
  basicPaise: number;
  incentivePaise: number;
  conveyancePaise: number;
  specialPaise: number;
  grossPaise: number;
  pfPaise: number;
  esicPaise: number;
  ptPaise: number;
  advanceDeductionPaise: number;
  lateCount: number;
  lateHalfDays: number;
  lateDeductionPaise: number;
  grossDeductionPaise: number;
  inHandPaise: number;
  otherPaymentPaise: number;
  employerPfPaise: number;
  employerEsicPaise: number;
  ctcPaise: number;
  hint: string;
};

export function computeSalary(x: SalaryInput, cfg: PayrollCfg): SalaryFigures {
  const days = daysInSalaryMonth(x.month, cfg);
  const attendanceCount = x.fullDays + x.halfDays / 2 + x.officialHolidays + x.paidLeave - x.holidaysInsideLeave - x.compDays;
  const accounted = x.fullDays + x.halfDays + x.leaveDays + x.officialHolidays - x.holidaysInsideLeave - x.compDays;
  const perDay = x.salaryPaise / days;
  const basicPaise = Math.round(perDay * attendanceCount);
  const conveyancePaise = Math.round((x.conveyancePaise / days) * attendanceCount);
  const specialPaise = Math.round(perDay * x.compDays);
  const grossPaise = basicPaise + x.incentivePaise + conveyancePaise + specialPaise;
  const halfBasic = basicPaise / 2;
  const pfPaise = x.pfApplies ? Math.round(Math.min((halfBasic * cfg.pfRatePercent) / 100, cfg.pfCapPaise)) : 0;
  const underCeiling = x.pfApplies && grossPaise < cfg.esicCeilingPaise;
  const esicPaise = underCeiling ? Math.round((grossPaise * cfg.esicEmployeePercent) / 100) : 0;
  const ptPaise = professionalTax(grossPaise, x.gender, x.month, cfg.ptSlabs);
  const half = lateHalfDays(x.lateCount, cfg.lateBands);
  const lateDeductionPaise = Math.round((perDay / 2) * half);
  const grossDeductionPaise = x.advanceDeductionPaise + lateDeductionPaise + pfPaise + ptPaise + esicPaise;
  const employerPfPaise = x.pfApplies ? pfPaise + Math.round((halfBasic * cfg.employerPfExtraPercent) / 100) : 0;
  const employerEsicPaise = underCeiling ? Math.round((grossPaise * cfg.esicEmployerPercent) / 100) : 0;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    month: x.month,
    daysInMonth: days,
    fullDays: x.fullDays,
    halfDays: x.halfDays,
    paidLeave: x.paidLeave,
    unpaidLeave: x.unpaidLeave,
    leaveDays: x.leaveDays,
    holidaysInsideLeave: x.holidaysInsideLeave,
    officialHolidays: x.officialHolidays,
    compDays: x.compDays,
    attendanceCount: r2(attendanceCount),
    accounted: r2(accounted),
    missingDays: r2(days - accounted),
    pendingCheckouts: x.pendingCheckouts,
    fixedPaise: x.salaryPaise,
    basicPaise,
    incentivePaise: x.incentivePaise,
    conveyancePaise,
    specialPaise,
    grossPaise,
    pfPaise,
    esicPaise,
    ptPaise,
    advanceDeductionPaise: x.advanceDeductionPaise,
    lateCount: x.lateCount,
    lateHalfDays: half,
    lateDeductionPaise,
    grossDeductionPaise,
    inHandPaise: grossPaise - grossDeductionPaise,
    otherPaymentPaise: Math.round((x.otherSalaryPaise / days) * attendanceCount),
    employerPfPaise,
    employerEsicPaise,
    ctcPaise: grossPaise + employerPfPaise + employerEsicPaise,
    hint: `Full days ${x.fullDays} + half days ${x.halfDays} + leave days ${x.leaveDays} + holidays ${x.officialHolidays} − holidays inside leave ${x.holidaysInsideLeave} − compensation days ${x.compDays} = ${r2(accounted)} of ${days} days`,
  };
}

/** "1 day", "2.5 days". */
const dayCount = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/**
 * Why a salary may not be prepared yet (spec §10.1), in plain words; null when
 * it may. The same two checks the source made: every check-in has a check-out,
 * and attendance, leave and holidays add up to exactly the days in the month.
 */
export function salaryBlock(f: SalaryFigures): string | null {
  if (f.pendingCheckouts > 0)
    return `${dayCount(f.pendingCheckouts)} this month ${f.pendingCheckouts === 1 ? "has" : "have"} a check-in with no check-out. Add the check-outs before preparing the salary.`;
  if (f.missingDays > 0.001)
    return `${dayCount(f.missingDays)} of ${f.daysInMonth} ${f.missingDays === 1 ? "is" : "are"} not covered by attendance, leave or holidays. Check the month's attendance and leave before preparing the salary.`;
  if (f.missingDays < -0.001)
    return `Attendance, leave and holidays add up to ${dayCount(-f.missingDays)} more than the ${f.daysInMonth} days in the month. Check for days counted twice before preparing the salary.`;
  return null;
}
