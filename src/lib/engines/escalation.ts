import type { BusinessDate } from "../business-date";
import { addDays, daysBetween } from "../business-date";
import type { Config } from "../config/registry";

/* ---------------------------------------------------------------------------
 * E3 — Escalation Stage
 *
 * How overdue a customer is, and which channel to use next. Grouped by
 * customer, never by bill: five overdue bills produce one worklist entry.
 *
 * Pure. Bills and the last attempt come in; a stage comes out, or nothing —
 * meaning the customer leaves the collections worklist entirely.
 * ------------------------------------------------------------------------- */

export type EscalationBill = {
  id: string;
  billNo: string;
  billDate: BusinessDate;
  /** Null when the bill carries no due date; the credit period applies instead. */
  dueDate: BusinessDate | null;
  /**
   * The credit period in force for this bill: the term agreed on the order
   * that produced it, or the customer's standing term. Null when neither
   * exists, and the configured default is the last word.
   */
  creditDays?: number | null;
  amount: number;
  paid: number;
  disputed: boolean;
};

export type FollowUpAttempt = {
  channel: "whatsapp" | "call";
  attemptedAt: BusinessDate;
};

export type EscalationState = {
  stage: 1 | 2 | 3;
  daysOverdue: number;
  totalOverdue: number;
  overdueCount: number;
  /** The bill the stage is measured from. */
  anchorBillId: string;
  anchorBillNo: string;
  anchorDueDate: BusinessDate;
  nextChannel: "whatsapp" | "call";
  /** True when a dispute is holding the customer at their current stage. */
  held: boolean;
  heldReason: string | null;
  /** True when the stage is the hand-raised floor rather than the account's age. */
  floored: boolean;
};

export type EscalationConfig = Pick<
  Config,
  | "escalation.stage1Days"
  | "escalation.stage2Days"
  | "escalation.stage3Days"
  | "escalation.stageDriver"
  | "escalation.partialPaymentResetsClock"
  | "escalation.disputeHoldsEscalation"
  | "bills.defaultCreditDays"
>;

/**
 * The stated due date, or the bill date plus the credit period in force.
 *
 * The term is settled when the order is taken, which is where the customer
 * agreed to it — so an order on 45 days does not quietly become 30 because
 * nobody typed a due date onto the bill.
 */
export function effectiveDueDate(
  bill: EscalationBill,
  config: Pick<Config, "bills.defaultCreditDays">,
): BusinessDate {
  if (bill.dueDate) return bill.dueDate;
  return addDays(
    bill.billDate,
    bill.creditDays ?? config["bills.defaultCreditDays"],
  );
}

export function escalationStage(
  bills: EscalationBill[],
  lastAttempt: FollowUpAttempt | null,
  today: BusinessDate,
  config: EscalationConfig,
  /** The stage the customer already sits at, so a dispute can hold it there. */
  currentStage: 1 | 2 | 3 | null = null,
  /**
   * Raised by hand when a customer refuses to commit or cannot be reached.
   * The derived stage still moves with the account's age; it simply never
   * reads below this.
   */
  manualFloor: 1 | 2 | 3 | null = null,
): EscalationState | null {
  const overdue = bills
    .map((b) => ({ bill: b, due: effectiveDueDate(b, config), balance: b.amount - b.paid }))
    .filter((x) => x.balance > 0 && x.due < today);

  // Nothing overdue: the customer leaves the worklist. Full payment therefore
  // removes them immediately, with no separate "close" step.
  if (!overdue.length) return null;

  const anchor =
    config["escalation.stageDriver"] === "largest"
      ? overdue.reduce((a, b) => (b.balance > a.balance ? b : a))
      : overdue.reduce((a, b) => (b.due < a.due ? b : a));

  // A part payment reduces the balance; whether it also resets the age is a
  // business decision, not an implementation detail.
  const ageFrom =
    config["escalation.partialPaymentResetsClock"] && anchor.bill.paid > 0
      ? maxDate(anchor.due, today)
      : anchor.due;
  const daysOverdue = Math.max(0, daysBetween(ageFrom, today));

  const naturalStage = stageFor(daysOverdue, config);

  const disputed = overdue.some((x) => x.bill.disputed);
  const holding = disputed && config["escalation.disputeHoldsEscalation"];
  const beforeFloor = holding ? (currentStage ?? naturalStage) : naturalStage;

  // The floor raises, never lowers. An account that has aged past the floor is
  // driven by its age again, and the floor stops mattering.
  const stage = (manualFloor && manualFloor > beforeFloor
    ? manualFloor
    : beforeFloor) as 1 | 2 | 3;

  return {
    stage,
    daysOverdue,
    totalOverdue: overdue.reduce((sum, x) => sum + x.balance, 0),
    overdueCount: overdue.length,
    anchorBillId: anchor.bill.id,
    anchorBillNo: anchor.bill.billNo,
    anchorDueDate: anchor.due,
    nextChannel: prescribeChannel(stage, lastAttempt),
    held: holding,
    heldReason: holding ? "An overdue bill is disputed - held at the current stage" : null,
    floored: stage > beforeFloor,
  };
}

function stageFor(daysOverdue: number, config: EscalationConfig): 1 | 2 | 3 {
  if (daysOverdue >= config["escalation.stage3Days"]) return 3;
  if (daysOverdue >= config["escalation.stage2Days"]) return 2;
  return 1;
}

/**
 * Stage 1 is a WhatsApp-only nudge, stage 3 is a call, and stage 2 alternates
 * so a customer is not messaged twice running.
 */
export function prescribeChannel(
  stage: 1 | 2 | 3,
  lastAttempt: FollowUpAttempt | null,
): "whatsapp" | "call" {
  if (stage === 1) return "whatsapp";
  if (stage === 3) return "call";
  return lastAttempt?.channel === "whatsapp" ? "call" : "whatsapp";
}

/**
 * Server-side enforcement of the stage 1 rule. A business rule that exists
 * only in the interface is not a business rule.
 */
export function isAttemptAllowed(
  stage: 1 | 2 | 3,
  channel: "whatsapp" | "call",
): { allowed: true } | { allowed: false; error: string } {
  if (stage === 1 && channel === "call") {
    return {
      allowed: false,
      error:
        "Stage 1 is a WhatsApp-only nudge - a call cannot be logged against it. Send the stage 1 message, or wait for the account to reach stage 2.",
    };
  }
  return { allowed: true };
}

/* ------------------------------------------------------------- slow payer */

export type PaidBill = { dueDate: BusinessDate; paidOn: BusinessDate };

/**
 * Counts bills paid well after their due date within the lookback. Evaluated
 * nightly; the flag then appears beside the customer name everywhere.
 *
 * "Well after" is the grace period, and it is the difference between a useful
 * flag and a meaningless one. A payment landing a day or two past its term is
 * ordinary business — a cheque in the post, a bank holiday, an accounts
 * department that pays on Fridays — and counting those marked customers who
 * pay perfectly reliably, just not to the calendar. The flag is read as "be
 * careful with this one", so it has to mean it.
 *
 * Grace applies to the DUE DATE, not to the count: three payments a fortnight
 * late is still a slow payer, however forgiving the first week is.
 */
export function isSlowPayer(
  paidBills: PaidBill[],
  today: BusinessDate,
  config: Pick<
    Config,
    | "escalation.slowPayerLookbackMonths"
    | "escalation.slowPayerLateCount"
    | "escalation.slowPayerGraceDays"
  >,
): { slowPayer: boolean; latePayments: number } {
  const cutoff = addDays(today, -30 * config["escalation.slowPayerLookbackMonths"]);
  const grace = config["escalation.slowPayerGraceDays"];
  const late = paidBills.filter(
    (b) => b.paidOn >= cutoff && b.paidOn > addDays(b.dueDate, grace),
  ).length;
  return {
    slowPayer: late >= config["escalation.slowPayerLateCount"],
    latePayments: late,
  };
}

/* ----------------------------------------------------------------- aging */

/**
 * The bucket label for a balance. Boundaries come from configuration and must
 * align with the escalation thresholds, or the bills screen and the follow-up
 * screen will contradict each other about the same account.
 */
export function agingBucket(
  daysOverdue: number,
  config: Pick<Config, "bills.agingBuckets">,
): string {
  const bounds = config["bills.agingBuckets"];
  if (daysOverdue <= 0) return "Not due";
  for (let i = bounds.length - 1; i >= 0; i--) {
    if (daysOverdue > bounds[i]) {
      const next = bounds[i + 1];
      // Boundaries are exclusive, so a band opens the day AFTER its boundary.
      // The open-ended one said `${bound}+`, which named a day the band below
      // it already owned: with a boundary of 29, day 29 sits in 16–29 and the
      // top band begins on 30.
      return next === undefined
        ? `${bounds[i] + 1}+ days`
        : `${bounds[i] + 1}–${next} days`;
    }
  }
  return `0–${bounds[1] ?? 30} days`;
}

function maxDate(a: BusinessDate, b: BusinessDate): BusinessDate {
  return a > b ? a : b;
}
