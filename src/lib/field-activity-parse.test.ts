import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  FIELD_ACTIVITY_COL,
  isBlankFieldActivityRow,
  parseFieldActivityDate,
  parseFieldActivityRow,
  splitMood,
} from "./field-activity-parse";

/* ---------------------------------------------------------------------------
 * The field-activity sheet's reading rules, tested without a database.
 *
 * This tab's date convention is the OPPOSITE of the order sheet's — verified
 * empirically against the real export (zero rows with a first component over
 * 12, thousands with a second component over 12) — so the parser and its
 * tests deliberately do not reuse `sheet-parse.ts`'s day-first assumption.
 * ------------------------------------------------------------------------- */

describe("dates — strict month/day/year, no ambiguous fallback", () => {
  test("a plain M/D/Y date reads as month first", () => {
    assert.equal(parseFieldActivityDate("10/11/2022"), "2022-10-11");
    assert.equal(parseFieldActivityDate("1/5/2023"), "2023-01-05");
  });

  test("a day over 12 confirms month-first without needing to guess", () => {
    assert.equal(parseFieldActivityDate("4/25/2024"), "2024-04-25");
    assert.equal(parseFieldActivityDate("12/31/2025"), "2025-12-31");
  });

  test("an impossible date is refused rather than rolled forward", () => {
    assert.equal(parseFieldActivityDate("2/30/2020"), null);
    assert.equal(parseFieldActivityDate("13/1/2020"), null);
    assert.equal(parseFieldActivityDate("not a date"), null);
  });

  test("a leap day is a date", () => {
    assert.equal(parseFieldActivityDate("2/29/2020"), "2020-02-29");
    assert.equal(parseFieldActivityDate("2/29/2021"), null);
  });

  test("blank is not an error", () => {
    assert.equal(parseFieldActivityDate("   "), null);
  });

  test("a day-first date this tab never actually contains is refused, not reinterpreted", () => {
    // 25/12/2024 would be Christmas under the order sheet's convention. Here
    // it is simply not a valid month, and the parser must not fall back to
    // guessing day-first — it has to say the cell was unreadable instead.
    assert.equal(parseFieldActivityDate("25/12/2024"), null);
  });
});

describe("mood/stage split", () => {
  test("a real mood is a mood, not a stage", () => {
    assert.deepEqual(splitMood("Happy"), { mood: "Happy", stageLabel: null });
    assert.deepEqual(splitMood("normal"), { mood: "normal", stageLabel: null });
    assert.deepEqual(splitMood("ANGRY"), { mood: "ANGRY", stageLabel: null });
  });

  test("a stage label is a stage, not a mood", () => {
    assert.deepEqual(splitMood("Stage 5 - Repeat Customer"), {
      mood: null,
      stageLabel: "Stage 5 - Repeat Customer",
    });
    assert.deepEqual(splitMood("Stage 3 – Negotiation High Value"), {
      mood: null,
      stageLabel: "Stage 3 – Negotiation High Value",
    });
  });

  test("blank is neither", () => {
    assert.deepEqual(splitMood(""), { mood: null, stageLabel: null });
    assert.deepEqual(splitMood("   "), { mood: null, stageLabel: null });
  });

  test("something that is neither a known mood nor a stage label is neither, not guessed", () => {
    assert.deepEqual(splitMood("Somewhat interested"), { mood: null, stageLabel: null });
  });
});

describe("parseFieldActivityRow", () => {
  const base: Record<string, string> = {
    [FIELD_ACTIVITY_COL.activityId]: "85E8E144",
    [FIELD_ACTIVITY_COL.employeeName]: "SANDEEP NAMDEO",
    [FIELD_ACTIVITY_COL.customerName]: "jeet furniture",
    [FIELD_ACTIVITY_COL.date]: "10/12/2022",
    [FIELD_ACTIVITY_COL.timeGiven]: "10",
    [FIELD_ACTIVITY_COL.meetingNote]: "stock Available",
    [FIELD_ACTIVITY_COL.issue]: "rate high",
    [FIELD_ACTIVITY_COL.reminderDate]: "",
    [FIELD_ACTIVITY_COL.mood]: "Stage 0 - Inactive Customers",
    [FIELD_ACTIVITY_COL.meetingType]: "Visit",
    [FIELD_ACTIVITY_COL.meetingPurpose]: "Follow up",
    [FIELD_ACTIVITY_COL.location]: "Jabalpur",
  };

  test("a clean row reads every column, with no issues", () => {
    const row = parseFieldActivityRow(base);
    assert.equal(row.activityId, "85E8E144");
    assert.equal(row.employeeName, "SANDEEP NAMDEO");
    assert.equal(row.customerName, "jeet furniture");
    assert.equal(row.visitDate, "2022-10-12");
    assert.equal(row.durationMinutes, 10);
    assert.equal(row.meetingNote, "stock Available");
    assert.equal(row.issueNote, "rate high");
    assert.equal(row.reminderDate, null);
    assert.equal(row.moodRaw, "Stage 0 - Inactive Customers");
    assert.equal(row.mood, null);
    assert.equal(row.stageLabel, "Stage 0 - Inactive Customers");
    assert.equal(row.meetingType, "Visit");
    assert.equal(row.meetingPurpose, "Follow up");
    assert.equal(row.location, "Jabalpur");
    assert.deepEqual(row.issues, []);
  });

  test("a row with no Activity ID is flagged rather than silently dropped by the parser itself", () => {
    const row = parseFieldActivityRow({ ...base, [FIELD_ACTIVITY_COL.activityId]: "" });
    assert.equal(row.activityId, "");
    assert.ok(row.issues.some((i) => i.kind === "contradiction" && i.column === FIELD_ACTIVITY_COL.activityId));
  });

  test("an unreadable date still imports the rest of the row, with an issue", () => {
    const row = parseFieldActivityRow({ ...base, [FIELD_ACTIVITY_COL.date]: "not a date" });
    assert.equal(row.visitDate, null);
    assert.equal(row.customerName, "jeet furniture");
    assert.ok(row.issues.some((i) => i.kind === "unreadable" && i.column === FIELD_ACTIVITY_COL.date));
  });

  test("an unreadable duration still imports the rest of the row, with an issue", () => {
    const row = parseFieldActivityRow({ ...base, [FIELD_ACTIVITY_COL.timeGiven]: "ages" });
    assert.equal(row.durationMinutes, null);
    assert.ok(row.issues.some((i) => i.kind === "unreadable" && i.column === FIELD_ACTIVITY_COL.timeGiven));
  });

  test("blank Time Given is not an error", () => {
    const row = parseFieldActivityRow({ ...base, [FIELD_ACTIVITY_COL.timeGiven]: "" });
    assert.equal(row.durationMinutes, null);
    assert.deepEqual(row.issues, []);
  });
});

describe("isBlankFieldActivityRow", () => {
  test("a row with nothing in it is blank", () => {
    const empty = Object.fromEntries(Object.values(FIELD_ACTIVITY_COL).map((c) => [c, ""]));
    assert.equal(isBlankFieldActivityRow(empty), true);
  });

  test("a row with a single non-empty cell is not blank", () => {
    const empty = Object.fromEntries(Object.values(FIELD_ACTIVITY_COL).map((c) => [c, ""]));
    assert.equal(isBlankFieldActivityRow({ ...empty, [FIELD_ACTIVITY_COL.activityId]: "X" }), false);
  });
});
