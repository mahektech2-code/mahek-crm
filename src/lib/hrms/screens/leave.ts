import "server-only";
import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { db } from "@/db";
import { employees, hrmsAttendance, hrmsHolidays, hrmsLeaveCredits, hrmsLeaveRequests, hrmsMonthlyRemarks, hrmsOvertime } from "@/db/schema";
import { parseCsv } from "@/lib/csv";
import { getConfig } from "@/lib/config/store";
import type { ActionSpec, ColSpec, Contact, FieldSpec, FormSpec, ListRow, RowField } from "@/lib/erp/ui";
import { has, type HrmsContext } from "../access";
import type { HrmsPower } from "../powers";
import {
  err,
  fieldErr,
  first,
  hrmsAudit,
  hrmsId,
  inTx,
  multi,
  nextSeries,
  num,
  ok,
  okVoid,
  refuse,
  stampLine,
  text,
  today,
  visibleCols,
  withoutHidden,
  type HrmsScreenModule,
  type Tx,
  type Values,
} from "../server";
import { allPeople, byId, isActive, isFieldOrOther, offices, visibleIds, type Person } from "../services/people";
import { attendanceCfg, attendanceRows, holidayDatesFor, holidays, leaveDatesIn } from "../services/attendance";
import { balances, checkApproval, checkRequest, holidaysInside, leaveDays, type Balances, type LeaveType } from "../engines/leave";
import { monthlyFigures } from "../engines/monthly";
import { minutesBetween } from "../engines/attendance";
import { addDaysISO, daysBetweenISO, daysIn, fdShort, hm, monLabel, monthName, monthOf, prevMonth, weekdayOf } from "../time";
import { hrmsLink } from "../registry";
import { runMonthlyLeaveCredit } from "../jobs";
import { personFrom, personOption, scopeFor } from "./attendance";
import { fromOld, HOLIDAY_CATEGORIES, LEAVE_WAITING } from "../values";
import { powerHolderUserIds, tell, tellEmployees } from "../services/notify";

/* ---------------------------------------------------------------------------
 * Leave & holidays (spec §7), overtime (§8) and the monthly attendance
 * report (§9). Balances come from `engines/leave.ts` and nowhere else, so the
 * apply form, the approvals queue and the approve prompt quote one figure; the
 * monthly report is derived from the same attendance rows the register and
 * payroll read, and its remark is the only thing it stores (A07).
 * ------------------------------------------------------------------------- */

type Req = typeof hrmsLeaveRequests.$inferSelect;
type Holiday = Awaited<ReturnType<typeof holidays>>[number];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const DELETE_WORDS = "Delete this leave request? It cannot be undone.";
const NOT_LINKED = "Your account is not linked to an employee record yet. Ask HR to link it on the Access screen.";
const hasP = (ctx: HrmsContext) => (p: string) => has(ctx, p as HrmsPower);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const at = (d: Date | null | undefined) => (d ? stampLine(null, d).replace(/^Created /, "") : "");
const monthEnd = (m: string) => `${m}-${String(daysIn(m)).padStart(2, "0")}`;
const nextMonth = (m: string) => monthOf(addDaysISO(`${m}-01`, 32));

/* ----------------------------------------------------------- notifications */

/** Who decides leave: holders of the power and HRMS administrators (spec §18.5). */
const approverUserIds = () => powerHolderUserIds("approveLeave");

/* A bell that could not be rung must never undo a decision already written. */
function span(r: { startDate: string; endDate: string }) {
  return r.startDate === r.endDate ? fdShort(r.startDate) : `${fdShort(r.startDate)} – ${fdShort(r.endDate)}`;
}

async function tellApprovers(ctx: HrmsContext, r: { reqNo: string; type: string; startDate: string; endDate: string; days: number }, name: string) {
  const ids = (await approverUserIds()).filter((id) => id !== ctx.user.id);
  await tell(ids.map((userId) => ({ userId, title: `Leave request ${r.reqNo}`, body: `${name} · ${r.type} · ${span(r)} · ${plural(r.days, "day")}`, href: hrmsLink("approvals") })));
}

async function tellEmployee(ctx: HrmsContext, r: Req, body: string, kind: string) {
  await tellEmployees(ctx.user.id, [r.employeeId], { title: `Leave ${r.reqNo}`, body, href: hrmsLink("leave"), kind });
}

/* --------------------------------------------------------------- balances */

type BalBook = {
  credits: Map<string, { month: string; days: number }[]>;
  approved: Map<string, { startDate: string; endDate: string; days: number; paid: number | null; unpaid: number | null }[]>;
  yearly: Map<string, number | null>;
};

function push<T>(m: Map<string, T[]>, k: string, v: T) {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

/** Credits, approved leave and yearly maxima, for some employees (or all), read in one pass. */
async function balBook(employeeIds: string[] | null, tx?: Tx): Promise<BalBook> {
  const q = (tx ?? db) as unknown as typeof db;
  const book: BalBook = { credits: new Map(), approved: new Map(), yearly: new Map() };
  if (employeeIds && !employeeIds.length) return book;
  const [cr, ap, em] = await Promise.all([
    q
      .select({ employeeId: hrmsLeaveCredits.employeeId, month: hrmsLeaveCredits.month, days: hrmsLeaveCredits.days })
      .from(hrmsLeaveCredits)
      .where(employeeIds ? inArray(hrmsLeaveCredits.employeeId, employeeIds) : undefined),
    q
      .select({
        employeeId: hrmsLeaveRequests.employeeId,
        startDate: hrmsLeaveRequests.startDate,
        endDate: hrmsLeaveRequests.endDate,
        days: hrmsLeaveRequests.days,
        paid: hrmsLeaveRequests.paid,
        unpaid: hrmsLeaveRequests.unpaid,
      })
      .from(hrmsLeaveRequests)
      .where(and(eq(hrmsLeaveRequests.status, "Approved"), employeeIds ? inArray(hrmsLeaveRequests.employeeId, employeeIds) : undefined)),
    q
      .select({ id: employees.id, yearly: employees.yearlyMaximumLeave })
      .from(employees)
      .where(employeeIds ? inArray(employees.id, employeeIds) : undefined),
  ]);
  for (const c of cr) push(book.credits, c.employeeId, { month: c.month, days: Number(c.days) });
  for (const a of ap) push(book.approved, a.employeeId, { ...a, days: Number(a.days) });
  for (const e of em) book.yearly.set(e.id, e.yearly);
  return book;
}

/** Available paid leave for the date's month and unpaid leave for its year (spec §7.1). */
function balOf(book: BalBook, employeeId: string, date: string): Balances {
  return balances({ month: monthOf(date), credits: book.credits.get(employeeId) ?? [], approved: book.approved.get(employeeId) ?? [], yearlyMax: book.yearly.get(employeeId) ?? null });
}

/** Total leave taken in a year (spec §7.1): approved days, a half day counting as the half it is. */
function takenIn(book: BalBook, employeeId: string, year: string): number {
  return (book.approved.get(employeeId) ?? [])
    .filter((r) => r.startDate.slice(0, 4) === year && r.endDate.slice(0, 4) === year)
    .reduce((a, r) => a + Number(r.days), 0);
}

/* ------------------------------------------------------------ leave rows */

const LEAVE_COLS: (ColSpec & { pw?: string })[] = [
  { k: "date", l: "Applied", t: "d" },
  { k: "reqId", l: "Request", t: "mono" },
  { k: "emp", l: "Employee", t: "b" },
  { k: "type", l: "Type", t: "s" },
  { k: "start", l: "From", t: "d" },
  { k: "end", l: "To", t: "d" },
  { k: "days", l: "Days", t: "n" },
  { k: "status", l: "Status", t: "s" },
  { k: "line", l: "Note", t: "t" },
  { k: "paid", l: "Paid", t: "n", pw: "split" },
  { k: "unpaid", l: "Unpaid", t: "n", pw: "split" },
  { k: "f", l: "Flags", t: "f" },
];

/** The request's one-line state — "Waiting for a decision" / "Approved" / "Rejected" (the source's wait/enjoy line). */
function waitLine(r: Req): string {
  return r.status === "Approved" ? "Approved" : r.status === "Rejected" ? "Rejected" : "Waiting for a decision";
}

function leaveFlags(r: Req): string[] {
  const f = [r.status === "Approved" ? "enjoy" : r.status === "Rejected" ? "rejected" : "waitApproval"];
  if (r.type === "Half Day") f.push("halfDay");
  return f;
}

function leaveActions(ctx: HrmsContext, r: Req, name: string, bal: Balances): ActionSpec[] {
  const approver = has(ctx, "approveLeave");
  const own = r.employeeId === ctx.employee?.id;
  const days = Number(r.days);
  const a: ActionSpec[] = [];
  if (r.status !== "Approved")
    a.push({
      id: "approve",
      l: "Approve",
      primary: true,
      why: approver ? undefined : "Only someone who approves leave can do this",
      prompt: {
        title: `Approve ${first(name)}’s leave`,
        sub: `${span(r)} · ${plural(days, "day")} · available paid ${bal.paid}, unpaid ${bal.unpaid}`,
        submit: "Approve",
        init: { paid: String(Math.min(days, bal.paid)) },
        fields: [
          { k: "paid", l: "Paid days", t: "num", req: true, min: 0, max: days, hint: `Up to ${days}. The rest is unpaid.` },
          { k: "remark", l: "Approver’s remark", t: "text" },
        ],
      },
    });
  if (r.status !== "Rejected")
    a.push({
      id: "reject",
      l: "Reject",
      why: approver ? undefined : "Only someone who approves leave can do this",
      prompt: { title: "Reject leave", sub: `${name} · ${span(r)}`, submit: "Reject", fields: [{ k: "remark", l: "Reason for rejecting", t: "area", req: true }] },
    });
  if (approver) {
    a.push({ id: "remark", l: "Approver’s remark", prompt: { title: "Approver’s remark", submit: "Save remark", init: { remark: r.officerRemark ?? "" }, fields: [{ k: "remark", l: "Remark", t: "area", req: true }] } });
    a.push({ id: "edit", l: "Edit", loadsForm: true, why: r.status === "Approved" ? "Reject an approved request before changing its dates or type" : undefined });
  }
  if (approver || (own && r.status === LEAVE_WAITING)) a.push({ id: "delete", l: approver ? "Delete" : "Delete request", confirm: DELETE_WORDS });
  return a;
}

function leaveRow(ctx: HrmsContext, r: Req, p: Person | undefined, x: { book: BalBook; hol: Holiday[]; hiddenKeys: string[] }): ListRow {
  const name = p?.name ?? "";
  const bal = balOf(x.book, r.employeeId, r.startDate);
  const holIn = holidaysInside(x.hol, r.employeeId, p?.office ?? null, r.startDate, r.endDate);
  const split = has(ctx, "split");
  const fields: RowField[] = [
    { l: "Request", v: r.reqNo },
    { l: "Employee ID", v: p?.code ?? "" },
    { l: "Type", v: r.type },
    { l: "Reason", v: r.reason ?? "" },
    { l: "Available paid leave this month", v: String(bal.paid), der: true },
    { l: "Available unpaid leave this year", v: String(bal.unpaid), der: true },
    { l: "Holidays inside", v: String(holIn), der: true },
    { l: "Total leave taken this year", v: String(takenIn(x.book, r.employeeId, r.startDate.slice(0, 4))), der: true },
    ...(split
      ? [
          { l: "Paid leave", v: r.paid == null ? "" : String(r.paid) },
          { l: "Unpaid leave", v: r.unpaid == null ? "" : String(r.unpaid), der: true },
        ]
      : []),
    { l: "Approved by", v: r.approvedByName ?? "" },
    { l: "Approved on", v: fdShort(r.approvedOn) },
    { l: "Approver’s remark", v: r.officerRemark ?? "" },
    { l: "Status time", v: at(r.statusAt) },
    { l: "Requested at", v: at(r.createdAt) },
  ];
  const contacts: Contact[] = r.lat != null && r.lng != null ? [{ l: "Where it was raised", href: `https://maps.google.com/?q=${r.lat},${r.lng}` }] : [];
  return {
    id: r.id,
    v: withoutHidden(
      {
        date: r.appliedOn,
        reqId: r.reqNo,
        emp: name,
        type: r.type,
        start: r.startDate,
        end: r.endDate,
        days: Number(r.days),
        status: r.status,
        line: waitLine(r),
        paid: r.paid == null ? "" : Number(r.paid),
        unpaid: r.unpaid == null ? "" : Number(r.unpaid),
        monthLbl: monLabel(monthOf(r.startDate)),
        bPaid: bal.paid,
        bUnpaid: bal.unpaid,
        holIn,
        reason: r.reason ?? "",
        calLabel: first(name) + (r.type === "Half Day" ? " · half" : ""),
        calTone: r.status === "Approved" ? "success" : "warn",
      },
      x.hiddenKeys,
    ),
    flags: leaveFlags(r),
    title: `${name} · ${r.reqNo}`,
    header: `${r.type} · ${span(r)} · ${plural(Number(r.days), "day")} · ${r.status}`,
    fields,
    contacts,
    actions: leaveActions(ctx, r, name, bal),
    by: stampLine(null, r.createdAt),
    hiddenFields: split ? undefined : 2,
  };
}

async function requestsFor(ids: Set<string> | null): Promise<Req[]> {
  if (ids && !ids.size) return [];
  return db
    .select()
    .from(hrmsLeaveRequests)
    .where(ids ? inArray(hrmsLeaveRequests.employeeId, [...ids]) : undefined);
}

/* ------------------------------------------------------------- apply form */

/**
 * Who this person may raise a request for (spec §7.2, A55): themself; with
 * the on-behalf power, also the active Sales and Other staff of their own
 * office; an approver, any active employee. Null means "only yourself".
 */
function applyChoices(ctx: HrmsContext, people: Person[]): Person[] | null {
  if (has(ctx, "approveLeave")) return people.filter(isActive);
  if (!has(ctx, "onBehalf")) return null;
  const me = ctx.employee;
  const self = me ? people.filter((p) => p.id === me.id) : [];
  const staff = me ? people.filter((p) => isActive(p) && p.id !== me.id && isFieldOrOther(p) && p.office === me.office) : [];
  return [...self, ...staff];
}

async function applyForm(ctx: HrmsContext, people: Person[], screen: string): Promise<FormSpec | undefined> {
  const choices = applyChoices(ctx, people);
  if (!choices && !ctx.employee) return undefined;
  const pool = choices ?? people.filter((p) => p.id === ctx.employee!.id);
  const book = await balBook(pool.map((p) => p.id));
  const t = today();
  const months = [monthOf(t), nextMonth(monthOf(t))];
  /* The balances the form shows as the dates change, keyed "Name · CODE|YYYY-MM" → "paid|unpaid". */
  const bal: Record<string, string> = {};
  for (const p of pool)
    for (const m of months) {
      const b = balOf(book, p.id, `${m}-01`);
      bal[`${personOption(p)}|${m}`] = `${b.paid}|${b.unpaid}`;
    }
  const me = pool.find((p) => p.id === ctx.employee?.id);
  const approver = has(ctx, "approveLeave");
  const header: FieldSpec[] = [];
  if (choices)
    header.push({
      k: "emp",
      l: "Apply for",
      t: "select",
      req: true,
      opts: choices.map(personOption),
      /* Spec §7.1: an approver's default is blank — they are usually filing for somebody else. */
      def: approver || !me ? "" : personOption(me),
      hint: approver ? "Any active employee." : "You can apply on behalf of field and other staff of your office.",
    });
  header.push(
    { k: "type", l: "Type", t: "select", req: true, opts: ["Leave", "Half Day"], def: "Leave" },
    { k: "start", l: "Start date", t: "date", req: true, def: t },
    { k: "end", l: "End date", t: "date", req: true, when: { k: "type", eq: "Leave" }, hint: "In the same month as the start. Apply for next month’s days as a separate request." },
    { k: "days", l: "Days", t: "derived", calc: "hrms.leave.days" },
    { k: "bPaid", l: "Available paid leave this month", t: "derived", calc: "hrms.leave.paid" },
    { k: "bUnpaid", l: "Available unpaid leave this year", t: "derived", calc: "hrms.leave.unpaid" },
    { k: "reason", l: "Reason", t: "area", req: true, mic: true, hint: "Say why you need the leave, in full." },
  );
  return {
    screen,
    id: "apply",
    title: "Apply for leave",
    sub: "One request per month. Your balances update as you choose the dates.",
    submit: "Send request",
    header,
    data: { bal, me: me ? personOption(me) : "" },
  };
}

const LEAVE_TYPES: LeaveType[] = ["Leave", "Half Day"];

/** The request's dates and days, or the field error that stops it. */
function readDates(h: Values): { type: LeaveType; start: string; end: string; days: number } | ReturnType<typeof fieldErr> {
  const type = h.type as LeaveType;
  if (!LEAVE_TYPES.includes(type)) return fieldErr("type", "Pick Leave or Half Day");
  const start = text(h.start) ?? "";
  if (!ISO.test(start)) return fieldErr("start", "Pick a start date");
  const end = type === "Half Day" ? start : (text(h.end) ?? "");
  if (!ISO.test(end)) return fieldErr("end", "Pick an end date");
  return { type, start, end, days: leaveDays(type, start, end) };
}

/** Another live request of the employee that overlaps these dates, leaving out one being edited. */
async function clashOf(tx: Tx, employeeId: string, start: string, end: string, except?: string) {
  const [c] = await tx
    .select({ type: hrmsLeaveRequests.type, status: hrmsLeaveRequests.status })
    .from(hrmsLeaveRequests)
    .where(
      and(
        eq(hrmsLeaveRequests.employeeId, employeeId),
        ne(hrmsLeaveRequests.status, "Rejected"),
        lte(hrmsLeaveRequests.startDate, end),
        gte(hrmsLeaveRequests.endDate, start),
        except ? ne(hrmsLeaveRequests.id, except) : undefined,
      ),
    )
    .limit(1);
  return c ?? null;
}

async function submitApply(ctx: HrmsContext, h: Values) {
  const people = await allPeople();
  const choices = applyChoices(ctx, people);
  let p: Person | undefined;
  if (choices && text(h.emp)) {
    p = personFrom(h.emp, choices);
    if (!p || !choices.some((x) => x.id === p!.id)) return fieldErr("emp", "Pick a person from the list");
  } else if (ctx.employee) {
    p = byId(people).get(ctx.employee.id);
  } else if (choices) return fieldErr("emp", "Pick who the leave is for");
  if (!p) return err(NOT_LINKED, "not_permitted");
  const d = readDates(h);
  if ("ok" in d) return d;
  const who = p;
  const id = hrmsId("hlr");
  const box = { reqNo: "" };
  const res = await inTx(async (tx) => {
    const chk = checkRequest({ type: d.type, start: d.start, end: d.end, clash: await clashOf(tx, who.id, d.start, d.end) });
    if (chk) return refuse(fieldErr(chk.field, chk.message));
    box.reqNo = `LR-${String(await nextSeries(tx, "leave")).padStart(4, "0")}`;
    await tx.insert(hrmsLeaveRequests).values({
      id,
      reqNo: box.reqNo,
      employeeId: who.id,
      officeName: who.office,
      appliedOn: today(),
      type: d.type,
      startDate: d.start,
      endDate: d.end,
      days: d.days,
      reason: text(h.reason),
      status: LEAVE_WAITING,
      createdById: ctx.user.id,
    });
    return okVoid(`Leave request ${box.reqNo} sent for ${first(who.name)} · ${plural(d.days, "day")} · waiting for a decision`);
  });
  if (res.ok) {
    await hrmsAudit(ctx, "hrms.leave.apply", "hrms_leave_requests", id, null, { reqNo: box.reqNo, employee: who.code, ...d });
    await tellApprovers(ctx, { reqNo: box.reqNo, type: d.type, startDate: d.start, endDate: d.end, days: d.days }, who.name);
  }
  return res;
}

function editLoader(screen: string) {
  return async (ctx: HrmsContext, id: string): Promise<FormSpec | null> => {
    if (!has(ctx, "approveLeave")) return null;
    const [r] = await db.select().from(hrmsLeaveRequests).where(eq(hrmsLeaveRequests.id, id));
    if (!r || r.status === "Approved") return null;
    return {
      screen,
      id: "edit",
      title: `Edit ${r.reqNo}`,
      submit: "Save request",
      recordId: id,
      init: { type: r.type, start: r.startDate, end: r.endDate, reason: r.reason ?? "" },
      header: [
        { k: "type", l: "Type", t: "select", req: true, opts: ["Leave", "Half Day"] },
        { k: "start", l: "Start date", t: "date", req: true },
        { k: "end", l: "End date", t: "date", req: true, when: { k: "type", eq: "Leave" } },
        { k: "days", l: "Days", t: "derived", calc: "hrms.leave.days" },
        { k: "reason", l: "Reason", t: "area", req: true },
      ],
    };
  };
}

async function submitEdit(ctx: HrmsContext, h: Values, _lines: Values[], recordId?: string) {
  if (!has(ctx, "approveLeave")) return err("Only someone who approves leave can do this", "not_permitted");
  if (!recordId) return err("That request could not be found. Open it from the list again.", "not_found");
  const d = readDates(h);
  if ("ok" in d) return d;
  const box: { before?: Req } = {};
  const res = await inTx(async (tx) => {
    const [before] = await tx.select().from(hrmsLeaveRequests).where(eq(hrmsLeaveRequests.id, recordId)).for("update");
    if (!before) return refuse(err("That request no longer exists.", "not_found"));
    if (before.status === "Approved") return refuse(err("Reject an approved request before changing its dates or type"));
    box.before = before;
    const chk = checkRequest({ type: d.type, start: d.start, end: d.end, clash: await clashOf(tx, before.employeeId, d.start, d.end, recordId) });
    if (chk) return refuse(fieldErr(chk.field, chk.message));
    await tx
      .update(hrmsLeaveRequests)
      .set({ type: d.type, startDate: d.start, endDate: d.end, days: d.days, reason: text(h.reason), updatedAt: new Date(), updatedById: ctx.user.id })
      .where(eq(hrmsLeaveRequests.id, recordId));
    return okVoid(`${before.reqNo} saved · ${plural(d.days, "day")}`);
  });
  if (res.ok) await hrmsAudit(ctx, "hrms.leave.edit", "hrms_leave_requests", recordId, box.before, d);
  return res;
}

/* ---------------------------------------------------------- the decisions */

type Approved = { r: Req; paid: number; unpaid: number };

/**
 * Approves one request with `paid` paid days — or, for the bulk action, as
 * many as the employee has left — reading the balances inside the caller's
 * transaction with the request locked (spec §7.3).
 */
async function approveOne(ctx: HrmsContext, tx: Tx, id: string, paidWanted: number | "available"): Promise<Approved | { error: string; r?: Req }> {
  const [r] = await tx.select().from(hrmsLeaveRequests).where(eq(hrmsLeaveRequests.id, id)).for("update");
  if (!r) return { error: "That request no longer exists." };
  if (r.status === "Approved") return { error: `${r.reqNo} is already approved`, r };
  const book = await balBook([r.employeeId], tx);
  const bal = balOf(book, r.employeeId, r.startDate);
  const days = Number(r.days);
  const paid = paidWanted === "available" ? Math.min(days, bal.paid) : paidWanted;
  const why = checkApproval(days, paid, bal);
  if (why) return { error: why, r };
  const unpaid = Math.round((days - paid) * 100) / 100;
  await tx
    .update(hrmsLeaveRequests)
    .set({
      status: "Approved",
      paid,
      unpaid,
      approvedByName: ctx.user.name || "Admin",
      approvedById: ctx.user.id,
      approvedOn: today(),
      statusAt: new Date(),
      updatedAt: new Date(),
      updatedById: ctx.user.id,
    })
    .where(eq(hrmsLeaveRequests.id, id));
  return { r, paid, unpaid };
}

async function nameOf(employeeId: string): Promise<string> {
  const [e] = await db.select({ name: employees.name }).from(employees).where(eq(employees.id, employeeId));
  return e?.name ?? "";
}

const REJECTED = (ctx: HrmsContext, remark: string) => ({
  status: "Rejected",
  /* A rejected request pays nothing, so the split it carried goes with it. */
  paid: null,
  unpaid: null,
  officerRemark: remark,
  approvedByName: ctx.user.name || "Admin",
  approvedById: ctx.user.id,
  approvedOn: today(),
  statusAt: new Date(),
  updatedAt: new Date(),
  updatedById: ctx.user.id,
});

const LEAVE_ACTIONS: HrmsScreenModule["actions"] = {
  async approve(ctx, id, v) {
    if (!has(ctx, "approveLeave")) return err("Only someone who approves leave can do this", "not_permitted");
    const paid = num(v.paid);
    if (paid == null) return fieldErr("paid", "Enter the number of paid days");
    const box: { done?: Approved } = {};
    const res = await inTx(async (tx) => {
      const out = await approveOne(ctx, tx, id, paid);
      if ("error" in out) return refuse(out.r ? fieldErr("paid", out.error) : err(out.error, "not_found"));
      if (text(v.remark)) await tx.update(hrmsLeaveRequests).set({ officerRemark: text(v.remark) }).where(eq(hrmsLeaveRequests.id, id));
      box.done = out;
      return okVoid();
    });
    if (!res.ok || !box.done) return res;
    const { r, unpaid } = box.done;
    await hrmsAudit(ctx, "hrms.leave.approve", "hrms_leave_requests", id, { status: r.status }, { status: "Approved", paid, unpaid });
    await tellEmployee(ctx, r, `Approved · ${span(r)} · ${paid} paid, ${unpaid} unpaid${text(v.remark) ? ` · ${text(v.remark)}` : ""}`, "success");
    return okVoid(`Approved ${first(await nameOf(r.employeeId))}’s leave · ${paid} paid, ${unpaid} unpaid`);
  },
  async reject(ctx, id, v) {
    if (!has(ctx, "approveLeave")) return err("Only someone who approves leave can do this", "not_permitted");
    const remark = text(v.remark);
    if (!remark) return fieldErr("remark", "Give a reason for rejecting");
    const [r] = await db.select().from(hrmsLeaveRequests).where(eq(hrmsLeaveRequests.id, id));
    if (!r) return err("That request no longer exists.", "not_found");
    if (r.status === "Rejected") return err(`${r.reqNo} is already rejected`);
    await db.update(hrmsLeaveRequests).set(REJECTED(ctx, remark)).where(eq(hrmsLeaveRequests.id, id));
    await hrmsAudit(ctx, "hrms.leave.reject", "hrms_leave_requests", id, { status: r.status, paid: r.paid, unpaid: r.unpaid }, { status: "Rejected", remark });
    await tellEmployee(ctx, r, `Rejected · ${span(r)} · ${remark}`, "warn");
    return okVoid(`Rejected · ${first(await nameOf(r.employeeId))} has been told why`);
  },
  async remark(ctx, id, v) {
    if (!has(ctx, "approveLeave")) return err("Only someone who approves leave can do this", "not_permitted");
    const [r] = await db.select({ remark: hrmsLeaveRequests.officerRemark }).from(hrmsLeaveRequests).where(eq(hrmsLeaveRequests.id, id));
    if (!r) return err("That request no longer exists.", "not_found");
    await db.update(hrmsLeaveRequests).set({ officerRemark: text(v.remark), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsLeaveRequests.id, id));
    await hrmsAudit(ctx, "hrms.leave.remark", "hrms_leave_requests", id, { remark: r.remark }, { remark: text(v.remark) });
    return okVoid("Remark saved");
  },
  async delete(ctx, id) {
    const [r] = await db.select().from(hrmsLeaveRequests).where(eq(hrmsLeaveRequests.id, id));
    if (!r) return err("That request no longer exists.", "not_found");
    const own = r.employeeId === ctx.employee?.id && r.status === LEAVE_WAITING;
    if (!(has(ctx, "approveLeave") || own)) return err("You can delete only your own request, and only while it is waiting for a decision", "not_permitted");
    await db.delete(hrmsLeaveRequests).where(eq(hrmsLeaveRequests.id, id));
    await hrmsAudit(ctx, "hrms.leave.delete", "hrms_leave_requests", id, r, null);
    return okVoid("Request deleted");
  },
};

const LEAVE_BULK: HrmsScreenModule["bulk"] = {
  /* The design's "Approve with available paid": each request takes as many
     paid days as its employee has left, in turn and in one transaction, so
     two requests of one person in the same batch cannot spend one balance. */
  async approveBulk(ctx, ids) {
    if (!has(ctx, "approveLeave")) return err("Only someone who approves leave can do this", "not_permitted");
    const short: string[] = [];
    const decided: Approved[] = [];
    const res = await inTx(async (tx) => {
      for (const id of ids) {
        const out = await approveOne(ctx, tx, id, "available");
        if ("error" in out) {
          if (out.r && out.r.status !== "Approved") short.push(out.r.employeeId);
          continue;
        }
        decided.push(out);
      }
      return okVoid();
    });
    if (!res.ok) return res;
    for (const d of decided) {
      await hrmsAudit(ctx, "hrms.leave.approve", "hrms_leave_requests", d.r.id, { status: d.r.status }, { status: "Approved", paid: d.paid, unpaid: d.unpaid, bulk: true });
      await tellEmployee(ctx, d.r, `Approved · ${span(d.r)} · ${d.paid} paid, ${d.unpaid} unpaid`, "success");
    }
    const people = byId(await allPeople());
    const names = [...new Set(short)].map((e) => first(people.get(e)?.name));
    return okVoid(`${decided.length} approved${names.length ? ` · not approved for ${names.join(", ")}: not enough unpaid leave left this year` : ""}`);
  },
  async rejectBulk(ctx, ids, v) {
    if (!has(ctx, "approveLeave")) return err("Only someone who approves leave can do this", "not_permitted");
    if (!ids.length) return okVoid("Nothing selected");
    const remark = text(v.remark) ?? "Rejected in bulk";
    const rows = (await db.select().from(hrmsLeaveRequests).where(inArray(hrmsLeaveRequests.id, ids))).filter((r) => r.status !== "Rejected");
    if (!rows.length) return okVoid("0 rejected");
    await db
      .update(hrmsLeaveRequests)
      .set(REJECTED(ctx, remark))
      .where(inArray(hrmsLeaveRequests.id, rows.map((r) => r.id)));
    for (const r of rows) {
      await hrmsAudit(ctx, "hrms.leave.reject", "hrms_leave_requests", r.id, { status: r.status }, { status: "Rejected", remark, bulk: true });
      await tellEmployee(ctx, r, `Rejected · ${span(r)} · ${remark}`, "warn");
    }
    return okVoid(`${rows.length} rejected`);
  },
};

const LEAVE_FORMS: HrmsScreenModule["forms"] = { apply: submitApply, edit: submitEdit };

/* ------------------------------------------------------------ the screens */

const leave: HrmsScreenModule = {
  key: "leave",
  async load(ctx, q) {
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "approveLeave", "hr");
    const ids = visibleIds(ctx, scope, people);
    const [reqs, book, hol, form] = await Promise.all([requestsFor(ids), balBook(ids ? [...ids] : null), holidays(), applyForm(ctx, people, "leave")]);
    const vc = visibleCols(LEAVE_COLS, hasP(ctx));
    const pb = byId(people);
    return {
      spec: {
        screen: "leave",
        cols: vc.cols,
        hidden: vc.hidden,
        groups: ["monthLbl"],
        chips: "status",
        sortDefault: ["start", -1],
        newForm: form,
        newLabel: "Apply for leave",
        noDataLine: "No leave requests yet.",
        hrms: {
          scope: { current: scope, options },
          ...(!form ? { notice: { text: NOT_LINKED, tone: "warn" as const } } : {}),
        },
      },
      rows: reqs.map((r) => leaveRow(ctx, r, pb.get(r.employeeId), { book, hol, hiddenKeys: vc.hiddenKeys })),
    };
  },
  actions: LEAVE_ACTIONS,
  forms: LEAVE_FORMS,
  formLoaders: { edit: editLoader("leave") },
};

const approvals: HrmsScreenModule = {
  key: "approvals",
  async load(ctx, q) {
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "approveLeave", "hr");
    const ids = visibleIds(ctx, scope, people);
    const reqs = (await requestsFor(ids)).filter((r) => r.status === LEAVE_WAITING);
    const [book, hol] = await Promise.all([balBook([...new Set(reqs.map((r) => r.employeeId))]), holidays()]);
    const pb = byId(people);
    const approver = has(ctx, "approveLeave");
    return {
      spec: {
        screen: "approvals",
        cols: [
          { k: "emp", l: "Employee", t: "b" },
          { k: "type", l: "Type", t: "s" },
          { k: "start", l: "From", t: "d" },
          { k: "end", l: "To", t: "d" },
          { k: "days", l: "Days", t: "n" },
          { k: "bPaid", l: "Available paid", t: "n" },
          { k: "bUnpaid", l: "Available unpaid", t: "n" },
          { k: "holIn", l: "Holidays inside", t: "n" },
          { k: "reason", l: "Reason", t: "t" },
        ],
        hidden: [],
        groups: ["emp"],
        groupSel: approver,
        sortDefault: ["start", -1],
        bulk: approver
          ? [
              { id: "approveBulk", l: "Approve with available paid", confirm: "Approve the selected requests, each with as much paid leave as its employee has left?" },
              { id: "rejectBulk", l: "Reject", prompt: { title: "Reject the selected requests", submit: "Reject", fields: [{ k: "remark", l: "Reason for rejecting", t: "area" }] } },
            ]
          : [],
        noDataLine: "Nothing is waiting for a decision.",
        hrms: {
          scope: { current: scope, options },
          ...(approver ? {} : { notice: { text: "You can read this queue. Only someone who approves leave can decide on it.", tone: "info" as const } }),
        },
      },
      /* The queue draws no paid/unpaid columns, but the row's data still went to
         the browser; somebody without the split power must not receive it. */
      rows: reqs.map((r) => leaveRow(ctx, r, pb.get(r.employeeId), { book, hol, hiddenKeys: visibleCols(LEAVE_COLS, hasP(ctx)).hiddenKeys })),
    };
  },
  actions: LEAVE_ACTIONS,
  bulk: LEAVE_BULK,
  forms: LEAVE_FORMS,
  formLoaders: { edit: editLoader("approvals") },
};

const leaveCal: HrmsScreenModule = {
  key: "leaveCal",
  async load(ctx, q) {
    const month = q.month && MONTH.test(q.month) ? q.month : monthOf(today());
    const from = `${month}-01`;
    const to = monthEnd(month);
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "approveLeave", "hr");
    const ids = visibleIds(ctx, scope, people);
    const reqs = (await requestsFor(ids)).filter((r) => r.status !== "Rejected" && r.startDate <= to && r.endDate >= from);
    const [book, hol] = await Promise.all([balBook([...new Set(reqs.map((r) => r.employeeId))]), holidays()]);
    const pb = byId(people);
    const hiddenKeys = visibleCols(LEAVE_COLS, hasP(ctx)).hiddenKeys;
    /* One name per date — the calendar draws the first it finds — preferring a holiday for everybody. */
    const seen = new Set<string>();
    const hols = hol
      .filter((h) => h.date >= from && h.date <= to)
      .sort((a, b) => Number(b.tagged === "All employees") - Number(a.tagged === "All employees"))
      .filter((h) => (seen.has(h.date) ? false : (seen.add(h.date), true)))
      .map((h) => ({ date: h.date, name: h.name }));
    return {
      spec: {
        screen: "leaveCal",
        cols: [
          { k: "emp", l: "Employee", t: "b" },
          { k: "start", l: "From", t: "d" },
          { k: "end", l: "To", t: "d" },
          { k: "status", l: "Status", t: "s" },
        ],
        hidden: [],
        sortDefault: ["start", 1],
        noDataLine: `No leave in ${monthName(month)}.`,
        hrms: {
          scope: { current: scope, options },
          calendar: { from: "start", to: "end", label: "calLabel", tone: "calTone", month, holidays: hols },
        },
      },
      rows: reqs.map((r) => leaveRow(ctx, r, pb.get(r.employeeId), { book, hol, hiddenKeys })),
    };
  },
  actions: LEAVE_ACTIONS,
  forms: LEAVE_FORMS,
  formLoaders: { edit: editLoader("leaveCal") },
};

/* ----------------------------------------------------------- leave setup */

const canRunCredits = (ctx: HrmsContext) => has(ctx, "hr") || has(ctx, "approveLeave") || has(ctx, "admin");
const canHandCredit = (ctx: HrmsContext) => has(ctx, "hr") || has(ctx, "admin");

const leaveSetup: HrmsScreenModule = {
  key: "leaveSetup",
  async load(ctx, q) {
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "hr", "approveLeave", "entitle");
    const ids = visibleIds(ctx, scope, people);
    const rows = ids && !ids.size ? [] : await db.select().from(hrmsLeaveCredits).where(ids ? inArray(hrmsLeaveCredits.employeeId, [...ids]) : undefined);
    const pb = byId(people);
    const t = monthOf(today());
    const hand = canHandCredit(ctx);
    return {
      spec: {
        screen: "leaveSetup",
        cols: [
          { k: "monthLbl", l: "Month", t: "t" },
          { k: "emp", l: "Employee", t: "b" },
          { k: "office", l: "Office", t: "t" },
          { k: "days", l: "Paid leave credited", t: "n" },
          { k: "auto", l: "Source", t: "t" },
        ],
        hidden: [],
        groups: ["monthLbl"],
        agg: { k: "days", l: "days credited" },
        sortDefault: ["month", -1],
        newForm: hand
          ? {
              screen: "leaveSetup",
              id: "credit",
              title: "Add a paid-leave credit",
              sub: "Credits are created on the 1st automatically; add one by hand for a correction.",
              submit: "Add credit",
              init: { month: t },
              header: [
                { k: "emp", l: "Employee", t: "select", req: true, opts: people.filter(isActive).map(personOption) },
                { k: "month", l: "Month", t: "select", req: true, opts: [prevMonth(t), t, nextMonth(t)] },
                { k: "days", l: "Days", t: "num", req: true, min: 0, max: 31 },
              ],
            }
          : undefined,
        newLabel: "Add a credit",
        tools: [
          {
            id: "runCredits",
            l: "Run now",
            why: canRunCredits(ctx) ? undefined : "Only HR, someone who approves leave, or an HRMS administrator can run the monthly credit",
            confirm: `Credit ${monthName(t)}’s paid leave to every active employee who has not had it yet?`,
          },
        ],
        noDataLine: "No credits yet. They are created on the 1st of each month.",
        hrms: { scope: { current: scope, options } },
      },
      rows: rows.map((c) => {
        const p = pb.get(c.employeeId);
        const days = Number(c.days);
        const a: ActionSpec[] = [];
        if (hand)
          a.push({
            id: "editCredit",
            l: "Edit",
            prompt: { title: "Edit credit", sub: `${p?.name ?? ""} · ${monLabel(c.month)}`, submit: "Save", init: { days: String(days) }, fields: [{ k: "days", l: "Days", t: "num", req: true, min: 0, max: 31 }] },
          });
        a.push({ id: "deleteCredit", l: "Delete", why: has(ctx, "admin") ? undefined : "Only an HRMS administrator can delete a credit", confirm: `Delete ${p?.name ?? ""}’s ${monLabel(c.month)} credit?` });
        return {
          id: c.id,
          v: { month: c.month, monthLbl: monLabel(c.month), emp: p?.name ?? "", office: p?.office ?? "", days, auto: c.source === "job" ? "Monthly job" : "Added by hand" },
          flags: [],
          title: `${p?.name ?? ""} · ${monLabel(c.month)}`,
          header: `${days} days · ${c.source === "job" ? "created by the monthly job" : "added by hand"}`,
          fields: [
            { l: "Employee ID", v: p?.code ?? "" },
            { l: "Month", v: monLabel(c.month) },
            { l: "Assigned leave", v: String(days) },
          ],
          actions: a,
          by: stampLine(null, c.createdAt),
        };
      }),
    };
  },
  actions: {
    async editCredit(ctx, id, v) {
      if (!canHandCredit(ctx)) return err("Only HR or an HRMS administrator can change a credit", "not_permitted");
      const days = num(v.days);
      if (days == null || days < 0 || days > 31) return fieldErr("days", "Days must be a number from 0 to 31");
      const [c] = await db.select().from(hrmsLeaveCredits).where(eq(hrmsLeaveCredits.id, id));
      if (!c) return err("That credit no longer exists.", "not_found");
      await db.update(hrmsLeaveCredits).set({ days, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsLeaveCredits.id, id));
      await hrmsAudit(ctx, "hrms.leaveCredit.edit", "hrms_leave_credits", id, { days: c.days }, { days });
      return okVoid("Credit saved");
    },
    async deleteCredit(ctx, id) {
      if (!has(ctx, "admin")) return err("Only an HRMS administrator can delete a credit", "not_permitted");
      const [c] = await db.select().from(hrmsLeaveCredits).where(eq(hrmsLeaveCredits.id, id));
      if (!c) return err("That credit no longer exists.", "not_found");
      await db.delete(hrmsLeaveCredits).where(eq(hrmsLeaveCredits.id, id));
      await hrmsAudit(ctx, "hrms.leaveCredit.delete", "hrms_leave_credits", id, c, null);
      return okVoid("Credit deleted");
    },
  },
  forms: {
    async credit(ctx, h) {
      if (!canHandCredit(ctx)) return err("Only HR or an HRMS administrator can add a credit", "not_permitted");
      const p = personFrom(h.emp, (await allPeople()).filter(isActive));
      if (!p) return fieldErr("emp", "Pick an active employee from the list");
      const month = text(h.month) ?? "";
      if (!MONTH.test(month)) return fieldErr("month", "Pick a month from the list");
      const days = num(h.days);
      if (days == null || days < 0 || days > 31) return fieldErr("days", "Days must be a number from 0 to 31");
      const id = hrmsId("hlc");
      await db.insert(hrmsLeaveCredits).values({ id, employeeId: p.id, month, days, source: "hand", createdById: ctx.user.id });
      await hrmsAudit(ctx, "hrms.leaveCredit.add", "hrms_leave_credits", id, null, { employee: p.code, month, days });
      return okVoid(`${days} days credited to ${p.name}`);
    },
  },
  tools: {
    async runCredits(ctx) {
      if (!canRunCredits(ctx)) return err("Only HR, someone who approves leave, or an HRMS administrator can run the monthly credit", "not_permitted");
      const m = monthOf(today());
      const { created } = await runMonthlyLeaveCredit(m);
      await hrmsAudit(ctx, "hrms.leaveCredit.run", "hrms_leave_credits", null, null, { month: m, created });
      return okVoid(created ? `${monthName(m)} credits created for ${plural(created, "employee")}` : `${monthName(m)} credits already exist for everyone`);
    },
  },
};

/* --------------------------------------------------------------- holidays */

const HOLIDAY_CATS: string[] = [...HOLIDAY_CATEGORIES];
const EVERYONE = "All employees";
const NAMED = "Named employees";
const canKeepHolidays = (ctx: HrmsContext) => has(ctx, "hr") || has(ctx, "admin");
const canImportHolidays = (ctx: HrmsContext) => has(ctx, "import") || has(ctx, "admin");

/** "Festival Holiday" (the source's spelling), "festival" and the old "Nature" all read as today's word. */
function readCategory(v: string | undefined): string | null {
  const s = fromOld(
    String(v ?? "")
      .trim()
      .replace(/\s+holiday$/i, ""),
  ).toLowerCase();
  return HOLIDAY_CATS.find((c) => c.toLowerCase() === s) ?? null;
}

/** Same date, and either side covers everybody or both name the same group: a duplicate. */
function clashes(a: { date: string; tagged: string }, b: { date: string; tagged: string }) {
  return a.date === b.date && (a.tagged === b.tagged || a.tagged === EVERYONE || b.tagged === EVERYONE);
}

function holidayForm(officeNames: string[], people: Person[], init?: Record<string, string>): FormSpec {
  return {
    screen: "holidays",
    id: "add",
    title: "Add holidays",
    sub: "Add more puts the next holiday on its own line.",
    submit: "Save holidays",
    lineLabel: "Holiday",
    init: init ?? { tagged: EVERYONE },
    header: [
      { k: "tagged", l: "Tagged employees", t: "select", req: true, opts: [EVERYONE, ...officeNames, NAMED], def: EVERYONE },
      { k: "people", l: "Employees", t: "multi", opts: people.filter(isActive).map(personOption), when: { k: "tagged", eq: NAMED } },
    ],
    line: [
      { k: "date", l: "Date", t: "date", req: true },
      { k: "day", l: "Day", t: "derived", calc: "hrms.weekday" },
      { k: "category", l: "Category", t: "select", req: true, opts: HOLIDAY_CATS },
      { k: "name", l: "Holiday name", t: "text", req: true },
      { k: "remark", l: "Remark", t: "text" },
    ],
  };
}

type HolidayLine = { date: string; category: string; name: string; tagged: string; remark: string; error: string };

async function readHolidayCsv(csvText: string): Promise<HolidayLine[]> {
  const [existing, officeRows] = await Promise.all([holidays(), offices()]);
  const officeNames = new Set(officeRows.map((o) => o.name));
  const pick = (r: Record<string, string>, ...keys: string[]) => {
    for (const k of Object.keys(r)) if (keys.includes(k.trim().toLowerCase())) return String(r[k] ?? "").trim();
    return "";
  };
  const taken = existing.map((h) => ({ date: h.date, tagged: h.tagged }));
  return parseCsv(csvText).map((r) => {
    const date = pick(r, "date");
    const category = readCategory(pick(r, "category"));
    const name = pick(r, "holiday name", "holiday", "name");
    const tagged = pick(r, "tagged", "tagged employees", "office") || EVERYONE;
    let error = "";
    if (!ISO.test(date)) error = "Date must be YYYY-MM-DD";
    else if (!category) error = `Category must be one of ${HOLIDAY_CATS.join(", ")}`;
    else if (!name) error = "Holiday name is required";
    else if (tagged !== EVERYONE && !officeNames.has(tagged)) error = `Unknown office ${tagged}`;
    else if (taken.some((t) => clashes(t, { date, tagged }))) error = `A holiday for ${tagged} on ${date} already exists`;
    if (!error) taken.push({ date, tagged });
    return { date, category: category ?? "", name, tagged, remark: pick(r, "remark"), error };
  });
}

const holidaysScreen: HrmsScreenModule = {
  key: "holidays",
  async load(ctx, q) {
    const window = (await getConfig())["hrms.holidays.editWindowDays"];
    const t = today();
    const conds = [q.from && ISO.test(q.from) ? gte(hrmsHolidays.date, q.from) : undefined, q.to && ISO.test(q.to) ? lte(hrmsHolidays.date, q.to) : undefined];
    const [rows, officeRows, people] = await Promise.all([db.select().from(hrmsHolidays).where(and(...conds)), offices(), allPeople()]);
    const officeNames = officeRows.map((o) => o.name);
    const pb = byId(people);
    const keep = canKeepHolidays(ctx);
    return {
      spec: {
        screen: "holidays",
        cols: [
          { k: "date", l: "Date", t: "d" },
          { k: "day", l: "Day", t: "t" },
          { k: "category", l: "Category", t: "s" },
          { k: "name", l: "Holiday", t: "b" },
          { k: "tagged", l: "Tagged employees", t: "t" },
          { k: "remark", l: "Remark", t: "t" },
        ],
        hidden: [],
        groups: ["monthLbl"],
        chips: "category",
        sortDefault: ["date", -1],
        newForm: keep ? holidayForm(officeNames, people) : undefined,
        newLabel: "Add holidays",
        tools: canImportHolidays(ctx)
          ? [
              {
                id: "import",
                l: "Import CSV",
                prompt: {
                  title: "Import holidays from CSV",
                  sub: "Columns: Date (YYYY-MM-DD), Category, Holiday Name, Tagged (All employees or an office), Remark. You see every row before anything is written.",
                  submit: "Preview",
                  fields: [{ k: "csv", l: "CSV file", t: "csv", req: true }],
                },
              },
            ]
          : [],
        /* Spec §7.6: "Download holiday" is admin's. */
        download: has(ctx, "admin"),
        noDataLine: "No holidays yet.",
      },
      rows: rows.map((h) => {
        const named = h.taggedEmployeeIds.map((id) => pb.get(id)?.name ?? "").filter(Boolean);
        const tagged = named.length && h.tagged !== EVERYONE && !officeNames.includes(h.tagged) ? named.join(", ") : h.tagged;
        const editable = h.date >= t || daysBetweenISO(h.date, t) <= window;
        const a: ActionSpec[] = [];
        if (keep) {
          const again = h.taggedEmployeeIds
            .map((id) => pb.get(id))
            .filter((p): p is Person => !!p)
            .map(personOption)
            .join("|");
          a.push({ id: "addMore", l: "Add more", primary: true, form: holidayForm(officeNames, people, { tagged: named.length ? NAMED : h.tagged, ...(again ? { people: again } : {}) }) });
          a.push({
            id: "edit",
            l: "Edit",
            why: editable ? undefined : `Only holidays from the last ${window} days can be edited`,
            prompt: {
              title: "Edit holiday",
              sub: `${fdShort(h.date)} · ${weekdayOf(h.date)}`,
              submit: "Save",
              init: { name: h.name, category: h.category, remark: h.remark ?? "" },
              fields: [
                { k: "name", l: "Holiday name", t: "text", req: true },
                { k: "category", l: "Category", t: "select", req: true, opts: HOLIDAY_CATS },
                { k: "remark", l: "Remark", t: "text" },
              ],
            },
          });
        }
        a.push({ id: "delete", l: "Delete", why: has(ctx, "admin") ? undefined : "Only an HRMS administrator can delete a holiday", confirm: `Delete ${h.name} on ${fdShort(h.date)}?` });
        return {
          id: h.id,
          v: { date: h.date, day: weekdayOf(h.date), category: h.category, name: h.name, tagged, remark: h.remark ?? "", monthLbl: monLabel(monthOf(h.date)), year: h.date.slice(0, 4) },
          flags: [],
          title: `${h.name} · ${fdShort(h.date)}`,
          header: `${weekdayOf(h.date)} · ${h.category} · ${tagged}`,
          fields: [
            { l: "Year", v: h.date.slice(0, 4), der: true },
            { l: "Day", v: weekdayOf(h.date), der: true },
            { l: "Remark", v: h.remark ?? "" },
          ],
          actions: a,
          by: stampLine(h.createdByName, h.updatedAt),
        };
      }),
    };
  },
  actions: {
    async edit(ctx, id, v) {
      if (!canKeepHolidays(ctx)) return err("Only HR or an HRMS administrator can edit a holiday", "not_permitted");
      const [h] = await db.select().from(hrmsHolidays).where(eq(hrmsHolidays.id, id));
      if (!h) return err("That holiday no longer exists.", "not_found");
      const window = (await getConfig())["hrms.holidays.editWindowDays"];
      const t = today();
      if (h.date < t && daysBetweenISO(h.date, t) > window) return err(`Only holidays from the last ${window} days can be edited`);
      const category = readCategory(v.category);
      if (!category) return fieldErr("category", "Pick a category from the list");
      const name = text(v.name);
      if (!name) return fieldErr("name", "Holiday name is required");
      const after = { name, category, remark: text(v.remark) };
      await db.update(hrmsHolidays).set({ ...after, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsHolidays.id, id));
      await hrmsAudit(ctx, "hrms.holiday.edit", "hrms_holidays", id, { name: h.name, category: h.category, remark: h.remark }, after);
      return okVoid("Holiday updated");
    },
    async delete(ctx, id) {
      if (!has(ctx, "admin")) return err("Only an HRMS administrator can delete a holiday", "not_permitted");
      const [h] = await db.select().from(hrmsHolidays).where(eq(hrmsHolidays.id, id));
      if (!h) return err("That holiday no longer exists.", "not_found");
      await db.delete(hrmsHolidays).where(eq(hrmsHolidays.id, id));
      await hrmsAudit(ctx, "hrms.holiday.delete", "hrms_holidays", id, h, null);
      return okVoid("Holiday deleted");
    },
  },
  forms: {
    async add(ctx, h, lines) {
      if (!canKeepHolidays(ctx)) return err("Only HR or an HRMS administrator can add holidays", "not_permitted");
      const [officeRows, people, existing] = await Promise.all([offices(), allPeople(), holidays()]);
      const tagged = text(h.tagged) ?? "";
      if (tagged !== EVERYONE && tagged !== NAMED && !officeRows.some((o) => o.name === tagged)) return fieldErr("tagged", tagged ? `${tagged} is not one of the choices. Pick from the list.` : "Pick who the holidays are for");
      let named: string[] = [];
      if (tagged === NAMED) {
        const act = people.filter(isActive);
        const picked = multi(h.people).map((o) => personFrom(o, act));
        if (!picked.length) return fieldErr("people", "Pick who the holiday is for");
        if (picked.some((p) => !p)) return fieldErr("people", "Pick active employees from the list");
        named = picked.map((p) => p!.id);
      }
      if (!lines.length) return err("Add at least one holiday");
      const rows: (typeof hrmsHolidays.$inferInsert)[] = [];
      const taken = existing.map((x) => ({ date: x.date, tagged: x.tagged }));
      for (const [i, l] of lines.entries()) {
        const date = text(l.date) ?? "";
        if (!ISO.test(date)) return fieldErr(`l${i}.date`, "Pick a date");
        const category = readCategory(l.category);
        if (!category) return fieldErr(`l${i}.category`, "Pick a category");
        const name = text(l.name);
        if (!name) return fieldErr(`l${i}.name`, "Holiday name is required");
        /* A holiday for named people clashes only with an everybody holiday:
           two different lists of names on one date are two holidays. */
        const dupe = tagged === NAMED ? taken.some((x) => x.date === date && x.tagged === EVERYONE) : taken.some((x) => clashes(x, { date, tagged }));
        if (dupe) return fieldErr(`l${i}.date`, `There is already a holiday on ${fdShort(date)} for these employees`);
        if (tagged !== NAMED) taken.push({ date, tagged });
        rows.push({ id: hrmsId("hhol"), date, category, name, tagged, taggedEmployeeIds: named, remark: text(l.remark), createdByName: ctx.user.name, createdById: ctx.user.id });
      }
      await db.insert(hrmsHolidays).values(rows);
      await hrmsAudit(ctx, "hrms.holiday.add", "hrms_holidays", null, null, { tagged, named, dates: rows.map((r) => r.date) });
      return okVoid(`${plural(rows.length, "holiday")} added for ${tagged === NAMED ? plural(named.length, "employee") : tagged.toLowerCase()}`);
    },
  },
  tools: {
    async import(ctx, v) {
      if (!canImportHolidays(ctx)) return err("Only someone who can import holidays can do this", "not_permitted");
      const lines = await readHolidayCsv(v.csv ?? "");
      if (!lines.length) return fieldErr("csv", "The file has no rows under its header.");
      const good = lines.filter((l) => !l.error).length;
      return ok({
        dialog: {
          title: "Import holidays from CSV",
          sub: `${good} rows ready · ${lines.length - good} with errors are skipped`,
          lines: lines.map((l, i) => ({
            text: `Row ${i + 2} · ${l.date} · ${l.name || "(no name)"} · ${l.category || "?"} · ${l.tagged}${l.error ? ` — ${l.error}` : ""}`,
            tone: l.error ? ("danger" as const) : undefined,
          })),
          next: good ? { tool: "importConfirm", label: `Import ${good} rows`, values: { csv: v.csv ?? "" } } : undefined,
        },
      });
    },
    async importConfirm(ctx, v) {
      if (!canImportHolidays(ctx)) return err("Only someone who can import holidays can do this", "not_permitted");
      /* Read again rather than trusting the preview: a holiday added since is a duplicate now. */
      const lines = (await readHolidayCsv(v.csv ?? "")).filter((l) => !l.error);
      if (!lines.length) return okVoid("Nothing to import");
      await db
        .insert(hrmsHolidays)
        .values(lines.map((l) => ({ id: hrmsId("hhol"), date: l.date, category: l.category, name: l.name, tagged: l.tagged, remark: l.remark || null, createdByName: `Import by ${ctx.user.name}`, createdById: ctx.user.id })));
      await hrmsAudit(ctx, "hrms.holiday.import", "hrms_holidays", null, null, { added: lines.length });
      return okVoid(`${plural(lines.length, "holiday")} imported`);
    },
  },
};

/* --------------------------------------------------------------- overtime */

type OtDay = { checkIn: string; checkOut: string | null; officialIn: string | null; officialOut: string | null };

/**
 * The OT a day's attendance gives a slot (spec §8): Before Duty runs from the
 * check-in to the official in time, After Duty from the official out time to
 * the check-out. Null when that day cannot give one at all.
 */
function otSpan(a: OtDay | undefined, slot: string): { start: string; end: string; minutes: number | null } | null {
  if (!a) return null;
  const start = slot === "Before Duty" ? a.checkIn : a.officialOut;
  const end = slot === "Before Duty" ? a.officialIn : a.checkOut;
  if (!start || !end) return null;
  return { start, end, minutes: minutesBetween(start, end) };
}

const canOtAnyone = (ctx: HrmsContext) => has(ctx, "hr") || has(ctx, "admin");

/** Why a slot gives no overtime, said for the case at hand. */
function otRefusal(s: { minutes: number | null } | null, slot: string, minMin: number): string {
  if (!s) return `That day’s attendance does not have the times needed for overtime ${slot.toLowerCase()}`;
  if (s.minutes == null) return `No overtime ${slot.toLowerCase()} that day`;
  return `Not overtime: ${s.minutes} minutes ${slot.toLowerCase()}, and it must be more than ${minMin}`;
}
const OT_SLOTS = ["After Duty", "Before Duty"];

async function attendanceDay(employeeId: string, date: string): Promise<OtDay | undefined> {
  const [a] = await db
    .select({ checkIn: hrmsAttendance.checkIn, checkOut: hrmsAttendance.checkOut, officialIn: hrmsAttendance.officialIn, officialOut: hrmsAttendance.officialOut })
    .from(hrmsAttendance)
    .where(and(eq(hrmsAttendance.employeeId, employeeId), eq(hrmsAttendance.date, date)));
  return a;
}

const overtime: HrmsScreenModule = {
  key: "overtime",
  async load(ctx, q) {
    const people = await allPeople();
    const pb = byId(people);
    const { scope, options } = scopeFor(ctx, q, "hr");
    const ids = visibleIds(ctx, scope, people);
    const rows = ids && !ids.size ? [] : await db.select().from(hrmsOvertime).where(ids ? inArray(hrmsOvertime.employeeId, [...ids]) : undefined);
    /* Spec §8 / A06: the month's total is by month AND year. */
    const total = new Map<string, number>();
    for (const r of rows) {
      const k = `${r.employeeId}|${monthOf(r.date)}`;
      total.set(k, (total.get(k) ?? 0) + r.minutes);
    }
    const minMin = (await getConfig())["hrms.ot.minMinutes"];

    const anyone = canOtAnyone(ctx);
    const choices = anyone ? people.filter(isActive) : people.filter((p) => p.id === ctx.employee?.id);
    const t = today();
    /* The last month of attendance, for the form's start / end / hours preview: "in|out|officialIn|officialOut". */
    const days = ctx.flags.ot && choices.length ? await attendanceRows({ employeeIds: choices.map((p) => p.id), from: addDaysISO(t, -31), to: t }) : [];
    const att: Record<string, string> = {};
    for (const d of days) {
      const p = pb.get(d.employeeId);
      if (p) att[`${personOption(p)}|${d.date}`] = [d.checkIn, d.checkOut ?? "", d.officialIn ?? "", d.officialOut ?? ""].join("|");
    }
    const me = choices.find((p) => p.id === ctx.employee?.id);
    const form: FormSpec | undefined =
      ctx.flags.ot && choices.length
        ? {
            screen: "overtime",
            id: "add",
            title: "Add overtime",
            sub: "Start and end fill from that day’s attendance.",
            submit: "Save overtime",
            init: { date: t, slot: "After Duty", ...(me ? { emp: personOption(me) } : {}) },
            data: { att, minMinutes: minMin },
            header: [
              { k: "emp", l: "Employee", t: "select", req: true, opts: choices.map(personOption), readOnly: !anyone },
              { k: "date", l: "Date", t: "date", req: true },
              { k: "slot", l: "Slot", t: "select", req: true, opts: OT_SLOTS },
              { k: "start", l: "Start", t: "derived", calc: "hrms.ot.start" },
              { k: "end", l: "End", t: "derived", calc: "hrms.ot.end" },
              { k: "hrs", l: "OT hours", t: "derived", calc: "hrms.ot.hours" },
              { k: "remark", l: "Remark", t: "area" },
            ],
          }
        : undefined;

    return {
      spec: {
        screen: "overtime",
        cols: [
          { k: "date", l: "Date", t: "d" },
          { k: "emp", l: "Employee", t: "b" },
          { k: "slot", l: "Slot", t: "s" },
          { k: "start", l: "Start", t: "t" },
          { k: "end", l: "End", t: "t" },
          { k: "hrs", l: "OT hours", t: "t" },
          { k: "mins", l: "Minutes", t: "n" },
          { k: "remark", l: "Remark", t: "t" },
        ],
        hidden: [],
        groups: ["monthLbl"],
        agg: { k: "mins", l: "minutes" },
        sortDefault: ["date", -1],
        newForm: form,
        newLabel: "Add overtime",
        noDataLine: `No overtime yet. Overtime must be more than ${minMin} minutes to count.`,
        hrms: {
          scope: { current: scope, options },
          ...(ctx.flags.ot ? {} : { notice: { text: "Overtime is switched off in HRMS settings", tone: "warn" as const } }),
        },
      },
      rows: rows.map((r) => {
        const p = pb.get(r.employeeId);
        const own = r.employeeId === ctx.employee?.id;
        const mayChange = own || anyone;
        const m = monthOf(r.date);
        return {
          id: r.id,
          v: { date: r.date, emp: p?.name ?? "", slot: r.slot, start: r.startTime, end: r.endTime, hrs: hm(r.minutes), mins: r.minutes, remark: r.remark ?? "", monthLbl: monLabel(m) },
          flags: own ? ["mine"] : [],
          title: `${p?.name ?? ""} · ${fdShort(r.date)}`,
          header: `${r.slot} · ${r.startTime} – ${r.endTime} · ${hm(r.minutes)}`,
          fields: [
            { l: "Employee ID", v: p?.code ?? "" },
            { l: "OT hours", v: hm(r.minutes), der: true },
            { l: `Total OT in ${monLabel(m)}`, v: hm(total.get(`${r.employeeId}|${m}`) ?? 0), der: true },
            { l: "Remark", v: r.remark ?? "" },
          ],
          actions: [
            {
              id: "edit",
              l: "Edit",
              why: mayChange ? undefined : "Only the employee, HR or an HRMS administrator can change this overtime",
              prompt: {
                title: "Edit overtime",
                sub: `${p?.name ?? ""} · ${fdShort(r.date)} · start and end are read again from that day’s attendance`,
                submit: "Save",
                init: { slot: r.slot, remark: r.remark ?? "" },
                fields: [
                  { k: "slot", l: "Slot", t: "select", req: true, opts: OT_SLOTS },
                  { k: "remark", l: "Remark", t: "area" },
                ],
              },
            },
            { id: "delete", l: "Delete", why: mayChange ? undefined : "Only the employee, HR or an HRMS administrator can delete this overtime", confirm: "Delete this overtime record?" },
          ],
          by: stampLine(null, r.createdAt),
        };
      }),
    };
  },
  actions: {
    async edit(ctx, id, v) {
      if (!ctx.flags.ot) return err("Overtime is switched off", "not_permitted");
      const [r] = await db.select().from(hrmsOvertime).where(eq(hrmsOvertime.id, id));
      if (!r) return err("That overtime no longer exists.", "not_found");
      if (!(r.employeeId === ctx.employee?.id || canOtAnyone(ctx))) return err("Only the employee, HR or an HRMS administrator can change this overtime", "not_permitted");
      if (!OT_SLOTS.includes(v.slot)) return fieldErr("slot", "Pick Before Duty or After Duty");
      const minMin = (await getConfig())["hrms.ot.minMinutes"];
      const s = otSpan(await attendanceDay(r.employeeId, r.date), v.slot);
      if (!s || s.minutes == null || s.minutes <= minMin) return fieldErr("slot", otRefusal(s, v.slot, minMin));
      const after = { slot: v.slot, startTime: s.start, endTime: s.end, minutes: s.minutes, remark: text(v.remark) };
      await db.update(hrmsOvertime).set({ ...after, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsOvertime.id, id));
      await hrmsAudit(ctx, "hrms.overtime.edit", "hrms_overtime", id, { slot: r.slot, minutes: r.minutes, remark: r.remark }, after);
      return okVoid(`${hm(s.minutes)} overtime saved`);
    },
    async delete(ctx, id) {
      if (!ctx.flags.ot) return err("Overtime is switched off in HRMS settings.", "not_permitted");
      const [r] = await db.select().from(hrmsOvertime).where(eq(hrmsOvertime.id, id));
      if (!r) return err("That overtime no longer exists.", "not_found");
      if (!(r.employeeId === ctx.employee?.id || canOtAnyone(ctx))) return err("Only the employee, HR or an HRMS administrator can delete this overtime", "not_permitted");
      await db.delete(hrmsOvertime).where(eq(hrmsOvertime.id, id));
      await hrmsAudit(ctx, "hrms.overtime.delete", "hrms_overtime", id, r, null);
      return okVoid("Overtime deleted");
    },
  },
  forms: {
    async add(ctx, h) {
      if (!ctx.flags.ot) return err("Overtime is switched off", "not_permitted");
      const people = await allPeople();
      let p: Person | undefined;
      if (canOtAnyone(ctx)) p = personFrom(h.emp, people.filter(isActive));
      else if (ctx.employee) {
        p = people.find((x) => x.id === ctx.employee!.id);
        if (text(h.emp) && personFrom(h.emp, people)?.id !== p?.id) return fieldErr("emp", "You can add overtime only for yourself");
      } else return err(NOT_LINKED, "not_permitted");
      if (!p) return fieldErr("emp", "Pick an active employee from the list");
      const date = text(h.date) ?? "";
      if (!ISO.test(date)) return fieldErr("date", "Pick a date");
      if (date > today()) return fieldErr("date", `${fdShort(date)} is in the future`);
      if (!OT_SLOTS.includes(h.slot)) return fieldErr("slot", "Pick Before Duty or After Duty");
      const [dupe] = await db
        .select({ id: hrmsOvertime.id })
        .from(hrmsOvertime)
        .where(and(eq(hrmsOvertime.employeeId, p.id), eq(hrmsOvertime.date, date)));
      if (dupe) return fieldErr("date", `Overtime for ${p.name} on ${fdShort(date)} is already added`);
      const minMin = (await getConfig())["hrms.ot.minMinutes"];
      const s = otSpan(await attendanceDay(p.id, date), h.slot);
      /* Spec §8: the OT must EXCEED the shortest overtime; at or under it is not applicable. */
      if (!s || s.minutes == null || s.minutes <= minMin) return fieldErr("slot", otRefusal(s, h.slot, minMin));
      const id = hrmsId("hot");
      const res = await db
        .insert(hrmsOvertime)
        .values({ id, employeeId: p.id, date, slot: h.slot, startTime: s.start, endTime: s.end, minutes: s.minutes, remark: text(h.remark), createdById: ctx.user.id })
        .onConflictDoNothing()
        .returning({ id: hrmsOvertime.id });
      /* The unique index answers the race two saves of one day would otherwise win together. */
      if (!res.length) return fieldErr("date", `Overtime for ${p.name} on ${fdShort(date)} is already added`);
      await hrmsAudit(ctx, "hrms.overtime.add", "hrms_overtime", id, null, { employee: p.code, date, slot: h.slot, minutes: s.minutes });
      return okVoid(`${hm(s.minutes)} overtime added`);
    },
  },
};

/* -------------------------------------------------------- monthly reports */

const monthlyKey = (employeeId: string, month: string) => `${employeeId}|${month}`;

function readMonthlyKey(id: string): { employeeId: string; month: string } | null {
  const i = id.lastIndexOf("|");
  if (i < 0) return null;
  const month = id.slice(i + 1);
  return MONTH.test(month) ? { employeeId: id.slice(0, i), month } : null;
}

const monthly: HrmsScreenModule = {
  key: "monthly",
  async load(ctx, q) {
    /* A report read on the 3rd is about the month before (spec §9: today − 5). */
    const month = q.month && MONTH.test(q.month) ? q.month : monthOf(addDaysISO(today(), -5));
    const from = `${month}-01`;
    const to = monthEnd(month);
    const people = await allPeople();
    const pb = byId(people);
    const { scope, options } = scopeFor(ctx, q, "hr", "perfAdmin", "payroll");
    const ids = visibleIds(ctx, scope, people);
    const [cfg, all, hol, approved, remarks] = await Promise.all([
      attendanceCfg(),
      attendanceRows({ from, to }),
      holidays(from, to),
      db
        .select({ employeeId: hrmsLeaveRequests.employeeId, startDate: hrmsLeaveRequests.startDate, endDate: hrmsLeaveRequests.endDate })
        .from(hrmsLeaveRequests)
        .where(and(eq(hrmsLeaveRequests.status, "Approved"), lte(hrmsLeaveRequests.startDate, to), gte(hrmsLeaveRequests.endDate, from))),
      db.select().from(hrmsMonthlyRemarks).where(eq(hrmsMonthlyRemarks.month, month)),
    ]);
    /* Office open days are the dates on which ANYBODY attended, whoever the list shows. */
    const openDates = [...new Set(all.map((d) => d.date))].sort();
    const byEmp = new Map<string, typeof all>();
    for (const d of all) push(byEmp, d.employeeId, d);
    const highest = Math.max(0, ...[...byEmp.values()].map((ds) => ds.reduce((a, d) => a + (d.fig.workedMin ?? 0), 0)));
    const remarkOf = new Map(remarks.map((r) => [r.employeeId, r]));
    const n = cfg.lateOverMinutes;
    const editor = has(ctx, "hr");
    const stamp = at(new Date());

    /* Somebody active who did not attend once that month is the report's most
       important row, and it used to leave them out: the list was built from
       attendance alone. They are listed with every open day missing. Only once
       the office has opened that month — an empty month has nothing to say. */
    const everyone = new Map(byEmp);
    if (openDates.length)
      for (const p of people)
        if (isActive(p) && !everyone.has(p.id) && (!p.dateOfJoining || p.dateOfJoining <= to) && (!p.dateOfLeaving || p.dateOfLeaving >= from)) everyone.set(p.id, []);
    const rows: ListRow[] = [];
    for (const [employeeId, ds] of everyone) {
      if (ids && !ids.has(employeeId)) continue;
      const p = pb.get(employeeId);
      const holidayDates = holidayDatesFor(hol, employeeId, p?.office ?? null, month);
      const leaveDates = leaveDatesIn(
        approved.filter((r) => r.employeeId === employeeId),
        month,
      );
      const f = monthlyFigures({
        days: ds.map((d) => ({ date: d.date, checkIn: d.checkIn, officialIn: d.officialIn, targetMin: d.targetMin, fig: d.fig })),
        openDates,
        holidayDates,
        leaveDates,
        lateOverMinutes: n,
      });
      const rm = remarkOf.get(employeeId);
      const a: ActionSpec[] = [
        {
          id: "editRemark",
          l: "Edit remark",
          primary: true,
          why: editor ? undefined : "Only HR can write a report remark",
          prompt: { title: "Remark", sub: `${p?.name ?? ""} · ${monLabel(month)}`, submit: "Save remark", init: { remark: rm?.remark ?? "" }, fields: [{ k: "remark", l: "Remark", t: "area", req: true }] },
        },
      ];
      if (rm) a.push({ id: "deleteRemark", l: "Delete remark", why: has(ctx, "admin") ? undefined : "Only an HRMS administrator can delete a report remark", confirm: "Delete this report’s remark?" });
      const lateTotal = hm(f.lateDurationMin) || "0h 00m";
      rows.push({
        id: monthlyKey(employeeId, month),
        v: {
          month,
          year: month.slice(0, 4),
          monthLbl: monLabel(month),
          emp: p?.name ?? "",
          attended: f.attended,
          open: f.openDays,
          late: f.late,
          lateOver10: f.lateOver,
          onTime: f.onTime,
          ciPct: f.checkInPct ?? "",
          overall: f.overallPct ?? "",
          lateDurTxt: lateTotal,
          half: f.halfDays,
          missingTxt: f.missing.map(fdShort).join(", ") || "—",
          remark: rm?.remark ?? "",
        },
        flags: f.missing.length ? ["missing"] : [],
        title: `${p?.name ?? ""} · ${monLabel(month)}`,
        header: `${f.attended} of ${f.openDays} open days${f.missing.length ? ` · ${plural(f.missing.length, "missing date")}` : ""}`,
        fields: [
          { l: "Employee ID", v: p?.code ?? "" },
          { l: "Office", v: p?.office ?? "" },
          { l: "Leave dates", v: leaveDates.map(fdShort).join(", ") || "—", der: true },
          { l: "Holiday dates", v: holidayDates.map(fdShort).join(", ") || "—", der: true },
          { l: "Missing dates", v: f.missing.map(fdShort).join(", ") || "—", der: true },
          { l: "Full days", v: String(f.fullDays), der: true },
          { l: "Pending check-outs", v: String(f.pendingCheckouts), der: true },
          { l: "Target hours", v: hm(f.targetMin), der: true },
          { l: "Achieved hours", v: hm(f.achievedMin), der: true },
          { l: "Highest achieved hours (anyone)", v: hm(highest), der: true },
          { l: `Late > ${n} min %`, v: f.lateOverPct == null ? "—" : `${f.lateOverPct}%`, der: true },
          { l: "Total late duration", v: lateTotal, der: true },
          { l: "Report generated at", v: stamp, der: true },
        ],
        actions: a,
        by: rm ? `Remark ${at(rm.updatedAt)}` : undefined,
      });
    }
    return {
      spec: {
        screen: "monthly",
        cols: [
          { k: "monthLbl", l: "Month", t: "t" },
          { k: "emp", l: "Employee", t: "b" },
          { k: "attended", l: "Attended", t: "n" },
          { k: "open", l: "Open days", t: "n" },
          { k: "late", l: "Late", t: "n" },
          { k: "lateOver10", l: `Late > ${n} min`, t: "n" },
          { k: "onTime", l: "On time", t: "n" },
          { k: "ciPct", l: "Check-in %", t: "n", u: "%" },
          { k: "overall", l: "Monthly %", t: "n", u: "%" },
          { k: "lateDurTxt", l: "Late total", t: "t" },
          { k: "half", l: "Half days", t: "n" },
          { k: "missingTxt", l: "Missing dates", t: "t" },
          { k: "remark", l: "Remark", t: "t" },
          { k: "f", l: "Flags", t: "f" },
        ],
        hidden: [],
        groups: ["year", "monthLbl"],
        sortDefault: ["emp", 1],
        download: true,
        noDataLine: `Nobody has attendance in ${monLabel(month)}.`,
        hrms: {
          scope: { current: scope, options },
          period: { label: monLabel(month), params: [{ k: "month", l: "Month", v: month, type: "month" }] },
        },
      },
      rows,
    };
  },
  actions: {
    async editRemark(ctx, id, v) {
      if (!has(ctx, "hr")) return err("Only HR can write a report remark", "not_permitted");
      const k = readMonthlyKey(id);
      if (!k) return err("That report no longer exists.", "not_found");
      const remark = text(v.remark);
      if (!remark) return fieldErr("remark", "Write the remark");
      const [before] = await db
        .select()
        .from(hrmsMonthlyRemarks)
        .where(and(eq(hrmsMonthlyRemarks.employeeId, k.employeeId), eq(hrmsMonthlyRemarks.month, k.month)));
      await db
        .insert(hrmsMonthlyRemarks)
        .values({ employeeId: k.employeeId, month: k.month, remark, createdById: ctx.user.id, updatedById: ctx.user.id })
        .onConflictDoUpdate({ target: [hrmsMonthlyRemarks.employeeId, hrmsMonthlyRemarks.month], set: { remark, updatedAt: new Date(), updatedById: ctx.user.id } });
      await hrmsAudit(ctx, "hrms.monthly.remark", "hrms_monthly_remarks", id, before ? { remark: before.remark } : null, { remark });
      return okVoid("Remark saved");
    },
    async deleteRemark(ctx, id) {
      if (!has(ctx, "admin")) return err("Only an HRMS administrator can delete a report remark", "not_permitted");
      const k = readMonthlyKey(id);
      if (!k) return err("That report no longer exists.", "not_found");
      const gone = await db
        .delete(hrmsMonthlyRemarks)
        .where(and(eq(hrmsMonthlyRemarks.employeeId, k.employeeId), eq(hrmsMonthlyRemarks.month, k.month)))
        .returning();
      if (!gone.length) return err("That report has no remark.", "not_found");
      await hrmsAudit(ctx, "hrms.monthly.remarkDelete", "hrms_monthly_remarks", id, gone[0], null);
      return okVoid("Remark deleted");
    },
  },
};

export const LEAVE_SCREENS: HrmsScreenModule[] = [leave, approvals, leaveCal, leaveSetup, holidaysScreen, overtime, monthly];
