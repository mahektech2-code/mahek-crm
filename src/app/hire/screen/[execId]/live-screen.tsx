"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { Btn, Callout, Label } from "../../_ui/kit";

/* ---------------------------------------------------------------------------
 * The live AI voice screen, over WebRTC to the Realtime API.
 *
 * The browser holds only a ten-minute client secret. The page listens to the
 * data channel for three things: what the candidate said (input
 * transcription), what the AI said (its audio transcript), and the AI's tool
 * calls — which question it is asking, whether consent was given, and that it
 * has ended. Recording starts ONLY after consent is given; before that,
 * nothing is captured. Nothing here flashes — a person is talking.
 * ------------------------------------------------------------------------- */

type Seg = { id: string; speaker: "ai" | "candidate"; startMs: number; endMs: number; text: string; live?: boolean };
type Phase = "ready" | "connecting" | "live" | "saving" | "done" | "error";

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export function LiveScreen({ execId, applicationId, candidateName }: { execId: string; applicationId: string; candidateName: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("ready");
  const [error, setError] = useState<string | null>(null);
  const [segs, setSegs] = useState<Seg[]>([]);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<string | null>(null);

  const t0 = useRef(0);
  const pc = useRef<RTCPeerConnection | null>(null);
  const dc = useRef<RTCDataChannel | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const remote = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const audioCtx = useRef<AudioContext | null>(null);
  const audioEl = useRef<HTMLAudioElement>(null);
  const marks = useRef<{ key: string; atMs: number }[]>([]);
  const consentRef = useRef<boolean | null>(null);
  const endReason = useRef<string | null>(null);
  const segsRef = useRef<Seg[]>([]);
  const speechStart = useRef<Record<string, number>>({});
  const aiStart = useRef<number | null>(null);
  const finishing = useRef(false);
  const txBox = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const now = () => performance.now() - t0.current;
  const commit = (next: Seg[]) => {
    segsRef.current = next;
    setSegs(next);
  };
  const upsert = (id: string, patch: Partial<Seg> & Pick<Seg, "speaker">) => {
    const list = segsRef.current.slice();
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) list[i] = { ...list[i], ...patch };
    else list.push({ id, startMs: patch.startMs ?? now(), endMs: patch.endMs ?? now(), text: patch.text ?? "", speaker: patch.speaker, live: patch.live });
    list.sort((a, b) => a.startMs - b.startMs);
    commit(list);
  };

  useEffect(() => {
    if (phase !== "live") return;
    const iv = setInterval(() => setElapsed(now()), 1000);
    return () => clearInterval(iv);
  }, [phase]);

  /* The transcript follows the conversation, and stops following when somebody scrolls up. */
  useEffect(() => {
    const el = txBox.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [segs]);

  useEffect(() => () => teardown(), []);

  function teardown() {
    try {
      dc.current?.close();
      pc.current?.close();
    } catch {}
    mic.current?.getTracks().forEach((t) => t.stop());
    void audioCtx.current?.close().catch(() => {});
    pc.current = null;
    dc.current = null;
  }

  function send(ev: unknown) {
    if (dc.current?.readyState === "open") dc.current.send(JSON.stringify(ev));
  }

  function startRecording() {
    if (recorder.current || !mic.current) return;
    try {
      const ctx = new AudioContext();
      audioCtx.current = ctx;
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(mic.current).connect(dest);
      if (remote.current) ctx.createMediaStreamSource(remote.current).connect(dest);
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const r = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 32000 });
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.start(1000);
      recorder.current = r;
    } catch (e) {
      console.error("recording", e);
    }
  }

  function onEvent(ev: { type: string; [k: string]: unknown }) {
    const t = now();
    switch (ev.type) {
      case "input_audio_buffer.speech_started":
        speechStart.current[String(ev.item_id)] = t;
        upsert(`c:${ev.item_id}`, { speaker: "candidate", startMs: t, endMs: t, text: "…", live: true });
        break;
      case "conversation.item.input_audio_transcription.delta": {
        const id = `c:${ev.item_id}`;
        const prev = segsRef.current.find((s) => s.id === id);
        upsert(id, { speaker: "candidate", text: `${prev && prev.text !== "…" ? prev.text : ""}${String(ev.delta ?? "")}`, live: true, startMs: speechStart.current[String(ev.item_id)] ?? t });
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        upsert(`c:${ev.item_id}`, { speaker: "candidate", text: String(ev.transcript ?? "").trim() || "(inaudible)", endMs: t, live: false, startMs: speechStart.current[String(ev.item_id)] ?? t });
        break;
      case "response.created":
        aiStart.current = t;
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        const id = `a:${ev.response_id ?? ev.item_id}`;
        const prev = segsRef.current.find((s) => s.id === id);
        upsert(id, { speaker: "ai", text: `${prev?.text ?? ""}${String(ev.delta ?? "")}`, startMs: prev?.startMs ?? aiStart.current ?? t, live: true });
        break;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        const id = `a:${ev.response_id ?? ev.item_id}`;
        const prev = segsRef.current.find((s) => s.id === id);
        upsert(id, { speaker: "ai", text: String(ev.transcript ?? prev?.text ?? ""), startMs: prev?.startMs ?? aiStart.current ?? t, endMs: t, live: false });
        break;
      }
      case "response.function_call_arguments.done": {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(String(ev.arguments ?? "{}"));
        } catch {}
        const name = String(ev.name);
        if (name === "mark_question" && typeof args.key === "string") {
          marks.current.push({ key: args.key, atMs: t });
          setCurrent(args.key);
        }
        if (name === "record_consent") {
          const given = args.given === true;
          consentRef.current = given;
          setConsent(given);
          if (given) startRecording();
        }
        if (name === "end_screen") {
          endReason.current = String(args.reason ?? "completed");
          /* Let the closing words finish playing. */
          setTimeout(() => void finish(endReason.current), 2500);
          return;
        }
        send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify({ ok: true }) } });
        send({ type: "response.create" });
        break;
      }
      case "error":
        console.error("realtime error", ev);
        break;
    }
  }

  async function start() {
    setPhase("connecting");
    setError(null);
    try {
      const res = await fetch("/api/hire/realtime", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ execId }) });
      const j = (await res.json()) as { ok: boolean; data?: { clientSecret: string }; error?: string };
      if (!j.ok || !j.data) throw new Error(j.error ?? "The AI interviewer could not be started.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      mic.current = stream;
      const conn = new RTCPeerConnection();
      pc.current = conn;
      conn.ontrack = (e) => {
        remote.current = e.streams[0];
        if (audioEl.current) audioEl.current.srcObject = e.streams[0];
      };
      stream.getTracks().forEach((tr) => conn.addTrack(tr, stream));
      const channel = conn.createDataChannel("oai-events");
      dc.current = channel;
      channel.onmessage = (m) => {
        try {
          onEvent(JSON.parse(m.data));
        } catch {}
      };
      channel.onopen = () => {
        t0.current = performance.now();
        setPhase("live");
        send({ type: "response.create" });
      };
      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      const sdp = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${j.data.clientSecret}`, "Content-Type": "application/sdp" },
      });
      if (!sdp.ok) throw new Error("The AI interviewer did not answer. Schedule a person to screen this candidate instead.");
      await conn.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
    } catch (e) {
      teardown();
      setPhase("error");
      setError(e instanceof Error ? (e.name === "NotAllowedError" ? "The microphone was not allowed. Allow it in the browser and try again." : e.message) : "Could not start.");
    }
  }

  async function finish(reason: string | null) {
    if (finishing.current) return;
    finishing.current = true;
    setPhase("saving");
    const rec = recorder.current;
    let blob: Blob | null = null;
    if (rec && rec.state !== "inactive") {
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        rec.stop();
      });
    }
    if (consentRef.current === true && chunks.current.length) blob = new Blob(chunks.current, { type: "audio/webm" });
    const duration = now();
    teardown();
    const payload = {
      execId,
      consent: consentRef.current,
      endReason: reason ?? endReason.current ?? "stopped",
      durationMs: Math.round(duration),
      segments: segsRef.current.filter((s) => s.text && s.text !== "…").map((s) => ({ speaker: s.speaker, startMs: Math.round(s.startMs), endMs: Math.round(Math.max(s.endMs, s.startMs)), text: s.text })),
      marks: marks.current.map((m) => ({ key: m.key, atMs: Math.round(m.atMs) })),
    };
    const form = new FormData();
    form.set("payload", JSON.stringify(payload));
    if (blob) form.set("audio", blob, "screen.webm");
    try {
      const res = await fetch("/api/hire/realtime/finish", { method: "POST", body: form });
      const j = (await res.json()) as { ok: boolean; data?: { sessionId: string }; error?: string; message?: string };
      if (!j.ok || !j.data) throw new Error(j.error ?? "The screen could not be saved.");
      if (consentRef.current === false || payload.endReason === "consent_refused") {
        setResult(j.message ?? "The candidate did not agree to recording. Nothing was kept.");
        setPhase("done");
        return;
      }
      router.push(`/hire/voice/${j.data.sessionId}`);
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "The screen could not be saved.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <audio ref={audioEl} autoPlay className="hidden" />
      {phase === "ready" || phase === "connecting" ? (
        <div className="rounded-[6px] border border-line bg-surface p-5">
          <div className="text-[15px] font-semibold text-heading">Before you start</div>
          <ul className="mt-2 mb-4 flex flex-col gap-1 pl-5 text-sm text-body">
            <li>{candidateName} is here, at this device, with a working microphone.</li>
            <li>The AI introduces itself as an AI and asks for consent to record before any question.</li>
            <li>You can end the screen or take over at any time; both are recorded on the stage.</li>
          </ul>
          <Btn kind="primary" disabled={phase === "connecting"} onClick={() => void start()}>
            {phase === "connecting" ? "Connecting…" : "Start the AI screen"}
          </Btn>
        </div>
      ) : null}

      {phase === "error" ? (
        <Callout tone="danger">
          {error}{" "}
          <Link href={`/hire/c/${applicationId}`} className="font-medium">
            Schedule a human screen instead
          </Link>
          .
        </Callout>
      ) : null}

      {phase === "done" ? (
        <Callout tone="warn">
          {result}{" "}
          <Link href={`/hire/c/${applicationId}`} className="font-medium">
            Schedule a person to screen them
          </Link>
          .
        </Callout>
      ) : null}

      {phase === "live" || phase === "saving" || (phase !== "ready" && segs.length) ? (
        <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
          <div className="flex items-center gap-3 border-b border-divider px-4 py-2.5 text-[13px]">
            <span className={cx("h-2 w-2 rounded-full", phase === "live" ? "bg-danger" : "bg-faint")} aria-hidden />
            <span className="text-body">
              {phase === "live" ? (consent ? "Recording · consent given" : consent === false ? "Not recording · consent refused" : "Not recording yet · consent being asked") : phase === "saving" ? "Saving and assessing the answers…" : "Ended"}
            </span>
            <span className="tabular-nums text-muted">{mmss(elapsed)}</span>
            <span className="flex-1" />
            {current ? <span className="text-muted">On question {current.toUpperCase()}</span> : null}
          </div>
          <div
            ref={txBox}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            className="flex max-h-[460px] min-h-[240px] flex-col gap-3 overflow-y-auto px-4 py-3"
          >
            {segs.length ? (
              segs.map((s) => (
                <div key={s.id}>
                  <Label>{s.speaker === "ai" ? "AI interviewer" : "Candidate"} · {mmss(s.startMs)}</Label>
                  <div className={cx("mt-0.5", s.speaker === "candidate" ? "font-[family-name:var(--font-evidence)] text-base leading-[26px] text-heading" : "text-sm text-body", s.live ? "opacity-80" : "")}>{s.text}</div>
                </div>
              ))
            ) : (
              <div className="text-[13px] text-muted">The AI is about to introduce itself.</div>
            )}
          </div>
          {phase === "live" ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-divider px-4 py-3">
              <Btn onClick={() => void finish("human_requested")}>Take over — a person continues</Btn>
              <span className="flex-1" />
              <Btn kind="danger" onClick={() => void finish(endReason.current ?? "stopped_by_recruiter")}>
                End screen
              </Btn>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
