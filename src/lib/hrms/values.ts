/* ---------------------------------------------------------------------------
 * The HRMS's STORED words — the values written into its columns and compared
 * against in its rules — in one place, so a status is spelled once.
 *
 * The first build stored Mahek EMP 2.0's own spellings: a grievance closed as
 * "Solve", a help request typed "I Forgot Make Attendance", an office open
 * "24*7", a checklist item marked "N/A". They were readable only to somebody
 * who had used the AppSheet app, and every one of them was compared as a
 * literal in two or three places. The restructure renamed them in the data
 * (`0202_hrms_plain_values.sql`, which reads `RENAMED` below) and in the
 * code, which names these constants rather than the words.
 *
 * An import of an old file may still carry the old spelling, so `fromOld`
 * turns one into the new word wherever a value arrives from outside.
 *
 * PURE and client-safe.
 * ------------------------------------------------------------------------- */

export const LEAVE_WAITING = "Waiting";

export const GRIEVANCE_ANSWERED = "Answered";

export const BUDDY_DONE = "Done";

export const CHECKLIST_NA = "Not applicable";

export const OFFICE_ALL_HOURS = "24 hours";
export const OFFICE_TIMINGS = ["Full Day", "Half Day", OFFICE_ALL_HOURS] as const;

export const ASSET_EQUIPMENT = "Equipment";
export const ASSET_CATEGORIES = ["Stationery", ASSET_EQUIPMENT, "Other"] as const;

export const EXPENSE_CLAIM = "Claim";
export const EXPENSE_PAID = "Payment";

export const HOLIDAY_CATEGORIES = ["Festival", "Weekly", "National", "Weather"] as const;

export const HELP = {
  forgotCheckIn: "Forgot to check in",
  lateCheckIn: "Checked in late",
  forgotCheckOut: "Forgot to check out",
  runningLate: "Running late today",
  overtime: "Overtime not approved",
  learnApp: "Help learning the app",
  appIssue: "Problem with the app",
  other: "Other",
} as const;

/** Every renamed stored value, column by column: the migration and the import read this. */
export const RENAMED: { table: string; column: string; from: string; to: string }[] = [
  { table: "hrms_leave_requests", column: "status", from: "Requesting", to: LEAVE_WAITING },
  { table: "hrms_grievances", column: "status", from: "Solve", to: GRIEVANCE_ANSWERED },
  { table: "hrms_buddy_tasks", column: "status", from: "Task done", to: BUDDY_DONE },
  { table: "hrms_checklist", column: "status", from: "N/A", to: CHECKLIST_NA },
  { table: "hrms_offices", column: "timing_type", from: "24*7", to: OFFICE_ALL_HOURS },
  { table: "hrms_asset_stock", column: "category", from: "Tangible Assets", to: ASSET_EQUIPMENT },
  { table: "hrms_expenses", column: "pay_type", from: "Expense Claim", to: EXPENSE_CLAIM },
  { table: "hrms_expenses", column: "pay_type", from: "Expense Paid", to: EXPENSE_PAID },
  { table: "hrms_holidays", column: "category", from: "Nature", to: "Weather" },
  { table: "hrms_help", column: "type", from: "I Forgot Make Attendance", to: HELP.forgotCheckIn },
  { table: "hrms_help", column: "type", from: "I Late Check In", to: HELP.lateCheckIn },
  { table: "hrms_help", column: "type", from: "I Forget Check Out", to: HELP.forgotCheckOut },
  { table: "hrms_help", column: "type", from: "I Am Late Today", to: HELP.runningLate },
  { table: "hrms_help", column: "type", from: "OT Not Approved", to: HELP.overtime },
  { table: "hrms_help", column: "type", from: "I Want to Lean App", to: HELP.learnApp },
];

/** A value from an old file or an old export, in today's word. */
export function fromOld(value: string): string {
  const v = value.trim();
  return RENAMED.find((r) => r.from.toLowerCase() === v.toLowerCase())?.to ?? v;
}
