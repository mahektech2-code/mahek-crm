"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { answerAction, questionAction, submitAttemptAction } from "@/lib/actions/learn";
import type { AttemptResult, QuestionView } from "@/lib/training/service";
import { cx } from "@/components/ui/primitives";
import { learnBtn } from "../../ui";
import { ResultView } from "./result";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * ONE QUESTION AT A TIME, served by the server. The browser never holds a
 * correct answer: it sends the option chosen and is told nothing back unless
 * the module shows feedback after each answer. The deadline is the server's
 * too — the countdown here is only a display of it, and a submit after it
 * is closed on the answers already saved.
 */
export function Player({ first, title, enrollmentId }: { first: QuestionView; title: string; enrollmentId: string }) {
  const [q, setQ] = useState<QuestionView>(first);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const submitted = useRef(false);

  const submit = () =>
    start(async () => {
      if (submitted.current) return;
      submitted.current = true;
      const r = await submitAttemptAction(q.attemptId);
      if (r.ok) setResult(r.data);
      else {
        submitted.current = false;
        setError(r.error);
      }
    });

  const deadline = q.deadlineAt;
  useEffect(() => {
    if (!deadline || result) return;
    const end = new Date(deadline).getTime();
    const tick = () => {
      const s = Math.max(0, Math.round((end - Date.now()) / 1000));
      setLeft(s);
      if (s === 0 && !submitted.current) {
        submitted.current = true;
        void submitAttemptAction(q.attemptId).then((r) => (r.ok ? setResult(r.data) : setError(r.error)));
      }
    };
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [deadline, result, q.attemptId]);

  if (result) return <ResultView r={result} title={title} enrollmentId={enrollmentId} notice={null} />;

  const go = (index: number) =>
    start(async () => {
      setError(null);
      setConfirming(false);
      const r = await questionAction(q.attemptId, index);
      if (r.ok) setQ(r.data);
      else setError(r.error);
    });

  const choose = (optionKey: string) => {
    if (q.feedback) return;
    const before = q;
    setQ({ ...q, chosen: optionKey, answered: q.chosen ? q.answered : q.answered + 1 });
    start(async () => {
      setError(null);
      const r = await answerAction(q.attemptId, q.question.key, optionKey);
      if (!r.ok) {
        setQ(before);
        setError(r.error);
        return;
      }
      /* After-each mode: the server now says whether it was right. */
      if (r.data.correct !== null) {
        const again = await questionAction(q.attemptId, q.index);
        if (again.ok) setQ(again.data);
      }
    });
  };

  const last = q.index >= q.total - 1;
  const unanswered = q.total - q.answered;
  const progress = Math.round(((q.index + 1) / q.total) * 100);

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col gap-4">
      <div className="flex flex-col gap-2.5 border-b border-line pb-3">
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-muted">
            {title} · attempt {q.attemptNo}
          </span>
          {deadline ? (
            <span className={cx("text-sm font-semibold tabular-nums", left != null && left < 60 ? "text-danger" : "text-heading")} aria-live="polite">
              {left == null ? "—" : `${clock(left)} left`}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2.5">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-divider">
            <div className="h-full bg-brand" style={{ width: `${progress}%` }} />
          </div>
          <span className="text-[12px] text-muted tabular-nums">
            Question {q.index + 1} of {q.total}
          </span>
        </div>
      </div>

      <h1 className="m-0 text-[19px] leading-[27px] font-semibold text-heading">{q.question.text}</h1>
      <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
        <legend className="sr-only">Choose one answer</legend>
        {q.question.options.map((o, i) => {
          const sel = q.chosen === o.key;
          const right = q.feedback && o.key === q.feedback.correctKey;
          const wrong = q.feedback && sel && !q.feedback.correct;
          return (
            <button
              key={o.key}
              type="button"
              aria-pressed={sel}
              disabled={Boolean(q.feedback)}
              title={q.feedback ? "The answer is shown, so it stays as given" : undefined}
              onClick={() => choose(o.key)}
              className={cx(
                "flex min-h-14 items-center gap-3 rounded-[8px] px-3.5 py-2.5 text-left text-[15px] leading-[21px] text-heading",
                right ? "border-2 border-success bg-success-soft" : wrong ? "border-2 border-danger bg-danger-soft" : sel ? "border-2 border-brand bg-brand-soft" : "border border-line bg-surface",
                q.feedback ? "cursor-default" : "cursor-pointer",
              )}
            >
              <span className={cx("flex size-7 flex-none items-center justify-center rounded-full text-[13px] font-semibold", sel ? "bg-brand text-white" : "bg-divider text-body")}>{String.fromCharCode(65 + i)}</span>
              <span>{o.text}</span>
            </button>
          );
        })}
      </fieldset>
      {q.feedback ? (
        <div className={cx("rounded-[8px] px-3.5 py-3 text-[13px] leading-[19px]", q.feedback.correct ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
          <b>{q.feedback.correct ? "Right." : "Not quite."}</b> {q.feedback.explanation}
        </div>
      ) : null}
      <p className="m-0 text-[12px] text-muted">Your answer is saved as you go. If the phone loses signal, carry on — the timer is kept by the server.</p>
      {error ? <p className="m-0 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-auto flex flex-col gap-2 border-t border-line pt-3">
        {confirming ? (
          <div className="rounded-[8px] bg-warn-soft px-3.5 py-3 text-[13px] text-warn-ink">
            {unanswered} question{unanswered === 1 ? " is" : "s are"} not answered and will count as wrong. Submit anyway?
          </div>
        ) : null}
        <div className="flex gap-2.5">
          <button type="button" className={learnBtn("secondary", pending || q.index === 0)} disabled={pending || q.index === 0} title={q.index === 0 ? "This is the first question" : undefined} onClick={() => go(q.index - 1)}>
            Back
          </button>
          {last ? (
            <button
              type="button"
              className={cx(learnBtn("primary", pending), "flex-1")}
              disabled={pending}
              title={pending ? "Saving…" : undefined}
              onClick={() => (unanswered > 0 && !confirming ? setConfirming(true) : submit())}
            >
              {confirming ? "Submit anyway" : "Submit test"}
            </button>
          ) : (
            <button type="button" className={cx(learnBtn("primary", pending), "flex-1")} disabled={pending} title={pending ? "Saving…" : undefined} onClick={() => go(q.index + 1)}>
              Next question
            </button>
          )}
        </div>
        {!last ? (
          <button type="button" className="min-h-11 cursor-pointer border-0 bg-transparent text-[13px] text-brand-hover" onClick={() => (unanswered > 0 && !confirming ? setConfirming(true) : submit())}>
            {confirming ? "Yes, submit now" : `Submit now · ${q.answered} of ${q.total} answered`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
