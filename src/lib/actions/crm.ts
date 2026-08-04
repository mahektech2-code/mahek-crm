"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { isManager } from "../auth";
import { db } from "@/db";
import {
  auditLog,
  complaintImages,
  complaints,
  complaintStatusHistory,
  customers,
  eodReports,
  notifications,
  users,
} from "@/db/schema";
import {
  requireCapability,
  resolveScope,
  assertCustomerInScope,
} from "@/lib/access-control";
import { SCOPE_COOKIE_NAME, DENSITY_COOKIE_NAME } from "@/lib/scope";
import { getConfig, invalidateConfig, updateSetting } from "@/lib/config/store";
import { saveInteraction } from "@/lib/services/interaction-service";
import { fileStorage } from "@/lib/storage";
import {
  recordFollowUpAttempt,
  recordPayment as recordPaymentService,
} from "@/lib/services/payment-service";
import {
  carryForward,
  changeComplaintStatus,
  completeReminder as completeReminderService,
  createReminder as createReminderService,
  dismissReminder,
  recordWatchOutcome,
  rescheduleReminder as rescheduleReminderService,
  resolveComplaint as resolveComplaintService,
  setTarget as setTargetService,
  setTargetsBulk as setTargetsBulkService,
} from "@/lib/services/worklist-services";
import {
  actionReply as actionReplyService,
  advanceRun as advanceRunService,
  cancelMessage as cancelMessageService,
  confirmSent,
  createRun,
  markCopied,
  prepareMessage,
  saveTemplate as saveTemplateService,
  sendAutomatic,
  setRunStatus,
} from "@/lib/services/whatsapp-service";
import {
  recomputeInactivity,
  recomputeLastContact,
  today,
} from "@/lib/recompute";
import { err, fromThrown, ok, okVoid, type Result } from "@/lib/result";
import { initialsOf } from "@/lib/format";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** Screens that read shared numbers — refresh them together after any write. */
const SHARED = [
  "/crm/dashboard",
  "/crm/call-log",
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

/**
 * Cache invalidation only means something inside a request. Jobs, scripts and
 * the integration tests call these same actions with no request around them,
 * and there is nothing to revalidate there — so a missing store is expected,
 * not an error worth failing a write over.
 */
function refreshAll() {
  try {
    for (const path of SHARED) revalidatePath(path);
    revalidatePath("/crm/customers/[id]", "page");
  } catch {
    /* no request context — nothing is cached, so nothing to invalidate */
  }
}

/* ------------------------------------------------------------ preferences */

export async function setScope(scope: "mine" | "team") {
  const ctx = await resolveScope();
  if (ctx.role === "telecaller") return;
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

/** Jyoti's dialog offers business labels; the column is an enum. */
const CATEGORY_MAP: Record<string, string> = {
  Packaging: "packaging_damage",
  "Packaging Damage": "packaging_damage",
  Staff: "service",
  Product: "product_quality",
  "Product Quality": "product_quality",
  "Product Complaint": "product_quality",
  Transport: "delivery",
  Transportation: "delivery",
  Delivery: "delivery",
  "Dispatch Delay": "dispatch_delay",
  "Rate / Discount": "pricing",
  Pricing: "pricing",
  "Immediate Payment": "billing_issue",
  "Billing Issue": "billing_issue",
  Billing: "billing_issue",
  "Sales Promotion": "other",
  Service: "service",
  Shortage: "shortage",
  Other: "other",
};

function parseRupees(input?: string): number | null {
  if (!input?.trim()) return null;
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
}

export type SaveInteractionActionInput = {
  customerId: string;
  interactionType: "outbound_call" | "inbound_call" | "order_received";
  outcome?: string | null;
  notes?: string;
  quickNoteIds?: string[];
  productQuantities?: Record<string, number>;
  followUpDate?: string;
  paymentPromiseDate?: string;
  complaintCategory?: string;
  orderDate?: string;
  /** The payment term agreed on this order, in days from the bill date. */
  creditDays?: number;
  sourceModule?:
    | "call_queue"
    | "payment_follow_up"
    | "inactive_watch"
    | "customer_record"
    | "ad_hoc";
  queuePosition?: number;
  idempotencyKey?: string;
};

/**
 * Logging an interaction. Thin over the service, which owns validation and
 * every side effect — this exists only to be callable from the interface.
 */
export async function saveInteractionAction(
  raw: SaveInteractionActionInput,
): Promise<Result<{ produced: string[]; complaintUpdated: boolean }>> {
  try {
    const result = await saveInteraction({
      customerId: raw.customerId,
      interactionType: raw.interactionType,
      outcome: (raw.outcome ?? null) as never,
      notes: raw.notes,
      quickNoteIds: raw.quickNoteIds ?? [],
      productQuantities: raw.productQuantities ?? {},
      followUpDate: raw.followUpDate,
      paymentPromiseDate: raw.paymentPromiseDate,
      complaintCategory: raw.complaintCategory as never,
      orderDate: raw.orderDate,
      creditDays: raw.creditDays,
      sourceModule: raw.sourceModule ?? "ad_hoc",
      queuePosition: raw.queuePosition,
      idempotencyKey: raw.idempotencyKey ?? randomUUID(),
    });
    if (!result.ok) return result;
    refreshAll();
    return ok(
      {
        produced: result.data.produced,
        complaintUpdated: result.data.complaintUpdated,
      },
      result.message ?? "Interaction saved",
      result.warnings,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/* ----------------------------------------------------------------- queue */

/** The queue is computed on request; there is nothing to rebuild. */
export async function rebuildQueue(): Promise<Result> {
  refreshAll();
  return okVoid("Queue refreshed");
}

export async function restoreWorkedRows(): Promise<Result> {
  return err(
    "Worked rows cannot be restored — the queue is derived from the calls you logged. Undo the call instead.",
    "rule_violation",
  );
}

/** Skipping is a do-not-contact-today note recorded against the customer. */
export async function skipQueueItem(
  customerId: string,
  reason: string,
): Promise<Result> {
  try {
    if (!reason.trim()) return err("A reason is required.", "validation");
    const ctx = await resolveScope();
    await db.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "queue.skip",
      entityType: "customer",
      entityId: customerId,
      afterState: { reason: reason.trim(), day: await today() } as never,
    });
    refreshAll();
    return okVoid("Skipped for today");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------- reminders */

export async function createReminder(input: {
  customerId: string;
  dueDate: string;
  note: string;
}): Promise<Result> {
  try {
    const r = await createReminderService(input);
    refreshAll();
    return r.ok ? okVoid(r.message) : r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function createRemindersBulk(
  customerIds: string[],
  dueDate: string,
  note: string,
): Promise<Result> {
  try {
    if (!customerIds.length)
      return err("Select at least one customer.", "validation");
    for (const customerId of customerIds) {
      const r = await createReminderService({ customerId, dueDate, note });
      // One bad customer must not leave a half-finished bulk behind silently.
      if (!r.ok) return r;
    }
    refreshAll();
    return okVoid(`${customerIds.length} reminders set`);
  } catch (e) {
    return fromThrown(e);
  }
}

export async function completeReminder(reminderId: string): Promise<Result> {
  try {
    const r = await completeReminderService(reminderId);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function cancelReminder(
  reminderId: string,
  reason: string,
): Promise<Result> {
  try {
    const r = await dismissReminder(reminderId, reason);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function rescheduleReminder(
  reminderId: string,
  dueDate: string,
  note?: string,
): Promise<Result> {
  try {
    const r = await rescheduleReminderService(reminderId, dueDate, note);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function carryReminderForward(
  reminderId: string,
): Promise<Result> {
  try {
    const r = await carryForward(reminderId);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

/* -------------------------------------------------------------- payments */

export async function recordPromise(input: {
  customerId: string;
  amount: string;
  promisedBy: string;
  note?: string;
}): Promise<Result> {
  try {
    const amount = parseRupees(input.amount);
    if (amount === null) {
      return err("Enter the amount they committed to.", "validation", [
        { field: "amount", message: "Enter a positive amount." },
      ]);
    }
    const r = await recordFollowUpAttempt({
      customerId: input.customerId,
      channel: "call",
      outcome: input.note || "Promise recorded",
      promisedAmount: amount,
      promisedDate: input.promisedBy,
      idempotencyKey: randomUUID(),
    });
    refreshAll();
    return r.ok ? okVoid(r.message) : r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function recordPayment(input: {
  billId: string;
  amount: string;
  mode: string;
  reference?: string;
  receivedOn: string;
}): Promise<Result> {
  try {
    const amount = parseRupees(input.amount);
    if (amount === null) {
      return err("Enter the amount received.", "validation", [
        { field: "amount", message: "Enter a positive amount." },
      ]);
    }
    const r = await recordPaymentService({
      billId: input.billId,
      amount,
      paidAt: input.receivedOn,
      mode: input.mode,
      reference: input.reference,
      idempotencyKey: randomUUID(),
    });
    refreshAll();
    return r.ok ? okVoid(r.message) : r;
  } catch (e) {
    return fromThrown(e);
  }
}

/** Stage-1 enforcement lives in the service; this surfaces its refusal. */
export async function recordFollowUp(input: {
  customerId: string;
  channel: "whatsapp" | "call";
  outcome?: string;
}): Promise<Result> {
  try {
    const r = await recordFollowUpAttempt({
      ...input,
      idempotencyKey: randomUUID(),
    });
    refreshAll();
    return r.ok ? okVoid(r.message) : r;
  } catch (e) {
    return fromThrown(e);
  }
}

/* -------------------------------------------------------------- customers */

const customerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Enter the business name as it appears on the bill."),
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
  leadSource: z.string().trim().max(120).optional(),
  backOfficeAmId: z.string().optional(),
});

export async function createCustomer(
  raw: Record<string, unknown>,
): Promise<Result<{ id: string; duplicateOf?: string }>> {
  try {
    const ctx = await resolveScope();
    const parsed = customerSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(issue.message, "validation", [
        { field: issue.path.join("."), message: issue.message },
      ]);
    }

    // Duplicate detection: the phone number is the natural key in this trade.
    const [duplicate] = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(eq(customers.phone, parsed.data.phone))
      .limit(1);
    if (duplicate) {
      return err(
        `${duplicate.name} already uses that telephone number.`,
        "duplicate",
        [{ field: "phone", message: "Already on the book." }],
      );
    }

    const customerId = id("cus");
    await db.insert(customers).values({
      id: customerId,
      name: parsed.data.name,
      contactPerson: parsed.data.contactPerson,
      phone: parsed.data.phone,
      city: parsed.data.city,
      // Adding from this screen creates a LEAD. Nobody is a customer until
      // they order — that is what the conversion in saveInteraction is for.
      kind: "lead",
      leadSource: parsed.data.leadSource || null,
      ownerId: parsed.data.ownerId || ctx.user.id,
      // No sales account manager yet: that is assigned when the lead converts,
      // and naming one now would claim an account that does not exist.
      salesAmId: null,
      gstin: parsed.data.gstin || null,
      creditTermDays: parsed.data.creditTermDays,
      cycleDays: parsed.data.cycleDays,
      cycleIsDefault: true,
      route: parsed.data.route || null,
      customerSince: null,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });

    refreshAll();
    return ok({ id: customerId }, `${parsed.data.name} added`);
  } catch (e) {
    return fromThrown(e);
  }
}

export async function updateCustomer(
  customerId: string,
  raw: Record<string, unknown>,
): Promise<Result> {
  try {
    const ctx = await resolveScope();
    const parsed = customerSchema.partial().safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(issue.message, "validation", [
        { field: issue.path.join("."), message: issue.message },
      ]);
    }

    const [existing] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId));
    if (!existing) return err("That customer no longer exists.", "not_found");
    await assertCustomerInScope(existing);

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
        ...(parsed.data.gstin !== undefined
          ? { gstin: parsed.data.gstin || null }
          : {}),
        ...(parsed.data.creditTermDays !== undefined
          ? { creditTermDays: parsed.data.creditTermDays }
          : {}),
        ...(parsed.data.cycleDays !== undefined
          ? { cycleDays: parsed.data.cycleDays }
          : {}),
        ...(parsed.data.leadSource !== undefined
          ? { leadSource: parsed.data.leadSource || null }
          : {}),
        // Who handles dispatch and billing is a manager's call, checked here
        // and not merely disabled in the form.
        ...(parsed.data.backOfficeAmId !== undefined && isManager(ctx.user)
          ? { backOfficeAmId: parsed.data.backOfficeAmId || null }
          : {}),
        ...(parsed.data.route !== undefined
          ? { route: parsed.data.route || null }
          : {}),
        updatedAt: new Date(),
        updatedById: ctx.user.id,
      })
      .where(eq(customers.id, customerId));

    await db.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "customer.update",
      entityType: "customer",
      entityId: customerId,
      beforeState: { name: existing.name, phone: existing.phone } as never,
      afterState: parsed.data as never,
    });

    refreshAll();
    return okVoid("Customer updated");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function requestDeactivation(
  customerIds: string[],
  reason: string,
): Promise<Result> {
  try {
    if (!reason.trim()) return err("A reason is required.", "validation");
    if (!customerIds.length)
      return err("Select at least one customer.", "validation");
    const ctx = await resolveScope();

    await db
      .update(customers)
      .set({ deactivationRequested: true, deactivationReason: reason.trim() })
      .where(inArray(customers.id, customerIds));

    const managers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.role, ["manager", "admin"]));
    for (const m of managers) {
      await db.insert(notifications).values({
        id: id("ntf"),
        userId: m.id,
        title: "Deactivation requested",
        body: `${ctx.user.name} asked to deactivate ${customerIds.length} customer${customerIds.length === 1 ? "" : "s"}: ${reason.trim()}`,
        kind: "warn",
        href: "/crm/inactive",
      });
    }

    refreshAll();
    return okVoid("Deactivation requested — a manager decides");
  } catch (e) {
    return fromThrown(e);
  }
}

/** Deactivation is a status change, never a deletion. History stays queryable. */
export async function decideDeactivation(
  customerId: string,
  approve: boolean,
  reason?: string,
): Promise<Result> {
  try {
    const ctx = await requireCapability("customer.deactivate");
    const [existing] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId));
    if (!existing) return err("That customer no longer exists.", "not_found");

    if (approve && !(reason ?? existing.deactivationReason)) {
      return err(
        "A reason is required to deactivate a customer.",
        "validation",
      );
    }

    await db
      .update(customers)
      .set(
        approve
          ? {
              status: "deactivated",
              deactivatedAt: new Date(),
              deactivatedById: ctx.user.id,
              deactivationReason: reason ?? existing.deactivationReason,
              deactivationRequested: false,
              updatedAt: new Date(),
              updatedById: ctx.user.id,
            }
          : {
              deactivationRequested: false,
              deactivationReason: null,
              updatedAt: new Date(),
              updatedById: ctx.user.id,
            },
      )
      .where(eq(customers.id, customerId));

    await db.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: approve
        ? "customer.deactivate"
        : "customer.deactivation_rejected",
      entityType: "customer",
      entityId: customerId,
      beforeState: { status: existing.status } as never,
      afterState: {
        status: approve ? "deactivated" : existing.status,
      } as never,
    });

    await recomputeInactivity();
    refreshAll();
    return okVoid(approve ? "Customer deactivated" : "Request rejected");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------- complaints */

/**
 * Raising a complaint outside a call. It still goes through the call service,
 * so the complaint gets its severity, SLA deadline and opening status-history
 * line exactly as one raised mid-call would — there is one path, not two.
 */
export async function logComplaint(input: {
  customerId: string;
  category: string;
  description: string;
  mobileNumber?: string;
  requestCn?: boolean;
  billId?: string | null;
  goodsDescription?: string;
  images?: File[];
}): Promise<Result> {
  try {
    if (!input.description.trim()) {
      return err(
        "Describe the complaint in the customer's words.",
        "validation",
        [
          {
            field: "description",
            message: "Describe the complaint in the customer's words.",
          },
        ],
      );
    }
    // A credit note with no bill behind it is not actionable by accounts.
    if (input.requestCn && !input.billId) {
      return err("Pick the bill this credit note relates to.", "validation", [
        {
          field: "billId",
          message: "Pick the bill this credit note relates to.",
        },
      ]);
    }

    // Her dialog does not ask how the complaint reached us, so it must not
    // invent an inbound call — that would inflate the call counts. A complaint
    // raised ON a call comes through saveInteraction instead, and gets its
    // interaction record there.
    const ctx = await resolveScope();
    const config = await getConfig();
    const severity = config["complaints.defaultSeverity"];
    const slaHours = config["complaints.slaHours"][severity];
    const complaintId = id("cmp");

    await db.transaction(async (tx) => {
      await tx.insert(complaints).values({
        id: complaintId,
        customerId: input.customerId,
        loggedByUserId: ctx.user.id,
        category: (CATEGORY_MAP[input.category] ?? "other") as never,
        description: input.description.trim(),
        severity,
        slaDueAt: new Date(Date.now() + slaHours * 3_600_000),
        mobileNumber: input.mobileNumber?.trim() || null,
        requestCn: input.requestCn ?? false,
        billId: input.requestCn ? (input.billId ?? null) : null,
        goodsDescription: input.requestCn
          ? input.goodsDescription?.trim() || null
          : null,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      await tx.insert(complaintStatusHistory).values({
        id: id("csh"),
        complaintId,
        fromStatus: null,
        toStatus: "open",
        changedById: ctx.user.id,
        note: `Logged by ${ctx.user.name}`,
      });
    });

    // Storage has no backend yet (see lib/storage.ts), so attaching images is
    // best-effort — the complaint itself must always save.
    let imagesAttached = false;
    if (input.images?.length && complaintId) {
      const uploads = await Promise.allSettled(
        input.images.map((file) => fileStorage.upload(file)),
      );
      const succeeded = uploads.flatMap((u) =>
        u.status === "fulfilled" ? [u.value] : [],
      );
      if (succeeded.length) {
        await db
          .insert(complaintImages)
          .values(
            succeeded.map((u) => ({ id: id("cim"), complaintId, url: u.url })),
          );
        imagesAttached = true;
      }
    }

    refreshAll();
    return okVoid(
      input.images?.length && !imagesAttached
        ? "Complaint logged — image attachments aren't available until storage is configured"
        : "Complaint logged",
    );
  } catch (e) {
    return fromThrown(e);
  }
}

export async function resolveComplaint(input: {
  id: string;
  resolutionNote: string;
  customerTold: boolean;
}): Promise<Result> {
  try {
    const r = await resolveComplaintService({
      complaintId: input.id,
      resolutionNotes: input.resolutionNote,
      customerInformed: input.customerTold,
    });
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function reassignComplaint(
  complaintId: string,
  assignedTo: string,
): Promise<Result> {
  try {
    const ctx = await resolveScope();
    if (!assignedTo.trim()) return err("Pick who this goes to.", "validation");
    await db
      .update(customers)
      .set({ updatedAt: new Date() })
      .where(sql`false`); // no-op keeps the transaction shape consistent
    const r = await changeComplaintStatus(
      complaintId,
      "in_progress",
      `Reassigned to ${assignedTo} by ${ctx.user.name}`,
    );
    if (r.ok) {
      await db.execute(
        sql`update complaints set assigned_to = ${assignedTo}, updated_at = now() where id = ${complaintId}`,
      );
    }
    refreshAll();
    return r.ok ? okVoid(`Reassigned to ${assignedTo}`) : r;
  } catch (e) {
    return fromThrown(e);
  }
}

/* ---------------------------------------------------------- inactive watch */

export async function recordInactiveOutcome(
  customerId: string,
  outcome:
    | "contacted"
    | "reminder_set"
    | "deactivation_requested"
    | "not_actually_inactive",
  reason?: string,
): Promise<Result> {
  try {
    const r = await recordWatchOutcome(customerId, outcome, reason);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

/* ---------------------------------------------------------------- targets */

export async function setTarget(
  customerId: string,
  amount: string,
  period?: string,
): Promise<Result> {
  try {
    const paise = parseRupees(amount);
    if (paise === null)
      return err("Enter the monthly target in rupees.", "validation");
    const r = await setTargetService(customerId, paise, period);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function setTargetsBulk(input: {
  customerIds: string[];
  mode: "amount" | "uplift";
  value: string;
  period?: string;
}): Promise<Result> {
  try {
    const value =
      input.mode === "amount"
        ? parseRupees(input.value)
        : Number(input.value.replace(/[^0-9.-]/g, ""));
    if (value === null || !Number.isFinite(value)) {
      return err("Enter a number.", "validation");
    }
    const r = await setTargetsBulkService(
      input.customerIds,
      input.mode,
      value,
      input.period,
    );
    refreshAll();
    return r.ok ? okVoid(r.message) : r;
  } catch (e) {
    return fromThrown(e);
  }
}

/* --------------------------------------------------------------- whatsapp */

export async function setWaMode(mode: "manual" | "automatic"): Promise<Result> {
  try {
    const ctx = await requireCapability("config.write");
    const r = await updateSetting("whatsapp.mode", mode, ctx.user.id);
    invalidateConfig();
    refreshAll();
    return r.ok
      ? okVoid(`WhatsApp set to ${mode}`)
      : err(r.error, "validation");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function setCustomerGroup(
  customerId: string,
  groupName: string,
): Promise<Result> {
  try {
    const ctx = await resolveScope();
    await db
      .update(customers)
      .set({
        whatsappGroupName: groupName.trim() || null,
        whatsappDest: groupName.trim() ? "group" : "personal",
        updatedAt: new Date(),
        updatedById: ctx.user.id,
      })
      .where(eq(customers.id, customerId));
    refreshAll();
    return okVoid("Group name saved");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function queueMessage(input: {
  customerId: string;
  templateId?: string | null;
  body: string;
  edited: boolean;
  destKind: "personal" | "group";
  runId?: string | null;
}): Promise<Result<{ id: string }>> {
  try {
    if (!input.templateId) return err("Pick a template.", "validation");
    const prepared = await prepareMessage({
      customerId: input.customerId,
      templateId: input.templateId,
      bodyOverride: input.edited ? input.body : undefined,
      destKind: input.destKind,
      runId: input.runId ?? undefined,
      idempotencyKey: randomUUID(),
    });
    if (!prepared.ok) return prepared;

    await markCopied(prepared.data.messageId);
    refreshAll();
    return ok(
      { id: prepared.data.messageId },
      prepared.data.mode === "automatic"
        ? "Ready to send"
        : "Copied — confirm once you have sent it",
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/** The copy step of a run: records it without claiming the message was sent. */
export async function markMessageCopied(messageId: string): Promise<Result> {
  try {
    const r = await markCopied(messageId);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function confirmMessageSent(messageId: string): Promise<Result> {
  try {
    const r = await confirmSent(messageId);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function sendMessageAutomatic(messageId: string): Promise<Result> {
  try {
    const r = await sendAutomatic(messageId);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function cancelMessage(messageId: string): Promise<Result> {
  try {
    const r = await cancelMessageService(messageId);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function actionReply(replyId: string): Promise<Result> {
  try {
    const r = await actionReplyService(replyId);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function saveTemplate(input: {
  id?: string;
  name: string;
  category: string;
  body: string;
  appliesTo: "personal" | "group";
}): Promise<Result> {
  try {
    const r = await saveTemplateService({
      id: input.id,
      name: input.name,
      category: input.category as never,
      body: input.body,
      appliesTo: input.appliesTo,
    });
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function archiveTemplate(
  templateId: string,
  archived: boolean,
): Promise<Result> {
  try {
    await requireCapability("whatsapp.template.write");
    await db.execute(
      sql`update wa_templates set active = ${!archived}, updated_at = now() where id = ${templateId}`,
    );
    refreshAll();
    return okVoid(archived ? "Template archived" : "Template restored");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function startRun(input: {
  templateId: string;
  customerIds: string[];
  filterKey: string;
}): Promise<Result<{ runId: string }>> {
  try {
    const r = await createRun(input);
    refreshAll();
    return r.ok ? ok({ runId: r.data.runId }, r.message) : r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function advanceRun(
  runId: string,
  messageId: string,
  outcome: "sent" | "skipped",
): Promise<Result> {
  try {
    const r = await advanceRunService(runId, messageId, outcome);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function pauseRun(
  runId: string,
  paused: boolean,
): Promise<Result> {
  try {
    const r = await setRunStatus(runId, paused ? "paused" : "active");
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function clearRun(runId: string): Promise<Result> {
  try {
    const r = await setRunStatus(runId, "completed");
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

/* -------------------------------------------------------------------- EOD */

export async function submitEod(body: string): Promise<Result> {
  try {
    const { eodPreflightFor, eodFor } =
      await import("@/lib/services/eod-service");
    const ctx = await resolveScope();
    const day = await today();

    const preflight = await eodPreflightFor(ctx.user.id, day);
    if (!preflight.canFinalise) {
      return err(preflight.message, "rule_violation");
    }

    const report = await eodFor(ctx.user.id, day);
    await db
      .insert(eodReports)
      .values({
        id: id("eod"),
        userId: ctx.user.id,
        day,
        body: body || report.whatsappText,
        metrics: report.lines as never,
        autoGenerated: false,
        finalisedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [eodReports.userId, eodReports.day],
        set: {
          body: body || report.whatsappText,
          metrics: report.lines as never,
          autoGenerated: false,
          finalisedAt: new Date(),
        },
      });

    refreshAll();
    return okVoid("EOD report submitted");
  } catch (e) {
    return fromThrown(e);
  }
}

/* -------------------------------------------------------- notifications */

export async function markNotificationsRead(): Promise<Result> {
  const ctx = await resolveScope();
  await db
    .update(notifications)
    .set({ read: true })
    .where(eq(notifications.userId, ctx.user.id));
  revalidatePath("/", "layout");
  return okVoid();
}

export async function markNotificationRead(
  notificationId: string,
): Promise<Result> {
  await resolveScope();
  await db
    .update(notifications)
    .set({ read: true })
    .where(eq(notifications.id, notificationId));
  revalidatePath("/", "layout");
  return okVoid();
}

/* ------------------------------------------------------------ configuration */

export async function updateConfigSetting(
  key: string,
  value: unknown,
): Promise<Result<{ warnings: string[] }>> {
  try {
    const ctx = await requireCapability("config.write");
    const r = await updateSetting(key, value, ctx.user.id);
    if (!r.ok)
      return err(r.error, "validation", [{ field: key, message: r.error }]);
    refreshAll();
    revalidatePath("/crm/settings");
    return ok({ warnings: r.warnings }, "Setting saved");
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * §7 requires every scheduled task to be triggerable by hand — a missed
 * nightly run must be fixable from the screen, not only from a terminal.
 */
export async function triggerJob(
  job: "nightly" | "hourly" | "day-boundary",
): Promise<Result<{ ran: string[] }>> {
  try {
    const ctx = await requireCapability("config.write");
    const { runJob } = await import("@/lib/jobs");
    const results = await runJob(job, ctx.user.id);
    refreshAll();
    revalidatePath("/crm/settings");
    return ok(
      { ran: results.map((r) => `${r.job}: ${r.detail}`) },
      `${job} finished — ${results.reduce((a, r) => a + r.recordsAffected, 0)} records touched`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

export { and, initialsOf, recomputeLastContact };
