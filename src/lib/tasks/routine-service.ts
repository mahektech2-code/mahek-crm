import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { taskEvents, taskRoutines, taskTransfers, tasks, users } from "@/db/schema";
import { APP_TIMEZONE } from "@/lib/business-date";
import { alias } from "drizzle-orm/pg-core";
import { occurrenceOn, windowWords, type RoutineFrequency } from "./routines";
import { audienceWords, readAudience, type Audience } from "./audience";
import { resolveFor } from "./audience-service";
import { MISSED_FROM, missedRemark, routineMissed, type TaskApp, type TaskPriority } from "./rules";
import { appClock } from "./clock";
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
  // A new routine is giving work; changing somebody else's is managing it.
  const team = await teamOf(viewer, createdById === undefined ? "give" : "manage");
  // A routine given by rules belongs to whoever set it — and so to anybody above them.
  if (assigneeId === null) return createdById !== undefined && team.has(createdById);
  return team.has(assigneeId);
}

/** Everybody's routines this viewer may see: their own and their team's. */
export async function routinesFor(viewer: Viewer): Promise<RoutineRow[]> {
  const [team, manages] = await Promise.all([teamOf(viewer, "see"), teamOf(viewer, "manage")]);
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
      canManage: createdById === viewer.id || (assigneeId ? manages.has(assigneeId) : manages.has(createdById)),
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

export async function writeRoutineTasks(day: string, opts: { assigneeId?: string; routineId?: string; skipPast?: boolean } = {}): Promise<number> {
  /* A routine made or changed after today's due time does not write a task that is missed the moment it exists. */
  const clock = opts.skipPast ? appClock() : null;
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
    if (clock && routineMissed({ routineId: r.id, status: "todo", dueDate: at.dueDate, dueTime: r.dueTime }, clock.day, clock.hm)) continue;
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

/* ---------------------------------------------------------------------------
 * MISSED. A routine's task not done by its due time — the end of its due day
 * where no time was set — is closed as `missed`, at the deadline, by nobody.
 * It cannot be closed or reopened afterwards: the next day writes the next
 * day's task, and yesterday's is not done today. The deadline is checked again
 * in `closeTask`, so the hour between two sweeps is never a way in.
 *
 * Idempotent: only open routine tasks past their deadline are touched, so the
 * hourly job, the nightly one and a person opening the app can all ask.
 * ------------------------------------------------------------------------- */

/** The instant a routine task's time runs out, as SQL: its due day at its due time, else at midnight after it. */
export const routineDeadlineSql = sql`((t.due_date + coalesce(t.due_time, '24:00')::time) at time zone ${APP_TIMEZONE})`;

export async function markMissedRoutineTasks(opts: { assigneeId?: string; ids?: string[] } = {}): Promise<number> {
  const due = (await db.execute(sql`
    select t.id, t.due_date::text as "dueDate", t.due_time as "dueTime", least(${routineDeadlineSql}, now()) as deadline
      from tasks t
     where t.routine_id is not null and t.status <> 'done' and t.status <> 'missed'
       and ${routineDeadlineSql} <= now()
       and t.due_date >= ${MISSED_FROM}::date
       ${opts.assigneeId ? sql`and t.assignee_id = ${opts.assigneeId}` : sql``}
       ${opts.ids ? (opts.ids.length ? sql`and t.id in ${opts.ids}` : sql`and false`) : sql``}
  `)) as unknown as { id: string; dueDate: string; dueTime: string | null; deadline: string | Date }[];
  if (!due.length) return 0;

  let missed = 0;
  for (let i = 0; i < due.length; i += 200) {
    const chunk = due.slice(i, i + 200);
    await db.transaction(async (tx) => {
      const closedIds: string[] = [];
      for (const r of chunk) {
        const done = await tx
          .update(tasks)
          .set({ status: "missed", closedAt: new Date(r.deadline), closedById: null, closeRemark: missedRemark(r.dueDate, r.dueTime), updatedAt: new Date() })
          .where(and(eq(tasks.id, r.id), sql`${tasks.status} <> 'done' and ${tasks.status} <> 'missed'`))
          .returning({ id: tasks.id });
        if (done.length) closedIds.push(r.id);
      }
      if (!closedIds.length) return;
      missed += closedIds.length;
      await tx.insert(taskEvents).values(
        chunk
          .filter((r) => closedIds.includes(r.id))
          .map((r) => ({ id: `tev_${randomUUID().replace(/-/g, "").slice(0, 16)}`, taskId: r.id, actorId: null, kind: "missed", body: missedRemark(r.dueDate, r.dueTime) })),
      );
      /* An offer still open on a task that can no longer be done is an offer of nothing. */
      await tx
        .update(taskTransfers)
        .set({ status: "withdrawn", decidedAt: new Date(), decisionNote: "The task was missed before it was accepted." })
        .where(and(inArray(taskTransfers.taskId, closedIds), eq(taskTransfers.status, "pending")));
    });
  }
  return missed;
}

