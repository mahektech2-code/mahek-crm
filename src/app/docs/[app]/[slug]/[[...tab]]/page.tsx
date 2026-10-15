import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import index from "@/docs/_generated/index.json";
import { loadContent, contentKey } from "@/docs/content";
import { DOC_TABS, docApp, docPage, isDocTab, pageHref, tabsOf, type DocPage, type DocTab } from "@/docs/registry";
import { cx } from "@/components/ui/primitives";

type Params = { app: string; slug: string; tab?: string[] };

function resolve(page: DocPage | undefined, p: Params): { tab: DocTab } | null {
  if (!page) return null;
  const tabs = tabsOf(page);
  if (!p.tab || p.tab.length === 0) return { tab: tabs[0] };
  if (p.tab.length === 1 && isDocTab(p.tab[0]) && tabs.includes(p.tab[0])) return { tab: p.tab[0] };
  return null;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const p = await params;
  const page = docPage(p.app, p.slug);
  const r = resolve(page, p);
  if (!page || !r) return { title: "Not found" };
  const tab = DOC_TABS.find((t) => t.id === r.tab)!;
  return { title: `${page.title} — ${tab.label}`, description: page.summary };
}

type TocEntry = { depth: number; text: string; id: string };

/**
 * One documentation page, on one of its three tabs.
 *
 * `/docs/crm/call-log` is the guide, and the other two tabs are a segment
 * beneath it, so a link can point at exactly the reader it is for. A tab that
 * is not written yet says so and offers the ones that are.
 */
export default async function DocPageRoute({ params }: { params: Promise<Params> }) {
  const p = await params;
  const app = docApp(p.app);
  const page = docPage(p.app, p.slug);
  const r = resolve(page, p);
  if (!app || !page || !r) notFound();
  const tabs = DOC_TABS.filter((t) => tabsOf(page).includes(t.id));
  const { tab } = r;

  const Content = await loadContent(p.app, p.slug, tab);
  const toc = ((index.toc as Record<string, TocEntry[]>)[contentKey(p.app, p.slug, tab)] ?? []).filter((t) => t.depth === 2 || t.depth === 3);

  const ordered = app.groups.flatMap((g) => app.pages.filter((x) => x.group === g));
  const at = ordered.findIndex((x) => x.slug === page.slug);
  const prev = ordered[at - 1];
  const next = ordered[at + 1];
  const tabInfo = DOC_TABS.find((t) => t.id === tab)!;

  return (
    <div className="mx-auto flex max-w-[1240px] gap-10 px-8 py-8">
      <article className="min-w-0 flex-1">
        <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1.5 text-[12px] text-muted">
          <Link href="/docs" className="text-muted no-underline hover:text-ink">
            Docs
          </Link>
          <span>/</span>
          <Link href={`/docs/${app.app}`} className="text-muted no-underline hover:text-ink">
            {app.title}
          </Link>
          <span>/</span>
          <span>{page.group}</span>
        </nav>
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[30px] leading-[38px] font-semibold text-heading">{page.title}</h1>
            <p className="mt-1.5 max-w-[720px] text-[15px] leading-[23px] text-body">{page.summary}</p>
          </div>
          {page.screen ? (
            <Link
              href={page.screen}
              className="mt-1.5 flex flex-none items-center gap-1.5 rounded-[4px] border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink no-underline hover:border-brand-softer hover:text-brand-hover hover:no-underline"
            >
              Open the screen ↗
            </Link>
          ) : null}
        </div>

        <div role="tablist" aria-label="Who this is for" className="mt-6 flex gap-1 border-b border-line">
          {tabs.map((t) => {
            const active = t.id === tab;
            const has = page.written.includes(t.id);
            return (
              <Link
                key={t.id}
                role="tab"
                aria-selected={active}
                href={pageHref(app.app, page.slug, t.id)}
                className={cx(
                  "-mb-px flex flex-col border-b-2 px-4 pt-1 pb-2.5 no-underline hover:no-underline",
                  active ? "border-brand" : "border-transparent hover:border-line-strong",
                )}
              >
                <span className={cx("text-[14px] font-semibold", active ? "text-ink" : has ? "text-body" : "text-faint")}>{t.label}</span>
                <span className={cx("text-[11px]", active ? "text-brand-hover" : "text-muted")}>{t.reader}</span>
              </Link>
            );
          })}
        </div>

        <div className="pt-6 pb-16">
          {Content ? (
            <Content />
          ) : (
            <div className="rounded-[8px] border border-dashed border-line-strong bg-surface px-6 py-10 text-center">
              <div className="text-[15px] font-semibold text-ink">The {tabInfo.label.toLowerCase()} tab for {page.title} is not written yet.</div>
              <p className="mx-auto mt-1.5 max-w-[520px] text-[13px] leading-[20px] text-muted">{tabInfo.blurb}</p>
              {page.written.length ? (
                <div className="mt-4 flex justify-center gap-2">
                  {page.written.map((w) => (
                    <Link key={w} href={pageHref(app.app, page.slug, w)} className="rounded-[4px] bg-brand-soft px-3 py-1.5 text-[13px] font-medium text-brand-hover no-underline">
                      Read the {DOC_TABS.find((t) => t.id === w)!.label.toLowerCase()} tab
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 border-t border-line pt-6">
          {prev ? (
            <Link href={pageHref(app.app, prev.slug, tab)} className="rounded-[6px] border border-line bg-surface px-4 py-3 no-underline hover:border-brand-softer hover:no-underline">
              <div className="text-[11px] text-muted">← Previous</div>
              <div className="text-[14px] font-semibold text-ink">{prev.title}</div>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={pageHref(app.app, next.slug, tab)} className="rounded-[6px] border border-line bg-surface px-4 py-3 text-right no-underline hover:border-brand-softer hover:no-underline">
              <div className="text-[11px] text-muted">Next →</div>
              <div className="text-[14px] font-semibold text-ink">{next.title}</div>
            </Link>
          ) : null}
        </div>
      </article>

      {toc.length ? (
        <aside className="hidden w-[220px] flex-none desk:block">
          <div className="sticky top-6">
            <div className="mb-2 text-[11px] font-semibold tracking-[0.07em] text-muted uppercase">On this page</div>
            <ul className="space-y-1 border-l border-line">
              {toc.map((t) => (
                <li key={t.id}>
                  <a
                    href={`#${t.id}`}
                    className={cx(
                      "-ml-px block border-l border-transparent py-0.5 text-[12.5px] leading-[18px] text-muted no-underline hover:border-brand hover:text-ink",
                      t.depth === 3 ? "pl-6" : "pl-3",
                    )}
                  >
                    {t.text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
