import "server-only";
import { cache } from "react";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";
import { listAttachments, type AttachmentView } from "@/lib/services/attachment-service";
import { managesBoth, teamBelow, type TaskApp, type TaskPriority, type TaskStatus } from "./rules";
import { AUTOMATION_BY_ID } from "./automations";
import { scheduleWords, windowWords, type RoutineFrequency } from "./routines";
import { reachesEverybody, type TaskReach } from "./permissions";
import { taskPowersOf } from "./powers-service";

/* ---------------------------------------------------------------------------
 * THE TASKS APP'S READS, and who may see what.
 *
 * WHO SEES A TASK is its assignee, its creator, the person a pending transfer
 * is offered to, and anybody above the assignee on the org chart — a manager
 * reads their team's tasks in every app. The Tasks permissions widen that to
 * the whole company, one question at a time (lib/tasks/permissions.ts): seeing,
 * giving and managing are three reaches, and a Tasks or platform administrator
 * holds all three.
 *
 * THE ORG CHART is `users.reports_to_id` first, then the HRMS reporting line
 * through `users.employee_id`, then the HRMS line matched by name — the same
 * three readings the field team's manager is found by, in that order.
 * ------------------------------------------------------------------------- */

export type TaskTransferView = {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  requestedById: string;
  reason: string | null;
  createdAt: string;
};

export type TaskRow = {
  id: string;
  title: string;
  note: string | null;
  app: TaskApp;
  customerId: string | null;
  customerName: string | null;
  assigneeId: string;
  assigneeName: string;
  createdById: string;
  createdByName: string;
  batchId: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string;
  dueTime: string | null;
  proofRequired: boolean;
  remarkRequired: boolean;
  checklist: { text: string; done: boolean }[];
  closedAt: string | null;
  /** The day it closed, in India — what "Done today" compares against. */
  closedOn: string | null;
  closedByName: string | null;
  closeRemark: string | null;
  createdAt: string;
  transfer: TaskTransferView | null;
  /** Where it came from: an app raised it, a routine, somebody gave it, or the person added it. */
  kind: TaskKind;
  routineId: string | null;
  /** The automatic rule that raised it, by id (lib/tasks/automations.ts). */
  autoRule: string | null;
};

export type TaskKind = "auto" | "routine" | "assigned" | "self";

type Viewer = { id: string; role: string };

/* ------------------------------------------------------------- the team */

/** Everybody's manager, as user ids. Request-memoised: one page asks several times. */
export const orgManagerMap = cache(async (): Promise<Map<string, string>> => {
  const people = await db.execute<{ id: string; name: string; reports_to_id: string | null; employee_id: string | null }>(sql`
    select id, name, reports_to_id, employee_id from users where active = true
  `);
  const links = await db.execute<{ employee_id: string; manager_id: string; employee_name: string; manager_name: string }>(sql`
    select r.employee_id, r.manager_id, e.name as employee_name, m.name as manager_name
      from employee_reporting r
      join employees e on e.id = r.employee_id
      join employees m on m.id = r.manager_id
  `);
  const userByEmployee = new Map<string, string>();
  const userByName = new Map<string, string>();
  for (const p of people) {
    if (p.employee_id) userByEmployee.set(p.employee_id, p.id);
    userByName.set(p.name.trim().toLowerCase(), p.id);
  }
  const managerEmployee = new Map(links.map((l) => [l.employee_id, l.manager_id]));
  const managerByName = new Map(links.map((l) => [l.employee_name.trim().toLowerCase(), l.manager_name.trim().toLowerCase()]));

  const out = new Map<string, string>();
  for (const p of people) {
    let manager: string | undefined = p.reports_to_id ?? undefined;
    if (!manager && p.employee_id) {
      const me = managerEmployee.get(p.employee_id);
      if (me) manager = userByEmployee.get(me);
    }
    if (!manager) {
      const mn = managerByName.get(p.name.trim().toLowerCase());
      if (mn) manager = userByName.get(mn);
    }
    if (manager && manager !== p.id) out.set(p.id, manager);
  }
  return out;
});

/** Every active person but this one. Request-memoised. */
const everybodyBut = cache(async (id: string): Promise<Set<string>> => {
  const all = await db.execute<{ id: string }>(sql`select id from users where active = true and id <> ${id}`);
  return new Set(all.map((r) => r.id));
});

/**
 * The people this person reaches, for one of three questions: whose tasks they
 * may SEE, who they may GIVE a task or routine to, and whose tasks they may
 * MANAGE as if above them (and move tasks between). Everybody below them on the
 * org chart; everybody, where a Tasks permission widens that reach — which a
 * Tasks administrator and a platform administrator hold for all three.
 *
 * `manage` is the default because it is the narrowest of the three: a caller
 * that forgot to say which question it is asking gets the answer that grants
 * the least.
 */
export const teamOf = cache(async (viewer: Viewer, reach: TaskReach = "manage"): Promise<Set<string>> => {
  if (reachesEverybody(await taskPowersOf(viewer), reach)) return everybodyBut(viewer.id);
  return teamBelow(await orgManagerMap(), viewer.id);
});

export async function viewerManagesBoth(viewer: Viewer, fromId: string, toId: string): Promise<boolean> {
  return managesBoth(await teamOf(viewer), viewer.id, fromId, toId);
}

/* ---------------------------------------------------------------- reads */

const SELECT = sql`
  select t.id, t.title, t.note, t.app, t.customer_id, c.name as customer_name,
         t.assignee_id, a.name as assignee_name, t.created_by_id, cb.name as created_by_name,
         t.batch_id, t.status, t.priority, t.due_date::text as due_date, t.due_time,
         t.proof_required, t.remark_required, t.checklist, t.closed_at, (t.closed_at at time zone ${APP_TIMEZONE})::date::text as closed_on, cl.name as closed_by_name, t.close_remark, t.created_at, t.routine_id, t.auto_rule,
         tr.id as tr_id, tr.from_id as tr_from, fu.name as tr_from_name, tr.to_id as tr_to, tu.name as tr_to_name,
         tr.requested_by_id as tr_by, tr.reason as tr_reason, tr.created_at as tr_at
    from tasks t
    join users a on a.id = t.assignee_id
    join users cb on cb.id = t.created_by_id
    left join users cl on cl.id = t.closed_by_id
    left join customers c on c.id = t.customer_id
    left join task_transfers tr on tr.task_id = t.id and tr.status = 'pending'
    left join users fu on fu.id = tr.from_id
    left join users tu on tu.id = tr.to_id`;

type Raw = Record<string, unknown>;
const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function toRow(r: Raw): TaskRow {
  return {
    id: String(r.id),
    title: String(r.title),
    note: (r.note as string) ?? null,
    app: r.app as TaskApp,
    customerId: (r.customer_id as string) ?? null,
    customerName: (r.customer_name as string) ?? null,
    assigneeId: String(r.assignee_id),
    assigneeName: String(r.assignee_name),
    createdById: String(r.created_by_id),
    createdByName: String(r.created_by_name),
    batchId: (r.batch_id as string) ?? null,
    status: r.status as TaskStatus,
    priority: r.priority as TaskPriority,
    dueDate: String(r.due_date),
    dueTime: (r.due_time as string) ?? null,
    proofRequired: Boolean(r.proof_required),
    remarkRequired: r.remark_required == null ? true : Boolean(r.remark_required),
    checklist: (r.checklist as { text: string; done: boolean }[]) ?? [],
    closedAt: iso(r.closed_at),
    closedOn: (r.closed_on as string) ?? null,
    closedByName: (r.closed_by_name as string) ?? null,
    closeRemark: (r.close_remark as string) ?? null,
    createdAt: iso(r.created_at)!,
    routineId: (r.routine_id as string) ?? null,
    autoRule: (r.auto_rule as string) ?? null,
    kind: r.auto_rule ? "auto" : r.routine_id ? "routine" : r.created_by_id !== r.assignee_id ? "assigned" : "self",
    transfer: r.tr_id
      ? {
          id: String(r.tr_id),
          fromId: String(r.tr_from),
          fromName: String(r.tr_from_name),
          toId: String(r.tr_to),
          toName: String(r.tr_to_name),
          requestedById: String(r.tr_by),
          reason: (r.tr_reason as string) ?? null,
          createdAt: iso(r.tr_at)!,
        }
      : null,
  };
}

/** Open first, then by day, time and priority. Done tasks only from the last fortnight. */
async function query(where: SQL, limit = 500): Promise<TaskRow[]> {
  const rows = await db.execute<Raw>(sql`
    ${SELECT}
    where (${where})
      and (t.status <> 'done' or t.closed_at > now() - interval '14 days')
    order by (t.status = 'done'), t.due_date, t.due_time nulls last,
             array_position(array['urgent','high','normal','low'], t.priority), t.created_at
    limit ${limit}`);
  return rows.map(toRow);
}

export async function getTaskRow(id: string): Promise<TaskRow | null> {
  const rows = await db.execute<Raw>(sql`${SELECT} where t.id = ${id}`);
  return rows[0] ? toRow(rows[0]) : null;
}

/** Everything assigned to this person; `app` narrows it to one app's work (TeleCRM's My tasks). */
export async function myTasks(userId: string, opts: { apps?: string[] } = {}): Promise<TaskRow[]> {
  const apps = opts.apps?.length ? sql` and t.app in (${sql.join(opts.apps.map((a) => sql`${a}`), sql`, `)})` : sql``;
  return query(sql`t.assignee_id = ${userId}${apps}`);
}

/** Everything this person has finished, newest first — the Done screen, which reaches past the fortnight the lists keep. */
export async function doneTasks(userId: string, limit = 500): Promise<TaskRow[]> {
  const rows = await db.execute<Raw>(sql`${SELECT} where t.assignee_id = ${userId} and t.status = 'done' order by t.closed_at desc limit ${limit}`);
  return rows.map(toRow);
}

/** This person's tasks due in a span of days (and, for the span holding today, what is late) — the Calendar. */
export async function tasksBetween(userId: string, from: string, to: string): Promise<TaskRow[]> {
  const rows = await db.execute<Raw>(sql`
    ${SELECT}
    where t.assignee_id = ${userId}
      and (t.due_date between ${from}::date and ${to}::date or (t.status <> 'done' and t.due_date < ${from}::date))
    order by t.due_date, t.due_time nulls last
    limit 2000`);
  return rows.map(toRow);
}

/** Tasks other people are offering this person. They are not theirs yet. */
export async function incomingTransfers(userId: string): Promise<TaskRow[]> {
  return query(sql`tr.to_id = ${userId}`);
}

export async function outgoingTransfers(userId: string): Promise<TaskRow[]> {
  return query(sql`tr.from_id = ${userId} or tr.requested_by_id = ${userId}`);
}

export type TransferHistoryRow = {
  id: string;
  taskId: string;
  title: string;
  fromName: string;
  toName: string;
  status: "accepted" | "rejected" | "withdrawn" | "moved";
  decidedByName: string | null;
  note: string | null;
  reason: string | null;
  decidedAt: string;
};

export async function transferHistory(userId: string): Promise<TransferHistoryRow[]> {
  const rows = await db.execute<Raw>(sql`
    select tr.id, tr.task_id, t.title, f.name as from_name, u.name as to_name, tr.status, d.name as decided_by_name,
           tr.decision_note, tr.reason, coalesce(tr.decided_at, tr.created_at) as decided_at
      from task_transfers tr
      join tasks t on t.id = tr.task_id
      join users f on f.id = tr.from_id
      join users u on u.id = tr.to_id
      left join users d on d.id = tr.decided_by_id
     where tr.status <> 'pending' and (tr.from_id = ${userId} or tr.to_id = ${userId} or tr.requested_by_id = ${userId})
     order by coalesce(tr.decided_at, tr.created_at) desc
     limit 100`);
  return rows.map((r) => ({
    id: String(r.id),
    taskId: String(r.task_id),
    title: String(r.title),
    fromName: String(r.from_name),
    toName: String(r.to_name),
    status: r.status as TransferHistoryRow["status"],
    decidedByName: (r.decided_by_name as string) ?? null,
    note: (r.decision_note as string) ?? null,
    reason: (r.reason as string) ?? null,
    decidedAt: iso(r.decided_at)!,
  }));
}

/** The tasks of the people under this person — `personId` narrows it to one of them. */
export async function teamTasks(viewer: Viewer, personId?: string): Promise<TaskRow[]> {
  const team = [...(await teamOf(viewer, "see"))];
  const ids = personId ? team.filter((id) => id === personId) : team;
  if (!ids.length) return [];
  return query(sql`t.assignee_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`, 2000);
}

/** What this person gave other people, one row each. */
export async function givenByMe(userId: string): Promise<TaskRow[]> {
  return query(sql`t.created_by_id = ${userId} and t.assignee_id <> ${userId}`, 1000);
}

export type TeamPerson = {
  id: string;
  name: string;
  apps: string[];
  /** Whether the viewer manages this person's tasks — false for somebody they only SEE through a permission. */
  manage?: boolean;
};

/**
 * The people this person reaches, with the apps each holds: whose work they
 * SEE for the workload table, whom they may GIVE to for the pickers.
 */
export async function teamPeople(viewer: Viewer, reach: TaskReach = "see"): Promise<TeamPerson[]> {
  const [reached, manages] = await Promise.all([teamOf(viewer, reach), teamOf(viewer, "manage")]);
  const team = [...reached];
  if (!team.length) return [];
  const rows = await db.execute<{ id: string; name: string; apps: string[] | null }>(sql`
    select u.id, u.name, array_remove(array_agg(distinct a.app::text), null) as apps
      from users u left join app_access a on a.user_id = u.id
     where u.id in (${sql.join(team.map((id) => sql`${id}`), sql`, `)}) and u.active = true
     group by u.id, u.name order by u.name`);
  return rows.map((r) => ({ id: r.id, name: r.name, apps: r.apps ?? [], manage: manages.has(r.id) }));
}

/** Everybody who could be handed a task in this app: they hold Tasks, or the app itself. */
export async function peopleForApp(app: string): Promise<TeamPerson[]> {
  const rows = await db.execute<{ id: string; name: string; apps: string[] | null }>(sql`
    select u.id, u.name, array_remove(array_agg(distinct a.app::text), null) as apps
      from users u join app_access a on a.user_id = u.id
     where u.active = true and a.app::text in ('tasks', ${app})
     group by u.id, u.name order by u.name`);
  return rows.map((r) => ({ id: r.id, name: r.name, apps: r.apps ?? [] }));
}

/** Whether somebody would find a task of this app anywhere: Tasks, or the app it belongs to. */
export async function canReceive(userId: string, app: string): Promise<boolean> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from app_access a join users u on u.id = a.user_id
     where a.user_id = ${userId} and u.active = true and a.app::text in ('tasks', ${app === "tasks" ? "tasks" : app})`);
  return Number(rows[0]?.n ?? 0) > 0;
}

/* ------------------------------------------------------------ visibility */

export async function canSeeTask(viewer: Viewer, t: Pick<TaskRow, "assigneeId" | "createdById" | "transfer">): Promise<boolean> {
  if (t.assigneeId === viewer.id || t.createdById === viewer.id) return true;
  if (t.transfer && (t.transfer.toId === viewer.id || t.transfer.requestedById === viewer.id)) return true;
  return (await teamOf(viewer, "see")).has(t.assigneeId);
}

/** For the attachment endpoint: may this person open a screenshot filed under this task. */
export async function canSeeTaskById(viewer: Viewer, taskId: string): Promise<boolean> {
  const t = await getTaskRow(taskId);
  return t ? canSeeTask(viewer, t) : false;
}

/* ---------------------------------------------------------------- detail */

export type TaskEventView = { id: string; kind: string; body: string | null; actorName: string | null; at: string };

export type TaskDetail = {
  task: TaskRow;
  events: TaskEventView[];
  proofs: AttachmentView[];
  /** Where it came from, in words: a routine's schedule, the group it was given to, the rule that raised it. */
  origin: {
    repeats: string | null;
    partOf: { audience: string; done: number; total: number } | null;
    auto: { when: string; closes: string } | null;
  };
  /** What this viewer may do — the screen draws exactly these, the actions ask again. */
  can: {
    edit: boolean;
    setProof: boolean;
    close: boolean;
    reopen: boolean;
    transfer: boolean;
    decideTransfer: boolean;
    withdrawTransfer: boolean;
    delete: boolean;
    note: boolean;
  };
};

export async function taskDetail(viewer: Viewer, id: string): Promise<TaskDetail | null> {
  const task = await getTaskRow(id);
  if (!task || !(await canSeeTask(viewer, task))) return null;
  const [events, proofs, team, routine, batch, powers] = await Promise.all([
    db.execute<Raw>(sql`
      select e.id, e.kind, e.body, u.name as actor_name, e.created_at
        from task_events e left join users u on u.id = e.actor_id
       where e.task_id = ${id} order by e.created_at, e.id`),
    listAttachments("task", id),
    teamOf(viewer),
    task.routineId
      ? db.execute<Raw>(sql`select frequency, weekdays, day_of_month, complete_by_day, start_time, due_time from task_routines where id = ${task.routineId}`)
      : Promise.resolve([] as Raw[]),
    task.batchId
      ? db.execute<Raw>(sql`
          select b.audience, count(t.id)::int as total, count(t.id) filter (where t.status = 'done')::int as done
            from task_batches b join tasks t on t.batch_id = b.id where b.id = ${task.batchId} group by b.audience`)
      : Promise.resolve([] as Raw[]),
    taskPowersOf(viewer),
  ]);
  const r0 = routine[0];
  const rule = task.autoRule ? AUTOMATION_BY_ID.get(task.autoRule) : undefined;
  const mine = task.assigneeId === viewer.id;
  const above = team.has(task.assigneeId);
  const creator = task.createdById === viewer.id;
  const open = task.status !== "done";
  return {
    task,
    events: events.map((e) => ({ id: String(e.id), kind: String(e.kind), body: (e.body as string) ?? null, actorName: (e.actor_name as string) ?? null, at: iso(e.created_at)! })),
    proofs,
    origin: {
      repeats: r0
        ? [
            scheduleWords({ frequency: r0.frequency as RoutineFrequency, weekdays: ((r0.weekdays as number[]) ?? []).map(Number), dayOfMonth: r0.day_of_month == null ? null : Number(r0.day_of_month), completeByDay: r0.complete_by_day == null ? null : Number(r0.complete_by_day) }),
            windowWords((r0.start_time as string) ?? null, (r0.due_time as string) ?? null),
          ]
            .filter(Boolean)
            .join(", ")
        : null,
      partOf: batch[0] ? { audience: String(batch[0].audience), done: Number(batch[0].done), total: Number(batch[0].total) } : null,
      auto: rule ? { when: rule.when, closes: rule.closes } : null,
    },
    can: {
      edit: open && (mine || above || creator),
      setProof: open && (creator || above),
      close: open && (mine || above),
      reopen: !open && (mine || above || creator),
      // An automatic task follows its record: the app that raised it decides who holds it.
      transfer: open && !task.transfer && !task.autoRule && (mine || above),
      decideTransfer: Boolean(task.transfer && task.transfer.toId === viewer.id),
      withdrawTransfer: Boolean(task.transfer && (task.transfer.requestedById === viewer.id || task.transfer.fromId === viewer.id)),
      // Whoever gave it, while it is open or it is their own; and whoever manages anybody's tasks.
      delete: !task.autoRule && ((creator && (task.assigneeId === viewer.id || open)) || powers.has("manageAnyone")),
      note: mine || above || creator || Boolean(task.transfer && task.transfer.toId === viewer.id),
    },
  };
}

/* --------------------------------------------------------------- counts */

/** The launcher's and the sidebar's numbers: due now and late, everything open, offers, the team's late work, what they gave out still open. */
export async function taskCounts(
  userId: string,
  today: string,
): Promise<{ dueNow: number; late: number; offered: number; open: number; teamLate: number; givenOpen: number }> {
  const team = [...(await teamOf({ id: userId, role: (await roleOf(userId)) ?? "associate" }, "see"))];
  const teamIn = team.length ? sql`assignee_id in (${sql.join(team.map((id) => sql`${id}`), sql`, `)})` : sql`false`;
  const rows = await db.execute<Record<string, number>>(sql`
    select
      (select count(*)::int from tasks where assignee_id = ${userId} and status <> 'done' and due_date <= ${today}::date) as due_now,
      (select count(*)::int from tasks where assignee_id = ${userId} and status <> 'done' and due_date < ${today}::date) as late,
      (select count(*)::int from tasks where assignee_id = ${userId} and status <> 'done') as open,
      (select count(*)::int from task_transfers where to_id = ${userId} and status = 'pending') as offered,
      (select count(*)::int from tasks where ${teamIn} and status <> 'done' and due_date < ${today}::date) as team_late,
      (select count(*)::int from tasks where created_by_id = ${userId} and assignee_id <> ${userId} and status <> 'done' and auto_rule is null) as given_open`);
  const r = rows[0] ?? {};
  return {
    dueNow: Number(r.due_now ?? 0),
    late: Number(r.late ?? 0),
    offered: Number(r.offered ?? 0),
    open: Number(r.open ?? 0),
    teamLate: Number(r.team_late ?? 0),
    givenOpen: Number(r.given_open ?? 0),
  };
}

async function roleOf(userId: string): Promise<string | null> {
  const rows = await db.execute<{ role: string }>(sql`select role from users where id = ${userId}`);
  return rows[0]?.role ?? null;
}

/** This person's open tasks per app, for the sidebar's By app list. */
export async function openByApp(userId: string, today: string): Promise<{ app: string; open: number; late: number }[]> {
  const rows = await db.execute<{ app: string; open: number; late: number }>(sql`
    select app, count(*)::int as open, count(*) filter (where due_date < ${today}::date)::int as late
      from tasks where assignee_id = ${userId} and status <> 'done' group by app order by count(*) desc, app`);
  return rows.map((r) => ({ app: r.app, open: Number(r.open), late: Number(r.late) }));
}
