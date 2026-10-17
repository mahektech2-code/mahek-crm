"use client";

import * as React from "react";
import { Badge, Button, Textarea, cx } from "@/components/ui/primitives";
import { DictateButton, type DictationMeta } from "@/components/ui/dictate";
import { analyseVerifyCallAction } from "@/lib/actions/verify-intel";
import {
  blockedReason as blockedFor,
  type ApplyContext,
  type VerifyAnalysis,
  type VerifyAnswerFill,
  type VerifyFindingFill,
} from "@/lib/engines/verify-intel-decide";
import type { VerifyAnswerKey, VerifyFindingKey } from "@/lib/verify-intel-schema";

/* ---------------------------------------------------------------------------
 * THE MANAGER VERIFICATION DIALOG'S VOICE ASSISTANT — at the top of the dialog,
 * above the answers it fills.
 *
 * The manager presses "Speak about this call" and says what the shop said — or
 * types it below and presses "Read what I typed". The assistant proposes
 * answers for the dialog's questions and shows where the shop's figures differ
 * from the salesman's, and NEVER saves anything: "Apply" writes into the same
 * dialog state a person clicking the answer would, through the two handlers the
 * dialog hands down, and the dialog's own save is what records a verification.
 *
 * WHAT THIS COMPONENT CAN REACH is exactly its props: the dialog's current
 * answers and finding rows (to leave anything the manager decided alone), and
 * two handlers — one that sets an answer, one that marks a finding Correct with
 * the shop's value. It is handed no way to choose the verification result, no
 * failure reason, no note, no correction reason and no way to save, so it could
 * not do any of those if it tried.
 *
 * A DIFFERENCE IS A PROPOSAL, NEVER A CHANGE. A finding where the shop disagrees
 * with the salesman is shown beside what he entered, with a button of its own;
 * it is never part of "Apply all ready", it only switches that one row to
 * Correct with the shop's value, and the row still demands the manager's own
 * reason before the dialog will save.
 *
 * WHAT WAS HEARD IS NOT WRITTEN ANYWHERE in the dialog. The text read here is
 * read and thrown away; the dialog's notes are the manager's own words.
 *
 * OBSERVATIONS ARE READ-ONLY, drawn by a component that is handed strings and
 * nothing else — no callback, no button.
 * ------------------------------------------------------------------------- */

type Phase =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "done"; analysis: VerifyAnalysis }
  | { kind: "failed"; message: string };

export function VerifyAssistant({
  customerId,
  context,
  onAnswer,
  onCorrect,
}: {
  customerId: string;
  /** What the dialog holds right now, so a proposal never overrides a decision. */
  context: ApplyContext;
  onAnswer: (key: VerifyAnswerKey, value: boolean | string) => void;
  onCorrect: (key: VerifyFindingKey, value: string) => void;
}) {
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const [applied, setApplied] = React.useState<Set<string>>(new Set());
  const [typed, setTyped] = React.useState("");

  async function read(meta: (DictationMeta & { english: string }) | null, typedNote: string) {
    setPhase({ kind: "reading" });
    setApplied(new Set());
    const result = await analyseVerifyCallAction({
      customerId,
      spoken: meta?.spoken ?? "",
      english: meta?.english ?? "",
      typedNote,
      language: meta?.language ?? null,
      heardBy: meta?.servedBy ?? "typed",
    });
    if (!result.ok) {
      setPhase({ kind: "failed", message: result.error });
      return;
    }
    setPhase({ kind: "done", analysis: result.data.analysis });
  }

  const blockedReason = (item: VerifyAnswerFill | VerifyFindingFill) => blockedFor(item, context);
  const idOf = (item: VerifyAnswerFill | VerifyFindingFill) => `${item.kind}:${item.key}`;

  function applyAnswer(fill: VerifyAnswerFill) {
    /* FILL-ONLY-UNTOUCHED — checked here, at the point of writing into the
       dialog's own state, which is the single place every answer passes through. */
    if (blockedReason(fill)) return;
    onAnswer(fill.key, fill.value);
    setApplied((s) => new Set(s).add(idOf(fill)));
  }

  function markCorrected(fill: VerifyFindingFill) {
    if (fill.relation !== "differs" || blockedReason(fill)) return;
    onCorrect(fill.key, fill.shopSays);
    setApplied((s) => new Set(s).add(idOf(fill)));
  }

  function applyAllReady(answers: VerifyAnswerFill[]) {
    for (const f of answers) if (f.state === "ready") applyAnswer(f);
  }

  const typedReady = typed.trim().length > 1;

  const starter = (
    <div className="flex flex-col gap-2">
      <Textarea
        rows={2}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder='Or type it: e.g. "Shop confirms the salesman visited and explained well, uses about 400 litres a month, no price problem, ready for a trial"'
      />
      <div className="flex flex-wrap items-center gap-2">
        <DictateButton
          modalTitle="Tell us about the verification call"
          importLabel="Read this"
          title="Speak about the call in any language"
          hasExistingText={false}
          renderTrigger={(open) => (
            <Button variant="primary" size="sm" onClick={open}>
              <MicGlyph /> Speak about this call
            </Button>
          )}
          onImport={(text, _replace, meta) => {
            void read({ ...meta, english: text }, "");
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!typedReady || phase.kind === "reading"}
          title={typedReady ? "Read what is typed above" : "Type a few words first, or speak"}
          onClick={() => void read(null, typed)}
        >
          Read what I typed
        </Button>
      </div>
    </div>
  );

  if (phase.kind === "idle" || phase.kind === "failed") {
    return (
      <section className="mb-4 rounded-[6px] border border-brand-softer bg-brand-soft p-3.5">
        <div className="text-[14px] font-semibold text-ink">Voice assistant</div>
        <p className="mt-0.5 mb-2.5 text-[12.5px] text-body">
          Say what the shop told you, in any language. The assistant suggests answers and shows where the shop&rsquo;s
          figures differ from the salesman&rsquo;s. You check each one, choose the result and write every reason yourself,
          and press Save verification. It never saves anything.
        </p>
        {starter}
        {phase.kind === "failed" ? <p className="mt-2 text-[12.5px] text-danger">{phase.message}</p> : null}
      </section>
    );
  }

  if (phase.kind === "reading") {
    return (
      <section className="mb-4 flex items-center gap-2 rounded-[6px] border border-brand-softer bg-brand-soft p-3.5">
        <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-brand" />
        <span className="text-[13px] text-body">Understanding…</span>
      </section>
    );
  }

  const { analysis } = phase;
  const readyCount = analysis.answers.filter(
    (f) => f.state === "ready" && !applied.has(idOf(f)) && !blockedReason(f),
  ).length;
  const nothing = !analysis.answers.length && !analysis.findings.length;

  return (
    <section className="mb-4 rounded-[6px] border border-brand-softer bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">Review suggested answers</span>
        <span className="flex-1" />
        <button type="button" className="cursor-pointer text-[12.5px] text-brand" onClick={() => setPhase({ kind: "idle" })}>
          Speak again
        </button>
      </div>

      {nothing ? (
        <p className="mt-2 text-[12.5px] text-muted">Nothing in that matched a question here. Fill the dialog in as usual.</p>
      ) : null}

      {analysis.answers.length ? (
        <>
          <div className="mt-2.5 mb-1 text-[10.5px] font-semibold tracking-[0.05em] text-muted uppercase">Answers</div>
          <div className="flex flex-col gap-1.5">
            {analysis.answers.map((f) => (
              <AnswerRow
                key={idOf(f)}
                fill={f}
                applied={applied.has(idOf(f))}
                blocked={blockedReason(f)}
                onApply={() => applyAnswer(f)}
              />
            ))}
          </div>
          {readyCount > 1 ? (
            <Button className="mt-2.5" size="sm" variant="secondary" onClick={() => applyAllReady(analysis.answers)}>
              Apply all ready answers ({readyCount})
            </Button>
          ) : null}
        </>
      ) : null}

      {analysis.findings.length ? (
        <>
          <div className="mt-3 mb-1 text-[10.5px] font-semibold tracking-[0.05em] text-muted uppercase">
            Salesman&rsquo;s findings
          </div>
          <div className="flex flex-col gap-1.5">
            {analysis.findings.map((f) => (
              <FindingRow
                key={idOf(f)}
                fill={f}
                applied={applied.has(idOf(f))}
                blocked={blockedReason(f)}
                onMark={() => markCorrected(f)}
              />
            ))}
          </div>
        </>
      ) : null}

      {analysis.unclear.length ? (
        <div className="mt-2.5 text-[12.5px] text-body">
          <span className="font-medium">Could not tell: </span>
          {analysis.unclear.join(" · ")}
        </div>
      ) : null}

      <Observations items={analysis.observations} />
    </section>
  );
}

function AnswerRow({
  fill,
  applied,
  blocked,
  onApply,
}: {
  fill: VerifyAnswerFill;
  applied: boolean;
  blocked: string | null;
  onApply: () => void;
}) {
  return (
    <div
      className={cx(
        "flex flex-wrap items-center gap-2 rounded-[4px] border px-3 py-2",
        applied ? "border-success/30 bg-success-soft" : "border-line bg-canvas",
      )}
    >
      <span className="text-[12.5px] font-medium text-ink">{fill.label}</span>
      <span className="text-[12.5px] text-body">{fill.display}</span>
      {fill.state === "confirm" ? (
        <Badge tone="warn" title={fill.questions.join(" · ") || "Not sure — check this before applying."}>
          Please check
        </Badge>
      ) : null}
      {fill.evidence ? (
        <span className="basis-full text-[11.5px] text-muted" title="The words this came from">
          &ldquo;{fill.evidence}&rdquo;
        </span>
      ) : null}
      {fill.state === "confirm" && fill.questions.length ? (
        <span className="basis-full text-[11.5px] text-warn-ink">{fill.questions.join(" · ")}</span>
      ) : null}
      <span className="flex-1" />
      {applied ? (
        <span className="text-[12px] text-success">Applied</span>
      ) : blocked ? (
        <span className="text-[12px] text-muted">{blocked}</span>
      ) : (
        <Button size="sm" variant="secondary" onClick={onApply}>
          {fill.state === "ready" ? "Apply" : "Apply anyway"}
        </Button>
      )}
    </div>
  );
}

function FindingRow({
  fill,
  applied,
  blocked,
  onMark,
}: {
  fill: VerifyFindingFill;
  applied: boolean;
  blocked: string | null;
  onMark: () => void;
}) {
  const differs = fill.relation === "differs";
  return (
    <div
      className={cx(
        "flex flex-wrap items-center gap-2 rounded-[4px] border px-3 py-2",
        applied ? "border-success/30 bg-success-soft" : differs ? "border-warn-line bg-warn-soft" : "border-line bg-canvas",
      )}
    >
      <span className="text-[12.5px] font-medium text-ink">{fill.label}</span>
      {differs ? (
        <span className="text-[12.5px] text-body">
          Salesman entered <b className="text-ink">{fill.onFile}</b> — the shop says <b className="text-ink">{fill.shopSays}</b>
        </span>
      ) : (
        <span className="text-[12.5px] text-body">Matches what the salesman entered ({fill.onFile})</span>
      )}
      {fill.evidence ? (
        <span className="basis-full text-[11.5px] text-muted" title="The words this came from">
          &ldquo;{fill.evidence}&rdquo;
        </span>
      ) : null}
      {fill.questions.length ? <span className="basis-full text-[11.5px] text-warn-ink">{fill.questions.join(" · ")}</span> : null}
      {differs ? (
        <span className="basis-full text-[11.5px] text-muted">
          Marking it corrected only switches the row below; you still write the reason yourself.
        </span>
      ) : null}
      <span className="flex-1" />
      {applied ? (
        <span className="text-[12px] text-success">Marked corrected</span>
      ) : differs && !blocked ? (
        <Button size="sm" variant="secondary" onClick={onMark}>
          Mark as corrected
        </Button>
      ) : (
        <span className="text-[12px] text-muted">{blocked}</span>
      )}
    </div>
  );
}

/**
 * Plain statements of what the shop said that no answer takes — for the manager
 * to READ. This is handed strings and nothing else: no callback and no button,
 * so nothing on this card can put one into the dialog.
 */
function Observations({ items }: { items: readonly string[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-3 rounded-[4px] border border-line bg-canvas px-3 py-2">
      <div className="text-[10.5px] font-semibold tracking-[0.05em] text-muted uppercase">
        What else the shop said — for you to read, not applied
      </div>
      <ul className="mt-1 space-y-1">
        {items.map((o) => (
          <li key={o} className="text-[12.5px] text-body">
            {o}
          </li>
        ))}
      </ul>
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
