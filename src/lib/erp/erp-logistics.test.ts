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
  customers,
  erpCustomerProfiles,
  erpFgEntries,
  erpFollowups,
  erpOrderDetails,
  erpOrders,
  erpProductPacking,
  erpRequests,
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
  await mod("orders").actions!.done(ctx, o.id, {});
  await mod("orders").forms!.edit(ctx, { status: "Ready", delivery: "Shree Paints", qty: String(qty), rate: "300", bill, transport: "0" }, [], o.id);
  assert.ok((await mod("orders").actions!.toDetails(ctx, o.id, {})).ok);
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

describe("dispatch opens the transport and follow-up records (§18)", () => {
  test("one transport record per bill, and one follow-up per line", async () => {
    const o = await dispatch("2026-08-01", 10, "MMI/26-27/1", "2026-08-02");
    const [t] = await db.select().from(erpTransports);
    assert.equal(t.orderNo, o.orderNo);
    assert.equal(t.billNo, "MMI/26-27/1");
    assert.equal(t.billDate, "2026-08-02");
    assert.equal(t.transporter, "VRL");
    assert.equal(t.paymentType, "Paid");
    assert.equal((await db.select().from(erpFollowups).where(eq(erpFollowups.orderId, o.id))).length, 1);
  });

  test("a tracked consignment needs its LR, and an LR takes it off Pending LR", async () => {
    const ctx = await as(admin);
    const [t] = await db.select().from(erpTransports);
    assert.equal(msg(await mod("pendingLr").actions!.update(ctx, t.id, { track: "Track", stage: "In Transit" })), "A consignment is tracked by its LR number");
    assert.ok((await mod("pendingLr").actions!.update(ctx, t.id, { lr: "LR-7781", track: "Track", stage: "In Transit" })).ok);
    assert.equal((await mod("pendingLr").load(ctx)).rows.length, 0);
    assert.equal((await mod("trackLr").load(ctx)).rows.length, 1);
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

describe("customer requests and credit notes", () => {
  test("a credit-note request names a real bill and an SKU on it; only the office decides", async () => {
    const c = await as(clerk);
    assert.equal(msg(await mod("requests").forms!.new(c, { customer: "Shree Paints", type: "Leakage", description: "Two cans leaked", cn: "Yes", bill: "NOPE" }, [])), "That is not one of this customer's bills");
    assert.ok((await mod("requests").forms!.new(c, { customer: "Shree Paints", type: "Leakage", description: "Two cans leaked", cn: "Yes", bill: "MMI/26-27/1", goods: SKU }, [])).ok);
    const [r] = await db.select().from(erpRequests);
    assert.equal(r.billDate, "2026-08-02", "the bill date is the dispatch date");
    assert.equal(msg(await mod("requests").actions!.accept(c, r.id, {})), "Only an admin or the office decides a request.");
  });

  test("an issued credit note shows as pending on its order line until the updater copies it, and the margin takes it", async () => {
    const a = await as(admin);
    const [r] = await db.select().from(erpRequests);
    assert.equal(msg(await mod("requests").actions!.issue(a, r.id, { amount: "100", date: "2026-08-05", number: "CN-1" })), "A credit note is issued on an accepted credit-note request.");
    assert.ok((await mod("requests").actions!.accept(a, r.id, {})).ok);
    assert.ok((await mod("requests").actions!.issue(a, r.id, { amount: "100", date: "2026-08-05", number: "CN-1" })).ok);
    const pending = await mod("pendingCn").load(a);
    assert.equal(pending.rows.length, 1);
    const before = (await mod("orderDetails").load(a)).rows[0].v.margin as number | null;
    assert.ok((await mod("pendingCn").actions!.update(a, pending.rows[0].id, {})).ok);
    assert.equal((await mod("pendingCn").load(a)).rows.length, 0);
    const [d] = await db.select().from(erpOrderDetails);
    assert.equal(d.creditNotePaise, 10000);
    const afterMargin = (await mod("orderDetails").load(a)).rows[0].v.margin as number | null;
    if (before != null && afterMargin != null) assert.equal(before - afterMargin, 10000);
  });
});

describe("order follow-up", () => {
  test("the previous order and the gap are by date, and the next order is predicted from the average", async () => {
    await dispatch("2026-08-21", 5, "MMI/26-27/2", "2026-08-22");
    const ctx = await as(admin);
    const { rows } = await mod("followup").load(ctx);
    const latest = rows.find((r) => r.v.date === "2026-08-21")!;
    assert.equal(latest.v.lastParty, "2026-08-01");
    assert.equal(latest.v.dayCount, 20);
    assert.equal(latest.v.average, 20);
    assert.equal(latest.v.next, "2026-09-10");
    assert.ok((await mod("followup").actions!.edit(ctx, latest.id, { party: "-3" })).ok);
    const again = (await mod("followup").load(ctx)).rows.find((r) => r.id === latest.id)!;
    assert.equal(again.v.calling, "2026-09-07");
  });
});

describe("petty cash", () => {
  test("available is credits less what that person spent, on both screens (A-24)", async () => {
    const ctx = await as(admin);
    assert.ok((await mod("credits").forms!.new(ctx, { date: "2026-08-01", godown: "Bhiwandi", who: "Ravi Sales", mode: "Cash", amount: "5000" }, [])).ok);
    assert.ok((await mod("expenses").forms!.new(ctx, { date: "2026-08-02", godown: "Bhiwandi", who: "Ravi Sales", mode: "Cash", particular: "Fuel", amount: "1200" }, [])).ok);
    const cr = (await mod("credits").load(ctx)).rows[0];
    const ex = (await mod("expenses").load(ctx)).rows[0];
    assert.equal(cr.v.available, 380000);
    assert.equal(ex.v.available, 380000);
    const c = await as(clerk);
    assert.equal(msg(await mod("expenses").actions!.verify(c, ex.id, {})), "A manager verifies expenses.");
    assert.ok((await mod("expenses").actions!.verify(ctx, ex.id, {})).ok);
    assert.equal(msg(await mod("expenses").actions!.amount(ctx, ex.id, { amount: "1" })), "A verified expense is closed.");
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
