/**
 * §2.10 — WHAT A DAY WAS, and how long somebody actually worked it.
 *
 * `mbos_attendance_days.status` has carried the comment "derived from the
 * hours, and overridable by leave" since the table was written, and
 * `worked_seconds` has carried "derived cache: rebuilt, never typed". Nothing
 * derived either. `handleAttendance` declines to set them by name — correctly,
 * because a handset must not type its own verdict — and the job it defers to
 * was never written, so every row ever stored reads `absent` with
 * `worked_seconds` null, including days carrying a check-in, a check-out and
 * two selfies. Three screens drew a red "absent" pill on days people plainly
 * worked, and `daysOnLeave` on the salary screen was a count of a value
 * nothing ever wrote.
 *
 * This is the rule, and it is pure for the usual reason and one more: a day's
 * verdict is payroll-adjacent, it will be argued about, and an argument about
 * somebody's pay is settled far better by a test naming the case than by
 * reading a job that only runs against a database.
 *
 * ## The hours
 *
 * **The sessions are the authority, never the two day-level marks.** A day is
 * `[{ inAt, outAt }]` — 9-to-1 and then 2-to-6 is two sessions — and
 * subtracting `check_out_at` from `check_in_at` on that day answers nine
 * hours, which is exactly the lie the `sessions` column was added to kill. So
 * the figure is the SUM of the sessions that have closed.
 *
 * **An open session contributes nothing and is never run to `now`.** A man
 * still in the shop has worked an amount nobody has measured yet, and a clock
 * read at the moment a job happens to run is not a measurement of his day — it
 * is a measurement of when the cron fired. It would also make the figure move
 * every hour for a reason that has nothing to do with him.
 *
 * ## The verdict
 *
 * At or above `fullDayHours` is `present`; at or above `halfDayHours` is
 * `half_day`; below that the day did not earn either, and what it reads as
 * then depends on whether anybody accounted for it.
 *
 * **Work outranks both leave and a holiday, and that is deliberate.** A man
 * who came out and sold on a public holiday, or on a day he had leave booked,
 * has worked that day, and a record calling it `holiday` erases the only
 * evidence that he did. It is also the reading that keeps this column honest
 * against the one beside it: `daysWorked` on the salary screen counts rows
 * with a check-in and `daysOnLeave` counts rows reading `on_leave`, so a
 * worked leave day written as `on_leave` would be counted in BOTH — one day
 * paid twice on the screen a payslip is read against.
 *
 * **A holiday outranks leave where nothing was worked**, because a holiday is
 * the more specific fact and the leave engine already agrees: `leaveWorkingDays`
 * excludes holidays from a request's span, so a holiday inside somebody's leave
 * cost them nothing and reading it as leave taken would contradict the balance
 * that was actually debited.
 *
 * ## The day that cannot be judged
 *
 * `null` — for both figures — is a real answer and the job writes nothing at
 * all for it. It arises where a session is still open: today's day mid-morning,
 * and the past day `markMissedCheckouts` could not close because MahekOne holds
 * no evidence of when he stopped. That job already refuses to invent a closing
 * time for exactly this row, and inventing a verdict from the hours it declined
 * to guess would walk straight round it. `absent` on a day with a check-in and
 * a selfie is not a cautious answer, it is a false one.
 *
 * Pure, and takes the leave and the holiday as answers rather than asking:
 * whether somebody's leave was approved is a question about `mbos_approvals`
 * and belongs in the service.
 */

/** The handset's own shape, stored as it arrives. `outAt` null is open. */
export type AttendanceSession = {
  inAt: number;
  outAt: number | null;
};

export type AttendanceThresholds = {
  /** Hours at or above which the day is a full one. */
  fullDayHours: number;
  /** Hours at or above which it is at least a half. Below it, neither. */
  halfDayHours: number;
};

export type AttendanceDayInput = {
  sessions: readonly AttendanceSession[];
  /**
   * The day-level marks, read ONLY where `sessions` is empty. See
   * `workedSecondsOf` — this is a fallback for rows an older handset wrote,
   * not a second opinion about a day that reported its sessions.
   */
  checkInAt: number | null;
  checkOutAt: number | null;
  /** Approved, uncancelled leave covering this day. */
  onApprovedLeave: boolean;
  /** A row in `mbos_holidays` for this day. */
  isHoliday: boolean;
};

export type AttendanceStatus =
  | "present"
  | "half_day"
  | "absent"
  | "on_leave"
  | "holiday";

export type AttendanceVerdict = {
  /** Seconds worked, or null where a session is still open. */
  workedSeconds: number | null;
  /** The verdict, or null where there is not one to give yet. */
  status: AttendanceStatus | null;
};

/**
 * A day cannot be longer than a day.
 *
 * A handset clock that jumped, a session left open across midnight and closed
 * the following evening, or a `resumedAt` that reopened a row nobody meant to
 * reopen all produce a session measured in days. None of those is somebody
 * working thirty hours, and the figure reaches a screen headed "Worked" — so
 * the total is capped rather than believed. A capped day is still `present`,
 * which is the one thing about it that is certainly true.
 */
const MAX_DAY_SECONDS = 24 * 60 * 60;

/**
 * What the closed sessions add up to, or null while one is still open.
 *
 * **The empty list falls back to the two marks, and only the empty list.** The
 * `sessions` column arrived after the table did, so a row written by an older
 * handset carries `[]` beside a real check-in and a real check-out — and
 * reading that as zero seconds would report a full day as no hours at all and
 * mark the man absent, which is the bug this whole engine exists to end,
 * arriving through the back door. A day that reported no sessions is a day
 * MahekOne only ever knew as one pair, so the pair is the best evidence there
 * is; the break it cannot see was never recorded anywhere and no reading of
 * this row can recover it. Where sessions ARE present they are the whole
 * answer and the marks are not consulted, because that is the case the column
 * was added for.
 */
export function workedSecondsOf(day: AttendanceDayInput): number | null {
  if (day.sessions.length === 0) {
    if (day.checkInAt == null) return 0;
    if (day.checkOutAt == null) return null;
    return clampSeconds(day.checkOutAt - day.checkInAt);
  }

  /* Milliseconds, like every other figure on the wire here, and rounded to
     seconds once at the end — rounding each session would drift a day of six
     short visits by a few seconds for no reason anybody could explain. */
  let total = 0;
  for (const session of day.sessions) {
    /* Still out there. The day is unmeasured, not short. */
    if (session.outAt == null) return null;
    /* A close at or before its own open measures nothing. It is a clock that
       went backwards between two writes on one phone, and subtracting it would
       take time OFF a day somebody worked. */
    if (session.outAt > session.inAt) total += session.outAt - session.inAt;
  }
  return clampSeconds(total);
}

function clampSeconds(millis: number): number {
  const seconds = Math.round(millis / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(seconds, MAX_DAY_SECONDS);
}

/**
 * The day's verdict and its hours, from the sessions, the thresholds, the
 * leave and the calendar.
 *
 * Returns `status: null` where there is no verdict to give — see the note at
 * the top of the file. The caller writes nothing for those rows rather than
 * choosing between two wrong answers.
 */
export function attendanceVerdict(
  day: AttendanceDayInput,
  thresholds: AttendanceThresholds,
): AttendanceVerdict {
  const workedSeconds = workedSecondsOf(day);

  if (workedSeconds == null) return { workedSeconds: null, status: null };

  const hours = workedSeconds / 3600;

  /* Work first, and above everything. See the header: a day somebody worked
     reads as worked whatever the calendar or the leave register says about
     it. `checkConsistency` in the registry refuses a half-day threshold at or
     above the full day, so these two cannot overlap. */
  if (hours >= thresholds.fullDayHours) return { workedSeconds, status: "present" };
  if (hours >= thresholds.halfDayHours) return { workedSeconds, status: "half_day" };

  /* Nothing that counts as time worked. Who accounted for the day, then? */
  if (day.isHoliday) return { workedSeconds, status: "holiday" };
  if (day.onApprovedLeave) return { workedSeconds, status: "on_leave" };

  /* Nobody. An hour logged on a day nobody booked off is still an absent day
     by the company's own thresholds — and `workedSeconds` rides along beside
     it, so the screen can show the hour rather than implying there was none. */
  return { workedSeconds, status: "absent" };
}
