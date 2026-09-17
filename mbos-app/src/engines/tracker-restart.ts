/**
 * WHEN A DEAD TRACKER MAY BE STARTED AGAIN, and how often.
 *
 * `trail-watchdog.ts` next door answers "is the OS lying to us". This answers
 * the question that comes immediately after it, and the answer this app gave
 * for the whole life of the module was GIVE UP: `fallBackToFloor` set a
 * module-level `backgroundProvedSilent`, nothing ever cleared it, and every
 * later `start()` — the check-in's, every foreground resume's, the afternoon
 * session's — fell through to a `setInterval`. A `setInterval` only advances
 * while the app is the thing on screen, so a phone that went back into a
 * pocket recorded nothing at all for the rest of the day. The demotion was
 * meant to salvage part of a day and on a pocketed handset it salvaged none.
 *
 * WHAT THE FIELD ACTUALLY SHOWS is that giving up is the wrong verdict on the
 * facts as well as on the outcome. Production handsets record 51 separate
 * silences inside one working day, losing 523 minutes between them — many
 * short gaps and then a burst of fixes, which is the signature of the OS
 * killing the hosting process and it only coming back when somebody opens the
 * app. A process that has been killed is not a phone that has refused: there
 * is nothing permanent to conclude, and the thing that was killed can simply
 * be started again.
 *
 * SO THE ANSWER IS "RETRY, AT A RATE SOMEBODY CHOSE", and this is where that
 * rate is decided. The objection that produced the one-way switch is real and
 * is kept: restarting on every tick of the watchdog would hand a dead task a
 * fresh silence window over and over, spend the radio, and punch the day full
 * of holes exactly the size of that window. Bounded at one attempt per
 * configured interval, the cost is one window per interval and the upside is
 * a day that comes back by itself.
 *
 * AND THERE IS A CEILING PER DAY, which is not the same control as the
 * interval. The interval bounds the cost of retrying; the ceiling is what
 * stops a handset the OS will never let track from spending a whole field day
 * waking its GPS chip to be killed again — on a phone that is already the
 * reason somebody is worried about battery. Past it the app stops asking and
 * says so, which is a support call the office can answer rather than a loop
 * nobody can see.
 *
 * THE COUNT IS PER CALENDAR DAY, and the day is carried rather than derived
 * from the mark. Deriving it would mean naming a timezone in here, and a
 * date-only string parses as UTC in JavaScript — the rule the whole codebase
 * keeps. The caller has `isoDate`, which is the local calendar date, and hands
 * both in. Overnight is also when a phone is charged and when an OEM battery
 * manager's own bookkeeping resets, so a new day is a genuinely new question
 * rather than only a convenient place to zero a counter.
 *
 * PURE, and an engine rather than three lines inside `sync/trail.ts`, for the
 * reason `cadence.ts` and `trail-watchdog.ts` both give and this module's own
 * history proves twice over: that file imports expo-location and TaskManager
 * at module scope, so nothing in it can be exercised without a device. The
 * `timeInterval` bug lived three days in the field for exactly that reason,
 * and the boolean that was never cleared lived for the whole life of every
 * process that hit it — on the one path nobody watches, with the handset still
 * reporting for itself that everything was fine.
 */

/**
 * What this handset has already tried, and on which LOCAL calendar day.
 *
 * `attempts` counts restarts made on `day` and nothing else; a mark from
 * yesterday is read as a clean slate rather than being carried forward, which
 * is `rollOver` below.
 */
export type RestartRecord = {
  /** Epoch ms of the last attempt. 0 is "no attempt this process has seen". */
  at: number;
  /** `isoDate(new Date())` at the moment of that attempt. */
  day: string;
  /** How many attempts have been made on that day. */
  attempts: number;
};

export const NO_RESTARTS: RestartRecord = { at: 0, day: '', attempts: 0 };

export type RestartInput = {
  record: RestartRecord;
  /** Now, in epoch ms. */
  now: number;
  /** Today's LOCAL calendar date, `isoDate(new Date())`. */
  today: string;
  /** How long one attempt stands before another is worth its cost. */
  minIntervalMs: number;
  /** How many attempts a single day may make before the app stops asking. */
  maxPerDay: number;
};

/**
 * The record as it applies to TODAY — yesterday's attempts do not count
 * against this morning.
 *
 * Separate from `mayRestartTracker` because the caller needs it too: the
 * number the office is shown is "restarts today", and reading it off a stored
 * record from a previous day would report six restarts on a handset that has
 * made none since breakfast. One rule, two readers.
 */
export function rollOver(record: RestartRecord, today: string): RestartRecord {
  if (!record || record.day !== today) return { at: 0, day: today, attempts: 0 };
  const attempts = Number.isFinite(record.attempts) ? Math.max(0, record.attempts) : 0;
  const at = Number.isFinite(record.at) && record.at > 0 ? record.at : 0;
  return { at, day: today, attempts };
}

/**
 * May the tracker be started again right now?
 *
 * A CLOCK THAT WENT BACKWARDS RETRIES rather than waiting out a mark it can
 * never reach. That is the same reading `shouldKeepFix` and `trailVerdict`
 * both give a mark in the future, and the trade here is the mildest of the
 * three: being wrong costs one registration attempt, and being wrong the other
 * way is a phone that records nothing until it catches up with a future it no
 * longer believes in.
 *
 * A ceiling of zero or less is read as NO CEILING rather than as "never
 * restart". A setting that silently disabled the only mechanism that brings a
 * dead trail back would be the most expensive possible way to express "I was
 * not sure what to put here", and `checkConsistency` has no way to catch a
 * number that is merely unwise.
 */
export function mayRestartTracker(i: RestartInput): boolean {
  const { now, today, minIntervalMs, maxPerDay } = i;
  const record = rollOver(i.record, today);

  if (maxPerDay > 0 && record.attempts >= maxPerDay) return false;

  /* Nothing tried today, so there is nothing to wait behind. This is the
     ordinary answer the first time a day goes quiet. */
  if (record.at <= 0) return true;

  /* Future mark: not evidence. See the note above. */
  if (now < record.at) return true;

  return now - record.at >= Math.max(0, minIntervalMs);
}

/**
 * The record to store once an attempt has actually been made.
 *
 * Written on the ATTEMPT and never on the outcome, because the outcome is not
 * knowable at the time: `startLocationUpdatesAsync` answering yes is exactly
 * the thing this whole subsystem has learned not to believe. What the interval
 * is bounding is how often we ASK, so what it counts has to be asks.
 */
export function recordRestart(record: RestartRecord, now: number, today: string): RestartRecord {
  const current = rollOver(record, today);
  return { at: now, day: today, attempts: current.attempts + 1 };
}

/**
 * How many restarts to tell the office about.
 *
 * Zero is a real answer and the common one — it means the tracker has not had
 * to be revived today, which is what a healthy handset looks like. Absence is
 * a build that cannot say, and the two must never be drawn alike; that
 * distinction is enforced at the two ends of the wire rather than here, which
 * only answers the number.
 */
export function restartsToday(record: RestartRecord, today: string): number {
  return rollOver(record, today).attempts;
}
