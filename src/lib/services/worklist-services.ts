import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  attachments,
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
  ASSIGNED_TO_SQL,
  assertCustomerInScope,
  BACK_OFFICE_SQL,
  requireCapability,
  resolveScope,
  scopedToUsers,
  scopedUserIds,
  type RequestScope,
} from "../access-control";
import { getConfig } from "../config/store";
import {
  COMPLAINT_PRIORITIES,
  priorityLabel,
} from "../complaint-labels";
import { classifyShortfall, resolveTarget } from "../engines/targets";
import { watchAge } from "../engines/inactivity";
import {
  closureNoteFor,
  remindersClosedBy,
  type ClosableReminderType,
  type ClosureEvent,
} from "../engines/reminder-closure";
import { recomputeInactivity, today } from "../recompute";
import {
  addDays,
  addMonths,
  businessDate,
  daysBetween,
  monthKey,
  onOrAfterWorkingDay,
} from "../business-date";
import { err, ok, okVoid, type Result } from "../result";
import { shortDateWithYear } from "../format";
import { nextStepForCustomer } from "./queue-service";
import {
  customerFilterClause,
  customerFiltersOnly,
  DIRECT_CUSTOMER_SQL,
  resolveSort,
  type CustomerListFilters,
} from "../queries";
import { creditedToSql, CREDITED_TO_SEAT_SQL, type CreditSeat } from "../sales-attribution";

/**
 * Whose target a customer's monthly figure counts toward — the same rule
 * `sales_performance` is scored by: the salesperson on the account, the
 * back-office person only where there is no salesperson, nobody otherwise.
 * `sales_person_name` and `owner_id` are deliberately left out of this, unlike
 * the old `TARGET_OWNER_NAME_SQL` it replaces — a name from the sheet with no
 * MahekOne login cannot be credited with a target, and `owner_id` on an
 * imported book is whoever ran the import, one person on a thousand rows.
 */
const CREDITED_TO_NAME_SQL = sql<string | null>`(select name from users u where u.id = ${creditedToSql("customers")})`;

/**
 * The two seats, read straight off the id — deliberately no sheet-text
 * fallback, unlike `SALES_AM_NAME_SQL`/`BACK_OFFICE_AM_NAME_SQL` in
 * queries.ts. Shown beside the credited name so the screen can say "also
 * back office: X" when a different person holds the other seat — and a name
 * with no MahekOne login could never be that second name anyway.
 */
const SALES_SEAT_NAME_SQL = sql<string | null>`(select name from users u where u.id = customers.sales_am_id)`;
const BACK_OFFICE_SEAT_NAME_SQL = sql<string | null>`(select name from users u where u.id = customers.back_office_am_id)`;

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
  holdOtherReasonsUntilDue: boolean;
  /**
   * True where this reminder is the promise standing between the customer
   * and an earlier reason the system would otherwise surface — the same
   * live read `nextStepForCustomer` gives the confirmation dialog, so a
   * review pass here and the dialog can never disagree about which
   * reminders are worth holding. Only ever true for a future, pending
   * reminder: an overdue or due-today one already IS the answer.
   */
  hasConflictToday: boolean;
  /**
   * HOW it was closed, and by whom — null on a pending one, and null on a row
   * closed before any of this was recorded. The screen draws those three
   * cases differently: "closed by the call on 12 Sep" is a fact somebody can
   * check, "marked done by Vikram" is a person standing behind it, and a bare
   * "Done" is all that can honestly be said about the rest.
   */
  closedBy: "person" | "call" | "order" | "payment" | null;
  closedBySourceId: string | null;
  closedByName: string | null;
  closedOn: string | null;
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
      // The closer, not the assignee — a subquery rather than a second join,
      // because it is null on every pending row and an inner join would drop
      // exactly the rows this screen is for.
      closedByName: sql<
        string | null
      >`(select name from users u where u.id = ${reminders.closedById})`,
    })
    .from(reminders)
    .innerJoin(customers, eq(customers.id, reminders.customerId))
    .innerJoin(users, eq(users.id, reminders.assignedUserId))
    .where(ids ? inArray(reminders.assignedUserId, ids) : undefined)
    .orderBy(asc(reminders.dueDate));

  // Only a FUTURE pending reminder can be the thing standing between a
  // customer and an earlier reason — an overdue or due-today one is already
  // the answer, so there is nothing behind it to hold back from. Checked
  // through the exact same `nextStepForCustomer` the confirmation dialog
  // reads, never a second copy of the comparison.
  const candidates = rows.filter(
    ({ reminder: r }) => r.status === "pending" && r.dueDate > day,
  );
  const conflicts = new Set(
    (
      await Promise.all(
        candidates.map(async ({ reminder: r }) => {
          const step = await nextStepForCustomer(r.customerId);
          return step?.promise?.reminderId === r.id ? r.id : null;
        }),
      )
    ).filter((id): id is string => id !== null),
  );

  const mapped = rows.map(({ reminder: r, customerName, assignedUserName, closedByName }) => {
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
      holdOtherReasonsUntilDue: r.holdOtherReasonsUntilDue,
      hasConflictToday: conflicts.has(r.id),
      closedBy: r.closedBy,
      closedBySourceId: r.closedBySourceId,
      closedByName,
      // A date, not the instant: this is read on a list, and the hour a
      // reminder was ticked has never been the question anybody asks of it.
      closedOn: r.closedAt
        ? businessDate(r.closedAt, {
            timezone: config["workingDay.timezone"],
            dayBoundaryHour: config["workingDay.dayBoundaryHour"],
            workingDays: config["workingDay.workingDays"],
          })
        : null,
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
  /** Which enquiry this follow-up belongs to, where there is one. Optional — every other caller of this schema has no enquiry to name. */
  enquiryId: z.string().optional(),
});

/**
 * `skipCustomerScope` exists for exactly one caller —
 * `enquiry-service.ts`'s `createEnquiryReminder` — and nobody else may set
 * it: it is a plain TypeScript parameter, never part of `reminderSchema`,
 * so it can never arrive from a request body, form data, a URL, or any
 * other client-controlled payload.
 *
 * Website Enquiries is its own app, authorised by `requireEnquiriesAccess()`
 * (a flat app grant), not by the CRM's own "mine/team/all" scope — see
 * `lib/apps.ts`'s own entry for it. `assertCustomerInScope` below encodes
 * exactly that CRM concept, so applying it to an Enquiries-authorised caller
 * refuses a customer merely for not being in *that specific employee's* CRM
 * book, even though Enquiries was deliberately built to need no such thing.
 * The caller sets this only after it has already, independently, verified
 * the enquiry exists and that the customer is genuinely the one that
 * enquiry is linked to — every other rule in this function (the schema,
 * customer existence, the working-day roll-forward, the insert itself)
 * still runs unconditionally either way.
 */
export type CreateReminderOptions = { skipCustomerScope?: true };

export async function createReminder(
  raw: z.input<typeof reminderSchema>,
  opts?: CreateReminderOptions,
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
  if (!opts?.skipCustomerScope) {
    await assertCustomerInScope(customer);
  }

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
    enquiryId: input.enquiryId ?? null,
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

/**
 * CLOSING ONE BY HAND, which is now a capability rather than a button
 * everybody has.
 *
 * What it used to be is the reason: a promise was closed by asserting it had
 * been kept, which is a claim nobody can check and the one person who could
 * make it was the person being measured. Evidence closes these now — see
 * `closeRemindersOnEvidence` below — and this is what is left for the cases
 * evidence cannot reach: settled over WhatsApp, the shop has shut, the same
 * promise written down twice.
 *
 * Checked here rather than by drawing the button conditionally, because a
 * server action is a URL and a hidden control is not a permission. It is
 * audited for the same reason: a closure with no evidence behind it is exactly
 * the one somebody will want to ask about later.
 */
export async function completeReminder(
  reminderId: string,
  closureNote?: string,
): Promise<Result> {
  const ctx = await requireCapability("reminder.close");
  const [existing] = await db
    .select()
    .from(reminders)
    .where(eq(reminders.id, reminderId));
  if (!existing) return err("That reminder no longer exists.", "not_found");

  await db
    .update(reminders)
    .set({
      status: "completed",
      closedAt: new Date(),
      closedById: ctx.user.id,
      closedBy: "person",
      // Nothing to point at. That IS the distinction this column draws: a
      // closure with no source row is one somebody stood behind personally.
      closedBySourceId: null,
      closureNote: closureNote ?? null,
      updatedAt: new Date(),
      updatedById: ctx.user.id,
    })
    .where(eq(reminders.id, reminderId));

  await db.insert(auditLog).values({
    id: id("aud"),
    actorId: ctx.user.id,
    actorRole: ctx.authorisedBy,
    actorApp: ctx.authorisedIn,
    action: "reminder.close",
    entityType: "reminder",
    entityId: reminderId,
    beforeState: { status: existing.status, dueDate: existing.dueDate } as never,
    afterState: { status: "completed", note: closureNote ?? null } as never,
  });

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
  /*
   * The SAME capability as completing, deliberately.
   *
   * A reason typed into a dismissal clears the overdue pile exactly as
   * effectively as a tick does, so gating one and not the other would leave
   * the escape open and merely rename it. The reason is still required, and it
   * is worth more here than it was: the people who can now write one are the
   * people who have to answer for the list.
   */
  const ctx = await requireCapability("reminder.close");
  const [existing] = await db
    .select()
    .from(reminders)
    .where(eq(reminders.id, reminderId));
  if (!existing) return err("That reminder no longer exists.", "not_found");

  await db
    .update(reminders)
    .set({
      status: "dismissed",
      dismissReason: reason.trim(),
      closedAt: new Date(),
      closedById: ctx.user.id,
      closedBy: "person",
      closedBySourceId: null,
      updatedAt: new Date(),
      updatedById: ctx.user.id,
    })
    .where(eq(reminders.id, reminderId));

  await db.insert(auditLog).values({
    id: id("aud"),
    actorId: ctx.user.id,
    actorRole: ctx.authorisedBy,
    actorApp: ctx.authorisedIn,
    action: "reminder.dismiss",
    entityType: "reminder",
    entityId: reminderId,
    beforeState: { status: existing.status, dueDate: existing.dueDate } as never,
    afterState: { status: "dismissed", reason: reason.trim() } as never,
  });

  return okVoid("Reminder dismissed");
}

/* ------------------------------------------- closing a promise on evidence */

/**
 * The engine wired to data: what just happened to this customer, and the
 * pending promises it settles.
 *
 * Takes the TRANSACTION it is called inside, never `db`. The call, the order
 * and the receipt are each written in one transaction with everything they
 * produced — "half-saved calls are how telecaller data goes wrong" — and a
 * reminder closed outside it would survive a rolled-back call, leaving the
 * promise gone and no record of the conversation that supposedly closed it.
 *
 * `exclude` is the reminder the same transaction has just CREATED. A call
 * whose outcome is "follow up" writes tomorrow's promise, and the event that
 * wrote it must not then close it — the customer would be dropped on the spot,
 * with a next step everybody believes in and nothing anywhere chasing it.
 *
 * Returns how many it closed, so a caller can say so; it is never an error
 * that the answer is none.
 */
export async function closeRemindersOnEvidence(
  tx: Pick<typeof db, "select" | "update">,
  input: {
    customerId: string;
    event: ClosureEvent;
    /** The row that is the evidence — a call, an order, a receipt. */
    sourceId: string;
    /** Whoever made the call, took the order or confirmed the money. */
    actorId: string;
    exclude?: Array<string | null | undefined>;
  },
): Promise<number> {
  const excluded = new Set(input.exclude?.filter(Boolean) as string[]);

  const pending = await tx
    .select({
      id: reminders.id,
      type: reminders.type,
      dueDate: reminders.dueDate,
    })
    .from(reminders)
    .where(
      and(
        eq(reminders.customerId, input.customerId),
        eq(reminders.status, "pending"),
      ),
    );

  const closing = remindersClosedBy(
    pending
      .filter((r) => !excluded.has(r.id))
      .map((r) => ({
        id: r.id,
        type: r.type as ClosableReminderType,
        dueDate: r.dueDate,
      })),
    input.event,
  );
  if (!closing.length) return 0;

  await tx
    .update(reminders)
    .set({
      status: "completed",
      closedAt: new Date(),
      // WHO, still — the person who made the call, not the person who tidied
      // the list. The two used to be the same and the whole point of this
      // change is that they are no longer.
      closedById: input.actorId,
      closedBy: input.event.kind,
      closedBySourceId: input.sourceId,
      closureNote: closureNoteFor(input.event),
      updatedAt: new Date(),
      updatedById: input.actorId,
    })
    .where(inArray(reminders.id, closing));

  return closing.length;
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

/**
 * A telecaller's own decision that this promise covers what the system would
 * otherwise ask about — see `holdWindow` in `lib/engines/queue.ts` for what
 * it actually does. Offered beside the promise sentence, never inferred.
 */
export async function holdOtherReasonsUntilReminder(
  reminderId: string,
): Promise<Result> {
  const ctx = await resolveScope();
  const day = await today();

  const [existing] = await db.select().from(reminders).where(eq(reminders.id, reminderId));
  if (!existing) return err("That reminder no longer exists.", "not_found");
  if (existing.status !== "pending") {
    return err("That reminder is no longer pending.", "validation");
  }
  if (existing.dueDate <= day) {
    return err(
      "That reminder is due today or already overdue, so there is nothing to hold until.",
      "validation",
    );
  }
  if (existing.holdOtherReasonsUntilDue) {
    return okVoid(`Already holding until ${shortDateWithYear(existing.dueDate, day)}`);
  }

  await db
    .update(reminders)
    .set({
      holdOtherReasonsUntilDue: true,
      updatedAt: new Date(),
      updatedById: ctx.user.id,
    })
    .where(eq(reminders.id, reminderId));

  return okVoid(`Holding other calls until ${shortDateWithYear(existing.dueDate, day)}`);
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
  /* Needed because the age below is measured against `day`, which is a
   * business date — see the comment on that line. */
  const config = await getConfig();
  const workingDay = {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  };

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
        scopedToUsers(ids),
        status ? eq(complaints.status, status as never) : undefined,
      ),
    )
    .orderBy(asc(complaints.slaDueAt));

  return rows.map(({ complaint: c, customerName, loggedByName }) => ({
    ...c,
    customerName,
    loggedByName,
    /* Both sides business dates. A complaint logged at 1am is a day old the
     * moment the shift it belongs to ends, not a day before it started —
     * mixing the two put a negative age on complaints raised overnight. */
    ageDays: daysBetween(businessDate(c.createdAt, workingDay), day),
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
      // The name is appended, unless the note already ends in it. Opening a
      // complaint writes "Logged by Priya" and this used to add "Priya" after
      // it, so every first line read "Logged by Priya · Priya".
      note: [
        `${h.fromStatus ? `${STATUS_LABEL[h.fromStatus]} → ` : ""}${STATUS_LABEL[h.toStatus]}`,
        h.note,
        byName && h.note?.trim().endsWith(byName) ? null : byName,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  return out;
}

/**
 * The photographs on a set of complaints, keyed by complaint.
 *
 * Batched exactly like `complaintHistories`, because the list screen opens a
 * drawer over rows it has already read and must not go back to the database
 * per complaint to do it.
 *
 * The bytes are NOT here. Only what is needed to render a thumbnail and its
 * link — `/api/attachments/[id]` serves the file itself, and it is the only
 * thing that does, because that is where the parent's scope is checked.
 */
export async function complaintAttachments(
  complaintIds: string[],
): Promise<Record<string, Array<{ id: string; filename: string; isImage: boolean }>>> {
  if (!complaintIds.length) return {};

  const rows = await db
    .select({
      id: attachments.id,
      parentId: attachments.parentId,
      filename: attachments.filename,
      contentType: attachments.contentType,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.parentType, "complaint"),
        inArray(attachments.parentId, complaintIds),
        eq(attachments.status, "available"),
      ),
    )
    .orderBy(asc(attachments.uploadedAt));

  const out: Record<string, Array<{ id: string; filename: string; isImage: boolean }>> = {};
  for (const r of rows) {
    (out[r.parentId!] ??= []).push({
      id: r.id,
      filename: r.filename,
      isImage: r.contentType.startsWith("image/"),
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

/* ------------------------------------------------------- complaint priority */

/**
 * RAISING OR LOWERING A COMPLAINT'S PRIORITY after it was raised.
 *
 * The priority is set on the form, and until now that was the only moment it
 * could be set: a complaint that turned out to be a stopped production line
 * stayed at whatever the person who took the call guessed. That is the one
 * judgement about a complaint most likely to be made LATER, by somebody with
 * more of the story than the telecaller had.
 *
 * THE DEADLINE MOVES WITH IT, and it is measured from when the complaint was
 * RAISED rather than from now. `complaints.slaHours` is a promise about how
 * long the customer waits, not about how long we have left once we notice —
 * so a three-day-old complaint reclassified Critical reads as breached
 * immediately, which is the true thing to say about it. Measuring from now
 * would hand back a fresh eight hours to the complaint that has already had
 * seventy-two, and the SLA figures would flatter exactly the cases that went
 * worst.
 *
 * A LINE IN THE HISTORY, with the status unchanged. `complaint_status_history`
 * is the only per-complaint timeline there is and its `to_status` is NOT NULL,
 * so a priority change is recorded as a row carrying the status it already
 * had. The drawer renders `at` and `note` and nothing else, so it reads as
 * what it is — and a resolver opening the complaint sees why the deadline
 * under their nose moved, which they could not learn from an audit row.
 *
 * NOBODY IS NOTIFIED, and that is not an oversight. `complaints.assigned_to`
 * holds a desk's name — "Operations", "Quality" — and not a user id, so there
 * is nobody to send it to. When a complaint gains a real assignee this is the
 * first thing that should tell them.
 */
export async function setComplaintPriority(
  complaintId: string,
  priority: string,
): Promise<Result> {
  const ctx = await resolveScope();

  // Checked against the offered list rather than trusted: a server action is a
  // URL, and this value decides a deadline.
  const picked = COMPLAINT_PRIORITIES.find((p) => p.value === priority);
  if (!picked) return err("That is not a priority.", "validation");

  const [existing] = await db
    .select()
    .from(complaints)
    .where(eq(complaints.id, complaintId));
  if (!existing) return err("That complaint no longer exists.", "not_found");
  if (existing.severity === picked.value) {
    return okVoid(`Already ${picked.label}`);
  }

  const config = await getConfig();
  const hours = config["complaints.slaHours"][picked.value];
  const slaDueAt = new Date(existing.createdAt.getTime() + hours * 3_600_000);
  const was = priorityLabel(existing.severity);

  await db.transaction(async (tx) => {
    await tx
      .update(complaints)
      .set({
        severity: picked.value,
        slaDueAt,
        updatedAt: new Date(),
        updatedById: ctx.user.id,
      })
      .where(eq(complaints.id, complaintId));

    await tx.insert(complaintStatusHistory).values({
      id: id("csh"),
      complaintId,
      fromStatus: existing.status,
      toStatus: existing.status,
      changedById: ctx.user.id,
      note: `Priority changed from ${was} to ${picked.label} by ${ctx.user.name} - resolution due ${slaDueAt.toISOString()}`,
    });

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "complaint.priority",
      entityType: "complaint",
      entityId: complaintId,
      beforeState: {
        severity: existing.severity,
        slaDueAt: existing.slaDueAt.toISOString(),
      } as never,
      afterState: {
        severity: picked.value,
        slaDueAt: slaDueAt.toISOString(),
      } as never,
    });
  });

  return okVoid(`Priority set to ${picked.label}`);
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
      /*
       * Whose account it is, by the rule every scoped list already filters on
       * — the sheet's salesperson first, then the linked account, and the
       * owner only where a lead answers to one.
       *
       * Reading `owner_id` alone named one person on every row: the import
       * writes it once for the whole book, so the column showed the importer
       * a thousand times over while the list it sat beside named the real
       * manager.
       */
      ownerName: sql<string | null>`coalesce(
        nullif(customers.sales_person_name, ''),
        (select name from users u where u.id = ${ASSIGNED_TO_SQL})
      )`,
    })
    .from(inactiveWatchItems)
    .innerJoin(customers, eq(customers.id, inactiveWatchItems.customerId))
    .where(scopedToUsers(ids));

  return rows
    .map(({ item, customer, ownerName }) => {
      /* Business date: `watchAge` differences it against `day`. Flagged
       * overnight, it used to come out a day adrift. */
      const flaggedDate = businessDate(item.flaggedAt, {
        timezone: config["workingDay.timezone"],
        dayBoundaryHour: config["workingDay.dayBoundaryHour"],
        workingDays: config["workingDay.workingDays"],
      });
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
    await recomputeInactivity(customerId);
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

/**
 * Who may see a customer's target, on THIS screen.
 *
 * `scopedToUsers` already reads two of the three seats — `ASSIGNED_TO_SQL`
 * (sales, falling back to a lead's owner) and `BACK_OFFICE_SQL` — but never
 * `sales_manager_id`, because that seat is documented everywhere else as
 * driving no queue, no scope and no target. It still has to drive visibility
 * HERE: a sales manager reviewing the month has no other way to find the
 * accounts they are named on.
 *
 * A MANAGER or ADMIN keeps exactly what `scopedToUsers` already gives them —
 * their reports-to team, or the whole company — untouched. That mechanism
 * already serves them a wider book than any one seat would, and widening it
 * further here would let a manager who also happens to be somebody's named
 * sales manager see a different set on this screen than on every other one.
 *
 * Everybody else — a telecaller or an accounts user, whichever of the three
 * seats they hold on a given account — sees exactly the accounts they hold a
 * seat on, and nothing wider. This REPLACES `scopedToUsers` for them rather
 * than adding to it: accounts today get `scope.kind === "all"`, the whole
 * book, because the approval queue they actually work is nobody's book — but
 * a target is not an approval queue, and "every account in the company" is
 * not an answer to "which targets are mine to review."
 */
function targetVisibilityClause(ctx: RequestScope) {
  if (ctx.role === "manager" || ctx.role === "admin") {
    return scopedToUsers(scopedUserIds(ctx.scope));
  }
  return or(
    inArray(ASSIGNED_TO_SQL, [ctx.user.id]),
    inArray(BACK_OFFICE_SQL, [ctx.user.id]),
    eq(customers.salesManagerId, ctx.user.id),
  );
}

/**
 * WHICH ACCOUNTS THE MONTH IS MEASURED OVER, as one clause — and the join
 * that hangs the month's target row off each of them.
 *
 * Factored out of `listTargets` so the aggregate and the single-row reads
 * below answer from exactly the same population. It is deliberately NOT
 * `targetFilterClause`, which carries `scopedToUsers`: this screen's
 * visibility is `targetVisibilityClause`, wider by the sales manager seat, and
 * a total computed over the narrower one would quietly disagree with the list
 * sitting under it.
 */
async function targetListClause(period: string | undefined, filters: TargetListFilters) {
  const ctx = await resolveScope();
  const visibility = targetVisibilityClause(ctx);
  const customerClause = customerFiltersOnly({
    query: filters.query,
    status: filters.status,
    salesAm: filters.salesAm,
    salesManager: filters.salesManager,
    backOfficeAm: filters.backOfficeAm,
  });
  const day = await today();
  const key = period ?? monthKey(day);
  const [year, month] = key.split("-").map(Number);

  return {
    key,
    year,
    month,
    joinTarget: and(
      eq(monthlyTargets.customerId, customers.id),
      eq(monthlyTargets.year, year),
      eq(monthlyTargets.month, month),
    ),
    where: and(
      // A customer who has gone quiet still carries a target — that is the
      // gap the month has to explain. Only deactivation removes them.
      ne(customers.status, "deactivated"),
      /*
       * A TARGET IS SET ON AN ACCOUNT WE INVOICE, AND ON NOTHING ELSE.
       * `DIRECT_CUSTOMER_SQL` — the same definition the Customers list's own
       * type filter reads, so the two screens cannot disagree about what a
       * direct customer is.
       *
       * A lead has never bought from us: a monthly figure against one is a
       * target nobody could have met, and it dragged the whole list's
       * achievement down with it. A third-party shop never buys from us
       * directly either — its goods are billed to its distributor, so the
       * rupees already count towards THAT account's month and counting them
       * again here would be the same money twice.
       *
       * Neither is being hidden from the month for good: both become direct
       * customers by buying. A lead's `kind` flips on its first order, and a
       * third-party shop that starts buying from us has its mark lifted by a
       * person — and either then arrives on this list carrying the default
       * like any other customer. That is why nothing here has to carry a
       * target for them in the meantime.
       */
      DIRECT_CUSTOMER_SQL,
      visibility,
      // Undefined where nothing is filtered, which `and` drops — so the
      // unfiltered read is the query it always was, byte for byte.
      customerClause,
    ),
  };
}

/**
 * THE MONTH'S TWO SCALARS, WITHOUT THE BOOK BEHIND THEM.
 *
 * The CRM dashboard prints one percentage out of this screen's figures and
 * read the WHOLE list to reduce it to two sums — every direct customer in
 * scope, each row carrying four correlated name subqueries and an entire
 * `customers` row, to say "63% of target". Same population, same join, one row
 * back.
 *
 * `coalesce(target_amount, 0)` is the sum, and that is NOT the approximation
 * `listTargetsPage`'s own aggregate documents: on the list's missing-row path
 * `resolveTarget` is handed `trailingAchievement: []`, so its base is 0 and
 * every later multiplication is a multiplication of 0. The default a customer
 * with no row resolves to IS zero, so summing the stored figures and summing
 * the resolved ones are the same number by construction — which is what lets
 * the dashboard's figure stay the figure it was.
 */
export async function targetTotals(
  period?: string,
  filters: TargetListFilters = {},
): Promise<{ customers: number; target: number; achieved: number }> {
  const { where, joinTarget, year, month } = await targetListClause(period, filters);

  const [row] = await db
    .select({
      customers: sql<number>`count(*)::int`,
      target: sql<number>`coalesce(sum(coalesce(${monthlyTargets.targetAmount}, 0)), 0)::bigint`,
      achieved: sql<number>`coalesce(sum(${targetAchievedSql(year, month)}), 0)::bigint`,
    })
    .from(customers)
    .leftJoin(monthlyTargets, joinTarget)
    .where(where);

  return {
    customers: Number(row?.customers ?? 0),
    target: Number(row?.target ?? 0),
    achieved: Number(row?.achieved ?? 0),
  };
}

/**
 * ONE CUSTOMER'S TARGET, and the share of the book it is.
 *
 * The customer record is the most-opened page in the CRM, and it read the
 * entire targets list to pull one row out of it with `.find` and sum the rest
 * — so opening one account scanned every direct customer in scope.
 *
 * NULL WHERE THE ACCOUNT IS NOT ON THIS SCREEN AT ALL, which is what the card
 * is built on: a lead has never bought from us and a third-party shop is
 * billed by its distributor, so an account absent from the population has no
 * target rather than a target of nothing. That is why this runs the same
 * clause — reading `monthly_targets` directly would answer "no row, therefore
 * zero" and put "of ₹0" on a delivery shop with a month of real orders behind
 * it.
 */
export async function targetFor(
  customerId: string,
  period?: string,
): Promise<{ amount: number; isDefault: boolean; shareOfBookPercent: number | null } | null> {
  const { where, joinTarget } = await targetListClause(period, {});

  const [row] = await db
    .select({
      // The same pair every list row resolves to: the stored figure, or the
      // default, which on this path is always 0. See `targetTotals`.
      amount: sql<number>`coalesce(${monthlyTargets.targetAmount}, 0)::bigint`,
      isDefault: sql<boolean>`coalesce(${monthlyTargets.isDefault}, true)`,
    })
    .from(customers)
    .leftJoin(monthlyTargets, joinTarget)
    .where(and(where, eq(customers.id, customerId)))
    .limit(1);

  if (!row) return null;

  // Asked for only once the account is known to be on the screen. The share is
  // of the book THIS reader can see, which is exactly what the list's own
  // reduce over every visible row was.
  const { target: bookTarget } = await targetTotals(period);
  const amount = Number(row.amount ?? 0);
  return {
    amount,
    isDefault: Boolean(row.isDefault),
    shareOfBookPercent: bookTarget ? Math.round((amount / bookTarget) * 100) : null,
  };
}

export async function listTargets(
  period?: string,
  /*
   * The Targets tab's own four filters, plus its search box, applied to this
   * read as well.
   *
   * It used to take none, and the note above `targetFilterClause` said why:
   * the shortfall "reads the whole scoped book to classify a coverage gap
   * from a customer gap, and that classification has to stand independent of
   * whatever the Targets tab's filters happen to be set to."
   *
   * That is right about the CLASSIFICATION and wrong about the POPULATION.
   * Which side a customer falls on is decided from their own contacts against
   * their own cycle, so narrowing the list cannot move anybody between the two
   * groups — and a manager looking at one salesperson's book cannot read a
   * shortfall drawn over the whole team's. The two figures sat on one screen,
   * one filtered and one not, with nothing saying they were answering
   * different questions.
   *
   * `customerFiltersOnly` is the SAME reading of those five the Customers list
   * and `targetFilterClause` both run, for the reason this file already states
   * about bulk writes: the honest way to act on "everyone these filters match"
   * is to run the clause the screen ran, not a second reading of the same four
   * filters that can drift from it.
   *
   * It is the FILTERS and not `customerFilterClause`, which carries scope as
   * well. The scope here is `targetVisibilityClause`, which is wider than
   * `scopedToUsers` by the sales manager seat — so ANDing the two narrows to
   * the intersection and takes that seat away again, on the one screen it
   * exists for. Filters narrow a population; they do not get to answer who may
   * see it.
   */
  filters: TargetListFilters = {},
) {
  const config = await getConfig();
  // The population, the join and the month, built once in `targetListClause`
  // so the aggregate and the single-row reads above measure the same book.
  const { where, joinTarget, year, month, key } = await targetListClause(period, filters);

  const rows = await db
    .select({
      customer: customers,
      /*
       * Whose TARGET this month's figure counts toward — see
       * `CREDITED_TO_NAME_SQL`. Deliberately not `ASSIGNED_TO_SQL`: that
       * answers whose BOOK a customer sits in, which falls back to
       * `owner_id` and can name whoever ran the import.
       */
      ownerName: CREDITED_TO_NAME_SQL,
      creditedSeat: CREDITED_TO_SEAT_SQL,
      salesSeatName: SALES_SEAT_NAME_SQL,
      backOfficeSeatName: BACK_OFFICE_SEAT_NAME_SQL,
      target: monthlyTargets.targetAmount,
      isDefault: monthlyTargets.isDefault,
      carriedForward: monthlyTargets.carriedForward,
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
    .leftJoin(monthlyTargets, joinTarget)
    .where(where)
    .orderBy(asc(customers.name));

  return rows.map((r) => {
    // Every active customer ends up with a figure — no blanks on the screen.
    const resolved =
      r.target !== null
        ? { amount: r.target, isDefault: r.isDefault ?? true, carriedForward: r.carriedForward ?? false }
        : {
            ...resolveTarget(
              {
                manualAmount: null,
                trailingAchievement: [],
                customerSince: r.customer.customerSince,
                month: `${key}-01`,
              },
              config,
            ),
            carriedForward: false,
          };
    const achieved = Number(r.achieved ?? 0);
    return {
      customerId: r.customer.id,
      customerName: r.customer.name,
      ownerName: r.ownerName,
      creditedSeat: r.creditedSeat as CreditSeat,
      salesSeatName: r.salesSeatName,
      backOfficeSeatName: r.backOfficeSeatName,
      cycleDays: r.customer.cycleDays,
      contactsThisMonth: Number(r.contactsThisMonth ?? 0),
      target: resolved.amount,
      achieved,
      gap: Math.max(0, resolved.amount - achieved),
      percent: resolved.amount ? Math.round((achieved / resolved.amount) * 100) : 0,
      isDefault: resolved.isDefault,
      carriedForward: resolved.carriedForward,
    };
  });
}

function targetAchievedSql(year: number, month: number) {
  return sql<number>`coalesce((
    select sum(o.total_amount) from ${orders} o
     where o.customer_id = customers.id
       and o.status in ('captured','confirmed','dispatched')
       and extract(year from o.ordered_at) = ${year}
       and extract(month from o.ordered_at) = ${month}
  ), 0)`;
}

/**
 * The customer-list filters, and only those — the Targets tab's filter bar
 * is deliberately the same four controls the Customers list offers
 * (status, sales people, sales managers, back office), read the same way,
 * so a name picked here always means what it means there. `thirdParty` is
 * left out: an account's kind is not a question this screen asks.
 */
export type TargetListFilters = Pick<
  CustomerListFilters,
  "query" | "status" | "salesAm" | "salesManager" | "backOfficeAm" | "sort"
> & {
  page?: number;
  perPage?: number;
};

export type TargetListRow = Awaited<ReturnType<typeof listTargets>>[number];

export type TargetListPage = {
  rows: TargetListRow[];
  /** Matching the filters. */
  total: number;
  /** In the whole scoped book, before any filter. */
  bookTotal: number;
  page: number;
  pageCount: number;
  /** Over the FILTERED set, not the page — the tiles describe the search. */
  totals: {
    target: number;
    achieved: number;
    gap: number;
    defaults: number;
    behind: number;
    maxGap: number;
  };
};

/**
 * One page of the monthly targets list, filtered and counted in the
 * database — the same reason `listCustomersPage` exists rather than the
 * customers screen holding the whole book. A manager's team is usually a
 * few hundred customers; sending all of them to show twenty-five is the
 * same waste the customers list stopped doing.
 *
 * `listTargets` above takes the same filters but no page: the shortfall is a
 * worklist rather than a table, so it is narrowed by the same four answers
 * and then read whole. What must NOT move with a filter is the
 * classification, and it cannot — coverage gap versus customer gap is decided
 * per customer from their own contacts and their own cycle, never from
 * anything about the set they arrived in.
 *
 * TARGET AND ACHIEVED, FOR FILTERING, ARE THE STORED FIGURES — `target`
 * falls back to 0 rather than running `resolveTarget`'s trailing-average
 * default in SQL. In steady state this is exactly the same number: the
 * nightly seed gives every active customer a row before anybody opens this
 * screen. The gap is a customer created since the seed last ran, which
 * reads as "on target" here until the next one — the safe direction, and
 * the same gap `listTargets` already had before pagination existed.
 */
/**
 * What a set of target-screen filters MEANS, as one clause — scope, period
 * and all. Exported because "set targets in bulk" is a write against
 * whatever the screen is showing, the same reasoning `customerFilterClause`
 * documents for account reassignment: the honest way to act on "everyone
 * these filters match" is to run the SAME clause the list ran, not a second
 * reading of the same four filters that can drift from it.
 */
export async function targetFilterClause(
  period: string | undefined,
  filters: TargetListFilters = {},
) {
  const ctx = await resolveScope();
  const scoped = scopedToUsers(scopedUserIds(ctx.scope));
  const day = await today();
  const key = period ?? monthKey(day);
  const [year, month] = key.split("-").map(Number);

  const achievedExpr = targetAchievedSql(year, month);
  const targetExpr = sql<number>`coalesce(${monthlyTargets.targetAmount}, 0)`;
  const isDefaultExpr = sql<boolean>`coalesce(${monthlyTargets.isDefault}, true)`;
  const gapExpr = sql<number>`greatest(0, ${targetExpr} - ${achievedExpr})`;

  // The SAME clause the Customers list runs for the same four filters —
  // `customerFilterClause` already carries scope, so this is the whole
  // WHERE except the one rule that is this screen's own.
  const customerClause = await customerFilterClause({
    query: filters.query,
    status: filters.status,
    salesAm: filters.salesAm,
    salesManager: filters.salesManager,
    backOfficeAm: filters.backOfficeAm,
  });

  // The two rules that are this screen's own, spelled exactly as `listTargets`
  // spells them — the page and the list disagreeing about which accounts the
  // month is measured over is the one thing pagination must not introduce.
  //
  // A customer who has gone quiet still carries a target: that is the gap the
  // month has to explain, so only deactivation removes them. "Deactivated" is
  // deliberately absent from the Status filter's own options for exactly that
  // reason — offering it would be a filter that always returns nothing.
  //
  // `DIRECT_CUSTOMER_SQL` is the other: leads and third-party shops carry no
  // target here. See `listTargets` for why.
  const onThisScreen = and(ne(customers.status, "deactivated"), DIRECT_CUSTOMER_SQL);
  const clause = customerClause ? and(onThisScreen, customerClause) : onThisScreen;

  return {
    clause,
    joinTarget: and(
      eq(monthlyTargets.customerId, customers.id),
      eq(monthlyTargets.year, year),
      eq(monthlyTargets.month, month),
    ),
    scoped,
    isDefaultExpr,
    targetExpr,
    achievedExpr,
    gapExpr,
    year,
    month,
    key,
  };
}

/**
 * Every customer id the current filters match, unpaginated — what "set
 * targets in bulk" acts on. `onlyDefault` narrows further to rows still on
 * the auto-applied default, which is itself just another turn of the same
 * clause rather than a client-side filter over one page of rows.
 */
export async function resolveTargetCustomerIds(
  period: string | undefined,
  filters: TargetListFilters,
  onlyDefault: boolean,
): Promise<string[]> {
  const { clause, joinTarget, isDefaultExpr } = await targetFilterClause(period, filters);
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .leftJoin(monthlyTargets, joinTarget)
    .where(onlyDefault ? and(clause, isDefaultExpr) : clause);
  return rows.map((r) => r.id);
}

/**
 * What the Monthly Targets list may be sorted by. Built per call rather than
 * a module-level constant — `targetExpr`/`achievedExpr`/`gapExpr` already
 * read "0 where nothing was set" off `targetFilterClause`, the same
 * expressions the tiles above the table are summed from, so a sorted column
 * can never disagree with the totals sitting over it.
 */
function targetSortColumns(targetExpr: SQL<number>, achievedExpr: SQL<number>, gapExpr: SQL<number>) {
  return {
    name: customers.name,
    target: targetExpr,
    achieved: achievedExpr,
    gap: gapExpr,
    achievement: sql<number>`case when ${targetExpr} = 0 then 0
      else round(${achievedExpr}::numeric * 100 / ${targetExpr}) end`,
  };
}

export async function listTargetsPage(
  period: string | undefined,
  filters: TargetListFilters = {},
): Promise<TargetListPage> {
  const config = await getConfig();
  const perPage = Math.min(Math.max(filters.perPage ?? 25, 1), 200);
  const {
    clause,
    joinTarget,
    scoped,
    isDefaultExpr,
    targetExpr,
    achievedExpr,
    gapExpr,
    year,
    month,
    key,
  } = await targetFilterClause(period, filters);

  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      target: sql<number>`coalesce(sum(${targetExpr}), 0)::bigint`,
      achieved: sql<number>`coalesce(sum(${achievedExpr}), 0)::bigint`,
      defaults: sql<number>`count(*) filter (where ${isDefaultExpr})::int`,
      behind: sql<number>`count(*) filter (where ${gapExpr} > 0)::int`,
      maxGap: sql<number>`coalesce(max(${gapExpr}), 0)::bigint`,
    })
    .from(customers)
    .leftJoin(monthlyTargets, joinTarget)
    .where(clause);

  const [book] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(customers)
    // The same two rules the list itself applies, minus the filters — "of
    // your book" has to count the book THIS SCREEN shows, or the unfiltered
    // page reads as 480 of 1,100 with nothing saying where the rest went.
    .where(and(ne(customers.status, "deactivated"), DIRECT_CUSTOMER_SQL, scoped));

  const total = Number(agg?.total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(filters.page ?? 1, 1), pageCount);

  const rows = await db
    .select({
      customer: customers,
      ownerName: CREDITED_TO_NAME_SQL,
      creditedSeat: CREDITED_TO_SEAT_SQL,
      salesSeatName: SALES_SEAT_NAME_SQL,
      backOfficeSeatName: BACK_OFFICE_SEAT_NAME_SQL,
      target: monthlyTargets.targetAmount,
      isDefault: monthlyTargets.isDefault,
      carriedForward: monthlyTargets.carriedForward,
      achieved: achievedExpr,
      contactsThisMonth: sql<number>`(
        select count(*)::int from calls c
         where c.customer_id = customers.id
           and extract(year from c.started_at) = ${year}
           and extract(month from c.started_at) = ${month}
      )`,
    })
    .from(customers)
    .leftJoin(monthlyTargets, joinTarget)
    .where(clause)
    .orderBy(
      resolveSort(targetSortColumns(targetExpr, achievedExpr, gapExpr), filters.sort, "name"),
    )
    .limit(perPage)
    .offset((page - 1) * perPage);

  const shaped = rows.map((r) => {
    const resolved =
      r.target !== null
        ? {
            amount: r.target,
            isDefault: r.isDefault ?? true,
            carriedForward: r.carriedForward ?? false,
          }
        : {
            ...resolveTarget(
              {
                manualAmount: null,
                trailingAchievement: [],
                customerSince: r.customer.customerSince,
                month: `${key}-01`,
              },
              config,
            ),
            carriedForward: false,
          };
    const achieved = Number(r.achieved ?? 0);
    return {
      customerId: r.customer.id,
      customerName: r.customer.name,
      ownerName: r.ownerName,
      creditedSeat: r.creditedSeat as CreditSeat,
      salesSeatName: r.salesSeatName,
      backOfficeSeatName: r.backOfficeSeatName,
      cycleDays: r.customer.cycleDays,
      contactsThisMonth: Number(r.contactsThisMonth ?? 0),
      target: resolved.amount,
      achieved,
      gap: Math.max(0, resolved.amount - achieved),
      percent: resolved.amount ? Math.round((achieved / resolved.amount) * 100) : 0,
      isDefault: resolved.isDefault,
      carriedForward: resolved.carriedForward,
    };
  });

  return {
    rows: shaped,
    total,
    bookTotal: Number(book?.n ?? 0),
    page,
    pageCount,
    totals: {
      target: Number(agg?.target ?? 0),
      achieved: Number(agg?.achieved ?? 0),
      gap: Math.max(0, Number(agg?.target ?? 0) - Number(agg?.achieved ?? 0)),
      defaults: Number(agg?.defaults ?? 0),
      behind: Number(agg?.behind ?? 0),
      maxGap: Number(agg?.maxGap ?? 0),
    },
  };
}

/**
 * The names the "Account manager" filter can offer — read from the same
 * expression the column renders, not from `users`, because most of these
 * people (the sheet's own salespeople) have no MahekOne account.
 */
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

  /*
   * A TARGET IS SET ON AN ACCOUNT WE INVOICE, and the rule is checked here
   * rather than only by what the list draws — a server action is a URL, and
   * this one is reachable with any customer id.
   *
   * Refused rather than silently dropped, and the message says what the way
   * forward is: both of these become direct customers by BUYING, and neither
   * is moved by anything on this screen. A lead's `kind` flips on its first
   * order (`promotesToCustomerAt`), and a third-party shop that starts buying
   * from us has its mark lifted by a person — at which point it arrives on
   * this list carrying the default like any other customer.
   */
  const [account] = await db
    .select({ kind: customers.kind, thirdParty: customers.thirdParty })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!account) return err("That customer no longer exists.", "not_found");
  if (account.thirdParty) {
    return err(
      "This shop is billed by a distributor, so its orders count towards that account's month rather than its own. No target here.",
      "rule_violation",
    );
  }
  if (account.kind === "lead") {
    return err(
      "A lead has never ordered, so there is nothing to measure a month against. It becomes a customer on its first order and picks up a target then.",
      "rule_violation",
    );
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
      carriedForward: false,
      setById: ctx.user.id,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    })
    .onConflictDoUpdate({
      target: [monthlyTargets.customerId, monthlyTargets.year, monthlyTargets.month],
      set: {
        targetAmount: amount,
        isDefault: false,
        // A real save is a decision, even one that reproduces a carried
        // figure verbatim — so a carried target stops being one the moment a
        // manager has actually looked at it and confirmed it.
        carriedForward: false,
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

/**
 * The view a manager opens before a coaching conversation.
 *
 * It is a worklist rather than a table, so it is narrowed by the same filters
 * and then read WHOLE — see `listTargetsPage`. What it does not need is the
 * four seat names every list row carries, each of them a correlated subquery
 * against `users` on every customer in scope, because `classifyShortfall` asks
 * only about a customer's own contacts against their own cycle. So this reads
 * the six columns it classifies on and nothing else, off the SAME clause the
 * list runs — the population has to be identical or a manager would be
 * coaching against a different book to the one on the screen above it.
 */
export async function shortfallAnalysis(
  period?: string,
  filters: TargetListFilters = {},
) {
  await requireCapability("target.shortfall");
  const day = await today();
  const { where, joinTarget, year, month } = await targetListClause(period, filters);

  const rows = await db
    .select({
      customerId: customers.id,
      name: customers.name,
      cycleDays: customers.cycleDays,
      // The stored figure, or the default — which on the missing-row path is
      // always 0. See `targetTotals` for why that is an identity rather than
      // an approximation.
      target: sql<number>`coalesce(${monthlyTargets.targetAmount}, 0)::bigint`,
      achieved: targetAchievedSql(year, month),
      contactsThisMonth: sql<number>`(
        select count(*)::int from calls c
         where c.customer_id = customers.id
           and extract(year from c.started_at) = ${year}
           and extract(month from c.started_at) = ${month}
      )`,
    })
    .from(customers)
    .leftJoin(monthlyTargets, joinTarget)
    .where(where)
    .orderBy(asc(customers.name));

  return classifyShortfall(
    rows.map((r) => ({
      customerId: r.customerId,
      name: r.name,
      target: Number(r.target ?? 0),
      achieved: Number(r.achieved ?? 0),
      contactsThisMonth: Number(r.contactsThisMonth ?? 0),
      cycleDays: r.cycleDays,
    })),
    day,
  );
}

export { addMonths, desc };
