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

/**
 * WHICH DAYS SOMEBODY WOULD HAVE WORKED — the office's own calendar, sent down
 * on the pull. ISO weekdays, Monday 1 … Sunday 7, and every holiday date.
 */
export type LeaveCalendar = {
  workingDays: readonly number[];
  holidays: ReadonlySet<string>;
};

/** ISO weekday of a `YYYY-MM-DD` date, Monday 1 … Sunday 7. */
function isoWeekday(day: string): number {
  const d = new Date(
    Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))),
  ).getUTCDay();
  return d === 0 ? 7 : d;
}

function nextDay(day: string): string {
  const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  return new Date(t + MS_PER_DAY).toISOString().slice(0, 10);
}

/** The same bound the office uses — a request longer than this is refused there. */
const MAX_SPAN_DAYS = 400;

/**
 * Working days in a span, both ends counted — `leaveWorkingDays` on the
 * server, the number a balance is actually debited by.
 */
export function workingDaysIn(from: string, to: string, calendar: LeaveCalendar): number {
  if (to < from) return 0;
  let count = 0;
  let cursor = from;
  for (let i = 0; i < MAX_SPAN_DAYS && cursor <= to; i++) {
    if (!calendar.holidays.has(cursor) && calendar.workingDays.includes(isoWeekday(cursor))) count++;
    cursor = nextDay(cursor);
  }
  return count;
}

/**
 * How many days a request is worth.
 *
 * WITH A CALENDAR IT COUNTS WORKING DAYS, which is what the office debits.
 * This counted calendar days: Friday to Monday read "4 days" on the phone,
 * was checked against the balance as four, and the office took two — and a
 * request for a Sunday alone was accepted here and refused there. Without a
 * calendar (an older caller) it keeps the calendar-day count it always had.
 */
export function leaveDays(request: LeaveRequestSpan, calendar?: LeaveCalendar): LeaveDaysResult {
  const single = request.span === 'single' || request.from === request.to;
  if (calendar) {
    const worked = workingDaysIn(request.from, single ? request.from : request.to, calendar);
    if (worked < 1) {
      return {
        days: 0,
        sentence: single
          ? 'That day is a holiday or a day off, so there is no leave to take.'
          : 'Every day in that range is a holiday or a day off, so there is no leave to take.',
        note: null,
      };
    }
    if (single) {
      return request.half
        ? { days: 0.5, sentence: 'Half a day.', note: null }
        : { days: 1, sentence: '1 day.', note: null };
    }
    const skipped = Math.max(0, inclusiveDays(request.from, request.to) - worked);
    return {
      days: worked,
      sentence: `${worked} ${worked === 1 ? 'working day' : 'working days'}.`,
      note: request.half
        ? 'Half day works only for one day. So all these days are counted as full days.'
        : skipped > 0
          ? `${skipped} ${skipped === 1 ? 'holiday or day off is' : 'holidays or days off are'} not counted.`
          : null,
    };
  }

  if (single) {
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
      ? 'Half day works only for one day. So all these days are counted as full days.'
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
