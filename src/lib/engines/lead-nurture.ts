/**
 * §13 and §16 — the chasing, as a function rather than as fifteen `if`s and a
 * cron job that grew them one at a time.
 *
 * A lead does not stall because nobody knows what to do next. It stalls
 * because the thing to do next lives in somebody's head, and the head is busy.
 * The nurture sequence is the answer to that: an event happens, and some days
 * later a task with a name and a date on it appears on somebody's list.
 *
 * PURE, like every other engine here — no I/O, no clock. The events, the day
 * and the configuration all arrive as arguments, which is what lets the fifteen
 * rows be tested without a database and, more to the point, lets the same
 * function answer for a day in the past when somebody asks why a task exists.
 *
 * THE SEQUENCE ITSELF IS NOT IN THIS FILE. It is `NURTURE_SEQUENCE` in
 * `lib/lead-labels.ts`, because the handset and the console both draw it and a
 * second copy typed into an engine would drift within a release. What lives
 * here is the arithmetic: which rows have come due, and what each one's stable
 * key is.
 *
 * **THE KEY IS THE WHOLE POINT.** This runs on a schedule, and a scheduled pass
 * that raises a second copy of a task every time it fires is worse than one
 * that never fires: a list of forty identical "Sample review call" rows is a
 * list somebody stops opening, and the one real task in it goes with them. Each
 * task carries a `sourceType`/`sourceId` pair derived only from facts that do
 * not move — which rung of the sequence it is, and which row triggered it — so
 * the second pass offers exactly what the first one did and the caller drops
 * what it already holds.
 */

import { addDays, type BusinessDate } from "../business-date";
import { NURTURE_SEQUENCE, type NurtureTrigger } from "../lead-labels";
import type { SampleState } from "../lead-labels";

/* ------------------------------------------------------------------ types */

/**
 * Something that happened on a lead, and the day it happened.
 *
 * `sourceId` is the row it happened ON — the sample, the visit, the order, or
 * the customer itself where the event is about the lead rather than about a
 * record beneath it. It is part of the key, so the same trigger firing twice
 * for two different samples raises two tasks, which is right, while the same
 * sample read on two consecutive nights raises one.
 */
export type NurtureEvent = {
  trigger: NurtureTrigger;
  sourceId: string;
  /** The day it happened, in the business's own zone. Never derived here. */
  on: BusinessDate;
};

export type NurtureOwner = "lead_manager" | "salesman";

/**
 * A task the sequence says should exist by today.
 *
 * `owner` is a ROLE rather than a user id, because working out who the lead
 * manager actually is on a given day is a read, and a read is not an engine's
 * to do. The caller resolves it and refuses to raise a task with nobody's name
 * on it — an unassigned task is a task nobody does.
 */
export type NurtureTask = {
  sourceType: string;
  sourceId: string;
  trigger: NurtureTrigger;
  owner: NurtureOwner;
  title: string;
  detail: string;
  /** The day it became due. In the past for anything the schedule missed. */
  dueDate: BusinessDate;
};

export type NurtureConfig = {
  /** §16's ladder, from `leads.sampleReviewChaseDays`. */
  sampleReviewChaseDays: readonly number[];
};

/** The one `sourceType` this engine writes. Everything else is in the id. */
export const NURTURE_SOURCE_TYPE = "lead_nurture";

/**
 * The stable key for one rung against one row.
 *
 * It is built from the trigger, the owner and the sequence row's own DECLARED
 * `after` — never from the effective due date. Those first three do not move;
 * the due date does, the moment a manager edits the chase ladder on the
 * Settings screen, and keying on it would raise every outstanding task a
 * second time on the night after they did. The wording is left out for the
 * same reason: improving a sentence must not duplicate a list.
 */
export function nurtureKey(
  trigger: NurtureTrigger,
  owner: NurtureOwner,
  declaredAfter: number,
  sourceId: string,
): string {
  return `${trigger}:${owner}:${declaredAfter}:${sourceId}`;
}

/**
 * How many days after its trigger a row is actually due.
 *
 * Fourteen of the fifteen rows answer with what the table says. The
 * `sample_received` one does not: it IS §16's first review chase, and §16's
 * ladder is configuration. Left at the table's hardcoded 2 it would put the
 * task on a manager's list on day 2 while the chase itself fired on day 3 for
 * anybody who had edited the setting — one lead, two dates, and nothing on
 * either screen saying why they disagreed.
 */
function dueAfter(
  row: (typeof NURTURE_SEQUENCE)[number],
  config: NurtureConfig,
): number {
  if (row.trigger === "sample_received") {
    const first = config.sampleReviewChaseDays[0];
    if (typeof first === "number" && Number.isFinite(first)) return Math.max(0, first);
  }
  return row.after;
}

/**
 * Every task the sequence says should exist on `today`, given what has
 * happened.
 *
 * A row comes due when its trigger's day plus its interval has ARRIVED — so a
 * pass that has not run for a week produces the week's worth rather than only
 * today's, which is the behaviour a schedule that drops ticks needs. Nothing
 * is produced ahead of its day: a task dated next Tuesday sitting on a list
 * today is a task somebody either does early or learns to ignore.
 *
 * `alreadyRaised` is what makes a re-run silent. It is an argument rather than
 * something the engine remembers, because remembering is state and this has
 * none — the caller reads the keys it already holds and hands them in, and what
 * comes back is exactly the work that is missing.
 */
export function tasksDueFor(
  events: readonly NurtureEvent[],
  today: BusinessDate,
  config: NurtureConfig,
  alreadyRaised: Iterable<string> = [],
): NurtureTask[] {
  const held = new Set(alreadyRaised);
  const out: NurtureTask[] = [];
  /* One rung against one row is one task, however many times the caller
     happens to have passed the same event in. A duplicated event is an
     ordinary result of reading two tables that both know about a sample. */
  const seen = new Set<string>();

  for (const event of events) {
    for (const row of NURTURE_SEQUENCE) {
      if (row.trigger !== event.trigger) continue;

      const dueDate = addDays(event.on, dueAfter(row, config));
      if (dueDate > today) continue;

      const sourceId = nurtureKey(row.trigger, row.owner, row.after, event.sourceId);
      if (held.has(sourceId) || seen.has(sourceId)) continue;
      seen.add(sourceId);

      out.push({
        sourceType: NURTURE_SOURCE_TYPE,
        sourceId,
        trigger: row.trigger,
        owner: row.owner,
        title: row.title,
        detail: row.detail,
        dueDate,
      });
    }
  }

  /* Oldest first: a list of overdue chasing read newest-first buries the lead
     that has been waiting longest under the one that came due this morning. */
  out.sort((a, b) => (a.dueDate === b.dueDate ? a.sourceId.localeCompare(b.sourceId) : a.dueDate < b.dueDate ? -1 : 1));
  return out;
}

/* ----------------------------------------------------- §16 the chase ladder */

export type SampleChaseInput = {
  id: string;
  state: SampleState;
  /** The day the customer confirmed it arrived. Null until they have. */
  receivedOn: BusinessDate | null;
  /** How many times the review has already been asked for. */
  chaseCount: number;
  /** The day of the last ask, so two passes in one day ask once. */
  lastChasedOn: BusinessDate | null;
};

export type SampleChase = {
  sampleId: string;
  sourceType: string;
  sourceId: string;
  /** 1-based. The third chase is the third time anybody has asked. */
  chaseNumber: number;
  /** The day this rung came due, which may be well in the past. */
  dueOn: BusinessDate;
  title: string;
  detail: string;
};

/**
 * How many days after delivery the nth chase falls.
 *
 * The ladder is a list of days FROM the sample being received — 2, then 4,
 * then 6 — and past its end the LAST INTERVAL repeats: 8, 10, 12, and on. It
 * does not stop, and that is the rule rather than an oversight. A trial nobody
 * reviewed is stock given away for nothing, and a ladder that gave up after
 * three attempts would quietly convert every hard-to-reach customer into a
 * write-off with no decision recorded anywhere. Somebody ends this by getting
 * an answer, or by cancelling the sample and saying why.
 *
 * A one-rung ladder repeats that rung as its own interval, because there is no
 * gap to read and the honest reading of "[3]" is "every three days".
 */
export function chaseOffset(chaseDays: readonly number[], chaseNumber: number): number {
  const days = chaseDays.filter((d) => Number.isFinite(d) && d >= 0);
  if (!days.length) return chaseNumber; /* nothing configured: ask daily */
  if (chaseNumber <= days.length) return days[chaseNumber - 1]!;
  const last = days[days.length - 1]!;
  const gap = days.length >= 2 ? last - days[days.length - 2]! : last;
  /* A ladder somebody typed backwards would otherwise walk into the past and
     fire every rung at once. One day is the floor a chase can be worth. */
  const step = Math.max(1, gap);
  return last + (chaseNumber - days.length) * step;
}

/**
 * Is this sample's review chase due today, and which rung is it?
 *
 * Answers null for everything that is not waiting on an answer: a sample not
 * yet delivered has nothing to review, and one that has been reviewed,
 * refused or cancelled is finished. `trial_done` still counts — the customer
 * has used it and we still do not know what they thought, which is precisely
 * the sample worth chasing.
 */
export function sampleChaseDue(
  sample: SampleChaseInput,
  today: BusinessDate,
  chaseDays: readonly number[],
): SampleChase | null {
  if (sample.state !== "received" && sample.state !== "trial_done") return null;
  if (!sample.receivedOn) return null;
  /* Two passes in one day is one ask. The office ringing twice before lunch
     because a job was re-run is the customer's experience of our idempotency. */
  if (sample.lastChasedOn && sample.lastChasedOn >= today) return null;

  const chaseNumber = Math.max(0, sample.chaseCount) + 1;
  const dueOn = addDays(sample.receivedOn, chaseOffset(chaseDays, chaseNumber));
  if (dueOn > today) return null;

  return {
    sampleId: sample.id,
    sourceType: NURTURE_SOURCE_TYPE,
    /* Keyed on the rung, so the fourth ask is a new task and the fourth pass
       over an unanswered third ask is not. */
    sourceId: `sample_review:${sample.id}:${chaseNumber}`,
    chaseNumber,
    dueOn,
    title: chaseNumber === 1 ? "Sample review call" : `Sample review call — ask ${chaseNumber}`,
    detail:
      chaseNumber <= 2
        ? "Have they tried it, and what did they think?"
        : `Asked ${chaseNumber - 1} times already with no answer. Worth ringing yourself.`,
  };
}
