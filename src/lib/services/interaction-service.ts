import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  callOpportunities,
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
import { resolveScope, assertCustomerInScope } from "../access-control";
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
import { consecutiveNoAnswerSql, nextStepForCustomer } from "./queue-service";
import { closeRemindersOnEvidence } from "./worklist-services";
import { addDays, onOrAfterWorkingDay } from "../business-date";
import { err, ok, type Result } from "../result";
import { money, shortDate } from "../format";
import { CRM_EVENT, callTimelineSummary, writeTimelineEvents } from "../timeline";
import {
  conversionColumns,
  hasOrderedBefore,
  recordConversion,
} from "./lead-conversion-service";
import {
  deskForAction,
  NEVER_CALL_AGAIN,
  outcomeFieldRequired,
  outcomeFieldsVisible,
} from "../call-outcomes";
import {
  CALL_REASON_CODES,
  CALL_REASON_LABEL,
  EXCLUSIVE_ACTION,
  type CallReason,
  NEXT_ACTION_LABEL,
  nextActionsFor,
  reasonFieldsFor,
  reminderTypeFor,
  wantsDate,
} from "../call-reasons";

/**
 * Zod wants a non-empty tuple and the vocabulary is a plain array, because
 * everything else that reads it wants a list. Asserted rather than retyped: a
 * second copy of ten codes is a second answer to "what may be stored", and the
 * one that drifts is always the one the server checks.
 */
const CALL_REASON_CODES_TUPLE = CALL_REASON_CODES as [CallReason, ...CallReason[]];

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * The sentence an opportunity reads as on the customer record.
 *
 * Built from what was actually answered rather than a fixed template with gaps
 * in it: "Opportunity: Nano Thinner — about ₹40,000" and "Opportunity: Nano
 * Thinner" are both true sentences, and "Opportunity: Nano Thinner — ₹0 —
 * (no date)" is a record that reads as somebody having judged it worthless.
 */
function opportunitySummary(o: {
  product: string;
  estimatedQuantity?: string;
  estimatedValueRupees?: number;
  expectedOrderDate?: string;
}): string {
  const parts = [`Opportunity: ${o.product.trim()}`];
  if (o.estimatedQuantity?.trim()) parts.push(o.estimatedQuantity.trim());
  if (o.estimatedValueRupees !== undefined) {
    parts.push(money(o.estimatedValueRupees * 100));
  }
  if (o.expectedOrderDate) parts.push(`expected ${shortDate(o.expectedOrderDate)}`);
  return parts.join(" — ");
}

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
      "wrong_product",
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

  /* ------------------------------------------------- who rang, and why --
   *
   * INBOUND'S QUESTIONS. The panel asked one — "what was the outcome?" — and
   * made it do two jobs: an outcome is how a call ENDED, and these are what
   * the customer wanted when they picked up the phone. On an inbound call the
   * two are routinely different, so the first half simply was not recorded.
   *
   * All of it is optional in the SCHEMA and conditionally required in the
   * rules below, because an outbound call and an order that arrived by
   * WhatsApp legitimately carry none of it — a nullable field and a rule that
   * knows when it applies, rather than three schemas.
   */
  callerRole: z
    .enum(["owner", "purchase", "accounts", "store", "production", "other"])
    .optional(),
  /** A role with nobody's name against it cannot be rung back. */
  callerName: z.string().optional(),
  callReason: z.enum(CALL_REASON_CODES_TUPLE).optional(),
  /**
   * The answers the chosen reason asked for. Validated against
   * `reasonFieldsFor` — the SAME function the form draws its boxes from, so a
   * field that is mandatory on the screen is mandatory in the rule and the two
   * cannot drift apart.
   */
  reasonDetail: z.record(z.string(), z.string()).default({}),
  /**
   * The answers the OUTCOME asked for — why no order, why no answer, what we
   * are waiting for, why not interested, a complaint's priority and what the
   * customer wants done about it.
   *
   * Validated against `outcomeFieldsVisible`/`outcomeFieldRequired`, the same
   * two functions the form draws its boxes from, so a box that is mandatory on
   * the screen is mandatory in the rule.
   */
  outcomeDetail: z.record(z.string(), z.string()).default({}),
  /** Codes from `nextActionsFor`, checked against the reason that was given. */
  nextActions: z.array(z.string()).default([]),
  nextActionDate: z.string().optional(),

  /**
   * §Sales opportunity — did this call turn up something worth chasing.
   *
   * Absent means nobody was asked, which on an outbound call is the truth.
   * Present with `yes: false` means somebody WAS asked and said no, and that
   * is a different fact worth keeping apart from silence.
   */
  opportunity: z
    .object({
      product: z.string().min(1),
      estimatedQuantity: z.string().optional(),
      /** Whole rupees from the form. Stored as paise, like all money here. */
      estimatedValueRupees: z.coerce.number().int().nonnegative().optional(),
      expectedOrderDate: z.string().optional(),
    })
    .optional(),

  /** Order-received only. User-entered, may be in the past, never the future. */
  orderDate: z.string().optional(),

  /* ---------------------------------------------------- the two parties --
   *
   * WHO WE INVOICE and WHERE THE GOODS GO are two questions, and on a shop
   * served through a distributor they have different answers. The model has
   * held both since `orders.delivery_customer_id` arrived; what it has never
   * had is anybody ASKING. `linkDeliveryParties()` reconstructs the delivery
   * party nightly by matching the order sheet's names against the book, which
   * is why it reports `unresolved` and `ambiguous` — it is guessing after the
   * fact at something the person taking the order knew at the time.
   *
   * Both are OPTIONAL and both default to the customer the call is with, so
   * every existing caller keeps its exact behaviour: bill them, deliver to
   * them, `deliveryCustomerId` null.
   */

  /**
   * Who gets invoiced. Defaults to the customer being called.
   *
   * It can differ from them: a call with a third-party shop produces an order
   * billed to its distributor, because that is who buys from us. Money follows
   * this one — credit, term, outstanding, receipts and collections — which is
   * why it is checked against the caller's scope like any other write.
   */
  billingCustomerId: z.string().optional(),
  /**
   * Where the goods go, when that is not where the bill goes.
   *
   * Null means the billing party received them, which is the ordinary case and
   * what every order written before this existed means. Never send the billing
   * party's own id here: "delivered to themselves" and "delivered elsewhere"
   * must not both be expressible, or two rows describing one arrangement read
   * differently.
   */
  deliveryCustomerId: z.string().optional(),


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
  /** Promises the evidence of this call closed. Never fewer than zero. */
  remindersClosed?: number;
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
    // Never stored — the hold action only makes sense against a LIVE
    // promise, not one replayed from a past call's six stored columns.
    promise: null,
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

  /* ------------------------------------------------------- the two parties */

  /*
   * Who we invoice, and where the goods go.
   *
   * Both default to the customer the call is with, so a caller that sends
   * neither gets exactly the behaviour every order written before this had:
   * billed to them, delivered to them, `deliveryCustomerId` null.
   *
   * Resolved BEFORE validation and outside the transaction, because a party
   * that does not exist or is out of scope must fail the save rather than roll
   * one back — and because the credit term below is read from whoever is
   * actually being billed.
   */
  let billingCustomer = customer;
  if (input.billingCustomerId && input.billingCustomerId !== customer.id) {
    const [biller] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, input.billingCustomerId));
    if (!biller) return fieldError("billingCustomerId", "That billing party no longer exists.");
    /*
     * Scoped like any other write. Billing somebody else's account is exactly
     * the move that would otherwise put an order — and its money — on a book
     * the caller cannot see.
     */
    await assertCustomerInScope(biller);
    /*
     * A LEAD cannot be billed. It has never ordered, carries no credit term
     * and no outstanding, and invoicing one silently turns a prospect into a
     * debtor without anybody converting it.
     */
    if (biller.kind === "lead") {
      return fieldError(
        "billingCustomerId",
        "That account has never ordered, so there is nothing to bill against. Convert it first.",
      );
    }
    billingCustomer = biller;
  }

  /*
   * The delivery party, where it is not the billing party.
   *
   * Naming the biller here is folded to null rather than refused: the two
   * spellings of "they received it themselves" must not both reach the column,
   * or one arrangement is stored two ways and every read has to know both.
   */
  let deliveryCustomerId: string | null = null;
  if (input.deliveryCustomerId && input.deliveryCustomerId !== billingCustomer.id) {
    const [shop] = await db
      .select({ id: customers.id, status: customers.status })
      .from(customers)
      .where(eq(customers.id, input.deliveryCustomerId));
    if (!shop) return fieldError("deliveryCustomerId", "That delivery party no longer exists.");
    /*
     * NOT scope-checked, and deliberately. A delivery party is an ADDRESS on
     * somebody else's order — the shop a distributor's goods go to — and it
     * routinely sits in another telecaller's book or in nobody's. Refusing it
     * on scope would make the common case unrecordable, which is the state
     * this field exists to end. Nothing about it moves money, and no figure on
     * this order is read from it.
     */
    if (shop.status === "deactivated") {
      return fieldError(
        "deliveryCustomerId",
        "That account is deactivated, so goods should not be sent there.",
      );
    }
    deliveryCustomerId = shop.id;
  }

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

  // 4. Inbound payment promises must carry the date they committed to, and it
  //    cannot be behind us.
  //
  //    THE FLOOR IS THE HALF THAT WAS MISSING. The other two date fields on
  //    this form both reject the past and this one did not, so a mistyped year
  //    produced a `payment_promise` reminder already overdue — which puts the
  //    customer at `reminderOverdue`, the strongest tier in the queue, the next
  //    morning, for a promise they had just made. `onOrAfterWorkingDay` shifts
  //    off a Sunday and deliberately never clamps forward, so nothing
  //    downstream was going to catch it.
  if (input.interactionType === "inbound_call" && input.outcome === "payment_promised") {
    if (!input.paymentPromiseDate) {
      return fieldError("paymentPromiseDate", "Enter the date they committed to.");
    }
  }
  if (input.paymentPromiseDate && input.paymentPromiseDate < day) {
    return fieldError(
      "paymentPromiseDate",
      "A payment date cannot be in the past.",
    );
  }

  /* ------------------------------------------------ 4b. who rang, and why
   *
   * INBOUND ONLY, and required there.
   *
   * An outbound call's reason is already recorded — it is whatever the queue
   * put the customer in front of us for — and asking the telecaller to restate
   * it would be a second answer that can disagree with the first. An order
   * that arrived by WhatsApp had no caller at all.
   *
   * Enforced HERE and not only on the form, like every other mandatory field
   * in this file: a server action is a URL, and a rule that lives in a browser
   * is not a rule.
   */
  if (input.interactionType === "inbound_call") {
    if (!input.callerRole) {
      return fieldError("callerRole", "Say who rang — it changes what the call is worth.");
    }
    if (!input.callReason) {
      return fieldError("callReason", "Say why they rang.");
    }
  } else if (input.callReason || input.callerRole) {
    // Not a refusal of work somebody did: there is no screen that can send
    // this, so anything arriving here came from something other than the form.
    return fieldError(
      "callReason",
      "Who rang and why is asked on inbound calls only.",
    );
  }

  /*
   * The detail the chosen reason asks for, checked against the SAME function
   * the form draws its boxes from. Two lists would be a box that is mandatory
   * on screen and optional in the rule, or the reverse — and the reverse is
   * the one that refuses a save nobody can fix.
   */
  const reasonDetail: Record<string, string> = {};
  if (input.callReason) {
    const fields = reasonFieldsFor(input.callReason);
    const allowed = new Set(fields.map((f) => f.key));
    for (const [key, value] of Object.entries(input.reasonDetail ?? {})) {
      if (!allowed.has(key)) continue; // a field from a reason they changed off
      const trimmed = value.trim();
      if (trimmed) reasonDetail[key] = trimmed;
    }
    for (const f of fields) {
      if (f.required && !reasonDetail[f.key]) {
        return fieldError(
          `reasonDetail.${f.key}`,
          `${f.label} is needed for a ${CALL_REASON_LABEL[input.callReason]} call.`,
        );
      }
      if (f.kind === "choice" && reasonDetail[f.key]) {
        const codes = new Set((f.options ?? []).map((o) => o.code));
        if (!codes.has(reasonDetail[f.key])) {
          return fieldError(`reasonDetail.${f.key}`, `Pick a valid ${f.label.toLowerCase()}.`);
        }
      }
      if (f.kind === "date" && reasonDetail[f.key] && !/^\d{4}-\d{2}-\d{2}$/.test(reasonDetail[f.key])) {
        return fieldError(`reasonDetail.${f.key}`, `${f.label} is not a date.`);
      }
    }
  }

  /* ------------------------------------- what the OUTCOME asked for
   *
   * Both directions. `reasonDetail` above is inbound's "why did they ring";
   * this is "what does this ending need to record", and a No Order is worth the
   * same answer whoever dialled.
   *
   * The visible set is computed from the answers themselves, because two of
   * the fields are conditional and neither can say so on the field: the
   * competitor name belongs to one answer of the question above it, and the
   * recall date to one answer of the question below. Validating against the
   * full list would demand a recall date from somebody who said there is no
   * later.
   */
  const outcomeDetail: Record<string, string> = {};
  if (input.outcome) {
    const answers = Object.fromEntries(
      Object.entries(input.outcomeDetail ?? {}).map(([k, v]) => [k, v.trim()]),
    );
    const visible = outcomeFieldsVisible(input.outcome, answers);
    const allowed = new Set(visible.map((f) => f.key));
    for (const [key, value] of Object.entries(answers)) {
      /* A field belonging to a branch they answered their way out of. Kept, it
         would store a competitor against a customer who said they have no
         requirement. */
      if (allowed.has(key) && value) outcomeDetail[key] = value;
    }
    for (const f of visible) {
      if (outcomeFieldRequired(f, answers) && !outcomeDetail[f.key]) {
        return fieldError(`outcomeDetail.${f.key}`, `${f.label} is needed.`);
      }
      if (f.kind === "choice" && outcomeDetail[f.key]) {
        const codes = new Set((f.options ?? []).map((o) => o.code));
        if (!codes.has(outcomeDetail[f.key])) {
          return fieldError(`outcomeDetail.${f.key}`, `Pick a valid ${f.label.toLowerCase()}.`);
        }
      }
      if (f.kind === "date" && outcomeDetail[f.key]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(outcomeDetail[f.key])) {
          return fieldError(`outcomeDetail.${f.key}`, `${f.label} is not a date.`);
        }
        if (outcomeDetail[f.key] < day) {
          return fieldError(`outcomeDetail.${f.key}`, `${f.label} cannot be in the past.`);
        }
      }
    }
  }

  /*
   * What somebody undertook to do. A code from this reason's own list — a
   * picker is not a permission, and "Arrange stock" against a price enquiry is
   * an answer to a question nobody asked.
   */
  const nextActions = [...new Set(input.nextActions ?? [])];
  /*
   * AN ORDER TAKEN ANSWERS THIS ON BOTH DIRECTIONS, and it is the one place
   * the list comes off the OUTCOME rather than the reason.
   *
   * Once the call has ended in an order, what happens next is about the order:
   * somebody who rang to ask a price and ended up ordering needs chasing for
   * payment or dispatch, not sending a quotation. And an order taken on a call
   * WE made needs exactly the same four answers as one taken on a call they
   * made — the goods and the money do not care who dialled — so this is the
   * one question on the form that an outbound call is also asked.
   */
  const offeredActions = nextActionsFor(input.callReason, input.outcome);
  if (nextActions.length) {
    if (!offeredActions.length) {
      return fieldError(
        "nextActions",
        "Pick why they rang before saying what happens next.",
      );
    }
    const offered = new Set(offeredActions.map((a) => a.code));
    const stray = nextActions.find((a) => !offered.has(a));
    if (stray) {
      return fieldError("nextActions", "That next action does not belong to this call.");
    }
    /*
     * "Nothing further is needed, and also chase the payment" is not a
     * sentence. Refused rather than silently resolved one way, because either
     * resolution stores something nobody said.
     */
    if (nextActions.includes(EXCLUSIVE_ACTION) && nextActions.length > 1) {
      return fieldError(
        "nextActions",
        "Either nothing further is needed, or something is — not both.",
      );
    }
  }
  /*
   * A DATE IS DEMANDED WHERE THE ACTION MEANS ONE, and refused where it does
   * not. "Send the quotation" with no day against it is the definition of how
   * a call gets forgotten; "Payment already made" is a statement about the
   * past and a date box beside it is a question nobody can answer.
   */
  if (wantsDate(nextActions) && !input.nextActionDate) {
    return fieldError("nextActionDate", "Say which day this is for.");
  }
  if (input.nextActionDate) {
    if (!wantsDate(nextActions)) {
      return fieldError("nextActionDate", "None of the chosen actions needs a date.");
    }
    if (input.nextActionDate < day) {
      return fieldError("nextActionDate", "The next action cannot be in the past.");
    }
  }

  /* An opportunity with a date on it must be a date somebody can still act on. */
  if (input.opportunity?.expectedOrderDate && input.opportunity.expectedOrderDate < day) {
    return fieldError(
      "opportunity.expectedOrderDate",
      "An expected order date cannot be in the past.",
    );
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
  /** Promises this call settled, counted so the save can say so. */
  let remindersClosed = 0;

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
      /*
       * The term of whoever is BILLED, not of whoever was called. On an order
       * delivered to a shop and invoiced to its distributor, the due date is
       * the distributor's to meet — reading the shop's term here would put a
       * date on the bill that nobody agreed with the person paying it.
       */
      const creditDays =
        billingCustomer.creditDays ?? config["customers.defaultCreditDays"];
      await tx.insert(orders).values({
        id: orderId,
        customerId: billingCustomer.id,
        // Null where the billing party received them, which is the ordinary
        // case and every order written before this was asked.
        deliveryCustomerId,
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

    /* -------------------------------------------- which attempt this was
     *
     * Stamped at the moment of the call, from the SAME ladder the queue reads —
     * one definition, or the screen saying "attempt 3" and the record saying
     * something else. The count is of the attempts BEFORE this one, so the call
     * being written is that plus one.
     *
     * It has to be a stamp rather than a read: the counter is consecutive no-
     * answers since the last answered call, so it resets the moment somebody
     * picks up, and a call logged as attempt 3 would read as attempt 0 a week
     * later — the one question this outcome exists to answer with no answer
     * left anywhere.
     */
    let callAttempt: number | null = null;
    if (input.outcome === "no_answer") {
      const [prior] = await tx.execute<{ n: number }>(
        sql`select ${consecutiveNoAnswerSql(customer.id)} as n`,
      );
      callAttempt = Number(prior?.n ?? 0) + 1;
    }

    /* ---------------------------------------------- a later they named
     *
     * "Possible later" with a date is the only thing standing between a
     * customer who said no this quarter and a customer nobody ever rings
     * again. It becomes a reminder, which outranks every cooldown in the
     * queue, so the call lands on the day rather than whenever the cadence
     * next gets round to them.
     */
    if (outcomeDetail.recallDate) {
      const recallId = id("rem");
      await tx.insert(reminders).values({
        id: recallId,
        customerId: customer.id,
        createdByUserId: ctx.user.id,
        assignedUserId: ctx.user.id,
        callId: interactionId,
        dueDate: onOrAfterWorkingDay(outcomeDetail.recallDate, {
          timezone: config["workingDay.timezone"],
          dayBoundaryHour: config["workingDay.dayBoundaryHour"],
          workingDays: config["workingDay.workingDays"],
        }),
        note: outcomeDetail.competitorName
          ? `Not interested for now - buying from ${outcomeDetail.competitorName}. They said to try again.`
          : "Not interested for now - they said to try again",
        type: "call_back",
        systemGenerated: true,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      produced.push("reminder");
      reminderId = reminderId ?? recallId;
    }

    /* ------------------------------------------ what we said we would do
     *
     * A NEXT ACTION WITH A DATE BECOMES A REMINDER, which is what stops it
     * being a dropdown nobody acts on. It is the same mechanism a promised
     * payment already uses rather than a second one beside it, so everything
     * that already knows how to surface a reminder — the queue (where one
     * outranks every cooldown), the reminders screen, the next-step
     * sentence — surfaces this for free.
     *
     * `send_information` and `check_stock` have been in `reminderTypeEnum`
     * since the CRM shipped with nothing ever writing one. These are what they
     * were for.
     */
    if (nextActions.length && input.nextActionDate) {
      const actionReminderId = id("rem");
      await tx.insert(reminders).values({
        id: actionReminderId,
        customerId: customer.id,
        createdByUserId: ctx.user.id,
        assignedUserId: ctx.user.id,
        callId: interactionId,
        dueDate: onOrAfterWorkingDay(input.nextActionDate, {
          timezone: config["workingDay.timezone"],
          dayBoundaryHour: config["workingDay.dayBoundaryHour"],
          workingDays: config["workingDay.workingDays"],
        }),
        /*
         * The note says WHAT, because "follow up" tells whoever picks it up
         * nothing about why they are ringing — the same reasoning the no-order
         * callback note carries one line down.
         */
        note: nextActions
          .map((a) => NEXT_ACTION_LABEL[a] ?? a)
          .join(", "),
        type: reminderTypeFor(nextActions),
        systemGenerated: true,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      produced.push("reminder");
      /*
       * The call row names ONE reminder and a call can legitimately owe two
       * things on two different days — a payment promised for Friday and a
       * quotation to send tomorrow. The column keeps whichever the call
       * produced first, exactly as before; both rows are on the reminders list,
       * which is where either of them actually gets worked. Overwriting would
       * silently repoint the promise at the errand.
       */
      reminderId = reminderId ?? actionReminderId;
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
        /* The priority a telecaller is told — and the severity it sets — is
           PR #358's (`complaint-vocabulary`), which gives `severity` a
           `critical` member of its own and recomputes the SLA from when the
           complaint was raised. Until that lands this stays the configured
           default, exactly as it always was. */
        const severity = config["complaints.defaultSeverity"];
        const slaHours = config["complaints.slaHours"][severity];
        /*
         * AND WHAT THEY ARE ASKING FOR IS WHAT ROUTES IT.
         *
         * `assigned_to` has defaulted to "Operations" on every complaint ever
         * raised, which is not a routing decision but the absence of one. A
         * replacement is the godown's, a credit note accounts', a technical
         * visit technical — so the desk is DERIVED from the action rather than
         * asked as a second question the telecaller cannot answer. Where no
         * action was given the old default stands, so nothing that does not ask
         * changes behaviour.
         */
        const desk = deskForAction(outcomeDetail.requiredAction);
        await tx.insert(complaints).values({
          id: complaintId,
          customerId: customer.id,
          loggedByUserId: ctx.user.id,
          callId: interactionId,
          category: input.complaintCategory!,
          description: complaintText,
          severity,
          requiredAction: outcomeDetail.requiredAction ?? null,
          ...(desk ? { assignedTo: desk } : {}),
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
      callerRole: input.callerRole ?? null,
      callerName: input.callerName?.trim() || null,
      callReason: input.callReason ?? null,
      /*
       * An empty object and null are different answers: null is a reason that
       * asks nothing (Place an Order, Follow-up on Previous Discussion), and
       * `{}` would read as a reason that asked and got nothing back.
       */
      reasonDetail: Object.keys(reasonDetail).length ? reasonDetail : null,
      outcomeDetail: Object.keys(outcomeDetail).length ? outcomeDetail : null,
      callAttempt,
      nextActions,
      nextActionDate: input.nextActionDate ?? null,
      sourceModule: input.sourceModule,
      queuePosition: input.queuePosition ?? null,
      orderId,
      reminderId,
      complaintId,
      idempotencyKey: input.idempotencyKey,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });

    /* -------------------------------------------- the opportunity it found
     *
     * Written BEFORE the timeline block below, because that block names this
     * row as its source and a timeline entry pointing at a record that is not
     * there yet is the whole thing `sourceRecordId` exists to prevent.
     *
     * Deliberately NOT a lead: a lead here is an account that has never
     * ordered, and about thirty readers of `customers.kind` are built on
     * exactly that — so an opportunity spotted on a call with a customer of
     * four years cannot be one without making every one of them wrong.
     */
    let opportunityId: string | null = null;
    if (input.opportunity) {
      opportunityId = id("opp");
      await tx.insert(callOpportunities).values({
        id: opportunityId,
        customerId: customer.id,
        callId: interactionId,
        userId: ctx.user.id,
        product: input.opportunity.product.trim(),
        estimatedQuantity: input.opportunity.estimatedQuantity?.trim() || null,
        /*
         * Rupees in, paise stored — money is paise everywhere here. Null and
         * zero are different answers: null is nobody having put a figure on
         * it, and zero would read as an opportunity judged worthless.
         */
        estimatedValuePaise:
          input.opportunity.estimatedValueRupees === undefined
            ? null
            : input.opportunity.estimatedValueRupees * 100,
        expectedOrderDate: input.opportunity.expectedOrderDate || null,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      produced.push("opportunity");
    }

    /* ------------------------------------- the promises this call settles */
    /*
     * A reminder is closed by the evidence that it was kept, and this is the
     * commonest piece of evidence there is — see
     * `lib/engines/reminder-closure.ts` for the rule and why the manual
     * button was not good enough.
     *
     * In THIS transaction, for the same reason the timeline entry below is:
     * a promise closed by a call that rolled back is a promise nobody is
     * chasing and a conversation that never happened.
     *
     * `no_answer` closes nothing. The customer still owes us the
     * conversation, and a list that can be emptied by dialling and hanging up
     * is the button we just took away wearing a different hat.
     *
     * `reminderId` is excluded because the branches above may have just
     * written tomorrow's promise from this very call, and an event must never
     * close the thing it created.
     *
     * AND AN ORDER RECEIVED IS NOT A CALL, which this file's own enum says in
     * as many words: it arrived by WhatsApp or the ERP with nobody speaking to
     * anybody. "He said he will ring me at three" is not answered by a
     * WhatsApp order landing, and treating it as one would close promises on
     * conversations that never happened — the exact failure the manual button
     * produced. The order itself still closes what an order settles, below.
     */
    if (!isOrderReceived) {
      remindersClosed = await closeRemindersOnEvidence(tx, {
        customerId: customer.id,
        event: {
          kind: "call",
          on: day,
          answered: input.outcome !== "no_answer",
        },
        sourceId: interactionId,
        actorId: ctx.user.id,
        exclude: [reminderId],
      });
    }

    /*
     * AND AN ORDER CLOSES THE PROMISE TO CONFIRM ONE, whatever day it was due.
     *
     * Separate from the call above rather than folded into it: the call rule
     * needs the reminder to be DUE, and this one deliberately does not. An
     * order confirmation promised for Friday is met by the order arriving on
     * Tuesday, and holding it open until Friday would put a call on somebody's
     * list about an order already on the book.
     */
    if (orderId) {
      remindersClosed += await closeRemindersOnEvidence(tx, {
        customerId: customer.id,
        event: { kind: "order", on: day },
        sourceId: orderId,
        actorId: ctx.user.id,
        exclude: [reminderId],
      });
    }

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
      ...(opportunityId && input.opportunity
        ? [
            {
              customerId: customer.id,
              eventType: CRM_EVENT.opportunity,
              sourceApp: "crm" as const,
              sourceRecordId: opportunityId,
              occurredAt: now,
              actorUserId: ctx.user.id,
              /*
               * `call_opportunities` has no screen of its own to be worked on
               * yet. This is what stops it being a record nobody can see — the
               * opportunity lands on the customer record, where the next
               * person to read the account finds it.
               */
              summary: opportunitySummary(input.opportunity),
            },
          ]
        : []),
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

    /*
     * "DO NOT CALL US AGAIN" IS A STANDING INSTRUCTION, not an outcome.
     *
     * `do_not_contact` outranks every reason the queue can produce — including
     * a reminder, which outranks everything else — so this is the single most
     * consequential thing a telecaller can write from this panel, and it is the
     * one the customer asked for in as many words. It is written here rather
     * than left to somebody to set afterwards precisely because "somebody will
     * do it later" is how a customer who asked to be left alone gets rung again
     * next Tuesday.
     *
     * It is set and never CLEARED: the other two answers are this call's
     * verdict, and a customer who asked to be left alone last year did not
     * change their mind by being marked "possible later" today. Lifting it is a
     * deliberate act on the customer record, where somebody can see what they
     * are undoing.
     */
    const askedNotToBeCalled =
      outcomeDetail.futureOpportunity === NEVER_CALL_AGAIN;
    if (askedNotToBeCalled && !customer.doNotContact) {
      set.doNotContact = true;
      produced.push("do-not-contact");
    }

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

      // A lead becomes a customer on its SECOND order, which is the client's
      // own correction of the rule this used to apply. A first order from a
      // shop that has just finished a trial is a few cans to try in their own
      // booth; it is the end of the trial rather than the start of a
      // relationship, and it routinely does not repeat.
      //
      // The order just written is excluded from the count by id, so the
      // question is strictly "have they ordered before" — and what counts as
      // an order is `lib/order-status.ts`, so an order accounts declined can
      // never promote anybody.
      //
      // The person who found them becomes the sales account manager. Back
      // office is deliberately left unassigned: who handles the dispatch and
      // billing is a decision, not something to guess at.
      if (customer.kind === "lead" && (await hasOrderedBefore(tx, customer.id, orderId))) {
        /*
         * Through `lead-conversion-service`, which is the ONE definition of
         * what happens when a lead orders. MBOS converts on its own order path
         * too, and two copies of this would drift within a release — the half
         * that drifts being whichever nobody is watching.
         *
         * Spread into the update this function is already building rather than
         * issued as a second statement: twenty other fields are going in the
         * same write.
         */
        Object.assign(set, conversionColumns(customer, orderedOn));
        converted = true;
      }
    }
    await tx.update(customers).set(set).where(eq(customers.id, customer.id));

    // Converting a lead changes who the record answers to and what every
    // screen shows for it. That is worth its own audit line rather than
    // hiding inside the interaction's.
    if (converted) {
      produced.push("converted-to-customer");
      /* The audit line AND the timeline entry, both from the shared service —
         a conversion the customer record cannot show is one nobody reading
         their history would ever know happened. */
      await recordConversion(
        tx,
        customer,
        ctx.user.id,
        set.salesAmId ?? null,
        "ordered on a call",
      );
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
        /* The two answers with consequences beyond this call: a standing
           instruction that silences every future one, and the coded reason a
           report is going to be built on. Both belong in the audit row rather
           than only on the call, because "who marked this customer do-not-
           contact, and when" is asked about the customer, not the call. */
        ...(askedNotToBeCalled ? { doNotContact: true } : {}),
        ...(Object.keys(outcomeDetail).length ? { outcomeDetail } : {}),
        produced,
        // Promises this call closed. The reminders themselves point back at
        // this interaction; this is the same fact from the other end, so
        // "which promises did that call settle" is answerable without a join.
        remindersClosed,
      } as never,
    });
  });

  /* --------------------------------------------- post-commit recomputation */

  if (orderId) {
    await recomputeBuyingCycle(customer.id);
    // THIS CUSTOMER, not the book. An order cannot move anybody else's
    // inactivity, and the unscoped pass was ~5,900 queries awaited in series
    // between the telecaller pressing Save and the confirmation appearing.
    await recomputeInactivity(customer.id);
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
      remindersClosed,
      nextStep: step,
    },
    /*
     * SAID OUT LOUD, because a promise disappearing off a list without a word
     * is indistinguishable from one that was lost. The telecaller closed it by
     * making the call, which is the whole point, and being told so is what
     * teaches them the list keeps itself.
     */
    complaintUpdated
      ? "Added to the open complaint"
      : remindersClosed
        ? `Interaction saved - ${remindersClosed} reminder${remindersClosed === 1 ? "" : "s"} closed`
        : "Interaction saved",
    warnings,
  );
}
