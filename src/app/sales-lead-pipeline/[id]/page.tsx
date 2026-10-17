import { notFound } from "next/navigation";
import { LeadRecordScreen } from "@/components/sales-lead-pipeline/lead-record-screen";
import { LeadModals } from "@/components/sales-lead-pipeline/modals";
import { LeadPipelineProvider } from "@/components/sales-lead-pipeline/provider";
import { today } from "@/lib/recompute";
import { pipelineLead, pipelineRefs } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";

export const metadata = { title: "Lead record — Sales Manager — MahekOne" };
export const dynamic = "force-dynamic";

const single = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** `<iso instant>|<row id>` — the keyset position `leadTimelinePage` returned, or nothing. */
function cursorFrom(raw: string | undefined): { at: string; id: string } | null {
  if (!raw) return null;
  const cut = raw.indexOf("|");
  if (cut < 1) return null;
  const at = raw.slice(0, cut);
  const id = raw.slice(cut + 1);
  return id && !Number.isNaN(Date.parse(at)) ? { at, id } : null;
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const day = await today();
  const cursor = cursorFrom(single(sp.tl));

  const found = await pipelineLead(id, day, { before: cursor });
  /* Null covers both "no such lead" and "not in this manager's territory", and
     the two are deliberately the same answer. */
  if (!found) notFound();

  const refs = await pipelineRefs();
  const base = `/sales-lead-pipeline/${id}`;
  const next = found.timeline.next;

  return (
    <LeadPipelineProvider lead={found.lead} refs={refs} today={day}>
      <LeadRecordScreen
        initialTab={cursor ? "timeline" : single(sp.tab)}
        timeline={{
          total: found.timeline.total,
          nextHref: next ? `${base}?tab=timeline&tl=${encodeURIComponent(`${next.at}|${next.id}`)}` : null,
          newestHref: cursor ? `${base}?tab=timeline` : null,
        }}
      />
      <LeadModals />
    </LeadPipelineProvider>
  );
}
