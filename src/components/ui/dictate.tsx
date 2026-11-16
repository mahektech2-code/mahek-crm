"use client";

import * as React from "react";
import { Textarea, cx } from "./primitives";
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

export function pickContainer(): string | undefined {
  return CONTAINERS.find((t) => MediaRecorder.isTypeSupported(t));
}

/* ----------------------------------------------------------------- icons */

export function MicIcon({ size = 16 }: { size?: number }) {
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

export function StopIcon({ size = 16 }: { size?: number }) {
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

export function PauseIcon({ size = 16 }: { size?: number }) {
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

export function ResumeIcon({ size = 16 }: { size?: number }) {
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

export const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/* ------------------------------------------------------------ level meter */

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

/* THE RECORDING MODAL IS FETCHED WHEN A MICROPHONE IS PRESSED. It is over a
   thousand lines — recording, cutting at pauses, sending pieces, the review
   and Tighten — and the microphone button sits on twenty prose boxes and in
   the shared prompt dialog (`overlays.tsx`), so it was in nearly every page's
   first download. The button, the box and the types stay here. */
const DictationBody = React.lazy(() => import("./dictate-body").then((m) => ({ default: m.DictationBody })));

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
      <React.Suspense fallback={<div className="py-8 text-center text-[13px] text-muted">Opening the microphone…</div>}>
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
      </React.Suspense>
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
  hideMic = false,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
  onDictate: (value: string) => void;
  dictateTitle?: string;
  /**
   * Leave the corner microphone off. For a box that sits under a control which
   * already offers the fuller microphone — the call panel's assistant speaks
   * the call AND fills the form, so a plain transcriber beside it is a second
   * microphone doing less. Default false: every other box keeps its own.
   */
  hideMic?: boolean;
}) {
  const current = typeof props.value === "string" ? props.value : "";

  if (hideMic) return <Textarea {...props} className={className} />;

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
