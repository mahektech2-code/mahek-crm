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
  | { available: true; maxSeconds: number; maxSizeMb: number; canRefine: boolean }
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
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/* ----------------------------------------------------------------- modal */

type Phase = "recording" | "working" | "review" | "failed";

function DictationBody({
  maxSeconds,
  canRefine,
  hasExistingText,
  onImport,
  onClose,
}: {
  maxSeconds: number;
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
      const res = await fetch("/api/dictate/transcribe", { method: "POST", body: form });
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
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        if (cancelled) return;
        const denied = e instanceof DOMException && e.name === "NotAllowedError";
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
      const mimeType = pickContainer();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (cancelled) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (blob.size === 0) {
          setError("Nothing was recorded.");
          setPhase("failed");
          return;
        }
        void send(blob);
      };
      recorder.start();
    })();

    return () => {
      cancelled = true;
      /* Closing mid-recording must release the microphone, or the browser
       * keeps showing the recording indicator over an app nobody is using. */
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      streamRef.current = null;
    };
  }, [take, send]);

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
        setError(json?.error ?? "That did not come back. Your text is unchanged.");
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
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-danger-soft text-danger">
          <span className="animate-pulse">
            <MicIcon size={28} />
          </span>
        </div>
        <p className="mt-4 text-2xl font-semibold tabular-nums text-ink">{clock(elapsed)}</p>
        <p className="mt-1 text-[13px] text-muted">
          Listening. Speak in whatever language you like — Hindi, Marathi, Gujarati, English, or
          a mix of them.
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
      <div className="py-10 text-center">
        <p className="text-sm font-medium text-ink">Writing down what you said…</p>
        <p className="mt-1 text-[13px] text-muted">
          {clock(elapsed)} of speech. This usually takes a few seconds.
        </p>
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
        This is everything you said, not a summary. Edit it directly, or ask below.
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
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={again}>
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
        <Button disabled={!english.trim()} onClick={() => onImport(english.trim(), false)}>
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
  title = "Dictate",
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
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={title}
        aria-label={title}
        className={cx(
          "flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-[4px]",
          "text-muted hover:bg-canvas hover:text-brand",
          "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
          className,
        )}
      >
        <MicIcon />
      </button>
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
      {/* Room for the button, so a long line never runs underneath it. */}
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
        className="absolute right-1 bottom-2"
      />
    </span>
  );
}
