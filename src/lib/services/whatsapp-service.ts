import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  bills,
  customers,
  followUpAttempts,
  followUpStates,
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
import { longDate } from "../format";
import { recomputeLastContact, today } from "../recompute";
import { err, ok, okVoid, type Result } from "../result";
import { effectiveDueDate } from "../engines/escalation";
import { billCreditDaysSql } from "../bill-terms";
import {
  advancedStatus,
  deliveryRoute,
  resolveWatiParams,
  waNumber,
  type WatiEvent,
} from "../whatsapp-delivery";
import { isApproved, listWatiTemplates, sendWatiTemplate, watiConfig } from "../wati";
import { whatsappServiceState } from "./whatsapp-switch-service";
import { factsFor } from "./wati-facts-service";
import {
  fillBody,
  manualText,
  renderSpec,
  specKey,
  type RenderResult,
} from "../wati-templates";

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
  "last_order_date", "last_order_value", "bill_no", "bill_due",
  /**
   * Every stated, unpaid bill on one line each — "9 Jul 2026 - MMI/25-26/859
   * - ₹59,086" — not only the oldest. A statement that names one bill when
   * four are overdue reads as though the other three do not exist.
   */
  "bills_list",
  /** Today, for a statement's own dateline — "As on 1 Sep 2026". */
  "as_of",
  /**
   * The latest DATED promise, whatever it was about. Worth naming after its
   * own date passes — that is exactly when it becomes a broken promise.
   */
  "promised_amount", "promised_date",
  "owner",
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

  // Every row this customer's outstanding is actually made of, oldest first —
  // the statement's own list, not just the one bill the other fields name.
  const billsList = billRows
    .map(
      ({ bill: b }) =>
        `${longDate(b.billDate)} - ${b.billNo} - ${money(b.amount - b.paidAmount)}`,
    )
    .join("\n");

  const [lastPromise] = await db
    .select({ amount: followUpAttempts.promisedAmount, date: followUpAttempts.promisedDate })
    .from(followUpAttempts)
    .where(
      and(
        eq(followUpAttempts.customerId, customerId),
        sql`${followUpAttempts.promisedDate} is not null`,
      ),
    )
    .orderBy(desc(followUpAttempts.attemptedAt))
    .limit(1);

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
      ? longDate(
          effectiveDueDate(
            {
              id: oldest.id, billNo: oldest.billNo, billDate: oldest.billDate,
              dueDate: oldest.dueDate,
              creditDays: oldestCreditDays === null ? null : Number(oldestCreditDays),
              amount: oldest.amount,
              paid: oldest.paidAmount, disputed: oldest.disputed,
            },
            config,
          ),
        )
      : "",
    bills_list: billsList,
    as_of: longDate(await today()),
    promised_amount: lastPromise?.amount ? money(lastPromise.amount) : "",
    promised_date: lastPromise?.date ? longDate(lastPromise.date) : "",
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
  /**
   * How THIS leg can leave: `automatic` means it may be sent through Wati right
   * now, `manual` means copy, paste and confirm — with `manualWhy` saying why.
   * Worked out per leg, because a both-ways customer's personal leg can go
   * through the API while the group leg never can.
   */
  mode: "manual" | "automatic";
  manualWhy: string | null;
  edited: boolean;
};

/**
 * The two facts every route decision needs that are not about the message:
 * is the founder's switch on, and is there a key. Read once per request.
 */
export async function deliveryContext(): Promise<{ serviceOn: boolean; hasToken: boolean }> {
  const [state, cfg] = await Promise.all([whatsappServiceState(), watiConfig()]);
  return { serviceOn: state.active, hasToken: Boolean(cfg) };
}

function routeFor(
  ctx: { serviceOn: boolean; hasToken: boolean },
  leg: { destKind: "personal" | "group"; watiTemplateName: string | null; edited: boolean },
) {
  const route = deliveryRoute({ ...ctx, ...leg });
  return route.via === "api"
    ? { mode: "automatic" as const, manualWhy: null }
    : { mode: "manual" as const, manualWhy: route.why };
}

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
  const delivery = await deliveryContext();

  const [existing] = await db
    .select()
    .from(waMessages)
    .where(eq(waMessages.idempotencyKey, input.idempotencyKey));
  if (existing) {
    const [linked] = existing.templateId
      ? await db
          .select({ wati: waTemplates.watiTemplateName })
          .from(waTemplates)
          .where(eq(waTemplates.id, existing.templateId))
      : [];
    return ok({
      messageId: existing.id,
      body: existing.body,
      resolvedDestination: existing.resolvedDestination,
      // Stored rows are always one leg; "both" never reaches this column.
      destKind: existing.destKind as "personal" | "group",
      ...routeFor(delivery, {
        destKind: existing.destKind as "personal" | "group",
        watiTemplateName: linked?.wati ?? null,
        edited: existing.edited,
      }),
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

  // A template with a rule set (`wati_spec`) is filled by those rules and
  // nothing else — on the manual route as much as the API one — so a copy
  // pasted by hand says exactly what the API would have sent, and is refused
  // for exactly the same reasons.
  const spec = specOf(template);
  let specFilled: string | null = null;
  if (spec) {
    const rendered = await renderForCustomer(spec, input.customerId);
    if (!rendered.ok) {
      return err(`Not sent to ${customer.name}: ${rendered.reasons.join(" ")}`, "rule_violation");
    }
    specFilled = fillBody(template.body, rendered.params);
  }

  const values = spec ? {} : await mergeValuesFor(input.customerId);
  const sourceBody = input.bodyOverride ?? template.body;

  // Validate BEFORE rendering, and name the specific field.
  const missing = spec ? [] : usedFields(template.body).filter((f) => !values[f]);
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
  const edited = Boolean(
    input.bodyOverride && input.bodyOverride !== (specFilled ?? template.body),
  );
  const route = routeFor(delivery, { destKind, watiTemplateName: template.watiTemplateName, edited });

  let body: string;
  if (specFilled !== null && !edited) {
    // The API sends the approved wording with its buttons; a pasted copy has
    // no buttons, so it gets the wording that asks for a reply instead.
    if (route.mode === "automatic") body = specFilled;
    else {
      const manual = manualText(specFilled);
      if (!manual.ok) return err(manual.reason, "rule_violation");
      body = manual.text;
    }
  } else {
    body = spec ? (input.bodyOverride ?? specFilled ?? "") : applyMerge(sourceBody, values);
  }

  await db.insert(waMessages).values({
    id: messageId,
    customerId: input.customerId,
    templateId: template.id,
    templateName: template.name,
    userId: ctx.user.id,
    // `automatic` is written only when the API actually sends it — see
    // `sendAutomatic`. A prepared row is a manual message until then.
    mode: "manual",
    destKind,
    resolvedDestination,
    body,
    edited,
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
    ...route,
    edited,
  });
}

/* ---------------------------------------------------------- rule-set rendering */

/** Which rule set fills this template: its own, or the one its Wati link names. */
export function specOf(template: { watiSpec: string | null; watiTemplateName: string | null }): string | null {
  return template.watiSpec ?? specKey(template.watiTemplateName);
}

/** Fresh facts, then the rules. `watiParams` is what Wati's approved copy asks for. */
async function renderForCustomer(
  spec: string,
  customerId: string,
  watiParams?: readonly string[],
): Promise<RenderResult> {
  const facts = await factsFor(customerId);
  if (!facts) return { ok: false, reasons: ["That customer no longer exists."] };
  return renderSpec(spec, facts, watiParams);
}

export type MessagePreview =
  | { ok: true; body: string; route: "automatic" | "manual"; manualWhy: string | null }
  | { ok: false; reasons: string[] };

/**
 * Exactly what this customer would receive from this template right now, on
 * the route it would take — or every reason it would be refused. Nothing is
 * written. The send screen, the payment panel and the founder's preview all
 * read this, so what somebody sees before pressing Send is what goes.
 */
export async function previewMessage(
  customerId: string,
  templateId: string,
  destKind: "personal" | "group" = "personal",
  /** Only for a caller that has already checked the founder's desk. */
  opts: { skipScope?: boolean } = {},
): Promise<MessagePreview> {
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!customer) return { ok: false, reasons: ["That customer no longer exists."] };
  if (!opts.skipScope) await assertCustomerInScope(customer);
  const [template] = await db.select().from(waTemplates).where(eq(waTemplates.id, templateId));
  if (!template) return { ok: false, reasons: ["That template no longer exists."] };
  if (customer.doNotContact) return { ok: false, reasons: [`${customer.name} is marked do not contact.`] };

  const delivery = await deliveryContext();
  const route = routeFor(delivery, { destKind, watiTemplateName: template.watiTemplateName, edited: false });
  const spec = specOf(template);
  if (!spec) {
    const values = await mergeValuesFor(customerId);
    const missing = usedFields(template.body).filter((f) => !values[f]);
    if (missing.length) return { ok: false, reasons: [`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} empty for this customer.`] };
    return { ok: true, body: applyMerge(template.body, values), route: route.mode, manualWhy: route.manualWhy };
  }
  const rendered = await renderForCustomer(spec, customerId);
  if (!rendered.ok) return { ok: false, reasons: rendered.reasons };
  const filled = fillBody(template.body, rendered.params);
  if (route.mode === "automatic") return { ok: true, body: filled, route: "automatic", manualWhy: null };
  const manual = manualText(filled);
  return manual.ok
    ? { ok: true, body: manual.text, route: "manual", manualWhy: route.manualWhy }
    : { ok: false, reasons: [manual.reason, route.manualWhy ?? ""].filter(Boolean) };
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
 * A PAYMENT REMINDER THAT WENT IS A FOLLOW-UP ATTEMPT, and nothing recorded one.
 *
 * The collections plan dates the next stage-1 nudge from the newest
 * `follow_up_attempts` row on the WhatsApp channel ("every four days, counted
 * from the last one actually sent"), and no path that sends a reminder ever
 * wrote that row — so a customer at stage 1 came back due every single day. It
 * is written here, once a message is actually sent (confirmed by hand or
 * accepted by Wati), keyed on the message so a repeat confirmation adds
 * nothing. Only for a payment reminder, and only for a customer who is on the
 * collections worklist at all; anything else is not a collections attempt.
 */
async function recordReminderAttempt(messageId: string, userId: string): Promise<void> {
  const [row] = await db
    .select({ customerId: waMessages.customerId, category: waTemplates.category })
    .from(waMessages)
    .innerJoin(waTemplates, eq(waTemplates.id, waMessages.templateId))
    .where(eq(waMessages.id, messageId));
  if (!row || row.category !== "payment_reminder") return;

  const [state] = await db
    .select({ stage: followUpStates.stage })
    .from(followUpStates)
    .where(eq(followUpStates.customerId, row.customerId));
  if (!state) return;

  const now = new Date();
  const inserted = await db
    .insert(followUpAttempts)
    .values({
      id: id("fua"),
      customerId: row.customerId,
      stage: state.stage,
      channel: "whatsapp",
      attemptedAt: now,
      userId,
      outcome: "Payment reminder sent on WhatsApp",
      idempotencyKey: `wa:${messageId}`,
      createdById: userId,
    })
    .onConflictDoNothing()
    .returning({ id: followUpAttempts.id });
  if (!inserted.length) return;

  await db
    .update(followUpStates)
    .set({ lastChannel: "whatsapp", lastFollowUpAt: now, updatedAt: now })
    .where(eq(followUpStates.customerId, row.customerId));
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
  await recordReminderAttempt(messageId, ctx.user.id);
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
 * SENDS ONE PREPARED MESSAGE THROUGH WATI — and refuses, saying why, whenever
 * any condition for that is not met.
 *
 * This used to be a stub that marked the message `sent` and stamped the
 * customer as messaged WITHOUT CALLING ANYTHING, so switching the mode to
 * automatic would have silently taken customers off the Call Log on the
 * strength of messages that never left. It now sends, or it says no.
 *
 * In order, every one a refusal that sends nothing:
 *   the founder's switch is on · a key is configured · the message is still
 *   unsent · it is the personal leg, unedited, of a template linked to an
 *   APPROVED Wati template · the customer is not do-not-contact · the number is
 *   a real Indian mobile and not a placeholder shared by several shops · the
 *   weekly limit is not reached · every variable the template needs has a value.
 *
 * The customer is stamped as messaged only when Wati ACCEPTS the message. A
 * failure reported later by webhook takes the stamp back (`applyWatiEvent`).
 */
export async function sendAutomatic(messageId: string): Promise<Result> {
  const ctx = await resolveScope();
  const config = await getConfig();
  const delivery = await deliveryContext();

  const [message] = await db.select().from(waMessages).where(eq(waMessages.id, messageId));
  if (!message) return err("That message no longer exists.", "not_found");
  if (!["prepared", "copied", "failed"].includes(message.status)) {
    return err(`This message is already ${message.status.replace("_", " ")}.`, "conflict");
  }

  const [customer] = await db.select().from(customers).where(eq(customers.id, message.customerId));
  if (!customer) return err("That customer no longer exists.", "not_found");
  await assertCustomerInScope(customer);
  if (customer.doNotContact) return err(`${customer.name} is marked do not contact.`, "rule_violation");

  const [template] = message.templateId
    ? await db.select().from(waTemplates).where(eq(waTemplates.id, message.templateId))
    : [];
  const route = deliveryRoute({
    ...delivery,
    destKind: message.destKind as "personal" | "group",
    watiTemplateName: template?.watiTemplateName ?? null,
    edited: message.edited,
  });
  if (route.via !== "api") return err(route.why, "rule_violation");
  const watiName = template!.watiTemplateName!;

  const phone = waNumber(message.resolvedDestination);
  if (!phone) {
    return err(
      `${message.resolvedDestination || "The number on file"} is not a mobile WhatsApp can reach. Fix it on the customer record.`,
      "validation",
    );
  }

  // A number on three or more shops is a placeholder somebody typed into an
  // import, not a person. Sending a payment reminder to it tells a stranger —
  // or every shop sharing it — what this customer owes.
  const last10 = phone.slice(-10);
  const [shared] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from customers c
    where right(regexp_replace(coalesce(c.whatsapp_phone, c.phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
  `);
  if (Number(shared?.n ?? 0) >= 3) {
    return err(
      `That number is on ${shared!.n} customers, so it looks like a placeholder rather than ${customer.name}'s own. Put the real number on the record first.`,
      "rule_violation",
    );
  }

  // `whatsapp.contactsPerWeekLimit` was configurable for a long time and read
  // by nothing. Enforced here, on the API route: a person pasting by hand is
  // exercising judgement, a button that sends is not. Zero means no limit.
  const limit = config["whatsapp.contactsPerWeekLimit"];
  if (limit > 0) {
    const [week] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from wa_messages m
      where m.customer_id = ${message.customerId}
        and m.status in ('sent_manually','sent','delivered','read')
        and coalesce(m.confirmed_sent_at, m.sent_at) > now() - interval '7 days'
    `);
    if (Number(week?.n ?? 0) >= limit) {
      return err(
        `${customer.name} has already had ${week!.n} WhatsApp message${Number(week!.n) === 1 ? "" : "s"} this week — the limit is ${limit}.`,
        "rule_violation",
      );
    }
  }

  const listed = await listWatiTemplates();
  if (!listed.ok) return err(`Could not reach Wati: ${listed.error}`, "rule_violation");
  const wati = listed.templates.find((t) => t.name === watiName);
  if (!wati || !isApproved(wati)) {
    return err(
      `The Wati template "${watiName}" is ${wati ? wati.status.toLowerCase() : "missing"} — it can only go the manual way until it is approved again.`,
      "rule_violation",
    );
  }
  // The variables are rebuilt HERE, from facts read now — not taken from
  // whatever was true when the message was prepared. A payment confirmed in
  // between changes the bill list, and the customer must see today's.
  let params: Array<{ name: string; value: string }>;
  let sentBody: string | null = null;
  const spec = specOf(template!);
  if (spec) {
    const rendered = await renderForCustomer(spec, message.customerId, wati.params);
    if (!rendered.ok) return err(`Not sent: ${rendered.reasons.join(" ")}`, "rule_violation");
    params = rendered.params;
    sentBody = fillBody(wati.body || template!.body, params);
  } else {
    const values = await mergeValuesFor(message.customerId);
    const resolved = resolveWatiParams(wati.params, values, MERGE_FIELDS);
    if (resolved.unknown.length) {
      return err(
        `The Wati template uses ${resolved.unknown.map((n) => `{{${n}}}`).join(", ")}, which MahekOne has no field for. Rename ${resolved.unknown.length === 1 ? "it" : "them"} in Wati to one of: ${MERGE_FIELDS.join(", ")}.`,
        "validation",
      );
    }
    if (resolved.missing.length) {
      return err(
        `This message cannot be built for ${customer.name}: ${resolved.missing.join(", ")} ${resolved.missing.length === 1 ? "is" : "are"} empty.`,
        "validation",
      );
    }
    params = resolved.params;
  }

  // CLAIM it before calling out. Two clicks, or a click racing a bulk run,
  // must not send one message twice: only the request that moves it to
  // `queued` goes on to call Wati.
  const claimed = await db
    .update(waMessages)
    .set({ status: "queued", failureReason: null, updatedAt: new Date(), updatedById: ctx.user.id })
    .where(and(eq(waMessages.id, messageId), inArray(waMessages.status, ["prepared", "copied", "failed"])))
    .returning({ id: waMessages.id });
  if (!claimed.length) return err("This message is already being sent.", "conflict");

  const day = await today();
  const sent = await sendWatiTemplate({
    templateName: watiName,
    phone,
    params,
    localMessageId: messageId,
    broadcastName: `mahekone_${watiName}_${day}`,
  });

  if (!sent.ok) {
    const reason = sent.uncertain
      ? `${sent.error} It may or may not have gone — check the chat in Wati before sending again.`
      : sent.error;
    await db
      .update(waMessages)
      .set({ status: "failed", mode: "automatic", failureReason: reason, updatedAt: new Date() })
      .where(eq(waMessages.id, messageId));
    return err(`Not sent: ${reason}`, "rule_violation");
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(waMessages)
      .set({
        status: "sent",
        mode: "automatic",
        // The log shows what the customer actually received.
        ...(sentBody ? { body: sentBody } : {}),
        sentAt: now,
        // Last contact reads this column; an API send IS a confirmed send.
        confirmedSentAt: now,
        updatedAt: now,
      })
      .where(eq(waMessages.id, messageId));
    await tx
      .update(customers)
      .set({ lastConfirmedWhatsappDate: day, updatedAt: now })
      .where(eq(customers.id, message.customerId));
    await tx
      .update(waTemplates)
      .set({ usageCount: sql`${waTemplates.usageCount} + 1` })
      .where(eq(waTemplates.id, template!.id));
    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "whatsapp.sent_api",
      entityType: "wa_message",
      entityId: messageId,
      afterState: { customerId: message.customerId, watiTemplate: watiName, broadcastId: sent.broadcastId } as never,
    });
  });

  await recomputeLastContact(message.customerId);
  await recordReminderAttempt(messageId, ctx.user.id);
  return okVoid(`Sent to ${customer.name} on WhatsApp`);
}

/**
 * Prepare and send in one step — the button a telecaller presses when the
 * message can go through the API. One personal leg only: a group leg can never
 * go this way, and a both-ways customer is worked leg by leg on the send screen.
 */
export async function sendNow(input: {
  customerId: string;
  templateId: string;
  idempotencyKey: string;
}): Promise<Result<{ messageId: string }>> {
  const prepared = await prepareMessage({ ...input, destKind: "personal" });
  if (!prepared.ok) return prepared;
  if (prepared.data.mode !== "automatic") {
    return err(prepared.data.manualWhy ?? "This message has to be sent the manual way.", "rule_violation");
  }
  const sent = await sendAutomatic(prepared.data.messageId);
  if (!sent.ok) return sent;
  return ok({ messageId: prepared.data.messageId }, sent.message);
}

/**
 * Sends every personal message still waiting in a run through the API, one at
 * a time, and leaves the rest — groups, and anything refused — for the manual
 * run exactly as before. Refusals are counted and the first few are named,
 * because "12 not sent" with no reason is a number nobody can act on.
 */
export async function sendRunViaApi(
  runId: string,
): Promise<Result<{ sent: number; left: number; problems: string[] }>> {
  await requireCapability("whatsapp.bulk");
  const delivery = await deliveryContext();
  if (!delivery.serviceOn) return err("WhatsApp sending is switched off on the Founder Dashboard.", "rule_violation");
  if (!delivery.hasToken) return err("No Wati key is configured.", "rule_violation");

  const waiting = await db
    .select({ id: waMessages.id, customerName: customers.name })
    .from(waMessages)
    .innerJoin(customers, eq(customers.id, waMessages.customerId))
    .where(
      and(
        eq(waMessages.runId, runId),
        eq(waMessages.destKind, "personal"),
        inArray(waMessages.status, ["prepared", "copied"]),
      ),
    )
    .orderBy(asc(waMessages.preparedAt));

  let sent = 0;
  const problems: string[] = [];
  for (const m of waiting) {
    const r = await sendAutomatic(m.id);
    if (r.ok) sent++;
    else problems.push(`${m.customerName}: ${r.error}`);
  }

  const state = await getRun(runId);
  if (state) {
    await db
      .update(waRuns)
      .set({
        sentCount: state.sent,
        skippedCount: state.skipped,
        ...(state.current ? {} : { status: "completed" as const, completedAt: new Date() }),
      })
      .where(eq(waRuns.id, runId));
  }

  const left = state?.recipients.filter((r) => !r.done).length ?? 0;
  return ok(
    { sent, left, problems },
    `${sent} sent through WhatsApp${left ? ` · ${left} left for the manual run` : ""}`,
  );
}

/* ------------------------------------------------------------ webhooks in */

/**
 * The customer's last-WhatsApp date, rebuilt from the messages that actually
 * went. Needed the moment a send can be taken back — a message Wati accepted
 * and WhatsApp then failed to deliver must stop holding the customer off the
 * Call Log.
 */
async function recomputeLastWhatsapp(customerId: string): Promise<void> {
  await db.execute(sql`
    update customers c set last_confirmed_whatsapp_date = (
      select max((coalesce(m.confirmed_sent_at, m.sent_at) at time zone 'Asia/Kolkata')::date)
      from wa_messages m
      where m.customer_id = c.id
        and m.status in ('sent_manually','sent','delivered','read')
    ), updated_at = now()
    where c.id = ${customerId}
  `);
  await recomputeLastContact(customerId);
}

/**
 * One webhook event from Wati, applied. Idempotent: Wati retries, and every
 * status only moves forward (`advancedStatus`), so a repeat changes nothing.
 * Returns what it did, for the route's log line.
 */
export async function applyWatiEvent(event: WatiEvent): Promise<string> {
  if (event.kind === "ignored") return `ignored: ${event.why}`;

  if (event.kind === "reply") {
    const last10 = event.waId.replace(/\D/g, "").slice(-10);
    const [match] = await db.execute<{ id: string }>(sql`
      select c.id from customers c
      where right(regexp_replace(coalesce(c.whatsapp_phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
         or right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
      order by (c.kind = 'customer') desc, c.updated_at desc
      limit 1
    `);
    const inserted = await db
      .insert(waReplies)
      .values({
        id: id("war"),
        customerId: match?.id ?? null,
        message: event.text.slice(0, 4000),
        waId: event.waId,
        senderName: event.senderName,
        providerMessageId: event.providerMessageId,
      })
      .onConflictDoNothing()
      .returning({ id: waReplies.id });
    return inserted.length ? `reply stored${match ? "" : " (no matching customer)"}` : "reply already stored";
  }

  const [message] = await db
    .select()
    .from(waMessages)
    .where(eq(waMessages.id, event.localMessageId));
  if (!message) return `no message ${event.localMessageId}`;

  const next = advancedStatus(message.status, event.kind);
  if (!next) return `${event.kind} ignored at ${message.status}`;

  const now = new Date();
  await db
    .update(waMessages)
    .set({
      status: next as never,
      providerRef: event.providerRef ?? message.providerRef,
      ...(next === "delivered" ? { deliveredAt: now } : {}),
      ...(next === "read" ? { readAt: now, deliveredAt: message.deliveredAt ?? now } : {}),
      ...(event.kind === "failed" ? { failureReason: event.reason } : {}),
      updatedAt: now,
    })
    .where(eq(waMessages.id, message.id));

  if (next === "failed") await recomputeLastWhatsapp(message.customerId);
  return `${message.status} -> ${next}`;
}

/* ------------------------------------------------------------------- lists */

/**
 * How many messages one read of the log may carry.
 *
 * Named, because the screen has to say what it is showing part of and a number
 * typed into a screen beside a number typed into a query is two answers to one
 * question.
 */
export const WA_MESSAGE_LIMIT = 300;

type MessageFilters = { status?: string; mode?: string; customerId?: string };

/** The scope and the filters, once, so the list and the count cannot disagree. */
function messageWhere(ids: string[] | null, filters?: MessageFilters) {
  return and(
    ids ? inArray(waMessages.userId, ids) : undefined,
    filters?.status ? eq(waMessages.status, filters.status as never) : undefined,
    filters?.mode ? eq(waMessages.mode, filters.mode as never) : undefined,
    filters?.customerId ? eq(waMessages.customerId, filters.customerId) : undefined,
  );
}

/**
 * How many there are, as against how many we fetched.
 *
 * `count(*)` over the same scope and the same filters the list runs. The log
 * printed "Showing 300 messages" on a book with several thousand, which is a
 * capped read presenting itself as a total — the thing the customer record was
 * rebuilt to stop doing. A count that came from `rows.length` would only ever
 * be able to report the cap back to itself.
 */
export async function messageCount(filters?: MessageFilters): Promise<number> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);

  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(waMessages)
    .where(messageWhere(ids, filters));

  return Number(row?.n ?? 0);
}

export async function listMessages(filters?: MessageFilters) {
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
    .where(messageWhere(ids, filters))
    .orderBy(desc(waMessages.preparedAt))
    .limit(WA_MESSAGE_LIMIT);

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
  // The inner join already drops replies from numbers the book does not know;
  // those are listed on the Founder Dashboard's WhatsApp screen instead.
  return rows.map(({ reply, customerName }) => ({
    ...reply,
    customerId: reply.customerId as string,
    customerName,
  }));
}

/** Replies from numbers matching no customer — kept, and shown, never dropped. */
export async function listUnmatchedReplies(limit = 50) {
  return db
    .select()
    .from(waReplies)
    .where(isNull(waReplies.customerId))
    .orderBy(desc(waReplies.receivedAt))
    .limit(limit);
}

/** What the API has sent in the last N days, by where it has got to. */
export async function apiSendCounts(days = 7): Promise<Record<string, number>> {
  const rows = await db.execute<{ status: string; n: number }>(sql`
    select m.status, count(*)::int as n from wa_messages m
    where m.mode = 'automatic' and m.updated_at > now() - make_interval(days => ${days}::int)
    group by m.status
  `);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
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
  const delivery = await deliveryContext();
  const [template] = await db.select().from(waTemplates).where(eq(waTemplates.id, input.templateId));

  if (!input.customerIds.length) {
    return err("Nobody matches that filter today.", "validation");
  }

  const runId = id("run");
  await db.insert(waRuns).values({
    id: runId,
    userId: ctx.user.id,
    templateId: input.templateId,
    // What the run CAN do when it starts: its personal legs through the API.
    // Groups in it are still worked by hand either way.
    mode: routeFor(delivery, {
      destKind: "personal",
      watiTemplateName: template?.watiTemplateName ?? null,
      edited: false,
    }).mode,
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
  /** Why it cannot go through the API, when `mode` is manual. */
  manualWhy: string | null;
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
  const delivery = await deliveryContext();
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

  // A rule-set template is previewed by the same rules that will send it. Its
  // "fields" are the reasons it cannot go, if any — there is nothing for a
  // telecaller to fill in, and a list of merge fields would suggest otherwise.
  const standingLeg = customer.whatsappGroupName ? customer.whatsappDest : "personal";
  const legKind: "personal" | "group" = standingLeg === "both" ? "personal" : standingLeg;
  if (specOf(template)) {
    const p = await previewMessage(customerId, template.id, legKind);
    const route = routeFor(delivery, { destKind: legKind, watiTemplateName: template.watiTemplateName, edited: false });
    return {
      templateId: template.id,
      templateName: template.name,
      destination:
        legKind === "group" ? (customer.whatsappGroupName ?? "") : (customer.whatsappPhone ?? customer.phone),
      destKind: legKind,
      body: p.ok ? p.body : "",
      ...route,
      fields: [],
      blocked: !p.ok,
      blockedReason: p.ok ? null : p.reasons.join(" "),
    };
  }

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
    ...routeFor(delivery, { destKind, watiTemplateName: template.watiTemplateName, edited: false }),
    fields,
    blocked: missing.length > 0,
    blockedReason: missing.length
      ? `${missing.map((f) => f.label).join(", ")} ${missing.length === 1 ? "is" : "are"} empty for this customer, so the message would read badly. Log a call instead, or fill it on the customer record first.`
      : null,
  };
}

/* ------------------------------------------------------------ test sends */

/**
 * The real template, filled from a real customer's facts, sent to a number
 * that is NOT the customer's — the founder's own phone, to see exactly what a
 * customer would receive before anything is switched on.
 *
 * Deliberately NOT gated by the service switch: the switch is about messages
 * to customers, and this is how somebody decides whether to flip it. Nothing
 * is written against the customer — no message row, no contact date — and the
 * send is audited with the number it went to.
 */
export async function sendTestMessage(input: {
  customerId: string;
  templateId: string;
  phone: string;
  userId: string;
}): Promise<Result<{ body: string }>> {
  const phone = waNumber(input.phone);
  if (!phone) return err("That is not a mobile number WhatsApp can reach.", "validation");

  const [template] = await db.select().from(waTemplates).where(eq(waTemplates.id, input.templateId));
  if (!template) return err("That template no longer exists.", "not_found");
  if (!template.watiTemplateName) {
    return err("Link this template to an approved Wati template first.", "rule_violation");
  }
  const listed = await listWatiTemplates({ fresh: true });
  if (!listed.ok) return err(`Could not reach Wati: ${listed.error}`, "rule_violation");
  const wati = listed.templates.find((t) => t.name === template.watiTemplateName);
  if (!wati || !isApproved(wati)) {
    return err(`"${template.watiTemplateName}" is not approved in Wati yet.`, "rule_violation");
  }

  const spec = specOf(template);
  if (!spec) return err("Test sends are for the templates that follow a rule set.", "rule_violation");
  const rendered = await renderForCustomer(spec, input.customerId, wati.params);
  if (!rendered.ok) return err(`This customer would not be sent it: ${rendered.reasons.join(" ")}`, "rule_violation");

  const sent = await sendWatiTemplate({
    templateName: wati.name,
    phone,
    params: rendered.params,
    localMessageId: id("test"),
    broadcastName: `mahekone_test_${wati.name}`,
  });
  await db.insert(auditLog).values({
    id: id("aud"),
    actorId: input.userId,
    action: "whatsapp.test_send",
    entityType: "wa_template",
    entityId: template.id,
    afterState: { customerId: input.customerId, to: phone, ok: sent.ok, error: sent.ok ? null : sent.error } as never,
  });
  if (!sent.ok) return err(`Wati did not send it: ${sent.error}`, "rule_violation");
  return ok({ body: fillBody(wati.body || template.body, rendered.params) }, `Test sent to +${phone}`);
}

/** Customers by name, for the founder's preview box. */
export async function findCustomersByName(q: string) {
  const term = q.trim();
  if (term.length < 2) return [];
  return db
    .select({ id: customers.id, name: customers.name, city: customers.city })
    .from(customers)
    .where(sql`${customers.name} ilike ${"%" + term.replace(/[%_]/g, "") + "%"}`)
    .orderBy(asc(customers.name))
    .limit(10);
}
