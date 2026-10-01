/**
 * CHANGING A FIELD ORDER, END TO END.
 *
 * Until accounts decide an order, its author edits it from the handset. After
 * they approve it, a change is a REQUEST: accounts accept it (and the order is
 * rewritten) or decline it with a reason. And the handset hears all of it —
 * the order's status and lines on `myOrders`, the request's answer on
 * `orderChanges` — which before this it never did: an accounts decision did
 * not reach the phone at all. Driven through `ingestSyncBatch`, the door the
 * phone uses, and the Accounts services, with nothing stubbed.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  customers,
  mbosUserTerritories,
  notifications,
  orderChangeRequests,
  orders,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { buildBootstrap, buildPull, encodeCursor, type MbosPrincipal } from "@/lib/services/mbos-service";
import { approveOrder, orderLines } from "@/lib/services/order-approval-service";
import { decideOrderChange, listOrderChanges } from "@/lib/services/order-change-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let salesman: typeof users.$inferSelect;
let deepa: typeof users.$inferSelect;
let principal: MbosPrincipal;
let shopId: string;
let skuA: string;
let skuB: string;

function item(over: Partial<SyncItem> & Pick<SyncItem, "entityType" | "payload">): SyncItem {
  const entityId = over.entityId ?? id("mbos");
  return {
    queueId: id("q"),
    entityId,
    op: "create",
    idempotencyKey: `${entityId}:${over.op ?? "create"}:${randomUUID()}`,
    clientCreatedAt: Date.now(),
    ...over,
  };
}

async function placeOrder(cans = 5) {
  const orderId = `mbos_order_${randomUUID()}`;
  const [r] = await ingestSyncBatch(principal, [
    item({
      entityType: "order",
      entityId: orderId,
      payload: { id: orderId, customerId: shopId, orderedAt: Date.now(), totalAmountPaise: 0, lines: [{ productId: skuA, quantityCans: cans }] },
    }),
  ]);
  assert.equal(r.status, "accepted", JSON.stringify(r));
  return orderId;
}

const edit = (orderId: string, lines: { productId: string; quantityCans: number }[]) =>
  item({ entityType: "order", entityId: orderId, op: "update", payload: { id: orderId, lines, totalAmountPaise: 0 } });

const askChange = (orderId: string, lines: { productId: string; quantityCans: number }[], note = "Shop rang for more") =>
  item({ entityType: "order_change_request", payload: { orderId, lines, totalAmountPaise: 0, note } });

const row = async (orderId: string) => (await db.select().from(orders).where(eq(orders.id, orderId)))[0];

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table order_change_requests, orders, mbos_sync_receipts, mbos_user_territories, timeline_events,
      audit_log, notifications, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  [salesman] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Mahesh", email: `${id("m")}@test.local`, passwordHash: "x", role: "associate", initials: "MP" })
    .returning();
  await db.insert(appAccess).values({ id: id("acc"), userId: salesman.id, app: "field" });
  await db.insert(mbosUserTerritories).values({ id: id("ut"), userId: salesman.id, kind: "state", region: "Maharashtra" });

  [deepa] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Deepa", email: `${id("d")}@test.local`, passwordHash: "x", role: "manager", initials: "DK" })
    .returning();
  await db.insert(appAccess).values({ id: id("acc"), userId: deepa.id, app: "accounts", role: "manager" });

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

  const made = await db
    .insert(products)
    .values([
      { id: id("prd"), name: `Nano Thinner 5 L ${randomUUID().slice(0, 6)}`, packing: "Loose", millilitresPerCan: 5000, cansPerBox: 1 },
      { id: id("prd"), name: `Nano Thinner 20 L ${randomUUID().slice(0, 6)}`, packing: "Loose", millilitresPerCan: 20000, cansPerBox: 1 },
    ])
    .returning({ id: products.id });
  [skuA, skuB] = made.map((m) => m.id);

  principal = { user: salesman, deviceId: "probe-device", role: "associate", scope: { kind: "own", userIds: [salesman.id] } } as MbosPrincipal;
});

after(async () => {
  await db.$client.end();
});

describe("Before accounts decide, the salesman edits his own order", () => {
  test("an edit rewrites the lines, and accounts see them in the queue", async () => {
    const orderId = await placeOrder(5);
    const [r] = await ingestSyncBatch(principal, [edit(orderId, [{ productId: skuA, quantityCans: 8 }, { productId: skuB, quantityCans: 2 }])]);
    assert.equal(r.status, "accepted", JSON.stringify(r));

    const after = await row(orderId);
    assert.equal(after.status, "pending_approval");
    assert.deepEqual(after.lineItems?.map((l) => l.quantity), [8, 2]);

    /* A field order's lines are on the order, not on a call — the drawer read
       only the second and showed every MBOS order empty. */
    const drawn = await orderLines(orderId);
    assert.deepEqual(drawn.map((l) => l.quantity).sort(), [2, 8]);
  });

  test("once approved, an edit is refused and points at a change request", async () => {
    const orderId = await placeOrder(5);
    setTestUser(deepa);
    assert.equal((await approveOrder(orderId)).ok, true);

    const [r] = await ingestSyncBatch(principal, [edit(orderId, [{ productId: skuA, quantityCans: 9 }])]);
    assert.equal(r.status, "rejected", JSON.stringify(r));
    assert.match(JSON.stringify(r), /change request/);
    assert.deepEqual((await row(orderId)).lineItems?.map((l) => l.quantity), [5]);
  });
});

describe("After approval, a change is a request accounts decide", () => {
  test("asked, accepted, the order rewritten, and the salesman told", async () => {
    const orderId = await placeOrder(5);
    setTestUser(deepa);
    await approveOrder(orderId);

    const ask = askChange(orderId, [{ productId: skuA, quantityCans: 12 }]);
    const [r] = await ingestSyncBatch(principal, [ask]);
    assert.equal(r.status, "accepted", JSON.stringify(r));

    const [waiting] = await listOrderChanges();
    assert.equal(waiting.status, "pending");
    assert.deepEqual(waiting.previousLineItems?.map((l) => l.quantity), [5]);
    const told = await db.select().from(notifications).where(eq(notifications.userId, deepa.id));
    assert.ok(told.some((n) => /Change requested/.test(n.title)), "accounts were not told");

    /* One at a time. */
    const [second] = await ingestSyncBatch(principal, [askChange(orderId, [{ productId: skuA, quantityCans: 20 }])]);
    assert.equal(second.status, "rejected");

    setTestUser(deepa);
    assert.equal((await decideOrderChange(ask.entityId, "accept", null)).ok, true);
    assert.deepEqual((await row(orderId)).lineItems?.map((l) => l.quantity), [12]);
    const [req] = await db.select().from(orderChangeRequests).where(eq(orderChangeRequests.id, ask.entityId));
    assert.equal(req.status, "accepted");

    const heard = await db.select().from(notifications).where(eq(notifications.userId, salesman.id));
    assert.ok(heard.some((n) => /Change accepted/.test(n.title)), "the salesman was not told");
  });

  test("a decline needs a reason and leaves the order as approved", async () => {
    const orderId = await placeOrder(5);
    setTestUser(deepa);
    await approveOrder(orderId);
    const ask = askChange(orderId, [{ productId: skuB, quantityCans: 3 }]);
    await ingestSyncBatch(principal, [ask]);

    setTestUser(deepa);
    assert.equal((await decideOrderChange(ask.entityId, "decline", "  ")).ok, false);
    assert.equal((await decideOrderChange(ask.entityId, "decline", "Already loaded")).ok, true);
    assert.deepEqual((await row(orderId)).lineItems?.map((l) => l.quantity), [5]);
  });

  test("a change cannot be asked on an order accounts have not decided", async () => {
    const orderId = await placeOrder(5);
    const [r] = await ingestSyncBatch(principal, [askChange(orderId, [{ productId: skuA, quantityCans: 7 }])]);
    assert.equal(r.status, "rejected");
    assert.match(JSON.stringify(r), /edited directly/);
  });
});

describe("The handset hears every decision", () => {
  test("the bootstrap and the delta carry the order's status and the request's answer", async () => {
    const orderId = await placeOrder(5);
    const boot = await buildBootstrap(principal);
    const mine = (boot.myOrders as { id: string; status: string }[]).find((o) => o.id === orderId);
    assert.equal(mine?.status, "pending_approval");

    const cursor = encodeCursor(new Date(Date.now() - 1000));
    setTestUser(deepa);
    await approveOrder(orderId);
    const ask = askChange(orderId, [{ productId: skuA, quantityCans: 6 }]);
    await ingestSyncBatch(principal, [ask]);
    setTestUser(deepa);
    await decideOrderChange(ask.entityId, "decline", "Lorry already loaded");

    const delta = await buildPull(principal, cursor);
    const status = (delta.myOrders as { id: string; status: string }[]).find((o) => o.id === orderId)?.status;
    assert.equal(status, "confirmed");
    const answer = (delta.orderChanges as { id: string; status: string; decisionNote: string }[]).find(
      (c) => c.id === ask.entityId,
    );
    assert.equal(answer?.status, "declined");
    assert.equal(answer?.decisionNote, "Lorry already loaded");
  });
});
