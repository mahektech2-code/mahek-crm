/**
 * ERP phase 5 — transport follow-up, customer requests and credit notes,
 * order follow-up, petty cash and my customers, against a real database
 * through the real handlers.
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
  bills,
  complaints,
  complaintStatusHistory,
  paymentReceipts,
  customers,
  erpCustomerProfiles,
  erpFgEntries,
  erpOrders,
  erpProductPacking,
  erpTransports,
  finishedGoods,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const tag = randomUUID().slice(0, 6);
const SKU = `ERPL Primer ${tag} - 1 Liter (Loose)`;

async function makeUser(name: string, level: "associate" | "admin") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}@erp.test`, phone: String(9820000000 + Math.floor(Math.random() * 999999)), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "erp", role: level });
  return u;
}
async function as(u: typeof users.$inferSelect) {
  setTestUser(u);
  return erpContext();
}
const mod = (k: string) => {
  const m = screenModule(k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};
const msg = (r: { ok: boolean; fieldErrors?: { message: string }[]; error?: string }) => (r.ok ? "ok" : (r.fieldErrors?.[0]?.message ?? r.error ?? "?"));

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;

/** Takes an order of `qty` cans on `date` all the way to dispatch-verified, through the real handlers. */
async function dispatch(date: string, qty: number, bill: string, dispatched: string) {
  const ctx = await as(admin);
  assert.ok((await mod("orders").forms!.new(ctx, { date, godown: "Bhiwandi", billing: "Shree Paints" }, [{ sku: SKU, qty: String(qty), rate: "300" }])).ok);
  const [o] = await db.select().from(erpOrders).where(sql`${erpOrders.orderDate} = ${date} and ${erpOrders.qtyCans} = ${qty}`);
  await mod("orders").actions!.ready(ctx, o.id, {});
  assert.ok((await mod("orders").forms!.allocate(ctx, { lot: "FG1BH", qty: String(qty) }, [], o.id)).ok);
  await mod("orders").forms!.edit(ctx, { status: "Ready", delivery: "Shree Paints", qty: String(qty), rate: "300", bill, transport: "0" }, [], o.id);
  assert.ok((await mod("orders").actions!.bill(ctx, o.id, {})).ok);
  assert.ok((await mod("orderDetails").actions!.verify(ctx, o.id, { date: dispatched })).ok);
  return o;
}

before(async () => {
  await db.execute(sql`
    truncate users, customers, erp_customer_profiles, erp_orders, erp_batch_codes, erp_order_details, erp_fg_entries,
             erp_pack_entries, erp_transports, erp_requests, erp_followups, erp_credits, erp_expenses, erp_videos,
             erp_user_powers, erp_godown_staff, erp_user_settings, audit_log restart identity cascade`);
  await db.execute(sql`update erp_series set last = 0`);
  admin = await makeUser("Kavita Admin", "admin");
  clerk = await makeUser("Ravi Sales", "associate");
  const fId = id("form");
  const bId = id("brand");
  const fgId = id("fg");
  const skuId = id("sku");
  await db.insert(productFormulations).values({ id: fId, name: `ERPL Primer ${tag}`, slug: `erpl-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `ERPL ${tag}`, slug: `erpl-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values({ id: fgId, name: `ERPL Primer 1 L ${tag}`, slug: `erpl-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 1000 });
  await db.insert(products).values({ id: skuId, name: SKU, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 1 });
  await db.insert(erpProductPacking).values({ productId: skuId, emptyBoxesRequired: 0 });
  await db.insert(customers).values({ id: "cus_shree", name: "Shree Paints", city: "Pune", phone: "9876500001", kind: "customer", area: "Pune", creditDays: 30, freightTerm: "Paid", salesAmId: clerk.id });
  await db.insert(erpCustomerProfiles).values({ customerId: "cus_shree", transporter: "VRL" });
  await db.insert(erpFgEntries).values({ id: id("fge"), sourceType: "fill", sourceId: "fin_x", entryDate: "2026-08-01", finishedGoodId: fgId, lotCode: "FG1BH", godownId: "erpg_bhiwandi", quantity: 100, packingType: "Can", skuId });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("dispatch opens the transport record (§18)", () => {
  test("one transport record per bill", async () => {
    const o = await dispatch("2026-08-01", 10, "MMI/26-27/1", "2026-08-02");
    const [t] = await db.select().from(erpTransports);
    assert.equal(t.orderNo, o.orderNo);
    assert.equal(t.billNo, "MMI/26-27/1");
    assert.equal(t.billDate, "2026-08-02");
    assert.equal(t.transporter, "VRL");
    assert.equal(t.paymentType, "Paid");
  });

  test("an LR puts a consignment on the road and takes it off Pending LR; reaching the party takes it off the road", async () => {
    const ctx = await as(admin);
    const [t] = await db.select().from(erpTransports);
    assert.equal(t.materialStage, "Dispatched");
    assert.ok((await mod("pendingLr").actions!.update(ctx, t.id, { stage: "In Transit" })).ok);
    assert.equal((await mod("pendingLr").load(ctx)).rows.length, 1, "no LR yet");
    assert.equal((await mod("trackLr").load(ctx)).rows.length, 0, "nothing to follow without an LR");
    assert.ok((await mod("pendingLr").actions!.update(ctx, t.id, { lr: "LR-7781", stage: "In Transit" })).ok);
    assert.equal((await mod("pendingLr").load(ctx)).rows.length, 0);
    assert.equal((await mod("trackLr").load(ctx)).rows.length, 1);
    const all = (await mod("transport").load(ctx)).rows[0];
    assert.match(String(all.v.stage), /In Transit/);
    assert.ok((await mod("trackLr").actions!.update(ctx, t.id, { lr: "LR-7781", stage: "Close - Received to Party" })).ok);
    assert.equal((await mod("trackLr").load(ctx)).rows.length, 0);
    assert.ok((await mod("trackLr").actions!.update(ctx, t.id, { lr: "LR-7781", stage: "In Transit" })).ok);
  });

  test("paid freight lists the line until its extra expense is entered, and the transport record follows", async () => {
    const ctx = await as(admin);
    const { rows } = await mod("paidFreight").load(ctx);
    assert.equal(rows.length, 1);
    assert.ok((await mod("paidFreight").actions!.extra(ctx, rows[0].id, { amount: "250" })).ok);
    assert.equal((await mod("paidFreight").load(ctx)).rows.length, 0);
    const [t] = await db.select().from(erpTransports);
    assert.equal(t.extraExpensePaise, 25000);
  });
});

describe("complaints and credit notes are the CRM's complaints", () => {
  test("a credit-note request names a real bill and goods on it, lands as a CRM complaint, and only the office decides", async () => {
    /* The ERP is not live here, so the bill is one the sheet wrote — the bills Accounts credits against. */
    await db.insert(bills).values({ id: "bil_mmi1", customerId: "cus_shree", billNo: "MMI/26-27/1", billDate: "2026-08-02", amount: 354000, paymentPosition: "stated" });
    const c = await as(clerk);
    assert.equal(msg(await mod("requests").forms!.new(c, { customer: "Shree Paints", type: "Leakage / Packaging", description: "Two cans leaked", cn: "Yes", bill: "NOPE" }, [])), "That is not one of this customer's bills");
    assert.ok((await mod("requests").forms!.new(c, { salesman: "Ravi Sales", customer: "Shree Paints", type: "Leakage / Packaging", description: "Two cans leaked", cn: "Yes", bill: "MMI/26-27/1", goods: SKU }, [])).ok);
    const [r] = await db.select().from(complaints);
    assert.equal(r.customerId, "cus_shree");
    assert.equal(r.category, "packaging_damage");
    assert.equal(r.requestCn, true);
    assert.equal(r.billId, "bil_mmi1");
    assert.equal(r.salesmanName, "Ravi Sales");
    assert.equal(r.status, "open");
    assert.ok(r.slaDueAt, "it carries the CRM's SLA like any complaint");
    assert.equal((await db.select().from(complaintStatusHistory).where(eq(complaintStatusHistory.complaintId, r.id))).length, 1);
    const row = (await mod("requests").load(c)).rows.find((x) => x.id === r.id)!;
    assert.equal(row.v.status, "Requested");
    assert.equal(row.v.bill, "MMI/26-27/1");
    assert.equal(msg(await mod("requests").actions!.accept(c, r.id, {})), "Only an admin or the office decides a request.");
  });

  test("an accepted credit note is issued through Accounts: it comes off the bill, closes the complaint, and the margin takes it", async () => {
    const a = await as(admin);
    const [r] = await db.select().from(complaints);
    assert.equal(msg(await mod("issueCn").actions!.issue(a, r.id, { amount: "100", date: "2026-08-05", number: "CN-1" })), "A credit note is issued on an accepted credit-note request.");
    assert.ok((await mod("issueCn").actions!.accept(a, r.id, {})).ok);
    const [accepted] = await db.select().from(complaints).where(eq(complaints.id, r.id));
    assert.equal(accepted.status, "in_progress");
    assert.equal(accepted.cnStatus, "under_review");
    const before = (await mod("orderDetails").load(a)).rows[0].v.margin as number | null;
    const issued = await mod("issueCn").actions!.issue(a, r.id, { amount: "100", date: "2026-08-05", number: "CN-1" });
    assert.ok(issued.ok, JSON.stringify(issued));
    const [done] = await db.select().from(complaints).where(eq(complaints.id, r.id));
    assert.equal(done.cnStatus, "issued");
    assert.equal(done.cnReference, "CN-1");
    assert.equal(done.cnDate, "2026-08-05");
    assert.equal(done.status, "resolved");
    const [receipt] = await db.select().from(paymentReceipts).where(eq(paymentReceipts.idempotencyKey, `creditnote:${r.id}`));
    assert.equal(Number(receipt.amount), 10000, "it is in the ledger, like every other credit note");
    const after = (await mod("orderDetails").load(a)).rows[0].v.margin as number | null;
    if (before != null && after != null) assert.equal(before - after, Math.round((10000 * 10000) / 11800), "the margin gives it back before GST");
    assert.equal((await mod("issueCn").load(a)).rows[0].v.status, "Resolved");
  });
});

describe("petty cash", () => {
  test("what was recorded before the fund ledger stays on its lists, and reaches no balance", async () => {
    const ctx = await as(admin);
    await db.execute(sql`insert into erp_credits (id, credit_date, godown_id, employee_name, mode, amount_paise, legacy) values ('cr_old', '2026-08-01', 'erpg_bhiwandi', 'Ravi Sales', 'Cash', 500000, true)`);
    await db.execute(sql`insert into erp_expenses (id, expense_date, godown_id, expense_by, mode, particular, amount_paise, status, legacy, approval_status) values ('exp_old', '2026-08-02', 'erpg_bhiwandi', 'Ravi Sales', 'Cash', 'Fuel', 120000, 'Verify', true, 'approved')`);
    const cr = (await mod("credits").load(ctx)).rows.find((r) => r.id === "cr_old")!;
    const ex = (await mod("expenses").load(ctx)).rows.find((r) => r.id === "exp_old")!;
    assert.equal(cr.v.status, "Before the ledger");
    assert.equal(ex.v.approval, "Before the ledger");
    assert.ok(ex.flags.includes("legacy"));
    assert.equal(ex.v.outstanding, null, "a legacy expense is in no payable");
    assert.ok(!(ex.actions ?? []).some((a) => a.id === "pay"), "and takes no payment");
  });
});

describe("my customers", () => {
  test("a salesman sees only the parties tagged to him, and cannot edit anyone else's", async () => {
    const c = await as(clerk);
    const { rows } = await mod("myCustomers").load(c);
    assert.deepEqual(rows.map((r) => r.v.name), ["Shree Paints"]);
    await db.insert(customers).values({ id: "cus_other", name: "Other Paints", city: "Pune", phone: "9876500009", kind: "customer" });
    assert.equal(msg(await mod("myCustomers").forms!.edit(c, { name: "Mine now" }, [], "cus_other")), "That customer is not tagged to you.");
    const [other] = await db.select().from(customers).where(eq(customers.id, "cus_other"));
    assert.equal(other.name, "Other Paints");
  });
});
