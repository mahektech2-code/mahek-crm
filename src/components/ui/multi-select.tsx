"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { cx } from "./primitives";

/* ---------------------------------------------------------------------------
 * The Excel-style filter dropdown — check as many as apply, closed shows a
 * summary rather than one value.
 *
 * PORTALED into `document.body`, the same reason `RowMenu` is: every filter
 * bar here sits above a `Card` carrying `overflow-auto` so a wide table
 * scrolls sideways, and an `overflow` ancestor clips an absolutely positioned
 * descendant. A `fixed` panel anchored to the trigger's own rectangle at open
 * time, closing on scroll rather than travelling with it, is the same escape
 * `RowMenu` uses — this is that pattern turned into a form control instead of
 * a row's ⋯ menu.
 *
 * EMPTY SELECTION MEANS "ALL", matching every plain `<Select>` this replaces:
 * each of them offered an "All statuses" / "All types" sentinel as their
 * first option, and nothing selected here reads exactly the same way. There
 * is deliberately no separate "select everything" action — ticking every box
 * and clearing the selection are the same answer to the same question, and a
 * panel offering both invites picking the wrong one for no reason.
 * ------------------------------------------------------------------------- */

export type MultiSelectOption = { value: string; label: string };

const PANEL_MIN_WIDTH = 220;
const PANEL_MAX_WIDTH = 340;
const VIEWPORT_MARGIN = 8;
/** Below this many options a search box is one more thing to read, not a shortcut. */
const SEARCH_THRESHOLD = 8;

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  placeholder = "All",
  className,
  title,
}: {
  /** Not drawn — read by screen readers and used as the trigger's accessible name. */
  label: string;
  options: MultiSelectOption[];
  /** Values from `options`. Empty means no filter — see the note above. */
  selected: string[];
  onChange: (next: string[]) => void;
  /** Shown on the closed trigger when nothing is selected. */
  placeholder?: string;
  className?: string;
  title?: string;
}) {
  const [at, setAt] = React.useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  const [term, setTerm] = React.useState("");
  const open = at !== null;
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  const place = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, rect.width));
    const searchRow = options.length > SEARCH_THRESHOLD ? 41 : 0;
    const height = Math.min(320, searchRow + 37 + options.length * 32 + 8);
    const below = window.innerHeight - rect.bottom;
    setAt({
      top:
        below < height + VIEWPORT_MARGIN
          ? Math.max(VIEWPORT_MARGIN, rect.top - height - 4)
          : rect.bottom + 4,
      // Left-aligned with the trigger, then pulled back inside the window —
      // a filter bar runs left to right, so a panel opening from the left
      // edge of its own control is where the eye already is.
      left: Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN),
      width,
    });
  };

  const close = React.useCallback(() => {
    setAt(null);
    setTerm("");
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    // Capture, because the scroll that matters is a Card's, not the window's,
    // and a scroll event on an inner element does not bubble — but capture
    // also sees the panel's OWN option list scrolling, since a captured
    // listener sits on the path to every target, panel included. Without the
    // check below, scrolling the list closed the dropdown before you could
    // read past the first page of options — the "scroll" that matters is
    // outside the panel, never inside it.
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  const matches = term.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(term.trim().toLowerCase()))
    : options;

  const summary =
    selected.length === 0 || selected.length === options.length
      ? placeholder
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? placeholder)
        : `${selected.length} selected`;

  function toggle(value: string) {
    const set = new Set(selected);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    onChange([...set]);
  }

  return (
    <span className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        title={title}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : place())}
        className={cx(
          "flex h-8.5 items-center gap-1.5 rounded-[4px] border bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand",
          open ? "border-brand" : "border-line",
          className,
        )}
      >
        <span className="max-w-[170px] truncate">{summary}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-none text-muted"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {at
        ? createPortal(
            <div
              ref={panelRef}
              role="listbox"
              aria-label={label}
              aria-multiselectable="true"
              style={{ top: at.top, left: at.left, width: at.width }}
              className="animate-fade-in fixed z-50 flex max-h-[320px] flex-col overflow-hidden rounded-[6px] border border-line bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
            >
              {options.length > SEARCH_THRESHOLD ? (
                <input
                  autoFocus
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder={`Search ${label.toLowerCase()}`}
                  className="flex-none border-b border-divider px-2.5 py-2 text-sm text-ink outline-none"
                />
              ) : null}
              {selected.length ? (
                <div className="flex flex-none items-center border-b border-divider px-2.5 py-1.5">
                  <button
                    type="button"
                    onClick={() => onChange([])}
                    className="cursor-pointer text-[12px] text-muted hover:text-body"
                  >
                    Clear ({selected.length})
                  </button>
                </div>
              ) : null}
              <div className="flex-1 overflow-y-auto py-1">
                {matches.map((o) => (
                  <label
                    key={o.value}
                    className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm text-body hover:bg-canvas"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(o.value)}
                      onChange={() => toggle(o.value)}
                      className="h-[15px] w-[15px] flex-none accent-[#6835FB]"
                    />
                    <span className="truncate">{o.label}</span>
                  </label>
                ))}
                {!matches.length ? (
                  <div className="px-2.5 py-3 text-[13px] text-muted">No matches</div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
