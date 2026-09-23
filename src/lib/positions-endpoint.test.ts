/**
 * The trail endpoint, driven through the ROUTE rather than around it.
 *
 * Nothing in this repo had ever executed `POST /api/mbos/positions`. The
 * nearest thing — `activity-location.test.ts` — inserts into `mbos_positions`
 * directly, which exercises the table and not one line of the handler that
 * decides what goes into it. That is how the bug below survived: the code
 * type-checks, lints clean, and answers 200 on every request.
 *
 * WHAT IS PINNED HERE IS THE ANSWER, not the row count. The handset deletes
 * what it sent on any `ok` that is neither `off` nor `no-session-yet`
 * (`mbos-app/src/sync/trail.ts`), so the `tracking` field is the only thing
 * standing between a batch the server declined to file and a batch nobody has
 * any more. A test asserting "nothing was stored" would have passed throughout:
 * nothing WAS stored, and the fixes were destroyed as well.
 *
 * The three cases are the three shapes production actually produces:
 *
 *   AN OPEN DAY. The ordinary case, and the one that must keep working — a
 *   route that answered `no-session-yet` to everything would be perfectly safe
 *   and would never store a fix again.
 *
 *   A DAY CLOSED EARLY, AND NOTHING ELSE IN THE BATCH. `markMissedCheckouts`
 *   closes a forgotten day at the last fix it can SEE, so a handset that lost
 *   signal at two and worked until six has its day closed at two, and every
 *   later fix falls outside the window. This one was ALREADY safe, and by
 *   accident rather than by intent: the sessions query asks for days that
 *   overlap the batch's own span, so a day closed before the oldest fix is not
 *   returned at all and the empty-sessions branch caught it. It is pinned
 *   because that is a narrow accident to be resting on.
 *
 *   A BATCH THAT STRADDLES ONE. Where the destruction actually lived, in both
 *   its shapes — a batch spanning the stale check-out, and the ordinary
 *   overnight catch-up that carries yesterday's lost tail together with this
 *   morning's fixes. In both, the query finds a session, some fixes fall inside
 *   it and the rest fall outside — so the batch was answered as delivered and
 *   the outside part was deleted from the only device that had it. The count in
 *   the answer was the only trace.
 *
 * WHAT A STRADDLE MUST ANSWER IS `partial`, AND IT MUST NAME WHAT LANDED.
 * Answering `no-session-yet` there would be safe and would stop the trail:
 * `flush()` re-reads the oldest batch on that word without advancing, so one
 * unfileable fix among five hundred pins the queue for a week. The word has to
 * be one an old build reads as "delivered" — which is any word it does not
 * know — so a phone that cannot be recalled behaves exactly as it does today,
 * and a new one deletes precisely `filed`.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  mbosAttendanceDays,
  mbosDevices,
  mbosPositions,
  users,
} from "@/db/schema";
import { invalidateConfig, seedConfig, updateSettings } from "@/lib/config/store";
import { issueToken } from "@/lib/mbos/token";
import { markMissedCheckouts } from "@/lib/mbos-jobs";
import { POST } from "@/app/api/mbos/positions/route";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const DEVICE = "probe-device";

/** Nagpur, Sadar. A real place, so a swapped lat/lng is visible. */
const HERE = { lat: 21.1601, lng: 79.0805 };

let salesman: typeof users.$inferSelect;
let token: string;

/**
 * Yesterday, in the working zone.
 *
 * `markMissedCheckouts` only touches days strictly before today — a day still
 * being worked is not one somebody forgot to close — so every day here has to
 * be yesterday's for the close to be reachable at all.
 */
const YESTERDAY = new Date(Date.now() - 86_400_000).toLocaleDateString("en-CA", {
  timeZone: "Asia/Kolkata",
});

/**
 * An instant on that day, given an hour in IST.
 *
 * The offset is written into the string rather than subtracted afterwards: a
 * date spelled with no zone is read as UTC, which is the same trap this
 * codebase already carries three paragraphs about, arriving in a test.
 */
function at(hourIst: number, minute = 0): Date {
  return new Date(
    Date.parse(`${YESTERDAY}T00:00:00+05:30`) + hourIst * 3_600_000 + minute * 60_000,
  );
}

/**
 * The id the handset would mint for a fix here.
 *
 * Mirrors `fixId` in `mbos-app/src/sync/trail.ts`, which the route mirrors
 * too — a position IS its reading, and what `filed` names has to be the string
 * the phone is holding, not one the server invented.
 */
function fixIdOf(when: Date, lat = HERE.lat, lng = HERE.lng): string {
  return `mbos_pos_${when.getTime()}_${Math.round(lat * 1e6)}_${Math.round(lng * 1e6)}`;
}

function post(fixes: { at: Date; lat?: number; lng?: number }[]) {
  return POST(
    new Request("http://localhost/api/mbos/positions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        positions: fixes.map((f) => ({
          /* Derived from the reading exactly as the handset derives it — an id
             minted any other way is a duplicate generator, which is the whole
             reason `mbos_positions_fix_key` exists. */
          id: fixIdOf(f.at, f.lat ?? HERE.lat, f.lng ?? HERE.lng),
          at: f.at.getTime(),
          lat: f.lat ?? HERE.lat,
          lng: f.lng ?? HERE.lng,
          accuracyM: 12,
        })),
      }),
    }),
  );
}

async function storedCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mbosPositions)
    .where(eq(mbosPositions.userId, salesman.id));
  return row.n;
}

/** A day checked in at 9am IST and never checked out. */
async function openDay() {
  const [row] = await db
    .insert(mbosAttendanceDays)
    .values({
      id: id("att"),
      userId: salesman.id,
      day: YESTERDAY,
      checkInAt: at(9),
    })
    .returning();
  return row;
}

/**
 * Today's day, still open, and a fix taken during it.
 *
 * Anchored to the clock rather than to an hour of the morning: a suite that
 * asserts against 9am IST fails for two hours a day on a machine that runs it
 * early, which is the worst kind of flake to debug.
 */
async function openToday(): Promise<Date> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  await db.insert(mbosAttendanceDays).values({
    id: id("att"),
    userId: salesman.id,
    day: today,
    checkInAt: new Date(Date.now() - 2 * 3_600_000),
  });
  return new Date(Date.now() - 3_600_000);
}

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
  /* The route authenticates for real — `setTestUser` is the CRM's seam and
     reaches none of this. A signing key is the whole of what a handset needs. */
  process.env.MBOS_JWT_SECRET ??= "test-signing-key-for-the-handset";
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      mbos_devices, mbos_positions, mbos_attendance_days,
      app_access, sessions, users, app_settings
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
  await db
    .insert(mbosDevices)
    .values({ id: id("dev"), userId: salesman.id, deviceId: DEVICE, active: true });

  token = issueToken({
    userId: salesman.id,
    deviceId: DEVICE,
    type: "access",
    ttlSeconds: 3600,
  }).token;
});

after(async () => {
  await db.$client.end();
});

describe("A batch the server cannot file is never acknowledged as stored", () => {
  test("an open day takes its fixes, and says nothing about tracking", async () => {
    await openDay();

    const answer = await post([{ at: at(10) }, { at: at(11) }, { at: at(12) }]);
    const body = (await answer.json()) as Record<string, unknown>;

    assert.equal(body.ok, true);
    assert.equal(body.stored, 3, JSON.stringify(body));
    assert.equal(
      body.tracking,
      undefined,
      "an ordinary batch was told to hold on to itself — the handset would re-send it for ever",
    );
    assert.equal(await storedCount(), 3);
  });

  test("yesterday's lost tail survives arriving beside this morning's fixes", async () => {
    /*
     * THE SELF-REINFORCING CASE, in the shape a handset actually produces it.
     *
     * He lost signal after 2pm and worked until half past five; the nightly
     * closed yesterday at the last fix it could see. He comes back into signal
     * this morning, already checked in, and the queue goes up oldest first —
     * so one batch carries yesterday's four refused hours AND today's fixes.
     *
     * That is what makes the session query find something: today's day is open
     * and overlaps the batch's span. Yesterday's is closed before the span
     * begins and is not returned. So four hours of yesterday fell inside no
     * window, the answer carried no `tracking`, and the handset deleted the
     * lot — including the very fixes whose absence closed the day early.
     */
    await openDay();
    await db.insert(mbosPositions).values({
      id: id("pos"),
      userId: salesman.id,
      deviceId: DEVICE,
      lat: HERE.lat,
      lng: HERE.lng,
      accuracyM: 12,
      at: at(14),
    });

    const closed = await markMissedCheckouts();
    assert.equal(closed.recordsAffected, 1, "the day was not closed, so this proves nothing");

    const todayFix = await openToday();

    const answer = await post([
      { at: at(15) },
      { at: at(16) },
      { at: at(17, 30) },
      { at: todayFix },
    ]);
    const body = (await answer.json()) as Record<string, unknown>;

    assert.equal(body.ok, true);
    assert.equal(
      body.tracking,
      "partial",
      "the server acknowledged a batch it could file only part of — the handset deletes on that answer and yesterday's four hours are gone for good",
    );
    assert.equal(body.stored, 1, "only this morning's fix belongs to a session that exists");
    assert.deepEqual(
      body.filed,
      [fixIdOf(todayFix)],
      "the one fix that landed was not named, so a handset honouring `filed` would send it again for ever",
    );
    assert.equal(
      await storedCount(),
      2,
      "the 2pm fix already there, plus this morning's — yesterday's tail must not be stored either, the privacy rule is unchanged",
    );
  });

  test("a day closed before the whole batch was already refused, and stays refused", async () => {
    // Pinned because it works by ACCIDENT: the sessions query asks only for
    // days overlapping the batch's span, so a day closed before the oldest fix
    // never comes back and the empty-sessions branch answers. Narrow the span
    // filter and this is the case that starts destroying.
    await openDay();
    await db.insert(mbosPositions).values({
      id: id("pos"),
      userId: salesman.id,
      deviceId: DEVICE,
      lat: HERE.lat,
      lng: HERE.lng,
      accuracyM: 12,
      at: at(14),
    });
    await markMissedCheckouts();

    const answer = await post([{ at: at(15) }, { at: at(16) }, { at: at(17, 30) }]);
    const body = (await answer.json()) as Record<string, unknown>;

    assert.equal(body.tracking, "no-session-yet");
    assert.equal(body.stored, 0, "the privacy rule leaked: fixes outside a session were stored");
    assert.equal(await storedCount(), 1, "only the 2pm fix that was already there");
  });

  test("a batch straddling a stale check-out keeps the tail it could not file", async () => {
    await openDay();
    await db.insert(mbosPositions).values({
      id: id("pos"),
      userId: salesman.id,
      deviceId: DEVICE,
      lat: HERE.lat,
      lng: HERE.lng,
      accuracyM: 12,
      at: at(14),
    });
    await markMissedCheckouts();

    // Two inside the closed window, two past it. The two inside are real work
    // and there is no reason to make the phone send them twice; the two past
    // it are what used to be destroyed without a word.
    const answer = await post([
      { at: at(12) },
      { at: at(13) },
      { at: at(15) },
      { at: at(16) },
    ]);
    const body = (await answer.json()) as Record<string, unknown>;

    assert.equal(body.ok, true);
    assert.equal(body.stored, 2, JSON.stringify(body));
    assert.equal(
      body.tracking,
      "partial",
      "a mixed batch was acknowledged whole, so the two fixes past the stale check-out were deleted from the only device that had them",
    );
    assert.deepEqual(
      body.filed,
      [fixIdOf(at(12)), fixIdOf(at(13))],
      "`filed` must be exactly what landed — anything else is either a fix deleted that never arrived, or a queue that never advances",
    );
    assert.equal(await storedCount(), 3, "the 2pm fix plus the two inside the window");
  });

  test("a batch the queue can never drain is finished with, not held for a week", async () => {
    /*
     * THE HEAD-OF-LINE CASE, which is why `partial` exists rather than a
     * second use of `no-session-yet`. A fix with no coordinates is not a fix
     * and will never be storable, so a handset told to keep it would re-read
     * the same oldest five hundred rows on every pass until retention — seven
     * days — aged it off, and the trail would stop dead in the meantime.
     * It is named in `filed` along with what landed, because "finished with"
     * is the question the handset is asking.
     */
    await openDay();

    const answer = await POST(
      new Request("http://localhost/api/mbos/positions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          positions: [
            /* Not a number at all. `null` would NOT do: `Number(null)` is 0,
               which is a perfectly valid coordinate in the Gulf of Guinea. */
            { id: "junk-1", at: at(10).getTime(), lat: "somewhere", lng: "over there" },
            { id: fixIdOf(at(11)), at: at(11).getTime(), ...HERE, accuracyM: 12 },
            { id: "junk-2", at: at(12).getTime(), lat: 999, lng: 999 },
            /* BEFORE the check-in, so outside the day — an open day runs to
               the end of its own day, so nothing later that day can be
               outside. This is the real straddle and the only row that may
               still be held. */
            { id: fixIdOf(at(6)), at: at(6).getTime(), ...HERE, accuracyM: 12 },
          ],
        }),
      }),
    );
    const body = (await answer.json()) as Record<string, unknown>;

    assert.equal(body.tracking, "partial", JSON.stringify(body));
    assert.equal(body.stored, 1);
    assert.deepEqual(
      (body.filed as string[]).slice().sort(),
      [fixIdOf(at(11)), "junk-1", "junk-2"].sort(),
      "a row that can never be stored was not named, so it would pin the queue for a week",
    );
  });

  test("no attendance row at all is still the answer it always was", async () => {
    // The case that already worked. It is here because the fix above widens
    // where `no-session-yet` is answered, and a widening is the easy way to
    // break the narrow case it grew out of.
    const answer = await post([{ at: at(10) }]);
    const body = (await answer.json()) as Record<string, unknown>;

    assert.equal(body.tracking, "no-session-yet");
    assert.equal(await storedCount(), 0);
  });

  test("a day nobody ever closed does not file fixes from the days after it", async () => {
    /*
     * PRODUCTION'S SHAPE. Two test check-ins from August had no evidence
     * behind them, so `markMissedCheckouts` marked them `auto_checked_out` and
     * left the check-out null — correctly, since nobody knows when they ended —
     * and never looked at them again. An open day ran to infinity, so a month
     * later they filed a salesman's whole night and a day he never checked in
     * for. Nothing today is open here: the fixes have no session to belong to.
     */
    const longAgo = new Date(Date.now() - 30 * 86_400_000).toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
    });
    await db.insert(mbosAttendanceDays).values({
      id: id("att"),
      userId: salesman.id,
      day: longAgo,
      checkInAt: new Date(Date.parse(`${longAgo}T08:00:00+05:30`)),
      autoCheckedOut: true,
    });

    const answer = await post([{ at: at(10) }, { at: at(23, 30) }]);
    const body = (await answer.json()) as Record<string, unknown>;

    assert.equal(
      body.tracking,
      "no-session-yet",
      "an abandoned day from last month was treated as still running",
    );
    assert.equal(await storedCount(), 0, "the privacy rule leaked through a day nobody closed");
  });

  test("a day left open is still open until its own midnight, and no further", async () => {
    // Yesterday, checked in at nine and not yet closed by the nightly: the
    // evening is his, the small hours of today are not.
    await openDay();
    const pastMidnight = at(24, 30);

    const answer = await post([{ at: at(22) }, { at: pastMidnight }]);
    const body = (await answer.json()) as Record<string, unknown>;

    assert.equal(body.stored, 1, JSON.stringify(body));
    assert.equal(body.tracking, "partial");
    assert.deepEqual(
      body.filed,
      [fixIdOf(at(22))],
      "the after-midnight fix was filed against yesterday, or the 10pm one was not",
    );
  });

  test("tracking switched off in the office still says so before anything else", async () => {
    await updateSettings(
      [{ key: "mbos.location.trackWhileWorking", value: false }],
      salesman.id,
    );
    invalidateConfig();
    await openDay();

    const answer = await post([{ at: at(10) }]);
    const body = (await answer.json()) as Record<string, unknown>;

    assert.equal(body.tracking, "off", "a disabled feature answered as an ordinary batch");
    assert.equal(await storedCount(), 0);
  });

  test("the same batch twice is the same rows — the id is the reading", async () => {
    await openDay();
    const batch = [{ at: at(10) }, { at: at(10, 30) }];

    await post(batch);
    await post(batch);

    assert.equal(
      await storedCount(),
      2,
      "a redelivered batch wrote a second copy — Android hands the same batch back whenever the task did not complete",
    );
  });
});
