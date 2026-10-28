"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ColSpec } from "@/lib/erp/ui";
import { nf } from "@/lib/erp/ui";
import type { ColFacet, ColFilter } from "@/lib/erp/list-query";
import { Button, checkboxClass, cx, Input } from "@/components/ui/primitives";
import { eyebrowClass, LinkButton, popoverClass } from "./look";

/* ---------------------------------------------------------------------------
 * AN EXCEL FILTER ON ONE COLUMN HEADING.
 *
 * The funnel opens the column's values, each with how many rows carry it, to
 * tick — counted over the rows every OTHER column filter leaves, so picking a
 * transporter narrows the parties to the ones that transporter carries. A
 * number column is a range instead. Nothing applies until Apply: a tick list
 * that re-read the page on every tick would lose the person's place.
 *
 * The menu is drawn in a portal at the funnel's own position, because the
 * table scrolls sideways inside its card and a menu inside it would be cut off.
 * ------------------------------------------------------------------------- */

/** Where the menu opens: under the funnel, or above it near the window's foot. */
type At = { top?: number; bottom?: number; left: number };

/** The menu's tallest, for deciding whether it fits below its funnel. */
const MENU_H = 440;

/** How a blank cell is named in the tick list. */
const BLANK = "—";

export function ColumnFilter({
  col,
  facet,
  value,
  onApply,
  onSort,
}: {
  col: ColSpec;
  facet: ColFacet | undefined;
  value: ColFilter | undefined;
  onApply: (f: ColFilter | null) => void;
  onSort: (d: 1 | -1) => void;
}) {
  const [at, setAt] = useState<At | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const on = !!value;
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const w = 300;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    /* A menu that would run off the bottom of the window opens upward. */
    const up = r.bottom + MENU_H + 6 > window.innerHeight && r.top - MENU_H - 6 > 8;
    setAt(up ? { bottom: window.innerHeight - r.top + 6, left } : { top: r.bottom + 6, left });
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        data-col-filter=""
        data-on={on ? "" : undefined}
        aria-label={on ? `Filtered: ${col.l}. Change the filter` : `Filter ${col.l}`}
        aria-haspopup="dialog"
        aria-expanded={!!at}
        title={on ? `Filtered — change the ${col.l} filter` : `Filter ${col.l}`}
        onClick={() => (at ? setAt(null) : place())}
        className={cx("flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-control", on ? "bg-brand-soft text-brand" : "text-muted hover:text-body")}
      >
        <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
          <path d="M3 5h18l-7 8.5V19l-4 2v-7.5z" />
        </svg>
      </button>
      {at
        ? createPortal(
            <FilterMenu key={JSON.stringify(value ?? null)} at={at} col={col} facet={facet} value={value} onClose={() => setAt(null)} onApply={(f) => (setAt(null), onApply(f))} onSort={(d) => (setAt(null), onSort(d))} anchor={btn} />,
            document.body,
          )
        : null}
    </>
  );
}

function FilterMenu({
  at,
  col,
  facet,
  value,
  onClose,
  onApply,
  onSort,
  anchor,
}: {
  at: At;
  col: ColSpec;
  facet: ColFacet | undefined;
  value: ColFilter | undefined;
  onClose: () => void;
  onApply: (f: ColFilter | null) => void;
  onSort: (d: 1 | -1) => void;
  anchor: React.RefObject<HTMLButtonElement | null>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const opts = facet?.kind === "list" ? facet.opts : [];
  const [ticked, setTicked] = useState<string[]>(() => value?.in ?? opts.map((o) => o.v));
  const [find, setFind] = useState("");
  const [min, setMin] = useState(value?.min != null ? String(value.min) : "");
  const [max, setMax] = useState(value?.max != null ? String(value.max) : "");

  /* Close on a click outside, Escape, or the page moving under the menu. */
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const move = (e: Event) => {
      if (box.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", move, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, anchor]);

  const range = facet?.kind === "range";
  const textual = col.t !== "n" && col.t !== "m" && col.t !== "d";
  const fl = find.trim().toLowerCase();
  const shown = opts.filter((o) => !fl || label(o.v).toLowerCase().includes(fl));
  const allOn = shown.length > 0 && shown.every((o) => ticked.includes(o.v));
  const toggle = (v: string) => setTicked((t) => (t.includes(v) ? t.filter((x) => x !== v) : [...t, v]));
  const num = (s: string) => {
    const n = Number(s.replace(/,/g, "").trim());
    return s.trim() === "" || !Number.isFinite(n) ? null : n;
  };
  const apply = () => {
    if (range) {
      const a = num(min);
      const b = num(max);
      onApply(a == null && b == null ? null : { min: a, max: b });
      return;
    }
    /* Every value ticked, and none beyond the cap unseen, is no filter at all. */
    const every = facet?.kind === "list" && !facet.more && opts.every((o) => ticked.includes(o.v));
    onApply(every ? null : { in: ticked });
  };
  const u = col.u?.trim() ?? "";

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={`Filter ${col.l}`}
      style={{ top: at.top, bottom: at.bottom, left: at.left, maxHeight: MENU_H }}
      className={cx(popoverClass, "fixed z-80 flex w-75 flex-col text-sm text-body")}
    >
      <div className="grid gap-0.5 border-b border-divider p-1.5">
        <SortRow onClick={() => onSort(1)} up>
          {textual ? "Sort A → Z" : col.t === "d" ? "Sort oldest first" : "Sort smallest first"}
        </SortRow>
        <SortRow onClick={() => onSort(-1)}>{textual ? "Sort Z → A" : col.t === "d" ? "Sort newest first" : "Sort largest first"}</SortRow>
      </div>

      {range ? (
        <div className="grid gap-2 p-3">
          <span className={eyebrowClass}>Show {col.l.toLowerCase()} between</span>
          <div className="flex items-center gap-2">
            <Input inputMode="decimal" aria-label="At least" placeholder={facet.lo != null ? nf(facet.lo) : "Min"} value={min} onChange={(e) => setMin(e.target.value)} className="min-w-0 flex-1" />
            <span className="text-muted">to</span>
            <Input inputMode="decimal" aria-label="At most" placeholder={facet.hi != null ? nf(facet.hi) : "Max"} value={max} onChange={(e) => setMax(e.target.value)} className="min-w-0 flex-1" />
          </div>
          {u ? <span className="text-xs text-muted">In {u}. Leave an end empty for no limit.</span> : <span className="text-xs text-muted">Leave an end empty for no limit.</span>}
        </div>
      ) : (
        <div className="grid gap-2 p-3">
          <Input autoFocus placeholder="Search values" aria-label={`Search ${col.l} values`} value={find} onChange={(e) => setFind(e.target.value)} />
          <label className="flex cursor-pointer items-center gap-2 border-b border-divider pb-2 font-medium text-ink">
            <input
              type="checkbox"
              className={checkboxClass}
              checked={allOn}
              onChange={() => {
                const vs = shown.map((o) => o.v);
                setTicked((t) => (allOn ? t.filter((v) => !vs.includes(v)) : [...t, ...vs.filter((v) => !t.includes(v))]));
              }}
            />
            {fl ? `Select all shown (${nf(shown.length)})` : "Select all"}
          </label>
          <div className="-mx-1 max-h-56 overflow-y-auto">
            {shown.length ? (
              shown.map((o) => (
                <label key={o.v} className="flex cursor-pointer items-center gap-2 rounded-control px-1 py-1 hover:bg-canvas">
                  <input type="checkbox" className={checkboxClass} checked={ticked.includes(o.v)} onChange={() => toggle(o.v)} />
                  <span className={cx("min-w-0 flex-1 truncate", o.v === BLANK && "text-muted italic")} title={label(o.v)}>
                    {label(o.v)}
                  </span>
                  <span className="text-xs text-muted tabular-nums">{nf(o.n)}</span>
                </label>
              ))
            ) : (
              <p className="px-1 py-2 text-muted">No value matches.</p>
            )}
          </div>
          {facet?.kind === "list" && facet.more ? <span className="text-xs text-muted">{nf(facet.more)} more values — search to find them.</span> : null}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-divider px-3 py-2.5">
        <LinkButton onClick={() => onApply(null)}>Clear filter</LinkButton>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={apply} disabled={!range && ticked.length === 0} title={!range && ticked.length === 0 ? "Tick at least one value" : undefined}>
          Apply
        </Button>
      </div>
    </div>
  );
}

const label = (v: string) => (v === BLANK || v === "" ? "(Blanks)" : v);

function SortRow({ children, onClick, up }: { children: React.ReactNode; onClick: () => void; up?: boolean }) {
  return (
    <button type="button" onClick={onClick} className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-left hover:bg-canvas">
      <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="text-muted">
        {up ? <path d="M12 19V5m-6 6 6-6 6 6" /> : <path d="M12 5v14m6-6-6 6-6-6" />}
      </svg>
      {children}
    </button>
  );
}
