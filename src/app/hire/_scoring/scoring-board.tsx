"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import type { Question } from "@/lib/hire/blueprint-types";
import { graceProblem, scoreCalc, scoreFixed, stageResult, GRACE_REASON_MIN } from "@/lib/hire/engines/scoring";
import { aiScoreQuestion, completeStage, confirmAnswer, moveToNextStage, reopenStage, type ConfirmInput } from "@/lib/hire/actions/scoring";
import type { AnswerView, ScoringView } from "@/lib/hire/services/scoring";
import { AiCard, Btn, BtnLink, Callout, EvidenceList, fdt, fmtScore, Label, Locked, Pill, Quote } from "../_ui/kit";

/* ---------------------------------------------------------------------------
 * The scoring review (design §7.4): one card per question in order, a running
 * total of CONFIRMED scores, grace beside it — never in it — and the outcome
 * against the one threshold. Nothing is pre-selected; every score lands only
 * when a person presses something.
 * ------------------------------------------------------------------------- */

type Run = <T extends { ok: boolean; message?: string; error?: string }>(p: Promise<T>) => Promise<T>;

const inputCls = "h-9 w-full rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm text-heading outline-none focus:border-brand";
const areaCls = "w-full rounded-[4px] border border-line-strong bg-surface px-2.5 py-2 text-sm leading-5 text-heading outline-none focus:border-brand";

export function ScoringBoard({
  view,
  seek,
  stacked = false,
}: {
  view: ScoringView;
  /** Voice review: the moment each question starts, and how to play from it. */
  seek?: { at: Record<string, { ms: number; label: string }>; play: (ms: number) => void };
  /** Questions above the totals, for a half-width column. */
  stacked?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const closed = view.exec.status === "completed" || view.exec.superseded;
  const run: Run = async (p) => {
    const r = await toast.run(p);
    start(() => router.refresh());
    return r;
  };

  return (
    <div className={stacked ? "flex flex-col gap-4" : "grid grid-cols-[minmax(0,1fr)_320px] items-start gap-6"}>
      <div className="flex max-w-[820px] flex-col gap-4">
        <div className="rounded-[4px] bg-canvas px-3.5 py-2.5 text-[13px] text-body">
          {view.bundle.masked.length
            ? `Scored blind — ${view.bundle.masked.map((m) => m.replace("_", " ")).join(", ")} masked, per ${view.bundle.roleTitle} v${view.bundle.version}. `
            : ""}
          Earlier stages’ scores are not shown here, so they cannot anchor this one.
        </div>
        {!view.ai.on && !closed ? (
          <Callout tone="warn">
            {view.ai.reason} Score each question yourself — a reason is kept with every score, and the stage is flagged for AI review when the service returns.
          </Callout>
        ) : null}
        {view.questions.map((q, i) => {
          const a = view.answers[q.key];
          const s = seek?.at[q.key];
          return (
            <div key={`${q.key}:${a.id ?? "none"}`} className="flex flex-col gap-1.5">
              {s && seek ? (
                <button onClick={() => seek.play(s.ms)} className="h-[26px] cursor-pointer self-start rounded-[13px] border border-line bg-surface px-2.5 text-xs text-body">
                  ▶ Play from {s.label}
                </button>
              ) : null}
              <QuestionCard q={q} a={a} n={i + 1} view={view} closed={closed || !view.canScore} run={run} busy={pending} />
            </div>
          );
        })}
      </div>
      <Sidebar key={`${view.exec.id}:${view.exec.status}`} view={view} run={run} busy={pending} stacked={stacked} />
    </div>
  );
}

function QuestionCard(props: { q: Question; a: AnswerView; n: number; view: ScoringView; closed: boolean; run: Run; busy: boolean }) {
  const { q } = props;
  if (q.mode === "fixed_choice") return <FixedCard {...props} />;
  if (q.mode === "calculated") return <CalcCard {...props} />;
  return <RubricCard {...props} />;
}

function QHead({ q, n, stageName }: { q: Question; n: number; stageName: string }) {
  return (
    <div className="mb-3">
      <Label>
        {stageName} · Q{n} · {q.mode === "ai_rubric" ? "rubric" : q.mode === "fixed_choice" ? "fixed choice" : q.mode === "calculated" ? "calculated" : "manual"} · {q.maxPoints} pts
      </Label>
      <div className="mt-1 text-[15px] leading-5 font-semibold text-heading">{q.text}</div>
    </div>
  );
}

function Confirmed({ a, max }: { a: AnswerView; max: number }) {
  if (!a.confirmed) return null;
  const how =
    a.humanAction === "accepted"
      ? "AI score accepted"
      : a.humanAction === "adjusted"
        ? `Adjusted from ${fmtScore(a.aiScore ?? 0)}`
        : a.humanAction === "scored_myself" || a.humanAction === "manual"
          ? "Scored by hand"
          : a.humanAction === "calculated"
            ? "Calculated"
            : "Selected";
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-body">
      <Pill tone="success">Confirmed {fmtScore(a.score ?? 0)} / {max}</Pill>
      <span>
        {how}
        {a.confirmedByName ? ` by ${a.confirmedByName}` : ""}
        {a.confirmedAt ? ` · ${fdt(a.confirmedAt)}` : ""}
      </span>
      {a.overrideReason ? <span className="text-muted">· “{a.overrideReason}”</span> : null}
    </div>
  );
}

/** Number + reason, for Adjust and Score myself. */
function ScoreForm({ max, label, initial, onSubmit, onCancel, busy }: { max: number; label: string; initial?: number | null; onSubmit: (score: number, reason: string) => void; onCancel: () => void; busy: boolean }) {
  const [score, setScore] = useState(initial != null ? String(initial) : "");
  const [reason, setReason] = useState("");
  const n = Number(score);
  const scoreBad = score === "" || !Number.isFinite(n) || n < 0 || n > max;
  const reasonBad = reason.trim().length < 10;
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-[4px] border border-line bg-canvas p-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-body">{label}</span>
        <input type="number" min={0} max={max} step={0.5} value={score} onChange={(e) => setScore(e.target.value)} className={cx(inputCls, "w-24")} aria-label="Score" />
        <span className="text-[13px] text-muted">of {max}</span>
      </div>
      <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why — kept beside the score, at least 10 characters" className={areaCls} />
      <div className="flex gap-2">
        <Btn kind="primary" size="sm" disabled={scoreBad || reasonBad || busy} title={scoreBad ? `A score between 0 and ${max}` : reasonBad ? "A reason is required" : undefined} onClick={() => onSubmit(n, reason)}>
          Confirm {scoreBad ? "" : fmtScore(n)}
        </Btn>
        <Btn kind="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

function RubricCard({ q, a, n, view, closed, run, busy }: { q: Question; a: AnswerView; n: number; view: ScoringView; closed: boolean; run: Run; busy: boolean }) {
  const [mode, setMode] = useState<"none" | "adjust" | "manual" | "answer" | "change">("none");
  const [text, setText] = useState(a.responseText ?? "");
  const confirm = (input: ConfirmInput) => void run(confirmAnswer(view.exec.id, q.key, input)).then((r) => r.ok && setMode("none"));
  const aiScore = () => void run(aiScoreQuestion(view.exec.id, q.key, text));
  const hasAi = a.aiScore != null;
  const low = a.aiConfidenceWord === "Low";
  const editable = !closed && (!a.confirmed || mode === "change");

  const rubric = (
    <details className="mt-3 text-[13px] text-muted">
      <summary className="cursor-pointer">Rubric</summary>
      <ul className="mt-2 mb-0 flex list-none flex-col gap-1 p-0">
        {q.rubric.map((r) => (
          <li key={r.key}>
            <span className="tabular-nums font-medium text-body">{r.points ?? "—"}</span> · {r.descriptor}
          </li>
        ))}
      </ul>
    </details>
  );

  /* A confirmed score: show it, with the AI's assessment it came from. */
  if (a.confirmed && mode !== "change") {
    return (
      <div className="rounded-[6px] border border-line bg-surface p-5">
        <QHead q={q} n={n} stageName={view.stage.name} />
        {hasAi ? (
          <AiCard confidence={a.aiConfidenceWord} score={a.aiScore} max={q.maxPoints} reasoning={a.aiReasoning}>
            <EvidenceList spans={a.evidence} />
          </AiCard>
        ) : a.responseText ? (
          <Quote>{a.responseText}</Quote>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Confirmed a={a} max={q.maxPoints} />
          {!closed ? (
            <Btn kind="ghost" size="sm" onClick={() => setMode("change")}>
              Change
            </Btn>
          ) : null}
        </div>
      </div>
    );
  }

  /* Insufficient — "Not scored", never 0. */
  if (a.insufficient) {
    return (
      <div className="rounded-[6px] border border-line bg-surface p-5">
        <QHead q={q} n={n} stageName={view.stage.name} />
        {a.responseText ? <Quote className="mb-3">{a.responseText}</Quote> : null}
        <AiCard
          insufficient
          reasoning="The response was too brief to assess against this rubric. Consider probing — a short answer is not a low score."
          footer={
            editable ? (
              <>
                <Btn size="sm" onClick={() => setMode("answer")}>
                  Add the answer to the probe
                </Btn>
                <Btn size="sm" onClick={() => setMode("manual")}>
                  Score manually
                </Btn>
              </>
            ) : null
          }
        >
          {a.probe ? (
            <div className="mt-3">
              <Label>Suggested probe</Label>
              <div className="mt-1 text-sm text-heading">“{a.probe}”</div>
            </div>
          ) : null}
        </AiCard>
        {mode === "answer" ? (
          <div className="mt-3 flex flex-col gap-2">
            <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} className={areaCls} placeholder="The candidate’s words, including what they said to the probe" />
            <div className="flex gap-2">
              <Btn kind="primary" size="sm" disabled={busy || !text.trim() || !view.ai.on} title={!view.ai.on ? (view.ai.reason ?? undefined) : undefined} onClick={aiScore}>
                Score with AI
              </Btn>
              <Btn kind="ghost" size="sm" onClick={() => setMode("none")}>
                Cancel
              </Btn>
            </div>
          </div>
        ) : null}
        {mode === "manual" ? <ScoreForm max={q.maxPoints} label="Your score" busy={busy} onCancel={() => setMode("none")} onSubmit={(s, r) => confirm({ kind: "manual", score: s, reason: r })} /> : null}
        {rubric}
      </div>
    );
  }

  /* An AI score waiting for a person. */
  if (hasAi) {
    return (
      <div className="rounded-[6px] border border-line bg-surface p-5">
        <QHead q={q} n={n} stageName={view.stage.name} />
        <AiCard
          confidence={a.aiConfidenceWord}
          score={a.aiScore}
          max={q.maxPoints}
          reasoning={a.aiReasoning}
          footer={
            !editable ? (
              closed ? <span className="text-[13px] text-muted">Not confirmed before the stage closed.</span> : <Locked size="sm" why="Needs an interviewer on this candidate.">Accept</Locked>
            ) : (
              <>
                <Btn kind={low ? "secondary" : "primary"} size="sm" disabled={busy} onClick={() => confirm({ kind: "accept" })} title={low ? "Low confidence — scoring it yourself is recommended" : undefined}>
                  Accept {fmtScore(a.aiScore ?? 0)}
                </Btn>
                <Btn size="sm" onClick={() => setMode(mode === "adjust" ? "none" : "adjust")}>
                  Adjust ▾
                </Btn>
                <Btn kind={low ? "primary" : "secondary"} size="sm" onClick={() => setMode(mode === "manual" ? "none" : "manual")}>
                  Score myself
                </Btn>
                {a.confirmed ? (
                  <Btn kind="ghost" size="sm" onClick={() => setMode("none")}>
                    Keep {fmtScore(a.score ?? 0)}
                  </Btn>
                ) : null}
              </>
            )
          }
        >
          {a.aiFlags.filter((f) => f !== "insufficient_response").length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {a.aiFlags
                .filter((f) => f !== "insufficient_response")
                .map((f) => (
                  <Pill key={f} tone="warn">
                    {f.replace(/_/g, " ")}
                  </Pill>
                ))}
            </div>
          ) : null}
          <EvidenceList spans={a.evidence} />
          {a.probe ? <div className="mt-3 text-[13px] text-muted">Probe if unsure: “{a.probe}”</div> : null}
        </AiCard>
        {mode === "adjust" ? <ScoreForm max={q.maxPoints} label="Adjusted score" initial={a.aiScore} busy={busy} onCancel={() => setMode("none")} onSubmit={(s, r) => confirm({ kind: "adjust", score: s, reason: r })} /> : null}
        {mode === "manual" ? <ScoreForm max={q.maxPoints} label="Your score" busy={busy} onCancel={() => setMode("none")} onSubmit={(s, r) => confirm({ kind: "manual", score: s, reason: r })} /> : null}
        {rubric}
      </div>
    );
  }

  /* No AI assessment yet — the answer, if there is one, and the two ways forward. */
  return (
    <div className="rounded-[6px] border border-line bg-surface p-5">
      <QHead q={q} n={n} stageName={view.stage.name} />
      {editable ? (
        <>
          <textarea rows={a.responseText ? 3 : 4} value={text} onChange={(e) => setText(e.target.value)} className={cx(areaCls, "font-[family-name:var(--font-evidence)] text-base leading-[26px]")} placeholder="What the candidate said — typed or pasted from the transcript" />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {view.ai.on ? (
              <Btn kind="primary" size="sm" disabled={busy || !text.trim()} onClick={aiScore} title={!text.trim() ? "Add the candidate’s answer first" : undefined}>
                ◈ Score with AI
              </Btn>
            ) : (
              <span className="text-[13px] text-warn-ink">AI unavailable — score by hand.</span>
            )}
            <Btn size="sm" onClick={() => setMode(mode === "manual" ? "none" : "manual")}>
              Score myself
            </Btn>
            {a.confirmed ? (
              <Btn kind="ghost" size="sm" onClick={() => setMode("none")}>
                Keep {fmtScore(a.score ?? 0)}
              </Btn>
            ) : null}
          </div>
          {mode === "manual" ? <ScoreForm max={q.maxPoints} label="Your score" busy={busy} onCancel={() => setMode("none")} onSubmit={(s, r) => confirm({ kind: "manual", score: s, reason: r })} /> : null}
        </>
      ) : a.responseText ? (
        <Quote>{a.responseText}</Quote>
      ) : (
        <div className="text-[13px] text-muted">Not answered.</div>
      )}
      {q.idealAnswer ? <div className="mt-3 text-[13px] text-muted">A strong answer: {q.idealAnswer}</div> : null}
      {rubric}
    </div>
  );
}

function FixedCard({ q, a, n, view, closed, run, busy }: { q: Question; a: AnswerView; n: number; view: ScoringView; closed: boolean; run: Run; busy: boolean }) {
  const [sel, setSel] = useState<string[]>(a.selected);
  const [editing, setEditing] = useState(!a.confirmed);
  const r = sel.length ? scoreFixed(q, sel) : null;
  const toggle = (k: string) => setSel((s) => (q.cumulative ? (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]) : [k]));
  const can = !closed && editing;
  return (
    <div className="flex items-start gap-4 rounded-[6px] border border-line bg-surface px-5 py-4">
      <div className="min-w-0 flex-1">
        <QHead q={q} n={n} stageName={view.stage.name} />
        <div className="flex flex-col gap-1.5">
          {(q.options ?? []).map((o) => {
            const on = sel.includes(o.key);
            return (
              <label key={o.key} className={cx("flex items-center gap-2.5 rounded-[4px] border px-3 py-2 text-sm", on ? "border-brand bg-brand-soft text-heading" : "border-line bg-surface text-body", can ? "cursor-pointer" : "cursor-default")}>
                <input type={q.cumulative ? "checkbox" : "radio"} name={`${view.exec.id}-${q.key}`} checked={on} disabled={!can} onChange={() => toggle(o.key)} />
                <span className="flex-1">{o.label}</span>
                <span className="tabular-nums text-muted">{o.points == null ? "no score defined" : o.points > 0 ? `+${o.points}` : o.points < 0 ? `−${Math.abs(o.points)}` : "0"}</span>
              </label>
            );
          })}
        </div>
        {q.note ? <div className="mt-2 text-xs text-muted">{q.note}</div> : null}
        {r ? <div className={cx("mt-2 text-[13px]", r.points == null ? "text-danger" : "text-body")}>{r.why}</div> : null}
        <div className="mt-3 flex items-center gap-2">
          {a.confirmed && !editing ? (
            <>
              <Confirmed a={a} max={q.maxPoints} />
              {!closed ? (
                <Btn kind="ghost" size="sm" onClick={() => setEditing(true)}>
                  Change
                </Btn>
              ) : null}
            </>
          ) : can ? (
            <Btn kind="primary" size="sm" disabled={busy || !r || r.points == null} onClick={() => void run(confirmAnswer(view.exec.id, q.key, { kind: "fixed", selected: sel })).then((x) => x.ok && setEditing(false))}>
              Record {r && r.points != null ? fmtScore(r.points) : ""}
            </Btn>
          ) : null}
        </div>
      </div>
      <div className="flex-none text-right">
        <div className="text-2xl leading-[30px] font-semibold tabular-nums text-heading">{a.confirmed ? fmtScore(a.score ?? 0) : r?.points != null ? fmtScore(r.points) : "—"}</div>
        <div className="text-[11px] text-muted">{q.cumulative ? "cumulative" : "fixed choice"}</div>
      </div>
    </div>
  );
}

function CalcCard({ q, a, n, view, closed, run, busy }: { q: Question; a: AnswerView; n: number; view: ScoringView; closed: boolean; run: Run; busy: boolean }) {
  const rule = q.calc!;
  const inputsDef = rule.kind === "formula" ? rule.inputs : [rule.input];
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(inputsDef.map((i) => [i.key, a.calcInputs[i.key] != null ? String(a.calcInputs[i.key]) : ""])));
  const [editing, setEditing] = useState(!a.confirmed);
  const nums = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v === "" ? NaN : Number(v)]));
  const filled = inputsDef.every((i) => Number.isFinite(nums[i.key]));
  const r = filled ? scoreCalc(rule, nums) : null;
  const can = !closed && editing;
  return (
    <div className="flex items-start gap-4 rounded-[6px] border border-line bg-surface px-5 py-4">
      <div className="min-w-0 flex-1">
        <QHead q={q} n={n} stageName={view.stage.name} />
        <div className="flex flex-wrap gap-3">
          {inputsDef.map((i) => (
            <label key={i.key} className="flex flex-col gap-1 text-[13px] text-body">
              {i.label}
              {i.unit ? <span className="text-muted"> ({i.unit})</span> : null}
              <input type="number" value={vals[i.key]} disabled={!can} onChange={(e) => setVals((v) => ({ ...v, [i.key]: e.target.value }))} className={cx(inputCls, "w-36")} />
            </label>
          ))}
        </div>
        {rule.kind === "formula" ? <div className="mt-2 font-mono text-xs text-muted">{rule.expression}</div> : null}
        {r ? <div className={cx("mt-2 text-[13px]", r.points == null ? "text-danger" : "text-body")}>{r.why}</div> : null}
        {q.note ? <div className="mt-2 text-xs text-muted">{q.note}</div> : null}
        {rule.anomaly ? <div className="mt-1 text-xs text-warn-ink">{rule.anomaly}</div> : null}
        <div className="mt-3 flex items-center gap-2">
          {a.confirmed && !editing ? (
            <>
              <Confirmed a={a} max={q.maxPoints} />
              {!closed ? (
                <Btn kind="ghost" size="sm" onClick={() => setEditing(true)}>
                  Change
                </Btn>
              ) : null}
            </>
          ) : can ? (
            <Btn kind="primary" size="sm" disabled={busy || !r || r.points == null} onClick={() => void run(confirmAnswer(view.exec.id, q.key, { kind: "calc", inputs: nums })).then((x) => x.ok && setEditing(false))}>
              Record {r && r.points != null ? fmtScore(r.points) : ""}
            </Btn>
          ) : null}
        </div>
      </div>
      <div className="flex-none text-right">
        <div className="text-2xl leading-[30px] font-semibold tabular-nums text-heading">{a.confirmed ? fmtScore(a.score ?? 0) : r?.points != null ? fmtScore(r.points) : "—"}</div>
        <div className="text-[11px] text-muted">calculated</div>
      </div>
    </div>
  );
}

function Sidebar({ view, run, busy, stacked }: { view: ScoringView; run: Run; busy: boolean; stacked?: boolean }) {
  const router = useRouter();
  const done = view.exec.status === "completed";
  const [grace, setGrace] = useState(done ? view.exec.grace : view.exec.grace);
  const [why, setWhy] = useState(view.exec.graceReason ?? "");
  const [reopen, setReopen] = useState(false);
  const [reopenWhy, setReopenWhy] = useState("");
  const st = view.stage;
  const range = Math.min(10, st.graceRange);
  const points = Object.fromEntries(view.questions.map((q) => [q.key, view.answers[q.key].confirmed ? view.answers[q.key].score : null]));
  const r = stageResult(st, points, done ? view.exec.grace : grace);
  const pendingN = r.missing.length;
  const gProblem = done ? null : graceProblem(st, grace, why);
  const pct = Math.max(0, Math.min(100, r.normalised));
  const outcome = done ? view.exec.outcome : r.outcome;
  const final = done ? (view.exec.finalScore ?? r.final) : r.final;
  const canSubmit = !done && view.canScore && pendingN === 0 && !gProblem && (grace === 0 || view.canGrace);
  const submitWhy = done ? undefined : !view.canScore ? "Needs an interviewer on this candidate." : pendingN ? `${pendingN} question${pendingN === 1 ? "" : "s"} still need a confirmed score.` : gProblem ?? undefined;

  return (
    <div className={stacked ? "flex flex-col gap-4" : "sticky top-4 flex flex-col gap-4"}>
      <div className="rounded-[6px] border border-line bg-surface p-5">
        <Label>Rubric total · confirmed only</Label>
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className="text-[32px] leading-9 font-semibold tabular-nums text-heading">{fmtScore(r.earned)}</span>
          <span className="text-[15px] text-muted">of {r.max}</span>
        </div>
        <div className="mt-1 text-[13px] text-body">Normalised {fmtScore(r.normalised)} on the 0–100 scale (earned ÷ max × 100)</div>
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-[3px] bg-divider">
          <div className="h-full bg-heading" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 text-xs text-muted">{pendingN ? `${pendingN} of ${view.questions.length} questions still need a person.` : "Every question has a confirmed score."}</div>
      </div>

      <div className="flex flex-col gap-2.5 rounded-[6px] border border-line bg-surface p-5">
        <div className="text-[15px] font-semibold text-heading">Grace adjustment</div>
        <div className="text-xs text-muted">Shown separately from the rubric score, never merged into it. Range ±{range}.</div>
        {done ? (
          <div className="text-sm text-body">
            {view.exec.grace ? `${view.exec.grace > 0 ? "+" : ""}${view.exec.grace} · “${view.exec.graceReason}”` : "None applied."}
          </div>
        ) : !view.canGrace ? (
          <Locked size="sm" why="Needs a role that may apply grace.">Grace</Locked>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <button disabled={grace <= -range} onClick={() => setGrace((g) => Math.max(-range, g - 1))} className="h-9 w-9 cursor-pointer rounded-[4px] border border-line-strong bg-surface text-lg disabled:cursor-not-allowed disabled:text-faint" aria-label="Less grace">
                −
              </button>
              <span className="flex-1 text-center text-[22px] font-semibold tabular-nums text-heading">{grace > 0 ? `+${grace}` : grace}</span>
              <button disabled={grace >= range} onClick={() => setGrace((g) => Math.min(range, g + 1))} className="h-9 w-9 cursor-pointer rounded-[4px] border border-line-strong bg-surface text-lg disabled:cursor-not-allowed disabled:text-faint" aria-label="More grace">
                +
              </button>
            </div>
            {grace !== 0 ? (
              <div>
                <textarea rows={3} value={why} onChange={(e) => setWhy(e.target.value)} placeholder={`Why the rubric does not capture this candidate fairly — at least ${GRACE_REASON_MIN} characters`} className={cx(areaCls, why.trim().length < GRACE_REASON_MIN ? "border-danger" : "")} />
                <div className={cx("mt-1 text-xs", why.trim().length < GRACE_REASON_MIN ? "text-danger" : "text-muted")}>
                  {why.trim().length < GRACE_REASON_MIN ? `Required — ${GRACE_REASON_MIN - why.trim().length} more characters. It is shown on the record and in calibration.` : "Recorded with your name, on the record and in calibration."}
                </div>
              </div>
            ) : null}
          </>
        )}
        <div className="text-[13px] text-body">
          {grace === 0 && !done ? `No grace. The stage score is ${fmtScore(r.normalised)}.` : `The stage score becomes ${fmtScore(r.normalised)} ${(done ? view.exec.grace : grace) >= 0 ? "+" : "−"} ${Math.abs(done ? view.exec.grace : grace)} = ${fmtScore(final)}.`}
        </div>
        {r.graceFlipped && pendingN === 0 ? <div className="text-xs font-medium text-warn-ink">Grace changes the outcome from {r.normalised >= st.passThreshold ? "pass" : "fail"} to {r.outcome}. That is flagged on the record and in calibration.</div> : null}
      </div>

      <div className="flex flex-col gap-2.5 rounded-[6px] border border-line bg-surface p-5">
        <Label>Stage outcome</Label>
        <div className={cx("text-[22px] font-semibold", outcome === "pass" ? "text-success" : outcome === "fail" ? "text-danger" : "text-muted")}>
          {outcome === "pass" ? `Pass · ${fmtScore(final)}` : outcome === "fail" ? `Not passed · ${fmtScore(final)}` : "Pending"}
        </div>
        <div className="text-xs text-muted">Pass mark {st.passThreshold}. One threshold governs status, the candidate’s message and progression.{st.autoRejectFloor != null ? ` Below ${st.autoRejectFloor}, a rejection is proposed for a person to confirm.` : ""}</div>
        {!done ? (
          <Btn kind="primary" disabled={!canSubmit || busy} title={submitWhy} onClick={() => void run(completeStage(view.exec.id, grace, why))}>
            Complete {st.name}
          </Btn>
        ) : view.exec.superseded ? (
          <div className="text-[13px] text-muted">This result was superseded by a correction. It stays here as history.</div>
        ) : (
          <>
            <div className="text-[13px] text-body">Completed {view.exec.completedAt ? fdt(view.exec.completedAt) : ""}{view.exec.conductedByName ? ` · ${view.exec.conductedByName}` : ""}{view.exec.aiReviewPending ? " · scored by hand, flagged for AI review" : ""}</div>
            {outcome === "pass" && view.nextStage && view.bundle.currentStageKey === st.key && view.bundle.appStatus === "in_progress" ? (
              <Btn kind="primary" disabled={busy} onClick={() => void run(moveToNextStage(view.exec.id))}>
                Move to {view.nextStage.name}
              </Btn>
            ) : null}
            {outcome === "fail" ? (
              <div className="text-[13px] text-body">
                {view.openProposal ? "A rejection is proposed and waits for a named person in " : "Decide what happens next in "}
                <Link href="/hire/decisions">Decisions</Link>. Nothing is rejected by the system alone.
              </div>
            ) : null}
            {view.canScore && view.bundle.currentStageKey === st.key ? (
              reopen ? (
                <div className="flex flex-col gap-2">
                  <textarea rows={2} value={reopenWhy} onChange={(e) => setReopenWhy(e.target.value)} placeholder="Why this stage needs correcting — at least 20 characters" className={areaCls} />
                  <div className="flex gap-2">
                    <Btn
                      size="sm"
                      disabled={busy || reopenWhy.trim().length < 20}
                      onClick={() =>
                        void run(reopenStage(view.exec.id, reopenWhy)).then((x) => {
                          if (x.ok && x.data) router.push(`/hire/scoring/${x.data.execId}`);
                        })
                      }
                    >
                      Reopen as a correction
                    </Btn>
                    <Btn kind="ghost" size="sm" onClick={() => setReopen(false)}>
                      Cancel
                    </Btn>
                  </div>
                </div>
              ) : (
                <Btn kind="ghost" size="sm" onClick={() => setReopen(true)}>
                  Correct this stage
                </Btn>
              )
            ) : null}
          </>
        )}
      </div>
      <BtnLink href={`/hire/c/${view.bundle.applicationId}`} kind="ghost" size="sm">
        Open the candidate’s record
      </BtnLink>
    </div>
  );
}
