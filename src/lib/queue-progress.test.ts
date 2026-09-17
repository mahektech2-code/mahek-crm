/**
 * The dashboard's four integers, against the Call Log's own.
 *
 * `queueProgress` exists so the dashboard can print "12 / 40, 28 still to
 * work" without building the ranked list, the call-panel detail for every row
 * on it and the carried-over count. What it must never do is arrive at a
 * different answer: a telecaller reads the figure on the dashboard and the
 * figure on the Call Log as one number, and nothing on either screen would say
 * which of them was lying.
 *
 * So every assertion here is an EQUALITY against `getQueue`, taken on both
 * sides of the one thing that changes how the answer is reached — whether the
 * business day has been settled into `queue_snapshots` yet. The unsettled path
 * builds the list from the book; the settled path rebuilds it from the stored
 * rows and lets today's live state decide what is still callable. Those are
 * two different pieces of arithmetic and both have to agree.
 *
 *   DATABASE_URL=…/mahekone_test NODE_ENV=test \
 *     npx tsx --conditions=react-server --test src/lib/queue-progress.test.ts
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, calls, customers, queueSnapshots, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { addDays } from "@/lib/business-date";
import { getQueue, queueProgress } from "@/lib/services/queue-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let manager: typeof users.$inferSelect;
let priya: typeof users.$inferSelect;
let TODAY: string;

async function makeUser(
  name: string,
  role: "associate" | "manager",
  reportsToId?: string,
) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
      reportsToId: reportsToId ?? null,
    })
    .returning();
  // A level with no grant is not a grant — a fixture without this is testing
  // somebody who cannot sign in.
  await db
    .insert(appAccess)
    .values({ id: id("aca"), userId: row.id, app: "crm", role });
  return row;
}

/**
 * A customer who is unambiguously due a call: a measured thirty-day cycle and
 * an order placed twice that long ago. Deliberately not a prospect — the
 * prospect cadence turns on the creation date, and a fixture whose eligibility
 * depends on the clock is one that stops proving anything the day it drifts.
 */
async function makeOverdueCustomer(ownerId: string) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Customer ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact Person",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Mumbai",
      ownerId,
      salesAmId: ownerId,
      kind: "customer",
      cycleDays: 30,
      cycleIsDefault: false,
      cycleConfidence: 90,
      lastOrderDate: addDays(TODAY, -60),
      lastOrderValue: 50_000_00,
      lastContactDate: addDays(TODAY, -60),
      customerSince: addDays(TODAY, -400),
    })
    .returning();
  return row;
}

/** Somebody rang them this morning, which is what `worked` counts. */
async function logCallToday(customerId: string, userId: string) {
  await db.insert(calls).values({
    id: id("cal"),
    customerId,
    userId,
    interactionType: "outbound_call",
    startedAt: new Date(`${TODAY}T10:00:00+05:30`),
    outcome: "no_order",
  });
}

/** Everything the dashboard reads, taken off the Call Log's own answer. */
async function progressFromFullQueue() {
  const queue = await getQueue();
  return {
    stillToWork: queue.entries.length,
    worked: queue.progress.worked,
    total: queue.progress.total,
    percent: queue.progress.percent,
  };
}

/** Put the day back to never having been read. */
async function unsettleTheDay() {
  await db.delete(queueSnapshots);
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
      audit_log, job_runs, notifications, monthly_targets, reminders,
      follow_up_attempts, follow_up_states, payments, bills,
      orders, calls, attendance, app_access, sessions,
      customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  manager = await makeUser("Vikram", "manager");
  priya = await makeUser("Priya", "associate", manager.id);
  setTestUser(priya);
  TODAY = await today();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("queueProgress answers exactly what the dashboard read off getQueue", () => {
  test("on a day nobody has opened yet, both build the list and agree", async () => {
    for (let i = 0; i < 6; i++) await makeOverdueCustomer(priya.id);

    // The first read of a business day is what settles it, so each side has to
    // be given an unsettled one — otherwise this would compare a build against
    // a rebuild and prove neither.
    await unsettleTheDay();
    const fromQueue = await progressFromFullQueue();

    await unsettleTheDay();
    const fromProgress = await queueProgress();

    assert.deepEqual(fromProgress, fromQueue);
    // Not vacuous: a pair of zeroes would satisfy the equality above and prove
    // nothing whatever about either function.
    assert.ok(fromQueue.total > 0, "the fixture produced an empty queue");
    assert.equal(fromQueue.worked, 0);
    assert.equal(fromQueue.stillToWork, fromQueue.total);
  });

  test("a settled day, part worked, reads the same on both screens", async () => {
    const book = [];
    for (let i = 0; i < 6; i++) book.push(await makeOverdueCustomer(priya.id));

    // Settle the day before anything is worked, which is what happens when
    // somebody opens the Call Log at nine and starts at the top.
    const settled = await progressFromFullQueue();
    assert.ok(settled.total > 0, "the fixture produced an empty queue");

    const snapshotRows = await db
      .select({ customerId: queueSnapshots.customerId })
      .from(queueSnapshots);
    assert.ok(snapshotRows.length > 0, "the day was never settled");

    // Two of them rung. They leave the callable list and join `worked`, and
    // the denominator must not move: that is the whole point of settling.
    await logCallToday(book[0].id, priya.id);
    await logCallToday(book[1].id, priya.id);

    const fromQueue = await progressFromFullQueue();
    const fromProgress = await queueProgress();

    assert.deepEqual(fromProgress, fromQueue);
    assert.equal(fromQueue.worked, 2);
    assert.equal(fromQueue.total, settled.total);
    assert.equal(fromQueue.stillToWork, settled.total - 2);
    assert.equal(
      fromQueue.percent,
      Math.round((fromQueue.worked / fromQueue.total) * 100),
    );

    // And in the other order, because whichever screen is opened first is the
    // one that reads the stored day — a difference there would show up as the
    // dashboard and the Call Log disagreeing depending on where somebody
    // started their morning.
    assert.deepEqual(await queueProgress(), await progressFromFullQueue());
  });

  test("a manager's team scope agrees too, which is the expensive path", async () => {
    // A manager's book is other people's, so this exercises the scope branch
    // rather than the owner one — and it is the scope where the dashboard was
    // measured at 780 ms, which is why the function exists at all.
    const rakesh = await makeUser("Rakesh", "associate", manager.id);
    for (let i = 0; i < 4; i++) await makeOverdueCustomer(priya.id);
    for (let i = 0; i < 4; i++) await makeOverdueCustomer(rakesh.id);

    setTestUser(manager);

    await unsettleTheDay();
    const unsettled = await progressFromFullQueue();
    await unsettleTheDay();
    assert.deepEqual(await queueProgress(), unsettled);
    assert.ok(unsettled.total > 0, "the manager's book came back empty");

    const worked = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.ownerId, priya.id));
    await logCallToday(worked[0].id, priya.id);

    assert.deepEqual(await queueProgress(), await progressFromFullQueue());
  });

  test("an empty book is nought of nought rather than a division", async () => {
    // No customers at all. `percent` divides by `total`, and the honest answer
    // to nothing to do is 0 — not NaN rendered into a progress bar.
    await unsettleTheDay();
    const fromQueue = await progressFromFullQueue();
    await unsettleTheDay();
    const fromProgress = await queueProgress();

    assert.deepEqual(fromProgress, fromQueue);
    assert.deepEqual(fromProgress, {
      stillToWork: 0,
      worked: 0,
      total: 0,
      percent: 0,
    });
  });

  test("a customer called today counts as worked even though nothing ranked them", async () => {
    // `worked` is taken over every CANDIDATE, not over the ranked list, so
    // somebody rung this morning about something the queue never asked for is
    // still one of today's calls. Reading it off the entries instead would
    // make the denominator shrink as the day was worked.
    const quiet = await makeOverdueCustomer(priya.id);
    await db
      .update(customers)
      .set({ doNotContact: true })
      .where(eq(customers.id, quiet.id));
    await logCallToday(quiet.id, priya.id);
    for (let i = 0; i < 3; i++) await makeOverdueCustomer(priya.id);

    await unsettleTheDay();
    const fromQueue = await progressFromFullQueue();
    await unsettleTheDay();
    assert.deepEqual(await queueProgress(), fromQueue);
    assert.equal(fromQueue.worked, 1);
  });
});
