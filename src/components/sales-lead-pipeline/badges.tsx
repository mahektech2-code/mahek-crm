import { Badge, type Tone } from "@/components/ui/primitives";
import { STAGE_LABEL } from "@/lib/sales-lead-pipeline/reference";
import type { Lead, Priority, Stage } from "@/lib/sales-lead-pipeline/types";

export function StageBadge({ stage }: { stage: Stage }) {
  const tone: Tone = ["customer", "second_order", "active_distributor"].includes(stage)
    ? "success"
    : ["negotiation", "first_order", "distributor_agreement", "initial_stock_order"].includes(stage)
      ? "brand"
      : ["qualification", "sample_trial", "sample_received", "sample_review", "management_review", "commercial_discussion", "distributor_approval"].includes(stage)
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
 * The classification set on a lead from the start — the same value every
 * ladder/tab decision in this app already keys off (`ladderFor`, the tab
 * set, the Distributor Profile/Approval tabs). It used to render nothing for
 * "direct", which read as though the header only shows a badge when a lead
 * is NOT a direct customer — this shows all three, always, dynamically.
 */
export function SalesTypeBadge({ salesType }: { salesType: Lead["salesType"] }) {
  if (salesType === "direct") return <Badge tone="neutral">Direct</Badge>;
  if (salesType === "third_party") return <Badge tone="brand">Third Party Customer</Badge>;
  return <Badge tone="warn">Distributor</Badge>;
}

export function LeadStatusBadges({ lead }: { lead: Lead }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <SalesTypeBadge salesType={lead.salesType} />
      {lead.lost ? <LostBadge /> : <StageBadge stage={lead.stage} />}
      <PriorityBadge priority={lead.priority} />
    </span>
  );
}
