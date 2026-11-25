"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { cx } from "@/components/ui/primitives";
import type { AppDefinition, AppId } from "@/lib/apps";
import { APP_ICON_PATH, GROUP_TONE, groupApps } from "@/lib/launcher-groups";

/**
 * The grid button in every app header.
 *
 * It switches app rather than going back to the launcher: a telecaller who
 * wants Orders wants Orders, and routing them via a page of tiles to click a
 * second time is a step that exists only because it was easier to build. The
 * launcher is still one click away for anyone who wants to see everything.
 *
 * Only rendered when the account opens more than one app — a single app is not
 * a choice, and the button would be a lie.
 *
 * THE PANEL IS THE LAUNCHER IN SMALL (Nov 2026). It was one two-column wall of
 * seventeen rows with two lines of description each, every icon the same
 * purple, so finding an app meant reading. It now draws the launcher's own
 * shelves (`lib/launcher-groups.ts`) — Sell, Money & operations, People,
 * Company — each in its colour, as compact tiles with the app's own glyph and
 * one line of what it is for. A search box at the top narrows the tiles as you
 * type; the 1–9 shortcuts follow the shelves' order, which is the launcher's,
 * so the same key opens the same app on both.
 */

type Shelf = ReturnType<typeof groupApps<AppDefinition>>[number];

export function AppSwitcher({
  apps,
  current,
  label,
}: {
  apps: AppDefinition[];
  current: AppId;
  /** Draw the trigger as a labelled button — "⊞ Admin Console ⌄" — rather than the bare grid. */
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const boxRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const itemRefs = React.useRef<Map<AppId, HTMLElement>>(new Map());

  /* The launcher's order: the shelves, and the apps in each. The shortcuts follow it. */
  const shelves = React.useMemo(() => groupApps(apps), [apps]);
  const ordered = React.useMemo(() => shelves.flatMap((s) => s.apps), [shelves]);
  const keyOf = React.useMemo(() => new Map(ordered.slice(0, 9).map((a, i) => [a.id, String(i + 1)])), [ordered]);

  const q = query.trim().toLowerCase();
  const shown: Shelf[] = q
    ? shelves
        .map((s) => ({ ...s, apps: s.apps.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)) }))
        .filter((s) => s.apps.length)
    : shelves;
  const shownApps = shown.flatMap((s) => s.apps);

  const close = React.useCallback((refocus = false) => {
    setOpen(false);
    setQuery("");
    if (refocus) buttonRef.current?.focus();
  }, []);

  const go = React.useCallback(
    (app: AppDefinition) => {
      close();
      if (app.id !== current) router.push(app.href);
    },
    [close, current, router],
  );

  React.useEffect(() => {
    if (!open) return;
    // Typing finds an app straight away; the arrows start from the search box.
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  /* Arrows walk the tiles by where they are on screen, so a shelf of two sits under a shelf of three without the steps going wrong. */
  const move = (from: HTMLElement | null, key: string) => {
    const tiles = shownApps.map((a) => itemRefs.current.get(a.id)).filter((el): el is HTMLElement => !!el);
    if (!tiles.length) return;
    if (!from || from === searchRef.current) {
      if (key === "ArrowDown" || key === "ArrowRight") tiles[0].focus();
      return;
    }
    const at = tiles.indexOf(from);
    if (key === "ArrowRight") return tiles[at + 1]?.focus();
    if (key === "ArrowLeft") return (tiles[at - 1] ?? searchRef.current)?.focus();
    const r = from.getBoundingClientRect();
    const cx0 = r.left + r.width / 2;
    let best: HTMLElement | null = null;
    let score = Infinity;
    for (const el of tiles) {
      if (el === from) continue;
      const o = el.getBoundingClientRect();
      const dy = key === "ArrowDown" ? o.top - r.bottom : r.top - o.bottom;
      if (dy < -2) continue;
      const s = dy * 1000 + Math.abs(o.left + o.width / 2 - cx0);
      if (s < score) {
        score = s;
        best = el;
      }
    }
    if (best) best.focus();
    else if (key === "ArrowUp") searchRef.current?.focus();
  };

  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    const inSearch = e.target === searchRef.current;
    // The number on a tile opens it — the launcher's keys — unless a search is being typed.
    if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !(inSearch && query)) {
      const app = ordered[Number(e.key) - 1];
      if (!app) return;
      e.preventDefault();
      go(app);
      return;
    }
    if (inSearch && e.key === "Enter" && shownApps[0]) {
      e.preventDefault();
      go(shownApps[0]);
      return;
    }
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      if (inSearch && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
      e.preventDefault();
      move(document.activeElement as HTMLElement | null, e.key);
    }
  };

  const currentApp = apps.find((a) => a.id === current);

  return (
    <div ref={boxRef} className="relative flex-none">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title={open ? undefined : "Switch app"}
        aria-label="Switch app"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cx(
          label
            ? "flex h-[34px] cursor-pointer items-center gap-2 rounded-control border border-brand-softer bg-surface px-2.5 text-[13px] font-semibold text-ink transition-colors duration-100 hover:bg-canvas"
            : "flex h-8 w-8 cursor-pointer items-center justify-center rounded-[4px] border transition-colors duration-100",
          !label && (open ? "border-brand bg-brand-soft text-brand" : "border-line bg-surface text-muted hover:bg-canvas hover:text-body"),
        )}
      >
        {label ? (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-brand-deep" aria-hidden>
              <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
            </svg>
            {label}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted" aria-hidden>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </>
        ) : (
          <Icon name="grid" size={16} />
        )}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Switch app"
          onKeyDown={onPanelKey}
          className="animate-fade-in absolute top-10 left-0 z-50 flex max-h-[min(640px,calc(100vh-72px))] w-[min(960px,calc(100vw-24px))] flex-col overflow-hidden rounded-[12px] border border-line bg-surface shadow-[0_18px_48px_rgba(22,22,22,0.16),0_2px_8px_rgba(22,22,22,0.06)]"
        >
          {/* Search and the way out to the launcher. */}
          <div className="flex items-center gap-3 border-b border-divider px-4 py-3">
            <div className="relative min-w-0 flex-1">
              <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={currentApp ? `Find an app — you are in ${currentApp.name}` : "Find an app"}
                aria-label="Find an app"
                className="h-10 w-full rounded-[8px] border border-line bg-canvas pr-3 pl-9 text-sm text-ink outline-none placeholder:text-faint focus:border-brand focus:bg-surface focus:ring-2 focus:ring-brand-soft"
              />
            </div>
            <Link
              href="/apps"
              onClick={() => close()}
              className="group hidden flex-none items-center gap-1.5 rounded-[8px] px-2.5 py-2 text-[13px] font-semibold text-brand no-underline hover:bg-brand-soft hover:no-underline sm:flex"
            >
              <Icon name="grid" size={15} />
              Launcher
              <Icon name="arrowRight" size={14} className="transition-transform duration-100 group-hover:translate-x-0.5" />
            </Link>
          </div>

          {/* The shelves. */}
          <div
            className="grid min-h-0 flex-1 grid-cols-1 content-start gap-x-3 gap-y-4 overflow-y-auto px-3 pt-3.5 pb-3 sm:grid-cols-2 lg:[grid-template-columns:var(--shelves)]"
            style={{ "--shelves": `repeat(${Math.max(1, shown.length)}, minmax(0, 1fr))` } as React.CSSProperties}
          >
            {shown.length === 0 ? (
              <div className="col-span-full px-3 py-10 text-center text-sm text-muted">
                No app matches “{query.trim()}”.
              </div>
            ) : (
              shown.map((shelf) => {
                const tone = GROUP_TONE[shelf.id];
                return (
                  <section key={shelf.id} aria-label={shelf.title} className="min-w-0">
                    <h3 className="mb-1.5 flex items-center gap-2 px-1.5 text-2xs font-semibold tracking-[0.06em] text-muted uppercase">
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: tone.dot }} />
                      {shelf.title}
                    </h3>
                    <div className="flex flex-col gap-1">
                      {shelf.apps.map((app) => {
                        const here = app.id === current;
                        const key = keyOf.get(app.id);
                        const setRef = (el: HTMLElement | null) => {
                          if (el) itemRefs.current.set(app.id, el);
                          else itemRefs.current.delete(app.id);
                        };
                        const body = (
                          <>
                            <span
                              aria-hidden
                              className="flex h-10 w-10 flex-none items-center justify-center rounded-[10px] transition-transform duration-100 group-hover:scale-105"
                              style={{ background: here ? tone.dot : tone.bg, color: here ? "#fff" : tone.fg }}
                            >
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d={APP_ICON_PATH[app.id]} />
                              </svg>
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-sm font-semibold text-ink">{app.name}</span>
                                {here ? (
                                  <span className="flex-none rounded-full bg-brand px-1.5 text-[10px] leading-4 font-semibold text-white">Open</span>
                                ) : !app.built ? (
                                  <span className="flex-none rounded-full bg-divider px-1.5 text-[10px] leading-4 font-medium text-muted">Soon</span>
                                ) : null}
                              </span>
                              <span className="mt-0.5 block truncate text-xs text-muted" title={app.description}>
                                {app.description}
                              </span>
                            </span>
                            {key && !here ? (
                              <kbd className="hidden h-5 min-w-5 flex-none items-center justify-center self-start rounded-[4px] border border-line bg-surface px-1 font-sans text-[11px] font-medium text-faint group-hover:flex group-focus-visible:flex">
                                {key}
                              </kbd>
                            ) : null}
                          </>
                        );
                        const shape =
                          "group flex min-h-[60px] items-center gap-3 rounded-[10px] border px-2.5 py-2 text-left no-underline outline-none hover:no-underline";
                        return here ? (
                          <button
                            key={app.id}
                            ref={setRef}
                            type="button"
                            aria-current="page"
                            onClick={() => close()}
                            className={cx(shape, "cursor-default border-brand-softer bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand")}
                          >
                            {body}
                          </button>
                        ) : (
                          <Link
                            key={app.id}
                            ref={setRef}
                            href={app.href}
                            onClick={() => close()}
                            className={cx(
                              shape,
                              "border-transparent hover:border-line hover:bg-canvas focus-visible:border-brand focus-visible:bg-canvas focus-visible:ring-2 focus-visible:ring-brand-soft",
                            )}
                          >
                            {body}
                          </Link>
                        );
                      })}
                    </div>
                  </section>
                );
              })
            )}
          </div>

          {/* How to drive it without the mouse. */}
          <div className="hidden items-center gap-4 border-t border-divider bg-canvas px-4 py-2 text-xs text-muted sm:flex">
            <span className="flex items-center gap-1.5">
              <Key>↑</Key>
              <Key>↓</Key>
              <Key>←</Key>
              <Key>→</Key> move
            </span>
            <span className="flex items-center gap-1.5">
              <Key>Enter</Key> open
            </span>
            {ordered.length > 1 ? (
              <span className="flex items-center gap-1.5">
                <Key>1</Key>–<Key>{String(Math.min(ordered.length, 9))}</Key> jump
              </span>
            ) : null}
            <span className="flex items-center gap-1.5">
              <Key>Esc</Key> close
            </span>
            <span className="ml-auto">
              {apps.length} app{apps.length === 1 ? "" : "s"} on your account
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Key({ children }: { children: string }) {
  return (
    <kbd className="flex h-5 min-w-5 flex-none items-center justify-center rounded-[4px] border border-line bg-surface px-1 font-sans text-[11px] font-medium text-muted">
      {children}
    </kbd>
  );
}
