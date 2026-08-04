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
  followUpStates,
  monthlyTargets,
  orders,
  reminders,
  users,
  waTemplates,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { seedConfig, updateSetting, invalidateConfig, getConfig } from "@/lib/config/store";
import { NotPermittedError } from "@/lib/access-control";
import { today } from "@/lib/recompute";
import {
  recomputeBuyingCycle,
  recomputeFollowUpState,
  recomputeInactivity,
  recomputeLastContact,
  recomputeOutstanding,
  recomputeBillStatuses,
} from "@/lib/recompute";
import { addDays } from "@/lib/business-date";
import { getQueue } from "@/lib/services/queue-service";
import { logCall } from "@/lib/services/call-service";
import {
  getFollowUpWorklist,
  recordFollowUpAttempt,
  recordPayment,
} from "@/lib/services/payment-service";
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
      follow_up_attempts, follow_up_states, payments, bills,
      orders, calls, eod_reports, attendance, app_access, sessions,
      customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

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
    let [row] = await db.select().from(customers).where(eq(customers.id, customer.id));
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

    [row] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(row.cycleIsDefault, false, "four orders is enough to derive a cycle");
    assert.equal(row.cycleDays, 20);
    assert.equal(row.avgOrderValue, 50_000_00);

    // Twenty days since the last order, so they are due to reorder.
    const queue = await getQueue();
    const entry = queue.entries.find((e) => e.customerId === customer.id);
    assert.ok(entry, "a customer at their cycle length must appear in the queue");
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
    const [bill] = await db.select().from(bills).where(eq(bills.customerId, customer.id));
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
    assert.equal(stillListed, undefined, "a paid-up customer leaves the worklist");
  });

  test("a disputed bill holds the customer instead of escalating them", async () => {
    const customer = await overdueCustomer(60);
    await db
      .update(bills)
      .set({ disputed: true })
      .where(eq(bills.customerId, customer.id));
    await recomputeFollowUpState(customer.id);

    const row = (await getFollowUpWorklist()).find((r) => r.customerId === customer.id);
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

    const [row] = await db.select().from(customers).where(eq(customers.id, customer.id));
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

    const { dismissReminder } = await import("@/lib/services/worklist-services");

    const noReason = await dismissReminder(created.data.id, "   ");
    assert.equal(noReason.ok, false, "dismissal without a reason is refused");

    const done = await dismissReminder(created.data.id, "Cheque already banked");
    assert.equal(done.ok, true);

    const [row] = await db
      .select()
      .from(reminders)
      .where(eq(reminders.id, created.data.id));
    assert.equal(row.status, "dismissed");
    assert.equal(row.dismissReason, "Cheque already banked");

    // Three statuses and no more — "cancelled" is not one of them.
    const all = await listReminders();
    assert.ok(all.every((r) => ["pending", "completed", "dismissed"].includes(r.status)));
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
    assert.ok(row.valueAtRisk > 0, "the watch is about money, so it must carry a figure");
    assert.equal(row.outcome, null);

    const decided = await recordWatchOutcome(
      customer.id,
      "contacted",
      "Spoke to them — they buy again next month",
    );
    assert.equal(decided.ok, true, decided.ok ? "" : decided.error);

    const after = await listInactiveWatch();
    const stillOpen = after.find((w) => w.customerId === customer.id);
    assert.equal(stillOpen?.needsDecision, false, "a decided item stops nagging");
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
    assert.ok(Number(denial.n) >= 1, "a refusal is a security event, so it is recorded");

    setTestUser(manager);
    const allowed = await setTarget(customer.id, 500000, TODAY.slice(0, 7));
    assert.equal(allowed.ok, true, allowed.ok ? "" : allowed.error);

    const [target] = await db
      .select()
      .from(monthlyTargets)
      .where(eq(monthlyTargets.customerId, customer.id));
    assert.equal(target.isDefault, false, "a hand-set target is no longer a default");
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
    assert.ok(row.slaDueAt > new Date(), "an open complaint has a future deadline");
    assert.equal(row.requestCn, false);
    assert.equal(row.billId, null, "no credit note asked for, so no bill attached");

    const history = await db
      .select()
      .from(complaintStatusHistory)
      .where(eq(complaintStatusHistory.complaintId, row.id));
    assert.equal(history.length, 1, "opening the complaint is itself a history line");
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
    assert.ok(before.includes("Packaging"), "ships with Mahek's own vocabulary");

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

/* ------------------------------------ cross-cutting: config, idempotency, audit */

describe("Cross-cutting rules", () => {
  test("a threshold change takes effect on the next read, with no restart", async () => {
    const customer = await makeCustomer(priya.id, {
      lastContactDate: addDays(TODAY, -10),
      lastOrderDate: addDays(TODAY, -10),
      cycleDays: 90,
      cycleIsDefault: false,
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
    const result = await updateSetting("queue.checkInIntervalDays", 4000, manager.id);
    assert.equal(result.ok, false);
    assert.match(result.error, /365/);
  });

  test("the same call submitted twice is logged once", async () => {
    const customer = await makeCustomer(priya.id);
    const key = randomUUID();

    const input = {
      customerId: customer.id,
      connectionStatus: "connected" as const,
      outcome: "will_order_later" as const,
      notes: "Asked us to call back next week",
      sourceModule: "call_queue" as const,
      idempotencyKey: key,
    };

    const first = await logCall(input);
    const second = await logCall(input);
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    assert.equal(second.ok, true, second.ok ? "" : second.error);
    assert.equal(
      first.data.callId,
      second.data.callId,
      "a retried submit must return the original call, not create a second",
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

    assert.ok((await getQueue()).entries.some((e) => e.customerId === customer.id));

    const logged = await logCall({
      customerId: customer.id,
      connectionStatus: "connected",
      outcome: "will_order_later",
      notes: "Will confirm quantities tomorrow",
      idempotencyKey: randomUUID(),
    });
    assert.equal(logged.ok, true, logged.ok ? "" : logged.error);

    await recomputeLastContact(customer.id);

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

  test("a missed call is derived from the connection status, never typed in", async () => {
    const customer = await makeCustomer(priya.id);
    await logCall({
      customerId: customer.id,
      connectionStatus: "no_answer",
      outcome: "not_reachable",
      idempotencyKey: randomUUID(),
    });

    const [row] = await db.select().from(calls).where(eq(calls.customerId, customer.id));
    assert.equal(row.connectionStatus, "no_answer");

    const { eodMetricsFor } = await import("@/lib/services/eod-service");
    const metrics = await eodMetricsFor(priya.id, TODAY);
    assert.equal(metrics.callsAttempted, 1);
    assert.equal(metrics.callsConnected, 0);
    assert.equal(metrics.callsMissed, 1);
  });
});
