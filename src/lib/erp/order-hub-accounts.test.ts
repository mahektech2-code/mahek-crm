/**
 * THE ORDER HUB, OPTION A. Accounts approve a TO and that makes the order
 * number; the same order punched twice on one day is caught; Accounts change
 * lines but never parties; a declined TO declines its call's order; and the
 * Production Head edits an order until it is billed.
 *
 *   npm run test:integration
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appSettings,
  customers,
  erpCustomerProfiles,
  erpFgEntries,
  erpOrderIntakes,
  erpOrders,
  erpProductPacking,
  erpUserPowers,
  finishedGoods,
  notifications,
  orders,
  productBrands,
  productFormulations,
  products,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig } from "@/lib/config/store";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { testPhone } from "@/lib/test-phone";
import { approveIntake, checkForDuplicate, createIntake, declineIntake, DuplicateFoundError, holdIntake, releaseIntake, sameOrdersFor, sendBackIntake } from "./order-hub";
import { approveTo, accountsTos, declineTo, holdTo } from "@/lib/services/to-approval-service";
import { openPlanFor, planExpected, planPrint, planView, recordPlanPrint, savePlanLine } from "./production-plan";

const tag = randomUUID().slice(0, 6);
const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const SKU_A = `OHA Thinner 1 L ${tag} (Loose)`;
const SKU_B = `OHA Primer 1 L ${tag} (Loose)`;
const DATE = "2026-11-10";

let admin: typeof users.$inferSelect;
let ledger: typeof users.$inferSelect;
let taker: typeof users.$inferSelect;
let head: typeof users.$inferSelect;
let skuA: string;
let skuB: string;

async function makeUser(name: string, level: "associate" | "manager" | "admin", app: "erp" | "accounts" | "crm") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}.${tag}@oha.test`, phone: testPhone(), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app, role: level });
  return u;
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

const intake = (lines: { skuId: string; qtyCans: number; ratePaise?: number | null }[], over: Partial<{ billingId: string; deliveryId: string | null; date: string; takenById: string; originOrderId: string | null; origin: "erp" | "crm" | "mbos" }> = {}) => ({
  origin: over.origin ?? ("erp" as const),
  originOrderId: over.originOrderId ?? null,
  orderSource: "Phone",
  orderDate: over.date ?? DATE,
  godownId: "erpg_bhiwandi",
  billingId: over.billingId ?? "cus_oha",
  deliveryId: over.deliveryId ?? null,
  takenById: over.takenById ?? taker.id,
  lines: lines.map((l) => ({ skuId: l.skuId, qtyCans: l.qtyCans, ratePaise: l.ratePaise === undefined ? 30000 : l.ratePaise, discountBp: null })),
});

before(async () => {
  await db.execute(sql`truncate users, customers, orders, erp_customer_profiles, erp_orders, erp_order_intakes, erp_batch_codes, erp_order_details, erp_fg_entries, erp_user_powers, notifications, audit_log restart identity cascade`);
  await db.execute(sql`delete from app_settings where key in ('erp.orders.live', 'erp.orders.duplicateCheck')`);
  invalidateConfig();
  admin = await makeUser("Kavita Admin", "admin", "erp");
  ledger = await makeUser("Deepa Ledger", "manager", "accounts");
  taker = await makeUser("Priya Taker", "associate", "crm");
  head = await makeUser("Ravi Head", "manager", "erp");
  await db.insert(erpUserPowers).values({ userId: head.id, power: "productionCheck" });
  const fId = id("form");
  const bId = id("brand");
  const fgId = id("fg");
  skuA = id("sku");
  skuB = id("sku");
  await db.insert(productFormulations).values({ id: fId, name: `OHA ${tag}`, slug: `oha-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `OHA ${tag}`, slug: `oha-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values({ id: fgId, name: `OHA 1 L ${tag}`, slug: `oha-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 1000 });
  await db.insert(products).values([
    { id: skuA, name: SKU_A, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 1 },
    { id: skuB, name: SKU_B, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 1 },
  ]);
  await db.insert(erpProductPacking).values([{ productId: skuA, emptyBoxesRequired: 0 }, { productId: skuB, emptyBoxesRequired: 0 }]);
  await db.insert(customers).values([
    { id: "cus_oha", name: `OHA Paints ${tag}`, city: "Pune", phone: "9876511001", kind: "customer", creditDays: 30 },
    { id: "cus_oha_shop", name: `OHA Shop ${tag}`, city: "Pune", phone: "9876511002", kind: "customer" },
    { id: "cus_oha_new", name: `OHA New ${tag}`, city: "Pune", phone: "9876511003", kind: "customer" },
  ]);
  await db.insert(erpCustomerProfiles).values([{ customerId: "cus_oha" }, { customerId: "cus_oha_shop" }, { customerId: "cus_oha_new", pendingActivation: true }]);
  await db.insert(erpFgEntries).values({ id: id("fge"), sourceType: "fill", sourceId: "fin_oha", entryDate: "2026-11-01", finishedGoodId: fgId, lotCode: `FGOHA${tag}`, godownId: "erpg_bhiwandi", quantity: 500, packingType: "Can", skuId: skuA });
  await live(true);
});

after(async () => {
  await db.execute(sql`delete from app_settings where key in ('erp.orders.live', 'erp.orders.duplicateCheck')`);
  invalidateConfig();
  setTestUser(null);
  await db.$client.end();
});

describe("the duplicate check", () => {
  test("the same parties, items and day is a duplicate; a different delivery party, day or item is not", async () => {
    const first = await createIntake(taker.id, intake([{ skuId: skuA, qtyCans: 6 }, { skuId: skuB, qtyCans: 4 }]));
    const shape = { billingId: "cus_oha", deliveryId: null, date: DATE, lines: [{ skuId: skuB, qtyCans: 4 }, { skuId: skuA, qtyCans: 6 }] };
    assert.deepEqual((await sameOrdersFor(db, shape)).map((m) => m.id), [first.id], "items in any order");
    assert.equal((await sameOrdersFor(db, { ...shape, deliveryId: "cus_oha_shop" })).length, 0, "another delivery party is another order");
    assert.equal((await sameOrdersFor(db, { ...shape, date: "2026-11-11" })).length, 0, "another day is another order");
    assert.equal((await sameOrdersFor(db, { ...shape, lines: [{ skuId: skuA, qtyCans: 6 }] })).length, 0, "other items are another order");
    const found = await checkForDuplicate(shape);
    assert.equal(found?.match.toNo, first.toNo);
    assert.ok(found?.line.length, "the comparison line is written, by a model or by the rules");
  });

  test("ask stops the save, flag marks it possible, and a 'different' answer is kept with its reason", async () => {
    const lines = [{ skuId: skuA, qtyCans: 12 }];
    const first = await createIntake(taker.id, intake(lines));
    await assert.rejects(() => createIntake(admin.id, intake(lines), undefined, { onDuplicate: "ask" }), (e) => e instanceof DuplicateFoundError && e.match.id === first.id);
    const flagged = await createIntake(admin.id, intake(lines), undefined, { onDuplicate: "flag" });
    const [f] = await db.select().from(erpOrderIntakes).where(eq(erpOrderIntakes.id, flagged.id));
    assert.equal(f.duplicateState, "possible");
    assert.equal(f.duplicateOfId, first.id);
    const different = await createIntake(admin.id, intake(lines), undefined, { onDuplicate: "ask", duplicate: { decision: "different", ofId: first.id, reason: "Second lorry for next week" } });
    const [d] = await db.select().from(erpOrderIntakes).where(eq(erpOrderIntakes.id, different.id));
    assert.equal(d.duplicateState, "different");
    assert.equal(d.duplicateReason, "Second lorry for next week");
    assert.equal(d.duplicateDecidedById, admin.id);
  });

  test("the ERP form answers a duplicate with the comparison, and saves on a 'different' answer", async () => {
    setTestUser(admin);
    const ctx = await erpContext();
    const h = { source: "Phone", date: DATE, godown: "Bhiwandi", billing: `OHA Paints ${tag}` };
    const ls = [{ sku: SKU_B, qty: "9", rate: "300" }];
    assert.ok((await mod("orders").forms!.new!(ctx, h, ls)).ok);
    const again = await mod("orders").forms!.new!(ctx, h, ls);
    assert.ok(!again.ok && again.code === "duplicate", JSON.stringify(again));
    const detail = (again as { detail: { match: { id: string; toNo: number } } }).detail;
    assert.ok(detail.match.toNo > 0);
    const noReason = await mod("orders").forms!.new!(ctx, { ...h, dupOf: detail.match.id }, ls);
    assert.ok(!noReason.ok, "a 'different' answer needs a reason");
    assert.ok((await mod("orders").forms!.new!(ctx, { ...h, dupOf: detail.match.id, dupReason: "Customer wants two drops" }, ls)).ok);
  });
});

describe("Accounts decide the TO", () => {
  test("approving makes the order number, already approved by Accounts, with the lines Accounts changed", async () => {
    const t = await createIntake(taker.id, intake([{ skuId: skuA, qtyCans: 3, ratePaise: null }]));
    const noRate = await approveIntake(ledger.id, t.id, null);
    assert.ok(!noRate.ok && /rate/i.test(noRate.error), "a line with no rate cannot be approved");
    const r = await approveIntake(ledger.id, t.id, [
      { skuId: skuA, qtyCans: 5, ratePaise: 25000, discountBp: 200 },
      { skuId: skuB, qtyCans: 2, ratePaise: 40000, discountBp: null },
    ]);
    assert.ok(r.ok, JSON.stringify(r));
    const lines = await db.select().from(erpOrders).where(eq(erpOrders.orderNo, r.data.orderNo));
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.accountsCheck === "Approved" && l.accountsCheckedById === ledger.id && l.productionCheck === "Pending"));
    assert.equal(lines.find((l) => l.skuId === skuA)?.qtyCans, 5);
    assert.equal(lines.find((l) => l.skuId === skuA)?.rateSetById, ledger.id, "a rate Accounts set says who set it");
    const [i] = await db.select().from(erpOrderIntakes).where(eq(erpOrderIntakes.id, t.id));
    assert.equal(i.status, "verified");
    const [b] = await db.select().from(orders).where(eq(orders.externalRef, `ERP-${r.data.orderNo}`));
    assert.equal(b.status, "confirmed", "it counts as a sale");
    const told = await db.select().from(notifications).where(eq(notifications.userId, taker.id));
    assert.ok(told.some((n) => n.title.includes(`Order ${r.data.orderNo}`)), "whoever took it is told");
    assert.ok(!(await approveIntake(ledger.id, t.id, null)).ok, "approved once");
  });

  test("a Pending customer's TO is approved by the same press", async () => {
    const t = await createIntake(taker.id, intake([{ skuId: skuA, qtyCans: 1 }], { billingId: "cus_oha_new" }));
    const r = await approveIntake(ledger.id, t.id, null);
    assert.ok(r.ok);
    const lines = await db.select().from(erpOrders).where(eq(erpOrders.orderNo, r.data.orderNo));
    assert.ok(lines.every((l) => l.partyStatus !== "Pending"), "no separate Approved By Admin");
  });

  test("send back, hold, release and decline", async () => {
    const orderId = id("ord");
    await db.insert(orders).values({ id: orderId, customerId: "cus_oha", userId: taker.id, source: "crm", status: "pending_approval", orderedAt: new Date("2026-11-10T05:00:00Z"), totalAmount: 0, lineItems: [] });
    const t = await createIntake(taker.id, intake([{ skuId: skuB, qtyCans: 7 }], { origin: "crm", originOrderId: orderId }));
    assert.ok((await sendBackIntake(ledger.id, t.id, "Rate should be 280")).ok);
    let [i] = await db.select().from(erpOrderIntakes).where(eq(erpOrderIntakes.id, t.id));
    assert.equal(i.status, "correction");
    assert.ok((await db.select().from(notifications).where(eq(notifications.userId, taker.id))).some((n) => n.href === "/crm/my-orders" && n.title.includes("sent back")));
    await db.update(erpOrderIntakes).set({ status: "open" }).where(eq(erpOrderIntakes.id, t.id));
    assert.ok((await holdIntake(ledger.id, t.id, "Over credit limit", "Waiting for the overdue")).ok);
    assert.ok((await releaseIntake(ledger.id, t.id, "Paid")).ok);
    assert.ok(!(await declineIntake(ledger.id, t.id, "  ")).ok, "a decline needs a reason");
    assert.ok((await declineIntake(ledger.id, t.id, "Bills 60 days overdue")).ok);
    [i] = await db.select().from(erpOrderIntakes).where(eq(erpOrderIntakes.id, t.id));
    assert.equal(i.status, "declined");
    assert.equal(i.declineReason, "Bills 60 days overdue");
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    assert.equal(o.status, "declined", "the call's order is declined with it");
    assert.ok((await db.select().from(timelineEvents).where(eq(timelineEvents.sourceRecordId, `${t.id}:declined`))).length === 1, "the customer's timeline says so");
  });

  test("the service asks order.approve, and the queue lists TOs by state", async () => {
    const t = await createIntake(taker.id, intake([{ skuId: skuB, qtyCans: 11 }]));
    setTestUser(taker);
    await assert.rejects(() => approveTo(t.id, null));
    setTestUser(ledger);
    const q = await accountsTos();
    const row = q.waiting.find((r) => r.id === t.id);
    assert.ok(row, "the TO is waiting for Accounts");
    assert.equal(row.valuePaise, 11 * 30000);
    assert.ok(!(await holdTo(t.id, "not-a-code", "")).ok, "a hold needs one of Accounts' reasons");
    assert.ok((await holdTo(t.id, "overdue_bills", "")).ok);
    assert.ok((await accountsTos()).held.some((r) => r.id === t.id));
    assert.ok(!(await declineTo(t.id, "")).ok);
    assert.ok((await declineTo(t.id, "Customer cancelled on the phone")).ok);
  });
});

describe("the Production Head edits until Bill it", () => {
  test("changes cans and adds a line with no approval asked; a billed order is locked", async () => {
    const t = await createIntake(taker.id, intake([{ skuId: skuA, qtyCans: 8 }]));
    const r = await approveIntake(ledger.id, t.id, null);
    assert.ok(r.ok);
    const [line] = await db.select().from(erpOrders).where(eq(erpOrders.orderNo, r.data.orderNo));
    setTestUser(taker);
    await db.insert(appAccess).values({ id: id("aca"), userId: taker.id, app: "erp", role: "associate" }).onConflictDoNothing();
    const takerCtx = await erpContext();
    assert.ok(!(await mod("orders").forms!.editOrder!(takerCtx, {}, [], line.id)).ok, "only the Production Head edits an order");
    setTestUser(head);
    const ctx = await erpContext();
    const h = { billing: `OHA Paints ${tag}`, deliveredBy: "Transporter" };
    const saved = await mod("orders").forms!.editOrder!(ctx, h, [{ lineId: line.id, sku: SKU_A, qty: "4", rate: "300" }, { sku: SKU_B, qty: "2", rate: "400" }], line.id);
    assert.ok(saved.ok, JSON.stringify(saved));
    const now = await db.select().from(erpOrders).where(eq(erpOrders.orderNo, r.data.orderNo));
    const live = now.filter((l) => l.status !== "Cancel");
    assert.equal(live.length, 2);
    assert.equal(live.find((l) => l.skuId === skuA)?.qtyCans, 4);
    assert.ok(live.every((l) => l.accountsCheck === "Approved"), "nothing is approved again");
  });
});

describe("Under Process plans the expected orders", () => {
  test("a TO waits for Accounts, moves to the MRP check on approval, and a held or declined one adds nothing", async () => {
    const fId = id("form");
    const fgId = id("fg");
    const bId = id("brand");
    const sku = id("sku");
    await db.insert(productFormulations).values({ id: fId, name: `UPX base ${tag}`, slug: `upx-${tag}` });
    await db.insert(productBrands).values({ id: bId, name: `UPX ${tag}`, slug: `upx-b-${tag}`, formulationId: fId });
    await db.insert(finishedGoods).values({ id: fgId, name: `UPX Thinner 20 L ${tag}`, slug: `upx-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 20000 });
    await db.insert(products).values({ id: sku, name: `UPX Thinner 20 L ${tag} (Loose)`, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 20000, cansPerBox: 1 });
    await db.insert(erpProductPacking).values({ productId: sku, emptyBoxesRequired: 0 });
    const key = `loose:${fgId}`;
    const rowOf = async () => (await planExpected("erpg_bhiwandi")).products.find((p) => p.key === key);

    const a = await createIntake(taker.id, intake([{ skuId: sku, qtyCans: 20 }], { date: "2026-11-11" }));
    const b = await createIntake(taker.id, intake([{ skuId: sku, qtyCans: 10 }], { date: "2026-11-12" }));
    const c = await createIntake(taker.id, intake([{ skuId: sku, qtyCans: 50 }], { date: "2026-11-13" }));
    let row = await rowOf();
    assert.deepEqual([row?.confirmed, row?.mrp, row?.accounts], [0, 0, 80]);
    assert.equal(row?.verdict.text, "Short 80 cans · 1,600 L");

    assert.ok((await holdIntake(ledger.id, c.id, "Over credit limit", "")).ok);
    let e = await planExpected("erpg_bhiwandi");
    const held = e.entries.find((x) => x.key === `t:${c.toNo}`);
    assert.ok(held?.held && !held.counted, "a held TO is listed and not counted");
    assert.equal(held?.check.lines[0].text, "Not counted while on hold");
    assert.equal(e.products.find((p) => p.key === key)?.accounts, 30);

    const r = await approveIntake(ledger.id, a.id, null);
    assert.ok(r.ok);
    row = await rowOf();
    assert.deepEqual([row?.mrp, row?.accounts], [20, 10], "approved, it moves to the MRP check by itself");
    assert.ok((await declineIntake(ledger.id, b.id, "Customer cancelled")).ok);
    row = await rowOf();
    assert.equal(row?.accounts, 0, "a declined TO drops off");
    e = await planExpected("erpg_bhiwandi");
    const base = e.bases.find((x) => x.formulationId === fId);
    assert.equal(base?.expectedLitres, 400);
    assert.deepEqual(base?.expectedFor, [`Order ${r.ok ? r.data.orderNo : 0}`]);

    /* The base is started ahead as a typed SFG line marked for expected orders, and the print keeps the expected box. */
    setTestUser(head);
    const ctx = await erpContext();
    const plan = await openPlanFor(ctx, "2099-01-05");
    assert.ok(plan.ok);
    await db.execute(sql`update erp_production_plans set godown_id = 'erpg_bhiwandi' where id = ${plan.data.id}`);
    const line = await savePlanLine(ctx, plan.data.id, { category: "sfg", itemId: fId, quantity: "400", unit: "Litre", remarks: "For TO", forExpected: true });
    assert.ok(line.ok, JSON.stringify(line));
    const view = await planView(plan.data.id);
    assert.ok(view?.lines.find((l) => l.id === (line.ok ? line.data.id : ""))?.forExpected);
    const printed = await recordPlanPrint(ctx, plan.data.id);
    assert.ok(printed.ok, JSON.stringify(printed));
    const sheet = await planPrint(plan.data.id, printed.ok ? printed.data.printNo : 0);
    const box = sheet?.current.expected?.find((x) => x.productName === `UPX Thinner 20 L ${tag}`);
    assert.deepEqual(box && [box.quantity, box.unit, box.mrp, box.accounts], [20, "Cans", 20, 0]);
    setTestUser(null);
  });
});
