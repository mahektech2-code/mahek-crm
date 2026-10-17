/**
 * "THEY CALLED US", COMPLETED — against a real database.
 *
 *   npm run test:integration
 *
 * What this pins is the part only a database can show, and every test is also a
 * statement that something that already worked still does:
 *
 *   - Opportunity = No is kept as an answer, unanswered stays null, and a Yes
 *     lands on the list of the person whose book the account is in;
 *   - the worklist shows a row to the people it concerns and to nobody else, and
 *     only they can move it;
 *   - a next action that belongs to somebody else is handed to them, and one
 *     that belongs to the caller still produces the single reminder it always
 *     did;
 *   - the snapshot is read by the SERVER from the id the panel names — never
 *     from figures the browser sends — and a broken read never costs the call;
 *   - the call history and the timeline show what a call recorded, and a call
 *     logged before any of this draws exactly as it did.
 *
 * No key is spent and nothing here reaches the network.
 */
delete process.env.OPENAI_API_KEY;
delete process.env.SARVAM_API_KEY;

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  callOpportunities,
  calls,
  customers,
  erpFgEntries,
  erpOrderDetails,
  erpOrders,
  erpPackEntries,
  erpProductPacking,
  erpTransports,
  finishedGoods,
  notifications,
  productBrands,
  productFormulations,
  products,
  reminders,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { addDays, today } from "@/lib/format";
import { saveInteraction } from "@/lib/services/interaction-service";
import { customerTimeline, listInteractions } from "@/lib/queries";
import {
  deliveryOrdersFor,
  paymentSnapshotFor,
  stockForSku,
} from "@/lib/services/call-context-service";
import {
  listOpportunities,
  setOpportunityStatus,
} from "@/lib/services/opportunity-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = today();

let mgr: typeof users.$inferSelect;
let salesman: typeof users.$inferSelect;
let backOffice: typeof users.$inferSelect;
let salesManager: typeof users.$inferSelect;
let stranger: typeof users.$inferSelect;
let customerId: string;
let loose = "";
let boxed = "";

async function makeUser(
  name: string,
  opts: { role?: "associate" | "manager"; reportsToId?: string } = {},
) {
  const role = opts.role ?? "associate";
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
      reportsToId: opts.reportsToId ?? null,
    } as never)
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role });
  return row;
}

async function makeCustomer(over: Partial<typeof customers.$inferInsert> = {}) {
  const cid = id("cus");
  await db.insert(customers).values({
    id: cid,
    name: "Shree Paints",
    phone: "9820099001",
    city: "Nagpur",
    kind: "customer",
    ownerId: mgr.id,
    salesAmId: salesman.id,
    backOfficeAmId: backOffice.id,
    salesManagerId: salesManager.id,
    ...over,
  } as never);
  return cid;
}

const inbound = (over: Record<string, unknown> = {}) =>
  saveInteraction({
    customerId,
    interactionType: "inbound_call",
    callerRole: "purchase",
    callReason: "price_quotation",
    reasonDetail: { product: "PU Clear 20L" },
    /* casual_talk, because an outcome WITH its own action list (Follow-up, No
       Order, Order Taken) replaces the reason's, and Follow-up also writes a
       reminder of its own — either would muddy what these tests count. */
    outcome: "casual_talk",
    idempotencyKey: randomUUID(),
    ...over,
  } as never);

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      call_opportunities, calls, reminders, complaints, timeline_events,
      notifications, audit_log, erp_order_details, erp_batch_codes, erp_orders,
      erp_transports, erp_fg_entries, erp_pack_entries, erp_product_packing,
      products, finished_goods, product_brands, product_formulations,
      customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  mgr = await makeUser("Manager Mina", { role: "manager" });
  salesman = await makeUser("Mahesh Salesman", { reportsToId: mgr.id });
  backOffice = await makeUser("Bhavna BackOffice", { reportsToId: mgr.id });
  salesManager = await makeUser("Sunil SalesManager", { reportsToId: mgr.id });
  stranger = await makeUser("Stranger Sam");
  customerId = await makeCustomer();

  const tag = randomUUID().slice(0, 6);
  const fId = id("form");
  const bId = id("brand");
  const fgId = id("fg");
  await db.insert(productFormulations).values({ id: fId, name: `TCU ${tag}`, slug: `tcu-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `TCU ${tag}`, slug: `tcu-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values({ id: fgId, name: `TCU Thinner ${tag}`, slug: `tcu-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 1000 });
  loose = id("sku");
  boxed = id("sku");
  await db.insert(products).values([
    { id: loose, name: `TCU Loose ${tag}`, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 1 },
    { id: boxed, name: `TCU Boxed ${tag}`, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 24 },
  ] as never);
  await db.insert(erpProductPacking).values([
    { productId: loose, emptyBoxesRequired: 0 },
    { productId: boxed, emptyBoxesRequired: 1, boxType: "Empty Box 1 Liter" },
  ]);
  await db.insert(erpFgEntries).values({ id: id("fge"), sourceType: "fill", sourceId: "fin_x", entryDate: TODAY, finishedGoodId: fgId, lotCode: "FG1BH", godownId: "erpg_bhiwandi", quantity: 30, packingType: "Can", skuId: loose });
  await db.insert(erpPackEntries).values({ id: id("pke"), sourceType: "batch", sourceId: "FP1BH", entryDate: TODAY, skuId: boxed, batchNo: "FP1BH", godownId: "erpg_bhiwandi", boxes: 10 });

  setTestUser(mgr);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

const callRow = async (callId: string) =>
  (await db.select().from(calls).where(eq(calls.id, callId)))[0];

/* ------------------------------------------------------ opportunity yes / no */

describe("the opportunity answer", () => {
  test("Yes keeps its row, No is kept as an answer, and unasked stays null", async () => {
    const yes = await inbound({
      opportunity: { product: "PU Clear 20L", estimatedValueRupees: 40_000 },
    });
    assert.ok(yes.ok, yes.ok ? "" : yes.error);
    assert.equal((await callRow(yes.data.interactionId)).opportunityAnswer, "yes");

    const no = await inbound({ opportunityAnswer: "no" });
    assert.ok(no.ok);
    assert.equal((await callRow(no.data.interactionId)).opportunityAnswer, "no");

    const unasked = await inbound();
    assert.ok(unasked.ok);
    assert.equal(
      (await callRow(unasked.data.interactionId)).opportunityAnswer,
      null,
      "nobody was asked — which is not a No",
    );

    const rows = await db.select().from(callOpportunities);
    assert.equal(rows.length, 1, "No writes no row — there is nothing to chase");
  });

  test("an opportunity described AND answered No is a contradiction, and is refused", async () => {
    const r = await inbound({
      opportunity: { product: "PU Clear 20L" },
      opportunityAnswer: "no",
    });
    assert.equal(r.ok, false);
  });

  test("an order that arrived with no call has nobody to ask", async () => {
    const r = await saveInteraction({
      customerId,
      interactionType: "order_received",
      orderDate: TODAY,
      productQuantities: { [loose]: 2 },
      opportunityAnswer: "no",
      idempotencyKey: randomUUID(),
    } as never);
    assert.equal(r.ok, false);
  });
});

/* ----------------------------------------------------------- the worklist */

describe("the opportunity worklist", () => {
  test("it lands on the person whose book the account is in, who is told", async () => {
    const r = await inbound({ opportunity: { product: "PU Clear 20L", estimatedValueRupees: 40_000 } });
    assert.ok(r.ok);
    const [opp] = await db.select().from(callOpportunities);
    assert.equal(opp.assignedUserId, salesman.id);
    assert.equal(opp.status, "open");
    assert.equal(opp.userId, mgr.id, "who logged it is still on the row");

    const told = await db.select().from(notifications).where(eq(notifications.userId, salesman.id));
    assert.equal(told.length, 1);
    assert.match(told[0].body, /PU Clear 20L/);

    setTestUser(salesman);
    const list = await listOpportunities();
    assert.equal(list.length, 1);
    assert.equal(list[0].callReason, "price_quotation");
    assert.equal(list[0].callerRole, "purchase");
  });

  test("with no salesperson on the account it stays with whoever took the call, and nobody else is told", async () => {
    const lone = await makeCustomer({ salesAmId: null, ownerId: mgr.id });
    const r = await inbound({ customerId: lone, opportunity: { product: "Thinner" } });
    assert.ok(r.ok);
    const [opp] = await db.select().from(callOpportunities);
    assert.equal(opp.assignedUserId, mgr.id);
    assert.equal((await db.select().from(notifications)).length, 0);
  });

  test("a stranger sees nothing and can move nothing", async () => {
    const r = await inbound({ opportunity: { product: "PU Clear 20L" } });
    assert.ok(r.ok);
    const [opp] = await db.select().from(callOpportunities);

    setTestUser(stranger);
    assert.equal((await listOpportunities()).length, 0);
    const moved = await setOpportunityStatus({ id: opp.id, status: "won" });
    assert.equal(moved.ok, false, "not on their list answers like not there");
    assert.equal((await db.select().from(callOpportunities))[0].status, "open");
  });

  test("the assignee works it: start, lost needs a reason, reopen clears the closing mark", async () => {
    const r = await inbound({ opportunity: { product: "PU Clear 20L" } });
    assert.ok(r.ok);
    const [opp] = await db.select().from(callOpportunities);

    setTestUser(salesman);
    assert.ok((await setOpportunityStatus({ id: opp.id, status: "in_progress" })).ok);
    assert.equal((await setOpportunityStatus({ id: opp.id, status: "lost" })).ok, false, "lost says why");
    assert.ok((await setOpportunityStatus({ id: opp.id, status: "lost", note: "Went with a competitor" })).ok);
    let [row] = await db.select().from(callOpportunities);
    assert.equal(row.status, "lost");
    assert.ok(row.closedAt);
    assert.equal(row.workedNote, "Went with a competitor");

    assert.ok((await setOpportunityStatus({ id: opp.id, status: "open" })).ok);
    [row] = await db.select().from(callOpportunities);
    assert.equal(row.closedAt, null);
    assert.equal(row.workedNote, "Went with a competitor", "reopening does not erase what was written");
    assert.equal((await setOpportunityStatus({ id: opp.id, status: "nonsense" })).ok, false);
  });

  test("the logger can still see what became of the opportunity they raised", async () => {
    const r = await inbound({ opportunity: { product: "PU Clear 20L" } });
    assert.ok(r.ok);
    setTestUser(mgr);
    assert.equal((await listOpportunities()).length, 1);
  });
});

/* ------------------------------------------------------------- next actions */

describe("next actions are handed to the people they belong to", () => {
  const dated = () => addDays(TODAY, 2);

  test("a quotation stays with the caller and the visit goes to the salesperson, who is told", async () => {
    const r = await inbound({
      nextActions: ["send_quotation", "salesman_visit"],
      nextActionDate: dated(),
    });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const rows = await db.select().from(reminders).where(eq(reminders.callId, r.data.interactionId));
    const byUser = new Map(rows.map((x) => [x.assignedUserId, x]));
    assert.equal(rows.length, 2, "one reminder per person");
    assert.match(byUser.get(mgr.id)!.note, /Send quotation/);
    assert.doesNotMatch(byUser.get(mgr.id)!.note, /visit/i, "the caller's list carries only the caller's job");
    /* "Visit customer" is the canonical label `NEXT_ACTION_LABEL` gives the code —
       the same words every history screen reads it back in. */
    assert.match(byUser.get(salesman.id)!.note, /^Visit customer — handed over by Manager Mina from a call with Shree Paints/);

    /* The call keeps pointing at the reminder it always pointed at. */
    assert.equal(r.data.reminderId, byUser.get(mgr.id)!.id);

    const told = await db.select().from(notifications).where(eq(notifications.userId, salesman.id));
    assert.equal(told.length, 1);
    assert.equal(
      (await db.select().from(notifications).where(eq(notifications.userId, mgr.id))).length,
      0,
      "nobody is told what they did themselves",
    );

    const snap = (await callRow(r.data.interactionId)).contextSnapshot as { routing?: unknown[] };
    assert.equal(snap.routing?.length, 1, "who it was handed to is kept on the call");
  });

  test("logistics goes to back office and an escalation to the sales manager — and the caller keeps nothing", async () => {
    const r = await inbound({
      callReason: "delivery_transport",
      reasonDetail: { issue: "not_received" },
      nextActions: ["contact_logistics", "escalate"],
      nextActionDate: dated(),
    });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const rows = await db.select().from(reminders).where(eq(reminders.callId, r.data.interactionId));
    assert.deepEqual(
      rows.map((x) => x.assignedUserId).sort(),
      [backOffice.id, salesManager.id].sort(),
    );
    assert.ok(rows.every((x) => x.assignedUserId !== mgr.id));
    assert.equal(r.data.reminderId, rows[0].id, "the call still names a reminder");
    for (const u of [backOffice, salesManager]) {
      assert.equal((await db.select().from(notifications).where(eq(notifications.userId, u.id))).length, 1);
    }
  });

  test("a call that is all the caller's own produces exactly the one reminder it always did", async () => {
    const r = await inbound({ nextActions: ["call_back", "send_price"], nextActionDate: dated() });
    assert.ok(r.ok);
    const rows = await db.select().from(reminders).where(eq(reminders.callId, r.data.interactionId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].assignedUserId, mgr.id);
    assert.equal(rows[0].note, "Call again, Send price", "the note is exactly what it always was");
    assert.equal((await db.select().from(notifications)).length, 0);
    assert.equal((await callRow(r.data.interactionId)).contextSnapshot, null);
  });

  test("an EMPTY seat keeps the action with the caller and says so", async () => {
    /* No salesperson, no owner, no sales manager. Back office is named only so
       the account is in the caller's scope at all. (Owner is left null on
       purpose: a customer with no salesperson falls back to its OWNER, so an
       owner who is the caller would BE the seat, and nothing would fall back.) */
    const bare = await makeCustomer({ salesAmId: null, ownerId: null, salesManagerId: null });
    const r = await inbound({
      customerId: bare,
      nextActions: ["salesman_visit"],
      nextActionDate: dated(),
    });
    assert.ok(r.ok);
    const rows = await db.select().from(reminders).where(eq(reminders.callId, r.data.interactionId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].assignedUserId, mgr.id);
    assert.ok(
      r.ok && (r as { warnings?: string[] }).warnings?.some((w) => /stays with you/.test(w)),
      "the person saving is told it did not go anywhere",
    );
  });

  test("a seat held by somebody who has left is an empty seat", async () => {
    await db.update(users).set({ active: false }).where(eq(users.id, salesman.id));
    const r = await inbound({ nextActions: ["salesman_visit"], nextActionDate: dated() });
    assert.ok(r.ok);
    const rows = await db.select().from(reminders).where(eq(reminders.callId, r.data.interactionId));
    assert.deepEqual(rows.map((x) => x.assignedUserId), [mgr.id]);
  });

  test("Follow-up date is a dated action: a day is demanded, then it is a call-back reminder", async () => {
    const missing = await inbound({ nextActions: ["follow_up_date"] });
    assert.equal(missing.ok, false);
    const r = await inbound({ nextActions: ["follow_up_date"], nextActionDate: dated() });
    assert.ok(r.ok);
    const [rem] = await db.select().from(reminders).where(eq(reminders.callId, r.data.interactionId));
    assert.equal(rem.type, "call_back");
  });
});

/* ----------------------------------------------------------------- snapshot */

describe("what the call keeps of the ERP and the ledger", () => {
  test("a payment call keeps what was owed that day, and the live figure still moves", async () => {
    await db.update(customers).set({ outstanding: 12_500_00 }).where(eq(customers.id, customerId));
    const r = await inbound({
      callReason: "payment_outstanding",
      reasonDetail: { customerQuery: "Which bills are open?", paymentPosition: "disputed" },
    });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const row = await callRow(r.data.interactionId);
    const snap = row.contextSnapshot as { payment?: { outstandingPaise: number } };
    assert.equal(snap.payment?.outstandingPaise, 12_500_00);
    assert.equal(row.reasonDetail?.paymentPosition, "disputed");

    await db.update(customers).set({ outstanding: 0 }).where(eq(customers.id, customerId));
    const after = (await callRow(r.data.interactionId)).contextSnapshot as { payment?: { outstandingPaise: number } };
    assert.equal(after.payment?.outstandingPaise, 12_500_00, "a record of the day, never recomputed");
    assert.equal((await paymentSnapshotFor(customerId))?.outstandingPaise, 0);
  });

  test("a bad payment-position code is refused; the old free-text box is untouched", async () => {
    const bad = await inbound({
      callReason: "payment_outstanding",
      reasonDetail: { customerQuery: "x", paymentPosition: "nonsense" },
    });
    assert.equal(bad.ok, false);
    const ok = await inbound({
      callReason: "payment_outstanding",
      reasonDetail: { customerQuery: "x", paymentStatus: "Cheque posted Tuesday" },
    });
    assert.ok(ok.ok, "no coded status is fine");
  });

  async function seedOrder(forCustomer: string, orderNo: number) {
    const oid = id("ord");
    await db.insert(erpOrders).values({
      id: oid, orderNo, orderDate: "2026-09-20", godownId: "erpg_bhiwandi",
      billingCustomerId: forCustomer, deliveryCustomerId: forCustomer, skuId: loose, qtyCans: 4,
      transporter: "Local Tempo", dispatchOn: "2026-09-25", tallyBillNo: `T-${orderNo}`,
    } as never);
    await db.insert(erpOrderDetails).values({ orderId: oid, dispatchStatus: "Dispatched", dispatchDate: "2026-09-26" } as never);
    await db.insert(erpTransports).values({
      id: id("tr"), orderNo, billingCustomerId: forCustomer, billNo: `B-${orderNo}`,
      transporter: "VRL Logistics", lrNo: `LR-${orderNo}`, materialStage: "In Transit",
    } as never);
  }

  test("delivery reads the customer's ERP orders with their transport details", async () => {
    await seedOrder(customerId, 501);
    const orders = await deliveryOrdersFor(customerId);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].orderNo, 501);
    assert.equal(orders[0].transporter, "VRL Logistics", "the transport record wins over the line's own");
    assert.equal(orders[0].lrNo, "LR-501");
    assert.equal(orders[0].billNo, "B-501");
    assert.equal(orders[0].dispatchedOn, "2026-09-26");
    assert.equal(orders[0].plannedDispatch, "2026-09-25");
    assert.equal(orders[0].stage, "In Transit");
  });

  test("the snapshot is read by the SERVER — and an order that is not theirs is not snapshotted", async () => {
    const other = await makeCustomer({ name: "Other Shop" });
    await seedOrder(customerId, 501);
    await seedOrder(other, 502);

    const mine = await inbound({
      callReason: "delivery_transport",
      reasonDetail: { issue: "delayed", orderRef: "my bill", erpOrderNo: "501" },
    });
    assert.ok(mine.ok, mine.ok ? "" : mine.error);
    const snap = (await callRow(mine.data.interactionId)).contextSnapshot as {
      delivery?: { orderNo: number; lrNo: string };
    };
    assert.equal(snap.delivery?.lrNo, "LR-501");

    const theirs = await inbound({
      callReason: "delivery_transport",
      reasonDetail: { issue: "delayed", erpOrderNo: "502" },
    });
    assert.ok(theirs.ok, "naming somebody else's order never costs the call");
    assert.equal((await callRow(theirs.data.interactionId)).contextSnapshot, null);

    const junk = await inbound({
      callReason: "delivery_transport",
      reasonDetail: { issue: "delayed", erpOrderNo: "5; drop table calls" },
    });
    assert.ok(junk.ok);
    assert.equal((await callRow(junk.data.interactionId)).reasonDetail?.erpOrderNo, undefined);
  });

  test("a delivery call with nothing in the ERP is still loggable", async () => {
    const r = await inbound({
      callReason: "delivery_transport",
      reasonDetail: { issue: "not_received", orderRef: "something they quoted" },
    });
    assert.ok(r.ok);
  });

  test("stock is read from the ERP's ledgers: loose in cans, boxed in boxes — and never reserved", async () => {
    const l = await stockForSku(loose);
    assert.ok(!("unavailable" in l));
    assert.equal(l.unit, "cans");
    assert.equal(l.total, 30);
    const b = await stockForSku(boxed);
    assert.ok(!("unavailable" in b));
    assert.equal(b.unit, "boxes");
    assert.equal(b.total, 10);

    const r = await inbound({
      callReason: "stock_availability",
      reasonDetail: { product: "Loose can", requiredQuantity: "10", skuId: loose },
    });
    assert.ok(r.ok);
    const snap = (await callRow(r.data.interactionId)).contextSnapshot as { stock?: { total: number } };
    assert.equal(snap.stock?.total, 30);
    assert.equal(await stockForSku(loose).then((s) => ("unavailable" in s ? -1 : s.total)), 30, "asking changes nothing");
    assert.equal((await db.select().from(erpFgEntries)).length, 1, "no ERP row was written");
  });

  test("a failed stock read is not a failed call", async () => {
    const unknown = await stockForSku("sku_that_does_not_exist");
    assert.deepEqual(unknown, { unavailable: true });
    const r = await inbound({
      callReason: "stock_availability",
      reasonDetail: { product: "Mystery", skuId: "sku_that_does_not_exist" },
    });
    assert.ok(r.ok);
    const snap = (await callRow(r.data.interactionId)).contextSnapshot as { stock?: { unavailable?: boolean } };
    assert.equal(snap.stock?.unavailable, true, "the failure is recorded, not hidden");
  });
});

/* ------------------------------------------------------------ complaint flow */

describe("a complaint reason still runs the existing complaint pipeline", () => {
  test("reason Complaint with the pre-set Complaint outcome creates the complaint, SLA and routing as before", async () => {
    const r = await inbound({
      callReason: "complaint",
      reasonDetail: {},
      outcome: "complaint",
      outcomeDetail: { requiredAction: "credit_note" },
      complaintCategory: "packaging_damage",
      complaintDescription: "Two drums leaking",
      nextActions: ["raise_complaint"],
    });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.ok(r.data.complaintId);
    const row = await callRow(r.data.interactionId);
    assert.equal(row.callReason, "complaint");
    assert.equal(row.outcome, "complaint");
  });
});

/* ------------------------------------------------------------------ history */

describe("the history draws what a call recorded", () => {
  test("the timeline and the call history both carry the detail", async () => {
    const r = await inbound({
      reasonDetail: { product: "PU Clear 20L", quotationRequired: "yes" },
      nextActions: ["send_quotation"],
      nextActionDate: addDays(TODAY, 2),
      opportunity: { product: "PU Clear 20L", estimatedValueRupees: 40_000 },
    });
    assert.ok(r.ok, r.ok ? "" : r.error);

    const page = await customerTimeline(customerId, { kind: "Call" });
    const entry = page.entries.find((e) => e.id === r.data.interactionId);
    assert.ok(entry?.detail, "the timeline call has detail");
    assert.equal(entry.detail.summary, "Price / Quotation · Purchase Person");
    assert.ok(entry.detail.lines.some((l) => l.label === "Opportunity" && /PU Clear 20L/.test(l.value)));
    assert.ok(entry.detail.lines.some((l) => l.label === "Next action"));

    const history = await listInteractions(50);
    assert.ok(history.find((h) => h.id === r.data.interactionId)?.detail);
  });

  test("a call logged before any of this draws exactly as it did", async () => {
    const callId = id("cal");
    await db.insert(calls).values({
      id: callId,
      customerId,
      userId: mgr.id,
      interactionType: "outbound_call",
      outcome: "no_order",
      notes: "old note",
      startedAt: new Date(),
    } as never);
    const page = await customerTimeline(customerId, { kind: "Call" });
    assert.equal(page.entries.find((e) => e.id === callId)?.detail, null);
    assert.equal((await listInteractions(50)).find((h) => h.id === callId)?.detail, null);
  });

  test("a timeline of other kinds carries no detail and is unchanged", async () => {
    await inbound({ opportunity: { product: "X" } });
    const page = await customerTimeline(customerId, {});
    for (const e of page.entries.filter((x) => x.kind !== "Call")) {
      assert.equal(e.detail, undefined);
    }
  });
});

/* ------------------------------------------------------ outbound unchanged */

describe("outbound calls and Order Received are untouched", () => {
  test("an outbound call refuses a reason, and stores no answer, snapshot or opportunity", async () => {
    const refused = await saveInteraction({
      customerId, interactionType: "outbound_call", outcome: "no_answer",
      outcomeDetail: { whyNoAnswer: "busy" }, callReason: "other", idempotencyKey: randomUUID(),
    } as never);
    assert.equal(refused.ok, false);

    const ok = await saveInteraction({
      customerId, interactionType: "outbound_call", outcome: "no_answer",
      outcomeDetail: { whyNoAnswer: "busy" }, idempotencyKey: randomUUID(),
    } as never);
    assert.ok(ok.ok, ok.ok ? "" : ok.error);
    const row = await callRow(ok.data.interactionId);
    assert.equal(row.opportunityAnswer, null);
    assert.equal(row.contextSnapshot, null);
  });

  test("an order received still writes its order", async () => {
    const r = await saveInteraction({
      customerId, interactionType: "order_received", orderDate: TODAY,
      productQuantities: { [loose]: 3 }, idempotencyKey: randomUUID(),
    } as never);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.ok(r.data.orderId);
  });

  test("a double-click still logs one call", async () => {
    const key = randomUUID();
    const a = await inbound({ idempotencyKey: key });
    const b = await inbound({ idempotencyKey: key });
    assert.ok(a.ok && b.ok);
    assert.equal(b.ok && b.data.duplicate, true);
    assert.equal((await db.select().from(calls)).length, 1);
  });
});
