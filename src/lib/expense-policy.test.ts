/**
 * The travel and expense module, end to end.
 *
 * The engines have their own unit tests and they run in milliseconds without a
 * database. What THIS proves is the wiring: that a policy typed on a screen is
 * the policy a day is priced against, that the eligible figure stored equals
 * the one derived, that a published version cannot be edited, and that the
 * requirement the whole module rests on — an old expense is worked out on the
 * policy in force on its own date — actually holds against real rows.
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
  expenseGrades,
  mbosApprovals,
  mbosExpenseDays,
  mbosExpenses,
  mbosTravelLegs,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import {
  createPolicyDraft,
  publishPolicy,
  saveRule,
  policyReadiness,
} from "@/lib/actions/expense-policy";
import { policyForDate, readPolicy } from "@/lib/services/expense-policy-service";
import { priceDay } from "@/lib/services/expense-service";
import { submitDay, reopenDay } from "@/lib/services/expense-submit-service";
import { claimDays } from "@/lib/services/expense-claims-service";
import { resolveException, decideExpenseDay } from "@/lib/actions/expenses";
import { duplicateWarnings } from "@/lib/services/expense-service";
import { simulatePolicy } from "@/lib/services/expense-simulator-service";
import { expenseTrend, snapshotExpenseMonth } from "@/lib/services/expense-roi-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const hhmm = (h: number, m = 0) => h * 60 + m;

let admin: typeof users.$inferSelect;
let salesman: typeof users.$inferSelect;

async function makeUser(name: string, role: "telecaller" | "manager" | "admin" | "accounts") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  return row!;
}

/** A day at a fixed instant, so the wall-clock conversion is deterministic. */
function at(day: string, minutes: number): Date {
  /* Built as an IST wall clock and converted — the same direction the handset
     sends and the server reads, so a bug in either shows up here. */
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+05:30`);
}

/** The client's own §E figures, as a publishable policy. */
async function publishPolicyV(effectiveFrom: string, paisePerKm: number) {
  setTestUser(admin);
  const draft = await createPolicyDraft({
    title: `Policy from ${effectiveFrom}`,
    effectiveFrom,
    notes: null,
  });
  assert.ok(draft.ok, draft.ok ? "" : draft.error);
  const policyId = draft.data.id;

  const rules: Array<Record<string, unknown>> = [
    { kind: "per_km", scopeKey: "travel_mode:own_bike", value: { paisePerKm, dailyKmCap: null } },
    { kind: "zero_rated", scopeKey: "travel_mode:walking", value: {} },
    { kind: "meal_rate", scopeKey: "breakfast", value: { amountPaise: 10000 } },
    { kind: "meal_rate", scopeKey: "lunch", value: { amountPaise: 15000 } },
    { kind: "meal_rate", scopeKey: "dinner", value: { amountPaise: 20000 } },
    {
      kind: "meal_entitlement",
      scopeKey: "breakfast",
      value: { windowFromMinutes: hhmm(6), windowToMinutes: hhmm(10), minAwayMinutes: null },
    },
    {
      kind: "meal_entitlement",
      scopeKey: "lunch",
      value: { windowFromMinutes: hhmm(12), windowToMinutes: hhmm(15), minAwayMinutes: null },
    },
    {
      kind: "meal_entitlement",
      scopeKey: "dinner",
      value: { windowFromMinutes: hhmm(19), windowToMinutes: hhmm(22), minAwayMinutes: null },
    },
    { kind: "meal_disqualifier", scopeKey: "breakfast", value: { departedAfterMinutes: hhmm(8) } },
    { kind: "lodging", scopeKey: "", value: { maxPerNightPaise: 150000, dayUseAllowed: false } },
    { kind: "proof_threshold", scopeKey: "*", value: { atPaise: 20000 } },
    {
      kind: "approval_route",
      scopeKey: "",
      value: {
        autoApproveUpToPaise: 100000,
        escalateAboveDayTotalPaise: 500000,
        escalateOnSeverity: null,
      },
    },
  ];

  for (const r of rules) {
    const saved = await saveRule({ policyId, grade: null, cityClass: null, ...r });
    assert.ok(saved.ok, saved.ok ? "" : `${r.kind}: ${saved.error}`);
  }

  const ready = await policyReadiness(policyId);
  assert.deepEqual(ready.problems, [], "the draft should be publishable");

  const published = await publishPolicy({
    policyId,
    effectiveFrom,
    confirmVersionNo: draft.data.versionNo,
  });
  assert.ok(published.ok, published.ok ? "" : published.error);
  return policyId;
}

async function openDay(day: string, over: Partial<typeof mbosExpenseDays.$inferInsert> = {}) {
  const dayId = id("mbos_expday");
  await db.insert(mbosExpenseDays).values({
    id: dayId,
    userId: salesman.id,
    day,
    departedAt: at(day, hhmm(7)),
    returnedAt: at(day, hhmm(20)),
    createdById: salesman.id,
    updatedById: salesman.id,
    ...over,
  });
  return dayId;
}

async function addBikeLeg(dayId: string, day: string, km: number) {
  const legId = id("mbos_leg");
  await db.insert(mbosTravelLegs).values({
    id: legId,
    userId: salesman.id,
    expenseDayId: dayId,
    modeKey: "own_bike",
    fromLabel: "Office",
    toLabel: "Market",
    startedAt: at(day, hhmm(9)),
    endedAt: at(day, hhmm(10)),
    purpose: "visit",
    odometerStartKm: 1000,
    odometerEndKm: 1000 + km,
    createdById: salesman.id,
    updatedById: salesman.id,
  });
  return legId;
}


/** A real attachment row, because the bill photo column has a foreign key. */
async function makeBill() {
  const attId = id("att");
  await db.insert(attachments).values({
    id: attId,
    parentType: "mbos_expense",
    filename: "bill.jpg",
    contentType: "image/jpeg",
    sizeBytes: 1024,
    storedRef: `test/${attId}`,
    status: "available",
    uploadedById: salesman.id,
  });
  return attId;
}

before(async () => {
  await db.execute(sql`select 1`);
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      mbos_expense_exceptions, mbos_travel_legs, mbos_expense_days,
      mbos_expenses, mbos_expense_claims, mbos_approvals, attachments,
      expense_policy_rules, expense_policies, expense_grade_map,
      expense_month_snapshots,
      audit_log, notifications, app_access, sessions, customers, users,
      app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  admin = await makeUser("Asha", "admin");
  salesman = await makeUser("Mahesh", "telecaller");
  await db.insert(appAccess).values({
    id: id("aa"),
    userId: salesman.id,
    app: "field",
    grantedById: admin.id,
  });
  setTestUser(admin);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ------------------------------------------------------- §A authoring */

describe("authoring a policy", () => {
  test("a draft becomes the version in force, and reads back as sentences", async () => {
    await publishPolicyV("2026-04-01", 350);
    const policy = await policyForDate("2026-06-15");
    assert.ok(policy, "a policy should cover a date inside its range");
    assert.equal(policy!.versionNo, 1);

    const detail = await readPolicy(policy!.id, "2026-06-15");
    assert.ok(detail);
    assert.equal(detail!.unreadableCount, 0, "every rule should be readable");
    const sentences = detail!.rules.map((r) => r.sentence).join(" ");
    assert.match(sentences, /own bike is paid ₹3\.5 a kilometre/);
    assert.match(sentences, /Breakfast is worth ₹100/);
  });

  test("a published version cannot be edited", async () => {
    const policyId = await publishPolicyV("2026-04-01", 350);
    const attempt = await saveRule({
      policyId,
      kind: "per_km",
      scopeKey: "travel_mode:own_car",
      grade: null,
      cityClass: null,
      value: { paisePerKm: 900, dailyKmCap: null },
    });
    assert.equal(attempt.ok, false);
    assert.match(
      attempt.ok ? "" : attempt.error,
      /cannot be edited/,
      "editing a published version has to be refused, or requirement 6 has no foundation",
    );
  });

  test("a draft missing an approval route is refused publication", async () => {
    const draft = await createPolicyDraft({ title: "Bare", effectiveFrom: "2027-01-01", notes: null });
    assert.ok(draft.ok);
    await saveRule({
      policyId: draft.data.id,
      kind: "per_km",
      scopeKey: "travel_mode:own_bike",
      grade: null,
      cityClass: null,
      value: { paisePerKm: 350, dailyKmCap: null },
    });
    const ready = await policyReadiness(draft.data.id);
    assert.ok(ready.problems.some((p) => /who decides/.test(p)));

    const published = await publishPolicy({
      policyId: draft.data.id,
      effectiveFrom: "2027-01-01",
      confirmVersionNo: draft.data.versionNo,
    });
    assert.equal(published.ok, false);
  });

  test("publishing with the wrong version number typed back is refused", async () => {
    const draft = await createPolicyDraft({ title: "Typo", effectiveFrom: "2027-02-01", notes: null });
    assert.ok(draft.ok);
    const published = await publishPolicy({
      policyId: draft.data.id,
      effectiveFrom: "2027-02-01",
      confirmVersionNo: draft.data.versionNo + 99,
    });
    assert.equal(published.ok, false);
    assert.match(published.ok ? "" : published.error, /typed back does not match/);
  });
});

/* ------------------------------------- §A6 the policy of the expense's date */

describe("requirement 6 — an old expense keeps its old policy", () => {
  test("a rate rise does not restate what last quarter's day was worth", async () => {
    await publishPolicyV("2026-04-01", 350);

    const oldDay = "2026-06-15";
    const oldDayId = await openDay(oldDay);
    await addBikeLeg(oldDayId, oldDay, 40);
    setTestUser(salesman);
    const first = await submitDay(salesman.id, oldDay);
    assert.ok(first.ok);

    const beforeRise = await priceDay(salesman.id, oldDay);
    assert.equal(beforeRise!.computation!.travelPaise, 14000, "40 km × ₹3.50");

    /* The rate goes up. A new VERSION, which is the only way it can go up. */
    setTestUser(admin);
    await publishPolicyV("2026-09-01", 500);

    const afterRise = await priceDay(salesman.id, oldDay);
    assert.equal(
      afterRise!.computation!.travelPaise,
      14000,
      "June is still worked out on June's policy",
    );

    const newDay = "2026-09-10";
    const newDayId = await openDay(newDay);
    await addBikeLeg(newDayId, newDay, 40);
    const priced = await priceDay(salesman.id, newDay);
    assert.equal(priced!.computation!.travelPaise, 20000, "September gets the new rate");
  });

  test("the version in force ends the day before the next one starts", async () => {
    await publishPolicyV("2026-04-01", 350);
    await publishPolicyV("2026-09-01", 500);

    assert.equal((await policyForDate("2026-08-31"))!.versionNo, 1);
    assert.equal((await policyForDate("2026-09-01"))!.versionNo, 2);
  });
});

/* ---------------------------------------------------- §E food, §G claiming */

describe("a day, priced", () => {
  test("food is worked out from the times, never claimed", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-15";
    await openDay(day);

    const priced = await priceDay(salesman.id, day);
    /* Out at 07:00, back at 20:00 — all three meals. */
    assert.equal(priced!.computation!.foodPaise, 45000);
  });

  test("requirement 28 — leaving after eight drops breakfast and nothing else", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-16";
    await openDay(day, { departedAt: at(day, hhmm(8, 30)), returnedAt: at(day, hhmm(21)) });

    const priced = await priceDay(salesman.id, day);
    assert.equal(priced!.computation!.foodPaise, 35000, "lunch and dinner only");
    const breakfast = priced!.computation!.meals.find((m) => m.meal === "breakfast")!;
    assert.equal(breakfast.earned, false);
    assert.match(breakfast.withheldReason!, /left at 08:30/);
  });

  test("submitting writes the eligible figures, and they equal the derived ones", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-17";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 30);

    const outcome = await submitDay(salesman.id, day);
    assert.ok(outcome.ok);

    const priced = await priceDay(salesman.id, day);
    const storedTravel = await db.execute<{ eligible: number }>(sql`
      select coalesce(sum(eligible_paise), 0) as eligible
        from mbos_expenses where expense_day_id = ${dayId} and kind = 'travel'
    `);
    assert.equal(
      Number(storedTravel[0]!.eligible),
      priced!.computation!.travelPaise,
      "the stored figure is a cache of the derived one and must never diverge from it",
    );

    const storedFood = await db.execute<{ eligible: number }>(sql`
      select coalesce(sum(eligible_paise), 0) as eligible
        from mbos_expenses where expense_day_id = ${dayId} and kind = 'food'
    `);
    assert.equal(Number(storedFood[0]!.eligible), priced!.computation!.foodPaise);
  });

  test("re-submitting a day does not double its lines", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-18";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 20);

    await submitDay(salesman.id, day);
    const again = await submitDay(salesman.id, day);
    assert.equal(again.ok, false, "a locked day cannot be submitted twice");

    const [count] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from mbos_expenses where expense_day_id = ${dayId}
    `);
    assert.equal(count!.n, 2, "one travel line and one food line");
  });
});

/* ---------------------------------------------------- §H routing, §J locking */

describe("where a day goes, and what locks", () => {
  test("a clean day under the limit approves itself", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-19";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 20);

    const outcome = await submitDay(salesman.id, day);
    assert.ok(outcome.ok);
    const raised = await db.execute<{ kind: string; severity: string; message: string }>(sql`
      select kind, severity, message from mbos_expense_exceptions where expense_day_id = ${dayId}
    `);
    assert.equal(
      outcome.autoApproved,
      true,
      `expected a clean day to approve itself; exceptions raised: ${JSON.stringify(raised)}`,
    );

    const approvals = await db
      .select()
      .from(mbosApprovals)
      .where(eq(mbosApprovals.subjectId, dayId));
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.state, "approved");
    assert.equal(approvals[0]!.routeReason, "auto");
  });

  test("a hotel bill over the ceiling is flagged, still recorded, and waits for a person", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-20";
    const dayId = await openDay(day, { overnight: true, stayedInHotel: true });
    await db.insert(mbosExpenses).values({
      id: id("mbos_exp"),
      userId: salesman.id,
      expenseDate: day,
      category: "lodging",
      kind: "lodging",
      sourceType: "manual",
      expenseDayId: dayId,
      amountPaise: 220000,
      billPhotoId: null,
      createdById: salesman.id,
      updatedById: salesman.id,
    });

    const outcome = await submitDay(salesman.id, day);
    assert.ok(outcome.ok);
    assert.equal(outcome.autoApproved, false, "over policy has to reach a person");

    const priced = await priceDay(salesman.id, day);
    assert.equal(priced!.computation!.lodgingClaimedPaise, 220000, "still recorded in full");
    assert.equal(priced!.computation!.lodgingEligiblePaise, 150000);
    assert.ok(priced!.computation!.exceptions.some((e) => e.kind === "over_cap"));
  });

  test("the day is locked on submission and reopening takes a reason", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-21";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 10);
    await submitDay(salesman.id, day);

    const [row] = await db
      .select({ lockedAt: mbosExpenseDays.lockedAt })
      .from(mbosExpenseDays)
      .where(eq(mbosExpenseDays.id, dayId));
    assert.ok(row!.lockedAt, "submitting locks the day");

    const reopened = await reopenDay(dayId, admin.id, "He photographed the wrong bill.", day);
    assert.equal(reopened.ok, true);

    const [after_] = await db
      .select({ lockedAt: mbosExpenseDays.lockedAt, reason: mbosExpenseDays.reopenReason })
      .from(mbosExpenseDays)
      .where(eq(mbosExpenseDays.id, dayId));
    assert.equal(after_!.lockedAt, null);
    assert.match(after_!.reason!, /wrong bill/);
  });

  test("reopening far outside the window is refused, with the window named", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-22";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 10);
    await submitDay(salesman.id, day);

    const refused = await reopenDay(dayId, admin.id, "Too late.", "2026-08-01");
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /days old/);
  });
});

/* -------------------------------------------------------- §G41 three figures */

describe("the manager's list", () => {
  test("claimed, eligible and approved are three separate figures", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-23";
    const dayId = await openDay(day, { overnight: true, stayedInHotel: true });
    await db.insert(mbosExpenses).values({
      id: id("mbos_exp"),
      userId: salesman.id,
      expenseDate: day,
      category: "lodging",
      kind: "lodging",
      sourceType: "manual",
      expenseDayId: dayId,
      amountPaise: 220000,
      billPhotoId: await makeBill(),
      createdById: salesman.id,
      updatedById: salesman.id,
    });
    await submitDay(salesman.id, day);

    const rows = await claimDays({ from: day, to: day });
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(Number(row.claimedPaise) > Number(row.eligiblePaise), true);
    assert.equal(Number(row.excessPaise), 70000);
    assert.equal(row.approvedAmountPaise, null, "nobody has decided yet");

    const decided = await decideExpenseDay({
      dayId,
      decision: "partially_approved",
      approvedAmountPaise: Number(row.eligiblePaise),
      note: "Allowed at the policy figure.",
    });
    assert.ok(decided.ok, decided.ok ? "" : decided.error);

    const after_ = await claimDays({ from: day, to: day });
    assert.equal(after_[0]!.approvalState, "partially_approved");
    assert.equal(Number(after_[0]!.approvedAmountPaise), Number(row.eligiblePaise));
  });

  test("a refusal without a reason is refused", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-24";
    const dayId = await openDay(day, { overnight: true, stayedInHotel: true });
    await db.insert(mbosExpenses).values({
      id: id("mbos_exp"),
      userId: salesman.id,
      expenseDate: day,
      category: "other",
      kind: "other",
      sourceType: "manual",
      expenseDayId: dayId,
      amountPaise: 900000,
      createdById: salesman.id,
      updatedById: salesman.id,
    });
    await submitDay(salesman.id, day);

    const refused = await decideExpenseDay({ dayId, decision: "rejected", note: "  " });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /say why/);
  });
});

/* --------------------------------------------------------- §H43 exceptions */

describe("exceptions", () => {
  test("an answered exception survives the day being priced again", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-25";
    const dayId = await openDay(day, { overnight: true, stayedInHotel: true });
    await db.insert(mbosExpenses).values({
      id: id("mbos_exp"),
      userId: salesman.id,
      expenseDate: day,
      category: "lodging",
      kind: "lodging",
      sourceType: "manual",
      expenseDayId: dayId,
      amountPaise: 220000,
      billPhotoId: await makeBill(),
      createdById: salesman.id,
      updatedById: salesman.id,
    });
    await submitDay(salesman.id, day);

    const [raised] = await db.execute<{ id: string }>(sql`
      select id from mbos_expense_exceptions
       where expense_day_id = ${dayId} and kind = 'over_cap' limit 1
    `);
    assert.ok(raised, "going over the hotel ceiling should raise one");

    const answered = await resolveException({
      exceptionId: raised!.id,
      resolution: "accepted",
      note: "Only room in town during the exhibition.",
    });
    assert.ok(answered.ok, answered.ok ? "" : answered.error);

    /* Price it again — which is what reopening and re-submitting does. */
    await reopenDay(dayId, admin.id, "Checking something.", day);
    await submitDay(salesman.id, day);

    const [after_] = await db.execute<{ resolution: string | null; note: string | null }>(sql`
      select resolution, resolution_note as note
        from mbos_expense_exceptions where id = ${raised!.id}
    `);
    assert.equal(
      after_?.resolution,
      "accepted",
      "a decision somebody made must not be wiped by a recompute",
    );
    assert.match(after_!.note!, /exhibition/);
  });
});

/* ------------------------------------------------------------- permissions */

describe("who may do what", () => {
  test("a telecaller cannot write the policy", async () => {
    setTestUser(salesman);
    await assert.rejects(
      () => createPolicyDraft({ title: "Mine", effectiveFrom: "2027-05-01", notes: null }),
      /expense\.policy\.write/,
    );
  });

  test("writing a policy and putting one in force are different permissions", async () => {
    const accounts = await makeUser("Deepa", "accounts");
    setTestUser(accounts);

    const draft = await createPolicyDraft({ title: "By accounts", effectiveFrom: "2027-06-01", notes: null });
    assert.ok(draft.ok, "accounts may author");

    await assert.rejects(
      () =>
        publishPolicy({
          policyId: draft.data.id,
          effectiveFrom: "2027-06-01",
          confirmVersionNo: draft.data.versionNo,
        }),
      /expense\.policy\.publish/,
      "publishing is an administrator's — verification by whoever typed the rates is not verification",
    );
  });

  test("the seeded grades carry exactly one residual", async () => {
    const grades = await db.select().from(expenseGrades);
    assert.equal(grades.filter((g) => g.isResidual).length, 1);
  });
});


/* ------------------------------------------------------- §I47 duplicates */

describe("a claim written down twice", () => {
  test("the same bill number is caught, and the amounts are named where they differ", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-07-01";
    const dayId = await openDay(day);
    await db.insert(mbosExpenses).values({
      id: id("mbos_exp"),
      userId: salesman.id,
      expenseDate: day,
      category: "other",
      kind: "other",
      sourceType: "manual",
      expenseDayId: dayId,
      amountPaise: 30000,
      billNumber: "INV-4471",
      createdById: salesman.id,
      updatedById: salesman.id,
    });

    const warnings = await duplicateWarnings({
      id: "not-yet-saved",
      userId: salesman.id,
      expenseDate: day,
      kind: "other",
      claimedPaise: 45000,
      vendorName: null,
      billNumber: "inv 4471",
      billHash: null,
      reference: null,
    });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.strength, "certain");
    assert.match(warnings[0]!.reason, /already claimed/);
  });

  test("the same PHOTOGRAPH is caught through the attachment's hash", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-07-02";
    const dayId = await openDay(day);

    /* One file, hashed once, referenced by a claim already recorded. */
    const attId = await makeBill();
    await db
      .update(attachments)
      .set({ contentHash: "deadbeef".repeat(8) })
      .where(eq(attachments.id, attId));
    await db.insert(mbosExpenses).values({
      id: id("mbos_exp"),
      userId: salesman.id,
      expenseDate: day,
      category: "lodging",
      kind: "lodging",
      sourceType: "manual",
      expenseDayId: dayId,
      amountPaise: 120000,
      billPhotoId: attId,
      createdById: salesman.id,
      updatedById: salesman.id,
    });

    const warnings = await duplicateWarnings({
      id: "not-yet-saved",
      userId: salesman.id,
      expenseDate: day,
      kind: "lodging",
      claimedPaise: 120000,
      vendorName: null,
      billNumber: null,
      billHash: "deadbeef".repeat(8),
      reference: null,
    });
    assert.equal(warnings[0]!.strength, "certain");
    assert.deepEqual(warnings[0]!.matchedOn, ["bill image"]);
  });

  test("two claims with nothing in common match on nothing", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-07-03";
    const dayId = await openDay(day);
    await db.insert(mbosExpenses).values({
      id: id("mbos_exp"),
      userId: salesman.id,
      expenseDate: "2026-07-03",
      category: "other",
      kind: "other",
      sourceType: "manual",
      expenseDayId: dayId,
      amountPaise: 30000,
      createdById: salesman.id,
      updatedById: salesman.id,
    });

    const warnings = await duplicateWarnings({
      id: "not-yet-saved",
      userId: salesman.id,
      expenseDate: "2026-07-20",
      kind: "lodging",
      claimedPaise: 99000,
      vendorName: null,
      billNumber: null,
      billHash: null,
      reference: null,
    });
    assert.deepEqual(warnings, []);
  });

  test("a certain duplicate blocks the day to a person on submission", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-07-04";
    const dayId = await openDay(day);
    for (const n of [1, 2]) {
      await db.insert(mbosExpenses).values({
        id: id(`mbos_exp${n}`),
        userId: salesman.id,
        expenseDate: day,
        category: "other",
        kind: "other",
        sourceType: "manual",
        expenseDayId: dayId,
        amountPaise: 30000,
        billNumber: "INV-9001",
        createdById: salesman.id,
        updatedById: salesman.id,
      });
    }
    const outcome = await submitDay(salesman.id, day);
    assert.ok(outcome.ok);
    assert.equal(outcome.autoApproved, false);

    const [raised] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from mbos_expense_exceptions
       where expense_day_id = ${dayId} and kind = 'duplicate_suspect'
    `);
    assert.ok(raised!.n > 0, "one bill number on two claims has to be raised");
  });
});

/* --------------------------------------------------------- §N73 simulator */

describe("what a draft would have cost", () => {
  test("a rate rise is priced against days that really happened", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-15";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 40);
    await submitDay(salesman.id, day);

    /* A draft at a higher rate — not published, so nothing in force moves. */
    setTestUser(admin);
    const draft = await createPolicyDraft({
      title: "Proposed rise",
      effectiveFrom: "2027-01-01",
      notes: null,
      copyFromPolicyId: (await policyForDate(day))!.id,
    });
    assert.ok(draft.ok);

    /* The rate rule came across with the copy, so it is CHANGED rather than
       added — a second rule of one kind at one specificity is refused by the
       unique index, which is the point of it. */
    const copied = (await readPolicy(draft.data.id, day))!.rules.find(
      (r) => r.kind === "per_km" && r.scopeKey === "travel_mode:own_bike",
    )!;
    const raised = await saveRule({
      policyId: draft.data.id,
      ruleId: copied.id,
      kind: "per_km",
      scopeKey: "travel_mode:own_bike",
      grade: null,
      cityClass: null,
      value: { paisePerKm: 500, dailyKmCap: null },
    });
    assert.ok(raised.ok, raised.ok ? "" : raised.error);

    const sim = await simulatePolicy(draft.data.id, "2026-06-01", "2026-06-30");
    assert.ok(!("error" in sim));
    if ("error" in sim) return;

    assert.equal(sim.daysReplayed, 1);
    /* 40 km at ₹3.50 was ₹140; at ₹5.00 it is ₹200. Food is unchanged, so the
       whole difference is the travel. */
    assert.equal(sim.byCategory.actualTravelPaise, 14000);
    assert.equal(sim.byCategory.travelPaise, 20000);
    assert.equal(sim.differencePaise, 6000);
    assert.match(sim.caveats[0]!, /Replayed 1 submitted day/);
  });

  test("it writes nothing — the day is worth what it was worth afterwards", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-16";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 40);
    await submitDay(salesman.id, day);

    const before = await priceDay(salesman.id, day);
    setTestUser(admin);
    const draft = await createPolicyDraft({
      title: "Much higher",
      effectiveFrom: "2027-01-01",
      notes: null,
      copyFromPolicyId: (await policyForDate(day))!.id,
    });
    assert.ok(draft.ok);
    const copied = (await readPolicy(draft.data.id, day))!.rules.find(
      (r) => r.kind === "per_km" && r.scopeKey === "travel_mode:own_bike",
    )!;
    await saveRule({
      policyId: draft.data.id,
      ruleId: copied.id,
      kind: "per_km",
      scopeKey: "travel_mode:own_bike",
      grade: null,
      cityClass: null,
      value: { paisePerKm: 5000, dailyKmCap: null },
    });
    await simulatePolicy(draft.data.id, "2026-06-01", "2026-06-30");

    const after_ = await priceDay(salesman.id, day);
    assert.equal(
      after_!.computation!.travelPaise,
      before!.computation!.travelPaise,
      "a simulation is a read and must leave the book exactly as it found it",
    );
  });

  test("a mode the draft never priced is NAMED, not counted as a saving", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-17";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 40);
    await submitDay(salesman.id, day);

    /* A draft with no travel rate at all. */
    setTestUser(admin);
    const draft = await createPolicyDraft({ title: "Forgot the rate", effectiveFrom: "2027-02-01", notes: null });
    assert.ok(draft.ok);

    const sim = await simulatePolicy(draft.data.id, "2026-06-01", "2026-06-30");
    assert.ok(!("error" in sim));
    if ("error" in sim) return;

    assert.deepEqual(sim.unpricedModes, [{ modeKey: "own_bike", legs: 1 }]);
    assert.ok(
      sim.caveats.some((c) => /sets no rate for own bike/.test(c)),
      "a draft that prices nothing must not read as free",
    );
  });

  test("an empty window says so rather than reporting a saving of everything", async () => {
    await publishPolicyV("2026-04-01", 350);
    setTestUser(admin);
    const draft = await createPolicyDraft({ title: "Nothing to see", effectiveFrom: "2027-03-01", notes: null });
    assert.ok(draft.ok);

    const sim = await simulatePolicy(draft.data.id, "2020-01-01", "2020-01-31");
    assert.ok(!("error" in sim));
    if ("error" in sim) return;
    assert.equal(sim.daysReplayed, 0);
    assert.equal(sim.differencePaise, 0);
    assert.match(sim.caveats[0]!, /nothing to replay/);
  });
});

/* ----------------------------------------------------------- §M72 the trend */

describe("the monthly trend", () => {
  test("a month is frozen, and reading it back does not touch the ledger", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-18";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 40);
    await submitDay(salesman.id, day);
    await decideExpenseDay({ dayId, decision: "approved", approvedAmountPaise: 0, note: null });

    const rows = await snapshotExpenseMonth("2026-06");
    assert.ok(rows >= 1, "at least the company row");

    const trend = await expenseTrend(12);
    assert.equal(trend.length, 1);
    assert.equal(trend[0]!.period, "2026-06");
    assert.ok(trend[0]!.totalPaise > 0);
  });

  test("running it twice does not double the month", async () => {
    await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-19";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 40);
    await submitDay(salesman.id, day);
    await decideExpenseDay({ dayId, decision: "approved", approvedAmountPaise: 0, note: null });

    await snapshotExpenseMonth("2026-06");
    const once = (await expenseTrend(12))[0]!.totalPaise;
    await snapshotExpenseMonth("2026-06");
    const twice = (await expenseTrend(12))[0]!.totalPaise;
    assert.equal(twice, once, "the unique index is what stops the trend doubling");
    assert.equal((await expenseTrend(12)).length, 1);
  });

  test("a month with no snapshot is absent, never drawn as zero", async () => {
    const trend = await expenseTrend(12);
    assert.deepEqual(trend, [], "nothing snapshotted means nothing to show, not a flat line");
  });
});
