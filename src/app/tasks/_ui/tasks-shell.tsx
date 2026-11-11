"use client";

import { useState } from "react";
import Link from "next/link";
import { AppFrame } from "@/components/shell/app-frame";
import { AccountMenu } from "@/components/shell/account-menu";
import { HeaderLead } from "@/components/shell/header-lead";
import { CollapsibleNav, type NavRowGroup, type NavRowItem } from "@/components/shell/collapsible-nav";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { Icon } from "@/components/shell/icons";
import { NotificationBell } from "@/components/shell/notification-bell";
import { cx } from "@/components/ui/primitives";
import { ToastProvider } from "@/components/ui/toast";
import type { Notification } from "@/db/schema";
import type { AppDefinition } from "@/lib/apps";

/* ---------------------------------------------------------------------------
 * The Tasks app's shell — the ERP's and the CRM's frame, so somebody moving
 * between them learns one layout: the sidebar runs the full height under the
 * Mahek mark, the lavender header beside it carries the switcher, the bell and
 * the account. `data-v4` is what styles/v4-theme.css answers to.
 * ------------------------------------------------------------------------- */

export type TasksNav = { pinned: NavRowItem[]; groups: NavRowGroup[] };

export function TasksShell({
  nav,
  counts,
  user,
  hat,
  notifications,
  apps,
  children,
}: {
  nav: TasksNav;
  /** Each row's count, by href — late ones are red, everything else amber. */
  counts: Record<string, { n: number; late?: boolean }>;
  user: { name: string; email: string | null; phone: string | null; initials: string; role: string };
  hat: { label: string; sentence: string };
  notifications: Notification[];
  apps: AppDefinition[];
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <ToastProvider>
      <div data-v4 className="contents">
        <AppFrame
          floor={false}
          sidebarFirst
          header={
            <header data-v4-header className="z-30 flex h-14 flex-none items-center gap-3 border-b border-brand-softer bg-brand-soft px-3">
              <div className="flex flex-none items-center">
                <HeaderLead
                  apps={apps}
                  current="tasks"
                  collapsed={collapsed}
                  onToggleSidebar={() => setCollapsed((c) => !c)}
                  href="/tasks"
                  label="MAHEK TASKS"
                  wordmark={false}
                  toggleIcon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M4 5h16v14H4zM9 5v14" />
                    </svg>
                  }
                />
              </div>
              <div className="flex-1" />
              <div className="flex flex-none items-center gap-2">
                <FeedbackButton compact className="xl:hidden" />
                <FeedbackButton className="hidden xl:flex" />
                <NotificationBell notifications={notifications} />
                <AccountMenu user={user} hat={hat} variant="header" nameFromXl />
              </div>
            </header>
          }
          sidebar={
            <aside className={cx("flex flex-none flex-col border-r border-line bg-surface transition-[width] duration-150", collapsed ? "w-16" : "w-[232px]")}>
              <Link href="/tasks" title="MahekOne Tasks" className="flex h-14 flex-none items-center gap-2.5 px-4 no-underline hover:no-underline">
                {/* eslint-disable-next-line @next/next/no-img-element -- a 256px static mark, nothing for the optimiser to do */}
                <img src="/brand/mahek-logo.png" alt="Mahek" width={30} height={30} className="h-7.5 w-7.5 flex-none rounded-full bg-surface object-contain" />
                {collapsed ? null : (
                  <span className="text-md font-bold tracking-tight whitespace-nowrap text-ink">
                    MahekOne <span className="font-medium text-faint">Tasks</span>
                  </span>
                )}
              </Link>
              <CollapsibleNav
                storageKey="tasks.nav.open"
                ariaLabel="Tasks sections"
                pinned={nav.pinned}
                groups={nav.groups}
                countFor={(item) => counts[item.href]?.n ?? 0}
                railed={collapsed}
                renderIcon={(name, size) => <Icon name={name} size={size} className="flex-none" />}
                badgeToneFor={(item) => (counts[item.href]?.late ? "danger" : "warn")}
                showSizes={false}
              />
            </aside>
          }
        >
          {children}
        </AppFrame>
      </div>
    </ToastProvider>
  );
}
