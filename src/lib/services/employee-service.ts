import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { employees, sheetSyncRuns, type SheetRowIssue } from "@/db/schema";
import {
  EMPLOYEE_SOURCE,
  EMPLOYEE_TAB,
  employeeSheetId,
} from "./employee-sync-service";

/* ---------------------------------------------------------------------------
 * Reading the employee master.
 *
 * One query answers the whole screen, because the master is the size of a
 * company rather than the size of a database: seventy-odd people, and the
 * filtering and searching that a person does while looking at it happens in
 * the browser. Paginating this would add a page control to a list that fits.
 *
 * What it deliberately does NOT select is `raw`. That column holds the full
 * bank account and Aadhaar numbers, and the way those leak is not a breach —
 * it is an ordinary list query that selected everything and a screen that
 * quietly carried it in the page source.
 * ------------------------------------------------------------------------- */

export type EmployeeRecord = {
  id: string;
  employeeCode: string;
  rowNumber: number;
  name: string;
  gender: string | null;
  officeName: string | null;
  reportsTo: string | null;
  department: string | null;
  position: string | null;
  areaAllocated: string | null;
  status: "active" | "inactive" | "unknown";
  statusRaw: string | null;
  /** True when the person is no longer a row in the sheet. */
  withdrawn: boolean;

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
  /** Four digits, never the account. Enough to recognise, useless to copy. */
  accountNumberLast4: string | null;
  aadhaarLast4: string | null;
  panNumber: string | null;

  hasPhoto: boolean;
  /** Cells a person has to look at: unreadable, or contradicting each other. */
  issues: SheetRowIssue[];
  /** Dates the import had to resolve by convention. A note, not a fault. */
  dateNotes: SheetRowIssue[];
  updatedAt: string;
};

export type EmployeeMaster = {
  employees: EmployeeRecord[];
  summary: {
    total: number;
    active: number;
    inactive: number;
    unknown: number;
    withdrawn: number;
    withIssues: number;
    datesReadByConvention: number;
    /** Distinct offices and departments, for the filters and the summary. */
    offices: string[];
    departments: string[];
  };
  lastSync: {
    at: string;
    mode: string;
    status: string;
    rowsCreated: number;
    rowsUpdated: number;
    rowsUnchanged: number;
    rowsWithdrawn: number;
    error: string | null;
  } | null;
  source: { spreadsheetId: string; tabTitle: string; configured: boolean };
};

/** Every column the screens are allowed to see. `raw` is not among them. */
const SAFE_COLUMNS = {
  id: employees.id,
  employeeCode: employees.employeeCode,
  rowNumber: employees.rowNumber,
  name: employees.name,
  gender: employees.gender,
  officeName: employees.officeName,
  reportsTo: employees.reportsTo,
  department: employees.department,
  position: employees.position,
  areaAllocated: employees.areaAllocated,
  status: employees.status,
  statusRaw: employees.statusRaw,
  sheetStatus: employees.sheetStatus,
  dateOfJoining: employees.dateOfJoining,
  dateOfBirth: employees.dateOfBirth,
  dateOfLeaving: employees.dateOfLeaving,
  marriageAnniversary: employees.marriageAnniversary,
  child1Birthday: employees.child1Birthday,
  child2Birthday: employees.child2Birthday,
  email: employees.email,
  personalMobile: employees.personalMobile,
  alternateMobile: employees.alternateMobile,
  companyMobile: employees.companyMobile,
  emergencyContact: employees.emergencyContact,
  address: employees.address,
  permanentAddress: employees.permanentAddress,
  netSalaryPaise: employees.netSalaryPaise,
  conveyancePaise: employees.conveyancePaise,
  otherSalaryPaise: employees.otherSalaryPaise,
  monthlyPaidLeave: employees.monthlyPaidLeave,
  yearlyMaximumLeave: employees.yearlyMaximumLeave,
  pfEsicApplicable: employees.pfEsicApplicable,
  uanNo: employees.uanNo,
  esicNo: employees.esicNo,
  bankName: employees.bankName,
  ifscCode: employees.ifscCode,
  accountNumberLast4: employees.accountNumberLast4,
  aadhaarLast4: employees.aadhaarLast4,
  panNumber: employees.panNumber,
  photoPath: employees.photoPath,
  issues: employees.issues,
  updatedAt: employees.updatedAt,
} as const;

export async function employeeMaster(): Promise<EmployeeMaster> {
  const [rows, lastRun] = await Promise.all([
    db
      .select(SAFE_COLUMNS)
      .from(employees)
      // Present before withdrawn, then by name: a list somebody scans for a
      // person is alphabetical, and a leaver never sits above a colleague who
      // is still here.
      .orderBy(asc(employees.sheetStatus), asc(sql`lower(${employees.name})`)),
    db
      .select()
      .from(sheetSyncRuns)
      .where(eq(sheetSyncRuns.source, EMPLOYEE_SOURCE))
      .orderBy(desc(sheetSyncRuns.startedAt))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  const list: EmployeeRecord[] = rows.map((r) => ({
    id: r.id,
    employeeCode: r.employeeCode,
    rowNumber: r.rowNumber,
    name: r.name,
    gender: r.gender,
    officeName: r.officeName,
    reportsTo: r.reportsTo,
    department: r.department,
    position: r.position,
    areaAllocated: r.areaAllocated,
    status: r.status,
    statusRaw: r.statusRaw,
    withdrawn: r.sheetStatus === "withdrawn",
    dateOfJoining: r.dateOfJoining,
    dateOfBirth: r.dateOfBirth,
    dateOfLeaving: r.dateOfLeaving,
    marriageAnniversary: r.marriageAnniversary,
    child1Birthday: r.child1Birthday,
    child2Birthday: r.child2Birthday,
    email: r.email,
    personalMobile: r.personalMobile,
    alternateMobile: r.alternateMobile,
    companyMobile: r.companyMobile,
    emergencyContact: r.emergencyContact,
    address: r.address,
    permanentAddress: r.permanentAddress,
    netSalaryPaise: r.netSalaryPaise,
    conveyancePaise: r.conveyancePaise,
    otherSalaryPaise: r.otherSalaryPaise,
    monthlyPaidLeave: r.monthlyPaidLeave,
    yearlyMaximumLeave: r.yearlyMaximumLeave,
    pfEsicApplicable: r.pfEsicApplicable,
    uanNo: r.uanNo,
    esicNo: r.esicNo,
    bankName: r.bankName,
    ifscCode: r.ifscCode,
    accountNumberLast4: r.accountNumberLast4,
    aadhaarLast4: r.aadhaarLast4,
    panNumber: r.panNumber,
    // The path into the sheet's own images folder is not something this app
    // can serve, so the screen says whether HR has attached one and no more.
    hasPhoto: Boolean(r.photoPath),
    // Split on the way out, so no screen has to know how to tell them apart.
    issues: r.issues.filter((i) => i.kind !== "ambiguous"),
    dateNotes: r.issues.filter((i) => i.kind === "ambiguous"),
    updatedAt: r.updatedAt.toISOString(),
  }));

  const present = list.filter((e) => !e.withdrawn);
  const distinct = (values: (string | null)[]) =>
    [...new Set(values.filter((v): v is string => Boolean(v)))].sort((a, b) =>
      a.localeCompare(b),
    );

  return {
    employees: list,
    summary: {
      total: present.length,
      active: present.filter((e) => e.status === "active").length,
      inactive: present.filter((e) => e.status === "inactive").length,
      unknown: present.filter((e) => e.status === "unknown").length,
      withdrawn: list.length - present.length,
      withIssues: list.filter((e) => e.issues.length > 0).length,
      datesReadByConvention: list.filter((e) => e.dateNotes.length > 0).length,
      offices: distinct(present.map((e) => e.officeName)),
      departments: distinct(present.map((e) => e.department)),
    },
    lastSync: lastRun
      ? {
          at: lastRun.startedAt.toISOString(),
          mode: lastRun.mode,
          status: lastRun.status,
          rowsCreated: lastRun.rowsCreated,
          rowsUpdated: lastRun.rowsUpdated,
          rowsUnchanged: lastRun.rowsUnchanged,
          rowsWithdrawn: lastRun.rowsWithdrawn,
          error: lastRun.error,
        }
      : null,
    source: {
      spreadsheetId: employeeSheetId(),
      tabTitle: EMPLOYEE_TAB,
      configured: Boolean(
        process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY,
      ),
    },
  };
}

/** How many people are on the books — the launcher tile's number. */
export async function activeEmployeeCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(employees)
    .where(and(eq(employees.status, "active"), eq(employees.sheetStatus, "present")));
  return row?.n ?? 0;
}
