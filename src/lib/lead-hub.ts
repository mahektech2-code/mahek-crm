/* ---------------------------------------------------------------------------
 * THE CRM'S LEAD MANAGEMENT, AS FOUR AREAS.
 *
 * The screens, their routes, their guards and their grants are exactly what
 * `lib/lead-workspace.ts` and `lib/modules.ts` say they are. What this file
 * changes is how somebody MOVES between them: the CRM used to offer five
 * sidebar rows, eight retired sections reached through an "Other screens"
 * menu, and a tab strip per section. It is now one sidebar row, "Leads", and
 * inside it four areas — Today, Leads, Pipeline, Insights — each a set of
 * desks, each desk a set of tabs.
 *
 * Every link names the MODULE that guards its route, and the frame draws only
 * what the person holds: a hidden link is a courtesy, the module layout is the
 * rule, and the two read the same key. `lead-hub.test.ts` pins every link to a
 * real CRM module and every lead module to at least one link.
 *
 * PURE and client-safe: the frame that draws it is a client component.
 * ------------------------------------------------------------------------- */

export type HubAreaKey = "today" | "leads" | "pipeline" | "insights";

export type HubLink = {
  /** Relative to `/crm`. Never starts with a slash. */
  path: string;
  label: string;
  /** The CRM module key that guards the route. */
  module: string;
  /** Only where the path is a prefix of other routes in the same desk. */
  exact?: boolean;
  /** Which server-computed count to draw beside it. */
  count?: HubCountKey;
};

export type HubDesk = {
  key: string;
  label: string;
  links: HubLink[];
  /** Left out of the desk strip unless somebody is on it — reached by a button. */
  hidden?: boolean;
};

export type HubArea = {
  key: HubAreaKey;
  label: string;
  desks: HubDesk[];
};

/** The counts the layout computes. A missing one is not drawn. */
export type HubCountKey =
  | "attention"
  | "dueToday"
  | "overdue"
  | "verify"
  | "checklists"
  | "trials"
  | "negotiation"
  | "slipped";

export const HUB_BASE = "/crm";

export function hubHref(path: string): string {
  return `${HUB_BASE}/${path}`;
}

export const HUB_AREAS: readonly HubArea[] = [
  {
    key: "today",
    label: "Today",
    desks: [
      {
        key: "my-day",
        label: "My day",
        links: [
          {
            path: "leads/dashboard",
            label: "My day",
            module: "crm.leads",
            count: "attention",
          },
        ],
      },
      {
        key: "calling-desk",
        label: "Calling desk",
        links: [
          {
            path: "leads/calling-desk",
            label: "Calling desk",
            module: "crm.lead-calling-desk",
          },
        ],
      },
      {
        key: "sales-manager",
        label: "Sales Manager",
        links: [
          {
            path: "leads/sales-manager",
            label: "Sales Manager",
            module: "crm.sales-manager",
          },
        ],
      },
      {
        key: "follow-ups",
        label: "Follow-ups",
        links: [
          {
            path: "leads/actions",
            label: "Due",
            module: "crm.lead-actions",
            exact: true,
            count: "dueToday",
          },
          {
            path: "leads/actions/overdue",
            label: "Overdue",
            module: "crm.lead-actions",
            count: "overdue",
          },
          {
            path: "leads/actions/none",
            label: "No next step",
            module: "crm.lead-actions",
          },
          {
            path: "leads/actions/parked",
            label: "On hold",
            module: "crm.lead-actions",
          },
        ],
      },
    ],
  },
  {
    key: "leads",
    label: "Leads",
    desks: [
      {
        key: "book",
        label: "All leads",
        links: [
          { path: "leads", label: "List", module: "crm.leads", exact: true },
          { path: "leads/board", label: "Board", module: "crm.leads" },
        ],
      },
      {
        key: "lost",
        label: "Lost",
        links: [{ path: "leads/lost", label: "Lost", module: "crm.lead-lost" }],
      },
      {
        key: "new",
        label: "New lead",
        hidden: true,
        links: [
          {
            path: "leads/intake",
            label: "One lead",
            module: "crm.lead-intake",
            exact: true,
          },
          {
            path: "leads/intake/bulk",
            label: "From a file",
            module: "crm.lead-intake",
          },
          {
            path: "leads/intake/duplicates",
            label: "Duplicates",
            module: "crm.lead-intake",
          },
        ],
      },
    ],
  },
  {
    key: "pipeline",
    label: "Pipeline",
    desks: [
      {
        key: "qualify",
        label: "Qualify",
        links: [
          {
            path: "leads/qualify/verification",
            label: "Verify",
            module: "crm.lead-qualify",
            count: "verify",
          },
          {
            path: "leads/qualify",
            label: "Suspect decisions",
            module: "crm.lead-qualify",
            exact: true,
          },
          {
            path: "leads/qualify/checklist",
            label: "Checklists",
            module: "crm.lead-qualify",
            count: "checklists",
          },
        ],
      },
      {
        key: "samples",
        label: "Samples",
        links: [
          { path: "samples/desk", label: "Desk", module: "crm.samples" },
          {
            path: "samples/chases",
            label: "Reviews due",
            module: "crm.samples",
            count: "trials",
          },
          {
            path: "samples",
            label: "All samples",
            module: "crm.samples",
            exact: true,
          },
        ],
      },
      {
        key: "commercial",
        label: "Commercial",
        links: [
          {
            path: "leads/commercial",
            label: "Negotiation",
            module: "crm.lead-commercial",
            exact: true,
            count: "negotiation",
          },
          {
            path: "leads/commercial/commitments",
            label: "Commitments",
            module: "crm.lead-commercial",
            count: "slipped",
          },
          {
            path: "leads/commercial/first-orders",
            label: "First orders",
            module: "crm.lead-commercial",
          },
        ],
      },
      {
        key: "handovers",
        label: "Handovers",
        links: [
          {
            path: "leads/handovers",
            label: "Handovers",
            module: "crm.lead-handovers",
          },
        ],
      },
      {
        key: "distributors",
        label: "Distributors",
        links: [
          {
            path: "leads/appointments",
            label: "Appointments",
            module: "crm.lead-appointments",
            exact: true,
          },
          {
            path: "leads/appointments/prospective",
            label: "Prospective",
            module: "crm.lead-appointments",
          },
        ],
      },
    ],
  },
  {
    key: "insights",
    label: "Insights",
    desks: [
      {
        key: "conversion",
        label: "Conversion",
        links: [
          {
            path: "leads/funnel",
            label: "Funnel",
            module: "crm.lead-funnel",
            exact: true,
          },
          {
            path: "leads/funnel/sources",
            label: "Sources",
            module: "crm.lead-funnel",
          },
          {
            path: "leads/funnel/reasons",
            label: "Reasons",
            module: "crm.lead-funnel",
          },
          {
            path: "samples/feedback",
            label: "Trial feedback",
            module: "crm.samples",
          },
        ],
      },
      {
        key: "activity",
        label: "Activity",
        links: [
          {
            path: "leads/actions/nurture",
            label: "Nurture",
            module: "crm.lead-actions",
          },
          {
            path: "leads/actions/communication",
            label: "Messages sent",
            module: "crm.lead-actions",
          },
          {
            path: "leads/qualify/validation",
            label: "Verification calls",
            module: "crm.lead-qualify",
          },
        ],
      },
      {
        key: "control",
        label: "Control",
        links: [
          {
            path: "leads/oversight",
            label: "Overrides",
            module: "crm.lead-oversight",
            exact: true,
          },
          {
            path: "leads/oversight/audit",
            label: "Audit",
            module: "crm.lead-oversight",
          },
          {
            path: "leads/oversight/settings",
            label: "Thresholds",
            module: "crm.lead-oversight",
          },
        ],
      },
    ],
  },
];

export function allHubLinks(): HubLink[] {
  return HUB_AREAS.flatMap((a) => a.desks.flatMap((d) => d.links));
}

/** The areas, desks and links this person holds, in order, and nothing else. */
export function hubFor(held: ReadonlySet<string>): HubArea[] {
  return HUB_AREAS.map((a) => ({
    ...a,
    desks: a.desks
      .map((d) => ({ ...d, links: d.links.filter((l) => held.has(l.module)) }))
      .filter((d) => d.links.length > 0),
  })).filter((a) => a.desks.length > 0);
}

/** Where the "Leads" sidebar row lands: the first link the person holds. */
export function hubLanding(held: ReadonlySet<string>): string | null {
  const first = hubFor(held)[0]?.desks[0]?.links[0];
  return first ? hubHref(first.path) : null;
}

/** Every path prefix the hub covers, so the sidebar row lights on all of them. */
export const HUB_PREFIXES = [hubHref("leads"), hubHref("samples")] as const;

export function linkMatches(link: HubLink, pathname: string, exact = link.exact): boolean {
  const href = hubHref(link.path);
  return exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");
}

export type HubPlace = {
  area: HubArea;
  desk: HubDesk;
  /** Null on a page inside a desk that is none of its tabs — a record. */
  link: HubLink | null;
};

/**
 * Where a path sits. The longest link matched as a PREFIX decides the desk,
 * so a sample's record is in Samples and a lead's record falls to All leads;
 * the tab is lit only where the link's own `exact` rule holds.
 */
export function hubPlace(areas: readonly HubArea[], pathname: string): HubPlace | null {
  let best: { area: HubArea; desk: HubDesk; link: HubLink } | null = null;
  for (const area of areas)
    for (const desk of area.desks)
      for (const link of desk.links) {
        if (!linkMatches(link, pathname, false)) continue;
        if (!best || link.path.length > best.link.path.length) best = { area, desk, link };
      }
  if (!best) return null;
  const lit = best.desk.links.find((l) => linkMatches(l, pathname)) ?? null;
  return { area: best.area, desk: best.desk, link: lit };
}
