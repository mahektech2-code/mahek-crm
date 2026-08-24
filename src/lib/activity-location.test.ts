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
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  customerDistributors,
  customers,
  mbosDevices,
  orders,
  products,
  syncConflicts,
  users,
} from "@/db/schema";
import { invalidateConfig, seedConfig, updateSettings } from "@/lib/config/store";
import { setTestUser } from "@/lib/auth";
import { releaseDevice } from "@/lib/actions/sales";
import { markMissedCheckouts } from "@/lib/mbos-jobs";
import { mbosAttendanceDays, mbosPositions } from "@/db/schema";
import { auditLog, notifications as notificationsTable } from "@/db/schema";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import {
  buildBootstrap,
  checkDeviceBinding,
  type MbosPrincipal,
} from "@/lib/services/mbos-service";
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
      mbos_positions, mbos_attendance_days,
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


/* -------------------------------------- who we bill for the shop we deliver to */

/**
 * The handset has to be able to ask "who do I bill for this?" while standing
 * in the shop, offline.
 *
 * The server has held both parties on an order since `delivery_customer_id`
 * arrived; the arrangement behind them — which shop is third party, and which
 * distributor invoices it — lived only on the web side. Without it in the
 * pull the salesman either guesses or the order is refused at sync hours
 * later with nothing on the screen explaining why.
 */
describe("The pull carries who bills each shop", () => {
  test("a third-party shop arrives marked, with its distributors", async () => {
    const [distributor] = await db
      .insert(customers)
      .values({
        id: id("cus"),
        name: "Nashik Distributors",
        contactPerson: "Contact",
        phone: "9820000111",
        city: "Nashik",
        ownerId: salesman.id,
        salesAmId: salesman.id,
      })
      .returning();

    await db
      .update(customers)
      .set({ thirdParty: true })
      .where(eq(customers.id, shop.id));
    await db.insert(customerDistributors).values({
      id: id("cd"),
      customerId: shop.id,
      distributorCustomerId: distributor.id,
      isPrimary: true,
    });

    const payload = await buildBootstrap(principal);
    const rows = payload.customers as Array<Record<string, unknown>>;

    const sent = rows.find((r) => r.id === shop.id);
    assert.ok(sent, "the shop was not in the pull at all");
    assert.equal(sent.thirdParty, true, "the shop arrived without the mark");

    const arrangement = sent.distributors as Array<{ id: string; name: string; isPrimary: boolean }>;
    assert.equal(arrangement.length, 1, "the handset was sent no distributor to bill");
    assert.equal(arrangement[0].id, distributor.id);
    assert.equal(arrangement[0].name, "Nashik Distributors", "a name it can show on the form");
    assert.equal(arrangement[0].isPrimary, true);
  });

  /**
   * An ordinary direct customer must arrive with an EMPTY list rather than
   * null: the handset defaults the billing party from this, and a null would
   * make every order form branch on a missing value instead of on a length.
   */
  test("a direct customer arrives unmarked, with an empty arrangement", async () => {
    const payload = await buildBootstrap(principal);
    const rows = payload.customers as Array<Record<string, unknown>>;
    const sent = rows.find((r) => r.id === shop.id);
    assert.ok(sent);
    assert.equal(sent.thirdParty, false);
    assert.deepEqual(sent.distributors, [], "an empty arrangement must be a list, not null");
  });
});


/* ----------------------- a field order names both parties, or means neither */

describe("A field order carries who was billed and where it went", () => {
  /** A SKU to hang a line on — an order with none is refused before this. */
  /*
   * A SKU to put on the order line, and this file has to make its own.
   *
   * It used to take whatever `products` happened to hold, and `products` is
   * not in the truncate list above — so these three tests passed only because
   * an earlier suite in the same run had left a catalogue behind. Run this
   * file on its own and `anySku()` returned undefined, which arrives as
   * `Cannot read properties of undefined (reading 'id')` several lines later
   * and reads as a bug in the order handler rather than a missing fixture.
   */
  async function anySku() {
    const [existing] = await db.select({ id: products.id }).from(products).limit(1);
    if (existing) return existing;

    const [made] = await db
      .insert(products)
      .values({
        id: id("prd"),
        name: `Test Thinner - 5 Liter (Loose) ${randomUUID().slice(0, 6)}`,
        packing: "Loose",
        millilitresPerCan: 5000,
        cansPerBox: 1,
      })
      .returning({ id: products.id });
    return made;
  }

  test("the bill goes to the distributor and the goods to the shop", async () => {
    const sku = await anySku();
    const [distributor] = await db
      .insert(customers)
      .values({
        id: id("cus"),
        name: "Nashik Distributors",
        contactPerson: "Contact",
        phone: "9820000222",
        city: "Nashik",
        ownerId: salesman.id,
        salesAmId: salesman.id,
      })
      .returning();

    const entityId = id("mbos");
    const [result] = await ingestSyncBatch(principal, [
      item({
        entityType: "order",
        entityId,
        payload: {
          id: entityId,
          customerId: distributor.id,
          deliveryCustomerId: shop.id,
          orderedAt: Date.now(),
          totalAmountPaise: 250_00,
          lines: [{ productId: sku.id, quantityCans: 5 }],
        },
      }),
    ]);
    assert.equal(result.status, "accepted", JSON.stringify(result));

    const [row] = await db.select().from(orders).where(eq(orders.id, entityId));
    assert.ok(row, "the order was not written");
    assert.equal(row.customerId, distributor.id, "the invoice went to the wrong account");
    assert.equal(row.deliveryCustomerId, shop.id, "where the goods went was not recorded");
  });

  /**
   * Every handset built before the form learned to ask sends no delivery
   * party, and must go on meaning what it has always meant.
   */
  test("an order with no delivery party means the biller received it", async () => {
    const sku = await anySku();
    const entityId = id("mbos");
    const [result] = await ingestSyncBatch(principal, [
      item({
        entityType: "order",
        entityId,
        payload: {
          id: entityId,
          customerId: shop.id,
          orderedAt: Date.now(),
          totalAmountPaise: 100_00,
          lines: [{ productId: sku.id, quantityCans: 2 }],
        },
      }),
    ]);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    const [row] = await db.select().from(orders).where(eq(orders.id, entityId));
    assert.equal(row.deliveryCustomerId, null);
  });

  /**
   * A shop that has left MahekOne since the salesman stood in it. Its own
   * code, because the payload was correct when it was written — the same
   * shape as `outstanding_stale`, wanting "sync and take it again" rather
   * than a message that reads as a bug in the app.
   */
  test("a delivery party that no longer exists is refused by name", async () => {
    const sku = await anySku();
    const entityId = id("mbos");
    const [result] = await ingestSyncBatch(principal, [
      item({
        entityType: "order",
        entityId,
        payload: {
          id: entityId,
          customerId: shop.id,
          deliveryCustomerId: "cus_gone_for_good",
          orderedAt: Date.now(),
          totalAmountPaise: 100_00,
          lines: [{ productId: sku.id, quantityCans: 1 }],
        },
      }),
    ]);
    assert.equal(result.status, "rejected");
    assert.equal(result.code, "delivery_party_unknown");
  });
});


/* ------------------------- a shop opened while standing inside it */

describe("A shop can be opened from the field", () => {
  async function aDistributor(name = "Nashik Distributors") {
    const [d] = await db
      .insert(customers)
      .values({
        id: id("cus"),
        name,
        contactPerson: "Contact",
        phone: "9820000333",
        city: "Nashik",
        ownerId: salesman.id,
        salesAmId: salesman.id,
      })
      .returning();
    return d;
  }

  test("it arrives marked, with the distributor recorded as billing it", async () => {
    const distributor = await aDistributor();
    const entityId = id("cus");

    const [result] = await ingestSyncBatch(principal, [
      item({
        entityType: "customer",
        entityId,
        payload: {
          id: entityId,
          name: "New Corner Outlet",
          phone: "9812345678",
          city: "Nashik",
          thirdParty: true,
          distributorCustomerId: distributor.id,
        },
      }),
    ]);
    assert.equal(result.status, "accepted", JSON.stringify(result));

    const [row] = await db.select().from(customers).where(eq(customers.id, entityId));
    assert.ok(row, "the shop was not created");
    assert.equal(row.thirdParty, true, "it arrived without the mark");

    const [link] = await db
      .select()
      .from(customerDistributors)
      .where(eq(customerDistributors.customerId, entityId));
    assert.ok(link, "nobody was recorded as billing it");
    assert.equal(link.distributorCustomerId, distributor.id);
    assert.equal(link.isPrimary, true, "the only distributor is the one that serves it");
  });

  /**
   * A shop marked as one we do not bill, with nobody recorded as billing it,
   * is exactly the row the console already has a tidying list for. Creating
   * those from the field would fill it faster than anybody empties it.
   */
  test("a shop we do not bill must say who does", async () => {
    const entityId = id("cus");
    const [result] = await ingestSyncBatch(principal, [
      item({
        entityType: "customer",
        entityId,
        payload: {
          id: entityId,
          name: "Nobody Bills Me",
          phone: "9812345679",
          city: "Nashik",
          thirdParty: true,
        },
      }),
    ]);
    assert.equal(result.status, "rejected");
    const [row] = await db.select().from(customers).where(eq(customers.id, entityId));
    assert.equal(row, undefined, "a shop nobody bills was created anyway");
  });

  test("the biller has to be an account we actually invoice", async () => {
    const [otherShop] = await db
      .insert(customers)
      .values({
        id: id("cus"),
        name: "Another Third Party",
        contactPerson: "Contact",
        phone: "9820000444",
        city: "Nashik",
        ownerId: salesman.id,
        salesAmId: salesman.id,
        thirdParty: true,
      })
      .returning();

    const entityId = id("cus");
    const [result] = await ingestSyncBatch(principal, [
      item({
        entityType: "customer",
        entityId,
        payload: {
          id: entityId,
          name: "Pointed At A Shop",
          phone: "9812345670",
          city: "Nashik",
          thirdParty: true,
          distributorCustomerId: otherShop.id,
        },
      }),
    ]);
    assert.equal(result.status, "rejected", "a shop was allowed to bill another shop");
  });

  /**
   * Flagged, not refused and not merged. Merging is impossible — the handset
   * does not act on the id we return — and refusing would lose the order he is
   * holding, which teaches him to retype the name until it goes through.
   */
  test("a shop on a number we already hold is created AND flagged", async () => {
    const distributor = await aDistributor();
    const [alreadyHere] = await db
      .insert(customers)
      .values({
        id: id("cus"),
        name: "Corner Shop",
        contactPerson: "Contact",
        phone: "98123 45678",
        city: "Nashik",
        ownerId: salesman.id,
        salesAmId: salesman.id,
      })
      .returning();

    const entityId = id("cus");
    const [result] = await ingestSyncBatch(principal, [
      item({
        entityType: "customer",
        entityId,
        payload: {
          id: entityId,
          // The same number, spaced differently, and the shop named otherwise.
          name: "Corner Stores",
          phone: "+91 9812345678",
          city: "Nashik",
          thirdParty: true,
          distributorCustomerId: distributor.id,
        },
      }),
    ]);
    assert.equal(result.status, "accepted", "the salesman lost his order to a duplicate check");

    const [row] = await db.select().from(customers).where(eq(customers.id, entityId));
    assert.ok(row, "the shop was refused rather than flagged");

    const flags = await db
      .select()
      .from(syncConflicts)
      .where(eq(syncConflicts.entityId, entityId));
    assert.equal(flags.length, 1, "nobody was told these might be the same shop");
    assert.equal(flags[0].field, "phone");
    assert.ok(
      flags[0].sheetValue?.includes(alreadyHere.name),
      "the flag does not name the record it might duplicate",
    );
  });
});

describe("How many handsets one person may hold", () => {
  /*
   * The rule shipped as a constant and had to become a setting: the screen its
   * own refusal named — "ask an admin to release the old one in the Admin
   * Console" — does not exist, so a salesman whose phone broke had no way back
   * in at all. Both states are pinned here, because a switch that is only ever
   * tested in its default position is a switch nobody has tested.
   */
  const SECOND = "second-handset";

  test("on by default, a second handset is refused", async () => {
    const outcome = await checkDeviceBinding(salesman.id, SECOND);
    assert.equal(outcome.ok, false);
    assert.match(
      outcome.ok === false ? outcome.error : "",
      /already signed in on another handset/i,
      "the refusal does not say what is wrong",
    );
  });

  test("switched off, the same person may hold two", async () => {
    await updateSettings([{ key: "mbos.devices.onePerPerson", value: false }], salesman.id);
    invalidateConfig();

    const outcome = await checkDeviceBinding(salesman.id, SECOND);
    assert.equal(outcome.ok, true, "the setting was written and nothing read it");
    assert.equal(
      outcome.ok === true ? outcome.firstBind : null,
      true,
      "a handset the server has never seen is not a first bind",
    );
  });

  test("the handset he is already on is never a second one", async () => {
    // The existing binding must keep working whichever way the switch is set,
    // or turning the rule ON would sign everybody out of the phone they hold.
    for (const onePerPerson of [true, false]) {
      await updateSettings(
        [{ key: "mbos.devices.onePerPerson", value: onePerPerson }],
        salesman.id,
      );
      invalidateConfig();
      const outcome = await checkDeviceBinding(salesman.id, "probe-device");
      assert.equal(outcome.ok, true, `his own handset was refused with the rule ${onePerPerson}`);
    }
  });

  test("somebody else's handset is refused either way", async () => {
    // This is a different rule and deliberately not part of the switch: it is
    // about whose phone it is, not how many one person may hold.
    const [other] = await db
      .insert(users)
      .values({
        id: id("usr"),
        name: "Rakesh",
        email: "rakesh@test.local",
        phone: "9820011002",
        passwordHash: "x",
        role: "telecaller",
        initials: "RK",
      })
      .returning();

    await updateSettings([{ key: "mbos.devices.onePerPerson", value: false }], salesman.id);
    invalidateConfig();

    const outcome = await checkDeviceBinding(other.id, "probe-device");
    assert.equal(outcome.ok, false, "one salesman took over another's phone");
    assert.match(
      outcome.ok === false ? outcome.error : "",
      /registered to another employee/i,
    );
  });
});

describe("Releasing a handset", () => {
  /*
   * The half that did not exist. `checkDeviceBinding` refused a second phone
   * and told the salesman an admin would release the first; nothing anywhere
   * released one, so the only route was a DELETE against production.
   */
  async function asOffice() {
    const [office] = await db
      .insert(users)
      .values({
        id: id("usr"),
        name: "Vikram Rao",
        email: `vikram-${randomUUID().slice(0, 6)}@test.local`,
        phone: `98200${Math.floor(10000 + Math.random() * 89999)}`,
        passwordHash: "x",
        role: "manager",
        initials: "VR",
      })
      .returning();
    await db.insert(appAccess).values({ id: id("acc"), userId: office.id, app: "sales" });
    setTestUser(office);
    return office;
  }

  test("it frees the person to sign in on a new phone", async () => {
    await asOffice();

    const before = await checkDeviceBinding(salesman.id, "second-handset");
    assert.equal(before.ok, false, "the rule was not on to begin with");

    const result = await releaseDevice({
      deviceId: "probe-device",
      reason: "Phone broken, replaced with a company handset",
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const after = await checkDeviceBinding(salesman.id, "second-handset");
    assert.equal(after.ok, true, "released the old handset and still refused the new one");
  });

  test("released, not deleted — the row and its reason stay", async () => {
    await asOffice();
    await releaseDevice({ deviceId: "probe-device", reason: "Left the company" });

    const [row] = await db
      .select()
      .from(mbosDevices)
      .where(eq(mbosDevices.deviceId, "probe-device"));
    assert.ok(row, "the binding was deleted, so which phone he was on is gone");
    assert.equal(row.active, false);
    assert.equal(row.releaseReason, "Left the company");
    assert.ok(row.releasedAt, "released with no date on it");
  });

  test("a reason is required by the action, not only by the form", async () => {
    await asOffice();
    const result = await releaseDevice({ deviceId: "probe-device", reason: "  " });
    assert.equal(result.ok, false);

    const [row] = await db
      .select()
      .from(mbosDevices)
      .where(eq(mbosDevices.deviceId, "probe-device"));
    assert.equal(row.active, true, "it was released anyway");
  });

  test("releasing twice is refused rather than silently repeated", async () => {
    await asOffice();
    await releaseDevice({ deviceId: "probe-device", reason: "Broken" });
    const again = await releaseDevice({ deviceId: "probe-device", reason: "Broken again" });
    assert.equal(again.ok, false, "the second release overwrote the first one's reason");
  });

  test("it is audited, and the salesman is told why", async () => {
    const office = await asOffice();
    await releaseDevice({ deviceId: "probe-device", reason: "Swapped at the depot" });

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "mbos.device.release"));
    assert.equal(audits.length, 1, "a handset was released with nobody's name against it");
    assert.equal(audits[0].actorId, office.id);

    const told = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.userId, salesman.id));
    assert.equal(told.length, 1, "his phone stopped working and nothing told him why");
    assert.match(told[0].body ?? "", /Swapped at the depot/);
  });

  test("somebody without the Sales Dashboard cannot release one", async () => {
    // The salesman himself holds `field`, not `sales`.
    setTestUser(salesman);
    const result = await releaseDevice({ deviceId: "probe-device", reason: "Mine now" });
    assert.equal(result.ok, false, "a salesman released his own binding");

    const [row] = await db
      .select()
      .from(mbosDevices)
      .where(eq(mbosDevices.deviceId, "probe-device"));
    assert.equal(row.active, true);
  });
});

describe("A day nobody checked out of", () => {
  /*
   * The nightly pass used to flag these and leave `check_out_at` null for
   * ever, so every query asking "who is still out" believed a salesman who
   * forgot the button on Tuesday was still out on Friday.
   */
  const YESTERDAY = new Date(Date.now() - 86_400_000)
    .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  async function openDay() {
    const [row] = await db
      .insert(mbosAttendanceDays)
      .values({
        id: id("att"),
        userId: salesman.id,
        day: YESTERDAY,
        checkInAt: new Date(`${YESTERDAY}T03:30:00Z`), // 9am IST
      })
      .returning();
    return row;
  }

  test("it closes at the last position he reported", async () => {
    const day = await openDay();
    const last = new Date(`${YESTERDAY}T11:00:00Z`); // 4:30pm IST
    for (const at of [new Date(`${YESTERDAY}T05:00:00Z`), last]) {
      await db.insert(mbosPositions).values({
        id: id("pos"),
        userId: salesman.id,
        deviceId: "probe-device",
        lat: 21.1458,
        lng: 79.0882,
        accuracyM: 18,
        at,
      });
    }

    const out = await markMissedCheckouts();
    assert.equal(out.recordsAffected, 1);

    const [after] = await db
      .select()
      .from(mbosAttendanceDays)
      .where(eq(mbosAttendanceDays.id, day.id));
    assert.equal(after.autoCheckedOut, true, "the day was not flagged");
    assert.ok(after.checkOutAt, "the day was left open despite a trail to close it at");
    assert.equal(
      after.checkOutAt.toISOString(),
      last.toISOString(),
      "closed at something other than the last position",
    );
  });

  test("with nothing recorded it stays open rather than inventing an hour", async () => {
    // Attendance is what somebody is paid against. "We do not know when he
    // stopped" is a real answer; a plausible six o'clock would be believed.
    const day = await openDay();

    const out = await markMissedCheckouts();
    assert.equal(out.recordsAffected, 1);

    const [after] = await db
      .select()
      .from(mbosAttendanceDays)
      .where(eq(mbosAttendanceDays.id, day.id));
    assert.equal(after.checkOutAt, null, "a check-out time was invented");
    assert.equal(after.autoCheckedOut, true, "it was not flagged for regularisation");
  });

  test("today is left alone — the day is not over", async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const [day] = await db
      .insert(mbosAttendanceDays)
      .values({
        id: id("att"),
        userId: salesman.id,
        day: today,
        checkInAt: new Date(Date.now() - 3_600_000),
      })
      .returning();

    await markMissedCheckouts();

    const [after] = await db
      .select()
      .from(mbosAttendanceDays)
      .where(eq(mbosAttendanceDays.id, day.id));
    assert.equal(after.checkOutAt, null, "somebody still working was checked out");
    assert.equal(after.autoCheckedOut, false);
  });

  test("running it twice does not move a closing time", async () => {
    const day = await openDay();
    const last = new Date(`${YESTERDAY}T11:00:00Z`);
    await db.insert(mbosPositions).values({
      id: id("pos"),
      userId: salesman.id,
      deviceId: "probe-device",
      lat: 21.1458,
      lng: 79.0882,
      accuracyM: 18,
      at: last,
    });

    await markMissedCheckouts();
    const second = await markMissedCheckouts();
    assert.equal(second.recordsAffected, 0, "an already-closed day was closed again");

    const [after] = await db
      .select()
      .from(mbosAttendanceDays)
      .where(eq(mbosAttendanceDays.id, day.id));
    assert.equal(after.checkOutAt?.toISOString(), last.toISOString());
  });
});
