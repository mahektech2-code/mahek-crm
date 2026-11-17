"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AppFrame } from "@/components/shell/app-frame";
import { AccountMenu } from "@/components/shell/account-menu";
import { CollapsibleNav, type NavRowGroup, type NavRowItem } from "@/components/shell/collapsible-nav";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { Icon as ShellIcon } from "@/components/shell/icons";
import { AskPanel } from "@/components/shell/ask-panel";
import { ADMIN_ASK } from "@/components/shell/ask-setups";
import { HeaderLead } from "@/components/shell/header-lead";
import { NotificationBell } from "@/components/shell/notification-bell";
import { cx } from "@/components/ui/primitives";
import { ToastProvider } from "@/components/ui/toast";
import type { Notification } from "@/db/schema";
import type { AppDefinition } from "@/lib/apps";
import { NAV_ICON } from "./nav-icons";

/* ---------------------------------------------------------------------------
 * The Admin Console's frame: the same header and the same collapsible sidebar
 * every other MahekOne app draws.
 *
 * It had its own — a hand-drawn header with no bell, no account menu and no
 * Tell us, and a sidebar of coloured dots — so the console was the one app in
 * the suite that looked and behaved like a different product. Nothing here is
 * the console's own except the list of places and the search over them.
 *
 * AND IT IS THE ERP'S FRAME, part for part (2026-11-17). The console had drawn
 * its own sidebar — a fixed 232px column with the browser's raw scrollbar, a
 * divider under the wordmark that met nothing in the header, no way to fold
 * it — inside the 1100px desktop floor, so on a laptop or a zoomed screen it
 * was cut off and scrolled sideways. Now: the shared `CollapsibleNav`, the
 * ERP's collapse button, no floor, and the rail by itself below 1280px wide.
 * ------------------------------------------------------------------------- */

/** Below this the sidebar starts as the icon rail, as a laptop needs. */
const RAIL_BELOW = "(max-width: 1279px)";

/** The console's glyphs where it has one, the suite's (chevron, …) otherwise. */
function renderIcon(name: string, size: number) {
  const d = NAV_ICON[name];
  if (!d) return <ShellIcon name={name} size={size} className="flex-none" />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** A place somebody can search for: a screen, or one setting on one. */
export type SearchEntry = { label: string; hint: string; href: string; key?: string };

export function AdminShell({
  pinned,
  groups,
  counts,
  search,
  user,
  hat,
  notifications,
  apps,
  status,
  children,
}: {
  pinned: NavRowItem[];
  groups: NavRowGroup[];
  /** href → what is waiting there, and whether it is urgent. Only non-zero entries are drawn. */
  counts: Record<string, { n: number; urgent?: boolean }>;
  /** Every screen, setting and person this person can open. */
  search: SearchEntry[];
  user: { name: string; email: string | null; phone: string | null; initials: string; role: string };
  hat: { label: string; sentence: string };
  notifications: Notification[];
  apps: AppDefinition[];
  status: ConsoleStatus;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/admin";
  const here = activeItem(pathname, pinned, groups);
  const crumb = here ? (here.group && here.group !== here.item.label ? `${here.group} › ${here.item.label}` : here.item.label) : "Admin Console";

  /* The rail follows the window: narrow starts railed, widening opens it.
     The button overrides it until the window crosses the line again. */
  const [collapsed, setCollapsed] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia(RAIL_BELOW);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the window's width is only known after mount
    setCollapsed(mq.matches);
    const on = (e: MediaQueryListEvent) => setCollapsed(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  return (
    <ToastProvider>
      {/* The v4 look — the ERP's, the CRM's and the Sales Dashboard's. The
          marker is what styles/v4-theme.css reads; see its header. */}
      <div data-v4 data-v4-app="admin" className="contents">
        <AppFrame
          /* No 1100px floor: a laptop, a zoomed screen and a half-width window
             reflow rather than scroll sideways — the ERP's choice. */
          floor={false}
          sidebarFirst
          header={
            <header data-v4-header className="relative z-30 flex h-14 flex-none items-center gap-3 border-b border-brand-softer bg-brand-soft px-3">
              <div className="flex flex-none items-center">
                <HeaderLead
                  apps={apps}
                  current="admin"
                  collapsed={collapsed}
                  onToggleSidebar={() => setCollapsed((c) => !c)}
                  href="/admin"
                  label="MAHEK ADMIN"
                  wordmark={false}
                  switcherLabel="Admin Console"
                  toggleIcon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M4 5h16v14H4zM9 5v14" />
                    </svg>
                  }
                />
              </div>
              <span className="hidden min-w-0 flex-initial truncate text-[13px] font-medium text-[#5a4e8c] lg:inline">{crumb}</span>
              <ConsoleSearch entries={search} />
              <span className="flex-1" />
              <div className="flex flex-none items-center gap-2">
                <AskPanel setup={ADMIN_ASK} />
                {/* Below 1280px the header has a laptop's width: Feedback and the account are icons. */}
                <FeedbackButton compact className="xl:hidden" />
                <FeedbackButton className="hidden xl:flex" />
                <NotificationBell notifications={notifications} />
                <AccountMenu user={user} hat={hat} variant="header" nameFromXl />
              </div>
            </header>
          }
          sidebar={
            <aside
              className={cx(
                "flex flex-none flex-col border-r border-line bg-surface transition-[width] duration-150",
                collapsed ? "w-16" : "w-[232px]",
              )}
            >
              <Link href="/admin" title="MahekOne Admin" className="flex h-14 flex-none items-center gap-2.5 px-4 no-underline hover:no-underline">
                {/* eslint-disable-next-line @next/next/no-img-element -- a 256px static mark, nothing for the optimiser to do */}
                <img src="/brand/mahek-logo.png" alt="Mahek" width={30} height={30} className="h-7.5 w-7.5 flex-none rounded-full bg-surface object-contain" />
                {collapsed ? null : (
                  <span className="text-md font-bold tracking-tight whitespace-nowrap text-ink">
                    MahekOne <span className="font-medium text-faint">Admin</span>
                  </span>
                )}
              </Link>
              <CollapsibleNav
                storageKey="admin.nav.open"
                ariaLabel="Admin Console sections"
                pinned={pinned}
                groups={groups}
                countFor={(item) => counts[item.href]?.n ?? 0}
                railed={collapsed}
                renderIcon={renderIcon}
                badgeToneFor={(item, n) => (counts[item.href]?.urgent || n > 5 ? "danger" : "warn")}
                showSizes={false}
                flyout
              />
              {collapsed ? null : <SystemStatus status={status} />}
            </aside>
          }
        >
          {children}
        </AppFrame>
      </div>
    </ToastProvider>
  );
}

type Here = { item: NavRowItem; group: string | null };

/** The row lit for this address: the longest href or `match` prefix that fits. */
function activeItem(pathname: string, pinned: NavRowItem[], groups: NavRowGroup[]): Here | null {
  let best: Here | null = null;
  let bestLen = -1;
  const consider = (item: NavRowItem, group: string | null) => {
    const prefixes = [item.href, ...(item.match ?? [])];
    for (const pre of prefixes) {
      const hit = item.exact && pre === item.href ? pathname === pre : pathname === pre || pathname.startsWith(pre + "/") || pathname.startsWith(pre + "?");
      if (hit && pre.length > bestLen) {
        best = { item, group };
        bestLen = pre.length;
      }
    }
  };
  pinned.forEach((i) => consider(i, null));
  groups.forEach((g) => g.items.forEach((i) => consider(i, g.label)));
  return best;
}

/** The console's "Live now": how the platform stands, always at the foot. */
export type ConsoleStatus = { tone: "ok" | "warn" | "danger"; title: string; line: string };

function SystemStatus({ status }: { status: ConsoleStatus }) {
  const dot = status.tone === "ok" ? "bg-success" : status.tone === "warn" ? "bg-warn" : "bg-danger";
  const box =
    status.tone === "ok"
      ? "border-[#bfe0cb] bg-success-soft"
      : status.tone === "warn"
        ? "border-warn-line bg-warn-soft"
        : "border-danger/25 bg-danger-soft";
  const head = status.tone === "ok" ? "text-success" : status.tone === "warn" ? "text-warn-ink" : "text-danger";
  return (
    <div className={cx("m-2.5 flex-none rounded-card border px-3 py-2.5", box)}>
      <div className={cx("flex items-center gap-2 text-xs font-semibold", head)}>
        <span className={cx("block h-[7px] w-[7px] flex-none rounded-full", dot)} />
        System status
      </div>
      <div className="mt-1 text-[13px] font-medium text-ink">{status.title}</div>
      <div className="mt-0.5 text-xs text-body">{status.line}</div>
    </div>
  );
}

/**
 * Find a screen or a setting by what it is called or by its key.
 *
 * Three hundred and fifty settings across eight pages is a list nobody browses;
 * the question is almost always "where do I change the quiet window", and the
 * answer should be one search away from anywhere in the console.
 */
function ConsoleSearch({ entries }: { entries: SearchEntry[] }) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  /* ⌘K / Ctrl+K puts the cursor in the box from anywhere in the console. */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setQ("");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const needle = q.trim().toLowerCase();
  const hits = needle
    ? entries
        .filter((e) => e.label.toLowerCase().includes(needle) || e.key?.toLowerCase().includes(needle))
        .slice(0, 12)
    : [];

  function go(href: string) {
    setQ("");
    router.push(href);
  }

  return (
    <div ref={wrapRef} className="relative w-[340px] max-w-[40%] min-w-[140px] flex-initial">
      <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20 20l-4-4" />
        </svg>
      </span>
      <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded-[4px] border border-line px-[5px] py-px text-[11px] font-semibold text-muted">
        ⌘K
      </span>
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, hits.length - 1));
          if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          if (e.key === "Enter" && hits[active]) go(hits[active].href);
          if (e.key === "Escape") setQ("");
        }}
        ref={inputRef}
        placeholder="Search people, settings, jobs, screens"
        aria-label="Search people, settings, jobs and screens"
        className="h-[34px] w-full rounded-control border border-brand-softer bg-surface pr-12 pl-[30px] text-[13px] text-ink placeholder:text-muted focus:border-brand focus:bg-surface focus:outline-none"
      />
      {needle ? (
        <div className="absolute top-10 left-0 z-50 w-[460px] max-w-[calc(100vw-24px)] overflow-hidden rounded-[6px] border border-line bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]">
          {hits.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted">Nothing in the console is called that.</div>
          ) : (
            hits.map((h, i) => (
              <button
                key={h.href + (h.key ?? "")}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(h.href)}
                className={cx(
                  "flex w-full cursor-pointer flex-col items-start px-4 py-2 text-left",
                  i === active ? "bg-brand-soft" : "bg-surface",
                  i ? "border-t border-divider" : "",
                )}
              >
                <span className="text-sm font-medium text-ink">{h.label}</span>
                <span className="text-[12px] text-muted">
                  {h.hint}
                  {h.key ? <span className="ml-1.5 font-mono">{h.key}</span> : null}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
