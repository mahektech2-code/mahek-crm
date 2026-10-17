"use client";

import * as React from "react";
import { Badge, Button, Textarea, cx } from "@/components/ui/primitives";
import { DictateButton, type DictationMeta } from "@/components/ui/dictate";
import { analyseIntakeAction } from "@/lib/actions/intake-intel";
import { blockedReason as blockedFor, type IntakeAnalysis, type IntakeFill } from "@/lib/engines/intake-intel-decide";
import type { IntakeFillKey } from "@/lib/intake-intel-schema";
import type { LeadWorkspace } from "@/lib/lead-workspace";

/* ---------------------------------------------------------------------------
 * THE LEAD INTAKE FORM'S VOICE ASSISTANT — beside the boxes it fills.
 *
 * The telecaller presses "Speak about this call" and talks, in any language,
 * about the customer on the phone — or types into the box below and presses
 * "Read what I typed". The assistant proposes a value for whichever of the
 * form's boxes the words support, and NEVER saves anything: "Apply" writes into
 * the same state a person typing into the box would, through the one `onFill`
 * the form hands down, and the form's own "Raise the lead" is the only thing
 * that creates a lead.
 *
 * WHAT THIS COMPONENT CAN REACH is exactly its props: the current text of each
 * box (to leave a filled one alone), and `onFill(key, value)` for the keys on
 * `IntakeFillKey`. It is handed no way to submit, no way to choose how the
 * customer is sold to, and no owner, priority or duplicate control — so it
 * could not do those things if it tried. `offerUnder` is a plain boolean saying
 * whether the form is drawing its "Under" box.
 *
 * FILL-ONLY-EMPTY. A proposal is applied to a box only where that box is
 * still empty. Somebody who has already typed an answer is never overwritten,
 * by voice or otherwise; they can change it themselves.
 *
 * WHAT WAS HEARD IS NOT WRITTEN ANYWHERE. The dictation modal's text is read
 * and thrown away; it is not put into the Note. The Note box receives only
 * what the Note PROPOSAL says, and only when it is applied.
 *
 * OBSERVATIONS ARE READ-ONLY. They are drawn by a component that is handed
 * strings and nothing else — no callback, no button — so nothing here can put
 * one into a box.
 * ------------------------------------------------------------------------- */

type Phase =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "done"; analysis: IntakeAnalysis }
  | { kind: "failed"; message: string };

export function IntakeAssistant({
  workspace,
  offerUnder,
  current,
  onFill,
}: {
  workspace: LeadWorkspace;
  /** Whether the form is drawing its "Under" box. */
  offerUnder: boolean;
  /** What is already in each box, so a proposal never overwrites it. */
  current: Partial<Record<IntakeFillKey, string>>;
  onFill: (key: IntakeFillKey, value: string) => void;
}) {
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const [applied, setApplied] = React.useState<Set<IntakeFillKey>>(new Set());
  const [typed, setTyped] = React.useState("");

  async function read(meta: (DictationMeta & { english: string }) | null, typedNote: string) {
    setPhase({ kind: "reading" });
    setApplied(new Set());
    const result = await analyseIntakeAction({
      workspace,
      spoken: meta?.spoken ?? "",
      english: meta?.english ?? "",
      typedNote,
      language: meta?.language ?? null,
      heardBy: meta?.servedBy ?? "typed",
      offerUnder,
    });
    if (!result.ok) {
      setPhase({ kind: "failed", message: result.error });
      return;
    }
    setPhase({ kind: "done", analysis: result.data.analysis });
  }

  /** Why a fill cannot be applied right now, or null if it can. */
  const blockedReason = (fill: IntakeFill) => blockedFor(fill, current);

  function applyOne(fill: IntakeFill) {
    /* FILL-ONLY-EMPTY — checked here, at the point of writing into the form's
       own state, which is the single place every proposal passes through. */
    if (blockedReason(fill)) return;
    onFill(fill.key, fill.value);
    setApplied((s) => new Set(s).add(fill.key));
  }

  function applyAllReady(fills: IntakeFill[]) {
    for (const f of fills) if (f.state === "ready") applyOne(f);
  }

  const typedReady = typed.trim().length > 1;

  const starter = (
    <div className="flex flex-col gap-2">
      <Textarea
        rows={2}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder='Or type it: e.g. "Ramesh from Shree Paints, Nashik, 98xxxxxx21, dealer, needs about 400 litres a month of thinner"'
      />
      <div className="flex flex-wrap items-center gap-2">
        <DictateButton
          modalTitle="Tell us about the call"
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
          Speak in any language — the assistant suggests values for the boxes below. You check each one,
          apply what is right, and press Raise the lead yourself. It never saves anything.
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
  const readyCount = analysis.fills.filter((f) => f.state === "ready" && !applied.has(f.key) && !blockedReason(f)).length;

  return (
    <section className="mb-4 rounded-[6px] border border-brand-softer bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">Review suggested values</span>
        <span className="flex-1" />
        <button className="cursor-pointer text-[12.5px] text-brand" onClick={() => setPhase({ kind: "idle" })}>
          Speak again
        </button>
      </div>

      {!analysis.fills.length ? (
        <p className="mt-2 text-[12.5px] text-muted">
          Nothing in that matched a box on this form. Fill the form in as usual.
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-col gap-1.5">
            {analysis.fills.map((f) => (
              <FillRow
                key={f.key}
                fill={f}
                applied={applied.has(f.key)}
                blocked={blockedReason(f)}
                onApply={() => applyOne(f)}
              />
            ))}
          </div>
          {readyCount > 1 ? (
            <Button className="mt-2.5" size="sm" variant="secondary" onClick={() => applyAllReady(analysis.fills)}>
              Apply all ready ({readyCount})
            </Button>
          ) : null}
        </>
      )}

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

function FillRow({
  fill,
  applied,
  blocked,
  onApply,
}: {
  fill: IntakeFill;
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

/**
 * Plain statements of what the customer said that no box takes — for the
 * telecaller to READ. This is handed strings and nothing else: no callback and
 * no button, so nothing on this card can put one into a box, and anyone who
 * wants one in the Note types it there themselves.
 */
function Observations({ items }: { items: readonly string[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-3 rounded-[4px] border border-line bg-canvas px-3 py-2">
      <div className="text-[10.5px] font-semibold tracking-[0.05em] text-muted uppercase">
        Observations — for you to read, not applied
      </div>
      <ul className="mt-1 space-y-1">
        {items.map((o) => (
          <li key={o} className="text-[12.5px] text-body">
            Observation: {o}
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
