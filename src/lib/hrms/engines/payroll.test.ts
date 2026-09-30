import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSalary, daysInSalaryMonth, lateHalfDays, professionalTax, salaryBlock, salaryMonth, type PayrollCfg, type SalaryInput } from "./payroll";

/* The salary (spec §10.1), against the configuration's shipped defaults — the
   source's rates, caps and slabs. Money is paise throughout. */

const CFG: PayrollCfg = {
  pfRatePercent: 12,
  pfCapPaise: 180000,
  employerPfExtraPercent: 1,
  esicEmployeePercent: 0.75,
  esicEmployerPercent: 3.25,
  esicCeilingPaise: 2100000,
  februaryDays: 28,
  ptSlabs: { female: [{ upToPaise: 2500000, pt: 0 }], male: [{ upToPaise: 750000, pt: 0 }, { upToPaise: 1000000, pt: 17500 }], rest: 20000, february: 30000 },
  lateBands: [[25, 5], [20, 4], [15, 3], [10, 2], [5, 1]],
};

/** A whole September worked, nothing else: every figure below varies one thing. */
function input(over: Partial<SalaryInput> = {}): SalaryInput {
  return {
    month: "2026-09",
    salaryPaise: 3000000,
    conveyancePaise: 0,
    otherSalaryPaise: 0,
    pfApplies: true,
    gender: "Male",
    fullDays: 30,
    halfDays: 0,
    pendingCheckouts: 0,
    lateCount: 0,
    paidLeave: 0,
    unpaidLeave: 0,
    leaveDays: 0,
    holidaysInsideLeave: 0,
    officialHolidays: 0,
    compDays: 0,
    incentivePaise: 0,
    advanceDeductionPaise: 0,
    ...over,
  };
}

test("the salary month is always the month before the salary date (A15)", () => {
  assert.equal(salaryMonth("2026-10-05"), "2026-09");
  assert.equal(salaryMonth("2026-01-31"), "2025-12");
});

test("February pays on the configured days (A08); other months on their own", () => {
  assert.equal(daysInSalaryMonth("2026-02", CFG), 28);
  assert.equal(daysInSalaryMonth("2028-02", CFG), 28);
  assert.equal(daysInSalaryMonth("2028-02", { februaryDays: 29 }), 29);
  assert.equal(daysInSalaryMonth("2026-09", CFG), 30);
  assert.equal(daysInSalaryMonth("2026-10", CFG), 31);
});

test("employee PF is 12% of half the basic, capped at ₹1,800; employer adds 1% uncapped", () => {
  const low = computeSalary(input({ salaryPaise: 2000000 }), CFG);
  assert.equal(low.basicPaise, 2000000);
  assert.equal(low.pfPaise, 120000);
  assert.equal(low.employerPfPaise, 120000 + 10000);

  const high = computeSalary(input({ salaryPaise: 6000000 }), CFG);
  assert.equal(high.pfPaise, 180000, "₹3,600 would be due; the cap is ₹1,800");
  assert.equal(high.employerPfPaise, 180000 + 30000);
});

test("no PF and no ESIC when the employee is not PF/ESIC applicable", () => {
  const f = computeSalary(input({ salaryPaise: 1500000, pfApplies: false }), CFG);
  assert.equal(f.pfPaise, 0);
  assert.equal(f.esicPaise, 0);
  assert.equal(f.employerPfPaise, 0);
  assert.equal(f.employerEsicPaise, 0);
  assert.equal(f.ctcPaise, f.grossPaise);
});

test("ESIC applies only while gross is strictly below ₹21,000", () => {
  const under = computeSalary(input({ salaryPaise: 2000000 }), CFG);
  assert.equal(under.esicPaise, 15000);
  assert.equal(under.employerEsicPaise, 65000);
  assert.equal(under.ctcPaise, 2000000 + 130000 + 65000);

  const at = computeSalary(input({ salaryPaise: 2100000 }), CFG);
  assert.equal(at.esicPaise, 0);
  assert.equal(at.employerEsicPaise, 0);
});

test("professional tax: female slab, male slabs, and February", () => {
  const pt = (gross: number, gender: string, month = "2026-09") => professionalTax(gross, gender, month, CFG.ptSlabs);
  assert.equal(pt(2500000, "Female"), 0);
  assert.equal(pt(2500100, "Female"), 20000);
  assert.equal(pt(2500100, "Female", "2026-02"), 30000);
  assert.equal(pt(750000, "Male"), 0);
  assert.equal(pt(750100, "Male"), 17500);
  assert.equal(pt(1000000, "Male"), 17500);
  assert.equal(pt(1000100, "Male"), 20000);
  assert.equal(pt(1000100, "Male", "2026-02"), 30000);
  assert.equal(pt(1000100, "", "2026-09"), 20000, "an unrecorded gender takes the male slabs");
});

test("late check-ins become half-days by band", () => {
  const b = CFG.lateBands;
  assert.deepEqual([0, 4, 5, 9, 10, 14, 15, 19, 20, 24, 25, 40].map((n) => lateHalfDays(n, b)), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  const f = computeSalary(input({ lateCount: 10 }), CFG);
  assert.equal(f.lateHalfDays, 2);
  assert.equal(f.lateDeductionPaise, 100000, "half a day of ₹1,000 a day, twice");
});

test("attendance count and the days reconciliation", () => {
  const f = computeSalary(
    input({ fullDays: 20, halfDays: 2, officialHolidays: 4, paidLeave: 2, unpaidLeave: 1, leaveDays: 3, holidaysInsideLeave: 1, compDays: 1 }),
    CFG,
  );
  /* 20 + 2 ÷ 2 + 4 + 2 − 1 − 1 */
  assert.equal(f.attendanceCount, 25);
  /* 20 + 2 + 3 + 4 − 1 − 1 of 30 */
  assert.equal(f.accounted, 27);
  assert.equal(f.missingDays, 3);
  assert.equal(salaryBlock(f), "Kindly Check Count Leave/Attendance 3 Days Missing");
  assert.equal(f.basicPaise, 2500000);
  assert.equal(f.specialPaise, 100000, "one compensation day paid as special allowance");
});

test("a month that reconciles is not blocked; a pending check-out is", () => {
  const whole = computeSalary(input({ fullDays: 26, officialHolidays: 4 }), CFG);
  assert.equal(whole.missingDays, 0);
  assert.equal(salaryBlock(whole), null);
  assert.equal(salaryBlock(computeSalary(input({ pendingCheckouts: 2 }), CFG)), "Your Pending Checkout Count is 2");
});

test("gross, deductions and in hand; other payment sits beside in hand (A10)", () => {
  const f = computeSalary(
    input({ salaryPaise: 3000000, conveyancePaise: 300000, otherSalaryPaise: 600000, incentivePaise: 50000, advanceDeductionPaise: 200000, lateCount: 5 }),
    CFG,
  );
  assert.equal(f.conveyancePaise, 300000);
  assert.equal(f.grossPaise, 3000000 + 50000 + 300000);
  assert.equal(f.pfPaise, 180000);
  assert.equal(f.esicPaise, 0);
  assert.equal(f.ptPaise, 20000);
  assert.equal(f.lateDeductionPaise, 50000);
  assert.equal(f.grossDeductionPaise, 200000 + 50000 + 180000 + 20000);
  assert.equal(f.inHandPaise, f.grossPaise - f.grossDeductionPaise);
  assert.equal(f.otherPaymentPaise, 600000);
});
