import * as React from "react";
import { Badge, Card, cx, type Tone } from "@/components/ui/primitives";
import { PHASE_LABEL, PHASE_TONE } from "@/lib/calling-desk-labels";
import {
  MAX_QUALIFICATION_CALLS,
  nextCallNumber,
  type CallOutcome,
  type DeskPhase,
  type DeskView,
} from "@/lib/engines/lead-calling-desk";
import type { LeadPriority } from "@/lib/lead-priority";
import type { LeadSalesType } from "@/lib/lead-labels";

/* ---------------------------------------------------------------------------
 * The small pieces of the Telecaller screens, drawn once.
 *
 * They are the Version 6 prototype's own — same sizes, same words, same tones —
 * and are written without hooks so the dashboard (a server component) and the
 * record (a client one) can both use them. Colours and spacing come from the
 * CRM's own tokens; nothing here is a new palette.
 * ------------------------------------------------------------------------- */

const ICONS = {
  phone:
    '<path d="M15.5 3.5a6 6 0 0 1 5 5"/><path d="M14.5 7.5a2.5 2.5 0 0 1 2 2"/><path d="M5 4h3l1.6 4-2 1.4a11 11 0 0 0 5 5L14 12.4 18 14v3a2 2 0 0 1-2.2 2A15 15 0 0 1 3 6.2 2 2 0 0 1 5 4z"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.5L3 20.5l1.6-5.4A8.4 8.4 0 1 1 21 11.5z"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.5"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M8 8h8M8 12h5"/>',
  rupee: '<path d="M6 4h12M6 9h12M15 4c0 4-3.5 5-9 5l8 10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chart: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16v-5M12 16V8M16 16v-7"/>',
} as const;

export type DeskIconName = keyof typeof ICONS;

export function DeskIcon({ name, size = 20 }: { name: DeskIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

export function PhaseBadge({ phase }: { phase: DeskPhase }) {
  return <Badge tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Badge>;
}

export function PriorityBadge({ priority }: { priority: LeadPriority | null }) {
  if (!priority) return null;
  const tone: Tone = priority === "high" ? "danger" : priority === "medium" ? "warn" : "neutral";
  return <Badge tone={tone}>{priority === "high" ? "High" : priority === "medium" ? "Medium" : "Low"}</Badge>;
}

/** An online lead has no sales type until somebody decides one — the CRM's own "Not Decided". */
export function SalesTypeBadge({ salesType }: { salesType: LeadSalesType | null }) {
  if (salesType === "direct") return <Badge tone="neutral">Direct</Badge>;
  if (salesType === "third_party") return <Badge tone="brand">Third Party Customer</Badge>;
  if (salesType === "distributor") return <Badge tone="neutral">Distributor</Badge>;
  return <Badge tone="muted">Not Decided</Badge>;
}

export function LeadStatusBadges({
  salesType,
  phase,
  priority,
}: {
  salesType: LeadSalesType | null;
  phase: DeskPhase;
  priority: LeadPriority | null;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <SalesTypeBadge salesType={salesType} />
      <PhaseBadge phase={phase} />
      <PriorityBadge priority={priority} />
    </span>
  );
}

/** Three dots for three calls: filled where made, ringed where next. */
export function CallMeter({
  phase,
  outcomes,
  size = "sm",
}: {
  phase: DeskPhase;
  outcomes: readonly CallOutcome[];
  size?: "sm" | "lg";
}) {
  const next = nextCallNumber(phase);
  const made = outcomes.length;
  const lg = size === "lg";
  return (
    <span
      className="inline-flex items-center gap-2"
      title={`${made} of ${MAX_QUALIFICATION_CALLS} call attempts used`}
    >
      <span className="inline-flex items-center gap-1">
        {[0, 1, 2].map((i) => {
          const o = outcomes[i];
          const isNext = next !== null && i + 1 === next;
          return (
            <span
              key={i}
              className={cx(
                "rounded-full border",
                lg ? "h-3.5 w-3.5" : "h-2.5 w-2.5",
                o
                  ? o === "no_answer" || o === "wrong_number"
                    ? "border-warn bg-warn"
                    : "border-brand bg-brand"
                  : isNext
                    ? "border-2 border-brand bg-surface"
                    : "border-line-strong bg-surface",
              )}
            />
          );
        })}
      </span>
      <span className={cx("font-medium text-ink", lg ? "text-sm" : "text-[12px]")}>
        {next !== null ? `Call ${next} / ${MAX_QUALIFICATION_CALLS}` : `${made} / ${MAX_QUALIFICATION_CALLS} used`}
      </span>
    </span>
  );
}

export function MetaItem({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] tracking-[0.03em] text-muted uppercase">{label}</div>
      <div className="truncate text-[13px] font-medium text-ink" title={value ?? ""}>
        {value || "—"}
      </div>
    </div>
  );
}

export function KvRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-divider py-1.5 text-[13px] last:border-0">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium text-ink">{value || "—"}</span>
    </div>
  );
}

export function SectionCard({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">{title}</div>
        {right ?? null}
      </div>
      {children}
    </Card>
  );
}

/**
 * A row of figures where each one is a door — a BUTTON, because pressing one
 * filters the list on this screen and goes nowhere.
 *
 * There is no "selected" look on these. The figures are counts, and the list
 * below names the view it is showing; a highlight on one tile of eight reads as
 * that tile being the important one. The lifecycle strip keeps its highlight
 * because a rung is somewhere a lead IS.
 */
export function MetricStrip({
  metrics,
  onSelect,
}: {
  metrics: {
    label: string;
    value: string;
    sub?: string;
    tone?: "danger" | "success" | "warn" | "ink";
    view: DeskView;
  }[];
  onSelect: (view: DeskView) => void;
}) {
  return (
    <Card className="mb-4 flex flex-wrap items-start gap-x-8 gap-y-3.5 px-5 py-3.5">
      {metrics.map((m) => (
        <button
          key={m.label}
          type="button"
          onClick={() => onSelect(m.view)}
          className="block cursor-pointer text-left"
        >
          <div className="text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
            {m.label}
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span
              className={cx(
                "text-[22px] leading-7 font-semibold",
                m.tone === "danger"
                  ? "text-danger"
                  : m.tone === "success"
                    ? "text-success"
                    : m.tone === "warn"
                      ? "text-warn-ink"
                      : "text-ink",
              )}
            >
              {m.value}
            </span>
          </div>
          {m.sub ? <div className="text-xs whitespace-nowrap text-muted">{m.sub}</div> : null}
        </button>
      ))}
    </Card>
  );
}
