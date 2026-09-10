/**
 * The check-in radius, end to end through the real sync handler.
 *
 * IT RUNS THE HANDLER RATHER THAN READING IT, for the reason
 * `travel-on-visit.test.ts` states beside it: the bugs this codebase has had
 * in `handleVisit` were all correct-looking SQL that threw at the database and
 * came back as a RETRY, so the outbox resent for ever and nothing on either
 * end named the cause. Two raw statements were added here — the pin capture
 * and the customer update beside it — and neither is visible to a type check.
 *
 * What it pins is the half of the gate the handset cannot own. The refusal
 * itself lives on the phone (`checkInVerdict`, tested pure in the handset's
 * own suite) because that is the only moment refusing is any use. What the
 * server is answerable for is that the ROW TELLS THE TRUTH afterwards, that an
 * un-updated handset is not punished for a rule it has never heard of, and
 * that a shop nobody had pinned gets pinned by being visited.
 *
 *   npm run test:integration
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, mbosDevices, mbosVisits, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { decidePinCorrection } from "@/lib/actions/sales";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** Nagpur, Sadar. A real place, so a swapped lat/lng is visible as nonsense. */
const SHOP = { lat: 21.1601, lng: 79.0805 };

/**
 * Metres north of the shop, as a coordinate.
 *
 * Due north only, so the arithmetic is one term and a failure reads as a
 * distance rather than as trigonometry. 111,320 m per degree of latitude.
 */
const northOf = (metres: number) => ({
  lat: SHOP.lat + metres / 111_320,
  lng: SHOP.lng,
});

let salesman: typeof users.$inferSelect;
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
  /* The app grant, because a level on its own is not one — a role is held
     under an app, not by the account. Same shape as `travel-on-visit`. */
  await db.insert(appAccess).values({
    id: id("aca"),
    userId: row!.id,
    app: "crm",
    role,
  });
  return row!;
}

/** A shop, pinned or not, in this salesman's own book. */
async function makeShop(name: string, pin: { lat: number; lng: number } | null) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name,
      phone: String(9822000000 + Math.floor(Math.random() * 999999)),
      city: "Nagpur",
      kind: "customer",
      ownerId: salesman.id,
      salesAmId: salesman.id,
      gpsLat: pin?.lat ?? null,
      gpsLng: pin?.lng ?? null,
    })
    .returning();
  return row!;
}

/** One visit, through the real endpoint, exactly as the handset sends it. */
async function checkIn(
  over: {
    customerId?: string;
    at?: { lat: number; lng: number } | null;
    accuracyM?: number | null;
    overrideReason?: string;
    pinCorrectionRequested?: boolean;
  } = {},
) {
  const entityId = id("visit");
  const at = over.at === undefined ? SHOP : over.at;
  const payload: Record<string, unknown> = {
    customerId: over.customerId ?? shop.id,
    checkInAt: Date.now() - 10 * 60_000,
    checkOutAt: Date.now(),
    checkInLat: at?.lat,
    checkInLng: at?.lng,
    checkInAccuracyM: over.accuracyM === undefined ? 12 : over.accuracyM,
    outcome: "visited",
    notes: "Stock checked.",
  };
  if (over.overrideReason) payload.checkInOverrideReason = over.overrideReason;
  if (over.pinCorrectionRequested) payload.pinCorrectionRequested = true;

  const item: SyncItem = {
    queueId: id("q"),
    entityId,
    entityType: "visit",
    op: "create",
    idempotencyKey: `${entityId}:create:${randomUUID()}`,
    clientCreatedAt: Date.now(),
    payload,
  };
  const [result] = await ingestSyncBatch(principal, [item]);
  assert.equal(
    result?.status,
    "accepted",
    `the visit should be accepted, never refused: ${JSON.stringify(result)}`,
  );
  const [row] = await db.select().from(mbosVisits).where(eq(mbosVisits.id, entityId)).limit(1);
  assert.ok(row, "the visit should be in the table");
  return row!;
}

const pinOf = async (customerId: string) => {
  const [row] = await db
    .select({
      lat: customers.gpsLat,
      lng: customers.gpsLng,
      accuracyM: customers.gpsAccuracyM,
      capturedAt: customers.gpsCapturedAt,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return row!;
};

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
      mbos_visits, mbos_devices, timeline_events,
      audit_log, notifications, app_access, sessions, customers, users,
      app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  salesman = await makeUser("Mahesh", "associate");
  manager = await makeUser("Vikram", "manager");

  await db.insert(appAccess).values([
    { id: id("aa"), userId: salesman.id, app: "field" },
    /* The Sales Dashboard grant is what `requireSales` reads, and it is what
       decides who may answer a pin correction at all. */
    { id: id("aa"), userId: manager.id, app: "sales" },
  ]);

  shop = await makeShop("Sai Paint Depot", SHOP);

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

describe("what the server makes of a check-in", () => {
  test("standing at the shop verifies, and the distance is kept either way", async () => {
    const visit = await checkIn({ at: northOf(30) });
    assert.equal(visit.verified, true);
    assert.equal(visit.locationMismatch, false);
    assert.equal(visit.unverifiedReason, null);
    assert.ok(
      (visit.distanceFromShopM ?? 0) >= 25 && (visit.distanceFromShopM ?? 0) <= 35,
      `about 30 m, got ${visit.distanceFromShopM}`,
    );
  });

  test("an un-updated handset is recorded, never refused", async () => {
    /*
     * THE POINT OF THIS ONE. An APK cannot be recalled, so phones in the field
     * go on sending check-ins the old build never refused — and every one of
     * those visits is real work with a note, a photograph and possibly an
     * order behind it. Rejecting would put the lot in `/rejections` for ever.
     */
    const visit = await checkIn({ at: northOf(340) });
    assert.equal(visit.verified, false);
    assert.equal(visit.locationMismatch, true);
    assert.equal(visit.checkInOverrideReason, null);
    assert.match(String(visit.unverifiedReason), /no reason was given/);
    assert.ok((visit.distanceFromShopM ?? 0) > 300);
  });

  test("past the radius with his own words is unverified, and the words are kept", async () => {
    const visit = await checkIn({
      at: northOf(340),
      overrideReason: "Shop moved to the next lane last month",
    });
    assert.equal(visit.verified, false);
    assert.equal(visit.locationMismatch, true);
    assert.equal(
      visit.checkInOverrideReason,
      "Shop moved to the next lane last month",
      "his sentence has a column of its own — a screen must not have to read it out of prose",
    );
    assert.match(String(visit.unverifiedReason), /next lane/);
  });

  test("a fix too wide to trust is not a mismatch, whatever it measures", async () => {
    /* A reading that cannot show he is there cannot show he is not. The
       distance stays null rather than being computed and then ignored. */
    const visit = await checkIn({ at: northOf(340), accuracyM: 900 });
    assert.equal(visit.verified, false);
    assert.equal(visit.locationMismatch, false);
    assert.equal(visit.distanceFromShopM, null);
    assert.match(String(visit.unverifiedReason), /900 m/);
  });

  test("no location at all is a recorded fact, not a mismatch", async () => {
    const visit = await checkIn({ at: null });
    assert.equal(visit.verified, false);
    assert.equal(visit.locationMismatch, false);
    assert.equal(visit.distanceFromShopM, null);
  });
});

describe("a shop nobody had pinned", () => {
  test("is pinned by being visited, from the check-in itself", async () => {
    const blank = await makeShop("Unpinned Traders", null);
    const before = await pinOf(blank.id);
    assert.equal(before.lat, null, "the shop starts with no pin at all");

    const here = northOf(80);
    const visit = await checkIn({ customerId: blank.id, at: here, accuracyM: 9 });

    const pin = await pinOf(blank.id);
    assert.ok(pin.lat != null && pin.lng != null, "the visit should have pinned it");
    assert.ok(Math.abs((pin.lat as number) - here.lat) < 1e-9, "the pin IS the check-in fix");
    assert.ok(Math.abs((pin.lng as number) - here.lng) < 1e-9);
    assert.equal(pin.accuracyM, 9, "how good the fix was travels with it");
    assert.ok(pin.capturedAt, "and when it was taken");

    /* Still not VERIFIED: nothing was checked against anything. What changed
       is that the next visit here can be. */
    assert.equal(visit.verified, false);
    assert.equal(visit.distanceFromShopM, null);
    assert.match(String(visit.unverifiedReason), /pinned here/);
  });

  test("a poor fix never pins it", async () => {
    /*
     * The order of the ladder, from the far end. Judged the other way round,
     * the first check-in on a bad afternoon drops the pin four hundred metres
     * out and every honest visit afterwards is refused against it — the exact
     * failure the gate exists to avoid, arriving by the back door.
     */
    const blank = await makeShop("Vague Traders", null);
    await checkIn({ customerId: blank.id, at: northOf(400), accuracyM: 900 });
    assert.equal((await pinOf(blank.id)).lat, null);
  });

  test("a second visit cannot move a pin the first one set", async () => {
    const blank = await makeShop("Twice Visited", null);
    const first = northOf(80);
    await checkIn({ customerId: blank.id, at: first, accuracyM: 9 });
    await checkIn({ customerId: blank.id, at: northOf(95), accuracyM: 9 });

    const pin = await pinOf(blank.id);
    assert.ok(
      Math.abs((pin.lat as number) - first.lat) < 1e-9,
      "the `gps_lat is null` guard is in the statement, not only in the branch above it",
    );
  });
});

describe("the pin a salesman says is wrong", () => {
  test("is a request on the visit, and a manager decides it", async () => {
    const here = northOf(340);
    const visit = await checkIn({
      at: here,
      overrideReason: "The map has us in the wrong lane",
      pinCorrectionRequested: true,
    });
    assert.equal(visit.pinCorrection, "requested");
    assert.equal(visit.pinCorrectionDecidedAt, null);

    /* NOTHING HAS MOVED YET. This is the whole reason it is a request: the
       handset can already write a pin through `customer_update`, so an
       override that moved it on its own would mean one override put the pin
       wherever somebody stood and the radius never refused him again. */
    const before = await pinOf(shop.id);
    assert.ok(Math.abs((before.lat as number) - SHOP.lat) < 1e-9);

    setTestUser(manager);
    const out = await decidePinCorrection({ visitId: visit.id, accept: true });
    assert.ok(out.ok, JSON.stringify(out));

    const pin = await pinOf(shop.id);
    assert.ok(
      Math.abs((pin.lat as number) - here.lat) < 1e-9,
      "what is accepted is the check-in fix already on the row, never a coordinate sent with the click",
    );

    const [after] = await db.select().from(mbosVisits).where(eq(mbosVisits.id, visit.id)).limit(1);
    assert.equal(after!.pinCorrection, "accepted");
    assert.equal(after!.pinCorrectionDecidedById, manager.id);
    assert.equal(
      after!.verified,
      false,
      "accepting the pin says the book was wrong — standing behind the visit is a different decision",
    );
  });

  test("refusing it leaves the shop exactly where it was", async () => {
    const visit = await checkIn({
      at: northOf(340),
      overrideReason: "I am outside the shutter",
      pinCorrectionRequested: true,
    });

    setTestUser(manager);
    assert.ok((await decidePinCorrection({ visitId: visit.id, accept: false })).ok);

    const pin = await pinOf(shop.id);
    assert.ok(Math.abs((pin.lat as number) - SHOP.lat) < 1e-9);
    const [after] = await db.select().from(mbosVisits).where(eq(mbosVisits.id, visit.id)).limit(1);
    assert.equal(after!.pinCorrection, "rejected");
  });

  test("cannot be answered twice", async () => {
    const visit = await checkIn({
      at: northOf(340),
      overrideReason: "Wrong lane",
      pinCorrectionRequested: true,
    });
    setTestUser(manager);
    assert.ok((await decidePinCorrection({ visitId: visit.id, accept: false })).ok);
    const second = await decidePinCorrection({ visitId: visit.id, accept: true });
    assert.equal(second.ok, false, "a decided request is not a standing one");
  });

  test("is dropped where the shop had no pin to be wrong about", async () => {
    /* Asked about a shop this very check-in has just pinned, the request would
       be a manager asked to approve moving a pin onto the spot it sits on. */
    const blank = await makeShop("Nothing To Correct", null);
    const visit = await checkIn({
      customerId: blank.id,
      at: northOf(80),
      accuracyM: 9,
      pinCorrectionRequested: true,
    });
    assert.equal(visit.pinCorrection, null);
  });
});
