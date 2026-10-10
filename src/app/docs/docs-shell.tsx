"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { AppFrame } from "@/components/shell/app-frame";
import { HeaderLead } from "@/components/shell/header-lead";
import { Icon } from "@/components/shell/icons";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { FeedbackButton } from "@/components/shell/feedback-button";
import type { AppDefinition } from "@/lib/apps";
import { SalesIcon } from "@/components/console/icons";
import { DOC_TABS, docApp, pageHref, type DocTab } from "@/docs/registry";
import { DocsSidebar } from "./docs-sidebar";
import { AskPanel, type AskPlace } from "./ask-panel";

/* ---------------------------------------------------------------------------
 * The Documentation app's shell: the suite's frame and header, a sidebar that
 * is the table of contents, and ⌘K search across every page.
 *
 * The sidebar is one app at a time — see `docs-sidebar.tsx`. "Ask the docs"
 * is docked on the right (`ask-panel.tsx`) and is told which page the reader
 * is on, so a question that does not name an app is read as being about the
 * one they are reading. ⌘K hands a question it cannot match to the panel.
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
  const [asking, setAsking] = React.useState(false);
  const [askRequest, setAskRequest] = React.useState<{ id: number; text: string } | null>(null);

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

  const [, , currentApp, currentSlug, currentTab] = pathname.split("/");
  const place: AskPlace =
    currentApp && docApp(currentApp) ? { app: currentApp, slug: currentSlug ?? null, tab: currentTab ?? null } : null;
  const askAbout = (text: string) => {
    setAsking(true);
    setAskRequest({ id: Date.now(), text });
  };

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
          <button
            type="button"
            onClick={() => setAsking((a) => !a)}
            aria-pressed={asking}
            className={cx(
              "inline-flex h-8 flex-none cursor-pointer items-center gap-[7px] rounded-[4px] border border-brand-softer px-3 text-[13px] font-medium text-[#5223E0] transition-colors duration-100 hover:bg-brand-softer",
              asking ? "bg-brand-softer" : "bg-brand-soft",
            )}
          >
            <SalesIcon name="spark" size={14} />
            Ask the docs
          </button>
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
            collapsed ? "w-0 overflow-hidden border-r-0" : "w-[clamp(232px,18vw,280px)]",
          )}
        >
          <DocsSidebar pathname={pathname} />
        </aside>
      }
    >
      {/* The page moves aside for the docked panel rather than sitting under it. */}
      <div className={cx(asking && "pr-[min(440px,calc(100vw-48px))]")}>{children}</div>
      {asking ? (
        <AskPanel
          place={place}
          request={askRequest}
          onClose={() => {
            setAsking(false);
            setAskRequest(null);
          }}
        />
      ) : null}
      {searching ? <SearchDialog entries={search} onClose={() => setSearching(false)} onAsk={askAbout} /> : null}
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

function SearchDialog({
  entries,
  onClose,
  onAsk,
}: {
  entries: SearchEntry[];
  onClose: () => void;
  /** Hand the typed words to "Ask the docs" as a question. */
  onAsk: (question: string) => void;
}) {
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

  const askIt = () => {
    onClose();
    onAsk(q.trim());
  };
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
                setCursor((c) => Math.min(c + 1, results.length));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              }
              if (e.key === "Enter") {
                if (results[cursor]) go(results[cursor]);
                else if (q.trim()) askIt();
              }
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
            <p className="px-4 pt-6 pb-3 text-center text-[13px] text-muted">No page title or heading matches that.</p>
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
          {words.length ? (
            <button
              type="button"
              onMouseEnter={() => setCursor(results.length)}
              onClick={askIt}
              className={cx(
                "flex w-full cursor-pointer items-center gap-2 border-t border-divider px-4 py-3 text-left text-[13px]",
                cursor === results.length && "bg-brand-soft",
              )}
            >
              <span className="flex text-[#5223E0]">
                <SalesIcon name="spark" size={14} />
              </span>
              <span className="min-w-0 flex-1 truncate text-ink">
                Ask the docs: <span className="font-medium">“{q.trim()}”</span>
              </span>
              <span className="text-[11px] text-muted">Answered from every page</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
