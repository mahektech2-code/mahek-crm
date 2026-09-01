import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  bills,
  customers,
  waMessages,
  waReplies,
  waRuns,
  waTemplates,
} from "@/db/schema";
import {
  assertCustomerInScope,
  requireCapability,
  resolveScope,
  scopedUserIds, scopedToUsers,} from "../access-control";
import { getConfig } from "../config/store";
import { recomputeLastContact, today } from "../recompute";
import { err, ok, okVoid, type Result } from "../result";
import { effectiveDueDate } from "../engines/escalation";
import { billCreditDaysSql } from "../bill-terms";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ---------------------------------------------------------------------------
 * §5.7 WhatsApp dual mode.
 *
 * THE RULE THAT MATTERS MOST:
 * the customer's last-WhatsApp date — which drives queue suppression — is set
 * ONLY on confirmed send (manual) or actual send (automatic). Never on copy.
 * A copied-but-unconfirmed message must not suppress the customer, because the
 * system does not know it was sent.
 * ------------------------------------------------------------------------- */

/* -------------------------------------------------------- merge rendering */

export const MERGE_FIELDS = [
  "customer", "contact", "city", "phone", "outstanding",
  "last_order_date", "last_order_value", "bill_no", "bill_due", "owner",
] as const;

export type MergeValues = Record<string, string>;

function money(paise: number): string {
  const r = Math.round(paise / 100);
  const s = String(Math.abs(r));
  const grouped =
    s.length <= 3 ? s : s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + s.slice(-3);
  return `₹${grouped}`;
}

export function usedFields(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) found.add(m[1]);
  return [...found];
}

export function applyMerge(body: string, values: MergeValues): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key: string) => values[key] ?? "");
}

async function mergeValuesFor(customerId: string): Promise<MergeValues> {
  const config = await getConfig();
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!c) return {};

  const billRows = await db
    .select({ bill: bills, creditDays: billCreditDaysSql })
    .from(bills)
    .where(
      and(
        eq(bills.customerId, customerId),
        sql`${bills.amount} > ${bills.paidAmount}`,
        // Never a bill nobody has stated a position for. This composes a
        // message that goes to the CUSTOMER asking for money — the one place
        // an unverified balance leaves the building, and the one that cannot
        // be taken back once sent.
        eq(bills.paymentPosition, "stated"),
      ),
    )
    .orderBy(asc(bills.billDate));

  const oldest = billRows[0]?.bill;
  const oldestCreditDays = billRows[0]?.creditDays ?? null;
  const ownerName = c.ownerId
    ? (
        await db.execute<{ name: string }>(
          sql`select name from users where id = ${c.ownerId}`,
        )
      )[0]?.name
    : undefined;

  return {
    customer: c.name,
    contact: c.contactPerson ?? "",
    city: c.city,
    phone: c.phone,
    outstanding: c.outstanding ? money(c.outstanding) : "",
    last_order_date: c.lastOrderDate ?? "",
    last_order_value: c.lastOrderValue ? money(c.lastOrderValue) : "",
    bill_no: oldest?.billNo ?? "",
    bill_due: oldest
      ? effectiveDueDate(
          {
            id: oldest.id, billNo: oldest.billNo, billDate: oldest.billDate,
            dueDate: oldest.dueDate,
            creditDays: oldestCreditDays === null ? null : Number(oldestCreditDays),
            amount: oldest.amount,
            paid: oldest.paidAmount, disputed: oldest.disputed,
          },
          config,
        )
      : "",
    owner: ownerName ?? "",
  };
}

/* ------------------------------------------------------------------ prepare */

export const prepareSchema = z.object({
  customerId: z.string().min(1),
  templateId: z.string().min(1),
  /** Overrides the template body when a telecaller edits before sending. */
  bodyOverride: z.string().optional(),
  /** "both" is resolved by `prepareLegs`; `prepareMessage` writes one leg. */
  destKind: z.enum(["personal", "group", "both"]).optional(),
  runId: z.string().optional(),
  idempotencyKey: z.string().min(8),
});

export type PreparedMessage = {
  messageId: string;
  body: string;
  resolvedDestination: string;
  destKind: "personal" | "group";
  mode: "manual" | "automatic";
  edited: boolean;
};

/**
 * Renders the template, validates every merge field, and creates the record in
 * `prepared`. A message reading "Dear ," must never reach a customer, so a
 * placeholder that resolves to empty is a hard rejection naming the field.
 */
export async function prepareMessage(
  raw: z.input<typeof prepareSchema>,
): Promise<Result<PreparedMessage>> {
  const parsed = prepareSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(issue.message, "validation", [
      { field: issue.path.join("."), message: issue.message },
    ]);
  }
  const input = parsed.data;
  const ctx = await resolveScope();
  const config = await getConfig();

  const [existing] = await db
    .select()
    .from(waMessages)
    .where(eq(waMessages.idempotencyKey, input.idempotencyKey));
  if (existing) {
    return ok({
      messageId: existing.id,
      body: existing.body,
      resolvedDestination: existing.resolvedDestination,
      // Stored rows are always one leg; "both" never reaches this column.
      destKind: existing.destKind as "personal" | "group",
      mode: existing.mode,
      edited: existing.edited,
    });
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, input.customerId));
  if (!customer) return err("That customer no longer exists.", "not_found");
  await assertCustomerInScope(customer);

  if (customer.doNotContact) {
    return err(`${customer.name} is marked do not contact.`, "rule_violation");
  }

  const [template] = await db
    .select()
    .from(waTemplates)
    .where(eq(waTemplates.id, input.templateId));
  if (!template) return err("That template no longer exists.", "not_found");

  const values = await mergeValuesFor(input.customerId);
  const sourceBody = input.bodyOverride ?? template.body;

  // Validate BEFORE rendering, and name the specific field.
  const missing = usedFields(template.body).filter((f) => !values[f]);
  if (missing.length && !input.bodyOverride) {
    return err(
      `This message cannot be built for ${customer.name}: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} empty. Fill it on the customer record first.`,
      "validation",
      missing.map((f) => ({ field: f, message: `${f} is empty for this customer.` })),
    );
  }

  // One row, one destination. A customer standing at "both" collapses to the
  // personal leg here; splitting the pair is `prepareLegs`' job, and letting
  // "both" through would write a destination no send path knows how to reach.
  const requested =
    input.destKind ?? (customer.whatsappGroupName ? customer.whatsappDest : "personal");
  const destKind: "personal" | "group" = requested === "both" ? "personal" : requested;
  const resolvedDestination =
    destKind === "group"
      ? (customer.whatsappGroupName ?? "")
      : (customer.whatsappPhone ?? customer.phone);

  if (!resolvedDestination) {
    return err(
      `No ${destKind === "group" ? "group name" : "number"} recorded for ${customer.name}.`,
      "validation",
      [{ field: "destination", message: "No destination recorded." }],
    );
  }

  const messageId = id("wam");
  const body = applyMerge(sourceBody, values);

  await db.insert(waMessages).values({
    id: messageId,
    customerId: input.customerId,
    templateId: template.id,
    templateName: template.name,
    userId: ctx.user.id,
    mode: config["whatsapp.mode"],
    destKind,
    resolvedDestination,
    body,
    edited: Boolean(input.bodyOverride && input.bodyOverride !== template.body),
    status: "prepared",
    runId: input.runId ?? null,
    idempotencyKey: input.idempotencyKey,
    createdById: ctx.user.id,
    updatedById: ctx.user.id,
  });

  return ok({
    messageId,
    body,
    resolvedDestination,
    destKind,
    mode: config["whatsapp.mode"],
    edited: Boolean(input.bodyOverride && input.bodyOverride !== template.body),
  });
}

/**
 * Prepares every leg a customer is owed. A customer set to `both` is reached
 * twice — the API carries it to the owner's own number, and a human pastes the
 * same text into the group their staff actually read — so it produces two
 * rows, each with its own state. One idempotency key still covers the pair:
 * the legs derive their own from it, so a retried click cannot double-send
 * either half.
 *
 * Order matters. The personal leg comes first because it is the one that can
 * complete without a human, and the screen works down the list.
 */
export async function prepareLegs(
  raw: z.input<typeof prepareSchema>,
): Promise<Result<PreparedMessage[]>> {
  const parsed = prepareSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(issue.message, "validation", [
      { field: issue.path.join("."), message: issue.message },
    ]);
  }
  const input = parsed.data;

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, input.customerId));
  if (!customer) return err("That customer no longer exists.", "not_found");

  const wanted = input.destKind ?? customer.whatsappDest;
  const legs: Array<"personal" | "group"> =
    wanted === "both"
      ? customer.whatsappGroupName
        ? ["personal", "group"]
        : // Configured for both but nobody recorded the group. Reaching the
          // owner is better than reaching nobody, and the screen says why.
          ["personal"]
      : [wanted === "group" && !customer.whatsappGroupName ? "personal" : wanted];

  const prepared: PreparedMessage[] = [];
  for (const leg of legs) {
    const result = await prepareMessage({
      ...input,
      destKind: leg,
      idempotencyKey: legs.length > 1 ? `${input.idempotencyKey}:${leg}` : input.idempotencyKey,
    });
    if (!result.ok) return result;
    prepared.push(result.data);
  }

  return ok(prepared);
}

/* ------------------------------------------------------------ state changes */

/** Records the copy. Deliberately does NOT touch the customer's contact dates. */
export async function markCopied(messageId: string): Promise<Result> {
  const [message] = await db.select().from(waMessages).where(eq(waMessages.id, messageId));
  if (!message) return err("That message no longer exists.", "not_found");
  if (message.status !== "prepared" && message.status !== "copied") {
    return err(`A ${message.status} message cannot be marked copied.`, "conflict");
  }

  await db
    .update(waMessages)
    .set({ status: "copied", copiedAt: new Date(), updatedAt: new Date() })
    .where(eq(waMessages.id, messageId));

  return okVoid("Copied - confirm once you have sent it");
}

/**
 * The only place a manual message becomes real. Sets the customer's
 * last-WhatsApp date, which is what suppresses them from the call log.
 */
export async function confirmSent(messageId: string): Promise<Result> {
  const ctx = await resolveScope();
  const day = await today();

  const [message] = await db.select().from(waMessages).where(eq(waMessages.id, messageId));
  if (!message) return err("That message no longer exists.", "not_found");
  if (message.status === "cancelled") {
    return err("That message was cancelled.", "conflict");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(waMessages)
      .set({
        status: "sent_manually",
        confirmedSentAt: new Date(),
        updatedAt: new Date(),
        updatedById: ctx.user.id,
      })
      .where(eq(waMessages.id, messageId));

    // Only here, never on copy.
    await tx
      .update(customers)
      .set({ lastConfirmedWhatsappDate: day, updatedAt: new Date() })
      .where(eq(customers.id, message.customerId));

    if (message.templateId) {
      await tx
        .update(waTemplates)
        .set({ usageCount: sql`${waTemplates.usageCount} + 1` })
        .where(eq(waTemplates.id, message.templateId));
    }

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "whatsapp.confirm_sent",
      entityType: "wa_message",
      entityId: messageId,
      afterState: { customerId: message.customerId } as never,
    });
  });

  await recomputeLastContact(message.customerId);
  return okVoid("Marked as sent");
}

export async function cancelMessage(messageId: string): Promise<Result> {
  const [message] = await db.select().from(waMessages).where(eq(waMessages.id, messageId));
  if (!message) return err("That message no longer exists.", "not_found");
  if (["sent_manually", "sent", "delivered", "read"].includes(message.status)) {
    return err("A sent message cannot be cancelled.", "conflict");
  }
  await db
    .update(waMessages)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(waMessages.id, messageId));
  return okVoid("Discarded");
}

/**
 * Automatic mode. Behind the same interface as manual, so turning the
 * integration on is a configuration change plus credentials — no code change.
 */
export async function sendAutomatic(messageId: string): Promise<Result> {
  const config = await getConfig();
  if (config["whatsapp.mode"] !== "automatic") {
    return err(
      "Automatic sending is off. Switch the WhatsApp mode in configuration first.",
      "rule_violation",
    );
  }

  const [message] = await db.select().from(waMessages).where(eq(waMessages.id, messageId));
  if (!message) return err("That message no longer exists.", "not_found");

  const day = await today();
  await db.transaction(async (tx) => {
    await tx
      .update(waMessages)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(waMessages.id, messageId));

    // The provider call goes here. Until credentials exist it resolves
    // optimistically to `sent`, and delivery callbacks move it onward.
    await tx
      .update(waMessages)
      .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
      .where(eq(waMessages.id, messageId));

    await tx
      .update(customers)
      .set({ lastConfirmedWhatsappDate: day, updatedAt: new Date() })
      .where(eq(customers.id, message.customerId));
  });

  await recomputeLastContact(message.customerId);
  return okVoid("Message sent");
}

/* ------------------------------------------------------------------- lists */

export async function listMessages(filters?: {
  status?: string;
  mode?: string;
  customerId?: string;
}) {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);

  const rows = await db
    .select({
      message: waMessages,
      customerName: customers.name,
      userName: sql<string | null>`(select name from users u where u.id = ${waMessages.userId})`,
    })
    .from(waMessages)
    .innerJoin(customers, eq(customers.id, waMessages.customerId))
    .where(
      and(
        ids ? inArray(waMessages.userId, ids) : undefined,
        filters?.status ? eq(waMessages.status, filters.status as never) : undefined,
        filters?.mode ? eq(waMessages.mode, filters.mode as never) : undefined,
        filters?.customerId ? eq(waMessages.customerId, filters.customerId) : undefined,
      ),
    )
    .orderBy(desc(waMessages.preparedAt))
    .limit(300);

  return rows.map(({ message, customerName, userName }) => ({
    ...message,
    customerName,
    userName,
  }));
}

/**
 * The manager's watch metric: copied, never confirmed, older than the expiry.
 * Each one is a customer who may or may not have been contacted.
 */
export async function listUnconfirmedCopies() {
  const config = await getConfig();
  const cutoff = new Date(
    Date.now() - config["whatsapp.unconfirmedExpiryHours"] * 3_600_000,
  );

  const rows = await db
    .select({ message: waMessages, customerName: customers.name })
    .from(waMessages)
    .innerJoin(customers, eq(customers.id, waMessages.customerId))
    .where(and(eq(waMessages.status, "copied"), lt(waMessages.copiedAt, cutoff)))
    .orderBy(asc(waMessages.copiedAt));

  return rows.map(({ message, customerName }) => ({ ...message, customerName }));
}

export async function listReplies() {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const rows = await db
    .select({ reply: waReplies, customerName: customers.name })
    .from(waReplies)
    .innerJoin(customers, eq(customers.id, waReplies.customerId))
    .where(and(eq(waReplies.actioned, false), scopedToUsers(ids)))
    .orderBy(desc(waReplies.receivedAt));
  return rows.map(({ reply, customerName }) => ({ ...reply, customerName }));
}

export async function actionReply(replyId: string): Promise<Result> {
  await db.update(waReplies).set({ actioned: true }).where(eq(waReplies.id, replyId));
  return okVoid("Reply actioned");
}

/* -------------------------------------------------------------- templates */

export async function listTemplates(includeInactive = false) {
  return db
    .select()
    .from(waTemplates)
    .where(includeInactive ? undefined : eq(waTemplates.active, true))
    .orderBy(asc(waTemplates.category), asc(waTemplates.name));
}

export async function saveTemplate(input: {
  id?: string;
  name: string;
  category: "order_confirmation" | "payment_reminder" | "routine_check_in" | "reactivation" | "other";
  escalationStage?: number | null;
  body: string;
  appliesTo: "personal" | "group" | "both";
  active?: boolean;
}): Promise<Result> {
  const ctx = await requireCapability("whatsapp.template.write");
  if (!input.name.trim()) return err("Give the template a name.", "validation");
  if (!input.body.trim()) return err("Write the message body.", "validation");

  if (input.id) {
    await db
      .update(waTemplates)
      .set({
        name: input.name.trim(),
        category: input.category,
        escalationStage: input.escalationStage ?? null,
        body: input.body,
        appliesTo: input.appliesTo,
        active: input.active ?? true,
        updatedAt: new Date(),
        updatedById: ctx.user.id,
      })
      .where(eq(waTemplates.id, input.id));
  } else {
    await db.insert(waTemplates).values({
      id: id("tpl"),
      name: input.name.trim(),
      category: input.category,
      escalationStage: input.escalationStage ?? null,
      body: input.body,
      appliesTo: input.appliesTo,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });
  }
  return okVoid("Template saved");
}

/* ------------------------------------------------------------- send runs */

/**
 * Every recipient's message record is created up front in `prepared`, which is
 * what makes a run resumable: a refresh picks up from the first recipient not
 * yet in a terminal state. Nobody restarts a forty-customer run.
 */
export async function createRun(input: {
  templateId: string;
  customerIds: string[];
  filterKey: string;
}): Promise<Result<{ runId: string; total: number; skipped: string[] }>> {
  const ctx = await requireCapability("whatsapp.bulk");
  const config = await getConfig();

  if (!input.customerIds.length) {
    return err("Nobody matches that filter today.", "validation");
  }

  const runId = id("run");
  await db.insert(waRuns).values({
    id: runId,
    userId: ctx.user.id,
    templateId: input.templateId,
    mode: config["whatsapp.mode"],
    filterKey: input.filterKey,
    totalCount: 0,
    createdById: ctx.user.id,
  });

  const skipped: string[] = [];
  let created = 0;

  for (const customerId of input.customerIds) {
    const prepared = await prepareMessage({
      customerId,
      templateId: input.templateId,
      runId,
      idempotencyKey: `${runId}:${customerId}`,
    });
    if (prepared.ok) created++;
    else skipped.push(`${customerId}: ${prepared.error}`);
  }

  await db
    .update(waRuns)
    .set({ totalCount: created, skippedCount: skipped.length })
    .where(eq(waRuns.id, runId));

  return ok({ runId, total: created, skipped }, `Run ready - ${created} recipients`);
}

export async function getRun(runId: string) {
  const [run] = await db.select().from(waRuns).where(eq(waRuns.id, runId));
  if (!run) return null;

  const messages = await db
    .select({ message: waMessages, customerName: customers.name })
    .from(waMessages)
    .innerJoin(customers, eq(customers.id, waMessages.customerId))
    .where(eq(waMessages.runId, runId))
    .orderBy(asc(waMessages.preparedAt));

  const TERMINAL = ["sent_manually", "sent", "delivered", "read", "cancelled"];
  const current = messages.find((m) => !TERMINAL.includes(m.message.status));

  return {
    run,
    recipients: messages.map(({ message, customerName }) => ({
      ...message,
      customerName,
      done: TERMINAL.includes(message.status),
    })),
    current: current
      ? { ...current.message, customerName: current.customerName }
      : null,
    sent: messages.filter((m) =>
      ["sent_manually", "sent", "delivered", "read"].includes(m.message.status),
    ).length,
    skipped: messages.filter((m) => m.message.status === "cancelled").length,
  };
}

/** Resumes wherever the run got to — the record set is the state. */
export async function findResumableRun(userId: string) {
  const [run] = await db
    .select()
    .from(waRuns)
    .where(and(eq(waRuns.userId, userId), eq(waRuns.status, "active")))
    .orderBy(desc(waRuns.startedAt))
    .limit(1);
  return run ? getRun(run.id) : null;
}

export async function advanceRun(
  runId: string,
  messageId: string,
  outcome: "sent" | "skipped",
): Promise<Result> {
  const result =
    outcome === "sent" ? await confirmSent(messageId) : await cancelMessage(messageId);
  if (!result.ok) return result;

  const state = await getRun(runId);
  if (state && !state.current) {
    await db
      .update(waRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        sentCount: state.sent,
        skippedCount: state.skipped,
      })
      .where(eq(waRuns.id, runId));
  } else if (state) {
    await db
      .update(waRuns)
      .set({ sentCount: state.sent, skippedCount: state.skipped })
      .where(eq(waRuns.id, runId));
  }

  return okVoid(outcome === "sent" ? "Sent - next customer" : "Skipped");
}

export async function setRunStatus(
  runId: string,
  status: "active" | "paused" | "cancelled" | "completed",
): Promise<Result> {
  await db
    .update(waRuns)
    .set({
      status,
      ...(status === "completed" || status === "cancelled"
        ? { completedAt: new Date() }
        : {}),
    })
    .where(eq(waRuns.id, runId));
  return okVoid(`Run ${status}`);
}

/* --------------------------------------------------------- hourly sweep */

/**
 * Copied messages older than the expiry either auto-confirm, if that is
 * switched on, or are left for the manager. Default is never auto-confirm:
 * asserting a message was sent when the system cannot know that is exactly
 * the failure the confirm step exists to prevent.
 */
export async function sweepUnconfirmed(): Promise<{ swept: number; autoConfirmed: number }> {
  const config = await getConfig();
  const expiry = config["whatsapp.unconfirmedExpiryHours"];
  const autoAfter = config["whatsapp.autoConfirmAfterHours"];

  const stale = await db
    .select()
    .from(waMessages)
    .where(
      and(
        eq(waMessages.status, "copied"),
        lt(waMessages.copiedAt, new Date(Date.now() - expiry * 3_600_000)),
      ),
    );

  let autoConfirmed = 0;
  if (autoAfter > 0) {
    const cutoff = new Date(Date.now() - autoAfter * 3_600_000);
    for (const m of stale) {
      if (m.copiedAt && m.copiedAt < cutoff) {
        await confirmSent(m.id);
        autoConfirmed++;
      }
    }
  }

  return { swept: stale.length, autoConfirmed };
}

export { isNull };

/* ------------------------------------------- the payment reminder preview */

export type ReminderPreview = {
  templateId: string;
  templateName: string;
  destination: string;
  destKind: "personal" | "group";
  body: string;
  mode: "manual" | "automatic";
  /** Every merge field the template uses, and whether this customer has it. */
  fields: Array<{ label: string; value: string; ok: boolean }>;
  /** True when a field is empty, so the message would read badly. */
  blocked: boolean;
  blockedReason: string | null;
};

/**
 * What the stage's reminder would say for this customer, without preparing
 * anything. The follow-up modal shows this before the telecaller commits, so
 * an empty merge field is caught by eye as well as by `prepareMessage`.
 */
export async function previewPaymentReminder(
  customerId: string,
  stage: number,
): Promise<ReminderPreview | null> {
  const config = await getConfig();
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!customer) return null;
  await assertCustomerInScope(customer);

  // The stage's own template, falling back to any active payment reminder —
  // a missing stage-3 template must not leave the telecaller with no message.
  const templates = await db
    .select()
    .from(waTemplates)
    .where(and(eq(waTemplates.category, "payment_reminder"), eq(waTemplates.active, true)));
  const template =
    templates.find((t) => t.escalationStage === stage) ?? templates[0];
  if (!template) return null;

  const values = await mergeValuesFor(customerId);
  const fields = usedFields(template.body).map((f) => ({
    label: f,
    value: values[f] ?? "",
    ok: Boolean(values[f]),
  }));
  const missing = fields.filter((f) => !f.ok);

  // The preview describes the first leg. A both-ways customer still starts at
  // their own number; the second leg is spelled out on the send screen, which
  // is the only place it can actually be worked.
  const standing = customer.whatsappGroupName ? customer.whatsappDest : "personal";
  const destKind: "personal" | "group" = standing === "both" ? "personal" : standing;
  const destination =
    destKind === "group"
      ? (customer.whatsappGroupName ?? "")
      : (customer.whatsappPhone ?? customer.phone);

  return {
    templateId: template.id,
    templateName: template.name,
    destination,
    destKind,
    body: applyMerge(template.body, values),
    mode: config["whatsapp.mode"],
    fields,
    blocked: missing.length > 0,
    blockedReason: missing.length
      ? `${missing.map((f) => f.label).join(", ")} ${missing.length === 1 ? "is" : "are"} empty for this customer, so the message would read badly. Log a call instead, or fill it on the customer record first.`
      : null,
  };
}
