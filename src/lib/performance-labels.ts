/* ---------------------------------------------------------------------------
 * THE TWO COMPONENTS WHOSE TARGET IS A SHARE, AND HOW THEY ARE SAID.
 *
 * Four of the six things a salesman is scored on are absolute: rupees of
 * revenue, litres of volume, a count of new customers, and the product mix,
 * which is already a percentage of itself. Two are not. Collection is a share
 * of WHAT WAS ALREADY OVERDUE at the start of the month, and activity is a
 * share of THE TASKS THAT FELL DUE in it — both of them a numerator over a
 * base that somebody else's book decides.
 *
 * Every screen drew the numerator alone. "₹2.4L collected · 73%" leaves a
 * manager with no way to know 73% of what, and "18 · 45%" is worse, because
 * `activityAssigned` sits on the same record saying forty and is discarded on
 * the way to the cell. `PersonActuals` says it in its own comment — "the count
 * of completed tasks says nothing on its own: twelve tasks and a hundred tasks
 * were both held to 'ten done'" — which is exactly what the screen printed.
 *
 * So the words live here, once: two manager tables, two personal screens, the
 * accounts achievement tab, the team brief and the handset render these, and a
 * ratio phrased seven ways is seven screens nobody reconciles.
 *
 * IT IMPORTS NOTHING, AND THAT IS DELIBERATE. The handset is a separate
 * TypeScript program that cannot import from here, so this file is MIRRORED to
 * `mbos-app/src/engines/performance-labels.ts` and `mbos-wire.test.ts` compares
 * the two as text. An import of `format` would make the copies differ on a line
 * that is not an import path — the one difference that test allows — so money
 * is rendered by a function the caller passes in. The office passes `money`,
 * the phone passes `inrFromPaise`, and neither has to know about the other.
 *
 * WHAT IS NOT HERE is any scoring. `performance-service` converts the
 * percentage target into an implied rupee or task figure and scores it exactly
 * as it scores every absolute component; none of that moves. This decides only
 * what a reader is shown.
 * ------------------------------------------------------------------------- */

/** A component measured as a share of a base somebody else's book decides. */
export type RatioReading = {
  /** What they did — money collected, or tasks completed. */
  done: number;
  /**
   * What it is a share of. Zero means there was nothing to do; NULL means
   * nobody recorded one, which a handset row pulled by an older build is.
   */
  base: number | null;
};

/** How a caller turns paise into words. `money`, `moneyShort`, `inrFromPaise`. */
export type RenderMoney = (paise: number) => string;

/**
 * WHAT THE SHARE IS, or null where there was no base.
 *
 * Null is not zero and the two must never be drawn alike. A book with no old
 * debt, or a month nobody was given a task in, has NOTHING TO BE MEASURED ON —
 * which is why `performance-service` gives it an implied target of zero and
 * `achievementBp` drops it from the score as "not asked" rather than failing
 * it. A screen printing "0%" there invents a failure the scoring deliberately
 * refuses to record, against the person least able to argue with it.
 */
export function shareBp({ done, base }: RatioReading): number | null {
  if (base == null || base <= 0) return null;
  return Math.round((done / base) * 10_000);
}

/**
 * The collection figure as a sentence: what came in, and what it was a share
 * of.
 *
 * The base is the WHOLE of the honest version. Collection is not "money
 * collected" — a bill that falls due on the 15th and is paid on the 20th is
 * ordinary business and no part of this component. It is old debt being worked
 * down, and how much old debt there was is the manager's first question.
 */
export function collectionLine(reading: RatioReading, render: RenderMoney): string {
  if (reading.base == null) return BASE_NOT_RECORDED;
  if (reading.base <= 0) return NOTHING_OVERDUE;
  return `${render(reading.done)} of ${render(reading.base)} overdue`;
}

/**
 * And the same for tasks. "18 of 40 tasks" is the figure; "18" is a number
 * somebody can meet by being given fewer tasks, which is not a target.
 */
export function activityLine(reading: RatioReading): string {
  if (reading.base == null) return BASE_NOT_RECORDED;
  if (reading.base <= 0) return NOTHING_ASSIGNED;
  return `${reading.done} of ${reading.base} tasks`;
}

/**
 * The SECOND HALF of the same sentence, for a table cell that has room for a
 * figure and a muted line under it rather than for a phrase.
 *
 * The cell keeps "₹2.40L" as the number somebody scans down a column, and this
 * goes underneath: "of ₹8.10L overdue". Same words, same source, so a cell and
 * a tile cannot end up describing one month two ways.
 */
export function collectionSub(reading: RatioReading, render: RenderMoney): string {
  if (reading.base == null) return BASE_NOT_RECORDED;
  return reading.base <= 0 ? NOTHING_OVERDUE : `of ${render(reading.base)} overdue`;
}

/** And the same half for tasks: "of 40 set". */
export function activitySub(reading: RatioReading): string {
  if (reading.base == null) return BASE_NOT_RECORDED;
  return reading.base <= 0 ? NOTHING_ASSIGNED : `of ${reading.base} set`;
}

/**
 * What a zero base says, in words rather than as a figure.
 *
 * These are STATEMENTS ABOUT THE MONTH, not about the person: nothing was
 * overdue, nobody was given anything to do. Both read as good news or as
 * nothing at all, and neither reads as a failure — which is the whole reason
 * they are sentences instead of "0%".
 */
export const NOTHING_OVERDUE = "nothing was overdue";
export const NOTHING_ASSIGNED = "no tasks were set";

/**
 * And the third answer, which is neither.
 *
 * The office has always had both bases to hand; the handset reads a cached row
 * and only started being sent them when the columns arrived. A row written
 * before that carries null, and the phone must not read it as "nothing was
 * overdue" — that is a claim about somebody's month, made on the strength of a
 * column that did not exist.
 */
export const BASE_NOT_RECORDED = "not recorded";

/** `6000` → `"60%"`. Null — no base, or nothing asked — prints a dash. */
export function bpPercent(bp: number | null | undefined): string {
  return bp == null ? "—" : `${(bp / 100).toFixed(0)}%`;
}
