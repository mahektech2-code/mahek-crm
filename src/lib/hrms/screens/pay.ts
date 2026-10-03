import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { employees, hrmsAdvances, hrmsExpenses, hrmsSalaries, users, type HrmsSalary } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { fdLong, inr, nf, type ActionSpec, type ColSpec, type FieldSpec, type FormSpec, type ListRow, type RowField } from "@/lib/erp/ui";
import { has, type HrmsContext, type Scope } from "../access";
import { err, fieldErr, hrmsAudit, hrmsId, inTx, nextSeries, okVoid, paise, refuse, rupeesField, stampLine, text, today, num, type HrmsScreenModule, type ScreenQuery, type Tx, type Values } from "../server";
import { allPeople, byId, isActive, refList, type Person } from "../services/people";
import { approvedLeave, attendanceRows, holidays, monthCounts } from "../services/attendance";
import { computeSalary, salaryBlock, salaryMonth, type PayrollCfg, type SalaryFigures } from "../engines/payroll";
import { daysIn, monLabel, monthOf, prevMonth } from "../time";
import { hrmsLink } from "../registry";
import { personFrom, personOption } from "./attendance";
import { EXPENSE_CLAIM, EXPENSE_PAID } from "../values";
import { tell } from "../services/notify";

/* ---------------------------------------------------------------------------
 * Payroll, advances and expenses (spec §10, §11).
 *
 * A salary is worked out ON THE SERVER from what the month's attendance,
 * leave and holidays say (`services/attendance.monthCounts`) through the pure
 * engine (`engines/payroll.computeSalary`), and the whole breakdown is stored
 * as `figures`. Approval freezes it: a later change to that month's
 * attendance is shown as a warning on the salary, never as moved numbers.
 * The advance still to recover is DERIVED — what was given less what salaries
 * deducted — so deleting a salary gives its deduction back without anybody
 * having to remember to.
 * ------------------------------------------------------------------------- */

/* ================================================================ shared */

async function payrollCfg(): Promise<PayrollCfg> {
  const c = await getConfig();
  return {
    pfRatePercent: c["hrms.payroll.pfRatePercent"],
    pfCapPaise: c["hrms.payroll.pfCapPaise"],
    employerPfExtraPercent: c["hrms.payroll.employerPfExtraPercent"],
    esicEmployeePercent: c["hrms.payroll.esicEmployeePercent"],
    esicEmployerPercent: c["hrms.payroll.esicEmployerPercent"],
    esicCeilingPaise: c["hrms.payroll.esicCeilingPaise"],
    februaryDays: c["hrms.payroll.februaryDays"],
    ptSlabs: c["hrms.payroll.ptSlabs"],
    lateBands: c["hrms.payroll.lateBands"],
  };
}

/** A scope switch with only the two answers these screens have: my own rows, or everybody's. */
function wideScope(q: ScreenQuery, wide: boolean): { scope: Scope; options: Scope[] } {
  if (!wide) return { scope: "mine", options: ["mine"] };
  return { scope: q.scope === "mine" ? "mine" : "all", options: ["mine", "all"] };
}

/** Names of the accounts that created rows, for the "Created by" line. */
async function userNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, want));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const money = (p: number | null | undefined) => (p == null ? "—" : inr(p) || "₹0");
const toPaise = (s: string | undefined) => paise(String(s ?? "").replace(/[₹,\s]/g, ""));

/* ======================================================= salary inputs */

type PayEmployee = {
  id: string;
  code: string;
  name: string;
  gender: string | null;
  office: string | null;
  position: string | null;
  status: string;
  salaryPaise: number | null;
  conveyancePaise: number | null;
  otherSalaryPaise: number | null;
  pfEsic: boolean | null;
  uanNo: string | null;
  esicNo: string | null;
  bankName: string | null;
  ifsc: string | null;
  accountNumber: string | null;
  accountLast4: string | null;
};

async function payEmployees(ids: string[]): Promise<Map<string, PayEmployee>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({
      id: employees.id,
      code: employees.employeeCode,
      name: employees.name,
      gender: employees.gender,
      office: employees.officeName,
      position: employees.position,
      status: employees.status,
      salaryPaise: employees.netSalaryPaise,
      conveyancePaise: employees.conveyancePaise,
      otherSalaryPaise: employees.otherSalaryPaise,
      pfEsic: employees.pfEsicApplicable,
      uanNo: employees.uanNo,
      esicNo: employees.esicNo,
      bankName: employees.bankName,
      ifsc: employees.ifscCode,
      accountNumber: employees.accountNumber,
      accountLast4: employees.accountNumberLast4,
    })
    .from(employees)
    .where(inArray(employees.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

/** "Name · Bank · A/c ••••1234 · IFSC …" — the account number never leaves as more than its last four. */
export function bankLine(e: Pick<PayEmployee, "name" | "bankName" | "ifsc" | "accountNumber" | "accountLast4">): string {
  const last4 = (e.accountNumber ? e.accountNumber.replace(/\s/g, "").slice(-4) : e.accountLast4) ?? "";
  const parts = [e.name, e.bankName, last4 ? `A/c ••••${last4}` : null, e.ifsc ? `IFSC ${e.ifsc}` : null].filter(Boolean);
  return parts.length > 1 ? parts.join(" · ") : "No bank details on the employee record";
}

type Counts = ReturnType<typeof monthCounts>;

/** What the month's attendance, leave and holidays say, for several employees at once. */
async function countsFor(pairs: { employeeId: string; office: string | null; month: string }[]): Promise<Map<string, Counts>> {
  const out = new Map<string, Counts>();
  if (!pairs.length) return out;
  const months = pairs.map((p) => p.month).sort();
  const from = `${months[0]}-01`;
  const last = months[months.length - 1];
  const to = `${last}-${String(daysIn(last)).padStart(2, "0")}`;
  const ids = [...new Set(pairs.map((p) => p.employeeId))];
  /* Holidays unbounded: a leave starting in the month may run past its end,
     and "holidays inside leave" counts over the whole request. */
  const [days, approved, hol] = await Promise.all([attendanceRows({ employeeIds: ids, from, to }), approvedLeave(ids), holidays()]);
  for (const p of pairs) out.set(`${p.employeeId}|${p.month}`, monthCounts({ ...p, days, approved, holidays: hol }));
  return out;
}

/** The figures that come from attendance, compared to decide whether a salary is out of date. */
const COUNT_KEYS = ["fullDays", "halfDays", "paidLeave", "unpaidLeave", "leaveDays", "holidaysInsideLeave", "officialHolidays", "lateCount", "pendingCheckouts"] as const;
const COUNT_LABEL: Record<(typeof COUNT_KEYS)[number], string> = {
  fullDays: "full days",
  halfDays: "half days",
  paidLeave: "paid leave",
  unpaidLeave: "unpaid leave",
  leaveDays: "leave days",
  holidaysInsideLeave: "holidays inside leave",
  officialHolidays: "official holidays",
  lateCount: "late check-ins",
  pendingCheckouts: "pending check-outs",
};

/** What moved since the figures were worked out: "full days 22 → 23", or nothing. */
function countChanges(f: SalaryFigures, c: Counts): string[] {
  return COUNT_KEYS.filter((k) => Math.abs(Number(f[k] ?? 0) - Number(c[k] ?? 0)) > 0.001).map(
    (k) => `${COUNT_LABEL[k]} ${nf(Number(f[k] ?? 0)) || "0"} → ${nf(Number(c[k] ?? 0)) || "0"}`,
  );
}

/** The stored breakdown: the engine's figures plus what the payslip needs from the employee as it was. */
export type StoredFigures = SalaryFigures & { pfEsic: string; uanNo: string; esicNo: string; bank: string };

export const figuresOf = (s: HrmsSalary) => s.figures as unknown as StoredFigures;

function work(
  e: PayEmployee,
  month: string,
  c: Counts,
  x: { compDays: number; incentivePaise: number; advanceDeductionPaise: number },
  cfg: PayrollCfg,
): StoredFigures {
  const f = computeSalary(
    {
      month,
      salaryPaise: e.salaryPaise ?? 0,
      conveyancePaise: e.conveyancePaise ?? 0,
      otherSalaryPaise: e.otherSalaryPaise ?? 0,
      pfApplies: !!e.pfEsic,
      gender: e.gender,
      ...c,
      ...x,
    },
    cfg,
  );
  return { ...f, pfEsic: e.pfEsic ? "Yes" : "No", uanNo: e.uanNo ?? "", esicNo: e.esicNo ?? "", bank: bankLine(e) };
}

/** Advances given less advance deductions on salaries, per employee (spec §10.4). */
async function advanceTotals(ids?: string[]): Promise<{ given: Map<string, number>; deducted: Map<string, number> }> {
  if (ids && !ids.length) return { given: new Map(), deducted: new Map() };
  const [g, d] = await Promise.all([
    db
      .select({ emp: hrmsAdvances.employeeId, total: sql<number>`coalesce(sum(${hrmsAdvances.amountPaise}), 0)`.mapWith(Number) })
      .from(hrmsAdvances)
      .where(ids ? inArray(hrmsAdvances.employeeId, ids) : undefined)
      .groupBy(hrmsAdvances.employeeId),
    db
      .select({ emp: hrmsSalaries.employeeId, total: sql<number>`coalesce(sum(${hrmsSalaries.advanceDeductionPaise}), 0)`.mapWith(Number) })
      .from(hrmsSalaries)
      .where(ids ? inArray(hrmsSalaries.employeeId, ids) : undefined)
      .groupBy(hrmsSalaries.employeeId),
  ]);
  return { given: new Map(g.map((r) => [r.emp, r.total])), deducted: new Map(d.map((r) => [r.emp, r.total])) };
}

/** The advance still to recover from one employee, leaving out one salary's own deduction when it is being redone. */
async function outstandingAdvance(employeeId: string, exceptSalaryId?: string): Promise<number> {
  const { given, deducted } = await advanceTotals([employeeId]);
  let d = deducted.get(employeeId) ?? 0;
  if (exceptSalaryId) {
    const [s] = await db.select({ a: hrmsSalaries.advanceDeductionPaise }).from(hrmsSalaries).where(eq(hrmsSalaries.id, exceptSalaryId));
    d -= s?.a ?? 0;
  }
  return (given.get(employeeId) ?? 0) - d;
}

/* ============================================================== payroll */

const PAY_COLS: ColSpec[] = [
  { k: "monthLbl", l: "Month", t: "t" },
  { k: "emp", l: "Employee", t: "b" },
  { k: "fixed", l: "Fixed", t: "m" },
  { k: "basic", l: "Basic", t: "m" },
  { k: "attCount", l: "Attendance", t: "n" },
  { k: "inHand", l: "In hand", t: "m" },
  { k: "advDed", l: "Advance deduction", t: "m" },
  { k: "lateDed", l: "Late deduction", t: "m" },
  { k: "pt", l: "Professional tax", t: "m" },
  { k: "inc", l: "Incentive", t: "m" },
  { k: "conv", l: "Conveyance", t: "m" },
  { k: "status", l: "Status", t: "s" },
  { k: "f", l: "Flags", t: "f" },
];

const payWide = (ctx: HrmsContext) => has(ctx, "payroll") || has(ctx, "pay");

/** Whether this person may open this salary's payslip (the payslip route asks the same). */
export function mayOpenPayslip(ctx: HrmsContext, s: { employeeId: string; status: string }): boolean {
  return payWide(ctx) || (s.employeeId === ctx.employee?.id && s.status === "Paid");
}

function salaryFields(s: HrmsSalary, f: StoredFigures, e: Person | undefined, changes: string[]): RowField[] {
  const n = (v: number) => nf(v) || "0";
  const out: RowField[] = [
    { l: "Employee", v: e ? `${e.name} · ${e.code}` : "" },
    { l: "Salary date", v: fdLong(s.salaryDate) },
    { l: "Days in month", v: String(s.daysInMonth) },
    { l: "Attendance count", v: n(f.attendanceCount), der: true },
    { l: "Full days", v: n(f.fullDays), der: true },
    { l: "Half days", v: n(f.halfDays), der: true },
    { l: "Paid leave", v: n(f.paidLeave), der: true },
    { l: "Unpaid leave", v: n(f.unpaidLeave), der: true },
    { l: "Leave days", v: n(f.leaveDays), der: true },
    { l: "Holidays inside leave", v: n(f.holidaysInsideLeave), der: true },
    { l: "Official holidays", v: n(f.officialHolidays), der: true },
    { l: "Compensation days", v: n(f.compDays) },
    { l: "Reconciliation", v: f.hint, der: true },
    { l: "Fixed salary", v: money(f.fixedPaise), der: true },
    { l: "Basic salary", v: money(f.basicPaise), der: true },
    { l: "Incentive", v: money(f.incentivePaise) },
    { l: "Conveyance allowance", v: money(f.conveyancePaise), der: true },
    { l: "Special allowance", v: money(f.specialPaise), der: true },
    { l: "Gross earnings", v: money(f.grossPaise), der: true },
    { l: "PF/ESIC applicable", v: f.pfEsic ?? "", der: true },
    { l: "UAN · ESIC number", v: [f.uanNo, f.esicNo].filter(Boolean).join(" · ") || "—", der: true },
    { l: "Professional tax", v: money(f.ptPaise), der: true },
    { l: "Employee PF", v: money(f.pfPaise), der: true },
    { l: "Employee ESIC", v: money(f.esicPaise), der: true },
    { l: "Employer PF", v: money(f.employerPfPaise), der: true },
    { l: "Employer ESIC", v: money(f.employerEsicPaise), der: true },
    { l: "Cost to company (CTC)", v: money(f.ctcPaise), der: true },
    { l: "Advance deduction", v: money(f.advanceDeductionPaise) },
    {
      l: "Late deduction",
      v: `${money(f.lateDeductionPaise)}${f.lateHalfDays ? ` · ${f.lateHalfDays} late half-day${f.lateHalfDays > 1 ? "s" : ""} for ${f.lateCount} late check-ins` : ""}`,
      der: true,
    },
    { l: "Total deductions", v: money(f.grossDeductionPaise), der: true },
    { l: "Other payment", v: `${money(f.otherPaymentPaise)} · paid beside salary in hand, not in it`, der: true },
    { l: "Salary in hand", v: money(f.inHandPaise), der: true },
    { l: "Remark", v: s.remark ?? "" },
    { l: "Bank details", v: f.bank ?? "", der: true },
    { l: "Payment UTR number", v: s.utr ?? "" },
    { l: "Payment date", v: s.paidOn ? fdLong(s.paidOn) : "" },
    { l: "Approved by", v: s.approvedByName ?? "" },
    /* `preparedByName` is written by Pay, so it names who paid the salary. */
    { l: "Paid by", v: s.preparedByName ?? "" },
    { l: "Payslip code", v: s.payslipCode ?? "" },
    { l: "Salary ID", v: s.salaryNo },
    { l: "Month", v: monLabel(s.month) },
  ];
  if (changes.length) out.unshift({ l: "Attendance changed since approval", v: `${changes.join(" · ")}. The approved figures stay as they were.` });
  return out;
}

function salaryActions(ctx: HrmsContext, s: HrmsSalary, f: StoredFigures, name: string): ActionSpec[] {
  const wide = payWide(ctx);
  const a: ActionSpec[] = [];
  const mon = monLabel(s.month);
  if (wide && s.status === "Prepared") {
    a.push({ id: "approve", l: "Approve", primary: true, why: has(ctx, "payroll") ? undefined : "Needs the “Prepare and approve salaries” power" });
    a.push({ id: "edit", l: "Edit", loadsForm: true, why: has(ctx, "payroll") ? undefined : "Needs the “Prepare and approve salaries” power" });
  }
  if (wide && s.status === "Approved")
    a.push({
      id: "pay",
      l: "Pay",
      primary: true,
      why: has(ctx, "pay") ? undefined : "Needs the “Pay salaries” power",
      prompt: {
        title: "Pay salary",
        sub: `${name} · ${mon} · ${money(f.inHandPaise)} in hand`,
        submit: "Mark paid",
        init: { paidOn: today() },
        fields: [
          { k: "utr", l: "Payment UTR number", t: "text", req: true },
          { k: "paidOn", l: "Payment date", t: "date", req: true },
        ],
      },
    });
  if (mayOpenPayslip(ctx, s) && s.status === "Paid") a.push({ id: "open", l: "Open payslip", href: `/api/hrms/payslip/${s.id}` });
  if (wide && s.status !== "Prepared" && has(ctx, "payroll"))
    a.push({
      id: "remark",
      l: "Remark",
      prompt: { title: "Remark", sub: `${name} · ${mon}`, submit: "Save remark", init: { remark: s.remark ?? "" }, fields: [{ k: "remark", l: "Remark", t: "area", req: true }] },
    });
  if (wide && has(ctx, "payroll")) a.push({
      id: "regenerate",
      l: "New payslip code",
      confirm: `Give ${name}’s ${mon} payslip a new payslip code? The figures stay the same; only the code printed on the payslip changes.`,
    });
  if (wide)
    a.push({
      id: "delete",
      l: "Delete",
      why: has(ctx, "admin") ? undefined : "Deleting a salary needs the “Administer HRMS” power",
      confirm: `Delete ${name}’s ${mon} salary? Its advance deduction goes back to the outstanding advance. It cannot be undone.`,
    });
  return a;
}

function salaryRow(ctx: HrmsContext, s: HrmsSalary, e: Person | undefined, changes: string[], creator: string | undefined): ListRow {
  const f = figuresOf(s);
  const name = e?.name ?? "";
  const flags: string[] = [];
  if (s.status === "Paid") flags.push("paid");
  else if (s.status === "Approved") flags.push("salApproved");
  if (changes.length) flags.push("changed");
  if (s.employeeId === ctx.employee?.id) flags.push("mine");
  return {
    id: s.id,
    v: {
      month: s.month,
      monthLbl: monLabel(s.month),
      emp: name,
      office: e?.office ?? "",
      fixed: f.fixedPaise,
      basic: f.basicPaise,
      attCount: f.attendanceCount,
      inHand: s.inHandPaise,
      advDed: f.advanceDeductionPaise,
      lateDed: f.lateDeductionPaise,
      pt: f.ptPaise,
      inc: f.incentivePaise,
      conv: f.conveyancePaise,
      status: s.status,
    },
    flags,
    title: `${name} · ${monLabel(s.month)}`,
    header: `${money(s.inHandPaise)} in hand${f.otherPaymentPaise ? ` · other payment ${money(f.otherPaymentPaise)}` : ""} · ${s.status}`,
    fields: salaryFields(s, f, e, changes),
    actions: salaryActions(ctx, s, f, name),
    by: stampLine(creator, s.createdAt),
  };
}

/** How far back the "attendance changed since approval" check looks: a year of salaries. */
const CHANGE_CHECK_MONTHS = 12;

function monthsBack(month: string, n: number): string {
  let m = month;
  for (let i = 0; i < n; i++) m = prevMonth(m);
  return m;
}

/** The input fields both salary forms share. */
function salaryInputFields(advanceHint: string): FieldSpec[] {
  return [
    { k: "comp", l: "Compensation days", t: "num", min: 0, def: "0", hint: "Extra days paid as special allowance." },
    { k: "inc", l: "Incentive (₹)", t: "num", min: 0 },
    { k: "adv", l: "Advance deduction (₹)", t: "num", min: 0, hint: advanceHint },
    { k: "remark", l: "Remark", t: "area" },
  ];
}

async function newSalaryForm(ctx: HrmsContext, people: Person[], salaries: HrmsSalary[]): Promise<FormSpec | undefined> {
  if (!has(ctx, "payroll")) return undefined;
  const t = today();
  const month = salaryMonth(t);
  const done = new Set(salaries.filter((s) => s.month === month).map((s) => s.employeeId));
  const open = people.filter((p) => isActive(p) && !done.has(p.id));
  const { given, deducted } = await advanceTotals();
  const owing = open
    .map((p) => ({ p, v: (given.get(p.id) ?? 0) - (deducted.get(p.id) ?? 0) }))
    .filter((x) => x.v > 0)
    .map((x) => `${x.p.name} ${money(x.v)}`);
  return {
    screen: "payroll",
    id: "new",
    title: "Prepare a salary",
    sub: "The salary date sets the month it pays: always the month before. Every figure is worked out from attendance, leave and the employee’s record when you save, and shown on the salary.",
    submit: "Save salary",
    init: { salaryDate: t, comp: "0" },
    header: [
      { k: "salaryDate", l: "Salary date", t: "date", req: true, hint: `Today pays for ${monLabel(month)}.` },
      {
        k: "emp",
        l: "Employee",
        t: "select",
        req: true,
        opts: open.map(personOption),
        hint: `Active employees without a salary for ${monLabel(month)}. Another salary date is checked when you save.`,
      },
      ...salaryInputFields(
        `Leave blank to recover the whole outstanding advance.${owing.length ? ` Outstanding now: ${owing.slice(0, 8).join(" · ")}${owing.length > 8 ? " …" : ""}` : " Nobody has an advance outstanding."}`,
      ),
    ],
  };
}

/** Works a salary out and saves it — a new one, or a Prepared one being redone. */
async function saveSalary(ctx: HrmsContext, h: Values, recordId?: string) {
  if (!has(ctx, "payroll")) return err("Preparing salaries needs the “Prepare and approve salaries” power.", "not_permitted");
  let employeeId: string;
  let salaryDate: string;
  let existing: HrmsSalary | undefined;
  if (recordId) {
    [existing] = await db.select().from(hrmsSalaries).where(eq(hrmsSalaries.id, recordId));
    if (!existing) return err("That salary no longer exists.", "not_found");
    if (existing.status !== "Prepared") return err(`This salary is ${existing.status.toLowerCase()}, so its figures are frozen. Only its remark can change.`);
    employeeId = existing.employeeId;
    salaryDate = existing.salaryDate;
  } else {
    const p = personFrom(h.emp, await allPeople());
    if (!p) return fieldErr("emp", "Pick an employee from the list");
    if (!isActive(p)) return fieldErr("emp", `${p.name} is not an active employee`);
    employeeId = p.id;
    salaryDate = text(h.salaryDate) ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(salaryDate)) return fieldErr("salaryDate", "Enter a valid salary date");
  }
  const month = salaryMonth(salaryDate);
  const e = (await payEmployees([employeeId])).get(employeeId);
  if (!e) return fieldErr("emp", "That employee’s record could not be found");
  if (!e.salaryPaise) return fieldErr("emp", `No salary is set on ${e.name}’s employee record. Add it there first.`);

  const compDays = num(h.comp) ?? 0;
  if (compDays < 0) return fieldErr("comp", "Compensation days can’t be less than zero");
  const incentivePaise = toPaise(h.inc) ?? 0;
  if (incentivePaise < 0) return fieldErr("inc", "The incentive can’t be less than zero");
  const outstanding = Math.max(0, await outstandingAdvance(employeeId, recordId));
  /* Spec §10.1 / A13: the deduction defaults to the whole outstanding advance. */
  const advanceDeductionPaise = toPaise(h.adv) ?? outstanding;
  if (advanceDeductionPaise < 0) return fieldErr("adv", "The advance deduction can’t be less than zero");
  if (advanceDeductionPaise > outstanding) return fieldErr("adv", `Can’t be more than the outstanding advance of ${money(outstanding)}`);

  const [cfg, counts] = await Promise.all([payrollCfg(), countsFor([{ employeeId, office: e.office, month }])]);
  const figures = work(e, month, counts.get(`${employeeId}|${month}`)!, { compDays, incentivePaise, advanceDeductionPaise }, cfg);
  const block = salaryBlock(figures);
  if (block) return fieldErr(recordId ? "comp" : "emp", block);
  if (figures.inHandPaise < 0) return fieldErr("adv", `Total deductions come to more than the gross earnings of ${money(figures.grossPaise)}. Lower the advance deduction.`);

  const values = {
    compDays,
    incentivePaise,
    advanceDeductionPaise,
    daysInMonth: figures.daysInMonth,
    figures: figures as unknown as Record<string, number | string>,
    inHandPaise: figures.inHandPaise,
    remark: text(h.remark),
  };
  if (existing) {
    await db
      .update(hrmsSalaries)
      .set({ ...values, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(and(eq(hrmsSalaries.id, existing.id), eq(hrmsSalaries.status, "Prepared")));
    await hrmsAudit(ctx, "hrms.salary.edit", "hrms_salaries", existing.id, { inHand: existing.inHandPaise }, { inHand: figures.inHandPaise });
    return okVoid(`Salary worked out again · ${money(figures.inHandPaise)} in hand`);
  }
  const id = hrmsId("hsal");
  const res = await inTx(async (tx: Tx) => {
    const [dupe] = await tx
      .select({ id: hrmsSalaries.id, status: hrmsSalaries.status })
      .from(hrmsSalaries)
      .where(and(eq(hrmsSalaries.employeeId, employeeId), eq(hrmsSalaries.month, month)));
    if (dupe) return refuse(fieldErr("emp", `${e.name} already has a salary for ${monLabel(month)} (${dupe.status.toLowerCase()})`));
    const n = await nextSeries(tx, "salary");
    await tx.insert(hrmsSalaries).values({
      id,
      salaryNo: `ES-${String(n).padStart(6, "0")}`,
      employeeId,
      month,
      salaryDate,
      status: "Prepared",
      payslipCode: hrmsId("slip"),
      createdById: ctx.user.id,
      ...values,
    });
    return okVoid(`Salary prepared for ${e.name} · ${money(figures.inHandPaise)} in hand · waiting for approval`);
  });
  if (res.ok) await hrmsAudit(ctx, "hrms.salary.prepare", "hrms_salaries", id, null, { employee: e.code, month, inHand: figures.inHandPaise });
  return res;
}

/**
 * Approves one Prepared salary. A salary whose month's attendance moved since
 * it was worked out is refused rather than frozen: approving would freeze
 * figures that no longer describe the month.
 */
async function approveOne(ctx: HrmsContext, s: HrmsSalary): Promise<string | null> {
  if (s.status !== "Prepared") return `Only a prepared salary can be approved. This one is ${s.status.toLowerCase()}.`;
  const e = (await payEmployees([s.employeeId])).get(s.employeeId);
  const counts = (await countsFor([{ employeeId: s.employeeId, office: e?.office ?? null, month: s.month }])).get(`${s.employeeId}|${s.month}`)!;
  const changes = countChanges(figuresOf(s), counts);
  if (changes.length) return `Attendance changed since this salary was prepared (${changes.join(", ")}) — edit it to work the figures out again`;
  const done = await db
    .update(hrmsSalaries)
    .set({ status: "Approved", approvedByName: ctx.user.name, approvedById: ctx.user.id, approvedAt: new Date(), updatedAt: new Date(), updatedById: ctx.user.id })
    .where(and(eq(hrmsSalaries.id, s.id), eq(hrmsSalaries.status, "Prepared")))
    .returning({ id: hrmsSalaries.id });
  if (!done.length) return "Someone else changed this salary at the same time. Reload and try again.";
  await hrmsAudit(ctx, "hrms.salary.approve", "hrms_salaries", s.id, { status: "Prepared" }, { status: "Approved" });
  return null;
}

function checkPayment(v: Values): { field: string; msg: string } | { utr: string; paidOn: string } {
  const utr = text(v.utr);
  const paidOn = text(v.paidOn);
  if (!utr) return { field: "utr", msg: "Enter the payment UTR number" };
  if (!paidOn || !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return { field: "paidOn", msg: "Enter a valid payment date" };
  if (paidOn > today()) return { field: "paidOn", msg: "The payment date can’t be in the future" };
  return { utr, paidOn };
}

/** Marks Approved salaries Paid and tells each employee their payslip is ready. */
async function payMany(ctx: HrmsContext, list: HrmsSalary[], utr: string, paidOn: string): Promise<HrmsSalary[]> {
  const paid: HrmsSalary[] = [];
  for (const s of list) {
    const done = await db
      .update(hrmsSalaries)
      .set({ status: "Paid", utr, paidOn, preparedByName: ctx.user.name, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(and(eq(hrmsSalaries.id, s.id), eq(hrmsSalaries.status, "Approved")))
      .returning({ id: hrmsSalaries.id });
    if (done.length) {
      paid.push(s);
      await hrmsAudit(ctx, "hrms.salary.pay", "hrms_salaries", s.id, { status: "Approved" }, { status: "Paid", utr, paidOn });
    }
  }
  if (paid.length) {
    /* Active accounts only, and a bell that fails must not report the payment as failed. */
    const accounts = await db
      .select({ id: users.id, employeeId: users.employeeId })
      .from(users)
      .where(and(inArray(users.employeeId, paid.map((s) => s.employeeId)), eq(users.active, true)));
    await tell(
      paid.flatMap((s) =>
        accounts
          .filter((u) => u.employeeId === s.employeeId)
          .map((u) => ({
            userId: u.id,
            title: `Your ${monLabel(s.month)} payslip is ready`,
            body: `${money(s.inHandPaise)} paid on ${fdLong(paidOn)} · UTR ${utr}`,
            kind: "success",
            href: hrmsLink("payroll", { open: s.id }),
          })),
      ),
    );
  }
  return paid;
}

async function salaryById(id: string): Promise<HrmsSalary | undefined> {
  const [s] = await db.select().from(hrmsSalaries).where(eq(hrmsSalaries.id, id));
  return s;
}

const payroll: HrmsScreenModule = {
  key: "payroll",
  async load(ctx, q) {
    const wide = payWide(ctx);
    const { scope, options } = wideScope(q, wide);
    const me = ctx.employee?.id ?? "";
    const [people, all] = await Promise.all([allPeople(), db.select().from(hrmsSalaries)]);
    /* Anybody who cannot run payroll sees their own PAID salaries only — My payslips. */
    const rows = all.filter((s) => (scope === "all" ? true : s.employeeId === me && (wide || s.status === "Paid")));
    const pb = byId(people);

    const since = monthsBack(salaryMonth(today()), CHANGE_CHECK_MONTHS);
    const frozen = wide ? rows.filter((s) => s.status !== "Prepared" && s.month >= since) : [];
    const counts = await countsFor(frozen.map((s) => ({ employeeId: s.employeeId, office: pb.get(s.employeeId)?.office ?? null, month: s.month })));
    const names = await userNames(rows.map((s) => s.createdById));

    return {
      spec: {
        screen: "payroll",
        cols: PAY_COLS,
        hidden: [],
        groups: ["monthLbl"],
        agg: { k: "inHand", l: "in hand" },
        sortDefault: ["month", -1],
        bulk: wide
          ? [
              { id: "approve", l: "Approve" },
              {
                id: "pay",
                l: "Pay",
                prompt: {
                  title: "Pay the selected salaries",
                  sub: "One UTR and date for the whole batch. Only approved salaries are paid.",
                  submit: "Mark paid",
                  init: { paidOn: today() },
                  fields: [
                    { k: "utr", l: "Payment UTR number", t: "text", req: true },
                    { k: "paidOn", l: "Payment date", t: "date", req: true },
                  ],
                },
              },
            ]
          : undefined,
        newForm: await newSalaryForm(ctx, people, all),
        newLabel: "Prepare a salary",
        download: has(ctx, "admin") || has(ctx, "payroll"),
        noDataLine: wide ? "No salaries yet." : "Your payslips appear here once a salary is paid.",
        hrms: {
          scope: { current: scope, options },
          ...(wide ? {} : { notice: { text: "Only paid salaries are listed here — open one for its payslip." } }),
        },
      },
      rows: rows.map((s) => {
        const c = counts.get(`${s.employeeId}|${s.month}`);
        return salaryRow(ctx, s, pb.get(s.employeeId), c && s.status !== "Prepared" ? countChanges(figuresOf(s), c) : [], names.get(s.createdById ?? ""));
      }),
    };
  },
  actions: {
    async approve(ctx, id) {
      if (!has(ctx, "payroll")) return err("Needs the “Prepare and approve salaries” power", "not_permitted");
      const s = await salaryById(id);
      if (!s) return err("That salary no longer exists.", "not_found");
      const why = await approveOne(ctx, s);
      if (why) return err(why);
      return okVoid(`${monLabel(s.month)} salary approved`);
    },
    async pay(ctx, id, v) {
      if (!has(ctx, "pay")) return err("Needs the “Pay salaries” power", "not_permitted");
      const s = await salaryById(id);
      if (!s) return err("That salary no longer exists.", "not_found");
      if (s.status !== "Approved") return err("Only an approved salary can be paid");
      const c = checkPayment(v);
      if ("field" in c) return fieldErr(c.field, c.msg);
      const paid = await payMany(ctx, [s], c.utr, c.paidOn);
      if (!paid.length) return err("Someone else changed this salary at the same time. Reload and try again.");
      return okVoid("Paid · payslip ready");
    },
    async remark(ctx, id, v) {
      if (!has(ctx, "payroll")) return err("Needs the “Prepare and approve salaries” power", "not_permitted");
      const s = await salaryById(id);
      if (!s) return err("That salary no longer exists.", "not_found");
      await db.update(hrmsSalaries).set({ remark: text(v.remark), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsSalaries.id, id));
      await hrmsAudit(ctx, "hrms.salary.remark", "hrms_salaries", id, { remark: s.remark }, { remark: text(v.remark) });
      return okVoid("Remark saved");
    },
    async regenerate(ctx, id) {
      if (!has(ctx, "payroll")) return err("Needs the “Prepare and approve salaries” power", "not_permitted");
      const s = await salaryById(id);
      if (!s) return err("That salary no longer exists.", "not_found");
      const code = hrmsId("slip");
      await db.update(hrmsSalaries).set({ payslipCode: code, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsSalaries.id, id));
      await hrmsAudit(ctx, "hrms.salary.regeneratePayslip", "hrms_salaries", id, { payslipCode: s.payslipCode }, { payslipCode: code });
      return okVoid("New payslip code issued");
    },
    async delete(ctx, id) {
      if (!has(ctx, "admin")) return err("Deleting a salary needs the “Administer HRMS” power", "not_permitted");
      const s = await salaryById(id);
      if (!s) return err("That salary no longer exists.", "not_found");
      await db.delete(hrmsSalaries).where(eq(hrmsSalaries.id, id));
      await hrmsAudit(ctx, "hrms.salary.delete", "hrms_salaries", id, s, null);
      return okVoid("Salary deleted");
    },
  },
  bulk: {
    async approve(ctx, ids) {
      if (!has(ctx, "payroll")) return err("Needs the “Prepare and approve salaries” power", "not_permitted");
      const list = await db.select().from(hrmsSalaries).where(inArray(hrmsSalaries.id, ids));
      let done = 0;
      const refused: string[] = [];
      for (const s of list) {
        if (s.status !== "Prepared") continue;
        const why = await approveOne(ctx, s);
        if (why) refused.push(s.salaryNo);
        else done++;
      }
      const notPrepared = list.filter((s) => s.status !== "Prepared").length;
      const tail = [
        notPrepared ? `${notPrepared} skipped because they were already approved or paid` : "",
        refused.length ? `${refused.length} held back because attendance changed since they were prepared (${refused.join(", ")})` : "",
      ].filter(Boolean);
      return okVoid(`${done} salar${done === 1 ? "y" : "ies"} approved${tail.length ? ` · ${tail.join(" · ")}` : ""}`);
    },
    async pay(ctx, ids, v) {
      if (!has(ctx, "pay")) return err("Needs the “Pay salaries” power", "not_permitted");
      const c = checkPayment(v);
      if ("field" in c) return fieldErr(c.field, c.msg);
      const list = (await db.select().from(hrmsSalaries).where(inArray(hrmsSalaries.id, ids))).filter((s) => s.status === "Approved");
      const paid = await payMany(ctx, list, c.utr, c.paidOn);
      const skipped = ids.length - paid.length;
      return okVoid(`${paid.length} salar${paid.length === 1 ? "y" : "ies"} paid · payslips ready${skipped ? ` · ${skipped} were not approved` : ""}`);
    },
  },
  forms: {
    async new(ctx, h) {
      return saveSalary(ctx, h);
    },
    async edit(ctx, h, _l, recordId) {
      if (!recordId) return err("That salary no longer exists.", "not_found");
      return saveSalary(ctx, h, recordId);
    },
  },
  formLoaders: {
    async edit(ctx, id) {
      if (!has(ctx, "payroll")) return null;
      const s = await salaryById(id);
      if (!s || s.status !== "Prepared") return null;
      const e = (await payEmployees([s.employeeId])).get(s.employeeId);
      if (!e) return null;
      const f = figuresOf(s);
      const outstanding = Math.max(0, await outstandingAdvance(s.employeeId, s.id));
      /* The figures as they stand, read-only: the form has no calculator, so
         what saving gives is shown on the salary once it is worked out again. */
      const show = (k: string, l: string): FieldSpec => ({ k: `_${k}`, l, t: "text", readOnly: true });
      return {
        screen: "payroll",
        id: "edit",
        title: "Edit salary",
        sub: `${e.name} · ${monLabel(s.month)}. Saving works every figure out again from the month’s attendance as it stands now.`,
        submit: "Work it out again",
        recordId: id,
        init: {
          comp: String(s.compDays ?? 0),
          inc: rupeesField(s.incentivePaise),
          adv: rupeesField(s.advanceDeductionPaise),
          remark: s.remark ?? "",
          _emp: `${e.name} · ${e.code}`,
          _month: monLabel(s.month),
          _att: `${nf(f.attendanceCount) || "0"} of ${s.daysInMonth} days · ${f.hint}`,
          _gross: money(f.grossPaise),
          _ded: money(f.grossDeductionPaise),
          _inHand: money(f.inHandPaise),
        },
        header: [
          show("emp", "Employee"),
          show("month", "Pays for"),
          ...salaryInputFields(`Outstanding advance ${money(outstanding)}. Leave blank to recover all of it.`),
          show("att", "Attendance count (last worked out)"),
          show("gross", "Gross earnings (last worked out)"),
          show("ded", "Total deductions (last worked out)"),
          show("inHand", "Salary in hand (last worked out)"),
        ],
      };
    },
  },
};

/* ============================================================= advances */

const advWide = (ctx: HrmsContext) => has(ctx, "advance") || has(ctx, "payroll");

function advanceForm(people: Person[], init?: { id: string; date: string; emp: string; amount: string; remark: string }): FormSpec {
  return {
    screen: "advances",
    id: init ? "edit" : "new",
    title: init ? "Edit advance" : "Give advance",
    sub: "Recovered from salary: the next salary deducts whatever is still outstanding unless payroll changes it.",
    submit: init ? "Save advance" : "Give advance",
    recordId: init?.id,
    init: init ? { date: init.date, emp: init.emp, amount: init.amount, remark: init.remark } : { date: today() },
    header: [
      { k: "date", l: "Date", t: "date", req: true },
      { k: "emp", l: "Employee", t: "select", req: true, opts: init ? [init.emp] : people.filter(isActive).map(personOption), readOnly: !!init },
      { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0 },
      { k: "remark", l: "Remark", t: "area" },
    ],
  };
}

/** How much of each advance salaries have recovered, oldest advance first. */
function recoveredByAdvance(advances: { id: string; employeeId: string; date: string; amountPaise: number }[], deducted: Map<string, number>): Map<string, number> {
  const left = new Map(deducted);
  const out = new Map<string, number>();
  for (const a of [...advances].sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id))) {
    const avail = left.get(a.employeeId) ?? 0;
    const take = Math.max(0, Math.min(avail, a.amountPaise));
    out.set(a.id, take);
    left.set(a.employeeId, avail - take);
  }
  return out;
}

async function saveAdvance(ctx: HrmsContext, h: Values, recordId?: string) {
  if (recordId ? !has(ctx, "admin") : !has(ctx, "advance"))
    return err(recordId ? "Editing an advance needs the “Administer HRMS” power." : "Giving advances needs the “Give salary advances” power.", "not_permitted");
  const date = text(h.date);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fieldErr("date", "Enter a valid date");
  const amount = toPaise(h.amount);
  if (amount == null) return fieldErr("amount", "Enter the amount");
  if (amount <= 0) return fieldErr("amount", "The amount must be more than zero");
  const remark = text(h.remark);
  if (recordId) {
    const [a] = await db.select().from(hrmsAdvances).where(eq(hrmsAdvances.id, recordId));
    if (!a) return err("That advance no longer exists.", "not_found");
    const [all, totals] = await Promise.all([db.select().from(hrmsAdvances).where(eq(hrmsAdvances.employeeId, a.employeeId)), advanceTotals([a.employeeId])]);
    const recovered = totals.deducted.get(a.employeeId) ?? 0;
    const given = all.reduce((t, x) => t + (x.id === a.id ? amount : x.amountPaise), 0);
    if (given < recovered) return fieldErr("amount", `Salaries have already recovered ${money(recovered)} of this employee’s advances`);
    await db.update(hrmsAdvances).set({ date, amountPaise: amount, remark, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsAdvances.id, recordId));
    await hrmsAudit(ctx, "hrms.advance.edit", "hrms_advances", recordId, { date: a.date, amount: a.amountPaise }, { date, amount });
    return okVoid("Advance saved");
  }
  const p = personFrom(h.emp, await allPeople());
  if (!p || !isActive(p)) return fieldErr("emp", "Pick an active employee from the list");
  const id = hrmsId("hadv");
  await db.insert(hrmsAdvances).values({ id, employeeId: p.id, date, amountPaise: amount, remark, createdById: ctx.user.id });
  await hrmsAudit(ctx, "hrms.advance.give", "hrms_advances", id, null, { employee: p.code, date, amount });
  return okVoid(`${money(amount)} advance given to ${p.name}`);
}

const advances: HrmsScreenModule = {
  key: "advances",
  async load(ctx, q) {
    const wide = advWide(ctx);
    const { scope, options } = wideScope(q, wide);
    const me = ctx.employee?.id ?? "";
    const [people, all, totals] = await Promise.all([allPeople(), db.select().from(hrmsAdvances), advanceTotals()]);
    const pb = byId(people);
    const recovered = recoveredByAdvance(all, totals.deducted);
    const rows = all.filter((a) => scope === "all" || a.employeeId === me);
    const names = await userNames(rows.map((a) => a.createdById));
    return {
      spec: {
        screen: "advances",
        cols: [
          { k: "monthLbl", l: "Month", t: "t" },
          { k: "date", l: "Date", t: "d" },
          { k: "emp", l: "Employee", t: "b" },
          { k: "office", l: "Office", t: "t" },
          { k: "amount", l: "Amount", t: "m" },
          { k: "recovered", l: "Recovered", t: "m" },
          { k: "outstanding", l: "Outstanding", t: "m" },
          { k: "remark", l: "Remark", t: "t" },
        ],
        hidden: [],
        groups: ["monthLbl"],
        agg: { k: "amount", l: "given" },
        sortDefault: ["date", -1],
        godownKey: "office",
        newForm: has(ctx, "advance") ? advanceForm(people) : undefined,
        newLabel: "Give advance",
        download: wide,
        noDataLine: wide ? "No advances given yet." : "You have no salary advances.",
        hrms: { scope: { current: scope, options } },
      },
      rows: rows.map((a): ListRow => {
        const e = pb.get(a.employeeId);
        const rec = recovered.get(a.id) ?? 0;
        const empOut = (totals.given.get(a.employeeId) ?? 0) - (totals.deducted.get(a.employeeId) ?? 0);
        const acts: ActionSpec[] = wide
          ? [
              { id: "edit", l: "Edit", loadsForm: true, why: has(ctx, "admin") ? undefined : "Editing an advance needs the “Administer HRMS” power" },
              {
                id: "delete",
                l: "Delete",
                why: !has(ctx, "admin")
                  ? "Deleting an advance needs the “Administer HRMS” power"
                  : rec > 0
                    ? "Part of this advance has already been recovered from salary, so it can’t be deleted"
                    : undefined,
                confirm: `Delete the ${money(a.amountPaise)} advance to ${e?.name ?? ""}?`,
              },
            ]
          : [];
        return {
          id: a.id,
          v: {
            date: a.date,
            monthLbl: monLabel(monthOf(a.date)),
            emp: e?.name ?? "",
            office: e?.office ?? "",
            amount: a.amountPaise,
            recovered: rec,
            outstanding: a.amountPaise - rec,
            remark: a.remark ?? "",
          },
          flags: [...(a.amountPaise - rec > 0 ? [] : ["done"]), ...(a.employeeId === me ? ["mine"] : [])],
          title: `${e?.name ?? ""} · ${money(a.amountPaise)}`,
          header: `Given ${fdLong(a.date)} · ${money(a.amountPaise - rec)} still to recover`,
          fields: [
            { l: "Employee", v: e ? `${e.name} · ${e.code}` : "" },
            { l: "Advance date", v: fdLong(a.date) },
            { l: "Advance amount", v: money(a.amountPaise) },
            { l: "Recovered from salary", v: money(rec), der: true },
            { l: "Still to recover on this advance", v: money(a.amountPaise - rec), der: true },
            { l: "Outstanding balance (all advances)", v: money(empOut), der: true },
            { l: "Remark", v: a.remark ?? "" },
            { l: "Month", v: monLabel(monthOf(a.date)) },
          ],
          actions: acts,
          by: stampLine(names.get(a.createdById ?? ""), a.createdAt),
        };
      }),
    };
  },
  actions: {
    async delete(ctx, id) {
      if (!has(ctx, "admin")) return err("Deleting an advance needs the “Administer HRMS” power", "not_permitted");
      const [a] = await db.select().from(hrmsAdvances).where(eq(hrmsAdvances.id, id));
      if (!a) return err("That advance no longer exists.", "not_found");
      const [all, totals] = await Promise.all([db.select().from(hrmsAdvances).where(eq(hrmsAdvances.employeeId, a.employeeId)), advanceTotals([a.employeeId])]);
      if ((recoveredByAdvance(all, totals.deducted).get(a.id) ?? 0) > 0) return err("Part of this advance has already been recovered from salary, so it can’t be deleted");
      await db.delete(hrmsAdvances).where(eq(hrmsAdvances.id, id));
      await hrmsAudit(ctx, "hrms.advance.delete", "hrms_advances", id, a, null);
      return okVoid("Advance deleted");
    },
  },
  forms: {
    async new(ctx, h) {
      return saveAdvance(ctx, h);
    },
    async edit(ctx, h, _l, recordId) {
      if (!recordId) return err("That advance no longer exists.", "not_found");
      return saveAdvance(ctx, h, recordId);
    },
  },
  formLoaders: {
    async edit(ctx, id) {
      if (!has(ctx, "admin")) return null;
      const [a] = await db.select().from(hrmsAdvances).where(eq(hrmsAdvances.id, id));
      if (!a) return null;
      const people = await allPeople();
      const p = people.find((x) => x.id === a.employeeId);
      return advanceForm(people, { id, date: a.date, emp: p ? personOption(p) : "", amount: rupeesField(a.amountPaise), remark: a.remark ?? "" });
    },
  },
};

/* ============================================================= expenses */

const CLAIM = EXPENSE_CLAIM;
const PAID = EXPENSE_PAID;
const expWide = (ctx: HrmsContext) => has(ctx, "hr") || has(ctx, "verifyExp");

/** Verified claims less verified payments, per employee-month and per employee (spec §11). */
function expenseBalances(rows: { employeeId: string; date: string; claimPaise: number | null; paidPaise: number | null; verify: string }[]): Map<string, number> {
  const b = new Map<string, number>();
  for (const r of rows) {
    if (r.verify !== "Verified") continue;
    const v = (r.claimPaise ?? 0) - (r.paidPaise ?? 0);
    const k = `${r.employeeId}|${monthOf(r.date)}`;
    b.set(k, (b.get(k) ?? 0) + v);
    b.set(r.employeeId, (b.get(r.employeeId) ?? 0) + v);
  }
  return b;
}

/** A value-list field: a pick-list while the list has values, free text until somebody fills it. */
const listField = (k: string, l: string, values: string[]): FieldSpec => (values.length ? { k, l, t: "select", req: true, opts: values } : { k, l, t: "text", req: true });

async function expenseForm(ctx: HrmsContext, people: Person[], edit?: { id: string; init: Record<string, string> }): Promise<FormSpec | undefined> {
  const wide = expWide(ctx);
  if (!wide && !ctx.employee) return undefined;
  const [locations, categories, particulars] = await Promise.all([refList("Expense locations"), refList("Expense categories"), refList("Expense particulars")]);
  const mine = people.find((p) => p.id === ctx.employee?.id);
  const pickable = edit ? [] : wide ? people.filter((p) => isActive(p) && !p.dateOfLeaving) : mine ? [mine] : [];
  return {
    screen: "expenses",
    id: edit ? "edit" : "new",
    title: edit ? "Edit expense" : "Add expense",
    sub: "A claim is money you spent; a payment is money the company gave you.",
    submit: "Save expense",
    recordId: edit?.id,
    init: edit?.init ?? { emp: mine ? personOption(mine) : "", date: today(), payType: CLAIM },
    header: [
      { k: "emp", l: "Employee", t: "select", req: true, opts: edit ? [edit.init.emp] : pickable.map(personOption), readOnly: !wide || !!edit },
      { k: "date", l: "Date", t: "date", req: true },
      { k: "payType", l: "Payment type", t: "select", req: true, opts: [CLAIM, PAID] },
      listField("location", "Location", locations),
      listField("category", "Category", categories),
      listField("particular", "Particular", particulars),
      { k: "claim", l: "Claim amount (₹)", t: "num", req: true, min: 0, when: { k: "payType", eq: CLAIM } },
      { k: "paid", l: "Paid amount (₹)", t: "num", req: true, min: 0, when: { k: "payType", eq: PAID } },
      { k: "reason", l: "Reason", t: "area", req: true, mic: true },
    ],
  };
}

async function saveExpense(ctx: HrmsContext, h: Values, recordId?: string) {
  const wide = expWide(ctx);
  let existing: typeof hrmsExpenses.$inferSelect | undefined;
  if (recordId) {
    [existing] = await db.select().from(hrmsExpenses).where(eq(hrmsExpenses.id, recordId));
    if (!existing) return err("That expense no longer exists.", "not_found");
    const own = existing.employeeId === ctx.employee?.id && existing.verify !== "Verified";
    if (!(wide || own)) return err("Only HR or someone who verifies expenses can change a verified expense or another person’s expense.", "not_permitted");
  }
  let employeeId = existing?.employeeId;
  if (!employeeId) {
    const people = await allPeople();
    const p = wide ? personFrom(h.emp, people) : people.find((x) => x.id === ctx.employee?.id);
    if (!p)
      return wide
        ? fieldErr("emp", "Pick an employee from the list")
        : err("Your account is not linked to an employee record yet. Ask HR to link it on the Access screen.", "not_permitted");
    if (!isActive(p) || p.dateOfLeaving) return fieldErr("emp", `${p.name} is not an active employee`);
    employeeId = p.id;
  }
  const date = text(h.date);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fieldErr("date", "Enter a valid date");
  if (date > today()) return fieldErr("date", "The date can’t be in the future");
  const payType = h.payType === PAID ? PAID : h.payType === CLAIM ? CLAIM : null;
  if (!payType) return fieldErr("payType", "Pick a payment type");
  const amountKey = payType === CLAIM ? "claim" : "paid";
  const amount = toPaise(h[amountKey]);
  if (amount == null) return fieldErr(amountKey, `Enter the ${payType === CLAIM ? "claim" : "paid"} amount`);
  if (amount <= 0) return fieldErr(amountKey, "The amount must be more than zero");
  const missing = { location: "Pick a location", category: "Pick a category", particular: "Pick a particular", reason: "Enter the reason" } as const;
  for (const k of ["location", "category", "particular", "reason"] as const) if (!text(h[k])) return fieldErr(k, missing[k]);

  /* Spec §11: what the company paid out is verified as it is written; a
     claim waits for somebody holding the verify power. */
  const defaultVerify = payType === PAID ? "Verified" : "Pending";
  const values = {
    date,
    payType,
    location: text(h.location),
    category: text(h.category),
    particular: text(h.particular),
    claimPaise: payType === CLAIM ? amount : null,
    paidPaise: payType === PAID ? amount : null,
    reason: text(h.reason),
  };
  if (existing) {
    /* A verifier's edit keeps a verified row verified; anybody else's edit is
       a new claim to verify. */
    const verify = existing.verify === "Verified" && has(ctx, "verifyExp") ? existing.verify : defaultVerify;
    await db.update(hrmsExpenses).set({ ...values, verify, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsExpenses.id, existing.id));
    await hrmsAudit(ctx, "hrms.expense.edit", "hrms_expenses", existing.id, existing, { ...values, verify });
    return okVoid(`${existing.serial} saved`);
  }
  const id = hrmsId("hexp");
  const emp = employeeId;
  const res = await inTx(async (tx: Tx) => {
    const n = await nextSeries(tx, "expense");
    const serial = `EX-${String(n).padStart(4, "0")}`;
    await tx.insert(hrmsExpenses).values({ id, serial, employeeId: emp, verify: defaultVerify, createdByName: ctx.user.name, createdById: ctx.user.id, ...values });
    return okVoid(`${serial} saved${defaultVerify === "Pending" ? " · waiting for verification" : ""}`);
  });
  if (res.ok) await hrmsAudit(ctx, "hrms.expense.add", "hrms_expenses", id, null, { employeeId: emp, ...values });
  return res;
}

async function setVerify(ctx: HrmsContext, ids: string[], to: "Verified" | "Pending"): Promise<number> {
  const done = await db
    .update(hrmsExpenses)
    .set({ verify: to, updatedAt: new Date(), updatedById: ctx.user.id })
    .where(and(inArray(hrmsExpenses.id, ids), sql`${hrmsExpenses.verify} <> ${to}`))
    .returning({ id: hrmsExpenses.id });
  if (done.length) await hrmsAudit(ctx, to === "Verified" ? "hrms.expense.verify" : "hrms.expense.unverify", "hrms_expenses", null, null, { ids: done.map((d) => d.id) });
  return done.length;
}

const expenses: HrmsScreenModule = {
  key: "expenses",
  async load(ctx, q) {
    const wide = expWide(ctx);
    const { scope, options } = wideScope(q, wide);
    const me = ctx.employee?.id ?? "";
    const [people, all] = await Promise.all([allPeople(), db.select().from(hrmsExpenses)]);
    const pb = byId(people);
    const bal = expenseBalances(all);
    const rows = all.filter((x) => scope === "all" || x.employeeId === me);
    const verifier = has(ctx, "verifyExp");
    return {
      spec: {
        screen: "expenses",
        cols: [
          { k: "serial", l: "Serial", t: "mono" },
          { k: "date", l: "Date", t: "d" },
          { k: "emp", l: "Employee", t: "b" },
          { k: "payType", l: "Payment type", t: "s" },
          { k: "category", l: "Category", t: "t" },
          { k: "particular", l: "Particular", t: "t" },
          { k: "claim", l: "Claim", t: "m" },
          { k: "paidAmt", l: "Paid", t: "m" },
          { k: "verify", l: "Verification", t: "s" },
          { k: "monthBal", l: "Month balance", t: "m" },
          { k: "totalBal", l: "Total balance", t: "m" },
        ],
        hidden: [],
        groups: ["emp"],
        chips: "verify",
        sortDefault: ["date", -1],
        godownKey: "office",
        bulk: verifier ? [{ id: "verify", l: "Verify" }] : undefined,
        newForm: await expenseForm(ctx, people),
        newLabel: "Add expense",
        download: true,
        noDataLine: "No expenses yet.",
        hrms: { scope: { current: scope, options } },
      },
      rows: rows.map((x): ListRow => {
        const e = pb.get(x.employeeId);
        const own = x.employeeId === me;
        const monthBal = bal.get(`${x.employeeId}|${monthOf(x.date)}`) ?? 0;
        const totalBal = bal.get(x.employeeId) ?? 0;
        const amount = x.payType === CLAIM ? x.claimPaise : x.paidPaise;
        const acts: ActionSpec[] = [];
        if (x.verify !== "Verified") acts.push({ id: "verify", l: "Verify", primary: true, why: verifier ? undefined : "Verifying expenses needs the “Verify expenses” power" });
        else if (verifier) acts.push({ id: "unverify", l: "Mark pending" });
        if (wide || (own && x.verify !== "Verified")) acts.push({ id: "edit", l: "Edit", loadsForm: true });
        if (has(ctx, "admin") || has(ctx, "hr") || (own && x.verify !== "Verified"))
          acts.push({ id: "delete", l: "Delete", confirm: `Delete ${x.serial}, ${money(amount)}? It cannot be undone.` });
        return {
          id: x.id,
          v: {
            serial: x.serial,
            date: x.date,
            emp: e?.name ?? "",
            office: e?.office ?? "",
            payType: x.payType,
            category: x.category ?? "",
            particular: x.particular ?? "",
            claim: x.claimPaise,
            paidAmt: x.paidPaise,
            verify: x.verify,
            monthBal,
            totalBal,
          },
          flags: [...(x.verify === "Verified" ? ["done"] : ["waitApproval"]), ...(own ? ["mine"] : [])],
          title: `${x.serial} · ${e?.name ?? ""}`,
          header: `${x.payType} · ${money(amount)} · ${x.verify}`,
          fields: [
            { l: "Employee", v: e ? `${e.name} · ${e.code}` : "" },
            { l: "Date", v: fdLong(x.date) },
            { l: "Payment type", v: x.payType },
            { l: "Location", v: x.location ?? "" },
            { l: "Category", v: x.category ?? "" },
            { l: "Particular", v: x.particular ?? "" },
            { l: x.payType === CLAIM ? "Claim amount" : "Paid amount", v: money(amount) },
            { l: "Reason", v: x.reason ?? "" },
            { l: "Verification", v: x.verify },
            { l: "Monthly balance", v: `${money(monthBal)} · verified claims less verified payments in ${monLabel(monthOf(x.date))}`, der: true },
            { l: "Total balance", v: `${money(totalBal)} · verified claims less verified payments, all time`, der: true },
            { l: "Office", v: e?.office ?? "" },
          ],
          actions: acts,
          by: stampLine(x.createdByName, x.createdAt),
        };
      }),
    };
  },
  actions: {
    async verify(ctx, id) {
      if (!has(ctx, "verifyExp")) return err("Verifying expenses needs the “Verify expenses” power", "not_permitted");
      const n = await setVerify(ctx, [id], "Verified");
      return n ? okVoid("Verified") : err("Already verified.");
    },
    async unverify(ctx, id) {
      if (!has(ctx, "verifyExp")) return err("Marking an expense pending needs the “Verify expenses” power", "not_permitted");
      const n = await setVerify(ctx, [id], "Pending");
      return n ? okVoid("Marked pending") : err("Already pending.");
    },
    async delete(ctx, id) {
      const [x] = await db.select().from(hrmsExpenses).where(eq(hrmsExpenses.id, id));
      if (!x) return err("That expense no longer exists.", "not_found");
      const own = x.employeeId === ctx.employee?.id && x.verify !== "Verified";
      if (!(has(ctx, "admin") || has(ctx, "hr") || own)) return err("Only HR or an HRMS administrator can delete a verified expense or another person’s expense.", "not_permitted");
      await db.delete(hrmsExpenses).where(eq(hrmsExpenses.id, id));
      await hrmsAudit(ctx, "hrms.expense.delete", "hrms_expenses", id, x, null);
      return okVoid(`${x.serial} deleted`);
    },
  },
  bulk: {
    async verify(ctx, ids) {
      if (!has(ctx, "verifyExp")) return err("Verifying expenses needs the “Verify expenses” power", "not_permitted");
      const n = await setVerify(ctx, ids, "Verified");
      return okVoid(`${n} expense${n === 1 ? "" : "s"} verified${ids.length > n ? ` · ${ids.length - n} were already verified` : ""}`);
    },
  },
  forms: {
    async new(ctx, h) {
      return saveExpense(ctx, h);
    },
    async edit(ctx, h, _l, recordId) {
      if (!recordId) return err("That expense no longer exists.", "not_found");
      return saveExpense(ctx, h, recordId);
    },
  },
  formLoaders: {
    async edit(ctx, id) {
      const [x] = await db.select().from(hrmsExpenses).where(eq(hrmsExpenses.id, id));
      if (!x) return null;
      if (!(expWide(ctx) || (x.employeeId === ctx.employee?.id && x.verify !== "Verified"))) return null;
      const people = await allPeople();
      const p = people.find((e) => e.id === x.employeeId);
      return (
        (await expenseForm(ctx, people, {
          id,
          init: {
            emp: p ? personOption(p) : "",
            date: x.date,
            payType: x.payType,
            location: x.location ?? "",
            category: x.category ?? "",
            particular: x.particular ?? "",
            claim: rupeesField(x.claimPaise),
            paid: rupeesField(x.paidPaise),
            reason: x.reason ?? "",
          },
        })) ?? null
      );
    },
  },
};

export const PAY_SCREENS: HrmsScreenModule[] = [payroll, advances, expenses];
