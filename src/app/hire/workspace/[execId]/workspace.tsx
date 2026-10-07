"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import type { HireSegment } from "@/db/schema";
import { addTranscriptLine, askCopilot, copilotAction, endInterview, startInterview } from "@/lib/hire/actions/interview";
import type { CopilotOut } from "@/lib/hire/ai/copilot";
import { AiMark, Btn, Callout, Icon, Label } from "../../_ui/kit";

/* ---------------------------------------------------------------------------
 * THE INTERVIEW WORKSPACE (design brief §7.3). An interviewer is talking to a
 * person while this is open, so nothing here may demand attention: nothing
 * flashes, nothing animates in, the copilot speaks only after the candidate
 * has finished an answer, and no earlier score is anywhere on the page.
 *
 * Recording is chunked: every ~15 seconds — and whenever the interviewer
 * changes who is speaking or which question is current — the chunk is cut and
 * sent to /api/hire/transcribe, which appends one segment. Cutting on a
 * speaker change is what keeps the labelling honest without diarisation the
 * browser cannot do.
 * ------------------------------------------------------------------------- */

export type WsQuestion = {
  key: string;
  text: string;
  mode: string;
  competencyKeys: string[];
  competency: string;
  inputs: { key: string; label: string }[];
};

type Session = { id: string; status: string; consent: boolean; consentAt: string | null; startedAt: string; segments: HireSegment[] };
type Speaker = "interviewer" | "candidate";

const CHUNK_MS = 15_000;

const clockOf = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const mmss = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  return `${m} min`;
};

export function Workspace(props: {
  execId: string;
  applicationId: string;
  name: string;
  first: string;
  meta: string;
  stageName: string;
  questions: WsQuestion[];
  competencies: { key: string; name: string }[];
  plannedMinutes: number;
  conductor: string;
  aiOn: boolean;
  aiWhy: string | null;
  takeover: boolean;
  nowMs: number;
  session: Session | null;
}) {
  const s = props.session;
  return (
    <div className="-mx-6 -mt-6 -mb-12 flex h-[calc(100vh-56px)] min-h-[560px] flex-col">
      <div className="flex flex-none items-center gap-3 border-b border-line bg-surface px-6 py-3">
        <Link href="/hire/interviews" title="Back" className="flex h-8 w-8 items-center justify-center rounded-[4px] border border-line text-body no-underline">
          <Icon n="back" s={16} />
        </Link>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[18px] leading-6 font-semibold text-heading">{props.name}</span>
          <span className="block truncate text-[13px] text-muted">{props.meta}</span>
        </span>
        <span className="text-[13px] text-muted">Prior stage scores are hidden during the interview.</span>
      </div>
      {!s ? (
        <Consent {...props} />
      ) : s.status !== "live" ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-[520px] rounded-[6px] border border-line bg-surface p-6 text-center">
            <div className="text-[15px] font-semibold text-heading">This interview has ended</div>
            <p className="mt-1.5 mb-4 text-sm text-muted">The answers are waiting on the scoring screen. Nothing counts until a person confirms each score.</p>
            <Link href={`/hire/scoring/${props.execId}`} className="inline-flex h-9 items-center rounded-[4px] bg-brand px-3.5 text-sm font-medium text-white no-underline hover:bg-brand-hover hover:no-underline">
              Go to scoring
            </Link>
          </div>
        </div>
      ) : (
        <Running {...props} session={s} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- consent */

function Consent(props: Parameters<typeof Workspace>[0]) {
  const router = useRouter();
  const [tick, setTick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (consent: boolean) => {
    setBusy(true);
    setError(null);
    const r = await startInterview(props.execId, consent, props.takeover);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.refresh();
  };
  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto p-10">
      <div className="w-full max-w-[620px] rounded-[6px] border border-line bg-surface p-7">
        <div className="text-[18px] font-semibold text-heading">{props.takeover ? "Take over from the AI interviewer" : "Before you start"}</div>
        {props.takeover ? <p className="mt-1.5 mb-0 text-sm text-muted">The AI voice screen ends the moment you start, and is marked as taken over by you.</p> : null}
        <div className="mt-4 text-sm leading-6 text-body">
          Read this to {props.first}:{" "}
          <span className="text-heading">
            “This interview is recorded and transcribed so the hiring team can review what you said. An AI helps us score answers against the same questions every candidate is asked, and a person makes every decision. Is that all right with you?”
          </span>
        </div>
        <label className="mt-5 flex cursor-pointer items-center gap-2.5 text-sm text-heading">
          <input type="checkbox" checked={tick} onChange={(e) => setTick(e.target.checked)} className="h-4 w-4 accent-[var(--color-brand)]" />
          {props.first} agreed to recording, out loud
        </label>
        {!props.aiOn ? <Callout tone="warn" className="mt-4">{props.aiWhy} Recording consent is still recorded; you will take notes as you go.</Callout> : null}
        {error ? <Callout tone="danger" className="mt-4">{error}</Callout> : null}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Btn disabled={busy} onClick={() => go(false)}>
            Continue without recording
          </Btn>
          <Btn kind="primary" disabled={!tick || busy} title={tick ? undefined : "Tick that they agreed, out loud, first"} onClick={() => go(true)}>
            Start recording
          </Btn>
        </div>
        <p className="mt-4 mb-0 text-[13px] text-muted">Without consent the interview goes ahead with your notes only. Nothing is recorded or transcribed.</p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- running */

type Cop = { kind: "off"; reason: string } | { kind: "idle" } | { kind: "thinking" } | { kind: "on"; out: CopilotOut };

function Running(props: Parameters<typeof Workspace>[0] & { session: Session }) {
  const router = useRouter();
  const { session } = props;
  const startedMs = new Date(session.startedAt).getTime();
  const [segments, setSegments] = useState<HireSegment[]>(session.segments);
  const firstOpen = props.questions.find((q) => !session.segments.some((g) => g.speaker === "candidate" && g.questionKey === q.key));
  const [current, setCurrent] = useState<string | null>(firstOpen?.key ?? props.questions[0]?.key ?? null);
  const [speaker, setSpeaker] = useState<Speaker>(session.segments.length && session.segments[session.segments.length - 1].speaker === "interviewer" ? "candidate" : "interviewer");
  const [now, setNow] = useState(props.nowMs);
  const [paused, setPaused] = useState(false);
  const [draft, setDraft] = useState("");
  const [captured, setCaptured] = useState<Record<string, Record<string, string>>>({});
  const [cop, setCop] = useState<Cop>(props.aiOn ? { kind: "idle" } : { kind: "off", reason: props.aiWhy ?? "AI is unavailable." });
  const [rec, setRec] = useState<"off" | "starting" | "on" | "refused" | "failed">("off");
  const [recWhy, setRecWhy] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [widths, setWidths] = useState<[number, number]>([300, 340]);

  const txRef = useRef<HTMLDivElement>(null);
  const meta = useRef<{ speaker: Speaker; question: string | null }>({ speaker, question: current });
  const cutRef = useRef<(() => void) | null>(null);
  const copTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copBusy = useRef(false);

  const transcribing = session.consent && props.aiOn && rec !== "refused" && rec !== "failed";

  /* The clock — an external thing to keep in step with. */
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  /* Auto-scroll, unless the interviewer has scrolled up to read. */
  useEffect(() => {
    const el = txRef.current;
    if (el && !paused) el.scrollTop = el.scrollHeight;
  }, [segments, paused]);

  const runCopilot = useCallback(() => {
    if (!props.aiOn || copBusy.current) return;
    copBusy.current = true;
    setCop({ kind: "thinking" });
    void askCopilot(props.execId, meta.current.question).then((r) => {
      copBusy.current = false;
      if (!r.ok) return setCop({ kind: "off", reason: r.error });
      setCop(r.data.on ? { kind: "on", out: r.data.out } : r.data.reason.startsWith("Waiting") ? { kind: "idle" } : { kind: "off", reason: r.data.reason });
    });
  }, [props.aiOn, props.execId]);

  /* After the CANDIDATE finishes an answer — never mid-sentence — the copilot is asked, once, a few seconds later. */
  const candidateSpoke = useCallback(() => {
    if (copTimer.current) clearTimeout(copTimer.current);
    copTimer.current = setTimeout(runCopilot, 4000);
  }, [runCopilot]);

  const append = useCallback(
    (seg: HireSegment) => {
      setSegments((prev) => [...prev, seg]);
      if (seg.speaker === "candidate") candidateSpoke();
    },
    [candidateSpoke],
  );

  /* Recording: chunks cut every 15s, or when who-is-speaking / the question changes. */
  useEffect(() => {
    if (!session.consent || !props.aiOn) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const upload = async (blob: Blob, sp: Speaker, q: string | null, startMs: number, endMs: number) => {
      if (blob.size < 2000) return;
      setPending((n) => n + 1);
      const fd = new FormData();
      fd.set("execId", props.execId);
      fd.set("speaker", sp);
      fd.set("questionKey", q ?? "");
      fd.set("startMs", String(startMs));
      fd.set("endMs", String(endMs));
      fd.set("audio", blob, "chunk.webm");
      try {
        const res = await fetch("/api/hire/transcribe", { method: "POST", body: fd });
        const j = (await res.json()) as { ok: boolean; segment?: HireSegment | null; error?: string };
        if (j.ok && j.segment) append(j.segment);
        else if (!j.ok) {
          setRecWhy(j.error ?? "Transcription failed for that part.");
          if (res.status === 503 || res.status === 403) {
            stopped = true;
            setRec("failed");
            recorder?.stop();
          }
        }
      } catch {
        setRecWhy("A part could not be sent. The interview carries on — type a note for it if it mattered.");
      } finally {
        setPending((n) => n - 1);
      }
    };

    const startChunk = () => {
      if (stopped || !stream) return;
      const r = new MediaRecorder(stream);
      recorder = r;
      const parts: Blob[] = [];
      const at = { sp: meta.current.speaker, q: meta.current.question, start: Date.now() - startedMs };
      r.ondataavailable = (e) => {
        if (e.data.size) parts.push(e.data);
      };
      r.onstop = () => {
        const end = Date.now() - startedMs;
        void upload(new Blob(parts, { type: r.mimeType || "audio/webm" }), at.sp, at.q, at.start, end);
        if (!stopped) startChunk();
      };
      r.start();
      timer = setTimeout(() => r.state !== "inactive" && r.stop(), CHUNK_MS);
    };

    cutRef.current = () => {
      if (timer) clearTimeout(timer);
      if (recorder && recorder.state !== "inactive") recorder.stop();
    };

    const media = typeof navigator !== "undefined" && typeof MediaRecorder !== "undefined" ? navigator.mediaDevices : undefined;
    const ask = media ? media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }) : Promise.reject(new Error("unsupported"));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reflects the microphone, an external system
    setRec("starting");
    ask
      .then((st) => {
        if (stopped) return st.getTracks().forEach((t) => t.stop());
        stream = st;
        setRec("on");
        startChunk();
      })
      .catch(() => {
        setRec("refused");
        setRecWhy(media ? "The microphone was not allowed. Carry on with notes — type what the candidate says." : "This browser cannot record. Carry on with notes.");
      });

    return () => {
      stopped = true;
      cutRef.current = null;
      if (timer) clearTimeout(timer);
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [session.consent, props.aiOn, props.execId, startedMs, append]);

  const cut = () => cutRef.current?.();

  const switchSpeaker = useCallback((to?: Speaker) => {
    const next: Speaker = to ?? (meta.current.speaker === "interviewer" ? "candidate" : "interviewer");
    if (next === meta.current.speaker) return;
    cutRef.current?.();
    meta.current.speaker = next;
    setSpeaker(next);
  }, []);

  const pickQuestion = (key: string) => {
    if (key === meta.current.question) return;
    cut();
    meta.current = { speaker: "interviewer", question: key };
    setCurrent(key);
    setSpeaker("interviewer");
  };

  /* `S` switches who is speaking — the one shortcut, so a hand on the keyboard never has to find the mouse. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement | null)?.tagName;
      if (t === "INPUT" || t === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        switchSpeaker();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [switchSpeaker]);

  const addLine = async (sp: Speaker) => {
    const text = draft.trim();
    if (!text) return;
    setError(null);
    const r = await addTranscriptLine(props.execId, { speaker: sp, text, questionKey: current });
    if (!r.ok) return setError(r.error);
    setDraft("");
    append(r.data);
  };

  /* Coverage: a competency is probed once the candidate has answered a question that tests it. */
  const answered = useMemo(() => new Set(segments.filter((g) => g.speaker === "candidate" && g.questionKey).map((g) => g.questionKey!)), [segments]);
  const probed = new Set(props.questions.filter((q) => answered.has(q.key)).flatMap((q) => q.competencyKeys));
  const unprobed = props.competencies.filter((c) => !probed.has(c.key));
  const elapsed = Math.max(0, now - startedMs);
  const lowTime = elapsed > props.plannedMinutes * 60_000 * 0.75 && unprobed.length > 0;

  const groups = useMemo(() => {
    const m = new Map<string, WsQuestion[]>();
    for (const q of props.questions) m.set(q.competency, [...(m.get(q.competency) ?? []), q]);
    return [...m.entries()];
  }, [props.questions]);

  const dur = (g: HireSegment) => Math.max(0, g.endMs - g.startMs) || g.text.length * 60;
  const candT = segments.filter((g) => g.speaker === "candidate").reduce((n, g) => n + dur(g), 0);
  const allT = segments.reduce((n, g) => n + dur(g), 0);
  const talk = allT ? `Candidate spoke ${Math.round((candT / allT) * 100)}% of the time` : "Nobody has spoken yet";

  const end = async () => {
    setEnding(true);
    setError(null);
    cut();
    const nums: Record<string, Record<string, number>> = {};
    for (const [q, vals] of Object.entries(captured)) {
      nums[q] = {};
      for (const [k, v] of Object.entries(vals)) if (v.trim() !== "" && Number.isFinite(Number(v))) nums[q][k] = Number(v);
    }
    const r = await endInterview(props.execId, nums);
    if (!r.ok) {
      setEnding(false);
      return setError(r.error);
    }
    router.push(r.data.href);
  };

  const drag = (which: 0 | 1) => (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = widths[which];
    const move = (ev: PointerEvent) => {
      const d = ev.clientX - x0;
      const w = Math.max(220, Math.min(520, which === 0 ? w0 + d : w0 - d));
      setWidths((p) => (which === 0 ? [w, p[1]] : [p[0], w]));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const recLine = session.consent
    ? rec === "on"
      ? `Recording · consent obtained ${session.consentAt ? clockOf(session.consentAt) : ""}`
      : rec === "starting"
        ? "Starting the microphone…"
        : props.aiOn
          ? `Not recording — ${recWhy ?? "the microphone is off"} · consent obtained ${session.consentAt ? clockOf(session.consentAt) : ""}`
          : `Transcription unavailable — notes only · consent obtained ${session.consentAt ? clockOf(session.consentAt) : ""}`
    : "Not recording — no consent, notes only";

  const nameOf = (g: HireSegment) => (g.speaker === "candidate" ? (g.name?.startsWith("Noted by") ? `${props.first} · ${g.name}` : props.first) : g.speaker === "ai" ? "AI interviewer" : g.name ? (g.name === props.conductor ? "You" : g.name) : "You");

  return (
    <>
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: `${widths[0]}px 6px minmax(320px,1fr) 6px ${widths[1]}px` }}>
        {/* QUESTIONS */}
        <section className="flex min-h-0 flex-col overflow-y-auto bg-surface px-4 py-4">
          <Label className="mb-3">Questions · {props.stageName}</Label>
          {groups.map(([comp, qs]) => (
            <div key={comp} className="mb-3">
              <div className="mb-1 text-[12px] font-medium text-muted">{comp}</div>
              {qs.map((q) => {
                const on = current === q.key;
                const done = answered.has(q.key);
                return (
                  <button
                    key={q.key}
                    onClick={() => pickQuestion(q.key)}
                    className={cx(
                      "mb-1 flex w-full cursor-pointer items-start gap-2.5 rounded-[4px] border px-2.5 py-2 text-left",
                      on ? "border-brand bg-brand-soft" : "border-transparent bg-transparent hover:bg-canvas",
                    )}
                  >
                    <span className={cx("mt-1.5 h-2 w-2 flex-none rounded-full", on ? "bg-brand" : done ? "bg-success" : "border border-line-strong")} aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-[13px] leading-[18px] text-heading">{q.text}</span>
                      <span className="text-[12px] text-muted">{on ? "current" : done ? "answered" : q.mode === "ai_rubric" ? "not asked" : q.mode === "calculated" ? "figures below" : "selected on the scoring page"}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          <div className="mt-2 border-t border-divider pt-3 text-[13px] text-muted">
            <div>
              <span className="font-semibold text-heading tabular-nums">{mmss(elapsed)}</span> elapsed of {props.plannedMinutes}
            </div>
            <div>{unprobed.length ? `${unprobed.length} competenc${unprobed.length === 1 ? "y" : "ies"} unprobed` : "Every competency has been probed"}</div>
          </div>
          {props.questions.some((q) => q.inputs.length) ? (
            <div className="mt-4 border-t border-divider pt-3">
              <Label className="mb-2">Captured figures</Label>
              {props.questions
                .filter((q) => q.inputs.length)
                .map((q) => (
                  <div key={q.key} className="mb-2.5">
                    <div className="mb-1 text-[12px] text-muted">{q.text}</div>
                    {q.inputs.map((i) => (
                      <label key={i.key} className="mb-1 flex items-center justify-between gap-2 text-[13px] text-body">
                        <span className="truncate">{i.label}</span>
                        <input
                          inputMode="decimal"
                          value={captured[q.key]?.[i.key] ?? ""}
                          onChange={(e) => setCaptured((p) => ({ ...p, [q.key]: { ...(p[q.key] ?? {}), [i.key]: e.target.value } }))}
                          className="h-7 w-24 rounded-[4px] border border-line-strong px-2 text-right text-[13px] tabular-nums"
                        />
                      </label>
                    ))}
                  </div>
                ))}
            </div>
          ) : null}
        </section>
        <div onPointerDown={drag(0)} className="cursor-col-resize border-x border-line bg-page hover:bg-divider" role="separator" aria-orientation="vertical" aria-label="Resize questions" />

        {/* TRANSCRIPT */}
        <section className="flex min-h-0 flex-col bg-surface">
          <div className="flex flex-none items-center justify-between gap-3 border-b border-divider px-5 py-2.5">
            <Label>{transcribing ? "Live transcript" : "Your notes"}</Label>
            <div className="flex items-center gap-2 text-[13px]">
              {paused ? (
                <button onClick={() => setPaused(false)} className="cursor-pointer border-0 bg-transparent text-brand-hover">
                  Resume auto-scroll ↓
                </button>
              ) : null}
              {transcribing ? (
                <span className="flex items-center gap-1 rounded-[6px] border border-line p-[3px]" title="Press S to switch">
                  {(["interviewer", "candidate"] as const).map((sp) => (
                    <button key={sp} onClick={() => switchSpeaker(sp)} className={cx("h-6 cursor-pointer rounded-[4px] border-0 px-2 text-xs", speaker === sp ? "bg-heading text-white" : "bg-transparent text-body")}>
                      {sp === "interviewer" ? "You speaking" : `${props.first} speaking`}
                    </button>
                  ))}
                  <span className="px-1 text-[11px] text-muted">S</span>
                </span>
              ) : null}
            </div>
          </div>
          {!transcribing ? (
            <div className="flex-none border-b border-warn-line bg-warn-soft px-5 py-2 text-[13px] text-warn-ink">
              {!session.consent ? "No recording consent — write what the candidate says, in their words where you can." : (recWhy ?? props.aiWhy ?? "Transcription is unavailable.") + " Your notes become the answers that are scored."}
            </div>
          ) : null}
          <div
            ref={txRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              if (!atBottom && !paused) setPaused(true);
              if (atBottom && paused) setPaused(false);
            }}
            className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
          >
            {segments.length ? (
              segments.map((g, i) => (
                <div key={i} className="mb-4">
                  <div className="text-[12px] font-medium text-muted">
                    {nameOf(g)} <span className="font-normal tabular-nums">{clockOf(new Date(startedMs + g.startMs).toISOString())}</span>
                    {g.language && g.language !== "en" && g.language !== "English" ? <span className="font-normal"> · {g.language}</span> : null}
                  </div>
                  <div className={cx("mt-0.5 leading-6", g.speaker === "candidate" ? "font-[family-name:var(--font-evidence)] text-[16px] text-heading" : "text-sm text-body")}>{g.text}</div>
                </div>
              ))
            ) : (
              <div className="text-sm text-muted">{transcribing ? "Listening. The transcript appears here as each part is heard." : "Nothing written yet."}</div>
            )}
            {pending > 0 ? <div className="text-[12px] text-muted">Transcribing {pending} part{pending === 1 ? "" : "s"}…</div> : null}
          </div>
          <div className="flex-none border-t border-divider px-5 py-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              placeholder={transcribing ? "Add a note to the transcript — something the microphone may have missed" : "What the candidate said — in their words where you can"}
              className="w-full resize-none rounded-[4px] border border-line-strong px-2.5 py-2 text-sm leading-5 text-heading"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[12px] text-muted">Filed under: {props.questions.find((q) => q.key === current)?.text.slice(0, 60) ?? "no question"}</span>
              <span className="flex gap-2">
                <Btn size="sm" disabled={!draft.trim()} onClick={() => addLine("interviewer")}>
                  Add as my question
                </Btn>
                <Btn size="sm" kind="primary" disabled={!draft.trim()} onClick={() => addLine("candidate")}>
                  Add as {props.first}’s answer
                </Btn>
              </span>
            </div>
          </div>
        </section>
        <div onPointerDown={drag(1)} className="cursor-col-resize border-x border-line bg-page hover:bg-divider" role="separator" aria-orientation="vertical" aria-label="Resize copilot" />

        {/* COPILOT */}
        <section className="flex min-h-0 flex-col overflow-y-auto bg-page px-4 py-4">
          {cop.kind === "off" ? (
            <div className="rounded-[6px] border border-line bg-surface p-3.5 text-[13px] leading-[19px] text-muted">
              The copilot is unavailable{cop.reason ? ` — ${cop.reason}` : ""}. Keep to the question list; coverage and contradictions are checked after the interview when AI returns.
            </div>
          ) : null}
          <div className="rounded-[6px] border border-ai-line bg-surface p-3.5">
            <div className="mb-2 text-[13px] font-medium text-ai">
              <AiMark /> Coverage
            </div>
            {props.competencies.map((c) => (
              <div key={c.key} className="flex items-center gap-2 py-0.5 text-[13px] text-body">
                <span className={probed.has(c.key) ? "text-success" : "text-faint"}>{probed.has(c.key) ? "✓" : "○"}</span>
                {c.name}
              </div>
            ))}
          </div>
          {cop.kind !== "off" ? (
            <div className="mt-3 rounded-[6px] border border-ai-line bg-surface p-3.5">
              <div className="mb-2 text-[13px] font-medium text-ai">
                <AiMark /> Suggested next
              </div>
              {cop.kind === "on" && cop.out.suggestion ? (
                <>
                  <div className="text-sm leading-5 text-heading">“{cop.out.suggestion}”</div>
                  <div className="mt-1.5 text-[13px] leading-[18px] text-muted">{cop.out.why}</div>
                  <div className="mt-3 flex gap-2">
                    <Btn
                      size="sm"
                      onClick={() => {
                        const sug = cop.out.suggestion!;
                        void copilotAction(props.execId, "suggestion", sug, "used");
                        if (cop.out.suggestionKey) pickQuestion(cop.out.suggestionKey);
                        setCop({ kind: "on", out: { ...cop.out, suggestion: null } });
                      }}
                    >
                      Ask
                    </Btn>
                    <Btn
                      size="sm"
                      kind="ghost"
                      onClick={() => {
                        void copilotAction(props.execId, "suggestion", cop.out.suggestion!, "dismissed");
                        setCop({ kind: "on", out: { ...cop.out, suggestion: null } });
                      }}
                    >
                      Dismiss
                    </Btn>
                  </div>
                </>
              ) : (
                <div className="text-[13px] text-muted">{cop.kind === "thinking" ? "Reading the last answer…" : "Appears after the candidate finishes an answer."}</div>
              )}
              {cop.kind === "idle" || (cop.kind === "on" && !cop.out.suggestion) ? (
                <button onClick={runCopilot} className="mt-2 cursor-pointer border-0 bg-transparent p-0 text-[13px] text-brand-hover">
                  Suggest now
                </button>
              ) : null}
            </div>
          ) : null}
          {cop.kind === "on" && cop.out.contradiction ? (
            <div className="mt-3 rounded-[6px] border border-warn-line bg-surface p-3.5">
              <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-warn-ink">
                <Icon n="warn" s={14} /> Check this
              </div>
              <div className="text-[12px] text-muted">{cop.out.contradiction.earlierSource}</div>
              <div className="mb-2 border-l-2 border-line-strong pl-2.5 font-[family-name:var(--font-evidence)] text-[15px] leading-6 text-heading">{cop.out.contradiction.earlier}</div>
              <div className="text-[12px] text-muted">Just now</div>
              <div className="border-l-2 border-line-strong pl-2.5 font-[family-name:var(--font-evidence)] text-[15px] leading-6 text-heading">“{cop.out.contradiction.said}”</div>
              <div className="mt-2.5 text-[13px] leading-[18px] text-ai">
                <AiMark /> Something to ask about, not a conclusion. Try: “{cop.out.contradiction.probe}”
              </div>
              <button
                onClick={() => {
                  void copilotAction(props.execId, "contradiction", cop.out.contradiction!.probe, "dismissed");
                  setCop({ kind: "on", out: { ...cop.out, contradiction: null } });
                }}
                className="mt-2 cursor-pointer border-0 bg-transparent p-0 text-[13px] text-muted"
              >
                Dismiss
              </button>
            </div>
          ) : null}
          {lowTime ? (
            <div className="mt-3 rounded-[6px] border border-line bg-surface p-3.5 text-[13px] leading-[19px] text-body">
              Time is short and {unprobed.map((c) => c.name).join(", ")} {unprobed.length === 1 ? "is" : "are"} still unprobed.
            </div>
          ) : null}
        </section>
      </div>

      <div className="flex flex-none items-center gap-3 border-t border-line bg-surface px-6 py-2.5 text-[13px] text-body">
        <span className={cx("h-2 w-2 rounded-full", session.consent && rec === "on" ? "bg-danger" : "bg-line-strong")} aria-hidden />
        <span>{recLine}</span>
        <span className="text-faint">·</span>
        <span>{talk}</span>
        <span className="flex-1" />
        {error ? <span className="text-danger">{error}</span> : null}
        {confirmEnd ? (
          <>
            <span>End the interview? The answers go to scoring.</span>
            <Btn size="sm" onClick={() => setConfirmEnd(false)} disabled={ending}>
              Keep going
            </Btn>
            <Btn size="sm" kind="primary" onClick={end} disabled={ending}>
              {ending ? "Ending…" : "End interview"}
            </Btn>
          </>
        ) : (
          <Btn size="sm" kind="primary" onClick={() => setConfirmEnd(true)}>
            End interview
          </Btn>
        )}
      </div>
    </>
  );
}
