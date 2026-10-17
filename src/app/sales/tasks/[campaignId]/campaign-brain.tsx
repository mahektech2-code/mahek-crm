"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/console/parts";
import { aiSummariseCampaign } from "@/lib/actions/sales";
import type { TaskSummary } from "@/lib/services/task-ai-service";

/**
 * The brain's half of the results page: what it was asked to build, which
 * answers update the customer record, and — on request — what everything the
 * field sent back adds up to. The reading is kept on the assignment, with
 * when it was taken, because a summary of yesterday's answers is a different
 * thing from a summary of today's.
 */
export function CampaignBrain({
  campaignId,
  aiAvailable,
  answered,
  summary: stored,
  summaryAt,
  brief,
  linked,
  skippedComplete,
}: {
  campaignId: string;
  aiAvailable: boolean;
  answered: number;
  summary: string | null;
  summaryAt: string | null;
  brief: string | null;
  linked: string[];
  skippedComplete: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fresh, setFresh] = React.useState<TaskSummary | null>(null);

  const summary: TaskSummary | null = fresh ?? parse(stored);

  async function summarise() {
    setBusy(true);
    setError(null);
    try {
      const r = await aiSummariseCampaign(campaignId);
      if (!r.ok) setError(r.error);
      else {
        setFresh(r.data);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  if (!aiAvailable && !summary && !linked.length && !brief) return null;

  return (
    <div className="mb-4 rounded-[8px] border border-brand/40 bg-gradient-to-br from-brand-soft to-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-ink">✦ What the field is telling you</p>
          {linked.length ? (
            <p className="mt-0.5 text-[12px] text-pretty text-muted">
              {`↻ ${linked.join(", ")} ${linked.length === 1 ? "updates" : "update"} the customer record as answers arrive, and shops that get it from anywhere else complete by themselves.`}
              {skippedComplete ? ` ${skippedComplete} shop${skippedComplete === 1 ? " was" : "s were"} never sent this — the record already had it.` : ""}
            </p>
          ) : null}
          {brief ? <p className="mt-0.5 text-[12px] text-muted">{`Built by AI from: “${brief}”`}</p> : null}
        </div>
        {aiAvailable ? (
          <Button
            size="sm"
            tone={summary ? "default" : "primary"}
            disabled={busy || answered === 0}
            title={answered === 0 ? "Nothing has been answered yet." : undefined}
            onClick={() => void summarise()}
          >
            {busy ? "Reading the answers…" : summary ? "Read them again" : "✦ Summarise the answers"}
          </Button>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
      {summary ? (
        <div className="mt-3 rounded-[6px] bg-surface p-3 text-[13px] text-body">
          <p className="font-medium text-ink">{summary.headline}</p>
          {summary.findings.length ? (
            <ul className="mt-2 list-disc space-y-0.5 pl-5">
              {summary.findings.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : null}
          {summary.followUps.length ? (
            <>
              <p className="mt-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Do next</p>
              <ul className="list-disc space-y-0.5 pl-5">
                {summary.followUps.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </>
          ) : null}
          {summary.dataQuality ? <p className="mt-2 text-[12px] text-warn">{`Worth checking: ${summary.dataQuality}`}</p> : null}
          <p className="mt-2 text-[11px] text-muted">
            {fresh ? "Read just now" : summaryAt ? `Read ${summaryAt}` : ""} · An AI reading of the answers below — check before acting on it.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function parse(raw: string | null): TaskSummary | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v.headline === "string" && Array.isArray(v.findings) && Array.isArray(v.followUps) ? (v as TaskSummary) : null;
  } catch {
    return null;
  }
}
