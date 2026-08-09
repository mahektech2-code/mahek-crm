import "server-only";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { employees, sheetSyncRuns } from "@/db/schema";
import { readTab, sheetsConfigured, type SheetTable } from "@/lib/sheets";
import {
  HR_FIRST_DATA_ROW,
  isLabelRow,
  parseEmployeeRow,
  redactRaw,
  type ParsedEmployee,
} from "@/lib/hr-parse";
import {
  hashRow,
  newSyncId,
  readWindows,
  runSync,
  watermark,
  WRITE_BATCH,
  type SheetReader,
  type SyncCounts,
  type SyncMode,
  type SyncOutcome,
} from "./sheet-sync-core";

/* ---------------------------------------------------------------------------
 * Pulling the Employee Details tab into the employee master.
 *
 * The mechanics are the order sheet's, shared through sheet-sync-core: a
 * windowed read, a per-row hash so an unchanged sheet costs no writes, and a
 * run record that survives a failure. What differs is everything about the
 * data, and three things are worth stating.
 *
 * FIRST, RECONCILE IS THE DEFAULT AND APPEND IS THE EXCEPTION. The order sheet
 * is heading for thirty thousand rows, so it reads only past its watermark
 * most of the time. This tab is the payroll of one company — seventy-odd rows,
 * one API call — so a full compare is affordable every few minutes, and it is
 * the only mode that notices a salary corrected, a person marked Inactive, or
 * a row deleted. Watching only for new rows would miss all three.
 *
 * SECOND, THE TAB HAS TWO HEADER ROWS. Row 1 is the machine header the cells
 * are keyed by; row 2 repeats it in human words and arrives looking exactly
 * like a complete record. It is skipped by what it SAYS as well as by where it
 * sits, or the day somebody inserts a row at the top the master gains an
 * employee called "Name Of Employee".
 *
 * THIRD, A PERSON IS NEVER DELETED. A row that leaves the sheet becomes
 * `withdrawn` and stays readable. Payroll history outlives a spreadsheet edit,
 * and somebody removing a leaver from a sheet is not a request to erase them.
 * ------------------------------------------------------------------------- */

/** The sheet and tab this import reads. One source, so one watermark. */
export const EMPLOYEE_SOURCE = "employee_details";
export const EMPLOYEE_TAB = "Employee Details";

/**
 * The workbook the employee master is read from.
 *
 * Hardcoded, and that is the decision rather than an oversight. This is not a
 * secret — it identifies a document, and the thing that actually grants access
 * to it is the service account credential, which stays in the environment. A
 * spreadsheet id in a variable meant one more thing to set correctly on every
 * environment for no security gained, and an HRMS that reports "not
 * configured" because a deploy missed a variable is worse than one that always
 * knows where to look.
 *
 * `HR_SHEET_ID` still wins if it is set, so pointing a staging deploy at a copy
 * of the sheet takes a variable and no code change.
 */
export const EMPLOYEE_SPREADSHEET_ID = "19egjF3QaVADA_N138tckOb7ozzkXLdOpseKSzLn4NlY";

export function employeeSheetId(): string {
  return process.env.HR_SHEET_ID || EMPLOYEE_SPREADSHEET_ID;
}

export type EmployeeSyncOptions = {
  spreadsheetId: string;
  tabTitle?: string;
  mode: SyncMode;
  triggeredById?: string | null;
  reader?: SheetReader;
};

export async function syncEmployeeSheet(
  options: EmployeeSyncOptions,
): Promise<SyncOutcome> {
  const tabTitle = options.tabTitle ?? EMPLOYEE_TAB;
  const { mode } = options;

  if (mode !== "reparse" && !options.reader && !sheetsConfigured()) {
    // Deliberately not an empty success. A sync that reports zero people and a
    // sync that never authenticated look identical on a screen, and only one
    // of them means the company has no staff.
    throw new Error(
      "Google Sheets is not configured — set GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY.",
    );
  }

  return runSync(
    {
      source: EMPLOYEE_SOURCE,
      spreadsheetId: options.spreadsheetId,
      tabTitle,
      mode,
      triggeredById: options.triggeredById,
    },
    (syncId) =>
      mode === "reparse"
        ? reparseStored(syncId)
        : pullFromSheet(syncId, { ...options, tabTitle }),
  );
}

async function pullFromSheet(
  syncId: string,
  { spreadsheetId, tabTitle, mode, reader }: EmployeeSyncOptions & { tabTitle: string },
): Promise<SyncCounts> {
  const read: SheetReader =
    reader ?? ((range) => readTab(spreadsheetId, tabTitle, range));
  const startRow =
    mode === "append"
      ? Math.max((await watermark(EMPLOYEE_SOURCE)) + 1, HR_FIRST_DATA_ROW)
      : HR_FIRST_DATA_ROW;

  let rowsRead = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let withIssues = 0;
  let highestRow = Math.max(startRow - 1, 1);

  for await (const window of readWindows(read, startRow, HR_FIRST_DATA_ROW)) {
    const rows = window.rows.filter((row) => !isLabelRow(row.cells));
    rowsRead += rows.length;
    for (const row of rows) highestRow = Math.max(highestRow, row.rowNumber);

    const result = await writeWindow(syncId, { ...window, rows });
    created += result.created;
    updated += result.updated;
    unchanged += result.unchanged;
    withIssues += result.withIssues;

    await db
      .update(sheetSyncRuns)
      .set({ cursorRow: highestRow, rowsRead, highestRow })
      .where(eq(sheetSyncRuns.id, syncId));
  }

  // Only a full read can conclude somebody has gone from the sheet. An append
  // run has not looked at the rows above its watermark and must never mark
  // them missing — that would withdraw the entire company on the first run.
  let withdrawn = 0;
  if (mode === "reconcile") {
    const result = await db
      .update(employees)
      .set({ sheetStatus: "withdrawn", updatedAt: new Date() })
      .where(
        and(ne(employees.lastSeenSyncId, syncId), eq(employees.sheetStatus, "present")),
      )
      .returning({ id: employees.id });
    withdrawn = result.length;
  }

  const detail =
    `${mode} from row ${startRow}: ${created} new, ${updated} changed, ` +
    `${unchanged} unchanged` +
    (withdrawn ? `, ${withdrawn} gone from the sheet` : "") +
    (withIssues ? `, ${withIssues} with issues` : "");

  return {
    rowsRead,
    rowsCreated: created,
    rowsUpdated: updated,
    rowsUnchanged: unchanged,
    rowsWithdrawn: withdrawn,
    rowsWithIssues: withIssues,
    detail,
  };
}

/**
 * A row with no employee id still has a person on it.
 *
 * It is keyed by where it sits instead, which is a worse key — the record
 * moves if rows above it are deleted — but a row held under a poor key can be
 * found and corrected, and a row dropped on the floor cannot. The parser
 * raises an issue saying so.
 */
const keyOf = (parsed: ParsedEmployee, rowNumber: number) =>
  parsed.employeeCode || `ROW-${rowNumber}`;

async function writeWindow(syncId: string, window: SheetTable) {
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let withIssues = 0;

  for (let i = 0; i < window.rows.length; i += WRITE_BATCH) {
    const slice = window.rows.slice(i, i + WRITE_BATCH);
    if (!slice.length) continue;

    const prepared = slice.map((row) => {
      const parsed = parseEmployeeRow(row.cells);
      return {
        row,
        parsed,
        // Hashed over what the sheet gave us, INCLUDING the password column,
        // so a change there is still seen as a change to the row. What gets
        // stored is the redacted copy.
        hash: hashRow(row.cells),
        code: keyOf(parsed, row.rowNumber),
      };
    });

    // One read to find out which rows actually changed. This is what keeps a
    // frequent reconcile cheap: matching rows are touched no further.
    const existing = await db
      .select({ code: employees.employeeCode, rowHash: employees.rowHash })
      .from(employees)
      .where(inArray(employees.employeeCode, prepared.map((p) => p.code)));
    const hashByCode = new Map(existing.map((e) => [e.code, e.rowHash]));

    const changed: (typeof employees.$inferInsert)[] = [];
    const untouched: string[] = [];

    for (const { row, parsed, hash, code } of prepared) {
      const known = hashByCode.get(code);
      if (known === hash) {
        unchanged++;
        untouched.push(code);
        continue;
      }
      if (parsed.issues.length) withIssues++;
      if (known === undefined) created++;
      else updated++;

      changed.push({
        id: newSyncId("emp"),
        syncId,
        rowNumber: row.rowNumber,
        employeeCode: code,
        name: parsed.name || "(no name in the sheet)",
        gender: parsed.gender,
        officeName: parsed.officeName,
        reportsTo: parsed.reportsTo,
        department: parsed.department,
        position: parsed.position,
        areaAllocated: parsed.areaAllocated,
        status: parsed.status,
        statusRaw: parsed.statusRaw,
        dateOfJoining: parsed.dateOfJoining,
        dateOfBirth: parsed.dateOfBirth,
        dateOfLeaving: parsed.dateOfLeaving,
        marriageAnniversary: parsed.marriageAnniversary,
        child1Birthday: parsed.child1Birthday,
        child2Birthday: parsed.child2Birthday,
        email: parsed.email,
        personalMobile: parsed.personalMobile,
        alternateMobile: parsed.alternateMobile,
        companyMobile: parsed.companyMobile,
        emergencyContact: parsed.emergencyContact,
        address: parsed.address,
        permanentAddress: parsed.permanentAddress,
        netSalaryPaise: parsed.netSalaryPaise,
        conveyancePaise: parsed.conveyancePaise,
        otherSalaryPaise: parsed.otherSalaryPaise,
        monthlyPaidLeave: parsed.monthlyPaidLeave,
        yearlyMaximumLeave: parsed.yearlyMaximumLeave,
        pfEsicApplicable: parsed.pfEsicApplicable,
        uanNo: parsed.uanNo,
        esicNo: parsed.esicNo,
        bankName: parsed.bankName,
        ifscCode: parsed.ifscCode,
        accountNumberLast4: parsed.accountNumberLast4,
        aadhaarLast4: parsed.aadhaarLast4,
        panNumber: parsed.panNumber,
        photoPath: parsed.photoPath,
        raw: redactRaw(row.cells),
        rowHash: hash,
        sheetStatus: "present",
        lastSeenSyncId: syncId,
        issues: parsed.issues,
        updatedAt: new Date(),
      });
    }

    if (changed.length) {
      await db
        .insert(employees)
        .values(changed)
        .onConflictDoUpdate({ target: employees.employeeCode, set: upsertColumns() });
    }

    // Unchanged rows still need their "seen" stamp, or the reconcile pass
    // would conclude every one of them had left the company. One statement
    // for the batch, writing two columns.
    if (untouched.length) {
      await db
        .update(employees)
        .set({ lastSeenSyncId: syncId, sheetStatus: "present" })
        .where(inArray(employees.employeeCode, untouched));
    }
  }

  return { created, updated, unchanged, withIssues };
}

/**
 * The columns an upsert overwrites.
 *
 * Not `id` and not `createdAt` — a person who already exists keeps their
 * identity across re-imports, because anything that comes to point at an
 * employee will point at that id.
 */
function upsertColumns() {
  const set: Record<string, unknown> = {};
  for (const column of [
    "syncId", "rowNumber", "name", "gender", "officeName", "reportsTo",
    "department", "position", "areaAllocated", "status", "statusRaw",
    "dateOfJoining", "dateOfBirth", "dateOfLeaving", "marriageAnniversary",
    "child1Birthday", "child2Birthday", "email", "personalMobile",
    "alternateMobile", "companyMobile", "emergencyContact", "address",
    "permanentAddress", "netSalaryPaise", "conveyancePaise", "otherSalaryPaise",
    "monthlyPaidLeave", "yearlyMaximumLeave", "pfEsicApplicable", "uanNo",
    "esicNo", "bankName", "ifscCode", "accountNumberLast4", "aadhaarLast4",
    "panNumber", "photoPath", "raw", "rowHash", "sheetStatus", "lastSeenSyncId",
    "issues", "updatedAt",
  ]) {
    set[column] = sql.raw(`excluded.${toSnake(column)}`);
  }
  return set;
}

const toSnake = (s: string) =>
  // child1Birthday → child1_birthday: a digit belongs to the word before it.
  s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Re-run the parser over rows already stored. Touches Google not at all.
 *
 * This is the mode that makes a wrong reading cheap to fix — the date rules in
 * particular, which are the one place this import applies a convention. The
 * raw cells are already here, so correcting the rule costs one pass over the
 * database rather than a re-import.
 *
 * The password column is not in the stored raw, so a reparse cannot recover
 * it. Nothing here wants it.
 */
async function reparseStored(syncId: string): Promise<SyncCounts> {
  let updated = 0;
  let withIssues = 0;
  let read = 0;
  let after = "";

  for (;;) {
    const page = await db
      .select({ id: employees.id, raw: employees.raw })
      .from(employees)
      .where(after ? sql`${employees.id} > ${after}` : undefined)
      .orderBy(employees.id)
      .limit(WRITE_BATCH);

    if (!page.length) break;
    read += page.length;
    after = page[page.length - 1].id;

    for (const row of page) {
      const parsed = parseEmployeeRow(row.raw);
      if (parsed.issues.length) withIssues++;
      updated++;

      await db
        .update(employees)
        .set({
          syncId,
          name: parsed.name || "(no name in the sheet)",
          gender: parsed.gender,
          officeName: parsed.officeName,
          reportsTo: parsed.reportsTo,
          department: parsed.department,
          position: parsed.position,
          areaAllocated: parsed.areaAllocated,
          status: parsed.status,
          statusRaw: parsed.statusRaw,
          dateOfJoining: parsed.dateOfJoining,
          dateOfBirth: parsed.dateOfBirth,
          dateOfLeaving: parsed.dateOfLeaving,
          marriageAnniversary: parsed.marriageAnniversary,
          child1Birthday: parsed.child1Birthday,
          child2Birthday: parsed.child2Birthday,
          email: parsed.email,
          personalMobile: parsed.personalMobile,
          alternateMobile: parsed.alternateMobile,
          companyMobile: parsed.companyMobile,
          emergencyContact: parsed.emergencyContact,
          address: parsed.address,
          permanentAddress: parsed.permanentAddress,
          netSalaryPaise: parsed.netSalaryPaise,
          conveyancePaise: parsed.conveyancePaise,
          otherSalaryPaise: parsed.otherSalaryPaise,
          monthlyPaidLeave: parsed.monthlyPaidLeave,
          yearlyMaximumLeave: parsed.yearlyMaximumLeave,
          pfEsicApplicable: parsed.pfEsicApplicable,
          uanNo: parsed.uanNo,
          esicNo: parsed.esicNo,
          bankName: parsed.bankName,
          ifscCode: parsed.ifscCode,
          accountNumberLast4: parsed.accountNumberLast4,
          aadhaarLast4: parsed.aadhaarLast4,
          panNumber: parsed.panNumber,
          photoPath: parsed.photoPath,
          issues: parsed.issues,
          updatedAt: new Date(),
        })
        .where(eq(employees.id, row.id));
    }
  }

  return {
    rowsRead: read,
    rowsCreated: 0,
    rowsUpdated: updated,
    rowsUnchanged: 0,
    rowsWithdrawn: 0,
    rowsWithIssues: withIssues,
    detail: `reparsed ${updated} stored employee records, ${withIssues} with issues`,
  };
}
