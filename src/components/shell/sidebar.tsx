"use client";

import { Icon } from "./icons";
import { CollapsibleNav, type NavRowItem } from "./collapsible-nav";
import { NAV, PINNED, type NavGroup, type NavItem } from "./nav";
import { AccountMenu } from "./account-menu";
import { cx } from "@/components/ui/primitives";
import type { User } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * The CRM's sidebar, which is now the Manager Console's sidebar.
 *
 * The accordion, the pinned row, the badge roll-up and the open-group store
 * all live in `./collapsible-nav.tsx` — one implementation for both apps, for
 * the reason given in its own header. What is left here is the two things that
 * are genuinely the CRM's: which icon set to draw, and where a badge's number
 * comes from.
 *
 * THE RAIL IS KEPT, and it is the one place the accordion is not drawn. A 56px
 * column has no room for a group's word, and a heading somebody cannot read is
 * a button that cannot say what it opens — so railed, every item is drawn flat
 * with the group dividers left in. It is the same list with its labels taken
 * away rather than a different one.
 * ------------------------------------------------------------------------- */

export function Sidebar({
  collapsed,
  user,
  hat,
  badges,
  /** What this person may open. The layout resolved it; undefined means all. */
  groups = NAV,
  pinned = PINNED,
}: {
  collapsed: boolean;
  user: User;
  /** Who this person is in THIS app — see `lib/hat-labels.ts`. */
  hat: { label: string; sentence: string };
  badges: { reminders: number; complaints: number; statusRequests: number };
  groups?: NavGroup[];
  pinned?: NavItem[];
}) {
  /*
   * The CRM names its badges rather than keying them by href, because the
   * three numbers are read once in the layout and handed down — see the note
   * on `NavItem.badge`, which is an internal discriminator and free to be
   * renamed. `countFor` is where that shape meets the shared component's.
   */
  const countFor = (item: NavRowItem) => {
    const badge = (item as NavItem).badge;
    if (badge === "reminders") return badges.reminders;
    if (badge === "complaints") return badges.complaints;
    if (badge === "statusRequests") return badges.statusRequests;
    return 0;
  };

  return (
    <aside
      className={cx(
        "flex flex-none flex-col border-r border-line bg-surface transition-[width] duration-150",
        collapsed ? "w-14" : "w-[216px]",
      )}
    >
      <CollapsibleNav
        storageKey="crm.nav.open"
        ariaLabel="CRM sections"
        pinned={pinned}
        groups={groups}
        countFor={countFor}
        railed={collapsed}
        renderIcon={(name, size) => <Icon name={name} size={size} className="flex-none" />}
        /*
         * The CRM's own rule about WHICH queue rather than about how big a
         * number is: a complaint is red at one, because one unanswered
         * complaint is not a lighter version of five. Everything else is amber
         * whatever it counts. Rolled up onto a shut heading the shared
         * component uses amber, which is right — a group is not one queue.
         */
        badgeToneFor={(item) =>
          (item as NavItem).badge === "complaints" ? "danger" : "warn"
        }
      />

      {/*
        The chip is the account menu now, not a label with a sign-out icon
        stuck to it — see `AccountMenu`. Collapsed, the avatar is the trigger:
        the rail used to draw the chip and hide every control on it, so a
        collapsed sidebar had no way to sign out at all.
      */}
      <div className="flex flex-none items-center border-t border-divider px-2 py-2">
        <AccountMenu user={user} hat={hat} variant="sidebar" collapsed={collapsed} />
      </div>
    </aside>
  );
}
