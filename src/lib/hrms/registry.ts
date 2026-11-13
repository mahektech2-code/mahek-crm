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

import type { HrmsPower } from "./powers";

export type HrmsIcon =
  | "clock" | "check" | "cal" | "file" | "wallet" | "receipt" | "list" | "chart"
  | "phone" | "people" | "building" | "box" | "help" | "doc" | "bell" | "gear";

/** How a list is drawn: the generic list, or one of the design's other views above it. */
export type HrmsView = "list" | "home" | "calendar" | "chart" | "perf" | "custom";

/**
 * WHO A SCREEN OR TAB IS FOR. HRMS gives a person one of three roles — the
 * level on their HRMS grant: an ASSOCIATE sees their own days, leave, pay and
 * score; a MANAGER sees their team (the org chart) and decides its leave; the
 * HR TEAM (the admin level) sees everybody and runs pay and settings. A gate
 * opens at its `min` level or above, or for somebody GRANTED one of its
 * `powers` on the Access screen — an associate given the HR power is HR's
 * hands whatever their level.
 */
export type HrmsGate = { min?: "manager" | "admin"; powers?: HrmsPower[] };

export type HrmsTab = HrmsGate & {
  /** The server module key that draws this tab. Never renamed — links and stored landings name it. */
  key: string;
  label: string;
  /** The sentence under the title while this tab is open. */
  sub: string;
  view: HrmsView;
  /** A tab behind a setting that is off in the source (Overtime). */
  flag?: "ot";
};

export type HrmsScreen = HrmsGate & {
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

const MANAGER = { min: "manager" } as const;
const hr = (...powers: HrmsPower[]): HrmsGate => ({ min: "admin", powers });

/*
 * THE SIMPLIFIED HRMS (Nov 2026). Checking in left for the MahekOne launcher,
 * and Tasks, My tasks, the Sales desk and the daily sales entries were taken
 * out at the client's request. Their server modules are still in
 * `screens/` — the data behind them is kept — but no screen draws them and
 * `hrmsContext` opens none of their keys, so nothing can act on them either.
 */
export const HRMS_GROUPS: HrmsGroup[] = [
  { id: "home", label: "Home", icon: "chart", screens: [s("home", "", "Home", "chart", "", { view: "home", bottom: true })] },
  {
    id: "time",
    label: "Time",
    icon: "clock",
    screens: [
      s("attendance", "attendance", "Attendance", "check", "", {
        views: [
          t("attendance", "Days", "Every check-in and check-out, newest first."),
          t("pendingOut", "Not checked out", "Days with a check-in and no check-out. An open day holds up that month’s salary."),
          t("absentees", "Absent", "People with no attendance on the day who are not on leave or a holiday.", "list", MANAGER),
          t("attChart", "Chart", "People present each day, with the trend.", "chart", MANAGER),
          t("monthly", "Monthly summary", "Per person per month. Days nobody can account for are cleared before salaries.", "list", hr("hr", "payroll", "editAtt")),
          t("overtime", "Overtime", "Time worked beyond the shortest overtime.", "list", { flag: "ot", ...MANAGER }),
        ],
      }),
      s("leave", "leave", "Leave & holidays", "cal", "", {
        bottom: true,
        nav: "Leave",
        short: "Leave",
        views: [
          t("leave", "Requests", "Leave and half-day requests."),
          t("approvals", "To decide", "Requests waiting for a decision. Approving sets how many of the days are paid.", "list", { ...MANAGER, powers: ["approveLeave"] }),
          t("leaveCal", "Calendar", "Approved in green, waiting in amber, with the month’s holidays.", "calendar"),
          t("holidays", "Holidays", "Festivals, national days and closures, and who each applies to."),
          t("leaveSetup", "Balances", "Paid leave credited to each person each month — on the 1st, or by hand.", "list", hr("hr", "entitle")),
        ],
      }),
    ],
  },
  {
    id: "results",
    label: "Pay & results",
    icon: "wallet",
    screens: [
      s("payroll", "pay", "Pay", "wallet", "", {
        views: [
          t("payroll", "Salaries", "Salaries by month. Everyone sees their own payslips once paid."),
          t("expenses", "Expenses", "Claims and payments, with the month’s balance."),
          t("advances", "Advances", "Salary advances, and how much is still to be recovered."),
        ],
      }),
      /* The screen key is still `kpi`, because it is a grant: the daily sales
         entries it opened on are gone, and the screen opens on the month. */
      s("kpi", "performance", "Performance", "chart", "", {
        views: [
          t("staffPerf", "Monthly score", "Each month’s working hours and punctuality."),
          t("eom", "Employee of the month", "Everyone at the Employee of the Month mark or above."),
          t("points", "Period review", "Points for any period, with the review questions and a PDF report.", "list", hr("perfAdmin")),
        ],
      }),
    ],
  },
  {
    id: "company",
    label: "Company",
    icon: "people",
    screens: [
      s("employees", "people", "People", "people", "", {
        views: [
          t("employees", "Directory", "Everyone, by status. Your own record is your profile."),
          t("idCards", "ID cards", "Every person’s ID card.", "list", hr("hr")),
          t("timings", "Working hours", "Each person’s start and finish time for every day of the week.", "list", hr("hr", "timings")),
        ],
      }),
      /* Its own screen, not a tab of People: moving a reporting line moves
         who the CRM names as an account's sales manager. */
      s("org", "org", "Org chart", "people", "Who reports to whom.", { view: "custom" }),
      s("offices", "offices", "Offices", "building", "Where people check in: the map pin, how close they must be, and the opening hours.", hr("hr")),
      s("assetStock", "assets", "Assets", "box", "", {
        views: [
          /* Stock is HR's; everybody else opens on what is with people. */
          t("assetStock", "Stock", "What the company owns, and how much of each is still in stock.", "list", hr("hr")),
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
          t("help", "Help requests", "Attendance corrections and other help."),
          t("grievances", "Grievances", "Raised to the CEO, HR, the company or a named person, and closed with an answer."),
        ],
      }),
      s("documents", "documents", "Documents", "doc", "Policies, forms and videos meant for you."),
      s("notifications", "announcements", "Announcements", "bell", "Messages to one person or to everyone. Each also arrives in the bell.", { bottom: true, short: "Notices" }),
      s("feedback", "feedback", "Feedback", "help", "What you sent in with the Feedback button, and the replies.", { view: "custom" }),
    ],
  },
  {
    id: "settings",
    label: "Admin",
    icon: "gear",
    screens: [
      s("settings", "settings", "Settings", "gear", "", {
        ...hr("admin"),
        views: [
          t("settings", "Rules", "The rules HRMS runs on, and who changes them.", "custom"),
          t("roles", "Roles", "What each of the three HRMS roles sees and decides.", "custom"),
          t("refLists", "Pick lists", "The values every form picks from."),
        ],
      }),
    ],
  },
];

/**
 * THE THREE ROLES, as people read them. The role is the level on the HRMS
 * grant, given on Admin Console → Access; nothing here grants anything.
 */
export const HRMS_ROLES: { level: "associate" | "manager" | "admin"; name: string; sees: string; decides: string }[] = [
  { level: "associate", name: "Associate", sees: "Their own days, leave, pay, score, assets and requests", decides: "Nothing; asks for leave, help and corrections" },
  { level: "manager", name: "Manager", sees: "Their team, from the org chart, as well as their own", decides: "Their team's leave, help requests and expense claims; marks and checks out their team" },
  { level: "admin", name: "HR team", sees: "Everybody", decides: "Everything: leave, salaries, people, offices, assets, settings" },
];

/** Is a gate open for this level and these GRANTED powers. */
export function gateOpen(g: HrmsGate, level: "associate" | "manager" | "admin" | null, granted: ReadonlySet<string>): boolean {
  if (!g.min) return true;
  const rank = { associate: 0, manager: 1, admin: 2 } as const;
  if (level && rank[level] >= rank[g.min]) return true;
  return (g.powers ?? []).some((p) => granted.has(p));
}

/** The lists a screen draws: its tabs' keys, or its own key when it has none. */
export function hrmsListKeys(screen: HrmsScreen): string[] {
  return screen.views ? screen.views.map((v) => v.key) : [screen.key];
}

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
 * Screens every HRMS user reaches whatever they were narrowed to: Home, and
 * the replies to what they sent in.
 */
export const HRMS_ALWAYS_OPEN = new Set(["home", "feedback"]);

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
  checklists: "home",
  "to-dos": "home",
  "buddy-tasks": "home",
  "task-templates": "home",
  kpi: "staffPerf",
  "sales-performance": "home",
  "staff-performance": "staffPerf",
  "employee-of-the-month": "eom",
  "performance-points": "points",
  customers: "home",
  calling: "home",
  "sales-activity": "home",
  "journey-planner": "home",
  employees: "employees",
  "id-cards": "idCards",
  "staff-timings": "timings",
  "asset-stock": "assetStock",
  "asset-assignments": "assignments",
  "help-requests": "help",
  grievances: "grievances",
  notifications: "notifications",
  "reference-lists": "refLists",
  /* Removed in the simplification: they land on Home rather than a 404. */
  tasks: "home",
  "my-tasks": "home",
  "sales-desk": "home",
};
