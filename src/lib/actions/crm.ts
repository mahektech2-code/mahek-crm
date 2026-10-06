"use server";

import { revalidatePath } from "next/cache";
import { placeShopsNow } from "@/lib/services/place-tree-service";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
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
import { requireUser } from "@/lib/auth";
import { whatsappLevel } from "@/lib/access";
import {
  updateSetting,
  updateSettings,
} from "@/lib/config/store";
import { saveInteraction } from "@/lib/services/interaction-service";
import { createComplaint } from "@/lib/services/complaint-create";
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
  holdOtherReasonsUntilReminder as holdOtherReasonsUntilReminderService,
  recordWatchOutcome,
  rescheduleReminder as rescheduleReminderService,
  resolveComplaint as resolveComplaintService,
  setComplaintPriority,
  setTarget as setTargetService,
  setTargetsBulk as setTargetsBulkService,
  resolveTargetCustomerIds,
  targetCandidates as targetCandidatesService,
  type TargetCandidate,
  type TargetListFilters,
} from "@/lib/services/worklist-services";
import {
  markThreadHandled as markThreadHandledService,
  sendChatMessage as sendChatMessageService,
  polishChatReply as polishChatReplyService,
} from "@/lib/services/whatsapp-chat-service";
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
  previewMessage,
  sendNow,
  sendRunViaApi,
  type MessagePreview,
  setRunStatus,
} from "@/lib/services/whatsapp-service";
import {
  recomputeInactivity,
  recomputeLastContact,
  today,
} from "@/lib/recompute";
import { ADMIN } from "@/lib/admin-routes";
import {
  customerTimeline,
  type TimelineCursor,
  type TimelineKind,
} from "@/lib/queries";
import { err, fromThrown, ok, okVoid, type Result } from "@/lib/result";
import { initialsOf } from "@/lib/format";
import { notifyUsers } from "../notify";
import { gstinChangeClear, reviewVoidPatch } from "../lead-review-void";
import { leadRow } from "../services/lead-service";
import { isReviewer, recordReviewVoid } from "../services/lead-qualification-flow-service";

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
    revalidatePath(ADMIN.home, "layout");
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
  if (ctx.role === "associate") return;
  const jar = await cookies();
  jar.set(SCOPE_COOKIE_NAME, scope, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  refreshAll();
}

/* -------------------------------------------------------------- the call */

function parseRupees(input?: string): number | null {
  if (!input?.trim()) return null;
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
}

export type SaveInteractionActionInput = {
  customerId: string;
  /** The call assistant's reading this form was filled from, if any. */
  aiDraftId?: string;
  interactionType: "outbound_call" | "inbound_call" | "order_received";
  outcome?: string | null;
  notes?: string;
  quickNoteIds?: string[];
  productQuantities?: Record<string, number>;
  /**
   * Product id → discount in BASIS POINTS, where the caller gave one.
   *
   * Absent on every call site that cannot price an order, and an empty map is
   * deliberately not sent: no discount and a discount of zero are the same
   * money and different facts, and the second is a decision somebody made.
   * The service re-checks each one against the caller's own authority — a
   * form is not a rule.
   */
  lineDiscounts?: Record<string, number>;
  followUpDate?: string;
  /** No order: the day they named, or that they named none. See the service. */
  noOrderNextCallDate?: string;
  noOrderNoCommitment?: boolean;
  paymentPromiseDate?: string;
  /* Inbound's own questions — who rang, why, what they asked for, and what we
     said we would do. Absent on an outbound call and on an order received. */
  callerRole?: string;
  callerName?: string;
  callReason?: string;
  reasonDetail?: Record<string, string>;
  /** What the OUTCOME asked for — both directions. See lib/call-outcomes.ts. */
  outcomeDetail?: Record<string, string>;
  nextActions?: string[];
  nextActionDate?: string;
  opportunity?: {
    product: string;
    estimatedQuantity?: string;
    estimatedValueRupees?: number;
    expectedOrderDate?: string;
  };
  complaintCategory?: string;
  complaintDescription?: string;
  complaintRequestCn?: boolean;
  complaintBillId?: string;
  complaintGoodsDescription?: string;
  /** Photos of the damaged or short goods. Best-effort, like the dialog's. */
  complaintImages?: File[];
  orderDate?: string;
  /**
   * Who to invoice, and where the goods go. Both default to the customer the
   * call is with, so an omitted pair means "bill them, deliver to them".
   */
  billingCustomerId?: string;
  deliveryCustomerId?: string;
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
      lineDiscounts: raw.lineDiscounts ?? {},
      followUpDate: raw.followUpDate,
      noOrderNextCallDate: raw.noOrderNextCallDate,
      noOrderNoCommitment: raw.noOrderNoCommitment ?? false,
      paymentPromiseDate: raw.paymentPromiseDate,
      callerRole: raw.callerRole as never,
      callerName: raw.callerName,
      callReason: raw.callReason as never,
      reasonDetail: raw.reasonDetail ?? {},
      outcomeDetail: raw.outcomeDetail ?? {},
      nextActions: raw.nextActions ?? [],
      nextActionDate: raw.nextActionDate,
      opportunity: raw.opportunity,
      complaintCategory: raw.complaintCategory as never,
      complaintDescription: raw.complaintDescription,
      complaintRequestCn: raw.complaintRequestCn ?? false,
      complaintBillId: raw.complaintBillId,
      complaintGoodsDescription: raw.complaintGoodsDescription,
      orderDate: raw.orderDate,
      billingCustomerId: raw.billingCustomerId,
      deliveryCustomerId: raw.deliveryCustomerId,
      sourceModule: raw.sourceModule ?? "ad_hoc",
      queuePosition: raw.queuePosition,
      idempotencyKey: raw.idempotencyKey ?? randomUUID(),
      aiDraftId: raw.aiDraftId,
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

export async function holdOtherReasonsUntilReminder(
  reminderId: string,
): Promise<Result> {
  try {
    const r = await holdOtherReasonsUntilReminderService(reminderId);
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
  contactPerson: z.string().trim().optional(),
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
      contactPerson: parsed.data.contactPerson || null,
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
    await placeShopsNow([customerId]);

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

    /* A CHANGED GSTIN IS NOT THE NUMBER ANYBODY VALIDATED — here as everywhere it
       is written. And if the account is a lead whose Qualification a manager has
       verified, changing the number takes that verification away unless the
       manager is the one changing it. */
    const before = await leadRow(customerId);
    const gstClear =
      parsed.data.gstin !== undefined && before
        ? gstinChangeClear(before, parsed.data.gstin || null)
        : null;
    const voided =
      parsed.data.gstin !== undefined && before
        ? reviewVoidPatch(before, { gstin: parsed.data.gstin || null }, { reviewer: await isReviewer(ctx.user) })
        : null;

    await db
      .update(customers)
      .set({
        ...(gstClear ?? {}),
        ...(voided?.set ?? {}),
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.contactPerson !== undefined
          ? { contactPerson: parsed.data.contactPerson || null }
          : {}),
        ...(parsed.data.phone ? { phone: parsed.data.phone } : {}),
        ...(parsed.data.city ? { city: parsed.data.city } : {}),
        // NOT ownerId, and not backOfficeAmId — see the guard above.
        ...(parsed.data.gstin !== undefined
          ? { gstin: parsed.data.gstin || null }
          : {}),
        /*
         * BOTH COLUMNS, because only one of them can say "nobody has stated
         * this".
         *
         * `creditTermDays` is NOT NULL DEFAULT 30, so on that column a
         * deliberate 30 and an untouched row are the same value and the party
         * projection cannot tell them apart. `creditDays` is the nullable
         * mirror and is what the sheet now reads to decide whether the field
         * is EMPTY. Writing only the first left a term somebody typed here
         * looking untouched, and the next sync put the spreadsheet's number
         * back within the half hour.
         */
        ...(parsed.data.creditTermDays !== undefined
          ? {
              creditTermDays: parsed.data.creditTermDays,
              creditDays: parsed.data.creditTermDays,
            }
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

    if (voided && before) await recordReviewVoid(db, { lead: before, voided, actorId: ctx.user.id });

    await db.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "customer.update",
      entityType: "customer",
      entityId: customerId,
      beforeState: { name: existing.name, phone: existing.phone } as never,
      afterState: parsed.data as never,
    });
    // A new town re-places a shop the tree was matching from its text; a
    // reviewed or hand-picked place is left alone by the resolver itself.
    if (parsed.data.city) await placeShopsNow([customerId]);

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
              // A person decided, so the sheet stops speaking for this row.
              statusDecidedAt: new Date(),
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
        actorApp: ctx.authorisedIn,
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

    await recomputeInactivity(customerId);
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
      await notifyUsers([
        {
          userId: m.id,
          title: "Reactivation requested",
          body: `${ctx.user.name} asked to bring back ${deactivated.length} customer${deactivated.length === 1 ? "" : "s"}: ${reason.trim()}`,
          href: "/crm/status-requests",
        },
      ]);
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
              /*
               * THE HALF THE SYNC USED TO UNDO.
               *
               * Clearing `deactivationReason` two lines up is what the party
               * projection had been reading to tell a CRM decision from its
               * own, so a reactivation erased the only evidence that anybody
               * had decided anything — and the next pass, seeing `Deactive`
               * still in the spreadsheet, closed the account again. Sixteen
               * minutes, in the case that found this.
               */
              statusDecidedAt: new Date(),
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
        actorApp: ctx.authorisedIn,
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
    await recomputeInactivity(customerId);
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
  /**
   * Normal, Urgent or Critical, as the stored severity. Absent from the
   * handset and from any caller that does not ask, which is what
   * `complaints.defaultSeverity` is for.
   */
  priority?: string;
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
    /* The priority is validated against the offered list inside the writer:
       a server action is a URL, and the SLA hangs off this value. The ERP's
       "Raise a customer request" writes through the same function. */
    const complaintId = await createComplaint({
      customerId: input.customerId,
      loggedById: ctx.user.id,
      loggedByName: ctx.user.name,
      category: input.category,
      description: input.description,
      priority: input.priority,
      mobileNumber: input.mobileNumber,
      requestCn: input.requestCn,
      billId: input.billId,
      goodsDescription: input.goodsDescription,
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

/**
 * Raising or lowering a complaint's priority once it is open.
 *
 * The judgement most likely to be made late, by somebody who knows more than
 * the person who took the call — see `setComplaintPriority` for why the
 * deadline is recomputed from when the complaint was RAISED rather than from
 * now.
 */
export async function setComplaintPriorityAction(
  complaintId: string,
  priority: string,
): Promise<Result> {
  try {
    const r = await setComplaintPriority(complaintId, priority);
    refreshAll();
    return r;
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
  /**
   * Sales bills asked for in the month, as typed. Omitted leaves the stored
   * count alone; an empty box clears it.
   */
  bills?: string,
): Promise<Result> {
  try {
    // An empty amount is a bills-only target; the service refuses a row that
    // asks for neither, with the sentence that says so.
    const paise = /^[\s₹0.,]*$/.test(amount) ? 0 : parseRupees(amount);
    if (paise === null)
      return err("Enter the monthly target in rupees.", "validation");
    let billTarget: number | null | undefined;
    if (bills !== undefined) {
      const typed = bills.trim();
      if (!typed) billTarget = null;
      else {
        const n = Number(typed);
        if (!Number.isInteger(n) || n <= 0)
          return err("Enter the number of bills as a whole number.", "validation");
        billTarget = n;
      }
    }
    const r = await setTargetService(customerId, paise, period, billTarget);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function setTargetsBulk(input: {
  /**
   * The screen's own filters, resolved to customer ids HERE rather than sent
   * as a ticked list — the honest way to act on "everyone these filters
   * match" is to run the same clause the list ran, not a client-side reading
   * of one page of it. See `targetFilterClause`.
   */
  filters: TargetListFilters;
  /**
   * Which of the customers those filters reach: the rows on the table, only
   * the listed ones still on the auto-applied default, or the direct
   * customers the table does not show because nothing is allocated yet.
   */
  population: "listed" | "defaults" | "unallocated";
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
    const customerIds = await resolveTargetCustomerIds(
      input.period,
      input.filters,
      input.population,
    );
    const r = await setTargetsBulkService(
      customerIds,
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

/**
 * The direct customers a target can be allocated to, with what each bought
 * lately — read for the allocate dialog's search, and with `customerId` for
 * the context the edit dialog shows. `target.set` is checked in the service.
 */
export async function findTargetCandidates(input: {
  period?: string;
  query?: string;
  customerId?: string;
}): Promise<Result<TargetCandidate[]>> {
  try {
    return ok(await targetCandidatesService(input));
  } catch (e) {
    return fromThrown(e);
  }
}

/* --------------------------------------------------------------- whatsapp */

/**
 * READ-ONLY IS CHECKED HERE, not by hiding the composer. A server action is a
 * URL, and a box that is not drawn is a statement to the browser.
 *
 * `chat` is for what only the WhatsApp screen offers — replying in a thread,
 * marking it handled — and asks for Write outright. `send` is for what other
 * screens offer too: the payment panel and the command centre send reminders
 * to people who were never given the chats, and they always could, so it
 * refuses only somebody deliberately narrowed to Read. See `whatsappLevel`.
 */
async function whatsappRefusal(kind: "chat" | "send"): Promise<Result<never> | null> {
  const user = await requireUser();
  const level = await whatsappLevel(user.id);
  if (level === "write" || (kind === "send" && level === "none")) return null;
  return err(
    level === "read"
      ? "Your WhatsApp access is read only — you can read the chats but not reply or send. Ask for Write on the Access screen."
      : "You do not have the WhatsApp screen.",
    "not_permitted",
  );
}

/**
 * Prepare and send one payment reminder or template message through Wati, in
 * one press. Refuses — sending nothing — whenever the message cannot go that
 * way, and the refusal says why, so the screen can fall back to copy-paste.
 */
export async function sendWhatsAppNow(input: {
  customerId: string;
  templateId: string;
}): Promise<Result<{ messageId: string }>> {
  try {
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
    const r = await sendNow({ ...input, idempotencyKey: randomUUID() });
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

/** What this customer would receive from this template, on the route it would take. */
export async function previewWhatsAppMessage(input: {
  customerId: string;
  templateId: string;
  destKind: "personal" | "group";
}): Promise<Result<MessagePreview>> {
  try {
    return ok(await previewMessage(input.customerId, input.templateId, input.destKind));
  } catch (e) {
    return fromThrown(e);
  }
}

/** Every personal message still waiting in a run, sent through the API. */
export async function sendRunThroughApi(
  runId: string,
): Promise<Result<{ sent: number; left: number; problems: string[] }>> {
  try {
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
    const r = await sendRunViaApi(runId);
    refreshAll();
    return r;
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
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
    const ctx = await resolveScope();
    /* The customer has to be one this caller may work. It took an id and
       wrote, so anybody signed in could redirect another book's reminders to
       a group of their choosing. */
    const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
    if (!customer) return err("That customer no longer exists.", "not_found");
    await assertCustomerInScope(customer);
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
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
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
        : "Copied - confirm once you have sent it",
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/** The copy step of a run: records it without claiming the message was sent. */
export async function markMessageCopied(messageId: string): Promise<Result> {
  try {
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
    const r = await markCopied(messageId);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function confirmMessageSent(messageId: string): Promise<Result> {
  try {
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
    const r = await confirmSent(messageId);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function sendMessageAutomatic(messageId: string): Promise<Result> {
  try {
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
    const r = await sendAutomatic(messageId);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function cancelMessage(messageId: string): Promise<Result> {
  try {
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
    const r = await cancelMessageService(messageId);
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function sendChatMessage(input: {
  key: string;
  text: string;
  idempotencyKey: string;
}): Promise<Result> {
  try {
    const refused = await whatsappRefusal("chat");
    if (refused) return refused;
    return await sendChatMessageService({
      key: String(input?.key ?? ""),
      text: String(input?.text ?? ""),
      idempotencyKey: String(input?.idempotencyKey ?? ""),
    });
  } catch (e) {
    return fromThrown(e);
  }
}

/** The review step's rewrite. Write level only: it exists to be sent. */
export async function polishChatReply(input: {
  key: string;
  draft: string;
  mode: "enhance" | "rewrite";
  instruction?: string;
}): Promise<Result<{ text: string }>> {
  try {
    const refused = await whatsappRefusal("chat");
    if (refused) return refused;
    return await polishChatReplyService({
      key: String(input?.key ?? ""),
      draft: String(input?.draft ?? ""),
      mode: input?.mode === "rewrite" ? "rewrite" : "enhance",
      instruction: input?.instruction ? String(input.instruction) : undefined,
    });
  } catch (e) {
    return fromThrown(e);
  }
}

export async function markThreadHandled(key: string, handled = true): Promise<Result> {
  try {
    const refused = await whatsappRefusal("chat");
    if (refused) return refused;
    return await markThreadHandledService(String(key ?? ""), handled === true);
  } catch (e) {
    return fromThrown(e);
  }
}

export async function actionReply(replyId: string, handled = true): Promise<Result> {
  try {
    const refused = await whatsappRefusal("chat");
    if (refused) return refused;
    const r = await actionReplyService(replyId, handled === true);
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
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
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
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
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
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
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
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
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
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
    const r = await setRunStatus(runId, paused ? "paused" : "active");
    refreshAll();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function clearRun(runId: string): Promise<Result> {
  try {
    const refused = await whatsappRefusal("send");
    if (refused) return refused;
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

/*
 * NEITHER OF THESE REVALIDATES, AND BOTH USED TO REVALIDATE EVERYTHING.
 *
 * They carried `revalidatePath("/", "layout")` — the broadest invalidation the
 * framework offers — on the cheapest write in the app. Marking one
 * notification read threw away the client's router cache for every route under
 * `/`, so the next navigation to any screen was a cold server render, and the
 * action's own response waited on a re-render of the current route with its
 * layout underneath it. A bell is pressed between calls, which is exactly when
 * somebody is about to navigate.
 *
 * Nothing is lost by dropping it: both call sites in `shell/header.tsx` follow
 * the await with `router.refresh()` (or a `router.push` to the notification's
 * own href), so the badge is already brought up to date by the client, off the
 * path the person is waiting on. The read itself is committed before either
 * runs.
 */
export async function markNotificationsRead(): Promise<Result> {
  const ctx = await resolveScope();
  await db
    .update(notifications)
    .set({ read: true })
    .where(eq(notifications.userId, ctx.user.id));
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
  return okVoid();
}

/* ------------------------------------------------------------ configuration */

/**
 * `config.write`, AND A STANDING IN THE APP WHOSE SETTINGS THESE ARE.
 *
 * The capability is a union over hats and is carried by the manager level of
 * several apps — so a manager of the Sales Dashboard could post a change to the
 * CRM's collections thresholds, the HRMS payroll rules or the platform's
 * sign-in settings, by URL, although the console would never have drawn them
 * that page. The console decides which pages somebody may OPEN from
 * `SETTINGS_PAGES[].owners`; the write now asks the same question of every key
 * it is handed: the platform administrator writes anything, and anybody else
 * only keys whose page is owned by an app they hold at manager or admin level.
 * A page with no owners — the platform's own settings — and a key the
 * presentation marks admin-only are the platform administrator's alone. A key
 * that sits on no page is refused, because a setting nobody can find is not
 * one to be changing by id.
 */
async function requireConfigWriteFor(keys: string[]) {
  const ctx = await requireCapability("config.write");
  const { isPlatformAdmin, hatsFor, NotPermittedError } = await import("@/lib/access-control");
  if (await isPlatformAdmin(ctx.user)) {
    // Every key, including the sign-in limits themselves — so the console's
    // password check applies here too. A manager's write is narrowed to their
    // own apps' pages below and may come from that app's own settings screen,
    // so it is not asked.
    const { requireConsoleConfirmed } = await import("@/lib/console-confirm");
    await requireConsoleConfirmed();
    return ctx;
  }

  const { placeSetting } = await import("@/lib/config/settings-placement");
  const { settingsPage } = await import("@/lib/config/settings-pages");
  const { PRESENTATION } = await import("@/lib/config/presentation");
  const managed = new Set(
    (await hatsFor(ctx.user))
      .filter((h) => h.app !== null && h.role !== "associate")
      .map((h) => h.app as string),
  );
  for (const key of keys) {
    const pageId = key.startsWith("hrms.") ? "hrms" : placeSetting(key)?.page;
    const owners = pageId ? (settingsPage(pageId)?.owners ?? []) : [];
    const adminOnly = PRESENTATION[key]?.adminOnly === true;
    if (adminOnly || !owners.some((a) => managed.has(a))) {
      throw new NotPermittedError("config.write");
    }
  }
  return ctx;
}

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
    const ctx = await requireConfigWriteFor(entries.map((e) => e.key));
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
    const ctx = await requireConfigWriteFor([key]);
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
    const { isPlatformAdmin } = await import("@/lib/access-control");
    if (!(await isPlatformAdmin(ctx.user))) {
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
    | "wa-reply-media"
    | "link-delivery-parties",
  options: { owner?: string; bills?: boolean } = {},
): Promise<Result<{ ran: string[] }>> {
  try {
    /*
     * THE PLATFORM ADMINISTRATOR'S, like rebuilding a queue above. It was
     * `config.write`, which every CRM and Sales manager carries — and a job
     * here is the nightly rebuild of every cache, a full sheet reconcile or a
     * projection that writes customers, orders and bills for the whole
     * company. None of that is a manager's to start in the middle of a day.
     */
    /*
     * THE SHEET PASSES ARE THE EXCEPTION, and they are `sheet.import`'s: the
     * accounts desk is who notices Sales Bills is empty, and on a deploy with
     * no shell this screen is the only door (AGENTS.md, "The import has to be
     * runnable from the screen"). Every other job stays the administrator's.
     */
    const ctx = await resolveScope();
    const { isPlatformAdmin, canFor } = await import("@/lib/access-control");
    const sheetJob = job === "sheet-reconcile" || job === "sheet-payments" || job === "project-sheet";
    const allowed =
      (await isPlatformAdmin(ctx.user)) || (sheetJob && (await canFor(ctx.user, "sheet.import")));
    if (!allowed) {
      return err(
        sheetJob
          ? "Running the order sheet import needs the sheet import permission (Accounts manager, or a CRM or Sales manager)."
          : "Running a scheduled job by hand is an administrator's - it rewrites figures for everybody.",
        "not_permitted",
      );
    }
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
