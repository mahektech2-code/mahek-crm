/**
 * The "ALL OUTSTANDING BILLS" import, against a real database.
 *
 *   npm run test:outstanding
 *
 * What these prove is the half a dry run cannot: that a Paid row settles a
 * bill, that a Pending row opens one, that neither ever overrules money
 * accounts have confirmed, and that running the whole thing twice lands on the
 * same ledger. It writes money, so it is tested like something that writes
 * money.
 *
 * Needs mahekone_test, which `npm run test:db` creates. The harness truncates
 * between tests — never point this at a database anybody is using.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { bills, customers, paymentReceipts, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { addDays } from "@/lib/business-date";
import { today, recomputeOutstanding } from "@/lib/recompute";
import {
  applyOutstanding,
  OUTSTANDING_SOURCE,
} from "@/lib/services/outstanding-import-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let TODAY: string;
let priya: typeof users.$inferSelect;
let customer: typeof customers.$inferSelect;

const HEAD = [
  "Bill Number", "Customer Name", "Bill Total Amount",
  "Bill Outstanding Amount", "Status", "Date", "Reason",
];

/** A sheet row, in rupees, the way the workbook writes one. */
function row(
  billNo: string,
  amount: number,
  outstanding: number,
  status: string,
  reason = "",
  date = "",
) {
  return [billNo, customer.name, String(amount), String(outstanding), status, date, reason];
}

async function makeBill(amount: number, over: Partial<typeof bills.$inferInsert> = {}) {
  const [b] = await db
    .insert(bills)
    .values({
      id: id("bil"),
      customerId: customer.id,
      billNo: over.billNo ?? `MMI/26-27/${Math.floor(Math.random() * 899999) + 100000}`,
      billDate: over.billDate ?? addDays(TODAY, -40),
      dueDate: over.dueDate ?? addDays(TODAY, -10),
      amount,
      paymentPosition: over.paymentPosition ?? "unstated",
      ...over,
    })
    .returning();
  return b;
}

/** A receipt of the given source, confirmed, allocated wholly to one bill. */
async function makeReceipt(billId: string, amount: number, source: string) {
  const receiptId = id("rcp");
  const at = addDays(TODAY, -5);
  // Raw, naming only the columns the DEPLOYED schema has — the same reason the
  // service inserts this way. `0053_receipt_cash_deposit` is in the journal and
  // has never actually applied, so neither production nor mahekone_test carries
  // `deposited_at`, while `schema.ts` does. A fixture built through Drizzle's
  // insert builder would name it and fail before reaching the code under test.
  await db.execute(sql`
    insert into payment_receipts
      (id, customer_id, amount, received_at, mode, status, source, idempotency_key)
    values (${receiptId}, ${customer.id}, ${amount}, ${at}, 'Bank transfer',
            'confirmed', ${source}, ${`${source}-${receiptId}`})
  `);
  await db.execute(sql`
    insert into payments (id, receipt_id, bill_id, customer_id, amount, paid_at, mode)
    values (${id("pay")}, ${receiptId}, ${billId}, ${customer.id}, ${amount}, ${at}, 'Bank transfer')
  `);
  return receiptId;
}

async function billState(billId: string) {
  const [b] = await db
    .select({
      amount: bills.amount,
      paid: bills.paidAmount,
      status: bills.status,
      position: bills.paymentPosition,
      decidedAt: bills.paymentDecidedAt,
    })
    .from(bills)
    .where(eq(bills.id, billId));
  return b;
}

async function receiptCount(source?: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentReceipts)
    .where(source ? eq(paymentReceipts.source, source) : sql`true`);
  return r.n;
}

async function outstandingOf() {
  const [c] = await db
    .select({ o: customers.outstanding })
    .from(customers)
    .where(eq(customers.id, customer.id));
  return c.o;
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
      audit_log, job_runs, notifications, follow_up_attempts, follow_up_states,
      payments, payment_receipts, bills, orders, calls, app_access, sessions,
      customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  const [p] = await db
    .insert(users)
    .values({
      id: id("usr"), name: "Priya", email: "priya@test.local",
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x", role: "telecaller", initials: "PR",
    })
    .returning();
  priya = p;
  setTestUser(priya);
  TODAY = await today();

  const [c] = await db
    .insert(customers)
    .values({
      id: id("cus"), name: "A TO Z ENTERPRISES", contactPerson: "Contact",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Mumbai", ownerId: priya.id, salesAmId: priya.id,
      customerSince: addDays(TODAY, -400),
    })
    .returning();
  customer = c;
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("Applying the outstanding workbook", () => {
  test("a Pending row opens the bill and strips the sheet's assumed receipt", async () => {
    const bill = await makeBill(10_000_00, { billNo: "MMI/26-27/0972" });
    await makeReceipt(bill.id, 10_000_00, "sheet_import");
    await recomputeOutstanding(customer.id);

    const r = await applyOutstanding([
      HEAD, row("MMI/26-27/0972", 10_000, 10_000, "Pending", "Pending"),
    ]);

    assert.equal(r.matched, 1);
    assert.equal(r.receiptsRemoved, 1);
    const b = await billState(bill.id);
    assert.equal(b.paid, 0);
    assert.equal(b.status, "unpaid");
    assert.equal(b.position, "stated");
    // The debt is now real, and counted.
    assert.equal(await outstandingOf(), 10_000_00);
    assert.equal(await receiptCount("sheet_import"), 0);
  });

  test("a Paid row settles the bill, creating the receipt that says so", async () => {
    const bill = await makeBill(74_823_00, { billNo: "MMI/26-27/0857" });

    const r = await applyOutstanding([
      HEAD, row("MMI/26-27/0857", 74_823, 74_823, "Paid", "Transfred", "19/08/2026"),
    ]);

    assert.equal(r.matched, 1);
    assert.equal(r.receiptsCreated, 1);
    const b = await billState(bill.id);
    assert.equal(b.paid, 74_823_00);
    assert.equal(b.status, "paid");
    assert.equal(b.position, "stated");
    assert.equal(await outstandingOf(), 0);

    // Explicit columns for the same reason the fixture is raw: a bare select()
    // names every column in the model, `deposited_at` included.
    const [rec] = await db
      .select({
        amount: paymentReceipts.amount,
        status: paymentReceipts.status,
        mode: paymentReceipts.mode,
        receivedAt: paymentReceipts.receivedAt,
        idempotencyKey: paymentReceipts.idempotencyKey,
      })
      .from(paymentReceipts)
      .where(eq(paymentReceipts.source, OUTSTANDING_SOURCE));
    assert.equal(rec.amount, 74_823_00);
    assert.equal(rec.status, "confirmed");
    assert.equal(rec.mode, "Bank transfer");
    assert.equal(rec.receivedAt, "2026-08-19");
    assert.equal(rec.idempotencyKey, "TALLYOUT-MMI/26-27/0857");
  });

  test("a credit note and an adjustment are recorded as what they were", async () => {
    await makeBill(81_469_00, { billNo: "MMI/25-26/0881" });
    await makeBill(11_460_00, { billNo: "MMI/25-26/1969" });

    await applyOutstanding([
      HEAD,
      row("MMI/25-26/0881", 81_469, 1_769, "Paid", "CN"),
      row("MMI/25-26/1969", 11_460, 168, "Paid", "Adjusted"),
    ]);

    const modes = await db
      .select({ mode: paymentReceipts.mode })
      .from(paymentReceipts)
      .where(eq(paymentReceipts.source, OUTSTANDING_SOURCE))
      .orderBy(paymentReceipts.mode);
    // Not "Bank transfer": neither of these is money anybody can find in a
    // bank statement, and both close a bill exactly the same way.
    assert.deepEqual(modes.map((m) => m.mode), ["Adjustment", "Credit note"]);
  });

  test("it never overrules a receipt accounts confirmed", async () => {
    const bill = await makeBill(50_000_00, { billNo: "MMI/26-27/0500" });
    await makeReceipt(bill.id, 50_000_00, "accounts");
    await recomputeOutstanding(customer.id);

    // The sheet says the whole thing is still owed. Accounts have already
    // found the money in the bank. The spreadsheet does not win.
    const r = await applyOutstanding([
      HEAD, row("MMI/26-27/0500", 50_000, 50_000, "Pending", "Pending"),
    ]);

    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].billNo, "MMI/26-27/0500");
    assert.equal(r.conflicts[0].confirmedPaise, 50_000_00);
    assert.equal(r.conflicts[0].statedSettledPaise, 0);
    assert.equal(r.receiptsRemoved, 0);

    const b = await billState(bill.id);
    assert.equal(b.paid, 50_000_00, "confirmed money is untouched");
    assert.equal(await receiptCount("accounts"), 1);
  });

  test("a REVERSED assumed receipt is left exactly as it stands", async () => {
    // Production is full of these: `sheet_import` receipts an earlier cleanup
    // reversed. A reversed receipt weighs nothing already — paid is derived
    // from confirmed money — so editing one moves no figure and only rewrites
    // somebody's record that this money counted and then failed.
    const bill = await makeBill(81_469_00, { billNo: "MMI/25-26/0881" });
    const reversedId = await makeReceipt(bill.id, 81_469_00, "sheet_import");
    await db
      .update(paymentReceipts)
      .set({ status: "reversed" })
      .where(eq(paymentReceipts.id, reversedId));
    // Real, confirmed money from the Tally receipts import.
    await makeReceipt(bill.id, 79_700_00, "tally_receipts");

    // The sheet says settled, with Rs 1,769 of it cleared by a credit note.
    const r = await applyOutstanding([
      HEAD, row("MMI/25-26/0881", 81_469, 1_769, "Paid", "CN"),
    ]);

    const [rev] = await db
      .select({ amount: paymentReceipts.amount, status: paymentReceipts.status })
      .from(paymentReceipts)
      .where(eq(paymentReceipts.id, reversedId));
    assert.equal(rev.amount, 81_469_00, "the reversal is untouched");
    assert.equal(rev.status, "reversed");

    // The gap is closed by a NEW receipt for what was actually cleared.
    assert.equal(r.receiptsCreated, 1);
    assert.equal(r.receiptsAdjusted, 0);
    const [made] = await db
      .select({ amount: paymentReceipts.amount, mode: paymentReceipts.mode })
      .from(paymentReceipts)
      .where(eq(paymentReceipts.source, OUTSTANDING_SOURCE));
    assert.equal(made.amount, 1_769_00);
    assert.equal(made.mode, "Credit note");
    // 79,700 confirmed + 1,769 credit note = the whole bill.
    assert.equal((await billState(bill.id)).paid, 81_469_00);
    assert.equal(await outstandingOf(), 0);
  });

  test("a blank status writes nothing at all", async () => {
    const bill = await makeBill(23_423_00, { billNo: "MMI/26-27/0751/8635" });

    const r = await applyOutstanding([
      HEAD, ["MMI/26-27/0751/8635", customer.name, "23423", "23423", "", "", ""],
    ]);

    assert.equal(r.read, 0);
    assert.equal(r.unstated.length, 1);
    assert.equal(r.unstatedPaise, 23_423_00);
    const b = await billState(bill.id);
    assert.equal(b.position, "unstated", "still nobody's statement");
    assert.equal(b.paid, 0);
    // An unstated bill is not debt, so it stays out of the figure.
    assert.equal(await outstandingOf(), 0);
  });

  test("one Tally bill split over orders is spread oldest first", async () => {
    const a = await makeBill(10_000_00, {
      billNo: "MMI/26-27/0718/8590", billDate: addDays(TODAY, -50),
    });
    const b = await makeBill(10_000_00, {
      billNo: "MMI/26-27/0718/8591", billDate: addDays(TODAY, -40),
    });

    // Rs 12,000 of the Rs 20,000 group is still owed.
    const r = await applyOutstanding([
      HEAD, row("MMI/26-27/0718", 20_000, 12_000, "Pending", "Pending"),
    ]);

    assert.equal(r.splitGroups, 1);
    assert.equal(r.splitBills, 2);
    // The oldest takes the debt first: 10,000 on the first, 2,000 on the next.
    assert.equal((await billState(a.id)).paid, 0);
    assert.equal((await billState(b.id)).paid, 8_000_00);
    assert.equal(await outstandingOf(), 12_000_00);
  });

  test("running it twice lands on the same ledger", async () => {
    const paid = await makeBill(74_823_00, { billNo: "MMI/26-27/0857" });
    const owed = await makeBill(10_000_00, { billNo: "MMI/26-27/0972" });
    await makeReceipt(owed.id, 10_000_00, "sheet_import");

    const sheet = [
      HEAD,
      row("MMI/26-27/0857", 74_823, 74_823, "Paid", "Transfred"),
      row("MMI/26-27/0972", 10_000, 10_000, "Pending", "Pending"),
    ];

    await applyOutstanding(sheet);
    const first = {
      paid: (await billState(paid.id)).paid,
      owed: (await billState(owed.id)).paid,
      outstanding: await outstandingOf(),
      receipts: await receiptCount(),
    };

    const second = await applyOutstanding(sheet);

    assert.deepEqual(
      {
        paid: (await billState(paid.id)).paid,
        owed: (await billState(owed.id)).paid,
        outstanding: await outstandingOf(),
        receipts: await receiptCount(),
      },
      first,
      "a second run must not stack a second payment on every bill",
    );
    // Nothing moved, so nothing is reported as having moved.
    assert.equal(second.updated, 0);
    assert.equal(second.receiptsCreated, 0);
  });

  test("a dry run reports the same work and writes none of it", async () => {
    const bill = await makeBill(74_823_00, { billNo: "MMI/26-27/0857" });
    const sheet = [HEAD, row("MMI/26-27/0857", 74_823, 74_823, "Paid", "Transfred")];

    const dry = await applyOutstanding(sheet, { dryRun: true });
    assert.equal(dry.matched, 1);
    assert.equal(dry.receiptsCreated, 1);
    assert.equal(await receiptCount(), 0, "a dry run writes nothing");
    assert.equal((await billState(bill.id)).position, "unstated");

    const wet = await applyOutstanding(sheet);
    assert.equal(wet.receiptsCreated, dry.receiptsCreated);
    assert.equal(await receiptCount(), 1);
  });

  test("a date the sheet puts in the future is pulled back to the run date", async () => {
    await makeBill(2_900_00, { billNo: "MMI/26-27/0960" });

    const r = await applyOutstanding(
      [HEAD, row("MMI/26-27/0960", 2_900, 2_900, "Paid", "Transfred", "46334")],
      { now: new Date("2026-08-21T06:00:00Z") },
    );

    assert.equal(r.datesClamped, 1);
    const [rec] = await db
      .select({ receivedAt: paymentReceipts.receivedAt })
      .from(paymentReceipts)
      .where(eq(paymentReceipts.source, OUTSTANDING_SOURCE));
    // The sheet said 2026-11-08. Money cannot have been received in November.
    assert.equal(rec.receivedAt, "2026-08-21");
  });

  test("a bill the sheet does not name keeps the position it had", async () => {
    const untouched = await makeBill(5_000_00, { billNo: "MMI/26-27/9999" });
    await makeBill(1_000_00, { billNo: "MMI/26-27/0972" });

    const r = await applyOutstanding([
      HEAD, row("MMI/26-27/0972", 1_000, 1_000, "Pending", "Pending"),
    ]);

    assert.equal(r.unmatched.length, 0);
    const b = await billState(untouched.id);
    assert.equal(b.position, "unstated");
    assert.equal(b.paid, 0);
  });
});
