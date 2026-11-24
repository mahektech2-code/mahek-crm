import Link from "next/link";
import { Badge, Card, EmptyState, Input, Select, buttonClass } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { ACTIVITY_KINDS, BATCH_ACTIONS, KIND_LABEL, MODE_LABEL, type TimelineFilter } from "@/lib/studio/domain/timeline";
import type { TimelineRow } from "@/lib/studio/timeline-service";

/* The Studio Timeline: newest first, one entry per recipient per act. What a PERSON did and what KAPSO reported are
   worded differently on purpose - a mark made by hand is never drawn as a delivery. */

const TONE = { success: "success", danger: "danger", neutral: "neutral", brand: "brand" } as const;

export function TimelineView({ result, basePath = "/studio/make" }: { result: { rows: TimelineRow[]; total: number; page: number; pageCount: number; filter: TimelineFilter }; basePath?: string }) {
  const f = result.filter;
  const href = (page: number) => {
    const p = new URLSearchParams({ list: "timeline" });
    for (const [k, v] of Object.entries({ q: f.q, sender: f.sender, kind: f.kind, from: f.from, to: f.to })) if (v) p.set(k, v);
    if (page > 1) p.set("page", String(page));
    return `${basePath}?${p.toString()}`;
  };
  return (
    <div>
      <form className="mb-3 flex flex-wrap items-end gap-2" action={basePath}>
        <input type="hidden" name="list" value="timeline" />
        <Input name="q" defaultValue={f.q ?? ""} placeholder="Recipient, content or caption" className="w-[260px]" aria-label="Search recipient, content or caption" />
        <Input name="sender" defaultValue={f.sender ?? ""} placeholder="Sent by" className="w-[160px]" aria-label="Sender" />
        <Select name="kind" defaultValue={f.kind ?? ""} aria-label="Type">
          <option value="">All types</option>
          {ACTIVITY_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </Select>
        <Input type="date" name="from" defaultValue={f.from ?? ""} aria-label="From date" className="w-[150px]" />
        <Input type="date" name="to" defaultValue={f.to ?? ""} aria-label="To date" className="w-[150px]" />
        <button className={buttonClass({ variant: "secondary" })} type="submit">
          Filter
        </button>
      </form>
      <Card className="p-0">
        {result.rows.length ? (
          <ol className="relative px-5 py-4" data-testid="timeline">
            {result.rows.map((r, i) => (
              <li key={r.id} className="relative flex gap-4 pb-5 pl-7 last:pb-0" data-action={r.action}>
                {i < result.rows.length - 1 ? <span aria-hidden className="absolute left-[9px] top-5 h-full w-px bg-divider" /> : null}
                <span aria-hidden className={`absolute left-1 top-1.5 h-3 w-3 rounded-full border-2 border-surface ${r.status.tone === "danger" ? "bg-danger" : r.status.confirmedByProvider ? "bg-success" : "bg-faint"}`} />
                <div className="w-[128px] flex-none text-[12.5px] text-muted">{stamp(r.at)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="brand">{KIND_LABEL[r.kind]}</Badge>
                    <span className="truncate text-sm font-medium text-ink" title={r.contentName}>
                      {r.contentName}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[13px] text-ink">
                    {BATCH_ACTIONS.includes(r.action) ? <b>{r.recipientName}</b> : <>To <b>{r.recipientName}</b></>} · by {r.senderName}
                    <span className="text-muted"> · {MODE_LABEL[r.mode]}</span>
                  </div>
                  {r.caption ? <div className="mt-0.5 truncate text-[12.5px] text-muted">“{r.caption}”</div> : null}
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge tone={TONE[r.status.tone as keyof typeof TONE] ?? "neutral"} title={r.status.confirmedByProvider ? "Reported by Kapso" : "What the sender did - not a delivery"}>
                      {r.status.label}
                    </Badge>
                    {r.reason ? <span className="text-[12.5px] text-muted">{r.reason}</span> : null}
                    {r.providerError ? <span className="text-[12.5px] text-danger">{r.providerError}</span> : null}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState
            title={f.q || f.sender || f.kind || f.from || f.to ? "Nothing matches those filters" : "Nothing on the timeline yet"}
            body={f.q || f.sender || f.kind || f.from || f.to ? "Try fewer words, a wider date range, or clear the filters." : "What you and your team send or share from the Studio appears here, one entry for every recipient."}
          />
        )}
      </Card>
      {result.pageCount > 1 ? (
        <div className="mt-3 flex items-center justify-between text-sm text-muted">
          <span>
            Page {result.page} of {result.pageCount} · {result.total} in all
          </span>
          <span className="flex gap-2">
            {result.page > 1 ? <Link href={href(result.page - 1)} className={buttonClass({ size: "sm" })}>Previous</Link> : null}
            {result.page < result.pageCount ? <Link href={href(result.page + 1)} className={buttonClass({ size: "sm" })}>Next</Link> : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
