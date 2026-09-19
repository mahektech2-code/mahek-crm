/**
 * WHAT A DAY WAS — the cases, named.
 *
 *   npm run test
 *
 * These are the arguments people have about their own pay, so each one is a
 * test with the reason in its name rather than a line in a job nobody reads.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  attendanceVerdict,
  workedSecondsOf,
  type AttendanceDayInput,
  type AttendanceThresholds,
} from "./attendance";

/** The shipped defaults: eight hours a full day, four a half. */
const HOURS: AttendanceThresholds = { fullDayHours: 8, halfDayHours: 4 };

const at = (hm: string) => new Date(`2026-09-08T${hm}:00+05:30`).getTime();

function day(over: Partial<AttendanceDayInput> = {}): AttendanceDayInput {
  return {
    sessions: [],
    checkInAt: null,
    checkOutAt: null,
    onApprovedLeave: false,
    isHoliday: false,
    ...over,
  };
}

describe("the hours", () => {
  it("sums the sessions and never the two day-level marks", () => {
    /* 9-to-1 and 2-to-6: eight hours worked across a nine-hour day. The pair
       of marks would answer nine, which is the whole reason the column
       exists. */
    const d = day({
      sessions: [
        { inAt: at("09:00"), outAt: at("13:00") },
        { inAt: at("14:00"), outAt: at("18:00") },
      ],
      checkInAt: at("09:00"),
      checkOutAt: at("18:00"),
    });
    assert.equal(workedSecondsOf(d), 8 * 3600);
    assert.equal(attendanceVerdict(d, HOURS).status, "present");
  });

  it("answers null while a session is still open, rather than running it to now", () => {
    const d = day({
      sessions: [
        { inAt: at("09:00"), outAt: at("13:00") },
        { inAt: at("14:00"), outAt: null },
      ],
      checkInAt: at("09:00"),
    });
    assert.deepEqual(attendanceVerdict(d, HOURS), { workedSeconds: null, status: null });
  });

  it("falls back to the two marks only where no sessions were reported", () => {
    /* An older handset, before the sessions column. Reading the empty list as
       zero would mark a full day absent. */
    const d = day({ checkInAt: at("09:30"), checkOutAt: at("18:30") });
    assert.equal(workedSecondsOf(d), 9 * 3600);
    assert.equal(attendanceVerdict(d, HOURS).status, "present");
  });

  it("counts nothing for a session that closed before it opened", () => {
    const d = day({
      sessions: [
        { inAt: at("09:00"), outAt: at("08:00") },
        { inAt: at("10:00"), outAt: at("15:00") },
      ],
    });
    assert.equal(workedSecondsOf(d), 5 * 3600);
  });

  it("caps a day at twenty-four hours", () => {
    const d = day({
      sessions: [{ inAt: at("09:00"), outAt: at("09:00") + 40 * 3600 * 1000 }],
    });
    assert.equal(workedSecondsOf(d), 24 * 3600);
  });
});

describe("the verdict", () => {
  it("reads a full day as present", () => {
    const d = day({ sessions: [{ inAt: at("09:00"), outAt: at("17:30") }] });
    assert.deepEqual(attendanceVerdict(d, HOURS), {
      workedSeconds: 8.5 * 3600,
      status: "present",
    });
  });

  it("reads exactly the full-day threshold as present, not as a half", () => {
    const d = day({ sessions: [{ inAt: at("09:00"), outAt: at("17:00") }] });
    assert.equal(attendanceVerdict(d, HOURS).status, "present");
  });

  it("reads a short day above the half-day threshold as a half day", () => {
    const d = day({ sessions: [{ inAt: at("09:00"), outAt: at("14:00") }] });
    assert.deepEqual(attendanceVerdict(d, HOURS), {
      workedSeconds: 5 * 3600,
      status: "half_day",
    });
  });

  it("reads a day under the half-day threshold as absent, and keeps the hours", () => {
    /* The hour he did work is still on the row. A screen that showed the
       verdict and no figure would read as somebody who never turned up. */
    const d = day({ sessions: [{ inAt: at("09:00"), outAt: at("10:00") }] });
    assert.deepEqual(attendanceVerdict(d, HOURS), {
      workedSeconds: 3600,
      status: "absent",
    });
  });

  it("reads a row with no check-in at all as absent, at zero hours", () => {
    assert.deepEqual(attendanceVerdict(day(), HOURS), { workedSeconds: 0, status: "absent" });
  });
});

describe("what outranks what", () => {
  it("reads an approved leave day nobody worked as on leave", () => {
    const d = day({ onApprovedLeave: true });
    assert.deepEqual(attendanceVerdict(d, HOURS), { workedSeconds: 0, status: "on_leave" });
  });

  it("reads a holiday nobody worked as a holiday", () => {
    const d = day({ isHoliday: true });
    assert.equal(attendanceVerdict(d, HOURS).status, "holiday");
  });

  it("prefers the holiday to the leave where both cover a day nobody worked", () => {
    /* `leaveWorkingDays` excluded this day from the request's span, so it cost
       no balance — calling it leave taken would contradict what was debited. */
    const d = day({ isHoliday: true, onApprovedLeave: true });
    assert.equal(attendanceVerdict(d, HOURS).status, "holiday");
  });

  it("lets WORK outrank a holiday", () => {
    const d = day({
      isHoliday: true,
      sessions: [{ inAt: at("09:00"), outAt: at("18:00") }],
    });
    assert.equal(attendanceVerdict(d, HOURS).status, "present");
  });

  it("lets WORK outrank approved leave, so no day is counted worked and on leave at once", () => {
    const d = day({
      onApprovedLeave: true,
      sessions: [{ inAt: at("09:00"), outAt: at("14:00") }],
    });
    assert.equal(attendanceVerdict(d, HOURS).status, "half_day");
  });

  it("still accounts for a leave day somebody dropped in on for half an hour", () => {
    /* Below every threshold, so the leave is what explains the day. */
    const d = day({
      onApprovedLeave: true,
      sessions: [{ inAt: at("11:00"), outAt: at("11:30") }],
    });
    assert.deepEqual(attendanceVerdict(d, HOURS), { workedSeconds: 1800, status: "on_leave" });
  });

  it("gives no verdict for an unclosed day, whatever the calendar says about it", () => {
    /* The day `markMissedCheckouts` could not close: a check-in, a selfie, and
       nothing anywhere saying when he stopped. Neither absent nor present is
       true, and a holiday flag must not decide it either. */
    const d = day({
      isHoliday: true,
      sessions: [{ inAt: at("09:00"), outAt: null }],
    });
    assert.deepEqual(attendanceVerdict(d, HOURS), { workedSeconds: null, status: null });
  });

  it("follows the configured thresholds rather than the eight-hour default", () => {
    const d = day({ sessions: [{ inAt: at("09:00"), outAt: at("15:00") }] });
    assert.equal(attendanceVerdict(d, { fullDayHours: 6, halfDayHours: 3 }).status, "present");
    assert.equal(attendanceVerdict(d, { fullDayHours: 9, halfDayHours: 6 }).status, "half_day");
    assert.equal(attendanceVerdict(d, { fullDayHours: 12, halfDayHours: 7 }).status, "absent");
  });
});
