import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  bills,
  calls,
  complaintStatusHistory,
  complaints,
  customers,
  followUpAttempts,
  followUpStates,
  payments,
  reminders,
  waTemplates,
} from "@/db/schema";
import { resolveScope, assertCustomerInScope } from "../access-control";
import { getConfig } from "../config/store";
import { isAttemptAllowed } from "../engines/escalation";
import { addDays, onOrAfterWorkingDay } from "../business-date";
import {
  recomputeBillStatuses,
  recomputeFollowUpState,
  recomputeOutstanding,
  today,
} from "../recompute";
import { err, ok, type Result } from "../result";
import { getFollowUpDetail, getPaymentFollowUpPlan } from "./payment-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ---------------------------------------------------------------------------
 * Logging a collections call.
 *
 * One outcome, one transaction. A collections call can produce a promise and
 * its reminder, a payment spread across bills, a billing complaint, or a
 * raised stage floor — and a half-saved one leaves the account describing
 * something that never happened.
 *
 * The outcomes are the seven a telecaller actually reports. What each one
 * requires and what it creates is declared once, here, so the screen and the
 * server cannot disagree about which fields are mandatory.
 * ------------------------------------------------------------------------- */

export type PayOutcomeKey =
  | "promised"
  | "part"
  | "paid"
  | "callback"
  | "dispute"
  | "refused"
  | "noanswer";

export type PayOutcomeDefinition = {
  key: PayOutcomeKey;
  label: string;
  /** An amount is required, and what the field is called when it is. */
  amount: false | string;
  /** A date is required, and what the field is called when it is. */
  date: false | string;
  /** Raises the stage floor by one — they told you something their bill dates did not. */
  escalates: boolean;
  /** Offered as chips; the telecaller can still type anything. */
  chips: string[];
  /** What saving it will do, said before they press save. */
  consequence: string | null;
};

export const PAY_OUTCOMES: PayOutcomeDefinition[] = [
  {
    key: "promised",
    label: "Payment promised",
    amount: "Amount promised",
    date: "Promised by",
    escalates: false,
    chips: [
      "Cheque ready",
      "NEFT today",
      "Accounts processing",
      "Will pay tomorrow",
      "Collect from shop",
    ],
    consequence: "A reminder is created for the day after, so the promise is chased.",
  },
  {
    key: "part",
    label: "Part payment promised",
    amount: "Amount promised",
    date: "Promised by",
    escalates: false,
    chips: [
      "Balance after next delivery",
      "Cash flow tight",
      "Paying against oldest bill",
      "Rest by month end",
    ],
    consequence: "A reminder is created for the day after, so the promise is chased.",
  },
  {
    key: "paid",
    label: "Already paid",
    amount: "Amount already paid",
    date: false,
    escalates: false,
    chips: [
      "NEFT done, sending UTR",
      "Cheque couriered",
      "Paid at the depot",
      "Check with accounts",
    ],
    consequence:
      "The amount is applied to the oldest bills first, and the outstanding figure updates everywhere.",
  },
  {
    key: "callback",
    label: "Call back later",
    amount: false,
    date: "Call back on",
    escalates: false,
    chips: [
      "Owner travelling",
      "Accounts person on leave",
      "Asked to call after 4 pm",
      "Festival closure",
    ],
    consequence: "A reminder is created for that date so this is chased.",
  },
  {
    key: "dispute",
    label: "Dispute raised",
    amount: false,
    date: false,
    escalates: false,
    chips: [
      "Rate charged is wrong",
      "Short supply not credited",
      "Bill not received",
      "Credit note pending",
    ],
    consequence:
      "A billing complaint is raised, and the account holds at its current stage until it is closed.",
  },
  {
    key: "refused",
    label: "Refused to commit",
    amount: false,
    date: false,
    escalates: true,
    chips: [
      "No date given",
      "Says business is slow",
      "Wants credit extension",
      "Disputes the ledger",
    ],
    consequence: null,
  },
  {
    key: "noanswer",
    label: "Not reachable",
    amount: false,
    date: false,
    escalates: true,
    chips: ["Phone rang", "Switched off", "Busy", "Number not in use"],
    consequence: null,
  },
];

export function payOutcome(key: string): PayOutcomeDefinition | undefined {
  return PAY_OUTCOMES.find((o) => o.key === key);
}

export const logFollowUpSchema = z.object({
  customerId: z.string().min(1),
  outcome: z.enum([
    "promised",
    "part",
    "paid",
    "callback",
    "dispute",
    "refused",
    "noanswer",
  ]),
  /** Whole rupees from the form; stored as paise. */
  amount: z.coerce.number().int().positive().optional(),
  date: z.string().optional(),
  notes: z.string().max(4000).optional(),
  chips: z.array(z.string()).default([]),
  idempotencyKey: z.string().min(8),
});

export type LogFollowUpInput = z.input<typeof logFollowUpSchema>;

export type LogFollowUpResult = {
  attemptId: string;
  produced: string[];
  /** True when the account left the worklist because the payment cleared it. */
  cleared: boolean;
};

export async function logPaymentFollowUp(
  raw: LogFollowUpInput,
): Promise<Result<LogFollowUpResult>> {
  const parsed = logFollowUpSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(issue.message, "validation", [
      { field: issue.path.join("."), message: issue.message },
    ]);
  }
  const input = parsed.data;
  const def = payOutcome(input.outcome)!;

  const ctx = await resolveScope();
  const config = await getConfig();
  const day = await today();

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, input.customerId));
  if (!customer) return err("That customer no longer exists.", "not_found");
  await assertCustomerInScope(customer);

  /* ------------------------------------------------------------ validation */

  if (def.amount && !input.amount) {
    return err(`Enter the ${def.amount.toLowerCase()}.`, "validation", [
      { field: "amount", message: `Enter the ${def.amount.toLowerCase()}.` },
    ]);
  }
  if (def.date && !input.date) {
    return err(`Pick the ${def.date.toLowerCase()} date.`, "validation", [
      { field: "date", message: "Pick the date — it becomes the reminder that chases this." },
    ]);
  }
  if (def.date && input.date && input.date < day) {
    return err("That date has already passed.", "validation", [
      { field: "date", message: "The date cannot be in the past." },
    ]);
  }

  const [state] = await db
    .select()
    .from(followUpStates)
    .where(eq(followUpStates.customerId, input.customerId));
  if (!state) {
    return err(
      "That customer has nothing overdue — they are not on the collections worklist.",
      "rule_violation",
    );
  }

  // Every outcome here is reported from a call, so the stage-1 rule applies to
  // all of them. Checked server-side; a disabled button is not a rule.
  const allowed = isAttemptAllowed(state.stage as 1 | 2 | 3, "call");
  if (!allowed.allowed) return err(allowed.error, "rule_violation");

  const [dupe] = await db
    .select({ id: followUpAttempts.id })
    .from(followUpAttempts)
    .where(eq(followUpAttempts.idempotencyKey, input.idempotencyKey));
  if (dupe) {
    return ok(
      { attemptId: dupe.id, produced: [], cleared: false },
      "Already recorded",
    );
  }

  /* ---------------------------------------------------------- open balances */

  const openBills = await db
    .select()
    .from(bills)
    .where(
      and(
        eq(bills.customerId, input.customerId),
        gt(sql`${bills.amount} - ${bills.paidAmount}`, 0),
      ),
    )
    .orderBy(bills.billDate);

  const amountPaise = input.amount ? input.amount * 100 : 0;
  const openTotal = openBills.reduce((sum, b) => sum + (b.amount - b.paidAmount), 0);

  if (input.outcome === "paid") {
    if (!openBills.length) {
      return err("There are no open bills to apply a payment to.", "rule_violation");
    }
    if (amountPaise > openTotal) {
      return err(
        `That is more than the ₹${Math.round(openTotal / 100).toLocaleString("en-IN")} still open on this account.`,
        "validation",
        [{ field: "amount", message: "Cannot exceed the open balance." }],
      );
    }
  }

  /* --------------------------------------------------------- the transaction */

  const attemptId = id("fua");
  const produced: string[] = [];
  const now = new Date();
  const notes =
    input.notes?.trim() ||
    [def.label, ...input.chips].filter(Boolean).join(". ");

  await db.transaction(async (tx) => {
    /* ---- the attempt itself, always ---- */
    await tx.insert(followUpAttempts).values({
      id: attemptId,
      customerId: input.customerId,
      stage: state.stage,
      channel: "call",
      attemptedAt: now,
      userId: ctx.user.id,
      outcome: def.label,
      promisedAmount:
        input.outcome === "promised" || input.outcome === "part" ? amountPaise : null,
      promisedDate:
        input.outcome === "promised" || input.outcome === "part"
          ? (input.date ?? null)
          : null,
      idempotencyKey: input.idempotencyKey,
      createdById: ctx.user.id,
    });

    // The call belongs in the interaction log too, attributed to this module —
    // reporting has to be able to tell collections from routine calling.
    await tx.insert(calls).values({
      id: id("ixn"),
      customerId: input.customerId,
      userId: ctx.user.id,
      interactionType: "outbound_call",
      outcome: input.outcome === "noanswer" ? "no_answer" : "payment_promised",
      startedAt: now,
      notes,
      sourceModule: "payment_follow_up",
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });

    /* ---- a promise, and the reminder that chases it ---- */
    if ((input.outcome === "promised" || input.outcome === "part") && input.date) {
      const due = onOrAfterWorkingDay(addDays(input.date, 1), {
        timezone: config["workingDay.timezone"],
        dayBoundaryHour: config["workingDay.dayBoundaryHour"],
        workingDays: config["workingDay.workingDays"],
      });
      await tx.insert(reminders).values({
        id: id("rem"),
        customerId: input.customerId,
        createdByUserId: ctx.user.id,
        assignedUserId: ctx.user.id,
        dueDate: due,
        note: `Collect ₹${Math.round(amountPaise / 100).toLocaleString("en-IN")} promised for ${input.date}`,
        type: "payment_promise",
        systemGenerated: true,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      produced.push("reminder");
      produced.push("promise");
    }

    /* ---- a callback the customer asked for ---- */
    if (input.outcome === "callback" && input.date) {
      await tx.insert(reminders).values({
        id: id("rem"),
        customerId: input.customerId,
        createdByUserId: ctx.user.id,
        assignedUserId: ctx.user.id,
        dueDate: input.date,
        note: notes,
        type: "call_back",
        systemGenerated: true,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      produced.push("reminder");
    }

    /* ---- money already paid, applied oldest bill first ---- */
    if (input.outcome === "paid" && amountPaise > 0) {
      let left = amountPaise;
      for (const b of openBills) {
        if (left <= 0) break;
        const balance = b.amount - b.paidAmount;
        const take = Math.min(left, balance);
        await tx.insert(payments).values({
          id: id("pay"),
          billId: b.id,
          customerId: input.customerId,
          amount: take,
          paidAt: day,
          mode: "Reported on a collections call",
          reference: input.notes?.trim() || null,
          // One key per bill, so a retried save cannot double-apply any of them.
          externalRef: `${input.idempotencyKey}:${b.id}`,
          recordedById: ctx.user.id,
          createdById: ctx.user.id,
          updatedById: ctx.user.id,
        });
        await tx
          .update(bills)
          .set({ paidAmount: b.paidAmount + take, updatedAt: now })
          .where(eq(bills.id, b.id));
        left -= take;
      }
      produced.push("payment");
    }

    /* ---- a dispute is a complaint, not a note ---- */
    if (input.outcome === "dispute") {
      const complaintId = id("cmp");
      const severity = config["complaints.defaultSeverity"];
      const slaHours = config["complaints.slaHours"][severity];
      await tx.insert(complaints).values({
        id: complaintId,
        customerId: input.customerId,
        loggedByUserId: ctx.user.id,
        category: "billing_issue",
        description: notes,
        severity,
        slaDueAt: new Date(now.getTime() + slaHours * 3_600_000),
        billId: openBills[0]?.id ?? null,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      await tx.insert(complaintStatusHistory).values({
        id: id("csh"),
        complaintId,
        fromStatus: null,
        toStatus: "open",
        changedById: ctx.user.id,
        note: `Raised on a collections call by ${ctx.user.name}`,
      });
      // The disputed bill is what holds the account at its stage — E3 reads
      // this flag, so the hold and the complaint cannot get out of step.
      if (openBills[0]) {
        await tx
          .update(bills)
          .set({ disputed: true, updatedAt: now })
          .where(eq(bills.id, openBills[0].id));
      }
      produced.push("complaint");
    }

    /* ---- a refusal raises the floor ---- */
    const raisesTo = def.escalates ? Math.min(3, state.stage + 1) : null;
    await tx
      .update(followUpStates)
      .set({
        lastChannel: "call",
        lastFollowUpAt: now,
        ...(raisesTo && raisesTo > (state.manualStageFloor ?? 0)
          ? {
              manualStageFloor: raisesTo,
              floorReason: `${def.label} on ${day}`,
              floorSetAt: now,
              floorSetById: ctx.user.id,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(followUpStates.customerId, input.customerId));
    if (raisesTo && raisesTo > (state.manualStageFloor ?? 0)) produced.push("escalation");

    await tx
      .update(customers)
      .set({ lastContactDate: day, lastCallDate: day, updatedAt: now })
      .where(eq(customers.id, input.customerId));

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "followup.log",
      entityType: "customer",
      entityId: input.customerId,
      afterState: {
        outcome: def.label,
        amount: amountPaise || null,
        date: input.date ?? null,
        produced,
      } as never,
    });
  });

  /* ------------------------------------------------------------- recompute */

  if (input.outcome === "paid") {
    await recomputeBillStatuses();
    await recomputeOutstanding(input.customerId);
  }
  await recomputeFollowUpState(input.customerId);

  const [after] = await db
    .select({ customerId: followUpStates.customerId })
    .from(followUpStates)
    .where(eq(followUpStates.customerId, input.customerId));

  return ok(
    { attemptId, produced, cleared: !after },
    !after
      ? `${customer.name} is fully paid and has left the follow-up list`
      : "Follow-up logged",
  );
}

/* --------------------------------------------------------- the stage 1 batch */

export type BatchCandidates = {
  templateId: string | null;
  templateName: string | null;
  customerIds: string[];
};

/**
 * Who a stage 1 batch would actually go to: the customers at stage 1 who are
 * due a reminder today. Stage alone is not enough — messaging somebody
 * reminded two days ago is exactly what the cadence exists to prevent, so the
 * batch and the Message today tab always name the same people.
 */
export async function stageOneBatch(): Promise<BatchCandidates> {
  const plan = await getPaymentFollowUpPlan();
  const due = new Set(plan.messages.map((m) => m.customerId));
  if (!due.size) return { templateId: null, templateName: null, customerIds: [] };

  const rows = await db
    .select({ customerId: followUpStates.customerId, stage: followUpStates.stage })
    .from(followUpStates);
  const customerIds = rows
    .filter((r) => r.stage === 1 && due.has(r.customerId))
    .map((r) => r.customerId);

  const [template] = await db
    .select()
    .from(waTemplates)
    .where(
      and(
        eq(waTemplates.category, "payment_reminder"),
        eq(waTemplates.escalationStage, 1),
        eq(waTemplates.active, true),
      ),
    );

  return {
    templateId: template?.id ?? null,
    templateName: template?.name ?? null,
    customerIds,
  };
}

/* ------------------------------------------------- everything the modal shows */

export type FollowUpPanelData = {
  customerId: string;
  name: string;
  contactPerson: string;
  phone: string;
  city: string;
  ownerName: string | null;
  stage: number;
  stageName: string;
  slowPayer: boolean;
  doNotContact: boolean;
  held: boolean;
  heldReason: string | null;
  floorReason: string | null;
  totalOverdue: number;
  overdueBillCount: number;
  oldestOverdueDays: number;
  lastFollowUpAt: string | null;
  nextChannel: "whatsapp" | "call";
  nextAction: string;
  creditDays: number;
  bills: Array<{
    id: string;
    billNo: string;
    billDate: string;
    dueDate: string;
    amount: number;
    paid: number;
    balance: number;
    overdueDays: number;
    disputed: boolean;
  }>;
  promises: Array<{ amount: number; date: string; note: string | null; broken: boolean }>;
  recent: Array<{ at: string; channel: string; outcome: string | null; note: string | null }>;
};

const STAGE_NAME: Record<number, string> = {
  1: "WhatsApp nudge",
  2: "WhatsApp and calls",
  3: "Urgent — call, firm",
};

const NEXT_ACTION: Record<number, string> = {
  1: "Send the stage 1 nudge",
  2: "Call and get a dated promise",
  3: "Call — urgent",
};

/**
 * One read for the whole modal. The bills are the truth: the outstanding
 * figure, the bill count and the oldest age all come from them, so the row,
 * the context bar and the message cannot contradict each other.
 */
export async function getFollowUpPanel(
  customerId: string,
): Promise<FollowUpPanelData | null> {
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!customer) return null;
  await assertCustomerInScope(customer);

  const config = await getConfig();
  const day = await today();

  const [state] = await db
    .select()
    .from(followUpStates)
    .where(eq(followUpStates.customerId, customerId));
  if (!state) return null;

  const [ownerRow] = await db.execute<{ name: string }>(
    sql`select name from users where id = ${customer.salesAmId ?? customer.ownerId}`,
  );

  const detail = await getFollowUpDetail(customerId);
  const openBills = (detail?.bills ?? []).filter((b) => b.balance > 0);

  const attempts = await db
    .select()
    .from(followUpAttempts)
    .where(eq(followUpAttempts.customerId, customerId))
    .orderBy(desc(followUpAttempts.attemptedAt))
    .limit(20);

  const recent = await db
    .select({
      at: calls.startedAt,
      type: calls.interactionType,
      outcome: calls.outcome,
      notes: calls.notes,
      source: calls.sourceModule,
    })
    .from(calls)
    .where(eq(calls.customerId, customerId))
    .orderBy(desc(calls.startedAt))
    .limit(3);

  return {
    customerId,
    name: customer.name,
    contactPerson: customer.contactPerson,
    phone: customer.phone,
    city: customer.city,
    ownerName: ownerRow?.name ?? null,
    stage: state.stage,
    stageName: STAGE_NAME[state.stage] ?? "",
    slowPayer: customer.slowPayer,
    doNotContact: customer.doNotContact,
    held: state.held,
    heldReason: state.heldReason,
    floorReason: state.manualStageFloor ? state.floorReason : null,
    totalOverdue: openBills.reduce((sum, b) => sum + b.balance, 0),
    overdueBillCount: openBills.filter((b) => b.overdueDays > 0).length,
    oldestOverdueDays: openBills.reduce((max, b) => Math.max(max, b.overdueDays), 0),
    lastFollowUpAt: state.lastFollowUpAt?.toISOString() ?? null,
    nextChannel: state.nextChannel,
    nextAction: state.held
      ? "Held — dispute open"
      : (NEXT_ACTION[state.stage] ?? "Follow up"),
    creditDays: customer.creditDays ?? config["customers.defaultCreditDays"],
    bills: openBills.map((b) => ({
      id: b.id,
      billNo: b.billNo,
      billDate: b.billDate,
      dueDate: b.effectiveDueDate,
      amount: b.amount,
      paid: b.paidAmount,
      balance: b.balance,
      overdueDays: b.overdueDays,
      disputed: b.disputed,
    })),
    promises: attempts
      .filter((a) => a.promisedDate && a.promisedAmount)
      .slice(0, 5)
      .map((a) => ({
        amount: Number(a.promisedAmount),
        date: a.promisedDate!,
        note: a.outcome,
        broken: a.promisedDate! < day,
      })),
    recent: recent.map((r) => ({
      at: r.at.toISOString(),
      channel: r.source === "payment_follow_up" ? "Collections" : "Call",
      outcome: r.outcome,
      note: r.notes,
    })),
  };
}
