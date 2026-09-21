"use client";

/* ---------------------------------------------------------------------------
 * WHAT READING A PRICE LIST LOOKS LIKE WHILE IT IS HAPPENING.
 *
 * A scanned price list takes the better part of a minute to read, and the
 * honest alternative to this is a spinner — which says only that something has
 * not finished, and on a minute-long wait reads as a screen that has hung. So
 * the five stages the parser actually moves through are DRAWN: the page is
 * swept, the header and the pack-size columns are picked out, the cells turn
 * into figures, each one gets its verdict, and the sheet is ticked.
 *
 * Every frame of it is driven by the poll rather than by a timer pretending to
 * be one. The stage comes from `parseStatus`, the number of cells from
 * `rowCount`, and the mix of success, warning and danger marks from the
 * matched/suggested/held counts — so what somebody watches is a report of the
 * work and not a decoration over it. Where the poll has not answered yet the
 * sheet is drawn at a sensible default size and says nothing it does not know.
 *
 * `prefers-reduced-motion` turns the whole left half still: no beam, no
 * staggered reveal, no pulse. The stepper alone still says everything the
 * animation does, which is the test of whether the animation was ever carrying
 * information in the first place.
 *
 * The clock is never read during render — the elapsed seconds come off a timer
 * started in an effect, which is the React Compiler rule this codebase keeps
 * everywhere.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import type { PriceDocumentStatus, PriceParsedHeader } from "@/db/schema";
import {
  DOCUMENT_STATUS_LABEL,
  PARSE_STAGES,
  PARSE_STAGE_SENTENCE,
  type ParseStage,
} from "@/lib/price-list-labels";
import { Button, cx } from "@/components/ui/primitives";

/** Exactly what `GET /api/price-lists/documents/[id]/status` answers with. */
export type DocumentStatusPoll = {
  parseStatus: PriceDocumentStatus;
  stageNote: string | null;
  stageStartedAt: string | null;
  confidence: number | null;
  problems: string[];
  rowCount: number;
  matchedCount: number;
  suggestedCount: number;
  heldCount: number;
  pageCount: number | null;
  layout: string | null;
  header: PriceParsedHeader | null;
};

/** The statuses a poller may stop on. */
export const TERMINAL_PARSE_STATUSES: readonly PriceDocumentStatus[] = [
  "parsed",
  "needs_review",
  "published",
  "rejected",
  "failed",
];

export function isTerminalParseStatus(status: PriceDocumentStatus): boolean {
  return TERMINAL_PARSE_STATUSES.includes(status);
}

const COLUMNS = 6;
const DEFAULT_CELLS = 30;

type Phase = "waiting" | "running" | "done" | "review" | "failed";

function phaseOf(status: PriceDocumentStatus | null): Phase {
  if (!status || status === "queued") return "waiting";
  if (status === "parsed" || status === "published") return "done";
  if (status === "needs_review") return "review";
  if (status === "failed" || status === "rejected") return "failed";
  return "running";
}

/** How many cells to draw. The real count where the poll has one, clamped so the sheet still reads as a sheet. */
function cellCountFor(rowCount: number): number {
  if (!rowCount) return DEFAULT_CELLS;
  return Math.max(COLUMNS * 3, Math.min(COLUMNS * 7, rowCount));
}

type CellTone = "success" | "warn" | "danger";

/**
 * Which verdict each cell carries, in the proportion the poll reports.
 *
 * Spread across the sheet rather than filled from one end, so a document that
 * is mostly matched with a handful held looks like what it is instead of like
 * two blocks.
 */
function toneFor(index: number, total: number, matched: number, suggested: number, held: number): CellTone {
  const sum = matched + suggested + held;
  if (sum <= 0) return "success";
  const position = ((index * 7) % total) / total;
  const matchedShare = matched / sum;
  const suggestedShare = suggested / sum;
  if (position < matchedShare) return "success";
  if (position < matchedShare + suggestedShare) return "warn";
  return "danger";
}

const TONE_CLASS: Record<CellTone, string> = {
  success: "bg-success",
  warn: "bg-warn",
  danger: "bg-danger",
};

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readsReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION).matches;
}

export function ParseAnimation({
  status,
  filename,
  onReview,
  onRetry,
}: {
  status: DocumentStatusPoll | null;
  filename: string;
  onReview?: () => void;
  onRetry?: () => void;
}) {
  const [elapsed, setElapsed] = React.useState(0);
  /* Subscribed to rather than copied into state: the media query IS the
     external store, and reading it into state in an effect is a second copy
     that renders once before it agrees with the browser. */
  const reduced = React.useSyncExternalStore(subscribeToReducedMotion, readsReducedMotion, () => false);

  React.useEffect(() => {
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const parseStatus = status?.parseStatus ?? null;
  const phase = phaseOf(parseStatus);
  const stageIndex = parseStatus ? PARSE_STAGES.indexOf(parseStatus as ParseStage) : -1;
  /* Everything is finished once the reading is: a terminal state draws the
     whole sheet rather than freezing it wherever the last poll landed. */
  const reached = phase === "running" ? stageIndex : phase === "waiting" ? -1 : PARSE_STAGES.length;

  const cells = cellCountFor(status?.rowCount ?? 0);
  const rows = Math.ceil(cells / COLUMNS);

  const showFigures = reached >= 2;
  const showMarks = reached >= 3;
  const showTick = reached >= 4;
  const scanning = phase === "running" && reached <= 1 && !reduced;
  const banding = phase === "running" && reached === 1;

  return (
    <div className="flex w-full max-w-[560px] gap-5 rounded-[6px] border border-line bg-surface p-5">
      <style>{KEYFRAMES}</style>

      {/* ------------------------------------------------------------ sheet */}
      <div className="relative w-[196px] flex-none">
        <div
          className={cx(
            "relative h-[252px] overflow-hidden rounded-[3px] border border-line bg-white px-3 py-3",
            "shadow-[0_6px_18px_rgba(22,22,22,0.10)]",
          )}
          aria-hidden
        >
          {/* The header block the classifier is looking for. */}
          <div className="mb-3">
            <div
              className={cx("h-2.5 w-2/3 rounded-[2px] bg-ink/80", banding && !reduced && "pla-band")}
            />
            <div className="mt-1.5 h-1.5 w-1/3 rounded-[2px] bg-line-strong" />
          </div>

          {/* The pack-size column strip, the classifier's other landmark. */}
          <div className={cx("mb-2 flex gap-1", banding && !reduced && "pla-band")}>
            {Array.from({ length: COLUMNS }, (_, c) => (
              <div key={c} className="h-1.5 flex-1 rounded-[1px] bg-brand-softer" />
            ))}
          </div>

          {/* The cells. Grey until the prices are read, then figures, then verdicts. */}
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}>
            {Array.from({ length: rows * COLUMNS }, (_, i) => {
              const live = i < cells;
              const tone = toneFor(
                i,
                cells,
                status?.matchedCount ?? 0,
                status?.suggestedCount ?? 0,
                status?.heldCount ?? 0,
              );
              return (
                <div
                  key={i}
                  className={cx(
                    "relative h-3.5 rounded-[2px] border border-divider",
                    showFigures && live ? "bg-canvas" : "bg-divider",
                  )}
                >
                  {showFigures && live ? (
                    <span
                      className={cx(
                        "absolute inset-x-1 top-1.5 block h-1 origin-left rounded-[1px] bg-body/60",
                        !reduced && "pla-fill",
                      )}
                      style={reduced ? undefined : { animationDelay: `${i * 40}ms` }}
                    />
                  ) : null}
                  {showMarks && live ? (
                    <span
                      className={cx(
                        "absolute right-0.5 bottom-0.5 block h-1.5 w-1.5 rounded-full",
                        TONE_CLASS[tone],
                        !reduced && "pla-pop",
                      )}
                      style={reduced ? undefined : { animationDelay: `${i * 35}ms` }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>

          {/* The terms block at the foot of every one of these documents. */}
          <div className="mt-3 space-y-1">
            <div className="h-1 w-full rounded-[1px] bg-divider" />
            <div className="h-1 w-5/6 rounded-[1px] bg-divider" />
            <div className="h-1 w-2/3 rounded-[1px] bg-divider" />
          </div>

          {/* The scanner. A soft trail behind a bright line, top to bottom, on a loop. */}
          {scanning ? (
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div className="pla-beam absolute inset-x-0 h-20">
                <div className="h-full w-full bg-gradient-to-b from-transparent via-brand/12 to-brand/28" />
                <div className="h-px w-full bg-brand shadow-[0_0_10px_rgba(104,53,251,0.75)]" />
              </div>
            </div>
          ) : null}

          {/* The tick, drawn over the whole sheet once the figures have been checked. */}
          {showTick ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/55">
              <svg viewBox="0 0 48 48" className="h-14 w-14" fill="none">
                <circle
                  cx="24"
                  cy="24"
                  r="21"
                  stroke={phase === "failed" ? "var(--color-danger)" : "var(--color-success)"}
                  strokeWidth="2"
                  opacity="0.35"
                />
                <path
                  d="M15 24.5 L21.5 31 L34 18"
                  stroke={phase === "failed" ? "var(--color-danger)" : "var(--color-success)"}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={reduced ? undefined : "pla-draw"}
                  strokeDasharray="34"
                  strokeDashoffset={reduced ? 0 : undefined}
                />
              </svg>
            </div>
          ) : null}
        </div>

        <div className="mt-2 truncate text-[11px] text-muted" title={filename}>
          {filename}
        </div>
      </div>

      {/* ---------------------------------------------------------- stepper */}
      <div className="min-w-0 flex-1">
        <ol className="space-y-2.5">
          {PARSE_STAGES.map((stage, i) => {
            const state = i < reached ? "done" : i === reached && phase === "running" ? "now" : "pending";
            return (
              <li key={stage} className="flex gap-2.5">
                <span className="relative mt-0.5 flex h-4 w-4 flex-none items-center justify-center">
                  {state === "done" ? (
                    <svg viewBox="0 0 16 16" className="h-4 w-4 text-success" fill="none">
                      <circle cx="8" cy="8" r="7" fill="var(--color-success-soft)" />
                      <path
                        d="M4.75 8.25 L7 10.5 L11.25 5.75"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : state === "now" ? (
                    <>
                      {reduced ? null : (
                        <span className="pla-ring absolute h-4 w-4 rounded-full bg-brand" aria-hidden />
                      )}
                      <span
                        className={cx(
                          "relative block h-2.5 w-2.5 rounded-full bg-brand",
                          !reduced && "pla-breathe",
                        )}
                      />
                    </>
                  ) : (
                    <span className="block h-2.5 w-2.5 rounded-full border border-line-strong" />
                  )}
                </span>
                <div className="min-w-0">
                  <div
                    className={cx(
                      "text-[13px] leading-[18px]",
                      state === "now"
                        ? "font-medium text-ink"
                        : state === "done"
                          ? "text-body"
                          : "text-muted",
                    )}
                  >
                    {DOCUMENT_STATUS_LABEL[stage]}
                  </div>
                  <div
                    className={cx(
                      "text-[11px] leading-[15px] text-muted",
                      state === "pending" && "opacity-55",
                    )}
                  >
                    {PARSE_STAGE_SENTENCE[stage]}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-4 border-t border-divider pt-3">
          <CountsLine status={status} />
          <div className="mt-1 text-[11px] text-muted">
            {phase === "waiting"
              ? `Waiting to start · ${elapsed}s`
              : phase === "running"
                ? `${elapsed}s so far`
                : `Took about ${elapsed}s`}
          </div>
        </div>

        <Outcome phase={phase} status={status} onReview={onReview} onRetry={onRetry} />
      </div>
    </div>
  );
}

/** "Page 1 of 1 · 54 cells · 35 matched · 7 to check · 12 held" — only the parts the poll can answer. */
function CountsLine({ status }: { status: DocumentStatusPoll | null }) {
  if (!status) return <div className="text-[11px] text-muted">Nothing read off the page yet.</div>;
  const parts: string[] = [];
  if (status.pageCount) parts.push(`${status.pageCount} ${status.pageCount === 1 ? "page" : "pages"}`);
  if (status.rowCount) parts.push(`${status.rowCount} cells`);
  if (status.matchedCount) parts.push(`${status.matchedCount} matched`);
  if (status.suggestedCount) parts.push(`${status.suggestedCount} to check`);
  if (status.heldCount) parts.push(`${status.heldCount} held`);
  if (!parts.length) return <div className="text-[11px] text-muted">Nothing read off the page yet.</div>;
  return <div className="text-[11px] text-body">{parts.join(" · ")}</div>;
}

function Outcome({
  phase,
  status,
  onReview,
  onRetry,
}: {
  phase: Phase;
  status: DocumentStatusPoll | null;
  onReview?: () => void;
  onRetry?: () => void;
}) {
  if (phase === "done") {
    return (
      <div className="mt-3 rounded-[4px] border border-success-soft border-l-[3px] border-l-success bg-success-soft px-3 py-2.5">
        <div className="text-[13px] font-medium text-success">Read, and ready to review</div>
        <div className="mt-0.5 text-[11px] text-body">
          Nothing is a price list until somebody publishes it.
        </div>
        {onReview ? (
          <Button size="sm" variant="primary" className="mt-2" onClick={onReview}>
            Review and publish
          </Button>
        ) : null}
      </div>
    );
  }

  if (phase === "review") {
    return (
      <div className="mt-3 rounded-[4px] border border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-3 py-2.5">
        <div className="text-[13px] font-medium text-warn-ink">A person has to look at this one</div>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-body">
          {(status?.problems ?? []).slice(0, 4).map((p, i) => (
            <li key={i}>{p}</li>
          ))}
          {!status?.problems?.length ? <li>Some cells could not be matched on their own.</li> : null}
        </ul>
        {onReview ? (
          <Button size="sm" variant="primary" className="mt-2" onClick={onReview}>
            Review
          </Button>
        ) : null}
      </div>
    );
  }

  if (phase === "failed") {
    return (
      <div className="mt-3 rounded-[4px] border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-3 py-2.5">
        <div className="text-[13px] font-medium text-danger">This one could not be read</div>
        <div className="mt-0.5 text-[11px] text-body">
          {status?.stageNote ?? "The file gave nothing back that looks like a price list."}
        </div>
        {onRetry ? (
          <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  return null;
}

/* The animation itself. Class names are prefixed `pla-` so nothing here can
   collide with a utility, and the keyframes travel with the component rather
   than sitting in globals.css waiting to be orphaned. */
const KEYFRAMES = `
@keyframes pla-beam {
  0%   { transform: translateY(-80%); opacity: 0; }
  10%  { opacity: 1; }
  90%  { opacity: 1; }
  100% { transform: translateY(260%); opacity: 0; }
}
@keyframes pla-band {
  0%, 100% { opacity: 0.4; }
  50%      { opacity: 1; }
}
@keyframes pla-fill {
  from { opacity: 0; transform: scaleX(0.15); }
  to   { opacity: 1; transform: scaleX(1); }
}
@keyframes pla-pop {
  0%   { opacity: 0; transform: scale(0.2); }
  70%  { opacity: 1; transform: scale(1.3); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes pla-draw {
  from { stroke-dashoffset: 34; }
  to   { stroke-dashoffset: 0; }
}
@keyframes pla-breathe {
  0%, 100% { opacity: 0.6; }
  50%      { opacity: 1; }
}
@keyframes pla-ring {
  0%   { opacity: 0.45; transform: scale(0.6); }
  100% { opacity: 0;    transform: scale(1.6); }
}
.pla-beam    { animation: pla-beam 2.1s cubic-bezier(0.4, 0, 0.3, 1) infinite; }
.pla-band    { animation: pla-band 1.3s ease-in-out infinite; }
.pla-fill    { animation: pla-fill 340ms cubic-bezier(0.2, 0, 0.2, 1) both; }
.pla-pop     { animation: pla-pop 320ms cubic-bezier(0.2, 0, 0.2, 1) both; }
.pla-draw    { animation: pla-draw 520ms cubic-bezier(0.2, 0, 0.2, 1) 120ms both; }
.pla-breathe { animation: pla-breathe 1.4s ease-in-out infinite; }
.pla-ring    { animation: pla-ring 1.6s cubic-bezier(0.2, 0, 0.2, 1) infinite; }
@media (prefers-reduced-motion: reduce) {
  .pla-beam, .pla-band, .pla-fill, .pla-pop, .pla-draw, .pla-breathe, .pla-ring { animation: none; }
}
`;
