/**
 * Vendor payouts against a real database: the ERP purchase register becoming
 * payouts, the payment days, a person's chosen day surviving the sync, manual
 * payouts with their invoices and files, and who may do what.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  attachments,
  bills,
  customers,
  erpGodowns,
  erpPurchases,
  erpRawMaterials,
  erpSuppliers,
  paymentReceipts,
  payments,
  users,
  vendorPayouts,
} from "@/db/schema";
import { cashInForecast } from "@/lib/services/cash-flow-service";
import { setTestUser } from "@/lib/auth";
import { addDays, paymentDayOnOrAfter, paymentWeekdays, weekdayOf } from "@/lib/engines/vendor-payouts";
import { today } from "@/lib/recompute";
import { canRead } from "@/lib/services/attachment-service";
import {
  addPayoutInvoice,
  cancelPayout,
  createManualPayout,
  holdPayout,
  listPayouts,
  markPayoutPaid,
  reschedulePayout,
  syncPurchasePayouts,
} from "@/lib/services/vendor-payout-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAYS = paymentWeekdays(["Tuesday", "Wednesday", "Thursday", "Friday"]);
const msg = (r: { ok: boolean; fieldErrors?: { message: string }[]; error?: string }) =>
  r.ok ? "ok" : (r.fieldErrors?.[0]?.message ?? r.error ?? "?");

type User = typeof users.$inferSelect;
let clerk: User;
let manager: User;
let caller: User;
let day = "";
let supplierId = "";
let materialId = "";
let godownId = "";

async function makeUser(name: string, app: "accounts" | "crm", level: "associate" | "manager") {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\s/g, ".")}@payouts.test`,
      phone: String(9830000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: level,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app, role: level });
  return u;
}

async function lot(o: { pr: number; date: string; rate: number | null; bill?: string; lotNo: string }) {
  const [row] = await db
    .insert(erpPurchases)
    .values({
      id: id("pur"),
      prNumber: o.pr,
      purchaseDate: o.date,
      supplierId,
      rawMaterialId: materialId,
      lotNo: o.lotNo,
      quantity: 100,
      unit: "Litre",
      ratePaise: o.rate,
      gstBp: 1800,
      godownId,
      billNumber: o.bill ?? null,
      source: "manual",
    })
    .returning();
  return row;
}

/** The next payment day strictly after `iso`, `n` times over. */
function laterPaymentDay(iso: string, n = 1): string {
  let d = iso;
  for (let i = 0; i < n; i++) d = paymentDayOnOrAfter(addDays(d, 1), DAYS);
  return d;
}

before(async () => {
  await db.execute(sql`
    truncate users, customers, bills, payment_receipts, payments, vendor_payouts, vendor_payout_invoices, erp_purchases, erp_suppliers, erp_raw_materials,
             audit_log restart identity cascade`);
  clerk = await makeUser("Payout Clerk", "accounts", "associate");
  manager = await makeUser("Payout Manager", "accounts", "manager");
  caller = await makeUser("Payout Caller", "crm", "associate");
  day = await today();

  supplierId = id("sup");
  await db.insert(erpSuppliers).values({ id: supplierId, name: "Shree Solvents", partyCode: "SS", creditDays: 15 });
  materialId = id("rm");
  await db.insert(erpRawMaterials).values({ id: materialId, serialNo: 9000 + Math.floor(Math.random() * 900), name: `Toluene ${randomUUID().slice(0, 6)}`, unit: "Litre", materialType: "Chemical" });
  godownId = id("gdn");
  await db.insert(erpGodowns).values({ id: godownId, name: `Payout Godown ${randomUUID().slice(0, 6)}` });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("purchases become payouts", () => {
  test("one payout per supplier per PR, at the register's figure, due after the credit days", async () => {
    setTestUser(clerk);
    await lot({ pr: 501, date: day, rate: 10_000, bill: "SS/1", lotNo: "SS-T-501a" });
    await lot({ pr: 501, date: day, rate: 10_000, bill: "SS/1", lotNo: "SS-T-501b" });
    await lot({ pr: 502, date: day, rate: null, lotNo: "SS-T-502" }); // no rate — no payout

    const first = await syncPurchasePayouts();
    assert.equal(first.created, 1);
    const again = await syncPurchasePayouts();
    assert.deepEqual(again, { created: 0, updated: 0, removed: 0 }, "an unchanged register writes nothing");

    const [p] = (await listPayouts()).filter((x) => x.source === "purchase");
    assert.equal(p.prNumber, 501);
    assert.equal(p.lots, 2);
    assert.equal(p.amountPaise, 2 * 1_180_000);
    assert.equal(p.reference, "SS/1");
    assert.equal(p.dueDate, addDays(day, 15));
    assert.ok(DAYS.has(weekdayOf(p.payOn)), "planned for a payment day");
    assert.equal(p.payOn, paymentDayOnOrAfter(addDays(day, 15), DAYS));
  });

  test("a day a person chose survives the register changing; a vanished purchase is cancelled and comes back", async () => {
    setTestUser(clerk);
    const [p] = (await listPayouts()).filter((x) => x.source === "purchase");

    const saturday = addDays(day, ((6 - weekdayOf(day) + 7) % 7) || 7);
    assert.match(msg(await reschedulePayout(p.id, saturday)), /not on a Saturday/);
    assert.match(msg(await reschedulePayout(p.id, addDays(day, -1))), /day that has gone/);

    const chosen = laterPaymentDay(day, 3);
    assert.equal(msg(await reschedulePayout(p.id, chosen)), "ok");

    // The register's rate moves: the amount follows, the chosen day does not.
    await db.update(erpPurchases).set({ ratePaise: 20_000 }).where(eq(erpPurchases.lotNo, "SS-T-501a"));
    const res = await syncPurchasePayouts();
    assert.equal(res.updated, 1);
    const [moved] = (await listPayouts()).filter((x) => x.id === p.id);
    assert.equal(moved.amountPaise, 2_360_000 + 1_180_000);
    assert.equal(moved.payOn, chosen);
    assert.equal(moved.payOnDecided, true);

    // Rate taken off every lot: no longer owed.
    await db.update(erpPurchases).set({ ratePaise: null }).where(eq(erpPurchases.prNumber, 501));
    assert.equal((await syncPurchasePayouts()).removed, 1);
    const [gone] = await db.select().from(vendorPayouts).where(eq(vendorPayouts.id, p.id));
    assert.equal(gone.status, "cancelled");

    // Rated again: the same payout comes back, its chosen day intact.
    await db.update(erpPurchases).set({ ratePaise: 10_000 }).where(eq(erpPurchases.prNumber, 501));
    await syncPurchasePayouts();
    const [back] = await db.select().from(vendorPayouts).where(eq(vendorPayouts.id, p.id));
    assert.equal(back.status, "open");
    assert.equal(back.payOn, chosen);
  });

  test("a paid purchase payout is a record — the register no longer rewrites it", async () => {
    const [p] = (await listPayouts()).filter((x) => x.source === "purchase");
    setTestUser(clerk);
    assert.match(
      msg(await markPayoutPaid(p.id, { paidOn: day, amountPaise: p.amountPaise, mode: "Bank transfer" })),
      /Accounts manager/,
      "an associate records; marking paid is the manager's",
    );
    setTestUser(manager);
    assert.match(msg(await markPayoutPaid(p.id, { paidOn: addDays(day, 1), amountPaise: p.amountPaise, mode: "UPI" })), /not come yet/);
    assert.equal(msg(await markPayoutPaid(p.id, { paidOn: day, amountPaise: p.amountPaise, mode: "UPI", reference: "UTR123" })), "ok");

    await db.update(erpPurchases).set({ ratePaise: 50_000 }).where(eq(erpPurchases.prNumber, 501));
    await syncPurchasePayouts();
    const [paid] = await db.select().from(vendorPayouts).where(eq(vendorPayouts.id, p.id));
    assert.equal(paid.status, "paid");
    assert.equal(Number(paid.amountPaise), p.amountPaise);
    assert.equal(paid.paymentReference, "UTR123");
  });
});

describe("manual payouts", () => {
  test("added with several invoices and their files, which only the desk may open", async () => {
    setTestUser(clerk);
    const fileId = id("att");
    await db.insert(attachments).values({
      id: fileId,
      filename: "proforma.pdf",
      storedRef: "x",
      contentType: "application/pdf",
      sizeBytes: 10,
      status: "available",
      uploadedById: clerk.id,
    });

    assert.match(
      msg(await createManualPayout({ payeeName: "Ganesh Transport", description: "", amountPaise: 500_000, dueDate: day })),
      /what the payment is for/,
    );
    const res = await createManualPayout({
      payeeName: "Ganesh Transport",
      description: "Freight for PR 501",
      amountPaise: 500_000,
      dueDate: day,
      invoices: [
        { kind: "Proforma invoice", invoiceNo: "GT-PI-9", attachmentId: fileId },
        { kind: "Lorry receipt", invoiceNo: "LR-77" },
      ],
    });
    assert.equal(msg(res), "ok");
    const payoutId = res.ok ? res.data.id : "";

    const [p] = (await listPayouts()).filter((x) => x.id === payoutId);
    assert.equal(p.source, "manual");
    assert.ok(DAYS.has(weekdayOf(p.payOn)));
    assert.ok(p.payOn >= day);
    assert.deepEqual(
      p.invoices.map((i) => [i.kind, i.invoiceNo, i.attachmentId]),
      [
        ["Proforma invoice", "GT-PI-9", fileId],
        ["Lorry receipt", "LR-77", null],
      ],
    );

    const [file] = await db.select().from(attachments).where(eq(attachments.id, fileId));
    assert.equal(file.parentType, "vendor_payout_invoice");
    assert.equal(await canRead(fileId), true);
    setTestUser(caller);
    assert.equal(await canRead(fileId), false, "a CRM telecaller cannot open a vendor's invoice");

    // Another invoice later, with nothing to identify it, is refused.
    setTestUser(clerk);
    assert.match(msg(await addPayoutInvoice(payoutId, { kind: "Tax invoice" })), /invoice number/);
    assert.equal(msg(await addPayoutInvoice(payoutId, { kind: "Tax invoice", invoiceNo: "GT/26/14" })), "ok");

    // Held needs a reason; cancelling is the manager's.
    assert.match(msg(await holdPayout(payoutId, " ")), /why it is held/);
    assert.equal(msg(await holdPayout(payoutId, "Waiting for the LR copy")), "ok");
    assert.match(msg(await cancelPayout(payoutId, "Not owed")), /Accounts manager/);
    setTestUser(manager);
    assert.equal(msg(await cancelPayout(payoutId, "Paid by the transporter's agent")), "ok");
  });

  test("somebody without Vendor payouts cannot write one", async () => {
    setTestUser(caller);
    const res = await createManualPayout({ payeeName: "X", description: "Y", amountPaise: 100, dueDate: day });
    assert.match(msg(res), /not on your account/);
  });
});

describe("money in", () => {
  test("an open bill is expected at its date plus the customer's own paying habit, a claim on its own date", async () => {
    setTestUser(clerk);
    const [shop] = await db
      .insert(customers)
      .values({ id: id("cus"), name: "Habit Paints", contactPerson: "A", phone: "9811122233", city: "Pune", ownerId: clerk.id })
      .returning();
    // Three past bills, each paid 20 days after it was raised.
    for (let i = 0; i < 3; i++) {
      const billDate = addDays(day, -100 + i * 20);
      const [b] = await db
        .insert(bills)
        .values({ id: id("bil"), customerId: shop.id, billNo: `HB/${i}`, billDate, amount: 10_000_00, paidAmount: 10_000_00 })
        .returning();
      const [r] = await db
        .insert(paymentReceipts)
        .values({ id: id("rct"), idempotencyKey: id("idem"), customerId: shop.id, amount: 10_000_00, receivedAt: addDays(billDate, 20), status: "confirmed", mode: "Bank transfer" })
        .returning();
      await db.insert(payments).values({ id: id("pay"), receiptId: r.id, billId: b.id, customerId: shop.id, amount: 10_000_00, paidAt: addDays(billDate, 20) });
    }
    // An open bill raised five days ago: expected in fifteen days, not on any credit term.
    const [open] = await db
      .insert(bills)
      .values({ id: id("bil"), customerId: shop.id, billNo: "HB/OPEN", billDate: addDays(day, -5), dueDate: addDays(day, 25), amount: 50_000_00 })
      .returning();
    // ₹10,000 of it reported by cheque dated in three days.
    const [claim] = await db
      .insert(paymentReceipts)
      .values({ id: id("rct"), idempotencyKey: id("idem"), customerId: shop.id, amount: 10_000_00, receivedAt: day, instrumentDate: addDays(day, 3), status: "reported", mode: "Cheque" })
      .returning();
    await db.insert(payments).values({ id: id("pay"), receiptId: claim.id, billId: open.id, customerId: shop.id, amount: 10_000_00, paidAt: day });

    const f = await cashInForecast();
    const mine = f.items.filter((i) => i.customerId === shop.id);
    const bill = mine.find((i) => i.kind === "bill")!;
    assert.equal(bill.basis, "own");
    assert.equal(bill.habit?.avgDays, 20);
    assert.equal(bill.expectedOn, addDays(day, 15));
    assert.equal(bill.amountPaise, 40_000_00, "the reported ₹10,000 is not predicted twice");
    const reported = mine.find((i) => i.kind === "reported")!;
    assert.equal(reported.expectedOn, addDays(day, 3));
    assert.equal(reported.amountPaise, 10_000_00);
  });
});
