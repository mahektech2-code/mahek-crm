"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acknowledgeAssetAction } from "@/lib/actions/learn";
import { learnBtn } from "../ui";

type Item = { id: string; label: string; serial: string | null; issuedOn: string | null; by: string | null; acknowledgedOn: string | null; problem: string | null };

const day = (ymd: string | null) => (ymd ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`)) : "");

export function AssetList({ items }: { items: Item[] }) {
  return (
    <div className="flex flex-col gap-3">
      {items.map((i) => (
        <AssetCard key={`${i.id}:${i.acknowledgedOn ?? ""}:${i.problem ?? ""}`} item={i} />
      ))}
    </div>
  );
}

function AssetCard({ item }: { item: Item }) {
  const router = useRouter();
  const [reporting, setReporting] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const send = (problem: string | null) =>
    start(async () => {
      setError(null);
      const r = await acknowledgeAssetAction(item.id, problem);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-2.5 rounded-[8px] border border-line bg-surface px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium text-heading">{item.label}</span>
          <span className="mt-0.5 block text-[12px] text-muted">
            {[item.serial, item.issuedOn ? `given ${day(item.issuedOn)}` : "", item.by ? `by ${item.by}` : ""].filter(Boolean).join(" · ")}
          </span>
        </span>
        {item.acknowledgedOn ? <span className="inline-flex h-[22px] items-center rounded-[11px] bg-success-soft px-2 text-[12px] font-medium text-success">✓ {day(item.acknowledgedOn)}</span> : null}
      </div>
      {item.problem ? <div className="rounded-[6px] bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">You reported: “{item.problem}”. HR will sort it out.</div> : null}
      {!item.acknowledgedOn && !item.problem ? (
        reporting ? (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[12px] text-muted">
              What is wrong?
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} className="rounded-[6px] border border-line-strong px-3 py-2 text-[15px] text-heading outline-none focus:border-brand" />
            </label>
            <div className="flex gap-2">
              <button type="button" className={learnBtn("primary", pending || text.trim().length < 5)} disabled={pending || text.trim().length < 5} title={text.trim().length < 5 ? "Say what is wrong" : undefined} onClick={() => send(text)}>
                Send
              </button>
              <button type="button" className={learnBtn("secondary")} onClick={() => setReporting(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button type="button" className={`${learnBtn("primary", pending)} flex-1`} disabled={pending} title={pending ? "Saving…" : undefined} onClick={() => send(null)}>
              I have it
            </button>
            <button type="button" className={learnBtn("secondary")} onClick={() => setReporting(true)}>
              Report a problem
            </button>
          </div>
        )
      ) : null}
      {error ? <p className="m-0 text-[13px] text-danger">{error}</p> : null}
    </div>
  );
}
