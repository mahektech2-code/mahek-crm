"use client";

import * as React from "react";
import { Card, EmptyState, MetricStrip, PageHeader } from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/overlays";
import { OrderThread } from "@/components/orders/order-journey";
import { MY_ORDERS_TABS, tabOf, type MyOrdersTab } from "@/lib/order-journey";
import type { OrderRow } from "@/lib/services/order-journey-service";

/**
 * TELECRM · MY ORDERS. The orders this telecaller took on a call, by where
 * each one is: still a TO being checked, held or sent back, with accounts, on
 * its way, or done. A TO she took can be changed or cancelled from its row
 * until it has its order number; after that it is read only.
 */
export function MyOrdersScreen({ rows }: { rows: OrderRow[] }) {
  const buckets = React.useMemo(() => {
    const out: Record<MyOrdersTab, OrderRow[]> = { to: [], hold: [], accounts: [], moving: [], done: [] };
    for (const r of rows) out[tabOf(r.journey)].push(r);
    return out;
  }, [rows]);
  const first = (MY_ORDERS_TABS.find((t) => buckets[t.key].length && t.key !== "done")?.key ?? "to") as MyOrdersTab;
  const [tab, setTab] = React.useState<MyOrdersTab>(first);
  const visible = buckets[tab];

  return (
    <div>
      <PageHeader title="My orders" subtitle="The orders you took on a call, from the TO number to the shop's door." />
      <MetricStrip
        metrics={[
          { label: "TO · being checked", value: String(buckets.to.length) },
          { label: "On hold or sent back", value: String(buckets.hold.length), tone: buckets.hold.length ? "danger" : "ink" },
          { label: "With accounts", value: String(buckets.accounts.length) },
          { label: "On the way", value: String(buckets.moving.length) },
        ]}
      />
      <Card>
        <Tabs tabs={MY_ORDERS_TABS.map((t) => ({ key: t.key, label: t.label, count: buckets[t.key].length }))} value={tab} onChange={setTab} />
        {visible.length ? (
          <ul className="divide-y divide-divider">
            {visible.map((r) => (
              <li key={r.id}>
                <OrderThread row={r} canEdit showCustomer />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={rows.length ? "Nothing here." : "No orders yet."} body="An order you take on a call appears here with its TO number." />
        )}
      </Card>
    </div>
  );
}
