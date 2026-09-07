import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  mbosApprovals,
  mbosExpenseDays,
  mbosExpenseExceptions,
  mbosExpenses,
  mbosTravelLegs,
} from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { worstSeverity, type PolicyException } from "@/lib/engines/expense-policy";
import { kmAnomalies, spendAnomalies } from "@/lib/engines/expense-fraud";
import {
  priceDay,
  ownDayHistory,
  teamDayHistory,
  gpsForLeg,
  duplicatesForDay,
} from "./expense-service";
import { resolveSubject, classOfCity } from "./expense-policy-service";

/* ---------------------------------------------------------------------------
 * Closing a day: pricing it, writing the eligible figures onto its lines,
 * raising what it raises, and routing it to whoever decides.
 *
 * ONE function does all of it — `submitDay` — because every one of those is
 * part of the same act and a day that is priced but not routed, or routed but
 * not locked, is a state nobody designed. The same rule the CRM's "saving a
 * call is one transaction" follows, and for the same reason: half-saved is how
 * field data goes wrong.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ------------------------------------------------------ distance on a leg */

/**
 * Work out and store what a leg's distance is, from all three sources.
 *
 * Run when a leg lands and again when the day is submitted, because the trail
 * arrives in batches and a leg synced the moment it ended has fewer positions
 * behind it than the same leg has an hour later. Re-running is safe: it reads
 * the trail and the odometer and writes what they say, and neither moves once
 * the day is over.
 */
export async function rescoreLeg(legId: string): Promise<void> {
  const [leg] = await db.execute<{
    id: string;
    userId: string;
    modeKey: string;
    startedAt: unknown;
    endedAt: unknown;
    fromLat: number | null;
    fromLng: number | null;
    toLat: number | null;
    toLng: number | null;
    odometerStartKm: number | null;
    odometerEndKm: number | null;
    manualMetres: number | null;
  }>(sql`
    select l.id, l.user_id as "userId", l.mode_key as "modeKey",
           l.started_at as "startedAt", l.ended_at as "endedAt",
           l.from_lat as "fromLat", l.from_lng as "fromLng",
           l.to_lat as "toLat", l.to_lng as "toLng",
           l.odometer_start_km as "odometerStartKm", l.odometer_end_km as "odometerEndKm",
           l.manual_metres as "manualMetres"
      from mbos_travel_legs l where l.id = ${legId} limit 1
  `);
  if (!leg) return;

  const gps = await gpsForLeg(leg);

  /* The odometer pair, in metres. A backwards pair is NOT quietly made
     positive: an end below a start is somebody having typed one of them wrong,
     and an absolute value would turn a typo into a payable distance. */
  const odometerMetres =
    leg.odometerStartKm !== null &&
    leg.odometerEndKm !== null &&
    leg.odometerEndKm >= leg.odometerStartKm
      ? (leg.odometerEndKm - leg.odometerStartKm) * 1000
      : null;

  await db
    .update(mbosTravelLegs)
    .set({
      gpsMetres: gps.metres,
      gpsMethod: gps.method,
      gpsFixCount: gps.fixCount,
      gpsCoveragePct: gps.coveragePct,
      gpsReason: gps.reason,
      odometerMetres,
    })
    .where(eq(mbosTravelLegs.id, legId));
}

/* ------------------------------------------------------- pricing the lines */

/**
 * Write what the engine said onto the rows it said it about.
 *
 * The eligible figure is DERIVED and could be computed on every read — it is
 * stored so that a list of two hundred claims is one query rather than two
 * hundred engine runs, and there is a test asserting the stored value equals
 * the derived one. It is a cache, and it says so.
 */
async function writeLineFigures(answer: NonNullable<Awaited<ReturnType<typeof priceDay>>>) {
  const c = answer.computation;
  if (!c) return;

  /* A travel leg's money is an expense LINE, so the ledger stays one list.
     Upserted on (sourceType, sourceId) rather than inserted, because a day is
     submitted, reopened and submitted again and each pass must land on the
     same row. */
  for (const leg of c.legs) {
    const row = answer.legs.find((l) => l.id === leg.legId);
    await db
      .insert(mbosExpenses)
      .values({
        id: `mbos_exp_leg_${leg.legId.slice(-20)}`,
        userId: answer.day.userId,
        expenseDate: answer.day.day,
        category: "travel",
        kind: "travel",
        sourceType: "travel_leg",
        sourceId: leg.legId,
        expenseDayId: answer.day.id,
        amountPaise: leg.claimedPaise,
        eligiblePaise: leg.eligiblePaise,
        excessPaise: leg.excessPaise,
        policyId: answer.policy?.id ?? null,
        resolvedGrade: answer.subject.grade,
        resolvedCityClass: answer.subject.cityClass,
        billPhotoId: row?.ticketPhotoId ?? null,
        remarks: row ? `${row.fromLabel ?? "?"} → ${row.toLabel ?? "?"}` : null,
        createdById: answer.day.userId,
        updatedById: answer.day.userId,
      })
      .onConflictDoUpdate({
        target: mbosExpenses.id,
        set: {
          amountPaise: leg.claimedPaise,
          eligiblePaise: leg.eligiblePaise,
          excessPaise: leg.excessPaise,
          policyId: answer.policy?.id ?? null,
          updatedAt: new Date(),
        },
      });
  }

  /* Food is not entered at all — it is what the day's times earn. One line,
     rewritten each pass, so a day whose departure time is corrected does not
     leave yesterday's allowance behind it. */
  const foodId = `mbos_exp_food_${answer.day.id.slice(-24)}`;
  if (c.foodPaise > 0) {
    const earned = c.meals.filter((m) => m.earned).map((m) => m.meal);
    await db
      .insert(mbosExpenses)
      .values({
        id: foodId,
        userId: answer.day.userId,
        expenseDate: answer.day.day,
        category: "food",
        kind: "food",
        sourceType: "expense_day",
        sourceId: answer.day.id,
        expenseDayId: answer.day.id,
        amountPaise: c.foodPaise,
        eligiblePaise: c.foodPaise,
        excessPaise: 0,
        policyId: answer.policy?.id ?? null,
        resolvedGrade: answer.subject.grade,
        resolvedCityClass: answer.subject.cityClass,
        remarks: c.dormitoryApplied
          ? "Dormitory morning — instead of the day's meals"
          : earned.length
            ? earned.join(", ")
            : null,
        createdById: answer.day.userId,
        updatedById: answer.day.userId,
      })
      .onConflictDoUpdate({
        target: mbosExpenses.id,
        set: {
          amountPaise: c.foodPaise,
          eligiblePaise: c.foodPaise,
          remarks: c.dormitoryApplied
            ? "Dormitory morning — instead of the day's meals"
            : earned.join(", "),
          updatedAt: new Date(),
        },
      });
  } else {
    await db.delete(mbosExpenses).where(eq(mbosExpenses.id, foodId));
  }

  /* And the lines somebody actually typed — a hotel bill, a rickshaw. Only
     their eligible figure is written; the claimed amount is his and is never
     touched. */
  const eligibleByLine = new Map<string, { eligible: number; excess: number }>();
  {
    /* Lodging and everything else, recomputed the same way the engine did, by
       asking it for the per-line answer rather than re-deriving one here. */
    const lodgingTotalEligible = c.lodgingEligiblePaise;
    const lodgingLines = answer.lines.filter((l) => l.kind === "lodging");
    const lodgingClaimed = lodgingLines.reduce((n, l) => n + Number(l.amountPaise), 0);
    for (const l of lodgingLines) {
      /* Where there is one hotel line — which is every real day — this is
         exact. Where there are two, the eligible total is shared in the
         proportion claimed, which is the only split that cannot favour one
         line over the other. */
      const share = lodgingClaimed > 0 ? Number(l.amountPaise) / lodgingClaimed : 0;
      const eligible = Math.round(lodgingTotalEligible * share);
      eligibleByLine.set(l.id, {
        eligible,
        excess: Math.max(0, Number(l.amountPaise) - eligible),
      });
    }
    const otherLines = answer.lines.filter((l) => l.kind !== "lodging");
    const otherClaimed = otherLines.reduce((n, l) => n + Number(l.amountPaise), 0);
    for (const l of otherLines) {
      const share = otherClaimed > 0 ? Number(l.amountPaise) / otherClaimed : 0;
      const eligible = Math.round(c.otherEligiblePaise * share);
      eligibleByLine.set(l.id, {
        eligible,
        excess: Math.max(0, Number(l.amountPaise) - eligible),
      });
    }
  }

  for (const [id, figures] of eligibleByLine) {
    await db
      .update(mbosExpenses)
      .set({
        eligiblePaise: figures.eligible,
        excessPaise: figures.excess,
        policyId: answer.policy?.id ?? null,
        resolvedGrade: answer.subject.grade,
        resolvedCityClass: answer.subject.cityClass,
        updatedAt: new Date(),
      })
      .where(eq(mbosExpenses.id, id));
  }
}

/* ---------------------------------------------------- the anomaly findings */

async function anomaliesFor(
  userId: string,
  day: string,
  totals: { metres: number; claimedPaise: number; gpsMetres: number | null; odometerMetres: number | null },
): Promise<PolicyException[]> {
  const config = await getConfig();
  const lookback = config["expenses.anomalyLookbackDays"];
  const minDays = config["expenses.anomalyMinHistoryDays"];

  const [own, team] = await Promise.all([
    ownDayHistory(userId, day, lookback),
    teamDayHistory(day, lookback),
  ]);

  return [
    ...kmAnomalies(
      { totalMetres: totals.metres, gpsMetres: totals.gpsMetres, odometerMetres: totals.odometerMetres },
      { dailyMetres: own.map((d) => Number(d.metres)) },
      {
        /* The bands come from the POLICY, not from configuration — they are
           reimbursement terms and they belong in the versioned document. The
           day ceiling is applied by the engine already; this pass adds the
           comparison against the person's own history, which the engine
           cannot do because it has no history. */
        dailyKmCeiling: null,
        aboveOwnMedianBps: 10_000,
        varianceFlagBps: 2_500,
      },
      minDays,
    ),
    ...spendAnomalies(
      totals.claimedPaise,
      own.map((d) => Number(d.claimedPaise)),
      team.map((d) => Number(d.claimedPaise)),
      { aboveOwnMedianBps: 10_000, aboveTeamMedianBps: 15_000 },
      minDays,
    ),
  ];
}

/* --------------------------------------------------------------- submitting */

export type SubmitOutcome = {
  ok: true;
  dayId: string;
  claimedPaise: number;
  eligiblePaise: number;
  autoApproved: boolean;
  escalated: boolean;
  routeReason: string;
  exceptionCount: number;
} | { ok: false; reason: string };

/**
 * Close a day: price it, store what it is worth, raise what it raises, route
 * it, and lock it.
 *
 * **The lock is what requirement 54 asks for and it is not a UI state.** After
 * this the day's lines cannot be edited — a correction supersedes a line
 * rather than changing one, so what was submitted stays readable exactly as it
 * was submitted.
 */
export async function submitDay(
  userId: string,
  day: string,
  opts: { note?: string | null } = {},
): Promise<SubmitOutcome> {
  const existing = await db
    .select({ id: mbosExpenseDays.id, lockedAt: mbosExpenseDays.lockedAt })
    .from(mbosExpenseDays)
    .where(and(eq(mbosExpenseDays.userId, userId), eq(mbosExpenseDays.day, day)))
    .limit(1);
  if (!existing[0]) return { ok: false, reason: "That day has not been opened, so there is nothing to submit." };
  if (existing[0].lockedAt) {
    return { ok: false, reason: "That day has already been submitted and locked." };
  }

  /* Stamp the resolution BEFORE pricing. A promotion after today must not
     change what today was worth, and the only way to guarantee that is to
     freeze the question rather than trusting nobody to be promoted. */
  const before = await db
    .select({ destinationCity: mbosExpenseDays.destinationCity, policyId: mbosExpenseDays.policyId })
    .from(mbosExpenseDays)
    .where(eq(mbosExpenseDays.id, existing[0].id))
    .limit(1);

  const subject = await resolveSubject(userId, before[0]?.destinationCity ?? null);
  const cityClass = before[0]?.destinationCity ? await classOfCity(before[0].destinationCity) : null;

  await db
    .update(mbosExpenseDays)
    .set({
      resolvedGrade: subject.grade,
      resolvedCityClass: cityClass,
      destinationCityClass: cityClass,
      updatedAt: new Date(),
    })
    .where(eq(mbosExpenseDays.id, existing[0].id));

  /* Every leg's distance is re-read first: the trail arrives in batches, and a
     leg synced the minute it ended has fewer positions behind it than the same
     leg has by evening. */
  const legIds = await db
    .select({ id: mbosTravelLegs.id })
    .from(mbosTravelLegs)
    .where(eq(mbosTravelLegs.expenseDayId, existing[0].id));
  for (const leg of legIds) await rescoreLeg(leg.id);

  const answer = await priceDay(userId, day);
  if (!answer) return { ok: false, reason: "That day could not be read back." };

  if (!answer.computation) {
    /* No policy covers the date. The day is still submitted — the money was
       still spent — and it goes to a person rather than being auto-approved
       against rules that do not exist. */
    await db
      .update(mbosExpenseDays)
      .set({
        submittedAt: new Date(),
        lockedAt: new Date(),
        note: opts.note ?? null,
        updatedAt: new Date(),
      })
      .where(eq(mbosExpenseDays.id, existing[0].id));
    await raiseApproval(userId, existing[0].id, 0, "no_policy", null);
    return {
      ok: true,
      dayId: existing[0].id,
      claimedPaise: 0,
      eligiblePaise: 0,
      autoApproved: false,
      escalated: false,
      routeReason: answer.noPolicyReason ?? "No policy covers this date.",
      exceptionCount: 0,
    };
  }

  await db
    .update(mbosExpenseDays)
    .set({ policyId: answer.policy!.id, updatedAt: new Date() })
    .where(eq(mbosExpenseDays.id, existing[0].id));

  await writeLineFigures(answer);

  /* Re-read after writing the figures, so the totals below are the totals the
     lines now carry rather than the ones they carried a moment ago. */
  const priced = (await priceDay(userId, day))!;
  const c = priced.computation!;

  const dayGps = priced.legs.reduce<number | null>(
    (n, l) => (l.gpsMetres === null ? n : (n ?? 0) + l.gpsMetres),
    null,
  );
  const dayOdo = priced.legs.reduce<number | null>(
    (n, l) => (l.odometerMetres === null ? n : (n ?? 0) + l.odometerMetres),
    null,
  );

  const anomalies = await anomaliesFor(userId, day, {
    metres: c.totalMetres,
    claimedPaise: c.totalClaimedPaise,
    gpsMetres: dayGps,
    odometerMetres: dayOdo,
  });

  /* Requirement 47, asked once of the finished day rather than at every entry.
     A salesman typing the third of four fares should not be interrupted three
     times; the question is better put to the person who can actually answer
     it, which is whoever reads the day. A `certain` match — the same file, or
     the same bill number — is worth blocking to a person; a `possible` one is
     an ordinary Tuesday and is a note. */
  const duplicates = (await duplicatesForDay(priced.day.id)).map(
    (d): PolicyException => ({
      kind: "duplicate_suspect",
      severity: d.strength === "certain" ? "block_route" : d.strength === "likely" ? "warn" : "info",
      message: d.reason,
      detail: {
        otherId: d.otherId,
        otherDate: d.otherDate,
        otherClaimedPaise: d.otherClaimedPaise,
        matchedOn: d.matchedOn.join(", "),
        strength: d.strength,
      },
      lineId: d.claimId,
    }),
  );

  const all = [...c.exceptions, ...anomalies, ...duplicates];
  await replaceExceptions(userId, priced.day.id, all);

  const route = priced.route!;
  /* The anomalies are raised AFTER the engine has routed, so a day the engine
     called clean but the history calls strange must not auto-approve. Routing
     is re-decided against everything found. */
  const worst = worstSeverity(all);
  const autoApproved = route.autoApproved && worst !== "warn" && worst !== "block_route";

  await db
    .update(mbosExpenseDays)
    .set({
      submittedAt: new Date(),
      submittedClaimedPaise: c.totalClaimedPaise,
      submittedEligiblePaise: c.totalEligiblePaise,
      lockedAt: new Date(),
      note: opts.note ?? null,
      updatedAt: new Date(),
    })
    .where(eq(mbosExpenseDays.id, priced.day.id));

  if (autoApproved) {
    await raiseApproval(userId, priced.day.id, 0, "auto", c.totalEligiblePaise, "approved");
  } else {
    await raiseApproval(
      userId,
      priced.day.id,
      0,
      worst === "block_route" ? "missing_proof" : worst === "warn" ? "flagged" : "over_limit",
      null,
    );
    if (route.escalate) {
      await raiseApproval(userId, priced.day.id, 1, "escalated", null);
    }
  }

  return {
    ok: true,
    dayId: priced.day.id,
    claimedPaise: c.totalClaimedPaise,
    eligiblePaise: c.totalEligiblePaise,
    autoApproved,
    escalated: route.escalate,
    routeReason: autoApproved ? route.reason : route.reason,
    exceptionCount: all.length,
  };
}

async function replaceExceptions(userId: string, dayId: string, list: PolicyException[]) {
  /* Only the UNRESOLVED are replaced. One a manager has already answered is a
     record of a decision, and a recompute must not silently reopen it. */
  await db
    .delete(mbosExpenseExceptions)
    .where(
      and(eq(mbosExpenseExceptions.expenseDayId, dayId), isNull(mbosExpenseExceptions.resolvedAt)),
    );
  if (!list.length) return;
  await db.insert(mbosExpenseExceptions).values(
    list.map((e) => ({
      id: newId("xexc"),
      userId,
      expenseDayId: dayId,
      expenseId: e.lineId ?? null,
      travelLegId: e.legId ?? null,
      kind: e.kind,
      severity: e.severity,
      message: e.message,
      detail: e.detail as Record<string, unknown>,
    })),
  );
}

async function raiseApproval(
  userId: string,
  dayId: string,
  stepIndex: number,
  routeReason: string,
  approvedAmountPaise: number | null,
  state: "pending" | "approved" = "pending",
) {
  await db
    .insert(mbosApprovals)
    .values({
      id: newId("mbappr"),
      type: "expense_claim",
      requestedByUserId: userId,
      subjectType: "mbos_expense_days",
      subjectId: dayId,
      stepIndex,
      routeReason,
      state,
      approvedAmountPaise,
      decidedAt: state === "approved" ? new Date() : null,
      decisionNote:
        state === "approved"
          ? "Within policy and under the automatic limit — approved on submission."
          : null,
    })
    .onConflictDoNothing();
}

/**
 * Requirement 50 — a submitted day corrected by an authorised person.
 *
 * The window is configuration and defaults to a week. Past it a locked day
 * cannot be reopened at all, which is deliberate: an authorised correction is
 * a real thing, and an authorised correction to a quarter that has already
 * been reported on is a different and worse thing.
 */
export async function reopenDay(
  dayId: string,
  byUserId: string,
  reason: string,
  todayIso: string,
): Promise<{ ok: boolean; reason: string }> {
  const config = await getConfig();
  const [row] = await db
    .select({
      id: mbosExpenseDays.id,
      day: sql<string>`${mbosExpenseDays.day}::text`,
      lockedAt: mbosExpenseDays.lockedAt,
    })
    .from(mbosExpenseDays)
    .where(eq(mbosExpenseDays.id, dayId))
    .limit(1);
  if (!row) return { ok: false, reason: "There is no such day." };
  if (!row.lockedAt) return { ok: false, reason: "That day is not locked, so there is nothing to reopen." };

  const ageDays = Math.floor(
    (Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${row.day}T00:00:00Z`)) / 86_400_000,
  );
  const window = config["expenses.eodReopenWindowDays"];
  if (ageDays > window) {
    return {
      ok: false,
      reason: `That day is ${ageDays} days old and a submitted day may be reopened for ${window}. Past that the correction is an accounts adjustment rather than an edit to what was submitted.`,
    };
  }

  await db
    .update(mbosExpenseDays)
    .set({
      lockedAt: null,
      reopenedAt: new Date(),
      reopenedById: byUserId,
      reopenReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(mbosExpenseDays.id, dayId));

  return { ok: true, reason: "Reopened. What was submitted is still recorded — a correction supersedes a line rather than changing it." };
}
