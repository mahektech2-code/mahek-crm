import { notFound } from "next/navigation";
import { nowMs } from "@/lib/format";
import { requireHireScreen } from "@/lib/hire/access";
import { loadWorkspace } from "@/lib/hire/services/interview";
import { Workspace, type WsQuestion } from "./workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Interview" };

/**
 * The interview workspace (design brief §7.3). The server hands the client
 * the questions, the competencies, and the transcript so far — and NO score
 * from any stage. Prior results contaminate an interview, so they never leave
 * the server on this page.
 */
export default async function WorkspacePage({ params, searchParams }: { params: Promise<{ execId: string }>; searchParams: Promise<{ takeover?: string }> }) {
  const ctx = await requireHireScreen("interviews");
  const { execId } = await params;
  const { takeover } = await searchParams;
  const w = await loadWorkspace(ctx, execId);
  if (!w) notFound();

  const comps = new Map(w.competencies.map((c) => [c.key, c.name]));
  const questions: WsQuestion[] = w.questions.map((q) => ({
    key: q.key,
    text: q.text,
    mode: q.mode,
    competencyKeys: q.competencyKeys,
    competency: comps.get(q.competencyKeys[0]) ?? "General",
    inputs: q.mode === "calculated" && q.calc ? (q.calc.kind === "formula" ? q.calc.inputs : [q.calc.input]).map((i) => ({ key: i.key, label: i.label + (i.unit ? ` (${i.unit})` : "") })) : [],
  }));
  const stageComps = [...new Set(w.questions.flatMap((q) => q.competencyKeys))];
  const s = w.session;

  return (
    <Workspace
      execId={w.exec.id}
      applicationId={w.bundle.app.id}
      name={w.bundle.candidate.fullName}
      first={w.bundle.candidate.preferredName || w.bundle.candidate.fullName.split(" ")[0]}
      meta={[w.bundle.blueprint.title, w.stage.name, w.bundle.app.location].filter(Boolean).join(" · ")}
      stageName={w.stage.name}
      questions={questions}
      competencies={w.competencies.filter((c) => stageComps.includes(c.key)).map((c) => ({ key: c.key, name: c.name }))}
      plannedMinutes={w.exec.scheduledMinutes ?? 60}
      conductor={w.conductor}
      aiOn={w.aiOn}
      aiWhy={w.aiWhy}
      takeover={takeover === "1" && Boolean(w.aiLive)}
      nowMs={nowMs()}
      session={
        s
          ? {
              id: s.id,
              status: s.status,
              consent: s.recordingConsent,
              consentAt: s.consentAt ? s.consentAt.toISOString() : null,
              startedAt: s.startedAt.toISOString(),
              segments: s.segments ?? [],
            }
          : null
      }
    />
  );
}
