import type { Metadata } from "next";
import { requireHireScreen } from "@/lib/hire/access";
import { loadPipeline } from "../_board/load";
import { PipelineView } from "../_board/pipeline-view";
import { PageHead } from "../_ui/kit";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Candidates" };

/** The same pipeline as a dense table — sort, filter and act in bulk. */
export default async function HireCandidatesPage() {
  const ctx = await requireHireScreen("candidates");
  const data = await loadPipeline(ctx);
  return (
    <>
      <PageHead title="Candidates" sub="The same pipeline as a dense table — sort, filter and act in bulk." />
      <PipelineView data={data} initialView="table" />
    </>
  );
}
