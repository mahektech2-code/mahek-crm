import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  employeeReporting,
  employees,
  hrmsAssetAssignments,
  hrmsAssetStock,
  hrmsLeaveCredits,
  hrmsOffices,
  hrmsStaffTimings,
  hrmsTaskTemplates,
  sessions,
} from "@/db/schema";
import { has, hrmsContext } from "@/lib/hrms/access";
import { first } from "@/lib/hrms/server";
import { fdShort } from "@/lib/hrms/time";
import { assetLotRefusal, canTimings, employeeDeleteRefusal, officeDeleteRefusal } from "@/lib/hrms/screens/people";
import { impactBatchIds } from "../batch-key";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { many, present } from "./erp-common";
import { countOf, employeeName, hrmsMayAct, linkedUsers, typeable } from "./hrms-common";

/* ---------------------------------------------------------------------------
 * HRMS's people: an employee deleted or deactivated, an ID card, an office, a
 * weekday timing, a stock lot and an asset assignment.
 *
 * An employee is the one record here that reaches past HRMS: the MahekOne
 * account linked to it, its open sessions, and the org chart other people are
 * placed on. Deleting is refused while the person has any history at all —
 * every HRMS table cascades from them — so what a delete that IS allowed takes
 * is configuration: timings, task templates, leave credits, reporting lines.
 * Deactivating is the everyday act, and the one whose reach is easy to miss:
 * it switches sign-ins off and ends sessions, and keeps everything else.
 * ------------------------------------------------------------------------- */

/* ================================================================ employee */

export const employeeDeleteImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["employees"], (ctx) => (has(ctx, "admin") ? null : "Deleting an employee needs the HRMS administration power"));
  },

  async report(id) {
    const [e] = await db.select().from(employees).where(eq(employees.id, id));
    if (!e) return null;
    const refused = await employeeDeleteRefusal(e);
    const [timings, templates, credits, manager, reports, accounts] = await Promise.all([
      db.select({ weekday: hrmsStaffTimings.weekday }).from(hrmsStaffTimings).where(eq(hrmsStaffTimings.employeeId, id)),
      db.select({ task: hrmsTaskTemplates.task }).from(hrmsTaskTemplates).where(eq(hrmsTaskTemplates.employeeId, id)).orderBy(asc(hrmsTaskTemplates.serial)),
      db.select({ month: hrmsLeaveCredits.month }).from(hrmsLeaveCredits).where(eq(hrmsLeaveCredits.employeeId, id)),
      db.select({ id: employeeReporting.id }).from(employeeReporting).where(eq(employeeReporting.employeeId, id)),
      db
        .select({ name: employees.name })
        .from(employeeReporting)
        .innerJoin(employees, eq(employees.id, employeeReporting.employeeId))
        .where(eq(employeeReporting.managerId, id))
        .orderBy(asc(employees.name)),
      linkedUsers([id]),
    ]);
    const items: ImpactItem[] = [
      { app: "HRMS", label: many(timings.length, "weekday timing"), effect: "deleted", count: timings.length, examples: timings.map((t) => t.weekday).slice(0, 5) },
      { app: "HRMS", label: many(templates.length, "task template"), effect: "deleted", count: templates.length, examples: templates.slice(0, 5).map((t) => t.task) },
      { app: "HRMS", label: many(credits.length, "leave credit"), effect: "deleted", count: credits.length },
      { app: "HRMS", label: "line to their manager on the org chart", effect: "deleted", count: manager.length },
      {
        app: "HRMS",
        label: many(reports.length, "person who reports to them", "people who report to them"),
        effect: "unlinked",
        count: reports.length,
        examples: reports.slice(0, 5).map((r) => r.name),
        note: "They are left with no manager on the org chart, and drop out of whoever’s team they reached through this person.",
      },
      {
        app: "Admin Console",
        label: many(accounts.length, "MahekOne account"),
        effect: "unlinked",
        count: accounts.length,
        examples: accounts.slice(0, 5).map((u) => u.name),
        note: "The account is kept and keeps its apps; it is no longer linked to an employee record, so HRMS and payroll no longer know it as this person.",
      },
    ];
    return {
      title: `${e.name} (${e.employeeCode})`,
      verb: "Delete",
      confirmWord: typeable(e.name, "DELETE"),
      items: refused ? [] : present(items),
      blockers: refused ? [refused] : [],
    };
  },
};

/* ============================================================== deactivate */

/** The id is the selection's batch key — one employee from their record, several from the list. */
export const employeeDeactivateImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["employees"], (ctx) => (has(ctx, "hr") ? null : "Deactivating an employee needs the HR power"));
  },

  async report(key) {
    const ids = impactBatchIds(key);
    if (!ids.length) return null;
    const rows = await db
      .select({ id: employees.id, name: employees.name, status: employees.status, leaving: employees.dateOfLeaving })
      .from(employees)
      .where(inArray(employees.id, ids))
      .orderBy(asc(employees.name));
    if (!rows.length) return null;
    /* The act's own refusal, in its own words: the person is in the selection. */
    const ctx = await hrmsContext();
    const self = !!ctx.employee && ids.includes(ctx.employee.id);
    const change = rows.filter((r) => r.status !== "inactive");
    const accounts = (await linkedUsers(change.map((r) => r.id))).filter((u) => u.active);
    const open = accounts.length
      ? await db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.userId, accounts.map((u) => u.id)))
      : [];
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: many(change.length, "employee marked inactive", "employees marked inactive"),
        effect: "changed",
        count: change.length,
        examples: change.slice(0, 5).map((r) => r.name),
        note: "They leave the active lists, the absentee list and the monthly leave credit; a leaving date of today is set where none is recorded. Their attendance, leave and pay history stays.",
      },
      {
        app: "Admin Console",
        label: many(accounts.length, "MahekOne sign-in switched off", "MahekOne sign-ins switched off"),
        effect: "changed",
        count: accounts.length,
        examples: accounts.slice(0, 5).map((u) => u.name),
        note: "They can no longer sign in to any app. Their apps and grants are kept, for the day they come back.",
      },
      {
        app: "Admin Console",
        label: many(open.length, "open session ended", "open sessions ended"),
        effect: "deleted",
        count: open.length,
      },
    ];
    const one = rows.length === 1 ? rows[0] : null;
    return {
      title: one ? one.name : `${rows.length} employees`,
      verb: "Deactivate",
      confirmWord: one ? typeable(one.name, "DEACTIVATE") : "DEACTIVATE",
      items: present(items),
      blockers: self ? ["You cannot deactivate your own record."] : [],
    };
  },
};

/* ================================================================= ID card */

export const idCardImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["idCards"], (ctx) => (has(ctx, "admin") ? null : "Removing an ID card needs the HRMS administration power"));
  },

  /* The card is one image on one record; removing it marks the file removed
     and retention decides the bytes. Nothing else reads it. */
  async report(id) {
    const [e] = await db.select({ name: employees.name, card: employees.idCardAttachmentId }).from(employees).where(eq(employees.id, id));
    if (!e?.card) return null;
    return { title: `${e.name}’s ID card image`, verb: "Remove", confirmWord: "REMOVE", items: [], blockers: [] };
  },
};

/* ================================================================== office */

export const officeImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["offices"], (ctx) => (has(ctx, "admin") ? null : "Deleting an office needs the HRMS administration power"));
  },

  async report(id) {
    const [o] = await db.select().from(hrmsOffices).where(eq(hrmsOffices.id, id));
    if (!o) return null;
    const refused = await officeDeleteRefusal(o);
    const former = await countOf(sql`select count(*)::int as n from employees where office_name = ${o.name} and status <> 'active'`);
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: "attendance QR code",
        effect: "deleted",
        count: o.qrText ? 1 : 0,
        note: "Scanning it no longer checks anybody in — take the printed code down.",
      },
      {
        app: "HRMS",
        label: many(former, "former employee’s record", "former employees’ records"),
        effect: "kept",
        count: former,
        note: `They still name ${o.name} as their office, as their attendance days do.`,
      },
    ];
    return {
      title: o.name,
      verb: "Delete",
      confirmWord: typeable(o.name, "DELETE"),
      items: refused ? [] : present(items),
      blockers: refused ? [refused] : [],
    };
  },
};

/* ================================================================== timing */

export const timingImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["timings"], (ctx) => (canTimings(ctx) ? null : "Deleting timings needs the “Set staff timings” or HR power"));
  },

  async report(id) {
    const [r] = await db.select().from(hrmsStaffTimings).where(eq(hrmsStaffTimings.id, id));
    if (!r) return null;
    const name = await employeeName(r.employeeId);
    /* A day is stamped with the official times in force when it was recorded. */
    const stamped = await countOf(sql`select count(*)::int as n from hrms_attendance
       where employee_id = ${r.employeeId} and to_char(date, 'FMDay') = ${r.weekday} and official_in is not null`);
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: "weekday with no official in time",
        effect: "changed",
        count: 1,
        note: `From the next ${r.weekday}, ${first(name)}’s check-in has no official in or out time, so lateness is not measured and the day carries no target hours.`,
      },
      {
        app: "HRMS",
        label: many(stamped, `${r.weekday} already recorded`, `${r.weekday}s already recorded`),
        effect: "kept",
        count: stamped,
        note: "Days already recorded keep the timing they were stamped with.",
      },
    ];
    return {
      title: `${name}’s ${r.weekday} timing (${r.inTime} – ${r.outTime})`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: present(items),
      blockers: [],
    };
  },
};

/* =============================================================== stock lot */

export const assetLotImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["assetStock"], (ctx) => (has(ctx, "hr") ? null : "Managing the asset stock needs the HR power"));
  },

  /* A lot nobody was ever given anything from is a purchase record and its two
     images; with assignments it is refused, because it would erase who holds it. */
  async report(id) {
    const [s] = await db.select().from(hrmsAssetStock).where(eq(hrmsAssetStock.id, id));
    if (!s) return null;
    const refused = await assetLotRefusal(s);
    return {
      title: `${s.code} — ${s.qty} × ${s.name}`,
      verb: "Delete",
      confirmWord: typeable(s.code, "DELETE"),
      items: [],
      blockers: refused ? [refused] : [],
    };
  },
};

/* ============================================================== assignment */

export const assetAssignmentImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["assignments"], (ctx) => (has(ctx, "admin") ? null : "Deleting an assignment needs the HRMS administration power"));
  },

  async report(id) {
    const [x] = await db
      .select({ a: hrmsAssetAssignments, name: hrmsAssetStock.name, code: hrmsAssetStock.code })
      .from(hrmsAssetAssignments)
      .innerJoin(hrmsAssetStock, eq(hrmsAssetStock.id, hrmsAssetAssignments.stockId))
      .where(and(eq(hrmsAssetAssignments.id, id)));
    if (!x) return null;
    const who = await employeeName(x.a.employeeId);
    /* What the lot counts as given out is what has not come back. */
    const out = Math.max(0, x.a.qty - (x.a.restoredQty ?? 0));
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: many(out, "unit back in stock", "units back in stock"),
        effect: "changed",
        count: out,
        note: `${x.name} · ${x.code} counts them as available again, though nothing says ${first(who)} handed them back.`,
      },
    ];
    return {
      title: `${x.a.qty} × ${x.name} (${x.code}) given to ${who}, ${fdShort(x.a.date)}`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: present(items),
      blockers: [],
    };
  },
};
