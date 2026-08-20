/**
 * §11 — the six journeys, end to end.
 *
 * These run the real services against a real database: scope resolution,
 * capability checks, recompute paths and all. The engines have their own unit
 * tests; what these prove is that the wiring between them holds.
 *
 *   npm run test:integration
 *
 * They need mahekone_test, which `npm run test:db` creates from the committed
 * migrations. Never point them at a database anybody is using — the harness
 * truncates everything between tests.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  auditLog,
  bills,
  calls,
  complaints,
  complaintStatusHistory,
  customers,
  followUpAttempts,
  followUpStates,
  monthlyTargets,
  orders,
  paymentReceipts,
  payments,
  reminders,
  users,
  waMessages,
  waTemplates,
  attachments as attachmentsTable,
  sheetOrderRows,
  sheetPaymentRows,
  sheetPartyRows,
  sheetSyncRuns,
  customerAmChanges,
  employees,
  notifications,
  syncConflicts,
  sheetTakenOrderRows,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { customerStatusLabel } from "@/lib/format";
import {
  seedConfig,
  updateSetting,
  invalidateConfig,
  getConfig,
} from "@/lib/config/store";
import {
  assertCustomerInScope,
  NotPermittedError,
  scopeForUser,
} from "@/lib/access-control";
import { today } from "@/lib/recompute";
import {
  recomputeBuyingCycle,
  recomputeFollowUpState,
  recomputeInactivity,
  recomputeOutstanding,
  recomputeAllOutstanding,
  recomputeBillStatuses,
  recomputeAllBillPaid,
  recomputeSalesPeople,
} from "@/lib/recompute";
import { addDays } from "@/lib/business-date";
import { updateAccountManagers } from "@/lib/actions/account-manager";
import { projectParties } from "@/lib/services/party-projection-service";
import { assignedUserId } from "@/lib/access-control";
import { partyNameKey } from "@/lib/sheet-parse";
import {
  confirmAsMatchAction,
  confirmReceiptAction,
  holdReceiptAction,
  matchesForEntryAction,
  rejectReceiptAction,
  reverseReceiptAction,
} from "@/lib/actions/payments";
import { getQueue, queueCandidatesFor } from "@/lib/services/queue-service";
import { snapshotQueue } from "@/lib/jobs";
import {
  linkDeliveryParties,
  unresolvedDeliveryParties,
} from "@/lib/services/delivery-party-service";
import { customerRecordDetail } from "@/lib/services/customer-record-service";
import { saveInteraction } from "@/lib/services/interaction-service";
import { seedCatalogue } from "@/db/seed-catalogue";
import {
  products as productsTable,
  productAliases as productAliasesTable,
  catalogueExceptions as catalogueExceptionsTable,
  finishedGoods as finishedGoodsTable,
  quickNotes as quickNotesTable,
  interactionProductLines,
  appAccess,
  queueSnapshots as queueSnapshotsTable,
} from "@/db/schema";
import { importCatalogue } from "@/lib/services/catalogue-import";
import {
  searchProducts,
  popularProducts,
  customerProducts,
} from "@/lib/services/product-service";
import {
  confirmReceipt,
  openBillsFor,
  pendingReceipts,
  recordReceipt,
  rejectReceipt,
} from "@/lib/services/receipt-service";
import { globalSearch ,
  listCustomersPage,
  listInteractions,
} from "@/lib/queries";
import { describeQuantity } from "@/lib/catalogue";
import {
  chooseCanonicalId,
  nameHeldRow,
  setSkuActive,
} from "@/lib/actions/catalogue";
import {
  collectionsMetrics,
  getFollowUpWorklist,
  getPaymentFollowUpPlan,
  recordFollowUpAttempt,
  recordPayment,
} from "@/lib/services/payment-service";
import {
  logPaymentFollowUp,
  stageOneBatch,
} from "@/lib/services/payment-followup-service";
import {
  decideDeactivation,
  decideReactivation,
  rebuildQueues,
  requestDeactivation,
  requestReactivation,
  startStageOneBatch,
} from "@/lib/actions/crm";
import { loadCustomerTimeline } from "@/lib/actions/crm";
import {
  addDistributor,
  convertToThirdParty,
  recordDeliveryAddress,
  removeDistributor,
  revertThirdParty,
  updateDistributor,
} from "@/lib/actions/third-party";
import {
  deliveryAddressesFor,
  distributorCandidates,
  distributorsFor,
} from "@/lib/services/distributor-service";
import {
  createReminder,
  completeReminder,
  listInactiveWatch,
  listReminders,
  recordWatchOutcome,
  setTarget,
} from "@/lib/services/worklist-services";
import {
  approveOrder,
  declineOrder,
} from "@/lib/services/order-approval-service";
import {
  customerTimeline,
  customerTimelineCounts,
  listAssignableUsers,
  listBackOfficeCandidates,
  listTeam,
  rangeActivity,
} from "@/lib/queries";
import {
  confirmSent,
  markCopied,
  prepareLegs,
  prepareMessage,
} from "@/lib/services/whatsapp-service";
import {
  eodMetricsFor,
  eodMetricsForRange,
  eodPreflightFor,
} from "@/lib/services/eod-service";
import {
  projectSheet,
  revertSheetSettledBills,
} from "@/lib/services/sheet-projection-service";

/* ------------------------------------------------------------------ harness */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let TODAY: string;
let manager: typeof users.$inferSelect;
let priya: typeof users.$inferSelect;
let rakesh: typeof users.$inferSelect;
let deepa: typeof users.$inferSelect;

async function makeUser(
  name: string,
  role: "telecaller" | "manager" | "accounts" | "admin",
  reportsToId?: string,
) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
      reportsToId: reportsToId ?? null,
    })
    .returning();
  return row;
}

async function makeCustomer(
  ownerId: string,
  over: Partial<typeof customers.$inferInsert> = {},
) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: over.name ?? `Customer ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact Person",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Mumbai",
      ownerId,
      // Scope resolves through the sales account manager on a customer, so the
      // fixture sets it. Tests that want a lead pass kind: "lead".
      salesAmId: ownerId,
      customerSince: addDays(TODAY, -400),
      ...over,
    })
    .returning();
  return row;
}

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  // Truncate rather than drop: the schema stays, the data does not.
  await db.execute(sql`
    truncate table
      audit_log, job_runs, bug_reports, feedback, help_articles, notifications,
      inactive_watch_items, monthly_targets, wa_runs, wa_replies, wa_messages,
      wa_templates, complaint_status_history, complaints, reminders,
      interaction_product_lines, catalogue_exceptions, product_aliases, products,
      finished_goods, product_brands, product_formulations,
      quick_notes, migration_exceptions,
      follow_up_attempts, follow_up_states, payments, bills,
      orders, calls, eod_reports, attendance, app_access, sessions, password_resets,
      customer_distributors, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  await seedCatalogue();

  manager = await makeUser("Vikram", "manager");
  priya = await makeUser("Priya", "telecaller", manager.id);
  rakesh = await makeUser("Rakesh", "telecaller", manager.id);
  deepa = await makeUser("Deepa", "accounts");

  setTestUser(priya);
  TODAY = await today();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/**
 * Accounts finding the money in the bank.
 *
 * Anything a telecaller records is a claim until this happens, so every
 * journey that ends in a settled bill has to pass through it. Restores
 * whoever was acting before, because the tests that use it are not about
 * accounts — they are about what the money does once accounts have spoken.
 */
async function confirmReportedPayments(customerId: string): Promise<number> {
  setTestUser(deepa);
  const waiting = await db
    .select({ id: paymentReceipts.id })
    .from(paymentReceipts)
    .where(
      and(
        eq(paymentReceipts.customerId, customerId),
        eq(paymentReceipts.status, "reported"),
      ),
    );
  for (const r of waiting) {
    const done = await confirmReceipt(r.id);
    assert.equal(done.ok, true, done.ok ? "" : done.error);
  }
  setTestUser(priya);
  return waiting.length;
}

/* ------------------------------------------------- journey 1: buying cycle */

describe("Journey 1 - a new customer earns their own buying cycle", () => {
  test("orders replace the default cycle, and the customer reaches the queue when due", async () => {
    const customer = await makeCustomer(priya.id);

    // With no history at all, the cycle is the configured default and says so.
    await recomputeBuyingCycle(customer.id);
    let [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    const config = await getConfig();
    assert.equal(row.cycleIsDefault, true);
    assert.equal(row.cycleDays, config["buyingCycle.defaultDays"]);

    // Four orders, twenty days apart.
    for (let i = 4; i >= 1; i--) {
      await db.insert(orders).values({
        id: id("ord"),
        customerId: customer.id,
        userId: priya.id,
        orderedAt: new Date(`${addDays(TODAY, -20 * i)}T06:00:00+05:30`),
        totalAmount: 50_000_00,
        status: "confirmed",
      });
    }
    await recomputeBuyingCycle(customer.id);

    [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(
      row.cycleIsDefault,
      false,
      "four orders is enough to derive a cycle",
    );
    assert.equal(row.cycleDays, 20);
    assert.equal(row.avgOrderValue, 50_000_00);

    // Twenty days since the last order, so they are due to reorder.
    const queue = await getQueue();
    const entry = queue.entries.find((e) => e.customerId === customer.id);
    assert.ok(
      entry,
      "a customer at their cycle length must appear in the queue",
    );
    assert.ok(
      entry.reasons.some((r) => r.kind.startsWith("order")),
      `expected an order-due reason, got ${entry.reasons.map((r) => r.kind).join(", ")}`,
    );
  });
});

/* ------------------------------------------ journey 2: payment escalation */

describe("Journey 2 - an overdue bill escalates, is chased, and is paid", () => {
  async function overdueCustomer(daysOverdue: number) {
    const customer = await makeCustomer(priya.id);
    await db.insert(bills).values({
      id: id("bil"),
      customerId: customer.id,
      billNo: `MMI/${randomUUID().slice(0, 6)}`,
      billDate: addDays(TODAY, -daysOverdue - 30),
      dueDate: addDays(TODAY, -daysOverdue),
      amount: 1_00_000_00,
      paidAmount: 0,
    });
    await recomputeBillStatuses();
    await recomputeOutstanding(customer.id);
    await recomputeFollowUpState(customer.id);
    return customer;
  }

  test("stage 1 is WhatsApp-only - a call attempt is refused, and says why", async () => {
    const customer = await overdueCustomer(10);

    const [state] = await db
      .select()
      .from(followUpStates)
      .where(eq(followUpStates.customerId, customer.id));
    assert.equal(state.stage, 1);
    assert.equal(state.nextChannel, "whatsapp");

    const refused = await recordFollowUpAttempt({
      customerId: customer.id,
      channel: "call",
      idempotencyKey: randomUUID(),
    });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /whatsapp/i);
  });

  test("the whole chase: stage 1 → stage 2 → promise → payment → off the list", async () => {
    const customer = await overdueCustomer(20);

    // The ladder is 0–15, 16–29, 30+. Twenty days is inside the second band,
    // and past the fifteen-day quiet window, so this is a customer who may be
    // called. It used to be thirty, which stage 3 now claims — the number moved
    // when the bands did, and what this journey is about is the chase, not the
    // day it starts on.
    const worklist = await getFollowUpWorklist();
    const row = worklist.find((r) => r.customerId === customer.id);
    assert.ok(row);
    assert.equal(row.stage, 2);
    assert.equal(row.totalOverdue, 1_00_000_00);

    const attempt = await recordFollowUpAttempt({
      customerId: customer.id,
      channel: "call",
      outcome: "promised",
      promisedAmount: 1_00_000_00,
      promisedDate: addDays(TODAY, 5),
      idempotencyKey: randomUUID(),
    });
    assert.equal(attempt.ok, true, attempt.ok ? "" : attempt.error);

    // A dated promise creates the reminder that chases it.
    assert.ok(attempt.data.reminderId, "a promise must create a reminder");

    const promised = (await getFollowUpWorklist()).find(
      (r) => r.customerId === customer.id,
    );
    assert.equal(promised?.promisedAmount, 1_00_000_00);
    assert.equal(promised?.promiseBroken, false);

    // The money arrives.
    const [bill] = await db
      .select()
      .from(bills)
      .where(eq(bills.customerId, customer.id));
    const paid = await recordPayment({
      billId: bill.id,
      amount: 1_00_000_00,
      paidAt: TODAY,
      idempotencyKey: randomUUID(),
    });
    assert.equal(paid.ok, true, paid.ok ? "" : paid.error);

    // A telecaller recording it is a claim, not a settlement. The bill does
    // not move until accounts have found the money.
    const [claimed] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(claimed.status, "unpaid", "nothing moves on a telecaller's word");
    assert.equal(
      (await getFollowUpWorklist()).find((r) => r.customerId === customer.id)
        ?.reportedAmount,
      1_00_000_00,
      "but the list says the money has been reported",
    );

    assert.equal(await confirmReportedPayments(customer.id), 1);

    const [after] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(after.status, "paid");

    const [customerAfter] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(customerAfter.outstanding, 0);

    const stillListed = (await getFollowUpWorklist()).find(
      (r) => r.customerId === customer.id,
    );
    assert.equal(
      stillListed,
      undefined,
      "a paid-up customer leaves the worklist",
    );
  });

  test("a disputed bill holds the customer instead of escalating them", async () => {
    const customer = await overdueCustomer(60);
    await db
      .update(bills)
      .set({ disputed: true })
      .where(eq(bills.customerId, customer.id));
    await recomputeFollowUpState(customer.id);

    const row = (await getFollowUpWorklist()).find(
      (r) => r.customerId === customer.id,
    );
    assert.ok(row);
    assert.equal(row.held, true);
    assert.ok(row.heldReason, "a hold must carry a reason a human can read");
  });
});

/* --------------------------------------------- journey 3: WhatsApp and the queue */

describe("Journey 3 - copying is not sending", () => {
  async function prepared() {
    const customer = await makeCustomer(priya.id, {
      lastContactDate: addDays(TODAY, -60),
      lastOrderDate: addDays(TODAY, -60),
      cycleDays: 20,
      cycleIsDefault: false,
    });

    const [template] = await db
      .insert(waTemplates)
      .values({
        id: id("tpl"),
        name: "Routine check-in",
        category: "routine_check_in",
        body: "Namaste {{contact}}, checking in from Mahek Marketing.",
        appliesTo: "personal",
      })
      .returning();

    const message = await prepareMessage({
      customerId: customer.id,
      templateId: template.id,
      idempotencyKey: randomUUID(),
    });
    assert.equal(message.ok, true, message.ok ? "" : message.error);
    return { customer, messageId: message.data.messageId };
  }

  test("a copied but unconfirmed message does NOT suppress the queue", async () => {
    const { customer, messageId } = await prepared();

    const before = await getQueue();
    assert.ok(before.entries.some((e) => e.customerId === customer.id));

    await markCopied(messageId);

    const after = await getQueue();
    assert.ok(
      after.entries.some((e) => e.customerId === customer.id),
      "the system does not know a copied message was ever sent, so the customer stays",
    );
    assert.equal(
      after.suppressed.some((s) => s.customerId === customer.id),
      false,
    );
  });

  test("a confirmed send suppresses for the cooldown, and shows the reason", async () => {
    const { customer, messageId } = await prepared();

    await markCopied(messageId);
    const confirmed = await confirmSent(messageId);
    assert.equal(confirmed.ok, true, confirmed.ok ? "" : confirmed.error);

    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(row.lastConfirmedWhatsappDate, TODAY);

    const queue = await getQueue();
    assert.equal(
      queue.entries.some((e) => e.customerId === customer.id),
      false,
    );

    // Suppressed, not silently dropped.
    const held = queue.suppressed.find((s) => s.customerId === customer.id);
    assert.ok(held, "a suppressed customer must still be reported");
    assert.match(held.reason, /cooldown/i);
  });

  test("a merge field with nothing behind it is refused, naming the field", async () => {
    const customer = await makeCustomer(priya.id, { whatsappGroupName: null });
    const [template] = await db
      .insert(waTemplates)
      .values({
        id: id("tpl"),
        name: "Payment reminder",
        category: "payment_reminder",
        body: "Bill {{bill_no}} for {{outstanding}} is due.",
        appliesTo: "personal",
      })
      .returning();

    // No bills at all, so {{bill_no}} cannot resolve.
    const result = await prepareMessage({
      customerId: customer.id,
      templateId: template.id,
      idempotencyKey: randomUUID(),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /bill_no/);
  });

  /* Both-ways: two destinations, two rows, two independent confirmations. */

  async function bothWays(over: Partial<typeof customers.$inferInsert> = {}) {
    const customer = await makeCustomer(priya.id, {
      lastContactDate: addDays(TODAY, -60),
      lastOrderDate: addDays(TODAY, -60),
      cycleDays: 20,
      cycleIsDefault: false,
      whatsappDest: "both",
      whatsappGroupName: "Balaji Traders - orders",
      ...over,
    });

    const [template] = await db
      .insert(waTemplates)
      .values({
        id: id("tpl"),
        name: "Routine check-in",
        category: "routine_check_in",
        body: "Namaste {{contact}}, checking in from Mahek Marketing.",
        appliesTo: "both",
      })
      .returning();

    const legs = await prepareLegs({
      customerId: customer.id,
      templateId: template.id,
      idempotencyKey: randomUUID(),
    });
    assert.equal(legs.ok, true, legs.ok ? "" : legs.error);
    return { customer, legs: legs.data };
  }

  test("a both-ways customer produces one row per destination", async () => {
    const { legs } = await bothWays();

    assert.equal(legs.length, 2);
    assert.deepEqual(
      legs.map((l) => l.destKind),
      ["personal", "group"],
      "the personal leg comes first - it is the one that can finish without a human",
    );
    assert.equal(legs[1].resolvedDestination, "Balaji Traders - orders");
    assert.notEqual(
      legs[0].messageId,
      legs[1].messageId,
      "two destinations are two pieces of work, not one row read twice",
    );
  });

  test("confirming one leg leaves the other exactly where it was", async () => {
    const { legs } = await bothWays();
    const [personal, group] = legs;

    await markCopied(personal.messageId);
    await markCopied(group.messageId);
    const confirmed = await confirmSent(group.messageId);
    assert.equal(confirmed.ok, true, confirmed.ok ? "" : confirmed.error);

    const [personalRow] = await db
      .select()
      .from(waMessages)
      .where(eq(waMessages.id, personal.messageId));
    assert.equal(
      personalRow.status,
      "copied",
      "the group being posted says nothing about the owner's own number",
    );
    assert.equal(personalRow.confirmedSentAt, null);
  });

  test("either leg confirmed means the customer was reached", async () => {
    const { customer, legs } = await bothWays();

    await markCopied(legs[0].messageId);
    await confirmSent(legs[0].messageId);

    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(
      row.lastConfirmedWhatsappDate,
      TODAY,
      "one confirmed route is contact; waiting for the second would chase a customer who already heard from us",
    );
  });

  test("both ways with no group recorded falls back to the number alone", async () => {
    const { legs } = await bothWays({ whatsappGroupName: null });

    assert.equal(legs.length, 1);
    assert.equal(legs[0].destKind, "personal");
  });
});

/* ------------------------------- the customer list, filtered in the database */

describe("The customer list is filtered where it is counted", () => {
  /**
   * The status shown on this list is derived — from the stored status, whether
   * anything has ever been ordered, and the slow-payer flag. It is written
   * twice now: once in TypeScript for the screen, once in SQL because the list
   * is filtered and counted in Postgres and a WHERE clause cannot call a
   * function.
   *
   * Two statements of one rule drift. This is what stops them.
   */
  test("every status label means the same thing in SQL as in TypeScript", async () => {
    await makeCustomer(priya.id, { name: "Status Active", lastOrderDate: TODAY });
    await makeCustomer(priya.id, { name: "Status New", lastOrderDate: null });
    await makeCustomer(priya.id, {
      name: "Status Slow",
      lastOrderDate: TODAY,
      slowPayer: true,
    });
    await makeCustomer(priya.id, { name: "Status Inactive", status: "inactive" });
    await makeCustomer(priya.id, {
      name: "Status Deactivated",
      status: "deactivated",
    });
    // Inactive outranks slow payer, and the SQL has to agree about that too.
    await makeCustomer(priya.id, {
      name: "Status Inactive And Slow",
      status: "inactive",
      slowPayer: true,
      lastOrderDate: TODAY,
    });

    const rows = await db.select().from(customers);
    const fromTypescript = new Map<string, number>();
    for (const c of rows) {
      const label = customerStatusLabel(c);
      fromTypescript.set(label, (fromTypescript.get(label) ?? 0) + 1);
    }

    for (const [label, expected] of fromTypescript) {
      const page = await listCustomersPage({ status: label, perPage: 200 });
      assert.equal(
        page.total,
        expected,
        `SQL and TypeScript disagree about "${label}"`,
      );
      for (const row of page.rows) {
        assert.equal(customerStatusLabel(row), label);
      }
    }
  });

  test("a page is a slice, and the totals describe the whole filter", async () => {
    for (let i = 0; i < 7; i++) {
      await makeCustomer(priya.id, { name: `Pager ${i}`, outstanding: 1000 });
    }
    const all = await listCustomersPage({ perPage: 200 });
    const first = await listCustomersPage({ perPage: 3, page: 1 });
    const second = await listCustomersPage({ perPage: 3, page: 2 });

    assert.equal(first.rows.length, 3);
    assert.equal(first.total, all.total, "the count is of the filter, not the page");
    assert.equal(
      first.totals.outstanding,
      all.totals.outstanding,
      "the tiles sum the filter, not the page in front of you",
    );
    assert.notEqual(first.rows[0].id, second.rows[0].id, "page 2 is different rows");
  });

  test("asking past the last page lands on the last page, not on nothing", async () => {
    for (let i = 0; i < 4; i++) await makeCustomer(priya.id, { name: `Clamp ${i}` });
    const far = await listCustomersPage({ perPage: 2, page: 99 });
    assert.equal(far.page, far.pageCount);
    assert.ok(far.rows.length > 0, "a filter that shortens the list must not strand somebody");
  });
});

/* ------------------------------------------------- journey 4: the EOD gate */

describe("Journey 4 - the EOD gate", () => {
  test("a reminder due today blocks the report until it is closed", async () => {
    const customer = await makeCustomer(priya.id);

    // The gate is about a reminder due TODAY, so today has to be a day the
    // reminder can fall on. Reminders roll off non-working days by default,
    // and when this suite runs on a Sunday that rule quietly moves the due
    // date to Monday — leaving nothing due today and the gate correctly open,
    // which reads as this rule being broken rather than the other one working.
    await updateSetting("reminders.rollForwardOnNonWorkingDays", false, manager.id);

    const created = await createReminder({
      customerId: customer.id,
      dueDate: TODAY,
      note: "Call back after they check stock",
    });
    assert.equal(created.ok, true, created.ok ? "" : created.error);

    const blocked = await eodPreflightFor(priya.id, TODAY);
    assert.equal(blocked.canFinalise, false);
    assert.equal(blocked.blocking.length, 1);
    assert.match(blocked.message, /reminder/i);

    await completeReminder(created.data.id, "Spoke to them, will order Friday");

    const open = await eodPreflightFor(priya.id, TODAY);
    assert.equal(open.canFinalise, true);
  });

  test("a reminder is dismissed, never deleted, and stays on the record", async () => {
    const customer = await makeCustomer(priya.id);
    const created = await createReminder({
      customerId: customer.id,
      dueDate: TODAY,
      note: "Chase the pending cheque",
    });
    assert.ok(created.ok);

    const { dismissReminder } =
      await import("@/lib/services/worklist-services");

    const noReason = await dismissReminder(created.data.id, "   ");
    assert.equal(noReason.ok, false, "dismissal without a reason is refused");

    const done = await dismissReminder(
      created.data.id,
      "Cheque already banked",
    );
    assert.equal(done.ok, true);

    const [row] = await db
      .select()
      .from(reminders)
      .where(eq(reminders.id, created.data.id));
    assert.equal(row.status, "dismissed");
    assert.equal(row.dismissReason, "Cheque already banked");

    // Three statuses and no more — "cancelled" is not one of them.
    const all = await listReminders();
    assert.ok(
      all.every((r) =>
        ["pending", "completed", "dismissed"].includes(r.status),
      ),
    );
  });
});

/* ------------------------------------------- journey 5: the inactive watch */

describe("Journey 5 - a customer goes quiet and gets a decision", () => {
  test("they are flagged with a value at risk, then leave once decided", async () => {
    const customer = await makeCustomer(priya.id, {
      cycleDays: 20,
      cycleIsDefault: false,
      lastOrderDate: addDays(TODAY, -70),
      avgOrderValue: 80_000_00,
    });

    const flagged = await recomputeInactivity();
    assert.ok(flagged >= 1);

    const watch = await listInactiveWatch();
    const row = watch.find((w) => w.customerId === customer.id);
    assert.ok(row, "three and a half cycles of silence must reach the watch");
    assert.ok(Number(row.cyclesElapsed) >= 3);
    assert.ok(
      row.valueAtRisk > 0,
      "the watch is about money, so it must carry a figure",
    );
    assert.equal(row.outcome, null);

    const decided = await recordWatchOutcome(
      customer.id,
      "contacted",
      "Spoke to them - they buy again next month",
    );
    assert.equal(decided.ok, true, decided.ok ? "" : decided.error);

    const after = await listInactiveWatch();
    const stillOpen = after.find((w) => w.customerId === customer.id);
    assert.equal(
      stillOpen?.needsDecision,
      false,
      "a decided item stops nagging",
    );
  });

  test("the status is marked inactive automatically, and an order undoes it", async () => {
    const customer = await makeCustomer(priya.id, {
      cycleDays: 20,
      cycleIsDefault: false,
      lastOrderDate: addDays(TODAY, -70),
      avgOrderValue: 80_000_00,
    });

    const status = async () => {
      const [row] = await db
        .select({ status: customers.status })
        .from(customers)
        .where(eq(customers.id, customer.id));
      return row.status;
    };

    assert.equal(await status(), "active", "they start active");

    await recomputeInactivity();
    assert.equal(await status(), "inactive", "twice the cycle marks them");

    // Running again must not undo itself — the status is this engine's own
    // output, and reading it back as a reason to skip would clear the flag.
    await recomputeInactivity();
    assert.equal(await status(), "inactive");
    const watch = await listInactiveWatch();
    assert.ok(watch.find((w) => w.customerId === customer.id));

    // They are still callable: an inactive customer is on the queue, because
    // calling them is the entire point.
    const queue = await getQueue();
    assert.ok(
      [...queue.entries, ...queue.suppressed].some(
        (q) => q.customerId === customer.id,
      ),
      "an inactive customer must not vanish from the calling list",
    );

    await db
      .update(customers)
      .set({ lastOrderDate: TODAY })
      .where(eq(customers.id, customer.id));
    await recomputeInactivity();
    assert.equal(await status(), "active", "an order puts them back");
  });

  test("deactivation is a decision, and no recompute reverses it", async () => {
    const customer = await makeCustomer(priya.id, {
      cycleDays: 20,
      cycleIsDefault: false,
      lastOrderDate: TODAY,
    });
    await db
      .update(customers)
      .set({ status: "deactivated" })
      .where(eq(customers.id, customer.id));

    await recomputeInactivity();

    const [row] = await db
      .select({ status: customers.status })
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(row.status, "deactivated", "an order does not undo a decision");
  });

  test("a telecaller cannot ask for somebody else's customer to go", async () => {
    // `resolveScope` was called and its answer thrown away: the update matched
    // on the ids alone, so any signed-in person could flag any customer in the
    // company. It set a flag a manager has to confirm, which is why nobody saw
    // it — but a server action is a URL and the ids come from the caller.
    const someoneElses = await makeCustomer(rakesh.id, { lastOrderDate: TODAY });

    setTestUser(priya);
    const r = await requestDeactivation([someoneElses.id], "Not mine to ask.");
    assert.equal(r.ok, false, "a telecaller flagged a customer outside their book");

    const [row] = await db
      .select({ requested: customers.deactivationRequested })
      .from(customers)
      .where(eq(customers.id, someoneElses.id));
    assert.equal(row.requested, false, "the refusal still wrote the flag");
  });

  test("one customer outside the book refuses the whole request", async () => {
    // Nobody re-reads a list they have been told went through, so a bulk
    // action either does all of it or none of it.
    const mine = await makeCustomer(priya.id, { lastOrderDate: TODAY });
    const theirs = await makeCustomer(rakesh.id, { lastOrderDate: TODAY });

    setTestUser(priya);
    const r = await requestDeactivation([mine.id, theirs.id], "Closing both.");
    assert.equal(r.ok, false);

    const rows = await db
      .select({ id: customers.id, requested: customers.deactivationRequested })
      .from(customers)
      .where(inArray(customers.id, [mine.id, theirs.id]));
    assert.ok(
      rows.every((x) => x.requested === false),
      "part of a refused bulk request was written anyway",
    );
  });

  test("a manager reaches the whole team's book", async () => {
    const theirs = await makeCustomer(rakesh.id, { lastOrderDate: TODAY });
    setTestUser(manager);
    assert.equal(
      (await requestDeactivation([theirs.id], "Team-wide clean-up.")).ok,
      true,
      "scoping the write shut a manager out of their own team",
    );
  });

  test("the way back: requested by a telecaller, decided by a manager", async () => {
    const customer = await makeCustomer(priya.id, { lastOrderDate: TODAY });

    // Out of the book first, the ordinary way.
    setTestUser(priya);
    assert.equal(
      (await requestDeactivation([customer.id], "Shut the shop.")).ok,
      true,
    );
    setTestUser(manager);
    assert.equal((await decideDeactivation(customer.id, true)).ok, true);

    let [row] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(row.status, "deactivated");

    // A telecaller hears they are opening again. They may ask; they may not decide.
    setTestUser(priya);
    const blank = await requestReactivation([customer.id], "   ");
    assert.equal(blank.ok, false, "a reason is required in both directions");

    const asked = await requestReactivation(
      [customer.id],
      "Reopened under the son. Wants to order next week.",
    );
    assert.equal(asked.ok, true, asked.ok ? "" : asked.error);

    [row] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(row.reactivationRequested, true);
    assert.match(row.reactivationReason ?? "", /Reopened under the son/);
    assert.equal(row.status, "deactivated", "asking is not deciding");

    // The action catches and returns rather than throwing, the way every
    // action here does — so the denial arrives as a Result a form can show.
    const denied = await decideReactivation(customer.id, true);
    assert.equal(denied.ok, false, "a telecaller cannot bring a customer back");
    assert.equal(denied.ok === false && denied.code, "not_permitted");

    // The manager decides.
    setTestUser(manager);
    const done = await decideReactivation(customer.id, true);
    assert.equal(done.ok, true, done.ok ? "" : done.error);

    [row] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(row.status, "active", "they are back in the book");
    assert.equal(row.reactivationRequested, false);
    assert.equal(row.reactivationReason, null);
    // The deactivation that was reversed does not stay on the row explaining a
    // state the customer is no longer in.
    assert.equal(row.deactivatedAt, null);
    assert.equal(row.deactivationReason, null);

    // Both decisions are in the log, which is where the history lives.
    const log = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, customer.id));
    const actions = log.map((l) => l.action);
    assert.ok(actions.includes("customer.deactivate"));
    assert.ok(actions.includes("customer.reactivate"));
  });

  test("a rejected request leaves the customer where they were", async () => {
    const customer = await makeCustomer(priya.id);
    await db
      .update(customers)
      .set({ status: "deactivated", deactivationReason: "Stopped paying." })
      .where(eq(customers.id, customer.id));

    setTestUser(priya);
    await requestReactivation([customer.id], "They say they will pay.");
    setTestUser(manager);
    assert.equal((await decideReactivation(customer.id, false)).ok, true);

    const [row] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(row.status, "deactivated", "a refusal changes nothing but the ask");
    assert.equal(row.reactivationRequested, false);
    assert.equal(row.reactivationReason, null);
    assert.equal(
      row.deactivationReason,
      "Stopped paying.",
      "and the reason they went out is untouched",
    );
  });

  test("a customer who is not deactivated cannot be asked back", async () => {
    const customer = await makeCustomer(priya.id);
    setTestUser(priya);
    const refused = await requestReactivation([customer.id], "no reason to");
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.code, "conflict");
  });

  test("coming back does not fake activity - a quiet customer is still quiet", async () => {
    const customer = await makeCustomer(priya.id, {
      cycleDays: 20,
      cycleIsDefault: false,
      // Long gone: well past any inactivity threshold.
      lastOrderDate: addDays(TODAY, -400),
      lastContactDate: addDays(TODAY, -400),
    });
    await db
      .update(customers)
      .set({ status: "deactivated" })
      .where(eq(customers.id, customer.id));

    setTestUser(priya);
    await requestReactivation([customer.id], "Asked to be put back on.");
    setTestUser(manager);
    await decideReactivation(customer.id, true);

    const [row] = await db
      .select({ status: customers.status })
      .from(customers)
      .where(eq(customers.id, customer.id));
    // `active` is what the action sets; `recomputeInactivity` runs straight
    // after and is what decides whether that is still true. A customer who has
    // bought nothing for a year comes back onto the watch, not onto the
    // dashboard as a healthy account.
    assert.equal(row.status, "inactive");
  });

  /*
   * The Taken Order tab is where an order lands FIRST — typed as the customer
   * gives it, hours or days before it is dispatched, billed, or written to
   * Order Details and projected into `orders`.
   *
   * Two things were meant to cover a customer between ordering and being
   * chased again: `activeInOrderSystem` holds them while any line is open, and
   * `lastOrderDate` keeps them quiet afterwards. The hold released on dispatch
   * and handed over to a date that knew nothing about the order, so the
   * customer went back on the Call Log days after their material shipped.
   */
  describe("an order on the Taken Order tab counts as an order placed", () => {
    async function takenOrderRow(
      customerId: string,
      orderDate: string,
      over: Partial<typeof sheetTakenOrderRows.$inferInsert> = {},
    ) {
      const [run] = await db
        .insert(sheetSyncRuns)
        .values({
          id: id("syn"),
          source: "taken_order",
          spreadsheetId: "sheet",
          tabTitle: "Taken Order",
          status: "ok",
        })
        .returning();

      await db.insert(sheetTakenOrderRows).values({
        id: id("tak"),
        syncId: run.id,
        rowNumber: 1,
        lineKey: randomUUID(),
        raw: {},
        rowHash: randomUUID(),
        orderDate,
        billingPartyName: "Whoever",
        matchedCustomerId: customerId,
        // Dispatched and filed: the hold has already let go.
        officeStatus: "Ready",
        entryStatus: "Done",
        open: false,
        ...over,
      });
    }

    test("a dispatched line still stops the queue chasing them", async () => {
      const customer = await makeCustomer(priya.id, {
        cycleDays: 10,
        cycleIsDefault: false,
        // What `orders` knows: nothing since June.
        lastOrderDate: addDays(TODAY, -55),
      });
      await takenOrderRow(customer.id, addDays(TODAY, -3));

      await recomputeBuyingCycle(customer.id);

      const [row] = await db
        .select({ last: customers.lastOrderDate })
        .from(customers)
        .where(eq(customers.id, customer.id));
      assert.equal(
        row.last,
        addDays(TODAY, -3),
        "the tab knew about the order before `orders` did",
      );

      setTestUser(priya);
      const queue = await getQueue();
      const chased = queue.entries.find((e) => e.customerId === customer.id);
      assert.equal(
        chased,
        undefined,
        "a customer whose material shipped three days ago is not asked to order again",
      );
    });

    test("a cancelled line is not an order", async () => {
      const customer = await makeCustomer(priya.id);
      // A real order, seven weeks ago.
      await db.insert(orders).values({
        id: id("ord"),
        customerId: customer.id,
        userId: priya.id,
        orderedAt: new Date(`${addDays(TODAY, -55)}T09:00:00+05:30`),
        totalAmount: 5_000_00,
        status: "confirmed",
      });
      // And a cancelled line three days ago. Cancel releases the hold on its
      // own, precisely because the customer behind it has not ordered
      // anything — counting it here would mute the one person who should be
      // rung.
      await takenOrderRow(customer.id, addDays(TODAY, -3), {
        officeStatus: "Cancel",
        entryStatus: null,
        open: false,
      });

      await recomputeBuyingCycle(customer.id);

      const [row] = await db
        .select({ last: customers.lastOrderDate })
        .from(customers)
        .where(eq(customers.id, customer.id));
      assert.equal(
        row.last,
        addDays(TODAY, -55),
        "the cancelled line is ignored and the real order stands",
      );
    });

    test("a CRM order still wins when it is the newer of the two", async () => {
      const customer = await makeCustomer(priya.id);
      await takenOrderRow(customer.id, addDays(TODAY, -30));
      await db.insert(orders).values({
        id: id("ord"),
        customerId: customer.id,
        userId: priya.id,
        orderedAt: new Date(`${addDays(TODAY, -2)}T09:00:00+05:30`),
        totalAmount: 5_000_00,
        status: "pending_approval",
      });

      await recomputeBuyingCycle(customer.id);

      const [row] = await db
        .select({ last: customers.lastOrderDate })
        .from(customers)
        .where(eq(customers.id, customer.id));
      assert.equal(row.last, addDays(TODAY, -2), "the later of the two is the answer");
    });
  });
});

/* -------------------------------------------------- journey 6: who sees what */

describe("Journey 6 - a telecaller sees their own book and nothing else", () => {
  test("another telecaller's customers are invisible in every list", async () => {
    const mine = await makeCustomer(priya.id, { name: "Priya's customer" });
    const theirs = await makeCustomer(rakesh.id, { name: "Rakesh's customer" });

    // Both are overdue, so both would qualify for the collections worklist.
    for (const c of [mine, theirs]) {
      await db.insert(bills).values({
        id: id("bil"),
        customerId: c.id,
        billNo: `MMI/${randomUUID().slice(0, 6)}`,
        billDate: addDays(TODAY, -60),
        dueDate: addDays(TODAY, -30),
        amount: 50_000_00,
        paidAmount: 0,
      });
      await recomputeOutstanding(c.id);
      await recomputeFollowUpState(c.id);
    }

    setTestUser(priya);
    const asPriya = await getFollowUpWorklist();
    assert.ok(asPriya.some((r) => r.customerId === mine.id));
    assert.equal(
      asPriya.some((r) => r.customerId === theirs.id),
      false,
      "a telecaller must never see another telecaller's customer",
    );

    setTestUser(manager);
    const asManager = await getFollowUpWorklist();
    assert.ok(asManager.some((r) => r.customerId === mine.id));
    assert.ok(
      asManager.some((r) => r.customerId === theirs.id),
      "a manager sees the whole team's book",
    );
  });

  test("the owner may open a record whose sales seat has moved on", async () => {
    // The shape that produced a 500 in production: the account was worked by
    // Priya, who owns it and holds its callback, while the sheet's salesperson
    // and the back office are two other people. Reading only the sales seat
    // refused her the record her own reminder was about.
    const moved = await makeCustomer(priya.id, {
      salesAmId: rakesh.id,
      backOfficeAmId: manager.id,
    });

    setTestUser(priya);
    await assert.doesNotReject(
      () => assertCustomerInScope(moved),
      "the owner still works the account, so the owner may still read it",
    );

    // The lists are deliberately untouched by that: a record belongs on ONE
    // person's list, and that is still the sales seat.
    const onPriyasList = await listCustomersPage({ page: 1 });
    assert.equal(
      onPriyasList.rows.some((r) => r.id === moved.id),
      false,
      "widening who may READ a record must not widen whose list it appears on",
    );

    // And somebody with no seat at all is still refused.
    const stranger = await makeUser("Stranger", "telecaller", manager.id);
    setTestUser(stranger);
    await assert.rejects(
      () => assertCustomerInScope(moved),
      NotPermittedError,
      "a third party with no seat on the account may not read it",
    );
  });

  test("a manager-only action names the role it needs, and is recorded", async () => {
    const customer = await makeCustomer(priya.id);

    setTestUser(priya);
    await assert.rejects(
      () => setTarget(customer.id, 500000, TODAY.slice(0, 7)),
      (error: unknown) => {
        assert.ok(error instanceof NotPermittedError);
        assert.match((error as Error).message, /manager/i);
        return true;
      },
    );

    const [denial] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log where action = 'access.denied'
    `);
    assert.ok(
      Number(denial.n) >= 1,
      "a refusal is a security event, so it is recorded",
    );

    setTestUser(manager);
    const allowed = await setTarget(customer.id, 500000, TODAY.slice(0, 7));
    assert.equal(allowed.ok, true, allowed.ok ? "" : allowed.error);

    const [target] = await db
      .select()
      .from(monthlyTargets)
      .where(eq(monthlyTargets.customerId, customer.id));
    assert.equal(
      target.isDefault,
      false,
      "a hand-set target is no longer a default",
    );
  });
});

/* ------------------------- journey 7: complaints, merged from both branches */

describe("Journey 7 - a complaint carries its SLA and its credit-note request", () => {
  test("logging one sets severity, an SLA deadline and an opening history line", async () => {
    const customer = await makeCustomer(priya.id);
    const { logComplaint } = await import("@/lib/actions/crm");

    const result = await logComplaint({
      customerId: customer.id,
      category: "Packaging",
      description: "Two drums dented, one three litres short",
      mobileNumber: "9820055555",
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const [row] = await db
      .select()
      .from(complaints)
      .where(eq(complaints.customerId, customer.id));

    assert.ok(row, "the complaint must exist");
    assert.equal(row.status, "open");
    assert.equal(row.mobileNumber, "9820055555");
    // The SLA deadline is derived from configured hours, never typed in.
    assert.ok(
      row.slaDueAt > new Date(),
      "an open complaint has a future deadline",
    );
    assert.equal(row.requestCn, false);
    assert.equal(
      row.billId,
      null,
      "no credit note asked for, so no bill attached",
    );

    const history = await db
      .select()
      .from(complaintStatusHistory)
      .where(eq(complaintStatusHistory.complaintId, row.id));
    assert.equal(
      history.length,
      1,
      "opening the complaint is itself a history line",
    );
    assert.equal(history[0].toStatus, "open");
  });

  test("a credit-note request is a yes, and needs no bill behind it", async () => {
    // The telecaller answers whether the customer asked for one. Which bill
    // and how much are accounts' work — they hold the ledger, and a bill
    // picked mid-call was as likely to be the wrong one as the right one.
    const customer = await makeCustomer(priya.id);
    const { logComplaint } = await import("@/lib/actions/crm");

    const result = await logComplaint({
      customerId: customer.id,
      category: "Packaging",
      description: "Short supply, wants a credit note",
      requestCn: true,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const [row] = await db
      .select()
      .from(complaints)
      .where(eq(complaints.customerId, customer.id));
    assert.equal(row.requestCn, true);
    assert.equal(row.billId, null);
    // It has somewhere to go: the pending list is what accounts read.
    const { pendingCreditNotes } = await import("@/lib/queries");
    const pending = await pendingCreditNotes();
    assert.ok(
      pending.some((c) => c.complaintId === row.id),
      "a request with no bill fell off the pending list",
    );
  });

  test("a bill named on a request is still stored, for whoever fills it in", async () => {
    const customer = await makeCustomer(priya.id);
    const [bill] = await db
      .insert(bills)
      .values({
        id: id("bil"),
        customerId: customer.id,
        billNo: `MMI/${randomUUID().slice(0, 6)}`,
        billDate: addDays(TODAY, -10),
        dueDate: addDays(TODAY, 20),
        amount: 40_000_00,
        paidAmount: 0,
      })
      .returning();

    const { logComplaint } = await import("@/lib/actions/crm");
    const ok_ = await logComplaint({
      customerId: customer.id,
      category: "Product Complaint",
      description: "Batch was off-spec",
      requestCn: true,
      billId: bill.id,
      goodsDescription: "NC thinner 20L x 4",
    });
    assert.equal(ok_.ok, true, ok_.ok ? "" : ok_.error);

    const [row] = await db
      .select()
      .from(complaints)
      .where(eq(complaints.customerId, customer.id));
    assert.equal(row.requestCn, true);
    assert.equal(row.billId, bill.id);
    assert.equal(row.goodsDescription, "NC thinner 20L x 4");
  });

  test("the category list is configuration, so a manager can change it", async () => {
    const before = (await getConfig())["complaints.categories"];
    assert.ok(
      before.includes("Packaging"),
      "ships with Mahek's own vocabulary",
    );

    const changed = await updateSetting(
      "complaints.categories",
      ["Packaging", "Transport", "Other"],
      manager.id,
    );
    assert.equal(changed.ok, true);
    assert.deepEqual((await getConfig())["complaints.categories"], [
      "Packaging",
      "Transport",
      "Other",
    ]);
  });
});

/* ------------------- journey 8: interactions, and the three hazards */

describe("Journey 8 - the interaction log", () => {
  async function firstProduct() {
    const [p] = await db.select().from(productsTable).limit(1);
    return p;
  }

  test("No Answer moves last CALL but never last CONTACT", async () => {
    const customer = await makeCustomer(priya.id, {
      lastContactDate: addDays(TODAY, -40),
      lastCallDate: addDays(TODAY, -40),
    });

    const r = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_answer",
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(row.lastCallDate, TODAY, "we did dial them");
    assert.equal(
      row.lastContactDate,
      addDays(TODAY, -40),
      "a ringing phone is not contact - the check-in timer must not reset",
    );
  });

  test("Order Received is not a call: attempted, connected and missed all ignore it", async () => {
    const customer = await makeCustomer(priya.id);
    const product = await firstProduct();

    const r = await saveInteraction({
      customerId: customer.id,
      interactionType: "order_received",
      productQuantities: { [product.id]: 4 },
      orderDate: TODAY,
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const { eodMetricsFor } = await import("@/lib/services/eod-service");
    const m = await eodMetricsFor(priya.id, TODAY);
    assert.equal(m.callsAttempted, 0, "nobody spoke to anybody");
    assert.equal(m.callsConnected, 0);
    assert.equal(m.callsMissed, 0);
    assert.equal(
      m.ordersWithoutCall,
      1,
      "but it is real work and counted separately",
    );
  });

  test("a backdated Order Received uses the entered date, not the log timestamp", async () => {
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -30),
    });
    const product = await firstProduct();
    const friday = addDays(TODAY, -3);

    await saveInteraction({
      customerId: customer.id,
      interactionType: "order_received",
      productQuantities: { [product.id]: 2 },
      orderDate: friday,
      idempotencyKey: randomUUID(),
    });

    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(
      row.lastOrderDate,
      friday,
      "the date they entered is the order date",
    );
  });

  test("a backdated order older than the last one does not drag it backwards", async () => {
    const recent = addDays(TODAY, -2);
    const customer = await makeCustomer(priya.id, { lastOrderDate: recent });
    const product = await firstProduct();

    // A real order behind the date — last order is derived from the order
    // book, so the fixture has to be one the recompute can rebuild.
    await db.insert(orders).values({
      id: id("ord"),
      customerId: customer.id,
      userId: priya.id,
      orderedAt: new Date(`${recent}T09:00:00+05:30`),
      totalAmount: 25_000_00,
      status: "confirmed",
    });

    await saveInteraction({
      customerId: customer.id,
      interactionType: "order_received",
      productQuantities: { [product.id]: 1 },
      orderDate: addDays(TODAY, -20),
      idempotencyKey: randomUUID(),
    });

    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(row.lastOrderDate, recent, "last order never moves backwards");
  });

  test("an outcome from the wrong set is refused", async () => {
    const customer = await makeCustomer(priya.id);
    const wrong = await saveInteraction({
      customerId: customer.id,
      interactionType: "inbound_call",
      outcome: "no_answer",
      idempotencyKey: randomUUID(),
    });
    assert.equal(wrong.ok, false, "nobody rings us and then does not answer");
    assert.match(wrong.error, /outcome/i);
  });

  test("a complaint raised on a call we made is raised the same way", async () => {
    const customer = await makeCustomer(priya.id);

    const r = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "complaint",
      complaintCategory: "packaging_damage",
      notes: "Two drums arrived dented",
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.ok(r.data.complaintId, "the complaint exists, not just the note");

    const [{ n }] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from complaints where customer_id = ${customer.id}
    `);
    assert.equal(Number(n), 1);
  });

  test("a complaint raised on a call carries its credit-note request", async () => {
    const customer = await makeCustomer(priya.id);
    const billId = id("bil");
    await db.insert(bills).values({
      id: billId,
      customerId: customer.id,
      billNo: `MMI/${randomUUID().slice(0, 6)}`,
      billDate: addDays(TODAY, -10),
      dueDate: addDays(TODAY, 20),
      amount: 40_000_00,
      paidAmount: 0,
    });

    const r = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "complaint",
      complaintCategory: "shortage",
      complaintDescription: "Two drums short against the last consignment",
      complaintRequestCn: true,
      complaintBillId: billId,
      complaintGoodsDescription: "20L NC Thinner × 10",
      notes: "Rang about the next order, this came up",
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const [row] = await db
      .select()
      .from(complaints)
      .where(eq(complaints.id, r.data.complaintId!));
    assert.equal(row.requestCn, true);
    assert.equal(row.billId, billId);
    assert.equal(row.goodsDescription, "20L NC Thinner × 10");
    assert.equal(
      row.description,
      "Two drums short against the last consignment",
      "the resolver reads the complaint, not the call note",
    );
  });

  test("follow-up needs a date; inbound payment promise needs one; outbound does not", async () => {
    const customer = await makeCustomer(priya.id);

    const noDate = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "follow_up",
      idempotencyKey: randomUUID(),
    });
    assert.equal(noDate.ok, false);
    assert.equal(noDate.fieldErrors?.[0].field, "followUpDate");

    const past = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "follow_up",
      followUpDate: addDays(TODAY, -1),
      idempotencyKey: randomUUID(),
    });
    assert.equal(past.ok, false, "a reminder in the past would never be seen");

    const inbound = await saveInteraction({
      customerId: customer.id,
      interactionType: "inbound_call",
      outcome: "payment_promised",
      idempotencyKey: randomUUID(),
    });
    assert.equal(inbound.ok, false);
    assert.equal(inbound.fieldErrors?.[0].field, "paymentPromiseDate");

    const outbound = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "payment_promised",
      idempotencyKey: randomUUID(),
    });
    assert.equal(outbound.ok, true, "outbound may promise without a date");
  });

  test("quick notes are stored as references and accumulate in the text", async () => {
    const customer = await makeCustomer(priya.id);
    const chips = await db
      .select()
      .from(quickNotesTable)
      .where(
        sql`${quickNotesTable.interactionType} = 'outbound_call'
            and ${quickNotesTable.outcome} = 'no_order'`,
      )
      .limit(2);
    assert.equal(chips.length, 2, "the seeded lists must be there");

    const r = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      // No date was recorded on these calls, which is now said explicitly.
      noOrderNoCommitment: true,
      notes: `${chips[0].label} ${chips[1].label}`,
      quickNoteIds: [chips[0].id, chips[1].id],
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const [row] = await db
      .select()
      .from(calls)
      .where(eq(calls.customerId, customer.id));
    assert.deepEqual(
      row.quickNoteIds.sort(),
      [chips[0].id, chips[1].id].sort(),
      "the identifiers are what makes them analysable - free text cannot be",
    );

    const [used] = await db
      .select()
      .from(quickNotesTable)
      .where(eq(quickNotesTable.id, chips[0].id));
    assert.equal(used.usageCount, 1);
  });

  test("a quick note from another outcome is refused", async () => {
    const customer = await makeCustomer(priya.id);
    const [foreign] = await db
      .select()
      .from(quickNotesTable)
      .where(sql`${quickNotesTable.interactionType} = 'order_received'`)
      .limit(1);

    const r = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      // No date was recorded on these calls, which is now said explicitly.
      noOrderNoCommitment: true,
      quickNoteIds: [foreign.id],
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /does not belong/i);
  });

  test("Order Taken with no quantities is refused, and with them writes lines", async () => {
    const customer = await makeCustomer(priya.id);
    const product = await firstProduct();

    const empty = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "order_taken",
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      empty.ok,
      false,
      "an order with nothing ordered is not an order",
    );

    const r = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "order_taken",
      productQuantities: { [product.id]: 3 },
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const lines = await db
      .select()
      .from(interactionProductLines)
      .where(eq(interactionProductLines.interactionId, r.data.interactionId));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].quantity, 3);

    // Rates are not held yet, so the order saves quantities and a zero value.
    assert.ok(
      r.warnings?.some((w) => /rates/i.test(w)),
      "the missing-rate problem must be surfaced, not silent",
    );
  });

  test("an inbound complaint on an existing open one updates rather than duplicates", async () => {
    const customer = await makeCustomer(priya.id);

    const first = await saveInteraction({
      customerId: customer.id,
      interactionType: "inbound_call",
      outcome: "complaint",
      complaintCategory: "delivery",
      notes: "Consignment short by two drums",
      idempotencyKey: randomUUID(),
    });
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    assert.equal(first.data.complaintUpdated, false);

    const again = await saveInteraction({
      customerId: customer.id,
      interactionType: "inbound_call",
      outcome: "complaint",
      complaintCategory: "delivery",
      notes: "Still not resolved",
      idempotencyKey: randomUUID(),
    });
    assert.equal(again.ok, true, again.ok ? "" : again.error);
    assert.equal(again.data.complaintUpdated, true, "one complaint, not two");
    assert.equal(again.data.complaintId, first.data.complaintId);

    const [{ n }] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from complaints where customer_id = ${customer.id}
    `);
    assert.equal(Number(n), 1);
  });

  test("a call payment attempt on a stage-1 customer saves but warns", async () => {
    const customer = await makeCustomer(priya.id);
    await db.insert(bills).values({
      id: id("bil"),
      customerId: customer.id,
      billNo: `MMI/${randomUUID().slice(0, 6)}`,
      billDate: addDays(TODAY, -40),
      dueDate: addDays(TODAY, -10),
      amount: 60_000_00,
      paidAmount: 0,
    });
    await recomputeOutstanding(customer.id);
    await recomputeFollowUpState(customer.id);

    const r = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "payment_promised",
      paymentPromiseDate: addDays(TODAY, 3),
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, "the interaction is still recorded");
    assert.ok(
      r.warnings?.some((w) => /stage 1/i.test(w)),
      "the stage rule must not be broken silently",
    );

    const attempts = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from follow_up_attempts where customer_id = ${customer.id}
    `);
    assert.equal(Number(attempts[0].n), 0, "no stage-1 attempt was recorded");
  });
});

/* ------------------------- journey 9: the information tab (§7) */

describe("Journey 9 - the Information tab", () => {
  test("last call ignores Order Received, because that was not a call", async () => {
    const customer = await makeCustomer(priya.id);
    const [product] = await db.select().from(productsTable).limit(1);
    const { customerInformation } =
      await import("@/lib/services/customer-info-service");

    await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      // No date was recorded on these calls, which is now said explicitly.
      noOrderNoCommitment: true,
      idempotencyKey: randomUUID(),
    });
    await saveInteraction({
      customerId: customer.id,
      interactionType: "order_received",
      productQuantities: { [product.id]: 5 },
      orderDate: TODAY,
      idempotencyKey: randomUUID(),
    });

    const info = await customerInformation(customer.id);
    assert.ok(info);
    // They have ordered, so the purchase section is present. On a lead it is
    // null, and the type makes every caller say which it expects.
    assert.ok(info.purchase);
    assert.equal(info.purchase.lastCallDate, TODAY, "the call counts");
    assert.equal(
      info.recentCalls.length,
      1,
      "the order does not appear under Last 3 calls",
    );
    assert.equal(info.recentCalls[0].outcome, "no_order");
  });

  test("next order date is last order plus their own cycle", async () => {
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -10),
      cycleDays: 21,
      cycleIsDefault: false,
    });
    const { customerInformation } =
      await import("@/lib/services/customer-info-service");

    const info = await customerInformation(customer.id);
    assert.ok(info);
    assert.ok(info.purchase);
    assert.equal(info.purchase.nextOrderDate, addDays(TODAY, 11));
    assert.equal(info.purchase.lastOrderDaysAgo, 10);
    assert.equal(
      info.purchase.cycleIsDefault,
      false,
      "a real cycle, not a fallback",
    );
  });

  test("a default cycle is flagged as one", async () => {
    const customer = await makeCustomer(priya.id, { cycleIsDefault: true });
    const { customerInformation } =
      await import("@/lib/services/customer-info-service");
    const info = await customerInformation(customer.id);
    assert.equal(info?.purchase?.cycleIsDefault, true);
  });

  test("run rate divides the gap over WORKING days, and survives a zero target", async () => {
    const customer = await makeCustomer(priya.id);
    const { customerInformation } =
      await import("@/lib/services/customer-info-service");

    // No target set at all — the maths must not divide by zero.
    const bare = await customerInformation(customer.id);
    assert.ok(bare);
    assert.ok(bare.monthly);
    assert.equal(bare.monthly.achievementPercent, 0);
    assert.equal(bare.monthly.gap, 0);

    // The service takes paise; only the action converts from rupees.
    setTestUser(manager);
    await setTarget(customer.id, 1_00_000_00, TODAY.slice(0, 7));
    setTestUser(priya);

    const info = await customerInformation(customer.id);
    assert.ok(info);
    assert.ok(info.monthly);
    assert.equal(info.monthly.target, 1_00_000_00);
    assert.ok(info.monthly.workingDaysRemaining > 0);
    assert.ok(
      info.monthly.workingDaysRemaining <= 31,
      "working days remaining cannot exceed the month",
    );
    // Gap spread over the working days left, not calendar days.
    assert.equal(
      info.monthly.requiredPerDay,
      Math.round(info.monthly.gap / info.monthly.workingDaysRemaining),
    );
  });

  test("credit days fall back to the configured default, and say so", async () => {
    const plain = await makeCustomer(priya.id);
    const own = await makeCustomer(priya.id, { creditDays: 45 });
    const { customerInformation } =
      await import("@/lib/services/customer-info-service");

    const a = await customerInformation(plain.id);
    assert.equal(
      a?.creditDays,
      (await getConfig())["customers.defaultCreditDays"],
    );

    const b = await customerInformation(own.id);
    assert.equal(b?.creditDays, 45, "their own term wins over the default");
  });

  test("product history comes from the CRM and is labelled as such", async () => {
    const customer = await makeCustomer(priya.id);
    const [product] = await db.select().from(productsTable).limit(1);
    const { customerInformation } =
      await import("@/lib/services/customer-info-service");

    await saveInteraction({
      customerId: customer.id,
      interactionType: "order_received",
      productQuantities: { [product.id]: 3 },
      orderDate: TODAY,
      idempotencyKey: randomUUID(),
    });

    const info = await customerInformation(customer.id);
    assert.ok(info);
    assert.equal(info.productHistory.length, 1);
    assert.equal(info.productHistory[0].totalOrderCount, 1);
    assert.equal(
      info.productHistorySource,
      "crm",
      "the ERP is not connected, and the screen must not imply it is",
    );
  });

  /* --------------------------------------------- §2 product selection */

  test("the frequent container matches the Information tab for the same customer", async () => {
    const customer = await makeCustomer(priya.id);
    const picks = await db.select().from(productsTable).limit(2);
    const { customerInformation } =
      await import("@/lib/services/customer-info-service");

    // Two orders for the first product, one for the second, so the ranking
    // has something to be wrong about.
    for (const q of [2, 3]) {
      await saveInteraction({
        customerId: customer.id,
        interactionType: "order_received",
        productQuantities: { [picks[0].id]: q },
        orderDate: TODAY,
        idempotencyKey: randomUUID(),
      });
    }
    await saveInteraction({
      customerId: customer.id,
      interactionType: "order_received",
      productQuantities: { [picks[1].id]: 1 },
      orderDate: TODAY,
      idempotencyKey: randomUUID(),
    });

    const info = await customerInformation(customer.id);
    assert.ok(info);
    assert.equal(
      info.frequentProducts[0].productId,
      picks[0].id,
      "most-ordered first",
    );
    assert.deepEqual(
      info.frequentProducts.map((f) => f.displayName),
      info.productHistory
        .slice(0, info.frequentProducts.length)
        .map((h) => h.productName),
      "one aggregation feeds both, so they cannot disagree",
    );
  });

  test("a discontinued product stays in history but leaves the order form", async () => {
    const customer = await makeCustomer(priya.id);
    const [product] = await db.select().from(productsTable).limit(1);
    const { frequentProducts, searchProducts } =
      await import("@/lib/services/product-service");

    await saveInteraction({
      customerId: customer.id,
      interactionType: "order_received",
      productQuantities: { [product.id]: 5 },
      orderDate: TODAY,
      idempotencyKey: randomUUID(),
    });
    assert.equal((await frequentProducts(customer.id)).length, 1);

    await db
      .update(productsTable)
      .set({ active: false })
      .where(eq(productsTable.id, product.id));

    assert.equal(
      (await frequentProducts(customer.id)).length,
      0,
      "a discontinued item must not be orderable",
    );
    assert.equal(
      (await searchProducts(product.name)).some(
        (r) => r.productId === product.id,
      ),
      false,
      "nor findable by search - other products may still match the words",
    );
  });

  test("search survives the way a name gets typed mid-call", async () => {
    const [product] = await db.select().from(productsTable).limit(1);
    const { searchProducts } = await import("@/lib/services/product-service");

    const exact = await searchProducts(product.name);
    assert.ok(
      exact.some((r) => r.productId === product.id),
      "an exact name must match",
    );

    // Drop a letter, the way somebody types while talking.
    const typo = product.name.slice(0, 3) + product.name.slice(4);
    const fuzzy = await searchProducts(typo);
    assert.ok(
      fuzzy.some((r) => r.productId === product.id),
      `a misspelling must still find it - searched "${typo}"`,
    );
  });

  test("an order saves identically however the product was chosen", async () => {
    const a = await makeCustomer(priya.id);
    const b = await makeCustomer(priya.id);
    const [product] = await db.select().from(productsTable).limit(1);

    // The stored record has no idea whether the telecaller tapped the
    // frequent chip or found it by searching, and it must stay that way.
    for (const customer of [a, b]) {
      await saveInteraction({
        customerId: customer.id,
        interactionType: "outbound_call",
        outcome: "order_taken",
        productQuantities: { [product.id]: 4 },
        idempotencyKey: randomUUID(),
      });
    }

    const rows = await db
      .select()
      .from(orders)
      .where(inArray(orders.customerId, [a.id, b.id]));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].source, rows[1].source);
    assert.equal(rows[0].totalAmount, rows[1].totalAmount);
  });

  /* ------------------------------------------- §3 No Order reasons */

  test("a retired No Order reason still reads back on the call that used it", async () => {
    const customer = await makeCustomer(priya.id);

    // A reason from the previous scheme, retired the way the migration
    // retires them: deactivated, never deleted.
    const [retired] = await db
      .insert(quickNotesTable)
      .values({
        id: id("qn"),
        interactionType: "outbound_call",
        outcome: "no_order",
        label: "Comparing competitor rates",
        displayOrder: 99,
        active: false,
      })
      .returning();

    const saved = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      // No date was recorded on these calls, which is now said explicitly.
      noOrderNoCommitment: true,
      quickNoteIds: [retired.id],
      notes: "Comparing competitor rates",
      idempotencyKey: randomUUID(),
    });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);

    const [call] = await db
      .select()
      .from(calls)
      .where(eq(calls.customerId, customer.id));
    assert.deepEqual(
      call.quickNoteIds,
      [retired.id],
      "the reference survives the reason being retired",
    );

    const [resolved] = await db
      .select()
      .from(quickNotesTable)
      .where(eq(quickNotesTable.id, retired.id));
    assert.equal(
      resolved.label,
      "Comparing competitor rates",
      "and it still resolves to something a human can read",
    );
  });

  test("the No Order form offers the six reasons, and only the six", async () => {
    const offered = await db
      .select()
      .from(quickNotesTable)
      .where(
        and(
          eq(quickNotesTable.outcome, "no_order"),
          eq(quickNotesTable.active, true),
        ),
      );
    assert.deepEqual(
      offered.map((n) => n.label).sort(),
      [
        "Business slow",
        "Buying elsewhere",
        "Not interested",
        "Price issue",
        "Stock sufficient",
        "Will order later",
      ],
    );
  });
});

/* --------------------------------------------------------------- timezone */

describe("The business day is Asia/Kolkata, whatever the database thinks", () => {
  test("a call at 1am IST belongs to that day, on a GMT database", async () => {
    // The client's Neon runs in GMT. Postgres casts a timestamptz to a date in
    // the SESSION zone, so a bare `started_at::date` puts a 1am IST call on the
    // previous day — and local Postgres runs in Asia/Kolkata, which hides it
    // perfectly. This test forces the session to GMT so it cannot hide.
    await db.execute(sql`set time zone 'GMT'`);
    try {
      const [row] = await db.execute<{ bare: string; zoned: string }>(sql`
        select (timestamptz '2026-08-07 20:00:00+00')::date::text as bare,
               ((timestamptz '2026-08-07 20:00:00+00')
                 at time zone 'Asia/Kolkata')::date::text as zoned
      `);

      // 20:00 UTC on the 7th is 01:30 IST on the 8th.
      assert.equal(row.bare, "2026-08-07", "this is the trap, stated plainly");
      assert.equal(
        row.zoned,
        "2026-08-08",
        "every timestamp-to-date cast in the app must look like this one",
      );
    } finally {
      await db.execute(sql`set time zone 'Asia/Kolkata'`);
    }
  });

  test("no query turns a stored timestamp into a date without saying which zone", async () => {
    // A grep, deliberately. The rule is invisible at runtime on a database
    // that happens to run in IST, so it is enforced on the source instead.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts") && !full.includes(".test.")) files.push(full);
      }
    };
    walk("src/lib");

    const TIMESTAMP_COLUMNS =
      /(started_at|ordered_at|confirmed_sent_at|attempted_at|created_at|updated_at|paid_at|copied_at)\s*\)?::date/;

    const offenders: string[] = [];
    for (const file of files) {
      for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const code = line.trim();
        // Prose describing the rule is not a breach of it.
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
        if (line.includes("time zone")) continue;
        if (TIMESTAMP_COLUMNS.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "cast these through `at time zone 'Asia/Kolkata'` — see APP_TIMEZONE",
    );
  });

  test("no query turns a stored DATE into an instant without saying which zone", async () => {
    /*
     * The same rule, read backwards. The two guards beside this one watch
     * timestamps being turned into dates; this watches dates being turned
     * into timestamps, which is the direction that produced a bill whose
     * instant depended on which pooled connection served it — and therefore a
     * timeline that could not be paged and a time on screen that moved.
     */
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts") && !full.includes(".test.")) files.push(full);
      }
    };
    walk("src/lib");

    // The date columns that reach a timeline or a sort. A cast on any of them
    // has to say which midnight it means.
    const DATE_COLUMNS = /(bill_date|received_at|due_date|order_date|day)\s*\)?::timestamptz/;

    const offenders: string[] = [];
    for (const file of files) {
      for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("--")) continue;
        if (line.includes("time zone")) continue;
        if (DATE_COLUMNS.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "cast these as `::timestamp at time zone ${APP_TIMEZONE}` — a bare cast is evaluated in the session's zone",
    );
  });

  test("no JavaScript turns a stored timestamp into a date without saying which zone", async () => {
    // The same rule, the other spelling. `toISOString()` answers in UTC, so
    // `.slice(0, 10)` on it dates a 2am IST row to the previous day — and it
    // hides even better than the SQL version, because it is wrong on every
    // machine equally and so never looks like a timezone bug. It reached the
    // buying cycle, where the dates it produced became the intervals a
    // customer's whole calling schedule is derived from.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (
          (full.endsWith(".ts") || full.endsWith(".tsx")) &&
          !full.includes(".test.")
        ) {
          files.push(full);
        }
      }
    };
    walk("src");

    // Only the truncation to a DAY is the bug. A full ISO timestamp is an
    // instant and carries its own zone, so it is left alone.
    const UTC_DATE = /toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/;

    const offenders: string[] = [];
    for (const file of files) {
      for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
        if (UTC_DATE.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }

    assert.deepEqual(offenders, [], "use `calendarDate()` — see APP_TIMEZONE");
  });
  test("no screen reads a stored instant as a wall clock without saying which zone", async () => {
    // The third spelling of the same rule, and the one that reached a screen.
    //
    // `getHours()` and `getDate()` answer in the zone of whichever machine is
    // asking. A page.tsx formats on the server, the server is Vercel and
    // Vercel is UTC — so every timestamp rendered server-side came out five
    // and a half hours early. An order taken at 9am read "3:30 am", which
    // looks like a machine writing rows in the night rather than a person on
    // a call, and somebody quite reasonably asked whether the app had
    // invented the row.
    //
    // Like both of its siblings it is correct on a laptop set to IST, so it
    // was right in development and wrong only in production.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (
          (full.endsWith(".ts") || full.endsWith(".tsx")) &&
          !full.includes(".test.")
        ) {
          files.push(full);
        }
      }
    };
    walk("src");

    // The local-zone getters. `getUTC*` is exempt: it names a zone, and
    // `longDate` uses it deliberately on a date-only value parsed as UTC.
    const LOCAL_GETTER =
      /\.get(Hours|Minutes|Date|Month|FullYear|Day)\s*\(\s*\)/;

    const offenders: string[] = [];
    for (const file of files) {
      for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
        if (LOCAL_GETTER.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "read it through `stamp`, `clock` or `Intl` with APP_TIMEZONE",
    );
  });
});

/* ------------------------------------------------------- order approval */

describe("An order is a customer saying yes, not the business saying yes", () => {
  async function takeOrder(customerId: string) {
    const [product] = await db.select().from(productsTable).limit(1);
    const saved = await saveInteraction({
      customerId,
      interactionType: "outbound_call",
      outcome: "order_taken",
      productQuantities: { [product.id]: 6 },
      idempotencyKey: randomUUID(),
    });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.customerId, customerId));
    return order;
  }

  test("a captured order waits for approval", async () => {
    const customer = await makeCustomer(priya.id);
    const order = await takeOrder(customer.id);
    assert.equal(order.status, "pending_approval");
    assert.equal(order.approvedAt, null);
  });

  test("the customer is not chased for an order approval has not reached yet", async () => {
    // Due to reorder, so without the capture signal they would be called.
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -40),
      lastContactDate: addDays(TODAY, -40),
      cycleDays: 20,
      cycleIsDefault: false,
    });
    await takeOrder(customer.id);

    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(
      row.lastOrderDate,
      TODAY,
      "they ordered today — nobody should ring tomorrow asking again",
    );
  });

  test("but nothing about money moves until it is approved", async () => {
    const customer = await makeCustomer(priya.id);
    await takeOrder(customer.id);

    const eod = await eodMetricsFor(priya.id, TODAY);
    assert.equal(
      eod.ordersCount,
      0,
      "a pending order is not a sale, so it is not on the day's count",
    );
    assert.equal(eod.ordersValue, 0);
  });

  test("approving makes it count, and only accounts may do it", async () => {
    const customer = await makeCustomer(priya.id);
    const order = await takeOrder(customer.id);

    // A telecaller cannot, and a manager cannot either — the person chasing
    // the target must not sign off the orders that hit it.
    setTestUser(priya);
    await assert.rejects(() => approveOrder(order.id), /not permitted|manager|accounts/i);
    setTestUser(manager);
    await assert.rejects(() => approveOrder(order.id), /not permitted|manager|accounts/i);

    setTestUser(deepa);
    const approved = await approveOrder(order.id);
    assert.equal(approved.ok, true, approved.ok ? "" : approved.error);

    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    assert.equal(after.status, "confirmed");
    assert.equal(after.approvedById, deepa.id);

    setTestUser(priya);
    const eod = await eodMetricsFor(priya.id, TODAY);
    assert.equal(eod.ordersCount, 1, "approved, so now it is a sale");
  });

  test("declining requires a reason, and the reason reaches the telecaller", async () => {
    const customer = await makeCustomer(priya.id);
    const order = await takeOrder(customer.id);

    setTestUser(deepa);
    const blank = await declineOrder(order.id, "   ");
    assert.equal(blank.ok, false, "a refusal nobody can read is not a refusal");

    const declined = await declineOrder(
      order.id,
      "Outstanding is over their limit — clear the June bills first.",
    );
    assert.equal(declined.ok, true, declined.ok ? "" : declined.error);

    setTestUser(priya);
    const timeline = await customerTimeline(customer.id);
    const entry = timeline.entries.find((t) => t.kind === "Order");
    assert.ok(entry);
    assert.match(entry.content, /declined/i);
    assert.match(
      entry.meta ?? "",
      /clear the June bills/i,
      "the telecaller has to ring back with it, so it is on the timeline",
    );
  });

  test("a declined order never counted, and the customer returns to the list", async () => {
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 20,
      cycleIsDefault: false,
    });
    const order = await takeOrder(customer.id);

    setTestUser(deepa);
    await declineOrder(order.id, "Customer disputed the last two bills.");

    setTestUser(priya);
    const eod = await eodMetricsFor(priya.id, TODAY);
    assert.equal(eod.ordersCount, 0, "it must never have counted");

    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.notEqual(
      row.lastOrderDate,
      TODAY,
      "the order was refused, so it no longer holds them out of the calling list",
    );
  });
});

/* --------------------------------------------- §6 complaints and credit notes */

describe("Complaints raised on a call we made", () => {
  test("outbound complaint fires exactly the side effects inbound does", async () => {
    const outbound = await makeCustomer(priya.id);
    const inbound = await makeCustomer(priya.id);

    const args = (customerId: string) => ({
      customerId,
      outcome: "complaint" as const,
      complaintCategory: "product_quality" as const,
      complaintDescription: "Drum arrived dented and leaking.",
      notes: "Sounded genuinely annoyed.",
      idempotencyKey: randomUUID(),
    });

    const a = await saveInteraction({ ...args(outbound.id), interactionType: "outbound_call" });
    const b = await saveInteraction({ ...args(inbound.id), interactionType: "inbound_call" });
    assert.equal(a.ok, true, a.ok ? "" : a.error);
    assert.equal(b.ok, true, b.ok ? "" : b.error);

    assert.deepEqual(
      a.ok && a.data.produced,
      b.ok && b.data.produced,
      "the same outcome must produce the same records whichever way the call went",
    );

    for (const c of [outbound, inbound]) {
      const [row] = await db.select().from(customers).where(eq(customers.id, c.id));
      assert.equal(row.lastContactDate, TODAY, "a complaint is contact");
    }
  });

  test("a credit note amount without a Yes is refused", async () => {
    const customer = await makeCustomer(priya.id);
    const result = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "complaint",
      complaintCategory: "billing_issue",
      complaintDescription: "Charged for a drum that never arrived.",
      complaintRequestCn: false,
      complaintCnAmount: 4500,
      idempotencyKey: randomUUID(),
    });

    assert.equal(result.ok, false);
    assert.match(
      result.ok ? "" : result.error,
      /credit note/i,
      "a figure with no request behind it reads as an approved amount",
    );
  });

  test("a credit note request needs no bill behind it, and still reaches accounts", async () => {
    // Mid-call, the question is whether the customer asked for a credit note.
    // Which bill and how much belong to whoever holds the ledger.
    const customer = await makeCustomer(priya.id);
    const result = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "complaint",
      complaintCategory: "billing_issue",
      complaintDescription: "Short supply against last week's bill.",
      complaintRequestCn: true,
      idempotencyKey: randomUUID(),
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const { pendingCreditNotes } = await import("@/lib/queries");
    const pending = await pendingCreditNotes();
    const raised = pending.find((c) => c.complaintId === result.data.complaintId);
    assert.ok(raised, "a request with no bill never reached the pending list");
    assert.equal(raised.billNo, null, "no bill was named, so none is claimed");
  });

  test("a raised request shows up on the manager's pending list", async () => {
    const customer = await makeCustomer(priya.id);
    const [bill] = await db
      .insert(bills)
      .values({
        id: id("bill"),
        customerId: customer.id,
        billNo: `CN-${randomUUID().slice(0, 5)}`,
        billDate: TODAY,
        amount: 500000,
        paidAmount: 0,
      })
      .returning();

    const saved = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "complaint",
      complaintCategory: "shortage",
      complaintDescription: "Two drums short on the last delivery.",
      complaintRequestCn: true,
      complaintBillId: bill.id,
      complaintCnAmount: 4500,
      idempotencyKey: randomUUID(),
    });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);

    const { pendingCreditNotes } = await import("@/lib/queries");
    const pending = await pendingCreditNotes();
    const row = pending.find((p) => p.customerId === customer.id);

    assert.ok(row, "a request with nowhere to go must still be visible");
    assert.equal(row.amount, 450000, "rupees in, paise stored");
    assert.equal(row.billNo, bill.billNo);
  });
});

/* ------------------------------------------- §5 payment follow-up changes */

describe("Retiring a follow-up response", () => {
  test("Part payment promised is no longer offered", async () => {
    const { offeredPayOutcomes } = await import(
      "@/lib/services/payment-followup-service"
    );
    assert.equal(
      offeredPayOutcomes().some((o) => o.key === "part"),
      false,
    );
    assert.equal(
      offeredPayOutcomes().length,
      6,
      "seven responses become six",
    );
  });

  test("but an attempt already recorded against it still reads correctly", async () => {
    const { payOutcome } = await import(
      "@/lib/services/payment-followup-service"
    );
    const def = payOutcome("part");
    assert.ok(def, "history must still resolve the key it was written with");
    assert.equal(def.label, "Part payment promised");
    assert.equal(def.retired, true);
  });

  test("and saving one is refused, not merely hidden", async () => {
    const customer = await makeCustomer(priya.id);
    const result = await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "part" as never,
      amount: 5000,
      date: addDays(TODAY, 2),
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      result.ok,
      false,
      "a form still offering it must be rejected server-side",
    );
  });
});

/* --------------------------------------------- §4 the attachment subsystem */

describe("Attachments — what may be attached, and what removal means", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);

  test("a file renamed .jpg is refused on its bytes, not its name", async () => {
    const { createAttachment } = await import("@/lib/services/attachment-service");

    // The extension says JPG and so does the browser. Neither is evidence.
    const result = await createAttachment({
      filename: "payment-proof.jpg",
      bytes: ZIP,
      declaredType: "image/jpeg",
    });

    assert.equal(result.ok, false);
    assert.match(
      result.ok ? "" : result.error,
      /not a JPG, PNG or PDF/i,
      "the refusal must say what is actually wrong",
    );
  });

  test("each permitted type is recognised from its signature", async () => {
    const { sniffContentType } = await import("@/lib/storage");
    assert.equal(sniffContentType(JPEG), "image/jpeg");
    assert.equal(sniffContentType(PNG), "image/png");
    assert.equal(sniffContentType(PDF), "application/pdf");
    assert.equal(sniffContentType(ZIP), null);
  });

  test("bytes survive a round trip through Postgres storage", async () => {
    const { fileStorage } = await import("@/lib/storage");
    assert.equal(
      fileStorage.kind,
      "postgres",
      "no Blob token in the test environment, so Postgres is the backend",
    );

    // A real JPEG header plus a body, so this is not just a length check.
    const original = new Uint8Array(4096);
    original.set(JPEG, 0);
    for (let i = JPEG.length; i < original.length; i++) original[i] = i % 251;

    const key = `attachments/roundtrip_${randomUUID().slice(0, 8)}`;
    const stored = await fileStorage.upload({
      key,
      body: original,
      contentType: "image/jpeg",
    });
    assert.equal(stored.sizeBytes, original.byteLength);
    assert.equal(stored.ref, key, "the reference is opaque, never a URL");

    const readBack = new Uint8Array(await fileStorage.read(stored.ref));
    assert.equal(readBack.byteLength, original.byteLength);
    assert.deepEqual(
      Array.from(readBack.slice(0, 16)),
      Array.from(original.slice(0, 16)),
      "byte for byte, not merely the same length",
    );
    assert.deepEqual(
      Array.from(readBack.slice(-16)),
      Array.from(original.slice(-16)),
      "including the tail, where a truncation would hide",
    );

    await fileStorage.remove(stored.ref);
    await assert.rejects(
      () => fileStorage.read(stored.ref),
      /missing from storage/i,
      "removing the bytes leaves nothing readable behind",
    );
  });

  test("a file over the limit is refused, and the message says by how much", async () => {
    const { createAttachment } = await import("@/lib/services/attachment-service");
    const config = await getConfig();
    const tooBig = new Uint8Array(config["attachments.maxSizeMb"] * 1024 * 1024 + 1024);
    tooBig.set(JPEG, 0);

    const result = await createAttachment({ filename: "big.jpg", bytes: tooBig });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /MB/);
  });

  test("removal detaches and marks removed, and never destroys the row", async () => {
    const { removeAttachment } = await import("@/lib/services/attachment-service");
    const [row] = await db
      .insert(attachmentsTable)
      .values({
        id: id("att"),
        parentType: "complaint",
        parentId: "cmp_whatever",
        filename: "slip.jpg",
        storedRef: "memory://slip",
        contentType: "image/jpeg",
        sizeBytes: 1024,
        status: "available",
        uploadedById: priya.id,
      })
      .returning();

    const result = await removeAttachment(row.id);
    assert.equal(result.ok, true);

    const [after] = await db
      .select()
      .from(attachmentsTable)
      .where(eq(attachmentsTable.id, row.id));
    assert.ok(after, "nothing representing a customer interaction is destroyed");
    assert.equal(after.status, "removed");
    assert.equal(after.parentId, null, "and it is detached from the complaint");
    assert.ok(after.removedAt);
  });

  test("binding stops at the configured limit rather than failing the save", async () => {
    const { bindAttachments } = await import("@/lib/services/attachment-service");
    const config = await getConfig();
    const limit = config["attachments.maxPerFollowUp"];

    const ids: string[] = [];
    for (let n = 0; n < limit + 2; n++) {
      const [row] = await db
        .insert(attachmentsTable)
        .values({
          id: id("att"),
          filename: `proof-${n}.jpg`,
          storedRef: `memory://proof-${n}`,
          contentType: "image/jpeg",
          sizeBytes: 512,
          status: "available",
          uploadedById: priya.id,
        })
        .returning();
      ids.push(row.id);
    }

    const result = await bindAttachments(ids, "follow_up_attempt", "fua_whatever");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.data.bound, limit);
    assert.equal(
      result.ok && result.data.skipped,
      2,
      "the extras are left for the sweep — the parent is already saved, so this is not an error",
    );
  });

  test("the owner can read a complaint's photograph, and another telecaller cannot", async () => {
    // canRead handed a raw snake_case row to a function reading camelCase
    // fields, with `as never` silencing the compiler — so the owner was
    // refused too and every attachment answered 404. It failed SHUT, which is
    // the safe direction and exactly why it went unnoticed: nothing in the CRM
    // had ever displayed an attachment to notice with.
    const { canRead } = await import("@/lib/services/attachment-service");
    const { bindAttachments } = await import("@/lib/services/attachment-service");

    const customer = await makeCustomer(priya.id);
    const [complaint] = await db
      .insert(complaints)
      .values({
        id: id("cmp"),
        customerId: customer.id,
        loggedByUserId: priya.id,
        category: "packaging_damage",
        description: "Drums dented in transit",
        severity: "medium",
        slaDueAt: new Date(Date.now() + 86_400_000),
      })
      .returning();

    const [file] = await db
      .insert(attachmentsTable)
      .values({
        id: id("att"),
        filename: "damage.jpg",
        storedRef: "memory://damage",
        contentType: "image/jpeg",
        sizeBytes: 512,
        status: "available",
        uploadedById: priya.id,
      })
      .returning();
    await bindAttachments([file.id], "complaint", complaint.id);

    setTestUser(priya);
    assert.equal(await canRead(file.id), true, "the owner could not read their own");

    setTestUser(manager);
    assert.equal(await canRead(file.id), true, "the manager could not read their team's");

    // And it still refuses somebody else's book, which is the point of it.
    setTestUser(rakesh);
    assert.equal(await canRead(file.id), false, "another telecaller could read it");
  });

  test("a complaint carries six photographs", async () => {
    // A short delivery gets photographed from every side, and five was one
    // short of a pallet. The limit is configuration; what this pins is that
    // the number the screens offer is the number that binds.
    const { bindAttachments } = await import("@/lib/services/attachment-service");
    const config = await getConfig();
    const limit = config["attachments.maxPerComplaint"];
    assert.equal(limit, 6);

    const ids: string[] = [];
    for (let n = 0; n < limit; n++) {
      const [row] = await db
        .insert(attachmentsTable)
        .values({
          id: id("att"),
          filename: `damage-${n}.jpg`,
          storedRef: `memory://damage-${n}`,
          contentType: "image/jpeg",
          sizeBytes: 512,
          status: "available",
          uploadedById: priya.id,
        })
        .returning();
      ids.push(row.id);
    }

    const result = await bindAttachments(ids, "complaint", "cmp_whatever");
    assert.equal(result.ok && result.data.bound, limit);
    assert.equal(result.ok && result.data.skipped, 0);
  });

  test("an abandoned form's files are swept; a bound one's are not", async () => {
    const { sweepOrphans } = await import("@/lib/services/attachment-service");
    const config = await getConfig();
    const old = new Date(
      Date.now() - (config["attachments.orphanCleanupHours"] + 1) * 60 * 60 * 1000,
    );

    const [orphan] = await db
      .insert(attachmentsTable)
      .values({
        id: id("att"),
        filename: "abandoned.jpg",
        storedRef: "memory://abandoned",
        contentType: "image/jpeg",
        sizeBytes: 256,
        status: "available",
        uploadedById: priya.id,
        uploadedAt: old,
      })
      .returning();

    const [bound] = await db
      .insert(attachmentsTable)
      .values({
        id: id("att"),
        parentType: "complaint",
        parentId: "cmp_kept",
        filename: "kept.jpg",
        storedRef: "memory://kept",
        contentType: "image/jpeg",
        sizeBytes: 256,
        status: "available",
        uploadedById: priya.id,
        uploadedAt: old,
      })
      .returning();

    await sweepOrphans();

    const [afterOrphan] = await db
      .select()
      .from(attachmentsTable)
      .where(eq(attachmentsTable.id, orphan.id));
    const [afterBound] = await db
      .select()
      .from(attachmentsTable)
      .where(eq(attachmentsTable.id, bound.id));

    assert.equal(afterOrphan.status, "removed", "nothing ever pointed at it");
    assert.equal(
      afterBound.status,
      "available",
      "a file on a real complaint is not an orphan, however old",
    );
  });
});

/* ------------------------------------------------ the calling rules, end to end */

describe("Who the Call Log puts in front of a telecaller", () => {
  test("no order is chased inside the quiet window", async () => {
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -6),
      lastContactDate: addDays(TODAY, -1),
      cycleDays: 8,
      cycleIsDefault: false,
    });
    const q = await getQueue();
    assert.equal(
      q.entries.some((e) => e.customerId === customer.id),
      false,
      "they order every 8 days on their own - asking for an order adds nothing",
    );
  });

  test("and a fast-cycling customer gets no check-in either", async () => {
    // They are in contact constantly through the orders themselves, so a
    // weekly call on top is noise on both sides of the phone. Not suppressed
    // either: two days after an order there is simply nothing to call them
    // about, which is a different thing from being held back.
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -2),
      lastContactDate: addDays(TODAY, -9),
      cycleDays: 8,
      cycleIsDefault: false,
    });
    const q = await getQueue();
    assert.equal(
      q.entries.some((e) => e.customerId === customer.id),
      false,
    );
    assert.equal(
      q.suppressed.some((x) => x.customerId === customer.id),
      false,
    );
  });

  test("and comes back the moment they stop ordering", async () => {
    // The other half of the same rule, and the reason dropping the check-in
    // does not lose them: out of the quiet window, the order reasons apply.
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -20),
      lastContactDate: addDays(TODAY, -9),
      cycleDays: 8,
      cycleIsDefault: false,
    });
    const q = await getQueue();
    const entry = q.entries.find((e) => e.customerId === customer.id);
    assert.ok(entry, "an 8-day buyer 20 days silent is exactly who to ring");
    assert.ok(
      entry.reasons.some((r) => r.kind.startsWith("order")),
      "and the reason is the order, not a check-in",
    );
  });

  test("a short-cycle customer past their due date is CALLED, not held to day 15", async () => {
    // The flat fifteen-day window used to run past the due date of anybody who
    // reorders faster than that. An eight-day buyer twelve days out was four
    // days late and silent for three more — the customers ordering most often
    // chased last, and real orders lost. The window is capped at their cycle.
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -12),
      // Contacted yesterday, so no check-in could carry them onto the list —
      // the order reason is doing this on its own.
      lastContactDate: addDays(TODAY, -1),
      cycleDays: 8,
      cycleIsDefault: false,
    });
    const q = await getQueue();
    assert.equal(
      q.suppressed.some((x) => x.customerId === customer.id),
      false,
      "not held back",
    );
    const entry = q.entries.find((e) => e.customerId === customer.id);
    assert.ok(entry, "four days past an eight-day cycle is exactly who to ring");
    assert.ok(entry.reasons.some((r) => r.kind.startsWith("order")));
  });

  test("a stock check inside the quiet window is held back visibly", async () => {
    // Sixteen days, twelve out: 70% of 16 is 11, so the stock check has come
    // due and the window still has three days to run. The one shape that
    // produces the held-back sentence now that the window cannot outlast a
    // customer's own due date.
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -12),
      lastContactDate: addDays(TODAY, -1),
      cycleDays: 16,
      cycleIsDefault: false,
    });
    const q = await getQueue();
    assert.equal(
      q.entries.some((e) => e.customerId === customer.id),
      false,
    );
    const held = q.suppressed.find((x) => x.customerId === customer.id);
    assert.ok(held, "held back customers are shown, never silently dropped");
    assert.match(held.reason, /no order chased for/);
  });

  test("a 22-day cycle gets its stock check on day 15, not day 14", async () => {
    // 70% of the customer's own cycle. It was day 18 — a lead of capped days
    // worked backwards from the due date, which gave the longest cycles the
    // shortest notice.
    const early = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -14),
      cycleDays: 22,
      cycleIsDefault: false,
    });
    const due = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -15),
      cycleDays: 22,
      cycleIsDefault: false,
    });
    const q = await getQueue();
    assert.equal(
      q.entries.some((e) => e.customerId === early.id),
      false,
    );
    assert.ok(q.entries.some((e) => e.customerId === due.id));
  });

  test("saying no does not put the same customer back tomorrow", async () => {
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      cycleIsDefault: false,
    });

    const before = await getQueue();
    assert.ok(
      before.entries.some((e) => e.customerId === customer.id),
      "past their call day, so they start on the list",
    );

    const saved = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      // No date was recorded on these calls, which is now said explicitly.
      noOrderNoCommitment: true,
      notes: "Still has stock",
      sourceModule: "call_queue",
      idempotencyKey: "j-no-order-1",
    });
    assert.ok(saved.ok, JSON.stringify(saved));

    // "Already called today" would mask the cooldown, and it expires at
    // midnight. Turning it off is how this test asks the question it means:
    // what holds them back TOMORROW.
    await updateSetting("queue.excludeCalledToday", false, manager.id);
    const after = await getQueue();
    assert.equal(
      after.entries.some((e) => e.customerId === customer.id),
      false,
    );
    const held = after.suppressed.find((x) => x.customerId === customer.id);
    assert.ok(held, "and the telecaller can see why");
    assert.match(held.reason, /asking again in/);
  });

  test("a promised callback beats both the quiet window and the cooldown", async () => {
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -1),
      cycleDays: 8,
      cycleIsDefault: false,
    });
    const saved = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "follow_up",
      followUpDate: TODAY,
      notes: "Asked us to ring back today about the rate",
      sourceModule: "call_queue",
      idempotencyKey: "j-followup-1",
    });
    assert.ok(saved.ok, JSON.stringify(saved));

    // Same reason as above: they were called a moment ago, and that rule is
    // not the one under test.
    await updateSetting("queue.excludeCalledToday", false, manager.id);
    const q = await getQueue();
    assert.ok(
      q.entries.some((e) => e.customerId === customer.id),
      "a promise the telecaller made outranks leaving a good customer alone",
    );
  });

  test("a lead shows no purchase cycle, no target and no run rate", async () => {
    // Zeroes on a record that has never ordered read as a customer performing
    // badly. The sections are absent, not empty.
    const lead = await makeCustomer(priya.id, {
      kind: "lead",
      leadSource: "Exhibition, Nashik",
      salesAmId: null,
      lastOrderDate: null,
    });
    const { customerInformation } =
      await import("@/lib/services/customer-info-service");
    const info = await customerInformation(lead.id);
    assert.ok(info);
    assert.equal(info.kind, "lead");
    assert.equal(info.purchase, null, "a lead has no buying cycle");
    assert.equal(info.monthly, null, "and no monthly target to be short of");
    assert.equal(info.lead?.source, "Exhibition, Nashik");
    assert.equal(
      info.accountManagers,
      null,
      "account managers are for customers",
    );
  });

  test("adding from the Customers screen creates a lead, not a customer", async () => {
    const { createCustomer } = await import("@/lib/actions/crm");
    const result = await createCustomer({
      name: "Konkan Paints",
      contactPerson: "Sameer Joshi",
      phone: "9812345678",
      city: "Ratnagiri",
      leadSource: "Exhibition",
    });
    assert.ok(result.ok, JSON.stringify(result));

    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, result.data.id));
    assert.equal(row.kind, "lead", "nobody is a customer until they order");
    assert.equal(row.leadSource, "Exhibition");
    assert.equal(
      row.salesAmId,
      null,
      "no account manager for an account that does not exist",
    );
    assert.equal(row.customerSince, null);
  });

  test("only a manager can set the back office account manager", async () => {
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -10),
    });
    const { updateCustomer } = await import("@/lib/actions/crm");

    // Priya is a telecaller. The form disables the field; the action refuses it.
    const refusedForTelecaller = await updateCustomer(customer.id, {
      backOfficeAmId: rakesh.id,
    });
    assert.equal(refusedForTelecaller.ok, false, "a disabled input is not a permission check");

    /*
     * AND IT IS REFUSED FOR A MANAGER TOO, which is the part that changed.
     *
     * This used to let a manager write `back_office_am_id` straight through
     * the customer form. That is a reassignment by another name, and it took
     * none of the things a reassignment takes: no `customer.reassign`
     * capability — deliberately accounts' and admin's — no reason, no history,
     * nobody notified, and no `am_decided_at`, so the next sheet sync put the
     * old answer back and the change silently came undone.
     *
     * One door: `updateAccountManagers`.
     */
    setTestUser(manager);
    const refusedForManager = await updateCustomer(customer.id, {
      backOfficeAmId: rakesh.id,
    });
    assert.equal(refusedForManager.ok, false, "the second door is still open");
    setTestUser(priya);
    const [afterManager] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(afterManager.backOfficeAmId, null, "and it wrote anyway");

    // The one path that does move it records everything about the move.
    setTestUser(deepa);
    const moved = await updateAccountManagers({
      customerIds: [customer.id],
      backOffice: { kind: "user", userId: rakesh.id },
      backOfficeReason: { reasonCode: "Salesperson left" },
    });
    assert.equal(moved.ok, true);
    const [afterAccounts] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(afterAccounts.backOfficeAmId, rakesh.id);
    assert.ok(afterAccounts.amDecidedAt, "and marked it so the sheet leaves it alone");
    setTestUser(priya);
  });

  test("a lead becomes a customer the moment it orders", async () => {
    const lead = await makeCustomer(priya.id, {
      kind: "lead",
      leadSource: "Walk-in",
      salesAmId: null,
      lastOrderDate: null,
    });
    const [product] = await db.select().from(productsTable).limit(1);

    const saved = await saveInteraction({
      customerId: lead.id,
      interactionType: "outbound_call",
      outcome: "order_taken",
      productQuantities: { [product.id]: 4 },
      idempotencyKey: randomUUID(),
    });
    assert.ok(saved.ok, JSON.stringify(saved));

    const [after] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, lead.id));
    assert.equal(
      after.kind,
      "customer",
      "ordering IS the definition of a customer",
    );
    assert.equal(
      after.salesAmId,
      priya.id,
      "whoever found them runs the account",
    );
    assert.equal(
      after.backOfficeAmId,
      null,
      "back office is a decision, not a guess on first order",
    );

    // And the Information tab stops hiding the purchase history it just began.
    const { customerInformation } =
      await import("@/lib/services/customer-info-service");
    const info = await customerInformation(lead.id);
    assert.ok(
      info?.purchase,
      "the purchase section appears once they have ordered",
    );
  });

  test("a lead is scoped by its owner, a customer by its sales account manager", async () => {
    const lead = await makeCustomer(priya.id, {
      kind: "lead",
      salesAmId: null,
      lastOrderDate: null,
      lastContactDate: addDays(TODAY, -9),
    });
    // Owned by Rakesh on paper, but Priya runs the account.
    const customer = await makeCustomer(rakesh.id, {
      salesAmId: priya.id,
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      cycleIsDefault: false,
    });

    const q = await getQueue();
    assert.ok(
      q.entries.some((e) => e.customerId === lead.id),
      "the lead answers to its owner",
    );
    assert.ok(
      q.entries.some((e) => e.customerId === customer.id),
      "the customer answers to its sales account manager, not its owner",
    );
  });

  test("a customer who has never ordered is worked as a prospect", async () => {
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: null,
      lastContactDate: addDays(TODAY, -4),
    });
    const q = await getQueue();
    const entry = q.entries.find((e) => e.customerId === customer.id);
    assert.ok(
      entry,
      "never-ordered customers are the growth work, not an omission",
    );
    assert.equal(entry.reasons[0].kind, "prospect");
  });
});

/* ------------------------------------ cross-cutting: config, idempotency, audit */

describe("Cross-cutting rules", () => {
  test("a threshold change takes effect on the next read, with no restart", async () => {
    // The check-in interval governs customers whose cycle could NOT be
    // measured, so that is what this exercises. The last order is well past
    // the quiet window, or the customer would be held back for that instead.
    const customer = await makeCustomer(priya.id, {
      lastContactDate: addDays(TODAY, -10),
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 90,
      cycleIsDefault: true,
    });

    await updateSetting("queue.checkInIntervalDays", 30, manager.id);
    const quiet = await getQueue();
    assert.equal(
      quiet.entries.some((e) => e.customerId === customer.id),
      false,
      "ten days is not yet a thirty-day check-in",
    );

    await updateSetting("queue.checkInIntervalDays", 7, manager.id);
    const busy = await getQueue();
    assert.ok(
      busy.entries.some((e) => e.customerId === customer.id),
      "lowering the interval must bring them straight back",
    );
  });

  test("an out-of-range setting is refused with the bound in the message", async () => {
    const result = await updateSetting(
      "queue.checkInIntervalDays",
      4000,
      manager.id,
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /365/);
  });

  test("the same call submitted twice is logged once", async () => {
    const customer = await makeCustomer(priya.id);
    const key = randomUUID();

    const input = {
      customerId: customer.id,
      interactionType: "outbound_call" as const,
      outcome: "no_order" as const,
      notes: "Asked us to call back next week",
      // The note says they asked for next week, so the date is recorded.
      noOrderNextCallDate: addDays(TODAY, 7),
      sourceModule: "call_queue" as const,
      idempotencyKey: key,
    };

    const first = await saveInteraction(input);
    const second = await saveInteraction(input);
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    assert.equal(second.ok, true, second.ok ? "" : second.error);
    assert.equal(
      first.data.interactionId,
      second.data.interactionId,
      "a retried submit must return the original, not create a second",
    );

    const [row] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from calls where customer_id = ${customer.id}
    `);
    assert.equal(Number(row.n), 1);
  });

  test("logging a call updates last contact, so the queue stops offering them", async () => {
    const customer = await makeCustomer(priya.id, {
      lastContactDate: addDays(TODAY, -90),
      lastOrderDate: addDays(TODAY, -90),
      cycleDays: 30,
      cycleIsDefault: false,
    });

    assert.ok(
      (await getQueue()).entries.some((e) => e.customerId === customer.id),
    );

    const logged = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      // No date was recorded on these calls, which is now said explicitly.
      noOrderNoCommitment: true,
      notes: "Will confirm quantities tomorrow",
      idempotencyKey: randomUUID(),
    });
    assert.equal(logged.ok, true, logged.ok ? "" : logged.error);

    const queue = await getQueue();
    assert.equal(
      queue.entries.some((e) => e.customerId === customer.id),
      false,
      "somebody called today is not offered again today",
    );
    const held = queue.suppressed.find((s) => s.customerId === customer.id);
    assert.ok(held);
    assert.match(held.reason, /already called today/i);
  });
});

/* ------------------------------------- journey: the payment follow-up cycle */

describe("The payment follow-up cycle - term, quiet window, messages, calls", () => {
  /**
   * A bill with no due date of its own, so what governs it is the term agreed
   * when the order was taken.
   */
  async function orderedThenBilled(
    creditDays: number,
    billedDaysAgo: number,
    over: Partial<typeof customers.$inferInsert> = {},
  ) {
    const customer = await makeCustomer(priya.id, over);
    await db.insert(orders).values({
      id: id("ord"),
      customerId: customer.id,
      userId: priya.id,
      orderedAt: new Date(`${addDays(TODAY, -billedDaysAgo)}T06:00:00+05:30`),
      totalAmount: 1_00_000_00,
      status: "confirmed",
      creditDays,
      paymentDueDate: addDays(TODAY, -billedDaysAgo + creditDays),
    });
    await db.insert(bills).values({
      id: id("bil"),
      customerId: customer.id,
      billNo: `MMI/${randomUUID().slice(0, 6)}`,
      billDate: addDays(TODAY, -billedDaysAgo),
      dueDate: null,
      amount: 1_00_000_00,
      paidAmount: 0,
    });
    await recomputeBillStatuses();
    await recomputeOutstanding(customer.id);
    await recomputeFollowUpState(customer.id);
    return customer;
  }

  test("the bill takes its due date from the term agreed on the order", async () => {
    // 45 days agreed, billed 50 days ago: five days overdue, not twenty as the
    // 30-day configured default would have made it.
    const customer = await orderedThenBilled(45, 50);

    const [state] = await db
      .select()
      .from(followUpStates)
      .where(eq(followUpStates.customerId, customer.id));
    assert.ok(state, "an overdue bill must put the customer on the worklist");
    assert.equal(state.daysOverdue, 5);
    assert.equal(state.oldestOverdueBillDate, addDays(TODAY, -5));
  });

  test("an order inherits the customer's standing term, not one typed on the call", async () => {
    const customer = await makeCustomer(priya.id, { creditDays: 15 });
    const [product] = await db.select().from(productsTable).limit(1);

    const saved = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "order_taken",
      productQuantities: { [product.id]: 4 },
      idempotencyKey: randomUUID(),
    });
    assert.equal(saved.ok, true);

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.customerId, customer.id));
    assert.equal(
      order.creditDays,
      15,
      "the term is no longer agreed call by call - it comes from the customer",
    );
    assert.equal(order.paymentDueDate, addDays(TODAY, 15));
  });

  test("a customer with no term of their own falls back to the configured one", async () => {
    const customer = await makeCustomer(priya.id, { creditDays: null });
    const [product] = await db.select().from(productsTable).limit(1);

    await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "order_taken",
      productQuantities: { [product.id]: 1 },
      idempotencyKey: randomUUID(),
    });

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.customerId, customer.id));
    assert.equal(
      order.creditDays,
      (await getConfig())["customers.defaultCreditDays"],
      "a bill still resolves a due date; only the telecaller's override is gone",
    );
  });

  test("inside the quiet window they are messaged, never called", async () => {
    // Billed 36 days ago on 30-day terms: six days overdue.
    const customer = await orderedThenBilled(30, 36);

    const plan = await getPaymentFollowUpPlan();
    assert.ok(
      plan.messages.some((m) => m.customerId === customer.id),
      "six days overdue is past the four-day reminder interval",
    );
    assert.equal(
      plan.calls.some((c) => c.customerId === customer.id),
      false,
      "nobody is called inside the quiet window",
    );

    const held = plan.heldBack.find(
      (h) => h.customerId === customer.id && h.channel === "call",
    );
    assert.ok(
      held,
      "a customer kept off the calling list must be accounted for",
    );
    assert.match(held.reason, /messages only until/);
  });

  test("the day the quiet window closes, the calling list picks them up", async () => {
    // Sixteen days overdue: the first calling day.
    const customer = await orderedThenBilled(30, 46);

    const plan = await getPaymentFollowUpPlan();
    const due = plan.calls.find((c) => c.customerId === customer.id);
    assert.ok(due, "day sixteen is the first day a payment call is due");
    assert.equal(due.daysOverdue, 16);
    assert.equal(due.phase, "calling");

    // And the call the list offers is one the server will actually accept.
    const attempt = await recordFollowUpAttempt({
      customerId: customer.id,
      channel: "call",
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      attempt.ok,
      true,
      `the calling list must never offer a call the rules refuse: ${attempt.ok ? "" : attempt.error}`,
    );
  });

  test("a logged call rests them, and the rest is visible rather than silent", async () => {
    const customer = await orderedThenBilled(30, 46);
    await recordFollowUpAttempt({
      customerId: customer.id,
      channel: "call",
      idempotencyKey: randomUUID(),
    });

    const plan = await getPaymentFollowUpPlan();
    assert.equal(
      plan.calls.some((c) => c.customerId === customer.id),
      false,
      "a customer called today does not return to the list today",
    );
    assert.ok(
      plan.heldBack.some(
        (h) => h.customerId === customer.id && /due again on/.test(h.reason),
      ),
    );
  });

  test("do not contact keeps them off both lists, and says so", async () => {
    const customer = await orderedThenBilled(30, 46, { doNotContact: true });

    const plan = await getPaymentFollowUpPlan();
    assert.equal(
      plan.calls.some((c) => c.customerId === customer.id),
      false,
    );
    assert.equal(
      plan.messages.some((m) => m.customerId === customer.id),
      false,
    );
    assert.ok(
      plan.heldBack.some(
        (h) => h.customerId === customer.id && /do not contact/i.test(h.reason),
      ),
    );
  });

  test("paying the bill takes them off the follow-up entirely", async () => {
    const customer = await orderedThenBilled(30, 46);
    const [bill] = await db
      .select()
      .from(bills)
      .where(eq(bills.customerId, customer.id));

    const paid = await recordPayment({
      billId: bill.id,
      amount: bill.amount,
      paidAt: TODAY,
      idempotencyKey: randomUUID(),
    });
    assert.equal(paid.ok, true);
    await confirmReportedPayments(customer.id);

    const plan = await getPaymentFollowUpPlan();
    assert.equal(
      plan.calls.some((c) => c.customerId === customer.id),
      false,
    );
    assert.equal(
      plan.messages.some((m) => m.customerId === customer.id),
      false,
    );
    assert.equal(
      plan.heldBack.some((h) => h.customerId === customer.id),
      false,
    );
  });
});

/* ----------------------------------- journey: logging a collections call */

describe("Logging a collections call - one outcome, one transaction", () => {
  async function onTheWorklist(daysOverdue: number) {
    const customer = await makeCustomer(priya.id);
    await db.insert(bills).values({
      id: id("bil"),
      customerId: customer.id,
      billNo: `MMI/${randomUUID().slice(0, 6)}`,
      billDate: addDays(TODAY, -daysOverdue - 30),
      dueDate: addDays(TODAY, -daysOverdue),
      amount: 1_00_000_00,
      paidAmount: 0,
    });
    await recomputeBillStatuses();
    await recomputeOutstanding(customer.id);
    await recomputeFollowUpState(customer.id);
    return customer;
  }

  const stateOf = async (customerId: string) =>
    (
      await db
        .select()
        .from(followUpStates)
        .where(eq(followUpStates.customerId, customerId))
    )[0];

  test("a promise creates the promise and the reminder that chases it", async () => {
    const customer = await onTheWorklist(30);

    const saved = await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "promised",
      amount: 50_000,
      date: addDays(TODAY, 3),
      notes: "Cheque ready",
      chips: ["Cheque ready"],
      idempotencyKey: randomUUID(),
    });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);
    assert.ok(saved.data.produced.includes("reminder"));

    const [rem] = await db
      .select()
      .from(reminders)
      .where(eq(reminders.customerId, customer.id));
    assert.ok(rem, "a promise nobody chases is just a note");
    assert.equal(rem.type, "payment_promise");
    assert.ok(rem.dueDate > addDays(TODAY, 3), "chased the day after, or later");
  });

  test("an amount is required where the outcome needs one, and it says which field", async () => {
    const customer = await onTheWorklist(30);
    const refused = await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "promised",
      date: addDays(TODAY, 3),
      chips: [],
      idempotencyKey: randomUUID(),
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.fieldErrors?.[0].field, "amount");
  });

  test("Already paid is a claim: it moves nothing until accounts confirm it", async () => {
    const customer = await onTheWorklist(30);

    const saved = await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "paid",
      amount: 1_00_000,
      chips: [],
      idempotencyKey: randomUUID(),
    });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);
    assert.ok(saved.data.produced.includes("payment"));

    // The customer said the money has gone. Nobody has found it, so the
    // ledger says exactly what it said before.
    const [before] = await db.select().from(bills).where(eq(bills.customerId, customer.id));
    assert.equal(before.paidAmount, 0, "a telecaller's word does not settle a bill");
    assert.equal(before.status, "unpaid");

    const [claimedRow] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(claimedRow.outstanding, 1_00_000_00, "still owed until it is found");
    assert.ok(await stateOf(customer.id), "and still on the worklist");

    // What DOES change is that they stop being chased for it.
    const plan = await getPaymentFollowUpPlan();
    assert.equal(plan.calls.some((c) => c.customerId === customer.id), false);
    assert.ok(
      plan.heldBack.some(
        (h) => h.customerId === customer.id && /reported paid/i.test(h.reason),
      ),
      "held back with the reason said plainly, never silently dropped",
    );

    assert.equal(await confirmReportedPayments(customer.id), 1);

    const [bill] = await db.select().from(bills).where(eq(bills.customerId, customer.id));
    assert.equal(bill.paidAmount, 1_00_000_00);
    assert.equal(bill.status, "paid");

    const [row] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(row.outstanding, 0, "outstanding is derived, and it was rebuilt");
    assert.equal(await stateOf(customer.id), undefined);
  });

  test("a rejected payment gives the money back and returns the customer", async () => {
    const customer = await onTheWorklist(30);

    await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "paid",
      amount: 1_00_000,
      chips: [],
      idempotencyKey: randomUUID(),
    });
    await confirmReportedPayments(customer.id);
    assert.equal(await stateOf(customer.id), undefined, "gone once confirmed");

    const [receipt] = await db
      .select()
      .from(paymentReceipts)
      .where(eq(paymentReceipts.customerId, customer.id));

    setTestUser(deepa);
    const rejected = await rejectReceipt(receipt.id, "Not in the statement");
    assert.equal(rejected.ok, true, rejected.ok ? "" : rejected.error);
    setTestUser(priya);

    const [bill] = await db.select().from(bills).where(eq(bills.customerId, customer.id));
    assert.equal(bill.paidAmount, 0, "the bill gets its balance back");
    assert.equal(bill.status, "unpaid");

    const [row] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(row.outstanding, 1_00_000_00);
    assert.ok(await stateOf(customer.id), "and they are back on the worklist");
  });

  test("rejecting requires a reason, because somebody has to ring back", async () => {
    const customer = await onTheWorklist(30);
    await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "paid",
      amount: 1_00_000,
      chips: [],
      idempotencyKey: randomUUID(),
    });
    const [receipt] = await db
      .select()
      .from(paymentReceipts)
      .where(eq(paymentReceipts.customerId, customer.id));

    setTestUser(deepa);
    const refused = await rejectReceipt(receipt.id, "   ");
    setTestUser(priya);
    assert.equal(refused.ok, false);
    assert.equal(refused.fieldErrors?.[0].field, "reason");
  });

  test("confirming is accounts' and nobody else's", async () => {
    const customer = await onTheWorklist(30);
    await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "paid",
      amount: 1_00_000,
      chips: [],
      idempotencyKey: randomUUID(),
    });
    const [receipt] = await db
      .select()
      .from(paymentReceipts)
      .where(eq(paymentReceipts.customerId, customer.id));

    // Not the telecaller who was told about it, and not a manager by
    // seniority either — accounts hold the bank statement.
    await assert.rejects(() => confirmReceipt(receipt.id), NotPermittedError);
    setTestUser(manager);
    await assert.rejects(() => confirmReceipt(receipt.id), NotPermittedError);
    setTestUser(deepa);
    assert.equal((await confirmReceipt(receipt.id)).ok, true);
    setTestUser(priya);
  });

  test("a payment entered by accounts is confirmed as it is written", async () => {
    const customer = await onTheWorklist(30);

    setTestUser(deepa);
    const saved = await recordReceipt({
      customerId: customer.id,
      amount: 1_00_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      reference: "UTR55512",
      idempotencyKey: randomUUID(),
    });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);
    assert.equal(saved.data.status, "confirmed", "they are the verification");
    assert.equal((await pendingReceipts()).length, 0, "so nothing queues up");
    setTestUser(priya);

    const [bill] = await db.select().from(bills).where(eq(bills.customerId, customer.id));
    assert.equal(bill.status, "paid");
  });

  test("a part payment is applied to the oldest bill first", async () => {
    const customer = await makeCustomer(priya.id);
    for (const [no, days] of [["OLD", 60], ["NEW", 20]] as const) {
      await db.insert(bills).values({
        id: `bil_${no}_${randomUUID().slice(0, 6)}`,
        customerId: customer.id,
        billNo: `MMI/${no}/${randomUUID().slice(0, 4)}`,
        billDate: addDays(TODAY, -days - 30),
        dueDate: addDays(TODAY, -days),
        amount: 50_000_00,
        paidAmount: 0,
      });
    }
    await recomputeBillStatuses();
    await recomputeOutstanding(customer.id);
    await recomputeFollowUpState(customer.id);

    await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "paid",
      amount: 50_000,
      chips: [],
      idempotencyKey: randomUUID(),
    });
    // The split is decided when the customer says so; it lands when accounts
    // find the money.
    await confirmReportedPayments(customer.id);

    const rows = await db.select().from(bills).where(eq(bills.customerId, customer.id));
    const oldest = rows.find((b) => b.billNo.includes("OLD"))!;
    const newest = rows.find((b) => b.billNo.includes("NEW"))!;
    assert.equal(oldest.paidAmount, 50_000_00, "the oldest debt is cleared first");
    assert.equal(newest.paidAmount, 0);
  });

  test("a dispute raises a billing complaint and holds the account", async () => {
    const customer = await onTheWorklist(30);

    const saved = await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "dispute",
      notes: "Rate charged is wrong",
      chips: ["Rate charged is wrong"],
      idempotencyKey: randomUUID(),
    });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);

    const [complaint] = await db
      .select()
      .from(complaints)
      .where(eq(complaints.customerId, customer.id));
    assert.ok(complaint, "a dispute is a complaint, not a note");
    assert.equal(complaint.category, "billing_issue");

    await recomputeFollowUpState(customer.id);
    const state = await stateOf(customer.id);
    assert.equal(state.held, true, "the disputed bill holds the escalation");
  });

  test("a refusal raises the stage floor, and the floor survives a recompute", async () => {
    // Sixteen days overdue is stage 2 on age alone.
    const customer = await onTheWorklist(16);
    assert.equal((await stateOf(customer.id)).stage, 2);

    const saved = await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "refused",
      notes: "No date given",
      chips: [],
      idempotencyKey: randomUUID(),
    });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);
    assert.ok(saved.data.produced.includes("escalation"));

    let state = await stateOf(customer.id);
    assert.equal(state.manualStageFloor, 3);
    assert.equal(state.stage, 3, "the refusal moved them, not the calendar");

    // The nightly rebuild must not quietly undo it.
    await recomputeFollowUpState(customer.id);
    state = await stateOf(customer.id);
    assert.equal(state.stage, 3, "a floor that a recompute erases is not a floor");
    assert.match(state.floorReason ?? "", /Refused to commit/);
  });

  test("the floor goes when the debt does", async () => {
    const customer = await onTheWorklist(16);
    await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "refused",
      chips: [],
      idempotencyKey: randomUUID(),
    });
    await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "paid",
      amount: 1_00_000,
      chips: [],
      idempotencyKey: randomUUID(),
    });
    assert.ok(
      await stateOf(customer.id),
      "reporting a payment does not clear the debt, so the floor stands",
    );

    await confirmReportedPayments(customer.id);
    assert.equal(
      await stateOf(customer.id),
      undefined,
      "the row and its floor describe a debt that no longer exists",
    );
  });

  test("stage 1 refuses a logged call, exactly as it refuses an attempt", async () => {
    const customer = await onTheWorklist(10); // stage 1
    const refused = await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "refused",
      chips: [],
      idempotencyKey: randomUUID(),
    });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /WhatsApp-only/i);
  });

  test("the same save submitted twice is logged once", async () => {
    const customer = await onTheWorklist(30);
    const key = randomUUID();
    const first = await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "paid",
      amount: 10_000,
      chips: [],
      idempotencyKey: key,
    });
    const second = await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "paid",
      amount: 10_000,
      chips: [],
      idempotencyKey: key,
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.message, "Already recorded");

    const receipts = await db
      .select()
      .from(paymentReceipts)
      .where(eq(paymentReceipts.customerId, customer.id));
    assert.equal(receipts.length, 1, "a double-click is one arrival of money");

    await confirmReportedPayments(customer.id);
    const [bill] = await db.select().from(bills).where(eq(bills.customerId, customer.id));
    assert.equal(bill.paidAmount, 10_000_00, "a double-click must not pay twice");
  });

  test("a collections call is attributed to its module, not to routine calling", async () => {
    const customer = await onTheWorklist(30);
    await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "callback",
      date: addDays(TODAY, 2),
      chips: [],
      idempotencyKey: randomUUID(),
    });
    const [call] = await db.select().from(calls).where(eq(calls.customerId, customer.id));
    assert.ok(call, "the call belongs in the interaction log too");
    assert.equal(call.sourceModule, "payment_follow_up");
  });
});

/* ------------------------------ journey: the figures across the top */

describe("Collections figures and the stage 1 batch", () => {
  async function overdue(daysOverdue: number, amount = 1_00_000_00) {
    const customer = await makeCustomer(priya.id);
    const [bill] = await db
      .insert(bills)
      .values({
        id: id("bil"),
        customerId: customer.id,
        billNo: `MMI/${randomUUID().slice(0, 6)}`,
        billDate: addDays(TODAY, -daysOverdue - 30),
        dueDate: addDays(TODAY, -daysOverdue),
        amount,
        paidAmount: 0,
      })
      .returning();
    await recomputeBillStatuses();
    await recomputeOutstanding(customer.id);
    await recomputeFollowUpState(customer.id);
    return { customer, bill };
  }

  test("outstanding, the urgent stage and collected all come from the same bills", async () => {
    await overdue(50, 2_00_000_00); // stage 3
    const { customer, bill } = await overdue(20, 1_00_000_00); // stage 2

    await recordPayment({
      billId: bill.id,
      amount: 40_000_00,
      paidAt: TODAY,
      idempotencyKey: randomUUID(),
    });
    // Collections figures are about money the business has, so the payment
    // has to be found before any of them move.
    await confirmReportedPayments(customer.id);

    const m = await collectionsMetrics();
    assert.equal(m.outstanding, 2_00_000_00 + 60_000_00, "open balance, not billed value");
    assert.equal(m.outstandingCustomers, 2);
    assert.equal(m.urgent, 2_00_000_00, "only the stage 3 account is urgent");
    assert.equal(m.urgentCustomers, 1);
    assert.equal(m.collectedThisMonth, 40_000_00);
    assert.equal(m.collectedThisWeek, 40_000_00);
    void customer;
  });

  test("a promise counts as kept only when the money arrived by the date", async () => {
    // Promised ten days ago for five days ago, and paid in between: kept.
    const kept = await overdue(60);
    await db.insert(followUpAttempts).values({
      id: id("fua"),
      customerId: kept.customer.id,
      stage: 3,
      channel: "call",
      attemptedAt: new Date(`${addDays(TODAY, -10)}T09:00:00+05:30`),
      userId: priya.id,
      promisedAmount: 50_000_00,
      promisedDate: addDays(TODAY, -5),
      idempotencyKey: randomUUID(),
    });
    await recordPayment({
      billId: kept.bill.id,
      amount: 50_000_00,
      paidAt: addDays(TODAY, -6),
      idempotencyKey: randomUUID(),
    });
    await confirmReportedPayments(kept.customer.id);

    // Promised for five days ago and nothing arrived: broken.
    const broken = await overdue(60);
    await db.insert(followUpAttempts).values({
      id: id("fua"),
      customerId: broken.customer.id,
      stage: 3,
      channel: "call",
      attemptedAt: new Date(`${addDays(TODAY, -10)}T09:00:00+05:30`),
      userId: priya.id,
      promisedAmount: 50_000_00,
      promisedDate: addDays(TODAY, -5),
      idempotencyKey: randomUUID(),
    });

    const m = await collectionsMetrics();
    assert.equal(m.promisesJudged, 2);
    assert.equal(m.promisesKeptPercent, 50);
  });

  test("a promise that has not come due is open, and is not judged either way", async () => {
    const { customer } = await overdue(60);
    await db.insert(followUpAttempts).values({
      id: id("fua"),
      customerId: customer.id,
      stage: 3,
      channel: "call",
      attemptedAt: new Date(),
      userId: priya.id,
      promisedAmount: 75_000_00,
      promisedDate: addDays(TODAY, 4),
      idempotencyKey: randomUUID(),
    });

    const m = await collectionsMetrics();
    assert.equal(m.promisedOpen, 75_000_00);
    assert.equal(m.promisedCount, 1);
    assert.equal(m.promisesJudged, 0);
    assert.equal(m.promisesKeptPercent, null, "an open promise is neither kept nor broken");
  });

  test("the batch names the same people the Message today tab does", async () => {
    // Stage 1, four days overdue: due a reminder today.
    await overdue(4);
    // Stage 3: overdue, but not stage 1.
    await overdue(60);

    await db.insert(waTemplates).values({
      id: id("tpl"),
      name: "Payment reminder · stage 1",
      category: "payment_reminder",
      escalationStage: 1,
      body: "Namaste {{contact}}, {{outstanding}} is pending against {{customer}}.",
      active: true,
    });

    const batch = await stageOneBatch();
    const plan = await getPaymentFollowUpPlan();
    assert.equal(batch.customerIds.length, 1, "only the stage 1 account is in the batch");
    assert.ok(
      batch.customerIds.every((cid) => plan.messages.some((m) => m.customerId === cid)),
      "a batch must never message somebody the cadence is holding back",
    );
    assert.ok(batch.templateId, "the stage 1 template was found");
  });

  test("a telecaller cannot start the batch, and the denial is recorded", async () => {
    setTestUser(priya);
    const refused = await startStageOneBatch();
    assert.equal(refused.ok, false);
    assert.match(refused.error, /manager/i);
  });
});

/* ------------------------------------------------------------- catalogue */

describe("The product master — importing it, and what an import must not touch", () => {
  test("the four levels land, and a second run changes nothing", async () => {
    // beforeEach has already run one import via seedCatalogue.
    const [levels] = await db.execute<{
      formulations: number;
      brands: number;
      goods: number;
      skus: number;
    }>(sql`
      select (select count(*)::int from product_formulations) as formulations,
             (select count(*)::int from product_brands) as brands,
             (select count(*)::int from finished_goods) as goods,
             (select count(*)::int from products where finished_good_id is not null) as skus
    `);
    assert.equal(levels.formulations, 19);
    assert.equal(levels.brands, 32);
    assert.equal(levels.goods, 107);
    assert.equal(levels.skus, 213);

    const again = await importCatalogue();
    assert.equal(again.created, 0, "a second run must create nothing");
    assert.equal(again.updated, 0, "a second run must update nothing");
    assert.ok(again.unchanged > 300);
  });

  test("a name carried by two legacy IDs is held, never auto-picked", async () => {
    const held = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.status, "needs_canonical_id"));

    assert.equal(held.length, 15);
    for (const row of held) {
      assert.equal(row.active, false, `${row.name} must not be orderable while unidentified`);
      assert.equal(row.externalCode, null, "the import must not choose an ID");
      assert.ok((row.externalIds ?? []).length > 1, "a held row keeps every candidate");
    }
  });

  test("choosing a canonical ID makes the losers aliases and the SKU orderable", async () => {
    setTestUser(manager);
    const [subject] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.status, "needs_canonical_id"))
      .limit(1);
    const [chosen, ...losers] = subject.externalIds ?? [];

    const result = await chooseCanonicalId(subject.id, chosen);
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const [after] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, subject.id));
    assert.equal(after.status, "ok");
    assert.equal(after.active, true);
    assert.equal(after.externalCode, String(chosen));

    // The losing IDs must keep resolving: legacy rows carry them.
    const aliases = await db
      .select()
      .from(productAliasesTable)
      .where(eq(productAliasesTable.productId, subject.id));
    assert.equal(aliases.length, losers.length);
    for (const l of losers) {
      assert.ok(aliases.some((a) => a.externalId === l), `#${l} lost its alias`);
    }
  });

  test("a re-import never unmakes a canonical ID somebody chose", async () => {
    setTestUser(manager);
    const [subject] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.status, "needs_canonical_id"))
      .limit(1);
    const chosen = (subject.externalIds ?? [])[0];
    await chooseCanonicalId(subject.id, chosen);

    await importCatalogue();

    const [after] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, subject.id));
    assert.equal(after.status, "ok", "the import reset a decision a person made");
    assert.equal(after.externalCode, String(chosen));
    assert.equal(after.active, true, "the import took a resolved SKU off the order form");
  });

  test("a re-import never puts a retired SKU back on the order form", async () => {
    setTestUser(manager);
    const [live] = await db
      .select()
      .from(productsTable)
      .where(and(eq(productsTable.status, "ok"), eq(productsTable.active, true)))
      .limit(1);

    const retired = await setSkuActive(live.id, false);
    assert.equal(retired.ok, true, retired.ok ? "" : retired.error);

    await importCatalogue();

    const [after] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, live.id));
    assert.equal(
      after.active,
      false,
      "whether a SKU is offered is a decision, and the import must not overrule it",
    );
  });

  test("search reaches the formulation, so M5x4 finds the Nano SKUs", async () => {
    const results = await searchProducts("M5x4");
    assert.ok(results.length > 0, "the formulation name found nothing");
    assert.ok(
      results.some((r) => r.name.includes("Nano")),
      "a telecaller told 'M5x4' has to reach the Nano SKUs",
    );
    // The formulation is what separates two near-identical names on screen.
    assert.ok(results.every((r) => r.subtitle));
  });

  test("a held legacy row cannot be ordered until somebody names it", async () => {
    setTestUser(manager);
    const exceptions = await db.select().from(catalogueExceptionsTable);
    const held = exceptions.filter((e) => e.kind === "held");
    const excluded = exceptions.filter((e) => e.kind === "excluded");

    assert.equal(held.length, 2, "IDs 76 and 77 have packing but no sellable name");
    assert.equal(excluded.length, 1, "the empty drum is packaging, not a product");
    for (const e of held) assert.equal(e.resolvedAt, null);

    // Naming one is what turns it into something a telecaller can pick.
    const [good] = await db.select().from(finishedGoodsTable).limit(1);
    const named = await nameHeldRow(held[0].id, {
      name: "Epoxy Thinner (FD) - 1 Liter (16 Can/Box) [named]",
      finishedGoodId: good.id,
      packing: "16 Can/Box",
      cansPerBox: 16,
      millilitresPerCan: 1000,
    });
    assert.equal(named.ok, true, named.ok ? "" : named.error);

    const [row] = await db
      .select()
      .from(catalogueExceptionsTable)
      .where(eq(catalogueExceptionsTable.id, held[0].id));
    assert.ok(row.resolvedAt, "the held row must record what it became");
  });

  test("excluded packaging cannot be named into a product", async () => {
    setTestUser(manager);
    const [drum] = await db
      .select()
      .from(catalogueExceptionsTable)
      .where(eq(catalogueExceptionsTable.kind, "excluded"));
    const [good] = await db.select().from(finishedGoodsTable).limit(1);

    const refused = await nameHeldRow(drum.id, {
      name: "Empty Drum 200 Liter",
      finishedGoodId: good.id,
      packing: "Drum",
      cansPerBox: 1,
      millilitresPerCan: 200000,
    });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /packaging/i);
  });

  test("a telecaller cannot change the catalogue, and the denial is recorded", async () => {
    setTestUser(priya);
    const [live] = await db.select().from(productsTable).limit(1);
    const refused = await setSkuActive(live.id, false);
    assert.equal(refused.ok, false);
  });
});

describe("The catalogue as the telecaller meets it", () => {
  test("the picker is offered a handful, not the catalogue", async () => {
    setTestUser(manager);
    await updateSetting("products.starterListCount", 8, manager.id);

    const offered = await popularProducts();
    assert.ok(offered.length <= 8, `offered ${offered.length}, which is a list to read mid-call`);
    assert.ok(offered.length > 0, "a telecaller opening the panel must be offered something");
    // Everything offered carries what tells two near-identical names apart.
    for (const p of offered) assert.ok("subtitle" in p);
  });

  test("nothing held or retired is ever offered", async () => {
    setTestUser(manager);
    await updateSetting("products.starterListCount", 50, manager.id);

    const held = await db
      .select({ id: productsTable.id })
      .from(productsTable)
      .where(eq(productsTable.status, "needs_canonical_id"));
    const offeredIds = new Set((await popularProducts()).map((p) => p.productId));
    for (const h of held) {
      assert.equal(offeredIds.has(h.id), false, "a SKU nobody can identify was offered on an order form");
    }
  });

  test("a customer's history follows a name through an alias", async () => {
    setTestUser(manager);
    const customer = await makeCustomer(priya.id);

    // A resolved duplicate leaves the losing spelling behind as an alias, and
    // an external order carrying it has to keep counting.
    const [sku] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.status, "needs_canonical_id"))
      .limit(1);
    await chooseCanonicalId(sku.id, (sku.externalIds ?? [])[0]);
    const [alias] = await db
      .select()
      .from(productAliasesTable)
      .where(eq(productAliasesTable.productId, sku.id));

    await db.insert(orders).values({
      id: `ord_${randomUUID().slice(0, 12)}`,
      customerId: customer.id,
      source: "external",
      externalRef: `EXT-${randomUUID().slice(0, 6)}`,
      orderedAt: new Date(),
      totalAmount: 500000,
      status: "confirmed",
      // Spelled the losing way, and typed badly on top of it.
      lineItems: [
        { product: alias.name.toLowerCase().replace(/ /g, ""), quantity: 4, unitPrice: 0, amount: 0 },
      ],
    });

    const history = await customerProducts(customer.id, { limit: 0 });
    assert.ok(
      history.some((h) => h.productId === sku.id),
      "an order naming the alias contributed nothing to the history",
    );
  });

  test("global search finds a SKU by the formulation nobody puts on a label", async () => {
    setTestUser(priya);

    // "135" appears in the formulation "Mylac - 135" and in no SKU name at
    // all, so anything it returns was reached through the formulation rather
    // than through the label — which is the whole point.
    const results = await globalSearch("135");
    assert.ok(results.products.length > 0, "the formulation found no products");
    for (const p of results.products) {
      assert.ok(
        p.name.startsWith("Mylac"),
        `${p.name} is not a Mylac SKU, so the formulation match reached too far`,
      );
      assert.match(p.subtitle, /Mylac - 135/);
    }
  });

  test("searching a name ranks that name above the rest of its formulation", async () => {
    setTestUser(priya);
    // One liquid, three brand names. Typing one of them should not bury it
    // under its own siblings — the list is five long and a telecaller reads
    // the top of it.
    const results = await globalSearch("M5x4");
    assert.ok(results.products.length > 0);
    assert.ok(
      results.products[0].name.includes("M5x4"),
      `typed "M5x4" and the first result was ${results.products[0].name}`,
    );
  });

  test("a quantity is cans, and reads back as litres and boxes", async () => {
    const [sku] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.name, "Nano Thinner - 5 Liter (6 Can/Box)"));
    assert.ok(sku, "the seeded catalogue is missing a SKU the test names");
    assert.equal(
      describeQuantity(12, {
        millilitresPerCan: sku.millilitresPerCan,
        cansPerBox: sku.cansPerBox,
      }),
      "12 cans · 60 L · 2 boxes",
    );
  });
});

/* ---------------------------------------------------------------------------
 * The imported sheet reaching a telecaller.
 *
 * The projection has a job behind it and its own report. What these pin is the
 * step after: whether anything it wrote is allowed to appear on a screen. Both
 * of the failures below were total and silent — a full database and an empty
 * Call Log, with the reason living in a flag and a fallback that nothing on the
 * screen could show.
 * ------------------------------------------------------------------------- */

describe("An imported customer reaches the calling queue", () => {
  /** One order, two lines, for one billing party. */
  async function stageSheetRows(party: string, orderNumber: string, orderDate: string) {
    const [run] = await db
      .insert(sheetSyncRuns)
      .values({
        id: id("syn"),
        source: "order_details",
        spreadsheetId: "test-sheet",
        tabTitle: "Order Details",
        mode: "reconcile",
        status: "ok",
      })
      .returning();

    for (const [i, description] of ["Nano Thinner", "Mylac Primer"].entries()) {
      await db.insert(sheetOrderRows).values({
        id: id("shr"),
        syncId: run.id,
        rowNumber: 2 + i,
        lineKey: `ODID-${orderNumber}-${i}`,
        orderNumber,
        raw: {},
        rowHash: randomUUID(),
        orderDate,
        billingPartyName: party,
        area: "Bhiwandi",
        creditDays: 45,
        description,
        cans: 10,
        ratePaise: 100_00,
        amountPaise: 1000_00,
        finalAmountPaise: 1180_00,
        tallyBillNo: `MMI/26-27/${orderNumber}`,
      });
    }
    return run;
  }

  test("the import does not flag them active in the order system", async () => {
    // That flag means live activity somewhere else, and the queue holds such a
    // customer back. Setting it across an import of order HISTORY muted the
    // whole book at once — every customer imported, every customer suppressed.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });

    const [imported] = await db
      .select()
      .from(customers)
      .where(eq(customers.name, "Shree Paints"));
    assert.ok(imported, "the projection created no customer");
    assert.equal(imported.activeInOrderSystem, false);
  });

  test("and the telecaller can actually see them the same day", async () => {
    // The whole point. A record written this afternoon carrying a 40-day-old
    // order was dated from its own creation, so it sat off the list for a
    // week — a full database and an empty screen.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });

    const [imported] = await db
      .select()
      .from(customers)
      .where(eq(customers.name, "Shree Paints"));

    setTestUser(priya);
    const queue = await getQueue();
    const seen = [...queue.entries, ...queue.suppressed].some(
      (r) => r.customerId === imported.id,
    );
    assert.ok(seen, "the imported customer reached neither the queue nor the held-back list");
  });

  test("a decision accounts made survives the next sheet sync", async () => {
    /*
     * The sheet says `dispatched` on every row and the projection used to
     * write that unconditionally, so an order accounts had declined was reset
     * to dispatched on the next pass — silently, every thirty minutes once a
     * schedule exists.
     *
     * Worse than the reset: `approved_at`, `approved_by_id` and
     * `decline_reason` are not part of that overwrite, so the row was left
     * saying "declined by Deepa, over credit limit" while its status read
     * dispatched. And approved status drives EOD value, targets, the buying
     * cycle, the product history and outstanding — five screens moved with
     * nobody's name against the change.
     */
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.externalRef, "SHEET-SO-1001"));
    assert.ok(order, "the projection created no order");
    assert.equal(order.status, "dispatched", "the sheet wins on an untouched order");

    // Accounts decide. `approvedAt` is the mark of a decision and is written
    // by decline as well as approve.
    await db
      .update(orders)
      .set({
        status: "declined",
        approvedById: priya.id,
        approvedAt: new Date(),
        declineReason: "Over credit limit",
      })
      .where(eq(orders.id, order.id));

    // The sheet is read again, unchanged, exactly as a schedule would.
    await projectSheet({ assignToUserId: priya.id });

    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    assert.equal(after.status, "declined", "the sheet overwrote a decision");
    assert.equal(after.declineReason, "Over credit limit");
  });

  test("and the disagreement is written down rather than swallowed", async () => {
    // Keeping the decision quietly would trade one silent loss for another:
    // the sheet still says dispatched and somebody has to reconcile the two.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.externalRef, "SHEET-SO-1001"));
    await db
      .update(orders)
      .set({ status: "declined", approvedById: priya.id, approvedAt: new Date() })
      .where(eq(orders.id, order.id));

    await projectSheet({ assignToUserId: priya.id });

    const [conflict] = await db
      .select()
      .from(syncConflicts)
      .where(eq(syncConflicts.entityId, order.id));
    assert.ok(conflict, "nothing recorded the disagreement");
    assert.equal(conflict.field, "status");
    assert.equal(conflict.sheetValue, "dispatched");
    assert.equal(conflict.appValue, "declined");
    assert.equal(conflict.decidedById, priya.id);

    // A second pass must not open a second row. An uncorrected sheet is
    // re-read every thirty minutes, and a list that grows by forty-eight rows
    // a day is one nobody reads.
    await projectSheet({ assignToUserId: priya.id });
    const all = await db
      .select()
      .from(syncConflicts)
      .where(eq(syncConflicts.entityId, order.id));
    assert.equal(all.length, 1, "the same disagreement was recorded twice");
  });

  test("an order nobody has touched still follows the sheet", async () => {
    // The guard must not freeze the ordinary case: without a decision, the
    // sheet is the source and stays it.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.externalRef, "SHEET-SO-1001"));
    await db
      .update(orders)
      .set({ status: "captured" })
      .where(eq(orders.id, order.id));

    await projectSheet({ assignToUserId: priya.id });

    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    assert.equal(after.status, "dispatched", "the sheet stopped winning where it should");
  });

  test("a follow-up row is cleared even for a customer nobody calls any more", async () => {
    // The recompute visited only `active` customers, so a customer who went
    // quiet — or was deactivated — kept whatever follow-up row they had at
    // that moment, for ever. Eight of them sat at stage 3 claiming crores
    // overdue while owing nothing, and no recompute could reach them again.
    const customer = await makeCustomer(priya.id);
    await db.insert(bills).values({
      id: id("bil"),
      customerId: customer.id,
      billNo: `INV-${randomUUID().slice(0, 6)}`,
      billDate: addDays(TODAY, -120),
      dueDate: addDays(TODAY, -90),
      amount: 40_000_00,
      paidAmount: 0,
    });
    await recomputeFollowUpState(customer.id);
    assert.equal(
      (await db.select().from(followUpStates)).length,
      1,
      "overdue and unpaid, so they belong on the list",
    );

    // The debt is settled and they leave the book on the same day.
    await db
      .update(bills)
      .set({ paidAmount: 40_000_00 })
      .where(eq(bills.customerId, customer.id));
    await db
      .update(customers)
      .set({ status: "deactivated" })
      .where(eq(customers.id, customer.id));

    const { recomputeAllFollowUpStates } = await import("@/lib/recompute");
    await recomputeAllFollowUpStates();
    assert.equal(
      (await db.select().from(followUpStates)).length,
      0,
      "a row describing a debt that no longer exists must go, whatever the customer's status",
    );
  });

  test("a sales bill is the order, and nobody has said whether it is paid", async () => {
    // The Order Details tab carries the bill number and the amount on every
    // line and a payment status on NONE. It used to be read as "paid", on the
    // reasoning that assuming the opposite invents the entire order book as
    // debt. Both readings are inventions; this one marked all the customers
    // and all the bills settled on a spreadsheet's authority.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    const report = await projectSheet({ assignToUserId: priya.id });

    assert.equal(report.bills.skipped, false, "bills are no longer opt-in");
    assert.equal(report.bills.created, 1, "one order is one bill");
    assert.equal(report.bills.unstated, 1, "and it is waiting on a person");
    assert.equal(report.bills.payments, 0, "the sheet writes no money, ever");

    const [bill] = await db.select().from(bills);
    // Two lines at 1180.00 each — the value is the SUM, never one line's.
    assert.equal(bill.amount, 2360_00);
    assert.equal(bill.paidAmount, 0, "nothing has been received that we know of");
    assert.equal(bill.paymentPosition, "unstated", "and nobody has said either way");
    assert.ok(bill.orderId, "the bill records which order it came from");

    // Not a receipt anywhere. This is the whole point.
    assert.equal(
      (await db.select().from(paymentReceipts)).length,
      0,
      "the projection wrote a receipt",
    );

    // And it is not debt either: unstated counts as NEITHER, so nobody is
    // chased for it and the collections list stays empty.
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.name, "Shree Paints"));
    assert.equal(customer.outstanding, 0, "an unsaid bill is not outstanding");
    assert.equal((await db.select().from(followUpStates)).length, 0);
  });

  test("a second pass never re-states a bill somebody has spoken for", async () => {
    // The 9 August failure in miniature: a decision recorded in the app, then
    // a scheduled pass over the same unchanged sheet row. `payment_position`
    // is not in the update's column list, so re-reading the row cannot return
    // a bill to silence.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });

    const [bill] = await db.select().from(bills);
    await db
      .update(bills)
      .set({ paymentPosition: "stated", paidAmount: bill.amount })
      .where(eq(bills.id, bill.id));

    await projectSheet({ assignToUserId: priya.id });

    const [after] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(after.paymentPosition, "stated", "the sheet unsaid a decision");
    assert.equal(after.paidAmount, bill.amount, "and it moved the money too");
  });

  test("recording a payment in the app is what states a bill", async () => {
    // The other direction: an unstated bill is invisible to outstanding until
    // somebody speaks, and recording money against it is speaking.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });

    const [bill] = await db.select().from(bills);
    assert.equal(bill.paymentPosition, "unstated");

    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, bill.customerId));
    assert.equal(customer.outstanding, 0, "unstated contributes nothing");

    // Half of it arrives. Accounts recording it IS the confirmation.
    setTestUser(deepa);
    const receipt = await recordReceipt({
      customerId: bill.customerId,
      amount: 1180_00,
      mode: "Bank transfer",
      reference: "UTR-STATE-1",
      receivedAt: TODAY,
      // Oldest first, not "settle": settling demands the full amount, and half
      // of it is exactly the interesting case — a bill that is now stated AND
      // still partly owed.
      allocation: "auto",
      idempotencyKey: randomUUID(),
    });
    assert.equal(receipt.ok, true, receipt.ok ? "" : receipt.error);
    setTestUser(priya);

    const [stated] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(stated.paymentPosition, "stated", "recording money states the bill");
    assert.ok(stated.paymentDecidedAt, "and marks when it was decided");

    // Now it counts — and it counts as the REMAINDER, not the whole amount.
    const [after] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, bill.customerId));
    assert.equal(after.outstanding, 1180_00, "the balance joins outstanding once stated");
  });

  test("a bill number already taken does not bring the whole import down", async () => {
    // The insert that failed in production: bills_no_key is unique across the
    // WHOLE table, so a number held by any other bill — typed in by hand, left
    // by a half-finished run, or written by the Payment Status path — collided
    // and threw, after thousands of rows had already landed.
    const other = await makeCustomer(rakesh.id);
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));

    // Exactly the number the import is about to want.
    const wanted = "MMI/26-27/SO-1001";
    await db.insert(bills).values({
      id: id("bil"),
      customerId: other.id,
      billNo: wanted,
      billDate: addDays(TODAY, -200),
      amount: 5_000_00,
      paidAmount: 0,
    });

    const report = await projectSheet({ assignToUserId: priya.id });
    assert.equal(report.bills.created, 1, "the order still became a bill");

    const rows = await db.select().from(bills);
    assert.equal(rows.length, 2, "both bills exist, neither overwrote the other");
    const mine = rows.find((b) => b.externalRef === "SHEETPAY-SO-1001");
    assert.ok(mine, "the imported bill was written");
    assert.notEqual(mine.billNo, wanted, "and it took a different number");
    assert.equal(
      mine.billNo,
      `${wanted}/SO-1001`,
      "the order number is what makes it unique, so it stays recognisable",
    );
  });

  test("running it twice pays the bill neither time", async () => {
    // This used to guard the importer's idempotency key, because settling
    // twice was the failure to fear. Nothing settles now, so the guarantee is
    // stronger and simpler: no pass, first or fiftieth, writes money.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });
    await projectSheet({ assignToUserId: priya.id });

    const rows = await db.select().from(bills);
    assert.equal(rows.length, 1, "one bill, not two");
    assert.equal(rows[0].paidAmount, 0, "and no money either time");
    assert.equal(rows[0].paymentPosition, "unstated");
    assert.equal((await db.select().from(paymentReceipts)).length, 0);
  });

  /** One Payment Status row for an order, saying whatever it is told to say. */
  async function stagePaymentRow(
    orderNumber: string,
    party: string,
    paymentStatus: string | null,
    paymentReceivedDate: string | null = null,
  ) {
    const [run] = await db
      .insert(sheetSyncRuns)
      .values({
        id: id("syn"),
        source: "payment_status",
        spreadsheetId: "test-sheet",
        tabTitle: "Payment Status",
        mode: "reconcile",
        status: "ok",
      })
      .returning();

    await db.insert(sheetPaymentRows).values({
      id: id("spr"),
      syncId: run.id,
      rowNumber: 2,
      orderNumber,
      raw: {},
      rowHash: randomUUID(),
      billingPartyName: party,
      tallyBillNo: `MMI/26-27/${orderNumber}`,
      billAmountPaise: 2360_00,
      paymentStatus,
      paymentReceivedDate,
    });
  }

  /**
   * The damage the old importer did, reproduced by hand.
   *
   * The projection cannot make it any more — that is the change — but the
   * cleanup path still has to work, because production carries thousands of
   * these receipts and they are the reason the whole book reads as paid. So
   * the tests that cover the revert build the wreckage directly instead of
   * asking the importer to produce it.
   */
  async function settleAsTheSheetOnceDid(billId: string, customerId: string) {
    const [bill] = await db.select().from(bills).where(eq(bills.id, billId));
    const receiptId = id("rcp");
    await db.insert(paymentReceipts).values({
      id: receiptId,
      customerId,
      amount: bill.amount,
      receivedAt: bill.billDate,
      mode: "Not stated",
      status: "confirmed",
      source: "sheet_import",
      confirmedAt: new Date(),
      idempotencyKey: bill.externalRef!,
    });
    await db.insert(payments).values({
      id: id("pay"),
      receiptId,
      billId: bill.id,
      customerId,
      amount: bill.amount,
      paidAt: bill.billDate,
      mode: "Not stated",
      externalRef: bill.externalRef,
    });
    // Settled by the sheet, so `payment_position` reads `stated` exactly as
    // the pre-existing production rows do — they were left alone deliberately.
    await db
      .update(bills)
      .set({ paymentPosition: "stated" })
      .where(eq(bills.id, bill.id));
    await recomputeAllBillPaid();
    await recomputeBillStatuses();
    await recomputeAllOutstanding();
  }

  test("the Payment Status tab saying Pending still writes no money", async () => {
    // This tab genuinely knows something — it is the one place in the workbook
    // that carries received/not-received. It is still a spreadsheet cell, and
    // a receipt is the assertion that money reached the bank, so the tab
    // informs a person rather than writing the ledger itself. The bill is
    // recorded; what happened to the money is left unsaid.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await stagePaymentRow("SO-1001", "Shree Paints", "Pending");

    const report = await projectSheet({ assignToUserId: priya.id });
    assert.equal(report.bills.created, 1, "the bill is still written");
    assert.equal(report.bills.unstated, 1, "and its position is unsaid");

    const [bill] = await db.select().from(bills);
    assert.equal(bill.paidAmount, 0);
    assert.equal(bill.paymentPosition, "unstated");
    assert.equal(
      (await db.select().from(paymentReceipts)).length,
      0,
      "no receipt was invented in either direction",
    );

    // NOT claimed as debt either, which is the change from before: the tab
    // saying Pending is evidence for a person to act on, not a person acting.
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.name, "Shree Paints"));
    assert.equal(customer.outstanding, 0, "a cell is not somebody vouching for a debt");
  });

  test("a blank status is unsaid, exactly like every other status", async () => {
    // "Not yet paid" and "nobody has updated this" wear the same blank. It
    // used to be read as settled; it is now read as what it is, which is the
    // same answer the tab's non-blank rows now get.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await stagePaymentRow("SO-1001", "Shree Paints", "   ");

    const report = await projectSheet({ assignToUserId: priya.id });
    assert.equal(report.bills.unstated, 1);

    const [bill] = await db.select().from(bills);
    assert.equal(bill.paidAmount, 0);
    assert.equal(bill.paymentPosition, "unstated");
  });

  test("the revert gives back the outstanding a settled run wrote over", async () => {
    // The historical damage: production carries thousands of these receipts,
    // and the importer can no longer produce one, so it is built by hand.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });

    const [before] = await db.select().from(bills);
    await settleAsTheSheetOnceDid(before.id, before.customerId);

    const [damaged] = await db.select().from(bills);
    assert.equal(damaged.paidAmount, damaged.amount, "settled, as prod was");

    // The tab's verdict arrives — it was always there, never overwritten.
    await stagePaymentRow("SO-1001", "Shree Paints", "Pending");

    const dry = await revertSheetSettledBills({ dryRun: true });
    assert.equal(dry.deleted, 1);
    assert.equal(dry.restoredPaise, 2360_00);
    assert.equal(dry.customers, 1);
    assert.equal(
      (await db.select().from(paymentReceipts)).length,
      1,
      "a dry run writes nothing",
    );

    const report = await revertSheetSettledBills();
    assert.equal(report.deleted, 1);
    assert.equal(report.restoredPaise, 2360_00);

    const [restored] = await db.select().from(bills);
    assert.equal(restored.paidAmount, 0, "the money is owed again");
    assert.notEqual(restored.status, "paid");
    assert.equal(
      (await db.select().from(payments)).length,
      0,
      "the allocation line went with the receipt it belonged to",
    );

    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.name, "Shree Paints"));
    assert.equal(customer.outstanding, 2360_00, "and the customer owes it");
  });

  test("a bill the receivables report unpaid is never settled again", async () => {
    // THE 11 AUGUST INCIDENT, exactly. Applying Tally's receivables on the 9th
    // marked 395 bills owed by DELETING their assumed receipts — which frees
    // the SHEETPAY-<order> idempotency key. A free key reads to the importer as
    // "never settled", so the next scheduled pass wrote a fresh full-amount
    // receipt for 348 of them, Rs 1.18 crore, fourteen hours later.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });

    const [imported] = await db.select().from(bills);
    await settleAsTheSheetOnceDid(imported.id, imported.customerId);

    const [settled] = await db.select().from(bills);
    assert.equal(settled.paidAmount, settled.amount, "settled, as prod still is");

    // Tally says the whole 2360.00 is still owed.
    const { applyReceivables } = await import("@/lib/services/receivables-service");
    const report = await applyReceivables(
      [
        `" "," ","Shree Paints"," "," "`,
        `"Date","Ref. No.","Pending Amount","Due on","OverDue by days"`,
        `"01 Jul 26","${settled.billNo}","2360","31 Jul 26"," "`,
      ].join("\n"),
    );
    assert.equal(report.matched, 1, "the report found the bill");

    const [owed] = await db.select().from(bills);
    assert.equal(owed.paidAmount, 0, "and left it owing");
    assert.ok(owed.paymentDecidedAt, "the decision is marked on the bill");
    assert.equal(
      (await db.select().from(paymentReceipts)).length,
      0,
      "the assumed receipt is gone, so the idempotency key is free again",
    );

    // The scheduled pass that used to undo all of it.
    await projectSheet({ assignToUserId: priya.id });

    const [after] = await db.select().from(bills);
    assert.equal(after.paidAmount, 0, "the debt survives the next sync");
    assert.equal(
      (await db.select().from(paymentReceipts)).length,
      0,
      "and no receipt was invented on the free key",
    );

    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.name, "Shree Paints"));
    assert.equal(customer.outstanding, 2360_00);
  });

  test("the decision survives however many times the sheet is read", async () => {
    // The cron runs every thirty minutes. Once is not the test.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });
    const [bill] = await db.select().from(bills);
    await settleAsTheSheetOnceDid(bill.id, bill.customerId);

    const { applyReceivables } = await import("@/lib/services/receivables-service");
    await applyReceivables(
      [
        `" "," ","Shree Paints"," "," "`,
        `"Date","Ref. No.","Pending Amount","Due on","OverDue by days"`,
        `"01 Jul 26","${bill.billNo}","2360","31 Jul 26"," "`,
      ].join("\n"),
    );

    for (let i = 0; i < 5; i++) await projectSheet({ assignToUserId: priya.id });

    const [after] = await db.select().from(bills);
    assert.equal(after.paidAmount, 0, "five passes, still owed");
  });

  test("a part payment from the report is not topped back up to full", async () => {
    // leaveOwing REDUCES the assumed receipt rather than deleting it when some
    // money did arrive. The key stays taken, but the lock has to hold anyway —
    // a later pass must not decide the remainder arrived too.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });
    const [bill] = await db.select().from(bills);
    await settleAsTheSheetOnceDid(bill.id, bill.customerId);

    const { applyReceivables } = await import("@/lib/services/receivables-service");
    await applyReceivables(
      [
        `" "," ","Shree Paints"," "," "`,
        `"Date","Ref. No.","Pending Amount","Due on","OverDue by days"`,
        `"01 Jul 26","${bill.billNo}","1000","31 Jul 26"," "`,
      ].join("\n"),
    );

    const [part] = await db.select().from(bills);
    assert.equal(part.paidAmount, 1360_00, "2360 billed, 1000 still owed");

    await projectSheet({ assignToUserId: priya.id });
    const [after] = await db.select().from(bills);
    assert.equal(after.paidAmount, 1360_00, "the remainder stays owed");
  });

  test("the revert keeps a receipt the tab vouches for", async () => {
    // The narrow part. A bill the tab calls Received is money that arrived,
    // and deleting its receipt would invent debt in the opposite direction.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });
    const [imported] = await db.select().from(bills);
    await settleAsTheSheetOnceDid(imported.id, imported.customerId);
    await stagePaymentRow("SO-1001", "Shree Paints", "Received", addDays(TODAY, -10));

    const report = await revertSheetSettledBills();
    assert.equal(report.deleted, 0);
    assert.equal(report.kept, 1);

    const [bill] = await db.select().from(bills);
    assert.equal(bill.paidAmount, bill.amount, "still settled, and rightly");
  });

  test("the revert leaves a payment somebody recorded alone", async () => {
    // Only `sheet_import` receipts are in scope. A telecaller's reported
    // payment and an accounts confirmation are somebody's word, and no
    // cleanup of an import's mistake may touch them.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });
    await stagePaymentRow("SO-1001", "Shree Paints", "Pending");

    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.name, "Shree Paints"));
    const humanReceipt = id("rcp");
    await db.insert(paymentReceipts).values({
      id: humanReceipt,
      customerId: customer.id,
      amount: 500_00,
      receivedAt: addDays(TODAY, -2),
      mode: "UPI",
      status: "confirmed",
      source: "manual",
      reference: "UTR-12345",
      confirmedAt: new Date(),
      idempotencyKey: id("idem"),
    });

    await revertSheetSettledBills();

    const remaining = await db.select().from(paymentReceipts);
    assert.equal(remaining.length, 1, "the fabricated one went, the real one stayed");
    assert.equal(remaining[0].id, humanReceipt);
  });

  test("the order lands, and the cycle is rebuilt from it", async () => {
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    const report = await projectSheet({ assignToUserId: priya.id });

    assert.equal(report.customers.created, 1);
    assert.equal(report.orders.created, 1);
    // Two lines, one order — the value is the SUM, never one line's figure.
    assert.equal(report.orders.lines, 2);

    const [imported] = await db
      .select()
      .from(customers)
      .where(eq(customers.name, "Shree Paints"));
    assert.equal(imported.lastOrderDate, addDays(TODAY, -40));
    assert.equal(imported.avgOrderValue, 2360_00);
  });

  test("a customer whose sales AM is set stays on the collections list", async () => {
    // Scope has one definition and it reads the sales account manager before
    // the owner. Eight lists read owner_id alone, so a converted customer
    // dropped off every one of them while still owing money.
    const customer = await makeCustomer(priya.id, { ownerId: null, salesAmId: priya.id });
    await db.insert(bills).values({
      id: id("bil"),
      customerId: customer.id,
      billNo: `INV-${randomUUID().slice(0, 6)}`,
      billDate: addDays(TODAY, -90),
      dueDate: addDays(TODAY, -60),
      amount: 50_000_00,
      paidAmount: 0,
    });
    await recomputeOutstanding(customer.id);
    await recomputeFollowUpState(customer.id);

    setTestUser(priya);
    const worklist = await getFollowUpWorklist();
    assert.ok(
      worklist.some((r) => r.customerId === customer.id),
      "an overdue customer with a sales AM was missing from the collections worklist",
    );
  });

  test("the collections figures count the same book the list shows", async () => {
    // The strip above the worklist scoped by owner_id while the list under it
    // scoped by the assignment rule, so a manager or an admin working their
    // own accounts read an outstanding figure of zero over a list of accounts
    // that plainly owed money.
    const customer = await makeCustomer(manager.id, {
      ownerId: null,
      salesAmId: manager.id,
    });
    await db.insert(bills).values({
      id: id("bil"),
      customerId: customer.id,
      billNo: `INV-${randomUUID().slice(0, 6)}`,
      billDate: addDays(TODAY, -90),
      dueDate: addDays(TODAY, -60),
      amount: 40_000_00,
      paidAmount: 0,
    });
    await recomputeOutstanding(customer.id);
    await recomputeFollowUpState(customer.id);

    setTestUser(manager);
    const row = (await getFollowUpWorklist()).find(
      (r) => r.customerId === customer.id,
    );
    assert.ok(row, "the account is on the list");

    const metrics = await collectionsMetrics();
    assert.ok(
      metrics.outstanding >= 40_000_00,
      "the figures left out an account the list beside them was showing",
    );

    // And the row says whose account it is, by the same rule — the owner is
    // null here, so reading owner_id would have left the column blank.
    assert.equal(row.assignedToName, manager.name);

  });
});

/* ---------------------------------------------------------------------------
 * The My book / Team switch.
 *
 * It is drawn for anybody `isManager` lets through, and that includes an
 * admin. The narrowing has to be read for both, or the highlight moves and
 * every list stays team-wide — which is what the Call Log did.
 * ------------------------------------------------------------------------- */

describe("whose book a screen is showing", () => {
  test("an admin choosing My book gets their own book, not the company", async () => {
    const admin = await makeUser("Anita", "admin");

    const narrowed = await scopeForUser(admin, "mine");
    assert.equal(narrowed.scope.kind, "own");
    assert.deepEqual(
      narrowed.scope.userIds,
      [admin.id],
      "the Call Log kept showing every telecaller's calls with My book lit",
    );
    assert.equal(narrowed.role, "admin", "narrowing the view is not a demotion");

    const wide = await scopeForUser(admin, "team");
    assert.equal(wide.scope.kind, "all", "an admin's team is the whole company");
  });

  test("a manager choosing My book gets their own book", async () => {
    const mine = await scopeForUser(manager, "mine");
    assert.equal(mine.scope.kind, "own");
    assert.deepEqual(mine.scope.userIds, [manager.id]);

    const team = await scopeForUser(manager, "team");
    assert.equal(team.scope.kind, "team");
    assert.deepEqual(
      [...(team.scope.userIds ?? [])].sort(),
      [manager.id, priya.id, rakesh.id].sort(),
      "the team is the reporting line plus the manager themselves",
    );
  });

  test("a telecaller cannot widen, whatever the preference says", async () => {
    const asked = await scopeForUser(priya, "team");
    assert.equal(asked.scope.kind, "own");
    assert.deepEqual(asked.scope.userIds, [priya.id]);
  });

  test("accounts are never narrowed — they are shown no switch", async () => {
    // `getScope` answers "mine" for every non-manager, so reading a preference
    // for accounts would scope the approval queue to a clerk's own book.
    const scope = await scopeForUser(deepa);
    assert.equal(scope.role, "accounts");
    assert.equal(scope.scope.kind, "all");
  });
});

/* ---------------------------------------------------------------------------
 * The dashboard's spans, against the database.
 *
 * `periodRange` is pinned in the engine tests; what is pinned here is that a
 * span of one day and that day on its own read the same figures, and that a
 * longer span adds days up rather than reading only one of them.
 * ------------------------------------------------------------------------- */

describe("figures over a span of days", () => {
  /** An outbound call at 10am IST on a given business date. */
  async function callAt(day: string, outcome: "no_order" | "no_answer") {
    const customer = await makeCustomer(priya.id);
    await db.insert(calls).values({
      id: id("cal"),
      customerId: customer.id,
      userId: priya.id,
      interactionType: "outbound_call",
      outcome,
      startedAt: new Date(`${day}T10:00:00+05:30`),
    });
  }

  test("a one-day range is the day itself", async () => {
    await callAt(TODAY, "no_order");
    await callAt(TODAY, "no_answer");

    const day = await eodMetricsFor(priya.id, TODAY);
    const range = await eodMetricsForRange(priya.id, { from: TODAY, to: TODAY });
    assert.deepEqual(
      range,
      day,
      "the dashboard's today and the EOD report must not be two answers",
    );
    assert.equal(day.callsAttempted, 2);
  });

  test("a span adds the days up, and stops at its edges", async () => {
    const yesterday = addDays(TODAY, -1);
    const wayBack = addDays(TODAY, -9);

    await callAt(TODAY, "no_order");
    await callAt(yesterday, "no_order");
    await callAt(yesterday, "no_answer");
    await callAt(wayBack, "no_order");

    const twoDays = await eodMetricsForRange(priya.id, {
      from: yesterday,
      to: TODAY,
    });
    assert.equal(twoDays.callsAttempted, 3, "the call nine days ago is outside");
    assert.equal(twoDays.callsMissed, 1);

    const tenDays = await eodMetricsForRange(priya.id, {
      from: wayBack,
      to: TODAY,
    });
    assert.equal(tenDays.callsAttempted, 4, "a wider span reaches it");
  });

  test("the team figure over a span sums the people in scope", async () => {
    await callAt(TODAY, "no_order");

    const customer = await makeCustomer(rakesh.id);
    await db.insert(calls).values({
      id: id("cal"),
      customerId: customer.id,
      userId: rakesh.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      startedAt: new Date(`${TODAY}T11:00:00+05:30`),
    });

    setTestUser(manager);
    const team = await rangeActivity(null, { from: TODAY, to: TODAY });
    assert.equal(team.callsAttempted, 2, "both telecallers' calls, added up");

    // And the rate comes off the summed calls, never averaged from each
    // person's own rate.
    assert.equal(team.connectRate, 100);
  });
});

/* ---------------------------------------------------------------------------
 * Changing who an account answers to.
 *
 * Two managers per account, moving independently, changed by accounts and
 * admin and nobody else — and the whole thing is worthless unless it survives
 * the next sheet sync, which is what most of these are about.
 * ------------------------------------------------------------------------- */

/** The same, with a phone number the projection is expected to fill in. */
async function stagePartyRowWithPhone(
  partyName: string,
  salesPersonName: string,
  mobileNo: string,
) {
  const [run] = await db
    .insert(sheetSyncRuns)
    .values({
      id: id("syn"),
      source: "sales_party",
      spreadsheetId: "test-sheet",
      tabTitle: "Sales Party",
      mode: "reconcile",
      status: "ok",
    })
    .returning();
  await db.insert(sheetPartyRows).values({
    id: id("spy"),
    syncId: run.id,
    rowNumber: 2,
    partyName,
    partyKey: partyNameKey(partyName),
    raw: {},
    rowHash: randomUUID(),
    salesPersonName,
    mobileNo,
  });
}

/** One Sales Party row, so `recomputeSalesPeople()` has a sheet to read. */
async function stagePartyRow(partyName: string, salesPersonName: string) {
  const [run] = await db
    .insert(sheetSyncRuns)
    .values({
      id: id("syn"),
      source: "sales_party",
      spreadsheetId: "test-sheet",
      tabTitle: "Sales Party",
      mode: "reconcile",
      status: "ok",
    })
    .returning();
  await db.insert(sheetPartyRows).values({
    id: id("spy"),
    syncId: run.id,
    rowNumber: 2,
    partyName,
    partyKey: partyNameKey(partyName),
    raw: {},
    rowHash: randomUUID(),
    salesPersonName,
  });
}

describe("a reassignment survives the sheet", () => {
  test("the party projection leaves a decided account alone, and says the sheet disagrees", async () => {
    /*
     * The reported bug, end to end.
     *
     * `recomputeSalesPeople` has honoured `am_decided_at` since it was added.
     * The party PROJECTION never did — so a reassignment wrote its history,
     * notified both people, and was undone by the next sync half an hour
     * later. In production somebody made the same change four times in four
     * minutes before giving up.
     */
    const customer = await makeCustomer(priya.id, { name: "DECIDED PAINTS" });
    await stagePartyRow("DECIDED PAINTS", priya.name);

    setTestUser(deepa);
    const moved = await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: rakesh.id,
      sales: { reasonCode: "Salesperson left" },
    });
    assert.equal(moved.ok, true);

    await projectParties();

    const [after] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(after.salesAmId, rakesh.id, "the sheet took the account back");
    assert.equal(
      after.salesPersonName,
      rakesh.name,
      "the id held and the NAME reverted — the worst of the two outcomes, because every screen reads the name first",
    );

    const conflicts = await db
      .select()
      .from(syncConflicts)
      .where(eq(syncConflicts.entityId, customer.id));
    assert.equal(conflicts.length, 1, "a kept decision is written down, not just kept");
    assert.equal(conflicts[0].field, "sales_person");
    assert.equal(conflicts[0].sheetValue, priya.name);
    assert.equal(conflicts[0].appValue, rakesh.name);
  });

  test("an undecided account is still the sheet's to state", async () => {
    // The guard must not freeze every account the moment it exists. Nobody
    // has decided anything here, so the sheet wins exactly as before.
    const customer = await makeCustomer(priya.id, { name: "OPEN PAINTS" });
    await stagePartyRow("OPEN PAINTS", rakesh.name);

    await projectParties();

    const [after] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(after.salesPersonName, rakesh.name);
    assert.equal(after.salesAmId, rakesh.id, "and it links where the name matches an account");
  });

  test("the sheet still wins on everything that is not a manager", async () => {
    // A decision is about who holds the account. It is not a reason to stop
    // taking the customer's phone number from the master.
    const customer = await makeCustomer(priya.id, { name: "PHONE PAINTS", phone: "" });
    await stagePartyRowWithPhone("PHONE PAINTS", priya.name, "9820011111");

    setTestUser(deepa);
    await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: rakesh.id,
      sales: { reasonCode: "Salesperson left" },
    });
    await projectParties();

    const [after] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(after.phone, "9820011111", "the sheet stopped filling in a phone number");
    assert.equal(after.salesAmId, rakesh.id, "and the decision still held");
  });
});

describe("emptying the sales seat means nobody, not the importer", () => {
  test("a decided-empty account leaves the owner's book", async () => {
    /*
     * `owner_id` is whoever ran the import — one person holds it on more than
     * a thousand rows in production. The fallback to it is for a field NOBODY
     * HAS SET, and a salesperson leaving is not that: recorded honestly as
     * "this account has no salesperson", it handed the account to the
     * importer, who had never sold to them and whose screen still showed the
     * departed salesperson's name.
     */
    const customer = await makeCustomer(priya.id, { name: "ORPHAN PAINTS" });

    setTestUser(deepa);
    const emptied = await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: null,
      sales: { reasonCode: "Salesperson left" },
    });
    assert.equal(emptied.ok, true);

    const [after] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(after.salesAmId, null);
    assert.ok(after.amDecidedAt, "the decision is marked");

    // The owner is untouched — it records who found the account — but it is
    // no longer what the account answers to.
    assert.equal(after.ownerId, priya.id);
    assert.equal(
      assignedUserId({
        kind: "customer",
        ownerId: after.ownerId,
        salesAmId: after.salesAmId,
        amDecidedAt: after.amDecidedAt,
      }),
      null,
      "an emptied seat resolved back to the owner",
    );

    // And the queue agrees, which is the half that was actually reported.
    setTestUser(priya);
    const q = await getQueue();
    assert.equal(
      q.entries.some((e) => e.customerId === customer.id) ||
        q.suppressed.some((x) => x.customerId === customer.id),
      false,
      "it stayed in the importer's calling list",
    );
  });

  test("an account nobody has decided on still falls back to the owner", async () => {
    // The fallback is what keeps a record mid-migration from being orphaned
    // out of every list. Removing it entirely would empty books.
    const customer = await makeCustomer(priya.id, { name: "UNSET PAINTS" });
    await db
      .update(customers)
      .set({ salesAmId: null })
      .where(eq(customers.id, customer.id));

    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(
      assignedUserId({
        kind: "customer",
        ownerId: row.ownerId,
        salesAmId: row.salesAmId,
        amDecidedAt: row.amDecidedAt,
      }),
      priya.id,
    );
  });
});

describe("updating an account manager", () => {
  test("accounts may, and a manager may not", async () => {
    // Deliberately the narrowest permission in the app. Whose book an account
    // is in decides whose targets it counts toward, so a manager reassigning
    // accounts is a manager moving numbers between their own people.
    const customer = await makeCustomer(priya.id);

    setTestUser(manager);
    const refused = await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: rakesh.id,
      sales: { reasonCode: "Salesperson left" },
    });
    assert.equal(refused.ok, false, "a manager reassigned an account");

    const [untouched] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(untouched.salesAmId, priya.id, "and it moved anyway");
    assert.equal(untouched.amDecidedAt, null, "and left a decision mark");

    setTestUser(deepa);
    const allowed = await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: rakesh.id,
      sales: { reasonCode: "Salesperson left" },
    });
    assert.equal(allowed.ok, true, allowed.ok ? "" : allowed.error);
    setTestUser(priya);
  });

  test("both managers move at once, and each is its own history row", async () => {
    const customer = await makeCustomer(priya.id, { backOfficeAmId: null });

    setTestUser(deepa);
    const res = await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: rakesh.id,
      backOffice: { kind: "user", userId: manager.id },
      // Two seats, two reasons — the point of the change. The back office did
      // not move because a salesperson left.
      sales: { reasonCode: "Territory reassigned", note: "Western line handed over" },
      backOfficeReason: { reasonCode: "Workload rebalanced" },
    });
    assert.equal(res.ok, true, res.ok ? "" : res.error);
    setTestUser(priya);

    const [after] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(after.salesAmId, rakesh.id);
    assert.equal(after.backOfficeAmId, manager.id);
    // The mirrors move with the ids, or the screens keep showing the old name
    // and the reassignment reads as a failure.
    assert.equal(after.salesPersonName, "Rakesh");
    assert.equal(after.backOfficeName, "Vikram");
    assert.ok(after.amDecidedAt, "the decision is marked");

    const history = await db
      .select()
      .from(customerAmChanges)
      .where(eq(customerAmChanges.customerId, customer.id));
    assert.equal(history.length, 2, "one row per manager, not one for both");
    const sales = history.find((h) => h.role === "sales")!;
    assert.equal(sales.fromUserId, priya.id);
    assert.equal(sales.toUserId, rakesh.id);
    assert.equal(sales.reasonCode, "Territory reassigned");
    assert.equal(sales.note, "Western line handed over");
    assert.equal(history.find((h) => h.role === "back_office")!.toUserId, manager.id);
  });

  test("the new manager is told, and the old one too", async () => {
    const customer = await makeCustomer(priya.id);

    setTestUser(deepa);
    await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: rakesh.id,
      sales: { reasonCode: "Salesperson left" },
    });
    setTestUser(priya);

    const toNew = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, rakesh.id));
    assert.ok(
      toNew.some((n) => /assigned to you/i.test(n.title)),
      "the person who gained the work was not told",
    );
    const toOld = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, priya.id));
    assert.ok(
      toOld.some((n) => /moved from you/i.test(n.title)),
      "a book that shrinks silently reads as a bug in the queue",
    );
  });

  test("a lead moves by its owner, a customer by its sales AM", async () => {
    // ASSIGNED_TO_SQL reads owner_id for a lead and sales_am_id for a customer.
    // Writing only sales_am_id leaves every lead exactly where it was while
    // the screen reports it moved.
    const lead = await makeCustomer(priya.id, { kind: "lead", salesAmId: null });

    setTestUser(deepa);
    await updateAccountManagers({
      customerIds: [lead.id],
      salesAmId: rakesh.id,
      sales: { reasonCode: "Salesperson left" },
    });
    setTestUser(priya);

    const [after] = await db.select().from(customers).where(eq(customers.id, lead.id));
    assert.equal(after.ownerId, rakesh.id, "the lead did not actually move");
  });

  test("a reason is required, and Other has to say what it is", async () => {
    const customer = await makeCustomer(priya.id);
    setTestUser(deepa);

    const unknown = await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: rakesh.id,
      sales: { reasonCode: "Because I said so" },
    });
    assert.equal(unknown.ok, false, "an unlabelled reason was stored");

    const bare = await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: rakesh.id,
      sales: { reasonCode: "Other" },
    });
    assert.equal(bare.ok, false, "Other without a note tells nobody anything");

    const withNote = await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: rakesh.id,
      sales: { reasonCode: "Other", note: "Covering maternity leave" },
    });
    assert.equal(withNote.ok, true, withNote.ok ? "" : withNote.error);
    setTestUser(priya);
  });

  test("selecting an account that is already there changes nothing", async () => {
    // Selecting forty to move the six that are not already on the new manager
    // must not tell them they gained forty.
    const customer = await makeCustomer(priya.id);
    setTestUser(deepa);
    const res = await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: priya.id,
      sales: { reasonCode: "Workload rebalanced" },
    });
    setTestUser(priya);
    assert.equal(res.ok, true);

    assert.equal(
      (await db.select().from(customerAmChanges).where(eq(customerAmChanges.customerId, customer.id)))
        .length,
      0,
      "a no-op was written to the history",
    );
    const [after] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(after.amDecidedAt, null, "and it claimed a decision was made");
  });

  test("the nightly recompute does not put the old name back", async () => {
    // The quiet half of the guard. Holding sales_am_id while letting
    // recomputeSalesPeople rewrite sales_person_name gives the worst outcome
    // available: the account moves for scope and every screen still shows the
    // old name. Nobody reports that as a bug — they report that reassignment
    // does not work.
    const customer = await makeCustomer(priya.id, { name: "Shree Paints" });
    await stagePartyRow("Shree Paints", "Suresh");

    await recomputeSalesPeople();
    const [fromSheet] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(fromSheet.salesPersonName, "Suresh", "the sheet is the author until somebody decides");

    setTestUser(deepa);
    await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: rakesh.id,
      sales: { reasonCode: "Salesperson left" },
    });
    setTestUser(priya);

    await recomputeSalesPeople();
    const [after] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(after.salesPersonName, "Rakesh", "the sheet overwrote a decision");
    assert.equal(after.salesAmId, rakesh.id);
  });
});

/* ---------------------------------------------------------------------------
 * Who may hold a seat, and why each one moved.
 *
 * Two seats that move for different reasons, and two lists of people, because
 * only one of the seats decides whose calling queue an account lands in.
 * ------------------------------------------------------------------------- */

/**
 * A row on the HRMS employee master. The table is a MIRROR of a spreadsheet,
 * so it demands the bookkeeping columns — a row number, the raw cells and the
 * hash that makes an unchanged sheet cost no writes — none of which these
 * tests care about beyond their being present.
 */
let employeeRow = 0;
async function makeEmployee(name: string, status: "active" | "inactive") {
  const [row] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      employeeCode: `E-${++employeeRow}`,
      name,
      status,
      rowNumber: employeeRow,
      raw: {},
      rowHash: `hash-${employeeRow}`,
    })
    .returning();
  return row;
}

describe("the back office seat is a book too", () => {
  test("an account reaches whoever sells to it AND whoever does its paperwork", async () => {
    /*
     * Seema Roy signed in to "queue cleared for today" on a day she had 195
     * accounts to work: back office on all of them, sales on none, and every
     * scoped list read the sales seat alone.
     *
     * The back office team are telecallers who also do the dispatch and the
     * paperwork, so both seats are a book.
     */
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -60),
      cycleDays: 30,
      backOfficeAmId: rakesh.id,
    });

    setTestUser(priya);
    const forSales = await listCustomersPage({});
    assert.ok(
      forSales.rows.some((r) => r.id === customer.id),
      "the salesperson lost their own account",
    );

    setTestUser(rakesh);
    const forBackOffice = await listCustomersPage({});
    assert.ok(
      forBackOffice.rows.some((r) => r.id === customer.id),
      "the back office manager could not see an account they handle",
    );

    // And it is on their calling queue, which is the screen that was empty.
    const queue = await getQueue();
    assert.ok(
      queue.entries.some((e) => e.customerId === customer.id) ||
        queue.suppressed.some((h) => h.customerId === customer.id),
      "the account reached neither the queue nor the held-back strip",
    );
    setTestUser(priya);
  });

  test("it does not reach somebody who holds neither seat", async () => {
    const customer = await makeCustomer(priya.id, { backOfficeAmId: rakesh.id });

    const third = await makeUser("Third Person", "telecaller", manager.id);
    setTestUser(third);
    const page = await listCustomersPage({});
    assert.ok(
      !page.rows.some((r) => r.id === customer.id),
      "widening the rule leaked an account to a third person",
    );
    setTestUser(priya);
  });
});

describe("choosing an account manager", () => {
  test("the picker offers the staff list, not the reader's scope", async () => {
    // It was built from `listTeam()`, which is scoped — so an admin reading
    // My book was offered exactly one person, themselves, and a manager was
    // offered their own reporting line. Whose account it BECOMES is a fact
    // about the staff, not about the viewer.
    setTestUser(priya); // a telecaller: the narrowest scope there is
    const scoped = await listTeam();
    const assignable = await listAssignableUsers();

    assert.equal(scoped.length, 1, "a telecaller's scope is themselves");
    assert.ok(
      assignable.length > scoped.length,
      "the assignable list was filtered by the reader's own scope",
    );
    assert.ok(
      assignable.some((p) => p.id === manager.id) &&
        assignable.some((p) => p.id === deepa.id),
      "everybody who can hold a book is offered",
    );
  });

  test("an inactive account is never offered a book", async () => {
    const leaver = await makeUser("Gone Away", "telecaller", manager.id);
    await db.update(users).set({ active: false }).where(eq(users.id, leaver.id));

    const assignable = await listAssignableUsers();
    assert.ok(
      !assignable.some((p) => p.id === leaver.id),
      "somebody who has left was offered accounts",
    );
  });

  test("back office offers current employees; sales does not", async () => {
    await makeEmployee("Sunita Kale", "active");
    await makeEmployee("Long Gone", "inactive");

    const backOffice = await listBackOfficeCandidates();
    const sales = await listAssignableUsers();

    assert.ok(
      backOffice.some((p) => p.name === "Sunita Kale"),
      "the person who actually does the paperwork could not be named",
    );
    assert.ok(
      !backOffice.some((p) => p.name === "Long Gone"),
      "a leaver is not a valid answer to who handles this account",
    );
    assert.ok(
      !sales.some((p) => p.name === "Sunita Kale"),
      "sales drives the queue, so it cannot be somebody with no login",
    );
  });

  test("an employee can hold the back office seat, by name", async () => {
    const staff = await makeEmployee("Ramesh Jadhav", "active");
    const customer = await makeCustomer(priya.id);

    setTestUser(deepa);
    const res = await updateAccountManagers({
      customerIds: [customer.id],
      backOffice: { kind: "employee", employeeId: staff.id },
      backOfficeReason: { reasonCode: "Workload rebalanced" },
    });
    assert.equal(res.ok, true, res.ok ? "" : res.error);
    setTestUser(priya);

    const [after] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(after.backOfficeName, "Ramesh Jadhav");
    assert.equal(
      after.backOfficeAmId,
      null,
      "an employee has no account, and none may be invented for them",
    );

    const [change] = await db
      .select()
      .from(customerAmChanges)
      .where(eq(customerAmChanges.customerId, customer.id));
    assert.equal(change.role, "back_office");
    assert.equal(change.toName, "Ramesh Jadhav");
    assert.equal(change.toUserId, null);
  });

  test("the sales seat can hold an employee, by name, with no queue", async () => {
    // Four of the busiest salespeople on this book are employees with no
    // login. Refusing to record them meant the true answer could not be
    // written down at all.
    const staff = await makeEmployee("Prakash Vasudev Prasad", "active");
    const customer = await makeCustomer(priya.id);

    setTestUser(deepa);
    const res = await updateAccountManagers({
      customerIds: [customer.id],
      salesEmployeeId: staff.id,
      sales: { reasonCode: "Territory reassigned" },
    });
    assert.equal(res.ok, true, res.ok ? "" : res.error);
    setTestUser(priya);

    const [after] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(after.salesPersonName, "Prakash Vasudev Prasad");
    assert.equal(
      after.salesAmId,
      null,
      "an employee has no account, and none may be invented for them",
    );

    // And the consequence the screen warns about is real: nobody holds it.
    const [change] = await db
      .select()
      .from(customerAmChanges)
      .where(eq(customerAmChanges.customerId, customer.id));
    assert.equal(change.role, "sales");
    assert.equal(change.toName, "Prakash Vasudev Prasad");
    assert.equal(change.toUserId, null);
  });

  test("a sales seat cannot be an account and an employee at once", async () => {
    const staff = await makeEmployee("Two At Once", "active");
    const customer = await makeCustomer(priya.id);
    setTestUser(deepa);
    const res = await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: rakesh.id,
      salesEmployeeId: staff.id,
      sales: { reasonCode: "Workload rebalanced" },
    });
    setTestUser(priya);
    assert.equal(res.ok, false, "two people were accepted for one seat");
  });

  test("a leaver cannot be assigned by an old browser tab", async () => {
    const staff = await makeEmployee("Left Last Month", "inactive");
    const customer = await makeCustomer(priya.id);

    setTestUser(deepa);
    const res = await updateAccountManagers({
      customerIds: [customer.id],
      backOffice: { kind: "employee", employeeId: staff.id },
      backOfficeReason: { reasonCode: "Workload rebalanced" },
    });
    setTestUser(priya);
    assert.equal(res.ok, false, "a leaver was given the paperwork");
  });

  test("each seat carries its OWN reason", async () => {
    // The whole point: both seats moving at once is the ordinary case, and
    // "Salesperson left" stamped on the back office row said the dispatch
    // clerk changed because a salesperson resigned.
    const customer = await makeCustomer(priya.id, { backOfficeAmId: null });

    setTestUser(deepa);
    const res = await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: rakesh.id,
      backOffice: { kind: "user", userId: manager.id },
      sales: { reasonCode: "Salesperson left", note: "Priya resigned" },
      backOfficeReason: { reasonCode: "Workload rebalanced" },
    });
    assert.equal(res.ok, true, res.ok ? "" : res.error);
    setTestUser(priya);

    const rows = await db
      .select()
      .from(customerAmChanges)
      .where(eq(customerAmChanges.customerId, customer.id));
    const sales = rows.find((r) => r.role === "sales")!;
    const back = rows.find((r) => r.role === "back_office")!;

    assert.equal(sales.reasonCode, "Salesperson left");
    assert.equal(sales.note, "Priya resigned");
    assert.equal(back.reasonCode, "Workload rebalanced");
    assert.equal(back.note, null, "the sales note was copied onto both rows");
  });

  test("a seat that moves without a reason is refused", async () => {
    const customer = await makeCustomer(priya.id);

    setTestUser(deepa);
    const noReason = await updateAccountManagers({
      customerIds: [customer.id],
      salesAmId: rakesh.id,
    });
    assert.equal(noReason.ok, false, "an account moved with no reason at all");

    // And the reason belongs to the seat that moved: a sales reason does not
    // stand in for a back office change.
    const wrongSeat = await updateAccountManagers({
      customerIds: [customer.id],
      backOffice: { kind: "user", userId: manager.id },
      sales: { reasonCode: "Salesperson left" },
    });
    assert.equal(wrongSeat.ok, false, "one seat's reason answered for the other");
    setTestUser(priya);
  });

  test("moving between two employees is a change, not a no-op", async () => {
    // Both are name-only, so the id is null on each side. Comparing ids alone
    // would report "nothing to change" on a screen that had just been told
    // somebody new does the paperwork.
    const first = await makeEmployee("First Clerk", "active");
    const second = await makeEmployee("Second Clerk", "active");
    const customer = await makeCustomer(priya.id);

    setTestUser(deepa);
    await updateAccountManagers({
      customerIds: [customer.id],
      backOffice: { kind: "employee", employeeId: first.id },
      backOfficeReason: { reasonCode: "Workload rebalanced" },
    });
    const res = await updateAccountManagers({
      customerIds: [customer.id],
      backOffice: { kind: "employee", employeeId: second.id },
      backOfficeReason: { reasonCode: "Workload rebalanced" },
    });
    setTestUser(priya);
    assert.equal(res.ok, true, res.ok ? "" : res.error);

    const [after] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(after.backOfficeName, "Second Clerk");

    const rows = await db
      .select()
      .from(customerAmChanges)
      .where(eq(customerAmChanges.customerId, customer.id));
    assert.equal(rows.length, 2, "the second move left no history");
  });
});

describe("reversing a payment that had counted", () => {
  /** One bill, open, with a due date already past. */
  async function makeBill(customerId: string, over: { amount: number }) {
    const [row] = await db
      .insert(bills)
      .values({
        id: id("bil"),
        customerId,
        billNo: `MMI/${randomUUID().slice(0, 6)}`,
        billDate: addDays(TODAY, -40),
        dueDate: addDays(TODAY, -10),
        amount: over.amount,
        paidAmount: 0,
      })
      .returning();
    await recomputeBillStatuses();
    await recomputeOutstanding(customerId);
    return row;
  }

  test("the money goes back on the bill, and the receipt keeps its row", async () => {
    // A cheque clears and then bounces. Until now the only word for it was
    // "rejected", which says on the statement that the money never arrived —
    // wrong about a payment the customer genuinely made.
    const customer = await makeCustomer(priya.id);
    const bill = await makeBill(customer.id, { amount: 10_000_00 });

    setTestUser(deepa);
    const receipt = await recordReceipt({
      customerId: customer.id,
      amount: 10_000_00,
      receivedAt: TODAY,
      mode: "Cheque",
      reference: "CHQ-88231",
      // A cheque carries its own date now — the day it can be banked, which is
      // not the day it was handed over. Dated today: it cleared, and then it
      // bounced, which is what this test is about.
      instrumentDate: TODAY,
      allocation: "auto",
      idempotencyKey: randomUUID(),
    });
    assert.equal(receipt.ok, true, receipt.ok ? "" : receipt.error);

    const [settled] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(settled.paidAmount, 10_000_00, "the bill was not settled to begin with");

    const reversed = await reverseReceiptAction(
      receipt.ok ? receipt.data.receiptId : "",
      "Cheque bounced",
    );
    assert.equal(reversed.ok, true, reversed.ok ? "" : reversed.error);
    setTestUser(priya);

    // The money comes back to the bill it settled — a rebuild, not a
    // subtraction, which is why it lands on the same answer every time.
    const [owing] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(owing.paidAmount, 0, "the money did not come back");

    const [after] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(after.outstanding, 10_000_00, "outstanding did not follow");

    // The receipt is kept, not deleted. A payment that arrived and was taken
    // back is a fact about the account.
    const [row] = await db
      .select()
      .from(paymentReceipts)
      .where(eq(paymentReceipts.id, receipt.ok ? receipt.data.receiptId : ""));
    assert.ok(row, "the receipt was deleted");
    assert.equal(row.status, "reversed", "and it is not the same as rejected");
    assert.equal(row.rejectReason, "Cheque bounced");
    assert.equal(row.amount, 10_000_00, "it keeps what it was worth");
  });

  test("a reason is required, and only confirmed money can be reversed", async () => {
    const customer = await makeCustomer(priya.id);
    await makeBill(customer.id, { amount: 5_000_00 });

    // A telecaller's claim has not counted yet, so there is nothing to take
    // back — rejecting it is the honest answer, and being strict here is what
    // keeps the two words meaning different things.
    const reported = await recordReceipt({
      customerId: customer.id,
      amount: 5_000_00,
      receivedAt: TODAY,
      mode: "Cash",
      allocation: "auto",
      idempotencyKey: randomUUID(),
    });
    assert.equal(reported.ok, true, reported.ok ? "" : reported.error);
    const reportedId = reported.ok ? reported.data.receiptId : "";

    setTestUser(deepa);
    const noReason = await reverseReceiptAction(reportedId, "   ");
    assert.equal(noReason.ok, false, "a reversal with no reason was accepted");

    const notCounted = await reverseReceiptAction(reportedId, "Bounced");
    assert.equal(notCounted.ok, false, "a reported payment was reversed");
    setTestUser(priya);

    const [row] = await db
      .select()
      .from(paymentReceipts)
      .where(eq(paymentReceipts.id, reportedId));
    assert.equal(row.status, "reported", "and its status was changed anyway");
  });
});

/* ---------------------------------------------------------------------------
 * Money accounts are in the middle of finding.
 *
 * A hold is the pause between "somebody says this arrived" and "we found it".
 * What makes it worth its own status is the customer: they come off the
 * collections list entirely and stay off, because chasing somebody while we
 * are part-way through establishing that they paid is worse than any call not
 * made.
 * ------------------------------------------------------------------------- */

describe("putting a payment on hold", () => {
  async function overdueBill(customerId: string, amount: number) {
    const [row] = await db
      .insert(bills)
      .values({
        id: id("bil"),
        customerId,
        billNo: `MMI/${randomUUID().slice(0, 6)}`,
        billDate: addDays(TODAY, -60),
        dueDate: addDays(TODAY, -40),
        amount,
        paidAmount: 0,
      })
      .returning();
    await recomputeBillStatuses();
    await recomputeOutstanding(customerId);
    await recomputeFollowUpState(customerId);
    return row;
  }

  /** A telecaller's claim: reported, counting nothing. */
  async function reported(customerId: string, amount: number) {
    const r = await recordReceipt({
      customerId,
      amount,
      receivedAt: TODAY,
      mode: "Bank transfer",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    return r.ok ? r.data.receiptId : "";
  }

  test("holding takes the customer off collections, and the reason travels with them", async () => {
    const customer = await makeCustomer(priya.id);
    await overdueBill(customer.id, 20_000_00);
    const receiptId = await reported(customer.id, 20_000_00);

    setTestUser(deepa);
    const held = await holdReceiptAction(receiptId, "Looking for it in the August statement");
    assert.equal(held.ok, true, held.ok ? "" : held.error);
    setTestUser(priya);

    const plan = await getPaymentFollowUpPlan();
    assert.equal(
      plan.calls.some((c) => c.customerId === customer.id),
      false,
      "a customer whose money is being looked for was put on the calling list",
    );
    assert.equal(
      plan.messages.some((c) => c.customerId === customer.id),
      false,
      "and they were sent a reminder message anyway",
    );

    // Held back with the reason said plainly — never silently dropped, which
    // is the rule every held-back strip in this app is built on.
    const heldBack = plan.heldBack.find((h) => h.customerId === customer.id);
    assert.ok(heldBack, "the customer vanished instead of being held back with a reason");
    assert.match(heldBack.reason, /on hold/i);
    assert.match(heldBack.reason, /August statement/);
  });

  test("the quiet does NOT expire, which is the whole difference from a report", async () => {
    const customer = await makeCustomer(priya.id);
    await overdueBill(customer.id, 20_000_00);
    const receiptId = await reported(customer.id, 20_000_00);

    setTestUser(deepa);
    await holdReceiptAction(receiptId, "Checking the bank");
    // Backdated well past the window a bare report would have lapsed in. A
    // report is an unanswered claim and has to lapse, or a customer could
    // silence their own account for good; a hold is a named person's decision.
    await db
      .update(paymentReceipts)
      .set({ createdAt: new Date(Date.parse(`${addDays(TODAY, -60)}T09:00:00+05:30`)) })
      .where(eq(paymentReceipts.id, receiptId));
    setTestUser(priya);

    const plan = await getPaymentFollowUpPlan();
    assert.equal(
      plan.calls.some((c) => c.customerId === customer.id),
      false,
      "a sixty-day-old hold lapsed and the customer was chased",
    );
  });

  test("rejecting a hold puts them straight back on the list", async () => {
    const customer = await makeCustomer(priya.id);
    await overdueBill(customer.id, 20_000_00);
    const receiptId = await reported(customer.id, 20_000_00);

    setTestUser(deepa);
    await holdReceiptAction(receiptId, "Checking the bank");
    const rejected = await rejectReceiptAction(receiptId, "Never arrived — nothing in August");
    assert.equal(rejected.ok, true, rejected.ok ? "" : rejected.error);
    setTestUser(priya);

    const plan = await getPaymentFollowUpPlan();
    assert.equal(
      plan.calls.some((c) => c.customerId === customer.id),
      true,
      "money that turned out not to exist left the customer off the list",
    );
  });

  test("a hold needs a reason, and cannot be put on money already decided", async () => {
    const customer = await makeCustomer(priya.id);
    await overdueBill(customer.id, 5_000_00);
    const receiptId = await reported(customer.id, 5_000_00);

    setTestUser(deepa);
    const noReason = await holdReceiptAction(receiptId, "   ");
    assert.equal(noReason.ok, false, "a hold with nothing to say was accepted");

    const confirmed = await confirmReceiptAction(receiptId);
    assert.equal(confirmed.ok, true, confirmed.ok ? "" : confirmed.error);

    const tooLate = await holdReceiptAction(receiptId, "Second thoughts");
    assert.equal(tooLate.ok, false, "confirmed money was put on hold");
    setTestUser(priya);
  });

  test("a held payment can still be confirmed, and it counts from that moment", async () => {
    const customer = await makeCustomer(priya.id);
    const bill = await overdueBill(customer.id, 20_000_00);
    const receiptId = await reported(customer.id, 20_000_00);

    setTestUser(deepa);
    await holdReceiptAction(receiptId, "Checking the bank");

    const [duringHold] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(duringHold.paidAmount, 0, "a hold moved money, which it must never do");

    const confirmed = await confirmReceiptAction(receiptId);
    assert.equal(confirmed.ok, true, confirmed.ok ? "" : confirmed.error);
    setTestUser(priya);

    const [settled] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(settled.paidAmount, 20_000_00, "confirming a held payment settled nothing");
  });
});

/* ---------------------------------------------------------------------------
 * Where the money goes, decided at the point of confirming.
 * ------------------------------------------------------------------------- */

describe("re-pointing a payment on the way to confirming it", () => {
  test("accounts can settle a different bill, and only that bill moves", async () => {
    const customer = await makeCustomer(priya.id);
    const older = await (async () => {
      const [row] = await db
        .insert(bills)
        .values({
          id: id("bil"),
          customerId: customer.id,
          billNo: "MMI/OLD-1",
          billDate: addDays(TODAY, -80),
          dueDate: addDays(TODAY, -50),
          amount: 10_000_00,
          paidAmount: 0,
        })
        .returning();
      return row;
    })();
    const [newer] = await db
      .insert(bills)
      .values({
        id: id("bil"),
        customerId: customer.id,
        billNo: "MMI/NEW-1",
        billDate: addDays(TODAY, -10),
        dueDate: addDays(TODAY, 20),
        amount: 10_000_00,
        paidAmount: 0,
      })
      .returning();
    await recomputeOutstanding(customer.id);

    // Reported oldest-first, so it names the older bill.
    const receiptId = await (async () => {
      const r = await recordReceipt({
        customerId: customer.id,
        amount: 10_000_00,
        receivedAt: TODAY,
        mode: "Bank transfer",
        allocation: "auto",
        source: "collections_call",
        idempotencyKey: randomUUID(),
      });
      assert.equal(r.ok, true, r.ok ? "" : r.error);
      return r.ok ? r.data.receiptId : "";
    })();

    // The customer said it was for the new bill. Re-pointing is a person
    // deciding, which is why it is offered rather than worked out.
    setTestUser(deepa);
    const confirmed = await confirmReceiptAction(receiptId, {
      mode: "settle",
      selectedBillIds: [newer.id],
    });
    assert.equal(confirmed.ok, true, confirmed.ok ? "" : confirmed.error);
    setTestUser(priya);

    const [oldRow] = await db.select().from(bills).where(eq(bills.id, older.id));
    const [newRow] = await db.select().from(bills).where(eq(bills.id, newer.id));
    assert.equal(oldRow.paidAmount, 0, "the bill it was reported against was settled anyway");
    assert.equal(newRow.paidAmount, 10_000_00, "the bill accounts chose was not settled");

    // Exactly one set of lines: re-pointing replaces, it does not add.
    const lines = await db
      .select()
      .from(payments)
      .where(eq(payments.receiptId, receiptId));
    assert.equal(lines.length, 1, "the old allocation line was left behind");
    assert.equal(lines[0].billId, newer.id);
  });

  test("re-pointing it at the bill it already names is not blocked by its own money", async () => {
    // A bill offers `balance - what other undecided receipts claim of it`. Its
    // OWN claim has to come out of that, or a receipt confirmed against the
    // bill it was reported against would find its own money in the way.
    const customer = await makeCustomer(priya.id);
    const [bill] = await db
      .insert(bills)
      .values({
        id: id("bil"),
        customerId: customer.id,
        billNo: "MMI/SAME-1",
        billDate: addDays(TODAY, -30),
        dueDate: addDays(TODAY, -5),
        amount: 8_000_00,
        paidAmount: 0,
      })
      .returning();
    await recomputeOutstanding(customer.id);

    const r = await recordReceipt({
      customerId: customer.id,
      amount: 8_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    setTestUser(deepa);
    const confirmed = await confirmReceiptAction(r.ok ? r.data.receiptId : "", {
      mode: "settle",
      selectedBillIds: [bill.id],
    });
    assert.equal(confirmed.ok, true, confirmed.ok ? "" : confirmed.error);
    setTestUser(priya);

    const [row] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(row.paidAmount, 8_000_00);
  });
});

/* ---------------------------------------------------------------------------
 * A cheque has two dates, and they answer different questions.
 * ------------------------------------------------------------------------- */

describe("the date written on the cheque", () => {
  async function overdue(customerId: string, amount: number) {
    const [row] = await db
      .insert(bills)
      .values({
        id: id("bil"),
        customerId,
        billNo: `MMI/${randomUUID().slice(0, 6)}`,
        billDate: addDays(TODAY, -60),
        dueDate: addDays(TODAY, -40),
        amount,
        paidAmount: 0,
      })
      .returning();
    await recomputeBillStatuses();
    await recomputeOutstanding(customerId);
    await recomputeFollowUpState(customerId);
    return row;
  }

  test("a cheque without its date is refused, and a dateless mode may not carry one", async () => {
    const customer = await makeCustomer(priya.id);
    await overdue(customer.id, 10_000_00);

    const noDate = await recordReceipt({
      customerId: customer.id,
      amount: 10_000_00,
      receivedAt: TODAY,
      mode: "Cheque",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });
    assert.equal(noDate.ok, false, "a cheque was recorded with no date on it");

    // Asked of everybody, not only of whoever asserts the money arrived. A
    // customer who says they have paid by cheque is holding the cheque.
    const wrongMode = await recordReceipt({
      customerId: customer.id,
      amount: 10_000_00,
      receivedAt: TODAY,
      mode: "Cash",
      instrumentDate: addDays(TODAY, 10),
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });
    assert.equal(wrongMode.ok, false, "cash was given a date of its own");
  });

  test("a post-dated cheque keeps the customer off collections until it can be banked", async () => {
    const customer = await makeCustomer(priya.id);
    await overdue(customer.id, 10_000_00);

    const r = await recordReceipt({
      customerId: customer.id,
      amount: 10_000_00,
      receivedAt: TODAY,
      mode: "Cheque",
      reference: "CHQ-4471",
      instrumentDate: addDays(TODAY, 25),
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    // Backdated well past the window a bare report would have lapsed in: the
    // cheque still cannot be banked, so the customer still must not be chased.
    await db
      .update(paymentReceipts)
      .set({ createdAt: new Date(Date.parse(`${addDays(TODAY, -20)}T09:00:00+05:30`)) })
      .where(eq(paymentReceipts.id, r.ok ? r.data.receiptId : ""));

    const plan = await getPaymentFollowUpPlan();
    assert.equal(
      plan.calls.some((c) => c.customerId === customer.id),
      false,
      "chased for money sitting in our own drawer",
    );
    const heldBack = plan.heldBack.find((h) => h.customerId === customer.id);
    assert.ok(heldBack);
    assert.match(heldBack.reason, /cheque dated/i);
  });

  test("a cheque due to be banked is flagged for accounts; a post-dated one is not", async () => {
    const customer = await makeCustomer(priya.id);
    await overdue(customer.id, 20_000_00);

    const due = await recordReceipt({
      customerId: customer.id,
      amount: 10_000_00,
      receivedAt: addDays(TODAY, -5),
      mode: "Cheque",
      reference: "CHQ-1",
      instrumentDate: addDays(TODAY, -2),
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });
    const later = await recordReceipt({
      customerId: customer.id,
      amount: 5_000_00,
      receivedAt: TODAY,
      mode: "Cheque",
      reference: "CHQ-2",
      instrumentDate: addDays(TODAY, 15),
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });
    assert.equal(due.ok && later.ok, true);

    setTestUser(deepa);
    const pending = await pendingReceipts();
    setTestUser(priya);

    const bankable = pending.find((p) => p.reference === "CHQ-1");
    const postDated = pending.find((p) => p.reference === "CHQ-2");
    assert.ok(bankable && postDated);

    assert.equal(bankable.bankableNow, true, "a cheque dated two days ago is bankable");
    assert.equal(bankable.bankableDays, 2);
    assert.equal(
      postDated.bankableNow,
      false,
      "a post-dated cheque was flagged as something to go and find",
    );
  });
});

/* ---------------------------------------------------------------------------
 * A reported payment does not make a bill look settled.
 * ------------------------------------------------------------------------- */

describe("a bill with money reported against it", () => {
  test("keeps its whole balance, and accounts can still record against it", async () => {
    /*
     * The bill offered `balance - reported` once, so a bill fully claimed by a
     * telecaller's unconfirmed report had nothing left to allocate — and
     * accounts holding the bank statement could not record the very money they
     * were looking at. The customer still owed it, because nothing unconfirmed
     * ever touches `paid_amount`, so the ledger and the entry screen disagreed
     * about the same bill.
     */
    const customer = await makeCustomer(priya.id);
    const [bill] = await db
      .insert(bills)
      .values({
        id: id("bil"),
        customerId: customer.id,
        billNo: "MMI/REP-1",
        billDate: addDays(TODAY, -40),
        dueDate: addDays(TODAY, -10),
        amount: 30_000_00,
        paidAmount: 0,
      })
      .returning();
    await recomputeOutstanding(customer.id);

    const reported = await recordReceipt({
      customerId: customer.id,
      amount: 30_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });
    assert.equal(reported.ok, true, reported.ok ? "" : reported.error);

    // Nothing unconfirmed touches the ledger.
    const [stillOwed] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(stillOwed.paidAmount, 0, "a reported payment settled a bill");

    // And the bill still offers its whole balance, with the claim shown beside
    // it rather than subtracted from it.
    setTestUser(deepa);
    const open = await openBillsFor(customer.id);
    const row = open.find((b) => b.id === bill.id);
    assert.ok(row, "the bill vanished from what is open");
    assert.equal(row.balance, 30_000_00, "the balance was reduced by an unconfirmed claim");
    assert.equal(row.reported, 30_000_00, "and the claim was not shown at all");

    // Accounts, holding the statement, record it as a SEPARATE payment. The
    // duplicate matcher is what asks whether it is the same money; nothing
    // here silently refuses the entry.
    const byAccounts = await recordReceipt({
      customerId: customer.id,
      amount: 30_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      reference: "UTR-990011",
      allocation: "settle",
      selectedBillIds: [bill.id],
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      byAccounts.ok,
      true,
      byAccounts.ok ? "" : `accounts could not record against the bill: ${byAccounts.error}`,
    );

    const [settled] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(settled.paidAmount, 30_000_00, "confirmed money did not settle the bill");
  });

  test("a HELD claim shows on the bill too, and still does not settle it", async () => {
    // A hold is still somebody claiming this money settles this bill. Counting
    // only `reported` would show the bill as unclaimed while a person in
    // accounts is actively looking for the very payment against it.
    const customer = await makeCustomer(priya.id);
    const [bill] = await db
      .insert(bills)
      .values({
        id: id("bil"),
        customerId: customer.id,
        billNo: "MMI/HELD-1",
        billDate: addDays(TODAY, -40),
        dueDate: addDays(TODAY, -10),
        amount: 12_000_00,
        paidAmount: 0,
      })
      .returning();
    await recomputeOutstanding(customer.id);

    const r = await recordReceipt({
      customerId: customer.id,
      amount: 12_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    setTestUser(deepa);
    await holdReceiptAction(r.ok ? r.data.receiptId : "", "Looking for it");
    const open = await openBillsFor(customer.id);
    setTestUser(priya);

    const row = open.find((b) => b.id === bill.id);
    assert.ok(row, "the bill disappeared while its money was on hold");
    assert.equal(row.balance, 12_000_00, "a hold moved the balance");
    assert.equal(row.reported, 12_000_00, "the held claim was not shown against the bill");
  });
});

/* ---------------------------------------------------------------------------
 * One payment, written down twice.
 * ------------------------------------------------------------------------- */

describe("the same money, entered from the bank statement", () => {
  async function claim(customerId: string, over: { amount: number; reference?: string }) {
    const r = await recordReceipt({
      customerId,
      amount: over.amount,
      receivedAt: TODAY,
      mode: "Bank transfer",
      reference: over.reference,
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    return r.ok ? r.data.receiptId : "";
  }

  test("an exact amount is offered, and it is the telecaller's claim that comes back", async () => {
    const customer = await makeCustomer(priya.id);
    const receiptId = await claim(customer.id, { amount: 50_000_00 });

    setTestUser(deepa);
    const found = await matchesForEntryAction(customer.id, {
      amount: 50_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      reference: "UTR-778899",
    });
    setTestUser(priya);

    assert.equal(found.ok, true);
    if (!found.ok) return;
    assert.equal(found.data.length, 1, "the payment already recorded was not offered");
    assert.equal(found.data[0].candidate.receiptId, receiptId);
    assert.equal(found.data[0].blocking, true, "an exact match must not be walked past");
  });

  test("confirming a match writes NO second receipt, and takes accounts' reference", async () => {
    const customer = await makeCustomer(priya.id);
    const [bill] = await db
      .insert(bills)
      .values({
        id: id("bil"),
        customerId: customer.id,
        billNo: "MMI/DUP-1",
        billDate: addDays(TODAY, -30),
        dueDate: addDays(TODAY, -5),
        amount: 50_000_00,
        paidAmount: 0,
      })
      .returning();
    await recomputeOutstanding(customer.id);

    // The telecaller had no UTR — they were repeating what the customer said.
    const receiptId = await claim(customer.id, { amount: 50_000_00 });

    setTestUser(deepa);
    const merged = await confirmAsMatchAction({
      receiptId,
      confirmAmount: 50_000_00,
      reference: "UTR-778899",
      receivedAt: TODAY,
      mode: "Bank transfer",
    });
    assert.equal(merged.ok, true, merged.ok ? "" : merged.error);
    setTestUser(priya);

    const all = await db
      .select()
      .from(paymentReceipts)
      .where(eq(paymentReceipts.customerId, customer.id));
    assert.equal(all.length, 1, "a second receipt was written for one payment");
    assert.equal(all[0].status, "confirmed");
    assert.equal(
      all[0].reference,
      "UTR-778899",
      "the reference off the bank statement was not written onto it",
    );

    const [settled] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(settled.paidAmount, 50_000_00, "the bill was not settled once");
  });

  test("the typed amount is checked on the SERVER, not only in the dialog", async () => {
    const customer = await makeCustomer(priya.id);
    const receiptId = await claim(customer.id, { amount: 50_000_00 });

    setTestUser(deepa);
    const wrong = await confirmAsMatchAction({
      receiptId,
      confirmAmount: 5_000_00,
      reference: "UTR-778899",
    });
    assert.equal(wrong.ok, false, "a merge went through on the wrong amount");
    setTestUser(priya);

    const [row] = await db
      .select()
      .from(paymentReceipts)
      .where(eq(paymentReceipts.id, receiptId));
    assert.equal(row.status, "reported", "and it was confirmed anyway");
  });

  test("a hold is offered as a match, and confirming it ends the hold", async () => {
    const customer = await makeCustomer(priya.id);
    const receiptId = await claim(customer.id, { amount: 50_000_00 });

    setTestUser(deepa);
    await holdReceiptAction(receiptId, "Looking for it");

    const found = await matchesForEntryAction(customer.id, {
      amount: 50_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      reference: null,
    });
    assert.equal(found.ok, true);
    if (!found.ok) return;
    assert.equal(found.data[0]?.candidate.status, "held", "the hold was not offered");

    const merged = await confirmAsMatchAction({ receiptId, confirmAmount: 50_000_00 });
    assert.equal(merged.ok, true, merged.ok ? "" : merged.error);
    setTestUser(priya);

    const [row] = await db
      .select()
      .from(paymentReceipts)
      .where(eq(paymentReceipts.id, receiptId));
    assert.equal(row.status, "confirmed");
  });

  test("confirmed money is never offered as a match", async () => {
    // Offering it would invite somebody to confirm one payment twice, which is
    // the exact failure this whole path exists to prevent.
    const customer = await makeCustomer(priya.id);
    const receiptId = await claim(customer.id, { amount: 50_000_00 });

    setTestUser(deepa);
    await confirmReceiptAction(receiptId);
    const found = await matchesForEntryAction(customer.id, {
      amount: 50_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      reference: null,
    });
    setTestUser(priya);

    assert.equal(found.ok, true);
    if (!found.ok) return;
    assert.equal(found.data.length, 0, "money already in the ledger was offered again");
  });
});

/* ---------------------------------------------------------------------------
 * The day's call list, settled once.
 *
 * What is frozen is the composition; what stays live is whether each row still
 * needs doing. Both halves are load-bearing and both are pinned here.
 * ------------------------------------------------------------------------- */

describe("the call list is settled once a day", () => {
  test("the second read returns the list the first one built", async () => {
    await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      cycleIsDefault: false,
    });

    setTestUser(priya);
    const first = await getQueue();
    assert.ok(first.entries.length >= 1);

    // A customer who becomes due mid-morning does NOT join today's list.
    await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      cycleIsDefault: false,
      name: "Arrived After The List Was Settled",
    });

    const second = await getQueue();
    assert.deepEqual(
      second.entries.map((e) => e.customerId),
      first.entries.map((e) => e.customerId),
      "the list reshuffled under the telecaller",
    );
  });

  test("but a customer who orders drops off it at once", async () => {
    // The specification is most emphatic about this: a frozen list must not go
    // on asking for an order somebody has already placed.
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      cycleIsDefault: false,
    });

    setTestUser(priya);
    const before = await getQueue();
    assert.ok(before.entries.some((e) => e.customerId === customer.id));

    await db
      .update(customers)
      .set({ lastOrderDate: TODAY })
      .where(eq(customers.id, customer.id));

    const after = await getQueue();
    assert.equal(
      after.entries.some((e) => e.customerId === customer.id),
      false,
      "still being chased for an order they have placed",
    );
    assert.ok(
      after.suppressed.some((h) => h.customerId === customer.id),
      "and it vanished silently rather than saying why",
    );
  });

  test("a promise falling due today reopens the settled list", async () => {
    setTestUser(priya);
    await getQueue(); // settle the day, empty

    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -3),
      cycleDays: 30,
      cycleIsDefault: false,
    });
    await db.insert(reminders).values({
      id: id("rem"),
      customerId: customer.id,
      assignedUserId: priya.id,
      createdByUserId: priya.id,
      dueDate: TODAY,
      note: "They asked for a call today",
      status: "pending",
    });

    const after = await getQueue();
    assert.ok(
      after.entries.some((e) => e.customerId === customer.id),
      "a promise made to a customer waited for tomorrow's list",
    );
  });

  test("the job builds the same list, and never overwrites one in use", async () => {
    await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      cycleIsDefault: false,
    });

    // Built before anybody signs in.
    const written = await snapshotQueue(TODAY);
    assert.ok(written >= 1, "the warmer built nothing");

    setTestUser(priya);
    const served = await getQueue();
    assert.ok(served.entries.length >= 1);

    // Re-running at noon must not reshuffle an afternoon.
    const again = await snapshotQueue(TODAY);
    assert.equal(again, 0, "a re-run rebuilt a list already in use");
    const unchanged = await getQueue();
    assert.deepEqual(
      unchanged.entries.map((e) => e.customerId),
      served.entries.map((e) => e.customerId),
    );
  });

  /*
   * The rebuild is the deliberate exception to all of the above. A release
   * that changes WHO belongs on a list is invisible until tomorrow otherwise,
   * and somebody has to be able to decide that today is the day.
   */
  test("a rebuild is refused to everybody but an administrator", async () => {
    await snapshotQueue(TODAY);

    setTestUser(priya);
    const asTelecaller = await rebuildQueues(null);
    assert.equal(asTelecaller.ok, false, "a telecaller rebuilt a call list");

    // A manager is NOT enough, deliberately: rebuilding reorders the day of
    // the people whose numbers the manager is measured on.
    setTestUser(manager);
    const asManager = await rebuildQueues(null);
    assert.equal(asManager.ok, false, "a manager rebuilt a call list");
    assert.match(asManager.ok ? "" : asManager.error, /administrator/i);
  });

  test("an administrator's rebuild picks up what the settled list could not", async () => {
    await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      cycleIsDefault: false,
    });
    await snapshotQueue(TODAY);
    setTestUser(priya);
    const before = await getQueue();

    // Somebody who qualifies, arriving after the day was settled. The warmer
    // cannot add them — that is the whole point of settling — so the list
    // stays exactly as long as it was.
    const late = await makeCustomer(priya.id, {
      name: "Arrived After The List Was Settled",
      lastOrderDate: addDays(TODAY, -60),
      cycleDays: 22,
      cycleIsDefault: false,
    });
    assert.equal(await snapshotQueue(TODAY), 0);
    const stillSettled = await getQueue();
    assert.equal(stillSettled.entries.length, before.entries.length);

    const admin = await makeUser("Console Admin", "admin");
    await db.insert(appAccess).values({ id: id("aca"), userId: admin.id, app: "admin" });
    setTestUser(admin);
    const rebuilt = await rebuildQueues([priya.id]);
    assert.equal(rebuilt.ok, true, rebuilt.ok ? "" : rebuilt.error);

    setTestUser(priya);
    const after = await getQueue();
    assert.ok(
      after.entries.some((e) => e.customerId === late.id),
      "the rebuild did not pick up a customer who qualified after the list was settled",
    );
  });

  test("rebuilding one telecaller leaves everybody else's list alone", async () => {
    await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      cycleIsDefault: false,
    });
    await makeCustomer(rakesh.id, {
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      cycleIsDefault: false,
    });
    await snapshotQueue(TODAY);

    const stampFor = async (userId: string) =>
      (
        await db
          .select({ generatedAt: queueSnapshotsTable.generatedAt })
          .from(queueSnapshotsTable)
          .where(
            and(
              eq(queueSnapshotsTable.day, TODAY),
              eq(queueSnapshotsTable.userId, userId),
            ),
          )
          .limit(1)
      )[0]?.generatedAt;

    const rakeshBefore = await stampFor(rakesh.id);
    assert.ok(rakeshBefore, "rakesh had no list to leave alone");

    const admin = await makeUser("Narrow Admin", "admin");
    await db.insert(appAccess).values({ id: id("aca"), userId: admin.id, app: "admin" });
    setTestUser(admin);
    assert.equal((await rebuildQueues([priya.id])).ok, true);

    assert.deepEqual(
      await stampFor(rakesh.id),
      rakeshBefore,
      "rebuilding one telecaller threw away another's list",
    );
  });
});

/* ---------------------------------------------------------------------------
 * "No order today" has to end with a date, or with somebody saying there
 * isn't one. It is the most common answer on the phone and it used to end the
 * call with nothing.
 * ------------------------------------------------------------------------- */

describe("No order, and when we ring back", () => {
  test("saving it without an answer is refused", async () => {
    const customer = await makeCustomer(priya.id);
    const r = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, false, "a no-order call saved without saying when to call back");
    // Refused in the SERVICE, not only on the form — a mandatory field that is
    // only mandatory in the browser is not mandatory.
    assert.match(r.ok ? "" : r.error, /call back|commit/i);
  });

  test("a date they gave becomes a reminder, and beats the cooldown", async () => {
    const customer = await makeCustomer(priya.id);
    const when = addDays(TODAY, 12);

    const r = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      noOrderNextCallDate: when,
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const [rem] = await db
      .select()
      .from(reminders)
      .where(eq(reminders.customerId, customer.id));
    assert.ok(rem, "the date they gave produced no reminder");
    assert.equal(rem.dueDate, when, "and it is not the day they named");
    assert.equal(rem.type, "call_back");
  });

  test("no commitment writes no reminder, and the wait decides", async () => {
    const customer = await makeCustomer(priya.id);
    const r = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      noOrderNoCommitment: true,
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    assert.equal(
      (await db.select().from(reminders).where(eq(reminders.customerId, customer.id))).length,
      0,
      "a customer who committed to nothing was given a reminder anyway",
    );
  });

  test("a date in the past is refused, and so is answering both ways", async () => {
    const customer = await makeCustomer(priya.id);

    const past = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      noOrderNextCallDate: addDays(TODAY, -1),
      idempotencyKey: randomUUID(),
    });
    assert.equal(past.ok, false, "the next call was scheduled in the past");

    const both = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      noOrderNextCallDate: addDays(TODAY, 3),
      noOrderNoCommitment: true,
      idempotencyKey: randomUUID(),
    });
    assert.equal(both.ok, false, "they both gave a date and gave none");
  });

  test("the default wait is five days", async () => {
    // A floor rather than the usual answer: most no-order calls now carry a
    // date, and a reminder outranks every cooldown. This is what is left when
    // the customer would not say.
    const config = await getConfig();
    assert.equal(config["queue.outcomeCooldownDays"].no_order, 5);
  });
});

describe("The next call reaches the lists a telecaller works from", () => {
  test("the customers list carries it, and only where somebody has called", async () => {
    /*
     * The dialog says it once, at the moment a call is saved, and then it was
     * gone: to find out when a customer comes back you opened their record.
     * The two screens where somebody is deciding who to work — the book and
     * the call history — could not answer it at all.
     *
     * It is the STORED answer, not a fresh reading: what the screen told the
     * person who logged the call, on the day they logged it. That is why the
     * column is empty on a customer nobody has called rather than filled with
     * a prediction nobody has been told.
     */
    const called = await makeCustomer(priya.id, { name: "Has Been Called" });
    const untouched = await makeCustomer(priya.id, { name: "Never Called" });
    const when = addDays(TODAY, 9);

    setTestUser(priya);
    const saved = await saveInteraction({
      customerId: called.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      noOrderNextCallDate: when,
      idempotencyKey: randomUUID(),
    });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);

    const page = await listCustomersPage({});
    const withCall = page.rows.find((r) => r.id === called.id)!;
    const without = page.rows.find((r) => r.id === untouched.id)!;

    assert.ok(withCall.nextStep, "the call was logged and the list knows nothing");
    assert.equal(withCall.nextStep!.kind, saved.ok ? saved.data.nextStep?.kind : null);
    assert.equal(withCall.nextStep!.date, saved.ok ? saved.data.nextStep?.date : null);
    assert.equal(
      withCall.nextStep!.toldOn,
      TODAY,
      "the day it was said is what makes a stale date readable as stale",
    );
    assert.equal(without.nextStep, null, "a customer nobody has called carried a next call");
  });

  test("the LATEST call is the one the list shows", async () => {
    // Two calls in a day is ordinary — they rang back, or the customer did.
    // The column has to be the last thing anybody was told, not the first.
    const customer = await makeCustomer(priya.id);
    setTestUser(priya);

    await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      noOrderNextCallDate: addDays(TODAY, 3),
      idempotencyKey: randomUUID(),
    });
    const second = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      noOrderNextCallDate: addDays(TODAY, 20),
      idempotencyKey: randomUUID(),
    });
    assert.equal(second.ok, true, second.ok ? "" : second.error);

    const page = await listCustomersPage({});
    const row = page.rows.find((r) => r.id === customer.id)!;
    assert.equal(
      row.nextStep!.date,
      second.ok ? second.data.nextStep?.date : null,
      "the list showed an older call's answer",
    );
  });

  test("the call history carries what THAT call said, per row", async () => {
    const customer = await makeCustomer(priya.id);
    setTestUser(priya);
    const saved = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      noOrderNextCallDate: addDays(TODAY, 6),
      idempotencyKey: randomUUID(),
    });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);

    const rows = await listInteractions();
    const row = rows.find((r) => r.customerId === customer.id)!;
    assert.ok(row.nextStep, "the history row lost the sentence the call carried");
    assert.equal(row.nextStep!.date, saved.ok ? saved.data.nextStep?.date : null);
    assert.equal(row.nextStep!.toldOn, TODAY);
  });

  test("a customer nothing will bring back says so, with no date invented", async () => {
    // `none` and `decide` carry no date, and the word IS the answer. A blank
    // cell there would read as missing data rather than as "nothing is coming".
    const customer = await makeCustomer(priya.id);
    await db
      .update(customers)
      .set({ doNotContact: true })
      .where(eq(customers.id, customer.id));

    setTestUser(priya);
    await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      noOrderNoCommitment: true,
      idempotencyKey: randomUUID(),
    });

    const page = await listCustomersPage({});
    const row = page.rows.find((r) => r.id === customer.id)!;
    assert.equal(row.nextStep!.kind, "none");
    assert.equal(row.nextStep!.date, null, "a date was invented for a customer nothing will ring");
  });
});

describe("What the telecaller was told would happen next", () => {
  test("the sentence is returned AND written onto the call", async () => {
    const customer = await makeCustomer(priya.id);
    const when = addDays(TODAY, 12);

    const r = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      noOrderNextCallDate: when,
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (!r.ok) return;

    const step = r.data.nextStep;
    assert.ok(step, "nothing was worked out at all");

    /*
     * The headline is the EARLIEST day this customer comes back — on a brand
     * new record that is the prospect cadence, which lands before the callback
     * the customer asked for. Both are true and both have to be said: the day
     * the name reappears, and the promise sitting behind it.
     */
    assert.ok(step.date && step.date <= when, "the date is not the earliest one");
    assert.match(
      step.detail,
      /promised them a callback/i,
      "the callback the telecaller just committed to was never mentioned",
    );

    const [row] = await db
      .select()
      .from(calls)
      .where(eq(calls.id, r.data.interactionId));

    assert.equal(row.nextStepKind, step.kind, "nothing was stored on the call");
    assert.equal(row.nextStepDate, step.date);
    assert.equal(row.nextStepHeadline, step.headline, "the words shown were not kept");
    assert.equal(row.nextStepDetail, step.detail);
    // Stored so the question "what did we tell them" survives the customer
    // ordering tomorrow and every rule around them changing afterwards.
    assert.ok(row.nextStepReason, "the reason behind the date was not kept");
  });

  test("a double-click gets the SAME sentence back, not a fresh reading", async () => {
    const customer = await makeCustomer(priya.id);
    const key = randomUUID();
    const input = {
      customerId: customer.id,
      interactionType: "outbound_call" as const,
      outcome: "no_order" as const,
      noOrderNextCallDate: addDays(TODAY, 9),
      idempotencyKey: key,
    };

    const first = await saveInteraction(input);
    const second = await saveInteraction(input);
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;

    assert.equal(second.data.duplicate, true);
    assert.equal(
      second.data.nextStep?.headline,
      first.data.nextStep?.headline,
      "the second click showed a different answer to the first",
    );
    assert.equal(second.data.nextStep?.date, first.data.nextStep?.date);
  });

  test("a customer marked do not contact is told so, with no date invented", async () => {
    const customer = await makeCustomer(priya.id);
    await db
      .update(customers)
      .set({ doNotContact: true })
      .where(eq(customers.id, customer.id));

    const r = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      noOrderNoCommitment: true,
      idempotencyKey: randomUUID(),
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (!r.ok) return;

    assert.equal(r.data.nextStep?.kind, "none");
    assert.equal(r.data.nextStep?.date, null, "a date was invented for a customer nothing will ring");
  });
});

/* ---------------------------------------------------------------------------
 * Most of what the CRM calls a lead is a shop served by a distributor. The
 * provision to say so — without anything saying it automatically.
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * The record of a four-year account, on a page that does not grow with it.
 * ------------------------------------------------------------------------- */

describe("the customer timeline is a page", () => {
  /** A book like COLOUR CAMP's: many bills, all stamped midnight. */
  async function billedCustomer(n: number) {
    const customer = await makeCustomer(priya.id);
    await db.insert(bills).values(
      Array.from({ length: n }, (_, i) => ({
        id: id("bil"),
        customerId: customer.id,
        // The same DATE on purpose. `bill_date` is a date, so a hundred bills
        // raised across one week share a handful of midnight timestamps —
        // which is exactly what breaks a sort with no tiebreaker.
        //
        // SEVEN to a day, deliberately NOT a multiple of any page size used
        // below. At twenty a day with pages of twenty, every page ended
        // exactly on a date boundary and a cursor that skipped whole
        // timestamps still came out right — the fixture passed a test of the
        // thing it was meant to break.
        billNo: `MMI/26-27/${1000 + i}`,
        billDate: addDays(TODAY, -Math.floor(i / 7)),
        dueDate: addDays(TODAY, 30),
        amount: 1_000_00 + i,
        paidAmount: 0,
      })),
    );
    return customer;
  }

  test("the first page is a page, and it says what it is a page of", async () => {
    const customer = await billedCustomer(60);
    setTestUser(priya);

    const page = await customerTimeline(customer.id, { limit: 25 });
    assert.equal(page.entries.length, 25, "the page was not the size asked for");
    assert.equal(page.more, true, "a capped read did not say there was more");
    assert.ok(page.cursor, "a page with more after it carried no cursor");

    // The COUNTS are the whole history, not the page. The pills print these,
    // and printing "Bill 25" against an account with sixty is the reason the
    // page used to read every row it had.
    const counts = await customerTimelineCounts(customer.id);
    assert.equal(counts.Bill, 60);
    assert.equal(counts.all, 60);
  });

  test("paging never repeats a row and never loses one", async () => {
    const customer = await billedCustomer(55);
    setTestUser(priya);

    const seen: string[] = [];
    const pages: string[] = [];
    let cursor: { at: string; id: string } | null = null;
    for (let i = 0; i < 10; i++) {
      const page: Awaited<ReturnType<typeof customerTimeline>> =
        await customerTimeline(customer.id, {
          limit: 20,
          before: cursor ?? undefined,
        });
      seen.push(...page.entries.map((e) => e.id));
      pages.push(
        `page ${i + 1}: ${page.entries.length} rows, more=${page.more}, ` +
          `cursor=${page.cursor?.at} ${page.cursor?.id}`,
      );
      cursor = page.cursor;
      if (!page.more) break;
    }

    /*
     * WHAT THE DATABASE THINKS, printed when this fails.
     *
     * It passed on a developer's macOS Postgres and failed on CI's
     * postgres:16, which is the signature of something the two databases
     * disagree about rather than something the code gets wrong — the sort key
     * is text, and text ordering is a property of the database's collation.
     * A failure nobody can reproduce locally has to carry its own evidence.
     */
    const repeated = seen.filter((v, i) => seen.indexOf(v) !== i);
    const [env] = await db.execute<{
      v: string;
      tz: string;
      datcollate: string;
    }>(sql`
      select version() as v, current_setting('TimeZone') as tz, datcollate
        from pg_database where datname = current_database()`);
    const evidence = [
      env?.v,
      `TimeZone=${env?.tz} collate=${env?.datcollate}`,
      ...pages,
      `repeated: ${repeated.join(", ") || "none"}`,
    ].join("\n      ");

    assert.equal(seen.length, 55, `paging lost rows or invented them\n      ${evidence}`);
    assert.equal(
      new Set(seen).size,
      55,
      `a row came back on two pages - the sort has no tiebreaker\n      ${evidence}`,
    );
  });

  test("a page read on one session zone pages correctly on another", async () => {
    /*
     * THE BUG THIS EXISTS FOR, and it is the codebase's oldest rule wearing
     * its third disguise.
     *
     * `bills.bill_date` is a DATE, and a date is not an instant until
     * something says which midnight is meant. `bill_date::timestamptz` asks
     * Postgres, and Postgres answers with the SESSION's zone — so the same
     * bill came back as 00:00Z on one pooled connection and 18:30Z on
     * another, in one process, because an earlier test in this file leaves a
     * connection in Asia/Kolkata while the rest sit on the server default. A
     * cursor taken from one page then excluded nothing on the next and five
     * rows came back twice.
     *
     * It passed on a developer's machine for the reason the rule always
     * survives: local Postgres runs in Asia/Kolkata, so both halves agreed.
     * CI runs in UTC and caught it. This forces the mixture rather than
     * waiting for the pool to produce it.
     */
    const customer = await billedCustomer(55);
    setTestUser(priya);

    const everyConnection = (zone: string) =>
      Promise.all(
        Array.from({ length: 12 }, () =>
          db.execute(sql.raw(`set time zone '${zone}'`)),
        ),
      );

    try {
      await everyConnection("GMT");
      const first = await customerTimeline(customer.id, { limit: 20 });
      await everyConnection("Asia/Kolkata");
      const second = await customerTimeline(customer.id, {
        limit: 20,
        before: first.cursor ?? undefined,
      });

      const firstIds = new Set(first.entries.map((e) => e.id));
      const repeated = second.entries.filter((e) => firstIds.has(e.id));
      assert.deepEqual(
        repeated.map((e) => e.id),
        [],
        "a cursor taken in one session zone re-read rows in another",
      );
    } finally {
      // Whatever happens, the pool goes back to what the rest of the file
      // expects — a connection left in GMT is a booby trap for every test
      // after this one.
      await everyConnection("Asia/Kolkata");
    }
  });

  test("a kind reads the whole history, not the loaded page", async () => {
    const customer = await billedCustomer(40);
    // One call, older than every bill. Under the old screen-side filter it
    // would be invisible unless somebody had already loaded past forty bills.
    await db.insert(calls).values({
      id: id("cal"),
      customerId: customer.id,
      userId: priya.id,
      startedAt: new Date(`${addDays(TODAY, -400)}T09:00:00+05:30`),
      connectionStatus: "connected",
      outcome: "order_taken",
      notes: "The oldest thing on this account",
      idempotencyKey: randomUUID(),
    });
    setTestUser(priya);

    const newest = await customerTimeline(customer.id, { limit: 20 });
    assert.ok(
      !newest.entries.some((e) => e.kind === "Call"),
      "the fixture is wrong - the call was not older than the bills",
    );

    const calls20 = await customerTimeline(customer.id, {
      limit: 20,
      kind: "Call",
    });
    assert.equal(calls20.entries.length, 1);
    assert.equal(calls20.entries[0].content, "The oldest thing on this account");
    assert.equal(calls20.more, false, "one call was reported as a partial list");
  });

  test("the reader has to be allowed to see the customer", async () => {
    const customer = await billedCustomer(1);
    setTestUser(rakesh);
    const refused = await loadCustomerTimeline(customer.id);
    assert.equal(refused.ok, false, "another telecaller's account was paged");

    setTestUser(priya);
    const allowed = await loadCustomerTimeline(customer.id);
    assert.equal(allowed.ok, true, allowed.ok ? "" : allowed.error);
  });
});

describe("third-party customers and their distributors", () => {
  /** A distributor is an account we bill, so every test needs one. */
  async function makeDistributor(name = "Distributor Alpha") {
    return makeCustomer(priya.id, { name, kind: "customer" });
  }

  test("converting is a manager's, and it is checked in the action", async () => {
    const shop = await makeCustomer(priya.id, { kind: "lead" });
    const distributor = await makeDistributor();

    setTestUser(priya);
    const asTelecaller = await convertToThirdParty({
      customerIds: [shop.id],
      distributors: [{ distributorId: distributor.id }],
    });
    assert.equal(asTelecaller.ok, false, "a telecaller reclassified an account");

    setTestUser(manager);
    const asManager = await convertToThirdParty({
      customerIds: [shop.id],
      distributors: [{ distributorId: distributor.id, isPrimary: true }],
    });
    assert.equal(asManager.ok, true, asManager.ok ? "" : asManager.error);

    const [row] = await db
      .select({ thirdParty: customers.thirdParty, kind: customers.kind })
      .from(customers)
      .where(eq(customers.id, shop.id));
    assert.equal(row.thirdParty, true);
    // The KIND is untouched. Being a shop we deliver to is how we work the
    // account, not what the account is — and we may still bill it one day.
    assert.equal(row.kind, "lead", "converting changed what the record is");

    const links = await distributorsFor(shop.id);
    assert.equal(links.length, 1);
    assert.equal(links[0].customerId, distributor.id);
    assert.equal(links[0].isPrimary, true);
  });

  test("a conversion with no distributor is refused, and nothing is marked", async () => {
    const shop = await makeCustomer(priya.id, { kind: "lead" });
    setTestUser(manager);

    const result = await convertToThirdParty({
      customerIds: [shop.id],
      distributors: [],
    });
    assert.equal(result.ok, false, "a shop was converted with nobody billing it");

    const [row] = await db
      .select({ thirdParty: customers.thirdParty })
      .from(customers)
      .where(eq(customers.id, shop.id));
    assert.equal(row.thirdParty, false, "the mark was written by a refused call");
  });

  test("a DIRECT CUSTOMER cannot be converted — we bill them ourselves", async () => {
    const customer = await makeCustomer(priya.id, { kind: "customer" });
    const distributor = await makeDistributor("Distributor Beta");
    setTestUser(manager);

    const result = await convertToThirdParty({
      customerIds: [customer.id],
      distributors: [{ distributorId: distributor.id }],
    });
    assert.equal(result.ok, false, "an account we invoice was made a third party");

    const [row] = await db
      .select({ thirdParty: customers.thirdParty })
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(row.thirdParty, false);
  });

  test("a distributor has to be an unmarked direct customer", async () => {
    const shop = await makeCustomer(priya.id, { kind: "lead" });
    const aLead = await makeCustomer(priya.id, { kind: "lead", name: "Not A Distributor" });
    const marked = await makeCustomer(priya.id, {
      kind: "customer",
      thirdParty: true,
      name: "Also Delivered To",
    });
    setTestUser(manager);

    // A lead has never ordered, so it cannot bill anybody.
    assert.equal(
      (await convertToThirdParty({
        customerIds: [shop.id],
        distributors: [{ distributorId: aLead.id }],
      })).ok,
      false,
      "a lead was accepted as a distributor",
    );

    // And a shop somebody else bills cannot be the one holding the invoice.
    assert.equal(
      (await convertToThirdParty({
        customerIds: [shop.id],
        distributors: [{ distributorId: marked.id }],
      })).ok,
      false,
      "a third-party customer was accepted as a distributor",
    );

    // Nor can an account be its own distributor.
    assert.equal(
      (await convertToThirdParty({
        customerIds: [shop.id],
        distributors: [{ distributorId: shop.id }],
      })).ok,
      false,
      "an account was made its own distributor",
    );

    assert.deepEqual(await distributorsFor(shop.id), []);
  });

  test("the picker offers direct customers and nothing else", async () => {
    await makeCustomer(priya.id, { kind: "customer", name: "Candidate Direct" });
    await makeCustomer(priya.id, { kind: "lead", name: "Candidate Lead" });
    await makeCustomer(priya.id, {
      kind: "customer",
      thirdParty: true,
      name: "Candidate Marked",
    });
    await makeCustomer(priya.id, {
      kind: "customer",
      status: "deactivated",
      name: "Candidate Gone",
    });
    setTestUser(manager);

    const names = (await distributorCandidates("Candidate")).hits.map((c) => c.name);
    assert.deepEqual(names, ["Candidate Direct"]);
  });

  test("what was typed decides the order, and the cap says it is a cap", async () => {
    /*
     * The bug this pins: the list used to be ordered by how many shops an
     * account already serves and then alphabetically, with the query used only
     * to filter. Typing "c" put a name whose ninth word contains one above
     * every account that starts with one, which on a book of 561 direct
     * customers makes the box unusable for the job it exists to do.
     */
    await makeCustomer(priya.id, { kind: "customer", name: "Zeta Paints" });
    // Already serves a shop, so the old ordering floated it to the top of
    // every result set it appeared in, whatever was typed.
    const busy = await makeCustomer(priya.id, {
      kind: "customer",
      // Contains the query LATE and in another word, which is exactly the shape
      // that used to win: it matched, it already served a shop, and the sort
      // read the shop count before it read anything about the query.
      name: "A Munsi Paint and zeta chemicals",
    });
    const shop = await makeCustomer(priya.id, { kind: "lead", name: "Some Shop" });
    setTestUser(manager);
    assert.equal(
      (await convertToThirdParty({
        customerIds: [shop.id],
        distributors: [{ distributorId: busy.id }],
      })).ok,
      true,
    );

    const byPrefix = await distributorCandidates("Zeta");
    assert.equal(
      byPrefix.hits[0]?.name,
      "Zeta Paints",
      "the account whose name starts with what was typed was not first",
    );

    // A word inside the name counts, which is how somebody finds "Zeta Paints"
    // by typing what the customer actually says.
    const byWord = await distributorCandidates("Paints");
    assert.equal(byWord.hits[0]?.name, "Zeta Paints");

    // And a name typed badly still lands, the way the product search already
    // forgives one mid-call.
    const misspelt = await distributorCandidates("Zeta Pants");
    assert.ok(
      misspelt.hits.some((h) => h.name === "Zeta Paints"),
      "a near-miss found nothing at all",
    );

    // The cap is reported rather than left to look like the whole answer.
    const capped = await distributorCandidates("", { limit: 1 });
    assert.equal(capped.hits.length, 1);
    assert.ok(capped.more > 0, "a trimmed list did not say it was trimmed");
  });

  test("one letter means names that START with it, and nothing else", async () => {
    /*
     * Somebody typing a single character is spelling the beginning of a name
     * they know. Matching inside words at that length filled the whole list
     * with accounts that merely contain the letter — "A MUNSI PAINT and
     * chemicals" for "c" — and pushed every account beginning with one off the
     * bottom.
     */
    await makeCustomer(priya.id, { kind: "customer", name: "Chetan Traders" });
    await makeCustomer(priya.id, { kind: "customer", name: "A Munsi Paint and chemicals" });
    await makeCustomer(priya.id, { kind: "customer", name: "Acc Home Decor" });
    setTestUser(manager);

    const one = await distributorCandidates("c");
    assert.deepEqual(
      one.hits.map((h) => h.name),
      ["Chetan Traders"],
      "a one-letter query matched inside words instead of at the start",
    );
    assert.equal(one.mode, "prefix");

    // Three characters is where it widens: the town, the code, a word inside
    // the name and a near miss all become worth searching.
    const three = await distributorCandidates("che");
    assert.ok(
      three.hits.some((h) => h.name === "A Munsi Paint and chemicals"),
      "the wider search never arrived",
    );
    assert.equal(three.hits[0]?.name, "Chetan Traders", "the prefix match lost its place");
    assert.equal(three.mode, "wide");

    // Nothing starting with it is a different answer to nothing at all, and
    // the screen is told which so it can say so.
    const none = await distributorCandidates("z");
    assert.deepEqual(none.hits, []);
    assert.equal(none.mode, "prefix");
  });

  test("a batch converts on one set of distributors", async () => {
    const one = await makeCustomer(priya.id, { kind: "lead", name: "Route Shop One" });
    const two = await makeCustomer(priya.id, { kind: "lead", name: "Route Shop Two" });
    const distributor = await makeDistributor("Route Distributor");
    setTestUser(manager);

    const result = await convertToThirdParty({
      customerIds: [one.id, two.id],
      distributors: [{ distributorId: distributor.id, isPrimary: true }],
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.equal(result.ok ? result.data.converted : 0, 2);

    const served = await deliveryAddressesFor(distributor.id);
    assert.deepEqual(
      served.map((s: { customerId: string }) => s.customerId).sort(),
      [one.id, two.id].sort(),
      "the distributor's own record does not know both shops",
    );
  });

  test("adding, editing and removing an arrangement", async () => {
    const shop = await makeCustomer(priya.id, { kind: "lead" });
    const first = await makeDistributor("Distributor First");
    const second = await makeDistributor("Distributor Second");
    const third = await makeDistributor("Distributor Third");
    setTestUser(manager);

    assert.equal(
      (await convertToThirdParty({
        customerIds: [shop.id],
        distributors: [{ distributorId: first.id, isPrimary: true }],
      })).ok,
      true,
    );

    const added = await addDistributor({
      customerId: shop.id,
      distributorId: second.id,
      note: "Covers the eastern half",
    });
    assert.equal(added.ok, true, added.ok ? "" : added.error);

    // The same distributor twice is one arrangement, not two.
    assert.equal(
      (await addDistributor({ customerId: shop.id, distributorId: second.id })).ok,
      false,
      "the same distributor was named twice",
    );

    // Handing the badge over takes it off whoever holds it. Two rows both
    // claiming to be the usual one is a state no screen can render honestly.
    const links = await distributorsFor(shop.id);
    const secondLink = links.find((l) => l.customerId === second.id)!;
    assert.equal(
      (await updateDistributor({ linkId: secondLink.linkId!, isPrimary: true })).ok,
      true,
    );
    const afterPrimary = await distributorsFor(shop.id);
    assert.deepEqual(
      afterPrimary.filter((l) => l.isPrimary).map((l) => l.customerId),
      [second.id],
    );

    // Swapping WHO it is with keeps the row, so who recorded the arrangement
    // and when survives a corrected name.
    assert.equal(
      (await updateDistributor({ linkId: secondLink.linkId!, distributorId: third.id })).ok,
      true,
    );
    const afterSwap = await distributorsFor(shop.id);
    assert.ok(afterSwap.some((l) => l.customerId === third.id));
    assert.ok(!afterSwap.some((l) => l.customerId === second.id));

    // And a swap onto a distributor already named is refused rather than
    // silently merging two arrangements into one.
    const firstLink = afterSwap.find((l) => l.customerId === first.id)!;
    assert.equal(
      (await updateDistributor({ linkId: firstLink.linkId!, distributorId: third.id })).ok,
      false,
      "a swap collapsed two arrangements into one",
    );

    assert.equal((await removeDistributor(firstLink.linkId!)).ok, true);
    assert.equal((await distributorsFor(shop.id)).length, 1);
  });

  test("what the sheet saw and what somebody recorded are ONE list", async () => {
    /*
     * The bug this pins was on the screen, not in the data: the recorded
     * arrangement was one panel and every shop the order sheet shows goods
     * going to was another, under a title of its own. Four rows beside
     * eighty-six, two counts, and no way to tell what the difference was.
     *
     * One list per direction now, and `recorded` is what separates the halves.
     * A shop the sheet has seen is not a second subject — it is the unfinished
     * part of the first one.
     */
    const distributor = await makeCustomer(priya.id, {
      kind: "customer",
      name: "Distributor Merge",
    });
    const recordedShop = await makeCustomer(priya.id, {
      kind: "lead",
      name: "Recorded Shop",
    });
    const seenShop = await makeCustomer(priya.id, {
      kind: "lead",
      name: "Seen Only Shop",
    });

    setTestUser(manager);
    assert.equal(
      (await convertToThirdParty({
        customerIds: [recordedShop.id],
        distributors: [{ distributorId: distributor.id, isPrimary: true }],
      })).ok,
      true,
    );

    // The sheet's own knowledge: an order billed to the distributor, delivered
    // to a shop nobody has recorded.
    await db.insert(orders).values({
      id: id("ord"),
      customerId: distributor.id,
      deliveryCustomerId: seenShop.id,
      source: "external",
      externalRef: `SHEET-${randomUUID().slice(0, 8)}`,
      orderedAt: new Date(),
      totalAmount: 100_00,
      status: "dispatched",
    });

    const addresses = await deliveryAddressesFor(distributor.id);
    assert.equal(addresses.length, 2, "the two halves did not land in one list");

    const recorded = addresses.find((a) => a.customerId === recordedShop.id)!;
    const seen = addresses.find((a) => a.customerId === seenShop.id)!;
    assert.equal(recorded.recorded, true);
    assert.equal(recorded.orders, 0, "recorded with no deliveries yet is a real state");
    assert.equal(seen.recorded, false, "a shop only the sheet knows read as recorded");
    assert.equal(seen.orders, 1);
    assert.ok(seen.linkId === null, "an unrecorded row carried a link to edit");

    // Recorded first, whatever the order counts say — the half somebody is
    // responsible for is the half they should read first.
    assert.equal(addresses[0].customerId, recordedShop.id);

    // And recording one moves it across, which is what makes the list a
    // worklist rather than a report.
    const done = await recordDeliveryAddress({
      distributorId: distributor.id,
      shopId: seenShop.id,
    });
    assert.equal(done.ok, true, done.ok ? "" : done.error);
    assert.equal(done.ok ? done.data.converted : false, true, "a lead was not converted");

    const after = await deliveryAddressesFor(distributor.id);
    assert.equal(after.length, 2, "recording duplicated the row instead of moving it");
    assert.equal(after.every((a) => a.recorded), true);

    // Read from the shop's own end it is the same arrangement, not a second one.
    const fromTheShop = await distributorsFor(seenShop.id);
    assert.deepEqual(
      fromTheShop.map((d) => d.customerId),
      [distributor.id],
    );
    assert.equal(fromTheShop[0].recorded, true);
  });

  test("recording a delivery address does not convert an account we bill", async () => {
    // A direct customer receiving goods on somebody else's bill is ordinary —
    // they buy both ways. Recording that arrangement is right; calling them a
    // shop somebody else bills is not, and only a lead may be converted.
    const distributor = await makeCustomer(priya.id, { kind: "customer", name: "Dist A" });
    const alsoDirect = await makeCustomer(priya.id, { kind: "customer", name: "Also Direct" });
    setTestUser(manager);

    const done = await recordDeliveryAddress({
      distributorId: distributor.id,
      shopId: alsoDirect.id,
    });
    assert.equal(done.ok, true, done.ok ? "" : done.error);
    assert.equal(done.ok ? done.data.converted : true, false, "an account we bill was converted");

    const [row] = await db
      .select({ thirdParty: customers.thirdParty, kind: customers.kind })
      .from(customers)
      .where(eq(customers.id, alsoDirect.id));
    assert.equal(row.thirdParty, false);
    assert.equal(row.kind, "customer");

    // The arrangement is still recorded.
    const addresses = await deliveryAddressesFor(distributor.id);
    assert.deepEqual(addresses.map((a) => a.customerId), [alsoDirect.id]);
    assert.equal(addresses[0].recorded, true);
  });

  test("the LAST distributor cannot be removed from a third-party customer", async () => {
    const shop = await makeCustomer(priya.id, { kind: "lead" });
    const distributor = await makeDistributor("Distributor Only");
    setTestUser(manager);
    assert.equal(
      (await convertToThirdParty({
        customerIds: [shop.id],
        distributors: [{ distributorId: distributor.id }],
      })).ok,
      true,
    );

    const [link] = await distributorsFor(shop.id);
    const refused = await removeDistributor(link.linkId!);
    assert.equal(refused.ok, false, "a third-party customer was left with nobody billing it");
    assert.equal((await distributorsFor(shop.id)).length, 1);

    // The way out is the other direction: it stops being a third-party
    // customer, and then the arrangement can go.
    assert.equal((await revertThirdParty([shop.id])).ok, true);
    assert.equal((await removeDistributor(link.linkId!)).ok, true);
  });

  test("reverting keeps who used to bill the shop", async () => {
    const shop = await makeCustomer(priya.id, { kind: "lead" });
    const distributor = await makeDistributor("Distributor Was");
    setTestUser(manager);
    assert.equal(
      (await convertToThirdParty({
        customerIds: [shop.id],
        distributors: [{ distributorId: distributor.id }],
      })).ok,
      true,
    );

    const reverted = await revertThirdParty([shop.id]);
    assert.equal(reverted.ok, true);
    const [row] = await db
      .select({ thirdParty: customers.thirdParty })
      .from(customers)
      .where(eq(customers.id, shop.id));
    assert.equal(row.thirdParty, false);

    // The links are the record of how it WAS served. Deleting them would
    // destroy the only account of it.
    assert.equal((await distributorsFor(shop.id)).length, 1);

    // And a second revert reports honestly rather than claiming work.
    const again = await revertThirdParty([shop.id]);
    assert.equal(again.ok, true);
    assert.equal(again.ok ? again.data.changed : -1, 0, "a no-op reported work");
  });

  test("an account converted before distributors existed is listed, not hidden", async () => {
    const orphan = await makeCustomer(priya.id, {
      kind: "lead",
      thirdParty: true,
      name: "Marked Before",
    });
    await makeCustomer(priya.id, { kind: "lead", name: "Ordinary Lead" });
    setTestUser(manager);

    const waiting = await listCustomersPage({ thirdParty: "nodistributor" });
    assert.deepEqual(waiting.rows.map((w) => w.id), [orphan.id]);
  });

  test("a converted shop drops off the Call Log, and only for that reason", async () => {
    const shop = await makeCustomer(priya.id, {
      kind: "lead",
      lastOrderDate: null,
      createdAt: new Date(Date.now() - 60 * 24 * 3600 * 1000),
    });
    const distributor = await makeDistributor("Distributor Queue");

    setTestUser(priya);
    const before = await getQueue();
    assert.ok(
      before.entries.some((e) => e.customerId === shop.id),
      "a prospect was not on the list to begin with",
    );

    setTestUser(manager);
    assert.equal(
      (await convertToThirdParty({
        customerIds: [shop.id],
        distributors: [{ distributorId: distributor.id }],
      })).ok,
      true,
    );

    // The day's list is settled, so this reads the live engine rather than the
    // stored one — the point being the RULE, not when it takes effect.
    const candidates = await queueCandidatesFor(priya.id, TODAY);
    const stillThere = candidates.find((c) => c.customerId === shop.id);
    assert.equal(stillThere?.thirdParty, true, "the flag never reached the engine");
  });

  test("a converted account leaves the lead count and joins the third-party one", async () => {
    // One question, three answers. A converted lead must not be counted in
    // both, or the split says 1,079 records across 1,178 rows and nobody
    // trusts it.
    await makeCustomer(priya.id, { kind: "lead", name: "Shop To Convert" });
    await makeCustomer(priya.id, { kind: "lead", name: "Genuine Lead" });
    const distributor = await makeCustomer(priya.id, {
      kind: "customer",
      name: "Real Distributor",
    });

    setTestUser(manager);
    const before = await listCustomersPage({});
    assert.equal(before.totals.leads, 2);
    assert.equal(before.totals.thirdParties, 0);

    const shop = before.rows.find((r) => r.name === "Shop To Convert")!;
    assert.equal(
      (await convertToThirdParty({
        customerIds: [shop.id],
        distributors: [{ distributorId: distributor.id }],
      })).ok,
      true,
    );

    const after = await listCustomersPage({});
    assert.equal(after.totals.leads, 1, "a converted account was still counted as a lead");
    assert.equal(after.totals.thirdParties, 1);
    assert.equal(
      after.totals.directCustomers + after.totals.leads + after.totals.thirdParties,
      after.total,
      "the three counts do not add up to the book",
    );

    // And the filters agree with the counts.
    const asLeads = await listCustomersPage({ thirdParty: "lead" });
    assert.ok(
      !asLeads.rows.some((r) => r.id === shop.id),
      "the Leads filter still offered a converted account",
    );
    const asThird = await listCustomersPage({ thirdParty: "yes" });
    assert.deepEqual(asThird.rows.map((r) => r.id), [shop.id]);
  });

  test("the sheet's delivery party links to a record, and creates none", async () => {
    const distributor = await makeCustomer(priya.id, { name: "Distributor Alpha" });
    const shop = await makeCustomer(priya.id, { name: "End Shop Beta", kind: "lead" });
    const before = (await db.select({ id: customers.id }).from(customers)).length;

    const [order] = await db
      .insert(orders)
      .values({
        id: id("ord"),
        customerId: distributor.id,
        source: "external",
        externalRef: "SHEET-TO-9001",
        orderedAt: new Date(),
        totalAmount: 100_00,
        status: "dispatched",
      })
      .returning();

    const [run] = await db
      .insert(sheetSyncRuns)
      .values({
        id: id("syn"),
        source: "taken_order",
        spreadsheetId: "sheet",
        tabTitle: "Taken Order",
        status: "ok",
      })
      .returning();
    await db.insert(sheetTakenOrderRows).values({
      id: id("tak"),
      syncId: run.id,
      rowNumber: 1,
      lineKey: randomUUID(),
      raw: {},
      rowHash: randomUUID(),
      orderNumber: "TO-9001",
      billingPartyName: "Distributor Alpha",
      deliveryPartyName: "End Shop Beta",
      officeStatus: "Ready",
      entryStatus: "Done",
      open: false,
    });

    const result = await linkDeliveryParties();
    assert.equal(result.linked, 1, "the delivery party was not linked");

    const [linked] = await db
      .select({ delivery: orders.deliveryCustomerId })
      .from(orders)
      .where(eq(orders.id, order.id));
    assert.equal(linked.delivery, shop.id);

    // The whole reason this is a link and not an import.
    const after = (await db.select({ id: customers.id }).from(customers)).length;
    assert.equal(after, before, "linking created a customer record");
  });

  test("a delivery party naming nobody is reported, never created", async () => {
    const distributor = await makeCustomer(priya.id, { name: "Distributor Gamma" });
    const before = (await db.select({ id: customers.id }).from(customers)).length;

    await db.insert(orders).values({
      id: id("ord"),
      customerId: distributor.id,
      source: "external",
      externalRef: "SHEET-TO-9002",
      orderedAt: new Date(),
      totalAmount: 100_00,
      status: "dispatched",
    });
    const [run] = await db
      .insert(sheetSyncRuns)
      .values({
        id: id("syn"),
        source: "taken_order",
        spreadsheetId: "sheet",
        tabTitle: "Taken Order",
        status: "ok",
      })
      .returning();
    await db.insert(sheetTakenOrderRows).values({
      id: id("tak"),
      syncId: run.id,
      rowNumber: 1,
      lineKey: randomUUID(),
      raw: {},
      rowHash: randomUUID(),
      orderNumber: "TO-9002",
      billingPartyName: "Distributor Gamma",
      deliveryPartyName: "Nobody We Have Ever Heard Of",
      officeStatus: "Ready",
      entryStatus: "Done",
      open: false,
    });

    const result = await linkDeliveryParties();
    assert.equal(result.unresolved, 1);
    assert.equal(result.linked, 0);
    assert.equal(
      (await db.select({ id: customers.id }).from(customers)).length,
      before,
      "an unmatched delivery name created a record",
    );

    const listed = await unresolvedDeliveryParties();
    assert.ok(
      listed.some((u) => u.name === "Nobody We Have Ever Heard Of"),
      "the unmatched name was not reported anywhere",
    );
  });
});

/* ---------------------------------------------------------------------------
 * The customer record, which held a timeline and five figures while the drawer
 * opened over the top of it knew more than the page underneath.
 * ------------------------------------------------------------------------- */

describe("everything on a customer's record", () => {
  test("a bill nobody has spoken for is listed and never given a balance", async () => {
    const customer = await makeCustomer(priya.id);
    await db.insert(bills).values([
      {
        id: id("bil"),
        customerId: customer.id,
        billNo: "STATED-1",
        billDate: addDays(TODAY, -40),
        dueDate: addDays(TODAY, -10),
        amount: 100_00,
        paymentPosition: "stated",
      },
      {
        id: id("bil"),
        customerId: customer.id,
        billNo: "UNSTATED-1",
        billDate: addDays(TODAY, -40),
        dueDate: addDays(TODAY, -10),
        amount: 250_00,
        paymentPosition: "unstated",
      },
    ]);

    setTestUser(priya);
    const detail = await customerRecordDetail(customer.id, TODAY);

    const stated = detail.bills.find((b) => b.billNo === "STATED-1")!;
    const unstated = detail.bills.find((b) => b.billNo === "UNSTATED-1")!;

    assert.equal(detail.counts.bills, 2, "the count is of every bill, not the page");
    assert.equal(stated.stated, true);
    assert.equal(stated.daysOverdue, 10);

    // Shown, counted, and never aged: an unstated bill is not a debt, so
    // giving it a number of days overdue would invent an age for something
    // nobody has said is owed.
    assert.equal(unstated.stated, false);
    assert.equal(unstated.daysOverdue, null, "an unstated bill was aged like a debt");
  });

  test("an order accounts refused is listed, and says it is not a sale", async () => {
    const customer = await makeCustomer(priya.id);
    await db.insert(orders).values([
      {
        id: id("ord"),
        customerId: customer.id,
        orderedAt: new Date(),
        totalAmount: 500_00,
        status: "dispatched",
      },
      {
        id: id("ord"),
        customerId: customer.id,
        orderedAt: new Date(),
        totalAmount: 900_00,
        status: "declined",
      },
    ]);

    setTestUser(priya);
    const detail = await customerRecordDetail(customer.id, TODAY);

    assert.equal(detail.orders.length, 2, "a declined order vanished from the record");
    assert.equal(detail.orders.filter((o) => o.counts).length, 1);
    assert.equal(
      detail.orders.find((o) => o.amount === 900_00)?.counts,
      false,
      "a declined order was presented as a sale",
    );
  });
});
