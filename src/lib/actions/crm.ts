"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  bills,
  complaintEvents,
  complaints,
  customers,
  eodReports,
  interactions,
  notifications,
  orders,
  payments,
  promises,
  queueItems,
  reminders,
  settings,
  targets,
  users,
  waMessages,
  waReplies,
  waRuns,
  waTemplates,
  type WaRunRecipient,
} from "@/db/schema";
import { isManager, requireUser } from "@/lib/auth";
import { getScope, SCOPE_COOKIE_NAME, DENSITY_COOKIE_NAME } from "@/lib/scope";
import {
  currentPeriod,
  dayActivity,
  listPaymentFollowUps,
  openRemindersDue,
  today,
} from "@/lib/queries";
import { addDays, money, parseRupees, shortDate } from "@/lib/format";
import {
  audit,
  fail,
  newId,
  notify,
  ok,
  recomputeOutstanding,
  type ActionResult,
} from "./core";

/** Screens that read shared numbers — refresh them together after any write. */
const SHARED = [
  "/crm/dashboard",
  "/crm/queue",
  "/crm/reminders",
  "/crm/history",
  "/crm/payments",
  "/crm/bills",
  "/crm/inactive",
  "/crm/customers",
  "/crm/complaints",
  "/crm/targets",
  "/crm/eod",
  "/crm/whatsapp",
];

function refreshAll() {
  for (const path of SHARED) revalidatePath(path);
  revalidatePath("/crm/customers/[id]", "page");
}

/* ------------------------------------------------------------ preferences */

export async function setScope(scope: "mine" | "team") {
  const user = await requireUser();
  if (!isManager(user)) return;
  const jar = await cookies();
  jar.set(SCOPE_COOKIE_NAME, scope, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  refreshAll();
}

export async function setDensity(density: "comfortable" | "compact") {
  const jar = await cookies();
  jar.set(DENSITY_COOKIE_NAME, density, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

/* -------------------------------------------------------------- the call */

const callSchema = z.object({
  customerId: z.string().min(1),
  queueItemId: z.string().optional().nullable(),
  connection: z.enum([
    "Connected",
    "Missed",
    "Not reachable",
    "Busy",
    "Wrong number",
  ]),
  outcome: z.string().min(1, "Pick the outcome — it decides what happens next."),
  note: z.string().optional(),

  orderProduct: z.string().optional(),
  orderQty: z.string().optional(),
  orderValue: z.string().optional(),
  orderDispatch: z.string().optional(),

  reminderDue: z.string().optional(),
  reminderNote: z.string().optional(),

  complaintCategory: z.string().optional(),
  complaintDesc: z.string().optional(),
});

/**
 * Saving a call is one transaction: the interaction, anything it produced, the
 * queue row, and the customer's rolled-up figures. Half-saved calls are how
 * telecaller data goes wrong, so there is no partial path through here.
 */
export async function saveCall(
  raw: z.infer<typeof callSchema>,
): Promise<ActionResult<{ produced: string[] }>> {
  const user = await requireUser();
  const parsed = callSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  const input = parsed.data;

  const customer = await db.query.customers.findFirst({
    where: (c, { eq }) => eq(c.id, input.customerId),
  });
  if (!customer) return fail("That customer no longer exists.");

  const produced: string[] = [];
  const now = new Date();

  // Validate the expansions before writing anything.
  let orderValuePaise: number | null = null;
  if (input.orderValue?.trim()) {
    orderValuePaise = parseRupees(input.orderValue);
    if (orderValuePaise == null || orderValuePaise <= 0) {
      return fail("Enter the order value in rupees.");
    }
  }
  if (input.reminderDue && !input.reminderNote?.trim()) {
    return fail("Write what was promised — this is what you will read back later.");
  }
  if (input.complaintCategory && !input.complaintDesc?.trim()) {
    return fail("Describe the complaint in the customer's words.");
  }

  await db.transaction(async (tx) => {
    if (orderValuePaise != null) {
      const orderId = newId("ord");
      await tx.insert(orders).values({
        id: orderId,
        customerId: customer.id,
        userId: user.id,
        product: input.orderProduct || "Unspecified",
        quantity: Number(input.orderQty) || 1,
        value: orderValuePaise,
        expectedDispatch: input.orderDispatch || null,
        placedAt: now,
      });
      produced.push(`Order ${money(orderValuePaise)}`);

      await tx
        .update(customers)
        .set({
          lastOrderDate: today(),
          lastOrderValue: orderValuePaise,
          status: customer.status === "Inactive" ? "Active" : customer.status,
        })
        .where(eq(customers.id, customer.id));
    }

    if (input.reminderDue && input.reminderNote?.trim()) {
      await tx.insert(reminders).values({
        id: newId("rem"),
        customerId: customer.id,
        userId: user.id,
        dueDate: input.reminderDue,
        note: input.reminderNote.trim(),
        source: "call",
      });
      produced.push(`Reminder ${shortDate(input.reminderDue)}`);
    }

    if (input.complaintCategory && input.complaintDesc?.trim()) {
      const complaintId = newId("cmp");
      await tx.insert(complaints).values({
        id: complaintId,
        customerId: customer.id,
        category: input.complaintCategory,
        description: input.complaintDesc.trim(),
        loggedById: user.id,
        loggedOn: today(),
      });
      await tx.insert(complaintEvents).values({
        id: newId("cev"),
        complaintId,
        note: `Logged by ${user.name} during a call`,
      });
      produced.push("Complaint logged");
    }

    await tx.insert(interactions).values({
      id: newId("int"),
      customerId: customer.id,
      userId: user.id,
      channel: "Call",
      connection: input.connection,
      outcome: input.outcome,
      note: input.note?.trim() || null,
      produced: produced.join(" · ") || null,
      occurredAt: now,
    });

    await tx
      .update(customers)
      .set({ lastContactAt: now })
      .where(eq(customers.id, customer.id));

    if (input.queueItemId) {
      await tx
        .update(queueItems)
        .set({ worked: true })
        .where(eq(queueItems.id, input.queueItemId));
    }
  });

  await audit(user, "call", "customer", customer.id, input.outcome);
  refreshAll();
  return ok("Call saved", { produced });
}

/* ----------------------------------------------------------------- queue */

export async function skipQueueItem(
  id: string,
  reason: string,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!reason.trim()) return fail("A reason is required — it is kept on the record.");

  const item = await db.query.queueItems.findFirst({
    where: (q, { eq }) => eq(q.id, id),
  });
  if (!item) return fail("That row is no longer in the queue.");

  await db
    .update(queueItems)
    .set({ skipped: true, heldBackReason: reason.trim() })
    .where(eq(queueItems.id, id));

  await audit(user, "skip", "queue_item", id, reason);
  refreshAll();
  return ok("Skipped for today");
}

export async function restoreWorkedRows(): Promise<ActionResult> {
  const user = await requireUser();
  await db
    .update(queueItems)
    .set({ worked: false })
    .where(and(eq(queueItems.day, today()), eq(queueItems.ownerId, user.id)));
  refreshAll();
  return ok("Worked rows restored");
}

/**
 * Rebuilds today's list from the actual state of the book. Reasons are ordered
 * so the most expensive thing to get wrong sits at the top of the queue.
 */
export async function rebuildQueue(): Promise<ActionResult> {
  const user = await requireUser();
  const day = today();

  const book = await db
    .select()
    .from(customers)
    .where(and(eq(customers.ownerId, user.id), eq(customers.active, true)));

  const [openRems, openCmps, heldBack] = await Promise.all([
    db
      .select({ customerId: reminders.customerId, dueDate: reminders.dueDate })
      .from(reminders)
      .where(and(eq(reminders.userId, user.id), eq(reminders.status, "open"))),
    db
      .select({ customerId: complaints.customerId })
      .from(complaints)
      .where(inArray(complaints.status, ["Open", "In progress"])),
    db
      .select({ customerId: waMessages.customerId })
      .from(waMessages)
      .where(
        and(
          eq(waMessages.sentById, user.id),
          inArray(waMessages.status, ["Sent", "Delivered", "Read"]),
          sql`${waMessages.createdAt} > now() - interval '2 days'`,
        ),
      ),
  ]);

  const dueByCustomer = new Map(
    openRems.filter((r) => r.dueDate <= day).map((r) => [r.customerId, r.dueDate]),
  );
  const complaintSet = new Set(openCmps.map((c) => c.customerId));
  const heldSet = new Set(heldBack.map((m) => m.customerId));

  const rows = book
    .map((c) => {
      let reason: string | null = null;
      let priority = 100;

      if (complaintSet.has(c.id)) {
        reason = "Open complaint";
        priority = 10;
      } else if (dueByCustomer.has(c.id)) {
        reason = "Reminder due";
        priority = 20;
      } else if (c.outstanding > 0 && c.slowPayer) {
        reason = "Payment overdue";
        priority = 30;
      } else if (c.outstanding > 0) {
        reason = "Payment follow-up";
        priority = 40;
      } else if (
        c.lastOrderDate &&
        c.cycleDays &&
        new Date(c.lastOrderDate).getTime() <
          Date.now() - c.cycleDays * 2 * 86_400_000
      ) {
        reason = "Gone quiet";
        priority = 50;
      } else if (
        c.lastOrderDate &&
        c.cycleDays &&
        new Date(c.lastOrderDate).getTime() <
          Date.now() - c.cycleDays * 86_400_000
      ) {
        reason = "Due to reorder";
        priority = 60;
      }

      if (!reason) return null;

      return {
        id: newId("qi"),
        day,
        customerId: c.id,
        ownerId: user.id,
        reason,
        priority,
        heldBackReason: heldSet.has(c.id)
          ? "WhatsApp message sent in the last two days"
          : null,
        skipped: heldSet.has(c.id),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  await db
    .delete(queueItems)
    .where(
      and(
        eq(queueItems.day, day),
        eq(queueItems.ownerId, user.id),
        eq(queueItems.worked, false),
      ),
    );

  const existing = await db
    .select({ customerId: queueItems.customerId })
    .from(queueItems)
    .where(and(eq(queueItems.day, day), eq(queueItems.ownerId, user.id)));
  const have = new Set(existing.map((e) => e.customerId));

  const fresh = rows.filter((r) => !have.has(r.customerId));
  if (fresh.length) await db.insert(queueItems).values(fresh);

  await audit(user, "rebuild", "queue", day, `${fresh.length} rows`);
  refreshAll();
  return ok(`Queue rebuilt — ${fresh.length} customers to work`);
}

/* ------------------------------------------------------------- reminders */

export async function createReminder(input: {
  customerId: string;
  dueDate: string;
  note: string;
  source?: string;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!input.note.trim()) {
    return fail("Write what was promised — this is what you will read back later.");
  }
  if (!input.dueDate) return fail("Pick a due date.");

  await db.insert(reminders).values({
    id: newId("rem"),
    customerId: input.customerId,
    userId: user.id,
    dueDate: input.dueDate,
    note: input.note.trim(),
    source: input.source ?? "manual",
  });

  await audit(user, "create", "reminder", input.customerId, input.note);
  refreshAll();
  return ok(`Reminder set for ${shortDate(input.dueDate)}`);
}

export async function createRemindersBulk(
  customerIds: string[],
  dueDate: string,
  note: string,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!customerIds.length) return fail("Select at least one customer.");
  if (!note.trim()) return fail("Write what the reminder is for.");

  await db.insert(reminders).values(
    customerIds.map((customerId) => ({
      id: newId("rem"),
      customerId,
      userId: user.id,
      dueDate,
      note: note.trim(),
      source: "bulk",
    })),
  );

  await audit(user, "create-bulk", "reminder", null, `${customerIds.length} reminders`);
  refreshAll();
  return ok(`${customerIds.length} reminders set for ${shortDate(dueDate)}`);
}

export async function completeReminder(id: string): Promise<ActionResult> {
  const user = await requireUser();
  await db
    .update(reminders)
    .set({ status: "done", completedAt: new Date() })
    .where(eq(reminders.id, id));
  await audit(user, "complete", "reminder", id);
  refreshAll();
  return ok("Reminder marked done");
}

export async function rescheduleReminder(
  id: string,
  dueDate: string,
  note?: string,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!dueDate) return fail("Pick the new due date.");
  await db
    .update(reminders)
    .set({ dueDate, ...(note?.trim() ? { note: note.trim() } : {}) })
    .where(eq(reminders.id, id));
  await audit(user, "reschedule", "reminder", id, dueDate);
  refreshAll();
  return ok(`Moved to ${shortDate(dueDate)}`);
}

export async function cancelReminder(id: string): Promise<ActionResult> {
  const user = await requireUser();
  await db
    .update(reminders)
    .set({ status: "cancelled" })
    .where(eq(reminders.id, id));
  await audit(user, "cancel", "reminder", id);
  refreshAll();
  return ok("Reminder cancelled");
}

/* --------------------------------------------------------------- payments */

export async function recordPromise(input: {
  customerId: string;
  amount: string;
  promisedBy: string;
  note?: string;
}): Promise<ActionResult> {
  const user = await requireUser();
  const amount = parseRupees(input.amount);
  if (amount == null || amount <= 0) {
    return fail("Enter the amount they committed to.");
  }
  if (!input.promisedBy) return fail("Pick the date they promised.");

  await db.transaction(async (tx) => {
    await tx.insert(promises).values({
      id: newId("prm"),
      customerId: input.customerId,
      userId: user.id,
      amount,
      promisedBy: input.promisedBy,
      note: input.note?.trim() || null,
    });

    // A promise nobody chases is just a note. Chase it the day after.
    await tx.insert(reminders).values({
      id: newId("rem"),
      customerId: input.customerId,
      userId: user.id,
      dueDate: addDays(input.promisedBy, 1),
      note: `Check ${money(amount)} promised for ${shortDate(input.promisedBy)}`,
      source: "promise",
    });
  });

  await audit(user, "promise", "customer", input.customerId, money(amount));
  refreshAll();
  return ok(`Promise recorded — chase set for ${shortDate(addDays(input.promisedBy, 1))}`);
}

export async function recordPayment(input: {
  billId: string;
  amount: string;
  mode: string;
  reference?: string;
  receivedOn: string;
}): Promise<ActionResult> {
  const user = await requireUser();
  const amount = parseRupees(input.amount);
  if (amount == null || amount <= 0) return fail("Enter the amount received.");

  const bill = await db.query.bills.findFirst({
    where: (b, { eq }) => eq(b.id, input.billId),
  });
  if (!bill) return fail("That bill no longer exists.");

  const balance = bill.amount - bill.paid;
  if (amount > balance) {
    return fail(`Enter an amount up to the outstanding balance (${money(balance)}).`);
  }

  await db.transaction(async (tx) => {
    await tx.insert(payments).values({
      id: newId("pay"),
      billId: bill.id,
      customerId: bill.customerId,
      amount,
      mode: input.mode || "Bank transfer",
      reference: input.reference?.trim() || null,
      receivedOn: input.receivedOn || today(),
      recordedById: user.id,
    });
    await tx
      .update(bills)
      .set({ paid: bill.paid + amount })
      .where(eq(bills.id, bill.id));
  });

  await recomputeOutstanding(bill.customerId);

  // A payment against an open promise settles it.
  const open = await db.query.promises.findFirst({
    where: (p, { and, eq, isNull }) =>
      and(eq(p.customerId, bill.customerId), isNull(p.kept)),
    orderBy: (p, { desc }) => desc(p.createdAt),
  });
  if (open && amount >= open.amount) {
    await db.update(promises).set({ kept: true }).where(eq(promises.id, open.id));
  }

  await audit(user, "payment", "bill", bill.id, money(amount));
  refreshAll();
  return ok(`${money(amount)} recorded against ${bill.billNo}`);
}

/* -------------------------------------------------------------- customers */

const customerSchema = z.object({
  name: z.string().trim().min(2, "Enter the business name as it appears on the bill."),
  contactPerson: z.string().trim().min(2, "Enter the contact person."),
  phone: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit telephone number."),
  city: z.string().trim().min(2, "Enter the city."),
  ownerId: z.string().optional(),
  gstin: z.string().trim().optional(),
  creditTermDays: z.coerce.number().int().min(0).max(180).default(30),
  cycleDays: z.coerce.number().int().min(1).max(365).default(30),
  route: z.string().trim().optional(),
});

export async function createCustomer(
  raw: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = customerSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0].message);

  const id = newId("cus");
  await db.insert(customers).values({
    id,
    name: parsed.data.name,
    contactPerson: parsed.data.contactPerson,
    phone: parsed.data.phone,
    city: parsed.data.city,
    ownerId: parsed.data.ownerId || user.id,
    gstin: parsed.data.gstin || null,
    creditTermDays: parsed.data.creditTermDays,
    cycleDays: parsed.data.cycleDays,
    route: parsed.data.route || null,
    status: "New",
    customerSince: today(),
  });

  await audit(user, "create", "customer", id, parsed.data.name);
  refreshAll();
  return ok(`${parsed.data.name} added`, { id });
}

export async function updateCustomer(
  id: string,
  raw: Record<string, unknown>,
): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = customerSchema.partial().safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0].message);

  await db
    .update(customers)
    .set({
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.contactPerson
        ? { contactPerson: parsed.data.contactPerson }
        : {}),
      ...(parsed.data.phone ? { phone: parsed.data.phone } : {}),
      ...(parsed.data.city ? { city: parsed.data.city } : {}),
      ...(parsed.data.ownerId ? { ownerId: parsed.data.ownerId } : {}),
      ...(parsed.data.gstin !== undefined ? { gstin: parsed.data.gstin || null } : {}),
      ...(parsed.data.creditTermDays !== undefined
        ? { creditTermDays: parsed.data.creditTermDays }
        : {}),
      ...(parsed.data.cycleDays !== undefined
        ? { cycleDays: parsed.data.cycleDays }
        : {}),
      ...(parsed.data.route !== undefined ? { route: parsed.data.route || null } : {}),
    })
    .where(eq(customers.id, id));

  await audit(user, "update", "customer", id);
  refreshAll();
  return ok("Customer updated");
}

export async function requestDeactivation(
  customerIds: string[],
  reason: string,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!reason.trim()) {
    return fail("A reason is required — it is kept on the customer record.");
  }
  if (!customerIds.length) return fail("Select at least one customer.");

  await db
    .update(customers)
    .set({ deactivationRequested: true, deactivationReason: reason.trim() })
    .where(inArray(customers.id, customerIds));

  const managers = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.role, ["manager", "admin"]));

  for (const m of managers) {
    await notify(
      m.id,
      "Deactivation requested",
      `${user.name} asked to deactivate ${customerIds.length} customer${
        customerIds.length === 1 ? "" : "s"
      }: ${reason.trim()}`,
      "warn",
      "/crm/inactive",
    );
  }

  await audit(user, "request-deactivation", "customer", null, reason);
  refreshAll();
  return ok("Deactivation requested — a manager decides");
}

export async function decideDeactivation(
  customerId: string,
  approve: boolean,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!isManager(user)) return fail("That is a manager action.");

  await db
    .update(customers)
    .set(
      approve
        ? { active: false, status: "Inactive", deactivationRequested: false }
        : { deactivationRequested: false, deactivationReason: null },
    )
    .where(eq(customers.id, customerId));

  await audit(user, approve ? "deactivate" : "reject-deactivation", "customer", customerId);
  refreshAll();
  return ok(approve ? "Customer deactivated" : "Request rejected");
}

/* ------------------------------------------------------------- complaints */

export async function logComplaint(input: {
  customerId: string;
  category: string;
  description: string;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!input.description.trim()) {
    return fail("Describe the complaint in the customer's words.");
  }

  const id = newId("cmp");
  await db.transaction(async (tx) => {
    await tx.insert(complaints).values({
      id,
      customerId: input.customerId,
      category: input.category || "Other",
      description: input.description.trim(),
      loggedById: user.id,
      loggedOn: today(),
    });
    await tx.insert(complaintEvents).values({
      id: newId("cev"),
      complaintId: id,
      note: `Logged by ${user.name}`,
    });
  });

  await audit(user, "create", "complaint", id, input.category);
  refreshAll();
  return ok("Complaint logged");
}

export async function resolveComplaint(input: {
  id: string;
  resolutionNote: string;
  customerTold: boolean;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!isManager(user)) return fail("Closing a complaint is a manager action.");
  if (!input.resolutionNote.trim()) {
    return fail("Write what was done before closing — the customer record shows it.");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(complaints)
      .set({
        status: "Resolved",
        resolutionNote: input.resolutionNote.trim(),
        customerTold: input.customerTold,
        resolvedAt: new Date(),
      })
      .where(eq(complaints.id, input.id));
    await tx.insert(complaintEvents).values({
      id: newId("cev"),
      complaintId: input.id,
      note: `Resolved by ${user.name}: ${input.resolutionNote.trim()}`,
    });
  });

  await audit(user, "resolve", "complaint", input.id);
  refreshAll();
  return ok("Complaint resolved");
}

export async function reassignComplaint(
  id: string,
  assignedTo: string,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!assignedTo.trim()) return fail("Pick who this goes to.");

  await db.transaction(async (tx) => {
    await tx
      .update(complaints)
      .set({ assignedTo: assignedTo.trim(), status: "In progress" })
      .where(eq(complaints.id, id));
    await tx.insert(complaintEvents).values({
      id: newId("cev"),
      complaintId: id,
      note: `Reassigned to ${assignedTo.trim()} by ${user.name}`,
    });
  });

  await audit(user, "reassign", "complaint", id, assignedTo);
  refreshAll();
  return ok(`Reassigned to ${assignedTo}`);
}

/* ---------------------------------------------------------------- targets */

export async function setTarget(
  customerId: string,
  amount: string,
  period = currentPeriod(),
): Promise<ActionResult> {
  const user = await requireUser();
  if (!isManager(user)) return fail("Setting targets is a manager action.");

  const paise = parseRupees(amount);
  if (paise == null || paise <= 0) return fail("Enter the monthly target in rupees.");

  await db
    .insert(targets)
    .values({
      id: newId("tgt"),
      customerId,
      period,
      amount: paise,
      isDefault: false,
      setById: user.id,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [targets.customerId, targets.period],
      set: {
        amount: paise,
        isDefault: false,
        setById: user.id,
        updatedAt: new Date(),
      },
    });

  await audit(user, "set-target", "customer", customerId, money(paise));
  refreshAll();
  return ok(`Target set to ${money(paise)}`);
}

export async function setTargetsBulk(input: {
  customerIds: string[];
  mode: "amount" | "uplift";
  value: string;
  period?: string;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!isManager(user)) return fail("Setting targets is a manager action.");
  if (!input.customerIds.length) return fail("Select at least one customer.");

  const period = input.period ?? currentPeriod();

  if (input.mode === "amount") {
    const paise = parseRupees(input.value);
    if (paise == null || paise <= 0) return fail("Enter the target in rupees.");

    for (const customerId of input.customerIds) {
      await db
        .insert(targets)
        .values({
          id: newId("tgt"),
          customerId,
          period,
          amount: paise,
          isDefault: false,
          setById: user.id,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [targets.customerId, targets.period],
          set: { amount: paise, isDefault: false, setById: user.id, updatedAt: new Date() },
        });
    }
  } else {
    const upliftPct = Number(input.value.replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(upliftPct)) return fail("Enter the uplift as a percentage.");

    const rows = await db
      .select()
      .from(customers)
      .where(inArray(customers.id, input.customerIds));

    for (const c of rows) {
      const base = Math.round((c.avgOrderValue * 30) / (c.cycleDays || 30));
      const amount = Math.round(base * (1 + upliftPct / 100));
      await db
        .insert(targets)
        .values({
          id: newId("tgt"),
          customerId: c.id,
          period,
          amount,
          isDefault: false,
          setById: user.id,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [targets.customerId, targets.period],
          set: { amount, isDefault: false, setById: user.id, updatedAt: new Date() },
        });
    }
  }

  await audit(user, "set-targets-bulk", "target", null, `${input.customerIds.length}`);
  refreshAll();
  return ok(`Targets set for ${input.customerIds.length} customers`);
}

/* --------------------------------------------------------------- whatsapp */

export async function setWaMode(
  mode: "manual" | "connected" | "failing",
): Promise<ActionResult> {
  const user = await requireUser();
  if (!isManager(user)) return fail("Changing the connection is a manager action.");

  await db
    .insert(settings)
    .values({ key: "whatsapp_mode", value: { mode } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { mode } } });

  await audit(user, "set-wa-mode", "settings", "whatsapp_mode", mode);
  refreshAll();
  return ok(`WhatsApp set to ${mode}`);
}

export async function setCustomerGroup(
  customerId: string,
  groupName: string,
): Promise<ActionResult> {
  const user = await requireUser();
  await db
    .update(customers)
    .set({
      whatsappGroupName: groupName.trim() || null,
      whatsappDest: groupName.trim() ? "group" : "personal",
    })
    .where(eq(customers.id, customerId));
  await audit(user, "set-group", "customer", customerId, groupName);
  refreshAll();
  return ok("Group name saved");
}

/**
 * A message is only "sent" when a human confirms it. Until then it sits as
 * Copied — a customer who may or may not have been contacted, and the log says
 * so rather than pretending.
 */
export async function queueMessage(input: {
  customerId: string;
  templateId?: string | null;
  templateName?: string | null;
  body: string;
  edited: boolean;
  destKind: "personal" | "group";
  destination: string;
  runId?: string | null;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!input.body.trim()) return fail("The message is empty.");

  const mode = await db.query.settings.findFirst({
    where: (s, { eq }) => eq(s.key, "whatsapp_mode"),
  });
  const waMode =
    (mode?.value as { mode?: string } | undefined)?.mode === "connected"
      ? "connected"
      : "manual";

  const id = newId("wam");
  await db.insert(waMessages).values({
    id,
    customerId: input.customerId,
    templateId: input.templateId || null,
    templateName: input.templateName || null,
    body: input.body,
    edited: input.edited,
    destination: input.destination,
    destKind: input.destKind,
    mode: waMode,
    // Connected sending is instant; manual sending waits for a confirmation.
    status: waMode === "connected" ? "Sent" : "Copied",
    sentById: user.id,
    runId: input.runId || null,
  });

  if (input.templateId) {
    await db
      .update(waTemplates)
      .set({ uses: sql`${waTemplates.uses} + 1` })
      .where(eq(waTemplates.id, input.templateId));
  }

  if (waMode === "connected") {
    await recordMessageInteraction(user.id, input.customerId, input.templateName);
  }

  refreshAll();
  return ok(
    waMode === "connected" ? "Message sent" : "Copied — confirm once you have sent it",
    { id },
  );
}

export async function confirmMessageSent(id: string): Promise<ActionResult> {
  const user = await requireUser();
  const message = await db.query.waMessages.findFirst({
    where: (m, { eq }) => eq(m.id, id),
  });
  if (!message) return fail("That message is no longer in the log.");

  await db.update(waMessages).set({ status: "Sent" }).where(eq(waMessages.id, id));
  await recordMessageInteraction(user.id, message.customerId, message.templateName);

  // Nobody should ring a customer minutes after messaging them.
  await db
    .update(queueItems)
    .set({
      skipped: true,
      heldBackReason: "WhatsApp message sent today",
    })
    .where(
      and(
        eq(queueItems.day, today()),
        eq(queueItems.customerId, message.customerId),
        eq(queueItems.worked, false),
      ),
    );

  await audit(user, "confirm-sent", "wa_message", id);
  refreshAll();
  return ok("Marked as sent");
}

export async function cancelMessage(id: string): Promise<ActionResult> {
  const user = await requireUser();
  await db
    .update(waMessages)
    .set({ status: "Cancelled" })
    .where(eq(waMessages.id, id));
  await audit(user, "cancel", "wa_message", id);
  refreshAll();
  return ok("Discarded");
}

async function recordMessageInteraction(
  userId: string,
  customerId: string,
  templateName?: string | null,
) {
  await db.insert(interactions).values({
    id: newId("int"),
    customerId,
    userId,
    channel: "WhatsApp",
    connection: null,
    outcome: templateName ?? "Message sent",
    note: templateName ? `Sent "${templateName}"` : "WhatsApp message sent",
    produced: null,
  });
  await db
    .update(customers)
    .set({ lastContactAt: new Date() })
    .where(eq(customers.id, customerId));
}

export async function actionReply(id: string): Promise<ActionResult> {
  const user = await requireUser();
  await db.update(waReplies).set({ actioned: true }).where(eq(waReplies.id, id));
  await audit(user, "action", "wa_reply", id);
  refreshAll();
  return ok("Reply actioned");
}

export async function saveTemplate(input: {
  id?: string;
  name: string;
  category: string;
  body: string;
  appliesTo: "personal" | "group";
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!isManager(user)) return fail("Editing templates is a manager action.");
  if (!input.name.trim()) return fail("Give the template a name.");
  if (!input.body.trim()) return fail("Write the message body.");

  if (input.id) {
    await db
      .update(waTemplates)
      .set({
        name: input.name.trim(),
        category: input.category,
        body: input.body,
        appliesTo: input.appliesTo,
        updatedAt: new Date(),
      })
      .where(eq(waTemplates.id, input.id));
  } else {
    await db.insert(waTemplates).values({
      id: newId("tpl"),
      name: input.name.trim(),
      category: input.category,
      body: input.body,
      appliesTo: input.appliesTo,
    });
  }

  await audit(user, input.id ? "update" : "create", "wa_template", input.id);
  refreshAll();
  return ok("Template saved");
}

export async function archiveTemplate(
  id: string,
  archived: boolean,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!isManager(user)) return fail("Editing templates is a manager action.");
  await db.update(waTemplates).set({ archived }).where(eq(waTemplates.id, id));
  refreshAll();
  return ok(archived ? "Template archived" : "Template restored");
}

/* ------------------------------------------------------------ send runs */

export async function startRun(input: {
  templateId: string;
  filterKey: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const scope = await getScope(user);
  const candidates = await listPaymentFollowUps(user, scope);

  const filtered = candidates.filter((c) => {
    if (input.filterKey === "stage1") return c.stage === "Reminder due";
    if (input.filterKey === "slow") return c.customer.slowPayer;
    if (input.filterKey === "over60") return c.oldestDays > 60;
    return true;
  });

  if (!filtered.length) return fail("Nobody matches that filter today.");

  const id = newId("run");
  await db.insert(waRuns).values({
    id,
    userId: user.id,
    templateId: input.templateId,
    filterKey: input.filterKey,
    recipients: filtered.map<WaRunRecipient>((c) => ({
      customerId: c.customer.id,
      state: "pending",
    })),
  });

  await audit(user, "start-run", "wa_run", id, `${filtered.length} recipients`);
  refreshAll();
  return ok(`Run started — ${filtered.length} customers`, { id });
}

export async function advanceRun(
  runId: string,
  outcome: "sent" | "skipped",
): Promise<ActionResult> {
  const user = await requireUser();
  const run = await db.query.waRuns.findFirst({
    where: (r, { eq }) => eq(r.id, runId),
  });
  if (!run) return fail("That run has finished.");

  const recipients = [...run.recipients];
  if (run.cursor >= recipients.length) return fail("That run has finished.");

  recipients[run.cursor] = { ...recipients[run.cursor], state: outcome };
  const cursor = run.cursor + 1;
  const done = cursor >= recipients.length;

  await db
    .update(waRuns)
    .set({ recipients, cursor, finishedAt: done ? new Date() : null })
    .where(eq(waRuns.id, runId));

  await audit(user, outcome, "wa_run", runId);
  refreshAll();
  return ok(done ? "Run finished" : outcome === "sent" ? "Sent — next customer" : "Skipped");
}

export async function pauseRun(runId: string, paused: boolean) {
  await requireUser();
  await db.update(waRuns).set({ paused }).where(eq(waRuns.id, runId));
  refreshAll();
  return ok(paused ? "Run paused" : "Run resumed");
}

export async function clearRun(runId: string) {
  await requireUser();
  await db.update(waRuns).set({ finishedAt: new Date() }).where(eq(waRuns.id, runId));
  refreshAll();
  return ok("Run cleared");
}

/* -------------------------------------------------------------------- EOD */

export async function submitEod(body: string): Promise<ActionResult> {
  const user = await requireUser();
  const day = today();

  const stillOpen = await openRemindersDue(user.id, day);
  if (stillOpen.length) {
    return fail(
      `${stillOpen.length} reminder${stillOpen.length === 1 ? "" : "s"} due today ` +
        "still open. Close or carry them forward first.",
    );
  }

  await db
    .insert(eodReports)
    .values({ id: newId("eod"), userId: user.id, day, body })
    .onConflictDoUpdate({
      target: [eodReports.userId, eodReports.day],
      set: { body, submittedAt: new Date() },
    });

  const managers = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.role, ["manager", "admin"]));
  const activity = await dayActivity(user.id, day);

  for (const m of managers) {
    if (m.id === user.id) continue;
    await notify(
      m.id,
      "EOD submitted",
      `${user.name}: ${activity.connected} connected, ${activity.orders} orders, ${money(
        activity.orderValue,
      )} booked.`,
      "info",
      "/crm/eod",
    );
  }

  await audit(user, "submit", "eod", day);
  refreshAll();
  return ok("EOD report submitted");
}

export async function carryReminderForward(id: string): Promise<ActionResult> {
  const user = await requireUser();
  const reminder = await db.query.reminders.findFirst({
    where: (r, { eq }) => eq(r.id, id),
  });
  if (!reminder) return fail("That reminder no longer exists.");

  await db
    .update(reminders)
    .set({ dueDate: addDays(today(), 1) })
    .where(eq(reminders.id, id));

  await audit(user, "carry-forward", "reminder", id);
  refreshAll();
  return ok("Carried forward to tomorrow");
}

/* -------------------------------------------------------- notifications */

export async function markNotificationsRead(): Promise<ActionResult> {
  const user = await requireUser();
  await db
    .update(notifications)
    .set({ read: true })
    .where(eq(notifications.userId, user.id));
  revalidatePath("/", "layout");
  return ok();
}

export async function markNotificationRead(id: string): Promise<ActionResult> {
  await requireUser();
  await db.update(notifications).set({ read: true }).where(eq(notifications.id, id));
  revalidatePath("/", "layout");
  return ok();
}
