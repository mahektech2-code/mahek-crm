import "server-only";
import { sql } from "drizzle-orm";
import { holidayAppliesSql } from "@/lib/holiday-sql";
import { db } from "@/db";
import { APP_TIMEZONE } from "../business-date";
import { managerScope, onlyMine } from "./sales-service";
import { placeNameSql } from "./place-filter-service";

const IST = sql.raw(`at time zone '${APP_TIMEZONE}'`);

/* ---------------------------------------------------------------------------
 * EVERYTHING AROUND A PLANNED DAY that is not the plan itself.
 *
 * Journeys & visits draws one salesman's days as a calendar, and a calendar
 * that shows only the route is one that lies by omission: a blank Tuesday is a
 * day nobody planned, a day he was on approved leave, a public holiday or a
 * day he punched in and worked anyway, and those are four different
 * conversations. These reads are the other three, plus the day's history and
 * the team-wide summary the overview tab is drawn from.
 *
 * Every read is narrowed by `managerScope`, the same narrowing every other
 * Sales Dashboard list goes through.
 * ------------------------------------------------------------------------- */

export type CalendarAttendance = {
  day: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  withinGeofence: boolean | null;
  workedSeconds: number | null;
  /** Closed by the nightly job rather than by him. */
  autoCheckedOut: boolean;
};

export type CalendarLeave = {
  id: string;
  fromDate: string;
  toDate: string;
  leaveType: string;
  halfDay: boolean;
  reason: string | null;
  /** `pending`, `approved`, `rejected`, or `cancelled`. */
  state: string;
};

export type CalendarTour = {
  id: string;
  startDate: string;
  endDate: string;
  cities: string[];
  purpose: string | null;
  state: string;
};

export type CalendarHoliday = { onDate: string; name: string };

export type CalendarFacts = {
  attendance: CalendarAttendance[];
  leave: CalendarLeave[];
  tours: CalendarTour[];
  holidays: CalendarHoliday[];
};

/** Punch-ins, leave, tours and holidays for one salesman over a window. */
export async function calendarFacts(
  userId: string,
  from: string,
  to: string,
): Promise<CalendarFacts> {
  const scope = await managerScope();
  const mine = onlyMine(scope, "x.user_id");

  const [attendance, leave, tours, holidays] = await Promise.all([
    db.execute(sql`
      select x.day::text as day, x.auto_checked_out as "autoCheckedOut", x.check_in_at as "checkInAt", x.check_out_at as "checkOutAt",
             x.within_geofence as "withinGeofence", x.worked_seconds as "workedSeconds"
        from mbos_attendance_days x
       where x.user_id = ${userId} and x.day between ${from}::date and ${to}::date ${mine}
       order by x.day
    `),
    db.execute(sql`
      select x.id, x.from_date::text as "fromDate", x.to_date::text as "toDate",
             x.leave_type::text as "leaveType", x.half_day as "halfDay", x.reason,
             case when x.cancelled_at is not null then 'cancelled'
                  else coalesce((select ap.state::text from mbos_approvals ap
                                  where ap.subject_id = x.id and ap.type = 'leave'
                                  order by ap.requested_at desc limit 1), 'pending') end as state
        from mbos_leave_requests x
       where x.user_id = ${userId}
         and x.from_date <= ${to}::date and x.to_date >= ${from}::date ${mine}
       order by x.from_date
    `),
    db.execute(sql`
      select x.id, x.start_date::text as "startDate", x.end_date::text as "endDate",
             x.cities, x.purpose,
             coalesce((select ap.state::text from mbos_approvals ap
                        where ap.subject_id = x.id and ap.type = 'tour'
                        order by ap.requested_at desc limit 1), 'pending') as state
        from mbos_tours x
       where x.user_id = ${userId}
         and x.start_date <= ${to}::date and x.end_date >= ${from}::date ${mine}
       order by x.start_date
    `),
    db.execute(sql`
      select h.on_date::text as "onDate", h.name
        from mbos_holidays h
       where h.on_date between ${from}::date and ${to}::date
         and ${holidayAppliesSql("h", sql`${userId}`)}
       order by h.on_date
    `),
  ]);

  return {
    attendance: attendance as unknown as CalendarAttendance[],
    leave: leave as unknown as CalendarLeave[],
    tours: tours as unknown as CalendarTour[],
    holidays: holidays as unknown as CalendarHoliday[],
  };
}

/* ------------------------------------------------------------ the history */

export type JourneyEvent = {
  id: string;
  at: string;
  action: string;
  actorName: string | null;
  /** The plan it names, or null for an office act covering a run of days. */
  planId: string | null;
  /** For a run-of-days act: the first and last day it covered. */
  from: string | null;
  to: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

/**
 * What was said about these days, oldest first.
 *
 * A plan row holds only the LATEST answer — a fresh proposal clears the last
 * refusal — so the conversation lives in the audit log: his answers from the
 * handset, the office taking his counter-city or proposing again, and the two
 * run-of-days acts (proposing a period, arranging shops from the office),
 * which are filed against the salesman with the dates they covered.
 */
export async function journeyHistory(
  userId: string,
  planIds: string[],
  from: string,
  to: string,
): Promise<JourneyEvent[]> {
  const scope = await managerScope();
  const ids = planIds.length ? planIds : ["-"];
  const rows = await db.execute(sql`
    select a.id, a.at, a.action, u.name as "actorName",
           case when a.entity_id = ${userId} then null else a.entity_id end as "planId",
           a.after_state->>'from' as "from", a.after_state->>'to' as "to",
           a.before_state as "before", a.after_state as "after"
      from audit_log a
      left join users u on u.id = a.actor_id
     where a.entity_type = 'mbos_journey_plan'
       and (
         a.entity_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
         or (a.entity_id = ${userId}
             and a.action in ('mbos.journey.propose', 'mbos.journey.period')
             and coalesce(a.after_state->>'from', '') <= ${to}
             and coalesce(a.after_state->>'to', a.after_state->>'from', '') >= ${from})
       )
       and exists (select 1 from users me where me.id = ${userId} ${onlyMine(scope, "me.id")})
     order by a.at asc
     limit 600
  `);
  return rows as unknown as JourneyEvent[];
}

/* -------------------------------------------------------- the team summary */

export type TeamPlanDay = {
  userId: string;
  planDate: string;
  dayState: "proposed" | "refused" | "agreed" | "planned";
  city: string | null;
  /** The stops' cities, most shops first — see `dayWhere`. */
  shopCities: string[];
  selfPlanned: boolean;
  refusalReason: string | null;
  counterCity: string | null;
  planId: string;
  stops: number;
  visited: number;
  skipped: number;
};

export type TeamVisitDay = {
  userId: string;
  day: string;
  visits: number;
  offPlan: number;
  unverified: number;
};

export type TeamLeaveDay = {
  userId: string;
  fromDate: string;
  toDate: string;
  state: string;
};

export type TeamJourneySummary = {
  plans: TeamPlanDay[];
  visits: TeamVisitDay[];
  leave: TeamLeaveDay[];
  holidays: CalendarHoliday[];
};

/**
 * Every salesman's days over a window, light enough for a team table: one row
 * per planned day with its stop counts, one per visited day with its visit
 * counts. Never the stops themselves — those are the calendar's.
 */
export async function teamJourneySummary(
  from: string,
  to: string,
): Promise<TeamJourneySummary> {
  const scope = await managerScope();
  const [plans, visits, leave, holidays] = await Promise.all([
    db.execute(sql`
      select p.user_id as "userId", p.plan_date::text as "planDate",
             p.day_state::text as "dayState", p.city, p.self_planned as "selfPlanned",
             p.refusal_reason as "refusalReason", p.counter_city as "counterCity",
             p.id as "planId",
             coalesce((
               select array_agg(x.city order by x.n desc, x.city)
                 from (select ${placeNameSql("c", "city", "city")} as city, count(*) as n
                         from mbos_journey_stops s2
                         join customers c on c.id = s2.customer_id
                        where s2.plan_id = p.id
                        group by 1) x
                where x.city is not null
             ), '{}') as "shopCities",
             count(s.id)::int as stops,
             count(s.id) filter (where s.status = 'visited')::int as visited,
             count(s.id) filter (where s.status = 'skipped')::int as skipped
        from mbos_journey_plans p
        left join mbos_journey_stops s on s.plan_id = p.id
       where p.plan_date between ${from}::date and ${to}::date
         ${onlyMine(scope, "p.user_id")}
       group by p.id
       order by p.plan_date
    `),
    db.execute(sql`
      select v.salesman_id as "userId",
             (v.check_in_at ${IST})::date::text as day,
             count(*)::int as visits,
             count(*) filter (where not v.was_planned)::int as "offPlan",
             count(*) filter (where not v.verified)::int as unverified
        from mbos_visits v
       where (v.check_in_at ${IST})::date between ${from}::date and ${to}::date
         ${onlyMine(scope, "v.salesman_id")}
       group by 1, 2
    `),
    db.execute(sql`
      select l.user_id as "userId", l.from_date::text as "fromDate", l.to_date::text as "toDate",
             coalesce((select ap.state::text from mbos_approvals ap
                        where ap.subject_id = l.id and ap.type = 'leave'
                        order by ap.requested_at desc limit 1), 'pending') as state
        from mbos_leave_requests l
       where l.cancelled_at is null
         and l.from_date <= ${to}::date and l.to_date >= ${from}::date
         ${onlyMine(scope, "l.user_id")}
    `),
    db.execute(sql`
      select h.on_date::text as "onDate", h.name from mbos_holidays h
       where h.on_date between ${from}::date and ${to}::date
    `),
  ]);
  return {
    plans: plans as unknown as TeamPlanDay[],
    visits: visits as unknown as TeamVisitDay[],
    leave: (leave as unknown as TeamLeaveDay[]).filter((l) => l.state !== "rejected"),
    holidays: holidays as unknown as CalendarHoliday[],
  };
}
