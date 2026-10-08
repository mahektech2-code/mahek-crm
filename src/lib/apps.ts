/* ---------------------------------------------------------------------------
 * The MahekOne app registry.
 *
 * One sign-in covers all of these. What a person can open is data — a row per
 * user per app — not something hard-coded against their role, because access
 * and job title drift apart the moment somebody covers for a colleague.
 * ------------------------------------------------------------------------- */

export const APP_IDS = [
  "crm",
  "field",
  "sales",
  "accounts",
  "people",
  "reports",
  "hrms",
  "admin",
  "founder",
  "enquiries",
  "erp",
  "website",
  "hire",
] as const;

export type AppId = (typeof APP_IDS)[number];

export type AppDefinition = {
  id: AppId;
  name: string;
  initials: string;
  description: string;
  href: string;
  /** The CRM carries the brand chip; everything else is neutral. */
  tone: "primary" | "neutral";
  /** False until the app itself exists — the launcher says so plainly. */
  built: boolean;
  /**
   * True for exactly one entry: `field`, MBOS's own handset. Granting it
   * gives somebody a sign-in to the mobile app and nothing else — there is
   * no web screen behind it and there is never going to be one, which is a
   * different fact from `built: false`. Every list that draws a person's WEB
   * navigation — the launcher, the switcher, the locked-apps strip — has to
   * leave this app out, or granting mobile access puts a dead "coming soon"
   * tile in front of a browser. It stays a real, grantable entry in `APPS`
   * for everything that is NOT web navigation: the access screen still needs
   * to offer it, and `app_access` still needs the id.
   */
  mobileOnly?: boolean;
  /**
   * An app whose work another app now does. Its id stays, so a grant made
   * before the retirement still resolves, but nothing draws it — two tiles
   * for one job is how people end up keeping two records of it.
   */
  retiredInto?: AppId;
};

export const APPS: AppDefinition[] = [
  {
    id: "crm",
    name: "Telecaller CRM",
    initials: "TC",
    description:
      "Call queue, payment follow-up, reminders and the EOD report.",
    href: "/crm/dashboard",
    tone: "primary",
    built: true,
  },
  {
    id: "field",
    name: "Salesman App",
    initials: "SA",
    // MBOS itself, not a screen on this site — see `mobileOnly` on the type.
    // Granting this app is granting a sign-in to the phone app, full stop.
    description:
      "The mobile app a field salesman signs into. Granting it gives mobile access only — there is no web screen for it.",
    href: "/field",
    tone: "neutral",
    // The mobile app is real and shipped; `built` here is about the web,
    // which this app deliberately has none of.
    built: true,
    mobileOnly: true,
  },
  {
    id: "sales",
    /*
     * The office end of MBOS, and deliberately a different app from `field`.
     *
     * `field` is the handset — MBOS sign-in refuses without that grant — and an
     * app grant with no module rows means every module of it, so a salesman
     * granted `field` from a terminal would open the approvals queue and the
     * whole team's figures beside his own day. Two audiences, two grants, and
     * a manager who genuinely walks a beat can hold both.
     */
    name: "Sales Dashboard",
    initials: "SD",
    description:
      "The field team's day, the journeys they walk, and every decision waiting on you.",
    href: "/sales",
    tone: "neutral",
    built: true,
  },
  {
    id: "accounts",
    // It was `orders`, named for what it first held. It now holds approvals,
    // receipts, the bill ledger, credit notes, on-account balances, the sheet
    // import and the audit log, and "orders" described one screen of seven.
    //
    // The slug moved with the name. `app_access` rows came with it — the
    // migration RENAMEs the enum value in place rather than adding a second
    // one, so nobody lost the app for an instant — and the old /orders URLs
    // redirect, so every bookmark still opens it.
    name: "Accounts",
    initials: "AC",
    description:
      "Order approvals, money coming in, the bill ledger and the credit notes behind it.",
    href: "/accounts",
    tone: "neutral",
    built: true,
  },
  {
    id: "people",
    name: "Attendance & People",
    initials: "AP",
    description: "Hours, leave and the team roster — now HRMS.",
    href: "/hrms",
    tone: "neutral",
    built: false,
    retiredInto: "hrms",
  },
  {
    id: "reports",
    // Retired. Its screens are gone; the owner's figures it drew are read by
    // the Founder Command Centre from the same service. The id stays so a
    // grant made before the retirement still resolves to something.
    name: "Reports",
    initials: "RP",
    description: "Retired — the owner's figures are in the Founder Command Centre.",
    href: "/founder",
    tone: "neutral",
    built: false,
    retiredInto: "founder",
  },
  {
    id: "hrms",
    name: "HRMS",
    initials: "HR",
    description:
      "Check in and out, leave, payroll, tasks, performance, the sales desk and the employee master.",
    href: "/hrms",
    tone: "neutral",
    built: true,
  },
  {
    id: "admin",
    name: "Admin Console",
    initials: "AC",
    description: "Accounts, roles and app access for the whole team.",
    href: "/admin",
    tone: "neutral",
    built: true,
  },
  {
    id: "founder",
    /*
     * Performance across every app, on one screen — a pure composition layer
     * over what the owner's KPIs, the Sales Dashboard, Accounts and HRMS
     * already compute. No new derived numbers live here; this reads and
     * rolls up. It is also where the retired Reports app's figures now live.
     */
    name: "Founder Command Centre",
    initials: "FC",
    description:
      "Every record and every decision in the company, in one place — and what needs you today.",
    href: "/founder",
    tone: "neutral",
    built: true,
  },
  {
    id: "enquiries",
    /*
     * Its own app, not a screen inside the CRM, Accounts or HRMS — Sales,
     * Accounts and HR each work enquiries that belong to their own team, and
     * one shared workspace granted separately is what lets a person hold it
     * without also holding whichever of those three apps happens to be
     * nearby. `enquiries.workspace` on the database row points back at this
     * same app id, so a grant here and a row there mean the same thing.
     */
    name: "Website Enquiries",
    initials: "WE",
    description:
      "Enquiries from the website and beyond, from first contact through to delivery.",
    href: "/enquiries",
    tone: "neutral",
    built: true,
  },
  {
    id: "erp",
    /*
     * The factory and the godowns: purchase, testing, stock, batching,
     * filling, packing, transfers, orders, dispatch and transport — the
     * client's AppSheet "Mahek Plus", rebuilt (docs/erp/). One app narrowed by
     * module rather than five: "where is this lot" is one question whoever
     * asks it, and each screen is its own module because the source granted
     * screens one at a time.
     */
    name: "ERP",
    initials: "ERP",
    description:
      "Purchase, quality tests, stock, production, orders, dispatch and transport — from the godown to the lorry.",
    href: "/erp",
    tone: "neutral",
    built: true,
  },
  {
    id: "website",
    /*
     * The CMS for mahek-website — its own app for the same reason Website
     * Enquiries is one: it is work nobody already granted Sales, Accounts or
     * HRMS does, so a separate grant is what lets somebody hold it without
     * also holding whichever of those happens to be nearby. This PR wires up
     * the app, its access and its 12 module screens over mock data only;
     * reading and writing the live site is a later PR.
     */
    name: "Website",
    initials: "WA",
    description:
      "Products, pages, gallery, careers and the rest of what the public site shows — content, not the calling book.",
    href: "/website",
    tone: "neutral",
    built: true,
  },
  {
    id: "hire",
    /*
     * Hiring and onboarding. It ends where the other apps begin: the last act
     * of the pipeline is provisioning the new employee's MahekOne account with
     * the apps their role blueprint names, which is also what makes a
     * candidate `hired` (Hire PRD §1.1, P8). What somebody may do inside it is
     * their Hire ROLE — recruiter, interviewer, hiring manager, onboarding,
     * HR head, admin — set on the Access screen beside the grant (`lib/hire/roles.ts`).
     */
    name: "Hire",
    initials: "HI",
    description:
      "Role blueprints, the hiring pipeline, AI-assisted interviews with evidence, decisions, offers and onboarding — ending in a working account.",
    href: "/hire",
    tone: "neutral",
    built: true,
  },
];

export function getApp(id: string): AppDefinition | undefined {
  return APPS.find((a) => a.id === id);
}

/**
 * The held apps that belong in a WEB list — the launcher grid, the header
 * switcher, the "not on your account" strip. One function rather than each
 * of those filtering `APPS` by hand, because that is exactly how a mobile-only
 * app like `field` ends up drawn as a browser tile in one of them and not the
 * others: the exclusion has to live in one place to be certain it is everywhere.
 */
export function webApps(ids: readonly AppId[]): AppDefinition[] {
  return APPS.filter((a) => ids.includes(a.id) && !a.mobileOnly && !a.retiredInto);
}

/** "MAHEK CRM" for the CRM, "MAHEK OM" and so on for the rest. */
export function wordmark(app: AppDefinition): string {
  return `MAHEK ${app.id === "crm" ? "CRM" : app.initials}`;
}
