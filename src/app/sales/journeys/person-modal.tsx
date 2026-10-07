"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEscape } from "@/components/ui/modal";
import { cx } from "@/components/ui/primitives";

export type PersonPane = "calendar" | "list" | "propose" | "visits";

/**
 * ONE SALESMAN, OPENED OVER THE TEAM OR TODAY — THE WHOLE OF HIM, NOT A SUMMARY.
 *
 * Everything the One salesman tab and the Visit log show for him, in a panel
 * over the list the manager came from. It is held in the URL (`&in=team` on
 * the ordinary One salesman and Visit log addresses), so the month arrows, a
 * day's drawer, proposing days and the visit log's day picker all navigate
 * without leaving it, a reload keeps it open, and the address can be sent.
 *
 * It sits BELOW the Drawer (z-60) and the Modal (z-70): a day opened from the
 * calendar slides over it, and a reason dialog over that. Escape closes the
 * topmost of them, which is what `useEscape`'s stack is for.
 */
export function PersonModal({
  name,
  initials,
  sub,
  pane,
  panes,
  closeHref,
  children,
}: {
  name: string;
  initials: string;
  sub: string;
  pane: PersonPane;
  panes: Array<{ key: PersonPane; label: string; href: string }>;
  closeHref: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const close = React.useCallback(() => router.push(closeHref, { scroll: false }), [router, closeHref]);
  useEscape(close);

  return (
    <div
      className="animate-fade-in fixed inset-0 z-[55] flex items-start justify-center bg-[rgba(22,22,22,0.35)] p-4 md:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      role="dialog"
      aria-label={name}
    >
      <div className="flex max-h-full w-full max-w-[1200px] flex-col overflow-hidden rounded-[8px] bg-canvas shadow-[0_12px_32px_rgba(22,22,22,0.18)]">
        <header className="flex flex-none flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-surface px-5 pt-3">
          <div className="flex min-w-0 items-center gap-3 pb-3">
            <span className="flex size-9 flex-none items-center justify-center rounded-full bg-brand-soft text-[12px] font-semibold text-[#5223E0]">
              {initials}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[16px] font-semibold text-ink">{name}</span>
              <span className="block truncate text-[12px] text-muted">{sub}</span>
            </span>
          </div>
          <nav className="flex flex-1 gap-1 self-end">
            {panes.map((p) => (
              <Link
                key={p.key}
                href={p.href}
                scroll={false}
                className={cx(
                  "-mb-px border-b-2 px-3 pb-2.5 text-[13px] no-underline hover:no-underline",
                  pane === p.key ? "border-brand font-medium text-ink" : "border-transparent text-muted hover:text-ink",
                )}
              >
                {p.label}
              </Link>
            ))}
          </nav>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="mb-3 flex size-8 cursor-pointer items-center justify-center rounded-[4px] text-[18px] text-muted hover:bg-canvas hover:text-ink"
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
