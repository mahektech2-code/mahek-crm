"use client";

import Link from "next/link";
import { cx } from "@/components/ui/primitives";

/** A row of mutually exclusive choices — the ladder switch and List / Board. */
export function Segmented({
  label,
  items,
}: {
  label: string;
  items: { key: string; label: string; title?: string; on: boolean; href?: string; onPick?: () => void }[];
}) {
  const cls = (on: boolean) =>
    cx(
      "inline-flex h-7 items-center rounded-[6px] px-3 text-[13px] font-medium whitespace-nowrap no-underline hover:no-underline",
      on ? "bg-surface text-ink shadow-[0_1px_2px_rgba(22,22,22,.12)]" : "text-muted hover:text-ink",
    );
  return (
    <div role="group" aria-label={label} className="inline-flex gap-0.5 rounded-[8px] bg-divider p-0.5">
      {items.map((i) =>
        i.href && !i.on ? (
          <Link key={i.key} href={i.href} className={cls(false)} title={i.title}>
            {i.label}
          </Link>
        ) : (
          <button
            key={i.key}
            type="button"
            title={i.title}
            aria-pressed={i.on}
            onClick={i.on ? undefined : i.onPick}
            className={cx(cls(i.on), "cursor-pointer border-0", !i.on && "bg-transparent")}
          >
            {i.label}
          </button>
        ),
      )}
    </div>
  );
}
