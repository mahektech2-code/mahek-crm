"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppFrame } from "@/components/shell/app-frame";
import { AccountMenu } from "@/components/shell/account-menu";
import { CollapsibleNav, type NavRowGroup, type NavRowItem } from "@/components/shell/collapsible-nav";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { HeaderLead } from "@/components/shell/header-lead";
import { NotificationBell } from "@/components/shell/notification-bell";
import { cx } from "@/components/ui/primitives";
import type { Notification } from "@/db/schema";
import type { AppDefinition } from "@/lib/apps";
import { DensityProvider, LockerOverlays, Segmented } from "./kit";
import { LkIcon } from "./icons";

/* ---------------------------------------------------------------------------
 * THE LOCKER'S SHELL — the ERP's frame, as the Studio and Tasks draw it: the
 * sidebar runs the full height under the Mahek mark, the lavender header
 * beside it carries the switcher, the Locker's search, the density switch,
 * the bell and the account. `data-v4` is what styles/v4-theme.css answers to,
 * so every colour, radius and type size here is the ERP's.
 * ------------------------------------------------------------------------- */

export type LockerNav = { groups: NavRowGroup[] };

type Hit = { href: string; name: string; meta: string };
type HitGroup = { label: string; vault?: boolean; items: Hit[] };

export function LockerShell({
  nav,
  counts,
  user,
  hat,
  apps,
  notifications,
  vault,
  banner,
  children,
}: {
  nav: LockerNav;
  /** Each row's count, by href — overdue ones red, everything else amber. */
  counts: Record<string, { n: number; over?: boolean }>;
  user: { name: string; email: string | null; phone: string | null; initials: string; role: string; title: string };
  hat: { label: string; sentence: string };
  apps: AppDefinition[];
  notifications: Notification[];
  vault: boolean;
  /** Emergency access in force: the red bar everybody sees. */
  banner: { line: string } | null;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<HitGroup[] | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    try {
      /* eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the browser's own storage, which the server cannot see */
      if (localStorage.getItem("lk.density") === "compact") setDensity("compact");
    } catch {
      /* private window: the default stands */
    }
    const onKey = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement | null)?.tagName;
      if (e.key === "/" && t !== "INPUT" && t !== "TEXTAREA" && t !== "SELECT") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") setQ("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/locker/search?q=${encodeURIComponent(needle)}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : { groups: [] }))
        .then((j: { groups: HitGroup[] }) => setHits(j.groups))
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  const open = q.trim().length >= 2;

  return (
    <LockerOverlays>
      <DensityProvider value={density}>
        <div data-v4 className="contents">
          <AppFrame
            floor={false}
            sidebarFirst
            header={
              <header data-v4-header className="z-30 flex h-14 flex-none items-center gap-3 border-b border-brand-softer bg-brand-soft px-3">
                <div className="flex flex-none items-center">
                  <HeaderLead
                    apps={apps}
                    current="locker"
                    collapsed={collapsed}
                    onToggleSidebar={() => setCollapsed((c) => !c)}
                    href="/locker"
                    label="MAHEK LOCKER"
                    wordmark={false}
                    toggleIcon={
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M4 5h16v14H4zM9 5v14" />
                      </svg>
                    }
                  />
                </div>
                <div className="relative ml-2 w-full max-w-[420px] min-w-[160px]">
                  <span className="pointer-events-none absolute top-1/2 left-2.5 flex -translate-y-1/2 text-muted">
                    <LkIcon name="search" />
                  </span>
                  <input
                    ref={searchRef}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={vault ? "Search assets, logins…   /" : "Search assets…   /"}
                    aria-label="Search the Locker"
                    className="ui-control h-8.5 w-full rounded-control border border-line bg-surface pr-3 pl-8 text-sm text-ink outline-none focus:border-brand"
                  />
                  {open ? (
                    <div className="absolute top-10 right-0 left-0 z-40 overflow-hidden rounded-card border border-line bg-surface shadow-[0_8px_24px_rgba(15,27,51,0.12)]">
                      {(hits ?? []).map((g) => (
                        <div key={g.label}>
                          <div className="bg-page px-3 pt-2 pb-1 text-2xs font-medium tracking-label text-muted uppercase">{g.label}</div>
                          {g.items.map((r) => (
                            <button
                              key={r.href}
                              type="button"
                              onClick={() => {
                                setQ("");
                                setHits(null);
                                router.push(r.href);
                              }}
                              className="flex w-full cursor-pointer items-center gap-2.5 border-t border-divider px-3 py-2 text-left hover:bg-canvas"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-ink">{r.name}</span>
                                <span className="block text-xs text-muted">{r.meta}</span>
                              </span>
                            </button>
                          ))}
                        </div>
                      ))}
                      {hits && !hits.length ? <div className="px-3 py-3.5 text-[13px] text-muted">Nothing you can open matches “{q}”.</div> : null}
                      {!hits ? <div className="px-3 py-3.5 text-[13px] text-muted">Searching…</div> : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex-1" />
                <div className="flex flex-none items-center gap-2">
                  <span className="hidden lg:inline-flex">
                    <Segmented
                      dark
                      opts={[
                        { key: "comfortable", label: "Comfortable" },
                        { key: "compact", label: "Compact" },
                      ]}
                      value={density}
                      onPick={(k) => {
                        try {
                          localStorage.setItem("lk.density", k);
                        } catch {}
                        setDensity(k);
                      }}
                    />
                  </span>
                  <FeedbackButton compact className="xl:hidden" />
                  <FeedbackButton className="hidden xl:flex" />
                  <NotificationBell notifications={notifications} />
                  <AccountMenu user={user} hat={hat} variant="header" nameFromXl />
                </div>
              </header>
            }
            sidebar={
              <aside className={cx("flex flex-none flex-col border-r border-line bg-surface transition-[width] duration-150", collapsed ? "w-16" : "w-[232px]")}>
                <Link href="/locker" title="MahekOne Locker" className="flex h-14 flex-none items-center gap-2.5 px-4 no-underline hover:no-underline">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a 256px static mark, nothing for the optimiser to do */}
                  <img src="/brand/mahek-logo.png" alt="Mahek" width={30} height={30} className="h-7.5 w-7.5 flex-none rounded-full bg-surface object-contain" />
                  {collapsed ? null : (
                    <span className="text-md font-bold tracking-tight whitespace-nowrap text-ink">
                      MahekOne <span className="font-medium text-faint">Locker</span>
                    </span>
                  )}
                </Link>
                <CollapsibleNav
                  storageKey="locker.nav.open"
                  ariaLabel="Locker sections"
                  groups={nav.groups}
                  countFor={(item: NavRowItem) => counts[item.href]?.n ?? 0}
                  railed={collapsed}
                  flyout
                  renderIcon={(name, size) => <LkIcon name={name} size={size} />}
                  badgeToneFor={(item) => (counts[item.href]?.over ? "danger" : "warn")}
                  showSizes={false}
                />
              </aside>
            }
          >
            {banner ? (
              <div className="flex h-10 flex-none items-center gap-3 bg-danger px-6 text-[13px] font-medium text-white">
                <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
                <span className="min-w-0 flex-1 truncate">{banner.line}</span>
                <Link href="/locker/emergency" className="flex h-7 items-center rounded-control border border-white/60 px-3 text-[13px] font-medium text-white no-underline hover:no-underline">
                  View emergency access
                </Link>
              </div>
            ) : null}
            <div id="lk-main" className="min-w-0">
              {children}
            </div>
          </AppFrame>
        </div>
      </DensityProvider>
    </LockerOverlays>
  );
}
