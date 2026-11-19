/**
 * ACCOUNTS CORRECTIONS against a real database: an issued credit note
 * cancelled (and the same thing reached from the statement's Reverse), and a
 * manual vendor payout's payee and amount edited while it is still to pay.
 *
 * Each act is driven the way its screen drives it — the cancel reads the
 * impact report, types its word and sends its fingerprint — and is refused
 * without a confirmation, refused to somebody without the capability, and
 * leaves an audit row when it writes.
 *
 * Needs a database whose name contains mahekone_test. It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, auditLog, bills, complaints, customers, erpSuppliers, paymentReceipts, users, vendorPayouts } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { addDays } from "@/lib/business-date";
import { impactReport } from "@/lib/impact/registry";
import { recomputeOutstanding, today } from "@/lib/recompute";
import { cancelCreditNoteAction } from "@/lib/actions/accounts";
import { editPayoutAction } from "@/lib/actions/vendor-payouts";
import { issueCreditNote } from "@/lib/services/credit-note-service";
import { reverseReceipt } from "@/lib/services/receipt-service";
import { createManualPayout, markPayoutPaid } from "@/lib/services/vendor-payout-service";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
/* Outside Next a successful action's revalidatePath throws this — the write itself has landed (area-handover.test.ts does the same). */
const saved = (r: { ok: boolean; error?: string }) => r.ok || /static generation store/.test(r.error ?? "");

type User = typeof users.$inferSelect;
let clerk: User;
let caller: User;
let customerId = "";
let day = "";

async function makeUser(name: string, app: "accounts" | "crm", level: "associate" | "manager") {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\s/g, ".")}@corrections.test`,
      phone: testPhone(),
      passwordHash: "x",
      role: level,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app, role: level });
  return u;
}

/** A bill and a complaint asking for a credit note against it, issued by the clerk. */
async function issued(amount: number, cn: number) {
  const [bill] = await db
    .insert(bills)
    .values({
      id: id("bil"),
      customerId,
      billNo: `MMI/26-27/${Math.floor(Math.random() * 899999) + 100000}`,
      billDate: addDays(day, -20),
      dueDate: addDays(day, 10),
      amount,
    })
    .returning();
  await recomputeOutstanding(customerId);
  const [c] = await db
    .insert(complaints)
    .values({
      id: id("cmp"),
      customerId,
      billId: bill.id,
      category: "packaging_damage",
      description: "Two drums arrived with the seals broken.",
      loggedByUserId: caller.id,
      slaDueAt: new Date(Date.now() + 86_400_000),
      requestCn: true,
    })
    .returning();
  setTestUser(clerk);
  const r = await issueCreditNote({ complaintId: c.id, amount: cn, reference: "CN-17" });
  assert.ok(r.ok, r.ok ? "" : r.error);
  return { bill, complaintId: c.id, receiptId: r.data.receiptId };
}

async function paidOf(billId: string) {
  const [b] = await db.select({ paid: bills.paidAmount }).from(bills).where(eq(bills.id, billId));
  return Number(b.paid);
}

async function confirmationFor(kind: string, key: string) {
  const report = await impactReport(kind, key);
  assert.ok(report.ok, report.ok ? "" : report.error);
  return { report: report.data, confirmation: { typed: report.data.confirmWord, fingerprint: report.data.fingerprint } };
}

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against a mahekone_test database.");
  await db.execute(sql`
    truncate table audit_log, app_access, sessions, notifications, customers, users, app_settings,
      bills, payment_receipts, payments, complaints, vendor_payouts, vendor_payout_invoices, erp_suppliers
    restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  clerk = await makeUser("Ledger Clerk", "accounts", "manager");
  caller = await makeUser("Phone Caller", "crm", "associate");
  day = await today();
  customerId = id("cus");
  await db.insert(customers).values({ id: customerId, name: "Colour Camp", kind: "customer", ownerId: caller.id, contactPerson: "A", phone: "9820011111", city: "Pune" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("cancelling an issued credit note", () => {
  test("refused without a confirmation, refused to a telecaller, and refused without a reason", async () => {
    const { complaintId, bill } = await issued(100_000, 20_000);
    setTestUser(clerk);
    const none = await cancelCreditNoteAction(complaintId, "Raised on the wrong bill");
    assert.equal(none.ok, false);
    assert.equal(!none.ok && none.code, "validation");

    const noReason = await cancelCreditNoteAction(complaintId, "  ");
    assert.equal(noReason.ok, false);

    const { confirmation } = await confirmationFor("accounts-creditnote-cancel", complaintId);
    setTestUser(caller);
    const refused = await cancelCreditNoteAction(complaintId, "Raised on the wrong bill", confirmation);
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.code, "not_permitted");
    const report = await impactReport("accounts-creditnote-cancel", complaintId);
    assert.equal(report.ok, false, "the modal is not a way to read it either");

    assert.equal(await paidOf(bill.id), 20_000, "nothing moved");
  });

  test("the receipt is reversed, never deleted; the bill is owed again; the complaint says Cancelled; one audit row", async () => {
    const { complaintId, bill, receiptId } = await issued(100_000, 30_000);
    assert.equal(await paidOf(bill.id), 30_000);
    setTestUser(clerk);
    const { report, confirmation } = await confirmationFor("accounts-creditnote-cancel", complaintId);
    assert.equal(report.verb, "Cancel");
    assert.deepEqual(report.blockers, []);
    assert.ok(report.items.some((i) => i.app === "CRM" && /complaint/.test(i.label)));

    const r = await cancelCreditNoteAction(complaintId, "Raised on the wrong bill", confirmation);
    assert.ok(saved(r), JSON.stringify(r));

    const [receipt] = await db.select().from(paymentReceipts).where(eq(paymentReceipts.id, receiptId));
    assert.equal(receipt.status, "reversed");
    assert.match(receipt.rejectReason ?? "", /wrong bill/);
    assert.equal(await paidOf(bill.id), 0, "rebuilt from the confirmed money left");
    const [c] = await db.select().from(complaints).where(eq(complaints.id, complaintId));
    assert.equal(c.cnStatus, "cancelled");
    assert.match(c.resolutionNotes ?? "", /Credit note cancelled: Raised on the wrong bill/);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "creditnote.cancel"), eq(auditLog.entityId, complaintId)));
    assert.equal(audits.length, 1);

    const again = await impactReport("accounts-creditnote-cancel", complaintId);
    assert.ok(again.ok);
    assert.deepEqual(again.ok && again.data.blockers, ["That credit note has already been cancelled."]);
  });

  test("reversing the credit note's receipt on the statement cancels the credit note too", async () => {
    const { complaintId, receiptId } = await issued(50_000, 5_000);
    setTestUser(clerk);
    const r = await reverseReceipt(receiptId, "Entered twice");
    assert.ok(r.ok);
    const [c] = await db.select().from(complaints).where(eq(complaints.id, complaintId));
    assert.equal(c.cnStatus, "cancelled");
  });
});

describe("editing a manual payout", () => {
  test("payee and amount change while it is to pay, with the before and after in the audit row", async () => {
    setTestUser(clerk);
    const supplier = id("sup");
    await db.insert(erpSuppliers).values({ id: supplier, name: "Shree Solvents", partyCode: "SS", creditDays: 15 });
    const made = await createManualPayout({ payeeName: "Ganesh Transport", description: "Freight", amountPaise: 120_000, dueDate: addDays(day, 5) });
    assert.ok(made.ok);
    const payoutId = made.ok ? made.data.id : "";

    setTestUser(caller);
    const refused = await editPayoutAction(payoutId, { supplierId: supplier, description: "Freight", amountPaise: 150_050 });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.code, "not_permitted");

    setTestUser(clerk);
    const bad = await editPayoutAction(payoutId, { payeeName: "", description: "Freight", amountPaise: 0 });
    assert.equal(bad.ok, false);

    const r = await editPayoutAction(payoutId, { supplierId: supplier, description: "Freight to Pune", reference: "INV-9", amountPaise: 150_050 });
    assert.ok(saved(r), JSON.stringify(r));
    const [p] = await db.select().from(vendorPayouts).where(eq(vendorPayouts.id, payoutId));
    assert.equal(p.payeeName, "Shree Solvents");
    assert.equal(p.supplierId, supplier);
    assert.equal(Number(p.amountPaise), 150_050, "paise kept exactly");
    assert.equal(p.reference, "INV-9");
    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "payout.edit"), eq(auditLog.entityId, payoutId)));
    assert.ok(a, "audited");
    assert.equal((a.beforeState as { payeeName: string }).payeeName, "Ganesh Transport");
    assert.equal((a.afterState as { amountPaise: number }).amountPaise, 150_050);
  });

  test("refused once paid, and says why", async () => {
    setTestUser(clerk);
    const made = await createManualPayout({ payeeName: "AMC Services", description: "AMC", amountPaise: 90_000, dueDate: addDays(day, 3) });
    assert.ok(made.ok);
    const payoutId = made.ok ? made.data.id : "";
    const paid = await markPayoutPaid(payoutId, { paidOn: day, amountPaise: 90_000, mode: "Bank transfer" });
    assert.ok(paid.ok, paid.ok ? "" : paid.error);
    const r = await editPayoutAction(payoutId, { payeeName: "AMC Services", description: "AMC", amountPaise: 10_000 });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /has been paid/);
  });

  test("a purchase payout is the register's, and is refused", async () => {
    setTestUser(clerk);
    const pid = id("vpo");
    await db.insert(vendorPayouts).values({
      id: pid,
      source: "purchase",
      purchaseKey: `test:${pid}`,
      payeeName: "Register Vendor",
      description: "PR 12",
      amountPaise: 50_000,
      dueDate: addDays(day, 3),
      payOn: addDays(day, 3),
    });
    const r = await editPayoutAction(pid, { payeeName: "Somebody else", description: "PR 12", amountPaise: 1 });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /purchase register/);
  });
});
