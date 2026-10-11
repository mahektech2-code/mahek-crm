"use client";

import { NotificationBell } from "@/components/shell/notification-bell";
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
import { docApp } from "@/docs/registry";
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


export function DocsShell({
  user,
  apps,
  children,
}: {
  user: { name: string; initials: string; role: string };
  apps: AppDefinition[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  const [wide, setWide] = React.useState(false);
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
          <NotificationBell />
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
      <div className={cx(asking && (wide ? "pr-[min(760px,calc(100vw-48px))]" : "pr-[min(440px,calc(100vw-48px))]"))}>{children}</div>
      {asking ? (
        <AskPanel
          place={place}
          request={askRequest}
          wide={wide}
          onWide={setWide}
          onClose={() => {
            setAsking(false);
            setAskRequest(null);
          }}
        />
      ) : null}
      {searching ? <SearchDialog place={place} onClose={() => setSearching(false)} onAsk={askAbout} /> : null}
    </AppFrame>
  );
}

/* ----------------------------------------------------------------- search */

type Result = { href: string; app: string; title: string; heading: string | null; tab: string; snippet: string; marks: string[] };

/** The words the engine matched, marked where they appear — a typo's correction included. */
function Marked({ text, marks }: { text: string; marks: string[] }) {
  if (!marks.length) return <>{text}</>;
  const re = new RegExp(`\\b(${marks.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-[2px] bg-brand-soft px-0.5 text-brand-hover">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

/**
 * ⌘K. Every keystroke asks `/api/docs/search` — the engine "Ask the docs"
 * reads with — a moment after typing pauses, and an answer to an older
 * keystroke is dropped rather than shown over a newer one.
 */
function SearchDialog({
  place,
  onClose,
  onAsk,
}: {
  place: AskPlace;
  onClose: () => void;
  /** Hand the typed words to "Ask the docs" as a question. */
  onAsk: (question: string) => void;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [found, setFound] = React.useState<{ q: string; results: Result[] }>({ q: "", results: [] });
  const [failed, setFailed] = React.useState(false);
  const typed = q.trim().length > 1;
  const results = typed ? found.results : [];
  const waiting = typed && found.q !== q;

  React.useEffect(() => {
    if (q.trim().length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q });
      if (place?.app) params.set("app", place.app);
      if (place?.slug) params.set("slug", place.slug);
      fetch(`/api/docs/search?${params}`, { signal: controller.signal })
        .then((r) => r.json() as Promise<{ ok: boolean; results?: Result[] }>)
        .then((j) => {
          setFailed(!j.ok);
          setFound({ q, results: j.results ?? [] });
        })
        .catch((e: unknown) => {
          if (!(e instanceof DOMException && e.name === "AbortError")) setFailed(true);
        });
    }, 70);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, place?.app, place?.slug]);

  const askIt = () => {
    onClose();
    onAsk(q.trim());
  };
  const go = (r: Result) => {
    onClose();
    router.push(r.href);
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
            placeholder="Search any screen, rule or setting — typos are fine"
            className="h-12 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-faint"
          />
          {waiting ? <span className="block h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-brand-softer border-t-brand" /> : null}
          <kbd className="rounded-[3px] border border-line px-1.5 font-mono text-[11px] text-muted">esc</kbd>
        </div>
        <div className="max-h-[56vh] overflow-y-auto">
          {!typed ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted">Type a screen, a rule or a question.</p>
          ) : failed ? (
            <p className="px-4 pt-6 pb-3 text-center text-[13px] text-muted">Search is not answering just now.</p>
          ) : results.length === 0 && !waiting ? (
            <p className="px-4 pt-6 pb-3 text-center text-[13px] text-muted">Nothing in the documentation matches that.</p>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.href}/${i}`}
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(r)}
                className={cx("block w-full cursor-pointer border-b border-divider px-4 py-2.5 text-left last:border-0", i === cursor && "bg-brand-soft", waiting && "opacity-70")}
              >
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="font-semibold text-ink">
                    <Marked text={r.title} marks={r.marks} />
                  </span>
                  {r.tab ? <span className="rounded-[3px] bg-canvas px-1.5 text-[11px] text-muted">{r.tab}</span> : null}
                  {r.heading ? (
                    <span className="truncate text-muted">
                      › <Marked text={r.heading} marks={r.marks} />
                    </span>
                  ) : null}
                  <span className="ml-auto flex-none text-[10px] tracking-[0.05em] text-faint uppercase">{docApp(r.app)?.short}</span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-[12px] leading-[17px] text-body">
                  <Marked text={r.snippet} marks={r.marks} />
                </div>
              </button>
            ))
          )}
          {typed ? (
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
