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
  erpRefValues,
  erpTransporterGodowns,
  erpTransporters,
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
import * as L from "@/lib/erp/logistics";

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
             erp_pack_entries, erp_transports, erp_lrs, erp_transport_events, erp_transport_messages, erp_transporters, erp_requests, erp_followups, erp_credits, erp_expenses, erp_videos,
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
    assert.equal(msg(await L.uploadLrs(ctx, [{ lrNo: "LR-7781", transporter: "vrl" }])), "Row 1: LR LR-7781 of vrl is already uploaded");
    assert.equal(msg(await L.uploadLrs(ctx, [{ lrNo: " " }])), "Fill in at least one LR — a photo is enough.");
    const lrs = await L.uploadedLrs();
    assert.equal(lrs.length, 2);
    const lr = lrs.find((l) => l.lrNo === "LR-7781")!;
    assert.equal(L.suggestBills(lr, await L.consignments())[0].id, t.id);
    assert.ok((await L.voidLr(ctx, lrs.find((l) => l.lrNo === "LR-9")!.id, "duplicate photo")).ok);
    assert.ok((await db.select().from(erpTransporters)).some((x) => x.name === "VRL"), "a transporter named on an upload joins the directory");

    /* No field is required: two LRs with no number from one transporter both land, an empty row is skipped,
       and one with no number cannot be attached until logistics types it off the photo. */
    const bare = await L.uploadLrs(ctx, [{ transporter: "Gati" }, {}, { transporter: "Gati", note: "photo only" }]);
    assert.ok(bare.ok, msg(bare));
    const numberless = (await L.uploadedLrs()).filter((l) => !l.lrNo);
    assert.equal(numberless.length, 2);
    assert.equal(msg(await L.attachLr(ctx, numberless[0].id, [t.id], {})), "Type the LR number off the photo first (Edit) — the customer is told it.");
    assert.ok((await L.editLr(ctx, numberless[0].id, { lrNo: "G-1", transporter: "Gati" })).ok);
    for (const l of numberless) assert.ok((await L.voidLr(ctx, l.id, "test rows")).ok);

    /* Logistics attaches it: the bill goes on the road and the party is told. */
    const att = await L.attachLr(ctx, lr.id, [t.id], { expectedOn: "2026-08-06" });
    assert.ok(att.ok, msg(att));
    [c] = await L.consignments({ ids: [t.id] });
    assert.equal(c.phase, "onRoad");
    assert.equal(c.lrNo, "LR-7781");
    assert.equal(c.stage, "In Transit");
    assert.equal(c.expectedDeliveryOn, "2026-08-06");
    assert.ok(c.nextCallOn, "the next call to the transporter is booked");
    let out = await L.messages();
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "lr");
    assert.equal(out[0].status, "to_send", "no Wati template is named, so it waits to be sent by hand");
    assert.match(out[0].why ?? "", /No logistics template/);
    assert.match(out[0].body, /LR no LR-7781/);
    assert.match(out[0].body, /1 box\./);
    assert.equal(out[0].phone, "919876500001");
    assert.equal(msg(await L.attachLr(ctx, lr.id, [t.id], {})), "These bills are already under this LR.");
    assert.ok((await L.markMessageSent(ctx, out[0].id)).ok);
    assert.equal((await L.messages({ waitingOnly: true })).length, 0);

    /* A call that moves nothing books the next one and tells nobody; a stage that moves is shared. */
    assert.ok((await L.updateConsignment(ctx, [t.id], { note: "driver on leave" })).ok);
    assert.equal((await L.messages()).length, 1);
    assert.ok((await L.updateConsignment(ctx, [t.id], { stage: "Reached Destination Area", note: "at Pune godown" })).ok);
    out = await L.messages();
    assert.equal(out.length, 2);
    assert.match(out[0].body, /has reached your area/);
    assert.equal(msg(await L.updateConsignment(ctx, [t.id], { stage: "Close - Received to Party" })), "Pick where the goods are");

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
    assert.match((await L.messages())[0].body, /received by Ramesh/);
    assert.equal(msg(await L.detachLr(ctx, t.id, "wrong bill")), "A delivered bill keeps its LR.");

    /* The customer's link names the steps and never a call note. */
    const pub = await L.publicTracking(c.trackToken!);
    assert.ok(pub);
    assert.equal(pub.lrNo, "LR-7781");
    assert.equal(pub.stage, "Close - Received to Party");
    assert.ok(!JSON.stringify(pub).includes("driver on leave"));
    assert.ok(!JSON.stringify(pub).includes("lorry broke down"));
    assert.equal(await L.publicTracking("nope"), null);

    /* Reopened by mistake: back on the road with a call due today, nobody messaged. */
    assert.ok((await L.reopen(ctx, t.id, "party says short")).ok);
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
    const [m] = await L.messages();
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

describe("transporters", () => {
  test("a GST number is checked, godowns are one town each with their people, and a new consignment name joins the list", async () => {
    const ctx = await as(admin);
    const ci = `Tcity ${tag}`, ci2 = `Ucity ${tag}`;

    assert.equal(msg(await L.saveTransporter(ctx, { name: `Road ${tag}`, gstin: "27ABCDE1234F1Z9" })), "That GST number does not check out — it is 15 characters, like 27ABCDE1234F1Z5");
    assert.equal(msg(await L.saveTransporter(ctx, { name: `Road ${tag}`, godowns: [{ label: "Main" }] })), "Type the town for godown 1");
    assert.equal(
      msg(await L.saveTransporter(ctx, { name: `Road ${tag}`, godowns: [{ town: ci, contacts: [{ name: "Ravi", phones: ["9820011001", "9820011002", "9820011003", "9820011004"] }] }] })),
      "A person takes up to 3 numbers",
    );

    const godowns = [
      { label: "Main godown", town: ` ${ci} `, address: "Plot 4", contacts: [{ name: "Ravi", role: "Booking", phones: ["9820011001", "", "022 2567 1234"] }, { name: "Asha", phones: ["9820011009"] }] },
      { town: ci2, contacts: [{ name: " ", phones: [""] }] },
    ];
    assert.ok((await L.saveTransporter(ctx, { name: `Road ${tag}`, gstin: "27aapcs1234a1zn", consignmentLabel: "  docket   number ", godowns })).ok);
    const [t] = await db.select().from(erpTransporters).where(eq(erpTransporters.name, `Road ${tag}`));
    assert.equal(t.gstin, "27AAPCS1234A1ZN");
    assert.equal(t.consignmentLabel, "docket number");
    /* The call buttons read the first person's name and numbers off the row. */
    assert.deepEqual([t.contactPerson, t.phone, t.altPhone], ["Ravi", "9820011001", "022 2567 1234"]);
    const list = await db.select().from(erpRefValues).where(sql`${erpRefValues.listKey} = 'consignmentLabel' and lower(${erpRefValues.value}) = 'docket number'`);
    assert.equal(list.length, 1);
    const read = (await L.transporters()).find((x) => x.id === t.id)!;
    assert.deepEqual(read.godowns.map((g) => [g.label, g.town, g.contacts.length]), [["Main godown", ci, 2], [null, ci2, 0]]);
    assert.deepEqual(read.godowns[0].contacts.map((c) => c.phones), [["9820011001", "022 2567 1234"], ["9820011009"]]);

    /* A known name keeps the list's spelling; leaving godowns out leaves them alone. */
    assert.ok((await L.saveTransporter(ctx, { id: t.id, name: `Road ${tag}`, consignmentLabel: "gr number" })).ok);
    const [again] = await db.select().from(erpTransporters).where(eq(erpTransporters.id, t.id));
    assert.equal(again.consignmentLabel, "GR Number");
    assert.equal(again.phone, "9820011001");
    assert.equal((await db.select().from(erpTransporterGodowns).where(eq(erpTransporterGodowns.transporterId, t.id))).length, 2);

    /* Saving the godowns back keeps their ids; a godown taken off goes with its people. */
    const keep = read.godowns[0];
    assert.ok((await L.saveTransporter(ctx, { id: t.id, name: `Road ${tag}`, godowns: [{ ...keep, contacts: keep.contacts.slice(1) }] })).ok);
    const after = (await L.transporters()).find((x) => x.id === t.id)!;
    assert.deepEqual(after.godowns.map((g) => g.id), [keep.id]);
    assert.deepEqual(after.godowns[0].contacts.map((c) => c.id), [keep.contacts[1].id]);
    assert.equal(after.contactPerson, "Asha");
  });
});

