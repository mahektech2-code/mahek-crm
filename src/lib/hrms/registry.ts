/* ---------------------------------------------------------------------------
 * The HRMS's screens, grouped the way its sidebar draws them. ONE LIST for
 * three readers: the sidebar, the module guard (via `lib/modules.ts`) and the
 * Access screen. Module key = `hrms.<key>`.
 *
 * A SCREEN IS A JOB, AND ITS LISTS ARE TABS. The first build copied Mahek EMP
 * 2.0 one AppSheet view at a time, so one table drawn three ways — leave
 * requests, the approvals queue and the leave calendar — was three sidebar
 * entries, three modules and three grants, with the same five actions on each.
 * It had 41 screens. A tab is that list again, reached from its screen rather
 * than the sidebar: it keeps its own server module (its rows, its actions,
 * its forms) under its own key, and it is opened by holding the SCREEN. It is
 * never a module of its own, so it can never be granted apart from it — the
 * same rule the ERP's tabs follow (`lib/erp/registry.ts`).
 *
 * The keys did not change. Every tab is drawn by the module that drew the old
 * screen, so every action, notification link and stored landing that names
 * `approvals` or `pendingOut` still resolves — `hrmsPlace` turns a key into
 * the screen and tab it now lives on. `feature-ledger.ts` records where every
 * one of the old screens' actions went, and its test fails the build if one
 * goes missing.
 *
 * Every function has ONE screen (PRD §3.2): what a person sees on it is their
 * scope, never a second copy of the screen.
 *
 * PURE and client-safe.
 * ------------------------------------------------------------------------- */

export type HrmsIcon =
  | "clock" | "check" | "cal" | "file" | "wallet" | "receipt" | "list" | "chart"
  | "phone" | "people" | "building" | "box" | "help" | "doc" | "bell" | "gear";

/** How a list is drawn: the generic list, or one of the design's other views above it. */
export type HrmsView = "list" | "home" | "calendar" | "chart" | "perf" | "custom";

/** A TAB of a screen: a list of its own, opened by holding the screen. */
export type HrmsTab = {
  /** The server module key that draws this tab. Never renamed — links and stored landings name it. */
  key: string;
  label: string;
  /** The sentence under the title while this tab is open. */
  sub: string;
  view: HrmsView;
  /** A tab behind a setting that is off in the source (Overtime). */
  flag?: "ot";
};

export type HrmsScreen = {
  /** Stable key; the module key is `hrms.<key>`. Never renamed — it is a grant. */
  key: string;
  /** URL segment under /hrms. Home is the app root. */
  slug: string;
  label: string;
  icon: HrmsIcon;
  /** The sentence under the title, for a screen with no tabs. */
  sub: string;
  view: HrmsView;
  /** Drawn on phones in the bottom bar. */
  bottom?: boolean;
  /** The sidebar's word, where the title does not fit beside a badge. */
  nav?: string;
  /** The bottom bar's word: a phone gives each item a fifth of its width. */
  short?: string;
  /** Tabs, the first being what the screen opens on. Absent: the screen is one list, its own key. */
  views?: HrmsTab[];
};

export type HrmsGroup = { id: string; label: string; icon: HrmsIcon; screens: HrmsScreen[] };

const s = (key: string, slug: string, label: string, icon: HrmsIcon, sub: string, extra: Partial<HrmsScreen> = {}): HrmsScreen => ({
  key,
  slug,
  label,
  icon,
  sub,
  view: "list",
  ...extra,
});

const t = (key: string, label: string, sub: string, view: HrmsView = "list", extra: Partial<HrmsTab> = {}): HrmsTab => ({ key, label, sub, view, ...extra });

export const HRMS_GROUPS: HrmsGroup[] = [
  { id: "home", label: "Check in", icon: "clock", screens: [s("home", "", "Check in", "clock", "", { view: "home", bottom: true })] },
  {
    id: "day",
    label: "My work",
    icon: "check",
    screens: [
      s("attendance", "attendance", "Attendance", "check", "", {
        views: [
          t("attendance", "Register", "Every check-in and check-out, newest first. Heads see their team; HR and admin see everyone."),
          t("pendingOut", "Not checked out", "Days with a check-in and no check-out. A day left open holds up that month’s salary."),
          t("absentees", "Absent", "Active people with no attendance on the day, who are not on leave or on a holiday that applies to them."),
          t("monthly", "Monthly summary", "Per person per month. Days nobody can account for must be cleared before that month’s salary."),
          t("attChart", "Chart", "People present each day, with the trend. Pick a row to open that person’s days.", "chart"),
          t("overtime", "Overtime", "One record per person per day, for time worked beyond the shortest overtime.", "list", { flag: "ot" }),
        ],
      }),
      s("leave", "leave", "Leave & holidays", "cal", "", {
        bottom: true,
        nav: "Leave",
        short: "Leave",
        views: [
          t("leave", "Requests", "Every leave and half-day request. You see your own; HR and admin see everyone’s."),
          t("approvals", "To decide", "Requests waiting for a decision, by person. Approving sets how many of the days are paid."),
          t("leaveCal", "Calendar", "One bar per request — approved in green, waiting in amber — with the month’s holidays.", "calendar"),
          t("holidays", "Holidays", "Weekly offs, festivals, national and weather closures, and who each one applies to."),
          t("leaveSetup", "Monthly credits", "Paid leave credited to each person each month — automatically on the 1st, or by hand."),
        ],
      }),
      s("checklist", "tasks", "Tasks", "list", "", {
        bottom: true,
        views: [
          t("checklist", "Checklist", "Today’s tasks, what is still open this week, and every checklist before."),
          t("todos", "To-dos", "Work given to you and by you. Whoever gave it checks it once it is done."),
          t("buddy", "Buddy tasks", "One of today’s tasks handed to a colleague, who accepts it and marks it done."),
          t("templates", "Templates", "Your daily, weekly and monthly tasks. Take my task copies today’s into your checklist."),
        ],
      }),
      s("payroll", "pay", "Pay", "wallet", "", {
        views: [
          t("payroll", "Salaries", "Salaries prepared, approved and paid, by month. Everyone sees their own payslips once paid."),
          t("advances", "Advances", "Salary advances, and how much of each is still to be recovered."),
          t("expenses", "Expenses", "Claims and payments per person, with the month’s balance and the running balance."),
        ],
      }),
    ],
  },
  {
    id: "perf",
    label: "Results",
    icon: "chart",
    screens: [
      s("kpi", "performance", "Performance", "chart", "", {
        views: [
          t("kpi", "Daily sales entries", "Each salesman’s day: visits, km, litres, sales and outstanding. Visits are filled in from the field app."),
          t("salesPerf", "Sales score", "A daily score out of 100, from nine parts measured against each salesman’s targets.", "perf"),
          t("staffPerf", "Staff month", "Each month’s working hours, punctuality, tasks, to-dos and buddy tasks."),
          t("eom", "Employee of the month", "Everyone at the Employee of the Month mark or above, overall."),
          t("points", "Period review", "Points for any period, with the review questions and a PDF report."),
        ],
      }),
      s("customers", "sales-desk", "Sales desk", "phone", "", {
        views: [
          t("customers", "Customers", "Customers by status, with how often they have been called and visited."),
          t("calling", "Calling", "Your area’s calling list. Log each call; if nobody picks up you are asked what happens next."),
          t("activity", "Sales activity", "Meetings and calls by salesmen, with the time given to each area."),
          t("journey", "Journey planner", "Where each salesman plans to be, by date.", "calendar"),
        ],
      }),
    ],
  },
  {
    id: "team",
    label: "Company",
    icon: "people",
    screens: [
      s("employees", "people", "People", "people", "", {
        views: [
          t("employees", "Directory", "Everyone, by status. Your own record is your profile."),
          t("idCards", "ID cards", "Every person’s ID card."),
          t("timings", "Working hours", "Each person’s start and finish time for every day of the week."),
        ],
      }),
      /* Its own screen, not a tab of People: moving a reporting line moves
         who the CRM names as an account's sales manager, which is a grant
         somebody may be given without the directory's addresses, or the
         directory without it. */
      s("org", "org", "Org chart", "people", "Who reports to whom.", { view: "custom" }),
      s("offices", "offices", "Offices", "building", "Where people check in: the map pin, how close they must be, and the opening hours."),
      s("assetStock", "assets", "Assets", "box", "", {
        views: [
          t("assetStock", "Stock", "What the company owns, and how much of each is still in stock."),
          t("assignments", "With people", "Who holds what, and what has come back."),
        ],
      }),
    ],
  },
  {
    id: "talk",
    label: "Messages",
    icon: "bell",
    screens: [
      s("help", "requests", "Help & grievances", "help", "", {
        views: [
          t("help", "Help requests", "Attendance corrections and other help. Problems with the app itself go to Tell us at the top."),
          t("grievances", "Grievances", "Raised to the CEO, HR, the company or a named person, and closed with an answer."),
        ],
      }),
      s("documents", "documents", "Documents", "doc", "Policies, forms and videos. You see what is meant for you."),
      s("notifications", "announcements", "Announcements", "bell", "Messages sent to one person or to everyone. Each one also arrives in the bell.", { bottom: true, short: "Notices" }),
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: "gear",
    screens: [
      s("settings", "settings", "Settings", "gear", "", {
        views: [
          t("settings", "Rules", "The rules HRMS runs on, and who changes them.", "custom"),
          t("refLists", "Pick lists", "The values every form picks from."),
        ],
      }),
    ],
  },
];

export const HRMS_SCREENS: HrmsScreen[] = HRMS_GROUPS.flatMap((g) => g.screens);

/** Every list a module draws: each screen's tabs, or the screen itself. */
export const HRMS_TABS: { screen: HrmsScreen; tab: HrmsTab }[] = HRMS_SCREENS.flatMap((sc) =>
  sc.views ? sc.views.map((tab) => ({ screen: sc, tab })) : [{ screen: sc, tab: { key: sc.key, label: sc.label, sub: sc.sub, view: sc.view } }],
);

/**
 * Where a module key is drawn: the screen it is on, and the tab (null when it
 * is the screen's first tab or the screen has none). Every link goes through
 * this, so a notification sent last month naming `approvals` lands on Leave &
 * holidays · To decide rather than on a page that no longer exists.
 */
export function hrmsPlace(key: string): { screen: HrmsScreen; tab: HrmsTab; view: string | null } | undefined {
  const hit = HRMS_TABS.find((x) => x.tab.key === key);
  if (!hit) return undefined;
  const first = hit.screen.views?.[0]?.key;
  return { screen: hit.screen, tab: hit.tab, view: first && first !== key ? key : null };
}

/** The screen a key is drawn on — its own, or the one it is a tab of. */
export function hrmsScreen(key: string): HrmsScreen | undefined {
  return hrmsPlace(key)?.screen;
}

export function hrmsScreenBySlug(slug: string): HrmsScreen | undefined {
  return HRMS_SCREENS.find((x) => x.slug === slug);
}

export function hrmsHref(screen: HrmsScreen | string): string {
  if (typeof screen === "string") return hrmsLink(screen);
  return screen.slug ? `/hrms/${screen.slug}` : "/hrms";
}

/** A link to a list by its key, opening a record or pre-filtering. */
export function hrmsLink(key: string, query: Record<string, string | null | undefined> = {}): string {
  const place = hrmsPlace(key);
  if (!place) return "/hrms";
  const base = place.screen.slug ? `/hrms/${place.screen.slug}` : "/hrms";
  const q = new URLSearchParams();
  if (place.view) q.set("view", place.view);
  for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

/** What a list is called wherever it is named on its own: "Leave & holidays · To decide". */
export function hrmsListLabel(key: string): string {
  const place = hrmsPlace(key);
  if (!place) return key;
  return place.screen.views ? `${place.screen.label} · ${place.tab.label}` : place.screen.label;
}

/** Every module key a screen's holder may use: its own and its tabs'. */
export function hrmsKeysOf(screen: HrmsScreen): string[] {
  return [...new Set([screen.key, ...(screen.views ?? []).map((x) => x.key)])];
}

/**
 * Screens every HRMS user reaches whatever they were narrowed to: checking in
 * is the reason almost everybody holds the app at all.
 */
export const HRMS_ALWAYS_OPEN = new Set(["home"]);

/**
 * The first build's URLs, and the list each now lives on. `next.config.ts`
 * redirects through it: a slug lives in bookmarks and in notifications long
 * after it has changed in the code.
 */
export const HRMS_RETIRED_SLUGS: Record<string, string> = {
  "pending-check-outs": "pendingOut",
  absentees: "absentees",
  "attendance-chart": "attChart",
  "leave-approvals": "approvals",
  "leave-calendar": "leaveCal",
  "leave-setup": "leaveSetup",
  holidays: "holidays",
  overtime: "overtime",
  "monthly-reports": "monthly",
  payroll: "payroll",
  advances: "advances",
  expenses: "expenses",
  checklists: "checklist",
  "to-dos": "todos",
  "buddy-tasks": "buddy",
  "task-templates": "templates",
  kpi: "kpi",
  "sales-performance": "salesPerf",
  "staff-performance": "staffPerf",
  "employee-of-the-month": "eom",
  "performance-points": "points",
  customers: "customers",
  calling: "calling",
  "sales-activity": "activity",
  "journey-planner": "journey",
  employees: "employees",
  "id-cards": "idCards",
  "staff-timings": "timings",
  "asset-stock": "assetStock",
  "asset-assignments": "assignments",
  "help-requests": "help",
  grievances: "grievances",
  notifications: "notifications",
  "reference-lists": "refLists",
};
