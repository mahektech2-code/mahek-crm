import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, mbosVisits, users } from "@/db/schema";
import { canOpen } from "@/lib/access";
import { calendarDate } from "@/lib/business-date";
import { visitOutcomeLabel } from "@/lib/lead-activity";
import { managerNameByEmployeeName } from "@/lib/services/org-service";

/* ---------------------------------------------------------------------------
 * CHECK VISITS — a superior reading the visits their own salesmen made.
 *
 * WHO COUNTS AS "THEIRS" is the reporting line MahekOne already keeps, read
 * the way every other team question here reads it, and nothing is added:
 *
 *   • `users.reports_to_id` — the line the scope resolver uses for a
 *     manager's team (`access-control.ts`), and
 *   • the Org Chart (`employee_reporting`), through `managerNameByEmployeeName`
 *     — the same map the nightly Sales Manager pass reads.
 *
 * Both are DIRECT reports. That is the authoritative rule today: the scope
 * resolver does not walk a chain, and a manager's manager is not given their
 * reports' books anywhere else in the product, so this does not either. The
 * Org Chart can draw deeper levels; if somebody wants a head to see a level
 * down, it is one decision made here, for every screen, rather than a quiet
 * widening in one of them.
 *
 * It is deliberately NOT `managedSalesmen`: that one also counts a salesman
 * who merely works a book under somebody's Sales Manager SEAT, which is a
 * customer assignment and not a reporting line. A seat is not a boss.
 *
 * An administrator reads every salesman's, as an administrator's team is the
 * whole company everywhere else. Only ACTIVE holders of the Salesman App are
 * ever returned, and the person themself never is: a salesman does not get a
 * window onto their own or a colleague's visits by being asked about them.
 * ------------------------------------------------------------------------- */

export type Superior = { id: string; name: string; role: string };

export async function reportingSalesmen(user: Superior): Promise<{ id: string; name: string }[]> {
  /* A desk feature of the CRM: somebody who is not in the CRM (a field salesman
     on the handset) has no door to it whatever the Org Chart says about them. */
  if (!(await canOpen(user.id, "crm"))) return [];
  const field = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .innerJoin(appAccess, eq(appAccess.userId, users.id))
    .where(and(eq(appAccess.app, "field"), eq(users.active, true)));

  if (user.role === "admin") return field.filter((f) => f.id !== user.id);

  const ids = new Set<string>();
  const direct = await db.select({ id: users.id }).from(users).where(eq(users.reportsToId, user.id));
  for (const r of direct) ids.add(r.id);

  const me = user.name.trim().toLowerCase();
  const chart = await managerNameByEmployeeName();
  for (const f of field) {
    const boss = chart.get(f.name.trim().toLowerCase());
    if (boss && boss.trim().toLowerCase() === me) ids.add(f.id);
  }
  return field.filter((f) => ids.has(f.id) && f.id !== user.id);
}

/** May this person open Check Visits at all — somebody has to report to them. */
export async function canCheckVisits(user: Superior): Promise<boolean> {
  return (await reportingSalesmen(user)).length > 0;
}

export type TeamVisit = {
  id: string;
  salesmanId: string;
  salesmanName: string;
  customerId: string;
  customerName: string;
  at: string;
  outcome: string | null;
  notes: string | null;
  nextFollowUpDate: string | null;
  planned: boolean;
  deviationReason: string | null;
  /** Only what the visit recorded: a coordinate, and only if the handset took one. */
  location: { lat: number; lng: number; accuracyM: number | null; distanceFromShopM: number | null } | null;
  verified: boolean;
  /** "By hand" when typed in at a desk, "Salesman App" when the handset checked in. */
  source: "handset" | "hand";
  activities: string[];
};

/** Visits per page, and the most pages one range may be walked to — never unlimited. */
export const TEAM_VISIT_PAGE = 25;
export const TEAM_VISIT_MAX_PAGES = 40;
/** The widest a date range may be, and what it is when nobody picks one. */
export const TEAM_VISIT_MAX_DAYS = 366;
export const TEAM_VISIT_DEFAULT_DAYS = 30;

const DAY = 86_400_000;
const IST = "+05:30";
const ymd = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (d: string) => new Date(`${d}T00:00:00${IST}`);

/** A picked range as instants in the working zone — [from, to) — or why it is refused. */
export function visitRange(
  input: { from?: string; to?: string },
  now: Date,
): { ok: true; from: Date; to: Date; fromDay: string; toDay: string } | { ok: false; error: string } {
  const istDay = (d: Date) => calendarDate(d);
  const toDay = input.to || istDay(now);
  const fromDay = input.from || istDay(new Date(dayStart(toDay).getTime() - (TEAM_VISIT_DEFAULT_DAYS - 1) * DAY));
  if (!ymd.test(fromDay) || !ymd.test(toDay) || Number.isNaN(dayStart(fromDay).getTime()) || Number.isNaN(dayStart(toDay).getTime())) {
    return { ok: false, error: "Pick the range as two dates." };
  }
  const from = dayStart(fromDay);
  const to = new Date(dayStart(toDay).getTime() + DAY);
  if (to <= from) return { ok: false, error: "The end date is before the start date." };
  if ((to.getTime() - from.getTime()) / DAY > TEAM_VISIT_MAX_DAYS) {
    return { ok: false, error: `Pick a range of at most ${TEAM_VISIT_MAX_DAYS} days.` };
  }
  return { ok: true, from, to, fromDay, toDay };
}

/**
 * The team's visits in a date range, newest first, one bounded page at a time.
 * `salesmanIds` is ALWAYS intersected with who reports to the caller, so a
 * hand-built request naming somebody else's salesman returns nothing.
 */
export async function teamVisits(
  user: Superior,
  opts: { customerId?: string; salesmanId?: string; from?: string; to?: string; page?: number; now: Date },
): Promise<{ visits: TeamVisit[]; more: boolean; fromDay: string; toDay: string } | { error: string } | null> {
  const team = await reportingSalesmen(user);
  if (!team.length) return null;
  const range = visitRange(opts, opts.now);
  if (!range.ok) return { error: range.error };
  const page = Math.min(Math.max(Math.trunc(opts.page ?? 0), 0), TEAM_VISIT_MAX_PAGES - 1);
  const allowed = new Set(team.map((t) => t.id));
  const wanted = opts.salesmanId ? (allowed.has(opts.salesmanId) ? [opts.salesmanId] : []) : [...allowed];
  if (!wanted.length) return { visits: [], more: false, fromDay: range.fromDay, toDay: range.toDay };

  const when = sql`coalesce(${mbosVisits.checkInAt}, ${mbosVisits.serverCreatedAt})`;
  const rows = await db
    .select({
      id: mbosVisits.id,
      salesmanId: mbosVisits.salesmanId,
      salesmanName: users.name,
      customerId: mbosVisits.customerId,
      customerName: customers.name,
      at: sql<Date>`${when}`,
      outcome: mbosVisits.outcome,
      notes: mbosVisits.notes,
      nextFollowUpDate: mbosVisits.nextFollowUpDate,
      wasPlanned: mbosVisits.wasPlanned,
      deviationReason: mbosVisits.deviationReason,
      lat: mbosVisits.checkInLat,
      lng: mbosVisits.checkInLng,
      accuracy: mbosVisits.checkInAccuracyM,
      distance: mbosVisits.distanceFromShopM,
      verified: mbosVisits.verified,
      deviceId: mbosVisits.deviceId,
      order: mbosVisits.linkedOrderId,
      payment: mbosVisits.linkedPaymentId,
      complaint: mbosVisits.linkedComplaintId,
      sample: mbosVisits.linkedSampleId,
    })
    .from(mbosVisits)
    .innerJoin(users, eq(users.id, mbosVisits.salesmanId))
    .innerJoin(customers, eq(customers.id, mbosVisits.customerId))
    .where(
      and(
        inArray(mbosVisits.salesmanId, wanted),
        opts.customerId ? eq(mbosVisits.customerId, opts.customerId) : undefined,
        sql`${when} >= ${range.from.toISOString()}::timestamptz`,
        sql`${when} < ${range.to.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(when), desc(mbosVisits.id))
    .limit(TEAM_VISIT_PAGE + 1)
    .offset(page * TEAM_VISIT_PAGE);

  const more = rows.length > TEAM_VISIT_PAGE && page + 1 < TEAM_VISIT_MAX_PAGES;
  const visits: TeamVisit[] = rows.slice(0, TEAM_VISIT_PAGE).map((r) => ({
    id: r.id,
    salesmanId: r.salesmanId,
    salesmanName: r.salesmanName,
    customerId: r.customerId,
    customerName: r.customerName,
    at: new Date(r.at).toISOString(),
    outcome: r.outcome ? visitOutcomeLabel(r.outcome) : null,
    notes: r.notes,
    nextFollowUpDate: r.nextFollowUpDate,
    planned: r.wasPlanned,
    deviationReason: r.deviationReason,
    location: r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng, accuracyM: r.accuracy, distanceFromShopM: r.distance } : null,
    verified: r.verified,
    source: r.deviceId ? "handset" : "hand",
    activities: [
      r.order ? "Order taken" : null,
      r.payment ? "Payment collected" : null,
      r.complaint ? "Complaint raised" : null,
      r.sample ? "Sample handled" : null,
    ].filter((x): x is string => x !== null),
  }));
  return { visits, more, fromDay: range.fromDay, toDay: range.toDay };
}
