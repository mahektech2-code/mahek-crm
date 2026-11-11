import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { taskEvents, taskRoutines, tasks, users } from "@/db/schema";
import { alias } from "drizzle-orm/pg-core";
import { occurrenceOn, windowWords, type RoutineFrequency } from "./routines";
import { audienceWords, readAudience, type Audience } from "./audience";
import { resolveFor } from "./audience-service";
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
  /** The one person it is for; null for a routine given by rules. */
  assigneeId: string | null;
  assigneeName: string | null;
  /** The include/exclude rules, where it is given by rules — re-read each day it runs. */
  audience: Audience | null;
  /** "Every Telecaller — except Rahul's team", or the person's name. */
  forWords: string;
  createdById: string;
  createdByName: string;
  priority: TaskPriority;
  proofRequired: boolean;
  remarkRequired: boolean;
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
  /** How many people it reaches today. */
  reach: number;
};

/**
 * May this viewer change this routine — they made it, or its person is below
 * them? With no `createdById` the question is about a NEW one: for themselves,
 * or for anybody below them.
 */
export async function canManageFor(viewer: Viewer, assigneeId: string | null, createdById?: string): Promise<boolean> {
  if (createdById === undefined ? assigneeId === viewer.id : createdById === viewer.id) return true;
  const team = await teamOf(viewer);
  // A routine given by rules belongs to whoever set it — and so to anybody above them.
  if (assigneeId === null) return createdById !== undefined && team.has(createdById);
  return team.has(assigneeId);
}

/** Everybody's routines this viewer may see: their own and their team's. */
export async function routinesFor(viewer: Viewer): Promise<RoutineRow[]> {
  const team = await teamOf(viewer);
  const ids = [viewer.id, ...team];
  const rows = await db.execute<Record<string, unknown>>(sql`
    select r.id, r.title, r.note, r.app, r.assignee_id, a.name as assignee_name, r.audience, r.created_by_id, c.name as created_by_name, c.role as created_by_role,
           r.priority, r.proof_required, r.remark_required, r.checklist, r.frequency, r.weekdays, r.day_of_month, r.complete_by_day,
           r.start_time, r.due_time, r.active, r.starts_on::text as starts_on
      from task_routines r
      left join users a on a.id = r.assignee_id
      join users c on c.id = r.created_by_id
     where r.assignee_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        or (r.assignee_id is null and r.created_by_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}))
     order by a.name nulls first, r.active desc, r.frequency, r.start_time nulls last, r.title`);
  const list = rows.map((r) => {
    const assigneeId = r.assignee_id == null ? null : String(r.assignee_id);
    const createdById = String(r.created_by_id);
    const audience = readAudience(r.audience);
    return {
      id: String(r.id),
      title: String(r.title),
      note: (r.note as string) ?? null,
      app: r.app as TaskApp,
      assigneeId,
      assigneeName: r.assignee_name == null ? null : String(r.assignee_name),
      audience,
      forWords: audience ? audienceWords(audience) : String(r.assignee_name ?? ""),
      createdById,
      createdByName: String(r.created_by_name),
      priority: r.priority as TaskPriority,
      proofRequired: Boolean(r.proof_required),
      remarkRequired: r.remark_required == null ? true : Boolean(r.remark_required),
      checklist: (r.checklist as { text: string; done: boolean }[]) ?? [],
      frequency: r.frequency as RoutineFrequency,
      weekdays: ((r.weekdays as number[]) ?? []).map(Number),
      dayOfMonth: r.day_of_month == null ? null : Number(r.day_of_month),
      completeByDay: r.complete_by_day == null ? null : Number(r.complete_by_day),
      startTime: (r.start_time as string) ?? null,
      dueTime: (r.due_time as string) ?? null,
      active: Boolean(r.active),
      startsOn: String(r.starts_on),
      canManage: createdById === viewer.id || (assigneeId ? team.has(assigneeId) : team.has(createdById)),
      reach: 1,
      creatorRole: String(r.created_by_role ?? "associate"),
    };
  });
  // A routine given by rules reaches whoever matches today — counted the way the job will count it.
  return Promise.all(
    list.map(async ({ creatorRole, ...row }) =>
      row.audience ? { ...row, reach: (await resolveFor({ id: row.createdById, role: creatorRole }, row.app, row.audience)).length } : row,
    ),
  );
}

export async function getRoutine(id: string) {
  const [r] = await db.select().from(taskRoutines).where(eq(taskRoutines.id, id));
  return r ?? null;
}

/**
 * Write `day`'s tasks for every active routine that falls due on it — all of
 * them, one person's, or one routine's. A routine given by rules is resolved
 * afresh against whoever matches today, as its creator could reach them today
 * (a creator who has left reaches nobody). Returns how many tasks were
 * written; asking again for the same day writes none.
 */
const creator = alias(users, "creator");
const person = alias(users, "person");

export async function writeRoutineTasks(day: string, opts: { assigneeId?: string; routineId?: string } = {}): Promise<number> {
  const routines = (
    await db
      .select({ r: taskRoutines, creatorActive: creator.active, creatorRole: creator.role, assigneeActive: person.active })
      .from(taskRoutines)
      .innerJoin(creator, eq(creator.id, taskRoutines.createdById))
      .leftJoin(person, eq(person.id, taskRoutines.assigneeId))
      .where(opts.routineId ? and(eq(taskRoutines.active, true), eq(taskRoutines.id, opts.routineId)) : eq(taskRoutines.active, true))
  ).filter(({ r, assigneeActive }) => (r.assigneeId ? assigneeActive === true && (!opts.assigneeId || r.assigneeId === opts.assigneeId) : true));

  const rows: (typeof tasks.$inferInsert)[] = [];
  for (const { r, creatorActive, creatorRole } of routines) {
    const at = occurrenceOn({ ...r, frequency: r.frequency as RoutineFrequency }, day);
    if (!at) continue;
    let people: string[];
    if (r.assigneeId) people = [r.assigneeId];
    else {
      const audience = readAudience(r.audience);
      if (!audience || !creatorActive) continue;
      people = await resolveFor({ id: r.createdById, role: creatorRole }, r.app, audience);
      if (opts.assigneeId) people = people.filter((p) => p === opts.assigneeId);
    }
    const window = windowWords(r.startTime, r.dueTime);
    const note = [r.note, window ? `Time: ${window}.` : null].filter(Boolean).join("\n") || null;
    for (const assigneeId of people) {
      rows.push({
        id: `tsk_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        title: r.title,
        note,
        app: r.app,
        assigneeId,
        createdById: r.createdById,
        priority: r.priority,
        dueDate: at.dueDate,
        dueTime: r.dueTime,
        proofRequired: r.proofRequired,
        remarkRequired: r.remarkRequired,
        checklist: r.checklist.map((c) => ({ text: c.text, done: false })),
        routineId: r.id,
        routineDay: day,
      });
    }
  }
  if (!rows.length) return 0;

  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const landed = await db.insert(tasks).values(rows.slice(i, i + 200)).onConflictDoNothing().returning({ id: tasks.id });
    if (!landed.length) continue;
    written += landed.length;
    await db.insert(taskEvents).values(
      landed.map((t) => ({ id: `tev_${randomUUID().replace(/-/g, "").slice(0, 16)}`, taskId: t.id, actorId: null, kind: "created", body: "From a routine." })),
    );
  }
  return written;
}
