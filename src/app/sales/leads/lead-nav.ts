import type { AppModule } from "@/lib/modules";

/* ---------------------------------------------------------------------------
 * The Lead Management workspace, in one list.
 *
 * TEN modules in the sidebar and thirty-four screens behind them, which is
 * only a contradiction until you look at where the line is drawn: a MODULE is
 * a destination that can be GRANTED, a TAB is a destination inside one that
 * cannot. `lib/modules.ts` owns the first half and this file owns the second,
 * and the two are pinned together by `lead-nav.test.ts` — every entry here
 * names a real module, and every `sales.lead*` module appears here exactly
 * once. A tab with no module is a screen nobody can be refused; a module with
 * no entry here is a screen nobody can find.
 *
 * It is PURE and client-safe, like `lib/modules.ts` beside it, because the tab
 * strip is a client component and a second copy of this list typed into a
 * screen would drift inside one release — and the half that drifts is always
 * the half somebody is reading.
 *
 * `href` is what the guard matches and what the sidebar links to, so the FIRST
 * tab of every module is that module's own route rather than a child of it.
 * A module whose landing page redirected to its first tab would put a
 * redirect in front of every sidebar click, and the back button would never
 * leave it.
 * ------------------------------------------------------------------------- */

export type LeadTab = {
  href: string;
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
  /** The stored module key. A join — never renamed. */
  key: AppModule["key"];
  label: string;
  /** Where the sidebar points, which is always the first tab's href. */
  href: string;
  tabs: LeadTab[];
};

export const LEAD_SECTIONS: readonly LeadSection[] = [
  {
    key: "sales.leads",
    label: "All Leads",
    href: "/sales/leads",
    tabs: [
      {
        href: "/sales/leads",
        label: "List",
        exact: true,
        hint: "Every lead, filterable, with its rung and what its gate is waiting on.",
      },
      {
        href: "/sales/leads/board",
        label: "Board",
        hint: "The same book as columns per rung — where a book is bunching.",
      },
    ],
  },
  {
    key: "sales.lead-funnel",
    label: "Funnel & conversion",
    href: "/sales/leads/funnel",
    tabs: [
      {
        href: "/sales/leads/funnel",
        label: "Funnel",
        exact: true,
        hint: "The three ladders, counted per rung, with how long leads sit on each.",
      },
      {
        href: "/sales/leads/funnel/sources",
        label: "Sources",
        hint: "Where business comes from, and the spellings that are the same source.",
      },
      {
        href: "/sales/leads/funnel/reasons",
        label: "Reasons",
        hint: "The four coded lists, counted — what we win on and what we lose on.",
      },
    ],
  },
  {
    key: "sales.lead-intake",
    label: "Intake",
    href: "/sales/leads/intake",
    tabs: [
      {
        href: "/sales/leads/intake",
        label: "Capture a lead",
        exact: true,
        hint: "Raising a lead at a desk — the sales type is asked first, alone.",
      },
      {
        href: "/sales/leads/intake/bulk",
        label: "Bulk intake",
        hint: "A file of leads, validated and previewed before anything is written.",
      },
      {
        href: "/sales/leads/intake/duplicates",
        label: "Duplicates",
        hint: "Two leads for one shop — detected here, merged nowhere yet.",
      },
    ],
  },
  {
    key: "sales.lead-qualify",
    label: "Qualification",
    href: "/sales/leads/qualify",
    tabs: [
      {
        href: "/sales/leads/qualify",
        label: "Suspect decisions",
        exact: true,
        hint: "§4's visit cap. It asks for an answer; it never refuses the visit.",
      },
      {
        href: "/sales/leads/qualify/verification",
        label: "Verification queue",
        hint: "§7 — prospects waiting on a manager's call, ageing against the configured window.",
      },
      {
        href: "/sales/leads/qualify/validation",
        label: "Validation calls",
        hint: "§8's twelve answers, and where the shop and the report disagreed.",
      },
      {
        href: "/sales/leads/qualify/checklist",
        label: "Checklists",
        hint: "§28 — what each lead's gate is still missing, in words.",
      },
    ],
  },
  {
    key: "sales.samples",
    label: "Samples & trials",
    href: "/sales/samples",
    tabs: [
      {
        href: "/sales/samples",
        label: "All samples",
        exact: true,
        hint: "Every sample, in every state, with the three dates kept apart.",
      },
      {
        href: "/sales/samples/desk",
        label: "Desk",
        hint: "Approve, dispatch, confirm receipt, record the trial.",
      },
      {
        href: "/sales/samples/chases",
        label: "Review chases",
        hint: "§16 does not stop — the last interval repeats until there is an answer.",
      },
      {
        href: "/sales/samples/feedback",
        label: "Trial feedback",
        hint: "§16's seven answers across every trial, by product and by competitor.",
      },
    ],
  },
  {
    key: "sales.lead-commercial",
    label: "Commercial",
    href: "/sales/leads/commercial",
    tabs: [
      {
        href: "/sales/leads/commercial",
        label: "Negotiation",
        exact: true,
        hint: "Every lead at negotiation, and what is blocking each one.",
      },
      {
        href: "/sales/leads/commercial/commitments",
        label: "Commitments",
        hint: "Expected orders. A forecast — never added to a real order value.",
      },
      {
        href: "/sales/leads/commercial/first-orders",
        label: "First orders",
        hint: "The order that converts an account, through delivery and payment.",
      },
    ],
  },
  {
    key: "sales.lead-appointments",
    label: "Distributor appointments",
    href: "/sales/leads/appointments",
    tabs: [
      {
        href: "/sales/leads/appointments",
        label: "Appointments",
        exact: true,
        hint: "§12's two-step chain, and the named reason each one escalated.",
      },
    ],
  },
  {
    key: "sales.lead-actions",
    label: "Next actions & nurture",
    href: "/sales/leads/actions",
    tabs: [
      {
        href: "/sales/leads/actions",
        label: "Due",
        exact: true,
        hint: "What is owed on a lead today, and by whom.",
      },
      {
        href: "/sales/leads/actions/overdue",
        label: "Overdue",
        hint: "Past its day, with nobody having said anything since.",
      },
      {
        href: "/sales/leads/actions/none",
        label: "Nothing scheduled",
        hint: "§24 — an active lead with nothing owed by anybody is the state the rule exists to prevent.",
      },
      {
        href: "/sales/leads/actions/nurture",
        label: "Nurture",
        hint: "§13's fifteen rows, split by owner — the salesman and the lead manager are chased for different things.",
      },
      {
        href: "/sales/leads/actions/communication",
        label: "Communication",
        hint: "The eleven company-communication actions, across the book.",
      },
    ],
  },
  {
    key: "sales.lead-handovers",
    label: "Handovers",
    href: "/sales/leads/handovers",
    tabs: [
      {
        href: "/sales/leads/handovers",
        label: "Handovers",
        exact: true,
        hint: "§Q — converted, and still nobody named to run the relationship.",
      },
    ],
  },
  {
    key: "sales.lead-oversight",
    label: "Oversight",
    href: "/sales/leads/oversight",
    tabs: [
      {
        href: "/sales/leads/oversight",
        label: "Overrides",
        exact: true,
        hint: "Every shut gate somebody passed, what was missing, and the reason code.",
      },
      {
        href: "/sales/leads/oversight/audit",
        label: "Audit",
        hint: "The funnel's own audited writes, with the hat that authorised each.",
      },
      {
        href: "/sales/leads/oversight/settings",
        label: "Thresholds",
        hint: "The leads.* keys in force. Read-only — configuration is authored in the Admin Console.",
      },
    ],
  },
];

const BY_KEY = new Map(LEAD_SECTIONS.map((s) => [s.key, s]));

export function leadSection(key: string): LeadSection | undefined {
  return BY_KEY.get(key);
}

/**
 * Which section a path is inside.
 *
 * Longest match wins, the same rule `moduleForPath` follows and for the same
 * reason: `/sales/leads/funnel/sources` is Funnel, not All Leads, although
 * `/sales/leads` is a prefix of it.
 */
export function sectionForPath(path: string): LeadSection | undefined {
  let best: LeadSection | undefined;
  for (const s of LEAD_SECTIONS) {
    const hit = path === s.href || path.startsWith(s.href + "/");
    if (!hit) continue;
    if (!best || s.href.length > best.href.length) best = s;
  }
  return best;
}
