import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DOC_TABS, docApp, pageHref, progressOf } from "@/docs/registry";

export async function generateMetadata({ params }: { params: Promise<{ app: string }> }): Promise<Metadata> {
  const app = docApp((await params).app);
  return { title: app?.title ?? "Not found" };
}

/** An app's contents: every page by sidebar group, and which of its tabs exist. */
export default async function DocAppIndex({ params }: { params: Promise<{ app: string }> }) {
  const app = docApp((await params).app);
  if (!app) notFound();
  const { written, total } = progressOf(app);

  return (
    <div className="mx-auto max-w-[1080px] px-8 py-10">
      <div className="text-[12px] font-medium tracking-[0.06em] text-brand-hover uppercase">Documentation</div>
      <h1 className="mt-1 text-[30px] leading-[38px] font-semibold text-heading">{app.title}</h1>
      <p className="mt-2 max-w-[760px] text-[15px] leading-[24px] text-body">{app.summary}</p>
      <p className="mt-2 text-[12px] text-muted">
        {written} of {total} tabs written across {app.pages.length} pages.
      </p>

      {app.groups.map((group) => {
        const pages = app.pages.filter((p) => p.group === group);
        if (!pages.length) return null;
        return (
          <section key={group} className="mt-10">
            <h2 className="mb-3 text-[12px] font-semibold tracking-[0.07em] text-muted uppercase">{group}</h2>
            <div className="grid grid-cols-2 gap-3">
              {pages.map((p) => (
                <Link
                  key={p.slug}
                  href={pageHref(app.app, p.slug)}
                  className="group rounded-[8px] border border-line bg-surface p-4 no-underline hover:border-brand-softer hover:no-underline"
                >
                  <div className="text-[15px] font-semibold text-ink group-hover:text-brand-hover">{p.title}</div>
                  <p className="mt-1 text-[13px] leading-[19px] text-body">{p.summary}</p>
                  <div className="mt-3 flex gap-1.5">
                    {DOC_TABS.map((t) => {
                      const has = p.written.includes(t.id);
                      return (
                        <span
                          key={t.id}
                          className={
                            has
                              ? "rounded-[3px] bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand-hover"
                              : "rounded-[3px] bg-canvas px-1.5 py-0.5 text-[11px] text-faint"
                          }
                        >
                          {t.label}
                        </span>
                      );
                    })}
                  </div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
