import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  mbosExpenseDays,
  mbosExpenseExceptions,
  mbosExpenses,
  mbosTravelLegs,
} from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { type PolicyException } from "@/lib/engines/expense-policy";
import { kmAnomalies, spendAnomalies } from "@/lib/engines/expense-fraud";
import {
  priceDay,
  ownDayHistory,
  teamDayHistory,
  gpsForLeg,
  duplicatesForDay,
} from "./expense-service";
import { resolveSubject, classOfCity, ensurePolicyRow } from "./expense-policy-service";
import { placeNameSql } from "./place-filter-service";
import { awayFromHometown } from "@/lib/expense-hometown";
import { APP_TIMEZONE } from "@/lib/business-date";

/* ---------------------------------------------------------------------------
 * A day's money, kept current as its records arrive.
 *
 * THERE IS NO CLOSING A DAY ANY MORE, and that is a reversal. A day used to be
 * priced, locked and routed only when the salesman pressed Send day on his
 * phone — and in practice almost nobody did, so a fortnight of travel and
 * claims sat on the server drawn on no screen anybody decides from. Mahek's
 * answer splits the money in two:
 *
 *  - ALLOWANCES are automatic. The meal allowance from his punch-in and
 *    punch-out, and own bike or car kilometres from the trips he logs, are
 *    worked out from the day's records every time one of them arrives, and
 *    need nobody's approval. They are lines this file writes (`source_type`
 *    `expense_day` or `travel_leg`) — see `lib/expense-money-sql.ts`.
 *  - EXPENSES are what he logs himself: a hotel, a food bill, a fare. Each is
 *    its own line with its own `expense_claim` approval, decided one at a time
 *    by his manager the moment it is raised.
 *
 * `refreshDayMoney` is the one function that does the first half, and it also
 * writes what the policy allows on each logged expense and raises the day's
 * flags, because both read the same priced day.
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
  if (answer.policy) await ensurePolicyRow(answer.policy.id);

  /* A trip's KILOMETRE ALLOWANCE is an expense line, so the ledger stays one
     list. Only a trip the policy pays by the kilometre earns one — own bike,
     own car. A fare is not an allowance: it is a bill he logs in Expenses, and
     the trip that carried him is a record of where he went.

     NEVER A ₹0 LINE. A walk, a company vehicle, a trip with no distance yet: a
     zero line reads on every screen as money withheld, so it is not written,
     and one written earlier is taken away when the trip stops earning — a
     trip re-measured, re-moded or excluded.

     Keyed on the trip, so every refresh lands on the same row. */
  const keptLegLines: string[] = [];
  for (const leg of c.legs) {
    const id = `mbos_exp_leg_${leg.legId.slice(-20)}`;
    const row = answer.legs.find((l) => l.id === leg.legId);
    if (leg.paisePerKm === null || leg.eligiblePaise <= 0) {
      await db.delete(mbosExpenses).where(eq(mbosExpenses.id, id));
      continue;
    }
    keptLegLines.push(id);
    const km = leg.chosenMetres != null ? `${(leg.chosenMetres / 1000).toFixed(1)} km` : null;
    const where =
      row?.fromLabel && row?.toLabel
        ? `${row.fromLabel} → ${row.toLabel}`
        : row?.toLabel
          ? `To ${row.toLabel}`
          : null;
    const remarks = [where, km].filter(Boolean).join(" · ") || null;
    await db
      .insert(mbosExpenses)
      .values({
        id,
        userId: answer.day.userId,
        expenseDate: answer.day.day,
        category: "travel",
        kind: "travel",
        sourceType: "travel_leg",
        sourceId: leg.legId,
        expenseDayId: answer.day.id,
        /* An allowance is what the policy pays, so the amount IS the eligible
           figure. Nobody claimed a different number for it to exceed. */
        amountPaise: leg.eligiblePaise,
        eligiblePaise: leg.eligiblePaise,
        excessPaise: 0,
        policyId: answer.policy?.id ?? null,
        resolvedGrade: answer.subject.grade,
        resolvedCityClass: answer.subject.cityClass,
        remarks,
        createdById: answer.day.userId,
        updatedById: answer.day.userId,
      })
      .onConflictDoUpdate({
        target: mbosExpenses.id,
        set: {
          amountPaise: leg.eligiblePaise,
          eligiblePaise: leg.eligiblePaise,
          excessPaise: 0,
          remarks,
          policyId: answer.policy?.id ?? null,
          updatedAt: new Date(),
        },
      });
  }

  /* A trip deleted since the last refresh leaves its allowance behind unless
     somebody takes it away. Only lines this file writes are touched. */
  await db.execute(sql`
    delete from mbos_expenses
     where expense_day_id = ${answer.day.id}
       and source_type = 'travel_leg'
       ${keptLegLines.length ? sql`and id not in (${sql.join(keptLegLines.map((k) => sql`${k}`), sql`, `)})` : sql``}
  `);

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
  for (const l of answer.lines) {
    /* The engine's own answer for the line. A line it did not see (none, in
       practice) is left at nothing rather than handed a share of the day. */
    const eligible = c.lineEligiblePaise[l.id] ?? 0;
    eligibleByLine.set(l.id, { eligible, excess: Math.max(0, Number(l.amountPaise) - eligible) });
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

/**
 * Bring one day's money up to date with its records.
 *
 * Run whenever something about the day arrives from the handset — a punch, a
 * trip, a logged expense, a change to the day itself — and again nightly over
 * the last few days, because the trail that measures a trip arrives in
 * batches and a trip synced the moment it ended has fewer positions behind it
 * than it has by evening.
 *
 * It is idempotent and it decides nothing. It writes the AUTOMATIC lines (the
 * meal allowance and the kilometre allowance on each trip), what the policy
 * allows on each expense he logged, and the day's flags. It never locks the
 * day, never raises or touches an approval, and never changes an amount a
 * person entered — those are his, and his manager's.
 *
 * A day with no record yet is left alone: nothing has happened on it.
 */
/** Where the day went, against his hometown. See `lib/expense-hometown.ts`. */
async function awayOnDay(
  userId: string,
  day: string,
  d: { destinationCity: string | null; overnight: boolean; departedFromHometown: boolean },
): Promise<boolean> {
  const [home] = await db.execute<{ city: string }>(
    sql`select city from expense_hometowns where user_id = ${userId} limit 1`,
  );
  if (!home) return d.departedFromHometown;
  const visits = await db.execute<{ city: string | null }>(sql`
    select ${placeNameSql("c", "city", "city")} as city
      from mbos_visits v
      join customers c on c.id = v.customer_id
     where v.salesman_id = ${userId}
       and v.check_in_at >= (${day}::date)::timestamp at time zone ${APP_TIMEZONE}
       and v.check_in_at < (${day}::date + 1)::timestamp at time zone ${APP_TIMEZONE}
  `);
  return awayFromHometown({
    hometown: home.city,
    visitCities: visits.map((v) => v.city),
    destinationCity: d.destinationCity,
    overnight: d.overnight,
    recorded: d.departedFromHometown,
  });
}

export async function refreshDayMoney(userId: string, day: string): Promise<void> {
  const [existing] = await db
    .select({
      id: mbosExpenseDays.id,
      destinationCity: mbosExpenseDays.destinationCity,
      overnight: mbosExpenseDays.overnight,
      departedFromHometown: mbosExpenseDays.departedFromHometown,
    })
    .from(mbosExpenseDays)
    .where(and(eq(mbosExpenseDays.userId, userId), eq(mbosExpenseDays.day, day)))
    .limit(1);
  if (!existing) return;

  /* Who he is under the policy, stamped on the day so a promotion next month
     does not reprice this one. Re-read each time while the day is current:
     the destination can still change until it is over. */
  /* "Away from his hometown", from where the day actually went — the handset
     cannot know where home is and always says yes. No hometown set leaves the
     recorded answer alone. */
  const away = await awayOnDay(userId, day, existing);
  if (away !== existing.departedFromHometown) {
    await db
      .update(mbosExpenseDays)
      .set({ departedFromHometown: away })
      .where(eq(mbosExpenseDays.id, existing.id));
  }

  const subject = await resolveSubject(userId, existing.destinationCity ?? null);
  const cityClass = existing.destinationCity ? await classOfCity(existing.destinationCity) : null;
  await db
    .update(mbosExpenseDays)
    .set({ resolvedGrade: subject.grade, resolvedCityClass: cityClass, destinationCityClass: cityClass })
    .where(eq(mbosExpenseDays.id, existing.id));

  const legIds = await db
    .select({ id: mbosTravelLegs.id })
    .from(mbosTravelLegs)
    .where(eq(mbosTravelLegs.expenseDayId, existing.id));
  for (const leg of legIds) await rescoreLeg(leg.id);

  const answer = await priceDay(userId, day);
  if (!answer?.computation || !answer.policy) return;

  await ensurePolicyRow(answer.policy.id);
  await db
    .update(mbosExpenseDays)
    .set({ policyId: answer.policy.id })
    .where(eq(mbosExpenseDays.id, existing.id));

  await writeLineFigures(answer);

  /* The flags, against the day as it now stands. Only the unresolved are
     replaced, so an answer a manager already gave survives the refresh. */
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
  /* Requirement 47 — the same bill logged twice. A `certain` match is worth a
     manager's eye before he approves the second one; a `possible` one is a
     note. */
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
  await replaceExceptions(userId, priced.day.id, [...c.exceptions, ...anomalies, ...duplicates]);
}

/**
 * The same refresh, after somebody in the office corrected the evidence under a
 * day — a meter read wrong, a trip re-measured. Kept as its own name because
 * that is what the caller is doing.
 */
export async function repriceDay(userId: string, day: string): Promise<void> {
  await refreshDayMoney(userId, day);
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


async function replaceExceptions(userId: string, dayId: string, list: PolicyException[]) {
  /* Only the UNRESOLVED are replaced. One a manager has already answered is a
     record of a decision, and a refresh must not silently reopen it. */
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
