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
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  attachments,
  customerDistributors,
  customers,
  mbosDevices,
  mbosUserTerritories,
  orders,
  paymentReceipts,
  products,
  syncConflicts,
  timelineEvents,
  users,
} from "@/db/schema";
import { invalidateConfig, seedConfig, updateSettings } from "@/lib/config/store";
import { setTestUser } from "@/lib/auth";
import { releaseDevice } from "@/lib/actions/sales";
import { markMissedCheckouts } from "@/lib/mbos-jobs";
import { mbosAttendanceDays, mbosPositions } from "@/db/schema";
import { auditLog, notifications as notificationsTable } from "@/db/schema";
import { ingestSyncBatch, storeMbosMedia } from "@/lib/actions/mbos";
import {
  canRead,
  sweepAttendanceSelfies,
  sweepOrphans,
} from "@/lib/services/attachment-service";
import {
  buildBootstrap,
  buildPull,
  checkDeviceBinding,
  encodeCursor,
  type MbosPrincipal,
} from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let salesman: typeof users.$inferSelect;
let shop: typeof customers.$inferSelect;
let principal: MbosPrincipal;

/** Nagpur, Sadar. A real place, so a wrong sign or a swap is visible. */
const HERE = { lat: 21.1601, lng: 79.0805 };

/*
 * A file that is a JPEG by its BYTES.
 *
 * `sniffContentType` reads the signature and nothing else — an extension and a
 * declared MIME both come from the same untrusted place — so a test uploading
 * `Buffer.from("hello")` named `.jpg` is refused at the door, correctly, and
 * would look like the parenting being broken. `FF D8 FF E0` then a JFIF header
 * is the smallest thing that is genuinely one.
 */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

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
      mbos_positions, mbos_attendance_days, mbos_user_territories,
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
      role: "associate",
      initials: "MP",
    })
    .returning();
  salesman = row;
  await db.insert(appAccess).values({ id: id("acc"), userId: salesman.id, app: "field" });
  /* ALLOCATED. Nowhere allocated now means no book at all, so without this
     every pull in this file would come back empty and each assertion would
     pass or fail for a reason that has nothing to do with what it tests. The
     rule has its own tests in `field-book.test.ts`. */
  await db.insert(mbosUserTerritories).values({
    id: id("ut"),
    userId: salesman.id,
    kind: "state",
    region: "Maharashtra",
  });

  const [c] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: "Sai Paint Depot",
      phone: "9822200011",
      contactPerson: "Anil",
      city: "Nagpur",
      region: "Maharashtra",
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
    role: "associate",
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
        region: "Maharashtra",
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


/* ------------------------------------------- the attendance selfie, and its
 * whole life: taken, uploaded, PARENTED, kept, and readable by somebody. */

describe("An attendance photograph survives the night and can be opened", () => {
  /*
   * EVERY MBOS PHOTOGRAPH WAS DELETED BY THE NIGHTLY JOB.
   *
   * `storeMbosMedia` never wrote `parentType`/`parentId` — the route read an
   * `entityId` nothing sends, and the handset's own `parentType` was ignored —
   * so every field upload landed unparented. `sweepOrphans` selects exactly
   * that (`parentId is null` past the orphan window), removes the bytes and
   * marks the row removed. A selfie taken on Monday was gone on Tuesday, and
   * in the meantime only the salesman who took it could open it, because
   * `canRead` falls back to "unbound and still the uploader's own".
   *
   * That is the difference between an attachment and a file with a
   * twenty-four-hour life, and it is why this is pinned rather than left to
   * the type checker: nothing about a null column is a type error.
   */
  test("an uploaded selfie is filed against the attendance day, not orphaned", async () => {
    const attendanceId = id("mbos_att");
    await db.execute(sql`
      insert into mbos_attendance_days (id, user_id, day, check_in_at, status)
      values (${attendanceId}, ${salesman.id},
              (now() at time zone 'Asia/Kolkata')::date, now(), 'present')
    `);

    const clientId = `mbos_media_${randomUUID()}`;
    const stored = await storeMbosMedia(principal, {
      clientId,
      kind: "selfie",
      parentType: "attendance",
      parentId: attendanceId,
      filename: "selfie.jpg",
      bytes: JPEG,
    });
    assert.ok(stored.ok, `the upload was refused: ${!stored.ok && stored.error}`);

    const [row] = await db
      .select({ parentType: attachments.parentType, parentId: attachments.parentId })
      .from(attachments)
      .where(eq(attachments.id, clientId));
    assert.equal(
      row.parentType,
      "mbos_attendance",
      "the handset says `attendance`; the enum says `mbos_attendance` — the mapping is what files it",
    );
    assert.equal(row.parentId, attendanceId, "a null parent is a file the nightly sweep deletes");
  });

  test("and the nightly orphan sweep leaves it alone", async () => {
    const attendanceId = id("mbos_att");
    await db.execute(sql`
      insert into mbos_attendance_days (id, user_id, day, check_in_at, status)
      values (${attendanceId}, ${salesman.id},
              (now() at time zone 'Asia/Kolkata')::date, now(), 'present')
    `);

    const parented = `mbos_media_${randomUUID()}`;
    const orphan = `mbos_media_${randomUUID()}`;
    await storeMbosMedia(principal, {
      clientId: parented,
      kind: "selfie",
      parentType: "attendance",
      parentId: attendanceId,
      filename: "selfie.jpg",
      bytes: JPEG,
    });
    /* One with no parent, to prove the sweep still does its job — the fix must
       not be "the sweep stopped working". */
    await storeMbosMedia(principal, {
      clientId: orphan,
      kind: "selfie",
      filename: "selfie.jpg",
      bytes: JPEG,
    });

    /* Both older than the window. The sweep reads `uploadedAt`, so the clock
       is moved rather than the test waiting a day. */
    await db.execute(sql`
      update attachments set uploaded_at = now() - interval '10 days'
       where id in (${parented}, ${orphan})
    `);

    await sweepOrphans();

    const rows = await db
      .select({ id: attachments.id, status: attachments.status })
      .from(attachments)
      .where(inArray(attachments.id, [parented, orphan]));
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    assert.equal(byId.get(parented), "available", "the selfie was swept away with the orphans");
    assert.equal(byId.get(orphan), "removed", "the sweep must still remove what belongs to nothing");
  });

  /*
   * AND IT DOES NOT LIVE FOR EVER.
   *
   * The opposite failure to the one above, and the reason this file now pins
   * both ends: a photograph of an employee's face is evidence of a moment, and
   * a moment nobody asks about within a day or two is a moment nobody will ask
   * about at all. Kept indefinitely it stops being verification and becomes a
   * standing collection of photographs of staff — worse to hold, worse to
   * leak, and not what anybody asked for.
   *
   * `mbos.attendance.selfieRetentionHours` is the window and the sweep runs
   * hourly, so the number on the screen means roughly what it says rather than
   * "some time in the next day or so".
   */
  test("a selfie past its window has its image deleted", async () => {
    const attendanceId = id("mbos_att");
    await db.execute(sql`
      insert into mbos_attendance_days (id, user_id, day, check_in_at, status)
      values (${attendanceId}, ${salesman.id},
              (now() at time zone 'Asia/Kolkata')::date, now(), 'present')
    `);

    const old = `mbos_media_${randomUUID()}`;
    const fresh = `mbos_media_${randomUUID()}`;
    for (const clientId of [old, fresh]) {
      await storeMbosMedia(principal, {
        clientId,
        kind: "selfie",
        parentType: "attendance",
        parentId: attendanceId,
        filename: "selfie.jpg",
        bytes: JPEG,
      });
    }

    /* The window is 72 hours by default; four days back clears it and one hour
       back plainly does not. The clock is moved rather than the test waiting. */
    await db.execute(sql`
      update attachments set uploaded_at = now() - interval '4 days' where id = ${old}
    `);

    await sweepAttendanceSelfies();

    const rows = await db
      .select({ id: attachments.id, status: attachments.status })
      .from(attachments)
      .where(inArray(attachments.id, [old, fresh]));
    const byId = new Map(rows.map((r) => [r.id, r.status]));

    assert.equal(byId.get(old), "removed", "a photograph past its window is still openable");
    assert.equal(
      byId.get(fresh),
      "available",
      "a photograph inside its window was deleted early — the manager never got to look",
    );
  });

  /*
   * The distinction the whole design rests on. "A photograph was taken at
   * 09:04 and has since been deleted" and "no photograph was taken" are
   * different facts about somebody's attendance, and the second is the one
   * that looks like a person cutting a corner. A sweep that nulled the column
   * would rewrite the first into the second on the record a payslip is read
   * against — months later, silently, with nobody able to tell.
   */
  test("and the day keeps the id, so a deleted photograph is not a missing one", async () => {
    const attendanceId = id("mbos_att");
    const clientId = `mbos_media_${randomUUID()}`;
    await db.execute(sql`
      insert into mbos_attendance_days (id, user_id, day, check_in_at, status,
                                        check_in_selfie_id)
      values (${attendanceId}, ${salesman.id},
              (now() at time zone 'Asia/Kolkata')::date, now(), 'present', null)
    `);
    await storeMbosMedia(principal, {
      clientId,
      kind: "selfie",
      parentType: "attendance",
      parentId: attendanceId,
      filename: "selfie.jpg",
      bytes: JPEG,
    });
    await db.execute(sql`
      update mbos_attendance_days set check_in_selfie_id = ${clientId}
       where id = ${attendanceId}
    `);
    await db.execute(sql`
      update attachments set uploaded_at = now() - interval '4 days' where id = ${clientId}
    `);

    await sweepAttendanceSelfies();

    const [day] = await db
      .select({ selfie: mbosAttendanceDays.checkInSelfieId })
      .from(mbosAttendanceDays)
      .where(eq(mbosAttendanceDays.id, attendanceId));
    assert.equal(
      day.selfie,
      clientId,
      "the day forgot it was ever photographed — an honest check-in now reads as a skipped one",
    );
  });

  /*
   * A cheque, a shop front and a damaged can are photographs OF something,
   * attached to records that outlive them. Only the selfie has a clock on it,
   * and a sweep that reached the others would be destroying evidence of a
   * payment to enforce a privacy rule about faces.
   */
  test("a visit photograph is not touched by the selfie sweep", async () => {
    const visitPhoto = `mbos_media_${randomUUID()}`;
    await storeMbosMedia(principal, {
      clientId: visitPhoto,
      kind: "shopfront",
      parentType: "visit",
      parentId: id("mbos_visit"),
      filename: "shop.jpg",
      bytes: JPEG,
    });
    await db.execute(sql`
      update attachments set uploaded_at = now() - interval '90 days' where id = ${visitPhoto}
    `);

    await sweepAttendanceSelfies();

    const [row] = await db
      .select({ status: attachments.status })
      .from(attachments)
      .where(eq(attachments.id, visitPhoto));
    assert.equal(
      row.status,
      "available",
      "the selfie retention window reached a photograph that is not a selfie",
    );
  });

  /*
   * And somebody has to be able to LOOK at it. `customerBehind` falls through
   * to the `calls` table for any parent it does not name, so an attendance id
   * was looked up among calls, found nothing, and every selfie answered 404 —
   * to the salesman in it and to the manager it exists for. It failed shut,
   * which is why nothing noticed: no screen had ever displayed one.
   */
  test("the salesman may open his own, and a national manager may too", async () => {
    const attendanceId = id("mbos_att");
    await db.execute(sql`
      insert into mbos_attendance_days (id, user_id, day, check_in_at, status)
      values (${attendanceId}, ${salesman.id},
              (now() at time zone 'Asia/Kolkata')::date, now(), 'present')
    `);
    const clientId = `mbos_media_${randomUUID()}`;
    await storeMbosMedia(principal, {
      clientId,
      kind: "selfie",
      parentType: "attendance",
      parentId: attendanceId,
      filename: "selfie.jpg",
      bytes: JPEG,
    });

    setTestUser(salesman);
    assert.equal(await canRead(clientId), true, "he cannot open a photograph of himself");

    /* A manager with no territory rows is national — `managerScope` says so,
       and `onlyMine` reads the same field to mean the same thing in SQL.
       He HOLDS THE SALES APP, which is what this test was missing: "whoever
       can see his attendance" means whoever can open `/sales/attendance`, and
       that layout redirects anybody without the grant whatever their role. A
       manager with no apps at all can see nothing in MahekOne, so asserting he
       could open a photograph was asserting something no screen offers. */
    const [manager] = await db
      .insert(users)
      .values({
        id: id("usr"),
        name: "Vikram",
        email: "vikram@test.local",
        passwordHash: "x",
        role: "manager",
        initials: "VS",
      })
      .returning();
    await db.insert(appAccess).values({ id: id("acc"), userId: manager.id, app: "sales" });
    setTestUser(manager);
    assert.equal(await canRead(clientId), true, "the manager the photograph exists for cannot see it");
  });

  test("but another salesman may not, however he came by the id", async () => {
    const attendanceId = id("mbos_att");
    await db.execute(sql`
      insert into mbos_attendance_days (id, user_id, day, check_in_at, status)
      values (${attendanceId}, ${salesman.id},
              (now() at time zone 'Asia/Kolkata')::date, now(), 'present')
    `);
    const clientId = `mbos_media_${randomUUID()}`;
    await storeMbosMedia(principal, {
      clientId,
      kind: "selfie",
      parentType: "attendance",
      parentId: attendanceId,
      filename: "selfie.jpg",
      bytes: JPEG,
    });

    /* A second field salesman, with a territory of his own so he is scoped
       rather than national. */
    const [other] = await db
      .insert(users)
      .values({
        id: id("usr"),
        name: "Rakesh",
        email: "rakesh@test.local",
        passwordHash: "x",
        role: "associate",
        initials: "RK",
      })
      .returning();
    await db.insert(appAccess).values({ id: id("acc"), userId: other.id, app: "field" });
    await db.execute(sql`
      -- Renamed: the table stopped being managers-only. A salesman's working
      -- cities live here too, told apart by kind, which defaults to region --
      -- the value managerScope asks for.
      insert into mbos_user_territories (id, user_id, region)
      values (${id("terr")}, ${other.id}, 'Nowhere')
    `);

    setTestUser(other);
    assert.equal(
      await canRead(clientId),
      false,
      "a salesman could fetch a colleague's photograph by id",
    );
  });

  /*
   * THE SAME REFUSAL FOR THE SALESMAN THE TEST ABOVE CAREFULLY AVOIDS.
   *
   * That one gives the colleague a territory row on purpose — "so he is scoped
   * rather than national" — and it passed for as long as it has existed. The
   * hole was the case it stepped around: `managerScope` answers
   * `salesmanIds: null`, meaning EVERYBODY, for anyone with no `region` row,
   * and a plain field salesman has none. Which is nearly all of them. So the
   * ordinary colleague — no territory, just the field app — got the national
   * answer and could open anybody's check-in photograph by id.
   *
   * It failed OPEN, the dangerous direction, and that is why it lasted: nothing
   * looked broken, because everything worked. The doc comment on
   * `canReadAttendanceSelfie` has promised this refusal from the day it was
   * written; only now does the code hold it.
   */
  test("nor may a salesman with no territory at all, which is most of them", async () => {
    const attendanceId = id("mbos_att");
    await db.execute(sql`
      insert into mbos_attendance_days (id, user_id, day, check_in_at, status)
      values (${attendanceId}, ${salesman.id},
              (now() at time zone 'Asia/Kolkata')::date, now(), 'present')
    `);
    const clientId = `mbos_media_${randomUUID()}`;
    await storeMbosMedia(principal, {
      clientId,
      kind: "selfie",
      parentType: "attendance",
      parentId: attendanceId,
      filename: "selfie.jpg",
      bytes: JPEG,
    });

    /* No `mbos_user_territories` row — the ordinary state of a field salesman,
       and the one that used to resolve to "national, sees everybody". */
    const [plain] = await db
      .insert(users)
      .values({
        id: id("usr"),
        name: "Suresh",
        email: "suresh@test.local",
        passwordHash: "x",
        role: "associate",
        initials: "SP",
      })
      .returning();
    await db.insert(appAccess).values({ id: id("acc"), userId: plain.id, app: "field" });

    setTestUser(plain);
    assert.equal(
      await canRead(clientId),
      false,
      "an unscoped salesman could open a colleague's check-in photograph",
    );
  });

  /*
   * And the grant is what separates the two, not the role.
   *
   * `/sales/layout.tsx` redirects anybody without the `sales` app whatever
   * their role — there is no implicit access for an admin, because
   * `listUserApps` reads `app_access` and nothing else. So a manager who was
   * never given the Sales Dashboard has no screen on which to see anybody's
   * attendance, and a photograph is not a back door to one.
   */
  test("a manager without the Sales Dashboard has no screen for it, and no file either", async () => {
    const attendanceId = id("mbos_att");
    await db.execute(sql`
      insert into mbos_attendance_days (id, user_id, day, check_in_at, status)
      values (${attendanceId}, ${salesman.id},
              (now() at time zone 'Asia/Kolkata')::date, now(), 'present')
    `);
    const clientId = `mbos_media_${randomUUID()}`;
    await storeMbosMedia(principal, {
      clientId,
      kind: "selfie",
      parentType: "attendance",
      parentId: attendanceId,
      filename: "selfie.jpg",
      bytes: JPEG,
    });

    const [ungranted] = await db
      .insert(users)
      .values({
        id: id("usr"),
        name: "Asha",
        email: "asha@test.local",
        passwordHash: "x",
        role: "manager",
        initials: "AS",
      })
      .returning();

    setTestUser(ungranted);
    assert.equal(await canRead(clientId), false, "a role is not a grant");
  });
});


/* --------------------------------- the day's SESSIONS reach the office, with
 * a photograph at each end of each one. */

describe("Every check-in and check-out is photographed, all day", () => {
  /*
   * The server held ONE pair of timestamps for a day the handset models as a
   * list of sessions — so 9-to-1 plus 2-to-6 arrived as nine hours on the
   * record that feeds a payslip, and there was nowhere to put more than two
   * photographs. A day with two breaks takes six.
   */
  test("a three-session day arrives whole, with six selfies", async () => {
    const attendanceId = id("mbos_att");
    const day = new Date().toISOString().slice(0, 10);
    const t = (h: number) =>
      new Date(`${day}T${String(h).padStart(2, "0")}:00:00+05:30`).getTime();

    /* Nine to one, two to four, five and still out. Two breaks, three
       sessions, six photographs — the shape the office could not see. */
    const sessions = [
      { inAt: t(9), outAt: t(13), inSelfieId: "s1", outSelfieId: "s2" },
      { inAt: t(14), outAt: t(16), inSelfieId: "s3", outSelfieId: "s4" },
      { inAt: t(17), outAt: null, inSelfieId: "s5", outSelfieId: null },
    ];

    const [result] = await ingestSyncBatch(principal, [
      item({
        entityType: "attendance",
        entityId: attendanceId,
        payload: { id: attendanceId, day, checkInAt: t(9), sessions, selfieId: "s1" },
      }),
    ]);
    assert.equal(result.status, "accepted", JSON.stringify(result));

    const [row] = await db
      .select({ sessions: mbosAttendanceDays.sessions })
      .from(mbosAttendanceDays)
      .where(eq(mbosAttendanceDays.id, attendanceId));

    assert.equal(row.sessions.length, 3, "the day arrived as one pair — the breaks are gone");
    assert.equal(row.sessions[0].outSelfieId, "s2", "the check-OUT photograph had nowhere to land");
    assert.equal(
      row.sessions[2].outAt,
      null,
      "the open session must stay open — `undefined` reads as neither",
    );
    assert.deepEqual(
      row.sessions.flatMap((x) => [x.inSelfieId, x.outSelfieId]).filter(Boolean),
      ["s1", "s2", "s3", "s4", "s5"],
      "every photograph of the day, in the order it was taken",
    );
  });

  /*
   * A LATER ARRIVAL GROWS THE DAY. The check-in mark is deliberately never
   * moved by a second sync, and the sessions are the opposite case: the
   * afternoon and its two photographs are new facts about a row that already
   * exists, and the whole list is what the handset sends.
   */
  test("the afternoon session is added rather than dropped", async () => {
    const attendanceId = id("mbos_att");
    const day = new Date().toISOString().slice(0, 10);
    const t = (h: number) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00+05:30`).getTime();

    await ingestSyncBatch(principal, [
      item({
        entityType: "attendance",
        entityId: attendanceId,
        payload: {
          id: attendanceId,
          day,
          checkInAt: t(9),
          sessions: [{ inAt: t(9), outAt: t(13), inSelfieId: "m1", outSelfieId: "m2" }],
        },
      }),
    ]);

    await ingestSyncBatch(principal, [
      item({
        entityType: "attendance",
        entityId: attendanceId,
        payload: {
          id: attendanceId,
          day,
          sessions: [
            { inAt: t(9), outAt: t(13), inSelfieId: "m1", outSelfieId: "m2" },
            { inAt: t(14), outAt: t(18), inSelfieId: "a1", outSelfieId: "a2" },
          ],
        },
      }),
    ]);

    const [row] = await db
      .select({ sessions: mbosAttendanceDays.sessions })
      .from(mbosAttendanceDays)
      .where(eq(mbosAttendanceDays.id, attendanceId));
    assert.equal(row.sessions.length, 2, "the second check-in of the day was lost");
    assert.equal(row.sessions[1].outSelfieId, "a2");
  });

  /*
   * MEDIA SYNCS AFTER ITS PARENT — that is the whole reason it is a separate
   * queue — so an attendance row routinely names a photograph whose bytes are
   * still on the phone. The two selfie columns are foreign keys, and a key
   * does not care why: it would refuse the check-in over a file in transit,
   * which is the one write in this app that must not be refused.
   */
  test("a check-in naming a photograph that has not arrived is still accepted", async () => {
    const attendanceId = id("mbos_att");
    const day = new Date().toISOString().slice(0, 10);
    const [result] = await ingestSyncBatch(principal, [
      item({
        entityType: "attendance",
        entityId: attendanceId,
        payload: {
          id: attendanceId,
          day,
          checkInAt: Date.now(),
          selfieId: `mbos_media_${randomUUID()}`,
          sessions: [{ inAt: Date.now(), outAt: null, inSelfieId: "not-uploaded-yet" }],
        },
      }),
    ]);
    assert.equal(
      result.status,
      "accepted",
      "the day was refused because a photograph was still uploading",
    );

    const [row] = await db
      .select({
        selfie: mbosAttendanceDays.checkInSelfieId,
        sessions: mbosAttendanceDays.sessions,
      })
      .from(mbosAttendanceDays)
      .where(eq(mbosAttendanceDays.id, attendanceId));
    assert.equal(row.selfie, null, "the key column waits for the bytes");
    assert.equal(
      row.sessions[0].inSelfieId,
      "not-uploaded-yet",
      "the LIST keeps the id regardless — the mark is never lost to an upload's ordering",
    );
  });
});


/* -------------------------------------------------- the delta actually RUNS */

/*
 * NOTHING HAD EVER EXECUTED `buildPull`.
 *
 * It is the query behind every sync from every handset, several times an hour,
 * and the only thing checking it was `mbos-wire.test.ts` — which reads the
 * file as TEXT to compare column names against the handset's schema. Correct
 * columns in a query that throws is exactly the state it was in.
 *
 * `and p.plan_date >= (now() at time zone $tz)::date - $days` looks right and
 * is not: `$days` is an untyped bind parameter, so Postgres resolves the
 * subtraction as `date - date`, gets an integer, and `date >= integer` has no
 * operator. Two of the fourteen queries in there carried it, and they sit
 * inside a `Promise.all` — so the rejection took the whole delta with it and
 * every pull from a handset holding a cursor answered 500. Which is every pull
 * after sign-in: the journey, the customers, the products, the tasks, the
 * price list, all of it, from the moment the bootstrap gave the phone a
 * cursor.
 *
 * The point of this test is not the date arithmetic. It is that the delta is
 * RUN, with a cursor, so the next query that only fails at the database fails
 * here instead of on a phone in Nagpur.
 */
describe("The pull delta runs — with a cursor, which is every pull after sign-in", () => {
  test("a cursor'd pull answers rather than throwing", async () => {
    /* A cursor the way the handset gets one: from the bootstrap. */
    const bootstrap = await buildBootstrap(principal);
    assert.ok(bootstrap.cursor, "the bootstrap issued no cursor to pull with");

    const delta = await buildPull(principal, bootstrap.cursor);

    assert.ok(delta.cursor, "the delta issued no cursor to continue from");
    /* Every channel the handset applies has to be present and iterable —
       `applyPull` walks each one, and a missing key is a channel silently
       never applied. */
    for (const channel of [
      "customers", "products", "timeline", "notifications", "transcripts",
      "journeyStops", "planDays", "priceList", "schemes", "documents",
      "courses", "approvals", "performance", "tasks", "leads", "samples",
      "leaveBalances", "holidays", "salary", "deletions",
      /* The three customer-history channels. `applyPull` walks all three and
         none of them was asserted here — `customerBills` is new, and the two
         beside it had simply been missed. */
      "customerOrders", "customerPayments", "customerBills",
    ] as const) {
      assert.ok(
        Array.isArray((delta as Record<string, unknown>)[channel]),
        `the delta sent no ${channel} array — the handset applies that channel`,
      );
    }
    assert.equal(typeof delta.config, "object", "the config is not optional");
  });

  /*
   * AND THE CUSTOMER-HISTORY CHANNELS CARRY ROWS, which `Array.isArray` above
   * cannot tell you.
   *
   * The customer record's Timeline, Orders and Payments tabs came back empty
   * on real handsets and this file was the test that should have caught it —
   * it asserted the three channels were arrays and stopped, which an empty
   * array satisfies perfectly. The comment three lines below this one already
   * says the rule for the journey channels: a query that returns nothing
   * cannot tell you it would have worked. These three had never been held to
   * it.
   */
  test("orders, payments and timeline arrive with rows behind them", async () => {
    await db.insert(orders).values({
      id: id("ord"),
      customerId: shop.id,
      userId: salesman.id,
      orderedAt: new Date(),
      status: "confirmed",
      totalAmount: 250_000,
      orderNo: "SO-1",
    });
    await db.insert(paymentReceipts).values({
      id: id("rcp"),
      customerId: shop.id,
      idempotencyKey: id("idem"),
      amount: 100_000,
      mode: "NEFT",
      receivedAt: new Date().toISOString().slice(0, 10),
      status: "confirmed",
      recordedById: salesman.id,
    });
    await db.insert(timelineEvents).values({
      id: id("tl"),
      customerId: shop.id,
      eventType: "order",
      sourceApp: "crm",
      sourceRecordId: id("src"),
      occurredAt: new Date(),
      summary: "Order placed",
    });

    const boot = await buildBootstrap(principal);
    assert.ok(
      (boot.customerOrders as unknown[]).length > 0,
      "the bootstrap carried no order history — the Orders tab is empty on the handset",
    );
    assert.ok(
      (boot.customerPayments as unknown[]).length > 0,
      "the bootstrap carried no receipts — the Payments tab is empty on the handset",
    );
    assert.ok(
      (boot.timeline as unknown[]).length > 0,
      "the bootstrap carried no timeline — that tab draws nothing at all when empty",
    );

    /*
     * EPOCH MILLISECONDS, not a timestamp string.
     *
     * `timeline_events.occurredAt` is `INTEGER NOT NULL` on the handset and
     * its own writes put `Date.now()` there. A string lands in the same column
     * as TEXT, renders as `NaN undefined`, and — because SQLite orders every
     * integer before every text value — sorts the office's events onto one
     * side of the salesman's own whatever the dates say.
     */
    const event = (boot.timeline as Record<string, unknown>[])[0];
    assert.equal(
      typeof event.occurredAt,
      "number",
      "occurredAt must be epoch milliseconds — the handset stores this column as INTEGER",
    );

    /* And on the delta, which is every pull after sign-in. The two history
       channels are deliberately not cursor-gated, so they come every time. */
    const delta = await buildPull(principal, boot.cursor);
    assert.ok(
      (delta.customerOrders as unknown[]).length > 0,
      "the delta carried no order history",
    );
    assert.ok(
      (delta.customerPayments as unknown[]).length > 0,
      "the delta carried no receipts",
    );
  });

  /*
   * And the two channels the journey tab is made of, with real rows behind
   * them — a query that returns nothing cannot tell you it would have worked.
   */
  /*
   * A DAY HE STARTED HIMSELF.
   *
   * The negotiation ran one way — the office proposes, he agrees or refuses —
   * and `handlePlanDay` answered a day it could not find with `retry`, for
   * ever. So a Tuesday the office had not thought about could not be worked at
   * all, which is most Tuesdays.
   *
   * Sent as a real payload through `ingestSyncBatch` rather than by calling the
   * handler, because that is the only way the shape of the thing is checked
   * too: every one of the three Date-binding faults in this module type-checked
   * perfectly and failed on contact with a real item.
   */
  describe("planning a day nobody proposed", () => {
    const tomorrow = () =>
      new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    test("a created day is born agreed, marked his, and carries the city", async () => {
      const planId = id("mbos_plan");
      const [result] = await ingestSyncBatch(principal, [
        item({
          entityType: "plan_day",
          entityId: planId,
          op: "create",
          payload: { answer: "agreed", planDate: tomorrow(), city: "Nagpur" },
        }),
      ]);

      assert.equal(result.status, "accepted", JSON.stringify(result));

      const [row] = await db.execute<Record<string, unknown>>(sql`
        select day_state::text as "dayState", city, self_planned as "selfPlanned",
               user_id as "userId", plan_date::text as "planDate"
          from mbos_journey_plans where id = ${planId}
      `);

      assert.ok(row, "the day never landed");
      /* `agreed`, never `planned`: the city is settled and the shops are not
         picked yet, which is exactly what that state means. */
      assert.equal(row.dayState, "agreed");
      assert.equal(row.city, "Nagpur");
      assert.equal(row.selfPlanned, true, "nothing records that he started it");
      assert.equal(row.userId, salesman.id, "a handset planned somebody else's day");
    });

    /*
     * The check that matters most. `pickCandidates` filters the shop list by
     * the day's city and applies NO clause at all when it is empty, so a day
     * created without one opens the picker on the entire book — the unfiltered
     * list Mahek overruled, arriving silently.
     */
    test("a day with no city is refused, because the picker would show the whole book", async () => {
      const [result] = await ingestSyncBatch(principal, [
        item({
          entityType: "plan_day",
          entityId: id("mbos_plan"),
          op: "create",
          payload: { answer: "agreed", planDate: tomorrow(), city: "   " },
        }),
      ]);

      assert.equal(result.status, "rejected", JSON.stringify(result));
      assert.match(
        (result as { message: string }).message,
        /city/i,
        "the refusal has to say what is missing",
      );
    });

    test("a day already gone is refused", async () => {
      const [result] = await ingestSyncBatch(principal, [
        item({
          entityType: "plan_day",
          entityId: id("mbos_plan"),
          op: "create",
          payload: { answer: "agreed", planDate: "2020-01-06", city: "Nagpur" },
        }),
      ]);
      assert.equal(result.status, "rejected", JSON.stringify(result));
    });

    /*
     * A date the office has already proposed. The unique index on
     * (user_id, plan_date) is what stops the second row, and the salesman has
     * to be told which day it is rather than watching the create fail quietly.
     */
    test("a day the office already proposed is refused, not duplicated", async () => {
      const day = tomorrow();
      await db.execute(sql`
        insert into mbos_journey_plans (id, user_id, plan_date, city, day_state, proposed_by_id)
        values (${id("mbos_plan")}, ${salesman.id}, ${day}::date, 'Wardha', 'proposed', ${salesman.id})
      `);

      const [result] = await ingestSyncBatch(principal, [
        item({
          entityType: "plan_day",
          entityId: id("mbos_plan"),
          op: "create",
          payload: { answer: "agreed", planDate: day, city: "Nagpur" },
        }),
      ]);

      assert.equal(result.status, "rejected", JSON.stringify(result));

      const rows = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from mbos_journey_plans
         where user_id = ${salesman.id} and plan_date = ${day}::date
      `);
      assert.equal(Number(rows[0].n), 1, "two rows for one day");
    });

    /* Answering a day that does not exist still retries — a create is the new
       door, not a replacement for the one the negotiation uses. */
    test("an ANSWER to a day the office has not sent yet still waits", async () => {
      const [result] = await ingestSyncBatch(principal, [
        item({
          entityType: "plan_day",
          entityId: id("mbos_plan"),
          op: "update",
          payload: { answer: "agreed" },
        }),
      ]);
      assert.equal(result.status, "retry", JSON.stringify(result));
    });

    test("the day he started comes back down the delta, marked as his", async () => {
      const before = await buildPull(principal, null);

      const planId = id("mbos_plan");
      await ingestSyncBatch(principal, [
        item({
          entityType: "plan_day",
          entityId: planId,
          op: "create",
          payload: { answer: "agreed", planDate: tomorrow(), city: "Nagpur" },
        }),
      ]);

      const delta = await buildPull(principal, before.cursor);
      const days = delta.planDays as Array<Record<string, unknown>>;
      const mine = days.find((d) => d.id === planId);

      assert.ok(mine, "his own day never reached his handset");
      assert.equal(mine.dayState, "agreed");
      assert.equal(
        mine.selfPlanned,
        true,
        "the mark has to travel, or the handset cannot tell his day from the office's",
      );
    });
  });

  test("a plan day and its stop both come down the delta", async () => {
    /* The cursor is taken FIRST, because the delta is `updated_at`-gated: a
       cursor issued after the rows exist excludes them by design, and a test
       that got that backwards would report the channel dead when it is not. */
    const before = await buildPull(principal, null);

    const planId = id("mbos_plan");
    const today = new Date().toISOString().slice(0, 10);
    await db.execute(sql`
      insert into mbos_journey_plans (id, user_id, plan_date, city, day_state, proposed_by_id)
      values (${planId}, ${salesman.id}, ${today}::date, 'Nagpur', 'planned', ${salesman.id})
    `);
    await db.execute(sql`
      insert into mbos_journey_stops (id, plan_id, customer_id, sequence, status)
      values (${id("mbos_stop")}, ${planId}, ${shop.id}, 1, 'planned')
    `);

    const delta = await buildPull(principal, before.cursor);

    const days = delta.planDays as Array<Record<string, unknown>>;
    const mine = days.find((d) => d.id === planId);
    assert.ok(mine, "the plan day never reached the handset — see the note above");
    assert.equal(mine.planDate, today, "the date has to arrive as a plain YYYY-MM-DD");
    assert.equal(mine.dayState, "planned");
    assert.equal(mine.city, "Nagpur");
    assert.equal(mine.picked, 1, "the stop count the Coming up card prints");

    const stops = delta.journeyStops as Array<Record<string, unknown>>;
    assert.equal(
      stops.filter((x) => x.customerId === shop.id).length,
      1,
      "the stop never reached the handset either",
    );
  });

  /*
   * B3-14 §O. WHAT THE MONEY IS AGAINST.
   *
   * The handset carried one number, `outstandingPaise`, so a salesman could
   * say a shop owed 47,000 and not which invoices that was — and because
   * nothing could name a bill, every collection spread oldest-first even where
   * the customer was plainly paying against the invoice in his hand.
   *
   * These assert the two halves that make the picker honest: an open bill
   * arrives with the id `handlePayment` validates against, and an `unstated`
   * bill arrives SAYING it is unstated, because its balance is the full amount
   * purely because nobody has spoken for it — printing that as a debt is the
   * imported-book mistake arriving on a phone.
   */
  test("the open bills behind the outstanding come down, with their position", async () => {
    const stated = id("bill");
    const unstated = id("bill");
    const settled = id("bill");
    const day = new Date().toISOString().slice(0, 10);

    await db.execute(sql`
      insert into bills (id, customer_id, bill_no, bill_date, amount, paid_amount, payment_position)
      values
        (${stated},   ${shop.id}, 'MMI/26-27/9001', ${day}::date, 250000, 50000, 'stated'),
        (${unstated}, ${shop.id}, 'MMI/26-27/9002', ${day}::date, 400000, 0,     'unstated'),
        (${settled},  ${shop.id}, 'MMI/26-27/9003', ${day}::date, 100000, 100000,'stated')
    `);

    const payload = await buildBootstrap(principal);
    const rows = payload.customerBills as Array<Record<string, unknown>>;

    const open = rows.find((b) => b.id === stated);
    assert.ok(open, "the open bill never reached the handset, so nothing can be named");
    assert.equal(open.billNo, "MMI/26-27/9001");
    assert.equal(open.balancePaise, 200000, "the balance is what is still open, not the face value");
    assert.equal(open.paymentPosition, "stated");

    const quiet = rows.find((b) => b.id === unstated);
    assert.ok(quiet, "an unstated bill is still a bill somebody can pay against");
    assert.equal(
      quiet.paymentPosition,
      "unstated",
      "without this the screen prints the full amount as a debt — the imported-book mistake, on a phone",
    );

    assert.equal(
      rows.find((b) => b.id === settled),
      undefined,
      "a settled bill must not be offered: naming it is refused with `bill_settled`, " +
        "which reads as the app being wrong rather than the phone being stale",
    );

    /* The customer's name, the aging bucket and the status are on the Accounts
       row and have nowhere to land here. One extra key empties the phone. */
    assert.deepEqual(
      Object.keys(open).filter((k) => !ALLOWED_BILL_KEYS.has(k)),
      [],
      "the payload was forwarded rather than trimmed to the handset",
    );
  });

  /*
   * The bootstrap sent NO plan days at all, and the delta is `updated_at`
   * gated — so a day proposed before this handset signed in arrived on no pass
   * ever, and a fresh sign-in opened the Journey tab on nothing.
   */
  test("the bootstrap carries the days themselves, not only the stops", async () => {
    const planId = id("mbos_plan");
    await db.execute(sql`
      insert into mbos_journey_plans (id, user_id, plan_date, city, day_state, proposed_by_id)
      values (${planId}, ${salesman.id}, (now() at time zone 'Asia/Kolkata')::date + 2,
              'Amravati', 'proposed', ${salesman.id})
    `);

    const payload = await buildBootstrap(principal);
    const days = payload.planDays as Array<Record<string, unknown>>;
    const mine = days.find((d) => d.id === planId);
    assert.ok(mine, "a fresh sign-in got no plan days, so the Journey tab opens empty");
    assert.equal(mine.dayState, "proposed", "the day it is being ASKED about");
    assert.equal(mine.proposedBy, "Mahesh", "who asked — the card names them");
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
        region: "Maharashtra",
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
        region: "Maharashtra",
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
        region: "Maharashtra",
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
        region: "Maharashtra",
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
        role: "associate",
        initials: "RK",
      })
      .returning();

    await updateSettings([{ key: "mbos.devices.onePerPerson", value: false }], salesman.id);
    invalidateConfig();

    const outcome = await checkDeviceBinding(other.id, "probe-device");
    assert.equal(outcome.ok, false, "one salesman took over another's phone");
    // Generic on purpose: whose account this handset belongs to is an
    // admin's business, not something surfaced to whoever is holding it.
    assert.match(outcome.ok === false ? outcome.error : "", /contact your admin/i);
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

  test("a released handset can be claimed by somebody else — the whole point of releasing it", async () => {
    // Before the fix, `checkDeviceBinding`'s hard refusal read `existingForDevice.userId`
    // without ever checking `active`, so a released row still refused every OTHER
    // employee forever — release only ever freed the SAME employee to rebind. This is
    // the scenario the release button and its own error message exist for: handing a
    // physical phone to somebody new.
    await asOffice();
    await releaseDevice({ deviceId: "probe-device", reason: "Reassigned to a new joiner" });

    const [newHire] = await db
      .insert(users)
      .values({
        id: id("usr"),
        name: "Anjali",
        email: `anjali-${randomUUID().slice(0, 6)}@test.local`,
        phone: `98200${Math.floor(10000 + Math.random() * 89999)}`,
        passwordHash: "x",
        role: "associate",
        initials: "AJ",
      })
      .returning();

    const outcome = await checkDeviceBinding(newHire.id, "probe-device");
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
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

/**
 * Exactly what a bill row may carry to the handset.
 *
 * `customer_bills` is a SQLite table and `applyPull` inserts the columns that
 * arrived, so a key with no column throws — and because the whole pull is one
 * transaction, that throw empties the book. The wire test pins this against
 * the handset schema as text; this one pins it against a row that really came
 * out of the service.
 */
const ALLOWED_BILL_KEYS = new Set([
  "id", "customerId", "billNo", "billDate", "dueDate",
  "amountPaise", "paidPaise", "balancePaise", "overdueDays",
  "disputed", "paymentPosition",
]);

describe("The journey channels' delta pull", () => {
  /*
   * `PLAN_HISTORY_DAYS` bound as a bare parameter next to a `::date` cast
   * left Postgres unable to tell `date - integer` (returns date) from
   * `date - date` (returns integer) until the parameter's type was known, so
   * it defaulted to `date` and the surrounding `plan_date >= …` then failed
   * with "operator does not exist: date >= integer" — every delta pull for
   * every handset with a cursor, on both the stops channel and the days
   * channel. Nothing caught it because nothing had ever called buildPull with
   * a real cursor: this is that call.
   */
  test("does not throw once a cursor makes it filter by plan history", async () => {
    const cursor = encodeCursor(new Date(Date.now() - 60_000));
    const delta = await buildPull(principal, cursor);
    assert.ok(Array.isArray(delta.journeyStops));
    assert.ok(Array.isArray(delta.planDays));
  });
});

describe("Starting the day again after checking out", () => {
  /*
   * The handset already does the right thing: it clears its own checkOutAt,
   * appends a new session and resumes GPS collection. What it sends the
   * server for that resume is `{ id, day, sessions, resumedAt }` — no
   * checkInAt, no checkOutAt — and the server used to have nothing that
   * reacted to `resumedAt` at all, so the row's checkOutAt from the earlier
   * checkout just sat there. The Live map's "who's out" filter
   * (`checkInAt && !checkOutAt`) and `/api/mbos/positions`'s tracking gate
   * both read that same column, so a resumed salesman vanished from the map
   * and every fix he sent afterwards was silently discarded — while the sync
   * call itself kept answering "accepted".
   */
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  async function attendanceRow() {
    const [row] = await db
      .select()
      .from(mbosAttendanceDays)
      .where(and(eq(mbosAttendanceDays.userId, salesman.id), eq(mbosAttendanceDays.day, day)));
    return row;
  }

  test("a resume clears checkOutAt, and a real checkout sets it again — repeatedly", async () => {
    const checkIn = item({
      entityType: "attendance",
      op: "create",
      payload: { day, checkInAt: Date.now() - 3 * 3_600_000 },
    });
    const [inResult] = await ingestSyncBatch(principal, [checkIn]);
    assert.equal(inResult.status, "accepted", JSON.stringify(inResult));

    const checkOut = item({
      entityType: "attendance",
      entityId: checkIn.entityId,
      op: "update",
      payload: { day, checkOutAt: Date.now() - 2 * 3_600_000 },
    });
    const [outResult] = await ingestSyncBatch(principal, [checkOut]);
    assert.equal(outResult.status, "accepted", JSON.stringify(outResult));
    assert.ok((await attendanceRow()).checkOutAt, "the first checkout never landed");

    // Back out after lunch — the resume payload, exactly as the handset sends it.
    const resume = item({
      entityType: "attendance",
      entityId: checkIn.entityId,
      op: "update",
      payload: { day, sessions: "[]", resumedAt: Date.now() - 3_600_000 },
    });
    const [resumeResult] = await ingestSyncBatch(principal, [resume]);
    assert.equal(resumeResult.status, "accepted", JSON.stringify(resumeResult));
    assert.equal(
      (await attendanceRow()).checkOutAt,
      null,
      "resuming the day left the old checkout in place — the Live map and GPS tracking both read this column",
    );

    // A second real checkout — proving this is a toggle, not a one-time fix.
    const checkOutAgain = item({
      entityType: "attendance",
      entityId: checkIn.entityId,
      op: "update",
      payload: { day, checkOutAt: Date.now() },
    });
    await ingestSyncBatch(principal, [checkOutAgain]);
    assert.ok((await attendanceRow()).checkOutAt, "the second checkout never landed");

    const resumeAgain = item({
      entityType: "attendance",
      entityId: checkIn.entityId,
      op: "update",
      payload: { day, sessions: "[]", resumedAt: Date.now() },
    });
    await ingestSyncBatch(principal, [resumeAgain]);
    assert.equal(
      (await attendanceRow()).checkOutAt,
      null,
      "a second resume the same day did not reopen the row",
    );
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
