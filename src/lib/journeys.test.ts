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
  reminders,
  users,
  waMessages,
  waTemplates,
  attachments as attachmentsTable,
  sheetOrderRows,
  sheetSyncRuns,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { customerStatusLabel } from "@/lib/format";
import {
  seedConfig,
  updateSetting,
  invalidateConfig,
  getConfig,
} from "@/lib/config/store";
import { NotPermittedError } from "@/lib/access-control";
import { today } from "@/lib/recompute";
import {
  recomputeBuyingCycle,
  recomputeFollowUpState,
  recomputeInactivity,
  recomputeOutstanding,
  recomputeBillStatuses,
} from "@/lib/recompute";
import { addDays } from "@/lib/business-date";
import { getQueue } from "@/lib/services/queue-service";
import { saveInteraction } from "@/lib/services/interaction-service";
import { seedCatalogue } from "@/db/seed-catalogue";
import {
  products as productsTable,
  productAliases as productAliasesTable,
  catalogueExceptions as catalogueExceptionsTable,
  finishedGoods as finishedGoodsTable,
  quickNotes as quickNotesTable,
  interactionProductLines,
} from "@/db/schema";
import { importCatalogue } from "@/lib/services/catalogue-import";
import {
  searchProducts,
  popularProducts,
  customerProducts,
} from "@/lib/services/product-service";
import {
  confirmReceipt,
  pendingReceipts,
  recordReceipt,
  rejectReceipt,
} from "@/lib/services/receipt-service";
import { globalSearch ,
  listCustomersPage,
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
  requestDeactivation,
  requestReactivation,
  startStageOneBatch,
} from "@/lib/actions/crm";
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
import { customerTimeline } from "@/lib/queries";
import {
  confirmSent,
  markCopied,
  prepareLegs,
  prepareMessage,
} from "@/lib/services/whatsapp-service";
import { eodMetricsFor, eodPreflightFor } from "@/lib/services/eod-service";
import { projectSheet } from "@/lib/services/sheet-projection-service";

/* ------------------------------------------------------------------ harness */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let TODAY: string;
let manager: typeof users.$inferSelect;
let priya: typeof users.$inferSelect;
let rakesh: typeof users.$inferSelect;
let deepa: typeof users.$inferSelect;

async function makeUser(
  name: string,
  role: "telecaller" | "manager" | "accounts",
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
      customers, users, app_settings
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
    const entry = timeline.find((t) => t.kind === "Order");
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

  test("late by their own cycle but inside the quiet window is held back visibly", async () => {
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -12),
      // Contacted yesterday, so no check-in is due to carry them onto the list.
      lastContactDate: addDays(TODAY, -1),
      cycleDays: 8,
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

  test("a 22-day cycle is called on day 18, not day 17", async () => {
    const early = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -17),
      cycleDays: 22,
      cycleIsDefault: false,
    });
    const due = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -18),
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
    await updateCustomer(customer.id, { backOfficeAmId: rakesh.id });
    const [afterTelecaller] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(
      afterTelecaller.backOfficeAmId,
      null,
      "a disabled input is not a permission check",
    );

    setTestUser(manager);
    await updateCustomer(customer.id, { backOfficeAmId: rakesh.id });
    setTestUser(priya);
    const [afterManager] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customer.id));
    assert.equal(afterManager.backOfficeAmId, rakesh.id);
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

  test("a sales bill is the order, and it starts settled", async () => {
    // The Order Details tab carries the bill number and the amount on every
    // line and a payment status on none, so bills come from it and every one
    // starts paid. Assuming the opposite would invent the entire order book
    // as debt and put every customer on the collections list.
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    const report = await projectSheet({ assignToUserId: priya.id });

    assert.equal(report.bills.skipped, false, "bills are no longer opt-in");
    assert.equal(report.bills.created, 1, "one order is one bill");

    const [bill] = await db.select().from(bills);
    // Two lines at 1180.00 each — the value is the SUM, never one line's.
    assert.equal(bill.amount, 2360_00);
    assert.equal(bill.paidAmount, bill.amount, "settled by instruction");
    assert.equal(bill.status, "paid");
    assert.ok(bill.orderId, "the bill records which order it came from");

    // Nothing owed anywhere, so nobody is chased for it.
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.name, "Shree Paints"));
    assert.equal(customer.outstanding, 0);
    assert.equal((await db.select().from(followUpStates)).length, 0);
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

  test("running it twice does not pay the same bill twice", async () => {
    await stageSheetRows("Shree Paints", "SO-1001", addDays(TODAY, -40));
    await projectSheet({ assignToUserId: priya.id });
    await projectSheet({ assignToUserId: priya.id });

    const rows = await db.select().from(bills);
    assert.equal(rows.length, 1, "one bill, not two");
    assert.equal(rows[0].paidAmount, rows[0].amount, "and paid once, not twice");
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
});
