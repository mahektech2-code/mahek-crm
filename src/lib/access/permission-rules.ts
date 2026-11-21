import { isTabKey, pageOfTab, tabsHeld, tabsOfPage } from "./tab-grants";

/* ---------------------------------------------------------------------------
 * THE TICK RULES OF THE ACCESS DIALOG, IN ONE PLACE.
 *
 * Access is now three things per screen and one thing per app:
 *
 *   - POSITION, per app: Associate sees only their own records; Manager sees
 *     their own and their team's (the HRMS reporting line); Everyone sees the
 *     whole company's. Position decides what somebody SEES and nothing else —
 *     it never adds a permission.
 *   - ACCESS on a screen opens it with every ordinary action on it.
 *   - EDIT on a screen is any row, modal or detail edit there.
 *   - DELETE on a screen is the special one, and it needs Edit.
 *
 * Screens sit under MODULES — the section headings of the app's sidebar, the
 * same `group` `lib/modules.ts` gives every screen. A module gates its
 * screens: none of them can be given until the module is, and the last one
 * taken away takes the module with it.
 *
 * A page's TABS are a third level under it (`tab-grants.ts`): Access only,
 * no tab entries meaning every tab.
 *
 * Pure and client-safe. The dialog runs these on every click and the server
 * runs `normaliseGrant` on every save, so what the dialog drew is what is
 * stored — a request that skipped the dialog is brought back into shape
 * rather than trusted.
 * ------------------------------------------------------------------------- */

/**
 * Whose records somebody sees in an app: their own, their own and their HRMS
 * team's, or everybody's. The one thing position decides.
 */
export type Position = "associate" | "manager" | "everyone";

/** Wider positions see everything narrower ones do. */
export const POSITION_RANK: Record<Position, number> = { associate: 0, manager: 1, everyone: 2 };

/** One screen's ticks. `autoEdit` marks an Edit that Delete brought along. */
export type ScreenTicks = { edit: boolean; delete: boolean; autoEdit: boolean };

/**
 * One app's grant as the dialog edits it.
 *
 * `modules` are the sidebar sections given; `screens` maps a screen's module
 * key (`crm.call-log`) to its ticks, and a screen absent from it has no
 * Access.
 */
export type AppGrantDraft = {
  position: Position;
  modules: ReadonlySet<string>;
  screens: ReadonlyMap<string, ScreenTicks>;
};

/** A sidebar section and the screens under it, as `moduleGroupsForApp` gives them. */
export type ModuleShape = { module: string; screens: readonly string[] };

const NONE: ScreenTicks = { edit: false, delete: false, autoEdit: false };

function withScreens(d: AppGrantDraft, edit: (m: Map<string, ScreenTicks>, mods: Set<string>) => void): AppGrantDraft {
  const screens = new Map(d.screens);
  const modules = new Set(d.modules);
  edit(screens, modules);
  return { position: d.position, modules, screens };
}

function moduleOf(shape: readonly ModuleShape[], screen: string): ModuleShape | undefined {
  return shape.find((m) => m.screens.includes(screen));
}

/** Giving a module opens every screen under it; taking it away takes them all, ticks and all. */
export function setModule(d: AppGrantDraft, shape: readonly ModuleShape[], module: string, on: boolean): AppGrantDraft {
  const m = shape.find((x) => x.module === module);
  if (!m) return d;
  return withScreens(d, (screens, modules) => {
    if (on) {
      modules.add(module);
      for (const s of m.screens) if (!screens.has(s)) screens.set(s, NONE);
    } else {
      modules.delete(module);
      for (const s of m.screens) dropPage(screens, s);
    }
  });
}

/**
 * Access on one screen. Refused while its module is not given — a screen
 * cannot be granted under a module nobody holds. Taking the last screen of a
 * module away takes the module too.
 */
export function setAccess(d: AppGrantDraft, shape: readonly ModuleShape[], screen: string, on: boolean): AppGrantDraft {
  const m = moduleOf(shape, screen);
  if (!m || !d.modules.has(m.module)) return d;
  return withScreens(d, (screens, modules) => {
    if (on) {
      if (!screens.has(screen)) screens.set(screen, NONE);
    } else {
      dropPage(screens, screen);
      if (!m.screens.some((s) => screens.has(s))) modules.delete(m.module);
    }
  });
}

/** A page taken away takes its tab entries with it. */
function dropPage(screens: Map<string, ScreenTicks>, page: string) {
  screens.delete(page);
  for (const t of tabsOfPage(page)) screens.delete(t.key);
}

/** Whether a tab is open under this draft: its page held, and the tab listed or no tab listed. */
export function holdsTab(d: AppGrantDraft, tab: string): boolean {
  const page = pageOfTab(tab);
  return !!page && d.screens.has(page) && tabsHeld(d.screens, page).includes(tab);
}

/**
 * ACCESS ON ONE TAB. Refused while its page is not held. Every tab ticked is
 * stored as no tab entries ("all"); the last tab unticked takes the page away
 * (and its module, if that was the module's last page).
 */
export function setTab(d: AppGrantDraft, shape: readonly ModuleShape[], tab: string, on: boolean): AppGrantDraft {
  const page = pageOfTab(tab);
  if (!page || !d.screens.has(page)) return d;
  const all = tabsOfPage(page).map((t) => t.key);
  const held = new Set(tabsHeld(d.screens, page));
  if (on) held.add(tab);
  else held.delete(tab);
  if (!held.size) return setAccess(d, shape, page, false);
  return withScreens(d, (screens) => {
    for (const k of all) screens.delete(k);
    if (held.size < all.length) for (const k of held) screens.set(k, NONE);
  });
}

/** Tab entries kept only under a held page, without ticks, and dropped where they list every tab. */
function keepTabs(from: ReadonlyMap<string, ScreenTicks>, into: Map<string, ScreenTicks>) {
  const byPage = new Map<string, string[]>();
  for (const k of from.keys()) {
    const page = isTabKey(k) ? pageOfTab(k) : undefined;
    if (page && into.has(page)) byPage.set(page, [...(byPage.get(page) ?? []), k]);
  }
  for (const [page, keys] of byPage) if (keys.length < tabsOfPage(page).length) for (const k of keys) into.set(k, NONE);
}

/** Edit ticked by hand is the person's own; taking it away takes Delete with it. */
export function setEdit(d: AppGrantDraft, shape: readonly ModuleShape[], screen: string, on: boolean): AppGrantDraft {
  const m = moduleOf(shape, screen);
  if (!m || !d.modules.has(m.module)) return d;
  return withScreens(d, (screens) => {
    const cur = screens.get(screen) ?? NONE;
    screens.set(screen, on ? { edit: true, delete: cur.delete, autoEdit: false } : { edit: false, delete: false, autoEdit: false });
  });
}

/** Delete brings Edit along if it was not there, and takes back only the Edit it brought. */
export function setDelete(d: AppGrantDraft, shape: readonly ModuleShape[], screen: string, on: boolean): AppGrantDraft {
  const m = moduleOf(shape, screen);
  if (!m || !d.modules.has(m.module)) return d;
  return withScreens(d, (screens) => {
    const cur = screens.get(screen) ?? NONE;
    if (on) screens.set(screen, { edit: true, delete: true, autoEdit: cur.edit ? cur.autoEdit : true });
    else screens.set(screen, cur.autoEdit ? NONE : { edit: cur.edit, delete: false, autoEdit: false });
  });
}

export function setPosition(d: AppGrantDraft, position: Position): AppGrantDraft {
  return { position, modules: d.modules, screens: d.screens };
}

/**
 * THE SERVER'S READING OF WHATEVER ARRIVED. Unknown screens dropped, a
 * screen under a module not given dropped, Delete without Edit given its
 * Edit, a module with no screen left taken away. Running it twice changes
 * nothing.
 */
export function normaliseGrant(d: AppGrantDraft, shape: readonly ModuleShape[]): AppGrantDraft {
  const screens = new Map<string, ScreenTicks>();
  const modules = new Set<string>();
  for (const m of shape) {
    if (!d.modules.has(m.module)) continue;
    for (const s of m.screens) {
      const t = d.screens.get(s);
      if (!t) continue;
      screens.set(s, t.delete ? { edit: true, delete: true, autoEdit: t.edit ? t.autoEdit : true } : { edit: t.edit, delete: false, autoEdit: false });
    }
    if (m.screens.some((s) => screens.has(s))) modules.add(m.module);
  }
  keepTabs(d.screens, screens);
  return { position: d.position, modules, screens };
}

export function emptyGrant(position: Position = "associate"): AppGrantDraft {
  return { position, modules: new Set(), screens: new Map() };
}
