"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { rankComparison, type RankView } from "@/lib/hire/actions/decisions";
import type { CompareOption } from "@/lib/hire/services/decisions";
import type { EvidenceQuote } from "@/lib/hire/services/evidence";
import { Btn, Callout, Empty, Label } from "../_ui/kit";

export type CmpColumn = { id: string; name: string; code: string; meta: string; overall: number | null; scores: Record<string, number | null>; quotes: Record<string, EvidenceQuote[]> };

export function CompareScreen({
  roleTitle,
  blueprintId,
  competencies,
  columns,
  options,
  mixed,
  aiDown,
}: {
  roleTitle: string;
  blueprintId: string | null;
  competencies: { key: string; name: string; weight: number }[];
  columns: CmpColumn[];
  options: CompareOption[];
  mixed: boolean;
  aiDown: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [rank, setRank] = useState<RankView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ids = columns.map((c) => c.id);
  const go = (next: string[]) => router.push(`/hire/compare${next.length ? `?ids=${next.join(",")}` : "?ids=none"}`);
  const addable = options.filter((o) => !ids.includes(o.id) && (!blueprintId || o.blueprintId === blueprintId));
  const byBp = new Map<string, CompareOption[]>();
  for (const o of blueprintId ? addable : options) byBp.set(`${o.blueprintTitle} v${o.version}`, [...(byBp.get(`${o.blueprintTitle} v${o.version}`) ?? []), o]);

  const named = (text: string) => (rank ? Object.entries(rank.names).reduce((t, [l, n]) => t.replaceAll(l, n), text) : text);
  const sorted = [...columns].sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));

  const synthesise = async () => {
    setBusy(true);
    setError(null);
    const r = await rankComparison(ids);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setRank(r.data);
  };

  const grid = { gridTemplateColumns: `200px repeat(${Math.max(1, columns.length)}, minmax(0, 1fr))` };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-muted">Comparing{roleTitle ? ` · ${roleTitle}` : ""}</span>
        {columns.map((c) => (
          <span key={c.id} className="inline-flex h-7 items-center gap-1 rounded-[14px] bg-brand-soft pr-1 pl-3 text-[13px] font-medium text-brand-hover">
            {c.name}
            <button aria-label={`Remove ${c.name}`} onClick={() => go(ids.filter((x) => x !== c.id))} className="h-5 w-5 cursor-pointer border-0 bg-transparent text-brand-hover">
              ✕
            </button>
          </span>
        ))}
        {columns.length < 4 && (blueprintId ? addable.length : options.length) ? (
          <select
            value=""
            onChange={(e) => e.target.value && go([...ids, e.target.value])}
            className="h-8 rounded-[4px] border border-line-strong bg-surface px-2 text-[13px] text-body"
            aria-label="Add a candidate"
          >
            <option value="">{columns.length ? "+ Add a candidate for this role" : "Pick a candidate"}</option>
            {[...byBp.entries()].map(([bp, os]) => (
              <optgroup key={bp} label={bp}>
                {os.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} · {o.stageName}
                    {o.overall != null ? ` · ${o.overall}` : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : null}
      </div>
      {mixed ? <Callout tone="warn">Only candidates on the same blueprint version can be compared — the others were left out. A candidate is scored under the version they entered on.</Callout> : null}

      {columns.length < 2 ? (
        <Empty title="Pick at least two candidates for the same role">Comparison is between people on one blueprint version, scored against one rubric.</Empty>
      ) : (
        <>
          <section className="overflow-hidden rounded-[6px] border border-ai-line bg-surface">
            <div className="flex items-center justify-between border-b border-ai-line bg-ai-soft px-5 py-2.5 text-xs font-semibold tracking-[0.04em] text-ai uppercase">
              <span>◈ AI synthesis{rank ? ` · Confidence: ${rank.confidence}` : ""}</span>
              {!aiDown ? (
                <button onClick={synthesise} disabled={busy} className="cursor-pointer border-0 bg-transparent p-0 text-xs font-medium tracking-normal text-ai normal-case underline disabled:cursor-wait">
                  {busy ? "Comparing the evidence…" : rank ? "Compare again" : "Compare with AI"}
                </button>
              ) : null}
            </div>
            <div className="px-5 py-3.5 text-sm leading-[22px] text-heading">
              {rank ? (
                <>
                  <p className="m-0">{named(rank.synthesis)}</p>
                  {rank.tooClose.filter((g) => g.length > 1).map((g, i) => (
                    <p key={i} className="mt-2 mb-0 text-[13px] text-warn-ink">
                      Too close to separate on the evidence: {g.map((l) => rank.names[l] ?? l).join(" and ")}.
                    </p>
                  ))}
                  <ol className="mt-3 mb-0 pl-5 text-[13px] text-body">
                    {[...rank.ranking].sort((a, b) => a.rank - b.rank).map((r) => (
                      <li key={r.label} className="mb-1">
                        <span className="font-medium text-heading">{rank.names[r.label] ?? r.label}</span> — {named(r.why)}
                      </li>
                    ))}
                  </ol>
                  {rank.differentiators.length ? (
                    <div className="mt-3 flex flex-col gap-2.5">
                      {rank.differentiators.map((d, i) => (
                        <figure key={i} className="m-0">
                          <blockquote className="m-0 border-l-2 border-line-strong pl-3 font-[family-name:var(--font-evidence)] text-[15px] leading-[23px]">“{d.verbatim}”</blockquote>
                          <figcaption className="mt-0.5 pl-3 text-[11px] text-muted">
                            {rank.names[d.label] ?? d.label} · {competencies.find((c) => c.key === d.competency)?.name ?? d.competency}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <span className="text-muted">
                  {aiDown
                    ? `${aiDown} Sorted by average stage score instead: ${sorted.map((c) => `${c.name} ${c.overall ?? "—"}`).join(" · ")}. A sort by score is not a ranking — read what each of them said below.`
                    : "Ask for a synthesis to compare what they said, competency by competency. It ranks on evidence only and says so when two are too close to separate."}
                </span>
              )}
              {error ? (
                <Callout tone="warn" className="mt-3">
                  {error} Sorted by average stage score: {sorted.map((c) => `${c.name} ${c.overall ?? "—"}`).join(" · ")}.
                </Callout>
              ) : null}
            </div>
          </section>

          <section className="overflow-hidden rounded-[6px] border border-line bg-surface">
            <div className="grid gap-5 border-b border-line bg-page px-5 py-3.5" style={grid}>
              <span />
              {columns.map((c) => (
                <Link key={c.id} href={`/hire/c/${c.id}?tab=evidence`} className="min-w-0 no-underline">
                  <span className="block text-[15px] font-semibold text-heading">{c.name}</span>
                  <span className="block text-xs text-muted">
                    {c.code} · {c.meta}
                    {c.overall != null ? ` · profile ${c.overall}/10` : ""}
                  </span>
                </Link>
              ))}
            </div>
            {competencies.map((k) => {
              const vals = columns.map((c) => c.scores[k.key]).filter((v): v is number => v != null);
              const top = vals.length ? Math.max(...vals) : null;
              return (
                <div key={k.key} className="grid gap-5 border-t border-divider px-5 py-4 first:border-t-0" style={grid}>
                  <span>
                    <span className="block text-sm font-semibold text-heading">{k.name}</span>
                    <span className="block text-xs text-muted">weight {Math.round(k.weight * 100)}%</span>
                  </span>
                  {columns.map((c) => {
                    const v = c.scores[k.key];
                    const qs = c.quotes[k.key] ?? [];
                    const key = `${c.id}:${k.key}`;
                    const isOpen = open[key];
                    return (
                      <button key={c.id} onClick={() => qs.length > 1 && setOpen((o) => ({ ...o, [key]: !o[key] }))} className={cx("min-w-0 border-0 bg-transparent p-0 text-left", qs.length > 1 ? "cursor-pointer" : "cursor-default")}>
                        <span className={cx("text-xl font-semibold tabular-nums", v == null ? "text-faint" : v === top && vals.length > 1 ? "text-heading" : "text-body")}>{v ?? "—"}</span>
                        {qs[0] ? (
                          <span className="mt-1.5 block border-l-2 border-line-strong pl-2.5 font-[family-name:var(--font-evidence)] text-[15px] leading-[23px] text-heading">“{qs[0].text}”</span>
                        ) : (
                          <span className="mt-1.5 block text-[13px] text-muted">No confirmed evidence on this competency.</span>
                        )}
                        {qs[0] ? <span className="mt-0.5 block pl-3 text-[11px] text-muted">{qs[0].source}</span> : null}
                        {isOpen ? (
                          <span className="mt-2.5 flex flex-col gap-2.5">
                            {qs.slice(1).map((m, i) => (
                              <span key={i} className="block">
                                <span className="block border-l-2 border-line pl-2.5 font-[family-name:var(--font-evidence)] text-[15px] leading-[23px] text-heading">“{m.text}”</span>
                                <span className="mt-0.5 block pl-3 text-[11px] text-muted">{m.source}</span>
                              </span>
                            ))}
                          </span>
                        ) : null}
                        {qs.length > 1 ? <span className="mt-1.5 block text-[11px] text-brand-hover">{isOpen ? "Show less" : `All ${qs.length} quotes`}</span> : null}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </section>
          <Label className="text-center normal-case tracking-normal">Scores are 0–10 per competency, rolled up from confirmed answers across every stage. Click a cell for every quote behind it.</Label>
          <div className="flex justify-end">
            <Btn size="sm" onClick={() => go([])}>
              Clear
            </Btn>
          </div>
        </>
      )}
    </div>
  );
}
