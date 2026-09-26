import Link from "next/link";
import { Callout, Card, PageHeader, SectionLabel } from "@/components/ui/primitives";
import type { PipelineFunnelData } from "@/lib/sales-lead-pipeline/types";

/**
 * The funnel, counted by `funnelByRung` — one grouped query over the scoped
 * book — and drawn as bars. Nothing here holds the leads: a bar is a count and
 * a link to the list filtered to that rung, which runs the same clause.
 *
 * A server component: there is nothing to click that a link does not do.
 */
export function PipelineScreen({ funnel }: { funnel: PipelineFunnelData & { retiredNote: string | null } }) {
  const direct = funnel.direct;
  const maxCount = Math.max(1, ...direct.map((f) => f.count));
  const distributorTotal = funnel.distributor.reduce((n, f) => n + f.count, 0);

  /* Where the legacy ladder's rungs are folded into the bars, the link has to
     reach both spellings, or the bar says 40 and the list opened from it 12. */
  const stageParam = (stage: string) =>
    stage === "suspect" ? "suspect,new" : stage === "prospect" ? "prospect,contacted" : stage === "qualification" ? "qualification,qualified" : stage === "customer" ? "customer,won" : stage;

  return (
    <div className="p-6">
      <PageHeader
        title="Lead Pipeline"
        subtitle="Click a stage to see the leads standing on it. Direct and third-party leads share this funnel; distributor appointments run their own track below."
      />

      <SectionLabel>Direct &amp; Third-Party</SectionLabel>
      <Card className="mt-1.5 mb-6 px-6 pt-6 pb-3">
        <div className="flex items-end gap-4" style={{ height: 160 }}>
          {direct.map((f) => (
            <Link
              key={f.stage}
              href={`/sales-lead-pipeline/list?stage=${stageParam(f.stage)}`}
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
          {direct.map((f) => (
            <span key={f.stage} className="flex-1 text-center text-[11px] leading-tight text-muted">
              {f.label}
            </span>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-muted">
          Leads raised before the funnel was introduced are counted at the rung their own ladder&rsquo;s stage stands for
          (New → Suspect, Contacted → Prospect, Qualified → Qualification, Won → Customer). Parked and lost leads are not in a bar.
        </p>
      </Card>

      <SectionLabel>Distributor appointments</SectionLabel>
      {funnel.retiredNote ? (
        <Callout tone="warn" className="mt-1.5 mb-2">
          <div className="text-[13px]">{funnel.retiredNote}</div>
        </Callout>
      ) : null}
      <Card className="mt-1.5 p-6">
        {distributorTotal === 0 ? (
          <div className="pb-3 text-center text-sm text-muted">No distributor appointments are in progress.</div>
        ) : null}
        <div className="flex items-center justify-between">
          {funnel.distributor.map((f, i) => (
            <div key={f.stage} className="flex flex-1 items-center">
              <Link
                href={`/sales-lead-pipeline/list?stage=${f.stage}`}
                className="flex flex-col items-center gap-1 text-center"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-soft text-[12px] font-semibold text-brand-hover">
                  {f.count}
                </span>
                <span className="w-20 text-[10px] leading-tight text-muted">{f.label}</span>
              </Link>
              {i < funnel.distributor.length - 1 ? <span className="mx-1 h-px flex-1 bg-line" /> : null}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
