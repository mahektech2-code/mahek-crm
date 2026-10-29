"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useEscape } from "./modal";
import { cx } from "./primitives";

/* ---------------------------------------------------------------------------
 * ONE VALUE, TYPED OR PICKED — the single-select twin of `MultiSelect`.
 *
 * It replaces `<input list="…">`, which is a native `<datalist>`. That control
 * is the right IDEA and the wrong thing on a screen: the browser draws it
 * itself, so it takes none of this product's type, spacing, border or shadow,
 * it sizes itself to its own content rather than to the field, and Chrome will
 * happily open it UPWARD across the page header when the field sits low. On
 * the journey planner it read as a spellchecker's suggestion popup rather than
 * as a control somebody is meant to choose from, which is what it was reported
 * as.
 *
 * **FREE TEXT IS KEPT, and that is why this is not a `<select>`.**
 * `customers.city` holds whatever the sheet typed, so the list of cities is a
 * list of what EXISTS rather than of what is allowed — a manager proposing a
 * town nobody has sold in yet is an ordinary Tuesday, and a closed list would
 * make it impossible. The options are a shortcut past typing, never a
 * constraint on what may be typed.
 *
 * **PORTALED and anchored `fixed`, for the reason `MultiSelect` and `RowMenu`
 * both are:** these sit inside cards carrying `overflow-auto`, and an
 * `overflow` ancestor clips an absolutely positioned descendant. It closes on
 * an outside scroll rather than travelling with it — the same escape, and the
 * same reason the scroll listener has to ignore the panel's own scrolling.
 * ------------------------------------------------------------------------- */

const PANEL_MIN_WIDTH = 200;
const VIEWPORT_MARGIN = 8;
const ROW_HEIGHT = 32;
const MAX_PANEL_HEIGHT = 280;

export function ComboBox({
  value,
  options,
  onChange,
  label,
  placeholder,
  disabled,
  title,
  className,
  inputClassName,
  groups,
  emptyHint = "No match — what you type is still proposed",
}: {
  value: string;
  /** What already exists. A shortcut past typing, never a constraint. */
  options?: string[];
  /**
   * The same list under headings — "Kerala Roadways' godowns", "Used before" —
   * where WHICH kind a row is decides whether it is the right one. A row may
   * carry a hint (the town a godown is in). Given, it replaces `options`.
   */
  groups?: { label: string; options: { value: string; hint?: string | null }[] }[];
  /** The field's own classes — height and type size — where a screen's controls are bigger than the default. */
  inputClassName?: string;
  onChange: (next: string) => void;
  /** Not drawn — the accessible name for the field and its list. */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  /** Said when nothing matches, because an empty panel reads as broken. */
  emptyHint?: string;
}) {
  const [at, setAt] = React.useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  /**
   * Which row the keyboard is on. `-1` is "none", and it is the state the
   * panel OPENS in deliberately: highlighting the first city the moment
   * somebody clicks the field would make Enter commit a value they had not
   * read, on a control whose whole point is that they may type their own.
   */
  const [active, setActive] = React.useState(-1);
  const open = at !== null;
  const fieldRef = React.useRef<HTMLInputElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const rowsRef = React.useRef<HTMLDivElement>(null);

  /* Filtered on what is TYPED, so the field doubles as the search box. A
     value already committed is not a search term — reopening a field reading
     "Indore" should offer every city rather than only Indore, or there is no
     way to change your mind with the mouse. */
  const [term, setTerm] = React.useState<string | null>(null);
  const query = (term ?? "").trim().toLowerCase();
  const sections = (groups ?? [{ label: "", options: (options ?? []).map((value) => ({ value, hint: null })) }])
    .map((g) => ({ label: g.label, options: query ? g.options.filter((o) => o.value.toLowerCase().includes(query) || (o.hint ?? "").toLowerCase().includes(query)) : g.options }))
    .filter((g) => g.options.length);
  /* One flat list for the keyboard; the same value under two headings is offered once, under the first. */
  const seen = new Set<string>();
  for (const g of sections) g.options = g.options.filter((o) => (seen.has(o.value.toLowerCase()) ? false : (seen.add(o.value.toLowerCase()), true)));
  const matches = sections.flatMap((g) => g.options.map((o) => o.value));

  const place = React.useCallback(() => {
    const field = fieldRef.current;
    if (!field) return;
    const rect = field.getBoundingClientRect();
    const width = Math.max(PANEL_MIN_WIDTH, rect.width);
    const height = Math.min(MAX_PANEL_HEIGHT, Math.max(ROW_HEIGHT, (matches.length + (groups ? sections.length : 0)) * ROW_HEIGHT) + 8);
    const below = window.innerHeight - rect.bottom;
    setAt({
      top:
        below < height + VIEWPORT_MARGIN
          ? Math.max(VIEWPORT_MARGIN, rect.top - height - 4)
          : rect.bottom + 4,
      left: Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN),
      width,
    });
  }, [matches.length, groups, sections.length]);

  const close = React.useCallback(() => {
    setAt(null);
    setActive(-1);
    setTerm(null);
  }, []);

  /* On the shared Escape stack while open, so Escape closes the list and NOT the
     dialog it sits in — a dialog listening on window would otherwise close too,
     and take everything typed into it with it. */
  useEscape(close, open);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (fieldRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
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

  /* The highlighted row kept in view. A list of forty cities scrolled by the
     mouse and driven by the keyboard otherwise walks the highlight off the
     bottom of the panel and looks like nothing is happening. */
  React.useEffect(() => {
    if (active < 0) return;
    rowsRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const commit = (next: string) => {
    onChange(next);
    close();
    fieldRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      /* Closed by the Escape stack above, which also keeps the dialog behind it open.
         The stack listens on window, so the key is NOT stopped here — a
         workspace behind this field is on the same stack and stays open. */
      if (open) e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return place();
      if (!matches.length) return;
      setActive((i) => {
        const step = e.key === "ArrowDown" ? 1 : -1;
        const next = i + step;
        if (next < 0) return matches.length - 1;
        if (next >= matches.length) return 0;
        return next;
      });
      return;
    }
    if (e.key === "Enter") {
      /* Enter on a HIGHLIGHTED row picks it; Enter on typed text keeps the
         text and closes. Both are commits — the difference is only whether
         the list or the keyboard supplied the words. */
      if (open && active >= 0 && matches[active]) {
        e.preventDefault();
        commit(matches[active]);
      } else if (open) {
        e.preventDefault();
        close();
      }
    }
  };

  return (
    <span className={cx("relative inline-block", className)}>
      <input
        ref={fieldRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? "combo-panel" : undefined}
        aria-autocomplete="list"
        aria-label={label}
        title={title}
        disabled={disabled}
        placeholder={placeholder}
        value={term ?? value}
        onChange={(e) => {
          setTerm(e.target.value);
          setActive(-1);
          onChange(e.target.value);
          if (!open) place();
        }}
        onFocus={() => place()}
        onClick={() => (open ? undefined : place())}
        onKeyDown={onKeyDown}
        className={cx(
          "w-full rounded-[4px] border bg-surface pr-7 pl-2 text-ink outline-none placeholder:text-muted disabled:opacity-60",
          inputClassName ?? "h-8 text-[13px]",
          open ? "border-brand" : "border-line focus:border-brand",
        )}
      />
      {/* The chevron is what makes it read as a dropdown at a glance rather
          than as a text field that happens to suggest things. It is not a
          button: the field itself opens the panel, and a second control that
          did the same thing in the same place is one people click expecting
          something different. */}
      <svg
        aria-hidden
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cx(
          "pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-muted transition-transform",
          open ? "rotate-180" : "",
          disabled ? "opacity-60" : "",
        )}
      >
        <path d="m6 9 6 6 6-6" />
      </svg>

      {at
        ? createPortal(
            <div
              ref={panelRef}
              id="combo-panel"
              style={{ top: at.top, left: at.left, width: at.width }}
              className="animate-fade-in fixed z-[95] flex max-h-[280px] flex-col overflow-hidden rounded-[6px] border border-line bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
            >
              {matches.length ? (
                <div ref={rowsRef} role="listbox" aria-label={label} className="overflow-y-auto overscroll-contain py-1">
                  {(() => {
                    let i = -1;
                    return sections.map((g) => (
                      <div key={g.label || "all"} role={g.label ? "group" : undefined} aria-label={g.label || undefined}>
                        {g.label ? <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{g.label}</div> : null}
                        {g.options.map((o) => {
                          i++;
                          const row = i;
                          return (
                            <div
                              key={o.value}
                              data-row={row}
                              role="option"
                              aria-selected={o.value === value}
                              onMouseEnter={() => setActive(row)}
                              onMouseDown={(e) => {
                                /* Before blur, or the field loses focus and the panel
                                   closes out from under the click. */
                                e.preventDefault();
                                commit(o.value);
                              }}
                              className={cx(
                                "flex cursor-pointer items-baseline gap-2 px-2.5 py-1.5 text-[13px]",
                                row === active ? "bg-wash text-ink" : "text-body",
                                o.value === value ? "font-medium text-ink" : "",
                              )}
                            >
                              <span className="truncate">{o.value}</span>
                              {o.hint ? <span className="ml-auto shrink-0 text-[12px] text-muted">{o.hint}</span> : null}
                            </div>
                          );
                        })}
                      </div>
                    ));
                  })()}
                </div>
              ) : (
                /* NOT an empty box. Nothing matching is a real answer here and
                   it is not a refusal — what was typed is still what gets
                   proposed, and saying so is what stops somebody deleting a
                   perfectly good town because the list went blank. */
                <p className="px-2.5 py-2 text-[12px] text-muted">{emptyHint}</p>
              )}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
