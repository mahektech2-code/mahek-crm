import "server-only";
import type { ErpContext } from "@/lib/erp/access";
import { erpCountsFor } from "@/lib/erp/counts";
import { erpHref, type ErpScreen, type ErpView } from "@/lib/erp/registry";
import type { ListTab } from "./list-screen";

/**
 * THE TABS OF A PAGE THIS PERSON HOLDS — every tab, less any withheld in
 * Manage access (`lib/access/tab-grants.ts`). Every page that draws tabs, and
 * every page that picks which tab to open on, reads this, so a withheld tab is
 * neither drawn nor reachable by typing its `?view=`.
 */
export function heldViews(ctx: ErpContext, screen: ErpScreen): ErpView[] {
  const withheld = ctx.withheld;
  const all = screen.views ?? [];
  return withheld?.size ? all.filter((v) => !withheld.has(v.key)) : all;
}

/**
 * A screen's tab strip, worked out ONCE for every page that draws one — the
 * generic list and Logistics alike — so the same screen never shows two
 * different strips, and each tab's count is the very figure the sidebar badge
 * adds up.
 */
export async function screenTabs(
  ctx: ErpContext,
  screen: ErpScreen,
  activeKey: string,
): Promise<{ tabs: ListTab[]; toggle: { label: string; href: string } | null; at: (key: string) => string; sections: ListTab[] | null }> {
  const views = heldViews(ctx, screen);
  const base = erpHref(screen);
  const at = (k: string) => (k === views[0]?.key ? base : `${base}?view=${k}`);
  /* Only this strip's own badges — the sidebar's are the layout's, and streamed. */
  const counts = views.length > 1 ? await erpCountsFor(ctx, views.map((v) => v.key).join(",")) : {};
  const tabs: ListTab[] = views.map((v) => ({
    key: v.key,
    label: v.label,
    href: at(v.key),
    active: v.key === activeKey || v.alt?.key === activeKey,
    count: counts[v.key] || undefined,
  }));
  const current = views.find((v) => v.key === activeKey || v.alt?.key === activeKey);
  const toggle = current?.alt ? (current.alt.key === activeKey ? { label: current.alt.back, href: at(current.key) } : { label: current.alt.label, href: at(current.alt.key) }) : null;
  /* Two levels (Petty Cash): the sub-modules across the top, and only the
     current sub-module's tabs under them. A sub-module's count is its tabs'. */
  if (!views.some((v) => v.section)) return { tabs, toggle, at, sections: null };
  const names = [...new Set(views.map((v) => v.section ?? ""))];
  const here = current?.section ?? names[0];
  const sections: ListTab[] = names.map((n) => {
    const mine = tabs.filter((_, i) => (views[i].section ?? "") === n);
    const total = mine.reduce((s, t) => s + (t.count ?? 0), 0);
    return { key: `section:${n}`, label: n, href: mine[0].href, active: n === here, count: total || undefined };
  });
  return { tabs: tabs.filter((_, i) => (views[i].section ?? "") === here), toggle, at, sections };
}
