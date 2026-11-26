import Link from "next/link";
import type { AttemptResult } from "@/lib/training/service";
import { cx } from "@/components/ui/primitives";
import { learnBtn } from "../../ui";

/** A submitted attempt: the score, what happens next, and — where the module allows — the review. */
export function ResultView({ r, title, enrollmentId, notice }: { r: AttemptResult; title: string; enrollmentId: string; notice: string | null }) {
  const pass = r.result === "passed";
  const moduleHref = `/learn/${enrollmentId}/${encodeURIComponent(r.moduleKey)}`;
  return (
    <div className="flex flex-col gap-5">
      <div className="text-[15px] font-semibold text-heading">{title} · result</div>
      {notice ? <div className="rounded-[8px] bg-warn-soft px-3.5 py-3 text-[13px] text-warn-ink">{notice}</div> : null}
      <div className="text-center">
        <div className={cx("text-[56px] leading-[60px] font-bold tabular-nums", pass ? "text-success" : "text-danger")}>{r.scorePercent}%</div>
        <div className="mt-1 text-sm text-muted tabular-nums">
          {r.correct} of {r.total} right · pass mark {r.passMark}% · attempt {r.attemptNo}
        </div>
        <div className={cx("mt-3 inline-flex h-7 items-center rounded-[14px] px-3 text-[13px] font-semibold", pass ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
          {pass ? "Passed" : "Not passed — retraining required"}
        </div>
      </div>

      {r.trackCompleted ? <div className="rounded-[8px] bg-brand-soft px-3.5 py-3 text-sm text-heading"><b>Your track is complete.</b> Every required module is passed.</div> : null}

      {!pass && r.weakTags.length ? (
        <div className="rounded-[8px] bg-surface p-3.5 ring-1 ring-line">
          <div className="mb-2 text-xs font-medium tracking-label text-muted uppercase">Topics to go over</div>
          <div className="flex flex-wrap gap-1.5">
            {r.weakTags.map((t) => (
              <span key={t.tag} className="inline-flex h-[26px] items-center rounded-[13px] bg-warn-soft px-2.5 text-[13px] text-warn-ink">
                {t.tag} · {t.missed} missed
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {!pass ? (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {["Read the module again.", "Your trainer goes through it with you and signs it off.", "The retake opens here. This attempt stays in your history."].map((t, i) => (
            <li key={i} className="flex gap-2.5 text-sm text-heading">
              <span className="flex size-[22px] flex-none items-center justify-center rounded-full bg-divider text-[12px] font-semibold">{i + 1}</span>
              {t}
            </li>
          ))}
        </ol>
      ) : null}

      {r.review ? (
        <details className="rounded-[8px] bg-surface ring-1 ring-line">
          <summary className="min-h-12 cursor-pointer px-3.5 py-3 text-sm font-medium text-heading">Review your answers</summary>
          <ol className="m-0 flex flex-col gap-3 px-3.5 pb-3.5">
            {r.review.map((x, i) => (
              <li key={i} className="text-[13px] leading-[19px]">
                <div className="font-medium text-heading">{x.text}</div>
                <div className={x.correct ? "text-success" : "text-danger"}>{x.chosen ? `You said: ${x.chosen}` : "Not answered"}</div>
                {!x.correct ? <div className="text-body">Right answer: {x.correctText}</div> : null}
                {x.explanation ? <div className="text-muted">{x.explanation}</div> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      <div className="flex flex-col gap-2">
        {pass ? (
          <Link href="/learn" className={learnBtn("primary")}>Back to my modules</Link>
        ) : (
          <>
            <Link href={moduleHref} className={learnBtn("primary")}>Review the module</Link>
            <Link href="/learn" className={learnBtn("secondary")}>Back to my modules</Link>
          </>
        )}
      </div>
    </div>
  );
}
