"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { NavLink } from "@/components/shell/nav-link";
import { cx } from "@/components/ui/primitives";
import { SalesIcon } from "./icons";
import { SALES_NAV, SALES_PINNED, type NavGroup, type NavItem } from "./nav";

/* ---------------------------------------------------------------------------
 * The Manager Console's sidebar: one pinned row, then seven groups of which
 * one is open.
 *
 * `./nav.ts` carries the argument for the shape, and why it is now every group
 * rather than only Lead Management. It moved out of `sales-shell.tsx` when it
 * grew state of its own: the shell draws a header, a frame and Live now, and
 * none of that has any business re-rendering because somebody opened People.
 *
 * Four things here are what make a collapsing sidebar honest rather than
 * merely shorter:
 *
 * **A SHUT GROUP STILL SAYS WHAT IS WAITING.** The badges are why anybody
 * looks at this column unprompted — four orders over a credit limit, two leave
 * requests — and a group that hid them while shut would hide them on six
 * sevenths of the console. A shut group carries the SUM of its own items'
 * counts and gives it up the moment they can speak for themselves. It is
 * summed over what this reader may actually open, so a count is never a badge
 * on a door that is not there.
 *
 * **THE GROUP YOU ARE IN IS MARKED WHETHER OR NOT IT IS OPEN.** Opening
 * another shuts this one, which is the whole point of an accordion and would
 * otherwise leave the console with nothing anywhere saying which screen you
 * are standing on.
 *
 * **WHAT IS REMEMBERED IS THE OPEN ONE, not the shut ones.** The stored value
 * used to be a map of collapsed labels, which is the right shape for seven
 * independent toggles and the wrong one for an accordion: a map can express
 * two open and it can express all seven shut, and both are states this sidebar
 * has no way to reach and no way to explain. One label can only ever say what
 * is true.
 *
 * **NOTHING REMEMBERED IS THE GROUP YOU ARE IN**, not the first group and not
 * all of them. A console opened on Salary should already be showing People.
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * The open-group store.
 *
 * Module scope rather than component state, because `useSyncExternalStore`
 * needs a `subscribe` that outlives a render and a `getSnapshot` that is a
 * plain function of the outside world. The listeners set is what makes a
 * change in one mounted sidebar reach another — and what makes this redraw at
 * all when a heading is clicked, since nothing here is React state.
 *
 * The snapshot is a STRING, which it has to be: `getSnapshot` must return
 * something stable under `Object.is` or React re-renders for ever. That was
 * true of the raw JSON this used to hold and is true of a bare label for free.
 * An empty string means nothing has been chosen in this browser, which is NOT
 * the same as "everything is shut" — see `openGroupFor`.
 * ------------------------------------------------------------------------- */

const OPEN_KEY = "sales.nav.open";
const openListeners = new Set<() => void>();

/**
 * Shutting the group you are standing in is a thing somebody may want — the
 * column is then seven headings and nothing else — and it cannot be said by
 * storing a label. It is stored as this rather than as an empty string, which
 * already means "nothing remembered" and would reopen on the next render.
 */
const SHUT = "__none__";

function subscribeToOpen(onChange: () => void): () => void {
  openListeners.add(onChange);
  return () => {
    openListeners.delete(onChange);
  };
}

function readOpen(): string {
  try {
    return window.localStorage.getItem(OPEN_KEY) ?? "";
  } catch {
    /* Blocked or cleared site data. Nothing remembered is a usable answer. */
    return "";
  }
}

function writeOpen(next: string): void {
  try {
    window.localStorage.setItem(OPEN_KEY, next);
  } catch {
    /*
     * Not remembering is worse than not opening, and neither is fatal — the
     * listeners still fire, so the group opens or shuts for this session even
     * where nothing can be written down.
     */
  }
  for (const listener of openListeners) listener();
}

export type SalesCounts = Partial<Record<string, number>>;

function isActive(item: NavItem, pathname: string) {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(item.href + "/");
}

/**
 * Which group is open, and the four answers in their order of authority.
 *
 * The group holding the current route wins over anything remembered, for the
 * reason the old per-group rule gave and which has not changed: a shut group
 * hiding the screen somebody is standing on reads as the sidebar having lost
 * it. Then a deliberate shut. Then a label remembered from a previous session.
 * Where none of them says anything — a first visit, or a route no group claims,
 * which is Approvals, reached from Today — the first group opens, because a
 * column of nothing but headings on arrival reads as one that failed to load.
 *
 * A remembered label naming no group any more resolves to the default rather
 * than to something near it: groups get renamed, and the honest answer to "the
 * group you had open is gone" is not a guess at which one replaced it.
 */
function openGroupFor(
  groups: NavGroup[],
  activeGroup: string | null,
  remembered: string,
): string | null {
  if (activeGroup) return activeGroup;
  if (remembered === SHUT) return null;
  if (remembered && groups.some((g) => g.label === remembered)) return remembered;
  return groups[0]?.label ?? null;
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

  /*
   * `useSyncExternalStore` rather than an effect that calls `setState`, and the
   * React Compiler lint is right to insist: reading storage into state on mount
   * is a second render on every navigation, and this draws the whole sidebar.
   * It is also genuinely an EXTERNAL store — another tab can change it, and
   * this is the hook built for exactly that shape.
   *
   * A lazy `useState` initialiser would have been the obvious alternative and
   * is wrong for a different reason: the server renders this too, and a first
   * render that reads `localStorage` is a first render the server cannot
   * produce. `getServerSnapshot` returns the empty string, so the server and
   * the client's first paint agree about what is open.
   */
  const remembered = React.useSyncExternalStore(subscribeToOpen, readOpen, () => "");

  const activeGroup =
    groups.find((g) => g.items.some((i) => isActive(i, pathname)))?.label ?? null;
  const open = openGroupFor(groups, activeGroup, remembered);

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

      {groups.map((group) => {
        const isOpen = open === group.label;
        const waiting = group.items.reduce((n, i) => n + (counts[i.href] ?? 0), 0);
        const panelId = `sales-nav-${group.label.replace(/\W+/g, "-").toLowerCase()}`;
        return (
          <div key={group.label} className="mt-1 first:mt-2">
            <button
              type="button"
              onClick={() => writeOpen(isOpen ? SHUT : group.label)}
              aria-expanded={isOpen}
              aria-controls={panelId}
              className={cx(
                "relative mb-px flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-[4px] pr-2 pl-3 text-left text-sm whitespace-nowrap",
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
              {isOpen ? null : waiting > 0 ? (
                <CountBadge count={waiting} />
              ) : (
                /* How much is behind the door, where nothing is waiting behind
                 * it. Drawn quietly, and deliberately NOT a badge: a count of
                 * rows and a count of things needing a decision must never be
                 * read as the same number. */
                <span className="flex-none text-[11px] text-muted opacity-70 tabular-nums">
                  {group.items.length}
                </span>
              )}
              <span
                className={cx(
                  "flex flex-none text-muted transition-transform",
                  isOpen && "rotate-90",
                )}
                aria-hidden
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
    </nav>
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
    <NavLink
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "relative mb-px flex items-center gap-2.5 rounded-[4px] border-l-[3px] pr-2.5 text-sm whitespace-nowrap no-underline hover:no-underline",
        /* The indent is the hierarchy. A sub-module drawn flush with its own
         * heading is a flat list that happens to fold. */
        nested ? "min-h-8 pl-[25px]" : "min-h-9 pl-[9px]",
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
    </NavLink>
  );
}

/**
 * Red past five, amber below — the design's own rule, and ONE copy of it now
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
