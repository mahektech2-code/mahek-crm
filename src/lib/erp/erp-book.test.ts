/**
 * ERP simplification — one order book. With `erp.orders.live` on, every ERP
 * order number is ONE row in MahekOne's `orders`, and once dispatch-verified
 * ONE row in `bills`; a Pending customer's order waits in the Accounts queue;
 * the sheet stops writing orders; and the Call Log's hold comes from the
 * ERP's open lines. Off, none of it writes.
 *
 *   npm run test:integration
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appSettings,
  auditLog,
  bills,
  customers,
  erpCustomerProfiles,
  erpFgEntries,
  erpOrders,
  erpProductPacking,
  finishedGoods,
  orders,
  productBrands,
  productFormulations,
  products,
  sheetOrderRows,
  sheetSyncRuns,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig } from "@/lib/config/store";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { bookStatus, bookStatusForStage, syncAllBookOrders, syncBookOrders } from "@/lib/erp/book";
import { approveOrder, declineOrder } from "@/lib/services/order-approval-service";
import { projectSheet } from "@/lib/services/sheet-projection-service";
import { recomputeOrderSystemHolds } from "@/lib/recompute";
import { customerProducts } from "@/lib/services/product-service";
import { varianceReport } from "@/lib/services/price-list-service";
import { runJob } from "@/lib/jobs";
import { ORDER_TABS_RETIRED, PARTY_TAB_RETIRED } from "@/lib/engines/sheet-retirement";

const tag = randomUUID().slice(0, 6);
const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const SKU = `ERPB Primer 1 L ${tag} (Loose)`;

async function makeUser(name: string, level: "associate" | "manager" | "admin", app: "erp" | "accounts" = "erp") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}@erp.test`, phone: String(9820000000 + Math.floor(Math.random() * 999999)), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app, role: level });
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
async function live(on: boolean) {
  await db
    .insert(appSettings)
    .values({ key: "erp.orders.live", value: on, valueType: "boolean", category: "erp", label: "The ERP takes the orders" })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: on } });
  invalidateConfig();
}
const book = async (orderNo: number) => (await db.select().from(orders).where(eq(orders.externalRef, `ERP-${orderNo}`)))[0];

let admin: typeof users.$inferSelect;
let ledger: typeof users.$inferSelect;
let skuId: string;

/** One ERP order of `qty` cans for `party`, through the real handlers. */
async function take(party: string, qty: number) {
  const ctx = await as(admin);
  const r = await mod("orders").forms!.new(ctx, { source: "Phone", date: "2026-09-10", godown: "Bhiwandi", billing: party }, [{ sku: SKU, qty: String(qty), rate: "300" }]);
  assert.ok(r.ok, JSON.stringify(r));
  const [o] = await db.select().from(erpOrders).where(sql`${erpOrders.qtyCans} = ${qty}`);
  return o;
}
/** Ready → allocated → billed → dispatch-verified. */
async function send(o: typeof erpOrders.$inferSelect, bill: string, date: string) {
  const ctx = await as(admin);
  assert.ok((await mod("orders").actions!.verifyOrder(ctx, o.id, {})).ok);
  assert.ok((await mod("orders").actions!.ready(ctx, o.id, {})).ok);
  assert.ok((await mod("orders").forms!.allocate(ctx, { lot: "FG1BH", qty: String(o.qtyCans) }, [], o.id)).ok);
  const billed = await mod("orders").actions!.bill(ctx, o.id, { invoiceNo: bill, invoiceDate: date });
  assert.ok(billed.ok, JSON.stringify(billed));
  assert.ok((await mod("orders").actions!.approveInvoice(ctx, o.id, {})).ok);
  const sent = await mod("orderDetails").actions!.verify(ctx, o.id, { date });
  assert.ok(sent.ok, JSON.stringify(sent));
}

before(async () => {
  await db.execute(sql`
    truncate users, customers, orders, bills, erp_customer_profiles, erp_orders, erp_batch_codes, erp_order_details,
             erp_fg_entries, erp_transports, erp_user_powers, erp_godown_staff, erp_user_settings, audit_log restart identity cascade`);
  await db.execute(sql`delete from app_settings where key in ('erp.orders.live', 'erp.orders.partySheet')`);
  invalidateConfig();
  await db.execute(sql`update erp_series set last = 0`);
  admin = await makeUser("Kavita Admin", "admin");
  ledger = await makeUser("Deepa Ledger", "manager", "accounts");
  const fId = id("form");
  const bId = id("brand");
  const fgId = id("fg");
  skuId = id("sku");
  await db.insert(productFormulations).values({ id: fId, name: `ERPB Primer ${tag}`, slug: `erpb-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `ERPB ${tag}`, slug: `erpb-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values({ id: fgId, name: `ERPB Primer 1 L ${tag}`, slug: `erpb-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 1000 });
  await db.insert(products).values({ id: skuId, name: SKU, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 1 });
  await db.insert(erpProductPacking).values({ productId: skuId, emptyBoxesRequired: 0 });
  await db.insert(customers).values([
    { id: "cus_shree", name: "Shree Paints", city: "Pune", phone: "9876500001", kind: "customer", creditDays: 30, freightTerm: "Paid" },
    { id: "cus_new", name: "New Colour House", city: "Nashik", phone: "9876500002", kind: "customer" },
  ]);
  await db.insert(erpCustomerProfiles).values([{ customerId: "cus_shree" }, { customerId: "cus_new", pendingActivation: true }]);
  await db.insert(erpFgEntries).values({ id: id("fge"), sourceType: "fill", sourceId: "fin_x", entryDate: "2026-08-01", finishedGoodId: fgId, lotCode: "FG1BH", godownId: "erpg_bhiwandi", quantity: 500, packingType: "Can", skuId });
});

after(async () => {
  await db.execute(sql`delete from app_settings where key in ('erp.orders.live', 'erp.orders.partySheet')`);
  invalidateConfig();
  setTestUser(null);
  await db.$client.end();
});

describe("the switch", () => {
  test("off, the ERP writes nothing into the book", async () => {
    await live(false);
    const o = await take("Shree Paints", 3);
    assert.equal(await book(o.orderNo), undefined);
    await db.delete(erpOrders).where(eq(erpOrders.id, o.id));
  });

  test("on, a line copied in from the Taken Order tab is never written into the book", async () => {
    await live(true);
    const o = await take("Shree Paints", 4);
    await db.update(erpOrders).set({ source: "sheet", sourceRef: `taken-${tag}` }).where(eq(erpOrders.id, o.id));
    await db.delete(orders).where(eq(orders.externalRef, `ERP-${o.orderNo}`));
    await syncAllBookOrders();
    assert.equal(await book(o.orderNo), undefined, "the sheet's own SHEET- order already counts it");
    await syncBookOrders([o.orderNo]);
    assert.equal(await book(o.orderNo), undefined, "an edit's resync does not write it either");
    await db.delete(erpOrders).where(eq(erpOrders.id, o.id));
  });
});

describe("an ERP order in the book", () => {
  test("one order row per order number, counted as a sale, confirmed and valued", async () => {
    await live(true);
    const o = await take("Shree Paints", 10);
    const b = await book(o.orderNo);
    assert.ok(b, "the order is in the book");
    assert.equal(b.source, "erp");
    assert.equal(b.status, "confirmed");
    assert.equal(b.customerId, "cus_shree");
    assert.equal(b.orderNo, `ERP-${o.orderNo}`);
    assert.equal(b.userId, admin.id, "whose order it was travels with it");
    assert.equal(Number(b.totalAmount), Math.round(10 * 30000 * 1.18));
    assert.equal(Number(b.netAmountPaise), 300000);
    const [c] = await db.select().from(customers).where(eq(customers.id, "cus_shree"));
    assert.equal(c.lastOrderDate, "2026-09-10", "the Call Log sees the order");
  });

  test("dispatch-verifying writes ONE bill, under the Tally number, owed until money is recorded", async () => {
    const [o] = await db.select().from(erpOrders).where(eq(erpOrders.qtyCans, 10));
    await send(o, "MMI/26-27/501", "2026-09-12");
    const b = await book(o.orderNo);
    assert.equal(b.status, "dispatched");
    const bs = await db.select().from(bills).where(eq(bills.externalRef, `ERPBILL-${o.orderNo}`));
    assert.equal(bs.length, 1);
    assert.equal(bs[0].billNo, "MMI/26-27/501");
    assert.equal(bs[0].orderId, b.id);
    assert.equal(bs[0].billDate, "2026-09-12");
    assert.equal(bs[0].paymentPosition, "stated");
    const [c] = await db.select().from(customers).where(eq(customers.id, "cus_shree"));
    assert.equal(Number(c.outstanding), Number(bs[0].amount), "it is on the ledger at once");
  });

  test("the consignment's stage moves the order: on the road, then delivered", async () => {
    const [o] = await db.select().from(erpOrders).where(eq(erpOrders.qtyCans, 10));
    const ctx = await as(admin);
    const [t] = (await db.execute(sql`select id from erp_transports where order_no = ${o.orderNo}`)) as unknown as { id: string }[];
    assert.ok((await mod("transport").actions!.update(ctx, t.id, { lr: "LR-9", stage: "In Transit" })).ok);
    assert.equal((await book(o.orderNo)).status, "in_transit");
    assert.ok((await mod("transport").actions!.update(ctx, t.id, { lr: "LR-9", stage: "Close - Received to Party" })).ok);
    assert.equal((await book(o.orderNo)).status, "delivered");
    const [c] = await db.select().from(customers).where(eq(customers.id, "cus_shree"));
    assert.equal(c.lastOrderDate, "2026-09-10", "a delivered order still counts as ordered");
  });

  test("a bill number the sheet already holds falls back rather than colliding", async () => {
    await db.insert(bills).values({ id: id("bil"), customerId: "cus_shree", billNo: "MMI/26-27/777", billDate: "2026-08-01", amount: 100, externalRef: "SHEETPAY-1" });
    const o = await take("Shree Paints", 4);
    await send(o, "MMI/26-27/777", "2026-09-13");
    const [b] = await db.select().from(bills).where(eq(bills.externalRef, `ERPBILL-${o.orderNo}`));
    assert.equal(b.billNo, `MMI/26-27/777/ERP${o.orderNo}`);
  });
});

describe("one Tally invoice over several orders", () => {
  /** Verified, Ready and allocated: everything Bill it asks for. */
  async function prep(party: string, qty: number) {
    const o = await take(party, qty);
    const ctx = await as(admin);
    assert.ok((await mod("orders").actions!.verifyOrder(ctx, o.id, {})).ok);
    assert.ok((await mod("orders").actions!.ready(ctx, o.id, {})).ok);
    assert.ok((await mod("orders").forms!.allocate(ctx, { lot: "FG1BH", qty: String(qty) }, [], o.id)).ok);
    return o;
  }
  const said = (r: { ok: boolean; error?: string }) => (r.ok ? "" : (r.error ?? ""));
  const billNo = async (o: typeof erpOrders.$inferSelect) => (await db.select().from(erpOrders).where(eq(erpOrders.id, o.id)))[0].tallyBillNo;

  test("several orders for one party bill onto one invoice, each its own bill in the book", async () => {
    await live(true);
    /* Two parties of their own, so nothing here is counted by the tests after. */
    await db.insert(customers).values([
      { id: "cus_one", name: "One Invoice Traders", city: "Pune", phone: "9876500003", kind: "customer" },
      { id: "cus_other", name: "Other Paints", city: "Pune", phone: "9876500004", kind: "customer" },
    ]);
    await db.insert(erpCustomerProfiles).values([{ customerId: "cus_one" }, { customerId: "cus_other" }]);
    const ctx = await as(admin);
    const a = await prep("One Invoice Traders", 71);
    const b = await prep("One Invoice Traders", 72);
    const together = await mod("orders").bulk!.bill(ctx, [a.id, b.id], { invoiceNo: "MMI/26-27/900", invoiceDate: "2026-09-14" });
    assert.ok(together.ok, JSON.stringify(together));
    assert.equal(await billNo(a), "MMI/26-27/900");
    assert.equal(await billNo(b), "MMI/26-27/900");

    const c = await prep("One Invoice Traders", 73);
    assert.match(said(await mod("orders").actions!.bill(ctx, c.id, { invoiceNo: "MMI/26-27/900", invoiceDate: "2026-09-15" })), /dated 2026-09-14/, "an invoice has one date");
    const joined = await mod("orders").actions!.bill(ctx, c.id, { invoiceNo: "mmi/26-27/ 900", invoiceDate: "2026-09-14" });
    assert.ok(joined.ok, JSON.stringify(joined));
    assert.equal(await billNo(c), "MMI/26-27/900", "it joins under the number as already written");

    const d = await prep("Other Paints", 74);
    assert.match(said(await mod("orders").actions!.bill(ctx, d.id, { invoiceNo: "MMI/26-27/900", invoiceDate: "2026-09-14" })), /billed to One Invoice Traders/, "an invoice has one party");
    assert.match(said(await mod("orders").bulk!.bill(ctx, [a.id, d.id], { invoiceNo: "MMI/26-27/950", invoiceDate: "2026-09-14" })), /already billed/);

    /* Changing the invoice changes it on every order it covers. */
    assert.ok((await mod("orders").actions!.changeInvoice(ctx, a.id, { invoiceNo: "MMI/26-27/901", invoiceDate: "2026-09-14" })).ok);
    for (const o of [a, b, c]) assert.equal(await billNo(o), "MMI/26-27/901");

    for (const o of [a, b]) {
      assert.ok((await mod("orders").actions!.approveInvoice(ctx, o.id, {})).ok);
      const sent = await mod("orderDetails").actions!.verify(ctx, o.id, { date: "2026-09-14" });
      assert.ok(sent.ok, JSON.stringify(sent));
    }
    const [ba] = await db.select().from(bills).where(eq(bills.externalRef, `ERPBILL-${a.orderNo}`));
    const [bb] = await db.select().from(bills).where(eq(bills.externalRef, `ERPBILL-${b.orderNo}`));
    assert.equal(ba.billNo, "MMI/26-27/901");
    assert.equal(bb.billNo, `MMI/26-27/901/ERP${b.orderNo}`);
    assert.match(said(await mod("orders").actions!.changeInvoice(ctx, c.id, { invoiceNo: "MMI/26-27/902", invoiceDate: "2026-09-14" })), /already dispatch-verified/);
  });
});

describe("a Pending customer goes to the Accounts queue", () => {
  test("the order waits as pending_approval and cannot be billed; Accounts approving releases it", async () => {
    const o = await take("New Colour House", 6);
    assert.equal(o.partyStatus, "Pending");
    const b = await book(o.orderNo);
    assert.equal(b.status, "pending_approval");
    const ctx = await as(admin);
    const blocked = await mod("orders").actions!.bill(ctx, o.id, { invoiceNo: "MMI/PENDING/1", invoiceDate: "2026-09-10" });
    assert.match(blocked.ok ? "" : (blocked.error ?? ""), /approval for this Pending customer/);
    assert.ok(!(await mod("orders").actions!.approve(ctx, o.id, {})).ok, "the ERP's own approval is gone while the ERP is live");
    setTestUser(ledger);
    assert.ok((await approveOrder(b.id)).ok);
    const [after] = await db.select().from(erpOrders).where(eq(erpOrders.id, o.id));
    assert.equal(after.partyStatus, "Approved By Admin");
    /* The next ERP write re-states the order; the approval is not undone by it. */
    assert.ok((await mod("orders").actions!.verifyOrder(await as(admin), o.id, {})).ok);
    assert.ok((await mod("orders").actions!.ready(await as(admin), o.id, {})).ok);
    assert.equal((await book(o.orderNo)).status, "confirmed");
  });

  test("Accounts declining cancels the ERP lines with the reason", async () => {
    const o = await take("New Colour House", 7);
    const b = await book(o.orderNo);
    setTestUser(ledger);
    assert.ok((await declineOrder(b.id, "Over the credit limit")).ok);
    const [after] = await db.select().from(erpOrders).where(eq(erpOrders.id, o.id));
    assert.equal(after.status, "Cancel");
    assert.equal(after.partyStatus, "Declined");
    assert.match(after.remark ?? "", /Over the credit limit/);
    await mod("orders").actions!.ready(await as(admin), o.id, {});
    assert.equal((await book(o.orderNo)).status, "declined", "nothing the godown does turns a refusal into a sale");
  });
});

describe("the sheet and the Call Log", () => {
  test("live, the sheet projection writes no orders or bills", async () => {
    const before = await db.select({ id: orders.id }).from(orders).where(like(orders.externalRef, "SHEET-%"));
    const r = await projectSheet({});
    assert.equal(r.orders.created + r.orders.updated, 0);
    assert.ok(r.bills.skipped);
    assert.match(r.skipped[0]?.reason ?? "", /ERP takes the orders/);
    const after = await db.select({ id: orders.id }).from(orders).where(like(orders.externalRef, "SHEET-%"));
    assert.equal(after.length, before.length);
  });

  test("a customer is held off the Call Log while an ERP line of theirs is open, and released when it leaves", async () => {
    await recomputeOrderSystemHolds();
    const [shree] = await db.select().from(customers).where(eq(customers.id, "cus_shree"));
    assert.equal(shree.activeInOrderSystem, false, "everything of theirs has been dispatched");
    await take("Shree Paints", 9);
    await recomputeOrderSystemHolds();
    const [held] = await db.select().from(customers).where(eq(customers.id, "cus_shree"));
    assert.equal(held.activeInOrderSystem, true);
  });
});

/*
 * THE CUT-OVER. Everything that read the sheet's half of the book, or only the
 * sheet's, and would have gone quiet or wrong the day the ERP took the orders.
 */
describe("once the ERP takes the orders", () => {
  test("live, the order tab creates no customers either", async () => {
    const run = id("syn");
    await db.insert(sheetSyncRuns).values({ id: run, source: "order_details", spreadsheetId: "sheet1", tabTitle: "Order Details", status: "ok", startedAt: new Date(), finishedAt: new Date() });
    await db.insert(sheetOrderRows).values({
      id: id("sor"), syncId: run, rowNumber: 2, lineKey: `late-${tag}`, raw: {}, rowHash: tag, status: "present",
      orderNumber: "99001", billingPartyName: `Typed After Cutover ${tag}`, orderDate: "2026-09-20",
    } as typeof sheetOrderRows.$inferInsert);
    const r = await projectSheet({});
    assert.equal(r.customers.created, 0);
    const made = await db.select().from(customers).where(like(customers.name, `Typed After Cutover%`));
    assert.equal(made.length, 0, "a party typed into Order Details after the cut-over is not a customer");
    await db.delete(sheetSyncRuns).where(eq(sheetSyncRuns.id, run));
  });

  test("a lead that orders through the ERP becomes a customer on its second ERP order", async () => {
    const rahul = await makeUser(`Rahul Field ${tag}`, "associate", "accounts");
    const ctx = await as(admin);
    /* A lead from Lead Management, owned by its salesman — the ERP no longer opens parties itself. */
    const leadId = id("cus");
    await db.insert(customers).values({ id: leadId, name: `Desk Party ${tag}`, city: "Thane", phone: "9876500077", kind: "lead", ownerId: rahul.id, creditDays: 30 } as typeof customers.$inferInsert);
    const [lead] = await db.select().from(customers).where(eq(customers.id, leadId));
    assert.ok((await mod("customers").actions!.activate(ctx, lead.id, {})).ok);

    await take(`Desk Party ${tag}`, 21);
    const [afterOne] = await db.select().from(customers).where(eq(customers.id, lead.id));
    assert.equal(afterOne.kind, "lead", "a first order is the tail of a trial, not a relationship");

    await take(`Desk Party ${tag}`, 22);
    const [afterTwo] = await db.select().from(customers).where(eq(customers.id, lead.id));
    assert.equal(afterTwo.kind, "customer");
    assert.equal(afterTwo.salesAmId, rahul.id, "the sales seat is the salesperson's");
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, lead.id));
    assert.ok(audit.some((a) => a.action === "customer.convertedFromLead"));
  });

  test("product history reads the ERP's orders, delivered ones included", async () => {
    const history = await customerProducts("cus_shree");
    const row = history.find((p) => p.productId === skuId);
    assert.ok(row, "the SKU Shree Paints ordered through the ERP is in their history");
    assert.ok(row.totalOrderCount >= 2);
  });

  test("the price-list variance report reads the ERP's own lines and not the ones copied from the sheet", async () => {
    const copied = await take("Shree Paints", 23);
    await db.update(erpOrders).set({ source: "sheet", sourceRef: `copied-${tag}` }).where(eq(erpOrders.id, copied.id));
    const v = await varianceReport("2026-09");
    const mine = v.rows.filter((r) => r.productId === skuId && r.customerId === "cus_shree");
    assert.ok(mine.length > 0, "ERP lines are in the month");
    assert.ok(mine.every((r) => r.billedExPaise === 30000));
    assert.equal(mine.filter((r) => r.cans === 23).length, 0, "a line the sheet already reports is not counted twice");
    await db.delete(erpOrders).where(eq(erpOrders.id, copied.id));
  });

  test("the hourly pass rebuilds the Call Log hold, and a retired tab is not read by anybody", async () => {
    await db.update(customers).set({ activeInOrderSystem: false }).where(eq(customers.id, "cus_shree"));
    const [holds] = await runJob("recompute-order-holds");
    assert.match(holds.detail, /held/);
    const [shree] = await db.select().from(customers).where(eq(customers.id, "cus_shree"));
    assert.equal(shree.activeInOrderSystem, true, "the open 9-can order holds them again without the Taken Order sync");

    // No Google credentials here: a read that ran would throw, so a detail is proof it did not.
    const [taken] = await runJob("taken-order-sync");
    assert.equal(taken.detail, ORDER_TABS_RETIRED);
    await db
      .insert(appSettings)
      .values({ key: "erp.orders.partySheet", value: false, valueType: "boolean", category: "erp", label: "The Sales Party sheet is the party master" })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: false } });
    invalidateConfig();
    const [party] = await runJob("party-sync");
    assert.equal(party.detail, PARTY_TAB_RETIRED);
    await db.execute(sql`delete from app_settings where key = 'erp.orders.partySheet'`);
    invalidateConfig();
  });
});

describe("the arithmetic", () => {
  test("what an order's lines add up to", () => {
    const line = (status: string, partyStatus: string | null, verification: string | null) => ({ status, partyStatus, verification });
    assert.equal(bookStatus([line("Ready", null, null)], null, null), "confirmed");
    assert.equal(bookStatus([line("Ready", "Pending", null)], null, null), "pending_approval");
    assert.equal(bookStatus([line("Ready", "Pending", null)], null, { approvedAt: new Date(), status: "confirmed" }), "confirmed");
    assert.equal(bookStatus([line("Cancel", null, null)], null, null), "cancelled");
    assert.equal(bookStatus([line("Ready", null, "Verified"), line("Ready", null, null)], "In Transit", null), "confirmed", "part of it has not left");
    assert.equal(bookStatus([line("Ready", null, "Verified"), line("Cancel", null, null)], "In Transit", null), "in_transit");
    assert.equal(bookStatus([line("Ready", null, "Verified")], null, { approvedAt: new Date(), status: "declined" }), "declined");
    assert.equal(bookStatusForStage("Dispatched"), "dispatched");
    assert.equal(bookStatusForStage("Dispatch from Bhiwandi"), "dispatched");
    assert.equal(bookStatusForStage("Reached Destination Area"), "in_transit");
    assert.equal(bookStatusForStage("Close - Received to Party"), "delivered");
  });
});
