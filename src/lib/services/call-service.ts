import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  calls,
  complaints,
  complaintStatusHistory,
  customers,
  orders,
  reminders,
  waMessages,
} from "@/db/schema";
import { resolveScope, assertCustomerInScope } from "../access-control";
import { getConfig } from "../config/store";
import {
  recomputeBuyingCycle,
  recomputeFollowUpState,
  recomputeInactivity,
  recomputeLastContact,
  today,
} from "../recompute";
import { onOrAfterWorkingDay } from "../business-date";
import { err, ok, type Result } from "../result";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ---------------------------------------------------------------------------
 * Call logging.
 *
 * One transaction covers the call and everything it produced. Half-saved calls
 * are how telecaller data goes wrong.
 * ------------------------------------------------------------------------- */

export const logCallSchema = z.object({
  customerId: z.string().min(1),
  direction: z.enum(["outbound", "inbound"]).default("outbound"),
  connectionStatus: z.enum([
    "connected",
    "no_answer",
    "busy",
    "switched_off",
    "wrong_number",
  ]),
  outcome: z
    .enum([
      "order_placed",
      "will_order_later",
      "no_requirement_now",
      "payment_promised",
      "payment_dispute",
      "complaint_raised",
      "not_reachable",
      "call_back_requested",
      "refused",
    ])
    .nullable()
    .optional(),
  notes: z.string().optional(),
  durationSeconds: z.number().int().min(0).optional(),
  sourceModule: z
    .enum(["call_queue", "payment_follow_up", "inactive_watch", "ad_hoc"])
    .default("ad_hoc"),

  order: z
    .object({
      product: z.string().min(1),
      quantity: z.coerce.number().int().min(1).default(1),
      /** Paise. */
      totalAmount: z.number().int().positive(),
      expectedDispatch: z.string().optional(),
    })
    .optional(),

  reminder: z
    .object({
      dueDate: z.string().min(1),
      note: z.string().min(1, "Write what was promised."),
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
    })
    .optional(),

  complaint: z
    .object({
      category: z.enum([
        "delivery",
        "product_quality",
        "billing",
        "pricing",
        "service",
        "shortage",
        "packaging",
        "other",
      ]),
      description: z.string().min(1, "Describe the complaint."),
      severity: z.enum(["low", "medium", "high"]).default("medium"),
      /** Whoever actually reported it — not always the main number on file. */
      mobileNumber: z.string().optional(),
      /* A credit-note request raised alongside the complaint. */
      requestCn: z.boolean().optional(),
      billId: z.string().nullish(),
      goodsDescription: z.string().optional(),
    })
    .optional(),

  /** Telecallers double-click; a duplicate call corrupts the EOD figures. */
  idempotencyKey: z.string().min(8),
});

export type LogCallInput = z.input<typeof logCallSchema>;

export type LogCallResult = {
  callId: string;
  produced: string[];
  duplicate: boolean;
  /** Set when the call raised a complaint, so images can be attached to it. */
  complaintId: string | null;
};

export async function logCall(raw: LogCallInput): Promise<Result<LogCallResult>> {
  const parsed = logCallSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(issue.message, "validation", [
      { field: issue.path.join("."), message: issue.message },
    ]);
  }
  const input = parsed.data;

  const ctx = await resolveScope();
  const config = await getConfig();
  const day = await today();

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, input.customerId));
  if (!customer) return err("That customer no longer exists.", "not_found");
  await assertCustomerInScope(customer.ownerId);

  // Idempotency: a repeat submission returns the original result rather than
  // creating a second call.
  const [existing] = await db
    .select({ id: calls.id, complaintId: calls.complaintId })
    .from(calls)
    .where(eq(calls.idempotencyKey, input.idempotencyKey));
  if (existing) {
    return ok(
      { callId: existing.id, produced: [], duplicate: true, complaintId: existing.complaintId },
      "Already logged",
    );
  }

  const callId = id("call");
  let raisedComplaintId: string | null = null;
  const produced: string[] = [];
  const now = new Date();

  await db.transaction(async (tx) => {
    let orderId: string | null = null;
    let reminderId: string | null = null;
    let complaintId: string | null = null;

    if (input.order) {
      orderId = id("ord");
      await tx.insert(orders).values({
        id: orderId,
        customerId: customer.id,
        userId: ctx.user.id,
        source: "crm",
        orderedAt: now,
        totalAmount: input.order.totalAmount,
        status: "captured",
        callId,
        expectedDispatch: input.order.expectedDispatch || null,
        lineItems: [
          {
            product: input.order.product,
            quantity: input.order.quantity,
            unitPrice: Math.round(input.order.totalAmount / input.order.quantity),
            amount: input.order.totalAmount,
          },
        ],
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      produced.push("order");
    }

    if (input.reminder) {
      reminderId = id("rem");
      // A reminder landing on a non-working day is no use to anyone.
      const due = config["reminders.rollForwardOnNonWorkingDays"]
        ? onOrAfterWorkingDay(input.reminder.dueDate, {
            timezone: config["workingDay.timezone"],
            dayBoundaryHour: config["workingDay.dayBoundaryHour"],
            workingDays: config["workingDay.workingDays"],
          })
        : input.reminder.dueDate;

      await tx.insert(reminders).values({
        id: reminderId,
        customerId: customer.id,
        createdByUserId: ctx.user.id,
        assignedUserId: ctx.user.id,
        callId,
        dueDate: due,
        note: input.reminder.note,
        type: input.reminder.type,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      produced.push("reminder");
    }

    if (input.complaint) {
      complaintId = id("cmp");
      const slaHours = config["complaints.slaHours"][input.complaint.severity];
      await tx.insert(complaints).values({
        id: complaintId,
        customerId: customer.id,
        loggedByUserId: ctx.user.id,
        callId,
        category: input.complaint.category,
        description: input.complaint.description,
        severity: input.complaint.severity,
        slaDueAt: new Date(now.getTime() + slaHours * 3_600_000),
        mobileNumber: input.complaint.mobileNumber?.trim() || null,
        requestCn: input.complaint.requestCn ?? false,
        // The bill is only meaningful when a credit note was actually asked for.
        billId: input.complaint.requestCn ? (input.complaint.billId ?? null) : null,
        goodsDescription: input.complaint.requestCn
          ? input.complaint.goodsDescription?.trim() || null
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
        note: `Logged during a call by ${ctx.user.name}`,
      });
      raisedComplaintId = complaintId;
      produced.push("complaint");
    }

    await tx.insert(calls).values({
      id: callId,
      customerId: customer.id,
      userId: ctx.user.id,
      direction: input.direction,
      startedAt: now,
      durationSeconds: input.durationSeconds ?? null,
      connectionStatus: input.connectionStatus,
      outcome: input.outcome ?? null,
      notes: input.notes?.trim() || null,
      sourceModule: input.sourceModule,
      orderId,
      reminderId,
      complaintId,
      idempotencyKey: input.idempotencyKey,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "call.log",
      entityType: "call",
      entityId: callId,
      afterState: {
        customerId: customer.id,
        connectionStatus: input.connectionStatus,
        outcome: input.outcome ?? null,
        produced,
      } as never,
    });
  });

  // Derived values follow the write, never precede it.
  await recomputeLastContact(customer.id);
  if (input.order) {
    await recomputeBuyingCycle(customer.id);
    await recomputeInactivity();
    await db
      .update(customers)
      .set({ lastOrderDate: day, lastOrderValue: input.order.totalAmount })
      .where(eq(customers.id, customer.id));
  }
  if (input.outcome === "payment_promised" || input.outcome === "payment_dispute") {
    await recomputeFollowUpState(customer.id);
  }

  return ok(
    { callId, produced, duplicate: false, complaintId: raisedComplaintId },
    "Call saved",
  );
}

/* --------------------------------------------------------- merged history */

export type HistoryEntry = {
  id: string;
  kind: "call" | "whatsapp";
  at: string;
  actor: string;
  summary: string;
  detail: string | null;
};

/** Calls and WhatsApp messages as one stream, newest first. */
export async function customerHistory(
  customerId: string,
  limit = 100,
): Promise<HistoryEntry[]> {
  const rows = await db.execute<{
    id: string;
    kind: "call" | "whatsapp";
    at: Date;
    actor: string;
    summary: string;
    detail: string | null;
  }>(sql`
    select c.id, 'call' as kind, c.started_at as at, u.name as actor,
           concat_ws(' · ', c.connection_status, c.outcome) as summary,
           c.notes as detail
      from calls c join users u on u.id = c.user_id
     where c.customer_id = ${customerId}
    union all
    select m.id, 'whatsapp', coalesce(m.confirmed_sent_at, m.sent_at, m.prepared_at),
           u.name, coalesce(m.template_name, 'WhatsApp message'),
           concat_ws(' · ', m.resolved_destination, m.status)
      from wa_messages m join users u on u.id = m.user_id
     where m.customer_id = ${customerId}
       and m.status in ('sent_manually','sent','delivered','read')
    order by at desc
    limit ${limit}
  `);

  return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
}

/* ------------------------------------------------------- handover summary */

export type Handover = {
  customerName: string;
  lastThree: HistoryEntry[];
  lastPromise: string | null;
  openCommitments: Array<{ note: string; dueDate: string }>;
  openComplaint: string | null;
  followUpStage: number | null;
  /** Copyable, for pasting into a chat when passing a customer over. */
  text: string;
};

export async function handoverSummary(customerId: string): Promise<Handover | null> {
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!customer) return null;
  await assertCustomerInScope(customer.ownerId);

  const history = await customerHistory(customerId, 3);

  const commitments = await db
    .select({ note: reminders.note, dueDate: reminders.dueDate })
    .from(reminders)
    .where(and(eq(reminders.customerId, customerId), eq(reminders.status, "pending")))
    .orderBy(reminders.dueDate);

  const [complaint] = await db
    .select({ description: complaints.description })
    .from(complaints)
    .where(
      and(
        eq(complaints.customerId, customerId),
        inArray(complaints.status, ["open", "in_progress", "awaiting_customer"]),
      ),
    )
    .limit(1);

  const [lastNote] = await db
    .select({ notes: calls.notes })
    .from(calls)
    .where(and(eq(calls.customerId, customerId), sql`${calls.notes} is not null`))
    .orderBy(desc(calls.startedAt))
    .limit(1);

  const text = [
    `*Handover — ${customer.name}*`,
    `${customer.contactPerson} · ${customer.phone}`,
    "",
    "Last three interactions:",
    ...history.map((h) => `· ${h.at.slice(0, 10)} ${h.summary}: ${h.detail ?? "no note"}`),
    "",
    `Last thing promised: ${lastNote?.notes ?? "nothing recorded"}`,
    "",
    commitments.length
      ? `Open commitments:\n${commitments.map((c) => `· ${c.note} (due ${c.dueDate})`).join("\n")}`
      : "Open commitments: none",
    complaint ? `\nOpen complaint: ${complaint.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    customerName: customer.name,
    lastThree: history,
    lastPromise: lastNote?.notes ?? null,
    openCommitments: commitments,
    openComplaint: complaint?.description ?? null,
    followUpStage: null,
    text,
  };
}

export { waMessages };
