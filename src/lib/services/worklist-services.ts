import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  complaints,
  complaintStatusHistory,
  customers,
  inactiveWatchItems,
  monthlyTargets,
  orders,
  reminders,
  users,
} from "@/db/schema";
import {
  assertCustomerInScope,
  requireCapability,
  resolveScope,
  scopedUserIds,
} from "../access-control";
import { getConfig } from "../config/store";
import { classifyShortfall, resolveTarget } from "../engines/targets";
import { watchAge } from "../engines/inactivity";
import { recomputeInactivity, today } from "../recompute";
import {
  addDays,
  addMonths,
  daysBetween,
  monthKey,
  onOrAfterWorkingDay,
} from "../business-date";
import { err, ok, okVoid, type Result } from "../result";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ============================================================== reminders */

/**
 * "Due" and "overdue" are DERIVED by comparing the due date to today. Storing
 * them would need a nightly job that can fail and leave the interface lying.
 */
export type ReminderView = "due_today" | "overdue" | "upcoming" | "completed" | "dismissed";

export type ReminderRow = {
  id: string;
  customerId: string;
  customerName: string;
  assignedUserName: string;
  dueDate: string;
  note: string;
  type: string;
  status: "pending" | "completed" | "dismissed";
  systemGenerated: boolean;
  rescheduleCount: number;
  /** Computed on read, never stored. */
  displayStatus: "overdue" | "due_today" | "upcoming" | "completed" | "dismissed";
  overdueDays: number;
  rescheduledOften: boolean;
};

export async function listReminders(view?: ReminderView): Promise<ReminderRow[]> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const config = await getConfig();
  const day = await today();

  const rows = await db
    .select({
      reminder: reminders,
      customerName: customers.name,
      assignedUserName: users.name,
    })
    .from(reminders)
    .innerJoin(customers, eq(customers.id, reminders.customerId))
    .innerJoin(users, eq(users.id, reminders.assignedUserId))
    .where(ids ? inArray(reminders.assignedUserId, ids) : undefined)
    .orderBy(asc(reminders.dueDate));

  const mapped = rows.map(({ reminder: r, customerName, assignedUserName }) => {
    const overdueDays = Math.max(0, daysBetween(r.dueDate, day));
    const displayStatus =
      r.status === "completed"
        ? "completed"
        : r.status === "dismissed"
          ? "dismissed"
          : r.dueDate < day
            ? "overdue"
            : r.dueDate === day
              ? "due_today"
              : "upcoming";

    return {
      id: r.id,
      customerId: r.customerId,
      customerName,
      assignedUserName,
      dueDate: r.dueDate,
      note: r.note,
      type: r.type,
      status: r.status,
      systemGenerated: r.systemGenerated,
      rescheduleCount: r.rescheduleCount,
      displayStatus,
      overdueDays,
      rescheduledOften:
        r.rescheduleCount >= config["reminders.rescheduleWarningCount"],
    } satisfies ReminderRow;
  });

  if (!view) return mapped;
  return mapped.filter((r) => r.displayStatus === view);
}

export const reminderSchema = z.object({
  customerId: z.string().min(1),
  dueDate: z.string().min(1, "Pick a due date."),
  note: z.string().min(1, "Write what was promised - this is what you will read back later."),
  type: z
    .enum([
      "call_back",
      "payment_promise",
      "order_confirmation",
      "send_information",
      "check_stock",
      "other",
    ])
    .default("call_back"),
  assignedUserId: z.string().optional(),
});

export async function createReminder(
  raw: z.input<typeof reminderSchema>,
): Promise<Result<{ id: string }>> {
  const parsed = reminderSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(issue.message, "validation", [
      { field: issue.path.join("."), message: issue.message },
    ]);
  }
  const input = parsed.data;
  const ctx = await resolveScope();
  const config = await getConfig();

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, input.customerId));
  if (!customer) return err("That customer no longer exists.", "not_found");
  await assertCustomerInScope(customer);

  const due = config["reminders.rollForwardOnNonWorkingDays"]
    ? onOrAfterWorkingDay(input.dueDate, {
        timezone: config["workingDay.timezone"],
        dayBoundaryHour: config["workingDay.dayBoundaryHour"],
        workingDays: config["workingDay.workingDays"],
      })
    : input.dueDate;

  const reminderId = id("rem");
  await db.insert(reminders).values({
    id: reminderId,
    customerId: input.customerId,
    createdByUserId: ctx.user.id,
    assignedUserId: input.assignedUserId ?? ctx.user.id,
    dueDate: due,
    note: input.note.trim(),
    type: input.type,
    createdById: ctx.user.id,
    updatedById: ctx.user.id,
  });

  return ok({ id: reminderId }, `Reminder set for ${due}`);
}

export async function completeReminder(
  reminderId: string,
  closureNote?: string,
): Promise<Result> {
  const ctx = await resolveScope();
  await db
    .update(reminders)
    .set({
      status: "completed",
      closedAt: new Date(),
      closedById: ctx.user.id,
      closureNote: closureNote ?? null,
      updatedAt: new Date(),
      updatedById: ctx.user.id,
    })
    .where(eq(reminders.id, reminderId));
  return okVoid("Reminder completed");
}

export async function dismissReminder(
  reminderId: string,
  reason: string,
): Promise<Result> {
  if (!reason.trim()) {
    return err("A reason is required to dismiss a reminder.", "validation", [
      { field: "reason", message: "Give a reason." },
    ]);
  }
  const ctx = await resolveScope();
  await db
    .update(reminders)
    .set({
      status: "dismissed",
      dismissReason: reason.trim(),
      closedAt: new Date(),
      closedById: ctx.user.id,
      updatedAt: new Date(),
      updatedById: ctx.user.id,
    })
    .where(eq(reminders.id, reminderId));
  return okVoid("Reminder dismissed");
}

export async function rescheduleReminder(
  reminderId: string,
  newDate: string,
  note?: string,
): Promise<Result> {
  const ctx = await resolveScope();
  const config = await getConfig();

  const [existing] = await db.select().from(reminders).where(eq(reminders.id, reminderId));
  if (!existing) return err("That reminder no longer exists.", "not_found");

  const due = config["reminders.rollForwardOnNonWorkingDays"]
    ? onOrAfterWorkingDay(newDate, {
        timezone: config["workingDay.timezone"],
        dayBoundaryHour: config["workingDay.dayBoundaryHour"],
        workingDays: config["workingDay.workingDays"],
      })
    : newDate;

  await db
    .update(reminders)
    .set({
      dueDate: due,
      rescheduleCount: existing.rescheduleCount + 1,
      ...(note?.trim() ? { note: note.trim() } : {}),
      updatedAt: new Date(),
      updatedById: ctx.user.id,
    })
    .where(eq(reminders.id, reminderId));

  return okVoid(`Moved to ${due}`);
}

/** Carrying forward always lands on a working day. */
export async function carryForward(reminderId: string): Promise<Result> {
  const config = await getConfig();
  const day = await today();
  const next = onOrAfterWorkingDay(addDays(day, 1), {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  });
  return rescheduleReminder(reminderId, next);
}

/* ============================================================= complaints */

export async function listComplaints(status?: string) {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const day = await today();

  const rows = await db
    .select({
      complaint: complaints,
      customerName: customers.name,
      loggedByName: users.name,
    })
    .from(complaints)
    .innerJoin(customers, eq(customers.id, complaints.customerId))
    .innerJoin(users, eq(users.id, complaints.loggedByUserId))
    .where(
      and(
        ids ? inArray(customers.ownerId, ids) : undefined,
        status ? eq(complaints.status, status as never) : undefined,
      ),
    )
    .orderBy(asc(complaints.slaDueAt));

  return rows.map(({ complaint: c, customerName, loggedByName }) => ({
    ...c,
    customerName,
    loggedByName,
    ageDays: daysBetween(c.createdAt.toISOString().slice(0, 10), day),
    slaBreached: !c.resolvedAt && c.slaDueAt < new Date(),
  }));
}

/**
 * Every history line for a set of complaints, keyed by complaint. The screen
 * shows history in a drawer that can open on any row, so fetching per row on
 * open would be a click-latency tax for no benefit at this volume.
 */
export async function complaintHistories(
  complaintIds: string[],
): Promise<Record<string, Array<{ at: string; note: string }>>> {
  if (!complaintIds.length) return {};

  const rows = await db
    .select({ history: complaintStatusHistory, byName: users.name })
    .from(complaintStatusHistory)
    .leftJoin(users, eq(users.id, complaintStatusHistory.changedById))
    .where(inArray(complaintStatusHistory.complaintId, complaintIds))
    .orderBy(asc(complaintStatusHistory.at));

  const out: Record<string, Array<{ at: string; note: string }>> = {};
  for (const { history: h, byName } of rows) {
    (out[h.complaintId] ??= []).push({
      at: h.at.toISOString(),
      note: [
        `${h.fromStatus ? `${STATUS_LABEL[h.fromStatus]} → ` : ""}${STATUS_LABEL[h.toStatus]}`,
        h.note,
        byName,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  return out;
}

export const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  awaiting_customer: "Awaiting customer",
  resolved: "Resolved",
  closed: "Closed",
  rejected: "Rejected",
};

export async function complaintHistory(complaintId: string) {
  return db
    .select({ history: complaintStatusHistory, byName: users.name })
    .from(complaintStatusHistory)
    .leftJoin(users, eq(users.id, complaintStatusHistory.changedById))
    .where(eq(complaintStatusHistory.complaintId, complaintId))
    .orderBy(asc(complaintStatusHistory.at));
}

export async function changeComplaintStatus(
  complaintId: string,
  toStatus: "open" | "in_progress" | "awaiting_customer" | "rejected" | "closed",
  note?: string,
): Promise<Result> {
  const ctx = await resolveScope();
  const [existing] = await db
    .select()
    .from(complaints)
    .where(eq(complaints.id, complaintId));
  if (!existing) return err("That complaint no longer exists.", "not_found");

  await db.transaction(async (tx) => {
    await tx
      .update(complaints)
      .set({ status: toStatus, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(eq(complaints.id, complaintId));
    await tx.insert(complaintStatusHistory).values({
      id: id("csh"),
      complaintId,
      fromStatus: existing.status,
      toStatus,
      changedById: ctx.user.id,
      note: note ?? null,
    });
  });

  return okVoid("Status updated");
}

/** Resolution is a manager action, and the notes are mandatory. */
export async function resolveComplaint(input: {
  complaintId: string;
  resolutionNotes: string;
  customerInformed: boolean;
}): Promise<Result> {
  const ctx = await requireCapability("complaint.resolve");

  if (!input.resolutionNotes.trim()) {
    return err(
      "Write what was done before closing - the customer record will show it.",
      "validation",
      [{ field: "resolutionNotes", message: "Resolution notes are required." }],
    );
  }

  const [existing] = await db
    .select()
    .from(complaints)
    .where(eq(complaints.id, input.complaintId));
  if (!existing) return err("That complaint no longer exists.", "not_found");

  await db.transaction(async (tx) => {
    await tx
      .update(complaints)
      .set({
        status: "resolved",
        resolutionNotes: input.resolutionNotes.trim(),
        customerInformed: input.customerInformed,
        resolvedAt: new Date(),
        resolvedById: ctx.user.id,
        updatedAt: new Date(),
        updatedById: ctx.user.id,
      })
      .where(eq(complaints.id, input.complaintId));
    await tx.insert(complaintStatusHistory).values({
      id: id("csh"),
      complaintId: input.complaintId,
      fromStatus: existing.status,
      toStatus: "resolved",
      changedById: ctx.user.id,
      note: input.resolutionNotes.trim(),
    });
  });

  return okVoid("Complaint resolved");
}

/* ========================================================= inactive watch */

export type WatchRow = {
  customerId: string;
  name: string;
  phone: string;
  city: string;
  ownerName: string | null;
  lastOrderDate: string | null;
  daysSinceLastOrder: number;
  cycleDays: number;
  cycleIsDefault: boolean;
  cyclesElapsed: string;
  valueAtRisk: number;
  flaggedAt: string;
  ageDays: number;
  needsDecision: boolean;
  outcome: string | null;
  lastContactDate: string | null;
  deactivationRequested: boolean;
  deactivationReason: string | null;
};

/** Sorted by age without a decision — the column the module exists for. */
export async function listInactiveWatch(): Promise<WatchRow[]> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const config = await getConfig();
  const day = await today();

  const rows = await db
    .select({
      item: inactiveWatchItems,
      customer: customers,
      ownerName: sql<string | null>`(select name from users u where u.id = customers.owner_id)`,
    })
    .from(inactiveWatchItems)
    .innerJoin(customers, eq(customers.id, inactiveWatchItems.customerId))
    .where(ids ? inArray(customers.ownerId, ids) : undefined);

  return rows
    .map(({ item, customer, ownerName }) => {
      const flaggedDate = item.flaggedAt.toISOString().slice(0, 10);
      const age = watchAge(flaggedDate, Boolean(item.outcome), day, config);
      return {
        customerId: customer.id,
        name: customer.name,
        phone: customer.phone,
        city: customer.city,
        ownerName,
        lastOrderDate: customer.lastOrderDate,
        daysSinceLastOrder: item.daysSinceLastOrder,
        cycleDays: customer.cycleDays,
        cycleIsDefault: customer.cycleIsDefault,
        cyclesElapsed: item.cyclesElapsed,
        valueAtRisk: item.valueAtRisk,
        flaggedAt: flaggedDate,
        ageDays: age.ageDays,
        needsDecision: age.needsDecision,
        outcome: item.outcome,
        lastContactDate: customer.lastContactDate,
        deactivationRequested: customer.deactivationRequested,
        deactivationReason: customer.deactivationReason,
      };
    })
    .sort((a, b) => b.ageDays - a.ageDays);
}

export async function recordWatchOutcome(
  customerId: string,
  outcome: "contacted" | "reminder_set" | "deactivation_requested" | "not_actually_inactive",
  reason?: string,
): Promise<Result> {
  const ctx = await resolveScope();
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!customer) return err("That customer no longer exists.", "not_found");
  await assertCustomerInScope(customer);

  await db
    .update(inactiveWatchItems)
    .set({
      outcome,
      outcomeAt: new Date(),
      outcomeById: ctx.user.id,
      outcomeReason: reason ?? null,
    })
    .where(eq(inactiveWatchItems.customerId, customerId));

  if (outcome === "deactivation_requested") {
    await db
      .update(customers)
      .set({ deactivationRequested: true, deactivationReason: reason ?? null })
      .where(eq(customers.id, customerId));
  }

  // "Not actually inactive" is a data correction, so re-evaluate rather than
  // leaving a row that the engine would immediately re-create.
  if (outcome === "not_actually_inactive") {
    await recomputeInactivity();
  }

  await db.insert(auditLog).values({
    id: id("aud"),
    actorId: ctx.user.id,
    action: "watch.outcome",
    entityType: "customer",
    entityId: customerId,
    afterState: { outcome, reason } as never,
  });

  return okVoid("Decision recorded");
}

/* ================================================================ targets */

export async function listTargets(period?: string) {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const config = await getConfig();
  const day = await today();
  const key = period ?? monthKey(day);
  const [year, month] = key.split("-").map(Number);

  const rows = await db
    .select({
      customer: customers,
      ownerName: sql<string | null>`(select name from users u where u.id = customers.owner_id)`,
      target: monthlyTargets.targetAmount,
      isDefault: monthlyTargets.isDefault,
      achieved: sql<number>`coalesce((
        select sum(o.total_amount) from ${orders} o
         where o.customer_id = customers.id
           and o.status in ('captured','confirmed','dispatched')
           and extract(year from o.ordered_at) = ${year}
           and extract(month from o.ordered_at) = ${month}
      ), 0)`,
      contactsThisMonth: sql<number>`(
        select count(*)::int from calls c
         where c.customer_id = customers.id
           and extract(year from c.started_at) = ${year}
           and extract(month from c.started_at) = ${month}
      )`,
    })
    .from(customers)
    .leftJoin(
      monthlyTargets,
      and(
        eq(monthlyTargets.customerId, customers.id),
        eq(monthlyTargets.year, year),
        eq(monthlyTargets.month, month),
      ),
    )
    .where(
      and(
        // A customer who has gone quiet still carries a target — that is the
        // gap the month has to explain. Only deactivation removes them.
        ne(customers.status, "deactivated"),
        ids ? inArray(customers.ownerId, ids) : undefined,
      ),
    )
    .orderBy(asc(customers.name));

  return rows.map((r) => {
    // Every active customer ends up with a figure — no blanks on the screen.
    const resolved =
      r.target !== null
        ? { amount: r.target, isDefault: r.isDefault ?? true }
        : resolveTarget(
            {
              manualAmount: null,
              trailingAchievement: [],
              customerSince: r.customer.customerSince,
              month: `${key}-01`,
            },
            config,
          );
    const achieved = Number(r.achieved ?? 0);
    return {
      customerId: r.customer.id,
      customerName: r.customer.name,
      ownerName: r.ownerName,
      cycleDays: r.customer.cycleDays,
      contactsThisMonth: Number(r.contactsThisMonth ?? 0),
      target: resolved.amount,
      achieved,
      gap: Math.max(0, resolved.amount - achieved),
      percent: resolved.amount ? Math.round((achieved / resolved.amount) * 100) : 0,
      isDefault: resolved.isDefault,
    };
  });
}

export async function setTarget(
  customerId: string,
  amount: number,
  period?: string,
): Promise<Result> {
  const ctx = await requireCapability("target.set");
  const day = await today();
  const key = period ?? monthKey(day);
  const [year, month] = key.split("-").map(Number);

  if (!Number.isInteger(amount) || amount <= 0) {
    return err("Enter the monthly target in rupees.", "validation", [
      { field: "amount", message: "Must be a positive amount." },
    ]);
  }

  await db
    .insert(monthlyTargets)
    .values({
      id: id("tgt"),
      customerId,
      year,
      month,
      targetAmount: amount,
      isDefault: false,
      setById: ctx.user.id,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    })
    .onConflictDoUpdate({
      target: [monthlyTargets.customerId, monthlyTargets.year, monthlyTargets.month],
      set: {
        targetAmount: amount,
        isDefault: false,
        setById: ctx.user.id,
        updatedAt: new Date(),
        updatedById: ctx.user.id,
      },
    });

  return okVoid("Target set");
}

export async function setTargetsBulk(
  customerIds: string[],
  mode: "amount" | "uplift",
  value: number,
  period?: string,
): Promise<Result<{ updated: number }>> {
  await requireCapability("target.set");
  if (!customerIds.length) return err("Select at least one customer.", "validation");

  const rows = await listTargets(period);
  const byId = new Map(rows.map((r) => [r.customerId, r]));

  let updated = 0;
  for (const cid of customerIds) {
    const current = byId.get(cid);
    const amount =
      mode === "amount"
        ? value
        : Math.round((current?.target ?? 0) * (1 + value / 100));
    if (amount > 0) {
      await setTarget(cid, amount, period);
      updated++;
    }
  }
  return ok({ updated }, `Targets set for ${updated} customers`);
}

/** The view a manager opens before a coaching conversation. */
export async function shortfallAnalysis(period?: string) {
  await requireCapability("target.shortfall");
  const day = await today();
  const rows = await listTargets(period);

  return classifyShortfall(
    rows.map((r) => ({
      customerId: r.customerId,
      name: r.customerName,
      target: r.target,
      achieved: r.achieved,
      contactsThisMonth: r.contactsThisMonth,
      cycleDays: r.cycleDays,
    })),
    day,
  );
}

export { addMonths, desc };
