import Link from "next/link";
import { PageHeader, cx } from "@/components/ui/primitives";
import type { AdminTab } from "@/lib/admin-routes";
import { MetricRow, type Metric } from "@/components/console/parts";

/* ---------------------------------------------------------------------------
 * Every console page opens the same way: a title, one sentence saying what it
 * is for, and — where it has them — tabs that are LINKS.
 *
 * They were buttons that swapped a screen in memory, which is why nothing could
 * link to one reliably. A tab is an address now, so it can be bookmarked, sent
 * to somebody, and reached with the back button.
 * ------------------------------------------------------------------------- */

export function AdminPage({
  title,
  subtitle,
  actions,
  tabs,
  metrics,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  tabs?: { items: readonly AdminTab[]; active: string; href: (slug: string) => string };
  /** Figure cards above the page — the v4 shape every list opens on. */
  metrics?: Metric[];
  children: React.ReactNode;
}) {
  return (
    <div className="px-7 pt-6 pb-12">
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
      {metrics && metrics.length ? <MetricRow metrics={metrics} /> : null}
      {tabs ? <TabLinks {...tabs} /> : null}
      {children}
    </div>
  );
}

/** Tabs that point at their own routes — one screen to read, several addresses underneath. */
export function routeTabs(items: readonly { slug: string; label: string; href: string }[], active: string) {
  return { items, active, href: (slug: string) => items.find((t) => t.slug === slug)?.href ?? items[0].href };
}

export function TabLinks({
  items,
  active,
  href,
}: {
  items: readonly AdminTab[];
  active: string;
  href: (slug: string) => string;
}) {
  return (
    <nav aria-label="Tabs" className="-mt-1 mb-4 flex flex-wrap items-center gap-x-6 border-b border-line">
      {items.map((t) => (
        <Link
          key={t.slug}
          href={href(t.slug)}
          aria-current={t.slug === active ? "page" : undefined}
          className={cx(
            "-mb-px border-b-2 py-2.5 text-sm whitespace-nowrap no-underline hover:no-underline",
            t.slug === active
              ? "border-brand font-semibold text-ink"
              : "border-transparent font-medium text-muted hover:text-body",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
