/**
 * A TASK THAT ASKS FOR SOMETHING, from the Sales Dashboard to the handset and
 * back.
 *
 *   npm run test:integration
 *
 * Pins the whole loop: a manager assigns one task with a form to several
 * salesmen and several shops; each salesman's handset receives his tasks WITH
 * the form; he answers, and the answers are cleaned against the form the office
 * stored; and the results read lays every salesman's answers side by side. Also
 * that the save refuses a count that moved after it was reviewed, and that
 * withdrawing takes only what is still open.
 *
 * Needs mahekone_test, which `npm run test:db` creates from the migrations.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customerContacts, customers, mbosDevices, mbosTasks, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import {
  assignTaskCampaign,
  closeTaskCampaign,
  previewTaskAudience,
} from "@/lib/actions/sales";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { buildBootstrap, type MbosPrincipal } from "@/lib/services/mbos-service";
import { taskCampaign, taskCampaigns } from "@/lib/services/task-campaign-service";
import { settleLinkedTasks } from "@/lib/services/task-link-service";
import { addContact, listCustomerContacts } from "@/lib/services/customer-contact-service";
import type { SyncItem } from "@/lib/mbos/types";
import { addDays, today } from "@/lib/format";
import type { TaskField } from "@/lib/task-form";
import type { TaskAudience } from "@/lib/task-audience";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let rahul: typeof users.$inferSelect;
let seema: typeof users.$inferSelect;
let manager: typeof users.$inferSelect;
const shops: string[] = [];

const FORM: TaskField[] = [
  { id: "owner", type: "short_text", label: "Owner's name", required: true },
  { id: "birthday", type: "birthday", label: "Owner's birthday", required: true },
  { id: "stocks", type: "yes_no", label: "Stocks our thinner?", required: true },
  {
    id: "which",
    type: "multi_choice",
    label: "Which ones?",
    required: true,
    options: ["Nano", "PU"],
    showIf: { field: "stocks", op: "is", value: "yes" },
  },
  { id: "front", type: "photo", label: "Shop front", required: false, min: 0, max: 2 },
];

async function makeUser(name: string, role: "associate" | "manager") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  return row!;
}

function principalFor(u: typeof users.$inferSelect): MbosPrincipal {
  return {
    user: u,
    deviceId: `device-${u.id}`,
    role: "associate",
    scope: { kind: "own", userIds: [u.id] },
  } as MbosPrincipal;
}

function answer(taskId: string, payload: Record<string, unknown>): SyncItem {
  return {
    queueId: id("q"),
    entityId: taskId,
    entityType: "task",
    op: "update",
    idempotencyKey: `${taskId}:update:${randomUUID()}`,
    clientCreatedAt: Date.now(),
    payload: { id: taskId, status: "done", ...payload },
  };
}

const DUE = addDays(today(), 3);

const assign = (audience: TaskAudience, expectedCount: number) =>
  assignTaskCampaign({ title: "Birthday and stock check", dueDate: DUE, form: FORM, audience, expectedCount });

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      mbos_tasks, mbos_task_campaigns, customer_contacts, customers, mbos_devices, attachments,
      audit_log, notifications, app_access, sessions, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  rahul = await makeUser("Rahul", "associate");
  seema = await makeUser("Seema", "associate");
  manager = await makeUser("Vikram", "manager");
  await db.insert(appAccess).values([
    { id: id("aa"), userId: rahul.id, app: "field", role: "associate" },
    { id: id("aa"), userId: seema.id, app: "field", role: "associate" },
    { id: id("aa"), userId: manager.id, app: "sales", role: "manager" },
  ]);
  await db.insert(mbosDevices).values([
    { id: id("dev"), userId: rahul.id, deviceId: `device-${rahul.id}`, active: true },
    { id: id("dev"), userId: seema.id, deviceId: `device-${seema.id}`, active: true },
  ]);

  shops.length = 0;
  for (const [name, carrier] of [
    ["Sai Paints", rahul.id],
    ["Balaji Hardware", rahul.id],
    ["Krishna Colours", seema.id],
    ["Nobody's Shop", null],
  ] as const) {
    const [c] = await db
      .insert(customers)
      .values({
        id: id("cus"),
        name,
        phone: String(9822200000 + shops.length),
        contactPerson: "Owner",
        city: "Nagpur",
        region: "Maharashtra",
        kind: "customer",
        ownerId: carrier,
        salesAmId: carrier,
      })
      .returning();
    shops.push(c.id);
  }
  setTestUser(manager);
});

/* Without this the pool keeps the process alive and the runner waits for ever. */
after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("assigning a task with a form", () => {
  test("each shop's own salesman gets one task per shop, and a shop nobody carries is skipped", async () => {
    const audience: TaskAudience = { shops: { kind: "list", customerIds: shops }, assignees: { kind: "carrier" } };
    const preview = await previewTaskAudience(audience);
    assert.ok(preview.ok, JSON.stringify(preview));
    assert.equal(preview.data.tasks, 3);
    assert.equal(preview.data.noCarrier, 1);
    assert.deepEqual(
      preview.data.salesmen.map((s) => [s.name, s.count]),
      [["Rahul", 2], ["Seema", 1]],
    );

    const saved = await assign(audience, 3);
    assert.ok(saved.ok, JSON.stringify(saved));
    const rows = await db.select().from(mbosTasks).where(eq(mbosTasks.campaignId, saved.data.campaignId));
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.status === "open" && r.dueDate === DUE));
  });

  test("several chosen salesmen each get the task for every shop", async () => {
    const audience: TaskAudience = {
      shops: { kind: "list", customerIds: shops.slice(0, 2) },
      assignees: { kind: "chosen", salesmanIds: [rahul.id, seema.id] },
    };
    const saved = await assign(audience, 4);
    assert.ok(saved.ok, JSON.stringify(saved));
    const rows = await db.select().from(mbosTasks).where(eq(mbosTasks.campaignId, saved.data.campaignId));
    assert.equal(rows.length, 4);
    assert.equal(new Set(rows.map((r) => `${r.assignedToUserId}|${r.customerId}`)).size, 4);
  });

  test("a task about no shop goes once to each chosen salesman", async () => {
    const saved = await assign({ shops: { kind: "none" }, assignees: { kind: "chosen", salesmanIds: [rahul.id, seema.id] } }, 2);
    assert.ok(saved.ok, JSON.stringify(saved));
    const rows = await db.select().from(mbosTasks).where(eq(mbosTasks.campaignId, saved.data.campaignId));
    assert.deepEqual(rows.map((r) => r.customerId), [null, null]);
  });

  test("a count that moved since it was reviewed is refused, and nothing is written", async () => {
    const saved = await assign({ shops: { kind: "list", customerIds: shops }, assignees: { kind: "carrier" } }, 99);
    assert.equal(saved.ok, false);
    assert.equal((await db.select().from(mbosTasks)).length, 0);
  });

  test("a form no salesman could answer is refused", async () => {
    const saved = await assignTaskCampaign({
      title: "Broken",
      dueDate: DUE,
      form: [{ id: "a", type: "single_choice", label: "Pick", options: ["only"] }],
      audience: { shops: { kind: "none" }, assignees: { kind: "chosen", salesmanIds: [rahul.id] } },
      expectedCount: 1,
    });
    assert.equal(saved.ok, false);
  });
});

describe("answering on the handset and reading it back", () => {
  test("the form reaches the phone, the answers come back cleaned, and every salesman's answers are read side by side", async () => {
    const saved = await assign({ shops: { kind: "list", customerIds: shops.slice(0, 3) }, assignees: { kind: "carrier" } }, 3);
    assert.ok(saved.ok, JSON.stringify(saved));
    const campaignId = saved.data.campaignId;

    /* The handset's bootstrap carries the form on each of his tasks. */
    const boot = await buildBootstrap(principalFor(rahul));
    const mine = (boot.tasks as Array<{ id: string; campaignId: string; form: TaskField[] }>).filter(
      (t) => t.campaignId === campaignId,
    );
    assert.equal(mine.length, 2);
    assert.deepEqual(mine[0].form.map((f) => f.id), FORM.map((f) => f.id));

    /* He answers one — with a stray answer to a hidden question, which the
       office drops, and no note, which the answers stand in for. */
    const [first] = mine;
    const out = await ingestSyncBatch(principalFor(rahul), [
      answer(first.id, {
        responses: {
          owner: "  Ramesh Agarwal ",
          birthday: { day: 14, month: 8 },
          stocks: false,
          which: ["Nano"],
          unknown: "x",
        },
      }),
    ]);
    assert.equal(out[0].status, "accepted", JSON.stringify(out[0]));

    const [row] = await db.select().from(mbosTasks).where(eq(mbosTasks.id, first.id));
    assert.equal(row.status, "done");
    assert.deepEqual(row.responses, {
      owner: "Ramesh Agarwal",
      birthday: { day: 14, month: 8 },
      stocks: false,
    });
    assert.ok(row.respondedAt);
    assert.match(row.completionNote ?? "", /Owner's birthday: 14 Aug/);

    /* Seema's tasks are hers: the results read shows both salesmen. */
    const detail = await taskCampaign(campaignId, today());
    assert.ok(detail);
    assert.equal(detail.tasks.length, 3);
    assert.deepEqual([...new Set(detail.tasks.map((t) => t.salesmanName))].sort(), ["Rahul", "Seema"]);
    const answered = detail.tasks.find((t) => t.id === first.id)!;
    assert.equal(answered.responses?.owner, "Ramesh Agarwal");

    const list = await taskCampaigns(today());
    assert.equal(list.length, 1);
    assert.equal(list[0].done, 1);
    assert.equal(list[0].open, 2);
    assert.equal(list[0].salesmen, 2);

    /* Withdrawing takes what is open and leaves the answer standing. */
    const closed = await closeTaskCampaign(campaignId);
    assert.ok(closed.ok);
    assert.equal(closed.data.cancelled, 2);
    const [still] = await db.select().from(mbosTasks).where(eq(mbosTasks.id, first.id));
    assert.equal(still.status, "done");
  });

  test("a plain task still needs its note", async () => {
    const [t] = await db
      .insert(mbosTasks)
      .values({ id: id("mbos_task"), title: "Take the rate list", assignedToUserId: rahul.id, dueDate: DUE })
      .returning();
    const out = await ingestSyncBatch(principalFor(rahul), [answer(t.id, { responses: { owner: "x" } })]);
    assert.equal(out[0].status, "rejected");
  });
});

describe("questions linked to the customer record", () => {
  const BIRTHDAY: TaskField[] = [
    {
      id: "bday",
      type: "birthday",
      label: "Owner's birthday",
      required: true,
      link: { target: "contact.birthday", mode: "fill", scope: "primary" },
    },
  ];

  test("a shop that already has the birthday is never sent the task", async () => {
    await addContact(shops[0], { name: "Ramesh", phone: "9876500001", birthDay: 14, birthMonth: 8, designations: ["primary"] }, manager.id);
    await addContact(shops[1], { name: "Sunil", phone: "9876500002", designations: ["primary"] }, manager.id);
    const audience: TaskAudience = { shops: { kind: "list", customerIds: shops.slice(0, 2) }, assignees: { kind: "carrier" } };
    const preview = await previewTaskAudience(audience, BIRTHDAY);
    assert.ok(preview.ok, JSON.stringify(preview));
    assert.equal(preview.data.alreadyComplete, 1);
    assert.equal(preview.data.tasks, 1);
  });

  test("the answer is written to the contact, and the same ask on the same shop completes itself", async () => {
    await addContact(shops[1], { name: "Sunil", phone: "9876500002", designations: ["primary"] }, manager.id);
    /* Two salesmen asked about the same shop. */
    const saved = await assignTaskCampaign({
      title: "Collect birthdays",
      dueDate: DUE,
      form: BIRTHDAY,
      audience: { shops: { kind: "list", customerIds: [shops[1]] }, assignees: { kind: "chosen", salesmanIds: [rahul.id, seema.id] } },
      expectedCount: 2,
    });
    assert.ok(saved.ok, JSON.stringify(saved));
    const tasks = await db.select().from(mbosTasks).where(eq(mbosTasks.campaignId, saved.data.campaignId));
    const mine = tasks.find((t) => t.assignedToUserId === rahul.id)!;
    const hers = tasks.find((t) => t.assignedToUserId === seema.id)!;

    /* His phone is told what the record holds — nothing yet. */
    const boot = await buildBootstrap(principalFor(rahul));
    const onPhone = (boot.tasks as Array<{ id: string; context: { contacts: { name: string }[] } | null }>).find((t) => t.id === mine.id)!;
    assert.equal(onPhone.context?.contacts[0].name, "Sunil");

    const out = await ingestSyncBatch(principalFor(rahul), [answer(mine.id, { responses: { bday: { day: 2, month: 3 } } })]);
    assert.equal(out[0].status, "accepted", JSON.stringify(out[0]));

    const contact = (await listCustomerContacts(shops[1])).find((x) => x.isPrimary)!;
    assert.equal(contact.name, "Sunil");
    assert.equal(contact.birthDay, 2);
    assert.equal(contact.birthMonth, 3);

    const [after] = await db.select().from(mbosTasks).where(eq(mbosTasks.id, mine.id));
    assert.equal(after.completedVia, "answer");
    assert.deepEqual(after.linkResults, { bday: "saved" });

    const [other] = await db.select().from(mbosTasks).where(eq(mbosTasks.id, hers.id));
    assert.equal(other.status, "done");
    assert.equal(other.completedVia, "record");
  });

  test("a birthday typed in the CRM completes the field task asking for it", async () => {
    const [c] = await db
      .insert(customerContacts)
      .values({ id: "cct_test1", customerId: shops[2], name: "Mohan", role: "owner", phone: "9876500003", isPrimary: true })
      .returning();
    const saved = await assignTaskCampaign({
      title: "Collect birthdays",
      dueDate: DUE,
      form: BIRTHDAY,
      audience: { shops: { kind: "list", customerIds: [shops[2]] }, assignees: { kind: "carrier" } },
      expectedCount: 1,
    });
    assert.ok(saved.ok, JSON.stringify(saved));
    await db.update(customerContacts).set({ birthDay: 9, birthMonth: 11 }).where(eq(customerContacts.id, c.id));
    const { completed } = await settleLinkedTasks([shops[2]]);
    assert.equal(completed, 1);
    const [t] = await db.select().from(mbosTasks).where(eq(mbosTasks.campaignId, saved.data.campaignId));
    assert.equal(t.status, "done");
    assert.equal(t.completedVia, "record");
    assert.deepEqual(t.responses, { bday: { day: 9, month: 11 } });
  });
});
