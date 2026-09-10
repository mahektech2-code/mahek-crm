/**
 * §Q — handing the relationship over.
 *
 *   npm run test:integration
 *
 * The brief asks for the account to become a customer on the second order and
 * for the relationship to pass to a customer manager in the same breath. Those
 * are two facts about two different things and MahekOne answers them on two
 * markers: `kind` flips on the FIRST order (see `lead-conversion-service`), and
 * this is the other half.
 *
 * What these pin is mostly what a handover must NOT do. It is a seat that
 * grants sight, sitting one column away from three seats that move money, and
 * the failure mode nobody would notice is it quietly moving revenue with it.
 *
 * Needs mahekone_test, which `npm run test:db` creates from the committed
 * migrations. The harness truncates between tests.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  customerAmChanges,
  customers,
  notifications,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { assertCustomerInScope } from "@/lib/access-control";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { handOverRelationships } from "@/lib/actions/relationship-handover";
import { pendingHandoverClause } from "@/lib/services/handover-service";
import { MBOS_EVENT } from "@/lib/timeline";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let manager: typeof users.$inferSelect;
let desk: typeof users.$inferSelect;

async function makeUser(name: string, role: "manager" | "associate") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  /*
   * THE APP GRANT, because a level on its own is not one.
   *
   * A capability hangs on (app, level) now, so `role: "manager"` with no
   * `app_access` row is a manager of nothing — which is right, and is what
   * production looks like too: an app's layout refuses anybody without a
   * grant, so a person who can reach a screen always has one. A fixture
   * without it was testing somebody who cannot sign in.
   *
   * The CRM, because that is the book these tests work. The ledger desk has
   * `makeAccountsUser` where it is needed.
   */
  await db.insert(appAccess).values({
    id: id("aca"),
    userId: row.id,
    app: "crm",
    role,
  });

  return row;
}

/** A shop that has ordered — which is what makes it a customer at all. */
async function makeConvertedCustomer(overrides: Partial<typeof customers.$inferInsert> = {}) {
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
      kind: "customer",
      ownerId: manager.id,
      salesAmId: manager.id,
      leadStage: "won",
      leadConvertedAt: new Date(),
      ...overrides,
    })
    .returning();
  return row;
}

async function reload(customerId: string) {
  const [row] = await db.select().from(customers).where(eq(customers.id, customerId));
  return row;
}

const REASON = "Territory reassigned";

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
      timeline_events, customer_am_changes, notifications, audit_log,
      customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  manager = await makeUser("Manager", "manager");
  desk = await makeUser("Deskperson", "associate");
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ------------------------------------------------------- what it does do */

test("a handover records the seat, the history and the timeline together", async () => {
  const c = await makeConvertedCustomer();

  const result = await handOverRelationships({
    customerIds: [c.id],
    toUserId: desk.id,
    reasonCode: REASON,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);

  const after = await reload(c.id);
  assert.equal(after.relationshipOwnerId, desk.id);
  assert.ok(after.handedOverAt, "handedOverAt is the only thing that says it happened");

  /* The history row, under its own seat name — this is what answers "who was
     running this in March" once the seat itself has moved on again. */
  const [history] = await db
    .select()
    .from(customerAmChanges)
    .where(eq(customerAmChanges.customerId, c.id));
  assert.equal(history.role, "relationship");
  assert.equal(history.fromUserId, null, "nobody was running it before");
  assert.equal(history.toUserId, desk.id);
  assert.equal(history.toName, desk.name);
  assert.equal(history.reasonCode, REASON);
  assert.equal(history.changedById, manager.id);

  const [event] = await db
    .select()
    .from(timelineEvents)
    .where(
      and(
        eq(timelineEvents.customerId, c.id),
        eq(timelineEvents.eventType, MBOS_EVENT.relationshipHandover),
      ),
    );
  assert.ok(event, "a handover the customer record cannot show is one nobody knows about");
  assert.match(event.summary, /Deskperson/);
});

test("both sides are told, and nobody is told about a loss that did not happen", async () => {
  const c = await makeConvertedCustomer();
  await handOverRelationships({ customerIds: [c.id], toUserId: desk.id, reasonCode: REASON });

  const told = await db.select().from(notifications);
  assert.equal(told.length, 1, "nobody held it before, so there is no loss to report");
  assert.equal(told[0].userId, desk.id);

  /* Now move it on, and the person losing it is told too — a book that
     shrinks silently reads as a bug in the queue. */
  const third = await makeUser("Third", "associate");
  await handOverRelationships({ customerIds: [c.id], toUserId: third.id, reasonCode: REASON });

  const round2 = await db.select().from(notifications);
  const audience = new Set(round2.map((n) => n.userId));
  assert.ok(audience.has(third.id), "the person taking it on is told");
  assert.ok(audience.has(desk.id), "the person losing it is told");
});

test("a second handover is a second history row and a second timeline entry", async () => {
  /*
   * The natural key on a timeline entry is (app, kind, source row), and a seat
   * has no row of its own — so keying this on the customer alone would make
   * every handover after the first vanish into the first one's key, silently,
   * because the conflict clause does nothing rather than failing.
   */
  const c = await makeConvertedCustomer();
  const third = await makeUser("Third", "associate");

  await handOverRelationships({ customerIds: [c.id], toUserId: desk.id, reasonCode: REASON });
  await handOverRelationships({ customerIds: [c.id], toUserId: third.id, reasonCode: REASON });

  const history = await db
    .select()
    .from(customerAmChanges)
    .where(eq(customerAmChanges.customerId, c.id));
  assert.equal(history.length, 2);

  const events = await db
    .select()
    .from(timelineEvents)
    .where(
      and(
        eq(timelineEvents.customerId, c.id),
        eq(timelineEvents.eventType, MBOS_EVENT.relationshipHandover),
      ),
    );
  assert.equal(events.length, 2, "the second handover must not be swallowed by the first's key");
});

/* --------------------------------------------------- what it must NOT do */

test("a handover moves sight, never the sales seat or the money behind it", async () => {
  /*
   * THE INVARIANT THIS WHOLE FILE EXISTS FOR.
   *
   * `sales_am_id` decides who is credited for an account's orders and whose
   * target it counts toward. Moving it is `customer.reassign`, which is
   * accounts' and admin's precisely so a manager cannot move numbers between
   * their own people. A handover is a manager's — so if it ever touched this
   * column, it would be a way around that rule that nobody would see, because
   * nobody reads a target screen looking for a handover.
   */
  const c = await makeConvertedCustomer();
  await handOverRelationships({ customerIds: [c.id], toUserId: desk.id, reasonCode: REASON });

  const after = await reload(c.id);
  assert.equal(after.salesAmId, manager.id, "the sales seat must not move");
  assert.equal(after.ownerId, manager.id, "nor the owner");
  assert.equal(after.kind, "customer", "and it says nothing about what the account IS");
  assert.equal(after.amDecidedAt, null, "no decision mark — the sheet has never heard of this seat");
});

test("a lead is refused, and named rather than silently dropped", async () => {
  const lead = await makeConvertedCustomer({
    kind: "lead",
    leadStage: "qualified",
    leadConvertedAt: null,
  });

  const result = await handOverRelationships({
    customerIds: [lead.id],
    toUserId: desk.id,
    reasonCode: REASON,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /lead/i);

  const after = await reload(lead.id);
  assert.equal(after.relationshipOwnerId, null);
});

test("a mixed selection moves the customers and says which were left", async () => {
  const customer = await makeConvertedCustomer();
  const lead = await makeConvertedCustomer({
    kind: "lead",
    leadStage: "qualified",
    leadConvertedAt: null,
  });

  const result = await handOverRelationships({
    customerIds: [customer.id, lead.id],
    toUserId: desk.id,
    reasonCode: REASON,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.match(result.ok ? (result.message ?? "") : "", /Not moved/, "the refused one is named, not dropped");

  assert.equal((await reload(customer.id)).relationshipOwnerId, desk.id);
  assert.equal((await reload(lead.id)).relationshipOwnerId, null);
});

test("handing an account to whoever already runs it writes nothing", async () => {
  const c = await makeConvertedCustomer();
  await handOverRelationships({ customerIds: [c.id], toUserId: desk.id, reasonCode: REASON });
  await db.delete(notifications);

  const again = await handOverRelationships({
    customerIds: [c.id],
    toUserId: desk.id,
    reasonCode: REASON,
  });
  assert.equal(again.ok, false);

  const history = await db
    .select()
    .from(customerAmChanges)
    .where(eq(customerAmChanges.customerId, c.id));
  assert.equal(history.length, 1, "a no-op must not grow the history");
  assert.equal((await db.select().from(notifications)).length, 0, "nor tell anybody again");
});

/* ------------------------------------------------------------------ scope */

test("the person handed the relationship can actually open the account", async () => {
  /*
   * A seat that did not carry sight would announce to somebody that an account
   * is theirs and then refuse them the screen — which is exactly the failure
   * `assertCustomerInScope` carries three paragraphs about, having shipped
   * twice. `desk` is a telecaller, so their scope is their own book alone, and
   * this account is in nobody's book but the manager's.
   */
  const c = await makeConvertedCustomer();

  const beforeRow = await reload(c.id);
  setTestUser(desk);
  await assert.rejects(
    () => assertCustomerInScope(beforeRow),
    /not permitted|customer\.read/i,
    "before the handover it is none of their business",
  );

  setTestUser(manager);
  await handOverRelationships({ customerIds: [c.id], toUserId: desk.id, reasonCode: REASON });

  setTestUser(desk);
  await assertCustomerInScope(await reload(c.id));
});

/* ---------------------------------------------------------------- pending */

test("outstanding handovers are derived from the two columns, not a flag", async () => {
  const waiting = await makeConvertedCustomer();
  const lead = await makeConvertedCustomer({
    kind: "lead",
    leadStage: "qualified",
    leadConvertedAt: null,
  });

  const before = await db.select({ id: customers.id }).from(customers).where(pendingHandoverClause());
  assert.deepEqual(
    before.map((r) => r.id),
    [waiting.id],
    "a lead has not converted, so it is not waiting for a handover",
  );
  assert.ok(!before.some((r) => r.id === lead.id));

  await handOverRelationships({
    customerIds: [waiting.id],
    toUserId: desk.id,
    reasonCode: REASON,
  });

  const after = await db.select({ id: customers.id }).from(customers).where(pendingHandoverClause());
  assert.equal(after.length, 0, "handing it over is what takes it off the list");
});
