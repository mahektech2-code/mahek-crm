"use client";

import { useState } from "react";
import { cx } from "@/components/ui/primitives";
import { Icon } from "./icons";

/* A godown picker: a button that opens a searchable list of godowns (and,
   where asked, "All"). Used by the header's working location, every list's
   godown filter and Settings. Hundreds of godowns is a search box's job, not
   a <select>'s, so it is not the CRM's Select — but it is drawn in the CRM's
   control language: `chip` is the header's Viewing switch, `field` is a
   filter-bar control. */

export type PickItem = { v: string; l: string; sub?: string };

export function GodownPicker({
  value,
  label,
  items,
  onPick,
  look = "field",
  align = "right",
  placeholder,
  noneLine,
}: {
  value: string;
  label: string;
  items: PickItem[];
  onPick: (v: string) => void;
  look?: "chip" | "field";
  align?: "left" | "right";
  placeholder?: string;
  noneLine?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const match = items.filter((it) => !ql || `${it.l} ${it.sub ?? ""}`.toLowerCase().includes(ql));
  const shown = match.slice(0, 9);
  return (
    <span className="relative inline-block flex-none">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setQ("");
        }}
        title={label}
        aria-expanded={open}
        className={cx(
          "inline-flex max-w-[260px] cursor-pointer items-center gap-1.5 rounded-[4px] text-[13px] whitespace-nowrap",
          look === "chip"
            ? "h-6 bg-brand-soft px-2 font-medium text-[#5223E0]"
            : "h-8 border border-line bg-surface px-2.5 text-body hover:bg-canvas",
        )}
      >
        <Icon n="pin" s={14} />
        <span className="truncate">{label}</span>
        <Icon n="down" s={14} />
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div
            className={cx(
              "animate-fade-in absolute top-10 z-50 w-[320px] max-w-[90vw] overflow-hidden rounded-[6px] border border-line bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]",
              align === "right" ? "right-0" : "left-0",
            )}
          >
            <div className="border-b border-divider p-2">
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={placeholder ?? `Search ${items.length} godowns`}
                className="h-8 w-full rounded-[4px] border border-line px-2.5 text-[13px] outline-none focus:border-brand"
              />
            </div>
            <div className="max-h-[340px] overflow-y-auto py-1">
              {shown.map((it) => (
                <button
                  type="button"
                  key={it.v || "_all"}
                  onClick={() => {
                    onPick(it.v);
                    setOpen(false);
                  }}
                  className={cx(
                    "flex min-h-9 w-full cursor-pointer items-center justify-between gap-2.5 px-3 py-1.5 text-left text-sm",
                    it.v === value ? "bg-brand-soft text-[#5223E0]" : "text-ink hover:bg-canvas",
                  )}
                >
                  <span className="min-w-0 truncate">{it.l}</span>
                  {it.sub ? <span className="flex-none text-xs text-muted">{it.sub}</span> : null}
                </button>
              ))}
            </div>
            {match.length > shown.length ? (
              <div className="border-t border-divider px-3 py-2 text-xs text-muted">
                {match.length - shown.length} more — keep typing to narrow
              </div>
            ) : null}
            {match.length === 0 ? (
              <div className="px-3 py-3 text-[13px] text-muted">{noneLine ?? `No godown matches “${q}”`}</div>
            ) : null}
          </div>
        </>
      ) : null}
    </span>
  );
}
