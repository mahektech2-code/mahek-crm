import type { SheetRowIssue } from "@/db/schema";
import { parseWholeNumber } from "@/lib/sheet-parse";

/* ---------------------------------------------------------------------------
 * Reading the Activity tab of a defunct prior system ("Mahek EMP 2.0") — a
 * field salesman's visit/call log from before MBOS existed. PURE — no I/O,
 * no clock, no database. Same contract as every other sheet parser here:
 * this never fails and never guesses. A cell it cannot read becomes null
 * plus an issue naming the column and quoting what was there, and the row
 * still imports.
 *
 * Its own date parser, not `sheet-parse.ts`'s. The CSV export the backfill
 * started from was uniformly month/day/year; the live sheet is read in the
 * workbook's own locale, which need not agree. So the order is DETECTED per
 * read (`detectDateOrder`) rather than assumed — see that function.
 * ------------------------------------------------------------------------- */

/** The sheet's own human header row, verbatim. */
export const FIELD_ACTIVITY_COL = {
  activityId: "Activity ID",
  employeeName: "Employee Name.",
  customerName: "Customer Name",
  date: "Date",
  /** Minutes spent at the shop — not a clock time, despite the column name. */
  timeGiven: "Time Given",
  meetingNote: "Meeting Note",
  issue: "Issue",
  reminderDate: "Remainder Date",
  mood: "Mood",
  meetingType: "Meeting Type",
  meetingPurpose: "Meeting Purpose",
  location: "Location",
} as const;

const REAL_MOODS = new Set(["normal", "happy", "angry"]);

/**
 * Which way round this tab writes a date. Two answers and no third: an
 * ambiguous cell is read the way the rest of its column is written.
 */
export type DateOrder = "mdy" | "dmy";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function isoOf(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1900 || year > 2100) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The two numbers in front of the year, or null where the cell is not N/N/YYYY. */
function numericParts(raw: string): { first: number; second: number; year: number } | null {
  // A trailing clock time ("10/7/2026 14:22:05", "10/7/2026, 2:22 PM") is the
  // same date — the time is dropped, not used to refuse the cell.
  const m = raw.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ ,T]+\d{1,2}:\d{2}.*)?$/);
  if (!m) return null;
  return { first: Number(m[1]), second: Number(m[2]), year: Number(m[3]) };
}

/**
 * WHICH WAY ROUND A COLUMN IS WRITTEN, decided from the column and never from
 * one cell.
 *
 * The rule this replaced — "this tab is month/day/year" — was measured on a
 * CSV export, and an export is a file somebody saved on a machine with its own
 * locale. The live read is Google's FORMATTED_VALUE, which follows the
 * WORKBOOK's locale, and an Indian workbook writes day first. Read month-first,
 * every day-first date with a day of 12 or less came out as a different,
 * perfectly valid date — 10 June stored as 6 October — and every one with a
 * day over 12 came out as nothing at all. Both are silent: the first puts a
 * visit on a day nobody made it, the second drops it out of every date range.
 *
 * A first number over 12 can only be a day and a second over 12 can only be a
 * day, so any column of real dates settles itself within a fortnight of rows.
 * Null is "this column says nothing either way" — every value 12 or under —
 * and the caller falls back on what it knows about the sheet already.
 */
export function detectDateOrder(values: Iterable<string | null | undefined>): DateOrder | null {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const v of values) {
    if (!v) continue;
    const p = numericParts(v);
    if (!p) continue;
    if (p.first > 12 && p.second <= 12) dayFirst++;
    else if (p.second > 12 && p.first <= 12) monthFirst++;
  }
  if (dayFirst === 0 && monthFirst === 0) return null;
  return dayFirst > monthFirst ? "dmy" : "mdy";
}

/**
 * This tab's date. Numeric dates are read in the column's own `order` — the
 * caller decides it with `detectDateOrder` — and a cell that contradicts that
 * order is unreadable rather than quietly flipped. ISO (`2026-10-07`) and
 * named-month (`7-Oct-2026`) cells say which number is which and are read
 * whatever the order.
 */
export function parseFieldActivityDate(raw: string, order: DateOrder = "mdy"): string | null {
  const value = raw.trim();
  if (!value) return null;

  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (iso) return isoOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const named = value.match(/^(\d{1,2})[ -]([A-Za-z]{3,9})[\s,-]*(\d{4})(?:[ ,T]+\d{1,2}:\d{2}.*)?$/);
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()];
    return month ? isoOf(Number(named[3]), month, Number(named[1])) : null;
  }

  const p = numericParts(value);
  if (!p) return null;
  return order === "dmy" ? isoOf(p.year, p.second, p.first) : isoOf(p.year, p.first, p.second);
}

/**
 * The "Mood" cell conflates two things: a real mood, and a "Stage 0..7"
 * label from the old app's own customer pipeline (unrelated to this app's
 * customer model). Both are derived from the same raw cell, never guessed —
 * a value that is neither is simply neither, and stays out of both.
 */
export function splitMood(raw: string): { mood: string | null; stageLabel: string | null } {
  const value = raw.trim();
  if (!value) return { mood: null, stageLabel: null };
  if (REAL_MOODS.has(value.toLowerCase())) {
    return { mood: value, stageLabel: null };
  }
  if (/^stage\s*\d/i.test(value)) {
    return { mood: null, stageLabel: value };
  }
  return { mood: null, stageLabel: null };
}

/* ------------------------------------------------------------------ a row */

export type ParsedFieldActivityRow = {
  activityId: string;
  employeeName: string | null;
  customerName: string | null;

  visitDate: string | null;
  durationMinutes: number | null;
  meetingNote: string | null;
  issueNote: string | null;
  reminderDate: string | null;

  moodRaw: string | null;
  mood: string | null;
  stageLabel: string | null;

  meetingType: string | null;
  meetingPurpose: string | null;
  location: string | null;

  issues: SheetRowIssue[];
};

const text = (cells: Record<string, string>, column: string): string | null => {
  const v = (cells[column] ?? "").trim();
  return v === "" ? null : v;
};

export function parseFieldActivityRow(
  cells: Record<string, string>,
  order: DateOrder = "mdy",
): ParsedFieldActivityRow {
  const issues: SheetRowIssue[] = [];
  const COL = FIELD_ACTIVITY_COL;

  const date = (column: string, label: string): string | null => {
    const raw = (cells[column] ?? "").trim();
    if (!raw) return null;
    const iso = parseFieldActivityDate(raw, order);
    if (iso === null) {
      issues.push({
        column,
        value: raw,
        kind: "unreadable",
        problem: `${label} could not be read as a date`,
      });
    }
    return iso;
  };

  const duration = (): number | null => {
    const raw = (cells[COL.timeGiven] ?? "").trim();
    if (!raw) return null;
    const n = parseWholeNumber(raw);
    if (n === null) {
      issues.push({
        column: COL.timeGiven,
        value: raw,
        kind: "unreadable",
        problem: "Time Given could not be read as a number of minutes",
      });
    }
    return n;
  };

  const moodRaw = text(cells, COL.mood);
  const { mood, stageLabel } = splitMood(moodRaw ?? "");

  const row: ParsedFieldActivityRow = {
    activityId: (cells[COL.activityId] ?? "").trim(),
    employeeName: text(cells, COL.employeeName),
    customerName: text(cells, COL.customerName),

    visitDate: date(COL.date, "Date"),
    durationMinutes: duration(),
    meetingNote: text(cells, COL.meetingNote),
    issueNote: text(cells, COL.issue),
    reminderDate: date(COL.reminderDate, "Remainder Date"),

    moodRaw,
    mood,
    stageLabel,

    meetingType: text(cells, COL.meetingType),
    meetingPurpose: text(cells, COL.meetingPurpose),
    location: text(cells, COL.location),

    issues: [],
  };

  if (!row.activityId) {
    issues.push({
      column: COL.activityId,
      value: "",
      kind: "contradiction",
      problem: "no Activity ID — the row cannot be matched on a re-import",
    });
  }
  if (!row.customerName) {
    issues.push({ column: COL.customerName, value: "", kind: "contradiction", problem: "no customer name" });
  }

  row.issues = issues;
  return row;
}

/**
 * True for a row the sheet left entirely empty — no Activity ID, no
 * employee, no date. These are trailing spacer rows, not activity, and are
 * dropped before they ever reach the parser above rather than imported as
 * an empty record with nothing to key it on.
 */
export function isBlankFieldActivityRow(cells: Record<string, string>): boolean {
  return Object.values(cells).every((v) => !v || !v.trim());
}
