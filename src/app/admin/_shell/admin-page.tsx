import Link from "next/link";
import { PageHeader, cx } from "@/components/ui/primitives";
import type { AdminTab } from "@/lib/admin-routes";

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
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  tabs?: { items: readonly AdminTab[]; active: string; href: (slug: string) => string };
  children: React.ReactNode;
}) {
  return (
    <div className="px-6 pt-6 pb-12">
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
      {tabs ? <TabLinks {...tabs} /> : null}
      {children}
    </div>
  );
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
    <nav aria-label="Tabs" className="-mt-1 flex flex-wrap items-center gap-x-5 border-b border-line">
      {items.map((t) => (
        <Link
          key={t.slug}
          href={href(t.slug)}
          aria-current={t.slug === active ? "page" : undefined}
          className={cx(
            "-mb-px border-b-2 py-2.5 text-sm whitespace-nowrap no-underline hover:no-underline",
            t.slug === active
              ? "border-brand font-medium text-ink"
              : "border-transparent text-muted hover:text-body",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
