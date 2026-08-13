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
  followUpAttempts,
  followUpStates,
  interactionProductLines,
  orders,
  products,
  quickNotes,
  reminders,
} from "@/db/schema";
import { OUTCOMES_BY_TYPE, type InteractionTypeKey, type OutcomeKey } from "@/db/catalogue";
import { assignedUserId, resolveScope, assertCustomerInScope } from "../access-control";
import { getConfig } from "../config/store";
import {
  recomputeBuyingCycle,
  recomputeFollowUpState,
  recomputeInactivity,
  recomputeOutstanding,
  today,
} from "../recompute";
import { isAttemptAllowed } from "../engines/escalation";
import type { NextStep, NextStepKind } from "../engines/next-step";
import { nextStepForCustomer } from "./queue-service";
import { addDays, onOrAfterWorkingDay } from "../business-date";
import { err, ok, type Result } from "../result";
import { CRM_EVENT, callTimelineSummary, writeTimelineEvents } from "../timeline";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ---------------------------------------------------------------------------
 * The save operation. One entry point for all thirteen workflows.
 *
 * The module logs INTERACTIONS, not calls. A record may be an outbound call,
 * an inbound call, or an order that arrived with nobody speaking to anybody.
 * That last one is the hazard: counted naively it inflates calls attempted,
 * the connect rate and every per-call conversion figure — so it is excluded
 * from all of them, here and in the EOD aggregator.
 *
 * Everything is one transaction. Half-saved interactions are how telecaller
 * data goes wrong.
 * ------------------------------------------------------------------------- */

export const saveInteractionSchema = z.object({
  customerId: z.string().min(1),
  interactionType: z.enum(["outbound_call", "inbound_call", "order_received"]),
  outcome: z
    .enum([
      "order_taken",
      "no_order",
      "no_answer",
      "payment_promised",
      "follow_up",
      "not_interested",
      "complaint",
      "transport_follow_up",
      "casual_talk",
    ])
    .nullish(),

  notes: z.string().optional(),
  /** References, not just the merged text — this is what makes them analysable. */
  quickNoteIds: z.array(z.string()).default([]),

  /** Product id → quantity. Zero and blank are dropped, never stored. */
  productQuantities: z.record(z.string(), z.coerce.number()).default({}),

  followUpDate: z.string().optional(),

  /*
   * NO ORDER HAS TO END WITH A DATE, or with somebody saying there isn't one.
   *
   * "No order today" is the most common answer on the phone and it used to
   * end the call with nothing: the customer dropped into a flat cooldown and
   * came back when a number said so, whatever they had actually said. A
   * customer who says "call me after Diwali" and one who says nothing at all
   * were treated identically, and the first is the one worth getting right —
   * ringing them early is the call that annoys, and ringing them late is the
   * order that goes somewhere else.
   *
   * So it is asked, and answering is mandatory. A date becomes a reminder,
   * which already outranks every cooldown in the queue engine, so the call
   * lands on the day the customer named. No date means the customer would not
   * commit, and only then does the `no_order` cooldown decide.
   *
   * The two are separate fields rather than a nullable date because "they
   * said the 20th" and "they would not say" are different answers, and a
   * blank box cannot tell them apart from a telecaller who simply skipped it.
   */
  noOrderNextCallDate: z.string().optional(),
  /** Explicitly: the customer committed to nothing. Lets the default apply. */
  noOrderNoCommitment: z.boolean().default(false),
  paymentPromiseDate: z.string().optional(),
  complaintCategory: z
    .enum([
      "product_quality",
      "packaging_damage",
      "dispatch_delay",
      "billing_issue",
      "delivery",
      "pricing",
      "service",
      "shortage",
      "other",
    ])
    .optional(),

  /**
   * The complaint as the customer put it. The call notes are about the call;
   * this is the text the resolver reads, so it is captured separately rather
   * than borrowed from them.
   */
  complaintDescription: z.string().optional(),
  /** A credit note the customer asked for, and the bill it is against. */
  complaintRequestCn: z.boolean().default(false),
  /** Whole rupees from the form; stored as paise. Only ever with a Yes. */
  complaintCnAmount: z.coerce.number().int().positive().optional(),
  complaintBillId: z.string().optional(),
  complaintGoodsDescription: z.string().optional(),

  /** Order-received only. User-entered, may be in the past, never the future. */
  orderDate: z.string().optional(),


  sourceModule: z
    .enum([
      "call_queue",
      "payment_follow_up",
      "inactive_watch",
      "customer_record",
      "ad_hoc",
    ])
    .default("ad_hoc"),
  queuePosition: z.number().int().optional(),
  durationSeconds: z.number().int().min(0).optional(),

  /** Telecallers double-click, and a duplicate corrupts three figures at once. */
  idempotencyKey: z.string().min(8),
});

export type SaveInteractionInput = z.input<typeof saveInteractionSchema>;

export type SaveInteractionResult = {
  interactionId: string;
  produced: string[];
  duplicate: boolean;
  orderId: string | null;
  reminderId: string | null;
  complaintId: string | null;
  /** True when an existing open complaint was updated instead of a new one. */
  complaintUpdated: boolean;
  /**
   * What happens next with this customer, as the telecaller is about to be
   * told. Null only where the customer has gone — deactivated between the save
   * and the read — because a screen with nothing to say is better than one
   * inventing something.
   */
  nextStep: NextStep | null;
};

function fieldError(field: string, message: string): Result<never> {
  return err(message, "validation", [{ field, message }]);
}

/**
 * The six stored columns back into the shape the screen renders.
 *
 * Null where nothing was stored — calls logged before this existed, and the
 * handful whose computation failed. A missing sentence is shown as a missing
 * sentence; nothing here reconstructs one, because a reconstruction would be
 * today's answer wearing the date of an old call.
 */
function storedNextStep(row: {
  nextStepKind: NextStepKind | null;
  nextStepDate: string | null;
  nextStepReason: string | null;
  nextStepHeadline: string | null;
  nextStepDetail: string | null;
  nextStepHeldToday: string | null;
}): NextStep | null {
  if (!row.nextStepKind || !row.nextStepHeadline) return null;
  return {
    kind: row.nextStepKind,
    date: row.nextStepDate,
    daysAway: null,
    reasonKind: (row.nextStepReason as NextStep["reasonKind"]) ?? null,
    headline: row.nextStepHeadline,
    detail: row.nextStepDetail ?? "",
    heldToday: row.nextStepHeldToday,
  };
}

export async function saveInteraction(
  raw: SaveInteractionInput,
): Promise<Result<SaveInteractionResult>> {
  const parsed = saveInteractionSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fieldError(issue.path.join("."), issue.message);
  }
  const input = parsed.data;

  const ctx = await resolveScope();
  const config = await getConfig();
  const day = await today();
  const isOrderReceived = input.interactionType === "order_received";

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, input.customerId));
  if (!customer) return err("That customer no longer exists.", "not_found");
  await assertCustomerInScope(customer);

  /* ------------------------------------------------------------ validation */

  // 1. The outcome must belong to the interaction type. The interface will not
  //    produce a mismatch, but the boundary has to enforce it anyway.
  if (isOrderReceived) {
    if (input.outcome) {
      return fieldError("outcome", "An order received has no outcome.");
    }
  } else {
    if (!input.outcome) {
      return fieldError("outcome", "Pick what came of the call.");
    }
    const legal = OUTCOMES_BY_TYPE[input.interactionType as InteractionTypeKey];
    if (!legal.includes(input.outcome as OutcomeKey)) {
      return fieldError(
        "outcome",
        `"${input.outcome}" is not a possible outcome for that kind of call.`,
      );
    }
  }

  // 2. Follow-up needs a date, and it cannot be in the past.
  if (input.outcome === "follow_up") {
    if (!input.followUpDate) {
      return fieldError("followUpDate", "Pick the follow-up date - it becomes a reminder.");
    }
    if (input.followUpDate < day) {
      return fieldError("followUpDate", "The follow-up date cannot be in the past.");
    }
  }

  // 3. No order has to say when to call back, or that the customer would not
  //    say. Enforced here and not only on the form: a mandatory field that is
  //    only mandatory in the browser is not mandatory.
  if (input.outcome === "no_order") {
    if (!input.noOrderNextCallDate && !input.noOrderNoCommitment) {
      return fieldError(
        "noOrderNextCallDate",
        "Say when to call back, or that they would not commit to a date.",
      );
    }
    if (input.noOrderNextCallDate) {
      if (input.noOrderNoCommitment) {
        return fieldError(
          "noOrderNextCallDate",
          "Either they gave a date or they did not - not both.",
        );
      }
      if (input.noOrderNextCallDate < day) {
        return fieldError(
          "noOrderNextCallDate",
          "The next call cannot be in the past.",
        );
      }
    }
  }

  // 4. Inbound payment promises must carry the date they committed to.
  if (input.interactionType === "inbound_call" && input.outcome === "payment_promised") {
    if (!input.paymentPromiseDate) {
      return fieldError("paymentPromiseDate", "Enter the date they committed to.");
    }
  }

  // 4. A complaint without a category cannot be routed, without a description
  //    cannot be worked, and a credit note with no bill behind it is not
  //    actionable by accounts. The same three rules as the complaints screen —
  //    a complaint raised mid-call is not a lesser record.
  if (input.outcome === "complaint") {
    if (!input.complaintCategory) {
      return fieldError("complaintCategory", "Pick the complaint category.");
    }
    // The description is its own field, but a complaint whose words were typed
    // into the call note is still a described complaint — what must never
    // happen is a resolver opening one that says nothing.
    if (!input.complaintDescription?.trim() && !input.notes?.trim()) {
      return fieldError(
        "complaintDescription",
        "Describe the complaint in the customer's words.",
      );
    }
    // A credit-note request is a yes, and nothing more. Naming the bill and
    // the amount is accounts' work — they hold the ledger, and asking a
    // telecaller mid-call to pick the right bill produced either a wrong one
    // or a request nobody made. `bill_id` stays on the row for whoever fills
    // it in later, and for the requests taken while the form asked.
    // §6.2 — an amount without a Yes is rejected. A figure sitting on a
    // complaint nobody asked a credit note for reads as an approved amount to
    // whoever opens it later.
    if (input.complaintCnAmount && !input.complaintRequestCn) {
      return fieldError(
        "complaintCnAmount",
        "There is a credit note amount but no credit note request. Choose Yes, or clear the amount.",
      );
    }
  }

  // 5. Order received: the date is required and cannot be in the future.
  if (isOrderReceived) {
    if (!input.orderDate) {
      return fieldError("orderDate", "Choose the date the order came in.");
    }
    if (input.orderDate > day) {
      return fieldError("orderDate", "The order date cannot be in the future.");
    }
  }

  // 6. An order needs something ordered.
  const lines = Object.entries(input.productQuantities)
    .map(([productId, qty]) => ({ productId, quantity: Number(qty) }))
    .filter((l) => l.quantity > 0);

  const needsProducts = isOrderReceived || input.outcome === "order_taken";
  if (needsProducts && !lines.length) {
    return fieldError("productQuantities", "Add at least one product and quantity.");
  }
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      return fieldError("productQuantities", "Quantities must be whole numbers above zero.");
    }
  }

  // 7. Quick notes must belong to this type and outcome.
  if (input.quickNoteIds.length) {
    const found = await db
      .select()
      .from(quickNotes)
      .where(inArray(quickNotes.id, input.quickNoteIds));
    if (found.length !== input.quickNoteIds.length) {
      return fieldError("quickNoteIds", "One of those quick notes no longer exists.");
    }
    const wrong = found.find(
      (n) =>
        n.interactionType !== input.interactionType ||
        (n.outcome ?? null) !== (input.outcome ?? null),
    );
    if (wrong) {
      return fieldError(
        "quickNoteIds",
        `"${wrong.label}" does not belong to that outcome.`,
      );
    }
  }

  // 8. Products must be active.
  let productRows: Array<typeof products.$inferSelect> = [];
  if (lines.length) {
    productRows = await db
      .select()
      .from(products)
      .where(inArray(products.id, lines.map((l) => l.productId)));
    if (productRows.length !== lines.length) {
      return fieldError("productQuantities", "One of those products no longer exists.");
    }
    const inactive = productRows.find((p) => !p.active);
    if (inactive) {
      return fieldError("productQuantities", `${inactive.name} is discontinued.`);
    }
  }

  // 9. Notes length.
  const maxNotes = config["interactions.maxNotesLength"];
  if (input.notes && input.notes.length > maxNotes) {
    return fieldError("notes", `Keep the notes under ${maxNotes} characters.`);
  }

  /* ---------------------------------------------------------- idempotency */

  const [existing] = await db
    .select({
      id: calls.id,
      orderId: calls.orderId,
      reminderId: calls.reminderId,
      complaintId: calls.complaintId,
      nextStepKind: calls.nextStepKind,
      nextStepDate: calls.nextStepDate,
      nextStepReason: calls.nextStepReason,
      nextStepHeadline: calls.nextStepHeadline,
      nextStepDetail: calls.nextStepDetail,
      nextStepHeldToday: calls.nextStepHeldToday,
    })
    .from(calls)
    .where(eq(calls.idempotencyKey, input.idempotencyKey));
  if (existing) {
    return ok(
      {
        interactionId: existing.id,
        produced: [],
        duplicate: true,
        orderId: existing.orderId,
        reminderId: existing.reminderId,
        complaintId: existing.complaintId,
        complaintUpdated: false,
        // The STORED one, not a fresh reading. A double-click has to show the
        // same screen as the first click — this is precisely what keeping the
        // sentence on the row buys.
        nextStep: storedNextStep(existing),
      },
      "Already logged",
    );
  }

  /* ------------------------------------------------------- the transaction */

  const now = new Date();
  const interactionId = id("ixn");
  const produced: string[] = [];
  const warnings: string[] = [];

  let orderId: string | null = null;
  /** When the order was PLACED — user-entered for an order received. */
  let orderedAtTs: Date | null = null;
  let reminderId: string | null = null;
  let complaintId: string | null = null;
  let complaintUpdated = false;
  let orderValue = 0;

  // §6 — which of the three dates each outcome touches.
  // A ringing phone is not contact: No Answer moves last CALL but never last
  // CONTACT, or a customer nobody has spoken to keeps falling out of the queue.
  const updatesLastCall = !isOrderReceived;
  const updatesLastContact = !isOrderReceived && input.outcome !== "no_answer";

  await db.transaction(async (tx) => {
    /* ------------------------------------------------------------- order */
    if (isOrderReceived || input.outcome === "order_taken") {
      // Rates are not held in the system yet, so an order records quantities
      // and a zero value. Flagged, because it leaves target achievement,
      // EOD order value and shortfall analysis all reading zero.
      orderValue = 0;
      orderId = id("ord");
      const orderedOn = isOrderReceived ? input.orderDate! : day;
      orderedAtTs = new Date(`${orderedOn}T09:00:00+05:30`);
      // The term is no longer agreed call by call — it comes from the standing
      // one on the customer, or the configured default. Still recorded on the
      // order, so the bill raised against it inherits a due date nobody has to
      // remember or retype.
      const creditDays =
        customer.creditDays ?? config["customers.defaultCreditDays"];
      await tx.insert(orders).values({
        id: orderId,
        customerId: customer.id,
        userId: ctx.user.id,
        source: "crm",
        orderedAt: orderedAtTs,
        totalAmount: orderValue,
        // Not a sale until accounts say so. The customer HAS ordered, which
        // is what stops the queue chasing them, but nothing about money moves
        // until this is approved.
        status: "pending_approval",
        creditDays,
        paymentDueDate: addDays(orderedOn, creditDays),
      });
      produced.push("order");
      warnings.push(
        "Order value is zero - the system does not hold product rates yet, so quantities were saved without a value.",
      );
    }

    /* ---------------------------------------------------------- reminder */
    if (input.outcome === "follow_up") {
      reminderId = id("rem");
      await tx.insert(reminders).values({
        id: reminderId,
        customerId: customer.id,
        createdByUserId: ctx.user.id,
        assignedUserId: ctx.user.id,
        callId: interactionId,
        dueDate: input.followUpDate!,
        note: input.notes?.trim() || "Follow up",
        type: "call_back",
        systemGenerated: true,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      produced.push("reminder");
    }

    /*
     * The date the customer gave becomes a reminder, which is the whole point:
     * the queue engine checks reminders BEFORE it consults any cooldown, so
     * the call surfaces on the day they named rather than on day five. Where
     * they committed to nothing, no reminder is written and the `no_order`
     * cooldown is left to decide — which is what it is for.
     */
    if (input.outcome === "no_order" && input.noOrderNextCallDate) {
      reminderId = id("rem");
      await tx.insert(reminders).values({
        id: reminderId,
        customerId: customer.id,
        createdByUserId: ctx.user.id,
        assignedUserId: ctx.user.id,
        callId: interactionId,
        dueDate: input.noOrderNextCallDate,
        // Says what the call is FOR. "Follow up" on its own tells whoever
        // picks it up nothing about why they are ringing.
        note: input.notes?.trim() || "No order last time - ask again",
        type: "call_back",
        systemGenerated: true,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      produced.push("reminder");
    }

    if (input.outcome === "payment_promised" && input.paymentPromiseDate) {
      reminderId = id("rem");
      await tx.insert(reminders).values({
        id: reminderId,
        customerId: customer.id,
        createdByUserId: ctx.user.id,
        assignedUserId: ctx.user.id,
        callId: interactionId,
        dueDate: onOrAfterWorkingDay(input.paymentPromiseDate, {
          timezone: config["workingDay.timezone"],
          dayBoundaryHour: config["workingDay.dayBoundaryHour"],
          workingDays: config["workingDay.workingDays"],
        }),
        note: input.notes?.trim() || "Payment promised",
        type: "payment_promise",
        systemGenerated: true,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      produced.push("reminder");
    }

    /* --------------------------------------------------------- complaint */
    if (input.outcome === "complaint") {
      const complaintText =
        input.complaintDescription?.trim() ||
        input.notes?.trim() ||
        "Reported on a call";

      // An existing open complaint in the same category is updated, not
      // duplicated — and the caller is told which happened.
      const [open] = await tx
        .select()
        .from(complaints)
        .where(
          and(
            eq(complaints.customerId, customer.id),
            eq(complaints.category, input.complaintCategory!),
            sql`${complaints.status} in ('open','in_progress','awaiting_customer')`,
          ),
        )
        .orderBy(desc(complaints.createdAt))
        .limit(1);

      if (open) {
        complaintId = open.id;
        complaintUpdated = true;
        await tx.insert(complaintStatusHistory).values({
          id: id("csh"),
          complaintId,
          fromStatus: open.status,
          toStatus: open.status,
          changedById: ctx.user.id,
          note: `Raised again on a call: ${complaintText}`,
        });
        // Asking for a credit note is new information about a complaint we
        // already knew about, so it lands on the existing row rather than
        // being lost with the duplicate. An existing request is never
        // withdrawn here — that is the resolver's decision, not this call's.
        if (input.complaintRequestCn && !open.requestCn) {
          await tx
            .update(complaints)
            .set({
              requestCn: true,
              billId: input.complaintBillId ?? null,
              goodsDescription:
                input.complaintGoodsDescription?.trim() || null,
              updatedById: ctx.user.id,
            })
            .where(eq(complaints.id, complaintId));
        }
        produced.push("complaint-updated");
      } else {
        complaintId = id("cmp");
        const severity = config["complaints.defaultSeverity"];
        const slaHours = config["complaints.slaHours"][severity];
        await tx.insert(complaints).values({
          id: complaintId,
          customerId: customer.id,
          loggedByUserId: ctx.user.id,
          callId: interactionId,
          category: input.complaintCategory!,
          description: complaintText,
          severity,
          slaDueAt: new Date(now.getTime() + slaHours * 3_600_000),
          mobileNumber: customer.phone,
          requestCn: input.complaintRequestCn,
          billId: input.complaintRequestCn
            ? (input.complaintBillId ?? null)
            : null,
          goodsDescription: input.complaintRequestCn
            ? input.complaintGoodsDescription?.trim() || null
            : null,
          cnAmount:
            input.complaintRequestCn && input.complaintCnAmount
              ? input.complaintCnAmount * 100
              : null,
          // Requested is where every request starts and, until something
          // outside the CRM moves it, where it stays.
          cnStatus: input.complaintRequestCn ? "requested" : null,
          createdById: ctx.user.id,
          updatedById: ctx.user.id,
        });
        await tx.insert(complaintStatusHistory).values({
          id: id("csh"),
          complaintId,
          fromStatus: null,
          toStatus: "open",
          changedById: ctx.user.id,
          note: `Logged on a call by ${ctx.user.name}`,
        });
        produced.push("complaint");
      }
    }

    /* ------------------------------------------------- the interaction row */
    await tx.insert(calls).values({
      id: interactionId,
      customerId: customer.id,
      userId: ctx.user.id,
      direction: input.interactionType === "inbound_call" ? "inbound" : "outbound",
      interactionType: input.interactionType,
      outcome: input.outcome ?? null,
      startedAt: now,
      orderDate: isOrderReceived ? input.orderDate! : null,
      durationSeconds: input.durationSeconds ?? null,
      notes: input.notes?.trim() || null,
      quickNoteIds: input.quickNoteIds,
      sourceModule: input.sourceModule,
      queuePosition: input.queuePosition ?? null,
      orderId,
      reminderId,
      complaintId,
      idempotencyKey: input.idempotencyKey,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });

    /* ------------------------------------------------- the shared timeline */
    /*
     * §1.1 — the stream both apps write. In THIS transaction, because a
     * timeline entry for a call that rolled back is a call that never
     * happened, on a screen somebody standing in the shop believes.
     *
     * The order gets its own entry rather than being folded into the call's
     * sentence: a salesman scanning a customer wants "they ordered" to be its
     * own line, and the order is a different source row with a different life.
     * No value is quoted, because the CRM holds no rates and every one of
     * these orders is worth a confident zero.
     */
    await writeTimelineEvents(tx, [
      {
        customerId: customer.id,
        eventType: CRM_EVENT.call,
        sourceApp: "crm",
        sourceRecordId: interactionId,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: callTimelineSummary({
          interactionType: input.interactionType,
          outcome: input.outcome ?? null,
          notes: input.notes ?? null,
        }),
      },
      ...(orderId
        ? [
            {
              customerId: customer.id,
              eventType: CRM_EVENT.order,
              sourceApp: "crm" as const,
              sourceRecordId: orderId,
              // The date the order was PLACED, which for an order logged on
              // Monday for Friday's WhatsApp is not today.
              occurredAt: orderedAtTs ?? now,
              actorUserId: ctx.user.id,
              summary: `Order taken by ${ctx.user.name} — awaiting approval by accounts`,
            },
          ]
        : []),
    ]);

    /* ------------------------------------------------------ product lines */
    for (const l of lines) {
      await tx.insert(interactionProductLines).values({
        id: id("ipl"),
        interactionId,
        productId: l.productId,
        quantity: l.quantity,
      });
    }

    /* ---------------------------------------------- customer date rollups */
    const set: Partial<typeof customers.$inferInsert> = { updatedAt: now };
    let converted = false;
    if (updatesLastCall) set.lastCallDate = day;
    if (updatesLastContact) set.lastContactDate = day;

    if (orderId) {
      // The user-entered order date is the order date. And a backdated order
      // must never drag the last-order date backwards.
      //
      // Set on CAPTURE, not on approval: this is the signal that stops the
      // calling queue chasing them, and nobody should ring a customer
      // tomorrow asking for an order they placed today, whatever accounts
      // decide afterwards. If the order is declined, `recomputeLastOrder`
      // pulls it back to the last one that actually counted.
      const orderedOn = isOrderReceived ? input.orderDate! : day;
      if (!customer.lastOrderDate || orderedOn > customer.lastOrderDate) {
        set.lastOrderDate = orderedOn;
      }

      // A lead becomes a customer the moment it orders. That is the whole
      // definition of the difference, so it converts here rather than waiting
      // for somebody to remember to change a dropdown — a lead with orders
      // against it would keep showing the lead notice and hiding the very
      // purchase history it had just started building.
      //
      // The person who found them becomes the sales account manager. Back
      // office is deliberately left unassigned: who handles the dispatch and
      // billing is a decision, not something to guess at on first order.
      if (customer.kind === "lead") {
        set.kind = "customer";
        // Through the one definition of whose book a record is in. A lead
        // answers to its owner, and a reassignment moves a lead by writing
        // that column — so this carries the CURRENT holder across rather than
        // re-deriving a fallback that could disagree with it.
        set.salesAmId = assignedUserId({
          kind: "lead",
          ownerId: customer.ownerId,
          salesAmId: customer.salesAmId,
        });
        set.customerSince = orderedOn;
        converted = true;
      }
    }
    await tx.update(customers).set(set).where(eq(customers.id, customer.id));

    // Converting a lead changes who the record answers to and what every
    // screen shows for it. That is worth its own audit line rather than
    // hiding inside the interaction's.
    if (converted) {
      produced.push("converted-to-customer");
      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        action: "customer.convertedFromLead",
        entityType: "customer",
        entityId: customer.id,
        beforeState: { kind: "lead", leadSource: customer.leadSource } as never,
        afterState: { kind: "customer", salesAmId: set.salesAmId } as never,
      });
    }

    /* ----------------------------------------------------- quick note use */
    if (input.quickNoteIds.length) {
      await tx
        .update(quickNotes)
        .set({ usageCount: sql`${quickNotes.usageCount} + 1` })
        .where(inArray(quickNotes.id, input.quickNoteIds));
    }

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "interaction.save",
      entityType: "interaction",
      entityId: interactionId,
      afterState: {
        interactionType: input.interactionType,
        outcome: input.outcome ?? null,
        produced,
      } as never,
    });
  });

  /* --------------------------------------------- post-commit recomputation */

  if (orderId) {
    await recomputeBuyingCycle(customer.id);
    await recomputeInactivity();
  }

  // A payment promise on either leg is a collections attempt by call. Stage 1
  // is WhatsApp-only, so record the interaction but refuse the attempt and say
  // so — silently breaking the stage rule would be worse than the warning.
  if (input.outcome === "payment_promised") {
    const [state] = await db
      .select()
      .from(followUpStates)
      .where(eq(followUpStates.customerId, customer.id));

    // isAttemptAllowed returns a verdict object, not a boolean — negating the
    // object itself would silently allow every stage-1 call through.
    const verdict = state
      ? isAttemptAllowed(state.stage as 1 | 2 | 3, "call")
      : { allowed: true as const };

    if (state && !verdict.allowed) {
      warnings.push(
        `${customer.name} is at stage ${state.stage}, which is WhatsApp-only - the call was logged, but not counted as a collections attempt.`,
      );
    } else if (state) {
      await db.insert(followUpAttempts).values({
        id: id("fua"),
        customerId: customer.id,
        stage: state.stage,
        channel: "call",
        attemptedAt: now,
        userId: ctx.user.id,
        outcome: "promised",
        promisedDate: input.paymentPromiseDate ?? null,
        reminderId,
        idempotencyKey: `${input.idempotencyKey}:fua`,
      });
      await db
        .update(followUpStates)
        .set({ lastChannel: "call", lastFollowUpAt: now, updatedAt: now })
        .where(eq(followUpStates.customerId, customer.id));
      await recomputeFollowUpState(customer.id);
    }
  }

  if (orderId) await recomputeOutstanding(customer.id);

  /* ------------------------------------------------ what happens next
   *
   * AFTER every recompute above, never before. The call that was just logged
   * is what moves the cycle, the last-contact date, the follow-up stage and
   * the cooldown — read a moment earlier and this would describe the world as
   * it stood before the call, which is the one answer that is certainly wrong.
   *
   * Failing to work it out must not fail the save. The call is in the ledger;
   * the sentence is a courtesy on top of it.
   */
  let step: NextStep | null = null;
  try {
    step = await nextStepForCustomer(customer.id);
    if (step) {
      await db
        .update(calls)
        .set({
          nextStepKind: step.kind,
          nextStepDate: step.date,
          nextStepReason: step.reasonKind,
          nextStepHeadline: step.headline,
          nextStepDetail: step.detail,
          nextStepHeldToday: step.heldToday,
        })
        .where(eq(calls.id, interactionId));
    }
  } catch {
    step = null;
  }

  return ok(
    {
      interactionId,
      produced,
      duplicate: false,
      orderId,
      reminderId,
      complaintId,
      complaintUpdated,
      nextStep: step,
    },
    complaintUpdated ? "Added to the open complaint" : "Interaction saved",
    warnings,
  );
}
