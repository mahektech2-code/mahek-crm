/**
 * WHEN A DEMOTED HANDSET MAY TRY THE REAL TRACKER AGAIN.
 *
 * `trail-watchdog.ts` next door answers "is the OS lying to us"; this answers
 * the question that comes immediately after it and had no answer at all.
 *
 * WHAT WAS THERE WAS A ONE-WAY SWITCH. `backgroundProvedSilent` was a
 * module-level boolean, set by the watchdog and cleared by nothing, and
 * `start()` read it before doing anything else — so the FIRST demotion of a
 * process was its last word on the subject. Every later `start()` — the one
 * the check-in makes, the one every foreground resume makes, the one the
 * afternoon session makes — fell through to the floor and did nothing. And the
 * floor is a `setInterval`, which only advances while the app is the thing on
 * screen, so a phone that went back in a pocket recorded nothing at all for the
 * rest of the day. The demotion was meant to salvage part of a day and on a
 * pocketed handset it salvaged none.
 *
 * The objection that produced the one-way switch is real and is kept: retrying
 * on EVERY resume clears the floor's timer each time, hands a dead task another
 * whole silent window to prove itself, and leaves the day punched full of holes
 * exactly the size of that window. So the answer is not "retry always", it is
 * "retry at a rate somebody chose" — the cost is then bounded at one window per
 * retry interval instead of one per resume.
 *
 * THREE THINGS RE-OPEN THE QUESTION and they are three different reasons:
 *
 *   A NEW CALENDAR DAY. The verdict was about yesterday's phone. Overnight is
 *   when a salesman is told to go into Settings, when a phone is charged, and
 *   when an OEM battery manager's own daily bookkeeping resets — and a day is
 *   the unit everything else in this app is judged in.
 *
 *   A FRESH CHECK-IN. He has just been through the start-of-day gate, which is
 *   the screen that walks him to the autostart switch; refusing to re-test the
 *   thing he was just sent to fix is the one shape that would make that screen
 *   pointless. This is also the afternoon session after lunch, which is a new
 *   attempt by any reading.
 *
 *   TIME PASSING. A battery manager that killed the service while the phone was
 *   hot and on 3% does not keep killing it once it is on charge, and nothing
 *   ever tells the app that it stopped. Waiting a configured interval and
 *   trying once is how that is ever discovered.
 *
 * PURE, and an engine rather than three lines inside `sync/trail.ts`, for the
 * reason `cadence.ts` and `trail-watchdog.ts` both give and this module's own
 * history proves twice: that file imports expo-location and TaskManager at
 * module scope, so nothing in it can be exercised without a device. The
 * `timeInterval` bug lived three days in the field for exactly that reason, and
 * this one — a boolean that was never cleared — lived for the whole life of
 * every process that hit it, on the one path nobody watches, with the handset
 * still reporting for itself that everything was fine.
 */

/**
 * A demotion this process made: when, and on which LOCAL calendar day.
 *
 * The day is carried rather than derived from `at` because deriving it would
 * mean naming a timezone in here, and a date-only string parses as UTC in
 * JavaScript — the rule the whole codebase keeps. The caller has `isoDate`,
 * which is the local calendar date, and hands both in.
 *
 * `null` is a process that has not demoted, which is most of them.
 */
export type Demotion = { at: number; day: string } | null;

export type RetryInput = {
  demotion: Demotion;
  /** Now, in epoch ms. */
  now: number;
  /** Today's LOCAL calendar date, `isoDate(new Date())`. */
  today: string;
  /**
   * Is this call a check-in — the morning one or the one after lunch — rather
   * than an ordinary foreground resume?
   */
  freshCheckIn: boolean;
  /** How long a demotion stands before one more attempt is worth its cost. */
  retryAfterMs: number;
};

/**
 * May `start()` attempt background registration again?
 *
 * A CLOCK THAT WENT BACKWARDS RETRIES rather than waiting out a mark it can
 * never reach. That is the same reading `shouldKeepFix` and `trailVerdict` both
 * give a mark in the future, and the trade here is the mildest of the three:
 * the cost of being wrong is one extra registration attempt, and the cost of
 * the other direction is a phone that stays on a dead floor until it catches up
 * with a future it no longer believes in.
 */
export function mayRetryBackground(i: RetryInput): boolean {
  const { demotion, now, today, freshCheckIn, retryAfterMs } = i;

  /* Nothing has been concluded about this process, so there is nothing to
     stand on. This is the ordinary answer. */
  if (!demotion) return true;
  if (!Number.isFinite(demotion.at) || demotion.at <= 0) return true;

  /* He has just been through the gate and, on a blocking deployment, has just
     said he did the steps. Re-testing is the whole point of asking. */
  if (freshCheckIn) return true;

  /* A verdict about a phone on another day is not a verdict about today's. */
  if (demotion.day !== today) return true;

  /* Future mark: not evidence. See the note above. */
  if (now < demotion.at) return true;

  return now - demotion.at >= Math.max(0, retryAfterMs);
}
