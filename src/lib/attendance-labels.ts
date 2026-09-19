/**
 * THE VERDICT AS WORDS, and the one case where the stored value is not one.
 *
 * `mbos_attendance_days.status` is NOT NULL and defaults to `absent`, so the
 * column cannot say "nobody has judged this day". The job that writes it
 * deliberately leaves a day alone where a session is still open — today's day
 * while it is being worked, and the past day `markMissedCheckouts` could not
 * close because MahekOne holds no evidence of when the man stopped — and on
 * those rows `absent` is the DEFAULT sitting there, not a judgement anybody
 * made. Drawn as a red "absent" pill beside a check-in time and a selfie, it is
 * the same lie this whole change was written to end, merely one row narrower.
 *
 * `worked_seconds` is what tells them apart: null with a check-in means the
 * hours were never measured, which is exactly the state the engine refuses to
 * judge. So the reading is a pure function of the row, held in one place
 * because two screens draw it and a second copy typed into one of them would
 * drift — and the half that drifts is always the half somebody is reading.
 *
 * Pure and client-safe, like `customer-health.ts` and `seat-labels.ts` beside
 * it: both callers are components.
 */

export type VerdictTone = "success" | "warn" | "danger" | "brand";

export type VerdictReading = {
  word: string;
  tone: VerdictTone;
  /** The sentence behind the word, for a `title`. Null where it needs none. */
  title: string | null;
};

export function readAttendanceVerdict(row: {
  status: string;
  /** Whether the day has a check-in mark at all. */
  hasCheckIn: boolean;
  /** The derived cache: null where the hours were never measured. */
  workedSeconds: number | null;
}): VerdictReading {
  if (row.hasCheckIn && row.workedSeconds == null) {
    return {
      word: "not measured",
      tone: "warn",
      title:
        "He checked in and nothing anywhere records when he stopped — either the day is still being worked, or it was never closed and there was no position, activity or visit to close it at. No verdict was given, rather than one being guessed at.",
    };
  }

  switch (row.status) {
    case "present":
      return { word: "present", tone: "success", title: null };
    case "half_day":
      return { word: "half day", tone: "warn", title: null };
    case "on_leave":
      return { word: "on leave", tone: "brand", title: "Approved leave covers this day." };
    case "holiday":
      return { word: "holiday", tone: "brand", title: "A company holiday nobody worked." };
    case "absent":
      return { word: "absent", tone: "danger", title: null };
    default:
      /* A value the enum grew and this file has not been taught. Said as it is
         stored rather than folded into one of the five above, because a new
         verdict quietly drawn as an old one is worse than an odd-looking word. */
      return { word: row.status.replace(/_/g, " "), tone: "warn", title: null };
  }
}
