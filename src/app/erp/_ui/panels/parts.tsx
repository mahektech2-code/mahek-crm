"use client";

import { cx } from "@/components/ui/primitives";
import { Eyebrow } from "../look";

/* ---------------------------------------------------------------------------
 * What the record dialogs' panels draw the same way, said once: the stepper
 * (purchase flow, a return, a stock count) and a figure tile.
 * ------------------------------------------------------------------------- */

/** Where a record is in its flow: one bar per step, done ones ticked, a stopped flow (step < 0) all grey. */
export function Stepper({ steps, step, label }: { steps: readonly string[]; step: number; label: string }) {
  const cancelled = step < 0;
  return (
    <ol className="grid gap-1" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-label={label}>
      {steps.map((s, i) => {
        const done = !cancelled && i < step;
        const now = !cancelled && i === step;
        return (
          <li key={s} className="grid min-w-0 gap-1">
            <span className={cx("h-1.5 rounded-full", done ? "bg-success" : now ? "bg-brand" : "bg-divider")} />
            <span className={cx("text-2xs leading-[14px] break-words", now ? "font-semibold text-ink" : done ? "text-body" : "text-muted")} title={s}>
              {done ? "✓ " : ""}
              {s}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const FIGURE_TONE = { danger: "text-danger", success: "text-success", muted: "text-muted" } as const;

/** One headline figure in a record panel: a small label over the number. */
export function Figure({ l, v, tone }: { l: string; v: string; tone?: keyof typeof FIGURE_TONE }) {
  return (
    <div className="min-w-0 rounded-control border border-divider px-3 py-2">
      <Eyebrow>{l}</Eyebrow>
      <div className={cx("mt-0.5 text-base font-semibold tabular-nums", tone ? FIGURE_TONE[tone] : "text-ink")}>{v}</div>
    </div>
  );
}
