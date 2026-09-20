import Link from "next/link";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { moneyShort } from "@/lib/format";
import { stageLabel, type LeadStage } from "@/lib/lead-labels";
import type { LadderStep, StepLadder } from "@/lib/engines/lead-funnel-shape";
import { Pill } from "@/components/console/parts";
import { plural } from "@/components/console/words";

/* ---------------------------------------------------------------------------
 * §8.3b — THE DISTRIBUTOR TRACK, AS A LADDER RATHER THAN AS MORE BARS.
 *
 * It is drawn differently because it is a different kind of progress. The
 * funnel beside it measures CONVERSION: a hundred suspects become forty
 * prospects become nine orders, and the width of each bar against the one above
 * it is the figure a manager is reading. An appointment converts nothing. It is
 * a sequence of approvals — a management review, a commercial discussion, two
 * sign-offs and a stock commitment — and the only honest question about a step
 * is whether anybody is waiting on it and for how long. Drawn as bars, the
 * narrowing from `management_review` to `distributor_approval` would read as a
 * drop-off rate, and there is no such thing here.
 *
 * It is also why a distributor's `management_review` is not laid beside a paint
 * shop's `sample_review` although they are the same distance up two ladders.
 * They are not the same work and a row you can read across is an invitation to
 * treat them as if they were — the same reason `leads/board` draws one sales
 * type at a time.
 *
 * RETIRED FOR NEW LEADS, AND NEITHER DEAD NOR BEING FED. `offeredSalesTypes()`
 * no longer puts Distributor in front of anybody raising a lead, because Mahek
 * does not appoint distributors through MahekOne and leads were stalling half
 * way up behind a gate nobody in the building could open. Every lead ALREADY on
 * it keeps its rung, its gates and its ability to climb, so the counts here are
 * real and the steps are still clickable. The screen says both halves of that
 * in words: a ladder drawn without the sentence reads as a track somebody
 * should be filling, and one drawn greyed out reads as leads nobody needs to
 * work — and there are leads on it that somebody does.
 * ------------------------------------------------------------------------- */

/**
 * Where a step goes, narrowed the same way the bar funnel's segments are.
 *
 * Six of these nine rungs are on no other ladder, so `stage` alone would in
 * fact be exact for them — and the three at the foot, `suspect`, `prospect`
 * and `qualification`, are shared with both shop ladders and would open three
 * populations under one number. Naming the track on every step rather than on
 * the three that need it: a screen where some links are narrowed and others
 * are not is one nobody can predict, and the exception would be the one
 * somebody reads.
 */
function stepHref(workspace: LeadWorkspace, stage: LeadStage): string {
  return leadHref(workspace, `leads?salesType=distributor&stage=${stage}`);
}

export function DistributorStepLadder({
  workspace,
  ladder,
}: {
  workspace: LeadWorkspace;
  ladder: StepLadder;
}) {
  const busiest = ladder.steps.reduce((n, s) => Math.max(n, s.count), 0);

  return (
    <section className="rounded-[6px] border border-line bg-surface">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-3.5">
        <div>
          <h3 className="text-sm font-semibold text-ink">Distributor appointment</h3>
          <p className="mt-0.5 max-w-[620px] text-xs text-muted">
            Approvals rather than conversions, so it is a ladder rather than a funnel — the gap
            between two steps is a queue, never a drop-off rate.
          </p>
        </div>
        <div className="flex flex-none flex-wrap gap-1.5">
          {ladder.parked > 0 ? <Pill tone="warn">{ladder.parked} parked</Pill> : null}
          {ladder.lost > 0 ? <Pill tone="neutral">{ladder.lost} lost</Pill> : null}
        </div>
      </header>

      {/*
        Both halves of the retirement, said together. Either sentence alone is
        misread: "retired" on its own reads as leads nobody needs to work, and
        silence reads as a track somebody should be filling.
      */}
      <p className="border-b border-line bg-canvas px-5 py-2.5 text-[11px] leading-[16px] text-muted">
        <span className="font-medium text-body">Closed to new leads.</span> Nothing raised today can
        be started on this ladder — Mahek does not appoint distributors through MahekOne, and leads
        were stalling behind an approval nobody in the building could give.{" "}
        {ladder.climbing > 0 ? (
          <>
            The {plural(ladder.climbing, "lead")} below are already on it, still climb it, and are
            still somebody&rsquo;s work.
          </>
        ) : (
          <>
            Nobody is on it. The steps are drawn at zero rather than hidden, because leads on this
            ladder still exist in the book and a step with no row on the screen is one nobody would
            think to look for.
          </>
        )}
      </p>

      <ol className="px-5 py-4">
        {ladder.steps.map((step, i) => (
          <Step
            key={step.stage}
            workspace={workspace}
            step={step}
            index={i}
            last={i === ladder.steps.length - 1}
            busiest={busiest}
          />
        ))}
      </ol>

      {ladder.offLadder.length > 0 ? (
        <footer className="border-t border-line bg-canvas px-5 py-3 text-[13px] text-body">
          <span className="font-medium text-ink">Not on this ladder: </span>
          {ladder.offLadder.map((r, i) => (
            <span key={`${r.stage}-${i}`}>
              {i > 0 ? ", " : ""}
              {stageLabel(r.stage)} ({r.count})
            </span>
          ))}
          <span className="text-muted">
            {" "}
            — a rung the distributor ladder does not carry, usually because the sales type was
            changed under them. Shown rather than dropped.
          </span>
        </footer>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------- step */

function Step({
  workspace,
  step,
  index,
  last,
  busiest,
}: {
  workspace: LeadWorkspace;
  step: LadderStep;
  index: number;
  last: boolean;
  busiest: number;
}) {
  const occupied = step.count > 0;

  return (
    <li className="relative pl-7">
      {/* The rail between the nodes. A ladder's steps are ordered and the order
          is load-bearing here in a way it is not on a bar chart — §12's second
          sign-off exists precisely because it comes AFTER the first. */}
      {!last ? (
        <span className="absolute left-[9px] top-5 h-[calc(100%-4px)] w-px bg-divider" aria-hidden />
      ) : null}

      <span
        className={`absolute left-0 top-[3px] flex h-[19px] w-[19px] items-center justify-center rounded-full border text-[10px] tabular-nums ${
          occupied
            ? "border-brand bg-brand text-white"
            : "border-line bg-surface text-muted"
        }`}
        aria-hidden
      >
        {index + 1}
      </span>

      <div className="mb-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[13px] text-body">
            {occupied ? (
              <Link
                href={stepHref(workspace, step.stage)}
                title={`Open the ${plural(step.count, "lead")} standing on ${stageLabel(step.stage)}`}
                className="text-[#5223E0]"
              >
                {stageLabel(step.stage)}
              </Link>
            ) : (
              /* An empty step is not a link. A link that opens an empty board is
                 a click somebody pays for and learns nothing from, and drawing
                 it identically to a live one makes the occupied steps harder to
                 find — which is the whole thing this picture is for. */
              <span className="text-muted">{stageLabel(step.stage)}</span>
            )}
            {step.approval ? (
              <span
                className="ml-2 align-middle text-[10px] uppercase tracking-wide text-muted"
                title="§12 — a salesman may never appoint a distributor and a manager may not do it alone. A long wait here is somebody else's queue, not a slow salesman."
              >
                approval
              </span>
            ) : null}
          </span>
          <span className={`flex-none text-[13px] tabular-nums ${occupied ? "text-ink" : "text-muted"}`}>
            {step.count}
          </span>
        </div>

        {occupied ? (
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 text-[11px] text-muted">
            {step.medianDaysHere !== null ? (
              <span title={`Median over the ${step.dated} of ${step.count} that carry a stage date`}>
                {step.medianDaysHere}d on this step
                {step.dated < step.count ? ` (${step.dated} dated)` : ""}
              </span>
            ) : (
              <span title="No lead on this step records when it arrived">no dates</span>
            )}
            {step.potentialPaise > 0 ? (
              <span title="Somebody's estimate of what these are worth. Never a derived figure.">
                {moneyShort(step.potentialPaise)} estimated
              </span>
            ) : null}
            {/* The bar is a proportion within this ladder only. It is drawn thin
                and unlabelled on purpose: the number beside the step is the
                answer, and a wide bar here must not be read against the funnel
                next to it, which is measured against a different book. */}
            <span className="h-1 w-16 overflow-hidden rounded-[2px] bg-divider" aria-hidden>
              <span
                className="block h-full rounded-[2px] bg-brand/60"
                style={{ width: busiest > 0 ? `${(step.count / busiest) * 100}%` : "0%" }}
              />
            </span>
          </div>
        ) : null}
      </div>
    </li>
  );
}
