import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "../business-date";
import {
  lastKnownPositions,
  trackForDay,
  visitsBetween,
  type LastKnown,
  type TrackPoint,
  type VisitRow,
} from "./sales-service";

/* ---------------------------------------------------------------------------
 * EVERYTHING ONE SALESMAN DID ON ONE DAY, for the page Today and the Live map
 * open in a new tab (`/sales/live/[id]`).
 *
 * Every read here is one the Sales Dashboard already makes for the whole team,
 * asked of one person — the visits are `visitsBetween`, the trail is
 * `trackForDay`, the pin is `lastKnownPositions` — so a figure on this page and
 * the same figure on the team's screens cannot disagree.
 *
 * SCOPE IS ASKED ONCE, ON THE SUBJECT. `lastKnownPositions` is already narrowed
 * to this manager's team; a salesman who is not in it answers null, and the
 * page says so rather than showing somebody else's day.
 * ------------------------------------------------------------------------- */

const IST_DAY = sql.raw(`at time zone '${APP_TIMEZONE}'`);

export type DayAttendance = {
  sessions: { inAt: string | null; outAt: string | null }[];
  checkInAt: Date | null;
  checkOutAt: Date | null;
  checkInAddress: string | null;
  checkOutAddress: string | null;
  withinGeofence: boolean | null;
  geofenceDistanceM: number | null;
  regularisationReason: string | null;
  autoCheckedOut: boolean;
  status: string | null;
  workedSeconds: number | null;
  /** How he said he was travelling at the punch-in, and the meter either end. */
  vehicle: string | null;
  odometerStartKm: number | null;
  odometerEndKm: number | null;
};

export type DayPlan = {
  city: string | null;
  dayState: string | null;
  stops: {
    customerId: string;
    customerName: string;
    customerKind: string;
    thirdParty: boolean;
    sequence: number | null;
    status: string;
    actualVisitAt: Date | null;
    skipReason: string | null;
  }[];
};

export type DayOrder = {
  id: string;
  at: Date;
  customerId: string | null;
  customerName: string | null;
  totalPaise: number;
  status: string;
  lines: number;
  visitId: string | null;
};

export type DayPayment = {
  id: string;
  at: Date;
  customerId: string | null;
  customerName: string | null;
  amountPaise: number;
  mode: string | null;
  status: string;
  visitId: string | null;
};

/** Every other act the handset recorded, with the facts each kind carries. */
export type DayAct = {
  entityType: string;
  entityId: string;
  at: Date;
  lat: number | null;
  lng: number | null;
  noFixReason: string | null;
  customerId: string | null;
  customerName: string | null;
  customerKind: string | null;
  /** One line about it — the sample's product, the complaint's category, the task's title. */
  detail: string | null;
  status: string | null;
};

export type SalesmanDayDetail = {
  person: LastKnown;
  attendance: DayAttendance | null;
  plan: DayPlan | null;
  visits: VisitRow[];
  orders: DayOrder[];
  payments: DayPayment[];
  acts: DayAct[];
  trail: TrackPoint[];
};

export async function salesmanDay(salesmanId: string, day: string): Promise<SalesmanDayDetail | null> {
  const team = await lastKnownPositions(day);
  const person = team.find((r) => r.salesmanId === salesmanId);
  if (!person) return null;

  const [attendance, plan, visits, orders, payments, acts, trail] = await Promise.all([
    attendanceOf(salesmanId, day),
    planOf(salesmanId, day),
    visitsBetween({ from: day, to: day, salesmanId }),
    ordersOf(salesmanId, day),
    paymentsOf(salesmanId, day),
    actsOf(salesmanId, day),
    trackForDay(salesmanId, day),
  ]);

  return { person, attendance, plan, visits, orders, payments, acts, trail };
}

async function attendanceOf(userId: string, day: string): Promise<DayAttendance | null> {
  const [row] = (await db.execute(sql`
    select coalesce(d.sessions, '[]'::jsonb) as sessions,
           d.check_in_at as "checkInAt", d.check_out_at as "checkOutAt",
           d.check_in_address as "checkInAddress", d.check_out_address as "checkOutAddress",
           d.within_geofence as "withinGeofence", d.geofence_distance_m as "geofenceDistanceM",
           d.regularisation_reason as "regularisationReason",
           coalesce(d.auto_checked_out, false) as "autoCheckedOut",
           d.status::text as status, d.worked_seconds as "workedSeconds",
           (select coalesce(m.label, l.mode_key)
              from mbos_travel_legs l
              left join mbos_travel_modes m on m.key = l.mode_key
             where l.user_id = d.user_id and l.origin = 'session'
               and (l.started_at ${IST_DAY})::date = d.day
             order by l.started_at asc limit 1) as vehicle,
           (select l.odometer_start_km from mbos_travel_legs l
             where l.user_id = d.user_id and l.origin = 'session'
               and (l.started_at ${IST_DAY})::date = d.day
             order by l.started_at asc limit 1) as "odometerStartKm",
           (select l.odometer_end_km from mbos_travel_legs l
             where l.user_id = d.user_id and l.origin = 'session'
               and (l.started_at ${IST_DAY})::date = d.day
             order by l.started_at desc limit 1) as "odometerEndKm"
      from mbos_attendance_days d
     where d.user_id = ${userId} and d.day = ${day}::date
  `)) as unknown as DayAttendance[];
  if (!row) return null;
  /* Raw `db.execute` hands timestamps back as strings — see `trackForDay`. */
  return {
    ...row,
    checkInAt: row.checkInAt ? new Date(row.checkInAt) : null,
    checkOutAt: row.checkOutAt ? new Date(row.checkOutAt) : null,
    sessions: normaliseSessions(row.sessions),
  };
}

/** The handset stores instants as epoch milliseconds; older rows as text. */
function normaliseSessions(raw: unknown): DayAttendance["sessions"] {
  if (!Array.isArray(raw)) return [];
  const iso = (v: unknown) =>
    v == null ? null : typeof v === "number" ? new Date(v).toISOString() : String(v);
  return raw.map((s: { inAt?: unknown; outAt?: unknown }) => ({ inAt: iso(s?.inAt), outAt: iso(s?.outAt) }));
}

async function planOf(userId: string, day: string): Promise<DayPlan | null> {
  const [plan] = (await db.execute<{ id: string; city: string | null; dayState: string | null }>(sql`
    select p.id, p.city, p.day_state::text as "dayState"
      from mbos_journey_plans p
     where p.user_id = ${userId} and p.plan_date = ${day}::date
     limit 1
  `)) as unknown as { id: string; city: string | null; dayState: string | null }[];
  if (!plan) return null;
  const stops = (await db.execute(sql`
    select s.customer_id as "customerId", c.name as "customerName", c.kind::text as "customerKind",
           c.third_party as "thirdParty", s.sequence, s.status::text as status,
           s.actual_visit_at as "actualVisitAt", s.skip_reason as "skipReason"
      from mbos_journey_stops s
      join customers c on c.id = s.customer_id
     where s.plan_id = ${plan.id}
     order by s.sequence asc nulls last, c.name asc
  `)) as unknown as DayPlan["stops"];
  return {
    city: plan.city,
    dayState: plan.dayState,
    stops: stops.map((s) => ({ ...s, actualVisitAt: s.actualVisitAt ? new Date(s.actualVisitAt) : null })),
  };
}

async function ordersOf(userId: string, day: string): Promise<DayOrder[]> {
  const rows = (await db.execute(sql`
    select o.id, o.ordered_at as at, o.customer_id as "customerId", c.name as "customerName",
           o.total_amount as "totalPaise", o.status::text as status,
           coalesce(jsonb_array_length(case when jsonb_typeof(o.line_items) = 'array' then o.line_items end), 0)::int as lines,
           o.visit_id as "visitId"
      from orders o
      left join customers c on c.id = o.customer_id
     where o.created_by_id = ${userId} and o.source = 'mbos'
       and (o.ordered_at ${IST_DAY})::date = ${day}::date
     order by o.ordered_at asc
  `)) as unknown as DayOrder[];
  return rows.map((r) => ({ ...r, at: new Date(r.at), totalPaise: Number(r.totalPaise ?? 0) }));
}

async function paymentsOf(userId: string, day: string): Promise<DayPayment[]> {
  const rows = (await db.execute(sql`
    select r.id, r.created_at as at, r.customer_id as "customerId", c.name as "customerName",
           r.amount as "amountPaise", r.mode, r.status::text as status, r.visit_id as "visitId"
      from payment_receipts r
      left join customers c on c.id = r.customer_id
     where r.reported_by_id = ${userId} and r.source = 'mbos'
       and r.received_at = ${day}::date
     order by r.created_at asc
  `)) as unknown as DayPayment[];
  return rows.map((r) => ({ ...r, at: new Date(r.at), amountPaise: Number(r.amountPaise ?? 0) }));
}

/**
 * Every other act, off `mbos_activity_locations` — the one place every write
 * the handset makes is recorded with where it was made. Orders and payments
 * are read off their own tables above, so they are left out here; so are
 * visits and the punch, which the page has in full.
 */
async function actsOf(userId: string, day: string): Promise<DayAct[]> {
  const rows = (await db.execute(sql`
    select a.entity_type as "entityType", a.entity_id as "entityId",
           coalesce(a.captured_at, a.created_at) as at,
           a.lat, a.lng, a.reason as "noFixReason",
           coalesce(lc.id, sc.id, cc.id, tc.id) as "customerId",
           coalesce(lc.name, sc.name, cc.name, tc.name) as "customerName",
           coalesce(lc.kind, sc.kind, cc.kind, tc.kind)::text as "customerKind",
           case a.entity_type
             when 'sample' then concat_ws(' · ', p.name,
                                case when s.quantity_cans is not null then s.quantity_cans || ' cans' end)
             when 'complaint' then concat_ws(' · ', replace(cm.category::text, '_', ' '), left(cm.description, 140))
             when 'task' then t.title
             when 'lead' then replace(lc.lead_stage::text, '_', ' ')
           end as detail,
           case a.entity_type
             when 'sample' then s.state::text
             when 'complaint' then cm.status::text
             when 'task' then t.status::text
           end as status
      from mbos_activity_locations a
      left join customers lc on a.entity_type in ('lead', 'customer') and lc.id = a.entity_id
      left join mbos_samples s on a.entity_type = 'sample' and s.id = a.entity_id
      left join products p on p.id = s.product_id
      left join customers sc on sc.id = s.customer_id
      left join complaints cm on a.entity_type = 'complaint' and cm.id = a.entity_id
      left join customers cc on cc.id = cm.customer_id
      left join mbos_tasks t on a.entity_type = 'task' and t.id = a.entity_id
      left join customers tc on tc.id = t.customer_id
     where a.user_id = ${userId}
       and (coalesce(a.captured_at, a.created_at) ${IST_DAY})::date = ${day}::date
       and a.entity_type not in ('visit', 'order', 'payment', 'attendance')
     order by coalesce(a.captured_at, a.created_at) asc
     limit 500
  `)) as unknown as DayAct[];
  return rows.map((r) => ({ ...r, at: new Date(r.at) }));
}
