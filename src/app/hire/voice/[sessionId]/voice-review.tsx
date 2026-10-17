"use client";

import { useRef, useState } from "react";
import { cx } from "@/components/ui/primitives";
import type { VoiceView } from "@/lib/hire/services/voice";
import { ScoringBoard } from "../../_scoring/scoring-board";
import { Callout, Label } from "../../_ui/kit";

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** The player and transcript on the left, the per-question scores on the right, one clock between them. */
export function VoiceReview({ v }: { v: VoiceView }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dur, setDur] = useState(v.durationMs);
  const play = (ms: number) => {
    const a = audio.current;
    setT(ms);
    if (!a) return;
    a.currentTime = ms / 1000;
    void a.play();
  };
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };
  const at: Record<string, { ms: number; label: string }> = {};
  for (const [k, ms] of Object.entries(v.firstMs)) at[k] = { ms, label: mmss(ms) };
  const current = v.segments.findIndex((g) => t >= g.startMs && t < g.endMs + 400);
  const qLabel = (k?: string) => {
    const i = v.scoring?.questions.findIndex((q) => q.key === k) ?? -1;
    return i >= 0 ? ` · Q${i + 1}` : "";
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-start gap-5">
      <div className="sticky top-4 flex flex-col gap-3">
        <div className="flex flex-col gap-2.5 rounded-[6px] border border-line bg-surface px-4 py-3.5">
          {v.audioUrl ? (
            <>
              <audio
                ref={audio}
                src={v.audioUrl}
                preload="metadata"
                onTimeUpdate={(e) => setT(e.currentTarget.currentTime * 1000)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration * 1000)}
              />
              <div className="flex items-center gap-2.5">
                <button onClick={toggle} aria-label={playing ? "Pause" : "Play"} className="h-9 w-9 cursor-pointer rounded-full border-0 bg-heading text-[13px] text-white">
                  {playing ? "❚❚" : "▶"}
                </button>
                <span className="text-[13px] font-semibold tabular-nums text-heading">{mmss(t)}</span>
                <span className="text-[13px] tabular-nums text-muted">/ {mmss(dur)}</span>
                <span className="flex-1" />
                <span className="text-xs text-muted">{v.talkRatio != null ? `Candidate spoke ${Math.round(v.talkRatio * 100)}% of the words` : ""}</span>
              </div>
              <input type="range" min={0} max={Math.max(1, Math.round(dur))} value={Math.round(t)} onChange={(e) => play(Number(e.target.value))} className="w-full accent-heading" aria-label="Position" />
            </>
          ) : (
            <div className="text-[13px] text-muted">{v.consent ? "No recording was uploaded for this screen." : "Nothing was recorded — the candidate did not agree to recording."} The transcript below is what was said.</div>
          )}
        </div>
        <div className="flex max-h-[calc(100vh-260px)] flex-col gap-3 overflow-y-auto rounded-[6px] border border-line bg-surface px-4 py-3">
          {v.segments.length ? (
            v.segments.map((g, i) => (
              <button
                key={i}
                onClick={() => play(g.startMs)}
                className={cx("cursor-pointer rounded-[4px] border-0 px-2 py-1.5 text-left", i === current ? "bg-brand-soft" : "bg-transparent hover:bg-canvas")}
              >
                <span className="block text-[11px] font-semibold text-muted">
                  {g.speaker === "candidate" ? "Candidate" : "AI interviewer"} · {mmss(g.startMs)}
                  {g.speaker === "ai" ? qLabel(g.questionKey) : ""}
                </span>
                <span className={cx("block", g.speaker === "candidate" ? "font-[family-name:var(--font-evidence)] text-base leading-[26px] text-heading" : "text-sm text-body")}>{g.text}</span>
              </button>
            ))
          ) : (
            <div className="text-[13px] text-muted">No transcript was captured.</div>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {v.recommendation ? (
          <div className="overflow-hidden rounded-[6px] border border-ai-line bg-surface">
            <div className="flex border-b border-ai-line bg-ai-soft px-5 py-2.5 text-ai">
              <span className="flex-1 text-xs font-semibold tracking-[0.04em] uppercase">◈ Screen recommendation</span>
              <span className="text-xs">Confidence: {v.recommendation.confidence}</span>
            </div>
            <div className="px-5 py-3.5 text-sm leading-[21px] text-heading">
              <div className="font-semibold">{v.recommendation.action}</div>
              <div className="mt-1 text-body">{v.recommendation.why}</div>
              <div className="mt-2 text-xs text-muted">Advice only. The screen’s result is what a person confirms below.</div>
            </div>
          </div>
        ) : (
          <Callout tone="muted">No AI recommendation for this screen — the AI was unavailable when it ended. Score each answer below.</Callout>
        )}
        <Label className="mt-2">Per-question assessment</Label>
        {v.scoring ? <ScoringBoard view={v.scoring} seek={v.audioUrl ? { at, play } : undefined} stacked /> : null}
      </div>
    </div>
  );
}
