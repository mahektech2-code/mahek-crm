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
 * Its own date parser, not `sheet-parse.ts`'s. That one is hard-coded to the
 * order sheet's day-first convention; this tab is the opposite. Checked
 * across every non-blank date in the export: 20,099 rows have a SECOND
 * numeric component over 12 (only possible if it is the day) and ZERO have a
 * FIRST component over 12 (impossible if the first were ever the day) — so
 * this column is uniformly month/day/year, a machine export in one locale
 * rather than the mixed hand-typed dates the HR sheet has to guess between.
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
 * This tab's date, and only this tab's: strict `M/D/Y`, no named-month
 * variant, no ambiguous fallback. Anything that does not match is
 * unreadable rather than guessed at.
 */
export function parseFieldActivityDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;

  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1900 || year > 2100) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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

export function parseFieldActivityRow(cells: Record<string, string>): ParsedFieldActivityRow {
  const issues: SheetRowIssue[] = [];
  const COL = FIELD_ACTIVITY_COL;

  const date = (column: string, label: string): string | null => {
    const raw = (cells[column] ?? "").trim();
    if (!raw) return null;
    const iso = parseFieldActivityDate(raw);
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
