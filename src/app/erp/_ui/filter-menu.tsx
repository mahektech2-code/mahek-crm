"use client";

import { useState } from "react";
import { cx, Select } from "@/components/ui/primitives";
import { nf } from "@/lib/erp/ui";
import { Icon } from "./icons";
import { fieldLabelClass, LinkButton, popoverClass } from "./look";
import { toolbarToggleClass } from "./columns-menu";

/* ---------------------------------------------------------------------------
 * A list's filters behind ONE button. They used to be a row of dropdowns, one
 * per column, each labelled only by "All …" inside it — five boxes to read on
 * every visit to use one of them now and then. The button says how many are
 * on, so a narrowed list never looks like a whole one.
 * ------------------------------------------------------------------------- */

export type Facet = { k: string; l: string; opts: { v: string; n: number }[] };

export function FilterMenu({ facets, value, onPick, onClear }: { facets: Facet[]; value: Record<string, string>; onPick: (k: string, v: string) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const on = facets.filter((f) => value[f.k]).length;
  return (
    <span className="relative inline-block flex-none">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={toolbarToggleClass(on > 0)}>
        <Icon n="filter" s={14} />
        Filter
        {on ? <span className="rounded-full bg-brand px-1.5 text-2xs font-semibold text-white tabular-nums">{on}</span> : null}
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div className={cx("animate-fade-in absolute top-10 left-0 z-50 flex w-[280px] max-w-[90vw] flex-col gap-3 p-3", popoverClass)}>
            {facets.map((f) => (
              <label key={f.k} className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{f.l}</span>
                <Select value={value[f.k] ?? ""} onChange={(e) => onPick(f.k, e.target.value)} className={cx("cursor-pointer", value[f.k] && "border-brand bg-brand-soft text-brand-hover")}>
                  <option value="">All</option>
                  {f.opts.map((o) => (
                    <option key={o.v} value={o.v}>
                      {o.v} · {nf(o.n)}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
            {on ? (
              <LinkButton onClick={onClear} className="self-start">
                Clear
              </LinkButton>
            ) : null}
          </div>
        </>
      ) : null}
    </span>
  );
}
