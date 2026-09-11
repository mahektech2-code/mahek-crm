/**
 * The journey opened from "Start visit", end to end through the real handler.
 *
 * IT RUNS THE HANDLER RATHER THAN READING IT, and that is why this exists
 * beside the handset's own pure tests. Four bugs in this codebase have had one
 * shape: a query correct in every way a type checker or a text-comparison test
 * can see, which throws at the database. `buildPull` carried two of them for
 * months because nothing had ever executed it. A Date bound into a raw
 * statement took the visit handler down, then the order handler, then the
 * visit handler again — and each time it came back as a RETRY, so the outbox
 * resent for ever and nothing on either end named the cause.
 *
 * What it pins is the half of the travel module that the `/travel` day log
 * cannot: a leg with a real gap between its two ends, and the strictness that
 * gap makes possible.
 *
 *   npm run test:integration
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  attachments,
  customers,
  mbosDevices,
  mbosTravelLegs,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { ingestSyncBatch, storeMbosMedia } from "@/lib/actions/mbos";
import { canRead } from "@/lib/services/attachment-service";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** Nagpur, Sadar. A real place, so a swap or a wrong sign is visible. */
const HERE = { lat: 21.1601, lng: 79.0805 };

/* A file that is a JPEG BY ITS BYTES — `sniffContentType` reads the signature
   and nothing else, so a buffer merely named `.jpg` is refused at the door,
   correctly, and would look like the parenting being broken. */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

let salesman: typeof users.$inferSelect;
let colleague: typeof users.$inferSelect;
let manager: typeof users.$inferSelect;
let shop: typeof customers.$inferSelect;
let principal: MbosPrincipal;

async function makeUser(name: string, role: "associate" | "manager") {
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
    })
    .returning();
  /* The app grant, because a level on its own is not one — see the note in
     `journeys.test.ts`. */
  await db.insert(appAccess).values({
    id: id("aca"),
    userId: row!.id,
    app: "crm",
    role,
  });
  return row!;
}

function item(over: Partial<SyncItem> & Pick<SyncItem, "entityType">): SyncItem {
  const entityId = over.entityId ?? id("leg");
  return {
    queueId: id("q"),
    entityId,
    op: "create",
    idempotencyKey: `${entityId}:${over.op ?? "create"}:${randomUUID()}`,
    clientCreatedAt: Date.now(),
    payload: {},
    ...over,
  };
}

/** A photograph the handset uploaded, parented to the leg, as the app does. */
async function photo(legId: string, name: string): Promise<string> {
  const out = await storeMbosMedia(principal, {
    clientId: `mbos_travel_${randomUUID().slice(0, 12)}`,
    kind: "odometer_photo",
    parentType: "travel_leg",
    parentId: legId,
    filename: name,
    bytes: JPEG,
  });
  assert.ok(out.ok, `the photograph should store: ${JSON.stringify(out)}`);
  return out.ok ? out.attachmentId : "";
}

/** The departure half of a bike leg, which every test below starts from. */
async function depart(legId: string, over: Record<string, unknown> = {}) {
  return ingestSyncBatch(principal, [
    item({
      entityType: "travel_leg",
      entityId: legId,
      payload: {
        day: "2026-09-10",
        modeKey: "own_bike",
        toLabel: shop.name,
        customerId: shop.id,
        purpose: "visit",
        startedAt: Date.now() - 30 * 60_000,
        endedAt: null,
        odometerStartKm: 41208,
        odometerPhotoId: await photo(legId, "start.jpg"),
        origin: "visit",
        ...over,
      },
    }),
  ]);
}

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  /* `mbos_travel_modes` is deliberately NOT truncated: it is reference data
     seeded by migration 0090, and a test that wiped it would be testing a
     deployment nobody has. */
  await db.execute(sql`
    truncate table
      mbos_travel_legs, mbos_expense_days, mbos_expenses, mbos_approvals,
      mbos_devices, mbos_visits, attachments,
      audit_log, notifications, app_access, sessions, customers, users,
      app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  salesman = await makeUser("Mahesh", "associate");
  colleague = await makeUser("Ramesh", "associate");
  manager = await makeUser("Vikram", "manager");

  await db.insert(appAccess).values([
    { id: id("aa"), userId: salesman.id, app: "field" },
    { id: id("aa"), userId: colleague.id, app: "field" },
    /* The Sales Dashboard grant, which is what actually decides who may look
       at somebody else's day — see `canReadTravelLegPhoto`. */
    { id: id("aa"), userId: manager.id, app: "sales" },
  ]);

  const [c] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: "Sai Paint Depot",
      phone: "9822200011",
      city: "Nagpur",
      kind: "customer",
      ownerId: salesman.id,
      salesAmId: salesman.id,
      gpsLat: HERE.lat,
      gpsLng: HERE.lng,
    })
    .returning();
  shop = c!;

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
  setTestUser(null);
  await db.$client.end();
});

/* ═══════════════════════════════════════════════════════════ the two ends */

describe("A journey opened when he sets off and closed when he arrives", () => {
  test("it lands open, closes with the second reading, and keeps both photographs", async () => {
    const legId = id("leg");
    const [out] = await depart(legId);
    assert.equal(out.status, "accepted", JSON.stringify(out));

    const [open] = await db.select().from(mbosTravelLegs).where(eq(mbosTravelLegs.id, legId));
    /* THE STATE `/travel` HAS NEVER BEEN ABLE TO EXPRESS: a leg being
       travelled. The day log writes `startedAt` and `endedAt` in the same
       breath, so before this every leg in the table was already over. */
    assert.equal(open.endedAt, null, "the leg should still be running");
    assert.equal(open.origin, "visit");
    assert.equal(open.odometerStartKm, 41208);
    assert.ok(open.odometerPhotoId, "the departure photograph");
    assert.equal(open.odometerEndPhotoId, null);

    const endPhoto = await photo(legId, "end.jpg");
    const [closed] = await ingestSyncBatch(principal, [
      item({
        entityType: "travel_leg",
        entityId: legId,
        op: "update",
        payload: {
          day: "2026-09-10",
          modeKey: "own_bike",
          customerId: shop.id,
          startedAt: Date.now() - 30 * 60_000,
          endedAt: Date.now(),
          odometerStartKm: 41208,
          odometerPhotoId: open.odometerPhotoId,
          odometerEndKm: 41231,
          odometerEndPhotoId: endPhoto,
          origin: "visit",
        },
      }),
    ]);
    assert.equal(closed.status, "accepted", JSON.stringify(closed));

    const [done] = await db.select().from(mbosTravelLegs).where(eq(mbosTravelLegs.id, legId));
    assert.ok(done.endedAt, "the leg should be closed");
    assert.equal(done.odometerEndKm, 41231);
    /*
     * TWO PHOTOGRAPHS, WHICH IS THE WHOLE POINT OF THE CHANGE. One
     * `odometer_photo_id` was right for a day log — both readings typed at
     * once, one picture of the meter as it stands — and cannot hold two
     * readings taken half an hour apart. The one that would have been missing
     * is the departure: the reading nobody can go back and check, because by
     * then the meter has moved.
     */
    assert.ok(done.odometerPhotoId, "the meter as he set off");
    assert.equal(done.odometerEndPhotoId, endPhoto, "the meter as he arrived");
    assert.notEqual(done.odometerPhotoId, done.odometerEndPhotoId);
  });

  test("the distance is NOT computed here, and that is deliberate", async () => {
    const legId = id("leg");
    await depart(legId);
    const [leg] = await db.select().from(mbosTravelLegs).where(eq(mbosTravelLegs.id, legId));
    /* `chosen_metres` is the policy engine's answer and it is worked out when
       the day is priced, from the odometer, the trail or a typed figure —
       never at ingest, because a leg synced the minute it ended has fewer
       trail positions behind it than the same leg has by evening. A handler
       that filled this in would be a second opinion that aged badly. */
    assert.equal(leg.chosenMetres, null);
    assert.equal(leg.odometerMetres, null);
  });
});

/* ══════════════════════════════════════════════ the strictness, and its edge */

describe("A visit leg is held to the standard the app was present for", () => {
  test("a metered visit leg with no reading is refused, however the handset was built", async () => {
    /* The camera screen refuses this for a person. This is the rule surviving
       a build that forgot it, or a payload somebody wrote by hand — a mileage
       claim is money, and a check that lives only in an interface is not a
       check. */
    const [out] = await ingestSyncBatch(principal, [
      item({
        entityType: "travel_leg",
        payload: {
          day: "2026-09-10",
          modeKey: "own_bike",
          customerId: shop.id,
          startedAt: Date.now(),
          origin: "visit",
        },
      }),
    ]);
    assert.equal(out.status, "rejected", JSON.stringify(out));
    assert.match(out.status === "rejected" ? out.message : "", /meter|reading/i);
  });

  test("a metered visit leg with a reading but no photograph is refused too", async () => {
    const [out] = await ingestSyncBatch(principal, [
      item({
        entityType: "travel_leg",
        payload: {
          day: "2026-09-10",
          modeKey: "own_bike",
          customerId: shop.id,
          startedAt: Date.now(),
          odometerStartKm: 41208,
          origin: "visit",
        },
      }),
    ]);
    assert.equal(out.status, "rejected", "a figure with no picture behind it cannot be checked");
  });

  test("A DAY-LOG LEG IS UNTOUCHED BY ALL OF IT", async () => {
    /*
     * The edge that matters most. `/travel` is typed up once the journey is
     * over, from memory, and the photograph has always been optional there —
     * refusing it for want of a picture nobody can now take would mean
     * refusing to record a journey that happened, which is the rule the whole
     * expense module is built on. `origin` is what lets the server hold a
     * visit leg to a higher standard without holding this one to it, and
     * without it the strictness would have silently broken the screen that
     * shipped first.
     */
    const [out] = await ingestSyncBatch(principal, [
      item({
        entityType: "travel_leg",
        payload: {
          day: "2026-09-10",
          modeKey: "own_bike",
          startedAt: Date.now(),
          endedAt: Date.now(),
          odometerStartKm: 41208,
          odometerEndKm: 41231,
          /* No photograph, no origin — exactly what `/travel` sends. */
        },
      }),
    ]);
    assert.equal(out.status, "accepted", JSON.stringify(out));
  });

  test("an unmetered visit leg needs nothing, and walking is accepted as it arrives", async () => {
    const [out] = await ingestSyncBatch(principal, [
      item({
        entityType: "travel_leg",
        payload: {
          day: "2026-09-10",
          modeKey: "walking",
          customerId: shop.id,
          startedAt: Date.now(),
          origin: "visit",
        },
      }),
    ]);
    assert.equal(out.status, "accepted", JSON.stringify(out));
  });

  test("a leg still on the road is not refused for missing an arrival reading", async () => {
    /* Its ordinary state, not a fault. The arrival check only applies once
       `endedAt` says the journey is over. */
    const legId = id("leg");
    const [out] = await depart(legId);
    assert.equal(out.status, "accepted", JSON.stringify(out));
  });

  test("closing a metered visit leg without the second photograph is refused", async () => {
    const legId = id("leg");
    await depart(legId);
    const [leg] = await db.select().from(mbosTravelLegs).where(eq(mbosTravelLegs.id, legId));

    const [out] = await ingestSyncBatch(principal, [
      item({
        entityType: "travel_leg",
        entityId: legId,
        op: "update",
        payload: {
          day: "2026-09-10",
          modeKey: "own_bike",
          customerId: shop.id,
          startedAt: Date.now() - 60_000,
          endedAt: Date.now(),
          odometerStartKm: 41208,
          odometerPhotoId: leg.odometerPhotoId,
          odometerEndKm: 41231,
          origin: "visit",
        },
      }),
    ]);
    assert.equal(out.status, "rejected", JSON.stringify(out));

    const [after] = await db.select().from(mbosTravelLegs).where(eq(mbosTravelLegs.id, legId));
    assert.equal(after.endedAt, null, "a refused arrival must not half-close the leg");
  });

  test("an arrival lower than the departure is refused, because meters do not run backwards", async () => {
    const legId = id("leg");
    await depart(legId);
    const [leg] = await db.select().from(mbosTravelLegs).where(eq(mbosTravelLegs.id, legId));

    const [out] = await ingestSyncBatch(principal, [
      item({
        entityType: "travel_leg",
        entityId: legId,
        op: "update",
        payload: {
          day: "2026-09-10",
          modeKey: "own_bike",
          customerId: shop.id,
          startedAt: Date.now() - 60_000,
          endedAt: Date.now(),
          odometerStartKm: 41208,
          odometerPhotoId: leg.odometerPhotoId,
          /* A digit dropped from the front, which is what this always is. */
          odometerEndKm: 4120,
          odometerEndPhotoId: await photo(legId, "end.jpg"),
          origin: "visit",
        },
      }),
    ]);
    assert.equal(out.status, "rejected", JSON.stringify(out));
    assert.match(out.status === "rejected" ? out.message : "", /backwards|digit/i);
  });

  test("a journey called off is closed at its own reading, so it measures nothing", async () => {
    /* Abandoned rather than deleted: the meter has already moved, and a leg
       that vanished would leave the next departure's reading following on from
       a gap — which is the pattern an audit stops at. */
    const legId = id("leg");
    await depart(legId);
    const [leg] = await db.select().from(mbosTravelLegs).where(eq(mbosTravelLegs.id, legId));

    const [out] = await ingestSyncBatch(principal, [
      item({
        entityType: "travel_leg",
        entityId: legId,
        op: "update",
        payload: {
          day: "2026-09-10",
          modeKey: "own_bike",
          customerId: shop.id,
          startedAt: Date.now() - 60_000,
          endedAt: Date.now(),
          odometerStartKm: 41208,
          odometerPhotoId: leg.odometerPhotoId,
          odometerEndKm: 41208,
          odometerEndPhotoId: leg.odometerPhotoId,
          note: "Shutter was down.",
          origin: "visit",
        },
      }),
    ]);
    assert.equal(out.status, "accepted", JSON.stringify(out));

    const [done] = await db.select().from(mbosTravelLegs).where(eq(mbosTravelLegs.id, legId));
    assert.equal(done.odometerEndKm, done.odometerStartKm, "it measures nothing");
    assert.match(done.note ?? "", /Shutter/);
  });
});

/* ═══════════════════════════════════════════ the evidence, and who sees it */

describe("An odometer photograph is evidence about the salesman", () => {
  test("it is parented to the leg, so the nightly orphan sweep cannot take it", async () => {
    const legId = id("leg");
    const shot = await photo(legId, "start.jpg");
    const [row] = await db.select().from(attachments).where(eq(attachments.id, shot));
    assert.equal(row.parentType, "mbos_travel_leg");
    assert.equal(row.parentId, legId);
  });

  test("EVERY ODOMETER PHOTOGRAPH USED TO BE A 404, and is not now", async () => {
    /*
     * `mbos_travel_leg` had a place in the attachment enum, the media route
     * filed files under it correctly, and `canRead` named it nowhere — so
     * `customerBehind` fell through to `calls`, looked a `mbos_travel_legs` id
     * up among the calls, found nothing, and refused the read. To the salesman
     * who took the photograph and to the manager approving the claim it
     * belongs to. It failed SHUT, which is the safe direction and exactly why
     * it survived: a broken image on a claim review reads as a photograph
     * nobody took.
     */
    const legId = id("leg");
    await depart(legId);
    const [leg] = await db.select().from(mbosTravelLegs).where(eq(mbosTravelLegs.id, legId));

    setTestUser(salesman);
    assert.equal(await canRead(leg.odometerPhotoId!), true, "his own mileage evidence");
  });

  test("a colleague cannot open it, and the manager it exists for can", async () => {
    const legId = id("leg");
    await depart(legId);
    const [leg] = await db.select().from(mbosTravelLegs).where(eq(mbosTravelLegs.id, legId));

    /*
     * This is why the leg is not read through the customer's scope. An
     * odometer photograph is evidence about a person's expense claim, not
     * about the shop — two salesmen sharing a customer must not thereby share
     * each other's reimbursement evidence, and these ids travel in payloads.
     *
     * The `sales` grant is what separates the two people below: `managerScope`
     * on its own answers "national, sees everybody" for anybody with no
     * territory row, which is every plain salesman.
     */
    setTestUser(colleague);
    assert.equal(await canRead(leg.odometerPhotoId!), false, "not a colleague's to open");

    setTestUser(manager);
    assert.equal(await canRead(leg.odometerPhotoId!), true, "his manager's to check");
  });
});
