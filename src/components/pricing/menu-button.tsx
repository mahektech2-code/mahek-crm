"use client";

/* ---------------------------------------------------------------------------
 * A BUTTON THAT OPENS A MENU OF WAYS TO DO ONE THING.
 *
 * "Create a price list" is one intention with six starting points — a PDF, a
 * folder of PDFs, a blank grid, a copy, a derivation, a spreadsheet — and six
 * buttons in a page header is a header nobody reads. Each item carries a
 * sentence, because "Derive" means nothing until it says "from another list,
 * by a rule".
 *
 * Rendered into `document.body`, like `RowMenu`, so a scrolling ancestor can
 * never clip it; it closes on scroll for the same reason.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { createPortal } from "react-dom";
import { Button, cx } from "@/components/ui/primitives";

export type MenuButtonItem = {
  key: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  destructive?: boolean;
  /** Draws a rule above this item. */
  divider?: boolean;
};

export function MenuButton({
  label,
  items,
  variant = "secondary",
  align = "right",
  width = 320,
  size = "md",
}: {
  label: React.ReactNode;
  items: MenuButtonItem[];
  variant?: "primary" | "secondary" | "ghost";
  align?: "left" | "right";
  width?: number;
  size?: "sm" | "md";
}) {
  const [at, setAt] = React.useState<{ top: number; left: number } | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (at) return setAt(null);
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = align === "right" ? Math.max(8, r.right - width) : Math.min(r.left, window.innerWidth - width - 8);
    setAt({ top: r.bottom + 6, left });
  };

  React.useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      if (e.type === "mousedown" && (menuRef.current?.contains(e.target as Node) || ref.current?.contains(e.target as Node))) return;
      setAt(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAt(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", key);
    };
  }, [at]);

  return (
    <div ref={ref} className="inline-flex">
      <Button variant={variant} size={size} onClick={toggle} aria-haspopup="menu" aria-expanded={!!at}>
        {label}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={cx("transition-transform", at && "rotate-180")}>
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </Button>
      {at
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={{ top: at.top, left: at.left, width }}
              className="animate-fade-in fixed z-[90] overflow-hidden rounded-[6px] border border-line bg-surface py-1 shadow-[0_12px_32px_rgba(22,22,22,0.16)]"
            >
              {items.map((item) => (
                <React.Fragment key={item.key}>
                  {item.divider ? <div className="my-1 h-px bg-divider" /> : null}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    title={item.title}
                    onClick={() => {
                      setAt(null);
                      item.onSelect();
                    }}
                    className={cx(
                      "flex w-full items-start gap-3 px-3 py-2 text-left",
                      item.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-canvas",
                    )}
                  >
                    {item.icon ? (
                      <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-[5px] bg-brand-soft text-[#5223E0]">
                        {item.icon}
                      </span>
                    ) : null}
                    <span className="min-w-0">
                      <span className={cx("block text-sm font-medium", item.destructive ? "text-danger" : "text-ink")}>{item.label}</span>
                      {item.description ? <span className="mt-0.5 block text-[12px] leading-[17px] text-muted">{item.description}</span> : null}
                    </span>
                  </button>
                </React.Fragment>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
