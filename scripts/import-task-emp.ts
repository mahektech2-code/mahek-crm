/**
 * Read the old AppSheet "Task EMP 2.0" workbook into the MahekOne Tasks app:
 * the To Do List tab as tasks, and the Task List tab as routines.
 *
 *   npm run tasks:import-task-emp                 dry run: what would be written
 *   npm run tasks:import-task-emp -- --apply      write it
 *   npm run tasks:import-task-emp:prod [-- --apply]
 *                                                 the same against prod, through
 *                                                 the tunnel (.env.prod.local's
 *                                                 DATABASE_URL wins; .env.local
 *                                                 supplies the Google credentials)
 *
 * The mapping is in src/lib/tasks/task-emp-import.ts. People are matched by
 * name to MahekOne ACCOUNTS, because a task belongs to somebody who can sign
 * in; a to-do given to somebody with no account is held back and named.
 *
 * Everybody who ends up holding an imported task and does not already hold
 * the Tasks app is granted it as an associate — the same grant
 * `npm run app:grant` makes — or they would hold tasks they can never see.
 *
 * Re-runnable. Each task's id is derived from the sheet's To Do Task Id and each
 * routine carries `source = task-emp:<Sr. No>`, and anything that already exists
 * is left exactly as it is — somebody may have changed it since. Nobody is
 * notified: these are old records arriving, not new work being given.
 *
 * A routine starts today, so today's task appears where today is one of its
 * days. A MONTHLY routine whose task for this month already came across from
 * the To Do List starts next month instead, or this month's task would be
 * there twice.
 *
 * The workbook must be shared Viewer with the service account (GOOGLE_SA_*).
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "../src/db";
import { appAccess, auditLog, taskEvents, taskRoutines, tasks, users } from "../src/db/schema";
import { readTab } from "../src/lib/sheets";
import { grantAppWithDefaultModules, rederiveAccountLevel } from "../src/lib/services/app-provisioning";
import { mapTaskList, mapToDoList, norm, routineKey, todoAsTask } from "../src/lib/tasks/task-emp-import";
import { writeRoutineTasks } from "../src/lib/tasks/routine-service";
import { scheduleWords } from "../src/lib/tasks/routines";

const SPREADSHEET_ID = "1wH9kM8aKcL_WKZ7_hNTTuSDaETc0IuRYxe56eTgxU_M";

const count = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

async function main() {
  const apply = process.argv.includes("--apply");
  const unknown = process.argv.slice(2).filter((a) => a !== "--apply");
  if (unknown.length) throw new Error(`Unknown option ${unknown.join(" ")} — the only option is --apply.`);

  const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname.slice(1);
  console.log(`${apply ? "APPLYING to" : "Dry run against"} database “${dbName}”`);

  const accounts = await db.select({ id: users.id, name: users.name, active: users.active }).from(users);
  // Only accounts that can sign in may hold a task.
  const refs = accounts.filter((u) => u.active).map((u) => ({ id: u.id, code: "", name: u.name, active: true }));
  const nameOf = new Map(accounts.map((u) => [u.id, u.name]));

  const sheet = await readTab(SPREADSHEET_ID, "To Do List");
  const mapped = mapToDoList(sheet.rows, refs);
  const rows = mapped.drafts.map(todoAsTask);

  const existing = new Set((await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, rows.map((r) => r.id).concat(["-"])))).map((r) => r.id));
  const toInsert = rows.filter((r) => !existing.has(r.id));

  /* ------------------------------------------------------------ routines */
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const nextMonth = (() => {
    const [y, m] = day.split("-").map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  })();
  const taskList = await readTab(SPREADSHEET_ID, "Task List");
  const plan = mapTaskList(taskList.rows, refs);
  const existingRoutines = await db
    .select({ id: taskRoutines.id, source: taskRoutines.source, assigneeId: taskRoutines.assigneeId, title: taskRoutines.title, frequency: taskRoutines.frequency, weekdays: taskRoutines.weekdays, dayOfMonth: taskRoutines.dayOfMonth, startTime: taskRoutines.startTime })
    .from(taskRoutines);
  const bySource = new Set(existingRoutines.map((r) => r.source).filter(Boolean));
  // Routines given by rules belong to no one person, so they never match an imported row.
  const byKey = new Map(existingRoutines.flatMap((r) => (r.assigneeId ? [[routineKey({ ...r, assigneeId: r.assigneeId, frequency: r.frequency as never }), r.id] as const] : [])));
  // This month's monthly tasks already imported from the To Do List — in the
  // database, or arriving in this same run.
  const month = day.slice(0, 7);
  const importedThisMonth = new Set(
    [
      ...(await db.select({ a: tasks.assigneeId, t: tasks.title, d: tasks.dueDate }).from(tasks).where(like(tasks.id, "tsk_taskemp_%"))).map((r) => ({ a: r.a, t: r.t, d: String(r.d) })),
      ...toInsert.map((r) => ({ a: r.assigneeId, t: r.title, d: r.dueDate })),
    ]
      .filter((r) => r.d.startsWith(month))
      .map((r) => `${r.a}|${norm(r.t)}`),
  );
  const routinesToInsert = plan.drafts.filter((d) => {
    if (bySource.has(`task-emp:${d.sr}`)) return false;
    const by = byKey.get(routineKey(d));
    if (by) {
      plan.skipped.push({ sr: String(d.sr), rowNumber: d.rowNumber, name: d.assigneeName, task: d.title, reason: `already a routine (${by})` });
      return false;
    }
    return true;
  });
  const startsOn = (d: (typeof routinesToInsert)[number]) =>
    d.frequency === "monthly" && importedThisMonth.has(`${d.assigneeId}|${norm(d.title)}`) ? nextMonth : day;

  console.log(`\n== Task List → routines\nSheet rows: ${taskList.rows.length}   routines to add: ${routinesToInsert.length}   already imported: ${plan.drafts.filter((d) => bySource.has(`task-emp:${d.sr}`)).length}   not added: ${plan.skipped.length}`);
  console.log(`By frequency: ${count(routinesToInsert, (d) => d.frequency).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`By person: ${count(routinesToInsert, (d) => d.assigneeName).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`Monthly ones starting next month (this month's task already imported): ${routinesToInsert.filter((d) => startsOn(d) === nextMonth).length}`);
  const fixed = routinesToInsert.filter((d) => d.fixes.some((f) => !f.startsWith("no days named")));
  if (fixed.length) console.log(`Corrected on the way in:\n${fixed.map((d) => `  Sr ${d.sr} ${d.assigneeName} — ${d.title}: ${d.fixes.join("; ")}`).join("\n")}`);
  console.log(`Daily rows naming no days, set to Monday–Saturday: ${routinesToInsert.filter((d) => d.fixes.some((f) => f.startsWith("no days named"))).length}`);
  console.log(`Schedules: ${count(routinesToInsert, (d) => scheduleWords(d)).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (plan.skipped.length) {
    console.log("Not added:");
    for (const [reason, n] of count(plan.skipped, (s) => s.reason)) console.log(`  ${reason} — ${n}`);
    for (const s of plan.skipped.filter((x) => /which day|same routine|correction/.test(x.reason))) console.log(`     Sr ${s.sr} ${s.name}: ${s.task}`);
  }

  const holders = [...new Set([...toInsert.map((r) => r.assigneeId), ...routinesToInsert.map((r) => r.assigneeId)])];
  const withTasks = new Set(
    (await db.select({ userId: appAccess.userId }).from(appAccess).where(and(eq(appAccess.app, "tasks"), inArray(appAccess.userId, holders.concat(["-"]))))).map((r) => r.userId),
  );
  const toGrant = holders.filter((id) => !withTasks.has(id));

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const open = toInsert.filter((r) => r.status === "todo");
  console.log(`\n== To Do List → tasks\nSheet rows: ${sheet.rows.length}   tasks to add: ${toInsert.length}   already imported: ${rows.length - toInsert.length}   duplicate copies merged: ${mapped.merged}   not added: ${mapped.skipped.length}`);
  console.log(`Done: ${toInsert.length - open.length} (verified ${toInsert.filter((r) => r.events.some((e) => e.body.startsWith("Checked and verified"))).length})   Open: ${open.length}, of which late ${open.filter((r) => r.dueDate < today).length}`);
  console.log(`Priority: ${count(toInsert, (r) => r.priority).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`Held by: ${count(toInsert, (r) => nameOf.get(r.assigneeId) ?? r.assigneeId).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`Open by person: ${count(open, (r) => nameOf.get(r.assigneeId) ?? r.assigneeId).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`Given by (creator): ${count(toInsert, (r) => nameOf.get(r.createdById) ?? r.createdById).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`Titles shortened to 200 characters (full text kept in the note): ${toInsert.filter((r) => r.title.endsWith("…")).length}`);
  console.log(`Granted the Tasks app as associate: ${toGrant.length ? toGrant.map((id) => nameOf.get(id)).join(", ") : "nobody new"}`);
  if (mapped.skipped.length) {
    console.log("Not added:");
    for (const [reason, n] of count(mapped.skipped, (s) => s.reason)) console.log(`  ${reason} — ${n}`);
  }

  if (!apply) {
    console.log("\nNothing written. Run again with --apply to write.");
    return;
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < toInsert.length; i += 500) {
      const chunk = toInsert.slice(i, i + 500);
      await tx
        .insert(tasks)
        .values(
          chunk.map((r) => ({
            id: r.id,
            title: r.title,
            note: r.note,
            app: r.app,
            assigneeId: r.assigneeId,
            createdById: r.createdById,
            status: r.status,
            priority: r.priority,
            dueDate: r.dueDate,
            closedAt: r.closedAt,
            closedById: r.closedById,
            closeRemark: r.closeRemark,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          })),
        )
        .onConflictDoNothing({ target: tasks.id });
      await tx.insert(taskEvents).values(
        chunk.flatMap((r) => r.events.map((e, k) => ({ id: `tev_taskemp_${r.id.slice(12)}_${k}`, taskId: r.id, actorId: e.actorId, kind: e.kind, body: e.body, createdAt: e.at }))),
      ).onConflictDoNothing({ target: taskEvents.id });
    }
    for (let i = 0; i < routinesToInsert.length; i += 200) {
      await tx
        .insert(taskRoutines)
        .values(
          routinesToInsert.slice(i, i + 200).map((d) => ({
            id: `trt_taskemp_${d.sr}`,
            title: d.title,
            note: d.note,
            app: "tasks",
            assigneeId: d.assigneeId,
            createdById: d.assigneeId,
            priority: d.priority,
            frequency: d.frequency,
            weekdays: d.weekdays,
            dayOfMonth: d.dayOfMonth,
            completeByDay: d.completeByDay,
            startTime: d.startTime,
            dueTime: d.dueTime,
            startsOn: startsOn(d),
            source: `task-emp:${d.sr}`,
          })),
        )
        .onConflictDoNothing();
    }
    for (const userId of toGrant) {
      await grantAppWithDefaultModules(tx, { userId, app: "tasks", grantedById: null, level: "associate" });
      const accountLevel = await rederiveAccountLevel(tx, userId);
      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: null,
        action: "app-grant",
        entityType: "user",
        entityId: userId,
        afterState: { detail: "granted tasks as associate (Task EMP 2.0 import)", accountLevel } as never,
      });
    }
    await tx.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      actorId: null,
      action: "tasks.import",
      entityType: "tasks",
      afterState: { source: SPREADSHEET_ID, tasksAdded: toInsert.length, merged: mapped.merged, tasksNotAdded: mapped.skipped.length, routinesAdded: routinesToInsert.length, routinesNotAdded: plan.skipped.length, granted: toGrant.length } as never,
    });
  });
  // Today's tasks from the routines just added, rather than at the next hourly run.
  const fromRoutines = await writeRoutineTasks(day);
  console.log(`\nWritten: ${toInsert.length} tasks and ${routinesToInsert.length} routines (${fromRoutines} tasks for today); Tasks app granted to ${toGrant.length}.`);
}

main()
  .then(() => db.$client.end())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await db.$client.end();
    process.exit(1);
  });
