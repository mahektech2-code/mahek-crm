import { ERP_SCREENS } from "../erp/registry";

/* ---------------------------------------------------------------------------
 * TABS AS GRANTS — the third level of the Manage access dialog.
 *
 * Module (a sidebar section) › screen (a sidebar page) › TAB (a list across
 * the top of that page: Purchases › Goods receipt, Register, Drum labels).
 * Until Nov 2026 a page's tabs always came with the page; the owner asked for
 * access to go down to the tab.
 *
 * A tab is stored as an `app_screen_access` row keyed `erp.<page>.<tab>`,
 * beside its page's row. It is ACCESS ONLY: Edit and Delete stay on the page,
 * because every ERP power and action owner is placed on a page
 * (`power-owners.ts`, `action-owners.ts`) and splitting them by tab would
 * re-decide all of them.
 *
 * NO TAB ROWS UNDER A HELD PAGE MEANS EVERY TAB. That is what keeps every
 * grant made before this exactly as it was, and what lets a tab added to a
 * page later reach everybody who holds the whole page. A page with some tabs
 * ticked holds exactly those; ticking the last missing one goes back to no
 * rows ("all", canonical); unticking the last one takes the page away, the way
 * the last page taken away takes its module.
 *
 * Tabs are NOT modules (`lib/modules.ts`): they never reach
 * `app_module_access`, the sidebar, the route guard or the older access
 * screens, which all go on reading pages. The ERP reads them itself
 * (`lib/erp/access.ts` → `withheldViews`).
 *
 * Pure and client-safe: the dialog, the save and the ERP share it.
 * ------------------------------------------------------------------------- */

export type TabDef = {
  /** Stored key: `erp.register.inward`. */
  key: string;
  /** The tab's own module key in the ERP (`inward`). */
  view: string;
  /** What the tab strip calls it; a sub-module's tabs carry its name first. */
  label: string;
  /** Keys that open with this tab — its "show every entry" toggle. */
  alsoOpens: string[];
};

/** Page module key (`erp.register`) → its tabs, for every built ERP page with more than one. */
export const PAGE_TABS: ReadonlyMap<string, readonly TabDef[]> = new Map(
  ERP_SCREENS.filter((s) => s.built && (s.views?.length ?? 0) > 1).map((s) => [
    `erp.${s.key}`,
    s.views!.map((v) => ({
      key: `erp.${s.key}.${v.key}`,
      view: v.key,
      label: v.section ? `${v.section} › ${v.label}` : v.label,
      alsoOpens: v.alt ? [v.alt.key] : [],
    })),
  ]),
);

const TAB_PAGE: ReadonlyMap<string, string> = new Map([...PAGE_TABS].flatMap(([page, tabs]) => tabs.map((t) => [t.key, page] as const)));

export const isTabKey = (key: string): boolean => TAB_PAGE.has(key);
export const pageOfTab = (key: string): string | undefined => TAB_PAGE.get(key);
export const tabsOfPage = (page: string): readonly TabDef[] => PAGE_TABS.get(page) ?? [];

/**
 * The tabs a page holds under a set of granted keys: the ones listed, or every
 * tab where none is. Empty for a page without tabs.
 */
export function tabsHeld(granted: { has(key: string): boolean }, page: string): string[] {
  const tabs = tabsOfPage(page);
  const listed = tabs.filter((t) => granted.has(t.key)).map((t) => t.key);
  return listed.length ? listed : tabs.map((t) => t.key);
}

/**
 * THE ERP'S READING: which of its own module keys a person may NOT open
 * because a tab was withheld. `pages` are held page keys without the `erp.`
 * prefix; `tabRows` the stored tab keys. A page with no tab rows withholds
 * nothing.
 */
export function withheldViews(pages: ReadonlySet<string>, tabRows: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const [page, tabs] of PAGE_TABS) {
    if (!pages.has(page.slice(4))) continue;
    if (!tabs.some((t) => tabRows.has(t.key))) continue;
    for (const t of tabs) if (!tabRows.has(t.key)) [t.view, ...t.alsoOpens].forEach((k) => out.add(k));
  }
  /* A view held through another tab's toggle stays held. */
  for (const tabs of PAGE_TABS.values()) for (const t of tabs) if (tabRows.has(t.key)) [t.view, ...t.alsoOpens].forEach((k) => out.delete(k));
  return out;
}
