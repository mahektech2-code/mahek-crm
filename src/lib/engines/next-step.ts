import type { BusinessDate } from "../business-date";
import { addDays } from "../business-date";
import type { QueueReasonKind } from "../config/registry";
import { buildQueue, type QueueCandidate, type QueueConfig } from "./queue";

/* ---------------------------------------------------------------------------
 * E10 — What happens next with this customer
 *
 * The queue answers "who do I call today". This answers the forward question a
 * telecaller asks the moment they put the phone down: "so when do I speak to
 * them again, and why?"
 *
 * It does NOT re-derive any rule. It asks the queue engine the same question
 * it always answers — is this customer on the list — once for today and once
 * for each day after, and reports the first day the answer is yes. A second
 * copy of the cycle, the quiet window, the cooldowns and the no-answer ladder
 * would drift from the real one within a release, and the sentence a customer
 * gets told on a phone call would be the copy that was wrong.
 *
 * Pure. A candidate, the business date and configuration go in; one sentence
 * comes out.
 * ------------------------------------------------------------------------- */

export type NextStepKind =
  /** A date we owe the customer — a callback they asked for. */
  | "booked"
  /** A date the rules produce. Real, but an expectation rather than a promise. */
  | "scheduled"
  /** The no-answer ladder is spent. Nothing will bring them back on its own. */
  | "decide"
  /** Nothing is coming: do not contact, or nothing inside the horizon. */
  | "none";

export type NextStep = {
  kind: NextStepKind;
  /** Null for `decide` and `none` — there is genuinely no date. */
  date: BusinessDate | null;
  daysAway: number | null;
  /** The queue reason that will put them back on the list, where there is one. */
  reasonKind: QueueReasonKind | null;
  /** One line: the day they come back to the Call Log, or that none is coming. */
  headline: string;
  /** One line: what to do, and why that day. */
  detail: string;
  /**
   * Why they are not on today's list, in the queue's own words, or null when
   * nothing is holding them. Shown underneath, because "not today" and "on the
   * 20th" are two different facts and a telecaller asks both.
   */
  heldToday: string | null;
  /**
   * The promise `withPromise` folded into `detail`, structured rather than
   * left for the UI to parse back out of a sentence. Present only where a
   * promise was actually appended — never where the promise already IS the
   * answer (`kind === "booked"` on this exact date), since there is nothing
   * to hold there beyond what is already true. This is what the "hold other
   * calls until then" action reads: it needs the reminder's id, not its
   * English.
   */
  promise: { reminderId: string; dueDate: BusinessDate; note: string } | null;
};

export type NextStepInput = {
  candidate: QueueCandidate;
  /**
   * The day collections next wants this account called, from `nextCallOn` in
   * the payment follow-up engine. `paymentCallDue` on the candidate is a
   * verdict about TODAY and cannot be rolled forward, so without this a
   * customer with an overdue bill would answer "tomorrow" every single day.
   */
  paymentNextCallOn: BusinessDate | null;
};

/** How far ahead to look before answering "nothing scheduled". */
export const NEXT_STEP_HORIZON_DAYS = 120;

export function nextStep(
  input: NextStepInput,
  today: BusinessDate,
  config: QueueConfig,
  nowMs: number,
  horizonDays: number = NEXT_STEP_HORIZON_DAYS,
): NextStep {
  const { candidate, paymentNextCallOn } = input;

  /*
   * Why they are not on the list today, in the words the held-back strip
   * already uses. Taken before the search so the two sentences agree.
   *
   * The call just logged is discounted on purpose. "Already called today" is
   * the first reason the queue reaches for and it is the one thing the person
   * reading this does not need telling — they made the call. What they want is
   * the rule underneath: the five days a "no order" buys, the quiet after an
   * order, the WhatsApp cooldown. Where that is genuinely all there is, the
   * plain answer is used.
   */
  const asIfNotCalled = { ...candidate, calledToday: false };
  const underneath = buildQueue(
    [forDay(asIfNotCalled, today, today, paymentNextCallOn)],
    today,
    config,
    nowMs,
  ).suppressed[0]?.reason;
  const plain = buildQueue(
    [forDay(candidate, today, today, paymentNextCallOn)],
    today,
    config,
    nowMs,
  ).suppressed[0]?.reason;
  const heldToday = underneath ?? plain ?? null;

  for (let i = 0; i <= horizonDays; i++) {
    const day = addDays(today, i);
    const c = forDay(candidate, day, today, paymentNextCallOn);
    const result =
      i === 0
        ? buildQueue([c], day, config, nowMs)
        : buildQueue([c], day, config);

    const entry = result.entries[0];
    if (!entry) continue;

    const top = entry.reasons[0];
    return withPromise(
      describe(top.kind, top.label, day, today, i, heldToday),
      candidate,
      today,
    );
  }

  if (candidate.doNotContact) {
    return {
      kind: "none",
      date: null,
      daysAway: null,
      reasonKind: null,
      headline: "No next call",
      detail:
        "This customer is marked do not contact, so nothing will bring them back to your Call Log.",
      heldToday: null,
      promise: null,
    };
  }

  return {
    kind: "none",
    date: null,
    daysAway: null,
    reasonKind: null,
    headline: "Nothing scheduled",
    detail: `Nothing brings this customer back to your Call Log in the next ${horizonDays} days. They will appear when something changes — an order falls due, or somebody sets a reminder.`,
    heldToday,
    promise: null,
  };
}

/* ------------------------------------------------------------------ helpers */

/**
 * The candidate as it will stand on `day`.
 *
 * Three fields are statements about TODAY and would otherwise be carried
 * forward as though they were permanent: a call logged this morning does not
 * mean the customer has been called on the 20th, a skip lasts the business day,
 * and collections' "due now" verdict has its own rest interval.
 */
function forDay(
  c: QueueCandidate,
  day: BusinessDate,
  today: BusinessDate,
  paymentNextCallOn: BusinessDate | null,
): QueueCandidate {
  const isToday = day === today;
  return {
    ...c,
    calledToday: isToday ? c.calledToday : false,
    skippedTodayReason: isToday ? c.skippedTodayReason : null,
    paymentCallDue: isToday
      ? c.paymentCallDue
      : c.paymentCallDue && paymentNextCallOn && day >= paymentNextCallOn
        ? c.paymentCallDue
        : null,
  };
}

/**
 * Name the callback, where the answer above is not already it.
 *
 * The headline is the EARLIEST day the customer comes back, which is the true
 * answer to "when do I speak to them again" — and on a prospect or an overdue
 * account that day often arrives before the callback anybody promised. Left at
 * that, the screen would say "back on your list in 7 days" to a telecaller who
 * had just committed to ringing on the 12th, and the promise would be the one
 * thing the confirmation did not mention.
 *
 * So it is added rather than substituted. Both facts are true and a telecaller
 * needs both: the day they will see the name, and the day the customer is
 * expecting to hear from them.
 */
function withPromise(
  step: NextStep,
  c: QueueCandidate,
  today: BusinessDate,
): NextStep {
  const promises = c.reminders
    .filter((r) => r.dueDate >= today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const promise = promises[0];
  if (!promise) return step;
  // Already the answer. Saying it twice reads as two different callbacks.
  if (step.kind === "booked" && step.date === promise.dueDate) return step;

  // `dated()` leaves detail without a full stop — it is normally read as a
  // standalone phrase — while the "unreachable" and do-not-contact details
  // already end in one. Adding a fixed period here would double up on those;
  // adding none runs the two sentences together with no separator at all,
  // which is what a telecaller was actually shown: "...due to reorder You
  // have also promised...", no capital-less "you", no full stop in sight.
  const needsFullStop = !/[.!?]$/.test(step.detail.trim());
  return {
    ...step,
    detail:
      `${step.detail}${needsFullStop ? "." : ""} You have also promised ` +
      `them a callback on ${dayLabel(promise.dueDate)} — ${promise.note}.`,
    promise: { reminderId: promise.id, dueDate: promise.dueDate, note: promise.note },
  };
}

/**
 * The sentence.
 *
 * Written per reason rather than reusing the queue's own label, because the two
 * are read at different moments. "Stock check - orders every 30 days, next due
 * in 9 days" is right on a list somebody is scanning; the person who has just
 * hung up wants to be told what to do and when. The queue's label is kept as
 * the detail wherever it says something this cannot.
 */
function describe(
  kind: QueueReasonKind,
  label: string,
  day: BusinessDate,
  today: BusinessDate,
  daysAway: number,
  heldToday: string | null,
): NextStep {
  const base = { date: day, daysAway, reasonKind: kind, heldToday, promise: null };

  /*
   * The headline is the SAME sentence for every dated reason, and it names the
   * screen rather than describing one.
   *
   * "Back on your list" was true and answered a question nobody asked: a
   * telecaller does not hold a mental model of "the list", they open the Call
   * Log. Saying which screen and which day, in a fixed form of words, is what
   * makes this a confirmation — read once, then recognised at a glance sixty
   * times a day. What VARIES is the reason underneath, which is the only part
   * worth reading twice.
   */
  const dated = (action: string, reason: string): NextStep => ({
    ...base,
    kind: "scheduled",
    headline: `Comes back to your Call Log ${whenLabel(day, today, daysAway)}`,
    detail: `${action} — ${reason}`,
  });

  switch (kind) {
    case "reminderOverdue":
    case "reminderDueToday":
      return {
        ...dated(
          "Call them back",
          "you promised a callback, so this is a date the customer is expecting",
        ),
        // A promise, not a prediction. The badge is what separates them.
        kind: "booked",
      };

    case "unreachable":
      return {
        ...base,
        kind: "decide",
        date: null,
        daysAway: null,
        headline: "No next call — this one needs a decision",
        detail:
          "Every attempt has gone unanswered, so nothing will ring them again on its own. Try another number, ask for a visit, or agree with your manager to leave them.",
      };

    case "paymentOverdue":
      return dated("Chase the payment", `${label.toLowerCase()}`);

    case "noAnswerRetry":
      return dated(
        "Try them again",
        "nobody answered, so the next attempt is spaced out rather than made straight away",
      );

    /*
     * The reason, never a claim about what the date means.
     *
     * "That is the day their order falls due" was here, and on any customer
     * held by a cooldown it was simply false — the order fell due last week
     * and the date shown is when the quiet runs out. A confident sentence
     * about the wrong thing is worse than a plain one about the right thing,
     * and the line underneath already says what is holding them.
     */
    case "orderOverdueFullCycle":
      return dated(
        "Ask for the order",
        "they are more than a full cycle past their reorder date",
      );

    case "orderDue":
      return dated("Ask for the order", "they are due to reorder");

    case "routineCall":
      return dated(
        "Stock check",
        "a short call before their order is due, to ask what they have left on the shelf",
      );

    case "orderStatus":
      return dated(
        "Check on their order",
        `${label.toLowerCase()} — their requirement is already in`,
      );

    case "checkInDue":
    case "checkInOverdue":
      return dated(
        "Check in",
        "we cannot measure how often this customer orders yet, so they get a steady check-in until we can",
      );

    case "prospect":
      return dated(
        "Try for a first order",
        "they have never ordered, so they are worked on a short cadence until they do",
      );

    default:
      return dated("Call them", label.toLowerCase());
  }
}

/** "today", "tomorrow", "on Thu 20 Aug — 5 days away". */
function whenLabel(day: BusinessDate, today: BusinessDate, daysAway: number): string {
  if (daysAway === 0) return "today";
  if (daysAway === 1) return "tomorrow";
  return `on ${dayLabel(day)} — ${daysAway} days away`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * "2026-08-20" -> "Thu 20 Aug".
 *
 * The weekday earns its place: a telecaller planning a callback needs to know
 * it does not land on a Sunday, and nobody reads that off a number.
 *
 * Built from UTC parts on purpose. A business date is already a calendar day in
 * Asia/Kolkata — it carries no time — so parsing it as UTC and reading it back
 * as UTC is the only way round that cannot shift it by a day.
 */
function dayLabel(day: BusinessDate): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
