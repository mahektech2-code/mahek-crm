"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AppFrame } from "@/components/shell/app-frame";
import { AccountMenu } from "@/components/shell/account-menu";
import type { NavRowGroup, NavRowItem } from "@/components/shell/collapsible-nav";
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
              className="relative z-30 flex h-14 flex-none items-center gap-3 border-b border-brand-softer bg-brand-soft px-4"
            >
              <HeaderLead
                apps={apps}
                current="admin"
                collapsed={false}
                onToggleSidebar={() => {}}
                href="/admin"
                label="MAHEK ADMIN"
                wordmark={false}
                switcherLabel="Admin Console"
                toggle={false}
              />
              <span className="min-w-0 flex-initial truncate text-[13px] font-medium text-[#5a4e8c]">{crumb}</span>
              <span className="flex-1" />
              <ConsoleSearch entries={search} />
              <AskPanel setup={ADMIN_ASK} boxed />
              <NotificationBell notifications={notifications} boxed />
              <AccountMenu user={user} hat={hat} variant="header" pill nameFromXl />
            </header>
          }
          sidebar={
            <aside className="flex w-[232px] flex-none flex-col border-r border-line bg-surface">
              <Link
                href="/admin"
                title="MahekOne Admin"
                className="flex h-14 flex-none items-center gap-2.5 border-b border-divider px-4 no-underline hover:no-underline"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a 256px static mark, nothing for the optimiser to do */}
                <img src="/brand/mahek-logo.png" alt="Mahek" width={30} height={30} className="h-[30px] w-[30px] flex-none rounded-full bg-surface object-contain" />
                <span className="text-[15px] font-bold tracking-[-0.01em] whitespace-nowrap text-ink">
                  MahekOne <span className="font-medium text-muted">Admin</span>
                </span>
              </Link>
              <ConsoleNav pinned={pinned} groups={groups} counts={counts} active={here?.item.href ?? null} />
              <SystemStatus status={status} />
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

const FOLD_KEY = "admin.nav.folded";

/** The canvas's sidebar: uppercase groups that fold, 34px rows, counts only where something waits. */
function ConsoleNav({
  pinned,
  groups,
  counts,
  active,
}: {
  pinned: NavRowItem[];
  groups: NavRowGroup[];
  counts: Record<string, { n: number; urgent?: boolean }>;
  active: string | null;
}) {
  const [folded, setFolded] = React.useState<string[]>([]);
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(FOLD_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the browser after mount
      if (raw) setFolded(JSON.parse(raw) as string[]);
    } catch {
      /* private window: every group open */
    }
  }, []);
  const toggle = (label: string) =>
    setFolded((f) => {
      const next = f.includes(label) ? f.filter((x) => x !== label) : [...f, label];
      try {
        window.localStorage.setItem(FOLD_KEY, JSON.stringify(next));
      } catch {
        /* not remembered, still folds */
      }
      return next;
    });

  const row = (item: NavRowItem) => {
    const on = item.href === active;
    const c = counts[item.href];
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={on ? "page" : undefined}
        className={cx(
          "flex h-[34px] items-center gap-2.5 rounded-control px-2.5 text-[13px] no-underline hover:no-underline",
          on ? "bg-brand-soft font-semibold text-brand-deep" : "font-medium text-body hover:bg-canvas",
        )}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cx("flex-none", on ? "text-brand-deep" : "text-muted")} aria-hidden>
          <path d={NAV_ICON[item.icon] ?? ""} />
        </svg>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {c && c.n > 0 ? (
          <span
            className={cx(
              "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[5px] text-[11px] font-bold",
              c.urgent || c.n > 5 ? "bg-danger text-white" : "bg-warn-soft text-warn-ink",
            )}
          >
            {c.n > 99 ? "99+" : c.n}
          </span>
        ) : null}
      </Link>
    );
  };

  return (
    <nav aria-label="Admin Console sections" className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2.5 pt-2.5 pb-3">
      {pinned.map(row)}
      {groups.map((g) => {
        const shut = folded.includes(g.label);
        return (
          <div key={g.label} className="flex flex-col gap-px">
            <button
              type="button"
              onClick={() => toggle(g.label)}
              aria-expanded={!shut}
              data-nav-group
              style={{ fontSize: 11, letterSpacing: "0.05em", lineHeight: "16px" }}
              className="flex cursor-pointer items-center justify-between px-2.5 pt-3.5 pb-[5px] text-[11px] font-semibold tracking-[0.05em] text-muted uppercase"
            >
              {g.label}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cx("transition-transform duration-100", shut && "-rotate-90")} aria-hidden>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {shut ? null : g.items.map(row)}
          </div>
        );
      })}
    </nav>
  );
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
    <div ref={wrapRef} className="relative w-[340px] max-w-[40%] min-w-0 flex-initial">
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
