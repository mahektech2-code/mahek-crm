/**
 * Production petty cash — the PRD's fourteen acceptance tests, against a real
 * database through the real services and screen handlers.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 * The tests run IN ORDER and build on each other, as the PRD's do: the
 * ₹5,000 expense of test 1 is paid in tests 2 and 3, the withdrawal of test 4
 * is the cash test 2 pays from, and so on.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  customers,
  erpCustomerCashReceipts,
  erpExpensePayments,
  erpExpenses,
  erpFundAccounts,
  erpFundTransfers,
  erpTallySync,
  erpUserPowers,
  paymentReceipts,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { today } from "@/lib/erp/screens/common";
import { balances } from "@/lib/erp/petty/core";
import { createExpense, decideExpense, editExpense, recordPayment, reversePayment, submitExpense } from "@/lib/erp/petty/expenses";
import { confirmTransfer, initiateTransfer, proposeOpening, recordReceipt, reviewClosing, submitClosing, verifyOpening } from "@/lib/erp/petty/funds";
import { confirmLines, importStatement } from "@/lib/erp/petty/bank";
import { loadExpense } from "@/lib/erp/petty/facts";
import { exceptions } from "@/lib/erp/petty/insight";
import { postToTally } from "@/lib/erp/petty/tally";
import { updateSettings } from "@/lib/config/store";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const R = 100;

async function makeUser(name: string, level: "associate" | "manager" | "admin", powers: string[] = []) {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}@petty.test`, phone: String(9820000000 + Math.floor(Math.random() * 999999)), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "erp", role: level });
  for (const p of powers) await db.insert(erpUserPowers).values({ userId: u.id, power: p });
  return u;
}
async function as(u: typeof users.$inferSelect) {
  setTestUser(u);
  return erpContext();
}
const msg = (r: { ok: boolean; fieldErrors?: { message: string }[]; error?: string; message?: string }) => (r.ok ? "ok" : (r.fieldErrors?.[0]?.message ?? r.error ?? "?"));
const bal = async (fund: string) => (await balances()).get(fund) ?? 0;
const count = async (table: string) => Number(((await db.execute(sql.raw(`select count(*)::int as n from ${table}`))) as unknown as { n: number }[])[0].n);

const KOTAK = "fund_kotak";
const CASH = "fund_prod_bank_cash";
const CUST = "fund_prod_customer_cash";

let head: typeof users.$inferSelect;
let accountant: typeof users.$inferSelect;
let approver: typeof users.$inferSelect;
let owner: typeof users.$inferSelect;
let expenseId: string;
let firstPaymentId: string;
let receiptId: string;
const day = today();
const dmy = `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;

before(async () => {
  await db.execute(sql`
    truncate users, customers, erp_expenses, erp_expense_payments, erp_expense_approvals, erp_expense_adjustments, erp_fund_ledger,
             erp_fund_transfers, erp_customer_cash_receipts, erp_fund_adjustments, erp_cash_closings, erp_expense_budgets,
             erp_bank_imports, erp_bank_lines, erp_bank_matches, erp_tally_sync, erp_petty_evidence, erp_fund_accounts,
             erp_user_powers, erp_godown_staff, erp_user_settings, payment_receipts, audit_log restart identity cascade`);
  await db.execute(sql`update erp_series set last = 0`);
  /* Truncating users cascades into anything that names a user — the seeded categories among them. Put them back as the migration wrote them. */
  const { readFileSync } = await import("node:fs");
  const seed = readFileSync("drizzle/0245_petty_cash_funds_control.sql", "utf8").match(/INSERT INTO "erp_expense_categories"[\s\S]*?ON CONFLICT DO NOTHING;/)![0];
  await db.execute(sql.raw(seed));
  await db.execute(sql`delete from app_settings where key like 'erp.tally.%' or key like 'erp.pettyCash.%'`);
  head = await makeUser("Production Head", "associate");
  accountant = await makeUser("Asha Accounts", "associate", ["pettyAccounts"]);
  approver = await makeUser("Mohan Approver", "manager", ["pettyApprove"]);
  owner = await makeUser("Owner Shah", "associate", ["pettyOwner", "pettyApprove", "pettyAccounts"]);
  await db.insert(erpFundAccounts).values([
    { id: KOTAK, code: "KOTAK", name: "Kotak Bank — Company Account", fundType: "BANK" },
    { id: CASH, code: "PBC", name: "Production Bank Cash", fundType: "PHYSICAL_CASH", custodianUserId: head.id, godownId: "erpg_ambernath" },
    { id: CUST, code: "PCC", name: "Production Customer Cash", fundType: "CUSTOMER_CASH", custodianUserId: head.id, godownId: "erpg_ambernath" },
  ]);
  await db.insert(customers).values({ id: "cus_petty", name: "Shree Hardware", city: "Ambernath", phone: "9876500101", kind: "customer" });
  /* The opening balance: proposed by one person, verified and posted by another. */
  assert.equal(msg(await proposeOpening(await as(owner), KOTAK, { amountPaise: 50000 * R, date: day, note: "Statement balance" })), "ok");
  assert.match(msg(await verifyOpening(await as(owner), KOTAK)), /Somebody other than whoever proposed it/);
  assert.match(msg(await verifyOpening(await as(accountant), KOTAK)), /approver or the owner/);
  assert.equal(msg(await verifyOpening(await as(approver), KOTAK)), "ok");
  assert.equal(await bal(KOTAK), 50000 * R);
  for (const f of [CASH, CUST]) {
    await proposeOpening(await as(accountant), f, { amountPaise: 0, date: day, note: "Empty box" });
    await verifyOpening(await as(approver), f);
  }
});

after(async () => {
  setTestUser(null);
  await db.execute(sql`delete from app_settings where key like 'erp.tally.%'`);
  await db.$client.end();
});

describe("petty cash acceptance (PRD §22)", () => {
  test("1 · an approved ₹5,000 purchase with no payment is pending and moves no cash", async () => {
    const ctx = await as(head);
    const r = await createExpense(ctx, { date: day, particular: "Testing material", category: "Testing Material", txnType: "Testing material", godownId: "erpg_ambernath", vendorName: "Lakshmi Chemicals", amountPaise: 5000 * R, submit: true });
    assert.equal(msg(r), "ok");
    expenseId = (r as { data: { id: string } }).data.id;
    let f = (await loadExpense(expenseId))!;
    assert.equal(f.e.approvalStatus, "submitted", "₹5,000 without its bill goes to an approver");
    assert.equal(msg(await decideExpense(await as(approver), [expenseId], "approve", null)), "ok");
    f = (await loadExpense(expenseId))!;
    assert.equal(f.e.approvalStatus, "approved");
    assert.equal(f.state.amountPaise, 5000 * R);
    assert.equal(f.state.paidPaise, 0);
    assert.equal(f.state.outstandingPaise, 5000 * R);
    assert.equal(f.state.status, "PENDING");
    assert.equal(await bal(CASH), 0);
    assert.equal(await bal(KOTAK), 50000 * R);
  });

  test("4 · withdrawing ₹10,000 moves it from Kotak to production cash once received, and is no expense", async () => {
    const t = await initiateTransfer(await as(accountant), { type: "withdrawal", date: day, fromFundId: KOTAK, toFundId: CASH, amountPaise: 10000 * R, bankReference: "ATM-77881" });
    assert.equal(msg(t), "ok");
    assert.equal(await bal(KOTAK), 50000 * R, "in transit: nothing has moved");
    assert.equal(await bal(CASH), 0, "unconfirmed cash is not available");
    assert.match(msg(await confirmTransfer(await as(accountant), (t as { data: { id: string } }).data.id)), /not whoever sent it/);
    assert.equal(msg(await confirmTransfer(await as(head), (t as { data: { id: string } }).data.id)), "ok");
    assert.equal(await bal(KOTAK), 40000 * R);
    assert.equal(await bal(CASH), 10000 * R);
    assert.equal((await bal(KOTAK)) + (await bal(CASH)), 50000 * R, "total company funds unchanged");
    assert.equal(await count("erp_expenses"), 1, "a withdrawal is not an expense");
  });

  test("2 · paying ₹3,000 of it makes it partially paid and takes ₹3,000 off the fund", async () => {
    const r = await recordPayment(await as(head), expenseId, { date: day, amountPaise: 3000 * R, fundId: CASH, mode: "Cash", ackName: "Ramesh (Lakshmi)", requestKey: "req-test-2" });
    assert.equal(msg(r), "ok");
    firstPaymentId = (r as { data: { id: string } }).data.id;
    const f = (await loadExpense(expenseId))!;
    assert.equal(f.state.paidPaise, 3000 * R);
    assert.equal(f.state.outstandingPaise, 2000 * R);
    assert.equal(f.state.status, "PARTIALLY_PAID");
    assert.equal(f.state.amountPaise, 5000 * R, "the expense itself stays ₹5,000");
    assert.equal(await bal(CASH), 7000 * R);
  });

  test("12 · the same payment request sent twice posts once", async () => {
    const r = await recordPayment(await as(head), expenseId, { date: day, amountPaise: 3000 * R, fundId: CASH, mode: "Cash", ackName: "Ramesh (Lakshmi)", requestKey: "req-test-2" });
    assert.ok(r.ok);
    assert.equal((r as { data: { id: string; existing: boolean } }).data.existing, true);
    assert.equal((r as { data: { id: string } }).data.id, firstPaymentId);
    assert.equal(await count("erp_expense_payments"), 1);
    assert.equal(await bal(CASH), 7000 * R, "the fund went down once");
  });

  test("3 · the last ₹2,000 by UPI completes it, and the expense is still ₹5,000", async () => {
    const r = await recordPayment(await as(head), expenseId, { date: day, amountPaise: 2000 * R, fundId: KOTAK, mode: "UPI / GPay", reference: "412345678901" });
    assert.equal(msg(r), "ok");
    const f = (await loadExpense(expenseId))!;
    assert.equal(f.state.paidPaise, 5000 * R);
    assert.equal(f.state.outstandingPaise, 0);
    assert.equal(f.state.status, "COMPLETED");
    assert.equal(f.state.amountPaise, 5000 * R);
    assert.equal(await bal(KOTAK), 38000 * R);
    assert.match(msg(await recordPayment(await as(head), expenseId, { date: day, amountPaise: 1, fundId: KOTAK, mode: "UPI / GPay", reference: "X1" })), /Nothing is left to pay/);
  });

  const statement = [
    "Kotak Mahindra Bank,,,,,,,",
    "Account No: 1234,,,,,,,",
    "Sl. No.,Transaction Date,Value Date,Description,Chq / Ref No.,Debit,Credit,Balance",
    `1,${dmy},${dmy},ATM CASH WDL AMBERNATH,ATM-77881,"10,000.00",,"40,000.00"`,
    `2,${dmy},${dmy},UPI/412345678901/LAKSHMI CHEMICALS,412345678901,"2,000.00",,"38,000.00"`,
  ].join("\n");

  test("6 · the Kotak debit for an existing UPI payment matches it, and creates nothing", async () => {
    const before = { e: await count("erp_expenses"), p: await count("erp_expense_payments"), t: await count("erp_fund_transfers") };
    const r = await importStatement(await as(accountant), { fundId: KOTAK, csv: statement, fileName: "kotak.csv" });
    assert.equal(msg(r), "ok");
    const d = (r as { data: { added: number; matched: number; suggested: number } }).data;
    assert.equal(d.added, 2);
    assert.equal(d.matched, 2, "both carry the reference the movement was recorded with");
    const [pay] = await db.select().from(erpExpensePayments).where(eq(erpExpensePayments.reference, "412345678901"));
    assert.equal(pay.reconStatus, "matched");
    assert.deepEqual({ e: await count("erp_expenses"), p: await count("erp_expense_payments"), t: await count("erp_fund_transfers") }, before);
    const lines = (await db.execute(sql`select id from erp_bank_lines`)) as unknown as { id: string }[];
    assert.equal(msg(await confirmLines(await as(accountant), lines.map((l) => l.id))), "ok");
    const [after] = await db.select().from(erpExpensePayments).where(eq(erpExpensePayments.reference, "412345678901"));
    assert.equal(after.reconStatus, "reconciled");
    assert.match(msg(await importStatement(await as(head), { fundId: KOTAK, csv: statement })), /accounts team/, "reconciling is accounts' job");
  });

  test("5 · importing the same statement again adds nothing and says so", async () => {
    const before = { l: await count("erp_bank_lines"), e: await count("erp_expenses"), p: await count("erp_expense_payments"), t: await count("erp_fund_transfers") };
    const r = await importStatement(await as(accountant), { fundId: KOTAK, csv: statement });
    assert.ok(r.ok);
    const d = (r as { data: { added: number; duplicates: number; repeatOf: string | null } }).data;
    assert.equal(d.added, 0);
    assert.equal(d.duplicates, 2);
    assert.ok(d.repeatOf, "the import history names the earlier upload");
    assert.deepEqual({ l: await count("erp_bank_lines"), e: await count("erp_expenses"), p: await count("erp_expense_payments"), t: await count("erp_fund_transfers") }, before);
  });

  test("7 · ₹3,000 from a customer raises customer cash and is no sale", async () => {
    const salesBefore = await count("payment_receipts");
    const ordersBefore = await count("orders");
    const r = await recordReceipt(await as(head), { customerId: "cus_petty", date: day, amountPaise: 3000 * R, fundId: CUST, ackFileId: null, evidenceFileId: null });
    assert.match(msg(r), /acknowledgement/, "a receipt needs the customer's acknowledgement");
    const file = id("att");
    await db.execute(sql`insert into attachments (id, filename, content_type, size_bytes, stored_ref, status, uploaded_by_id) values (${file}, 'ack.jpg', 'image/jpeg', 10, ${file}, 'available', ${head.id})`);
    const ok = await recordReceipt(await as(head), { customerId: "cus_petty", date: day, amountPaise: 3000 * R, fundId: CUST, ackFileId: file });
    assert.equal(msg(ok), "ok");
    receiptId = (ok as { data: { id: string } }).data.id;
    assert.equal(await bal(CUST), 3000 * R);
    assert.equal(await count("erp_customer_cash_receipts"), 1);
    assert.equal(await count("payment_receipts"), salesBefore, "no second collection in the ledger");
    assert.equal(await count("orders"), ordersBefore, "no sale");
    const [t] = await db.select().from(erpTallySync).where(eq(erpTallySync.recordId, receiptId));
    assert.equal(t.status, "pending", "its Tally receipt is tracked on its own");
    void paymentReceipts;
  });

  test("8 · depositing it moves it into Kotak; the receipt is untouched and not repeated", async () => {
    const t = await initiateTransfer(await as(head), { type: "customerDeposit", date: day, fromFundId: CUST, toFundId: KOTAK, amountPaise: 3000 * R, bankReference: "DEP-5521", receiptIds: [receiptId] });
    assert.equal(msg(t), "ok");
    assert.match(msg(await initiateTransfer(await as(head), { type: "customerDeposit", date: day, fromFundId: CUST, toFundId: KOTAK, amountPaise: 3000 * R, bankReference: "DEP-5522", receiptIds: [receiptId] })), /already on/);
    assert.equal(msg(await confirmTransfer(await as(accountant), (t as { data: { id: string } }).data.id)), "ok");
    assert.equal(await bal(CUST), 0);
    assert.equal(await bal(KOTAK), 41000 * R);
    const [r] = await db.select().from(erpCustomerCashReceipts).where(eq(erpCustomerCashReceipts.id, receiptId));
    assert.equal(r.amountPaise, 3000 * R);
    assert.equal(r.status, "posted");
    assert.equal(await count("erp_customer_cash_receipts"), 1);
    const row = (await screenModule("pettyReceipts")!.load(await as(head))).rows.find((x) => x.id === receiptId)!;
    assert.equal(row.v.custody, "Deposited");
  });

  test("9 · a cash payment larger than the fund is refused and logged", async () => {
    const big = await createExpense(await as(head), { date: day, particular: "Pump repair", category: "Repairs and Maintenance", txnType: "Repairs and maintenance", godownId: "erpg_ambernath", vendorName: "Sai Engineering", amountPaise: 9000 * R, submit: true });
    const bigId = (big as { data: { id: string } }).data.id;
    await decideExpense(await as(approver), [bigId], "approve", null);
    const r = await recordPayment(await as(head), bigId, { date: day, amountPaise: 8000 * R, fundId: CASH, mode: "Cash", ackName: "Sai" });
    assert.match(msg(r), /holds ₹7,000/);
    assert.equal(await bal(CASH), 7000 * R, "no negative balance");
    const [logged] = (await db.execute(sql`select count(*)::int as n from audit_log where action = 'erp.petty.payment.refused'`)) as unknown as { n: number }[];
    assert.equal(Number(logged.n), 1);
    assert.match(msg(await recordPayment(await as(head), bigId, { date: day, amountPaise: 8000 * R, fundId: CASH, mode: "Cash", ackName: "Sai", overdrawReason: "Pump had to be fixed today" })), /Only an approver/);
  });

  test("10 · ₹500 short at closing is a variance for review, never an expense", async () => {
    const expensesBefore = await count("erp_expenses");
    const r = await submitClosing(await as(head), { fundId: CASH, date: day, countedPaise: 6500 * R, explanation: null });
    assert.match(msg(r), /short/);
    const ok = await submitClosing(await as(head), { fundId: CASH, date: day, countedPaise: 6500 * R, explanation: "Tea for the loading gang not written down" });
    assert.equal(msg(ok), "ok");
    const { id: closingId, variancePaise } = (ok as { data: { id: string; variancePaise: number } }).data;
    assert.equal(variancePaise, -500 * R);
    assert.equal(await count("erp_expenses"), expensesBefore, "no automatic expense");
    assert.ok((await exceptions()).some((x) => x.kind === "cashVariance"), "flagged for review");
    assert.match(msg(await reviewClosing(await as(head), closingId, { decision: "approve", note: "ok" })), /approver/);
    assert.match(msg(await reviewClosing(await as(approver), closingId, { decision: "approve", note: null })), /resolved/);
    assert.equal(msg(await reviewClosing(await as(approver), closingId, { decision: "approve", note: "Recovered from nobody; written off", resolution: "adjusted" })), "ok");
    assert.equal(await bal(CASH), 6500 * R, "the adjustment is posted separately and the box now agrees");
    assert.equal(await count("erp_expenses"), expensesBefore);
  });

  test("11 · nobody approves their own expense — the backend refuses", async () => {
    const mine = await createExpense(await as(approver), { date: day, particular: "Diesel for generator", category: "Petrol/Diesel", txnType: "Petrol/diesel", godownId: "erpg_ambernath", vendorName: "HP Pump", amountPaise: 2000 * R, submit: true });
    const mineId = (mine as { data: { id: string } }).data.id;
    assert.match(msg(await decideExpense(await as(approver), [mineId], "approve", null)), /Nobody approves/);
    assert.equal((await loadExpense(mineId))!.e.approvalStatus, "submitted", "it stays waiting for somebody else");
    assert.match(msg(await decideExpense(await as(head), [mineId], "approve", null)), /approver/);
    assert.equal(msg(await decideExpense(await as(owner), [mineId], "approve", null)), "ok");
  });

  test("13 · Tally unavailable: the record stays, the attempt fails safely and a retry never duplicates", async () => {
    const [q] = await db.select().from(erpTallySync).where(eq(erpTallySync.recordId, firstPaymentId));
    assert.equal(q.status, "pending");
    assert.match(msg(await postToTally(await as(accountant), q.id)), /live posting is switched off/);
    const set = await updateSettings([{ key: "erp.tally.mode", value: "live" }], owner.id);
    assert.ok(set.ok);
    assert.match(msg(await postToTally(await as(accountant), q.id)), /no Tally server address/);
    await updateSettings([{ key: "erp.tally.url", value: "http://tally.invalid:9000" }], owner.id);
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    assert.match(msg(await postToTally(await as(accountant), q.id, down)), /ECONNREFUSED/);
    const [failed] = await db.select().from(erpTallySync).where(eq(erpTallySync.id, q.id));
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 3);
    assert.ok(await db.select().from(erpExpensePayments).where(eq(erpExpensePayments.id, firstPaymentId)).then((x) => x[0].status === "confirmed"), "the MahekOne record is untouched");
    let sent = 0;
    const up = (async (_u: string, init: RequestInit) => {
      sent++;
      assert.match(String(init.body), /REMOTEID="MAHEKONE-PAY-1"/);
      return new Response("<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><LASTVCHID>881</LASTVCHID></RESPONSE>");
    }) as unknown as typeof fetch;
    assert.equal(msg(await postToTally(await as(accountant), q.id, up)), "ok");
    const again = await postToTally(await as(accountant), q.id, up);
    assert.match(again.ok ? (again.message ?? "") : again.error, /Already posted/);
    assert.equal(sent, 1, "a posted voucher is never sent again");
    const [posted] = await db.select().from(erpTallySync).where(eq(erpTallySync.id, q.id));
    assert.equal(posted.status, "posted");
    assert.equal(posted.voucherNo, "881");
    await updateSettings([{ key: "erp.tally.mode", value: "export" }, { key: "erp.tally.url", value: "" }], owner.id);
  });

  test("14 · a posted expense is never edited; a backdated reversal reopens the approved closing", async () => {
    assert.match(msg(await editExpense(await as(head), expenseId, { date: day, particular: "x", category: "Testing Material", txnType: "Testing material", godownId: "erpg_ambernath", vendorName: "x", amountPaise: 1 * R, submit: false, version: null })), /Only a draft/);
    assert.match(msg(await reversePayment(await as(head), firstPaymentId, "Wrong vendor", true)), /approver/);
    assert.equal(msg(await reversePayment(await as(approver), firstPaymentId, "Paid to the wrong person", true)), "ok");
    assert.equal(await bal(CASH), 9500 * R, "the ₹3,000 is back in the box");
    const [c] = (await db.execute(sql`select status, reopened_reason from erp_cash_closings where fund_account_id = ${CASH}`)) as unknown as { status: string; reopened_reason: string }[];
    assert.equal(c.status, "reopened", "the approved closing is flagged, never silently changed");
    assert.match(c.reopened_reason, /posted after the day was closed/);
    const f = (await loadExpense(expenseId))!;
    assert.equal(f.state.status, "PARTIALLY_PAID", "the status is worked out again from the payments that stand");
    const [pay] = await db.select().from(erpExpensePayments).where(eq(erpExpensePayments.id, firstPaymentId));
    assert.equal(pay.status, "reversed", "the payment is still on record");
    const [t] = await db.select().from(erpTallySync).where(eq(erpTallySync.recordId, firstPaymentId));
    assert.equal(t.status, "correction", "a voucher already in Tally is flagged for correcting there");
    const hist = (await db.execute(sql`select action from audit_log where entity_id = ${firstPaymentId}`)) as unknown as { action: string }[];
    assert.ok(hist.some((h) => h.action === "erp.petty.payment.reverse"));
  });
});

describe("controls around the acceptance tests", () => {
  test("the ledger cannot be edited or deleted, whatever the application does", async () => {
    const appendOnly = (e: unknown) => /append-only/.test(String((e as { cause?: { message?: string } }).cause?.message ?? e));
    await assert.rejects(db.execute(sql`update erp_fund_ledger set amount_paise = 1`), appendOnly);
    await assert.rejects(db.execute(sql`delete from erp_fund_ledger`), appendOnly);
  });

  test("a duplicate-looking expense is caught and can be confirmed separate", async () => {
    const base = { date: day, particular: "Pump repair", category: "Repairs and Maintenance", txnType: "Repairs and maintenance", godownId: "erpg_ambernath", vendorName: "Sai Engineering", amountPaise: 9000 * R, submit: false };
    assert.match(msg(await createExpense(await as(head), base)), /Possible duplicate/);
    assert.equal(msg(await createExpense(await as(head), { ...base, notDuplicate: true })), "ok");
  });

  test("an urgent payment before approval needs its reason and evidence, and is flagged", async () => {
    const r = await createExpense(await as(head), { date: day, particular: "Crane hire", category: "Loading/Unloading", txnType: "Loading/unloading", godownId: "erpg_ambernath", vendorName: "Crane Co", amountPaise: 900 * R, submit: true });
    const eid = (r as { data: { id: string } }).data.id;
    assert.equal((await loadExpense(eid))!.e.approvalStatus, "submitted");
    assert.match(msg(await recordPayment(await as(head), eid, { date: day, amountPaise: 900 * R, fundId: CASH, mode: "Cash", ackName: "Crane" })), /urgent payment/);
    const file = id("att");
    await db.execute(sql`insert into attachments (id, filename, content_type, size_bytes, stored_ref, status, uploaded_by_id) values (${file}, 'slip.jpg', 'image/jpeg', 10, ${file}, 'available', ${head.id})`);
    assert.equal(msg(await recordPayment(await as(head), eid, { date: day, amountPaise: 900 * R, fundId: CASH, mode: "Cash", ackName: "Crane", urgentReason: "Lorry waiting at the gate", evidenceFileId: file })), "ok");
    assert.ok((await exceptions()).some((x) => x.kind === "paidUnapproved" && x.open === eid));
  });

  test("a small expense with its bill is approved by policy on submission; a draft is edited, not paid", async () => {
    const file = id("att");
    await db.execute(sql`insert into attachments (id, filename, content_type, size_bytes, stored_ref, status, uploaded_by_id) values (${file}, 'bill.jpg', 'image/jpeg', 10, ${file}, 'available', ${head.id})`);
    const r = await createExpense(await as(head), { date: day, particular: "Tea", category: "Tea/Food/Water", txnType: "Tea, food and drinking water", godownId: "erpg_ambernath", vendorName: "Canteen", amountPaise: 120 * R, submit: false, fileId: file });
    const eid = (r as { data: { id: string } }).data.id;
    assert.match(msg(await recordPayment(await as(head), eid, { date: day, amountPaise: 120 * R, fundId: CASH, mode: "Cash", ackName: "Canteen" })), /Submit it first/);
    assert.equal(msg(await submitExpense(await as(head), eid)), "ok");
    const f = (await loadExpense(eid))!;
    assert.equal(f.e.approvalStatus, "approved");
    assert.equal(f.e.approvalLevel, "policy");
  });

  test("every Petty cash tab loads, for the production head and for the owner", async () => {
    for (const u of [head, owner]) {
      const ctx = await as(u);
      for (const k of ["pettyOverview", "expenses", "pettyPayments", "credits", "pettyReceipts", "pettyVendors", "pettyClosing", "pettyBank", "pettyLedger", "pettyBudgets", "pettyReports", "pettyTally", "pettySettings"]) {
        const m = screenModule(k);
        assert.ok(m, `${k} has a module`);
        const { spec } = await m!.load(ctx);
        assert.equal(spec.screen, k);
      }
    }
  });

  test("a new expense through the screen's own form, and its payment form", async () => {
    const ctx = await as(head);
    const mod = screenModule("expenses")!;
    const r = await mod.forms!.new(ctx, { date: day, particular: "Loading", category: "Loading/Unloading", txnType: "Loading/unloading", godown: "Ambernath", vendor: "Gang", amount: "400", received: "Received", docStatus: "To follow", situation: "Paid in full now", payfund: "Production Bank Cash", paymode: "Cash", payAckName: "Gang leader", submitAs: "Submit for approval", requestKey: "screen-form-1" }, []);
    assert.equal(msg(r), "ok");
    const [e] = await db.select().from(erpExpenses).where(eq(erpExpenses.particular, "Loading"));
    assert.equal(e.approvalStatus, "approved", "₹400 is under the auto-approve limit and Loading/Unloading needs no bill");
    const f = (await loadExpense(e.id))!;
    assert.equal(f.state.status, "COMPLETED");
    void erpFundTransfers;
  });
});
