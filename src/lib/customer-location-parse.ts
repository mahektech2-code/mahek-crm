import type { SheetRowIssue } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * Reading a third-party field-tracking app's customer/shop export — a
 * one-time CSV, not a live sheet. PURE — no I/O, no clock, no database. Same
 * contract as every other importer here: this never fails and never guesses.
 * A cell it cannot read becomes null plus an issue naming the column and
 * quoting what was there, and the row still imports.
 * ------------------------------------------------------------------------- */

/** The export's own header row, verbatim. */
export const CUSTOMER_LOCATION_COL = {
  name: "Customer Name",
  printAs: "Customer PrintAs",
  location: "Customer Location",
  territory: "Territory",
  industry: "Industry",
  address: "CustomerAddress",
  addedOn: "Customer AddedOn",
  addedBy: "Customer AddedBy",
  updatedOn: "Customer UpdatedOn",
  updatedBy: "Customer UpdatedBy",
  latitude: "Latitude",
  longitude: "Longitude",
} as const;

/**
 * India's bounding box, generously — the mainland plus the island
 * territories. A coordinate outside it is not dropped, only flagged: this is
 * defence against a bad export, not a rule the real data has ever broken.
 */
const INDIA_LAT_RANGE: [number, number] = [6, 38];
const INDIA_LNG_RANGE: [number, number] = [68, 98];

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * This export's own timestamp, and only this export's: `"26 Dec 2025 12:20
 * PM"`. Assumed local to `APP_TIMEZONE` (Asia/Kolkata) — the same assumption
 * every naive wall-clock cell in this codebase makes, made explicit with a
 * literal `+05:30` offset rather than left to whichever zone happens to read
 * it back. Anything that does not match is unreadable rather than guessed at.
 */
export function parseCustomerLocationTimestamp(raw: string): Date | null {
  const value = raw.trim();
  if (!value) return null;

  const m = value.match(
    /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i,
  );
  if (!m) return null;

  const day = Number(m[1]);
  const month = MONTHS[m[2].toLowerCase()];
  const year = Number(m[3]);
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  const meridiem = m[6].toUpperCase();

  if (!month || day < 1 || day > 31 || hour < 1 || hour > 12 || minute > 59) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;

  if (meridiem === "AM") hour = hour === 12 ? 0 : hour;
  else hour = hour === 12 ? 12 : hour + 12;

  const iso =
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` +
    `T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A coordinate cell, read as a finite number — never rounded, never clamped. */
function parseCoordinate(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ a row */

export type ParsedCustomerLocationRow = {
  name: string;
  printAs: string | null;
  locationText: string | null;
  territory: string | null;
  industryLabel: string | null;
  address: string | null;

  lat: number | null;
  lng: number | null;

  sourceAddedByName: string | null;
  sourceAddedAt: Date | null;
  sourceUpdatedByName: string | null;
  sourceUpdatedAt: Date | null;

  issues: SheetRowIssue[];
};

const text = (cells: Record<string, string>, column: string): string | null => {
  const v = (cells[column] ?? "").trim();
  return v === "" ? null : v;
};

export function parseCustomerLocationRow(
  cells: Record<string, string>,
): ParsedCustomerLocationRow {
  const issues: SheetRowIssue[] = [];
  const COL = CUSTOMER_LOCATION_COL;

  const timestamp = (column: string, label: string): Date | null => {
    const raw = (cells[column] ?? "").trim();
    if (!raw) return null;
    const parsed = parseCustomerLocationTimestamp(raw);
    if (parsed === null) {
      issues.push({
        column,
        value: raw,
        kind: "unreadable",
        problem: `${label} could not be read as a date`,
      });
    }
    return parsed;
  };

  const coordinate = (column: string, label: string): number | null => {
    const raw = (cells[column] ?? "").trim();
    if (!raw) {
      issues.push({ column, value: "", kind: "contradiction", problem: `no ${label}` });
      return null;
    }
    const n = parseCoordinate(raw);
    if (n === null) {
      issues.push({
        column,
        value: raw,
        kind: "unreadable",
        problem: `${label} could not be read as a number`,
      });
    }
    return n;
  };

  const name = text(cells, COL.name);
  const lat = coordinate(COL.latitude, "latitude");
  const lng = coordinate(COL.longitude, "longitude");

  if (
    lat !== null &&
    lng !== null &&
    (lat < INDIA_LAT_RANGE[0] || lat > INDIA_LAT_RANGE[1] ||
      lng < INDIA_LNG_RANGE[0] || lng > INDIA_LNG_RANGE[1])
  ) {
    issues.push({
      column: `${COL.latitude}/${COL.longitude}`,
      value: `${lat}, ${lng}`,
      kind: "contradiction",
      problem: "coordinate falls outside India — kept, not dropped",
    });
  }

  if (!name) {
    issues.push({ column: COL.name, value: "", kind: "contradiction", problem: "no customer name" });
  }

  const row: ParsedCustomerLocationRow = {
    name: name ?? "",
    printAs: text(cells, COL.printAs),
    locationText: text(cells, COL.location),
    territory: text(cells, COL.territory),
    industryLabel: text(cells, COL.industry),
    address: text(cells, COL.address),

    lat,
    lng,

    sourceAddedByName: text(cells, COL.addedBy),
    sourceAddedAt: timestamp(COL.addedOn, "Customer AddedOn"),
    sourceUpdatedByName: text(cells, COL.updatedBy),
    sourceUpdatedAt: timestamp(COL.updatedOn, "Customer UpdatedOn"),

    issues: [],
  };

  row.issues = issues;
  return row;
}

/**
 * True for a row the export left entirely empty. These are trailing spacer
 * rows, not a shop, and are dropped before they ever reach the parser above.
 */
export function isBlankCustomerLocationRow(cells: Record<string, string>): boolean {
  return Object.values(cells).every((v) => !v || !v.trim());
}
