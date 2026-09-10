/**
 * §J — where did the sample get to, and who is asked.
 *
 *   npm run test:integration
 *
 * This item sat unbuilt because the brief assigns the work to "Logistics" and
 * MahekOne's role list is telecaller, manager, accounts, admin. The resolution
 * was not a new role: `back_office_am_id` has been dispatch, billing and
 * paperwork since the second account manager column shipped, and that is the
 * seat the brief is describing. A fifth `users.role` would have been a new way
 * to see the whole company's book, to model something that already existed.
 *
 * What these pin is mostly the honesty of the fallback. An account with no back
 * office person still has to produce a chase — a sample that never arrives is
 * the quietest way a lead dies — but where it lands on the Lead Manager instead
 * the task has to SAY so, or the brief's job has been moved without anybody
 * being told.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  customers,
  mbosDevices,
  mbosSamples,
  mbosTasks,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { calendarDate } from "@/lib/business-date";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let salesman: typeof users.$inferSelect;
let backOffice: typeof users.$inferSelect;
let leadManager: typeof users.$inferSelect;
let shop: typeof customers.$inferSelect;
let principal: MbosPrincipal;

function item(over: Partial<SyncItem> & Pick<SyncItem, "entityType">): SyncItem {
  const entityId = over.entityId ?? id("mbos");
  return {
    queueId: id("q"),
    entityId,
    op: "update",
    idempotencyKey: `${entityId}:update:${randomUUID()}`,
    clientCreatedAt: Date.now(),
    payload: {},
    ...over,
  } as SyncItem;
}

async function makeUser(name: string, phone: string) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@test.local`,
      phone,
      passwordHash: "x",
      role: "associate",
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
    role: "associate",
  });

  return row;
}

async function makeSample() {
  const [row] = await db
    .insert(mbosSamples)
    .values({
      id: id("smp"),
      customerId: shop.id,
      salesmanId: salesman.id,
      quantityCans: 1,
      requestedDate: calendarDate(new Date()),
    })
    .returning();
  return row;
}

async function chaseFor(sampleId: string) {
  const [row] = await db
    .select()
    .from(mbosTasks)
    .where(
      and(eq(mbosTasks.sourceType, "sample_in_transit"), eq(mbosTasks.sourceId, sampleId)),
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
      mbos_activity_locations, mbos_devices, mbos_samples, mbos_tasks,
      timeline_events, audit_log, notifications, app_access, sessions,
      customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  salesman = await makeUser("Mahesh", "9820011007");
  backOffice = await makeUser("Deepa", "9820011008");
  leadManager = await makeUser("Vikram", "9820011006");
  await db.insert(appAccess).values({ id: id("acc"), userId: salesman.id, app: "field" });

  const [c] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: "Sai Paint Depot",
      phone: "9822200011",
      contactPerson: "Anil",
      city: "Nagpur",
      kind: "customer",
      ownerId: salesman.id,
      salesAmId: salesman.id,
      backOfficeAmId: backOffice.id,
      leadManagerId: leadManager.id,
    })
    .returning();
  shop = c;

  await db
    .insert(mbosDevices)
    .values({ id: id("dev"), userId: salesman.id, deviceId: "probe-device", active: true });

  principal = {
    user: salesman,
    deviceId: "probe-device",
    role: "associate",
    scope: { kind: "own", userIds: [salesman.id] },
  } as MbosPrincipal;
  setTestUser(salesman);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("dispatching a sample puts the chase on the BACK OFFICE seat", async () => {
  /* The seat §J calls Logistics. It is not a new role — dispatch, billing and
     paperwork is what this column has always meant. */
  const sample = await makeSample();
  const [result] = await ingestSyncBatch(principal, [
    item({
      entityType: "sample",
      entityId: sample.id,
      payload: {
        dispatchedAt: Date.now(),
        courierName: "VRL",
        trackingNumber: "VRL-99120",
      },
    }),
  ]);
  assert.equal(result.status, "accepted", JSON.stringify(result));

  const chase = await chaseFor(sample.id);
  assert.ok(chase, "a dispatched sample nobody has confirmed needs somebody chasing it");
  assert.equal(chase.assignedToUserId, backOffice.id);
  assert.equal(chase.status, "open");
  assert.match(chase.title, /Sai Paint Depot/);
  assert.match(chase.description ?? "", /VRL-99120/, "the carrier is what makes it chaseable");
  assert.doesNotMatch(
    chase.description ?? "",
    /no back office person/,
    "there IS one, so it must not claim otherwise",
  );
});

test("with no back office person it goes to the Lead Manager AND says why", async () => {
  /*
   * THE OBJECTION THIS ITEM WAS PARKED ON. Quietly moving a job the brief puts
   * elsewhere looks like completion; naming why it moved is not the same thing,
   * and it turns the gap into something somebody can fix.
   */
  await db
    .update(customers)
    .set({ backOfficeAmId: null })
    .where(eq(customers.id, shop.id));

  const sample = await makeSample();
  await ingestSyncBatch(principal, [
    item({
      entityType: "sample",
      entityId: sample.id,
      payload: { dispatchedAt: Date.now() },
    }),
  ]);

  const chase = await chaseFor(sample.id);
  assert.ok(chase);
  assert.equal(chase.assignedToUserId, leadManager.id);
  assert.match(
    chase.description ?? "",
    /no back office person is named/,
    "a silent fallback is the thing this item refused to ship",
  );
});

test("the chase is dated from DISPATCH, not from when the phone synced", async () => {
  /* A dispatch is routinely recorded a day or two late from a handset that was
     offline. The parcel does not wait for the sync, so neither does the clock. */
  const sample = await makeSample();
  const dispatchedAt = Date.now() - 3 * 86_400_000;
  await ingestSyncBatch(principal, [
    item({
      entityType: "sample",
      entityId: sample.id,
      payload: { dispatchedAt },
    }),
  ]);

  const chase = await chaseFor(sample.id);
  const expected = calendarDate(new Date(dispatchedAt + 4 * 86_400_000)); // default 4 days
  assert.equal(chase?.dueDate, expected);
});

test("confirming receipt closes the chase and opens the review", async () => {
  const sample = await makeSample();
  await ingestSyncBatch(principal, [
    item({ entityType: "sample", entityId: sample.id, payload: { dispatchedAt: Date.now() } }),
  ]);
  assert.equal((await chaseFor(sample.id))?.status, "open");

  await ingestSyncBatch(principal, [
    item({ entityType: "sample", entityId: sample.id, payload: { receivedAt: Date.now() } }),
  ]);

  const chase = await chaseFor(sample.id);
  assert.equal(chase?.status, "done", "the question it asked has been answered");
  assert.ok(chase?.completedAt, "and closing it is recorded, not implied");

  /* Not deleted — "we asked where this was and then it arrived" is the only way
     anybody finds out a courier is the problem. */
  assert.equal(chase?.sourceId, sample.id);

  const [review] = await db
    .select()
    .from(mbosTasks)
    .where(
      and(eq(mbosTasks.sourceType, "sample_review"), eq(mbosTasks.sourceId, sample.id)),
    );
  assert.ok(review, "receipt starts the review clock");
  assert.equal(review.status, "open");
});

test("a re-sent dispatch does not stack a second chase", async () => {
  /* The handset retries, and an outbox that never saw the response sends the
     same dispatch again. Two identical tasks on one list is how a list stops
     being read. */
  const sample = await makeSample();
  const payload = { dispatchedAt: Date.now(), courierName: "VRL" };
  await ingestSyncBatch(principal, [
    item({ entityType: "sample", entityId: sample.id, payload }),
  ]);
  await ingestSyncBatch(principal, [
    item({ entityType: "sample", entityId: sample.id, payload }),
  ]);

  const all = await db
    .select()
    .from(mbosTasks)
    .where(
      and(eq(mbosTasks.sourceType, "sample_in_transit"), eq(mbosTasks.sourceId, sample.id)),
    );
  assert.equal(all.length, 1);
});
