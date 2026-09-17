"use client";

import { SalesIcon, type SalesIconName } from "./icons";
import { CollapsibleNav } from "@/components/shell/collapsible-nav";
import { SALES_NAV, SALES_PINNED } from "./nav";

/* ---------------------------------------------------------------------------
 * The Manager Console's sidebar: one pinned row, then seven groups of which
 * one is open.
 *
 * `./nav.ts` carries the argument for the shape. The MECHANISM moved to
 * `components/shell/collapsible-nav.tsx` when the CRM needed the same one —
 * two copies of an accordion is two sets of rules about what a shut group says
 * and which one reopens, and the half that drifts is always the half somebody
 * is reading. What is left here is the console's own icon set and its own
 * counts, which are keyed by href where the CRM's are named.
 * ------------------------------------------------------------------------- */

export type SalesCounts = Partial<Record<string, number>>;

export function SalesSidebarNav({
  allowed,
  counts,
}: {
  allowed: string[];
  counts: SalesCounts;
}) {
  const permitted = new Set(allowed);

  const pinned = SALES_PINNED.filter((i) => permitted.has(i.href));
  const groups = SALES_NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => permitted.has(i.href)),
  })).filter((g) => g.items.length > 0);

  return (
    <CollapsibleNav
      storageKey="sales.nav.open"
      ariaLabel="Manager Console sections"
      pinned={pinned}
      groups={groups}
      countFor={(item) => counts[item.href] ?? 0}
      renderIcon={(name, size) => <SalesIcon name={name as SalesIconName} size={size} />}
    />
  );
}
