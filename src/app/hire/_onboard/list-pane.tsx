"use client";

import { useState } from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { Pill, type Tone } from "../_ui/kit";

export type PaneRow = { id: string; name: string; meta: string; badge: { l: string; tone: Tone } };

/** The left list on every onboarding screen: who is at this point, filterable, picks by `?app=`. */
export function ListPane({ label, rows, selected, basePath, empty }: { label: string; rows: PaneRow[]; selected: string | null; basePath: string; empty: string }) {
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(40);
  const t = q.trim().toLowerCase();
  const shown = t ? rows.filter((r) => `${r.name} ${r.meta}`.toLowerCase().includes(t)) : rows;
  return (
    <div className="sticky top-4 overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="border-b border-divider px-3.5 py-2.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">{label}</div>
      <div className="border-b border-divider p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, phone or role"
          className="h-8 w-full rounded-[4px] border border-line-strong px-2.5 text-[13px] outline-none focus:border-brand"
        />
      </div>
      {!shown.length ? <div className="px-3.5 py-4 text-[13px] text-muted">{t ? `Nobody here matches “${q.trim()}”.` : empty}</div> : null}
      {shown.slice(0, limit).map((r) => (
        <Link
          key={r.id}
          href={`${basePath}?app=${r.id}`}
          scroll={false}
          className={cx(
            "flex items-center gap-2.5 border-t border-canvas px-3.5 py-2.5 no-underline first:border-t-0 hover:bg-canvas hover:no-underline",
            selected === r.id ? "bg-brand-soft shadow-[inset_3px_0_0_var(--color-brand)]" : "",
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-heading">{r.name}</span>
            <span className="block truncate text-xs text-muted">{r.meta}</span>
          </span>
          <Pill tone={r.badge.tone}>{r.badge.l}</Pill>
        </Link>
      ))}
      {shown.length > limit ? (
        <button onClick={() => setLimit((n) => n + 40)} className="h-9 w-full cursor-pointer border-0 border-t border-divider bg-page text-[13px] font-medium text-brand-hover">
          Show {Math.min(40, shown.length - limit)} more
        </button>
      ) : null}
    </div>
  );
}
