"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { recordGateDecision, refreshGateRecommendation } from "@/lib/hire/actions/decisions";
import type { GateRec } from "@/lib/hire/ai/gate-recommendation";
import type { GateDecision } from "@/lib/hire/services/decisions";
import { DECISION_REASON_MIN } from "@/lib/hire/engines/gating";
import { Btn, BtnLink, Callout, Quote, fdt } from "../../_ui/kit";

type Choice = "advance" | "hold" | "reject";
const ACTION: Record<Choice, string> = { advance: "Advance", hold: "Hold", reject: "Reject" };

export function GateClient({
  applicationId,
  name,
  nextStageName,
  atGate,
  whereNow,
  canDecide,
  lockLine,
  rec: initialRec,
  aiDown,
  last,
  reasons,
}: {
  applicationId: string;
  name: string;
  nextStageName: string | null;
  atGate: boolean;
  whereNow: string;
  canDecide: boolean;
  lockLine: string;
  rec: (GateRec & { at: string | null }) | null;
  aiDown: string | null;
  last: GateDecision | null;
  reasons: { k: string; l: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [rec, setRec] = useState(initialRec);
  const [refreshing, setRefreshing] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [why, setWhy] = useState("");
  const [disagree, setDisagree] = useState(false);
  const [touchedDisagree, setTouchedDisagree] = useState(false);
  const [reasonCode, setReasonCode] = useState("decision");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const len = why.trim().length;
  const differs = Boolean(rec && choice && rec.action !== choice);
  /* Suggested, never forced: ticked for them when their choice differs, until they touch it. */
  const disagreeShown = touchedDisagree ? disagree : differs;
  const ready = Boolean(choice) && len >= DECISION_REASON_MIN && !busy;

  const refresh = async () => {
    setRefreshing(true);
    setRecError(null);
    const r = await refreshGateRecommendation(applicationId);
    setRefreshing(false);
    if (!r.ok) return setRecError(r.error);
    setRec({ ...r.data, at: new Date().toISOString() });
  };

  const record = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    const r = await recordGateDecision(applicationId, { decision: choice, reasoning: why, disagree: disagreeShown, reasonCode });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    toast.push(r.message ?? "Decision recorded.");
    router.refresh();
  };

  return (
    <>
      <section className="overflow-hidden rounded-[6px] border border-ai-line bg-surface">
        <div className="flex items-center justify-between border-b border-ai-line bg-ai-soft px-7 py-2.5 text-ai">
          <span className="text-xs font-semibold tracking-[0.04em] uppercase">◈ AI recommendation</span>
          <span className="flex items-center gap-3 text-xs font-medium">
            {rec ? (
              <>
                {rec.confidence === "Moderate" ? <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden /> : null}
                Confidence: {rec.confidence}
              </>
            ) : null}
            {canDecide && !aiDown ? (
              <button onClick={refresh} disabled={refreshing} className="cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-ai underline disabled:cursor-wait">
                {refreshing ? "Reading the evidence…" : rec ? "Refresh" : "Ask for a recommendation"}
              </button>
            ) : null}
          </span>
        </div>
        <div className="px-7 py-[18px]">
          {rec ? (
            <>
              <div className="text-lg font-semibold text-ai">
                {ACTION[rec.action]}
                {rec.action === "advance" && nextStageName ? ` to ${nextStageName.toLowerCase()}` : ""}
              </div>
              <div className="mt-1.5 text-sm leading-[22px] text-body">{rec.why}</div>
              {rec.evidence.length ? (
                <div className="mt-4 flex flex-col gap-3">
                  {rec.evidence.map((e, i) => (
                    <Quote key={i} caption={e.source}>
                      {e.verbatim}
                    </Quote>
                  ))}
                </div>
              ) : null}
              {rec.at ? <div className="mt-3 text-[12px] text-muted">Read {fdt(rec.at)}. It supports your decision; it does not make it.</div> : null}
            </>
          ) : (
            <div className="text-sm text-muted">{aiDown ? `${aiDown} The decision below works without it.` : "No recommendation yet. You can decide without one, or ask for one first."}</div>
          )}
          {recError ? <Callout tone="warn" className="mt-3">{recError} The decision below works without it.</Callout> : null}
        </div>
      </section>

      {atGate && canDecide ? (
        <section className="flex flex-col gap-[18px] rounded-[6px] border-2 border-heading bg-surface px-8 py-7">
          <div className="text-xs font-semibold tracking-[0.06em] text-heading uppercase">Your decision</div>
          <div className="flex gap-2.5" role="radiogroup" aria-label="Your decision">
            {(["advance", "hold", "reject"] as Choice[]).map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={choice === c}
                onClick={() => setChoice(c)}
                className={cx(
                  "flex h-11 flex-1 cursor-pointer items-center justify-center gap-2.5 rounded-[4px] border text-[15px] font-medium",
                  choice === c ? "border-heading bg-heading text-white" : "border-line-strong bg-surface text-heading hover:bg-canvas",
                )}
              >
                <span className={cx("h-3.5 w-3.5 rounded-full border-2", choice === c ? "border-white bg-white shadow-[inset_0_0_0_2px_var(--color-heading)]" : "border-line-strong")} />
                {ACTION[c]}
              </button>
            ))}
          </div>
          {choice === "reject" ? (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium tracking-[0.04em] text-muted uppercase">Reason</span>
              <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className="h-9 w-full rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm">
                {reasons.map((r) => (
                  <option key={r.k} value={r.k}>
                    {r.l}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block">
            <span className="mb-1.5 flex justify-between text-xs font-medium tracking-[0.04em] text-muted uppercase">
              <span>Your reasoning</span>
              <span>Required</span>
            </span>
            <textarea
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              rows={5}
              placeholder="What in the evidence decides this for you. This stays on the record."
              className="w-full resize-y rounded-[4px] border border-line-strong p-3 text-[15px] leading-[23px] text-heading outline-none focus:border-brand"
            />
            <span className={cx("mt-1 block text-xs", len >= DECISION_REASON_MIN ? "text-muted" : "text-warn-ink")}>
              {len >= DECISION_REASON_MIN ? `${len} characters` : `At least ${DECISION_REASON_MIN} characters — ${DECISION_REASON_MIN - len} to go`}
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-heading">
            <input
              type="checkbox"
              checked={disagreeShown}
              disabled={!rec}
              onChange={(e) => {
                setTouchedDisagree(true);
                setDisagree(e.target.checked);
              }}
              className="mt-px h-[18px] w-[18px] accent-[var(--color-brand)]"
            />
            <span>
              I disagree with the AI recommendation
              <span className="block text-xs text-muted">
                {!rec ? "There is no recommendation to agree or disagree with." : differs ? `You chose ${ACTION[choice!]}; the AI recommended ${ACTION[rec.action]}. Your disagreement is how the system learns.` : "Tick this if your reasons differ from the AI’s, even where the outcome is the same."}
              </span>
            </span>
          </label>
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <div className="flex justify-center pt-1.5">
            <Btn kind={choice === "reject" ? "danger" : "primary"} disabled={!ready} onClick={record} title={!choice ? "Choose Advance, Hold or Reject" : len < DECISION_REASON_MIN ? "Write your reasoning first" : undefined} className="h-11 px-8 text-[15px]">
              {busy ? "Recording…" : "Record decision"}
            </Btn>
          </div>
        </section>
      ) : atGate ? (
        <div className="rounded-[6px] border border-line bg-canvas p-6 text-center text-sm text-body">{lockLine}</div>
      ) : null}

      {!atGate ? (
        last ? (
          <section className="flex flex-col gap-2.5 rounded-[6px] border border-line bg-surface px-7 py-6">
            <div className="text-xs font-semibold tracking-[0.06em] text-heading uppercase">Decision recorded</div>
            <div className="text-lg font-semibold text-heading">
              {ACTION[last.decision as Choice] ?? last.decision} — {name}
            </div>
            <div className="text-sm leading-[22px] text-body">“{last.reasoning}”</div>
            <div className="text-[13px] text-muted">
              {last.by} · {last.role} · {fdt(last.at)}
              {last.agreed === false ? " · disagreed with the AI" : last.agreed ? " · agreed with the AI" : ""}
            </div>
            <div className="mt-1.5 flex gap-2">
              <BtnLink href={`/hire/c/${applicationId}`} size="sm">
                Open {name.split(" ")[0]}’s record
              </BtnLink>
              <BtnLink href="/hire/decisions" size="sm">
                Back to decisions
              </BtnLink>
            </div>
            <div className="text-[13px] text-muted">{whereNow}</div>
          </section>
        ) : (
          <div className="rounded-[6px] border border-line bg-canvas p-6 text-center text-sm text-body">
            {whereNow}{" "}
            <Link href={`/hire/c/${applicationId}`}>Open the record</Link>
          </div>
        )
      ) : null}
    </>
  );
}
