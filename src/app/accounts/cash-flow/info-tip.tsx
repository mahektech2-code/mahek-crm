"use client";

import * as React from "react";
import { cx } from "@/components/ui/primitives";

/**
 * A small "i" that holds the explanation a screen would otherwise print.
 * Opens on hover and on focus, and stays open on click, so it works with a
 * mouse, a keyboard and a touch screen alike.
 */
export function InfoTip({ children, align = "left", className }: { children: React.ReactNode; align?: "left" | "right"; className?: string }) {
  const [pinned, setPinned] = React.useState(false);
  const [hover, setHover] = React.useState(false);
  const open = pinned || hover;
  return (
    <span
      className={cx("relative inline-flex align-middle", className)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        aria-label="More information"
        aria-expanded={open}
        onClick={() => setPinned((p) => !p)}
        onFocus={() => setHover(true)}
        onBlur={() => {
          setHover(false);
          setPinned(false);
        }}
        className={cx(
          "flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-full border text-[11px] leading-none font-semibold italic transition-colors",
          open ? "border-brand bg-brand text-white" : "border-line-strong bg-surface text-muted hover:border-brand hover:text-brand",
        )}
      >
        i
      </button>
      {open ? (
        <span
          role="tooltip"
          className={cx(
            "absolute top-6 z-50 w-[300px] rounded-[8px] border border-line bg-surface px-3.5 py-2.5 text-left text-[12.5px] leading-[19px] font-normal tracking-normal whitespace-normal text-body normal-case not-italic shadow-[0_8px_24px_rgba(22,22,22,0.14)]",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
