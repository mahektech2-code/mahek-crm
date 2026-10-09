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
import {
  STANDARD_DEFAULTS_VERSION,
  STANDARD_POLICY,
  STANDARD_POLICY_ID,
  STANDARD_POLICY_TITLE,
} from "@/lib/expense-policy-standard";
import type { PolicyRule } from "@/lib/engines/expense-policy";

/* The issued policy pays own vehicles nothing, and these tests are about how a
   kilometre allowance is written, edited and re-worked — so the standard row
   is seeded as the document's rules with own bike at ₹3.50 a km. Seeded at the
   current defaults edition, so `ensureStandardSet` leaves it as it is. */
const TEST_RULES: PolicyRule[] = STANDARD_POLICY.rules.map((r) =>
  r.kind === "zero_rated" && r.modeKey === "own_bike"
    ? { kind: "per_km", grade: null, cityClass: null, modeKey: "own_bike", paisePerKm: 350, dailyKmCap: null }
    : r,
);
import {
  assignPolicySet,
  createPolicySet,
  deletePolicySet,
  duplicatePolicySet,
  restorePolicyRevision,
  savePolicySet,
  setPolicySetActive,
} from "@/lib/actions/expense-policy-sets";
import { policySetRevisions, readPolicySet } from "@/lib/services/expense-policy-set-service";
import { ruleToDraft } from "@/lib/expense-policy-sets";
import { priceDay } from "@/lib/services/expense-service";
import { refreshDayMoney } from "@/lib/services/expense-submit-service";
import { expenseLines } from "@/lib/services/expense-claims-service";
import { resolveException } from "@/lib/actions/expenses";
import { decideExpense } from "@/lib/actions/sales";
import { expenseStateSql, paidPaiseSql } from "@/lib/expense-money-sql";
import { duplicateWarnings } from "@/lib/services/expense-service";
import { simulatePolicy } from "@/lib/services/expense-simulator-service";
import { expenseTrend, snapshotExpenseMonth } from "@/lib/services/expense-roi-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const hhmm = (h: number, m = 0) => h * 60 + m;

let admin: typeof users.$inferSelect;
let salesman: typeof users.$inferSelect;

async function makeUser(name: string, role: "associate" | "manager" | "admin", app: "crm" | "accounts" = "crm") {
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
  /* The app grant, because a level on its own is not one — a capability hangs
     on (app, level) now, and `role: "manager"` with no `app_access` row is a
     manager of nothing. */
  await db.insert(appAccess).values({
    id: id("aca"),
    userId: row!.id,
    app,
    role,
  });
  return row!;
}

/**
 * The ledger desk, which is an APP GRANT and not a role any more.
 *
 * `role: "manager"` alone is a manager of nothing — the capabilities that make
 * somebody accounts (approving an order, confirming a payment, issuing a
 * credit note) hang on holding the Accounts app at manager level. A test that
 * set only the level would be testing a person who cannot do the job.
 */
async function makeAccountsUser(name: string) {
  return makeUser(name, "manager", "accounts");
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
  await db.execute(sql`
    insert into expense_policy_sets (id, name, is_standard, active, rules, revision, defaults_version)
    values (${STANDARD_POLICY_ID}, ${STANDARD_POLICY_TITLE}, true, true, ${JSON.stringify(TEST_RULES)}::jsonb, 1,
            ${STANDARD_DEFAULTS_VERSION})
  `);

  admin = await makeUser("Asha", "admin");
  /* The PLATFORM administrator: the Admin Console at the admin level. Admin of
     the CRM alone is admin of the CRM, and would see only her own (empty)
     book of expense days. */
  await db.insert(appAccess).values({ id: id("aa"), userId: admin.id, app: "admin", role: "admin" });
  salesman = await makeUser("Mahesh", "associate");
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
  test("a published draft reads back as sentences", async () => {
    const policyId = await publishPolicyV("2026-04-01", 350);
    const detail = await readPolicy(policyId, "2026-06-15");
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

describe("the hard-coded standard policy", () => {
  test("it is the policy in force on every date, whatever the table holds", async () => {
    await publishPolicyV("2026-04-01", 500);
    assert.equal((await policyForDate("2026-06-15"))!.id, STANDARD_POLICY_ID);
    assert.equal((await policyForDate("2001-01-01"))!.id, STANDARD_POLICY_ID);
  });

  test("a day is priced and stamped with it, at ₹3.50 a km on a bike", async () => {
    const day = "2026-06-15";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 40);
    await refreshDayMoney(salesman.id, day);
    const priced = await priceDay(salesman.id, day);
    assert.equal(priced!.computation!.travelPaise, 14000, "40 km × ₹3.50");
    const [row] = await db
      .select({ policyId: mbosExpenseDays.policyId })
      .from(mbosExpenseDays)
      .where(eq(mbosExpenseDays.id, dayId));
    assert.equal(row!.policyId, STANDARD_POLICY_ID);
  });
});

/* ---------------------------------------------------- §E food, §G claiming */

describe("a day, priced", () => {
  test("food is worked out from the times, never claimed", async () => {
    const day = "2026-06-15";
    await openDay(day);

    const priced = await priceDay(salesman.id, day);
    /* Out at 07:00, back at 20:00 — breakfast and lunch; dinner needs him
       back after 22:30. */
    assert.equal(priced!.computation!.foodPaise, 25000);
  });

  test("the policy document — leaving after eight earns no meal at all", async () => {
    const day = "2026-06-16";
    await openDay(day, { departedAt: at(day, hhmm(8, 30)), returnedAt: at(day, hhmm(23)) });

    const priced = await priceDay(salesman.id, day);
    assert.equal(priced!.computation!.foodPaise, 0);
    const breakfast = priced!.computation!.meals.find((m) => m.meal === "breakfast")!;
    assert.equal(breakfast.earned, false);
    assert.match(breakfast.withheldReason!, /08:30/);
  });

  test("a day in his hometown earns no meal, once his hometown is set", async () => {
    const day = "2026-06-21";
    const dayId = await openDay(day, { departedAt: at(day, hhmm(6)), returnedAt: at(day, hhmm(23)) });
    await refreshDayMoney(salesman.id, day);
    assert.equal((await priceDay(salesman.id, day))!.computation!.foodPaise, 45000, "no hometown set: as recorded");

    await db.execute(sql`insert into expense_hometowns (user_id, city) values (${salesman.id}, 'Nagpur')`);
    await refreshDayMoney(salesman.id, day);
    const [row] = await db
      .select({ away: mbosExpenseDays.departedFromHometown })
      .from(mbosExpenseDays)
      .where(eq(mbosExpenseDays.id, dayId));
    assert.equal(row!.away, false, "no shop elsewhere and no trip named");
    assert.equal((await priceDay(salesman.id, day))!.computation!.foodPaise, 0);

    await db.update(mbosExpenseDays).set({ destinationCity: "Wardha" }).where(eq(mbosExpenseDays.id, dayId));
    await refreshDayMoney(salesman.id, day);
    assert.equal((await priceDay(salesman.id, day))!.computation!.foodPaise, 45000, "a trip to Wardha is away");
  });

  test("the allowances are written with no day closed, and equal the derived figures", async () => {
    const day = "2026-06-17";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 30);

    await refreshDayMoney(salesman.id, day);

    const priced = await priceDay(salesman.id, day);
    const stored = await db.execute<{ kind: string; amount: number; eligible: number }>(sql`
      select kind, sum(amount_paise)::int as amount, sum(eligible_paise)::int as eligible
        from mbos_expenses where expense_day_id = ${dayId} group by kind
    `);
    const travel = stored.find((r) => r.kind === "travel")!;
    const food = stored.find((r) => r.kind === "food")!;
    assert.equal(Number(travel.amount), priced!.computation!.travelPaise, "the kilometre allowance");
    assert.equal(Number(travel.eligible), Number(travel.amount), "an allowance is what the policy pays");
    assert.equal(Number(food.amount), priced!.computation!.foodPaise, "the meal allowance");

    const [day_] = await db
      .select({ submittedAt: mbosExpenseDays.submittedAt, lockedAt: mbosExpenseDays.lockedAt })
      .from(mbosExpenseDays)
      .where(eq(mbosExpenseDays.id, dayId));
    assert.equal(day_!.submittedAt, null, "nothing is submitted");
    assert.equal(day_!.lockedAt, null, "and nothing locks");
    const approvals = await db.select().from(mbosApprovals).where(eq(mbosApprovals.subjectId, dayId));
    assert.equal(approvals.length, 0, "an allowance asks nobody's approval");
  });

  test("refreshing again does not double its lines", async () => {
    const day = "2026-06-18";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 20);

    await refreshDayMoney(salesman.id, day);
    await refreshDayMoney(salesman.id, day);

    const [count] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from mbos_expenses where expense_day_id = ${dayId}
    `);
    assert.equal(count!.n, 2, "one kilometre allowance and one meal allowance");
  });

  test("a walk, or a trip that stops earning, leaves no ₹0 line behind", async () => {
    const day = "2026-06-19";
    const dayId = await openDay(day, { departedAt: null, returnedAt: null });
    const legId = await addBikeLeg(dayId, day, 25);

    await refreshDayMoney(salesman.id, day);
    const [before_] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from mbos_expenses where source_id = ${legId}
    `);
    assert.equal(before_!.n, 1, "a bike trip earns its kilometres");

    await db.update(mbosTravelLegs).set({ modeKey: "walking" }).where(eq(mbosTravelLegs.id, legId));
    await refreshDayMoney(salesman.id, day);

    const [lines] = await db.execute<{ n: number; zero: number }>(sql`
      select count(*)::int as n, count(*) filter (where amount_paise <= 0)::int as zero
        from mbos_expenses where expense_day_id = ${dayId}
    `);
    assert.equal(lines!.zero, 0, "nothing is ever written at ₹0");
    assert.equal(lines!.n, 0, "a walk pays nothing, so its allowance is taken away");
  });

  test("a deleted trip takes its allowance with it", async () => {
    const day = "2026-06-20";
    const dayId = await openDay(day, { departedAt: null, returnedAt: null });
    const legId = await addBikeLeg(dayId, day, 25);
    await refreshDayMoney(salesman.id, day);

    await db.delete(mbosTravelLegs).where(eq(mbosTravelLegs.id, legId));
    await refreshDayMoney(salesman.id, day);

    const [lines] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from mbos_expenses where expense_day_id = ${dayId}
    `);
    assert.equal(lines!.n, 0);
  });
});

/* ------------------------------------------------- one expense, one decision */

async function logExpense(day: string, dayId: string, amountPaise: number, kind = "lodging") {
  const expenseId = id("mbos_expense");
  await db.insert(mbosExpenses).values({
    id: expenseId,
    userId: salesman.id,
    expenseDate: day,
    category: kind === "local_transport" ? "travel" : (kind as "lodging" | "food" | "travel" | "other"),
    kind,
    sourceType: "manual",
    expenseDayId: dayId,
    amountPaise,
    billPhotoId: await makeBill(),
    createdById: salesman.id,
    updatedById: salesman.id,
  });
  return expenseId;
}

/** Somebody who decides expenses: a manager of the Sales Dashboard. */
async function salesManager() {
  const m = await makeUser("Ravi", "manager");
  await db.insert(appAccess).values({ id: id("aa"), userId: m.id, app: "sales", role: "manager" });
  return m;
}

describe("an expense he logs", () => {
  test("is on the Expenses desk at once, waiting, with the policy figure beside it", async () => {
    const day = "2026-06-23";
    const dayId = await openDay(day, { overnight: true, stayedInHotel: true });
    const expenseId = await logExpense(day, dayId, 220000);
    await refreshDayMoney(salesman.id, day);

    setTestUser(await salesManager());
    const rows = await expenseLines({ from: day, to: day });
    const row = rows.find((r) => r.id === expenseId)!;
    assert.ok(row, "no day was closed and it is listed anyway");
    assert.equal(row.state, "pending");
    assert.equal(row.allowance, false);
    assert.equal(row.claimedPaise, 220000, "recorded in full, however far over");
    assert.equal(row.eligiblePaise, 45000, "the fixed hotel rate");
    assert.equal(row.excessPaise, 175000);
    assert.equal(row.files.length, 1, "the bill is in front of whoever decides it");
    assert.ok(
      rows.some((r) => r.allowance && r.kind === "food" && r.state === "allowance"),
      "the day's meal allowance is listed beside it, already his",
    );
  });

  test("is part-approved on its own, and only that amount counts as paid", async () => {
    const day = "2026-06-24";
    const dayId = await openDay(day, { overnight: true, stayedInHotel: true });
    const expenseId = await logExpense(day, dayId, 220000);
    await refreshDayMoney(salesman.id, day);

    setTestUser(await salesManager());
    const decided = await decideExpense({
      expenseId,
      decision: "partially_approved",
      approvedAmountPaise: 150000,
      note: "Allowed at the policy figure.",
    });
    assert.ok(decided.ok, decided.ok ? "" : decided.error);

    const [row] = await db.execute<{ state: string; paid: number }>(sql`
      select ${expenseStateSql("e")} as state, ${paidPaiseSql("e")}::int as paid
        from mbos_expenses e where e.id = ${expenseId}
    `);
    assert.equal(row!.state, "partially_approved");
    assert.equal(Number(row!.paid), 150000);
  });

  test("a 'part' at or above what he logged is recorded as a yes", async () => {
    const day = "2026-06-25";
    const dayId = await openDay(day);
    const expenseId = await logExpense(day, dayId, 30000, "other");

    setTestUser(await salesManager());
    const decided = await decideExpense({
      expenseId,
      decision: "partially_approved",
      approvedAmountPaise: 30000,
      note: "Fine.",
    });
    assert.ok(decided.ok, decided.ok ? "" : decided.error);
    const [row] = await db.execute<{ state: string }>(sql`
      select ${expenseStateSql("e")} as state from mbos_expenses e where e.id = ${expenseId}
    `);
    assert.equal(row!.state, "approved");
  });

  test("a refusal without a reason is refused, and an allowance cannot be decided", async () => {
    const day = "2026-06-26";
    const dayId = await openDay(day);
    const expenseId = await logExpense(day, dayId, 90000, "other");
    await refreshDayMoney(salesman.id, day);

    setTestUser(await salesManager());
    const refused = await decideExpense({ expenseId, decision: "rejected", note: "  " });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /Say why/);

    const [meal] = await db.execute<{ id: string }>(sql`
      select id from mbos_expenses where expense_day_id = ${dayId} and source_type = 'expense_day'
    `);
    const onAllowance = await decideExpense({ expenseId: meal!.id, decision: "approved" });
    assert.equal(onAllowance.ok, false);
    assert.match(onAllowance.ok ? "" : onAllowance.error, /allowance/);
  });

  test("an expense whose approval has not arrived yet can still be decided", async () => {
    const day = "2026-06-27";
    const dayId = await openDay(day);
    const expenseId = await logExpense(day, dayId, 12050, "local_transport");

    setTestUser(await salesManager());
    const decided = await decideExpense({ expenseId, decision: "approved" });
    assert.ok(decided.ok, decided.ok ? "" : decided.error);
    const [row] = await db.execute<{ paid: number }>(sql`
      select ${paidPaiseSql("e")}::int as paid from mbos_expenses e where e.id = ${expenseId}
    `);
    assert.equal(Number(row!.paid), 12050, "to the paisa");
  });
});

/* --------------------------------------------------------- §H43 exceptions */

describe("exceptions", () => {
  test("an answered exception survives the day being priced again", async () => {
    const day = "2026-06-28";
    const dayId = await openDay(day, { overnight: true, stayedInHotel: true });
    await logExpense(day, dayId, 220000);
    await refreshDayMoney(salesman.id, day);

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

    /* Price it again — which every sync and the nightly pass do. */
    await refreshDayMoney(salesman.id, day);

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
    const accounts = await makeAccountsUser("Deepa");
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

  test("a certain duplicate is raised for whoever decides it", async () => {
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
    await refreshDayMoney(salesman.id, day);

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
    const publishedId = await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-15";
    /* Out early and back late, so every meal is earned under either policy and
       the only difference is the kilometres. */
    const dayId = await openDay(day, { departedAt: at(day, hhmm(6)), returnedAt: at(day, hhmm(23)) });
    await addBikeLeg(dayId, day, 40);
    await refreshDayMoney(salesman.id, day);

    /* A draft at a higher rate — not published, so nothing in force moves. */
    setTestUser(admin);
    const draft = await createPolicyDraft({
      title: "Proposed rise",
      effectiveFrom: "2027-01-01",
      notes: null,
      copyFromPolicyId: publishedId,
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
    assert.match(sim.caveats[0]!, /Replayed 1 recorded day/);
  });

  test("it writes nothing — the day is worth what it was worth afterwards", async () => {
    const publishedId = await publishPolicyV("2026-04-01", 350);
    const day = "2026-06-16";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 40);
    await refreshDayMoney(salesman.id, day);

    const before = await priceDay(salesman.id, day);
    setTestUser(admin);
    const draft = await createPolicyDraft({
      title: "Much higher",
      effectiveFrom: "2027-01-01",
      notes: null,
      copyFromPolicyId: publishedId,
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
    await refreshDayMoney(salesman.id, day);

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
    await refreshDayMoney(salesman.id, day);

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
    await refreshDayMoney(salesman.id, day);

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

/* ------------------------------------------------- named, editable policies */

describe("named policies", () => {
  const bikeRate = async (setId: string, paisePerKm: number) => {
    const set = await readPolicySet(setId);
    const drafts = set!.rules.map(ruleToDraft).map((d) =>
      d.kind === "per_km" && d.scopeKey === "own_bike" ? { ...d, value: { ...d.value, paisePerKm } } : d,
    );
    return savePolicySet({ id: setId, name: set!.name, description: set!.description, rules: drafts, expectedRevision: set!.revision });
  };

  test("editing the standard policy changes what a day is paid", async () => {
    const saved = await bikeRate(STANDARD_POLICY_ID, 500);
    assert.ok(saved.ok, saved.ok ? "" : saved.error);
    const day = "2026-06-15";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 40);
    await refreshDayMoney(salesman.id, day);
    assert.equal((await priceDay(salesman.id, day))!.computation!.travelPaise, 20000, "40 km × ₹5");
    assert.equal((await policySetRevisions(STANDARD_POLICY_ID)).length, 2, "the seed and the edit");
  });

  test("a copy, given to one salesman, prices only his days — and its id is a key his day can carry", async () => {
    const copy = await createPolicySet({ name: "Outstation", description: null });
    assert.ok(copy.ok, copy.ok ? "" : copy.error);
    assert.ok((await bikeRate(copy.data.id, 1000)).ok);
    const moved = await assignPolicySet({ userIds: [salesman.id], setId: copy.data.id, notify: false });
    assert.ok(moved.ok && moved.data.moved === 1);

    const day = "2026-06-16";
    const dayId = await openDay(day);
    await addBikeLeg(dayId, day, 40);
    await refreshDayMoney(salesman.id, day);
    assert.equal((await priceDay(salesman.id, day))!.computation!.travelPaise, 40000, "40 km × ₹10");
    const [row] = await db.select({ policyId: mbosExpenseDays.policyId }).from(mbosExpenseDays).where(eq(mbosExpenseDays.id, dayId));
    assert.equal(row!.policyId, copy.data.id);
    assert.equal((await policyForDate(day, admin.id))!.id, STANDARD_POLICY_ID, "everybody else stays on standard");

    /* Switched off, he is paid on standard again; deleting it is refused because it priced a day. */
    assert.ok((await setPolicySetActive({ id: copy.data.id, active: false })).ok);
    assert.equal((await policyForDate(day, salesman.id))!.id, STANDARD_POLICY_ID);
    const del = await deletePolicySet({ id: copy.data.id });
    assert.equal(del.ok, false);
    assert.match(del.ok ? "" : del.error, /switch it off instead/i);
  });

  test("a stale save is refused rather than overwriting somebody else's", async () => {
    const set = (await readPolicySet(STANDARD_POLICY_ID))!;
    assert.ok((await bikeRate(STANDARD_POLICY_ID, 400)).ok);
    const late = await savePolicySet({
      id: set.id,
      name: set.name,
      description: set.description,
      rules: set.rules.map(ruleToDraft),
      expectedRevision: set.revision,
    });
    assert.equal(late.ok, false);
    assert.equal(late.ok ? "" : late.code, "conflict");
  });

  test("a broken rule is refused with its field named, and an old revision can be restored", async () => {
    const set = (await readPolicySet(STANDARD_POLICY_ID))!;
    const drafts = set.rules.map(ruleToDraft);
    const k = drafts.findIndex((d) => d.kind === "per_km");
    drafts[k] = { ...drafts[k]!, value: { paisePerKm: -5, dailyKmCap: null } };
    const bad = await savePolicySet({ id: set.id, name: set.name, description: null, rules: drafts, expectedRevision: set.revision });
    assert.equal(bad.ok, false);
    assert.ok(!bad.ok && bad.fieldErrors?.some((f) => f.field === `rules.${k}.paisePerKm`));

    assert.ok((await bikeRate(STANDARD_POLICY_ID, 777)).ok);
    const restored = await restorePolicyRevision({ id: STANDARD_POLICY_ID, revision: 1 });
    assert.ok(restored.ok, restored.ok ? "" : restored.error);
    const back = (await readPolicySet(STANDARD_POLICY_ID))!;
    assert.deepEqual(back.rules, TEST_RULES);
  });

  test("a duplicate is a full copy nobody is on, and an unused one can be deleted", async () => {
    const dup = await duplicatePolicySet({ id: STANDARD_POLICY_ID });
    assert.ok(dup.ok);
    const copy = (await readPolicySet(dup.data.id))!;
    assert.match(copy.name, /^Copy of /);
    assert.deepEqual(copy.rules, (await readPolicySet(STANDARD_POLICY_ID))!.rules);
    assert.equal(copy.memberCount, 0);
    assert.ok((await deletePolicySet({ id: copy.id })).ok);
    assert.equal(await readPolicySet(copy.id), null);
  });

  test("guidelines are saved with the rules, copied with a duplicate, and kept in the history", async () => {
    const set = (await readPolicySet(STANDARD_POLICY_ID))!;
    const saved = await savePolicySet({
      id: set.id,
      name: set.name,
      description: null,
      rules: set.rules.map(ruleToDraft),
      guidelines: ["  Bills with every claim. ", "", "Paid with salary."],
      expectedRevision: set.revision,
    });
    assert.ok(saved.ok, saved.ok ? "" : saved.error);
    assert.deepEqual((await readPolicySet(STANDARD_POLICY_ID))!.guidelines, ["Bills with every claim.", "Paid with salary."]);
    const dup = await duplicatePolicySet({ id: STANDARD_POLICY_ID });
    assert.ok(dup.ok);
    assert.deepEqual((await readPolicySet(dup.data.id))!.guidelines, ["Bills with every claim.", "Paid with salary."]);
    const restored = await restorePolicyRevision({ id: STANDARD_POLICY_ID, revision: 1 });
    assert.ok(restored.ok);
    assert.deepEqual((await readPolicySet(STANDARD_POLICY_ID))!.guidelines, []);
  });

  test("an untouched standard policy moves onto the document's figures; an edited one does not", async () => {
    await db.execute(sql`update expense_policy_sets set defaults_version = 1 where id = ${STANDARD_POLICY_ID}`);
    const moved = (await readPolicySet(STANDARD_POLICY_ID))!;
    assert.deepEqual(moved.rules, STANDARD_POLICY.rules);
    assert.ok(moved.guidelines.length > 0);
    assert.equal(moved.revision, 2);
    assert.match((await policySetRevisions(STANDARD_POLICY_ID))[0]!.note ?? "", /Expense Policy document/);

    const edited = await savePolicySet({
      id: moved.id,
      name: moved.name,
      description: null,
      rules: TEST_RULES.map(ruleToDraft),
      expectedRevision: moved.revision,
    });
    assert.ok(edited.ok, edited.ok ? "" : edited.error);
    await db.execute(sql`update expense_policy_sets set defaults_version = 1 where id = ${STANDARD_POLICY_ID}`);
    const kept = (await readPolicySet(STANDARD_POLICY_ID))!;
    assert.deepEqual(kept.rules, TEST_RULES, "a person's edit stands");
  });

  test("the standard policy cannot be switched off or deleted", async () => {
    assert.equal((await setPolicySetActive({ id: STANDARD_POLICY_ID, active: false })).ok, false);
    assert.equal((await deletePolicySet({ id: STANDARD_POLICY_ID })).ok, false);
  });
});
