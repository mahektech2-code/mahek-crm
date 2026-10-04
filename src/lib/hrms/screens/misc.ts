import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, attachments, hrmsAttendance, hrmsDocuments, hrmsGrievances, hrmsHelp, hrmsNotifications, hrmsRefLists, hrmsUserPowers, users } from "@/db/schema";
import { notifyUsers, type NotifyEntry } from "@/lib/notify";
import { submitFeedback } from "@/lib/actions/feedback";
import { bindAttachments } from "@/lib/services/attachment-service";
import type { ActionSpec, Contact, FormSpec, ListRow, RowField } from "@/lib/erp/ui";
import { has, type HrmsContext, type Scope } from "../access";
import { err, fieldErr, first, hrmsAudit, hrmsId, inTx, nextSeries, now, okVoid, stampLine, text, today, type HrmsScreenModule, type ScreenQuery } from "../server";
import { allPeople, byId, isActive, isSales, offices, type Person } from "../services/people";
import { bindHrmsFiles } from "../attachments";
import { HRMS_TABS, hrmsLink, hrmsListLabel } from "../registry";
import { fdShort, tmin } from "../time";
import { personFrom, personOption } from "./attendance";

/* ---------------------------------------------------------------------------
 * Help & grievance (spec §16), Documents and Notifications (§17), and the
 * reference lists (§3). Small screens whose one real rule is WHO sees a row,
 * which is why every load filters on the server rather than trusting a scope
 * the browser sent.
 * ------------------------------------------------------------------------- */

/** mine / all for the holders of one power, never "team": these rows are private to the people in them. */
function privateScope(q: ScreenQuery, wide: boolean): { scope: Scope; options: Scope[] } {
  if (!wide) return { scope: "mine", options: ["mine"] };
  return { scope: q.scope === "mine" ? "mine" : "all", options: ["mine", "all"] };
}

/** MahekOne accounts for employees — the bell is a user's, the HRMS row an employee's. */
async function userIdsFor(employeeIds: (string | null | undefined)[]): Promise<string[]> {
  const ids = [...new Set(employeeIds.filter((x): x is string => !!x))];
  if (!ids.length) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.employeeId, ids), eq(users.active, true)));
  return rows.map((r) => r.id);
}

/** Who answers help and grievances: holders of `resolve`, and HRMS administrators (spec §18.5). */
async function resolverUserIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "hrms")))
    .leftJoin(hrmsUserPowers, and(eq(hrmsUserPowers.userId, users.id), eq(hrmsUserPowers.power, "resolve")))
    .where(and(eq(users.active, true), or(isNotNull(hrmsUserPowers.userId), eq(appAccess.role, "admin"), eq(users.role, "admin"))));
  return rows.map((r) => r.id);
}

/** Every active account holding HRMS — "All employees" on a notification. */
async function hrmsUserIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "hrms")))
    .where(eq(users.active, true));
  return rows.map((r) => r.id);
}

/** A bell must never fail the write it announces. */
async function tell(entries: NotifyEntry[]): Promise<void> {
  try {
    await notifyUsers(entries);
  } catch {
    /* the record is saved; the bell is a courtesy */
  }
}

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

const APP_ISSUE = "App issue — send to MahekOne Tell us";
const HELP_TYPES = ["I Forgot Make Attendance", "I Late Check In", "I Forget Check Out", "I Am Late Today", "OT Not Approved", "I Want to Lean App", APP_ISSUE, "Other"];
const IN_TYPES = ["I Forgot Make Attendance", "I Late Check In", "I Am Late Today"];
const OUT_TYPES = ["I Forgot Make Attendance", "I Forget Check Out"];
/** The issues about an attendance day, which the resolver corrects there (§6.3). */
const ATTENDANCE_TYPES = ["I Forgot Make Attendance", "I Late Check In", "I Forget Check Out", "I Am Late Today"];

function helpForm(): FormSpec {
  return {
    screen: "help",
    id: "new",
    title: "Ask for help",
    sub: "Attendance issues go to admin. An app problem goes to MahekOne’s Tell us with your text.",
    submit: "Send request",
    init: { inTime: now(), outTime: now() },
    header: [
      { k: "type", l: "What happened", t: "select", req: true, opts: HELP_TYPES, hint: "An app problem goes to MahekOne Tell us — the product team — rather than to admin." },
      { k: "inTime", l: "In time", t: "time", req: true, when: { k: "type", in: IN_TYPES } },
      { k: "outTime", l: "Out time", t: "time", req: true, when: { k: "type", in: OUT_TYPES } },
      { k: "text", l: "Details", t: "area", req: true, mic: true },
      { k: "shot", l: "Screenshot", t: "photo", when: { k: "type", eq: APP_ISSUE } },
    ],
  };
}

type HelpRow = typeof hrmsHelp.$inferSelect;

function helpActions(ctx: HrmsContext, r: HelpRow, attendanceId: string | undefined): ActionSpec[] {
  const resolver = has(ctx, "resolve");
  const late = r.type === "I Am Late Today";
  const a: ActionSpec[] = [];
  if (r.status === "Pending")
    a.push({
      id: "approve",
      l: "Approve",
      primary: true,
      why: resolver ? undefined : "Only admin approves help requests",
      prompt: {
        title: "Approve help request",
        sub: r.type,
        submit: "Approve",
        init: { remark: r.adminRemark ?? "" },
        fields: [{ k: "remark", l: "Admin remark", t: "area", req: late, hint: late ? "Required for I Am Late Today." : undefined }],
      },
    });
  if (resolver)
    a.push({ id: "remark", l: "Admin remark", prompt: { title: "Admin remark", submit: "Save", init: { remark: r.adminRemark ?? "" }, fields: [{ k: "remark", l: "Remark", t: "area", req: true }] } });
  if (ATTENDANCE_TYPES.includes(r.type))
    a.push({
      id: "openDay",
      l: "Open attendance day",
      /* The day it is about may not exist yet (I Forgot Make Attendance): then the register from that date. */
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
  if (body.length < 10) return fieldErr("text", "Say a little more — what happened, or what you would like.");
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
          { k: "remark", l: "Admin remark", t: "t" },
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
          { l: "Admin remark", v: r.adminRemark ?? "" },
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
      if (!has(ctx, "resolve")) return err("Only admin approves help requests", "not_permitted");
      const [r] = await db.select().from(hrmsHelp).where(eq(hrmsHelp.id, id));
      if (!r) return err("That request no longer exists.", "not_found");
      if (r.status !== "Pending") return err("Already approved.");
      const remark = text(v.remark);
      if (r.type === "I Am Late Today" && !remark) return fieldErr("remark", "Admin remark is required for I Am Late Today.");
      await db
        .update(hrmsHelp)
        .set({ status: "Approved", adminRemark: remark ?? r.adminRemark, decidedAt: new Date(), decidedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsHelp.id, id));
      await hrmsAudit(ctx, "hrms.help.approve", "hrms_help", id, { status: r.status }, { status: "Approved", remark });
      const to = await userIdsFor([r.employeeId]);
      await tell(to.map((userId) => ({ userId, title: "Help request approved", body: `${r.type}${remark ? ` · ${remark}` : ""}`, href: hrmsLink("help", { open: id }) })));
      return okVoid(ATTENDANCE_TYPES.includes(r.type) ? "Approved · set the check-in time on the attendance day" : "Approved");
    },
    async remark(ctx, id, v) {
      if (!has(ctx, "resolve")) return err("Only admin writes the admin remark", "not_permitted");
      const remark = text(v.remark);
      if (!remark) return fieldErr("remark", "Remark is required");
      const res = await db.update(hrmsHelp).set({ adminRemark: remark, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsHelp.id, id)).returning({ id: hrmsHelp.id });
      if (!res.length) return err("That request no longer exists.", "not_found");
      await hrmsAudit(ctx, "hrms.help.remark", "hrms_help", id, null, { remark });
      return okVoid("Remark saved");
    },
    async delete(ctx, id) {
      const [r] = await db.select().from(hrmsHelp).where(eq(hrmsHelp.id, id));
      if (!r) return err("That request no longer exists.", "not_found");
      const own = r.employeeId === ctx.employee?.id && r.status === "Pending";
      if (!own && !has(ctx, "admin")) return err("Only admin deletes a decided request.", "not_permitted");
      await db.delete(hrmsHelp).where(eq(hrmsHelp.id, id));
      await hrmsAudit(ctx, "hrms.help.delete", "hrms_help", id, r, null);
      return okVoid("Help request deleted");
    },
  },
  forms: {
    async new(ctx, h) {
      const type = text(h.type);
      if (!type || !HELP_TYPES.includes(type)) return fieldErr("type", "What happened is required");
      const body = text(h.text);
      if (!body) return fieldErr("text", "Details are required");
      if (type === APP_ISSUE) return appIssue(ctx, body, text(h.shot));
      const me = ctx.employee;
      if (!me) return noEmployee();
      const inTime = IN_TYPES.includes(type) ? text(h.inTime) : null;
      const outTime = OUT_TYPES.includes(type) ? text(h.outTime) : null;
      if (IN_TYPES.includes(type) && tmin(inTime) == null) return fieldErr("inTime", "In time is required");
      if (OUT_TYPES.includes(type) && tmin(outTime) == null) return fieldErr("outTime", "Out time is required");
      const id = hrmsId("hhlp");
      await db.insert(hrmsHelp).values({ id, date: today(), employeeId: me.id, type, inTime, outTime, text: body, status: "Pending", createdById: ctx.user.id });
      await hrmsAudit(ctx, "hrms.help.raise", "hrms_help", id, null, { type });
      const to = (await resolverUserIds()).filter((u) => u !== ctx.user.id);
      await tell(to.map((userId) => ({ userId, title: `Help request from ${me.name}`, body: `${type} · ${body}`, kind: "warn", href: hrmsLink("help", { scope: "all", open: id }) })));
      return okVoid("Help request sent to admin");
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
      why: has(ctx, "resolve") || addressee ? undefined : "The person it is addressed to, or admin, solves it",
      prompt: { title: "Give solution", sub: r.issue, submit: "Mark solved", fields: [{ k: "solution", l: "Solution", t: "area", req: true }] },
    });
  if (raiser && r.status === "Solve" && !r.stars)
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
      if (!has(ctx, "resolve") && !addressee) return err("The person it is addressed to, or admin, solves it", "not_permitted");
      if (r.status !== "Pending") return err("Already solved.");
      const solution = text(v.solution);
      if (!solution) return fieldErr("solution", "Solution is required");
      await db.update(hrmsGrievances).set({ status: "Solve", solution, solvedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsGrievances.id, id));
      await hrmsAudit(ctx, "hrms.grievance.solve", "hrms_grievances", id, { status: r.status }, { status: "Solve", solution });
      const to = await userIdsFor([r.byEmployeeId]);
      await tell(to.map((userId) => ({ userId, title: `Grievance #${r.no} solved`, body: solution, href: hrmsLink("grievances", { open: id }) })));
      const raiser = (await allPeople()).find((x) => x.id === r.byEmployeeId);
      return okVoid(`Solved · ${first(raiser?.name)} can give feedback`);
    },
    async feedback(ctx, id, v) {
      const [r] = await db.select().from(hrmsGrievances).where(eq(hrmsGrievances.id, id));
      if (!r) return err("That grievance no longer exists.", "not_found");
      if (r.byEmployeeId !== ctx.employee?.id) return err("Only the person who raised it gives feedback.", "not_permitted");
      if (r.status !== "Solve") return err("Feedback is given once it is solved.");
      if (r.stars) return err("Feedback already given.");
      const n = Number(String(v.stars ?? "").trim()[0]);
      if (!(n >= 1 && n <= 5)) return fieldErr("stars", "Stars is required");
      await db.update(hrmsGrievances).set({ stars: n, feedbackAt: new Date(), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsGrievances.id, id));
      await hrmsAudit(ctx, "hrms.grievance.feedback", "hrms_grievances", id, null, { stars: n });
      return okVoid("Thanks for the feedback");
    },
    async delete(ctx, id) {
      if (!has(ctx, "admin")) return err("Only admin deletes a grievance", "not_permitted");
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
      if (!to) return fieldErr("to", "To is required");
      const issue = text(h.issue);
      if (!issue) return fieldErr("issue", "Issue is required");
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
      if (!recordId) return err("Which grievance?", "not_found");
      const [r] = await db.select().from(hrmsGrievances).where(eq(hrmsGrievances.id, recordId));
      if (!r) return err("That grievance no longer exists.", "not_found");
      if (!mayEditGrievance(ctx, r)) return err("Only admin, or the person who raised it while it is pending, edits a grievance.", "not_permitted");
      const to = grievanceTo(h.to, await allPeople(), r.byEmployeeId);
      if (!to) return fieldErr("to", "To is required");
      const issue = text(h.issue);
      if (!issue) return fieldErr("issue", "Issue is required");
      await db.update(hrmsGrievances).set({ toLabel: to.label, toEmployeeId: to.employeeId, issue, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsGrievances.id, recordId));
      await hrmsAudit(ctx, "hrms.grievance.edit", "hrms_grievances", recordId, { to: r.toLabel, issue: r.issue }, { to: to.label, issue });
      return okVoid("Grievance updated");
    },
  },
};

/* ============================================================ documents §17.1 */

const DOC_TYPES = ["PDF & audio", "Image", "Video", "Link"];
const manageDocs = (ctx: HrmsContext) => has(ctx, "hr") || has(ctx, "admin");

type DocRow = typeof hrmsDocuments.$inferSelect;

/** Whether a document is tagged to this person: everyone, field staff, their office, or by name. */
function docFor(d: DocRow, me: HrmsContext["employee"]): boolean {
  if (d.tagged === "All employees") return true;
  if (!me) return false;
  if (d.taggedEmployeeIds.includes(me.id)) return true;
  if (d.tagged === "Field staff") return isSales({ positionType: me.positionType } as Person);
  return !!me.office && d.tagged === me.office;
}

const docHref = (d: DocRow) => (d.type === "Link" ? (d.url ?? "") : d.fileAttachmentId ? `/api/attachments/${d.fileAttachmentId}` : "");
const openLabel: Record<string, string> = { Link: "Open link", Video: "Open video", Image: "Open image", "PDF & audio": "Open PDF & Audio" };

const documents: HrmsScreenModule = {
  key: "documents",
  async load(ctx) {
    const manager = manageDocs(ctx);
    const all = await db.select().from(hrmsDocuments).orderBy(desc(hrmsDocuments.date));
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
          { k: "tagged", l: "Tagged", t: "t" },
        ],
        hidden: [],
        chips: "type",
        sortDefault: ["date", -1],
        newForm: manager
          ? {
              screen: "documents",
              id: "new",
              title: "Add a document",
              sub: "Tag who should see it.",
              submit: "Add document",
              init: { tagged: "All employees" },
              header: [
                { k: "title", l: "Title", t: "text", req: true },
                { k: "type", l: "Type", t: "select", req: true, opts: DOC_TYPES },
                { k: "file", l: "File", t: "photo", req: true, when: { k: "type", in: ["PDF & audio", "Image", "Video"] } },
                { k: "url", l: "Link", t: "text", req: true, when: { k: "type", eq: "Link" }, hint: "An http:// or https:// address." },
                { k: "desc", l: "Description", t: "area" },
                { k: "tagged", l: "Tagged employees", t: "select", req: true, opts: ["All employees", "Field staff", ...officeNames] },
              ],
            }
          : undefined,
        newLabel: "Add document",
        noDataLine: manager ? "No documents yet." : "No documents are tagged to you yet.",
      },
      rows: rows.map((d): ListRow => {
        const href = docHref(d);
        const named = d.taggedEmployeeIds.map((id) => people.get(id)?.name).filter(Boolean).join(", ");
        const actions: ActionSpec[] = [href ? { id: "open", l: "Open", primary: true, href } : { id: "open", l: "Open", primary: true, why: "Nothing was attached to this document" }];
        if (manager) actions.push({ id: "delete", l: "Delete", confirm: `Delete “${d.title}”?` });
        const fields: RowField[] = [{ l: "File or link", v: d.type === "Link" ? (d.url ?? "") : d.fileAttachmentId ? "Attached" : "None" }];
        if (named) fields.push({ l: "Tagged by name", v: named });
        return {
          id: d.id,
          v: { title: d.title, type: d.type, desc: d.description ?? "", date: d.date, tagged: d.tagged },
          flags: [],
          title: d.title,
          header: `${d.type} · ${d.tagged}`,
          fields,
          contacts: href ? [{ l: openLabel[d.type] ?? "Open", href }] : [],
          actions,
          by: stampLine(creators.get(d.createdById ?? "") ?? null, d.createdAt),
        };
      }),
    };
  },
  actions: {
    async delete(ctx, id) {
      if (!manageDocs(ctx)) return err("Only HR or admin deletes a document", "not_permitted");
      const [d] = await db.select().from(hrmsDocuments).where(eq(hrmsDocuments.id, id));
      if (!d) return err("That document no longer exists.", "not_found");
      await db.delete(hrmsDocuments).where(eq(hrmsDocuments.id, id));
      await hrmsAudit(ctx, "hrms.document.delete", "hrms_documents", id, d, null);
      return okVoid("Document deleted");
    },
  },
  forms: {
    async new(ctx, h) {
      if (!manageDocs(ctx)) return err("Only HR or admin adds documents", "not_permitted");
      const title = text(h.title);
      if (!title) return fieldErr("title", "Title is required");
      const type = text(h.type);
      if (!type || !DOC_TYPES.includes(type)) return fieldErr("type", "Type is required");
      const url = type === "Link" ? text(h.url) : null;
      const file = type === "Link" ? null : text(h.file);
      if (type === "Link" && !url) return fieldErr("url", "Link is required");
      if (url && !/^https?:\/\//i.test(url)) return fieldErr("url", "INVALID");
      if (type !== "Link" && !file) return fieldErr("file", "File is required");
      const tagged = text(h.tagged) ?? "All employees";
      const officeNames = (await offices()).map((o) => o.name);
      if (!["All employees", "Field staff", ...officeNames].includes(tagged)) return fieldErr("tagged", "Tagged employees is required");
      const id = hrmsId("hdoc");
      const res = await inTx(async (tx) => {
        await tx.insert(hrmsDocuments).values({ id, title, type, fileAttachmentId: file, url, description: text(h.desc), date: today(), tagged, createdById: ctx.user.id });
        if (file) await bindHrmsFiles(tx, [file], "hrms_document", id, ctx.user.id);
        return okVoid(`Document added for ${tagged.toLowerCase()}`);
      });
      if (res.ok) await hrmsAudit(ctx, "hrms.document.add", "hrms_documents", id, null, { title, type, tagged });
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
    const toMe = (n: NoteRow) => n.toEmployeeId == null || (!!me && n.toEmployeeId === me);
    const fromMe = (n: NoteRow) => n.createdById === ctx.user.id || (!!me && n.fromEmployeeId === me);
    const rows = scope === "all" ? all : all.filter((n) => toMe(n) || fromMe(n));
    const people = await allPeople();
    const pb = byId(people);
    return {
      spec: {
        screen: "notifications",
        cols: [
          { k: "time", l: "Time", t: "t" },
          { k: "from", l: "From", t: "t" },
          { k: "to", l: "To", t: "t" },
          { k: "text", l: "Message", t: "b" },
          { k: "landing", l: "Opens", t: "t" },
          { k: "seen", l: "Seen", t: "s" },
        ],
        hidden: [],
        newForm: writeNotes(ctx)
          ? {
              screen: "notifications",
              id: "new",
              title: "Write a notification",
              sub: "It arrives in the MahekOne bell and opens the screen you choose.",
              submit: "Send notification",
              init: { landing: hrmsListLabel("home") },
              header: [
                { k: "to", l: "To", t: "select", req: true, opts: ["All employees", ...people.filter(isActive).map(personOption)] },
                { k: "text", l: "Message", t: "area", req: true, mic: true },
                { k: "landing", l: "Opens", t: "select", req: true, opts: LANDINGS.map((s) => s.label) },
              ],
            }
          : undefined,
        newLabel: "Write a notification",
        noDataLine: "No notifications sent or received yet.",
        hrms: { scope: { current: scope, options } },
      },
      rows: rows.map((n): ListRow => {
        const personal = n.toEmployeeId != null;
        const sender = fromMe(n);
        const contacts: Contact[] = [];
        const s = mailto(n.fromEmployeeId ? pb.get(n.fromEmployeeId)?.email : null, n.text);
        const r = mailto(n.toEmployeeId ? pb.get(n.toEmployeeId)?.email : null, n.text);
        if (s) contacts.push({ l: "Email sender", href: s });
        if (r) contacts.push({ l: "Email receiver", href: r });
        const actions: ActionSpec[] = [];
        if (n.landing) actions.push({ id: "open", l: `Open ${landingLabel(n.landing)}`, primary: true, href: hrmsLink(n.landing) });
        if (personal && !!me && n.toEmployeeId === me && !n.seenAt) actions.push({ id: "seen", l: "Mark seen" });
        if (sender) actions.push({ id: "edit", l: "Edit", prompt: { title: "Edit notification", submit: "Save", init: { text: n.text }, fields: [{ k: "text", l: "Message", t: "area", req: true }] } });
        if (sender || admin) actions.push({ id: "delete", l: "Delete", confirm: "Delete this notification?" });
        const fields: RowField[] = [
          { l: "To", v: n.toLabel },
          { l: "Opens", v: landingLabel(n.landing) },
        ];
        if (n.seenAt) fields.push({ l: "Seen", v: when(n.seenAt) });
        return {
          id: n.id,
          /* "All employees" has no one reader, so it carries no seen state. */
          v: { time: when(n.createdAt), from: n.fromName, to: n.toLabel, text: n.text, landing: landingLabel(n.landing), seen: personal ? (n.seenAt ? "Seen" : "Unseen") : "" },
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
      if (!ctx.employee || n.toEmployeeId !== ctx.employee.id) return err("Only the person it was sent to marks it seen.", "not_permitted");
      if (!n.seenAt) await db.update(hrmsNotifications).set({ seenAt: new Date(), updatedAt: new Date() }).where(eq(hrmsNotifications.id, id));
      return okVoid("Marked seen");
    },
    async edit(ctx, id, v) {
      const [n] = await db.select().from(hrmsNotifications).where(eq(hrmsNotifications.id, id));
      if (!n) return err("That notification no longer exists.", "not_found");
      if (!(n.createdById === ctx.user.id || (!!ctx.employee && n.fromEmployeeId === ctx.employee.id))) return err("Only the sender edits a notification.", "not_permitted");
      const body = text(v.text);
      if (!body) return fieldErr("text", "Message is required");
      await db.update(hrmsNotifications).set({ text: body, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsNotifications.id, id));
      await hrmsAudit(ctx, "hrms.notification.edit", "hrms_notifications", id, { text: n.text }, { text: body });
      return okVoid("Notification updated");
    },
    async delete(ctx, id) {
      const [n] = await db.select().from(hrmsNotifications).where(eq(hrmsNotifications.id, id));
      if (!n) return err("That notification no longer exists.", "not_found");
      const sender = n.createdById === ctx.user.id || (!!ctx.employee && n.fromEmployeeId === ctx.employee.id);
      if (!sender && !has(ctx, "admin")) return err("Only the sender or admin deletes a notification.", "not_permitted");
      await db.delete(hrmsNotifications).where(eq(hrmsNotifications.id, id));
      await hrmsAudit(ctx, "hrms.notification.delete", "hrms_notifications", id, n, null);
      return okVoid("Notification deleted");
    },
  },
  forms: {
    async new(ctx, h) {
      if (!writeNotes(ctx)) return err("Only HR or admin writes notifications", "not_permitted");
      const body = text(h.text);
      if (!body) return fieldErr("text", "Message is required");
      const landing = LANDINGS.find((s) => s.label === h.landing || s.key === h.landing);
      if (!landing) return fieldErr("landing", "Opens is required");
      const toV = text(h.to);
      if (!toV) return fieldErr("to", "To is required");
      let toEmp: Person | undefined;
      if (toV !== "All employees") {
        toEmp = personFrom(toV, await allPeople());
        if (!toEmp || !isActive(toEmp)) return fieldErr("to", "invalid Name");
      }
      const fromName = ctx.employee?.name ?? ctx.user.name;
      const id = hrmsId("hntf");
      await db.insert(hrmsNotifications).values({
        id,
        fromEmployeeId: ctx.employee?.id ?? null,
        fromName,
        toEmployeeId: toEmp?.id ?? null,
        toLabel: toEmp?.name ?? "All employees",
        text: body,
        landing: landing.key,
        createdById: ctx.user.id,
      });
      await hrmsAudit(ctx, "hrms.notification.send", "hrms_notifications", id, null, { to: toEmp?.code ?? "All employees", landing: landing.key });
      /* Delivery is MahekOne's bell (§18.4): titled with the sender, the text as body, opening the landing screen. */
      const recipients = (toEmp ? await userIdsFor([toEmp.id]) : await hrmsUserIds()).filter((u) => u !== ctx.user.id);
      await tell(recipients.map((userId) => ({ userId, title: fromName, body, href: hrmsLink(landing.key) })));
      const unreached = toEmp && !recipients.length ? ` · ${toEmp.name} has no MahekOne account yet, so it reached no bell` : "";
      return okVoid(`Notification sent to ${toEmp?.name ?? "all employees"}${unreached}`);
    },
  },
};

/* ========================================================= reference lists §3 */

const refLists: HrmsScreenModule = {
  key: "refLists",
  async load(ctx) {
    const why = has(ctx, "admin") ? undefined : "Only an HRMS administrator edits the value lists";
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
        noDataLine: "No value lists yet.",
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
      if (!has(ctx, "admin")) return err("Only an HRMS administrator edits the value lists", "not_permitted");
      const value = text(v.v);
      if (!value) return fieldErr("v", "Value is required");
      const [r] = await db.select().from(hrmsRefLists).where(eq(hrmsRefLists.list, list));
      if (!r) return err("That list no longer exists.", "not_found");
      if (r.values.some((x) => x.trim().toLowerCase() === value.toLowerCase())) return fieldErr("v", "Duplicate Entry!");
      await db.update(hrmsRefLists).set({ values: [...r.values, value], updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsRefLists.list, list));
      await hrmsAudit(ctx, "hrms.refList.add", "hrms_ref_lists", list, null, { value });
      return okVoid(`Added “${value}” to ${list}`);
    },
    async remove(ctx, list, v) {
      if (!has(ctx, "admin")) return err("Only an HRMS administrator edits the value lists", "not_permitted");
      const value = text(v.v);
      const [r] = await db.select().from(hrmsRefLists).where(eq(hrmsRefLists.list, list));
      if (!r) return err("That list no longer exists.", "not_found");
      if (!value || !r.values.includes(value)) return fieldErr("v", "Value is required");
      await db.update(hrmsRefLists).set({ values: r.values.filter((x) => x !== value), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsRefLists.list, list));
      await hrmsAudit(ctx, "hrms.refList.remove", "hrms_ref_lists", list, { value }, null);
      return okVoid(`Removed “${value}” from ${list}`);
    },
  },
};

export const MISC_SCREENS: HrmsScreenModule[] = [help, grievances, documents, notifications, refLists];
