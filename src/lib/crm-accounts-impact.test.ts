/**
 * THE CRM, ACCOUNTS, LEADS AND SALES DASHBOARD IMPACT REPORTS, read against a
 * real database.
 *
 * Every report here is raw SQL over tables tsc cannot see into, so a column
 * named wrong is invisible until a modal opens on it. Each source is asked for
 * its report over a record built for it, and the acts that can be driven
 * without a request are driven the way the modal drives them: read the report,
 * type its word, send its fingerprint — and refused without it.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  bankStatementUploads,
  bills,
  customers,
  employeeReporting,
  employees,
  enquiries,
  enquiryOrders,
  erpBankLines,
  erpBankMatches,
  erpMoneyAccounts,
  focusCustomers,
  mbosCourseProgress,
  mbosCourses,
  mbosExpensePayouts,
  mbosSamples,
  orders,
  paymentReceipts,
  payments,
  reminders,
  users,
  vendorPayoutInvoices,
  vendorPayouts,
  waMessages,
  waRuns,
  waTemplates,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { impactReport } from "@/lib/impact/registry";
import type { ImpactSource } from "@/lib/impact/registry";
import { impactBatch, impactPair } from "@/lib/impact/kinds/crm-keys";
import {
  enquiryOrderImpact,
  focusCustomerImpact,
  reportingLineImpact,
} from "@/lib/impact/kinds/crm-customers";
import { waMessageImpact, waRunEndImpact, waTemplateArchiveImpact } from "@/lib/impact/kinds/crm-whatsapp";
import {
  bankReturnImpact,
  bankUnmatchImpact,
  bankUploadDiscardImpact,
  payoutCancelImpact,
  payoutInvoiceImpact,
  payoutReopenImpact,
} from "@/lib/impact/kinds/accounts";
import { leadArchiveImpact, sampleCancelImpact } from "@/lib/impact/kinds/leads-more";
import { courseWithdrawImpact, expensePayoutVoidImpact } from "@/lib/impact/kinds/sales-dashboard";
import { archiveTemplate, cancelMessage, cancelReminder, clearRun } from "@/lib/actions/crm";
import { bulkArchiveLeads } from "@/lib/actions/sales";
import { unlinkOrderAction } from "@/lib/actions/enquiries";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = new Date().toISOString().slice(0, 10);

let admin: typeof users.$inferSelect;
let shop: string;
let lead: string;

/** A report straight from its source, as the registry would read it. */
async function body(source: ImpactSource, key: string) {
  const r = await source.report(key);
  assert.ok(r, "the report found its record");
  return r;
}

const where = (items: { app: string; label: string; effect: string; count: number }[]) =>
  items.map((i) => `${i.app}:${i.effect}:${i.count}:${i.label}`).join(" | ");

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against mahekone_test.");
  await db.execute(sql`
    truncate table audit_log, app_access, sessions, notifications, customers, users, app_settings,
      wa_templates, enquiries, employees, erp_money_accounts, vendor_payouts, mbos_courses
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  [admin] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Admin", email: `admin-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role: "admin", initials: "AD" })
    .returning();
  await db.insert(appAccess).values(
    (["crm", "sales", "enquiries", "accounts", "hrms"] as const).map((app) => ({ id: id("aca"), userId: admin.id, app, role: "admin" as const })),
  );
  setTestUser(admin);
  shop = id("cus");
  lead = id("cus");
  await db.insert(customers).values([
    { id: shop, name: "Colour Camp", kind: "customer", ownerId: admin.id, contactPerson: "A", phone: "9820011111", city: "Pune", salesPersonName: "Ravi Kumar" },
    { id: lead, name: "Prospect Paints", kind: "lead", ownerId: admin.id, contactPerson: "B", phone: "9820022222", city: "Pune", leadStage: "new" },
  ]);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ------------------------------------------------------------------ CRM */

test("a focus entry: the note goes, the customer stays", async () => {
  const entry = id("foc");
  await db.insert(focusCustomers).values({ id: entry, customerId: shop, addedById: admin.id, note: "Close to the cutoff" });
  const r = await body(focusCustomerImpact, entry);
  assert.equal(r.confirmWord, "Colour Camp");
  assert.ok(r.items.some((i) => i.effect === "deleted" && /note/.test(i.label)), where(r.items));
});

test("a reminder dismissed leaves the Call Log, and is refused without a confirmation", async () => {
  const reminder = id("rem");
  await db.insert(reminders).values({
    id: reminder,
    customerId: shop,
    createdByUserId: admin.id,
    assignedUserId: admin.id,
    dueDate: TODAY,
    note: "Ring about the 20L order",
    holdOtherReasonsUntilDue: true,
  });
  const report = await impactReport("crm-reminder-dismiss", reminder);
  assert.ok(report.ok, report.ok ? "" : report.error);
  assert.ok(report.data.items.some((i) => /Call Log/.test(i.label)), where(report.data.items));
  assert.ok(report.data.items.some((i) => /held back/.test(i.label)), "the held order chasing is named");

  assert.equal((await cancelReminder(reminder, "Paid already")).ok, false, "no confirmation, no dismissal");
  const done = await cancelReminder(reminder, "Paid already", { typed: report.data.confirmWord, fingerprint: report.data.fingerprint });
  assert.ok(done.ok, done.ok ? "" : done.error);
  const [row] = await db.select().from(reminders).where(eq(reminders.id, reminder));
  assert.equal(row.status, "dismissed");
});

test("an order unlinked from an enquiry keeps the order", async () => {
  const enquiry = id("enq");
  const order = id("ord");
  await db.insert(enquiries).values({ id: enquiry, workspace: "enquiries", source: "website", rawSubmission: {}, receivedAt: new Date(), customerId: shop });
  await db.insert(orders).values({ id: order, customerId: shop, orderedAt: new Date(), totalAmount: 12_500_00, orderNo: "SO-77" });
  await db.insert(enquiryOrders).values({ id: id("eno"), enquiryId: enquiry, orderId: order });
  const key = impactPair(enquiry, order);
  const r = await body(enquiryOrderImpact, key);
  assert.equal(r.confirmWord, "SO-77");
  assert.ok(r.items.every((i) => i.effect === "kept"));

  assert.equal((await unlinkOrderAction(enquiry, order)).ok, false, "no confirmation, no unlink");
  const report = await impactReport("crm-enquiry-order", key);
  assert.ok(report.ok, report.ok ? "" : report.error);
  const done = await unlinkOrderAction(enquiry, order, { typed: "so-77", fingerprint: report.data.fingerprint });
  assert.ok(done.ok, done.ok ? "" : done.error);
  assert.equal((await db.select().from(orders).where(eq(orders.id, order))).length, 1, "the order itself stays");
});

test("a reporting line names the accounts whose sales manager it supplies", async () => {
  const base = { raw: {}, rowHash: "h" };
  const [ravi, meena] = await db
    .insert(employees)
    .values([
      { id: id("emp"), rowNumber: 2, employeeCode: "E2", name: "Ravi Kumar", ...base },
      { id: id("emp"), rowNumber: 3, employeeCode: "E3", name: "Meena Shah", ...base },
    ])
    .returning();
  await db.insert(employeeReporting).values({ id: id("rep"), employeeId: ravi.id, managerId: meena.id });
  const r = await body(reportingLineImpact, ravi.id);
  const accounts = r.items.find((i) => i.app === "CRM");
  assert.equal(accounts?.count, 1, where(r.items));
  assert.deepEqual(accounts?.examples, ["Colour Camp"]);
});

/* ------------------------------------------------------------- WhatsApp */

test("WhatsApp: a copied message, an archived template and an ended run", async () => {
  const template = id("tpl");
  await db.insert(waTemplates).values({ id: template, name: "Gentle reminder", category: "payment_reminder", body: "Hello" });
  const run = id("run");
  await db.insert(waRuns).values({ id: run, userId: admin.id, templateId: template, filterKey: "stage1", totalCount: 1 });
  const message = id("wam");
  await db.insert(waMessages).values({
    id: message,
    customerId: shop,
    userId: admin.id,
    templateId: template,
    templateName: "Gentle reminder",
    resolvedDestination: "919820011111",
    body: "Hello",
    status: "copied",
    runId: run,
  });

  const msg = await body(waMessageImpact, message);
  assert.ok(msg.items.some((i) => /never confirmed/.test(i.label)), where(msg.items));
  const tpl = await body(waTemplateArchiveImpact, template);
  assert.equal(tpl.confirmWord, "Gentle reminder");
  assert.ok(tpl.items.some((i) => /run/.test(i.label) && i.count === 1), where(tpl.items));
  const ending = await body(waRunEndImpact, run);
  assert.ok(ending.items.some((i) => /still waiting/.test(i.label) && i.count === 1), where(ending.items));

  /* Ending the run with somebody waiting asks first; so does the template. */
  assert.equal((await clearRun(run)).ok, false, "a run with a customer waiting is not ended unasked");
  assert.equal((await archiveTemplate(template, true)).ok, false, "no confirmation, no archive");
  const archive = await impactReport("crm-wa-template-archive", template);
  assert.ok(archive.ok, archive.ok ? "" : archive.error);
  const archived = await archiveTemplate(template, true, { typed: "gentle reminder", fingerprint: archive.data.fingerprint });
  assert.ok(archived.ok, archived.ok ? "" : archived.error);
  assert.ok((await archiveTemplate(template, false)).ok, "restoring asks nothing");

  assert.equal((await cancelMessage(message)).ok, false, "no confirmation, no discard");
  const discard = await impactReport("crm-wa-message", message);
  assert.ok(discard.ok, discard.ok ? "" : discard.error);
  const discarded = await cancelMessage(message, { typed: discard.data.confirmWord, fingerprint: discard.data.fingerprint });
  assert.ok(discarded.ok, discarded.ok ? "" : discarded.error);
  assert.ok((await clearRun(run)).ok, "nobody left waiting, so ending asks nothing");
});

/* ------------------------------------------------------------- Accounts */

test("a returned cheque names the bill owed again and the line set aside", async () => {
  const bill = id("bil");
  await db.insert(bills).values({ id: bill, customerId: shop, billNo: "MMI/26-27/1119", billDate: TODAY, amount: 8_000_00, paidAmount: 8_000_00 });
  const receipt = id("rct");
  await db.insert(paymentReceipts).values({
    id: receipt,
    customerId: shop,
    amount: 8_000_00,
    receivedAt: TODAY,
    mode: "Cheque",
    status: "confirmed",
    idempotencyKey: randomUUID(),
  });
  await db.insert(payments).values({ id: id("pay"), receiptId: receipt, billId: bill, customerId: shop, amount: 8_000_00, paidAt: TODAY });
  const [account] = await db.insert(erpMoneyAccounts).values({ id: id("acc"), name: "Kotak Bank", kind: "bank" }).returning();
  const line = id("bnl");
  await db.insert(erpBankLines).values({ id: line, accountId: account.id, lineDate: TODAY, description: "CHQ RETURN", debitPaise: 8_000_00, lineKey: id("k"), importBatch: "b1" });

  const r = await body(bankReturnImpact, impactPair(line, receipt));
  assert.deepEqual(r.blockers, []);
  const owed = r.items.find((i) => /settled/.test(i.label));
  assert.equal(owed?.count, 1, where(r.items));
  assert.match(owed?.examples?.[0] ?? "", /MMI\/26-27\/1119/);
  assert.ok(r.items.some((i) => /bank line/.test(i.label) && i.effect === "changed"));

  /* A match on another line: undoing it says the receipt stays confirmed. */
  const matched = id("bnl");
  await db.insert(erpBankLines).values({ id: matched, accountId: account.id, lineDate: TODAY, description: "NEFT COLOUR CAMP", creditPaise: 8_000_00, lineKey: id("k"), importBatch: "b1" });
  await db.insert(erpBankMatches).values({ id: id("bmt"), lineId: matched, receiptId: receipt, amountPaise: 8_000_00 });
  const undo = await body(bankUnmatchImpact, matched);
  assert.ok(undo.items.some((i) => i.effect === "unlinked" && i.count === 1), where(undo.items));
  assert.ok(undo.items.some((i) => i.effect === "kept" && /receipt/.test(i.label)));
  const reverse = await body(bankReturnImpact, impactPair(line, receipt));
  assert.ok(reverse.items.some((i) => /matched to it/.test(i.label) && i.effect === "kept"), "the matched line is named as staying");

  const upload = id("bsu");
  await db.insert(bankStatementUploads).values({
    id: upload,
    accountId: account.id,
    fileName: "kotak-sept.pdf",
    fileSize: 1000,
    fileRef: "ref",
    status: "ready",
    linesRead: 42,
    pdfExpiresAt: new Date(Date.now() + 86_400_000),
  });
  const discard = await body(bankUploadDiscardImpact, upload);
  assert.ok(discard.items.some((i) => i.effect === "deleted" && i.count === 42), where(discard.items));
});

test("vendor payouts: cancel, reopen and an invoice off", async () => {
  const open = id("vpo");
  const paid = id("vpo");
  await db.insert(vendorPayouts).values([
    { id: open, source: "manual", payeeName: "Shree Drums", amountPaise: 50_000_00, dueDate: TODAY, payOn: TODAY },
    { id: paid, source: "manual", payeeName: "Om Labels", amountPaise: 9_000_00, dueDate: TODAY, payOn: TODAY, status: "paid", paidOn: TODAY, paidAmountPaise: 9_000_00, paymentMode: "UPI" },
  ]);
  const invoice = id("vpi");
  await db.insert(vendorPayoutInvoices).values({ id: invoice, payoutId: open, kind: "Invoice", invoiceNo: "SD-19", amountPaise: 50_000_00 });

  const cancel = await body(payoutCancelImpact, open);
  assert.deepEqual(cancel.blockers, []);
  assert.ok(cancel.items.some((i) => /invoice/.test(i.label) && i.count === 1), where(cancel.items));
  const notPaid = await body(payoutReopenImpact, open);
  assert.deepEqual(notPaid.blockers, ["Only a paid payout can be reopened."]);
  const reopen = await body(payoutReopenImpact, paid);
  assert.ok(reopen.items.some((i) => i.effect === "deleted" && /payment recorded/.test(i.label)), where(reopen.items));
  const inv = await body(payoutInvoiceImpact, invoice);
  assert.equal(inv.confirmWord, "SD-19");
});

/* ---------------------------------------------------------- Leads, Sales */

test("leads: a sample called off and a selection archived", async () => {
  const sample = id("smp");
  await db.insert(mbosSamples).values({ id: sample, customerId: lead, salesmanId: admin.id, quantityCans: 1, state: "requested" });
  const r = await body(sampleCancelImpact, sample);
  assert.deepEqual(r.blockers, []);
  assert.equal(r.confirmWord, "Prospect Paints");

  const key = impactBatch([lead]);
  const archive = await body(leadArchiveImpact, key);
  assert.ok(archive.items.some((i) => /working list/.test(i.label) && i.count === 1), where(archive.items));
  assert.ok(archive.items.some((i) => /sample/.test(i.label) && i.effect === "kept"), "the sample in progress is named as staying");

  assert.equal((await bulkArchiveLeads({ leadIds: [lead], reason: "Duplicate" })).ok, false, "no confirmation, nothing archived");
  const report = await impactReport("lead-archive", key);
  assert.ok(report.ok, report.ok ? "" : report.error);
  const done = await bulkArchiveLeads({ leadIds: [lead], reason: "Duplicate" }, { typed: report.data.confirmWord, fingerprint: report.data.fingerprint });
  assert.ok(done.ok, done.ok ? "" : done.error);
  const [row] = await db.select().from(customers).where(eq(customers.id, lead));
  assert.equal(row.leadArchived, true);
});

test("Sales Dashboard: a course withdrawn keeps the progress, a voided payment names the balance", async () => {
  const course = id("crs");
  await db.insert(mbosCourses).values({ id: course, title: "Spray booth basics", mandatory: true });
  await db.insert(mbosCourseProgress).values({ id: id("cpr"), courseId: course, userId: admin.id, startedAt: new Date(), completedAt: new Date(), passed: true });
  const c = await body(courseWithdrawImpact, course);
  assert.ok(c.items.some((i) => /finished/.test(i.label) && i.count === 1), where(c.items));

  const payout = id("exp");
  await db.insert(mbosExpensePayouts).values({ id: payout, userId: admin.id, paidOn: TODAY, amountPaise: 3_200_00 });
  const v = await body(expensePayoutVoidImpact, payout);
  assert.equal(v.confirmWord, "VOID");
  assert.ok(v.items.some((i) => /balance/.test(i.label) && i.effect === "changed"), where(v.items));
});
