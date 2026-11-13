import "server-only";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { employees, hrmsActivities, hrmsKpi, hrmsReviews } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { inr } from "@/lib/erp/ui";
import type { ListRow, RowField } from "@/lib/erp/ui";
import { has, type HrmsContext } from "../access";
import { err, fieldErr, hrmsAudit, hrmsId, okVoid, stampLine, text, today, type HrmsScreenModule, type ScreenQuery } from "../server";
import { allPeople, isActive, isSales, timingMap, visibleIds, type Person } from "../services/people";
import { attendanceRows, holidays, type DayRow } from "../services/attendance";
import { minutesBetween } from "../engines/attendance";
import { holidayApplies } from "../engines/leave";
import {
  dailyScore,
  isEmployeeOfMonth,
  noteLength,
  performancePoints,
  pointKind,
  staffMonth,
  type DailyCfg,
  type PointBands,
  type DailyScore,
  type MonthlyTargets,
  type Points,
  type StaffMonth,
} from "../engines/performance";
import { datesBetween, datesOfMonth, daysBetweenISO, fdShort, monLabel, monthOf, prevMonth, weekdayOf } from "../time";
import { hrmsLink } from "../registry";
import { scopeFor } from "./attendance";

/* ---------------------------------------------------------------------------
 * Performance (spec §12): the monthly staff performance, Employee of the Month
 * and performance points for any period. The salesman's daily KPI entry and
 * its daily score were taken out of the HRMS (Nov 2026); entries already made
 * still count for the periods they cover.
 *
 * Everything is DERIVED on read from attendance and the KPI history, through
 * `engines/performance.ts` — so a corrected KPI or a late check-out moves the
 * score, the month and the points together, and nobody has to add a row per
 * salesman per day the way the source asked them to (the same call A07 made
 * for monthly reports). The review answers are the one other thing stored.
 * ------------------------------------------------------------------------- */

type Kpi = typeof hrmsKpi.$inferSelect;
type Cfg = DailyCfg & { pointBands: PointBands; fyStart: string; pointsFrom: string; periodDivisor: number; standardHours: number; eomPercent: number; staffOffices: string[] };

const NO_TARGETS: MonthlyTargets = { visits: null, km: null, litres: null, hours: null, amountPaise: null };

/* ------------------------------------------------------------------ reads */

async function perfCfg(): Promise<Cfg> {
  const c = await getConfig();
  return {
    timeGivenBase: c["hrms.performance.timeGivenBase"],
    descriptionBase: c["hrms.performance.descriptionBase"],
    outstandingBands: c["hrms.performance.outstandingBands"],
    pointBands: { outstanding: c["hrms.performance.outstandingBands"], ...c["hrms.performance.pointBands"] },
    weights: c["hrms.performance.weights"],
    dailyDivisor: c["hrms.performance.dailyDivisor"],
    gstPercent: c["hrms.performance.gstPercent"],
    fyStart: c["hrms.performance.financialYearStart"],
    /* One financial year start for the score and the points alike. */
    pointsFrom: c["hrms.performance.financialYearStart"],
    periodDivisor: c["hrms.performance.periodDivisor"],
    standardHours: c["hrms.performance.standardHours"],
    eomPercent: c["hrms.performance.employeeOfMonthPercent"],
    staffOffices: c["hrms.performance.staffOffices"],
  };
}

async function targetsOf(ids: string[] | null): Promise<Map<string, MonthlyTargets>> {
  if (ids && !ids.length) return new Map();
  const rows = await db
    .select({
      id: employees.id,
      visits: employees.targetVisits,
      km: employees.targetKm,
      litres: employees.targetLitres,
      hours: employees.targetHours,
      amountPaise: employees.targetAmountPaise,
    })
    .from(employees)
    .where(ids ? inArray(employees.id, ids) : undefined);
  return new Map(rows.map(({ id, ...t }) => [id, t]));
}

async function kpiRows(ids: string[] | null, from?: string, to?: string): Promise<Kpi[]> {
  if (ids && !ids.length) return [];
  const conds = [];
  if (ids) conds.push(inArray(hrmsKpi.employeeId, ids));
  if (from) conds.push(gte(hrmsKpi.date, from));
  if (to) conds.push(lte(hrmsKpi.date, to));
  return db.select().from(hrmsKpi).where(conds.length ? and(...conds) : undefined);
}

async function activityRows(ids: string[] | null, from: string, to: string) {
  if (ids && !ids.length) return [];
  const conds = [gte(hrmsActivities.date, from), lte(hrmsActivities.date, to)];
  if (ids) conds.push(inArray(hrmsActivities.employeeId, ids));
  return db
    .select({ employeeId: hrmsActivities.employeeId, date: hrmsActivities.date, minutes: hrmsActivities.minutes, note: hrmsActivities.note })
    .from(hrmsActivities)
    .where(and(...conds));
}

const key = (emp: string, date: string) => `${emp}|${date}`;

function groupBy<T>(xs: T[], k: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const g = m.get(k(x)) ?? [];
    g.push(x);
    m.set(k(x), g);
  }
  return m;
}

const isoDate = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** An "early" attendance row: the day's remark says early (on time or within the grace), as the source's remark test did. */
const earlyDay = (d: DayRow) => d.fig.lateOrEarlyMin != null && !d.fig.lateBeyondGrace;

/* ------------------------------------------------ the day's derived score */

type ScoreBook = {
  cfg: Cfg;
  targets: Map<string, MonthlyTargets>;
  /** Every KPI row of these employees from the FY start, for total sale. */
  allKpi: Map<string, Kpi[]>;
  att: Map<string, DayRow>;
  acts: Map<string, { minutes: number; note: string | null }[]>;
};

async function scoreBook(ids: string[] | null, from: string, to: string): Promise<ScoreBook> {
  const cfg = await perfCfg();
  const fyFrom = cfg.fyStart < from ? cfg.fyStart : from;
  const [targets, all, att, acts] = await Promise.all([
    targetsOf(ids),
    kpiRows(ids, fyFrom, to),
    attendanceRows({ employeeIds: ids, from, to }),
    activityRows(ids, from, to),
  ]);
  return {
    cfg,
    targets,
    allKpi: groupBy(all, (k) => k.employeeId),
    att: new Map(att.map((a) => [key(a.employeeId, a.date), a])),
    acts: groupBy(acts, (a) => key(a.employeeId, a.date)),
  };
}

/** Punch in / out and on-field time (out − in − unplanned stop) for a KPI row, from that day's attendance. */
function punchOf(k: Kpi, att: DayRow | undefined) {
  const onField = att?.checkOut ? (minutesBetween(att.checkIn, att.checkOut) ?? 0) - (k.stoppageMin || 0) : null;
  return { in: att?.checkIn ?? "", out: att?.checkOut ?? "", onField };
}

/** Time with customers that day: the logged activities, or the KPI's own figure where none were logged. */
function dayTime(k: Kpi, acts: { minutes: number }[] | undefined): number {
  return acts?.length ? acts.reduce((a, x) => a + x.minutes, 0) : k.timeGivenMin;
}

/** That day's meeting notes: the KPI's own and every activity's. */
function dayNotes(k: Kpi, acts: { note: string | null }[] | undefined): string[] {
  return [k.notes, ...(acts ?? []).map((a) => a.note)].filter((n): n is string => !!n && !!n.trim());
}

function scoreOf(k: Kpi, b: ScoreBook): DailyScore {
  const kk = key(k.employeeId, k.date);
  const acts = b.acts.get(kk);
  const fySales = (b.allKpi.get(k.employeeId) ?? []).filter((x) => x.date >= b.cfg.fyStart && x.date <= k.date).reduce((a, x) => a + x.amountPaise, 0);
  return dailyScore(
    {
      targets: b.targets.get(k.employeeId) ?? NO_TARGETS,
      visits: k.visits,
      timeGivenMin: dayTime(k, acts),
      noteChars: dayNotes(k, acts).reduce((a, n) => a + noteLength(n), 0),
      onFieldMin: Math.max(0, punchOf(k, b.att.get(kk)).onField ?? 0),
      km: Number(k.km),
      amountPaise: k.amountPaise,
      litres: Number(k.litres),
      outstandingPaise: k.outstandingPaise,
      fySalesPaise: fySales,
      daysSinceFy: Math.max(0, daysBetweenISO(b.cfg.fyStart, k.date)),
      /* To-dos were taken out of the HRMS; the staff month reads only the field-work parts. */
      todos: { total: 0, verified: 0 },
    },
    b.cfg,
  );
}

function periodOf(q: ScreenQuery, defFrom: string, defTo: string): { from: string; to: string } {
  const from = isoDate(q.from) ?? defFrom;
  const to = isoDate(q.to) ?? defTo;
  return { from, to: to < from ? from : to };
}

/* -------------------------------------- daily sales entries (the KPI) */


/* ------------------------------------------------------- Staff performance */

type StaffRow = { employee: Person; month: string; m: StaffMonth; sales: boolean; hasKpi: boolean };

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * Monthly staff performance for active employees of the offices the setting
 * names (A25), for the six months up to `?month=`. A month appears for an
 * employee who attended in it — the same base the monthly report uses.
 */
async function staffRows(ctx: HrmsContext, q: ScreenQuery) {
  const t = today();
  const cfg = await perfCfg();
  const people = await allPeople();
  const sc = scopeFor(ctx, q, "perfAdmin", "hr");
  const ids = visibleIds(ctx, sc.scope);
  const offices = new Set(cfg.staffOffices.map((o) => o.trim().toLowerCase()));
  const staff = people.filter((p) => isActive(p) && offices.has((p.office ?? "").trim().toLowerCase()) && (!ids || ids.has(p.id)));
  const toMonth = q.month && /^\d{4}-\d{2}$/.test(q.month) ? q.month : monthOf(t);
  let fromMonth = toMonth;
  for (let i = 0; i < 5; i++) fromMonth = prevMonth(fromMonth);
  const from = `${fromMonth}-01`;
  const to = datesOfMonth(toMonth).at(-1)!;
  const idList = staff.map((p) => p.id);
  const [att, hol, timings, book, kpis] = await Promise.all([
    attendanceRows({ employeeIds: idList, from, to }),
    holidays(from, to),
    timingMap(),
    scoreBook(idList, from, to),
    kpiRows(idList, from, to),
  ]);
  const attBy = groupBy(att, (a) => key(a.employeeId, monthOf(a.date)));
  const kpBy = groupBy(kpis, (c) => key(c.employeeId, monthOf(c.date)));
  const rows: StaffRow[] = [];
  for (let m = fromMonth; m <= toMonth; m = nextMonth(m)) {
    /* The current month is scored up to today: tomorrow's hours are not missing yet. */
    const dates = datesOfMonth(m).filter((d) => d <= t);
    for (const p of staff) {
      const k = key(p.id, m);
      const days = attBy.get(k) ?? [];
      if (!days.length) continue;
      const sales = isSales(p);
      /* A22: the month's working dates less the employee's holidays, each worth that weekday's target duration. */
      const targetMinutes = dates
        .filter((d) => !hol.some((h) => h.date === d && holidayApplies(h, p.id, p.office)))
        .map((d) => {
          const tm = timings.get(`${p.id}|${weekdayOf(d)}`);
          return tm ? (minutesBetween(tm.inTime, tm.outTime) ?? 0) : 0;
        });
      const kpiParts = sales
        ? (kpBy.get(k) ?? []).map((row) => {
            const s = scoreOf(row, book);
            const g = (x: string) => s.parts.find((pp) => pp.k === x)!.got;
            return { visits: g("visits"), timeCust: g("timeCust"), noteLen: g("noteLen"), km: g("km") };
          })
        : [];
      const mm = staffMonth({
        sales,
        days: days.map((d) => ({ durationMin: d.fig.durationMin, early: earlyDay(d) })),
        targetMinutes,
        /* Checklists, to-dos and buddy tasks were taken out of the HRMS and no longer count. */
        checklist: [],
        kpiParts,
        todos: [],
        buddy: [],
      });
      rows.push({ employee: p, month: m, m: mm, sales, hasKpi: kpiParts.length > 0 });
    }
  }
  return { rows, scope: sc, fromMonth, toMonth, cfg };
}

function staffRowOut(r: StaffRow): ListRow {
  const p = r.employee;
  const pctTxt = (n: number | null) => (n == null ? "—" : `${n}%`);
  return {
    id: `${p.id}|${r.month}`,
    v: {
      month: r.month,
      monthLbl: monLabel(r.month),
      emp: p.name,
      office: p.office ?? "",
      position: p.position ?? "",
      workHrPct: r.m.workingHoursPct,
      punctual: r.m.punctualityPct,
      overall: r.m.overallPct,
    },
    flags: [],
    title: `${p.name} · ${monLabel(r.month)}`,
    header: `Overall ${r.m.overallPct}%`,
    fields: [
      { l: "Position type", v: p.positionType ?? "" },
      { l: "Working hours against target", v: pctTxt(r.m.workingHoursPct), der: true },
      { l: "Days on time", v: pctTxt(r.m.punctualityPct), der: true },
      ...(r.sales && r.hasKpi ? [{ l: "Field work score (visits, time, notes, km)", v: pctTxt(r.m.dailyTaskPct), der: true }] : []),
      { l: "Overall performance", v: pctTxt(r.m.overallPct), der: true },
    ],
    actions: [{ id: "att", l: "Open attendance", href: hrmsLink("attendance", { from: `${r.month}-01` }) }],
  };
}

const staffPerf: HrmsScreenModule = {
  key: "staffPerf",
  async load(ctx, q) {
    const { rows, scope, fromMonth, toMonth, cfg } = await staffRows(ctx, q);
    return {
      spec: {
        screen: "staffPerf",
        cols: [
          { k: "monthLbl", l: "Month", t: "t" },
          { k: "emp", l: "Employee", t: "b" },
          { k: "workHrPct", l: "Working hours", t: "n", u: "%" },
          { k: "punctual", l: "On time", t: "n", u: "%" },
          { k: "overall", l: "Overall", t: "n", u: "%" },
          { k: "f", l: "", t: "f" },
        ],
        hidden: [],
        groups: ["monthLbl"],
        sortDefault: ["month", -1],
        godownKey: "office",
        readOnly: true,
        noDataLine: `No attendance for employees of ${cfg.staffOffices.join(", ")} in these months.`,
        hrms: {
          scope: { current: scope.scope, options: scope.options },
          period: { label: `${monLabel(fromMonth)} – ${monLabel(toMonth)}`, params: [{ k: "month", l: "Up to", v: toMonth, type: "month" }] },
          ...(ctx.screens.has("eom") ? { notice: { text: `Employee of the month: everyone at ${cfg.eomPercent}% or above`, href: hrmsLink("eom") } } : {}),
        },
      },
      rows: rows.map((r) => staffRowOut(r)),
    };
  },
};

const eom: HrmsScreenModule = {
  key: "eom",
  async load(ctx, q) {
    const { rows, scope, fromMonth, toMonth, cfg } = await staffRows(ctx, q);
    return {
      spec: {
        screen: "eom",
        cols: [
          { k: "monthLbl", l: "Month", t: "t" },
          { k: "emp", l: "Employee", t: "b" },
          { k: "office", l: "Office", t: "t" },
          { k: "position", l: "Position", t: "t" },
          { k: "punctual", l: "On time", t: "n", u: "%" },
          { k: "overall", l: "Overall", t: "n", u: "%" },
        ],
        hidden: [],
        groups: ["monthLbl"],
        sortDefault: ["month", -1],
        godownKey: "office",
        readOnly: true,
        noDataLine: `Nobody reached ${cfg.eomPercent}% overall in these months.`,
        hrms: {
          scope: { current: scope.scope, options: scope.options },
          period: { label: `${monLabel(fromMonth)} – ${monLabel(toMonth)} · at ${cfg.eomPercent}% or above`, params: [{ k: "month", l: "Up to", v: toMonth, type: "month" }] },
        },
      },
      rows: rows.filter((r) => isEmployeeOfMonth(r.m.overallPct, cfg.eomPercent)).map((r) => staffRowOut(r)),
    };
  },
};

/* ----------------------------------------------------- Performance points */

export type PointsRow = {
  employee: Person;
  from: string;
  to: string;
  points: Points;
  review: typeof hrmsReviews.$inferSelect | null;
};

/** Counts and points for these employees over a period (spec §12.4) — the screen and the PDF report read the same answer. */
export async function pointsFor(people: Person[], from: string, to: string): Promise<{ rows: PointsRow[]; financialDate: string }> {
  const cfg = await perfCfg();
  const ids = people.map((p) => p.id);
  if (!ids.length) return { rows: [], financialDate: cfg.pointsFrom };
  const [att, hol, kpis, acts, reviews, targets] = await Promise.all([
    attendanceRows({ employeeIds: ids, from, to }),
    holidays(from, to),
    kpiRows(ids, undefined, to),
    activityRows(ids, from, to),
    db
      .select()
      .from(hrmsReviews)
      .where(and(inArray(hrmsReviews.employeeId, ids), eq(hrmsReviews.fromDate, from), eq(hrmsReviews.toDate, to))),
    targetsOf(ids),
  ]);
  const periodDays = datesBetween(from, to).length;
  const attBy = groupBy(att, (a) => a.employeeId);
  const kpBy = groupBy(kpis, (a) => a.employeeId);
  const acBy = groupBy(acts, (a) => a.employeeId);
  const rvBy = new Map(reviews.map((r) => [r.employeeId, r]));
  const rows = people.map((p) => {
    const days = attBy.get(p.id) ?? [];
    const allK = kpBy.get(p.id) ?? [];
    const inK = allK.filter((k) => k.date >= from);
    const latest = [...allK].sort((a, b) => b.date.localeCompare(a.date))[0];
    const ac = acBy.get(p.id) ?? [];
    /* Time with customers per day: activities, or the KPI's own figure on a day none were logged — the daily score's reading. */
    const dayMinutes = new Map<string, number>();
    for (const [d, list] of groupBy(ac, (a) => a.date)) dayMinutes.set(d, list.reduce((a, x) => a + x.minutes, 0));
    for (const k of inK) if (!dayMinutes.has(k.date) && k.timeGivenMin > 0) dayMinutes.set(k.date, k.timeGivenMin);
    const points = performancePoints(
      {
        kind: pointKind(p.positionType),
        periodDays,
        attendanceRows: days.length,
        earlyRows: days.filter(earlyDay).length,
        taggedHolidays: hol.filter((h) => holidayApplies(h, p.id, p.office)).length,
        durationMin: days.reduce((a, d) => a + (d.fig.durationMin ?? 0), 0),
        /* Checklists and to-dos were taken out of the HRMS and no longer count. */
        checklistTotal: 0,
        checklistCleared: 0,
        todosTotal: 0,
        todosDone: 0,
        naReasons: [],
        targets: targets.get(p.id) ?? NO_TARGETS,
        salesPaise: inK.reduce((a, k) => a + k.amountPaise, 0),
        litres: inK.reduce((a, k) => a + Number(k.litres), 0),
        latestOutstandingPaise: latest?.outstandingPaise ?? 0,
        salesSinceFinancialPaise: allK.filter((k) => k.date >= cfg.pointsFrom).reduce((a, k) => a + k.amountPaise, 0),
        daysSinceFinancial: Math.max(0, daysBetweenISO(cfg.pointsFrom, to)),
        activityMinutes: [...dayMinutes.values()].reduce((a, b) => a + b, 0),
        activityDates: dayMinutes.size,
        noteChars: [...ac.map((a) => a.note), ...inK.map((k) => k.notes)].reduce((a, n) => a + noteLength(n), 0),
        kpiVisits: inK.reduce((a, k) => a + k.visits, 0),
        kpiDays: inK.length,
      },
      { standardHours: cfg.standardHours, periodDivisor: cfg.periodDivisor, bands: cfg.pointBands },
    );
    return { employee: p, from, to, points, review: rvBy.get(p.id) ?? null };
  });
  return { rows, financialDate: cfg.pointsFrom };
}

/** Every count, point and the total, in the source's form order — the drawer and the PDF print the same list. */
export function pointLines(r: PointsRow, financialDate: string): { l: string; v: string }[] {
  const x = r.points;
  const n = (v: number | null, dp = 2) => (v == null ? "" : String(Math.round(v * 10 ** dp) / 10 ** dp));
  const lines: { l: string; v: string }[] = [
    { l: "From date", v: fdShort(r.from) },
    { l: "To date", v: fdShort(r.to) },
    { l: "Employee", v: r.employee.name },
    { l: "Employee position", v: r.employee.positionType ?? "" },
    { l: "Attendance count", v: String(x.attendanceCount) },
    { l: "Attendance point", v: n(x.attendancePoint) },
    { l: "Punctuality count", v: String(x.punctualityCount) },
    { l: "Punctuality point", v: n(x.punctualityPoint) },
    { l: "Average working hours", v: n(x.avgHours) },
    { l: "Working hour point", v: n(x.workingHourPoint) },
  ];
  if (x.salesPaise != null)
    lines.push(
      { l: "Sales amount", v: inr(x.salesPaise) },
      { l: "Sales amount points", v: n(x.salesPoint) },
      { l: "Litre sales", v: n(x.litres) },
      { l: "Litre sales points", v: n(x.litrePoint) },
      { l: "Outstanding (average payment days)", v: x.outstandingCount == null ? "Money owed with no sale since the financial date" : n(x.outstandingCount) },
      { l: "Financial date", v: fdShort(financialDate) },
      { l: "Outstanding point", v: n(x.outstandingPoint) },
      { l: "Time with customer (min a day)", v: n(x.timeGiven) },
      { l: "Time point", v: n(x.timePoint) },
      { l: "Note length (characters a visit)", v: n(x.noteLength) },
      { l: "Note length point", v: n(x.descriptionPoint) },
    );
  lines.push({ l: "Total", v: `${n(x.total, 3)} (${Math.round(x.total * 1000) / 10}%)` });
  return lines;
}

export const REVIEW_QUESTIONS = [
  { k: "issues", l: "Problems faced in the last period" },
  { k: "ideas", l: "Opportunities and new ideas for this period" },
  { k: "nextPlan", l: "Plan until the next meeting" },
  { k: "actionForSir", l: "What you need from management" },
] as const;

const pointsWide = (ctx: HrmsContext) => has(ctx, "perfAdmin") || has(ctx, "hr") || ctx.administrator;

/** "empId|from|to" → its parts, or null. */
function pointsId(id: string): { emp: string; from: string; to: string } | null {
  const [emp, from, to] = id.split("|");
  return emp && isoDate(from) && isoDate(to) && from <= to ? { emp, from, to } : null;
}

/** Whether this person may see one employee's points: the screen's scope, widened by the performance powers. */
export function canSeePoints(ctx: HrmsContext, people: Person[], employeeId: string): boolean {
  if (pointsWide(ctx)) return true;
  const { scope } = scopeFor(ctx, {}, "perfAdmin", "hr");
  const ids = visibleIds(ctx, scope);
  return !ids || ids.has(employeeId);
}

const reportHref = (emp: string, from: string, to: string) => `/api/hrms/performance-report?${new URLSearchParams({ emp, from, to }).toString()}`;

async function reviewGate(ctx: HrmsContext, id: string) {
  const pid = pointsId(id);
  if (!pid) return { refusal: err("That review period is not valid: it needs a from date on or before its to date.", "not_found") };
  const people = await allPeople();
  if (!people.some((p) => p.id === pid.emp) || !canSeePoints(ctx, people, pid.emp)) return { refusal: err("You cannot see this person’s performance.", "not_permitted") };
  return { pid };
}

const points: HrmsScreenModule = {
  key: "points",
  async load(ctx, q) {
    const t = today();
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "perfAdmin", "hr");
    const ids = visibleIds(ctx, scope);
    const { from, to } = periodOf(q, `${monthOf(t)}-01`, t);
    const staff = people.filter((p) => isActive(p) && !p.dateOfLeaving && (!ids || ids.has(p.id)));
    const { rows, financialDate } = await pointsFor(staff, from, to);
    return {
      spec: {
        screen: "points",
        cols: [
          { k: "emp", l: "Employee", t: "b" },
          { k: "position", l: "Position", t: "t" },
          { k: "attendance", l: "Attendance", t: "n" },
          { k: "punctual", l: "On time", t: "n" },
          { k: "hours", l: "Hours", t: "t" },
          { k: "sales", l: "Sales", t: "m" },
          { k: "litres", l: "Litres", t: "n" },
          { k: "total", l: "Points", t: "n", u: "%" },
          { k: "f", l: "", t: "f" },
        ],
        hidden: [],
        groups: ["position"],
        sortDefault: ["total", -1],
        godownKey: "office",
        noDataLine: "No active employees in this scope.",
        hrms: {
          scope: { current: scope, options },
          period: { label: `${fdShort(from)} – ${fdShort(to)}`, params: [{ k: "from", l: "From", v: from, type: "date" }, { k: "to", l: "To", v: to, type: "date" }] },
        },
      },
      rows: rows.map((r) => {
        const x = r.points;
        const p = r.employee;
        const rv = r.review;
        const done = !!rv && REVIEW_QUESTIONS.some((qq) => text(rv[qq.k] ?? "") != null);
        const totalPct = Math.round(x.total * 1000) / 10;
        const fields: RowField[] = pointLines(r, financialDate).map((l) => ({ ...l, der: true }));
        for (const qq of REVIEW_QUESTIONS) fields.push({ l: qq.l, v: rv?.[qq.k] ?? "" });
        const version = Number(rv?.pdfCode) || 1;
        fields.push({ l: "Office", v: p.office ?? "" }, { l: "Report version", v: String(version) });
        return {
          id: `${p.id}|${from}|${to}`,
          v: {
            emp: p.name,
            position: p.positionType ?? "",
            office: p.office ?? "",
            attendance: x.attendanceCount,
            punctual: x.punctualityCount,
            hours: `${Math.round(x.avgHours * 10) / 10}h average`,
            sales: x.salesPaise,
            litres: x.litres,
            total: totalPct,
          },
          flags: done ? ["done"] : [],
          title: `${p.name} · ${fdShort(from)} – ${fdShort(to)}`,
          header: `${p.positionType ?? ""} · ${totalPct}%`,
          fields,
          actions: [
            {
              id: "review",
              l: "Fill in review",
              primary: true,
              prompt: {
                title: "Performance review",
                sub: `${p.name} · ${fdShort(from)} – ${fdShort(to)}`,
                submit: "Save review",
                init: Object.fromEntries(REVIEW_QUESTIONS.map((qq) => [qq.k, rv?.[qq.k] ?? ""])),
                fields: REVIEW_QUESTIONS.map((qq) => ({ k: qq.k, l: qq.l, t: "area" as const, req: qq.k !== "actionForSir", mic: true })),
              },
            },
            { id: "pdf", l: "Open PDF report", href: reportHref(p.id, from, to) },
            {
              id: "regenerate",
              l: "Mark report revised",
              confirm: `Mark ${p.name}’s report as revised? The PDF is always drawn from the latest attendance and sales; this only moves its version number from ${version} to ${version + 1}.`,
            },
          ],
          by: rv ? stampLine(null, rv.updatedAt) : undefined,
        };
      }),
    };
  },
  actions: {
    async review(ctx, id, v) {
      const g = await reviewGate(ctx, id);
      if (!g.pid) return g.refusal;
      const { pid } = g;
      for (const qq of REVIEW_QUESTIONS) if (qq.k !== "actionForSir" && !text(v[qq.k])) return fieldErr(qq.k, `${qq.l} is required`);
      const values = { issues: text(v.issues), ideas: text(v.ideas), nextPlan: text(v.nextPlan), actionForSir: text(v.actionForSir) };
      const [row] = await db
        .insert(hrmsReviews)
        .values({ id: hrmsId("hrev"), employeeId: pid.emp, fromDate: pid.from, toDate: pid.to, ...values, pdfCode: "1", createdById: ctx.user.id, updatedById: ctx.user.id })
        .onConflictDoUpdate({
          target: [hrmsReviews.employeeId, hrmsReviews.fromDate, hrmsReviews.toDate],
          set: { ...values, updatedAt: new Date(), updatedById: ctx.user.id },
        })
        .returning({ id: hrmsReviews.id });
      await hrmsAudit(ctx, "hrms.points.review", "hrms_reviews", row?.id ?? null, null, { employee: pid.emp, from: pid.from, to: pid.to, ...values });
      return okVoid("Review saved · the PDF report includes it");
    },
    async regenerate(ctx, id) {
      const g = await reviewGate(ctx, id);
      if (!g.pid) return g.refusal;
      const { pid } = g;
      /* The report is drawn on request from live figures, so there is nothing
         to rebuild; the code is the version the source's PDF job keyed on,
         and a new one records that somebody asked for it to be redone. */
      const [prev] = await db
        .select({ pdfCode: hrmsReviews.pdfCode })
        .from(hrmsReviews)
        .where(and(eq(hrmsReviews.employeeId, pid.emp), eq(hrmsReviews.fromDate, pid.from), eq(hrmsReviews.toDate, pid.to)));
      const code = String((Number(prev?.pdfCode) || 1) + 1);
      const [row] = await db
        .insert(hrmsReviews)
        .values({ id: hrmsId("hrev"), employeeId: pid.emp, fromDate: pid.from, toDate: pid.to, pdfCode: code, createdById: ctx.user.id, updatedById: ctx.user.id })
        .onConflictDoUpdate({ target: [hrmsReviews.employeeId, hrmsReviews.fromDate, hrmsReviews.toDate], set: { pdfCode: code, updatedAt: new Date(), updatedById: ctx.user.id } })
        .returning({ id: hrmsReviews.id });
      await hrmsAudit(ctx, "hrms.points.regenerate", "hrms_reviews", row?.id ?? null, { pdfCode: prev?.pdfCode ?? null }, { pdfCode: code });
      return okVoid(`Report marked as revised · now version ${code}`);
    },
  },
};

export const PERF_SCREENS: HrmsScreenModule[] = [staffPerf, eom, points];
