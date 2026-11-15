/* ---------------------------------------------------------------------------
 * THE CRM'S LEAD MANAGEMENT, AS A SIDEBAR GROUP OF DESKS (Nov 2026).
 *
 * It used to be one sidebar row, "Leads", opening onto a second app: its own
 * header, its own search box, four areas, a strip of desks and a row of tabs
 * under that. Nobody could tell where a screen lived. Now Leads is an ordinary
 * sidebar group, like Customer records, and each desk is a row in it. A desk
 * with more than one screen draws ONE row of tabs under its title, and that is
 * the only navigation inside the page.
 *
 * Every link names the MODULE that guards its route, and the sidebar draws only
 * what the person holds: a hidden link is a courtesy, the module layout is the
 * rule, and the two read the same key. `lead-hub.test.ts` pins every link to a
 * real CRM module and every lead module to at least one link.
 *
 * A desk with `nav: false` has no sidebar row. Its screens are reached from a
 * button (New lead), a filter on All leads (Follow-ups), or are kept for old
 * links while their work moves elsewhere (Distributors, closed to new leads;
 * Control, which belongs to administrators). When somebody is on one, its tabs
 * are still drawn.
 *
 * PURE and client-safe: the sidebar and the frame that draw it are clients.
 * ------------------------------------------------------------------------- */

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
  /** The sidebar glyph (`components/shell/icons.tsx`). */
  icon: string;
  links: HubLink[];
  /** False: no sidebar row. See the header. */
  nav?: boolean;
  /** "+ New lead" beside the title. */
  addButton?: boolean;
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

export const HUB_DESKS: readonly HubDesk[] = [
  {
    key: "my-day",
    label: "My day",
    icon: "dashboard",
    addButton: true,
    links: [{ path: "leads/dashboard", label: "My day", module: "crm.leads", count: "attention" }],
  },
  {
    key: "book",
    label: "All leads",
    icon: "target",
    addButton: true,
    links: [
      { path: "leads", label: "List", module: "crm.leads", exact: true },
      { path: "leads/board", label: "Board", module: "crm.leads" },
      { path: "leads/lost", label: "Lost", module: "crm.lead-lost" },
    ],
  },
  {
    key: "calling-desk",
    label: "Calling desk",
    icon: "phone",
    links: [{ path: "leads/calling-desk", label: "Calling desk", module: "crm.lead-calling-desk" }],
  },
  {
    key: "sales-manager",
    label: "Sales Manager desk",
    icon: "people",
    links: [{ path: "leads/sales-manager", label: "Sales Manager desk", module: "crm.sales-manager" }],
  },
  {
    key: "qualify",
    label: "Verify & qualify",
    icon: "check",
    links: [
      { path: "leads/qualify/verification", label: "Verify", module: "crm.lead-qualify", count: "verify" },
      { path: "leads/qualify", label: "Suspect decisions", module: "crm.lead-qualify", exact: true },
      {
        path: "leads/qualify/checklist",
        label: "Qualification review",
        module: "crm.lead-qualify",
        count: "checklists",
      },
    ],
  },
  {
    key: "samples",
    label: "Samples & trials",
    icon: "gift",
    links: [
      { path: "samples/desk", label: "Desk", module: "crm.samples" },
      { path: "samples/chases", label: "Reviews due", module: "crm.samples", count: "trials" },
      { path: "samples", label: "All samples", module: "crm.samples", exact: true },
    ],
  },
  {
    key: "commercial",
    label: "Negotiation",
    icon: "rupee",
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
      { path: "leads/commercial/first-orders", label: "First orders", module: "crm.lead-commercial" },
    ],
  },
  {
    key: "handovers",
    label: "Handovers",
    icon: "swap",
    links: [{ path: "leads/handovers", label: "Handovers", module: "crm.lead-handovers" }],
  },
  {
    key: "reports",
    label: "Lead reports",
    icon: "chart",
    links: [
      { path: "leads/funnel", label: "Funnel", module: "crm.lead-funnel", exact: true },
      { path: "leads/funnel/sources", label: "Sources", module: "crm.lead-funnel" },
      { path: "leads/funnel/reasons", label: "Win & loss reasons", module: "crm.lead-funnel" },
      { path: "samples/feedback", label: "Trial feedback", module: "crm.samples" },
      { path: "leads/actions/nurture", label: "Nurture", module: "crm.lead-actions" },
      { path: "leads/actions/communication", label: "Messages sent", module: "crm.lead-actions" },
      { path: "leads/qualify/validation", label: "Verification calls", module: "crm.lead-qualify" },
    ],
  },
  /* ---- no sidebar row ------------------------------------------------- */
  {
    key: "new",
    label: "New lead",
    icon: "plus",
    nav: false,
    links: [
      { path: "leads/intake", label: "One lead", module: "crm.lead-intake", exact: true },
      { path: "leads/intake/bulk", label: "From a file", module: "crm.lead-intake" },
      { path: "leads/intake/duplicates", label: "Duplicates", module: "crm.lead-intake" },
    ],
  },
  {
    /* Due, Overdue, No next step and On hold are filters of All leads now
       (`?view=today|overdue|unworked|parked`). These screens stay for links. */
    key: "follow-ups",
    label: "Follow-ups",
    icon: "clock",
    nav: false,
    links: [
      { path: "leads/actions", label: "Due", module: "crm.lead-actions", exact: true, count: "dueToday" },
      { path: "leads/actions/overdue", label: "Overdue", module: "crm.lead-actions", count: "overdue" },
      { path: "leads/actions/none", label: "No next step", module: "crm.lead-actions" },
      { path: "leads/actions/parked", label: "On hold", module: "crm.lead-actions" },
    ],
  },
  {
    /* The distributor ladder is closed to new leads. */
    key: "distributors",
    label: "Distributors",
    icon: "people",
    nav: false,
    links: [
      { path: "leads/appointments", label: "Appointments", module: "crm.lead-appointments", exact: true },
      { path: "leads/appointments/prospective", label: "Prospective", module: "crm.lead-appointments" },
    ],
  },
  {
    /* Administrators' screens, out of the daily CRM. */
    key: "control",
    label: "Lead control",
    icon: "settings",
    nav: false,
    links: [
      { path: "leads/oversight", label: "Overrides", module: "crm.lead-oversight", exact: true },
      { path: "leads/oversight/audit", label: "Audit", module: "crm.lead-oversight" },
      { path: "leads/oversight/settings", label: "Thresholds", module: "crm.lead-oversight" },
    ],
  },
];

export function allHubLinks(): HubLink[] {
  return HUB_DESKS.flatMap((d) => d.links);
}

/** The desks and links this person holds, in order, and nothing else. */
export function hubFor(held: ReadonlySet<string>): HubDesk[] {
  return HUB_DESKS.map((d) => ({ ...d, links: d.links.filter((l) => held.has(l.module)) })).filter(
    (d) => d.links.length > 0,
  );
}

/**
 * The sidebar rows: held desks that have one. Somebody who holds ONLY screens
 * with no row of their own (an auditor given Lead control and nothing else)
 * gets those as rows instead — nobody is left without a way in.
 */
export function hubNav(held: ReadonlySet<string>): HubDesk[] {
  const desks = hubFor(held);
  const rows = desks.filter((d) => d.nav !== false);
  return rows.length > 0 ? rows : desks;
}

/** Where a desk's sidebar row lands: its first link. */
export function deskHref(desk: HubDesk): string {
  return hubHref(desk.links[0].path);
}

/** Where "Leads" lands for somebody: the first desk they hold. */
export function hubLanding(held: ReadonlySet<string>): string | null {
  const first = hubNav(held)[0];
  return first ? deskHref(first) : null;
}

/** Every path prefix the frame covers. */
export const HUB_PREFIXES = [hubHref("leads"), hubHref("samples")] as const;

export function linkMatches(link: HubLink, pathname: string, exact = link.exact): boolean {
  const href = hubHref(link.path);
  return exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");
}

export type HubPlace = {
  desk: HubDesk;
  /** Null on a page inside a desk that is none of its tabs — a record. */
  link: HubLink | null;
};

/**
 * Where a path sits. The longest link matched as a PREFIX decides the desk,
 * so a sample's record is in Samples and a lead's record falls to All leads;
 * the tab is lit only where the link's own `exact` rule holds.
 */
export function hubPlace(desks: readonly HubDesk[], pathname: string): HubPlace | null {
  let best: { desk: HubDesk; link: HubLink } | null = null;
  for (const desk of desks)
    for (const link of desk.links) {
      if (!linkMatches(link, pathname, false)) continue;
      if (!best || link.path.length > best.link.path.length) best = { desk, link };
    }
  if (!best) return null;
  const lit = best.desk.links.find((l) => linkMatches(l, pathname)) ?? null;
  return { desk: best.desk, link: lit };
}

/**
 * The sidebar row a desk draws: its first link's address, lit on every one of
 * its links. A `match` entry for each link is what makes Lead reports light on
 * `samples/feedback` and Verify & qualify on its three tabs.
 */
export function deskNavMatch(desk: HubDesk): string[] {
  return desk.links.map((l) => hubHref(l.path));
}
