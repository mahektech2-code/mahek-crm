/**
 * ROUTINES, end to end — the actions and the writer against a real database.
 *
 * A routine set by a manager writes its person's task for today once, however
 * often the day is asked for; only whoever set it, or a manager above its
 * person, may change it; a paused routine writes nothing.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, notifications, tasks, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { deleteRoutine, saveRoutine, setRoutineActive } from "@/lib/actions/task-routines";
import { routinesFor, writeRoutineTasks } from "@/lib/tasks/routine-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, reportsToId: string | null = null) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      passwordHash: "x",
      role: reportsToId ? "associate" : "manager",
      initials: name.slice(0, 2).toUpperCase(),
      reportsToId,
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "tasks", role: reportsToId ? "associate" : "manager" });
  return row;
}

let vikram: typeof users.$inferSelect; // the manager
let priya: typeof users.$inferSelect; // reports to Vikram
let deepa: typeof users.$inferSelect; // nobody's manager here, nobody's report

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const routine = (assigneeId: string, title = "Download the bank statement") => ({
  assigneeId,
  title,
  app: "tasks",
  priority: "high",
  frequency: "daily",
  weekdays: EVERY_DAY,
  dayOfMonth: null,
  completeByDay: null,
  startTime: "14:00",
  dueTime: "16:00",
  proofRequired: false,
  checklist: "Download\nEnter in Tally",
});

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table task_routines, task_transfers, task_events, tasks, task_batches, audit_log, notifications,
      app_module_access, app_access, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  vikram = await makeUser("Vikram Shah");
  priya = await makeUser("Priya Sharma", vikram.id);
  deepa = await makeUser("Deepa Menon");
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("A routine", () => {
  test("set by a manager writes today's task once, however often the day is asked for", async () => {
    setTestUser(vikram);
    const made = await saveRoutine(routine(priya.id));
    assert.ok(made.ok, made.ok ? "" : made.error);
    const day = await today();
    assert.equal(await writeRoutineTasks(day), 0, "saving already wrote today's");
    assert.equal(await writeRoutineTasks(day, { assigneeId: priya.id }), 0);
    const written = await db.select().from(tasks).where(eq(tasks.assigneeId, priya.id));
    assert.equal(written.length, 1);
    assert.equal(written[0].routineDay, day);
    assert.equal(written[0].dueTime, "16:00");
    assert.equal(written[0].priority, "high");
    assert.deepEqual(written[0].checklist.map((c) => c.done), [false, false]);
    assert.equal((await db.select().from(notifications).where(eq(notifications.userId, priya.id))).length, 1, "she is told once, when it is set");
  });

  test("is changed only by whoever set it or a manager above its person", async () => {
    setTestUser(deepa);
    const outside = await saveRoutine(routine(priya.id));
    assert.ok(!outside.ok, "a colleague outside her line cannot set her one");

    setTestUser(vikram);
    const made = await saveRoutine(routine(priya.id));
    assert.ok(made.ok);
    setTestUser(priya);
    assert.ok(!(await setRoutineActive(made.data.id, false)).ok, "she cannot switch off what her manager set");
    assert.equal((await routinesFor(priya)).find((r) => r.id === made.data.id)?.canManage, false);
    assert.ok((await saveRoutine(routine(priya.id, "My own reminder"))).ok, "she can set her own");
  });

  test("writes nothing while paused, and deleting it keeps the tasks it wrote", async () => {
    setTestUser(vikram);
    const made = await saveRoutine(routine(priya.id));
    assert.ok(made.ok);
    assert.ok((await setRoutineActive(made.data.id, false)).ok);
    await db.delete(tasks);
    assert.equal(await writeRoutineTasks(await today()), 0, "a paused routine writes nothing");
    assert.ok((await setRoutineActive(made.data.id, true)).ok);
    assert.equal((await db.select().from(tasks)).length, 1, "resuming writes today's");
    assert.ok((await deleteRoutine(made.data.id)).ok);
    const [left] = await db.select().from(tasks);
    assert.ok(left, "the task stays");
    assert.equal(left.routineId, null);
  });
});
