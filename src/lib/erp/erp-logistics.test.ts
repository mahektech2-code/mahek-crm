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
  attachments,
  auditLog,
  bills,
  complaints,
  complaintStatusHistory,
  paymentReceipts,
  customers,
  erpCustomerProfiles,
  erpFgEntries,
  erpOrders,
  erpProductPacking,
  erpRefValues,
  erpTransporterGodowns,
  erpTransporters,
  erpOrderDetails,
  erpTransports,
  erpVideos,
  finishedGoods,
  places,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import * as L from "@/lib/erp/logistics";
import { today as businessToday } from "@/lib/erp/screens/common";
import { erpAudit } from "@/lib/erp/server";
import * as T from "@/lib/erp/trips";
import { createComplaint } from "@/lib/services/complaint-create";
import { impactReport } from "@/lib/impact/registry";
import { IMPACT_FIELD } from "@/lib/impact/types";

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

/** What the impact modal would show, and the confirmation it would send back with the name typed. */
async function confirmed(kind: string, recordId: string) {
  const r = await impactReport(kind, recordId);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return { report: r.data, confirmation: { typed: r.data.confirmWord, fingerprint: r.data.fingerprint } };
}

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;

/** Takes an order of `qty` cans on `date` all the way to dispatch-verified, through the real handlers. */
async function dispatch(date: string, qty: number, bill: string, dispatched: string) {
  const ctx = await as(admin);
  assert.ok((await mod("orders").forms!.new(ctx, { date, godown: "Bhiwandi", billing: "Shree Paints", source: "Phone" }, [{ sku: SKU, qty: String(qty), rate: "300" }])).ok);
  const [o] = await db.select().from(erpOrders).where(sql`${erpOrders.orderDate} = ${date} and ${erpOrders.qtyCans} = ${qty}`);
  /* The back office's order check (0285) is the orders suite's subject; here it has simply passed. */
  await db.execute(sql`update erp_orders set order_check = 'Verified' where order_no = ${o.orderNo}`);
  await mod("orders").actions!.ready(ctx, o.id, {});
  assert.ok((await mod("orders").forms!.allocate(ctx, { lot: "FG1BH", qty: String(qty) }, [], o.id)).ok);
  await mod("orders").forms!.edit(ctx, { status: "Ready", delivery: "Shree Paints", qty: String(qty), rate: "300", bill, transport: "0" }, [], o.id);
  assert.ok((await mod("orders").actions!.bill(ctx, o.id, { invoiceNo: bill, invoiceDate: dispatched })).ok);
  /* Likewise the independent invoice check (0285): approved, so dispatch may go. */
  await db.execute(sql`update erp_order_details set invoice_check = 'Approved' where order_id in (select id from erp_orders where order_no = ${o.orderNo})`);
  assert.ok((await mod("orderDetails").actions!.verify(ctx, o.id, { date: dispatched })).ok);
  return o;
}

before(async () => {
  await db.execute(sql`
    truncate users, customers, erp_customer_profiles, erp_orders, erp_batch_codes, erp_order_details, erp_fg_entries,
             erp_pack_entries, erp_transport_allocations, erp_transport_payments, erp_trips, erp_order_reviews, erp_transports, erp_lrs, erp_transport_events, erp_transport_messages, erp_transporters, erp_requests, erp_followups, erp_credits, erp_expenses, erp_videos,
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
  /* A transporter is on the list before anything may name it: nothing adds one on the way past. */
  await db.insert(erpTransporters).values([{ id: id("etr"), name: "VRL" }, { id: id("etr"), name: "Gati" }]);
  await db.insert(erpFgEntries).values({ id: id("fge"), sourceType: "fill", sourceId: "fin_x", entryDate: "2026-08-01", finishedGoodId: fgId, lotCode: "FG1BH", godownId: "erpg_bhiwandi", quantity: 100, packingType: "Can", skuId });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* Logistics' own messages. Order tracking writes its confirmation, invoice and
   dispatch messages to the same outbox (0292); these tests are about the road. */
const ROAD_KINDS = new Set(["lr", "stage", "issue", "delivered"]);
const roadMessages = async (o?: Parameters<typeof L.messages>[0]) => (await L.messages(o)).filter((m) => ROAD_KINDS.has(m.kind));

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

  test("the bill opens with its boxes, its tracking link and the first line of its timeline", async () => {
    const [t] = await db.select().from(erpTransports);
    assert.equal(t.packages, 10, "ten loose cans are ten packages");
    assert.equal(Number(t.litres), 10);
    assert.match(t.trackToken ?? "", /^[a-z0-9]{20}$/);
    const ev = await L.eventsFor([t.id]);
    assert.deepEqual(ev.map((e) => e.kind), ["opened"]);
    const [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.phase, "toTransport");
  });

  test("the whole road: to the transporter, the LR uploaded and attached, tracked, a problem, delivered — the customer told at each step", async () => {
    const ctx = await as(admin);
    const [t] = await db.select().from(erpTransports);
    assert.ok((await L.setTransportDue(ctx, [t.id], "2026-08-03")).ok);
    assert.ok((await L.markAtTransport(ctx, [t.id], { [t.id]: 1 })).ok);
    let [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.phase, "lrPending");
    assert.equal(c.packages, 1, "the box count logistics corrected");
    assert.equal(msg(await L.markAtTransport(ctx, [t.id])), "None of these is still on its way to the transporter.");

    /* The dispatch team uploads two LRs at once; a number already on the desk is refused. */
    const up = await L.uploadLrs(ctx, [{ lrNo: "lr-7781", lrDate: "2026-08-03", transporter: "VRL", destination: "Pune", packages: 1 }, { lrNo: "LR-9", transporter: "VRL" }]);
    assert.ok(up.ok, msg(up));
    assert.equal(msg(await L.uploadLrs(ctx, [{ lrNo: "LR-7781", transporter: "vrl" }])), "Row 1: LR LR-7781 of VRL is already uploaded");
    assert.equal(msg(await L.uploadLrs(ctx, [{ lrNo: " " }])), "Fill in at least one LR — a photo is enough.");
    const lrs = await L.uploadedLrs();
    assert.equal(lrs.length, 2);
    const lr = lrs.find((l) => l.lrNo === "LR-7781")!;
    assert.equal(L.suggestBills(lr, await L.consignments())[0].id, t.id);
    /* Voiding asks first: the bare act is refused, and the modal names the LR leaving the desk. */
    const nine = lrs.find((l) => l.lrNo === "LR-9")!;
    assert.equal(msg(await L.voidLr(ctx, nine.id, "duplicate photo")), "Check what this affects and confirm it first.");
    const voiding = await confirmed("erp-lr-void", nine.id);
    assert.equal(voiding.report.confirmWord, "LR-9");
    assert.ok(voiding.report.items.some((i) => i.effect === "changed" && /leaves the Documents desk/.test(i.label)), JSON.stringify(voiding.report.items));
    assert.ok((await L.voidLr(ctx, nine.id, "duplicate photo", voiding.confirmation)).ok);
    /* A name that is not on the list is refused — on an upload and on an edit — and the list does not grow. */
    const listed = (await db.select().from(erpTransporters)).length;
    const unlisted = await L.uploadLrs(ctx, [{ lrNo: "LR-x1", transporter: "The Great India Transport" }]);
    assert.equal(unlisted.ok, false);
    assert.match(msg(unlisted), /^Row 1: "The Great India Transport" is not on the transporter list/);
    assert.equal(msg(await L.editLr(ctx, lr.id, { lrNo: "LR-7781", transporter: "VRL Logistcs" })).includes("not on the transporter list"), true);
    assert.equal((await db.select().from(erpTransporters)).length, listed, "nothing typed or uploaded adds a transporter");
    /* The same name in other capitals, spacing or "Pvt Ltd" is the listed one, saved as the list spells it. */
    const spelled = await L.uploadLrs(ctx, [{ lrNo: "LR-x2", transporter: "  gati pvt. ltd " }]);
    assert.ok(spelled.ok, msg(spelled));
    assert.equal((await L.uploadedLrs()).find((l) => l.lrNo === "LR-X2")?.transporter, "Gati");
    for (const sid of spelled.ok ? spelled.data.ids : []) assert.ok((await L.voidLr(ctx, sid, "test row", (await confirmed("erp-lr-void", sid)).confirmation)).ok);

    /* No field is required: two LRs with no number from one transporter both land, an empty row is skipped,
       and one with no number cannot be attached until logistics types it off the photo. */
    const bare = await L.uploadLrs(ctx, [{ transporter: "Gati" }, {}, { transporter: "Gati", note: "photo only" }]);
    assert.ok(bare.ok, msg(bare));
    const numberless = (await L.uploadedLrs()).filter((l) => !l.lrNo);
    assert.equal(numberless.length, 2);
    assert.equal(msg(await L.attachLr(ctx, numberless[0].id, [t.id], {})), "Type the LR number off the photo first (Edit) — the customer is told it.");
    assert.ok((await L.editLr(ctx, numberless[0].id, { lrNo: "G-1", transporter: "Gati" })).ok);
    for (const l of numberless) assert.ok((await L.voidLr(ctx, l.id, "test rows", (await confirmed("erp-lr-void", l.id)).confirmation)).ok);

    /* Logistics attaches it: the bill goes on the road and the party is told. */
    const att = await L.attachLr(ctx, lr.id, [t.id], { expectedOn: "2026-08-06" });
    assert.ok(att.ok, msg(att));
    [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.phase, "onRoad");
    assert.equal(c.lrNo, "LR-7781");
    assert.equal(c.stage, "In Transit");
    assert.equal(c.expectedDeliveryOn, "2026-08-06");
    assert.ok(c.nextCallOn, "the next call to the transporter is booked");
    let out = await roadMessages();
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "lr");
    assert.equal(out[0].status, "to_send", "no Wati template is named, so it waits to be sent by hand");
    assert.match(out[0].why ?? "", /No logistics template/);
    assert.match(out[0].body, /LR no LR-7781/);
    assert.match(out[0].body, /1 box\./);
    assert.equal(out[0].phone, "919876500001");
    assert.equal(msg(await L.attachLr(ctx, lr.id, [t.id], {})), "These bills are already under this LR.");
    assert.ok((await L.markMessageSent(ctx, out[0].id)).ok);
    assert.equal((await roadMessages({ waitingOnly: true })).length, 0);

    /* A call that moves nothing books the next one and tells nobody; a stage that moves is shared. */
    assert.ok((await L.updateConsignment(ctx, [t.id], { note: "driver on leave" })).ok);
    assert.equal((await roadMessages()).length, 1);
    assert.ok((await L.updateConsignment(ctx, [t.id], { stage: "Reached Destination Area", note: "at Pune godown" })).ok);
    out = await roadMessages();
    assert.equal(out.length, 2);
    assert.match(out[0].body, /has reached your area/);
    assert.equal(msg(await L.updateConsignment(ctx, [t.id], { stage: "Close - Received to Party" })), "Pick where the goods are");

    /* 0296 — the route: the godown it left from, the cities since (each dated), where it is going, and a pickup. */
    assert.match(msg(await L.updateConsignment(ctx, [t.id], { cities: [{ city: "Pune", on: "2026-08-01" }] })), /the goods left on Sun 2 Aug/);
    const routed = await L.updateConsignment(ctx, [t.id], {
      dispatchedFrom: "  Kerala Roadways  Bhiwandi ",
      cities: [
        { city: "Indore", on: "2026-08-04" },
        { city: "Nashik", on: "2026-08-03" },
      ],
      destination: "Vadakara",
    });
    assert.ok(routed.ok, msg(routed));
    [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.dispatchedFrom, "Kerala Roadways Bhiwandi");
    assert.deepEqual(
      c.route.map((r) => [r.kind, r.city]),
      [
        ["dispatched", "Kerala Roadways Bhiwandi"],
        ["checkpoint", "Nashik"],
        ["checkpoint", "Indore"],
      ],
      "it left the godown before the first city, and the cities read in the order they were reached",
    );
    assert.equal(c.currentCity, "Indore");
    assert.equal(c.destination, "Vadakara");
    out = await roadMessages();
    assert.equal(out.length, 3, "a new city is news, so the customer is told");
    assert.match(out[0].body, /Reached Indore on Tue 4 Aug/);
    assert.ok((await L.updateConsignment(ctx, [t.id], { cities: [{ city: "Kozhikode", on: businessToday() }] })).ok);
    [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.currentCity, "Kozhikode");
    assert.equal(msg(await L.updateConsignment(ctx, [t.id], { stage: "Ready for Pickup" })), "Say where the party collects it — the transporter's office and its area");
    const pickup = await L.updateConsignment(ctx, [t.id], { stage: "Ready for Pickup", pickupPoint: "Kerala Roadways, Vadakara office", pickupContact: "Suresh 9876500009" });
    assert.ok(pickup.ok, msg(pickup));
    [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.stage, "Ready for Pickup");
    assert.equal(c.pickupPoint, "Kerala Roadways, Vadakara office");
    out = await roadMessages();
    assert.match(out[0].body, /ready for you to collect/);
    assert.match(out[0].body, /Collect it from: Kerala Roadways, Vadakara office \(Suresh 9876500009\)/);
    assert.ok((await L.updateConsignment(ctx, [t.id], { destination: "" })).ok);
    [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.destination, c.lrDestination, "an emptied destination goes back to the LR's own");

    /* A problem, solved. */
    assert.equal(msg(await L.raiseIssue(ctx, [t.id], { issue: "Other" })), "Say what the problem is");
    assert.ok((await L.raiseIssue(ctx, [t.id], { issue: "Delayed", note: "lorry broke down", notify: false })).ok);
    [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.issue, "Delayed");
    assert.ok((await L.clearIssue(ctx, [t.id], "repaired")).ok);

    /* Delivered: closed, the party told, the book follows. */
    assert.equal(msg(await L.markDelivered(ctx, [t.id], { date: "2026-08-01" })), `Order ${t.orderNo} left on 2026-08-02; it cannot arrive before that`);
    assert.ok((await L.markDelivered(ctx, [t.id], { date: "2026-08-05", receivedBy: "Ramesh" })).ok);
    [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.phase, "delivered");
    assert.equal(c.nextCallOn, null);
    assert.match((await roadMessages())[0].body, /received by Ramesh/);
    assert.equal(msg(await L.detachLr(ctx, t.id, "wrong bill")), "A delivered bill keeps its LR.");

    /* The customer's link names the steps and never a call note. */
    const pub = await L.publicTracking(c.trackToken!);
    assert.ok(pub);
    assert.equal(pub.lrNo, "LR-7781");
    assert.equal(pub.stage, "Close - Received to Party");
    assert.ok(!JSON.stringify(pub).includes("driver on leave"));
    assert.ok(!JSON.stringify(pub).includes("lorry broke down"));
    assert.equal(await L.publicTracking("nope"), null);

    /* Reopened by mistake: back on the road with a call due today, nobody messaged. While the LR still
       carries it, voiding that LR is refused — and the modal says so before anybody types its number. */
    const carrying = await confirmed("erp-lr-void", lr.id);
    assert.match(carrying.report.blockers[0] ?? "", /attached to 1 bill/);
    assert.equal(msg(await L.reopen(ctx, t.id, "party says short")), "Check what this affects and confirm it first.");
    const reopening = await confirmed("erp-delivery-reopen", t.id);
    assert.equal(reopening.report.confirmWord, String(t.orderNo));
    assert.ok(reopening.report.items.some((i) => i.label === "delivery record cleared" && /received by Ramesh/.test(i.note ?? "")), JSON.stringify(reopening.report.items));
    assert.ok(reopening.report.items.some((i) => i.effect === "kept" && /still waiting to be sent/.test(i.label)), "the delivered message nobody sent still says delivered");
    assert.ok((await L.reopen(ctx, t.id, "party says short", reopening.confirmation)).ok);
    [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.phase, "onRoad");
    assert.ok((await L.detachLr(ctx, t.id, "wrong bill")).ok);
    [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.phase, "lrPending");
    assert.equal((await L.uploadedLrs()).length, 1, "an LR left carrying nothing is back on the desk");
    assert.ok((await L.attachLr(ctx, lr.id, [t.id], { notify: false })).ok);
    assert.ok((await L.markDelivered(ctx, [t.id], { date: "2026-08-05", notify: false })).ok);
  });

  test("a customer who may not be messaged is recorded as skipped, with the reason", async () => {
    const ctx = await as(admin);
    await db.update(customers).set({ whatsappDnd: true }).where(eq(customers.id, "cus_shree"));
    const [t] = await db.select().from(erpTransports);
    await L.notifyCustomers(ctx, "stage", [t.id], null);
    const [m] = await roadMessages();
    assert.equal(m.status, "skipped");
    assert.match(m.why ?? "", /DND/);
    await db.update(customers).set({ whatsappDnd: false }).where(eq(customers.id, "cus_shree"));
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

  test("an extra expense entered on Orders → Billing & dispatch reaches the transport record too", async () => {
    /* Orders had its own copy of the writer, and it skipped the transport record. */
    const ctx = await as(admin);
    await db.update(erpOrderDetails).set({ extraExpensesPaise: null });
    await db.update(erpTransports).set({ extraExpensePaise: null });
    const { rows } = await mod("orderDetails").load(ctx);
    const res = await mod("orderDetails").actions!.extra(ctx, rows[0].id, { amount: "125" });
    assert.ok(res.ok, JSON.stringify(res));
    const [t] = await db.select().from(erpTransports);
    assert.equal(t.extraExpensePaise, 12500);
  });
});

describe("reading an LR photo into the upload form", () => {
  test("the model is told each transporter's label and earlier numbers, and a reading is settled against what was uploaded", async () => {
    const ctx = await as(admin);
    await db.insert(erpTransporters).values({ id: id("etr"), name: `Maruti ${tag}`, consignmentLabel: "GR Number", updatedById: admin.id }).onConflictDoNothing();
    assert.ok((await L.uploadLrs(ctx, [{ lrNo: `77${tag.replace(/\D/g, "1").slice(0, 3)}01`, transporter: `Maruti ${tag}` }])).ok);
    const { lrStyles, settleLrReadings } = await import("@/lib/erp/lr-upload-read");
    const style = (await lrStyles()).find((t) => t.name === `Maruti ${tag}`)!;
    assert.equal(style.label, "GR Number");
    assert.equal(style.examples.length, 1, "its earlier number is its style");

    const { logSuggestion } = await import("@/lib/erp/ai");
    const { erpAiSuggestions } = await import("@/db/schema");
    const proposed = { lrNo: "GR-501", lrDate: "2026-08-03", transporter: `Maruti ${tag}`, destination: "Pune", packages: 4, freightTerm: "To pay", freightRupees: null };
    const accepted = await logSuggestion({ feature: "photos", recordType: "erp_lr", proposed, userId: ctx.actor.id });
    const edited = await logSuggestion({ feature: "photos", recordType: "erp_lr", proposed: { ...proposed, lrNo: "GR-5O2" }, userId: ctx.actor.id });
    const up = await L.uploadLrs(ctx, [
      { ...proposed, readingId: accepted },
      { ...proposed, lrNo: "GR-502", readingId: edited },
    ]);
    assert.ok(up.ok, msg(up));
    const [a1] = await db.select().from(erpAiSuggestions).where(eq(erpAiSuggestions.id, accepted));
    const [e1] = await db.select().from(erpAiSuggestions).where(eq(erpAiSuggestions.id, edited));
    assert.equal(a1.outcome, "accepted");
    assert.equal(a1.recordId, up.ok ? up.data.ids[0] : null, "the reading points at the LR it became");
    assert.equal(e1.outcome, "edited", "the person corrected the number");

    /* A reading is settled once, and only by the person it was read for. */
    await settleLrReadings(ctx, [{ readingId: accepted, lrId: "elr_other", final: {} }]);
    assert.equal((await db.select().from(erpAiSuggestions).where(eq(erpAiSuggestions.id, accepted)))[0].recordId, a1.recordId);
  });
});

describe("complaints and credit notes are the CRM's complaints", () => {
  test("a credit-note request names a real bill and goods on it, lands as a CRM complaint, and only the office decides", async () => {
    /* The ERP is not live here, so the bill is one the sheet wrote — the bills Accounts credits against. */
    await db.insert(bills).values({ id: "bil_mmi1", customerId: "cus_shree", billNo: "MMI/26-27/1", billDate: "2026-08-02", amount: 354000, paymentPosition: "stated" });
    const c = await as(clerk);
    assert.equal(msg(await mod("requests").forms!.new(c, { customer: "Shree Paints", description: "Two cans leaked", cn: "Yes", bill: "NOPE" }, [])), "That is not one of this customer's bills");
    assert.ok((await mod("requests").forms!.new(c, { salesman: "Ravi Sales", customer: "Shree Paints", type: "Leakage / Packaging", description: "Two cans leaked", cn: "Yes", bill: "MMI/26-27/1", goods: SKU }, [])).ok);
    const [r] = await db.select().from(complaints);
    assert.equal(r.customerId, "cus_shree");
    assert.equal(r.category, "product_quality", "the ERP raises product quality complaints only, whatever type is posted");
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

  test("a complaint of any other type is the CRM's: the ERP neither lists it nor acts on it", async () => {
    const a = await as(admin);
    await createComplaint({ id: "cmp_bill", customerId: "cus_shree", loggedById: a.user.id, loggedByName: a.user.name, category: "Billing Issue", description: "Wrong GST on the bill" });
    for (const s of ["requests", "issueCn", "complaints"]) assert.ok(!(await mod(s).load(a)).rows.some((x) => x.id === "cmp_bill"), s);
    assert.equal(msg(await mod("requests").actions!.accept(a, "cmp_bill", {})), "That complaint is not a product quality complaint, so the ERP does not handle it.");
    await db.delete(complaintStatusHistory).where(eq(complaintStatusHistory.complaintId, "cmp_bill"));
    await db.delete(complaints).where(eq(complaints.id, "cmp_bill"));
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

describe("transporters", () => {
  test("a godown is a state, district, city and area with its own GST number; an unlisted rung is added once; a new consignment name joins the list", async () => {
    const ctx = await as(admin);
    const di = id("plc"), ci = id("plc"), ar = id("plc"), di2 = id("plc");
    /* The state is the real one: a godown's GST number is checked against its NAME. */
    await db.insert(places).values({ id: id("plc"), kind: "state", name: "Maharashtra", key: "maharashtra", parentId: null }).onConflictDoNothing();
    const [mh] = await db.select().from(places).where(sql`${places.kind} = 'state' and ${places.key} = 'maharashtra' and ${places.parentId} is null`);
    const st = mh.id;
    await db.insert(places).values([
      { id: di, kind: "district", name: `Tdist ${tag}`, key: `tdist${tag}`, parentId: st },
      { id: ci, kind: "city", name: `Tcity ${tag}`, key: `tcity${tag}`, parentId: di },
      { id: ar, kind: "area", name: `Tarea ${tag}`, key: `tarea${tag}`, parentId: ci },
      { id: di2, kind: "district", name: `Udist ${tag}`, key: `udist${tag}`, parentId: st },
    ]);
    const MH = "27AAPCS1234A1ZN";
    const full = { state: { id: mh.id }, district: { id: di }, city: { id: ci }, area: { id: ar } };

    assert.equal(msg(await L.saveTransporter(ctx, { name: `Road ${tag}`, gstin: "27ABCDE1234F1Z9" })), "That GST number does not check out — it is 15 characters, like 27ABCDE1234F1Z5");
    assert.equal(msg(await L.saveTransporter(ctx, { name: `Road ${tag}`, godowns: [{ label: "Main" }] })), "Main: Pick the state");
    assert.equal(msg(await L.saveTransporter(ctx, { name: `Road ${tag}`, godowns: [{ label: "Main", place: { ...full, area: undefined } }] })), "Main: Pick the area, or add it if it is not listed");
    assert.match(msg(await L.saveTransporter(ctx, { name: `Road ${tag}`, godowns: [{ label: "Main", place: full, gstin: "24AAPCS1234A1ZT" }] })), /registered in Gujarat, but the godown is in Maharashtra/);
    assert.equal(
      msg(await L.saveTransporter(ctx, { name: `Road ${tag}`, godowns: [{ place: full, gstin: MH, contacts: [{ name: "Ravi", phones: ["9820011001", "9820011002", "9820011003", "9820011004"] }] }] })),
      "A person takes up to 3 numbers",
    );
    assert.equal(msg(await L.saveTransporter(ctx, { name: `Road ${tag}`, godowns: [{ place: full, gstin: MH, lat: 19.2, lng: null }] })), "A pin is a latitude and a longitude — give both, or neither");

    /* The second godown's city and area are not listed: they are added under the picked district. */
    const added = { state: { id: mh.id }, district: { id: di2 }, city: { name: `Vcity ${tag}` }, area: { name: `Varea ${tag}` } };
    const godowns = [
      { label: "Main godown", place: full, gstin: MH, lat: 19.2094, lng: 73.0939, address: "Plot 4", contacts: [{ name: "Ravi", role: "Booking", phones: ["9820011001", "", "022 2567 1234"] }, { name: "Asha", phones: ["9820011009"] }] },
      { place: added, gstin: MH.toLowerCase(), contacts: [{ name: " ", phones: [""] }] },
    ];
    assert.ok((await L.saveTransporter(ctx, { name: `Road ${tag}`, gstin: "27aapcs1234a1zn", consignmentLabel: "  docket   number ", godowns })).ok);
    const [t] = await db.select().from(erpTransporters).where(eq(erpTransporters.name, `Road ${tag}`));
    assert.equal(t.gstin, MH);
    assert.equal(t.consignmentLabel, "docket number");
    assert.deepEqual([t.contactPerson, t.phone, t.altPhone], ["Ravi", "9820011001", "022 2567 1234"]);
    const list = await db.select().from(erpRefValues).where(sql`${erpRefValues.listKey} = 'consignmentLabel' and lower(${erpRefValues.value}) = 'docket number'`);
    assert.equal(list.length, 1);
    const read = (await L.transporters()).find((x) => x.id === t.id)!;
    assert.deepEqual(read.godowns.map((g) => [g.label, g.gstin, g.lat, g.contacts.length]), [["Main godown", MH, 19.2094, 2], [null, MH, null, 0]]);
    assert.equal(read.godowns[0].placeId, ar);
    const [vArea] = await db.select().from(places).where(eq(places.id, read.godowns[1].placeId!));
    const [vCity] = await db.select().from(places).where(eq(places.id, vArea.parentId!));
    assert.deepEqual([vArea.kind, vArea.name, vCity.kind, vCity.name, vCity.parentId], ["area", `Varea ${tag}`, "city", `Vcity ${tag}`, di2]);

    /* Typing the same city again, any spelling, files under the one already added. */
    const again = { ...added, city: { name: `VCITY  ${tag}`.toLowerCase() }, area: { name: `Warea ${tag}` } };
    assert.ok((await L.saveTransporter(ctx, { id: t.id, name: `Road ${tag}`, godowns: [...read.godowns.map((g) => ({ ...g, place: undefined })), { place: again, gstin: MH }] })).ok);
    const cities = await db.select().from(places).where(sql`${places.kind} = 'city' and ${places.parentId} = ${di2}`);
    assert.equal(cities.length, 1);

    /* Leaving godowns out leaves them alone; saving them back keeps their ids; a godown taken off goes with its people. */
    assert.ok((await L.saveTransporter(ctx, { id: t.id, name: `Road ${tag}`, consignmentLabel: "gr number" })).ok);
    const [row] = await db.select().from(erpTransporters).where(eq(erpTransporters.id, t.id));
    assert.equal(row.consignmentLabel, "GR Number");
    assert.equal((await db.select().from(erpTransporterGodowns).where(eq(erpTransporterGodowns.transporterId, t.id))).length, 3);
    const keep = read.godowns[0];
    assert.ok((await L.saveTransporter(ctx, { id: t.id, name: `Road ${tag}`, godowns: [{ ...keep, contacts: keep.contacts.slice(1) }] })).ok);
    const after = (await L.transporters()).find((x) => x.id === t.id)!;
    assert.deepEqual(after.godowns.map((g) => g.id), [keep.id]);
    assert.deepEqual(after.godowns[0].contacts.map((c) => c.id), [keep.contacts[1].id]);
    assert.equal(after.contactPerson, "Asha");
  });
});



describe("renaming and merging a transporter carries the name everywhere it is written", () => {
  test("a rename rewrites bills, LRs and party defaults in any case, and is refused until confirmed", async () => {
    const ctx = await as(admin);
    const old = `Swift ${tag}`;
    assert.ok((await L.saveTransporter(ctx, { name: old })).ok);
    const [t] = await db.select().from(erpTransporters).where(eq(erpTransporters.name, old));
    await db.insert(erpTransports).values({ id: id("tr"), orderNo: 90001, billingCustomerId: "cus_shree", transporter: old.toUpperCase() });
    await db.execute(sql`insert into erp_lrs (id, lr_no, transporter) values (${id("lr")}, ${`R${tag}`}, ${` ${old} `})`);
    await db.update(erpCustomerProfiles).set({ transporter: old.toLowerCase() }).where(eq(erpCustomerProfiles.customerId, "cus_shree"));

    const renamed = `Swift Roadways ${tag}`;
    assert.equal((await L.saveTransporter(ctx, { id: t.id, name: renamed })).ok, false, "a rename is confirmed first");
    const { report, confirmation } = await confirmed("erp-transporter-rename", `${t.id}|${renamed}`);
    assert.deepEqual(report.items.map((i) => [i.label, i.count]).sort(), [["LR", 1], ["bill", 1], ["party using it as their transporter", 1]]);
    assert.ok((await L.saveTransporter(ctx, { id: t.id, name: renamed, confirmation })).ok);

    const [bill] = (await db.execute(sql`select transporter from erp_transports where order_no = 90001`)) as unknown as { transporter: string }[];
    assert.equal(bill.transporter, renamed);
    const [lr] = (await db.execute(sql`select transporter from erp_lrs where lr_no = ${`R${tag}`}`)) as unknown as { transporter: string }[];
    assert.equal(lr.transporter, renamed);
    const [p] = await db.select().from(erpCustomerProfiles).where(eq(erpCustomerProfiles.customerId, "cus_shree"));
    assert.equal(p.transporter, renamed);
    await db.update(erpCustomerProfiles).set({ transporter: "VRL" }).where(eq(erpCustomerProfiles.customerId, "cus_shree"));
  });

  test("renaming onto a name already in the list is blocked and points at Merge into", async () => {
    const ctx = await as(admin);
    assert.ok((await L.saveTransporter(ctx, { name: `Alpha ${tag}` })).ok);
    assert.ok((await L.saveTransporter(ctx, { name: `Beta ${tag}` })).ok);
    const [a] = await db.select().from(erpTransporters).where(eq(erpTransporters.name, `Alpha ${tag}`));
    const r = await impactReport("erp-transporter-rename", `${a.id}|beta ${tag}`);
    assert.ok(r.ok);
    assert.match(r.data.blockers[0], /Merge into/);
  });

  test("a merge rewrites the dropped spelling, moves its godowns and drops its row; clashing LR numbers block it", async () => {
    const ctx = await as(admin);
    const dup = `V.R.L. ${tag}`;
    const keep = `VRL Logistics ${tag}`;
    assert.ok((await L.saveTransporter(ctx, { name: dup })).ok);
    assert.ok((await L.saveTransporter(ctx, { name: keep })).ok);
    const [from] = await db.select().from(erpTransporters).where(eq(erpTransporters.name, dup));
    const [into] = await db.select().from(erpTransporters).where(eq(erpTransporters.name, keep));
    await db.insert(erpTransporterGodowns).values({ id: id("etg"), transporterId: from.id, label: "Hub" });
    await db.insert(erpTransports).values({ id: id("tr"), orderNo: 90002, billingCustomerId: "cus_shree", transporter: dup });
    await db.execute(sql`insert into erp_lrs (id, lr_no, transporter) values (${id("lr")}, ${`M${tag}`}, ${dup}), (${id("lr")}, ${`M${tag}`}, ${keep})`);

    const key = `${from.id}>${into.id}`;
    const blocked = await impactReport("erp-transporter-merge", key);
    assert.ok(blocked.ok);
    assert.match(blocked.data.blockers[0], /LRs numbered/);
    await db.execute(sql`update erp_lrs set status = 'void' where lr_no = ${`M${tag}`} and transporter = ${keep}`);

    const godownsBefore = (await db.select().from(erpTransporterGodowns).where(eq(erpTransporterGodowns.transporterId, from.id))).length;
    const { confirmation } = await confirmed("erp-transporter-merge", key);
    assert.ok((await L.mergeTransporter(ctx, from.id, into.id, confirmation)).ok);
    assert.equal((await db.select().from(erpTransporters).where(eq(erpTransporters.id, from.id))).length, 0);
    assert.equal((await db.select().from(erpTransporterGodowns).where(eq(erpTransporterGodowns.transporterId, into.id))).length, godownsBefore);
    const [bill] = (await db.execute(sql`select transporter from erp_transports where order_no = 90002`)) as unknown as { transporter: string }[];
    assert.equal(bill.transporter, keep);
  });
});

describe("every dispatch reaches Logistics (0279)", () => {
  const lot = `FGD${tag}`;
  let fgId = "";
  let skuId = "";
  before(async () => {
    const [p] = await db.select().from(products).where(eq(products.name, SKU));
    skuId = p.id;
    fgId = p.finishedGoodId!;
    await db.insert(erpFgEntries).values({ id: id("fge"), sourceType: "fill", sourceId: `fin_${tag}`, entryDate: "2026-08-01", finishedGoodId: fgId, lotCode: lot, godownId: "erpg_bhiwandi", quantity: 200, packingType: "Can", skuId });
  });

  /** An order of one line per quantity, every line allocated and billed — not yet verified. */
  async function billed(date: string, qtys: number[], bill: string) {
    const ctx = await as(admin);
    assert.ok((await mod("orders").forms!.new(ctx, { date, godown: "Bhiwandi", billing: "Shree Paints", source: "Phone" }, qtys.map((q) => ({ sku: SKU, qty: String(q), rate: "300" })))).ok);
    const ls = await db.select().from(erpOrders).where(sql`${erpOrders.orderDate} = ${date}`).orderBy(erpOrders.createdAt);
    /* The order check and the invoice check (0285) are the orders suite's subject; here both have passed. */
    await db.execute(sql`update erp_orders set order_check = 'Verified' where order_no = ${ls[0].orderNo}`);
    for (const o of ls) {
      await mod("orders").actions!.ready(ctx, o.id, {});
      assert.ok((await mod("orders").forms!.allocate(ctx, { lot, qty: String(o.qtyCans) }, [], o.id)).ok);
    }
    /* One order is one bill: billing records the invoice against the whole order. */
    assert.equal(msg(await mod("orders").actions!.bill(ctx, ls[0].id, { invoiceNo: bill, invoiceDate: date })), "ok");
    await db.execute(sql`update erp_order_details set invoice_check = 'Approved' where order_id in (select id from erp_orders where order_no = ${ls[0].orderNo})`);
    return ls;
  }
  const lineOf = async (orderId: string) => (await db.select().from(erpOrderDetails).where(eq(erpOrderDetails.orderId, orderId)))[0];

  test("an order number that already carries a closed row from the history still opens a consignment", async () => {
    const [o] = await billed("2026-09-01", [4], "MMI/26-27/901");
    /* The Taken Order history's row for the same number: delivered long ago. */
    await db.insert(erpTransports).values({ id: id("legacy"), orderNo: o.orderNo, billDate: "2025-01-05", billingCustomerId: "cus_shree", billNo: "OLD/1", materialStage: "Close - Received to Party", deliveredOn: "2025-01-09" });
    const ctx = await as(admin);
    assert.equal(msg(await mod("orderDetails").actions!.verify(ctx, o.id, { date: "2026-09-02" })), "ok");
    const rows = await db.select().from(erpTransports).where(eq(erpTransports.orderNo, o.orderNo));
    assert.equal(rows.length, 2, "the old row stays and a new one opens");
    const fresh = rows.find((t) => t.billDate === "2026-09-02")!;
    assert.equal((await lineOf(o.id)).transportId, fresh.id);
    assert.equal(fresh.packages, 4);
    const [c] = await L.consignments({ ids: [fresh.id] });
    assert.equal(c.phase, "toTransport");
    assert.ok((await L.consignments()).some((x) => x.id === fresh.id), "it is on the board");
  });

  test("an order leaves whole: verifying any of its lines verifies every billed line, on one consignment", async () => {
    /* PRD rule 1 — one order is one complete bill — and rule 2: what cannot go now is moved to a new
       linked order, so an order is never sent in two goes and never opens a second consignment. */
    const [a, b, c] = await billed("2026-09-03", [3, 5, 2], "MMI/26-27/902");
    const ctx = await as(admin);
    assert.equal(msg(await mod("orderDetails").bulk!.verify(ctx, [a.id], { date: "2026-09-04" })), "ok");
    const first = (await lineOf(a.id)).transportId!;
    assert.ok(first);
    assert.equal((await lineOf(b.id)).transportId, first);
    assert.equal((await lineOf(c.id)).transportId, first);
    assert.equal((await db.select().from(erpTransports).where(eq(erpTransports.id, first)))[0].packages, 10);
    assert.deepEqual(
      (await L.billLines(a.orderNo, first)).map((l) => l.id).sort(),
      [a.id, b.id, c.id].sort(),
    );
  });

  test("the rest of an order already gone is not verified a second time", async () => {
    const [a, b] = await billed("2026-09-06", [1, 1], "MMI/26-27/903");
    const ctx = await as(admin);
    assert.equal(msg(await mod("orderDetails").actions!.verify(ctx, a.id, { date: "2026-09-07" })), "ok");
    assert.equal((await lineOf(a.id)).transportId, (await lineOf(b.id)).transportId);
    assert.notEqual(msg(await mod("orderDetails").actions!.verify(ctx, b.id, { date: "2026-09-07" })), "ok");
    assert.equal((await db.select().from(erpTransports).where(eq(erpTransports.orderNo, a.orderNo))).length, 1);
  });

  test("a verified line on no consignment is caught by the sync, once", async () => {
    const { syncDispatchedTransports } = await import("@/lib/erp/screens/sales");
    const [o] = await billed("2026-09-08", [6], "MMI/26-27/904");
    const ctx = await as(admin);
    assert.equal(msg(await mod("orderDetails").actions!.verify(ctx, o.id, { date: "2026-09-09" })), "ok");
    /* As though the hand-over never happened. */
    const tid = (await lineOf(o.id)).transportId!;
    await db.execute(sql`delete from erp_transport_events where transport_id = ${tid}`);
    await db.delete(erpTransports).where(eq(erpTransports.id, tid));
    await db.update(erpOrderDetails).set({ transportId: null }).where(eq(erpOrderDetails.orderId, o.id));
    assert.equal(await syncDispatchedTransports(null, 3650), 1);
    const back = (await lineOf(o.id)).transportId!;
    const [t] = await db.select().from(erpTransports).where(eq(erpTransports.id, back));
    assert.equal(t.billDate, "2026-09-09", "dated its own dispatch");
    assert.equal(t.packages, 6);
    assert.deepEqual((await L.eventsFor([t.id])).map((e) => e.kind), ["opened"]);
    assert.equal(await syncDispatchedTransports(null, 3650), 0, "nothing left to hand over");
  });
});

describe("vehicle trips and the transport payment shared by litres (Order-to-Delivery PRD 10–12)", () => {
  /** A bill record as dispatch leaves it, written straight in: these tests are about what Logistics does next. */
  async function bill(orderNo: number, party: string, litres: number | null) {
    const tid = id("etrn");
    await db.insert(erpTransports).values({ id: tid, orderNo, billDate: "2026-09-10", billingCustomerId: party, billNo: `MMI/T/${orderNo}`, litres, materialStage: "Dispatched" });
    return tid;
  }

  test("dispatch names a vehicle: bills of two customers on one vehicle one day share a trip; another day or no vehicle does not", async () => {
    await db.insert(customers).values({ id: "cus_om", name: "Om Hardware", city: "Pune", phone: "9876500002", kind: "customer" }).onConflictDoNothing();
    const a = await bill(9101, "cus_shree", 250);
    const b = await bill(9102, "cus_om", 500);
    const c = await bill(9103, "cus_shree", 250);
    const d = await bill(9104, "cus_om", 40);
    await db.transaction((tx) =>
      T.assignTripsAtDispatch(
        tx,
        [
          { transportId: a, date: "2026-09-10", vehicleNo: "MH04 AB 1234", driver: "Sunil", transporter: "VRL" },
          { transportId: b, date: "2026-09-10", vehicleNo: "mh04ab1234", driver: null, transporter: null },
          { transportId: c, date: "2026-09-11", vehicleNo: "MH04 AB 1234", driver: null, transporter: null },
          { transportId: d, date: "2026-09-10", vehicleNo: null, driver: null, transporter: null },
        ],
        admin.id,
      ),
    );
    const rows = await db.select().from(erpTransports).where(sql`${erpTransports.orderNo} between 9101 and 9104`);
    const byNo = new Map(rows.map((r) => [r.orderNo, r]));
    assert.ok(byNo.get(9101)!.tripId);
    assert.equal(byNo.get(9101)!.tripId, byNo.get(9102)!.tripId, "same vehicle, same day: one trip for both customers");
    assert.notEqual(byNo.get(9103)!.tripId, byNo.get(9101)!.tripId, "the next day is another trip");
    assert.equal(byNo.get(9104)!.tripId, null, "no vehicle, no trip");
    assert.equal(byNo.get(9102)!.vehicleNo, "mh04ab1234");
    const missing = await T.billsWithoutTrip(3650);
    assert.ok(missing.some((x) => x.id === d));
  });

  test("₹1,000 over 1,000 L is shared ₹250 / ₹500 / ₹250; the same bills cannot be shared twice; reversing frees them", async () => {
    const ctx = await as(admin);
    const x = await bill(9201, "cus_shree", 250);
    const y = await bill(9202, "cus_om", 500);
    const z = await bill(9203, "cus_shree", 250);
    assert.match(msg(await T.saveTrip(ctx, { tripDate: "2026-09-12", vehicleNo: "MH12 XY 9", transporter: "Unlisted Tempo", transportIds: [x, y, z] })), /not on the transporter list/);
    const made = await T.saveTrip(ctx, { tripDate: "2026-09-12", vehicleNo: "MH12 XY 9", transporter: "VRL", transportIds: [x, y, z] });
    assert.ok(made.ok, msg(made));
    const tripId = made.ok ? made.data.id : "";

    const part = await T.recordTransportPayment(ctx, { tripId, amountPaise: 100000, transportIds: [x, y] });
    assert.equal(part.ok, false, "a payment for part of the trip must say which part");

    const paid = await T.recordTransportPayment(ctx, { tripId, amountPaise: 100000, paidOn: "2026-09-12", paidTo: "VRL", reference: "UTR1", transportIds: [x, y, z] });
    assert.ok(paid.ok, msg(paid));
    const shares = (await db.execute(sql`select transport_id as t, amount_paise as a from erp_transport_allocations where not reversed`)) as unknown as { t: string; a: number }[];
    const share = new Map(shares.map((r) => [r.t, Number(r.a)]));
    assert.deepEqual([share.get(x), share.get(y), share.get(z)], [25000, 50000, 25000]);

    const again = await T.recordTransportPayment(ctx, { tripId, amountPaise: 5000, transportIds: [x] , scope: "again"});
    assert.equal(again.ok, false);
    assert.match(msg(again), /already carries a transport payment/);

    const move = await T.removeFromTrip(ctx, x);
    assert.equal(move.ok, false, "a bill carrying a share stays on its trip");
    assert.match((await confirmed("erp-trip-bill", x)).report.blockers[0] ?? "", /carries a share of this trip's transport payment/, "and the modal says why before anything is typed");

    let [view] = await T.trips({ ids: [tripId] });
    assert.equal(view.costStatus, "Allocated");
    assert.equal(view.payments[0].costPerLitrePaise, 100);

    /* A bill whose litres are corrected after the split needs reconciling. */
    await db.update(erpTransports).set({ litres: 260 }).where(eq(erpTransports.id, z));
    [view] = await T.trips({ ids: [tripId] });
    assert.equal(view.costStatus, "Reconciliation Required");

    const paymentId = paid.ok ? paid.data.id : "";
    assert.equal((await T.reverseTransportPayment(ctx, paymentId, "")).ok, false, "a reversal says why");
    assert.equal(msg(await T.reverseTransportPayment(ctx, paymentId, "wrong amount")), "Check what this affects and confirm it first.");
    const reversing = await confirmed("erp-transport-payment", paymentId);
    const freed = reversing.report.items.find((i) => /lose their share/.test(i.label));
    assert.equal(freed?.count, 3, "the modal names the three bills the payment was shared over");
    assert.ok(freed?.examples?.some((e) => /9202/.test(e)), JSON.stringify(freed));
    assert.equal(reversing.report.confirmWord, "REVERSE");
    assert.ok((await T.reverseTransportPayment(ctx, paymentId, "wrong amount", reversing.confirmation)).ok);
    assert.match((await confirmed("erp-transport-payment", paymentId)).report.blockers[0] ?? "", /already reversed/);
    [view] = await T.trips({ ids: [tripId] });
    assert.equal(view.costStatus, "Not Recorded");
    /* Freed, a bill can leave the trip — the modal names the two that stay. */
    assert.equal(msg(await T.removeFromTrip(ctx, z)), "Check what this affects and confirm it first.");
    const leaving = await confirmed("erp-trip-bill", z);
    assert.equal(leaving.report.confirmWord, "9203");
    assert.equal(leaving.report.items.find((i) => /^other bills on trip/.test(i.label))?.count, 2, JSON.stringify(leaving.report.items));
    assert.ok((await T.removeFromTrip(ctx, z, leaving.confirmation)).ok);
    assert.equal((await db.select().from(erpTransports).where(eq(erpTransports.id, z)))[0].tripId, null);
    const redo = await T.recordTransportPayment(ctx, { tripId, amountPaise: 101000, transportIds: [x, y] });
    assert.ok(redo.ok, msg(redo));
    const audit = (await db.execute(sql`select action from audit_log where action like 'erp.transportPayment.%' order by at`)) as unknown as { action: string }[];
    assert.deepEqual(audit.map((a) => a.action), ["erp.transportPayment.record", "erp.transportPayment.reverse", "erp.transportPayment.record"]);
  });

  test("zero or missing litres are refused, naming the bill", async () => {
    const ctx = await as(admin);
    const ok1 = await bill(9301, "cus_shree", 100);
    const none = await bill(9302, "cus_om", null);
    const made = await T.saveTrip(ctx, { tripDate: "2026-09-13", vehicleNo: "MH14 Z 1", transportIds: [ok1, none] });
    assert.ok(made.ok);
    const r = await T.recordTransportPayment(ctx, { tripId: made.ok ? made.data.id : "", amountPaise: 1000, transportIds: [ok1, none] });
    assert.equal(r.ok, false);
    assert.match(msg(r), /Order 9302 has no dispatched litres/);
  });

  test("delivery records who confirmed it and the proof, and an Unconfirmed problem keeps it open", async () => {
    const ctx = await as(admin);
    const t = await bill(9401, "cus_shree", 10);
    const issue = await L.raiseIssue(ctx, [t], { issue: "Unconfirmed", note: "party not answering", notify: false });
    assert.ok(issue.ok, msg(issue));
    let [c] = await L.consignments({ ids: [t] });
    assert.notEqual(c.phase, "delivered");
    const done = await L.markDelivered(ctx, [t], { date: "2026-09-15", receivedBy: "Ramesh", proof: "POD 7781", notify: false });
    assert.ok(done.ok, msg(done));
    [c] = await L.consignments({ ids: [t] });
    assert.equal(c.phase, "delivered");
    assert.equal(c.deliveredBy, admin.name);
    assert.equal(c.deliveryProof, "POD 7781");
  });
});

describe("a bulk action is audited one row per record", () => {
  test("300 bills marked at once write 300 rows, not one key past the index limit", async () => {
    const ctx = await as(admin);
    const ids = Array.from({ length: 300 }, () => id("etr"));
    await erpAudit(ctx, "erp.logistics.atTransport", "erp_transport", [...ids, ids[0]].join(","), null, { bulk: true });
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "erp.logistics.atTransport"));
    const mine = rows.filter((r) => ids.includes(r.entityId ?? ""));
    assert.equal(mine.length, 300, "one row each, the repeated id once");
    assert.ok(mine.every((r) => r.actorId === admin.id && r.actorApp === "erp"));
  });

  test("a single id is still one row, as written", async () => {
    const ctx = await as(admin);
    const one = id("etr");
    await erpAudit(ctx, "erp.logistics.packages", "erp_transport", one, null, null);
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, one));
    assert.equal(rows.length, 1);
  });
});

describe("help videos", () => {
  test("removing an uploaded video says the file goes too, and takes it off rather than leaving it behind", async () => {
    const ctx = await as(admin);
    const file = id("att");
    await db.insert(attachments).values({ id: file, filename: "packing-walkthrough.mp4", storedRef: `test/${file}`, contentType: "video/mp4", sizeBytes: 10, status: "available", uploadedById: admin.id } as never);
    const made = await mod("videos").forms!.new(ctx, { title: "Packing a batch", source: "From File Upload", file }, []);
    assert.ok(made.ok, msg(made));
    const [v] = await db.select().from(erpVideos).where(eq(erpVideos.title, "Packing a batch"));

    const report = await impactReport("erp-video", v.id);
    assert.ok(report.ok, report.ok ? "" : report.error);
    assert.equal(report.data.confirmWord, "Packing a batch");
    assert.deepEqual(report.data.items.map((i) => [i.effect, i.count, i.examples]), [["deleted", 1, ["packing-walkthrough.mp4"]]]);
    assert.equal((await mod("videos").actions!.delete(ctx, v.id, {})).ok, false, "no confirmation, no removal");
    const r = await mod("videos").actions!.delete(ctx, v.id, { [IMPACT_FIELD]: JSON.stringify({ typed: "packing a batch", fingerprint: report.data.fingerprint }) });
    assert.ok(r.ok, msg(r));
    assert.equal((await db.select().from(erpVideos).where(eq(erpVideos.id, v.id))).length, 0);
    const [f] = await db.select({ status: attachments.status }).from(attachments).where(eq(attachments.id, file));
    assert.equal(f.status, "removed");
  });
});

describe("delivery proof: an LR for a transporter, a signed copy for a Mahek Vehicle (0297)", () => {
  async function dispatchOwn(date: string, qty: number, bill: string, dispatched: string, verify: Record<string, string>) {
    const ctx = await as(admin);
    const made = await mod("orders").forms!.new(ctx, { date, godown: "Bhiwandi", billing: "Shree Paints", source: "Phone", deliveredBy: "Mahek Vehicle" }, [{ sku: SKU, qty: String(qty), rate: "300" }]);
    assert.ok(made.ok, msg(made));
    const [o] = await db.select().from(erpOrders).where(sql`${erpOrders.orderDate} = ${date} and ${erpOrders.qtyCans} = ${qty}`);
    assert.equal(o.transporter, "Mahek Vehicle", "Delivered by: Mahek Vehicle is the order's transporter");
    await db.execute(sql`update erp_orders set order_check = 'Verified' where order_no = ${o.orderNo}`);
    await mod("orders").actions!.ready(ctx, o.id, {});
    assert.ok((await mod("orders").forms!.allocate(ctx, { lot: "FG2BH", qty: String(qty) }, [], o.id)).ok);
    const ed = await mod("orders").forms!.edit(ctx, { status: "Ready", delivery: "Shree Paints", deliveredBy: "Mahek Vehicle", qty: String(qty), rate: "300", transport: "0" }, [], o.id);
    assert.ok(ed.ok, msg(ed));
    const billed = await mod("orders").actions!.bill(ctx, o.id, { invoiceNo: bill, invoiceDate: dispatched });
    assert.ok(billed.ok, msg(billed));
    await db.execute(sql`update erp_order_details set invoice_check = 'Approved' where order_id in (select id from erp_orders where order_no = ${o.orderNo})`);
    return { o, verify: () => mod("orderDetails").actions!.verify(ctx, o.id, { date: dispatched, ...verify }) };
  }

  before(async () => {
    await db.insert(erpTransporters).values({ id: id("etr"), name: "Mahek Vehicle" }).onConflictDoNothing();
    const [p] = await db.select().from(products).where(eq(products.name, SKU));
    await db.insert(erpFgEntries).values({ id: id("fge"), sourceType: "fill", sourceId: "fin_y", entryDate: "2026-08-01", finishedGoodId: p.finishedGoodId!, lotCode: "FG2BH", godownId: "erpg_bhiwandi", quantity: 60, packingType: "Can", skuId: p.id });
  });

  let ownId = "";

  test("a Mahek Vehicle cannot leave unnamed: the vehicle and the driver are asked", async () => {
    const { verify } = await dispatchOwn("2026-10-01", 3, "MP/26-27/9901", "2026-10-02", {});
    assert.match(msg(await verify()), /vehicle number/);
    const { verify: v2 } = await dispatchOwn("2026-10-03", 4, "MP/26-27/9902", "2026-10-04", { vehicle: "mh04 kl 2231" });
    assert.match(msg(await v2()), /driver/);
    const { o, verify: v3 } = await dispatchOwn("2026-10-05", 5, "MP/26-27/9903", "2026-10-06", { vehicle: "MH04 KL 2231", driver: "Driver One 9820011099" });
    const r = await v3();
    assert.ok(r.ok, msg(r));
    const [t] = await db.select().from(erpTransports).where(eq(erpTransports.orderNo, o.orderNo));
    ownId = t.id;
    const [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.ownVehicle, true);
    assert.equal(c.phase, "onRoad", "no transporter's godown and no LR to wait for");
    assert.equal(c.nextCallOn, "2026-10-06", "the driver is rung from the day it leaves");
    assert.match(c.driver ?? "", /9820011099/);
  });

  test("the driver's update moves it on the road with no LR; an LR cannot be put on it", async () => {
    const ctx = await as(admin);
    const up = await L.updateConsignment(ctx, [ownId], { stage: "Out for Delivery", note: "Driver says near the shop", notify: false });
    assert.ok(up.ok, msg(up));
    const lr = await L.uploadLrs(ctx, [{ lrNo: "OWN-1", transporter: "VRL" }]);
    assert.ok(lr.ok);
    assert.match(msg(await L.attachLr(ctx, lr.ok ? lr.data.ids[0] : "", [ownId], { notify: false })), /Mahek Vehicle/);
  });

  test("it closes only with the customer-signed copy, and who signed it", async () => {
    const ctx = await as(admin);
    assert.match(msg(await L.markDelivered(ctx, [ownId], { date: "2026-10-07", notify: false })), /signed copy/);
    const up = await L.uploadLrs(ctx, [{ kind: "signed_copy", billHint: "9903", lrNo: "IGNORED", transporter: "Gati" }]);
    assert.ok(up.ok, msg(up));
    const copy = up.ok ? up.data.ids[0] : "";
    const [row] = await db.execute(sql`select kind, lr_no as "lrNo", transporter from erp_lrs where id = ${copy}`) as unknown as { kind: string; lrNo: string | null; transporter: string | null }[];
    assert.deepEqual(row, { kind: "signed_copy", lrNo: null, transporter: null }, "a signed copy carries no LR number or transporter");
    assert.match(msg(await L.attachLr(ctx, copy, [ownId], { notify: false })), /signed copy/, "a signed copy is never attached as an LR");
    assert.match(msg(await L.markDelivered(ctx, [ownId], { date: "2026-10-07", signedCopyId: copy, notify: false })), /who signed/);
    const done = await L.markDelivered(ctx, [ownId], { date: "2026-10-07", signedCopyId: copy, receivedBy: "Contact Two", notify: false });
    assert.ok(done.ok, msg(done));
    const [t] = await db.select().from(erpTransports).where(eq(erpTransports.id, ownId));
    assert.equal(t.materialStage, "Close - Received to Party");
    assert.equal(t.signedCopyId, copy);
    assert.equal(t.receivedBy, "Contact Two");
    const [l] = await db.execute(sql`select status, received_by as "receivedBy" from erp_lrs where id = ${copy}`) as unknown as { status: string; receivedBy: string }[];
    assert.deepEqual(l, { status: "assigned", receivedBy: "Contact Two" });
  });

  test("the same photo twice is stored once", async () => {
    const ctx = await as(admin);
    const a = id("att");
    const b = id("att");
    for (const f of [a, b]) await db.insert(attachments).values({ id: f, filename: "lr.jpg", storedRef: `test/${f}`, contentType: "image/jpeg", sizeBytes: 10, status: "available", uploadedById: admin.id, contentHash: `hash-${tag}` } as never);
    const first = await L.uploadLrs(ctx, [{ fileId: a }, { fileId: b }]);
    assert.ok(first.ok, msg(first));
    assert.equal(first.ok && first.data.ids.length, 1, "one photo, sent twice in one upload, is one LR");
    const again = await L.uploadLrs(ctx, [{ fileId: b }]);
    assert.ok(again.ok);
    assert.deepEqual(again.ok && again.data, { ids: [], already: first.ok ? first.data.ids : [] }, "and sent again later it answers with the first");
  });

  test("a second photo of one LR is flagged beside the first, and discarding it keeps the first", async () => {
    const ctx = await as(admin);
    const { duplicateFlags } = await import("@/lib/erp/engines/delivery-proof");
    const one = await L.uploadLrs(ctx, [{ lrNo: "LR-5001", transporter: "VRL", packages: 4 }]);
    const two = await L.uploadLrs(ctx, [{ transporter: "VRL", note: "photo only" }]);
    assert.ok(one.ok && two.ok);
    const second = two.ok ? two.data.ids[0] : "";
    /* What the AI read off the second photo, kept beside the empty number box. */
    await db.execute(sql`update erp_lrs set read_lr_no = 'LR5001', read_at = now() where id = ${second}`);
    const desk = await L.uploadedLrs({ status: "all", recentDays: 120 });
    const flag = duplicateFlags(desk).get(second);
    assert.equal(flag?.kind, "duplicate");
    assert.equal(flag?.ofId, one.ok ? one.data.ids[0] : "");
    const r = await L.discardDuplicate(ctx, second);
    assert.ok(r.ok, msg(r));
    const [l] = await db.execute(sql`select status, void_reason as why from erp_lrs where id = ${second}`) as unknown as { status: string; why: string }[];
    assert.equal(l.status, "void");
    assert.match(l.why, /Duplicate of LR LR-5001/);
    assert.match(msg(await L.discardDuplicate(ctx, one.ok ? one.data.ids[0] : "")), /does not look like a copy/, "the first one is never the duplicate");
  });

  test("a near number is a question; keeping both stops it being asked again", async () => {
    const ctx = await as(admin);
    const { duplicateFlags } = await import("@/lib/erp/engines/delivery-proof");
    const one = await L.uploadLrs(ctx, [{ lrNo: "33120", transporter: "Gati", packages: 20, lrDate: "2026-09-01" }]);
    const two = await L.uploadLrs(ctx, [{ lrNo: "3312", transporter: "Gati", packages: 20, lrDate: "2026-09-01" }]);
    assert.ok(one.ok && two.ok);
    const second = two.ok ? two.data.ids[0] : "";
    assert.equal(duplicateFlags(await L.uploadedLrs({ status: "all", recentDays: 120 })).get(second)?.kind, "check");
    assert.ok((await L.clearDuplicate(ctx, second)).ok);
    assert.equal(duplicateFlags(await L.uploadedLrs({ status: "all", recentDays: 120 })).get(second), undefined);
  });

  test("who delivers a bill changes until it is delivered, never under an LR", async () => {
    const ctx = await as(admin);
    const o = await dispatch("2026-10-10", 7, "MP/26-27/9910", "2026-10-11");
    const [t] = await db.select().from(erpTransports).where(eq(erpTransports.orderNo, o.orderNo));
    const r = await L.setDeliveredBy(ctx, [t.id], "Mahek Vehicle");
    assert.ok(r.ok, msg(r));
    const [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.ownVehicle, true);
    assert.equal(c.phase, "onRoad");
    const [line] = await db.select({ transporter: erpOrders.transporter }).from(erpOrders).where(eq(erpOrders.orderNo, o.orderNo));
    assert.equal(line.transporter, "Mahek Vehicle", "the order's own lines move with it");
    assert.ok((await L.setDeliveredBy(ctx, [t.id], "gati")).ok, "and back, to a listed transporter");
    const lr = await L.uploadLrs(ctx, [{ lrNo: "LR-9910", transporter: "Gati" }]);
    assert.ok(lr.ok && (await L.attachLr(ctx, lr.data.ids[0], [t.id], { notify: false })).ok);
    assert.match(msg(await L.setDeliveredBy(ctx, [t.id], "Mahek Vehicle")), /Take it off the LR/);
    assert.match(msg(await L.setDeliveredBy(ctx, [ownId], "VRL")), /already delivered/);
  });

  test("our own vehicle keeps its name and stays on the list", async () => {
    const ctx = await as(admin);
    const [mv] = await db.select().from(erpTransporters).where(eq(erpTransporters.name, "Mahek Vehicle"));
    assert.match(msg(await L.saveTransporter(ctx, { id: mv.id, name: "Own Truck" })), /keeps its name/);
    assert.match(msg(await L.saveTransporter(ctx, { id: mv.id, name: "Mahek Vehicle", active: false })), /cannot be switched off/);
    const [vrl] = await db.select().from(erpTransporters).where(eq(erpTransporters.name, "VRL"));
    assert.match(msg(await L.mergeTransporter(ctx, vrl.id, mv.id)), /cannot be merged/);
  });

  test("an upload is moved between LRs and signed copies only while it is on the desk", async () => {
    const ctx = await as(admin);
    const up = await L.uploadLrs(ctx, [{ lrNo: "LR-7777", transporter: "VRL" }]);
    assert.ok(up.ok);
    const lid = up.ok ? up.data.ids[0] : "";
    assert.ok((await L.setLrKind(ctx, lid, "signed_copy")).ok);
    const [l] = await db.execute(sql`select kind, lr_no as "lrNo" from erp_lrs where id = ${lid}`) as unknown as { kind: string; lrNo: string | null }[];
    assert.deepEqual(l, { kind: "signed_copy", lrNo: null });
  });
});
