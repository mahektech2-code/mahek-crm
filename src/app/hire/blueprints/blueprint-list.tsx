"use client";

import { useState } from "react";
import Link from "next/link";
import type { BlueprintListRow } from "@/lib/hire/services/blueprints";
import { cx } from "@/components/ui/primitives";
import { Empty, Icon, Pill, fd, type Tone } from "../_ui/kit";

const STATUS: Record<string, [string, Tone]> = { draft: ["Draft", "warn"], published: ["Published", "success"], retired: ["Retired", "muted"] };

export function BlueprintList({ rows }: { rows: BlueprintListRow[] }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [family, setFamily] = useState("");
  const [size, setSize] = useState(25);
  const [page, setPage] = useState(0);
  const families = [...new Set(rows.map((r) => r.family))].sort();
  const term = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!status || r.status === status) && (!family || r.family === family) && (!term || `${r.title} ${r.family} ${r.department}`.toLowerCase().includes(term)));
  const pages = Math.max(1, Math.ceil(shown.length / size));
  const at = Math.min(page, pages - 1);
  const slice = shown.slice(at * size, at * size + size);

  return (
    <div className="rounded-[6px] border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-divider px-4 py-3">
        <span className="relative">
          <Icon n="search" s={16} className="pointer-events-none absolute top-[9px] left-2.5 text-muted" />
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
            placeholder={`Search ${rows.length} versions`}
            className="h-[34px] w-[280px] rounded-[4px] border border-line bg-canvas pr-3 pl-8 text-sm outline-none focus:border-brand focus:bg-surface"
          />
        </span>
        <select value={family} onChange={(e) => { setFamily(e.target.value); setPage(0); }} className="h-[34px] rounded-[4px] border border-line bg-surface px-2.5 text-sm">
          <option value="">Every family</option>
          {families.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
        <span className="inline-flex gap-0.5 rounded-[6px] border border-line p-[3px]">
          {[["", "All"], ["published", "Published"], ["draft", "Draft"], ["retired", "Retired"]].map(([v, l]) => (
            <button key={v} onClick={() => { setStatus(v); setPage(0); }} className={cx("h-7 cursor-pointer rounded-[4px] border-0 px-2.5 text-xs font-medium", status === v ? "bg-heading text-white" : "bg-transparent text-body")}>
              {l}
            </button>
          ))}
        </span>
      </div>
      {slice.length ? (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs font-medium tracking-[0.04em] text-muted uppercase">
              {["Role", "Version", "Status", "In flight", "Created by", "Published", ""].map((h) => (
                <th key={h} className="border-b border-divider px-4 py-2.5 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((r) => {
              const [l, t] = STATUS[r.status] ?? [r.status, "neutral"];
              return (
                <tr key={r.id} className="hire-row border-b border-divider hover:bg-page">
                  <td className="px-4 py-2">
                    <Link href={`/hire/blueprints/${r.id}`} className="font-medium text-heading">{r.title}</Link>
                    <div className="text-[13px] text-muted">
                      {r.family} · {r.department}
                      {r.locations.length ? ` · ${r.locations.slice(0, 3).join(", ")}${r.locations.length > 3 ? ` +${r.locations.length - 3}` : ""}` : ""}
                    </div>
                  </td>
                  <td className="px-4 tabular-nums">v{r.version}</td>
                  <td className="px-4">
                    <span className="flex items-center gap-1.5">
                      <Pill tone={t}>{l}</Pill>
                      {r.status === "draft" ? <span className="text-xs text-muted tabular-nums">{r.approved} of {r.total} approved</span> : null}
                      {r.aiGenerated && r.status === "draft" ? <Pill tone="ai">◈ AI draft</Pill> : null}
                    </span>
                  </td>
                  <td className="px-4 tabular-nums">{r.inFlight || <span className="text-faint">0</span>}</td>
                  <td className="px-4 text-body">{r.createdBy ?? <span className="text-faint">Seeded</span>}</td>
                  <td className="px-4 tabular-nums text-body">{r.publishedAt ? fd(r.publishedAt) : "—"}</td>
                  <td className="px-4 text-right whitespace-nowrap">
                    <Link href={`/hire/blueprints/${r.id}`} className="text-[13px]">Open</Link>
                    {r.version > 1 ? (
                      <Link href={`/hire/blueprints/${r.id}/diff`} className="ml-3 text-[13px]">Changes</Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="p-6">
          <Empty title={rows.length ? "No blueprint matches these filters" : "No blueprints yet"}>{rows.length ? "Clear a filter to see more." : "Start with New role blueprint."}</Empty>
        </div>
      )}
      <div className="flex items-center gap-3 border-t border-divider px-4 py-2.5 text-[13px] text-muted">
        <span className="tabular-nums">
          {shown.length ? `${at * size + 1}–${Math.min(shown.length, at * size + size)} of ${shown.length}` : "0"}
        </span>
        <span className="flex-1" />
        <select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(0); }} className="h-[30px] rounded-[4px] border border-line bg-surface px-2 text-[13px]">
          {[25, 50, 100].map((n) => (
            <option key={n} value={n}>{n} rows</option>
          ))}
        </select>
        <button disabled={at === 0} onClick={() => setPage(at - 1)} className="h-[30px] cursor-pointer rounded-[4px] border border-line bg-surface px-2.5 disabled:cursor-not-allowed disabled:text-faint">Previous</button>
        <button disabled={at >= pages - 1} onClick={() => setPage(at + 1)} className="h-[30px] cursor-pointer rounded-[4px] border border-line bg-surface px-2.5 disabled:cursor-not-allowed disabled:text-faint">Next</button>
      </div>
    </div>
  );
}
