import type { AppId } from "@/lib/apps";

/* ---------------------------------------------------------------------------
 * WHAT THE DOCUMENTATION APP COVERS, as data.
 *
 * Pure and client-safe: the sidebar is a client component and the coverage
 * test runs without a database, and both read this one list. A page's content
 * lives in MDX beside it (`src/docs/<app>/<slug>/<tab>.mdx`) and is loaded by
 * `content.ts`, which is the only file that knows where the MDX is.
 *
 * EVERY PAGE HAS THE SAME THREE TABS, one per reader, because the three ask
 * different questions of the same screen:
 *
 *   guide         — the person doing the work: what to press, in what order,
 *                   and what happens when they do.
 *   how-it-works  — the owner: the rule behind the screen in plain words, why
 *                   it is that rule, and which setting changes it.
 *   developer     — whoever changes it next: routes, services, tables, the
 *                   engine, the tests that pin it.
 *
 * A tab not yet written is listed in `written` by omission and drawn as
 * exactly that — "not written yet" — never as an empty page, which reads as a
 * page that failed to load.
 *
 * EVERY MODULE OF A DOCUMENTED APP IS CLAIMED BY SOME PAGE. `coverage.test.ts`
 * reads `modulesForApp` and fails on a screen nobody has a page for, so a new
 * CRM screen arrives with its documentation owed rather than forgotten.
 * ------------------------------------------------------------------------- */

export type DocTab = "guide" | "how-it-works" | "developer";

export const DOC_TABS: ReadonlyArray<{ id: DocTab; label: string; reader: string; blurb: string }> = [
  {
    id: "guide",
    label: "Guide",
    reader: "For the person using the screen",
    blurb: "What to press, in what order, and what happens when you do.",
  },
  {
    id: "how-it-works",
    label: "How it works",
    reader: "For the owner and managers",
    blurb: "The rules behind the screen, why they are the rules, and the settings that change them.",
  },
  {
    id: "developer",
    label: "Developer",
    reader: "For whoever changes it next",
    blurb: "Routes, services, the engine, the tables, and the tests that pin it.",
  },
];

export function isDocTab(value: string): value is DocTab {
  return DOC_TABS.some((t) => t.id === value);
}

export type DocPage = {
  /** The URL segment: `/docs/<app>/<slug>`. Never renamed once published. */
  slug: string;
  title: string;
  /** One sentence, shown on the app's index and in search. */
  summary: string;
  /** The sidebar heading it sits under — the app's own sidebar heading where there is one. */
  group: string;
  /** The module keys this page documents. The coverage test reads these. */
  modules: string[];
  /** The route the screen itself lives at, for the "Open the screen" link. */
  screen?: string;
  /** Which tabs have content. Order is irrelevant; `DOC_TABS` decides it. */
  written: DocTab[];
};

export type DocApp = {
  app: AppId;
  /** The app's name as its users say it. */
  title: string;
  summary: string;
  /** Groups in sidebar order. Pages appear under the group they name. */
  groups: string[];
  pages: DocPage[];
};

const ALL: DocTab[] = ["guide", "how-it-works", "developer"];

export const DOC_APPS: DocApp[] = [
  {
    app: "crm",
    title: "Telecaller CRM",
    summary:
      "The calling book: who to ring today and why, what each call produced, the money owed, and the leads being worked towards a first order.",
    groups: [
      "Start here",
      "Overview",
      "Daily calling",
      "Collections",
      "Customer records",
      "Lead Management",
      "Targets & reporting",
      "Support",
    ],
    pages: [
      {
        slug: "overview",
        title: "The CRM in one page",
        summary: "Who uses the CRM, what a day looks like, and how its screens fit together.",
        group: "Start here",
        modules: [],
        written: [],
      },
      {
        slug: "dashboard",
        title: "Dashboard",
        summary: "A telecaller's day at a glance, and a manager's view of the team.",
        group: "Overview",
        modules: ["crm.dashboard"],
        screen: "/crm/dashboard",
        written: [],
      },
      {
        slug: "call-log",
        title: "Call Log",
        summary:
          "The list of customers to ring today, in the order to ring them, with the reason for every name — and the customers held back, with the reason for each.",
        group: "Daily calling",
        modules: ["crm.call-log"],
        screen: "/crm/call-log",
        written: ALL,
      },
      {
        slug: "reminders",
        title: "Reminders",
        summary: "Callbacks customers asked for, and the promises made to them.",
        group: "Daily calling",
        modules: ["crm.reminders"],
        screen: "/crm/reminders",
        written: [],
      },
      {
        slug: "history",
        title: "Call History",
        summary: "Every call logged, what it produced, and what each one said would happen next.",
        group: "Daily calling",
        modules: ["crm.history"],
        screen: "/crm/history",
        written: [],
      },
      {
        slug: "opportunities",
        title: "Opportunities",
        summary: "What customers' calls turned up that somebody may buy.",
        group: "Daily calling",
        modules: ["crm.opportunities"],
        screen: "/crm/opportunities",
        written: [],
      },
      {
        slug: "payments",
        title: "Payment Follow-up",
        summary: "The collections worklist: who owes money, which stage the chase is at, and logging what they said.",
        group: "Collections",
        modules: ["crm.payments"],
        screen: "/crm/payments",
        written: [],
      },
      {
        slug: "whatsapp",
        title: "WhatsApp",
        summary: "Customer chats, payment reminders, and the confirm-before-send rule.",
        group: "Collections",
        modules: ["crm.whatsapp", "crm.whatsapp-reply"],
        screen: "/crm/whatsapp",
        written: [],
      },
      {
        slug: "outstanding",
        title: "Outstanding",
        summary: "Who owes what, one row per customer, with the bills behind each balance.",
        group: "Collections",
        modules: ["crm.outstanding"],
        screen: "/crm/outstanding",
        written: [],
      },
      {
        slug: "bills",
        title: "Sales Bills",
        summary: "The bill ledger by financial year, and what a bill's balance does and does not mean.",
        group: "Collections",
        modules: ["crm.bills"],
        screen: "/crm/bills",
        written: [],
      },
      {
        slug: "customers",
        title: "Customers and the customer record",
        summary: "The customer list, the three account types, the three seats, and the fixed-length record page.",
        group: "Customer records",
        modules: ["crm.customers"],
        screen: "/crm/customers",
        written: [],
      },
      {
        slug: "complaints",
        title: "Complaints",
        summary: "Raising a complaint on a call, photographs, credit-note requests and the SLA.",
        group: "Customer records",
        modules: ["crm.complaints"],
        screen: "/crm/complaints",
        written: [],
      },
      {
        slug: "price-lists",
        title: "Price lists",
        summary: "What each customer pays, which list applies to a shop and why, and asking for a special price.",
        group: "Customer records",
        modules: ["crm.price-lists"],
        screen: "/crm/price-lists",
        written: [],
      },
      {
        slug: "status-requests",
        title: "Close / Reopen",
        summary: "Requests to close a customer account or reopen one, and who decides them.",
        group: "Customer records",
        modules: ["crm.deactivations"],
        screen: "/crm/status-requests",
        written: [],
      },
      {
        slug: "leads",
        title: "All Leads and the lead ladder",
        summary: "The three sales types, every rung of each ladder, and the gates between them.",
        group: "Lead Management",
        modules: ["crm.leads"],
        screen: "/crm/leads",
        written: [],
      },
      {
        slug: "lead-calling-desk",
        title: "Calling desk",
        summary: "Working leads by telephone.",
        group: "Lead Management",
        modules: ["crm.lead-calling-desk"],
        screen: "/crm/leads/calling-desk",
        written: [],
      },
      {
        slug: "lead-intake-and-qualification",
        title: "Intake and qualification",
        summary: "Raising a lead, the validation call, and the questions that qualify it.",
        group: "Lead Management",
        modules: ["crm.lead-intake", "crm.lead-qualify"],
        screen: "/crm/leads/intake",
        written: [],
      },
      {
        slug: "samples",
        title: "Samples & trials",
        summary: "A sample's journey, its three dates, the trial and the review that opens negotiation.",
        group: "Lead Management",
        modules: ["crm.samples"],
        screen: "/crm/samples",
        written: [],
      },
      {
        slug: "lead-commercial",
        title: "Commercial and distributor appointments",
        summary: "Negotiation, the first order, and appointing a distributor through two approvals.",
        group: "Lead Management",
        modules: ["crm.lead-commercial", "crm.lead-appointments"],
        screen: "/crm/leads/commercial",
        written: [],
      },
      {
        slug: "lead-actions",
        title: "Next actions, nurture and handovers",
        summary: "What every active lead owes and to whom, the nurture sequence, and handing a customer over.",
        group: "Lead Management",
        modules: ["crm.lead-actions", "crm.lead-handovers"],
        screen: "/crm/leads/actions",
        written: [],
      },
      {
        slug: "lead-oversight",
        title: "Oversight, Sales Manager desk and Lost",
        summary: "What a manager watches, the Sales Manager's pipeline, and leads lost with their reasons.",
        group: "Lead Management",
        modules: ["crm.lead-oversight", "crm.sales-manager", "crm.lead-lost", "crm.lead-funnel"],
        screen: "/crm/leads/oversight",
        written: [],
      },
      {
        slug: "targets",
        title: "Monthly Targets and Top customers",
        summary: "Targets set on a customer, the shortfall, and the monthly top-customers report.",
        group: "Targets & reporting",
        modules: ["crm.targets"],
        screen: "/crm/targets",
        written: [],
      },
      {
        slug: "performance",
        title: "My Performance",
        summary: "The six components of the score, the mix, and the month-end forecast.",
        group: "Targets & reporting",
        modules: ["crm.performance"],
        screen: "/crm/performance",
        written: [],
      },
      {
        slug: "eod",
        title: "EOD Report",
        summary: "The day, the week or the month in figures, measured against the span before it.",
        group: "Targets & reporting",
        modules: ["crm.eod"],
        screen: "/crm/eod",
        written: [],
      },
      {
        slug: "help-and-settings",
        title: "Help Center and Manager settings",
        summary: "Where SOPs live, and every setting a manager can change from the CRM.",
        group: "Support",
        modules: ["crm.help", "crm.settings"],
        screen: "/crm/settings",
        written: [],
      },
    ],
  },
];

export function docApp(app: string): DocApp | undefined {
  return DOC_APPS.find((a) => a.app === app);
}

export function docPage(app: string, slug: string): DocPage | undefined {
  return docApp(app)?.pages.find((p) => p.slug === slug);
}

export function pageHref(app: string, slug: string, tab: DocTab = "guide"): string {
  return tab === "guide" ? `/docs/${app}/${slug}` : `/docs/${app}/${slug}/${tab}`;
}

/** How much of an app is written, counted in tabs — the honest unit. */
export function progressOf(app: DocApp): { written: number; total: number } {
  const total = app.pages.length * DOC_TABS.length;
  const written = app.pages.reduce((n, p) => n + p.written.length, 0);
  return { written, total };
}
