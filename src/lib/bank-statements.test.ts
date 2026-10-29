/**
 * Accounts → Bank statement management, against a real database through the
 * real services: an upload read into lines, imported, a second overlapping
 * upload adding only what is new, each line matched to what explains it, and
 * the PDF deleted after its days while the lines stay.
 *
 *   npm run test:integration
 *
 * The AI reading is the one part not exercised — there is no model here. The
 * test writes what a reading produces (`rows`) onto the upload, exactly as
 * `readUpload` does after the model answers, and drives everything after it.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, bankStatementUploads, bills, customers, erpBankLines, paymentReceipts, users, vendorPayouts } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig } from "@/lib/config/store";
import { checkBalances, checkRows, type ReadRow } from "@/lib/engines/bank-statements";
import * as S from "@/lib/services/bank-statement-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const msg = (r: { ok: boolean; error?: string; fieldErrors?: { message: string }[] }) => (r.ok ? "ok" : (r.fieldErrors?.[0]?.message ?? r.error ?? "?"));
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 5.5 * 3_600_000 - n * 86_400_000).toISOString().slice(0, 10);
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

let manager: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;

async function makeUser(name: string, level: "associate" | "manager") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}@bank.test`, phone: String(9830000000 + Math.floor(Math.random() * 999999)), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "accounts", role: level });
  return u;
}

let bal = 0;
const row = (n: number, date: string, narration: string, ref: string | null, dr: number, cr: number, conf = 97): ReadRow => {
  bal += (cr - dr) * 100;
  return { lineNo: n, page: 1, date, narration, reference: ref, debitPaise: dr * 100, creditPaise: cr * 100, balancePaise: bal, confidence: conf };
};

/** Uploads a PDF and writes onto it what the AI reading would have, then hands back the upload. */
async function uploaded(rows: ReadRow[], opening: number) {
  const r = await S.startUpload({ accountId: "macc_kotak", fileName: `kotak-${rows.length}.pdf`, bytes: PDF, note: null });
  assert.equal(msg(r), "ok");
  if (!r.ok) throw new Error();
  const check = checkBalances(rows, opening, null);
  const held = (await db.execute(sql`select line_date::text as date, debit_paise::float8 as "debitPaise", credit_paise::float8 as "creditPaise", balance_paise::float8 as "balancePaise", reference, description, created_at::text as "createdAt" from erp_bank_lines where account_id = 'macc_kotak'`)) as unknown as {
    date: string;
    debitPaise: number;
    creditPaise: number;
    balancePaise: number | null;
    reference: string | null;
    description: string;
    createdAt: string;
  }[];
  const checked = checkRows(rows, held.map((h) => ({ ...h, debitPaise: Number(h.debitPaise), creditPaise: Number(h.creditPaise), balancePaise: h.balancePaise == null ? null : Number(h.balancePaise) })), check.breaks, 80);
  await db
    .update(bankStatementUploads)
    .set({ status: "ready", step: "ready", rows: checked as never, openingPaise: opening, closingPaise: check.closingPaise, balanceOk: check.ok, breakAt: check.breaks[0] ?? null, linesRead: rows.length, linesNew: checked.filter((c) => !c.existing).length, linesExisting: checked.filter((c) => c.existing).length })
    .where(eq(bankStatementUploads.id, r.data.id));
  return r.data.id;
}

const lineOf = async (narration: string) => {
  const [l] = await db.select().from(erpBankLines).where(sql`${erpBankLines.description} like ${narration + "%"}`);
  assert.ok(l, `no line ${narration}`);
  return l;
};

before(async () => {
  await db.execute(sql`truncate users, erp_bank_matches, erp_bank_lines, bank_statement_uploads, payments, payment_receipts, bills, vendor_payouts, erp_money_txns, audit_log restart identity cascade`);
  await db.execute(sql`delete from customers where id like 'cus_bank_%'`);
  /* The four accounts the migration seeds. Another suite (crm-accounts-impact) truncates
     erp_money_accounts, and which suites share a database depends on how the list is
     sharded — so this suite puts them back rather than trusting what ran before it. */
  await db.execute(sql`insert into erp_money_accounts (id, name, kind, sort) values ('macc_kotak', 'Kotak Bank', 'bank', 1), ('macc_icici', 'ICICI Bank', 'bank', 2), ('macc_cash', 'Cash in Hand', 'cash', 3), ('macc_petty', 'Petty Cash', 'petty', 4) on conflict do nothing`);
  await db.execute(sql`update erp_money_accounts set last4 = '4471', bank_name = 'Kotak Mahindra', active = true where id = 'macc_kotak'`);
  await db.execute(sql`update erp_money_accounts set last4 = '0932', bank_name = 'ICICI Bank', active = true where id = 'macc_icici'`);
  invalidateConfig();
  manager = await makeUser("Deepa Ledger", "manager");
  clerk = await makeUser("Anil Clerk", "associate");
  await db.insert(customers).values([
    { id: "cus_bank_cc", name: "COLOUR CAMP", city: "Pune", phone: "9876500101", kind: "customer" },
    { id: "cus_bank_nv", name: "NAVKAR TRADERS", city: "Pune", phone: "9876500102", kind: "customer" },
    { id: "cus_bank_rj", name: "RAJ ENTERPRISES", city: "Thane", phone: "9876500103", kind: "customer" },
  ]);
  await db.insert(bills).values([
    { id: "bil_bank_1", customerId: "cus_bank_cc", billNo: "MMI/26-27/1102", billDate: daysAgo(20), dueDate: daysAgo(-10), amount: 5_600_000 },
    { id: "bil_bank_2", customerId: "cus_bank_nv", billNo: "MMI/26-27/0988", billDate: daysAgo(40), dueDate: daysAgo(10), amount: 4_820_000 },
    { id: "bil_bank_3", customerId: "cus_bank_nv", billNo: "MMI/26-27/1044", billDate: daysAgo(25), dueDate: daysAgo(-5), amount: 4_290_000 },
  ]);
  await db.insert(paymentReceipts).values([
    { id: "rcp_bank_1", customerId: "cus_bank_cc", amount: 5_600_000, receivedAt: daysAgo(1), mode: "UPI", reference: "429411027734", status: "reported", idempotencyKey: "rcp_bank_1" },
    { id: "rcp_bank_2", customerId: "cus_bank_rj", amount: 4_230_000, receivedAt: daysAgo(4), mode: "Cheque", reference: "004377", instrumentDate: daysAgo(4), status: "confirmed", idempotencyKey: "rcp_bank_2" },
  ]);
  await db.insert(vendorPayouts).values({ id: "vp_bank_1", source: "manual", payeeName: "Asian Solvents Pvt Ltd", reference: "1182, 1190", amountPaise: 24_878_000, dueDate: daysAgo(-3), payOn: today(), status: "open" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("an upload, read and imported", () => {
  let first: string;
  test("only somebody who records payments may upload, and only a PDF", async () => {
    setTestUser(manager);
    const notPdf = await S.startUpload({ accountId: "macc_kotak", fileName: "x.pdf", bytes: new TextEncoder().encode("hello"), note: null });
    assert.match(msg(notPdf), /not a PDF/);
    const cash = await S.startUpload({ accountId: "macc_cash", fileName: "x.pdf", bytes: PDF, note: null });
    assert.match(msg(cash), /bank account/);
  });

  test("the new lines are imported, and the PDF is kept until its days are up", async () => {
    setTestUser(manager);
    bal = 1_000_000_00;
    first = await uploaded(
      [
        row(1, today(), "UPI/COLOURCAMP PAINTS/9876501234@ybl/PAYMENT", "429411027734", 0, 56000),
        row(2, today(), "NEFT-HDFC0000412-ASIAN SOLVENTS PVT LTD-INV 1182", "N294260011982", 248780, 0),
        row(3, today(), "CHQ DEP 004512 - CLG - NAVKAR TRADERS", "004512", 0, 75000),
        row(4, today(), "RTN CHQ 004377 - INSUFFICIENT FUNDS - RAJ ENTERPRISES", "004377", 42300, 0),
      ],
      1_000_000_00,
    );
    const r = await S.importUpload(first);
    assert.equal(msg(r), "ok");
    assert.equal(r.ok && r.data.added, 4);
    const d = await S.uploadDetail(first);
    assert.equal(d?.status, "imported");
    assert.equal(d?.pdfKept, true);
    assert.ok(await S.uploadPdf(first), "the PDF opens while it is kept");
  });

  test("a second, overlapping download adds only what is new", async () => {
    setTestUser(manager);
    const before = bal;
    bal = before - 75000 * 100 + 42300 * 100; // rewind to the balance after line 2
    const rows = [
      row(1, today(), "CHQ DEP 004512 - CLG - NAVKAR TRADERS (wrapped)", "004512", 0, 75000),
      row(2, today(), "RTN CHQ 004377 - INSUFFICIENT FUNDS - RAJ ENTERPRISES", "004377", 42300, 0),
      row(3, today(), "CHARGES-NEFT-OUTWARD-GST", null, 17.7, 0),
    ];
    const second = await uploaded(rows, before - 75000 * 100 + 42300 * 100);
    const d = await S.uploadDetail(second);
    assert.equal(d?.rows.filter((x) => x.existing).length, 2, "two are already in");
    const r = await S.importUpload(second);
    assert.equal(r.ok && r.data.added, 1);
    assert.equal(r.ok && r.data.skipped, 2);
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from erp_bank_lines where account_id = 'macc_kotak'`)) as unknown as { n: number }[];
    assert.equal(n, 5);
  });
});

describe("what each line is", () => {
  test("the credit with the reported receipt's UTR is suggested, and confirming it confirms the receipt", async () => {
    setTestUser(manager);
    const l = await lineOf("UPI/COLOURCAMP");
    const s = l.suggestion as { kind: string; id: string } | null;
    assert.equal(s?.kind, "receipt");
    assert.equal(s?.id, "rcp_bank_1");
    const r = await S.acceptCandidate(l.id, { kind: "receipt", id: "rcp_bank_1" }, "suggestion");
    assert.equal(msg(r), "ok");
    const [rc] = await db.select().from(paymentReceipts).where(eq(paymentReceipts.id, "rcp_bank_1"));
    assert.equal(rc.status, "confirmed");
    const again = await S.acceptCandidate(l.id, { kind: "receipt", id: "rcp_bank_1" });
    assert.match(msg(again), /already matched/);
  });

  test("somebody who only records payments cannot confirm a match", async () => {
    setTestUser(clerk);
    const l = await lineOf("NEFT-HDFC0000412");
    const r = await S.acceptCandidate(l.id, { kind: "payout", id: "vp_bank_1" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "not_permitted");
  });

  test("the debit equal to a planned payout marks the payout paid with the bank's reference", async () => {
    setTestUser(manager);
    const l = await lineOf("NEFT-HDFC0000412");
    assert.equal((l.suggestion as { kind: string } | null)?.kind, "payout");
    assert.equal(msg(await S.acceptCandidate(l.id, { kind: "payout", id: "vp_bank_1" }, "suggestion")), "ok");
    const [p] = await db.select().from(vendorPayouts).where(eq(vendorPayouts.id, "vp_bank_1"));
    assert.equal(p.status, "paid");
    assert.equal(p.paymentReference, "N294260011982");
  });

  test("a cheque deposit nothing explains is marked by hand as a customer payment, oldest bill first", async () => {
    setTestUser(manager);
    const l = await lineOf("CHQ DEP 004512");
    const r = await S.markLine(l.id, { as: "customer_payment", customerId: "cus_bank_nv", mode: "Cheque", reference: "004512" });
    assert.equal(msg(r), "ok");
    const [b1] = await db.select().from(bills).where(eq(bills.id, "bil_bank_2"));
    const [b2] = await db.select().from(bills).where(eq(bills.id, "bil_bank_3"));
    assert.equal(b1.paidAmount, 4_820_000, "the oldest bill is settled");
    assert.equal(b2.paidAmount, 2_680_000, "the rest goes on the next");
  });

  test("a returned cheque is flagged with the receipt it paid, and reversing it sets the line aside", async () => {
    setTestUser(manager);
    const l = await lineOf("RTN CHQ 004377");
    assert.equal(l.flag, "returned");
    assert.equal(l.flagReceiptId, "rcp_bank_2");
    assert.equal(msg(await S.reverseForReturn(l.id, "rcp_bank_2")), "ok");
    const [rc] = await db.select().from(paymentReceipts).where(eq(paymentReceipts.id, "rcp_bank_2"));
    assert.equal(rc.status, "reversed");
    const [after] = await db.select().from(erpBankLines).where(eq(erpBankLines.id, l.id));
    assert.equal(after.status, "ignored");
  });

  test("bank charges are entered on Petty Cash and matched; undoing leaves the entry", async () => {
    setTestUser(manager);
    const l = await lineOf("CHARGES-NEFT");
    assert.equal((l.suggestion as { kind: string } | null)?.kind, "charges");
    assert.equal(msg(await S.acceptCandidate(l.id, { kind: "charges", id: null }, "suggestion")), "ok");
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from erp_money_txns where category = 'Bank charges' and status = 'active'`)) as unknown as { n: number }[];
    assert.equal(n, 1);
    assert.equal(msg(await S.undoMatch(l.id)), "ok");
    const v = await S.reconcileView({ account: "macc_kotak", tab: "all", q: "CHARGES", dir: "both", period: "all", upload: null });
    assert.notEqual(v.rows[0].state, "matched");
  });

  test("a line set aside needs a reason, and can be brought back", async () => {
    setTestUser(clerk);
    const l = await lineOf("CHARGES-NEFT");
    assert.match(msg(await S.ignoreLine(l.id, "")), /why/);
    assert.equal(msg(await S.ignoreLine(l.id, "Already on Petty Cash")), "ok");
    assert.equal(msg(await S.restoreLine(l.id)), "ok");
  });
});

describe("the PDF's days", () => {
  test("the sweep deletes a PDF past its days, keeps the upload and its lines, and the PDF answers no more", async () => {
    setTestUser(manager);
    const [u] = await db.select().from(bankStatementUploads).limit(1);
    await db.update(bankStatementUploads).set({ pdfExpiresAt: new Date(Date.now() - 1000) }).where(eq(bankStatementUploads.id, u.id));
    const r = await S.sweepStatementPdfs();
    assert.ok(r.deleted >= 1);
    assert.equal(await S.uploadPdf(u.id), null);
    const d = await S.uploadDetail(u.id);
    assert.equal(d?.pdfKept, false);
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from erp_bank_lines where upload_id = ${u.id}`)) as unknown as { n: number }[];
    assert.ok(n > 0, "the lines stay");
  });
});
