/**
 * `customers.typical_order_paise` must equal the subquery it replaced.
 *
 *   npm run test:integration
 *
 * The queue's candidate scan used to derive what a call is worth with a
 * correlated `percentile_cont(0.5)` per customer — the largest single
 * component of the most expensive statement in the app. It is a cache now,
 * written by `writeCycle` from rows it already reads.
 *
 * A cache is only worth having if it holds the same answer, so these compare
 * the written column against the ORIGINAL SQL, run live against the same rows,
 * rather than against a second JavaScript median that could drift with it. The
 * even-count case is the one that matters: `percentile_cont` interpolates
 * between the two middle values, and a naive median picks one of them.
 *
 * Needs mahekone_test, which `npm run test:db` creates from the committed
 * migrations. The harness truncates between tests.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, orders, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { recomputeBuyingCycle } from "@/lib/recompute";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let manager: typeof users.$inferSelect;

/** The expression `queueInputs` carried, asked of the database as it stood. */
async function subqueryAnswer(customerId: string, lookbackDays = 365) {
  const rows = await db.execute<{ v: string }>(sql`
    select coalesce((
      select percentile_cont(0.5) within group (order by o.total_amount)
        from orders o
       where o.customer_id = ${customerId}
         and o.status in ('captured','confirmed','dispatched','in_transit','delivered')
         and o.ordered_at >= now() - make_interval(days => ${lookbackDays})
    ), 0)::bigint as v
  `);
  return Number(rows[0]?.v ?? 0);
}

async function cachedAnswer(customerId: string) {
  const [row] = await db
    .select({ v: customers.typicalOrderPaise })
    .from(customers)
    .where(eq(customers.id, customerId));
  return Number(row?.v ?? 0);
}

async function makeCustomer() {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Shop ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nagpur",
      region: "Maharashtra",
      status: "active",
      ownerId: manager.id,
      salesAmId: manager.id,
    })
    .returning();
  return row;
}

async function placeOrder(
  customerId: string,
  amount: number,
  daysAgo: number,
  status: "captured" | "declined" | "pending_approval" = "captured",
) {
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await db.insert(orders).values({
    id: id("ord"),
    customerId,
    userId: manager.id,
    status,
    totalAmount: amount,
    orderedAt: at,
    createdAt: at,
  });
}

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table orders, calls, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Manager",
      email: `manager-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "manager",
      initials: "MG",
    })
    .returning();
  await db.insert(appAccess).values({
    id: id("aca"),
    userId: row.id,
    app: "crm",
    role: "manager",
  });
  manager = row;
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("an ODD number of orders — the cache is the middle one, and the subquery agrees", async () => {
  const c = await makeCustomer();
  // Deliberately SKEWED: the mean of these is 37,333 and the median is 12,000.
  // Symmetric amounts would let a mean-based implementation pass this test,
  // which is the whole failure this file exists to catch.
  for (const [amount, daysAgo] of [
    [10_000, 30],
    [90_000, 60],
    [12_000, 90],
  ] as const) {
    await placeOrder(c.id, amount, daysAgo);
  }
  await recomputeBuyingCycle(c.id);

  assert.equal(await cachedAnswer(c.id), 12_000);
  assert.equal(await cachedAnswer(c.id), await subqueryAnswer(c.id));
});

test("an EVEN number interpolates, which is where a naive median would diverge", async () => {
  const c = await makeCustomer();
  for (const [amount, daysAgo] of [
    [10_000, 30],
    [20_000, 60],
    [30_000, 90],
    [90_000, 120],
  ] as const) {
    await placeOrder(c.id, amount, daysAgo);
  }
  await recomputeBuyingCycle(c.id);

  // percentile_cont averages the two middle values: (20_000 + 30_000) / 2.
  assert.equal(await cachedAnswer(c.id), 25_000);
  assert.equal(await cachedAnswer(c.id), await subqueryAnswer(c.id));
});

test("an odd amount rounds the same way the ::bigint cast did", async () => {
  const c = await makeCustomer();
  await placeOrder(c.id, 10_001, 30);
  await placeOrder(c.id, 10_002, 60);
  await recomputeBuyingCycle(c.id);

  // (10_001 + 10_002) / 2 = 10_001.5, and both sides must land on the same
  // integer — this is the case a different rounding rule would split.
  assert.equal(await cachedAnswer(c.id), await subqueryAnswer(c.id));
});

test("orders that were never a sale do not count, on either side", async () => {
  const c = await makeCustomer();
  await placeOrder(c.id, 10_000, 30);
  await placeOrder(c.id, 11_000, 35);
  await placeOrder(c.id, 80_000, 38);
  await placeOrder(c.id, 900_000, 40, "declined");
  await placeOrder(c.id, 900_000, 50, "pending_approval");
  await recomputeBuyingCycle(c.id);

  // Median of the three that count is 11,000; their mean is 33,667, and
  // letting the two refused ones in would move both.
  assert.equal(await cachedAnswer(c.id), 11_000);
  assert.equal(await cachedAnswer(c.id), await subqueryAnswer(c.id));
});

test("orders outside the lookback window are ignored, on either side", async () => {
  const c = await makeCustomer();
  await placeOrder(c.id, 10_000, 30);
  await placeOrder(c.id, 11_000, 60);
  await placeOrder(c.id, 80_000, 90);
  await placeOrder(c.id, 900_000, 500); // older than the 365-day default
  await recomputeBuyingCycle(c.id);

  assert.equal(await cachedAnswer(c.id), 11_000);
  assert.equal(await cachedAnswer(c.id), await subqueryAnswer(c.id));
});

test("a customer with no orders is zero, not null — the coalesce the subquery had", async () => {
  const c = await makeCustomer();
  await recomputeBuyingCycle(c.id);

  assert.equal(await cachedAnswer(c.id), 0);
  assert.equal(await cachedAnswer(c.id), await subqueryAnswer(c.id));
});

test("the cache moves when a new order lands and the cycle is recomputed", async () => {
  const c = await makeCustomer();
  await placeOrder(c.id, 10_000, 30);
  await recomputeBuyingCycle(c.id);
  assert.equal(await cachedAnswer(c.id), 10_000);

  await placeOrder(c.id, 12_000, 2);
  await placeOrder(c.id, 90_000, 1);
  await recomputeBuyingCycle(c.id);

  assert.equal(await cachedAnswer(c.id), 12_000);
  assert.equal(await cachedAnswer(c.id), await subqueryAnswer(c.id));
});
