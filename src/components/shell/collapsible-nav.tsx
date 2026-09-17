"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { NavLink } from "./nav-link";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * ONE SIDEBAR, for every app that has one.
 *
 * The Manager Console worked this out first — forty destinations under seven
 * headings is forty-seven rows in a 232px column, which is taller than the
 * viewport, so the bottom group was below the fold on every screen and the
 * scroll position was a thing somebody had to manage in order to navigate.
 * The answer was a group that collapses, an accordion so exactly one is open,
 * and a pinned home above them.
 *
 * The CRM had the same problem arriving: it is fourteen destinations today and
 * Lead Management is ten more. Writing the same accordion a second time is the
 * mistake this codebase names more often than any other — two copies of a rule
 * drift inside a release and the half that drifts is always the half somebody
 * is reading. So the console's sidebar moved here and the CRM's sidebar became
 * a second caller, which is also what makes the two apps feel like one
 * product: a person who works both should not have to learn two navigations.
 *
 * What is DELIBERATELY parameterised is only what genuinely differs:
 *
 * **The icon set.** The console draws `SalesIcon` and the CRM draws `Icon` —
 * two sets, one grid, drawn at different stroke weights. `renderIcon` takes a
 * name and gives back a glyph, so neither app imports the other's.
 *
 * **Where the count comes from.** The console reads a map keyed by href; the
 * CRM reads three named badges off its own layout. `countFor` answers for one
 * item and neither caller has to learn the other's shape.
 *
 * **The rail.** Only the CRM collapses to a 56px strip of icons, and there the
 * accordion is not merely unhelpful, it is unusable: a heading with no room
 * for its word is a button that cannot say what it opens. Railed, every item
 * is drawn flat, which is the honest shape for a column with no labels in it.
 * ------------------------------------------------------------------------- */

export type NavRowItem = {
  href: string;
  label: string;
  icon: string;
  /** Only where the route is a prefix of every other route in the app. */
  exact?: boolean;
};

export type NavRowGroup = {
  label: string;
  /**
   * The group's own glyph. A shut sidebar is these and nothing else, so a
   * group with no icon is a word in a list rather than a place.
   */
  icon: string;
  items: NavRowItem[];
};

/* ---------------------------------------------------------------------------
 * The open-group store.
 *
 * Module scope rather than component state, because `useSyncExternalStore`
 * needs a `subscribe` that outlives a render and a `getSnapshot` that is a
 * plain function of the outside world. The listeners set is what makes a
 * change in one mounted sidebar reach another — and what makes this redraw at
 * all when a heading is clicked, since nothing here is React state.
 *
 * It is keyed by APP. The CRM and the Manager Console are different columns
 * with different groups in them, and one shared key would have each app
 * opening a group the other had chosen — or, where the label does not exist
 * in this app, falling through to a default for a reason nobody could see.
 *
 * The snapshot is a STRING, which it has to be: `getSnapshot` must return
 * something stable under `Object.is` or React re-renders for ever. An empty
 * string means nothing has been chosen in this browser, which is NOT the same
 * as "everything is shut" — see `openGroupFor`.
 * ------------------------------------------------------------------------- */

const listeners = new Set<() => void>();

/**
 * Shutting the group you are standing in is a thing somebody may want — the
 * column is then its headings and nothing else — and it cannot be said by
 * storing a label. It is stored as this rather than as an empty string, which
 * already means "nothing remembered" and would reopen on the next render.
 */
const SHUT = "__none__";

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function readOpen(storageKey: string): string {
  try {
    return window.localStorage.getItem(storageKey) ?? "";
  } catch {
    /* Blocked or cleared site data. Nothing remembered is a usable answer. */
    return "";
  }
}

function writeOpen(storageKey: string, next: string): void {
  try {
    window.localStorage.setItem(storageKey, next);
  } catch {
    /*
     * Not remembering is worse than not opening, and neither is fatal — the
     * listeners still fire, so the group opens or shuts for this session even
     * where nothing can be written down.
     */
  }
  for (const listener of listeners) listener();
}

export function isRowActive(item: NavRowItem, pathname: string): boolean {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(item.href + "/");
}

/**
 * Which group is open, and the four answers in their order of authority.
 *
 * The group holding the current route wins over anything remembered: a shut
 * group hiding the screen somebody is standing on reads as the sidebar having
 * lost it. Then a deliberate shut. Then a label remembered from a previous
 * session. Where none of them says anything — a first visit, or a route no
 * group claims — the first group opens, because a column of nothing but
 * headings on arrival reads as one that failed to load.
 *
 * A remembered label naming no group any more resolves to the default rather
 * than to something near it: groups get renamed and apps get narrowed by a
 * grant, and the honest answer to "the group you had open is gone" is not a
 * guess at which one replaced it.
 */
export function openGroupFor(
  groups: readonly NavRowGroup[],
  activeGroup: string | null,
  remembered: string,
): string | null {
  if (activeGroup) return activeGroup;
  if (remembered === SHUT) return null;
  if (remembered && groups.some((g) => g.label === remembered)) return remembered;
  return groups[0]?.label ?? null;
}

export function CollapsibleNav({
  storageKey,
  pinned = [],
  groups,
  countFor,
  renderIcon,
  railed = false,
  ariaLabel,
  badgeToneFor,
}: {
  /** `crm.nav.open`, `sales.nav.open` — one per app. */
  storageKey: string;
  /** Rows above the groups, which no heading can ever hide. */
  pinned?: readonly NavRowItem[];
  groups: readonly NavRowGroup[];
  /** Only what is waiting. A zero is not drawn. */
  countFor: (item: NavRowItem) => number;
  renderIcon: (name: string, size: number) => React.ReactNode;
  /** The CRM's 56px icon strip. Railed, the accordion is not drawn at all. */
  railed?: boolean;
  ariaLabel: string;
  /**
   * The CRM draws complaints red and everything else amber, which is its own
   * rule about which queue is which rather than about how big a number is.
   * Unset, the console's rule applies: red past five, amber below.
   */
  badgeToneFor?: (item: NavRowItem, count: number) => "danger" | "warn";
}) {
  const pathname = usePathname();

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
  const getSnapshot = React.useCallback(() => readOpen(storageKey), [storageKey]);
  const remembered = React.useSyncExternalStore(subscribe, getSnapshot, () => "");

  const activeGroup =
    groups.find((g) => g.items.some((i) => isRowActive(i, pathname)))?.label ?? null;
  const open = openGroupFor(groups, activeGroup, remembered);

  /*
   * RAILED, EVERYTHING IS DRAWN FLAT.
   *
   * A 56px column has no room for a group's word, and a heading somebody
   * cannot read is a button that cannot say what it opens. The dividers are
   * what is left of the grouping — the order is unchanged, so the rail is the
   * same list with its labels taken away rather than a different one.
   */
  if (railed) {
    return (
      <nav aria-label={ariaLabel} className="flex-1 overflow-y-auto px-1.5 pt-2 pb-4">
        {pinned.map((item) => (
          <Row
            key={item.href}
            item={item}
            active={isRowActive(item, pathname)}
            count={countFor(item)}
            renderIcon={renderIcon}
            badgeToneFor={badgeToneFor}
            railed
          />
        ))}
        {groups.map((group) => (
          <div key={group.label}>
            <div className="my-2 border-t border-divider" />
            {group.items.map((item) => (
              <Row
                key={item.href}
                item={item}
                active={isRowActive(item, pathname)}
                count={countFor(item)}
                renderIcon={renderIcon}
                badgeToneFor={badgeToneFor}
                railed
              />
            ))}
          </div>
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label={ariaLabel} className="flex-1 overflow-y-auto px-1.5 pt-2 pb-4">
      {pinned.map((item) => (
        <Row
          key={item.href}
          item={item}
          active={isRowActive(item, pathname)}
          count={countFor(item)}
          renderIcon={renderIcon}
          badgeToneFor={badgeToneFor}
        />
      ))}

      {groups.map((group) => {
        const isOpen = open === group.label;
        /*
         * A SHUT GROUP STILL SAYS WHAT IS WAITING.
         *
         * The badges are why anybody looks at this column unprompted, and a
         * group that hid them while shut would hide them on most of the app.
         * It is summed over the items this reader may actually open — the
         * caller has already filtered the grant — so a count is never a badge
         * on a door that is not there.
         */
        const waiting = group.items.reduce((n, i) => n + countFor(i), 0);
        const panelId = `nav-${storageKey}-${group.label.replace(/\W+/g, "-").toLowerCase()}`;
        return (
          <div key={group.label} className="mt-1 first:mt-2">
            <button
              type="button"
              onClick={() => writeOpen(storageKey, isOpen ? SHUT : group.label)}
              aria-expanded={isOpen}
              aria-controls={panelId}
              className={cx(
                "relative mb-px flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-[4px] pr-2 pl-2.5 text-left text-sm whitespace-nowrap",
                /*
                 * THE GROUP YOU ARE IN IS MARKED WHETHER OR NOT IT IS OPEN.
                 * Opening another shuts this one, which would otherwise leave
                 * nothing anywhere saying which screen you are standing on.
                 */
                activeGroup === group.label
                  ? "font-medium text-[#5223E0]"
                  : "text-body hover:bg-canvas hover:text-ink",
              )}
            >
              <span className="flex flex-none">{renderIcon(group.icon, 18)}</span>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">
                {group.label}
              </span>
              {isOpen ? null : waiting > 0 ? (
                <Badge count={waiting} tone="warn" />
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
                {renderIcon("chevron", 14)}
              </span>
            </button>

            {isOpen ? (
              <div id={panelId} className="mb-1">
                {group.items.map((item) => (
                  <Row
                    key={item.href}
                    item={item}
                    active={isRowActive(item, pathname)}
                    count={countFor(item)}
                    renderIcon={renderIcon}
                    badgeToneFor={badgeToneFor}
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

function Row({
  item,
  active,
  count,
  renderIcon,
  badgeToneFor,
  nested,
  railed,
}: {
  item: NavRowItem;
  active: boolean;
  count: number;
  renderIcon: (name: string, size: number) => React.ReactNode;
  badgeToneFor?: (item: NavRowItem, count: number) => "danger" | "warn";
  nested?: boolean;
  railed?: boolean;
}) {
  const tone = badgeToneFor?.(item, count) ?? (count >= 5 ? "danger" : "warn");
  return (
    <NavLink
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={railed ? item.label : undefined}
      className={cx(
        "relative mb-px flex items-center gap-2.5 rounded-[4px] border-l-[3px] text-sm whitespace-nowrap no-underline hover:no-underline",
        railed
          ? "min-h-9 justify-center border-l-transparent px-0"
          : /* The indent is the hierarchy. A sub-module drawn flush with its
             * own heading is a flat list that happens to fold. */
            nested
            ? "min-h-8 pr-2.5 pl-[25px]"
            : "min-h-9 pr-2.5 pl-[9px]",
        active
          ? cx("font-medium text-[#5223E0]", !railed && "border-l-brand")
          : "border-l-transparent text-body hover:bg-canvas hover:text-ink",
      )}
    >
      {active ? (
        <span className="pointer-events-none absolute inset-0 rounded-[4px] bg-brand-soft" />
      ) : null}
      <span className="relative z-1 flex flex-none">
        {renderIcon(item.icon, nested ? 16 : 18)}
      </span>
      {railed ? null : (
        <>
          <span className="relative z-1 min-w-0 flex-1 overflow-hidden text-ellipsis">
            {item.label}
          </span>
          {count > 0 ? <Badge count={count} tone={tone} /> : null}
        </>
      )}
    </NavLink>
  );
}

/**
 * Red past five, amber below unless the caller says otherwise — the console's
 * own rule, and ONE copy of it now that a group, an item and two apps can each
 * carry one. The number alone does not say whether anybody is on top of it.
 */
function Badge({ count, tone }: { count: number; tone: "danger" | "warn" }) {
  return (
    <span
      className={cx(
        "relative z-1 h-[18px] min-w-5 flex-none rounded-[9px] px-1.5 text-center text-[11px] leading-[18px] font-medium tabular-nums",
        tone === "danger" ? "bg-danger-soft text-danger" : "bg-warn-line text-warn-ink",
      )}
    >
      {count}
    </span>
  );
}
