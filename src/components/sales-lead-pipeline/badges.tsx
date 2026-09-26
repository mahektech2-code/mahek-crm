import { Badge, type Tone } from "@/components/ui/primitives";
import { STAGE_LABEL } from "@/lib/sales-lead-pipeline/reference";
import type { Priority, SalesType, Stage } from "@/lib/sales-lead-pipeline/types";

/** The four things a status badge reads — satisfied by a full `Lead` and by a list row alike. */
export type BadgeLead = { salesType: SalesType | null; stage: Stage | null; priority: Priority; lost?: unknown };

export function StageBadge({ stage }: { stage: Stage }) {
  const tone: Tone = ["customer", "second_order", "active_distributor", "won"].includes(stage)
    ? "success"
    : ["negotiation", "first_order", "distributor_agreement", "initial_stock_order"].includes(stage)
      ? "brand"
      : ["qualification", "qualified", "sample_trial", "sample_received", "sample_review", "management_review", "commercial_discussion", "distributor_approval"].includes(stage)
        ? "warn"
        : "neutral";
  return <Badge tone={tone}>{STAGE_LABEL[stage]}</Badge>;
}

export function LostBadge() {
  return <Badge tone="danger">Lost</Badge>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  if (!priority) return null;
  const tone: Tone = priority === "high" ? "danger" : priority === "medium" ? "warn" : "neutral";
  const label = priority === "high" ? "High" : priority === "medium" ? "Medium" : "Low";
  return <Badge tone={tone}>{label}</Badge>;
}

/**
 * The classification chosen when the lead was raised — the same value every
 * ladder and tab decision keys off. All three are shown, always; and a lead
 * raised before the funnel existed has NONE, which is said as "Not set" rather
 * than guessed into one of the three (the ladder it climbs decides which gates
 * apply, so a wrong guess would block a salesman rather than mislabel a row).
 */
export function SalesTypeBadge({ salesType }: { salesType: SalesType | null }) {
  if (salesType === "direct") return <Badge tone="neutral">Direct</Badge>;
  if (salesType === "third_party") return <Badge tone="brand">Third Party Customer</Badge>;
  if (salesType === "distributor") return <Badge tone="warn">Distributor</Badge>;
  return <Badge tone="muted">Not set</Badge>;
}

export function LeadStatusBadges({ lead }: { lead: BadgeLead }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <SalesTypeBadge salesType={lead.salesType} />
      {lead.lost ? <LostBadge /> : lead.stage ? <StageBadge stage={lead.stage} /> : null}
      <PriorityBadge priority={lead.priority} />
    </span>
  );
}
