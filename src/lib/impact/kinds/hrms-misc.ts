import "server-only";
import { and, eq, isNotNull, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { hrmsAttendance, hrmsGrievances, hrmsHelp, hrmsNotifications, mbosDocuments } from "@/db/schema";
import { has } from "@/lib/hrms/access";
import { fdShort } from "@/lib/hrms/time";
import { manageDocs } from "@/lib/hrms/screens/misc";
import { bellsOf } from "@/lib/services/announcement-service";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { many, present } from "./erp-common";
import { countOf, employeeName, hrmsMayAct, typeable } from "./hrms-common";

/* ---------------------------------------------------------------------------
 * HRMS's conversations and the company library: a help request, a grievance,
 * a document and an announcement.
 *
 * The first two are records of somebody asking; deleting one takes the asking
 * and nothing else, though an approved help request may already have written
 * its times onto an attendance day, and that correction stays. The last two
 * leave the screen they were pressed on: a document withdrawn comes off every
 * handset that pulled it, and an announcement deleted comes out of the bell of
 * everybody it reached — in the office and on the phones.
 * ------------------------------------------------------------------------- */

/* ============================================================== help request */

export const helpRequestImpact: ImpactSource = {
  authorize: async (id) => {
    await hrmsMayAct(["help"], async (ctx) => {
      const [r] = await db.select({ employeeId: hrmsHelp.employeeId, status: hrmsHelp.status }).from(hrmsHelp).where(eq(hrmsHelp.id, id));
      if (!r) return null;
      const own = r.employeeId === ctx.employee?.id && r.status === "Pending";
      return own || has(ctx, "admin") ? null : "Only a pending request of your own can be deleted. Deleting any other needs the HRMS administration power.";
    });
  },

  async report(id) {
    const [r] = await db.select().from(hrmsHelp).where(eq(hrmsHelp.id, id));
    if (!r) return null;
    const name = await employeeName(r.employeeId);
    /* `correctDayFromHelp` marks the day it wrote with the request's type, so
       the day this request corrected is the one carrying that mark. */
    const corrected =
      r.status === "Approved"
        ? await db
            .select({ id: hrmsAttendance.id })
            .from(hrmsAttendance)
            .where(and(eq(hrmsAttendance.employeeId, r.employeeId), eq(hrmsAttendance.date, r.date), like(hrmsAttendance.remark, `%From help request: ${r.type}%`)))
        : [];
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: "attendance day it corrected",
        effect: "kept",
        count: corrected.length,
        note: `The times approving it wrote onto ${fdShort(r.date)} stay on the day — correct the day itself to change them.`,
      },
    ];
    return {
      title: `${name}’s help request “${r.type}”, ${fdShort(r.date)}`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: present(items),
      blockers: [],
    };
  },
};

/* ================================================================= grievance */

export const grievanceImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["grievances"], (ctx) => (has(ctx, "admin") ? null : "Deleting a grievance needs the HRMS administration power"));
  },

  /* A grievance is the conversation itself — the issue, the solution and the
     stars — and nothing else hangs off it. */
  async report(id) {
    const [r] = await db.select().from(hrmsGrievances).where(eq(hrmsGrievances.id, id));
    if (!r) return null;
    const name = await employeeName(r.byEmployeeId);
    return {
      title: `grievance #${r.no} from ${name}`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: [],
      blockers: [],
    };
  },
};

/* ================================================================== document */

export const documentWithdrawImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["documents"], (ctx) => (manageDocs(ctx) ? null : "Withdrawing a document needs the HR or HRMS administration power"));
  },

  async report(id) {
    const [d] = await db.select().from(mbosDocuments).where(and(eq(mbosDocuments.id, id), isNotNull(mbosDocuments.audience)));
    if (!d) return null;
    /* An empty role list is the field app's "everybody"; HR's own documents
       for the office carry `hrms` and never reach a phone. Named people narrow
       it, as they narrow what the handset pulls. */
    const onPhones = d.visibleToRoles.length === 0;
    const phones = onPhones
      ? await countOf(sql`select count(distinct u.id)::int as n from users u
           join app_access a on a.user_id = u.id and a.app = 'field'
          where u.active
            ${d.visibleToUserIds.length ? sql`and u.id in ${d.visibleToUserIds}` : sql``}`)
      : 0;
    const items: ImpactItem[] = [
      {
        app: "MBOS handsets",
        label: many(phones, "salesman’s phone", "salesmen’s phones"),
        effect: "phones",
        count: phones,
        note: "It comes off their document library on the next sync.",
      },
      {
        app: "HRMS",
        label: "document and its file",
        effect: "kept",
        count: 1,
        note: `Kept on HR’s list, marked withdrawn — a policy somebody quoted is a fact about when they quoted it. It no longer shows to ${d.audience ?? "its audience"}.`,
      },
    ];
    return {
      title: `“${d.title}”`,
      verb: "Withdraw",
      confirmWord: typeable(d.title, "WITHDRAW"),
      items: present(items),
      /* The act's own refusal, said before the button rather than after it. */
      blockers: d.active ? [] : [`${d.title} is already withdrawn.`],
    };
  },
};

/* ============================================================== announcement */

export const announcementImpact: ImpactSource = {
  authorize: async (id) => {
    await hrmsMayAct(["notifications"], async (ctx) => {
      const [n] = await db.select({ createdById: hrmsNotifications.createdById, fromEmployeeId: hrmsNotifications.fromEmployeeId }).from(hrmsNotifications).where(eq(hrmsNotifications.id, id));
      if (!n) return null;
      const sender = n.createdById === ctx.user.id || (!!ctx.employee && n.fromEmployeeId === ctx.employee.id);
      return sender || has(ctx, "admin") ? null : "Only the sender can delete a notification. Deleting anyone else’s needs the HRMS administration power.";
    });
  },

  async report(id) {
    const [n] = await db.select().from(hrmsNotifications).where(eq(hrmsNotifications.id, id));
    if (!n) return null;
    const bells = await bellsOf(n.bellIds);
    const unread = bells.filter((b) => !b.read).length;
    const items: ImpactItem[] = [
      {
        app: "Notifications",
        label: many(bells.length, "message in somebody’s bell", "messages in people’s bells"),
        effect: "deleted",
        count: bells.length,
        note:
          (unread ? `${unread} of them not read yet. ` : "") +
          "It comes out of the bell in every app, and off the phones of anybody who pulled it, on their next sync.",
      },
    ];
    const text = n.text.length > 60 ? `${n.text.slice(0, 57)}…` : n.text;
    return {
      title: `the announcement to ${n.toLabel}: “${text}”`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: present(items),
      blockers: [],
    };
  },
};
