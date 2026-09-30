/*
 * The CRM's Sales Manager workspace — the prototype's dashboard, drawn over the
 * real Sales Manager pipeline service. The scope is `customers.sales_manager_id`
 * (an administrator sees everything); it travels on the request — see
 * `lib/services/crm-sales-manager-scope.ts`.
 */
import { ProtoDashboard } from "@/components/sales-lead-pipeline/proto/dashboard";
import { today } from "@/lib/recompute";
import { pipelineDashboard } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";

export const metadata = { title: "Sales Manager — CRM — MahekOne" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const day = await today();
  return <ProtoDashboard data={await pipelineDashboard(day)} />;
}
