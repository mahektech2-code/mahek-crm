/**
 * A FIELD PAYMENT'S REMAINDER IS ON ACCOUNT ONCE.
 *
 * allocate() puts the money no bill takes into its lines as a billId-null
 * line. The handset door inserted every line and then a second on-account line
 * of its own, so ₹10,000 against ₹6,000 open saved ₹14,000 of lines: ₹6,000 on
 * the bill and ₹4,000 on account twice. Driven through ingestSyncBatch, the
 * door the phone uses.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, bills, customers, mbosUserTerritories, payments, users } from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let principal: MbosPrincipal;
let shopId: string;
let billId: string;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table payments, payment_receipts, bills, mbos_sync_receipts, mbos_user_territories, timeline_events,
      audit_log, notifications, app_access, customers, users, app_settings
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
  billId = id("bil");
  await db.insert(bills).values({ id: billId, customerId: shopId, billNo: "B-1", billDate: "2026-10-01", amount: 600000 });

  principal = { user: salesman, deviceId: "probe-device", role: "associate", scope: { kind: "own", userIds: [salesman.id] } } as MbosPrincipal;
});

after(async () => {
  await db.$client.end();
});

test("₹10,000 against ₹6,000 open saves ₹6,000 on the bill and ₹4,000 on account, once", async () => {
  const entityId = `mbos_payment_${randomUUID()}`;
  const item: SyncItem = {
    queueId: id("q"),
    entityId,
    entityType: "payment",
    op: "create",
    idempotencyKey: `${entityId}:create`,
    clientCreatedAt: Date.now(),
    payload: { customerId: shopId, amountPaise: 1_000_000, mode: "Cash" },
  };
  const [r] = await ingestSyncBatch(principal, [item]);
  assert.equal(r.status, "accepted", JSON.stringify(r));

  const lines = await db.select().from(payments).where(eq(payments.receiptId, entityId));
  const total = lines.reduce((s, l) => s + Number(l.amount), 0);
  assert.equal(total, 1_000_000, "the lines add up to the receipt, no more");
  assert.deepEqual(
    lines.map((l) => [l.billId, Number(l.amount)]).sort((a, b) => Number(b[1]) - Number(a[1])),
    [
      [billId, 600000],
      [null, 400000],
    ],
  );
});
