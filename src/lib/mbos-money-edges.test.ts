/**
 * MONEY AT THE EDGES OF A FIELD SYNC — driven through `ingestSyncBatch` and
 * `buildPull`, the doors the phone uses.
 *
 *  - A collection naming a bill settled meanwhile is ACCEPTED, spread oldest
 *    first, and flagged on the receipt (it used to be refused `bill_settled`).
 *  - `mbos.credit.overdueDaysBlockOrders` refuses a new order (`overdue_blocked`).
 *  - The order number's financial year is the order's, not the sync day's.
 *  - `openOrdered` is ordered-not-yet-billed per billing party; a billed order
 *    leaves it.
 *  - `myPayments` carries accounts' decision on his own receipt.
 *  - An open bill older than the statement window still reaches the phone.
 *  - An order delivered to a shop is on that shop's Orders channel.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appSettings,
  bills,
  customers,
  mbosUserTerritories,
  orders,
  paymentReceipts,
  payments,
  products,
  users,
} from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { storedSettingValue } from "@/lib/config/storage";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { buildPull, encodeCursor, type MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let principal: MbosPrincipal;
let shopId: string;
let productId: string;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
});

async function setSetting(key: string, value: unknown, valueType: "integer" | "boolean") {
  await db
    .insert(appSettings)
    .values({ key, value: storedSettingValue(value), valueType, category: "mbos-credit", label: key })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: storedSettingValue(value) } });
  invalidateConfig();
}

beforeEach(async () => {
  await db.execute(sql`
    truncate table payments, payment_receipts, bills, orders, products, mbos_sync_receipts, mbos_user_territories,
      timeline_events, audit_log, notifications, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  const [salesman] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Mahesh", email: `${id("m")}@test.local`, passwordHash: "x", role: "associate", initials: "MP" })
    .returning();
  await db.insert(appAccess).values({ id: id("acc"), userId: salesman.id, app: "field" });
  await db.insert(mbosUserTerritories).values({ id: id("ut"), userId: salesman.id, kind: "state", region: "Maharashtra" });

  shopId = id("cus");
  await db.insert(customers).values({
    id: shopId,
    name: "Sai Paint Depot",
    phone: "9822200011",
    city: "Nagpur",
    territoryRegion: "Maharashtra",
    kind: "customer",
    ownerId: salesman.id,
    salesAmId: salesman.id,
  });
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "Nano Thinner 5 L" } as never);

  principal = { user: salesman, deviceId: "probe-device", role: "associate", scope: { kind: "own", userIds: [salesman.id] } } as MbosPrincipal;
});

after(async () => {
  await db.$client.end();
});

const item = (entityType: SyncItem["entityType"], payload: Record<string, unknown>, entityId = `mbos_${entityType}_${randomUUID()}`): SyncItem => ({
  queueId: id("q"),
  entityId,
  entityType,
  op: "create",
  idempotencyKey: `${entityId}:create`,
  clientCreatedAt: Date.now(),
  payload,
});

test("a collection naming a bill settled meanwhile is accepted, spread, and flagged", async () => {
  const settled = id("bil");
  const open = id("bil");
  await db.insert(bills).values([
    { id: settled, customerId: shopId, billNo: "B-OLD", billDate: "2026-08-01", amount: 500000, paidAmount: 500000 },
    { id: open, customerId: shopId, billNo: "B-NEW", billDate: "2026-10-01", amount: 300000 },
  ]);
  const pay = item("payment", { customerId: shopId, amountPaise: 400000, mode: "Cash", billIds: [settled] });
  const [r] = await ingestSyncBatch(principal, [pay]);
  assert.equal(r.status, "accepted", JSON.stringify(r));

  const lines = await db.select().from(payments).where(eq(payments.receiptId, pay.entityId));
  assert.deepEqual(
    lines.map((l) => [l.billId, Number(l.amount)]).sort((a, b) => Number(b[1]) - Number(a[1])),
    [[open, 300000], [null, 100000]],
  );
  const [receipt] = await db.select().from(paymentReceipts).where(eq(paymentReceipts.id, pay.entityId));
  assert.match(receipt.note ?? "", /B-OLD.*already settled/);
  assert.equal(receipt.status, "reported");
});

test("a bill past the overdue-days setting refuses a new order, and 0 lets it through", async () => {
  await db.insert(bills).values({ id: id("bil"), customerId: shopId, billNo: "B-LATE", billDate: "2026-01-01", dueDate: "2026-02-01", amount: 100000 } as never);
  const order = () =>
    item("order", { customerId: shopId, orderedAt: Date.now(), lines: [{ productId, quantityCans: 6 }], totalAmountPaise: 0, valueUnavailable: true });

  await setSetting("mbos.credit.overdueDaysBlockOrders", 90, "integer");
  const [refused] = await ingestSyncBatch(principal, [order()]);
  assert.equal(refused.status, "rejected");
  assert.equal((refused as { code?: string }).code, "overdue_blocked");

  await setSetting("mbos.credit.overdueDaysBlockOrders", 0, "integer");
  const [taken] = await ingestSyncBatch(principal, [order()]);
  assert.equal(taken.status, "accepted", JSON.stringify(taken));
});

test("an order taken on 31 March is numbered into the year it was taken in", async () => {
  const o = item("order", {
    customerId: shopId,
    orderedAt: Date.parse("2026-03-31T18:00:00+05:30"),
    lines: [{ productId, quantityCans: 6 }],
    totalAmountPaise: 0,
    valueUnavailable: true,
  });
  const [r] = await ingestSyncBatch(principal, [o]);
  assert.equal(r.status, "accepted", JSON.stringify(r));
  const [row] = await db.select({ orderNo: orders.orderNo }).from(orders).where(eq(orders.id, o.entityId));
  assert.match(row.orderNo ?? "", /25-26/);
});

test("the pull says what is ordered and not yet billed, the office's word on his receipt, and every open bill", async () => {
  const ordered = id("ord");
  const billed = id("ord");
  await db.insert(orders).values([
    { id: ordered, customerId: shopId, userId: principal.user.id, source: "mbos", status: "pending_approval", orderedAt: new Date(), totalAmount: 250000 },
    { id: billed, customerId: shopId, userId: principal.user.id, source: "mbos", status: "confirmed", orderedAt: new Date(), totalAmount: 900000 },
  ] as never);
  await db.insert(bills).values([
    { id: id("bil"), customerId: shopId, billNo: "B-BILLED", billDate: "2026-11-20", amount: 900000, orderId: billed },
    /* Far older than the thirteen-month window, and still owed. */
    { id: id("bil"), customerId: shopId, billNo: "B-ANCIENT", billDate: "2024-04-01", amount: 120000 },
  ] as never);
  const receiptId = id("rcp");
  await db.insert(paymentReceipts).values({
    id: receiptId,
    customerId: shopId,
    amount: 5000,
    receivedAt: "2026-11-20",
    status: "rejected",
    rejectReason: "Not in the bank",
    receiptNo: "MRCP/26-27/7",
    reportedById: principal.user.id,
    source: "mbos",
  } as never);

  const pull = await buildPull(principal, encodeCursor(new Date(Date.now() - 60_000)));
  assert.deepEqual(pull.openOrdered, [{ customerId: shopId, paise: 250000 }], "the billed order is not counted");
  assert.deepEqual(
    pull.myPayments?.map((p) => [p.id, p.status, p.reason, p.receiptNo]),
    [[receiptId, "rejected", "Not in the bank", "MRCP/26-27/7"]],
  );

  const missing = await buildPull(principal, encodeCursor(new Date(Date.now() - 60_000)), { missingIds: [shopId] });
  const billNos = (missing.customerBills as { billNo: string }[]).map((b) => b.billNo);
  assert.ok(billNos.includes("B-ANCIENT"), "an open bill older than the window still reaches the phone");
});

test("an order delivered to a shop is on that shop's Orders channel too", async () => {
  const distributor = id("cus");
  await db.insert(customers).values({
    id: distributor,
    name: "Om Distributors",
    phone: "9822200099",
    city: "Nagpur",
    territoryRegion: "Maharashtra",
    kind: "customer",
    ownerId: principal.user.id,
    salesAmId: principal.user.id,
  });
  const o = id("ord");
  await db.insert(orders).values({
    id: o,
    customerId: distributor,
    deliveryCustomerId: shopId,
    userId: principal.user.id,
    source: "mbos",
    status: "pending_approval",
    orderedAt: new Date(),
    totalAmount: 100000,
  } as never);
  const pull = await buildPull(principal, encodeCursor(new Date(Date.now() - 60_000)));
  const rows = pull.customerOrders as { id: string; customerId: string }[];
  assert.ok(rows.some((r) => r.id === o && r.customerId === distributor), "billed to the distributor");
  assert.ok(rows.some((r) => r.id === `${o}@${shopId}` && r.customerId === shopId), "and delivered to the shop");
});
