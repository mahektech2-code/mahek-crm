import { PipelineScreen } from "@/components/sales-lead-pipeline/pipeline-screen";
import { today } from "@/lib/recompute";
import { pipelineFunnel } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";

export const metadata = { title: "Lead Pipeline — Sales Manager — MahekOne" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const day = await today();
  return <PipelineScreen funnel={await pipelineFunnel(day)} />;
}
