"use client";

import type { ReactNode } from "react";
import { Button, cx } from "@/components/ui/primitives";
import { Eyebrow, eyebrowClass } from "../look";
import { Icon } from "../icons";

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

/* ---------------------------------------------------------------------------
 * THE PURCHASE RECORD'S PARTS (Nov 2026 design) — one look for every Purchase
 * pop-up: a summary fact down the left rail, the Next step card with the one
 * button the record is waiting on, and its history. The requirement's record
 * (`purchase-flow.tsx`) and the record dialog's Purchase layout
 * (`record-dialog.tsx`) both draw these, so the pages cannot drift apart.
 * ------------------------------------------------------------------------- */

/** One fact in the record's left rail: a small label over its value. */
export function SumFact({ l, children, aside }: { l: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={cx(eyebrowClass, "flex items-center gap-1.5")}>
        {l}
        {aside}
      </dt>
      <dd className="mt-0.5 text-sm break-words text-ink">{children}</dd>
    </div>
  );
}

/** What the record is waiting on, and the button that does it — locked with its reason where the person lacks the tick. */
export function NextStep({ title, sub, act }: { title: string; sub?: string | null; act?: { l: string; why?: string; onPress: () => void } | null }) {
  return (
    <div className="flex items-center gap-4 rounded-card border border-brand bg-brand-soft px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className={cx(eyebrowClass, "text-brand-hover")}>Next step</div>
        <div className="mt-0.5 text-md font-semibold text-ink">{title}</div>
        {sub ? <div className="mt-0.5 text-meta text-body">{sub}</div> : null}
        {act?.why ? (
          <div className="mt-1 flex items-center gap-1.5 text-meta text-muted">
            <Icon n="lock" s={13} />
            {act.why}
          </div>
        ) : null}
      </div>
      {act ? (
        <Button
          variant={act.why ? "secondary" : "primary"}
          className={cx("shrink-0", act.why && "cursor-help opacity-50")}
          aria-disabled={!!act.why}
          title={act.why || act.l}
          onClick={() => (act.why ? undefined : act.onPress())}
        >
          {act.why ? <Icon n="lock" s={14} /> : null}
          {act.l}
        </Button>
      ) : null}
    </div>
  );
}

export type HistoryEntry = { at: string; text: string; open?: boolean };

/** What happened to the record, oldest first; the step still waiting is hollow. */
export function History({ items }: { items: readonly HistoryEntry[] }) {
  if (!items.length) return null;
  return (
    <div className="grid gap-1">
      <div className={eyebrowClass}>History</div>
      <ol className="grid">
        {items.map((h, i) => (
          <li key={i} className="flex gap-3 py-1.5 text-sm">
            <span aria-hidden className={cx("mt-1.5 size-2.5 flex-none rounded-full", h.open ? "border-2 border-brand bg-surface" : "bg-success")} />
            <span className="w-32 flex-none text-muted tabular-nums">{h.at}</span>
            <span className="min-w-0 break-words text-ink">{h.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
