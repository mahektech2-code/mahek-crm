/**
 * The Accounts app, end to end.
 *
 * Every screen in the app is one of these functions with a table around it, so
 * what these prove is the thing a screenshot cannot: that a decision moves the
 * figures it claims to move, and that the ones it must NOT move stay still.
 *
 *   npm run test:accounts
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
  auditLog,
  bills,
  complaints,
  customers,
  appAccess,
  orders,
  paymentReceipts,
  payments,
  sheetSyncRuns,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { NotPermittedError } from "@/lib/access-control";
import { invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import { addDays } from "@/lib/business-date";
import { today, recomputeOutstanding } from "@/lib/recompute";

import { accountsHome, bucketise } from "@/lib/services/accounts-home-service";
import { accountsAudit } from "@/lib/services/accounts-audit-service";
import { queueUrgency } from "@/lib/services/accounts-queue-service";
import { launcherApps } from "@/lib/access";
import {
  issueCreditNote,
  pendingCreditNoteCount,
  pendingCreditNotes,
  refuseCreditNote,
} from "@/lib/services/credit-note-service";
import {
  applyOnAccount,
  onAccountHolders,
} from "@/lib/services/on-account-service";
import { importState } from "@/lib/services/bill-import-service";
import {
  approveOrder,
  declineOrder,
  pendingOrderCount,
  pendingOrders,
} from "@/lib/services/order-approval-service";
import {
  confirmReceipt,
  customerLedger,
  openBillsFor,
  paymentSearch,
  pendingReceipts,
  recordReceipt,
  rejectReceipt,
} from "@/lib/services/receipt-service";
import { listBills } from "@/lib/services/payment-service";

/* ------------------------------------------------------------------ harness */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let TODAY: string;
let manager: typeof users.$inferSelect;
let priya: typeof users.$inferSelect;
let deepa: typeof users.$inferSelect;

async function makeUser(name: string, role: "telecaller" | "manager" | "accounts") {
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
    })
    .returning();
  return row;
}

async function makeCustomer(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: over.name ?? `Customer ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact Person",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Mumbai",
      ownerId: priya.id,
      salesAmId: priya.id,
      customerSince: addDays(TODAY, -400),
      ...over,
    })
    .returning();
  return row;
}

async function makeBill(
  customerId: string,
  amount: number,
  over: Partial<typeof bills.$inferInsert> = {},
) {
  const [row] = await db
    .insert(bills)
    .values({
      id: id("bil"),
      customerId,
      billNo: over.billNo ?? `MMI/26-27/${Math.floor(Math.random() * 899999) + 100000}`,
      billDate: over.billDate ?? addDays(TODAY, -40),
      dueDate: over.dueDate ?? addDays(TODAY, -10),
      amount,
      ...over,
    })
    .returning();
  await recomputeOutstanding(customerId);
  return row;
}

async function makeComplaintWithCn(
  customerId: string,
  over: Partial<typeof complaints.$inferInsert> = {},
) {
  const [row] = await db
    .insert(complaints)
    .values({
      id: id("cmp"),
      customerId,
      category: "packaging_damage",
      description: "Two drums arrived with the seals broken.",
      loggedByUserId: priya.id,
      slaDueAt: new Date(Date.now() + 86_400_000),
      requestCn: true,
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
  await db.execute(sql`
    truncate table
      audit_log, job_runs, notifications, complaint_status_history, complaints,
      attachments, follow_up_attempts, follow_up_states, payments, bills,
      orders, calls, app_access, sessions, customers, users, app_settings,
      sheet_sync_runs
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  manager = await makeUser("Vikram", "manager");
  priya = await makeUser("Priya", "telecaller");
  deepa = await makeUser("Deepa", "accounts");

  setTestUser(deepa);
  TODAY = await today();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* =========================================================== order approvals */

describe("Order approvals", () => {
  async function pendingOrder(customerId: string, amount = 5_000_00) {
    const [row] = await db
      .insert(orders)
      .values({
        id: id("ord"),
        customerId,
        userId: priya.id,
        orderedAt: new Date(Date.now() - 30 * 3600_000),
        totalAmount: amount,
        status: "pending_approval",
      })
      .returning();
    return row;
  }

  test("the queue carries the credit picture accounts decide on", async () => {
    const customer = await makeCustomer({ name: "Shree Paints", slowPayer: true });
    await makeBill(customer.id, 24_000_00, { dueDate: addDays(TODAY, -20) });
    await pendingOrder(customer.id, 18_600_00);

    const rows = await pendingOrders();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.customerName, "Shree Paints");
    assert.equal(row.totalAmount, 18_600_00);
    // The three signals the drawer's risk panel is built from, all live.
    assert.equal(row.outstanding, 24_000_00);
    assert.equal(row.overdueBills, 1);
    assert.equal(row.slowPayer, true);
    assert.ok(row.waitingHours >= 29, `waited ${row.waitingHours}h`);
    assert.equal(await pendingOrderCount(), 1);
  });

  test("approving moves it out of the queue and writes an audit row", async () => {
    const customer = await makeCustomer();
    const order = await pendingOrder(customer.id);

    const result = await approveOrder(order.id);
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const [after_] = await db.select().from(orders).where(eq(orders.id, order.id));
    assert.equal(after_.status, "confirmed");
    assert.equal(after_.approvedById, deepa.id);
    assert.equal(await pendingOrderCount(), 0);

    const log = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "order.approve"));
    assert.equal(log.length, 1);
    assert.equal(log[0].actorId, deepa.id);
  });

  test("declining demands a reason, and the reason reaches the row", async () => {
    const customer = await makeCustomer();
    const order = await pendingOrder(customer.id);

    const blank = await declineOrder(order.id, "   ");
    assert.equal(blank.ok, false);
    assert.equal(blank.ok === false && blank.code, "validation");

    const done = await declineOrder(order.id, "Outstanding is over their limit.");
    assert.equal(done.ok, true);

    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    assert.equal(row.status, "declined");
    assert.equal(row.declineReason, "Outstanding is over their limit.");
  });

  test("a second decision is refused rather than overwriting the first", async () => {
    const customer = await makeCustomer();
    const order = await pendingOrder(customer.id);
    await approveOrder(order.id);

    const again = await declineOrder(order.id, "changed my mind");
    assert.equal(again.ok, false);
    assert.equal(again.ok === false && again.code, "conflict");
  });

  test("a telecaller cannot approve, however the screen is reached", async () => {
    const customer = await makeCustomer();
    const order = await pendingOrder(customer.id);
    setTestUser(priya);
    await assert.rejects(() => approveOrder(order.id), NotPermittedError);
    setTestUser(manager);
    // Not a manager either: the person chasing the target must not sign off
    // the orders that hit it.
    await assert.rejects(() => approveOrder(order.id), NotPermittedError);
  });
});

/* ======================================================= payments to confirm */

describe("Payments to confirm", () => {
  test("a telecaller's report moves nothing until accounts find it", async () => {
    const customer = await makeCustomer();
    const bill = await makeBill(customer.id, 10_000_00);

    setTestUser(priya);
    const recorded = await recordReceipt({
      customerId: customer.id,
      amount: 4_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });
    assert.equal(recorded.ok, true, recorded.ok ? "" : recorded.error);
    assert.equal(recorded.ok && recorded.data.status, "reported");

    // Nothing moved: not the bill, not outstanding.
    const [b] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(b.paidAmount, 0);
    const [c] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(c.outstanding, 10_000_00);

    setTestUser(deepa);
    const waiting = await pendingReceipts();
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].amount, 4_000_00);
    assert.equal(waiting[0].reportedBy, "Priya");
    assert.equal(waiting[0].source, "collections_call");
    assert.equal(waiting[0].lines.length, 1);
    assert.equal(waiting[0].lines[0].billNo, bill.billNo);
  });

  test("confirming settles the bill and clears the account", async () => {
    const customer = await makeCustomer();
    const bill = await makeBill(customer.id, 10_000_00);

    setTestUser(priya);
    await recordReceipt({
      customerId: customer.id,
      amount: 10_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });

    setTestUser(deepa);
    const [waiting] = await pendingReceipts();
    const done = await confirmReceipt(waiting.receiptId);
    assert.equal(done.ok, true, done.ok ? "" : done.error);
    assert.equal(done.ok && done.data.cleared, true);

    const [b] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(b.paidAmount, 10_000_00);
    assert.equal(b.status, "paid");
    const [c] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(c.outstanding, 0);
  });

  test("rejecting keeps the row, gives the balance back and stays on the statement", async () => {
    const customer = await makeCustomer();
    const bill = await makeBill(customer.id, 10_000_00);

    setTestUser(priya);
    await recordReceipt({
      customerId: customer.id,
      amount: 10_000_00,
      receivedAt: TODAY,
      mode: "Cash",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });

    setTestUser(deepa);
    const [waiting] = await pendingReceipts();
    await confirmReceipt(waiting.receiptId);

    const rejected = await rejectReceipt(waiting.receiptId, "No cash was handed over.");
    assert.equal(rejected.ok, true, rejected.ok ? "" : rejected.error);

    // The money comes back off the bill.
    const [b] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(b.paidAmount, 0);
    const [c] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(c.outstanding, 10_000_00);

    // And the receipt is still there, with its reason, on the statement.
    const ledger = await customerLedger(customer.id);
    const dead = ledger!.entries.find((e) => e.status === "rejected");
    assert.ok(dead, "a rejected receipt must stay on the statement");
    assert.equal(dead.credit, 0, "it credits nothing");
    assert.match(dead.detail, /No cash was handed over/);
  });

  test("a stale allocation is refused rather than silently moved", async () => {
    const customer = await makeCustomer();
    const bill = await makeBill(customer.id, 10_000_00);

    setTestUser(priya);
    await recordReceipt({
      customerId: customer.id,
      amount: 10_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });

    // Somebody else settles the same bill in the meantime.
    setTestUser(deepa);
    await db
      .update(bills)
      .set({ paidAmount: 10_000_00 })
      .where(eq(bills.id, bill.id));

    const [waiting] = await pendingReceipts();
    const blocked = await confirmReceipt(waiting.receiptId);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.ok === false && blocked.code, "conflict");
    assert.match(blocked.ok === false ? blocked.error : "", /settled since/);
  });

  test("accounts recording money confirms it as it is written", async () => {
    const customer = await makeCustomer();
    await makeBill(customer.id, 10_000_00);

    const recorded = await recordReceipt({
      customerId: customer.id,
      amount: 6_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      reference: "UTR904312",
      allocation: "auto",
      source: "accounts",
      idempotencyKey: randomUUID(),
    });
    assert.equal(recorded.ok, true, recorded.ok ? "" : recorded.error);
    assert.equal(recorded.ok && recorded.data.status, "confirmed");
    // It never appears on the confirm queue — that would be a queue of their
    // own keystrokes.
    assert.equal((await pendingReceipts()).length, 0);
  });

  /*
   * A reference is ASKED FOR and not demanded. Accounts confirm money they are
   * already looking at in the statement, so the entry is itself the
   * cross-check; refusing the save turned a receipt somebody could see into one
   * nobody could record. Both halves are pinned here — that it saves by
   * default, and that naming a mode brings the old rule back for it.
   */
  test("accounts can confirm a bank transfer with no reference", async () => {
    const customer = await makeCustomer();
    await makeBill(customer.id, 10_000_00);

    const recorded = await recordReceipt({
      customerId: customer.id,
      amount: 6_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      allocation: "auto",
      source: "accounts",
      idempotencyKey: randomUUID(),
    });
    assert.equal(recorded.ok, true, recorded.ok ? "" : recorded.error);
    assert.equal(recorded.ok && recorded.data.status, "confirmed");
  });

  test("a mode named in the settings still demands one", async () => {
    await updateSetting("payments.referenceRequiredModes", ["Bank transfer"], deepa.id);
    invalidateConfig();

    const customer = await makeCustomer();
    await makeBill(customer.id, 10_000_00);

    const refused = await recordReceipt({
      customerId: customer.id,
      amount: 6_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      allocation: "auto",
      source: "accounts",
      idempotencyKey: randomUUID(),
    });
    assert.equal(refused.ok, false);
    assert.match(refused.ok === false ? refused.error : "", /needs its reference/);
  });

  test("a retried save is the same payment, not a second one", async () => {
    const customer = await makeCustomer();
    await makeBill(customer.id, 10_000_00);
    const key = randomUUID();

    const first = await recordReceipt({
      customerId: customer.id,
      amount: 5_000_00,
      receivedAt: TODAY,
      mode: "Cash",
      allocation: "auto",
      source: "accounts",
      idempotencyKey: key,
    });
    const second = await recordReceipt({
      customerId: customer.id,
      amount: 5_000_00,
      receivedAt: TODAY,
      mode: "Cash",
      allocation: "auto",
      source: "accounts",
      idempotencyKey: key,
    });
    assert.equal(first.ok && second.ok, true);
    assert.equal(
      first.ok && second.ok && first.data.receiptId,
      second.ok ? second.data.receiptId : "",
    );
    const rows = await db.select().from(paymentReceipts);
    assert.equal(rows.length, 1);
  });
});

/* ============================================================= credit notes */

describe("Credit notes", () => {
  test("a request reaches the queue with its complaint and its bill", async () => {
    const customer = await makeCustomer({ name: "Om Sai" });
    const bill = await makeBill(customer.id, 20_000_00);
    await makeComplaintWithCn(customer.id, {
      billId: bill.id,
      cnAmount: 1_240_00,
      goodsDescription: "Two 20L drums, seals broken",
    });

    const rows = await pendingCreditNotes();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customerName, "Om Sai");
    assert.equal(rows[0].amount, 1_240_00);
    assert.equal(rows[0].billNo, bill.billNo);
    assert.equal(rows[0].billBalance, 20_000_00);
    // The stored enum is never what reaches the screen.
    assert.equal(rows[0].categoryLabel, "Packaging damage");
    assert.equal(rows[0].raisedByName, "Priya");
    assert.equal(await pendingCreditNoteCount(), 1);
  });

  test("a request naming no bill still reaches accounts", async () => {
    const customer = await makeCustomer();
    await makeComplaintWithCn(customer.id, { cnAmount: null });

    const rows = await pendingCreditNotes();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].billId, null);
    // Nobody put a figure on it, and that is ordinary — accounts set it.
    assert.equal(rows[0].amount, null);
  });

  test("issuing one comes off the bill and shows on the statement", async () => {
    const customer = await makeCustomer();
    const bill = await makeBill(customer.id, 20_000_00);
    const complaint = await makeComplaintWithCn(customer.id, { billId: bill.id });

    const done = await issueCreditNote({ complaintId: complaint.id, amount: 1_240_00 });
    assert.equal(done.ok, true, done.ok ? "" : done.error);

    const [b] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(b.paidAmount, 1_240_00, "the credit settles part of the bill");
    const [c] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(c.outstanding, 18_760_00);

    const [row] = await db.select().from(complaints).where(eq(complaints.id, complaint.id));
    assert.equal(row.cnStatus, "issued");
    assert.equal(row.cnAmount, 1_240_00);
    assert.equal(await pendingCreditNoteCount(), 0);

    // It is a receipt like any other, so it is on the statement and reversible.
    const ledger = await customerLedger(customer.id);
    const line = ledger!.entries.find((e) => e.ref === "Adjustment");
    assert.ok(line, "the credit note appears on the statement");
    assert.equal(line.credit, 1_240_00);
  });

  test("a credit note is not money in", async () => {
    const customer = await makeCustomer();
    const bill = await makeBill(customer.id, 20_000_00);
    const complaint = await makeComplaintWithCn(customer.id, { billId: bill.id });
    await issueCreditNote({ complaintId: complaint.id, amount: 1_240_00 });

    const home = await accountsHome();
    // It settled a bill, so the book shrank...
    assert.equal(home.aging.total, 18_760_00);
    // ...but no cash arrived, and a figure headed "money in" that counts
    // paperwork is one somebody reconciles against the bank and finds short.
    assert.equal(home.money.confirmedToday, 0);
    assert.equal(home.money.confirmedTodayCount, 0);
    assert.equal(home.money.confirmedThisMonth, 0);
  });

  test("a credit note cannot be worth more than the bill it comes off", async () => {
    const customer = await makeCustomer();
    const bill = await makeBill(customer.id, 1_000_00);
    const complaint = await makeComplaintWithCn(customer.id, { billId: bill.id });

    const refused = await issueCreditNote({ complaintId: complaint.id, amount: 5_000_00 });
    assert.equal(refused.ok, false);
    assert.match(refused.ok === false ? refused.error : "", /only ₹1,000 open/);
  });

  test("issued with no bill named, it sits on account", async () => {
    const customer = await makeCustomer();
    const complaint = await makeComplaintWithCn(customer.id);

    const done = await issueCreditNote({ complaintId: complaint.id, amount: 900_00 });
    assert.equal(done.ok, true, done.ok ? "" : done.error);

    const held = await onAccountHolders();
    assert.equal(held.length, 1);
    assert.equal(held[0].amount, 900_00);
  });

  test("refusing demands a reason and leaves the money alone", async () => {
    const customer = await makeCustomer();
    const bill = await makeBill(customer.id, 20_000_00);
    const complaint = await makeComplaintWithCn(customer.id, { billId: bill.id });

    const blank = await refuseCreditNote(complaint.id, "  ");
    assert.equal(blank.ok, false);

    const done = await refuseCreditNote(complaint.id, "Seals were intact on the LR copy.");
    assert.equal(done.ok, true);

    const [row] = await db.select().from(complaints).where(eq(complaints.id, complaint.id));
    assert.equal(row.cnStatus, "rejected");
    assert.match(row.resolutionNotes ?? "", /Seals were intact/);
    const [b] = await db.select().from(bills).where(eq(bills.id, bill.id));
    assert.equal(b.paidAmount, 0);
    assert.equal(await pendingCreditNoteCount(), 0);
  });

  test("issuing twice is refused", async () => {
    const customer = await makeCustomer();
    const bill = await makeBill(customer.id, 20_000_00);
    const complaint = await makeComplaintWithCn(customer.id, { billId: bill.id });

    await issueCreditNote({ complaintId: complaint.id, amount: 500_00 });
    const again = await issueCreditNote({ complaintId: complaint.id, amount: 500_00 });
    assert.equal(again.ok, false);
    assert.equal(again.ok === false && again.code, "conflict");
  });

  test("only accounts may issue one", async () => {
    const customer = await makeCustomer();
    const complaint = await makeComplaintWithCn(customer.id);
    setTestUser(manager);
    await assert.rejects(
      () => issueCreditNote({ complaintId: complaint.id, amount: 100_00 }),
      NotPermittedError,
    );
    setTestUser(priya);
    await assert.rejects(
      () => refuseCreditNote(complaint.id, "no"),
      NotPermittedError,
    );
  });
});

/* ============================================================== on account */

describe("On account", () => {
  /** A confirmed receipt bigger than the bills it names leaves a credit. */
  async function overpay(customerId: string, amount: number, billTotal: number) {
    if (billTotal > 0) await makeBill(customerId, billTotal);
    const done = await recordReceipt({
      customerId,
      amount,
      receivedAt: TODAY,
      mode: "Cash",
      allocation: "auto",
      source: "accounts",
      idempotencyKey: randomUUID(),
    });
    assert.equal(done.ok, true, done.ok ? "" : done.error);
  }

  test("a remainder becomes a credit rather than being refused at the door", async () => {
    const customer = await makeCustomer({ name: "Vinayak Hardware" });
    await overpay(customer.id, 12_000_00, 10_000_00);

    const held = await onAccountHolders();
    assert.equal(held.length, 1);
    assert.equal(held[0].customerName, "Vinayak Hardware");
    assert.equal(held[0].amount, 2_000_00);
    assert.equal(held[0].outstanding, 0);
    assert.equal(held[0].oldestOpenBillId, null, "nothing left open to point it at");
  });

  test("applying it settles the oldest open bill and rebuilds the figures", async () => {
    const customer = await makeCustomer();
    await overpay(customer.id, 12_000_00, 10_000_00);
    // A new bill arrives after the credit was taken.
    const next = await makeBill(customer.id, 5_000_00, {
      billNo: "MMI/26-27/9001",
      billDate: TODAY,
    });

    const done = await applyOnAccount(customer.id);
    assert.equal(done.ok, true, done.ok ? "" : done.error);
    assert.equal(done.ok && done.data.applied, 2_000_00);
    assert.equal(done.ok && done.data.billNo, "MMI/26-27/9001");

    const [b] = await db.select().from(bills).where(eq(bills.id, next.id));
    assert.equal(b.paidAmount, 2_000_00);
    const [c] = await db.select().from(customers).where(eq(customers.id, customer.id));
    assert.equal(c.outstanding, 3_000_00);
    assert.equal((await onAccountHolders()).length, 0, "the credit is spent");
  });

  test("a credit larger than the bill splits, and the rest stays on account", async () => {
    const customer = await makeCustomer();
    await overpay(customer.id, 12_000_00, 0);
    const small = await makeBill(customer.id, 3_000_00, { billDate: TODAY });

    const done = await applyOnAccount(customer.id);
    assert.equal(done.ok, true, done.ok ? "" : done.error);
    assert.equal(done.ok && done.data.applied, 3_000_00);

    const [b] = await db.select().from(bills).where(eq(bills.id, small.id));
    assert.equal(b.paidAmount, 3_000_00);

    const held = await onAccountHolders();
    assert.equal(held.length, 1);
    assert.equal(held[0].amount, 9_000_00, "the remainder is still a credit");

    // The split kept the money on the receipt it arrived on — one arrival of
    // money, two lines.
    const receipts = await db.select().from(paymentReceipts);
    assert.equal(receipts.length, 1);
    const lines = await db
      .select()
      .from(payments)
      .where(eq(payments.receiptId, receipts[0].id));
    assert.equal(lines.reduce((a, l) => a + l.amount, 0), 12_000_00);
  });

  test("with nothing open it says so rather than doing nothing", async () => {
    const customer = await makeCustomer();
    await overpay(customer.id, 12_000_00, 10_000_00);
    const refused = await applyOnAccount(customer.id);
    assert.equal(refused.ok, false);
    assert.match(refused.ok === false ? refused.error : "", /nothing open/);
  });

  test("a telecaller cannot move money between bills", async () => {
    const customer = await makeCustomer();
    await overpay(customer.id, 12_000_00, 10_000_00);
    setTestUser(priya);
    await assert.rejects(() => applyOnAccount(customer.id), NotPermittedError);
  });
});

/* ================================================================= the desk */

describe("Today", () => {
  test("every figure on it is the one its own screen shows", async () => {
    const customer = await makeCustomer();
    await makeBill(customer.id, 10_000_00);
    await db.insert(orders).values({
      id: id("ord"),
      customerId: customer.id,
      userId: priya.id,
      orderedAt: new Date(Date.now() - 30 * 3600_000),
      totalAmount: 7_500_00,
      status: "pending_approval",
    });
    await makeComplaintWithCn(customer.id, { cnAmount: 600_00 });

    setTestUser(priya);
    await recordReceipt({
      customerId: customer.id,
      amount: 2_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });

    setTestUser(deepa);
    const home = await accountsHome();

    assert.equal(home.orders.count, 1);
    assert.equal(home.orders.value, 7_500_00);
    assert.ok(home.orders.oldestHours >= 29);
    assert.equal(home.payments.count, 1);
    assert.equal(home.payments.value, 2_000_00);
    assert.equal(home.credits.count, 1);
    assert.equal(home.credits.value, 600_00);

    // The counts agree with the services the queues themselves read.
    assert.equal(home.orders.count, await pendingOrderCount());
    assert.equal(home.payments.count, (await pendingReceipts()).length);
    assert.equal(home.credits.count, await pendingCreditNoteCount());

    // Reported money is in exactly one figure and nowhere else.
    assert.equal(home.money.awaiting, 2_000_00);
    assert.equal(home.money.confirmedToday, 0);
    assert.equal(home.money.confirmedThisMonth, 0);

    // The whole open book is on the aging strip.
    assert.equal(home.aging.total, 10_000_00);
    assert.equal(home.aging.bills, 1);
  });

  test("confirmed money reaches today's figure and the aging strip empties", async () => {
    const customer = await makeCustomer();
    await makeBill(customer.id, 10_000_00);
    await recordReceipt({
      customerId: customer.id,
      amount: 10_000_00,
      receivedAt: TODAY,
      mode: "Cash",
      allocation: "auto",
      source: "accounts",
      idempotencyKey: randomUUID(),
    });

    const home = await accountsHome();
    assert.equal(home.money.confirmedToday, 10_000_00);
    assert.equal(home.money.confirmedTodayCount, 1);
    assert.equal(home.money.awaiting, 0);
    assert.equal(home.aging.total, 0, "nothing is open any more");
  });

  test("what was decided today is read from the log, not from the rows", async () => {
    const customer = await makeCustomer({ name: "Balaji Traders" });
    const [order] = await db
      .insert(orders)
      .values({
        id: id("ord"),
        customerId: customer.id,
        userId: priya.id,
        orderedAt: new Date(),
        totalAmount: 6_200_00,
        status: "pending_approval",
      })
      .returning();

    await approveOrder(order.id);

    const home = await accountsHome();
    assert.equal(home.decided.length, 1);
    assert.equal(home.decided[0].line, "Approved an order worth ₹6,200");
    assert.equal(home.decided[0].actorName, "Deepa");
    assert.equal(home.decided[0].customerName, "Balaji Traders");
  });

  test("the aging strip buckets on the configured boundaries", () => {
    const rows = [
      { overdueDays: 0, balance: 100 },
      { overdueDays: 10, balance: 200 },
      { overdueDays: 30, balance: 400 },
      { overdueDays: 60, balance: 800 },
      { overdueDays: 200, balance: 1600 },
    ];
    const { buckets, total } = bucketise(rows, [0, 15, 45, 90]);
    assert.equal(total, 3100);
    // The labels are the escalation engine's, not this file's — the Bills
    // table stamps each row with the same function.
    assert.deepEqual(
      buckets.map((b) => [b.label, b.amount]),
      [
        ["Not due", 100],
        ["1–15 days", 200],
        ["16–45 days", 400],
        ["46–90 days", 800],
        ["91+ days", 1600],
      ],
    );
  });
});

/* ================================================================== the log */

describe("Audit log", () => {
  test("every decision this desk makes is readable afterwards", async () => {
    const customer = await makeCustomer({ name: "Ganesh Chemicals" });
    const bill = await makeBill(customer.id, 10_000_00);
    const [order] = await db
      .insert(orders)
      .values({
        id: id("ord"),
        customerId: customer.id,
        userId: priya.id,
        orderedAt: new Date(),
        totalAmount: 5_000_00,
        status: "pending_approval",
      })
      .returning();
    const complaint = await makeComplaintWithCn(customer.id, { billId: bill.id });

    await declineOrder(order.id, "Outstanding is over their limit.");
    await issueCreditNote({ complaintId: complaint.id, amount: 500_00 });

    setTestUser(priya);
    await recordReceipt({
      customerId: customer.id,
      amount: 1_000_00,
      receivedAt: TODAY,
      mode: "Cash",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });
    setTestUser(deepa);
    const [waiting] = await pendingReceipts();
    await rejectReceipt(waiting.receiptId, "Not in the statement.");

    const rows = await accountsAudit();
    const actions = rows.map((r) => r.action);
    assert.ok(actions.includes("order.decline"));
    assert.ok(actions.includes("creditnote.issue"));
    assert.ok(actions.includes("payment.record"));
    assert.ok(actions.includes("payment.reject"));

    // Every row names a person, a customer and says what happened in words.
    for (const row of rows) {
      assert.ok(row.what.length > 0, `${row.action} has no sentence`);
      assert.notEqual(row.what, row.action, `${row.action} reached the screen raw`);
      assert.equal(row.on, "Ganesh Chemicals");
    }

    const declined = rows.find((r) => r.action === "order.decline");
    assert.match(declined!.what, /Outstanding is over their limit/);
    const rejected = rows.find((r) => r.action === "payment.reject");
    assert.match(rejected!.what, /₹1,000/);
  });
});

/* ============================================================ the money screens */

describe("Bills, search and the statement", () => {
  test("the ledger is cut by financial year", async () => {
    const customer = await makeCustomer();
    await makeBill(customer.id, 1_000_00, {
      billNo: "MMI/26-27/1119",
      billDate: "2026-07-26",
      dueDate: "2026-08-25",
    });
    await makeBill(customer.id, 2_000_00, {
      billNo: "MMI/25-26/0912",
      billDate: "2026-02-14",
      dueDate: "2026-03-16",
    });

    const thisYear = await listBills({ financialYear: "26-27" });
    assert.equal(thisYear.length, 1);
    assert.equal(thisYear[0].billNo, "MMI/26-27/1119");

    const lastYear = await listBills({ financialYear: "25-26" });
    assert.equal(lastYear.length, 1);
    assert.equal(lastYear[0].billNo, "MMI/25-26/0912");

    const all = await listBills();
    assert.equal(all.length, 2);
  });

  test("search finds a customer by name, by bill and by reference", async () => {
    const customer = await makeCustomer({ name: "Krishna Paint House" });
    const bill = await makeBill(customer.id, 5_000_00, { billNo: "MMI/26-27/1140" });
    await recordReceipt({
      customerId: customer.id,
      amount: 100_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      reference: "HDFC22104",
      allocation: "auto",
      source: "accounts",
      idempotencyKey: randomUUID(),
    });

    const byName = await paymentSearch("Krishna");
    assert.equal(byName.length, 1);
    assert.equal(byName[0].matchedOn, "Customer");

    const byBill = await paymentSearch("1140");
    assert.equal(byBill.length, 1);
    assert.equal(byBill[0].matchedOn, `Bill ${bill.billNo}`);

    const byRef = await paymentSearch("HDFC22104");
    assert.equal(byRef.length, 1);
    assert.equal(byRef[0].matchedOn, "Reference HDFC22104");

    assert.deepEqual(await paymentSearch("K"), [], "one character searches nothing");
  });

  test("open bills subtract money already reported against them", async () => {
    const customer = await makeCustomer();
    const bill = await makeBill(customer.id, 10_000_00);

    setTestUser(priya);
    await recordReceipt({
      customerId: customer.id,
      amount: 4_000_00,
      receivedAt: TODAY,
      mode: "Cash",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });

    setTestUser(deepa);
    const open = await openBillsFor(customer.id);
    assert.equal(open.length, 1);
    assert.equal(open[0].balance, 10_000_00, "the bill has not moved");
    assert.equal(open[0].reported, 4_000_00, "but ₹4,000 is already claimed");
    assert.equal(open[0].id, bill.id);
  });

  /*
   * THE BILL A TELECALLER HAS CLAIMED IS STILL RECORDABLE AGAINST.
   *
   * This is the whole point of not subtracting. A customer says they have paid
   * bill X; the telecaller writes it down; days later the transfer appears on
   * the statement and accounts go to record it against bill X — which is
   * exactly the bill the claim had made unavailable. There was no way through
   * it but to reject the claim first.
   */
  test("a fully claimed bill can still be settled by accounts", async () => {
    const customer = await makeCustomer();
    const bill = await makeBill(customer.id, 10_000_00);

    setTestUser(priya);
    await recordReceipt({
      customerId: customer.id,
      amount: 10_000_00,
      receivedAt: TODAY,
      mode: "Cash",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });

    setTestUser(deepa);
    const open = await openBillsFor(customer.id);
    assert.equal(open[0].balance, 10_000_00, "the whole balance is still offered");
    assert.equal(open[0].reported, 10_000_00, "and what is claimed is said beside it");

    const recorded = await recordReceipt({
      customerId: customer.id,
      amount: 10_000_00,
      receivedAt: TODAY,
      mode: "Bank transfer",
      reference: "UTR7781",
      allocation: "settle",
      selectedBillIds: [bill.id],
      source: "accounts",
      idempotencyKey: randomUUID(),
    });
    assert.equal(recorded.ok, true, recorded.ok ? "" : recorded.error);
    assert.equal(recorded.ok && recorded.data.onAccount, 0, "it lands on the bill, not on account");
    assert.equal(recorded.ok && recorded.data.billsTouched, 1);
  });

  test("the statement balance counts confirmed money only", async () => {
    const customer = await makeCustomer();
    await makeBill(customer.id, 10_000_00, { billDate: addDays(TODAY, -5) });

    setTestUser(priya);
    await recordReceipt({
      customerId: customer.id,
      amount: 3_000_00,
      receivedAt: TODAY,
      mode: "Cash",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });

    setTestUser(deepa);
    const ledger = await customerLedger(customer.id);
    assert.equal(ledger!.entries.length, 2);
    assert.equal(ledger!.totals.outstanding, 10_000_00);
    assert.equal(ledger!.awaiting.count, 1);
    assert.equal(ledger!.awaiting.amount, 3_000_00);
    // The last balance agrees with what the customer owes.
    assert.equal(ledger!.entries.at(-1)!.balance, 10_000_00);
  });
});

/* =============================================================== the badges */

describe("The sidebar", () => {
  test("urgency is read from the oldest thing waiting", async () => {
    const customer = await makeCustomer();
    await db.insert(orders).values({
      id: id("ord"),
      customerId: customer.id,
      userId: priya.id,
      orderedAt: new Date(Date.now() - 50 * 3600_000),
      totalAmount: 1_000_00,
      status: "pending_approval",
    });

    setTestUser(priya);
    await recordReceipt({
      customerId: customer.id,
      amount: 100_00,
      receivedAt: TODAY,
      mode: "Cash",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });

    setTestUser(deepa);
    const urgency = await queueUrgency();
    assert.ok(urgency.oldestOrderHours >= 49, `got ${urgency.oldestOrderHours}`);
    assert.ok(urgency.oldestReceiptHours < 1, `got ${urgency.oldestReceiptHours}`);
  });
});

/* ============================================================ the launcher */

describe("The launcher tile", () => {
  test("counts all three queues, and the sentence names what the number is", async () => {
    const customer = await makeCustomer();
    await db.insert(appAccess).values({
      id: id("acc"),
      userId: deepa.id,
      app: "accounts",
      grantedById: manager.id,
    });

    await db.insert(orders).values({
      id: id("ord"),
      customerId: customer.id,
      userId: priya.id,
      orderedAt: new Date(),
      totalAmount: 5_000_00,
      status: "pending_approval",
    });
    await makeComplaintWithCn(customer.id, { cnAmount: 500_00 });
    await makeBill(customer.id, 10_000_00);

    setTestUser(priya);
    await recordReceipt({
      customerId: customer.id,
      amount: 1_000_00,
      receivedAt: TODAY,
      mode: "Cash",
      allocation: "auto",
      source: "collections_call",
      idempotencyKey: randomUUID(),
    });

    setTestUser(deepa);
    const tile = (await launcherApps(deepa)).find((a) => a.id === "accounts");
    assert.ok(tile, "accounts must see their own app on the launcher");
    // One order, one payment, one credit note. The badge was counting orders
    // alone, which left two queues invisible from the launcher.
    assert.equal(tile.count, 3);
    assert.match(tile.status, /1 order to approve/);
    assert.match(tile.status, /1 payment to confirm/);
    assert.match(tile.status, /1 credit note/);
  });

  test("an empty desk says so rather than showing a zero", async () => {
    await db.insert(appAccess).values({
      id: id("acc"),
      userId: deepa.id,
      app: "accounts",
      grantedById: manager.id,
    });

    const tile = (await launcherApps(deepa)).find((a) => a.id === "accounts");
    assert.equal(tile?.count, 0);
    assert.equal(tile?.status, "Nothing waiting");
  });
});

/* ============================================================ the import */

describe("Sheet import", () => {
  test("the screen reads what the runs actually did, newest first", async () => {
    await db.insert(sheetSyncRuns).values([
      {
        id: id("syn"),
        source: "order_details",
        spreadsheetId: "sheet1",
        tabTitle: "Order Details",
        status: "ok",
        startedAt: new Date(Date.now() - 7200_000),
        finishedAt: new Date(Date.now() - 7100_000),
        rowsCreated: 555,
        rowsUnchanged: 23_619,
        rowsWithIssues: 2,
      },
      {
        id: id("syn"),
        source: "order_details",
        spreadsheetId: "sheet1",
        tabTitle: "Order Details",
        status: "failed",
        startedAt: new Date(Date.now() - 10_800_000),
        error: "The sheet could not be read.",
      },
    ]);

    const state = await importState();
    assert.equal(state.runs.length, 2);
    assert.equal(state.last!.ok, true, "the newest run is the one reported at the top");
    assert.equal(state.last!.created, 555);
    assert.equal(state.last!.unchanged, 23_619);
    assert.equal(state.last!.withIssues, 2);
    assert.equal(state.runs[1].ok, false);
    assert.equal(state.runs[1].error, "The sheet could not be read.");

    // Accounts may run it; that is the whole reason this screen exists.
    assert.equal(state.canRun, true);
    assert.ok(state.owners.length >= 3, "an owner has to be choosable");
  });

  test("a telecaller may not run it", async () => {
    setTestUser(priya);
    const state = await importState();
    assert.equal(state.canRun, false);
    assert.equal(state.owners.length, 0, "the owner list is not a staff directory");
  });
});

/* ---------------------------------------------------------------------------
 * The list and the record have to agree about who may see a customer.
 *
 * When they disagreed, the Accounts bill list showed a customer and opening
 * them threw — a 500, because a throw in a server component is not a redirect.
 * ------------------------------------------------------------------------- */

describe("Seeing a customer you hold only the back office seat on", () => {
  test("the statement opens rather than throwing", async () => {
    // Seema does the dispatch and the paperwork for this account and sells to
    // nobody on it. `scopedToUsers` puts it on her list; the row check used to
    // say it was not hers, so the list offered a row that could not be opened.
    const seema = await makeUser("Seema", "telecaller");
    const customer = await makeCustomer({
      ownerId: priya.id,
      salesAmId: priya.id,
      backOfficeAmId: seema.id,
    });
    await makeBill(customer.id, 10_000_00);

    setTestUser(seema);
    const ledger = await customerLedger(customer.id);
    assert.ok(ledger, "the customer's own statement refused to open for them");
    assert.equal(ledger.customerId, customer.id);
    setTestUser(deepa);
  });

  test("and somebody holding neither seat still cannot", async () => {
    // The widening is both seats, not no check at all.
    const stranger = await makeUser("Stranger", "telecaller");
    const customer = await makeCustomer({
      ownerId: priya.id,
      salesAmId: priya.id,
      backOfficeAmId: null,
    });

    setTestUser(stranger);
    await assert.rejects(
      () => customerLedger(customer.id),
      (e: Error) => e instanceof NotPermittedError,
      "an account on neither of somebody's seats was readable",
    );
    setTestUser(deepa);
  });
});
