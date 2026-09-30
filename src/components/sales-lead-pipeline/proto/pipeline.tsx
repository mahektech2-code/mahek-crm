import Link from "next/link";

import type { PipelineFunnelData } from "@/lib/sales-lead-pipeline/types";
import { pipelineLinks } from "@/lib/sales-lead-pipeline/workspace";
import { PCard, PFunnel, PPage, PPageHead, PSectionLabel, stageFilter } from "./ui";

/**
 * `renderPipelinePage`: a card holding the direct / third-party funnel at 64px,
 * and a second card holding the distributor appointment as a connected ladder
 * whose nodes fill purple where a lead is standing.
 *
 * The counts are `pipelineFunnel`'s — the same folding of legacy rungs the
 * list behind each bar reads — so only the drawing is the prototype's.
 */
export function ProtoPipeline({ funnel }: { funnel: PipelineFunnelData & { retiredNote: string | null } }) {
  const BASE = pipelineLinks("crm").base;

  return (
    <PPage>
      <PPageHead
        title="Lead Pipeline"
        sub="Click a stage to see the leads standing on it. Direct and third-party leads share this funnel; distributor appointments run their own track below."
      />

      <PCard className="mb-5 px-[22px] pt-6 pb-2">
        <PSectionLabel>Direct &amp; Third-Party</PSectionLabel>
        <PFunnel
          height={64}
          bars={funnel.direct.map((f) => ({ stage: f.stage, label: f.label, count: f.count, href: `${BASE}/list?stage=${stageFilter(f.stage)}` }))}
        />
      </PCard>

      <PCard className="px-[22px] py-5">
        <PSectionLabel>Distributor Appointment</PSectionLabel>
        {funnel.retiredNote ? (
          <div className="mb-3 rounded-[6px] border-l-[3px] border-warn bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn-ink">{funnel.retiredNote}</div>
        ) : null}
        <div className="flex items-start overflow-x-auto pt-1 pb-1.5">
          {funnel.distributor.map((f, i) => (
            <Link key={f.stage} href={`${BASE}/list?stage=${f.stage}`} className="relative flex min-w-[96px] flex-none flex-1 flex-col items-center">
              {i > 0 ? <span className="absolute top-[13px] left-[calc(-50%+13px)] z-0 h-0.5 w-[calc(100%-26px)] bg-line-strong" /> : null}
              <span
                className={
                  "z-[1] flex h-[26px] w-[26px] items-center justify-center rounded-full border-2 text-[12px] font-semibold " +
                  (f.count ? "border-brand bg-brand text-white" : "border-line-strong bg-surface text-[#8890a0]")
                }
              >
                {f.count || ""}
              </span>
              <span className="mt-[7px] max-w-[92px] text-center text-[10.5px] leading-[13px] font-semibold text-muted">{f.label}</span>
            </Link>
          ))}
        </div>
      </PCard>
    </PPage>
  );
}
