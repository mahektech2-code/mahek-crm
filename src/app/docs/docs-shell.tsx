"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { AppFrame } from "@/components/shell/app-frame";
import { HeaderLead } from "@/components/shell/header-lead";
import { Icon } from "@/components/shell/icons";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { FeedbackButton } from "@/components/shell/feedback-button";
import type { AppDefinition } from "@/lib/apps";
import { DOC_APPS, DOC_TABS, pageHref, type DocTab } from "@/docs/registry";

/* ---------------------------------------------------------------------------
 * The Documentation app's shell: the suite's frame and header, a sidebar that
 * is the table of contents, and ⌘K search across every page.
 *
 * The sidebar lists EVERY page, written or not. A page still to be written is
 * drawn muted with a dot, not hidden — a missing entry reads as "this screen
 * has no documentation and never will", and a muted one reads as what it is.
 * ------------------------------------------------------------------------- */

export type SearchEntry = {
  app: string;
  slug: string;
  tab: string | null;
  title: string;
  heading: string | null;
  id: string | null;
  text: string;
};

export function DocsShell({
  user,
  apps,
  search,
  children,
}: {
  user: { name: string; initials: string; role: string };
  apps: AppDefinition[];
  search: SearchEntry[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);
  const [searching, setSearching] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [, , currentApp, currentSlug] = pathname.split("/");

  return (
    <AppFrame
      header={
        <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-4">
          <HeaderLead
            apps={apps}
            current="docs"
            collapsed={collapsed}
            onToggleSidebar={() => setCollapsed((c) => !c)}
            href="/docs"
            label="MAHEK DOCS"
          />
          <button
            type="button"
            onClick={() => setSearching(true)}
            className="ml-4 flex h-8 w-[min(420px,40vw)] cursor-pointer items-center gap-2 rounded-[4px] border border-line bg-canvas px-2.5 text-[13px] text-muted hover:border-line-strong"
          >
            <Icon name="search" size={15} />
            <span className="flex-1 text-left">Search the documentation</span>
            <kbd className="rounded-[3px] border border-line bg-surface px-1.5 font-mono text-[11px]">⌘K</kbd>
          </button>
          <span className="flex-1" />
          <FeedbackButton />
          <span className="mx-1 h-6 w-px flex-none bg-divider" />
          <div className="flex flex-none items-center gap-2">
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[4px] bg-brand-soft text-xs font-semibold text-brand-hover">
              {user.initials}
            </span>
            <span className="min-w-0 leading-[14px]">
              <span className="block text-[13px] font-medium whitespace-nowrap text-ink">{user.name}</span>
              <span className="block text-[11px] whitespace-nowrap text-muted">{user.role}</span>
            </span>
          </div>
          <SignOutButton />
        </header>
      }
      sidebar={
        <aside
          className={cx(
            "flex flex-none flex-col border-r border-line bg-surface transition-[width] duration-150",
            collapsed ? "w-0 overflow-hidden border-r-0" : "w-[clamp(220px,18vw,268px)]",
          )}
        >
          <nav aria-label="Documentation" className="flex-1 overflow-y-auto px-2 pt-3 pb-6">
            <Link
              href="/docs"
              className={cx(
                "mb-3 flex h-8 items-center gap-2 rounded-[4px] px-2.5 text-[13px] no-underline hover:bg-canvas hover:no-underline",
                pathname === "/docs" ? "bg-brand-soft font-medium text-brand-hover" : "text-body",
              )}
            >
              <Icon name="book" size={16} />
              All apps
            </Link>
            {DOC_APPS.map((app) => (
              <div key={app.app} className="mb-4">
                <Link
                  href={`/docs/${app.app}`}
                  className={cx(
                    "flex items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-[13px] font-semibold no-underline hover:bg-canvas hover:no-underline",
                    currentApp === app.app && !currentSlug ? "text-brand-hover" : "text-ink",
                  )}
                >
                  {app.title}
                </Link>
                {app.groups.map((group) => {
                  const pages = app.pages.filter((p) => p.group === group);
                  if (!pages.length) return null;
                  return (
                    <div key={group} className="mt-2">
                      <div className="px-2.5 pb-1 text-[10px] font-semibold tracking-[0.07em] text-faint uppercase">{group}</div>
                      {pages.map((p) => {
                        const active = currentApp === app.app && currentSlug === p.slug;
                        const written = p.written.length > 0;
                        return (
                          <Link
                            key={p.slug}
                            href={pageHref(app.app, p.slug)}
                            aria-current={active ? "page" : undefined}
                            className={cx(
                              "relative flex h-7 items-center gap-2 rounded-[4px] border-l-2 pr-2 pl-2.5 text-[13px] no-underline hover:no-underline",
                              active
                                ? "border-l-brand bg-brand-soft font-medium text-brand-hover"
                                : cx("border-l-transparent hover:bg-canvas", written ? "text-body" : "text-faint"),
                            )}
                          >
                            <span className="min-w-0 flex-1 truncate">{p.title}</span>
                            {!written ? (
                              <span title="Not written yet" className="h-1.5 w-1.5 flex-none rounded-full bg-line-strong" />
                            ) : null}
                          </Link>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ))}
          </nav>
        </aside>
      }
    >
      {children}
      {searching ? <SearchDialog entries={search} onClose={() => setSearching(false)} /> : null}
    </AppFrame>
  );
}

/* ----------------------------------------------------------------- search */

const TAB_LABEL = Object.fromEntries(DOC_TABS.map((t) => [t.id, t.label])) as Record<DocTab, string>;

function score(entry: SearchEntry, words: string[]): number {
  const title = entry.title.toLowerCase();
  const heading = (entry.heading ?? "").toLowerCase();
  const text = entry.text.toLowerCase();
  let s = 0;
  for (const w of words) {
    if (title.includes(w)) s += 6;
    else if (heading.includes(w)) s += 4;
    else if (text.includes(w)) s += 1;
    else return 0;
  }
  return s + (entry.heading ? 0 : 1);
}

function snippet(text: string, words: string[]): string {
  const lower = text.toLowerCase();
  const at = Math.max(0, Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), text.length) - 40);
  return (at > 0 ? "…" : "") + text.slice(at, at + 150) + (at + 150 < text.length ? "…" : "");
}

function SearchDialog({ entries, onClose }: { entries: SearchEntry[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const results = words.length
    ? entries
        .map((e) => ({ e, s: score(e, words) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 12)
        .map((r) => r.e)
    : [];

  const go = (e: SearchEntry) => {
    const href = pageHref(e.app, e.slug, (e.tab ?? undefined) as DocTab | undefined) + (e.id ? `#${e.id}` : "");
    onClose();
    router.push(href);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Search the documentation" className="fixed inset-0 z-50 flex justify-center bg-ink/40 pt-[12vh]" onClick={onClose}>
      <div className="h-fit w-[640px] max-w-[92vw] overflow-hidden rounded-[8px] border border-line bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Icon name="search" size={17} className="text-muted" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, results.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              }
              if (e.key === "Enter" && results[cursor]) go(results[cursor]);
            }}
            placeholder="Why is a customer not on my Call Log?"
            className="h-12 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-faint"
          />
          <kbd className="rounded-[3px] border border-line px-1.5 font-mono text-[11px] text-muted">esc</kbd>
        </div>
        <div className="max-h-[56vh] overflow-y-auto">
          {words.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted">Type a screen, a rule or a question.</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted">Nothing in the written pages matches that yet.</p>
          ) : (
            results.map((e, i) => (
              <button
                key={`${e.app}/${e.slug}/${e.tab}/${e.id}/${i}`}
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(e)}
                className={cx("block w-full cursor-pointer border-b border-divider px-4 py-2.5 text-left last:border-0", i === cursor && "bg-brand-soft")}
              >
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="font-semibold text-ink">{e.title}</span>
                  {e.tab ? <span className="rounded-[3px] bg-canvas px-1.5 text-[11px] text-muted">{TAB_LABEL[e.tab as DocTab] ?? e.tab}</span> : null}
                  {e.heading ? <span className="truncate text-muted">› {e.heading}</span> : null}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[12px] leading-[17px] text-body">{snippet(e.text, words)}</div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
