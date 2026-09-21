"use client";

/* ---------------------------------------------------------------------------
 * WHY THIS SHOP IS ON THIS LIST, drawn as the ladder the engine walked.
 *
 * `resolvePriceList` returns the answer AND the chain of reasons, because a
 * price a telecaller cannot explain is a price the customer argues with. This
 * is the chain: one step per scope kind, narrowest first, each saying what it
 * matched and what it did not, with a tick against the one that won.
 *
 * It is its own component because three screens want it — the preview modal on
 * the price lists index, a customer's own pricing panel, and the coverage
 * report's "why is nobody priced here" — and a second copy of a stepper is a
 * second set of words for one answer.
 * ------------------------------------------------------------------------- */

import { SCOPE_KIND_LABEL } from "@/lib/price-list-labels";
import type { Resolution } from "@/lib/engines/price-resolution";
import { cx } from "@/components/ui/primitives";

export function ResolutionChain({ resolution }: { resolution: Resolution | null }) {
  if (!resolution) {
    return (
      <p className="text-[13px] text-muted">
        No chain to show — nothing was matched.
      </p>
    );
  }

  return (
    <ol className="space-y-0">
      {resolution.chain.map((step, index) => {
        const won = step.chosen !== null;
        const last = index === resolution.chain.length - 1;
        return (
          <li key={`${step.kind}-${index}`} className="flex gap-3">
            {/* The rail: a dot per step, joined by a line, so the eye reads
                it as a sequence rather than as a list of sentences. */}
            <div className="flex w-4 shrink-0 flex-col items-center">
              <span
                className={cx(
                  "mt-1.5 flex h-4 w-4 items-center justify-center rounded-full border text-[9px] leading-none",
                  won
                    ? "border-success bg-success text-white"
                    : "border-line bg-surface text-muted",
                )}
              >
                {won ? "✓" : ""}
              </span>
              {last ? null : <span className="w-px flex-1 bg-line" />}
            </div>

            <div className={cx("min-w-0 flex-1", last ? "pb-0" : "pb-3.5")}>
              <div
                className={cx(
                  "text-sm",
                  won ? "font-medium text-ink" : "text-muted",
                )}
              >
                {SCOPE_KIND_LABEL[step.kind]}
              </div>
              <p className="mt-0.5 text-[13px] text-muted">{step.note}</p>
              {step.matched.length ? (
                <ul className="mt-1 space-y-0.5">
                  {step.matched.map((m) => (
                    <li
                      key={m.scopeId}
                      className={cx(
                        "text-[13px]",
                        m.listId === step.chosen ? "text-ink" : "text-muted",
                      )}
                    >
                      {m.listName}
                      {m.listId === step.chosen ? (
                        <span className="ml-1.5 text-[11px] tracking-[0.04em] text-success uppercase">
                          applies
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
