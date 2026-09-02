import "server-only";
import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  calls,
  customers,
  monthlyTargets,
  orders,
  queueSnapshots,
  reminders,
} from "@/db/schema";
import { getConfig } from "../config/store";
import { ASSIGNED_TO_SQL, resolveScope, scopedUserIds, scopedToUsers} from "../access-control";
import {
  buildQueue,
  type QueueCandidate,
  type QueueResult,
  callValuePaise,
} from "../engines/queue";
import { orderCountsSql } from "../order-status";
import { nextStep, type NextStep } from "../engines/next-step";
import { today } from "../recompute";
import { getPaymentFollowUpPlan, paymentCadenceFor } from "./payment-service";
import {
  businessDate,
  dayBoundaryWindow,
  type BusinessDate,
  monthKey,
  previousWorkingDay,
} from "../business-date";

/* ---------------------------------------------------------------------------
 * E2 wiring.
 *
 * The queue is COMPUTED ON REQUEST and never persisted. It changes
 * continuously as calls are logged through the day, and a stale stored queue
 * is worse than a slow computed one.
 * ------------------------------------------------------------------------- */

/**
 * A queue entry plus the customer detail the row and its call panel need.
 * Carried through from the candidate scan so opening a panel costs nothing.
 */
export type QueueRow = QueueResult["entries"][number] & {
  contactPerson: string | null;
  phone: string;
  city: string;
  ownerName: string | null;
  /** Whose call this is, by the assignment rule. Shown on team lists. */
  assignedToName: string | null;
  kind: "lead" | "customer";
  /** Active, or gone quiet past twice their own cycle. Never `deactivated`. */
  status: "active" | "inactive" | "deactivated";
  /** Asked for already, and waiting on a manager. Stops a second request. */
  deactivationRequested: boolean;
  slowPayer: boolean;
  lastOrderDate: string | null;
  lastOrderValue: number;
  creditTermDays: number;
  openComplaint: string | null;
  lastNote: string | null;
};

export type QueueView = Omit<QueueResult, "entries"> & {
  entries: QueueRow[];
  /** Progress figures for the header strip. */
  progress: { worked: number; total: number; percent: number };
  /**
   * How many of today's rows were also on the previous working day's list.
   * Null when there is no snapshot to compare against — the first day after
   * deployment, say — because "0 carried over" and "we do not know" are very
   * different things to show a telecaller.
   */
  carriedOver: number | null;
  /** The hour the list settles, so the screen can say when. */
  snapshotHour: number;
  scopeLabel: string;
};

/**
 * Everything the queue engine needs, for one scope, on one day.
 *
 * Shared by the live screen and by the nightly snapshot so the two can never
 * disagree about who was on the list — a snapshot built by a second, slightly
 * different query would be worse than no snapshot at all.
 */
async function queueInputs(
  ids: string[] | null,
  day: string,
  /** One customer only, for the forward "what happens next" question. */
  onlyCustomerId?: string,
) {
  const config = await getConfig();
  const window = dayBoundaryWindow(day, {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  });

  // Whose book, by the single definition — a lead answers to its owner, a
  // customer to its sales account manager.
  const ownerFilter = scopedToUsers(ids);

  // Deactivated customers are never candidates.
  const rows = await db
    .select({
      customer: customers,
      calledToday: sql<boolean>`exists (
        select 1 from ${calls} c
         where c.customer_id = customers.id
           and c.started_at >= ${window.start}::timestamptz
           and c.started_at <  ${window.end}::timestamptz
      )`,
      ownerName: sql<
        string | null
      >`(select name from users u where u.id = customers.owner_id)`,
      // Who is actually to make this call. Not the owner: whose book a record
      // sits in is ASSIGNED_TO_SQL, so on a team list the owner's name would
      // put a call against somebody it was reassigned away from. The sheet's
      // salesperson is a NAME and may be nobody with an account, so it is
      // shown where there is one and the assigned user underneath — the
      // person who can sign in and work the row is the answer that matters.
      assignedToName: sql<string | null>`coalesce(
        nullif(customers.sales_person_name, ''),
        (select name from users u where u.id = ${ASSIGNED_TO_SQL})
      )`,
      /*
       * What this customer's order is usually worth, in paise.
       *
       * The MEDIAN, not the average: one drum bought for a job that never
       * repeated should not decide where a shop sits on the calling list for
       * a year, and an average is exactly how it would.
       *
       * Approved orders only — `orderCountsSql` is the single definition of
       * "did the business sell anything", and a declined order was never a
       * sale. Null where there is no history at all, which is a prospect, and
       * they are ranked by the reason rather than by a figure we do not have.
       *
       * `customers.id` spelled out for the reason the comment above says: a
       * bare `id` inside a correlated subquery binds to the inner table.
       */
      typicalOrderPaise: sql<number>`coalesce((
        select percentile_cont(0.5) within group (order by o.total_amount)
          from ${orders} o
         where o.customer_id = customers.id
           and ${orderCountsSql("o")}
           and o.ordered_at >= now() - make_interval(days => ${config["queue.orderValueLookbackDays"]})
      ), 0)::bigint`,
      openComplaint: sql<string | null>`(
        select c.description from complaints c
         where c.customer_id = customers.id
           and c.status in ('open','in_progress','awaiting_customer')
         order by c.created_at desc limit 1
      )`,
      /*
       * The last call that was ANSWERED, and what came of it. What it buys is
       * configuration — "no order" a week, "not interested" a month — so the
       * outcome travels rather than a single hardcoded flag.
       *
       * Note customers.id spelled out: Drizzle renders ${customers.id} as a
       * bare "id", which inside a correlated subquery binds to the INNER
       * table and quietly matches every row.
       */
      lastAnsweredOutcome: sql<string | null>`(
        select c.outcome::text from ${calls} c
         where c.customer_id = customers.id
           and c.interaction_type = 'outbound_call'
           and c.outcome is not null and c.outcome <> 'no_answer'
         order by c.started_at desc limit 1
      )`,
      lastAnsweredDate: sql<string | null>`(
        select (c.started_at at time zone 'Asia/Kolkata')::date::text from ${calls} c
         where c.customer_id = customers.id
           and c.interaction_type = 'outbound_call'
           and c.outcome is not null and c.outcome <> 'no_answer'
         order by c.started_at desc limit 1
      )`,
      /*
       * The UNANSWERED RUN — attempts since the last time somebody answered.
       * Counted rather than stored: a column would have to be reset by every
       * path that reaches the customer, and one missed reset leaves somebody
       * permanently unreachable.
       */
      noAnswerCount: sql<number>`(
        select count(*)::int from ${calls} c
         where c.customer_id = customers.id
           and c.interaction_type = 'outbound_call'
           and c.outcome = 'no_answer'
           and c.started_at > coalesce((
             select c2.started_at from ${calls} c2
              where c2.customer_id = customers.id
                and c2.outcome is not null and c2.outcome <> 'no_answer'
              order by c2.started_at desc limit 1
           ), '-infinity'::timestamptz)
      )`,
      /* The instant, not the date: the first retry is an hour later. */
      lastNoAnswerAt: sql<string | null>`(
        select to_char(c.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          from ${calls} c
         where c.customer_id = customers.id
           and c.interaction_type = 'outbound_call'
           and c.outcome = 'no_answer'
         order by c.started_at desc limit 1
      )`,
      /* An order already placed and still working its way through. */
      openOrderStatus: sql<string | null>`(
        select o.status::text from ${orders} o
         where o.customer_id = customers.id
           and o.status in ('pending_approval','captured','confirmed')
         order by o.ordered_at desc limit 1
      )`,
      lastNoOrder: sql<string | null>`(
        select (c.started_at at time zone 'Asia/Kolkata')::date::text from ${calls} c
         where c.customer_id = customers.id and c.outcome = 'no_order'
         order by c.started_at desc limit 1
      )`,
      lastNote: sql<string | null>`(
        select c.notes from ${calls} c
         where c.customer_id = customers.id and c.notes is not null
         order by c.started_at desc limit 1
      )`,
      targetGap: sql<number>`coalesce((
        select greatest(0, t.target_amount - coalesce((
          select sum(o.total_amount) from ${orders} o
           where o.customer_id = customers.id
             and o.status in ('captured','confirmed','dispatched')
             and extract(year  from o.ordered_at) = t.year
             and extract(month from o.ordered_at) = t.month
        ), 0))
        from ${monthlyTargets} t
        where t.customer_id = customers.id
          and t.year = ${Number(monthKey(day).slice(0, 4))}
          and t.month = ${Number(monthKey(day).slice(5, 7))}
      ), 0)`,
    })
    .from(customers)
    // Not `status = 'active'`: going quiet marks a customer inactive, and the
    // one thing you must still be able to do with them is call. Only a
    // deactivated customer leaves the queue.
    .where(
      and(
        ne(customers.status, "deactivated"),
        // Naming one customer replaces the scope filter rather than narrowing
        // it. A manager logging a call on somebody else's account is entitled
        // to be told what happens next with it — the caller has already been
        // scope-checked — and an owner filter here would answer "no such
        // customer" instead. `ids` still governs which REMINDERS count, which
        // is right: a callback belongs to whoever promised it.
        onlyCustomerId ? eq(customers.id, onlyCustomerId) : ownerFilter,
      ),
    );

  // Pending reminders assigned to whoever is asking, in one query.
  const reminderRows = await db
    .select({
      id: reminders.id,
      customerId: reminders.customerId,
      dueDate: reminders.dueDate,
      note: reminders.note,
      holdOtherReasonsUntilDue: reminders.holdOtherReasonsUntilDue,
    })
    .from(reminders)
    .where(
      and(
        eq(reminders.status, "pending"),
        ids ? inArray(reminders.assignedUserId, ids) : undefined,
      ),
    );

  const remindersByCustomer = new Map<string, QueueCandidate["reminders"]>();
  for (const r of reminderRows) {
    const list = remindersByCustomer.get(r.customerId) ?? [];
    list.push({
      id: r.id,
      dueDate: r.dueDate,
      note: r.note,
      holdOtherReasonsUntilDue: r.holdOtherReasonsUntilDue,
    });
    remindersByCustomer.set(r.customerId, list);
  }

  // Skips are recorded in the audit log rather than as queue rows — there is
  // no stored queue to mark. They last for the business day only.
  const skips = await db.execute<{ entity_id: string; reason: string }>(sql`
    select distinct on (entity_id) entity_id, after_state->>'reason' as reason
      from audit_log
     where action = 'queue.skip'
       and after_state->>'day' = ${day}
     order by entity_id, at desc
  `);
  const skipReason = new Map(skips.map((s) => [s.entity_id, s.reason]));

  const detail = new Map(rows.map((r) => [r.customer.id, r]));

  const candidates: QueueCandidate[] = rows.map(
    ({
      customer: c,
      calledToday,
      targetGap,
      lastAnsweredOutcome,
      lastAnsweredDate,
      noAnswerCount,
      lastNoAnswerAt,
      openOrderStatus,
      typicalOrderPaise,
    }) => ({
      customerId: c.id,
      name: c.name,
      ownerId: c.ownerId,
      lastOrderDate: c.lastOrderDate,
      cycleDays: c.cycleDays,
      cycleIsDefault: c.cycleIsDefault,
      cycleConfidence: c.cycleConfidence,
      typicalOrderPaise: Number(typicalOrderPaise ?? 0),
      lastContactDate: c.lastContactDate,
      // In the business's own zone, never UTC. `toISOString()` on a
      // timestamptz is the same bug as a bare `::date` in SQL wearing different
      // clothes.
      //
      // A BUSINESS date, because the queue differences it against today to
      // decide when a prospect is due their first call. It was a calendar
      // date, so for the five hours before the day boundary a customer added
      // overnight was measured on one scale against a today on the other.
      createdDate: businessDate(c.createdAt, {
        timezone: config["workingDay.timezone"],
        dayBoundaryHour: config["workingDay.dayBoundaryHour"],
        workingDays: config["workingDay.workingDays"],
      }),
      reminders: remindersByCustomer.get(c.id) ?? [],
      lastConfirmedWhatsappDate: c.lastConfirmedWhatsappDate,
      activeInOrderSystem: c.activeInOrderSystem,
      thirdParty: c.thirdParty,
      calledToday: Boolean(calledToday),
      doNotContact: c.doNotContact,
      skippedTodayReason: skipReason.get(c.id) ?? null,
      outstanding: c.outstanding,
      targetGap: Number(targetGap ?? 0),
      lastAnsweredOutcome: lastAnsweredOutcome ?? null,
      lastAnsweredDate: lastAnsweredDate ?? null,
      noAnswerCount: Number(noAnswerCount ?? 0),
      lastNoAnswerAt: lastNoAnswerAt ?? null,
      openOrderStatus: openOrderStatus ? orderStatusLabel(openOrderStatus) : null,
      /* Filled in below, from the collections engine's own conclusion. */
      paymentCallDue: null,
    }),
  );

  return { config, rows, detail, candidates };
}

/**
 * What happens next with one customer, and why.
 *
 * The forward question, answered from live data every time it is asked. The
 * copy stored on a call row is what somebody was TOLD; this is what is true
 * now, and the two are meant to be able to differ.
 *
 * Null when there is nothing to answer about — a deactivated customer, or one
 * that has gone since the call was logged.
 */
export async function nextStepForCustomer(
  customerId: string,
): Promise<NextStep | null> {
  const ctx = await resolveScope();
  const day = await today();
  const { config, candidates } = await queueInputs([ctx.user.id], day, customerId);

  const candidate = candidates[0];
  if (!candidate) return null;

  // The collections engine's own conclusion, folded in exactly as the queue
  // folds it in — the verdict for today, and the date behind it so the search
  // can roll forward.
  let paymentNextCallOn: string | null = null;
  if (config["queue.includePaymentDue"]) {
    const cadence = await paymentCadenceFor(customerId);
    if (cadence) {
      paymentNextCallOn = cadence.nextCallOn;
      if (cadence.nextCallOn <= day) {
        candidate.paymentCallDue = {
          totalOverdue: cadence.totalOverdue,
          daysOverdue: cadence.daysOverdue,
        };
      }
    }
  }

  return nextStep({ candidate, paymentNextCallOn }, day, config, Date.now());
}

/** The snapshot job's view: one telecaller's list, ranked as they would see it. */
export async function queueCandidatesFor(userId: string, day: string) {
  const { candidates } = await queueInputs([userId], day);
  return candidates;
}

/**
 * The stored status as a sentence. `pending_approval` is what the column
 * says; "waiting for accounts to approve" is what a telecaller needs to know
 * before ringing somebody about it.
 */
function orderStatusLabel(status: string): string {
  switch (status) {
    case "pending_approval":
      return "waiting for accounts to approve";
    case "captured":
      return "taken, not yet dispatched";
    case "confirmed":
      return "confirmed, awaiting dispatch";
    default:
      return status.replace(/_/g, " ");
  }
}

/**
 * Read the day's list, building and storing it the first time it is asked for.
 *
 * WHAT IS FROZEN is the composition: who is on the list, why, and in what
 * order. WHAT STAYS LIVE is whether each row still needs doing.
 *
 * That distinction is the whole design. A list frozen completely would go on
 * asking a telecaller to chase an order the customer placed an hour ago, which
 * is the one thing the specification is most emphatic about. A list not frozen
 * at all is the moving target this replaces. So:
 *
 *   · a row whose customer has since been called, skipped, ordered, or been
 *     marked do-not-contact is dropped from the callable list and appears in
 *     the held-back strip with the reason, exactly as it would have done;
 *
 *   · a REMINDER falling due today is added the moment it does. A promise made
 *     to a customer cannot wait for tomorrow's list, and it is the only thing
 *     urgent enough to reopen a settled day.
 */
async function settleDayList(
  userId: string,
  day: BusinessDate,
  live: QueueResult,
  candidates: QueueCandidate[],
  config: Awaited<ReturnType<typeof getConfig>>,
): Promise<QueueResult> {
  const stored = await db
    .select()
    .from(queueSnapshots)
    .where(and(eq(queueSnapshots.day, day), eq(queueSnapshots.userId, userId)))
    .orderBy(asc(queueSnapshots.rank));

  if (!stored.length) {
    // First read of the business day. Write what the engine just decided.
    if (live.entries.length) {
      await db
        .insert(queueSnapshots)
        .values(
          live.entries.map((e, i) => ({
            day,
            userId,
            customerId: e.customerId,
            score: e.score,
            reasons: e.reasons,
            rank: i,
          })),
        )
        // Two tabs opening at once is one list, not a crash.
        .onConflictDoNothing();
    }
    return live;
  }

  /*
   * The day is already settled. Rebuild its entries from the stored rows, in
   * the stored order, and let today's live state decide what is still callable.
   */
  const liveById = new Map(live.entries.map((e) => [e.customerId, e]));
  const heldById = new Map(live.suppressed.map((h) => [h.customerId, h]));
  const byId = new Map(candidates.map((c) => [c.customerId, c]));

  const entries: QueueResult["entries"] = [];
  const suppressed = [...live.suppressed.filter((h) => !liveById.has(h.customerId))];

  for (const row of stored) {
    const candidate = byId.get(row.customerId);
    // Out of the book entirely since the list was settled — reassigned, or
    // deactivated. Not held back: it is not this person's to explain.
    if (!candidate) continue;

    const stillLive = liveById.get(row.customerId);
    if (stillLive) {
      // Keep the settled reason and rank; a customer does not get re-ranked
      // mid-morning because their outstanding moved.
      entries.push({
        customerId: row.customerId,
        name: candidate.name,
        score: row.score,
        reasons: (row.reasons.length
          ? row.reasons
          : stillLive.reasons) as QueueResult["entries"][number]["reasons"],
        outstanding: candidate.outstanding,
        // Recomputed from the settled reason against today's figures. The
        // RANK is frozen — a customer is not re-ranked mid-morning because
        // their outstanding moved — so this only ever describes the row; it
        // does not move it.
        callValue: callValuePaise(
          (row.reasons[0]?.kind ?? stillLive.reasons[0].kind) as Parameters<
            typeof callValuePaise
          >[0],
          candidate,
        ),
        targetGap: candidate.targetGap,
        daysSinceContact: stillLive.daysSinceContact,
      });
      continue;
    }

    // No longer callable. Say why, rather than letting it vanish.
    const held = heldById.get(row.customerId);
    if (!suppressed.some((h) => h.customerId === row.customerId)) {
      suppressed.push({
        customerId: row.customerId,
        name: candidate.name,
        reason: held?.reason ?? "Dealt with since the list was settled",
      });
    }
  }

  /*
   * A promise falling due today reopens the settled list — and only that.
   * Anything else waits for tomorrow, which is the point of settling it.
   */
  const settledIds = new Set(stored.map((r) => r.customerId));
  const promises = live.entries.filter(
    (e) =>
      !settledIds.has(e.customerId) &&
      e.reasons.some(
        (r) => r.kind === "reminderDueToday" || r.kind === "reminderOverdue",
      ),
  );
  if (promises.length) {
    entries.unshift(...promises);
    await db
      .insert(queueSnapshots)
      .values(
        promises.map((e, i) => ({
          day,
          userId,
          customerId: e.customerId,
          score: e.score,
          reasons: e.reasons,
          rank: -1 - i,
        })),
      )
      .onConflictDoNothing();
  }

  const limit = config["queue.maxSizePerUser"];
  return {
    entries: limit > 0 ? entries.slice(0, limit) : entries,
    suppressed,
    totalQualified: entries.length,
  };
}

export async function getQueue(): Promise<QueueView> {


  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const day = await today();
  const { config, detail, candidates } = await queueInputs(ids, day);

  /*
   * The collections engine's own conclusion, folded in — NOT re-derived.
   *
   * It owns the cadence: a quiet window measured from the due date, a message
   * every few days through it, calls opening on day 16 and the customer
   * resting between them. Working any of that out again here would be a
   * second copy of a rule that has already been got right once.
   *
   * What this does is show the answer on the calling list, so a telecaller
   * works one list rather than two — the customers this engine says are due a
   * payment call arrive at the top, with the money and the days on the row.
   */
  if (config["queue.includePaymentDue"]) {
    const plan = await getPaymentFollowUpPlan();
    const dueToday = new Map(
      plan.calls.map((c) => [
        c.customerId,
        { totalOverdue: c.totalOverdue, daysOverdue: c.daysOverdue },
      ]),
    );
    for (const c of candidates) {
      c.paymentCallDue = dueToday.get(c.customerId) ?? null;
    }
  }

  /*
   * THE DAY'S LIST, settled once.
   *
   * The list used to be worked out afresh on every load, which meant it could
   * reshuffle under a telecaller mid-morning because a colleague logged a call
   * or a bill fell due. It is built once per business day now and read from
   * storage after that, so the day is something a person can plan and "twelve
   * of forty worked" is a real figure rather than a fraction of a moving
   * denominator.
   *
   * NO CRON REQUIRED. The first read of the day builds it. A scheduled job can
   * warm it before anybody signs in — `npm run jobs -- build-queues` — but
   * nothing depends on that job having run, which matters on a deployment
   * where the scheduler is somebody else's to switch on.
   */
  const live = buildQueue(candidates, day, config, Date.now());
  const result = await settleDayList(ctx.user.id, day, live, candidates, config);

  // "Worked" is how many of today's candidates have already been called —
  // derived from the calls table, not from a stored queue row.
  const worked = candidates.filter((c) => c.calledToday).length;
  const total = result.totalQualified + worked;

  // Re-attach the customer detail the screen and call panel need. The scan
  // already read these rows, so this costs nothing extra.
  const entries: QueueRow[] = result.entries.map((e) => {
    const row = detail.get(e.customerId)!;
    const c = row.customer;
    return {
      ...e,
      contactPerson: c.contactPerson,
      phone: c.phone,
      city: c.city,
      ownerName: row.ownerName,
      assignedToName: row.assignedToName,
      kind: c.kind,
      // Active or inactive, said on the card. It is `recomputeInactiveWatch`
      // that writes this — twice the customer's own cycle with no order — and
      // it clears itself the moment one arrives. The queue no longer holds
      // these customers back, so the badge is the only thing telling a
      // telecaller which conversation they are about to have.
      status: c.status,
      deactivationRequested: c.deactivationRequested,
      slowPayer: c.slowPayer,
      lastOrderDate: c.lastOrderDate,
      lastOrderValue: c.lastOrderValue,
      creditTermDays: c.creditTermDays,
      openComplaint: row.openComplaint,
      lastNote: row.lastNote,
    };
  });

  // Carried over: on today's list and on the previous working day's too. Not
  // "was due yesterday and ignored" — a row can legitimately reappear — but
  // the plain fact that it has been waiting more than one day.
  const previous = previousWorkingDay(day, {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  });
  const snapshotRows = await db
    .select({ customerId: queueSnapshots.customerId })
    .from(queueSnapshots)
    .where(
      ids
        ? and(
            eq(queueSnapshots.day, previous),
            inArray(queueSnapshots.userId, ids),
          )
        : eq(queueSnapshots.day, previous),
    );
  const yesterdaysList = new Set(snapshotRows.map((r) => r.customerId));

  return {
    ...result,
    entries,
    carriedOver: yesterdaysList.size
      ? entries.filter((e) => yesterdaysList.has(e.customerId)).length
      : null,
    snapshotHour: config["queue.snapshotHour"],
    progress: {
      worked,
      total,
      percent: total ? Math.round((worked / total) * 100) : 0,
    },
    scopeLabel:
      ctx.scope.kind === "own" ? `${ctx.user.name}'s book` : "Whole team",
  };
}

/** Everything the call panel needs for one queue customer. */
export async function getQueueCustomer(customerId: string) {
  const [row] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId));
  return row ?? null;
}

export { gte, lte };
