"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  complaints,
  complaintStatusHistory,
  customers,
  eodReports,
  notifications,
  users,
} from "@/db/schema";
import {
  bindAttachments,
  createAttachment,
} from "@/lib/services/attachment-service";
import {
  requireCapability,
  resolveScope,
  assertCustomerInScope,
  scopedToUsers,
  scopedUserIds,
} from "@/lib/access-control";
import { SCOPE_COOKIE_NAME } from "@/lib/scope";
import {
  getConfig,
  invalidateConfig,
  updateSetting,
  updateSettings,
} from "@/lib/config/store";
import { saveInteraction } from "@/lib/services/interaction-service";
import type { NextStep } from "@/lib/engines/next-step";
import {
  recordFollowUpAttempt,
  recordPayment as recordPaymentService,
} from "@/lib/services/payment-service";
import {
  logPaymentFollowUp,
  stageOneBatch,
} from "@/lib/services/payment-followup-service";
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
  prepareLegs,
  saveTemplate as saveTemplateService,
  sendAutomatic,
  setRunStatus,
} from "@/lib/services/whatsapp-service";
import {
  recomputeInactivity,
  recomputeLastContact,
  today,
} from "@/lib/recompute";
import {
  customerTimeline,
  type TimelineCursor,
  type TimelineKind,
} from "@/lib/queries";
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
/**
 * The console's own paths. Kept out of `SHARED` deliberately — a telecaller
 * logging a call should not invalidate the admin console — and guarded the
 * same way, because an action called from a test has no request context and
 * nothing cached to invalidate.
 */
function refreshAdmin() {
  try {
    revalidatePath("/admin");
  } catch {
    /* no request context — see refreshAll */
  }
}

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
  /** No order: the day they named, or that they named none. See the service. */
  noOrderNextCallDate?: string;
  noOrderNoCommitment?: boolean;
  paymentPromiseDate?: string;
  complaintCategory?: string;
  complaintDescription?: string;
  complaintRequestCn?: boolean;
  complaintBillId?: string;
  complaintGoodsDescription?: string;
  /** Photos of the damaged or short goods. Best-effort, like the dialog's. */
  complaintImages?: File[];
  orderDate?: string;
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
): Promise<
  Result<{
    produced: string[];
    complaintUpdated: boolean;
    nextStep: NextStep | null;
  }>
> {
  try {
    const result = await saveInteraction({
      customerId: raw.customerId,
      interactionType: raw.interactionType,
      outcome: (raw.outcome ?? null) as never,
      notes: raw.notes,
      quickNoteIds: raw.quickNoteIds ?? [],
      productQuantities: raw.productQuantities ?? {},
      followUpDate: raw.followUpDate,
      noOrderNextCallDate: raw.noOrderNextCallDate,
      noOrderNoCommitment: raw.noOrderNoCommitment ?? false,
      paymentPromiseDate: raw.paymentPromiseDate,
      complaintCategory: raw.complaintCategory as never,
      complaintDescription: raw.complaintDescription,
      complaintRequestCn: raw.complaintRequestCn ?? false,
      complaintBillId: raw.complaintBillId,
      complaintGoodsDescription: raw.complaintGoodsDescription,
      orderDate: raw.orderDate,
      sourceModule: raw.sourceModule ?? "ad_hoc",
      queuePosition: raw.queuePosition,
      idempotencyKey: raw.idempotencyKey ?? randomUUID(),
    });
    if (!result.ok) return result;

    // Best-effort: the call is already saved and must not be undone by a
    // failed upload.
    const attached = await attachComplaintImages(
      result.data.complaintId,
      raw.complaintImages,
    );

    refreshAll();
    return ok(
      {
        produced: result.data.produced,
        complaintUpdated: result.data.complaintUpdated,
        nextStep: result.data.nextStep,
      },
      attachmentNote(attached)
        ? `Call saved — ${attachmentNote(attached)}`
        : (result.message ?? "Interaction saved"),
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
    "Worked rows cannot be restored - the queue is derived from the calls you logged. Undo the call instead.",
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
  /** The date written on the cheque. Required by the service for dated modes. */
  instrumentDate?: string;
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
      instrumentDate: input.instrumentDate,
      idempotencyKey: randomUUID(),
    });
    refreshAll();
    return r.ok ? okVoid(r.message) : r;
  } catch (e) {
    return fromThrown(e);
  }
}

/** Stage-1 enforcement lives in the service; this surfaces its refusal. */
export async function logPaymentFollowUpAction(input: {
  customerId: string;
  outcome:
    | "promised"
    | "paid"
    | "callback"
    | "dispute"
    | "refused"
    | "noanswer";
  amount?: number;
  date?: string;
  notes?: string;
  chips?: string[];
  /** §5.2 — payment proof already uploaded, bound when the attempt saves. */
  attachmentIds?: string[];
  idempotencyKey: string;
}): Promise<
  Result<{ produced: string[]; cleared: boolean; nextStep: NextStep | null }>
> {
  try {
    const r = await logPaymentFollowUp({ ...input, chips: input.chips ?? [] });
    if (!r.ok) return r;
    refreshAll();
    return ok(
      {
        produced: r.data.produced,
        cleared: r.data.cleared,
        nextStep: r.data.nextStep,
      },
      r.message,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Start the stage 1 reminder run. Manager-only, checked here rather than only
 * disabled in the interface, and it reuses the ordinary WhatsApp run — a batch
 * still goes out one confirmed message at a time.
 */
export async function startStageOneBatch(): Promise<
  Result<{ runId: string; total: number }>
> {
  try {
    await requireCapability("whatsapp.bulk");
    const batch = await stageOneBatch();
    if (!batch.templateId) {
      return err(
        "There is no active stage 1 payment reminder template. Write one on the WhatsApp screen first.",
        "rule_violation",
      );
    }
    if (!batch.customerIds.length) {
      return err(
        "Nobody at stage 1 is due a reminder today. The four-day interval is counted from the last one actually sent.",
        "rule_violation",
      );
    }
    const run = await createRun({
      templateId: batch.templateId,
      customerIds: batch.customerIds,
      filterKey: "payment_stage_1",
    });
    if (!run.ok) return run;
    refreshAll();
    return ok(
      { runId: run.data.runId, total: run.data.total },
      `Stage 1 reminder queued for ${run.data.total} customer${run.data.total === 1 ? "" : "s"}`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

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

    /*
     * MOVING AN ACCOUNT IS NOT AN ORDINARY EDIT, AND THIS IS NOT THE DOOR.
     *
     * This action used to write `owner_id` for anybody who could edit a
     * customer at all, and `back_office_am_id` for any manager. Both are
     * account managers — `owner_id` IS the assignment on a lead — so that was
     * a second way to reassign, and the wrong one in every respect: no
     * `customer.reassign` capability, which is deliberately accounts' and
     * admin's; no reason code; no history row; nobody notified; and, worst,
     * no `am_decided_at`, so the next sheet sync restated the old answer and
     * the move silently came undone.
     *
     * The screen has routed managers through `updateAccountManagers` for a
     * while and strips these keys before calling this — but a server action is
     * a URL, and the unaudited door always wins in the end. So it is refused
     * here rather than merely unused.
     */
    if (parsed.data.ownerId !== undefined || parsed.data.backOfficeAmId !== undefined) {
      return err(
        "Account managers are changed from Reassign, not from the customer form - that is the one path that records who decided and why.",
        "not_permitted",
      );
    }

    await db
      .update(customers)
      .set({
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.contactPerson
          ? { contactPerson: parsed.data.contactPerson }
          : {}),
        ...(parsed.data.phone ? { phone: parsed.data.phone } : {}),
        ...(parsed.data.city ? { city: parsed.data.city } : {}),
        // NOT ownerId, and not backOfficeAmId — see the guard above.
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

/*
 * `setThirdParty` was here, and it is now two actions in
 * `lib/actions/third-party.ts`.
 *
 * A boolean could say an account is a shop somebody else bills and could not
 * say WHO — so the mark took a record off the calling list and left nobody to
 * ask about it. Converting names at least one distributor in the same
 * transaction, which a two-argument setter cannot express; and the two
 * directions turned out not to be symmetrical, since only a lead may be
 * converted while anything may stop being one.
 */

/**
 * The next page of a customer's timeline, or the first page of one kind of it.
 *
 * A READ behind a server action, which is unusual here and is the point: the
 * record page renders on the server and the timeline is now a page rather than
 * the whole history, so paging it from the client needs a door. It is this
 * rather than a route handler because there is nothing to cache, nothing to
 * stream and no query string worth having — and `assertCustomerInScope` is the
 * same check the page itself made before rendering a single row.
 */
export async function loadCustomerTimeline(
  customerId: string,
  opts: { kind?: TimelineKind; before?: TimelineCursor; limit?: number } = {},
): Promise<Result<{ entries: SerialisedEntry[]; cursor: TimelineCursor | null; more: boolean }>> {
  try {
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId));
    if (!customer) return err("That customer no longer exists.", "not_found");
    await assertCustomerInScope(customer);

    const page = await customerTimeline(customerId, opts);
    return ok({
      // Dates cross this boundary as strings. A server action serialises a
      // Date happily enough, and the screen already formats from a string
      // everywhere else on this page — two shapes for one field is how a
      // component ends up calling `toISOString` on a string.
      entries: page.entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        at: e.at.toISOString(),
        actor: e.actor,
        content: e.content,
        meta: e.meta ?? null,
      })),
      cursor: page.cursor,
      more: page.more,
    });
  } catch (e) {
    return fromThrown(e);
  }
}

type SerialisedEntry = {
  id: string;
  kind: string;
  at: string;
  actor: string;
  content: string;
  meta: string | null;
};

export async function requestDeactivation(
  customerIds: string[],
  reason: string,
): Promise<Result> {
  try {
    if (!reason.trim()) return err("A reason is required.", "validation");
    if (!customerIds.length)
      return err("Select at least one customer.", "validation");
    const ctx = await resolveScope();

    /*
     * WHOSE CUSTOMERS THESE ARE, checked before anything is written.
     *
     * `resolveScope` was called here and its answer never used: the update
     * matched on the ids alone, so any signed-in person could flag any
     * customer in the company by id. It only ever set a flag a manager has to
     * confirm, which is why it never showed up — but a server action is a URL,
     * and the ids are supplied by whoever calls it.
     *
     * Asked as a SELECT rather than folded into the update's WHERE, because
     * the honest answer to "one of these is not yours" is to write nothing at
     * all. A bulk action that silently flags nineteen of twenty and reports
     * success is worse than one that refuses: nobody re-reads a list they have
     * been told went through.
     */
    const scopeClause = scopedToUsers(scopedUserIds(ctx.scope));
    if (scopeClause) {
      const reachable = await db
        .select({ id: customers.id })
        .from(customers)
        .where(and(inArray(customers.id, customerIds), scopeClause));
      if (reachable.length !== customerIds.length) {
        return err(
          "Some of those customers are not in your book.",
          "not_permitted",
        );
      }
    }

    await db
      .update(customers)
      .set({
        deactivationRequested: true,
        deactivationReason: reason.trim(),
        // Stored on the row, not only in the notification. A queue that cannot
        // say who asked is a queue a manager has to answer on trust.
        deactivationRequestedById: ctx.user.id,
        deactivationRequestedAt: new Date(),
      })
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
        // The customer list, which marks a row whose deactivation has been
        // asked for. It was the Inactive Watch until that screen went — and a
        // bell landing on a route that no longer exists is worse than one with
        // no href at all.
        href: "/crm/customers",
      });
    }

    refreshAll();
    return okVoid("Deactivation requested - a manager decides");
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
      // Which hat allowed it — see `audit_log.actor_role`.
      actorRole: ctx.authorisedBy,
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

/* ---------------------------------------------------------- coming back */

/**
 * Asking for a deactivated customer to be brought back.
 *
 * The mirror of `requestDeactivation`, and deliberately the same shape: the
 * person who knows the account raises it with a reason, and a manager decides.
 * `recomputeInactivity` will not do it on the strength of an order — a
 * deactivation was somebody's decision and an order does not undo it — so this
 * is the only way back.
 *
 * Only a deactivated customer can be asked for. Anybody else is already in the
 * book, and a pending request against them would sit on a manager's list
 * meaning nothing.
 */
export async function requestReactivation(
  customerIds: string[],
  reason: string,
): Promise<Result> {
  try {
    if (!reason.trim()) return err("A reason is required.", "validation");
    if (!customerIds.length)
      return err("Select at least one customer.", "validation");
    const ctx = await resolveScope();

    const rows = await db
      .select({ id: customers.id, status: customers.status })
      .from(customers)
      .where(inArray(customers.id, customerIds));

    const deactivated = rows.filter((r) => r.status === "deactivated");
    if (!deactivated.length) {
      return err(
        rows.length === 1
          ? "That customer is not deactivated, so there is nothing to bring back."
          : "None of those customers are deactivated.",
        "conflict",
      );
    }

    await db
      .update(customers)
      .set({
        reactivationRequested: true,
        reactivationReason: reason.trim(),
        reactivationRequestedById: ctx.user.id,
        reactivationRequestedAt: new Date(),
      })
      .where(
        inArray(
          customers.id,
          deactivated.map((r) => r.id),
        ),
      );

    const managers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.role, ["manager", "admin"]));
    for (const m of managers) {
      await db.insert(notifications).values({
        id: id("ntf"),
        userId: m.id,
        title: "Reactivation requested",
        body: `${ctx.user.name} asked to bring back ${deactivated.length} customer${deactivated.length === 1 ? "" : "s"}: ${reason.trim()}`,
        kind: "info",
        href: "/crm/status-requests",
      });
    }

    refreshAll();
    // Says how many were acted on rather than how many were selected: a bulk
    // selection that included live customers has not done what it looks like.
    return okVoid(
      deactivated.length === rows.length
        ? "Reactivation requested - a manager decides"
        : `Reactivation requested for ${deactivated.length} of ${rows.length} - the rest were not deactivated`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * The manager's half.
 *
 * Approving puts the customer back at `active` and lets `recomputeInactivity`
 * decide from there whether they are actually quiet — status is derived from
 * behaviour once somebody is in the book again, and setting `active` by hand
 * and leaving it would be a stored value nobody rebuilds.
 *
 * The deactivation fields are cleared rather than kept. They describe a state
 * the customer is no longer in, and a stale reason sitting on a live row is
 * how a screen ends up explaining a deactivation that was reversed in March.
 * The audit log holds both decisions, which is what it is for.
 */
export async function decideReactivation(
  customerId: string,
  approve: boolean,
): Promise<Result> {
  try {
    const ctx = await requireCapability("customer.deactivate");
    const [existing] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId));
    if (!existing) return err("That customer no longer exists.", "not_found");

    if (approve && existing.status !== "deactivated") {
      return err(
        "That customer is already in the book. Somebody has brought them back already.",
        "conflict",
      );
    }

    await db
      .update(customers)
      .set(
        approve
          ? {
              status: "active",
              deactivatedAt: null,
              deactivatedById: null,
              deactivationReason: null,
              deactivationRequested: false,
              reactivationRequested: false,
              reactivationReason: null,
              updatedAt: new Date(),
              updatedById: ctx.user.id,
            }
          : {
              reactivationRequested: false,
              reactivationReason: null,
              updatedAt: new Date(),
              updatedById: ctx.user.id,
            },
      )
      .where(eq(customers.id, customerId));

    await db.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      // Which hat allowed it — see `audit_log.actor_role`.
      actorRole: ctx.authorisedBy,
      action: approve ? "customer.reactivate" : "customer.reactivation_rejected",
      entityType: "customer",
      entityId: customerId,
      beforeState: {
        status: existing.status,
        deactivationReason: existing.deactivationReason,
      } as never,
      afterState: {
        status: approve ? "active" : existing.status,
        reason: existing.reactivationReason,
      } as never,
    });

    // A customer back in the book is a customer the queue has to place, and
    // one who has been quiet for months goes straight onto the inactive watch
    // rather than reading as freshly active.
    await recomputeInactivity();
    refreshAll();
    return okVoid(approve ? "Customer brought back" : "Request rejected");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------- complaints */

/**
 * Photos of the damaged or short goods, attached to a complaint however it was
 * raised — the dialog and a call both come through here.
 *
 * Storage has no backend yet (see lib/storage.ts), so this is deliberately
 * best-effort: the complaint is already written and a dead uploader must not
 * take it down with it. The caller says so on screen rather than pretending
 * the pictures arrived.
 */
async function attachComplaintImages(
  complaintId: string | null,
  images?: File[],
): Promise<{ wanted: number; attached: number }> {
  const wanted = images?.length ?? 0;
  if (!complaintId || !wanted) return { wanted: 0, attached: 0 };

  // §4.2 — never blocks the save. The complaint is already written; each file
  // is validated on its bytes and the ones that make it are bound. What did
  // not make it is reported by count, so nobody assumes all or nothing.
  const results = await Promise.allSettled(
    images!.map(async (file) => {
      const created = await createAttachment({
        filename: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        declaredType: file.type,
      });
      if (!created.ok) throw new Error(created.error);
      return created.data.id;
    }),
  );
  const ids = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!ids.length) return { wanted, attached: 0 };

  const bound = await bindAttachments(ids, "complaint", complaintId);
  return { wanted, attached: bound.ok ? bound.data.bound : 0 };
}

/** The sentence to show when some files did not make it. */
function attachmentNote({ wanted, attached }: { wanted: number; attached: number }) {
  if (!wanted || attached === wanted) return null;
  return `${attached} of ${wanted} file${wanted === 1 ? "" : "s"} attached`;
}

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

    const attached = await attachComplaintImages(complaintId, input.images);

    refreshAll();
    const note = attachmentNote(attached);
    return okVoid(note ? `Complaint logged — ${note}` : "Complaint logged");
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
  dest?: "personal" | "group" | "both",
): Promise<Result> {
  try {
    const ctx = await resolveScope();
    const named = groupName.trim();
    // Without a group there is nowhere for the other legs to go, so clearing
    // the name always returns the customer to their own number.
    const whatsappDest = !named ? "personal" : (dest ?? "group");
    await db
      .update(customers)
      .set({
        whatsappGroupName: named || null,
        whatsappDest,
        updatedAt: new Date(),
        updatedById: ctx.user.id,
      })
      .where(eq(customers.id, customerId));
    refreshAll();
    return okVoid(
      whatsappDest === "both"
        ? "Saved - this customer now gets both"
        : "Group name saved",
    );
  } catch (e) {
    return fromThrown(e);
  }
}

export async function queueMessage(input: {
  customerId: string;
  templateId?: string | null;
  body: string;
  edited: boolean;
  destKind: "personal" | "group" | "both";
  runId?: string | null;
}): Promise<
  Result<{
    id: string;
    legs: Array<{ id: string; destKind: "personal" | "group"; destination: string }>;
  }>
> {
  try {
    if (!input.templateId) return err("Pick a template.", "validation");
    const prepared = await prepareLegs({
      customerId: input.customerId,
      templateId: input.templateId,
      bodyOverride: input.edited ? input.body : undefined,
      destKind: input.destKind,
      runId: input.runId ?? undefined,
      idempotencyKey: randomUUID(),
    });
    if (!prepared.ok) return prepared;

    const legs = prepared.data;
    // Only the leg the telecaller actually copies is marked copied. A both-ways
    // pair copied in one click would claim the group had been pasted into
    // before anybody opened WhatsApp.
    if (legs.length === 1) await markCopied(legs[0].messageId);
    refreshAll();

    return ok(
      {
        id: legs[0].messageId,
        legs: legs.map((l) => ({
          id: l.messageId,
          destKind: l.destKind,
          destination: l.resolvedDestination,
        })),
      },
      legs.length > 1
        ? "Both messages are ready - work them one at a time"
        : legs[0].mode === "automatic"
          ? "Ready to send"
          : "Copied - confirm once you have sent it",
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
  appliesTo: "personal" | "group" | "both";
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

/**
 * A whole section, saved as one change set. The Admin Console edits several
 * related settings at once and reviews them together, so it commits them
 * together — a half-applied set of escalation thresholds describes a policy
 * nobody agreed to.
 */
export async function updateConfigSettings(
  entries: Array<{ key: string; value: unknown }>,
): Promise<Result<{ warnings: string[] }>> {
  try {
    const ctx = await requireCapability("config.write");
    const r = await updateSettings(entries, ctx.user.id);
    if (!r.ok) return err(r.error, "validation", r.fields);
    refreshAll();
    refreshAdmin();
    return ok(
      { warnings: r.warnings },
      entries.length === 1
        ? "1 setting saved. It takes effect immediately."
        : `${entries.length} settings saved. They take effect immediately.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

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
    refreshAdmin();
    return ok({ warnings: r.warnings }, "Setting saved");
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * §7 requires every scheduled task to be triggerable by hand — a missed
 * nightly run must be fixable from the screen, not only from a terminal.
 *
 * The sheet jobs are here for a sharper reason: on a deploy nobody has shell
 * access to, a terminal is not a fallback, it is the only door and it is
 * locked. The import ran on somebody's laptop against the production database
 * or it did not run at all, and Sales Bills stayed empty through three
 * releases that each claimed to fix it. A merge has to be enough.
 */
/**
 * Rebuild today's Call Log, for one telecaller or for everybody.
 *
 * ADMIN ONLY, and not by `config.write` — that is a manager's, and a manager
 * rebuilding a list is a manager reshuffling the day of the people whose
 * numbers they are measured on, halfway through it. `apps.includes("admin")`
 * is what the console already means by admin, so the button and the action
 * answer to the same rule rather than two that can drift.
 *
 * It is a bulk action in the sense that matters: it never edits a row of work.
 * It throws away a cached list and asks the engine the same question again, so
 * the worst it can do is reorder somebody's afternoon — which is real, which
 * is why it is audited with the names of whoever was rebuilt.
 */
export async function rebuildQueues(
  userIds: string[] | null,
): Promise<Result<{ users: number; cleared: number; written: number }>> {
  try {
    const ctx = await resolveScope();
    const { listUserApps } = await import("@/lib/access");
    const apps = await listUserApps(ctx.user.id);
    if (!apps.includes("admin")) {
      return err(
        "Rebuilding a call list is an administrator's - it reorders somebody else's day.",
        "not_permitted",
      );
    }

    const { resettleQueues } = await import("@/lib/jobs");
    const day = await today();
    const result = await resettleQueues(day, userIds);

    // Who did it, to whom, and on which day. A list that changed under
    // somebody mid-afternoon is exactly the thing they will ask about later.
    await db.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "queue.rebuild",
      entityType: "queue",
      entityId: day,
      afterState: {
        day,
        users: userIds?.length ? userIds : "all",
        cleared: result.cleared,
        written: result.written,
      },
    });

    refreshAll();
    refreshAdmin();
    return ok(
      result,
      result.users === 0
        ? "Nobody to rebuild"
        : `Rebuilt ${result.users} list${result.users === 1 ? "" : "s"} - ${result.cleared} rows replaced by ${result.written}`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

export async function triggerJob(
  job:
    | "nightly"
    | "hourly"
    | "day-boundary"
    | "sheet-reconcile"
    | "sheet-payments"
    | "project-sheet"
    | "backfill-timeline"
    | "link-delivery-parties",
  options: { owner?: string; bills?: boolean } = {},
): Promise<Result<{ ran: string[] }>> {
  try {
    const ctx = await requireCapability("config.write");
    const { runJob } = await import("@/lib/jobs");
    const results = await runJob(job, ctx.user.id, options);
    refreshAll();
    refreshAdmin();
    return ok(
      { ran: results.map((r) => `${r.job}: ${r.detail}`) },
      `${job} finished - ${results.reduce((a, r) => a + r.recordsAffected, 0)} records touched`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

export { and, initialsOf, recomputeLastContact };
