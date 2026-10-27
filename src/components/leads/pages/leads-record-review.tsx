import { notFound } from "next/navigation";
import { type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { loadQualificationReview } from "@/lib/services/lead-qualification-review-service";
import { QualificationReviewScreen } from "@/components/leads/review/qualification-review-screen";

/**
 * The unified Qualification Review, mounted by both Lead Management workspaces
 * from one file. A lead the viewer may not see and one that does not exist are
 * one answer — a 404 that told them apart would make the URL a way to find out
 * whose book an id belongs to.
 */
export async function Body({
  workspace,
  params,
}: {
  workspace: LeadWorkspace;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();
  const model = await loadQualificationReview(id, user);
  if (!model) notFound();
  /* Keyed on the lead, so moving between two remounts with fresh draft state. */
  return <QualificationReviewScreen key={model.customerId} workspace={workspace} model={model} />;
}
