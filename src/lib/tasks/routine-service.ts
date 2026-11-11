import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { taskEvents, taskRoutines, tasks, users } from "@/db/schema";
import { occurrenceOn, windowWords, type RoutineFrequency } from "./routines";
import type { TaskApp, TaskPriority } from "./rules";
import { teamOf } from "./service";

/* ---------------------------------------------------------------------------
 * ROUTINES: who sees which, and the tasks they write.
 *
 * A routine is seen by the person it belongs to and by anybody above them on
 * the org chart — the same reach `teamOf` gives every other task screen — and
 * managed by whoever made it or anybody above its person. The person it
 * belongs to reads theirs without being able to switch it off: a routine a
 * manager set is the manager's to change.
 *
 * WRITING A DAY IS IDEMPOTENT. Each task names its routine and the day it was
 * for, and a partial unique index holds that pair to one row, so the hourly
 * job, the nightly one and somebody opening the app can all ask for today and
 * only the first lands. Nobody is notified: a routine is the same work every
 * day, and a bell for each of fifteen daily tasks is a bell nobody reads.
 * ------------------------------------------------------------------------- */

type Viewer = { id: string; role: string };

export type RoutineRow = {
  id: string;
  title: string;
  note: string | null;
  app: TaskApp;
  assigneeId: string;
  assigneeName: string;
  createdById: string;
  createdByName: string;
  priority: TaskPriority;
  proofRequired: boolean;
  checklist: { text: string; done: boolean }[];
  frequency: RoutineFrequency;
  weekdays: number[];
  dayOfMonth: number | null;
  completeByDay: number | null;
  startTime: string | null;
  dueTime: string | null;
  active: boolean;
  startsOn: string;
  /** Whether this viewer may edit, pause or delete it. */
  canManage: boolean;
};

/**
 * May this viewer change this routine — they made it, or its person is below
 * them? With no `createdById` the question is about a NEW one: for themselves,
 * or for anybody below them.
 */
export async function canManageFor(viewer: Viewer, assigneeId: string, createdById?: string): Promise<boolean> {
  if (createdById === undefined ? assigneeId === viewer.id : createdById === viewer.id) return true;
  return (await teamOf(viewer)).has(assigneeId);
}

/** Everybody's routines this viewer may see: their own and their team's. */
export async function routinesFor(viewer: Viewer): Promise<RoutineRow[]> {
  const team = await teamOf(viewer);
  const ids = [viewer.id, ...team];
  const rows = await db.execute<Record<string, unknown>>(sql`
    select r.id, r.title, r.note, r.app, r.assignee_id, a.name as assignee_name, r.created_by_id, c.name as created_by_name,
           r.priority, r.proof_required, r.checklist, r.frequency, r.weekdays, r.day_of_month, r.complete_by_day,
           r.start_time, r.due_time, r.active, r.starts_on::text as starts_on
      from task_routines r
      join users a on a.id = r.assignee_id
      join users c on c.id = r.created_by_id
     where r.assignee_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
     order by a.name, r.active desc, r.frequency, r.start_time nulls last, r.title`);
  return rows.map((r) => {
    const assigneeId = String(r.assignee_id);
    const createdById = String(r.created_by_id);
    return {
      id: String(r.id),
      title: String(r.title),
      note: (r.note as string) ?? null,
      app: r.app as TaskApp,
      assigneeId,
      assigneeName: String(r.assignee_name),
      createdById,
      createdByName: String(r.created_by_name),
      priority: r.priority as TaskPriority,
      proofRequired: Boolean(r.proof_required),
      checklist: (r.checklist as { text: string; done: boolean }[]) ?? [],
      frequency: r.frequency as RoutineFrequency,
      weekdays: ((r.weekdays as number[]) ?? []).map(Number),
      dayOfMonth: r.day_of_month == null ? null : Number(r.day_of_month),
      completeByDay: r.complete_by_day == null ? null : Number(r.complete_by_day),
      startTime: (r.start_time as string) ?? null,
      dueTime: (r.due_time as string) ?? null,
      active: Boolean(r.active),
      startsOn: String(r.starts_on),
      canManage: createdById === viewer.id || team.has(assigneeId),
    };
  });
}

export async function getRoutine(id: string) {
  const [r] = await db.select().from(taskRoutines).where(eq(taskRoutines.id, id));
  return r ?? null;
}

/**
 * Write `day`'s task for every active routine that falls due on it — every
 * routine, or one person's. Returns how many tasks were written; asking again
 * for the same day writes none.
 */
export async function writeRoutineTasks(day: string, opts: { assigneeId?: string } = {}): Promise<number> {
  const where = opts.assigneeId
    ? and(eq(taskRoutines.active, true), eq(users.active, true), eq(taskRoutines.assigneeId, opts.assigneeId))
    : and(eq(taskRoutines.active, true), eq(users.active, true));
  const routines = await db
    .select({ r: taskRoutines })
    .from(taskRoutines)
    .innerJoin(users, eq(users.id, taskRoutines.assigneeId))
    .where(where);

  const due = routines
    .map(({ r }) => ({ r, at: occurrenceOn({ ...r, frequency: r.frequency as RoutineFrequency }, day) }))
    .filter((x): x is { r: typeof x.r; at: { dueDate: string } } => x.at !== null);
  if (!due.length) return 0;

  const rows = due.map(({ r, at }) => {
    const window = windowWords(r.startTime, r.dueTime);
    const note = [r.note, window ? `Time: ${window}.` : null].filter(Boolean).join("\n") || null;
    return {
      id: `tsk_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      title: r.title,
      note,
      app: r.app,
      assigneeId: r.assigneeId,
      createdById: r.createdById,
      priority: r.priority,
      dueDate: at.dueDate,
      dueTime: r.dueTime,
      proofRequired: r.proofRequired,
      checklist: r.checklist.map((c) => ({ text: c.text, done: false })),
      routineId: r.id,
      routineDay: day,
    };
  });

  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const landed = await db.insert(tasks).values(rows.slice(i, i + 200)).onConflictDoNothing().returning({ id: tasks.id, title: tasks.title });
    if (!landed.length) continue;
    written += landed.length;
    await db.insert(taskEvents).values(
      landed.map((t) => ({ id: `tev_${randomUUID().replace(/-/g, "").slice(0, 16)}`, taskId: t.id, actorId: null, kind: "created", body: "From a routine." })),
    );
  }
  return written;
}
