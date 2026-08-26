"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { signOut } from "@/lib/actions/auth";
import { AccountsIcon, type AccountsIconName } from "./icons";
import { AccountsSearch } from "./accounts-search";

/* ---------------------------------------------------------------------------
 * The Accounts app's shell.
 *
 * Deliberately not the CRM's: that one carries the calling sidebar and its
 * reminder and complaint badges, and accounts have no calling book.
 *
 * Ten screens is too many for a tab bar, and they are not ten equal things:
 * three are decisions somebody is waiting on, four are ways of looking at
 * money, two are the machinery underneath. The groups say so.
 *
 * A count appears only where something is waiting — a zero beside a heading
 * reads as a problem rather than as an empty queue — and it turns red when
 * what is waiting has been waiting too long, because the number alone does not
 * say whether the desk is on top of it.
 * ------------------------------------------------------------------------- */

type Item = {
  href: string;
  label: string;
  icon: AccountsIconName;
  /** Exact match only, or the root would light up on every child route. */
  exact?: boolean;
  badge?: number;
  /** True when what is waiting has been waiting past the configured threshold. */
  urgent?: boolean;
};

export type NavCounts = {
  orders: number;
  ordersUrgent: boolean;
  payments: number;
  paymentsUrgent: boolean;
  credits: number;
};

const SHORTCUTS = [
  { what: "Move down / up the queue", key: "j · k" },
  { what: "Open the selected row", key: "Enter" },
  { what: "Approve an order · confirm a payment", key: "a" },
  { what: "Decline an order · reject a payment", key: "d" },
  { what: "Close the drawer or this sheet", key: "Esc" },
  { what: "Show this list", key: "?" },
];

export function AccountsShell({
  user,
  counts,
  allowed,
  switcher,
  feedback,
  children,
}: {
  user: { name: string; role: string; initials: string };
  counts: NavCounts;
  /**
   * The routes this person may open, resolved in the layout. The sidebar draws
   * only these; the route itself is guarded by each module's own layout, so a
   * link that is not drawn is not the only thing standing in the way.
   */
  allowed: string[];
  /** The app switcher, rendered on the server — it needs the access list. */
  switcher: React.ReactNode;
  /** The Tell us button, which sits in the header of every app. */
  feedback: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (e.key === "?" && !typing) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const all: Array<{ label: string; items: Item[] }> = [
    {
      label: "Overview",
      items: [{ href: "/accounts", label: "Today", icon: "today", exact: true }],
    },
    {
      label: "Decisions",
      items: [
        {
          href: "/accounts/approvals",
          label: "Order approvals",
          icon: "approve",
          badge: counts.orders,
          urgent: counts.ordersUrgent,
        },
        {
          href: "/accounts/payments",
          label: "Payments to confirm",
          icon: "rupee",
          badge: counts.payments,
          urgent: counts.paymentsUrgent,
        },
        {
          href: "/accounts/credits",
          label: "Credit notes",
          icon: "creditnote",
          badge: counts.credits,
        },
      ],
    },
    {
      label: "Accounts",
      items: [
        /*
         * The customer list, and the reason it is here at all.
         *
         * Changing an account manager is accounts' and admin's, and an
         * accounts user holds `apps: ["accounts"]` — the CRM layout redirects
         * them straight back out. Offering the action only on the CRM's
         * customer list would have shipped a permission nobody who holds it
         * can reach.
         */
        { href: "/accounts/customers", label: "Customers", icon: "ledger" },
        /*
         * Setting what each person is asked for in a month, and publishing it.
         *
         * Beside Customers rather than in Decisions: a target is not a queue
         * item waiting on today's word, it is a standing responsibility the
         * desk carries the way it carries who bills which account.
         */
        { href: "/accounts/targets", label: "Sales targets", icon: "target" },
      ],
    },
    {
      label: "Money",
      items: [
        { href: "/accounts/record", label: "Record a payment", icon: "plus" },
        { href: "/accounts/outstanding", label: "Outstanding", icon: "wallet" },
        { href: "/accounts/bills", label: "Bills", icon: "bill" },
        { href: "/accounts/ledger", label: "Customer account", icon: "ledger" },
        { href: "/accounts/on-account", label: "On account", icon: "onaccount" },
      ],
    },
    {
      label: "System",
      items: [
        { href: "/accounts/import", label: "Sheet import", icon: "import" },
        { href: "/accounts/audit", label: "Audit log", icon: "audit" },
      ],
    },
  ];

  const permitted = new Set(allowed);
  const groups = all
    .map((g) => ({ ...g, items: g.items.filter((i) => permitted.has(i.href)) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="flex h-screen min-w-[1000px] flex-col overflow-hidden bg-canvas">
      <header className="relative z-30 flex h-14 flex-none items-center gap-5 border-b border-line bg-surface px-4">
        <div className="flex min-w-0 flex-none items-center gap-2">
          {switcher}
          <button
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
          >
            <AccountsIcon name="menu" size={18} />
          </button>
          <Link
            href="/accounts"
            className="flex items-center gap-2 no-underline hover:no-underline"
          >
            <span className="flex h-4 w-4 flex-none items-center justify-center rounded-[3px] bg-brand">
              <span className="block h-1.5 w-1.5 rounded-[1px] bg-brand-lime" />
            </span>
            <span className="truncate text-[15px] font-semibold tracking-[-0.01em] whitespace-nowrap text-ink">
              MAHEK AC
            </span>
          </Link>
        </div>

        <AccountsSearch />

        <div className="min-w-2 flex-1" />

        <div className="flex min-w-0 flex-none items-center gap-2">
          {feedback}
          <button
            onClick={() => setShortcutsOpen(true)}
            title="Keyboard shortcuts"
            className="flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-[4px] border border-line bg-surface text-[13px] font-medium text-muted hover:bg-canvas hover:text-body"
          >
            ?
          </button>
          <span className="mx-1 h-6 w-px flex-none bg-divider" />
          <div className="flex flex-none items-center gap-2">
            <span
              title={`${user.name} · ${user.role}`}
              className="flex h-7 w-7 flex-none items-center justify-center rounded-[4px] bg-brand-soft text-xs font-semibold text-[#5223E0]"
            >
              {user.initials}
            </span>
            <span className="min-w-0 leading-[14px]">
              <span className="block text-[13px] font-medium whitespace-nowrap text-ink">
                {user.name}
              </span>
              <span className="block text-[11px] whitespace-nowrap text-muted capitalize">
                {user.role}
              </span>
            </span>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className={cx(
            "flex flex-none flex-col border-r border-line bg-surface transition-[width] duration-150 ease-[var(--ease-swift)]",
            collapsed ? "w-16" : "w-[clamp(196px,17vw,240px)]",
          )}
        >
          <nav
            aria-label="Accounts sections"
            className="flex-1 overflow-y-auto px-1.5 pt-2 pb-4"
          >
            {groups.map((group) => (
              <div key={group.label}>
                {collapsed ? (
                  <div className="mx-2 mt-2 mb-1 h-3 border-t border-divider" />
                ) : (
                  <div className="px-3 pt-3.5 pb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                    {group.label}
                  </div>
                )}
                {group.items.map((item) => {
                  const active = item.exact
                    ? pathname === item.href
                    : pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={collapsed ? item.label : undefined}
                      aria-current={active ? "page" : undefined}
                      className={cx(
                        "relative mb-px flex h-9 items-center gap-2.5 overflow-hidden rounded-[4px] border-l-[3px] text-sm whitespace-nowrap no-underline transition-colors duration-100 hover:no-underline",
                        collapsed ? "px-2.5" : "pr-2.5 pl-[9px]",
                        active
                          ? "border-l-brand font-medium text-[#5223E0]"
                          : "border-l-transparent text-body hover:bg-canvas",
                      )}
                    >
                      {active ? (
                        <span className="pointer-events-none absolute inset-0 rounded-[4px] bg-brand-soft" />
                      ) : null}
                      <AccountsIcon name={item.icon} className="relative z-1 flex-none" />
                      {collapsed ? null : (
                        <span className="relative z-1 min-w-0 flex-1 overflow-hidden text-ellipsis">
                          {item.label}
                        </span>
                      )}
                      {!collapsed && item.badge ? (
                        <span
                          className={cx(
                            "relative z-1 flex-none rounded-[9px] px-1.5 py-px text-[11px] font-medium tabular-nums",
                            item.urgent
                              ? "bg-danger-soft text-danger"
                              : "bg-brand-soft text-[#5223E0]",
                          )}
                        >
                          {item.badge}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="flex flex-none items-center gap-2.5 border-t border-divider px-3 py-2.5">
            <span className="flex h-7.5 w-7.5 flex-none items-center justify-center rounded-[4px] bg-brand-soft text-xs font-semibold text-[#5223E0]">
              {user.initials}
            </span>
            {collapsed ? null : (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-4 font-medium text-ink">
                    {user.name}
                  </span>
                  <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                    {user.role}
                  </span>
                </span>
                <form action={signOut} className="flex-none">
                  <button
                    type="submit"
                    title="Signing out records your finish time for the day"
                    aria-label="Sign out"
                    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
                  >
                    <AccountsIcon name="signout" size={16} />
                  </button>
                </form>
              </>
            )}
          </div>
        </aside>

        <main className="animate-fade-in min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>

      <Modal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        title="Keyboard shortcuts"
        width={520}
      >
        {SHORTCUTS.map((s) => (
          <div
            key={s.what}
            className="flex items-center justify-between gap-4 border-b border-canvas py-2 last:border-0"
          >
            <span className="text-sm text-body">{s.what}</span>
            <span className="flex-none rounded-[4px] border border-line bg-canvas px-2 py-0.5 font-mono text-xs text-ink">
              {s.key}
            </span>
          </div>
        ))}
      </Modal>
    </div>
  );
}
