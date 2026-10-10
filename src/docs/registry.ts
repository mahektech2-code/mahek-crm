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
  /**
   * Which tabs this page HAS. Most pages have all three; a deployment guide
   * has nobody to write a Guide tab for, and drawing an empty one forever
   * reads as a page somebody forgot. Omitted means all three.
   */
  tabs?: DocTab[];
  /** Which tabs have content. Order is irrelevant; `DOC_TABS` decides it. */
  written: DocTab[];
};

export type DocApp = {
  /** The URL segment: `/docs/<app>`. An app id, or `platform` for MahekOne itself. */
  app: string;
  /**
   * The MahekOne app this section documents, where it documents one. The
   * coverage test reads its modules; the platform section has none.
   */
  appId?: AppId;
  /** The app's name as its users say it. */
  title: string;
  summary: string;
  /** Groups in sidebar order. Pages appear under the group they name. */
  groups: string[];
  pages: DocPage[];
};

const ALL: DocTab[] = ["guide", "how-it-works", "developer"];
const OWNER_AND_DEV: DocTab[] = ["how-it-works", "developer"];
const DEV: DocTab[] = ["developer"];

export const DOC_APPS: DocApp[] = [
  {
    app: "platform",
    title: "MahekOne platform",
    summary:
      "How the whole of MahekOne fits together, how to run it on a laptop, how it is deployed to DigitalOcean, and the outside services it leans on — Cloudflare R2, Google Sheets, WhatsApp and the rest.",
    groups: ["Start here", "Run it", "Ship it", "Services"],
    pages: [
      {
        slug: "architecture",
        title: "Architecture, end to end",
        summary: "The apps, the one database, the handset, the sheets, and how a request and a record travel through all of it.",
        group: "Start here",
        modules: [],
        tabs: OWNER_AND_DEV,
        written: OWNER_AND_DEV,
      },
      {
        slug: "local-setup",
        title: "Setup and installation",
        summary: "From a fresh clone to the app running on a laptop: Node, Postgres, environment, migrations, seed data and the test suites.",
        group: "Run it",
        modules: [],
        tabs: DEV,
        written: DEV,
      },
      {
        slug: "configuration",
        title: "Configuration, settings and secrets",
        summary: "Environment variables, the settings registry managers change from a screen, and the credentials kept in the console.",
        group: "Run it",
        modules: [],
        tabs: OWNER_AND_DEV,
        written: OWNER_AND_DEV,
      },
      {
        slug: "deploy-digitalocean",
        title: "Deploying to DigitalOcean",
        summary: "One droplet, Docker Compose, Caddy, the image built in GitHub Actions, migrations over an SSH tunnel, rollbacks and day-to-day operation.",
        group: "Ship it",
        modules: [],
        tabs: DEV,
        written: DEV,
      },
      {
        slug: "handset-release",
        title: "Releasing the MBOS handset app",
        summary: "Building, signing and publishing the APK, over-the-air updates, and push notifications.",
        group: "Ship it",
        modules: [],
        tabs: DEV,
        written: DEV,
      },
      {
        slug: "storage-r2",
        title: "Files and Cloudflare R2",
        summary: "Where photographs and documents live, when they move to R2, how they are read back, and what deletes them.",
        group: "Services",
        modules: [],
        tabs: OWNER_AND_DEV,
        written: OWNER_AND_DEV,
      },
      {
        slug: "backups",
        title: "Backups and recovery",
        summary: "What is backed up, where to, how often, how it is encrypted, and how to restore — with the drill.",
        group: "Services",
        modules: [],
        tabs: OWNER_AND_DEV,
        written: OWNER_AND_DEV,
      },
      {
        slug: "sheets-and-jobs",
        title: "Google Sheets sync and scheduled jobs",
        summary: "What is read from the workbooks, on what cadence, what runs hourly and nightly, and how to run any of it by hand.",
        group: "Services",
        modules: [],
        tabs: OWNER_AND_DEV,
        written: OWNER_AND_DEV,
      },
      {
        slug: "integrations",
        title: "Outside services",
        summary: "WhatsApp (Wati), sign-in codes (MiniMoth), maps (Ola), mail (Resend), dictation (Sarvam and OpenAI) — what each does and what happens without it.",
        group: "Services",
        modules: [],
        tabs: OWNER_AND_DEV,
        written: OWNER_AND_DEV,
      },
    ],
  },
  {
    app: "crm",
    appId: "crm",
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
        written: ALL,
      },
      {
        slug: "dashboard",
        title: "Dashboard",
        summary: "A telecaller's day at a glance, and a manager's view of the team.",
        group: "Overview",
        modules: ["crm.dashboard"],
        screen: "/crm/dashboard",
        written: ALL,
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
        written: ALL,
      },
      {
        slug: "history",
        title: "Call History",
        summary: "Every call logged, what it produced, and what each one said would happen next.",
        group: "Daily calling",
        modules: ["crm.history"],
        screen: "/crm/history",
        written: ALL,
      },
      {
        slug: "opportunities",
        title: "Opportunities",
        summary: "What customers' calls turned up that somebody may buy.",
        group: "Daily calling",
        modules: ["crm.opportunities"],
        screen: "/crm/opportunities",
        written: ALL,
      },
      {
        slug: "payments",
        title: "Payment Follow-up",
        summary: "The collections worklist: who owes money, which stage the chase is at, and logging what they said.",
        group: "Collections",
        modules: ["crm.payments"],
        screen: "/crm/payments",
        written: ALL,
      },
      {
        slug: "whatsapp",
        title: "WhatsApp",
        summary: "Customer chats, payment reminders, and the confirm-before-send rule.",
        group: "Collections",
        modules: ["crm.whatsapp", "crm.whatsapp-reply"],
        screen: "/crm/whatsapp",
        written: ALL,
      },
      {
        slug: "outstanding",
        title: "Outstanding",
        summary: "Who owes what, one row per customer, with the bills behind each balance.",
        group: "Collections",
        modules: ["crm.outstanding"],
        screen: "/crm/outstanding",
        written: ALL,
      },
      {
        slug: "bills",
        title: "Sales Bills",
        summary: "The bill ledger by financial year, and what a bill's balance does and does not mean.",
        group: "Collections",
        modules: ["crm.bills"],
        screen: "/crm/bills",
        written: ALL,
      },
      {
        slug: "customers",
        title: "Customers and the customer record",
        summary: "The customer list, the three account types, the three seats, and the fixed-length record page.",
        group: "Customer records",
        modules: ["crm.customers"],
        screen: "/crm/customers",
        written: ALL,
      },
      {
        slug: "complaints",
        title: "Complaints",
        summary: "Raising a complaint on a call, photographs, credit-note requests and the SLA.",
        group: "Customer records",
        modules: ["crm.complaints"],
        screen: "/crm/complaints",
        written: ALL,
      },
      {
        slug: "price-lists",
        title: "Price lists",
        summary: "What each customer pays, which list applies to a shop and why, and asking for a special price.",
        group: "Customer records",
        modules: ["crm.price-lists"],
        screen: "/crm/price-lists",
        written: ALL,
      },
      {
        slug: "status-requests",
        title: "Close / Reopen",
        summary: "Requests to close a customer account or reopen one, and who decides them.",
        group: "Customer records",
        modules: ["crm.deactivations"],
        screen: "/crm/status-requests",
        written: ALL,
      },
      {
        slug: "leads",
        title: "All Leads and the lead ladder",
        summary: "The three sales types, every rung of each ladder, and the gates between them.",
        group: "Lead Management",
        modules: ["crm.leads"],
        screen: "/crm/leads",
        written: ALL,
      },
      {
        slug: "lead-calling-desk",
        title: "Calling desk",
        summary: "Working leads by telephone.",
        group: "Lead Management",
        modules: ["crm.lead-calling-desk"],
        screen: "/crm/leads/calling-desk",
        written: ALL,
      },
      {
        slug: "lead-intake-and-qualification",
        title: "Intake and qualification",
        summary: "Raising a lead, the validation call, and the questions that qualify it.",
        group: "Lead Management",
        modules: ["crm.lead-intake", "crm.lead-qualify"],
        screen: "/crm/leads/intake",
        written: ALL,
      },
      {
        slug: "samples",
        title: "Samples & trials",
        summary: "A sample's journey, its three dates, the trial and the review that opens negotiation.",
        group: "Lead Management",
        modules: ["crm.samples"],
        screen: "/crm/samples",
        written: ALL,
      },
      {
        slug: "lead-commercial",
        title: "Commercial and distributor appointments",
        summary: "Negotiation, the first order, and appointing a distributor through two approvals.",
        group: "Lead Management",
        modules: ["crm.lead-commercial", "crm.lead-appointments"],
        screen: "/crm/leads/commercial",
        written: ALL,
      },
      {
        slug: "lead-actions",
        title: "Next actions, nurture and handovers",
        summary: "What every active lead owes and to whom, the nurture sequence, and handing a customer over.",
        group: "Lead Management",
        modules: ["crm.lead-actions", "crm.lead-handovers"],
        screen: "/crm/leads/actions",
        written: ALL,
      },
      {
        slug: "lead-oversight",
        title: "Oversight, Sales Manager desk and Lost",
        summary: "What a manager watches, the Sales Manager's pipeline, and leads lost with their reasons.",
        group: "Lead Management",
        modules: ["crm.lead-oversight", "crm.sales-manager", "crm.lead-lost", "crm.lead-funnel"],
        screen: "/crm/leads/oversight",
        written: ALL,
      },
      {
        slug: "targets",
        title: "Monthly Targets and Top customers",
        summary: "Targets set on a customer, the shortfall, and the monthly top-customers report.",
        group: "Targets & reporting",
        modules: ["crm.targets"],
        screen: "/crm/targets",
        written: ALL,
      },
      {
        slug: "performance",
        title: "My Performance",
        summary: "The six components of the score, the mix, and the month-end forecast.",
        group: "Targets & reporting",
        modules: ["crm.performance"],
        screen: "/crm/performance",
        written: ALL,
      },
      {
        slug: "eod",
        title: "EOD Report",
        summary: "The day, the week or the month in figures, measured against the span before it.",
        group: "Targets & reporting",
        modules: ["crm.eod"],
        screen: "/crm/eod",
        written: ALL,
      },
      {
        slug: "help-and-settings",
        title: "Help Center and Manager settings",
        summary: "Where SOPs live, and every setting a manager can change from the CRM.",
        group: "Support",
        modules: ["crm.help", "crm.settings"],
        screen: "/crm/settings",
        written: ALL,
      },
    ],
  },
  {
    app: "sales",
    appId: "sales",
    title: "Sales Dashboard",
    summary:
      "The office end of MBOS: the field team's day, where they are, the journeys they walk, their targets and performance, and every decision waiting on a manager.",
    groups: ["Start here", "Overview", "Decisions", "Field work", "Commercial", "Lead Management", "People", "Enablement", "Administration"],
    pages: [
      {
        slug: "overview",
        title: "The Sales Dashboard in one page",
        summary: "Who uses the office end of MBOS, what a manager's day looks like, and how its screens fit together.",
        group: "Start here",
        modules: [],
        written: ALL,
      },
      {
        slug: "today",
        title: "Today",
        summary: "The field team's day at a glance and every decision waiting on you.",
        group: "Overview",
        modules: ["sales.today"],
        screen: "/sales",
        written: ALL,
      },
      {
        slug: "live-map",
        title: "Live map",
        summary: "Where the team is now and everywhere they went today, on Ola Maps, with trails snapped to the road.",
        group: "Overview",
        modules: ["sales.live"],
        screen: "/sales/live",
        written: ALL,
      },
      {
        slug: "territory",
        title: "Territory",
        summary: "The book's shops on a map, prospect pins, and allocating salesmen to states, cities and beats.",
        group: "Overview",
        modules: ["sales.territory"],
        screen: "/sales/territory",
        written: ALL,
      },
      {
        slug: "performance",
        title: "Performance and cost & return",
        summary: "The six-component score, the mix, the forecast, and what each salesman costs against what he brings in.",
        group: "Overview",
        modules: ["sales.performance", "sales.roi"],
        screen: "/sales/performance",
        written: ALL,
      },
      {
        slug: "approvals",
        title: "Approvals",
        summary: "Every decision the field sends the office, the two-step chain, and what each approval writes.",
        group: "Decisions",
        modules: ["sales.approvals"],
        screen: "/sales/approvals",
        written: ALL,
      },
      {
        slug: "targets",
        title: "Sales targets",
        summary: "Setting, publishing and revising a salesman's monthly target, with the reason on every revision.",
        group: "Decisions",
        modules: ["sales.targets"],
        screen: "/sales/targets",
        written: ALL,
      },
      {
        slug: "journeys",
        title: "Journeys and visits",
        summary: "Proposing a city, the salesman agreeing and picking shops, the day's route, and the visits it produced.",
        group: "Field work",
        modules: ["sales.journeys"],
        screen: "/sales/journeys",
        written: ALL,
      },
      {
        slug: "tasks",
        title: "Tasks",
        summary: "Tasks raised for salesmen and managers, nurture tasks, escalation and completion with evidence.",
        group: "Field work",
        modules: ["sales.tasks"],
        screen: "/sales/tasks",
        written: ALL,
      },
      {
        slug: "field-reports",
        title: "Field reports and activity history",
        summary: "What the field recorded, the old app's activity history, and how shops are matched.",
        group: "Field work",
        modules: ["sales.field-reports", "sales.activity-history"],
        screen: "/sales/field-reports",
        written: ALL,
      },
      {
        slug: "travel",
        title: "Travel ledger",
        summary: "Every journey leg, meter photographs at both ends, and how a leg is priced.",
        group: "Field work",
        modules: ["sales.travel"],
        screen: "/sales/travel",
        written: ALL,
      },
      {
        slug: "commercial",
        title: "Orders, payments and invoices",
        summary: "What salesmen take in the field, how it reaches accounts, and what the office sees of it.",
        group: "Commercial",
        modules: ["sales.orders", "sales.payments", "sales.invoices"],
        screen: "/sales/orders",
        written: ALL,
      },
      {
        slug: "lead-management",
        title: "Lead Management on the Sales Dashboard",
        summary: "The same lead screens as the CRM, scoped to a manager's team — what differs and where each is documented.",
        group: "Lead Management",
        modules: ["sales.leads", "sales.lead-pipeline", "sales.lead-funnel", "sales.lead-intake", "sales.lead-qualify", "sales.samples", "sales.lead-commercial", "sales.lead-appointments", "sales.lead-actions", "sales.lead-handovers", "sales.lead-oversight"],
        screen: "/sales/leads",
        written: ALL,
      },
      {
        slug: "attendance",
        title: "Attendance",
        summary: "Check-in and check-out with selfies, sessions in a day, geofence, missed check-outs and what a manager sees.",
        group: "People",
        modules: ["sales.attendance"],
        screen: "/sales/attendance",
        written: ALL,
      },
      {
        slug: "leave-and-holidays",
        title: "Leave and holidays",
        summary: "Leave requests and decisions, and the holiday calendar the forecast and the working day read.",
        group: "People",
        modules: ["sales.leave", "sales.holidays"],
        screen: "/sales/leave",
        written: ALL,
      },
      {
        slug: "expenses",
        title: "Expenses and the expense policy",
        summary: "Daily expense claims, the policy engine that prices them, and the flagged ones a manager reviews.",
        group: "People",
        modules: ["sales.expenses", "sales.exceptions", "sales.expense-policy"],
        screen: "/sales/expenses",
        written: ALL,
      },
      {
        slug: "enablement",
        title: "Documents and knowledge",
        summary: "Publishing documents and training to the handsets, and withdrawing them.",
        group: "Enablement",
        modules: ["sales.documents", "sales.knowledge"],
        screen: "/sales/documents",
        written: ALL,
      },
      {
        slug: "salesmen",
        title: "Salesmen",
        summary: "The team list, each salesman's record, devices and handset health.",
        group: "Administration",
        modules: ["sales.people"],
        screen: "/sales/people",
        written: ALL,
      },
      {
        slug: "administration",
        title: "App preferences, logins, sync health, notifications and audit",
        summary: "Running the handsets from the office: preferences, who signed in, which phones are syncing, sending a notification, and the audit trail.",
        group: "Administration",
        modules: ["sales.prefs", "sales.logins", "sales.sync-health", "sales.notify", "sales.audit"],
        screen: "/sales/sync-health",
        written: ALL,
      },
    ],
  },
  {
    app: "mbos",
    appId: "field",
    title: "MBOS handset app",
    summary:
      "The field salesman's Android app: the day, the visits, orders, payments and leads — built to work with no signal and sync when it can.",
    groups: ["Start here", "The day", "Selling", "Money and time", "No signal"],
    pages: [
      {
        slug: "overview",
        title: "MBOS in one page",
        summary: "What the handset is, who uses it, a salesman's day, and how it works with no signal.",
        group: "Start here",
        modules: ["field.home"],
        written: ALL,
      },
      {
        slug: "setup",
        title: "Installing, signing in and phone setup",
        summary: "Getting the APK, signing in, the permissions and battery settings tracking needs, and the phone setup screens.",
        group: "Start here",
        modules: [],
        written: ALL,
      },
      {
        slug: "attendance",
        title: "Starting and ending the day",
        summary: "Check-in and check-out with a selfie, sessions, breaks, the geofence, and tracking while working.",
        group: "The day",
        modules: [],
        written: ALL,
      },
      {
        slug: "journeys",
        title: "Journeys, the route and what is near me",
        summary: "Agreeing a day, picking shops, the day's order, Next Best Visit, navigation and the map.",
        group: "The day",
        modules: [],
        written: ALL,
      },
      {
        slug: "visit",
        title: "Visiting a shop",
        summary: "Setting off, arriving within the radius, the visit form, photographs, the note and dictation, and closing a visit.",
        group: "The day",
        modules: [],
        written: ALL,
      },
      {
        slug: "customers",
        title: "Customers and the account record",
        summary: "The book on the phone, territory, the customer record, the statement and reorder due.",
        group: "Selling",
        modules: [],
        written: ALL,
      },
      {
        slug: "orders",
        title: "Orders and the catalogue",
        summary: "Taking an order in the field, prices, what accounts do with it, and delivery confirmation.",
        group: "Selling",
        modules: [],
        written: ALL,
      },
      {
        slug: "payments",
        title: "Collecting payments",
        summary: "Recording money at a counter, cheques, cash in hand, deposits and bounced cheques.",
        group: "Selling",
        modules: [],
        written: ALL,
      },
      {
        slug: "leads",
        title: "Leads, qualification and samples",
        summary: "Raising a lead, the ladder on the phone, the Suspect visit cap, qualifying, validation, samples and trials.",
        group: "Selling",
        modules: [],
        written: ALL,
      },
      {
        slug: "tasks",
        title: "Tasks and notifications",
        summary: "What the office asks of a salesman, completing with evidence, and notifications.",
        group: "Selling",
        modules: [],
        written: ALL,
      },
      {
        slug: "expenses",
        title: "Travel, expenses, leave and salary",
        summary: "Logging travel and expenses, the policy, leave requests, holidays and the salary view.",
        group: "Money and time",
        modules: [],
        written: ALL,
      },
      {
        slug: "performance",
        title: "Performance and reports",
        summary: "The salesman's own score, target, mix and forecast, and his reports.",
        group: "Money and time",
        modules: [],
        written: ALL,
      },
      {
        slug: "offline-maps",
        title: "Offline maps",
        summary: "Downloading areas of the book's map for no signal, sizes and keeping them fresh.",
        group: "No signal",
        modules: [],
        written: ALL,
      },
      {
        slug: "sync",
        title: "Sync, the outbox and rejections",
        summary: "How the phone and the office stay in step, what a refused record means, and fixing a stuck handset.",
        group: "No signal",
        modules: [],
        written: ALL,
      },
    ],
  },  {
    app: "erp",
    appId: "erp",
    title: "ERP",
    summary:
      "The factory and back office: buying raw materials, making and packing paint, stock by godown, orders, dispatch, transport and petty cash.",
    groups: ["Start here", "Masters", "Purchase", "Make and store", "Sell and ship", "Money"],
    pages: [
      {
        slug: "overview",
        title: "The ERP in one page",
        summary: "What the ERP runs — buying, making, stocking, selling and shipping paint — how its screens fit together, and the dashboard.",
        group: "Start here",
        modules: ["erp.dashboard"],
        written: ALL,
      },
      {
        slug: "access-and-designations",
        title: "Access, designations and settings",
        summary: "Who can open which ERP screen, what a designation grants, working location, and the help videos.",
        group: "Start here",
        modules: ["erp.settings", "erp.videos"],
        written: ALL,
      },
      {
        slug: "order-book",
        title: "The ERP and MahekOne's order book",
        summary: "How ERP orders reach the CRM, targets and outstanding, and the erp.orders.live cut-over from the sheet.",
        group: "Start here",
        modules: [],
        written: ALL,
      },
      {
        slug: "masters",
        title: "Masters",
        summary: "Raw materials, suppliers, products, sales parties, godowns, price lists and reference lists.",
        group: "Masters",
        modules: ["erp.rawMaterials", "erp.suppliers", "erp.products", "erp.customers", "erp.myCustomers", "erp.godowns", "erp.priceLists", "erp.refLists"],
        written: ALL,
      },
      {
        slug: "purchase-requirements",
        title: "Purchase requirements and quotations",
        summary: "A department asks for something; the purchase rule decides direct buy, quotation or the buyer's call.",
        group: "Purchase",
        modules: ["erp.requisitions"],
        written: ALL,
      },
      {
        slug: "purchase-orders",
        title: "Purchase orders",
        summary: "No purchase without a PO: raising, approving, sending and printing one.",
        group: "Purchase",
        modules: ["erp.purchaseOrders"],
        written: ALL,
      },
      {
        slug: "goods-receipt-and-testing",
        title: "Goods receipt, testing and the register",
        summary: "Receiving at the gate against a PO, lots, drum labels, lab testing and matching the supplier's bill.",
        group: "Purchase",
        modules: ["erp.register", "erp.testing"],
        written: ALL,
      },
      {
        slug: "production",
        title: "Production: batches, filling, packing and recipes",
        summary: "SFG batches from raw-material lots, filling into cans, packing into boxes, and recipes.",
        group: "Make and store",
        modules: ["erp.sfgBatches", "erp.fgFill", "erp.packBatches", "erp.recipes"],
        written: ALL,
      },
      {
        slug: "stock",
        title: "Stock, boxes and transfers",
        summary: "Stock by godown and stage, every box by id and its label, and moving or writing off stock.",
        group: "Make and store",
        modules: ["erp.stock", "erp.units", "erp.transfers"],
        written: ALL,
      },
      {
        slug: "stock-levels",
        title: "Minimum levels and reordering",
        summary: "Raw-material and finished-goods minimums, and raising a requirement from a shortfall.",
        group: "Make and store",
        modules: ["erp.rmLevels", "erp.fgLevels"],
        written: ALL,
      },
      {
        slug: "orders",
        title: "Orders, billing and the WhatsApp inbox",
        summary: "From an order being taken to its bill: pending, ready, billing, batch codes, labels and the inbox.",
        group: "Sell and ship",
        modules: ["erp.orders"],
        written: ALL,
      },
      {
        slug: "dispatch",
        title: "The dispatch desk",
        summary: "Scanning every box onto its order before the lorry leaves, and the override when one is wrong.",
        group: "Sell and ship",
        modules: ["erp.dispatch"],
        written: ALL,
      },
      {
        slug: "transport",
        title: "Transport and LRs",
        summary: "Every dispatched bill, its LR, where the consignment is, and paid freight.",
        group: "Sell and ship",
        modules: ["erp.transport"],
        written: ALL,
      },
      {
        slug: "traceability",
        title: "Traceability",
        summary: "Any box, lot, batch, order or bill: where it came from and where it went.",
        group: "Sell and ship",
        modules: ["erp.trace"],
        written: ALL,
      },
      {
        slug: "complaints-and-credit-notes",
        title: "Complaints and credit notes",
        summary: "The customer's complaints and credit notes — the same records the CRM keeps.",
        group: "Sell and ship",
        modules: ["erp.requests"],
        written: ALL,
      },
      {
        slug: "petty-cash",
        title: "Petty cash: expenses and funds given",
        summary: "Funds given to people, what they spent, and what each of them still holds.",
        group: "Money",
        modules: ["erp.expenses"],
        written: ALL,
      },
      {
        slug: "alerts-and-ai",
        title: "Alerts and the AI helpers",
        summary: "The overnight alerts, and the AI that reads orders, bills, complaints and photographs.",
        group: "Money",
        modules: ["erp.alerts"],
        written: ALL,
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

/** The tabs a page has, in `DOC_TABS` order. */
export function tabsOf(page: DocPage): DocTab[] {
  const has = page.tabs ?? ALL;
  return DOC_TABS.map((t) => t.id).filter((t) => has.includes(t));
}

/**
 * A page's URL. Its FIRST tab is the bare path, so `/docs/crm/call-log` is
 * the guide and `/docs/platform/local-setup` is the developer tab — the only
 * one it has. Any other tab is a segment beneath.
 */
export function pageHref(app: string, slug: string, tab?: DocTab): string {
  const page = docPage(app, slug);
  const first = page ? tabsOf(page)[0] : "guide";
  return !tab || tab === first ? `/docs/${app}/${slug}` : `/docs/${app}/${slug}/${tab}`;
}

/** How much of an app is written, counted in tabs — the honest unit. */
export function progressOf(app: DocApp): { written: number; total: number } {
  const total = app.pages.reduce((n, p) => n + tabsOf(p).length, 0);
  const written = app.pages.reduce((n, p) => n + p.written.length, 0);
  return { written, total };
}
