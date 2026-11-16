import { APP_MODULES } from "@/lib/modules";
import { deskHref, deskNavMatch, hubNav } from "@/lib/lead-hub";
import { LEAD_GROUP, NAV, PINNED, type NavGroup, type NavItem } from "./nav";

/*
 * THE SIDEBAR'S RULES, KEPT APART FROM THE SIDEBAR'S DATA.
 *
 * These three narrow the CRM's menu to the modules somebody holds, and the
 * lead row reads `APP_MODULES` to do it — the registry of every module in every
 * app, 1,500 lines. They are called by the CRM's layout, on the server. They
 * used to live in `nav.ts`, which the sidebar imports for `NAV` and `PINNED`,
 * and that one import put the whole registry into the browser bundle of every
 * app: 48 KB nobody's browser ever ran. Keep anything that reads the registry
 * here, and keep `nav.ts` data only.
 */

/**
 * The rows above the groups, narrowed the same way.
 *
 * Dashboard is pinned for the reason the Manager Console pins Today: it is the
 * app's home, the screen the wordmark links to and the one somebody returns to
 * between every other thing they do. Inside a group it would sit behind a shut
 * heading on every screen that is not its own, which is most of them, and a
 * home you have to open a drawer to reach is not a home.
 *
 * It is narrowed by the grant like anything else — Dashboard is a module and
 * can be withheld, and a pinned row nobody may open would be a permanent link
 * to a redirect.
 */
export function pinnedForModules(allowed: readonly string[]): NavItem[] {
  const set = new Set(allowed);
  return PINNED.filter((i) => set.has(i.href));
}

export function navForModules(
  allowed: readonly string[],
  /** Holds `customer.deactivate` — see `NavItem.managerOnly`. */
  isManager = true,
): NavGroup[] {
  const set = new Set(allowed);
  return NAV.map((g) =>
    g.label === LEAD_GROUP
      ? leadsRow(set)
      : {
          ...g,
          // Two filters, deliberately. The module grant answers "were they given
          // this screen"; `managerOnly` answers "is this screen theirs to have at
          // all" — and the second is needed because an ungranted module is a
          // HELD module, not a withheld one.
          items: g.items.filter((i) => set.has(i.href) && (isManager || !i.managerOnly)),
        },
  ).filter((g) => g.items.length > 0);
}


/**
 * EVERY LEAD MODULE IS ONE ROW, "Leads".
 *
 * Behind it is the Leads frame (`components/leads/hub`) — Today, Leads,
 * Pipeline and Insights — which draws the desks this person holds. The row
 * lands on the first of them and lights on every lead and sample screen.
 * Nobody is stranded: the row is drawn for whoever holds any one lead module,
 * and it lands on a screen they hold.
 */
function leadsRow(set: ReadonlySet<string>): NavGroup {
  const keys = new Set(
    APP_MODULES.filter((m) => m.app === "crm" && set.has(m.href)).map((m) => m.key),
  );
  /* An ordinary group, like Customer records: one row per desk this person
     holds, each lit on every screen of its desk (`deskNavMatch`). */
  return {
    label: "Leads",
    icon: "target",
    items: hubNav(keys).map((d) => ({
      href: deskHref(d),
      label: d.label,
      icon: d.icon,
      match: deskNavMatch(d),
      ...(d.key === "my-day" ? { badge: "leadsAttention" as const } : {}),
    })),
  };
}
