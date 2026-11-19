/**
 * CORRECTING WHAT WAS WRITTEN DOWN in the CRM: a payment promise edited or
 * cancelled, a complaint corrected or withdrawn, a reminder's note and kind,
 * an opportunity's figures.
 *
 * Each act is driven the way its screen drives it — the destructive two
 * through their impact report, refused without the confirmation — and each is
 * asked of somebody who may not do it as well as somebody who may.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  auditLog,
  callOpportunities,
  complaints,
  customers,
  followUpAttempts,
  reminders,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { addDays, today as businessToday } from "@/lib/format";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { impactReport } from "@/lib/impact/registry";
import {
  cancelPromiseAction,
  editComplaintAction,
  editOpportunityAction,
  editPromiseAction,
  editReminderAction,
  withdrawComplaintAction,
} from "@/lib/actions/crm";
import { getFollowUpWorklist } from "@/lib/services/payment-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = businessToday();

let manager: typeof users.$inferSelect;
let caller: typeof users.$inferSelect;
let shop: string;

async function confirm(kind: string, key: string) {
  const report = await impactReport(kind, key);
  assert.ok(report.ok, report.ok ? "" : report.error);
  return { report: report.data, confirmation: { typed: report.data.confirmWord, fingerprint: report.data.fingerprint } };
}

async function promise(by: string, amount = 50_000_00, date = addDays(TODAY, 5)) {
  const attempt = id("fua");
  const reminder = id("rem");
  await db.insert(reminders).values({
    id: reminder,
    customerId: shop,
    createdByUserId: by,
    assignedUserId: by,
    dueDate: addDays(date, 1),
    note: `Check ₹${amount / 100} promised for ${date}`,
    type: "payment_promise",
    systemGenerated: true,
  });
  await db.insert(followUpAttempts).values({
    id: attempt,
    customerId: shop,
    stage: 2,
    channel: "call",
    attemptedAt: new Date(),
    userId: by,
    outcome: "Promised on the phone",
    promisedAmount: amount,
    promisedDate: date,
    reminderId: reminder,
  });
  return { attempt, reminder };
}

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against mahekone_test.");
  await db.execute(sql`
    truncate table audit_log, app_access, sessions, notifications, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  [manager, caller] = await db
    .insert(users)
    .values([
      { id: id("usr"), name: "Meera Manager", email: `m-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role: "admin", initials: "MM" },
      { id: id("usr"), name: "Tara Telecaller", email: `t-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role: "associate", initials: "TT" },
    ])
    .returning();
  await db.insert(appAccess).values([
    { id: id("aca"), userId: manager.id, app: "crm", role: "admin" as const },
    { id: id("aca"), userId: caller.id, app: "crm", role: "associate" as const },
  ]);
  shop = id("cus");
  await db.insert(customers).values({
    id: shop,
    name: "Colour Camp",
    kind: "customer",
    ownerId: caller.id,
    contactPerson: "A",
    phone: "9820011111",
    city: "Pune",
  });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ------------------------------------------------------------ promises */

test("a promise edited moves its chase reminder, and the edit is audited", async () => {
  setTestUser(caller);
  const { attempt, reminder } = await promise(caller.id);
  const newDate = addDays(TODAY, 9);
  const r = await editPromiseAction({ attemptId: attempt, amount: "42,500.50", promisedBy: newDate, note: "Owner will send RTGS" });
  assert.ok(r.ok, r.ok ? "" : r.error);

  const [a] = await db.select().from(followUpAttempts).where(eq(followUpAttempts.id, attempt));
  assert.equal(Number(a.promisedAmount), 42_500_50, "paise kept, never rounded to rupees");
  assert.equal(a.promisedDate, newDate);
  assert.equal(a.outcome, "Owner will send RTGS");
  const [rem] = await db.select().from(reminders).where(eq(reminders.id, reminder));
  assert.ok(rem.dueDate > newDate, "chased after the new date, not the old one");
  assert.match(rem.note, new RegExp(`promised for ${newDate}`));
  assert.equal(rem.rescheduleCount, 0, "correcting a promise is not a reschedule");
  const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, "followup.promise_edit"), eq(auditLog.entityId, shop)));
  assert.equal(audits.length, 1);
});

test("a promise is not dated before the day it was made, nor edited to nothing", async () => {
  setTestUser(caller);
  const { attempt } = await promise(caller.id);
  assert.equal((await editPromiseAction({ attemptId: attempt, amount: "100", promisedBy: addDays(TODAY, -3) })).ok, false);
  assert.equal((await editPromiseAction({ attemptId: attempt, amount: "0", promisedBy: TODAY })).ok, false);
});

test("cancelling a promise: refused to a telecaller, refused unconfirmed, then dismisses its chase", async () => {
  const { attempt, reminder } = await promise(caller.id, 20_000_00);

  setTestUser(caller);
  const refused = await cancelPromiseAction(attempt, "Wrong customer");
  assert.equal(refused.ok, false, "a telecaller may not clear a chase off the list");

  setTestUser(manager);
  const { report, confirmation } = await confirm("crm-payment-promise-cancel", attempt);
  assert.equal(report.confirmWord, "Colour Camp");
  assert.ok(report.items.some((i) => /chase reminder/.test(i.label)), "the chase reminder is named");
  assert.equal((await cancelPromiseAction(attempt, "Wrong customer")).ok, false, "no confirmation, no cancel");
  assert.equal((await cancelPromiseAction(attempt, "  ", confirmation)).ok, false, "a reason is required");

  const done = await cancelPromiseAction(attempt, "Wrong customer", confirmation);
  assert.ok(done.ok, done.ok ? "" : done.error);
  const [a] = await db.select().from(followUpAttempts).where(eq(followUpAttempts.id, attempt));
  assert.ok(a.promiseCancelledAt, "marked cancelled");
  assert.equal(a.promiseCancelReason, "Wrong customer");
  assert.equal(Number(a.promisedAmount), 20_000_00, "the attempt keeps what was said");
  const [rem] = await db.select().from(reminders).where(eq(reminders.id, reminder));
  assert.equal(rem.status, "dismissed");

  const again = await impactReport("crm-payment-promise-cancel", attempt);
  assert.ok(again.ok && again.data.blockers.length > 0, "a cancelled promise cannot be cancelled twice");
  assert.equal((await editPromiseAction({ attemptId: attempt, amount: "5", promisedBy: TODAY })).ok, false, "nor edited");
});

test("the worklist never offers a cancelled promise as the live one", async () => {
  setTestUser(manager);
  const rows = await getFollowUpWorklist();
  for (const r of rows) {
    if (!r.promiseAttemptId) continue;
    const [a] = await db.select().from(followUpAttempts).where(eq(followUpAttempts.id, r.promiseAttemptId));
    assert.equal(a.promiseCancelledAt, null);
  }
});

/* ---------------------------------------------------------- complaints */

async function complaint(over: Partial<typeof complaints.$inferInsert> = {}) {
  const key = id("cmp");
  await db.insert(complaints).values({
    id: key,
    customerId: shop,
    loggedByUserId: caller.id,
    category: "dispatch_delay",
    description: "Delivery came a week late",
    slaDueAt: new Date(Date.now() + 86_400_000),
    ...over,
  });
  return key;
}

test("a complaint corrected by whoever logged it, and refused to anybody else", async () => {
  const key = await complaint();
  const other = (await db
    .insert(users)
    .values({ id: id("usr"), name: "Other Caller", email: `o-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role: "associate", initials: "OC" })
    .returning())[0];
  await db.insert(appAccess).values({ id: id("aca"), userId: other.id, app: "crm", role: "associate" as const });
  setTestUser(other);
  const refused = await editComplaintAction({ complaintId: key, description: "x", category: "Packaging" });
  assert.equal(refused.ok, false);

  setTestUser(caller);
  const r = await editComplaintAction({ complaintId: key, description: "Two cans leaking on arrival", category: "Packaging" });
  assert.ok(r.ok, r.ok ? "" : r.error);
  const [c] = await db.select().from(complaints).where(eq(complaints.id, key));
  assert.equal(c.description, "Two cans leaking on arrival");
  assert.equal(c.category, "packaging_damage", "the label is mapped to its stored value");
  const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, "complaint.edit"), eq(auditLog.entityId, key)));
  assert.equal(audits.length, 1);
});

test("withdrawing a complaint closes it and refuses its waiting credit note", async () => {
  const key = await complaint({ requestCn: true, cnStatus: "requested" });

  setTestUser(caller);
  assert.equal((await withdrawComplaintAction(key, "Raised twice")).ok, false, "a telecaller may not finish a complaint");

  setTestUser(manager);
  const { report, confirmation } = await confirm("crm-complaint-withdraw", key);
  assert.ok(report.items.some((i) => /credit-note/.test(i.label)), "the credit note request is named");
  assert.equal((await withdrawComplaintAction(key, "Raised twice")).ok, false, "no confirmation, no withdrawal");
  const done = await withdrawComplaintAction(key, "Raised twice", confirmation);
  assert.ok(done.ok, done.ok ? "" : done.error);
  const [c] = await db.select().from(complaints).where(eq(complaints.id, key));
  assert.equal(c.status, "closed");
  assert.equal(c.cnStatus, "rejected");
  assert.match(c.resolutionNotes ?? "", /Withdrawn: Raised twice/);
  assert.equal((await editComplaintAction({ complaintId: key, description: "y", category: "Packaging" })).ok, false, "a finished complaint is not edited");
});

test("a complaint whose credit note accounts issued cannot be withdrawn", async () => {
  const key = await complaint({ requestCn: true, cnStatus: "issued" });
  setTestUser(manager);
  const report = await impactReport("crm-complaint-withdraw", key);
  assert.ok(report.ok && report.data.blockers.length > 0, "the modal says why");
  const r = await withdrawComplaintAction(key, "Mistake", { typed: "Colour Camp", fingerprint: report.ok ? report.data.fingerprint : "" });
  assert.equal(r.ok, false);
});

/* ----------------------------------------------------------- reminders */

test("a reminder's note and kind are corrected without counting a reschedule", async () => {
  const key = id("rem");
  await db.insert(reminders).values({ id: key, customerId: shop, createdByUserId: caller.id, assignedUserId: caller.id, dueDate: TODAY, note: "Ring abuot stock" });
  setTestUser(caller);
  const r = await editReminderAction({ reminderId: key, note: "Ring about stock", type: "check_stock" });
  assert.ok(r.ok, r.ok ? "" : r.error);
  const [rem] = await db.select().from(reminders).where(eq(reminders.id, key));
  assert.equal(rem.note, "Ring about stock");
  assert.equal(rem.type, "check_stock");
  assert.equal(rem.rescheduleCount, 0);
  assert.equal((await editReminderAction({ reminderId: key, note: "" })).ok, false, "a note is required");
});

test("a system chase keeps its kind, and a reminder outside your book is refused", async () => {
  const { reminder } = await promise(caller.id);
  setTestUser(caller);
  assert.equal((await editReminderAction({ reminderId: reminder, note: "x", type: "call_back" })).ok, false);

  const elsewhere = id("cus");
  await db.insert(customers).values({ id: elsewhere, name: "Not Mine", kind: "customer", ownerId: manager.id, contactPerson: "B", phone: "9820099999", city: "Pune" });
  const theirs = id("rem");
  await db.insert(reminders).values({ id: theirs, customerId: elsewhere, createdByUserId: manager.id, assignedUserId: manager.id, dueDate: TODAY, note: "Theirs" });
  const r = await editReminderAction({ reminderId: theirs, note: "Mine now" });
  assert.equal(r.ok, false);
});

/* ------------------------------------------------------- opportunities */

test("an opportunity's value and date are corrected while it is worked, and not once closed", async () => {
  const key = id("opp");
  await db.insert(callOpportunities).values({
    id: key,
    customerId: shop,
    callId: id("ixn"),
    userId: caller.id,
    product: "Primer 20L",
    estimatedValuePaise: 10_000_00,
  });
  setTestUser(caller);
  const r = await editOpportunityAction({ id: key, value: "15,000", expectedOrderDate: addDays(TODAY, 14) });
  assert.ok(r.ok, r.ok ? "" : r.error);
  let [o] = await db.select().from(callOpportunities).where(eq(callOpportunities.id, key));
  assert.equal(Number(o.estimatedValuePaise), 15_000_00);
  assert.equal(o.expectedOrderDate, addDays(TODAY, 14));

  const cleared = await editOpportunityAction({ id: key, value: "", expectedOrderDate: "" });
  assert.ok(cleared.ok);
  [o] = await db.select().from(callOpportunities).where(eq(callOpportunities.id, key));
  assert.equal(o.estimatedValuePaise, null, "an estimate may be taken away");

  await db.update(callOpportunities).set({ status: "won" }).where(eq(callOpportunities.id, key));
  assert.equal((await editOpportunityAction({ id: key, value: "1", expectedOrderDate: "" })).ok, false);
});
