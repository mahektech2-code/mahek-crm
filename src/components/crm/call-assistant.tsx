"use client";

import * as React from "react";
import { Badge, Button, Textarea, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  DictateButton,
  type DictationCompanion,
  type DictationMeta,
} from "@/components/ui/dictate";
import { LogComplaintDialog } from "@/components/crm/log-complaint-dialog";
import { RequestSampleForm } from "@/components/samples/request-sample";
import {
  analyseCallAction,
  callAssistantStatus,
  markSuggestionAppliedAction,
  noteDraftEnglishAction,
  sampleRequestContext,
  type SampleRequestContext,
} from "@/lib/actions/call-intel";
import {
  createReminder,
  logComplaint,
  rescheduleReminder,
} from "@/lib/actions/crm";
import { SUGGESTION_STATE_LABEL } from "@/lib/call-intel-labels";
import { money } from "@/lib/format";
import type { CallAnalysis, Suggestion } from "@/lib/engines/call-intel-decide";
import { dayLabel } from "@/lib/engines/call-intel-dates";

/* ---------------------------------------------------------------------------
 * THE CALL ASSISTANT, on the call panel.
 *
 * The telecaller presses one button and speaks — in whatever language the
 * call was in — about what happened. The assistant reads it and proposes the
 * form: which outcome, which dates, which products, what to chase. Nothing is
 * saved by it. "Fill the form" puts the proposal into the ordinary call form,
 * where the telecaller reads it and presses the ordinary Save; everything
 * that is not the call itself (a sample, a complaint on a call that was also
 * an order, a second reminder) opens its own ordinary form, filled in.
 *
 * WHAT IT NEVER DOES, and each is the client's rule:
 *   - save anything on its own;
 *   - overwrite what the telecaller typed — the form fills only empty fields;
 *   - guess. Where it is unsure the card asks a question with the candidates
 *     as buttons, and fields nobody said stay empty;
 *   - mark a customer do-not-contact. It SHOWS the words, prominently, and the
 *     button that records it is the telecaller's click.
 *
 * It also works without a microphone: "Read what I typed" reads the note box.
 * ------------------------------------------------------------------------- */

type Direction = "outbound_call" | "inbound_call" | null;

export type AssistantApply = {
  suggestion: Suggestion;
  draftId: string;
  direction: Direction;
};

/** What the dictation door heard, as it came back. */
type Heard = {
  spoken: string;
  english: string;
  language: string | null;
  servedBy: "sarvam" | "openai" | null;
};

/**
 * The reading that happens INSIDE the dictation modal, while the telecaller
 * is still looking at their note.
 *
 * `readText` is the English a reading was made from, so an edit since shows
 * as the two no longer matching. It is NULL for the first reading of a
 * recording, which is made from the transcript before the English exists —
 * that reading describes the note as written, whatever it turns out to say.
 */
type Live =
  | { kind: "off" }
  | { kind: "reading"; heard: Heard | null; readText: string | null }
  | {
      kind: "ready";
      heard: Heard | null;
      readText: string | null;
      draftId: string;
      analysis: CallAnalysis;
    }
  | { kind: "failed"; heard: Heard | null; readText: string | null; message: string };

/** The English a reading stands for. */
function readOf(live: Live): string | null {
  if (live.kind === "off") return null;
  return live.readText ?? live.heard?.english ?? null;
}

type Phase =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "done"; draftId: string; analysis: CallAnalysis; spoken: string }
  | { kind: "failed"; message: string };

export function CallAssistant({
  customerId,
  customerName,
  customerPhone,
  interactionType,
  notes,
  onNotes,
  onApply,
  complaintCategories,
  maxComplaintImages,
}: {
  customerId: string;
  customerName: string;
  customerPhone: string;
  interactionType: Direction | "order_received";
  notes: string;
  /** Receives the WHOLE new note — the dictated English joined to what was there. */
  onNotes: (next: string) => void;
  onApply: (a: AssistantApply) => void;
  complaintCategories: Array<{ value: string; label: string }>;
  maxComplaintImages: number;
}) {
  const { push, run } = useToast();
  const [enabled, setEnabled] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const [appliedKey, setAppliedKey] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<Record<string, string>>({});
  const [door, setDoor] = React.useState<"sample" | "complaint" | null>(null);
  const [doorSuggestion, setDoorSuggestion] = React.useState<Suggestion | null>(
    null,
  );
  const [sampleCtx, setSampleCtx] = React.useState<SampleRequestContext | null>(
    null,
  );
  const [showHeard, setShowHeard] = React.useState(false);
  const sectionRef = React.useRef<HTMLElement | null>(null);

  /* ---------------------------------------------- reading along the mic */
  const [live, setLive] = React.useState<Live>({ kind: "off" });
  /* Bumped by every new recording and every re-read; an answer carrying an
     older number describes words that are no longer on the screen. */
  const seq = React.useRef(0);
  /* The note in the box when the recording was sent — the typed half of what
     the reading read. */
  const typedAtStart = React.useRef("");
  /* Pressed "Use this" before the reading was back, or after an edit it had
     not caught up with: finish when it lands. `choice` is an answer picked in
     the modal, applied in place of the assistant's own first pick. */
  const pendingImport = React.useRef<{
    choice: Suggestion | null;
    english: string | null;
  } | null>(null);
  /* What the recording in flight has written. Refs because the recorder's
     callbacks were handed over renders ago, and must act on what is true now
     rather than on what was true when the microphone opened. */
  const heardRef = React.useRef<Heard | null>(null);
  const finishRef = React.useRef<
    (
      draftId: string,
      analysis: CallAnalysis,
      spoken: string,
      choice: Suggestion | null,
      english: string | null,
    ) => void
  >(() => {});
  React.useEffect(() => {
    finishRef.current = finish;
  });

  React.useEffect(() => {
    let live = true;
    callAssistantStatus().then((s) => {
      if (live) setEnabled(s.enabled);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!enabled || interactionType === "order_received") return null;

  async function read(
    meta: (DictationMeta & { english: string }) | null,
    typedNote: string,
  ) {
    setPhase({ kind: "reading" });
    setAppliedKey(null);
    setDone({});
    const result = await analyseCallAction({
      customerId,
      spoken: meta?.spoken ?? "",
      english: meta?.english ?? "",
      typedNote,
      language: meta?.language ?? null,
      heardBy: meta?.servedBy ?? "typed",
      interactionType:
        interactionType === "inbound_call" ||
        interactionType === "outbound_call"
          ? interactionType
          : null,
    });
    if (!result.ok) {
      setPhase({ kind: "failed", message: result.error });
      return;
    }
    setPhase({
      kind: "done",
      draftId: result.data.draftId,
      analysis: result.data.analysis,
      spoken: meta?.spoken ?? "",
    });
  }

  const direction0: Direction =
    interactionType === "inbound_call" || interactionType === "outbound_call"
      ? interactionType
      : null;

  /**
   * Out of the modal and onto the panel, with the form filled where the
   * reading is sure. Only a READY first pick fills on its own — anything the
   * assistant would have asked about is left as the question it is, and
   * do-not-call is never filled by anything but the telecaller's own click.
   */
  function finish(
    draftId: string,
    analysis: CallAnalysis,
    spoken: string,
    choice: Suggestion | null,
    english: string | null,
  ) {
    pendingImport.current = null;
    setAppliedKey(null);
    setDone({});
    setPhase({ kind: "done", draftId, analysis, spoken });
    /* The first reading was made from the transcript before the English was
       written; the draft keeps the note the telecaller actually used. */
    if (english)
      void noteDraftEnglishAction(draftId, english, heardRef.current?.servedBy ?? null);
    const primary = analysis.primary;
    const asking =
      primary?.state === "confirm" && analysis.alternatives.length > 1;
    const pick =
      choice ?? (primary && primary.state === "ready" && !asking ? primary : null);
    if (pick?.fill) apply(pick, draftId, analysis.direction ?? direction0);
  }

  /**
   * Read the call. The first reading of a recording starts the moment its
   * words are back (`readText` null); every later one is of the note as it now
   * stands, marked as the telecaller's correction.
   */
  async function runRead(args: {
    spoken: string;
    english: string;
    typedNote: string;
    language: string | null;
    heardBy: "sarvam" | "openai" | "dictation" | "typed";
    edited: boolean;
    readText: string | null;
  }) {
    const mine = ++seq.current;
    setLive({ kind: "reading", heard: heardRef.current, readText: args.readText });
    const result = await analyseCallAction({
      customerId,
      spoken: args.spoken,
      english: args.english,
      typedNote: args.typedNote,
      language: args.language,
      heardBy: args.heardBy,
      interactionType: direction0,
      edited: args.edited,
    });
    if (mine !== seq.current) return;
    const heard = heardRef.current;
    if (!result.ok) {
      setLive({ kind: "failed", heard, readText: args.readText, message: result.error });
      if (pendingImport.current) {
        pendingImport.current = null;
        setPhase({ kind: "failed", message: result.error });
      }
      return;
    }
    setLive({
      kind: "ready",
      heard,
      readText: args.readText,
      draftId: result.data.draftId,
      analysis: result.data.analysis,
    });
    if (pendingImport.current) {
      finishRef.current(
        result.data.draftId,
        result.data.analysis,
        heard?.spoken ?? args.spoken,
        pendingImport.current.choice,
        pendingImport.current.english,
      );
    }
  }

  function reread(english: string, typedNote: string) {
    const heard = heardRef.current;
    void runRead({
      spoken: heard?.spoken ?? "",
      english,
      typedNote,
      language: heard?.language ?? null,
      heardBy: heard?.servedBy ?? "typed",
      edited: true,
      readText: english,
    });
  }

  const companion: DictationCompanion = {
    workingLabel: "…and reading the call at the same time.",
    onStart: () => {
      seq.current += 1;
      heardRef.current = null;
      typedAtStart.current = notes;
      pendingImport.current = null;
      setLive({ kind: "reading", heard: null, readText: null });
    },
    onHeard: (h) => {
      void runRead({
        spoken: h.spoken,
        english: h.draft,
        typedNote: typedAtStart.current,
        language: h.language,
        /* Which provider heard it is known once the note is written, and
           is corrected onto the draft then. */
        heardBy: "dictation",
        edited: false,
        readText: null,
      });
    },
    onWritten: (note) => {
      heardRef.current = note;
      setLive((l) => (l.kind === "off" ? l : { ...l, heard: note }));
    },
    render: ({ english, importNow }) => (
      <LiveReading
        live={live}
        english={english}
        readText={readOf(live)}
        onReread={(text) => reread(text, typedAtStart.current)}
        onChoose={(choice) => {
          pendingImport.current = { choice, english };
          importNow(english);
        }}
      />
    ),
  };

  /**
   * "Use this and fill the form" in the modal. The note goes in at once; the
   * form fills now if the reading already describes exactly this note, or
   * the moment a reading of it lands.
   */
  function importDictated(english: string, replace: boolean, meta: DictationMeta) {
    const typed = replace ? "" : typedAtStart.current;
    onNotes(
      replace || !notes.trim() ? english : `${notes.trimEnd()}\n\n${english}`,
    );
    const choice = pendingImport.current?.choice ?? null;
    heardRef.current ??= {
      spoken: meta.spoken,
      english,
      language: meta.language,
      servedBy: meta.servedBy,
    };
    const sameTyped = typed === typedAtStart.current;
    if (live.kind === "ready" && readOf(live) === english && sameTyped) {
      finish(live.draftId, live.analysis, live.heard?.spoken ?? meta.spoken, choice, english);
      return;
    }
    pendingImport.current = { choice, english };
    setPhase({ kind: "reading" });
    /* Already reading exactly this note: that answer will finish it.
       Anything else — an edit, Tighten, Replace dropping the typed half — is
       read again. */
    const willAnswer =
      live.kind === "reading" && readOf(live) === english && sameTyped;
    if (!willAnswer) reread(english, typed);
  }

  function apply(s: Suggestion, draftId: string, direction: Direction) {
    onApply({ suggestion: s, draftId, direction });
    setAppliedKey(s.key + (s.fill?.outcome ?? ""));
    void markSuggestionAppliedAction(draftId, s.fill?.outcome ?? s.intent);
    /* The form it just filled is under this card; take the telecaller there,
       because checking it is the next thing they have to do. */
    requestAnimationFrame(() =>
      sectionRef.current?.nextElementSibling?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      }),
    );
  }

  async function makeReminder(s: Suggestion, dueDate: string) {
    const r = await run(
      createReminder({
        customerId,
        dueDate,
        note: s.reminder?.note ?? s.title,
      }),
    );
    if (r.ok)
      setDone((d) => ({
        ...d,
        [s.key]: `Reminder set for ${dayLabel(dueDate)}`,
      }));
  }

  async function moveReminder(s: Suggestion, dueDate: string) {
    if (!s.duplicateOf) return;
    const r = await run(rescheduleReminder(s.duplicateOf.id, dueDate));
    if (r.ok)
      setDone((d) => ({
        ...d,
        [s.key]: `Existing reminder moved to ${dayLabel(dueDate)}`,
      }));
  }

  async function openSample(s: Suggestion) {
    const ctx = await sampleRequestContext(customerId);
    if (!ctx.ok) {
      push(ctx.error, "error");
      return;
    }
    setSampleCtx(ctx.data);
    setDoorSuggestion(s);
    setDoor("sample");
  }

  /* ------------------------------------------------------------ idle */

  const typedReady = notes.trim().length > 1;

  const starter = (
    <div className="flex flex-col gap-2">
      {/* The SAME note as the form's own box further down — one piece of state,
          two places to write it — so typing here is typing the call's note. */}
      <Textarea
        rows={3}
        value={notes}
        onChange={(e) => onNotes(e.target.value)}
        placeholder="Or type it: e.g. “Payment 50 hazar after 15 days, also wants a sample of PU sealer”"
      />
      <div className="flex flex-wrap items-center gap-2">
        <DictateButton
          modalTitle="Tell us about the call"
          importLabel="Use this and fill the form"
          title="Speak about the call in any language"
          hasExistingText={notes.trim().length > 0}
          companion={companion}
          renderTrigger={(open) => (
            <Button variant="primary" onClick={open}>
              <MicGlyph /> Speak about the call
            </Button>
          )}
          onImport={importDictated}
        />
        <Button
          variant="secondary"
          disabled={!typedReady || phase.kind === "reading"}
          title={
            typedReady
              ? "Read the note already in the box"
              : "Type a note first, or speak"
          }
          onClick={() => read(null, notes)}
        >
          Read what I typed
        </Button>
      </div>
    </div>
  );

  if (phase.kind === "idle" || phase.kind === "failed") {
    return (
      <section className="mb-4 rounded-[6px] border border-brand-softer bg-brand-soft p-4">
        <div className="text-[15px] font-semibold text-ink">
          Just say what happened
        </div>
        <p className="mt-0.5 mb-3 text-[13px] text-body">
          Speak in any language. The assistant picks the outcome, works out the
          dates and fills the form — you check it and save. It never saves
          anything itself.
        </p>
        {starter}
        {phase.kind === "failed" ? (
          <p className="mt-2 text-[13px] text-danger">{phase.message}</p>
        ) : null}
      </section>
    );
  }

  if (phase.kind === "reading") {
    return (
      <section className="mb-4 rounded-[6px] border border-brand-softer bg-brand-soft p-4">
        <div className="text-[15px] font-semibold text-ink">
          Reading the call…
        </div>
        <p className="mt-0.5 text-[13px] text-body">
          Checking what is already open for {customerName} so nothing is raised
          twice.
        </p>
      </section>
    );
  }

  /* ------------------------------------------------------------ done */

  const { analysis, draftId } = phase;
  const direction = analysis.direction;
  const primary = analysis.primary;
  const asking =
    primary?.state === "confirm" && analysis.alternatives.length > 1;

  return (
    <section
      ref={sectionRef}
      className="mb-4 rounded-[6px] border border-brand-softer bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          What the assistant understood
        </span>
        {!analysis.readers.model ? (
          <Badge
            tone="warn"
            title="No language model answered, so this is only how similar calls were logged before."
          >
            From past calls only
          </Badge>
        ) : analysis.readers.agreed === false ? (
          <Badge
            tone="warn"
            title="How similar calls were logged points somewhere else."
          >
            Past calls disagree
          </Badge>
        ) : null}
        <span className="flex-1" />
        <button
          className="cursor-pointer text-[13px] text-brand"
          onClick={() => setPhase({ kind: "idle" })}
        >
          Start again
        </button>
      </div>

      {analysis.summary ? (
        <p className="mt-2 text-sm text-ink">{analysis.summary}</p>
      ) : null}

      {/* ------------------------------------------------ do not call */}
      {analysis.doNotCall ? (
        <div className="mt-3 rounded-[4px] border border-danger bg-danger-soft p-3">
          <div className="text-sm font-semibold text-danger">
            They may have asked not to be called again
          </div>
          {analysis.doNotCall.quote ? (
            <p className="mt-0.5 text-[13px] text-body">
              “{analysis.doNotCall.quote}”
            </p>
          ) : null}
          {analysis.doNotCall.alreadyMarked ? (
            <p className="mt-1 text-[13px] text-body">
              This customer is already marked do-not-contact.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  apply(
                    {
                      key: "dnc",
                      intent: "not_interested",
                      state: "confirm",
                      title: "Not interested — asked not to be called",
                      why: analysis.doNotCall?.quote ?? "",
                      questions: [],
                      duplicateOf: null,
                      date: null,
                      door: "form",
                      fill: {
                        outcome: "not_interested",
                        outcomeDetail: {
                          ...(primary?.intent === "not_interested"
                            ? primary.fill?.outcomeDetail
                            : {}),
                          futureOpportunity: "never",
                        },
                      },
                    },
                    draftId,
                    direction,
                  )
                }
              >
                Record it: they asked us not to call
              </Button>
              <span className="text-[12px] text-muted">
                Fills the form only. Nothing changes until you save the call.
              </span>
            </div>
          )}
        </div>
      ) : null}

      {/* ------------------------------------------------ feedback */}
      {analysis.feedback.length ? (
        <ul className="mt-3 flex flex-col gap-1">
          {analysis.feedback.map((f, i) => (
            <li
              key={i}
              className="flex items-start gap-2 text-[13px] text-body"
            >
              <span
                className={cx(
                  "mt-1.5 h-1.5 w-1.5 flex-none rounded-full",
                  f.tone === "positive"
                    ? "bg-success"
                    : f.tone === "negative"
                      ? "bg-danger"
                      : "bg-muted",
                )}
              />
              <span>
                {f.text}
                <span className="ml-1 text-muted">· {f.about}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* ------------------------------------------------ the call itself */}
      {primary ? (
        asking ? (
          <div className="mt-4 rounded-[4px] border border-warn-line bg-warn-soft p-3">
            <div className="text-sm font-semibold text-warn-ink">
              Which was it?
            </div>
            <p className="mt-0.5 text-[13px] text-body">
              The assistant is not sure enough to fill this in. Pick what
              happened and it fills the rest.
            </p>
            <div className="mt-2 flex flex-col gap-1.5">
              {analysis.alternatives.map((a) => (
                <button
                  key={a.outcome}
                  onClick={() => apply(a.suggestion, draftId, direction)}
                  className={cx(
                    "cursor-pointer rounded-[4px] border bg-surface px-3 py-2 text-left hover:border-brand",
                    appliedKey === a.suggestion.key + a.outcome
                      ? "border-brand"
                      : "border-line",
                  )}
                >
                  <span className="block text-sm font-medium text-ink">
                    {a.label}
                  </span>
                  {a.why ? (
                    <span className="block text-[12px] text-muted">
                      {a.why}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <SuggestionCard
            s={primary}
            primary
            applied={appliedKey === primary.key + (primary.fill?.outcome ?? "")}
            onApply={(s) => apply(s, draftId, direction)}
          />
        )
      ) : (
        <p className="mt-3 text-[13px] text-muted">
          Nothing in that says how the call ended. Pick the outcome below as
          usual.
        </p>
      )}

      {/* ------------------------------------------------ everything else */}
      {analysis.extras.length ? (
        <div className="mt-4">
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Also from this call
          </div>
          <div className="mt-1.5 flex flex-col gap-2">
            {analysis.extras.map((e) => (
              <ExtraCard
                key={e.key}
                s={e}
                doneLabel={done[e.key] ?? null}
                onReminder={(date) => makeReminder(e, date)}
                onMove={(date) => moveReminder(e, date)}
                onSample={() => openSample(e)}
                onComplaint={() => {
                  setDoorSuggestion(e);
                  setDoor("complaint");
                }}
              />
            ))}
          </div>
        </div>
      ) : null}

      {analysis.unclear.length ? (
        <div className="mt-3 text-[13px] text-body">
          <span className="font-medium">Could not tell: </span>
          {analysis.unclear.join(" · ")}
        </div>
      ) : null}

      {phase.spoken ? (
        <div className="mt-3">
          <button
            className="cursor-pointer text-[12px] text-brand"
            onClick={() => setShowHeard((v) => !v)}
          >
            {showHeard ? "Hide" : "Show"} what was said, as it was said
          </button>
          {showHeard ? (
            <p className="mt-1 rounded-[4px] bg-canvas p-2 text-[13px] whitespace-pre-wrap text-body">
              {phase.spoken}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------------------------ the doors */}
      {door === "sample" && doorSuggestion?.sample && sampleCtx ? (
        <Modal
          open
          onClose={() => setDoor(null)}
          title={`Request a sample for ${customerName}`}
          width={560}
          footer={null}
        >
          <RequestSampleForm
            key={doorSuggestion.key}
            customerId={customerId}
            customerName={customerName}
            defaultProductId={
              doorSuggestion.sample.product?.state === "matched"
                ? doorSuggestion.sample.product.productId
                : null
            }
            defaultProductName={
              doorSuggestion.sample.product?.state === "matched"
                ? doorSuggestion.sample.product.name
                : null
            }
            defaultApplication={doorSuggestion.sample.application}
            defaultCans={doorSuggestion.sample.quantityCans}
            leadStage={sampleCtx.leadStage}
            salesType={sampleCtx.salesType}
            reasons={sampleCtx.reasons}
            onClose={() => setDoor(null)}
            onRequested={() =>
              setDone((d) => ({
                ...d,
                [doorSuggestion.key]: "Sample requested",
              }))
            }
          />
        </Modal>
      ) : null}
      <LogComplaintDialog
        open={door === "complaint"}
        onClose={() => setDoor(null)}
        categories={complaintCategories.map((c) => c.label)}
        maxImages={maxComplaintImages}
        customer={{ id: customerId, name: customerName, phone: customerPhone }}
        defaults={{
          category:
            complaintCategories.find(
              (c) => c.value === doorSuggestion?.fill?.complaint?.category,
            )?.label ?? null,
          description: doorSuggestion?.fill?.complaint?.description ?? null,
          requestCn: doorSuggestion?.fill?.complaint?.requestCn ?? false,
        }}
        onSubmit={async (input) => {
          const r = await run(logComplaint(input));
          if (r.ok && doorSuggestion) {
            setDone((d) => ({
              ...d,
              [doorSuggestion.key]: "Complaint raised",
            }));
            setDoor(null);
          }
        }}
      />
    </section>
  );
}

/* ---------------------------------------------------------------- parts */

/**
 * The assistant's reading, drawn INSIDE the dictation modal under the note —
 * so the telecaller checks the words and what they will do in one look, and
 * one press both uses the note and fills the form.
 *
 * AN EDIT IS READ AGAIN. The note is the evidence; a reading of words that
 * are no longer on the screen would fill the form from the version the
 * telecaller just corrected. So once they stop typing for a moment the note
 * is read again as it now stands, marked as a correction so the model trusts
 * it over the transcript, and until that answer lands the card says it is
 * out of date and its choices are held — a choice made against the old
 * reading would be a choice about a different call.
 */
function LiveReading({
  live,
  english,
  readText,
  onReread,
  onChoose,
}: {
  live: Live;
  english: string;
  /** The English the reading on screen stands for. */
  readText: string | null;
  onReread: (english: string) => void;
  onChoose: (s: Suggestion) => void;
}) {
  const settled = live.kind === "ready" || live.kind === "failed";
  const edited =
    settled && readText !== null && english.trim() !== readText.trim();

  React.useEffect(() => {
    if (!edited || !english.trim()) return;
    const timer = setTimeout(() => onReread(english), 1200);
    return () => clearTimeout(timer);
    // Re-armed by the words changing, not by a new callback each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edited, english]);

  const frame = (children: React.ReactNode) => (
    <section className="mt-4 rounded-[6px] border border-brand-softer bg-brand-soft p-3">
      {children}
    </section>
  );

  if (live.kind === "off") return null;

  if (live.kind === "reading") {
    return frame(
      <div className="flex items-center gap-2 text-[13px] text-body">
        <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-brand" />
        {live.heard
          ? "Reading the call — the outcome, dates and anything to chase…"
          : "Reading the call as soon as the words are in…"}
      </div>,
    );
  }

  if (live.kind === "failed") {
    return frame(
      <div className="text-[13px]">
        <p className="text-danger">{live.message}</p>
        <p className="mt-0.5 text-muted">
          {edited
            ? "Reading your edit…"
            : "Your note is fine — use it and pick the outcome on the form yourself."}
        </p>
      </div>,
    );
  }

  const { analysis } = live;
  const primary = analysis.primary;
  const asking =
    primary?.state === "confirm" && analysis.alternatives.length > 1;
  const date = primary?.date?.date ?? null;

  return frame(
    <div className={cx(edited && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          What the assistant understood
        </span>
        {edited ? (
          <Badge tone="warn" title="You changed the note — it is being read again">
            Reading your edit…
          </Badge>
        ) : !analysis.readers.model ? (
          <Badge
            tone="warn"
            title="No language model answered, so this is only how similar calls were logged before."
          >
            From past calls only
          </Badge>
        ) : null}
      </div>

      {analysis.doNotCall && !analysis.doNotCall.alreadyMarked ? (
        <p className="mt-2 rounded-[4px] border border-danger bg-danger-soft px-2.5 py-1.5 text-[13px] text-danger">
          They may have asked not to be called again. You decide that on the
          form — it is never filled in for you.
        </p>
      ) : null}

      {primary ? (
        asking ? (
          <div className="mt-2">
            <div className="text-sm font-semibold text-ink">
              Which was it?
            </div>
            <p className="text-[12px] text-muted">
              Not sure enough to choose. Tap the right one — it uses the note
              and fills the form.
            </p>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {analysis.alternatives.map((a) => (
                <button
                  key={a.outcome}
                  disabled={edited}
                  onClick={() => onChoose(a.suggestion)}
                  className="cursor-pointer rounded-[4px] border border-line bg-surface px-3 py-1.5 text-left hover:border-brand disabled:cursor-not-allowed"
                >
                  <span className="block text-sm font-medium text-ink">
                    {a.label}
                  </span>
                  {a.why ? (
                    <span className="block text-[12px] text-muted">{a.why}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mt-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold text-ink">
                {primary.title}
              </span>
              <Badge tone={STATE_TONE[primary.state]}>
                {SUGGESTION_STATE_LABEL[primary.state]}
              </Badge>
            </div>
            <ul className="mt-1 flex flex-col gap-0.5 text-[13px] text-body">
              {date ? <li>{dayLabel(date)}</li> : null}
              {primary.fill?.payAmountRupees ? (
                <li>{money(primary.fill.payAmountRupees * 100)}</li>
              ) : null}
              {primary.fill?.orderLines?.map((l) => (
                <li key={l.productId}>
                  {l.name} —{" "}
                  {l.quantity === null ? "how many?" : `${l.quantity} cans`}
                </li>
              ))}
              {primary.questions.map((q, i) => (
                <li key={i} className="text-warn-ink">
                  • {q}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[12px] text-muted">
              {primary.state === "ready"
                ? "Fills the form when you use this. You still check it and save."
                : "Shown on the form for you to confirm — not filled on its own."}
            </p>
          </div>
        )
      ) : (
        <p className="mt-2 text-[13px] text-muted">
          Nothing in that says how the call ended. You will pick the outcome
          on the form.
        </p>
      )}

      {analysis.extras.length ? (
        <div className="mt-2 text-[13px] text-body">
          <span className="font-medium">Also from this call: </span>
          {analysis.extras.map((e) => e.title).join(" · ")}
          <span className="text-muted"> — each one is a button on the next screen.</span>
        </div>
      ) : null}

      {analysis.unclear.length ? (
        <div className="mt-1 text-[13px] text-body">
          <span className="font-medium">Could not tell: </span>
          {analysis.unclear.join(" · ")}
        </div>
      ) : null}
    </div>,
  );
}

const STATE_TONE = {
  ready: "brand",
  confirm: "warn",
  duplicate: "neutral",
} as const;

/** A suggestion with a date chosen from its choices, set on whichever field that outcome dates. */
function withDate(s: Suggestion, date: string): Suggestion {
  if (!s.fill) return s;
  const fill = { ...s.fill, outcomeDetail: { ...s.fill.outcomeDetail } };
  switch (fill.outcome) {
    case "follow_up":
      fill.followUpDate = date;
      break;
    case "no_order":
      fill.noOrderNextCallDate = date;
      break;
    case "payment_promised":
      fill.payDate = date;
      break;
    case "not_interested":
      fill.outcomeDetail.recallDate = date;
      break;
  }
  return { ...s, fill, date: s.date ? { ...s.date, date } : s.date };
}

function SuggestionCard({
  s,
  applied,
  onApply,
}: {
  s: Suggestion;
  primary?: boolean;
  applied: boolean;
  onApply: (s: Suggestion) => void;
}) {
  const [picked, setPicked] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const date = picked ?? s.date?.date ?? null;

  /* Once it has filled the form, the form is what needs reading — the card
     folds to one line so it stops pushing the form off the screen. */
  if (applied && !open) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-[4px] border border-line px-3 py-2">
        <span className="text-sm font-medium text-ink">{s.title}</span>
        <span className="text-[12px] text-success">
          Filled — check it below, then save.
        </span>
        <span className="flex-1" />
        <button
          className="cursor-pointer text-[12px] text-brand"
          onClick={() => setOpen(true)}
        >
          Show what it heard
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-[4px] border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-semibold text-ink">{s.title}</span>
        <Badge tone={STATE_TONE[s.state]}>
          {SUGGESTION_STATE_LABEL[s.state]}
        </Badge>
      </div>
      {s.why ? <p className="mt-1 text-[13px] text-muted">{s.why}</p> : null}
      {s.fill?.payAmountRupees ? (
        <p className="mt-1 text-[13px] text-body">
          Amount:{" "}
          <span className="font-medium">
            {money(s.fill.payAmountRupees * 100)}
          </span>
        </p>
      ) : null}
      {s.fill?.orderLines?.length ? (
        <ul className="mt-1 text-[13px] text-body">
          {s.fill.orderLines.map((l) => (
            <li key={l.productId}>
              {l.name} —{" "}
              {l.quantity === null ? "how many?" : `${l.quantity} cans`}
            </li>
          ))}
        </ul>
      ) : null}
      {s.date?.explanation && (date || s.date.choices.length) ? (
        <p className="mt-1 text-[13px] text-body">
          {date ? (
            <span className="font-medium">{dayLabel(date)} · </span>
          ) : null}
          {s.date.explanation}
        </p>
      ) : null}
      {s.date && !s.date.date && s.date.choices.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {s.date.choices.map((c) => (
            <button
              key={c.date}
              onClick={() => setPicked(c.date)}
              className={cx(
                "cursor-pointer rounded-[4px] border px-2 py-1 text-[12px]",
                picked === c.date
                  ? "border-brand bg-brand-soft text-brand-hover"
                  : "border-line bg-surface text-body hover:border-brand",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
      {s.questions.length ? (
        <ul className="mt-2 flex flex-col gap-0.5 text-[13px] text-warn-ink">
          {s.questions.map((q, i) => (
            <li key={i}>• {q}</li>
          ))}
        </ul>
      ) : null}
      {s.duplicateOf ? (
        <p className="mt-2 text-[13px] text-body">{s.duplicateOf.label}</p>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant={applied ? "secondary" : "primary"}
          onClick={() => onApply(picked ? withDate(s, picked) : s)}
        >
          {applied ? "Fill again" : "Fill the form"}
        </Button>
        {applied ? (
          <span className="text-[12px] text-success">
            Filled — check it below, then save.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ExtraCard({
  s,
  doneLabel,
  onReminder,
  onMove,
  onSample,
  onComplaint,
}: {
  s: Suggestion;
  doneLabel: string | null;
  onReminder: (date: string) => void;
  onMove: (date: string) => void;
  onSample: () => void;
  onComplaint: () => void;
}) {
  const [picked, setPicked] = React.useState<string | null>(null);
  const due = picked ?? s.reminder?.dueDate ?? s.date?.date ?? null;
  return (
    <div className="rounded-[4px] border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{s.title}</span>
        <Badge tone={STATE_TONE[s.state]}>
          {SUGGESTION_STATE_LABEL[s.state]}
        </Badge>
      </div>
      {s.why ? <p className="mt-0.5 text-[13px] text-muted">{s.why}</p> : null}
      {s.questions.length ? (
        <ul className="mt-1 text-[13px] text-warn-ink">
          {s.questions.map((q, i) => (
            <li key={i}>• {q}</li>
          ))}
        </ul>
      ) : null}
      {s.duplicateOf ? (
        <p className="mt-1 text-[13px] text-body">{s.duplicateOf.label}</p>
      ) : null}
      {(s.door === "reminder" || s.door === "reschedule") &&
      s.date &&
      !s.date.date &&
      s.date.choices.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {s.date.choices.map((c) => (
            <button
              key={c.date}
              onClick={() => setPicked(c.date)}
              className={cx(
                "cursor-pointer rounded-[4px] border px-2 py-1 text-[12px]",
                picked === c.date
                  ? "border-brand bg-brand-soft text-brand-hover"
                  : "border-line bg-surface text-body hover:border-brand",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        {doneLabel ? (
          <span className="text-[13px] text-success">{doneLabel}</span>
        ) : s.door === "reminder" ? (
          <Button
            size="sm"
            disabled={!due}
            onClick={() => due && onReminder(due)}
          >
            {due ? `Create reminder · ${dayLabel(due)}` : "Pick a day first"}
          </Button>
        ) : s.door === "reschedule" ? (
          <Button
            size="sm"
            disabled={!due}
            onClick={() => due && onMove(due)}
            title="Moves the reminder already open rather than adding a second"
          >
            {due
              ? `Move the existing reminder to ${dayLabel(due)}`
              : "Pick a day first"}
          </Button>
        ) : s.door === "sample" ? (
          <Button size="sm" onClick={onSample}>
            {s.state === "duplicate"
              ? "Request another anyway…"
              : "Open the sample request…"}
          </Button>
        ) : s.door === "complaint" ? (
          <Button size="sm" onClick={onComplaint}>
            {s.state === "duplicate"
              ? "Raise a separate complaint anyway…"
              : "Open the complaint…"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function MicGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
      className="mr-1.5 inline-block align-[-2px]"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
