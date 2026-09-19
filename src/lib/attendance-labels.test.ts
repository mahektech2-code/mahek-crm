/**
 * THE ONE ROW WHERE THE STORED VERDICT IS NOT A VERDICT.
 *
 *   npm run test
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readAttendanceVerdict } from "./attendance-labels";

describe("reading a day's verdict", () => {
  it("does not say absent about a day nobody measured", () => {
    /* `status` is NOT NULL defaulting to `absent`, and the job leaves a day
       with an open session alone. A red "absent" pill beside a check-in time
       and a selfie is the lie this whole change exists to end. */
    const r = readAttendanceVerdict({ status: "absent", hasCheckIn: true, workedSeconds: null });
    assert.equal(r.word, "not measured");
    assert.equal(r.tone, "warn");
    assert.ok(r.title);
  });

  it("does say absent about a day with no check-in at all", () => {
    const r = readAttendanceVerdict({ status: "absent", hasCheckIn: false, workedSeconds: null });
    assert.equal(r.word, "absent");
    assert.equal(r.tone, "danger");
  });

  it("says absent about a judged day somebody barely worked", () => {
    /* Judged: the hours are measured and fell under the half-day threshold. */
    const r = readAttendanceVerdict({ status: "absent", hasCheckIn: true, workedSeconds: 1800 });
    assert.equal(r.word, "absent");
  });

  it("draws the four judged verdicts with their own words", () => {
    const of = (status: string) =>
      readAttendanceVerdict({ status, hasCheckIn: true, workedSeconds: 8 * 3600 });
    assert.equal(of("present").word, "present");
    assert.equal(of("present").tone, "success");
    assert.equal(of("half_day").word, "half day");
    assert.equal(of("on_leave").word, "on leave");
    assert.equal(of("holiday").word, "holiday");
  });

  it("says a verdict it has not been taught rather than folding it into one it has", () => {
    const r = readAttendanceVerdict({ status: "week_off", hasCheckIn: false, workedSeconds: 0 });
    assert.equal(r.word, "week off");
  });
});
