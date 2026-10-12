import "server-only";
import type { ErpContext } from "@/lib/erp/access";
import { erpNavCounts } from "@/lib/erp/counts";
import { erpHref, type ErpScreen } from "@/lib/erp/registry";
import type { ListTab } from "./list-screen";

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
): Promise<{ tabs: ListTab[]; toggle: { label: string; href: string } | null; at: (key: string) => string }> {
  const views = screen.views ?? [];
  const base = erpHref(screen);
  const at = (k: string) => (k === views[0]?.key ? base : `${base}?view=${k}`);
  const counts = views.length > 1 ? await erpNavCounts(ctx) : {};
  const tabs: ListTab[] = views.map((v) => ({
    key: v.key,
    label: v.label,
    href: at(v.key),
    active: v.key === activeKey || v.alt?.key === activeKey,
    count: counts[v.key] || undefined,
  }));
  const current = views.find((v) => v.key === activeKey || v.alt?.key === activeKey);
  const toggle = current?.alt ? (current.alt.key === activeKey ? { label: current.alt.back, href: at(current.key) } : { label: current.alt.label, href: at(current.alt.key) }) : null;
  return { tabs, toggle, at };
}
