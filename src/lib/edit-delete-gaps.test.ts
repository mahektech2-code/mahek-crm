/**
 * The edit/delete gaps a page-by-page sweep found, closed from the page the
 * record is listed on:
 *
 *   - a sample request edited before dispatch (requester or lead manager);
 *   - a close/reopen request withdrawn by whoever raised it;
 *   - an expense the office entered, edited or deleted by whoever entered it
 *     while it is undecided;
 *   - the reads the CRM's bills and payments screens use to offer Edit
 *     payment on a reported payment, and the ERP order number a bill links to.
 *
 * Runs against a mahekone_test database with the real actions.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  auditLog,
  bills,
  customers,
  mbosApprovals,
  mbosDeletions,
  mbosExpenses,
  mbosSamples,
  orders,
  paymentReceipts,
  payments,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { addDays, today as businessToday } from "@/lib/format";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { editSampleRequest } from "@/lib/actions/lead-samples";
import { withdrawStatusRequest } from "@/lib/actions/crm";
import { addExpenseFor, deleteEnteredExpense, editEnteredExpense } from "@/lib/actions/sales";
import { erpOrderNosFor, getFollowUpWorklist, undecidedReceiptsForBills } from "@/lib/services/payment-service";
import { sampleEditableBy } from "@/lib/services/sample-service";
import { recomputeFollowUpState } from "@/lib/recompute";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = businessToday();

let manager: typeof users.$inferSelect;
let manager2: typeof users.$inferSelect;
let salesA: typeof users.$inferSelect;
let salesB: typeof users.$inferSelect;
let productA: string;
let productB: string;

async function makeUser(
  name: string,
  role: "associate" | "manager" | "admin",
  apps: { app: "sales" | "crm" | "field"; role: "associate" | "manager" | "admin" }[],
  reportsToId: string | null = null,
) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
      reportsToId,
    })
    .returning();
  for (const a of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: a.app, role: a.role });
  return row;
}

async function makeShop(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Shop ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ganesh",
      phone: testPhone(),
      city: "Nashik",
      kind: "lead",
      leadStage: "qualification",
      leadSalesType: "direct",
      leadSource: "manual",
      ownerId: salesA.id,
      leadManagerId: manager.id,
      ...over,
    })
    .returning();
  return row;
}

async function makeSample(customerId: string, state: "requested" | "approved" | "dispatched", by = salesA.id) {
  const sampleId = id("smp");
  await db.insert(mbosSamples).values({
    id: sampleId,
    customerId,
    salesmanId: by,
    productId: productA,
    quantityCans: 2,
    application: "Wood polish",
    plannedSendDate: addDays(TODAY, 3),
    sendingMode: "courier",
    requestedDate: TODAY,
    state,
    createdById: by,
    updatedById: by,
  });
  await db.insert(mbosApprovals).values({
    id: id("apr"),
    type: "sample",
    requestedByUserId: by,
    subjectType: "mbos_samples",
    subjectId: sampleId,
    reason: "PU Thinner, to go by Courier",
    requestedAt: new Date(),
    stepIndex: 0,
    routeReason: "normal",
    state: state === "requested" ? "pending" : "approved",
  });
  return sampleId;
}

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against a mahekone_test database.");
  await db.execute(sql`
    truncate table mbos_samples, mbos_approvals, mbos_expenses, mbos_deletions, payments, payment_receipts,
      bills, orders, notifications, timeline_events, audit_log, app_module_access, app_access,
      customers, products, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  manager = await makeUser("Sales Manager", "manager", [
    { app: "sales", role: "manager" },
    { app: "crm", role: "manager" },
  ]);
  manager2 = await makeUser("Other Manager", "manager", [
    { app: "sales", role: "manager" },
    { app: "crm", role: "manager" },
  ]);
  salesA = await makeUser("Salesman A", "associate", [{ app: "field", role: "associate" }], manager.id);
  salesB = await makeUser("Salesman B", "associate", [{ app: "field", role: "associate" }], manager.id);
  productA = id("prd");
  productB = id("prd");
  await db.insert(products).values([
    { id: productA, name: "PU Thinner - 20 Liter" },
    { id: productB, name: "NC Thinner - 20 Liter" },
  ]);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ------------------------------------------------------------------ samples */

test("the requester edits a sample request before approval: product, cans, note — audited, approval reworded", async () => {
  const shop = await makeShop();
  const s = await makeSample(shop.id, "requested");
  assert.equal(await sampleEditableBy(s, salesA.id), true);
  assert.equal(await sampleEditableBy(s, salesB.id), false);
  setTestUser(salesA);
  const r = await editSampleRequest(s, {
    productId: productB,
    quantityCans: 5,
    application: "Furniture lacquer",
    sendingDate: addDays(TODAY, 4),
    sendingMode: "hand_delivery",
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  const [row] = await db.select().from(mbosSamples).where(eq(mbosSamples.id, s));
  assert.equal(row.productId, productB);
  assert.equal(row.quantityCans, 5);
  assert.equal(row.application, "Furniture lacquer");
  assert.equal(row.sendingMode, "hand_delivery");
  const [apr] = await db.select().from(mbosApprovals).where(eq(mbosApprovals.subjectId, s));
  assert.match(apr.reason ?? "", /NC Thinner/);
  const audits = await db.select().from(auditLog).where(and(eq(auditLog.entityId, s), eq(auditLog.action, "sample.edited")));
  assert.equal(audits.length, 1);
});

test("the lead manager may edit too; somebody else may not", async () => {
  const shop = await makeShop();
  const s = await makeSample(shop.id, "requested");
  setTestUser(manager);
  const ok = await editSampleRequest(s, { productId: productA, quantityCans: 3, application: null, sendingDate: addDays(TODAY, 2), sendingMode: "courier" });
  assert.ok(ok.ok, ok.ok ? "" : ok.error);
  setTestUser(salesB);
  const refused = await editSampleRequest(s, { productId: productA, quantityCans: 9, application: null, sendingDate: addDays(TODAY, 2), sendingMode: "courier" });
  assert.equal(refused.ok, false);
  const [row] = await db.select().from(mbosSamples).where(eq(mbosSamples.id, s));
  assert.equal(row.quantityCans, 3, "the refused edit wrote nothing");
});

test("an approved sample keeps its product and cans; a dispatched one cannot be edited at all", async () => {
  const shop = await makeShop();
  const approved = await makeSample(shop.id, "approved");
  setTestUser(salesA);
  const swap = await editSampleRequest(approved, { productId: productB, quantityCans: 2, application: "Wood polish", sendingDate: addDays(TODAY, 3), sendingMode: "courier" });
  assert.equal(swap.ok, false);
  const note = await editSampleRequest(approved, { productId: productA, quantityCans: 2, application: "Doors", sendingDate: addDays(TODAY, 5), sendingMode: "courier" });
  assert.ok(note.ok, note.ok ? "" : note.error);

  const sent = await makeSample(shop.id, "dispatched");
  assert.equal(await sampleEditableBy(sent, salesA.id), false);
  const late = await editSampleRequest(sent, { productId: productA, quantityCans: 2, application: "x", sendingDate: addDays(TODAY, 3), sendingMode: "courier" });
  assert.equal(late.ok, false);
});

/* ---------------------------------------------------------- status requests */

test("whoever raised a close request withdraws it; nobody else can; a decided one cannot be", async () => {
  const shop = await makeShop({ kind: "customer", leadStage: null, ownerId: manager.id });
  await db
    .update(customers)
    .set({ deactivationRequested: true, deactivationReason: "Shut down", deactivationRequestedById: manager.id, deactivationRequestedAt: new Date() })
    .where(eq(customers.id, shop.id));

  setTestUser(manager2);
  assert.equal((await withdrawStatusRequest(shop.id, "deactivate")).ok, false, "not the asker");

  setTestUser(manager);
  const r = await withdrawStatusRequest(shop.id, "deactivate");
  assert.ok(r.ok, r.ok ? "" : r.error);
  const [row] = await db.select().from(customers).where(eq(customers.id, shop.id));
  assert.equal(row.deactivationRequested, false);
  assert.equal(row.deactivationReason, null);
  assert.equal(row.status === "deactivated", false, "withdrawing changes nothing about the customer");
  const audit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, shop.id), eq(auditLog.action, "customer.deactivation_withdrawn")));
  assert.equal(audit.length, 1);

  assert.equal((await withdrawStatusRequest(shop.id, "deactivate")).ok, false, "nothing left to withdraw");
});

/* ----------------------------------------------------------------- expenses */

test("the office edits an expense it entered while undecided; another manager cannot; a decided one cannot be", async () => {
  setTestUser(manager);
  const day = addDays(TODAY, -1);
  const added = await addExpenseFor({ userId: salesA.id, day, kind: "food", amountPaise: 15_000, remarks: "Lunch" });
  assert.ok(added.ok, added.ok ? "" : added.error);
  const expenseId = added.data.id;

  const fixed = await editEnteredExpense(expenseId, { day, kind: "travel", amountPaise: 12_550, remarks: "Bus to Nashik" });
  assert.ok(fixed.ok, fixed.ok ? "" : fixed.error);
  const [line] = await db.select().from(mbosExpenses).where(eq(mbosExpenses.id, expenseId));
  assert.equal(Number(line.amountPaise), 12_550);
  assert.equal(line.kind, "travel");
  assert.equal(line.remarks, "Bus to Nashik");
  assert.equal((await db.select().from(auditLog).where(eq(auditLog.action, "mbos.expense.edited_for"))).length, 1);

  setTestUser(manager2);
  assert.equal((await editEnteredExpense(expenseId, { day, kind: "food", amountPaise: 1, remarks: "x" })).ok, false);
  assert.equal((await deleteEnteredExpense(expenseId, "mine now")).ok, false);

  /* Decided — the office cannot take it back any more. */
  await db
    .update(mbosApprovals)
    .set({ state: "approved", decidedAt: new Date() })
    .where(and(eq(mbosApprovals.subjectType, "expense"), eq(mbosApprovals.subjectId, expenseId)));
  setTestUser(manager);
  assert.equal((await editEnteredExpense(expenseId, { day, kind: "food", amountPaise: 100, remarks: "x" })).ok, false);
  assert.equal((await deleteEnteredExpense(expenseId, "too late")).ok, false);
});

test("the office deletes an expense it entered by mistake: the line and its approval go, a tombstone is written", async () => {
  setTestUser(manager);
  const added = await addExpenseFor({ userId: salesB.id, day: addDays(TODAY, -2), kind: "other", amountPaise: 9_900 });
  assert.ok(added.ok, added.ok ? "" : added.error);
  const expenseId = added.data.id;
  assert.equal((await deleteEnteredExpense(expenseId, "")).ok, false, "a reason is required");
  const r = await deleteEnteredExpense(expenseId, "Entered on the wrong salesman");
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal((await db.select().from(mbosExpenses).where(eq(mbosExpenses.id, expenseId))).length, 0);
  assert.equal((await db.select().from(mbosApprovals).where(eq(mbosApprovals.subjectId, expenseId))).length, 0);
  const [tomb] = await db.select().from(mbosDeletions).where(eq(mbosDeletions.entityId, expenseId));
  assert.equal(tomb.entity, "expenses");
  assert.equal(tomb.userId, salesB.id);
  assert.equal((await db.select().from(auditLog).where(eq(auditLog.action, "mbos.expense.deleted_for"))).length, 1);
});

/* --------------------------------------------------- reported payments, bills */

test("a reported payment is found against its bill and on the worklist row, with who reported it", async () => {
  const shop = await makeShop({ kind: "customer", leadStage: null, ownerId: salesA.id });
  const orderId = id("ord");
  await db.insert(orders).values({ id: orderId, customerId: shop.id, source: "erp", externalRef: "ERP-4321", totalAmount: 100_000, orderedAt: new Date() });
  const billId = id("bil");
  await db.insert(bills).values({
    id: billId,
    customerId: shop.id,
    billNo: "MB/26-27/0001",
    billDate: addDays(TODAY, -60),
    dueDate: addDays(TODAY, -30),
    amount: 100_000,
    orderId,
  });
  const receiptId = id("rcp");
  await db.insert(paymentReceipts).values({
    id: receiptId,
    customerId: shop.id,
    amount: 40_000,
    receivedAt: TODAY,
    status: "reported",
    reportedById: salesA.id,
    idempotencyKey: id("idem"),
  });
  await db.insert(payments).values({ id: id("pay"), receiptId, billId, customerId: shop.id, amount: 40_000, paidAt: TODAY });

  const byBill = await undecidedReceiptsForBills([billId]);
  assert.deepEqual(byBill.get(billId), [{ id: receiptId, amount: 40_000, status: "reported", reportedById: salesA.id }]);
  assert.deepEqual(await erpOrderNosFor([orderId, "nope"]), { [orderId]: 4321 });

  await recomputeFollowUpState(shop.id);
  setTestUser(manager);
  const rows = await getFollowUpWorklist();
  const mine = rows.find((r) => r.customerId === shop.id);
  assert.ok(mine, "the overdue account is on the worklist");
  {
    assert.equal(mine!.reportedAmount, 40_000);
    assert.deepEqual(mine!.reportedReceipts, [{ id: receiptId, amount: 40_000, status: "reported", reportedById: salesA.id }]);
  }
});
