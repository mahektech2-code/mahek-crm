import type { AppId } from "@/lib/apps";

/* ---------------------------------------------------------------------------
 * The settings pages, one per app that actually has settings.
 *
 * An app with nothing to configure has NO page here, rather than a page that
 * says so. Every app used to get a section whether or not it declared a
 * setting, and the ones that declared none rendered "publishes no
 * configuration schema" above a button into a tab that had been deleted —
 * which is how Website Enquiries, Accounts and Reports came to be dead ends.
 *
 * `owners` are the grants that let somebody who is not a platform
 * administrator open the page: a manager who may write configuration and holds
 * the CRM configures the CRM, and nothing it does not hold.
 *
 * Pure and client-safe — the sidebar reads it. Which setting sits on which
 * page is decided in `lib/config/schema-contract.ts`.
 * ------------------------------------------------------------------------- */

export type SettingsPage = {
  id: string;
  label: string;
  /** One line under the title, saying what these settings decide. */
  blurb: string;
  /**
   * The apps whose holders may open the page without being a platform
   * administrator — if they may write configuration at all. Empty means
   * platform administrators only: these decide things for everybody.
   */
  owners: AppId[];
  /** The sidebar's glyph, from `components/shell/icons.tsx`. */
  icon: string;
};

export const SETTINGS_PAGES: SettingsPage[] = [
  {
    id: "platform",
    label: "Platform",
    blurb: "Sign-in codes, the working day, file uploads and the other settings every app shares.",
    owners: [],
    icon: "settings",
  },
  {
    id: "crm",
    label: "Telecaller CRM",
    blurb: "The call queue, collections, buying cycles and everything else a telecaller's day runs on.",
    owners: ["crm"],
    icon: "phone",
  },
  {
    id: "leads",
    label: "Lead funnel",
    blurb: "The gates a lead must pass, the reason lists, and how leads behave on the handset. Shared by the CRM and the field team.",
    owners: ["crm", "sales"],
    icon: "target",
  },
  {
    id: "sales",
    label: "Sales & field app",
    blurb: "Attendance, tracking, visits, orders, expenses and salesman targets — the office end and the handset.",
    // The handset (`field`) has no web screen of its own; this is where it is configured.
    owners: ["sales", "field"],
    icon: "chart",
  },
  {
    id: "accounts",
    label: "Accounts",
    blurb: "How money is recorded and confirmed, and how price lists are read and discounted.",
    owners: ["accounts"],
    icon: "wallet",
  },
  {
    id: "hrms",
    label: "HRMS",
    blurb: "Check-in, overtime, payroll deductions and performance points.",
    owners: ["hrms"],
    icon: "people",
  },
  {
    id: "erp",
    label: "ERP",
    blurb: "Production tolerances, whether the ERP takes the orders, and its alerts and assistants.",
    owners: ["erp"],
    icon: "clipboard",
  },
  {
    id: "reports",
    label: "Reports",
    blurb: "How the owner's KPIs are measured, and when a customer counts as at risk or lost.",
    owners: ["founder"],
    icon: "eye",
  },
  {
    id: "ai",
    label: "Voice & AI",
    blurb: "Dictation, the call assistant and the other assistants. The keys they call out with are under Integrations.",
    owners: ["crm"],
    icon: "chat",
  },
];

export function settingsPage(id: string): SettingsPage | undefined {
  return SETTINGS_PAGES.find((p) => p.id === id);
}
