import { ProtoPipeline } from "@/components/sales-lead-pipeline/proto/pipeline";
import { today } from "@/lib/recompute";
import { pipelineFunnel } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";

export const metadata = { title: "Lead Pipeline — Sales Manager — CRM — MahekOne" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const day = await today();
  return <ProtoPipeline funnel={await pipelineFunnel(day)} />;
}
