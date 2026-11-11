/**
 * WHO GETS A TASK, end to end — include/exclude rules against a real database.
 *
 * Only people who hold the task's app are reachable; a team, a designation and
 * a level match the way the builder says; a person named on their own beats a
 * group; a routine given by rules is read again each day it runs, so a new
 * joiner picks it up; and a remark can be made optional.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, employees, taskRoutines, tasks, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { closeTask, createTask, loadAudienceOptions } from "@/lib/actions/tasks";
import { saveRoutine } from "@/lib/actions/task-routines";
import { writeRoutineTasks } from "@/lib/tasks/routine-service";
import type { Audience } from "@/lib/tasks/audience";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, opts: { reportsToId?: string | null; apps?: ("crm" | "tasks")[]; position?: string } = {}) {
  let employeeId: string | null = null;
  if (opts.position) {
    employeeId = id("emp");
    await db.insert(employees).values({ id: employeeId, rowNumber: 1, employeeCode: employeeId, name, position: opts.position, department: "Sales", raw: {}, rowHash: employeeId });
  }
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      passwordHash: "x",
      role: opts.reportsToId ? "associate" : "manager",
      initials: name.slice(0, 2).toUpperCase(),
      reportsToId: opts.reportsToId ?? null,
      employeeId,
    })
    .returning();
  for (const app of opts.apps ?? ["tasks"]) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role: opts.reportsToId ? "associate" : "manager" });
  return row;
}

let vikram: typeof users.$inferSelect;
let rahul: typeof users.$inferSelect;
let priya: typeof users.$inferSelect;
let rakesh: typeof users.$inferSelect;
let anjali: typeof users.$inferSelect;
let noCrm: typeof users.$inferSelect;

let businessDay = "";
const holders = async (taskTitle: string) =>
  (await db.select({ a: tasks.assigneeId }).from(tasks).where(eq(tasks.title, taskTitle))).map((r) => r.a).sort();
const sorted = (...xs: string[]) => [...xs].sort();

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table task_routines, task_transfers, task_events, tasks, task_batches, audit_log, notifications,
      app_module_access, app_access, users, employees, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  businessDay = await today();
  vikram = await makeUser("Vikram Shah", { apps: ["tasks", "crm"] });
  rahul = await makeUser("Rahul Mehta", { reportsToId: vikram.id, apps: ["crm"], position: "Team Lead" });
  priya = await makeUser("Priya Sharma", { reportsToId: rahul.id, apps: ["crm"], position: "Telecaller" });
  rakesh = await makeUser("Rakesh Iyer", { reportsToId: rahul.id, apps: ["crm"], position: "Telecaller" });
  anjali = await makeUser("Anjali Rao", { reportsToId: vikram.id, apps: ["crm"], position: "Telecaller" });
  noCrm = await makeUser("Neha Kapoor", { reportsToId: vikram.id, apps: ["tasks"], position: "Telecaller" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

const once = (title: string, audience: Audience) => ({ title, app: "crm", dueDate: businessDay, priority: "normal", proofRequired: false, assigneeIds: [], audience });

describe("Who gets a task", () => {
  test("only people who hold the app are offered, with the designations and teams among them", async () => {
    setTestUser(vikram);
    const r = await loadAudienceOptions("crm");
    assert.ok(r.ok);
    const names = r.data.people.map((p) => p.name).sort();
    assert.ok(!names.includes("Neha Kapoor"), "no CRM, not offered for a CRM task");
    assert.deepEqual(r.data.choices.designation.find((d) => d.label === "Telecaller")?.count, 3);
    assert.ok(r.data.choices.team.some((t) => t.value === rahul.id));
  });

  test("a designation, minus a team, plus one person by name", async () => {
    setTestUser(vikram);
    const audience: Audience = {
      include: [
        { kind: "designation", value: "Telecaller", label: "Designation: Telecaller" },
        { kind: "person", value: priya.id, label: "Priya Sharma" },
      ],
      exclude: [{ kind: "team", value: rahul.id, label: "Everyone under Rahul Mehta" }],
    };
    const made = await createTask(once("Call the dormant shops", audience));
    assert.ok(made.ok, made.ok ? "" : made.error);
    assert.deepEqual(await holders("Call the dormant shops"), sorted(anjali.id, priya.id), "Rakesh is excluded with his team; Priya is named; Neha has no CRM");
  });

  test("rules that reach nobody are refused, and nobody reaches past their own team", async () => {
    setTestUser(vikram);
    const none = await createTask(once("Nobody", { include: [{ kind: "designation", value: "Astronaut", label: "Astronaut" }], exclude: [] }));
    assert.ok(!none.ok);
    setTestUser(rahul);
    await db.insert(appAccess).values({ id: id("aca"), userId: rahul.id, app: "tasks", role: "manager" });
    const made = await createTask(once("Team call", { include: [{ kind: "designation", value: "Telecaller", label: "Telecaller" }], exclude: [] }));
    assert.ok(made.ok, made.ok ? "" : made.error);
    assert.deepEqual(await holders("Team call"), sorted(priya.id, rakesh.id), "Rahul's reach stops at his own people — not Anjali");
  });

  test("a routine given by rules is read again each day — a new Telecaller picks it up", async () => {
    setTestUser(vikram);
    const saved = await saveRoutine({
      assigneeId: null,
      audience: { include: [{ kind: "designation", value: "Telecaller", label: "Telecaller" }], exclude: [{ kind: "person", value: rakesh.id, label: "Rakesh Iyer" }] },
      title: "Morning stock-check calls",
      app: "crm",
      priority: "normal",
      frequency: "daily",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      dayOfMonth: null,
      completeByDay: null,
      startTime: null,
      dueTime: null,
      proofRequired: false,
      remarkRequired: false,
    });
    assert.ok(saved.ok, saved.ok ? "" : saved.error);
    const [r] = await db.select().from(taskRoutines);
    assert.equal(r.assigneeId, null);
    assert.deepEqual(await holders("Morning stock-check calls"), sorted(anjali.id, priya.id));
    assert.equal(await writeRoutineTasks(await today()), 0, "asking again for today writes nothing");

    const newJoiner = await makeUser("Kiran Das", { reportsToId: vikram.id, apps: ["crm"], position: "Telecaller" });
    await db.delete(tasks);
    assert.equal(await writeRoutineTasks(await today()), 3, "the next run reaches her too");
    assert.ok((await holders("Morning stock-check calls")).includes(newJoiner.id));
    const [hers] = await db.select().from(tasks).where(eq(tasks.assigneeId, newJoiner.id));
    assert.equal(hers.remarkRequired, false);
  });

  test("a task whose creator made the remark optional closes without one", async () => {
    setTestUser(vikram);
    const made = await createTask({ ...once("Tick the register", { include: [{ kind: "person", value: anjali.id, label: "Anjali" }], exclude: [] }), remarkRequired: false });
    assert.ok(made.ok);
    setTestUser(anjali);
    const closed = await closeTask(made.data.ids[0], { confirmed: true, remark: "", attachmentIds: [] });
    assert.ok(closed.ok, closed.ok ? "" : closed.error);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, made.data.ids[0]));
    assert.equal(t.status, "done");
  });
});
