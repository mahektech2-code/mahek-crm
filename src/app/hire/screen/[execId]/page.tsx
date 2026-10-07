import { notFound } from "next/navigation";
import { requireHireScreen } from "@/lib/hire/access";
import { realtimeState, screenTarget, sessionsFor } from "@/lib/hire/services/voice";
import { BtnLink, Callout, fdt, Label, PageHead, Panel, Pill } from "../../_ui/kit";
import { LiveScreen } from "./live-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI voice screen" };

/**
 * Run an AI voice screen in the browser (spec §5.3). The candidate speaks on
 * this device with a recruiter present — calling out to a phone is not built.
 */
export default async function ScreenPage({ params }: { params: Promise<{ execId: string }> }) {
  const ctx = await requireHireScreen("interviews");
  const { execId } = await params;
  const t = await screenTarget(ctx, execId);
  if (!t) notFound();
  const [state, sessions] = await Promise.all([realtimeState(), sessionsFor(execId)]);
  const here = t.b.app.status === "in_progress" && t.b.app.stageKey === t.stage.key;
  return (
    <>
      <PageHead
        back={{ href: "/hire/interviews", label: "Interviews" }}
        title={`${t.stage.name} · ${t.b.candidate.fullName}`}
        sub={`${t.b.blueprint.title} v${t.b.blueprint.version} · ${t.stage.questions.length} questions, asked in order by the AI interviewer. It tells the candidate it is an AI, asks consent to record, and never says how they did.`}
      />
      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-6">
        <div className="flex flex-col gap-4">
          {!here ? (
            <Callout tone="warn">{t.b.candidate.fullName} is not at {t.stage.name} any more, so a new screen cannot be started.</Callout>
          ) : !state.on ? (
            <Panel title="The AI interviewer is unavailable">
              <p className="m-0 text-sm text-body">{state.reason}</p>
              <p className="mt-2 mb-4 text-sm text-body">The screen falls back to a person: schedule a human screen, and score it on the same rubric.</p>
              <BtnLink href={`/hire/c/${t.b.app.id}`} kind="primary">
                Schedule a human screen instead
              </BtnLink>
            </Panel>
          ) : !ctx.can("interview") ? (
            <Callout tone="muted">Running a screen needs an interviewing role in Hire.</Callout>
          ) : (
            <LiveScreen execId={execId} applicationId={t.b.app.id} candidateName={t.b.candidate.fullName} />
          )}
          <Callout tone="muted">
            This runs in the browser: the candidate speaks into this device’s microphone. Calling a candidate’s phone is not part of Hire yet. If the candidate asks for a person, is distressed or refuses recording, the AI stops and the screen is handed to a person.
          </Callout>
        </div>
        <div className="flex flex-col gap-4">
          <Panel title="What the AI will ask" sub="From the blueprint’s AI screen stage, in order. It asks nothing outside this list.">
            <ol className="m-0 flex flex-col gap-2.5 pl-5 text-sm text-body">
              {t.stage.questions.map((q) => (
                <li key={q.key}>
                  {q.text}
                  {q.probes.length ? <div className="text-xs text-muted">Follow-up: {q.probes.join(" / ")}</div> : null}
                </li>
              ))}
            </ol>
          </Panel>
          {sessions.length ? (
            <Panel title="Earlier attempts" pad={false}>
              {sessions.map((s) => (
                <div key={s.id} className="flex items-center gap-2 border-b border-canvas px-5 py-2.5 text-[13px] last:border-b-0">
                  <span className="flex-1 text-body">{fdt(s.startedAt)}</span>
                  <Pill tone={s.status === "ended" ? "neutral" : "warn"}>{s.escalated ? s.escalated.replace(/_/g, " ") : s.status}</Pill>
                  {s.status !== "live" ? (
                    <BtnLink href={`/hire/voice/${s.id}`} size="sm" kind="ghost">
                      Review
                    </BtnLink>
                  ) : null}
                </div>
              ))}
            </Panel>
          ) : null}
          <div>
            <Label>Disclosure</Label>
            <p className="mt-1 text-[13px] text-muted">“I am an AI interviewer, not a person. A person at Mahek reviews everything from this call and makes every decision. You can ask for a person at any time.”</p>
          </div>
        </div>
      </div>
    </>
  );
}
