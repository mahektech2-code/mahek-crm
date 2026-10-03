import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { attachments, hrmsAttendance, hrmsGrievances, hrmsHelp, hrmsNotifications, hrmsRefLists, mbosDeletions, mbosDocuments, users } from "@/db/schema";
import { submitFeedback } from "@/lib/actions/feedback";
import { bindAttachments } from "@/lib/services/attachment-service";
import type { ActionSpec, Contact, FormSpec, ListRow, RowField } from "@/lib/erp/ui";
import { has, type HrmsContext, type Scope } from "../access";
import { err, fieldErr, first, hrmsAudit, hrmsId, inTx, nextSeries, now, okVoid, stampLine, text, today, type HrmsScreenModule, type ScreenQuery } from "../server";
import { allPeople, byId, isActive, isSales, offices, type Person } from "../services/people";
import { bindHrmsFiles } from "../attachments";
import { HRMS_TABS, hrmsLink, hrmsListLabel } from "../registry";
import { fdShort, tmin } from "../time";
import { calendarDate } from "@/lib/business-date";
import { personFrom, personOption } from "./attendance";
import { GRIEVANCE_ANSWERED, HELP } from "../values";
import { hrmsUserIds, powerHolderUserIds, tell, usersOfEmployees } from "../services/notify";
import { announce, bellsOf, markAnnouncementSeen, rewordAnnouncement, withdrawAnnouncement } from "@/lib/services/announcement-service";

/* ---------------------------------------------------------------------------
 * Help & grievance (spec §16), Documents and Notifications (§17), and the
 * pick lists (§3). Small screens whose one real rule is WHO sees a row,
 * which is why every load filters on the server rather than trusting a scope
 * the browser sent.
 * ------------------------------------------------------------------------- */

/** mine / all for the holders of one power, never "team": these rows are private to the people in them. */
function privateScope(q: ScreenQuery, wide: boolean): { scope: Scope; options: Scope[] } {
  if (!wide) return { scope: "mine", options: ["mine"] };
  return { scope: q.scope === "mine" ? "mine" : "all", options: ["mine", "all"] };
}

/* Who is told, and the telling, are `../services/notify`: one definition of
   a resolver for help, grievances and the late-check-in request alike. */
const userIdsFor = usersOfEmployees;
const resolverUserIds = () => powerHolderUserIds("resolve");

async function namesOf(userIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** "27 Sep 2026, 10:14" in IST — the stamp without its "Created" prefix. */
const when = (at: Date | null | undefined) => (at ? stampLine(null, at).replace(/^Created /, "") : "");

const noEmployee = () => err("Your account is not linked to an employee record yet. Ask HR to link it on the Access screen.", "not_permitted");

/* ================================================================ help §16.1 */

/* Never stored: a problem with the app goes to MahekOne's Tell us. */
const APP_ISSUE = HELP.appIssue;
const HELP_TYPES: string[] = [HELP.forgotCheckIn, HELP.lateCheckIn, HELP.forgotCheckOut, HELP.runningLate, HELP.overtime, HELP.learnApp, APP_ISSUE, HELP.other];
const IN_TYPES: string[] = [HELP.forgotCheckIn, HELP.lateCheckIn, HELP.runningLate];
const OUT_TYPES: string[] = [HELP.forgotCheckIn, HELP.forgotCheckOut];
/** The issues about an attendance day, which the resolver corrects there (§6.3). */
const ATTENDANCE_TYPES: string[] = [HELP.forgotCheckIn, HELP.lateCheckIn, HELP.forgotCheckOut, HELP.runningLate];

function helpForm(): FormSpec {
  return {
    screen: "help",
    id: "new",
    title: "Ask for help",
    sub: "Attendance issues go to whoever resolves help requests. A problem with the app goes to MahekOne’s Tell us, with your text.",
    submit: "Send request",
    init: { inTime: now(), outTime: now() },
    header: [
      { k: "type", l: "What happened", t: "select", req: true, opts: HELP_TYPES, hint: "A problem with the app goes to MahekOne’s Tell us, which reaches the product team, rather than to whoever resolves help requests." },
      { k: "inTime", l: "In time", t: "time", req: true, when: { k: "type", in: IN_TYPES } },
      { k: "outTime", l: "Out time", t: "time", req: true, when: { k: "type", in: OUT_TYPES } },
      { k: "text", l: "Details", t: "area", req: true, mic: true },
      { k: "shot", l: "Screenshot", t: "photo", when: { k: "type", eq: APP_ISSUE } },
    ],
  };
}

type HelpRow = typeof hrmsHelp.$inferSelect;

/** Whether approving this request can write its times onto the day: an attendance request with a time, approved by somebody who edits attendance. */
const correctsDay = (ctx: HrmsContext, r: HelpRow) => ATTENDANCE_TYPES.includes(r.type) && !!(r.inTime || r.outTime) && has(ctx, "editAtt");

function helpActions(ctx: HrmsContext, r: HelpRow, attendanceId: string | undefined): ActionSpec[] {
  const resolver = has(ctx, "resolve");
  const late = r.type === HELP.runningLate;
  const a: ActionSpec[] = [];
  if (r.status === "Pending")
    a.push({
      id: "approve",
      l: "Approve",
      primary: true,
      why: resolver ? undefined : "Approving help requests needs the “Resolve help requests and grievances” power",
      prompt: {
        title: "Approve help request",
        sub: r.type,
        submit: "Approve",
        init: { remark: r.adminRemark ?? "", apply: correctsDay(ctx, r) ? "Yes" : "" },
        fields: [
          { k: "remark", l: "Reviewer’s remark", t: "area", req: late, hint: late ? "Say what was agreed about the late start." : undefined },
          ...(correctsDay(ctx, r)
            ? [{ k: "apply", l: `Write ${[r.inTime && `check-in ${r.inTime}`, r.outTime && `check-out ${r.outTime}`].filter(Boolean).join(" and ")} on ${fdShort(r.date)}`, t: "select" as const, opts: ["Yes", "No"], req: true }]
            : []),
        ],
      },
    });
  if (resolver)
    a.push({ id: "remark", l: "Reviewer’s remark", prompt: { title: "Reviewer’s remark", submit: "Save", init: { remark: r.adminRemark ?? "" }, fields: [{ k: "remark", l: "Remark", t: "area", req: true }] } });
  if (ATTENDANCE_TYPES.includes(r.type))
    a.push({
      id: "openDay",
      l: "Open attendance day",
      /* The day it is about may not exist yet (forgot to check in): then the register from that date. */
      href: attendanceId ? hrmsLink("attendance", { scope: "all", open: attendanceId }) : hrmsLink("attendance", { scope: "all", from: r.date }),
    });
  const own = r.employeeId === ctx.employee?.id;
  if ((own && r.status === "Pending") || has(ctx, "admin")) a.push({ id: "delete", l: "Delete", confirm: "Delete this help request? It cannot be undone." });
  return a;
}

/**
 * An app fault has ONE channel across MahekOne (A40): it becomes a Tell us
 * report, never a help row admin cannot fix. The screenshot was already
 * uploaded by the form, so it is bound to the report by id — only when it is
 * this person's and still unparented, so an id typed into a request cannot
 * move somebody else's file.
 */
async function appIssue(ctx: HrmsContext, body: string, shot: string | null) {
  if (body.length < 10) return fieldErr("text", "Say a little more: what happened, or what you would like.");
  const line = body.split(/\r?\n/)[0].trim();
  const heading = (line.length >= 4 ? line : `HRMS: ${line}`).slice(0, 120);
  const res = await submitFeedback({ kind: "bug", title: heading, body, path: "/hrms" });
  if (!res.ok) return fieldErr("text", res.error);
  let attached = false;
  if (shot) {
    const [file] = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(and(eq(attachments.id, shot), eq(attachments.uploadedById, ctx.user.id), isNull(attachments.parentId)));
    if (file) {
      const b = await bindAttachments([file.id], "feedback", res.data.id);
      attached = b.ok && b.data.bound > 0;
    }
  }
  return okVoid(`Sent to MahekOne Tell us with your text${attached ? " and screenshot" : ""}`);
}

const help: HrmsScreenModule = {
  key: "help",
  async load(ctx, q) {
    const { scope, options } = privateScope(q, has(ctx, "resolve"));
    const me = ctx.employee?.id;
    const rows =
      scope === "all"
        ? await db.select().from(hrmsHelp).orderBy(desc(hrmsHelp.date))
        : me
          ? await db.select().from(hrmsHelp).where(eq(hrmsHelp.employeeId, me)).orderBy(desc(hrmsHelp.date))
          : [];
    const people = byId(await allPeople());
    const empIds = [...new Set(rows.map((r) => r.employeeId))];
    const days = empIds.length
      ? await db
          .select({ id: hrmsAttendance.id, employeeId: hrmsAttendance.employeeId, date: hrmsAttendance.date })
          .from(hrmsAttendance)
          .where(inArray(hrmsAttendance.employeeId, empIds))
      : [];
    const dayOf = new Map(days.map((d) => [`${d.employeeId}|${d.date}`, d.id]));
    const deciders = await namesOf(rows.map((r) => r.decidedById));
    return {
      spec: {
        screen: "help",
        cols: [
          { k: "date", l: "Date", t: "d" },
          { k: "emp", l: "Employee", t: "b" },
          { k: "type", l: "Issue", t: "t" },
          { k: "inTime", l: "In", t: "t" },
          { k: "outTime", l: "Out", t: "t" },
          { k: "text", l: "Details", t: "t" },
          { k: "status", l: "Status", t: "s" },
          { k: "remark", l: "Reviewer’s remark", t: "t" },
          { k: "f", l: "", t: "f" },
        ],
        hidden: [],
        chips: "status",
        sortDefault: ["date", -1],
        newForm: helpForm(),
        newLabel: "Ask for help",
        noDataLine: "No help requests yet.",
        hrms: { scope: { current: scope, options } },
      },
      rows: rows.map((r): ListRow => {
        const p = people.get(r.employeeId);
        const fields: RowField[] = [
          { l: "Employee ID", v: p?.code ?? "" },
          { l: "Office", v: p?.office ?? "" },
          { l: "Reviewer’s remark", v: r.adminRemark ?? "" },
        ];
        if (r.decidedAt) fields.push({ l: "Approved", v: `${deciders.get(r.decidedById ?? "") ?? ""} · ${when(r.decidedAt)}` });
        return {
          id: r.id,
          v: { date: r.date, emp: p?.name ?? "", type: r.type, inTime: r.inTime ?? "", outTime: r.outTime ?? "", text: r.text ?? "", status: r.status, remark: r.adminRemark ?? "" },
          flags: r.status === "Approved" ? ["helpOk"] : [],
          title: `${p?.name ?? ""} · ${r.type}`,
          header: `${fdShort(r.date)} · ${r.status}`,
          fields,
          actions: helpActions(ctx, r, dayOf.get(`${r.employeeId}|${r.date}`)),
          by: stampLine(p?.name, r.createdAt),
        };
      }),
    };
  },
  actions: {
    async approve(ctx, id, v) {
      if (!has(ctx, "resolve")) return err("Approving help requests needs the “Resolve help requests and grievances” power", "not_permitted");
      const [r] = await db.select().from(hrmsHelp).where(eq(hrmsHelp.id, id));
      if (!r) return err("That request no longer exists.", "not_found");
      if (r.status !== "Pending") return err("This help request is already approved.");
      const remark = text(v.remark);
      if (r.type === HELP.runningLate && !remark) return fieldErr("remark", "Say what was agreed about the late start.");
      await db
        .update(hrmsHelp)
        .set({ status: "Approved", adminRemark: remark ?? r.adminRemark, decidedAt: new Date(), decidedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsHelp.id, id));
      await hrmsAudit(ctx, "hrms.help.approve", "hrms_help", id, { status: r.status }, { status: "Approved", remark });
      const to = await userIdsFor([r.employeeId]);
      await tell(to.map((userId) => ({ userId, title: "Help request approved", body: `${r.type}${remark ? ` · ${remark}` : ""}`, href: hrmsLink("help", { open: id }) })));
      if (!ATTENDANCE_TYPES.includes(r.type)) return okVoid("Approved");
      if (correctsDay(ctx, r) && v.apply === "Yes") {
        const { correctDayFromHelp } = await import("./attendance");
        return okVoid(`Approved · ${await correctDayFromHelp(ctx, { employeeId: r.employeeId, date: r.date, inTime: r.inTime, outTime: r.outTime, type: r.type })}`);
      }
      return okVoid(has(ctx, "editAtt") ? "Approved · attendance was not changed" : "Approved · someone who can edit attendance sets the times on that day");
    },
    async remark(ctx, id, v) {
      if (!has(ctx, "resolve")) return err("Writing the reviewer’s remark needs the “Resolve help requests and grievances” power", "not_permitted");
      const remark = text(v.remark);
      if (!remark) return fieldErr("remark", "Write the remark");
      const res = await db.update(hrmsHelp).set({ adminRemark: remark, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsHelp.id, id)).returning({ id: hrmsHelp.id });
      if (!res.length) return err("That request no longer exists.", "not_found");
      await hrmsAudit(ctx, "hrms.help.remark", "hrms_help", id, null, { remark });
      return okVoid("Remark saved");
    },
    async delete(ctx, id) {
      const [r] = await db.select().from(hrmsHelp).where(eq(hrmsHelp.id, id));
      if (!r) return err("That request no longer exists.", "not_found");
      const own = r.employeeId === ctx.employee?.id && r.status === "Pending";
      if (!own && !has(ctx, "admin")) return err("Only a pending request of your own can be deleted. Deleting any other needs the HRMS administration power.", "not_permitted");
      await db.delete(hrmsHelp).where(eq(hrmsHelp.id, id));
      await hrmsAudit(ctx, "hrms.help.delete", "hrms_help", id, r, null);
      return okVoid("Help request deleted");
    },
  },
  forms: {
    async new(ctx, h) {
      const type = text(h.type);
      if (!type || !HELP_TYPES.includes(type)) return fieldErr("type", "Choose what happened");
      const body = text(h.text);
      if (!body) return fieldErr("text", "Write the details");
      if (type === APP_ISSUE) return appIssue(ctx, body, text(h.shot));
      const me = ctx.employee;
      if (!me) return noEmployee();
      const inTime = IN_TYPES.includes(type) ? text(h.inTime) : null;
      const outTime = OUT_TYPES.includes(type) ? text(h.outTime) : null;
      if (IN_TYPES.includes(type) && tmin(inTime) == null) return fieldErr("inTime", "Enter the in time");
      if (OUT_TYPES.includes(type) && tmin(outTime) == null) return fieldErr("outTime", "Enter the out time");
      const id = hrmsId("hhlp");
      await db.insert(hrmsHelp).values({ id, date: today(), employeeId: me.id, type, inTime, outTime, text: body, status: "Pending", createdById: ctx.user.id });
      await hrmsAudit(ctx, "hrms.help.raise", "hrms_help", id, null, { type });
      const to = (await resolverUserIds()).filter((u) => u !== ctx.user.id);
      await tell(to.map((userId) => ({ userId, title: `Help request from ${me.name}`, body: `${type} · ${body}`, kind: "warn", href: hrmsLink("help", { scope: "all", open: id }) })));
      return okVoid("Help request sent");
    },
  },
};

/* =========================================================== grievances §16.2 */

const GRIEVANCE_TO = ["CEO", "HR", "Company"];
const STAR_OPTS = ["5 ★★★★★", "4 ★★★★☆", "3 ★★★☆☆", "2 ★★☆☆☆", "1 ★☆☆☆☆"];
const stars = (n: number | null) => (n ? "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n) : "");

type GrievanceRow = typeof hrmsGrievances.$inferSelect;

function grievanceForm(ctx: HrmsContext, people: Person[], id: "new" | "edit", r?: GrievanceRow): FormSpec {
  const raiser = r?.byEmployeeId ?? ctx.employee?.id;
  const others = people.filter((p) => isActive(p) && p.id !== raiser).map(personOption);
  const toNow = r?.toEmployeeId ? people.find((p) => p.id === r.toEmployeeId) : undefined;
  return {
    screen: "grievances",
    id,
    title: r ? `Edit grievance #${r.no}` : "Raise a grievance",
    sub: "Only you and the person it is addressed to can see it.",
    submit: r ? "Save" : "Raise grievance",
    recordId: r?.id,
    init: r ? { to: toNow ? personOption(toNow) : r.toLabel, issue: r.issue } : undefined,
    header: [
      { k: "to", l: "To", t: "select", req: true, opts: [...GRIEVANCE_TO, ...others] },
      { k: "issue", l: "Issue", t: "area", req: true, mic: true },
    ],
  };
}

/** Resolves the To field: a fixed recipient, or an active employee who is not the raiser. */
function grievanceTo(v: string | undefined, people: Person[], raiser: string): { label: string; employeeId: string | null } | null {
  const t = text(v);
  if (!t) return null;
  if (GRIEVANCE_TO.includes(t)) return { label: t, employeeId: null };
  const p = personFrom(t, people);
  if (!p || !isActive(p) || p.id === raiser) return null;
  return { label: p.name, employeeId: p.id };
}

/** Only the raiser, the addressee, and resolvers see a grievance (spec §16.2). */
function mayReadGrievance(ctx: HrmsContext, r: GrievanceRow): boolean {
  const me = ctx.employee?.id;
  return has(ctx, "resolve") || (!!me && (r.byEmployeeId === me || r.toEmployeeId === me));
}

const mayEditGrievance = (ctx: HrmsContext, r: GrievanceRow) => has(ctx, "admin") || (r.byEmployeeId === ctx.employee?.id && r.status === "Pending");

function grievanceActions(ctx: HrmsContext, r: GrievanceRow): ActionSpec[] {
  const me = ctx.employee?.id;
  const raiser = !!me && r.byEmployeeId === me;
  const addressee = !!me && r.toEmployeeId === me;
  const a: ActionSpec[] = [];
  if (r.status === "Pending")
    a.push({
      id: "solve",
      l: "Give solution",
      primary: true,
      why: has(ctx, "resolve") || addressee ? undefined : "Only the person it is addressed to, or someone with the “Resolve help requests and grievances” power, gives the solution",
      prompt: { title: "Give solution", sub: r.issue, submit: "Mark solved", fields: [{ k: "solution", l: "Solution", t: "area", req: true }] },
    });
  if (raiser && r.status === GRIEVANCE_ANSWERED && !r.stars)
    a.push({
      id: "feedback",
      l: "Give feedback",
      primary: true,
      prompt: { title: "How was it solved?", sub: r.solution ?? "", submit: "Send feedback", fields: [{ k: "stars", l: "Stars", t: "select", req: true, opts: STAR_OPTS }] },
    });
  if (mayEditGrievance(ctx, r)) a.push({ id: "edit", l: "Edit", loadsForm: true });
  if (has(ctx, "admin")) a.push({ id: "delete", l: "Delete", confirm: `Delete grievance #${r.no}? It cannot be undone.` });
  return a;
}

const grievances: HrmsScreenModule = {
  key: "grievances",
  async load(ctx, q) {
    const { scope, options } = privateScope(q, has(ctx, "resolve"));
    const me = ctx.employee?.id;
    const all = await db.select().from(hrmsGrievances).orderBy(desc(hrmsGrievances.date), desc(hrmsGrievances.no));
    const rows = all.filter((r) => (scope === "all" ? mayReadGrievance(ctx, r) : !!me && (r.byEmployeeId === me || r.toEmployeeId === me)));
    const people = await allPeople();
    const pb = byId(people);
    const solvers = await namesOf(rows.map((r) => r.solvedById));
    return {
      spec: {
        screen: "grievances",
        cols: [
          { k: "date", l: "Date", t: "d" },
          { k: "by", l: "Raised by", t: "t" },
          { k: "to", l: "To", t: "t" },
          { k: "issue", l: "Issue", t: "b" },
          { k: "status", l: "Status", t: "s" },
          { k: "solution", l: "Solution", t: "t" },
          { k: "starsTxt", l: "Feedback", t: "t" },
          { k: "f", l: "", t: "f" },
        ],
        hidden: [],
        groups: ["status", "to"],
        sortDefault: ["date", -1],
        newForm: me ? grievanceForm(ctx, people, "new") : undefined,
        newLabel: "Raise a grievance",
        noDataLine: "No grievances.",
        hrms: { scope: { current: scope, options } },
      },
      rows: rows.map((r): ListRow => {
        const by = pb.get(r.byEmployeeId)?.name ?? "";
        const fields: RowField[] = [{ l: "Grievance no.", v: String(r.no) }];
        if (r.solvedById) fields.push({ l: "Solved by", v: solvers.get(r.solvedById) ?? "" });
        if (r.feedbackAt) fields.push({ l: "Feedback given", v: when(r.feedbackAt) });
        return {
          id: r.id,
          v: { date: r.date, by, to: r.toLabel, issue: r.issue, status: r.status, solution: r.solution ?? "", starsTxt: stars(r.stars) },
          flags: r.stars === 5 ? ["fiveStar"] : [],
          title: `To ${r.toLabel}`,
          header: r.issue,
          fields,
          actions: grievanceActions(ctx, r),
          by: stampLine(by, r.createdAt),
        };
      }),
    };
  },
  actions: {
    async solve(ctx, id, v) {
      const [r] = await db.select().from(hrmsGrievances).where(eq(hrmsGrievances.id, id));
      if (!r || !mayReadGrievance(ctx, r)) return err("That grievance no longer exists.", "not_found");
      const addressee = !!ctx.employee && r.toEmployeeId === ctx.employee.id;
      if (!has(ctx, "resolve") && !addressee) return err("Only the person it is addressed to, or someone with the “Resolve help requests and grievances” power, gives the solution", "not_permitted");
      if (r.status !== "Pending") return err(`Grievance #${r.no} is already solved.`);
      const solution = text(v.solution);
      if (!solution) return fieldErr("solution", "Write the solution");
      await db.update(hrmsGrievances).set({ status: GRIEVANCE_ANSWERED, solution, solvedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsGrievances.id, id));
      await hrmsAudit(ctx, "hrms.grievance.solve", "hrms_grievances", id, { status: r.status }, { status: GRIEVANCE_ANSWERED, solution });
      const to = await userIdsFor([r.byEmployeeId]);
      await tell(to.map((userId) => ({ userId, title: `Grievance #${r.no} solved`, body: solution, href: hrmsLink("grievances", { open: id }) })));
      const raiser = (await allPeople()).find((x) => x.id === r.byEmployeeId);
      return okVoid(`Solved · ${first(raiser?.name)} can give feedback`);
    },
    async feedback(ctx, id, v) {
      const [r] = await db.select().from(hrmsGrievances).where(eq(hrmsGrievances.id, id));
      if (!r) return err("That grievance no longer exists.", "not_found");
      if (r.byEmployeeId !== ctx.employee?.id) return err("Only the person who raised it gives feedback.", "not_permitted");
      if (r.status !== GRIEVANCE_ANSWERED) return err("You can rate the solution once there is one.");
      if (r.stars) return err("You have already given feedback on this grievance.");
      const n = Number(String(v.stars ?? "").trim()[0]);
      if (!(n >= 1 && n <= 5)) return fieldErr("stars", "Choose a star rating");
      await db.update(hrmsGrievances).set({ stars: n, feedbackAt: new Date(), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsGrievances.id, id));
      await hrmsAudit(ctx, "hrms.grievance.feedback", "hrms_grievances", id, null, { stars: n });
      return okVoid("Thanks for the feedback");
    },
    async delete(ctx, id) {
      if (!has(ctx, "admin")) return err("Deleting a grievance needs the HRMS administration power", "not_permitted");
      const [r] = await db.select().from(hrmsGrievances).where(eq(hrmsGrievances.id, id));
      if (!r) return err("That grievance no longer exists.", "not_found");
      await db.delete(hrmsGrievances).where(eq(hrmsGrievances.id, id));
      await hrmsAudit(ctx, "hrms.grievance.delete", "hrms_grievances", id, r, null);
      return okVoid("Grievance deleted");
    },
  },
  formLoaders: {
    async edit(ctx, id) {
      const [r] = await db.select().from(hrmsGrievances).where(eq(hrmsGrievances.id, id));
      if (!r || !mayReadGrievance(ctx, r) || !mayEditGrievance(ctx, r)) return null;
      return grievanceForm(ctx, await allPeople(), "edit", r);
    },
  },
  forms: {
    async new(ctx, h) {
      const me = ctx.employee;
      if (!me) return noEmployee();
      const to = grievanceTo(h.to, await allPeople(), me.id);
      if (!to) return fieldErr("to", "Choose who it is to: the CEO, HR, the company, or an active employee other than the person who raised it");
      const issue = text(h.issue);
      if (!issue) return fieldErr("issue", "Describe the issue");
      const id = hrmsId("hgrv");
      let no = 0;
      const res = await inTx(async (tx) => {
        no = await nextSeries(tx, "grievance");
        await tx.insert(hrmsGrievances).values({ id, no, date: today(), byEmployeeId: me.id, toLabel: to.label, toEmployeeId: to.employeeId, issue, status: "Pending", createdById: ctx.user.id });
        return okVoid(`Grievance raised to ${to.label}`);
      });
      if (!res.ok) return res;
      await hrmsAudit(ctx, "hrms.grievance.raise", "hrms_grievances", id, null, { no, to: to.label });
      const recipients = new Set([...(await resolverUserIds()), ...(await userIdsFor([to.employeeId]))]);
      recipients.delete(ctx.user.id);
      await tell([...recipients].map((userId) => ({ userId, title: `Grievance #${no} from ${me.name}`, body: `To ${to.label} · ${issue}`, kind: "warn", href: hrmsLink("grievances", { open: id }) })));
      return res;
    },
    async edit(ctx, h, _lines, recordId) {
      if (!recordId) return err("No grievance was named. Open it again and retry.", "not_found");
      const [r] = await db.select().from(hrmsGrievances).where(eq(hrmsGrievances.id, recordId));
      if (!r) return err("That grievance no longer exists.", "not_found");
      if (!mayEditGrievance(ctx, r)) return err("Only the person who raised a grievance can edit it, and only while it is pending. Editing any other needs the HRMS administration power.", "not_permitted");
      const to = grievanceTo(h.to, await allPeople(), r.byEmployeeId);
      if (!to) return fieldErr("to", "Choose who it is to: the CEO, HR, the company, or an active employee other than the person who raised it");
      const issue = text(h.issue);
      if (!issue) return fieldErr("issue", "Describe the issue");
      await db.update(hrmsGrievances).set({ toLabel: to.label, toEmployeeId: to.employeeId, issue, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsGrievances.id, recordId));
      await hrmsAudit(ctx, "hrms.grievance.edit", "hrms_grievances", recordId, { to: r.toLabel, issue: r.issue }, { to: to.label, issue });
      return okVoid("Grievance updated");
    },
  },
};

/* ============================================================ documents §17.1 */

/*
 * ONE LIBRARY. HRMS's documents are rows of the company's document library,
 * `mbos_documents` — the one the field app and the Sales Dashboard read — with
 * an `audience` saying who in HRMS each is for. A document the Sales Dashboard
 * published to the field team alone has no audience and is not listed here.
 */

const DOC_TYPES = ["PDF & audio", "Image", "Video", "Link"];
const EVERYONE = "All employees";
const FIELD = "Field staff";
const manageDocs = (ctx: HrmsContext) => has(ctx, "hr") || has(ctx, "admin");

type DocRow = typeof mbosDocuments.$inferSelect;

/** HR's documents in the shared library, newest first — withdrawn ones only for whoever manages them. */
async function hrDocuments(includeWithdrawn: boolean): Promise<DocRow[]> {
  return db
    .select()
    .from(mbosDocuments)
    .where(includeWithdrawn ? isNotNull(mbosDocuments.audience) : and(isNotNull(mbosDocuments.audience), eq(mbosDocuments.active, true)))
    .orderBy(desc(mbosDocuments.serverCreatedAt));
}

/** Whether a document is meant for this person: everyone, field staff, their office, or by name. */
function docFor(d: DocRow, me: HrmsContext["employee"]): boolean {
  if (!d.active || !d.audience) return false;
  if (d.audience === EVERYONE) return true;
  if (!me) return false;
  if (d.audienceEmployeeIds.includes(me.id)) return true;
  if (d.audience === FIELD) return isSales({ positionType: me.positionType } as Person);
  return !!me.office && d.audience === me.office;
}

/**
 * Who a document reaches on the handsets: everybody in the field (an empty
 * role list) when it is for all employees or field staff and has a file;
 * nobody otherwise — a handset cannot open a link and does not know its
 * holder's office. "hrms" matches no handset role.
 */
const handsetRoles = (media: string, file: string | null, audience: string) => (media !== "Link" && file && (audience === EVERYONE || audience === FIELD) ? [] : ["hrms"]);

/** Whether this person may open a document's file: the screen's own rule. */
export async function mayReadDocument(ctx: HrmsContext, id: string): Promise<boolean> {
  const [d] = await db.select().from(mbosDocuments).where(eq(mbosDocuments.id, id)).limit(1);
  return !!d && !!d.audience && (manageDocs(ctx) || docFor(d, ctx.employee));
}

/** The header search's documents: the ones this person's Documents screen would list. */
export async function searchDocuments(ctx: HrmsContext, needle: string, limit: number): Promise<{ id: string; title: string; type: string }[]> {
  const n = needle.trim().toLowerCase();
  return (await hrDocuments(false))
    .filter((d) => (manageDocs(ctx) || docFor(d, ctx.employee)) && d.title.toLowerCase().includes(n))
    .slice(0, limit)
    .map((d) => ({ id: d.id, title: d.title, type: d.media ?? "" }));
}

const docHref = (d: DocRow) => (d.media === "Link" ? (d.linkUrl ?? "") : d.attachmentId ? `/api/attachments/${d.attachmentId}` : "");
const openLabel: Record<string, string> = { Link: "Open link", Video: "Open video", Image: "Open image", "PDF & audio": "Open PDF or audio" };

const documents: HrmsScreenModule = {
  key: "documents",
  async load(ctx) {
    const manager = manageDocs(ctx);
    const all = await hrDocuments(manager);
    const rows = manager ? all : all.filter((d) => docFor(d, ctx.employee));
    const officeNames = manager ? (await offices()).map((o) => o.name) : [];
    const people = byId(await allPeople());
    const creators = await namesOf(rows.map((d) => d.createdById));
    return {
      spec: {
        screen: "documents",
        cols: [
          { k: "title", l: "Title", t: "b" },
          { k: "type", l: "Type", t: "s" },
          { k: "desc", l: "Description", t: "t" },
          { k: "date", l: "Date", t: "d" },
          { k: "tagged", l: "For", t: "t" },
          { k: "f", l: "", t: "f" },
        ],
        hidden: [],
        chips: "type",
        sortDefault: ["date", -1],
        newForm: manager
          ? {
              screen: "documents",
              id: "new",
              title: "Add a document",
              sub: "Say who should see it. A file for all employees or field staff also reaches the field app.",
              submit: "Add document",
              init: { tagged: EVERYONE },
              header: [
                { k: "title", l: "Title", t: "text", req: true },
                { k: "type", l: "Type", t: "select", req: true, opts: DOC_TYPES },
                { k: "file", l: "File", t: "photo", req: true, when: { k: "type", in: ["PDF & audio", "Image", "Video"] } },
                { k: "url", l: "Link", t: "text", req: true, when: { k: "type", eq: "Link" }, hint: "An http:// or https:// address." },
                { k: "desc", l: "Description", t: "area" },
                { k: "tagged", l: "Who it is for", t: "select", req: true, opts: [EVERYONE, FIELD, ...officeNames] },
              ],
            }
          : undefined,
        newLabel: "Add document",
        noDataLine: manager ? "No documents yet." : "No documents are meant for you yet.",
      },
      rows: rows.map((d): ListRow => {
        const href = docHref(d);
        const named = d.audienceEmployeeIds.map((id) => people.get(id)?.name).filter(Boolean).join(", ");
        const actions: ActionSpec[] = [href ? { id: "open", l: "Open", primary: true, href } : { id: "open", l: "Open", primary: true, why: "Nothing was attached to this document" }];
        if (manager && d.active) actions.push({ id: "delete", l: "Withdraw", confirm: `Withdraw “${d.title}”? It comes off the list, and off every handset on its next sync. The record is kept.` });
        const fields: RowField[] = [
          { l: "File or link", v: d.media === "Link" ? (d.linkUrl ?? "") : d.attachmentId ? "Attached" : "None" },
          { l: "On the field app", v: d.visibleToRoles.length === 0 ? "Yes" : "No" },
        ];
        if (named) fields.push({ l: "Meant for, by name", v: named });
        return {
          id: d.id,
          v: { title: d.title, type: d.media ?? "", desc: d.description ?? "", date: calendarDate(d.serverCreatedAt), tagged: d.audience ?? "" },
          flags: d.active ? [] : ["inactive"],
          title: d.title,
          header: `${d.media ?? ""} · ${d.audience ?? ""}`,
          fields,
          contacts: href ? [{ l: openLabel[d.media ?? ""] ?? "Open", href }] : [],
          actions,
          by: stampLine(creators.get(d.createdById ?? "") ?? null, d.serverCreatedAt),
        };
      }),
    };
  },
  actions: {
    /* Withdrawn, never deleted — the library's rule: a policy somebody quoted
       in March is a fact about March. The tombstone is what takes it off the
       handsets that already pulled it. */
    async delete(ctx, id) {
      if (!manageDocs(ctx)) return err("Withdrawing a document needs the HR or HRMS administration power", "not_permitted");
      const [d] = await db.select().from(mbosDocuments).where(and(eq(mbosDocuments.id, id), isNotNull(mbosDocuments.audience)));
      if (!d) return err("That document no longer exists.", "not_found");
      if (!d.active) return err(`${d.title} is already withdrawn.`);
      await db.update(mbosDocuments).set({ active: false, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(mbosDocuments.id, id));
      await db.insert(mbosDeletions).values({ id: hrmsId("del"), entity: "documents", entityId: id, userId: null, reason: "withdrawn" });
      await hrmsAudit(ctx, "hrms.document.withdraw", "mbos_documents", id, { active: true }, { active: false });
      return okVoid(`${d.title} withdrawn`);
    },
  },
  forms: {
    async new(ctx, h) {
      if (!manageDocs(ctx)) return err("Adding documents needs the HR or HRMS administration power", "not_permitted");
      const title = text(h.title);
      if (!title) return fieldErr("title", "Give the document a title");
      const type = text(h.type);
      if (!type || !DOC_TYPES.includes(type)) return fieldErr("type", "Choose the type of document");
      const url = type === "Link" ? text(h.url) : null;
      const file = type === "Link" ? null : text(h.file);
      if (type === "Link" && !url) return fieldErr("url", "Enter the link");
      if (url && !/^https?:\/\//i.test(url)) return fieldErr("url", "A link starts with http:// or https://");
      if (type !== "Link" && !file) return fieldErr("file", "Attach the file");
      const tagged = text(h.tagged) ?? EVERYONE;
      const officeNames = (await offices()).map((o) => o.name);
      if (![EVERYONE, FIELD, ...officeNames].includes(tagged)) return fieldErr("tagged", "Choose who should see it: all employees, field staff, or an office");
      const id = hrmsId("hdoc");
      const res = await inTx(async (tx) => {
        await tx.insert(mbosDocuments).values({
          id,
          title,
          category: "policy",
          attachmentId: file,
          visibleToRoles: handsetRoles(type, file, tagged),
          active: true,
          audience: tagged,
          media: type,
          linkUrl: url,
          description: text(h.desc),
          createdById: ctx.user.id,
          updatedById: ctx.user.id,
        });
        if (file) await bindHrmsFiles(tx, [file], "hrms_document", id, ctx.user.id);
        return okVoid(`Document added for ${tagged.toLowerCase()}`);
      });
      if (res.ok) await hrmsAudit(ctx, "hrms.document.add", "mbos_documents", id, null, { title, type, tagged });
      return res;
    },
  },
};

/* ======================================================== notifications §17.2 */

const writeNotes = (ctx: HrmsContext) => has(ctx, "hr") || has(ctx, "admin");
/** Screens a notification may open: every screen the registry knows except settings, offered by label. */
/* Every list somebody can be sent to, by its full name ("Leave & holidays ·
   To decide"), never the settings: a notice is not a way into the rules. */
const LANDINGS = HRMS_TABS.filter((x) => x.screen.key !== "settings").map((x) => ({ key: x.tab.key, label: hrmsListLabel(x.tab.key) }));
const landingLabel = (key: string | null) => (key ? hrmsListLabel(key) : "");

type NoteRow = typeof hrmsNotifications.$inferSelect;

function mailto(email: string | null | undefined, body: string): string | null {
  return email ? `mailto:${email}?subject=${encodeURIComponent("HRMS notification")}&body=${encodeURIComponent(body)}` : null;
}

const notifications: HrmsScreenModule = {
  key: "notifications",
  async load(ctx, q) {
    const admin = has(ctx, "admin");
    const { scope, options } = privateScope(q, admin);
    const me = ctx.employee?.id ?? null;
    const all = await db.select().from(hrmsNotifications).orderBy(desc(hrmsNotifications.createdAt));
    /* Who it went to is the recipient list; rows from before it existed are read the old way. */
    const toMe = (n: NoteRow) => (n.recipientUserIds.length ? n.recipientUserIds.includes(ctx.user.id) : n.toEmployeeId == null || (!!me && n.toEmployeeId === me));
    const fromMe = (n: NoteRow) => n.createdById === ctx.user.id || (!!me && n.fromEmployeeId === me);
    const rows = scope === "all" ? all : all.filter((n) => toMe(n) || fromMe(n));
    const people = await allPeople();
    const pb = byId(people);
    /* Seen is the bell's own read mark — one read state, not two. */
    const bells = await bellsOf(rows.flatMap((n) => n.bellIds));
    const bellsFor = (n: NoteRow) => bells.filter((b) => n.bellIds.includes(b.id));
    return {
      spec: {
        screen: "notifications",
        cols: [
          { k: "time", l: "Time", t: "t" },
          { k: "from", l: "From", t: "t" },
          { k: "to", l: "To", t: "t" },
          { k: "text", l: "Message", t: "b" },
          { k: "landing", l: "Opens", t: "t" },
          { k: "seen", l: "Seen", t: "t" },
        ],
        hidden: [],
        newForm: writeNotes(ctx)
          ? {
              screen: "notifications",
              id: "new",
              title: "Write an announcement",
              sub: "It arrives in the MahekOne bell and opens the screen you choose.",
              submit: "Send",
              init: { landing: hrmsListLabel("home") },
              header: [
                { k: "to", l: "To", t: "select", req: true, opts: ["All employees", ...people.filter(isActive).map(personOption)] },
                { k: "text", l: "Message", t: "area", req: true, mic: true },
                { k: "landing", l: "Opens", t: "select", req: true, opts: LANDINGS.map((s) => s.label) },
              ],
            }
          : undefined,
        newLabel: "Write an announcement",
        noDataLine: "No announcements sent or received yet.",
        hrms: { scope: { current: scope, options } },
      },
      rows: rows.map((n): ListRow => {
        const personal = n.toEmployeeId != null;
        const sender = fromMe(n);
        const contacts: Contact[] = [];
        const s = mailto(n.fromEmployeeId ? pb.get(n.fromEmployeeId)?.email : null, n.text);
        const r = mailto(n.toEmployeeId ? pb.get(n.toEmployeeId)?.email : null, n.text);
        if (s) contacts.push({ l: "Email the sender", href: s });
        if (r) contacts.push({ l: "Email the recipient", href: r });
        const actions: ActionSpec[] = [];
        if (n.landing) actions.push({ id: "open", l: `Open ${landingLabel(n.landing)}`, primary: true, href: hrmsLink(n.landing) });
        const mine = bellsFor(n).find((b) => b.userId === ctx.user.id);
        const sent = bellsFor(n);
        const seenBy = sent.filter((b) => b.read).length;
        const legacySeen = !n.bellIds.length && !!n.seenAt;
        if (mine && !mine.read) actions.push({ id: "seen", l: "Mark as seen" });
        else if (!n.bellIds.length && personal && !!me && n.toEmployeeId === me && !n.seenAt) actions.push({ id: "seen", l: "Mark as seen" });
        if (sender) actions.push({ id: "edit", l: "Edit", prompt: { title: "Edit announcement", sub: "Everybody it was sent to sees the new words in their bell.", submit: "Save", init: { text: n.text }, fields: [{ k: "text", l: "Message", t: "area", req: true }] } });
        if (sender || admin) actions.push({ id: "delete", l: "Delete", confirm: "Delete this announcement? It is taken out of everybody’s bell too." });
        const fields: RowField[] = [
          { l: "To", v: n.toLabel },
          { l: "Opens", v: landingLabel(n.landing) },
          { l: "Sent from", v: n.source === "sales" ? "Sales Dashboard" : "HRMS" },
        ];
        if (n.title) fields.push({ l: "Title", v: n.title });
        if (sent.length) fields.push({ l: "Seen by", v: `${seenBy} of ${sent.length}` });
        if (legacySeen) fields.push({ l: "Seen", v: when(n.seenAt) });
        const seen = sent.length ? (sent.length === 1 ? (seenBy ? "Seen" : "Unseen") : `${seenBy} of ${sent.length}`) : personal ? (legacySeen ? "Seen" : "Unseen") : "";
        return {
          id: n.id,
          /* "All employees" has no one reader, so it carries no seen state. */
          v: { time: when(n.createdAt), from: n.fromName, to: n.toLabel, text: n.text, landing: landingLabel(n.landing), seen },
          flags: [],
          title: `From ${n.fromName}`,
          header: n.text,
          fields,
          contacts,
          actions,
          by: stampLine(n.fromName, n.createdAt),
        };
      }),
    };
  },
  actions: {
    async seen(ctx, id) {
      const [n] = await db.select().from(hrmsNotifications).where(eq(hrmsNotifications.id, id));
      if (!n) return err("That notification no longer exists.", "not_found");
      if (n.bellIds.length) {
        if (!(await markAnnouncementSeen(n.bellIds, ctx.user.id))) return err("Only somebody it was sent to can mark it as seen.", "not_permitted");
        return okVoid("Marked as seen");
      }
      if (!ctx.employee || n.toEmployeeId !== ctx.employee.id) return err("Only the person it was sent to can mark it as seen.", "not_permitted");
      if (!n.seenAt) await db.update(hrmsNotifications).set({ seenAt: new Date(), updatedAt: new Date() }).where(eq(hrmsNotifications.id, id));
      return okVoid("Marked as seen");
    },
    async edit(ctx, id, v) {
      const [n] = await db.select().from(hrmsNotifications).where(eq(hrmsNotifications.id, id));
      if (!n) return err("That notification no longer exists.", "not_found");
      if (!(n.createdById === ctx.user.id || (!!ctx.employee && n.fromEmployeeId === ctx.employee.id))) return err("Only the sender can edit a notification.", "not_permitted");
      const body = text(v.text);
      if (!body) return fieldErr("text", "Write the message");
      await db.update(hrmsNotifications).set({ text: body, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsNotifications.id, id));
      await rewordAnnouncement(n.bellIds, body);
      await hrmsAudit(ctx, "hrms.notification.edit", "hrms_notifications", id, { text: n.text }, { text: body });
      return okVoid(n.bellIds.length ? "Announcement updated, in everybody’s bell too" : "Announcement updated");
    },
    async delete(ctx, id) {
      const [n] = await db.select().from(hrmsNotifications).where(eq(hrmsNotifications.id, id));
      if (!n) return err("That notification no longer exists.", "not_found");
      const sender = n.createdById === ctx.user.id || (!!ctx.employee && n.fromEmployeeId === ctx.employee.id);
      if (!sender && !has(ctx, "admin")) return err("Only the sender can delete a notification. Deleting anyone else’s needs the HRMS administration power.", "not_permitted");
      await db.delete(hrmsNotifications).where(eq(hrmsNotifications.id, id));
      await withdrawAnnouncement(n.bellIds);
      await hrmsAudit(ctx, "hrms.notification.delete", "hrms_notifications", id, n, null);
      return okVoid("Announcement deleted, and taken out of the bell");
    },
  },
  forms: {
    async new(ctx, h) {
      if (!writeNotes(ctx)) return err("Writing notifications needs the HR or HRMS administration power", "not_permitted");
      const body = text(h.text);
      if (!body) return fieldErr("text", "Write the message");
      const landing = LANDINGS.find((s) => s.label === h.landing || s.key === h.landing);
      if (!landing) return fieldErr("landing", "Choose the screen it opens");
      const toV = text(h.to);
      if (!toV) return fieldErr("to", "Choose who it is to");
      let toEmp: Person | undefined;
      if (toV !== "All employees") {
        toEmp = personFrom(toV, await allPeople());
        if (!toEmp || !isActive(toEmp)) return fieldErr("to", "Pick an active employee from the list, or All employees");
      }
      const fromName = ctx.employee?.name ?? ctx.user.name;
      /* Delivery is MahekOne's bell (§18.4): titled with the sender, the text as body, opening the landing screen. */
      const recipients = toEmp ? await userIdsFor([toEmp.id]) : await hrmsUserIds();
      const { id, reached } = await announce({
        senderUserId: ctx.user.id,
        fromEmployeeId: ctx.employee?.id ?? null,
        fromName,
        toEmployeeId: toEmp?.id ?? null,
        toLabel: toEmp?.name ?? "All employees",
        text: body,
        landing: landing.key,
        href: hrmsLink(landing.key),
        recipients,
        source: "hrms",
      });
      await hrmsAudit(ctx, "hrms.notification.send", "hrms_notifications", id, null, { to: toEmp?.code ?? "All employees", landing: landing.key });
      const unreached = toEmp && !reached ? ` · ${toEmp.name} has no MahekOne account yet, so it reached no bell` : "";
      return okVoid(`Sent to ${toEmp?.name ?? "all employees"}${unreached}`);
    },
  },
};

/* ========================================================= pick lists §3 */

const refLists: HrmsScreenModule = {
  key: "refLists",
  async load(ctx) {
    const why = has(ctx, "admin") ? undefined : "Editing pick lists needs the HRMS administration power";
    const rows = (await db.select().from(hrmsRefLists)).sort((a, b) => a.list.localeCompare(b.list));
    const setBy = await namesOf(rows.map((r) => r.updatedById));
    return {
      spec: {
        screen: "refLists",
        cols: [
          { k: "list", l: "List", t: "b" },
          { k: "count", l: "Values", t: "n" },
          { k: "sample", l: "Values", t: "t" },
        ],
        hidden: [],
        sortDefault: ["list", 1],
        noDataLine: "No pick lists yet.",
      },
      rows: rows.map(
        (r): ListRow => ({
          id: r.list,
          v: { list: r.list, count: r.values.length, sample: r.values.slice(0, 5).join(", ") + (r.values.length > 5 ? " …" : "") },
          flags: [],
          title: r.list,
          header: `${r.values.length} value${r.values.length === 1 ? "" : "s"}`,
          fields: [{ l: "Values", v: r.values.join(", ") || "—" }],
          actions: [
            { id: "add", l: "Add a value", primary: true, why, prompt: { title: `Add to ${r.list}`, submit: "Add value", fields: [{ k: "v", l: "Value", t: "text", req: true }] } },
            {
              id: "remove",
              l: "Remove a value",
              why: why ?? (r.values.length ? undefined : "The list is empty"),
              prompt: {
                title: `Remove from ${r.list}`,
                sub: "Old records keep the value they were saved with.",
                submit: "Remove value",
                fields: [{ k: "v", l: "Value", t: "select", req: true, opts: r.values }],
              },
            },
          ],
          by: r.updatedById ? `Last changed by ${setBy.get(r.updatedById) ?? "someone"} · ${when(r.updatedAt)}` : undefined,
        }),
      ),
    };
  },
  actions: {
    async add(ctx, list, v) {
      if (!has(ctx, "admin")) return err("Editing pick lists needs the HRMS administration power", "not_permitted");
      const value = text(v.v);
      if (!value) return fieldErr("v", "Type the value to add");
      const [r] = await db.select().from(hrmsRefLists).where(eq(hrmsRefLists.list, list));
      if (!r) return err("That list no longer exists.", "not_found");
      if (r.values.some((x) => x.trim().toLowerCase() === value.toLowerCase())) return fieldErr("v", `“${value}” is already in ${list}`);
      await db.update(hrmsRefLists).set({ values: [...r.values, value], updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsRefLists.list, list));
      await hrmsAudit(ctx, "hrms.refList.add", "hrms_ref_lists", list, null, { value });
      return okVoid(`Added “${value}” to ${list}`);
    },
    async remove(ctx, list, v) {
      if (!has(ctx, "admin")) return err("Editing pick lists needs the HRMS administration power", "not_permitted");
      const value = text(v.v);
      const [r] = await db.select().from(hrmsRefLists).where(eq(hrmsRefLists.list, list));
      if (!r) return err("That list no longer exists.", "not_found");
      if (!value || !r.values.includes(value)) return fieldErr("v", `Choose a value from ${list}`);
      await db.update(hrmsRefLists).set({ values: r.values.filter((x) => x !== value), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsRefLists.list, list));
      await hrmsAudit(ctx, "hrms.refList.remove", "hrms_ref_lists", list, { value }, null);
      return okVoid(`Removed “${value}” from ${list}`);
    },
  },
};

export const MISC_SCREENS: HrmsScreenModule[] = [help, grievances, documents, notifications, refLists];
