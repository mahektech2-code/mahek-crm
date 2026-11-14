/**
 * A DAY'S PHOTOGRAPHS, AND THE VERDICT ON EACH — through the real service and
 * the real action.
 *
 * It runs them rather than reading them, for the reason
 * `travel-on-visit.test.ts` states at length: four bugs in this codebase have
 * had one shape, a query correct in every way a type checker can see which
 * throws at the database. Two of the queries here are new, one of them is a
 * `jsonb_array_elements … with ordinality` over a column the handset writes,
 * and neither had ever been executed before this file existed.
 *
 * What it pins is the half nobody would notice going wrong:
 *
 *  - a photograph SWEPT after its window and a mark that was never
 *    photographed are two different facts, and the record says which;
 *  - a correction rewrites the leg and re-measures it, AND the salesman's own
 *    figure survives a SECOND correction. That last one is not hypothetical —
 *    reading the original off the leg told him "read as 41,270 rather than the
 *    41,280 you entered" on a leg he had entered 41,226 on, which is the
 *    office quoting its own earlier answer back at him as his;
 *  - the distance under a DECIDED claim does not move.
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
  mbosApprovals,
  mbosAttendanceDays,
  mbosEvidenceReviews,
  mbosExpenseDays,
  mbosTravelLegs,
  mbosUserTerritories,
  notifications,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { reviewDayEvidence } from "@/lib/actions/sales";
import { dayEvidence, unreviewedCounts } from "@/lib/services/day-evidence-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const DAY = "2026-09-16";
/** Asia/Kolkata wall clocks, written as the instants they are. */
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+05:30`);

let salesman: typeof users.$inferSelect;
let manager: typeof users.$inferSelect;
let outsider: typeof users.$inferSelect;
let attendanceId: string;
let legId: string;

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
  return row!;
}

/** An `attachments` row in whichever state the test needs it in. */
async function file(parentType: string, parentId: string, status: "available" | "removed") {
  const row = {
    id: id("att"),
    parentType: parentType as never,
    parentId,
    filename: "x.jpg",
    storedRef: `ref/${randomUUID()}`,
    contentType: "image/jpeg",
    sizeBytes: 22,
    status,
    uploadedById: salesman.id,
  };
  await db.insert(attachments).values(row as never);
  return row.id;
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
      mbos_evidence_reviews, mbos_travel_legs, mbos_expense_days, mbos_expenses,
      mbos_approvals, mbos_attendance_days, mbos_user_territories,
      mbos_devices, mbos_visits, attachments,
      audit_log, notifications, app_access, sessions, customers, users,
      app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  salesman = await makeUser("Mahesh", "associate");
  manager = await makeUser("Vikram", "manager");
  outsider = await makeUser("Sunil", "manager");

  await db.insert(appAccess).values([
    { id: id("aa"), userId: salesman.id, app: "field" },
    { id: id("aa"), userId: manager.id, app: "sales" },
    { id: id("aa"), userId: outsider.id, app: "sales" },
  ]);

  await db.insert(customers).values({
    id: id("cus"),
    name: "Sai Paint Depot",
    phone: "9822200011",
    city: "Nagpur",
    kind: "customer",
    ownerId: salesman.id,
    salesAmId: salesman.id,
  });

  /* A DAY OF TWO SESSIONS — he broke for lunch. The morning check-in is still
     openable, the morning check-out has been swept, and the afternoon was
     never photographed at all: three states, on purpose. */
  attendanceId = id("mad");
  const inPhoto = await file("mbos_attendance", attendanceId, "available");
  const outPhoto = await file("mbos_attendance", attendanceId, "removed");
  await db.insert(mbosAttendanceDays).values({
    id: attendanceId,
    userId: salesman.id,
    day: DAY,
    checkInAt: at("09:04"),
    checkOutAt: at("18:22"),
    checkInSelfieId: inPhoto,
    checkOutSelfieId: outPhoto,
    status: "present",
    sessions: [
      {
        inAt: at("09:04").getTime(),
        outAt: at("13:00").getTime(),
        inSelfieId: inPhoto,
        outSelfieId: outPhoto,
      },
      { inAt: at("13:40").getTime(), outAt: at("18:22").getTime() },
    ],
  });

  /* One leg between them, both meters read and the departure photographed. */
  legId = id("leg");
  const [day] = await db
    .insert(mbosExpenseDays)
    .values({ id: id("exd"), userId: salesman.id, day: DAY, submittedAt: new Date() })
    .returning();
  await db.insert(mbosTravelLegs).values({
    id: legId,
    userId: salesman.id,
    expenseDayId: day!.id,
    modeKey: "own_bike",
    fromLabel: "Sadar",
    toLabel: "Itwari",
    startedAt: at("10:10"),
    endedAt: at("10:40"),
    odometerStartKm: 41208,
    odometerEndKm: 41226,
    odometerPhotoId: await file("mbos_travel_leg", legId, "available"),
    origin: "visit",
  });

  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ══════════════════════════════════════════════════════════════ the read */

describe("A salesman's day, read as one list", () => {
  test("every mark and every meter, in the order the day happened", async () => {
    const ev = await dayEvidence(salesman.id, DAY);
    assert.ok(ev, "the day should read back");

    assert.deepEqual(
      ev.items.map((i) => i.ref.replace(attendanceId, "AD").replace(legId, "LEG")),
      [
        "att:AD:0:in",
        "leg:LEG:start",
        "leg:LEG:end",
        "att:AD:0:out",
        "att:AD:1:in",
        "att:AD:1:out",
      ],
      /* THE LEG SITS INSIDE THE MORNING. Grouped by table this would be three
         selfies then two meters, which is two lists a reader has to interleave
         in their head while deciding whether they believe the day. */
    );

    assert.equal(ev.items[0]!.kind, "attendance_selfie");
    assert.equal(ev.items[1]!.km, 41208);
    assert.equal(ev.items[2]!.km, 41226);
  });

  test("a swept photograph and a mark nobody photographed are told apart", async () => {
    const ev = (await dayEvidence(salesman.id, DAY))!;
    const byRef = new Map(ev.items.map((i) => [i.ref, i]));

    const open = byRef.get(`att:${attendanceId}:0:in`)!;
    assert.equal(open.photographed, true);
    assert.equal(open.photoAvailable, true);

    /* SWEPT AFTER ITS WINDOW. The id stays on the day for ever, which is the
       whole point of keeping it — so this has to read as "taken, and the image
       has gone" rather than as nothing having been taken. */
    const swept = byRef.get(`att:${attendanceId}:0:out`)!;
    assert.equal(swept.photographed, true, "it was photographed");
    assert.equal(swept.photoAvailable, false, "and the image has been swept");

    /* NEVER PHOTOGRAPHED, which is somebody having got past a camera and is a
       different conversation entirely. */
    const none = byRef.get(`att:${attendanceId}:1:in`)!;
    assert.equal(none.photographed, false);
    assert.equal(none.photoAvailable, false);
  });

  test("an open session's check-out is not drawn as a missing photograph", async () => {
    await db
      .update(mbosAttendanceDays)
      .set({
        checkOutAt: null,
        sessions: [{ inAt: at("09:04").getTime(), outAt: null }],
      })
      .where(eq(mbosAttendanceDays.id, attendanceId));

    const ev = (await dayEvidence(salesman.id, DAY))!;
    assert.ok(
      !ev.items.some((i) => i.ref.endsWith(":0:out")),
      "a mark he has not reached yet is not a camera he skipped",
    );
  });

  test("a leg with no meter at either end is left off entirely", async () => {
    await db
      .update(mbosTravelLegs)
      .set({ odometerStartKm: null, odometerEndKm: null, odometerPhotoId: null })
      .where(eq(mbosTravelLegs.id, legId));

    const ev = (await dayEvidence(salesman.id, DAY))!;
    assert.ok(
      !ev.items.some((i) => i.kind === "odometer"),
      "a bus fare has nothing on it to answer, and a row with a meaningless button is worse than no row",
    );
  });

  test("somebody else's team reads as nothing at all", async () => {
    /* A region containing no shops of his, which is what makes the scope bite:
       `managerScope` answers national for a manager with no region rows. */
    await db.insert(mbosUserTerritories).values({
      id: id("ter"),
      userId: outsider.id,
      kind: "region",
      region: "Gujarat",
    });
    setTestUser(outsider);
    assert.equal(
      await dayEvidence(salesman.id, DAY),
      null,
      "and null rather than an error, so a URL cannot confirm that an id is a real account",
    );
  });
});

/* ═════════════════════════════════════════════════════════════ the verdict */

describe("Answering a photograph", () => {
  test("approving takes one call and asks for nothing", async () => {
    const r = await reviewDayEvidence({
      ref: `att:${attendanceId}:0:in`,
      verdict: "accepted",
    });
    assert.ok(r.ok, JSON.stringify(r));

    const ev = (await dayEvidence(salesman.id, DAY))!;
    const item = ev.items.find((i) => i.ref === `att:${attendanceId}:0:in`)!;
    assert.equal(item.review?.verdict, "accepted");
    assert.equal(item.review?.decidedByName, manager.name);

    /* NOBODY IS TOLD THEY WERE BELIEVED. A notification per approved
       photograph is six a day per salesman, and a bell that rings for good
       news is a bell people turn off. */
    const bells = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, salesman.id));
    assert.equal(bells.length, 0);
  });

  test("declining without words is refused", async () => {
    const r = await reviewDayEvidence({
      ref: `att:${attendanceId}:0:in`,
      verdict: "declined",
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, "validation");
  });

  test("a decline reaches him carrying the words", async () => {
    await reviewDayEvidence({
      ref: `att:${attendanceId}:0:in`,
      verdict: "declined",
      remark: "That is not you in the photograph.",
    });
    const [bell] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, salesman.id));
    assert.ok(bell, "he is told");
    assert.match(bell.body, /That is not you in the photograph\./);
    /* `warn` and not `warning`: the bell colours `warn` and `danger`, and the
       several callers spelling it the other way are drawn as ordinary. */
    assert.equal(bell.kind, "warn");
  });

  test("there is nothing on a selfie to correct", async () => {
    const r = await reviewDayEvidence({
      ref: `att:${attendanceId}:0:in`,
      verdict: "declined",
      remark: "x",
      correctedKm: 10,
    });
    assert.equal(r.ok, false);
  });

  test("a figure cannot ride on an approval", async () => {
    const r = await reviewDayEvidence({
      ref: `leg:${legId}:end`,
      verdict: "accepted",
      correctedKm: 41280,
    });
    assert.equal(r.ok, false, "accepting says the photograph shows what he typed");
  });

  test("a reference nobody minted resolves to nothing", async () => {
    for (const ref of ["leg:../../etc/passwd:end", "att:x:9:sideways", "", "leg:nosuch:end"]) {
      const r = await reviewDayEvidence({ ref, verdict: "accepted" });
      assert.equal(r.ok, false, `"${ref}" should not resolve`);
    }
  });

  test("a manager cannot answer for a day outside his patch", async () => {
    await db.insert(mbosUserTerritories).values({
      id: id("ter"),
      userId: outsider.id,
      kind: "region",
      region: "Gujarat",
    });
    setTestUser(outsider);
    const r = await reviewDayEvidence({
      ref: `att:${attendanceId}:0:in`,
      verdict: "accepted",
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, "not_permitted");
  });
});

/* ═════════════════════════════════════════════════════════ the correction */

describe("Correcting a meter somebody read wrong", () => {
  test("it rewrites the leg and re-measures the journey", async () => {
    const r = await reviewDayEvidence({
      ref: `leg:${legId}:end`,
      verdict: "declined",
      remark: "The dial reads 41,280 — the 8 and the 0 are transposed.",
      correctedKm: 41280,
    });
    assert.ok(r.ok, JSON.stringify(r));

    const [leg] = await db.select().from(mbosTravelLegs).where(eq(mbosTravelLegs.id, legId));
    assert.equal(leg.odometerEndKm, 41280);
    assert.equal(leg.odometerStartKm, 41208, "the other end is untouched");
    /* RE-MEASURED, not merely rewritten. `chosen_metres` is what the money is
       worked out from and it is derived from this pair. */
    assert.equal(leg.odometerMetres, 72_000);
  });

  test("HIS OWN FIGURE SURVIVES A SECOND CORRECTION", async () => {
    await reviewDayEvidence({
      ref: `leg:${legId}:end`,
      verdict: "declined",
      remark: "Reads 41,280.",
      correctedKm: 41280,
    });
    await reviewDayEvidence({
      ref: `leg:${legId}:end`,
      verdict: "declined",
      remark: "Looked again — 41,270.",
      correctedKm: 41270,
    });

    const [row] = await db
      .select()
      .from(mbosEvidenceReviews)
      .where(eq(mbosEvidenceReviews.sourceRef, `leg:${legId}:end`));
    assert.equal(row.correctedKm, 41270);
    /* The leg's own column was overwritten by the FIRST correction, so a
       second pass reading the original off it would store 41,280 here and tell
       him the office had read 41,270 "rather than the 41,280 you entered" — on
       a leg he entered 41,226 on. */
    assert.equal(row.reportedKm, 41226, "what he actually typed");

    const bells = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, salesman.id));
    assert.match(bells.at(-1)!.body, /41,226/, "and that is the figure he is told about");
  });

  test("a meter running backwards is refused", async () => {
    const r = await reviewDayEvidence({
      ref: `leg:${legId}:end`,
      verdict: "declined",
      remark: "x",
      correctedKm: 41000,
    });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : "", /does not run backwards/);
  });

  test("a journey past the ceiling is refused", async () => {
    const r = await reviewDayEvidence({
      ref: `leg:${legId}:end`,
      verdict: "declined",
      remark: "x",
      correctedKm: 99_999,
    });
    assert.equal(r.ok, false);
  });

  test("THE DISTANCE UNDER A DECIDED CLAIM DOES NOT MOVE", async () => {
    const [day] = await db
      .select()
      .from(mbosExpenseDays)
      .where(eq(mbosExpenseDays.userId, salesman.id));
    await db.insert(mbosApprovals).values({
      id: id("apr"),
      type: "expense_claim",
      requestedByUserId: salesman.id,
      subjectType: "mbos_expense_days",
      subjectId: day!.id,
      approverUserId: manager.id,
      state: "approved",
      stepIndex: 0,
      decidedAt: new Date(),
    } as never);

    const r = await reviewDayEvidence({
      ref: `leg:${legId}:end`,
      verdict: "declined",
      remark: "Reads 41,280.",
      correctedKm: 41280,
    });
    assert.equal(r.ok, false, "the figures would move beneath somebody's signature");
    assert.equal(r.ok === false && r.code, "conflict");
    assert.match(r.ok === false ? r.error : "", /Reopen/, "and the way past it is named");

    const [leg] = await db.select().from(mbosTravelLegs).where(eq(mbosTravelLegs.id, legId));
    assert.equal(leg.odometerEndKm, 41226, "untouched");
  });

  test("a verdict on a decided day is still recordable", async () => {
    const [day] = await db
      .select()
      .from(mbosExpenseDays)
      .where(eq(mbosExpenseDays.userId, salesman.id));
    await db.insert(mbosApprovals).values({
      id: id("apr"),
      type: "expense_claim",
      requestedByUserId: salesman.id,
      subjectType: "mbos_expense_days",
      subjectId: day!.id,
      approverUserId: manager.id,
      state: "approved",
      stepIndex: 0,
      decidedAt: new Date(),
    } as never);

    /* Noticing after the money was allowed is exactly the thing worth writing
       down; it is the CORRECTION that is held, not the verdict. */
    const r = await reviewDayEvidence({
      ref: `leg:${legId}:end`,
      verdict: "declined",
      remark: "This reading is wrong and the claim has already been paid.",
    });
    assert.ok(r.ok, JSON.stringify(r));
  });
});

/* ═════════════════════════════════════════════════════ what is outstanding */

describe("What the team list has to say about a day", () => {
  test("the count is what nobody has looked at, and it falls as they do", async () => {
    assert.equal((await unreviewedCounts(DAY)).get(salesman.id), 6);

    await reviewDayEvidence({ ref: `att:${attendanceId}:0:in`, verdict: "accepted" });
    await reviewDayEvidence({ ref: `leg:${legId}:start`, verdict: "accepted" });

    assert.equal((await unreviewedCounts(DAY)).get(salesman.id), 4);
  });

  test("a day nobody has evidence for is absent rather than zero", async () => {
    assert.equal((await unreviewedCounts("2026-09-15")).get(salesman.id), undefined);
  });
});
