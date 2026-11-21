import Link from "next/link";

import { CardGrid } from "@/components/ui/card-grid";
import { cx } from "@/components/ui/primitives";
import { Icon } from "@/components/shell/icons";
import { stageLabel } from "@/lib/lead-labels";
import { rawStagesOf } from "@/lib/lead-display";
import type { DisplayStage } from "@/lib/engines/lead-ladder";

/*
 * THE LEAD STAGE SUMMARY — one card per pipeline stage. A card is a LINK that
 * sets the list's own `stage` filter, so the list below, its search, filters,
 * paging and the scope it is read under are all the existing ones; nothing here
 * counts or filters. The numbers are made on the server (`leadStageSummary`):
 * the total, MIN (created in the last 24 hours) and MAX (older), the last two
 * summing to the first by construction.
 */
const CARD = "rounded-[10px] border bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04)]";

const LOOK: Record<string, { icon: string; tint: string }> = {
  suspect: { icon: "search", tint: "bg-brand-soft text-brand" },
  prospect: { icon: "people", tint: "bg-success-soft text-success" },
  qualification: { icon: "clipboard", tint: "bg-info-soft text-info" },
  sample_trial: { icon: "gift", tint: "bg-warn-soft text-warn-ink" },
  negotiation: { icon: "doc", tint: "bg-brand-soft text-brand" },
  first_order: { icon: "target", tint: "bg-success-soft text-success" },
};

/** The `stage=` value for one card: every stored rung drawn under it. */
const paramOf = (s: DisplayStage) => rawStagesOf(s).join(",");

export function LeadStageSummary({
  stages,
  selectedStages,
  hrefFor,
}: {
  stages: { stage: DisplayStage; count: number; min: number; max: number }[];
  /** The `stage` values already in the URL. */
  selectedStages: string[];
  /** The list's address with this `stage` set, or with none (null). */
  hrefFor: (stageParam: string | null) => string;
}) {
  const picked = new Set(selectedStages);
  const isSelected = (s: DisplayStage) => {
    const raw = rawStagesOf(s);
    return raw.length === picked.size && raw.every((r) => picked.has(r));
  };
  const none = picked.size === 0;

  return (
    <div className="mb-4">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 className="text-[12px] font-semibold tracking-[0.08em] text-muted uppercase">
          Lead stage summary
        </h2>
        <Link
          href={hrefFor(null)}
          aria-pressed={none}
          className={cx(
            "inline-flex h-[30px] items-center rounded-[8px] border px-3 text-[12.5px] font-medium no-underline hover:no-underline",
            none
              ? "border-brand bg-brand-soft text-brand"
              : "border-line bg-surface text-body hover:bg-canvas",
          )}
        >
          All stages
        </Link>
      </div>
      <CardGrid min={170} gap="gap-4">
        {stages.map(({ stage, count, min, max }) => {
          const look = LOOK[stage] ?? LOOK.suspect;
          const on = isSelected(stage);
          return (
            <Link
              key={stage}
              /* The selected card links back to no stage, so a second click clears it. */
              href={hrefFor(on ? null : paramOf(stage))}
              aria-pressed={on}
              className={cx(
                CARD,
                "block px-5 py-4 no-underline hover:no-underline",
                on
                  ? "border-brand bg-brand-soft shadow-[0_0_0_1px_var(--color-brand)]"
                  : "border-line hover:border-brand",
              )}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className={cx(
                    "flex size-8 flex-none items-center justify-center rounded-[8px]",
                    look.tint,
                  )}
                >
                  <Icon name={look.icon} size={17} />
                </span>
                <span className={cx("text-[13px] font-medium", on ? "text-ink" : "text-muted")}>
                  {stageLabel(stage)}
                </span>
              </div>
              <div className="mt-3 text-[28px] leading-8 font-semibold tracking-[-0.02em] text-ink tabular-nums">
                {count}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-2 text-[12px] font-semibold text-danger tabular-nums">
                <span>MIN: {min}</span>
                <span aria-hidden>|</span>
                <span>MAX: {max}</span>
              </div>
            </Link>
          );
        })}
      </CardGrid>
    </div>
  );
}
