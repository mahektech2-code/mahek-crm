/**
 * THE SALES MANAGER DESK'S TWO WIDENED QUEUES.
 *
 *   sample   — requested, approved and dispatched are on the desk as well as a
 *              received parcel nobody has reviewed; reviewed, rejected and
 *              cancelled are not.
 *   nurture  — an open nurture task due today or already late puts the lead on
 *              the desk; one weeks ahead, or done, does not.
 */
import { after, before, beforeEach, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, customers, mbosSamples, mbosTasks, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { CRM_SALES_MANAGER_WORKSPACE } from "@/proxy";
import { setTestWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { pipelineDesk } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";

const DAY = "2026-09-24";
const id = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

let sm: typeof users.$inferSelect;
let salesman: typeof users.$inferSelect;

async function lead(name: string) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name,
      contactPerson: "Ganesh",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nashik",
      kind: "lead",
      leadStage: "sample_trial",
      leadSalesType: "direct",
      leadSource: "manual",
      leadStageSince: "2026-09-20",
      leadLastActivityDate: "2026-09-20",
      ownerId: salesman.id,
      salesManagerId: sm.id,
    })
    .returning();
  return row;
}

async function sample(customerId: string, state: typeof mbosSamples.$inferInsert["state"]) {
  await db.insert(mbosSamples).values({
    id: id("smp"),
    customerId,
    salesmanId: salesman.id,
    quantityCans: 1,
    requestedDate: "2026-09-20",
    state,
  });
}

async function task(customerId: string, dueDate: string, status: "open" | "done" = "open") {
  await db.insert(mbosTasks).values({
    id: id("tsk"),
    title: "Nurture",
    assignedToUserId: sm.id,
    customerId,
    dueDate,
    status,
    sourceType: "lead_nurture",
    sourceId: id("src"),
  } as typeof mbosTasks.$inferInsert);
}

const queuesOf = async (leadId: string) =>
  (await pipelineDesk(DAY)).rows.find((r) => r.id === leadId)?.queues ?? [];

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table mbos_tasks, mbos_samples, sample_feedback, lead_stage_transitions, notifications,
      timeline_events, audit_log, app_module_access, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  const mk = async (name: string, app: "crm" | "field") => {
    const [u] = await db
      .insert(users)
      .values({
        id: id("usr"),
        name,
        email: `${randomUUID().slice(0, 6)}@test.local`,
        phone: String(9820000000 + Math.floor(Math.random() * 999999)),
        passwordHash: "x",
        role: "associate",
        initials: "XX",
      })
      .returning();
    await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app, role: "associate" });
    return u;
  };
  sm = await mk("Manager Aye", "crm");
  await db.insert(appModuleAccess).values({ id: id("ama"), userId: sm.id, app: "crm", module: "crm.sales-manager" });
  salesman = await mk("Salesman One", "field");
  setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE);
  setTestUser(sm);
});

afterEach(() => setTestWorkspace(null));

after(async () => {
  setTestUser(null);
  setTestWorkspace(null);
  await db.$client.end();
});

describe("sample queue", () => {
  for (const state of ["requested", "approved", "dispatched", "received", "trial_done"] as const) {
    test(`${state} is on the desk`, async () => {
      const l = await lead(`L ${state}`);
      await sample(l.id, state);
      assert.ok((await queuesOf(l.id)).includes("sample"));
    });
  }
  for (const state of ["reviewed", "rejected", "cancelled"] as const) {
    test(`${state} is not`, async () => {
      const l = await lead(`L ${state}`);
      await sample(l.id, state);
      assert.ok(!(await queuesOf(l.id)).includes("sample"));
    });
  }
});

describe("nurture queue", () => {
  test("due today and overdue are on the desk", async () => {
    const a = await lead("Today");
    const b = await lead("Late");
    await task(a.id, DAY);
    await task(b.id, "2026-09-20");
    assert.ok((await queuesOf(a.id)).includes("nurture"));
    assert.ok((await queuesOf(b.id)).includes("nurture"));
  });
  test("a future task, and a done one, are not", async () => {
    const a = await lead("Future");
    const b = await lead("Done");
    await task(a.id, "2026-10-20");
    await task(b.id, "2026-09-20", "done");
    assert.ok(!(await queuesOf(a.id)).includes("nurture"));
    assert.ok(!(await queuesOf(b.id)).includes("nurture"));
  });
});
