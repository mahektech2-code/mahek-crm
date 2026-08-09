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
  /** Last call that ended in no order. Starts the re-ask cooldown. */
  lastNoOrderDate: BusinessDate | null;

  /**
   * Open on the Inactive Watch — past twice their own buying cycle with no
   * order, and nobody has decided what to do about them yet.
   */
  onInactiveWatch: boolean;

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
  | "queue.prospectIntervalDays"
  | "queue.whatsappCooldownDays"
  | "queue.quietDaysAfterOrder"
  | "queue.leadPercent"
  | "queue.leadMinDays"
  | "queue.leadMaxDays"
  | "queue.noOrderCooldownDays"
  | "queue.excludeActiveInOrderSystem"
  | "queue.excludeCalledToday"
  | "queue.excludeInactiveWatch"
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
    const all = reasonsFor(c, today, config, weights);
    if (!all.length) continue;

    // A reminder is a promise the telecaller made. It overrides the quiet
    // window and the no-order cooldown, but not do-not-contact.
    const hasReminderReason = all.some(
      (r) => r.kind === "reminderOverdue" || r.kind === "reminderDueToday",
    );

    // The quiet window silences ORDER CHASING, not the customer. A fast-cycling
    // customer still gets their weekly check-in inside it — that call is "is
    // everything running fine", not "please place an order", and the two must
    // not be confused. So the order reasons are stripped rather than the whole
    // customer suppressed, and what the telecaller sees is the call they are
    // actually making.
    const quiet = quietWindow(c, today, config, hasReminderReason);
    const reasons = quiet ? all.filter((r) => !isOrderChasing(r.kind)) : all;

    if (!reasons.length) {
      // Nothing but order chasing, and the window says not yet. Shown rather
      // than dropped: a customer late by their own cycle would otherwise
      // vanish with no explanation.
      suppressed.push({
        customerId: c.customerId,
        name: c.name,
        reason: quiet!,
      });
      continue;
    }

    // Suppression is a return value, not a filter. The interface has a strip
    // that explains who is missing and why; silently dropping them would
    // remove a telecaller's ability to understand their own queue.
    const held = suppressionReason(c, today, config, hasReminderReason);
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
        label: `Reminder ${late} day${late === 1 ? "" : "s"} overdue - ${r.note}`,
        weight: weights.reminderOverdue,
      });
    } else if (r.dueDate === today) {
      reasons.push({
        kind: "reminderDueToday",
        label: `Reminder due today - ${r.note}`,
        weight: weights.reminderDueToday,
      });
    }
  }

  /* ---- order due ---- */
  //
  // The call day comes from the customer's OWN cycle, not from a fixed lead:
  // a 60-day bulk buyer needs more notice than a 20-day one, because their
  // reorder date is less precise to begin with. Capped at both ends so a very
  // short cycle still gets some warning and a very long one is not chased
  // three weeks early.
  //
  // Only a MEASURED cycle earns this treatment. Applying "call on day 18" to
  // a cycle we guessed from one order is false precision — those customers
  // fall through to the check-in rule below.
  if (c.lastOrderDate && !c.cycleIsDefault) {
    const expected = addDays(c.lastOrderDate, c.cycleDays);
    const sinceOrder = daysBetween(c.lastOrderDate, today);

    if (sinceOrder >= callDayFor(c.cycleDays, config)) {
      if (today > expected) {
        const overdueDays = daysBetween(expected, today);
        const cyclesMissed = Math.floor(overdueDays / Math.max(1, c.cycleDays));
        if (cyclesMissed >= 1) {
          reasons.push({
            kind: "orderOverdueFullCycle",
            label: `Order overdue by ${cyclesMissed} full cycle${cyclesMissed === 1 ? "" : "s"} - expected ${expected}`,
            weight: weights.orderOverdueFullCycle,
          });
        } else {
          reasons.push({
            kind: "orderDue",
            label: `Order overdue by ${overdueDays} day${overdueDays === 1 ? "" : "s"} - expected ${expected}`,
            weight: weights.orderDue,
          });
        }
      } else if (today === expected) {
        reasons.push({
          kind: "orderDue",
          label: `Order due today - ${c.cycleDays}-day cycle`,
          weight: weights.orderDue,
        });
      } else {
        const inDays = daysBetween(today, expected);
        reasons.push({
          kind: "orderDueSoon",
          label: `Orders every ${c.cycleDays} days - next one due in ${inDays} day${inDays === 1 ? "" : "s"}`,
          weight: weights.orderDueSoon,
        });
      }
    }
  }

  /* ---- prospect ---- */
  // Never ordered. Worked on its own short cadence, because converting a
  // first order is the growth work and there is no cycle to wait for.
  if (!c.lastOrderDate) {
    const since = c.lastContactDate ?? c.createdDate;
    const daysSince = daysBetween(since, today);
    if (daysSince >= config["queue.prospectIntervalDays"]) {
      reasons.push({
        kind: "prospect",
        label: c.lastContactDate
          ? `Never ordered - ${daysSince} days since last contact`
          : `Never ordered - on the book ${daysSince} days, never contacted`,
        weight: weights.prospect,
      });
    }
  }

  /* ---- check-in due ---- */
  //
  // Two kinds of customer, one cadence.
  //
  // Customers who reorder faster than the quiet window are never chased for an
  // order — they are the good ones and they order on their own. But going
  // silent on your best customers for weeks is how you lose them, so they get
  // a weekly call that asks whether everything is running fine and whether
  // they need anything, not whether they will place an order.
  //
  // Customers whose cycle could not be measured yet get the same cadence for a
  // different reason: there is no cycle to time a call from.
  //
  // Customers with a measured cycle of 15 days or more get neither — their
  // cycle already says when to call, and adding a weekly check-in on top would
  // mean ringing a 60-day buyer eight times before their order is due.
  const fastCycling =
    !c.cycleIsDefault && c.cycleDays < config["queue.quietDaysAfterOrder"];
  if (c.lastOrderDate && (c.cycleIsDefault || fastCycling)) {
    // When contact was last made, as well as it can be known. An ORDER is
    // contact — somebody spoke to them to take it — and for a book imported
    // from elsewhere it is the only evidence there is. Falling straight to the
    // record's creation date dates a customer of four years from the afternoon
    // their row was written, which holds an entire imported book off the queue
    // for a week on the strength of it.
    const since = c.lastContactDate ?? c.lastOrderDate;
    const daysSince = daysBetween(since, today);
    const interval = config["queue.checkInIntervalDays"];

    if (daysSince > interval * 1.5) {
      reasons.push({
        kind: "checkInOverdue",
        label: fastCycling
          ? `Orders every ${c.cycleDays} days - no contact for ${daysSince} days`
          : `No contact for ${daysSince} days - cycle not established yet`,
        weight: weights.checkInOverdue,
      });
    } else if (daysSince >= interval) {
      reasons.push({
        kind: "checkInDue",
        label: fastCycling
          ? `Weekly check-in - orders every ${c.cycleDays} days, ${daysSince} days since last contact`
          : `Check-in due - ${daysSince} days since last contact`,
        weight: weights.checkInDue,
      });
    }
  }

  return reasons;
}

/**
 * How many days after an order the customer becomes worth calling.
 *
 * Lead scales with the cycle and is clamped at both ends. The quiet window is
 * NOT folded in here on purpose — see suppressionReason. Keeping it separate
 * is what lets the screen say "held back until day 15" instead of silently
 * omitting a customer who is late by their own reckoning.
 */
function callDayFor(cycleDays: number, config: QueueConfig): number {
  const lead = Math.min(
    config["queue.leadMaxDays"],
    Math.max(
      config["queue.leadMinDays"],
      Math.round((cycleDays * config["queue.leadPercent"]) / 100),
    ),
  );
  return Math.max(0, cycleDays - lead);
}

/** The order-chasing reasons — the ones the quiet window holds back. */
function isOrderChasing(kind: QueueReasonKind): boolean {
  return (
    kind === "orderDue" ||
    kind === "orderDueSoon" ||
    kind === "orderOverdueFullCycle"
  );
}

/**
 * Why order chasing is held back today, or null if it is not.
 *
 * A customer reordering faster than this window is serving themselves and a
 * call asking for an order adds nothing. They can still be LATE by their own
 * cycle while inside it, which is why this returns a sentence: the screen
 * shows it rather than dropping them without explanation.
 */
function quietWindow(
  c: QueueCandidate,
  today: BusinessDate,
  config: QueueConfig,
  hasReminderReason: boolean,
): string | null {
  if (!c.lastOrderDate || hasReminderReason) return null;
  const quiet = config["queue.quietDaysAfterOrder"];
  const sinceOrder = daysBetween(c.lastOrderDate, today);
  if (sinceOrder >= quiet) return null;
  const left = quiet - sinceOrder;
  return `Orders every ${c.cycleDays} days · ordered ${sinceOrder === 0 ? "today" : `${sinceOrder} day${sinceOrder === 1 ? "" : "s"} ago`} - no order chased for ${left} more day${left === 1 ? "" : "s"}`;
}

function suppressionReason(
  c: QueueCandidate,
  today: BusinessDate,
  config: QueueConfig,
  hasReminderReason: boolean,
): string | null {
  if (c.doNotContact) return "Marked do not contact";

  if (c.skippedTodayReason) return `Skipped today - ${c.skippedTodayReason}`;

  if (config["queue.excludeCalledToday"] && c.calledToday) {
    return "Already called today";
  }

  if (config["queue.excludeActiveInOrderSystem"] && c.activeInOrderSystem) {
    return "Active in the order system";
  }

  // A customer this far past their cycle is worked from the Inactive Watch,
  // which is a different conversation: not "are you ready to reorder" but "why
  // did you stop". Left in the queue they arrive as the most overdue customers
  // on it — every one of them, every day — and bury the customers who are
  // merely due. A reminder still outranks this, because a callback the
  // customer asked for is not chasing.
  if (config["queue.excludeInactiveWatch"] && c.onInactiveWatch && !hasReminderReason) {
    return "On the inactive watch - worked from that list";
  }

  // Asked for an order and told no. Without this a customer past their call
  // day returns to the top of the list every single day until they order,
  // which punishes the telecaller for working it.
  if (c.lastNoOrderDate && !hasReminderReason) {
    const cooldown = config["queue.noOrderCooldownDays"];
    const elapsed = daysBetween(c.lastNoOrderDate, today);
    if (elapsed < cooldown) {
      const left = cooldown - elapsed;
      return `No order ${elapsed === 0 ? "today" : `${elapsed} day${elapsed === 1 ? "" : "s"} ago`} - asking again in ${left} day${left === 1 ? "" : "s"}`;
    }
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
      return `WhatsApp sent ${elapsed === 0 ? "today" : `${elapsed} day${elapsed === 1 ? "" : "s"} ago`} - ${left} day${left === 1 ? "" : "s"} of cooldown left`;
    }
  }

  return null;
}
