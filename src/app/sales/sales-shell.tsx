"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { signOut } from "@/lib/actions/auth";
import { SalesIcon, type SalesIconName } from "./icons";
import { AskPanel } from "./ask-panel";

/* ---------------------------------------------------------------------------
 * The Manager Console's shell, from `MBOS Manager Console.dc.html`.
 *
 * Twenty-four destinations in six groups. That is a lot of sidebar, and the
 * design earns it by grouping on what somebody came here to DO rather than on
 * which table the data sits in: Overview is the morning, Field work is the
 * people, Commercial is the money, and the rest is administration you visit
 * occasionally.
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

type Item = {
  href: string;
  label: string;
  icon: SalesIconName;
  exact?: boolean;
  count?: number;
};

/**
 * The navigation, in the design's own order and words.
 *
 * Drawn from this list and filtered through `app_module_access`, so a module
 * somebody does not hold is not drawn — and its route redirects anyway, since
 * a link that is not drawn is a statement to the browser and the browser is not
 * where authority lives.
 */
const NAV: Array<{ label: string; items: Item[] }> = [
  {
    label: "Overview",
    items: [
      { href: "/sales", label: "Today", icon: "home", exact: true },
      { href: "/sales/live", label: "Live map", icon: "pin" },
      { href: "/sales/territory", label: "Territory", icon: "grid" },
      { href: "/sales/performance", label: "Performance", icon: "chart" },
      { href: "/sales/targets", label: "Sales Targets", icon: "target" },
    ],
  },
  {
    label: "Field work",
    items: [
      { href: "/sales/tasks", label: "Tasks", icon: "task" },
      { href: "/sales/journeys", label: "Journey planning", icon: "route" },
      { href: "/sales/visits", label: "Visits", icon: "visit" },
      { href: "/sales/leads", label: "Leads", icon: "spark" },
    ],
  },
  {
    label: "Commercial",
    items: [
      { href: "/sales/orders", label: "Orders", icon: "order" },
      { href: "/sales/payments", label: "Payments", icon: "money" },
      { href: "/sales/invoices", label: "Invoices", icon: "doc" },
      { href: "/sales/samples", label: "Samples", icon: "sample" },
      { href: "/sales/catalogue", label: "Catalogue & rates", icon: "grid" },
    ],
  },
  {
    label: "People",
    items: [
      { href: "/sales/attendance", label: "Attendance", icon: "clock" },
      { href: "/sales/leave", label: "Leave", icon: "cal" },
      { href: "/sales/holidays", label: "Holidays", icon: "cal" },
      { href: "/sales/salary", label: "Salary", icon: "money" },
      { href: "/sales/expenses", label: "Expenses & claims", icon: "receipt" },
    ],
  },
  {
    label: "Enablement",
    items: [
      { href: "/sales/documents", label: "Documents", icon: "doc" },
      { href: "/sales/knowledge", label: "Knowledge", icon: "book" },
    ],
  },
  {
    label: "Administration",
    items: [
      { href: "/sales/people", label: "Salesmen", icon: "people" },
      { href: "/sales/prefs", label: "App preferences", icon: "sliders" },
      { href: "/sales/logins", label: "Login history", icon: "shield" },
      { href: "/sales/audit", label: "Audit trail", icon: "list" },
    ],
  },
];

export type SalesCounts = Partial<Record<string, number>>;

export function SalesShell({
  user,
  teamLine,
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
  const pathname = usePathname();
  const permitted = new Set(allowed);

  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => permitted.has(i.href)),
  })).filter((g) => g.items.length > 0);

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
        <span className="flex-none text-[13px] whitespace-nowrap text-muted">{teamLine}</span>

        <span className="relative max-w-[380px] min-w-[160px] flex-[1_1_320px]">
          <span className="pointer-events-none absolute top-[9px] left-2.5 flex text-muted">
            <SalesIcon name="search" size={16} />
          </span>
          <input
            placeholder="Search a salesman, customer, order or bill"
            className="h-8.5 w-full rounded-[4px] border border-line bg-canvas pr-3 pl-8 text-sm text-ink outline-none focus:border-brand focus:bg-surface"
          />
        </span>

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

        <span className="flex flex-none items-center gap-2">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[4px] bg-brand-soft text-xs font-semibold text-[#5223E0]">
            {user.initials}
          </span>
          <span className="leading-[14px]">
            <span className="block text-[13px] font-medium whitespace-nowrap text-ink">
              {user.name}
            </span>
            <span className="block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
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
              <SalesIcon name="close" size={16} />
            </button>
          </form>
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* --------------------------------------------------------- sidebar */}
        <aside className="flex w-[232px] flex-none flex-col border-r border-line bg-surface">
          <nav
            aria-label="Manager Console sections"
            className="flex-1 overflow-y-auto px-1.5 pt-2 pb-4"
          >
            {groups.map((group) => (
              <div key={group.label}>
                <div className="px-3 pt-3.5 pb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  {group.label}
                </div>
                {group.items.map((item) => {
                  const active = item.exact
                    ? pathname === item.href
                    : pathname === item.href || pathname.startsWith(item.href + "/");
                  const count = counts[item.href] ?? 0;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cx(
                        "relative mb-px flex min-h-9 items-center gap-2.5 rounded-[4px] border-l-[3px] pr-2.5 pl-[9px] text-sm whitespace-nowrap no-underline hover:no-underline",
                        active
                          ? "border-l-brand font-medium text-[#5223E0]"
                          : "border-l-transparent text-body hover:bg-canvas",
                      )}
                    >
                      {active ? (
                        <span className="pointer-events-none absolute inset-0 rounded-[4px] bg-brand-soft" />
                      ) : null}
                      <span className="relative z-1 flex flex-none">
                        <SalesIcon name={item.icon} size={18} />
                      </span>
                      <span className="relative z-1 min-w-0 flex-1 overflow-hidden text-ellipsis">
                        {item.label}
                      </span>
                      {count > 0 ? (
                        <span
                          className={cx(
                            "relative z-1 h-[18px] min-w-5 flex-none rounded-[9px] px-1.5 text-center text-[11px] leading-[18px] font-medium tabular-nums",
                            /* Red past five, amber below. The number alone does
                             * not say whether anybody is on top of it. */
                            count >= 5
                              ? "bg-danger-soft text-danger"
                              : "bg-warn-line text-warn-ink",
                          )}
                        >
                          {count}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>

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
