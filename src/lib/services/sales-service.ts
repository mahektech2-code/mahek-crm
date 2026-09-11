import "server-only";
import { bandFor, type HealthBand } from "../engines/inactivity";
import type { BusinessDate } from "../business-date";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "../business-date";
import { today } from "../recompute";
import { employeeJoinOn, employeeLinkKindSql } from "@/lib/employee-link";
import { TERRITORY_REGION_SQL, qualify, stateKeySql } from "@/lib/territory-sql";
import { canonicalState, stateKey, stateVariants } from "@/lib/india-states";
import {
  leaveBalances as leaveBalancesFor,
  leaveDebitDays,
  type LeaveBalance,
} from "@/lib/engines/leave";

/* ---------------------------------------------------------------------------
 * Every read the Sales Dashboard makes.
 *
 * The office end of MBOS. Until this file existed, nothing in MahekOne selected
 * a single `mbos_*` row — the handsets had been filing visits, orders, money,
 * hours, leave and approvals into tables no screen displayed, which is a
 * quieter kind of broken than an error: everything worked, and nobody could
 * see any of it.
 *
 * Two rules run through it.
 *
 * **Raw SQL, and every column of the outer table qualified.** Drizzle renders
 * `${customers.id}` as a bare `"id"`, which inside a correlated subquery binds
 * to the INNER table and silently makes the condition false. Written out as
 * `customers.id`, as AGENTS.md requires.
 *
 * **Never cast a stored timestamp to a date without naming the zone.** Every
 * day window here carries `AT TIME ZONE` or an explicit `+05:30`, because a
 * bare `::date` reads in the session zone and puts a 9am visit on the wrong
 * day the moment the database is not set to Asia/Kolkata.
 * ------------------------------------------------------------------------- */

/** A day boundary in the business zone, for use inside a raw query. */
const IST_DAY = sql.raw(`at time zone '${APP_TIMEZONE}'`);

/* ═══════════════════════════════════════════════════════════════════ scope */

export type ManagerScope = {
  national: boolean;
  regions: string[];
  /**
   * The salesmen this manager may see. Null for a national manager, which is
   * NOT the same as an empty list — empty means a regional manager whose
   * regions contain nobody, and they should see nothing rather than everything.
   */
  salesmanIds: string[] | null;
};

/**
 * Which patch the signed-in manager covers.
 *
 * **Resolved here rather than passed in.** Every read in this file would
 * otherwise take a scope argument, and a filter a caller can forget to pass is
 * a filter that leaks — the failure is silent, looks like working software,
 * and shows a regional manager the whole country's figures. Reading the
 * session inside the service means there is no call site that can get it
 * wrong.
 *
 * **No territory rows means national.** That is what let the hierarchy ship
 * without changing what a single existing grant meant, and it is the same rule
 * `app_module_access` uses for modules.
 *
 * Cached per request: the sidebar asks, then every query on the screen asks
 * again, and it is two round trips either way.
 */
export const managerScope = cache(async function managerScope(): Promise<ManagerScope> {
  const { requireUser } = await import("../auth");

  let userId: string;
  try {
    userId = (await requireUser()).id;
  } catch {
    /* No request to read a session from — a script, a job or a test. There is
     * no manager to scope to, so nothing is narrowed. Every caller in that
     * situation is trusted code rather than a browser. */
    return { national: true, regions: [], salesmanIds: null };
  }

  const rows = await db.execute<{ region: string }>(sql`
    -- REGIONS ONLY. The table also holds a salesman's working cities now, and
    -- reading one of those as an oversight region would narrow a manager's
    -- console to a city on the day somebody allocated him one.
    select region from mbos_user_territories
     where user_id = ${userId} and kind = 'region'
  `);

  if (!rows.length) return { national: true, regions: [], salesmanIds: null };

  /* Every spelling of every region on the patch, folded the same way the chip
     list folds them. Compared as raw text a manager allocated "Gujarat" would
     oversee the 31 customers spelled that way and not the 97 spelled "Gujrat"
     — most of the state missing from their console, with nothing saying so. */
  const regions = rows.map((r) => canonicalState(r.region));
  const keys = [...new Set(regions.flatMap((r) => stateVariants(r)))];
  if (!keys.length) return { national: true, regions: [], salesmanIds: null };
  const list = sql`(${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`;

  /* A salesman is in scope when any shop in his book is. The book is the
   * territory — `customers.territory_region` — rather than a second field on
   * the person, which would be a third place for the same fact to disagree. */
  const men = await db.execute<{ id: string }>(sql`
    select distinct u.id
      from users u
      join app_access a on a.user_id = u.id and a.app = 'field'
      join customers c on coalesce(c.sales_am_id, c.owner_id) = u.id
     where ${sql.raw(stateKeySql(qualify(TERRITORY_REGION_SQL, "c")))} in ${list}
  `);

  return { national: false, regions, salesmanIds: men.map((m) => m.id) };
});

/**
 * `and <alias>.id in (…)`, or nothing at all for a national manager.
 *
 * An empty list produces `in ('')`, which matches nothing — deliberately. A
 * regional manager whose regions contain no salesmen sees none, and the
 * alternative (falling through to unfiltered) is the leak this whole mechanism
 * exists to prevent.
 */
export function onlyMine(scope: ManagerScope, column: string) {
  if (scope.salesmanIds === null) return sql``;
  const ids = scope.salesmanIds.length ? scope.salesmanIds : [""];
  return sql`and ${sql.raw(column)} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`;
}

/**
 * A request somebody took back is not waiting on anybody.
 *
 * Withdrawing leave marks `cancelled_at` on the request and deliberately does
 * NOT touch the approval — the office never decided anything, so recording a
 * decision would be a lie, and `mbos_approval_state` has no word for "taken
 * back" that an APK already in somebody's pocket would understand. So the
 * approval stays `pending` for ever and every read of the queue has to know it.
 *
 * Every read, which is the point of writing it once: the queue itself, the
 * count on the dashboard, the sidebar badge and the "oldest thing waiting"
 * figure. Miss one and a withdrawn request quietly becomes a desk that looks
 * three days behind.
 */
const NOT_WITHDRAWN = sql`
  and not exists (
    select 1 from mbos_leave_requests l
     where l.id = ap.subject_id
       and ap.type = 'leave'
       and l.cancelled_at is not null
  )`;

/* ═════════════════════════════════════════════════════════════════ the team */

export type Salesman = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  initials: string;
  active: boolean;
  /** Null where they have never signed in on a handset. */
  deviceBoundAt: Date | null;
  /** When the handset last spoke to MahekOne. Null where it never has. */
  lastSeenAt: Date | null;
  /** The handset bound to them now, so it can be released. Null if none is. */
  boundDeviceId: string | null;
  lastLoginAt: Date | null;
  customerCount: number;
  /**
   * Where he WORKS. Empty means his whole book, which is the safe default and
   * a deliberate one — allocating cities to eight people and forgetting the
   * ninth must not empty her handset.
   *
   * Regions are excluded: those are a manager's oversight patch, set on its own
   * screen, and a salesman's dialog must not appear able to change them.
   */
  /** Where he works. `parent` is the state a city sits in — see `PARENT_KIND`. */
  territories: { kind: string; value: string; parent: string }[];
};

/**
 * Who is in the field.
 *
 * Holding the `field` app IS the definition — it is what MBOS sign-in checks,
 * so anybody it lets onto a handset appears here and nobody else does. Reading
 * a role instead would answer a different question and the two would drift the
 * first time somebody covered a territory.
 *
 * Inactive accounts are listed rather than hidden. A leaver's book still has
 * customers in it and somebody has to move them; a person missing from a list
 * reads as a broken list.
 */
export async function fieldTeam(): Promise<Salesman[]> {
  const scope = await managerScope();
  return db.execute<Salesman>(sql`
    select u.id, u.name, u.email, u.phone, u.initials, u.active,
           u.last_login_at as "lastLoginAt",
           (select min(d.bound_at) from mbos_devices d
             where d.user_id = u.id and d.active) as "deviceBoundAt",
           (select max(d.last_seen_at) from mbos_devices d
             where d.user_id = u.id and d.active) as "lastSeenAt",
           /* The handset currently bound, so it can be released from this row.
              A salesman who changes phone cannot sign in on the new one while
              the old binding stands, and until now the only way to lift it was
              a screen he could not reach. Newest wins where a row somehow
              carries two: the one he is actually holding is the one he last
              signed in on. */
           (select d.device_id from mbos_devices d
             where d.user_id = u.id and d.active
             order by d.bound_at desc limit 1) as "boundDeviceId",
           (select count(*)::int from customers c
             where coalesce(c.sales_am_id, c.owner_id) = u.id
               and c.status = 'active') as "customerCount",
           -- Where he WORKS, which narrows the book above rather than being
           -- part of it. Regions are excluded: those are a manager's oversight
           -- patch, set on its own screen, and showing them here would read as
           -- something this dialog can change.
           coalesce((
             select json_agg(json_build_object('kind', t.kind, 'value', t.region,
                                               'parent', coalesce(t.parent, ''))
                             order by t.parent, t.kind, t.region)
               from mbos_user_territories t
              where t.user_id = u.id and t.kind <> 'region'
           ), '[]'::json) as "territories"
      from users u
      join app_access a on a.user_id = u.id and a.app = 'field'
     where true ${onlyMine(scope, "u.id")}
     order by u.active desc, u.name asc
  `) as unknown as Salesman[];
}

/* ═══════════════════════════════════════════════════════════════ the day */

export type SalesmanDay = {
  id: string;
  name: string;
  initials: string;
  active: boolean;
  /** Null where the day has not been started. */
  checkInAt: Date | null;
  checkOutAt: Date | null;
  withinGeofence: boolean | null;
  regularisationRequested: boolean;
  visits: number;
  /** Visits saved with the checklist unsatisfied — the salesman gave a reason. */
  unverifiedVisits: number;
  orders: number;
  orderValuePaise: number;
  collectedPaise: number;
  plannedStops: number;
  walkedStops: number;
};

export type TeamDay = {
  day: string;
  people: SalesmanDay[];
  totals: {
    checkedIn: number;
    outOf: number;
    visits: number;
    orders: number;
    orderValuePaise: number;
    collectedPaise: number;
    plannedStops: number;
    walkedStops: number;
  };
};

/**
 * What the field is doing, for one day.
 *
 * One query with subselects rather than one query per person: a team of twelve
 * asking eight questions each is ninety-six round trips to draw a screen
 * somebody refreshes every ten minutes.
 *
 * **The money is what the salesman said, not what the business has seen.**
 * Orders are counted as CAPTURED — `mbos` orders sit at `pending_approval`
 * until accounts decide — and collections count reported receipts, which are
 * not confirmed money. Both are the honest figure for this screen, because the
 * question it answers is "what did the team do today", and a manager reading a
 * collections total here must not think it has cleared the bank. The screen
 * says which is which.
 */
export async function teamDay(day?: string): Promise<TeamDay> {
  const on = day ?? (await today());
  const scope = await managerScope();

  const people = (await db.execute<SalesmanDay>(sql`
    select u.id, u.name, u.initials, u.active,
           att.check_in_at as "checkInAt",
           att.check_out_at as "checkOutAt",
           att.within_geofence as "withinGeofence",
           coalesce(att.regularisation_requested, false) as "regularisationRequested",

           (select count(*)::int from mbos_visits v
             where v.salesman_id = u.id
               and (v.check_in_at ${IST_DAY})::date = ${on}::date) as "visits",
           (select count(*)::int from mbos_visits v
             where v.salesman_id = u.id
               and (v.check_in_at ${IST_DAY})::date = ${on}::date
               and v.verified = false) as "unverifiedVisits",

           (select count(*)::int from orders o
             where o.created_by_id = u.id and o.source = 'mbos'
               and (o.ordered_at ${IST_DAY})::date = ${on}::date) as "orders",
           (select coalesce(sum(o.total_amount), 0)::bigint from orders o
             where o.created_by_id = u.id and o.source = 'mbos'
               and (o.ordered_at ${IST_DAY})::date = ${on}::date) as "orderValuePaise",

           (select coalesce(sum(r.amount), 0)::bigint from payment_receipts r
             where r.reported_by_id = u.id and r.source = 'mbos'
               and r.received_at = ${on}::date
               and r.status <> 'rejected') as "collectedPaise",

           (select count(*)::int from mbos_journey_stops s
              join mbos_journey_plans p on p.id = s.plan_id
             where p.user_id = u.id and p.plan_date = ${on}::date) as "plannedStops",
           (select count(*)::int from mbos_journey_stops s
              join mbos_journey_plans p on p.id = s.plan_id
             where p.user_id = u.id and p.plan_date = ${on}::date
               and s.status = 'visited') as "walkedStops"

      from users u
      join app_access a on a.user_id = u.id and a.app = 'field'
      left join mbos_attendance_days att
             on att.user_id = u.id and att.day = ${on}::date
     where true ${onlyMine(scope, "u.id")}
     order by u.active desc, att.check_in_at asc nulls last, u.name asc
  `)) as unknown as SalesmanDay[];

  const sum = (get: (p: SalesmanDay) => number) =>
    people.reduce((n, p) => n + Number(get(p) ?? 0), 0);

  return {
    day: on,
    people,
    totals: {
      checkedIn: people.filter((p) => p.checkInAt).length,
      outOf: people.filter((p) => p.active).length,
      visits: sum((p) => p.visits),
      orders: sum((p) => p.orders),
      orderValuePaise: sum((p) => p.orderValuePaise),
      collectedPaise: sum((p) => p.collectedPaise),
      plannedStops: sum((p) => p.plannedStops),
      walkedStops: sum((p) => p.walkedStops),
    },
  };
}

/* ════════════════════════════════════════════════════════ the shell's counts */

export type ConsoleCounts = {
  /** "11 salesmen · All India · 7 regions" */
  teamLine: string;
  /** The full patch, for the header's hover — see `patch` below. */
  scopeDetail: string;
  /** "National sales manager", or "South sales manager". From the scope. */
  title: string;
  /** "6 of 11 in the field" */
  liveLine: string;
  tasks: number;
  unplanned: number;
  /** Days the salesman refused. Waiting on the manager to answer. */
  refused: number;
  orders: number;
  samples: number;
  leave: number;
  expenses: number;
  /** Everything the bell would raise, added up. */
  alerts: number;
};

/**
 * Every number the sidebar badges, in one round trip.
 *
 * The sidebar draws on every route, so asking these one screen at a time is
 * eight round trips per navigation that nobody can see and everybody pays for.
 *
 * A count is only ever what is WAITING — the design draws no badge at zero,
 * because a zero beside a heading reads as a problem rather than as an empty
 * queue. The numbers are returned raw and the shell decides that.
 *
 * THE "regions" COUNT MAY NOT READ `territory_region` DIRECTLY, which is what
 * it did. That column is empty on every one of the 5,915 rows in production and
 * `customers.region` is the one the sheet fills — `TERRITORY_REGION_SQL` is the
 * fall-through and the ONE definition of this geography, and reading the raw
 * column instead is exactly the failure that file was written about. It counted
 * zero on every book in the company, so the console header has said "no
 * territory set" since it shipped, printed beside the very list of states it
 * was contradicting. Folded with `stateKeySql` as well, because the sheet holds
 * Gujrat beside Gujarat and a distinct over the raw text counts one state
 * twice.
 *
 * This note is out here rather than inside the query because the SQL is a
 * template literal, and a backtick in a comment inside one ends the string.
 */
export async function consoleCounts(
  day: string,
  tomorrow: string,
): Promise<ConsoleCounts> {
  const scope = await managerScope();
  const mine = (col: string) => onlyMine(scope, col);
  const rows = await db.execute<Record<string, number>>(sql`
    select
      (select count(*)::int from users u
         join app_access a on a.user_id = u.id and a.app = 'field'
        where u.active ${mine("u.id")}) as "team",
      (select count(*)::int from users u
         join app_access a on a.user_id = u.id and a.app = 'field'
         join mbos_attendance_days d on d.user_id = u.id and d.day = ${day}::date
        where u.active and d.check_in_at is not null and d.check_out_at is null
          ${mine("u.id")}) as "live",
      -- WHERE THE BOOK ACTUALLY IS. See the note above this function for why
      -- it may not read territory_region directly.
      (select count(distinct ${sql.raw(stateKeySql(qualify(TERRITORY_REGION_SQL, "c")))})::int
         from customers c
        where ${sql.raw(qualify(TERRITORY_REGION_SQL, "c"))} is not null
          and c.status = 'active'
          ${mine("coalesce(c.sales_am_id, c.owner_id)")}) as "regions",

      (select count(*)::int from mbos_tasks t
         join users u on u.id = t.assigned_to_user_id
         join app_access a on a.user_id = u.id and a.app = 'field'
        where t.status in ('open', 'in_progress') ${mine("u.id")}) as "tasks",

      (select count(*)::int from users u
         join app_access a on a.user_id = u.id and a.app = 'field'
        where u.active ${mine("u.id")}
          and not exists (select 1 from mbos_journey_plans p
                           where p.user_id = u.id and p.plan_date = ${tomorrow}::date)) as "unplanned",

      /* Days he has refused. These are waiting on the MANAGER, which is what
       * a badge should count — an unplanned day is waiting on nobody in
       * particular and would sit permanently at the size of the team. */
      (select count(*)::int from mbos_journey_plans p
        where p.day_state = 'refused' and p.plan_date >= ${day}::date
          ${mine("p.user_id")}) as "refused",

      (select count(*)::int from orders o
        where o.source = 'mbos' and o.status = 'pending_approval'
          ${mine("o.created_by_id")}) as "orders",

      (select count(*)::int from mbos_samples s
        where s.trial_outcome = 'pending'
          and s.follow_up_date is not null
          and s.follow_up_date < ${day}::date ${mine("s.salesman_id")}) as "samples",

      (select count(*)::int from mbos_approvals ap
        where ap.state = 'pending' and ap.type = 'leave'
          ${NOT_WITHDRAWN}
          ${mine("ap.requested_by_user_id")}) as "leave",
      (select count(*)::int from mbos_approvals ap
        where ap.state = 'pending' and ap.type = 'expense_claim'
          ${mine("ap.requested_by_user_id")}) as "expenses"
  `);

  const r = rows[0] ?? {};
  const n = (k: string) => Number(r[k] ?? 0);

  const team = n("team");
  const regions = n("regions");

  /*
   * THE PATCH, NAMED OR COUNTED — never spelled out at any length.
   *
   * This joined every region with a comma, so a manager holding five states got
   * "Andhra Pradesh, Maharashtra, Odisha, Rajasthan, West Bengal" in a header
   * bar that also has to hold a search box, three controls and his own name.
   * It does not wrap and it did not shrink, so it pushed the user chip off the
   * right edge of the screen — the whole right-hand end of the header was
   * unreachable, and the design's own example is "11 salesmen · All India ·
   * 7 states", a count rather than a list.
   *
   * One or two are still NAMED, because that is the answer somebody wants and
   * it is short. Three or more is a count, with the full list on the hover of
   * the element that prints it — the names are not lost, they stop being the
   * thing that breaks the bar.
   */
  const patch = scope.national
    ? "All India"
    : scope.regions.length <= 2
      ? scope.regions.join(" and ")
      : `${scope.regions.length} states`;

  return {
    title: scope.national
      ? "National sales manager"
      : scope.regions.length === 1
        ? `${scope.regions[0]} sales manager`
        : "Regional sales manager",
    /* The full patch, for the hover. A count is quick to read and it is not an
       answer, so the answer has to be one gesture away. */
    scopeDetail: scope.national
      ? "Every state — a national manager sees the whole field team"
      : `Oversees ${scope.regions.join(", ")}`,
    teamLine: [
      `${team} ${team === 1 ? "salesman" : "salesmen"}`,
      /* The scope, not just the headcount. It is how a regional manager knows
       * at a glance that they are looking at their own patch. */
      patch,
      /*
       * WHERE THE BOOK IS, which is a different question to where he may look,
       * and worth printing only where the two can differ. A regional manager's
       * customers are inside his patch by definition, so "5 states · 5 states"
       * would be the same fact twice; a national manager's spread is the only
       * thing in the line that is not a constant.
       */
      ...(scope.national
        ? [regions ? `${regions} ${regions === 1 ? "state" : "states"}` : "no customer names a state"]
        : []),
    ].join(" · "),
    liveLine: `${n("live")} of ${team} in the field`,
    tasks: n("tasks"),
    unplanned: n("unplanned"),
    refused: n("refused"),
    orders: n("orders"),
    samples: n("samples"),
    leave: n("leave"),
    expenses: n("expenses"),
    alerts:
      n("orders") +
      n("samples") +
      n("leave") +
      n("expenses") +
      n("refused") +
      (team - n("live") > 0 ? 1 : 0),
  };
}

/* ══════════════════════════════════════════════════════════════ approvals */

export type PendingApproval = {
  id: string;
  type: string;
  subjectType: string;
  subjectId: string;
  reason: string | null;
  requestedAt: Date;
  requestedByName: string;
  requestedById: string;
  /** What is actually being asked for, in words, read from the subject row. */
  summary: string;
  amountPaise: number | null;
  customerName: string | null;
};

/**
 * Everything waiting on a decision, oldest first.
 *
 * Oldest first and not by type: the queue is a list of people waiting, and a
 * salesman standing in a shop on a credit approval has been waiting longer than
 * whoever asked for leave this morning. Sorting by kind would bury him under
 * whatever the manager finds most interesting.
 *
 * The summary is joined from the subject rather than stored on the approval.
 * `mbos_approvals` deliberately carries only who asked, what for and why — the
 * amount lives on the expense, the dates live on the leave request, and copying
 * either onto the approval would make two rows that can disagree about one
 * request.
 */
export async function pendingApprovals(): Promise<PendingApproval[]> {
  const scope = await managerScope();
  return db.execute<PendingApproval>(sql`
    select ap.id, ap.type::text as type, ap.subject_type as "subjectType",
           ap.subject_id as "subjectId", ap.reason,
           ap.requested_at as "requestedAt",
           ap.requested_by_user_id as "requestedById",
           u.name as "requestedByName",

           case ap.type
             when 'expense_claim' then
               coalesce(
                 (select e.category || ' — ' || to_char(e.amount_paise / 100.0, 'FM99,99,999') ||
                         ' on ' || to_char(e.expense_date, 'DD Mon')
                    from mbos_expenses e where e.id = ap.subject_id),
                 'An expense claim the office cannot find')
             when 'leave' then
               coalesce(
                 (select l.leave_type::text || ' leave, ' ||
                         to_char(l.from_date, 'DD Mon') ||
                         case when l.to_date > l.from_date
                              then ' to ' || to_char(l.to_date, 'DD Mon') else '' end ||
                         case when l.half_day then ' (half day)' else '' end
                    from mbos_leave_requests l where l.id = ap.subject_id),
                 'A leave request the office cannot find')
             when 'sample' then
               coalesce(
                 (select coalesce(s.quantity_cans::text || ' cans', 'A sample') ||
                         coalesce(' of ' || p.name, '')
                    from mbos_samples s
                    left join products p on p.id = s.product_id
                   where s.id = ap.subject_id),
                 'A sample request the office cannot find')
             when 'order' then
               coalesce(
                 (select 'Order ' || coalesce(o.order_no, 'not yet numbered')
                    from orders o where o.id = ap.subject_id),
                 'An order the office cannot find')
             when 'attendance_regularisation' then
               coalesce(
                 (select 'The day of ' || to_char(d.day, 'DD Mon')
                    from mbos_attendance_days d where d.id = ap.subject_id),
                 'A day the office cannot find')
             else ap.subject_type
           end as summary,

           case ap.type
             when 'expense_claim' then
               (select e.amount_paise from mbos_expenses e where e.id = ap.subject_id)
             when 'order' then
               (select o.total_amount from orders o where o.id = ap.subject_id)
             else null
           end as "amountPaise",

           case ap.type
             when 'order' then
               (select c.name from orders o join customers c on c.id = o.customer_id
                 where o.id = ap.subject_id)
             when 'sample' then
               (select c.name from mbos_samples s join customers c on c.id = s.customer_id
                 where s.id = ap.subject_id)
             else null
           end as "customerName"

      from mbos_approvals ap
      join users u on u.id = ap.requested_by_user_id
     where ap.state = 'pending' ${NOT_WITHDRAWN}
       ${onlyMine(scope, "ap.requested_by_user_id")}
     order by ap.requested_at asc
     limit 200
  `) as unknown as PendingApproval[];
}

/** For the sidebar badge and the launcher tile. */
export async function pendingApprovalCount(): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from mbos_approvals ap
         where ap.state = 'pending' ${NOT_WITHDRAWN}`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * The oldest thing waiting, in hours.
 *
 * The badge says how many; this says whether the desk is on top of them. A
 * count of three is a quiet morning or a scandal depending entirely on how long
 * the oldest one has been sitting there.
 */
export async function oldestApprovalHours(): Promise<number> {
  const rows = await db.execute<{ hours: number }>(sql`
    select coalesce(
             floor(extract(epoch from (now() - min(ap.requested_at))) / 3600), 0
           )::int as hours
      from mbos_approvals ap
     where ap.state = 'pending' ${NOT_WITHDRAWN}
  `);
  return Number(rows[0]?.hours ?? 0);
}

export type DecidedApproval = {
  id: string;
  type: string;
  state: string;
  requestedByName: string;
  approverName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  approvedAmountPaise: number | null;
};

/** What has been decided lately, so a manager can see their own record. */
export async function recentDecisions(limit = 50): Promise<DecidedApproval[]> {
  return db.execute<DecidedApproval>(sql`
    select ap.id, ap.type::text as type, ap.state::text as state,
           u.name as "requestedByName", d.name as "approverName",
           ap.decided_at as "decidedAt", ap.decision_note as "decisionNote",
           ap.approved_amount_paise as "approvedAmountPaise"
      from mbos_approvals ap
      join users u on u.id = ap.requested_by_user_id
      left join users d on d.id = ap.approver_user_id
     where ap.state <> 'pending'
     order by ap.decided_at desc nulls last
     limit ${limit}
  `) as unknown as DecidedApproval[];
}

/* ═══════════════════════════════════════════════════════════════ field work */

export type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  salesmanId: string;
  salesmanName: string;
  initials: string;
  customerName: string | null;
  dueDate: string | null;
  priority: string;
  status: string;
  completionNote: string | null;
  raisedBy: string | null;
  createdAt: Date;
  /** Days past due. Zero where it is not late. */
  overdueDays: number;
};

/**
 * What each salesman has been asked to do.
 *
 * `overdueDays` is computed in SQL against the business date rather than in the
 * browser, so a task is late by the same number of days on every screen and in
 * whatever timezone the office happens to be read from.
 */
export async function tasksList(day: string): Promise<TaskRow[]> {
  const scope = await managerScope();
  return db.execute<TaskRow>(sql`
    select t.id, t.title, t.description,
           t.assigned_to_user_id as "salesmanId",
           u.name as "salesmanName", u.initials,
           c.name as "customerName",
           t.due_date::text as "dueDate",
           t.priority::text as priority,
           t.status::text as status,
           t.completion_note as "completionNote",
           b.name as "raisedBy",
           t.server_created_at as "createdAt",
           greatest(0, ${day}::date - t.due_date)::int as "overdueDays"
      from mbos_tasks t
      join users u on u.id = t.assigned_to_user_id
      join app_access a on a.user_id = u.id and a.app = 'field'
      left join customers c on c.id = t.customer_id
      left join users b on b.id = t.assigned_by_user_id
     where true ${onlyMine(scope, "u.id")}
     order by
       case t.status when 'open' then 0 when 'in_progress' then 1 else 2 end,
       t.due_date asc nulls last
     limit 400
  `) as unknown as TaskRow[];
}

export type VisitRow = {
  id: string;
  salesmanId: string;
  salesmanName: string;
  initials: string;
  customerName: string;
  checkInAt: Date | null;
  durationSeconds: number | null;
  outcome: string;
  verified: boolean;
  locationMismatch: boolean;
  unverifiedReason: string | null;
  /** Metres from the shop's own pin, kept whatever the outcome. Null where
   * there was nothing to check against — see `unverifiedReason`. */
  distanceFromShopM: number | null;
  acceptedAt: Date | null;
  wasPlanned: boolean;
  deviationReason: string | null;
  photos: number;
  notes: string | null;
  transcript: string | null;
  orderValuePaise: number;
  /** Where the check-in and check-out actually landed — for a manager who
   * wants to see the point itself rather than read the mismatch sentence. */
  checkInLat: number | null;
  checkInLng: number | null;
  checkInAccuracyM: number | null;
  checkOutLat: number | null;
  checkOutLng: number | null;
  checkOutAccuracyM: number | null;
  /**
   * What the salesman typed to get past a refused check-in, in his own words.
   *
   * The server folds it into `unverifiedReason`'s sentence as well, because
   * that is the column every existing screen reads — this is here so a screen
   * can show what he actually wrote rather than only what was written about
   * him, which is the same argument `distanceFromShopM` carries one field up.
   */
  checkInOverrideReason: string | null;
  /** "The shop's pin is wrong" — asked, decided, or never raised. */
  pinCorrection: "requested" | "accepted" | "rejected" | null;
  pinCorrectionDecidedAt: Date | null;
};

/**
 * Every visit on a day, with what it produced and whether it could be verified.
 *
 * An unverified visit is not a suspicious one. The handset saves a visit
 * whatever the checklist says — refusing would teach people to stop logging
 * them — and records the reason it could not be verified. That reason is the
 * column a manager actually reads.
 */
export async function visitsList(day: string): Promise<VisitRow[]> {
  const scope = await managerScope();
  return db.execute<VisitRow>(sql`
    select v.id, v.salesman_id as "salesmanId", u.name as "salesmanName", u.initials,
           c.name as "customerName",
           v.check_in_at as "checkInAt", v.duration_seconds as "durationSeconds",
           v.outcome::text as outcome, v.verified,
           v.location_mismatch as "locationMismatch",
           v.unverified_reason as "unverifiedReason",
           v.distance_from_shop_m as "distanceFromShopM",
           v.accepted_at as "acceptedAt",
           v.was_planned as "wasPlanned", v.deviation_reason as "deviationReason",
           v.notes, v.transcript,
           (case when v.shop_photo_id is not null then 1 else 0 end
            + case when v.cust_photo_id is not null then 1 else 0 end)::int as "photos",
           coalesce((select o.total_amount from orders o where o.id = v.linked_order_id), 0)
             as "orderValuePaise",
           v.check_in_lat as "checkInLat", v.check_in_lng as "checkInLng",
           v.check_in_accuracy_m as "checkInAccuracyM",
           v.check_out_lat as "checkOutLat", v.check_out_lng as "checkOutLng",
           v.check_out_accuracy_m as "checkOutAccuracyM",
           v.check_in_override_reason as "checkInOverrideReason",
           v.pin_correction::text as "pinCorrection",
           v.pin_correction_decided_at as "pinCorrectionDecidedAt"
      from mbos_visits v
      join users u on u.id = v.salesman_id
      join customers c on c.id = v.customer_id
     where (v.check_in_at ${IST_DAY})::date = ${day}::date
       ${onlyMine(scope, "u.id")}
     order by v.check_in_at desc nulls last
     limit 400
  `) as unknown as VisitRow[];
}

/* ═════════════════════════════════════ field activity backfill (historical) */

export type FieldActivityRow = {
  id: string;
  visitDate: string | null;
  salesmanId: string | null;
  salesmanName: string | null;
  employeeNameRaw: string | null;
  customerId: string | null;
  customerName: string | null;
  customerNameRaw: string | null;
  durationMinutes: number | null;
  meetingType: string | null;
  meetingPurpose: string | null;
  meetingNote: string | null;
  issueNote: string | null;
  location: string | null;
  customerMatchStatus: "pending" | "matched" | "ambiguous" | "unmatched";
  matchNote: string | null;
};

export type FieldActivityFilter = {
  from: string;
  to: string;
  salesmanId?: string;
  matchStatus?: "matched" | "ambiguous" | "unmatched";
};

const FIELD_ACTIVITY_LIMIT = 200;

/**
 * A capped, filtered slice of the imported "Mahek EMP 2.0" activity history
 * — a manager's read of the full staging table, not just the subset that
 * resolved to a real customer. `timeline_events` (and through it the MBOS
 * `timeline` pull channel) only ever gets the matched subset; a manager
 * reviewing this backfill needs to see the rows that still need a customer
 * resolved too, which is why this reads `sheet_field_activity_rows` directly.
 */
export async function fieldActivityHistory(
  filter: FieldActivityFilter,
): Promise<{ rows: FieldActivityRow[]; total: number; capped: boolean }> {
  const scope = await managerScope();
  const matchClause = filter.matchStatus
    ? sql`and f.customer_match_status = ${filter.matchStatus}`
    : sql``;
  const salesmanClause = filter.salesmanId
    ? sql`and f.matched_salesman_id = ${filter.salesmanId}`
    : sql``;

  const counted = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from sheet_field_activity_rows f
      left join users u on u.id = f.matched_salesman_id
     where f.status = 'present'
       and f.visit_date between ${filter.from}::date and ${filter.to}::date
       ${onlyMine(scope, "u.id")}
       ${matchClause}
       ${salesmanClause}
  `);
  const total = counted[0]?.n ?? 0;

  const rows = await db.execute<FieldActivityRow>(sql`
    select f.id, f.visit_date as "visitDate",
           f.matched_salesman_id as "salesmanId", u.name as "salesmanName",
           f.employee_name as "employeeNameRaw",
           f.matched_customer_id as "customerId", c.name as "customerName",
           f.customer_name as "customerNameRaw",
           f.duration_minutes as "durationMinutes",
           f.meeting_type as "meetingType", f.meeting_purpose as "meetingPurpose",
           f.meeting_note as "meetingNote", f.issue_note as "issueNote",
           f.location, f.customer_match_status as "customerMatchStatus",
           f.match_note as "matchNote"
      from sheet_field_activity_rows f
      left join users u on u.id = f.matched_salesman_id
      left join customers c on c.id = f.matched_customer_id
     where f.status = 'present'
       and f.visit_date between ${filter.from}::date and ${filter.to}::date
       ${onlyMine(scope, "u.id")}
       ${matchClause}
       ${salesmanClause}
     order by f.visit_date desc nulls last, f.id desc
     limit ${FIELD_ACTIVITY_LIMIT}
  `) as unknown as FieldActivityRow[];

  return { rows, total, capped: total > FIELD_ACTIVITY_LIMIT };
}

/** Distinct salesmen the imported activity actually resolved to, for a filter. */
export async function fieldActivitySalesmen(): Promise<{ id: string; name: string }[]> {
  const scope = await managerScope();
  return db.execute<{ id: string; name: string }>(sql`
    select distinct u.id, u.name
      from sheet_field_activity_rows f
      join users u on u.id = f.matched_salesman_id
     where f.status = 'present'
       ${onlyMine(scope, "u.id")}
     order by u.name
  `) as unknown as { id: string; name: string }[];
}

/**
 * How many rows in range fall into each match status, over the WHOLE
 * filtered set rather than the capped page — the same reason the customer
 * timeline's filter pills read a `count(*)` instead of what happened to load.
 */
export async function fieldActivityMatchCounts(
  filter: Omit<FieldActivityFilter, "matchStatus">,
): Promise<{ all: number; matched: number; ambiguous: number; unmatched: number }> {
  const scope = await managerScope();
  const salesmanClause = filter.salesmanId
    ? sql`and f.matched_salesman_id = ${filter.salesmanId}`
    : sql``;

  const rows = await db.execute<{ status: string; n: number }>(sql`
    select f.customer_match_status as status, count(*)::int as n
      from sheet_field_activity_rows f
      left join users u on u.id = f.matched_salesman_id
     where f.status = 'present'
       and f.visit_date between ${filter.from}::date and ${filter.to}::date
       ${onlyMine(scope, "u.id")}
       ${salesmanClause}
     group by f.customer_match_status
  `);

  const counts = { all: 0, matched: 0, ambiguous: 0, unmatched: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    counts.all += n;
    if (r.status === "matched" || r.status === "ambiguous" || r.status === "unmatched") {
      counts[r.status] = n;
    }
  }
  return counts;
}

export type LeadRow = {
  id: string;
  name: string;
  companyName: string | null;
  mobile: string | null;
  city: string | null;
  area: string | null;
  source: string;
  estimatedPotentialPaise: number | null;
  stage: string;
  salesmanId: string | null;
  salesmanName: string | null;
  initials: string | null;
  /**
   * Who coordinates the conversion, once the lead is qualified. Distinct from
   * the salesman above, who keeps the book and keeps making the visits — see
   * `customers.leadManagerId`. Null until a lead is qualified.
   */
  leadManagerId: string | null;
  leadManagerName: string | null;
  /** Why a held or stuck lead is not moving. Null while it is progressing. */
  holdReason: string | null;
  /** How many times anybody has stood in this shop. Counted, never cached. */
  visitCount: number;
  nextFollowUpDate: string | null;
  lastActivityDate: string | null;
  /** Days since anything happened. What "stale" is measured from. */
  quietDays: number;
  /** Days since the lead was raised. */
  ageDays: number;
  notes: string | null;
  hasGps: boolean;
  createdAt: Date;
  archived: boolean;
  archivedAt: Date | null;
  lostReason: string | null;
  /** Set on conversion. The lead is not deleted — it is where the account began. */
  convertedCustomerId: string | null;
  convertedAt: Date | null;
  /**
   * The linked customer's real derived facts, read where a lead has become
   * one. Null on everything else — a lead that has never ordered is in NO
   * health band, and inventing one here would be the exact mistake §owner
   * dashboard's health bands were written to avoid.
   */
  customerHealthScore: number | null;
  customerStatus: string | null;
  customerLastOrderDate: string | null;
  customerCycleDays: number | null;
  /**
   * The retention band — the ONE definition of "gone quiet", the same one
   * `customers.status`, the Call Log and the owner's report read. Computed in
   * JS from the two columns above rather than as a CASE in the query, because
   * a second copy of that rule is a copy that drifts. Null where the lead has
   * never ordered: no band, and the screen says so in words.
   */
  customerHealthBand: HealthBand | null;
  customerOutstandingPaise: number | null;
};

/*
 * ONE LEAD, so this reads `customers`.
 *
 * The screen shows anything that has ever been a lead — `lead_stage is not
 * null` — rather than `kind = 'lead'`. Winning one now moves `kind` to
 * `customer` on the SAME row, and filtering on the kind would drop it out of
 * the funnel at the moment it succeeded, which is the one band a manager most
 * wants to see. The stage survives the conversion; `lead_converted_at` is what
 * says it happened.
 *
 * The customer-health columns used to come from a join to the converted
 * record. There is no second record now, so they are this row's own, shown
 * only once it has actually been won — an unconverted lead would otherwise
 * report the column defaults as though they were a health reading.
 */
const LEAD_ROW_SELECT = sql`
    select c.id, c.name, c.company_name as "companyName", c.phone as mobile,
           c.city, c.area,
           /* COALESCED, and NO BACKTICKS in this comment: it sits inside a
            * sql template literal, and one backtick ends the literal.
            *
            * LeadRow.source is typed as a plain string and the screen calls
            * .replace() on it. mbos_leads.source was NOT NULL with a default
            * of 'manual'; customers.lead_source is nullable, so collapsing the
            * two tables quietly removed an invariant three screens were
            * written against - 42 leads with a null source took the whole page
            * down with "Cannot read properties of null". The cast in
            * db.execute of LeadRow is unchecked, so neither tsc nor a test
            * could see it; the guarantee has to be restored here in the SQL. */
           coalesce(c.lead_source, 'manual') as source,
           c.lead_estimated_potential_paise as "estimatedPotentialPaise",
           c.lead_stage::text as stage,
           c.owner_id as "salesmanId",
           u.name as "salesmanName", u.initials,
           /* The coordinating seat. It is NOT the owner and must not be drawn
            * as one: the salesman above still holds the book and still makes
            * the visits. This is who runs the conversation about price, terms
            * and samples once the lead is qualified. */
           c.lead_manager_id as "leadManagerId",
           lm.name as "leadManagerName",
           c.lead_hold_reason as "holdReason",
           /* The same count the handset is sent, from the same expression, so
            * the office and the salesman cannot disagree about how many times
            * somebody has been to a shop. */
           (select count(*)::int from mbos_visits v
             where v.customer_id = c.id) as "visitCount",
           c.lead_next_follow_up_date::text as "nextFollowUpDate",
           c.lead_last_activity_date::text as "lastActivityDate",
           c.lead_notes as notes,
           (c.gps_lat is not null and c.gps_lng is not null) as "hasGps",
           c.created_at as "createdAt",
           c.lead_archived as archived,
           c.lead_archived_at as "archivedAt",
           c.lead_lost_reason as "lostReason",
           case when c.lead_converted_at is not null then c.id end as "convertedCustomerId",
           c.lead_converted_at as "convertedAt",
           case when c.lead_converted_at is not null then c.health_score end as "customerHealthScore",
           case when c.lead_converted_at is not null then c.status::text end as "customerStatus",
           case when c.lead_converted_at is not null then c.last_order_date::text end as "customerLastOrderDate",
           case when c.lead_converted_at is not null then c.cycle_days end as "customerCycleDays",
           case when c.lead_converted_at is not null then c.outstanding end as "customerOutstandingPaise"
`;

/** Prospects each salesman is working, and how long since anybody touched one. */
export async function leadsList(day: string): Promise<LeadRow[]> {
  const scope = await managerScope();
  return withHealthBand(day, await db.execute<LeadRow>(sql`
    ${LEAD_ROW_SELECT},
           coalesce(${day}::date - c.lead_last_activity_date, 0)::int as "quietDays",
           (${day}::date - (c.created_at ${IST_DAY})::date)::int as "ageDays"
      from customers c
      left join users u on u.id = c.owner_id
      left join users lm on lm.id = c.lead_manager_id
     where c.lead_stage is not null
       and c.lead_archived = false
       ${onlyMine(scope, "c.owner_id")}
     order by c.lead_next_follow_up_date asc nulls last, c.lead_last_activity_date asc nulls last
     limit 400
  `) as unknown as LeadRow[]);
}

/**
 * Fill in each row's retention band.
 *
 * `bandFor` is the one definition of "has this customer gone quiet", shared
 * with `customers.status`, the Call Log and the owner's retention report.
 * Spelling it as a CASE expression in the query above would have been a second
 * copy of a rule whose entire point is that there is one — and the copy drifts
 * the day somebody changes a multiplier on the Settings screen.
 *
 * Null stays null: a lead that has never ordered is in NO band, which the
 * screen says in words rather than drawing one it invented.
 */
async function withHealthBand(day: string, rows: LeadRow[]): Promise<LeadRow[]> {
  const { getConfig } = await import("../config/store");
  const config = await getConfig();
  return rows.map((r) => ({
    ...r,
    customerHealthBand:
      bandFor(
        {
          lastOrderDate: (r.customerLastOrderDate as BusinessDate | null) ?? null,
          cycleDays: Number(r.customerCycleDays ?? 0),
        },
        day as BusinessDate,
        config,
      )?.band ?? null,
  }));
}

/**
 * Leads a manager has filed out of the way, newest first.
 *
 * Archiving here is a manual override of what the nightly sweep would
 * otherwise do on its own — a manager saying "I have looked at this and it
 * is not worth chasing right now" — and it stays reachable and reversible for
 * exactly the same reason the sweep never deletes: a shop that said no in
 * March is who somebody wants to find in September.
 */
export async function archivedLeadsList(day: string): Promise<LeadRow[]> {
  const scope = await managerScope();
  return db.execute<LeadRow>(sql`
    ${LEAD_ROW_SELECT},
           coalesce(${day}::date - c.lead_last_activity_date, 0)::int as "quietDays",
           (${day}::date - (c.created_at ${IST_DAY})::date)::int as "ageDays"
      from customers c
      left join users u on u.id = c.owner_id
      left join users lm on lm.id = c.lead_manager_id
     where c.lead_stage is not null
       and c.lead_archived = true
       ${onlyMine(scope, "c.owner_id")}
     order by c.lead_archived_at desc nulls last
     limit 400
  `) as unknown as LeadRow[];
}

/** How many leads are filed away, for the link that leads there. */
export async function archivedLeadsCount(): Promise<number> {
  const scope = await managerScope();
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from customers c
     where c.lead_stage is not null
       and c.lead_archived = true
       ${onlyMine(scope, "c.owner_id")}
  `);
  return Number(rows[0]?.n ?? 0);
}

/* ═══════════════════════════════════════════════════════════════ commercial */

export type FieldOrder = {
  id: string;
  orderNo: string | null;
  salesmanId: string | null;
  salesmanName: string | null;
  customerId: string;
  customerName: string;
  orderedAt: Date;
  totalAmountPaise: number;
  status: string;
  creditLimitPaise: number | null;
  outstandingPaise: number;
  creditBlocked: boolean;
  creditTermDays: number | null;
  lines: number;
  cans: number;
  /** Hours since it was captured. What "waiting" is measured in. */
  waitingHours: number;
};

/**
 * Orders taken in the field.
 *
 * An order here is the customer saying yes, not the business. It sits at
 * `pending_approval` until accounts decide, and this screen shows what that
 * decision is up against — the customer's limit and what they already owe,
 * beside the value. The decision itself is accounts', deliberately: the person
 * chasing the target does not sign off the orders that hit it.
 */
export async function fieldOrders(pending?: boolean): Promise<FieldOrder[]> {
  const only = pending ? sql`and o.status = 'pending_approval'` : sql``;
  const scope = await managerScope();
  return db.execute<FieldOrder>(sql`
    select o.id, o.order_no as "orderNo",
           o.created_by_id as "salesmanId", u.name as "salesmanName",
           o.customer_id as "customerId", c.name as "customerName",
           o.ordered_at as "orderedAt",
           o.total_amount as "totalAmountPaise",
           o.status::text as status,
           c.credit_limit_paise as "creditLimitPaise",
           coalesce(c.outstanding, 0) as "outstandingPaise",
           c.credit_blocked as "creditBlocked",
           c.credit_term_days as "creditTermDays",
           coalesce(jsonb_array_length(o.line_items), 0)::int as "lines",
           coalesce((select sum((x->>'quantity')::int)
                       from jsonb_array_elements(coalesce(o.line_items, '[]'::jsonb)) x), 0)::int
             as "cans",
           floor(extract(epoch from (now() - o.created_at)) / 3600)::int as "waitingHours"
      from orders o
      join customers c on c.id = o.customer_id
      left join users u on u.id = o.created_by_id
     where o.source = 'mbos' ${only} ${onlyMine(scope, "o.created_by_id")}
     order by o.ordered_at desc
     limit 300
  `) as unknown as FieldOrder[];
}

export type FieldReceipt = {
  id: string;
  receiptNo: string | null;
  salesmanId: string | null;
  salesmanName: string | null;
  customerName: string;
  amountPaise: number;
  mode: string;
  reference: string | null;
  receivedAt: string;
  status: string;
  depositedAt: Date | null;
  note: string | null;
  /** Days since it was collected. The deposit window is counted in these. */
  heldDays: number;
};

/**
 * Money the field says it has collected.
 *
 * The screen this feeds is about two different things and the design says so:
 * what has been reported, and who is still holding company CASH. Cash is a
 * personal liability for the man carrying it — a transfer is already in the
 * bank and a cheque is banked by the office — so only cash is counted against
 * the deposit window.
 */
export async function fieldReceipts(): Promise<FieldReceipt[]> {
  const scope = await managerScope();
  return db.execute<FieldReceipt>(sql`
    select r.id, r.receipt_no as "receiptNo",
           r.reported_by_id as "salesmanId", u.name as "salesmanName",
           c.name as "customerName",
           r.amount as "amountPaise", r.mode, r.reference,
           r.received_at::text as "receivedAt",
           r.status::text as status,
           r.deposited_at as "depositedAt",
           r.note,
           (current_date - r.received_at)::int as "heldDays"
      from payment_receipts r
      join customers c on c.id = r.customer_id
      left join users u on u.id = r.reported_by_id
     where r.source = 'mbos' ${onlyMine(scope, "r.reported_by_id")}
     order by r.received_at desc, r.created_at desc
     limit 300
  `) as unknown as FieldReceipt[];
}

export type FieldInvoice = {
  id: string;
  billNo: string;
  customerName: string;
  salesmanId: string | null;
  salesmanName: string | null;
  billDate: string;
  dueDate: string | null;
  amountPaise: number;
  paidPaise: number;
  openPaise: number;
  overdueDays: number;
  paymentPosition: string;
};

/**
 * What has been billed against the field's book, and what is left on each.
 *
 * "After confirmed money only", as the design puts it. `paid_amount` counts
 * confirmed receipts and nothing else, so a bill a salesman has reported money
 * against still stands at its full amount here — which is exactly the row
 * somebody needs an explanation on, and `paymentPosition` is it: `unstated`
 * means nobody has spoken for this bill either way, and it is held out of
 * outstanding rather than counted as debt.
 */
export async function fieldInvoices(): Promise<FieldInvoice[]> {
  const scope = await managerScope();
  return db.execute<FieldInvoice>(sql`
    select b.id, b.bill_no as "billNo", c.name as "customerName",
           coalesce(c.sales_am_id, c.owner_id) as "salesmanId",
           u.name as "salesmanName",
           b.bill_date::text as "billDate",
           b.due_date::text as "dueDate",
           b.amount as "amountPaise",
           b.paid_amount as "paidPaise",
           (b.amount - b.paid_amount) as "openPaise",
           greatest(0, current_date - b.due_date)::int as "overdueDays",
           b.payment_position::text as "paymentPosition"
      from bills b
      join customers c on c.id = b.customer_id
      left join users u on u.id = coalesce(c.sales_am_id, c.owner_id)
     where exists (select 1 from app_access a
                    where a.user_id = coalesce(c.sales_am_id, c.owner_id) and a.app = 'field')
       ${onlyMine(scope, "coalesce(c.sales_am_id, c.owner_id)")}
     order by (b.amount - b.paid_amount) desc, b.due_date asc nulls last
     limit 300
  `) as unknown as FieldInvoice[];
}

export type FieldSample = {
  id: string;
  customerName: string;
  salesmanId: string;
  salesmanName: string;
  productName: string | null;
  quantityCans: number | null;
  requestedDate: string | null;
  deliveredAt: Date | null;
  followUpDate: string | null;
  trialOutcome: string;
  feedbackNotes: string | null;
  approvalId: string | null;
  approvalState: string | null;
  /** Days past the follow-up date. Zero where it is not late. */
  lateDays: number;
};

/** Stock given away on trial, and the feedback nobody chased. */
export async function fieldSamples(): Promise<FieldSample[]> {
  const scope = await managerScope();
  return db.execute<FieldSample>(sql`
    select s.id, c.name as "customerName",
           s.salesman_id as "salesmanId", u.name as "salesmanName",
           p.name as "productName", s.quantity_cans as "quantityCans",
           s.requested_date::text as "requestedDate",
           s.delivered_at as "deliveredAt",
           s.follow_up_date::text as "followUpDate",
           s.trial_outcome::text as "trialOutcome",
           s.feedback_notes as "feedbackNotes",
           (select ap.id from mbos_approvals ap
             where ap.subject_id = s.id and ap.type = 'sample'
             order by ap.requested_at desc limit 1) as "approvalId",
           (select ap.state::text from mbos_approvals ap
             where ap.subject_id = s.id and ap.type = 'sample'
             order by ap.requested_at desc limit 1) as "approvalState",
           greatest(0, current_date - s.follow_up_date)::int as "lateDays"
      from mbos_samples s
      join customers c on c.id = s.customer_id
      join users u on u.id = s.salesman_id
      left join products p on p.id = s.product_id
     where true ${onlyMine(scope, "s.salesman_id")}
     order by s.requested_date desc nulls last
     limit 300
  `) as unknown as FieldSample[];
}

export type CatalogueRow = {
  id: string;
  name: string;
  rawName: string | null;
  packSize: string | null;
  packing: string | null;
  cansPerBox: number | null;
  millilitresPerCan: number | null;
  active: boolean;
  status: string;
  formulation: string | null;
  brand: string | null;
  orderedCans: number;
};

/**
 * What the app offers, and how much of it has actually been ordered.
 *
 * No prices. `products.priceSource` is `unset` and the product master carries
 * none at all, so the design's Retail / Dealer / Distributor columns have
 * nothing behind them — and reaching for the packing cost because it is the
 * only number on the row would put believable wrong figures on a rate card.
 * The screen says that rather than showing three zeroes.
 */
export async function catalogueRows(search?: string): Promise<CatalogueRow[]> {
  const where = search
    ? sql`and (p.name ilike ${"%" + search + "%"}
            or coalesce(f.name, '') ilike ${"%" + search + "%"}
            or coalesce(br.name, '') ilike ${"%" + search + "%"})`
    : sql``;

  return db.execute<CatalogueRow>(sql`
    select p.id, p.name, p.raw_name as "rawName",
           p.pack_size as "packSize", p.packing,
           p.cans_per_box as "cansPerBox",
           p.millilitres_per_can as "millilitresPerCan",
           p.active, p.status::text as status,
           f.name as formulation, br.name as brand,
           coalesce((select sum((x->>'quantity')::int)
                       from orders o,
                            jsonb_array_elements(coalesce(o.line_items, '[]'::jsonb)) x
                      where o.source = 'mbos' and x->>'product' = p.name), 0)::int
             as "orderedCans"
      from products p
      left join finished_goods fg on fg.id = p.finished_good_id
      left join product_brands br on br.id = fg.brand_id
      left join product_formulations f on f.id = br.formulation_id
     where true ${where}
     order by p.active desc, p.display_order asc nulls last, p.name asc
     limit 400
  `) as unknown as CatalogueRow[];
}

export type PriceListRow = {
  id: string;
  customerPriceTag: string;
  productId: string;
  productName: string;
  ratePaise: number;
  validFrom: string | null;
  validTo: string | null;
};

/**
 * Every rate ever set, current and superseded alike.
 *
 * A superseded row (`validTo` in the past) is shown rather than hidden — it
 * is what explains an order priced last month, and hiding it the moment it
 * expires would make that explanation unreachable the day after it mattered.
 * The screen is the one that decides how much of the past to draw.
 */
export async function priceListEntries(): Promise<PriceListRow[]> {
  return db.execute<PriceListRow>(sql`
    select pl.id, pl.customer_price_tag as "customerPriceTag", pl.product_id as "productId",
           p.name as "productName", pl.rate_paise as "ratePaise",
           pl.valid_from::text as "validFrom", pl.valid_to::text as "validTo"
      from mbos_price_list pl
      join products p on p.id = pl.product_id
     order by (pl.valid_to is not null) asc, pl.customer_price_tag asc, p.name asc, pl.valid_from desc
     limit 2000
  `) as unknown as PriceListRow[];
}

/** Every price tag the Sales Party tab actually uses — a dropdown, not a guess. */
export async function priceTagOptions(): Promise<string[]> {
  const rows = await db.execute<{ tag: string }>(sql`
    select distinct tag_pricelist as tag
      from sheet_party_rows
     where tag_pricelist is not null and tag_pricelist <> ''
     order by 1
  `);
  return rows.map((r) => r.tag);
}

export type SchemeRow = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  eligibility: unknown;
  benefit: unknown;
  validFrom: string | null;
  validTo: string | null;
};

export async function schemeEntries(): Promise<SchemeRow[]> {
  return db.execute<SchemeRow>(sql`
    select s.id, s.name, s.description, s.active, s.eligibility, s.benefit,
           s.valid_from::text as "validFrom", s.valid_to::text as "validTo"
      from mbos_schemes s
     order by s.active desc, s.valid_from desc nulls last, s.name asc
     limit 500
  `) as unknown as SchemeRow[];
}

/* ═══════════════════════════════════════════════════════════════════ people */

export type AttendanceRow = {
  id: string;
  day: string;
  salesmanId: string;
  salesmanName: string;
  initials: string;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  status: string;
  withinGeofence: boolean | null;
  geofenceDistanceM: number | null;
  regularisationRequested: boolean;
  regularisationReason: string | null;
  autoCheckedOut: boolean;
  workedSeconds: number | null;
  visits: number;
  /**
   * Every arrival and departure of the day, with the photograph taken at each.
   *
   * The day-level `check_in_selfie_id`/`check_out_selfie_id` are the first-in
   * and last-out mirrors and are deliberately NOT what this screen reads: a
   * salesman who breaks for lunch and comes out again in the evening has three
   * arrivals, and showing one photograph for the day would verify the first and
   * assert nothing whatever about the other two.
   *
   */
  sessions: {
    inAt: string | null;
    outAt: string | null;
    inSelfieId: string | null;
    outSelfieId: string | null;
  }[];
  /**
   * Which of those ids can still be opened.
   *
   * Asked of the attachments table rather than worked out from the retention
   * window, because the two can honestly differ: a photograph taken on a Monday
   * with no signal and synced on Wednesday is younger than the day it belongs
   * to, and the window runs from when it arrived. An id present in a session
   * and absent from this list is a photograph that WAS taken and has since been
   * deleted — which is a different thing to say than "none was taken", and the
   * screen says it differently.
   */
  availableSelfieIds: string[];
};

/**
 * Who started the day, when, and from where.
 *
 * **This is not the `attendance` table.** That one is a sign-in log with an
 * unfortunate name — it says somebody opened MahekOne, from home, at 2am. This
 * is `mbos_attendance_days`, the real check-in system, and the difference
 * matters on a screen a manager might pay somebody from.
 *
 * Everybody in the field appears, including those who never checked in: a
 * missing row IS the fact worth seeing, and a list that only shows people who
 * turned up cannot answer the question the screen exists for.
 */
export async function attendanceForDay(day: string): Promise<AttendanceRow[]> {
  const scope = await managerScope();
  return db.execute<AttendanceRow>(sql`
    select coalesce(d.id, u.id) as id,
           ${day}::text as day,
           u.id as "salesmanId", u.name as "salesmanName", u.initials,
           d.check_in_at as "checkInAt", d.check_out_at as "checkOutAt",
           coalesce(d.status::text, 'absent') as status,
           d.within_geofence as "withinGeofence",
           d.geofence_distance_m as "geofenceDistanceM",
           coalesce(d.regularisation_requested, false) as "regularisationRequested",
           d.regularisation_reason as "regularisationReason",
           coalesce(d.auto_checked_out, false) as "autoCheckedOut",
           d.worked_seconds as "workedSeconds",
           (select count(*)::int from mbos_visits v
             where v.salesman_id = u.id
               and (v.check_in_at ${IST_DAY})::date = ${day}::date) as "visits",
           /* The day as the handset reported it. Null on a row written before
              sessions existed, which the screen falls back from rather than
              drawing an empty list. */
           coalesce(d.sessions, '[]'::jsonb) as "sessions",
           /* Which photographs are still openable, asked of the attachments
              table itself. The sessions column names its ids for ever — that
              is the point of keeping them — so an id present there says a
              photograph was TAKEN and says nothing about whether it still
              exists. (No backticks in here: this is inside a sql template and
              one would end it.) */
           coalesce((select jsonb_agg(a.id) from attachments a
                      where a.parent_type = 'mbos_attendance'
                        and a.parent_id = d.id
                        and a.status = 'available'), '[]'::jsonb)
             as "availableSelfieIds"
      from users u
      join app_access a on a.user_id = u.id and a.app = 'field'
      left join mbos_attendance_days d on d.user_id = u.id and d.day = ${day}::date
     where u.active ${onlyMine(scope, "u.id")}
     order by d.check_in_at asc nulls last, u.name asc
  `) as unknown as AttendanceRow[];
}

export type LeaveRow = {
  id: string;
  salesmanId: string;
  salesmanName: string;
  initials: string;
  leaveType: string;
  fromDate: string;
  toDate: string;
  halfDay: boolean;
  days: number;
  reason: string | null;
  cancelledAt: Date | null;
  approvalId: string | null;
  approvalState: string | null;
  decisionNote: string | null;
  approverName: string | null;
  requestedAt: Date | null;
  /** Somebody else in the field off on an overlapping day. */
  clashesWith: string | null;
};

/**
 * Leave asked for, and what stands in the way of saying yes.
 *
 * `clashesWith` is the design's idea and a good one: two salesmen off in the
 * same week leaves those shops unworked, and a manager approving the second
 * request usually cannot see the first. It is computed rather than stored,
 * because it is a question about the state of the calendar at the moment
 * somebody looks.
 */
export async function leaveRequests(): Promise<LeaveRow[]> {
  const scope = await managerScope();
  return db.execute<LeaveRow>(sql`
    select l.id, l.user_id as "salesmanId", u.name as "salesmanName", u.initials,
           l.leave_type::text as "leaveType",
           l.from_date::text as "fromDate", l.to_date::text as "toDate",
           l.half_day as "halfDay", l.days, l.reason,
           l.cancelled_at as "cancelledAt",
           ap.id as "approvalId",
           ap.state::text as "approvalState",
           ap.decision_note as "decisionNote",
           d.name as "approverName",
           ap.requested_at as "requestedAt",
           /* Who ELSE is off on these days.
            *
            * "Else" is load-bearing and was missing: without the user check a
            * person's own request could name them, which reads as a clash with
            * themselves. And a REFUSED request is not somebody being off — it
            * counted here, so the banner warned about two salesmen away in one
            * week when one of them had already been told no. Waiting counts,
            * because two requests decided one at a time by somebody who cannot
            * see the other is the whole reason this column exists. */
           (select string_agg(distinct u2.name, ', ')
              from mbos_leave_requests l2
              join users u2 on u2.id = l2.user_id
              left join mbos_approvals ap2
                     on ap2.subject_id = l2.id and ap2.type = 'leave'
             where l2.id <> l.id
               and l2.user_id <> l.user_id
               and l2.cancelled_at is null
               and coalesce(ap2.state::text, 'pending') in ('pending', 'approved')
               and l2.from_date <= l.to_date
               and l2.to_date >= l.from_date) as "clashesWith"
      from mbos_leave_requests l
      join users u on u.id = l.user_id
      left join mbos_approvals ap
             on ap.subject_id = l.id and ap.type = 'leave'
      left join users d on d.id = ap.approver_user_id
     where true ${onlyMine(scope, "l.user_id")}
     order by
       case when ap.state = 'pending' then 0 else 1 end,
       l.from_date desc
     limit 300
  `) as unknown as LeaveRow[];
}

export type ExpenseRow = {
  id: string;
  salesmanId: string;
  salesmanName: string;
  initials: string;
  category: string;
  amountPaise: number;
  expenseDate: string;
  remarks: string | null;
  billPhotoId: string | null;
  approvalId: string | null;
  approvalState: string | null;
  approvedAmountPaise: number | null;
  decisionNote: string | null;
  /** What this person has already claimed in the same category this month. */
  monthToDatePaise: number;
};

/**
 * What the field spent, and what it is owed back.
 *
 * `monthToDatePaise` is what makes a cap mean anything on this screen: a
 * ₹1,840 fuel claim is unremarkable on its own and is the fourth one this
 * month against a ₹6,000 cap. The cap itself is configuration and lives with
 * the settings; this supplies the number to compare it against.
 */
export async function expenseClaims(): Promise<ExpenseRow[]> {
  const scope = await managerScope();
  return db.execute<ExpenseRow>(sql`
    select e.id, e.user_id as "salesmanId", u.name as "salesmanName", u.initials,
           e.category::text as category,
           e.amount_paise as "amountPaise",
           e.expense_date::text as "expenseDate",
           e.remarks, e.bill_photo_id as "billPhotoId",
           ap.id as "approvalId",
           ap.state::text as "approvalState",
           ap.approved_amount_paise as "approvedAmountPaise",
           ap.decision_note as "decisionNote",
           coalesce((select sum(e2.amount_paise) from mbos_expenses e2
                      where e2.user_id = e.user_id
                        and e2.category = e.category
                        and date_trunc('month', e2.expense_date) =
                            date_trunc('month', e.expense_date)), 0) as "monthToDatePaise"
      from mbos_expenses e
      join users u on u.id = e.user_id
      left join mbos_approvals ap
             on ap.subject_id = e.id and ap.type = 'expense_claim'
     where true ${onlyMine(scope, "e.user_id")}
     order by
       case when ap.state = 'pending' then 0 else 1 end,
       e.expense_date desc
     limit 300
  `) as unknown as ExpenseRow[];
}

/* ═════════════════════════════════════════════════════ overview and admin */

export type LastKnown = {
  salesmanId: string;
  salesmanName: string;
  initials: string;
  active: boolean;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  /** Where the handset last reported from, and when. */
  lat: number | null;
  lng: number | null;
  seenAt: Date | null;
  place: string | null;
  accuracyM: number | null;
  onLeave: boolean;
  /**
   * Whether this salesman's handset actually has the OS's background
   * location permission — see `mbos_devices.background_location_granted`.
   * False is the answer that matters: tracking has fallen back to a timer
   * that dies the moment the phone locks, which is the real cause behind a
   * trail with real gaps in it. Null means never reported, not refused.
   */
  backgroundTrackingGranted: boolean | null;
  /**
   * WHY THE MAP IS EMPTY, where the handset was able to say.
   *
   * "No fix today" has four ordinary causes and used to be one sentence for
   * all of them: the background permission refused, location switched off on
   * the phone, no signal, or a flat battery. They are four different
   * conversations — one is a settings screen, one is a charger, and one is
   * nobody's fault at all — and a manager guessing between them rings a
   * salesman to ask him to read out his own permissions.
   *
   * Every one of these is NULLABLE and stays drawn as unknown when it is
   * null. Handsets already in the field report none of it and will go on
   * doing so until they are updated, which is not a fault to display.
   */
  deviceModel: string | null;
  appVersion: string | null;
  locationPermission: string | null;
  locationServicesEnabled: boolean | null;
  connectionType: string | null;
  batteryPercent: number | null;
  batteryCharging: boolean | null;
  /**
   * When the three readings above were taken — NOT when they were drawn.
   *
   * There is no live reading here and the screen must never imply one: the
   * handset speaks when it syncs, so a battery figure is minutes old inside a
   * working day and hours old outside one. This is what lets the row say "64%
   * at 09:14" instead of "64%", the same way a travelling salesman's distance
   * carries the age of the fix it was measured from.
   */
  deviceStateAt: Date | null;
  /**
   * The last time the HANDSET SPOKE, which is the only honest answer to "is
   * his internet off".
   *
   * A phone with no connection cannot report that it has no connection, so
   * nothing the handset sends could ever carry that fact. Silence carries it,
   * and this is the silence measured.
   */
  lastHeardAt: Date | null;
  /**
   * THE TRAIL'S OWN NEWEST FIX, which `seenAt` above cannot answer.
   *
   * `seenAt` is the newest of three sources — the trail, the check-in and each
   * visit — and that is right for "where is he", which is what it is for. It
   * is the wrong reading of "is his tracking working", because a check-in
   * leaves a fix whatever the trail is doing: a salesman whose tracking never
   * started once ran a whole day with a pin, a place and a time on this list
   * and not one position in `mbos_positions`, and nothing on any screen could
   * tell that apart from a man standing still. Null means the trail has
   * produced nothing at all today — see `trailIsDead` in `handset-health`.
   */
  trailSeenAt: Date | null;
  /**
   * WHETHER THE DAY OPENED ON A PHONE THAT COULD SHOW IT WOULD RECORD IT.
   *
   * The handset gates its own check-in now, and the three facts behind that
   * decision ride the attendance row: what it could check, whether the man
   * claimed to have done the steps nothing can check, and what was still
   * outstanding when he claimed it. They are here because a gate that stops a
   * man working is a support call, and the office has to be able to answer it
   * — and because the claim is only worth anything read against the trail that
   * did or did not follow it.
   *
   * Null throughout on a handset too old to say, which is every handset in the
   * field until it is updated. Never read null as "nothing was wrong".
   */
  setupReady: boolean | null;
  setupAcknowledgedAt: Date | null;
  setupUnverified: string[] | null;
};

/**
 * Where each salesman last reported from.
 *
 * **Three sources, and the newest of them wins.** The trail is a fix every few
 * minutes while the day is open; a check-in and each visit leave one apiece.
 * Reading only the trail would blank a handset whose tracking is off or whose
 * permission was refused — those two still leave visits, and a visit is a
 * position somebody stood at.
 *
 * The time on the answer is the time of the fix and never "now". A salesman who
 * checked in at nine and whose phone has had no signal since reads as nine
 * o'clock, which is the honest thing and the whole reason `seenAt` is on the
 * row rather than implied by the screen drawing it.
 */
export async function lastKnownPositions(day: string): Promise<LastKnown[]> {
  const scope = await managerScope();
  return db.execute<LastKnown>(sql`
    with fixes as (
      select v.salesman_id as uid, v.check_in_lat as lat, v.check_in_lng as lng,
             v.check_in_at as at, c.name as place, v.check_in_accuracy_m as acc
        from mbos_visits v
        join customers c on c.id = v.customer_id
       where (v.check_in_at ${IST_DAY})::date = ${day}::date
         and v.check_in_lat is not null
      union all
      select d.user_id, d.check_in_lat, d.check_in_lng, d.check_in_at,
             'Checked in' as place, d.check_in_accuracy_m
        from mbos_attendance_days d
       where d.day = ${day}::date and d.check_in_lat is not null
      union all
      /* The trail. It carries no place name, because it is a point between two
         shops rather than at one — saying "On the road" is the truth and a
         reverse-geocoded street name would be a guess dressed as a fact. */
      select p.user_id, p.lat, p.lng, p.at, null as place, p.accuracy_m
        from mbos_positions p
       where (p.at ${IST_DAY})::date = ${day}::date
    ),
    latest as (
      select distinct on (uid) uid, lat, lng, at, place, acc
        from fixes order by uid, at desc
    ),
    /* The trail ALONE, deliberately not folded into the fixes above: the whole
       point of it is to be readable apart from the check-in and the visits
       that would otherwise stand in for it. See trailSeenAt on the type. */
    trail as (
      select p.user_id as uid, max(p.at) as at
        from mbos_positions p
       where (p.at ${IST_DAY})::date = ${day}::date
       group by p.user_id
    )
    select u.id as "salesmanId", u.name as "salesmanName", u.initials, u.active,
           d.check_in_at as "checkInAt", d.check_out_at as "checkOutAt",
           f.lat, f.lng, f.at as "seenAt", f.place, f.acc as "accuracyM",
           (d.status = 'on_leave') as "onLeave",
           dev.background_location_granted as "backgroundTrackingGranted",
           dev.model as "deviceModel", dev.app_version as "appVersion",
           dev.location_permission as "locationPermission",
           dev.location_services_enabled as "locationServicesEnabled",
           dev.connection_type as "connectionType",
           dev.battery_percent as "batteryPercent",
           dev.battery_charging as "batteryCharging",
           dev.device_state_at as "deviceStateAt",
           dev.last_seen_at as "lastHeardAt",
           tr.at as "trailSeenAt",
           d.setup_ready as "setupReady",
           d.setup_acknowledged_at as "setupAcknowledgedAt",
           d.setup_unverified as "setupUnverified"
      from users u
      join app_access a on a.user_id = u.id and a.app = 'field'
      left join mbos_attendance_days d on d.user_id = u.id and d.day = ${day}::date
      left join latest f on f.uid = u.id
      left join trail tr on tr.uid = u.id
      left join mbos_devices dev on dev.user_id = u.id and dev.active
     where u.active ${onlyMine(scope, "u.id")}
     order by f.at desc nulls last, u.name asc
  `) as unknown as LastKnown[];
}

export type TrackPoint = {
  lat: number;
  lng: number;
  at: Date;
  accuracyM: number | null;
  /** Set on the points that are a visit rather than a plain fix. */
  place: string | null;
};

/**
 * One person's day, in order, uncapped in any way that would thin it.
 *
 * The line a manager actually wants: a beat worked from one end to the other
 * looks completely unlike an afternoon spent in one place, and neither is
 * visible in a list of visits.
 *
 * Visits are folded in and NAMED, because they are the points that mean
 * something — a track with the shops marked on it answers "did he get to
 * Sadar" without anybody counting pins. The plain fixes carry no name at all
 * rather than a guessed one.
 *
 * The limit is generous rather than a real cap: this is one person's one day,
 * not the whole team's (see `tracksForDay` for that), so even the fifteen-
 * second sampling `mbos.location.trackEverySeconds` defaults to leaves a
 * twelve-hour day at under 3,000 fixes — a limit of 2,000 here would have
 * started truncating ordinary working days the moment that density shipped.
 */
export async function trackForDay(salesmanId: string, day: string): Promise<TrackPoint[]> {
  const scope = await managerScope();
  /* Scope is applied to the SUBJECT rather than to the rows: a manager who may
     not see this salesman gets an empty day, not somebody else's. */
  if (scope.salesmanIds !== null && !scope.salesmanIds.includes(salesmanId)) return [];

  const rows = (await db.execute<TrackPoint>(sql`
    select p.lat, p.lng, p.at, p.accuracy_m as "accuracyM", null::text as place
      from mbos_positions p
     where p.user_id = ${salesmanId}
       and (p.at ${IST_DAY})::date = ${day}::date
    union all
    select v.check_in_lat, v.check_in_lng, v.check_in_at, v.check_in_accuracy_m, c.name
      from mbos_visits v
      join customers c on c.id = v.customer_id
     where v.salesman_id = ${salesmanId}
       and (v.check_in_at ${IST_DAY})::date = ${day}::date
       and v.check_in_lat is not null
    order by at asc
    limit 20000
  `)) as unknown as TrackPoint[];
  /* drizzle disables postgres.js's own timestamp parsing on the shared client
     so it can apply schema-aware conversion itself — a conversion that only
     runs for typed queries, never for a raw `db.execute`. Every timestamp this
     file's raw queries return is therefore a string on the wire, whatever the
     return type says; `at` is named here rather than left for whoever reads
     `.getTime()` next to discover it. */
  return rows.map((r) => ({ ...r, at: new Date(r.at) }));
}

/**
 * Every salesman's day at once, for the map's second view.
 *
 * One query rather than one per person: eleven round trips to draw one picture
 * is eleven chances for the picture to be half-drawn. The cap is per PERSON —
 * `row_number()` inside the CTE — because a global limit would give whoever
 * synced first the whole budget and leave the rest of the team as dots.
 *
 * Positions are thinned to roughly `perPerson`, spread evenly across however
 * many the day actually holds — never the first `perPerson` in arrival order.
 * At the old five-minute sampling a cap this size was never reached, so a cap
 * that silently truncated instead of thinning went unnoticed; at the current
 * fifteen-second sampling a working day can carry several thousand fixes, and
 * truncating to the earliest `perPerson` would cut the trail off a couple of
 * hours in and lose the rest of the day. Visits are NEVER thinned or capped —
 * they are the points that mean something, and are unioned in after the
 * positions are already down to size.
 */
export async function tracksForDay(
  day: string,
  perPerson = 400,
): Promise<Map<string, TrackPoint[]>> {
  const scope = await managerScope();

  const rows = await db.execute<TrackPoint & { salesmanId: string }>(sql`
    with positions as (
      select p.user_id as "salesmanId", p.lat, p.lng, p.at,
             p.accuracy_m as "accuracyM"
        from mbos_positions p
       where (p.at ${IST_DAY})::date = ${day}::date
         ${onlyMine(scope, "p.user_id")}
    ),
    numbered as (
      select positions.*,
             row_number() over (partition by positions."salesmanId" order by positions.at asc) as rn,
             count(*) over (partition by positions."salesmanId") as total
        from positions
    ),
    positions_thinned as (
      select "salesmanId", lat, lng, at, "accuracyM", null::text as place
        from numbered
       where total <= ${perPerson}
          or rn % greatest(1, ceil(total::numeric / ${perPerson})::int) = 0
    ),
    visits as (
      select v.salesman_id as "salesmanId", v.check_in_lat as lat, v.check_in_lng as lng,
             v.check_in_at as at, v.check_in_accuracy_m as "accuracyM", c.name as place
        from mbos_visits v
        join customers c on c.id = v.customer_id
       where (v.check_in_at ${IST_DAY})::date = ${day}::date
         and v.check_in_lat is not null
         ${onlyMine(scope, "v.salesman_id")}
    )
    select * from positions_thinned
    union all
    select * from visits
    order by "salesmanId", at asc
  `);

  const byPerson = new Map<string, TrackPoint[]>();
  for (const row of rows) {
    const list = byPerson.get(row.salesmanId);
    /* See the comment in `trackForDay`: a raw `db.execute` gets timestamps
       back as strings, whatever TrackPoint's own type says. */
    const point = {
      lat: row.lat,
      lng: row.lng,
      at: new Date(row.at),
      accuracyM: row.accuracyM,
      place: row.place,
    };
    if (list) list.push(point);
    else byPerson.set(row.salesmanId, [point]);
  }
  return byPerson;
}

export type ActivityPoint = {
  salesmanId: string;
  entityType: string;
  entityId: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  capturedAt: Date | null;
  ageSeconds: number | null;
  source: string | null;
};

/**
 * Everything the team did today, and where.
 *
 * The point of recording a place on every activity is that somebody can see
 * it, and this is what they see it on: the day's trail with the work marked
 * along it. An order taken two kilometres off the beat is obvious on a line
 * and invisible in a list.
 *
 * Only rows that HAVE coordinates. A row saying "we asked and there was no
 * fix" is a real fact and belongs on the activity's own record, not as a pin
 * on a map — there is nowhere to put it.
 */
export async function activityPointsForDay(day: string): Promise<ActivityPoint[]> {
  const scope = await managerScope();
  return db.execute<ActivityPoint>(sql`
    select a.user_id as "salesmanId", a.entity_type as "entityType",
           a.entity_id as "entityId", a.lat, a.lng,
           a.accuracy_m as "accuracyM", a.captured_at as "capturedAt",
           a.age_seconds as "ageSeconds", a.source
      from mbos_activity_locations a
     where a.lat is not null and a.lng is not null
       and (a.captured_at ${IST_DAY})::date = ${day}::date
       ${onlyMine(scope, "a.user_id")}
     order by a.captured_at asc
     limit 2000
  `) as unknown as ActivityPoint[];
}

/**
 * Where one activity was done, for the record that shows it.
 *
 * Returns the row even when it has no coordinates, because "we asked and could
 * not get a fix" is the answer in a godown and a screen that showed nothing
 * would be claiming nobody asked.
 */
export async function locationOf(
  entityType: string,
  entityId: string,
): Promise<ActivityPoint & { reason: string | null } | null> {
  const rows = await db.execute<ActivityPoint & { reason: string | null }>(sql`
    select a.user_id as "salesmanId", a.entity_type as "entityType",
           a.entity_id as "entityId", a.lat, a.lng,
           a.accuracy_m as "accuracyM", a.captured_at as "capturedAt",
           a.age_seconds as "ageSeconds", a.source, a.reason
      from mbos_activity_locations a
     where a.entity_type = ${entityType} and a.entity_id = ${entityId}
     limit 1
  `);
  return rows[0] ?? null;
}

export type TerritoryRow = {
  region: string | null;
  city: string;
  beat: string | null;
  salesmanId: string | null;
  salesmanName: string | null;
  shops: number;
  withGps: number;
  outstandingPaise: number;
};

/**
 * Which states, cities and beats belong to whom.
 *
 * Grouped rather than listed: a territory screen answers "who covers Nagpur"
 * and "how much of Karnataka has nobody", and a thousand customer rows answers
 * neither. The customer list itself is a screen away.
 */
export async function territory(): Promise<TerritoryRow[]> {
  const scope = await managerScope();
  return db.execute<TerritoryRow>(sql`
    select c.territory_region as region, c.city, c.beat,
           coalesce(c.sales_am_id, c.owner_id) as "salesmanId",
           u.name as "salesmanName",
           count(*)::int as shops,
           count(*) filter (where c.gps_lat is not null and c.gps_lng is not null)::int as "withGps",
           coalesce(sum(c.outstanding), 0) as "outstandingPaise"
      from customers c
      left join users u on u.id = coalesce(c.sales_am_id, c.owner_id)
     where c.status = 'active' and c.kind = 'customer'
       ${onlyMine(scope, "coalesce(c.sales_am_id, c.owner_id)")}
     group by c.territory_region, c.city, c.beat, coalesce(c.sales_am_id, c.owner_id), u.name
     order by c.territory_region asc nulls last, c.city asc, c.beat asc nulls last
     limit 500
  `) as unknown as TerritoryRow[];
}

export type TeamRegionRow = {
  salesmanId: string;
  salesmanName: string;
  initials: string;
  active: boolean;
  /** The region most of this salesman's own book sits in. Null where they
   * cover no active customers yet. */
  region: string | null;
  cities: string[];
  shopCount: number;
  checkedInToday: boolean;
  onLeaveToday: boolean;
  reportsToId: string | null;
  reportsToName: string | null;
};

/**
 * The field team, each person's own region, and who they report to —
 * everything the Territory screen groups by.
 *
 * A salesman has no region of his own in this schema, only a book of
 * customers that each carry one; `region` here is the one his book has the
 * MOST of, which is the honest answer to "where does this person work"
 * without inventing a field nothing else in MahekOne has. `reportsToId` is
 * the general reporting line every user carries (`access-control.ts` already
 * reads it for scope), not something built for this screen.
 */
export async function teamByRegion(day: string): Promise<TeamRegionRow[]> {
  const scope = await managerScope();
  return db.execute<TeamRegionRow>(sql`
    with counts as (
      select coalesce(c.sales_am_id, c.owner_id) as salesman_id,
             c.territory_region as region,
             count(*) as n
        from customers c
       where c.status = 'active' and c.kind = 'customer'
         and coalesce(c.sales_am_id, c.owner_id) is not null
       group by coalesce(c.sales_am_id, c.owner_id), c.territory_region
    ),
    top_region as (
      select distinct on (salesman_id) salesman_id, region
        from counts
       order by salesman_id, n desc nulls last
    ),
    book as (
      select coalesce(c.sales_am_id, c.owner_id) as salesman_id,
             coalesce(array_agg(distinct c.city order by c.city), '{}') as cities,
             count(*)::int as shop_count
        from customers c
       where c.status = 'active' and c.kind = 'customer'
       group by coalesce(c.sales_am_id, c.owner_id)
    )
    select u.id as "salesmanId", u.name as "salesmanName", u.initials, u.active,
           tr.region,
           coalesce(b.cities, '{}') as cities,
           coalesce(b.shop_count, 0) as "shopCount",
           (d.check_in_at is not null) as "checkedInToday",
           (d.status = 'on_leave') as "onLeaveToday",
           u.reports_to_id as "reportsToId",
           m.name as "reportsToName"
      from users u
      join app_access a on a.user_id = u.id and a.app = 'field'
      left join top_region tr on tr.salesman_id = u.id
      left join book b on b.salesman_id = u.id
      left join mbos_attendance_days d on d.user_id = u.id and d.day = ${day}::date
      left join users m on m.id = u.reports_to_id
     where u.active
       ${onlyMine(scope, "u.id")}
     order by u.name asc
  `) as unknown as TeamRegionRow[];
}

export type PerformanceRow = {
  salesmanId: string;
  salesmanName: string;
  initials: string;
  visits: number;
  verifiedVisits: number;
  orders: number;
  orderValuePaise: number;
  collectedPaise: number;
  newCustomers: number;
  plannedStops: number;
  walkedStops: number;
  daysWorked: number;
};

/**
 * A month, per salesman.
 *
 * There is no target column and that is deliberate. `monthly_targets` is the
 * CRM's, set per telecaller, and nothing sets one for a field salesman — a
 * percentage against a target nobody set would be a number invented on this
 * screen. Achievement is shown as what actually happened, and the screen says
 * what is missing rather than filling it in.
 *
 * Order value is CAPTURED value: an MBOS order sits at pending approval, so
 * this is what the team sold, not what the business booked.
 */
export async function performance(from: string, to: string): Promise<PerformanceRow[]> {
  const scope = await managerScope();
  return db.execute<PerformanceRow>(sql`
    select u.id as "salesmanId", u.name as "salesmanName", u.initials,

           (select count(*)::int from mbos_visits v
             where v.salesman_id = u.id
               and (v.check_in_at ${IST_DAY})::date between ${from}::date and ${to}::date) as "visits",
           (select count(*)::int from mbos_visits v
             where v.salesman_id = u.id and v.verified
               and (v.check_in_at ${IST_DAY})::date between ${from}::date and ${to}::date) as "verifiedVisits",

           (select count(*)::int from orders o
             where o.created_by_id = u.id and o.source = 'mbos'
               and (o.ordered_at ${IST_DAY})::date between ${from}::date and ${to}::date) as "orders",
           (select coalesce(sum(o.total_amount), 0)::bigint from orders o
             where o.created_by_id = u.id and o.source = 'mbos'
               and (o.ordered_at ${IST_DAY})::date between ${from}::date and ${to}::date) as "orderValuePaise",

           (select coalesce(sum(r.amount), 0)::bigint from payment_receipts r
             where r.reported_by_id = u.id and r.source = 'mbos'
               and r.received_at between ${from}::date and ${to}::date
               and r.status <> 'rejected') as "collectedPaise",

           (select count(*)::int from customers c
             where coalesce(c.sales_am_id, c.owner_id) = u.id
               and c.customer_since between ${from}::date and ${to}::date) as "newCustomers",

           (select count(*)::int from mbos_journey_stops s
              join mbos_journey_plans p on p.id = s.plan_id
             where p.user_id = u.id
               and p.plan_date between ${from}::date and ${to}::date) as "plannedStops",
           (select count(*)::int from mbos_journey_stops s
              join mbos_journey_plans p on p.id = s.plan_id
             where p.user_id = u.id and s.status = 'visited'
               and p.plan_date between ${from}::date and ${to}::date) as "walkedStops",

           (select count(*)::int from mbos_attendance_days d
             where d.user_id = u.id and d.check_in_at is not null
               and d.day between ${from}::date and ${to}::date) as "daysWorked"

      from users u
      join app_access a on a.user_id = u.id and a.app = 'field'
     where u.active ${onlyMine(scope, "u.id")}
     order by u.name asc
  `) as unknown as PerformanceRow[];
}

export type LoginRow = {
  salesmanId: string;
  salesmanName: string;
  initials: string;
  active: boolean;
  deviceId: string | null;
  model: string | null;
  platform: string | null;
  appVersion: string | null;
  boundAt: Date | null;
  lastSeenAt: Date | null;
  deviceActive: boolean | null;
  releasedAt: Date | null;
  releaseReason: string | null;
  hasPushToken: boolean | null;
  lastLoginAt: Date | null;
};

/**
 * Which handset each salesman signed in on.
 *
 * The design shows a login LOG — every attempt, its device, where from, and
 * what failed. MahekOne records none of that: there is no failed-attempt table
 * and no location on a sign-in, and the Admin Console deleted its own version
 * of this screen rather than render a fixture. What exists is the device
 * binding — one handset per person, when it was bound, when it last spoke —
 * and that is what this shows.
 */
export async function deviceBindings(): Promise<LoginRow[]> {
  const scope = await managerScope();
  return db.execute<LoginRow>(sql`
    select u.id as "salesmanId", u.name as "salesmanName", u.initials, u.active,
           d.device_id as "deviceId", d.model, d.platform, d.app_version as "appVersion",
           d.bound_at as "boundAt", d.last_seen_at as "lastSeenAt",
           d.active as "deviceActive",
           d.released_at as "releasedAt", d.release_reason as "releaseReason",
           (d.push_token is not null) as "hasPushToken",
           u.last_login_at as "lastLoginAt"
      from users u
      join app_access a on a.user_id = u.id and a.app = 'field'
      left join mbos_devices d on d.user_id = u.id
     where true ${onlyMine(scope, "u.id")}
     order by d.last_seen_at desc nulls last, u.name asc
     limit 200
  `) as unknown as LoginRow[];
}

export type SyncHealthRow = {
  salesmanId: string;
  salesmanName: string;
  initials: string;
  active: boolean;
  deviceId: string | null;
  model: string | null;
  platform: string | null;
  lastSeenAt: Date | null;
  rejected7d: number;
  conflicted7d: number;
  unresolvedConflicts: number;
};

/**
 * Whose handset is actually reaching the office.
 *
 * There is no such thing as "items stuck in the outbox" on this side of the
 * wire — a queued item that has never reached the server leaves no trace
 * here, by the sync contract's own design (see `storeReceipt`'s comment: a
 * `retry` is deliberately never stored, because it is the one answer that
 * must not stick). What CAN be answered from here is narrower and still
 * useful: when a handset last spoke at all, and what the server has actually
 * REFUSED or found in conflict since. A salesman whose phone has not spoken
 * in three days, or whose last ten pushes were all rejected, is the same
 * "something is wrong and nobody in the office knows" this screen exists to
 * surface — it just answers from what the server saw, not from a queue depth
 * nothing here can see.
 */
export async function syncHealth(): Promise<SyncHealthRow[]> {
  const scope = await managerScope();
  const rows = (await db.execute<SyncHealthRow>(sql`
    select u.id as "salesmanId", u.name as "salesmanName", u.initials, u.active,
           d.device_id as "deviceId", d.model, d.platform, d.last_seen_at as "lastSeenAt",
           coalesce(r.rejected, 0)::int as "rejected7d",
           coalesce(r.conflicted, 0)::int as "conflicted7d",
           coalesce(c.unresolved, 0)::int as "unresolvedConflicts"
      from users u
      join app_access a on a.user_id = u.id and a.app = 'field'
      left join mbos_devices d on d.user_id = u.id and d.active
      left join (
        select user_id,
               count(*) filter (where result_json ->> 'status' = 'rejected') as rejected,
               count(*) filter (where result_json ->> 'status' = 'conflict') as conflicted
          from mbos_sync_receipts
         where created_at > now() - interval '7 days'
         group by user_id
      ) r on r.user_id = u.id
      left join (
        select created_by_id, count(*) as unresolved
          from mbos_conflicts
         where flagged_for_review and reviewed_at is null
         group by created_by_id
      ) c on c.created_by_id = u.id
     where true ${onlyMine(scope, "u.id")}
     order by (case when d.last_seen_at is null then 0 else 1 end) asc,
              d.last_seen_at asc nulls first,
              (coalesce(r.rejected, 0) + coalesce(c.unresolved, 0)) desc,
              u.name asc
     limit 300
  `)) as unknown as SyncHealthRow[];
  /* See the comment in `trackForDay`: a raw `db.execute` returns a timestamp
     as a string, whatever this row type says. */
  return rows.map((r) => ({ ...r, lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt) : null }));
}

export type AuditRow = {
  id: string;
  at: Date;
  actorName: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  afterState: unknown;
};

/** Every decision made in this console, with a name against it. */
export async function fieldAudit(limit = 200): Promise<AuditRow[]> {
  return db.execute<AuditRow>(sql`
    select l.id, l.at, u.name as "actorName",
           l.action, l.entity_type as "entityType", l.entity_id as "entityId",
           l.after_state as "afterState"
      from audit_log l
      left join users u on u.id = l.actor_id
     where l.action like 'mbos.%'
        or l.entity_type in ('mbos_approval', 'mbos_journey_plan')
     order by l.at desc
     limit ${limit}
  `) as unknown as AuditRow[];
}

/* ═════════════════════════════════════════════════════════════ enablement */

export type DocumentRow = {
  id: string;
  title: string;
  category: string;
  attachmentId: string | null;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  visibleToRoles: string[];
  customerName: string | null;
  active: boolean;
  updatedAt: Date;
};

/** The library a handset can open. Read-only here; HR and the office own it. */
export async function documents(): Promise<DocumentRow[]> {
  return db.execute<DocumentRow>(sql`
    select d.id, d.title, d.category::text as category,
           d.attachment_id as "attachmentId",
           a.filename, a.content_type as "contentType", a.size_bytes as "sizeBytes",
           d.visible_to_roles as "visibleToRoles",
           c.name as "customerName",
           d.active, d.updated_at as "updatedAt"
      from mbos_documents d
      left join attachments a on a.id = d.attachment_id
      left join customers c on c.id = d.customer_id
     order by d.active desc, d.updated_at desc
     limit 200
  `) as unknown as DocumentRow[];
}

export type CourseRow = {
  id: string;
  title: string;
  category: string | null;
  durationMinutes: number | null;
  mandatory: boolean;
  dueDate: string | null;
  active: boolean;
  /** How many of the field team have finished it, out of how many there are. */
  completed: number;
  started: number;
  team: number;
};

/** Training a salesman is expected to have done, and who has done it. */
export async function courses(): Promise<CourseRow[]> {
  return db.execute<CourseRow>(sql`
    select k.id, k.title, k.category, k.duration_minutes as "durationMinutes",
           k.mandatory, k.due_date::text as "dueDate", k.active,
           (select count(*)::int from mbos_course_progress p
              join app_access a on a.user_id = p.user_id and a.app = 'field'
             where p.course_id = k.id and p.completed_at is not null) as "completed",
           (select count(*)::int from mbos_course_progress p
              join app_access a on a.user_id = p.user_id and a.app = 'field'
             where p.course_id = k.id and p.started_at is not null) as "started",
           (select count(*)::int from users u
              join app_access a on a.user_id = u.id and a.app = 'field'
             where u.active) as "team"
      from mbos_courses k
     order by k.active desc, k.mandatory desc, k.due_date asc nulls last
     limit 200
  `) as unknown as CourseRow[];
}

export type HolidayRow = {
  id: string;
  onDate: string;
  name: string;
  scope: string | null;
  createdAt: Date;
};

/** The days nobody is expected to work. */
export async function holidays(fromYear: number): Promise<HolidayRow[]> {
  return db.execute<HolidayRow>(sql`
    select h.id, h.on_date::text as "onDate", h.name, h.scope,
           h.created_at as "createdAt"
      from mbos_holidays h
     where extract(year from h.on_date) >= ${fromYear}
     order by h.on_date asc
     limit 200
  `) as unknown as HolidayRow[];
}

/* ════════════════════════════════════════════════════════════════ journeys */

export type PlanStop = {
  id: string;
  customerId: string;
  customerName: string;
  area: string | null;
  beat: string | null;
  sequence: number;
  plannedAt: Date | null;
  status: string;
  skipReason: string | null;
  hasGps: boolean;
  gpsLat: number | null;
  gpsLng: number | null;
  outstandingPaise: number;
  lastVisitDate: string | null;
};

export type JourneyPlan = {
  id: string;
  userId: string;
  userName: string;
  planDate: string;
  beat: string | null;
  area: string | null;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  /* ---- the negotiation ---- */
  dayState: "proposed" | "refused" | "agreed" | "planned";
  city: string | null;
  refusalReason: string | null;
  counterCity: string | null;
  proposedAt: Date | null;
  respondedAt: Date | null;
  stops: PlanStop[];
};

/** Every plan for a day, with its stops. */
export async function journeyPlansFor(day: string): Promise<JourneyPlan[]> {
  return journeyPlansBetween(day, day);
}

/**
 * Every plan in a window, with its stops.
 *
 * A window rather than a day because a beat plan is a CYCLE — a manager lays
 * out a fortnight or a month at a time, Monday on one beat and Tuesday on the
 * next — and asking the database once per day for thirty days is thirty round
 * trips to draw one screen. Two queries, whatever the length.
 *
 * `userId` narrows it to one salesman; without it the window covers everybody,
 * which is what the "who has nothing planned" strip reads.
 */
export async function journeyPlansBetween(
  fromDay: string,
  toDay: string,
  userId?: string,
): Promise<JourneyPlan[]> {
  const scope = await managerScope();
  const who = userId ? sql`and p.user_id = ${userId}` : sql``;

  const plans = (await db.execute<Omit<JourneyPlan, "stops">>(sql`
    select p.id, p.user_id as "userId", u.name as "userName",
           p.plan_date::text as "planDate", p.beat, p.area,
           p.status::text as status,
           p.started_at as "startedAt", p.completed_at as "completedAt",
           p.day_state::text as "dayState", p.city,
           p.refusal_reason as "refusalReason", p.counter_city as "counterCity",
           p.proposed_at as "proposedAt", p.responded_at as "respondedAt"
      from mbos_journey_plans p
      join users u on u.id = p.user_id
     where p.plan_date between ${fromDay}::date and ${toDay}::date ${who}
       ${onlyMine(scope, "p.user_id")}
     order by p.plan_date asc, u.name asc
  `)) as unknown as Array<Omit<JourneyPlan, "stops">>;

  if (!plans.length) return [];

  const stops = (await db.execute<PlanStop & { planId: string }>(sql`
    select s.id, s.plan_id as "planId", s.customer_id as "customerId",
           c.name as "customerName", c.area, c.beat,
           s.sequence, s.planned_at as "plannedAt",
           s.status::text as status, s.skip_reason as "skipReason",
           (c.gps_lat is not null and c.gps_lng is not null) as "hasGps",
           c.gps_lat as "gpsLat", c.gps_lng as "gpsLng",
           coalesce(c.outstanding, 0) as "outstandingPaise",
           c.last_visit_date::text as "lastVisitDate"
      from mbos_journey_stops s
      join mbos_journey_plans p on p.id = s.plan_id
      join customers c on c.id = s.customer_id
     where p.plan_date between ${fromDay}::date and ${toDay}::date ${who}
       ${onlyMine(scope, "p.user_id")}
     order by p.plan_date asc, s.sequence asc
  `)) as unknown as Array<PlanStop & { planId: string }>;

  return plans.map((p) => ({
    ...p,
    stops: stops.filter((s) => s.planId === p.id),
  }));
}

/**
 * Active salesmen with nothing planned for a day.
 *
 * The badge that matters most on this app, and the one nobody would think to
 * look for: an empty plan is not an error anywhere, it is simply a salesman
 * who opens his handset tomorrow morning to a blank route and decides for
 * himself where to go. Counted for TOMORROW by default, because a plan made
 * on the day is a plan somebody has already worked around.
 */
export async function unplannedCount(day: string): Promise<number> {
  const scope = await managerScope();
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from users u
      join app_access a on a.user_id = u.id and a.app = 'field'
     where u.active ${onlyMine(scope, "u.id")}
       and not exists (
         select 1 from mbos_journey_plans p
          where p.user_id = u.id and p.plan_date = ${day}::date
       )
  `);
  return Number(rows[0]?.n ?? 0);
}

/** One person's plan for one day, or null where none has been made. */
export async function planFor(
  userId: string,
  day: string,
): Promise<JourneyPlan | null> {
  const plans = await journeyPlansFor(day);
  return plans.find((p) => p.userId === userId) ?? null;
}

/* ════════════════════════════════════════════════════════════ the field book */

export type BookCustomer = {
  id: string;
  name: string;
  city: string;
  area: string | null;
  beat: string | null;
  phone: string;
  salesmanId: string | null;
  salesmanName: string | null;
  hasGps: boolean;
  outstandingPaise: number;
  creditLimitPaise: number | null;
  creditBlocked: boolean;
  healthScore: number | null;
  /** The retention band. See `withHealthBand` — one definition, filled in JS. */
  healthBand: HealthBand | null;
  cycleDays: number | null;
  lastVisitDate: string | null;
  lastOrderDate: string | null;
};

/**
 * The book, by salesman.
 *
 * Whose book a customer is in is `ASSIGNED_TO_SQL` — the sales account manager,
 * falling back to the owner — and not the owner alone. Reading `owner_id` here
 * would drop every customer whose sales AM has been set, which is most of them
 * on any database that has been through a sheet sync.
 */
export async function fieldBook(filter?: {
  salesmanId?: string;
  beat?: string;
  /** Only shops with no coordinates — the gap that breaks route optimisation. */
  missingGpsOnly?: boolean;
  search?: string;
}): Promise<BookCustomer[]> {
  const salesman = filter?.salesmanId
    ? sql`and coalesce(c.sales_am_id, c.owner_id) = ${filter.salesmanId}`
    : sql``;
  const beat = filter?.beat ? sql`and c.beat = ${filter.beat}` : sql``;
  const gps = filter?.missingGpsOnly
    ? sql`and (c.gps_lat is null or c.gps_lng is null)`
    : sql``;
  const scope = await managerScope();
  const search = filter?.search
    ? sql`and (c.name ilike ${"%" + filter.search + "%"}
            or c.phone like ${"%" + filter.search + "%"}
            or c.city ilike ${"%" + filter.search + "%"}
            or coalesce(c.area, '') ilike ${"%" + filter.search + "%"})`
    : sql``;

  const rows = (await db.execute<BookCustomer>(sql`
    select c.id, c.name, c.city, c.area, c.beat, c.phone,
           coalesce(c.sales_am_id, c.owner_id) as "salesmanId",
           u.name as "salesmanName",
           (c.gps_lat is not null and c.gps_lng is not null) as "hasGps",
           coalesce(c.outstanding, 0) as "outstandingPaise",
           c.credit_limit_paise as "creditLimitPaise",
           c.credit_blocked as "creditBlocked",
           c.health_score as "healthScore",
           -- the two facts the band is derived from, so it can be filled in JS
           c.cycle_days as "cycleDays",
           c.last_visit_date::text as "lastVisitDate",
           c.last_order_date::text as "lastOrderDate"
      from customers c
      left join users u on u.id = coalesce(c.sales_am_id, c.owner_id)
     where c.status = 'active' and c.kind = 'customer'
       ${onlyMine(scope, "coalesce(c.sales_am_id, c.owner_id)")}
       ${salesman} ${beat} ${gps} ${search}
     order by c.name asc
     limit 500
  `)) as unknown as BookCustomer[];

  const { getConfig } = await import("../config/store");
  const [config, day] = await Promise.all([getConfig(), today()]);
  /* The same one definition the leads list and the handset payload use. A
     manager arranging somebody's day should be able to see which of these
     shops has gone quiet without opening each one. */
  return rows.map((r) => ({
    ...r,
    healthBand:
      bandFor(
        {
          lastOrderDate: (r.lastOrderDate as BusinessDate | null) ?? null,
          cycleDays: Number(r.cycleDays ?? 0),
        },
        day,
        config,
      )?.band ?? null,
  }));
}

/** How much of the book has no coordinates. A count, and then a decision. */
export async function gpsGap(): Promise<{ missing: number; total: number }> {
  const rows = await db.execute<{ missing: number; total: number }>(sql`
    select count(*) filter (where c.gps_lat is null or c.gps_lng is null)::int as missing,
           count(*)::int as total
      from customers c
     where c.status = 'active' and c.kind = 'customer'
  `);
  return { missing: Number(rows[0]?.missing ?? 0), total: Number(rows[0]?.total ?? 0) };
}

/** The beats somebody has actually written down, for the filter. */
export async function beats(): Promise<string[]> {
  const rows = await db.execute<{ beat: string }>(sql`
    select distinct c.beat from customers c
     where c.beat is not null and c.beat <> '' and c.status = 'active'
     order by c.beat asc
  `);
  return rows.map((r) => r.beat);
}

/* ═══════════════════════════════════════════════════════════ the shop map */

export type ShopPin = {
  id: string;
  name: string;
  city: string;
  area: string | null;
  beat: string | null;
  lat: number;
  lng: number;
  /**
   * True where the pin was looked up from an address rather than captured by
   * standing in the shop.
   *
   * It is on the row rather than derived on the map because the difference is
   * real and often large: an Indian address outside a metro geocodes to the
   * locality centre, which can be several hundred metres from the door.
   * Drawing it identically to a field fix would present a guess as a
   * measurement on the screen a territory is planned from.
   */
  approximate: boolean;
  salesmanId: string | null;
  salesmanName: string | null;
};

/**
 * Every active customer with a coordinate. Unpaged, unlike `fieldBook` —
 * this feeds one map layer rather than a table somebody scrolls, and the
 * whole book is a few thousand points, one GeoJSON payload rather than
 * something worth paginating.
 */
export async function shopPins(): Promise<ShopPin[]> {
  const scope = await managerScope();
  return db.execute<ShopPin>(sql`
    select c.id, c.name, c.city, c.area, c.beat,
           /* The field pin first, then the looked-up one. 503 shops carry an
              address and no pin, and they were absent from this map entirely
              — a shop nobody can see is a shop nobody plans a day around. */
           coalesce(c.gps_lat, c.geocoded_lat) as lat,
           coalesce(c.gps_lng, c.geocoded_lng) as lng,
           /* WHICH KIND OF PIN THIS IS. A geocode is a locality centre often
              enough that drawing it identically to a fix taken in the doorway
              would present a guess as a measurement. The map draws it hollow,
              the same way a stale activity fix is drawn. */
           (c.gps_lat is null) as "approximate",
           coalesce(c.sales_am_id, c.owner_id) as "salesmanId",
           u.name as "salesmanName"
      from customers c
      left join users u on u.id = coalesce(c.sales_am_id, c.owner_id)
     where c.status = 'active' and c.kind = 'customer'
       and coalesce(c.gps_lat, c.geocoded_lat) is not null
       and coalesce(c.gps_lng, c.geocoded_lng) is not null
       ${onlyMine(scope, "coalesce(c.sales_am_id, c.owner_id)")}
  `) as unknown as ShopPin[];
}

export type ProspectPin = {
  id: string;
  name: string;
  territory: string | null;
  industryLabel: string | null;
  lat: number;
  lng: number;
  sourceAddedByName: string | null;
  sourceAddedAt: Date | null;
};

/**
 * Field-collected pins that never matched an existing customer — a shop the
 * team has found, not one MahekOne has a record of. `customerMatchStatus`
 * covers both `unmatched` and `ambiguous`: a held-for-review candidate is not
 * yet a confirmed shop either, and both are worth a manager seeing on the
 * map. Scoped by who pinned it, the same way every other list here narrows
 * by whose work it is.
 */
export async function prospectPins(): Promise<ProspectPin[]> {
  const scope = await managerScope();
  return db.execute<ProspectPin>(sql`
    select p.id, p.name, p.territory, p.industry_label as "industryLabel",
           p.lat, p.lng,
           p.source_added_by_name as "sourceAddedByName",
           p.source_added_at as "sourceAddedAt"
      from field_customer_pins p
     where p.customer_match_status in ('unmatched', 'ambiguous')
       and p.lat is not null and p.lng is not null
       ${onlyMine(scope, "p.added_by_user_id")}
  `) as unknown as ProspectPin[];
}

/* ═════════════════════════════════════════════════════════ the settings */

export type FieldSetting = {
  key: string;
  type: string;
  category: string;
  label: string;
  description: string;
  value: unknown;
  isDefault: boolean;
  min?: number;
  max?: number;
  options?: readonly string[];
  /** Structured settings where an empty box is an answer rather than a typo. */
  nullable?: boolean;
};

/** The section headings, in the order somebody would work through them. */
const SETTING_GROUPS: Array<{ category: string; label: string; blurb: string }> = [
  {
    category: "mbos-location",
    label: "Where somebody is",
    blurb:
      "The geofence and the accuracy a fix has to reach. None of these ever block a salesman — they decide what is flagged.",
  },
  {
    category: "mbos-attendance",
    label: "The working day",
    blurb:
      "What counts as a full day, a half day, and how far a check-in may be from base — including WHERE base is, which was the one number on this screen that had no box. Leave the coordinates empty and no check-in is measured against anything, which is better than measuring every one of them against a guess.",
  },
  {
    category: "mbos-route",
    label: "The order a day is walked in",
    blurb:
      "How the handset sorts today's stops, and what it reckons the day will take. The two speeds price the day in minutes and never change the order; the two below them bound the tidy-up pass, which is work a phone has to do on the spot. Nothing here decides which shops are on the list.",
  },
  {
    category: "mbos-orders",
    label: "Orders",
    blurb:
      "Minimum quantities and the values above which an order needs somebody to say yes.",
  },
  {
    category: "mbos-credit",
    label: "Credit",
    blurb: "How much room a customer has before an order needs approving.",
  },
  {
    category: "mbos-payments",
    label: "Money collected",
    blurb:
      "Cash-in-hand limits and how long somebody has to bank it. A deposit SLA is a personal liability with a clock on it.",
  },
  {
    category: "mbos-expenses",
    label: "Expenses",
    blurb:
      "The bill-photo threshold, and how far back a claim may be dated. What a claim is WORTH is not here and must not come back here — that is the published expense policy, which has versions and effective dates so an old claim keeps the rules it was made under.",
  },
  {
    category: "mbos-leave",
    label: "Leave",
    blurb: "Entitlements and how far ahead leave has to be asked for.",
  },
  {
    category: "mbos-tasks",
    label: "Tasks",
    blurb: "When a task escalates, and whether closing one needs a note.",
  },
  {
    category: "mbos-leads",
    label: "Leads",
    blurb: "When a lead goes stale, when it is archived, and when it escalates.",
  },
  {
    category: "mbos-health",
    label: "Customer health",
    blurb:
      "The seven components and their weights. Unsigned-off — these are a guess at what the business believes and the easiest thing here to change.",
  },
  {
    category: "mbos-sync",
    label: "Sync and the handset",
    blurb:
      "Batch sizes, the offline login window, and what the handset holds. Changing these changes how a phone behaves in a market with no signal.",
  },
  {
    category: "mbos-maps",
    label: "Maps on the handset",
    blurb:
      "What a salesman may save so the map still draws in a market with no signal. The closest zoom is the setting that decides the size — every step in is four times the download.",
  },
  {
    category: "mbos-devices",
    label: "Handsets",
    blurb:
      "Whether a field account may be signed in on more than one phone at a time. Read the setting before changing it — a second live handset is convenient on the Tuesday somebody's phone breaks and permanent afterwards.",
  },
];

/**
 * Every field threshold, grouped, with what it is set to now.
 *
 * Read from the registry rather than listed here, so a setting added to
 * `lib/config/registry.ts` under an `mbos-*` category appears on this screen
 * without anybody remembering to add it — the failure direction that shows up
 * immediately rather than the one that quietly hides a control.
 */
export async function fieldSettings(): Promise<
  Array<{ category: string; label: string; blurb: string; settings: FieldSetting[] }>
> {
  const { SETTINGS } = await import("../config/registry");
  const { getConfig } = await import("../config/store");
  const values = await getConfig();

  const all = SETTINGS.filter((s) => s.key.startsWith("mbos."));

  const groups = SETTING_GROUPS.map((g) => ({
    ...g,
    settings: all
      .filter((s) => s.category === g.category)
      .map((s) => {
        const value = (values as Record<string, unknown>)[s.key];
        return {
          key: s.key,
          type: s.type,
          category: s.category,
          label: s.label,
          description: s.description,
          value,
          isDefault: JSON.stringify(value) === JSON.stringify(s.default),
          min: "min" in s ? (s.min as number) : undefined,
          max: "max" in s ? (s.max as number) : undefined,
          options: "options" in s ? (s.options as readonly string[]) : undefined,
          nullable: "nullable" in s ? (s.nullable as boolean) : undefined,
        };
      }),
  })).filter((g) => g.settings.length > 0);

  /* Anything the groups above have not claimed still gets a home. A setting
   * that exists and appears on no screen is a setting nobody can change. */
  const claimed = new Set(groups.flatMap((g) => g.settings.map((s) => s.key)));
  const rest = all.filter((s) => !claimed.has(s.key));
  if (rest.length) {
    groups.push({
      category: "mbos-other",
      label: "Everything else",
      blurb: "Field settings that have not been given a section yet.",
      settings: rest.map((s) => ({
        key: s.key,
        type: s.type,
        category: s.category,
        label: s.label,
        description: s.description,
        value: (values as Record<string, unknown>)[s.key],
        isDefault:
          JSON.stringify((values as Record<string, unknown>)[s.key]) ===
          JSON.stringify(s.default),
        min: "min" in s ? (s.min as number) : undefined,
        max: "max" in s ? (s.max as number) : undefined,
        options: "options" in s ? (s.options as readonly string[]) : undefined,
        nullable: "nullable" in s ? (s.nullable as boolean) : undefined,
      })),
    });
  }

  return groups;
}

/* ══════════════════════════════════════════════════════════════════ pay */

export type PayRow = {
  salesmanId: string;
  salesmanName: string;
  active: boolean;
  employeeCode: string | null;
  /**
   * Whether that employee was CHOSEN or merely matched.
   *
   * `guessed` means nobody has linked this account and the old email-or-mobile
   * heuristic found the row — which on this book is rare and, where it does
   * fire, is matching an account against whichever of two same-named payroll
   * rows happened to share a number. A pay figure arrived at that way is worth
   * saying out loud rather than printing beside a chosen one as though the two
   * were the same kind of fact.
   */
  employeeMatch: "linked" | "guessed";
  employeeStatus: string | null;
  netSalaryPaise: number | null;
  conveyancePaise: number | null;
  otherSalaryPaise: number | null;
  pfEsicApplicable: boolean | null;
  dateOfJoining: string | null;
  /** Days worked in the window. What a month's pay is actually against. */
  daysWorked: number;
  daysOnLeave: number;
  /** Expenses approved in the window — reimbursed, not salary. */
  reimbursedPaise: number;
};

/**
 * What each salesman is paid, read from the employee master.
 *
 * `DECISIONS.md` settled this before MBOS shipped: **salary is read-only and
 * reads what payroll publishes.** HR maintains the employee workbook, HRMS
 * mirrors it hash-for-hash, and this reads that mirror — nothing here writes a
 * figure and no MBOS table holds one.
 *
 * The match is email then company mobile, the same rule the Access screen uses
 * to find a person's employee record. Two rules for "which employee is this
 * account" is how one of them ends up finding somebody the other does not.
 *
 * Days worked and reimbursements sit beside the pay because they are what a
 * month's figure is actually against — but neither is combined with it. An
 * expense reimbursement is money owed back, not earnings, and adding them
 * would produce a number that is neither.
 */
export async function payForPeriod(from: string, to: string): Promise<PayRow[]> {
  const scope = await managerScope();
  return db.execute<PayRow>(sql`
    select u.id as "salesmanId", u.name as "salesmanName", u.active,
           e.employee_code as "employeeCode",
           ${employeeLinkKindSql("u")} as "employeeMatch",
           e.status_raw as "employeeStatus",
           e.net_salary_paise as "netSalaryPaise",
           e.conveyance_paise as "conveyancePaise",
           e.other_salary_paise as "otherSalaryPaise",
           e.pf_esic_applicable as "pfEsicApplicable",
           e.date_of_joining::text as "dateOfJoining",

           (select count(*)::int from mbos_attendance_days d
             where d.user_id = u.id and d.check_in_at is not null
               and d.day between ${from}::date and ${to}::date) as "daysWorked",
           (select count(*)::int from mbos_attendance_days d
             where d.user_id = u.id and d.status = 'on_leave'
               and d.day between ${from}::date and ${to}::date) as "daysOnLeave",

           coalesce((select sum(coalesce(ap.approved_amount_paise, ex.amount_paise))
                       from mbos_expenses ex
                       join mbos_approvals ap
                         on ap.subject_id = ex.id and ap.type = 'expense_claim'
                      where ex.user_id = u.id
                        and ap.state in ('approved', 'partially_approved')
                        and ex.expense_date between ${from}::date and ${to}::date), 0)
             as "reimbursedPaise"

      from users u
      join app_access a on a.user_id = u.id and a.app = 'field'
      /* The link somebody made, falling back to the old email-or-mobile guess
         where nobody has made one -- see lib/employee-link.ts, which the
         handset's own copy of these figures reads too. The guess alone matched
         almost nobody on the real book, so this screen showed a blank salary
         for every field salesman with no way to say whether that meant unpaid
         or unknown. */
      left join employees e on ${employeeJoinOn("u", "e")}
     where u.active ${onlyMine(scope, "u.id")}
     order by u.name asc
  `) as unknown as PayRow[];
}

/* ═══════════════════════════════════════════════════ who covers what */

export type ManagerRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  regions: string[];
};

/**
 * Everybody who holds the Sales Dashboard, and the patch each covers.
 *
 * No regions means national, and the screen says so in words rather than
 * leaving an empty cell — an empty cell reads as "not set up yet" when it
 * actually means "sees everything".
 */
export async function managers(): Promise<ManagerRow[]> {
  return db.execute<ManagerRow>(sql`
    select u.id, u.name, u.email, u.role::text as role, u.active,
           coalesce(
             -- REGIONS ONLY, and from the renamed table. It also holds a
             -- salesman's working cities now, and listing one of those as a
             -- manager's patch would show "Nagpur" as somewhere they oversee.
             (select array_agg(t.region order by t.region)
                from mbos_user_territories t
               where t.user_id = u.id and t.kind = 'region'),
             '{}'
           ) as regions
      from users u
      join app_access a on a.user_id = u.id and a.app = 'sales'
     order by u.active desc, u.name asc
  `) as unknown as ManagerRow[];
}

/**
 * The regions the customer book actually names.
 *
 * Read from `customers.territory_region` rather than a list of its own: a
 * region is whatever the book says it is, and a second list would offer this
 * screen regions nobody's shops are in.
 */
export async function knownRegions(): Promise<string[]> {
  /* The SAME expression the filter matches on — see `TERRITORY_REGION_SQL`.
     Read straight off `territory_region` this came back EMPTY on the real book,
     so the patch dialog offered no chips and no manager's patch could ever be
     set; and a row inserted by hand would have matched nothing and blanked that
     manager's console. A chip list and a filter that read different columns is
     how a screen offers a place no book is in. */
  const rows = await db.execute<{ region: string }>(sql`
    select distinct ${sql.raw(qualify(TERRITORY_REGION_SQL, "c"))} as region
      from customers c
     where ${sql.raw(qualify(TERRITORY_REGION_SQL, "c"))} is not null
     order by 1
  `);

  /* ONE CHIP PER PLACE, however the sheet spelled it.
     
     The book holds 24 distinct strings for about 20 places — Gujrat 97 beside
     Gujarat 31, Chhattisgadh 14 beside Chhattisgarh 19, TAMIL NADU beside
     Tamilnadu. Offered raw, each spelling was its own chip and its own
     territory: allocating "Gujarat" gave somebody 31 customers and silently
     withheld 97, which is worse than an empty result because the screen looks
     like it worked.
     
     `canonicalState` is the same fold `territoryClause` matches on, so a chip
     and the filter behind it cannot disagree about which customers a place
     has. A spelling this file has not been taught is kept as typed rather than
     guessed into a neighbour — a state nobody listed is likelier than a typo,
     and folding it on a string edit would move customers between
     territories. */
  const seen = new Map<string, string>();
  for (const r of rows) {
    const name = canonicalState(r.region);
    if (name && !seen.has(stateKey(name))) seen.set(stateKey(name), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * THE PLACES THE BOOK ACTUALLY USES, as the tree they form.
 *
 * A city belongs to a state and a beat to a city, so this is one query grouped
 * rather than three flat lists. Flat lists are what the dialog had, and on this
 * book that meant every city value in the country under one heading — several
 * hundred of them, most of them not cities at all but whole postal addresses
 * the sheet dropped into the column ("06, MAHADEV TOWERS CO-OP HSG SOC, LTD,
 * LBS MARG, HARINIWAS CIRCLE, Thane, Maharashtra, 400602"). Nesting does not
 * clean that data and cannot; what it does is make it reachable, because a
 * state's worth of it is a list somebody can search and the country's is not.
 *
 * Read off `customers` rather than kept as a list of their own, exactly as
 * `knownRegions` is and for the same reason: a separate list would offer places
 * no customer is in, and a territory that matches nothing is a book that goes
 * quietly empty.
 *
 * Trimmed and deduplicated case-insensitively, because "Nagpur", "nagpur " and
 * "NAGPUR" are one city typed by three people — and the filter that reads these
 * compares the same way, so the dialog must not offer three chips that behave
 * as one. States are folded by `canonicalState`, the same fold the clause
 * matches on, so a chip and the filter behind it cannot disagree about which
 * customers a place has.
 */
export type BeatNode = { beat: string; shops: number };

export type PlaceNode = {
  city: string;
  beats: BeatNode[];
  /** How many shops carry it. The dialog prints it — a city of 1 is usually a typo. */
  shops: number;
};

export type StateNode = {
  state: string;
  cities: PlaceNode[];
  shops: number;
};

export type PlaceTree = {
  states: StateNode[];
  /**
   * SHOPS THAT NAME NO STATE, counted and never hidden.
   *
   * They cannot be allocated: every branch of the tree starts at a state, and a
   * row with nothing in `region` matches no state row. Under the old rule they
   * reached whoever held their book anyway; under the new one they reach
   * nobody, which is a real consequence of switching the default off and is
   * therefore said out loud on the screen rather than left to be discovered.
   */
  statelessShops: number;
};

export async function knownPlaces(): Promise<PlaceTree> {
  const rows = await db.execute<{
    region: string | null;
    city: string | null;
    beat: string | null;
    shops: number;
  }>(sql`
    select ${sql.raw(qualify(TERRITORY_REGION_SQL, "c"))} as region,
           nullif(trim(c.city), '') as city,
           nullif(trim(c.beat), '') as beat,
           count(*)::int as shops
      from customers c
     group by 1, 2, 3
  `);

  /* Keyed on the fold, valued on the first spelling seen, so the tree carries
     one node per place however many ways the sheet spelled it. */
  const states = new Map<string, StateNode>();
  let statelessShops = 0;

  for (const r of rows) {
    const state = canonicalState(r.region);
    if (!state) {
      statelessShops += r.shops;
      continue;
    }

    const sKey = stateKey(state);
    let node = states.get(sKey);
    if (!node) {
      node = { state, cities: [], shops: 0 };
      states.set(sKey, node);
    }
    node.shops += r.shops;

    if (!r.city) continue;
    const cKey = r.city.toLowerCase();
    let city = node.cities.find((c) => c.city.toLowerCase() === cKey);
    if (!city) {
      city = { city: r.city, beats: [], shops: 0 };
      node.cities.push(city);
    }
    city.shops += r.shops;

    if (r.beat) {
      const beat = city.beats.find((b) => b.beat.toLowerCase() === r.beat!.toLowerCase());
      if (beat) beat.shops += r.shops;
      else city.beats.push({ beat: r.beat, shops: r.shops });
    }
  }

  /* Biggest first inside a state: the city somebody means is almost always one
     of the few with real shop counts, and the long tail is address strings. */
  for (const node of states.values()) {
    node.cities.sort((a, b) => b.shops - a.shops || a.city.localeCompare(b.city));
    for (const c of node.cities) {
      c.beats.sort((a, b) => b.shops - a.shops || a.beat.localeCompare(b.beat));
    }
  }

  return {
    states: [...states.values()].sort((a, b) => a.state.localeCompare(b.state)),
    statelessShops,
  };
}

/* ══════════════════════════════════════════════════ one salesman's record */

export type SalesmanRecord = {
  salesman: Salesman;
  visits: Array<{
    id: string;
    customerName: string;
    checkInAt: Date | null;
    durationSeconds: number | null;
    outcome: string;
    notes: string | null;
    transcript: string | null;
    verified: boolean;
    locationMismatch: boolean;
    unverifiedReason: string | null;
  }>;
  orders: Array<{
    id: string;
    orderNo: string | null;
    customerName: string;
    orderedAt: Date;
    totalAmountPaise: number;
    status: string;
  }>;
  receipts: Array<{
    id: string;
    receiptNo: string | null;
    customerName: string;
    receivedAt: string;
    amountPaise: number;
    mode: string;
    status: string;
    depositedAt: Date | null;
  }>;
  attendance: Array<{
    day: string;
    checkInAt: Date | null;
    checkOutAt: Date | null;
    status: string;
    withinGeofence: boolean | null;
    regularisationRequested: boolean;
  }>;
  leave: Array<{
    id: string;
    leaveType: string;
    fromDate: string;
    toDate: string;
    halfDay: boolean;
    days: number;
    reason: string | null;
    cancelledAt: Date | null;
    state: string | null;
  }>;
  expenses: Array<{
    id: string;
    category: string;
    amountPaise: number;
    expenseDate: string;
    remarks: string | null;
    state: string | null;
  }>;
  samples: Array<{
    id: string;
    customerName: string;
    productName: string | null;
    quantityCans: number | null;
    requestedDate: string | null;
    followUpDate: string | null;
    state: string | null;
  }>;
  leads: Array<{
    id: string;
    name: string;
    companyName: string | null;
    mobile: string;
    city: string | null;
    stage: string;
    nextFollowUpDate: string | null;
    lastActivityDate: string | null;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    priority: string;
    dueDate: string | null;
    status: string;
    customerName: string | null;
  }>;
};

/**
 * Everything MBOS has recorded for one person.
 *
 * Nine lists in one function and one round trip's worth of parallel queries,
 * because the screen shows them as tabs of a single record. Each is capped:
 * this is a record to look through, not an export, and an unbounded select on a
 * salesman with four years of visits is a page nobody can open.
 */
export async function salesmanRecord(
  userId: string,
  limit = 60,
): Promise<SalesmanRecord | null> {
  /* `fieldTeam` is scoped, so somebody outside this manager's patch is simply
   * not in the list — and the screen answers 404 rather than confirming that
   * an id belongs to a real account somewhere else in the country. */
  const team = await fieldTeam();
  const salesman = team.find((s) => s.id === userId);
  if (!salesman) return null;

  const [visits, orders, receipts, attendance, leave, expenses, samples, leads, tasks] =
    await Promise.all([
      db.execute(sql`
        select v.id, c.name as "customerName", v.check_in_at as "checkInAt",
               v.duration_seconds as "durationSeconds", v.outcome::text as outcome,
               v.notes, v.transcript,
               v.verified, v.location_mismatch as "locationMismatch",
               v.unverified_reason as "unverifiedReason"
          from mbos_visits v join customers c on c.id = v.customer_id
         where v.salesman_id = ${userId}
         order by v.check_in_at desc nulls last limit ${limit}
      `),
      db.execute(sql`
        select o.id, o.order_no as "orderNo", c.name as "customerName",
               o.ordered_at as "orderedAt", o.total_amount as "totalAmountPaise",
               o.status::text as status
          from orders o join customers c on c.id = o.customer_id
         where o.created_by_id = ${userId} and o.source = 'mbos'
         order by o.ordered_at desc limit ${limit}
      `),
      db.execute(sql`
        select r.id, r.receipt_no as "receiptNo", c.name as "customerName",
               r.received_at::text as "receivedAt", r.amount as "amountPaise",
               r.mode, r.status::text as status, r.deposited_at as "depositedAt"
          from payment_receipts r join customers c on c.id = r.customer_id
         where r.reported_by_id = ${userId} and r.source = 'mbos'
         order by r.received_at desc limit ${limit}
      `),
      db.execute(sql`
        select d.day::text as day, d.check_in_at as "checkInAt",
               d.check_out_at as "checkOutAt", d.status::text as status,
               d.within_geofence as "withinGeofence",
               d.regularisation_requested as "regularisationRequested"
          from mbos_attendance_days d
         where d.user_id = ${userId}
         order by d.day desc limit ${limit}
      `),
      db.execute(sql`
        select l.id, l.leave_type::text as "leaveType",
               l.from_date::text as "fromDate", l.to_date::text as "toDate",
               l.half_day as "halfDay", l.days, l.reason, l.cancelled_at as "cancelledAt",
               (select ap.state::text from mbos_approvals ap
                 where ap.subject_id = l.id and ap.type = 'leave'
                 order by ap.requested_at desc limit 1) as state
          from mbos_leave_requests l
         where l.user_id = ${userId}
         order by l.from_date desc limit ${limit}
      `),
      db.execute(sql`
        select e.id, e.category::text as category, e.amount_paise as "amountPaise",
               e.expense_date::text as "expenseDate", e.remarks,
               (select ap.state::text from mbos_approvals ap
                 where ap.subject_id = e.id and ap.type = 'expense_claim'
                 order by ap.requested_at desc limit 1) as state
          from mbos_expenses e
         where e.user_id = ${userId}
         order by e.expense_date desc limit ${limit}
      `),
      db.execute(sql`
        select s.id, c.name as "customerName", p.name as "productName",
               s.quantity_cans as "quantityCans",
               s.requested_date::text as "requestedDate",
               s.follow_up_date::text as "followUpDate",
               (select ap.state::text from mbos_approvals ap
                 where ap.subject_id = s.id and ap.type = 'sample'
                 order by ap.requested_at desc limit 1) as state
          from mbos_samples s
          join customers c on c.id = s.customer_id
          left join products p on p.id = s.product_id
         where s.salesman_id = ${userId}
         order by s.requested_date desc nulls last limit ${limit}
      `),
      db.execute(sql`
        select c.id, c.name, c.company_name as "companyName", c.phone as mobile, c.city,
               c.lead_stage::text as stage,
               c.lead_next_follow_up_date::text as "nextFollowUpDate",
               c.lead_last_activity_date::text as "lastActivityDate"
          from customers c
         where c.owner_id = ${userId} and c.lead_stage is not null
           and c.lead_archived = false
         order by c.lead_last_activity_date desc nulls last limit ${limit}
      `),
      db.execute(sql`
        select t.id, t.title, t.priority::text as priority,
               t.due_date::text as "dueDate", t.status::text as status,
               c.name as "customerName"
          from mbos_tasks t
          left join customers c on c.id = t.customer_id
         where t.assigned_to_user_id = ${userId}
           and t.status in ('open', 'in_progress')
         order by t.due_date asc nulls last limit ${limit}
      `),
    ]);

  return {
    salesman,
    visits: visits as never,
    orders: orders as never,
    receipts: receipts as never,
    attendance: attendance as never,
    leave: leave as never,
    expenses: expenses as never,
    samples: samples as never,
    leads: leads as never,
    tasks: tasks as never,
  };
}

/* ══════════════════════════════════════ leave, per person */

export type EntitlementRow = {
  userId: string;
  name: string;
  balances: LeaveBalance[];
  /** The kinds this person has a stored figure for, as against the default. */
  overridden: string[];
};

/**
 * What each salesman may take this year, and how much is left.
 *
 * The entitlement itself is CONFIGURATION — `mbos.leave.annualEntitlementDays`
 * — and a row in `mbos_leave_balances` overrides it for one person. That much
 * already worked. What did not exist was any way to WRITE such a row: nothing
 * in MahekOne created one, so the override was a mechanism with no door, and a
 * salesman on different terms could not be given them.
 *
 * Read through `leaveBalances`, the same engine the handset's own figures come
 * through, so this screen and the phone in somebody's pocket cannot disagree
 * about how many days remain.
 */
export async function leaveEntitlements(year: number): Promise<EntitlementRow[]> {
  const scope = await managerScope();
  const { getConfig } = await import("../config/store");

  const [people, overrideRows, usedRows, config] = await Promise.all([
    db.execute<{ userId: string; name: string }>(sql`
      select u.id as "userId", u.name
        from users u
        join app_access a on a.user_id = u.id and a.app = 'field'
       where u.active ${onlyMine(scope, "u.id")}
       order by u.name asc
    `),
    db.execute<{ userId: string; kind: string; entitled: number }>(sql`
      select b.user_id as "userId", b.leave_type::text as kind, b.entitled_days as entitled
        from mbos_leave_balances b
       where b.year = ${year}
    `),
    /* The approved requests, not a stored sum — what a request costs is
       `leaveDebitDays`, and spelling that arithmetic out in SQL as well is how
       two answers to "how much has he taken" come to exist. */
    db.execute<{ userId: string; kind: string; days: number; halfDay: boolean }>(sql`
      select r.user_id as "userId", r.leave_type::text as kind, r.days, r.half_day as "halfDay"
        from mbos_leave_requests r
        join mbos_approvals ap on ap.subject_id = r.id and ap.type = 'leave'
       where ap.state in ('approved', 'partially_approved')
         and r.cancelled_at is null
         and extract(year from r.from_date) = ${year}
    `),
    getConfig(),
  ]);

  const entitlement = config["mbos.leave.annualEntitlementDays"] ?? {};

  const overridesBy = new Map<string, Record<string, number>>();
  for (const r of overrideRows as unknown as { userId: string; kind: string; entitled: number }[]) {
    const forUser = overridesBy.get(r.userId) ?? {};
    forUser[r.kind] = r.entitled;
    overridesBy.set(r.userId, forUser);
  }

  const usedBy = new Map<string, Record<string, number>>();
  for (const r of usedRows as unknown as { userId: string; kind: string; days: number; halfDay: boolean }[]) {
    const forUser = usedBy.get(r.userId) ?? {};
    forUser[r.kind] = (forUser[r.kind] ?? 0) + leaveDebitDays(Number(r.days), r.halfDay);
    usedBy.set(r.userId, forUser);
  }

  return (people as unknown as { userId: string; name: string }[]).map((p) => ({
    userId: p.userId,
    name: p.name,
    balances: leaveBalancesFor(entitlement, usedBy.get(p.userId) ?? {}, overridesBy.get(p.userId) ?? {}),
    overridden: Object.keys(overridesBy.get(p.userId) ?? {}),
  }));
}
