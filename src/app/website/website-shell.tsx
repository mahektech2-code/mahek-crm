"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { AppFrame } from "@/components/shell/app-frame";
import { Wordmark } from "@/components/shell/wordmark";
import { Icon } from "@/components/shell/icons";
import { SignOutButton } from "@/components/shell/sign-out-button";

/* ---------------------------------------------------------------------------
 * The Website app's shell: a flat 12-item sidebar, the same shape Accounts
 * and the Sales Dashboard draw in groups — this app is small enough that one
 * group says everything. The floor, scroll model and arrival animation are
 * the frame's; see `components/shell/app-frame.tsx`.
 * ------------------------------------------------------------------------- */

type Item = {
  href: string;
  label: string;
  icon: string;
  exact?: boolean;
};

const NAV: Item[] = [
  { href: "/website", label: "Dashboard", icon: "dashboard", exact: true },
  { href: "/website/products", label: "Products", icon: "grid" },
  { href: "/website/industries", label: "Industries", icon: "chart" },
  { href: "/website/pages", label: "Pages", icon: "doc" },
  { href: "/website/gallery", label: "Gallery", icon: "book" },
  { href: "/website/media", label: "Media", icon: "copy" },
  { href: "/website/careers", label: "Careers", icon: "clipboard" },
  { href: "/website/testimonials", label: "Testimonials", icon: "chat" },
  { href: "/website/milestones", label: "Milestones", icon: "history" },
  { href: "/website/navigation", label: "Navigation", icon: "menu" },
  { href: "/website/seo", label: "SEO", icon: "search" },
  { href: "/website/settings", label: "Settings", icon: "settings" },
];

export function WebsiteShell({
  user,
  allowed,
  switcher,
  feedback,
  children,
}: {
  user: { name: string; initials: string; role: string };
  /** The routes this person may open, resolved in the layout. */
  allowed: string[];
  switcher: React.ReactNode;
  feedback: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const permitted = new Set(allowed);
  const items = NAV.filter((i) => permitted.has(i.href));

  return (
    <AppFrame
      header={
        <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-4">
          {switcher}
          <Wordmark label="MAHEK WA" />
          <span className="flex-1" />
          {feedback}
          <span className="mx-1 h-6 w-px flex-none bg-divider" />
          <div className="flex flex-none items-center gap-2">
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[4px] bg-brand-soft text-xs font-semibold text-[#5223E0]">
              {user.initials}
            </span>
            <span className="min-w-0 leading-[14px]">
              <span className="block text-[13px] font-medium whitespace-nowrap text-ink">
                {user.name}
              </span>
              <span className="block text-[11px] whitespace-nowrap text-muted">
                {user.role}
              </span>
            </span>
          </div>
          <SignOutButton />
        </header>
      }
      sidebar={
        <aside className="flex w-[clamp(196px,17vw,240px)] flex-none flex-col border-r border-line bg-surface">
          <nav aria-label="Website sections" className="flex-1 overflow-y-auto px-1.5 pt-2 pb-4">
            {items.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "relative mb-px flex h-9 items-center gap-2.5 overflow-hidden rounded-[4px] border-l-[3px] pr-2.5 pl-[9px] text-sm whitespace-nowrap no-underline transition-colors duration-100 hover:no-underline",
                    active
                      ? "border-l-brand font-medium text-[#5223E0]"
                      : "border-l-transparent text-body hover:bg-canvas",
                  )}
                >
                  {active ? (
                    <span className="pointer-events-none absolute inset-0 rounded-[4px] bg-brand-soft" />
                  ) : null}
                  <Icon name={item.icon} size={18} className="relative z-1 flex-none" />
                  <span className="relative z-1 min-w-0 flex-1 overflow-hidden text-ellipsis">
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </nav>
        </aside>
      }
    >
      {children}
    </AppFrame>
  );
}
