import { notFound } from "next/navigation";
import { requireHireScreen } from "@/lib/hire/access";
import { scoringView } from "@/lib/hire/services/scoring";
import { ScoringBoard } from "../../_scoring/scoring-board";
import { PageHead, Pill } from "../../_ui/kit";

export const dynamic = "force-dynamic";
export const metadata = { title: "Scoring review" };

/** One stage's questions, each confirmed by a person (design §7.4). */
export default async function ScoringPage({ params }: { params: Promise<{ execId: string }> }) {
  const ctx = await requireHireScreen("review");
  const { execId } = await params;
  const view = await scoringView(ctx, execId);
  if (!view) notFound();
  const who = view.bundle.maskName ? view.bundle.candidateCode : `${view.bundle.candidateName} · ${view.bundle.candidateCode}`;
  return (
    <>
      <PageHead
        back={{ href: "/hire/review", label: "To review" }}
        title={`${view.stage.name} · ${who}`}
        sub={`${view.bundle.roleTitle} v${view.bundle.version}${view.bundle.location ? ` · ${view.bundle.location}` : ""} · ${view.questions.length} questions, ${view.stage.maxPoints} points. AI scores count only once a person accepts, adjusts or replaces them.`}
        actions={
          view.exec.superseded ? <Pill tone="muted">Superseded by a correction</Pill> : view.exec.status === "completed" ? <Pill tone="neutral">Completed</Pill> : <Pill tone="warn">Awaiting confirmation</Pill>
        }
      />
      <ScoringBoard view={view} />
    </>
  );
}
