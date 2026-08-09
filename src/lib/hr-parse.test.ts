import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  HR_COL,
  REDACTED,
  isLabelRow,
  last4,
  parseEmployeeRow,
  parseEmploymentStatus,
  parseHrDate,
  parseYesNo,
  redactRaw,
} from "./hr-parse";

/* ---------------------------------------------------------------------------
 * The employee sheet's reading rules, tested without a database.
 *
 * The dates carry most of the weight here. The tab mixes four shapes and two
 * conventions, and a birthday read eight months out is the kind of wrong that
 * nobody catches by looking at it.
 * ------------------------------------------------------------------------- */

describe("dates", () => {
  test("a three-letter month is day-first and settles it", () => {
    assert.deepEqual(parseHrDate("1-Nov-2024"), { iso: "2024-11-01", ambiguous: false });
    assert.deepEqual(parseHrDate("31-Jan-2024"), { iso: "2024-01-31", ambiguous: false });
    assert.deepEqual(parseHrDate("9-Dec-2025"), { iso: "2025-12-09", ambiguous: false });
  });

  test("a component over 12 can only be the day, whichever side it is on", () => {
    // Google renders this sheet's real date values month-first…
    assert.deepEqual(parseHrDate("10/15/2006"), { iso: "2006-10-15", ambiguous: false });
    // …and text somebody typed is day-first.
    assert.deepEqual(parseHrDate("22/04/2013"), { iso: "2013-04-22", ambiguous: false });
  });

  test("a zero-padded component means somebody typed it, so day-first", () => {
    assert.deepEqual(parseHrDate("08/05/2009"), { iso: "2009-05-08", ambiguous: true });
    assert.deepEqual(parseHrDate("01/10/2014"), { iso: "2014-10-01", ambiguous: true });
  });

  test("an unpadded ambiguous date is a rendered value, so month-first", () => {
    assert.deepEqual(parseHrDate("12/8/2021"), { iso: "2021-12-08", ambiguous: true });
    assert.deepEqual(parseHrDate("5/1/2021"), { iso: "2021-05-01", ambiguous: true });
  });

  test("ambiguity is reported, never silently resolved", () => {
    // Both readings are valid dates. The caller has to be able to say so.
    assert.equal(parseHrDate("4/2/2015").ambiguous, true);
    assert.equal(parseHrDate("19/2/2015").ambiguous, false);
  });

  test("an impossible date is refused rather than rolled forward", () => {
    // 31/02 is not the 3rd of March, and a Date constructor would say it was.
    assert.equal(parseHrDate("31/02/2020").iso, null);
    assert.equal(parseHrDate("30-Feb-2020").iso, null);
    assert.equal(parseHrDate("13/13/2020").iso, null);
    assert.equal(parseHrDate("not a date").iso, null);
  });

  test("a leap day is a date", () => {
    assert.equal(parseHrDate("29/02/2020").iso, "2020-02-29");
    assert.equal(parseHrDate("29/02/2021").iso, null);
  });

  test("blank is not an error — most of these columns are optional", () => {
    assert.deepEqual(parseHrDate("   "), { iso: null, ambiguous: false });
  });
});

describe("small readings", () => {
  test("status is two states and three spellings", () => {
    assert.equal(parseEmploymentStatus("Active"), "active");
    assert.equal(parseEmploymentStatus("ACTIVE"), "active");
    assert.equal(parseEmploymentStatus(" Inactive "), "inactive");
    // Never guessed into one or the other.
    assert.equal(parseEmploymentStatus("On leave"), "unknown");
  });

  test("anything that is not yes or no is unknown, not no", () => {
    assert.equal(parseYesNo("Yes"), true);
    assert.equal(parseYesNo("no"), false);
    assert.equal(parseYesNo(""), null);
    assert.equal(parseYesNo("applied"), null);
  });

  test("last four digits ignore however the number is spaced", () => {
    assert.equal(last4("922010027950175"), "0175");
    assert.equal(last4("6187 5044 4859"), "4859");
    assert.equal(last4("12"), null);
  });
});

describe("the password column", () => {
  const cells = { [HR_COL.employeeCode]: "EMP-1", [HR_COL.password]: "Ankit9156" };

  test("never survives the import", () => {
    assert.equal(redactRaw(cells)[HR_COL.password], REDACTED);
    // …and the original object is not mutated, because the hash is taken over it.
    assert.equal(cells[HR_COL.password], "Ankit9156");
  });

  test("is not on the parsed record at all", () => {
    const parsed = parseEmployeeRow(cells) as unknown as Record<string, unknown>;
    assert.equal(
      Object.values(parsed).some((v) => v === "Ankit9156"),
      false,
    );
  });

  test("an empty one stays empty rather than becoming a redaction", () => {
    assert.equal(redactRaw({ [HR_COL.password]: "" })[HR_COL.password], "");
  });
});

describe("a row", () => {
  const row = {
    [HR_COL.employeeCode]: "EMP-1692",
    [HR_COL.name]: "ANKIT SRIVASTAV",
    [HR_COL.status]: "Active",
    [HR_COL.dateOfJoining]: "5/1/2021",
    [HR_COL.dateOfBirth]: "7/19/1989",
    [HR_COL.netSalary]: "26,000",
    [HR_COL.conveyance]: "0",
    [HR_COL.accountNumber]: "7010077181253",
    [HR_COL.aadhaar]: "618750444859",
    [HR_COL.pfEsic]: "Yes",
    [HR_COL.monthlyPaidLeave]: "2",
  };

  test("money arrives as paise, like every other amount in MahekOne", () => {
    assert.equal(parseEmployeeRow(row).netSalaryPaise, 2_600_000);
    // Zero is a figure somebody entered, not a missing value.
    assert.equal(parseEmployeeRow(row).conveyancePaise, 0);
  });

  test("the bank and Aadhaar numbers reduce to four digits", () => {
    const parsed = parseEmployeeRow(row);
    assert.equal(parsed.accountNumberLast4, "1253");
    assert.equal(parsed.aadhaarLast4, "4859");
    assert.equal(
      JSON.stringify(parsed).includes("7010077181253"),
      false,
      "the full account number must not reach the parsed record",
    );
  });

  test("a bad cell costs that cell and not the row", () => {
    const parsed = parseEmployeeRow({ ...row, [HR_COL.netSalary]: "twenty six thousand" });
    assert.equal(parsed.netSalaryPaise, null);
    assert.equal(parsed.name, "ANKIT SRIVASTAV");
    const issue = parsed.issues.find((i) => i.column === HR_COL.netSalary);
    assert.equal(issue?.value, "twenty six thousand");
  });

  test("a leaving date on an Active record is the sheet contradicting itself", () => {
    const parsed = parseEmployeeRow({ ...row, [HR_COL.dateOfLeaving]: "1-Nov-2024" });
    assert.equal(parsed.dateOfLeaving, "2024-11-01");
    assert.ok(parsed.issues.some((i) => i.problem.includes("leaving date")));
  });

  test("an Inactive record with no leaving date says so", () => {
    const parsed = parseEmployeeRow({ ...row, [HR_COL.status]: "Inactive" });
    assert.ok(parsed.issues.some((i) => i.column === HR_COL.dateOfLeaving));
  });

  test("leaving before joining is caught", () => {
    const parsed = parseEmployeeRow({
      ...row,
      [HR_COL.status]: "Inactive",
      [HR_COL.dateOfLeaving]: "1-Nov-2019",
    });
    assert.ok(parsed.issues.some((i) => i.problem.includes("before the joining date")));
  });

  test("a row with no employee id is held, not dropped", () => {
    const parsed = parseEmployeeRow({ ...row, [HR_COL.employeeCode]: "" });
    assert.equal(parsed.name, "ANKIT SRIVASTAV");
    assert.ok(parsed.issues.some((i) => i.column === HR_COL.employeeCode));
  });

  test("the second header row is recognised by what it says", () => {
    // It arrives looking like a complete record — every cell filled.
    assert.equal(isLabelRow({ [HR_COL.employeeCode]: "Employee Id" }), true);
    assert.equal(isLabelRow(row), false);
  });
});
