"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AppFrame } from "@/components/shell/app-frame";
import { AccountMenu } from "@/components/shell/account-menu";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { CollapsibleNav, isRowActive, type NavRowGroup, type NavRowItem } from "@/components/shell/collapsible-nav";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { HeaderLead } from "@/components/shell/header-lead";
import { Icon as ShellIcon } from "@/components/shell/icons";
import { NotificationBell } from "@/components/shell/notification-bell";
import { cx } from "@/components/ui/primitives";
import { ToastProvider } from "@/components/ui/toast";
import { ErpUiProvider } from "@/app/erp/_ui/erp-ui";
import { hrmsSearch, type HrmsSearchHit } from "@/lib/actions/hrms-screens";
import type { Notification } from "@/db/schema";
import type { AppDefinition } from "@/lib/apps";
import "@/lib/hrms/calcs";
import { HRMS_KIT } from "./kit";
import { HIcon, hasHIcon } from "./icons";

/* ---------------------------------------------------------------------------
 * The HRMS's shell: the CRM's frame and header (switcher, wordmark, search,
 * Tell us, the bell, the account) and the CRM's `CollapsibleNav`, with the
 * HRMS's modules. Unlike the desk apps it has no floor, because most people
 * open HRMS on a phone at the office door: below the sidebar breakpoint the
 * navigation becomes a drawer and a bottom bar carries the four screens a
 * person opens every day (the design's bottom navigation).
 * ------------------------------------------------------------------------- */

export type NavScreen = { key: string; label: string; nav?: string; short?: string; icon: string; href: string; count?: number; bottom?: boolean };
export type NavGroup = { id: string; label: string; icon: string; screens: NavScreen[] };

const SHELL_ICONS = new Set(["dashboard", "phone", "bell", "history", "wallet", "doc", "person", "people", "chart", "clipboard", "check", "clock", "settings", "lock", "mail"]);

function renderIcon(name: string, size: number) {
  if (hasHIcon(name)) return <HIcon n={name} s={size} className="flex-none" />;
  return SHELL_ICONS.has(name) ? <ShellIcon name={name} size={size} className="flex-none" /> : <HIcon n="list" s={size} className="flex-none" />;
}

export function HrmsShell({
  nav,
  user,
  hat,
  notifications,
  apps,
  children,
}: {
  nav: NavGroup[];
  user: { name: string; email: string | null; phone: string | null; initials: string; role: string };
  hat: { label: string; sentence: string };
  notifications: Notification[];
  apps: AppDefinition[];
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();

  const toRow = (s: NavScreen): NavRowItem => ({ href: s.href, label: s.nav ?? s.label, icon: s.icon, exact: s.href === "/hrms" });
  const pinned: NavRowItem[] = nav.filter((g) => g.id === "home").flatMap((g) => g.screens.map((s) => toRow(s)));
  const groups: NavRowGroup[] = nav.filter((g) => g.id !== "home").map((g) => ({ label: g.label, icon: g.icon, items: g.screens.map((s) => toRow(s)) }));
  const counts = new Map(nav.flatMap((g) => g.screens.map((s) => [s.href, s.count ?? 0] as const)));
  const bottom = nav.flatMap((g) => g.screens.filter((s) => s.bottom));

  const sidebar = (
    <CollapsibleNav
      storageKey="hrms.nav.open"
      ariaLabel="HRMS sections"
      pinned={pinned}
      groups={groups}
      countFor={(item) => counts.get(item.href) ?? 0}
      railed={collapsed}
      renderIcon={renderIcon}
    />
  );

  return (
    <ToastProvider>
      <ErpUiProvider kit={HRMS_KIT}>
        <AppFrame
          floor={false}
          header={
            <header className="z-30 flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-3 lg:gap-5 lg:px-4">
              <div className="flex flex-none items-center gap-2 lg:w-[216px]">
                <button
                  onClick={() => setDrawer(true)}
                  aria-label="Menu"
                  className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[4px] border border-line text-body lg:hidden"
                >
                  <HIcon n="menu" />
                </button>
                {/* Phones get the drawer and a compact wordmark; from `lg:` up the
                    header starts with the same three controls as every app. */}
                <Link href="/hrms" className="flex items-center gap-2 no-underline hover:no-underline lg:hidden">
                  <span className="text-[15px] font-semibold tracking-[-0.01em] whitespace-nowrap text-ink">
                    MAHEK <span className="text-brand">HRMS</span>
                  </span>
                </Link>
                <div className="hidden lg:flex">
                  <HeaderLead
                    apps={apps}
                    current="hrms"
                    collapsed={collapsed}
                    onToggleSidebar={() => setCollapsed((c) => !c)}
                    href="/hrms"
                    label="MAHEK HRMS"
                  />
                </div>
              </div>
              <div className="hidden min-w-0 md:block">
                <HrmsSearch />
              </div>
              <div className="flex-1" />
              <div className="flex items-center gap-2">
                <span className="hidden sm:block">
                  <FeedbackButton />
                </span>
                <NotificationBell notifications={notifications} />
                <span className="mx-1 hidden h-6 w-px bg-divider sm:block" />
                <AccountMenu user={user} hat={hat} variant="header" />
              </div>
            </header>
          }
          sidebar={
            <aside className={cx("hidden flex-none flex-col border-r border-line bg-surface transition-[width] duration-150 lg:flex", collapsed ? "w-14" : "w-[216px]")}>
              {sidebar}
              <div className="flex flex-none items-center border-t border-divider px-2 py-2">
                <AccountMenu user={user} hat={hat} variant="sidebar" collapsed={collapsed} />
              </div>
            </aside>
          }
        >
          <div className="pb-16 lg:pb-0">{children}</div>
        </AppFrame>

        {drawer ? (
          <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-label="HRMS menu">
            <button aria-label="Close menu" onClick={() => setDrawer(false)} className="absolute inset-0 bg-[rgba(22,22,22,0.35)]" />
            <aside
              className="absolute top-0 bottom-0 left-0 flex w-[280px] flex-col overflow-y-auto bg-surface shadow-lg"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("a")) setDrawer(false);
              }}
            >
              <div className="flex h-14 flex-none items-center justify-between border-b border-divider px-4">
                <span className="text-[15px] font-semibold text-ink">
                  MAHEK <span className="text-brand">HRMS</span>
                </span>
                <AppSwitcher apps={apps} current="hrms" />
              </div>
              <div className="border-b border-divider p-3">
                <HrmsSearch />
              </div>
              {sidebar}
            </aside>
          </div>
        ) : null}

        {bottom.length ? (
          <nav aria-label="Everyday screens" className="fixed right-0 bottom-0 left-0 z-40 flex h-16 border-t border-line bg-surface lg:hidden">
            {bottom.map((b) => {
              const active = isRowActive({ href: b.href, label: b.label, icon: b.icon, exact: b.href === "/hrms" }, pathname);
              return (
                <Link
                  key={b.key}
                  href={b.href}
                  className={cx("flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium no-underline hover:no-underline", active ? "text-brand" : "text-muted")}
                >
                  <span className="relative">
                    {renderIcon(b.icon, 20)}
                    {b.count ? <span className="absolute -top-1.5 -right-2.5 rounded-full bg-warn px-1 text-[10px] leading-4 text-white">{b.count}</span> : null}
                  </span>
                  {b.short ?? b.label}
                </Link>
              );
            })}
            <button onClick={() => setDrawer(true)} className="flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted">
              <HIcon n="menu" s={20} />
              More
            </button>
          </nav>
        ) : null}
      </ErpUiProvider>
    </ToastProvider>
  );
}

/** Header search: employees, customers, documents — only what this person can open. */
function HrmsSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<HrmsSearchHit[]>([]);
  const [asked, setAsked] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setQ("");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const t = setTimeout(() => {
      void hrmsSearch(term).then((r) => {
        setHits(r);
        setAsked(term);
      });
    }, 180);
    return () => clearTimeout(t);
  }, [q]);
  const open = q.trim().length >= 2 && asked === q.trim();
  return (
    <div ref={wrapRef} className="relative w-full md:w-[340px]">
      <ShellIcon name="search" size={16} className="pointer-events-none absolute top-[9px] left-2.5 text-muted" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search people, customers, documents…"
        className="h-8.5 w-full rounded-[4px] border border-line bg-canvas pr-3 pl-8 text-sm text-ink outline-none focus:border-brand focus:bg-surface"
      />
      {open ? (
        <div className="absolute top-10 left-0 z-40 w-full overflow-hidden rounded-[6px] border border-line bg-surface py-1.5 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          {hits.length ? (
            hits.map((h) => (
              <button
                key={h.href}
                onClick={() => {
                  setQ("");
                  router.push(h.href);
                }}
                className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-[7px] text-left hover:bg-canvas"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{h.name}</span>
                  <span className="block truncate text-[13px] text-muted">{h.meta}</span>
                </span>
                <span className="flex-none text-xs text-muted">{h.kind}</span>
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-[13px] text-muted">Nothing matches “{q.trim()}”.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
