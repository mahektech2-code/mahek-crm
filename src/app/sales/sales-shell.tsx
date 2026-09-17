"use client";

import * as React from "react";
import Link from "next/link";
import { signOut } from "@/lib/actions/auth";
import { SalesIcon } from "@/components/console/icons";
import { SalesSidebarNav, type SalesCounts } from "./sidebar-nav";
import { SalesSearch } from "./search";
import { AskPanel } from "./ask-panel";

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
  alertCount,
  allowed,
  switcher,
  feedback,
  children,
}: {
  user: { name: string; title: string; initials: string };
  /** "11 salesmen · All India · 7 states" — the scope, not just the name. */
  teamLine: string;
  /** The patch in full, for `teamLine`'s hover — it prints a count past two. */
  scopeDetail: string;
  /** "6 of 11 in the field" */
  liveLine: string;
  /** Keyed by href. Only what is waiting; a zero is not drawn. */
  counts: SalesCounts;
  alertCount: number;
  allowed: string[];
  switcher: React.ReactNode;
  feedback: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen min-w-[1100px] flex-col overflow-hidden bg-canvas">
      {/* ------------------------------------------------------------ header */}
      <header className="relative z-2 flex h-14 flex-none items-center gap-4 border-b border-line bg-surface px-6">
        {/*
          THE SWITCHER SITS FIRST, BEFORE THIS APP'S OWN NAME.

          It was over on the right, tucked between the audit bell and the
          user's initials, which is where this app happened to put it and
          nowhere else does: the CRM, Accounts, HRMS and the Admin Console all
          open their header with it. The console says why in its own comment —
          moving between apps is a platform affordance rather than something
          each app decides to offer — and an affordance that moves depending on
          which app you are standing in is one people stop reaching for.

          Reading order is the argument too. Left to right, the header now says
          which app you may go to, which app you are in, and then what is in it,
          rather than opening with a name and hiding the way out beside the
          sign-out button.
        */}
        <span className="flex flex-none items-center gap-2">
          {switcher}
          <Link
            href="/sales"
            className="flex flex-none items-center gap-2 no-underline hover:no-underline"
          >
            <span className="flex h-4 w-4 flex-none items-center justify-center rounded-[3px] bg-brand">
              <span className="block h-1.5 w-1.5 rounded-[1px] bg-brand-lime" />
            </span>
            <span className="text-[15px] font-semibold whitespace-nowrap text-ink">
              MBOS <span className="text-brand">MANAGER</span>
            </span>
          </Link>
        </span>

        <span className="h-[22px] w-px flex-none bg-divider" />
        {/*
          IT SHRINKS AND TRUNCATES, and it did neither.

          `flex-none` beside `whitespace-nowrap` is a promise the bar cannot
          keep: the line is built from the manager's own patch, so its length is
          somebody's data rather than a constant, and a five-state manager got a
          string wide enough to push the search box to its minimum and the user
          chip clean off the right edge — under `overflow-hidden`, so it was cut
          rather than scrollable, and the sign-out button with it.

          `min-w-0` is the half that is easy to miss: a flex item defaults to
          `min-width: auto`, which is its content, so `truncate` alone does
          nothing here and the element goes on refusing to be smaller than its
          own text. The service keeps this short as well — both, because a
          layout that only holds while the data is polite is not a layout.
        */}
        <span
          title={scopeDetail}
          className="min-w-0 flex-initial truncate text-[13px] text-muted"
        >
          {teamLine}
        </span>

        <SalesSearch />

        <span className="flex-1" />

        {/*
          The design's tinted header button, and the drawer behind it. It sits
          before the bell and the feedback control because it is the one thing
          in the header that answers a question rather than opening a list.
        */}
        <AskPanel />

        {feedback}

        <Link
          href="/sales/audit"
          title="Every decision made here, with a name against it"
          className="flex h-8 w-8 flex-none items-center justify-center rounded-[4px] border border-line bg-surface text-muted no-underline hover:bg-canvas hover:text-body hover:no-underline"
        >
          <span className="relative flex">
            <SalesIcon name="bell" size={16} />
            {alertCount > 0 ? (
              <span className="absolute -top-[7px] -right-[7px] h-4 min-w-4 rounded-lg bg-danger px-1 text-center text-[11px] leading-4 font-medium text-white">
                {alertCount}
              </span>
            ) : null}
          </span>
        </Link>

        {/*
          THE NAME IS WHAT GIVES WAY, never the sign-out button.

          The name is data too — "Pritesh Bipin Doshi" beside a five-state role
          is wider than the two icons around it — so it is capped, truncated,
          and the full pair kept on the hover. But a capped name in a `flex-none`
          group is still a fixed width: at the shell's own 1100px floor the group
          held its 256px and the sign-out button was the thing pushed past the
          edge, which is the worst possible choice of casualty.

          So the GROUP shrinks and the two icons inside it do not. Under
          pressure the name gets narrower and the avatar, the badge and the way
          out stay exactly where they are.
        */}
        <span className="flex min-w-0 flex-initial items-center gap-2">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[4px] bg-brand-soft text-xs font-semibold text-[#5223E0]">
            {user.initials}
          </span>
          <span
            className="min-w-0 flex-initial max-w-[180px] leading-[14px]"
            title={`${user.name} — ${user.title}`}
          >
            <span className="block truncate text-[13px] font-medium text-ink">
              {user.name}
            </span>
            <span className="block truncate text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              {user.title}
            </span>
          </span>
          <form action={signOut} className="flex-none">
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
            >
              <SalesIcon name="signOut" size={16} />
            </button>
          </form>
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* --------------------------------------------------------- sidebar */}
        <aside className="flex w-[232px] flex-none flex-col border-r border-line bg-surface">
          <SalesSidebarNav allowed={allowed} counts={counts} />

          <div className="flex-none border-t border-divider px-3 py-2.5">
            <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Live now
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="block h-[7px] w-[7px] flex-none animate-pulse rounded-full bg-success" />
              <span className="text-[13px] text-ink">{liveLine}</span>
            </div>
          </div>
        </aside>

        <main className="animate-fade-in relative min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
