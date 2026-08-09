"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui/primitives";

/**
 * The accounts workspace has four questions in it, and they are four screens
 * rather than one screen with state: each is entered directly, bookmarked,
 * and reloaded on its own. A badge appears only where something is waiting —
 * a zero beside a tab reads as a problem rather than as an empty queue.
 */
const TABS = [
  { href: "/orders", label: "Order approvals", exact: true },
  { href: "/orders/payments", label: "Payments to confirm" },
  { href: "/orders/record", label: "Record a payment" },
  { href: "/orders/ledger", label: "Customer account" },
];

export function OrdersNav({
  pendingOrders,
  pendingPayments,
}: {
  pendingOrders: number;
  pendingPayments: number;
}) {
  const pathname = usePathname();
  const counts: Record<string, number> = {
    "/orders": pendingOrders,
    "/orders/payments": pendingPayments,
  };

  return (
    <nav
      aria-label="Accounts sections"
      className="flex flex-none items-center gap-1 border-b border-line bg-surface px-4"
    >
      {TABS.map((tab) => {
        const active = tab.exact
          ? pathname === tab.href
          : pathname.startsWith(tab.href);
        const count = counts[tab.href] ?? 0;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-[13px] transition-colors",
              active
                ? "border-brand font-medium text-ink"
                : "border-transparent text-muted hover:text-ink",
            )}
          >
            {tab.label}
            {count > 0 ? (
              <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[11px] font-medium text-brand tabular-nums">
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
