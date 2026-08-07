import "server-only";
import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
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
import { ASSIGNED_TO_SQL, resolveScope, scopedUserIds } from "../access-control";
import {
  buildQueue,
  type QueueCandidate,
  type QueueResult,
} from "../engines/queue";
import { today } from "../recompute";
import {
  dayBoundaryWindow,
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
  contactPerson: string;
  phone: string;
  city: string;
  ownerName: string | null;
  kind: "lead" | "customer";
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
async function queueInputs(ids: string[] | null, day: string) {
  const config = await getConfig();
  const window = dayBoundaryWindow(day, {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  });

  // Whose book, by the single definition — a lead answers to its owner, a
  // customer to its sales account manager.
  const ownerFilter = ids ? inArray(ASSIGNED_TO_SQL, ids) : undefined;

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
      openComplaint: sql<string | null>`(
        select c.description from complaints c
         where c.customer_id = customers.id
           and c.status in ('open','in_progress','awaiting_customer')
         order by c.created_at desc limit 1
      )`,
      // The last call that ended in no order, for the re-ask cooldown. Note
      // customers.id spelled out: Drizzle renders ${customers.id} as a bare
      // "id", which inside this correlated subquery would bind to the INNER
      // table and quietly match every row.
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
    .where(and(ne(customers.status, "deactivated"), ownerFilter));

  // Pending reminders assigned to whoever is asking, in one query.
  const reminderRows = await db
    .select({
      id: reminders.id,
      customerId: reminders.customerId,
      dueDate: reminders.dueDate,
      note: reminders.note,
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
    list.push({ id: r.id, dueDate: r.dueDate, note: r.note });
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
    ({ customer: c, calledToday, targetGap, lastNoOrder }) => ({
      customerId: c.id,
      name: c.name,
      ownerId: c.ownerId,
      lastOrderDate: c.lastOrderDate,
      cycleDays: c.cycleDays,
      cycleIsDefault: c.cycleIsDefault,
      lastContactDate: c.lastContactDate,
      createdDate: c.createdAt.toISOString().slice(0, 10),
      reminders: remindersByCustomer.get(c.id) ?? [],
      lastConfirmedWhatsappDate: c.lastConfirmedWhatsappDate,
      activeInOrderSystem: c.activeInOrderSystem,
      calledToday: Boolean(calledToday),
      doNotContact: c.doNotContact,
      skippedTodayReason: skipReason.get(c.id) ?? null,
      outstanding: c.outstanding,
      targetGap: Number(targetGap ?? 0),
      lastNoOrderDate: lastNoOrder ?? null,
    }),
  );

  return { config, rows, detail, candidates };
}

/** The snapshot job's view: one telecaller's list, ranked as they would see it. */
export async function queueCandidatesFor(userId: string, day: string) {
  const { candidates } = await queueInputs([userId], day);
  return candidates;
}

export async function getQueue(): Promise<QueueView> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const day = await today();
  const { config, detail, candidates } = await queueInputs(ids, day);

  const result = buildQueue(candidates, day, config);

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
      kind: c.kind,
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
