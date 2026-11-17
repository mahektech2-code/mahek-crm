import type { AdminTab } from "@/lib/admin-routes";
import type { Metric } from "@/components/console/parts";
import { PageHeader } from "@/components/ui/primitives";
import { Figures, Tabs, type Figure } from "./kit";

/* ---------------------------------------------------------------------------
 * Every console page opens the canvas's way: the title and its actions on one
 * row, figure cards, then tabs that are LINKS — and every block 18px apart in
 * a column that stops at 1240px.
 *
 * There is no subtitle under the title: the canvas has none, and a sentence
 * explaining a screen to the person who opened it on purpose was read once.
 * `subtitle` is still accepted, for the ⓘ on the title, so no page had to
 * change to stop drawing it.
 *
 * THE TITLE IS THE SUITE'S `PageHeader`, and the column is the ERP's — full
 * width, 24px in (2026-11-17). The console had its own heading and a 1240px
 * column, so moving from the ERP or HRMS into it the title jumped, the page
 * narrowed and sat off-centre on a wide screen: a different product.
 * ------------------------------------------------------------------------- */

export function AdminPage({
  title,
  subtitle,
  actions,
  tabs,
  metrics,
  figures,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  tabs?: { items: readonly (AdminTab & { count?: number | null; urgent?: boolean })[]; active: string; href: (slug: string) => string };
  /** Figure cards above the page (older pages' shape — a tone colours the figure). */
  metrics?: Metric[];
  /** Figure cards, the canvas's way: dots, the navy card, links. */
  figures?: Figure[];
  children: React.ReactNode;
}) {
  const cards: Figure[] | undefined =
    figures ??
    metrics?.map((m) => ({
      label: m.label,
      value: m.value,
      sub: m.sub,
      tone: m.tone === "success" ? "ok" : m.tone,
    }));
  return (
    <div className="flex w-full min-w-0 flex-col gap-4 px-6 pt-6 pb-10 text-[13px] leading-[1.45]">
      <div className="-mb-4">
        <PageHeader title={title} subtitle={typeof subtitle === "string" ? subtitle : undefined} actions={actions} />
      </div>
      {cards && cards.length ? <Figures items={cards} /> : null}
      {tabs ? <Tabs items={tabs.items.map((t) => ({ ...t, href: tabs.href(t.slug) }))} active={tabs.active} /> : null}
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </div>
  );
}

/** Tabs that point at their own routes — one screen to read, several addresses underneath. */
export function routeTabs(items: readonly { slug: string; label: string; href: string; count?: number | null }[], active: string) {
  return { items, active, href: (slug: string) => items.find((t) => t.slug === slug)?.href ?? items[0].href };
}

/** The tab strip on its own, for a page that draws it below something else. */
export function TabLinks({
  items,
  active,
  href,
}: {
  items: readonly (AdminTab & { count?: number | null })[];
  active: string;
  href: (slug: string) => string;
}) {
  return <Tabs items={items.map((t) => ({ ...t, href: href(t.slug) }))} active={active} />;
}
