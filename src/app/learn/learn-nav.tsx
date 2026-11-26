"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui/primitives";

const TABS = [
  { href: "/learn", label: "Training", icon: "M2 9l10-5 10 5-10 5zM6 11v5c3 2.5 9 2.5 12 0v-5M22 9v6" },
  { href: "/learn/assets", label: "Assets", icon: "M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8" },
  { href: "/learn/contacts", label: "Contacts", icon: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 19c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 0 1 0 6M21 19c0-2-1.5-3.6-3.5-4.4" },
] as const;

/** The bottom tabs. Hidden inside a test: nothing should pull somebody away from a timed attempt. */
export function LearnNav({ assetsWaiting }: { assetsWaiting: number }) {
  const path = usePathname();
  if (path.startsWith("/learn/test/")) return null;
  const on = (href: string) => (href === "/learn" ? !path.startsWith("/learn/assets") && !path.startsWith("/learn/contacts") : path.startsWith(href));
  return (
    <nav aria-label="Training" className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface">
      <div className="mx-auto flex max-w-[640px]">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={on(t.href) ? "page" : undefined}
            className={cx("flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium no-underline hover:no-underline", on(t.href) ? "text-brand-hover" : "text-muted")}
          >
            <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={t.icon} />
            </svg>
            {t.label}
            {t.href === "/learn/assets" && assetsWaiting ? ` · ${assetsWaiting}` : ""}
          </Link>
        ))}
      </div>
    </nav>
  );
}
