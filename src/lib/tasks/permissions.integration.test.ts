/**
 * THE TASKS PERMISSIONS, end to end: granted on the Access screen through the
 * real `setAccess`, read back by the real Tasks actions. The org chart is the
 * baseline; each permission widens one reach and nothing else.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, taskUserPowers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { moduleKeysForApp } from "@/lib/modules";
import { setAccess } from "@/lib/actions/access";
import { createTask, deleteTask, loadTaskDetail, nudgePerson, updateTask } from "@/lib/actions/tasks";
import { listAccess } from "@/lib/services/access-service";
import { canManageAutomations } from "./setup-access";
import { teamPeople } from "./service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

type U = typeof users.$inferSelect;
let boss: U; // platform administrator — the only person setAccess lets in
let vikram: U; // a manager
let priya: U; // reports to Vikram
let deepa: U; // the coordinator: nobody reports to her, she reports to nobody

async function makeUser(name: string, opts: { reportsToId?: string | null; level?: "associate" | "manager" | "admin"; admin?: boolean } = {}) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      passwordHash: "x",
      role: opts.admin ? "admin" : (opts.level ?? "associate"),
      initials: name.slice(0, 2).toUpperCase(),
      reportsToId: opts.reportsToId ?? null,
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "tasks", role: opts.level ?? "associate" });
  if (opts.admin) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "admin", role: "admin" });
  return row;
}

/** Deepa's Tasks grant, saved by the platform administrator with these permissions ticked. */
async function grantDeepa(taskPowers: string[]) {
  setTestUser(boss);
  const r = await setAccess({ userId: deepa.id, grants: [{ app: "tasks", modules: moduleKeysForApp("tasks"), role: "associate" }], taskPowers });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
}

async function priyasTask(due = today()) {
  setTestUser(vikram);
  const r = await createTask({ title: "Ring Hari Om Paints", app: "tasks", dueDate: due, priority: "normal", proofRequired: false, assigneeIds: [priya.id] });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return r.ok ? r.data.ids[0] : "";
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table task_user_powers, task_transfers, task_events, tasks, task_batches, attachments, audit_log, notifications,
      app_module_access, app_access, sessions, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  boss = await makeUser("Boss Admin", { admin: true });
  vikram = await makeUser("Vikram Shah", { level: "manager" });
  priya = await makeUser("Priya Sharma", { reportsToId: vikram.id });
  deepa = await makeUser("Deepa Menon");
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("Without a permission, the org chart decides", () => {
  test("an outsider cannot read, give to, nudge, or run the automatic tasks", async () => {
    const taskId = await priyasTask(yesterday());
    setTestUser(deepa);
    assert.equal((await loadTaskDetail(taskId)).ok, false);
    const given = await createTask({ title: "x", app: "tasks", dueDate: today(), priority: "normal", proofRequired: false, assigneeIds: [priya.id] });
    assert.equal(given.ok, false);
    assert.equal((await nudgePerson(priya.id)).ok, false);
    assert.equal(await canManageAutomations(deepa), false);
    assert.deepEqual(await teamPeople(deepa), []);
  });
});

describe("Granted on the Access screen", () => {
  test("the rows are written, listed back, and cleared by saving none", async () => {
    await grantDeepa(["seeAll", "automations", "notAPower"]);
    const stored = (await db.select().from(taskUserPowers).where(eq(taskUserPowers.userId, deepa.id))).map((r) => r.power).sort();
    assert.deepEqual(stored, ["automations", "seeAll"]);
    setTestUser(boss);
    const row = (await listAccess()).find((a) => a.userId === deepa.id);
    assert.deepEqual([...(row?.taskPowers ?? [])].sort(), ["automations", "seeAll"]);
    await grantDeepa([]);
    assert.equal((await db.select().from(taskUserPowers).where(eq(taskUserPowers.userId, deepa.id))).length, 0);
  });

  test("See everyone's tasks opens anybody's task read-only", async () => {
    const taskId = await priyasTask();
    await grantDeepa(["seeAll"]);
    setTestUser(deepa);
    const d = await loadTaskDetail(taskId);
    assert.equal(d.ok, true);
    assert.equal(d.ok && d.data.can.edit, false);
    assert.equal(d.ok && d.data.can.close, false);
    assert.equal((await updateTask(taskId, { priority: "urgent" })).ok, false);
    const people = await teamPeople(deepa);
    assert.ok(people.some((p) => p.id === priya.id && p.manage === false), "listed, and not hers to manage");
  });

  test("Manage anyone's tasks changes and deletes anybody's, and nudges them", async () => {
    const taskId = await priyasTask(yesterday());
    await grantDeepa(["manageAnyone"]);
    setTestUser(deepa);
    const d = await loadTaskDetail(taskId);
    assert.equal(d.ok && d.data.can.edit && d.data.can.close && d.data.can.delete, true);
    assert.equal((await updateTask(taskId, { priority: "urgent" })).ok, true);
    assert.equal((await nudgePerson(priya.id)).ok, true);
    assert.equal((await deleteTask(taskId)).ok, true);
  });

  test("Give tasks to anyone puts work on somebody outside the org chart, and nothing more", async () => {
    await grantDeepa(["giveAnyone"]);
    setTestUser(deepa);
    const r = await createTask({ title: "Send the price list", app: "tasks", dueDate: today(), priority: "normal", proofRequired: false, assigneeIds: [priya.id] });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    // She gave it, so she reads it — but somebody else's task stays out of reach.
    const theirs = await priyasTask();
    setTestUser(deepa);
    assert.equal((await loadTaskDetail(theirs)).ok, false);
  });

  test("Run automatic tasks is the switch, and a Tasks administrator holds it without a row", async () => {
    await grantDeepa(["automations"]);
    assert.equal(await canManageAutomations(deepa), true);
    const admin = await makeUser("Tara Admin", { level: "admin" });
    assert.equal(await canManageAutomations(admin), true);
    const taskId = await priyasTask();
    setTestUser(admin);
    const d = await loadTaskDetail(taskId);
    assert.equal(d.ok && d.data.can.edit, true, "the admin level manages everybody's tasks");
  });
});
