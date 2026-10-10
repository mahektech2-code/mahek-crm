"use client";

import { useState } from "react";
import type { ColSpec } from "@/lib/erp/ui";
import { cx } from "@/components/ui/primitives";
import type { ColumnFit } from "./fit-columns";
import { Icon } from "./icons";

/* ---------------------------------------------------------------------------
 * The list's Columns control: how many of the list's columns are drawn, and
 * a menu to choose which. The list never scrolls sideways, so a column that
 * has no room is not offered as a tick that would push the table wider — it
 * says there is no room, and hiding another column makes room for it.
 * Every column, drawn or not, is in the record a row opens.
 * ------------------------------------------------------------------------- */

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
        title={folded ? `${folded} more column${folded > 1 ? "s" : ""} in each record — open a row to see them, or choose which to show` : "Choose which columns to show"}
        className={cx(
          "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[4px] border px-2.5 text-[13px] whitespace-nowrap",
          chosen ? "border-brand bg-brand-soft font-medium text-[#5223E0]" : "border-line bg-surface text-body hover:bg-canvas",
        )}
      >
        Columns
        <span className={cx("tabular-nums", chosen ? undefined : "text-muted")}>
          {fit.shown.length} of {cols.length}
        </span>
        <Icon n="down" s={14} />
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div className="animate-fade-in absolute top-10 right-0 z-50 w-[300px] max-w-[90vw] overflow-hidden rounded-[6px] border border-line bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]">
            <div className="border-b border-divider px-3 py-2.5 text-[12px] leading-[1.45] text-muted">
              The list shows what fits your screen. Every column is in the record a row opens.
              {fit.dropped ? (
                <span className="mt-1 block text-warn-ink">
                  {fit.dropped} of your columns {fit.dropped > 1 ? "do" : "does"} not fit this width.
                </span>
              ) : null}
            </div>
            <div className="max-h-[320px] overflow-y-auto py-1">
              {cols.map((c) => {
                const on = shown.has(c.k);
                const room = on || fit.roomFor(c.k);
                return (
                  <label
                    key={c.k}
                    title={room ? undefined : "No room at this width — hide another column first"}
                    className={cx(
                      "flex min-h-8 items-center gap-2.5 px-3 py-1 text-[13px]",
                      room ? "cursor-pointer text-ink hover:bg-canvas" : "cursor-not-allowed text-muted",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!room}
                      onChange={() => toggle(c.k)}
                      className="h-[15px] w-[15px] cursor-pointer accent-[#6835FB] disabled:cursor-not-allowed"
                    />
                    <span className="min-w-0 flex-1 truncate">{c.l}</span>
                    {!room ? <span className="flex-none text-[11px]">No room</span> : null}
                  </label>
                );
              })}
            </div>
            <div className="flex items-center justify-between border-t border-divider px-3 py-2">
              <span className="text-[12px] text-muted">{chosen ? "Your choice" : "Chosen to fit"}</span>
              <button
                type="button"
                disabled={!chosen}
                onClick={() => onChoose(null)}
                className="cursor-pointer text-[13px] font-medium text-[#5223E0] hover:underline disabled:cursor-default disabled:text-muted disabled:no-underline"
              >
                Reset
              </button>
            </div>
          </div>
        </>
      ) : null}
    </span>
  );
}
