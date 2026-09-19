import type { AppModule } from "@/lib/modules";

/* ---------------------------------------------------------------------------
 * The Lead Management workspace, in one list, for BOTH apps that mount it.
 *
 * TEN modules in the sidebar and thirty-four screens behind them, which is
 * only a contradiction until you look at where the line is drawn: a MODULE is
 * a destination that can be GRANTED, a TAB is a destination inside one that
 * cannot. `lib/modules.ts` owns the first half and this file owns the second,
 * and the two are pinned together by `lead-workspace.test.ts` — every entry
 * here names a real module in every workspace, and every `*.lead*` module
 * appears here exactly once. A tab with no module is a screen nobody can be
 * refused; a module with no entry here is a screen nobody can find.
 *
 * **IT IS MOUNTED TWICE AND WRITTEN ONCE.** The Manager Console built this for
 * managers; the telecallers work the same funnel from the same book, by phone
 * rather than on foot, and they are redirected out of `/sales` by its own
 * layout — so the workspace had to reach them where they already are. The
 * alternative was a second lead system inside the CRM, which is twenty
 * thousand lines of the same rules drifting from these, and this codebase has
 * a paragraph about that outcome on nearly every page.
 *
 * So a PATH here is relative and a WORKSPACE turns it into a route. Nothing in
 * the screens spells an app's own segment any more; `useLeadWorkspace()` is
 * what a client component reads and a page hands its own literal down, because
 * a page already knows which app it is.
 *
 * What is NOT parameterised is the authority. `lead.work` is held by any
 * associate — see `access-control.ts`, which says in as many words that a
 * funnel only a manager can advance is a funnel nobody updates — so the write
 * side needed no change at all to reach a second app. Reads narrow through
 * `resolveScope`, which reads the grant for the app named on the REQUEST, so
 * the same screen shows a telecaller their own book and a manager their team's
 * without either knowing the other exists.
 *
 * It is PURE and client-safe, like `lib/modules.ts` beside it, because the tab
 * strip is a client component and a second copy of this list typed into a
 * screen would drift inside one release — and the half that drifts is always
 * the half somebody is reading.
 *
 * `path` is what the guard matches and what the sidebar links to, so the FIRST
 * tab of every module is that module's own route rather than a child of it.
 * A module whose landing page redirected to its first tab would put a redirect
 * in front of every sidebar click, and the back button would never leave it.
 * ------------------------------------------------------------------------- */

/**
 * Which app is drawing the workspace.
 *
 * It is the app id rather than a base path, because it is also half of a
 * module key — `sales.leads` and `crm.leads` are different grants over the
 * same screens, and a base path could not say which to require.
 */
export type LeadWorkspace = "sales" | "crm";

export const LEAD_WORKSPACES: readonly LeadWorkspace[] = ["sales", "crm"];

/** Every workspace's own segment. One place, so a rename is one edit. */
const BASE: Record<LeadWorkspace, string> = {
  sales: "/sales",
  crm: "/crm",
};

export function leadBase(workspace: LeadWorkspace): string {
  return BASE[workspace];
}

/** `leadHref("crm", "leads/funnel")` → `/crm/leads/funnel`. */
export function leadHref(workspace: LeadWorkspace, path: string): string {
  return path ? `${BASE[workspace]}/${path}` : BASE[workspace];
}

export type LeadTab = {
  /** Relative to the workspace's own segment. Never starts with a slash. */
  path: string;
  label: string;
  /** Only where the route is the module's own root and would match every child. */
  exact?: boolean;
  /**
   * One line on what this tab answers, shown on hover. Not decoration: four of
   * these tabs are one question asked of four populations and the labels alone
   * do not separate them.
   */
  hint?: string;
};

export type LeadSection = {
  /**
   * The module SLUG, which the workspace turns into a stored key. A join —
   * never renamed.
   */
  slug: string;
  label: string;
  /** Where the sidebar points, which is always the first tab's path. */
  path: string;
  tabs: LeadTab[];
};

/** The stored module key for a section in a workspace. */
export function leadModuleKey(
  workspace: LeadWorkspace,
  section: LeadSection,
): AppModule["key"] {
  return `${workspace}.${section.slug}`;
}

export const LEAD_SECTIONS: readonly LeadSection[] = [
  {
    slug: "leads",
    label: "All Leads",
    path: "leads",
    tabs: [
      {
        path: "leads",
        label: "List",
        exact: true,
        hint: "Every lead, filterable, with its rung and what its gate is waiting on.",
      },
      {
        path: "leads/board",
        label: "Board",
        hint: "The same book as columns per rung — where a book is bunching.",
      },
      /*
       * §8.2's seven management blocks.
       *
       * A TAB AND NOT AN ELEVENTH MODULE, deliberately. A module is something
       * that can be GRANTED, and there is nothing here to grant: every figure
       * on it is a count of rows from Qualification, Samples and Commercial,
       * and the person who may see those counts is exactly the person who may
       * open those screens — which the grants already say, and which the
       * screen itself re-reads rather than assuming. A key of its own would be
       * a second answer to a question already answered, and the one that
       * drifts would be the one that widens.
       *
       * It sits under All Leads because it is a third view of the same book:
       * the List answers "which lead", the Board answers "where is the book
       * bunching", and this answers "what is waiting on somebody". It is NOT
       * the first tab, though a dashboard usually would be — `path` above is
       * what the sidebar points at and what `crm.leads`/`sales.leads` name as
       * their href, so leading with it would move the module's own landing
       * page and put a redirect in front of every sidebar click.
       */
      {
        path: "leads/dashboard",
        label: "Dashboard",
        hint: "Seven queues across the funnel — what is waiting on somebody, each opening the list behind it.",
      },
    ],
  },
  {
    slug: "lead-funnel",
    label: "Funnel & conversion",
    path: "leads/funnel",
    tabs: [
      {
        path: "leads/funnel",
        label: "Funnel",
        exact: true,
        hint: "The three ladders, counted per rung, with how long leads sit on each.",
      },
      {
        path: "leads/funnel/sources",
        label: "Sources",
        hint: "Where business comes from, and the spellings that are the same source.",
      },
      {
        path: "leads/funnel/reasons",
        label: "Reasons",
        hint: "The four coded lists, counted — what we win on and what we lose on.",
      },
    ],
  },
  {
    slug: "lead-intake",
    label: "Intake",
    path: "leads/intake",
    tabs: [
      {
        path: "leads/intake",
        label: "Capture a lead",
        exact: true,
        hint: "Raising a lead at a desk — the sales type is asked first, alone.",
      },
      {
        path: "leads/intake/bulk",
        label: "Bulk intake",
        hint: "A file of leads, validated and previewed before anything is written.",
      },
      {
        path: "leads/intake/duplicates",
        label: "Duplicates",
        hint: "Two leads for one shop — detected here, merged nowhere yet.",
      },
    ],
  },
  {
    slug: "lead-qualify",
    label: "Qualification",
    path: "leads/qualify",
    tabs: [
      {
        path: "leads/qualify",
        label: "Suspect decisions",
        exact: true,
        hint: "§4's visit cap. It asks for an answer; it never refuses the visit.",
      },
      {
        path: "leads/qualify/verification",
        label: "Verification queue",
        hint: "§7 — prospects waiting on a manager's call, ageing against the configured window.",
      },
      {
        path: "leads/qualify/validation",
        label: "Validation calls",
        hint: "§8's twelve answers, and where the shop and the report disagreed.",
      },
      {
        path: "leads/qualify/checklist",
        label: "Checklists",
        hint: "§28 — what each lead's gate is still missing, in words.",
      },
    ],
  },
  {
    slug: "samples",
    label: "Samples & trials",
    path: "samples",
    tabs: [
      {
        path: "samples",
        label: "All samples",
        exact: true,
        hint: "Every sample, in every state, with the three dates kept apart.",
      },
      {
        path: "samples/desk",
        label: "Desk",
        hint: "Approve, dispatch, confirm receipt, record the trial.",
      },
      {
        path: "samples/chases",
        label: "Review chases",
        hint: "§16 does not stop — the last interval repeats until there is an answer.",
      },
      {
        path: "samples/feedback",
        label: "Trial feedback",
        hint: "§16's seven answers across every trial, by product and by competitor.",
      },
    ],
  },
  {
    slug: "lead-commercial",
    label: "Commercial",
    path: "leads/commercial",
    tabs: [
      {
        path: "leads/commercial",
        label: "Negotiation",
        exact: true,
        hint: "Every lead at negotiation, and what is blocking each one.",
      },
      {
        path: "leads/commercial/commitments",
        label: "Commitments",
        hint: "Expected orders. A forecast — never added to a real order value.",
      },
      {
        path: "leads/commercial/first-orders",
        label: "First orders",
        hint: "The order that converts an account, through delivery and payment.",
      },
    ],
  },
  {
    slug: "lead-appointments",
    label: "Distributor appointments",
    path: "leads/appointments",
    tabs: [
      {
        path: "leads/appointments",
        label: "Appointments",
        exact: true,
        hint: "§12's two-step chain, and the named reason each one escalated.",
      },
    ],
  },
  {
    slug: "lead-actions",
    label: "Next actions & nurture",
    path: "leads/actions",
    tabs: [
      {
        path: "leads/actions",
        label: "Due",
        exact: true,
        hint: "What is owed on a lead today, and by whom.",
      },
      {
        path: "leads/actions/overdue",
        label: "Overdue",
        hint: "Past its day, with nobody having said anything since.",
      },
      {
        path: "leads/actions/none",
        label: "Nothing scheduled",
        hint: "§24 — an active lead with nothing owed by anybody is the state the rule exists to prevent.",
      },
      {
        path: "leads/actions/nurture",
        label: "Nurture",
        hint: "§13's fifteen rows, split by owner — the salesman and the lead manager are chased for different things.",
      },
      {
        path: "leads/actions/communication",
        label: "Communication",
        hint: "The eleven company-communication actions, across the book.",
      },
    ],
  },
  {
    slug: "lead-handovers",
    label: "Handovers",
    path: "leads/handovers",
    tabs: [
      {
        path: "leads/handovers",
        label: "Handovers",
        exact: true,
        hint: "§Q — converted, and still nobody named to run the relationship.",
      },
    ],
  },
  {
    slug: "lead-oversight",
    label: "Oversight",
    path: "leads/oversight",
    tabs: [
      {
        path: "leads/oversight",
        label: "Overrides",
        exact: true,
        hint: "Every shut gate somebody passed, what was missing, and the reason code.",
      },
      {
        path: "leads/oversight/audit",
        label: "Audit",
        hint: "The funnel's own audited writes, with the hat that authorised each.",
      },
      {
        path: "leads/oversight/settings",
        label: "Thresholds",
        hint: "The leads.* keys in force. Read-only — configuration is authored in the Admin Console.",
      },
    ],
  },
];

const BY_SLUG = new Map(LEAD_SECTIONS.map((s) => [s.slug, s]));

export function leadSection(slug: string): LeadSection | undefined {
  return BY_SLUG.get(slug);
}

/**
 * Which section a path is inside, within one workspace.
 *
 * Longest match wins, the same rule `moduleForPath` follows and for the same
 * reason: `/crm/leads/funnel/sources` is Funnel, not All Leads, although
 * `/crm/leads` is a prefix of it.
 *
 * It takes the workspace rather than sniffing it off the path, because a path
 * that belongs to neither would otherwise resolve to whichever workspace's
 * prefix happened to match first.
 */
export function sectionForPath(
  workspace: LeadWorkspace,
  path: string,
): LeadSection | undefined {
  let best: LeadSection | undefined;
  for (const s of LEAD_SECTIONS) {
    const href = leadHref(workspace, s.path);
    const hit = path === href || path.startsWith(href + "/");
    if (!hit) continue;
    if (!best || s.path.length > best.path.length) best = s;
  }
  return best;
}
