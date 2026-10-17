"use client";

import * as React from "react";
import { Badge, Button, Textarea, cx } from "@/components/ui/primitives";
import { DictateButton, type DictationMeta } from "@/components/ui/dictate";
import { analyseLeadCallAction } from "@/lib/actions/lead-call-intel";
import type { LeadCallAnalysis, LeadCallFill } from "@/lib/engines/lead-call-intel-decide";
import type { DeskFieldKey } from "@/lib/engines/lead-calling-desk";
import type { ProductMatch } from "@/lib/engines/call-intel-decide";

/* ---------------------------------------------------------------------------
 * THE LEAD CALLING DESK'S VOICE ASSISTANT — Call 1/2/3's own, beside the
 * questions it fills.
 *
 * The telecaller presses "Speak about this call" and talks, in any language,
 * about what the customer just said — or types it into the box below and
 * presses "Read what I typed". Either way this proposes a value for whichever
 * of the questions on THIS call are still open, never more, and NEVER saves
 * anything: "Apply to form" writes into the same `text`/`productId` state a
 * human typing into the boxes below would, and the existing Save call button
 * is what actually records anything.
 *
 * FILL-ONLY-EMPTY. A proposal is applied to a field only where that field's
 * own box is still empty — a telecaller who has already typed an answer is
 * never overwritten, voice or not.
 * ------------------------------------------------------------------------- */

type Phase =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "done"; analysis: LeadCallAnalysis; callNumber: number }
  | { kind: "failed"; message: string };

export function LeadCallAssistant({
  customerId,
  notes,
  onNotes,
  currentText,
  currentProductId,
  onFillText,
  onFillProduct,
}: {
  customerId: string;
  /** The call's own "Notes" box — read along with whatever was spoken. */
  notes: string;
  onNotes: (next: string) => void;
  /** What is already typed, so a proposal never overwrites it. */
  currentText: Partial<Record<DeskFieldKey, string>>;
  currentProductId: string | null;
  onFillText: (key: DeskFieldKey, value: string) => void;
  onFillProduct: (match: Extract<ProductMatch, { state: "matched" }>) => void;
}) {
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const [applied, setApplied] = React.useState<Set<DeskFieldKey>>(new Set());

  async function read(meta: (DictationMeta & { english: string }) | null, typedNote: string) {
    setPhase({ kind: "reading" });
    setApplied(new Set());
    const result = await analyseLeadCallAction({
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
    setPhase({ kind: "done", analysis: result.data.analysis, callNumber: result.data.callNumber });
  }

  function applyOne(fill: LeadCallFill) {
    /* FILL-ONLY-EMPTY — checked here, at the point of writing into the
       dialog's own state, which is the single place every proposed field
       passes through on its way to the form. */
    if (fill.key === "requiredProductId") {
      if (currentProductId) return;
      if (fill.product?.state === "matched") onFillProduct(fill.product);
    } else {
      if ((currentText[fill.key] ?? "").trim()) return;
      if (fill.textValue) onFillText(fill.key, fill.textValue);
    }
    setApplied((s) => new Set(s).add(fill.key));
  }

  function applyAllReady(fills: LeadCallFill[]) {
    for (const f of fills) if (f.state === "ready") applyOne(f);
  }

  const typedReady = notes.trim().length > 1;

  const starter = (
    <div className="flex flex-col gap-2">
      <Textarea
        rows={2}
        value={notes}
        onChange={(e) => onNotes(e.target.value)}
        placeholder='Or type it: e.g. "Dealer, needs about 400 litres a month of Nano Thinner, currently using a local brand"'
      />
      <div className="flex flex-wrap items-center gap-2">
        <DictateButton
          modalTitle="Tell us about the call"
          importLabel="Use this"
          title="Speak about the call in any language"
          hasExistingText={notes.trim().length > 0}
          renderTrigger={(open) => (
            <Button variant="primary" size="sm" onClick={open}>
              <MicGlyph /> Speak about this call
            </Button>
          )}
          onImport={(text, _replace, meta) => {
            onNotes(text);
            void read({ ...meta, english: text }, text);
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!typedReady || phase.kind === "reading"}
          title={typedReady ? "Read the note already in the box" : "Type a note first, or speak"}
          onClick={() => void read(null, notes)}
        >
          Read what I typed
        </Button>
      </div>
    </div>
  );

  if (phase.kind === "idle" || phase.kind === "failed") {
    return (
      <section className="mb-3 rounded-[6px] border border-brand-softer bg-brand-soft p-3.5">
        <div className="text-[14px] font-semibold text-ink">Voice assistant</div>
        <p className="mt-0.5 mb-2.5 text-[12.5px] text-body">
          Speak in any language — the assistant suggests answers for the questions below. You still
          check them and press Save call.
        </p>
        {starter}
        {phase.kind === "failed" ? <p className="mt-2 text-[12.5px] text-danger">{phase.message}</p> : null}
      </section>
    );
  }

  if (phase.kind === "reading") {
    return (
      <section className="mb-3 flex items-center gap-2 rounded-[6px] border border-brand-softer bg-brand-soft p-3.5">
        <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-brand" />
        <span className="text-[13px] text-body">Understanding…</span>
      </section>
    );
  }

  const { analysis } = phase;
  const readyCount = analysis.fills.filter((f) => f.state === "ready" && !applied.has(f.key)).length;

  return (
    <section className="mb-3 rounded-[6px] border border-brand-softer bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">
          {analysis.readByModel ? "Review suggested answers" : "Could not read this call"}
        </span>
        <span className="flex-1" />
        <button className="cursor-pointer text-[12.5px] text-brand" onClick={() => setPhase({ kind: "idle" })}>
          Speak again
        </button>
      </div>

      {!analysis.fills.length ? (
        <p className="mt-2 text-[12.5px] text-muted">
          Nothing in that matched a question this call is asking. Fill the boxes below as usual.
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-col gap-1.5">
            {analysis.fills.map((f) => (
              <FillRow key={f.key} fill={f} applied={applied.has(f.key)} onApply={() => applyOne(f)} />
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
    </section>
  );
}

function FillRow({
  fill,
  applied,
  onApply,
}: {
  fill: LeadCallFill;
  applied: boolean;
  onApply: () => void;
}) {
  const display =
    fill.key === "requiredProductId"
      ? (fill.product?.state === "matched" ? fill.product.name : fill.product?.state === "ambiguous" ? "several matches" : "no match")
      : (fill.textValue ?? "");
  const blocked = fill.key === "requiredProductId" ? fill.product?.state !== "matched" : !fill.textValue;

  return (
    <div
      className={cx(
        "flex flex-wrap items-center gap-2 rounded-[4px] border px-3 py-2",
        applied ? "border-success/30 bg-success-soft" : "border-line bg-canvas",
      )}
    >
      <span className="text-[12.5px] font-medium text-ink">{fill.label}</span>
      <span className="text-[12.5px] text-body">{display}</span>
      {fill.state === "confirm" ? (
        <Badge tone="warn" title={fill.questions.join(" · ") || "Not sure — check this before applying."}>
          Please check
        </Badge>
      ) : null}
      <span className="flex-1" />
      {applied ? (
        <span className="text-[12px] text-success">Applied</span>
      ) : (
        <Button size="sm" variant="secondary" disabled={blocked} onClick={onApply}>
          {fill.state === "ready" ? "Apply" : "Apply anyway"}
        </Button>
      )}
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
