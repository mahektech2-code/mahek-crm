/**
 * A customer's monthly target: what carries forward and what does not.
 *
 *   npm run test:integration
 *
 * §E5 of the brief plus the incident that prompted this file: a manager set
 * a customer's target by hand in August, and September silently replaced it
 * with a trailing-average default nobody asked for — the two are different
 * numbers by design (one is a decision, the other is a guess at what they
 * will buy), and nothing before this carried the decision forward. These
 * pin the carry-forward `seedMonthlyTargets` now does, and the cases where
 * it must NOT carry.
 *
 * Needs mahekone_test, which `npm run test:db` creates from the committed
 * migrations. The harness truncates between tests.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess, customers, monthlyTargets, orders, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { seedMonthlyTargets } from "@/lib/recompute";
import { listTargets, setTarget } from "@/lib/services/worklist-services";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let manager: typeof users.$inferSelect;

async function makeCustomer() {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Shop ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Mumbai",
      region: "Maharashtra",
      status: "active",
      ownerId: manager.id,
      salesAmId: manager.id,
    })
    .returning();
  return row;
}

async function targetFor(customerId: string, year: number, month: number) {
  const [row] = await db
    .select()
    .from(monthlyTargets)
    .where(
      and(
        eq(monthlyTargets.customerId, customerId),
        eq(monthlyTargets.year, year),
        eq(monthlyTargets.month, month),
      ),
    );
  return row ?? null;
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
    truncate table
      monthly_targets, sales_target_revisions, sales_target_categories,
      sales_targets, orders, calls, customers, users, app_settings
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
  /* The app grant, because a level on its own is not one: a capability hangs
     on (app, level) now, and `role: "manager"` with no `app_access` row is a
     manager of nothing. */
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

test("a target set BY HAND carries forward to a month nobody has touched", async () => {
  const c = await makeCustomer();
  await setTarget(c.id, 100_000, "2026-08");

  const created = await seedMonthlyTargets("2026-09");
  assert.equal(created, 1);

  const sep = await targetFor(c.id, 2026, 9);
  assert.equal(sep?.targetAmount, 100_000);
  assert.equal(sep?.isDefault, false, "a carried target is somebody's decision, not a guess");
  assert.equal(sep?.carriedForward, true);
});

test("a customer with no manual history gets a fresh default, not a carry", async () => {
  const c = await makeCustomer();

  await seedMonthlyTargets("2026-09");

  const sep = await targetFor(c.id, 2026, 9);
  assert.ok(sep, "every active customer ends up with a target");
  assert.equal(sep?.isDefault, true);
  assert.equal(sep?.carriedForward, false);
});

test("last month's AUTO-APPLIED default is never carried — only a real decision is", async () => {
  const c = await makeCustomer();
  await seedMonthlyTargets("2026-08"); // seeds a default for August

  const aug = await targetFor(c.id, 2026, 8);
  assert.equal(aug?.isDefault, true);

  await seedMonthlyTargets("2026-09");

  const sep = await targetFor(c.id, 2026, 9);
  assert.equal(sep?.carriedForward, false, "a guess does not get carried as though it were a decision");
});

test("a target already set for this month is left alone", async () => {
  const c = await makeCustomer();
  await setTarget(c.id, 100_000, "2026-08");
  await setTarget(c.id, 250_000, "2026-09"); // a manager already set September directly

  const created = await seedMonthlyTargets("2026-09");
  assert.equal(created, 0, "nothing to seed — September was already set");

  const sep = await targetFor(c.id, 2026, 9);
  assert.equal(sep?.targetAmount, 250_000);
  assert.equal(sep?.carriedForward, false);
});

test("saving a real target clears a carried-forward mark", async () => {
  const c = await makeCustomer();
  await setTarget(c.id, 100_000, "2026-08");
  await seedMonthlyTargets("2026-09");

  const before = await targetFor(c.id, 2026, 9);
  assert.equal(before?.carriedForward, true);

  await setTarget(c.id, 130_000, "2026-09");

  const after_ = await targetFor(c.id, 2026, 9);
  assert.equal(after_?.targetAmount, 130_000);
  assert.equal(after_?.carriedForward, false, "a manager has now looked at this month and decided");
});

/* ============================ what the month has ACHIEVED against that target */

/**
 * The other half of the screen, and it was wrong in three ways at once — all
 * of them invisible, because a figure that is merely too big looks like a good
 * month. The achievement subquery spelled three of `PURCHASE_STATUSES`' five
 * out as a literal, read `total_amount` (GST in) against a target typed
 * without it, and extracted the month in whatever zone the session was in.
 */

const PERIOD = "2026-08";

async function makeOrderFor(
  customerId: string,
  over: Partial<typeof orders.$inferInsert> = {},
) {
  const [row] = await db
    .insert(orders)
    .values({
      id: id("ord"),
      customerId,
      source: "external",
      status: "dispatched",
      orderedAt: new Date(`${PERIOD}-15T09:00:00+05:30`),
      totalAmount: 118_000_00,
      netAmountPaise: 100_000_00,
      ...over,
    })
    .returning();
  return row;
}

async function achievedFor(customerId: string) {
  const rows = await listTargets(PERIOD);
  const row = rows.find((r) => r.customerId === customerId);
  assert.ok(row, "the customer did not reach the targets list at all");
  return row.achieved;
}

test("achievement is the sale net of GST, not the figure the customer was billed", async () => {
  const c = await makeCustomer();
  await makeOrderFor(c.id);
  assert.equal(await achievedFor(c.id), 100_000_00);
});

test("AN ORDER THAT REACHED THE CUSTOMER STILL COUNTS", async () => {
  /*
   * The worst of the three. The literal held `captured`, `confirmed` and
   * `dispatched`, so recording that an order was in transit or delivered took
   * it back out of its customer's month — achievement going DOWN as the order
   * went further, and a gap reopening on a shop that had already bought.
   */
  for (const status of ["in_transit", "delivered"] as const) {
    const c = await makeCustomer();
    await makeOrderFor(c.id, { status });
    assert.equal(await achievedFor(c.id), 100_000_00, `${status} stopped counting`);
  }
});

test("and a declined order still counts for nothing", async () => {
  // The widening must not have reached the other list.
  const c = await makeCustomer();
  await makeOrderFor(c.id, { status: "declined" });
  assert.equal(await achievedFor(c.id), 0);
});

test("an order with no net stated counts at what was typed, never at zero", async () => {
  const c = await makeCustomer();
  await makeOrderFor(c.id, { source: "crm", netAmountPaise: null, totalAmount: 50_000_00 });
  assert.equal(await achievedFor(c.id), 50_000_00);
});

test("a 1am order on the FIRST belongs to that month, on a GMT database", async () => {
  /*
   * The zone rule, in its fourth spelling. `extract(month from ordered_at)`
   * reads the session's zone, so this order fell into July on any database not
   * set to Asia/Kolkata — and local Postgres is, which is why nothing here ever
   * saw it. The session is forced to GMT for the length of the read.
   */
  const c = await makeCustomer();
  await makeOrderFor(c.id, {
    orderedAt: new Date(`${PERIOD}-01T01:00:00+05:30`),
  });

  await db.execute(sql`set time zone 'GMT'`);
  try {
    assert.equal(await achievedFor(c.id), 100_000_00);
  } finally {
    await db.execute(sql`set time zone 'Asia/Kolkata'`);
  }
});

test("and an order on the LAST night of the month does not spill into the next", async () => {
  const c = await makeCustomer();
  await makeOrderFor(c.id, {
    orderedAt: new Date(`${PERIOD}-31T23:30:00+05:30`),
  });

  await db.execute(sql`set time zone 'GMT'`);
  try {
    assert.equal(await achievedFor(c.id), 100_000_00);
    const next = await listTargets("2026-09");
    assert.equal(next.find((r) => r.customerId === c.id)?.achieved, 0);
  } finally {
    await db.execute(sql`set time zone 'Asia/Kolkata'`);
  }
});
