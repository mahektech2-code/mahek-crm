"use client";

import { useState } from "react";
import { cx } from "@/components/ui/primitives";
import { correctAttemptAction, signOffRetrainingAction } from "@/lib/hire/actions/training";
import type { RetakeRow } from "@/lib/training/service";
import { cleanDecimal } from "@/lib/format";
import { Btn, Callout, Label, Locked, Panel, Pill, fd, fdt } from "../../_ui/kit";
import { areaCls, inputCls, useRun } from "../_shared";

type Detail = {
  attemptId: string;
  learner: string;
  moduleTitle: string;
  moduleVersion: number;
  startedAt: string;
  submittedAt: string | null;
  scorePercent: number;
  passMark: number;
  correct: number;
  total: number;
  minStudyMinutes: number;
  studiedSinceSeconds: number;
  questions: { n: number; text: string; chosen: string | null; correctText: string; correct: boolean; tags: string[] }[];
  corrections: { id: string; scorePercent: number; result: string; reason: string; at: string }[];
};

export function RetakePanel({
  row,
  detail: d,
  canSignOff,
  signOffWhy,
  canCorrect,
  correctWhy,
  signOffMin,
  correctionMin,
}: {
  row: RetakeRow;
  detail: Detail;
  canSignOff: boolean;
  signOffWhy: string;
  canCorrect: boolean;
  correctWhy: string;
  signOffMin: number;
  correctionMin: number;
}) {
  const { pending, run } = useRun();
  const [note, setNote] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [score, setScore] = useState("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const missed = new Map<string, number>();
  for (const q of d.questions) if (!q.correct) for (const t of q.tags) missed.set(t, (missed.get(t) ?? 0) + 1);
  const studiedMin = Math.floor(d.studiedSinceSeconds / 60);
  const tone = row.state === "retraining_required" ? "danger" : row.state === "retake_open" ? "info" : "success";
  return (
    <Panel
      title={`${d.learner} · ${d.moduleTitle}`}
      sub={`Attempt ${row.attemptNo} · ${fdt(d.startedAt)}${d.submittedAt ? `–${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d.submittedAt))}` : ""} · module v${d.moduleVersion}`}
      actions={<Pill tone={tone}>{row.state === "retraining_required" ? "Retraining required" : row.state === "retake_open" ? "Retake open" : "Passed on retake"}</Pill>}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-baseline gap-2.5">
          <span className="text-[32px] leading-9 font-semibold text-danger tabular-nums">{d.scorePercent}%</span>
          <span className="text-[13px] text-muted">
            {d.correct} of {d.total} right · pass mark {d.passMark}%
          </span>
        </div>
        <div>
          <Label className="mb-2">Answers</Label>
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(13, d.questions.length)}, minmax(0, 1fr))` }}>
            {d.questions.map((q) => (
              <button
                key={q.n}
                type="button"
                title={q.text}
                onClick={() => setOpen(open === q.n ? null : q.n)}
                className={cx("flex h-6 cursor-pointer items-center justify-center rounded-[3px] border-0 text-[11px] font-semibold", q.correct ? "bg-success-soft text-success" : "bg-danger-soft text-danger", open === q.n ? "ring-2 ring-brand" : "")}
              >
                {q.n}
              </button>
            ))}
          </div>
          {open != null ? (
            (() => {
              const q = d.questions.find((x) => x.n === open)!;
              return (
                <div className="mt-2 rounded-[4px] bg-page px-3 py-2 text-[13px] leading-[19px]">
                  <div className="text-heading">{q.text}</div>
                  <div className={q.correct ? "text-success" : "text-danger"}>Chose: {q.chosen ?? "no answer"}</div>
                  {!q.correct ? <div className="text-success">Right: {q.correctText}</div> : null}
                </div>
              );
            })()
          ) : null}
          <div className="mt-1.5 text-xs text-muted">{missed.size ? `Missed: ${[...missed.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`).join(" · ")}` : "Untagged questions missed."}</div>
        </div>

        {row.state === "retraining_required" ? (
          canSignOff ? (
            <>
              <label>
                <Label className="mb-1.5">What was reviewed · kept on the record</Label>
                <textarea className={cx(areaCls, "h-[72px] resize-y")} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Went through the price book and pack sizes with them on a call…" />
              </label>
              <label className="flex items-start gap-2 text-sm text-heading">
                <input type="checkbox" className="mt-[3px]" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
                <span>
                  I reviewed the module with {d.learner.split(" ")[0]}. They have studied it for {studiedMin} min since the fail
                  {d.minStudyMinutes ? ` — the retake opens after ${d.minStudyMinutes}` : ""}.
                </span>
              </label>
              <div className="flex gap-2">
                <Btn
                  kind="primary"
                  disabled={pending || !reviewed || note.trim().length < signOffMin}
                  title={!reviewed ? "Tick that you reviewed it with them" : note.trim().length < signOffMin ? `Say what was reviewed — at least ${signOffMin} characters` : undefined}
                  onClick={() => run(() => signOffRetrainingAction(row.enrollmentId, row.moduleKey, note))}
                >
                  Sign off — open the retake
                </Btn>
              </div>
            </>
          ) : (
            <Locked why={signOffWhy}>Sign off the review</Locked>
          )
        ) : row.signedOffWhy ? (
          <Callout tone="neutral">Signed off: “{row.signedOffWhy}”</Callout>
        ) : null}

        <Callout tone="neutral">The retake is a new attempt on the module as published now. This attempt stays exactly as it is.</Callout>

        {d.corrections.length ? (
          <div>
            <Label className="mb-1.5">Corrections</Label>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
              {d.corrections.map((c) => (
                <li key={c.id}>
                  <b className="font-medium text-heading">{c.scorePercent}% · {c.result}</b> · {fd(c.at)} · “{c.reason}”
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {canCorrect ? (
          fixing ? (
            <div className="flex flex-col gap-2 rounded-[4px] border border-line p-3">
              <Label>Correct this attempt · HR Head</Label>
              <div className="flex items-center gap-2">
                <input className={cx(inputCls, "h-8 w-20 text-right")} inputMode="decimal" value={score} onChange={(e) => setScore(cleanDecimal(e.target.value, 1))} placeholder="Score" aria-label="Corrected score" />
                <span className="text-[13px] text-muted">% · pass mark {d.passMark}%</span>
              </div>
              <textarea className={cx(areaCls, "h-16")} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`Why — at least ${correctionMin} characters, kept on the record`} aria-label="Reason" />
              <div className="flex gap-2">
                <Btn
                  size="sm"
                  kind="primary"
                  disabled={pending || !score || reason.trim().length < correctionMin}
                  title={!score ? "Give the corrected score" : reason.trim().length < correctionMin ? `A reason of at least ${correctionMin} characters` : undefined}
                  onClick={() => run(() => correctAttemptAction(d.attemptId, { scorePercent: Number(score), reason }), () => setFixing(false))}
                >
                  Record correction
                </Btn>
                <Btn size="sm" onClick={() => setFixing(false)}>
                  Cancel
                </Btn>
              </div>
            </div>
          ) : (
            <div>
              <Btn size="sm" onClick={() => setFixing(true)}>
                Correct this attempt
              </Btn>
            </div>
          )
        ) : (
          <div>
            <Locked size="sm" why={`${correctWhy} A correction is a separate, audited record.`}>
              Correct this attempt
            </Locked>
          </div>
        )}
      </div>
    </Panel>
  );
}
