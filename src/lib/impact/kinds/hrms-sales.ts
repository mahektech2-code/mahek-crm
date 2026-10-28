import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, hrmsActivities, hrmsCalling, hrmsJourneys, hrmsKpi, users } from "@/db/schema";
import { has } from "@/lib/hrms/access";
import { first, today } from "@/lib/hrms/server";
import { fdShort } from "@/lib/hrms/time";
import { calendarDate } from "@/lib/business-date";
import {
  ACTIVITY_DELETE_WHY,
  backOfficeIsMe,
  DELETE_CALL_WHY,
  JOURNEY_DELETE_WHY,
  mayChangeJourney,
  WITHDRAW_WHY,
} from "@/lib/hrms/screens/sales";
import { canTouchKpi, KPI_WHY } from "@/lib/hrms/screens/perf";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { many, present } from "./erp-common";
import { countOf, employeeName, hrmsMayAct } from "./hrms-common";

/* ---------------------------------------------------------------------------
 * HRMS's sales desk: a deactivation request, a calling row, a sales activity,
 * a journey plan and a day's sales entry.
 *
 * Calls and meetings logged here are written onto the customer's shared
 * history as they happen, and deleting the HRMS row does NOT take those
 * entries back — the call happened. That is said as "stays", because it is
 * exactly what somebody pressing Delete on the calling list expects to go.
 * The scores are the other half: a day's sales score is worked out from the
 * entry and the day's activities on every read, so it moves with them.
 * ------------------------------------------------------------------------- */

/** Entries this HRMS row wrote onto a customer's history: the id, or the id and a stage after a colon. */
const historyOf = (recordId: string) =>
  countOf(sql`select count(*)::int as n from timeline_events
     where source_app = 'hrms' and split_part(source_record_id, ':', 1) = ${recordId}`);

/* ==================================================== deactivation request */

export const deactivationRequestImpact: ImpactSource = {
  authorize: async (id) => {
    await hrmsMayAct(["customers"], async (ctx) => {
      const [c] = await db
        .select({ by: customers.deactivationRequestedById, backOfficeAmId: customers.backOfficeAmId, backOfficeName: customers.backOfficeName })
        .from(customers)
        .where(eq(customers.id, id));
      if (!c) return null;
      return has(ctx, "custStatus") || c.by === ctx.user.id || backOfficeIsMe(ctx, c) ? null : WITHDRAW_WHY;
    });
  },

  async report(id) {
    const [c] = await db
      .select({
        name: customers.name,
        requested: customers.deactivationRequested,
        reason: customers.deactivationReason,
        at: customers.deactivationRequestedAt,
        by: users.name,
      })
      .from(customers)
      .leftJoin(users, eq(users.id, customers.deactivationRequestedById))
      .where(eq(customers.id, id));
    if (!c) return null;
    const asked = [c.by ? `Asked by ${c.by}` : "Asked", c.at ? `on ${fdShort(calendarDate(c.at))}` : ""].filter(Boolean).join(" ");
    const items: ImpactItem[] = [
      {
        app: "CRM",
        label: "deactivation request waiting for a decision",
        effect: "deleted",
        count: c.requested ? 1 : 0,
        note: `${asked}${c.reason ? `: “${c.reason}”` : ""}. It comes off the list managers decide deactivations from, its reason is cleared, and ${c.name} stays active.`,
      },
    ];
    return {
      title: `the request to deactivate ${c.name}`,
      verb: "Withdraw",
      confirmWord: "WITHDRAW",
      items: present(items),
      blockers: c.requested ? [] : [`${c.name} has no deactivation request to withdraw.`],
    };
  },
};

/* ============================================================== calling row */

export const callingRowImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["calling"], (ctx) => (has(ctx, "custStatus") ? null : DELETE_CALL_WHY));
  },

  async report(id) {
    const [r] = await db
      .select({ row: hrmsCalling, customer: customers.name })
      .from(hrmsCalling)
      .innerJoin(customers, eq(customers.id, hrmsCalling.customerId))
      .where(eq(hrmsCalling.id, id));
    if (!r) return null;
    const name = await employeeName(r.row.employeeId);
    const history = await historyOf(id);
    const booked = !!r.row.followUp && r.row.followUp >= today();
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: "follow-up booked on the calling list",
        effect: "deleted",
        count: booked ? 1 : 0,
        note: `Booked for ${fdShort(r.row.followUp)}; with the row gone, nothing brings ${r.customer} back to the Follow-ups due tab on that day.`,
      },
      {
        app: "CRM",
        label: many(history, `entry on ${r.customer}’s history`, `entries on ${r.customer}’s history`),
        effect: "kept",
        count: history,
        note: "The calls logged on this row stay on the customer’s record — they happened.",
      },
    ];
    return {
      title: `${first(name)}’s calling row for ${r.customer}, ${fdShort(r.row.date)}`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: present(items),
      blockers: [],
    };
  },
};

/* ================================================================= activity */

export const activityImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["activity"], (ctx) => (has(ctx, "admin") || has(ctx, "hr") ? null : ACTIVITY_DELETE_WHY));
  },

  async report(id) {
    const [r] = await db.select().from(hrmsActivities).where(eq(hrmsActivities.id, id));
    if (!r) return null;
    const name = await employeeName(r.employeeId);
    const [[entry], history] = await Promise.all([
      db.select({ id: hrmsKpi.id }).from(hrmsKpi).where(and(eq(hrmsKpi.employeeId, r.employeeId), eq(hrmsKpi.date, r.date))),
      historyOf(id),
    ]);
    const customer = r.customerName ?? "the customer";
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: "day’s sales entry and score",
        effect: "changed",
        count: entry ? 1 : 0,
        note: `Its time with customers and meeting notes are read from the day’s activities, so ${fdShort(r.date)} loses ${r.minutes} minutes and this note, and the day’s score moves with it.`,
      },
      {
        app: "CRM",
        label: many(history, `entry on ${customer}’s history`, `entries on ${customer}’s history`),
        effect: "kept",
        count: history,
        note: "The meeting stays on the customer’s record — it happened.",
      },
    ];
    return {
      title: `${first(name)}’s ${r.meetType ?? "meeting"} with ${customer}, ${fdShort(r.date)}`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: present(items),
      blockers: [],
    };
  },
};

/* ============================================================ journey plan */

export const journeyImpact: ImpactSource = {
  authorize: async (id) => {
    await hrmsMayAct(["journey"], async (ctx) => {
      const [r] = await db.select({ createdById: hrmsJourneys.createdById, employeeId: hrmsJourneys.employeeId }).from(hrmsJourneys).where(eq(hrmsJourneys.id, id));
      if (!r) return null;
      return mayChangeJourney(ctx, r) ? null : JOURNEY_DELETE_WHY;
    });
  },

  /* A plan is a note of intent: the customers it names are named by id and
     nothing else in MahekOne reads it. */
  async report(id) {
    const [r] = await db.select().from(hrmsJourneys).where(eq(hrmsJourneys.id, id));
    if (!r) return null;
    const name = await employeeName(r.employeeId);
    const when = r.startDate === r.endDate ? fdShort(r.startDate) : `${fdShort(r.startDate)} – ${fdShort(r.endDate)}`;
    return {
      title: `${first(name)}’s journey plan${r.location ? ` to ${r.location}` : ""}, ${when}`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: [],
      blockers: [],
    };
  },
};

/* ============================================================= sales entry */

export const salesEntryImpact: ImpactSource = {
  authorize: async (id) => {
    await hrmsMayAct(["kpi"], async (ctx) => {
      const [k] = await db.select().from(hrmsKpi).where(eq(hrmsKpi.id, id));
      if (!k) return null;
      return canTouchKpi(ctx, k) ? null : KPI_WHY;
    });
  },

  async report(id) {
    const [k] = await db.select().from(hrmsKpi).where(eq(hrmsKpi.id, id));
    if (!k) return null;
    const name = await employeeName(k.employeeId);
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: "day’s sales score",
        effect: "deleted",
        count: 1,
        note: `It is worked out from this entry, so ${fdShort(k.date)} drops out of ${first(name)}’s Sales score tab and the month’s performance points.`,
      },
    ];
    return {
      title: `${name}’s sales entry for ${fdShort(k.date)}`,
      verb: "Delete",
      confirmWord: "DELETE",
      items,
      blockers: [],
    };
  },
};
