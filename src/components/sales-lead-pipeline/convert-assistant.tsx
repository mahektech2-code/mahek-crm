"use client";

import * as React from "react";
import { Badge, Button, Textarea, cx } from "@/components/ui/primitives";
import { DictateButton, type DictationMeta } from "@/components/ui/dictate";
import { analyseConvertCallAction } from "@/lib/actions/convert-intel";
import {
  blockedReason as blockedFor,
  type ConvertAnalysis,
  type ConvertApplyContext,
  type ConvertItem,
  type ConvertOnFile,
} from "@/lib/engines/convert-intel-decide";

/* ---------------------------------------------------------------------------
 * THE CONVERT-TO-PROSPECT DIALOG'S VOICE ASSISTANT — at the top of the dialog,
 * above the facts it fills.
 *
 * The manager presses "Speak about this shop" and says what they know — or types
 * it below and presses "Read what I typed". The assistant proposes a value for
 * each fact the dialog asks and sorts every one into exactly one of four
 * states, because the save behind this dialog (`convertProspect`) writes the
 * values straight into the lead's own fields and keeps no record of what was
 * there:
 *
 *   Ready to apply      the lead has nothing for this fact, and the words support it.
 *   Needs checking      the words do not support it well enough — or a product is
 *                       ambiguous or unknown, which cannot be applied at all.
 *   Conflict            the lead already holds a DIFFERENT value. Shown beside it,
 *                       with a button that is the manager's own act; never a fill.
 *   Already matches     the shop agrees with what is on file. Nothing to do.
 *
 * It NEVER saves anything. "Apply" and "Mark as corrected" call the two
 * handlers the dialog hands down, which change this dialog's own state and
 * nothing else; "Convert to Prospect" is what writes, pressed by a person.
 *
 * WHAT THIS COMPONENT CAN REACH is exactly its props: what the dialog holds
 * right now (so a fact the manager changed is left alone) and those two
 * handlers. It is handed no way to choose the conversion reason, no way to mark
 * a fact Confirmed or Unable To Verify, and no way to convert.
 *
 * "APPLY ALL READY" APPLIES READY ITEMS ONLY — never a conflict, never an item
 * that needs checking.
 *
 * WHAT WAS HEARD IS NOT WRITTEN ANYWHERE. The text read here is read and thrown
 * away.
 * ------------------------------------------------------------------------- */

type Phase =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "done"; analysis: ConvertAnalysis }
  | { kind: "failed"; message: string };

const STATUS_LABEL: Record<ConvertItem["status"], string> = {
  ready: "Ready to apply",
  uncertain: "Needs checking",
  conflict: "Conflict with salesman's value",
  matches: "Already matches",
};
const STATUS_TONE = { ready: "success", uncertain: "warn", conflict: "danger", matches: "muted" } as const;

export function ConvertAssistant({
  customerId,
  context,
  onFile,
  onFill,
  onCorrect,
}: {
  customerId: string;
  /** What the dialog holds right now, so a proposal never overrides what the manager did. */
  context: ConvertApplyContext;
  /** The two on-file values the picker rules need. */
  onFile: Pick<ConvertOnFile, "customerType" | "productId">;
  /** Put a proposal into a fact the lead has nothing for. */
  onFill: (item: ConvertItem) => void;
  /** Mark a fact the lead already has as corrected to the shop's value. */
  onCorrect: (item: ConvertItem) => void;
}) {
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const [applied, setApplied] = React.useState<Set<string>>(new Set());
  const [typed, setTyped] = React.useState("");

  async function read(meta: (DictationMeta & { english: string }) | null, typedNote: string) {
    setPhase({ kind: "reading" });
    setApplied(new Set());
    const result = await analyseConvertCallAction({
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

  const blockedReason = (item: ConvertItem) => blockedFor(item, context, onFile);

  function applyOne(item: ConvertItem) {
    /* FILL-ONLY-UNTOUCHED — checked here, at the point of writing into the
       dialog's own state, which is the single place every proposal passes through. */
    if (item.status === "conflict" || item.status === "matches" || blockedReason(item)) return;
    onFill(item);
    setApplied((s) => new Set(s).add(item.key));
  }

  function markCorrected(item: ConvertItem) {
    if (item.status !== "conflict" || blockedReason(item)) return;
    onCorrect(item);
    setApplied((s) => new Set(s).add(item.key));
  }

  function applyAllReady(items: ConvertItem[]) {
    for (const item of items) if (item.status === "ready") applyOne(item);
  }

  const typedReady = typed.trim().length > 1;

  const starter = (
    <div className="flex flex-col gap-2">
      <Textarea
        rows={2}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder='Or type it: e.g. "Dealer, needs about 400 litres a month of Nano Thinner, buys from a local brand, ask for Ramesh"'
      />
      <div className="flex flex-wrap items-center gap-2">
        <DictateButton
          modalTitle="Tell us about the shop"
          importLabel="Read this"
          title="Speak about the shop in any language"
          hasExistingText={false}
          renderTrigger={(open) => (
            <Button variant="primary" size="sm" onClick={open}>
              <MicGlyph /> Speak about this shop
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
          Say what you know about the shop, in any language. The assistant fills what is still empty and flags where
          you are told something different from what the salesman entered — it never replaces his value. You choose the
          reason and press Convert to Prospect yourself. It never saves anything.
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
  const readyCount = analysis.items.filter((i) => i.status === "ready" && !applied.has(i.key) && !blockedReason(i)).length;

  return (
    <section className="mb-4 rounded-[6px] border border-brand-softer bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">Review suggestions</span>
        <span className="flex-1" />
        <button type="button" className="cursor-pointer text-[12.5px] text-brand" onClick={() => setPhase({ kind: "idle" })}>
          Speak again
        </button>
      </div>

      {!analysis.items.length ? (
        <p className="mt-2 text-[12.5px] text-muted">Nothing in that matched a fact this dialog asks. Fill it in as usual.</p>
      ) : (
        <>
          <div className="mt-2.5 flex flex-col gap-1.5">
            {analysis.items.map((item) => (
              <ItemRow
                key={item.key}
                item={item}
                applied={applied.has(item.key)}
                blocked={blockedReason(item)}
                onApply={() => applyOne(item)}
                onMark={() => markCorrected(item)}
              />
            ))}
          </div>
          {readyCount > 1 ? (
            <Button className="mt-2.5" size="sm" variant="secondary" onClick={() => applyAllReady(analysis.items)}>
              Apply all ready ({readyCount})
            </Button>
          ) : null}
        </>
      )}

      {analysis.stillMissing.length ? (
        <div className="mt-2.5 text-[12.5px] text-body">
          <span className="font-medium">Still to find out: </span>
          {analysis.stillMissing.join(" · ")}
        </div>
      ) : null}
      {analysis.unclear.length ? (
        <div className="mt-1.5 text-[12.5px] text-body">
          <span className="font-medium">Could not tell: </span>
          {analysis.unclear.join(" · ")}
        </div>
      ) : null}
    </section>
  );
}

function ItemRow({
  item,
  applied,
  blocked,
  onApply,
  onMark,
}: {
  item: ConvertItem;
  applied: boolean;
  blocked: string | null;
  onApply: () => void;
  onMark: () => void;
}) {
  const conflict = item.status === "conflict";
  return (
    <div
      className={cx(
        "flex flex-wrap items-center gap-2 rounded-[4px] border px-3 py-2",
        applied
          ? "border-success/30 bg-success-soft"
          : conflict
            ? "border-warn-line bg-warn-soft"
            : "border-line bg-canvas",
      )}
    >
      <span className="text-[12.5px] font-medium text-ink">{item.label}</span>
      <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
      {conflict ? (
        <span className="basis-full text-[12.5px] text-body">
          Salesman entered <b className="text-ink">{item.onFile}</b> — customer says <b className="text-ink">{item.display}</b>
        </span>
      ) : item.status === "matches" ? (
        <span className="text-[12.5px] text-body">{item.display}</span>
      ) : (
        <span className="text-[12.5px] text-body">{item.display}</span>
      )}
      {item.options?.length ? (
        <span className="basis-full text-[12px] text-body">Could be: {item.options.join(" · ")}</span>
      ) : null}
      {item.evidence ? (
        <span className="basis-full text-[11.5px] text-muted" title="The words this came from">
          &ldquo;{item.evidence}&rdquo;
        </span>
      ) : null}
      {item.questions.length ? <span className="basis-full text-[11.5px] text-warn-ink">{item.questions.join(" · ")}</span> : null}
      {conflict ? (
        <span className="basis-full text-[11.5px] text-muted">
          Marking it corrected only changes this dialog; nothing is saved until you press Convert to Prospect.
        </span>
      ) : null}
      <span className="flex-1" />
      {applied ? (
        <span className="text-[12px] text-success">{conflict ? "Marked corrected" : "Applied"}</span>
      ) : blocked ? (
        <span className="text-[12px] text-muted">{blocked}</span>
      ) : conflict ? (
        <Button size="sm" variant="secondary" onClick={onMark}>
          Mark as corrected
        </Button>
      ) : (
        <Button size="sm" variant="secondary" onClick={onApply}>
          {item.status === "ready" ? "Apply" : "Apply anyway"}
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
