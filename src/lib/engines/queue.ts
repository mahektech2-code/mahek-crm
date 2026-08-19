import type { BusinessDate } from "../business-date";
import { shortDateWithYear } from "../format";
import { addDays, daysBetween } from "../business-date";
import { DEFAULT_TIER_WEIGHTS, type Config, type QueueReasonKind } from "../config/registry";

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
  /**
   * How PREDICTABLE that cycle is, 0-100, and null where it was guessed.
   *
   * Two customers can both average thirty days and be nothing alike: one
   * orders every 29, 30, 31 days, the other after 15, then 45, then 22, then
   * 60. The average is identical and only one of them has a date worth
   * calling on. It was computed, stored and displayed, and nothing acted on
   * it.
   */
  cycleConfidence: number | null;
  /**
   * What this customer's order is usually worth, in paise — the median of
   * their recent approved orders, so one freak order does not decide where
   * they sit on the list for a year.
   *
   * Their OWN history, never a figure derived from the catalogue: the product
   * master carries no prices, `canValueOrders()` answers no, and a confident
   * wrong number would be worse here than no number at all.
   */
  typicalOrderPaise: number;

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
   * A shop we deliver to, served through a distributor — marked by a person,
   * never derived. It suppresses PROSPECTING and nothing else: an order this
   * account actually placed, money it owes and a promise somebody made all
   * still reach the list.
   */
  thirdParty: boolean;

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
  /**
   * What this call is worth, in paise — the debt on a collections call, the
   * order on a sales one, discounted by cycle confidence where the reason is
   * a prediction. It orders the list within a reason, and the screen can show
   * it, so a telecaller can see why one row sits above another.
   */
  callValue: number;
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
  | "queue.routineConfidenceSwing"
  | "queue.routineMinCycleDays"
  | "queue.outcomeCooldownDays"
  | "queue.noAnswerRetryHours"
  | "queue.noAnswerRetryDays"
  | "queue.noAnswerMaxAttempts"
  | "queue.includePaymentDue"
  | "queue.showOrderStatus"
  | "queue.excludeActiveInOrderSystem"
  | "queue.excludeCalledToday"
  | "queue.maxSizePerUser"
  | "queue.tierWeights"
  | "inactive.cycleMultiplier"
>;

/**
 * The weight of a reason, and never `undefined`.
 *
 * A stored `queue.tierWeights` REPLACES the registry default rather than
 * merging into it, so a blob written before a kind existed leaves that kind
 * unweighted — and production was carrying exactly that: eight keys against
 * the engine's thirteen, missing `paymentOverdue` and holding `orderDueSoon`,
 * a name the code stopped using. `undefined` does not throw here. It makes
 * `score` undefined, and `b.score - a.score` NaN, and a comparator that
 * answers NaN sorts nothing — so the calls about money, the highest tier there
 * is, were ordered arbitrarily and nothing anywhere looked broken.
 *
 * Falling back to the default is not a repair of the stored value; it is the
 * guarantee that a partial one cannot poison the ranking. The migration
 * repairs the value.
 */
function weightOf(weights: Partial<Record<QueueReasonKind, number>>, kind: QueueReasonKind): number {
  return weights[kind] ?? DEFAULT_TIER_WEIGHTS[kind];
}

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
        callValue: callValuePaise(unreachable.kind, c),
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
      // The leading reason decides which question "what is this worth" is
      // asking, so it is read after the sort, never before it.
      callValue: callValuePaise(reasons[0].kind, c),
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

/**
 * Why first, then what it is worth.
 *
 * The tier weight decides the order of REASONS and it is untouched: a promise
 * still beats an order due, which still beats a stock check. What changed is
 * the order within a reason. It was "who owes the most money", which is a
 * collections answer given to a sales question — among twenty customers all
 * due to order, the one who owes most is not the one to ring first, and a
 * telecaller working top-down spent the morning in the wrong half of the book.
 *
 * `callValue` asks the question the reason is actually about. Outstanding
 * stays below it as a further tie-break, where it costs nothing and settles
 * two customers whose orders are worth the same.
 */
function compareEntries(a: QueueEntry, b: QueueEntry): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.callValue !== a.callValue) return b.callValue - a.callValue;
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
      weight: weightOf(weights, "paymentOverdue"),
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
      weight: weightOf(weights, "orderStatus"),
    });
  }

  /* ---- nobody answered ---- */
  const retry = noAnswerState(c, today, config, nowMs);
  if (retry === "exhausted") {
    reasons.push({
      kind: "unreachable",
      label: `Unreachable - ${c.noAnswerCount} attempts, no answer. Decide what happens next.`,
      weight: weightOf(weights, "unreachable"),
    });
  } else if (retry === "due") {
    reasons.push({
      kind: "noAnswerRetry",
      label: `No answer - attempt ${c.noAnswerCount + 1}`,
      weight: weightOf(weights, "noAnswerRetry"),
    });
  }

  /* ---- reminder due ---- */
  for (const r of c.reminders) {
    if (r.dueDate < today) {
      const late = daysBetween(r.dueDate, today);
      reasons.push({
        kind: "reminderOverdue",
        label: `Reminder ${late} day${late === 1 ? "" : "s"} overdue - ${r.note}`,
        weight: weightOf(weights, "reminderOverdue"),
      });
    } else if (r.dueDate === today) {
      reasons.push({
        kind: "reminderDueToday",
        label: `Reminder due today - ${r.note}`,
        weight: weightOf(weights, "reminderDueToday"),
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

    if (sinceOrder >= routineDayFor(c.cycleDays, c.cycleConfidence, config)) {
      if (today > expected) {
        const overdueDays = daysBetween(expected, today);
        const cyclesMissed = Math.floor(overdueDays / Math.max(1, c.cycleDays));
        if (cyclesMissed >= 1) {
          /*
           * PAST THE POINT OF CHASING AN ORDER, and it is a different call.
           *
           * The same multiple of their own cycle that earns the Inactive
           * badge, so the badge a telecaller reads and the rank the list is
           * built on cannot disagree. Below it, a customer is late and worth
           * chasing hard. Above it they have stopped, and "why did you stop"
           * is a conversation worth having after the day's real chasing
           * rather than instead of it — these outnumber the active book, and
           * ranked as ordinary overdue orders they filled every list.
           */
          /*
           * THE INACTIVITY ENGINE'S OWN LINE, spelled the way it spells it:
           * days since the last ORDER against a multiple of the cycle, not
           * cycles missed since the date one was expected. Those differ by a
           * whole cycle, and getting it wrong would badge a customer Inactive
           * while ranking them as a live chase — the screen and the order
           * disagreeing about the same row.
           *
           * Under the default multiple of 2 this is exactly "one full cycle
           * overdue", so the two branches coincide and every one of these
           * customers is a lapse. Raise the multiple and a band opens between
           * them: late enough to have missed a cycle, not yet late enough to
           * have stopped. That band is what `orderOverdueFullCycle` is for.
           */
          const longGone =
            sinceOrder >=
            Math.round(c.cycleDays * config["inactive.cycleMultiplier"]);
          reasons.push({
            kind: longGone ? "orderLongOverdue" : "orderOverdueFullCycle",
            label: longGone
              ? `Gone quiet - ${cyclesMissed} cycles since their last order, expected ${shortDateWithYear(expected, today)}`
              : `Order overdue by ${cyclesMissed} full cycle${cyclesMissed === 1 ? "" : "s"} - expected ${shortDateWithYear(expected, today)}`,
            weight: weightOf(weights, longGone ? "orderLongOverdue" : "orderOverdueFullCycle"),
          });
        } else {
          reasons.push({
            kind: "orderDue",
            label: `Order overdue by ${overdueDays} day${overdueDays === 1 ? "" : "s"} - expected ${shortDateWithYear(expected, today)}`,
            weight: weightOf(weights, "orderDue"),
          });
        }
      } else if (today === expected) {
        reasons.push({
          kind: "orderDue",
          label: `Order due today - ${c.cycleDays}-day cycle`,
          weight: weightOf(weights, "orderDue"),
        });
      } else {
        // The routine stock check. A different call from "your order is due"
        // and it says so: the telecaller is asking what they have left, not
        // asking for the order.
        const inDays = daysBetween(today, expected);
        reasons.push({
          kind: "routineCall",
          label: `Stock check - orders every ${c.cycleDays} days, next due in ${inDays} day${inDays === 1 ? "" : "s"}`,
          weight: weightOf(weights, "routineCall"),
        });
      }
    }
  }

  /* ---- prospect ---- */
  //
  // Never ordered. Worked on its own short cadence, because converting a
  // first order is the growth work and there is no cycle to wait for.
  //
  // UNLESS SOMEBODY HAS SAID THERE IS NO FIRST ORDER TO CONVERT. A shop served
  // through a distributor buys from the distributor; ringing it to ask for an
  // order is asking for something it cannot give. That was the single largest
  // category of work on the Call Log — 125 rows a day against 67 for the next
  // reason — and every one of them was speculative.
  //
  // Only this reason is suppressed. If a marked account does place an order
  // with us directly it gains a cycle and is chased on it like anybody else,
  // so the mark corrects itself and nobody has to remember to lift it.
  if (!c.lastOrderDate && !c.thirdParty) {
    const since = c.lastContactDate ?? c.createdDate;
    const daysSince = daysBetween(since, today);
    if (daysSince >= config["queue.prospectIntervalDays"]) {
      reasons.push({
        kind: "prospect",
        label: c.lastContactDate
          ? `Never ordered - ${daysSince} days since last contact`
          : `Never ordered - on the book ${daysSince} days, never contacted`,
        weight: weightOf(weights, "prospect"),
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
        weight: weightOf(weights, "checkInOverdue"),
      });
    } else if (daysSince >= interval) {
      reasons.push({
        kind: "checkInDue",
        label: `Check-in due - ${daysSince} days since last contact`,
        weight: weightOf(weights, "checkInDue"),
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
function routineDayFor(
  cycleDays: number,
  confidence: number | null,
  config: QueueConfig,
): number {
  /*
   * A customer who buys every fortnight or less gets NO stock-check call, and
   * this is the ONLY thing a short cycle costs them. Their order is chased on
   * their own due date exactly like everybody else's — the quiet window is
   * capped at their cycle so that it cannot run past it.
   *
   * What they lose is the call BEFORE the order is due, which asks what they
   * have left on the shelf. Somebody buying every week already knows, and is in
   * contact constantly through the orders themselves, so it is noise on both
   * sides of the phone.
   *
   * Returning the cycle itself is what withholds it: the first day an order
   * reason can fire becomes the due date, never earlier.
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
  /*
   * ...and it moves with how predictable that cycle is.
   *
   * A date computed from 29, 30, 31 days is worth calling ON. A date computed
   * from 15, 45, 22, 60 is a guess dressed up as a date, and the honest
   * response to a guess is a wider net — ring earlier, because the real
   * order could come at any point either side of it.
   *
   * So a perfectly regular customer is called LATER, closer to the day they
   * actually order, which is the call least likely to be wasted; an erratic
   * one is called earlier. Fifty is neutral and leaves the flat percentage
   * exactly where it was, so a swing of zero restores the old behaviour for
   * everybody.
   */
  const swing = config["queue.routineConfidenceSwing"];
  const adjust = ((confidence ?? 50) - 50) / 50;
  const percent = clampPercent(
    config["queue.routineCallPercent"] + adjust * swing,
  );

  return Math.max(1, Math.round((cycleDays * percent) / 100));
}

/** The registry's own bounds on the routine percentage, honoured after a swing. */
function clampPercent(percent: number): number {
  return Math.min(100, Math.max(10, percent));
}

/* ---------------------------------------------------------------------------
 * What a call is worth.
 *
 * The list is ordered by WHY the call is being made — that is the tier
 * weight, and it does not move. This decides the order WITHIN a reason, and it
 * used to be "who owes the most money", which is a collections answer given to
 * a sales question: among twenty customers all due to order, the one who owes
 * most is not the one worth ringing first.
 *
 * Two different questions, and the reason says which one to ask:
 *
 *   A COLLECTIONS call is worth the debt. That figure is certain — the
 *   money is owed — so it is used as it stands.
 *
 *   A SALES call is worth the order, and for the reasons that are a
 *   PREDICTION it is discounted by how sure we are the prediction is right.
 *   A customer worth a lakh whose cycle is a coin toss is not a better call
 *   than one worth sixty thousand who orders like clockwork, and multiplying
 *   the two is the whole of that judgement.
 *
 * Reminders, prospects and check-ins are facts rather than predictions — a
 * promise was made, a week went by — so they carry the order value whole.
 * ------------------------------------------------------------------------- */

/** Reasons that are a guess about when the customer will order. */
function isPrediction(kind: QueueReasonKind): boolean {
  return (
    kind === "orderDue" ||
    kind === "routineCall" ||
    kind === "orderOverdueFullCycle" ||
    // Derived from the same cycle, so discounted by the same confidence. A
    // lapsed customer on a cycle nobody has measured well is a guess about a
    // guess.
    kind === "orderLongOverdue"
  );
}

export function callValuePaise(
  topReason: QueueReasonKind,
  c: Pick<QueueCandidate, "outstanding" | "typicalOrderPaise" | "cycleConfidence">,
): number {
  if (topReason === "paymentOverdue") return c.outstanding;
  if (!isPrediction(topReason)) return c.typicalOrderPaise;
  /*
   * No confidence figure means NO DISCOUNT, not a middling one.
   *
   * A prediction takes a measured cycle and a measured cycle computes a
   * confidence, so in a database whose caches are current this is never null.
   * It is null on every cycle computed before the column existed — 297 of
   * them here — and those rebuild on the next nightly.
   *
   * Until they do, discounting them all by half would be a uniform penalty
   * dressed up as a judgement: it says "we are unsure about this customer"
   * when what is true is "we have not looked yet". Missing information never
   * demotes anybody; the discount starts applying to a customer the moment
   * there is something real to apply.
   */
  const sure = c.cycleConfidence ?? 100;
  return Math.round((c.typicalOrderPaise * sure) / 100);
}

/**
 * How long after an order this customer is left alone.
 *
 * The configured window, or their own cycle where that is shorter and measured.
 */
function quietDaysFor(c: QueueCandidate, config: QueueConfig): number {
  const quiet = config["queue.quietDaysAfterOrder"];
  if (c.cycleIsDefault) return quiet;
  return Math.min(quiet, c.cycleDays);
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
 * A customer who ordered days ago is serving themselves and a call asking for
 * another order adds nothing. They can still be LATE by their own cycle while
 * inside the window, which is why this returns a sentence: the screen shows it
 * rather than dropping them without explanation.
 *
 * THE WINDOW NEVER OUTLASTS THE CUSTOMER'S OWN DUE DATE.
 *
 * It is a flat fifteen days, and cycles are not — so on anybody who reorders
 * faster than that it used to run past the day their order was actually due.
 * A seven-day buyer was held until day 15: a whole cycle missed, and the call
 * that finally came was eight days late. The people ordering most often were
 * the ones chased last, which is backwards, and the orders it lost were real.
 *
 * Capping it at the cycle makes every customer the same rule — quiet until
 * their order is due, chased from the day it is. What a short cycle still does
 * NOT get is the stock check, and that is now the only difference: see
 * `routineDayFor`. A call before the order is due asks what they have left on
 * the shelf, and somebody buying every week already knows.
 *
 * Only a MEASURED cycle caps it. A guessed one is not a due date, and shrinking
 * a real window on the strength of a number nobody measured would chase people
 * on the strength of a default.
 */
function quietWindow(
  c: QueueCandidate,
  today: BusinessDate,
  config: QueueConfig,
  hasReminderReason: boolean,
): string | null {
  if (!c.lastOrderDate || hasReminderReason) return null;
  const quiet = quietDaysFor(c, config);
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
