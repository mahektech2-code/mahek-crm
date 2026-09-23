"use client";

import Link from "next/link";
import { Card, PageHeader, SectionLabel } from "@/components/ui/primitives";
import { useLeadPipeline } from "./provider";
import { funnelCounts } from "@/lib/sales-lead-pipeline/engine";
import { DISTRIBUTOR_LADDER, STAGE_LABEL } from "@/lib/sales-lead-pipeline/reference";

export function PipelineScreen() {
  const { leads } = useLeadPipeline();
  const funnel = funnelCounts(leads);
  const maxCount = Math.max(1, ...funnel.map((f) => f.count));

  const distributorLeads = leads.filter((l) => l.salesType === "distributor" && !l.lost);

  return (
    <div className="p-6">
      <PageHeader
        title="Lead Pipeline"
        subtitle="Click a stage to see the leads standing on it. Direct and third-party leads share this funnel; distributor appointments run their own track below."
      />

      <SectionLabel>Direct &amp; Third-Party</SectionLabel>
      <Card className="mt-1.5 mb-6 px-6 pt-6 pb-3">
        <div className="flex items-end gap-4" style={{ height: 160 }}>
          {funnel.map((f) => (
            <Link
              key={f.stage}
              href={`/sales-lead-pipeline/list?stage=${f.stage}`}
              className="flex flex-1 flex-col items-center justify-end gap-1.5"
            >
              <span className="text-sm font-semibold text-ink">{f.count}</span>
              <div
                className="w-full rounded-t-[4px] bg-brand-soft transition-colors hover:bg-brand-softer"
                style={{ height: Math.max(10, (f.count / maxCount) * 120) }}
              />
            </Link>
          ))}
        </div>
        <div className="mt-2 flex gap-4 border-t border-divider pt-2">
          {funnel.map((f) => (
            <span key={f.stage} className="flex-1 text-center text-[11px] leading-tight text-muted">
              {f.label}
            </span>
          ))}
        </div>
      </Card>

      <SectionLabel>Distributor appointments</SectionLabel>
      <Card className="mt-1.5 p-6">
        <div className="flex items-center justify-between">
          {DISTRIBUTOR_LADDER.map((stage, i) => {
            const count = distributorLeads.filter((l) => l.stage === stage).length;
            return (
              <div key={stage} className="flex flex-1 items-center">
                <Link
                  href={`/sales-lead-pipeline/list?stage=${stage}`}
                  className="flex flex-col items-center gap-1 text-center"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-soft text-[12px] font-semibold text-brand-hover">
                    {count}
                  </span>
                  <span className="w-20 text-[10px] leading-tight text-muted">{STAGE_LABEL[stage]}</span>
                </Link>
                {i < DISTRIBUTOR_LADDER.length - 1 ? <span className="mx-1 h-px flex-1 bg-line" /> : null}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
