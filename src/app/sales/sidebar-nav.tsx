"use client";

import { SalesIcon, type SalesIconName } from "@/components/console/icons";
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

/**
 * WHICH QUEUE IS RED AT ONE, rather than how big a number is.
 *
 * The console's own rule is a size — red past five, amber below — and it is
 * the right rule for the six rows it was written for: five journeys refused
 * and five expense claims waiting are a worse morning than one of each, and
 * nothing about a single one of them is a failure.
 *
 * §24's overdue count is not that kind of number. ONE lead sitting past the
 * day somebody promised is the whole reason §24 exists — that lead is the one
 * everybody assumes somebody else is holding — so it is drawn red from one,
 * exactly as an open complaint is in the CRM. Left on the size rule it would
 * have gone amber at four, which says "four is nearly fine" about the one
 * thing on this column that is never fine.
 *
 * It is a set of HREFS because the console's counts are keyed by href, where
 * the CRM's are named. Same decision, the shape this component's counts
 * already have — and a set rather than a comparison because the day a second
 * row earns red, a ternary is where the reasoning goes to be forgotten.
 */
const DANGER_HREFS = new Set<string>(["/sales/leads/actions"]);

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
      /* Named red, or the console's own size rule. See `DANGER_HREFS` — the
         rows it does not name keep exactly the tone they have always had. */
      badgeToneFor={(item, count) =>
        DANGER_HREFS.has(item.href) ? "danger" : count >= 5 ? "danger" : "warn"
      }
      renderIcon={(name, size) => <SalesIcon name={name as SalesIconName} size={size} />}
    />
  );
}
