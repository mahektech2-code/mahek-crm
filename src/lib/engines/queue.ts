import type { BusinessDate } from "../business-date";
import { addDays, daysBetween } from "../business-date";
import type { Config, QueueReasonKind } from "../config/registry";

/* ---------------------------------------------------------------------------
 * E2 — Queue Builder
 *
 * The most important function in the system: who to call next, ranked, with
 * every held-back customer returned rather than silently dropped.
 *
 * Pure. Candidates and the business date come in; two lists go out. The queue
 * is never persisted — it changes continuously as calls are logged, and a
 * stale stored queue is worse than a slow computed one.
 * ------------------------------------------------------------------------- */

export type QueueCandidate = {
  customerId: string;
  name: string;
  ownerId: string | null;

  /** Ascending order history. Empty means never ordered. */
  lastOrderDate: BusinessDate | null;
  /** From E1. */
  cycleDays: number;
  cycleIsDefault: boolean;

  lastContactDate: BusinessDate | null;
  /** Falls back to record creation when a customer has never been contacted. */
  createdDate: BusinessDate;

  /** Pending reminders assigned to the requesting user. */
  reminders: Array<{ id: string; dueDate: BusinessDate; note: string }>;

  /** Set only on CONFIRMED send. A copied-but-unconfirmed message is never here. */
  lastConfirmedWhatsappDate: BusinessDate | null;
  activeInOrderSystem: boolean;
  calledToday: boolean;
  doNotContact: boolean;
  /** Skipped by hand today, with the reason the telecaller gave. */
  skippedTodayReason: string | null;

  /** Tie-breakers. */
  outstanding: number;
  targetGap: number;
};

export type QueueReason = {
  kind: QueueReasonKind;
  /** Plain language — shown verbatim, so a telecaller never wonders why a name appeared. */
  label: string;
  weight: number;
};

export type QueueEntry = {
  customerId: string;
  name: string;
  score: number;
  /** Every reason the customer qualified, highest weight first. */
  reasons: QueueReason[];
  outstanding: number;
  targetGap: number;
  daysSinceContact: number | null;
};

export type SuppressedEntry = {
  customerId: string;
  name: string;
  /** Plain language, for the "customers held back today" strip. */
  reason: string;
};

export type QueueResult = {
  entries: QueueEntry[];
  suppressed: SuppressedEntry[];
  /** Before truncation, so progress figures stay honest. */
  totalQualified: number;
};

export type QueueConfig = Pick<
  Config,
  | "queue.checkInIntervalDays"
  | "queue.whatsappCooldownDays"
  | "queue.orderDueLeadDays"
  | "queue.excludeActiveInOrderSystem"
  | "queue.excludeCalledToday"
  | "queue.maxSizePerUser"
  | "queue.tierWeights"
>;

export function buildQueue(
  candidates: QueueCandidate[],
  today: BusinessDate,
  config: QueueConfig,
): QueueResult {
  const weights = config["queue.tierWeights"];
  const entries: QueueEntry[] = [];
  const suppressed: SuppressedEntry[] = [];

  for (const c of candidates) {
    const reasons = reasonsFor(c, today, config, weights);
    if (!reasons.length) continue;

    // Suppression is evaluated only for customers who would otherwise appear —
    // and it is a return value, not a filter. The interface has a strip that
    // explains who is missing and why; silently dropping them would remove a
    // telecaller's ability to understand their own queue.
    const held = suppressionReason(c, today, config);
    if (held) {
      suppressed.push({ customerId: c.customerId, name: c.name, reason: held });
      continue;
    }

    reasons.sort((a, b) => b.weight - a.weight);
    entries.push({
      customerId: c.customerId,
      name: c.name,
      score: reasons[0].weight,
      reasons,
      outstanding: c.outstanding,
      targetGap: c.targetGap,
      daysSinceContact: c.lastContactDate
        ? daysBetween(c.lastContactDate, today)
        : null,
    });
  }

  entries.sort(compareEntries);

  const limit = config["queue.maxSizePerUser"];
  return {
    entries: limit > 0 ? entries.slice(0, limit) : entries,
    suppressed,
    totalQualified: entries.length,
  };
}

/** Tie-breakers, in the specified order. */
function compareEntries(a: QueueEntry, b: QueueEntry): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.outstanding !== a.outstanding) return b.outstanding - a.outstanding;
  if (b.targetGap !== a.targetGap) return b.targetGap - a.targetGap;
  const aContact = a.daysSinceContact ?? Number.MAX_SAFE_INTEGER;
  const bContact = b.daysSinceContact ?? Number.MAX_SAFE_INTEGER;
  if (bContact !== aContact) return bContact - aContact;
  return a.customerId.localeCompare(b.customerId); // stable
}

function reasonsFor(
  c: QueueCandidate,
  today: BusinessDate,
  config: QueueConfig,
  weights: Record<QueueReasonKind, number>,
): QueueReason[] {
  const reasons: QueueReason[] = [];

  /* ---- reminder due ---- */
  for (const r of c.reminders) {
    if (r.dueDate < today) {
      const late = daysBetween(r.dueDate, today);
      reasons.push({
        kind: "reminderOverdue",
        label: `Reminder ${late} day${late === 1 ? "" : "s"} overdue — ${r.note}`,
        weight: weights.reminderOverdue,
      });
    } else if (r.dueDate === today) {
      reasons.push({
        kind: "reminderDueToday",
        label: `Reminder due today — ${r.note}`,
        weight: weights.reminderDueToday,
      });
    }
  }

  /* ---- order due ---- */
  // A customer who has never ordered has no expected next order; skip this
  // reason entirely and let the check-in rule carry them.
  if (c.lastOrderDate) {
    const expected = addDays(c.lastOrderDate, c.cycleDays);
    const lead = config["queue.orderDueLeadDays"];

    if (today > expected) {
      const overdueDays = daysBetween(expected, today);
      const cyclesMissed = Math.floor(overdueDays / Math.max(1, c.cycleDays));
      if (cyclesMissed >= 1) {
        reasons.push({
          kind: "orderOverdueFullCycle",
          label: `Order overdue by ${cyclesMissed} full cycle${cyclesMissed === 1 ? "" : "s"} — expected ${expected}`,
          weight: weights.orderOverdueFullCycle,
        });
      } else {
        reasons.push({
          kind: "orderDue",
          label: `Order overdue by ${overdueDays} day${overdueDays === 1 ? "" : "s"} — expected ${expected}`,
          weight: weights.orderDue,
        });
      }
    } else if (today === expected) {
      reasons.push({
        kind: "orderDue",
        label: `Order due today — ${c.cycleDays}-day cycle${c.cycleIsDefault ? " (default)" : ""}`,
        weight: weights.orderDue,
      });
    } else if (daysBetween(today, expected) <= lead) {
      reasons.push({
        kind: "orderDueSoon",
        label: `Order due ${expected}`,
        weight: weights.orderDueSoon,
      });
    }
  }

  /* ---- check-in due ---- */
  const since = c.lastContactDate ?? c.createdDate;
  const daysSince = daysBetween(since, today);
  const interval = config["queue.checkInIntervalDays"];

  if (daysSince > interval * 1.5) {
    reasons.push({
      kind: "checkInOverdue",
      label: c.lastContactDate
        ? `No contact for ${daysSince} days`
        : `Never contacted — on the book ${daysSince} days`,
      weight: weights.checkInOverdue,
    });
  } else if (daysSince > interval) {
    reasons.push({
      kind: "checkInDue",
      label: c.lastContactDate
        ? `Check-in due — ${daysSince} days since last contact`
        : `Check-in due — never contacted`,
      weight: weights.checkInDue,
    });
  }

  return reasons;
}

function suppressionReason(
  c: QueueCandidate,
  today: BusinessDate,
  config: QueueConfig,
): string | null {
  if (c.doNotContact) return "Marked do not contact";

  if (c.skippedTodayReason) return `Skipped today — ${c.skippedTodayReason}`;

  if (config["queue.excludeCalledToday"] && c.calledToday) {
    return "Already called today";
  }

  if (config["queue.excludeActiveInOrderSystem"] && c.activeInOrderSystem) {
    return "Active in the order system";
  }

  // Only a CONFIRMED send suppresses. A copied-but-unconfirmed message means
  // the system does not know it was sent, and suppressing on that would drop
  // customers out of the calling list on the strength of something that may
  // never have happened.
  if (c.lastConfirmedWhatsappDate) {
    const cooldown = config["queue.whatsappCooldownDays"];
    const elapsed = daysBetween(c.lastConfirmedWhatsappDate, today);
    if (elapsed < cooldown) {
      const left = cooldown - elapsed;
      return `WhatsApp sent ${elapsed === 0 ? "today" : `${elapsed} day${elapsed === 1 ? "" : "s"} ago`} — ${left} day${left === 1 ? "" : "s"} of cooldown left`;
    }
  }

  return null;
}
