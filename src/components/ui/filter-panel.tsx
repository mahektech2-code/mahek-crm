"use client";

import * as React from "react";
import { createPortal } from "react-dom";

/**
 * ONE FILTER BUTTON, AND THE FILTERS BEHIND IT.
 *
 * A list's narrowing controls drawn side by side wrap onto two or three rows
 * and push the table below the fold; behind one button carrying how many are
 * on, the bar is a search box, the button and the count. Every control is
 * still there — the panel holds them, each still its own list — and what is on
 * stays on the bar as chips (the screen's own), so nothing narrowed is hidden.
 *
 * It is the Leads filter bar's panel without its columns: the same anchoring,
 * the same "a portalled option list is not outside" rule, the same footer. The
 * caller hands it the controls.
 */
export function FilterPanelButton({
  count,
  onClear,
  summary,
  children,
  width = 560,
  size = "sm",
}: {
  /** How many values are on — drawn on the button. */
  count: number;
  onClear: () => void;
  /** The footer's left side: what the filters found. */
  summary?: React.ReactNode;
  /** The controls. */
  children: React.ReactNode;
  width?: number;
  /** The button's height: `sm` (32px) beside a CRM toolbar, `md` (36px)
      beside the ERP's taller search box. */
  size?: "sm" | "md";
}) {
  const [at, setAt] = React.useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const open = at !== null;
  const close = React.useCallback(() => setAt(null), []);

  React.useEffect(() => {
    if (!open) return;
    /* A MultiSelect inside the panel portals its own option list into the
       body, so a click or a scroll in it lands outside this subtree — and is
       not a reason to shut. */
    const inside = (t: EventTarget | null) => {
      const n = t as Node | null;
      if (!n) return false;
      if (panelRef.current?.contains(n) || triggerRef.current?.contains(n)) return true;
      return Boolean((n as Element).closest?.("[role='listbox']"));
    };
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  /* Below the button where there is room, above it where there is more —
     capped by the window, so the footer is never below the fold. */
  function place() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    const below = window.innerHeight - rect.bottom - margin - 4;
    const above = rect.top - margin - 4;
    if (below >= 320 || below >= above) {
      setAt({ top: rect.bottom + 4, left, maxHeight: Math.min(560, below) });
      return;
    }
    const height = Math.min(560, above);
    setAt({ top: rect.top - height - 4, left, maxHeight: height });
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : place())}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={
          "ui-btn flex flex-none cursor-pointer items-center gap-1.5 rounded-[4px] border px-2.5 text-[13px] " +
          (size === "md" ? "h-9 " : "h-8 ") +
          (count
            ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
            : open
              ? "border-brand bg-surface text-body"
              : "border-line bg-surface text-body hover:bg-canvas")
        }
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 4h18l-7 8v6l-4 2v-8z" />
        </svg>
        <span>Filter</span>
        {count ? (
          <span className="flex size-[18px] items-center justify-center rounded-full bg-[#5223E0] text-[11px] font-medium text-white">
            {count}
          </span>
        ) : null}
      </button>
      {at
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label="Narrow this list"
              style={{ top: at.top, left: at.left, width, maxHeight: at.maxHeight }}
              className="animate-fade-in fixed z-[95] flex flex-col overflow-hidden rounded-[8px] border border-line bg-surface shadow-pop"
            >
              <div className="grid flex-1 grid-cols-2 gap-2.5 overflow-y-auto overscroll-contain p-4 [&>*]:w-full">
                {children}
              </div>
              <footer className="flex flex-none items-center justify-between gap-3 border-t border-line px-4 py-2.5">
                <span className="text-[13px] text-muted">{summary}</span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={onClear}
                    disabled={!count}
                    className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body hover:bg-canvas disabled:cursor-not-allowed disabled:text-muted"
                  >
                    Clear all
                  </button>
                  <button
                    type="button"
                    onClick={close}
                    className="h-8 cursor-pointer rounded-[4px] bg-ink px-3 text-[13px] font-medium text-white hover:opacity-90"
                  >
                    Done
                  </button>
                </span>
              </footer>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
