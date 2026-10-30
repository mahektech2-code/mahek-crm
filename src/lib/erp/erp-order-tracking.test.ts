/**
 * CUSTOMER ORDER TRACKING, end to end, against a real database through the
 * real handlers: an order is verified (and its link and confirmation made), held
 * and resolved, billed with its PDF, its invoice approved, dispatched, carried,
 * delayed, delivered — and at every step the customer's page says only what
 * was recorded, and each message is written once.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  attachments,
  customers,
  erpCustomerProfiles,
  erpFgEntries,
  erpOrderHolds,
  erpOrderMilestones,
  erpOrderTracking,
  erpOrders,
  erpProductPacking,
  erpTransportMessages,
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
import { today } from "@/lib/erp/screens/common";
import { addDays } from "@/lib/erp/engines/logistics";
import * as L from "@/lib/erp/logistics";
import * as T from "@/lib/erp/order-tracking";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const tag = randomUUID().slice(0, 6).toUpperCase();
const SKU = `ERPT Thinner ${tag} - 5 Liter (Loose)`;
const TODAY = today();

async function makeUser(name: string, level: "associate" | "admin") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}@track.test`, phone: testPhone(), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
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

async function takeOrder(qty: number, extra: Record<string, string> = {}) {
  const ctx = await as(admin);
  const r = await mod("orders").forms!.new(ctx, { date: TODAY, godown: "Bhiwandi", billing: "Shree Paints", source: "Phone", ...extra }, [{ sku: SKU, qty: String(qty), rate: "300" }]);
  assert.ok(r.ok, JSON.stringify(r));
  const [o] = await db.select().from(erpOrders).where(sql`${erpOrders.qtyCans} = ${qty} and ${erpOrders.skuId} = (select id from products where name = ${SKU})`);
  return o;
}
const steps = async (orderNo: number) =>
  (await db.select().from(erpOrderMilestones).where(and(eq(erpOrderMilestones.orderNo, orderNo), isNull(erpOrderMilestones.withdrawnAt)))).map((m) => m.step).sort();
const orderMessages = async (orderNo: number) => db.select().from(erpTransportMessages).where(eq(erpTransportMessages.orderNo, orderNo));
const tokenOf = async (orderNo: number) => (await db.select().from(erpOrderTracking).where(and(eq(erpOrderTracking.orderNo, orderNo), isNull(erpOrderTracking.revokedAt))))[0];

before(async () => {
  /* The address links are built against — production reads its own. */
  process.env.APP_URL = "https://one.test";
  await db.execute(sql`
    truncate users, customers, erp_customer_profiles, erp_orders, erp_batch_codes, erp_order_details, erp_fg_entries,
             erp_pack_entries, erp_transport_allocations, erp_transport_payments, erp_trips, erp_order_reviews, erp_transports, erp_lrs,
             erp_transport_events, erp_transport_messages, erp_order_tracking, erp_order_milestones, erp_order_holds,
             erp_user_powers, erp_godown_staff, erp_user_settings, audit_log restart identity cascade`);
  await db.execute(sql`update erp_series set last = 0`);
  admin = await makeUser("Kavita Admin", "admin");
  const fId = id("form");
  const bId = id("brand");
  const fgId = id("fg");
  const skuId = id("sku");
  await db.insert(productFormulations).values({ id: fId, name: `ERPT Thinner ${tag}`, slug: `erpt-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `ERPT ${tag}`, slug: `erpt-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values({ id: fgId, name: `ERPT Thinner - 5 Liter`, slug: `erpt-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 5000 });
  await db.insert(products).values({ id: skuId, name: SKU, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 5000, cansPerBox: 1 });
  await db.insert(erpProductPacking).values({ productId: skuId, emptyBoxesRequired: 0 });
  await db.insert(customers).values({ id: "cus_shree", name: "Shree Paints", city: "Pune", phone: "9876500001", kind: "customer", area: "Pune", creditDays: 30, freightTerm: "Paid" });
  await db.insert(customers).values({ id: "cus_shop", name: "Ganesh Hardware", city: "Satara", phone: "9876500002", kind: "customer", area: "Satara", thirdParty: true });
  await db.insert(erpCustomerProfiles).values({ customerId: "cus_shree", transporter: "VRL" });
  await db.execute(sql`insert into erp_transporters (id, name) values ('etr_vrl_tracking', 'VRL') on conflict do nothing`);
  await db.insert(erpFgEntries).values({ id: id("fge"), sourceType: "fill", sourceId: "fin_x", entryDate: TODAY, finishedGoodId: fgId, lotCode: "FG7BH", godownId: "erpg_bhiwandi", quantity: 500, packingType: "Can", skuId });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("customer order tracking", () => {
  test("from verification to delivery: one link, every step once, holds, documents and messages", async () => {
    const ctx = await as(admin);
    const o = await takeOrder(4);
    const no = o.orderNo;

    /* Taken is not confirmed: no link, nothing told. */
    await T.syncOrderTracking([no]);
    assert.equal(await tokenOf(no), undefined);
    assert.deepEqual(await steps(no), []);

    /* The back office verifies: the link is made and the confirmation written — once. */
    assert.ok((await mod("orders").actions!.verifyOrder(ctx, o.id, {})).ok);
    const t = await tokenOf(no);
    assert.ok(t, "a link exists once the order is confirmed");
    assert.equal(t.backfilled, false);
    assert.equal(t.deliveryToken, null, "billing and delivery are one party, so one link");
    assert.deepEqual(await steps(no), ["confirmed", "preparing"]);
    let out = await orderMessages(no);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "confirmed");
    assert.equal(out[0].status, "to_send", "no Wati template is named, so it waits to be sent by hand");
    assert.match(out[0].body, new RegExp(`Order Number: ${no}`));
    assert.match(out[0].body, /• ERPT Thinner \(5 L can\) — 4 Cans/);
    assert.match(out[0].body, new RegExp(`/t/${t.token}`));
    await T.syncOrderTracking([no]);
    await T.syncOrderTracking([no]);
    assert.equal((await orderMessages(no)).length, 1, "a step saved again is not told again");

    let page = (await T.publicOrderTracking(t.token))!;
    assert.equal(page.status.label, "Preparing Your Order");
    assert.equal(page.expectedOn, null, "no delivery date before anything says one");
    assert.deepEqual(page.products, [{ name: "ERPT Thinner", qty: 4, unit: "Cans", pack: "5 L can", measure: "20 Litre" }]);
    assert.equal(page.documents.invoice.available, false);
    assert.equal(page.documents.lr.detail, "Will appear here when available");

    /* On hold, with a reason the customer reads and a note they never do. */
    assert.equal(msg(await mod("orders").actions!.hold(ctx, o.id, { reason: "Other", customerText: "x" })), "Write the reason the customer will read");
    assert.ok((await mod("orders").actions!.hold(ctx, o.id, { reason: "Material shortage", customerText: "Your order is waiting for a material.", internalNote: "Toluene drums short", nextUpdateOn: addDays(TODAY, 2), notify: "Yes" })).ok);
    assert.equal((await db.select().from(erpOrders).where(eq(erpOrders.id, o.id)))[0].status, "Hold From Office");
    assert.match(msg(await mod("orders").actions!.hold(ctx, o.id, { reason: "Payment pending", customerText: "Waiting for your payment please." })), /already on hold/);
    page = (await T.publicOrderTracking(t.token))!;
    assert.equal(page.hold?.title, "Order On Hold");
    assert.equal(page.hold?.text, "Your order is waiting for a material.");
    assert.ok(!JSON.stringify(page).includes("Toluene"), "the internal note never reaches the customer's page");
    out = await orderMessages(no);
    assert.equal(out.filter((m) => m.kind === "hold").length, 1);
    assert.ok(!out.some((m) => m.body.includes("Toluene")));

    /* Resolved: back to Under Process, and both ends stay in the history. */
    assert.ok((await mod("orders").actions!.resolveHold(ctx, o.id, { resolution: "Materials received. Preparation resumed.", notify: "No" })).ok);
    assert.equal((await db.select().from(erpOrders).where(eq(erpOrders.id, o.id)))[0].status, "Under Process");
    page = (await T.publicOrderTracking(t.token))!;
    assert.equal(page.hold, null);
    assert.deepEqual(
      page.entries.filter((e) => e.type !== "step").map((e) => e.type),
      ["hold", "resolved"],
    );

    /* Ready, then billed with its PDF: the invoice is not the customer's until the checker approves it. */
    assert.ok((await mod("orders").actions!.ready(ctx, o.id, {})).ok);
    assert.ok((await steps(no)).includes("ready"));
    const [pdf] = await db
      .insert(attachments)
      .values({ id: id("att"), filename: "MMI-1.pdf", storedRef: `pg:${tag}`, contentType: "application/pdf", sizeBytes: 10, status: "available", uploadedById: admin.id })
      .returning();
    assert.ok((await mod("orders").forms!.allocate(ctx, { lot: "FG7BH", qty: "4" }, [], o.id)).ok);
    assert.ok((await mod("orders").actions!.bill(ctx, o.id, { invoiceNo: `MMI/${tag}/1`, invoiceDate: TODAY, invoiceFile: pdf.id })).ok);
    assert.equal((await db.select().from(attachments).where(eq(attachments.id, pdf.id)))[0].parentId, String(no), "the PDF is the order's");
    assert.equal((await steps(no)).includes("invoice"), false, "a bill waiting for its check is not shown");
    assert.equal(await T.publicDocument(t.token, "invoice"), null);
    assert.ok((await mod("orders").actions!.approveInvoice(ctx, o.id, {})).ok);
    assert.ok((await steps(no)).includes("invoice"));
    page = (await T.publicOrderTracking(t.token))!;
    assert.equal(page.status.label, "Invoice Available");
    assert.equal(page.documents.invoice.available, true);
    assert.deepEqual(await T.publicDocument(t.token, "invoice"), { id: pdf.id });
    assert.equal(await T.publicDocument(t.token, "lr"), null, "no LR yet");
    assert.equal((await orderMessages(no)).filter((m) => m.kind === "invoice").length, 1);

    /* Dispatched: the consignment opens and the customer is told it left. */
    assert.ok((await mod("orderDetails").actions!.verify(ctx, o.id, { date: TODAY })).ok);
    assert.ok((await steps(no)).includes("dispatched"));
    assert.equal((await orderMessages(no)).filter((m) => m.kind === "dispatched").length, 1);
    const [tr] = await db.select().from(erpTransports).where(eq(erpTransports.orderNo, no));

    /* A consignment link sent before order tracking opens the order's page. */
    assert.equal(await T.orderLinkForConsignment(tr.trackToken!), t.token);

    /* The road. */
    assert.ok((await L.markAtTransport(ctx, [tr.id])).ok);
    assert.ok((await steps(no)).includes("at_transport"));
    const up = await L.uploadLrs(ctx, [{ lrNo: `LR-${tag}`, lrDate: TODAY, transporter: "VRL", destination: "Pune", packages: 4 }]);
    assert.ok(up.ok);
    assert.ok((await L.attachLr(ctx, up.data.ids[0], [tr.id], { expectedOn: addDays(TODAY, 4) })).ok);
    page = (await T.publicOrderTracking(t.token))!;
    assert.equal(page.status.label, "In Transit");
    assert.equal(page.expectedOn, addDays(TODAY, 4));
    assert.equal(page.lrNo, `LR-${tag}`);
    assert.ok(page.entries.some((e) => e.type === "step" && e.step === "lr" && e.state === "done"));
    const lrMessage = (await L.messages()).find((m) => m.kind === "lr");
    assert.match(lrMessage?.body ?? "", new RegExp(`/t/${t.token}`), "Logistics' own messages carry the order's link now");

    /* A delay the customer reads as one — its own sentence, the internal note kept back. */
    assert.ok((await L.raiseIssue(ctx, [tr.id], { issue: "Delayed", note: "driver drunk", expectedOn: addDays(TODAY, 6), notify: false })).ok);
    page = (await T.publicOrderTracking(t.token))!;
    assert.equal(page.hold?.title, "Delivery Delayed");
    assert.match(page.hold?.text ?? "", /The transporter has reported a delay/);
    assert.equal(page.expectedOn, addDays(TODAY, 6), "the revised date where one was given");
    assert.ok(!JSON.stringify(page).includes("drunk"));
    assert.ok((await L.clearIssue(ctx, [tr.id], "moving again")).ok);
    assert.equal((await T.publicOrderTracking(t.token))!.hold, null);

    /* 0296 — the route reaches the customer's page: where it left from and each city, never a call note. */
    assert.ok((await L.updateConsignment(ctx, [tr.id], { dispatchedFrom: "VRL Bhiwandi", cities: [{ city: "Nashik", on: TODAY }], destination: "Indore", note: "driver asleep", notify: false })).ok);
    page = (await T.publicOrderTracking(t.token))!;
    assert.deepEqual(page.route.map((r) => [r.from, r.city]), [[true, "VRL Bhiwandi"], [false, "Nashik"]]);
    assert.equal(page.destination, "Indore");
    assert.equal(page.pickup, null);
    assert.ok(!JSON.stringify(page).includes("asleep"));

    /* Out for delivery is reported; the destination office is not, and is never ticked. */
    assert.ok((await L.updateConsignment(ctx, [tr.id], { stage: "Out for Delivery", notify: false })).ok);
    assert.equal((await T.publicOrderTracking(t.token))!.status.label, "Out for Delivery");
    assert.ok((await L.markDelivered(ctx, [tr.id], { date: TODAY, receivedBy: "Ramesh", notify: false })).ok);
    page = (await T.publicOrderTracking(t.token))!;
    assert.equal(page.status.delivered, true);
    assert.equal(page.receivedBy, "Ramesh");
    assert.deepEqual(page.unreported, ["Reached Destination Transport Office"], "only what was not reported is named");
    assert.equal(page.entries.some((e) => e.type === "step" && e.step === "at_destination"), false);
    assert.deepEqual(await steps(no), ["at_transport", "confirmed", "delivered", "dispatched", "in_transit", "invoice", "lr", "out_for_delivery", "preparing", "ready"]);
    assert.equal(
      (await orderMessages(no)).filter((m) => m.kind === "confirmed" || m.kind === "invoice" || m.kind === "dispatched").length,
      3,
      "every order step was told exactly once",
    );
    assert.ok((await T.publicOrderTracking(t.token))!.status.lastUpdated, "the page counts opens and says when it changed");
    assert.ok((await tokenOf(no)).opens > 0);

    /* A new link retires the old one, and every consignment link sent before. */
    const fresh = await T.regenerateTracking(ctx, no);
    assert.ok(fresh.ok);
    assert.equal(await T.publicOrderTracking(t.token), null);
    assert.ok(await T.publicOrderTracking(fresh.data.token));
    assert.equal(await T.orderLinkForConsignment(tr.trackToken!), null);
    assert.equal(await T.consignmentLinkRetired(tr.trackToken!), true);
  });

  test("a delivery party that is not the billing party gets its own link, which never shows the invoice", async () => {
    const ctx = await as(admin);
    const o = await takeOrder(6, { delivery: "Ganesh Hardware" });
    assert.equal(o.deliveryCustomerId, "cus_shop");
    assert.ok((await mod("orders").actions!.verifyOrder(ctx, o.id, {})).ok);
    const t = await tokenOf(o.orderNo);
    assert.ok(t.deliveryToken);
    const shop = (await T.publicOrderTracking(t.deliveryToken!))!;
    assert.equal(shop.view, "delivery");
    assert.equal(shop.documents.invoice.available, false);
    assert.equal(shop.documents.invoice.detail, "Sent to the party who placed the order.");
    /* The confirmation is the buyer's alone. */
    const out = await orderMessages(o.orderNo);
    assert.deepEqual(out.map((m) => m.customerId), ["cus_shree"]);
  });

  test("verification taken back withdraws the step; nothing is deleted", async () => {
    const ctx = await as(admin);
    const o = await takeOrder(8);
    assert.ok((await mod("orders").actions!.verifyOrder(ctx, o.id, {})).ok);
    assert.ok((await mod("orders").actions!.unverifyOrder(ctx, o.id, {})).ok);
    assert.deepEqual(await steps(o.orderNo), []);
    const all = await db.select().from(erpOrderMilestones).where(eq(erpOrderMilestones.orderNo, o.orderNo));
    assert.equal(all.length, 2, "the withdrawn rows are kept");
    const page = (await T.publicOrderTracking((await tokenOf(o.orderNo)).token))!;
    assert.equal(page.status.label, "Order received — being checked");
    /* Verified again: the steps come back, and the confirmation is not sent twice. */
    assert.ok((await mod("orders").actions!.verifyOrder(ctx, o.id, {})).ok);
    assert.deepEqual(await steps(o.orderNo), ["confirmed", "preparing"]);
    assert.equal((await orderMessages(o.orderNo)).filter((m) => m.kind === "confirmed").length, 1);
  });

  test("an order already under way is backfilled quietly — a link and its steps, nobody messaged", async () => {
    const o = await takeOrder(9);
    await db.execute(sql`update erp_orders set order_check = 'Verified', order_checked_at = now() - interval '3 days' where order_no = ${o.orderNo}`);
    const r = await T.backfillOrderTracking();
    assert.ok(r.links >= 1);
    const t = await tokenOf(o.orderNo);
    assert.equal(t.backfilled, true);
    assert.deepEqual(await steps(o.orderNo), ["confirmed", "preparing"]);
    assert.equal((await orderMessages(o.orderNo)).length, 0);
    const holds = await db.select().from(erpOrderHolds).where(eq(erpOrderHolds.orderNo, o.orderNo));
    assert.equal(holds.length, 0);
  });
});
