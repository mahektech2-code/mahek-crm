/**
 * AN ORDER TURNED DOWN GOES THROUGH WHAT IT AFFECTS FIRST.
 *
 * Cancelling one's own TO, Accounts declining a TO or sending one back, and
 * declining a numbered order each take a reason and used to write at once.
 * Each now asks the impact modal's confirmation: refused without it, refused
 * to anybody who may not decide it, and written once the report's word and
 * fingerprint come back — with the reason kept.
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
  customers,
  erpCustomerProfiles,
  erpOrderIntakes,
  erpProductPacking,
  finishedGoods,
  orders,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { testPhone } from "@/lib/test-phone";
import { createIntake } from "@/lib/erp/order-hub";
import { impactReport } from "@/lib/impact/registry";
import type { ImpactConfirmation } from "@/lib/impact/types";
import { cancelMyToAction } from "@/lib/actions/my-orders";
import { declineToAction, sendBackToAction } from "@/lib/actions/to-approval";
import { declineOrderAction } from "@/lib/actions/orders";

const tag = randomUUID().slice(0, 6);
const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const CUSTOMER = "cus_odi";

let ledger: typeof users.$inferSelect;
let taker: typeof users.$inferSelect;
let other: typeof users.$inferSelect;
let sku: string;

async function makeUser(name: string, level: "associate" | "manager", app: "accounts" | "crm") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}.${tag}@odi.test`, phone: testPhone(), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app, role: level });
  return u;
}

/** A TO taken on a CRM call, with the CRM order row beside it. */
async function crmTo() {
  const [order] = await db
    .insert(orders)
    .values({ id: id("ord"), customerId: CUSTOMER, userId: taker.id, orderedAt: new Date(), totalAmount: 60_000, status: "pending_approval", source: "crm" })
    .returning();
  const made = await createIntake(taker.id, {
    origin: "crm",
    originOrderId: order.id,
    orderSource: "Phone",
    orderDate: "2026-11-10",
    godownId: "erpg_bhiwandi",
    billingId: CUSTOMER,
    deliveryId: null,
    takenById: taker.id,
    lines: [{ skuId: sku, qtyCans: Math.floor(Math.random() * 90) + 2, ratePaise: 30000, discountBp: null }],
  });
  return { intakeId: made.id, orderId: order.id, toNo: made.toNo };
}

/** What the modal hands back: the report's word, typed, and its fingerprint. */
async function confirmationFor(kind: string, key: string): Promise<ImpactConfirmation> {
  const r = await impactReport(kind, key);
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.deepEqual(r.data.blockers, [], "nothing blocks it");
  return { typed: r.data.confirmWord, fingerprint: r.data.fingerprint };
}

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against a mahekone_test database.");
  await db.execute(sql`truncate users, customers, orders, erp_customer_profiles, erp_orders, erp_order_intakes, notifications, audit_log, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  ledger = await makeUser("Deepa Ledger", "manager", "accounts");
  taker = await makeUser("Priya Taker", "associate", "crm");
  other = await makeUser("Rakesh Other", "associate", "crm");
  const fId = id("form");
  const bId = id("brand");
  const fgId = id("fg");
  sku = id("sku");
  await db.insert(productFormulations).values({ id: fId, name: `ODI ${tag}`, slug: `odi-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `ODI ${tag}`, slug: `odi-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values({ id: fgId, name: `ODI 1 L ${tag}`, slug: `odi-fg-${tag}`, brandId: bId, formulationId: fId, millilitres: 1000 });
  await db.insert(products).values({ id: sku, name: `ODI Thinner 1 L ${tag} (Loose)`, finishedGoodId: fgId, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 1 });
  await db.insert(erpProductPacking).values({ productId: sku, emptyBoxesRequired: 0 });
  await db.insert(customers).values({ id: CUSTOMER, name: `ODI Paints ${tag}`, city: "Pune", phone: "9876512001", kind: "customer", ownerId: taker.id });
  await db.insert(erpCustomerProfiles).values({ customerId: CUSTOMER });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("the taker cancels their own TO", () => {
  test("refused without the confirmation, refused to anybody else, written with it", async () => {
    const t = await crmTo();
    setTestUser(taker);
    const bare = await cancelMyToAction({ intakeId: t.intakeId, reason: "Customer changed his mind" });
    assert.equal(bare.ok, false);
    assert.equal(!bare.ok && bare.code, "validation");

    setTestUser(other);
    const notTheirs = await impactReport("crm-to-cancel", t.intakeId);
    assert.equal(notTheirs.ok, false, "the report is not shown to somebody who did not take it");
    const refused = await cancelMyToAction({ intakeId: t.intakeId, reason: "x", confirmation: { typed: `TO-${t.toNo}`, fingerprint: "x" } });
    assert.equal(!refused.ok && refused.code, "not_permitted");

    setTestUser(taker);
    const report = await impactReport("crm-to-cancel", t.intakeId);
    assert.ok(report.ok);
    assert.equal(report.data.confirmWord, `TO-${t.toNo}`);
    assert.ok(report.data.items.some((i) => i.app === "CRM" && /order/.test(i.label)), "it names the CRM order beside the TO");
    const done = await cancelMyToAction({ intakeId: t.intakeId, reason: "Customer changed his mind", confirmation: { typed: report.data.confirmWord, fingerprint: report.data.fingerprint } });
    assert.ok(done.ok, done.ok ? "" : done.error);
    const [row] = await db.select().from(erpOrderIntakes).where(eq(erpOrderIntakes.id, t.intakeId));
    assert.equal(row.status, "cancelled");
    assert.equal(row.cancelReason, "Customer changed his mind");
    const [o] = await db.select().from(orders).where(eq(orders.id, t.orderId));
    assert.equal(o.status, "cancelled");

    const again = await impactReport("crm-to-cancel", t.intakeId);
    assert.ok(again.ok && again.data.blockers.length, "a cancelled TO says why it cannot be cancelled again");
  });
});

describe("Accounts decline or send back a TO", () => {
  test("send back: refused bare, refused to the taker, written with the confirmation", async () => {
    const t = await crmTo();
    setTestUser(ledger);
    const bare = await sendBackToAction(t.intakeId, "Rate should be 280");
    assert.equal(bare.ok, false);

    setTestUser(taker);
    const notAccounts = await sendBackToAction(t.intakeId, "Rate should be 280", { typed: `TO-${t.toNo}`, fingerprint: "x" });
    assert.equal(notAccounts.ok, false, "only Accounts decide a TO");
    assert.equal((await impactReport("accounts-to-send-back", t.intakeId)).ok, false);

    setTestUser(ledger);
    const done = await sendBackToAction(t.intakeId, "Rate should be 280", await confirmationFor("accounts-to-send-back", t.intakeId));
    assert.ok(done.ok, done.ok ? "" : done.error);
    const [row] = await db.select().from(erpOrderIntakes).where(eq(erpOrderIntakes.id, t.intakeId));
    assert.equal(row.status, "correction");
    assert.equal(row.correctionNote, "Rate should be 280");
  });

  test("decline: refused bare, written with the confirmation, the CRM order declined with the reason", async () => {
    const t = await crmTo();
    setTestUser(ledger);
    assert.equal((await declineToAction(t.intakeId, "Bills 60 days overdue")).ok, false);
    const empty = await declineToAction(t.intakeId, "  ");
    assert.equal(empty.ok, false, "a reason is still the service's to ask for");

    setTestUser(taker);
    assert.equal((await declineToAction(t.intakeId, "Bills 60 days overdue", { typed: `TO-${t.toNo}`, fingerprint: "x" })).ok, false);

    setTestUser(ledger);
    const stale = await declineToAction(t.intakeId, "Bills 60 days overdue", { typed: `TO-${t.toNo}`, fingerprint: "stale" });
    assert.equal(!stale.ok && stale.code, "conflict", "a picture that moved is refused as a conflict");
    const done = await declineToAction(t.intakeId, "Bills 60 days overdue", await confirmationFor("accounts-to-decline", t.intakeId));
    assert.ok(done.ok, done.ok ? "" : done.error);
    const [o] = await db.select().from(orders).where(eq(orders.id, t.orderId));
    assert.equal(o.status, "declined");
    assert.equal(o.declineReason, "Bills 60 days overdue");
  });
});

describe("Accounts decline a numbered order", () => {
  test("refused bare, refused without the capability, written with the confirmation", async () => {
    const [order] = await db
      .insert(orders)
      .values({ id: id("ord"), customerId: CUSTOMER, userId: taker.id, orderedAt: new Date(), totalAmount: 5_000_00, status: "pending_approval" })
      .returning();
    setTestUser(ledger);
    assert.equal((await declineOrderAction(order.id, "Over the limit.")).ok, false);

    setTestUser(taker);
    const notAccounts = await declineOrderAction(order.id, "Over the limit.", { typed: "DECLINE", fingerprint: "x" });
    assert.equal(!notAccounts.ok && notAccounts.code, "not_permitted");

    setTestUser(ledger);
    const report = await impactReport("accounts-order-decline", order.id);
    assert.ok(report.ok, report.ok ? "" : report.error);
    assert.ok(report.data.items.some((i) => /buying cycle/.test(i.label)));
    assert.ok(report.data.items.some((i) => /Priya Taker/.test(i.label)), "the taker is named as told");
    const done = await declineOrderAction(order.id, "Over the limit.", { typed: report.data.confirmWord, fingerprint: report.data.fingerprint });
    assert.ok(done.ok, done.ok ? "" : done.error);
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    assert.equal(o.status, "declined");
    assert.equal(o.declineReason, "Over the limit.");
  });

  test("a CRM order still a TO is blocked in the report, in the service's words", async () => {
    const t = await crmTo();
    setTestUser(ledger);
    const report = await impactReport("accounts-order-decline", t.orderId);
    assert.ok(report.ok);
    assert.match(report.data.blockers[0] ?? "", new RegExp(`still TO-${t.toNo}`));
  });
});
