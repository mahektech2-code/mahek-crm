"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, taskRoutines } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { notifyUsers } from "@/lib/notify";
import { today } from "@/lib/recompute";
import { err, ok, type Result } from "@/lib/result";
import { checklistFrom, TASK_APP_LABEL, type FieldProblem } from "@/lib/tasks/rules";
import { normaliseRoutine, routineProblems, scheduleWords, type RoutineFrequency } from "@/lib/tasks/routines";
import { canManageFor, getRoutine, writeRoutineTasks } from "@/lib/tasks/routine-service";
import { canReceive } from "@/lib/tasks/service";
import { audienceProblems, type Audience } from "@/lib/tasks/audience";
import { resolveFor } from "@/lib/tasks/audience-service";

/* ---------------------------------------------------------------------------
 * EVERY WRITE TO A ROUTINE. Each asks `canManageFor` — a server action is a
 * URL, and a button that is not drawn is not a permission. A change reaches
 * the days still to come; the tasks already written keep their words.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const fieldsErr = (problems: FieldProblem[]) => err(problems[0].message, "validation", problems.map((p) => ({ field: p.field, message: p.message })));
const first = (name: string) => name.split(/\s+/)[0];

async function audit(actorId: string, action: string, id: string, detail: Record<string, unknown>) {
  await db.insert(auditLog).values({ id: newId("aud"), actorId, action, entityType: "task_routine", entityId: id, afterState: detail as never });
}

function refresh() {
  try {
    revalidatePath("/tasks", "layout");
  } catch {
    /* no request context (tests, scripts) */
  }
}

export type SaveRoutineInput = {
  /** Absent for a new routine. */
  id?: string;
  /** One person — or, with `audience`, nobody in particular. */
  assigneeId: string | null;
  /** Include/exclude rules, re-read on every day the routine runs. */
  audience?: Audience | null;
  title: string;
  app: string;
  priority: string;
  frequency: string;
  weekdays: number[];
  dayOfMonth: number | null;
  completeByDay: number | null;
  startTime: string | null;
  dueTime: string | null;
  proofRequired: boolean;
  remarkRequired?: boolean;
  note?: string | null;
  checklist?: string | null;
};

export async function saveRoutine(input: SaveRoutineInput): Promise<Result<{ id: string }>> {
  const user = await requireUser();
  const problems = routineProblems(input);
  if (problems.length) return fieldsErr(problems);
  const r = normaliseRoutine(input);

  const before = input.id ? await getRoutine(input.id) : null;
  if (input.id && !before) return err("That routine no longer exists.", "not_found");
  if (before && !(await canManageFor(user, before.assigneeId, before.createdById))) return err("Only whoever set this routine, or a manager above its person, can change it.", "not_permitted");

  const audience = input.audience ?? null;
  if (audience) {
    const ap = audienceProblems(audience);
    if (ap.length) return fieldsErr(ap);
    // Checked against today's people: a rule nobody matches yet is a typo, not a plan.
    const reach = await resolveFor(user, r.app, audience);
    if (!reach.length) return err("Those rules reach nobody who holds this app today.", "validation", [{ field: "audience", message: "Nobody matches." }]);
  } else {
    if (!r.assigneeId) return err("Say who it is for.", "validation", [{ field: "assignee", message: "Pick somebody." }]);
    if (!(await canManageFor(user, r.assigneeId))) {
      return err("You can set routines for yourself and the people under you on the org chart.", "not_permitted", [{ field: "assignee", message: "Not in your team." }]);
    }
    if (!(await canReceive(r.assigneeId, r.app))) {
      return err(`They can't open ${TASK_APP_LABEL[r.app as keyof typeof TASK_APP_LABEL] ?? r.app} or Tasks, so they would never see these tasks.`, "validation", [{ field: "assignee", message: "Can't see it." }]);
    }
  }

  const day = await today();
  const values = {
    title: r.title,
    note: r.note ?? null,
    app: r.app,
    assigneeId: audience ? null : r.assigneeId,
    audience,
    priority: r.priority,
    proofRequired: input.proofRequired,
    remarkRequired: input.remarkRequired ?? true,
    checklist: checklistFrom(input.checklist),
    frequency: r.frequency,
    weekdays: r.weekdays,
    dayOfMonth: r.dayOfMonth,
    completeByDay: r.completeByDay,
    startTime: r.startTime,
    dueTime: r.dueTime,
  };

  let id = input.id ?? "";
  if (before) {
    await db.update(taskRoutines).set({ ...values, updatedAt: new Date() }).where(eq(taskRoutines.id, before.id));
    await audit(user.id, "task.routine.edited", before.id, { before: { title: before.title, assigneeId: before.assigneeId }, after: values });
  } else {
    id = newId("trt");
    await db.insert(taskRoutines).values({ id, ...values, createdById: user.id, startsOn: day });
    await audit(user.id, "task.routine.created", id, values);
    if (audience) {
      const reach = (await resolveFor(user, r.app, audience)).filter((p) => p !== user.id);
      await notifyUsers(
        reach.map((userId) => ({
          userId,
          title: `${first(user.name)} set you a routine`,
          body: `${r.title} — ${scheduleWords({ ...r, frequency: r.frequency as RoutineFrequency })}`,
          href: "/tasks/routines",
        })),
      );
    } else if (r.assigneeId && r.assigneeId !== user.id) {
      await notifyUsers([
        {
          userId: r.assigneeId,
          title: `${first(user.name)} set you a routine`,
          body: `${r.title} — ${scheduleWords({ ...r, frequency: r.frequency as RoutineFrequency })}`,
          href: "/tasks/routines",
        },
      ]);
    }
  }
  // Today's task, where today is one of its days — a routine set at ten in
  // the morning for "every day" means today as well.
  await writeRoutineTasks(day, { routineId: id });
  refresh();
  return ok({ id }, before ? "Routine saved. It changes the days to come." : "Routine set.");
}

export async function setRoutineActive(id: string, active: boolean): Promise<Result<null>> {
  const user = await requireUser();
  const r = await getRoutine(id);
  if (!r) return err("That routine no longer exists.", "not_found");
  if (!(await canManageFor(user, r.assigneeId, r.createdById))) return err("Only whoever set this routine, or a manager above its person, can pause it.", "not_permitted");
  if (r.active === active) return ok(null);
  // Resuming starts from today: the days it was paused are not owed.
  const day = await today();
  await db
    .update(taskRoutines)
    .set({ active, updatedAt: new Date(), ...(active ? { startsOn: r.startsOn > day ? r.startsOn : day } : {}) })
    .where(eq(taskRoutines.id, id));
  await audit(user.id, active ? "task.routine.resumed" : "task.routine.paused", id, { title: r.title });
  if (active) await writeRoutineTasks(day, { routineId: id });
  refresh();
  return ok(null, active ? "Routine resumed." : "Routine paused. Nothing new is added until it is resumed.");
}

/** Deleting stops the routine; the tasks it already wrote stay, as the work they were. */
export async function deleteRoutine(id: string): Promise<Result<null>> {
  const user = await requireUser();
  const r = await getRoutine(id);
  if (!r) return err("That routine no longer exists.", "not_found");
  if (!(await canManageFor(user, r.assigneeId, r.createdById))) return err("Only whoever set this routine, or a manager above its person, can delete it.", "not_permitted");
  await db.delete(taskRoutines).where(eq(taskRoutines.id, id));
  await audit(user.id, "task.routine.deleted", id, { title: r.title, assigneeId: r.assigneeId });
  refresh();
  return ok(null, "Routine deleted. The tasks it already added stay.");
}
