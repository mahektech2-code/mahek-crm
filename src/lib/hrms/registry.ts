/* ---------------------------------------------------------------------------
 * The HRMS's screens, grouped the way its sidebar draws them (the design's
 * MODS). ONE LIST for three readers: the sidebar, the module guard (via
 * `lib/modules.ts`) and the Access screen. Module key = `hrms.<key>`.
 *
 * Every function has ONE screen (PRD §3.2): what a person sees on it is their
 * scope, never a second copy of the screen.
 *
 * PURE and client-safe.
 * ------------------------------------------------------------------------- */

export type HrmsIcon =
  | "clock" | "check" | "cal" | "file" | "wallet" | "receipt" | "list" | "chart"
  | "phone" | "people" | "building" | "box" | "help" | "doc" | "bell" | "gear";

/** How a screen is drawn: the generic list, or one of the design's other views above it. */
export type HrmsView = "list" | "home" | "calendar" | "chart" | "perf" | "custom";

export type HrmsScreen = {
  /** Stable key; the module key is `hrms.<key>`. Never renamed — it is a grant. */
  key: string;
  /** URL segment under /hrms. Home is the app root. */
  slug: string;
  label: string;
  sub: string;
  view: HrmsView;
  /** A screen behind a setting that is off in the source (Overtime). */
  flag?: "ot";
  /** Drawn on phones in the bottom bar. */
  bottom?: boolean;
};

export type HrmsGroup = { id: string; label: string; icon: HrmsIcon; screens: HrmsScreen[] };

const s = (key: string, slug: string, label: string, sub: string, view: HrmsView = "list", extra: Partial<HrmsScreen> = {}): HrmsScreen => ({
  key,
  slug,
  label,
  sub,
  view,
  ...extra,
});

export const HRMS_GROUPS: HrmsGroup[] = [
  { id: "home", label: "Check in", icon: "clock", screens: [s("home", "", "Check in", "", "home", { bottom: true })] },
  {
    id: "att",
    label: "Attendance",
    icon: "check",
    screens: [
      s("attendance", "attendance", "Attendance", "Every check-in and check-out, newest first. Heads see their team, HR and admin see everyone."),
      s("pendingOut", "pending-check-outs", "Pending check-outs", "Days with a check-in and no check-out. A pending check-out blocks that month’s salary."),
      s("absentees", "absentees", "Absentees", "Active employees with no attendance, not on a holiday tagged to them and not on leave."),
      s("attChart", "attendance-chart", "Attendance chart", "People present per day with a trend. Tap a row to open that person’s days.", "chart"),
    ],
  },
  {
    id: "leave",
    label: "Leave & Holidays",
    icon: "cal",
    screens: [
      s("leave", "leave", "Leave requests", "Every leave and half-day request. You see yours; HR and admin see everyone’s.", "list", { bottom: true }),
      s("approvals", "leave-approvals", "Leave approvals", "Requests waiting for a decision, grouped by employee. Approving sets how many days are paid."),
      s("leaveCal", "leave-calendar", "Leave calendar", "One bar per request. Approved in green, waiting in amber.", "calendar"),
      s("leaveSetup", "leave-setup", "Leave setup", "Monthly paid-leave credits, created automatically on the 1st of each month."),
      s("holidays", "holidays", "Holidays", "Weekly offs, festivals, national and weather closures, and who they apply to."),
    ],
  },
  { id: "ot", label: "Overtime", icon: "clock", screens: [s("overtime", "overtime", "Overtime", "One record per employee per date, above the shortest overtime.", "list", { flag: "ot" })] },
  { id: "monthly", label: "Monthly reports", icon: "file", screens: [s("monthly", "monthly-reports", "Monthly reports", "Per employee per month. Missing dates must be cleared before that month’s salary.")] },
  {
    id: "pay",
    label: "Payroll",
    icon: "wallet",
    screens: [
      s("payroll", "payroll", "Salaries", "Prepared, approved and paid salaries by month. Employees see their own paid payslips here."),
      s("advances", "advances", "Advances", "Salary advances and what is still to be recovered."),
    ],
  },
  { id: "exp", label: "Expenses", icon: "receipt", screens: [s("expenses", "expenses", "Expenses", "Claims and payments per employee, with the monthly and total balance.")] },
  {
    id: "tasks",
    label: "Tasks",
    icon: "list",
    screens: [
      s("checklist", "checklists", "Checklists", "Today’s tasks, what is still blank this week, and every checklist before.", "list", { bottom: true }),
      s("todos", "to-dos", "To-dos", "Work given to you and by you. The giver verifies it once it is done."),
      s("buddy", "buddy-tasks", "Buddy tasks", "One of today’s tasks shared with a colleague, who accepts it and marks it done."),
      s("templates", "task-templates", "Task templates", "Daily, weekly and monthly tasks. Take my task copies today’s into your checklist."),
    ],
  },
  {
    id: "perf",
    label: "Performance",
    icon: "chart",
    screens: [
      s("kpi", "kpi", "KPI KRA", "Daily sales entries. Visits, km and litres come from MBOS and punch times from attendance; all stay editable."),
      s("salesPerf", "sales-performance", "Sales performance", "A daily score out of 100 from nine components against each salesman’s targets.", "perf"),
      s("staffPerf", "staff-performance", "Staff performance", "Monthly working hours, punctuality, tasks, to-dos and buddy tasks."),
      s("eom", "employee-of-the-month", "Employee of the month", "Everyone at the Employee of the Month mark or above overall."),
      s("points", "performance-points", "Performance points", "Counts and points for a period, with the review form and PDF report."),
    ],
  },
  {
    id: "sales",
    label: "Sales desk",
    icon: "phone",
    screens: [
      s("customers", "customers", "Customers", "Customers by status, with their calls and sales activity inside each record."),
      s("calling", "calling", "Calling", "Your area-wise calling list. Log each call; a second status is asked when the call is not picked up."),
      s("activity", "sales-activity", "Sales activity", "Meetings and calls by salesmen, with time given per area."),
      s("journey", "journey-planner", "Journey planner", "Where each salesman plans to be, by date.", "calendar"),
    ],
  },
  {
    id: "emp",
    label: "Employees",
    icon: "people",
    screens: [
      s("employees", "employees", "Employees", "The directory, by status. Your own record is your profile."),
      s("idCards", "id-cards", "ID cards", "Every employee’s ID card image."),
      s("org", "org", "Org chart", "Who reports to whom.", "custom"),
    ],
  },
  {
    id: "office",
    label: "Offices & timings",
    icon: "building",
    screens: [
      s("offices", "offices", "Offices", "Where people check in: the map pin, the radius and the opening hours."),
      s("timings", "staff-timings", "Staff timings", "Each person’s in and out time per weekday."),
    ],
  },
  {
    id: "assets",
    label: "Assets",
    icon: "box",
    screens: [
      s("assetStock", "asset-stock", "Asset stock", "What the company owns and how much is still in stock."),
      s("assignments", "asset-assignments", "Asset assignments", "Who holds what, and what has come back."),
    ],
  },
  {
    id: "help",
    label: "Help & grievance",
    icon: "help",
    screens: [
      s("help", "help-requests", "Help requests", "Attendance issues and other help. Admin approves; app problems go to MahekOne Tell us."),
      s("grievances", "grievances", "Grievances", "Raised to the CEO, HR, the company or a named person, and closed with a solution."),
    ],
  },
  { id: "docs", label: "Documents", icon: "doc", screens: [s("documents", "documents", "Documents", "Policies, forms and videos. You see what is tagged to you.")] },
  { id: "notif", label: "Notifications", icon: "bell", screens: [s("notifications", "notifications", "Notifications", "Messages you sent and received. Received ones also arrive in the MahekOne bell.", "list", { bottom: true })] },
  {
    id: "settings",
    label: "Settings",
    icon: "gear",
    screens: [
      s("settings", "settings", "HRMS settings", "", "custom"),
      s("refLists", "reference-lists", "Reference lists", "The value lists every form picks from."),
    ],
  },
];

export const HRMS_SCREENS: HrmsScreen[] = HRMS_GROUPS.flatMap((g) => g.screens);

export function hrmsScreen(key: string): HrmsScreen | undefined {
  return HRMS_SCREENS.find((x) => x.key === key);
}

export function hrmsScreenBySlug(slug: string): HrmsScreen | undefined {
  return HRMS_SCREENS.find((x) => x.slug === slug);
}

export function hrmsHref(screen: HrmsScreen | string): string {
  const sc = typeof screen === "string" ? hrmsScreen(screen) : screen;
  if (!sc) return "/hrms";
  return sc.slug ? `/hrms/${sc.slug}` : "/hrms";
}

/** A link to a screen by key, opening a record or pre-filtering. */
export function hrmsLink(key: string, query: Record<string, string | null | undefined> = {}): string {
  const base = hrmsHref(key);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Screens every HRMS user reaches whatever they were narrowed to: checking in
 * is the reason almost everybody holds the app at all.
 */
export const HRMS_ALWAYS_OPEN = new Set(["home"]);
