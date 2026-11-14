import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CUSTOMER_LOCATION_COL,
  isBlankCustomerLocationRow,
  parseCustomerLocationRow,
  parseCustomerLocationTimestamp,
} from "./customer-location-parse";

/* ---------------------------------------------------------------------------
 * The field-tracking export's reading rules, tested without a database. The
 * timestamp format ("26 Dec 2025 12:20 PM") is this export's own — verified
 * against the real file, every row parses cleanly — so these tests exercise
 * the edges the real data never hits rather than re-proving the happy path.
 * ------------------------------------------------------------------------- */

describe("timestamp — day Mon year H:MM AM/PM, assumed Asia/Kolkata", () => {
  test("a clean timestamp reads as an instant with the +05:30 offset", () => {
    const at = parseCustomerLocationTimestamp("26 Dec 2025 12:20 PM");
    assert.ok(at);
    assert.equal(at.toISOString(), "2025-12-26T06:50:00.000Z");
  });

  test("midnight and noon both resolve correctly", () => {
    assert.equal(parseCustomerLocationTimestamp("1 Jan 2024 12:00 AM")?.toISOString(), "2023-12-31T18:30:00.000Z");
    assert.equal(parseCustomerLocationTimestamp("1 Jan 2024 12:00 PM")?.toISOString(), "2024-01-01T06:30:00.000Z");
  });

  test("a single-digit day and hour still read", () => {
    assert.equal(parseCustomerLocationTimestamp("3 Oct 2025 6:07 PM")?.toISOString(), "2025-10-03T12:37:00.000Z");
  });

  test("an impossible date is refused rather than rolled forward", () => {
    assert.equal(parseCustomerLocationTimestamp("31 Feb 2024 1:00 PM"), null);
    assert.equal(parseCustomerLocationTimestamp("not a date"), null);
  });

  test("blank is not an error", () => {
    assert.equal(parseCustomerLocationTimestamp("   "), null);
  });
});

describe("parseCustomerLocationRow", () => {
  const base: Record<string, string> = {
    [CUSTOMER_LOCATION_COL.name]: "3D Traders",
    [CUSTOMER_LOCATION_COL.printAs]: "3D Traders",
    [CUSTOMER_LOCATION_COL.location]: "Dhenkanal",
    [CUSTOMER_LOCATION_COL.territory]: "odisha",
    [CUSTOMER_LOCATION_COL.industry]: "Auto Car Colour",
    [CUSTOMER_LOCATION_COL.address]: "Gudianali, Dhenkanal, Odisha 759001, India",
    [CUSTOMER_LOCATION_COL.addedOn]: "26 Dec 2025 12:20 PM",
    [CUSTOMER_LOCATION_COL.addedBy]: "Sanjay Samantaray",
    [CUSTOMER_LOCATION_COL.updatedOn]: "",
    [CUSTOMER_LOCATION_COL.updatedBy]: "",
    [CUSTOMER_LOCATION_COL.latitude]: "20.651580810546875",
    [CUSTOMER_LOCATION_COL.longitude]: "85.6053491407449",
  };

  test("a clean row reads every column, with no issues", () => {
    const row = parseCustomerLocationRow(base);
    assert.equal(row.name, "3D Traders");
    assert.equal(row.territory, "odisha");
    assert.equal(row.industryLabel, "Auto Car Colour");
    assert.equal(row.lat, 20.651580810546875);
    assert.equal(row.lng, 85.6053491407449);
    assert.equal(row.sourceAddedByName, "Sanjay Samantaray");
    assert.ok(row.sourceAddedAt);
    assert.equal(row.sourceUpdatedAt, null);
    assert.deepEqual(row.issues, []);
  });

  test("a row with no name is flagged rather than silently dropped by the parser itself", () => {
    const row = parseCustomerLocationRow({ ...base, [CUSTOMER_LOCATION_COL.name]: "" });
    assert.equal(row.name, "");
    assert.ok(
      row.issues.some((i) => i.kind === "contradiction" && i.column === CUSTOMER_LOCATION_COL.name),
    );
  });

  test("a missing coordinate is flagged and the row still imports", () => {
    const row = parseCustomerLocationRow({ ...base, [CUSTOMER_LOCATION_COL.latitude]: "" });
    assert.equal(row.lat, null);
    assert.equal(row.name, "3D Traders");
    assert.ok(
      row.issues.some((i) => i.kind === "contradiction" && i.column === CUSTOMER_LOCATION_COL.latitude),
    );
  });

  test("an unreadable coordinate is flagged, not silently zeroed", () => {
    const row = parseCustomerLocationRow({ ...base, [CUSTOMER_LOCATION_COL.longitude]: "not a number" });
    assert.equal(row.lng, null);
    assert.ok(
      row.issues.some((i) => i.kind === "unreadable" && i.column === CUSTOMER_LOCATION_COL.longitude),
    );
  });

  test("a coordinate outside India is kept, and flagged rather than dropped", () => {
    const row = parseCustomerLocationRow({
      ...base,
      [CUSTOMER_LOCATION_COL.latitude]: "51.5074",
      [CUSTOMER_LOCATION_COL.longitude]: "-0.1278",
    });
    assert.equal(row.lat, 51.5074);
    assert.equal(row.lng, -0.1278);
    assert.ok(row.issues.some((i) => i.kind === "contradiction" && i.problem.includes("outside India")));
  });

  test("an unreadable AddedOn still imports the rest of the row, with an issue", () => {
    const row = parseCustomerLocationRow({ ...base, [CUSTOMER_LOCATION_COL.addedOn]: "whenever" });
    assert.equal(row.sourceAddedAt, null);
    assert.equal(row.name, "3D Traders");
    assert.ok(
      row.issues.some((i) => i.kind === "unreadable" && i.column === CUSTOMER_LOCATION_COL.addedOn),
    );
  });
});

describe("isBlankCustomerLocationRow", () => {
  test("a row with nothing in it is blank", () => {
    const empty = Object.fromEntries(Object.values(CUSTOMER_LOCATION_COL).map((c) => [c, ""]));
    assert.equal(isBlankCustomerLocationRow(empty), true);
  });

  test("a row with a single non-empty cell is not blank", () => {
    const empty = Object.fromEntries(Object.values(CUSTOMER_LOCATION_COL).map((c) => [c, ""]));
    assert.equal(
      isBlankCustomerLocationRow({ ...empty, [CUSTOMER_LOCATION_COL.name]: "X" }),
      false,
    );
  });
});
