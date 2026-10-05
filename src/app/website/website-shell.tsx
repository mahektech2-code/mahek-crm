"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/shell/icons";
import { cx } from "@/components/ui/primitives";

const NAV: { href: string; label: string; icon: string }[] = [
  { href: "/website", label: "Dashboard", icon: "dashboard" },
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

export function WebsiteShell({ userName, children }: { userName: string; children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen bg-canvas">
      <aside className="flex w-[232px] flex-none flex-col border-r border-line bg-surface">
        <div className="flex h-14 flex-none items-center gap-2 border-b border-line px-4">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[4px] bg-brand text-[13px] font-semibold text-white">
            W
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold text-ink">Website</div>
            <div className="truncate text-[11px] text-muted">mahekindia.com</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {NAV.map((item) => {
            const active = item.href === "/website" ? pathname === "/website" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cx(
                  "mb-0.5 flex items-center gap-2.5 rounded-[4px] px-2.5 py-2 text-[13.5px] font-medium transition-colors",
                  active ? "bg-brand-soft text-[#5223E0]" : "text-body hover:bg-canvas",
                )}
              >
                <Icon name={item.icon} size={17} strokeWidth={1.6} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex-none border-t border-line px-3 py-3">
          <Link
            href="/enquiries"
            className="flex items-center gap-2.5 rounded-[4px] px-2.5 py-2 text-[13px] text-muted hover:bg-canvas hover:text-body"
          >
            <Icon name="mail" size={16} strokeWidth={1.6} />
            Website Enquiries →
          </Link>
          <p className="mt-1 px-2.5 text-[11px] text-muted">Enquiries live in the Enquiries app, not here.</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 flex-none items-center justify-between border-b border-line bg-surface px-6">
          <div className="text-[13px] text-muted">
            <Link href="/apps" className="hover:text-body">
              MahekOne
            </Link>
            <span className="px-1.5">/</span>
            <span className="text-body">Website Admin</span>
          </div>
          <div className="flex items-center gap-3 text-[13px] text-body">
            <span className="rounded-[3px] bg-warn-soft px-1.5 py-0.5 text-[11px] font-medium text-warn-ink">
              Prototype — mock data
            </span>
            <span>{userName}</span>
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-[1280px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
