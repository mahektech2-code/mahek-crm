"use client";

import * as React from "react";

/**
 * A field's hint behind an ⓘ. Hover or focus shows it, and a tap toggles it,
 * because the same screens run on a tablet where nothing hovers.
 *
 * It is a SPAN with a button's role rather than a `<button>`, because it sits
 * inside a field's `<label>`: a label hands a click on its text to its first
 * labelable descendant, and a real button before the input would take every
 * click meant for the box. The click is stopped here for the same reason, so
 * tapping the ⓘ does not also focus the box beside it.
 */
export function HintTip({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const toggle = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen((o) => !o);
  };
  return (
    <span className={["group relative inline-flex align-middle", className].filter(Boolean).join(" ")}>
      <span
        role="button"
        tabIndex={0}
        aria-label="About this field"
        aria-describedby={id}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") toggle(e);
          if (e.key === "Escape") setOpen(false);
        }}
        onBlur={() => setOpen(false)}
        className="flex cursor-help rounded-full text-faint outline-none hover:text-muted focus-visible:text-brand"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 7.2v4M8 4.8v.2" strokeLinecap="round" />
        </svg>
      </span>
      <span
        id={id}
        role="tooltip"
        className={[
          "pointer-events-none absolute top-full left-0 z-50 mt-1 w-max max-w-[280px] rounded-control bg-ink px-2.5 py-1.5 text-[12.5px] leading-[17px] font-medium tracking-normal text-white normal-case shadow-pop",
          open ? "block" : "hidden group-hover:block group-focus-within:block",
        ].join(" ")}
      >
        {text}
      </span>
    </span>
  );
}
