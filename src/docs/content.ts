import "server-only";
import type { ComponentType } from "react";
import type { DocTab } from "./registry";

/* ---------------------------------------------------------------------------
 * Where each written tab's MDX is. The ONE file that knows.
 *
 * A literal map of static imports rather than a template string, because the
 * bundler has to see every path to compile it — `import(\`./${x}.mdx\`)` would
 * either pull in every file under the folder or none. `coverage.test.ts`
 * checks this map against `registry.ts` in both directions, so a tab marked
 * written with no content, or content no page claims, fails the build.
 * ------------------------------------------------------------------------- */

type Loader = () => Promise<{ default: ComponentType }>;

export const CONTENT: Record<string, Loader> = {
  "platform/architecture/developer": () => import("./platform/architecture/developer.mdx"),
  "platform/architecture/how-it-works": () => import("./platform/architecture/how-it-works.mdx"),
  "platform/backups/developer": () => import("./platform/backups/developer.mdx"),
  "platform/backups/how-it-works": () => import("./platform/backups/how-it-works.mdx"),
  "platform/configuration/developer": () => import("./platform/configuration/developer.mdx"),
  "platform/configuration/how-it-works": () => import("./platform/configuration/how-it-works.mdx"),
  "platform/deploy-digitalocean/developer": () => import("./platform/deploy-digitalocean/developer.mdx"),
  "platform/handset-release/developer": () => import("./platform/handset-release/developer.mdx"),
  "platform/integrations/developer": () => import("./platform/integrations/developer.mdx"),
  "platform/integrations/how-it-works": () => import("./platform/integrations/how-it-works.mdx"),
  "platform/local-setup/developer": () => import("./platform/local-setup/developer.mdx"),
  "platform/sheets-and-jobs/developer": () => import("./platform/sheets-and-jobs/developer.mdx"),
  "platform/sheets-and-jobs/how-it-works": () => import("./platform/sheets-and-jobs/how-it-works.mdx"),
  "platform/storage-r2/developer": () => import("./platform/storage-r2/developer.mdx"),
  "platform/storage-r2/how-it-works": () => import("./platform/storage-r2/how-it-works.mdx"),
  "crm/bills/developer": () => import("./crm/bills/developer.mdx"),
  "crm/bills/guide": () => import("./crm/bills/guide.mdx"),
  "crm/bills/how-it-works": () => import("./crm/bills/how-it-works.mdx"),
  "crm/call-log/developer": () => import("./crm/call-log/developer.mdx"),
  "crm/call-log/guide": () => import("./crm/call-log/guide.mdx"),
  "crm/call-log/how-it-works": () => import("./crm/call-log/how-it-works.mdx"),
  "crm/complaints/developer": () => import("./crm/complaints/developer.mdx"),
  "crm/complaints/guide": () => import("./crm/complaints/guide.mdx"),
  "crm/complaints/how-it-works": () => import("./crm/complaints/how-it-works.mdx"),
  "crm/customers/developer": () => import("./crm/customers/developer.mdx"),
  "crm/customers/guide": () => import("./crm/customers/guide.mdx"),
  "crm/customers/how-it-works": () => import("./crm/customers/how-it-works.mdx"),
  "crm/dashboard/developer": () => import("./crm/dashboard/developer.mdx"),
  "crm/dashboard/guide": () => import("./crm/dashboard/guide.mdx"),
  "crm/dashboard/how-it-works": () => import("./crm/dashboard/how-it-works.mdx"),
  "crm/eod/developer": () => import("./crm/eod/developer.mdx"),
  "crm/eod/guide": () => import("./crm/eod/guide.mdx"),
  "crm/eod/how-it-works": () => import("./crm/eod/how-it-works.mdx"),
  "crm/help-and-settings/developer": () => import("./crm/help-and-settings/developer.mdx"),
  "crm/help-and-settings/guide": () => import("./crm/help-and-settings/guide.mdx"),
  "crm/help-and-settings/how-it-works": () => import("./crm/help-and-settings/how-it-works.mdx"),
  "crm/history/developer": () => import("./crm/history/developer.mdx"),
  "crm/history/guide": () => import("./crm/history/guide.mdx"),
  "crm/history/how-it-works": () => import("./crm/history/how-it-works.mdx"),
  "crm/lead-actions/developer": () => import("./crm/lead-actions/developer.mdx"),
  "crm/lead-actions/guide": () => import("./crm/lead-actions/guide.mdx"),
  "crm/lead-actions/how-it-works": () => import("./crm/lead-actions/how-it-works.mdx"),
  "crm/lead-calling-desk/developer": () => import("./crm/lead-calling-desk/developer.mdx"),
  "crm/lead-calling-desk/guide": () => import("./crm/lead-calling-desk/guide.mdx"),
  "crm/lead-calling-desk/how-it-works": () => import("./crm/lead-calling-desk/how-it-works.mdx"),
  "crm/lead-commercial/developer": () => import("./crm/lead-commercial/developer.mdx"),
  "crm/lead-commercial/guide": () => import("./crm/lead-commercial/guide.mdx"),
  "crm/lead-commercial/how-it-works": () => import("./crm/lead-commercial/how-it-works.mdx"),
  "crm/lead-intake-and-qualification/developer": () => import("./crm/lead-intake-and-qualification/developer.mdx"),
  "crm/lead-intake-and-qualification/guide": () => import("./crm/lead-intake-and-qualification/guide.mdx"),
  "crm/lead-intake-and-qualification/how-it-works": () => import("./crm/lead-intake-and-qualification/how-it-works.mdx"),
  "crm/lead-oversight/developer": () => import("./crm/lead-oversight/developer.mdx"),
  "crm/lead-oversight/guide": () => import("./crm/lead-oversight/guide.mdx"),
  "crm/lead-oversight/how-it-works": () => import("./crm/lead-oversight/how-it-works.mdx"),
  "crm/leads/developer": () => import("./crm/leads/developer.mdx"),
  "crm/leads/guide": () => import("./crm/leads/guide.mdx"),
  "crm/leads/how-it-works": () => import("./crm/leads/how-it-works.mdx"),
  "crm/opportunities/developer": () => import("./crm/opportunities/developer.mdx"),
  "crm/opportunities/guide": () => import("./crm/opportunities/guide.mdx"),
  "crm/opportunities/how-it-works": () => import("./crm/opportunities/how-it-works.mdx"),
  "crm/outstanding/developer": () => import("./crm/outstanding/developer.mdx"),
  "crm/outstanding/guide": () => import("./crm/outstanding/guide.mdx"),
  "crm/outstanding/how-it-works": () => import("./crm/outstanding/how-it-works.mdx"),
  "crm/overview/developer": () => import("./crm/overview/developer.mdx"),
  "crm/overview/guide": () => import("./crm/overview/guide.mdx"),
  "crm/overview/how-it-works": () => import("./crm/overview/how-it-works.mdx"),
  "crm/payments/developer": () => import("./crm/payments/developer.mdx"),
  "crm/payments/guide": () => import("./crm/payments/guide.mdx"),
  "crm/payments/how-it-works": () => import("./crm/payments/how-it-works.mdx"),
  "crm/performance/developer": () => import("./crm/performance/developer.mdx"),
  "crm/performance/guide": () => import("./crm/performance/guide.mdx"),
  "crm/performance/how-it-works": () => import("./crm/performance/how-it-works.mdx"),
  "crm/price-lists/developer": () => import("./crm/price-lists/developer.mdx"),
  "crm/price-lists/guide": () => import("./crm/price-lists/guide.mdx"),
  "crm/price-lists/how-it-works": () => import("./crm/price-lists/how-it-works.mdx"),
  "crm/reminders/developer": () => import("./crm/reminders/developer.mdx"),
  "crm/reminders/guide": () => import("./crm/reminders/guide.mdx"),
  "crm/reminders/how-it-works": () => import("./crm/reminders/how-it-works.mdx"),
  "crm/samples/developer": () => import("./crm/samples/developer.mdx"),
  "crm/samples/guide": () => import("./crm/samples/guide.mdx"),
  "crm/samples/how-it-works": () => import("./crm/samples/how-it-works.mdx"),
  "crm/status-requests/developer": () => import("./crm/status-requests/developer.mdx"),
  "crm/status-requests/guide": () => import("./crm/status-requests/guide.mdx"),
  "crm/status-requests/how-it-works": () => import("./crm/status-requests/how-it-works.mdx"),
  "crm/targets/developer": () => import("./crm/targets/developer.mdx"),
  "crm/targets/guide": () => import("./crm/targets/guide.mdx"),
  "crm/targets/how-it-works": () => import("./crm/targets/how-it-works.mdx"),
  "crm/whatsapp/developer": () => import("./crm/whatsapp/developer.mdx"),
  "crm/whatsapp/guide": () => import("./crm/whatsapp/guide.mdx"),
  "crm/whatsapp/how-it-works": () => import("./crm/whatsapp/how-it-works.mdx"),
};

export function contentKey(app: string, slug: string, tab: DocTab): string {
  return `${app}/${slug}/${tab}`;
}

export async function loadContent(app: string, slug: string, tab: DocTab): Promise<ComponentType | null> {
  const load = CONTENT[contentKey(app, slug, tab)];
  return load ? (await load()).default : null;
}
