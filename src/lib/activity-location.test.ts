/**
 * Every activity carries where it was done.
 *
 * Four MBOS tables used to hold a coordinate and twenty-three did not, so an
 * order taken at a shop, a payment collected at a counter and a complaint
 * raised in a godown were all recorded with no idea where they happened.
 *
 * Three rules are worth pinning, and all three are ones a future change could
 * quietly break without any type error:
 *
 *   ONE PLACE. The location is written by the dispatcher, not by each handler,
 *   which is what makes a thirteenth kind of activity carry it by existing.
 *   A test that only checked orders would pass on the day somebody added a
 *   handler that forgot.
 *
 *   NEVER BLOCKS. A save is never lost to a missing fix, a refused permission
 *   or a nonsense coordinate.
 *
 *   NEVER FOR A REFUSAL. A rejected order did not happen, and a position for
 *   it is a record of somewhere a salesman stood while something failed.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, mbosDevices, users } from "@/db/schema";
import { invalidateConfig, seedConfig, updateSettings } from "@/lib/config/store";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let salesman: typeof users.$inferSelect;
let shop: typeof customers.$inferSelect;
let principal: MbosPrincipal;

/** Nagpur, Sadar. A real place, so a wrong sign or a swap is visible. */
const HERE = { lat: 21.1601, lng: 79.0805 };

function item(over: Partial<SyncItem> & Pick<SyncItem, "entityType">): SyncItem {
  const entityId = over.entityId ?? id("mbos");
  return {
    queueId: id("q"),
    entityId,
    op: "create",
    idempotencyKey: `${entityId}:create:${randomUUID()}`,
    clientCreatedAt: Date.now(),
    payload: {},
    location: {
      ...HERE,
      accuracyM: 18,
      capturedAt: Date.now() - 90_000,
      ageSeconds: 90,
      source: "trail",
    },
    ...over,
  };
}

async function whereOf(entityType: string, entityId: string) {
  const rows = await db.execute<{
    lat: number | null;
    lng: number | null;
    accuracyM: number | null;
    ageSeconds: number | null;
    source: string | null;
    reason: string | null;
  }>(sql`
    select lat, lng, accuracy_m as "accuracyM", age_seconds as "ageSeconds", source, reason
      from mbos_activity_locations
     where entity_type = ${entityType} and entity_id = ${entityId}`);
  return rows[0] ?? null;
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
      mbos_activity_locations, mbos_devices, mbos_visits, mbos_tasks,
      audit_log, notifications, app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Mahesh",
      email: "mahesh@test.local",
      phone: "9820011007",
      passwordHash: "x",
      role: "telecaller",
      initials: "MP",
    })
    .returning();
  salesman = row;
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
    })
    .returning();
  shop = c;

  await db
    .insert(mbosDevices)
    .values({ id: id("dev"), userId: salesman.id, deviceId: "probe-device", active: true });

  principal = {
    user: salesman,
    deviceId: "probe-device",
    role: "telecaller",
    scope: { kind: "own", userIds: [salesman.id] },
  } as MbosPrincipal;
});

after(async () => {
  await db.$client.end();
});

describe("Every activity is logged with where it happened", () => {
  test("a task carries the position it was done at, with its age and accuracy", async () => {
    const task = item({
      entityType: "task",
      payload: { title: "Collect the cheque", customerId: shop.id },
    });

    const [result] = await ingestSyncBatch(principal, [task]);
    assert.equal(result.status, "accepted", JSON.stringify(result));

    const where = await whereOf("task", task.entityId);
    assert.ok(where, "the activity should have recorded a location");
    assert.equal(Math.round(where.lat! * 10_000), Math.round(HERE.lat * 10_000));
    assert.equal(Math.round(where.lng! * 10_000), Math.round(HERE.lng * 10_000));
    assert.equal(where.accuracyM, 18);

    // Age and source travel with it: a fix from ninety seconds ago is evidence
    // and one from four hours ago is not, and only the age says which.
    assert.equal(where.ageSeconds, 90);
    assert.equal(where.source, "trail");
    assert.equal(where.reason, null);
  });

  test("it is written by the dispatcher, so a handler cannot forget it", async () => {
    // The point of the design: no handler mentions locations, so every kind
    // gets one. If somebody moves this into the handlers, the kind they miss
    // is what this catches.
    const kinds: SyncItem[] = [
      item({ entityType: "task", payload: { title: "Ring them back", customerId: shop.id } }),
      item({
        entityType: "lead",
        payload: { name: "Rakesh", companyName: "New Paints", mobile: "9820011999" },
      }),
    ];

    const results = await ingestSyncBatch(principal, kinds);
    for (const [i, result] of results.entries()) {
      assert.equal(result.status, "accepted", `${kinds[i].entityType}: ${JSON.stringify(result)}`);
      const where = await whereOf(kinds[i].entityType, kinds[i].entityId);
      assert.ok(where?.lat, `${kinds[i].entityType} should carry a location`);
    }
  });

  test("no fix is a recorded fact, not a missing row", async () => {
    // Indoors in a concrete godown there is no fix. "We asked and could not"
    // and "nobody asked" are different facts about a salesman's day, and a
    // screen that could not tell them apart would say "no location" for both.
    const task = item({
      entityType: "task",
      payload: { title: "Check the stock", customerId: shop.id },
      location: { reason: "unavailable" },
    });

    const [result] = await ingestSyncBatch(principal, [task]);
    assert.equal(result.status, "accepted");

    const where = await whereOf("task", task.entityId);
    assert.ok(where, "a refused fix is still a row — it is what says we asked");
    assert.equal(where.lat, null);
    assert.equal(where.reason, "unavailable");
  });

  test("a nonsense coordinate never costs the record", async () => {
    // A save is never lost to the thing that decorates it. The activity lands
    // and the position is recorded as unavailable rather than as a point in
    // the sea off Africa.
    const task = item({
      entityType: "task",
      payload: { title: "Deliver the sample", customerId: shop.id },
      location: { lat: 999, lng: 999, accuracyM: 10 },
    });

    const [result] = await ingestSyncBatch(principal, [task]);
    assert.equal(result.status, "accepted", "the record must survive a bad position");

    const where = await whereOf("task", task.entityId);
    assert.equal(where?.lat, null);
    assert.equal(where?.reason, "unavailable");
  });

  test("an item with no location at all is accepted and stores nothing", async () => {
    const task = item({
      entityType: "task",
      payload: { title: "Nothing recorded", customerId: shop.id },
      location: undefined,
    });

    const [result] = await ingestSyncBatch(principal, [task]);
    assert.equal(result.status, "accepted");
    assert.equal(await whereOf("task", task.entityId), null);
  });

  test("switching it off in the office stops the server storing one", async () => {
    // A setting only the handset honours is not a setting: an older build
    // carries on sending what it was built to send.
    await updateSettings(
      [{ key: "mbos.location.logActivityLocation", value: false }],
      salesman.id,
    );
    invalidateConfig();

    const task = item({
      entityType: "task",
      payload: { title: "Still a task", customerId: shop.id },
    });

    const [result] = await ingestSyncBatch(principal, [task]);
    assert.equal(result.status, "accepted");
    assert.equal(
      await whereOf("task", task.entityId),
      null,
      "the office turned it off, so nothing is stored however willing the handset was",
    );
  });

  test("a refused activity leaves no position behind", async () => {
    // A rejected record did not happen. Keeping where somebody stood while it
    // failed is a row about a person that answers nothing.
    const bad = item({
      entityType: "task",
      payload: { title: "", customerId: "cus_does_not_exist" },
    });

    const [result] = await ingestSyncBatch(principal, [bad]);
    assert.notEqual(result.status, "accepted");
    assert.equal(await whereOf("task", bad.entityId), null);
  });

  test("a retried sync writes one location, not two", async () => {
    const task = item({
      entityType: "task",
      payload: { title: "Collect the cheque", customerId: shop.id },
    });

    await ingestSyncBatch(principal, [task]);
    // The same item again, as a handset that never saw the answer would send.
    await ingestSyncBatch(principal, [{ ...task, queueId: id("q") }]);

    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from mbos_activity_locations
       where entity_type = 'task' and entity_id = ${task.entityId}`);
    assert.equal(rows[0].n, 1);
  });
});
