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
  /**
   * The last call that got an answer, and what the customer said. Any outcome
   * with a configured cooldown buys quiet for that long — "no order" is the
   * common one, but "not interested" should buy far more than a week.
   */
  lastAnsweredOutcome: string | null;
  lastAnsweredDate: BusinessDate | null;

  /**
   * The unanswered run: how many attempts in a row have gone unanswered, and
   * when the last one was — as an INSTANT, because the first retry is an hour
   * later and a date cannot express that.
   */
  noAnswerCount: number;
  lastNoAnswerAt: string | null;

  /**
   * An order already placed and still working its way through — under
   * process, held, waiting for dispatch. The status as the order system
   * states it, so the screen can show what is actually happening.
   */
  openOrderStatus: string | null;

  /** The collections cadence says a payment call is due today. */
  paymentCallDue: { totalOverdue: number; daysOverdue: number } | null;

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
  | "queue.routineCallPercent"
  | "queue.routineMinCycleDays"
  | "queue.outcomeCooldownDays"
  | "queue.noAnswerRetryHours"
  | "queue.noAnswerRetryDays"
  | "queue.noAnswerMaxAttempts"
  | "queue.includePaymentDue"
  | "queue.showOrderStatus"
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
  /**
   * The instant, for the same-day retry alone. Everything else here works in
   * business dates; an hour-later retry is the one rule that cannot.
   */
  nowMs: number = Date.parse(`${today}T23:59:59+05:30`),
): QueueResult {
  const weights = config["queue.tierWeights"];
  const entries: QueueEntry[] = [];
  const suppressed: SuppressedEntry[] = [];

  for (const c of candidates) {
    const all = reasonsFor(c, today, config, weights, nowMs);
    if (!all.length) continue;

    /*
     * A customer nobody can reach is ONE thing, not a list of things.
     *
     * The ladder is spent, so asking for an order is not the work — deciding
     * what happens to them is: a different number, a different time of day, a
     * visit, or leaving them alone. Presenting them as an ordinary order call
     * beside that would invite a sixth unanswered ring.
     */
    const unreachable = all.find((r) => r.kind === "unreachable");
    if (unreachable) {
      entries.push({
        customerId: c.customerId,
        name: c.name,
        score: unreachable.weight,
        reasons: [unreachable],
        outstanding: c.outstanding,
        targetGap: c.targetGap,
        daysSinceContact: c.lastContactDate
          ? daysBetween(c.lastContactDate, today)
          : null,
      });
      continue;
    }

    // A reminder is a promise the telecaller made. It overrides the quiet
    // window and the no-order cooldown, but not do-not-contact.
    const hasReminderReason = all.some(
      (r) => r.kind === "reminderOverdue" || r.kind === "reminderDueToday",
    );

    // The quiet window silences ORDER CHASING, not the customer. Order reasons
    // are stripped rather than the whole customer suppressed, so a telecaller
    // with a reminder or a check-in against them still sees the call they are
    // actually making rather than one about an order.
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
    const held = suppressionReason(c, today, config, hasReminderReason, nowMs);
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
  nowMs: number,
): QueueReason[] {
  const reasons: QueueReason[] = [];

  /* ---- payment overdue ---- */
  //
  // Decided by the collections engine, which owns the cadence: its quiet
  // window, its message interval, its rest between calls. This does not
  // re-derive any of that — it shows what that engine already concluded, at
  // the top of the list, so a telecaller works one list rather than two.
  if (config["queue.includePaymentDue"] && c.paymentCallDue) {
    reasons.push({
      kind: "paymentOverdue",
      label: `Payment overdue ${c.paymentCallDue.daysOverdue} day${c.paymentCallDue.daysOverdue === 1 ? "" : "s"} - ${formatPaise(c.paymentCallDue.totalOverdue)}`,
      weight: weights.paymentOverdue,
    });
  }

  /* ---- an order already on its way ---- */
  //
  // NOT a reason to ask for another one. The customer's requirement is
  // already captured; what is worth seeing is where it has got to.
  if (config["queue.showOrderStatus"] && c.openOrderStatus) {
    reasons.push({
      kind: "orderStatus",
      label: `Order in progress - ${c.openOrderStatus}`,
      weight: weights.orderStatus,
    });
  }

  /* ---- nobody answered ---- */
  const retry = noAnswerState(c, today, config, nowMs);
  if (retry === "exhausted") {
    reasons.push({
      kind: "unreachable",
      label: `Unreachable - ${c.noAnswerCount} attempts, no answer. Decide what happens next.`,
      weight: weights.unreachable,
    });
  } else if (retry === "due") {
    reasons.push({
      kind: "noAnswerRetry",
      label: `No answer - attempt ${c.noAnswerCount + 1}`,
      weight: weights.noAnswerRetry,
    });
  }

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

    if (sinceOrder >= routineDayFor(c.cycleDays, config)) {
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
        // The routine stock check. A different call from "your order is due"
        // and it says so: the telecaller is asking what they have left, not
        // asking for the order.
        const inDays = daysBetween(today, expected);
        reasons.push({
          kind: "routineCall",
          label: `Stock check - orders every ${c.cycleDays} days, next due in ${inDays} day${inDays === 1 ? "" : "s"}`,
          weight: weights.routineCall,
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
  // One group only: customers whose cycle could not be measured yet. There is
  // no cycle to time a call from, so a steady cadence is the only thing left.
  //
  // Customers who reorder FASTER than the quiet window used to get this too,
  // on the reasoning that going silent on your best customers loses them. They
  // no longer do. A customer buying every seven days is in contact constantly
  // through the orders themselves, and a weekly call on top is noise on both
  // sides of the phone — they are the one group who genuinely do order on
  // their own.
  //
  // They are not lost by it. The moment they stop ordering they leave the
  // quiet window, their order reasons apply, and they come back on the list
  // for the reason that actually matters.
  //
  // Customers with a measured cycle of 15 days or more never had this: their
  // cycle already says when to call, and a weekly check-in on top would ring a
  // 60-day buyer eight times before their order was due.
  if (c.lastOrderDate && c.cycleIsDefault) {
    // When contact was last made, as well as it can be known. An ORDER is
    // contact — somebody spoke to them to take it — and for a book imported
    // from elsewhere it is the only evidence there is. Falling straight to the
    // record's creation date dates a customer of four years from the afternoon
    // their row was written, which holds an entire imported book off the queue
    // for a week on the strength of it.
    //
    // The LATER of the two, not the logged call in preference to the order. An
    // order that arrived through the sheet is evidence somebody spoke to them
    // that day, and reading a three-week-old call first would ring a customer
    // who ordered on Tuesday to ask how they are getting on.
    const since = laterOf(c.lastContactDate, c.lastOrderDate);
    const daysSince = daysBetween(since, today);
    const interval = config["queue.checkInIntervalDays"];

    if (daysSince > interval * 1.5) {
      reasons.push({
        kind: "checkInOverdue",
        label: `No contact for ${daysSince} days - cycle not established yet`,
        weight: weights.checkInOverdue,
      });
    } else if (daysSince >= interval) {
      reasons.push({
        kind: "checkInDue",
        label: `Check-in due - ${daysSince} days since last contact`,
        weight: weights.checkInDue,
      });
    }
  }

  return reasons;
}

/** The more recent of two dates. ISO dates sort lexically, so `>` is enough. */
function laterOf(a: BusinessDate | null, b: BusinessDate): BusinessDate {
  return a && a > b ? a : b;
}

/**
 * How many days after an order the customer becomes worth calling.
 *
 * Lead scales with the cycle and is clamped at both ends. The quiet window is
 * NOT folded in here on purpose — see suppressionReason. Keeping it separate
 * is what lets the screen say "held back until day 15" instead of silently
 * omitting a customer who is late by their own reckoning.
 */
function routineDayFor(cycleDays: number, config: QueueConfig): number {
  /*
   * A customer who buys every fortnight or less gets NO routine call. They
   * are in contact constantly through the orders themselves, and a call in
   * between is noise on both sides of the phone. Their first reason is the
   * due date itself.
   */
  if (cycleDays <= config["queue.routineMinCycleDays"]) return cycleDays;

  /*
   * Otherwise the stock check lands at a percentage of the customer's OWN
   * cycle — 70% of 30 days is day 21, three weeks after the last order and
   * nine days before the next is expected.
   *
   * Forwards from the last order, not backwards from the due date. The old
   * calculation subtracted a lead capped at ten days, which on a 60-day
   * customer meant day 50 rather than day 42: the longer the cycle, the later
   * the warning, which is backwards. A long cycle is exactly where the
   * estimate is loosest and the notice should be longest.
   */
  return Math.max(
    1,
    Math.round((cycleDays * config["queue.routineCallPercent"]) / 100),
  );
}

/**
 * Where the customer sits on the no-answer ladder.
 *
 * `none` — nobody has failed to reach them, or somebody has since answered.
 * `waiting` — an attempt is owed, but not yet.
 * `due` — try again now.
 * `exhausted` — the ladder has run out and a person has to decide.
 *
 * The first rung is measured in HOURS from the attempt itself, which is why
 * this takes an instant: people are driving, or serving a customer, and an
 * hour later is a genuinely different moment. Every rung after it is measured
 * in days, because a second attempt in the same afternoon is pestering.
 */
export function noAnswerState(
  c: Pick<QueueCandidate, "noAnswerCount" | "lastNoAnswerAt">,
  today: BusinessDate,
  config: QueueConfig,
  nowMs: number,
): "none" | "waiting" | "due" | "exhausted" {
  if (!c.lastNoAnswerAt || c.noAnswerCount < 1) return "none";
  if (c.noAnswerCount >= config["queue.noAnswerMaxAttempts"]) return "exhausted";

  const lastMs = Date.parse(c.lastNoAnswerAt);
  if (Number.isNaN(lastMs)) return "none";

  if (c.noAnswerCount === 1) {
    const gapMs = config["queue.noAnswerRetryHours"] * 3_600_000;
    return nowMs - lastMs >= gapMs ? "due" : "waiting";
  }

  // Rung 2 onwards, in days: [1, 3] means the next working day, then three
  // days after that. Past the end of the ladder the last rung repeats until
  // the attempt limit stops it.
  const ladder = config["queue.noAnswerRetryDays"];
  const step = ladder[Math.min(c.noAnswerCount - 2, ladder.length - 1)] ?? 1;
  const lastDay = c.lastNoAnswerAt.slice(0, 10);
  return daysBetween(lastDay, today) >= step ? "due" : "waiting";
}

/** Rupees, for a label. The screen formats money everywhere else. */
function formatPaise(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

/** The order-chasing reasons — the ones the quiet window holds back. */
function isOrderChasing(kind: QueueReasonKind): boolean {
  return (
    kind === "orderDue" ||
    kind === "routineCall" ||
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
  // The cycle is safe to name here. This sentence is only ever SHOWN when the
  // stripping above emptied the reason list, which takes an order reason, which
  // takes a measured cycle — so `cycleDays` is never the guessed default by the
  // time a telecaller reads it.
  return `Orders every ${c.cycleDays} days · ordered ${sinceOrder === 0 ? "today" : `${sinceOrder} day${sinceOrder === 1 ? "" : "s"} ago`} - no order chased for ${left} more day${left === 1 ? "" : "s"}`;
}

/** The stored outcome, as a sentence a telecaller reads. */
function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "no_order":
      return "No order";
    case "not_interested":
      return "Not interested";
    case "casual_talk":
      return "Spoke";
    default:
      return outcome.replace(/_/g, " ");
  }
}

function suppressionReason(
  c: QueueCandidate,
  today: BusinessDate,
  config: QueueConfig,
  hasReminderReason: boolean,
  nowMs: number,
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

  /*
   * WHAT THE CUSTOMER SAID, and how long it buys.
   *
   * Asked for an order and told no: without a cooldown a customer past their
   * call day returns to the top of the list every single day until they
   * order, which punishes the telecaller for working it. "Not interested"
   * should buy far more than a week, and the map is what lets a manager say
   * so without a deploy.
   *
   * An outcome with no entry buys nothing — silence in the configuration
   * means no quiet, never an accidental month.
   */
  if (c.lastAnsweredOutcome && c.lastAnsweredDate && !hasReminderReason) {
    const cooldown = config["queue.outcomeCooldownDays"][c.lastAnsweredOutcome];
    if (cooldown && cooldown > 0) {
      const elapsed = daysBetween(c.lastAnsweredDate, today);
      if (elapsed < cooldown) {
        const left = cooldown - elapsed;
        return `${outcomeLabel(c.lastAnsweredOutcome)} ${elapsed === 0 ? "today" : `${elapsed} day${elapsed === 1 ? "" : "s"} ago`} - asking again in ${left} day${left === 1 ? "" : "s"}`;
      }
    }
  }

  /*
   * Waiting for the next rung of the no-answer ladder. Held rather than
   * dropped, so somebody looking for a customer they rang this morning can
   * see when the next attempt is owed instead of concluding they vanished.
   */
  if (noAnswerState(c, today, config, nowMs) === "waiting") {
    return `No answer - attempt ${c.noAnswerCount} made, waiting before the next`;
  }

  // Only a CONFIRMED send suppresses. A copied-but-unconfirmed message means
  // the system does not know it was sent, and suppressing on that would drop
  // customers out of the calling list on the strength of something that may
  // never have happened.
  //
  // A reminder outranks this for the same reason it outranks the quiet window:
  // the callback was promised to the customer, and a message we chose to send
  // afterwards must not be what cancels it. Being called the day after a
  // WhatsApp is a small cost; not ringing somebody who asked to be rung is the
  // failure the cooldown was never meant to cause. `calledToday` still wins —
  // they have already been spoken to.
  if (c.lastConfirmedWhatsappDate && !hasReminderReason) {
    const cooldown = config["queue.whatsappCooldownDays"];
    const elapsed = daysBetween(c.lastConfirmedWhatsappDate, today);
    if (elapsed < cooldown) {
      const left = cooldown - elapsed;
      return `WhatsApp sent ${elapsed === 0 ? "today" : `${elapsed} day${elapsed === 1 ? "" : "s"} ago`} - ${left} day${left === 1 ? "" : "s"} of cooldown left`;
    }
  }

  return null;
}
