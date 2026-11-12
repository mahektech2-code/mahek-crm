"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments, auditLog, customers, taskBatches, taskEvents, taskTransfers, tasks, type TaskChecklistItem } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { notifyUsers, type NotifyEntry } from "@/lib/notify";
import { today } from "@/lib/recompute";
import { err, ok, type Result } from "@/lib/result";
import { bindAttachments } from "@/lib/services/attachment-service";
import {
  checklistFrom,
  closeProblems,
  isTaskApp,
  managesBoth,
  newTaskProblems,
  parseQuickAdd,
  rejectProblems,
  transferProblems,
  transferRoute,
  TASK_APP_LABEL,
  APP_TASKS_PATH,
  NOTE_MAX,
  type FieldProblem,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/tasks/rules";
import { canReceive, getTaskRow, peopleForApp, taskDetail, teamOf, teamPeople, viewerManagesBoth } from "@/lib/tasks/service";
import { audienceProblems, audienceWords, type Audience } from "@/lib/tasks/audience";
import { audienceOptions, resolveFor, type AudienceOptions } from "@/lib/tasks/audience-service";

/* ---------------------------------------------------------------------------
 * EVERY WRITE IN THE TASKS APP.
 *
 * Each one asks `taskDetail` — the same answer the screen drew its buttons
 * from — before it writes, because a server action is a URL and a button that
 * is not drawn is not a permission. Each writes its line of the task's
 * activity in the same breath, and tells whoever has to know.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

const fieldsErr = (problems: FieldProblem[]) => err(problems[0].message, "validation", problems.map((p) => ({ field: p.field, message: p.message })));

async function audit(actorId: string, action: string, taskId: string, detail: Record<string, unknown>) {
  await db.insert(auditLog).values({ id: newId("aud"), actorId, action, entityType: "task", entityId: taskId, afterState: detail as never });
}

async function event(taskId: string, actorId: string | null, kind: string, body: string | null) {
  await db.insert(taskEvents).values({ id: newId("tev"), taskId, actorId, kind, body });
}

/**
 * Where a notification about a task takes somebody: the My tasks of the app the
 * work belongs to — which also files it under that app's bell — and the Tasks
 * app for a personal task.
 */
function taskHref(t: { id: string; app: string }) {
  const own = isTaskApp(t.app) ? APP_TASKS_PATH[t.app] : undefined;
  return `${own ?? "/tasks"}?task=${t.id}`;
}

function refresh() {
  try {
    revalidatePath("/tasks", "layout");
    for (const path of Object.values(APP_TASKS_PATH)) revalidatePath(path);
  } catch {
    /* no request context (tests, scripts) — nothing cached to invalidate */
  }
}

const first = (name: string) => name.split(/\s+/)[0];

/* ----------------------------------------------------------------- create */

export type CreateTaskInput = {
  title: string;
  app: string;
  customerId?: string | null;
  dueDate: string;
  dueTime?: string | null;
  priority: string;
  note?: string | null;
  checklist?: string | null;
  proofRequired: boolean;
  /** Whether closing needs a remark. Required when not said. */
  remarkRequired?: boolean;
  /** Empty, or only the creator, is a task for themselves. Ignored where `audience` is given. */
  assigneeIds: string[];
  /** Include/exclude rules; resolved here, never trusted from the screen's preview. */
  audience?: Audience | null;
};

export async function createTask(input: CreateTaskInput): Promise<Result<{ ids: string[] }>> {
  const user = await requireUser();
  const problems = newTaskProblems(input);
  if (problems.length) return fieldsErr(problems);

  const held = await listUserApps(user.id);
  if (!held.includes("tasks" as never) && !(input.app !== "tasks" && held.includes(input.app as never))) {
    return err("You can't add tasks here.", "not_permitted");
  }

  let ids = [...new Set(input.assigneeIds.length ? input.assigneeIds : [user.id])];
  const team = await teamOf(user, "give");
  if (input.audience) {
    const problems = audienceProblems(input.audience);
    if (problems.length) return fieldsErr(problems);
    ids = await resolveFor(user, input.app, input.audience);
    if (!ids.length) return err("Those rules reach nobody who holds this app today.", "validation", [{ field: "audience", message: "Nobody matches." }]);
  }
  for (const id of ids) {
    if (id !== user.id && !team.has(id)) return err("You can give tasks only to the people under you on the org chart. Giving them to anyone is a Tasks permission, set on the Access screen.", "not_permitted", [{ field: input.audience ? "audience" : "assignees", message: "Not in your team." }]);
    if (id !== user.id && !(await canReceive(id, input.app))) {
      return err(`One of them can't open ${TASK_APP_LABEL[input.app as keyof typeof TASK_APP_LABEL]} or Tasks, so they would never see it.`, "validation", [{ field: "assignees", message: "Can't see it." }]);
    }
  }

  if (input.customerId) {
    const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId));
    if (!c) return err("That customer no longer exists.", "validation", [{ field: "customerId", message: "Not found." }]);
  }

  const title = input.title.trim();
  let batchId: string | null = null;
  if (ids.length > 1) {
    batchId = newId("tbt");
    await db.insert(taskBatches).values({
      id: batchId,
      title,
      app: input.app,
      givenById: user.id,
      audience: input.audience ? audienceWords(input.audience) : `${ids.length} people`,
      rules: input.audience ?? null,
    });
  }

  const names = new Map((await db.execute<{ id: string; name: string }>(sql`select id, name from users where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)).map((r) => [r.id, r.name]));
  const checklist = checklistFrom(input.checklist);
  const rows = ids.map((assigneeId) => ({
    id: newId("tsk"),
    title,
    note: input.note?.trim() ? input.note.trim().slice(0, NOTE_MAX) : null,
    app: input.app,
    customerId: input.customerId || null,
    assigneeId,
    createdById: user.id,
    batchId,
    priority: input.priority,
    dueDate: input.dueDate,
    dueTime: input.dueTime || null,
    proofRequired: input.proofRequired,
    remarkRequired: input.remarkRequired ?? true,
    checklist: checklist.map((c) => ({ ...c })),
  }));
  await db.insert(tasks).values(rows);
  await db.insert(taskEvents).values(
    rows.map((r) => ({
      id: newId("tev"),
      taskId: r.id,
      actorId: user.id,
      kind: "created",
      body: r.assigneeId === user.id ? "Added it." : `Gave it to ${first(names.get(r.assigneeId) ?? "them")}.`,
    })),
  );
  for (const r of rows) await audit(user.id, "task.created", r.id, { title, assigneeId: r.assigneeId, app: r.app });

  const others = rows.filter((r) => r.assigneeId !== user.id);
  await notifyUsers(
    others.map((r) => ({
      userId: r.assigneeId,
      title: `New task from ${first(user.name)}`,
      body: `${title}${r.proofRequired ? " — a screenshot is needed to close it" : ""}`,
      href: taskHref(r),
    })),
  );
  refresh();
  return ok({ ids: rows.map((r) => r.id) }, others.length === 0 ? "Task added" : others.length === 1 ? "Task given" : `Given to ${others.length} people`);
}

/** A personal task from one typed line: "Call Hari Om Paints tomorrow 3pm !high". */
export async function quickAddTask(text: string, app = "tasks"): Promise<Result<{ ids: string[] }>> {
  const parsed = parseQuickAdd(text, await today());
  if (!parsed.title) return err("Type what needs doing.");
  return createTask({ ...parsed, app: isTaskApp(app) ? app : "tasks", proofRequired: false, assigneeIds: [], priority: parsed.priority });
}

/* -------------------------------------------------------------- editing */

export type TaskPatch = {
  status?: Exclude<TaskStatus, "done">;
  dueDate?: string;
  dueTime?: string | null;
  priority?: TaskPriority;
  proofRequired?: boolean;
  remarkRequired?: boolean;
  title?: string;
  note?: string | null;
};

export async function updateTask(id: string, patch: TaskPatch): Promise<Result> {
  const user = await requireUser();
  const d = await taskDetail(user, id);
  if (!d) return err("That task is not there any more.", "not_found");
  if (!d.can.edit) return err(d.task.status === "done" ? "Reopen it first." : "You can't change this task.", "not_permitted");
  if ((patch.proofRequired !== undefined || patch.remarkRequired !== undefined) && !d.can.setProof) return err("Only the person who gave this task, or a manager above whoever holds it, decides whether it needs a screenshot.", "not_permitted");

  const t = d.task;
  const set: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
  const said: string[] = [];
  if (patch.status && patch.status !== t.status) {
    if (!["todo", "doing", "waiting"].includes(patch.status)) return err("Close a task with Mark done.");
    set.status = patch.status;
    said.push(`Moved it to ${patch.status === "todo" ? "To do" : patch.status === "doing" ? "In progress" : "Waiting on someone"}.`);
  }
  if (patch.dueDate && patch.dueDate !== t.dueDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.dueDate)) return err("Pick the day it is due.");
    set.dueDate = patch.dueDate;
    said.push(`Moved the due day to ${patch.dueDate}.`);
  }
  if (patch.dueTime !== undefined && (patch.dueTime || null) !== t.dueTime) {
    if (patch.dueTime && !/^[0-2]\d:[0-5]\d$/.test(patch.dueTime)) return err("Use a time like 15:30.");
    set.dueTime = patch.dueTime || null;
    said.push(patch.dueTime ? `Set the time to ${patch.dueTime}.` : "Took the time off.");
  }
  if (patch.priority && patch.priority !== t.priority) {
    set.priority = patch.priority;
    said.push(`Set the priority to ${patch.priority}.`);
  }
  if (patch.proofRequired !== undefined && patch.proofRequired !== t.proofRequired) {
    set.proofRequired = patch.proofRequired;
    said.push(patch.proofRequired ? "Asked for a screenshot when it closes." : "A screenshot is now optional when it closes.");
  }
  if (patch.remarkRequired !== undefined && patch.remarkRequired !== t.remarkRequired) {
    set.remarkRequired = patch.remarkRequired;
    said.push(patch.remarkRequired ? "Asked for a remark when it closes." : "A remark is now optional when it closes.");
  }
  if (patch.title !== undefined && patch.title.trim() && patch.title.trim() !== t.title) {
    set.title = patch.title.trim().slice(0, 200);
    said.push("Renamed it.");
  }
  if (patch.note !== undefined && (patch.note?.trim() || null) !== t.note) {
    set.note = patch.note?.trim() ? patch.note.trim().slice(0, NOTE_MAX) : null;
    said.push("Changed the note.");
  }
  if (!said.length) return ok(undefined);

  await db.update(tasks).set(set).where(and(eq(tasks.id, id), ne(tasks.status, "done")));
  for (const s of said) await event(id, user.id, "edited", s);

  /* Asking for proof on somebody else's task changes what they must do. */
  if (patch.proofRequired === true && t.assigneeId !== user.id && !t.proofRequired) {
    await notifyUsers([{ userId: t.assigneeId, title: `${first(user.name)} needs a screenshot to close a task`, body: t.title, href: taskHref(t) }]);
  }
  refresh();
  return ok(undefined, "Saved");
}

export async function toggleChecklistItem(id: string, index: number): Promise<Result> {
  const user = await requireUser();
  const d = await taskDetail(user, id);
  if (!d) return err("That task is not there any more.", "not_found");
  if (!d.can.close) return err("Only whoever holds the task ticks its steps.", "not_permitted");
  const list: TaskChecklistItem[] = d.task.checklist.map((c) => ({ ...c }));
  if (!list[index]) return err("That step is not there any more.", "not_found");
  list[index].done = !list[index].done;
  await db
    .update(tasks)
    .set({ checklist: list, status: d.task.status === "todo" ? "doing" : d.task.status, updatedAt: new Date() })
    .where(eq(tasks.id, id));
  await event(id, user.id, "step", `${list[index].done ? "Ticked" : "Unticked"} “${list[index].text}”.`);
  refresh();
  return ok(undefined);
}

export async function addTaskNote(id: string, body: string): Promise<Result> {
  const user = await requireUser();
  const text = body.trim();
  if (!text) return err("Write the note first.", "validation", [{ field: "note", message: "Empty." }]);
  const d = await taskDetail(user, id);
  if (!d) return err("That task is not there any more.", "not_found");
  if (!d.can.note) return err("You can't add notes to this task.", "not_permitted");
  await event(id, user.id, "note", text.slice(0, NOTE_MAX));
  const tell = [...new Set([d.task.assigneeId, d.task.createdById])].filter((u) => u !== user.id);
  await notifyUsers(tell.map((u) => ({ userId: u, title: `${first(user.name)} added a note`, body: `${d.task.title}: ${text.slice(0, 140)}`, href: taskHref(d.task) })));
  refresh();
  return ok(undefined, "Note added");
}

/* -------------------------------------------------------------- closing */

export type CloseTaskInput = { confirmed: boolean; remark: string; attachmentIds: string[] };

/**
 * Closing: the person says it is done, writes what was done, and — where the
 * task asks — shows it. The screenshots must be files THIS person uploaded and
 * nobody has bound to anything else, so a file id lifted from another task is
 * not evidence for this one.
 */
export async function closeTask(id: string, input: CloseTaskInput): Promise<Result> {
  const user = await requireUser();
  const d = await taskDetail(user, id);
  if (!d) return err("That task is not there any more.", "not_found");
  if (d.task.status === "done") return err("It is already closed.", "conflict");
  if (!d.can.close) return err("Only whoever holds the task, or a manager above them, can close it.", "not_permitted");

  const wanted = [...new Set(input.attachmentIds)].slice(0, 10);
  const proofs = wanted.length
    ? await db
        .select({ id: attachments.id })
        .from(attachments)
        .where(
          and(
            inArray(attachments.id, wanted),
            eq(attachments.uploadedById, user.id),
            eq(attachments.status, "available"),
            or(isNull(attachments.parentId), and(eq(attachments.parentType, "task"), eq(attachments.parentId, id))),
          ),
        )
    : [];
  const problems = closeProblems({ confirmed: input.confirmed, remark: input.remark, proofs: proofs.length, proofRequired: d.task.proofRequired, remarkRequired: d.task.remarkRequired });
  if (problems.length) return fieldsErr(problems);

  const remark = input.remark.trim();
  const closed = await db
    .update(tasks)
    .set({ status: "done", closedAt: new Date(), closedById: user.id, closeRemark: remark, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), ne(tasks.status, "done")))
    .returning({ id: tasks.id });
  if (!closed.length) return err("Somebody closed it a moment ago.", "conflict");

  if (proofs.length) await bindAttachments(proofs.map((p) => p.id), "task", id);
  await event(id, user.id, "closed", `${remark || "Done."}${proofs.length ? ` (${proofs.length} screenshot${proofs.length === 1 ? "" : "s"})` : ""}`);

  /* An offer still open on a task that is now done is an offer of nothing. */
  if (d.task.transfer) {
    await db
      .update(taskTransfers)
      .set({ status: "withdrawn", decidedById: user.id, decidedAt: new Date(), decisionNote: "Closed before it was accepted." })
      .where(and(eq(taskTransfers.id, d.task.transfer.id), eq(taskTransfers.status, "pending")));
  }
  await audit(user.id, "task.closed", id, { remark, proofs: proofs.length });

  const tell: NotifyEntry[] = [];
  if (d.task.createdById !== user.id) tell.push({ userId: d.task.createdById, title: `${first(user.name)} closed a task you gave`, body: remark ? `${d.task.title} — “${remark.slice(0, 140)}”` : d.task.title, href: taskHref(d.task) });
  if (d.task.assigneeId !== user.id && d.task.assigneeId !== d.task.createdById) tell.push({ userId: d.task.assigneeId, title: `${first(user.name)} closed your task`, body: d.task.title, href: taskHref(d.task) });
  await notifyUsers(tell);
  refresh();
  return ok(undefined, "Closed");
}

export async function reopenTask(id: string): Promise<Result> {
  const user = await requireUser();
  const d = await taskDetail(user, id);
  if (!d) return err("That task is not there any more.", "not_found");
  if (!d.can.reopen) return err("You can't reopen this task.", "not_permitted");
  await db
    .update(tasks)
    .set({ status: "todo", closedAt: null, closedById: null, closeRemark: null, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), eq(tasks.status, "done")));
  await event(id, user.id, "reopened", "Reopened it.");
  await audit(user.id, "task.reopened", id, {});
  if (d.task.assigneeId !== user.id) await notifyUsers([{ userId: d.task.assigneeId, title: `${first(user.name)} reopened a task`, body: d.task.title, href: taskHref(d.task) }]);
  refresh();
  return ok(undefined, "Reopened");
}

export async function deleteTask(id: string): Promise<Result> {
  const user = await requireUser();
  const d = await taskDetail(user, id);
  if (!d) return err("That task is not there any more.", "not_found");
  if (!d.can.delete) return err("Only the person who gave a task can delete it, and not once somebody else has closed it.", "not_permitted");
  await audit(user.id, "task.deleted", id, { title: d.task.title, assigneeId: d.task.assigneeId });
  await db.delete(tasks).where(eq(tasks.id, id));
  if (d.task.assigneeId !== user.id && d.task.status !== "done") {
    await notifyUsers([{ userId: d.task.assigneeId, title: `${first(user.name)} took back a task`, body: d.task.title, href: taskHref(d.task) }]);
  }
  refresh();
  return ok(undefined, "Deleted");
}

/* ------------------------------------------------------------- transfers */

/**
 * Hand a task to somebody else. A manager above both people moves it at once;
 * anybody else asks, and it stays with its assignee until the other person
 * accepts — work does not land on somebody because a colleague decided it.
 */
export async function transferTask(id: string, input: { toId: string; reason: string }): Promise<Result<{ route: "move" | "request" }>> {
  const user = await requireUser();
  const d = await taskDetail(user, id);
  if (!d) return err("That task is not there any more.", "not_found");
  if (!d.can.transfer) return err(d.task.transfer ? "It is already offered to somebody — withdraw that first." : "You can't hand this task over.", "not_permitted");

  const t = d.task;
  const route = transferRoute({ actorManagesBoth: await viewerManagesBoth(user, t.assigneeId, input.toId) });
  const problems = transferProblems({ route, fromId: t.assigneeId, toId: input.toId, reason: input.reason });
  if (problems.length) return fieldsErr(problems);
  if (!(await canReceive(input.toId, t.app))) {
    return err(`They can't open ${TASK_APP_LABEL[t.app]} or Tasks, so they would never see it.`, "validation", [{ field: "to", message: "Can't see it." }]);
  }
  /* Only the assignee, or somebody above them, asks on their behalf. */
  if (route === "request" && t.assigneeId !== user.id) return err("Only whoever holds the task can ask somebody to take it.", "not_permitted");

  const reason = input.reason.trim() || null;
  const toName = await nameOf(input.toId);
  if (route === "move") {
    const moved = await db
      .update(tasks)
      .set({ assigneeId: input.toId, status: t.status === "waiting" ? "todo" : t.status, updatedAt: new Date() })
      .where(and(eq(tasks.id, id), eq(tasks.assigneeId, t.assigneeId), ne(tasks.status, "done")))
      .returning({ id: tasks.id });
    if (!moved.length) return err("It changed hands a moment ago — open it again.", "conflict");
    await db.insert(taskTransfers).values({
      id: newId("ttr"),
      taskId: id,
      fromId: t.assigneeId,
      toId: input.toId,
      requestedById: user.id,
      reason,
      status: "moved",
      decidedById: user.id,
      decidedAt: new Date(),
    });
    await event(id, user.id, "moved", `Moved it from ${first(t.assigneeName)} to ${first(toName)}${reason ? `: ${reason}` : "."}`);
    await audit(user.id, "task.moved", id, { from: t.assigneeId, to: input.toId, reason });
    await notifyUsers(
      [
        { userId: input.toId, title: `${first(user.name)} gave you a task`, body: `${t.title}${reason ? ` — ${reason}` : ""}`, href: taskHref(t) },
        { userId: t.assigneeId, title: `${first(user.name)} moved your task to ${first(toName)}`, body: t.title, href: "/tasks/transfers" },
      ].filter((n) => n.userId !== user.id),
    );
    refresh();
    return ok({ route }, `Moved to ${first(toName)}`);
  }

  try {
    await db.insert(taskTransfers).values({ id: newId("ttr"), taskId: id, fromId: t.assigneeId, toId: input.toId, requestedById: user.id, reason, status: "pending" });
  } catch {
    return err("It is already offered to somebody — withdraw that first.", "conflict");
  }
  await event(id, user.id, "transfer_requested", `Asked ${first(toName)} to take it over: ${reason}`);
  await audit(user.id, "task.transfer.requested", id, { to: input.toId, reason });
  await notifyUsers([
    { userId: input.toId, title: `${first(user.name)} wants to hand you a task`, body: `${t.title} — “${reason}”. Review it, then accept or reject.`, href: `/tasks/transfers?task=${id}`, kind: "warn" },
  ]);
  refresh();
  return ok({ route }, `Sent to ${first(toName)}. It stays yours until they accept.`);
}

export async function decideTransfer(taskId: string, input: { accept: boolean; note?: string }): Promise<Result> {
  const user = await requireUser();
  const t = await getTaskRow(taskId);
  if (!t || !t.transfer || t.transfer.toId !== user.id) return err("That offer is not there any more.", "not_found");
  const tr = t.transfer;

  if (!input.accept) {
    const problems = rejectProblems(input.note ?? "");
    if (problems.length) return fieldsErr(problems);
    const note = input.note!.trim();
    const done = await db
      .update(taskTransfers)
      .set({ status: "rejected", decidedById: user.id, decidedAt: new Date(), decisionNote: note })
      .where(and(eq(taskTransfers.id, tr.id), eq(taskTransfers.status, "pending")))
      .returning({ id: taskTransfers.id });
    if (!done.length) return err("That offer is not there any more.", "conflict");
    await event(taskId, user.id, "transfer_rejected", `Rejected it: ${note}`);
    await audit(user.id, "task.transfer.rejected", taskId, { note });
    await notifyUsers([{ userId: tr.requestedById, title: `${first(user.name)} rejected your task`, body: `${t.title} — “${note}”. It stays with ${tr.requestedById === tr.fromId ? "you" : first(tr.fromName)}.`, href: taskHref(t), kind: "warn" }]);
    refresh();
    return ok(undefined, `Rejected — it stays with ${first(tr.fromName)}`);
  }

  const moved = await db
    .update(tasks)
    .set({ assigneeId: user.id, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.assigneeId, tr.fromId), ne(tasks.status, "done")))
    .returning({ id: tasks.id });
  if (!moved.length) {
    await db.update(taskTransfers).set({ status: "withdrawn", decidedAt: new Date(), decisionNote: "The task changed before it was accepted." }).where(eq(taskTransfers.id, tr.id));
    refresh();
    return err("The task changed before you accepted it — it is not yours.", "conflict");
  }
  await db.update(taskTransfers).set({ status: "accepted", decidedById: user.id, decidedAt: new Date(), decisionNote: input.note?.trim() || null }).where(eq(taskTransfers.id, tr.id));
  await event(taskId, user.id, "transfer_accepted", `Accepted it from ${first(tr.fromName)}.`);
  await audit(user.id, "task.transfer.accepted", taskId, { from: tr.fromId });
  const tell: NotifyEntry[] = [{ userId: tr.requestedById, title: `${first(user.name)} accepted your task`, body: t.title, href: "/tasks/transfers" }];
  if (t.createdById !== tr.requestedById && t.createdById !== user.id) tell.push({ userId: t.createdById, title: `${first(user.name)} now holds a task you gave`, body: `${t.title} — handed over by ${first(tr.fromName)}`, href: taskHref(t) });
  await notifyUsers(tell);
  refresh();
  return ok(undefined, "It is yours now");
}

export async function withdrawTransfer(taskId: string): Promise<Result> {
  const user = await requireUser();
  const t = await getTaskRow(taskId);
  if (!t || !t.transfer) return err("That offer is not there any more.", "not_found");
  if (t.transfer.requestedById !== user.id && t.transfer.fromId !== user.id) return err("Only whoever asked can withdraw it.", "not_permitted");
  const done = await db
    .update(taskTransfers)
    .set({ status: "withdrawn", decidedById: user.id, decidedAt: new Date() })
    .where(and(eq(taskTransfers.id, t.transfer.id), eq(taskTransfers.status, "pending")))
    .returning({ id: taskTransfers.id });
  if (!done.length) return err("They answered a moment ago.", "conflict");
  await event(taskId, user.id, "transfer_withdrawn", `Withdrew the request to ${first(t.transfer.toName)}.`);
  await audit(user.id, "task.transfer.withdrawn", taskId, { to: t.transfer.toId });
  await notifyUsers([{ userId: t.transfer.toId, title: `${first(user.name)} withdrew a task they offered you`, body: t.title, href: "/tasks/transfers" }]);
  refresh();
  return ok(undefined, "Withdrawn");
}

async function nameOf(id: string): Promise<string> {
  const rows = await db.execute<{ name: string }>(sql`select name from users where id = ${id}`);
  return rows[0]?.name ?? "them";
}

/* ------------------------------------------------------------------ reads
 * What the dialogs ask for when they open. Each answers only what the person
 * may see — the same functions the pages read.
 */

export async function loadTaskDetail(id: string): Promise<Result<NonNullable<Awaited<ReturnType<typeof taskDetail>>> & { today: string; viewerId: string }>> {
  const user = await requireUser();
  const d = await taskDetail(user, id);
  if (!d) return err("That task is not there any more, or it is not yours to see.", "not_found");
  return ok({ ...d, today: await today(), viewerId: user.id });
}

export type TaskOptions = {
  today: string;
  me: { id: string; name: string };
  /** The apps a task may be filed under, by this person: the ones they hold, and Personal. */
  apps: string[];
  team: { id: string; name: string; apps: string[] }[];
};

export async function loadTaskOptions(): Promise<Result<TaskOptions>> {
  const user = await requireUser();
  const [held, team, day] = await Promise.all([listUserApps(user.id), teamPeople(user, "give"), today()]);
  const apps = ["tasks", ...held.filter((a) => isTaskApp(a) && a !== "tasks")];
  return ok({ today: day, me: { id: user.id, name: user.name }, apps, team });
}

/**
 * The people a task in `app` can be given to, and the teams, designations,
 * departments and levels among them — only people who hold that app.
 */
export async function loadAudienceOptions(app: string): Promise<Result<AudienceOptions>> {
  const user = await requireUser();
  if (!isTaskApp(app)) return err("Pick an app.");
  return ok(await audienceOptions(user, app));
}

export type TransferCandidate = { id: string; name: string; route: "move" | "request" };

export async function loadTransferCandidates(id: string): Promise<Result<TransferCandidate[]>> {
  const user = await requireUser();
  const d = await taskDetail(user, id);
  if (!d || !d.can.transfer) return err("You can't hand this task over.", "not_permitted");
  const people = (await peopleForApp(d.task.app)).filter((p) => p.id !== d.task.assigneeId);
  const team = await teamOf(user);
  const above = (pid: string) => managesBoth(team, user.id, d.task.assigneeId, pid);
  /* Somebody asking for themselves can offer it to anybody; a manager acting
     for somebody else moves it within their team and nowhere else. */
  const mine = d.task.assigneeId === user.id;
  return ok(
    people
      .map((p) => ({ id: p.id, name: p.name, route: (above(p.id) ? "move" : "request") as "move" | "request" }))
      .filter((p) => mine || p.route === "move")
      .sort((a, b) => (a.route === b.route ? a.name.localeCompare(b.name) : a.route === "move" ? -1 : 1)),
  );
}

/* ------------------------------------------------------------ many at once */

/**
 * Start, park or move several tasks — the All tasks selection bar. Each goes
 * through `updateTask`, so each is checked exactly as one would be; a task this
 * person may not change is counted and named rather than stopping the rest.
 */
export async function bulkUpdateTasks(ids: string[], op: "doing" | "waiting" | "todo" | "tomorrow"): Promise<Result<{ done: number; skipped: number }>> {
  await requireUser();
  const day = await today();
  const tomorrow = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + 1));
  const next = `${tomorrow.getUTCFullYear()}-${String(tomorrow.getUTCMonth() + 1).padStart(2, "0")}-${String(tomorrow.getUTCDate()).padStart(2, "0")}`;
  let done = 0;
  let skipped = 0;
  for (const id of [...new Set(ids)].slice(0, 200)) {
    const r = await updateTask(id, op === "tomorrow" ? { dueDate: next } : { status: op });
    if (r.ok) done++;
    else skipped++;
  }
  refresh();
  const verb = op === "tomorrow" ? "Moved to tomorrow" : op === "doing" ? "Started" : op === "waiting" ? "Marked waiting" : "Moved to To do";
  return ok({ done, skipped }, `${verb}: ${done}${skipped ? ` · ${skipped} you can't change` : ""}`);
}

/**
 * Close several tasks with one confirmation and one remark. A task that needs
 * a screenshot is closed on its own — a screenshot is evidence about ONE task.
 */
export async function closeTasks(ids: string[], input: { confirmed: boolean; remark: string }): Promise<Result<{ closed: number }>> {
  const user = await requireUser();
  const list = [...new Set(ids)].slice(0, 200);
  const details = await Promise.all(list.map((id) => taskDetail(user, id)));
  if (details.some((d) => !d || !d.can.close)) return err("One of them is not yours to close any more. Refresh and try again.", "not_permitted");
  if (details.some((d) => d!.task.proofRequired)) return err("Some of these need a screenshot — close those one at a time.", "validation", [{ field: "proof", message: "Needs a screenshot." }]);
  const needRemark = details.some((d) => d!.task.remarkRequired);
  const problems = closeProblems({ confirmed: input.confirmed, remark: input.remark, proofs: 0, proofRequired: false, remarkRequired: needRemark });
  if (problems.length) return fieldsErr(problems);
  let closed = 0;
  for (const id of list) {
    const r = await closeTask(id, { confirmed: true, remark: input.remark, attachmentIds: [] });
    if (r.ok) closed++;
  }
  refresh();
  return ok({ closed }, `Closed ${closed} task${closed === 1 ? "" : "s"}`);
}

/**
 * A reminder to somebody that something is late: one notification naming how
 * many and the oldest. Whoever manages their tasks nudges about all of it;
 * whoever only GAVE them work nudges about the late tasks they gave, and
 * nothing else of theirs.
 */
export async function nudgePerson(personId: string): Promise<Result> {
  const user = await requireUser();
  const manages = (await teamOf(user)).has(personId);
  const day = await today();
  const late = await db
    .select({ id: tasks.id, title: tasks.title, app: tasks.app, dueDate: tasks.dueDate })
    .from(tasks)
    .where(
      and(
        eq(tasks.assigneeId, personId),
        ne(tasks.status, "done"),
        sql`${tasks.dueDate} < ${day}::date`,
        manages ? undefined : eq(tasks.createdById, user.id),
      ),
    )
    .orderBy(tasks.dueDate)
    .limit(50);
  if (!late.length) return err(manages ? "Nothing of theirs is late." : "Nothing you gave them is late.", manages ? undefined : "not_permitted");
  const oldest = late[0];
  await notifyUsers([
    {
      userId: personId,
      title: `${first(user.name)} nudged you: ${late.length} late task${late.length === 1 ? "" : "s"}`,
      body: `Oldest: ${oldest.title}`,
      kind: "warn",
      href: late.length === 1 ? taskHref({ id: oldest.id, app: oldest.app }) : "/tasks/all",
    },
  ]);
  await db.insert(auditLog).values({ id: newId("aud"), actorId: user.id, action: "task.nudged", entityType: "user", entityId: personId, afterState: { late: late.length } as never });
  return ok(undefined, "Nudged — they have been told.");
}
