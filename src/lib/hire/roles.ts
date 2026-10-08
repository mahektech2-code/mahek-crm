/* ---------------------------------------------------------------------------
 * WHO MAY DO WHAT IN HIRE (spec §8). PURE and client-safe — the screens draw
 * locked controls with the role that would unlock them, and the actions check
 * the same table on the server.
 *
 * MahekOne grants an app at a LEVEL (associate / manager / admin). Hiring has
 * six jobs, not three, so the job is a `hire_user_roles` row, set where every
 * other grant is set: the Admin Console's People → Access screen, under Hire. With no row the level decides, narrowly: an admin of Hire is
 * Admin, a manager is a Hiring Manager, an associate is an Interviewer — the
 * least anybody can be given, because an interviewer sees only who they are
 * interviewing.
 * ------------------------------------------------------------------------- */

export const HIRE_ROLES = ["recruiter", "interviewer", "hiring_manager", "onboarding", "hr_head", "admin"] as const;
export type HireRole = (typeof HIRE_ROLES)[number];

export const ROLE_LABEL: Record<HireRole, string> = {
  recruiter: "Recruiter",
  interviewer: "Interviewer",
  hiring_manager: "Hiring Manager",
  onboarding: "Onboarding Coordinator",
  hr_head: "HR Head",
  admin: "Admin",
};

export const HIRE_CAPS = [
  "interview",
  "score",
  "grace",
  "override",
  "decide",
  "confirmReject",
  "offer",
  "provision",
  "unmask",
  "proposeBp",
  "editBp",
  "publish",
  "bias",
  "export",
  "auditAll",
  "addCandidate",
  "message",
  "documents",
  "onboard",
] as const;
export type HireCap = (typeof HIRE_CAPS)[number];

const ALL: HireCap[] = [...HIRE_CAPS];

export const ROLE_CAPS: Record<HireRole, readonly HireCap[]> = {
  recruiter: ["interview", "score", "grace", "confirmReject", "addCandidate", "message", "documents"],
  interviewer: ["interview", "score", "grace"],
  hiring_manager: ["interview", "score", "grace", "override", "decide", "confirmReject", "offer", "proposeBp", "addCandidate", "message"],
  onboarding: ["unmask", "offer", "provision", "documents", "onboard", "message"],
  hr_head: ALL,
  admin: ALL,
};

export function can(role: HireRole, cap: HireCap): boolean {
  return ROLE_CAPS[role].includes(cap);
}

/** "Hiring Manager, HR Head or Admin" — for a locked control's tooltip. */
export function whoCan(cap: HireCap): string {
  const names = HIRE_ROLES.filter((r) => ROLE_CAPS[r].includes(cap)).map((r) => ROLE_LABEL[r]);
  if (names.length <= 1) return names[0] ?? "nobody";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

export const lockedWhy = (cap: HireCap) => `Needs ${whoCan(cap)}.`;

/* ------------------------------------------------------------- navigation */

export type HireNavKey =
  | "board" | "candidates" | "calendar" | "tasks"
  | "interviews" | "review" | "decisions" | "compare"
  | "offers" | "documents" | "induction" | "provision"
  | "blueprints" | "questions" | "library"
  | "funnel" | "quality" | "fairness" | "calibrate" | "aiusage"
  | "pool" | "search";

export type HireNavIcon =
  | "board" | "people" | "cal" | "check" | "mic" | "list" | "gavel" | "cols" | "doc" | "shield" | "box" | "key"
  | "layers" | "help" | "book" | "funnel" | "chart" | "scale" | "sliders" | "cpu" | "star" | "search";

export type HireNavGroup = { label: string; items: { key: HireNavKey; label: string; href: string; icon: HireNavIcon }[] };

export const HIRE_NAV: HireNavGroup[] = [
  {
    label: "Pipeline",
    items: [
      { key: "board", label: "Board", href: "/hire", icon: "board" },
      { key: "candidates", label: "Candidates", href: "/hire/candidates", icon: "people" },
      { key: "calendar", label: "Calendar", href: "/hire/calendar", icon: "cal" },
      { key: "tasks", label: "Tasks", href: "/hire/tasks", icon: "check" },
    ],
  },
  {
    label: "Evaluate",
    items: [
      { key: "interviews", label: "Interviews", href: "/hire/interviews", icon: "mic" },
      { key: "review", label: "To review", href: "/hire/review", icon: "list" },
      { key: "decisions", label: "Decisions", href: "/hire/decisions", icon: "gavel" },
      { key: "compare", label: "Compare", href: "/hire/compare", icon: "cols" },
    ],
  },
  {
    label: "Onboard",
    items: [
      { key: "offers", label: "Offers", href: "/hire/offers", icon: "doc" },
      { key: "documents", label: "Documents", href: "/hire/documents", icon: "shield" },
      { key: "induction", label: "Induction", href: "/hire/induction", icon: "box" },
      { key: "provision", label: "Provision", href: "/hire/provision", icon: "key" },
    ],
  },
  {
    label: "Roles",
    items: [
      { key: "blueprints", label: "Blueprints", href: "/hire/blueprints", icon: "layers" },
      { key: "questions", label: "Questions", href: "/hire/questions", icon: "help" },
      { key: "library", label: "Library", href: "/hire/library", icon: "book" },
    ],
  },
  {
    label: "Insights",
    items: [
      { key: "funnel", label: "Funnel", href: "/hire/insights/funnel", icon: "funnel" },
      { key: "quality", label: "Quality", href: "/hire/insights/quality", icon: "chart" },
      { key: "fairness", label: "Fairness", href: "/hire/insights/fairness", icon: "scale" },
      { key: "calibrate", label: "Calibrate", href: "/hire/insights/calibrate", icon: "sliders" },
      { key: "aiusage", label: "AI usage", href: "/hire/insights/ai-usage", icon: "cpu" },
    ],
  },
  {
    label: "Talent",
    items: [
      { key: "pool", label: "Pool", href: "/hire/pool", icon: "star" },
      { key: "search", label: "Search", href: "/hire/search", icon: "search" },
    ],
  },
];

/** Which nav groups each role sees (design: an interviewer sees Pipeline and Evaluate only). */
export const ROLE_GROUPS: Record<HireRole, readonly string[]> = {
  recruiter: ["Pipeline", "Evaluate", "Onboard", "Talent"],
  interviewer: ["Pipeline", "Evaluate"],
  hiring_manager: ["Pipeline", "Evaluate", "Onboard", "Roles", "Talent"],
  onboarding: ["Pipeline", "Onboard"],
  hr_head: ["Pipeline", "Evaluate", "Onboard", "Roles", "Insights", "Talent"],
  admin: ["Pipeline", "Evaluate", "Onboard", "Roles", "Insights", "Talent"],
};

/** Screens inside a group a role holds, but not for them. */
const HIDDEN: Partial<Record<HireRole, HireNavKey[]>> = {
  /* Decisions and Compare show scores across stages; an interviewer sees none. */
  interviewer: ["decisions", "compare"],
};

export function navFor(role: HireRole): HireNavGroup[] {
  const groups = ROLE_GROUPS[role];
  const hidden = new Set(HIDDEN[role] ?? []);
  return HIRE_NAV.filter((g) => groups.includes(g.label)).map((g) => ({ ...g, items: g.items.filter((i) => !hidden.has(i.key)) }));
}

export function holdsScreen(role: HireRole, key: HireNavKey): boolean {
  return navFor(role).some((g) => g.items.some((i) => i.key === key));
}

/** The decision point every gate decision is filed under. */
export const GATE_POINT = "decision_gate";

/**
 * The MahekOne app level a Hire role is held at. The Access screen sets it
 * when a role is picked, the way an ERP designation sets the ERP's level.
 */
export const LEVEL_FOR_ROLE: Record<HireRole, "associate" | "manager" | "admin"> = {
  recruiter: "associate",
  interviewer: "associate",
  onboarding: "associate",
  hiring_manager: "manager",
  hr_head: "manager",
  admin: "admin",
};

/** The role somebody has with no `hire_user_roles` row: the level decides, narrowly. */
export function defaultRoleFor(level: string | null | undefined): HireRole {
  return level === "admin" ? "admin" : level === "manager" ? "hiring_manager" : "interviewer";
}

/** One line per role, for the Access screen. */
export const ROLE_SENTENCE: Record<HireRole, string> = {
  recruiter: "Moves their own requisitions through; confirms rejections; never sees unmasked PII.",
  interviewer: "Sees only the candidates assigned to them, and only the stage they are conducting — never earlier scores.",
  hiring_manager: "Decides at the gate, overrides an entry rule with a reason, issues offers, proposes blueprints.",
  onboarding: "Documents, offers, induction and provisioning; may unmask PII, and every unmask is logged.",
  hr_head: "Everything, including publishing blueprints, fairness analytics and exports.",
  admin: "Everything.",
};
