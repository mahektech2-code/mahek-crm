import type { BusinessDate } from "../business-date";
import { addDays, daysBetween } from "../business-date";
import type { Config } from "../config/registry";

/* ---------------------------------------------------------------------------
 * E7 — Payment Follow-up Cadence
 *
 * WHEN an overdue customer is contacted, and by which channel. E3 answers how
 * overdue they are and how hard to push; this answers whether anything is due
 * from them today.
 *
 * The policy in one paragraph: a bill falls due, and for the length of the
 * quiet window nobody rings — a bill a few days late is usually paperwork,
 * not refusal. A reminder message goes every few days through that window,
 * counted from the due date. The day the window closes, calling opens, and
 * from then on the customer returns to the calling list on their own rest
 * interval. Messages do not stop when calling starts; the two run alongside.
 *
 * Pure. Overdue customers and the business date come in; three lists go out.
 * Held-back customers are RETURNED, never filtered away — a telecaller must
 * always be able to find out why somebody they expected is missing.
 * ------------------------------------------------------------------------- */

export type FollowUpSubject = {
  customerId: string;
  name: string;
  /** The effective due date of the bill anchoring the account — from E3. */
  anchorDueDate: BusinessDate;
  totalOverdue: number;
  overdueBillCount: number;

  /** Last payment reminder actually sent. Null means none since the bill fell due. */
  lastMessageOn: BusinessDate | null;
  /** Last payment call logged. Null means none since the bill fell due. */
  lastCallOn: BusinessDate | null;

  doNotContact: boolean;
  /** Already spoken to today, on any module. One call a day is the limit. */
  contactedToday: boolean;
  /** E3 holds a disputed account at its stage; it also stops the chasing. */
  held: boolean;
  heldReason: string | null;
  /** A live dated promise. Chasing resumes the day after it passes. */
  promisedDate: BusinessDate | null;
  /**
   * Money reported against this account and not yet decided on by accounts.
   * Paise, and the day it was reported.
   *
   * `held` says accounts have looked at it and parked it deliberately, which
   * is a different fact from nobody having looked yet — see `reportedQuiet`,
   * where it is the difference between quiet that expires and quiet that does
   * not. The reason travels with it because the sentence is read by a
   * telecaller who has to answer a customer asking why nobody rang.
   */
  reportedPayment: {
    amount: number;
    on: BusinessDate;
    held: boolean;
    holdReason: string | null;
    /**
     * The latest date written on an undecided cheque, where there is one.
     *
     * A post-dated cheque is a customer who has already paid as far as they
     * are concerned, and who cannot be expected to do anything more until the
     * date arrives. The ordinary reported quiet is a few days and a cheque can
     * be dated a month out, so without this the customer is chased for money
     * that is sitting in our own drawer — which is the most annoying call it
     * is possible to make.
     */
    postDatedTo: BusinessDate | null;
  } | null;
};

export type FollowUpConfig = Pick<
  Config,
  | "escalation.quietCallDays"
  | "escalation.messageIntervalDays"
  | "escalation.callIntervalDays"
  | "payments.reportedQuietDays"
>;

/** Where the account sits relative to the quiet window. */
export type FollowUpPhase = "quiet" | "calling";

export type FollowUpDue = {
  customerId: string;
  name: string;
  phase: FollowUpPhase;
  daysOverdue: number;
  totalOverdue: number;
  overdueBillCount: number;
  /** Plain language, shown verbatim beside the name. */
  reason: string;
  /** Days since the last contact of this channel, or since the due date. */
  daysSinceLast: number;
};

export type FollowUpHeldBack = {
  customerId: string;
  name: string;
  channel: "whatsapp" | "call";
  /** Plain language, for the held-back strip. */
  reason: string;
};

export type FollowUpPlan = {
  /** Customers to call today, oldest debt first. */
  calls: FollowUpDue[];
  /** Customers to message today, oldest debt first. */
  messages: FollowUpDue[];
  /** Everybody due something who is not being contacted, and why. */
  heldBack: FollowUpHeldBack[];
};

/**
 * The first day a payment call may be made. The quiet window is measured from
 * the due date, so a 15-day window on a bill due the 1st opens calling on the
 * 16th.
 */
export function callingOpensOn(
  anchorDueDate: BusinessDate,
  config: Pick<Config, "escalation.quietCallDays">,
): BusinessDate {
  return addDays(anchorDueDate, config["escalation.quietCallDays"] + 1);
}

/**
 * The day the next reminder message is due. Counted from the last message
 * actually sent, or from the due date when none has been — which puts the
 * first reminder one interval after the bill fell due, not the morning after.
 */
export function nextMessageOn(
  subject: Pick<FollowUpSubject, "anchorDueDate" | "lastMessageOn">,
  config: Pick<Config, "escalation.messageIntervalDays">,
): BusinessDate {
  const from = subject.lastMessageOn ?? subject.anchorDueDate;
  return addDays(from, config["escalation.messageIntervalDays"]);
}

/**
 * The day the customer next appears on the calling list. Never before calling
 * opens, and never inside the rest interval that follows a logged call.
 */
export function nextCallOn(
  subject: Pick<FollowUpSubject, "anchorDueDate" | "lastCallOn">,
  config: Pick<Config, "escalation.quietCallDays" | "escalation.callIntervalDays">,
): BusinessDate {
  const opens = callingOpensOn(subject.anchorDueDate, config);
  if (!subject.lastCallOn) return opens;
  const rested = addDays(subject.lastCallOn, config["escalation.callIntervalDays"]);
  return rested > opens ? rested : opens;
}

export function planPaymentFollowUps(
  subjects: FollowUpSubject[],
  today: BusinessDate,
  config: FollowUpConfig,
): FollowUpPlan {
  const calls: FollowUpDue[] = [];
  const messages: FollowUpDue[] = [];
  const heldBack: FollowUpHeldBack[] = [];

  for (const s of subjects) {
    const daysOverdue = daysBetween(s.anchorDueDate, today);
    // Not yet due is not this engine's business. E3 has already dropped these,
    // but the guard keeps the function honest when called with anything.
    if (daysOverdue <= 0) continue;

    const phase: FollowUpPhase =
      daysOverdue > config["escalation.quietCallDays"] ? "calling" : "quiet";

    const messageDue = today >= nextMessageOn(s, config);
    const callDue = phase === "calling" && today >= nextCallOn(s, config);

    // Whatever stops the chasing stops both channels, and says so once per
    // channel the customer would otherwise have appeared on.
    const block = blockingReason(s, today, config);
    if (block) {
      if (messageDue) {
        heldBack.push({ customerId: s.customerId, name: s.name, channel: "whatsapp", reason: block });
      }
      if (callDue) {
        heldBack.push({ customerId: s.customerId, name: s.name, channel: "call", reason: block });
      }
      continue;
    }

    if (messageDue) {
      const since = daysBetween(s.lastMessageOn ?? s.anchorDueDate, today);
      messages.push({
        customerId: s.customerId,
        name: s.name,
        phase,
        daysOverdue,
        totalOverdue: s.totalOverdue,
        overdueBillCount: s.overdueBillCount,
        daysSinceLast: since,
        reason: s.lastMessageOn
          ? `Last reminded ${since} ${since === 1 ? "day" : "days"} ago`
          : `${daysOverdue} ${daysOverdue === 1 ? "day" : "days"} overdue, not yet reminded`,
      });
    }

    if (callDue) {
      const since = s.lastCallOn ? daysBetween(s.lastCallOn, today) : daysOverdue;
      calls.push({
        customerId: s.customerId,
        name: s.name,
        phase,
        daysOverdue,
        totalOverdue: s.totalOverdue,
        overdueBillCount: s.overdueBillCount,
        daysSinceLast: since,
        reason: s.lastCallOn
          ? `Last called ${since} ${since === 1 ? "day" : "days"} ago, still unpaid`
          : `${daysOverdue} days overdue - the quiet window has closed`,
      });
    } else {
      // Not a problem, but the reason somebody expected on the calling list is
      // not there. Said plainly rather than left to be guessed at.
      heldBack.push({
        customerId: s.customerId,
        name: s.name,
        channel: "call",
        reason:
          phase === "quiet"
            ? `Only ${daysOverdue} ${daysOverdue === 1 ? "day" : "days"} overdue - messages only until ${callingOpensOn(s.anchorDueDate, config)}`
            : `Called ${daysBetween(s.lastCallOn!, today)} ${daysBetween(s.lastCallOn!, today) === 1 ? "day" : "days"} ago - due again on ${nextCallOn(s, config)}`,
      });
    }
  }

  const byDebtAge = (a: FollowUpDue, b: FollowUpDue) =>
    b.daysOverdue - a.daysOverdue || b.totalOverdue - a.totalOverdue;

  return {
    calls: calls.sort(byDebtAge),
    messages: messages.sort(byDebtAge),
    heldBack,
  };
}

/**
 * The reasons nobody is contacted today, in the order they win. Do-not-contact
 * is absolute; money the customer says has already gone comes next, because
 * chasing somebody for a payment they have made is worse than chasing one they
 * have merely promised; then the promise itself, because chasing inside it is
 * what breaks it.
 */
function blockingReason(
  s: FollowUpSubject,
  today: BusinessDate,
  config: Pick<Config, "payments.reportedQuietDays">,
): string | null {
  if (s.doNotContact) return "Marked do not contact";
  if (s.held) return s.heldReason ?? "Held - a bill is disputed";

  const reported = reportedQuiet(s, today, config);
  if (reported) return reported;

  if (s.promisedDate && s.promisedDate >= today) {
    return `Payment promised by ${s.promisedDate} - not chased until it passes`;
  }
  if (s.contactedToday) return "Already contacted today";
  return null;
}

/**
 * The quiet a reported payment buys, and when it runs out.
 *
 * It has to run out. The money has not been confirmed and the bill is still
 * open, so an unexpiring quiet would let a customer take themselves off the
 * collections list by saying they had paid — and nobody would ever notice,
 * because the account simply stops appearing.
 */
export function reportedQuiet(
  s: Pick<FollowUpSubject, "reportedPayment">,
  today: BusinessDate,
  config: Pick<Config, "payments.reportedQuietDays">,
): string | null {
  if (!s.reportedPayment) return null;
  const age = daysBetween(s.reportedPayment.on, today);
  const amount = `₹${Math.round(s.reportedPayment.amount / 100).toLocaleString("en-IN")}`;

  /*
   * A HOLD DOES NOT EXPIRE, and that is the whole difference between the two.
   *
   * The expiry above exists because a bare report is nobody's decision — left
   * unexpiring, a customer could take themselves off this list for good by
   * saying they had paid, and the account would simply stop appearing. A hold
   * is somebody in accounts saying "I am looking for this money in the bank
   * statement, leave them alone until I have"; chasing through that is worse
   * than any call not made, and it is a named person's judgement rather than
   * an unanswered claim.
   *
   * What replaces the expiry is visibility. The hold ages in plain sight on
   * accounts' own list, past `payments.holdStaleDays` it is flagged there, and
   * the customer is only ever released by somebody deciding.
   */
  if (s.reportedPayment.held) {
    return `${amount} on hold with accounts${
      s.reportedPayment.holdReason ? ` - ${s.reportedPayment.holdReason}` : ""
    } - not chased until they decide`;
  }

  /*
   * A CHEQUE DATED IN THE FUTURE buys quiet until its date, plus the ordinary
   * window on top for the money to clear.
   *
   * The reported window is a few days and a cheque can be dated a month out.
   * Measured from when it was written down, the quiet lapses long before the
   * cheque can even be banked, and the customer is chased for money that is
   * sitting in our own drawer — the most annoying call it is possible to make,
   * and one where the customer is entirely right.
   */
  const postDated = s.reportedPayment.postDatedTo;
  if (postDated && postDated > today) {
    return `${amount} cheque dated ${postDated} - not chased until it can be banked`;
  }

  const from = postDated && postDated > s.reportedPayment.on ? postDated : s.reportedPayment.on;
  if (daysBetween(from, today) > config["payments.reportedQuietDays"]) return null;
  return age === 0
    ? `${amount} reported paid today - waiting for accounts to confirm it`
    : `${amount} reported paid ${age} ${age === 1 ? "day" : "days"} ago - waiting for accounts to confirm it`;
}
