import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { computeDay, type DayComputation, type Policy } from "@/lib/engines/expense-policy";
import { factsFor, legsForDay, linesForDay, readDay } from "./expense-service";
import { draftPolicy, policyForDate, resolveSubject } from "./expense-policy-service";

/* ---------------------------------------------------------------------------
 * §N — what a draft policy would have cost.
 *
 * This is the payoff for keeping the calculator pure. It replays days that
 * really happened through `computeDay` with a DIFFERENT policy and compares
 * the answer to what was actually worked out. Nothing is written, nothing is
 * rewritten, and the facts are untouched — it is a read, and could not be
 * anything else without the engine having I/O in it.
 *
 * Two honesty rules, both of which would otherwise make a simulator flatter a
 * bad policy:
 *
 *   1. **It says how many days it replayed and over what window.** "+₹42,000 a
 *      month" from eleven days of data is not a monthly figure, and a number
 *      with no denominator beside it is the easiest way to be confidently wrong
 *      about what a rate change costs.
 *
 *   2. **Legs and lines the draft cannot price are COUNTED AND NAMED**, never
 *      silently zeroed. A policy that forgot to name a rate for `own_car`
 *      would otherwise simulate as wonderfully cheap, which is exactly
 *      backwards — it is not cheap, it is broken.
 * ------------------------------------------------------------------------- */

export type SimulationRow = {
  userId: string;
  userName: string;
  days: number;
  actualEligiblePaise: number;
  simulatedEligiblePaise: number;
  differencePaise: number;
};

export type Simulation = {
  from: string;
  to: string;
  policyId: string;
  versionNo: number;
  /** How many submitted days were replayed. The denominator for everything. */
  daysReplayed: number;
  /** Calendar days in the window, so "eleven days of data" is visible. */
  windowDays: number;
  actualEligiblePaise: number;
  simulatedEligiblePaise: number;
  differencePaise: number;
  byCategory: {
    travelPaise: number;
    foodPaise: number;
    lodgingPaise: number;
    otherPaise: number;
    actualTravelPaise: number;
    actualFoodPaise: number;
    actualLodgingPaise: number;
    actualOtherPaise: number;
  };
  perSalesman: SimulationRow[];
  /** Modes the draft prices nothing for, with how many legs they cover. */
  unpricedModes: { modeKey: string; legs: number }[];
  /** Days the CURRENT policy could not price either, so the comparison is fair. */
  daysWithoutBaseline: number;
  /** Said in words on the screen. */
  caveats: string[];
};

/**
 * Replay a window of real days through a draft.
 *
 * The comparison is against what the policy IN FORCE on each day says, worked
 * out fresh rather than read from the stored figures — because a stored figure
 * may predate a correction, and a comparison of a fresh number against a stale
 * one attributes the difference to the draft when it belongs to the
 * correction.
 */
export async function simulatePolicy(
  draftId: string,
  from: string,
  to: string,
): Promise<Simulation | { error: string }> {
  const draft = await draftPolicy(draftId);
  if (!draft) return { error: "There is no policy version with that id." };

  const days = await db.execute<{ userId: string; userName: string; day: string }>(sql`
    select d.user_id as "userId", u.name as "userName", d.day::text as day
      from mbos_expense_days d
      join users u on u.id = d.user_id
     where d.submitted_at is not null
       and d.day between ${from}::date and ${to}::date
     order by d.day asc
  `);

  const totals = {
    actual: 0,
    simulated: 0,
    travel: 0,
    food: 0,
    lodging: 0,
    other: 0,
    actualTravel: 0,
    actualFood: 0,
    actualLodging: 0,
    actualOther: 0,
  };
  const perSalesman = new Map<string, SimulationRow>();
  const unpriced = new Map<string, number>();
  let daysWithoutBaseline = 0;

  for (const row of days) {
    const day = await readDay(row.userId, row.day);
    if (!day) continue;
    const [legs, lines] = await Promise.all([legsForDay(day.id), linesForDay(day.id)]);

    /* The stamped resolution, so a promotion since does not change what the
       comparison is about. Falls back to resolving it, for a day submitted
       before the stamping existed. */
    const subject =
      day.policyId !== null
        ? { grade: day.resolvedGrade, cityClass: day.resolvedCityClass }
        : await resolveSubject(row.userId, day.destinationCity).then((s) => ({
            grade: s.grade,
            cityClass: s.cityClass,
          }));

    const facts = factsFor(day, legs, lines);
    const inForce: Policy | null = await policyForDate(row.day);

    const actual: DayComputation | null = inForce
      ? computeDay(inForce, subject, facts)
      : null;
    if (!actual) daysWithoutBaseline++;

    const simulated = computeDay(draft, subject, facts);

    /* A mode the draft never priced, counted off the exception the engine
       already raises for it. Reading `unpricedReason` instead would miss every
       one of them: `computeLeg` returns as soon as it finds no rate, before it
       has chosen a distance, so `chosenMetres` is null on exactly the legs this
       is about — and a condition requiring both is one that can never be true. */
    for (const e of simulated.exceptions) {
      if (e.kind !== "unpriced_mode") continue;
      const modeKey = String(e.detail.modeKey ?? "unknown");
      unpriced.set(modeKey, (unpriced.get(modeKey) ?? 0) + 1);
    }

    totals.actual += actual?.totalEligiblePaise ?? 0;
    totals.simulated += simulated.totalEligiblePaise;
    totals.travel += simulated.travelPaise;
    totals.food += simulated.foodPaise;
    totals.lodging += simulated.lodgingEligiblePaise;
    totals.other += simulated.otherEligiblePaise;
    totals.actualTravel += actual?.travelPaise ?? 0;
    totals.actualFood += actual?.foodPaise ?? 0;
    totals.actualLodging += actual?.lodgingEligiblePaise ?? 0;
    totals.actualOther += actual?.otherEligiblePaise ?? 0;

    const existing = perSalesman.get(row.userId) ?? {
      userId: row.userId,
      userName: row.userName,
      days: 0,
      actualEligiblePaise: 0,
      simulatedEligiblePaise: 0,
      differencePaise: 0,
    };
    existing.days += 1;
    existing.actualEligiblePaise += actual?.totalEligiblePaise ?? 0;
    existing.simulatedEligiblePaise += simulated.totalEligiblePaise;
    existing.differencePaise = existing.simulatedEligiblePaise - existing.actualEligiblePaise;
    perSalesman.set(row.userId, existing);
  }

  const windowDays =
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
    ) + 1;

  const caveats: string[] = [];
  if (days.length === 0) {
    caveats.push(
      "No submitted days fall in this window, so there is nothing to replay. A simulation needs days that actually happened — it cannot invent them.",
    );
  } else {
    caveats.push(
      `Replayed ${days.length} submitted day${days.length === 1 ? "" : "s"} across ${windowDays} calendar days. Every figure below is that window and no more — scaling it to a month is your arithmetic, not this screen's.`,
    );
  }
  if (daysWithoutBaseline > 0) {
    caveats.push(
      `${daysWithoutBaseline} of those days had no policy in force at the time, so they contribute to the draft's total and to nothing to compare it against. The difference is overstated by whatever they are worth.`,
    );
  }
  for (const [modeKey, legs] of unpriced) {
    caveats.push(
      `This draft sets no rate for ${modeKey.replace(/_/g, " ")}, and ${legs} leg${legs === 1 ? "" : "s"} in this window used it. Those are worth nothing under it — which makes the draft look cheaper than it is, rather than being a saving.`,
    );
  }

  return {
    from,
    to,
    policyId: draft.id,
    versionNo: draft.versionNo,
    daysReplayed: days.length,
    windowDays,
    actualEligiblePaise: totals.actual,
    simulatedEligiblePaise: totals.simulated,
    differencePaise: totals.simulated - totals.actual,
    byCategory: {
      travelPaise: totals.travel,
      foodPaise: totals.food,
      lodgingPaise: totals.lodging,
      otherPaise: totals.other,
      actualTravelPaise: totals.actualTravel,
      actualFoodPaise: totals.actualFood,
      actualLodgingPaise: totals.actualLodging,
      actualOtherPaise: totals.actualOther,
    },
    perSalesman: [...perSalesman.values()].sort(
      (a, b) => Math.abs(b.differencePaise) - Math.abs(a.differencePaise),
    ),
    unpricedModes: [...unpriced.entries()].map(([modeKey, legs]) => ({ modeKey, legs })),
    daysWithoutBaseline,
    caveats,
  };
}
