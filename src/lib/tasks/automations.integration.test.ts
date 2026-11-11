/**
 * AUTOMATIC TASKS, end to end — the rules against a real database.
 *
 * A callback promised raises a task for whoever it is for, once however often
 * the job runs; completing the reminder closes the task with nobody's name on
 * it; a payment reported raises one per Accounts manager; switching a rule off
 * closes what it raised; and only a Tasks administrator may switch one.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, paymentReceipts, reminders, tasks, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { setAutomation } from "@/lib/actions/task-automations";
import { syncAutomations } from "@/lib/tasks/automation-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, grants: [string, string][]) {
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", role: "associate", initials: name.slice(0, 2).toUpperCase() })
    .returning();
  for (const [app, role] of grants) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: app as never, role: role as never });
  return row;
}

let priya: typeof users.$inferSelect;
let deepa: typeof users.$inferSelect;
let rohan: typeof users.$inferSelect;
let admin: typeof users.$inferSelect;
let customerId = "";
const auto = (rule: string) => db.select().from(tasks).where(eq(tasks.autoRule, rule));

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table task_automations, task_events, tasks, reminders, payment_receipts, customers, audit_log, notifications,
      app_module_access, app_access, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  priya = await makeUser("Priya", [["crm", "associate"]]);
  deepa = await makeUser("Deepa", [["accounts", "manager"]]);
  rohan = await makeUser("Rohan", [["accounts", "associate"]]);
  admin = await makeUser("Tara", [["tasks", "admin"]]);
  customerId = id("cus");
  await db.insert(customers).values({ id: customerId, name: "Shree Paints", phone: "9820099001", city: "Nagpur", kind: "customer", ownerId: priya.id, salesAmId: priya.id } as never);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("Automatic tasks", () => {
  test("a callback raises a task once, and completing the reminder closes it", async () => {
    const remId = id("rem");
    await db.insert(reminders).values({ id: remId, customerId, createdByUserId: priya.id, assignedUserId: priya.id, dueDate: await today(), note: "Ring after 11" });
    await syncAutomations("crm.callback");
    await syncAutomations("crm.callback");
    const raised = await auto("crm.callback");
    assert.equal(raised.length, 1, "once, however often it runs");
    assert.equal(raised[0].assigneeId, priya.id);
    assert.equal(raised[0].title, "Call back Shree Paints");
    assert.equal(raised[0].customerId, customerId);

    await db.update(reminders).set({ status: "completed", closedAt: new Date() }).where(eq(reminders.id, remId));
    await syncAutomations("crm.callback");
    const [closed] = await auto("crm.callback");
    assert.equal(closed.status, "done");
    assert.equal(closed.closedById, null, "the app closed it, not a person");
    assert.match(closed.closeRemark ?? "", /reminder was completed/);
  });

  test("a reported payment goes to every Accounts manager, not to a clerk", async () => {
    await db.insert(paymentReceipts).values({ id: id("rcp"), customerId, amount: 120000_00, receivedAt: await today(), status: "reported", idempotencyKey: id("idem") } as never);
    await syncAutomations("accounts.reported-payment");
    const raised = await auto("accounts.reported-payment");
    assert.deepEqual(raised.map((t) => t.assigneeId), [deepa.id]);
    assert.ok(!raised.some((t) => t.assigneeId === rohan.id));
  });

  test("only a Tasks administrator switches a rule, and switching it off closes what it raised", async () => {
    await db.insert(reminders).values({ id: id("rem"), customerId, createdByUserId: priya.id, assignedUserId: priya.id, dueDate: await today(), note: "x" });
    await syncAutomations("crm.callback");

    setTestUser(priya);
    assert.ok(!(await setAutomation("crm.callback", false)).ok, "a telecaller cannot switch it");

    setTestUser(admin);
    const off = await setAutomation("crm.callback", false);
    assert.ok(off.ok, off.ok ? "" : off.error);
    const [t] = await auto("crm.callback");
    assert.equal(t.status, "done");
    const all = await syncAutomations();
    assert.deepEqual(all.filter((x) => x.error).map((x) => `${x.rule}: ${x.error}`), [], "every rule's read runs");
    assert.equal((await db.select().from(tasks).where(and(eq(tasks.autoRule, "crm.callback"), eq(tasks.status, "todo")))).length, 0, "an off rule raises nothing");
  });
});
