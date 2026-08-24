import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customers,
  mbosApprovals,
  mbosLeads,
  mbosSamples,
  mbosTasks,
  mbosVisits,
  notifications,
} from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { APP_TIMEZONE } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { recomputeSalesPerformance } from "@/lib/services/performance-service";

/**
 * The scheduled work MBOS needs, per brief §8.
 *
 * Every one of these is idempotent and re-runnable, which is what makes running
 * them on an unreliable schedule safe — closing an already-closed visit changes
 * nothing, and escalating an already-escalated task changes nothing and
 * notifies nobody twice. A job that is only correct the first time is a job
 * nobody dares re-run when it half-fails.
 *
 * Every date comparison names Asia/Kolkata. Neon runs in GMT, so a bare cast
 * would put a 1am IST visit on the previous day — the mistake `AGENTS.md`
 * already has a test guarding `lib/` against.
 */

export type Counted = { recordsAffected: number; detail: string };

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** Today, in the business timezone rather than the server's. */
const TODAY = sql`((now() AT TIME ZONE ${APP_TIMEZONE})::date)`;

/* -------------------------------------------------------------- nightly */

/**
 * A visit whose salesman never checked out.
 *
 * It is marked unverified and left for a manager to confirm. The duration is
 * deliberately NOT invented — guessing an end time puts hours on a record
 * nobody measured, and those hours reach a report looking exactly like measured
 * ones.
 */
export async function closeOpenVisits(): Promise<Counted> {
  const rows = await db
    .update(mbosVisits)
    .set({
      verified: false,
      unverifiedReason: sql`COALESCE(${mbosVisits.unverifiedReason}, 'Closed automatically at the end of the day — no check-out was recorded')`,
      updatedAt: new Date(),
    })
    .where(
      and(
        isNotNull(mbosVisits.checkInAt),
        isNull(mbosVisits.checkOutAt),
        lt(sql`(${mbosVisits.checkInAt} AT TIME ZONE ${APP_TIMEZONE})::date`, TODAY),
        /* Already-closed ones are skipped, so a re-run is free. */
        ne(mbosVisits.verified, false),
      ),
    )
    .returning({ id: mbosVisits.id });

  return { recordsAffected: rows.length, detail: `${rows.length} visits closed without a check-out` };
}

/**
 * A day with a check-in and no check-out — closed at the last thing they did.
 *
 * This used to set `autoCheckedOut` and nothing else, which flagged the day
 * for regularisation and left `check_out_at` null for ever. Every query that
 * asks "who is still out" reads that column, so a salesman who forgot to press
 * the button on Tuesday was still out on Friday, and the Live map, the
 * attendance screen and the day counts all believed it.
 *
 * **THE CLOSING TIME IS EVIDENCE, NEVER A GUESS.** It is the latest moment
 * MahekOne can show he was working: his last reported position, the last
 * activity he filed, or the last visit he closed. Picking an hour instead —
 * six o'clock, or the end of the configured day — would be inventing
 * attendance, and attendance is the one place in this app where an invented
 * figure is least forgivable: somebody is paid against it.
 *
 * **A day with no evidence at all keeps its null**, and keeps the flag. That
 * is a real state — checked in, did nothing the app saw, never checked out —
 * and the honest answer is that we do not know when he stopped, not a
 * plausible time that would be believed.
 *
 * `auto_checked_out` still marks every one of them, so no closed day is ever
 * mistaken for one somebody pressed the button on, and the regularisation
 * path is untouched.
 */
export async function markMissedCheckouts(): Promise<Counted> {
  /* Raw, because the closing time is the greatest of three subqueries and
     Drizzle's builder cannot say that without three round trips. No JS Date
     is bound anywhere here — every timestamp is a column or `now()`. */
  const closed = await db.execute<{ id: string; closed: boolean }>(sql`
    update mbos_attendance_days d
       set check_out_at = ev.last_seen,
           auto_checked_out = true,
           updated_at = now()
      from (
        select a.id,
               greatest(
                 (select max(p.at) from mbos_positions p
                   where p.user_id = a.user_id
                     and (p.at at time zone ${APP_TIMEZONE})::date = a.day),
                 (select max(l.captured_at) from mbos_activity_locations l
                   where l.user_id = a.user_id
                     and (l.captured_at at time zone ${APP_TIMEZONE})::date = a.day),
                 (select max(coalesce(v.check_out_at, v.check_in_at)) from mbos_visits v
                   where v.salesman_id = a.user_id
                     and (v.check_in_at at time zone ${APP_TIMEZONE})::date = a.day)
               ) as last_seen
          from mbos_attendance_days a
         where a.check_in_at is not null
           and a.check_out_at is null
           and a.auto_checked_out = false
           and a.day < ${TODAY}
      ) ev
     where d.id = ev.id
    returning d.id, (d.check_out_at is not null) as closed
  `);

  const withTime = closed.filter((r) => r.closed).length;
  const blind = closed.length - withTime;

  return {
    recordsAffected: closed.length,
    detail:
      `${closed.length} days missing a check-out` +
      (closed.length
        ? ` — ${withTime} closed at the last thing they did` +
          (blind ? `, ${blind} left open because nothing was recorded` : "")
        : ""),
  };
}

/**
 * Leads go stale, then archived.
 *
 * Archived is a FILTER, never a delete — a lead that went quiet for three
 * months is still the record of who was approached and what was said.
 */
export async function ageLeads(): Promise<Counted> {
  const config = await getConfig();
  const staleDays = config["mbos.leads.staleDays"];
  const archiveDays = config["mbos.leads.archiveDays"];

  const archived = await db
    .update(mbosLeads)
    .set({ archived: true, archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        isNull(mbosLeads.convertedCustomerId),
        eq(mbosLeads.archived, false),
        lt(mbosLeads.lastActivityDate, sql`${TODAY} - ${archiveDays}::int`),
      ),
    )
    .returning({ id: mbosLeads.id });

  /* Counted rather than written: `stage` is the salesperson's own reading of
     the lead, and overwriting "Negotiation" with a staleness flag would lose
     what they knew. The threshold surfaces them; it does not relabel them. */
  const [stale] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mbosLeads)
    .where(
      and(
        isNull(mbosLeads.convertedCustomerId),
        eq(mbosLeads.archived, false),
        lt(mbosLeads.lastActivityDate, sql`${TODAY} - ${staleDays}::int`),
      ),
    );

  return {
    recordsAffected: archived.length,
    detail: `${archived.length} archived, ${stale?.n ?? 0} now stale`,
  };
}

/**
 * Customers with no coordinates. A count, not a fix.
 *
 * Route optimisation and visit validation both depend on coordinates, and the
 * brief requires the gap surfaced so somebody decides whether capturing them is
 * an early field task rather than a background nicety.
 */
export async function countCustomersWithoutGps(): Promise<Counted> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(customers)
    .where(isNull(customers.gpsLat));

  return { recordsAffected: row?.n ?? 0, detail: `${row?.n ?? 0} customers have no coordinates` };
}

/* --------------------------------------------------------------- hourly */

/**
 * Overdue tasks escalate to the manager.
 *
 * `escalatedAt` is written once and is what makes this idempotent — running the
 * sweep four times an hour costs nothing and tells nobody twice.
 */
export async function escalateOverdueTasks(): Promise<Counted> {
  const hours = (await getConfig())["mbos.tasks.escalationHours"];

  const due = await db
    .update(mbosTasks)
    .set({ escalatedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(mbosTasks.status, "open"),
        isNull(mbosTasks.escalatedAt),
        isNotNull(mbosTasks.dueDate),
        lt(sql`${mbosTasks.dueDate}::timestamptz + (${hours}::int * interval '1 hour')`, sql`now()`),
      ),
    )
    .returning({ id: mbosTasks.id, title: mbosTasks.title, assignedToUserId: mbosTasks.assignedToUserId });

  for (const t of due) {
    if (!t.assignedToUserId) continue;
    await db.insert(notifications).values({
      id: id("notif"),
      userId: t.assignedToUserId,
      title: "Task overdue",
      body: `${t.title} is past its date and your manager has been told.`,
      kind: "warning",
      href: "/field/tasks",
    });
  }

  return { recordsAffected: due.length, detail: `${due.length} tasks escalated` };
}

/**
 * An approval sitting undecided past its window.
 *
 * Surfaced rather than auto-decided. Nobody's request is approved by a timer —
 * an approval with nowhere to go is a salesman standing in a shop waiting for
 * an answer that is not coming, and the fix is to tell somebody, not to guess.
 */
export async function escalateApprovals(): Promise<Counted> {
  const hours = (await getConfig())["mbos.approvals.escalationHours"];

  const stale = await db
    .select({ id: mbosApprovals.id, requestedByUserId: mbosApprovals.requestedByUserId })
    .from(mbosApprovals)
    .where(
      and(
        eq(mbosApprovals.state, "pending"),
        lt(mbosApprovals.requestedAt, sql`now() - (${hours}::int * interval '1 hour')`),
      ),
    );

  return { recordsAffected: stale.length, detail: `${stale.length} approvals past their window` };
}

/**
 * A sample whose follow-up date passed with no feedback recorded.
 *
 * Flagged, not closed. A sample nobody chased is a sample that was given away,
 * and the whole point is to make somebody chase it.
 */
export async function flagOverdueSamples(): Promise<Counted> {
  const rows = await db
    .select({ id: mbosSamples.id, customerId: mbosSamples.customerId })
    .from(mbosSamples)
    .where(
      and(
        eq(mbosSamples.trialOutcome, "pending"),
        isNotNull(mbosSamples.followUpDate),
        lt(mbosSamples.followUpDate, TODAY),
      ),
    );

  return { recordsAffected: rows.length, detail: `${rows.length} samples past their follow-up` };
}

/* ----------------------------------------------------------- composites */

export async function mbosNightly(): Promise<Counted> {
  const parts = [
    await closeOpenVisits(),
    await markMissedCheckouts(),
    await ageLeads(),
    await countCustomersWithoutGps(),
  ];
  return {
    recordsAffected: parts.reduce((a, p) => a + p.recordsAffected, 0),
    detail: parts.map((p) => p.detail).join(" · "),
  };
}

/**
 * The current month's score, rebuilt hourly.
 *
 * The nightly job does both this month and the last one; this does only the
 * current month, and it exists because the handset reads the CACHE. Nightly
 * alone would mean a salesman who took three orders this morning saw
 * yesterday's figures all day, on the one screen whose whole purpose is to
 * tell him where he stands right now.
 *
 * It is one pass over one month of orders for the whole company, which at this
 * size is cheap enough to do every hour and far too expensive to do on every
 * handset's sync.
 */
async function refreshPerformance(): Promise<Counted> {
  const day = await today();
  const { people } = await recomputeSalesPerformance(day.slice(0, 7), day);
  return { recordsAffected: people, detail: `${people} scored for ${day.slice(0, 7)}` };
}

export async function mbosHourly(): Promise<Counted> {
  const parts = [
    await escalateOverdueTasks(),
    await escalateApprovals(),
    await flagOverdueSamples(),
    await refreshPerformance(),
  ];
  return {
    recordsAffected: parts.reduce((a, p) => a + p.recordsAffected, 0),
    detail: parts.map((p) => p.detail).join(" · "),
  };
}
