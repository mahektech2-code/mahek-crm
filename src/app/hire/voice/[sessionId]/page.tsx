import { notFound } from "next/navigation";
import { requireHireScreen } from "@/lib/hire/access";
import { voiceView } from "@/lib/hire/services/voice";
import { fdt, PageHead, Pill } from "../../_ui/kit";
import { VoiceReview } from "./voice-review";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI voice screen review" };

/** A completed AI voice screen: listen, read the synced transcript, confirm each score (design §7.8). */
export default async function VoicePage({ params }: { params: Promise<{ sessionId: string }> }) {
  const ctx = await requireHireScreen("interviews");
  const { sessionId } = await params;
  const v = await voiceView(ctx, sessionId);
  if (!v || !v.scoring) notFound();
  const s = v.scoring;
  const who = s.bundle.maskName ? s.bundle.candidateCode : `${s.bundle.candidateName} · ${s.bundle.candidateCode}`;
  return (
    <>
      <PageHead
        back={{ href: "/hire/interviews", label: "Interviews" }}
        title={`AI voice screen · ${who}`}
        sub={`${s.bundle.roleTitle} v${s.bundle.version} · ${fdt(v.startedAt)} · ${Math.max(1, Math.round(v.durationMs / 60000))} min. Listen, read the synced transcript, and confirm each score. Clicking a question plays the audio from that moment.`}
        actions={
          <>
            <Pill tone={v.consent ? "neutral" : "warn"}>{v.consent ? "Recording consent given" : "No recording consent"}</Pill>
            {v.escalated ? <Pill tone="warn">Ended: {v.escalated.replace(/_/g, " ")}</Pill> : null}
          </>
        }
      />
      <VoiceReview v={v} />
    </>
  );
}
