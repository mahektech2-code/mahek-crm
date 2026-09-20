/**
 * §16 — the ladder that chases a sample review, read on the phone.
 *
 * The office raises the chases: `leads.sampleReviewChaseDays` says day 2, then
 * 4, then 6, the nightly pass walks it, and `mbos_samples.review_chase_count`
 * counts what has gone. None of that reached the salesman. A sample that has
 * gone quiet looked identical whether it was received yesterday or had been
 * asked about three times with no answer — and those are two different
 * mornings: the first is waiting, the second is picking up the phone yourself.
 *
 * Everything here is PURE, takes the configured ladder and the business date as
 * arguments, and performs no I/O — the same rule every other engine in this app
 * keeps, and for the sharper reason: the salesman reading this is standing in a
 * market with one bar, and a rule that only exists on the server is a rule he
 * finds out about on the drive home.
 *
 * It is a MIRROR of `chaseOffset` in MahekOne's own `lib/engines/lead-nurture.ts`
 * rather than an import of it — one runtime is an Expo package and the other is
 * `server-only`, so the two cannot share a module. What they share is the
 * configured array, which reaches the handset on every pull with the rest of
 * the `leads.*` keys. The arithmetic is deliberately one line at each end: a
 * rule small enough to be obvious cannot drift the way a re-derived one does.
 *
 * WHAT IT IS NOT DATED FROM is the half worth saying out loud. `dispatchedAt`
 * is us saying it went and `deliveredAt` is the carrier saying it arrived;
 * neither starts this clock. Only the SHOP confirming it is in their hands
 * does, because a review timed from the day we posted it rings a customer still
 * waiting for the parcel — and that call teaches them we do not know where our
 * own stock is.
 */

/** A number of asks the office has made, or null where nobody has told us. */
export type ChaseCount = number | null;

export type ChaseRung = {
  /** Which ask this is, counting from one. */
  ask: number;
  /** The day it falls due, counted forward from confirmed receipt. */
  dueOn: string;
  /**
   * Has this ask gone?
   *
   * NULL IS A THIRD ANSWER AND NOT A NO. `review_chase_count` is a server
   * column that does not travel on the wire, so a handset genuinely does not
   * know — and drawing an unchased box for "this phone has not been told" is
   * the mistake this codebase keeps writing paragraphs about. Every caller has
   * to say which of the three it is looking at.
   */
  asked: boolean | null;
  /**
   * Its day is today or behind us. A fact off the calendar, so it is known
   * whether or not the count is — which is what makes the checklist worth
   * drawing on a handset that has never been told anything.
   */
  duePassed: boolean;
};

export type ChaseSchedule = {
  /**
   * The day the clock started — the shop's own confirmation and nothing else.
   * Null before it, which is not "no chases yet": there is nothing to chase,
   * because as far as anybody knows the parcel has not arrived.
   */
  startedOn: string | null;
  /** What the office says, or null where this handset has not been told. */
  asked: ChaseCount;
  /** The named ladder, one rung each. Empty before receipt. */
  rungs: ChaseRung[];
  /**
   * How many asks have gone PAST the end of the named ladder, per the count.
   * Null where the count is unknown. Drawn as one repeating line rather than
   * as a list, because the list does not end.
   */
  beyondLadder: number | null;
  /** The interval the ladder repeats on once its named rungs run out. */
  repeatEveryDays: number;
  /** Which ask is next. Only answerable where the count is known. */
  nextAsk: number | null;
  /** The day that next ask falls. Only answerable where the count is known. */
  nextAskDueOn: string | null;
  /**
   * The next day the ladder falls due at all, by the calendar alone.
   *
   * This is the honest answer a handset can give with no count: it cannot say
   * which ask is next, and it can say what day the rhythm lands on. Null only
   * before receipt.
   */
  nextDayOn: string | null;
};

/* ------------------------------------------------------------ the ladder */

/**
 * Days from confirmed receipt to the nth ask.
 *
 * The last interval REPEATS, which is the whole of §16 and the reason this is
 * not an array lookup: a trial nobody reviewed is stock given away for nothing,
 * so the asking does not stop at the end of a list. A ladder somebody typed
 * backwards would otherwise walk into the past and fire every rung at once, so
 * one day is the floor a step can be worth.
 */
export function chaseOffsetDays(chaseDays: readonly number[], ask: number): number {
  const days = chaseDays.filter((d) => Number.isFinite(d) && d >= 0);
  if (!days.length) return ask; /* nothing configured: ask daily */
  if (ask <= days.length) return days[ask - 1]!;
  const last = days[days.length - 1]!;
  const gap = days.length >= 2 ? last - days[days.length - 2]! : last;
  const step = Math.max(1, gap);
  return last + (ask - days.length) * step;
}

/** The interval the ladder settles into once its named rungs are used up. */
export function chaseRepeatDays(chaseDays: readonly number[]): number {
  const days = chaseDays.filter((d) => Number.isFinite(d) && d >= 0);
  if (!days.length) return 1;
  const last = days[days.length - 1]!;
  const gap = days.length >= 2 ? last - days[days.length - 2]! : last;
  return Math.max(1, gap);
}

/**
 * A day, n days on, in the salesman's own calendar.
 *
 * Built out of the date PARTS through `Date.UTC` rather than by adding
 * milliseconds to a local instant: a day is not always 86,400,000 ms long, and
 * a shift that lands on one that is not silently moves the whole ladder by a
 * day. Parsing the string with `new Date(iso)` would be the other spelling of
 * the same bug — a date-only string is specified to read as UTC and lands five
 * and a half hours before the day it names.
 */
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map((p) => Number(p));
  if (!y || !m || !d) return iso;
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------- the schedule */

/**
 * What the chase looks like for one sample, on a given day.
 *
 * `receivedOn` is the SHOP's confirmation — see the header. `asked` is the
 * office's count where the wire carries one and null where it does not, and
 * the two are kept apart all the way to the screen.
 */
export function chaseSchedule(input: {
  receivedOn: string | null;
  asked: ChaseCount;
  chaseDays: readonly number[];
  today: string;
}): ChaseSchedule {
  const { receivedOn, chaseDays, today } = input;
  /* A negative count is a corrupted row rather than an instruction, and reading
     it as "minus two asks have gone" would put the next ask in the past. */
  const asked = input.asked == null ? null : Math.max(0, Math.floor(input.asked));
  const repeatEveryDays = chaseRepeatDays(chaseDays);

  if (!receivedOn) {
    return {
      startedOn: null,
      asked,
      rungs: [],
      beyondLadder: null,
      repeatEveryDays,
      nextAsk: null,
      nextAskDueOn: null,
      nextDayOn: null,
    };
  }

  /* The NAMED rungs are the checklist. Past them the ladder repeats for ever,
     and a finite list that simply ran out would imply the chasing had stopped
     when it has not — so what lies beyond is a sentence, not more boxes. */
  const named = chaseDays.filter((d) => Number.isFinite(d) && d >= 0).length || 1;
  const rungs: ChaseRung[] = [];
  for (let ask = 1; ask <= named; ask++) {
    const dueOn = addDays(receivedOn, chaseOffsetDays(chaseDays, ask));
    rungs.push({
      ask,
      dueOn,
      asked: asked == null ? null : ask <= asked,
      duePassed: dueOn <= today,
    });
  }

  const beyondLadder = asked == null ? null : Math.max(0, asked - named);
  const nextAsk = asked == null ? null : asked + 1;
  const nextAskDueOn = nextAsk == null ? null : addDays(receivedOn, chaseOffsetDays(chaseDays, nextAsk));

  /* The calendar's own answer, which stands whether or not the count does: the
     first day on the ladder that has not gone by. It walks rather than solving
     for it because the ladder's early rungs are arbitrary and only its tail is
     arithmetic — and a sample is chased in tens of asks, not thousands. */
  let nextDayOn: string | null = null;
  for (let ask = 1; ask <= named + 2; ask++) {
    const day = addDays(receivedOn, chaseOffsetDays(chaseDays, ask));
    if (day > today) {
      nextDayOn = day;
      break;
    }
  }
  if (!nextDayOn) {
    /* Past the tail the step is constant, so the next day is one step on from
       the last one that has gone by — worked out rather than walked, because a
       sample received a year ago would otherwise be a loop of a hundred. */
    const lastNamed = addDays(receivedOn, chaseOffsetDays(chaseDays, named));
    const behind = daysBetween(lastNamed, today);
    const steps = Math.floor(behind / repeatEveryDays) + 1;
    nextDayOn = addDays(lastNamed, steps * repeatEveryDays);
  }

  return { startedOn: receivedOn, asked, rungs, beyondLadder, repeatEveryDays, nextAsk, nextAskDueOn, nextDayOn };
}

/** Whole days from one ISO date to another, never negative. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/* ------------------------------------------------------------- the words */

/**
 * "Asked three times", which is the number the whole mechanism exists to
 * produce — and the sentence for when nobody has told us.
 *
 * Zero asks and "this phone has not been told" are different facts, and saying
 * the first for the second is a screen quietly reassuring somebody that nothing
 * has been chased when three calls may already have been made. The two
 * sentences are different lengths and different shapes on purpose: they are not
 * meant to be mistaken for one another at arm's length in a market.
 */
export function chaseCountSentence(asked: ChaseCount): string {
  if (asked == null) return 'This phone has not been told how many times the office has asked';
  if (asked === 0) return 'Not asked yet';
  if (asked === 1) return 'Asked once';
  if (asked === 2) return 'Asked twice';
  return `Asked ${asked} times`;
}

/**
 * The line under the checklist, which never says the chasing is finished.
 *
 * Past the named rungs the ladder repeats until there is an answer, so the
 * sentence has to carry the rhythm rather than a last date. Where the count is
 * known it names which ask is next, because "ask seven" is itself the number
 * that tells somebody to ring the shop themselves.
 *
 * The date FORMATTER is passed in rather than reached for, because this module
 * is pure and `pretty` is the screen's. It also keeps the day drawn here and
 * the day drawn on the rung above it in one shape, which is the whole reason
 * the sentence is built in one place rather than assembled at each call site.
 */
export function nextChaseSentence(s: ChaseSchedule, fmt: (iso: string) => string): string | null {
  if (!s.startedOn) return null;
  const every = s.repeatEveryDays === 1 ? 'every day' : `every ${s.repeatEveryDays} days`;
  if (s.nextAsk != null && s.nextAskDueOn) {
    return `Ask ${s.nextAsk} falls on ${fmt(s.nextAskDueOn)}, then ${every} until they answer.`;
  }
  if (s.nextDayOn) {
    return `The next ask falls on ${fmt(s.nextDayOn)}, then ${every} until they answer.`;
  }
  return null;
}
