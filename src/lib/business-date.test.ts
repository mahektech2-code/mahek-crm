import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  businessDate,
  calendarDate,
  calendarDaysBetween,
  dayBoundaryWindow,
  daysBetween,
  isDashboardPeriod,
  periodRange,
  previousRange,
  rangeBoundaryWindow,
} from "./business-date";

/* ---------------------------------------------------------------------------
 * The two kinds of day, and the five hours a night they disagree.
 *
 * These exist because the bug they describe was caught by a test that only
 * failed between midnight and 5am — which is to say, it passed every time
 * anybody ran it deliberately, and failed on whoever happened to be working
 * late. Nothing here reads the clock: the instants are fixed, so the window
 * is always under test.
 * ------------------------------------------------------------------------- */

const IST = "Asia/Kolkata";
const WORKING_DAY = { timezone: IST, dayBoundaryHour: 5, workingDays: [1, 2, 3, 4, 5, 6] };

/** 1am IST on 11 August: inside the window, before the 5am boundary. */
const OVERNIGHT = new Date("2026-08-10T19:30:00Z");
/** 10am IST on 11 August: an ordinary hour, where the two agree. */
const DAYTIME = new Date("2026-08-11T04:30:00Z");

describe("a call at 1am belongs to the shift that started yesterday", () => {
  test("the business date steps back before the boundary", () => {
    assert.equal(businessDate(OVERNIGHT, WORKING_DAY), "2026-08-10");
  });

  test("the calendar date does not, and that is deliberate", () => {
    // An order placed at 2am was placed on that date, whatever shift the
    // telecaller was working. Both functions are right; they answer different
    // questions.
    assert.equal(calendarDate(OVERNIGHT, IST), "2026-08-11");
  });

  test("they differ by exactly one day inside the window", () => {
    const business = businessDate(OVERNIGHT, WORKING_DAY);
    const calendar = calendarDate(OVERNIGHT, IST);
    assert.notEqual(business, calendar);
    assert.equal(business, "2026-08-10");
    assert.equal(calendar, "2026-08-11");

    // Note what cannot be written here: neither `daysBetween` nor
    // `calendarDaysBetween` will take one of each. An earlier draft of this
    // very test tried to difference the two to prove they were a day apart,
    // and the compiler refused it — which is the guarantee, demonstrated on
    // the person most motivated to work around it.
  });

  test("and agree for the rest of the day", () => {
    assert.equal(businessDate(DAYTIME, WORKING_DAY), calendarDate(DAYTIME, IST));
  });
});

describe("mixing the two is what put a call in the future", () => {
  test("a calendar date against a business today comes out negative", () => {
    // The shape of the original bug, written out. The Information tab took
    // the calendar date of the last call and subtracted a business today,
    // then clamped the result to zero with Math.max — so the screen said "0
    // days ago" beside a date the rest of the CRM disagreed with.
    const businessToday = businessDate(OVERNIGHT, WORKING_DAY);
    const calendarOfTheCall = calendarDate(OVERNIGHT, IST);

    // The cast is the point of this test rather than a wart on it: without
    // one, this line does not compile any more. It is the only way left to
    // write the bug down, and it is here so the arithmetic that reached a
    // telecaller's screen stays on the record.
    const wrong = daysBetween(calendarOfTheCall as string, businessToday);
    assert.equal(wrong, -1, "a call one day in the future");
    assert.equal(Math.max(0, wrong), 0, "and the clamp that hid it");
  });

  test("both sides on the same scale come out at zero, which is the truth", () => {
    const businessToday = businessDate(OVERNIGHT, WORKING_DAY);
    const businessOfTheCall = businessDate(OVERNIGHT, WORKING_DAY);
    assert.equal(daysBetween(businessOfTheCall, businessToday), 0);
  });
});

describe("the boundary is configuration, not the number five", () => {
  test("a midnight boundary makes the two kinds identical", () => {
    const midnight = { ...WORKING_DAY, dayBoundaryHour: 0 };
    assert.equal(businessDate(OVERNIGHT, midnight), calendarDate(OVERNIGHT, IST));
  });

  test("a later boundary swallows more of the morning", () => {
    // 7am IST on 11 August: past a 5am boundary, not past a 9am one.
    const earlyShift = new Date("2026-08-11T01:30:00Z");
    const nineAm = { ...WORKING_DAY, dayBoundaryHour: 9 };
    assert.equal(businessDate(earlyShift, WORKING_DAY), "2026-08-11");
    assert.equal(businessDate(earlyShift, nineAm), "2026-08-10");
  });
});

describe("spans between same-kind dates are unaffected by the boundary", () => {
  test("the gaps a buying cycle is the median of", () => {
    // Order dates are calendar dates and are differenced against each other,
    // never against today. That is why `calendarDaysBetween` exists rather
    // than a looser `daysBetween` that would have taken one of each.
    const first = calendarDate(new Date("2026-07-01T20:00:00Z"), IST); // 1:30am IST, 2 Jul
    const second = calendarDate(new Date("2026-07-21T20:00:00Z"), IST); // 1:30am IST, 22 Jul
    assert.equal(calendarDaysBetween(first, second), 20);
  });
});

/* ---------------------------------------------------------------------------
 * The dashboard's four spans.
 *
 * Pure, so what "this week" means is pinned here rather than discovered on a
 * Monday morning when the figures look wrong.
 * ------------------------------------------------------------------------- */

describe("the spans the dashboard reads over", () => {
  // Wednesday 12 August 2026. Six-day week, Sunday off.
  const WEDNESDAY = "2026-08-12";
  const MONDAY = "2026-08-10";

  test("today and yesterday are one day each", () => {
    assert.deepEqual(periodRange(WEDNESDAY, "today", WORKING_DAY), {
      from: WEDNESDAY,
      to: WEDNESDAY,
    });
    assert.deepEqual(periodRange(WEDNESDAY, "yesterday", WORKING_DAY), {
      from: "2026-08-11",
      to: "2026-08-11",
    });
  });

  test("yesterday on a Monday is Saturday, not the Sunday nobody worked", () => {
    // A Sunday of zeroes would read as a collapse every Monday morning.
    assert.deepEqual(periodRange(MONDAY, "yesterday", WORKING_DAY), {
      from: "2026-08-08",
      to: "2026-08-08",
    });
  });

  test("the week runs from Monday to today, never past it", () => {
    assert.deepEqual(periodRange(WEDNESDAY, "week", WORKING_DAY), {
      from: MONDAY,
      to: WEDNESDAY,
    });
    // On the Monday itself the week is that one day, not seven.
    assert.deepEqual(periodRange(MONDAY, "week", WORKING_DAY), {
      from: MONDAY,
      to: MONDAY,
    });
  });

  test("the month runs from the first to today", () => {
    assert.deepEqual(periodRange(WEDNESDAY, "month", WORKING_DAY), {
      from: "2026-08-01",
      to: WEDNESDAY,
    });
  });

  test("a span is measured against an equally long one immediately before", () => {
    const week = periodRange(WEDNESDAY, "week", WORKING_DAY); // 3 days
    assert.deepEqual(previousRange(week, WORKING_DAY), {
      from: "2026-08-07",
      to: "2026-08-09",
    });

    const month = periodRange(WEDNESDAY, "month", WORKING_DAY); // 12 days
    assert.deepEqual(previousRange(month, WORKING_DAY), {
      from: "2026-07-20",
      to: "2026-07-31",
    });
  });

  test("a one-day span compares against the previous WORKING day", () => {
    assert.deepEqual(previousRange({ from: MONDAY, to: MONDAY }, WORKING_DAY), {
      from: "2026-08-08",
      to: "2026-08-08",
    });
  });

  test("the window over a span opens and closes on the boundary", () => {
    const week = periodRange(WEDNESDAY, "week", WORKING_DAY);
    const w = rangeBoundaryWindow(week, WORKING_DAY);
    assert.equal(w.start, "2026-08-10T05:00:00+05:30");
    assert.equal(w.end, "2026-08-13T05:00:00+05:30");

    // A range of one day and that day on its own are the same window — the
    // day figures and the span figures cannot disagree.
    const single = { from: WEDNESDAY, to: WEDNESDAY };
    assert.deepEqual(
      rangeBoundaryWindow(single, WORKING_DAY),
      dayBoundaryWindow(WEDNESDAY, WORKING_DAY),
    );
  });

  test("at midnight the boundary the window opens at moves with it", () => {
    const midnight = { ...WORKING_DAY, dayBoundaryHour: 0 };
    const w = rangeBoundaryWindow({ from: WEDNESDAY, to: WEDNESDAY }, midnight);
    assert.equal(w.start, "2026-08-12T00:00:00+05:30");
    assert.equal(w.end, "2026-08-13T00:00:00+05:30");

    // 1am IST on the 12th: the previous day at a 5am boundary, the 12th at
    // midnight. This is the whole of the change the setting makes.
    const oneAm = new Date("2026-08-11T19:30:00Z");
    assert.equal(businessDate(oneAm, WORKING_DAY), "2026-08-11");
    assert.equal(businessDate(oneAm, midnight), "2026-08-12");
  });

  test("only the four known spans are accepted from a URL", () => {
    assert.equal(isDashboardPeriod("month"), true);
    assert.equal(isDashboardPeriod("fortnight"), false);
    assert.equal(isDashboardPeriod(undefined), false);
  });
});
