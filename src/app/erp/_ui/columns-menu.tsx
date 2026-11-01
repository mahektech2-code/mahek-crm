"use client";

import { useState } from "react";
import type { ColSpec } from "@/lib/erp/ui";
import { checkboxClass, cx } from "@/components/ui/primitives";
import { LinkButton, popoverClass, toggleClass } from "./look";
import type { ColumnFit } from "./fit-columns";
import { Icon } from "./icons";

/* ---------------------------------------------------------------------------
 * The list's Columns control: how many of the list's columns are drawn, and
 * a menu to choose which. Any column may be ticked, every one of them if
 * somebody wants: a pick wider than the screen scrolls sideways. Every
 * column, drawn or not, is in the record a row opens.
 * ------------------------------------------------------------------------- */

/**
 * A list toolbar's on/off control — Columns, Group by — in its pressed and
 * unpressed looks. One string, so two toggles side by side cannot drift apart.
 */
export const toolbarToggleClass = toggleClass;

export function ColumnsMenu({
  cols,
  fit,
  chosen,
  onChoose,
}: {
  cols: ColSpec[];
  fit: ColumnFit;
  /** The person's own pick, or null for the automatic set. */
  chosen: string[] | null;
  onChoose: (keys: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const shown = new Set(fit.shown.map((c) => c.k));
  const folded = fit.folded.length;
  const toggle = (k: string) => {
    const next = shown.has(k) ? fit.shown.filter((c) => c.k !== k).map((c) => c.k) : [...fit.shown.map((c) => c.k), k];
    onChoose(next.length ? next : null);
  };

  return (
    <span className="relative inline-block flex-none">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Columns, ${fit.shown.length} of ${cols.length} shown`}
        title={`Columns · ${fit.shown.length} of ${cols.length}`}
        className={cx(toolbarToggleClass(!!chosen), "px-2")}
      >
        <Icon n="columns" s={15} />
        {folded ? <span className={cx("text-meta tabular-nums", chosen ? undefined : "text-muted")}>{fit.shown.length}/{cols.length}</span> : null}
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div className={cx("animate-fade-in absolute top-10 right-0 z-50 w-[300px] max-w-[90vw] overflow-hidden", popoverClass)}>
            <div className="border-b border-divider px-3 py-2.5 text-xs leading-[1.45] text-muted">
              Hidden columns are in the record a row opens. Tick as many as you like — a wide list scrolls sideways.
            </div>
            <div className="max-h-[320px] overflow-y-auto py-1">
              {cols.map((c) => {
                const on = shown.has(c.k);
                return (
                  <label key={c.k} className="flex min-h-8 cursor-pointer items-center gap-2.5 px-3 py-1 text-meta text-ink hover:bg-canvas">
                    <input type="checkbox" className={checkboxClass} checked={on} onChange={() => toggle(c.k)} />
                    <span className="min-w-0 flex-1 truncate">{c.l}</span>
                  </label>
                );
              })}
            </div>
            <div className="flex items-center justify-between border-t border-divider px-3 py-2">
              <span className="text-xs text-muted">{chosen ? "Your choice" : "Chosen to fit"}</span>
              <LinkButton disabled={!chosen} onClick={() => onChoose(null)} className="text-meta">
                Reset
              </LinkButton>
            </div>
          </div>
        </>
      ) : null}
    </span>
  );
}
