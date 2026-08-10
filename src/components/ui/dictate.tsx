"use client";

import * as React from "react";
import { Button, Textarea, cx } from "./primitives";
import { Modal } from "./overlays";

/* ---------------------------------------------------------------------------
 * Speaking into a text box.
 *
 * A telecaller mid-call types English slowly and thinks in something else, so
 * the note that gets written is the short version of what was actually said.
 * The microphone is there to close that gap, and every decision below follows
 * from one thing: THE PERSON MUST SEE WHAT THEY ARE ABOUT TO IMPORT.
 *
 *   IT SHOWS THE FAITHFUL ENGLISH FIRST. Not a summary. Tightening is a button
 *   they press after reading it, not something that happens on the way. A note
 *   that quietly lost the bill number reads exactly like one that never had it.
 *
 *   IT IS EDITABLE IN PLACE. "Tweak it" is a cursor in a text box, not another
 *   round trip. Tighten and Rewrite are for when it is easier to ask.
 *
 *   IT NEVER OVERWRITES BY ACCIDENT. Where the box already has words, Add and
 *   Replace are two different buttons and Add is the default one.
 *
 *   IT SHOWS WHAT WAS HEARD. The original-language transcript is one click
 *   away, because the only way to know a translation went wrong is to read the
 *   sentence it came from.
 *
 * Nothing here is stored. The audio never leaves the browser except as the
 * body of one request, there is no attachment row, and closing the modal drops
 * everything — the Modal unmounts its children, so the next visit starts blank
 * without an effect resetting anything.
 *
 * The mic draws nothing at all when dictation is off, when no provider has a
 * key, or when the browser cannot record. A microphone that fails when
 * pressed is worse than one that was never offered — and for the same reason
 * Tighten and Rewrite are left out entirely where no text model is set up,
 * rather than offered and failing.
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------- availability */

type Availability =
  | {
      available: true;
      maxSeconds: number;
      maxSizeMb: number;
      canRefine: boolean;
      /** Optional so an older cached response still opens a microphone. */
      capture?: CaptureSettings;
    }
  | { available: false };

/*
 * One request per tab, shared by every mic on the page. Twenty boxes on a
 * screen must not be twenty identical asks, and the answer cannot change
 * without a settings edit and a reload.
 */
let availabilityPromise: Promise<Availability> | null = null;

function loadAvailability(): Promise<Availability> {
  availabilityPromise ??= fetch("/api/dictate")
    .then((r) => (r.ok ? r.json() : { available: false }))
    .then((j: Availability) => j)
    .catch(() => ({ available: false }) as Availability);
  return availabilityPromise;
}

/** Recording needs a secure context and MediaRecorder; older Android has neither. */
function browserCanRecord(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

function useDictation(): Availability {
  const [state, setState] = React.useState<Availability>({ available: false });

  React.useEffect(() => {
    if (!browserCanRecord()) return;
    let live = true;
    loadAvailability().then((a) => {
      if (live) setState(a);
    });
    return () => {
      live = false;
    };
  }, []);

  return state;
}

/* ------------------------------------------------------------- recording */

/**
 * The container the browser will actually give us. Chrome and Android record
 * webm/opus; Safari and iOS record mp4 and reject the webm request outright,
 * so the list is tried in order rather than asserted.
 */
const CONTAINERS = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

function pickContainer(): string | undefined {
  return CONTAINERS.find((t) => MediaRecorder.isTypeSupported(t));
}

/* ----------------------------------------------------------------- icons */

function MicIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4M9 21h6" />
    </svg>
  );
}

function StopIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/* ------------------------------------------------------------ level meter */

const BAR_COUNT = 27;

/**
 * The bars that make the modal feel like something is happening.
 *
 * While RECORDING they are driven by the microphone itself, through an
 * AnalyserNode on the same stream the recorder is using. That matters more
 * than decoration: a telecaller who has just been asked to speak into a phone
 * has no other way to know the browser can hear them, and a dead meter is the
 * difference between saying it again now and discovering the silence after the
 * call is over.
 *
 * Heights are written straight to the DOM from `requestAnimationFrame`. Sixty
 * state updates a second would re-render the whole modal for an animation.
 *
 * While WORKING there is no stream left to read — the tracks stop the moment
 * the recorder does — so the same bars breathe on a CSS loop instead. Same
 * shape, same identity, and nothing pretends to be measuring anything.
 */
function LevelMeter({
  stream,
  live,
  tone = "danger",
}: {
  stream: MediaStream | null;
  /** True while the microphone is open; false animates on a loop instead. */
  live: boolean;
  tone?: "danger" | "brand";
}) {
  const bars = React.useRef<Array<HTMLSpanElement | null>>([]);

  React.useEffect(() => {
    if (!live || !stream) return;

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return; /* No Web Audio: the CSS loop is the fallback. */

    const context = new Ctor();
    const analyser = context.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.75;
    context.createMediaStreamSource(stream).connect(analyser);

    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;

    const draw = () => {
      analyser.getByteFrequencyData(spectrum);
      for (let i = 0; i < BAR_COUNT; i++) {
        const node = bars.current[i];
        if (!node) continue;
        /* Mirrored around the middle, so speech pushes the meter outwards
         * from the centre rather than filling it left to right. */
        const from = Math.abs(i - (BAR_COUNT - 1) / 2);
        const bin = Math.min(
          spectrum.length - 1,
          Math.round((from / (BAR_COUNT / 2)) * (spectrum.length * 0.6)),
        );
        const level = spectrum[bin] / 255;
        node.style.transform = `scaleY(${Math.max(0.16, Math.min(1, level * 1.6))})`;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      void context.close();
    };
  }, [live, stream]);

  return (
    <div className="flex h-12 items-center justify-center gap-[3px]" aria-hidden>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span
          key={i}
          ref={(node) => {
            bars.current[i] = node;
          }}
          className={cx(
            "block w-[3px] rounded-full",
            tone === "danger" ? "bg-danger" : "bg-brand",
            !live && "animate-dictate-bar",
          )}
          style={{
            height: `${18 + Math.round(Math.sin((i / BAR_COUNT) * Math.PI) * 26)}px`,
            transform: "scaleY(0.16)",
            /* Staggered from the middle out, so the idle loop travels rather
             * than flashing all twenty-seven bars in unison. */
            animationDelay: `${Math.abs(i - (BAR_COUNT - 1) / 2) * 55}ms`,
          }}
        />
      ))}
    </div>
  );
}

/** The note arriving: lines of text, before there is any text. */
function SkeletonNote() {
  return (
    <div className="mx-auto mt-6 w-full max-w-[320px] space-y-2.5" aria-hidden>
      {[100, 92, 74].map((width, i) => (
        <div
          key={i}
          className="relative h-2.5 overflow-hidden rounded-full bg-divider"
          style={{ width: `${width}%` }}
        >
          <div
            className="animate-dictate-shimmer absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-surface to-transparent"
            style={{ animationDelay: `${i * 180}ms` }}
          />
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- modal */

/** How the microphone is opened. Decided by configuration, not the browser. */
export type CaptureSettings = {
  noiseSuppression: boolean;
  autoGainControl: boolean;
  echoCancellation: boolean;
};

/* If the endpoint ever answers without these — an older cached response, say —
 * favour hearing everything. A whisper lost is a fact lost; background noise
 * is only noise, and the models are better at ignoring it than a filter tuned
 * for conference calls is at keeping the quiet parts. */
const CAPTURE_FALLBACK: CaptureSettings = {
  noiseSuppression: false,
  autoGainControl: true,
  echoCancellation: false,
};

type Phase = "recording" | "working" | "review" | "failed";

function DictationBody({
  maxSeconds,
  capture,
  canRefine,
  hasExistingText,
  onImport,
  onClose,
}: {
  maxSeconds: number;
  /** How to open the microphone. Configuration, not the browser's guess. */
  capture: CaptureSettings;
  /** Tighten and Rewrite need a text model; without one they are not offered. */
  canRefine: boolean;
  hasExistingText: boolean;
  onImport: (text: string, replace: boolean) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = React.useState<Phase>("recording");
  const [elapsed, setElapsed] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [english, setEnglish] = React.useState("");
  const [spoken, setSpoken] = React.useState("");
  const [language, setLanguage] = React.useState<string | null>(null);
  const [showSpoken, setShowSpoken] = React.useState(false);
  const [busy, setBusy] = React.useState<"tighten" | "rewrite" | null>(null);
  const [instruction, setInstruction] = React.useState("");
  const [askingRewrite, setAskingRewrite] = React.useState(false);
  /* One step is enough: Tighten then Undo is the whole of what people do. */
  const [previous, setPrevious] = React.useState<string | null>(null);
  /* Bumping this remounts the recorder, which is how "record again" resets. */
  const [take, setTake] = React.useState(0);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  /* The same stream as the ref, in state, because the level meter is an
   * effect and a ref assignment does not wake one. */
  const [micStream, setMicStream] = React.useState<MediaStream | null>(null);
  /*
   * The same count as `elapsed`, readable from the send callback without
   * putting it in that callback's dependencies — re-creating `send` every
   * second would re-run the recorder effect that closes over it.
   */
  const elapsedRef = React.useRef(0);

  const send = React.useCallback(async (blob: Blob) => {
    setPhase("working");
    const form = new FormData();
    /* The extension is cosmetic — the server reads the blob's type. */
    form.append("audio", blob, "dictation");
    /*
     * How long it ran. The server routes on it: Sarvam refuses audio over 30
     * seconds, and the recorder is the only thing that already knows.
     */
    form.append("seconds", String(elapsedRef.current));
    try {
      const res = await fetch("/api/dictate/transcribe", {
        method: "POST",
        body: form,
      });
      const json = await res.json().catch(() => null);
      if (!json?.ok) {
        setError(json?.error ?? "That did not come back. Try recording again.");
        setPhase("failed");
        return;
      }
      setEnglish(json.english);
      setSpoken(json.spoken);
      setLanguage(json.language ?? null);
      setPhase("review");
    } catch {
      setError("The connection dropped before the recording finished sending.");
      setPhase("failed");
    }
  }, []);

  /*
   * Recording starts when the modal opens. The person pressed a microphone;
   * asking them to press a second one mid-call is a tap that buys nothing.
   */
  React.useEffect(() => {
    let cancelled = false;
    const chunks: Blob[] = [];

    (async () => {
      let stream: MediaStream;
      try {
        /*
         * Never a bare `{ audio: true }`. That takes the browser's defaults,
         * which turn on noise suppression, echo cancellation and gain control
         * because they assume a video call — and the first of those is built
         * to remove exactly the sort of low-level signal a whisper is made of,
         * or a telecaller speaking quietly with a customer still on the line.
         * It was deleting the words along with the fan.
         *
         * Mono at 48kHz: speech is one voice and every model here downmixes
         * anyway, so a second channel doubles the bytes for nothing.
         */
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: capture.noiseSuppression,
            autoGainControl: capture.autoGainControl,
            echoCancellation: capture.echoCancellation,
            channelCount: 1,
            sampleRate: 48_000,
          },
        });
      } catch (e) {
        if (cancelled) return;
        const denied =
          e instanceof DOMException && e.name === "NotAllowedError";
        setError(
          denied
            ? "The browser is not letting this page use the microphone. Allow it in the address bar, then try again."
            : "No microphone was found.",
        );
        setPhase("failed");
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;
      setMicStream(stream);
      const mimeType = pickContainer();
      /*
       * An explicit bitrate. Left to itself a browser picks something sized
       * for a call rather than for a model reading the result, and a quiet
       * consonant is the first thing a low bitrate spends.
       */
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 96_000,
      });
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (cancelled) return;
        const blob = new Blob(chunks, {
          type: recorder.mimeType || "audio/webm",
        });
        if (blob.size === 0) {
          setError("Nothing was recorded.");
          setPhase("failed");
          return;
        }
        void send(blob);
      };
      /*
       * A chunk a second rather than one at the end. The bytes are identical,
       * but a recording interrupted by a closed laptop has already delivered
       * most of itself instead of nothing at all.
       */
      recorder.start(1000);
    })();

    return () => {
      cancelled = true;
      /* Closing mid-recording must release the microphone, or the browser
       * keeps showing the recording indicator over an app nobody is using. */
      if (recorderRef.current?.state === "recording")
        recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      streamRef.current = null;
      setMicStream(null);
    };
  }, [take, send, capture]);

  /* The timer, and the ceiling it enforces. */
  React.useEffect(() => {
    if (phase !== "recording") return;
    const id = setInterval(() => {
      setElapsed((s) => {
        const next = s + 1;
        elapsedRef.current = next;
        if (next >= maxSeconds && recorderRef.current?.state === "recording") {
          recorderRef.current.stop();
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [phase, maxSeconds]);

  const stop = () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };

  const again = () => {
    setPhase("recording");
    setElapsed(0);
    elapsedRef.current = 0;
    setError(null);
    setEnglish("");
    setSpoken("");
    setPrevious(null);
    setShowSpoken(false);
    setAskingRewrite(false);
    setInstruction("");
    setTake((t) => t + 1);
  };

  const refine = async (mode: "tighten" | "rewrite") => {
    if (!english.trim()) return;
    setBusy(mode);
    setError(null);
    try {
      const res = await fetch("/api/dictate/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: english,
          mode,
          instruction: mode === "rewrite" ? instruction : undefined,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!json?.ok) {
        setError(
          json?.error ?? "That did not come back. Your text is unchanged.",
        );
        return;
      }
      setPrevious(english);
      setEnglish(json.text);
      setAskingRewrite(false);
      setInstruction("");
    } catch {
      setError("The connection dropped. Your text is unchanged.");
    } finally {
      setBusy(null);
    }
  };

  /* ------------------------------------------------------------ recording */

  if (phase === "recording") {
    const remaining = maxSeconds - elapsed;
    return (
      <div className="py-4 text-center">
        <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
          {/* A ring going out on a loop, so the modal is never still even
              during a pause for breath. */}
          <span className="animate-pulse-ring absolute inset-0 rounded-full bg-danger-soft" />
          <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-danger-soft text-danger">
            <MicIcon size={28} />
          </span>
        </div>
        {/* Driven by the microphone itself — the only proof a telecaller has
            that the browser can hear them before they say the whole thing. */}
        <div className="mt-4">
          <LevelMeter stream={micStream} live />
        </div>
        <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">
          {clock(elapsed)}
        </p>
        <p className="mt-1 text-[13px] text-muted">
          {/* No language is named here. A list reads as the set of allowed
              answers, and somebody whose language is missing from it stops
              before they start — the opposite of what this sentence is for. */}
          Listening. Speak in any language, or a mix of them.
        </p>
        {remaining <= 20 ? (
          <p className="mt-1 text-[13px] text-danger">
            Stops on its own in {remaining} second{remaining === 1 ? "" : "s"}.
          </p>
        ) : null}
        <div className="mt-5 flex justify-center gap-2.5">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={stop}>
            <StopIcon /> Stop and write it
          </Button>
        </div>
      </div>
    );
  }

  /* -------------------------------------------------------------- working */

  if (phase === "working") {
    return (
      <div className="py-8 text-center">
        {/* The same bars, now breathing on their own: the microphone is closed
            by this point and there is nothing left to measure, so nothing here
            claims to be measuring. It keeps the modal alive rather than
            leaving a sentence sitting still on a white screen. */}
        <LevelMeter stream={null} live={false} tone="brand" />
        <p className="mt-5 text-sm font-medium text-ink">
          Writing down what you said…
        </p>
        <p className="mt-1 text-[13px] text-muted">
          {clock(elapsed)} of speech. This usually takes a few seconds.
        </p>
        <SkeletonNote />
      </div>
    );
  }

  /* --------------------------------------------------------------- failed */

  if (phase === "failed") {
    return (
      <div className="py-6 text-center">
        <p className="text-sm text-danger">{error}</p>
        <div className="mt-5 flex justify-center gap-2.5">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={again}>
            <MicIcon /> Record again
          </Button>
        </div>
      </div>
    );
  }

  /* --------------------------------------------------------------- review */

  return (
    <div>
      <p className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">
        What you said, in English
      </p>
      <Textarea
        value={english}
        onChange={(e) => setEnglish(e.target.value)}
        rows={7}
        aria-label="Dictated text"
        /* Edit it here. Most corrections are one word and do not need a model. */
      />
      <p className="mt-1 text-[13px] text-muted">
        This is everything you said, not a summary. Edit it directly, or ask
        below.
      </p>

      {spoken && spoken !== english ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowSpoken((v) => !v)}
            className="cursor-pointer text-[13px] text-brand underline underline-offset-2"
          >
            {showSpoken ? "Hide" : "Show"} what was heard
            {language ? ` (${language})` : ""}
          </button>
          {showSpoken ? (
            <p className="mt-1.5 rounded-[4px] border border-line bg-canvas px-2.5 py-2 text-[13px] whitespace-pre-wrap text-body">
              {spoken}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {/* Left out rather than shown broken where no text model is set up. */}
        {canRefine ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null || !english.trim()}
              onClick={() => refine("tighten")}
            >
              {busy === "tighten" ? "Tightening…" : "Tighten"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null || !english.trim()}
              onClick={() => setAskingRewrite((v) => !v)}
            >
              Rewrite
            </Button>
          </>
        ) : null}
        {previous !== null ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => {
              setEnglish(previous);
              setPrevious(null);
            }}
          >
            Undo
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={again}
        >
          <MicIcon size={14} /> Record again
        </Button>
      </div>

      {askingRewrite && canRefine ? (
        <div className="mt-2.5 flex gap-2">
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && instruction.trim()) {
                e.preventDefault();
                void refine("rewrite");
              }
            }}
            autoFocus
            placeholder="Make it more formal / drop the part about the driver"
            className="h-8.5 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
          />
          <Button
            size="sm"
            disabled={busy !== null || !instruction.trim()}
            onClick={() => refine("rewrite")}
          >
            {busy === "rewrite" ? "…" : "Go"}
          </Button>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap justify-end gap-2.5 border-t border-divider pt-4">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        {hasExistingText ? (
          <Button
            variant="secondary"
            disabled={!english.trim()}
            onClick={() => onImport(english.trim(), true)}
          >
            Replace what is there
          </Button>
        ) : null}
        <Button
          disabled={!english.trim()}
          onClick={() => onImport(english.trim(), false)}
        >
          {hasExistingText ? "Add to what is there" : "Put it in the box"}
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- button */

export function DictateButton({
  onImport,
  hasExistingText = false,
  disabled,
  className,
  /* Shown on hover and read out by a screen reader. The words live here
   * rather than in the layout, so twenty fields do not each carry a sentence. */
  title = "Speak instead of typing. Say it in any language.",
}: {
  /** `replace` is false for an append — the default, and the safe one. */
  onImport: (text: string, replace: boolean) => void;
  hasExistingText?: boolean;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const dictation = useDictation();
  const [open, setOpen] = React.useState(false);

  /* Off, unconfigured, or a browser that cannot record: draw nothing. */
  if (!dictation.available) return null;

  return (
    <>
      {/*
       * SMALL, IN THE CORNER OF THE BOX — but coloured, not grey.
       *
       * It began as a muted glyph the same weight as the resize handle beside
       * it, and the two read as one piece of furniture. A telecaller who is
       * not confident with computers does not press furniture. The fix is not
       * size: it is that the control is TINTED, so it registers as something
       * offered rather than something structural, and carries its words on
       * hover and for a screen reader rather than in the layout.
       *
       * Nudged up and left of the corner so it stops sharing pixels with the
       * resize grip — the two were overlapping, which is most of what made it
       * look like part of the frame.
       *
       * THE LABEL IS OURS, NOT THE BROWSER'S. `title` was doing this job and
       * browsers sit on it for about a second before showing anything — long
       * enough that somebody who hovers to find out what a button does has
       * already moved on. The whole point of the words is to answer that
       * question at the moment it is asked, so they appear on hover with no
       * delay at all. `aria-label` still carries them for a screen reader;
       * `title` is gone so the native tooltip cannot arrive late on top.
       */}
      {/*
       * Two spans, and they are not interchangeable. The OUTER one takes the
       * caller's positioning; the INNER one is `relative`, which is what the
       * tooltip anchors to. Putting both on one element silently breaks it:
       * `absolute` and `relative` are the same property, Tailwind emits
       * `relative` last, and the caller's placement is thrown away — the
       * button drops out of the corner and lands wherever the flow puts it.
       */}
      <span className={className}>
        <span className="group relative inline-flex">
          <button
            type="button"
            disabled={disabled}
            onClick={() => setOpen(true)}
            aria-label={title}
            className={cx(
              "inline-flex cursor-pointer items-center justify-center rounded-[4px]",
              "h-6.5 w-6.5 border border-brand-softer bg-brand-soft text-brand",
              "transition-colors duration-100 hover:border-brand hover:bg-brand-softer",
              "disabled:cursor-not-allowed disabled:border-line disabled:bg-canvas",
              "disabled:text-muted disabled:hover:border-line disabled:hover:bg-canvas",
            )}
          >
            <MicIcon size={13} />
          </button>

          {/* Right-aligned and above: the button lives in the bottom-right of a
            field, so a tooltip growing left and up is the only direction that
            stays on screen. Not rendered for a disabled button — there is
            nothing being offered to explain. */}
          {disabled ? null : (
            <span
              role="tooltip"
              className={cx(
                "pointer-events-none absolute right-0 bottom-full z-20 mb-1.5 hidden",
                "rounded-[4px] bg-ink px-2 py-1 text-[12px] whitespace-nowrap text-white",
                "shadow-[0_2px_8px_rgba(22,22,22,0.18)]",
                "group-hover:block group-focus-within:block",
              )}
            >
              {title}
            </span>
          )}
        </span>
      </span>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Say it instead"
        width={560}
        footer={null}
      >
        {/* Unmounted on close, so every visit starts a fresh recording. */}
        <DictationBody
          maxSeconds={dictation.maxSeconds}
          capture={dictation.capture ?? CAPTURE_FALLBACK}
          canRefine={dictation.canRefine}
          hasExistingText={hasExistingText}
          onClose={() => setOpen(false)}
          onImport={(text, replace) => {
            onImport(text, replace);
            setOpen(false);
          }}
        />
      </Modal>
    </>
  );
}

/* -------------------------------------------------------------- textarea */

/**
 * How dictated text joins text already in the box. A blank line, because two
 * separate thoughts written at two separate moments are two paragraphs, and
 * running them together is how a note stops being readable.
 */
export function joinDictation(existing: string, added: string): string {
  const kept = existing.trimEnd();
  return kept ? `${kept}\n\n${added}` : added;
}

/**
 * A `Textarea` with a microphone in its corner. A drop-in replacement wherever
 * somebody writes prose — same props, plus the setter.
 *
 * `onDictate` takes the FINISHED value rather than the dictated fragment, so
 * appending, replacing and the length ceiling are all decided here instead of
 * at twenty call sites that would each get one of them slightly wrong.
 */
export function VoiceTextarea({
  onDictate,
  dictateTitle,
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
  onDictate: (value: string) => void;
  dictateTitle?: string;
}) {
  const current = typeof props.value === "string" ? props.value : "";

  return (
    <span className="relative block">
      {/* Room on the right so a long line never runs under the button. */}
      <Textarea {...props} className={cx("pr-9", className)} />
      <DictateButton
        title={dictateTitle}
        disabled={props.disabled}
        hasExistingText={current.trim().length > 0}
        onImport={(text, replace) => {
          const joined = replace ? text : joinDictation(current, text);
          /*
           * `maxLength` stops typing but not a programmatic set, so the box
           * would otherwise accept more than the field will save.
           */
          onDictate(
            props.maxLength && props.maxLength > 0
              ? joined.slice(0, props.maxLength)
              : joined,
          );
        }}
        /* Clear of the resize grip in the very corner, which it used to sit
         * on top of — that overlap is most of what made it read as part of
         * the frame rather than as a control. */
        className="absolute right-2 bottom-3"
      />
    </span>
  );
}
