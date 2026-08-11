/**
 * Leave: how many days a request is worth, what it leaves in the balance, and
 * whether it clashes with something already asked for.
 *
 * **Overlapping requests are blocked**, and this is one of the two refusals in
 * MBOS (the other is a credit block). It is a refusal rather than a flag
 * because the alternative is not a doubtful record — it is a second request
 * that will be approved by somebody who cannot see the first, and then a
 * balance debited twice for one absence. There is no version of that a manager
 * can sort out afterwards without going through the ledger by hand.
 *
 * The unpaid sentence is the other thing this file exists for. A request that
 * runs past the balance is still submittable — people do take unpaid leave, and
 * refusing would just mean they take it without telling anybody — but nobody
 * may find out it was unpaid on payday. The sentence is returned so it can be
 * shown on the form, before the request goes.
 *
 * Pure. Dates are `YYYY-MM-DD` strings and are compared as strings, which is
 * exactly right for ISO dates and avoids parsing them into `Date` objects that
 * would drag a timezone into a calculation that has nothing to do with one.
 */

export type LeaveSpan = 'single' | 'range';
/** Which half a half-day request covers. Null for a whole day. */
export type LeaveHalf = 'first_half' | 'second_half' | null;

export type LeaveRequestSpan = {
  span: LeaveSpan;
  /** `YYYY-MM-DD`. */
  from: string;
  /** `YYYY-MM-DD`. Equal to `from` for a single-day request. */
  to: string;
  half: LeaveHalf;
};

export type LeaveDaysResult = {
  days: number;
  sentence: string;
  /** Set when something in the request was ignored, so the form can say so. */
  note: string | null;
};

const MS_PER_DAY = 86_400_000;

/** Whole days between two ISO dates, inclusive of both ends. */
function inclusiveDays(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  // UTC on both sides on purpose: the two dates are calendar days, not
  // instants, so building them in local time would make a request spanning a
  // DST change one day longer in some countries and shorter in others.
  return Math.floor((b - a) / MS_PER_DAY) + 1;
}

export function leaveDays(request: LeaveRequestSpan): LeaveDaysResult {
  if (request.span === 'single' || request.from === request.to) {
    if (request.half) {
      return {
        days: 0.5,
        sentence: 'Half a day.',
        note: null,
      };
    }
    return { days: 1, sentence: '1 day.', note: null };
  }

  const days = Math.max(0, inclusiveDays(request.from, request.to));
  return {
    days,
    sentence: `${days} days.`,
    // A half-day marker on a multi-day request is meaningless — the middle days
    // are whole days whatever it says — so it is dropped and the form is told,
    // rather than being silently honoured on one end nobody chose.
    note: request.half
      ? 'A half day only applies to a single-day request, so the whole range is counted as full days.'
      : null,
  };
}

export type LeaveEntitlement = {
  /** Days of paid leave left in the period. May be fractional. */
  balanceDays: number;
  /** What the leave type is called, for the sentence. */
  kind: string;
};

export type BalanceResult = {
  /** Paid days this request will consume. */
  paidDays: number;
  /** Days beyond the balance. Zero when it fits. */
  unpaidDays: number;
  /** The balance once the request is taken. Never negative — the excess is unpaid. */
  remainingDays: number;
  /** "3 days of this goes unpaid." Empty string when nothing does. */
  unpaidSentence: string;
  sentence: string;
};

export function balanceAfter(days: number, entitlement: LeaveEntitlement): BalanceResult {
  const paidDays = Math.min(days, Math.max(0, entitlement.balanceDays));
  const unpaidDays = Math.max(0, days - paidDays);
  const remainingDays = Math.max(0, entitlement.balanceDays - paidDays);

  const unpaidSentence =
    unpaidDays > 0
      ? `${trim(unpaidDays)} ${unpaidDays === 1 ? 'day' : 'days'} of this goes unpaid.`
      : '';

  return {
    paidDays,
    unpaidDays,
    remainingDays,
    unpaidSentence,
    sentence:
      unpaidDays > 0
        ? `You have ${trim(entitlement.balanceDays)} ${entitlement.kind} left. ${unpaidSentence}`
        : `${trim(remainingDays)} ${entitlement.kind} left after this.`,
  };
}

/* ------------------------------------------------------------- overlapping */

export type ExistingLeave = {
  id: string;
  from: string;
  to: string;
  status: string;
};

export type OverlapResult = {
  /** True means the request may not be submitted. See the note at the top. */
  blocked: boolean;
  clashes: ExistingLeave[];
  sentence: string;
};

/**
 * Does this request cover a day already asked for?
 *
 * Checked against **pending as well as approved**. Only counting approved ones
 * is the obvious mistake and the wrong one: two requests sitting in the same
 * inbox for the same week are approved separately by somebody reading them one
 * at a time, and the clash is discovered a month later in the balance.
 *
 * `blockingStatuses` is an argument because what an org calls those states
 * differs, and a status list hardcoded here would silently stop blocking the
 * day somebody renamed one.
 */
export function overlaps(
  request: LeaveRequestSpan,
  existing: readonly ExistingLeave[],
  blockingStatuses: readonly string[],
): OverlapResult {
  const clashes = existing.filter(
    (e) =>
      blockingStatuses.includes(e.status) &&
      // Two closed intervals overlap unless one ends before the other starts.
      // ISO dates compare correctly as strings, so no parsing is needed.
      e.from <= request.to &&
      e.to >= request.from,
  );

  return {
    blocked: clashes.length > 0,
    clashes,
    sentence: clashes.length
      ? `You already have leave requested for ${clashes[0]!.from === clashes[0]!.to ? clashes[0]!.from : `${clashes[0]!.from} to ${clashes[0]!.to}`}. Cancel that one first.`
      : '',
  };
}

/** No trailing `.0` on a whole number of days, and one decimal on a half. */
function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(1)));
}
