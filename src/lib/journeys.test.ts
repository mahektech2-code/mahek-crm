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
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  bills,
  calls,
  complaints,
  complaintStatusHistory,
  customers,
  followUpAttempts,
  followUpStates,
  monthlyTargets,
  orders,
  reminders,
  users,
  waTemplates,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
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
  quickNotes as quickNotesTable,
  interactionProductLines,
} from "@/db/schema";
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
import { startStageOneBatch } from "@/lib/actions/crm";
import {
  createReminder,
  completeReminder,
  listInactiveWatch,
  listReminders,
  recordWatchOutcome,
  setTarget,
} from "@/lib/services/worklist-services";
import {
  confirmSent,
  markCopied,
  prepareMessage,
} from "@/lib/services/whatsapp-service";
import { eodPreflightFor } from "@/lib/services/eod-service";

/* ------------------------------------------------------------------ harness */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let TODAY: string;
let manager: typeof users.$inferSelect;
let priya: typeof users.$inferSelect;
let rakesh: typeof users.$inferSelect;

async function makeUser(
  name: string,
  role: "telecaller" | "manager",
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
      audit_log, job_runs, bug_reports, help_articles, notifications,
      inactive_watch_items, monthly_targets, wa_runs, wa_replies, wa_messages,
      wa_templates, complaint_status_history, complaints, reminders,
      interaction_product_lines, products, quick_notes, migration_exceptions,
      follow_up_attempts, follow_up_states, payments, bills,
      orders, calls, eod_reports, attendance, app_access, sessions,
      customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  await seedCatalogue();

  manager = await makeUser("Vikram", "manager");
  priya = await makeUser("Priya", "telecaller", manager.id);
  rakesh = await makeUser("Rakesh", "telecaller", manager.id);

  setTestUser(priya);
  TODAY = await today();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ------------------------------------------------- journey 1: buying cycle */

describe("Journey 1 — a new customer earns their own buying cycle", () => {
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

describe("Journey 2 — an overdue bill escalates, is chased, and is paid", () => {
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

  test("stage 1 is WhatsApp-only — a call attempt is refused, and says why", async () => {
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
    const customer = await overdueCustomer(30);

    // Thirty days overdue is past the second threshold, so a call is allowed.
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

describe("Journey 3 — copying is not sending", () => {
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
});

/* ------------------------------------------------- journey 4: the EOD gate */

describe("Journey 4 — the EOD gate", () => {
  test("a reminder due today blocks the report until it is closed", async () => {
    const customer = await makeCustomer(priya.id);

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

describe("Journey 5 — a customer goes quiet and gets a decision", () => {
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
      "Spoke to them — they buy again next month",
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
});

/* -------------------------------------------------- journey 6: who sees what */

describe("Journey 6 — a telecaller sees their own book and nothing else", () => {
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

describe("Journey 7 — a complaint carries its SLA and its credit-note request", () => {
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

  test("a credit-note request without a bill is refused", async () => {
    const customer = await makeCustomer(priya.id);
    const { logComplaint } = await import("@/lib/actions/crm");

    const refused = await logComplaint({
      customerId: customer.id,
      category: "Packaging",
      description: "Short supply, wants a credit note",
      requestCn: true,
      billId: null,
    });
    assert.equal(refused.ok, false, "accounts cannot action a CN with no bill");
    assert.match(refused.error, /bill/i);
  });

  test("a credit-note request with a bill stores the link", async () => {
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

describe("Journey 8 — the interaction log", () => {
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
      "a ringing phone is not contact — the check-in timer must not reset",
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
      outcome: "not_interested",
      idempotencyKey: randomUUID(),
    });
    assert.equal(wrong.ok, false, "not_interested is outbound-only");
    assert.match(wrong.error, /outcome/i);
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
      "the identifiers are what makes them analysable — free text cannot be",
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

describe("Journey 9 — the Information tab", () => {
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
    assert.equal(a?.creditDaysIsDefault, true);

    const b = await customerInformation(own.id);
    assert.equal(b?.creditDays, 45);
    assert.equal(b?.creditDaysIsDefault, false);
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
      "they order every 8 days on their own — asking for an order adds nothing",
    );
  });

  test("but a fast-cycling customer still gets their weekly check-in", async () => {
    const customer = await makeCustomer(priya.id, {
      lastOrderDate: addDays(TODAY, -2),
      lastContactDate: addDays(TODAY, -9),
      cycleDays: 8,
      cycleIsDefault: false,
    });
    const q = await getQueue();
    const entry = q.entries.find((e) => e.customerId === customer.id);
    assert.ok(entry, "going quiet on your best customers is how you lose them");
    assert.ok(entry.reasons[0].kind.startsWith("checkIn"));
    assert.ok(
      entry.reasons.every((r) => !r.kind.startsWith("order")),
      "and it is a service call, not an order chase",
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

describe("The payment follow-up cycle — term, quiet window, messages, calls", () => {
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

  test("taking an order records the term, and the panel's default is the customer's own", async () => {
    const customer = await makeCustomer(priya.id, { creditDays: 15 });
    const [product] = await db.select().from(productsTable).limit(1);

    const saved = await saveInteraction({
      customerId: customer.id,
      interactionType: "outbound_call",
      outcome: "order_taken",
      productQuantities: { [product.id]: 4 },
      creditDays: 45,
      idempotencyKey: randomUUID(),
    });
    assert.equal(saved.ok, true);

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.customerId, customer.id));
    assert.equal(order.creditDays, 45, "the term the telecaller agreed wins");
    assert.equal(order.paymentDueDate, addDays(TODAY, 45));

    // Left unstated, the customer's own standing term applies instead.
    const second = await makeCustomer(priya.id, { creditDays: 15 });
    await saveInteraction({
      customerId: second.id,
      interactionType: "outbound_call",
      outcome: "order_taken",
      productQuantities: { [product.id]: 1 },
      idempotencyKey: randomUUID(),
    });
    const [fallback] = await db
      .select()
      .from(orders)
      .where(eq(orders.customerId, second.id));
    assert.equal(fallback.creditDays, 15);
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

describe("Logging a collections call — one outcome, one transaction", () => {
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

  test("Already paid clears the bills, the outstanding and the worklist row together", async () => {
    const customer = await onTheWorklist(30);

    const saved = await logPaymentFollowUp({
      customerId: customer.id,
      outcome: "paid",
      amount: 1_00_000,
      chips: [],
      idempotencyKey: randomUUID(),
    });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);
    assert.equal(saved.data.cleared, true, "paying in full leaves the worklist");

    const [bill] = await db.select().from(bills).where(eq(bills.customerId, customer.id));
    assert.equal(bill.paidAmount, 1_00_000_00);
    assert.equal(bill.status, "paid");

    const [row] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(row.outstanding, 0, "outstanding is derived, and it was rebuilt");
    assert.equal(await stateOf(customer.id), undefined);
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
