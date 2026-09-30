import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { hrmsBuddyTasks, hrmsChecklist, hrmsTaskTemplates, hrmsTodos, users } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { notifyUsers } from "@/lib/notify";
import type { ActionSpec, ColSpec, FieldSpec, FormSpec, ListRow, RowField, ToolResult, ToolSpec } from "@/lib/erp/ui";
import type { Err } from "@/lib/result";
import { has, type HrmsContext } from "../access";
import { err, fieldErr, first, hrmsAudit, hrmsId, inTx, int, multi, nextSeries, now, ok, okVoid, refuse, stampLine, text, today, type HrmsScreenModule, type Tx } from "../server";
import { allPeople, byId, isActive, visibleIds, type Person } from "../services/people";
import { personFrom, personOption, scopeFor } from "./attendance";
import {
  averageDaysTaken,
  buddySuggestions,
  checkTemplate,
  checklistBucket,
  checklistOpen,
  daysGiven,
  daysTaken,
  expiredMessage,
  FREQUENCIES,
  isUrgentCategory,
  monthlyTemplates,
  monthlyTodoDates,
  storedWeekdays,
  TASK_CATEGORIES,
  taskEodMessage,
  templatesForDay,
  timeDifference,
  todoExpired,
  todoOverdue,
  todoTab,
  waDigits,
} from "../engines/tasks";
import { addDaysISO, fdShort, hm, monthOf, weekdayOf, WEEKDAYS } from "../time";
import { hrmsLink } from "../registry";

/* ---------------------------------------------------------------------------
 * Tasks (spec §13): templates, the daily checklist they are copied into, the
 * to-dos people give each other and the tasks shared with a buddy, plus the
 * Task EOD. Every rule a day or a month turns on — which templates Take my
 * task copies, when a to-do has expired, days given and taken — is in
 * `engines/tasks.ts`, so the screens, the EOD and staff performance agree.
 *
 * Scope: your own rows; a head their team; `tasksAdmin` (or admin) everyone,
 * and only they add or change templates for somebody else.
 * ------------------------------------------------------------------------- */

type Template = typeof hrmsTaskTemplates.$inferSelect;
type Checklist = typeof hrmsChecklist.$inferSelect;
type Todo = typeof hrmsTodos.$inferSelect;
type Buddy = typeof hrmsBuddyTasks.$inferSelect;

const NOT_LINKED = "Your account is not linked to an employee record yet. Ask HR to link it on the Access screen.";

/** Manages everyone's tasks: the power, or HRMS administration. */
const taskAdmin = (ctx: HrmsContext) => has(ctx, "tasksAdmin") || has(ctx, "admin");

const isISO = (v: string | null | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** "1 Oct 2026, 10:14 am" — an instant as a drawer line. */
const when = (at: Date | null) => (at ? stampLine(null, at).replace(/^Created\s*/, "") : "—");

/** A bell never costs the write it follows: a failed notification is logged and dropped. */
async function notifyEmployees(employeeIds: string[], title: string, body: string, href: string): Promise<void> {
  const ids = [...new Set(employeeIds.filter(Boolean))];
  if (!ids.length) return;
  try {
    const us = await db.select({ id: users.id }).from(users).where(and(inArray(users.employeeId, ids), eq(users.active, true)));
    await notifyUsers(us.map((u) => ({ userId: u.id, title, body, href })));
  } catch (e) {
    console.error("hrms tasks: notification failed", e);
  }
}

/** Serialises Take my task / Take monthly task per person, so a double click cannot copy twice. */
async function lockFor(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/* ================================================================= tools */

const takeTaskTool = (ctx: HrmsContext): ToolSpec => ({ id: "takeTask", l: "Take my task", why: ctx.employee ? undefined : NOT_LINKED });
const takeMonthlyTool = (ctx: HrmsContext): ToolSpec => ({ id: "takeMonthly", l: "Take monthly task", why: ctx.employee ? undefined : NOT_LINKED });
const eodTool = (ctx: HrmsContext): ToolSpec => ({ id: "eod", l: "Task EOD", primary: true, why: ctx.employee ? undefined : NOT_LINKED });

const TOOLS: NonNullable<HrmsScreenModule["tools"]> = {
  /** Spec §13.1: today's templates into today's checklist, once a day. */
  async takeTask(ctx) {
    const me = ctx.employee;
    if (!me) return err(NOT_LINKED, "not_permitted");
    const t = today();
    const wd = weekdayOf(t);
    const res = await inTx(async (tx) => {
      await lockFor(tx, `hrms.takeTask:${me.id}:${t}`);
      const [taken] = await tx
        .select({ id: hrmsChecklist.id })
        .from(hrmsChecklist)
        .where(and(eq(hrmsChecklist.employeeId, me.id), eq(hrmsChecklist.date, t)))
        .limit(1);
      if (taken) return refuse(err("Today’s tasks are already in your checklist", "conflict"));
      const mine = await tx.select().from(hrmsTaskTemplates).where(eq(hrmsTaskTemplates.employeeId, me.id)).orderBy(asc(hrmsTaskTemplates.serial));
      const tk = templatesForDay(mine, t);
      if (!tk.length) return refuse(err(`You have no tasks for ${wd} in your templates`, "rule_violation"));
      await tx.insert(hrmsChecklist).values(
        tk.map((x) => ({
          id: hrmsId("hcl"),
          date: t,
          employeeId: me.id,
          templateId: x.id,
          task: x.task,
          frequency: x.frequency,
          weekday: wd,
          startTime: x.startTime,
          endTime: x.endTime,
          createdById: ctx.user.id,
        })),
      );
      const out: ToolResult = { navigate: hrmsLink("checklist") };
      return ok(out, `${tk.length} task${tk.length > 1 ? "s" : ""} for ${wd} added to today’s checklist`);
    });
    if (res.ok) await hrmsAudit(ctx, "hrms.tasks.takeTask", "hrms_checklist", null, null, { employee: me.code, date: t });
    return res;
  },

  /** Spec §13.1: the Monthly templates into to-dos, once a month (the month key is the guard). */
  async takeMonthly(ctx) {
    const me = ctx.employee;
    if (!me) return err(NOT_LINKED, "not_permitted");
    const m = monthOf(today());
    const res = await inTx(async (tx) => {
      await lockFor(tx, `hrms.takeMonthly:${me.id}:${m}`);
      const [taken] = await tx
        .select({ id: hrmsTodos.id })
        .from(hrmsTodos)
        .where(and(eq(hrmsTodos.toEmployeeId, me.id), eq(hrmsTodos.monthlyKey, m)))
        .limit(1);
      if (taken) return refuse(err("This month’s tasks are already in your to-dos", "conflict"));
      const mine = await tx.select().from(hrmsTaskTemplates).where(eq(hrmsTaskTemplates.employeeId, me.id)).orderBy(asc(hrmsTaskTemplates.serial));
      const tk = monthlyTemplates(mine);
      if (!tk.length) return refuse(err("You have no monthly tasks", "rule_violation"));
      await tx.insert(hrmsTodos).values(
        tk.map((x) => {
          const d = monthlyTodoDates(m, x.dayOfMonth, x.beforeDay);
          return {
            id: hrmsId("htd"),
            forDate: d.forDate,
            tillDate: d.tillDate,
            fromEmployeeId: null,
            fromLabel: "Monthly Task",
            toEmployeeId: me.id,
            category: x.category,
            task: x.task,
            urgent: isUrgentCategory(x.category),
            monthlyKey: m,
            templateId: x.id,
            createdById: ctx.user.id,
          };
        }),
      );
      const out: ToolResult = { navigate: hrmsLink("todos") };
      return ok(out, `${tk.length} monthly task${tk.length > 1 ? "s" : ""} added to your to-dos`);
    });
    if (res.ok) await hrmsAudit(ctx, "hrms.tasks.takeMonthly", "hrms_todos", null, null, { employee: me.code, month: m });
    return res;
  },

  /** Spec §13.5: today's message, to copy or to open in WhatsApp for the configured number. */
  async eod(ctx) {
    const me = ctx.employee;
    if (!me) return err(NOT_LINKED, "not_permitted");
    const t = today();
    const [cl, td, cfg] = await Promise.all([
      db
        .select()
        .from(hrmsChecklist)
        .where(and(eq(hrmsChecklist.employeeId, me.id), eq(hrmsChecklist.date, t)))
        .orderBy(asc(hrmsChecklist.startTime)),
      db
        .select()
        .from(hrmsTodos)
        .where(and(eq(hrmsTodos.toEmployeeId, me.id), eq(hrmsTodos.status, "Open"))),
      getConfig(),
    ]);
    const msg = taskEodMessage({ name: me.name, employeeId: me.id, today: t, checklist: cl, todos: td });
    const digits = waDigits(cfg["hrms.tasks.eodWhatsappNumber"] ?? "");
    const out: ToolResult = {
      dialog: {
        title: "Task EOD",
        sub: !cl.length
          ? "Your checklist for today is empty. Take my task first, then send the EOD."
          : digits
            ? `To +${digits}`
            : "No WhatsApp number is set for the Task EOD — copy it instead.",
        text: msg,
        copy: true,
        open: digits ? { label: "Open WhatsApp", href: `https://wa.me/${digits}?text=${encodeURIComponent(msg)}` } : undefined,
      },
    };
    return ok(out);
  },
};

/* ============================================================ templates */

const TEMPLATE_COLS: ColSpec[] = [
  { k: "emp", l: "Employee", t: "b" },
  { k: "task", l: "Task", t: "t" },
  { k: "freq", l: "Frequency", t: "s" },
  { k: "weekdays", l: "Weekdays", t: "t" },
  { k: "dom", l: "Day of month", t: "n" },
  { k: "before", l: "Before", t: "n" },
  { k: "category", l: "Category", t: "t" },
  { k: "start", l: "Start", t: "t" },
  { k: "end", l: "End", t: "t" },
  { k: "f", l: "", t: "f" },
];

function templateFields(ctx: HrmsContext, people: Person[]): FieldSpec[] {
  const admin = taskAdmin(ctx);
  const me = ctx.employee;
  const choices = admin ? people.filter(isActive) : me ? people.filter((p) => p.id === me.id) : [];
  return [
    {
      k: "emp",
      l: "Employee",
      t: "select",
      req: true,
      opts: choices.map(personOption),
      def: me ? `${me.name} · ${me.code}` : undefined,
      hint: admin ? undefined : "You add templates for yourself.",
    },
    { k: "task", l: "Task", t: "area", req: true },
    { k: "freq", l: "Frequency", t: "select", req: true, opts: [...FREQUENCIES], def: "Daily" },
    { k: "weekdays", l: "Weekdays", t: "multi", opts: [...WEEKDAYS], when: { k: "freq", in: ["Daily", "Weekly"] }, hint: "A daily task with none picked runs every day." },
    { k: "category", l: "Category", t: "select", req: true, opts: [...TASK_CATEGORIES], when: { k: "freq", eq: "Monthly" } },
    { k: "dom", l: "Day of month", t: "num", req: true, min: 1, max: 31, when: { k: "freq", eq: "Monthly" }, hint: "A day the month does not have lands on its last day." },
    { k: "before", l: "Complete before (day)", t: "num", min: 1, max: 31, when: { k: "freq", eq: "Monthly" } },
    { k: "start", l: "Start time", t: "time", def: "10:00" },
    { k: "end", l: "End time", t: "time", def: "10:30" },
  ];
}

function templateForm(ctx: HrmsContext, people: Person[], init?: Record<string, string>, recordId?: string): FormSpec | undefined {
  if (!ctx.employee && !taskAdmin(ctx)) return undefined;
  return {
    screen: "templates",
    id: "template",
    title: recordId ? "Edit task template" : "Add a task template",
    sub: "Daily and weekly tasks run on the weekdays you pick; monthly tasks land in to-dos.",
    submit: "Save template",
    header: templateFields(ctx, people),
    init,
    recordId,
  };
}

function templateInit(r: Template, p: Person | undefined): Record<string, string> {
  return {
    emp: p ? personOption(p) : "",
    task: r.task,
    freq: r.frequency,
    weekdays: r.weekdays.join("|"),
    category: r.category ?? "",
    dom: r.dayOfMonth == null ? "" : String(r.dayOfMonth),
    before: r.beforeDay == null ? "" : String(r.beforeDay),
    start: r.startTime ?? "",
    end: r.endTime ?? "",
  };
}

function templateRow(ctx: HrmsContext, r: Template, p: Person | undefined, people: Person[]): ListRow {
  const own = r.employeeId === ctx.employee?.id;
  const admin = taskAdmin(ctx);
  const actions: ActionSpec[] = [];
  /* Add more copies the row into a fresh form, task left blank: the next task for the same person and rhythm. */
  const copy = templateForm(ctx, people, { ...templateInit(r, p), task: "" });
  if (copy) actions.push({ id: "addMore", l: "Add more", primary: true, form: copy, why: own || admin ? undefined : "Only tasks admin adds templates for somebody else" });
  actions.push({ id: "edit", l: "Edit", loadsForm: true, why: admin ? undefined : "Only tasks admin edits a template" });
  actions.push({ id: "delete", l: "Delete", confirm: `Delete the template “${r.task}”?`, why: admin ? undefined : "Only tasks admin deletes a template" });
  return {
    id: r.id,
    v: {
      emp: p?.name ?? "",
      task: r.task,
      freq: r.frequency,
      weekdays: r.frequency === "Monthly" ? "" : r.weekdays.length === 7 ? "Every day" : r.weekdays.map((d) => d.slice(0, 3)).join(", "),
      dom: r.dayOfMonth,
      before: r.beforeDay,
      category: r.category ?? "",
      start: r.startTime ?? "",
      end: r.endTime ?? "",
      office: p?.office ?? "",
    },
    flags: own ? ["mine"] : [],
    title: r.task,
    header: `${p?.name ?? ""} · ${r.frequency}${r.frequency === "Monthly" ? ` · day ${r.dayOfMonth ?? ""}` : ""}`,
    fields: [
      { l: "Serial", v: String(r.serial) },
      { l: "Employee ID", v: p?.code ?? "" },
      { l: "Office", v: p?.office ?? "" },
    ],
    actions,
    by: stampLine(null, r.createdAt),
  };
}

const templates: HrmsScreenModule = {
  key: "templates",
  async load(ctx, q) {
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "tasksAdmin");
    const ids = visibleIds(ctx, scope, people);
    const where = ids ? (ids.size ? inArray(hrmsTaskTemplates.employeeId, [...ids]) : sql`false`) : undefined;
    const rows = await db.select().from(hrmsTaskTemplates).where(where).orderBy(asc(hrmsTaskTemplates.serial));
    const pb = byId(people);
    return {
      spec: {
        screen: "templates",
        cols: TEMPLATE_COLS,
        hidden: [],
        groups: ["emp"],
        sortDefault: ["emp", 1],
        godownKey: "office",
        newForm: templateForm(ctx, people),
        newLabel: "Add template",
        tools: [takeTaskTool(ctx), takeMonthlyTool(ctx), eodTool(ctx)],
        noDataLine: "No task templates yet. Add one, then Take my task copies today’s into your checklist.",
        hrms: { scope: { current: scope, options } },
      },
      rows: rows.map((r) => templateRow(ctx, r, pb.get(r.employeeId), people)),
    };
  },
  formLoaders: {
    async edit(ctx, id) {
      if (!taskAdmin(ctx)) return null;
      const [r] = await db.select().from(hrmsTaskTemplates).where(eq(hrmsTaskTemplates.id, id));
      if (!r) return null;
      const people = await allPeople();
      return templateForm(ctx, people, templateInit(r, byId(people).get(r.employeeId)), r.id) ?? null;
    },
  },
  forms: {
    async template(ctx, h, _lines, recordId) {
      const admin = taskAdmin(ctx);
      if (recordId && !admin) return err("Only tasks admin edits a template", "not_permitted");
      const people = await allPeople();
      const p = personFrom(h.emp, people);
      if (!p) return fieldErr("emp", "invalid Name");
      if (!admin && p.id !== ctx.employee?.id) return err("Only tasks admin adds templates for somebody else", "not_permitted");
      if (!recordId && !isActive(p)) return fieldErr("emp", "invalid Name");
      const task = text(h.task);
      if (!task) return fieldErr("task", "Task is required");
      const frequency = String(h.freq ?? "");
      const monthly = frequency === "Monthly";
      const input = {
        frequency,
        weekdays: multi(h.weekdays),
        category: monthly ? text(h.category) : null,
        dayOfMonth: monthly ? int(h.dom) : null,
        beforeDay: monthly ? int(h.before) : null,
        startTime: text(h.start),
        endTime: text(h.end),
      };
      if (monthly && !input.category) return fieldErr("category", "Category is required");
      const bad = checkTemplate(input);
      if (bad) return fieldErr(bad.field, bad.message);
      const values = { ...input, employeeId: p.id, task, weekdays: storedWeekdays(frequency, input.weekdays) };
      if (recordId) {
        const [before] = await db.select().from(hrmsTaskTemplates).where(eq(hrmsTaskTemplates.id, recordId));
        if (!before) return err("That template no longer exists.", "not_found");
        await db
          .update(hrmsTaskTemplates)
          .set({ ...values, updatedAt: new Date(), updatedById: ctx.user.id })
          .where(eq(hrmsTaskTemplates.id, recordId));
        await hrmsAudit(ctx, "hrms.tasks.template.edit", "hrms_task_templates", recordId, before, values);
        return okVoid("Template saved");
      }
      const id = hrmsId("htt");
      const res = await inTx(async (tx) => {
        const serial = await nextSeries(tx, "template");
        await tx.insert(hrmsTaskTemplates).values({ id, serial, ...values, createdById: ctx.user.id });
        return okVoid(`Template added for ${p.name}`);
      });
      if (res.ok) await hrmsAudit(ctx, "hrms.tasks.template.add", "hrms_task_templates", id, null, { employee: p.code, ...values });
      return res;
    },
  },
  actions: {
    async delete(ctx, id) {
      if (!taskAdmin(ctx)) return err("Only tasks admin deletes a template", "not_permitted");
      const [r] = await db.select().from(hrmsTaskTemplates).where(eq(hrmsTaskTemplates.id, id));
      if (!r) return err("That template no longer exists.", "not_found");
      await db.delete(hrmsTaskTemplates).where(eq(hrmsTaskTemplates.id, id));
      await hrmsAudit(ctx, "hrms.tasks.template.delete", "hrms_task_templates", id, r, null);
      return okVoid("Template deleted");
    },
  },
  tools: TOOLS,
};

/* ============================================================ checklist */

const CHECKLIST_COLS: ColSpec[] = [
  { k: "date", l: "Date", t: "d" },
  { k: "emp", l: "Employee", t: "b" },
  { k: "task", l: "Task", t: "t" },
  { k: "status", l: "Status", t: "s" },
  { k: "start", l: "Start", t: "t" },
  { k: "end", l: "End", t: "t" },
  { k: "working", l: "Working time", t: "t" },
  { k: "remark", l: "Remark", t: "t" },
  { k: "f", l: "Flags", t: "f" },
];

/** A blank status is still to do today, and was not done on any day before. */
const statusLabel = (r: Checklist, t: string) => (checklistOpen(r.status) ? (r.date === t ? "Pending" : "Not done") : r.status);

function checklistActions(ctx: HrmsContext, r: Checklist, t: string): ActionSpec[] {
  const own = r.employeeId === ctx.employee?.id;
  const isToday = r.date === t;
  const a: ActionSpec[] = [];
  if (own && r.status !== "Done")
    a.push({ id: "done", l: "Done", primary: true, confirm: "Are You Sure! Your Task Is Done", why: isToday ? undefined : expiredMessage(r.task, r.date) });
  if (own && isToday && (r.status === "Done" || r.status === "N/A")) a.push({ id: "notDone", l: "Not done" });
  if (own && isToday && checklistOpen(r.status))
    a.push({
      id: "na",
      l: "N/A",
      prompt: { title: "Not applicable today", sub: r.task, submit: "Mark N/A", fields: [{ k: "reason", l: "Remark / Not Applicable Reason", t: "area", req: true, mic: true }] },
    });
  if (own || taskAdmin(ctx))
    a.push({
      id: "remark",
      l: "Write remark",
      prompt: { title: "Remark", sub: r.task, submit: "Save remark", init: { remark: r.remark ?? "" }, fields: [{ k: "remark", l: "Remark", t: "area", req: true, mic: true }] },
    });
  if (taskAdmin(ctx)) a.push({ id: "delete", l: "Delete", confirm: `Delete “${r.task}” from the checklist of ${fdShort(r.date)}?` });
  return a;
}

function checklistRow(ctx: HrmsContext, r: Checklist, p: Person | undefined, t: string): ListRow {
  const bucket = checklistBucket(r.date, r.status, t);
  const diff = timeDifference(r.workingTime, r.endTime);
  const flags: string[] = [];
  if (r.status === "Done") flags.push("done");
  if (bucket === "Not done this week") flags.push("blank");
  if (r.status === "N/A") flags.push("naReason");
  const fields: RowField[] = [
    { l: "Frequency", v: r.frequency ?? "" },
    { l: "Day", v: r.weekday ?? weekdayOf(r.date) },
    { l: "Working time", v: r.workingTime ?? "—" },
  ];
  /* Spec §13.2: the difference is shown only where the task has an end time to measure against. */
  if (r.endTime) fields.push({ l: "Time difference", v: diff == null ? "—" : `${diff > 0 ? "+" : ""}${hm(diff)}`, der: true });
  fields.push({ l: "Not applicable reason", v: r.naReason ?? "" }, { l: "Remark", v: r.remark ?? "" }, { l: "Office", v: p?.office ?? "" }, { l: "Marked at", v: when(r.stampedAt) });
  return {
    id: r.id,
    v: {
      date: r.date,
      emp: p?.name ?? "",
      task: r.task,
      status: statusLabel(r, t),
      start: r.startTime ?? "",
      end: r.endTime ?? "",
      working: r.workingTime ?? "",
      remark: r.remark ?? r.naReason ?? "",
      bucket,
      office: p?.office ?? "",
    },
    flags,
    title: r.task,
    header: `${p?.name ?? ""} · ${fdShort(r.date)} · ${statusLabel(r, t)}`,
    fields,
    actions: checklistActions(ctx, r, t),
    by: stampLine(null, r.createdAt),
  };
}

/** A checklist item the signed-in person may still tick today, or why not. */
async function ownTodayItem(ctx: HrmsContext, id: string): Promise<{ row: Checklist } | { refusal: Err }> {
  const [r] = await db.select().from(hrmsChecklist).where(eq(hrmsChecklist.id, id));
  if (!r) return { refusal: err("That task no longer exists.", "not_found") };
  if (r.employeeId !== ctx.employee?.id) return { refusal: err("That task is not yours.", "not_permitted") };
  if (r.date !== today()) return { refusal: err(expiredMessage(r.task, r.date), "rule_violation") };
  return { row: r };
}

const checklist: HrmsScreenModule = {
  key: "checklist",
  async load(ctx, q) {
    const t = today();
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "tasksAdmin");
    const ids = visibleIds(ctx, scope, people);
    const from = isISO(q.from) ? q.from : addDaysISO(t, -30);
    const where: SQL[] = [gte(hrmsChecklist.date, from)];
    if (isISO(q.to)) where.push(lte(hrmsChecklist.date, q.to));
    if (ids) where.push(ids.size ? inArray(hrmsChecklist.employeeId, [...ids]) : sql`false`);
    const rows = await db
      .select()
      .from(hrmsChecklist)
      .where(and(...where))
      .orderBy(desc(hrmsChecklist.date), asc(hrmsChecklist.startTime));
    const pb = byId(people);
    const me = ctx.employee;
    const takenToday = !!me && rows.some((r) => r.employeeId === me.id && r.date === t);
    const [hasTemplates] =
      me && !takenToday ? await db.select({ id: hrmsTaskTemplates.id }).from(hrmsTaskTemplates).where(eq(hrmsTaskTemplates.employeeId, me.id)).limit(1) : [];
    return {
      spec: {
        screen: "checklist",
        cols: CHECKLIST_COLS,
        hidden: [],
        groups: ["date", "emp"],
        chips: "bucket",
        sortDefault: ["date", -1],
        godownKey: "office",
        bulk: [{ id: "clDone", l: "Mark done" }],
        tools: [takeTaskTool(ctx), eodTool(ctx)],
        noDataLine: "No checklist items in this window. Take my task copies today’s tasks from your templates.",
        hrms: {
          scope: { current: scope, options },
          period: { label: "", params: [{ k: "from", l: "From", v: from, type: "date" }] },
          ...(hasTemplates ? { notice: { text: "Today’s tasks are not in your checklist yet — Take my task copies them in", tone: "warn" as const } } : {}),
        },
      },
      rows: rows.map((r) => checklistRow(ctx, r, pb.get(r.employeeId), t)),
    };
  },
  actions: {
    async done(ctx, id) {
      const got = await ownTodayItem(ctx, id);
      if ("refusal" in got) return got.refusal;
      if (got.row.status === "Done") return err("Already done.");
      const at = now();
      await db
        .update(hrmsChecklist)
        .set({ status: "Done", workingTime: at, stampedAt: new Date(), naReason: null, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsChecklist.id, id));
      await hrmsAudit(ctx, "hrms.tasks.checklist.done", "hrms_checklist", id, { status: got.row.status }, { status: "Done", workingTime: at });
      return okVoid(`Done · ${got.row.task}`);
    },
    async notDone(ctx, id) {
      const got = await ownTodayItem(ctx, id);
      if ("refusal" in got) return got.refusal;
      if (checklistOpen(got.row.status)) return err("It is not marked yet.");
      await db
        .update(hrmsChecklist)
        .set({ status: "", workingTime: null, stampedAt: null, naReason: null, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsChecklist.id, id));
      await hrmsAudit(ctx, "hrms.tasks.checklist.notDone", "hrms_checklist", id, { status: got.row.status }, { status: "" });
      return okVoid("Marked not done");
    },
    async na(ctx, id, v) {
      const got = await ownTodayItem(ctx, id);
      if ("refusal" in got) return got.refusal;
      if (!checklistOpen(got.row.status)) return err("Mark it not done first.");
      const reason = text(v.reason);
      if (!reason) return fieldErr("reason", "Remark / Not Applicable Reason is required");
      const at = now();
      await db
        .update(hrmsChecklist)
        .set({ status: "N/A", naReason: reason, workingTime: at, stampedAt: new Date(), updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsChecklist.id, id));
      await hrmsAudit(ctx, "hrms.tasks.checklist.na", "hrms_checklist", id, { status: got.row.status }, { status: "N/A", naReason: reason });
      return okVoid("Marked not applicable");
    },
    async remark(ctx, id, v) {
      const [r] = await db.select().from(hrmsChecklist).where(eq(hrmsChecklist.id, id));
      if (!r) return err("That task no longer exists.", "not_found");
      if (!(r.employeeId === ctx.employee?.id || taskAdmin(ctx))) return err("Not yours to remark on.", "not_permitted");
      const remark = text(v.remark);
      if (!remark) return fieldErr("remark", "Remark is required");
      await db.update(hrmsChecklist).set({ remark, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsChecklist.id, id));
      await hrmsAudit(ctx, "hrms.tasks.checklist.remark", "hrms_checklist", id, { remark: r.remark }, { remark });
      return okVoid("Remark saved");
    },
    async delete(ctx, id) {
      if (!taskAdmin(ctx)) return err("Only tasks admin deletes a checklist item", "not_permitted");
      const [r] = await db.select().from(hrmsChecklist).where(eq(hrmsChecklist.id, id));
      if (!r) return err("That task no longer exists.", "not_found");
      await db.delete(hrmsChecklist).where(eq(hrmsChecklist.id, id));
      await hrmsAudit(ctx, "hrms.tasks.checklist.delete", "hrms_checklist", id, r, null);
      return okVoid("Removed from the checklist");
    },
  },
  bulk: {
    /** Only today's own items that are not done yet; the rest are counted, never touched. */
    async clDone(ctx, ids) {
      const me = ctx.employee;
      if (!me) return err(NOT_LINKED, "not_permitted");
      if (!ids.length) return err("Nothing selected.");
      const t = today();
      const rows = await db.select().from(hrmsChecklist).where(inArray(hrmsChecklist.id, ids));
      const mine = rows.filter((r) => r.employeeId === me.id && r.date === t && r.status !== "Done");
      if (mine.length) {
        const at = now();
        await db
          .update(hrmsChecklist)
          .set({ status: "Done", workingTime: at, stampedAt: new Date(), naReason: null, updatedAt: new Date(), updatedById: ctx.user.id })
          .where(inArray(hrmsChecklist.id, mine.map((r) => r.id)));
        await hrmsAudit(ctx, "hrms.tasks.checklist.bulkDone", "hrms_checklist", null, null, { ids: mine.map((r) => r.id), workingTime: at });
      }
      const rest = ids.length - mine.length;
      return okVoid(`${mine.length} marked done${rest ? ` · ${rest} were not today’s, not yours or already done` : ""}`);
    },
  },
  tools: { takeTask: TOOLS.takeTask, eod: TOOLS.eod },
};

/* =============================================================== to-dos */

const TODO_COLS: ColSpec[] = [
  { k: "forDate", l: "For", t: "d" },
  { k: "tillDate", l: "Till", t: "d" },
  { k: "from", l: "From", t: "t" },
  { k: "to", l: "To", t: "t" },
  { k: "task", l: "Task", t: "b" },
  { k: "category", l: "Category", t: "t" },
  { k: "status", l: "Status", t: "s" },
  { k: "recheck", l: "Recheck", t: "s" },
  { k: "daysTaken", l: "Days taken", t: "n" },
  { k: "f", l: "Flags", t: "f" },
];

/**
 * Who gave a to-do. A Monthly Task copy has no giver — the person took it from
 * their own template — so its assignee stands in: otherwise nobody but tasks
 * admin could ever verify it or send it back.
 */
const assignerOf = (r: Todo): string | null => r.fromEmployeeId ?? (r.fromLabel === "Monthly Task" ? r.toEmployeeId : null);

function todoActions(ctx: HrmsContext, r: Todo, t: string): ActionSpec[] {
  const me = ctx.employee?.id;
  const assigner = !!me && assignerOf(r) === me;
  const assignee = !!me && r.toEmployeeId === me;
  const party = assigner || assignee;
  const admin = taskAdmin(ctx);
  const a: ActionSpec[] = [];
  if (r.status === "Open" && party)
    a.push({
      id: "done",
      l: "Done",
      primary: true,
      confirm: "Are You Sure! Your Task Is Done",
      why: r.tillDate && todoExpired(r.tillDate, t) ? expiredMessage(r.task, r.tillDate) : undefined,
    });
  if (r.status === "Done" && r.recheck !== "Verified" && party) a.push({ id: "notDone", l: "Not done" });
  if (r.status === "Done" && r.recheck !== "Verified" && (assigner || admin)) a.push({ id: "verify", l: "Verified", primary: true });
  if (r.status === "Done" && (party || admin))
    a.push({
      id: "pending",
      l: "Pending",
      why: assigner ? undefined : "Only the person who gave it sends it back",
      prompt: { title: "Send back as pending", sub: r.task, submit: "Send back", fields: [{ k: "remark", l: "What is still missing", t: "area", req: true, mic: true }] },
    });
  if (party || admin)
    a.push({
      id: "remark",
      l: "Write remark",
      prompt: { title: "Remark", sub: r.task, submit: "Save remark", init: { remark: r.remark ?? "" }, fields: [{ k: "remark", l: "Remark", t: "area", req: true, mic: true }] },
    });
  if (assigner || admin) a.push({ id: "delete", l: "Delete", confirm: `Delete the to-do “${r.task}”?` });
  return a;
}

function todoRow(ctx: HrmsContext, r: Todo, pb: Map<string, Person>, t: string, avg: number | null): ListRow {
  const me = ctx.employee?.id;
  const to = pb.get(r.toEmployeeId);
  const from = r.fromEmployeeId ? (pb.get(r.fromEmployeeId)?.name ?? r.fromLabel) : r.fromLabel;
  const flags: string[] = [];
  if (me && r.toEmployeeId === me) flags.push("toMe");
  else if (me && r.fromEmployeeId === me) flags.push("byMe");
  if (r.urgent) flags.push("urgent");
  if (todoOverdue(r, t)) flags.push("overdue");
  if (r.status === "Done") flags.push("done");
  const taken = daysTaken(r.forDate, r.doneOn);
  return {
    id: r.id,
    v: {
      forDate: r.forDate,
      tillDate: r.tillDate ?? "",
      from,
      to: to?.name ?? "",
      task: r.task,
      category: r.category ?? "",
      status: r.status,
      recheck: r.recheck,
      daysTaken: taken,
      tab: todoTab(r.status, r.recheck),
      office: to?.office ?? "",
    },
    flags,
    title: r.task,
    header: `${from} → ${to?.name ?? ""} · for ${fdShort(r.forDate)}${r.tillDate ? ` · till ${fdShort(r.tillDate)}` : ""}`,
    fields: [
      { l: "Days given", v: String(daysGiven(r.forDate, r.tillDate)), der: true },
      { l: "Days taken", v: taken == null ? "Not done yet" : String(taken), der: true },
      { l: "Average days taken that month", v: avg == null ? "—" : String(avg), der: true },
      { l: "Urgent and important", v: r.urgent ? "Yes" : "No" },
      { l: "Remark", v: r.remark ?? "" },
      { l: "Done at", v: when(r.doneAt) },
      { l: "Office", v: to?.office ?? "" },
    ],
    actions: todoActions(ctx, r, t),
    by: stampLine(r.fromLabel, r.createdAt),
  };
}

function todoForm(ctx: HrmsContext, people: Person[], t: string): FormSpec | undefined {
  if (!ctx.employee && !taskAdmin(ctx)) return undefined;
  return {
    screen: "todos",
    id: "assign",
    title: "Assign to-do",
    sub: "The person gets it in their to-dos; you verify it once they mark it done.",
    submit: "Assign to-do",
    init: { forDate: t },
    header: [
      { k: "to", l: "Assign to", t: "select", req: true, opts: people.filter(isActive).map(personOption) },
      { k: "forDate", l: "For date", t: "date", req: true, def: t },
      { k: "tillDate", l: "Till date", t: "date", hint: "Marking it done is refused after this date." },
      { k: "category", l: "Category", t: "select", req: true, opts: [...TASK_CATEGORIES] },
      { k: "task", l: "Task", t: "area", req: true, mic: true },
      { k: "remark", l: "Remark", t: "area", mic: true },
    ],
  };
}

async function todoFor(id: string): Promise<Todo | undefined> {
  const [r] = await db.select().from(hrmsTodos).where(eq(hrmsTodos.id, id));
  return r;
}

const todos: HrmsScreenModule = {
  key: "todos",
  async load(ctx, q) {
    const t = today();
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "tasksAdmin");
    const ids = visibleIds(ctx, scope, people);
    const list = ids ? [...ids] : null;
    /* A to-do belongs to both ends: the person given it and the person who gave it. */
    const where = list ? (list.length ? or(inArray(hrmsTodos.toEmployeeId, list), inArray(hrmsTodos.fromEmployeeId, list)) : sql`false`) : undefined;
    const rows = await db.select().from(hrmsTodos).where(where).orderBy(asc(hrmsTodos.forDate));
    const assignees = [...new Set(rows.filter((r) => r.doneOn).map((r) => r.toEmployeeId))];
    const doneAll = assignees.length
      ? await db
          .select({ toEmployeeId: hrmsTodos.toEmployeeId, forDate: hrmsTodos.forDate, doneOn: hrmsTodos.doneOn })
          .from(hrmsTodos)
          .where(and(inArray(hrmsTodos.toEmployeeId, assignees), isNotNull(hrmsTodos.doneOn)))
      : [];
    const pb = byId(people);
    const me = ctx.employee;
    const myOverdue = me ? rows.filter((r) => r.toEmployeeId === me.id && todoOverdue(r, t)).length : 0;
    return {
      spec: {
        screen: "todos",
        cols: TODO_COLS,
        hidden: [],
        groups: ["from"],
        chips: "tab",
        sortDefault: ["forDate", 1],
        godownKey: "office",
        newForm: todoForm(ctx, people, t),
        newLabel: "Assign to-do",
        noDataLine: "No to-dos given to you or by you.",
        hrms: {
          scope: { current: scope, options },
          ...(myOverdue ? { notice: { text: `${myOverdue} of your to-dos ${myOverdue > 1 ? "are" : "is"} overdue`, tone: "danger" as const } } : {}),
        },
      },
      rows: rows.map((r) => todoRow(ctx, r, pb, t, r.doneOn ? averageDaysTaken(doneAll, r.toEmployeeId, monthOf(r.doneOn)) : null)),
    };
  },
  forms: {
    async assign(ctx, h) {
      if (!ctx.employee && !taskAdmin(ctx)) return err(NOT_LINKED, "not_permitted");
      const people = await allPeople();
      const p = personFrom(h.to, people);
      if (!p || !isActive(p)) return fieldErr("to", "invalid Name");
      const forDate = text(h.forDate);
      if (!isISO(forDate)) return fieldErr("forDate", "INVALID");
      const tillDate = text(h.tillDate);
      if (tillDate && !isISO(tillDate)) return fieldErr("tillDate", "INVALID");
      if (tillDate && tillDate <= forDate) return fieldErr("tillDate", "Before Date should Be Greater Than For Date!");
      const category = text(h.category);
      if (!category || !(TASK_CATEGORIES as readonly string[]).includes(category)) return fieldErr("category", "Category is required");
      const task = text(h.task);
      if (!task) return fieldErr("task", "Task is required");
      const id = hrmsId("htd");
      const fromLabel = ctx.employee?.name ?? ctx.user.name;
      const values = {
        id,
        forDate,
        tillDate,
        fromEmployeeId: ctx.employee?.id ?? null,
        fromLabel,
        toEmployeeId: p.id,
        category,
        task,
        urgent: isUrgentCategory(category),
        remark: text(h.remark),
        createdById: ctx.user.id,
      };
      await db.insert(hrmsTodos).values(values);
      await hrmsAudit(ctx, "hrms.tasks.todo.assign", "hrms_todos", id, null, { ...values, to: p.code });
      /* §18.5: the assignee is told; giving yourself a to-do tells nobody. */
      if (p.id !== ctx.employee?.id)
        await notifyEmployees([p.id], "A to-do was assigned to you", `${fromLabel}: ${task}${tillDate ? ` · till ${fdShort(tillDate)}` : ""}`, hrmsLink("todos"));
      return okVoid(`To-do assigned to ${p.name}`);
    },
  },
  actions: {
    async done(ctx, id) {
      const r = await todoFor(id);
      if (!r) return err("That to-do no longer exists.", "not_found");
      const me = ctx.employee?.id;
      if (!me || (r.toEmployeeId !== me && assignerOf(r) !== me)) return err("Only the person it was given to, or who gave it, marks it done.", "not_permitted");
      if (r.status !== "Open") return err("Already done.");
      const t = today();
      if (r.tillDate && todoExpired(r.tillDate, t)) return err(expiredMessage(r.task, r.tillDate), "rule_violation");
      await db
        .update(hrmsTodos)
        .set({ status: "Done", recheck: "", doneAt: new Date(), doneOn: t, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsTodos.id, id));
      await hrmsAudit(ctx, "hrms.tasks.todo.done", "hrms_todos", id, { status: r.status }, { status: "Done", doneOn: t });
      return okVoid(r.fromEmployeeId && r.fromEmployeeId !== me ? `Done · ${first(r.fromLabel)} verifies it` : "Done");
    },
    async notDone(ctx, id) {
      const r = await todoFor(id);
      if (!r) return err("That to-do no longer exists.", "not_found");
      const me = ctx.employee?.id;
      if (!me || (r.toEmployeeId !== me && assignerOf(r) !== me)) return err("Only the person it was given to, or who gave it, changes it.", "not_permitted");
      if (r.status !== "Done") return err("It is not done yet.");
      if (r.recheck === "Verified") return err("It is already verified.");
      await db
        .update(hrmsTodos)
        .set({ status: "Open", recheck: "", doneAt: null, doneOn: null, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsTodos.id, id));
      await hrmsAudit(ctx, "hrms.tasks.todo.notDone", "hrms_todos", id, { status: "Done" }, { status: "Open" });
      return okVoid("Back to open");
    },
    async verify(ctx, id) {
      const r = await todoFor(id);
      if (!r) return err("That to-do no longer exists.", "not_found");
      if (!(assignerOf(r) === ctx.employee?.id || taskAdmin(ctx))) return err("Only the person who gave it, or tasks admin, verifies it.", "not_permitted");
      if (r.status !== "Done") return err("It is not done yet.");
      if (r.recheck === "Verified") return err("Already verified.");
      await db.update(hrmsTodos).set({ recheck: "Verified", updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsTodos.id, id));
      await hrmsAudit(ctx, "hrms.tasks.todo.verify", "hrms_todos", id, { recheck: r.recheck }, { recheck: "Verified" });
      return okVoid("Verified");
    },
    /** Sent back: the work is not finished, so it is open again with what is missing written on it. */
    async pending(ctx, id, v) {
      const r = await todoFor(id);
      if (!r) return err("That to-do no longer exists.", "not_found");
      const me = ctx.employee;
      if (!me || assignerOf(r) !== me.id) return err("Only the person who gave it sends it back", "not_permitted");
      if (r.status !== "Done") return err("It is not done yet.");
      const remark = text(v.remark);
      if (!remark) return fieldErr("remark", "What is still missing is required");
      await db
        .update(hrmsTodos)
        .set({ status: "Open", recheck: "Pending", doneAt: null, doneOn: null, remark, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsTodos.id, id));
      await hrmsAudit(ctx, "hrms.tasks.todo.pending", "hrms_todos", id, { status: r.status, recheck: r.recheck }, { status: "Open", recheck: "Pending", remark });
      if (r.toEmployeeId !== me.id) await notifyEmployees([r.toEmployeeId], "A to-do was sent back", `${r.task} — ${remark}`, hrmsLink("todos"));
      const to = byId(await allPeople()).get(r.toEmployeeId);
      return okVoid(`Sent back to ${first(to?.name)}`);
    },
    async remark(ctx, id, v) {
      const r = await todoFor(id);
      if (!r) return err("That to-do no longer exists.", "not_found");
      const me = ctx.employee?.id;
      if (!((me && (r.toEmployeeId === me || assignerOf(r) === me)) || taskAdmin(ctx))) return err("Not yours to remark on.", "not_permitted");
      const remark = text(v.remark);
      if (!remark) return fieldErr("remark", "Remark is required");
      await db.update(hrmsTodos).set({ remark, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsTodos.id, id));
      await hrmsAudit(ctx, "hrms.tasks.todo.remark", "hrms_todos", id, { remark: r.remark }, { remark });
      return okVoid("Remark saved");
    },
    async delete(ctx, id) {
      const r = await todoFor(id);
      if (!r) return err("That to-do no longer exists.", "not_found");
      if (!(assignerOf(r) === ctx.employee?.id || taskAdmin(ctx))) return err("Only admin or the person who gave it deletes a to-do", "not_permitted");
      await db.delete(hrmsTodos).where(eq(hrmsTodos.id, id));
      await hrmsAudit(ctx, "hrms.tasks.todo.delete", "hrms_todos", id, r, null);
      return okVoid("To-do deleted");
    },
  },
};

/* ================================================================ buddy */

const BUDDY_COLS: ColSpec[] = [
  { k: "date", l: "Date", t: "d" },
  { k: "from", l: "From", t: "t" },
  { k: "to", l: "To", t: "b" },
  { k: "task", l: "Task", t: "t" },
  { k: "status", l: "Status", t: "s" },
  { k: "note", l: "Note", t: "t" },
];

function buddyRow(ctx: HrmsContext, r: Buddy, pb: Map<string, Person>, t: string): ListRow {
  const me = ctx.employee?.id;
  const from = pb.get(r.fromEmployeeId);
  const to = pb.get(r.toEmployeeId);
  const isBuddy = !!me && r.toEmployeeId === me;
  const sender = !!me && r.fromEmployeeId === me;
  const actions: ActionSpec[] = [];
  if (r.status === "Shared" && isBuddy) actions.push({ id: "accept", l: "Accept", primary: true });
  if (r.status === "Accepted" && isBuddy) actions.push({ id: "done", l: "Task done", primary: true, confirm: "Are You Sure! Your Task Is Done" });
  if (sender || taskAdmin(ctx)) actions.push({ id: "delete", l: "Delete", confirm: `Delete the shared task “${r.task}”?` });
  const flags: string[] = [];
  if (isBuddy) flags.push("toMe");
  else if (sender) flags.push("byMe");
  if (r.status === "Task done") flags.push("done");
  return {
    id: r.id,
    v: {
      date: r.date,
      from: from?.name ?? "",
      to: to?.name ?? "",
      task: r.task,
      status: r.status,
      note: r.note ?? "",
      tab: isBuddy && r.date === t ? "Shared with me today" : r.date === t ? "Today" : "Earlier",
      office: to?.office ?? "",
    },
    flags,
    title: r.task,
    header: `${from?.name ?? ""} → ${to?.name ?? ""} · ${fdShort(r.date)}`,
    fields: [
      { l: "Day", v: weekdayOf(r.date), der: true },
      { l: "Buddy status", v: r.status === "Shared" ? "Pending" : "Task Accepted" },
      { l: "Accepted at", v: when(r.acceptedAt) },
      { l: "Done at", v: when(r.doneAt) },
      { l: "Note", v: r.note ?? "" },
    ],
    actions,
    by: stampLine(from?.name, r.createdAt),
  };
}

async function shareForm(ctx: HrmsContext, people: Person[], t: string): Promise<FormSpec | undefined> {
  const me = ctx.employee;
  if (!me) return undefined;
  const [tpls, shared] = await Promise.all([
    db.select().from(hrmsTaskTemplates).where(eq(hrmsTaskTemplates.employeeId, me.id)).orderBy(asc(hrmsTaskTemplates.serial)),
    db
      .select({ task: hrmsBuddyTasks.task })
      .from(hrmsBuddyTasks)
      .where(and(eq(hrmsBuddyTasks.fromEmployeeId, me.id), eq(hrmsBuddyTasks.date, t))),
  ]);
  const suggested = buddySuggestions(tpls, t, shared.map((s) => s.task));
  /* Suggested, not imposed (spec §13.4): with nothing left to suggest, the task is written. */
  const taskField: FieldSpec = suggested.length
    ? { k: "task", l: "Task", t: "select", req: true, opts: suggested, hint: "Suggested from your templates for today." }
    : { k: "task", l: "Task", t: "area", req: true, hint: "None of your templates for today is left to share — write the task." };
  return {
    screen: "buddy",
    id: "share",
    title: "Share a task with a buddy",
    sub: "Your buddy accepts it, then marks it done.",
    submit: "Share task",
    header: [
      { k: "to", l: "Buddy", t: "select", req: true, opts: people.filter((p) => isActive(p) && p.id !== me.id).map(personOption) },
      taskField,
      { k: "note", l: "Note", t: "text" },
    ],
  };
}

async function buddyFor(id: string): Promise<Buddy | undefined> {
  const [r] = await db.select().from(hrmsBuddyTasks).where(eq(hrmsBuddyTasks.id, id));
  return r;
}

const buddy: HrmsScreenModule = {
  key: "buddy",
  async load(ctx, q) {
    const t = today();
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "tasksAdmin");
    const ids = visibleIds(ctx, scope, people);
    const list = ids ? [...ids] : null;
    const where = list ? (list.length ? or(inArray(hrmsBuddyTasks.toEmployeeId, list), inArray(hrmsBuddyTasks.fromEmployeeId, list)) : sql`false`) : undefined;
    const rows = await db.select().from(hrmsBuddyTasks).where(where).orderBy(desc(hrmsBuddyTasks.date));
    const pb = byId(people);
    return {
      spec: {
        screen: "buddy",
        cols: BUDDY_COLS,
        hidden: [],
        groups: ["date"],
        chips: "tab",
        sortDefault: ["date", -1],
        godownKey: "office",
        newForm: await shareForm(ctx, people, t),
        newLabel: "Share a task",
        noDataLine: "Nothing shared with you or by you yet.",
        hrms: { scope: { current: scope, options } },
      },
      rows: rows.map((r) => buddyRow(ctx, r, pb, t)),
    };
  },
  forms: {
    async share(ctx, h) {
      const me = ctx.employee;
      if (!me) return err(NOT_LINKED, "not_permitted");
      const people = await allPeople();
      const p = personFrom(h.to, people);
      if (!p || !isActive(p) || p.id === me.id) return fieldErr("to", "invalid Name");
      const task = text(h.task);
      if (!task) return fieldErr("task", "Task is required");
      const id = hrmsId("hbt");
      const values = { id, date: today(), fromEmployeeId: me.id, toEmployeeId: p.id, task, note: text(h.note), createdById: ctx.user.id };
      await db.insert(hrmsBuddyTasks).values(values);
      await hrmsAudit(ctx, "hrms.tasks.buddy.share", "hrms_buddy_tasks", id, null, { ...values, to: p.code });
      return okVoid(`Shared with ${first(p.name)}`);
    },
  },
  actions: {
    async accept(ctx, id) {
      const r = await buddyFor(id);
      if (!r) return err("That task no longer exists.", "not_found");
      if (r.toEmployeeId !== ctx.employee?.id) return err("Only the buddy accepts it.", "not_permitted");
      if (r.status !== "Shared") return err("Already accepted.");
      await db
        .update(hrmsBuddyTasks)
        .set({ status: "Accepted", acceptedAt: new Date(), updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsBuddyTasks.id, id));
      await hrmsAudit(ctx, "hrms.tasks.buddy.accept", "hrms_buddy_tasks", id, { status: r.status }, { status: "Accepted" });
      return okVoid(`Accepted · ${r.task}`);
    },
    async done(ctx, id) {
      const r = await buddyFor(id);
      if (!r) return err("That task no longer exists.", "not_found");
      if (r.toEmployeeId !== ctx.employee?.id) return err("Only the buddy marks it done.", "not_permitted");
      if (r.status !== "Accepted") return err(r.status === "Shared" ? "Accept it first." : "Already done.");
      await db
        .update(hrmsBuddyTasks)
        .set({ status: "Task done", doneAt: new Date(), updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsBuddyTasks.id, id));
      await hrmsAudit(ctx, "hrms.tasks.buddy.done", "hrms_buddy_tasks", id, { status: r.status }, { status: "Task done" });
      /* §18.5: the person who shared it is told it is done. */
      await notifyEmployees([r.fromEmployeeId], "Your buddy task is done", `${ctx.employee?.name ?? ""}: ${r.task}`, hrmsLink("buddy"));
      const sender = byId(await allPeople()).get(r.fromEmployeeId);
      return okVoid(`Done · ${first(sender?.name)} is told`);
    },
    async delete(ctx, id) {
      const r = await buddyFor(id);
      if (!r) return err("That task no longer exists.", "not_found");
      if (!(r.fromEmployeeId === ctx.employee?.id || taskAdmin(ctx))) return err("Only admin or the person who shared it deletes it", "not_permitted");
      await db.delete(hrmsBuddyTasks).where(eq(hrmsBuddyTasks.id, id));
      await hrmsAudit(ctx, "hrms.tasks.buddy.delete", "hrms_buddy_tasks", id, r, null);
      return okVoid("Shared task deleted");
    },
  },
};

export const TASKS_SCREENS: HrmsScreenModule[] = [templates, checklist, todos, buddy];
