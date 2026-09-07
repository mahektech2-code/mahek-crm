import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { mbosExpenseDays, mbosTravelModes } from "@/db/schema";
import {
  APP_TIMEZONE,
  asDate,
  localMinutesSince,
  type CalendarDate,
} from "@/lib/business-date";
import {
  computeDay,
  routeDay,
  type DayComputation,
  type DayFacts,
  type ExpenseKind,
  type Policy,
  type PolicySubject,
  type Route,
  type TravelLegFacts,
} from "@/lib/engines/expense-policy";
import { gpsDistanceForLeg, type Fix, type TrailOptions } from "@/lib/engines/travel-distance";
import { duplicateCandidates, type ClaimFacts } from "@/lib/engines/expense-fraud";
import { getConfig } from "@/lib/config/store";
import { policyForDate, resolveSubject } from "./expense-policy-service";

/* ---------------------------------------------------------------------------
 * A day of expenses, and what it is worth.
 *
 * The engine decides every rupee; this file's whole job is to hand it facts
 * and to write down what it said. Nothing here does arithmetic on money, and
 * nothing here reads a rate — if a number appears in this file that a manager
 * might one day want to change, it is in the wrong place.
 *
 * **The eligible figure is DERIVED on read, not cached.** A published policy
 * version cannot be edited and the resolution is stamped on the day, so
 * re-deriving is stable forever — which makes a cache pure risk. What IS
 * stored is what was submitted, and that is a record rather than a cache: it
 * says what the salesman was told on the day he pressed submit.
 * ------------------------------------------------------------------------- */

export type LegRow = {
  id: string;
  modeKey: string;
  modeLabel: string | null;
  fromLabel: string | null;
  toLabel: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  purpose: string | null;
  customerId: string | null;
  customerName: string | null;
  visitId: string | null;
  gpsMetres: number | null;
  gpsMethod: string | null;
  gpsCoveragePct: number | null;
  gpsReason: string | null;
  manualMetres: number | null;
  odometerStartKm: number | null;
  odometerEndKm: number | null;
  odometerMetres: number | null;
  odometerPhotoId: string | null;
  chosenMetres: number | null;
  chosenSource: string | null;
  varianceBps: number | null;
  ticketAmountPaise: number | null;
  ticketPhotoId: string | null;
  ticketReference: string | null;
  note: string | null;
};

export type LineRow = {
  id: string;
  kind: string;
  category: string;
  amountPaise: number;
  eligiblePaise: number | null;
  excessPaise: number | null;
  billPhotoId: string | null;
  remarks: string | null;
  vendorName: string | null;
  billNumber: string | null;
  exceptionReason: string | null;
  expenseDate: string;
  /** Lodging only. */
  nights: number | null;
};

export type DayRow = {
  id: string;
  userId: string;
  userName: string;
  day: string;
  departedAt: Date | null;
  returnedAt: Date | null;
  departedFromHometown: boolean;
  destinationCity: string | null;
  destinationCityClass: string | null;
  arrivedAtDestinationAt: Date | null;
  arrivalObservedAt: Date | null;
  overnight: boolean;
  stayedInHotel: boolean;
  odometerPhotoDemanded: boolean;
  policyId: string | null;
  resolvedGrade: string | null;
  resolvedCityClass: string | null;
  submittedAt: Date | null;
  submittedClaimedPaise: number | null;
  submittedEligiblePaise: number | null;
  lockedAt: Date | null;
  reopenedAt: Date | null;
  reopenReason: string | null;
  note: string | null;
};

/* -------------------------------------------------------------- the reads */

export async function readDay(userId: string, day: string): Promise<DayRow | null> {
  const rows = await db.execute<DayRow>(sql`
    select d.id, d.user_id as "userId", u.name as "userName", d.day::text as day,
           d.departed_at as "departedAt", d.returned_at as "returnedAt",
           d.departed_from_hometown as "departedFromHometown",
           d.destination_city as "destinationCity",
           d.destination_city_class as "destinationCityClass",
           d.arrived_at_destination_at as "arrivedAtDestinationAt",
           d.arrival_observed_at as "arrivalObservedAt",
           d.overnight, d.stayed_in_hotel as "stayedInHotel",
           d.odometer_photo_demanded as "odometerPhotoDemanded",
           d.policy_id as "policyId", d.resolved_grade as "resolvedGrade",
           d.resolved_city_class as "resolvedCityClass",
           d.submitted_at as "submittedAt",
           d.submitted_claimed_paise as "submittedClaimedPaise",
           d.submitted_eligible_paise as "submittedEligiblePaise",
           d.locked_at as "lockedAt", d.reopened_at as "reopenedAt",
           d.reopen_reason as "reopenReason", d.note
      from mbos_expense_days d
      join users u on u.id = d.user_id
     where d.user_id = ${userId} and d.day = ${day}::date
     limit 1
  `);
  return rows[0] ?? null;
}

export async function legsForDay(dayId: string): Promise<LegRow[]> {
  return db.execute<LegRow>(sql`
    select l.id, l.mode_key as "modeKey", m.label as "modeLabel",
           l.from_label as "fromLabel", l.to_label as "toLabel",
           l.started_at as "startedAt", l.ended_at as "endedAt",
           l.purpose, l.customer_id as "customerId", c.name as "customerName",
           l.visit_id as "visitId",
           l.gps_metres as "gpsMetres", l.gps_method as "gpsMethod",
           l.gps_coverage_pct as "gpsCoveragePct", l.gps_reason as "gpsReason",
           l.manual_metres as "manualMetres",
           l.odometer_start_km as "odometerStartKm", l.odometer_end_km as "odometerEndKm",
           l.odometer_metres as "odometerMetres", l.odometer_photo_id as "odometerPhotoId",
           l.chosen_metres as "chosenMetres", l.chosen_source as "chosenSource",
           l.variance_bps as "varianceBps",
           l.ticket_amount_paise as "ticketAmountPaise",
           l.ticket_photo_id as "ticketPhotoId", l.ticket_reference as "ticketReference",
           l.note
      from mbos_travel_legs l
      left join mbos_travel_modes m on m.key = l.mode_key
      left join customers c on c.id = l.customer_id
     where l.expense_day_id = ${dayId}
     order by l.started_at asc nulls last, l.id asc
  `);
}

/**
 * The lines somebody TYPED — a hotel bill, a rickshaw fare.
 *
 * **Deliberately not the lines the policy produced.** Submitting a day writes
 * the travel and the meal allowance into `mbos_expenses` so that the ledger is
 * one list and a manager reads one table. Those rows are OUTPUTS of the
 * engine, and feeding them back in as inputs does two wrong things at once:
 * the day's food is counted a second time as an "other" claim, and the meal
 * allowance — which is computed, and can never have a receipt — is asked for
 * one and blocks the day for want of it.
 *
 * So the engine sees only what a person entered. `source_type` is what tells
 * them apart, and it is set on every row this module writes.
 */
export async function linesForDay(dayId: string): Promise<LineRow[]> {
  return db.execute<LineRow>(sql`
    select e.id, coalesce(e.kind, e.category::text) as kind, e.category::text as category,
           e.amount_paise as "amountPaise", e.eligible_paise as "eligiblePaise",
           e.excess_paise as "excessPaise", e.bill_photo_id as "billPhotoId",
           e.remarks, e.vendor_name as "vendorName", e.bill_number as "billNumber",
           e.exception_reason as "exceptionReason", e.expense_date::text as "expenseDate",
           null::int as nights
      from mbos_expenses e
     where e.expense_day_id = ${dayId}
       and e.superseded_by_id is null
       and coalesce(e.source_type, 'manual') = 'manual'
     order by e.server_created_at asc
  `);
}

/* ------------------------------------------------------- facts -> engine */

/**
 * A stored day as the facts the engine takes.
 *
 * The ONE place a timestamp becomes a wall clock. `localMinutesSince` names
 * `APP_TIMEZONE`; everything downstream sees an integer and therefore cannot
 * get the zone wrong. Doing this inside the engine would have made the engine
 * impure, and doing it at each screen would have made it wrong in a different
 * place each time.
 */
export function factsFor(day: DayRow, legs: LegRow[], lines: LineRow[]): DayFacts {
  const on = day.day as CalendarDate;
  /* These rows come from `db.execute`, so a timestamptz arrives as a STRING
     however the type reads. `asDate` is the one place that is reconciled. */
  const mins = (at: unknown) => {
    const instant = asDate(at);
    return instant === null ? null : localMinutesSince(on, instant);
  };

  return {
    day: day.day,
    clock: {
      departedMinutes: mins(day.departedAt),
      returnedMinutes: mins(day.returnedAt),
      arrivedAtDestinationMinutes: mins(day.arrivedAtDestinationAt),
    },
    departedFromHometown: day.departedFromHometown,
    stayedInHotel: day.stayedInHotel,
    overnight: day.overnight,
    legs: legs.map(
      (l): TravelLegFacts => ({
        id: l.id,
        modeKey: l.modeKey,
        gpsMetres: l.gpsMetres,
        gpsCoveragePct: l.gpsCoveragePct,
        manualMetres: l.manualMetres,
        /* Derived from the two READINGS rather than read from the column.
           `odometer_metres` is a cache written when the day is submitted, and
           a day that has not been submitted yet still has to price correctly —
           on the travel ledger, on the handset, and in the summary somebody
           checks before pressing send. A backwards pair is null rather than an
           absolute value: an end below a start is a typo, and taking its
           magnitude turns a typo into a payable distance. */
        odometerMetres:
          l.odometerStartKm !== null &&
          l.odometerEndKm !== null &&
          l.odometerEndKm >= l.odometerStartKm
            ? (l.odometerEndKm - l.odometerStartKm) * 1000
            : l.odometerMetres,
        hasOdometerPhoto: l.odometerPhotoId !== null,
        ticketAmountPaise: l.ticketAmountPaise,
        hasTicketProof: l.ticketPhotoId !== null,
        odometerPhotoDemanded: day.odometerPhotoDemanded,
      }),
    ),
    lines: lines.map((l) => ({
      id: l.id,
      kind: (l.kind as ExpenseKind) ?? "other",
      claimedPaise: Number(l.amountPaise),
      hasProof: l.billPhotoId !== null,
      nights: l.nights ?? (l.kind === "lodging" ? 1 : undefined),
    })),
  };
}

export type DayAnswer = {
  day: DayRow;
  legs: LegRow[];
  lines: LineRow[];
  computation: DayComputation | null;
  route: Route | null;
  subject: PolicySubject;
  /** Null where no published policy covers this date. */
  policy: Policy | null;
  /** Said in words wherever the answer could not be worked out. */
  noPolicyReason: string | null;
};

/**
 * A whole day, priced.
 *
 * **No policy is an ANSWER, not an error.** A deployment mid-rollout has days
 * before its first published version, and the honest response is to show the
 * claims with no eligible figure and say why — not a screen of zeroes that
 * reads as "the company allows you nothing".
 */
export async function priceDay(userId: string, day: string): Promise<DayAnswer | null> {
  const row = await readDay(userId, day);
  if (!row) return null;

  const [legs, lines] = await Promise.all([legsForDay(row.id), linesForDay(row.id)]);

  /* The STAMPED resolution wins where there is one. A person promoted since
     must not have last year's claims silently repriced. */
  const subject: PolicySubject =
    row.policyId !== null
      ? { grade: row.resolvedGrade, cityClass: row.resolvedCityClass }
      : await resolveSubject(userId, row.destinationCity).then((s) => ({
          grade: s.grade,
          cityClass: s.cityClass,
        }));

  const policy = await policyForDate(day);
  if (!policy) {
    return {
      day: row,
      legs,
      lines,
      computation: null,
      route: null,
      subject,
      policy: null,
      noPolicyReason: `No expense policy is in force on ${day}, so nothing here has an eligible amount yet. The claims are recorded and will be worked out as soon as a policy covering that date is published.`,
    };
  }

  const computation = computeDay(policy, subject, factsFor(row, legs, lines));
  return {
    day: row,
    legs,
    lines,
    computation,
    route: routeDay(policy, subject, computation),
    subject,
    policy,
    noPolicyReason: null,
  };
}

/* ------------------------------------------------------- GPS for one leg */

export async function trailOptions(): Promise<TrailOptions> {
  const config = await getConfig();
  return {
    maxAccuracyM: config["mbos.location.gpsAccuracyThresholdM"],
    expectedFixEveryMinutes: config["mbos.location.trackEveryMinutes"],
    roadFactorBps: config["expenses.gpsRoadFactorBps"],
    minCoveragePct: config["expenses.gpsMinCoveragePct"],
  };
}

/**
 * The GPS distance for one leg, from the day's own trail.
 *
 * Reads `mbos_positions`, which is the stream the handset posts while somebody
 * is checked in. Where the trail did not cover the leg the answer is a
 * LABELLED estimate from the two endpoints, or null with a reason — never a
 * straight line quietly returned as though it were the track.
 */
export async function gpsForLeg(leg: {
  userId: string;
  startedAt: unknown;
  endedAt: unknown;
  fromLat: number | null;
  fromLng: number | null;
  toLat: number | null;
  toLng: number | null;
}) {
  const opts = await trailOptions();
  /* The leg was read with `db.execute`, so these arrived as strings whatever
     the type says. And never bind a Date into a raw query either — that is the
     rule this codebase has paid for three times, in `handleOrder`,
     `handleVisit` and the sync cursor. Both hazards, one `asDate`. */
  const startedAt = asDate(leg.startedAt);
  const endedAt = asDate(leg.endedAt);

  let fixes: Fix[] = [];
  if (startedAt && endedAt) {
    fixes = await db.execute<Fix>(sql`
      select extract(epoch from p.at) * 1000 as at, p.lat, p.lng,
             p.accuracy_m as "accuracyM"
        from mbos_positions p
       where p.user_id = ${leg.userId}
         and p.at >= ${startedAt.toISOString()}::timestamptz
         and p.at <= ${endedAt.toISOString()}::timestamptz
       order by p.at asc
    `);
  }
  return gpsDistanceForLeg(
    fixes.map((f) => ({ ...f, at: Number(f.at) })),
    {
      startedAt: startedAt ? startedAt.getTime() : null,
      endedAt: endedAt ? endedAt.getTime() : null,
      from: leg.fromLat !== null && leg.fromLng !== null ? { lat: leg.fromLat, lng: leg.fromLng } : null,
      to: leg.toLat !== null && leg.toLng !== null ? { lat: leg.toLat, lng: leg.toLng } : null,
    },
    opts,
  );
}

/* ------------------------------------------------------- the manager views */

export type TravelLedgerRow = LegRow & {
  userId: string;
  userName: string;
  day: string;
  eligiblePaise: number | null;
};

/**
 * Requirement 25 — every movement, with all three distances side by side.
 *
 * The three are shown together deliberately. A ledger printing only what was
 * paid on cannot answer requirement 19's question, and the manager reading it
 * is exactly the person who needs to see that the odometer said 60 km on a leg
 * the phone measured at 6.
 */
export async function travelLedger(from: string, to: string, userId?: string): Promise<TravelLedgerRow[]> {
  return db.execute<TravelLedgerRow>(sql`
    select l.id, l.user_id as "userId", u.name as "userName",
           d.day::text as day,
           l.mode_key as "modeKey", m.label as "modeLabel",
           l.from_label as "fromLabel", l.to_label as "toLabel",
           l.started_at as "startedAt", l.ended_at as "endedAt",
           l.purpose, l.customer_id as "customerId", c.name as "customerName",
           l.visit_id as "visitId",
           l.gps_metres as "gpsMetres", l.gps_method as "gpsMethod",
           l.gps_coverage_pct as "gpsCoveragePct", l.gps_reason as "gpsReason",
           l.manual_metres as "manualMetres",
           l.odometer_start_km as "odometerStartKm", l.odometer_end_km as "odometerEndKm",
           l.odometer_metres as "odometerMetres", l.odometer_photo_id as "odometerPhotoId",
           l.chosen_metres as "chosenMetres", l.chosen_source as "chosenSource",
           l.variance_bps as "varianceBps",
           l.ticket_amount_paise as "ticketAmountPaise",
           l.ticket_photo_id as "ticketPhotoId", l.ticket_reference as "ticketReference",
           l.note,
           (select e.eligible_paise from mbos_expenses e
             where e.source_type = 'travel_leg' and e.source_id = l.id
             limit 1) as "eligiblePaise"
      from mbos_travel_legs l
      join users u on u.id = l.user_id
      left join mbos_expense_days d on d.id = l.expense_day_id
      left join mbos_travel_modes m on m.key = l.mode_key
      left join customers c on c.id = l.customer_id
     where coalesce(d.day, (l.started_at at time zone ${APP_TIMEZONE})::date)
           between ${from}::date and ${to}::date
       ${userId ? sql`and l.user_id = ${userId}` : sql``}
     order by d.day desc nulls last, l.started_at asc nulls last
  `);
}

export type ExceptionRow = {
  id: string;
  userId: string;
  userName: string;
  day: string | null;
  expenseDayId: string | null;
  kind: string;
  severity: string;
  message: string;
  detail: Record<string, unknown>;
  salesmanReason: string | null;
  raisedAt: Date;
  resolvedAt: Date | null;
  resolvedByName: string | null;
  resolution: string | null;
  resolutionNote: string | null;
};

/** Requirement 69's worklist. Worst first, and open by default. */
export async function listExceptions(opts: {
  openOnly?: boolean;
  userId?: string;
  limit?: number;
} = {}): Promise<ExceptionRow[]> {
  const { openOnly = true, userId, limit = 200 } = opts;
  return db.execute<ExceptionRow>(sql`
    select x.id, x.user_id as "userId", u.name as "userName",
           d.day::text as day, x.expense_day_id as "expenseDayId",
           x.kind, x.severity, x.message, x.detail,
           x.salesman_reason as "salesmanReason",
           x.raised_at as "raisedAt", x.resolved_at as "resolvedAt",
           r.name as "resolvedByName", x.resolution, x.resolution_note as "resolutionNote"
      from mbos_expense_exceptions x
      join users u on u.id = x.user_id
      left join users r on r.id = x.resolved_by_id
      left join mbos_expense_days d on d.id = x.expense_day_id
     where 1 = 1
       ${openOnly ? sql`and x.resolved_at is null` : sql``}
       ${userId ? sql`and x.user_id = ${userId}` : sql``}
     order by case x.severity when 'block_route' then 0 when 'warn' then 1 else 2 end,
              x.raised_at desc
     limit ${limit}
  `);
}

/** Every travel mode a handset may offer. Read, never hardcoded. */
export async function travelModes() {
  return db
    .select()
    .from(mbosTravelModes)
    .where(eq(mbosTravelModes.active, true))
    .orderBy(asc(mbosTravelModes.sortOrder));
}

/* ------------------------------------------------------- the daily summary */

export type DaySummaryRow = {
  id: string;
  userId: string;
  userName: string;
  day: string;
  visitCount: number;
  legCount: number;
  metres: number;
  claimedPaise: number;
  submittedAt: Date | null;
  lockedAt: Date | null;
  openExceptions: number;
};

/** Requirement 52, for a list of days rather than one. */
export async function daySummaries(from: string, to: string, userId?: string): Promise<DaySummaryRow[]> {
  return db.execute<DaySummaryRow>(sql`
    select d.id, d.user_id as "userId", u.name as "userName", d.day::text as day,
           (select count(*)::int from mbos_visits v
             where v.salesman_id = d.user_id
               and (v.check_in_at at time zone ${APP_TIMEZONE})::date = d.day) as "visitCount",
           (select count(*)::int from mbos_travel_legs l where l.expense_day_id = d.id) as "legCount",
           coalesce((select sum(l.chosen_metres)::int from mbos_travel_legs l
                      where l.expense_day_id = d.id), 0) as metres,
           coalesce((select sum(e.amount_paise) from mbos_expenses e
                      where e.expense_day_id = d.id and e.superseded_by_id is null), 0)
             as "claimedPaise",
           d.submitted_at as "submittedAt", d.locked_at as "lockedAt",
           (select count(*)::int from mbos_expense_exceptions x
             where x.expense_day_id = d.id and x.resolved_at is null) as "openExceptions"
      from mbos_expense_days d
      join users u on u.id = d.user_id
     where d.day between ${from}::date and ${to}::date
       ${userId ? sql`and d.user_id = ${userId}` : sql``}
     order by d.day desc, u.name asc
  `);
}

/** A day row, created on first touch. The handset opens a day by writing one. */
export async function ensureDay(
  userId: string,
  day: string,
  deviceId: string | null,
): Promise<string> {
  const existing = await db
    .select({ id: mbosExpenseDays.id })
    .from(mbosExpenseDays)
    .where(and(eq(mbosExpenseDays.userId, userId), eq(mbosExpenseDays.day, day)))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const id = `mbos_expday_${userId.slice(-6)}_${day}`;
  await db
    .insert(mbosExpenseDays)
    .values({ id, userId, day, deviceId, createdById: userId, updatedById: userId })
    .onConflictDoNothing();

  const [row] = await db
    .select({ id: mbosExpenseDays.id })
    .from(mbosExpenseDays)
    .where(and(eq(mbosExpenseDays.userId, userId), eq(mbosExpenseDays.day, day)))
    .limit(1);
  return row!.id;
}

/** Recent days of this person, for the anomaly bands. Excludes the day itself. */
export async function ownDayHistory(userId: string, day: string, lookbackDays: number) {
  return db.execute<{ metres: number; claimedPaise: number }>(sql`
    select coalesce(sum(l.chosen_metres), 0)::int as metres,
           coalesce((select sum(e.amount_paise) from mbos_expenses e
                      where e.expense_day_id = d.id and e.superseded_by_id is null), 0)
             as "claimedPaise"
      from mbos_expense_days d
      left join mbos_travel_legs l on l.expense_day_id = d.id
     where d.user_id = ${userId}
       and d.day < ${day}::date
       and d.day >= (${day}::date - ${lookbackDays}::int)
     group by d.id
  `);
}

/** The team's recent days, for the second comparison. */
export async function teamDayHistory(day: string, lookbackDays: number) {
  return db.execute<{ claimedPaise: number }>(sql`
    select coalesce(sum(e.amount_paise), 0) as "claimedPaise"
      from mbos_expense_days d
      join mbos_expenses e on e.expense_day_id = d.id and e.superseded_by_id is null
     where d.day < ${day}::date
       and d.day >= (${day}::date - ${lookbackDays}::int)
     group by d.id
  `);
}

/* ------------------------------------------------------- §I47 duplicates */

/**
 * Recent claims of one person, in the shape the duplicate engine reads.
 *
 * The bill hash is JOINED from the attachment rather than stored on the claim:
 * a hash is a property of the file, and one photograph attached to two claims
 * has to give both the same answer. Storing it twice is how the two come to
 * disagree.
 *
 * A ticket reference from the travel leg rides along too — a PNR names one
 * journey as firmly as a bill number names one bill.
 */
export async function recentClaims(
  userId: string,
  onDate: string,
  windowDays: number,
): Promise<ClaimFacts[]> {
  return db.execute<ClaimFacts>(sql`
    select e.id, e.user_id as "userId", e.expense_date::text as "expenseDate",
           coalesce(e.kind, e.category::text) as kind,
           e.amount_paise as "claimedPaise", e.vendor_name as "vendorName",
           e.bill_number as "billNumber",
           coalesce(e.bill_hash, a.content_hash) as "billHash",
           l.ticket_reference as reference
      from mbos_expenses e
      left join attachments a on a.id = e.bill_photo_id
      left join mbos_travel_legs l
             on e.source_type = 'travel_leg' and l.id = e.source_id
     where e.user_id = ${userId}
       and e.superseded_by_id is null
       and e.expense_date between (${onDate}::date - ${windowDays}::int)
                              and (${onDate}::date + ${windowDays}::int)
  `);
}

export type DuplicateWarning = {
  otherId: string;
  strength: "certain" | "likely" | "possible";
  reason: string;
  matchedOn: readonly string[];
  /** So the screen can show what it is pointing at rather than an id. */
  otherDate: string;
  otherClaimedPaise: number;
  otherKind: string;
};

/**
 * Whether this claim looks like one already recorded.
 *
 * **A suggestion, never a gate**, and that is the rule `receipt-match.ts`
 * settled for payments: a gate in front of the ordinary case is a gate people
 * learn to click through, and two ₹250 auto fares in a week is an ordinary
 * week. Nothing here refuses a save. It hands back a sentence and lets a
 * person answer it.
 *
 * The claim being checked is excluded by id, so re-opening an existing claim
 * does not match it against itself.
 */
export async function duplicateWarnings(claim: {
  id: string;
  userId: string;
  expenseDate: string;
  kind: string;
  claimedPaise: number;
  vendorName: string | null;
  billNumber: string | null;
  billHash: string | null;
  reference: string | null;
}): Promise<DuplicateWarning[]> {
  const config = await getConfig();
  const windowDays = config["expenses.duplicateWindowDays"];
  const history = await recentClaims(claim.userId, claim.expenseDate, windowDays);

  const candidates = duplicateCandidates(claim, history, {
    windowDays,
    nearAmountBps: 500,
  });
  if (!candidates.length) return [];

  const byId = new Map(history.map((h) => [h.id, h]));
  return candidates
    .map((c) => {
      const other = byId.get(c.otherId);
      if (!other) return null;
      return {
        otherId: c.otherId,
        strength: c.strength,
        reason: c.reason,
        matchedOn: c.matchedOn,
        otherDate: other.expenseDate,
        otherClaimedPaise: Number(other.claimedPaise),
        otherKind: other.kind,
      };
    })
    .filter((x): x is DuplicateWarning => x !== null);
}

/**
 * The duplicates across a whole day, for the screen a manager reads.
 *
 * Run at submission rather than at entry for the day's own lines, because a
 * salesman entering the third of four fares should not be interrupted three
 * times — the question is better asked once, of the finished day, by the
 * person who can answer it.
 */
export async function duplicatesForDay(dayId: string): Promise<
  Array<DuplicateWarning & { claimId: string; claimedPaise: number }>
> {
  const claims = await db.execute<ClaimFacts>(sql`
    select e.id, e.user_id as "userId", e.expense_date::text as "expenseDate",
           coalesce(e.kind, e.category::text) as kind,
           e.amount_paise as "claimedPaise", e.vendor_name as "vendorName",
           e.bill_number as "billNumber",
           coalesce(e.bill_hash, a.content_hash) as "billHash",
           l.ticket_reference as reference
      from mbos_expenses e
      left join attachments a on a.id = e.bill_photo_id
      left join mbos_travel_legs l
             on e.source_type = 'travel_leg' and l.id = e.source_id
     where e.expense_day_id = ${dayId} and e.superseded_by_id is null
  `);

  const out: Array<DuplicateWarning & { claimId: string; claimedPaise: number }> = [];
  for (const claim of claims) {
    const warnings = await duplicateWarnings({
      ...claim,
      claimedPaise: Number(claim.claimedPaise),
    });
    for (const w of warnings) {
      out.push({ ...w, claimId: claim.id, claimedPaise: Number(claim.claimedPaise) });
    }
  }
  return out;
}
