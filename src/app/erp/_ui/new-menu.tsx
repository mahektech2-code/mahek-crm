"use client";

import { useEffect, useRef, useState } from "react";
import { NavLink } from "@/components/shell/nav-link";
import { Icon as ShellIcon } from "@/components/shell/icons";
import { buttonClass, cx } from "@/components/ui/primitives";
import { popoverClass } from "./look";

/**
 * "+ New ▾": one button that offers every kind of record a screen can start,
 * each a line and a sentence (Petty Cash: an expense, petty cash, a receipt,
 * a transfer, an advance). Each item opens that record's form on its own tab.
 */
export type NewMenuItem = { l: string; sub?: string; href: string };

export function NewMenu({ items, label = "New" }: { items: NewMenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={buttonClass({ variant: "primary" })}>
        <ShellIcon name="plus" size={16} />
        {label} ▾
      </button>
      {open ? (
        <div role="menu" className={cx(popoverClass, "absolute right-0 z-40 mt-1.5 grid w-64 gap-0.5 p-1.5")}>
          {items.map((i) => (
            <NavLink key={i.l} role="menuitem" href={i.href} onClick={() => setOpen(false)} className="block rounded-control px-3 py-2 hover:bg-brand-soft">
              <span className="block text-sm font-medium text-ink">{i.l}</span>
              {i.sub ? <span className="block text-meta text-muted">{i.sub}</span> : null}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}
