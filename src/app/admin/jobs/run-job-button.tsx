"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { triggerJob } from "@/lib/actions/crm";

/** The jobs a person may start from here — the same list `triggerJob` takes. */
export const RUNNABLE = [
  "nightly",
  "hourly",
  "day-boundary",
  "sheet-reconcile",
  "sheet-payments",
  "project-sheet",
  "backfill-timeline",
  "wa-reply-media",
  "link-delivery-parties",
  "field-activity-reparse",
] as const;
export type RunnableJob = (typeof RUNNABLE)[number];

/** ▶ on a job's row: runs it now, says what it did, and redraws the table. */
export function RunJobButton({ job }: { job: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const runnable = (RUNNABLE as readonly string[]).includes(job);
  return (
    <button
      type="button"
      disabled={!runnable || busy}
      aria-label={`Run ${job} now`}
      title={runnable ? (busy ? "Running…" : `Run ${job} now`) : "Runs on its own schedule — it cannot be started from here"}
      className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-control border border-line-strong bg-surface text-ink hover:bg-[#f7f9fc] disabled:cursor-not-allowed disabled:opacity-40"
      onClick={async () => {
        setBusy(true);
        try {
          const r = await triggerJob(job as RunnableJob);
          toast.push(r.ok ? (r.data?.ran.join(" · ") ?? r.message ?? "Finished") : r.error);
          if (r.ok) router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M7 4v16l13-8z" />
        </svg>
      )}
    </button>
  );
}
