"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppFrame } from "@/components/shell/app-frame";
import { AccountMenu } from "@/components/shell/account-menu";
import { CollapsibleNav, type NavRowGroup, type NavRowItem } from "@/components/shell/collapsible-nav";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { HeaderLead } from "@/components/shell/header-lead";
import { Icon } from "@/components/shell/icons";
import { NotificationBell } from "@/components/shell/notification-bell";
import { cx } from "@/components/ui/primitives";
import { ToastProvider } from "@/components/ui/toast";
import type { Notification } from "@/db/schema";
import type { AppDefinition } from "@/lib/apps";

/* ---------------------------------------------------------------------------
 * The Admin Console's frame: the same header and the same collapsible sidebar
 * every other MahekOne app draws.
 *
 * It had its own — a hand-drawn header with no bell, no account menu and no
 * Tell us, and a sidebar of coloured dots — so the console was the one app in
 * the suite that looked and behaved like a different product. Nothing here is
 * the console's own except the list of places and the search over them.
 * ------------------------------------------------------------------------- */

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
  /** href → what is waiting there. Only non-zero entries are drawn. */
  counts: Record<string, number>;
  /** Every screen and every setting this person can open. */
  search: SearchEntry[];
  user: { name: string; email: string | null; phone: string | null; initials: string; role: string };
  hat: { label: string; sentence: string };
  notifications: Notification[];
  apps: AppDefinition[];
  status: ConsoleStatus;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    <ToastProvider>
      {/* The v4 look — the ERP's, the CRM's and the Sales Dashboard's. The
          marker is what styles/v4-theme.css reads; see its header. */}
      <div data-v4 data-v4-app="admin" className="contents">
        <AppFrame
          sidebarFirst
          header={
            <header
              data-v4-header
              className="relative z-30 flex h-14 flex-none items-center gap-3 border-b border-brand-softer bg-brand-soft px-3"
            >
              <div className="flex flex-none items-center">
                <HeaderLead
                  apps={apps}
                  current="admin"
                  collapsed={collapsed}
                  onToggleSidebar={() => setCollapsed((c) => !c)}
                  href="/admin"
                  label="MAHEK ADMIN"
                  wordmark={false}
                  toggleIcon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M4 5h16v14H4zM9 5v14" />
                    </svg>
                  }
                />
              </div>
              <span className="min-w-0 flex-initial truncate text-[13px] font-medium text-[#5a4e8c]">{hat.label}</span>
              <span className="flex-1" />
              <ConsoleSearch entries={search} />
              <div className="flex flex-none items-center gap-2">
                <FeedbackButton />
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
              <Link
                href="/admin"
                title="MahekOne Admin"
                className={cx(
                  "flex h-14 flex-none items-center gap-2.5 no-underline hover:no-underline",
                  collapsed ? "justify-center" : "px-4",
                )}
              >
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
                countFor={(item) => counts[item.href] ?? 0}
                railed={collapsed}
                renderIcon={(name, size) => <Icon name={name} size={size} className="flex-none" />}
              />
              <SystemStatus status={status} collapsed={collapsed} />
            </aside>
          }
        >
          {children}
        </AppFrame>
      </div>
    </ToastProvider>
  );
}

/** The console's "Live now": how the platform stands, always at the foot. */
export type ConsoleStatus = { tone: "ok" | "warn" | "danger"; title: string; line: string };

function SystemStatus({ status, collapsed }: { status: ConsoleStatus; collapsed: boolean }) {
  const dot = status.tone === "ok" ? "bg-success" : status.tone === "warn" ? "bg-warn" : "bg-danger";
  if (collapsed) {
    return (
      <div className="flex flex-none justify-center border-t border-divider py-3" title={`${status.title} — ${status.line}`}>
        <span className={cx("block h-[7px] w-[7px] rounded-full", dot)} />
      </div>
    );
  }
  const box =
    status.tone === "ok"
      ? "border-success/25 bg-success-soft text-success"
      : status.tone === "warn"
        ? "border-warn-line bg-warn-soft text-warn-ink"
        : "border-danger/25 bg-danger-soft text-danger";
  return (
    <div className={cx("m-2 flex-none rounded-card border px-3 py-2.5", box)}>
      <div className="flex items-center gap-2 text-xs font-semibold">
        <span className={cx("block h-[7px] w-[7px] flex-none rounded-full", dot)} />
        System status
      </div>
      <div className="mt-1 text-[13px] font-medium text-ink">{status.title}</div>
      <div className="text-xs text-body">{status.line}</div>
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
    <div ref={wrapRef} className="relative w-[340px] min-w-0 flex-initial">
      <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted">
        <Icon name="search" size={16} />
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
        placeholder="Find a screen, a setting or a key"
        aria-label="Find a screen or a setting"
        className="h-9 w-full rounded-control border border-brand-softer bg-surface pr-3 pl-8 text-sm text-ink placeholder:text-muted focus:border-brand focus:bg-surface focus:outline-none"
      />
      {needle ? (
        <div className="absolute top-10 left-0 z-50 w-[460px] overflow-hidden rounded-[6px] border border-line bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]">
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
