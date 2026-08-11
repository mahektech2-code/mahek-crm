/**
 * What a day's check-ins add up to.
 *
 * One rule shapes the whole file: **a missed check-out is flagged for
 * regularization, never guessed at.** The temptation is to close the session at
 * the last GPS ping, or at six o'clock, or at whatever the shift is supposed to
 * be — and every one of those writes a number into somebody's attendance record
 * that nobody can defend. A phone that ran out of battery in a market at four
 * o'clock is a fact about the phone; the hours are a question for the salesman
 * and his manager, asked through regularization, which is a screen that exists
 * for exactly this.
 *
 * So an open session contributes **zero minutes** and raises a flag. It reads
 * harshly for a moment and it is the only honest answer: the alternative pays
 * or docks somebody on the strength of a guess.
 *
 * Pure — the sessions arrive as timestamps and every threshold as an argument.
 */

export type AttendanceStatus = 'Present' | 'Half Day' | 'Absent' | 'On Leave' | 'Weekly Off';

export type AttendanceSession = {
  id: string;
  /** Epoch ms. */
  checkInAt: number;
  /** Epoch ms, or null where the day was never closed. */
  checkOutAt: number | null;
};

export type ApprovedLeave = {
  /** 'casual', 'sick', whatever the org calls it — carried through to the sentence. */
  kind: string;
  /** A half-day leave halves what the day is expected to be, it does not excuse it. */
  portion: 'full' | 'half';
};

export type AttendanceInputs = {
  sessions: readonly AttendanceSession[];
  /** Worked hours at or above which the day counts as half. Configuration. */
  halfDayThresholdHours: number;
  /**
   * Worked hours at or above which the day counts as full.
   *
   * The brief named only the half-day threshold, but a rule with one number
   * cannot separate Present from Half Day without inventing the other — and an
   * invented one would be a literal in this function body, which is exactly
   * what is not allowed here. So both arrive from configuration.
   */
  fullDayThresholdHours: number;
  /** False for a Sunday or a company holiday. */
  isWorkingDay: boolean;
  approvedLeave: ApprovedLeave | null;
};

export type AttendanceResult = {
  status: AttendanceStatus;
  /** Summed across every CLOSED session. Open ones contribute nothing. */
  workedMinutes: number;
  /** Sessions with no check-out. Their ids, so a screen can offer each one. */
  openSessionIds: string[];
  needsRegularization: boolean;
  sentence: string;
};

const MS_PER_MINUTE = 60_000;

export function deriveStatus(inputs: AttendanceInputs): AttendanceResult {
  const openSessionIds: string[] = [];
  let workedMinutes = 0;

  for (const s of inputs.sessions) {
    if (s.checkOutAt == null) {
      openSessionIds.push(s.id);
      continue;
    }
    // A check-out before its check-in is a clock somebody changed. It is not
    // negative time; it is a session that cannot be read, so it is flagged too.
    if (s.checkOutAt < s.checkInAt) {
      openSessionIds.push(s.id);
      continue;
    }
    workedMinutes += (s.checkOutAt - s.checkInAt) / MS_PER_MINUTE;
  }
  workedMinutes = Math.round(workedMinutes);

  const needsRegularization = openSessionIds.length > 0;
  const workedHours = workedMinutes / 60;

  // A half-day leave leaves half a day to be worked, so the bar for the day
  // being complete drops to the half-day threshold.
  const fullBar =
    inputs.approvedLeave?.portion === 'half'
      ? inputs.halfDayThresholdHours
      : inputs.fullDayThresholdHours;

  const base = { workedMinutes, openSessionIds, needsRegularization };

  if (inputs.approvedLeave?.portion === 'full') {
    return {
      ...base,
      status: 'On Leave',
      sentence: workedMinutes > 0
        ? `On approved ${inputs.approvedLeave.kind} leave, with work logged against the day — worth a word with your manager.`
        : `On approved ${inputs.approvedLeave.kind} leave.`,
    };
  }

  // A Sunday with nothing logged is not an absence. Marking it one puts a black
  // mark against every person in the company every week, and a status nobody
  // can be at fault for is a status the four the brief names cannot express —
  // hence the fifth.
  if (!inputs.isWorkingDay && workedMinutes === 0 && !needsRegularization) {
    return { ...base, status: 'Weekly Off', sentence: 'Not a working day.' };
  }

  if (workedHours >= fullBar) {
    return {
      ...base,
      status: 'Present',
      sentence: needsRegularization
        ? `${describe(workedMinutes)} logged, and a session left open — regularize it.`
        : `${describe(workedMinutes)} logged.`,
    };
  }

  if (workedHours >= inputs.halfDayThresholdHours) {
    return {
      ...base,
      status: 'Half Day',
      sentence: needsRegularization
        ? `${describe(workedMinutes)} logged, and a session left open — regularize it.`
        : `${describe(workedMinutes)} logged — short of a full day.`,
    };
  }

  return {
    ...base,
    status: 'Absent',
    sentence: needsRegularization
      ? 'A session was never closed, so nothing counts yet — regularize it and the day will recalculate.'
      : workedMinutes > 0
        ? `Only ${describe(workedMinutes)} logged.`
        : 'No check-in on record.',
  };
}

function describe(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
