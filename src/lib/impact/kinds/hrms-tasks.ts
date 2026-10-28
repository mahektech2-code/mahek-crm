import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { hrmsBuddyTasks, hrmsChecklist, hrmsTaskTemplates, hrmsTodos } from "@/db/schema";
import { first } from "@/lib/hrms/server";
import { fdShort, monLabel, monthOf } from "@/lib/hrms/time";
import { assignerOf, taskAdmin } from "@/lib/hrms/screens/tasks";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { many, present } from "./erp-common";
import { employeeName, hrmsMayAct, typeable } from "./hrms-common";

/* ---------------------------------------------------------------------------
 * HRMS's tasks: a template, a checklist item, a to-do and a shared task.
 *
 * A template is a rule that writes rows, so deleting it stops the rows coming
 * and leaves the ones already written. The other three are those rows, and
 * each is read back by the monthly staff performance — checklist done on time,
 * to-dos closed, buddy tasks finished — so deleting one moves somebody's score
 * for the month without anything on the task list saying so.
 * ------------------------------------------------------------------------- */

const ADMIN_WHY = "needs the “Manage everyone's tasks” power";

/** The month's performance a task row is read back into. */
function scoreItem(who: string, date: string, what: string): ImpactItem {
  return {
    app: "HRMS",
    label: "month’s task score",
    effect: "changed",
    count: 1,
    note: `${first(who)}’s ${monLabel(monthOf(date))} staff performance and points are worked out from the ${what} rows, so this one drops out of them.`,
  };
}

/* ================================================================ template */

export const taskTemplateImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["templates"], (ctx) => (taskAdmin(ctx) ? null : `Deleting a template ${ADMIN_WHY}`));
  },

  async report(id) {
    const [t] = await db.select().from(hrmsTaskTemplates).where(eq(hrmsTaskTemplates.id, id));
    if (!t) return null;
    const name = await employeeName(t.employeeId);
    const [checklist, todos] = await Promise.all([
      db.select({ id: hrmsChecklist.id }).from(hrmsChecklist).where(eq(hrmsChecklist.templateId, id)),
      db.select({ id: hrmsTodos.id }).from(hrmsTodos).where(eq(hrmsTodos.templateId, id)),
    ]);
    const monthly = t.frequency === "Monthly";
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: monthly ? "monthly to-do list that stops getting it" : "daily checklist that stops getting it",
        effect: "changed",
        count: 1,
        note: `${monthly ? "Take monthly task" : "Take my task"} no longer adds “${t.task}” for ${first(name)}.`,
      },
      {
        app: "HRMS",
        label: many(checklist.length, "checklist item already taken from it", "checklist items already taken from it"),
        effect: "kept",
        count: checklist.length,
        note: "They stay on the days they were taken onto, done or not.",
      },
      {
        app: "HRMS",
        label: many(todos.length, "to-do already taken from it", "to-dos already taken from it"),
        effect: "kept",
        count: todos.length,
      },
    ];
    return {
      title: `${first(name)}’s template “${t.task}”`,
      verb: "Delete",
      confirmWord: typeable(t.task, "DELETE"),
      items: present(items),
      blockers: [],
    };
  },
};

/* ========================================================== checklist item */

export const checklistItemImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["checklist"], (ctx) => (taskAdmin(ctx) ? null : `Deleting a checklist item ${ADMIN_WHY}`));
  },

  async report(id) {
    const [r] = await db.select().from(hrmsChecklist).where(eq(hrmsChecklist.id, id));
    if (!r) return null;
    const name = await employeeName(r.employeeId);
    return {
      title: `“${r.task}” on ${first(name)}’s checklist of ${fdShort(r.date)}`,
      verb: "Delete",
      confirmWord: typeable(r.task, "DELETE"),
      items: [scoreItem(name, r.date, "checklist")],
      blockers: [],
    };
  },
};

/* =================================================================== to-do */

export const todoImpact: ImpactSource = {
  authorize: async (id) => {
    await hrmsMayAct(["todos"], async (ctx) => {
      const [r] = await db.select().from(hrmsTodos).where(eq(hrmsTodos.id, id));
      if (!r) return null;
      return assignerOf(r) === ctx.employee?.id || taskAdmin(ctx)
        ? null
        : "Only the person who gave this to-do, or someone with the “Manage everyone's tasks” power, can delete it";
    });
  },

  async report(id) {
    const [r] = await db.select().from(hrmsTodos).where(eq(hrmsTodos.id, id));
    if (!r) return null;
    const name = await employeeName(r.toEmployeeId);
    return {
      title: `the to-do “${r.task}” for ${name}`,
      verb: "Delete",
      confirmWord: typeable(r.task, "DELETE"),
      items: [scoreItem(name, r.forDate, "to-do")],
      blockers: [],
    };
  },
};

/* ============================================================= shared task */

export const sharedTaskImpact: ImpactSource = {
  authorize: async (id) => {
    await hrmsMayAct(["buddy"], async (ctx) => {
      const [r] = await db.select({ from: hrmsBuddyTasks.fromEmployeeId }).from(hrmsBuddyTasks).where(eq(hrmsBuddyTasks.id, id));
      if (!r) return null;
      return r.from === ctx.employee?.id || taskAdmin(ctx)
        ? null
        : "Only the person who shared this task, or someone with the “Manage everyone's tasks” power, can delete it";
    });
  },

  async report(id) {
    const [r] = await db.select().from(hrmsBuddyTasks).where(eq(hrmsBuddyTasks.id, id));
    if (!r) return null;
    const [from, to] = await Promise.all([employeeName(r.fromEmployeeId), employeeName(r.toEmployeeId)]);
    return {
      title: `the task “${r.task}” ${first(from)} shared with ${first(to)}`,
      verb: "Delete",
      confirmWord: typeable(r.task, "DELETE"),
      items: [scoreItem(to, r.date, "buddy task")],
      blockers: [],
    };
  },
};
