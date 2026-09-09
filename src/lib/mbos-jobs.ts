import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  bills,
  customers,
  leadStageTransitions,
  mbosApprovals,
  mbosSamples,
  mbosTasks,
  mbosVisits,
  notifications,
  orders,
} from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { addDays, APP_TIMEZONE } from "@/lib/business-date";
import {
  NURTURE_SOURCE_TYPE,
  sampleChaseDue,
  tasksDueFor,
  type NurtureConfig,
  type NurtureEvent,
} from "@/lib/engines/lead-nurture";
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

  /* ONE LEAD, so this sweeps `customers`. "Not converted" is `kind = 'lead'`
     now rather than a null pointer to a second row: a won lead has become the
     customer, and archiving one for going quiet would file away an account
     that is actively buying. */
  const archived = await db
    .update(customers)
    .set({ leadArchived: true, leadArchivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(customers.kind, "lead"),
        isNotNull(customers.leadStage),
        eq(customers.leadArchived, false),
        lt(customers.leadLastActivityDate, sql`${TODAY} - ${archiveDays}::int`),
      ),
    )
    .returning({ id: customers.id });

  /* Counted rather than written: `stage` is the salesperson's own reading of
     the lead, and overwriting "Negotiation" with a staleness flag would lose
     what they knew. The threshold surfaces them; it does not relabel them. */
  const [stale] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(customers)
    .where(
      and(
        eq(customers.kind, "lead"),
        isNotNull(customers.leadStage),
        eq(customers.leadArchived, false),
        lt(customers.leadLastActivityDate, sql`${TODAY} - ${staleDays}::int`),
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
        /*
         * `at time zone`, NOT a bare `::timestamptz`.
         *
         * `due_date` is a DATE, and a bare cast resolves its midnight in the
         * SESSION's zone — which is not a property of the row. One pooled
         * connection left in Asia/Kolkata by an earlier query read a task as
         * 18:30Z while the rest read it as 00:00Z, in one process, so a task
         * escalated five and a half hours early or late depending on which
         * connection the job happened to draw. Local Postgres runs in
         * Asia/Kolkata and agrees with itself, which is why it looked correct
         * here and misbehaved on the droplet.
         */
        lt(
          sql`(${mbosTasks.dueDate}::timestamp at time zone ${APP_TIMEZONE}) + (${hours}::int * interval '1 hour')`,
          sql`now()`,
        ),
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
    /* §13 — the sequence, once a day. Its longest interval is four days, so a
       nightly pass is ample and an hourly one would re-derive the same events
       twenty-four times to raise nothing twenty-three of them. */
    await runNurturePass(),
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
    /* §16 — the chase ladder, hourly, because the day a rung falls due is the
       day somebody should ring rather than the following morning. It is safe
       at any cadence: the count and the task key both move together, so a pass
       that runs twice in an hour asks once. */
    await chaseSampleReviews(),
    await flagSamplesPastDelivery(),
    await refreshPerformance(),
  ];
  return {
    recordsAffected: parts.reduce((a, p) => a + p.recordsAffected, 0),
    detail: parts.map((p) => p.detail).join(" · "),
  };
}

/* ------------------------------------------------- §13/§16 the nurture pass */

/**
 * Anything that can insert and select: `db` itself, or a transaction handle.
 *
 * The two callers are the scheduled pass below and the sample actions, which
 * raise the same tasks inside the transaction that produced the event. Sharing
 * one writer type is what keeps a sample's dispatch and the task chasing it
 * from being two writes that can half-happen.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type NurtureWriter = Tx | typeof db;

/**
 * Who a nurture task belongs to, resolved from the lead.
 *
 * A task with nobody's name on it is a task nobody does, so a row whose owner
 * cannot be resolved is SKIPPED rather than assigned to whoever happens to be
 * handy — and the gap is visible where it belongs, on the console's list of
 * leads with no manager, rather than as work quietly landing on one person.
 */
async function nurtureOwners(
  tx: NurtureWriter,
  customerId: string,
): Promise<{ lead_manager: string | null; salesman: string | null }> {
  const [row] = await tx
    .select({
      leadManagerId: customers.leadManagerId,
      salesAmId: customers.salesAmId,
      ownerId: customers.ownerId,
    })
    .from(customers)
    .where(eq(customers.id, customerId));

  return {
    lead_manager: row?.leadManagerId ?? null,
    /* The salesman half falls through the same way `sales-attribution.ts`
       does — the seat first, the owner after — because the person who is
       expected to collect a GST number is the person whose book it is. */
    salesman: row?.salesAmId ?? row?.ownerId ?? null,
  };
}

/**
 * Raise whatever the sequence says should exist for these events, and nothing
 * that already does.
 *
 * The keys are read back before anything is written, which is what makes this
 * safe to call from a scheduled pass AND from the action that caused the event
 * — the ordinary case is that the action raised it seconds ago and the nightly
 * finds nothing to do. There is no unique index behind this on purpose:
 * `mbos_tasks` is a general table and a partial index for one source type
 * would be a migration in somebody else's file, so the check is a read inside
 * the same transaction instead.
 */
export async function raiseNurtureTasks(
  tx: NurtureWriter,
  input: {
    customerId: string;
    events: readonly NurtureEvent[];
    today: string;
    config: NurtureConfig;
    salesmanId?: string | null;
  },
): Promise<number> {
  if (!input.events.length) return 0;

  const candidates = tasksDueFor(input.events, input.today, input.config);
  if (!candidates.length) return 0;

  const existing = await tx
    .select({ sourceId: mbosTasks.sourceId })
    .from(mbosTasks)
    .where(
      and(
        eq(mbosTasks.sourceType, NURTURE_SOURCE_TYPE),
        inArray(
          mbosTasks.sourceId,
          candidates.map((c) => c.sourceId),
        ),
      ),
    );
  const held = new Set(existing.map((r) => r.sourceId).filter(Boolean) as string[]);

  const owners = await nurtureOwners(tx, input.customerId);
  const rows = candidates
    .filter((c) => !held.has(c.sourceId))
    .map((c) => {
      const assignee =
        c.owner === "salesman" ? (input.salesmanId ?? owners.salesman) : owners[c.owner];
      return assignee ? { task: c, assignee } : null;
    })
    .filter((r): r is { task: (typeof candidates)[number]; assignee: string } => r !== null);

  if (!rows.length) return 0;

  await tx.insert(mbosTasks).values(
    rows.map(({ task, assignee }) => ({
      id: id("task"),
      title: task.title,
      description: task.detail,
      assignedToUserId: assignee,
      customerId: input.customerId,
      dueDate: task.dueDate,
      status: "open" as const,
      sourceType: task.sourceType,
      sourceId: task.sourceId,
    })),
  );

  return rows.length;
}

/**
 * The chasing is over — close what was raised for it.
 *
 * Closed rather than deleted, and only where it is still open: a task somebody
 * already did is a record of them doing it, and rewriting its completion note
 * because a job caught up afterwards would take the credit away. `cancelled`
 * is the honest status for work the world overtook — it was never done, and
 * calling it done would put it in the count of what somebody got through.
 */
export async function closeNurtureTasks(
  tx: NurtureWriter,
  sourceIds: readonly string[],
  reason: string,
): Promise<number> {
  if (!sourceIds.length) return 0;
  const closed = await tx
    .update(mbosTasks)
    .set({
      status: "cancelled",
      completionNote: reason,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mbosTasks.sourceType, NURTURE_SOURCE_TYPE),
        inArray(mbosTasks.sourceId, [...sourceIds]),
        inArray(mbosTasks.status, ["open", "in_progress"]),
      ),
    )
    .returning({ id: mbosTasks.id });
  return closed.length;
}

/**
 * Every open nurture task raised against one row — the sample, usually.
 *
 * Read by `cancelSample` and by the delivery step, which have to close the
 * chasing without knowing which rungs were ever reached. The key is
 * `<trigger>:<owner>:<after>:<sourceId>` for a sequence row and
 * `sample_review:<sourceId>:<n>` for a chase, so the row's own id appears
 * either at the end or between two colons.
 *
 * **It is matched with string functions rather than with `LIKE`, deliberately.**
 * Every id in this codebase carries an underscore in its prefix — `smp_`,
 * `apr_` — and `_` is LIKE's own single-character wildcard, so `%:smp_a1b2`
 * would happily match a task belonging to `smp` + any character + `a1b2`. That
 * is a closing sweep reaching another sample's tasks, which is silent, rare,
 * and impossible to reproduce from the outside.
 */
export async function openNurtureTaskIdsFor(
  tx: NurtureWriter,
  sourceRowId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ sourceId: mbosTasks.sourceId })
    .from(mbosTasks)
    .where(
      and(
        eq(mbosTasks.sourceType, NURTURE_SOURCE_TYPE),
        inArray(mbosTasks.status, ["open", "in_progress"]),
        or(
          sql`right(${mbosTasks.sourceId}, ${sourceRowId.length + 1}) = ${`:${sourceRowId}`}`,
          sql`strpos(${mbosTasks.sourceId}, ${`:${sourceRowId}:`}) > 0`,
        ),
      ),
    );
  return rows.map((r) => r.sourceId).filter((s): s is string => Boolean(s));
}

/** The window the pass looks back over. See `runNurturePass`. */
const NURTURE_LOOKBACK_DAYS = 60;

/**
 * The scheduled half of §13: read what has happened, raise what is due.
 *
 * It looks back a bounded window rather than over the whole book, because the
 * sequence's longest interval is four days and re-deriving five years of
 * events every night to raise nothing is a pass that gets switched off the
 * first time it is slow. Anything older than the window has either been raised
 * already — the keys are stable, so it would be dropped — or belongs to a lead
 * nobody has touched since spring, which is a report rather than a task.
 *
 * FOUR OF THE FIFTEEN TRIGGERS ARE NOT WIRED HERE, and that is deliberate
 * rather than unfinished. `delivery_completed` needs a dispatch mark MahekOne
 * does not record yet; `expected_reorder` is the Call Log's own job and a
 * second list chasing the same reorder would ring the customer twice with two
 * people each believing they were the only one. Both raise correctly the
 * moment something calls `raiseNurtureTasks` with them.
 * TODO(integration): `delivery_completed` once dispatch is recorded.
 */
export async function runNurturePass(): Promise<Counted> {
  const config = await getConfig();
  const day = await today();
  const since = addDays(day, -NURTURE_LOOKBACK_DAYS);
  const nurtureConfig: NurtureConfig = {
    sampleReviewChaseDays: config["leads.sampleReviewChaseDays"],
  };

  /* Every date below is derived in the business's own zone, in SQL, naming it
     — a bare cast would put an event that happened at 1am IST on the previous
     day and the whole sequence would be one rung early for anybody working
     late. */
  const dayOf = (column: SQL | AnyColumn) =>
    sql<string>`((${column} AT TIME ZONE ${APP_TIMEZONE})::date)::text`;

  type Candidate = NurtureEvent & { customerId: string; salesmanId: string | null };
  const candidates: Candidate[] = [];

  /* A lead becoming a Prospect: the sequence's own starting gun, and four of
     the fifteen rows hang off it. */
  const prospects = await db
    .select({
      customerId: leadStageTransitions.customerId,
      on: dayOf(leadStageTransitions.at),
    })
    .from(leadStageTransitions)
    .where(
      and(
        eq(leadStageTransitions.toStage, "prospect"),
        sql`((${leadStageTransitions.at} AT TIME ZONE ${APP_TIMEZONE})::date) >= ${since}`,
      ),
    );
  for (const p of prospects) {
    candidates.push({
      trigger: "prospect_created",
      sourceId: p.customerId,
      on: p.on,
      customerId: p.customerId,
      salesmanId: null,
    });
  }

  const negotiations = await db
    .select({
      customerId: leadStageTransitions.customerId,
      on: dayOf(leadStageTransitions.at),
    })
    .from(leadStageTransitions)
    .where(
      and(
        eq(leadStageTransitions.toStage, "negotiation"),
        sql`((${leadStageTransitions.at} AT TIME ZONE ${APP_TIMEZONE})::date) >= ${since}`,
      ),
    );
  for (const n of negotiations) {
    candidates.push({
      trigger: "negotiation",
      sourceId: n.customerId,
      on: n.on,
      customerId: n.customerId,
      salesmanId: null,
    });
  }

  /* A salesman's visit to a lead. The manager's verification call the day
     after is the check that the visit happened and that Mahek was explained,
     which no amount of GPS proves. */
  const visits = await db
    .select({
      id: mbosVisits.id,
      customerId: mbosVisits.customerId,
      salesmanId: mbosVisits.salesmanId,
      on: dayOf(mbosVisits.checkInAt),
    })
    .from(mbosVisits)
    .innerJoin(customers, eq(customers.id, mbosVisits.customerId))
    .where(
      and(
        isNotNull(mbosVisits.checkInAt),
        isNotNull(customers.leadStage),
        sql`((${mbosVisits.checkInAt} AT TIME ZONE ${APP_TIMEZONE})::date) >= ${since}`,
      ),
    );
  for (const v of visits) {
    candidates.push({
      trigger: "salesman_visit",
      sourceId: v.id,
      on: v.on,
      customerId: v.customerId,
      salesmanId: v.salesmanId,
    });
  }

  /* The sample's own three marks. Each is a different question asked of a
     different person, which is why they are three rows of the sequence and not
     one "chase the sample" task that means whatever the reader assumes. */
  const samples = await db
    .select({
      id: mbosSamples.id,
      customerId: mbosSamples.customerId,
      salesmanId: mbosSamples.salesmanId,
      requestedOn: dayOf(mbosSamples.serverCreatedAt),
      dispatchedOn: dayOf(mbosSamples.dispatchedAt),
      receivedOn: dayOf(mbosSamples.receivedConfirmedAt),
      trialOutcome: mbosSamples.trialOutcome,
      reviewedOn: dayOf(mbosSamples.reviewedAt),
    })
    .from(mbosSamples)
    .where(sql`((${mbosSamples.serverCreatedAt} AT TIME ZONE ${APP_TIMEZONE})::date) >= ${since}`);

  for (const s of samples) {
    const base = { customerId: s.customerId, salesmanId: s.salesmanId };
    candidates.push({ trigger: "sample_requested", sourceId: s.id, on: s.requestedOn, ...base });
    if (s.dispatchedOn) {
      candidates.push({ trigger: "sample_dispatched", sourceId: s.id, on: s.dispatchedOn, ...base });
    }
    if (s.receivedOn) {
      candidates.push({ trigger: "sample_received", sourceId: s.id, on: s.receivedOn, ...base });
    }
    /* `sample_approved` is the CUSTOMER approving it, not the office — the row
       reads "They liked it. Ask what they want and when." An office approval
       is what puts a sample on a courier and nothing to ring anybody about. */
    if (s.trialOutcome === "approved" && s.reviewedOn) {
      candidates.push({ trigger: "sample_approved", sourceId: s.id, on: s.reviewedOn, ...base });
    }
  }

  /* The day the customer said they would place the order. §18's whole point is
     that "interested" is not a report, and this is the task that goes and
     collects the answer on the day that was named. */
  const expected = await db
    .select({ id: customers.id, on: customers.leadExpectedOrderDate })
    .from(customers)
    .where(
      and(
        isNotNull(customers.leadExpectedOrderDate),
        isNotNull(customers.leadStage),
        sql`${customers.leadExpectedOrderDate} >= ${since}`,
      ),
    );
  for (const e of expected) {
    if (!e.on) continue;
    candidates.push({
      trigger: "expected_order_date",
      sourceId: e.id,
      on: e.on,
      customerId: e.id,
      salesmanId: null,
    });
  }

  /* An order from a funnel customer: the delivery is followed from here. */
  const ordered = await db
    .select({
      id: orders.id,
      customerId: orders.customerId,
      on: dayOf(orders.orderedAt),
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(
      and(
        isNotNull(customers.leadStage),
        sql`((${orders.orderedAt} AT TIME ZONE ${APP_TIMEZONE})::date) >= ${since}`,
      ),
    );
  for (const o of ordered) {
    candidates.push({
      trigger: "order_received",
      sourceId: o.id,
      on: o.on,
      customerId: o.customerId,
      salesmanId: null,
    });
  }

  /* A bill falling due on a funnel customer. `due_date` is a stored DATE and
     is compared to another date — there is no instant here to truncate. */
  const dueBills = await db
    .select({ id: bills.id, customerId: bills.customerId, on: bills.dueDate })
    .from(bills)
    .innerJoin(customers, eq(customers.id, bills.customerId))
    .where(
      and(
        isNotNull(bills.dueDate),
        isNotNull(customers.leadStage),
        sql`${bills.dueDate} >= ${since}`,
      ),
    );
  for (const b of dueBills) {
    if (!b.on) continue;
    candidates.push({
      trigger: "payment_due",
      sourceId: b.id,
      on: b.on,
      customerId: b.customerId,
      salesmanId: null,
    });
  }

  /* Grouped by customer, because the owner of a task is a fact about the LEAD
     and reading it once per event would be one query per row. */
  const byCustomer = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byCustomer.get(c.customerId);
    if (list) list.push(c);
    else byCustomer.set(c.customerId, [c]);
  }

  let raised = 0;
  for (const [customerId, list] of byCustomer) {
    raised += await raiseNurtureTasks(db, {
      customerId,
      events: list,
      today: day,
      config: nurtureConfig,
      salesmanId: list.find((c) => c.salesmanId)?.salesmanId ?? null,
    });
  }

  return {
    recordsAffected: raised,
    detail: `${raised} nurture tasks raised from ${candidates.length} events`,
  };
}

/**
 * §16 — ask again, and keep asking.
 *
 * The ladder is day 2, then 4, then 6, and the last interval repeats until
 * there is an answer. A ladder that gave up would quietly turn every
 * hard-to-reach customer into a write-off with nobody's decision behind it:
 * the sample was given away, nobody knows what they thought, and no screen
 * ever said so.
 *
 * The count on the sample is what the engine reads to know which rung it is
 * on, so it is bumped in the same transaction as the task. Bumping it without
 * raising the task would silently skip a rung; raising without bumping would
 * ask for ever on day two.
 */
export async function chaseSampleReviews(): Promise<Counted> {
  const config = await getConfig();
  const day = await today();
  const ladder = config["leads.sampleReviewChaseDays"];

  const waiting = await db
    .select({
      id: mbosSamples.id,
      customerId: mbosSamples.customerId,
      salesmanId: mbosSamples.salesmanId,
      state: mbosSamples.state,
      receivedOn: sql<string | null>`((${mbosSamples.receivedConfirmedAt} AT TIME ZONE ${APP_TIMEZONE})::date)::text`,
      chaseCount: mbosSamples.reviewChaseCount,
      lastChasedOn: sql<string | null>`((${mbosSamples.lastReviewChaseAt} AT TIME ZONE ${APP_TIMEZONE})::date)::text`,
    })
    .from(mbosSamples)
    .where(inArray(mbosSamples.state, ["received", "trial_done"]));

  let chased = 0;
  for (const s of waiting) {
    const due = sampleChaseDue(
      {
        id: s.id,
        state: s.state,
        receivedOn: s.receivedOn,
        chaseCount: s.chaseCount,
        lastChasedOn: s.lastChasedOn,
      },
      day,
      ladder,
    );
    if (!due) continue;

    const owners = await nurtureOwners(db, s.customerId);
    const assignee = owners.lead_manager ?? owners.salesman;
    /* Nobody to chase means nobody to chase. The lead with no manager is the
       console's own list; inventing an assignee here would bury it. */
    if (!assignee) continue;

    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: mbosTasks.id })
        .from(mbosTasks)
        .where(
          and(eq(mbosTasks.sourceType, due.sourceType), eq(mbosTasks.sourceId, due.sourceId)),
        );
      if (existing) return;

      await tx.insert(mbosTasks).values({
        id: id("task"),
        title: due.title,
        description: due.detail,
        assignedToUserId: assignee,
        customerId: s.customerId,
        dueDate: due.dueOn,
        /* A third ask is not the same kind of task as a first one. */
        priority: due.chaseNumber >= 3 ? "high" : "medium",
        status: "open",
        sourceType: due.sourceType,
        sourceId: due.sourceId,
      });

      await tx
        .update(mbosSamples)
        .set({
          reviewChaseCount: due.chaseNumber,
          lastReviewChaseAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mbosSamples.id, s.id));
      chased += 1;
    });
  }

  return { recordsAffected: chased, detail: `${chased} sample reviews chased` };
}

/**
 * A sample sent and not arrived by the day the courier promised.
 *
 * Flagged, never advanced. `state` is what somebody did, and moving a sample to
 * `received` because a date passed would put a delivery on the record that
 * nobody witnessed — the whole reason `receivedConfirmedAt` says "confirmed by
 * the customer or the salesman, not by the courier".
 *
 * The flag is a task rather than a column: the useful output of "this docket
 * has not moved in five days" is somebody ringing the courier, and a column
 * nobody queries is a fact nobody acts on.
 */
export async function flagSamplesPastDelivery(): Promise<Counted> {
  const day = await today();

  const late = await db
    .select({
      id: mbosSamples.id,
      customerId: mbosSamples.customerId,
      salesmanId: mbosSamples.salesmanId,
      courierName: mbosSamples.courierName,
      courierDocket: mbosSamples.courierDocket,
      expected: mbosSamples.expectedDeliveryDate,
    })
    .from(mbosSamples)
    .where(
      and(
        eq(mbosSamples.state, "dispatched"),
        isNotNull(mbosSamples.expectedDeliveryDate),
        lt(mbosSamples.expectedDeliveryDate, TODAY),
      ),
    );

  let flagged = 0;
  for (const s of late) {
    const sourceId = `sample_late:${s.id}`;
    const owners = await nurtureOwners(db, s.customerId);
    const assignee = owners.lead_manager ?? s.salesmanId;
    if (!assignee) continue;

    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: mbosTasks.id })
        .from(mbosTasks)
        .where(and(eq(mbosTasks.sourceType, NURTURE_SOURCE_TYPE), eq(mbosTasks.sourceId, sourceId)));
      /* Once per sample, not once per night. A parcel five days late is one
         problem, and five identical tasks about it is a list nobody reads. */
      if (existing) return;

      await tx.insert(mbosTasks).values({
        id: id("task"),
        title: "Sample has not arrived",
        description:
          `It was due on ${s.expected}` +
          (s.courierName ? ` with ${s.courierName}` : "") +
          (s.courierDocket ? ` on docket ${s.courierDocket}` : "") +
          ". Chase the courier, and confirm with the customer whether it has landed.",
        assignedToUserId: assignee,
        customerId: s.customerId,
        dueDate: day,
        priority: "high",
        status: "open",
        sourceType: NURTURE_SOURCE_TYPE,
        sourceId,
      });
      flagged += 1;
    });
  }

  return { recordsAffected: flagged, detail: `${flagged} samples past their delivery date` };
}
