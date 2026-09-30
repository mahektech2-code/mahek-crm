/*
 * The CRM's Sales Manager workspace — the same dashboard the Sales Dashboard's
 * `/sales-lead-pipeline` draws, read through the CRM Sales Manager's own scope
 * (`customers.sales_manager_id` = the signed-in person; an administrator sees
 * everything). Nothing here decides anything: the figures, the gates and the
 * actions are the shared Sales Manager service's, and the scope travels on the
 * request — see `lib/services/crm-sales-manager-scope.ts`.
 */
import { DashboardScreen } from "@/components/sales-lead-pipeline/dashboard-screen";
import { today } from "@/lib/recompute";
import { pipelineDashboard } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";

export const metadata = { title: "Sales Manager — CRM — MahekOne" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const day = await today();
  const data = await pipelineDashboard(day);
  return <DashboardScreen data={data} workspace="crm" />;
}
