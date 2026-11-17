"use client";

import * as React from "react";
import { ADMIN } from "@/lib/admin-routes";
import { cx } from "@/components/ui/primitives";
import { Figures, Tabs, type Figure } from "../_shell/kit";

/* ---------------------------------------------------------------------------
 * THE HANDSETS SCREEN'S FRAME, drawn as the canvas draws it: the title with a
 * search box and a Filters button on its row, the figure cards, the fleet's
 * tabs with their counts, then the table. It is the page frame's own layout,
 * repeated here because the search and the filters belong to the live table
 * below them and so have to live in the browser with it.
 * ------------------------------------------------------------------------- */

export type FleetTab = "field" | "factory" | "control";
export type FilterOption = { value: string; label: string; count?: number };

export function FleetFrame({
  title = "Handsets",
  tab,
  counts,
  figures,
  search,
  filters,
  children,
}: {
  title?: string;
  tab: FleetTab;
  counts: { field: number; factory: number };
  figures?: Figure[];
  search?: { value: string; onChange: (v: string) => void; placeholder: string };
  filters?: { groups: Array<{ label: string; value: string; options: FilterOption[]; onChange: (v: string) => void }>; on: number };
  children: React.ReactNode;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-4 px-6 pt-6 pb-10 text-[13px] leading-[1.45]">
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="m-0 text-[22px] leading-7 font-bold tracking-[-0.02em] text-ink">{title}</h1>
        <span className="flex-1" />
        {search ? (
          <input
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            aria-label="Find a handset"
            placeholder={search.placeholder}
            className="h-9 w-[240px] rounded-control border border-line-strong bg-surface px-3 text-[13px] text-ink placeholder:text-muted focus:border-brand focus:outline-none"
          />
        ) : null}
        {filters ? <FiltersButton {...filters} /> : null}
      </div>
      {figures && figures.length ? <Figures items={figures} min={150} /> : null}
      <Tabs
        active={tab}
        items={[
          { slug: "field", label: "Salesman App", href: ADMIN.handsets, count: counts.field },
          { slug: "factory", label: "Factory app", href: ADMIN.factoryHandsets, count: counts.factory },
          { slug: "control", label: "MBOS control", href: ADMIN.mbosControl },
        ]}
      />
      <div className="flex min-w-0 flex-col gap-[18px]">{children}</div>
    </div>
  );
}

function FiltersButton({
  groups,
  on,
}: {
  groups: Array<{ label: string; value: string; options: FilterOption[]; onChange: (v: string) => void }>;
  on: number;
}) {
  const [open, setOpen] = React.useState(false);
  const box = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-control border border-line-strong bg-surface px-3.5 text-[13px] font-semibold text-ink hover:bg-[#f7f9fc]"
      >
        Filters{on ? ` · ${on}` : ""}
      </button>
      {open ? (
        <div className="absolute top-11 right-0 z-40 flex w-[260px] flex-col gap-3 rounded-card border border-line bg-surface p-3 shadow-pop">
          {groups.map((g) => (
            <div key={g.label} className="flex flex-col gap-1">
              <div className="px-1 text-xs font-semibold text-muted">{g.label}</div>
              {g.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => g.onChange(o.value)}
                  className={cx(
                    "flex h-8 cursor-pointer items-center justify-between rounded-control px-2 text-left text-[13px]",
                    g.value === o.value ? "bg-brand-soft font-semibold text-brand-deep" : "text-body hover:bg-canvas",
                  )}
                >
                  {o.label}
                  {o.count != null ? <span className="text-xs text-muted tabular-nums">{o.count}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
