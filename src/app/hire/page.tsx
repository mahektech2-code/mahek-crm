import type { Metadata } from "next";
import { requireHireScreen } from "@/lib/hire/access";
import { loadPipeline } from "./_board/load";
import { PipelineView } from "./_board/pipeline-view";
import { PageHead } from "./_ui/kit";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Board" };

/** The recruiter's home: every candidate in this person's scope, by stage. */
export default async function HireBoardPage() {
  const ctx = await requireHireScreen("board");
  const data = await loadPipeline(ctx);
  return (
    <>
      <PageHead
        title="Board"
        sub={
          ctx.role === "interviewer"
            ? "The candidates you are interviewing, by stage. Earlier scores are not shown to you — that is deliberate."
            : "Every candidate in the pipeline. Across all roles the columns group stages by type; pick a role to see and move through its own stages."
        }
      />
      <PipelineView data={data} initialView="kanban" />
    </>
  );
}
