"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { AccountMenu } from "@/components/shell/account-menu";
import { Icon } from "@/components/shell/icons";
import { NotificationBell } from "@/components/shell/notification-bell";
import { pipelineLinks } from "@/lib/sales-lead-pipeline/workspace";
import { PROTO_FONT } from "../proto/ui";

/* ---------------------------------------------------------------------------
 * THE SALES MANAGER WORKSPACE'S OWN BAR — and nothing beside it.
 *
 * The prototype draws a 56px bar (wordmark, lead search, bell, avatar); the
 * screens draw underneath. The CRM's own header and sidebar are not drawn on
 * this route (`app/crm/layout.tsx`), so this bar is the only navigation chrome
 * here. There is NO sidebar: the other views are reached from the dashboard's
 * tiles, funnel and buttons, and from the list.
 *
 * (The prototype's "Viewing as" role switcher and phone preview are how one
 * mock showed five roles. They are not part of a Sales Manager's workspace and
 * are deliberately absent.)
 * ------------------------------------------------------------------------- */

export function SalesManagerShell({
  user,
  hat,
  notifications,
  children,
}: {
  user: React.ComponentProps<typeof AccountMenu>["user"];
  hat: React.ComponentProps<typeof AccountMenu>["hat"];
  notifications: React.ComponentProps<typeof NotificationBell>["notifications"];
  children: React.ReactNode;
}) {
  const base = pipelineLinks("crm").base;
  const router = useRouter();
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
            router.push(term ? `${base}?q=${encodeURIComponent(term)}` : base);
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

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
