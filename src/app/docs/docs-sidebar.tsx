"use client";

import * as React from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { Icon } from "@/components/shell/icons";
import { DOC_APPS, DOC_TABS, docApp, pageHref, progressOf, tabsOf, type DocApp, type DocTab } from "@/docs/registry";

/* ---------------------------------------------------------------------------
 * The Documentation app's sidebar: ONE app at a time.
 *
 * It used to list every app's every page down one column — five apps, two
 * hundred and forty pages, the CRM's "Overview" heading three screens above
 * the ERP's — so the reader could not tell from the sidebar which app they
 * were reading about, and the page they were on was somewhere in the middle
 * of a wall. Now the app is the first thing it says:
 *
 *   - on the front page, the sidebar IS the list of apps;
 *   - inside an app, a switcher names the app (its glyph, its name, how much
 *     is written) and opens onto every other app, and below it only that
 *     app's sections, each folding away, with the reader's own section open
 *     and the page's tabs drawn under it;
 *   - a filter narrows the app's pages by name, opening every section while
 *     it is in use, because a match hidden in a folded section is no match.
 *
 * A page still to be written is still drawn, muted with a dot — a missing
 * entry reads as "this screen has no documentation and never will".
 * ------------------------------------------------------------------------- */

export function DocsSidebar({ pathname }: { pathname: string }) {
  const [, , appSeg, slugSeg, tabSeg] = pathname.split("/");
  const app = appSeg ? docApp(appSeg) : undefined;

  return (
    <nav aria-label="Documentation" className="flex min-h-0 flex-1 flex-col">
      {app ? (
        <AppNav key={app.app} app={app} slug={slugSeg ?? null} tab={(tabSeg as DocTab | undefined) ?? null} />
      ) : (
        <AppList />
      )}
    </nav>
  );
}

/* ---------------------------------------------------------------- the front */

function AppList() {
  return (
    <div className="flex-1 overflow-y-auto px-2 pt-3 pb-6">
      <div className="px-2.5 pb-2 text-[10px] font-semibold tracking-[0.07em] text-faint uppercase">Choose an app</div>
      {DOC_APPS.map((a) => {
        const { written, total } = progressOf(a);
        return (
          <Link
            key={a.app}
            href={`/docs/${a.app}`}
            className="mb-1 flex items-center gap-2.5 rounded-[6px] px-2.5 py-2 no-underline hover:bg-canvas hover:no-underline"
          >
            <AppGlyph app={a} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">{a.title}</span>
              <span className="block text-[11px] text-muted">
                {a.pages.length} pages · {Math.round((written / total) * 100)}% written
              </span>
            </span>
            <Icon name="chevron" size={14} className="flex-none text-faint" />
          </Link>
        );
      })}
    </div>
  );
}

function AppGlyph({ app, size = 30 }: { app: DocApp; size?: number }) {
  return (
    <span
      className="flex flex-none items-center justify-center rounded-[6px] bg-brand-soft text-brand-hover"
      style={{ width: size, height: size }}
    >
      <Icon name={app.icon} size={Math.round(size * 0.55)} />
    </span>
  );
}

/* ----------------------------------------------------------------- one app */

function AppNav({ app, slug, tab }: { app: DocApp; slug: string | null; tab: DocTab | null }) {
  const [filter, setFilter] = React.useState("");
  const activePage = slug ? app.pages.find((p) => p.slug === slug) : undefined;
  // Mounted per app (the key above), so it starts from the reader's own section.
  const [open, setOpen] = React.useState<Set<string>>(
    () => new Set(activePage ? [activePage.group] : app.groups),
  );
  // Moving to a page in a folded section opens that section; nothing ever closes on its own.
  const [seenGroup, setSeenGroup] = React.useState(activePage?.group);
  if (activePage && activePage.group !== seenGroup) {
    setSeenGroup(activePage.group);
    setOpen((o) => new Set(o).add(activePage.group));
  }

  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (title: string, summary: string) =>
    words.every((w) => title.toLowerCase().includes(w) || summary.toLowerCase().includes(w));
  const filtering = words.length > 0;
  const allOpen = app.groups.every((g) => open.has(g));

  return (
    <>
      <div className="flex-none border-b border-divider px-2 pt-3 pb-3">
        <AppSwitcher app={app} />
        <div className="mt-2.5 flex items-center gap-1.5 rounded-[4px] border border-line bg-canvas px-2 focus-within:border-brand">
          <Icon name="search" size={13} className="flex-none text-muted" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
            placeholder={`Filter ${app.title} pages`}
            aria-label={`Filter ${app.title} pages`}
            className="h-7 min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-faint"
          />
          {filtering ? (
            <button type="button" onClick={() => setFilter("")} aria-label="Clear the filter" className="cursor-pointer text-muted hover:text-ink">
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-6">
        <div className="flex items-center justify-between px-2.5 pt-1 pb-1.5">
          <Link
            href={`/docs/${app.app}`}
            className={cx(
              "text-[12px] font-medium no-underline hover:no-underline",
              !slug ? "text-brand-hover" : "text-muted hover:text-ink",
            )}
          >
            Contents
          </Link>
          {!filtering ? (
            <button
              type="button"
              onClick={() => setOpen(allOpen ? new Set(activePage ? [activePage.group] : []) : new Set(app.groups))}
              className="cursor-pointer text-[11px] text-muted hover:text-ink"
            >
              {allOpen ? "Fold all" : "Open all"}
            </button>
          ) : null}
        </div>

        {app.groups.map((group) => {
          const pages = app.pages.filter((p) => p.group === group && (!filtering || matches(p.title, p.summary)));
          if (!pages.length) return null;
          const isOpen = filtering || open.has(group);
          const holdsActive = activePage?.group === group;
          return (
            <div key={group} className="mt-1">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() =>
                  setOpen((o) => {
                    const n = new Set(o);
                    if (n.has(group)) n.delete(group);
                    else n.add(group);
                    return n;
                  })
                }
                className={cx(
                  "flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-[4px] px-2 text-left text-[11px] font-semibold tracking-[0.06em] uppercase hover:bg-canvas",
                  holdsActive ? "text-brand-hover" : "text-muted",
                )}
              >
                <Icon name="chevron" size={12} className={cx("flex-none transition-transform duration-100", isOpen && "rotate-90")} />
                <span className="min-w-0 flex-1 truncate">{group}</span>
                <span className="text-[10px] font-medium text-faint">{pages.length}</span>
              </button>
              {isOpen ? (
                <div className="ml-[13px] border-l border-divider pl-1.5">
                  {pages.map((p) => {
                    const active = slug === p.slug;
                    const written = p.written.length > 0;
                    const tabs = tabsOf(p);
                    return (
                      <div key={p.slug}>
                        <Link
                          href={pageHref(app.app, p.slug)}
                          aria-current={active ? "page" : undefined}
                          title={p.summary}
                          className={cx(
                            "flex min-h-7 items-center gap-2 rounded-[4px] px-2 py-1 text-[13px] leading-[18px] no-underline hover:no-underline",
                            active ? "bg-brand-soft font-medium text-brand-hover" : cx("hover:bg-canvas", written ? "text-body" : "text-faint"),
                          )}
                        >
                          <span className="min-w-0 flex-1">{p.title}</span>
                          {!written ? <span title="Not written yet" className="h-1.5 w-1.5 flex-none rounded-full bg-line-strong" /> : null}
                        </Link>
                        {active && tabs.length > 1 ? (
                          <div className="mt-0.5 mb-1 ml-2 flex flex-col">
                            {DOC_TABS.filter((t) => tabs.includes(t.id)).map((t) => {
                              const here = (tab ?? tabs[0]) === t.id;
                              const has = p.written.includes(t.id);
                              return (
                                <Link
                                  key={t.id}
                                  href={pageHref(app.app, p.slug, t.id)}
                                  className={cx(
                                    "flex h-6 items-center gap-2 rounded-[4px] px-2 text-[12px] no-underline hover:no-underline",
                                    here ? "font-medium text-brand-hover" : has ? "text-muted hover:text-ink" : "text-faint",
                                  )}
                                >
                                  <span className={cx("h-1 w-1 flex-none rounded-full", here ? "bg-brand" : "bg-line-strong")} />
                                  {t.label}
                                </Link>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}

        {filtering && !app.pages.some((p) => matches(p.title, p.summary)) ? (
          <p className="px-2.5 pt-3 text-[12px] leading-[18px] text-muted">
            No {app.title} page is called that. Search the whole documentation with ⌘K, or ask the docs.
          </p>
        ) : null}
      </div>
    </>
  );
}

/** The app being read, and the way to every other one. */
function AppSwitcher({ app }: { app: DocApp }) {
  const [open, setOpen] = React.useState(false);
  const box = React.useRef<HTMLDivElement>(null);
  const { written, total } = progressOf(app);

  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[6px] border border-line bg-surface px-2 py-1.5 text-left hover:border-line-strong"
      >
        <AppGlyph app={app} />
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold tracking-[0.07em] text-faint uppercase">Reading</span>
          <span className="block truncate text-[13px] font-semibold text-ink">{app.title}</span>
        </span>
        <span className="flex flex-none flex-col items-end">
          <span className="text-[10px] text-muted">
            {written}/{total}
          </span>
          <Icon name="chevron" size={13} className={cx("text-muted transition-transform", open ? "-rotate-90" : "rotate-90")} />
        </span>
      </button>
      {open ? (
        <div role="listbox" className="absolute top-full right-0 left-0 z-30 mt-1 overflow-hidden rounded-[6px] border border-line bg-surface py-1 shadow-lg">
          <Link
            href="/docs"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-muted no-underline hover:bg-canvas hover:text-ink hover:no-underline"
          >
            <Icon name="book" size={14} /> All apps
          </Link>
          <div className="my-1 h-px bg-divider" />
          {DOC_APPS.map((a) => (
            <Link
              key={a.app}
              href={`/docs/${a.app}`}
              role="option"
              aria-selected={a.app === app.app}
              onClick={() => setOpen(false)}
              className={cx(
                "flex items-center gap-2.5 px-2.5 py-1.5 no-underline hover:bg-canvas hover:no-underline",
                a.app === app.app && "bg-brand-soft",
              )}
            >
              <AppGlyph app={a} size={24} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{a.title}</span>
              {a.app === app.app ? <Icon name="tick" size={13} className="text-brand-hover" /> : null}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
