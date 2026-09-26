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

function PauseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="7" y="5" width="4" height="14" rx="1.2" />
      <rect x="13" y="5" width="4" height="14" rx="1.2" />
    </svg>
  );
}

function ResumeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5Z" />
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
  held = false,
  tone = "danger",
}: {
  stream: MediaStream | null;
  /** True while the microphone is open; false animates on a loop instead. */
  live: boolean;
  /**
   * Held on a pause: STILL, not idling. The idle loop exists so a screen
   * waiting on the model does not sit dead, and it is exactly the wrong thing
   * here — bars travelling under the word "Held" is the screen saying it can
   * still hear you while the recorder is taking nothing.
   */
  held?: boolean;
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
            held
              ? "bg-line-strong"
              : tone === "danger"
                ? "bg-danger"
                : "bg-brand",
            !live && !held && "animate-dictate-bar",
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

/*
 * Where a long dictation is cut. A piece runs at least PIECE_MIN_MS, then ends
 * at the first QUIET_MS as quiet as the room — the speaker's own pause, so no
 * word is split — and never later than PIECE_MAX_MS, which keeps every piece
 * inside Sarvam's 30-second ceiling with room to spare.
 */
const TICK_MS = 100;
const PIECE_MIN_MS = 15_000;
const PIECE_MAX_MS = 27_000;
const QUIET_MS = 350;
/*
 * Not a limit anybody meets: an hour of one person talking. It exists only
 * so a microphone left open on a desk overnight does not stream the office
 * to a transcription provider until morning.
 */
const SESSION_CEILING_MS = 60 * 60 * 1000;

type Piece = {
  index: number;
  blob: Blob;
  seconds: number;
  /** Stopped before it was ever cut: a whole note, written as one. */
  whole: boolean;
  status: "sending" | "written" | "empty" | "failed";
  /** The words are back, whether or not the English is. */
  heard: boolean;
  attempts: number;
  spoken: string;
  draft: string;
  english: string;
  language: string | null;
  servedBy: "sarvam" | "openai" | null;
  error?: string;
  /** Will fail the same way again — no key, no credit, switched off. */
  fatal?: boolean;
};

function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  for (const [v, n] of counts) if (!best || n > (counts.get(best) ?? 0)) best = v;
  return best;
}

/**
 * What came back beside the English. The call assistant keeps the transcript
 * in the language it was spoken in — the client asked for the original to be
 * kept for checking — so the modal hands it over rather than dropping it.
 */
export type DictationMeta = {
  spoken: string;
  language: string | null;
  servedBy: "sarvam" | "openai" | null;
};

/**
 * Something that reads the recording ALONGSIDE the transcription, and shows
 * what it read under the note — the call assistant is the one there is.
 *
 * It is told when the words are back and when the note is written, and draws
 * under the note. This file knows nothing about calls; it knows that somebody
 * else may want to read along.
 */
export type DictationCompanion = {
  /** A new recording has begun — whatever was read before is void. */
  onStart: () => void;
  /**
   * Every word is back, BEFORE the English is written: the transcript and the
   * provider's rough English. The call assistant starts reading here, so the
   * reading and the writing run side by side.
   */
  onHeard: (heard: { spoken: string; draft: string; language: string | null }) => void;
  /** The note is written and on the screen. */
  onWritten: (note: {
    english: string;
    spoken: string;
    language: string | null;
    servedBy: "sarvam" | "openai" | null;
  }) => void;
  /** Said while the last of the audio is with the server. */
  workingLabel?: string;
  /**
   * Drawn under the note while it is reviewed. `english` is the note as it
   * stands, edits included; `importNow` imports it exactly as the main button
   * would, for a companion whose own buttons ARE the decision.
   */
  render: (args: {
    english: string;
    importNow: (english: string) => void;
  }) => React.ReactNode;
};

/** Reads a newline-delimited JSON stream, one event at a time. */
async function readEvents(
  res: Response,
  onEvent: (e: Record<string, unknown>) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) {
        try {
          onEvent(JSON.parse(line));
        } catch {
          /* A torn line is not worth failing the note over. */
        }
      }
      newline = buffered.indexOf("\n");
    }
    if (done) break;
  }
}

function DictationBody({
  capture,
  canRefine,
  hasExistingText,
  importLabel,
  companion,
  onImport,
  onClose,
}: {
  /** How to open the microphone. Configuration, not the browser's guess. */
  capture: CaptureSettings;
  /** Tighten and Rewrite need a text model; without one they are not offered. */
  canRefine: boolean;
  hasExistingText: boolean;
  /** Overrides the main button's words, where importing does more than fill a box. */
  importLabel?: string;
  companion?: DictationCompanion;
  onImport: (text: string, replace: boolean, meta: DictationMeta) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = React.useState<Phase>("recording");
  /* The server has the words and is writing them up — said, because a wait
     that visibly moves forward is a wait people sit through. */
  const [heardAlready, setHeardAlready] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  /*
   * Held, not stopped. A call comes in, somebody walks up to the desk, the
   * customer says wait — and the alternative to a pause button is starting
   * again, which on a note somebody has already half spoken is worse than not
   * offering dictation at all.
   */
  const [paused, setPaused] = React.useState(false);
  /*
   * Whether this browser can pause at all. Safari only learned in 14.1, and a
   * button that fails when pressed is worse than one never drawn — the same
   * rule the microphone itself follows.
   */
  const [canPause, setCanPause] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [english, setEnglish] = React.useState("");
  const [spoken, setSpoken] = React.useState("");
  const [language, setLanguage] = React.useState<string | null>(null);
  const [servedBy, setServedBy] = React.useState<DictationMeta["servedBy"]>(null);
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
  /* Read by the recorder's own clock, which lives inside an effect and must
     see a pause the moment it is pressed rather than on the next render. */
  const pausedRef = React.useRef(false);
  /* Stop pressed: the next piece cut is the last one. */
  const stoppingRef = React.useRef(false);

  /*
   * THE PIECES. A dictation is cut at the speaker's own pauses while they are
   * still talking, and every piece is sent the moment it is cut — see
   * `/api/dictate/piece`. `piecesRef` is the truth the async handlers work
   * from; `pieces` mirrors it for drawing.
   */
  const piecesRef = React.useRef<Piece[]>([]);
  const [pieces, setPieces] = React.useState<Piece[]>([]);
  /* Every piece is in: stop was pressed and the last one has been cut. */
  const allCutRef = React.useRef(false);
  /* Each take's own abort, so a closed modal or "Record again" stops the
     pieces still in flight from reporting into a recording nobody wants. */
  const abortRef = React.useRef<AbortController | null>(null);
  const announcedRef = React.useRef<{ heard: boolean; written: boolean }>({
    heard: false,
    written: false,
  });

  /* In a ref so the recorder effect stays stable — a caller passing a fresh
     object each render must not restart the microphone. */
  const companionRef = React.useRef(companion);
  React.useEffect(() => {
    companionRef.current = companion;
  });

  /** Where the take stands, worked out from the pieces after every change. */
  const settle = React.useCallback(() => {
    const list = piecesRef.current;
    setPieces([...list]);

    /* No key, no credit, switched off: every later piece would fail the same
       way, so the person is stopped NOW rather than after five more minutes
       of talking into a microphone nothing can hear. */
    const fatal = list.find((p) => p.status === "failed" && p.fatal);
    if (fatal) {
      stoppingRef.current = true;
      setError(fatal.error ?? "Dictation is unavailable.");
      setPhase("failed");
      return;
    }
    if (!allCutRef.current) return;
    if (list.some((p) => p.status === "sending")) {
      if (list.some((p) => p.status !== "sending")) setHeardAlready(true);
      /* The call assistant can start once every piece has been HEARD, even
         while the last one is still being written. */
    }
    if (list.some((p) => p.status === "failed")) {
      if (!list.some((p) => p.status === "sending")) {
        const n = list.filter((p) => p.status === "failed").length;
        setError(
          n === list.length
            ? (list[0].error ?? "That did not come back. Try again.")
            : `${n} part${n === 1 ? "" : "s"} of what you said did not come back. Send ${n === 1 ? "it" : "them"} again — nothing you said is lost.`,
        );
        setPhase("failed");
      }
      return;
    }

    const heardAll = list.every((p) => p.status !== "sending" || p.heard);
    const used = list.filter((p) => p.status !== "empty");
    const join = (xs: string[]) =>
      xs.map((x) => x.trim()).filter(Boolean).join(" ");
    const lang = mostCommon(used.map((p) => p.language));
    const by = used.find((p) => p.servedBy)?.servedBy ?? null;

    if (heardAll && !announcedRef.current.heard && used.length) {
      announcedRef.current.heard = true;
      setHeardAlready(true);
      companionRef.current?.onHeard({
        spoken: join(used.map((p) => p.spoken)),
        draft: join(used.map((p) => p.draft || p.spoken)),
        language: lang,
      });
    }

    if (list.every((p) => p.status === "written" || p.status === "empty")) {
      if (!used.length) {
        setError("Nothing was heard in that recording. Try again, closer to the microphone.");
        setPhase("failed");
        return;
      }
      if (announcedRef.current.written) return;
      announcedRef.current.written = true;
      const note = {
        english: join(used.map((p) => p.english)),
        spoken: join(used.map((p) => p.spoken)),
        language: lang,
        servedBy: by,
      };
      setEnglish(note.english);
      setSpoken(note.spoken);
      setLanguage(note.language);
      setServedBy(note.servedBy);
      setPhase("review");
      companionRef.current?.onWritten(note);
    }
  }, []);

  /** Change one piece. Immutable, so a drawn list is never edited under React. */
  const patchPiece = React.useCallback((index: number, patch: Partial<Piece>) => {
    piecesRef.current = piecesRef.current.map((p) =>
      p.index === index ? { ...p, ...patch } : p,
    );
  }, []);

  /** Send one piece, and once more if the connection is what failed. */
  const sendPiece = React.useCallback(
    async (index: number) => {
      const signal = abortRef.current?.signal;
      const piece = piecesRef.current.find((p) => p.index === index);
      if (!piece) return;
      let failure: { message: string; fatal: boolean } | null = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        failure = null;
        patchPiece(index, { status: "sending", heard: false, attempts: attempt });
        settle();
        const form = new FormData();
        /* The extension is cosmetic — the server reads the blob's type. */
        form.append("audio", piece.blob, "dictation");
        /* How long it ran. The server routes on it: Sarvam refuses audio over
           30 seconds, and the recorder is the only thing that already knows. */
        form.append("seconds", String(Math.max(1, Math.ceil(piece.seconds))));
        /* A take that was never cut is a whole note, and is written as one. */
        form.append("piece", piece.whole ? "0" : "1");
        let ended = false;
        try {
          const res = await fetch("/api/dictate/piece", {
            method: "POST",
            body: form,
            signal,
          });
          if (!res.ok) {
            const json = await res.json().catch(() => null);
            failure = {
              message: json?.error ?? "That did not come back.",
              fatal: res.status === 401 || res.status === 403,
            };
          } else {
            await readEvents(res, (e) => {
              if (e.type === "heard") {
                patchPiece(index, {
                  heard: true,
                  spoken: String(e.spoken ?? ""),
                  draft: String(e.draft ?? ""),
                  language: typeof e.language === "string" ? e.language : null,
                });
                settle();
              } else if (e.type === "written") {
                ended = true;
                patchPiece(index, {
                  status: "written",
                  heard: true,
                  english: String(e.english ?? ""),
                  spoken: String(e.spoken ?? ""),
                  language: typeof e.language === "string" ? e.language : null,
                  servedBy:
                    e.servedBy === "sarvam" || e.servedBy === "openai"
                      ? e.servedBy
                      : null,
                });
              } else if (e.type === "error") {
                ended = true;
                if (e.reason === "no_speech") {
                  /* A piece cut in a long pause holds nothing, and that is fine. */
                  patchPiece(index, { status: "empty", heard: true });
                } else {
                  failure = {
                    message:
                      typeof e.error === "string" ? e.error : "That did not come back.",
                    /* These will say the same thing again on a retry. */
                    fatal:
                      e.reason === "not_configured" ||
                      e.reason === "provider_refused" ||
                      e.status === 403,
                  };
                }
              }
            });
            if (!ended && !failure)
              failure = { message: "The connection dropped part-way.", fatal: false };
          }
        } catch {
          if (signal?.aborted) return;
          failure = {
            message: "The connection dropped before a part of it was sent.",
            fatal: false,
          };
        }
        if (signal?.aborted) return;
        if (!failure) break;
        if ((failure as { fatal: boolean }).fatal) break;
      }

      if (failure) {
        const f = failure as { message: string; fatal: boolean };
        patchPiece(index, { status: "failed", error: f.message, fatal: f.fatal });
      }
      settle();
    },
    [settle, patchPiece],
  );

  /*
   * The recording. Starts when the modal opens — the person pressed a
   * microphone, and asking them to press a second one mid-call is a tap that
   * buys nothing.
   *
   * THERE IS NO LENGTH LIMIT a person will meet. The recorder is cut into
   * pieces at the speaker's own pauses — after `PIECE_MIN_MS` of speech, at
   * the first stretch as quiet as the room — and never later than
   * `PIECE_MAX_MS`, which keeps every piece inside Sarvam's 30 seconds. Each
   * piece is a fresh MediaRecorder on the SAME stream, so each is a complete
   * file a provider can read on its own, and the next starts before the last
   * stops so nothing between them is lost.
   */
  React.useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    abortRef.current = abort;
    piecesRef.current = [];
    allCutRef.current = false;
    stoppingRef.current = false;
    announcedRef.current = { heard: false, written: false };
    companionRef.current?.onStart();
    let tick: ReturnType<typeof setInterval> | null = null;
    let audio: AudioContext | null = null;

    (async () => {
      let stream: MediaStream;
      try {
        /*
         * Never a bare `{ audio: true }`. That takes the browser's defaults,
         * which turn on noise suppression, echo cancellation and gain control
         * because they assume a video call — and the first of those is built
         * to remove exactly the sort of low-level signal a whisper is made of,
         * or a telecaller speaking quietly with a customer still on the line.
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
      setMicStream(stream);
      const mimeType = pickContainer();

      /* Listening for the pauses. Nothing here is recorded or sent — it only
         decides where one piece ends and the next begins. */
      let analyser: AnalyserNode | null = null;
      try {
        audio = new AudioContext();
        analyser = audio.createAnalyser();
        analyser.fftSize = 1024;
        audio.createMediaStreamSource(stream).connect(analyser);
      } catch {
        analyser = null;
      }
      const samples = new Float32Array(1024);
      const level = () => {
        if (!analyser) return 0;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const v of samples) sum += v * v;
        return Math.sqrt(sum / samples.length);
      };

      let pieceMs = 0;
      let totalMs = 0;
      let floor = Number.POSITIVE_INFINITY;
      let quietMs = 0;

      const cut = (recorder: MediaRecorder, chunks: Blob[], seconds: number, last: boolean) => {
        recorder.onstop = () => {
          if (cancelled) return;
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          if (last) {
            stream.getTracks().forEach((t) => t.stop());
            void audio?.close().catch(() => {});
          }
          if (blob.size > 0) {
            const piece: Piece = {
              index: piecesRef.current.length,
              blob,
              seconds,
              whole: last && piecesRef.current.length === 0,
              status: "sending",
              heard: false,
              attempts: 0,
              spoken: "",
              draft: "",
              english: "",
              language: null,
              servedBy: null,
            };
            piecesRef.current = [...piecesRef.current, piece];
            if (last) allCutRef.current = true;
            void sendPiece(piece.index);
          } else if (last) {
            allCutRef.current = true;
            settle();
          }
        };
        if (recorder.state !== "inactive") recorder.stop();
      };

      const begin = () => {
        const chunks: Blob[] = [];
        /*
         * An explicit bitrate. Left to itself a browser picks something sized
         * for a call rather than for a model reading the result, and a quiet
         * consonant is the first thing a low bitrate spends.
         */
        const recorder = new MediaRecorder(stream, {
          ...(mimeType ? { mimeType } : {}),
          audioBitsPerSecond: 96_000,
        });
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        recorder.start(1000);
        return { recorder, chunks };
      };
      let current = begin();
      recorderRef.current = current.recorder;
      setCanPause(
        typeof current.recorder.pause === "function" &&
          typeof current.recorder.resume === "function",
      );

      tick = setInterval(() => {
        if (cancelled) return;
        if (stoppingRef.current) {
          if (tick) clearInterval(tick);
          tick = null;
          cut(current.recorder, current.chunks, pieceMs / 1000, true);
          return;
        }
        if (pausedRef.current) return;
        pieceMs += TICK_MS;
        totalMs += TICK_MS;
        const seconds = Math.floor(totalMs / 1000);
        setElapsed((s) => (s === seconds ? s : seconds));

        if (totalMs >= SESSION_CEILING_MS) {
          stoppingRef.current = true;
          return;
        }

        /* The room's own level: the quietest moment heard, drifting slowly
           up so a fan switched on halfway through does not make every
           later pause look like speech. */
        const rms = level();
        floor = Math.min(floor * 1.001, rms);
        quietMs = rms <= floor * 1.8 + 0.002 ? quietMs + TICK_MS : 0;
        const atPause =
          analyser !== null && pieceMs >= PIECE_MIN_MS && quietMs >= QUIET_MS;
        if (atPause || pieceMs >= PIECE_MAX_MS) {
          const done = current;
          const seconds = pieceMs / 1000;
          current = begin();
          recorderRef.current = current.recorder;
          pieceMs = 0;
          quietMs = 0;
          cut(done.recorder, done.chunks, seconds, false);
        }
      }, TICK_MS);
    })();

    return () => {
      cancelled = true;
      abort.abort();
      if (tick) clearInterval(tick);
      /* Closing mid-recording must release the microphone, or the browser
       * keeps showing the recording indicator over an app nobody is using.
       * `!== "inactive"` rather than `=== "recording"`: a recorder held on
       * pause is neither. */
      if (recorderRef.current && recorderRef.current.state !== "inactive")
        recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void audio?.close().catch(() => {});
      recorderRef.current = null;
      streamRef.current = null;
      setMicStream(null);
      setPaused(false);
      pausedRef.current = false;
    };
  }, [take, capture, sendPiece, settle]);

  /*
   * Pause captures NOTHING. `MediaRecorder.pause()` stops the container being
   * fed, so the held seconds are absent from the piece rather than recorded
   * as silence, and the clock above does not count them.
   *
   * The track is disabled as well: the recorder is already taking nothing,
   * and this stops the microphone yielding anything to take. It is also what
   * makes the level meter honestly flat while the screen says paused.
   */
  const pause = () => {
    const recorder = recorderRef.current;
    if (recorder?.state !== "recording") return;
    recorder.pause();
    pausedRef.current = true;
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = false));
    setPaused(true);
  };

  const resume = () => {
    const recorder = recorderRef.current;
    if (recorder?.state !== "paused") return;
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = true));
    recorder.resume();
    pausedRef.current = false;
    setPaused(false);
  };

  /* Stopping works from a pause too — the recording ends where it was held.
     The recorder's own clock cuts the last piece on its next tick. */
  const stop = () => {
    if (pausedRef.current) resume();
    stoppingRef.current = true;
    setPhase("working");
  };

  /** Send the parts that did not come back, from the audio still held. */
  const retryFailed = () => {
    setError(null);
    setPhase("working");
    for (const p of piecesRef.current)
      if (p.status === "failed") void sendPiece(p.index);
  };

  const canRetry =
    pieces.some((p) => p.status === "failed" && !p.fatal);

  const again = () => {
    setPhase("recording");
    setElapsed(0);
    setError(null);
    setEnglish("");
    setSpoken("");
    setPrevious(null);
    setShowSpoken(false);
    setAskingRewrite(false);
    setInstruction("");
    setHeardAlready(false);
    setPieces([]);
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
    const remaining = Math.round(SESSION_CEILING_MS / 1000) - elapsed;
    const written = pieces.filter((p) => p.status === "written").length;
    return (
      <div className="py-4 text-center">
        <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
          {/* A ring going out on a loop, so the modal is never still even
              during a pause for breath. It stops while HELD, because a screen
              that goes on pulsing is a screen that looks like it is still
              listening. */}
          {paused ? null : (
            <span className="animate-pulse-ring absolute inset-0 rounded-full bg-danger-soft" />
          )}
          <span
            className={cx(
              "relative flex h-16 w-16 items-center justify-center rounded-full",
              paused ? "bg-canvas text-muted" : "bg-danger-soft text-danger",
            )}
          >
            {paused ? <PauseIcon size={26} /> : <MicIcon size={28} />}
          </span>
        </div>
        {/* Driven by the microphone itself — the only proof a telecaller has
            that the browser can hear them before they say the whole thing. */}
        <div className="mt-4">
          <LevelMeter stream={micStream} live={!paused} held={paused} />
        </div>
        <p
          className={cx(
            "mt-1 text-2xl font-semibold tabular-nums",
            paused ? "text-muted" : "text-ink",
          )}
        >
          {clock(elapsed)}
        </p>
        <p className="mt-1 text-[13px] text-muted">
          {/* No language is named here. A list reads as the set of allowed
              answers, and somebody whose language is missing from it stops
              before they start — the opposite of what this sentence is for. */}
          {paused
            ? "Held. Nothing is being recorded — press Resume and carry on where you left off."
            : "Listening. Speak in any language, or a mix of them."}
        </p>
        {written > 0 ? (
          <p className="mt-1 text-[13px] text-success">
            Writing it up as you go — take as long as you need.
          </p>
        ) : null}
        {remaining <= 60 && !paused ? (
          <p className="mt-1 text-[13px] text-danger">
            Stops on its own in {remaining} second{remaining === 1 ? "" : "s"}.
          </p>
        ) : null}
        <div className="mt-5 flex justify-center gap-2.5">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {canPause ? (
            <Button
              variant="secondary"
              onClick={paused ? resume : pause}
              title={
                paused
                  ? "Start recording again, onto the end of what you have already said"
                  : "Hold the recording — nothing is captured until you resume"
              }
            >
              {paused ? (
                <>
                  <ResumeIcon /> Resume
                </>
              ) : (
                <>
                  <PauseIcon /> Pause
                </>
              )}
            </Button>
          ) : null}
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
          {heardAlready
            ? "Heard it. Writing it in English…"
            : "Writing down what you said…"}
        </p>
        {companion?.workingLabel ? (
          <p className="mt-1 text-[13px] text-body">{companion.workingLabel}</p>
        ) : null}
        {pieces.length > 1 ? (
          <p className="mt-1 text-[13px] text-muted">
            {pieces.filter((p) => p.status === "written" || p.status === "empty").length}{" "}
            of {pieces.length} parts written.
          </p>
        ) : null}
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
          {canRetry ? (
            <>
              <Button variant="secondary" onClick={again}>
                <MicIcon /> Record again
              </Button>
              <Button onClick={retryFailed}>Send it again</Button>
            </>
          ) : (
            <Button onClick={again}>
              <MicIcon /> Record again
            </Button>
          )}
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

      {companion
        ? companion.render({
            english,
            importNow: (text) =>
              onImport(text.trim(), false, { spoken, language, servedBy }),
          })
        : null}

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
            onClick={() => onImport(english.trim(), true, { spoken, language, servedBy })}
          >
            Replace what is there
          </Button>
        ) : null}
        <Button
          disabled={!english.trim()}
          onClick={() => onImport(english.trim(), false, { spoken, language, servedBy })}
        >
          {importLabel ?? (hasExistingText ? "Add to what is there" : "Put it in the box")}
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
  renderTrigger,
  importLabel,
  companion,
  modalTitle = "Say it instead",
  /* Shown on hover and read out by a screen reader. The words live here
   * rather than in the layout, so twenty fields do not each carry a sentence. */
  title = "Speak instead of typing. Say it in any language.",
}: {
  /** `replace` is false for an append — the default, and the safe one. */
  onImport: (text: string, replace: boolean, meta: DictationMeta) => void;
  hasExistingText?: boolean;
  disabled?: boolean;
  className?: string;
  title?: string;
  /**
   * A control of the caller's own in place of the corner microphone — the
   * call assistant's is a full-width button, because it is the first thing
   * on the panel rather than furniture on a box. Same modal, same rules.
   */
  renderTrigger?: (open: () => void) => React.ReactNode;
  importLabel?: string;
  /** Reads along with the transcription — see `DictationCompanion`. */
  companion?: DictationCompanion;
  modalTitle?: string;
}) {
  const dictation = useDictation();
  const [open, setOpen] = React.useState(false);

  /* Off, unconfigured, or a browser that cannot record: draw nothing. */
  if (!dictation.available) return null;

  const modal = (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title={modalTitle}
      width={companion ? 640 : 560}
      footer={null}
    >
      <DictationBody
        capture={dictation.capture ?? CAPTURE_FALLBACK}
        canRefine={dictation.canRefine}
        hasExistingText={hasExistingText}
        importLabel={importLabel}
        companion={companion}
        onClose={() => setOpen(false)}
        onImport={(text, replace, meta) => {
          onImport(text, replace, meta);
          setOpen(false);
        }}
      />
    </Modal>
  );

  if (renderTrigger) {
    return (
      <>
        {renderTrigger(() => setOpen(true))}
        {modal}
      </>
    );
  }

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
      {/* Unmounted on close, so every visit starts a fresh recording. */}
      {modal}
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
