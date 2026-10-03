import "server-only";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { employees, hrmsActivities, hrmsBuddyTasks, hrmsChecklist, hrmsKpi, hrmsReviews, hrmsTodos, mbosVisits, users } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { APP_TIMEZONE } from "@/lib/business-date";
import { inr } from "@/lib/erp/ui";
import type { ActionSpec, ColSpec, FieldSpec, FormSpec, ListRow, RowField } from "@/lib/erp/ui";
import { has, type HrmsContext } from "../access";
import { err, fieldErr, hrmsAudit, hrmsId, int, num, okVoid, paise, rupeesField, stampLine, text, today, type HrmsScreenModule, type ScreenQuery } from "../server";
import { allPeople, byId, isActive, isSales, refList, timingMap, visibleIds, type Person } from "../services/people";
import { attendanceRows, holidays, type DayRow } from "../services/attendance";
import { minutesBetween, timeRemark } from "../engines/attendance";
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
import { addDaysISO, datesBetween, datesOfMonth, daysBetweenISO, fdShort, hm, monLabel, monthOf, prevMonth, weekdayOf } from "../time";
import { hrmsLink } from "../registry";
import { personFrom, personOption, scopeFor } from "./attendance";
import { BUDDY_DONE, CHECKLIST_NA } from "../values";

/* ---------------------------------------------------------------------------
 * Performance (spec §12): the salesman's daily KPI entry, the daily score it
 * earns, the monthly staff performance, Employee of the Month and
 * performance points for any period.
 *
 * Only the KPI is typed. Everything else is DERIVED on read from the KPI,
 * attendance, activities, the checklist, to-dos and buddy tasks, through
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
    pointsFrom: c["hrms.performance.pointsFinancialDate"],
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

async function todoRows(ids: string[] | null, from: string, to: string) {
  if (ids && !ids.length) return [];
  const conds = [gte(hrmsTodos.forDate, from), lte(hrmsTodos.forDate, to)];
  if (ids) conds.push(inArray(hrmsTodos.toEmployeeId, ids));
  return db
    .select({
      employeeId: hrmsTodos.toEmployeeId,
      forDate: hrmsTodos.forDate,
      tillDate: hrmsTodos.tillDate,
      status: hrmsTodos.status,
      recheck: hrmsTodos.recheck,
      doneOn: hrmsTodos.doneOn,
    })
    .from(hrmsTodos)
    .where(and(...conds));
}

async function checklistRows(ids: string[] | null, from: string, to: string) {
  if (ids && !ids.length) return [];
  const conds = [gte(hrmsChecklist.date, from), lte(hrmsChecklist.date, to)];
  if (ids) conds.push(inArray(hrmsChecklist.employeeId, ids));
  return db
    .select({ employeeId: hrmsChecklist.employeeId, date: hrmsChecklist.date, status: hrmsChecklist.status, naReason: hrmsChecklist.naReason })
    .from(hrmsChecklist)
    .where(and(...conds));
}

async function buddyRows(ids: string[] | null, from: string, to: string) {
  if (ids && !ids.length) return [];
  const conds = [gte(hrmsBuddyTasks.date, from), lte(hrmsBuddyTasks.date, to)];
  if (ids) conds.push(inArray(hrmsBuddyTasks.toEmployeeId, ids));
  return db.select({ employeeId: hrmsBuddyTasks.toEmployeeId, date: hrmsBuddyTasks.date, status: hrmsBuddyTasks.status }).from(hrmsBuddyTasks).where(and(...conds));
}

/** MBOS check-ins a person's account made on a date, or null when no account is linked to the employee. */
async function mbosVisitCount(employeeId: string, date: string): Promise<number | null> {
  const accounts = await db.select({ id: users.id }).from(users).where(eq(users.employeeId, employeeId));
  if (!accounts.length) return null;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mbosVisits)
    .where(
      and(
        inArray(
          mbosVisits.salesmanId,
          accounts.map((a) => a.id),
        ),
        sql`(${mbosVisits.checkInAt} at time zone ${APP_TIMEZONE})::date = ${date}::date`,
      ),
    );
  return Number(r?.n ?? 0);
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
  todos: Map<string, { recheck: string }[]>;
};

async function scoreBook(ids: string[] | null, from: string, to: string): Promise<ScoreBook> {
  const cfg = await perfCfg();
  const fyFrom = cfg.fyStart < from ? cfg.fyStart : from;
  const [targets, all, att, acts, todos] = await Promise.all([
    targetsOf(ids),
    kpiRows(ids, fyFrom, to),
    attendanceRows({ employeeIds: ids, from, to }),
    activityRows(ids, from, to),
    todoRows(ids, from, to),
  ]);
  return {
    cfg,
    targets,
    allKpi: groupBy(all, (k) => k.employeeId),
    att: new Map(att.map((a) => [key(a.employeeId, a.date), a])),
    acts: groupBy(acts, (a) => key(a.employeeId, a.date)),
    todos: groupBy(todos, (t) => key(t.employeeId, t.forDate)),
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
  const todos = b.todos.get(kk) ?? [];
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
      todos: { total: todos.length, verified: todos.filter((t) => t.recheck === "Verified").length },
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

const KPI_COLS: ColSpec[] = [
  { k: "date", l: "Date", t: "d" },
  { k: "emp", l: "Salesman", t: "b" },
  { k: "area", l: "Area", t: "t" },
  { k: "visits", l: "Visits", t: "n" },
  { k: "productive", l: "Productive", t: "n" },
  { k: "litres", l: "Litres", t: "n" },
  { k: "km", l: "Km", t: "n" },
  { k: "amount", l: "Sales", t: "m" },
  { k: "outstanding", l: "Outstanding", t: "m" },
  { k: "punchIn", l: "Check-in", t: "t" },
  { k: "punchOut", l: "Check-out", t: "t" },
  { k: "onFieldTxt", l: "On field", t: "t" },
  { k: "f", l: "", t: "f" },
];

/** Active Sales employees with no date of leaving (spec §12.1). */
const salesmen = (people: Person[]) => people.filter((p) => isActive(p) && isSales(p) && !p.dateOfLeaving);

const kpiWide = (ctx: HrmsContext) => has(ctx, "salesAll") || has(ctx, "hr") || ctx.administrator;

/** Whom this person may enter a KPI for: anyone with the sales desk or HR, else only themself. */
function kpiPickable(ctx: HrmsContext, people: Person[]): Person[] {
  const all = salesmen(people);
  return kpiWide(ctx) ? all : all.filter((p) => p.id === ctx.employee?.id);
}

const canTouchKpi = (ctx: HrmsContext, k: Kpi) => kpiWide(ctx) || k.employeeId === ctx.employee?.id;
const KPI_WHY = "Only the salesman, the sales desk or HR can change this sales entry";

async function kpiForm(ctx: HrmsContext, people: Person[], rec?: Kpi): Promise<FormSpec | undefined> {
  const pick = kpiPickable(ctx, people);
  if (!pick.length && !rec) return undefined;
  const areas = await refList("Areas");
  const pb = byId(people);
  const who = rec ? pb.get(rec.employeeId) : pick.find((p) => p.id === ctx.employee?.id);
  const date = rec?.date ?? today();
  /* Pre-filled only for the person and day the form opens on: a count per
     option would be a query per salesman for a form most people open for
     themselves. The save re-reads it for whoever was actually chosen. */
  const mbos = !rec && who ? await mbosVisitCount(who.id, date) : null;
  const att = who ? (await attendanceRows({ employeeIds: [who.id], from: date, to: date }))[0] : undefined;
  const header: FieldSpec[] = [
    { k: "date", l: "Date", t: "date", req: true, readOnly: !!rec },
    rec
      ? { k: "emp", l: "Salesman", t: "text", readOnly: true }
      : { k: "emp", l: "Salesman", t: "select", req: true, opts: pick.map(personOption), hint: kpiWide(ctx) ? "Active sales staff." : undefined },
    areas.length ? { k: "area", l: "Area visited", t: "suggest", req: true, opts: areas } : { k: "area", l: "Area visited", t: "text", req: true },
    { k: "visits", l: "Visits", t: "num", req: true, min: 0, hint: mbos ? `Filled in from ${mbos} field-app check-in${mbos > 1 ? "s" : ""} today` : undefined },
    { k: "productive", l: "Productive counters", t: "num", req: true, min: 0 },
    { k: "litres", l: "Litre sales", t: "num", req: true, min: 0 },
    { k: "km", l: "Km", t: "num", req: true, min: 0 },
    { k: "amount", l: "Amount of sales (₹)", t: "num", req: true, min: 0 },
    { k: "outstanding", l: "Outstanding (₹)", t: "num", min: 0 },
    { k: "stoppage", l: "Unplanned stop (min)", t: "num", min: 0 },
    { k: "punch", l: "Check-in and check-out", t: "text", readOnly: true, hint: "From that day’s attendance." },
    { k: "notes", l: "Meeting notes", t: "area", mic: true },
  ];
  const init: Record<string, string> = rec
    ? {
        date: rec.date,
        emp: who ? personOption(who) : "",
        area: rec.area ?? "",
        visits: String(rec.visits),
        productive: String(rec.productive),
        litres: String(rec.litres),
        km: String(rec.km),
        amount: rupeesField(rec.amountPaise),
        outstanding: rupeesField(rec.outstandingPaise),
        stoppage: String(rec.stoppageMin),
        notes: rec.notes ?? "",
      }
    : { date, emp: who ? personOption(who) : "", area: who?.area ?? "", ...(mbos ? { visits: String(mbos) } : {}), stoppage: "0" };
  init.punch = att ? `${att.checkIn} – ${att.checkOut ?? "not checked out yet"}` : "No attendance marked that day";
  return {
    screen: "kpi",
    id: "kpi",
    title: rec ? "Edit sales entry" : "Enter today’s sales",
    sub: "Visits are filled in from the salesman’s field-app check-ins where there are any; check-in and check-out times come from attendance. Correct anything that is wrong.",
    submit: "Save entry",
    header,
    init,
    recordId: rec?.id,
  };
}

function kpiRow(ctx: HrmsContext, k: Kpi, p: Person | undefined, att: DayRow | undefined, acts: { minutes: number; note: string | null }[] | undefined): ListRow {
  const punch = punchOf(k, att);
  const name = p?.name ?? "";
  const pre = Object.entries(k.prefill ?? {});
  const flags: string[] = [];
  if (pre.length) flags.push("preFilled");
  /* A01 / §23 rules 39–40: red when late, green when early — the attendance day's own verdict. */
  if (att?.fig.lateBeyondGrace) flags.push("late");
  else if (att && earlyDay(att)) flags.push("early");
  const notes = dayNotes(k, acts);
  const fields: RowField[] = [
    { l: "Productive counters", v: String(k.productive) },
    { l: "Unplanned stop (min)", v: String(k.stoppageMin) },
    { l: "On-field time", v: punch.onField == null ? (att ? "Not checked out" : "No attendance marked that day") : hm(punch.onField), der: true },
    { l: "Time remark", v: att ? timeRemark(att.fig, name, att.method) : "", der: true },
    { l: "Time with customers (min)", v: String(dayTime(k, acts)), der: !!acts?.length },
    { l: "Meeting-note length (characters)", v: String(notes.reduce((a, n) => a + noteLength(n), 0)), der: true },
    { l: "Meeting notes", v: notes.join(" · ") },
    { l: "Pre-filled from", v: pre.length ? pre.map(([f, s]) => `${f}: ${s}`).join(" · ") : "Typed by hand" },
  ];
  const why = canTouchKpi(ctx, k) ? undefined : KPI_WHY;
  const actions: ActionSpec[] = [
    { id: "edit", l: "Edit", loadsForm: true, why },
    { id: "score", l: "Open score", href: hrmsLink("salesPerf", { who: k.employeeId, from: k.date }) },
    { id: "delete", l: "Delete", why, confirm: `Delete ${name}’s sales entry for ${fdShort(k.date)}? The day’s score is deleted with it.` },
  ];
  return {
    id: k.id,
    v: {
      date: k.date,
      emp: name,
      office: p?.office ?? "",
      area: k.area ?? "",
      visits: k.visits,
      productive: k.productive,
      litres: Number(k.litres),
      km: Number(k.km),
      amount: k.amountPaise,
      outstanding: k.outstandingPaise,
      punchIn: punch.in,
      punchOut: punch.out,
      onFieldTxt: punch.onField == null ? "" : hm(punch.onField),
    },
    flags,
    title: `${name} · ${fdShort(k.date)}`,
    header: `${k.area ?? ""} · ${k.visits} visits · ${inr(k.amountPaise)}`,
    fields,
    actions,
    by: stampLine(null, k.createdAt),
  };
}

const kpi: HrmsScreenModule = {
  key: "kpi",
  async load(ctx, q) {
    const t = today();
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "salesAll", "hr", "perfAdmin");
    const ids = visibleIds(ctx, scope, people);
    const idList = ids ? [...ids] : null;
    const { from, to } = periodOf(q, addDaysISO(t, -30), t);
    const [rows, att, acts, form] = await Promise.all([
      kpiRows(idList, from, to),
      attendanceRows({ employeeIds: idList, from, to }),
      activityRows(idList, from, to),
      kpiForm(ctx, people),
    ]);
    const am = new Map(att.map((a) => [key(a.employeeId, a.date), a]));
    const ag = groupBy(acts, (a) => key(a.employeeId, a.date));
    const pb = byId(people);
    return {
      spec: {
        screen: "kpi",
        cols: KPI_COLS,
        hidden: [],
        groups: ["date"],
        sortDefault: ["date", -1],
        godownKey: "office",
        newForm: form,
        newLabel: "Enter today’s sales",
        noDataLine: "No sales entries in this period.",
        hrms: {
          scope: { current: scope, options },
          period: { label: `${fdShort(from)} – ${fdShort(to)}`, params: [{ k: "from", l: "From", v: from, type: "date" }, { k: "to", l: "To", v: to, type: "date" }] },
        },
      },
      rows: rows.map((k) => kpiRow(ctx, k, pb.get(k.employeeId), am.get(key(k.employeeId, k.date)), ag.get(key(k.employeeId, k.date)))),
    };
  },
  formLoaders: {
    async edit(ctx, id) {
      const [k] = await db.select().from(hrmsKpi).where(eq(hrmsKpi.id, id));
      if (!k || !canTouchKpi(ctx, k)) return null;
      return (await kpiForm(ctx, await allPeople(), k)) ?? null;
    },
  },
  forms: {
    async kpi(ctx, h, _lines, recordId) {
      const people = await allPeople();
      let existing: Kpi | undefined;
      if (recordId) {
        [existing] = await db.select().from(hrmsKpi).where(eq(hrmsKpi.id, recordId));
        if (!existing) return err("That sales entry no longer exists.", "not_found");
        if (!canTouchKpi(ctx, existing)) return err(KPI_WHY, "not_permitted");
      }
      const p = existing ? people.find((x) => x.id === existing!.employeeId) : personFrom(h.emp, people);
      if (!p) return fieldErr("emp", "Pick a salesman from the list");
      if (!existing && !kpiPickable(ctx, people).some((x) => x.id === p.id))
        return fieldErr("emp", kpiWide(ctx) ? `${p.name} is not active sales staff. Pick a salesman from the list` : "You can enter sales only for yourself");
      const date = existing?.date ?? isoDate(h.date);
      if (!date) return fieldErr("date", "Enter the date of the sales entry");
      if (date > today()) return fieldErr("date", `${fdShort(date)} is in the future. Enter sales for today or an earlier date`);
      const area = text(h.area);
      if (!area) return fieldErr("area", "Area visited is required");
      for (const [k, l] of [
        ["visits", "Visits"],
        ["productive", "Productive counters"],
        ["litres", "Litre sales"],
        ["km", "Km"],
        ["amount", "Amount of sales"],
      ] as const) {
        const v = num(h[k]);
        if (v == null) return fieldErr(k, `${l} is required`);
        if (v < 0) return fieldErr(k, `${l} cannot be negative`);
      }
      if ((num(h.outstanding) ?? 0) < 0) return fieldErr("outstanding", "Outstanding cannot be negative");
      if ((num(h.stoppage) ?? 0) < 0) return fieldErr("stoppage", "Unplanned stop cannot be negative");
      const visits = int(h.visits)!;
      /* A59: a figure MahekOne already held is labelled with where it came
         from — and only while it still equals that figure, so a corrected
         count stops claiming MBOS said it. */
      const mbos = await mbosVisitCount(p.id, date);
      const prefill: Record<string, string> = {};
      if (mbos && visits === mbos) prefill.Visits = `MBOS · ${mbos} check-in${mbos > 1 ? "s" : ""}`;
      const values = {
        area,
        visits,
        productive: int(h.productive)!,
        litres: num(h.litres)!,
        km: num(h.km)!,
        amountPaise: paise(h.amount)!,
        outstandingPaise: paise(h.outstanding) ?? 0,
        stoppageMin: int(h.stoppage) ?? 0,
        notes: text(h.notes),
        prefill,
        updatedAt: new Date(),
        updatedById: ctx.user.id,
      };
      if (existing) {
        await db.update(hrmsKpi).set(values).where(eq(hrmsKpi.id, existing.id));
        await hrmsAudit(ctx, "hrms.kpi.edit", "hrms_kpi", existing.id, existing, values);
        return okVoid(`Sales entry saved for ${p.name}`);
      }
      const dupeMsg = `${p.name} already has a sales entry for ${fdShort(date)}. Edit that one instead`;
      const id = hrmsId("hkpi");
      /* One per employee per date: the unique index decides, so two saves at once cannot both land. */
      const inserted = await db
        .insert(hrmsKpi)
        .values({ id, employeeId: p.id, date, ...values, createdById: ctx.user.id })
        .onConflictDoNothing()
        .returning({ id: hrmsKpi.id });
      if (!inserted.length) return fieldErr("date", dupeMsg);
      await hrmsAudit(ctx, "hrms.kpi.add", "hrms_kpi", id, null, { employee: p.code, date, ...values });
      return okVoid("Sales entry saved · the day’s score is on the Sales score tab");
    },
  },
  actions: {
    async delete(ctx, id) {
      const [k] = await db.select().from(hrmsKpi).where(eq(hrmsKpi.id, id));
      if (!k) return err("That sales entry no longer exists.", "not_found");
      if (!canTouchKpi(ctx, k)) return err(KPI_WHY, "not_permitted");
      await db.delete(hrmsKpi).where(eq(hrmsKpi.id, id));
      await hrmsAudit(ctx, "hrms.kpi.delete", "hrms_kpi", id, k, null);
      return okVoid("Sales entry deleted");
    },
  },
};

/* ------------------------------------------------------- Sales performance */

const salesPerf: HrmsScreenModule = {
  key: "salesPerf",
  async load(ctx, q) {
    const t = today();
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "perfAdmin", "hr", "salesAll");
    const ids = visibleIds(ctx, scope, people);
    const idList = ids ? [...ids] : null;
    const { from, to } = periodOf(q, addDaysISO(t, -30), t);
    const [rows, book] = await Promise.all([kpiRows(idList, from, to), scoreBook(idList, from, to)]);
    const pb = byId(people);
    const scored = rows.map((k) => ({ k, s: scoreOf(k, book) }));

    /* The chart: the average per date, or one salesman's line when picked. */
    const emps = [...new Set(scored.map((x) => x.k.employeeId))].sort((a, b) => (pb.get(a)?.name ?? "").localeCompare(pb.get(b)?.name ?? ""));
    const who = q.who && emps.includes(q.who) ? q.who : emps.length === 1 ? emps[0] : "";
    const picked = scored.filter((x) => !who || x.k.employeeId === who);
    const byDate = groupBy(picked, (x) => x.k.date);
    const series = [...byDate.keys()].sort().map((d) => {
      const g = byDate.get(d)!;
      return { d, v: Math.round(g.reduce((a, x) => a + x.s.total, 0) / g.length) };
    });
    const last = [...picked].sort((a, b) => b.k.date.localeCompare(a.k.date))[0];

    return {
      spec: {
        screen: "salesPerf",
        cols: [
          { k: "date", l: "Date", t: "d" },
          { k: "emp", l: "Salesman", t: "b" },
          { k: "score", l: "Score", t: "n" },
          { k: "parts", l: "Breakdown", t: "t" },
          { k: "notes", l: "Meeting notes", t: "t" },
        ],
        hidden: [],
        sortDefault: ["date", -1],
        godownKey: "office",
        readOnly: true,
        noDataLine: "No sales entries in this period, so no score yet. Scores come from Daily sales entries.",
        hrms: {
          scope: { current: scope, options },
          period: { label: `${fdShort(from)} – ${fdShort(to)}`, params: [{ k: "from", l: "From", v: from, type: "date" }, { k: "to", l: "To", v: to, type: "date" }] },
          chart: {
            caption: "Daily score out of 100 · dashed line is the trend",
            series,
            ...(emps.length > 1 ? { pick: { param: "who", value: who, options: [{ v: "", l: "Team average" }, ...emps.map((e) => ({ v: e, l: pb.get(e)?.name ?? e }))] } } : {}),
            ...(last
              ? {
                  parts: {
                    title: `${pb.get(last.k.employeeId)?.name ?? ""} · ${fdShort(last.k.date)} · ${Math.round(last.s.total)} / 100`,
                    items: last.s.parts.map((p) => ({ l: p.l, got: p.got, max: p.max })),
                  },
                }
              : {}),
          },
        },
      },
      rows: scored.map(({ k, s }) => {
        const p = pb.get(k.employeeId);
        const kk = key(k.employeeId, k.date);
        const acts = book.acts.get(kk);
        const todos = book.todos.get(kk) ?? [];
        const onField = punchOf(k, book.att.get(kk)).onField;
        const part = (x: string) => s.parts.find((pp) => pp.k === x)!;
        const line = (x: string, fig: string, target: string): RowField => ({ l: `${part(x).l} (${fig} against ${target})`, v: `${part(x).got} / ${part(x).max}`, der: true });
        const notes = dayNotes(k, acts);
        const fields: RowField[] = [
          line("visits", String(k.visits), `${s.dailyTargets.visits} a day`),
          line("timeCust", `${s.timePerVisit} min a visit`, `${book.cfg.timeGivenBase} min`),
          line("noteLen", `${s.notePerVisit} characters a visit`, `${book.cfg.descriptionBase}`),
          line("hours", hm(Math.max(0, onField ?? 0)), `${Math.round(s.dailyTargets.hours * 10) / 10}h`),
          line("km", String(Number(k.km)), String(s.dailyTargets.km)),
          line("amount", inr(k.amountPaise), inr(s.dailyTargets.amountPaise)),
          line("litres", String(Number(k.litres)), String(s.dailyTargets.litres)),
          {
            l: `Outstanding (${inr(k.outstandingPaise)} on ${inr(s.totalSalePaise)} total sale with GST)`,
            v: `${part("outstanding").got} / ${part("outstanding").max} · ${s.paymentDays == null ? "no sale since the financial year start" : `${Math.round(s.paymentDays)} average payment days`}`,
            der: true,
          },
          { l: `Tasks (${todos.filter((x) => x.recheck === "Verified").length} verified of ${todos.length} to-dos)`, v: `${part("tasks").got} / ${part("tasks").max}`, der: true },
          { l: "Day’s score", v: String(s.total), der: true },
          { l: "Meeting notes", v: notes.join(" · ") },
          { l: "Month", v: monLabel(monthOf(k.date)) },
        ];
        return {
          id: k.id,
          v: {
            date: k.date,
            emp: p?.name ?? "",
            office: p?.office ?? "",
            score: Math.round(s.total * 10) / 10,
            parts: s.parts.map((pp) => `${pp.l.split(" ")[0]} ${pp.got}/${pp.max}`).join(" · "),
            notes: notes.join(" · "),
          },
          flags: [],
          title: `${p?.name ?? ""} · ${fdShort(k.date)}`,
          header: `Score ${Math.round(s.total * 10) / 10} / 100`,
          fields,
          actions: [{ id: "kpi", l: "Open sales entry", href: hrmsLink("kpi", { from: k.date, to: k.date, scope: scope === "mine" ? undefined : scope }) }],
        };
      }),
    };
  },
};

/* ------------------------------------------------------- Staff performance */

type StaffRow = { employee: Person; month: string; m: StaffMonth; sales: boolean };

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
  const ids = visibleIds(ctx, sc.scope, people);
  const offices = new Set(cfg.staffOffices.map((o) => o.trim().toLowerCase()));
  const staff = people.filter((p) => isActive(p) && offices.has((p.office ?? "").trim().toLowerCase()) && (!ids || ids.has(p.id)));
  const toMonth = q.month && /^\d{4}-\d{2}$/.test(q.month) ? q.month : monthOf(t);
  let fromMonth = toMonth;
  for (let i = 0; i < 5; i++) fromMonth = prevMonth(fromMonth);
  const from = `${fromMonth}-01`;
  const to = datesOfMonth(toMonth).at(-1)!;
  const idList = staff.map((p) => p.id);
  const [att, hol, checklist, todos, buddy, timings, book, kpis] = await Promise.all([
    attendanceRows({ employeeIds: idList, from, to }),
    holidays(from, to),
    checklistRows(idList, from, to),
    todoRows(idList, from, to),
    buddyRows(idList, from, to),
    timingMap(),
    scoreBook(idList, from, to),
    kpiRows(idList, from, to),
  ]);
  const attBy = groupBy(att, (a) => key(a.employeeId, monthOf(a.date)));
  const clBy = groupBy(checklist, (c) => key(c.employeeId, monthOf(c.date)));
  const tdBy = groupBy(todos, (c) => key(c.employeeId, monthOf(c.forDate)));
  const bdBy = groupBy(buddy, (c) => key(c.employeeId, monthOf(c.date)));
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
        checklist: clBy.get(k) ?? [],
        kpiParts,
        todos: (tdBy.get(k) ?? []).map((x) => ({
          done: x.status === "Done",
          daysGiven: x.tillDate ? daysBetweenISO(x.forDate, x.tillDate) : null,
          daysTaken: x.status === "Done" && x.doneOn ? daysBetweenISO(x.forDate, x.doneOn) : null,
        })),
        buddy: (bdBy.get(k) ?? []).map((b) => ({ done: b.status === BUDDY_DONE })),
      });
      rows.push({ employee: p, month: m, m: mm, sales });
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
      taskPct: r.m.dailyTaskPct,
      todoPerf: r.m.todoPct,
      buddyPerf: r.m.buddyPct,
      overall: r.m.overallPct,
      speed: r.m.speed,
    },
    flags: [],
    title: `${p.name} · ${monLabel(r.month)}`,
    header: `Overall ${r.m.overallPct}%`,
    fields: [
      { l: "Position type", v: p.positionType ?? "" },
      { l: "Working hours against target", v: pctTxt(r.m.workingHoursPct), der: true },
      { l: "Days on time", v: pctTxt(r.m.punctualityPct), der: true },
      { l: "Daily tasks not done", v: String(r.m.notDoneChecklist), der: true },
      { l: r.sales ? "Field work score (visits, time, notes, km)" : "Daily tasks done", v: pctTxt(r.m.dailyTaskPct), der: true },
      { l: "Working speed and to-dos not done", v: r.m.speed, der: true },
      { l: "To-do speed against time given", v: pctTxt(r.m.todoPct), der: true },
      { l: "Buddy tasks not done", v: String(r.m.notDoneBuddy), der: true },
      { l: "Buddy tasks done", v: r.m.buddyPct == null ? "No buddy tasks this month" : pctTxt(r.m.buddyPct), der: true },
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
          { k: "taskPct", l: "Daily tasks", t: "n", u: "%" },
          { k: "todoPerf", l: "To-dos", t: "n", u: "%" },
          { k: "buddyPerf", l: "Buddy tasks", t: "n", u: "%" },
          { k: "overall", l: "Overall", t: "n", u: "%" },
          { k: "speed", l: "Working speed", t: "t" },
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
  naCount: number;
  review: typeof hrmsReviews.$inferSelect | null;
};

/** Counts and points for these employees over a period (spec §12.4) — the screen and the PDF report read the same answer. */
export async function pointsFor(people: Person[], from: string, to: string): Promise<{ rows: PointsRow[]; financialDate: string }> {
  const cfg = await perfCfg();
  const ids = people.map((p) => p.id);
  if (!ids.length) return { rows: [], financialDate: cfg.pointsFrom };
  const [att, hol, checklist, todos, kpis, acts, reviews, targets] = await Promise.all([
    attendanceRows({ employeeIds: ids, from, to }),
    holidays(from, to),
    checklistRows(ids, from, to),
    todoRows(ids, from, to),
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
  const clBy = groupBy(checklist, (a) => a.employeeId);
  const tdBy = groupBy(todos, (a) => a.employeeId);
  const kpBy = groupBy(kpis, (a) => a.employeeId);
  const acBy = groupBy(acts, (a) => a.employeeId);
  const rvBy = new Map(reviews.map((r) => [r.employeeId, r]));
  const rows = people.map((p) => {
    const days = attBy.get(p.id) ?? [];
    const cl = clBy.get(p.id) ?? [];
    const td = tdBy.get(p.id) ?? [];
    const allK = kpBy.get(p.id) ?? [];
    const inK = allK.filter((k) => k.date >= from);
    const latest = [...allK].sort((a, b) => b.date.localeCompare(a.date))[0];
    const ac = acBy.get(p.id) ?? [];
    /* Time with customers per day: activities, or the KPI's own figure on a day none were logged — the daily score's reading. */
    const dayMinutes = new Map<string, number>();
    for (const [d, list] of groupBy(ac, (a) => a.date)) dayMinutes.set(d, list.reduce((a, x) => a + x.minutes, 0));
    for (const k of inK) if (!dayMinutes.has(k.date) && k.timeGivenMin > 0) dayMinutes.set(k.date, k.timeGivenMin);
    const na = cl.filter((c) => c.status === CHECKLIST_NA);
    const points = performancePoints(
      {
        kind: pointKind(p.positionType),
        periodDays,
        attendanceRows: days.length,
        earlyRows: days.filter(earlyDay).length,
        taggedHolidays: hol.filter((h) => holidayApplies(h, p.id, p.office)).length,
        durationMin: days.reduce((a, d) => a + (d.fig.durationMin ?? 0), 0),
        checklistTotal: cl.length,
        checklistCleared: cl.filter((c) => c.status === "Done" || c.status === CHECKLIST_NA).length,
        todosTotal: td.length,
        todosDone: td.filter((x) => x.status === "Done").length,
        naReasons: na.map((c) => c.naReason ?? ""),
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
      },
      { standardHours: cfg.standardHours, periodDivisor: cfg.periodDivisor, bands: cfg.pointBands },
    );
    return { employee: p, from, to, points, naCount: na.length, review: rvBy.get(p.id) ?? null };
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
  if (x.taskCount != null) lines.push({ l: "Task count", v: String(x.taskCount) }, { l: "Not applicable", v: x.naText ?? "" }, { l: "Task point", v: n(x.taskPoint) });
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
  const ids = visibleIds(ctx, scope, people);
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
    const ids = visibleIds(ctx, scope, people);
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
          { k: "tasks", l: "Tasks", t: "t" },
          { k: "na", l: "Not applicable", t: "n" },
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
            tasks: x.taskCount == null ? "" : String(x.taskCount),
            na: x.taskCount == null ? null : r.naCount,
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
              confirm: `Mark ${p.name}’s report as revised? The PDF is always drawn from the latest attendance, tasks and sales; this only moves its version number from ${version} to ${version + 1}.`,
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

export const PERF_SCREENS: HrmsScreenModule[] = [kpi, salesPerf, staffPerf, eom, points];
