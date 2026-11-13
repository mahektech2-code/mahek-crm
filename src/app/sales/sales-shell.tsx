"use client";

import * as React from "react";
import Link from "next/link";
import { AppFrame } from "@/components/shell/app-frame";
import { AccountMenu } from "@/components/shell/account-menu";
import { HeaderLead } from "@/components/shell/header-lead";
import { NotificationBell } from "@/components/shell/notification-bell";
import { cx } from "@/components/ui/primitives";
import type { AppDefinition } from "@/lib/apps";
import type { Notification } from "@/db/schema";
import { SalesSidebarNav, type SalesCounts } from "./sidebar-nav";
import { SalesSearch } from "./search";
import { AskPanel } from "@/components/shell/ask-panel";
import { SALES_ASK } from "@/components/shell/ask-setups";

/* ---------------------------------------------------------------------------
 * The Manager Console's shell, from `MBOS Manager Console.dc.html`.
 *
 * Forty destinations grouped on what somebody came here to DO rather than on
 * which table the data sits in: Overview is the morning, Field work and Lead
 * Management are the people, Commercial is the money, and the rest is
 * administration you visit occasionally.
 *
 * Drawn flat that is forty-seven rows and taller than the viewport, so it is
 * one pinned row and seven collapsed groups now — and the sidebar moved to
 * `./sidebar-nav.tsx` with the store that was here. The shell holds the
 * header, the frame and Live now, none of which has any business redrawing
 * because somebody opened People.
 *
 * The list itself is `./nav.ts`, which says why it is data rather than written
 * out here: it is a second copy of the module registry, and it had drifted by
 * four screens.
 *
 * Three things the design does that are worth naming, because each is easy to
 * lose in a port:
 *
 * **A count appears only where something is waiting**, and it is red past five
 * and amber below. A zero beside a heading reads as a problem rather than as an
 * empty queue.
 *
 * **The header carries the scope, not just the name.** "11 salesmen · All India
 * · 7 states" is how a regional manager knows at a glance that they are looking
 * at their own patch and not somebody else's.
 *
 * **"Live now" sits at the bottom of the sidebar, always.** It is the one fact
 * a field manager wants without navigating, and the pulsing dot is the only
 * animation in the whole console.
 * ------------------------------------------------------------------------- */

export type { SalesCounts };

export function SalesShell({
  user,
  teamLine,
  scopeDetail,
  liveLine,
  counts,
  notifications,
  allowed,
  apps,
  feedback,
  children,
}: {
  /**
   * `title` is the LEVEL held on this app — see `lib/hat-labels.ts`.
   *
   * It used to be a sentence derived from the SCOPE: "National sales manager",
   * or "Maharashtra sales manager". That is not a level, is stored nowhere, and
   * is a job title the company does not issue — an associate granted this app
   * was greeted as a national manager. The scope has not been lost: the team
   * line beside the wordmark has said "11 salesmen · All India · 7 regions"
   * all along, which is the same fact without the invented rank.
   */
  user: { name: string; email: string | null; phone: string | null; role: string; title: string; titleSentence: string; initials: string };
  /** "11 salesmen · All India · 7 states" — the scope, not just the name. */
  teamLine: string;
  /** The patch in full, for `teamLine`'s hover — it prints a count past two. */
  scopeDetail: string;
  /** "6 of 11 in the field" */
  liveLine: string;
  /** Keyed by href. Only what is waiting; a zero is not drawn. */
  counts: SalesCounts;
  /** The signed-in person's own notifications — the same box every app draws. */
  notifications: Notification[];
  allowed: string[];
  /** Every web app this person opens, for the switcher — drawn always. */
  apps: AppDefinition[];
  feedback: React.ReactNode;
  children: React.ReactNode;
}) {
  /* The sidebar narrows to an icon rail; the toggle is HeaderLead's ☰. */
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    /*
     * THE ERP'S FRAME, SHARED (Nov 2026). `data-v4` is what
     * `styles/v4-theme.css` answers to, and `data-v4-app="sales"` is what puts
     * this app's spaced-capital labels into sentence case, as the CRM's are.
     * The sidebar runs the full height under the Mahek mark; the lavender
     * header beside it carries the switcher, the scope, the search, Ask, the
     * bell and the account — the same order the ERP, the CRM and Tasks use.
     */
    <div data-v4 data-v4-app="sales" className="contents">
    <AppFrame
      /*
       * THE ONE APP THAT BLEEDS. Live tracking and Territory are maps, and a
       * map is the case where wider genuinely is better — every other screen
       * in the suite stops at `--container-measure` so its cards and its prose
       * do not stretch across a 1920 monitor.
       */
      bleed
      sidebarFirst
      header={
        <header data-v4-header className="relative z-30 flex h-14 flex-none items-center gap-3 border-b border-brand-softer bg-brand-soft px-3">
          {/* The switcher first, as in every app: which app you may go to,
              then what is in this one. The wordmark is atop the sidebar. */}
          <div className="flex flex-none items-center">
            <HeaderLead
              apps={apps}
              current="sales"
              collapsed={collapsed}
              onToggleSidebar={() => setCollapsed((c) => !c)}
              href="/sales"
              label="MBOS MANAGER"
              wordmark={false}
              toggleIcon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 5h16v14H4zM9 5v14" />
                </svg>
              }
            />
          </div>

          {/*
            THE SCOPE SHRINKS AND TRUNCATES. It is built from the manager's own
            patch, so its length is data; `min-w-0` is what lets `truncate` work
            on a flex item at all, and the full patch is on the hover.
          */}
          <span title={scopeDetail} className="min-w-0 flex-initial truncate text-[13px] font-medium text-[#5a4e8c]">
            {teamLine}
          </span>

          <SalesSearch />

          <span className="flex-1" />

          <div className="flex flex-none items-center gap-2">
            <AskPanel setup={SALES_ASK} />
            {feedback}
            {/* The bell is the notification box, as in every app — the
                waiting queues are badged in the sidebar. */}
            <NotificationBell notifications={notifications} />
            {/* The account menu is the way out, as in the ERP: the name and
                level are inside it, the header shows the avatar alone. */}
            <AccountMenu user={user} hat={{ label: user.title, sentence: user.titleSentence }} variant="header" nameFromXl />
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
            href="/sales"
            title="MahekOne Sales"
            className={cx("flex h-14 flex-none items-center gap-2.5 no-underline hover:no-underline", collapsed ? "justify-center" : "px-4")}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- a 256px static mark, nothing for the optimiser to do */}
            <img src="/brand/mahek-logo.png" alt="Mahek" width={30} height={30} className="h-7.5 w-7.5 flex-none rounded-full bg-surface object-contain" />
            {collapsed ? null : (
              <span className="text-md font-bold tracking-tight whitespace-nowrap text-ink">
                MahekOne <span className="font-medium text-faint">Sales</span>
              </span>
            )}
          </Link>

          <SalesSidebarNav allowed={allowed} counts={counts} railed={collapsed} />

          {/* "Live now" sits at the foot, always. Railed, it keeps only its
              pulsing dot; the line is on hover. */}
          {collapsed ? (
            <div className="flex flex-none justify-center border-t border-divider py-3" title={`Live now — ${liveLine}`}>
              <span className="block h-[7px] w-[7px] animate-pulse rounded-full bg-success" />
            </div>
          ) : (
            <div className="m-2 flex-none rounded-card border border-success/25 bg-success-soft px-3 py-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-success">
                <span className="block h-[7px] w-[7px] flex-none animate-pulse rounded-full bg-success" />
                Live now
              </div>
              <div className="mt-1 text-[13px] font-medium text-ink">{liveLine}</div>
            </div>
          )}
        </aside>
      }
    >
      {children}
    </AppFrame>
    </div>
  );
}
