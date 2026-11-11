/**
 * THE TASKS APP, end to end — the actions against a real database.
 *
 * Closing is a confirmation, a remark and, where the creator asked, a
 * screenshot this person uploaded; a colleague's transfer waits for consent; a
 * manager above both people moves a task at once; nobody outside a task can
 * read it. Each is asked here of the real actions, signed in as the person.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, attachments, notifications, taskTransfers, tasks, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { closeTask, createTask, decideTransfer, loadTaskDetail, transferTask, updateTask } from "@/lib/actions/tasks";

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

async function upload(userId: string) {
  const attId = id("att");
  await db.insert(attachments).values({ id: attId, filename: "proof.png", storedRef: "x", contentType: "image/png", sizeBytes: 10, status: "available", uploadedById: userId });
  return attId;
}

const task = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];

let vikram: typeof users.$inferSelect; // the manager
let priya: typeof users.$inferSelect; // reports to Vikram
let rakesh: typeof users.$inferSelect; // reports to Vikram
let deepa: typeof users.$inferSelect; // nobody's manager here, nobody's report

const today = () => new Date().toISOString().slice(0, 10);

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table task_transfers, task_events, tasks, task_batches, attachments, audit_log, notifications,
      app_module_access, app_access, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  vikram = await makeUser("Vikram Shah");
  priya = await makeUser("Priya Sharma", vikram.id);
  rakesh = await makeUser("Rakesh Iyer", vikram.id);
  deepa = await makeUser("Deepa Menon");
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("Closing a task", () => {
  test("asks for a confirmation and a remark, and records who closed it", async () => {
    setTestUser(priya);
    const made = await createTask({ title: "Tidy my call notes", app: "tasks", dueDate: today(), priority: "normal", proofRequired: false, assigneeIds: [] });
    assert.ok(made.ok);
    const tid = made.data.ids[0];

    const bare = await closeTask(tid, { confirmed: false, remark: "", attachmentIds: [] });
    assert.ok(!bare.ok);
    assert.deepEqual(bare.fieldErrors?.map((f) => f.field), ["confirmed", "remark"]);
    assert.equal((await task(tid)).status, "todo");

    const done = await closeTask(tid, { confirmed: true, remark: "Notes tidied for Monday and Tuesday.", attachmentIds: [] });
    assert.ok(done.ok, done.ok ? "" : done.error);
    const t = await task(tid);
    assert.equal(t.status, "done");
    assert.equal(t.closedById, priya.id);
    assert.equal(t.closeRemark, "Notes tidied for Monday and Tuesday.");
  });

  test("needs a screenshot where the creator asked for one — and only one this person uploaded", async () => {
    setTestUser(vikram);
    const given = await createTask({ title: "Send October statements", app: "tasks", dueDate: today(), priority: "high", proofRequired: true, assigneeIds: [priya.id] });
    assert.ok(given.ok, given.ok ? "" : given.error);
    const tid = given.data.ids[0];
    const told = await db.select().from(notifications).where(eq(notifications.userId, priya.id));
    assert.equal(told.length, 1, "the person given a task is told");

    setTestUser(priya);
    const noProof = await closeTask(tid, { confirmed: true, remark: "Sent all thirty.", attachmentIds: [] });
    assert.ok(!noProof.ok);
    assert.equal(noProof.fieldErrors?.[0].field, "proof");

    const someoneElses = await upload(rakesh.id);
    const borrowed = await closeTask(tid, { confirmed: true, remark: "Sent all thirty.", attachmentIds: [someoneElses] });
    assert.ok(!borrowed.ok, "a file somebody else uploaded is not evidence");

    const mine = await upload(priya.id);
    const ok = await closeTask(tid, { confirmed: true, remark: "Sent all thirty.", attachmentIds: [mine] });
    assert.ok(ok.ok, ok.ok ? "" : ok.error);
    const [bound] = await db.select().from(attachments).where(eq(attachments.id, mine));
    assert.equal(bound.parentType, "task");
    assert.equal(bound.parentId, tid);
    const creatorTold = await db.select().from(notifications).where(eq(notifications.userId, vikram.id));
    assert.equal(creatorTold.length, 1, "whoever gave the task hears it closed");
  });

  test("only the creator, or somebody above the assignee, decides whether a screenshot is needed", async () => {
    setTestUser(vikram);
    const given = await createTask({ title: "Call the dormant shops", app: "tasks", dueDate: today(), priority: "normal", proofRequired: false, assigneeIds: [priya.id] });
    assert.ok(given.ok);
    const tid = given.data.ids[0];
    setTestUser(priya);
    const changed = await updateTask(tid, { proofRequired: true });
    assert.ok(!changed.ok, "the assignee cannot set it");
    setTestUser(vikram);
    assert.ok((await updateTask(tid, { proofRequired: true })).ok);
    assert.equal((await task(tid)).proofRequired, true);
  });
});

describe("Transferring a task", () => {
  test("a colleague's request waits for consent, and accepting moves it", async () => {
    setTestUser(priya);
    const made = await createTask({ title: "Call back Balaji Wood Works", app: "tasks", dueDate: today(), priority: "normal", proofRequired: false, assigneeIds: [] });
    assert.ok(made.ok);
    const tid = made.data.ids[0];

    const noReason = await transferTask(tid, { toId: rakesh.id, reason: "" });
    assert.ok(!noReason.ok, "a request says why");

    const asked = await transferTask(tid, { toId: rakesh.id, reason: "I'm at the Bhiwandi visits all day." });
    assert.ok(asked.ok, asked.ok ? "" : asked.error);
    assert.equal(asked.data.route, "request");
    assert.equal((await task(tid)).assigneeId, priya.id, "it stays hers until he accepts");

    const again = await transferTask(tid, { toId: deepa.id, reason: "Or Deepa" });
    assert.ok(!again.ok, "one open request per task");

    setTestUser(rakesh);
    const seen = await loadTaskDetail(tid);
    assert.ok(seen.ok && seen.data.can.decideTransfer, "the person offered a task can review it");
    assert.ok(!seen.ok || !seen.data.can.close, "and cannot close it before accepting");
    const accepted = await decideTransfer(tid, { accept: true });
    assert.ok(accepted.ok, accepted.ok ? "" : accepted.error);
    assert.equal((await task(tid)).assigneeId, rakesh.id);
    const [tr] = await db.select().from(taskTransfers).where(eq(taskTransfers.taskId, tid));
    assert.equal(tr.status, "accepted");
  });

  test("rejecting says why, and the task stays where it was", async () => {
    setTestUser(priya);
    const made = await createTask({ title: "Chase Colour Camp", app: "tasks", dueDate: today(), priority: "high", proofRequired: false, assigneeIds: [] });
    assert.ok(made.ok);
    const tid = made.data.ids[0];
    assert.ok((await transferTask(tid, { toId: rakesh.id, reason: "He knows them" })).ok);
    setTestUser(rakesh);
    assert.ok(!(await decideTransfer(tid, { accept: false, note: "" })).ok);
    assert.ok((await decideTransfer(tid, { accept: false, note: "Colour Camp is Priya's book." })).ok);
    assert.equal((await task(tid)).assigneeId, priya.id);
  });

  test("a manager above both people moves it at once", async () => {
    setTestUser(vikram);
    const given = await createTask({ title: "Stock-check call", app: "tasks", dueDate: today(), priority: "normal", proofRequired: false, assigneeIds: [priya.id] });
    assert.ok(given.ok);
    const tid = given.data.ids[0];
    const moved = await transferTask(tid, { toId: rakesh.id, reason: "" });
    assert.ok(moved.ok, moved.ok ? "" : moved.error);
    assert.equal(moved.data.route, "move");
    assert.equal((await task(tid)).assigneeId, rakesh.id);
  });

  test("nobody gives a task to somebody outside their team, or reads one that isn't theirs", async () => {
    setTestUser(priya);
    const outside = await createTask({ title: "Do my work", app: "tasks", dueDate: today(), priority: "normal", proofRequired: false, assigneeIds: [rakesh.id] });
    assert.ok(!outside.ok, "a colleague is not your team");

    const made = await createTask({ title: "Private", app: "tasks", dueDate: today(), priority: "normal", proofRequired: false, assigneeIds: [] });
    assert.ok(made.ok);
    setTestUser(deepa);
    assert.ok(!(await loadTaskDetail(made.data.ids[0])).ok, "an outsider cannot read it");
    setTestUser(vikram);
    assert.ok((await loadTaskDetail(made.data.ids[0])).ok, "her manager can");
  });
});
