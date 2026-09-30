import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { hrmsAttendance, hrmsLeaveRequests } from "@/db/schema";
import { parseCsv } from "@/lib/csv";
import type { ActionSpec, ColSpec, Contact, FormSpec, ListRow, RowField, ToolSpec } from "@/lib/erp/ui";
import { has, scopeOf, type HrmsContext, type Scope } from "../access";
import { hrmsAudit, hrmsId, inTx, refuse, stampLine, text, today, fieldErr, okVoid, err, ok, type HrmsScreenModule, type ScreenQuery } from "../server";
import { allPeople, byId, isActive, markableStaff, timingMap, visibleIds, type Person } from "../services/people";
import { attendanceCfg, attendanceRows, holidays, type DayRow } from "../services/attendance";
import { minutesBetween, timeRemark } from "../engines/attendance";
import { holidayApplies } from "../engines/leave";
import { addDaysISO, distanceLabel, hm, tmin, weekdayOf, fdShort, datesBetween } from "../time";
import { hrmsLink } from "../registry";
import type { HrmsExtras } from "../extras";

/* ---------------------------------------------------------------------------
 * Attendance (spec §6): the register, pending check-outs, absentees and the
 * attendance chart. One record per employee per day; every figure a day
 * carries comes from `engines/attendance.ts` through the attendance service,
 * so the register, the monthly report and payroll agree about it.
 * ------------------------------------------------------------------------- */

/** Who a list shows for this person, and the scopes they may switch between. */
export function scopeFor(ctx: HrmsContext, q: ScreenQuery, ...widening: Parameters<typeof scopeOf>[1][]): { scope: Scope; options: Scope[] } {
  const widest = scopeOf(ctx, ...widening);
  const options: Scope[] = widest === "all" ? (ctx.isHead ? ["mine", "team", "all"] : ["mine", "all"]) : widest === "team" ? ["mine", "team"] : ["mine"];
  const want = q.scope as Scope | undefined;
  return { scope: want && options.includes(want) ? want : widest, options };
}

const COLS: ColSpec[] = [
  { k: "date", l: "Date", t: "d" },
  { k: "emp", l: "Employee", t: "b" },
  { k: "office", l: "Office", t: "t" },
  { k: "in", l: "Check in", t: "t" },
  { k: "out", l: "Check out", t: "t" },
  { k: "dur", l: "Duration", t: "t" },
  { k: "late", l: "Late / early", t: "t" },
  { k: "workDay", l: "Day", t: "s" },
  { k: "current", l: "Status", t: "s" },
  { k: "pct", l: "Working %", t: "n", u: "%" },
  { k: "distance", l: "Distance", t: "t" },
  { k: "f", l: "Flags", t: "f" },
];

function flagsOf(r: DayRow, t: string): string[] {
  const f: string[] = [];
  if (r.fig.lateBeyondGrace) f.push("late");
  else if (r.fig.lateMin != null && r.fig.lateMin <= 0) f.push("early");
  if (!r.checkOut && r.date !== t) f.push("noOut");
  if (!r.checkOut && r.date === t) f.push("working");
  if (r.fig.workDay === "Half Day") f.push("halfDay");
  if (r.method === "qr") f.push("qr");
  if (r.method === "officer") f.push("marked");
  return f;
}

function actionsFor(ctx: HrmsContext, r: DayRow, t: string): ActionSpec[] {
  const own = r.employeeId === ctx.employee?.id;
  const a: ActionSpec[] = [];
  if (!r.checkOut && own) {
    if (r.date === t) a.push({ id: "goHome", l: "Check out", primary: true, href: "/hrms" });
    else
      a.push({
        id: "checkOutLate",
        l: "Check out",
        primary: true,
        prompt: {
          title: `Check out for ${fdShort(r.date)}`,
          sub: `You checked in at ${r.checkIn} and never checked out.`,
          submit: "Check out",
          fields: [
            { k: "out", l: "Check-out time", t: "time", req: true },
            { k: "remark", l: "Remark", t: "text", req: true },
          ],
        },
      });
  }
  if (!r.checkOut && !own)
    a.push({
      id: "officerOut",
      l: "Check out by officer",
      why: has(ctx, "checkoutStaff") ? undefined : "Only a head, HR or admin checks out another person",
      prompt: {
        title: "Check out",
        sub: `${fdShort(r.date)} · checked in ${r.checkIn}`,
        submit: "Check out",
        init: { out: r.officialOut ?? "" },
        fields: [
          { k: "out", l: "Check Out Time", t: "time", req: true },
          { k: "remark", l: "Remark", t: "text" },
        ],
      },
    });
  if (has(ctx, "editAtt"))
    a.push({
      id: "setIn",
      l: "Set check-in time",
      prompt: {
        title: "Set check-in time",
        submit: "Save time",
        init: { in: r.checkIn },
        fields: [
          { k: "in", l: "Check-in", t: "time", req: true },
          { k: "remark", l: "Remark", t: "text", req: true },
        ],
      },
    });
  if (has(ctx, "editAtt") || has(ctx, "checkoutStaff") || own)
    a.push({
      id: "remark",
      l: "Remark",
      prompt: { title: "Remark", submit: "Save remark", init: { remark: r.remark ?? "" }, fields: [{ k: "remark", l: "Write Remark", t: "area", req: true }] },
    });
  if (r.method === "qr" && has(ctx, "admin") && !r.editHelp) a.push({ id: "editHelp", l: "Edit help" });
  if (has(ctx, "editAtt")) a.push({ id: "delete", l: "Delete", confirm: "Delete this attendance day? It cannot be undone." });
  return a;
}

export function attendanceRow(ctx: HrmsContext, r: DayRow, p: Person | undefined, t: string): ListRow {
  const name = p?.name ?? "";
  const fields: RowField[] = [
    { l: "Employee ID", v: p?.code ?? "" },
    { l: "Official in – out", v: r.officialIn ? `${r.officialIn} – ${r.officialOut ?? ""}` : "No timing set for this weekday" },
    { l: "Target duration", v: hm(r.targetMin), der: true },
    { l: "Unplanned stoppage", v: r.stoppageMin ? hm(r.stoppageMin) : "—" },
    { l: "Working hours", v: hm(r.fig.workedMin), der: true },
    { l: "Working hour difference", v: hm(r.fig.differenceMin), der: true },
    { l: "Time remark", v: timeRemark(r.fig, name, r.method), der: true },
    { l: "Remark", v: r.remark ?? "" },
    {
      l: "How it was recorded",
      v: r.method === "officer" ? `Marked by ${r.markedByName ?? "a head"}` : r.method === "qr" ? `QR code ${r.checkInCode ?? ""}` : r.method === "import" ? "Imported" : "Location check",
    },
    { l: "Check-in photo", v: r.inPhotoId ? "Attached" : "None" },
    { l: "Check-out photo", v: r.outPhotoId ? "Attached" : "None" },
  ];
  const contacts: Contact[] = [];
  if (r.lat != null && r.lng != null) contacts.push({ l: "Check-in location", href: `https://maps.google.com/?q=${r.lat},${r.lng}` });
  if (r.inPhotoId) contacts.push({ l: "Check-in photo", href: `/api/attachments/${r.inPhotoId}` });
  if (r.outPhotoId) contacts.push({ l: "Check-out photo", href: `/api/attachments/${r.outPhotoId}` });
  return {
    id: r.id,
    v: {
      date: r.date,
      emp: name,
      office: r.officeName,
      in: r.checkIn,
      out: r.checkOut ?? "",
      dur: r.fig.durationMin == null ? (r.date === t ? "Working" : "No check-out") : hm(r.fig.durationMin),
      late: r.fig.lateTxt,
      workDay: r.fig.workDay,
      current: r.fig.current,
      pct: r.fig.pct,
      distance: r.method === "officer" ? "Marked by head" : distanceLabel(r.distanceM),
      dayTab: r.date === t ? "Today" : "Earlier",
    },
    flags: flagsOf(r, t),
    title: `${name} · ${fdShort(r.date)}`,
    header: `${r.checkIn} – ${r.checkOut ?? "…"} · ${r.fig.current}`,
    fields,
    contacts,
    actions: actionsFor(ctx, r, t),
    by: stampLine(r.markedByName, r.createdAt),
  };
}

function markForm(ctx: HrmsContext, people: Person[], marked: Set<string>, t: string): FormSpec | undefined {
  if (!has(ctx, "markStaff")) return undefined;
  const wide = has(ctx, "hr") || ctx.administrator;
  const staff = markableStaff(ctx, people, wide).filter((p) => !marked.has(`${p.id}|${t}`));
  return {
    screen: "attendance",
    id: "mark",
    title: "Mark attendance for staff",
    sub: "Field and other staff of your office who are not yet marked today. Heads are never marked by someone else.",
    submit: "Mark attendance",
    init: { date: t, in: "09:30" },
    header: [
      { k: "emp", l: "Employee", t: "select", req: true, opts: staff.map((p) => `${p.name} · ${p.code}`), hint: "Only active field and other staff of your office, not yet marked for this date." },
      { k: "date", l: "Date", t: "date", req: true },
      { k: "in", l: "Check in", t: "time", req: true },
      { k: "out", l: "Check out", t: "time" },
      { k: "stoppage", l: "Unplanned stoppage (min)", t: "num", min: 0 },
      { k: "office", l: "Office", t: "text", readOnly: true, def: ctx.employee?.office ?? "" },
      { k: "photo", l: "Photo", t: "photo" },
    ],
  };
}

/** Resolves "Name · CODE" from a select back to the person. */
export function personFrom(v: string | undefined, people: Person[]): Person | undefined {
  const code = String(v ?? "").split(" · ").pop();
  return people.find((p) => p.code === code) ?? people.find((p) => p.name === v);
}

export const personOption = (p: Person) => `${p.name} · ${p.code}`;

const importTools = (ctx: HrmsContext): ToolSpec[] =>
  has(ctx, "editAtt") || has(ctx, "import")
    ? [
        {
          id: "import",
          l: "Import CSV",
          prompt: {
            title: "Import attendance from CSV",
            sub: "Columns: Employee ID, Date (YYYY-MM-DD), Check In (HH:MM), Check Out (HH:MM), Remark. You see every row before anything is written.",
            submit: "Preview",
            fields: [{ k: "csv", l: "CSV file", t: "csv", req: true }],
          },
        },
      ]
    : [];

type ImportLine = { code: string; date: string; in: string; out: string; remark: string; error: string };

async function readImport(csvText: string): Promise<ImportLine[]> {
  const people = await allPeople();
  const byCode = new Map(people.map((p) => [p.code.toUpperCase(), p]));
  const rows = parseCsv(csvText);
  const pick = (r: Record<string, string>, ...keys: string[]) => {
    for (const k of Object.keys(r)) if (keys.some((x) => k.trim().toLowerCase() === x)) return String(r[k] ?? "").trim();
    return "";
  };
  return rows.map((r) => {
    const code = pick(r, "employee id", "emp id", "employee code");
    const date = pick(r, "date");
    const inT = pick(r, "check in", "in");
    const outT = pick(r, "check out", "out");
    let error = "";
    if (!byCode.get(code.toUpperCase())) error = `Unknown employee ID ${code || "(blank)"}`;
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) error = "Date must be YYYY-MM-DD";
    else if (tmin(inT) == null) error = "Check In must be HH:MM";
    else if (outT && minutesBetween(inT, outT) == null) error = "Check-out is before check-in";
    return { code, date, in: inT, out: outT, remark: pick(r, "remark"), error };
  });
}

const attendance: HrmsScreenModule = {
  key: "attendance",
  async load(ctx, q) {
    const cfg = await attendanceCfg();
    const t = today();
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "hr", "editAtt");
    const ids = visibleIds(ctx, scope, people);
    const from = q.from ?? addDaysISO(t, -cfg.defaultWindowDays);
    const [rows, todays] = await Promise.all([attendanceRows({ employeeIds: ids ? [...ids] : null, from, to: q.to }), attendanceRows({ from: t, to: t })]);
    const marked = new Set(todays.map((r) => `${r.employeeId}|${r.date}`));
    const pb = byId(people);
    const myPending = ctx.employee ? rows.filter((r) => r.employeeId === ctx.employee!.id && !r.checkOut && r.date < t).length : 0;
    const extras: HrmsExtras = {
      scope: { current: scope, options },
      period: { label: "", params: [{ k: "from", l: "From", v: from, type: "date" }] },
      ...(myPending ? { notice: { text: `You have ${myPending} pending check-out${myPending > 1 ? "s" : ""} — they block that month’s salary`, href: hrmsLink("pendingOut") } } : {}),
    };
    return {
      spec: {
        screen: "attendance",
        cols: COLS,
        hidden: [],
        groups: ["date"],
        chips: "dayTab",
        sortDefault: ["date", -1],
        godownKey: "office",
        newForm: markForm(ctx, people, marked, t),
        newLabel: "Mark attendance for staff",
        tools: importTools(ctx),
        noDataLine: "No attendance in this window yet.",
        hrms: extras,
      },
      rows: rows.map((r) => attendanceRow(ctx, r, pb.get(r.employeeId), t)),
    };
  },
  actions: {
    async checkOutLate(ctx, id, v) {
      const [r] = await db.select().from(hrmsAttendance).where(eq(hrmsAttendance.id, id));
      if (!r || r.employeeId !== ctx.employee?.id) return err("That day is not yours.", "not_permitted");
      if (r.checkOut) return err("Already checked out.");
      if (minutesBetween(r.checkIn, v.out) == null) return fieldErr("out", "Check-out must be after check-in");
      await db.update(hrmsAttendance).set({ checkOut: v.out, remark: text(v.remark), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsAttendance.id, id));
      await hrmsAudit(ctx, "hrms.attendance.checkOut", "hrms_attendance", id, { checkOut: null }, { checkOut: v.out });
      return okVoid(`Checked out for ${fdShort(r.date)} at ${v.out}`);
    },
    async officerOut(ctx, id, v) {
      if (!has(ctx, "checkoutStaff")) return err("Only a head, HR or admin checks out another person", "not_permitted");
      const [r] = await db.select().from(hrmsAttendance).where(eq(hrmsAttendance.id, id));
      if (!r) return err("That day no longer exists.", "not_found");
      if (r.checkOut) return err("Already checked out.");
      if (minutesBetween(r.checkIn, v.out) == null) return fieldErr("out", "Check-out must be after check-in");
      await db
        .update(hrmsAttendance)
        .set({ checkOut: v.out, remark: text(v.remark) ?? `Checked out by ${ctx.user.name}`, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsAttendance.id, id));
      await hrmsAudit(ctx, "hrms.attendance.officerCheckOut", "hrms_attendance", id, null, { checkOut: v.out });
      return okVoid(`Checked out at ${v.out}`);
    },
    async setIn(ctx, id, v) {
      if (!has(ctx, "editAtt")) return err("Only admin sets a check-in time", "not_permitted");
      if (tmin(v.in) == null) return fieldErr("in", "INVALID");
      const [r] = await db.select().from(hrmsAttendance).where(eq(hrmsAttendance.id, id));
      if (!r) return err("That day no longer exists.", "not_found");
      if (r.checkOut && minutesBetween(v.in, r.checkOut) == null) return fieldErr("in", "Check-in must be before check-out");
      await db.update(hrmsAttendance).set({ checkIn: v.in, remark: text(v.remark), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsAttendance.id, id));
      await hrmsAudit(ctx, "hrms.attendance.setIn", "hrms_attendance", id, { checkIn: r.checkIn }, { checkIn: v.in });
      return okVoid(`Check-in set to ${v.in}`);
    },
    async remark(ctx, id, v) {
      const [r] = await db.select().from(hrmsAttendance).where(eq(hrmsAttendance.id, id));
      if (!r) return err("That day no longer exists.", "not_found");
      if (!(has(ctx, "editAtt") || has(ctx, "checkoutStaff") || r.employeeId === ctx.employee?.id)) return err("Not yours to remark on.", "not_permitted");
      await db.update(hrmsAttendance).set({ remark: text(v.remark), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsAttendance.id, id));
      return okVoid("Remark saved");
    },
    async editHelp(ctx, id) {
      if (!has(ctx, "admin")) return err("Admin only", "not_permitted");
      await db.update(hrmsAttendance).set({ editHelp: true, updatedAt: new Date() }).where(eq(hrmsAttendance.id, id));
      return okVoid("Edit help switched on for this day");
    },
    async delete(ctx, id) {
      if (!has(ctx, "editAtt")) return err("Only admin deletes attendance", "not_permitted");
      const [r] = await db.select().from(hrmsAttendance).where(eq(hrmsAttendance.id, id));
      if (!r) return err("That day no longer exists.", "not_found");
      await db.delete(hrmsAttendance).where(eq(hrmsAttendance.id, id));
      await hrmsAudit(ctx, "hrms.attendance.delete", "hrms_attendance", id, r, null);
      return okVoid("Attendance deleted");
    },
  },
  forms: {
    async mark(ctx, h) {
      if (!has(ctx, "markStaff")) return err("Only a head, HR or admin marks attendance for staff", "not_permitted");
      const people = await allPeople();
      const p = personFrom(h.emp, people);
      if (!p) return fieldErr("emp", "invalid Name");
      const wide = has(ctx, "hr") || ctx.administrator;
      if (!markableStaff(ctx, people, wide).some((x) => x.id === p.id)) return fieldErr("emp", "invalid Name");
      const date = text(h.date);
      if (!date || date > today()) return fieldErr("date", "INVALID");
      if (tmin(h.in) == null) return fieldErr("in", "Check in is required");
      if (h.out && minutesBetween(h.in, h.out) == null) return fieldErr("out", "Check-out must be after check-in");
      const timings = await timingMap();
      const tm = timings.get(`${p.id}|${weekdayOf(date)}`);
      const id = hrmsId("hatt");
      const res = await inTx(async (tx) => {
        const [dupe] = await tx
          .select({ id: hrmsAttendance.id })
          .from(hrmsAttendance)
          .where(and(eq(hrmsAttendance.employeeId, p.id), eq(hrmsAttendance.date, date)));
        if (dupe) return refuse(fieldErr("emp", `${p.name} is already marked for ${fdShort(date)}`));
        await tx.insert(hrmsAttendance).values({
          id,
          employeeId: p.id,
          date,
          officeName: p.office,
          method: "officer",
          checkIn: h.in,
          checkOut: text(h.out),
          stoppageMin: Number(h.stoppage) || 0,
          officialIn: tm?.inTime ?? null,
          officialOut: tm?.outTime ?? null,
          targetMin: tm ? minutesBetween(tm.inTime, tm.outTime) : null,
          inPhotoId: text(h.photo),
          markedById: ctx.user.id,
          markedByName: ctx.user.name,
          reportToStamp: ctx.employee?.position ?? null,
          createdById: ctx.user.id,
        });
        if (h.photo) {
          const { bindHrmsFiles } = await import("../attachments");
          await bindHrmsFiles(tx, [h.photo], "hrms_attendance", id, ctx.user.id);
        }
        return okVoid(`Attendance marked for ${p.name}${h.out ? "" : " · check them out at the end of the day"}`);
      });
      if (res.ok) await hrmsAudit(ctx, "hrms.attendance.mark", "hrms_attendance", id, null, { employee: p.code, date });
      return res;
    },
  },
  tools: {
    async import(ctx, v) {
      if (!(has(ctx, "editAtt") || has(ctx, "import"))) return err("Importing attendance is not on your account.", "not_permitted");
      const lines = await readImport(v.csv ?? "");
      if (!lines.length) return fieldErr("csv", "The file has no rows under its header.");
      const good = lines.filter((l) => !l.error).length;
      return ok({
        dialog: {
          title: "Import attendance from CSV",
          sub: `${good} rows ready · ${lines.length - good} with errors are skipped`,
          lines: lines.map((l, i) => ({
            text: `Row ${i + 2} · ${l.code} · ${l.date} · ${l.in}–${l.out || "…"}${l.error ? ` — ${l.error}` : ""}`,
            tone: l.error ? ("danger" as const) : undefined,
          })),
          next: good ? { tool: "importConfirm", label: `Import ${good} rows`, values: { csv: v.csv ?? "" } } : undefined,
        },
      });
    },
    async importConfirm(ctx, v) {
      if (!(has(ctx, "editAtt") || has(ctx, "import"))) return err("Importing attendance is not on your account.", "not_permitted");
      const lines = (await readImport(v.csv ?? "")).filter((l) => !l.error);
      const people = await allPeople();
      const byCode = new Map(people.map((p) => [p.code.toUpperCase(), p]));
      const timings = await timingMap();
      let added = 0;
      let skipped = 0;
      for (const l of lines) {
        const p = byCode.get(l.code.toUpperCase())!;
        const tm = timings.get(`${p.id}|${weekdayOf(l.date)}`);
        const res = await db
          .insert(hrmsAttendance)
          .values({
            id: hrmsId("hatt"),
            employeeId: p.id,
            date: l.date,
            officeName: p.office,
            method: "import",
            checkIn: l.in,
            checkOut: l.out || null,
            officialIn: tm?.inTime ?? null,
            officialOut: tm?.outTime ?? null,
            targetMin: tm ? minutesBetween(tm.inTime, tm.outTime) : null,
            remark: l.remark || "Imported",
            markedById: ctx.user.id,
            markedByName: "Import",
            createdById: ctx.user.id,
          })
          .onConflictDoNothing()
          .returning({ id: hrmsAttendance.id });
        if (res.length) added++;
        else skipped++;
      }
      await hrmsAudit(ctx, "hrms.attendance.import", "hrms_attendance", null, null, { added, skipped });
      return okVoid(`${added} rows imported${skipped ? ` · ${skipped} already had attendance that day` : ""}`);
    },
  },
};

const pendingOut: HrmsScreenModule = {
  key: "pendingOut",
  async load(ctx, q) {
    const t = today();
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "hr", "editAtt", "checkoutStaff");
    const ids = visibleIds(ctx, scope, people);
    const rows = (await attendanceRows({ employeeIds: ids ? [...ids] : null })).filter((r) => !r.checkOut);
    const pb = byId(people);
    return {
      spec: {
        screen: "pendingOut",
        cols: [
          { k: "date", l: "Date", t: "d" },
          { k: "emp", l: "Employee", t: "b" },
          { k: "office", l: "Office", t: "t" },
          { k: "in", l: "Check in", t: "t" },
          { k: "current", l: "Status", t: "s" },
          { k: "f", l: "Flags", t: "f" },
        ],
        hidden: [],
        groups: ["date"],
        sortDefault: ["date", -1],
        godownKey: "office",
        noDataLine: "Nobody has a check-in without a check-out.",
        hrms: { scope: { current: scope, options } },
      },
      rows: rows.map((r) => ({ ...attendanceRow(ctx, r, pb.get(r.employeeId), t), flags: r.date === t ? ["working"] : ["noOut"] })),
    };
  },
  actions: attendance.actions,
};

const absentees: HrmsScreenModule = {
  key: "absentees",
  async load(_ctx, q) {
    const t = today();
    const date = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : t;
    const [people, day, hol, leave, week] = await Promise.all([
      allPeople(),
      attendanceRows({ from: date, to: date }),
      holidays(date, date),
      db.select().from(hrmsLeaveRequests),
      attendanceRows({ from: addDaysISO(date, -6), to: date }),
    ]);
    const present = new Set(day.map((d) => d.employeeId));
    /* Spec §6.6 / A52: any leave request covering the date excuses the day, whatever its status. */
    const onLeave = new Set(leave.filter((l) => l.startDate <= date && l.endDate >= date).map((l) => l.employeeId));
    const out = people.filter((p) => isActive(p) && !present.has(p.id) && !onLeave.has(p.id) && !hol.some((h) => holidayApplies(h, p.id, p.office)));
    const weekDates = datesBetween(addDaysISO(date, -6), date);
    return {
      spec: {
        screen: "absentees",
        cols: [
          { k: "emp", l: "Employee", t: "b" },
          { k: "code", l: "ID", t: "t" },
          { k: "office", l: "Office", t: "t" },
          { k: "position", l: "Position", t: "t" },
          { k: "count", l: "Days without attendance (7)", t: "n" },
        ],
        hidden: [],
        sortDefault: ["code", 1],
        godownKey: "office",
        readOnly: true,
        noDataLine: "Everybody is accounted for on this date.",
        hrms: {
          period: { label: `Absent on ${fdShort(date)}`, params: [{ k: "date", l: "Date", v: date, type: "date" }] },
          notice: { text: "Pending check-outs are listed on their own screen", href: hrmsLink("pendingOut") },
        },
      },
      rows: out.map((p) => ({
        id: p.id,
        v: { emp: p.name, code: p.code, office: p.office, position: p.position, count: weekDates.filter((d) => !week.some((w) => w.employeeId === p.id && w.date === d)).length },
        flags: [],
        title: p.name,
        header: `${p.code} · ${p.position ?? ""} · ${p.office ?? ""}`,
        actions: [{ id: "open", l: "Open attendance", href: hrmsLink("attendance", { scope: "all" }) }],
      })),
    };
  },
};

const attChart: HrmsScreenModule = {
  key: "attChart",
  async load(ctx) {
    const t = today();
    const from = addDaysISO(t, -29);
    const people = await allPeople();
    const ids = visibleIds(ctx, scopeOf(ctx, "hr", "editAtt"), people);
    const rows = await attendanceRows({ employeeIds: ids ? [...ids] : null, from, to: t });
    const pb = byId(people);
    const series = datesBetween(from, t).map((d) => ({ d, v: new Set(rows.filter((r) => r.date === d).map((r) => r.employeeId)).size }));
    const by = new Map<string, DayRow[]>();
    for (const r of rows) {
      const list = by.get(r.employeeId) ?? [];
      list.push(r);
      by.set(r.employeeId, list);
    }
    return {
      spec: {
        screen: "attChart",
        cols: [
          { k: "emp", l: "Employee", t: "b" },
          { k: "office", l: "Office", t: "t" },
          { k: "count", l: "Days present (30)", t: "n" },
          { k: "late", l: "Late days", t: "n" },
        ],
        hidden: [],
        sortDefault: ["count", -1],
        godownKey: "office",
        readOnly: true,
        noDataLine: "No attendance in the last 30 days.",
        hrms: { chart: { caption: "People present per day, last 30 days · dashed line is the trend", series } },
      },
      rows: [...by.entries()].map(([emp, rs]) => ({
        id: emp,
        v: { emp: pb.get(emp)?.name ?? "", office: pb.get(emp)?.office ?? "", count: rs.length, late: rs.filter((r) => r.fig.lateBeyondGrace).length },
        flags: [],
        title: pb.get(emp)?.name ?? "",
        actions: [{ id: "open", l: "Open their days", href: hrmsLink("attendance", { scope: "all" }) }],
      })),
    };
  },
};

export const ATTENDANCE_SCREENS: HrmsScreenModule[] = [attendance, pendingOut, absentees, attChart];
