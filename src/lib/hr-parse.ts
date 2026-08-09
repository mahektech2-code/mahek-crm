import type { SheetRowIssue } from "@/db/schema";
import { parseMoneyPaise, parseWholeNumber } from "@/lib/sheet-parse";

/* ---------------------------------------------------------------------------
 * Reading the Employee Details tab. PURE — no I/O, no clock, no database.
 *
 * Same contract as the order sheet's parser: this never fails and never
 * guesses. A cell it cannot read becomes a null plus an issue naming the
 * column and quoting what was there, and the row still imports. Losing the
 * other forty columns of a person's record because one date is mistyped is a
 * worse outcome than holding the record and saying which cell is wrong.
 *
 * Two things here are stricter than the order sheet, because the data is a
 * person rather than an invoice:
 *
 *   - The `passwoard` column is REDACTED on the way in, everywhere, including
 *     the raw snapshot. It holds plaintext credentials to a different system.
 *   - The bank account and Aadhaar numbers survive as their last four digits
 *     only in the typed columns; the full values stay in the raw snapshot,
 *     which no screen reads.
 * ------------------------------------------------------------------------- */

/**
 * The tab's machine header row, verbatim — misspellings and all.
 *
 * Row 1 of the sheet holds these; row 2 holds the human labels ("Employee Id",
 * "Name Of Employee") that people actually see. This is a foreign key into
 * somebody else's document, so `passwoard` and `date_of_joinning` are spelled
 * the way the sheet spells them and are not tidied up.
 */
export const HR_COL = {
  employeeCode: "employee_id",
  name: "employee_name",
  gender: "gender",
  /** Read only to be thrown away. Never stored. */
  password: "passwoard",
  officeName: "office_name",
  reportsTo: "report_to",
  address: "address",
  personalMobile: "personal_mobile_no.",
  emergencyContact: "emergency_contact_number",
  permanentAddress: "permanent_address",
  bankName: "Bank_name",
  accountNumber: "account_number",
  ifscCode: "ifsc_code",
  alternateMobile: "alternate_number",
  /** Labelled "Position Type" on the sheet: Sales, Office Staff, Other, Owner. */
  department: "department",
  position: "position",
  dateOfJoining: "date_of_joinning",
  dateOfBirth: "date_of_birth",
  status: "status",
  marriageAnniversary: "Marrage_anniversary",
  email: "email_id",
  child1Birthday: "birthday_of_child1",
  child2Birthday: "birthday_of_child2",
  netSalary: "net_salary",
  conveyance: "conveyance",
  otherSalary: "other_salary",
  companyMobile: "company_mobile_number",
  aadhaar: "adhar_number",
  photo: "photo",
  areaAllocated: "area_allocated",
  dateOfLeaving: "date_of_leaving",
  monthlyPaidLeave: "monthly_paid_leave",
  yearlyMaximumLeave: "yearly_maximum_leave",
  pfEsic: "pf/esic_application",
  uanNo: "uan_no",
  esicNo: "esic_no",
  panNumber: "pan_number",
} as const;

/**
 * What the label row says in the `employee_id` column.
 *
 * The tab carries two header rows, so row 2 arrives looking exactly like data:
 * a full set of cells, none of them blank. Skipping "row 2" by number alone
 * would import a person as "Name Of Employee" the day somebody inserts a row
 * at the top, so the sync checks this as well.
 */
export const HR_LABEL_ROW_MARKER = "Employee Id";

/** Rows 1 and 2 are the machine header and the human label. Data starts at 3. */
export const HR_FIRST_DATA_ROW = 3;

/** Never stored, never displayed, and this is what stands in for it. */
export const REDACTED = "[redacted on import]";

/* ------------------------------------------------------------- primitives */

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

export type ParsedDate = {
  /** ISO, or null when the cell could not be read at all. */
  iso: string | null;
  /**
   * True when the cell was numeric, both components were 12 or under, and the
   * reading below had to fall back on a convention. 4/2/2015 is either the 4th
   * of February or the 2nd of April and nothing in the cell says which.
   */
  ambiguous: boolean;
};

/**
 * Read one of this tab's dates. Four shapes appear in it, and they do not
 * agree with each other:
 *
 *   1-Nov-2024    a day-first text date, unambiguous
 *   10/15/2006    a real date value, rendered by Google in the sheet's locale
 *                 (month-first) and never zero-padded
 *   22/04/2013    text somebody typed day-first, and zero-padded
 *   12/8/2021     a real date value that happens to be ambiguous
 *
 * So the reading goes, in order: a three-letter month is day-first and settles
 * it; a component over 12 can only be the day; a zero-padded component means
 * somebody typed the string, and people here type day-first; and what is left
 * is a value Google rendered, which is month-first.
 *
 * The last two rules are conventions rather than facts, which is why the
 * ambiguous case is REPORTED rather than silently resolved — a birthday off by
 * eight months is the kind of wrong that nobody catches by looking.
 */
export function parseHrDate(raw: string): ParsedDate {
  const value = raw.trim();
  if (!value) return { iso: null, ambiguous: false };

  const named = value.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{2,4})$/);
  if (named) {
    const month = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase());
    if (month < 0) return { iso: null, ambiguous: false };
    return {
      iso: build(Number(named[1]), month + 1, Number(named[3])),
      ambiguous: false,
    };
  }

  const numeric = value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (!numeric) return { iso: null, ambiguous: false };

  const a = Number(numeric[1]);
  const b = Number(numeric[2]);
  const year = Number(numeric[3]);
  const padded = numeric[1].length === 2 && numeric[1].startsWith("0")
    || numeric[2].length === 2 && numeric[2].startsWith("0");

  if (a > 12 && b > 12) return { iso: null, ambiguous: false };
  if (a > 12) return { iso: build(a, b, year), ambiguous: false };
  if (b > 12) return { iso: build(b, a, year), ambiguous: false };

  return padded
    ? { iso: build(a, b, year), ambiguous: true }
    : { iso: build(b, a, year), ambiguous: true };
}

/** Rejects the 31st of February rather than rolling it into March. */
function build(day: number, month: number, year: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1900 || year > 2100) return null;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > days) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "Active", "ACTIVE" and "Inactive" are two statuses and three spellings. */
export function parseEmploymentStatus(raw: string): "active" | "inactive" | "unknown" {
  const v = raw.trim().toLowerCase();
  if (v === "active") return "active";
  if (v === "inactive" || v === "in-active" || v === "in active") return "inactive";
  return "unknown";
}

/** "Yes"/"No". Anything else is not a no — it is an unknown, and stays null. */
export function parseYesNo(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === "yes" || v === "y" || v === "true") return true;
  if (v === "no" || v === "n" || v === "false") return false;
  return null;
}

/**
 * The last four digits of an account or Aadhaar number, and nothing else.
 *
 * Enough to check a payment against a passbook, useless to anyone who copies
 * the screen. Separators are stripped first so "1234 5678 9012" and
 * "123456789012" agree about what their last four are.
 */
export function last4(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

/* ------------------------------------------------------------------ a row */

export type ParsedEmployee = {
  employeeCode: string;
  name: string;
  gender: string | null;
  officeName: string | null;
  reportsTo: string | null;
  department: string | null;
  position: string | null;
  areaAllocated: string | null;

  status: "active" | "inactive" | "unknown";
  statusRaw: string | null;

  dateOfJoining: string | null;
  dateOfBirth: string | null;
  dateOfLeaving: string | null;
  marriageAnniversary: string | null;
  child1Birthday: string | null;
  child2Birthday: string | null;

  email: string | null;
  personalMobile: string | null;
  alternateMobile: string | null;
  companyMobile: string | null;
  emergencyContact: string | null;
  address: string | null;
  permanentAddress: string | null;

  netSalaryPaise: number | null;
  conveyancePaise: number | null;
  otherSalaryPaise: number | null;

  monthlyPaidLeave: number | null;
  yearlyMaximumLeave: number | null;

  pfEsicApplicable: boolean | null;
  uanNo: string | null;
  esicNo: string | null;

  bankName: string | null;
  ifscCode: string | null;
  accountNumberLast4: string | null;
  aadhaarLast4: string | null;
  panNumber: string | null;

  photoPath: string | null;

  issues: SheetRowIssue[];
};

const text = (cells: Record<string, string>, column: string): string | null => {
  const v = (cells[column] ?? "").trim();
  return v === "" ? null : v;
};

/**
 * The raw snapshot as it is stored: the sheet's own cells, with the password
 * column replaced.
 *
 * The hash is taken over the ORIGINAL cells, not over this — otherwise a
 * password changed in the sheet would look like no change at all, and the row
 * would keep whatever else changed alongside it out of the database.
 */
export function redactRaw(cells: Record<string, string>): Record<string, string> {
  if (!(HR_COL.password in cells)) return cells;
  const out = { ...cells };
  out[HR_COL.password] = cells[HR_COL.password].trim() ? REDACTED : "";
  return out;
}

/** True for the second header row, whichever row number it currently occupies. */
export function isLabelRow(cells: Record<string, string>): boolean {
  return (cells[HR_COL.employeeCode] ?? "").trim() === HR_LABEL_ROW_MARKER;
}

export function parseEmployeeRow(cells: Record<string, string>): ParsedEmployee {
  const issues: SheetRowIssue[] = [];

  /** A date cell: null plus an issue if unreadable, flagged if ambiguous. */
  const date = (column: string, label: string): string | null => {
    const raw = (cells[column] ?? "").trim();
    if (!raw) return null;
    const { iso, ambiguous } = parseHrDate(raw);
    if (iso === null) {
      issues.push({
        column,
        value: raw,
        kind: "unreadable",
        problem: `${label} could not be read as a date`,
      });
      return null;
    }
    if (ambiguous) {
      issues.push({
        column,
        value: raw,
        kind: "ambiguous",
        problem:
          `${label} could be read two ways — taken as ${iso}. ` +
          `Writing it as ${raw.replace(/[-/.]/g, "-")} in d-MMM-yyyy form would settle it`,
      });
    }
    return iso;
  };

  const money = (column: string, label: string): number | null => {
    const raw = (cells[column] ?? "").trim();
    if (!raw) return null;
    const paise = parseMoneyPaise(raw);
    if (paise === null) {
      issues.push({
        column,
        value: raw,
        kind: "unreadable",
        problem: `${label} could not be read as an amount`,
      });
    }
    return paise;
  };

  const count = (column: string, label: string): number | null => {
    const raw = (cells[column] ?? "").trim();
    if (!raw) return null;
    const n = parseWholeNumber(raw);
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

  const statusRaw = text(cells, HR_COL.status);
  const status = parseEmploymentStatus(statusRaw ?? "");
  if (statusRaw && status === "unknown") {
    issues.push({
      column: HR_COL.status,
      value: statusRaw,
      kind: "unreadable",
      problem: "is neither Active nor Inactive, so the record is shown as unknown",
    });
  }

  const row: ParsedEmployee = {
    employeeCode: (cells[HR_COL.employeeCode] ?? "").trim(),
    name: (cells[HR_COL.name] ?? "").trim(),
    gender: text(cells, HR_COL.gender),
    officeName: text(cells, HR_COL.officeName),
    reportsTo: text(cells, HR_COL.reportsTo),
    department: text(cells, HR_COL.department),
    position: text(cells, HR_COL.position),
    areaAllocated: text(cells, HR_COL.areaAllocated),

    status,
    statusRaw,

    dateOfJoining: date(HR_COL.dateOfJoining, "Date of joining"),
    dateOfBirth: date(HR_COL.dateOfBirth, "Date of birth"),
    dateOfLeaving: date(HR_COL.dateOfLeaving, "Date of leaving"),
    marriageAnniversary: date(HR_COL.marriageAnniversary, "Marriage anniversary"),
    child1Birthday: date(HR_COL.child1Birthday, "First child's birthday"),
    child2Birthday: date(HR_COL.child2Birthday, "Second child's birthday"),

    email: text(cells, HR_COL.email),
    personalMobile: text(cells, HR_COL.personalMobile),
    alternateMobile: text(cells, HR_COL.alternateMobile),
    companyMobile: text(cells, HR_COL.companyMobile),
    emergencyContact: text(cells, HR_COL.emergencyContact),
    address: text(cells, HR_COL.address),
    permanentAddress: text(cells, HR_COL.permanentAddress),

    netSalaryPaise: money(HR_COL.netSalary, "Salary"),
    conveyancePaise: money(HR_COL.conveyance, "Conveyance"),
    otherSalaryPaise: money(HR_COL.otherSalary, "Other salary"),

    monthlyPaidLeave: count(HR_COL.monthlyPaidLeave, "Monthly paid leave"),
    yearlyMaximumLeave: count(HR_COL.yearlyMaximumLeave, "Yearly maximum leave"),

    pfEsicApplicable: parseYesNo(cells[HR_COL.pfEsic] ?? ""),
    uanNo: text(cells, HR_COL.uanNo),
    esicNo: text(cells, HR_COL.esicNo),

    bankName: text(cells, HR_COL.bankName),
    ifscCode: text(cells, HR_COL.ifscCode),
    accountNumberLast4: last4(cells[HR_COL.accountNumber] ?? ""),
    aadhaarLast4: last4(cells[HR_COL.aadhaar] ?? ""),
    panNumber: text(cells, HR_COL.panNumber),

    photoPath: text(cells, HR_COL.photo),

    issues: [],
  };

  if (!row.employeeCode) {
    issues.push({
      column: HR_COL.employeeCode,
      value: "",
      kind: "contradiction",
      problem: "no employee id — the row cannot be matched on a re-import",
    });
  }
  if (!row.name) {
    issues.push({ column: HR_COL.name, value: "", kind: "contradiction", problem: "no name" });
  }

  // A leaving date on somebody still marked Active, or an Inactive record with
  // no leaving date, is the sheet contradicting itself. Both happen when a
  // resignation is recorded in one column and not the other, and both leave
  // the headcount wrong — which is the one number this app exists to answer.
  if (row.dateOfLeaving && row.status === "active") {
    issues.push({
      column: HR_COL.status,
      value: statusRaw ?? "",
      kind: "contradiction",
      problem: `reads Active, but a leaving date of ${row.dateOfLeaving} is recorded`,
    });
  }
  if (row.status === "inactive" && !row.dateOfLeaving) {
    issues.push({
      column: HR_COL.dateOfLeaving,
      value: (cells[HR_COL.dateOfLeaving] ?? "").trim(),
      kind: "contradiction",
      problem: "is empty on an Inactive record — nothing says when they left",
    });
  }
  if (row.dateOfLeaving && row.dateOfJoining && row.dateOfLeaving < row.dateOfJoining) {
    issues.push({
      column: HR_COL.dateOfLeaving,
      value: (cells[HR_COL.dateOfLeaving] ?? "").trim(),
      kind: "contradiction",
      problem: `is before the joining date of ${row.dateOfJoining}`,
    });
  }

  row.issues = issues;
  return row;
}
