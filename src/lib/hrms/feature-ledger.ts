/* ---------------------------------------------------------------------------
 * THE HRMS FEATURE LEDGER — what the first build could do, and where each
 * thing is now.
 *
 * The HRMS was restructured from 41 screens copied one AppSheet view at a
 * time into 14 screens with tabs, its AppSheet wording rewritten, and its
 * copies of things MahekOne already had handed to the shared feature. The
 * client's one condition was that NOTHING is lost in doing it: no feature, no
 * function, no rule. This file is how that is kept rather than hoped for.
 *
 * `BASELINE` is every server handler of every screen as the first build had
 * them, captured from the modules themselves on 2026-10-04 — 169 actions, bulk
 * actions, forms, form loaders and header tools. It is frozen: nothing edits it.
 *
 * `MOVED` says where an entry went, when it is not where it was:
 *   - `at`      — another screen module's handler that does the same job;
 *   - `shared`  — a MahekOne feature outside the HRMS that does it, named by a
 *                 file and a line that must appear in it;
 *   - `retired` — dead code or an exact copy, with the reason. Never a
 *                 working feature somebody used.
 *
 * `FEATURES` is everything that is not a handler — a check-in rule, a PDF, a
 * calendar, a nightly job, a badge — each pinned by a file and a marker line.
 *
 * `feature-ledger.test.ts` fails the build when a baseline handler is neither
 * where it was nor accounted for here, when a destination does not exist, when
 * a feature's marker has disappeared from its file, and when a NEW handler
 * appears that nobody recorded. So "we lost a feature in the restructure" is a
 * red build, not a phone call.
 *
 * PURE: data only.
 * ------------------------------------------------------------------------- */

export type HandlerKind = "actions" | "bulk" | "forms" | "formLoaders" | "tools";

export type ModuleHandlers = Partial<Record<HandlerKind, string[]>>;

/** Every handler, by the screen key whose module held it, before the restructure. Frozen. */
export const BASELINE: Record<string, ModuleHandlers> = {
  attendance: { actions: ["checkOutLate", "officerOut", "setIn", "remark", "editHelp", "delete"], forms: ["mark"], tools: ["import", "importConfirm"] },
  pendingOut: { actions: ["checkOutLate", "officerOut", "setIn", "remark", "editHelp", "delete"] },
  absentees: {},
  attChart: {},
  leave: { actions: ["approve", "reject", "remark", "delete"], forms: ["apply", "edit"], formLoaders: ["edit"] },
  approvals: { actions: ["approve", "reject", "remark", "delete"], bulk: ["approveBulk", "rejectBulk"], forms: ["apply", "edit"], formLoaders: ["edit"] },
  leaveCal: { actions: ["approve", "reject", "remark", "delete"], forms: ["apply", "edit"], formLoaders: ["edit"] },
  leaveSetup: { actions: ["editCredit", "deleteCredit"], forms: ["credit"], tools: ["runCredits"] },
  holidays: { actions: ["edit", "delete"], forms: ["add"], tools: ["import", "importConfirm"] },
  overtime: { actions: ["edit", "delete"], forms: ["add"] },
  monthly: { actions: ["editRemark", "deleteRemark"] },
  payroll: { actions: ["approve", "pay", "remark", "regenerate", "delete"], bulk: ["approve", "pay"], forms: ["new", "edit"], formLoaders: ["edit"] },
  advances: { actions: ["delete"], forms: ["new", "edit"], formLoaders: ["edit"] },
  expenses: { actions: ["verify", "unverify", "delete"], bulk: ["verify"], forms: ["new", "edit"], formLoaders: ["edit"] },
  checklist: { actions: ["done", "notDone", "na", "remark", "delete"], bulk: ["clDone"], tools: ["takeTask", "eod"] },
  todos: { actions: ["done", "notDone", "verify", "pending", "remark", "delete"], forms: ["assign"] },
  buddy: { actions: ["accept", "done", "delete"], forms: ["share"] },
  templates: { actions: ["delete"], forms: ["template"], formLoaders: ["edit"], tools: ["takeTask", "takeMonthly", "eod"] },
  kpi: { actions: ["delete"], forms: ["kpi"], formLoaders: ["edit"] },
  salesPerf: {},
  staffPerf: {},
  eom: {},
  points: { actions: ["review", "regenerate"] },
  customers: { actions: ["takeFollowUp", "requestDeactivation", "withdrawRequest", "acceptDeactivation", "rejectDeactivation", "makeActive"], forms: ["edit"], formLoaders: ["edit"] },
  calling: { actions: ["logCall", "delete"] },
  activity: { actions: ["delete"], forms: ["activity"], formLoaders: ["edit"] },
  journey: { actions: ["delete"], forms: ["journey"], formLoaders: ["edit"] },
  employees: { actions: ["deactivate", "activate", "photo", "delete"], bulk: ["empActivate", "empDeactivate"], forms: ["new", "edit", "editSelf"], formLoaders: ["edit", "editSelf"], tools: ["pullSheet"] },
  idCards: { actions: ["upload", "remove"] },
  offices: { actions: ["delete"], forms: ["new", "edit"], formLoaders: ["edit"] },
  timings: { actions: ["addMore", "quickEdit", "delete"], forms: ["new"] },
  assetStock: { actions: ["delete"], forms: ["new", "edit"], formLoaders: ["edit"] },
  assignments: { actions: ["restore", "delete"], forms: ["new"] },
  help: { actions: ["approve", "remark", "delete"], forms: ["new"] },
  grievances: { actions: ["solve", "feedback", "delete"], forms: ["new", "edit"], formLoaders: ["edit"] },
  documents: { actions: ["delete"], forms: ["new"] },
  notifications: { actions: ["seen", "edit", "delete"], forms: ["new"] },
  refLists: { actions: ["add", "remove"] },
};

/** `"<screen>.<kind>.<id>"` — one handler of one screen module. */
export type HandlerRef = `${string}.${HandlerKind}.${string}`;

export type Destination =
  | { at: HandlerRef; note?: string }
  | { shared: string; file: string; marker: string }
  | { retired: string };

/**
 * Where a baseline handler went, when it is not exactly where it was. A
 * handler with no entry here must still exist under the same screen, kind and
 * id — the test checks it.
 */
export const MOVED: Partial<Record<HandlerRef, Destination>> = {};

/**
 * Handlers that did not exist before the restructure. Recorded so a new door
 * is a decision somebody wrote down, and so the test can tell an addition from
 * a typo in a move.
 */
export const ADDED: Partial<Record<HandlerRef, string>> = {};

/**
 * Everything that is not a handler: rules, views, documents, jobs and the
 * furniture around them. Each is pinned by a file and a line that must stay in
 * it, so deleting the code that does it fails the build.
 */
export type Feature = { what: string; file: string; marker: string };

export const FEATURES: Record<string, Feature> = {
  /* ------------------------------------------------------------- check-in */
  checkIn: { what: "Geo-fenced check-in with an optional photo; HR and admin get the wider range", file: "src/lib/actions/hrms-checkin.ts", marker: "export async function hrmsCheckIn" },
  checkInQr: { what: "QR-code check-in against the office's code, behind its setting", file: "src/lib/actions/hrms-checkin.ts", marker: "hrms.attendance.qrEnabled" },
  checkOut: { what: "Check-out, geo-fenced unless the day was a QR check-in", file: "src/lib/actions/hrms-checkin.ts", marker: "export async function hrmsCheckOut" },
  lateHelp: { what: "A refused late check-in can raise “I am late today” on the spot", file: "src/lib/actions/hrms-checkin.ts", marker: "export async function hrmsRaiseLateHelp" },
  checkInRules: { what: "The check-in refusal order: already, location off, no pin, outside, late", file: "src/lib/hrms/engines/attendance.ts", marker: "export function decideCheckIn" },
  dayFigures: { what: "Worked time, late, percentage of target, full or half day", file: "src/lib/hrms/engines/attendance.ts", marker: "export function dayFigures" },
  homeCard: { what: "The check-in card: timing, office, worked-so-far bar, late and day result", file: "src/app/hrms/_ui/home-card.tsx", marker: "export function HomeCard" },
  homeWaiting: { what: "“Waiting for you today”: check-outs, checklist, to-dos, buddy tasks, approvals, staff to mark or check out, help and grievances", file: "src/app/hrms/page.tsx", marker: "wait.push" },
  officeQrPrint: { what: "A printable QR code per office", file: "src/app/hrms/offices/[id]/qr/page.tsx", marker: "qrSvgPath" },
  qrEncoder: { what: "The in-house QR encoder", file: "src/lib/hrms/qr.ts", marker: "export function encodeQr" },

  /* ---------------------------------------------------------- leave & pay */
  leaveRules: { what: "Leave clash, end-before-start and same-month checks", file: "src/lib/hrms/engines/leave.ts", marker: "export function checkRequest" },
  leaveBalances: { what: "Paid leave from the month's credits, unpaid from the yearly maximum", file: "src/lib/hrms/engines/leave.ts", marker: "export function balances" },
  monthlyCredit: { what: "Monthly paid-leave credit, nightly and from Run now", file: "src/lib/hrms/jobs.ts", marker: "export async function runMonthlyLeaveCredit" },
  monthlyCreditCron: { what: "The nightly job that runs the leave credit", file: "src/lib/jobs.ts", marker: "hrms-leave-credit" },
  leaveNotify: { what: "Approvers are told of a request; the person is told of the decision", file: "src/lib/hrms/screens/leave.ts", marker: "tellApprovers" },
  payrollFormula: { what: "Salary from attendance, leave and holidays: PF, ESIC, PT slabs, late-mark deduction, advance recovery", file: "src/lib/hrms/engines/payroll.ts", marker: "export function computeSalary" },
  salaryBlock: { what: "A salary is refused while a check-out is pending or days are unaccounted for", file: "src/lib/hrms/engines/payroll.ts", marker: "export function salaryBlock" },
  payslipPdf: { what: "The payslip PDF, drawn from the frozen figures", file: "src/app/api/hrms/payslip/[id]/route.ts", marker: "export async function GET" },
  attendanceChanged: { what: "A salary approved before attendance changed says so", file: "src/lib/hrms/screens/pay.ts", marker: "Attendance changed since" },
  advanceRecovery: { what: "Advance outstanding derived from salaries, oldest advance recovered first", file: "src/lib/hrms/screens/pay.ts", marker: "recoveredByAdvance" },
  expenseBalances: { what: "Verified claims less verified payments, by month and in all", file: "src/lib/hrms/screens/pay.ts", marker: "expenseBalances" },

  /* ---------------------------------------------------------------- tasks */
  taskTemplates: { what: "Template checks: frequency, weekdays, day of month, before-day, times", file: "src/lib/hrms/engines/tasks.ts", marker: "export function checkTemplate" },
  taskEod: { what: "Task EOD message, to copy or send to WhatsApp", file: "src/lib/hrms/engines/tasks.ts", marker: "export function taskEodMessage" },

  /* ---------------------------------------------------------- performance */
  salesScore: { what: "The nine-part daily sales score", file: "src/lib/hrms/engines/performance.ts", marker: "export function dailyScore" },
  staffMonth: { what: "Monthly staff performance: hours, punctuality, tasks, to-dos, buddy tasks", file: "src/lib/hrms/engines/performance.ts", marker: "export function staffMonth" },
  points: { what: "Period performance points by kind of job", file: "src/lib/hrms/engines/performance.ts", marker: "export function performancePoints" },
  employeeOfMonth: { what: "Employee of the month at the configured mark", file: "src/lib/hrms/engines/performance.ts", marker: "export const isEmployeeOfMonth" },
  reviewPdf: { what: "The period review PDF", file: "src/app/api/hrms/performance-report/route.ts", marker: "export async function GET" },
  kpiPrefill: { what: "KPI visits filled in from field-app check-ins", file: "src/lib/hrms/screens/perf.ts", marker: "mbosVisitCount" },

  /* ---------------------------------------------------------------- sales */
  callingTabs: { what: "Calling tabs: to call, follow-ups due, history, older", file: "src/lib/hrms/engines/calling.ts", marker: "export function callingTab" },
  callingSuggestion: { what: "Follow up or deactivate, from calls against orders", file: "src/lib/hrms/engines/calling.ts", marker: "export function suggestion" },

  /* --------------------------------------------------------------- people */
  orgChart: { what: "The org chart: chart and list views, set and clear a manager, loop refusal", file: "src/lib/actions/org.ts", marker: "export async function setManager" },
  sheetSync: { what: "The employee master mirrored from the sheet, HRMS-owned rows kept", file: "src/lib/services/employee-sync-service.ts", marker: "HRMS_OWNED" },
  powers: { what: "The 22 HRMS powers, granted on the Access screen", file: "src/lib/hrms/powers.ts", marker: "export const HRMS_POWERS" },
  scope: { what: "Mine, my team and everyone", file: "src/lib/hrms/access.ts", marker: "export function scopeOf" },
  attachments: { what: "HRMS uploads, and who may open each kind", file: "src/lib/hrms/attachments.ts", marker: "export async function canReadHrmsAttachment" },

  /* ----------------------------------------------------------- the shell */
  search: { what: "Header search across people, customers and documents", file: "src/lib/actions/hrms-screens.ts", marker: "export async function hrmsSearch" },
  badges: { what: "Sidebar and tab badges for work waiting", file: "src/lib/hrms/counts.ts", marker: "export const hrmsNavCounts" },
  bottomBar: { what: "The phone bottom bar of everyday screens", file: "src/app/hrms/_ui/hrms-shell.tsx", marker: "Everyday screens" },
  settingsView: { what: "The HRMS rules in force, read-only, with the way to the console", file: "src/app/hrms/_ui/settings-view.tsx", marker: "export async function SettingsView" },
  calendar: { what: "Month calendar view with holidays (leave calendar, journey planner)", file: "src/app/hrms/_ui/above.tsx", marker: "function Calendar" },
  chart: { what: "Trend chart with a parts breakdown (attendance chart, sales score)", file: "src/app/hrms/_ui/above.tsx", marker: "function Chart" },
  oldUrls: { what: "Every first-build URL redirects to the tab it became", file: "next.config.ts", marker: "HRMS_RETIRED_SLUGS" },
};
