import { DashboardScreen } from "@/components/sales-lead-pipeline/dashboard-screen";
import { today } from "@/lib/recompute";
import { pipelineDashboard } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";

export const metadata = { title: "Sales Manager — Lead Pipeline — MahekOne" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const day = await today();
  const data = await pipelineDashboard(day);
  return <DashboardScreen data={data} />;
}
