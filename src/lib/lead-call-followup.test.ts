/**
 * A lead's follow-up is a reminder, and its call history is the calls already
 * recorded. Focused: creation, no invented reminders, deduplication,
 * rescheduling, completed rows left alone, ownership, history.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, reminders, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { logQualificationCall } from "@/lib/actions/lead-calling-desk";
import {
  leadCallHistory,
  leadUpcomingFollowUps,
  moveLeadFollowUpsTo,
} from "@/lib/services/lead-followup-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const D1 = "2026-12-01";
const D2 = "2026-12-09";

let desk: typeof users.$inferSelect;
let other: typeof users.$inferSelect;

async function makeUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "associate",
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role: "associate" });
  return row;
}

async function makeLead() {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ganesh",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nashik",
      kind: "lead",
      leadStage: "suspect",
      leadSalesType: "direct",
      leadSource: "Website / Online Enquiry",
      ownerId: desk.id,
    })
    .returning();
  return row;
}

const callBack = (customerId: string, date?: string) =>
  logQualificationCall({
    customerId,
    outcome: "spoke_callback",
    answers: {},
    notes: "Asked to ring again.",
    ...(date ? { next: { kind: "call" as const, text: "re-check", date } } : {}),
  });

const rowsFor = (customerId: string) => db.select().from(reminders).where(eq(reminders.customerId, customerId));

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against mahekone_test (`npm run test:db`).");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table reminders, calls, notifications, timeline_events, audit_log, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  desk = await makeUser("Desk Caller");
  other = await makeUser("Other Caller");
  setTestUser(desk);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("lead follow-up reminders", () => {
  test("a call saved with a chosen date makes one pending reminder, owned by the lead's owner", async () => {
    const lead = await makeLead();
    const r = await callBack(lead.id, D2);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const rows = await rowsFor(lead.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].dueDate, D2);
    assert.equal(rows[0].assignedUserId, lead.ownerId);
    assert.equal(rows[0].systemGenerated, true);
    const shown = await leadUpcomingFollowUps(lead.id);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].dueDate, D2);
  });

  test("no chosen date means no reminder is invented", async () => {
    const lead = await makeLead();
    const r = await callBack(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await rowsFor(lead.id)).length, 0);
  });

  test("a later call reschedules the same open reminder instead of adding another", async () => {
    const lead = await makeLead();
    await callBack(lead.id, D1);
    await callBack(lead.id, D2);
    const rows = await rowsFor(lead.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dueDate, D2);
    assert.equal(rows[0].rescheduleCount, 1);
    assert.equal(rows[0].status, "pending");
  });

  test("a completed reminder is never reopened; the next follow-up is a new row", async () => {
    const lead = await makeLead();
    await callBack(lead.id, D1);
    const [first] = await rowsFor(lead.id);
    await db.update(reminders).set({ status: "completed", closedAt: new Date() }).where(eq(reminders.id, first.id));
    await callBack(lead.id, D2);
    const rows = await rowsFor(lead.id);
    assert.equal(rows.length, 2);
    const done = rows.find((r) => r.id === first.id)!;
    assert.equal(done.status, "completed");
    assert.equal(done.dueDate, D1);
    assert.equal(rows.filter((r) => r.status === "pending").length, 1);
  });

  test("changing the lead's owner moves the pending reminder and leaves completed ones", async () => {
    const lead = await makeLead();
    await callBack(lead.id, D1);
    const [first] = await rowsFor(lead.id);
    await db.update(reminders).set({ status: "completed", closedAt: new Date() }).where(eq(reminders.id, first.id));
    await callBack(lead.id, D2);
    await db.transaction((tx) => moveLeadFollowUpsTo(tx, lead.id, other.id, desk.id));
    const rows = await rowsFor(lead.id);
    assert.equal(rows.find((r) => r.status === "pending")!.assignedUserId, other.id);
    assert.equal(rows.find((r) => r.status === "completed")!.assignedUserId, desk.id);
  });

  test("call history lists every recorded call with notes and the next follow-up date", async () => {
    const lead = await makeLead();
    await callBack(lead.id, D1);
    await callBack(lead.id, D2);
    const history = await leadCallHistory(lead.id);
    assert.equal(history.length, 2);
    assert.equal(history[0].callNumber, 2);
    assert.equal(history[0].nextDate, D2);
    assert.equal(history[0].notes, "Asked to ring again.");
    assert.equal(history[1].callNumber, 1);
    assert.equal(history[1].byName, "Desk Caller");
  });
});
