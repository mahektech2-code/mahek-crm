"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { AccountMenu } from "@/components/shell/account-menu";
import { Icon } from "@/components/shell/icons";
import { NotificationBell } from "@/components/shell/notification-bell";
import { cx } from "@/components/ui/primitives";
import type { SidebarCounts } from "@/lib/sales-lead-pipeline/types";
import { pipelineLinks } from "@/lib/sales-lead-pipeline/workspace";
import { PROTO_FONT } from "./ui";

/* ---------------------------------------------------------------------------
 * THE SALES MANAGER WORKSPACE'S OWN FRAME, inside the CRM's.
 *
 * The prototype is an app of its own: a 56px bar (wordmark, lead search, bell,
 * avatar) over a 200px sidebar of seven links, and the four screens draw in the
 * space beside it. The CRM still owns the page — sign-in, its header, its
 * sidebar and its toasts are all around this — so what is drawn here is the
 * prototype's frame INSIDE the CRM's content area, not instead of it.
 *
 * (The prototype's "Viewing as" role switcher and phone preview are how one
 * mock showed five roles. They are not part of a Sales Manager's workspace and
 * are deliberately absent.)
 *
 * Counts arrive from the layout, counted in SQL by the same scope the pages
 * use — a sidebar number and the list it opens cannot disagree.
 * ------------------------------------------------------------------------- */

type NavDef = { key: string; href: string; icon: string; label: string; count?: number; danger?: boolean };

export function SalesManagerShell({
  user,
  hat,
  notifications,
  counts,
  children,
}: {
  user: React.ComponentProps<typeof AccountMenu>["user"];
  hat: React.ComponentProps<typeof AccountMenu>["hat"];
  notifications: React.ComponentProps<typeof NotificationBell>["notifications"];
  counts: SidebarCounts;
  children: React.ReactNode;
}) {
  const links = pipelineLinks("crm");
  const base = links.base;
  const pathname = usePathname() ?? "";
  const router = useRouter();

  const groups: { label: string; items: NavDef[] }[] = [
    {
      label: "Workspace",
      items: [
        { key: "dashboard", href: base, icon: "dashboard", label: "Dashboard" },
        { key: "pipeline", href: `${base}/pipeline`, icon: "chart", label: "Pipeline" },
        { key: "list", href: `${base}/list`, icon: "grid", label: "All Leads", count: counts.all },
      ],
    },
    {
      label: "My work · Sales Manager",
      items: [
        { key: "today", href: `${base}/today`, icon: "clock", label: "Today's actions", count: counts.today },
        { key: "overdue", href: `${base}/overdue`, icon: "alert", label: "Overdue", count: counts.overdue, danger: true },
        { key: "mine", href: `${base}/mine`, icon: "target", label: "My leads", count: counts.mine },
      ],
    },
    {
      label: "Reference",
      items: [{ key: "distributors", href: `${base}/distributors`, icon: "people", label: "Distributors" }],
    },
  ];

  const activeKey = (() => {
    if (pathname === base) return "dashboard";
    const rest = pathname.slice(base.length + 1).split("/")[0];
    return ["pipeline", "list", "today", "overdue", "mine", "distributors"].includes(rest) ? rest : "";
  })();

  const [q, setQ] = React.useState("");

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-[14px] leading-5 text-body" style={{ fontFamily: PROTO_FONT }}>
      {/* .topbar */}
      <div className="flex h-14 flex-none items-center gap-4 border-b border-line bg-surface px-4">
        <Link href={base} className="flex flex-none items-center gap-2">
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-brand">
            <i className="block h-1.5 w-1.5 rounded-[1px] bg-brand-lime" />
          </span>
          <span className="text-[15px] font-[650] tracking-[-0.01em] whitespace-nowrap text-ink">
            MAHEK <b className="text-brand">LEADS</b>
          </span>
        </Link>
        <form
          className="hidden h-8 max-w-[360px] flex-1 items-center gap-2 rounded-[4px] border border-line bg-canvas px-2.5 text-muted sm:flex"
          onSubmit={(e) => {
            e.preventDefault();
            const term = q.trim();
            router.push(term ? `${base}/list?q=${encodeURIComponent(term)}` : `${base}/list`);
          }}
        >
          <Icon name="search" size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search leads, customers, distributors…"
            aria-label="Search leads"
            className="flex-1 border-none bg-transparent text-[13px] text-ink outline-none"
          />
        </form>
        <div className="ml-auto flex flex-none items-center gap-2.5">
          <NotificationBell notifications={notifications} />
          {/* The CRM's own account menu — the avatar, who this person is here, password and sign-out. */}
          <AccountMenu user={user} hat={hat} variant="header" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* .sidebar */}
        <aside className="flex-none border-b border-line bg-surface px-2.5 py-3 md:sticky md:top-0 md:max-h-screen md:w-[200px] md:self-start md:overflow-y-auto md:border-r md:border-b-0">
          {groups.map((g, gi) => (
            <div key={g.label}>
              <div className={cx("px-2.5 pb-1.5 text-[10.5px] font-[650] tracking-[0.05em] text-[#8890a0] uppercase", gi === 0 ? "pt-1" : "pt-3")}>
                {g.label}
              </div>
              {g.items.map((it) => {
                const active = activeKey === it.key;
                return (
                  <Link
                    key={it.key}
                    href={it.href}
                    className={cx(
                      "mb-0.5 flex h-[34px] items-center gap-2.5 rounded-[5px] px-2.5 text-[13.5px]",
                      active ? "bg-brand-soft font-semibold text-[#5223e0]" : "text-body hover:bg-canvas hover:text-ink",
                    )}
                  >
                    <Icon name={it.icon as never} size={17} />
                    <span>{it.label}</span>
                    {it.count ? (
                      <span
                        className={cx(
                          "ml-auto min-w-4 rounded-lg px-1.5 py-px text-center text-[10.5px] font-bold",
                          it.danger ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn-ink",
                        )}
                      >
                        {it.count}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          ))}
          <div className="mt-3 border-t border-divider pt-2">
            <Link href="/crm/dashboard" className="mb-0.5 flex h-[34px] items-center gap-2.5 rounded-[5px] px-2.5 text-[13.5px] text-body hover:bg-canvas hover:text-ink">
              <span aria-hidden>←</span>
              <span>Back to CRM</span>
            </Link>
          </div>
        </aside>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
