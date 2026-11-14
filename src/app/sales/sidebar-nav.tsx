"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { SalesIcon } from "./icons";
import { SALES_NAV, SALES_PINNED, type NavGroup, type NavItem } from "./nav";

/* ---------------------------------------------------------------------------
 * The Manager Console's sidebar: one pinned row, then six groups of which one
 * is open.
 *
 * `./nav.ts` carries the argument for the shape. What lives here is the three
 * things that make a collapsing sidebar honest rather than merely shorter:
 *
 * **A CLOSED GROUP STILL SAYS WHAT IS WAITING.** The badges are the reason
 * anybody looks at this column without being sent — four orders over a credit
 * limit, two leave requests — and a group that hid them while closed would
 * hide them on five sixths of the console. A closed group carries the SUM of
 * its own items' counts, and gives it up the moment it is opened and the
 * items can speak for themselves. It is summed over what the reader may
 * actually open, so a count is never a badge on a door that is not there.
 *
 * **THE GROUP YOU ARE IN IS MARKED WHETHER OR NOT IT IS OPEN.** Opening
 * another group closes this one, which is the whole point of an accordion and
 * would otherwise leave the console with nothing anywhere saying which screen
 * you are on. The heading keeps the brand colour; only the open one also
 * shows the item.
 *
 * **NAVIGATING RE-OPENS THE RIGHT GROUP.** The open group is state, and the
 * active group is a prop — so `NavGroups` is KEYED on the active group and
 * remounts with the correct one open rather than resetting itself in an
 * effect, which is the React Compiler rule this codebase already follows for
 * every modal and drawer.
 * ------------------------------------------------------------------------- */

export type SalesCounts = Partial<Record<string, number>>;

function isActive(item: NavItem, pathname: string) {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(item.href + "/");
}

export function SalesSidebarNav({
  allowed,
  counts,
}: {
  allowed: string[];
  counts: SalesCounts;
}) {
  const pathname = usePathname();
  const permitted = new Set(allowed);

  const pinned = SALES_PINNED.filter((i) => permitted.has(i.href));
  const groups = SALES_NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => permitted.has(i.href)),
  })).filter((g) => g.items.length > 0);

  const activeGroup =
    groups.find((g) => g.items.some((i) => isActive(i, pathname)))?.label ?? null;

  return (
    <nav
      aria-label="Manager Console sections"
      className="flex-1 overflow-y-auto px-1.5 pt-2 pb-4"
    >
      {pinned.map((item) => (
        <NavRow
          key={item.href}
          item={item}
          active={isActive(item, pathname)}
          count={counts[item.href] ?? 0}
        />
      ))}

      <NavGroups
        /* Remount rather than reset: see the header of this file. */
        key={activeGroup ?? "none"}
        groups={groups}
        counts={counts}
        pathname={pathname}
        activeGroup={activeGroup}
        /* Landing somewhere no group claims — Approvals, reached from Today —
         * opens the first group rather than leaving every door shut. A sidebar
         * showing nothing but headings on arrival reads as one that failed to
         * load. */
        initialOpen={activeGroup ?? groups[0]?.label ?? null}
      />
    </nav>
  );
}

function NavGroups({
  groups,
  counts,
  pathname,
  activeGroup,
  initialOpen,
}: {
  groups: NavGroup[];
  counts: SalesCounts;
  pathname: string;
  activeGroup: string | null;
  initialOpen: string | null;
}) {
  const [open, setOpen] = React.useState(initialOpen);

  return (
    <>
      {groups.map((group) => {
        const isOpen = open === group.label;
        const held = group.items.reduce((n, i) => n + (counts[i.href] ?? 0), 0);
        const panelId = `sales-nav-${group.label.replace(/\W+/g, "-").toLowerCase()}`;
        return (
          <div key={group.label} className="mt-1 first:mt-2">
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : group.label)}
              aria-expanded={isOpen}
              aria-controls={panelId}
              className={cx(
                "relative mb-px flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-[4px] border-l-[3px] border-l-transparent pr-2 pl-[9px] text-left text-sm whitespace-nowrap",
                activeGroup === group.label
                  ? "font-medium text-[#5223E0]"
                  : "text-body hover:bg-canvas",
              )}
            >
              <span className="flex flex-none">
                <SalesIcon name={group.icon} size={18} />
              </span>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">
                {group.label}
              </span>
              {/* Given up the moment the items can speak for themselves. */}
              {!isOpen && held > 0 ? <CountBadge count={held} /> : null}
              <span
                className={cx(
                  "flex flex-none text-muted transition-transform",
                  isOpen && "rotate-90",
                )}
              >
                <SalesIcon name="chevron" size={14} />
              </span>
            </button>

            {isOpen ? (
              <div id={panelId} className="mb-1">
                {group.items.map((item) => (
                  <NavRow
                    key={item.href}
                    item={item}
                    active={isActive(item, pathname)}
                    count={counts[item.href] ?? 0}
                    nested
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function NavRow({
  item,
  active,
  count,
  nested,
}: {
  item: NavItem;
  active: boolean;
  count: number;
  nested?: boolean;
}) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "relative mb-px flex min-h-8 items-center gap-2.5 rounded-[4px] border-l-[3px] pr-2.5 text-sm whitespace-nowrap no-underline hover:no-underline",
        /* The indent is the hierarchy. A sub-module drawn flush with its own
         * group heading is a flat list that happens to fold. */
        nested ? "pl-[25px]" : "min-h-9 pl-[9px]",
        active
          ? "border-l-brand font-medium text-[#5223E0]"
          : "border-l-transparent text-body hover:bg-canvas",
      )}
    >
      {active ? (
        <span className="pointer-events-none absolute inset-0 rounded-[4px] bg-brand-soft" />
      ) : null}
      <span className="relative z-1 flex flex-none">
        <SalesIcon name={item.icon} size={nested ? 16 : 18} />
      </span>
      <span className="relative z-1 min-w-0 flex-1 overflow-hidden text-ellipsis">
        {item.label}
      </span>
      {count > 0 ? <CountBadge count={count} /> : null}
    </Link>
  );
}

/**
 * Red past five, amber below — the design's own rule, and one copy of it now
 * that both a group and an item can carry one. The number alone does not say
 * whether anybody is on top of it.
 */
function CountBadge({ count }: { count: number }) {
  return (
    <span
      className={cx(
        "relative z-1 h-[18px] min-w-5 flex-none rounded-[9px] px-1.5 text-center text-[11px] leading-[18px] font-medium tabular-nums",
        count >= 5 ? "bg-danger-soft text-danger" : "bg-warn-line text-warn-ink",
      )}
    >
      {count}
    </span>
  );
}
